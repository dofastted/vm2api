import json
import os
import socketserver
import tempfile
import threading
import time
from pathlib import Path

from importlib.util import module_from_spec, spec_from_file_location

ROOT = Path(__file__).resolve().parents[2]
spec = spec_from_file_location(
    "gemini_host_native", ROOT / "scripts/gemini_host_native.py"
)
native = module_from_spec(spec)
spec.loader.exec_module(native)

frames = [
    b": keepalive\r\n\r\n",
    b'data: {"candidates":[{"content":{"parts":[{"text":"hello "}]}}]}\n\n',
    b'data: {"candidates":[{"content":{"parts":[{"text":"world"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":12,"cachedContentTokenCount":4,"candidatesTokenCount":3,"thoughtsTokenCount":2,"totalTokenCount":17}}\n\n',
]
wrapped_frames = [
    b": keepalive\r\n\r\n",
    b'data: {"response":{"candidates":[{"content":{"parts":[{"text":"hello "}]}}]}}\n\n',
    b'data: {"response":{"candidates":[{"content":{"parts":[{"text":"world"}]},"finishReason":"STOP"}],'
    b'"usageMetadata":{"promptTokenCount":12,"cachedContentTokenCount":4,"candidatesTokenCount":3,'
    b'"thoughtsTokenCount":2,"totalTokenCount":17}}}\n\n',
]
expected = {
    "state": "completed",
    "text": "hello world",
    "usage": {
        "input_tokens": 8,
        "output_tokens": 5,
        "cache_read_tokens": 4,
        "total_tokens": 17,
    },
}
assert native.parse_sse(frames) == expected
for invalid in (
    [b'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n'],
    [b"data: not-json\n\n"],
    [b"event: error\ndata: upstream failure\n\n"],
    wrapped_frames[:-1],
    [*wrapped_frames, b'data: {"response":null}\n\n'],
    [*wrapped_frames, b'data: {"response":{"error":{"code":500}}}\n\n'],
):
    try:
        native.parse_sse(invalid)
    except native.NativeFailure:
        pass
    else:
        raise AssertionError("invalid or unterminated native SSE was accepted")


class UnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


cancelled_requests = []
hang_release = threading.Event()


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        request_line = self.rfile.readline().decode("ascii").strip()
        headers = {}
        while True:
            line = self.rfile.readline()
            if line in (b"\r\n", b"\n", b""):
                break
            key, _, value = line.decode("ascii").partition(":")
            headers[key.lower()] = value.strip()
        if request_line == "GET /internal/health HTTP/1.1":
            assert headers.get("x-kin-internal-token") == "a" * 64
            body = b'{"ready":true,"native_pid":12}'
            self.wfile.write(
                b"HTTP/1.1 200 OK\r\nContent-Length: "
                + str(len(body)).encode()
                + b"\r\nConnection: close\r\n\r\n"
                + body
            )
            return
        if request_line == "POST /internal/v1/cancel HTTP/1.1":
            assert headers.get("x-kin-internal-token") == "a" * 64
            length = int(headers["content-length"])
            cancel_req = json.loads(self.rfile.read(length))
            req_id = cancel_req.get("request_id")
            cancelled_requests.append(req_id)
            if req_id == "turn-hang-diag":
                hang_release.set()
            body = json.dumps({"cancelled": req_id in ("turn-cancel-01", "turn-hang-diag")}).encode("utf-8")
            self.wfile.write(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
                + str(len(body)).encode()
                + b"\r\nConnection: close\r\n\r\n"
                + body
            )
            return
        if request_line != "POST /internal/v1/messages HTTP/1.1":
            raise AssertionError(request_line)
        assert headers.get("x-kin-internal-token") == "a" * 64
        length = int(headers["content-length"])
        request = json.loads(self.rfile.read(length))
        if request["request_id"] == "turn-hang-diag":
            hang_release.wait(timeout=3.0)
            return
        if request["request_id"] == "turn-err-429":
            body = json.dumps(
                {"error": "rate limited", "code": "upstream_http", "upstream_status": 429}
            ).encode("utf-8")
            self.wfile.write(
                b"HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nContent-Length: "
                + str(len(body)).encode()
                + b"\r\nConnection: close\r\n\r\n"
                + body
            )
            return
        if request["request_id"] == "turn-err-license":
            body = json.dumps({"error": "seat required", "code": "license_required"}).encode("utf-8")
            self.wfile.write(
                b"HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: "
                + str(len(body)).encode()
                + b"\r\nConnection: close\r\n\r\n"
                + body
            )
            return
        if request["request_id"] == "turn-err-unsupported":
            body = json.dumps({"error": "plain text only", "code": "unsupported_turn"}).encode("utf-8")
            self.wfile.write(
                b"HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: "
                + str(len(body)).encode()
                + b"\r\nConnection: close\r\n\r\n"
                + body
            )
            return
        if request["request_id"] == "turn-stream-01":
            assert request.get("gateway_policy") == {"first_byte_timeout_ms": 5000}
            assert request["body"]["model"] == "gemini-test"
            body = b"".join(wrapped_frames)
            self.wfile.write(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nContent-Length: "
                + str(len(body)).encode()
                + b"\r\nConnection: close\r\n\r\n"
                + body
            )
            return
        assert request["request_id"] == "turn-native-01"
        assert request["body"]["model"] == "gemini-test"
        assert request["body"]["contents"][0]["parts"][0]["text"] == "native prompt"
        body = b"".join(wrapped_frames)
        self.wfile.write(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: "
            + str(len(body)).encode()
            + b"\r\nConnection: close\r\n\r\n"
            + body
        )


