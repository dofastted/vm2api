import argparse
import base64
import codecs
import errno
import fcntl
import grp
import hashlib
import hmac
import importlib.util
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
OAUTH_ACCESS_TOKEN = re.compile(r"[A-Za-z0-9._~+/-]{1,4096}={0,2}\Z")
RELEASE_CODE = re.compile(r"CGG1-[A-Za-z0-9_-]{43}\Z")
SHA256 = re.compile(r"[a-f0-9]{64}\Z")
MANUAL_RELEASE = Path("/etc/vm2api/gemini-release.json")
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
AGY_SHA256 = "39816d49d5ab92229952987225c23ea3fed7580699dcb4a444e0388e0ac1ce43"
INFERENCE_MODULE = ROOT / "scripts/gemini_host_inference.py"
MODEL = re.compile(r"[a-z0-9][a-z0-9._-]{0,99}\Z")
RUN_TTL = 150


def invocation_module():
    check_root_owned(INFERENCE_MODULE)
    spec = importlib.util.spec_from_file_location(
        "gemini_host_inference", INFERENCE_MODULE
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Failure(Exception):
    def __init__(self, status, code=None):
        self.status = status
        self.code = code


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


NATIVE_MODULE = ROOT / "scripts/gemini_host_native.py"


def native_module():
    check_root_owned(NATIVE_MODULE)
    spec = importlib.util.spec_from_file_location("gemini_host_native", NATIVE_MODULE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def account_command(uid, method, profile=None):
    return [
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
    ]


def read_account(uid, proxy_url, method, api_key=None, profile=None, oauth_token=None):
    try:
        result = subprocess.run(
            account_command(uid, method, profile),
            input=json.dumps({"proxy_url": proxy_url, "api_key": api_key, "oauth_token": oauth_token}).encode(),
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


def read_root_file(path, limit):
    check_root_owned(path)
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    with os.fdopen(os.open(path, flags), "rb") as data:
        info = os.fstat(data.fileno())
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != 0
            or info.st_mode & 0o022
            or not 0 < info.st_size <= limit
        ):
            raise ValueError("Invalid Gemini file")
        value = data.read(limit + 1)
        if not 0 < len(value) <= limit:
            raise ValueError("Invalid Gemini file size")
        return value


def read_release_verifier(path):
    value = json.loads(read_root_file(path, 1024))
    if (
        not isinstance(value, dict)
        or set(value) != {"manifest_sha256", "code_sha256"}
        or any(
            not isinstance(v, str) or not SHA256.fullmatch(v) for v in value.values()
        )
    ):
        raise ValueError("Invalid Gemini release verifier")
    return value


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


def profile_secrets(profile, uid, *, include_raw=False):
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
        secrets = tuple(
            value
            for value in (
                access,
                credential.get("refresh_token"),
                credential.get("id_token"),
            )
            if isinstance(value, str) and 1 <= len(value) <= 16384 and value.isascii()
        )
        return (secrets, raw) if include_raw else secrets
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

VT_EXEC = """import os,sys
fd=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
os.write(fd,str(os.getpid()).encode('ascii'))
os.close(fd)
os.execvpe(sys.argv[2],sys.argv[2:],os.environ)
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
            self.initialize_home(home)
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
        ]
        self.launch_cli(self.launch_args(self.uid) + sandbox, size)

    def initialize_home(self, home):
        settings = home / ".gemini" / "antigravity-cli"
        for private in (home, home / ".gemini", settings):
            private.mkdir(mode=0o700)
            os.chown(private, self.uid, self.uid)
        private_json(settings / "settings.json", CLI_SETTINGS)
        os.chown(settings / "settings.json", self.uid, self.uid)

    def launch_cli(self, argv, size):
        argv += [
            "--setenv",
            "SSH_TTY",
            "/dev/tty",
            "--setenv",
            "SSH_CONNECTION",
            "127.0.0.1 12345 127.0.0.1 22",
            "--",
        ]
        if self.profile is not None:
            argv += ["/usr/bin/python3", "-I", "-c", TERMINAL_EXEC]
        argv += ["/opt/agy", "--mode", "plan"]
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


class Headless(Agy):
    def __init__(self, host, environment, proxy_url, auth, args, prompt):
        self.invocation = None
        self.credentials, self.token_bytes = auth
        self.args, self.prompt = args, prompt
        super().__init__(host, environment, proxy_url)

    def initialize_home(self, home):
        super().initialize_home(home)
        settings = home / ".gemini" / "antigravity-cli"
        private_json(
            settings / "settings.json",
            {
                **CLI_SETTINGS,
                "permissions": {
                    "deny": [
                        "read_file(*)",
                        "write_file(*)",
                        "command(*)",
                        "mcp(*)",
                        "read_url(*)",
                        "execute_url(*)",
                    ]
                },
            },
        )
        os.chown(settings / "settings.json", self.uid, self.uid)
        token = settings / TOKEN_NAME
        token.write_bytes(self.token_bytes)
        os.chown(token, self.uid, self.uid)
        self.token_bytes = None

    def launch_cli(self, argv, size):
        self.invocation = invocation_module().Invocation(
            argv + ["--", "/opt/agy", *self.args],
            SYSTEM_ENV,
            self.prompt,
            secrets=self.credentials,
        )

    def poll(self):
        if self.egress.poll() is not None:
            return {
                "state": "failed",
                "text": "",
                "error": {
                    "code": "gemini_proxy_error",
                    "message": "Gemini egress stopped",
                },
            }
        return self.invocation.poll()

    def close(self, preserve=False):
        try:
            if self.invocation is not None:
                self.invocation.close()
        finally:
            super().close(preserve)


def native_process_identity(pid):
    fields = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
    tty = int(fields[4])
    start = int(fields[19])
    pgid = int(fields[2])
    if tty == 0 or ((tty >> 8) & 0xFFF) in (2, 3, *range(128, 144)):
        raise Failure(503, "gemini_native_tty_unavailable")
    return pgid, start


def read_native_tui_pid(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != 0
            or info.st_nlink != 1
            or info.st_mode & 0o077
            or not 1 <= info.st_size <= 16
        ):
            raise Failure(503, "gemini_native_tty_unavailable")
        raw = os.read(descriptor, 17)
        if len(raw) != info.st_size or not raw.isdigit():
            raise Failure(503, "gemini_native_tty_unavailable")
        return int(raw)
    finally:
        os.close(descriptor)


class NativeAgy(Agy):
    def __init__(self, host, environment, proxy_url, auth, model, prompt):
        self.credentials, _ = auth
        self.model, self.prompt = model, prompt
        self.native_dir = None
        self.native_token = None
        self.native_tui = None
        self.native_tui_pid = None
        self.native_tui_pgid = None
        self.native_tui_start = None
        self.native_invocation = None
        self.native_diagnostic = None
        # CLI onboarding and project state belong to the authorized profile, not the token alone.
        profile = host.directory / environment["id"] / environment["profile"]
        super().__init__(host, environment, proxy_url, profile=profile)

    def launch_cli(self, argv, size):
        self.native_dir = self.directory / "native"
        self.native_dir.mkdir(mode=0o700)
        os.chown(self.native_dir, self.uid, self.uid)
        self.native_token = secrets.token_hex(32)
        config = self.native_dir / "kernel.json"
        private_json(
            config,
            {
                "run_dir": "/tmp/craggemini",
                "internal_token": self.native_token,
                "session_id": self.attempt,
                "model": self.model,
                "agy_sha256": AGY_SHA256,
                "timeout_ms": 120000,
                "first_byte_timeout_ms": 90000,
                "idle_timeout_ms": 15000,
                "queue_timeout_ms": 1000,
                "max_queue": 1,
            },
        )
        os.chown(config, self.uid, self.uid)
        native_module_impl = native_module()
        self.native_diagnostic = native_module_impl.EligibilityDiagnostic(
            self.native_dir, self.uid
        )

        argv.extend(
            [
                "--ro-bind",
                str(self.host.payload / "craggemini"),
                "/opt/craggemini",
                "--ro-bind",
                str(self.host.payload / "libagy_bridge.so"),
                "/opt/libagy_bridge.so",
                "--dir",
                "/tmp/craggemini",
                "--bind",
                str(self.native_dir),
                "/tmp/craggemini",
                "--setenv",
                "SSH_CONNECTION",
                "127.0.0.1 12345 127.0.0.1 22",
                "--setenv",
                "CRAGGEMINI_SESSION_ID",
                self.attempt,
                "--ro-bind",
                str(NATIVE_MODULE),
                "/opt/gemini_host_native.py",
                "--",
                "/usr/bin/python3",
                "-I",
                "/opt/gemini_host_native.py",
                "--launch-native",
                "/opt/agy",
                "--mode",
                "plan",
                "--model",
                self.model,
                "--settings",
                json.dumps(CLI_SETTINGS, separators=(",", ":")),
                "--log-file",
                "/tmp/craggemini/" + native_module_impl.ELIGIBILITY_LOG_FILE,
            ]
        )
        self.native_exit_reader = native_module_impl.read_launcher_exit
        try:
            lock, vt = native_module_impl.query_free_vt(
                self.host.directory / "native-vt.lock"
            )
        except (native_module_impl.NativeFailure, OSError) as error:
            code = getattr(error, "code", "gemini_native_tty_unavailable")
            raise Failure(503, code) from None
        try:
            self.native_tui = subprocess.Popen(
                [
                    "openvt",
                    "-c",
                    str(vt),
                    "-w",
                    "--",
                    sys.executable,
                    "-I",
                    "-c",
                    VT_EXEC,
                    str(self.directory / "tui.pid"),
                    *argv,
                ],
                env=SYSTEM_ENV,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            pid_path = self.directory / "tui.pid"
            pid_deadline = time.monotonic() + 5
            while not pid_path.exists() and self.native_tui.poll() is None:
                if time.monotonic() >= pid_deadline:
                    raise Failure(503, "gemini_native_tty_unavailable")
                time.sleep(0.02)
            if self.native_tui.poll() is not None or not pid_path.exists():
                raise Failure(503, "gemini_native_tty_unavailable")
            self.native_tui_pid = read_native_tui_pid(pid_path)
            self.native_tui_pgid, self.native_tui_start = native_process_identity(
                self.native_tui_pid
            )
        except OSError:
            raise Failure(503, "gemini_native_tty_unavailable") from None
        finally:
            os.close(lock)
        self.pid = self.native_tui_pid
        self.native_invocation = native_module_impl.NativeInvocation(
            {
                "socket": str(self.native_dir / "kernel.sock"),
                "token": self.native_token,
                "model": self.model,
                "request_id": self.attempt,
                "prompt": self.prompt,
                "startup_timeout": 45,
            },
            secrets=self.credentials,
        )
        self.prompt = None
        self.credentials = ()

    def poll(self):
        if self.egress.poll() is not None:
            return {
                "state": "failed",
                "text": "",
                "error": {
                    "code": "gemini_proxy_error",
                    "message": "Gemini egress stopped",
                },
            }
        result = self.native_invocation.poll()
        if result["state"] == "completed":
            return result
        wrapper_exited = self.native_tui is None or self.native_tui.poll() is not None
        diagnostic = self.native_diagnostic.poll(
            final=wrapper_exited or result["state"] != "running"
        )
        if diagnostic is not None:
            return {
                "state": "failed",
                "text": "",
                "error": {"code": diagnostic},
            }
        if result["state"] != "running":
            return result
        if wrapper_exited:
            return {
                "state": "failed",
                "text": "",
                "error": {"code": "gemini_native_worker_unavailable"},
            }
        return result

    def close(self, preserve=False):
        wrapper_status = self.native_tui.poll() if self.native_tui is not None else None
        try:
            if self.native_invocation is not None:
                self.native_invocation.close()
        finally:
            try:
                if self.native_tui_pid and self.native_tui_start is not None:
                    try:
                        current = native_process_identity(self.native_tui_pid)
                        if current == (self.native_tui_pgid, self.native_tui_start):
                            os.killpg(self.native_tui_pgid, signal.SIGKILL)
                    except (OSError, ValueError, Failure):
                        pass
                if self.native_tui is not None:
                    self._stop_process_group(self.native_tui)
                    self.native_tui = None
                    outcome = self.native_exit_reader(self.native_dir, self.uid)
                    if outcome is not None:
                        child, status = outcome
                        kind = "exit_code" if status >= 0 else "signal"
                        print(
                            f"Gemini native child={child} {kind}={abs(status)}",
                            file=sys.stderr,
                        )
                    elif wrapper_status is not None:
                        kind = "exit_code" if wrapper_status >= 0 else "signal"
                        print(
                            f"Gemini native wrapper=openvt {kind}={abs(wrapper_status)} child_record=missing",
                            file=sys.stderr,
                        )
                    else:
                        print(
                            "Gemini native wrapper=openvt status=running_before_cleanup child_record=missing",
                            file=sys.stderr,
                        )
            finally:
                self.pid = None
                self.native_tui_pid = None
                self.credentials = ()
                self.prompt = None
                try:
                    if self.native_diagnostic is not None:
                        self.native_diagnostic.close()
                finally:
                    super().close(preserve)

    @staticmethod
    def _stop_process_group(process):
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


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
        self.default_public_key = args.default_public_key
        self.default_release = args.default_release_verifier
        self.manual_release = args.release_verifier or MANUAL_RELEASE
        self.manual_release_optional = args.release_verifier is None
        self.activation = self.directory / "release-activation.json"
        self.verified_payload = None
        self.payload_version = None
        self.payload_state = "not_configured"
        self.payload_issue = None
        self.egress = args.egress
        self.uid_base = args.uid_base
        self.egress_uid = args.uid_base + MAX_ENVIRONMENTS
        self.state_file = self.directory / "environments.json"
        self.pending = {}
        self.terminals = {}
        self.runs = {}
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

    def verify_payload(self, source, public_key, install=False):
        check_root_owned(source)
        check_root_owned(public_key)
        for name in PAYLOAD_FILES:
            check_root_owned(source / name)
        output = subprocess.run(
            [
                "node",
                str(ROOT / "scripts/install-gemini-payload.mjs"),
                "--source",
                str(source),
                "--public-key",
                str(public_key),
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

    def release_verifier(self, path, optional=False):
        try:
            return read_release_verifier(path)
        except FileNotFoundError:
            if optional:
                return None
            raise Failure(503, "gemini_release_not_configured") from None
        except (OSError, RuntimeError, ValueError, RecursionError):
            raise Failure(503, "gemini_release_invalid") from None

    def payload_config(self):
        installed = self.payload.exists() or self.payload.is_symlink()
        source = self.payload if installed else self.payload_source
        if source is None or not source.is_dir():
            raise Failure(503, "gemini_payload_source_missing")
        if any(not (source / name).is_file() for name in PAYLOAD_FILES):
            raise Failure(503, "gemini_payload_incomplete")
        if installed and any(
            not os.access(source / name, os.X_OK) for name in ("agy", "craggemini")
        ):
            raise Failure(503, "gemini_payload_incomplete")
        digest = hashlib.sha256(
            read_root_file(source / "manifest.json", 8192)
        ).hexdigest()
        default = (
            self.release_verifier(self.default_release)
            if self.default_release
            else None
        )
        # The shell pins the default verifier. A different manifest must never
        # be validated with the staged default key, even as a fallback.
        if default is not None and digest == default["manifest_sha256"]:
            public_key, verifier = self.default_public_key, default
        else:
            public_key = self.public_key
            verifier = self.release_verifier(
                self.manual_release, self.manual_release_optional
            )
            if verifier is not None:
                # Only a genuinely unconfigured legacy install is exempt.
                self.manual_release_optional = False
                if digest != verifier["manifest_sha256"]:
                    raise Failure(409, "gemini_release_payload_mismatch")
        if not public_key.is_file():
            raise Failure(503, "gemini_public_key_missing")
        check_root_owned(public_key)
        return source, installed, public_key, verifier, digest

    def payload_identity(self, source, public_key, digest):
        # Hash large binaries only on first use or when a trusted input changes.
        files = (public_key, source, *(source / name for name in PAYLOAD_FILES))
        stats = (entry.lstat() for entry in files)
        identities = tuple(
            (
                s.st_dev,
                s.st_ino,
                s.st_mode,
                s.st_uid,
                s.st_size,
                s.st_ctime_ns,
                s.st_mtime_ns,
            )
            for s in stats
        )
        return (source, public_key, digest, identities)

    def release_activated(self, verifier):
        try:
            return read_release_verifier(self.activation) == verifier
        except (OSError, RuntimeError, ValueError, RecursionError):
            return False

    def load_payload(
        self, *, materialize=False, verify_again=False, legacy_install=False
    ):
        try:
            source, installed, public_key, verifier, digest = self.payload_config()
            install = not installed and (
                materialize or (legacy_install and verifier is None)
            )
            version = None
            if installed or install:
                identity = self.payload_identity(source, public_key, digest)
                if install:
                    check_root_owned(self.payload.parent)
                cached = None if verify_again else self.verified_payload
                if not install and cached is not None and identity == cached[0]:
                    version = cached[1]
                else:
                    version = self.verify_payload(source, public_key, install=install)
                    if install:
                        target_digest = hashlib.sha256(
                            read_root_file(self.payload / "manifest.json", 8192)
                        ).hexdigest()
                        if target_digest != digest:
                            raise RuntimeError(
                                "Gemini manifest changed during installation"
                            )
                        identity = self.payload_identity(
                            self.payload, public_key, digest
                        )
                    elif self.payload_identity(source, public_key, digest) != identity:
                        raise RuntimeError("Gemini payload changed during verification")
                    self.verified_payload = (identity, version)
                self.payload_state = (
                    "installed"
                    if verifier is None or self.release_activated(verifier)
                    else "awaiting_redemption"
                )
            elif verifier is None:
                self.payload_state = "install_on_create"
            else:
                raise Failure(503, "gemini_payload_not_installed")
            self.payload_version = version
            self.payload_issue = None
            return verifier
        except (OSError, RuntimeError, ValueError, subprocess.SubprocessError):
            if self.payload_issue != "gemini_payload_invalid":
                print(
                    "Gemini payload installation or verification failed",
                    file=sys.stderr,
                )
            self.payload_failure("gemini_payload_invalid")
            raise Failure(503, "gemini_payload_invalid") from None
        except Failure as error:
            self.payload_failure(error.code)
            raise

    def payload_failure(self, code):
        self.payload_issue = code
        self.payload_state = (
            "not_configured"
            if code
            in (
                "gemini_payload_source_missing",
                "gemini_payload_incomplete",
                "gemini_public_key_missing",
                "gemini_payload_not_installed",
            )
            else "invalid"
        )
        self.payload_version = None
        self.verified_payload = None

    def inspect_payload(self):
        try:
            self.load_payload()
        except Failure:
            pass  # Inventory remains available for diagnosis even if not usable.

    def ensure_payload(self, *, legacy_install=True):
        self.load_payload(legacy_install=legacy_install)
        if self.payload_state == "awaiting_redemption":
            raise Failure(403, "gemini_release_redemption_required")
        if self.payload_state != "installed":
            raise Failure(503, "gemini_payload_not_installed")

    def redeem_payload(self, code):
        if not isinstance(code, str) or not RELEASE_CODE.fullmatch(code):
            raise Failure(400, "gemini_release_code_invalid")
        verifier = self.load_payload()
        if verifier is None:
            raise Failure(503, "gemini_release_not_configured")
        if not hmac.compare_digest(
            hashlib.sha256(code.encode("ascii")).hexdigest(), verifier["code_sha256"]
        ):
            raise Failure(400, "gemini_release_code_invalid")
        private_json(self.activation, verifier)
        self.payload_state = "installed"
        return {"kernel_version": self.payload_version}

    def oauth_runtime_issue(self):
        if any(
            not shutil.which(tool, path=SYSTEM_ENV["PATH"])
            for tool in ("ip", "nft", "setpriv", "bwrap", "curl", "openvt")
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

    def stop_run(self, identifier):
        entry = self.runs.pop(identifier, None)
        if entry and entry["process"] is not None:
            entry["process"].close()

    def running(self, identifier):
        entry = self.runs.get(identifier)
        return bool(entry and entry["process"] is not None)

    def update_run(self, entry):
        if entry["process"] is None:
            return entry["result"]
        result = entry["process"].poll()
        if result["state"] != "running" or time.monotonic() >= entry["deadline"]:
            entry["process"].close()
            entry["process"] = None
            entry["result"] = (
                result
                if result["state"] != "running"
                else {
                    "state": "failed",
                    "text": "",
                    "error": {
                        "code": "gemini_inference_timeout",
                        "message": "Gemini request timed out",
                    },
                }
            )
            entry["deadline"] = time.monotonic() + RUN_TTL
            return entry["result"]
        return result

    def operation_account(self, env):
        self.ensure_payload(legacy_install=False)
        if env["auth_state"] != "authorized":
            code = (
                "gemini_api_key_invalid"
                if env.get("auth_method") == "api_key"
                else "gemini_oauth_required"
            )
            raise Failure(409, code)
        identifier = env["id"]
        if (
            self.running(identifier)
            or identifier in self.terminals
            or identifier in self.pending
        ):
            raise Failure(409, "gemini_operation_busy")
        uid = self.uid_base + env["slot"]
        directory = self.directory / identifier
        if env.get("auth_method") == "api_key":
            key = json.loads(read_root_file(directory / "credential.json", 1024)).get(
                "api_key"
            )
            if isinstance(key, str) and API_KEY.fullmatch(key):
                return uid, key, None
            raise Failure(409, "gemini_api_key_invalid")
        profile = env.get("profile")
        auth = profile and profile_secrets(directory / profile, uid, include_raw=True)
        if not auth:
            raise Failure(409, "gemini_oauth_required")
        issue = self.oauth_runtime_issue()
        if issue:
            raise Failure(503, issue)
        return uid, None, auth

    def pull_models(self, env, proxy_url):
        uid, key, auth = self.operation_account(env)
        if key:
            data = read_account(uid, proxy_url, "api-key-models", api_key=key)
            if data.get("state") == "reauth_required":
                raise Failure(409, "gemini_api_key_invalid")
            if data.get("state") not in ("ok", "partial"):
                raise Failure(502, "gemini_proxy_error")
            models = data.get("models", [])
        else:
            run = Headless(
                self, env, proxy_url, auth, invocation_module().MODEL_ARGS, None
            )
            try:
                deadline = time.monotonic() + 19
                while True:
                    result = run.poll()
                    if result["state"] != "running":
                        break
                    if time.monotonic() >= deadline:
                        raise Failure(504, "gemini_inference_timeout")
                    time.sleep(0.05)
                if result["state"] != "completed":
                    raise Failure(502, result["error"]["code"])
                models = result.get("models", [])
            finally:
                run.close()
        if not models:
            raise Failure(502, "gemini_models_empty")
        self.save_environment(env, {**env, "call_models": models, "updated_at": now()})
        return self.view(env)

    def start_run(self, env, proxy_url, body):
        model, prompt = body.get("model"), body.get("prompt")
        if (
            not isinstance(model, str)
            or not MODEL.fullmatch(model)
            or not isinstance(prompt, str)
            or not prompt.strip()
            or len(prompt.encode()) > 4096
        ):
            raise Failure(400)
        uid, key, auth = self.operation_account(env)
        if model not in env.get("call_models", []):
            raise Failure(409, "gemini_model_unavailable")
        identifier = env["id"]
        self.stop_run(identifier)
        if key:
            process = invocation_module().Invocation(
                account_command(uid, "api-key-chat"),
                SYSTEM_ENV,
                prompt,
                input_bytes=json.dumps(
                    {
                        "api_key": key,
                        "proxy_url": proxy_url,
                        "prompt": prompt,
                        "model": model,
                    }
                ).encode(),
                secrets=(key,),
            )
        else:
            process = NativeAgy(self, env, proxy_url, auth, model, prompt)
        run_id = secrets.token_hex(16)
        self.runs[identifier] = {
            "id": run_id,
            "process": process,
            "deadline": time.monotonic() + RUN_TTL,
        }
        return {"run_id": run_id}

    def run_request(self, operation, identifier, body):
        entry = self.runs.get(identifier)
        if not entry or entry["id"] != body.get("run_id"):
            raise Failure(404, "gemini_run_not_found")
        if operation == "test-chat-cancel":
            self.stop_run(identifier)
            return {"cancelled": True}
        try:
            self.ensure_payload(legacy_install=False)
        except Failure:
            self.stop_run(identifier)
            raise
        return self.update_run(entry)

    def probe_proxy(self, env, proxy_url):
        started = time.monotonic()
        result = read_account(self.uid_base + env["slot"], proxy_url, "proxy-probe")
        return {
            "ok": result.get("ok") is True,
            "latency_ms": round((time.monotonic() - started) * 1000),
        }

    def save_environment(self, env, updated):
        private_json(self.state_file, {**self.environments, env["id"]: updated})
        env.clear()
        env.update(updated)

    def bind_proxy(self, env, body):
        new_id = body.get("proxy_id")
        if not isinstance(new_id, str) or not ID.fullmatch(new_id):
            raise Failure(400)
        proxy_config(body.get("proxy_url"))
        identifier = env["id"]
        if (
            body.get("previous_proxy_id") != env["proxy_id"]
            or self.running(identifier)
            or identifier in self.terminals
            or identifier in self.pending
        ):
            raise Failure(409, "gemini_operation_busy")
        if new_id != env["proxy_id"]:
            self.stop_run(identifier)
            updated = {**env, "proxy_id": new_id, "updated_at": now()}
            updated.pop("call_models", None)
            updated.pop("account", None)
            self.save_environment(env, updated)
        return self.view(env)

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
            try:
                self.ensure_payload(legacy_install=False)
            except Failure:
                self.stop_terminal(identifier)
                raise
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
            or self.running(identifier)
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
        self.ensure_payload()
        try:
            issue = self.oauth_runtime_issue()
            if issue:
                raise Failure(503, issue)
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
            (self.stop_run, self.runs),
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
        for identifier, entry in list(self.runs.items()):
            if entry["process"] is None and time.monotonic() >= entry["deadline"]:
                self.stop_run(identifier)
            else:
                self.update_run(entry)
        if self.terminals or self.pending or self.runs:
            try:
                self.ensure_payload(legacy_install=False)
            except Failure:
                for identifier in list(self.runs):
                    self.stop_run(identifier)
                for identifier in list(self.terminals):
                    self.stop_terminal(identifier)
                for identifier in list(self.pending):
                    self.cancel(identifier)
                    self.environments[identifier].update(
                        auth_state="reauth_required", updated_at=now()
                    )
                    self.save()
                return
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
                imported = env.pop("oauth_imported", False)
                login.close(preserve=True)
                env.update(
                    auth_state="authorized", profile=login.attempt, updated_at=now()
                )
                env.pop("account", None)
                env.pop("call_models", None)
                self.save()
                if imported:
                    (self.directory / identifier / "oauth-import.json").unlink(
                        missing_ok=True
                    )
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
            **({"oauth_imported": True} if env.get("oauth_imported") else {}),
            "runtime_ready": False,
            "kernel_version": self.payload_version,
            "models": env.get("call_models", account.get("models", [])),
            "models_discovered": bool(env.get("call_models")),
            "account": account,
            "created_at": env.get("created_at"),
            "updated_at": env.get("updated_at"),
        }

    def probe_imported_account(self, slot, proxy_url, credential):
        if credential["expiry"] <= time.time():
            return {"state": "reauth_required", "checked_at": now()}
        return read_account(
            self.uid_base + slot, proxy_url, "oauth_import", oauth_token=credential
        )

    def refresh_account(self, env, proxy_url):
        directory = self.directory / env["id"]
        if env.get("auth_method") == "api_key":
            api_key = json.loads((directory / "credential.json").read_bytes())[
                "api_key"
            ]
            account = read_account(
                self.uid_base + env["slot"], proxy_url, "api_key", api_key=api_key
            )
        elif env.get("oauth_imported"):
            credential = json.loads((directory / "oauth-import.json").read_bytes())
            account = self.probe_imported_account(env["slot"], proxy_url, credential)
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
            self.stop_run(env["id"])
            env.pop("call_models", None)
            self.stop_terminal(env["id"])
            env["auth_state"] = "reauth_required"
        elif account.get("state") in ("ok", "partial"):
            env["auth_state"] = "authorized"
        env["updated_at"] = now()
        self.save()
        return self.view(env)

    def request(self, operation, body):
        if operation == "install-payload":
            self.load_payload(materialize=True, verify_again=True)
            return {
                "version": self.payload_version,
                "activation_required": self.payload_state == "awaiting_redemption",
            }
        if operation == "redeem":
            return self.redeem_payload(body.get("redemption_code"))
        if operation == "list":
            self.inspect_payload()
            return {
                "payload_state": self.payload_state,
                "payload_issue": self.payload_issue,
                "release_activated": self.payload_state == "installed",
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
            imported = body.get("oauth_account")
            credential = None
            if imported is not None:
                if method != "oauth" or not isinstance(imported, dict):
                    raise Failure(400, "gemini_oauth_import_invalid")
                access = imported.get("access_token")
                expiry = imported.get("expiry_timestamp")
                if (
                    not isinstance(access, str)
                    or not OAUTH_ACCESS_TOKEN.fullmatch(access)
                    or type(expiry) is not int
                    or not 0 < expiry < 253402300800
                ):
                    raise Failure(400, "gemini_oauth_import_invalid")
                credential = {"access_token": access, "expiry": expiry}
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
            if credential:
                account = self.probe_imported_account(slot, proxy_url, credential)
                if account["state"] == "reauth_required":
                    raise Failure(400, "gemini_oauth_import_rejected")
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
                "auth_state": (
                    "authorized" if method == "api_key" or credential else "unverified"
                ),
                **({"oauth_imported": True} if credential else {}),
                "account": account,
                "created_at": timestamp,
                "updated_at": timestamp,
            }
            try:
                if method == "api_key":
                    private_json(directory / "credential.json", {"api_key": api_key})
                if credential:
                    private_json(directory / "oauth-import.json", credential)
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
            self.inspect_payload()
            return {
                **self.view(env),
                "payload_state": self.payload_state,
                "payload_issue": self.payload_issue,
            }
        if operation == "proxy-bind":
            return self.bind_proxy(env, body)
        if operation in ("test-chat-status", "test-chat-cancel"):
            return self.run_request(operation, identifier, body)
        if operation in ("terminal-start", "terminal-io", "terminal-stop"):
            return self.terminal_request(operation, env, body)
        if operation == "logout":
            if env.get("auth_method", "oauth") != "oauth":
                raise Failure(409)
            self.stop_run(identifier)
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
            env.pop("call_models", None)
            if env["auth_state"] != "disabled":
                env["auth_state"] = "reauth_required"
            env["updated_at"] = now()
            self.save()
            return {}
        if operation in ("delete", "disable"):
            self.stop_run(identifier)
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
        if operation == "proxy-probe":
            return self.probe_proxy(env, proxy_url)
        if operation == "models":
            return self.pull_models(env, proxy_url)
        if operation == "test-chat":
            return self.start_run(env, proxy_url, body)
        if operation == "refresh":
            self.ensure_payload(legacy_install=False)
            if env["auth_state"] not in ("authorized", "reauth_required") or (
                env.get("auth_method") != "api_key"
                and not (env.get("profile") or env.get("oauth_imported"))
            ):
                raise Failure(409)
            return self.refresh_account(env, proxy_url)
        if env.get("auth_method", "oauth") != "oauth":
            raise Failure(409)
        if operation == "authorize":
            if identifier in self.terminals or self.running(identifier):
                raise Failure(409, "gemini_terminal_conflict")
            self.ensure_oauth_runtime()
            self.cancel(identifier)
            self.stop_run(identifier)
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
            self.ensure_payload(legacy_install=False)
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
            operation = self.path[1:] if self.path.startswith("/") else self.path
            if length < 1 or length > (
                32768 if operation in ("create", "test-chat") else 8192
            ):
                raise Failure(400)
            if operation not in {
                "list",
                "redeem",
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
                "proxy-probe",
                "proxy-bind",
                "models",
                "test-chat",
                "test-chat-status",
                "test-chat-cancel",
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
    parser.add_argument("--default-public-key", type=Path)
    parser.add_argument("--default-release-verifier", type=Path)
    parser.add_argument("--release-verifier", type=Path)
    parser.add_argument("--gateway-group", required=True)
    parser.add_argument("--uid-base", type=int, required=True)
    args = parser.parse_args()
    if (args.default_public_key is None) != (args.default_release_verifier is None):
        parser.error(
            "--default-public-key and --default-release-verifier must be used together"
        )
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
        INFERENCE_MODULE,
        NATIVE_MODULE,
        ROOT / "src/lib/gemini/payload.mjs",
        args.state,
        args.socket.parent,
    ):
        if not entry.is_absolute():
            raise SystemExit("Gemini host paths must be absolute")
        check_root_owned(entry)
    args.state.chmod(0o711)
    for entry in (
        args.payload,
        args.public_key,
        args.egress,
        args.payload_source,
        args.default_public_key,
        args.default_release_verifier,
        args.release_verifier,
    ):
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
