#!/usr/bin/env python3
"""Drive the official remote OAuth TUI. Never export credentials or terminal logs."""
import fcntl
import json
import os
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time
from urllib.parse import urlparse, parse_qs

OSC_URL = re.compile(rb'\x1b\]8;[^;]*;(https://accounts\.google\.com/[^\x07\x1b]+)(?:\x07|\x1b\\)')
PLAIN_URL = re.compile(rb'https://accounts\.google\.com/[^\s\x1b\x07<>\"\']+')
ANSI = re.compile(rb'\x1b(?:\[[0-?]*[ -/]*[@-~]|\].*?(?:\x07|\x1b\\))')


def auth_url(raw):
    match = OSC_URL.search(raw) or PLAIN_URL.search(raw)
    if not match:
        return None
    value = (match.group(1) if match.re is OSC_URL else match.group(0)).decode('ascii', 'ignore')
    try:
        parsed = urlparse(value)
        query = parse_qs(parsed.query)
        if (parsed.scheme == 'https' and parsed.hostname == 'accounts.google.com'
                and query.get('redirect_uri') == ['https://antigravity.google/oauth-callback']
                and query.get('response_type') == ['code'] and query.get('state') and query.get('code_challenge')):
            return value
    except ValueError:
        pass
    return None


def emit(status, **fields):
    print(json.dumps({'status': status, **fields}), flush=True)


def main():
    argv = json.loads(os.environ['KIN_ANTIGRAVITY_EXEC_ARGV'])
    pid, fd = os.forkpty()
    if pid == 0:
        os.execvp(argv[0], argv)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 60, 220, 0, 0))
    raw = b''
    commands = b''
    selected = False
    waiting = False
    submitted = False
    deadline = time.monotonic() + 1800
    parent = os.getppid()
    verifier = None
    verify_argv = json.loads(os.environ.get('KIN_ANTIGRAVITY_VERIFY_ARGV', '[]'))
    next_probe = time.monotonic()
    initial_probe = False
    verification_deadline = None
    try:
        while time.monotonic() < deadline and os.getppid() == parent:
            now = time.monotonic()
            if verify_argv and verifier is None and now >= next_probe and (submitted or not initial_probe):
                verifier = subprocess.Popen(verify_argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                initial_probe = True
                next_probe = now + 3
            if verifier is not None and verifier.poll() is not None:
                output = verifier.communicate()[0]
                verified = verifier.returncode == 0 and bool(output.strip())
                verifier = None
                if verified:
                    emit('authenticated', authenticated=True)
                    return
            if verification_deadline and now >= verification_deadline:
                emit('failed', error='官方客户端尚未确认登录，请检查授权码、账号权限和槽位网络后重试。')
                return
            readable, _, _ = select.select([fd, sys.stdin.buffer], [], [], 0.25)
            if sys.stdin.buffer in readable:
                part = os.read(sys.stdin.fileno(), 8192)
                if not part:
                    return
                commands += part
                while b'\n' in commands:
                    line, commands = commands.split(b'\n', 1)
                    command = json.loads(line)
                    if command.get('cancel'):
                        return
                    code = command.get('code', '')
                    if waiting and not submitted and isinstance(code, str) and 1 <= len(code) <= 4096 and not re.search(r'[\x00-\x20\x7f]', code):
                        # Bracketed paste avoids the TUI interpreting individual code bytes as shortcuts.
                        os.write(fd, b'\x1b[200~' + code.encode() + b'\x1b[201~\r')
                        submitted = True
                        verification_deadline = time.monotonic() + 120
                        next_probe = time.monotonic()
                        raw = b''
                        emit('verifying')
            if fd not in readable:
                continue
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            raw = (raw + chunk)[-262144:]
            text = ANSI.sub(b'', raw).decode('utf-8', 'replace')
            if not selected and 'Select login method' in text:
                os.write(fd, b'\r')
                selected = True
                raw = b''
                continue
            url = auth_url(raw)
            if url and not waiting:
                waiting = True
                emit('awaiting_code', auth_url=url)
            if 'Got an error:' in text or 'token exchange failed' in text:
                emit('failed', error='官方客户端授权失败，请检查授权码、账号权限和槽位网络后重新生成链接。')
                return
        emit('failed', error='官方客户端登录进程已结束，请重新生成授权链接。')
    finally:
        if verifier is not None:
            verifier.terminate()
            try:
                verifier.communicate(timeout=2)
            except subprocess.TimeoutExpired:
                verifier.kill()
                verifier.communicate()
        # Close the controlling terminal as well as docker exec, so the slot CLI gets HUP.
        try:
            os.write(fd, b'\x03')
            time.sleep(0.1)
            os.write(fd, b'\x03')
            time.sleep(0.1)
            os.close(fd)
        except OSError:
            pass
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        for _ in range(20):
            if os.waitpid(pid, os.WNOHANG)[0]:
                break
            time.sleep(0.025)
        else:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)


if __name__ == '__main__':
    main()
