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
import queue
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
import threading
import time
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
MAX_ENVIRONMENTS = 8
MAX_CONCURRENCY = 64
AUTH_TTL = 300
AUTH_MIN_SETTLE_SECONDS = 3.0
AUTH_SETTLE_SECONDS = 6.0
TERMINAL_TTL = 300
TERMINAL_READ = 16384
TERMINAL_INPUT = 1024
ATTEMPT = re.compile(r"[a-f0-9]{32}\Z")
TOKEN_NAME = "antigravity-oauth-token"
ACCESS_TOKEN = re.compile(r"[A-Za-z0-9._~+/-]{1,4096}={0,2}\Z")
CLI_SETTINGS = {"toolPermission": "strict", "useG1Credits": False}
NATIVE_CLI_SETTINGS = {
    "allowNonWorkspaceAccess": True,
    "useG1Credits": False,
    "permissions": {
        "allow": [
            "read_file(/work/.craggemini-media)",
            "read_file(/work/.craggemini-media/*)",
            "read_file(/work/.craggemini-media/**)",
            "read_file(/tmp/craggemini)",
            "read_file(/tmp/craggemini/**)",
        ],
        "deny": [
            "write_file(*)",
            "command(*)",
        ],
    },
}
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
CRAG_PAYLOAD_FILES = (
    "manifest.json",
    "agy",
    "craggemini",
    "craggemini.payload.enc",
    "libagy_bridge.so",
    "crag-license-public.pem",
)
LICENSE_ERROR_CODES = frozenset(
    {
        "license_required",
        "license_expired",
        "license_not_yet_valid",
        "license_invalid",
        "license_binding_mismatch",
        "license_unconfigured",
    }
)
AGY_SHA256 = "39816d49d5ab92229952987225c23ea3fed7580699dcb4a444e0388e0ac1ce43"
INFERENCE_MODULE = ROOT / "scripts/gemini_host_inference.py"
MODEL = re.compile(r"[a-z0-9][a-z0-9._-]{0,99}\Z")
INFER_REQUEST_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
RUN_TTL = 150
# Idle TTL for burst agy slots above min_warm_slots inside craggemini pool.
# Resident NativeSession & min_warm_slots=1 base agy process are NEVER reaped for idle time.
NATIVE_SESSION_TTL = 600
NATIVE_HEALTH_FAIL_THRESHOLD = 3
NATIVE_HEALTH_POLL_INTERVAL = 15.0
NATIVE_WARM_BACKOFF_MIN = 2.0
NATIVE_WARM_BACKOFF_MAX = 60.0
NATIVE_DEFAULT_MODEL = "gemini-3-flash"
MAX_INFER_BODY = 12 * 1024 * 1024
NATIVE_RUNTIME_ROOT = Path("/run/vm2api-gemini-native")
FULL_CAPABILITIES = (
    "streaming",
    "multi_turn",
    "system_instruction",
    "tools",
    "generation_config",
    "thinking",
    "multimodal",
    "full_gemini_api",
)
NATIVE_CAPABILITIES = (
    "streaming",
    "native_tui",
    "multi_turn",
    "system_instruction",
    "tools",
    "generation_config",
    "thinking",
    "multimodal",
)
# Fixed categories only: process output and exception details are not inventory data.
INFERENCE_ERROR_CODES = frozenset(
    {
        "gemini_account_ineligible",
        "gemini_account_verification_required",
        "gemini_api_key_invalid",
        "gemini_inference_bad_input",
        "gemini_inference_cancelled",
        "gemini_inference_failed",
        "gemini_inference_invalid_output",
        "gemini_inference_output_limit",
        "gemini_inference_start_failed",
        "gemini_inference_timeout",
        "gemini_inference_tool_blocked",
        "gemini_location_unsupported",
        "gemini_model_unavailable",
        "gemini_models_empty",
        "gemini_native_bridge_timeout",
        "gemini_native_tty_unavailable",
        "gemini_native_worker_unavailable",
        "gemini_oauth_required",
        "gemini_proxy_error",
        "gemini_quota_exhausted",
        *LICENSE_ERROR_CODES,
    }
)

_TRUSTED_MODULES = {}
_TRUSTED_MODULES_LOCK = threading.Lock()


def _load_trusted_module(name, path):
    check_root_owned(path)
    info = path.lstat()
    identity = (
        info.st_dev,
        info.st_ino,
        info.st_size,
        info.st_ctime_ns,
        info.st_mtime_ns,
    )
    with _TRUSTED_MODULES_LOCK:
        cached = _TRUSTED_MODULES.get(name)
        if cached is not None and cached[0] == identity:
            return cached[1]
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _TRUSTED_MODULES[name] = (identity, module)
        return module


def invocation_module():
    return _load_trusted_module("gemini_host_inference", INFERENCE_MODULE)


class Failure(Exception):
    def __init__(self, status, code=None):
        self.status = status
        self.code = code


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def env_concurrency(env):
    value = env.get("max_concurrency") if isinstance(env, dict) else None
    return value if type(value) is int and 1 <= value <= MAX_CONCURRENCY else 1


def env_hostname(env):
    identifier = env.get("id") if isinstance(env, dict) else None
    if not isinstance(identifier, str) or not identifier:
        return "ws-default"
    digest = hashlib.sha256(f"vm2api-gemini-host:{identifier}".encode("utf-8")).hexdigest()
    return f"ws-{digest[:8]}"


def verify_proxy_sha256(body, proxy_url):
    if "proxy_sha256" not in body or body["proxy_sha256"] is None:
        return
    expected = body["proxy_sha256"]
    actual = hashlib.sha256(proxy_url.encode()).hexdigest()
    if (
        not isinstance(expected, str)
        or not SHA256.fullmatch(expected)
        or not hmac.compare_digest(expected, actual)
    ):
        raise Failure(409, "gemini_proxy_calibration_mismatch")


NATIVE_MODULE = ROOT / "scripts/gemini_host_native.py"


def native_module():
    return _load_trusted_module("gemini_host_native", NATIVE_MODULE)


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


