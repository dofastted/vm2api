"""Run in a disposable Linux amd64 guest with a free VT, bwrap and openvt.

Usage: sudo python3 -B test/deploy/gemini-host-native-launch-smoke.py PAYLOAD_DIR
PAYLOAD_DIR is an already verified payload with pinned agy and the native adapter.
The test uses loopback only and must run with external egress disabled.
"""

import importlib.util
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace


class Upstream(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, kind, body):
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.reply(
            "application/json",
            b'{"models":[{"name":"models/gemini-2.5-flash","supportedGenerationMethods":["generateContent"]}]}',
        )

    def do_POST(self):
        size = int(self.headers["Content-Length"])
        if not 0 < size <= 1024 * 1024:
            self.send_error(400)
            return
        self.rfile.read(size)
        self.reply(
            "text/event-stream",
            b'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"launcher smoke"}]}}]}\n\n'
            b'data: {"candidates":[{"finishReason":"STOP"}]}\n\n',
        )


def main(payload):
    source = Path(__file__).resolve().parents[2] / "scripts/gemini-host.py"
    spec = importlib.util.spec_from_file_location("gemini_host", source)
    host = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(host)
    with tempfile.TemporaryDirectory(dir="/run", prefix="gemini-launch-") as root:
        directory = Path(root)
        directory.chmod(0o711)
        home = directory / "home"
        profile = home / ".gemini/antigravity-cli"
        profile.mkdir(parents=True)
        (profile / "settings.json").write_text('{"modelProvider":"gemini"}')
        with ThreadingHTTPServer(("127.0.0.1", 0), Upstream) as upstream:
            thread = threading.Thread(target=upstream.serve_forever, daemon=True)
            thread.start()
            run = host.NativeAgy.__new__(host.NativeAgy)
            run.host = SimpleNamespace(payload=payload, directory=directory)
            run.directory = directory
            run.uid = 31000
            run.attempt = "launcher-smoke"
            run.model = "gemini-2.5-flash"
            run.prompt = "Say hello"
            run.credentials = ()
            run.native_tui = run.native_invocation = run.pid = None
            run.native_tui_pid = run.native_tui_pgid = run.native_tui_start = None
            run.egress = SimpleNamespace(poll=lambda: None)
            run.terminal = run.network_lock = None
            run.owns_directory = False
            try:
                for path in (home, *home.rglob("*")):
                    os.chown(path, run.uid, run.uid)
                run.launch_cli(
                    [
                        "setpriv",
                        "--reuid",
                        str(run.uid),
                        "--regid",
                        str(run.uid),
                        "--clear-groups",
                        "--no-new-privs",
                        "--bounding-set=-all",
                        "bwrap",
                        "--unshare-pid",
                        "--die-with-parent",
                        "--clearenv",
                        "--ro-bind",
                        "/usr",
                        "/usr",
                        "--ro-bind",
                        "/lib",
                        "/lib",
                        "--ro-bind",
                        "/lib64",
                        "/lib64",
                        "--dev",
                        "/dev",
                        "--proc",
                        "/proc",
                        "--tmpfs",
                        "/tmp",
                        "--ro-bind",
                        str(payload / "agy"),
                        "/opt/agy",
                        "--bind",
                        str(home),
                        "/home/agy",
                        "--chdir",
                        "/home/agy",
                        "--setenv",
                        "HOME",
                        "/home/agy",
                        "--setenv",
                        "TERM",
                        "linux",
                        "--setenv",
                        "AGY_CLI_DISABLE_AUTO_UPDATE",
                        "true",
                        "--setenv",
                        "GEMINI_API_KEY",
                        "fixture-only-not-a-real-key",
                        "--setenv",
                        "GOOGLE_GEMINI_BASE_URL",
                        f"http://127.0.0.1:{upstream.server_port}",
                    ],
                    (80, 25),
                )
                deadline = time.monotonic() + 50
                while time.monotonic() < deadline:
                    result = run.poll()
                    if result["state"] != "running":
                        assert result["state"] == "completed", result
                        assert result["text"] == "launcher smoke", result
                        print(
                            "openvt + bwrap: production worker validated adapter PID, VT and ELF; turn complete"
                        )
                        return
                    time.sleep(0.05)
                raise TimeoutError("native fixture did not finish")
            finally:
                run.egress = None
                run.close()
                upstream.shutdown()
                thread.join()


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve())
