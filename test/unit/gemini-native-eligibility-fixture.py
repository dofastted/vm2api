"""Offline CLI log -> NativeAgy -> Host.update_run -> Unix HTTP fixture."""

import importlib.util
import json
import os
from pathlib import Path
import signal
import socketserver
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


native = load("native", ROOT / "scripts/gemini_host_native.py")
host = load("host", ROOT / "scripts/gemini-host.py")
LOCATION = (
    b"W1122 01:55:07.555880     317 server_oauth.go:133] Account ineligible: "
    b"Your current account is not eligible for Antigravity, because it is not "
    b"currently available in your location.\n"
)


if sys.argv[1] == "--cli":
    assert sys.argv[2] == "--log-file"
    with open(sys.argv[3], "wb", buffering=0) as stream:
        # Larger than a pipe: this host request waits without ever polling the run.
        stream.write(b"x" * (256 * 1024) + b"\n")
        stream.write(b"unrecognized fixture-secret log\n")
        stream.write(LOCATION[:97])
        stream.write(LOCATION[97:])
    raise SystemExit(74)


root = Path(sys.argv[1])

# A previous/shared profile log and another run must never supply this result.
(root / "cli.log").write_bytes(LOCATION)
for label in ("current", "other"):
    (root / label).mkdir(mode=0o700)
current = native.EligibilityDiagnostic(root / "current", os.getuid())
other = native.EligibilityDiagnostic(root / "other", os.getuid())
try:
    assert current.poll() is None
    current._consume(b"prefix " + LOCATION)
    assert current.poll() is None
    current._consume(b"x" * 4096)
    assert current.poll() is None and len(current.pending) == 4096
    current._consume(LOCATION)
    assert current.poll() is None and not current.pending
    current._consume(LOCATION[:97])
    assert current.poll() is None
    current._consume(LOCATION[97:])
    assert current.poll() == "gemini_location_unsupported"
    assert other.poll() is None
finally:
    current.close()
    other.close()
assert not current._thread.is_alive() and not other._thread.is_alive()
current.close()
other.close()


class Worker(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"ready":true,"native_pid":123}')

    def do_POST(self):
        self.rfile.read(int(self.headers["Content-Length"]))
        self.send_response(503)
        self.end_headers()
        self.wfile.write(b'{"error":{"code":"first_byte_timeout"}}')


worker = socketserver.UnixStreamServer(str(root / "worker.sock"), Worker)
worker_thread = threading.Thread(target=worker.serve_forever, daemon=True)
worker_thread.start()
account = {
    "id": "gemini-log-fixture",
    "proxy_id": "px-fixture",
    "auth_state": "authorized",
    "auth_method": "oauth",
    "models_discovered": True,
    "models": ["gemini-test"],
}
run_id = "b" * 32
runs = []


class Fixture:
    finish_inference = staticmethod(host.Host.finish_inference)

    def request(self, operation, body):
        if operation == "list":
            return {"payload_state": "installed", "environments": [account]}
        assert body["id"] == account["id"]
        if operation == "get":
            return account
        if operation == "test-chat":
            assert not runs
            run = host.NativeAgy.__new__(host.NativeAgy)
            run.native_dir = root / "turn"
            run.native_dir.mkdir(mode=0o700)
            run.uid = os.getuid()
            run.native_diagnostic = native.EligibilityDiagnostic(
                run.native_dir, run.uid
            )
            run.native_exit_reader = native.read_launcher_exit
            run.native_tui = subprocess.Popen(
                [
                    sys.executable,
                    "-B",
                    __file__,
                    "--cli",
                    "--log-file",
                    str(run.native_dir / native.ELIGIBILITY_LOG_FILE),
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            assert run.native_tui.wait(timeout=5) == 74
            run.native_invocation = native.NativeInvocation(
                {
                    "socket": str(root / "worker.sock"),
                    "token": "a" * 64,
                    "request_id": "eligibility-fixture",
                    "model": "gemini-test",
                    "prompt": "fixture-private-prompt",
                }
            )
            run.native_invocation._process.wait(timeout=5)
            assert (
                run.native_invocation.poll()["error"]["code"]
                == "gemini_upstream_unavailable"
            )
            run.egress = subprocess.Popen(["/bin/sleep", "30"], start_new_session=True)
            run.native_tui_pid = run.pid = run.terminal = run.network_lock = None
            run.native_tui_start = None
            run.pool_mode = False
            run._network_lease = None
            run.owns_directory = False
            run.credentials = ()
            run.prompt = None
            runs.append(
                {
                    "process": run,
                    "deadline": time.monotonic() + 120,
                    "evidence": {
                        "state": "running",
                        "model": "gemini-test",
                        "started_at": host.now(),
                        "finished_at": None,
                        "error_code": None,
                    },
                }
            )
            return {"run_id": run_id}
        if operation == "test-chat-status":
            assert body["run_id"] == run_id
            diagnostic = runs[0]["process"].native_diagnostic
            result = host.Host.update_run(self, runs[0])
            assert runs[0]["process"] is None
            assert runs[0]["evidence"]["state"] == "failed"
            assert runs[0]["evidence"]["error_code"] == "gemini_location_unsupported"
            assert diagnostic.descriptor is None
            assert not diagnostic._thread.is_alive()
            return result
        raise AssertionError("unexpected host operation")


stop = False


def shutdown(*_args):
    global stop
    stop = True


signal.signal(signal.SIGTERM, shutdown)
try:
    with socketserver.UnixStreamServer(
        str(root / "host.sock"), host.ControlHandler
    ) as server:
        server.host = Fixture()
        server.timeout = 0.1
        print("ready", flush=True)
        while not stop:
            server.handle_request()
finally:
    for entry in runs:
        if entry["process"] is not None:
            entry["process"].close()
    worker.shutdown()
    worker.server_close()
    worker_thread.join(timeout=2)
