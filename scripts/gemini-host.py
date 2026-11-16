import argparse
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
import socketserver
import stat
import struct
import subprocess
import sys
import termios
import time
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
MAX_ENVIRONMENTS = 8
AUTH_TTL = 300
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")
CODE = re.compile(r"[A-Za-z0-9._~/-]{1,2048}\Z")
AUTH_LINK = re.compile(
    rb"\x1b\]8;[^;\x1b]*;(https://accounts\.google\.com/o/oauth2/auth\?[^\x07\x1b]{1,4096})(?:\x07|\x1b\\)"
)
AUTH_SUCCESS = re.compile(
    rb"(successfully authenticated|authentication successful|logged in as)", re.I
)
AUTH_FAILURE = re.compile(
    rb"(invalid authorization code|failed to exchange|authentication failed)", re.I
)
SYSTEM_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"}


class Failure(Exception):
    def __init__(self, status):
        self.status = status


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


class Login:
    def __init__(self, host, environment, proxy_url):
        self.host = host
        self.environment = environment
        self.slot = environment["slot"]
        self.uid = host.uid_base + self.slot
        self.attempt = secrets.token_hex(16)
        self.directory = host.directory / environment["id"] / self.attempt
        self.deadline = time.monotonic() + AUTH_TTL
        self.sent = False
        self.buffer = b""
        self.pid = None
        self.terminal = None
        self.egress = None
        self.network_started = False
        address, port = proxy_config(proxy_url)
        self.network = [str(self.slot), str(host.egress_uid), address, port]
        self.namespace = f"vm2agy{self.slot}"
        self.proxy_hash = hashlib.sha256(proxy_url.encode()).digest()
        try:
            self.start(proxy_url)
        except BaseException:
            self.close()
            raise

    def start(self, proxy_url):
        self.directory.mkdir(mode=0o700)
        home = self.directory / "home"
        work = self.directory / "work"
        settings = home / ".gemini" / "antigravity-cli"
        for private in (home, home / ".gemini", settings, work):
            private.mkdir(mode=0o700)
            os.chown(private, self.uid, self.uid)
        private_json(
            settings / "settings.json",
            {"toolPermission": "strict", "useG1Credits": False},
        )
        os.chown(settings / "settings.json", self.uid, self.uid)
        env_dir = self.directory.parent
        env_dir.chmod(0o711)
        self.directory.chmod(0o711)
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
        resolver = self.directory / "resolv.conf"
        resolver.write_text("nameserver 1.1.1.1\noptions timeout:2 attempts:2\n")
        resolver.chmod(0o644)
        self.host.network("start", self.network)
        self.network_started = True
        subprocess.run(
            self.launch_args(self.host.egress_uid)
            + [
                "python3",
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
            + [str(self.host.egress), "--config", str(config)],
            env=SYSTEM_ENV,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        sandbox = [
            "bwrap",
            "--unshare-pid",
            "--unshare-ipc",
            "--unshare-uts",
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
            "--ro-bind",
            str(resolver),
            "/etc/resolv.conf",
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
            "PATH",
            "/usr/bin:/bin",
            "--setenv",
            "TERM",
            "xterm-256color",
            "--setenv",
            "LANG",
            "C.UTF-8",
            "--setenv",
            "SSH_TTY",
            "/dev/tty",
            "--setenv",
            "SSH_CONNECTION",
            "127.0.0.1 12345 127.0.0.1 22",
            "--",
            "/opt/agy",
            "--mode",
            "plan",
        ]
        self.pid, self.terminal = pty.fork()
        if self.pid == 0:
            try:
                os.umask(0o077)
                argv = self.launch_args(self.uid) + sandbox
                os.execvpe(argv[0], argv, SYSTEM_ENV)
            finally:
                os._exit(125)
        fcntl.ioctl(
            self.terminal, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 180, 0, 0)
        )

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

    def read(self, timeout):
        if self.egress is None or self.terminal is None:
            raise Failure(503)
        if self.egress.poll() is not None:
            raise Failure(503)
        if select.select([self.terminal], [], [], timeout)[0]:
            try:
                data = os.read(self.terminal, 16384)
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
                return {
                    "attempt_id": self.attempt,
                    "url": match.group(1).decode("ascii"),
                }
        raise Failure(503)

    def submit(self, code, proxy_url):
        if (
            self.sent
            or not CODE.fullmatch(code)
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
        self.read(0)
        if not self.sent:
            return False
        if AUTH_FAILURE.search(self.buffer):
            raise Failure(409)
        if not AUTH_SUCCESS.search(self.buffer):
            return False
        try:
            info = (
                self.directory / "home/.gemini/antigravity-cli/antigravity-oauth-token"
            ).lstat()
        except FileNotFoundError:
            return False
        return (
            stat.S_ISREG(info.st_mode)
            and info.st_uid == self.uid
            and not info.st_mode & 0o077
            and info.st_size > 0
        )

    def close(self, preserve=False):
        if self.pid:
            try:
                os.killpg(self.pid, signal.SIGKILL)
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
        if self.network_started:
            self.host.network("stop", self.network)
            self.network_started = False
        (self.directory / "egress.json").unlink(missing_ok=True)
        if not preserve and self.directory.exists():
            shutil.rmtree(self.directory)


class Host:
    def __init__(self, args):
        self.directory = args.state
        self.payload = args.payload
        self.egress = args.egress
        self.uid_base = args.uid_base
        self.egress_uid = args.uid_base + MAX_ENVIRONMENTS
        self.state_file = self.directory / "environments.json"
        self.pending = {}
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
                changed = True
                self.network(
                    "stop", [str(slot), str(self.egress_uid), "192.0.2.1", "1080"]
                )
                for stale in (self.directory / identifier).iterdir():
                    if stale.name != profile and re.fullmatch(
                        r"[a-f0-9]{32}", stale.name
                    ):
                        shutil.rmtree(stale)
        if changed:
            self.save()

    def save(self):
        private_json(self.state_file, self.environments)

    def network(self, action, network):
        subprocess.run(
            ["bash", str(ROOT / "scripts/gemini-host-egress.sh"), action, *network],
            check=True,
            timeout=12,
            env=SYSTEM_ENV,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def cancel(self, identifier):
        if identifier in self.pending:
            self.pending[identifier].close()
            del self.pending[identifier]

    def cleanup(self):
        for identifier, login in list(self.pending.items()):
            env = self.environments[identifier]
            try:
                if time.monotonic() > login.deadline:
                    raise Failure(409)
                if not login.finished():
                    continue
                old_profile = env.get("profile")
                login.close(preserve=True)
                env.update(auth_state="authorized", profile=login.attempt)
                self.save()
                del self.pending[identifier]
                if old_profile:
                    shutil.rmtree(self.directory / identifier / old_profile)
            except Failure:
                self.cancel(identifier)
                env["auth_state"] = "reauth_required"
                self.save()

    def view(self, env):
        return {
            "id": env["id"],
            "name": env["name"],
            "proxy_id": env["proxy_id"],
            "auth_state": env["auth_state"],
            "runtime_ready": False,
            "models": [],
        }

    def request(self, operation, body):
        if operation == "list":
            return {
                "environments": [self.view(env) for env in self.environments.values()]
            }
        if operation == "create":
            proxy_config(body.get("proxy_url"))
            name, proxy_id = body.get("name"), body.get("proxy_id")
            if (
                not isinstance(name, str)
                or not name.strip()
                or len(name) > 80
                or not isinstance(proxy_id, str)
                or not ID.fullmatch(proxy_id)
            ):
                raise Failure(400)
            taken = {env["slot"] for env in self.environments.values()}
            slot = next(
                (slot for slot in range(MAX_ENVIRONMENTS) if slot not in taken), None
            )
            if slot is None:
                raise Failure(409)
            identifier = f"gemini-{secrets.token_hex(12)}"
            (self.directory / identifier).mkdir(mode=0o711)
            env = {
                "id": identifier,
                "name": name.strip(),
                "proxy_id": proxy_id,
                "slot": slot,
                "auth_state": "unverified",
            }
            self.environments[identifier] = env
            self.save()
            return self.view(env)
        identifier = body.get("id")
        if not isinstance(identifier, str) or identifier not in self.environments:
            raise Failure(404)
        env = self.environments[identifier]
        if operation == "get":
            return self.view(env)
        if operation in ("delete", "disable"):
            self.cancel(identifier)
            env["auth_state"] = "disabled"
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
        if operation == "authorize":
            self.cancel(identifier)
            env["auth_state"] = "authorizing"
            self.save()
            try:
                login = Login(self, env, proxy_url)
                self.pending[identifier] = login
                return login.challenge()
            except BaseException:
                self.cancel(identifier)
                env["auth_state"] = "reauth_required"
                self.save()
                raise
        if operation == "complete":
            login = self.pending.get(identifier)
            code = body.get("code")
            if (
                not login
                or body.get("attempt_id") != login.attempt
                or not isinstance(code, str)
            ):
                raise Failure(409)
            login.submit(code, proxy_url)
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
            operation = self.path.removeprefix("/")
            if operation not in {
                "list",
                "get",
                "create",
                "authorize",
                "complete",
                "disable",
                "delete",
            }:
                raise Failure(404)
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise Failure(400)
            status, payload = 200, self.server.host.request(operation, body)
        except Failure as error:
            status, payload = error.status, {}
        except (ValueError, TimeoutError):
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
        except (BrokenPipeError, ConnectionResetError):
            return

    def log_message(self, *_args):
        return


def main():
    parser = argparse.ArgumentParser()
    for name in ("state", "payload", "public-key", "egress", "socket"):
        parser.add_argument(f"--{name}", type=Path, required=True)
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
        ROOT / "src/lib/gemini/payload.mjs",
        args.state,
        args.payload,
        args.public_key,
        args.egress,
        args.socket.parent,
    ):
        if not entry.is_absolute():
            raise SystemExit("Gemini host paths must be absolute")
        check_root_owned(entry)
    args.state.chmod(0o711)
    for filename in (
        "agy",
        "craggemini",
        "libagy_bridge.so",
        "manifest.json",
        "manifest.sig",
    ):
        check_root_owned(args.payload / filename)
    lock = os.open(
        args.state / "service.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600
    )
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    subprocess.run(
        [
            "node",
            str(ROOT / "scripts/install-gemini-payload.mjs"),
            "--source",
            str(args.payload),
            "--public-key",
            str(args.public_key),
            "--check",
        ],
        check=True,
        timeout=30,
        env=SYSTEM_ENV,
    )
    host = Host(args)
    if args.socket.exists():
        if not stat.S_ISSOCK(args.socket.lstat().st_mode):
            raise RuntimeError("Gemini socket path already exists")
        args.socket.unlink()
    stop = False

    def shutdown(*_args):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        with socketserver.UnixStreamServer(str(args.socket), ControlHandler) as server:
            os.chown(args.socket, 0, grp.getgrnam(args.gateway_group).gr_gid)
            args.socket.chmod(0o660)
            server.host = host
            server.timeout = 0.25
            while not stop:
                server.handle_request()
                host.cleanup()
    finally:
        for identifier in list(host.pending):
            host.cancel(identifier)
        args.socket.unlink(missing_ok=True)
        os.close(lock)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.SubprocessError):
        raise SystemExit("Gemini host failed to start or lost its managed runtime")
