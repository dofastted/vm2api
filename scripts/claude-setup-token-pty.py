#!/usr/bin/env python3
"""Host PTY for `claude setup-token` on a slot container.

Extracts the CAI authorize URL, accepts a pasted auth code via inbox file,
and writes the printed 1-year oat to a 0600 file. Never logs the token.
"""
from __future__ import annotations

import fcntl
import json
import os
import re
import select
import struct
import termios
import time
from pathlib import Path

URL_RE = re.compile(
    rb"https://claude\.com/cai/oauth/authorize\?[^\s\x1b\x07\x08\"']+"
)
OSC_URL_RE = re.compile(
    rb"\x1b\]8;[^;]*;(https://claude\.com/cai/oauth/authorize\?[^\x07]+)\x07"
)
TOKEN_RE = re.compile(rb"sk-ant-oat01-[A-Za-z0-9._~+/-]{80,}=*")
ANSI_RE = re.compile(rb"\x1b(?:\[[0-9;]*[A-Za-z]|\].*?(?:\x07|\x1b\\))")
INVALID_RE = re.compile(rb"Invalid code|full code was copied", re.I)
OAUTH_FAIL_RE = re.compile(rb"OAuth error:\s*([^\r\n\x1b]+)", re.I)
RETRY_RE = re.compile(rb"Press Enter to retry", re.I)
PROMPT_RE = re.compile(rb"Paste code here", re.I)
SUCCESS_RE = re.compile(rb"Long-lived authentication token created successfully", re.I)
BRACKET_START = b"\x1b[200~"
BRACKET_END = b"\x1b[201~"


def session_dir() -> Path:
    return Path(os.environ["KIN_SESSION_DIR"])


def write_json(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def write_status(**fields) -> None:
    path = session_dir() / "status.json"
    now = int(time.time() * 1000)
    doc = {
        "session_id": os.environ.get("KIN_SESSION_ID", ""),
        "vm_id": os.environ.get("KIN_VM_ID", ""),
        "status": "waiting_url",
        "auth_url": "",
        "error": None,
        "created_at": int(os.environ.get("KIN_CREATED_AT", now)),
        "expires_at": int(os.environ.get("KIN_EXPIRES_AT", now + 30 * 60 * 1000)),
        "updated_at": now,
        "code_fed": False,
    }
    if path.exists():
        try:
            doc.update(json.loads(path.read_text(encoding="utf-8")))
        except Exception:
            pass
    doc.update(fields)
    doc["updated_at"] = now
    ttl = int(os.environ.get("KIN_SESSION_TTL_MS", 30 * 60 * 1000))
    if doc.get("status") in {"waiting_url", "waiting_auth", "waiting_retry", "code_fed"}:
        doc["expires_at"] = now + max(ttl, 60_000)
    doc.pop("token", None)
    doc.pop("access_token", None)
    write_json(path, doc)


def strip_ansi(raw: bytes) -> bytes:
    return ANSI_RE.sub(b"", raw)


def decode_url(raw: bytes) -> str:
    osc = OSC_URL_RE.search(raw)
    if osc:
        return osc.group(1).decode("ascii", "ignore")
    compact = re.sub(rb"[\r\n\t ]+", b"", strip_ansi(raw))
    m = URL_RE.search(compact)
    return m.group(0).decode("ascii", "ignore") if m else ""


def decode_token(raw: bytes) -> str:
    compact = re.sub(rb"[\r\n\s]+", b"", strip_ansi(raw))
    m = TOKEN_RE.search(compact)
    return m.group(0).decode("ascii", "ignore") if m else ""


def set_winsize(fd: int, rows: int = 40, cols: int = 220) -> None:
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


def set_nonblocking(fd: int) -> None:
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)


def write_all(fd: int, data: bytes) -> bool:
    view = memoryview(data)
    deadline = time.time() + 5
    while view and time.time() < deadline:
        try:
            n = os.write(fd, view)
            if n <= 0:
                return False
            view = view[n:]
        except BlockingIOError:
            ready, _, _ = select.select([], [fd], [], 0.25)
            if not ready:
                continue
        except OSError:
            return False
    return not view