class _Spawner:
    """Single long-lived thread that forks managed child processes so Linux
    PR_SET_PDEATHSIG fires only when gemini-host exits, never when an HTTP
    worker thread from ThreadingUnixStreamServer terminates."""

    def __init__(self):
        self._queue = queue.Queue()
        self._thread = threading.Thread(
            target=self._loop, name="gemini-spawner", daemon=True
        )
        self._thread.start()

    def _loop(self):
        while True:
            fn, result_q = self._queue.get()
            try:
                result_q.put((True, fn()))
            except BaseException as exc:
                result_q.put((False, exc))

    def call(self, fn):
        if threading.current_thread() is self._thread:
            return fn()
        result_q = queue.Queue(maxsize=1)
        self._queue.put((fn, result_q))
        ok, value = result_q.get()
        if ok:
            return value
        raise value


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
        self._network_lease = None
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
        hostname = env_hostname(self.environment)
        files = {
            "resolv.conf": "nameserver 1.1.1.1\noptions timeout:2 attempts:2\n",
            "passwd": f"agy:x:{self.uid}:{self.uid}:Antigravity:/home/agy:/bin/sh\n",
            "group": f"agy:x:{self.uid}:\n",
            "nsswitch.conf": "passwd: files\ngroup: files\nhosts: files dns\n",
            "hosts": f"127.0.0.1 localhost {hostname}\n::1 localhost\n",
        }
        identity = []
        for name, contents in files.items():
            target = self.directory / name
            target.write_text(contents, encoding="ascii")
            target.chmod(0o644)
            identity += ["--ro-bind", str(target), "/etc/" + name]
        machine_id = self.host.ensure_env_machine_id(self.environment)
        identity += ["--ro-bind", str(machine_id), "/etc/machine-id"]
        if hasattr(self.host, "acquire_slot_network"):
            lease = self.host.acquire_slot_network(
                self.slot,
                self.directory.parent,
                self.network,
                self.environment["proxy_id"],
                proxy_url,
                self.proxy_hash,
                self.launch_args,
            )
            self._network_lease = lease
            self.network_lock = lease["lock"]
            self.egress = lease["egress"]
        else:
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
            spawn = getattr(self.host, "spawn", lambda fn: fn())
            self.egress = spawn(
                lambda: subprocess.Popen(
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
            )
            self.wait_egress()
        sandbox = [
            "bwrap",
            "--unshare-pid",
            "--unshare-ipc",
            "--unshare-uts",
            "--hostname",
            hostname,
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
        def _fork_pty():
            pid, terminal = pty.fork()
            if pid == 0:
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
            return pid, terminal

        spawn = getattr(self.host, "spawn", lambda fn: fn())
        self.pid, self.terminal = spawn(_fork_pty)
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
            if preserve and not self.exited():
                for sig_fn in (
                    lambda: os.killpg(self.pid, signal.SIGTERM),
                    lambda: os.kill(self.pid, signal.SIGTERM),
                ):
                    try:
                        sig_fn()
                    except ProcessLookupError:
                        pass
                grace_deadline = time.monotonic() + 1.5
                while time.monotonic() < grace_deadline and not self.exited():
                    time.sleep(0.05)
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
        if self._network_lease is not None:
            lease = self._network_lease
            self._network_lease = None
            self.egress = None
            self.network_lock = None
            self.host.release_slot_network(self.slot, lease)
        else:
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

    def _copy_profile_file(self, src, dst, mode=0o600):
        try:
            fd = os.open(src, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(stream.fileno())
                if (
                    not stat.S_ISREG(info.st_mode)
                    or info.st_uid != self.uid
                    or not 0 < info.st_size <= 4096
                ):
                    return
                raw = stream.read(4097)
            if not 0 < len(raw) <= 4096:
                return
            dst.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            os.chown(dst.parent, self.uid, self.uid)
            dst.write_bytes(raw)
            os.chmod(dst, mode)
            os.chown(dst, self.uid, self.uid)
        except OSError:
            pass

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
        # Preserve the authorized profile's device installation_id & cached project
        # so Google sees the exact same client device rather than a fresh blank install.
        profile_name = self.environment.get("profile")
        if isinstance(profile_name, str) and profile_name:
            src_cli = (
                self.host.directory
                / self.environment["id"]
                / profile_name
                / "home"
                / ".gemini"
                / "antigravity-cli"
            )
            self._copy_profile_file(
                src_cli / "installation_id", settings / "installation_id"
            )
            self._copy_profile_file(
                src_cli / "cache" / "default_project_id.txt",
                settings / "cache" / "default_project_id.txt",
            )
        token = settings / TOKEN_NAME
        token.write_bytes(self.token_bytes)
        os.chown(token, self.uid, self.uid)
        self.token_bytes = None

    def launch_cli(self, argv, size):
        spawn = getattr(self.host, "spawn", lambda fn: fn())
        self.invocation = spawn(
            lambda: invocation_module().Invocation(
                argv + ["--", "/opt/agy", *self.args],
                SYSTEM_ENV,
                self.prompt,
                secrets=self.credentials,
            )
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
        self.max_concurrency = env_concurrency(environment)
        # Unify ALL resident NativeSessions (max_concurrency >= 1) onto managed CRAGGemini pool mode:
        # eliminates openvt VT exhaustion, decouples craggemini from single agy crashes, and enables
        # resident min_warm_slots + live /model switching.
        self.pool_mode = prompt is None
        self.native_dir = None
        self._owns_native_dir = False
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
        candidate = self.directory / "native"
        if len(str(candidate / "kernel.sock").encode("utf-8")) > 96:
            NATIVE_RUNTIME_ROOT.mkdir(mode=0o711, exist_ok=True)
            os.chmod(NATIVE_RUNTIME_ROOT, 0o711)
            check_root_owned(NATIVE_RUNTIME_ROOT)
            self.native_dir = (
                NATIVE_RUNTIME_ROOT / f"s{getattr(self, 'slot', 0)}-{self.attempt[:12]}"
            )
            self._owns_native_dir = True
        else:
            self.native_dir = candidate
            self._owns_native_dir = False
        self.native_dir.mkdir(mode=0o700)
        os.chown(self.native_dir, self.uid, self.uid)
        self.native_token = secrets.token_hex(32)
        license_dir = self.host.ensure_env_license_dir(self.environment)
        native_module_impl = native_module()
        agy_args = [
            "--mode",
            "plan",
            "--dangerously-skip-permissions",
            "--add-dir",
            "/work",
            "--model",
            self.model,
            "--settings",
            json.dumps(NATIVE_CLI_SETTINGS, separators=(",", ":")),
            "--log-file",
            "/tmp/craggemini/" + native_module_impl.ELIGIBILITY_LOG_FILE,
        ]
        kernel_cfg = {
            "run_dir": "/tmp/craggemini",
            "internal_token": self.native_token,
            "session_id": self.attempt,
            "model": self.model,
            "agy_sha256": AGY_SHA256,
            "timeout_ms": 120000,
            "first_byte_timeout_ms": 90000,
            "idle_timeout_ms": 15000,
            "queue_timeout_ms": 1000,
            "max_queue": max(4, self.max_concurrency * 2) if self.pool_mode else 1,
            "vm_id": self.environment["id"],
            "license_dir": "/run/kin/crag-license",
            "host_license_dir": "/run/kin/crag-host",
        }
        if self.pool_mode:
            # Inside vm2agy<slot>, kin-egress enforces kernel-level fail-closed SOCKS5 routing
            # under a separate UID; pass only the proxy_sha256 digest (never raw credentials).
            kernel_cfg.update(
                {
                    "agy_bin": "/opt/agy",
                    "bridge_so": "/opt/libagy_bridge.so",
                    "verify_agy_sha256": True,
                    "require_proxy_calibration": False,
                    "accounts": [
                        {
                            "account_id": self.environment["id"],
                            "env_id": self.environment["id"],
                            "agy_home": "/home/agy",
                            "work_dir": "/work",
                            "run_dir": "/tmp/craggemini/acc",
                            "proxy_id": self.environment["proxy_id"],
                            "proxy_sha256": hashlib.sha256(
                                self.proxy_url.encode()
                            ).hexdigest(),
                            "netns_transparent_egress": True,
                            "max_concurrency": self.max_concurrency,
                            "min_warm_slots": 1,
                            "session_idle_ttl_secs": NATIVE_SESSION_TTL,
                            "model": self.model,
                            "agy_args": agy_args,
                            "oauth_proxy_required": True,
                            "enabled": True,
                        }
                    ],
                }
            )
        config = self.native_dir / "kernel.json"
        private_json(config, kernel_cfg)
        os.chown(config, self.uid, self.uid)
        self.native_diagnostic = native_module_impl.EligibilityDiagnostic(
            self.native_dir, self.uid
        )

        crag_mounts = [
            "--dir",
            "/run",
            "--dir",
            "/run/kin",
            "--dir",
            "/run/kin/crag-license",
            "--bind",
            str(license_dir),
            "/run/kin/crag-license",
        ]
        if self.host.crag_host_dir is not None and self.host.crag_host_dir.is_dir():
            crag_mounts.extend(
                [
                    "--dir",
                    "/run/kin/crag-host",
                    "--ro-bind",
                    str(self.host.crag_host_dir),
                    "/run/kin/crag-host",
                ]
            )
        if self.host.payload_mode == "crag_subscription":
            crag_mounts.extend(
                [
                    "--ro-bind",
                    str(self.host.payload / "craggemini.payload.enc"),
                    "/opt/craggemini.payload.enc",
                    "--ro-bind",
                    str(self.host.payload / "manifest.json"),
                    "/opt/manifest.json",
                    "--ro-bind",
                    str(self.host.payload / "crag-license-public.pem"),
                    "/opt/crag-license-public.pem",
                ]
            )

        argv.extend(
            [
                *crag_mounts,
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
                *agy_args,
            ]
        )
        self.native_exit_reader = native_module_impl.read_launcher_exit
        spawn = getattr(self.host, "spawn", lambda fn: fn())
        if self.pool_mode:
            # Multi-process CRAGGemini pool allocates per-slot PTYs and pidfd execution guards
            # inside the sandbox, so no host Linux virtual console is needed.
            try:
                self.native_tui = spawn(
                    lambda: subprocess.Popen(
                        argv,
                        env=SYSTEM_ENV,
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        start_new_session=True,
                    )
                )
            except OSError:
                raise Failure(503, "gemini_native_worker_unavailable") from None
            self.pid = self.native_tui.pid
            return
        try:
            lock, vt = native_module_impl.query_free_vt(
                self.host.directory / "native-vt.lock"
            )
        except (native_module_impl.NativeFailure, OSError) as error:
            code = getattr(error, "code", "gemini_native_tty_unavailable")
            raise Failure(503, code) from None
        try:
            self.native_tui = spawn(
                lambda: subprocess.Popen(
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
        if self.prompt is not None:
            try:
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
            except native_module_impl.NativeFailure as error:
                raise Failure(503, error.code) from None
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
                        wrapper_kind = "pool" if self.pool_mode else "openvt"
                        print(
                            f"Gemini native wrapper={wrapper_kind} {kind}={abs(wrapper_status)} child_record=missing",
                            file=sys.stderr,
                        )
                    else:
                        wrapper_kind = "pool" if self.pool_mode else "openvt"
                        print(
                            f"Gemini native wrapper={wrapper_kind} status=running_before_cleanup child_record=missing",
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
                    try:
                        if (
                            getattr(self, "_owns_native_dir", False)
                            and self.native_dir is not None
                        ):
                            shutil.rmtree(self.native_dir, ignore_errors=True)
                            self._owns_native_dir = False
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


class NativeSession(NativeAgy):
    """Resident, reusable CRAGGemini native-worker session (unified pool mode)."""

    def __init__(self, host, environment, proxy_url, auth, model):
        super().__init__(host, environment, proxy_url, auth, model, None)
        self.last_used = time.monotonic()
        self._health_failures = 0
        self._ever_ready = False
        self._last_health = None
        self._last_health_at = 0.0

    @property
    def socket_path(self):
        return str(self.native_dir / "kernel.sock")

    def is_alive(self):
        return (
            self.egress is not None
            and self.egress.poll() is None
            and self.native_tui is not None
            and self.native_tui.poll() is None
        )

    def health(self, timeout=0.5):
        if not self.is_alive():
            self._last_health = None
            self._health_failures = NATIVE_HEALTH_FAIL_THRESHOLD
            return None
        status = native_module().worker_status(
            self.socket_path, self.native_token, timeout=timeout
        )
        self._last_health = status
        self._last_health_at = time.monotonic()
        if (
            isinstance(status, dict)
            and status.get("ready") is True
            and status.get("needs_recovery") is not True
        ):
            self._health_failures = 0
            self._ever_ready = True
        else:
            self._health_failures += 1
        return status

    def is_ready(self, *, timeout=0.5):
        status = self.health(timeout=timeout)
        return bool(
            status
            and status.get("ready") is True
            and status.get("needs_recovery") is not True
        )

    def is_severely_unhealthy(self):
        if not self.is_alive():
            return True
        if isinstance(self._last_health, dict):
            if self._last_health.get("needs_recovery") is True:
                return True
            if self._last_health.get("ok") is False:
                return True
        return self._health_failures >= NATIVE_HEALTH_FAIL_THRESHOLD

    def open_stream(self, request_id, body_obj, *, model=None, gateway_policy=None):
        if not self.is_alive():
            raise native_module().NativeFailure("gemini_native_worker_unavailable", 503)
        effective_model = model or self.model
        return native_module().open_worker_stream(
            self.socket_path,
            self.native_token,
            effective_model,
            request_id,
            body_obj,
            startup_timeout=45,
            gateway_policy=gateway_policy,
        )

    def cancel_turn(self, request_id):
        try:
            return native_module().cancel_worker_request(
                self.socket_path, self.native_token, request_id
            )
        except OSError:
            return False


class ResidentTestChatRun:
    """Runs a panel test-chat turn directly on the resident NativeSession without restarting it."""

    def __init__(self, session, model, prompt, credentials):
        self.session = session
        self.model = model
        self._request_id = f"test-{secrets.token_hex(12)}"
        self._done = False
        self._invocation = native_module().NativeInvocation(
            {
                "socket": session.socket_path,
                "token": session.native_token,
                "model": model,
                "request_id": self._request_id,
                "prompt": prompt,
            },
            secrets=credentials,
        )

    def poll(self):
        diagnostic = (
            self.session.native_diagnostic.poll()
            if self.session.native_diagnostic is not None
            else None
        )
        if diagnostic is not None:
            self._done = True
            return {"state": "failed", "text": "", "error": {"code": diagnostic}}
        result = self._invocation.poll()
        if result["state"] != "running":
            self._done = True
            self.session.last_used = time.monotonic()
            if result["state"] == "failed" and self.session.native_diagnostic is not None:
                final_diag = self.session.native_diagnostic.poll(final=True)
                if final_diag is not None:
                    return {"state": "failed", "text": "", "error": {"code": final_diag}}
            return result
        if not self.session.is_alive():
            self._done = True
            return {
                "state": "failed",
                "text": "",
                "error": {"code": "gemini_native_worker_unavailable"},
            }
        return result

    def close(self):
        try:
            if not self._done:
                self.session.cancel_turn(self._request_id)
        finally:
            if self._invocation is not None:
                self._invocation.close()
                self._invocation = None


class Login(Agy):
    def __init__(self, host, environment, proxy_url):
        self.deadline = time.monotonic() + AUTH_TTL
        self.sent = False
        self.state = None
        self.buffer = b""
        self.token_seen_at = None
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

    def _project_cache_ready(self):
        cache_file = (
            self.directory
            / "home"
            / ".gemini"
            / "antigravity-cli"
            / "cache"
            / "default_project_id.txt"
        )
        try:
            fd = os.open(cache_file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_uid != self.uid:
                    return False
                return bool(stream.read(256).strip())
        except OSError:
            return False

    def finished(self):
        if self.sent and profile_secrets(self.directory, self.uid):
            now_mono = time.monotonic()
            if self.token_seen_at is None:
                self.token_seen_at = now_mono
            try:
                self.read(0)
            except Failure:
                return True
            elapsed = now_mono - self.token_seen_at
            # Let agy finish its official post-login initialization sequence
            # (loadCodeAssist, fetchAvailableModels, FetchConfig/experiments, cache flush)
            # before gracefully terminating it. Never cut it off on .config/antigravity,
            # which agy already creates before OAuth login starts.
            if (
                not self.alive()
                or elapsed >= AUTH_SETTLE_SECONDS
                or (elapsed >= AUTH_MIN_SETTLE_SECONDS and self._project_cache_ready())
            ):
                return True
            return False
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
        self.payload_mode = "legacy_release"
        self.payload_issue = None
        self.crag_host_dir = getattr(args, "crag_host_dir", None)
        self.egress = args.egress
        self.uid_base = args.uid_base
        self.egress_uid = args.uid_base + MAX_ENVIRONMENTS
        self.state_file = self.directory / "environments.json"
        self.lock = threading.RLock()
        self._spawner = _Spawner()
        self.pending = {}
        self.terminals = {}
        self.runs = {}
        self.native_sessions = {}
        self._session_locks = {}
        self._slot_networks = {}
        self._network_lease_lock = threading.Lock()
        self._runtime_proxies = {}
        self._warm_backoff = {}
        self._warming = set()
        self.active_infers = {}
        self.last_inference = {}
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
                    if (
                        stale.name != profile
                        and (
                            ATTEMPT.fullmatch(name)
                            or re.fullmatch(r"\.net-[a-f0-9]{16}", stale.name)
                        )
                    ):
                        check_root_owned(stale)
                        if stale.is_dir():
                            shutil.rmtree(stale)
        if changed:
            self.save()
        if NATIVE_RUNTIME_ROOT.exists():
            try:
                check_root_owned(NATIVE_RUNTIME_ROOT)
                os.chmod(NATIVE_RUNTIME_ROOT, 0o711)
                for stale in NATIVE_RUNTIME_ROOT.iterdir():
                    if stale.is_dir() and re.fullmatch(r"s[0-9]+-[a-f0-9]{8,16}", stale.name):
                        shutil.rmtree(stale, ignore_errors=True)
            except (OSError, RuntimeError):
                pass
        self.inspect_payload()

    def spawn(self, fn):
        return self._spawner.call(fn)

    @staticmethod
    def is_crag_encrypted_payload(source):
        try:
            raw = read_root_file(source / "manifest.json", 65536)
            manifest = json.loads(raw)
        except (OSError, RuntimeError, ValueError):
            return False
        auth = manifest.get("authorization") if isinstance(manifest, dict) else None
        return (
            isinstance(manifest, dict)
            and manifest.get("family") == "crag"
            and manifest.get("encrypted") is True
            and isinstance(auth, dict)
            and auth.get("product") == "craggemini"
        )

    def verify_payload(self, source, public_key, install=False):
        check_root_owned(source)
        check_root_owned(public_key)
        members = (
            CRAG_PAYLOAD_FILES
            if self.is_crag_encrypted_payload(source)
            else PAYLOAD_FILES
        )
        for name in members:
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
        encrypted = self.is_crag_encrypted_payload(source)
        members = CRAG_PAYLOAD_FILES if encrypted else PAYLOAD_FILES
        if any(not (source / name).is_file() for name in members):
            raise Failure(503, "gemini_payload_incomplete")
        if installed and any(
            not os.access(source / name, os.X_OK) for name in ("agy", "craggemini")
        ):
            raise Failure(503, "gemini_payload_incomplete")
        digest = hashlib.sha256(
            read_root_file(source / "manifest.json", 65536 if encrypted else 8192)
        ).hexdigest()
        if encrypted:
            public_key = (
                self.public_key
                if self.public_key.is_file()
                else source / "crag-license-public.pem"
            )
            if not public_key.is_file():
                raise Failure(503, "gemini_public_key_missing")
            check_root_owned(public_key)
            self._payload_mode = "crag_subscription"
            return source, installed, public_key, None, digest
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
        self._payload_mode = "legacy_release"
        return source, installed, public_key, verifier, digest

    def payload_identity(self, source, public_key, digest):
        members = (
            CRAG_PAYLOAD_FILES
            if self.is_crag_encrypted_payload(source)
            else PAYLOAD_FILES
        )
        # Hash large binaries only on first use or when a trusted input changes.
        files = (public_key, source, *(source / name for name in members))
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
            self._payload_mode = "legacy_release"
            source, installed, public_key, verifier, digest = self.payload_config()
            mode = self._payload_mode
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
                            read_root_file(
                                self.payload / "manifest.json",
                                65536 if mode == "crag_subscription" else 8192,
                            )
                        ).hexdigest()
                        if target_digest != digest:
                            raise RuntimeError(
                                "Gemini manifest changed during installation"
                            )
                        identity = self.payload_identity(
                            self.payload, public_key, digest
                        )
                    elif (
                        self.payload_identity(source, public_key, digest) != identity
                    ):
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
            self.payload_mode = mode
            self.set_payload_version(version)
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
        self.set_payload_version(None)
        self.verified_payload = None

    def set_payload_version(self, version):
        if version != self.payload_version:
            self.last_inference.clear()
            self.payload_version = version

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
            self._schedule_warm_locked(identifier, force=True)

    def acquire_slot_network(
        self, slot, env_dir, network, proxy_id, proxy_url, proxy_hash, launch_args_fn
    ):
        lease_lock = getattr(self, "_network_lease_lock", None)
        if lease_lock is None:
            lease_lock = threading.Lock()
            self._network_lease_lock = lease_lock
        leases = getattr(self, "_slot_networks", None)
        if leases is None:
            leases = {}
            self._slot_networks = leases
        with lease_lock:
            existing = leases.get(slot)
            if existing is not None:
                if (
                    existing["egress"].poll() is None
                    and secrets.compare_digest(existing["proxy_hash"], proxy_hash)
                ):
                    existing["refcount"] += 1
                    return existing
                if existing["refcount"] <= 0:
                    leases.pop(slot, None)
                    self._teardown_slot_network_lease(existing)
                else:
                    raise Failure(503)
            lease_dir = env_dir / f".net-{secrets.token_hex(8)}"
            lease_dir.mkdir(mode=0o711)
            lease_dir.chmod(0o711)
            env_dir.chmod(0o711)
            lock = None
            egress = None
            try:
                config = lease_dir / "egress.json"
                private_json(
                    config,
                    {
                        "proxy_id": proxy_id,
                        "proxy_url": proxy_url,
                        "listen_tcp": "127.0.0.1:1080",
                        "listen_dns": "127.0.0.1:1053",
                    },
                )
                os.chown(config, self.egress_uid, self.egress_uid)
                lock = self.start_network(lease_dir, network)
                subprocess.run(
                    launch_args_fn(self.egress_uid)
                    + [
                        sys.executable,
                        "-I",
                        "-c",
                        "import socket,sys; socket.create_connection((sys.argv[1], int(sys.argv[2])), 2).close()",
                        *network[2:],
                    ],
                    check=True,
                    timeout=3,
                    env=SYSTEM_ENV,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                spawn = getattr(self, "spawn", lambda fn: fn())
                egress = spawn(
                    lambda: subprocess.Popen(
                        launch_args_fn(self.egress_uid)
                        + [
                            sys.executable,
                            "-I",
                            "-c",
                            EGRESS_EXEC,
                            str(os.getpid()),
                            str(self.egress),
                            "--config",
                            str(config),
                        ],
                        env=SYSTEM_ENV,
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                )
                deadline = time.monotonic() + 3
                probe = launch_args_fn(self.egress_uid) + [
                    sys.executable,
                    "-I",
                    "-c",
                    EGRESS_READY,
                    str(self.egress_uid),
                ]
                while egress.poll() is None and time.monotonic() < deadline:
                    result = subprocess.run(
                        probe,
                        timeout=1,
                        env=SYSTEM_ENV,
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                    if result.returncode == 0 and egress.poll() is None:
                        break
                    time.sleep(0.05)
                else:
                    raise Failure(503)
                lease = {
                    "slot": slot,
                    "directory": lease_dir,
                    "network": list(network),
                    "proxy_hash": proxy_hash,
                    "lock": lock,
                    "egress": egress,
                    "refcount": 1,
                }
                leases[slot] = lease
                return lease
            except BaseException:
                if egress is not None:
                    if egress.poll() is None:
                        egress.kill()
                    try:
                        egress.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        pass
                if lock is not None:
                    try:
                        self.stop_network(lease_dir, network, lock)
                    finally:
                        os.close(lock)
                shutil.rmtree(lease_dir, ignore_errors=True)
                raise

    def release_slot_network(self, slot, lease):
        if lease is None:
            return
        lease_lock = getattr(self, "_network_lease_lock", None)
        leases = getattr(self, "_slot_networks", None)
        if lease_lock is None or leases is None:
            self._teardown_slot_network_lease(lease)
            return
        with lease_lock:
            lease["refcount"] -= 1
            if lease["refcount"] > 0:
                return
            if leases.get(slot) is lease:
                leases.pop(slot, None)
        self._teardown_slot_network_lease(lease)

    def _teardown_slot_network_lease(self, lease):
        egress = lease.get("egress")
        if egress is not None:
            if egress.poll() is None:
                egress.kill()
            try:
                egress.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            lease["egress"] = None
        lock = lease.get("lock")
        if lock is not None:
            try:
                self.stop_network(lease["directory"], lease["network"], lock)
            finally:
                os.close(lock)
                lease["lock"] = None
        lease_dir = lease.get("directory")
        if lease_dir is not None:
            shutil.rmtree(lease_dir, ignore_errors=True)

    def _remember_runtime_proxy(self, env, proxy_url):
        if not env or not isinstance(proxy_url, str) or not proxy_url:
            return
        proxies = getattr(self, "_runtime_proxies", None)
        if proxies is None:
            proxies = {}
            self._runtime_proxies = proxies
        proxies[env["id"]] = (
            env["proxy_id"],
            proxy_url,
            hashlib.sha256(proxy_url.encode()).digest(),
        )

    def _clear_runtime_proxy(self, identifier):
        proxies = getattr(self, "_runtime_proxies", None)
        if proxies is not None:
            proxies.pop(identifier, None)
        backoff = getattr(self, "_warm_backoff", None)
        if backoff is not None:
            backoff.pop(identifier, None)

    def _can_keep_resident(self, env):
        if not env or env.get("auth_method", "oauth") != "oauth":
            return False
        if env.get("auth_state") != "authorized" or env.get("oauth_imported"):
            return False
        if not env.get("profile"):
            return False
        identifier = env["id"]
        if identifier in self.terminals or identifier in self.pending:
            return False
        if getattr(self, "payload_state", None) != "installed" or self.oauth_runtime_issue() is not None:
            return False
        if self.payload_mode == "crag_subscription":
            candidate = self.license_release_candidate(env)
            if not candidate.get("permit_sha256"):
                return False
        return True

    @staticmethod
    def _initial_session_model(env, requested_model=None):
        if isinstance(requested_model, str) and MODEL.fullmatch(requested_model):
            return requested_model
        for candidate in env.get("call_models") or ():
            if isinstance(candidate, str) and MODEL.fullmatch(candidate):
                return candidate
        return NATIVE_DEFAULT_MODEL

    def _schedule_warm_locked(self, identifier, model=None, force=False):
        env = self.environments.get(identifier)
        if not self._can_keep_resident(env):
            return False
        proxies = getattr(self, "_runtime_proxies", {})
        cached = proxies.get(identifier)
        if not cached or cached[0] != env["proxy_id"]:
            return False
        _, _, proxy_hash = cached
        existing = self.native_sessions.get(identifier)
        if (
            existing is not None
            and getattr(existing, "max_concurrency", 1) == env_concurrency(env)
            and secrets.compare_digest(existing.proxy_hash, proxy_hash)
            and existing.is_alive()
            and not existing.is_severely_unhealthy()
        ):
            return False
        warming = getattr(self, "_warming", None)
        if warming is None:
            warming = set()
            self._warming = warming
        if identifier in warming:
            return False
        backoff = getattr(self, "_warm_backoff", None)
        if backoff is None:
            backoff = {}
            self._warm_backoff = backoff
        if not force:
            entry = backoff.get(identifier)
            if entry and time.monotonic() < entry[1]:
                return False
        warming.add(identifier)
        worker = threading.Thread(
            target=self._warm_worker,
            args=(identifier, model),
            name=f"gemini-warm-{identifier[-8:]}",
            daemon=True,
        )
        worker.start()
        return True

    def _record_warm_failure_locked(self, identifier):
        backoff = getattr(self, "_warm_backoff", None)
        if backoff is None:
            backoff = {}
            self._warm_backoff = backoff
        fails = backoff.get(identifier, (0, 0.0))[0] + 1
        delay = min(
            NATIVE_WARM_BACKOFF_MAX,
            NATIVE_WARM_BACKOFF_MIN * (2 ** min(fails - 1, 5)),
        )
        backoff[identifier] = (fails, time.monotonic() + delay)
        return fails, delay

    def _schedule_reauth_check_locked(self, identifier):
        env = self.environments.get(identifier)
        if (
            not env
            or env.get("auth_method", "oauth") != "oauth"
            or env.get("oauth_imported")
            or env.get("auth_state") != "authorized"
            or not env.get("profile")
        ):
            return False
        cached = getattr(self, "_runtime_proxies", {}).get(identifier)
        if not cached or cached[0] != env["proxy_id"]:
            return False
        proxy_url = cached[1]
        health = self._profile_credential_health(env, skew_seconds=0)
        if not health or health.get("state") not in (
            "expired_refreshable",
            "expired",
            "missing",
        ):
            return False
        checking = getattr(self, "_reauth_checking", None)
        if checking is None:
            checking = set()
            self._reauth_checking = checking
        if identifier in checking:
            return False
        cooldowns = getattr(self, "_reauth_check_next_at", None)
        if cooldowns is None:
            cooldowns = {}
            self._reauth_check_next_at = cooldowns
        now_mono = time.monotonic()
        if now_mono < cooldowns.get(identifier, 0.0):
            return False
        checking.add(identifier)
        cooldowns[identifier] = now_mono + 120.0

        def _worker():
            try:
                with self.lock:
                    cur = self.environments.get(identifier)
                    if cur and cur.get("auth_state") == "authorized":
                        self.refresh_account(cur, proxy_url, auto_pull_models=False)
            except BaseException:
                pass
            finally:
                with self.lock:
                    getattr(self, "_reauth_checking", set()).discard(identifier)

        threading.Thread(
            target=_worker, name=f"gemini-reauth-{identifier[-8:]}", daemon=True
        ).start()
        return True

    def _warm_worker(self, identifier, model=None):
        try:
            with self._session_lock(identifier):
                with self.lock:
                    env = self.environments.get(identifier)
                    if not self._can_keep_resident(env):
                        return
                    cached = getattr(self, "_runtime_proxies", {}).get(identifier)
                    if not cached or cached[0] != env["proxy_id"]:
                        return
                    proxy_id, proxy_url, proxy_hash = cached
                    existing = self.native_sessions.get(identifier)
                    desired_concurrency = env_concurrency(env)
                    if (
                        existing is not None
                        and getattr(existing, "max_concurrency", 1) == desired_concurrency
                        and secrets.compare_digest(existing.proxy_hash, proxy_hash)
                        and existing.is_alive()
                        and not existing.is_severely_unhealthy()
                    ):
                        return
                    uid = self.uid_base + env["slot"]
                    profile = env.get("profile")
                    auth = profile and profile_secrets(
                        self.directory / identifier / profile, uid, include_raw=True
                    )
                    if not auth:
                        return
                    env_snapshot = dict(env)
                    initial_model = self._initial_session_model(env_snapshot, model)
                    if existing is not None and not self.active_infers.get(identifier):
                        self.stop_native_session(identifier)
                session = NativeSession(
                    self, env_snapshot, proxy_url, auth, initial_model
                )
                keep = False
                try:
                    with self.lock:
                        current_env = self.environments.get(identifier)
                        current_cached = getattr(self, "_runtime_proxies", {}).get(identifier)
                        already = self.native_sessions.get(identifier)
                        if (
                            current_env is not None
                            and self._can_keep_resident(current_env)
                            and current_env["proxy_id"] == proxy_id
                            and current_cached is not None
                            and secrets.compare_digest(current_cached[2], proxy_hash)
                            and env_concurrency(current_env) == desired_concurrency
                            and (already is None or not already.is_alive())
                        ):
                            if already is not None:
                                self.stop_native_session(identifier)
                            self.native_sessions[identifier] = session
                            keep = True
                finally:
                    if not keep:
                        session.close()
        except BaseException:
            with self.lock:
                self._record_warm_failure_locked(identifier)
        finally:
            with self.lock:
                getattr(self, "_warming", set()).discard(identifier)

    def _schedule_provision_locked(self, identifier, proxy_url):
        env = self.environments.get(identifier)
        if (
            not env
            or env.get("auth_method", "oauth") != "oauth"
            or env.get("oauth_imported")
            or env.get("auth_state") != "authorized"
            or not env.get("profile")
            or self.egress is None
            or self.oauth_runtime_issue() is not None
        ):
            return False
        has_models = bool(env.get("call_models"))
        has_plan = isinstance(env.get("account"), dict) and bool(env["account"].get("plan"))
        if has_models and has_plan:
            return False
        provisioning = getattr(self, "_provisioning", None)
        if provisioning is None:
            provisioning = set()
            self._provisioning = provisioning
        if identifier in provisioning:
            return False
        cooldowns = getattr(self, "_provision_next_at", None)
        if cooldowns is None:
            cooldowns = {}
            self._provision_next_at = cooldowns
        now = time.monotonic()
        if now < cooldowns.get(identifier, 0.0):
            return False
        provisioning.add(identifier)
        cooldowns[identifier] = now + (300.0 if has_models else 60.0)
        worker = threading.Thread(
            target=self._provision_worker,
            args=(identifier, proxy_url),
            name=f"gemini-prov-{identifier[-8:]}",
            daemon=True,
        )
        worker.start()
        return True

    def _provision_worker(self, identifier, proxy_url):
        try:
            with self.lock:
                env = self.environments.get(identifier)
                if (
                    not env
                    or env.get("auth_method", "oauth") != "oauth"
                    or env.get("oauth_imported")
                    or env.get("auth_state") != "authorized"
                    or not env.get("profile")
                ):
                    return
                if env.get("call_models") and isinstance(env.get("account"), dict) and env["account"].get("plan"):
                    return
                self._post_auth_provision(env, proxy_url)
        except BaseException:
            pass
        finally:
            with self.lock:
                getattr(self, "_provisioning", set()).discard(identifier)

    def warm_environment(self, env, proxy_url, model=None):
        identifier = env["id"]
        self._remember_runtime_proxy(env, proxy_url)
        self._schedule_provision_locked(identifier, proxy_url)
        proxy_hash = hashlib.sha256(proxy_url.encode()).digest()
        existing = self.native_sessions.get(identifier)
        if existing is not None:
            same_binding = (
                getattr(existing, "max_concurrency", 1) == env_concurrency(env)
                and secrets.compare_digest(existing.proxy_hash, proxy_hash)
            )
            if not same_binding and not self.active_infers.get(identifier):
                self.stop_native_session(identifier)
                existing = None
            elif same_binding and existing.is_alive() and not existing.is_severely_unhealthy():
                ready = bool(existing.is_ready(timeout=0.5))
                return {"warmed": ready, "runtime_ready": ready, "warming": not ready}
        scheduled = self._schedule_warm_locked(identifier, model=model, force=True)
        return {
            "warmed": False,
            "runtime_ready": False,
            "warming": scheduled or (identifier in getattr(self, "_warming", set())),
        }

    def inference_binding(self, env):
        return (
            env["proxy_id"],
            env.get("profile"),
            env.get("auth_method", "oauth"),
            env.get("oauth_imported", False),
            env["auth_state"],
            env.get("updated_at"),
            self.payload_version,
        )

    def last_inference_view(self, env):
        entry = self.last_inference.get(env["id"])
        if entry and entry[0] == self.inference_binding(env):
            return {
                "last_inference": entry[1].copy(),
                "last_inference_proxy_sha256": entry[2],
            }
        return {"last_inference": None}

    @staticmethod
    def finish_inference(evidence, state, code=None):
        if state == "failed" and code == "gemini_inference_cancelled":
            state = "cancelled"
        evidence.update(
            state=state,
            finished_at=now(),
            error_code=(
                code
                if isinstance(code, str) and code in INFERENCE_ERROR_CODES
                else None
            ),
        )

    def touch_environment(self, env):
        # Explicit invalidation also handles multiple mutations in one second.
        self.last_inference.pop(env["id"], None)
        env["updated_at"] = now()

    def _session_lock(self, identifier):
        with self.lock:
            locks = getattr(self, "_session_locks", None)
            if locks is None:
                locks = {}
                self._session_locks = locks
            lock = locks.get(identifier)
            if lock is None:
                lock = threading.Lock()
                locks[identifier] = lock
            return lock

    def stop_native_session(self, identifier):
        session = self.native_sessions.pop(identifier, None)
        if session is not None:
            session.close()

    def cancel_infer(self, identifier, request_id=None):
        slots = self.active_infers.get(identifier)
        if not slots:
            return False
        if request_id is not None:
            entry = slots.get(request_id)
            if not entry:
                return False
            targets = [entry]
        else:
            targets = list(slots.values())
        for entry in targets:
            entry["cancel_event"].set()
            cancel_fn = entry.get("cancel_fn")
            if callable(cancel_fn):
                try:
                    cancel_fn()
                except Exception:
                    pass
        return bool(targets)

    def stop_run(self, identifier):
        entry = self.runs.pop(identifier, None)
        if entry and entry["process"] is not None:
            self.finish_inference(
                entry["evidence"], "cancelled", "gemini_inference_cancelled"
            )
            entry["process"].close()

    def running(self, identifier):
        if self.active_infers.get(identifier):
            return True
        entry = self.runs.get(identifier)
        return bool(entry and entry["process"] is not None)

    def update_run(self, entry):
        if entry["process"] is None:
            return entry["result"]
        result = entry["process"].poll()
        if result["state"] != "running" or time.monotonic() >= entry["deadline"]:
            result = (
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
            error = result.get("error") if result["state"] == "failed" else None
            self.finish_inference(
                entry["evidence"],
                result["state"],
                error.get("code") if isinstance(error, dict) else None,
            )
            entry["process"].close()
            entry["process"] = None
            entry["result"] = result
            entry["deadline"] = time.monotonic() + RUN_TTL
            return entry["result"]
        return result

    def operation_account(
        self, env, *, allow_concurrent_infer=False, allow_reauth_probe=False
    ):
        self.ensure_payload(legacy_install=False)
        allowed_states = (
            ("authorized", "reauth_required")
            if allow_reauth_probe
            else ("authorized",)
        )
        if env["auth_state"] not in allowed_states:
            code = (
                "gemini_api_key_invalid"
                if env.get("auth_method") == "api_key"
                else "gemini_oauth_required"
            )
            raise Failure(409, code)
        identifier = env["id"]
        run_entry = self.runs.get(identifier)
        run_active = bool(run_entry and run_entry["process"] is not None)
        active_slots = len(self.active_infers.get(identifier, {}))
        infer_busy = (
            active_slots >= env_concurrency(env)
            if allow_concurrent_infer
            else active_slots > 0
        )
        if (
            run_active
            or infer_busy
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

    def _sync_profile_token(self, env, run):
        profile_name = env.get("profile")
        if not profile_name or env.get("auth_method", "oauth") != "oauth":
            return False
        uid = self.uid_base + env["slot"]
        updated = profile_secrets(run.directory, uid, include_raw=True)
        if not updated:
            return False
        _, new_bytes = updated
        profile_dir = self.directory / env["id"] / profile_name
        current = profile_secrets(profile_dir, uid, include_raw=True)
        if current and current[1] == new_bytes:
            return False
        token_dir = profile_dir / "home" / ".gemini" / "antigravity-cli"
        target = token_dir / TOKEN_NAME
        staging = token_dir / f".{TOKEN_NAME}.{secrets.token_hex(8)}"
        try:
            with os.fdopen(
                os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb"
            ) as out:
                out.write(new_bytes)
                out.flush()
                os.fsync(out.fileno())
            os.chown(staging, uid, uid)
            os.chmod(staging, 0o600)
            staging.replace(target)
            return True
        except OSError:
            return False
        finally:
            staging.unlink(missing_ok=True)

    def _profile_credential_health(self, env, *, skew_seconds=300):
        profile_name = env.get("profile")
        if not profile_name or env.get("auth_method", "oauth") != "oauth":
            return None
        uid = self.uid_base + env["slot"]
        loaded = profile_secrets(
            self.directory / env["id"] / profile_name, uid, include_raw=True
        )
        if not loaded:
            return {
                "present": False,
                "state": "missing",
                "has_access": False,
                "has_refresh": False,
                "needs_refresh": True,
                "expires_at": None,
            }
        try:
            data = json.loads(loaded[1])
        except (ValueError, UnicodeDecodeError):
            return {
                "present": False,
                "state": "missing",
                "has_access": False,
                "has_refresh": False,
                "needs_refresh": True,
                "expires_at": None,
            }
        token = data.get("token") if isinstance(data, dict) and isinstance(data.get("token"), dict) else data
        if not isinstance(token, dict):
            return {
                "present": False,
                "state": "missing",
                "has_access": False,
                "has_refresh": False,
                "needs_refresh": True,
                "expires_at": None,
            }
        access = token.get("access_token") or token.get("accessToken")
        refresh = token.get("refresh_token") or token.get("refreshToken")
        has_access = isinstance(access, str) and bool(access.strip())
        has_refresh = isinstance(refresh, str) and bool(refresh.strip())
        expiry = token.get("expiry") or token.get("expires_at") or token.get("expiresAt")
        expires_at_ts = None
        if isinstance(expiry, (int, float)) and expiry > 0:
            expires_at_ts = expiry / 1000.0 if expiry >= 10_000_000_000 else float(expiry)
        elif isinstance(expiry, str) and expiry.strip():
            normalized = re.sub(r"\.[0-9]+", "", expiry.strip())
            if normalized.endswith("Z"):
                normalized = normalized[:-1] + "+00:00"
            try:
                parsed = datetime.fromisoformat(normalized)
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                expires_at_ts = parsed.timestamp()
            except ValueError:
                expires_at_ts = None
        now_ts = time.time()
        if not has_access:
            state = "refreshable" if has_refresh else "missing"
            needs_refresh = True
        elif expires_at_ts is not None and expires_at_ts <= now_ts:
            state = "expired_refreshable" if has_refresh else "expired"
            needs_refresh = True
        elif expires_at_ts is not None and expires_at_ts <= now_ts + skew_seconds:
            state = "refresh_window"
            needs_refresh = True
        else:
            state = "fresh"
            needs_refresh = False
        return {
            "present": True,
            "state": state,
            "has_access": has_access,
            "has_refresh": has_refresh,
            "needs_refresh": needs_refresh,
            "expires_at": int(expires_at_ts * 1000) if expires_at_ts is not None else None,
        }

    def _profile_token_state(self, env):
        health = self._profile_credential_health(env, skew_seconds=300)
        if not health or not health.get("present"):
            return False, False
        return bool(health.get("has_refresh")), bool(health.get("needs_refresh"))

    def pull_models(self, env, proxy_url, *, allow_reauth_probe=False):
        uid, key, auth = self.operation_account(
            env, allow_reauth_probe=allow_reauth_probe
        )
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
                self._sync_profile_token(env, run)
                run.close()
        if not models:
            raise Failure(502, "gemini_models_empty")
        self.save_environment(env, {**env, "call_models": models, "updated_at": now()})
        return self.view(env)

    def _start_oauth_test_chat(self, env, proxy_url, auth, model, prompt):
        identifier = env["id"]
        proxy_hash = hashlib.sha256(proxy_url.encode()).digest()
        desired_concurrency = env_concurrency(env)
        existing = self.native_sessions.get(identifier)
        if (
            existing is not None
            and getattr(existing, "max_concurrency", 1) == desired_concurrency
            and secrets.compare_digest(existing.proxy_hash, proxy_hash)
            and existing.is_alive()
            and not existing.is_severely_unhealthy()
        ):
            session = existing
        else:
            if existing is not None:
                self.stop_native_session(identifier)
            session = NativeSession(self, env, proxy_url, auth, model)
            self.native_sessions[identifier] = session
        session.last_used = time.monotonic()
        return ResidentTestChatRun(session, model, prompt, auth[0])

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
        self._remember_runtime_proxy(env, proxy_url)
        self.stop_run(identifier)
        evidence = {
            "state": "running",
            "model": model,
            "started_at": now(),
            "finished_at": None,
            "error_code": None,
        }
        # Runs may outlive a binding change. Updating their own evidence object
        # must not put an invalidated record back into inventory.
        # Keep the proxy identity on the trusted control socket only. A proxy
        # pool edit can change the endpoint or credentials without a new ID.
        self.last_inference[identifier] = (
            self.inference_binding(env),
            evidence,
            hashlib.sha256(proxy_url.encode()).hexdigest(),
        )
        try:
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
                process = self._start_oauth_test_chat(env, proxy_url, auth, model, prompt)
        except Failure as error:
            self.finish_inference(
                evidence, "failed", error.code or "gemini_inference_start_failed"
            )
            raise
        except (OSError, subprocess.SubprocessError, ValueError, RuntimeError):
            self.finish_inference(evidence, "failed", "gemini_inference_start_failed")
            raise
        run_id = secrets.token_hex(16)
        self.runs[identifier] = {
            "id": run_id,
            "process": process,
            "evidence": evidence,
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
        self.last_inference.pop(env["id"], None)
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
            self.stop_native_session(identifier)
            self._clear_runtime_proxy(identifier)
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
        self._remember_runtime_proxy(env, proxy_url)
        self.stop_native_session(identifier)
        try:
            issue = self.oauth_runtime_issue()
            if issue:
                raise Failure(503, issue)
            self.terminals[identifier] = Terminal(
                self, env, proxy_url, profile, size, session_id, credentials
            )
        except Failure as error:
            if error.code == TERMINAL_OAUTH:
                env["auth_state"] = "reauth_required"
                self.touch_environment(env)
                self.save()
                raise
            raise Failure(503, "gemini_terminal_unavailable") from error
        except (OSError, subprocess.SubprocessError) as error:
            raise Failure(503, "gemini_terminal_unavailable") from error
        return {"ok": True}

    def close(self):
        failed = False
        with self.lock:
            for identifier in list(self.active_infers):
                self.cancel_infer(identifier)
            for stop, active in (
                (self.stop_run, self.runs),
                (self.stop_native_session, self.native_sessions),
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
        with self.lock:
            self._cleanup_locked()

    def _cleanup_locked(self):
        now_mono = time.monotonic()
        for identifier, session in list(self.native_sessions.items()):
            if self.active_infers.get(identifier):
                continue
            run_entry = self.runs.get(identifier)
            if run_entry and run_entry["process"] is not None:
                continue
            if not session.is_alive():
                ever_ready = bool(getattr(session, "_ever_ready", False))
                self.stop_native_session(identifier)
                if not ever_ready:
                    self._record_warm_failure_locked(identifier)
                    self._schedule_reauth_check_locked(identifier)
                self._schedule_warm_locked(identifier)
                continue
            last_probe = getattr(session, "_last_health_at", 0.0)
            if now_mono - last_probe >= NATIVE_HEALTH_POLL_INTERVAL:
                status = session.health(timeout=0.5)
                if (
                    isinstance(status, dict)
                    and status.get("ready") is True
                    and status.get("needs_recovery") is not True
                ):
                    getattr(self, "_warm_backoff", {}).pop(identifier, None)
                if session.is_severely_unhealthy():
                    ever_ready = bool(getattr(session, "_ever_ready", False))
                    self.stop_native_session(identifier)
                    if not ever_ready:
                        self._record_warm_failure_locked(identifier)
                        self._schedule_reauth_check_locked(identifier)
                    self._schedule_warm_locked(identifier)
        for identifier, entry in list(self.runs.items()):
            if entry["process"] is None and time.monotonic() >= entry["deadline"]:
                self.stop_run(identifier)
            else:
                self.update_run(entry)
        if self.terminals or self.pending or self.runs or self.native_sessions:
            try:
                self.ensure_payload(legacy_install=False)
            except Failure:
                for identifier in list(self.active_infers):
                    self.cancel_infer(identifier)
                for identifier in list(self.runs):
                    self.stop_run(identifier)
                for identifier in list(self.native_sessions):
                    self.stop_native_session(identifier)
                for identifier in list(self.terminals):
                    self.stop_terminal(identifier)
                for identifier in list(self.pending):
                    self.cancel(identifier)
                    env = self.environments[identifier]
                    env["auth_state"] = "reauth_required"
                    self.touch_environment(env)
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
            completed_proxy_url = None
            try:
                if time.monotonic() > login.deadline:
                    raise Failure(409)
                if not login.finished():
                    continue
                old_profile = env.get("profile")
                imported = env.pop("oauth_imported", False)
                completed_proxy_url = login.proxy_url
                login.close(preserve=True)
                env.update(auth_state="authorized", profile=login.attempt)
                self.touch_environment(env)
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
                self._remember_runtime_proxy(env, login.proxy_url)
            except Failure:
                self.cancel(identifier)
                env["auth_state"] = "reauth_required"
                self.touch_environment(env)
                self.save()
                continue
            if completed_proxy_url:
                self._post_auth_provision(env, completed_proxy_url)
                self._schedule_warm_locked(identifier, force=True)
        for identifier in list(self.environments):
            if identifier not in self.native_sessions:
                self._schedule_warm_locked(identifier)

    def _post_auth_provision(self, env, proxy_url):
        if (
            env.get("auth_method", "oauth") == "oauth"
            and not env.get("oauth_imported")
            and self.egress is not None
            and self.oauth_runtime_issue() is None
        ):
            try:
                self.pull_models(env, proxy_url)
            except (
                Failure,
                OSError,
                subprocess.SubprocessError,
                ValueError,
                RuntimeError,
            ):
                pass
        try:
            self.refresh_account(env, proxy_url, auto_pull_models=False)
        except (
            Failure,
            OSError,
            subprocess.SubprocessError,
            ValueError,
            RuntimeError,
        ):
            pass

    def ensure_env_machine_id(self, env):
        env_dir = self.directory / env["id"]
        env_dir.mkdir(mode=0o711, exist_ok=True)
        env_dir.chmod(0o711)
        target = env_dir / "machine-id"
        if target.exists():
            info = target.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise Failure(503, "license_invalid")
            return target
        staging = env_dir / f".machine-id.{secrets.token_hex(8)}"
        try:
            with os.fdopen(
                os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644), "w"
            ) as out:
                out.write(secrets.token_hex(16) + "\n")
                out.flush()
                os.fsync(out.fileno())
            os.chmod(staging, 0o644)
            staging.replace(target)
        finally:
            staging.unlink(missing_ok=True)
        return target

    def ensure_env_license_dir(self, env):
        env_dir = self.directory / env["id"]
        env_dir.mkdir(mode=0o711, exist_ok=True)
        env_dir.chmod(0o711)
        uid = self.uid_base + env["slot"]
        target = env_dir / "crag-license"
        if target.exists() or target.is_symlink():
            info = target.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or (info.st_mode & 0o7777) != 0o700:
                raise Failure(503, "license_invalid")
            return target
        target.mkdir(mode=0o700)
        os.chown(target, uid, uid)
        os.chmod(target, 0o700)
        return target

    def run_craggemini_license_cli(self, env, extra_args, input_code=None):
        if env.get("auth_method", "oauth") != "oauth":
            raise Failure(409, "gemini_subscription_oauth_only")
        self.ensure_payload(legacy_install=False)
        uid = self.uid_base + env["slot"]
        machine_id = self.ensure_env_machine_id(env)
        license_dir = self.ensure_env_license_dir(env)
        staging_dir = None
        try:
            bwrap_args = [
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
                "bwrap",
                "--unshare-pid",
                "--unshare-ipc",
                "--unshare-uts",
                "--unshare-net",
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
                "--ro-bind",
                str(machine_id),
                "/etc/machine-id",
                "--dir",
                "/run",
                "--dir",
                "/run/kin",
                "--dir",
                "/run/kin/crag-license",
                "--bind",
                str(license_dir),
                "/run/kin/crag-license",
                "--ro-bind",
                str(self.payload / "craggemini"),
                "/opt/craggemini",
                "--proc",
                "/proc",
                "--tmpfs",
                "/tmp",
            ]
            if self.crag_host_dir is not None and self.crag_host_dir.is_dir():
                bwrap_args.extend(
                    [
                        "--dir",
                        "/run/kin/crag-host",
                        "--ro-bind",
                        str(self.crag_host_dir),
                        "/run/kin/crag-host",
                    ]
                )
            if self.payload_mode == "crag_subscription":
                bwrap_args.extend(
                    [
                        "--ro-bind",
                        str(self.payload / "craggemini.payload.enc"),
                        "/opt/craggemini.payload.enc",
                        "--ro-bind",
                        str(self.payload / "manifest.json"),
                        "/opt/manifest.json",
                        "--ro-bind",
                        str(self.payload / "crag-license-public.pem"),
                        "/opt/crag-license-public.pem",
                    ]
                )
            cli_args = [
                "/opt/craggemini",
                "--vm-id",
                env["id"],
                "--license-dir",
                "/run/kin/crag-license",
                "--host-license-dir",
                "/run/kin/crag-host",
                *extra_args,
            ]
            if input_code is not None:
                staging_dir = self.directory / env["id"] / f".activate-{secrets.token_hex(8)}"
                staging_dir.mkdir(mode=0o700)
                os.chown(staging_dir, uid, uid)
                code_file = staging_dir / "code.txt"
                with os.fdopen(
                    os.open(code_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600),
                    "w",
                    encoding="utf-8",
                ) as out:
                    out.write(input_code.strip() + "\n")
                    out.flush()
                    os.fsync(out.fileno())
                os.chown(code_file, uid, uid)
                os.chmod(code_file, 0o600)
                bwrap_args.extend(["--dir", "/tmp/activate", "--ro-bind", str(staging_dir), "/tmp/activate"])
                cli_args.extend(["--license-activate-file", "/tmp/activate/code.txt"])
            result = subprocess.run(
                bwrap_args + ["--"] + cli_args,
                timeout=10,
                capture_output=True,
                text=True,
                env=SYSTEM_ENV,
            )
            if result.returncode != 0:
                raise Failure(403, "license_invalid")
            data = json.loads(result.stdout)
            if not isinstance(data, dict):
                raise Failure(503, "license_invalid")
            return data
        except Failure:
            raise
        except (OSError, subprocess.SubprocessError, ValueError):
            raise Failure(503, "license_unconfigured") from None
        finally:
            if staging_dir is not None:
                shutil.rmtree(staging_dir, ignore_errors=True)

    def license_status(self, env):
        if env.get("auth_method", "oauth") == "api_key":
            return {
                "product": "craggemini",
                "status": "not_required",
                "valid": True,
                "seat_required": False,
                "vm_id": env["id"],
            }
        try:
            status = self.run_craggemini_license_cli(env, ["--license-status"])
            status.setdefault("product", "craggemini")
            status["seat_required"] = True
            return status
        except Failure as error:
            code = error.code if error.code in LICENSE_ERROR_CODES else "license_unconfigured"
            return {
                "product": "craggemini",
                "status": "unlicensed" if code == "license_required" else "unconfigured",
                "valid": False,
                "seat_required": True,
                "vm_id": env["id"],
                "code": code,
            }

    def license_release_candidate(self, env):
        if env.get("auth_method", "oauth") != "oauth":
            return {"permit_sha256": None, "seat_required": False}
        reg_file = self.directory / env["id"] / "crag-license" / "registration.code"
        try:
            fd = os.open(reg_file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size > 65536:
                    return {"permit_sha256": None, "seat_required": True}
                text = stream.read(65537).decode("utf-8", errors="strict").strip()
            if text.startswith("CRAGS1."):
                return {
                    "permit_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                    "seat_required": True,
                }
            return {"permit_sha256": None, "seat_required": True}
        except (OSError, UnicodeDecodeError):
            return {"permit_sha256": None, "seat_required": True}

    def license_clear(self, env):
        identifier = env["id"]
        self.cancel_infer(identifier)
        self.stop_run(identifier)
        self.stop_native_session(identifier)
        self._clear_runtime_proxy(identifier)
        reg_file = self.directory / identifier / "crag-license" / "registration.code"
        try:
            if reg_file.exists() and not reg_file.is_symlink():
                reg_file.unlink()
        except OSError:
            pass
        return {"cleared": True}

    def view(self, env):
        account = env.get("account", {})
        method = env.get("auth_method", "oauth")
        session = self.native_sessions.get(env["id"])
        runtime_ready = (
            (method == "api_key" and env["auth_state"] == "authorized" and bool(env.get("call_models")))
            or (
                session is not None
                and session.is_alive()
                and not session.is_severely_unhealthy()
            )
        )
        crag_license = (
            self.license_status(env)
            if self.payload_mode == "crag_subscription"
            else None
        )
        credential_state = (
            self._profile_credential_health(env)
            if method == "oauth" and not env.get("oauth_imported")
            else None
        )
        return {
            "id": env["id"],
            "name": env["name"],
            "proxy_id": env["proxy_id"],
            "auth_state": env["auth_state"],
            "auth_method": method,
            **({"oauth_imported": True} if env.get("oauth_imported") else {}),
            "runtime_ready": runtime_ready,
            "max_concurrency": env_concurrency(env),
            "active_slots": len(self.active_infers.get(env["id"], {})),
            "capabilities": list(FULL_CAPABILITIES if method == "api_key" else NATIVE_CAPABILITIES),
            "kernel_version": self.payload_version,
            "models": env.get("call_models", account.get("models", [])),
            "models_discovered": bool(env.get("call_models")),
            "account": account,
            **({"credential_state": credential_state} if credential_state is not None else {}),
            **({"crag_license": crag_license} if crag_license is not None else {}),
            "created_at": env.get("created_at"),
            "updated_at": env.get("updated_at"),
            **self.last_inference_view(env),
        }

    def probe_imported_account(self, slot, proxy_url, credential):
        if credential["expiry"] <= time.time():
            return {"state": "reauth_required", "checked_at": now()}
        return read_account(
            self.uid_base + slot, proxy_url, "oauth_import", oauth_token=credential
        )

    def refresh_account(self, env, proxy_url, *, auto_pull_models=True):
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
            has_refresh, is_expired = self._profile_token_state(env)
            can_run_agy = (
                self.egress is not None
                and self.oauth_runtime_issue() is None
                and not self.running(env["id"])
                and env["id"] not in self.terminals
                and env["id"] not in self.pending
            )
            agy_refreshed = False
            agy_non_auth_error = False
            if has_refresh and is_expired and can_run_agy:
                agy_refreshed = True
                try:
                    self.pull_models(env, proxy_url, allow_reauth_probe=True)
                except Failure as error:
                    if error.code != "gemini_oauth_required":
                        agy_non_auth_error = True
                except (OSError, subprocess.SubprocessError, ValueError, RuntimeError):
                    agy_non_auth_error = True
            account = read_account(
                self.uid_base + env["slot"],
                proxy_url,
                "oauth",
                profile=directory / env["profile"],
            )
            if (
                account.get("state") == "reauth_required"
                and has_refresh
                and not agy_refreshed
                and can_run_agy
            ):
                agy_refreshed = True
                try:
                    self.pull_models(env, proxy_url, allow_reauth_probe=True)
                    account = read_account(
                        self.uid_base + env["slot"],
                        proxy_url,
                        "oauth",
                        profile=directory / env["profile"],
                    )
                except Failure as error:
                    if error.code != "gemini_oauth_required":
                        agy_non_auth_error = True
                except (OSError, subprocess.SubprocessError, ValueError, RuntimeError):
                    agy_non_auth_error = True
            if account.get("state") == "reauth_required" and agy_non_auth_error:
                account["state"] = "error"
            if (
                account.get("state") in ("ok", "partial")
                and auto_pull_models
                and not env.get("call_models")
                and not agy_refreshed
                and can_run_agy
            ):
                try:
                    self.pull_models(env, proxy_url, allow_reauth_probe=True)
                except (
                    Failure,
                    OSError,
                    subprocess.SubprocessError,
                    ValueError,
                    RuntimeError,
                ):
                    pass
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
            self.stop_native_session(env["id"])
            self._clear_runtime_proxy(env["id"])
            env.pop("call_models", None)
            self.stop_terminal(env["id"])
            env["auth_state"] = "reauth_required"
        elif account.get("state") in ("ok", "partial"):
            env["auth_state"] = "authorized"
        self.touch_environment(env)
        self.save()
        return self.view(env)

    def request(self, operation, body):
        with self.lock:
            return self._locked_request(operation, body)

    def _locked_request(self, operation, body):
        if operation in {
            "list",
            "get",
            "maintenance-status",
            "test-chat-status",
            "test-chat-cancel",
            "infer-cancel",
            "terminal-io",
            "terminal-stop",
        }:
            return self._request(operation, body)
        descriptor = os.open(
            self.directory / "maintenance.lock",
            os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
            0o600,
        )
        try:
            info = os.fstat(descriptor)
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != 0
                or info.st_nlink != 1
                or info.st_mode & 0o077
            ):
                raise Failure(503, "gemini_maintenance_lock_invalid")
            try:
                fcntl.flock(descriptor, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Failure(409, "gemini_operation_busy") from None
            pending = self.directory / "maintenance.pending"
            if pending.exists() or pending.is_symlink():
                raise Failure(409, "gemini_operation_busy")
            return self._request(operation, body)
        finally:
            os.close(descriptor)

    def _request(self, operation, body):
        if operation == "maintenance-status":
            return {
                "busy": bool(
                    self.pending
                    or self.terminals
                    or any(self.active_infers.values())
                    or any(self.running(key) for key in self.runs)
                )
            }
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
                "payload_mode": self.payload_mode,
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
            raw_concurrency = body.get("max_concurrency")
            if raw_concurrency is None:
                max_concurrency = 1
            elif type(raw_concurrency) is int and 1 <= raw_concurrency <= MAX_CONCURRENCY:
                max_concurrency = raw_concurrency
            else:
                raise Failure(400, "gemini_invalid_concurrency")
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
            call_models = None
            if method == "api_key":
                account = read_account(
                    self.uid_base + slot, proxy_url, "api_key", api_key=api_key
                )
                if account["state"] == "reauth_required":
                    raise Failure(400, "gemini_api_key_rejected")
                if account["state"] not in ("ok", "partial"):
                    raise Failure(502, "gemini_account_read_failed")
                chat_data = read_account(
                    self.uid_base + slot, proxy_url, "api-key-models", api_key=api_key
                )
                if chat_data.get("state") in ("ok", "partial") and chat_data.get(
                    "models"
                ):
                    call_models = chat_data["models"]
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
                "max_concurrency": max_concurrency,
                "auth_method": method,
                "auth_state": (
                    "authorized" if method == "api_key" or credential else "unverified"
                ),
                **({"oauth_imported": True} if credential else {}),
                **({"call_models": call_models} if call_models else {}),
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
                "payload_mode": self.payload_mode,
                "payload_issue": self.payload_issue,
            }
        if operation == "license-machine-code":
            return self.run_craggemini_license_cli(env, ["--license-machine-code"])
        if operation == "license-activate":
            code = body.get("code")
            if not isinstance(code, str) or not 16 <= len(code.strip()) <= 16384:
                raise Failure(400, "gemini_subscription_invalid_code")
            status = self.run_craggemini_license_cli(env, [], input_code=code)
            self.stop_native_session(identifier)
            self._schedule_warm_locked(identifier, force=True)
            return status
        if operation == "license-status":
            return {"license": self.license_status(env)}
        if operation == "license-release-candidate":
            return self.license_release_candidate(env)
        if operation == "license-clear":
            return self.license_clear(env)
        if operation == "proxy-bind":
            return self.bind_proxy(env, body)
        if operation == "concurrency-set":
            raw_concurrency = body.get("max_concurrency")
            if type(raw_concurrency) is not int or not 1 <= raw_concurrency <= MAX_CONCURRENCY:
                raise Failure(400, "gemini_invalid_concurrency")
            if (
                self.running(identifier)
                or identifier in self.terminals
                or identifier in self.pending
            ):
                raise Failure(409, "gemini_operation_busy")
            if env_concurrency(env) != raw_concurrency:
                self.stop_native_session(identifier)
                self.save_environment(
                    env,
                    {**env, "max_concurrency": raw_concurrency, "updated_at": now()},
                )
                self._schedule_warm_locked(identifier, force=True)
            return self.view(env)
        if operation in ("test-chat-status", "test-chat-cancel"):
            return self.run_request(operation, identifier, body)
        if operation == "infer-cancel":
            req_id = body.get("request_id")
            if req_id is not None and (
                not isinstance(req_id, str) or not INFER_REQUEST_ID.fullmatch(req_id)
            ):
                raise Failure(400)
            return {"cancelled": self.cancel_infer(identifier, req_id)}
        if operation in ("terminal-start", "terminal-io", "terminal-stop"):
            return self.terminal_request(operation, env, body)
        if operation == "logout":
            if env.get("auth_method", "oauth") != "oauth":
                raise Failure(409)
            self.cancel_infer(identifier)
            self.stop_run(identifier)
            self.stop_native_session(identifier)
            self._clear_runtime_proxy(identifier)
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
            self.touch_environment(env)
            self.save()
            return {}
        if operation in ("delete", "disable"):
            self.cancel_infer(identifier)
            self.stop_run(identifier)
            self.stop_native_session(identifier)
            self._clear_runtime_proxy(identifier)
            self.stop_terminal(identifier)
            self.cancel(identifier)
            self.recover_network(self.directory / identifier, env["slot"])
            env["auth_state"] = "disabled"
            self.touch_environment(env)
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
        verify_proxy_sha256(body, proxy_url)
        if operation == "warm":
            self.ensure_payload(legacy_install=False)
            return self.warm_environment(env, proxy_url, model=body.get("model"))
        if operation == "proxy-probe":
            return self.probe_proxy(env, proxy_url)
        if operation == "models":
            self._remember_runtime_proxy(env, proxy_url)
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
            self._remember_runtime_proxy(env, proxy_url)
            return self.refresh_account(env, proxy_url)
        if env.get("auth_method", "oauth") != "oauth":
            raise Failure(409)
        if operation == "authorize":
            if identifier in self.terminals or self.running(identifier):
                raise Failure(409, "gemini_terminal_conflict")
            self.ensure_oauth_runtime()
            self.cancel(identifier)
            self.stop_run(identifier)
            self.stop_native_session(identifier)
            env["auth_state"] = "authorizing"
            self.touch_environment(env)
            self.save()
            try:
                login = Login(self, env, proxy_url)
                self.pending[identifier] = login
                return login.challenge()
            except (Failure, OSError, subprocess.SubprocessError) as error:
                self.cancel(identifier)
                env["auth_state"] = "reauth_required"
                self.touch_environment(env)
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

    @staticmethod
    def _extract_native_turn_body(model, body_obj):
        if not isinstance(body_obj, dict):
            return None
        allowed_top = {
            "model",
            "contents",
            "stream",
            "systemInstruction",
            "system_instruction",
            "tools",
            "toolConfig",
            "tool_config",
            "generationConfig",
            "generation_config",
            "safetySettings",
            "safety_settings",
            "conversation_id",
            "conversationId",
        }
        if any(k not in allowed_top for k in body_obj):
            return None
        contents = body_obj.get("contents")
        if not isinstance(contents, list) or not contents:
            return None
        allowed_part_keys = {
            "text",
            "inlineData",
            "inline_data",
            "fileData",
            "file_data",
            "functionCall",
            "function_call",
            "functionResponse",
            "function_response",
            "thought",
            "thoughtSignature",
            "thought_signature",
        }
        has_substantive_part = False
        for entry in contents:
            if not isinstance(entry, dict) or any(k not in ("role", "parts") for k in entry):
                return None
            if entry.get("role") not in (None, "user", "model"):
                return None
            parts = entry.get("parts")
            if not isinstance(parts, list) or not parts:
                return None
            for part in parts:
                if not isinstance(part, dict) or not part or any(k not in allowed_part_keys for k in part):
                    return None
                if "text" in part:
                    text = part["text"]
                    if not isinstance(text, str):
                        return None
                    if any(ord(ch) < 32 and ch not in ("\n", "\r", "\t") for ch in text):
                        return None
                    if text.strip():
                        has_substantive_part = True
                if any(
                    k in part
                    for k in (
                        "inlineData",
                        "inline_data",
                        "fileData",
                        "file_data",
                        "functionCall",
                        "function_call",
                        "functionResponse",
                        "function_response",
                    )
                ):
                    has_substantive_part = True
        if not has_substantive_part:
            return None
        forwarded = {k: v for k, v in body_obj.items() if k != "stream"}
        forwarded["model"] = model
        return forwarded

    @staticmethod
    def _redact_bytes(chunk, secret_values):
        for secret in secret_values:
            if secret and secret in chunk:
                chunk = chunk.replace(secret, b"[redacted]")
        return chunk

    def _begin_infer(self, body):
        identifier = body.get("id")
        if not isinstance(identifier, str) or identifier not in self.environments:
            raise Failure(404)
        env = self.environments[identifier]
        if body.get("proxy_id") != env["proxy_id"]:
            raise Failure(409)
        proxy_url = body.get("proxy_url")
        proxy_config(proxy_url)
        verify_proxy_sha256(body, proxy_url)
        model = body.get("model")
        request_id = body.get("request_id")
        infer_body = body.get("body")
        if (
            not isinstance(model, str)
            or not MODEL.fullmatch(model)
            or not isinstance(request_id, str)
            or not INFER_REQUEST_ID.fullmatch(request_id)
            or not isinstance(infer_body, dict)
        ):
            raise Failure(400, "gemini_invalid_request")
        descriptor = os.open(
            self.directory / "maintenance.lock",
            os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
            0o600,
        )
        try:
            fcntl.flock(descriptor, fcntl.LOCK_SH | fcntl.LOCK_NB)
            pending = self.directory / "maintenance.pending"
            if pending.exists() or pending.is_symlink():
                raise Failure(409, "gemini_operation_busy")
        except BlockingIOError:
            raise Failure(409, "gemini_operation_busy") from None
        finally:
            os.close(descriptor)

        uid, key, auth = self.operation_account(env, allow_concurrent_infer=True)
        if request_id in self.active_infers.get(identifier, {}):
            raise Failure(409, "gemini_operation_busy")
        if model not in env.get("call_models", []):
            raise Failure(409, "gemini_model_unavailable")
        native_body = None
        if not key:
            native_body = self._extract_native_turn_body(model, infer_body)
            if native_body is None:
                raise Failure(400, "gemini_unsupported_turn")
        evidence = {
            "state": "running",
            "model": model,
            "started_at": now(),
            "finished_at": None,
            "error_code": None,
        }
        self.last_inference[identifier] = (
            self.inference_binding(env),
            evidence,
            hashlib.sha256(proxy_url.encode()).hexdigest(),
        )
        cancel_event = threading.Event()
        infer_entry = {
            "request_id": request_id,
            "cancel_event": cancel_event,
            "cancel_fn": None,
        }
        self.active_infers.setdefault(identifier, {})[request_id] = infer_entry
        return {
            "identifier": identifier,
            "env": dict(env),
            "uid": uid,
            "key": key,
            "auth": auth,
            "proxy_url": proxy_url,
            "model": model,
            "request_id": request_id,
            "infer_body": infer_body,
            "native_body": native_body,
            "evidence": evidence,
            "entry": infer_entry,
        }

    def stream_infer(self, body, handler):
        with self.lock:
            ctx = self._begin_infer(body)
        identifier = ctx["identifier"]
        evidence = ctx["evidence"]
        cancel_event = ctx["entry"]["cancel_event"]
        final_state = "failed"
        final_code = "gemini_inference_failed"
        try:
            if ctx["key"]:
                final_state, final_code = self._stream_api_key_infer(ctx, handler)
            else:
                final_state, final_code = self._stream_native_infer(ctx, handler)
        except Failure as error:
            final_state = "cancelled" if cancel_event.is_set() else "failed"
            final_code = error.code or "gemini_inference_failed"
            handler.send_json_error(error.status, final_code)
        except (BrokenPipeError, ConnectionResetError):
            final_state = "cancelled"
            final_code = "gemini_inference_cancelled"
        except (OSError, subprocess.SubprocessError, ValueError):
            final_state = "failed"
            final_code = "gemini_inference_failed"
            handler.send_json_error(502, final_code)
        finally:
            with self.lock:
                slot_map = self.active_infers.get(identifier)
                if slot_map is not None:
                    slot_map.pop(ctx["request_id"], None)
                    if not slot_map:
                        self.active_infers.pop(identifier, None)
                self.finish_inference(
                    evidence,
                    final_state,
                    None if final_state == "completed" else final_code,
                )

    def _stream_api_key_infer(self, ctx, handler):
        key = ctx["key"]
        cancel_event = ctx["entry"]["cancel_event"]
        secret_bytes = (key.encode("utf-8"),)
        proc = subprocess.Popen(
            account_command(ctx["uid"], "api-key-stream"),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            bufsize=0,
            env=SYSTEM_ENV,
        )

        def stop_proc():
            if proc.poll() is None:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

        ctx["entry"]["cancel_fn"] = stop_proc
        try:
            payload = json.dumps(
                {
                    "api_key": key,
                    "proxy_url": ctx["proxy_url"],
                    "model": ctx["model"],
                    "body": ctx["infer_body"],
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
            proc.stdin.write(payload)
            proc.stdin.close()
            header_line = proc.stdout.readline(1024)
            parts = header_line.decode("ascii", errors="replace").strip().split(" ", 2)
            status = int(parts[1]) if len(parts) >= 2 and parts[0] == "STATUS" and parts[1].isdigit() else 0
            ct = (parts[2] if len(parts) >= 3 else "").split(";", 1)[0].strip().lower()
            if status != 200 or ct != "text/event-stream":
                raw_err = proc.stdout.read(65536) if proc.stdout else b""
                err_msg = None
                try:
                    parsed_err = json.loads(raw_err) if raw_err else {}
                    err_obj = parsed_err.get("error") if isinstance(parsed_err, dict) else None
                    if isinstance(err_obj, dict) and isinstance(err_obj.get("message"), str):
                        err_msg = err_obj["message"][:512]
                except ValueError:
                    pass
                code = {
                    0: "gemini_proxy_error",
                    400: "gemini_invalid_request",
                    401: "gemini_api_key_invalid",
                    403: "gemini_api_key_invalid",
                    404: "gemini_model_unavailable",
                    429: "gemini_quota_exhausted",
                }.get(status, "gemini_inference_failed")
                http_status = status if 400 <= status <= 599 else 502
                handler.send_json_error(http_status, code, err_msg)
                return "failed", code
            handler.begin_sse()
            while not cancel_event.is_set():
                chunk = proc.stdout.read1(16384) if hasattr(proc.stdout, "read1") else proc.stdout.read(16384)
                if not chunk:
                    break
                handler.write_sse_chunk(self._redact_bytes(chunk, secret_bytes))
            if cancel_event.is_set():
                return "cancelled", "gemini_inference_cancelled"
            return "completed", None
        finally:
            stop_proc()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=2)

    def _acquire_native_session(self, ctx):
        identifier = ctx["identifier"]
        proxy_hash = hashlib.sha256(ctx["proxy_url"].encode()).digest()
        desired_concurrency = env_concurrency(ctx["env"])
        with self._session_lock(identifier):
            with self.lock:
                self._remember_runtime_proxy(ctx["env"], ctx["proxy_url"])
                existing = self.native_sessions.get(identifier)
                if (
                    existing is not None
                    and getattr(existing, "max_concurrency", 1) == desired_concurrency
                    and secrets.compare_digest(existing.proxy_hash, proxy_hash)
                    and existing.is_alive()
                    and not existing.is_severely_unhealthy()
                ):
                    existing.last_used = time.monotonic()
                    return existing
                if existing is not None:
                    self.stop_native_session(identifier)
            session = NativeSession(
                self, ctx["env"], ctx["proxy_url"], ctx["auth"], ctx["model"]
            )
            with self.lock:
                self.native_sessions[identifier] = session
                getattr(self, "_warm_backoff", {}).pop(identifier, None)
            return session

    def _stream_native_infer(self, ctx, handler):
        identifier = ctx["identifier"]
        cancel_event = ctx["entry"]["cancel_event"]
        creds = tuple(
            v.encode("utf-8")
            for v in (ctx["auth"][0] if ctx["auth"] else ())
            if isinstance(v, str) and v
        )
        native_mod = native_module()
        session = self._acquire_native_session(ctx)
        conn = None
        had_error = False

        def stop_native():
            session.cancel_turn(ctx["request_id"])
            if conn is not None:
                try:
                    conn.close()
                except OSError:
                    pass

        ctx["entry"]["cancel_fn"] = stop_native
        try:
            conn, response = session.open_stream(
                ctx["request_id"], ctx["native_body"], model=ctx["model"]
            )
            handler.begin_sse()
            while not cancel_event.is_set():
                chunk = response.read1(16384)
                if not chunk:
                    break
                handler.write_sse_chunk(self._redact_bytes(chunk, creds))
            if cancel_event.is_set():
                had_error = True
                return "cancelled", "gemini_inference_cancelled"
            session.last_used = time.monotonic()
            return "completed", None
        except native_mod.NativeFailure as error:
            had_error = error.code != "gemini_unsupported_turn"
            diagnostic = (
                session.native_diagnostic.poll(final=True)
                if session.native_diagnostic is not None
                else None
            )
            code = diagnostic or error.code
            if code in (
                "gemini_location_unsupported",
                "gemini_account_verification_required",
                "gemini_account_ineligible",
            ):
                status = 403
                message = None
            else:
                status = error.status or 502
                message = error.message
            handler.send_json_error(status, code, message)
            return "failed", code
        except (BrokenPipeError, ConnectionResetError):
            had_error = True
            stop_native()
            raise
        except (OSError, TimeoutError):
            had_error = True
            handler.send_json_error(502, "gemini_inference_failed")
            return "failed", "gemini_inference_failed"
        finally:
            if conn is not None:
                conn.close()
            unhealthy = not session.is_alive()
            if not unhealthy and had_error:
                session.health(timeout=0.5)
                unhealthy = session.is_severely_unhealthy()
            if unhealthy:
                with self.lock:
                    if self.native_sessions.get(identifier) is session:
                        self.stop_native_session(identifier)
                        self._schedule_warm_locked(identifier, force=True)


class ThreadingUnixStreamServer(
    socketserver.ThreadingMixIn, socketserver.UnixStreamServer
):
    daemon_threads = True
    allow_reuse_address = True


class ControlHandler(BaseHTTPRequestHandler):
    def setup(self):
        self.request.settimeout(2)
        self._headers_sent = False
        super().setup()

    def send_json_error(self, status, code=None, message=None):
        if self._headers_sent:
            return
        payload = {}
        if code:
            payload["code"] = code
        if message:
            payload["message"] = message
        data = json.dumps(payload).encode()
        self._headers_sent = True
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            return

    def begin_sse(self):
        if self._headers_sent:
            return
        self._headers_sent = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()

    def write_sse_chunk(self, chunk):
        if not chunk:
            return
        self.wfile.write(chunk)
        self.wfile.flush()

    def do_POST(self):
        operation = self.path[1:] if self.path.startswith("/") else self.path
        try:
            length = int(self.headers.get("Content-Length", 0))
            if operation == "infer":
                if not hasattr(self.server.host, "stream_infer"):
                    raise Failure(404)
                self.request.settimeout(300)
                if length < 1 or length > MAX_INFER_BODY:
                    raise Failure(413 if length > MAX_INFER_BODY else 400)
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise Failure(400)
                self.server.host.stream_infer(body, self)
                return
            if length < 1 or length > (
                32768
                if operation in ("create", "test-chat")
                else 16384
                if operation == "license-activate"
                else 8192
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
                "maintenance-status",
                "proxy-probe",
                "proxy-bind",
                "concurrency-set",
                "models",
                "test-chat",
                "test-chat-status",
                "test-chat-cancel",
                "infer-cancel",
                "warm",
                "license-machine-code",
                "license-activate",
                "license-status",
                "license-release-candidate",
                "license-clear",
            }:
                raise Failure(404)
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise Failure(400)
            if operation in ("install-payload", "maintenance-status"):
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
        if self._headers_sent:
            return
        data = json.dumps(payload).encode()
        self._headers_sent = True
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
    parser.add_argument("--crag-host-dir", type=Path)
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
        args.crag_host_dir,
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
        with ThreadingUnixStreamServer(str(args.socket), ControlHandler) as server:
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
