import argparse
import base64
import codecs
import errno
import fcntl
import grp
import hashlib
from http.server import BaseHTTPRequestHandler
import ipaddress
import json
import os
from pathlib import Path
import pty
import pwd
import re
import secrets
import select
import shutil
import signal
import socket
import socketserver
import stat
import struct
import subprocess
import sys
import termios
import time
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
MAX_ENVIRONMENTS = 8
AUTH_TTL = 300
TERMINAL_TTL = 300
TERMINAL_READ = 16384
TERMINAL_INPUT = 1024
ATTEMPT = re.compile(r"[a-f0-9]{32}\Z")
TOKEN_NAME = "antigravity-oauth-token"
ACCESS_TOKEN = re.compile(r"[A-Za-z0-9._~+/-]{1,4096}={0,2}\Z")
CLI_SETTINGS = {"toolPermission": "strict", "useG1Credits": False}
CLI_MARKER = b"\x02agy-start\x03"
DISPLAY_CSI = re.compile(r"\x1b\[[?=>]?[0-9;:]*[A-HJKSTXcdfhlmnrsu]")
TERMINAL_OAUTH = "gemini_terminal_requires_oauth"
OAUTH_MENU = "> 1. Google OAuth"
OAUTH_OUTPUT = (
    "https://accounts.google.com/",
    "https://antigravity.google/oauth-callback",
    "Enter authorization code",
    "code_challenge=",
)
# agy probes capabilities before painting its first screen, while the browser
# is still waiting for terminal-start. Match xterm's initial DA responses.
STARTUP_DA = {"\x1b[c": b"\x1b[?1;2c", "\x1b[>c": b"\x1b[>0;276;0c"}
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")
CODE = re.compile(r"[A-Za-z0-9._~/-]{1,2048}\Z")
API_KEY = re.compile(r"[A-Za-z0-9_-]{20,256}\Z")
AUTH_LINK = re.compile(
    rb"\x1b\]8;[^;\x1b]*;(https://accounts\.google\.com/o/oauth2/auth\?[^\x07\x1b]{1,4096})(?:\x07|\x1b\\)"
)
AUTH_FAILURE = re.compile(
    rb"(invalid authorization code|failed to exchange|authentication failed)", re.I
)
SYSTEM_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/bin", "LANG": "C.UTF-8"}
PAYLOAD_FILES = (
    "manifest.json",
    "manifest.sig",
    "agy",
    "craggemini",
    "libagy_bridge.so",
)


class Failure(Exception):
    def __init__(self, status, code=None):
        self.status = status
        self.code = code


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def read_account(uid, proxy_url, method, api_key=None, profile=None):
    try:
        result = subprocess.run(
            [
                "setpriv",
                "--reuid",
                str(uid),
                "--regid",
                str(uid),
                "--clear-groups",
                "--no-new-privs",
                "--inh-caps=-all",
                "--ambient-caps=-all",
                "--bounding-set=-all",
                sys.executable,
                "-I",
                str(ROOT / "scripts/gemini_host_account.py"),
                method,
                *([str(profile)] if profile is not None else []),
            ],
            input=json.dumps({"proxy_url": proxy_url, "api_key": api_key}).encode(),
            check=True,
            timeout=17,
            capture_output=True,
            env=SYSTEM_ENV,
        )
        return json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        return {"state": "error", "checked_at": now()}