with tempfile.TemporaryDirectory(prefix="gemini-native-fixture-") as temporary:
    socket_path = str(Path(temporary) / "kernel.sock")
    server = UnixHTTPServer(socket_path, Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    assert native.worker_status(socket_path, "a" * 64, timeout=2) == {
        "ready": True,
        "native_pid": 12,
    }
    assert native.cancel_worker_request(socket_path, "a" * 64, "turn-cancel-01", timeout=2) is True
    assert native.cancel_worker_request(socket_path, "a" * 64, "other-id", timeout=2) is False
    conn, resp = native.open_worker_stream(
        socket_path,
        "a" * 64,
        "gemini-test",
        "turn-stream-01",
        {"model": "gemini-test", "contents": [{"role": "user", "parts": [{"text": "hi"}]}]},
        startup_timeout=2,
        gateway_policy={"first_byte_timeout_ms": 5000},
    )
    try:
        streamed = resp.read()
        assert streamed == b"".join(wrapped_frames)
    finally:
        conn.close()
    for req_id, expected_code, expected_status in (
        ("turn-err-429", "gemini_quota_exhausted", 429),
        ("turn-err-unsupported", "gemini_unsupported_turn", 400),
    ):
        try:
            native.open_worker_stream(
                socket_path,
                "a" * 64,
                "gemini-test",
                req_id,
                {"model": "gemini-test", "contents": [{"role": "user", "parts": [{"text": "hi"}]}]},
                startup_timeout=2,
            )
        except native.NativeFailure as err:
            assert err.code == expected_code, (err.code, expected_code)
            assert err.status == expected_status, (err.status, expected_status)
        else:
            raise AssertionError(f"expected NativeFailure for {req_id}")
    invocation = native.NativeInvocation(
        {
            "socket": socket_path,
            "token": "a" * 64,
            "model": "gemini-test",
            "request_id": "turn-native-01",
            "prompt": "native prompt",
        }
    )
    try:
        deadline = time.monotonic() + 5
        while True:
            result = invocation.poll()
            if result["state"] != "running":
                break
            if time.monotonic() >= deadline:
                raise AssertionError("native request helper did not complete")
            time.sleep(0.01)
        assert result == expected, result
    finally:
        invocation.close()
    # run_request() must map worker error payloads via _map_worker_error instead of flattening to gemini_inference_failed.
    for req_id, expected_code in (
        ("turn-err-429", "gemini_quota_exhausted"),
        ("turn-err-license", "license_required"),
    ):
        try:
            native.run_request(
                {
                    "socket": socket_path,
                    "token": "a" * 64,
                    "model": "gemini-test",
                    "request_id": req_id,
                    "prompt": "native prompt",
                    "startup_timeout": 2,
                }
            )
        except native.NativeFailure as err:
            assert err.code == expected_code, (err.code, expected_code)
        else:
            raise AssertionError(f"expected NativeFailure for run_request {req_id}")
    # open_worker_stream() must fast-fail on EligibilityDiagnostic before or while awaiting headers.
    with tempfile.TemporaryDirectory(prefix="gemini-stream-diag-") as sdiag_tmp:
        sdiag = native.EligibilityDiagnostic(Path(sdiag_tmp), os.getuid())
        try:
            verify_line = (
                b"W1124 02:15:09.215562     504 server_oauth.go:133] Account ineligible: "
                b"Your current account is not eligible for Antigravity. Verify your account to continue.\n"
            )
            hang_release.clear()
            cancelled_requests.clear()

            def _emit_late():
                time.sleep(0.1)
                sdiag._consume(verify_line)

            emitter = threading.Thread(target=_emit_late, daemon=True)
            emitter.start()
            t0 = time.monotonic()
            try:
                native.open_worker_stream(
                    socket_path,
                    "a" * 64,
                    "gemini-test",
                    "turn-hang-diag",
                    {"model": "gemini-test", "contents": [{"role": "user", "parts": [{"text": "hi"}]}]},
                    startup_timeout=2,
                    turn_timeout=5,
                    diagnostic=sdiag,
                )
            except native.NativeFailure as err:
                elapsed = time.monotonic() - t0
                assert (err.code, err.status) == ("gemini_account_verification_required", 403), (
                    err.code,
                    err.status,
                )
                assert elapsed < 1.5, f"expected fast-fail <1.5s, took {elapsed:.2f}s"
                assert "turn-hang-diag" in cancelled_requests, cancelled_requests
            else:
                raise AssertionError("expected NativeFailure for turn-hang-diag")
            emitter.join(timeout=2)

            # Already-latched diagnostic fails immediately before opening any HTTP stream.
            t1 = time.monotonic()
            try:
                native.open_worker_stream(
                    socket_path,
                    "a" * 64,
                    "gemini-test",
                    "turn-stream-01",
                    {"model": "gemini-test", "contents": [{"role": "user", "parts": [{"text": "hi"}]}]},
                    startup_timeout=2,
                    diagnostic=sdiag,
                )
            except native.NativeFailure as err:
                assert (err.code, err.status) == ("gemini_account_verification_required", 403)
                assert time.monotonic() - t1 < 0.5
            else:
                raise AssertionError("expected immediate NativeFailure for latched diagnostic")
        finally:
            sdiag.close()
    server.shutdown()
    server.server_close()
    thread.join(timeout=2)

# EligibilityDiagnostic must classify account verification & generic ineligibility without spoofing.
with tempfile.TemporaryDirectory(prefix="gemini-diag-fixture-") as diag_tmp:
    diag = native.EligibilityDiagnostic(Path(diag_tmp), os.getuid())
    try:
        verify_line = (
            b"W1122 22:45:38.121837     330 server_oauth.go:133] Account ineligible: "
            b"Your current account is not eligible for Antigravity. Verify your account to continue.\n"
        )
        diag._consume(b"spoofed " + verify_line)
        assert diag.poll() is None
        diag._consume(verify_line)
        assert diag.poll() == "gemini_account_verification_required"
    finally:
        diag.close()

with tempfile.TemporaryDirectory(prefix="gemini-diag-generic-") as diag_tmp:
    diag = native.EligibilityDiagnostic(Path(diag_tmp), os.getuid())
    try:
        generic_line = (
            b"W1122 22:45:38.121837     330 server_oauth.go:133] Account ineligible: "
            b"Your organization administrator disabled Antigravity.\n"
        )
        diag._consume(generic_line)
        assert diag.poll() == "gemini_account_ineligible"
    finally:
        diag.close()

# Regression for dynamic re-import bug: native_module() must return the same module & NativeFailure class
# across calls so _stream_native_infer catches NativeFailure and maps diagnostics cleanly.
host_spec = spec_from_file_location("gemini_host_cached_test", ROOT / "scripts/gemini-host.py")
host_mod = module_from_spec(host_spec)
host_spec.loader.exec_module(host_mod)
orig_check = host_mod.check_root_owned
host_mod.check_root_owned = lambda _path: None
try:
    mod_a = host_mod.native_module()
    mod_b = host_mod.native_module()
    assert mod_a is mod_b
    assert mod_a.NativeFailure is mod_b.NativeFailure
    fake_host = host_mod.Host.__new__(host_mod.Host)
    fake_host.lock = threading.Lock()
    fake_host.native_sessions = {}
    fake_host.runtime_policy = {"accounts_per_daemon": 1}
    fake_host.payload_mode = "legacy_release"

    class FakeDiag:
        def poll(self, *, final=False):
            assert final is True
            return "gemini_account_verification_required"

    class FakeSession:
        native_diagnostic = FakeDiag()

        def open_stream(self, _request_id, _body_obj, *, model=None, gateway_policy=None):
            raise host_mod.native_module().NativeFailure("gemini_inference_failed", 502, "native turn failed")

        def cancel_turn(self, _request_id):
            return False

        def is_alive(self):
            return False

        def is_severely_unhealthy(self):
            return True

        def is_ready(self):
            return False

        def close(self):
            pass

    class FakeHandler:
        def __init__(self):
            self.sent = None

        def send_json_error(self, status, code=None, message=None):
            self.sent = (status, code, message)

    fake_session = FakeSession()
    fake_host._acquire_native_session = lambda _ctx: fake_session
    fake_host.stop_native_session = lambda _id: None
    fake_handler = FakeHandler()
    state, code = fake_host._stream_native_infer(
        {
            "identifier": "gemini-test-env",
            "entry": {"cancel_event": threading.Event(), "cancel_fn": None},
            "auth": ((), b""),
            "model": "gemini-test",
            "request_id": "req-1",
            "native_body": {"model": "gemini-test", "contents": [{"role": "user", "parts": [{"text": "hi"}]}]},
        },
        fake_handler,
    )
    assert (state, code) == ("failed", "gemini_account_verification_required"), (state, code)
    assert fake_handler.sent == (403, "gemini_account_verification_required", None), fake_handler.sent
finally:
    host_mod.check_root_owned = orig_check

# Error mapping checks for all CRAG upstream_status codes
assert native._map_worker_error(502, {"code": "upstream_http", "upstream_status": 429}).code == "gemini_quota_exhausted"
assert native._map_worker_error(502, {"code": "upstream_http", "upstream_status": 403}).code == "gemini_location_unsupported"
assert (
    native._map_worker_error(
        502,
        {"code": "upstream_http", "upstream_status": 403, "upstream_reason": "UNSUPPORTED_REGION"},
    ).code
    == "gemini_location_unsupported"
)
assert (
    native._map_worker_error(
        502,
        {"code": "upstream_http", "upstream_status": 403, "upstream_reason": "TOS_VIOLATION"},
    ).code
    == "gemini_account_ineligible"
)
assert (
    native._payload_upstream_reason(
        {"message": "403 UNSUPPORTED_REGION and TOS_VIOLATION"},
    )
    == "TOS_VIOLATION"
)
assert native._map_worker_error(502, {"code": "upstream_http", "upstream_status": 401}).code == "gemini_oauth_required"
assert native._map_worker_error(502, {"code": "upstream_http", "upstream_status": 404}).code == "gemini_model_unavailable"
assert native._map_worker_error(504, {"code": "first_byte_timeout"}).code == "gemini_inference_timeout"
assert native._map_worker_error(503, {"code": "queue_full"}).code == "gemini_operation_busy"
assert native._map_worker_error(503, {"code": "account_circuit_open"}).code == "gemini_native_worker_unavailable"
assert native._map_worker_error(409, {"code": "tool_continuation_aborted"}).code == "gemini_session_conflict"
assert native._map_worker_error(409, {"code": "tool_continuation_aborted"}).status == 409

# Pool-mode readiness accepts ready=True + pool.enabled=True + pool.ready=True with native_pid=None
assert native._worker_ready({"ready": True, "native_pid": 12}) is True
assert native._worker_ready({"ready": True, "native_pid": None, "pool": {"enabled": True, "ready": True}}) is True
assert native._worker_ready({"ready": True, "native_pid": None, "pool": {"enabled": True, "ready": False}}) is False
assert native._worker_ready({"ready": True, "native_pid": None}) is False

# Host multi-concurrency (acc1=10 slots), concurrency-set, selective cancel, and strict proxy_sha256 calibration
with tempfile.TemporaryDirectory(prefix="gemini-multiproc-host-") as mp_tmp:
    mp_dir = Path(mp_tmp)
    (mp_dir / "maintenance.lock").touch(mode=0o600)
    mp_env_id = "gemini-" + "a" * 24
    mp_proxy = "socks5h://u1:p1@192.0.2.55:1080"
    mp_sha = host_mod.hashlib.sha256(mp_proxy.encode()).hexdigest()
    mp_host = host_mod.Host.__new__(host_mod.Host)
    mp_host.directory = mp_dir
    mp_host.state_file = mp_dir / "environments.json"
    mp_host.lock = threading.RLock()
    mp_host.pending = {}
    mp_host.terminals = {}
    mp_host.runs = {}
    mp_host.native_sessions = {}
    mp_host.daemon_shards = {}
    mp_host._shard_locks = {}
    mp_host._shard_faults = {}
    mp_host._account_shard_map = {}
    mp_host._runtime_proxies = {}
    mp_host.runtime_policy = {"accounts_per_daemon": 1}
    mp_host._session_locks = {}
    mp_host.active_infers = {}
    mp_host.last_inference = {}
    mp_host.payload_version = "0.3.0"
    mp_host.payload_mode = "legacy_release"
    mp_host.uid_base = 10000
    mp_host.environments = {
        mp_env_id: {
            "id": mp_env_id,
            "name": "acc1",
            "proxy_id": "px-1",
            "slot": 0,
            "max_concurrency": 1,
            "auth_method": "oauth",
            "auth_state": "authorized",
            "profile": "p" * 32,
            "call_models": ["gemini-test"],
            "created_at": "2030-01-01T00:00:00+00:00",
            "updated_at": "2030-01-01T00:00:00+00:00",
        }
    }
    mp_host.ensure_payload = lambda **_kw: None
    mp_host.oauth_runtime_issue = lambda: None
    orig_secrets = host_mod.profile_secrets
    host_mod.profile_secrets = lambda *_a, **_kw: (("tok",), b"tok")
    try:
        # Scale acc1 to concurrency=10 via concurrency-set
        view = mp_host._request("concurrency-set", {"id": mp_env_id, "max_concurrency": 10})
        assert view["max_concurrency"] == 10 and view["active_slots"] == 0, view

        # Wrong proxy_sha256 MUST fail closed with 409 gemini_proxy_calibration_mismatch
        try:
            mp_host._begin_infer(
                {
                    "id": mp_env_id,
                    "proxy_id": "px-1",
                    "proxy_url": mp_proxy,
                    "proxy_sha256": "0" * 64,
                    "model": "gemini-test",
                    "request_id": "req-bad-sha",
                    "body": {"model": "gemini-test", "contents": [{"role": "user", "parts": [{"text": "hi"}]}]},
                }
            )
        except host_mod.Failure as err:
            assert (err.status, err.code) == (409, "gemini_proxy_calibration_mismatch"), (err.status, err.code)
        else:
            raise AssertionError("expected proxy calibration mismatch failure")

        # Admit 10 concurrent infers simultaneously on acc1
        for idx in range(10):
            ctx = mp_host._begin_infer(
                {
                    "id": mp_env_id,
                    "proxy_id": "px-1",
                    "proxy_url": mp_proxy,
                    "proxy_sha256": mp_sha,
                    "model": "gemini-test",
                    "request_id": f"req-slot-{idx}",
                    "body": {"model": "gemini-test", "contents": [{"role": "user", "parts": [{"text": f"hi {idx}"}]}]},
                }
            )
            assert ctx["request_id"] == f"req-slot-{idx}"
        assert mp_host.view(mp_host.environments[mp_env_id])["active_slots"] == 10

        # 11th concurrent infer on acc1 MUST fail with 409 gemini_operation_busy
        try:
            mp_host._begin_infer(
                {
                    "id": mp_env_id,
                    "proxy_id": "px-1",
                    "proxy_url": mp_proxy,
                    "proxy_sha256": mp_sha,
                    "model": "gemini-test",
                    "request_id": "req-slot-overflow",
                    "body": {"model": "gemini-test", "contents": [{"role": "user", "parts": [{"text": "hi"}]}]},
                }
            )
        except host_mod.Failure as err:
            assert (err.status, err.code) == (409, "gemini_operation_busy"), (err.status, err.code)
        else:
            raise AssertionError("expected 11th concurrent infer to fail with gemini_operation_busy")

        # Selective cancel cancels ONLY req-slot-3 without cancelling sibling slots
        assert mp_host.cancel_infer(mp_env_id, "req-slot-3") is True
        assert mp_host.active_infers[mp_env_id]["req-slot-3"]["cancel_event"].is_set() is True
        assert mp_host.active_infers[mp_env_id]["req-slot-0"]["cancel_event"].is_set() is False
        assert mp_host.cancel_infer(mp_env_id, "req-missing") is False

        # _extract_native_turn_body defense-in-depth minimal CRAGGemini whitelist checks
        cleaned = host_mod.Host._extract_native_turn_body(
            "gemini-test",
            {
                "model": "ignored-model",
                "stream": True,
                "system_instruction": {"parts": [{"text": "sys"}]},
                "conversationId": "conv_py_1",
                "safetySettings": [{"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"}],
                "cachedContent": "cachedContents/x",
                "generationConfig": {
                    "temperature": 0.5,
                    "maxOutputTokens": 512,
                    "thinkingConfig": {"thinkingBudget": 1024},
                    "imageConfig": {"aspectRatio": "99:99", "imageSize": "8K"},
                },
                "tools": [
                    {"functionDeclarations": [{"name": "get_weather"}]},
                    {"googleSearch": {}},
                    {"codeExecution": {}},
                ],
                "contents": [
                    {
                        "role": "user",
                        "parts": [
                            {"text": "hi"},
                            {"fileData": {"mimeType": "application/pdf", "fileUri": "https://example.test/a.pdf"}},
                        ],
                    },
                    {
                        "role": "model",
                        "parts": [
                            {"thought": True, "text": "hidden"},
                            {"text": "ok", "thoughtSignature": "skip_thought_signature_validator"},
                        ],
                    },
                ],
            },
        )
        assert cleaned is not None
        assert set(cleaned.keys()) == {
            "model",
            "contents",
            "systemInstruction",
            "tools",
            "generationConfig",
            "conversation_id",
        }, cleaned.keys()
        assert cleaned["model"] == "gemini-test"
        assert cleaned["conversation_id"] == "conv_py_1"
        assert cleaned["generationConfig"] == {"thinkingConfig": {"thinkingBudget": 1024}}
        assert cleaned["tools"] == [{"functionDeclarations": [{"name": "get_weather"}]}, {"googleSearch": {}}]
        assert cleaned["contents"][0]["parts"][1] == {"text": "[Attached application/pdf: https://example.test/a.pdf]"}
        assert cleaned["contents"][1]["parts"] == [{"text": "ok"}]

        # Valid image generationConfig is preserved while non-image params are stripped
        img_cleaned = host_mod.Host._extract_native_turn_body(
            "gemini-test",
            {
                "contents": [{"role": "user", "parts": [{"text": "draw"}]}],
                "generationConfig": {
                    "temperature": 0.9,
                    "responseModalities": ["TEXT", "IMAGE"],
                    "imageConfig": {"aspectRatio": "16:9", "imageSize": "2K"},
                    "candidateCount": 2,
                },
            },
        )
        assert img_cleaned["generationConfig"] == {
            "responseModalities": ["TEXT", "IMAGE"],
            "imageConfig": {"aspectRatio": "16:9", "imageSize": "2K"},
            "candidateCount": 2,
        }
    finally:
        host_mod.profile_secrets = orig_secrets

# #1729: early worker exit before handshake must classify invalid config and fast-fail
# instead of waiting until gemini_native_bridge_timeout.
with tempfile.TemporaryDirectory(prefix="gemini-native-early-exit-") as early_dir:
    ed = Path(early_dir)
    (ed / "kernel.json").write_text('{"max_accounts": 1}', encoding="utf-8")
    bad_cfg_bin = ed / "fake-craggemini-bad-cfg"
    bad_cfg_bin.write_text(
        "#!/bin/sh\n"
        "echo 'craggemini: invalid configuration JSON or fields token=sk-secret-never-leak' >&2\n"
        "exit 1\n",
        encoding="utf-8",
    )
    bad_cfg_bin.chmod(0o755)
    t_start = time.monotonic()
    rc = native._launch_native(
        ["/bin/true"],
        worker_bin=str(bad_cfg_bin),
        directory=str(ed),
        startup_timeout=5,
    )
    assert rc == 1, rc
    assert time.monotonic() - t_start < 2.0
    raw_exit = (ed / native.LAUNCHER_EXIT_FILE).read_text(encoding="ascii")
    assert raw_exit == "craggemini 1 invalid_config\n", raw_exit
    assert "sk-secret-never-leak" not in raw_exit
    uid = os.getuid()
    assert native.read_launcher_exit(ed, uid) == ("craggemini", 1)
    assert native.read_launcher_exit_detail(ed, uid) == ("craggemini", 1, "invalid_config")

    # open_worker_stream fast-fails with gemini_native_config_invalid (not bridge timeout).
    t_stream = time.monotonic()
    try:
        native.open_worker_stream(
            str(ed / "kernel.sock"),
            "t" * 32,
            "gemini-2.5-pro",
            "req-early-cfg",
            {"contents": [{"role": "user", "parts": [{"text": "hi"}]}]},
            startup_timeout=10,
            is_alive=lambda: False,
            exit_reader=lambda: native.read_launcher_exit_detail(ed, uid),
        )
    except native.NativeFailure as err:
        assert err.code == "gemini_native_config_invalid", err.code
        assert err.status == 503, err.status
        assert time.monotonic() - t_stream < 1.0
    else:
        raise AssertionError("open_worker_stream should fast-fail on invalid_config")

    # run_request (NativeInvocation path) also fast-fails on launcher-exit before timeout.
    t_req = time.monotonic()
    try:
        native.run_request(
            {
                "socket": str(ed / "kernel.sock"),
                "token": "t" * 32,
                "model": "gemini-2.5-pro",
                "request_id": "req-early-inv",
                "prompt": "hi",
                "startup_timeout": 10,
                "launcher_uid": uid,
            }
        )
    except native.NativeFailure as err:
        assert err.code == "gemini_native_config_invalid", err.code
        assert time.monotonic() - t_req < 1.0
    else:
        raise AssertionError("run_request should fast-fail on invalid_config")

    # Unclassified stderr exit records no arbitrary text and fast-fails as worker_unavailable.
    (ed / native.LAUNCHER_EXIT_FILE).unlink()
    crash_bin = ed / "fake-craggemini-crash"
    crash_bin.write_text(
        "#!/bin/sh\n"
        "echo 'panic: unexpected internal failure secret=top-secret' >&2\n"
        "exit 2\n",
        encoding="utf-8",
    )
    crash_bin.chmod(0o755)
    rc2 = native._launch_native(
        ["/bin/true"],
        worker_bin=str(crash_bin),
        directory=str(ed),
        startup_timeout=5,
    )
    assert rc2 == 1, rc2
    raw_exit2 = (ed / native.LAUNCHER_EXIT_FILE).read_text(encoding="ascii")
    assert raw_exit2 == "craggemini 2\n", raw_exit2
    assert "top-secret" not in raw_exit2
    assert native.read_launcher_exit_detail(ed, uid) == ("craggemini", 2, None)

    t_dead = time.monotonic()
    try:
        native.open_worker_stream(
            str(ed / "kernel.sock"),
            "t" * 32,
            "gemini-2.5-pro",
            "req-early-dead",
            {"contents": [{"role": "user", "parts": [{"text": "hi"}]}]},
            startup_timeout=10,
            is_alive=lambda: False,
            exit_reader=lambda: None,
        )
    except native.NativeFailure as err:
        assert err.code == "gemini_native_worker_unavailable", err.code
        assert time.monotonic() - t_dead < 1.0
    else:
        raise AssertionError("open_worker_stream should fast-fail when worker is dead")

# Regression: NativeAgy.read_exit_detail()/early_exit_code() must honor injected native_exit_reader
# without invoking native_module() (which checks root ownership on non-root checkouts), and
# CragDaemonShard.close() must still remove directories if read_exit_detail() raises.
with tempfile.TemporaryDirectory(prefix="gemini-native-reader-inject-") as inj_tmp:
    inj_dir = Path(inj_tmp)
    orig_native_module = host_mod.native_module
    host_mod.native_module = lambda: (_ for _ in ()).throw(
        host_mod.Failure(500, "unexpected_native_module_call")
    )
    try:
        run_2 = host_mod.NativeAgy.__new__(host_mod.NativeAgy)
        run_2.native_dir = inj_dir
        run_2.uid = os.getuid()
        run_2.native_exit_reader = lambda _d, _u: ("craggemini", 1)
        assert run_2.read_exit_detail() == ("craggemini", 1, None)
        assert run_2.early_exit_code() == "gemini_native_worker_unavailable"

        run_3 = host_mod.NativeAgy.__new__(host_mod.NativeAgy)
        run_3.native_dir = inj_dir
        run_3.uid = os.getuid()
        run_3.native_exit_reader = lambda _d, _u: ("craggemini", 1, "invalid_config")
        assert run_3.read_exit_detail() == ("craggemini", 1, "invalid_config")
        assert run_3.early_exit_code() == "gemini_native_config_invalid"

        run_other = host_mod.NativeAgy.__new__(host_mod.NativeAgy)
        run_other.native_dir = inj_dir
        run_other.uid = os.getuid()
        run_other.native_exit_reader = lambda _d, _u: ("craggemini", 1, "bind_failed")
        assert run_other.early_exit_code() == "gemini_native_worker_unavailable"

        run_none = host_mod.NativeAgy.__new__(host_mod.NativeAgy)
        run_none.native_dir = inj_dir
        run_none.uid = os.getuid()
        run_none.native_exit_reader = lambda _d, _u: None
        assert run_none.read_exit_detail() is None
        assert run_none.early_exit_code() == "gemini_native_worker_unavailable"
    finally:
        host_mod.native_module = orig_native_module

    shard = host_mod.CragDaemonShard.__new__(host_mod.CragDaemonShard)
    shard._lock = threading.RLock()
    shard.shard_id = "shard-close-test"
    shard.directory = inj_dir / "shard-dir"
    shard.native_dir = inj_dir / "shard-native"
    shard.directory.mkdir()
    shard.native_dir.mkdir()
    shard._owns_native_dir = True

    class _DoneProc:
        def poll(self):
            return 1

        def wait(self, timeout=None):
            return 1

    shard.process = _DoneProc()
    shard.read_exit_detail = lambda: (_ for _ in ()).throw(RuntimeError("diag boom"))
    try:
        shard.close()
    except RuntimeError:
        pass
    else:
        raise AssertionError("expected RuntimeError from shard.read_exit_detail()")
    assert not shard.native_dir.exists()
    assert not shard.directory.exists()

print(
    "Native worker fixture: health, streaming, cancel, error mapping, pool concurrency, SSE completion and usage PASS"
)
