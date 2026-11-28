"""Bounded, no-approval subprocess protocol for the Gemini host diagnostic.

The caller owns the sandbox and its private, deny-by-default CLI settings, and
must call close() when retiring an invocation (including on client cancellation).
"""

import json
import os
import re
import signal
import subprocess


MODEL_ARGS = ("models",)
_MODEL_SLUG = r"[a-z0-9][a-z0-9._-]{0,127}"
_MODEL_ROW = re.compile(rf"[ \t]*({_MODEL_SLUG})([ \t]+)\S.*")
_SGR = re.compile(r"\x1b\[[0-9;:]*m")
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x0d\x0e-\x1f\x7f-\x9f]")
_CREDENTIAL = re.compile(
    r"https?://[^\s/@]+:[^\s/@]+@|socks5h?://[^\s/@]+:[^\s/@]+@"
    r"|\b(?:AIza[\w-]{35}|ya29\.[\w.-]+|eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+)"
    r"|1//[\w.-]+"
    r"|(?i:\bbearer[ \t]+[a-z0-9._~+/=-]+)"
)
_MAX_STDIN = 1024 * 1024
_MAX_MODEL_OUTPUT = 128 * 1024
_MAX_STDOUT = 4 * 1024 * 1024
_MAX_STDERR = 128 * 1024
_MAX_LINE = 1024 * 1024
_MAX_TEXT = 16 * 1024
_MAX_DIAGNOSTIC = 16 * 1024
_IO_CHUNK = 64 * 1024
_USAGE_FIELDS = (
    "input_tokens",
    "output_tokens",
    "thinking_tokens",
    "cache_read_tokens",
    "total_tokens",
)
_ERROR_MESSAGES = {
    "gemini_inference_bad_input": "The test request is invalid or too large.",
    "gemini_inference_start_failed": "The Gemini diagnostic could not start.",
    "gemini_inference_failed": "The Gemini diagnostic failed.",
    "gemini_inference_invalid_output": "The Gemini diagnostic returned invalid output.",
    "gemini_inference_output_limit": "The Gemini diagnostic exceeded its output limit.",
    "gemini_inference_cancelled": "The Gemini diagnostic was cancelled.",
    "gemini_inference_tool_blocked": "The diagnostic does not allow tools.",
    "gemini_models_empty": "Gemini returned no available models.",
    "gemini_model_unavailable": "The selected model is unavailable.",
    "gemini_oauth_required": "Sign in to Gemini again to run this diagnostic.",
    "gemini_location_unsupported": (
        "Google rejected Antigravity access (403). The egress region may be unsupported or the account may be "
        "disabled; eligibility checks can still look normal—confirm with an actual conversation."
    ),
    "gemini_api_key_invalid": "The Gemini API key was rejected.",
    "gemini_proxy_error": "Gemini could not be reached through the configured proxy.",
    "gemini_quota_exhausted": "The Gemini quota or rate limit was reached.",
}
_UPSTREAM_CODES = frozenset(
    (
        "gemini_model_unavailable",
        "gemini_oauth_required",
        "gemini_api_key_invalid",
        "gemini_proxy_error",
        "gemini_quota_exhausted",
    )
)
_DIAGNOSTIC_CODES = (
    (
        "gemini_location_unsupported",
        re.compile(
            r"not eligible for antigravity[^\n]{0,160}not currently available in your location"
        ),
    ),
    (
        "gemini_oauth_required",
        re.compile(
            r"authentication required|not (?:logged|signed) in|(?:re)?authenticate with"
            r"|invalid_grant|unauthenticated|reauthentication required|credentials (?:expired|revoked)"
            r"|please sign in to view available models"
        ),
    ),
    (
        "gemini_model_unavailable",
        re.compile(
            r"invalid model selection|unknown model|model [^\r\n]{1,160} (?:was |is )?"
            r"(?:not found|not recognized|unavailable)|model_not_found"
        ),
    ),
    (
        "gemini_api_key_invalid",
        re.compile(r"api_key_invalid|api key (?:not valid|is invalid)"),
    ),
    (
        "gemini_quota_exhausted",
        re.compile(r"resource_exhausted|quota exceeded|rate limit exceeded"),
    ),
)
_PROXY_FAILURE = re.compile(
    r"proxyconnect|proxy error|proxy authentication|proxy connection|socks[45]? (?:connect|proxy)"
    r"|dial tcp|network is unreachable|no such host|connection refused|connection reset"
    r"|(?:i/o|tls handshake|awaiting response headers) timeout"
)
_TOOL_DENIAL = re.compile(r"headless mode cannot prompt|auto-denied.*permission", re.I)


