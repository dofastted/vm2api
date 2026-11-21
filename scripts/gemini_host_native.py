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
import time
from http.client import HTTPResponse

MAX_BODY = 256 * 1024
MAX_FRAME = 2 * 1024 * 1024
MAX_SSE = 8 * 1024 * 1024
MAX_TEXT = 16 * 1024
MAX_RESULT = 64 * 1024
TURN_TIMEOUT = 125
TOKEN = re.compile(r"[!-~]{24,4096}\Z")
MODEL = re.compile(r"[a-z0-9][a-z0-9._-]{0,99}\Z")
REQUEST_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")


class NativeFailure(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


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
    def __init__(self, path, timeout):
        self.path = path
        self.timeout = timeout
        self.sock = None

    def request(self, method, path, headers, body):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)
        lines = [f"{method} {path} HTTP/1.1", "Host: localhost"]
        lines.extend(f"{key}: {value}" for key, value in headers.items())
        lines.extend(("Connection: close", "", ""))
        self.sock.sendall("\r\n".join(lines).encode("ascii") + body)
        return HTTPResponse(self.sock)

    def close(self):
        if self.sock:
            self.sock.close()
            self.sock = None


def worker_status(socket_path, token, timeout=0.5):
    connection = _UnixHTTPConnection(socket_path, timeout)
    try:
        response = connection.request(
            "GET", "/internal/health", {"X-Kin-Internal-Token": token}, b""
        )
        response.begin()
        if response.status != 200:
            return None
        raw = response.read(64 * 1024 + 1)
        if len(raw) > 64 * 1024:
            return None
        data = json.loads(raw, object_pairs_hook=_object)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError, RecursionError):
        return None
    finally:
        connection.close()


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
    ):
        raise NativeFailure("gemini_inference_bad_input")
    startup_timeout = request.get("startup_timeout", 45)
    if type(startup_timeout) is not int or not 1 <= startup_timeout <= 45:
        startup_timeout = 45
    start_deadline = time.monotonic() + startup_timeout
    while time.monotonic() < start_deadline:
        status = worker_status(socket_path, token, timeout=0.25)
        native_pid = status.get("native_pid") if status else None
        if (
            status
            and status.get("ready") is True
            and type(native_pid) is int
            and native_pid > 0
        ):
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
    connection = _UnixHTTPConnection(socket_path, TURN_TIMEOUT)
    try:
        response = connection.request(
            "POST",
            "/internal/v1/messages",
            {
                "Content-Type": "application/json",
                "Content-Length": str(len(body)),
                "X-Kin-Internal-Token": token,
            },
            body,
        )
        response.begin()
        if response.status != 200:
            raise NativeFailure("gemini_inference_failed")
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
    except (OSError, TimeoutError):
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


def _launch_native(argv):
    # Both children must use the same PID namespace and procfs: the worker
    # compares SO_PEERCRED with the PID reported by the in-process adapter.
    directory = "/tmp/craggemini"
    worker = subprocess.Popen(
        ["/opt/craggemini", "--gateway-worker", "--config", directory + "/kernel.json"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    tui = None
    try:
        deadline = time.monotonic() + 5
        while worker.poll() is None and time.monotonic() < deadline:
            if all(
                os.path.exists(f"{directory}/{name}")
                for name in ("kernel.sock", "native.sock")
            ):
                break
            time.sleep(0.025)
        else:
            return 1
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
        return child.returncode if child.returncode >= 0 else 128 - child.returncode
    finally:
        for child in (tui, worker):
            if child is not None:
                child.kill()
                child.wait()


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
