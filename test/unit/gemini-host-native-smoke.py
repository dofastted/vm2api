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
        if request_line != "POST /internal/v1/messages HTTP/1.1":
            raise AssertionError(request_line)
        assert headers.get("x-kin-internal-token") == "a" * 64
        length = int(headers["content-length"])
        request = json.loads(self.rfile.read(length))
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
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

print(
    "Native worker fixture: health, authenticated text turn, SSE completion and usage PASS"
)