def chat_args(model):
    """Official agy suffix; the prompt is not an argument or environment value."""
    if not isinstance(model, str) or not re.fullmatch(_MODEL_SLUG, model):
        raise ValueError("invalid Gemini model slug")
    return (
        # Streaming input selects print mode without -p, which takes an argument.
        "--mode",
        "plan",
        "--disable-slash-commands",
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--model",
        model,
    )


def parse_models(output):
    """Project only the first column of official `agy models` text rows."""
    slugs = {}
    for line in _SGR.sub("", output).splitlines():
        match = _MODEL_ROW.fullmatch(line)
        if match and (len(match[2]) >= 2 or "\t" in match[2]):
            slugs[match[1]] = None
    return list(slugs)


def _bounded_int(value):
    if len(value) > 16:
        raise ValueError("integer out of range")
    return int(value)


def _object(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError("duplicate JSON key")
    return result


def _invalid_constant(_):
    raise ValueError("invalid JSON constant")


def _usage(value):
    if not isinstance(value, dict):
        return {}
    return {
        key: value[key]
        for key in _USAGE_FIELDS
        if type(value.get(key)) is int and 0 <= value[key] <= 2**31 - 1
    }


def _diagnostic_code(*messages):
    normalized = [
        message[:_MAX_DIAGNOSTIC].strip().lower()
        for message in messages
        if isinstance(message, str)
    ]
    for message in normalized:
        if message in _UPSTREAM_CODES:
            return message
    # The CLI may report a generic sign-in error after a failed proxy request.
    if any(_PROXY_FAILURE.search(message) for message in normalized):
        return "gemini_proxy_error"
    for code, pattern in _DIAGNOSTIC_CODES:
        if any(pattern.search(message) for message in normalized):
            return code
    return None


class _ProtocolError(Exception):
    pass


class Invocation:
    """One agy turn, models listing, or trusted helper with the same protocol.

    poll() is nonblocking, and snapshots stay stable once terminal. Chat text
    is released only after a successful final result and clean process exit.
    input_bytes optionally replaces the agy stdin frame for a trusted helper.
    """

    def __init__(self, argv, env, prompt=None, *, input_bytes=None, secrets=()):
        self._process = None
        self._group_stopped = False
        self._snapshot = None
        self._models = prompt is None
        self._secret_values = tuple(
            sorted(
                (
                    value
                    for value in (secrets or ())
                    if isinstance(value, str) and value
                ),
                key=len,
                reverse=True,
            )
        )
        self._input = b""
        self._input_offset = 0
        self._input_incomplete = False
        self._stdout = bytearray()
        self._stderr = bytearray()
        self._stdout_bytes = 0
        self._stderr_bytes = 0
        self._text = []
        self._text_bytes = 0
        self._result_status = None
        self._result_error = None
        self._result_usage = {}
        try:
            if input_bytes is not None:
                if (
                    self._models
                    or not isinstance(input_bytes, bytes)
                    or not input_bytes
                ):
                    raise ValueError
                self._input = input_bytes
            elif not self._models:
                if not isinstance(prompt, str) or len(prompt) > _MAX_STDIN:
                    raise ValueError
                # The official stdin protocol is one user message per NDJSON
                # record. Never send a control/permission response or a second turn.
                message = {"event": "user", "message": {"content": prompt}}
                self._input = (json.dumps(message, ensure_ascii=False) + "\n").encode(
                    "utf-8"
                )
            if len(self._input) > _MAX_STDIN:
                raise ValueError
        except ValueError:
            self._fail("gemini_inference_bad_input")
            return
        try:
            self._process = subprocess.Popen(
                argv,
                env=env,
                start_new_session=True,
                bufsize=0,
                stdin=subprocess.DEVNULL if self._models else subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            for pipe in (
                self._process.stdin,
                self._process.stdout,
                self._process.stderr,
            ):
                if pipe is not None:
                    os.set_blocking(pipe.fileno(), False)
        except (OSError, ValueError):
            self._fail("gemini_inference_start_failed")

    def _write_input(self):
        pipe = self._process.stdin
        if pipe is None or pipe.closed:
            return
        try:
            self._input_offset += os.write(
                pipe.fileno(),
                memoryview(self._input)[
                    self._input_offset : self._input_offset + _IO_CHUNK
                ],
            )
        except BlockingIOError:
            return
        except BrokenPipeError:
            self._input_incomplete = True
        if self._input_incomplete or self._input_offset == len(self._input):
            pipe.close()
            self._input = b""

    def _read_stdout(self):
        pipe = self._process.stdout
        if pipe.closed:
            return
        try:
            chunk = os.read(pipe.fileno(), _IO_CHUNK)
        except BlockingIOError:
            return
        if not chunk:
            pipe.close()
            if not self._models and self._stdout:
                self._event(self._stdout)
                self._stdout.clear()
            return
        self._stdout_bytes += len(chunk)
        if self._stdout_bytes > (_MAX_MODEL_OUTPUT if self._models else _MAX_STDOUT):
            raise _ProtocolError("gemini_inference_output_limit")
        if self._models:
            self._stdout.extend(chunk)
            return
        lines = chunk.split(b"\n")
        if len(lines) > 1:
            self._stdout.extend(lines[0])
            self._event(self._stdout)
            self._stdout.clear()
            for line in lines[1:-1]:
                self._event(line)
        self._stdout.extend(lines[-1])
        if len(self._stdout) > _MAX_LINE:
            raise _ProtocolError("gemini_inference_output_limit")

    def _read_stderr(self):
        pipe = self._process.stderr
        if pipe.closed:
            return
        try:
            chunk = os.read(pipe.fileno(), _IO_CHUNK)
        except BlockingIOError:
            return
        if not chunk:
            pipe.close()
            return
        self._stderr_bytes += len(chunk)
        if self._stderr_bytes > _MAX_STDERR:
            raise _ProtocolError("gemini_inference_output_limit")
        room = _MAX_DIAGNOSTIC - len(self._stderr)
        if room:
            self._stderr.extend(chunk[:room])

    def _event(self, line):
        if len(line) > _MAX_LINE:
            raise _ProtocolError("gemini_inference_output_limit")
        if not line.strip():
            return
        if self._result_status is not None:
            raise _ProtocolError("gemini_inference_invalid_output")
        event = json.loads(
            line.decode("utf-8"),
            parse_int=_bounded_int,
            parse_constant=_invalid_constant,
            object_pairs_hook=_object,
        )
        if not isinstance(event, dict) or not isinstance(event.get("event"), str):
            raise _ProtocolError("gemini_inference_invalid_output")
        kind = event["event"]
        if kind == "init":
            init = event.get(kind)
            if not isinstance(init, dict):
                raise _ProtocolError("gemini_inference_invalid_output")
            if init.get("permission_mode") not in (None, "strict", "request-review"):
                raise _ProtocolError("gemini_inference_tool_blocked")
        elif kind == "step_update":
            step = event.get(kind)
            if not isinstance(step, dict):
                raise _ProtocolError("gemini_inference_invalid_output")
            step_type = step.get("step_type")
            if not isinstance(step_type, str):
                raise _ProtocolError("gemini_inference_invalid_output")
            step_type = step_type.lower()
            if step_type.startswith(("tool", "subagent", "permission_request")) or any(
                step.get(key) for key in ("tool_name", "tool_info", "subagent_info")
            ):
                raise _ProtocolError("gemini_inference_tool_blocked")
            if step_type != "agent_response" or "text_delta" not in step:
                return
            delta = step["text_delta"]
            if step.get("state") not in ("ACTIVE", "DONE") or not isinstance(
                delta, str
            ):
                raise _ProtocolError("gemini_inference_invalid_output")
            self._text_bytes += len(delta.encode("utf-8"))
            if self._text_bytes > _MAX_TEXT:
                raise _ProtocolError("gemini_inference_output_limit")
            self._text.append(delta)
        elif kind == "result":
            result = event.get(kind)
            status = result.get("status") if isinstance(result, dict) else None
            if status not in (
                "SUCCESS",
                "ERROR",
                "CANCELED",
                "INTERRUPTED",
                "INVALID",
                "WAITING",
                "RUNNING",
            ):
                raise _ProtocolError("gemini_inference_invalid_output")
            if result.get("denied_actions"):
                raise _ProtocolError("gemini_inference_tool_blocked")
            if status == "SUCCESS" and result.get("error"):
                raise _ProtocolError("gemini_inference_invalid_output")
            self._result_status = status
            error = result.get("error")
            self._result_error = (
                error[:_MAX_DIAGNOSTIC] if isinstance(error, str) else None
            )
            self._result_usage = _usage(result.get("usage"))
        elif kind.startswith(("control_", "tool", "subagent", "permission_request")):
            raise _ProtocolError("gemini_inference_tool_blocked")

    def _stop_group(self):
        if self._process is not None and not self._group_stopped:
            try:
                os.killpg(self._process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self._group_stopped = True

    def _observe_exit(self):
        # Keep the group leader unreaped until the group has been signalled:
        # its PID cannot yet be reused, and no descendants can hold pipes open.
        if (
            self._process.returncode is None
            and os.waitid(
                os.P_PID,
                self._process.pid,
                os.WEXITED | os.WNOHANG | os.WNOWAIT,
            )
            is not None
        ):
            self._stop_group()
            self._process.poll()
        return self._process.returncode

    def _discard_buffers(self):
        self._input = b""
        self._stdout.clear()
        self._stderr.clear()
        self._text.clear()
        self._secret_values = ()
        self._result_error = None

    def _fail(self, code):
        self._snapshot = {
            "state": "failed",
            "text": "",
            "error": {
                "code": code,
                "message": _ERROR_MESSAGES[code],
            },
        }
        if self._process is not None:
            self._stop_group()
            for pipe in (
                self._process.stdin,
                self._process.stdout,
                self._process.stderr,
            ):
                if pipe is not None:
                    pipe.close()
            self._process.poll()
        self._discard_buffers()

    def _finish(self, returncode):
        stderr = self._stderr.decode("utf-8", errors="replace")
        if self._models:
            output = self._stdout.decode("utf-8", errors="replace")
            diagnostic = _diagnostic_code(stderr, output)
            if returncode != 0:
                self._fail(diagnostic or "gemini_inference_failed")
                return
            models = [
                slug
                for slug in parse_models(output)
                if (
                    not _CREDENTIAL.search(slug)
                    and not any(secret in slug for secret in self._secret_values)
                )
            ]
            if not models:
                self._fail(diagnostic or "gemini_models_empty")
                return
            self._snapshot = {"state": "completed", "models": models, "text": ""}
        else:
            if _TOOL_DENIAL.search(stderr):
                self._fail("gemini_inference_tool_blocked")
                return
            if (
                returncode != 0
                or self._result_status != "SUCCESS"
                or self._input_incomplete
            ):
                code = _diagnostic_code(self._result_error, stderr)
                if code is None:
                    if self._result_status in ("CANCELED", "INTERRUPTED"):
                        code = "gemini_inference_cancelled"
                    elif returncode == 0 and self._result_status is None:
                        code = "gemini_inference_invalid_output"
                    else:
                        code = "gemini_inference_failed"
                self._fail(code)
                return
            text = _CONTROL.sub("", _SGR.sub("", "".join(self._text)))
            pattern = _CREDENTIAL
            if self._secret_values:
                alternatives = "|".join(map(re.escape, self._secret_values))
                pattern = re.compile(f"{alternatives}|{_CREDENTIAL.pattern}")
            text = pattern.sub("[redacted]", text)
            if len(text.encode("utf-8")) > _MAX_TEXT:
                self._fail("gemini_inference_output_limit")
                return
            if not text.strip():
                self._fail("gemini_inference_invalid_output")
                return
            self._snapshot = {"state": "completed", "text": text}
            if self._result_usage:
                self._snapshot["usage"] = self._result_usage
        self._discard_buffers()

    def poll(self):
        if self._snapshot is None:
            try:
                self._write_input()
                self._read_stdout()
                self._read_stderr()
                returncode = self._observe_exit()
                if (
                    returncode is not None
                    and self._process.stdout.closed
                    and self._process.stderr.closed
                ):
                    self._finish(returncode)
            except _ProtocolError as error:
                self._fail(error.args[0])
            except (ValueError, RecursionError):
                self._fail("gemini_inference_invalid_output")
            except OSError:
                self._fail("gemini_inference_failed")
        elif self._process is not None:
            self._process.poll()
        if self._snapshot is None:
            return {"state": "running", "text": ""}
        snapshot = dict(self._snapshot)
        for key in ("models", "usage", "error"):
            if key in snapshot:
                snapshot[key] = snapshot[key].copy()
        return snapshot

    def close(self):
        if self._snapshot is None:
            self._fail("gemini_inference_cancelled")
        if self._process is not None:
            self._process.wait()
            self._process = None
