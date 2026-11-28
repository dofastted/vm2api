"""Bounded client for one CRAGGemini native-worker text turn."""

import fcntl
import json
import os
import re
import select
import signal
import socket
import stat
import struct
import subprocess
import sys
import threading
import time
from http.client import HTTPException, HTTPResponse
from pathlib import Path

MAX_BODY = 12 * 1024 * 1024
MAX_FRAME = 2 * 1024 * 1024
MAX_SSE = 16 * 1024 * 1024
MAX_TEXT = 16 * 1024
MAX_RESULT = 64 * 1024
TURN_TIMEOUT = 125
TOKEN = re.compile(r"[!-~]{24,4096}\Z")
MODEL = re.compile(r"[a-z0-9][a-z0-9._-]{0,99}\Z")
REQUEST_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
ACCOUNT_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")
MAX_WORKER_STDERR = 4096
LAUNCHER_EXIT_FILE = "launcher-exit"
LAUNCHER_EXIT_REASONS = frozenset(
    {
        "invalid_config",
        "license_error",
        "bind_failed",
    }
)
LAUNCHER_EXIT = re.compile(
    rb"(craggemini|agy) (-?[0-9]{1,3})(?: ([a-z][a-z0-9_]{0,31}))?\n"
)
ELIGIBILITY_LOG_FILE = "cli-diagnostic"
ADVISORY_DIAGNOSTIC_CODES = frozenset({"gemini_client_unsupported"})


def poll_diagnostic(diagnostic, *, final=False, include_advisory=True):
    if diagnostic is None:
        return None
    if not include_advisory:
        try:
            code = diagnostic.poll(final=final, include_advisory=False)
        except TypeError:
            code = diagnostic.poll(final=final)
        return None if code in ADVISORY_DIAGNOSTIC_CODES else code
    return diagnostic.poll(final=final)


class EligibilityDiagnostic:
    """One run's bounded CLI stream, independent of the host request loop."""

    def __init__(self, directory, uid):
        path = directory / ELIGIBILITY_LOG_FILE
        os.mkfifo(path, 0o600)
        os.chown(path, uid, uid)
        self.descriptor = os.open(path, os.O_RDWR | os.O_NONBLOCK | os.O_NOFOLLOW)
        self.pending = bytearray()
        self.discard_line = False
        self.code = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._snapshot_requested = threading.Event()
        self._snapshot_ready = threading.Event()
        self._thread = threading.Thread(
            target=self._drain, name="gemini-cli-diagnostic", daemon=True
        )
        try:
            self._thread.start()
        except BaseException:
            os.close(self.descriptor)
            self.descriptor = None
            raise

    def _consume(self, chunk):
        for piece in chunk.splitlines(keepends=True):
            ended = piece.endswith(b"\n")
            if not self.discard_line:
                if len(self.pending) + len(piece) > 4096:
                    self.pending.clear()
                    self.discard_line = True
                else:
                    self.pending.extend(piece)
            if ended:
                if not self.discard_line:
                    if re.fullmatch(
                        rb"W[0-9]{4} [0-9:. ]+ [0-9]+ server_oauth\.go:[0-9]+\] "
                        rb"Account ineligible: [^\r\n]{0,256}not eligible for Antigravity, "
                        rb"because it is not currently available in your location\.\r?\n",
                        self.pending,
                    ):
                        with self._lock:
                            self.code = "gemini_location_unsupported"
                    elif re.fullmatch(
                        rb"W[0-9]{4} [0-9:. ]+ [0-9]+ server_oauth\.go:[0-9]+\] "
                        rb"Account ineligible: [^\r\n]{0,256}[Vv]erify your account[^\r\n]{0,256}\r?\n",
                        self.pending,
                    ):
                        with self._lock:
                            self.code = "gemini_account_verification_required"
                    elif re.fullmatch(
                        rb"W[0-9]{4} [0-9:. ]+ [0-9]+ server_oauth\.go:[0-9]+\] "
                        rb"Account ineligible: [^\r\n]{0,256}(?:UNSUPPORTED_CLIENT|[Uu]nsupported client|client[^\r\n]{0,64}not supported)[^\r\n]{0,256}\r?\n",
                        self.pending,
                    ):
                        with self._lock:
                            self.code = "gemini_client_unsupported"
                    elif re.fullmatch(
                        rb"W[0-9]{4} [0-9:. ]+ [0-9]+ server_oauth\.go:[0-9]+\] "
                        rb"Account ineligible: [^\r\n]{1,512}\r?\n",
                        self.pending,
                    ):
                        with self._lock:
                            if self.code is None:
                                self.code = "gemini_account_ineligible"
                self.pending.clear()
                self.discard_line = False

    def _drain(self):
        descriptor = self.descriptor
        try:
            while not self._stop.is_set():
                readable, _, _ = select.select([descriptor], [], [], 0.1)
                if not readable:
                    if self._snapshot_requested.is_set():
                        self._snapshot_requested.clear()
                        self._snapshot_ready.set()
                    continue
                # Limit each batch so a continuous writer cannot starve shutdown.
                remaining = 64 * 1024
                while remaining and not self._stop.is_set():
                    try:
                        chunk = os.read(descriptor, min(4096, remaining))
                    except BlockingIOError:
                        break
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    self._consume(chunk)
                if remaining and self._snapshot_requested.is_set():
                    self._snapshot_requested.clear()
                    self._snapshot_ready.set()
        finally:
            os.close(descriptor)
            self._snapshot_ready.set()

    def poll(self, *, final=False, include_advisory=True):
        with self._lock:
            code = self.code
        if final and code is None and self.descriptor is not None:
            # Do not miss a terminal line already queued as the child exits.
            self._snapshot_ready.clear()
            self._snapshot_requested.set()
            self._snapshot_ready.wait(timeout=0.25)
        with self._lock:
            code = self.code
        if not include_advisory and code in ADVISORY_DIAGNOSTIC_CODES:
            return None
        return code

    def clear_advisory(self):
        with self._lock:
            if self.code in ADVISORY_DIAGNOSTIC_CODES:
                self.code = None

    def close(self):
        if self.descriptor is None:
            return
        self._stop.set()
        self._thread.join(timeout=2)
        if self._thread.is_alive():
            raise RuntimeError("Gemini diagnostic drainer did not stop")
        # The reader owns the descriptor until it exits; never race fd reuse.
        self.descriptor = None
        self.pending.clear()


