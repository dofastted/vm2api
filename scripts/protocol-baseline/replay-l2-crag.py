#!/usr/bin/env python3
"""
L2 Deep Wire Parity Verifier for vm2api protocol baseline.

Directly adapts X:/crag-standalone/scripts/replay-standards.py:
Takes captured CRAG handoff envelopes (`E_node` and `E_go`) from two L1 golden snapshots
and replays both through the SAME isolated fixture-licensed local CRAG worker +
official Linux x64 Claude Code 2.1.321 ELF + loopback TLS mock for api.anthropic.com:443.
Verifies W_go == W_node (normalizing only session UUID and dynamic billing cch).
"""

import argparse
import copy
import hashlib
import http.client
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import socketserver
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import uuid

CLI_HASH = "426c33815ca6645a772f722fbff10dbf2cbdb124a8aeab733c1365dbf8bbf61f"
FIXTURE_ISSUER = "21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9"
FIXTURE_OAUTH = "offline-replay-only"
ANSWER = '{"count":7}'


def sse(event):
    return f"event: {event['type']}\ndata: {json.dumps(event)}\n\n".encode()


class Receiver(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def begin(self, status, mime):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Connection", "close")
        self.end_headers()

    def do_POST(self):
        size = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(size)
        if self.path.split("?")[0] != "/v1/messages":
            self.begin(404, "application/json")
            self.wfile.write(b"{}")
            return
        body = json.loads(raw)
        self.server.calls.append(body)
        if self.headers.get("Authorization") != "Bearer " + FIXTURE_OAUTH:
            self.begin(401, "application/json")
            self.wfile.write(b'{"type":"error","error":{"type":"authentication_error","message":"fixture OAuth required"}}')
            return
        self.begin(200, "text/event-stream")
        message = dict(
            id="msg_l2",
            type="message",
            role="assistant",
            model=body["model"],
            content=[],
            stop_reason=None,
            stop_sequence=None,
            usage=dict(input_tokens=10, output_tokens=0),
        )
        self.wfile.write(sse(dict(type="message_start", message=message)))
        self.wfile.write(sse(dict(type="content_block_start", index=0, content_block=dict(type="text", text=""))))
        self.wfile.write(sse(dict(type="content_block_delta", index=0, delta=dict(type="text_delta", text=ANSWER))))
        self.wfile.write(sse(dict(type="content_block_stop", index=0)))
        self.wfile.write(sse(dict(type="message_delta", delta=dict(stop_reason="end_turn", stop_sequence=None), usage=dict(output_tokens=2))))
        self.wfile.write(sse(dict(type="message_stop")))


class Loopback(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(15)
        line = self.rfile.readline(1024).split()
        if line[:2] != [b"CONNECT", b"api.anthropic.com:443"]:
            self.wfile.write(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
            return
        for _ in range(64):
            if self.rfile.readline(4096) == b"\r\n":
                break
        self.wfile.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        try:
            with self.server.tls.wrap_socket(self.connection, server_side=True) as local:
                Receiver(local, self.client_address, self.server)
        except (BrokenPipeError, ConnectionResetError):
            return


def normalize_wire(body):
    out = copy.deepcopy(body)
    if isinstance(out.get("metadata", {}).get("user_id"), str):
        try:
            identity = json.loads(out["metadata"]["user_id"])
            if "session_id" in identity:
                uuid.UUID(identity["session_id"])
                identity["session_id"] = "<session>"
            out["metadata"]["user_id"] = identity
        except Exception:
            pass
    if isinstance(out.get("system"), list) and out["system"]:
        first = out["system"][0]
        if isinstance(first, dict) and isinstance(first.get("text"), str) and first["text"].startswith("x-anthropic-billing-header:"):
            first["text"] = re.sub(r"(?<=; cch=)[0-9a-f]+(?=;)", "<dynamic>", first["text"])
    return out


def post_unix(sock_path, route, body=None):
    with socket.socket(socket.AF_UNIX) as sock:
        sock.settimeout(55)
        sock.connect(str(sock_path))
        conn = http.client.HTTPConnection("localhost")
        conn.sock = sock
        try:
            headers = {"Content-Type": "application/json", "X-Tenant-Id": "fixture", "X-Kin-Internal-Token": "replay"}
            conn.request("GET" if body is None else "POST", route, None if body is None else json.dumps(body), headers)
            reply = conn.getresponse()
            raw = reply.read()
            return reply.status, raw
        finally:
            conn.close()


def replay_envelope(envelope, root, args, tls):
    with tempfile.TemporaryDirectory(dir=root) as scratch, socketserver.ThreadingTCPServer(("127.0.0.1", 0), Loopback) as proxy:
        scratch = Path(scratch)
        home, cfg, work = [scratch / n for n in ("home", "cfg", "work")]
        for d in (home, cfg, work):
            d.mkdir()
        (cfg / ".credentials.json").write_text(json.dumps({
            "claudeAiOauth": {
                "accessToken": FIXTURE_OAUTH,
                "refreshToken": FIXTURE_OAUTH,
                "expiresAt": int(time.time() * 1000) + 86400000,
                "scopes": ["user:inference", "user:profile"],
                "subscriptionType": "max",
                "rateLimitTier": "default_claude_max_5x",
            }
        }))
        (cfg / ".claude.json").write_text(json.dumps({
            "hasCompletedOnboarding": True,
            "theme": "dark",
            "userID": "a" * 64,
            "oauthAccount": {
                "accountUuid": "10000000-0000-4000-a000-000000000001",
                "organizationUuid": "10000000-0000-4000-a000-000000000002",
                "emailAddress": "fixture@example.invalid",
            },
            "projects": {str(work): {"hasTrustDialogAccepted": True, "hasCompletedProjectOnboarding": True}},
        }))
        sock = scratch / "crag.sock"
        config_path = scratch / "config.json"
        config_path.write_text(json.dumps({
            "vm_id": args.vm_id,
            "socket_path": str(sock),
            "internal_token": "replay",
            "license_dir": str(root / "license"),
            "claude_bin": str(args.claude),
            "work_dir": str(work),
            "config_dir": str(cfg),
            "asset_dir": str(root / "assets"),
            "transport": "tui",
            "bare": False,
            "slots_per_worker": 1,
            "session_slots": 1,
            "request_timeout_seconds": 40,
            "first_byte_timeout_seconds": 28,
            "default_cache_ttl": "5m",
            "direct": False,
            "proxy_url": f"http://127.0.0.1:{proxy.server_address[1]}",
        }))
        proxy.daemon_threads, proxy.tls, proxy.calls = True, tls, []
        threading.Thread(target=proxy.serve_forever, daemon=True).start()
        env = dict(
            HOME=str(home),
            PATH="/usr/bin:/bin",
            LANG="C.UTF-8",
            DISABLE_TELEMETRY="1",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1",
            NODE_EXTRA_CA_CERTS=str(root / "cert"),
            SSL_CERT_FILE=str(root / "cert"),
        )
        worker = subprocess.Popen([args.package / "crag-v2", "--gateway-worker", "--config", config_path], cwd=work, env=env, start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
        try:
            for _ in range(200):
                try:
                    st, _ = post_unix(sock, "/internal/health")
                    if st == 200:
                        break
                except OSError:
                    time.sleep(0.05)
            status, _ = post_unix(sock, "/internal/v1/messages", envelope)
        finally:
            if worker.poll() is None:
                worker.terminate()
                try:
                    worker.wait(6)
                except subprocess.TimeoutExpired:
                    os.killpg(worker.pid, signal.SIGKILL)
            proxy.shutdown()
        return status, [normalize_wire(c) for c in proxy.calls]


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--node-golden", type=Path, required=True)
    p.add_argument("--go-golden", type=Path, required=True)
    p.add_argument("--package", type=Path, required=True)
    p.add_argument("--license", type=Path, required=True)
    p.add_argument("--claude", type=Path, required=True)
    p.add_argument("ids", nargs="*")
    args = p.parse_args()

    node_data = {r["id"]: r for r in json.loads(args.node_golden.read_text(encoding="utf-8"))["results"]}
    go_data = {r["id"]: r for r in json.loads(args.go_golden.read_text(encoding="utf-8"))["results"]}

    manifest = json.loads((args.package / "manifest.json").read_text(encoding="utf-8"))
    if manifest["authorization"]["public_key_id"] != FIXTURE_ISSUER:
        raise SystemExit("Refusing non-fixture CRAG package")
    with args.claude.open("rb") as f:
        if hashlib.file_digest(f, "sha256").hexdigest() != CLI_HASH:
            raise SystemExit("Unexpected Claude Code ELF sha256")

    with tempfile.TemporaryDirectory(prefix="vm2api-l2-", dir="/tmp") as temp:
        root = Path(temp)
        (root / "license").mkdir()
        for name in ("registration.code", "device.json"):
            shutil.copyfile(args.license / name, root / "license" / name)
        args.vm_id = json.loads((root / "license/device.json").read_text())["vm_id"]
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
             "-subj", "/CN=api.anthropic.com", "-addext", "subjectAltName=DNS:api.anthropic.com",
             "-out", root / "cert", "-keyout", root / "key"],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(root / "cert", root / "key")

        selected = [cid for cid, r in node_data.items() if r["target_family"] == "claude_crag" and r.get("envelopes") and (not args.ids or cid in args.ids)]
        failures = 0
        for cid in selected:
            n_st, n_w = replay_envelope(node_data[cid]["envelopes"][0], root, args, tls)
            g_st, g_w = replay_envelope(go_data[cid]["envelopes"][0], root, args, tls)
            if n_st != g_st or n_w != g_w:
                print(f"FAIL {cid}: status {n_st} vs {g_st}, W mismatch", file=sys.stderr)
                failures += 1
            else:
                print(f"PASS {cid}: status={g_st} W={len(g_w)}")
        print(f"L2 Wire Parity: {len(selected) - failures}/{len(selected)} matched")
        return int(failures != 0)


if __name__ == "__main__":
    sys.exit(main())