def private_json(target, contents):
    staging = target.with_name(f".{target.name}.{secrets.token_hex(8)}")
    try:
        with os.fdopen(
            os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w"
        ) as output:
            json.dump(contents, output)
            output.flush()
            os.fsync(output.fileno())
        staging.replace(target)
        descriptor = os.open(target.parent, os.O_DIRECTORY | os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        staging.unlink(missing_ok=True)


def check_root_owned(target):
    for entry in (target, *target.parents):
        info = entry.lstat()
        if info.st_uid != 0 or stat.S_ISLNK(info.st_mode) or info.st_mode & 0o022:
            raise RuntimeError(
                "Gemini service code, configuration and payload must be root-owned"
            )


def proxy_config(value):
    if not isinstance(value, str) or len(value) > 4096:
        raise Failure(400)
    try:
        url = urlsplit(value)
        address = ipaddress.IPv4Address(url.hostname)
        port = url.port
        if (
            url.scheme != "socks5h"
            or not port
            or url.path not in ("", "/")
            or url.fragment
            or url.query
            or address.is_loopback
            or address.is_unspecified
            or address.is_multicast
            or address.is_link_local
            or address == ipaddress.IPv4Address("255.255.255.255")
        ):
            raise ValueError()
    except (ValueError, TypeError) as error:
        raise Failure(400) from error
    return str(address), str(port)


def profile_secrets(profile, uid):
    """Open only beneath a root-owned profile, without traversing symlinks."""
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = None
    try:
        fd = os.open(profile, flags)
        info = os.fstat(fd)
        if info.st_uid != 0 or info.st_mode & 0o022:
            return None
        for part in ("home", ".gemini", "antigravity-cli"):
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            if info.st_uid != uid or info.st_mode & 0o077:
                return None
        token_fd = os.open(
            TOKEN_NAME, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd
        )
        with os.fdopen(token_fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != uid
                or info.st_mode & 0o077
                or info.st_nlink != 1
                or not 0 < info.st_size <= 16384
            ):
                return None
            raw = stream.read(16385)
        value = json.loads(raw) if len(raw) <= 16384 else None
        credential = value.get("token") if isinstance(value, dict) else None
        if not isinstance(credential, dict):
            return None
        access = credential.get("access_token")
        if not isinstance(access, str) or not ACCESS_TOKEN.fullmatch(access):
            return None
        return tuple(
            value
            for value in (
                access,
                credential.get("refresh_token"),
                credential.get("id_token"),
            )
            if isinstance(value, str) and 1 <= len(value) <= 16384 and value.isascii()
        )
    except (OSError, ValueError, RecursionError):
        return None
    finally:
        if fd is not None:
            os.close(fd)


EGRESS_EXEC = """\
import ctypes, os, signal, sys
if ctypes.CDLL(None).prctl(1, signal.SIGKILL, 0, 0, 0) or os.getppid() != int(sys.argv[1]):
    sys.exit(125)
os.execv(sys.argv[2], sys.argv[2:])
"""

# The helper binds all three listeners before accepting traffic. A passive check
# inside the bound netns does not create a connection on its transparent port.
EGRESS_READY = """\
import sys
for proto, port, state in [('tcp', 1080, '0A'), ('tcp', 1053, '0A'), ('udp', 1053, '07')]:
    with open('/proc/net/' + proto) as table:
        rows = (line.split() for line in list(table)[1:])
        if not any(row[1] == '0100007F:%04X' % port and row[3] == state
                   and row[7] == sys.argv[1] for row in rows):
            sys.exit(1)
"""

TERMINAL_EXEC = """\
import os, sys
os.write(1, b'\\x02agy-start\\x03')
os.execv(sys.argv[1], sys.argv[1:])
"""


class Agy:
    def __init__(self, host, environment, proxy_url, profile=None, size=(180, 40)):
        self.host = host
        self.environment = environment
        self.slot = environment["slot"]
        self.uid = host.uid_base + self.slot
        self.attempt = secrets.token_hex(16)
        dirname = self.attempt if profile is None else "terminal-" + self.attempt
        self.directory = host.directory / environment["id"] / dirname
        self.profile = profile
        self.owns_directory = False
        self.pid = None
        self.terminal = None
        self.egress = None
        self.network_lock = None
        address, port = proxy_config(proxy_url)
        self.network = [str(self.slot), str(host.egress_uid), address, port]
        self.namespace = f"vm2agy{self.slot}"
        self.proxy_hash = hashlib.sha256(proxy_url.encode()).digest()
        self.proxy_url = proxy_url
        try:
            self.start(proxy_url, size)
        except BaseException:
            self.close()
            raise

    def start(self, proxy_url, size):
        self.directory.mkdir(mode=0o711)
        self.owns_directory = True
        self.directory.chmod(0o711)
        self.directory.parent.chmod(0o711)
        home = (self.profile or self.directory) / "home"
        work = self.directory / "work"
        work.mkdir(mode=0o700)
        os.chown(work, self.uid, self.uid)
        if self.profile is None:
            settings = home / ".gemini" / "antigravity-cli"
            for private in (home, home / ".gemini", settings):
                private.mkdir(mode=0o700)
                os.chown(private, self.uid, self.uid)
            private_json(settings / "settings.json", CLI_SETTINGS)
            os.chown(settings / "settings.json", self.uid, self.uid)
        config = self.directory / "egress.json"
        private_json(
            config,
            {
                "proxy_id": self.environment["proxy_id"],
                "proxy_url": proxy_url,
                "listen_tcp": "127.0.0.1:1080",
                "listen_dns": "127.0.0.1:1053",
            },
        )
        os.chown(config, self.host.egress_uid, self.host.egress_uid)
        files = {
            "resolv.conf": "nameserver 1.1.1.1\noptions timeout:2 attempts:2\n",
            "passwd": f"agy:x:{self.uid}:{self.uid}:Antigravity:/home/agy:/bin/sh\n",
            "group": f"agy:x:{self.uid}:\n",
            "nsswitch.conf": "passwd: files\ngroup: files\nhosts: files dns\n",
            "hosts": "127.0.0.1 localhost agy\n::1 localhost\n",
        }
        identity = []
        for name, contents in files.items():
            target = self.directory / name
            target.write_text(contents, encoding="ascii")
            target.chmod(0o644)
            identity += ["--ro-bind", str(target), "/etc/" + name]
        self.network_lock = self.host.start_network(self.directory, self.network)
        subprocess.run(
            self.launch_args(self.host.egress_uid)
            + [
                sys.executable,
                "-I",
                "-c",
                "import socket,sys; socket.create_connection((sys.argv[1], int(sys.argv[2])), 2).close()",
                *self.network[2:],
            ],
            check=True,
            timeout=3,
            env=SYSTEM_ENV,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.egress = subprocess.Popen(
            self.launch_args(self.host.egress_uid)
            + [
                sys.executable,
                "-I",
                "-c",
                EGRESS_EXEC,
                str(os.getpid()),
                str(self.host.egress),
                "--config",
                str(config),
            ],
            env=SYSTEM_ENV,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.wait_egress()
        sandbox = [
            "bwrap",
            "--unshare-pid",
            "--unshare-ipc",
            "--unshare-uts",
            "--hostname",
            "agy",
            "--die-with-parent",
            "--clearenv",
            "--ro-bind",
            "/usr",
            "/usr",
            "--ro-bind-try",
            "/lib",
            "/lib",
            "--ro-bind-try",
            "/lib64",
            "/lib64",
            "--ro-bind-try",
            "/bin",
            "/bin",
            "--ro-bind-try",
            "/etc/ssl/certs",
            "/etc/ssl/certs",
            *identity,
            "--ro-bind",
            str(self.host.payload / "agy"),
            "/opt/agy",
            "--bind",
            str(home),
            "/home/agy",
            "--bind",
            str(work),
            "/work",
            "--dev",
            "/dev",
            "--proc",
            "/proc",
            "--tmpfs",
            "/tmp",
            "--chdir",
            "/work",
            "--setenv",
            "HOME",
            "/home/agy",
            "--setenv",
            "USER",
            "agy",
            "--setenv",
            "LOGNAME",
            "agy",
            "--setenv",
            "SHELL",
            "/bin/sh",
            "--setenv",
            "XDG_CONFIG_HOME",
            "/home/agy/.config",
            "--setenv",
            "XDG_CACHE_HOME",
            "/home/agy/.cache",
            "--setenv",
            "PWD",
            "/work",
            "--setenv",
            "PATH",
            "/usr/bin:/bin",
            "--setenv",
            "TERM",
            "xterm-256color",
            "--setenv",
            "LANG",
            "C.UTF-8",
            "--setenv",
            "AGY_CLI_DISABLE_AUTO_UPDATE",
            "true",
            "--setenv",
            "SSH_TTY",
            "/dev/tty",
            "--setenv",
            "SSH_CONNECTION",
            "127.0.0.1 12345 127.0.0.1 22",
            "--",
            *(
                ["/usr/bin/python3", "-I", "-c", TERMINAL_EXEC]
                if self.profile is not None
                else []
            ),
            "/opt/agy",
            "--mode",
            "plan",
        ]
        self.pid, self.terminal = pty.fork()
        if self.pid == 0:
            try:
                os.umask(0o077)
                fcntl.ioctl(
                    0, termios.TIOCSWINSZ, struct.pack("HHHH", size[1], size[0], 0, 0)
                )
                if self.profile is not None:
                    with open(os.devnull, "wb") as quiet:
                        os.dup2(quiet.fileno(), 2)
                argv = self.launch_args(self.uid) + sandbox
                os.execvpe(argv[0], argv, SYSTEM_ENV)
            finally:
                os._exit(125)
        os.set_blocking(self.terminal, False)

    def wait_egress(self):
        deadline = time.monotonic() + 3
        probe = self.launch_args(self.host.egress_uid) + [
            sys.executable,
            "-I",
            "-c",
            EGRESS_READY,
            str(self.host.egress_uid),
        ]
        while self.egress.poll() is None and time.monotonic() < deadline:
            result = subprocess.run(
                probe,
                timeout=1,
                env=SYSTEM_ENV,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if result.returncode == 0 and self.egress.poll() is None:
                return
            time.sleep(0.05)
        raise Failure(503)

    def launch_args(self, uid):
        return [
            "ip",
            "netns",
            "exec",
            self.namespace,
            "setpriv",
            "--reuid",
            str(uid),
            "--regid",
            str(uid),
            "--clear-groups",
            "--no-new-privs",
            "--inh-caps=-all",
            "--ambient-caps=-all",
            "--bounding-set=-all",
        ]

    def alive(self):
        return bool(self.pid and self.egress.poll() is None and not self.exited())

    def exited(self):
        # WNOWAIT leaves the PID reserved until close() has signalled its group.
        return (
            os.waitid(os.P_PID, self.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            is not None
        )

    def close(self, preserve=False):
        if self.pid:
            try:
                os.killpg(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            # forkpty's child may not have become group leader yet.
            try:
                os.kill(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(self.pid, 0)
            self.pid = None
        if self.terminal is not None:
            os.close(self.terminal)
            self.terminal = None
        if self.egress is not None:
            if self.egress.poll() is None:
                self.egress.kill()
            self.egress.wait(timeout=5)
            self.egress = None
        if self.network_lock is not None:
            try:
                self.host.stop_network(self.directory, self.network, self.network_lock)
            finally:
                os.close(self.network_lock)
                self.network_lock = None
        if self.owns_directory:
            if preserve:
                for name in (
                    "egress.json",
                    "resolv.conf",
                    "passwd",
                    "group",
                    "nsswitch.conf",
                    "hosts",
                ):
                    (self.directory / name).unlink(missing_ok=True)
                shutil.rmtree(self.directory / "work")
            else:
                shutil.rmtree(self.directory)
            self.owns_directory = False


class Login(Agy):
    def __init__(self, host, environment, proxy_url):
        self.deadline = time.monotonic() + AUTH_TTL
        self.sent = False
        self.state = None
        self.buffer = b""
        super().__init__(host, environment, proxy_url)

    def read(self, timeout):
        if not self.alive():
            raise Failure(503)
        if select.select([self.terminal], [], [], timeout)[0]:
            try:
                data = os.read(self.terminal, 16384)
            except BlockingIOError:
                return
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                data = b""
            if not data:
                raise Failure(409)
            self.buffer = (self.buffer + data)[-65536:]

    def challenge(self):
        selected = False
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            self.read(0.1)
            if not selected and b"> 1. Google OAuth" in self.buffer:
                os.write(self.terminal, b"\r")
                selected = True
            match = AUTH_LINK.search(self.buffer)
            if selected and match:
                url = match.group(1).decode("ascii")
                self.state = parse_qs(urlsplit(url).query).get("state", [None])[0]
                return {
                    "attempt_id": self.attempt,
                    "url": url,
                }
        raise Failure(503)

    def submit(self, code, state, proxy_url):
        if (
            self.sent
            or not CODE.fullmatch(code)
            or (
                state is not None
                and (not self.state or not secrets.compare_digest(self.state, state))
            )
            or not secrets.compare_digest(
                self.proxy_hash, hashlib.sha256(proxy_url.encode()).digest()
            )
        ):
            raise Failure(409)
        self.buffer = b""
        written = os.write(self.terminal, code.encode("ascii") + b"\r")
        if written != len(code) + 1:
            raise Failure(503)
        self.sent = True

    def finished(self):
        if self.sent and profile_secrets(self.directory, self.uid):
            return True
        self.read(0)
        if self.sent and AUTH_FAILURE.search(self.buffer):
            raise Failure(409)
        return False


class Display:
    def __init__(self):
        self.decode = codecs.getincrementaldecoder("utf-8")("ignore")
        self.state = "text"
        self.csi = ""
        self.tail = ""

    def screen(self, raw, credentials, startup_replies=None):
        out = []
        for char in self.decode.decode(raw):
            if self.state in ("string", "string-escape"):
                if char in "\x07\x9c" or self.state == "string-escape" and char == "\\":
                    self.state = "text"
                else:
                    self.state = "string-escape" if char == "\x1b" else "string"
            elif self.state == "escape":
                if char == "[":
                    self.csi = "\x1b["
                    self.state = "csi"
                elif char in "]P_^X":
                    self.state = "string"
                else:
                    self.state = "escape" if char == "\x1b" else "text"
            elif self.state == "csi":
                if "@" <= char <= "~":
                    command = self.csi + char
                    if startup_replies is not None and command in STARTUP_DA:
                        reply = startup_replies.pop(command, b"")
                        if reply:
                            startup_replies[None] += reply
                    elif self.csi and DISPLAY_CSI.fullmatch(command):
                        out.append(command)
                    self.state = "text"
                elif char == "\x1b":
                    self.state = "escape"
                elif self.csi and len(self.csi) < 64:
                    self.csi += char
                else:
                    self.csi = ""
            elif char in "\x90\x98\x9d\x9e\x9f":
                self.state = "string"
            elif char == "\x1b":
                self.state = "escape"
            elif char in "\r\n\t\b" or char >= " " and not "\x7f" <= char <= "\x9f":
                out.append(char)

        text = self.tail + "".join(out)
        plain = DISPLAY_CSI.sub("", text)
        keep = 0
        markers = credentials + OAUTH_OUTPUT
        if startup_replies is not None:
            # After startup the same menu text can come from a prompt or model.
            markers += (OAUTH_MENU,)
        for marker in markers:
            if marker in plain:
                raise Failure(409, TERMINAL_OAUTH if marker == OAUTH_MENU else None)
            # Hold potential fragments across PTY reads and ANSI styling.
            start = max(0, len(plain) - len(marker) + 1)
            while True:
                pos = plain.find(marker[0], start)
                if pos < 0 or len(plain) - pos <= keep:
                    break
                if marker.startswith(plain[pos:]):
                    keep = len(plain) - pos
                    break
                start = pos + 1
        split = len(text)
        if keep:
            split = len(plain) - keep
            for match in DISPLAY_CSI.finditer(text):
                if match.start() > split:
                    break
                split += len(match[0])
        self.tail = text[split:]
        if len(self.tail) > TERMINAL_READ:
            raise Failure(409)
        return text[:split].encode("utf-8")


def terminal_size(body, required=False):
    if not required and "cols" not in body and "rows" not in body:
        return None
    cols, rows = body.get("cols"), body.get("rows")
    if (
        type(cols) is not int
        or type(rows) is not int
        or not (10 <= cols <= 500 and 5 <= rows <= 200)
    ):
        raise Failure(400)
    return cols, rows


class Terminal(Agy):
    def __init__(
        self, host, environment, proxy_url, profile, size, session_id, credentials
    ):
        self.session_id = session_id
        self.size = size
        self.display = Display()
        self.input = bytearray()
        self.output = bytearray()
        self.credentials = credentials
        super().__init__(host, environment, proxy_url, profile, size)
        try:
            self.await_start()
        except BaseException:
            self.close()
            raise
        self.deadline = time.monotonic() + TERMINAL_TTL

    def await_start(self):
        deadline = time.monotonic() + 8
        startup_replies = {**STARTUP_DA, None: b""}
        painted = False
        ready_at = None
        pending = b""
        while time.monotonic() < deadline:
            if not self.alive():
                raise Failure(503)
            self.flush_input()
            if ready_at is not None and painted and time.monotonic() >= ready_at:
                return
            if len(self.output) >= TERMINAL_READ:
                time.sleep(0.05)
                continue
            if not select.select([self.terminal], [], [], 0.05)[0]:
                continue
            try:
                raw = os.read(self.terminal, 4096)
            except BlockingIOError:
                continue
            if not raw:
                raise Failure(503)
            if ready_at is None:
                pending += raw
                _, match, raw = pending.partition(CLI_MARKER)
                if not match:
                    pending = pending[-len(CLI_MARKER) :]
                    continue
                # Catch exec/loader failures immediately after sandbox setup.
                ready_at = time.monotonic() + 0.5
            rendered = self.display.screen(raw, self.credentials, startup_replies)
            self.input += startup_replies[None]
            startup_replies[None] = b""
            painted = painted or bool(
                DISPLAY_CSI.sub("", rendered.decode("utf-8")).strip()
            )
            self.output += rendered
        raise Failure(503)

    def live_profile(self):
        current = profile_secrets(self.profile, self.uid)
        if not current:
            return False
        # Keep prior credential generations while filtering buffered PTY output.
        self.credentials = tuple(dict.fromkeys(current + self.credentials))[:12]
        return True

    def relay(self, new_input, size):
        if not self.alive() or not self.live_profile():
            raise Failure(409)
        if len(self.input) + len(new_input) > TERMINAL_INPUT * 4:
            raise Failure(429, "gemini_terminal_conflict")
        if size and size != self.size:
            fcntl.ioctl(
                self.terminal,
                termios.TIOCSWINSZ,
                struct.pack("HHHH", size[1], size[0], 0, 0),
            )
            self.size = size
            self.deadline = time.monotonic() + TERMINAL_TTL
        if new_input:
            self.input += new_input
            self.deadline = time.monotonic() + TERMINAL_TTL
        self.flush_input()
        if len(self.output) < TERMINAL_READ:
            try:
                raw = os.read(self.terminal, TERMINAL_READ)
            except BlockingIOError:
                raw = None
            if raw == b"":
                raise Failure(409)
            if raw:
                self.output += self.display.screen(raw, self.credentials)
        chunk = self.output[:TERMINAL_READ]
        del self.output[:TERMINAL_READ]
        return base64.b64encode(chunk).decode("ascii")

    def flush_input(self):
        if self.input:
            try:
                del self.input[: os.write(self.terminal, self.input)]
            except BlockingIOError:
                pass


class Host:
    def __init__(self, args):
        self.directory = args.state
        self.payload = args.payload
        self.payload_source = args.payload_source
        self.public_key = args.public_key
        self.payload_version = None
        self.payload_state = "not_configured"
        self.payload_issue = None
        self.egress = args.egress
        self.uid_base = args.uid_base
        self.egress_uid = args.uid_base + MAX_ENVIRONMENTS
        self.state_file = self.directory / "environments.json"
        self.pending = {}
        self.terminals = {}
        self.network_scope = os.stat("/proc/self/ns/net").st_ino
        self.environments = (
            json.loads(self.state_file.read_bytes()) if self.state_file.exists() else {}
        )
        if (
            not isinstance(self.environments, dict)
            or len(self.environments) > MAX_ENVIRONMENTS
        ):
            raise RuntimeError("invalid Gemini host state")
        changed = False
        slots = set()
        for identifier, env in self.environments.items():
            if (
                not re.fullmatch(r"gemini-[0-9a-f]{24}", identifier)
                or env["id"] != identifier
            ):
                raise RuntimeError("invalid Gemini environment identity")
            slot = env["slot"]
            profile = env.get("profile")
            if (
                type(slot) is not int
                or not 0 <= slot < MAX_ENVIRONMENTS
                or slot in slots
                or (profile is not None and not re.fullmatch(r"[a-f0-9]{32}", profile))
            ):
                raise RuntimeError("invalid Gemini environment slot or profile")
            slots.add(slot)
            if env["auth_state"] == "authorizing":
                env["auth_state"] = "reauth_required"
                env["updated_at"] = now()
                changed = True
            env_dir = self.directory / identifier
            if env_dir.exists():
                check_root_owned(env_dir)
                self.recover_network(env_dir, slot)
                for stale in env_dir.iterdir():
                    name = (
                        stale.name[9:]
                        if stale.name.startswith("terminal-")
                        else stale.name
                    )
                    if stale.name != profile and ATTEMPT.fullmatch(name):
                        check_root_owned(stale)
                        if stale.is_dir():
                            shutil.rmtree(stale)
        if changed:
            self.save()
        self.inspect_payload()

    def verify_payload(self, source, install=False):
        check_root_owned(source)
        check_root_owned(self.public_key)
        for name in PAYLOAD_FILES:
            check_root_owned(source / name)
        output = subprocess.run(
            [
                "node",
                str(ROOT / "scripts/install-gemini-payload.mjs"),
                "--source",
                str(source),
                "--public-key",
                str(self.public_key),
                *(["--dest", str(self.payload)] if install else ["--check"]),
            ],
            check=True,
            timeout=35,
            env=SYSTEM_ENV,
            capture_output=True,
            text=True,
        ).stdout
        version = re.fullmatch(
            r"Gemini payload ([a-zA-Z0-9.-]+) (?:verified|installed)\n", output
        )
        if not version:
            raise RuntimeError("Unexpected Gemini installer response")
        return version[1]

    def payload_inputs_issue(self, source):
        if not self.public_key.is_file():
            return "gemini_public_key_missing"
        if source is None or not source.is_dir():
            return "gemini_payload_source_missing"
        if any(not (source / name).is_file() for name in PAYLOAD_FILES):
            return "gemini_payload_incomplete"
        if source == self.payload and any(
            not os.access(source / name, os.X_OK) for name in ("agy", "craggemini")
        ):
            return "gemini_payload_incomplete"
        return None

    def inspect_payload(self):
        installed = self.payload.exists() or self.payload.is_symlink()
        source = self.payload if installed else self.payload_source
        self.payload_version = None
        issue = self.payload_inputs_issue(source)
        if issue:
            self.payload_state = "not_configured"
            self.payload_issue = issue
            return
        if installed:
            try:
                self.payload_version = self.verify_payload(source)
            except (OSError, RuntimeError, subprocess.SubprocessError):
                self.payload_state = "invalid"
                self.payload_issue = "gemini_payload_invalid"
                print("Installed Gemini payload failed verification", file=sys.stderr)
                return
        self.payload_state = "installed" if installed else "install_on_create"
        self.payload_issue = None

    def ensure_payload(self):
        installed = self.payload.exists() or self.payload.is_symlink()
        issue = self.payload_inputs_issue(
            self.payload if installed else self.payload_source
        )
        if issue:
            self.payload_state = "not_configured"
            self.payload_issue = issue
            self.payload_version = None
            raise Failure(503, issue)
        if installed and self.payload_state == "installed":
            return
        self.payload_version = None
        try:
            if installed:
                self.payload_version = self.verify_payload(self.payload)
            else:
                check_root_owned(self.payload.parent)
                self.payload_version = self.verify_payload(
                    self.payload_source, install=True
                )
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            self.payload_state = "invalid"
            self.payload_issue = "gemini_payload_invalid"
            print("Gemini payload installation or verification failed", file=sys.stderr)
            raise Failure(503, "gemini_payload_invalid") from error
        self.payload_state = "installed"
        self.payload_issue = None

    def oauth_runtime_issue(self):
        if any(
            not shutil.which(tool, path=SYSTEM_ENV["PATH"])
            for tool in ("ip", "nft", "setpriv", "bwrap", "curl")
        ):
            return "gemini_oauth_tools_missing"
        try:
            check_root_owned(self.egress)
            if not self.egress.is_file() or not os.access(self.egress, os.X_OK):
                raise RuntimeError("Gemini egress helper is not executable")
        except (OSError, RuntimeError):
            return "gemini_egress_unavailable"
        try:
            if Path("/proc/sys/net/ipv4/ip_forward").read_text().strip() == "1":
                return None
        except OSError:
            print("Gemini OAuth could not read IPv4 forwarding state", file=sys.stderr)
        return "gemini_ipv4_forwarding_unavailable"

    def ensure_oauth_runtime(self):
        self.ensure_payload()
        issue = self.oauth_runtime_issue()
        if issue:
            raise Failure(503, issue)

    def save(self):
        private_json(self.state_file, self.environments)

    def network(self, action, network, lock):
        argv = ["bash", str(ROOT / "scripts/gemini-host-egress.sh"), action, *network]
        # A timed-out setup must not leave e.g. a child nft/iptables mutating
        # network state after our cleanup. The helper retains the slot lock if
        # the daemon is killed while the setup transaction is still running.
        with subprocess.Popen(
            argv,
            env=SYSTEM_ENV,
            pass_fds=(lock,),
            start_new_session=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ) as child:
            try:
                status = child.wait(timeout=12)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                raise
            if status:
                raise subprocess.CalledProcessError(status, argv)

    def network_paths(self, slot):
        runtime = Path("/run/vm2api-gemini-networks")
        runtime.mkdir(mode=0o700, exist_ok=True)
        check_root_owned(runtime)
        path = runtime / f"{self.network_scope}-{slot}"
        return path.with_suffix(".lock"), path.with_suffix(".json")

    def lock_network(self, slot):
        path, journal = self.network_paths(slot)
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fd, journal
        except BaseException:
            os.close(fd)
            raise

    @staticmethod
    def namespace_identity(slot):
        try:
            info = Path(f"/run/netns/vm2agy{slot}").stat()
        except FileNotFoundError:
            return None
        return [info.st_dev, info.st_ino]

    @staticmethod
    def network_inventory(*argv):
        return subprocess.check_output(
            argv, timeout=3, env=SYSTEM_ENV, stderr=subprocess.DEVNULL
        )

    def start_network(self, directory, network):
        slot = network[0]
        prefix = f"vm2agy{slot}"
        self.recover_network(directory.parent, slot)
        lock, journal = self.lock_network(slot)
        try:
            # Check the same names as the existing setup helper *before*
            # recording an intent to create them. Never reclaim collisions.
            if (
                self.namespace_identity(slot) is not None
                or any(
                    row.get("ifname") == prefix + "h"
                    for row in json.loads(
                        self.network_inventory("ip", "-j", "link", "show")
                    )
                )
                or f"table inet {prefix}".encode()
                in self.network_inventory("nft", "list", "tables").splitlines()
                or (
                    shutil.which("iptables", path=SYSTEM_ENV["PATH"])
                    and f"-N VM2API-AGY-{slot}".encode()
                    in self.network_inventory("iptables", "-w", "3", "-S").splitlines()
                )
            ):
                raise Failure(503)
            record = {
                "directory": str(directory),
                "uid": self.egress_uid,
                "namespace": None,
            }
            private_json(journal, record)
            try:
                self.network("start", network, lock)
                record["namespace"] = self.namespace_identity(slot)
                if record["namespace"] is None:
                    raise Failure(503)
                private_json(journal, record)
            except BaseException:
                self.stop_network(directory, network, lock)
                raise
            return lock
        except BaseException:
            os.close(lock)
            raise

    def stop_network(self, directory, network, lock):
        slot = network[0]
        _, journal = self.network_paths(slot)
        if not journal.exists():
            return
        record = json.loads(journal.read_bytes())
        if record["directory"] != str(directory) or record["uid"] != self.egress_uid:
            return
        bound = self.namespace_identity(slot)
        if record["namespace"] is None or bound is None or bound == record["namespace"]:
            self.network("stop", network, lock)
        journal.unlink()

    def recover_network(self, env_dir, slot):
        _, journal = self.network_paths(slot)
        try:
            if Path(json.loads(journal.read_bytes())["directory"]).parent != env_dir:
                return
        except FileNotFoundError:
            return
        lock, journal = self.lock_network(slot)
        try:
            if journal.exists():
                directory = Path(json.loads(journal.read_bytes())["directory"])
                if directory.parent == env_dir:
                    self.stop_network(
                        directory,
                        [str(slot), str(self.egress_uid), "192.0.2.1", "1080"],
                        lock,
                    )
        finally:
            os.close(lock)

    def cancel(self, identifier):
        if identifier in self.pending:
            self.pending[identifier].close()
            del self.pending[identifier]

    def stop_terminal(self, identifier):
        terminal = self.terminals.pop(identifier, None)
        if terminal:
            terminal.close()

    def terminal_request(self, operation, env, body):
        identifier = env["id"]
        session_id = body.get("session_id")
        if not isinstance(session_id, str) or not ATTEMPT.fullmatch(session_id):
            raise Failure(400)
        terminal = self.terminals.get(identifier)
        if operation == "terminal-stop":
            if terminal and terminal.session_id == session_id:
                self.stop_terminal(identifier)
            return {}
        if operation == "terminal-io":
            closed = {"data": "", "closed": True}
            if not terminal or terminal.session_id != session_id:
                return closed
            size = terminal_size(body)
            text = body.get("input", "")
            if not isinstance(text, str):
                raise Failure(400)
            data = text.encode("utf-8")
            if len(data) > TERMINAL_INPUT:
                raise Failure(400)
            if time.monotonic() < terminal.deadline:
                try:
                    output = terminal.relay(data, size)
                    return {"data": output, "closed": False}
                except Failure as error:
                    if error.status != 409:
                        raise
                except OSError:
                    pass
            self.stop_terminal(identifier)
            return closed

        if (
            terminal
            or identifier in self.pending
            or any(other.session_id == session_id for other in self.terminals.values())
        ):
            raise Failure(409, "gemini_terminal_conflict")
        if (
            env.get("auth_method", "oauth") != "oauth"
            or env["auth_state"] != "authorized"
            or not env.get("profile")
        ):
            raise Failure(409, TERMINAL_OAUTH)
        profile = self.directory / identifier / env["profile"]
        credentials = profile_secrets(profile, self.uid_base + env["slot"])
        if not credentials:
            raise Failure(409, TERMINAL_OAUTH)
        if body.get("proxy_id") != env["proxy_id"]:
            raise Failure(409, "gemini_terminal_conflict")
        proxy_url = body.get("proxy_url")
        proxy_config(proxy_url)
        size = terminal_size(body, required=True)
        try:
            self.ensure_oauth_runtime()
            self.terminals[identifier] = Terminal(
                self, env, proxy_url, profile, size, session_id, credentials
            )
        except Failure as error:
            if error.code == TERMINAL_OAUTH:
                env.update(auth_state="reauth_required", updated_at=now())
                self.save()
                raise
            raise Failure(503, "gemini_terminal_unavailable") from error
        except (OSError, subprocess.SubprocessError) as error:
            raise Failure(503, "gemini_terminal_unavailable") from error
        return {"ok": True}

    def close(self):
        failed = False
        for stop, active in (
            (self.stop_terminal, self.terminals),
            (self.cancel, self.pending),
        ):
            for identifier in list(active):
                try:
                    stop(identifier)
                except (OSError, subprocess.SubprocessError):
                    failed = True
        if failed:
            raise RuntimeError("Gemini child cleanup failed")

    def cleanup(self):
        for identifier, terminal in list(self.terminals.items()):
            if (
                time.monotonic() >= terminal.deadline
                or not terminal.alive()
                or not terminal.live_profile()
            ):
                self.stop_terminal(identifier)
            else:
                try:
                    terminal.flush_input()
                except OSError:
                    self.stop_terminal(identifier)
        for identifier, login in list(self.pending.items()):
            env = self.environments[identifier]
            try:
                if time.monotonic() > login.deadline:
                    raise Failure(409)
                if not login.finished():
                    continue
                old_profile = env.get("profile")
                login.close(preserve=True)
                env.update(
                    auth_state="authorized", profile=login.attempt, updated_at=now()
                )
                env.pop("account", None)
                self.save()
                del self.pending[identifier]
                if old_profile:
                    shutil.rmtree(self.directory / identifier / old_profile)
                self.refresh_account(env, login.proxy_url)
            except Failure:
                self.cancel(identifier)
                env["auth_state"] = "reauth_required"
                env["updated_at"] = now()
                self.save()

    def view(self, env):
        account = env.get("account", {})
        return {
            "id": env["id"],
            "name": env["name"],
            "proxy_id": env["proxy_id"],
            "auth_state": env["auth_state"],
            "auth_method": env.get("auth_method", "oauth"),
            "runtime_ready": False,
            "kernel_version": self.payload_version,
            "models": account.get("models", []),
            "account": account,
            "created_at": env.get("created_at"),
            "updated_at": env.get("updated_at"),
        }

    def refresh_account(self, env, proxy_url):
        directory = self.directory / env["id"]
        if env.get("auth_method") == "api_key":
            api_key = json.loads((directory / "credential.json").read_bytes())[
                "api_key"
            ]
            account = read_account(
                self.uid_base + env["slot"], proxy_url, "api_key", api_key=api_key
            )
        else:
            account = read_account(
                self.uid_base + env["slot"],
                proxy_url,
                "oauth",
                profile=directory / env["profile"],
            )
        if account.get("state") in ("error", "reauth_required") and env.get("account"):
            previous = env["account"]
            if previous.get("state") in ("ok", "partial") and not previous.get(
                "data_at"
            ):
                previous["data_at"] = previous.get("checked_at")
            previous.update(state=account["state"], checked_at=account["checked_at"])
        else:
            env["account"] = account
        if account.get("state") == "reauth_required":
            self.stop_terminal(env["id"])
            env["auth_state"] = "reauth_required"
        elif account.get("state") in ("ok", "partial"):
            env["auth_state"] = "authorized"
        env["updated_at"] = now()
        self.save()
        return self.view(env)

    def request(self, operation, body):
        if operation == "install-payload":
            self.ensure_payload()
            return {"version": self.payload_version}
        if operation == "list":
            installed = self.payload.exists() or self.payload.is_symlink()
            inputs_issue = self.payload_inputs_issue(
                self.payload if installed else self.payload_source
            )
            if (
                inputs_issue
                or self.payload_state == "not_configured"
                or (
                    installed != (self.payload_state == "installed")
                    and self.payload_state != "invalid"
                )
            ):
                self.inspect_payload()
            return {
                "payload_state": self.payload_state,
                "payload_issue": self.payload_issue,
                "oauth_runtime_issue": self.oauth_runtime_issue(),
                "environments": [self.view(env) for env in self.environments.values()],
            }
        if operation == "create":
            proxy_url = body.get("proxy_url")
            proxy_config(proxy_url)
            name, proxy_id = body.get("name"), body.get("proxy_id")
            method, api_key = body.get("auth_method", "oauth"), body.get("api_key")
            if (
                not isinstance(name, str)
                or not name.strip()
                or len(name) > 80
                or not isinstance(proxy_id, str)
                or not ID.fullmatch(proxy_id)
                or method not in ("oauth", "api_key")
                or (
                    method == "api_key"
                    and (not isinstance(api_key, str) or not API_KEY.fullmatch(api_key))
                )
                or (method == "oauth" and api_key is not None)
            ):
                raise Failure(400)
            taken = {env["slot"] for env in self.environments.values()}
            slot = next(
                (slot for slot in range(MAX_ENVIRONMENTS) if slot not in taken), None
            )
            if slot is None:
                raise Failure(409)
            self.ensure_payload()
            account = {}
            if method == "api_key":
                account = read_account(
                    self.uid_base + slot, proxy_url, "api_key", api_key=api_key
                )
                if account["state"] == "reauth_required":
                    raise Failure(400, "gemini_api_key_rejected")
                if account["state"] not in ("ok", "partial"):
                    raise Failure(502, "gemini_account_read_failed")
            identifier = f"gemini-{secrets.token_hex(12)}"
            directory = self.directory / identifier
            directory.mkdir(mode=0o711)
            timestamp = now()
            env = {
                "id": identifier,
                "name": name.strip(),
                "proxy_id": proxy_id,
                "slot": slot,
                "auth_method": method,
                "auth_state": "authorized" if method == "api_key" else "unverified",
                "account": account,
                "created_at": timestamp,
                "updated_at": timestamp,
            }
            try:
                if method == "api_key":
                    private_json(directory / "credential.json", {"api_key": api_key})
                self.environments[identifier] = env
                self.save()
            except OSError:
                self.environments.pop(identifier, None)
                shutil.rmtree(directory)
                raise
            return self.view(env)
        identifier = body.get("id")
        if not isinstance(identifier, str) or identifier not in self.environments:
            raise Failure(404)
        env = self.environments[identifier]
        if operation == "get":
            return self.view(env)
        if operation in ("terminal-start", "terminal-io", "terminal-stop"):
            return self.terminal_request(operation, env, body)
        if operation == "logout":
            if env.get("auth_method", "oauth") != "oauth":
                raise Failure(409)
            self.stop_terminal(identifier)
            self.cancel(identifier)
            self.recover_network(self.directory / identifier, env["slot"])
            if env.get("profile"):
                profile = self.directory / identifier / env.pop("profile")
                try:
                    shutil.rmtree(profile)
                except FileNotFoundError:
                    pass
            env.pop("account", None)
            if env["auth_state"] != "disabled":
                env["auth_state"] = "reauth_required"
            env["updated_at"] = now()
            self.save()
            return {}
        if operation in ("delete", "disable"):
            self.stop_terminal(identifier)
            self.cancel(identifier)
            self.recover_network(self.directory / identifier, env["slot"])
            env["auth_state"] = "disabled"
            env["updated_at"] = now()
            self.save()
            if operation == "delete":
                shutil.rmtree(self.directory / identifier)
                del self.environments[identifier]
                self.save()
            return {}
        if body.get("proxy_id") != env["proxy_id"]:
            raise Failure(409)
        proxy_url = body.get("proxy_url")
        proxy_config(proxy_url)
        if operation == "refresh":
            if env["auth_state"] not in ("authorized", "reauth_required") or (
                env.get("auth_method") != "api_key" and not env.get("profile")
            ):
                raise Failure(409)
            return self.refresh_account(env, proxy_url)
        if env.get("auth_method", "oauth") != "oauth":
            raise Failure(409)
        if operation == "authorize":
            if identifier in self.terminals:
                raise Failure(409, "gemini_terminal_conflict")
            self.ensure_oauth_runtime()
            self.cancel(identifier)
            env["auth_state"] = "authorizing"
            env["updated_at"] = now()
            self.save()
            try:
                login = Login(self, env, proxy_url)
                self.pending[identifier] = login
                return login.challenge()
            except (Failure, OSError, subprocess.SubprocessError) as error:
                self.cancel(identifier)
                env["auth_state"] = "reauth_required"
                env["updated_at"] = now()
                self.save()
                print("Gemini CLI authorization did not start", file=sys.stderr)
                raise Failure(503, "gemini_authorization_unavailable") from error
        if operation == "complete":
            login = self.pending.get(identifier)
            code = body.get("code")
            state = body.get("state")
            if (
                not login
                or body.get("attempt_id") != login.attempt
                or not isinstance(code, str)
                or (
                    state is not None
                    and (
                        not isinstance(state, str)
                        or not re.fullmatch(r"[A-Za-z0-9._~-]{1,512}", state)
                    )
                )
            ):
                raise Failure(409)
            login.submit(code, state, proxy_url)
            return self.view(env)
        raise Failure(404)


class ControlHandler(BaseHTTPRequestHandler):
    def setup(self):
        self.request.settimeout(2)
        super().setup()

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length < 1 or length > 8192:
                raise Failure(400)
            operation = self.path[1:] if self.path.startswith("/") else self.path
            if operation not in {
                "list",
                "get",
                "create",
                "authorize",
                "complete",
                "refresh",
                "disable",
                "delete",
                "logout",
                "terminal-start",
                "terminal-io",
                "terminal-stop",
                "install-payload",
            }:
                raise Failure(404)
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise Failure(400)
            if operation == "install-payload":
                _, uid, _ = struct.unpack(
                    "3i",
                    self.request.getsockopt(
                        socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")
                    ),
                )
                if uid != 0:
                    raise Failure(403)
                if body:
                    raise Failure(400)
            status, payload = 200, self.server.host.request(operation, body)
        except Failure as error:
            status, payload = error.status, {"code": error.code} if error.code else {}
        except (ValueError, TimeoutError, RecursionError):
            status, payload = 400, {}
        except (OSError, subprocess.SubprocessError):
            print("Gemini host operation failed", file=sys.stderr)
            status, payload = 503, {}
        data = json.dumps(payload).encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            return

    def log_message(self, *_args):
        return


def socket_identity(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != 0:
        raise RuntimeError("Gemini socket path is not an owned socket")
    return info.st_dev, info.st_ino


def remove_stale_socket(path):
    stale = socket_identity(path)
    if stale is None:
        return
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(0.25)
        try:
            client.connect(str(path))
        except ConnectionRefusedError:
            if socket_identity(path) == stale:
                path.unlink()
            return
    raise RuntimeError("Gemini socket already has a listener")


def main():
    parser = argparse.ArgumentParser()
    for name in ("state", "payload", "public-key", "egress", "socket"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument("--payload-source", type=Path)
    parser.add_argument("--gateway-group", required=True)
    parser.add_argument("--uid-base", type=int, required=True)
    args = parser.parse_args()
    if os.geteuid() != 0 or not 1024 <= args.uid_base <= 65524:
        raise SystemExit("Gemini host setup requires root and a dedicated UID range")
    os.umask(0o077)
    for uid in range(args.uid_base, args.uid_base + MAX_ENVIRONMENTS + 1):
        try:
            pwd.getpwuid(uid)
        except KeyError:
            continue
        raise SystemExit("Gemini UID range overlaps a host user")
    if any(
        args.uid_base <= account.gr_gid <= args.uid_base + MAX_ENVIRONMENTS
        for account in grp.getgrall()
    ):
        raise SystemExit("Gemini GID range overlaps a host group")
    if not args.state.is_absolute():
        raise SystemExit("Gemini host paths must be absolute")
    check_root_owned(args.state.parent)
    args.state.mkdir(mode=0o711, exist_ok=True)
    for entry in (
        ROOT,
        Path(__file__),
        ROOT / "scripts/gemini-host-egress.sh",
        ROOT / "scripts/install-gemini-payload.mjs",
        ROOT / "scripts/gemini_host_account.py",
        ROOT / "src/lib/gemini/payload.mjs",
        args.state,
        args.socket.parent,
    ):
        if not entry.is_absolute():
            raise SystemExit("Gemini host paths must be absolute")
        check_root_owned(entry)
    args.state.chmod(0o711)
    for entry in (args.payload, args.public_key, args.egress, args.payload_source):
        if entry is not None and not entry.is_absolute():
            raise SystemExit("Gemini host paths must be absolute")
    lock = os.open(
        args.state / "service.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600
    )
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    remove_stale_socket(args.socket)
    host = Host(args)
    bound = None
    stop = False

    def shutdown(*_args):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        with socketserver.UnixStreamServer(str(args.socket), ControlHandler) as server:
            bound = socket_identity(args.socket)
            os.chown(args.socket, 0, grp.getgrnam(args.gateway_group).gr_gid)
            args.socket.chmod(0o660)
            server.host = host
            server.timeout = 0.25
            notify_socket = os.environ.get("NOTIFY_SOCKET")
            if notify_socket:
                address = (
                    "\0" + notify_socket[1:]
                    if notify_socket.startswith("@")
                    else notify_socket
                )
                with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as notify:
                    notify.sendto(b"READY=1", address)
            while not stop:
                server.handle_request()
                host.cleanup()
    finally:
        try:
            host.close()
        finally:
            if bound is not None and socket_identity(args.socket) == bound:
                args.socket.unlink()
            os.close(lock)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.SubprocessError):
        raise SystemExit("Gemini host failed to start or lost its managed runtime")
