#!/usr/bin/env python3
"""HTTP CONNECT bridge → one SOCKS5 egress.

Claude CLI treats HTTPS_PROXY as HTTP CONNECT. It cannot dial socks5://.
Point KIN_HTTPS_PROXY at this listener; keep KIN_SOCKS5 as the real egress
so refresh (Go) and inference (CLI) share one path.

  KIN_SOCKS5=socks5h://user:pass@host:port
  KIN_HTTP_BRIDGE_ADDR=127.0.0.1:18080
  python3 scripts/http_to_socks.py
"""
from __future__ import annotations

import os
import select
import socket
import struct
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse


def parse_socks5(raw: str) -> tuple[str, int, str | None, str | None]:
    value = raw.strip()
    if "://" not in value:
        value = "socks5h://" + value
    parsed = urlparse(value)
    if parsed.scheme not in {"socks5", "socks5h"}:
        raise SystemExit("KIN_SOCKS5 must be socks5h://user:pass@host:port")
    if not parsed.hostname or not parsed.port:
        raise SystemExit("KIN_SOCKS5 host:port required")
    user = unquote(parsed.username) if parsed.username else None
    password = unquote(parsed.password) if parsed.password else None
    return parsed.hostname, parsed.port, user, password


def socks5_connect(
    socks_host: str,
    socks_port: int,
    user: str | None,
    password: str | None,
    target: str,
    port: int,
    timeout: float = 20,
) -> socket.socket:
    sock = socket.create_connection((socks_host, socks_port), timeout=timeout)
    if user is not None:
        sock.sendall(b"\x05\x01\x02")
        if sock.recv(2) != b"\x05\x02":
            sock.close()
            raise OSError("socks5 method rejected")
        u, p = user.encode(), (password or "").encode()
        sock.sendall(b"\x01" + bytes([len(u)]) + u + bytes([len(p)]) + p)
        if sock.recv(2) != b"\x01\x00":
            sock.close()
            raise OSError("socks5 auth failed")
    else:
        sock.sendall(b"\x05\x01\x00")
        if sock.recv(2) != b"\x05\x00":
            sock.close()
            raise OSError("socks5 method rejected")
    host = target.encode()
    sock.sendall(b"\x05\x01\x00\x03" + bytes([len(host)]) + host + struct.pack("!H", port))
    reply = sock.recv(10)
    if len(reply) < 2 or reply[1] != 0:
        sock.close()
        raise OSError("socks5 connect failed")
    sock.settimeout(None)
    return sock


def pipe(left: socket.socket, right: socket.socket) -> None:
    sockets = [left, right]
    try:
        while True:
            ready, _, _ = select.select(sockets, [], [], 300)
            if not ready:
                break
            for src in ready:
                data = src.recv(65536)
                if not data:
                    return
                dst = right if src is left else left
                dst.sendall(data)
    except OSError:
        return
    finally:
        for sock in sockets:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                pass


def main() -> None:
    socks = parse_socks5(os.environ.get("KIN_SOCKS5", ""))
    listen = os.environ.get("KIN_HTTP_BRIDGE_ADDR", "127.0.0.1:18080")
    host, _, port = listen.partition(":")

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt: str, *args) -> None:
            msg = fmt % args
            if "sk-ant-" in msg or (socks[3] and socks[3] in msg):
                return
            print(msg, flush=True)

        def do_CONNECT(self) -> None:
            target, _, target_port = self.path.partition(":")
            try:
                remote = socks5_connect(
                    socks[0], socks[1], socks[2], socks[3], target, int(target_port or "443")
                )
            except Exception as exc:
                self.send_error(502, str(exc))
                return
            self.send_response(200, "Connection Established")
            self.end_headers()
            pipe(self.connection, remote)

        def do_GET(self) -> None:
            if self.path in {"/", "/health"}:
                body = b"ok"
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_error(405)

    httpd = ThreadingHTTPServer((host, int(port or "18080")), Handler)
    print(f"http-connect -> socks5h {socks[0]}:{socks[1]} listen {listen}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