def build_argv() -> list[str]:
    raw = os.environ.get("KIN_DOCKER_ARGV", "").strip()
    if raw:
        argv = json.loads(raw)
        if not isinstance(argv, list) or not argv or argv[0] != "exec":
            raise SystemExit(2)
        return ["docker", *argv]
    container = os.environ["KIN_CONTAINER"]
    uid = os.environ["KIN_UID"]
    gid = os.environ["KIN_GID"]
    tz = os.environ.get("TZ", "UTC")
    lang = os.environ.get("LANG", "en_US.UTF-8")
    cli = os.environ["KIN_CLI_BIN"]
    return [
        "docker", "exec", "-it",
        "-u", f"{uid}:{gid}",
        "-e", "HOME=/home/kincli",
        "-e", "TMPDIR=/home/kincli/.cache/tmp",
        "-e", f"TZ={tz}",
        "-e", f"LANG={lang}",
        "-e", f"LC_ALL={lang}",
        "-e", "PATH=/home/kincli/.local/bin:/usr/bin:/bin",
        "-e", "CLAUDE_CODE_HOST_REFRESH=1",
        "-e", f"CLAUDE_CODE_VERSION={os.environ.get('KIN_CLI_VERSION', '2.1.293')}",
        "-e", "USER_TYPE=external",
        # The slot cli-node guard spares host-run setup-token sessions.
        "-e", "KIN_SETUP_TOKEN=1",
        "-e", "CLAUDE_CODE_USE_BEDROCK=0",
        "-e", "CLAUDE_CODE_USE_VERTEX=0",
        "-e", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=0",
        "-e", "DISABLE_TELEMETRY=1",
        "-e", "DO_NOT_TRACK=1",
        "-e", "ANTHROPIC_BASE_URL=",
        "-e", "ANTHROPIC_API_KEY=",
        "-e", "ANTHROPIC_AUTH_TOKEN=",
        "-e", "CLAUDE_CODE_OAUTH_TOKEN=",
        "-e", "TERM=xterm-256color",
        "-e", "COLUMNS=220",
        "-e", "LINES=40",
        "-w", "/home/kincli",
        container,
        cli,
        "setup-token",
    ]


def sanitize_transcript(raw: bytes) -> str:
    text = strip_ansi(raw).decode("utf-8", "replace")
    text = re.sub(r"sk-ant-[a-z0-9]+-[A-Za-z0-9_-]{8,}", "sk-ant-***", text, flags=re.I)
    text = re.sub(r"https://claude\.com/cai/oauth/authorize\S+", "https://claude.com/cai/oauth/authorize?***", text)
    text = re.sub(r"(code_challenge|state|code)=[A-Za-z0-9_\-~.]+", r"\1=***", text)
    return text[-4000:]


def write_transcript(buf: bytes) -> None:
    try:
        dest = session_dir() / "pty.out"
        dest.write_text(sanitize_transcript(buf), encoding="utf-8")
        os.chmod(dest, 0o600)
    except OSError:
        pass


def feed_inbox(master: int, last_mtime: int | None, ready: bool) -> int | None:
    if not ready:
        return last_mtime
    inbox = session_dir() / "code.inbox"
    if not inbox.exists():
        return last_mtime
    try:
        st = inbox.stat()
        raw = inbox.read_bytes()
    except OSError:
        return last_mtime
    if last_mtime is not None and st.st_mtime_ns <= last_mtime:
        return last_mtime
    text = raw.decode("utf-8", "replace").strip()
    if not text:
        return last_mtime
    payload = BRACKET_START + text.encode("utf-8", "replace") + BRACKET_END + b"\r"
    if not write_all(master, payload):
        write_status(status="waiting_auth", error="授权码未能写入官方 CLI 输入框，请重试")
        return last_mtime
    try:
        inbox.unlink()
    except OSError:
        pass
    write_status(status="code_fed", error=None, code_fed=True)
    return st.st_mtime_ns


def leave_service_cgroup() -> None:
    """Survive `systemctl restart kin-gateway` (default KillMode=control-group)."""
    pid = f"{os.getpid()}\n"
    for path in (
        "/sys/fs/cgroup/system.slice/cgroup.procs",
        "/sys/fs/cgroup/cgroup.procs",
    ):
        try:
            with open(path, "w", encoding="ascii") as fh:
                fh.write(pid)
            return
        except OSError:
            continue