class NativeFailure(Exception):
    def __init__(
        self,
        code,
        status=None,
        message=None,
        retry_after_ms=None,
        upstream_reason=None,
        content_rejected=False,
    ):
        super().__init__(message or code)
        self.code = code
        self.status = status
        self.message = message
        self.retry_after_ms = retry_after_ms
        self.upstream_reason = upstream_reason
        self.content_rejected = bool(content_rejected)


def _object(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError("duplicate JSON key")
    return result


def _integer(value):
    return value if type(value) is int and 0 <= value <= 2**31 - 1 else 0


def parse_sse(frames):
    text = []
    usage = {}
    total_bytes = 0
    saw_finish = False
    for frame in frames:
        total_bytes += len(frame)
        if total_bytes > MAX_SSE or len(frame) > MAX_FRAME:
            raise NativeFailure("gemini_inference_output_limit")
        data = []
        for line in frame.replace(b"\r\n", b"\n").split(b"\n"):
            if not line or line.startswith(b":"):
                continue
            field, _, value = line.partition(b":")
            if field == b"event" and value.lstrip() == b"error":
                raise NativeFailure("gemini_inference_failed")
            if field == b"data":
                data.append(value[1:] if value.startswith(b" ") else value)
        if not data:
            continue
        try:
            payload = json.loads(
                b"\n".join(data).decode("utf-8"), object_pairs_hook=_object
            )
        except (UnicodeDecodeError, ValueError, RecursionError):
            raise NativeFailure("gemini_inference_invalid_output") from None
        if not isinstance(payload, dict) or "error" in payload:
            raise NativeFailure("gemini_inference_invalid_output")
        # The worker forwards raw SSE from both Gemini and Code Assist.
        response = payload.get("response", payload)
        if not isinstance(response, dict) or "error" in response:
            raise NativeFailure("gemini_inference_invalid_output")
        candidates = response.get("candidates", [])
        if not isinstance(candidates, list):
            raise NativeFailure("gemini_inference_invalid_output")
        for candidate in candidates:
            if not isinstance(candidate, dict):
                raise NativeFailure("gemini_inference_invalid_output")
            content = candidate.get("content", {})
            parts = content.get("parts", []) if isinstance(content, dict) else []
            if not isinstance(parts, list):
                raise NativeFailure("gemini_inference_invalid_output")
            for part in parts:
                if not isinstance(part, dict):
                    raise NativeFailure("gemini_inference_invalid_output")
                value = part.get("text")
                if value is not None:
                    if not isinstance(value, str):
                        raise NativeFailure("gemini_inference_invalid_output")
                    text.append(value)
            finish = candidate.get("finishReason")
            if finish not in (None, "", "FINISH_REASON_UNSPECIFIED"):
                saw_finish = finish in ("STOP", "MAX_TOKENS")
        metadata = response.get("usageMetadata")
        if isinstance(metadata, dict):
            input_tokens = _integer(metadata.get("promptTokenCount"))
            cached = min(
                input_tokens, _integer(metadata.get("cachedContentTokenCount"))
            )
            output_tokens = _integer(metadata.get("candidatesTokenCount"))
            thinking = _integer(metadata.get("thoughtsTokenCount"))
            total = _integer(metadata.get("totalTokenCount"))
            usage = {
                "input_tokens": input_tokens - cached,
                "output_tokens": output_tokens + thinking,
                "cache_read_tokens": cached,
                "total_tokens": total or input_tokens + output_tokens + thinking,
            }
    response_text = "".join(text)
    if not saw_finish or not response_text.strip():
        raise NativeFailure("gemini_inference_invalid_output")
    if len(response_text.encode("utf-8")) > MAX_TEXT:
        raise NativeFailure("gemini_inference_output_limit")
    return {
        "state": "completed",
        "text": response_text,
        **({"usage": usage} if usage else {}),
    }


class _UnixHTTPConnection:
    def __init__(self, path, timeout, *, keep_alive=False, sock=None):
        self.path = path
        self.timeout = timeout
        self.keep_alive = keep_alive
        self.sock = sock

    def request(self, method, path, headers, body):
        if self.sock is None:
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.settimeout(self.timeout)
            self.sock.connect(self.path)
        else:
            self.sock.settimeout(self.timeout)
        conn_hdr = "Connection: keep-alive" if self.keep_alive else "Connection: close"
        lines = [f"{method} {path} HTTP/1.1", "Host: localhost"]
        lines.extend(f"{key}: {value}" for key, value in headers.items())
        lines.extend((conn_hdr, "", ""))
        self.sock.sendall("\r\n".join(lines).encode("ascii") + body)
        return HTTPResponse(self.sock)

    def detach(self):
        sock = self.sock
        self.sock = None
        return sock

    def close(self):
        if self.sock:
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None


CONTROL_CONN_POOL_MAX_PER_PATH = 8
CONTROL_CONN_POOL_MAX_IDLE_GLOBAL = 128
CONTROL_CONN_POOL_IDLE_TTL = 30.0


class _UnixConnectionPool:
    """Thread-safe HTTP/1.1 keep-alive pool for short JSON control calls to craggemini."""

    def __init__(
        self,
        max_per_path=CONTROL_CONN_POOL_MAX_PER_PATH,
        max_idle_global=CONTROL_CONN_POOL_MAX_IDLE_GLOBAL,
        idle_ttl=CONTROL_CONN_POOL_IDLE_TTL,
    ):
        self._lock = threading.Lock()
        self._idle = {}
        self._max_per_path = max_per_path
        self._max_idle_global = max_idle_global
        self._idle_ttl = idle_ttl

    def _close_sock(self, sock):
        try:
            sock.close()
        except OSError:
            pass

    def _sweep_idle_locked(self, now_t):
        for path, bucket in list(self._idle.items()):
            kept = []
            for sock, stored_at in bucket:
                if now_t - stored_at <= self._idle_ttl:
                    kept.append((sock, stored_at))
                else:
                    self._close_sock(sock)
            if kept:
                self._idle[path] = kept
            else:
                self._idle.pop(path, None)

    def _enforce_global_cap_locked(self):
        entries = []
        for path, bucket in self._idle.items():
            for sock, stored_at in bucket:
                entries.append((stored_at, path, sock))
        excess = len(entries) - self._max_idle_global
        if excess <= 0:
            return
        entries.sort(key=lambda item: item[0])
        for _, _, sock in entries[:excess]:
            self._close_sock(sock)
        kept = entries[excess:]
        rebuilt = {}
        for stored_at, path, sock in kept:
            rebuilt.setdefault(path, []).append((sock, stored_at))
        self._idle = rebuilt

    def acquire(self, path):
        now_t = time.monotonic()
        with self._lock:
            self._sweep_idle_locked(now_t)
            bucket = self._idle.get(path)
            while bucket:
                sock, stored_at = bucket.pop()
                if now_t - stored_at <= self._idle_ttl:
                    if not bucket:
                        self._idle.pop(path, None)
                    return sock
                self._close_sock(sock)
            if bucket is not None and not bucket:
                self._idle.pop(path, None)
        return None

    def release(self, path, sock):
        if sock is None:
            return
        now_t = time.monotonic()
        with self._lock:
            self._sweep_idle_locked(now_t)
            bucket = self._idle.setdefault(path, [])
            if len(bucket) >= self._max_per_path:
                self._close_sock(sock)
                return
            bucket.append((sock, now_t))
            self._enforce_global_cap_locked()


_CONTROL_CONN_POOL = _UnixConnectionPool()


def _pooled_unix_json_exchange(socket_path, method, path, headers, body, timeout, max_bytes):
    reused_sock = _CONTROL_CONN_POOL.acquire(socket_path)
    for attempt in range(2):
        sock = reused_sock if attempt == 0 else None
        conn = _UnixHTTPConnection(socket_path, timeout, keep_alive=True, sock=sock)
        try:
            response = conn.request(method, path, headers, body)
            response.begin()
            raw = response.read(max_bytes + 1)
            can_reuse = (
                not response.will_close
                and len(raw) <= max_bytes
                and response.isclosed()
            )
            if can_reuse:
                _CONTROL_CONN_POOL.release(socket_path, conn.detach())
            else:
                conn.close()
            return response.status, raw
        except (OSError, HTTPException, ValueError):
            conn.close()
            if attempt == 0 and reused_sock is not None:
                continue
            raise


def worker_status(socket_path, token, timeout=0.5):
    try:
        status, raw = _pooled_unix_json_exchange(
            socket_path,
            "GET",
            "/internal/health",
            {"X-Kin-Internal-Token": token},
            b"",
            timeout,
            64 * 1024,
        )
        if status != 200 or len(raw) > 64 * 1024:
            return None
        data = json.loads(raw, object_pairs_hook=_object)
        return data if isinstance(data, dict) else None
    except (OSError, HTTPException, ValueError, RecursionError):
        return None


def worker_json_request(
    socket_path, token, method, path, body_obj=None, timeout=5.0
):
    if (
        not isinstance(socket_path, str)
        or not os.path.isabs(socket_path)
        or not isinstance(token, str)
        or not TOKEN.fullmatch(token)
        or method not in ("GET", "POST", "PUT", "DELETE")
        or not isinstance(path, str)
        or not path.startswith("/internal/")
    ):
        return 0, None
    body = (
        json.dumps(body_obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if body_obj is not None
        else b""
    )
    headers = {"X-Kin-Internal-Token": token}
    if body:
        headers["Content-Type"] = "application/json"
        headers["Content-Length"] = str(len(body))
    try:
        status, raw = _pooled_unix_json_exchange(
            socket_path, method, path, headers, body, timeout, 256 * 1024
        )
        if len(raw) > 256 * 1024:
            return status, None
        data = json.loads(raw, object_pairs_hook=_object) if raw else {}
        return status, data if isinstance(data, dict) else None
    except (OSError, HTTPException, ValueError, RecursionError):
        return 0, None


def cancel_worker_request(
    socket_path, token, request_id, timeout=2.0, *, account_id=None
):
    if not isinstance(request_id, str) or not REQUEST_ID.fullmatch(request_id):
        return False
    if account_id is not None:
        if not isinstance(account_id, str) or not ACCOUNT_ID.fullmatch(account_id):
            return False
        path = f"/internal/v1/accounts/{account_id}/cancel"
    else:
        path = "/internal/v1/cancel"
    status, data = worker_json_request(
        socket_path, token, "POST", path, {"request_id": request_id}, timeout=timeout
    )
    return status == 200 and isinstance(data, dict) and data.get("cancelled") is True


LICENSE_ERROR_CODES = frozenset(
    {
        "license_required",
        "license_expired",
        "license_not_yet_valid",
        "license_invalid",
        "license_binding_mismatch",
        "license_payload_key_mismatch",
        "license_unconfigured",
        "gemini_subscription_sync_pending",
    }
)

_UPSTREAM_403_REASON_TOKENS = (
    "TOS_VIOLATION",
    "UNSUPPORTED_REGION",
    "VALIDATION_REQUIRED",
    "UNSUPPORTED_CLIENT",
)


def _payload_upstream_reason(payload):
    if not isinstance(payload, dict):
        return None
    raw = payload.get("upstream_reason")
    if isinstance(raw, str):
        token = raw.strip()
        if len(token) > 0:
            upper = token.upper()
            if upper in _UPSTREAM_403_REASON_TOKENS:
                return upper
            return upper
    for key in ("message", "error"):
        val = payload.get(key)
        if not isinstance(val, str):
            continue
        text = val.strip()
        if len(text) == 0:
            continue
        upper = text.upper()
        for token in _UPSTREAM_403_REASON_TOKENS:
            if token in upper:
                return token
    return None


def _map_effective_403(payload, message):
    reason = _payload_upstream_reason(payload)
    if reason == "TOS_VIOLATION":
        return NativeFailure("gemini_account_ineligible", 403, message)
    return NativeFailure("gemini_location_unsupported", 403, message)


def _map_worker_error(http_status, payload):
    code = payload.get("code") if isinstance(payload, dict) else None
    upstream = payload.get("upstream_status") if isinstance(payload, dict) else None
    message = payload.get("error") if isinstance(payload, dict) and isinstance(payload.get("error"), str) else None
    if isinstance(code, str) and code in LICENSE_ERROR_CODES:
        return NativeFailure(code, 503 if code == "gemini_subscription_sync_pending" else 403, message)
    effective_status = upstream if isinstance(upstream, int) and 400 <= upstream <= 599 else http_status
    if code == "unsupported_turn":
        return NativeFailure("gemini_unsupported_turn", 400, message)
    if code in ("invalid_envelope", "invalid_json"):
        return NativeFailure("gemini_invalid_request", 400, message)
    if code in ("queue_full", "native_unavailable", "kernel_stopping", "slot_shm_required", "account_circuit_open"):
        return NativeFailure(
            "gemini_operation_busy"
            if code == "queue_full"
            else "gemini_native_worker_unavailable",
            503,
            message,
        )
    if code in ("first_byte_timeout", "turn_timeout", "idle_timeout", "queue_timeout"):
        return NativeFailure("gemini_inference_timeout", 504, message)
    if code == "cancelled":
        return NativeFailure("gemini_inference_cancelled", 499, message)
    if code in ("tool_continuation_aborted", "gemini_session_conflict"):
        return NativeFailure("gemini_session_conflict", 409, message)
    if effective_status == 429:
        raw_retry = payload.get("retry_after_ms") if isinstance(payload, dict) else None
        retry_after_ms = (
            raw_retry
            if type(raw_retry) is int and 1 <= raw_retry <= 3_600_000
            else None
        )
        raw_reason = payload.get("upstream_reason") if isinstance(payload, dict) else None
        upstream_reason = raw_reason if isinstance(raw_reason, str) and raw_reason else None
        content_rejected = bool(
            isinstance(payload, dict)
            and (payload.get("content_rejected") is True or code == "gemini_content_rejected")
        )
        return NativeFailure(
            "gemini_content_rejected" if content_rejected else "gemini_quota_exhausted",
            429,
            message,
            retry_after_ms=retry_after_ms,
            upstream_reason=upstream_reason,
            content_rejected=content_rejected,
        )
    if effective_status == 401:
        return NativeFailure("gemini_oauth_required", 401, message)
    if effective_status == 403:
        return _map_effective_403(payload, message)
    if effective_status == 404:
        return NativeFailure("gemini_model_unavailable", 404, message)
    if code == "upstream_unavailable" or effective_status == 503:
        raw_retry = payload.get("retry_after_ms") if isinstance(payload, dict) else None
        retry_after_ms = (
            raw_retry
            if type(raw_retry) is int and 1 <= raw_retry <= 3_600_000
            else None
        )
        return NativeFailure(
            "gemini_upstream_unavailable",
            503,
            message or "Gemini upstream service temporarily unavailable",
            retry_after_ms=retry_after_ms,
        )
    return NativeFailure("gemini_inference_failed", effective_status if 400 <= effective_status <= 599 else 502, message)


def _worker_ready(status):
    if not isinstance(status, dict) or status.get("ready") is not True:
        return False
    native_pid = status.get("native_pid")
    if type(native_pid) is int and native_pid > 0:
        return True
    pool = status.get("pool")
    return isinstance(pool, dict) and pool.get("enabled") is True and pool.get("ready") is True


def open_worker_stream(
    socket_path,
    token,
    model,
    request_id,
    body_obj,
    *,
    startup_timeout=45,
    turn_timeout=TURN_TIMEOUT,
    gateway_policy=None,
    restart_resume=False,
    diagnostic=None,
    account_id=None,
    is_alive=None,
    exit_reader=None,
    skip_ready_probe=False,
):
    if (
        not isinstance(socket_path, str)
        or not os.path.isabs(socket_path)
        or not isinstance(token, str)
        or not TOKEN.fullmatch(token)
        or not isinstance(model, str)
        or not MODEL.fullmatch(model)
        or not isinstance(request_id, str)
        or not REQUEST_ID.fullmatch(request_id)
        or not isinstance(body_obj, dict)
        or (
            account_id is not None
            and (not isinstance(account_id, str) or not ACCOUNT_ID.fullmatch(account_id))
        )
    ):
        raise NativeFailure("gemini_inference_bad_input", 400)

    def _wait_worker_ready():
        start_deadline = time.monotonic() + startup_timeout
        while time.monotonic() < start_deadline:
            diag_code = poll_diagnostic(diagnostic, include_advisory=False)
            if diag_code is not None:
                raise NativeFailure(diag_code, 403)
            if exit_reader is not None:
                outcome = exit_reader()
                if outcome is not None:
                    final_diag = poll_diagnostic(diagnostic, final=True, include_advisory=True)
                    if final_diag is not None:
                        raise NativeFailure(final_diag, 403)
                    raise launcher_exit_failure(outcome)
            if is_alive is not None and not is_alive():
                final_diag = poll_diagnostic(diagnostic, final=True, include_advisory=True)
                if final_diag is not None:
                    raise NativeFailure(final_diag, 403)
                outcome = exit_reader() if exit_reader is not None else None
                if outcome is not None:
                    raise launcher_exit_failure(outcome)
                raise NativeFailure("gemini_native_worker_unavailable", 503)
            status = worker_status(socket_path, token, timeout=0.25)
            if status and status.get("license_valid") is False:
                lic = status.get("license") if isinstance(status.get("license"), dict) else {}
                lic_code = lic.get("code") if isinstance(lic.get("code"), str) and lic.get("code") in LICENSE_ERROR_CODES else "license_required"
                raise NativeFailure(lic_code, 403, lic.get("message") if isinstance(lic.get("message"), str) else None)
            if status and status.get("needs_recovery") is True:
                raise NativeFailure("gemini_native_worker_unavailable", 503)
            if _worker_ready(status):
                return
            time.sleep(0.05)
        final_diag = poll_diagnostic(diagnostic, final=True, include_advisory=True)
        if final_diag is not None:
            raise NativeFailure(final_diag, 403)
        raise NativeFailure("gemini_native_bridge_timeout", 503)

    wire_body = body_obj
    system_prompt_mode = body_obj.get("system_prompt_mode")
    if system_prompt_mode is not None:
        if system_prompt_mode not in ("official_full", "zero"):
            raise NativeFailure("gemini_inference_bad_input", 400)
        wire_body = {k: v for k, v in body_obj.items() if k != "system_prompt_mode"}
    envelope = {
        "request_id": request_id,
        "stream": True,
        "body": wire_body,
    }
    if restart_resume is True:
        envelope["restart_resume"] = True
    if system_prompt_mode == "zero":
        envelope["system_prompt_mode"] = "zero"
    conv_id = wire_body.get("conversation_id") or wire_body.get("conversationId")
    if isinstance(conv_id, str) and REQUEST_ID.fullmatch(conv_id):
        envelope["conversation_id"] = conv_id
    if isinstance(gateway_policy, dict) and gateway_policy:
        envelope["gateway_policy"] = gateway_policy
    payload = json.dumps(envelope, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(payload) > MAX_BODY:
        raise NativeFailure("gemini_inference_output_limit", 413)
    message_path = (
        f"/internal/v1/accounts/{account_id}/messages"
        if account_id is not None
        else "/internal/v1/messages"
    )

    if not skip_ready_probe:
        _wait_worker_ready()
    else:
        diag_code = poll_diagnostic(diagnostic, include_advisory=False)
        if diag_code is not None:
            raise NativeFailure(diag_code, 403)
        if exit_reader is not None:
            outcome = exit_reader()
            if outcome is not None:
                final_diag = poll_diagnostic(diagnostic, final=True, include_advisory=True)
                if final_diag is not None:
                    raise NativeFailure(final_diag, 403)
                raise launcher_exit_failure(outcome)
        if is_alive is not None and not is_alive():
            final_diag = poll_diagnostic(diagnostic, final=True, include_advisory=True)
            if final_diag is not None:
                raise NativeFailure(final_diag, 403)
            outcome = exit_reader() if exit_reader is not None else None
            if outcome is not None:
                raise launcher_exit_failure(outcome)
            raise NativeFailure("gemini_native_worker_unavailable", 503)

    probed_after_skip = not skip_ready_probe
    while True:
        connection = _UnixHTTPConnection(socket_path, turn_timeout)
        try:
            diag_code = poll_diagnostic(diagnostic, include_advisory=False)
            if diag_code is not None:
                raise NativeFailure(diag_code, 403)
            response = connection.request(
                "POST",
                message_path,
                {
                    "Content-Type": "application/json",
                    "Content-Length": str(len(payload)),
                    "X-Kin-Internal-Token": token,
                },
                payload,
            )
            if diagnostic is not None and connection.sock is not None:
                header_deadline = time.monotonic() + turn_timeout
                while time.monotonic() < header_deadline:
                    diag_code = poll_diagnostic(diagnostic, include_advisory=False)
                    if diag_code is not None:
                        connection.close()
                        cancel_worker_request(
                            socket_path, token, request_id, account_id=account_id
                        )
                        raise NativeFailure(diag_code, 403)
                    remaining = header_deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    readable, _, _ = select.select(
                        [connection.sock], [], [], min(0.2, remaining)
                    )
                    if readable:
                        break
            response.begin()
            ct = (response.getheader("Content-Type") or "").split(";", 1)[0].strip().lower()
            if response.status != 200 or ct != "text/event-stream":
                raw = response.read(64 * 1024)
                err_payload = None
                try:
                    err_payload = json.loads(raw) if raw else None
                except ValueError:
                    err_payload = None
                connection.close()
                mapped = _map_worker_error(response.status, err_payload)
                if (
                    not probed_after_skip
                    and mapped.code == "gemini_native_worker_unavailable"
                    and response.status == 503
                ):
                    probed_after_skip = True
                    _wait_worker_ready()
                    continue
                raise mapped
            return connection, response
        except NativeFailure:
            raise
        except (OSError, TimeoutError, HTTPException):
            connection.close()
            if not probed_after_skip:
                probed_after_skip = True
                _wait_worker_ready()
                continue
            raise NativeFailure("gemini_inference_failed", 502) from None


def query_free_vt(lock_path):
    descriptor = os.open(
        lock_path,
        os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC,
        0o600,
    )
    try:
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != 0
            or info.st_nlink != 1
            or info.st_mode & 0o077
        ):
            raise NativeFailure("gemini_native_tty_unavailable")
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        tty0 = os.open("/dev/tty0", os.O_RDWR | os.O_NOCTTY | os.O_CLOEXEC)
        try:
            result = bytearray(struct.pack("i", 0))
            fcntl.ioctl(tty0, 0x5600, result, True)
            number = struct.unpack("i", result)[0]
        finally:
            os.close(tty0)
        if not 1 <= number <= 63:
            raise NativeFailure("gemini_native_tty_unavailable")
        return descriptor, number
    except BaseException:
        os.close(descriptor)
        raise


def run_request(request):
    if not isinstance(request, dict):
        raise NativeFailure("gemini_inference_bad_input")
    socket_path = request.get("socket")
    token = request.get("token")
    model = request.get("model")
    request_id = request.get("request_id")
    prompt = request.get("prompt")
    account_id = request.get("account_id")
    if (
        not isinstance(socket_path, str)
        or not os.path.isabs(socket_path)
        or not isinstance(token, str)
        or not TOKEN.fullmatch(token)
        or not isinstance(model, str)
        or not MODEL.fullmatch(model)
        or not isinstance(request_id, str)
        or not REQUEST_ID.fullmatch(request_id)
        or not isinstance(prompt, str)
        or not prompt.strip()
        or len(prompt.encode("utf-8")) > 4096
        or (
            account_id is not None
            and (not isinstance(account_id, str) or not ACCOUNT_ID.fullmatch(account_id))
        )
    ):
        raise NativeFailure("gemini_inference_bad_input")
    startup_timeout = request.get("startup_timeout", 45)
    if type(startup_timeout) is not int or not 1 <= startup_timeout <= 45:
        startup_timeout = 45
    launcher_uid = request.get("launcher_uid")
    if launcher_uid is not None and (type(launcher_uid) is not int or launcher_uid < 0):
        launcher_uid = None
    socket_dir = Path(socket_path).parent
    start_deadline = time.monotonic() + startup_timeout
    while time.monotonic() < start_deadline:
        if launcher_uid is not None:
            outcome = read_launcher_exit_detail(socket_dir, launcher_uid)
            if outcome is not None:
                raise launcher_exit_failure(outcome)
        status = worker_status(socket_path, token, timeout=0.25)
        if status and status.get("license_valid") is False:
            lic = status.get("license") if isinstance(status.get("license"), dict) else {}
            lic_code = lic.get("code") if isinstance(lic.get("code"), str) and lic.get("code") in LICENSE_ERROR_CODES else "license_required"
            raise NativeFailure(lic_code, 403, lic.get("message") if isinstance(lic.get("message"), str) else None)
        if _worker_ready(status):
            break
        time.sleep(0.1)
    else:
        raise NativeFailure("gemini_native_bridge_timeout")
    body = json.dumps(
        {
            "request_id": request_id,
            "stream": True,
            "body": {
                "model": model,
                "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            },
        },
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    if len(body) > MAX_BODY:
        raise NativeFailure("gemini_inference_output_limit")
    message_path = (
        f"/internal/v1/accounts/{account_id}/messages"
        if account_id is not None
        else "/internal/v1/messages"
    )
    connection = _UnixHTTPConnection(socket_path, TURN_TIMEOUT)
    try:
        response = connection.request(
            "POST",
            message_path,
            {
                "Content-Type": "application/json",
                "Content-Length": str(len(body)),
                "X-Kin-Internal-Token": token,
            },
            body,
        )
        response.begin()
        if response.status != 200:
            raw = response.read(64 * 1024)
            err_payload = None
            try:
                err_payload = json.loads(raw) if raw else None
            except ValueError:
                err_payload = None
            raise _map_worker_error(response.status, err_payload)
        frames = []
        pending = bytearray()
        total = 0
        while True:
            chunk = response.read1(65536)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_SSE:
                raise NativeFailure("gemini_inference_output_limit")
            pending.extend(chunk)
            while True:
                boundary = pending.find(b"\n\n")
                cr_boundary = pending.find(b"\r\n\r\n")
                if cr_boundary >= 0 and (boundary < 0 or cr_boundary < boundary):
                    boundary, width = cr_boundary, 4
                elif boundary >= 0:
                    width = 2
                else:
                    if len(pending) > MAX_FRAME:
                        raise NativeFailure("gemini_inference_output_limit")
                    break
                frames.append(bytes(pending[: boundary + width]))
                del pending[: boundary + width]
        if pending:
            raise NativeFailure("gemini_inference_invalid_output")
        return parse_sse(frames)
    except (OSError, TimeoutError, HTTPException):
        raise NativeFailure("gemini_inference_failed") from None
    finally:
        connection.close()


class NativeInvocation:
    """Pollable worker request helper; only a private Unix socket is reachable."""

    def __init__(self, request, secrets=()):
        self._process = subprocess.Popen(
            [sys.executable, "-I", os.path.abspath(__file__), "--request-worker"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            bufsize=0,
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        )
        self._stdout = bytearray()
        self._snapshot = None
        self._secrets = tuple(
            sorted(
                (value for value in secrets if isinstance(value, str) and value),
                key=len,
                reverse=True,
            )
        )
        os.set_blocking(self._process.stdout.fileno(), False)
        payload = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8"
        )
        try:
            self._process.stdin.write(payload)
            self._process.stdin.close()
        except OSError:
            self.close()
            raise NativeFailure("gemini_inference_start_failed") from None

    def poll(self):
        if self._snapshot is not None:
            return dict(self._snapshot)
        process = self._process
        descriptor = process.stdout.fileno()
        try:
            ready, _, _ = select.select([descriptor], [], [], 0)
            if ready:
                while True:
                    try:
                        chunk = os.read(descriptor, 65536)
                    except BlockingIOError:
                        break
                    if not chunk:
                        break
                    if len(self._stdout) + len(chunk) > MAX_RESULT:
                        raise NativeFailure("gemini_inference_output_limit")
                    self._stdout.extend(chunk)
            status = process.poll()
            if status is None:
                return {"state": "running", "text": ""}
            if status != 0:
                raise NativeFailure("gemini_inference_failed")
            result = json.loads(bytes(self._stdout), object_pairs_hook=_object)
            if not isinstance(result, dict) or result.get("state") not in (
                "completed",
                "failed",
            ):
                raise NativeFailure("gemini_inference_invalid_output")
            if isinstance(result.get("text"), str):
                for secret in self._secrets:
                    result["text"] = result["text"].replace(secret, "[redacted]")
            self._snapshot = result
        except (OSError, ValueError, RecursionError, NativeFailure) as error:
            code = (
                error.code
                if isinstance(error, NativeFailure)
                else "gemini_inference_failed"
            )
            self._snapshot = {"state": "failed", "text": "", "error": {"code": code}}
        self._stdout.clear()
        self._secrets = ()
        return dict(self._snapshot)

    def close(self):
        process = getattr(self, "_process", None)
        if process is None:
            return
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        for pipe in (process.stdin, process.stdout, process.stderr):
            if pipe and not pipe.closed:
                pipe.close()
        process.wait(timeout=5)
        self._process = None


def _classify_worker_stderr(raw):
    if not raw:
        return None
    text = raw[:MAX_WORKER_STDERR].decode("utf-8", errors="ignore").lower()
    if (
        "invalid configuration" in text
        or "unknown field" in text
        or (
            "config" in text
            and (
                "failed to parse" in text
                or "invalid json" in text
                or "json or fields" in text
            )
        )
    ):
        return "invalid_config"
    if "license" in text and any(
        token in text for token in ("invalid", "expired", "missing", "required", "mismatch")
    ):
        return "license_error"
    if "address already in use" in text or (
        "failed to bind" in text and "socket" in text
    ):
        return "bind_failed"
    return None


def _drain_stderr(pipe, captured):
    try:
        while True:
            chunk = pipe.read(1024)
            if not chunk:
                break
            remaining = MAX_WORKER_STDERR - len(captured)
            if remaining > 0:
                captured.extend(chunk[:remaining])
    except OSError:
        pass
    finally:
        try:
            pipe.close()
        except OSError:
            pass


def read_launcher_exit_detail(directory, uid):
    try:
        descriptor = os.open(
            Path(directory) / LAUNCHER_EXIT_FILE,
            os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
        )
        with os.fdopen(descriptor, "rb") as stream:
            info = os.fstat(stream.fileno())
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != uid
                or info.st_nlink != 1
            ):
                return None
            match = LAUNCHER_EXIT.fullmatch(stream.read(96))
    except OSError:
        return None
    if match is not None:
        status = int(match[2])
        if -signal.NSIG < status <= 255:
            reason_raw = match[3].decode("ascii") if match[3] is not None else None
            reason = reason_raw if reason_raw in LAUNCHER_EXIT_REASONS else None
            return match[1].decode("ascii"), status, reason
    return None


def read_launcher_exit(directory, uid):
    detail = read_launcher_exit_detail(directory, uid)
    if detail is None:
        return None
    return detail[0], detail[1]


def launcher_exit_code(outcome):
    if outcome is None:
        return "gemini_native_worker_unavailable"
    reason = outcome[2] if len(outcome) >= 3 else None
    if reason == "invalid_config":
        return "gemini_native_config_invalid"
    return "gemini_native_worker_unavailable"


def launcher_exit_failure(outcome):
    return NativeFailure(launcher_exit_code(outcome), 503)


def _record_launcher_exit(directory, name, returncode, reason=None):
    suffix = f" {reason}" if reason in LAUNCHER_EXIT_REASONS else ""
    try:
        with open(f"{directory}/{LAUNCHER_EXIT_FILE}", "x", encoding="ascii") as stream:
            stream.write(f"{name} {returncode}{suffix}\n")
    except OSError:
        # Diagnostic I/O must not replace the child's exit or bypass cleanup.
        pass


def _is_pool_mode_config(config_path):
    try:
        with open(config_path, "rb") as stream:
            data = json.loads(stream.read(256 * 1024))
        if not isinstance(data, dict):
            return False
        accounts = data.get("accounts")
        return (isinstance(accounts, list) and len(accounts) > 0) or (
            isinstance(data.get("max_accounts"), int) and data.get("max_accounts") >= 1
        )
    except (OSError, ValueError):
        return False


def _launch_native(argv, *, worker_bin="/opt/craggemini", directory="/tmp/craggemini", startup_timeout=5):
    # Both children must use the same PID namespace and procfs: the worker
    # compares SO_PEERCRED with the PID reported by the in-process adapter.
    config_path = directory + "/kernel.json"
    pool_mode = _is_pool_mode_config(config_path)
    worker = subprocess.Popen(
        [worker_bin, "--gateway-worker", "--config", config_path],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    stderr_buf = bytearray()
    stderr_drain = threading.Thread(
        target=_drain_stderr,
        args=(worker.stderr, stderr_buf),
        name="craggemini-stderr",
        daemon=True,
    )
    stderr_drain.start()
    tui = None
    try:
        required_sockets = ("kernel.sock",) if pool_mode else ("kernel.sock", "native.sock")
        deadline = time.monotonic() + startup_timeout
        while worker.poll() is None and time.monotonic() < deadline:
            if all(os.path.exists(f"{directory}/{name}") for name in required_sockets):
                break
            time.sleep(0.025)
        else:
            if worker.poll() is not None:
                stderr_drain.join(timeout=0.5)
                reason = _classify_worker_stderr(bytes(stderr_buf))
                _record_launcher_exit(directory, "craggemini", worker.returncode, reason=reason)
            return 1
        if pool_mode:
            # In multi-process pool mode, craggemini spawns and guards up to
            # max_concurrency agy processes with per-slot PTYs and memfd rings.
            code = worker.wait()
            stderr_drain.join(timeout=0.5)
            reason = _classify_worker_stderr(bytes(stderr_buf))
            _record_launcher_exit(directory, "craggemini", code, reason=reason)
            return code if code >= 0 else 128 - code
        tui = subprocess.Popen(
            argv,
            env={
                **os.environ,
                "CRAGGEMINI_NATIVE_SOCKET": directory + "/native.sock",
                "CRAGGEMINI_SESSION_ID": os.environ["CRAGGEMINI_SESSION_ID"],
                "LD_PRELOAD": "/opt/libagy_bridge.so",
            },
        )
        pid, status = os.wait()
        child = worker if pid == worker.pid else tui
        child.returncode = os.waitstatus_to_exitcode(status)
        reason = None
        if child is worker:
            stderr_drain.join(timeout=0.5)
            reason = _classify_worker_stderr(bytes(stderr_buf))
        _record_launcher_exit(
            directory,
            "craggemini" if child is worker else "agy",
            child.returncode,
            reason=reason,
        )
        return child.returncode if child.returncode >= 0 else 128 - child.returncode
    finally:
        for child in (tui, worker):
            if child is not None:
                child.kill()
                child.wait()
        stderr_drain.join(timeout=0.5)


def _worker_main():
    try:
        raw = sys.stdin.buffer.read(16 * 1024 + 1)
        if len(raw) > 16 * 1024:
            raise NativeFailure("gemini_inference_bad_input")
        request = json.loads(raw, object_pairs_hook=_object)
        result = run_request(request)
    except NativeFailure as error:
        result = {"state": "failed", "text": "", "error": {"code": error.code}}
    except (ValueError, RecursionError):
        result = {
            "state": "failed",
            "text": "",
            "error": {"code": "gemini_inference_invalid_output"},
        }
    sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--request-worker"]:
        raise SystemExit(_worker_main())
    if sys.argv[1:2] == ["--launch-native"] and len(sys.argv) > 2:
        raise SystemExit(_launch_native(sys.argv[2:]))
