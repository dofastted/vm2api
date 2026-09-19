#!/usr/bin/env bash
# Local Docker slot: start kin-kernel --gateway-worker and prove health + mock SSE.
set -euo pipefail

BIN="${KIN_KERNEL_BIN:-$(cd "$(dirname "$0")/.." && pwd)/bin/kin-kernel}"
IMAGE="${KIN_VERIFY_IMAGE:-kin-os/ubuntu:24.04}"
NAME=kin-local-rust-verify
WORKDIR="$(mktemp -d /tmp/kin-local-rust.XXXXXX)"
TOKEN=local-verify-token
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

if [[ ! -x "$BIN" ]]; then
  echo "missing executable kin-kernel at $BIN" >&2
  exit 1
fi

mkdir -p "$WORKDIR/run"
EXPIRY=$(($(date +%s) + 86400))
cat >"$WORKDIR/run/kernel.json" <<EOF
{
  "vm_id": "vm-local-rust",
  "socket_path": "/run/kin/kernel.sock",
  "credential_path": "/run/kin/credentials.json",
  "proxy_url": "",
  "proxy_required": false,
  "internal_token": "$TOKEN",
  "delivery_mode": "realtime",
  "refresh_skew_seconds": 300,
  "request_timeout_seconds": 30,
  "first_byte_timeout_seconds": 10,
  "idle_timeout_seconds": 10,
  "runtime_kind": "docker",
  "test_endpoints": true,
  "anthropic_base_url": "http://127.0.0.1:19091"
}
EOF
cat >"$WORKDIR/run/credentials.json" <<EOF
{"claudeAiOauth":{"accessToken":"local-verify-access","refreshToken":"local-verify-refresh","expiresAt":${EXPIRY}000}}
EOF
cat >"$WORKDIR/run/mock_anthropic.py" <<'PY'
from http.server import BaseHTTPRequestHandler, HTTPServer
SSE = (
    b"event: message_start\n"
    b'data: {"type":"message_start","message":{"id":"m1","model":"claude-haiku-4-5-20251001","role":"assistant","content":[],"usage":{"input_tokens":3,"output_tokens":0}}}\n\n'
    b"event: content_block_start\n"
    b'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
    b"event: content_block_delta\n"
    b'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n'
    b"event: content_block_stop\n"
    b'data: {"type":"content_block_stop","index":0}\n\n'
    b"event: message_delta\n"
    b'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n'
    b"event: message_stop\n"
    b'data: {"type":"message_stop"}\n\n'
)
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        self.wfile.write(SSE)
    def log_message(self, *args):
        pass
HTTPServer(("127.0.0.1", 19091), H).serve_forever()
PY
cat >"$WORKDIR/run/probe.py" <<'PY'
import json, http.client, socket, sys

class U(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("localhost")
        self.path = path
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(self.path)

def health():
    c = U("/run/kin/kernel.sock")
    c.request("GET", "/internal/health", headers={"X-Kin-Internal-Token": "local-verify-token"})
    r = c.getresponse()
    body = r.read().decode()
    print(body)
    doc = json.loads(body)
    assert r.status == 200, r.status
    assert doc.get("engine") == "rust", doc
    assert doc.get("vm_id") == "vm-local-rust", doc

def hop():
    payload = json.dumps({
        "body": {
            "model": "claude-haiku-4-5-20251001",
            "messages": [{"role": "user", "content": "hi"}],
            "max_tokens": 16,
            "stream": True,
        },
        "headers": {"anthropic-version": "2023-06-01", "content-type": "application/json"},
        "stream": True,
        "delivery_mode": "realtime",
    }).encode()
    c = U("/run/kin/kernel.sock")
    c.request("POST", "/internal/v1/messages", body=payload, headers={
        "X-Kin-Internal-Token": "local-verify-token",
        "Content-Type": "application/json",
        "TE": "trailers",
    })
    r = c.getresponse()
    body = r.read().decode()
    print("HOP_HTTP", r.status)
    print(body)
    assert r.status == 200, (r.status, body)
    assert "message_stop" in body, body

if __name__ == "__main__":
    {"health": health, "hop": hop}[sys.argv[1]]()
PY

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --user 0 \
  -v "$BIN:/usr/local/bin/kin-kernel:ro" \
  -v "$WORKDIR/run:/run/kin" \
  "$IMAGE" sleep 3600 >/dev/null

if ! docker exec "$NAME" python3 --version >/dev/null 2>&1; then
  docker exec "$NAME" bash -lc 'apt-get update -qq && apt-get install -y -qq python3 >/dev/null'
fi

docker exec -d "$NAME" python3 /run/kin/mock_anthropic.py
docker exec -d "$NAME" /usr/local/bin/kin-kernel --gateway-worker --config /run/kin/kernel.json

ok=0
for _ in $(seq 1 50); do
  if docker exec "$NAME" test -S /run/kin/kernel.sock; then
    ok=1
    break
  fi
  sleep 0.1
done
if [[ "$ok" != 1 ]]; then
  echo "kernel.sock never appeared" >&2
  docker exec "$NAME" ps aux || true
  exit 1
fi

docker exec "$NAME" python3 /run/kin/probe.py health
docker exec "$NAME" python3 /run/kin/probe.py hop
echo "LOCAL_RUST_SLOT_OK"