def main() -> int:
    leave_service_cgroup()
    session_dir().mkdir(parents=True, exist_ok=True)
    write_status(status="starting", auth_url="", error=None, code_fed=False)
    master, slave = os.openpty()
    set_winsize(master)
    set_winsize(slave)
    pid = os.fork()
    if pid == 0:
        os.setsid()
        os.close(master)
        os.dup2(slave, 0)
        os.dup2(slave, 1)
        os.dup2(slave, 2)
        if slave > 2:
            os.close(slave)
        os.execvp("docker", build_argv())
    os.close(slave)
    set_nonblocking(master)
    (session_dir() / "pty.pid").write_text(f"{os.getpid()}\n", encoding="utf-8")
    (session_dir() / "child.pid").write_text(f"{pid}\n", encoding="utf-8")
    buf = b""
    url = ""
    token = ""
    last_mtime = None
    last_beat = 0.0
    prompt_ready = False
    waiting_fresh_prompt = False
    last_oauth = b""
    deadline = time.time() + 32 * 60
    try:
        while time.time() < deadline:
            if token:
                break
            try:
                _, status = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                status = 0
                pid_alive = False
            else:
                pid_alive = status == 0
            ready, _, _ = select.select([master], [], [], 0.25)
            if ready:
                try:
                    chunk = os.read(master, 8192)
                except BlockingIOError:
                    chunk = b""
                except OSError:
                    chunk = b""
                if chunk:
                    buf += chunk
                    if len(buf) > 64_000:
                        buf = buf[-32_000:]
                    write_transcript(buf)
                    tail = strip_ansi(buf[-8000:])
                    if not url:
                        url = decode_url(buf)
                        if url:
                            write_status(status="waiting_auth", auth_url=url, error=None)
                            prompt_ready = True
                    if not token:
                        token = decode_token(buf)
                    if INVALID_RE.search(tail) and not token:
                        write_status(
                            status="waiting_auth",
                            auth_url=url,
                            code_fed=False,
                            error="授权码无效或不完整，请粘贴浏览器显示的完整授权码（含 # 后半段）",
                        )
                        prompt_ready = True
                    oauth_fail = OAUTH_FAIL_RE.search(tail)
                    if oauth_fail and not token and oauth_fail.group(0) != last_oauth:
                        last_oauth = oauth_fail.group(0)
                        detail = oauth_fail.group(1).decode("utf-8", "replace").strip()[:160]
                        write_status(
                            status="waiting_retry",
                            auth_url=url,
                            code_fed=False,
                            error=f"官方 CLI 换票 400（{detail}）。请再打开当前这条链接拿新码（含 #），不要重新生成",
                        )
                        write_all(master, b"\r")
                        prompt_ready = False
                        waiting_fresh_prompt = True
                    if RETRY_RE.search(tail) and not token:
                        prompt_ready = False
                    if waiting_fresh_prompt and chunk and PROMPT_RE.search(strip_ansi(chunk)) and not token:
                        waiting_fresh_prompt = False
                        prompt_ready = True
                        write_status(status="waiting_auth", auth_url=url, code_fed=False)
            last_mtime = feed_inbox(master, last_mtime, prompt_ready)
            now = time.time()
            if now - last_beat > 5:
                write_status(auth_url=url or "")
                deadline = max(deadline, now + 32 * 60)
                last_beat = now
            if token:
                dest = session_dir() / "token"
                dest.write_text(token + "\n", encoding="ascii")
                os.chmod(dest, 0o600)
                write_status(status="token_ready", auth_url=url, error=None)
                break
            if not pid_alive and not token:
                write_transcript(buf)
                write_status(
                    status="exited",
                    auth_url=url,
                    error="claude setup-token 已退出，且未打印一年期 token",
                )
                return 1
        else:
            write_transcript(buf)
            write_status(status="error", auth_url=url, error="等待授权超时")
            return 1
    finally:
        try:
            os.kill(pid, 15)
        except OSError:
            pass
        try:
            os.close(master)
        except OSError:
            pass
    return 0 if token else 1


if __name__ == "__main__":
    raise SystemExit(main())
