#!/usr/bin/env python3
"""TCP 0.0.0.0:<port> -> unix /run/kin-guest/kernel.sock (one thread per conn)."""

from __future__ import annotations

import argparse
import os
import signal
import socket
import sys
import threading

DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 7070
DEFAULT_UNIX = "/run/kin-guest/kernel.sock"


def _resolve_port(cli_port: int | None) -> int:
    raw = cli_port if cli_port is not None else os.environ.get("KIN_RELAY_PORT") or os.environ.get("KIN_VSOCK_PORT") or DEFAULT_PORT
    port = int(raw)
    if not (1 <= port <= 65535):
        raise ValueError(f"port out of range (1..65535): {port}")
    return port


def pipe(src: socket.socket, dst: socket.socket) -> None:
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            src.shutdown(socket.SHUT_RD)
        except OSError:
            pass
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def handle(client: socket.socket, unix_path: str) -> None:
    unix = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        unix.connect(unix_path)
    except OSError:
        try:
            client.close()
        except OSError:
            pass
        unix.close()
        return
    t1 = threading.Thread(target=pipe, args=(client, unix), daemon=True)
    t2 = threading.Thread(target=pipe, args=(unix, client), daemon=True)
    t1.start()
    t2.start()
    t1.join()
    t2.join()
    try:
        client.close()
    except OSError:
        pass
    try:
        unix.close()
    except OSError:
        pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Relay guest TCP port to CRAG kernel unix socket")
    parser.add_argument("--host", default=os.environ.get("KIN_RELAY_HOST", DEFAULT_HOST))
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--unix", default=os.environ.get("KIN_RELAY_UNIX", DEFAULT_UNIX))
    args = parser.parse_args(argv)

    port = _resolve_port(args.port)
    unix_path = args.unix
    stop_event = threading.Event()

    def _stop(_signum: int, _frame: object) -> None:
        stop_event.set()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((args.host, port))
    srv.listen(128)
    srv.settimeout(0.5)
    print(f"kin-kernel-relay: listening on {args.host}:{port} -> {unix_path}", flush=True)
    try:
        while not stop_event.is_set():
            try:
                client, _ = srv.accept()
            except socket.timeout:
                continue
            except OSError:
                if stop_event.is_set():
                    break
                continue
            threading.Thread(target=handle, args=(client, unix_path), daemon=True).start()
    finally:
        srv.close()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print("kin-kernel-relay:", e, file=sys.stderr, flush=True)
        sys.exit(1)
