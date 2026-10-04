#!/usr/bin/env python3
"""HTTP CONNECT bridge → one SOCKS5 or HTTP(S) CONNECT egress.

Claude CLI treats HTTPS_PROXY as HTTP CONNECT. It cannot dial socks5://.
Point KIN_HTTPS_PROXY at this listener; keep KIN_SOCKS5 as the real egress
so refresh (Go) and inference (CLI) share one path.

  KIN_SOCKS5=socks5h://user:pass@host:port
  KIN_HTTP_BRIDGE_ADDR=127.0.0.1:18080
  python3 scripts/http_to_socks.py
"""
from __future__ import annotations

import base64
import os
import select
import socket
import struct
import ssl
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


def read_exact(sock: socket.socket, size: int) -> bytes:
    data = bytearray()
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk:
            raise OSError("proxy connection closed")
        data.extend(chunk)
    return bytes(data)


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
    try:
        if user is not None:
            sock.sendall(b"\x05\x01\x02")
            if read_exact(sock, 2) != b"\x05\x02":
                raise OSError("socks5 method rejected")
            u, p = user.encode(), (password or "").encode()
            sock.sendall(b"\x01" + bytes([len(u)]) + u + bytes([len(p)]) + p)
            if read_exact(sock, 2) != b"\x01\x00":
                raise OSError("socks5 auth failed")
        else:
            sock.sendall(b"\x05\x01\x00")
            if read_exact(sock, 2) != b"\x05\x00":
                raise OSError("socks5 method rejected")
        host = target.encode()
        sock.sendall(b"\x05\x01\x00\x03" + bytes([len(host)]) + host + struct.pack("!H", port))
        reply = read_exact(sock, 4)
        if reply[0] != 5 or reply[1] != 0:
            raise OSError("socks5 connect failed")
        length = 4 if reply[3] == 1 else 16 if reply[3] == 4 else None
        if reply[3] == 3:
            length = read_exact(sock, 1)[0]
        if length is None:
            raise OSError("invalid socks5 address type")
        read_exact(sock, length + 2)
        sock.settimeout(None)
        return sock
    except BaseException:
        sock.close()
        raise


def http_connect(raw: str, target: str, port: int, timeout: float = 20) -> socket.socket:
    proxy = urlparse(raw)
    if proxy.scheme not in {"http", "https"} or not proxy.hostname:
        raise ValueError("invalid HTTP proxy URL")
    authority = f"[{target}]:{port}" if ":" in target else f"{target}:{port}"
    if any(c.isspace() or c in "/\\@?#" for c in authority):
        raise ValueError("invalid CONNECT target")
    sock = socket.create_connection((proxy.hostname, proxy.port or (443 if proxy.scheme == "https" else 80)), timeout=timeout)
    try:
        if proxy.scheme == "https":
            sock = ssl.create_default_context().wrap_socket(sock, server_hostname=proxy.hostname)
        headers = [f"CONNECT {authority} HTTP/1.1", f"Host: {authority}"]
        if proxy.username is not None:
            auth = f"{unquote(proxy.username)}:{unquote(proxy.password or '')}".encode()
            headers.append("Proxy-Authorization: Basic " + base64.b64encode(auth).decode())
        sock.sendall(("\r\n".join(headers) + "\r\n\r\n").encode())
        response = bytearray()
        # Never read ahead into target TLS/application bytes.
        while not response.endswith(b"\r\n\r\n"):
            if len(response) >= 16384:
                raise OSError("HTTP CONNECT headers too large")
            response.extend(read_exact(sock, 1))
        status = bytes(response).split(b"\r\n", 1)[0].split()
        if len(status) < 2 or status[0] not in {b"HTTP/1.0", b"HTTP/1.1"} or status[1] != b"200":
            code = status[1].decode() if len(status) > 1 and status[1].isdigit() else "invalid"
            raise OSError(f"HTTP CONNECT proxy returned {code}")
        sock.settimeout(None)
        return sock
    except BaseException:
        sock.close()
        raise


def pipe(left: socket.socket, right: socket.socket) -> None:
    sockets = [left, right]
    try:
        while True:
            ready = [s for s in sockets if isinstance(s, ssl.SSLSocket) and s.pending()]
            if not ready:
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
    upstream = os.environ.get("KIN_SOCKS5", "").strip()
    parsed = urlparse(upstream)
    is_http = parsed.scheme in {"http", "https"}
    socks = None if is_http else parse_socks5(upstream)
    if is_http and (not parsed.hostname or parsed.path not in {"", "/"} or parsed.query or parsed.fragment):
        raise SystemExit("invalid HTTP proxy URL")
    listen = os.environ.get("KIN_HTTP_BRIDGE_ADDR", "127.0.0.1:18080")
    host, _, port = listen.partition(":")

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt: str, *args) -> None:
            msg = fmt % args
            if "sk-ant-" in msg or (socks and socks[3] and socks[3] in msg):
                return
            print(msg, flush=True)

        def do_CONNECT(self) -> None:
            try:
                destination = urlparse("//" + self.path)
                target, target_port = destination.hostname, destination.port or 443
                if not target or destination.username or destination.path or destination.query or destination.fragment:
                    raise ValueError("invalid CONNECT target")
                remote = http_connect(upstream, target, target_port) if is_http else socks5_connect(
                    socks[0], socks[1], socks[2], socks[3], target, target_port
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
    print(f"http-connect upstream={parsed.scheme or 'socks5h'} listen {listen}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
