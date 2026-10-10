#!/usr/bin/env python3
"""TCP 0.0.0.0:7070 → unix /run/kin-guest/kernel.sock (one thread per conn)."""
import socket
import sys
import threading

LISTEN = ('0.0.0.0', 7070)
UNIX = '/run/kin-guest/kernel.sock'


def pipe(src, dst):
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


def handle(client):
    unix = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        unix.connect(UNIX)
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


def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(LISTEN)
    srv.listen(128)
    print('kin-kernel-relay: listening on 0.0.0.0:7070 →', UNIX, flush=True)
    while True:
        client, _ = srv.accept()
        threading.Thread(target=handle, args=(client,), daemon=True).start()


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print('kin-kernel-relay:', e, file=sys.stderr, flush=True)
        sys.exit(1)
