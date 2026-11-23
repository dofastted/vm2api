#!/usr/bin/env python3
"""Root-owned fixed-action Gemini maintenance over a local Unix socket."""

import argparse
from contextlib import contextmanager
import ctypes
from datetime import datetime, timezone
import fcntl
import grp
import hashlib
import http.client
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shutil
import signal
import socket
import socketserver
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time


SOCKET = Path("/run/vm2api-gemini-maintenance/control.sock")
ACTIONS = {
    "diagnose",
    "install",
    "repair",
    "recover",
    "update_cli",
    "update_native",
    "rollback",
}
RELEASE_ACTIONS = {"install", "repair", "update_cli", "update_native"}
HEADER_LIMIT = 8192
BODY_LIMIT = 2048
SNAPSHOT_LIMIT = 256 * 1024
REQUEST_TIMEOUT = 2


class Failure(Exception):
    def __init__(self, status, code):
        super().__init__(code)
        self.status = status
        self.code = code


RUNTIME_FILES = (
    "scripts/gemini-host.py",
    "scripts/gemini_host_account.py",
    "scripts/gemini_host_inference.py",
    "scripts/gemini_host_native.py",
    "scripts/gemini-host-egress.sh",
    "scripts/install-gemini-payload.mjs",
    "src/lib/gemini/payload.mjs",
    "bin/kin-egress",
)
VERIFIER_FILES = RUNTIME_FILES[5:7]
MEMBERS = ("manifest.json", "manifest.sig", "agy", "craggemini", "libagy_bridge.so")
ASSETS = (
    *[name for name in MEMBERS if name != "agy"],
    "gemini-ed25519.pub",
    "gemini-release.json",
)
CRAG_MEMBERS = (
    "manifest.json",
    "agy",
    "craggemini",
    "craggemini.payload.enc",
    "libagy_bridge.so",
    "crag-license-public.pem",
)
CRAG_ASSETS = tuple(name for name in CRAG_MEMBERS if name != "agy")
SYSTEMD_UNIT = "vm2api-gemini.service"
SYSTEM_ENV = {
    "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
    "LANG": "C",
    "SYSTEMD_PAGER": "",
    "SYSTEMD_COLORS": "0",
    "DEBIAN_FRONTEND": "noninteractive",
}
SAFE_PATH = re.compile(r"/[A-Za-z0-9._/-]+")
SAFE_VERSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9.-]{0,63}")
HEX = re.compile(r"[0-9a-f]{64}")
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
MAX_MEMBER = 512 * 1024 * 1024


def fail(code, status=503):
    return Failure(status, "gemini_maintenance_" + code)


def strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def parse_json(data):
    def invalid_constant(_):
        raise ValueError("non-JSON constant")

    return json.loads(
        data.decode("utf-8"),
        object_pairs_hook=strict_object,
        parse_constant=invalid_constant,
    )


def canonical(value):
    if (
        not isinstance(value, str)
        or len(value) > 1024
        or not SAFE_PATH.fullmatch(value)
    ):
        raise ValueError("invalid path")
    path = Path(value)
    if (
        str(path) != value
        or path.anchor != "/"
        or path == Path("/")
        or ".." in path.parts
    ):
        raise ValueError("noncanonical path")
    return path


def require_root(path, kind):
    canonical(str(path))
    for entry in reversed(path.parents):
        info = entry.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError("untrusted path ancestor")
    info = path.lstat()
    if not kind(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError("untrusted path")
    return info


def exists(path):
    return os.path.lexists(path)


def root_dir(path, mode=0o755):
    if not exists(path):
        if path.parent != Path("/"):
            root_dir(path.parent)
        path.mkdir(mode=mode, exist_ok=True)
        # Service UMask is private; runtime payload parents must be traversable by slot UIDs.
        path.chmod(mode)
    require_root(path, stat.S_ISDIR)


def open_regular(path, limit, *, trusted=True):
    if trusted:
        require_root(path, stat.S_ISREG)
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    else:
        # Open the app artifact by inode, rejecting links, FIFOs and devices
        # before obtaining a readable descriptor, even if bin is app-owned.
        require_root(path.parent.parent, stat.S_ISDIR)
        parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            handle = os.open(path.name, os.O_PATH | os.O_NOFOLLOW, dir_fd=parent)
            try:
                info = os.fstat(handle)
                if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= limit:
                    raise ValueError("invalid app artifact")
                fd = os.open(f"/proc/self/fd/{handle}", os.O_RDONLY | os.O_NONBLOCK)
            finally:
                os.close(handle)
        finally:
            os.close(parent)
    try:
        info = os.fstat(fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or not 0 < info.st_size <= limit
            or (trusted and (info.st_uid != 0 or info.st_mode & 0o022))
        ):
            raise ValueError("invalid file")
        return os.fdopen(fd, "rb")
    except BaseException:
        os.close(fd)
        raise


def read_root(path, limit):
    with open_regular(path, limit) as source:
        result = source.read(limit + 1)
    if not 0 < len(result) <= limit:
        raise ValueError("invalid file size")
    return result


def read_optional(path, limit):
    try:
        return read_root(path, limit)
    except FileNotFoundError:
        return None


def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def sync_tree(directory):
    # Staging created exclusively by the broker and its signed payload installer.
    for parent, _, files in os.walk(directory, topdown=False):
        for name in files:
            with (Path(parent) / name).open("rb") as source:
                os.fsync(source.fileno())
        fsync_dir(parent)


def atomic_file(target, data, mode=0o600):
    require_root(target.parent, stat.S_ISDIR)
    if exists(target):
        require_root(target, stat.S_ISREG)
    if data is None:
        target.unlink(missing_ok=True)
    else:
        fd, name = tempfile.mkstemp(prefix=".gemini-write-", dir=target.parent)
        try:
            with os.fdopen(fd, "wb") as output:
                output.write(data)
                os.fchmod(output.fileno(), mode)
                output.flush()
                os.fsync(output.fileno())
            os.replace(name, target)
        finally:
            Path(name).unlink(missing_ok=True)
    fsync_dir(target.parent)


def copy_file(source, target, mode, *, pin=None, trusted=True):
    """Copy only a bounded regular file; make the target visible after checking the pin."""
    root_dir(target.parent)
    if exists(target):
        require_root(target, stat.S_ISREG)
    digest = hashlib.sha256()
    count = 0
    maximum = pin["size"] if pin is not None else MAX_MEMBER
    fd, name = tempfile.mkstemp(prefix=".gemini-copy-", dir=target.parent)
    try:
        with os.fdopen(fd, "wb") as output, open_regular(
            source, maximum, trusted=trusted
        ) as stream:
            while chunk := stream.read(1024 * 1024):
                count += len(chunk)
                if count > maximum:
                    raise ValueError("invalid file size")
                if pin is not None:
                    digest.update(chunk)
                output.write(chunk)
            if not count or (
                pin is not None
                and (count != maximum or digest.hexdigest() != pin["sha256"])
            ):
                raise ValueError("pin mismatch")
            os.fchmod(output.fileno(), mode)
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, target)
        fsync_dir(target.parent)
    finally:
        Path(name).unlink(missing_ok=True)


def hash_pin(path, pin):
    digest = hashlib.sha256()
    with open_regular(path, pin["size"]) as source:
        remaining = pin["size"]
        while remaining:
            chunk = source.read(min(remaining, 1024 * 1024))
            if not chunk:
                return False
            remaining -= len(chunk)
            digest.update(chunk)
        return not source.read(1) and digest.hexdigest() == pin["sha256"]


def valid_pin(value):
    return (
        isinstance(value, dict)
        and set(value) == {"size", "sha256"}
        and type(value["size"]) is int
        and 0 < value["size"] <= MAX_MEMBER
        and isinstance(value["sha256"], str)
        and HEX.fullmatch(value["sha256"])
    )


def identity(path, kind):
    if not exists(path):
        return None
    info = require_root(path, kind)
    return [info.st_dev, info.st_ino]


def exchange(left, right):
    """Never create a window without current; unsupported filesystems fail safely."""
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None:
        raise fail("atomic_exchange_unavailable")
    renameat2.argtypes = (
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    )
    renameat2.restype = ctypes.c_int
    if renameat2(-100, os.fsencode(left), -100, os.fsencode(right), 2):
        raise fail("atomic_exchange_failed")
    fsync_dir(left.parent)
    if left.parent != right.parent:
        fsync_dir(right.parent)


def durable_rename(source, target):
    source.rename(target)
    fsync_dir(target.parent)
    if source.parent != target.parent:
        fsync_dir(source.parent)


def command(argv, timeout, code, *, capture=False, success=(0,)):
    # Only fixed commands against root-owned paths reach here. Kill a fetcher's
    # verifier too if the outer timeout expires. Nothing in child output is logged.
    try:
        with tempfile.TemporaryFile() if capture else open(os.devnull, "w+b") as output:
            child = subprocess.Popen(
                argv,
                stdin=subprocess.DEVNULL,
                stdout=output,
                stderr=subprocess.DEVNULL,
                cwd="/",
                env=SYSTEM_ENV,
                start_new_session=True,
            )
            try:
                result = child.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait()
                raise fail(code + "_timeout") from None
            if result not in success:
                raise fail(code)
            if capture:
                output.seek(0)
                data = output.read(8193)
                if len(data) > 8192:
                    raise fail(code)
                return data
    except OSError:
        raise fail(code) from None


class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("localhost", timeout=1)
        self.path = str(path)

    def connect(self):
        with_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock = with_socket
        with_socket.settimeout(self.timeout)
        with_socket.connect(self.path)


class SystemService:
    def __init__(self, runtime_socket):
        self.runtime_socket = runtime_socket

    def info(self):
        raw = command(
            [
                "/usr/bin/systemctl",
                "show",
                "--no-pager",
                "-p",
                "LoadState",
                "-p",
                "ActiveState",
                "-p",
                "MainPID",
                "-p",
                "ControlGroup",
                "-p",
                "FragmentPath",
                "-p",
                "DropInPaths",
                SYSTEMD_UNIT,
            ],
            1,
            "systemd_unavailable",
            capture=True,
            success=(0, 1, 4),
        )
        info = dict(
            line.split("=", 1)
            for line in raw.decode("utf-8").splitlines()
            if "=" in line
        )
        if not info.get("LoadState") or not info.get("ActiveState"):
            raise fail("systemd_unavailable")
        return info

    def ensure_idle(self, info):
        state = info.get("ActiveState")
        if state not in {"active", "inactive", "failed"}:
            raise fail("busy", 409)
        active = state == "active"
        if active:
            try:
                # The socket may be group-writeable but its parent must not be.
                require_root(self.runtime_socket.parent, stat.S_ISDIR)
                info_socket = self.runtime_socket.lstat()
                if (
                    not stat.S_ISSOCK(info_socket.st_mode)
                    or info_socket.st_uid != 0
                    or stat.S_IMODE(info_socket.st_mode) != 0o660
                ):
                    raise fail("runtime_unreachable")
            except (OSError, ValueError):
                raise fail("runtime_unreachable") from None
            client = UnixHTTP(self.runtime_socket)
            try:
                client.request(
                    "POST",
                    "/maintenance-status",
                    b"{}",
                    {"Content-Type": "application/json"},
                )
                response = client.getresponse()
                result = parse_json(response.read(65))
                if (
                    response.status != 200
                    or not isinstance(result, dict)
                    or set(result) != {"busy"}
                    or type(result["busy"]) is not bool
                ):
                    raise fail("runtime_unreachable")
                if result["busy"]:
                    raise fail("busy", 409)
            except (OSError, http.client.HTTPException, ValueError, RecursionError):
                raise fail("runtime_unreachable") from None
            finally:
                client.close()
        # A child orphaned within the unit must not be killed by a restart. The
        # runtime admission lock prevents new children while we inspect the cgroup.
        group = info.get("ControlGroup") or "/system.slice/" + SYSTEMD_UNIT
        try:
            canonical(group)
            group_path = Path("/sys/fs/cgroup") / group[1:]
            main = int(info.get("MainPID", "0")) if active else 0
            if not Path("/sys/fs/cgroup/cgroup.controllers").exists() and active:
                raise fail("runtime_unreachable")
            if group_path.exists():
                for parent, _, _ in os.walk(
                    group_path, onerror=lambda error: (_ for _ in ()).throw(error)
                ):
                    with (Path(parent) / "cgroup.procs").open() as processes:
                        if any(int(pid) != main for pid in processes if pid.strip()):
                            raise fail("busy", 409)
            elif active:
                raise fail("runtime_unreachable")
        except (OSError, ValueError):
            raise fail("runtime_unreachable") from None

    def reload(self):
        command(["/usr/bin/systemctl", "daemon-reload"], 15, "systemd_reload_failed")

    def start(self):
        command(
            ["/usr/bin/systemctl", "restart", SYSTEMD_UNIT], 100, "service_start_failed"
        )

    def stop(self):
        command(["/usr/bin/systemctl", "stop", SYSTEMD_UNIT], 45, "service_stop_failed")

    def set_enabled(self, enabled):
        command(
            ["/usr/bin/systemctl", "enable" if enabled else "disable", SYSTEMD_UNIT],
            15,
            "service_enable_failed",
        )


def version_order(value):
    match = re.fullmatch(
        r"(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-rc\.(\d{1,9}))?", value or ""
    )
    if match is None:
        return None
    major, minor, patch, rc = match.groups()
    return int(major), int(minor), int(patch), rc is None, int(rc or 0)


def read_verifier(path):
    result = parse_json(read_root(path, 1024))
    if (
        not isinstance(result, dict)
        or set(result) != {"manifest_sha256", "code_sha256"}
        or not all(isinstance(v, str) and HEX.fullmatch(v) for v in result.values())
    ):
        raise ValueError("invalid release verifier")
    return result


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Maintenance:
    def __init__(
        self,
        install_dir,
        bundle_dir,
        *,
        runtime_dir=Path("/usr/local/lib/vm2api-gemini"),
        state_dir=Path("/var/lib/vm2api-gemini"),
        unit=Path("/etc/systemd/system/vm2api-gemini.service"),
        runtime_socket=Path("/run/vm2api-gemini/control.sock"),
        trust_dir=Path("/etc/vm2api"),
        service=None,
    ):
        if os.geteuid() != 0:
            raise ValueError("root required")
        self.install = canonical(str(install_dir))
        self.bundle = canonical(str(bundle_dir))
        self.runtime = canonical(str(runtime_dir))
        self.state = canonical(str(state_dir))
        self.unit = canonical(str(unit))
        self.runtime_socket = canonical(str(runtime_socket))
        self.trust = canonical(str(trust_dir))
        self.service = (
            service if service is not None else SystemService(self.runtime_socket)
        )
        require_root(self.install, stat.S_ISDIR)
        require_root(self.bundle, stat.S_ISDIR)
        require_root(self.unit.parent, stat.S_ISDIR)
        self.current = self.install / "share/gemini/current"
        self.transaction = self.current.parent / ".maintenance-transaction"
        self.backup = self.current.parent / ".maintenance-rollback"
        for target in (self.runtime, self.state, self.current.parent):
            if (
                target == self.bundle
                or target in self.bundle.parents
                or self.bundle in target.parents
            ):
                raise ValueError("bundle overlaps mutable targets")
        root_dir(self.state, 0o711)
        self.lockfile = self.state / "maintenance.lock"
        self.pending = self.state / "maintenance.pending"
        self.activation = self.state / "release-activation.json"
        self.public_key = self.trust / "gemini-ed25519.pub"
        self.manual_release = self.trust / "gemini-release.json"
        self.descriptor = self.bundle / "deploy/payload.json"
        self.crag_bundle = False
        self.release, self.pins, self.egress_pin = self.read_bundle()
        # Optional display metadata for manually signed manifests that use the
        # same CLI binary. The signed verifier, not this pattern, checks hashes.
        verifier_code = read_root(self.bundle / VERIFIER_FILES[1], 256 * 1024)
        cli_pin = re.search(
            rb"(?m)^export const AGY_SHA256 = '([0-9a-f]{64})'$", verifier_code
        )
        self.known_cli = cli_pin[1].decode("ascii") if cli_pin else None
        self.guard = threading.Lock()
        self.job = None
        self.verified = {}
        self.last_inspection = 0.0
        self.inspecting = False
        self.egress_ok = None

    @classmethod
    def from_config(cls, path):
        value = parse_json(read_root(canonical(str(path)), 4096))
        if not isinstance(value, dict) or set(value) != {"install_dir", "bundle_dir"}:
            raise ValueError("invalid maintenance configuration")
        return cls(canonical(value["install_dir"]), canonical(value["bundle_dir"]))

    def read_bundle(self):
        descriptor = parse_json(read_root(self.descriptor, 256 * 1024))
        catalog = parse_json(read_root(self.bundle / "catalog.json", 8192))
        if (
            not isinstance(descriptor, dict)
            or not isinstance(catalog, list)
            or len(catalog) != 1
            or not isinstance(catalog[0], dict)
            or set(catalog[0]) != {"id", "version", "cli_version"}
        ):
            raise ValueError("invalid release catalog")
        release = catalog[0]
        if (
            not isinstance(release["id"], str)
            or not IDENTIFIER.fullmatch(release["id"])
            or not all(
                isinstance(release[key], str) and SAFE_VERSION.fullmatch(release[key])
                for key in ("version", "cli_version")
            )
        ):
            raise ValueError("invalid release catalog")
        default = descriptor.get("geminiDefaultLinuxAmd64")
        if (
            not isinstance(default, dict)
            or default.get("tag") != release["id"]
            or not release["id"].endswith("-gemini-" + release["version"])
        ):
            raise ValueError("catalog does not refer to bundled Gemini tag")
        pins = default.get("assets")
        if (
            not isinstance(pins, dict)
            or set(pins) not in (set(ASSETS), set(CRAG_ASSETS))
            or not all(map(valid_pin, pins.values()))
        ):
            raise ValueError("invalid Gemini asset pins")
        self.crag_bundle = set(pins) == set(CRAG_ASSETS)
        files = descriptor.get("files")
        if not isinstance(files, list):
            raise ValueError("missing egress pin")
        entries = [
            {k: v for k, v in f.items() if k in {"size", "sha256"}}
            for f in files
            if isinstance(f, dict)
            and f.get("path") == "bin/kin-egress"
            and f.get("asset") == "kin-egress"
        ]
        if len(entries) != 1 or not valid_pin(entries[0]):
            raise ValueError("invalid egress pin")
        return release, pins, entries[0]

    @contextmanager
    def maintenance_lock(self, exclusive=True):
        fd = os.open(
            self.lockfile, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600
        )
        try:
            info = os.fstat(fd)
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != 0
                or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_nlink != 1
            ):
                raise fail("lock_invalid")
            try:
                fcntl.flock(
                    fd, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB
                )
            except BlockingIOError:
                raise fail("busy", 409) from None
            yield
        finally:
            os.close(fd)

    def start_job(self, action, release_id):
        if action not in ACTIONS or (
            release_id is not None and action not in RELEASE_ACTIONS
        ):
            raise fail("invalid_action", 400)
        if release_id is not None and release_id != self.release["id"]:
            raise fail("unknown_release", 400)
        with self.guard:
            if self.job and self.job["status"] == "running":
                raise fail("busy", 409)
            self.job = {
                "id": secrets.token_hex(16),
                "action": action,
                "status": "running",
                "phase": "checking",
                "error_code": None,
                "started_at": timestamp(),
                "finished_at": None,
            }
            admitted = self.job.copy()
            worker = threading.Thread(
                target=self.run_job, args=(action, release_id), daemon=True
            )
            worker.start()
        snapshot = self.snapshot()
        if snapshot["job"]["id"] != admitted["id"]:
            snapshot["job"] = admitted
        return snapshot

    def phase(self, phase):
        with self.guard:
            self.job["phase"] = phase

    def run_job(self, action, release_id):
        code = None
        try:
            with self.maintenance_lock(exclusive=action != "diagnose"):
                if action == "diagnose":
                    self.phase("diagnosing")
                    self.inspect()
                else:
                    info = self.service.info()
                    self.service.ensure_idle(info)
                    if exists(self.pending):
                        self.phase("restoring")
                        self.finish_transaction()
                        info = self.service.info()
                        self.service.ensure_idle(info)
                    self.operate(action, release_id, info)
        except Failure as error:
            code = error.code
        except Exception:
            code = "gemini_maintenance_operation_failed"
        finally:
            with self.guard:
                self.last_inspection = 0.0
                self.job.update(
                    status="failed" if code else "completed",
                    phase="failed" if code else "completed",
                    error_code=code,
                    finished_at=timestamp(),
                )

    def inspect_later(self):
        with self.guard:
            if self.inspecting or (self.job and self.job["status"] == "running"):
                return
            if self.last_inspection and time.monotonic() - self.last_inspection < 10:
                return
            self.inspecting = True
            self.last_inspection = time.monotonic()

        def run():
            try:
                # Inspection is read-only. Sample identities before and after
                # verification so a concurrent rename cannot cache stale facts.
                self.inspect()
            except (Failure, OSError, ValueError, RecursionError):
                pass
            finally:
                with self.guard:
                    self.inspecting = False

        threading.Thread(target=run, daemon=True).start()

    def snapshot(self):
        self.inspect_later()
        checks = []

        def check(name, status, code=None):
            checks.append({"id": name, "state": status, "code": code})

        systemd = True
        try:
            info = self.service.info()
        except (Failure, OSError, ValueError):
            info = {}
            systemd = False
        installed = exists(self.unit) or info.get("LoadState") == "loaded"
        active = info.get("ActiveState") == "active"
        supported = sys.platform == "linux" and platform.machine() in {
            "x86_64",
            "amd64",
        }
        pending = exists(self.pending)
        check(
            "platform",
            "pass" if supported else "fail",
            None if supported else "gemini_payload_unsupported_host",
        )
        check(
            "systemd",
            "pass" if systemd else "fail",
            None if systemd else "gemini_maintenance_systemd_unavailable",
        )
        check(
            "runtime_service",
            "pass" if active else "warning",
            None if active else "gemini_maintenance_service_inactive",
        )
        check(
            "maintenance",
            "fail" if pending else "pass",
            "gemini_maintenance_incomplete" if pending else None,
        )
        payload = self.payload_status(pending)
        assessment = {
            "installed": "pass",
            "awaiting_redemption": "warning",
            "unverified": "warning",
            "not_configured": "warning",
        }.get(payload["state"], "fail")
        check(
            "signed_payload",
            assessment,
            payload["issue"]
            or (
                "gemini_release_redemption_required"
                if payload["activation_required"]
                else None
            ),
        )
        with self.guard:
            egress_ok = self.egress_ok
            job = self.job.copy() if self.job else None
        check(
            "pinned_egress",
            "pass" if egress_ok else "warning" if egress_ok is None else "fail",
            (
                None
                if egress_ok
                else (
                    "gemini_maintenance_egress_unverified"
                    if egress_ok is None
                    else "gemini_maintenance_egress_invalid"
                )
            ),
        )
        tools = all(
            shutil.which(tool, path=SYSTEM_ENV["PATH"])
            for tool in ("node", "ip", "nft", "setpriv", "bwrap", "curl", "openvt")
        )
        check(
            "runtime_tools",
            "pass" if tools else "warning",
            None if tools else "gemini_oauth_tools_missing",
        )
        try:
            with open("/proc/sys/net/ipv4/ip_forward", "rb") as sysctl:
                forward = sysctl.read(4).strip() == b"1"
        except OSError:
            forward = False
        check(
            "ipv4_forwarding",
            "pass" if forward else "warning",
            None if forward else "gemini_maintenance_ipv4_forwarding_disabled",
        )
        # A local recovery is not a Google/OAuth/network qualification.
        check("google_qualification", "warning", "gemini_maintenance_google_not_tested")
        rollback = {"available": False, "version": None}
        if not pending:
            try:
                record = self.backup_record()
                unit = read_optional(self.backup / "before/unit", 65536)
                verified = self.cached_payload(
                    self.backup / "payload", unit, self.backup / "before/runtime"
                )
                if (
                    verified
                    and isinstance(verified, dict)
                    and verified["digest"] == record["digest"]
                ):
                    rollback = {"available": True, "version": verified["version"]}
            except (Failure, OSError, ValueError, RecursionError, KeyError):
                pass
        compatible = (
            supported
            and not pending
            and (
                not exists(self.current)
                or self.can_update(payload["version"], payload["cli_version"])
            )
        )
        return {
            "available": True,
            "install_dir": str(self.install),
            "service": {"installed": installed, "active": active},
            "payload": payload,
            "releases": [
                {
                    **self.release,
                    "compatible": compatible,
                    "installed": payload["state"]
                    in {"installed", "awaiting_redemption"}
                    and self.current_digest() == self.pins["manifest.json"]["sha256"],
                }
            ],
            "rollback": rollback,
            "checks": checks,
            "job": job,
        }

    def can_update(self, version, cli_version):
        installed, target = version_order(version), version_order(
            self.release["version"]
        )
        cli, target_cli = version_order(cli_version), version_order(
            self.release["cli_version"]
        )
        return (
            installed is not None
            and target is not None
            and installed <= target
            and cli is not None
            and target_cli is not None
            and cli <= target_cli
        )

    def current_digest(self):
        try:
            return hashlib.sha256(
                read_root(self.current / "manifest.json", 65536)
            ).hexdigest()
        except (OSError, ValueError):
            return None

    def unit_bytes(self):
        return read_optional(self.unit, 65536)

    def unit_args(self, data):
        if data is None:
            return {}
        text = data.decode("utf-8")
        lines = [
            line.strip()
            for line in text.splitlines()
            if line.lstrip().startswith("ExecStart=")
        ]
        if len(lines) != 1 or any(
            line.rstrip().endswith("\\") for line in text.splitlines()
        ):
            raise fail("unsupported_service_config")
        argv = lines[0][len("ExecStart=") :].split()
        if argv[:3] != [
            "/usr/bin/python3",
            "-I",
            str(self.runtime / "scripts/gemini-host.py"),
        ]:
            raise fail("unsupported_service_config")
        arg = argv[3:]
        allowed = {
            "--state",
            "--payload",
            "--payload-source",
            "--public-key",
            "--release-verifier",
            "--default-public-key",
            "--default-release-verifier",
            "--crag-host-dir",
            "--egress",
            "--socket",
            "--gateway-group",
            "--uid-base",
        }
        options = dict(zip(arg[::2], arg[1::2]))
        if (
            len(arg) % 2
            or len(arg) != 2 * len(options)
            or set(options) - allowed
            or {
                "--state",
                "--payload",
                "--public-key",
                "--egress",
                "--socket",
                "--gateway-group",
                "--uid-base",
            }
            - set(options)
            or options["--state"] != str(self.state)
            or options["--payload"] != str(self.current)
            or options["--socket"] != str(self.runtime_socket)
            or not IDENTIFIER.fullmatch(options["--gateway-group"])
            or not re.fullmatch(r"[0-9]{4,5}", options["--uid-base"])
            or ("--default-public-key" in options)
            != ("--default-release-verifier" in options)
        ):
            raise fail("unsupported_service_config")
        for name, value in options.items():
            if name not in {"--gateway-group", "--uid-base"}:
                canonical(value)
        return options

    def write_unit(self, before, default=None):
        if before is None:
            data = read_root(
                self.bundle / "deploy/gemini-host.service.example", 65536
            ).decode("utf-8")
            data = (
                data.replace("@INSTALL_DIR@", str(self.install))
                .replace("@PAYLOAD_SOURCE_ARG@", "")
                .replace("@DEFAULT_PAYLOAD_ARGS@", "")
                .replace("/usr/local/lib/vm2api-gemini/", str(self.runtime) + "/")
                .replace("/var/lib/vm2api-gemini", str(self.state))
                .replace("/run/vm2api-gemini/control.sock", str(self.runtime_socket))
                .replace("/etc/vm2api/gemini-ed25519.pub", str(self.public_key))
            )
            before = data.encode()
        options = self.unit_args(before)
        if default is None and options["--egress"] == str(
            self.runtime / "bin/kin-egress"
        ):
            return before
        options["--egress"] = str(self.runtime / "bin/kin-egress")
        if default is not None:
            if self.crag_bundle:
                options["--public-key"] = str(default / "crag-license-public.pem")
                options.pop("--default-public-key", None)
                options.pop("--default-release-verifier", None)
                default_crag_host_dir = (
                    self.install / "data/crag-gemini-subscription/public"
                    if (self.install / "data").is_dir()
                    or not (self.install / "src/data/crag-gemini-subscription").is_dir()
                    else self.install / "src/data/crag-gemini-subscription/public"
                )
                legacy_crag_host_dir = str(
                    self.install / "src/data/crag-gemini-subscription/public"
                )
                if "--crag-host-dir" not in options or (
                    options["--crag-host-dir"] == legacy_crag_host_dir
                    and not Path(legacy_crag_host_dir).is_dir()
                    and (self.install / "data").is_dir()
                ):
                    options["--crag-host-dir"] = str(default_crag_host_dir)
            else:
                options["--default-public-key"] = str(default / "gemini-ed25519.pub")
                options["--default-release-verifier"] = str(
                    default / "gemini-release.json"
                )
            # Keep a manual source. An original default source is not needed for an
            # installed payload and must not reinstall the old default if current is lost.
            source = options.get("--payload-source")
            if source and (self.runtime / "defaults") in Path(source).parents:
                options.pop("--payload-source")
        line = "ExecStart=/usr/bin/python3 -I " + str(
            self.runtime / "scripts/gemini-host.py"
        )
        line += "".join(f" {name} {value}" for name, value in options.items())
        return re.sub(rb"(?m)^[ \t]*ExecStart=[^\r\n]*", line.encode(), before, count=1)

    def is_crag_manifest(self, raw):
        manifest = parse_json(raw)
        return (
            isinstance(manifest, dict)
            and manifest.get("family") == "crag"
            and manifest.get("encrypted") is True
        )

    def payload_metadata(self, payload, unit):
        require_root(payload, stat.S_ISDIR)
        raw = read_root(payload / "manifest.json", 65536)
        crag = self.is_crag_manifest(raw)
        if not crag and len(raw) > 8192:
            raise ValueError("invalid file size")
        digest = hashlib.sha256(raw).hexdigest()
        options = self.unit_args(unit)
        if crag:
            key = Path(options.get("--public-key", self.public_key))
            if not exists(key):
                key = payload / "crag-license-public.pem"
            return raw, digest, key, None
        verifier = None
        key = Path(options.get("--public-key", self.public_key))
        default = options.get("--default-release-verifier")
        if (
            default
            and (verifier := read_verifier(Path(default)))["manifest_sha256"] == digest
        ):
            key = Path(options["--default-public-key"])
        else:
            verifier = None
            path = Path(options.get("--release-verifier", self.manual_release))
            if "--release-verifier" in options or exists(path):
                verifier = read_verifier(path)
                if verifier["manifest_sha256"] != digest:
                    raise fail("release_payload_mismatch")
        return raw, digest, key, verifier

    def verification_key(self, payload, unit, runtime):
        raw, digest, key, verifier = self.payload_metadata(payload, unit)
        members = CRAG_MEMBERS if self.is_crag_manifest(raw) else MEMBERS
        tuples = [digest, verifier, str(key)]
        for name in (payload, key, *(payload / member for member in members)):
            info = require_root(name, stat.S_ISDIR if name == payload else stat.S_ISREG)
            tuples.append(
                (
                    info.st_dev,
                    info.st_ino,
                    info.st_mode,
                    info.st_size,
                    info.st_ctime_ns,
                    info.st_mtime_ns,
                )
            )
        for root in (runtime, self.bundle):
            for member in VERIFIER_FILES:
                try:
                    info = require_root(root / member, stat.S_ISREG)
                    tuples.append(
                        (
                            info.st_dev,
                            info.st_ino,
                            info.st_mode,
                            info.st_size,
                            info.st_ctime_ns,
                            info.st_mtime_ns,
                        )
                    )
                except (OSError, ValueError):
                    tuples.append(None)
        if payload == self.current and any(
            not os.access(payload / name, os.X_OK) for name in ("agy", "craggemini")
        ):
            raise fail("payload_incomplete")
        return tuple(tuples), raw, digest, key, verifier

    def verify(self, payload, key, verifier_root, *, dest=None):
        require_root(payload, stat.S_ISDIR)
        require_root(key, stat.S_ISREG)
        raw = read_root(payload / "manifest.json", 65536)
        members = CRAG_MEMBERS if self.is_crag_manifest(raw) else MEMBERS
        for name in members:
            require_root(payload / name, stat.S_ISREG)
        for relative in VERIFIER_FILES:
            require_root(verifier_root / relative, stat.S_ISREG)
        output = command(
            [
                "/usr/bin/node",
                str(verifier_root / VERIFIER_FILES[0]),
                "--source",
                str(payload),
                "--public-key",
                str(key),
                *(["--dest", str(dest)] if dest else ["--check"]),
            ],
            45,
            "payload_invalid",
            capture=True,
        )
        match = re.fullmatch(
            rb"Gemini payload ([A-Za-z0-9][A-Za-z0-9.-]{0,63}) "
            + (b"installed\n" if dest else b"verified\n"),
            output,
        )
        if not match:
            raise fail("payload_invalid")
        return match[1].decode("ascii")

    def verify_existing(self, payload, unit, runtime=None):
        runtime = runtime or self.runtime
        fingerprint, raw, digest, key, verifier = self.verification_key(
            payload, unit, runtime
        )
        for root in dict.fromkeys((runtime, self.bundle)):
            try:
                version = self.verify(payload, key, root)
                break
            except (Failure, OSError, ValueError):
                continue
        else:
            with self.guard:
                self.verified[str(payload)] = (
                    fingerprint,
                    "gemini_maintenance_payload_invalid",
                )
            raise fail("payload_invalid")
        if self.verification_key(payload, unit, runtime)[0] != fingerprint:
            raise fail("payload_changed")
        manifest = parse_json(raw)
        if self.is_crag_manifest(raw):
            members = {
                name: (
                    require_root(payload / name, stat.S_ISREG).st_size,
                    sha_hex,
                )
                for name, sha_hex in manifest["sha256"].items()
            }
        else:
            members = {
                member["name"]: (member["size"], member["sha256"])
                for member in manifest["files"]
            }
        cli = (
            self.release["cli_version"]
            if digest == self.pins["manifest.json"]["sha256"]
            else None
        )
        # The schema-1 manifest has no CLI version field. For custom packages,
        # report a version only when the verified manifest uses the known pinned CLI.
        if cli is None:
            declared = manifest.get("cli_version")
            if isinstance(declared, str) and SAFE_VERSION.fullmatch(declared):
                cli = declared
            elif self.known_cli is not None and members["agy"][1] == self.known_cli:
                cli = self.release["cli_version"]
        result = {
            "version": version,
            "digest": digest,
            "members": members,
            "cli_version": cli,
            "key": key,
            "release": verifier,
            "verifier_root": root,
        }
        with self.guard:
            self.verified[str(payload)] = (fingerprint, result)
        return result

    def cached_payload(self, payload, unit, runtime=None):
        try:
            fingerprint = self.verification_key(payload, unit, runtime or self.runtime)[
                0
            ]
        except Failure as error:
            return error.code
        except (OSError, ValueError, RecursionError):
            return "gemini_maintenance_payload_invalid"
        with self.guard:
            entry = self.verified.get(str(payload))
        return entry[1] if entry and entry[0] == fingerprint else None

    def payload_status(self, pending):
        result = {
            "state": "not_configured",
            "version": None,
            "cli_version": None,
            "activation_required": False,
            "issue": None,
        }
        if pending:
            return {
                **result,
                "state": "invalid",
                "issue": "gemini_maintenance_incomplete",
            }
        if not exists(self.current):
            return {**result, "issue": "gemini_payload_not_installed"}
        try:
            verified = self.cached_payload(self.current, self.unit_bytes())
        except (OSError, ValueError):
            verified = "gemini_maintenance_payload_invalid"
        if verified is None:
            return {
                **result,
                "state": "unverified",
                "issue": "gemini_maintenance_payload_unverified",
            }
        if isinstance(verified, str):
            return {**result, "state": "invalid", "issue": verified}
        locked = False
        if verified["release"] is not None:
            try:
                locked = read_verifier(self.activation) != verified["release"]
            except (OSError, ValueError, RecursionError):
                locked = True
        return {
            **result,
            "state": "awaiting_redemption" if locked else "installed",
            "version": verified["version"],
            "cli_version": verified["cli_version"],
            "activation_required": locked,
        }

    def inspect(self):
        if exists(self.pending):
            return
        try:
            egress_ok = hash_pin(self.runtime / "bin/kin-egress", self.egress_pin)
            if egress_ok:
                egress_ok = os.access(self.runtime / "bin/kin-egress", os.X_OK)
        except (OSError, ValueError):
            egress_ok = False
        with self.guard:
            self.egress_ok = egress_ok
        for payload, unit, runtime in (
            (self.current, self.unit, self.runtime),
            (
                self.backup / "payload",
                self.backup / "before/unit",
                self.backup / "before/runtime",
            ),
        ):
            try:
                if exists(payload):
                    config = read_optional(unit, 65536)
                    if self.cached_payload(payload, config, runtime) is None:
                        self.verify_existing(payload, config, runtime)
            except (Failure, OSError, ValueError, RecursionError):
                pass

    def stage_pinned(self):
        if sys.platform != "linux" or platform.machine() not in {"x86_64", "amd64"}:
            raise fail("unsupported_host")
        self.phase("fetching")
        source = self.transaction / "source"
        fetcher = self.bundle / "scripts/fetch-default-gemini.py"
        for entry in (
            fetcher,
            self.descriptor,
            *(self.bundle / name for name in VERIFIER_FILES),
        ):
            require_root(entry, stat.S_ISREG)
        command(
            [
                "/usr/bin/python3",
                "-I",
                str(fetcher),
                "--manifest",
                str(self.descriptor),
                "--dest",
                str(source),
            ],
            600,
            "fetch_failed",
        )
        self.phase("verifying")
        expected_assets = CRAG_ASSETS if self.crag_bundle else ASSETS
        if not all(hash_pin(source / name, self.pins[name]) for name in expected_assets):
            raise fail("payload_pin_mismatch")
        digest = self.pins["manifest.json"]["sha256"]
        if self.crag_bundle:
            key = source / "crag-license-public.pem"
        else:
            key = source / "gemini-ed25519.pub"
            lock = read_verifier(source / "gemini-release.json")
            if lock["manifest_sha256"] != digest:
                raise fail("release_payload_mismatch")
        candidate = self.transaction / "payload"
        if (
            self.verify(source, key, self.bundle, dest=candidate)
            != self.release["version"]
        ):
            raise fail("release_payload_mismatch")
        manifest_raw = read_root(candidate / "manifest.json", 65536)
        manifest = parse_json(manifest_raw)
        if self.crag_bundle:
            members = {
                name: (
                    require_root(candidate / name, stat.S_ISREG).st_size,
                    sha_hex,
                )
                for name, sha_hex in manifest["sha256"].items()
            }
        else:
            members = {
                member["name"]: (member["size"], member["sha256"])
                for member in manifest["files"]
            }
        defaults = self.runtime / "defaults"
        root_dir(defaults, 0o700)
        default = defaults / digest
        root_dir(default, 0o700)
        trust_files = (
            ("crag-license-public.pem",)
            if self.crag_bundle
            else ("gemini-ed25519.pub", "gemini-release.json")
        )
        for name in trust_files:
            if exists(default / name):
                if not hash_pin(default / name, self.pins[name]):
                    raise fail("default_trust_conflict")
            else:
                copy_file(
                    source / name,
                    default / name,
                    0o644 if self.crag_bundle else 0o600,
                    pin=self.pins[name],
                )
        shutil.rmtree(source)
        return default, digest, members

    def backup_record(self):
        value = parse_json(read_root(self.backup / "good.json", 4096))
        if (
            not isinstance(value, dict)
            or set(value) != {"digest"}
            or not isinstance(value["digest"], str)
            or not HEX.fullmatch(value["digest"])
        ):
            raise fail("rollback_invalid")
        return value

    def prepare_runtime(
        self, *, keep_existing=False, verifier_root=None, rollback=False
    ):
        previous = self.transaction / "before/runtime"
        target = self.transaction / "after/runtime"
        self.phase("preparing_runtime")
        for relative in RUNTIME_FILES:
            current = self.runtime / relative
            egress = relative == "bin/kin-egress"
            mode = 0o755 if egress else 0o644
            if egress:
                if self.egress_matches(current):
                    mode = stat.S_IMODE(require_root(current, stat.S_ISREG).st_mode)
                    copy_file(current, previous / relative, mode, pin=self.egress_pin)
                self.prepare_egress(target / relative, current)
                continue
            if exists(current):
                copy_file(
                    current,
                    previous / relative,
                    stat.S_IMODE(require_root(current, stat.S_ISREG).st_mode),
                )
            if rollback:
                archived = self.backup / "before/runtime" / relative
                source = archived if exists(archived) else self.bundle / relative
            elif relative in VERIFIER_FILES and verifier_root is not None:
                source = verifier_root / relative
            else:
                source = (
                    current
                    if keep_existing and exists(current)
                    else self.bundle / relative
                )
            copy_file(source, target / relative, mode)

    def egress_matches(self, path):
        try:
            return hash_pin(path, self.egress_pin)
        except (OSError, ValueError):
            return False

    def prepare_egress(self, target, current):
        candidate = self.bundle / "bin/kin-egress"
        try:
            if self.egress_matches(current):
                copy_file(current, target, 0o755, pin=self.egress_pin)
            elif exists(candidate):
                copy_file(candidate, target, 0o755, pin=self.egress_pin)
            else:
                copy_file(
                    self.install / "bin/kin-egress",
                    target,
                    0o755,
                    pin=self.egress_pin,
                    trusted=False,
                )
        except (OSError, ValueError):
            raise fail("egress_pin_mismatch") from None

    def prepare_dependencies(self):
        tools = ("node", "python3", "ip", "nft", "setpriv", "bwrap", "curl", "openvt")
        if all(shutil.which(tool, path=SYSTEM_ENV["PATH"]) for tool in tools):
            return
        if not Path("/usr/bin/apt-get").is_file():
            raise fail("dependencies_missing")
        self.phase("dependencies")
        command(
            ["/usr/bin/apt-get", "-o", "DPkg::Lock::Timeout=30", "update"],
            300,
            "dependencies_failed",
        )
        command(
            [
                "/usr/bin/apt-get",
                "-o",
                "DPkg::Lock::Timeout=30",
                "install",
                "-y",
                "--no-install-recommends",
                "nodejs",
                "python3",
                "iproute2",
                "nftables",
                "util-linux",
                "bubblewrap",
                "curl",
                "kbd",
            ],
            600,
            "dependencies_failed",
        )
        if not all(shutil.which(tool, path=SYSTEM_ENV["PATH"]) for tool in tools):
            raise fail("dependencies_missing")

    def operate(self, action, release_id, service_info):
        if service_info.get("DropInPaths") or (
            service_info.get("FragmentPath") or str(self.unit)
        ) != str(self.unit):
            # Do not restart or reinterpret a manually overridden unit using a
            # different trust or payload policy. An operator must reconcile it.
            raise fail("unsupported_service_config")
        if action in {"install", "repair", "recover"}:
            self.prepare_dependencies()
        before = self.unit_bytes()
        options = self.unit_args(before)
        root_dir(self.current.parent)
        root_dir(self.runtime)
        if exists(self.transaction):
            require_root(self.transaction, stat.S_ISDIR)
            shutil.rmtree(self.transaction)
        root_dir(self.transaction, 0o700)
        try:
            self.phase("verifying")
            activated = read_optional(self.activation, 1024)
            current_id = identity(self.current, stat.S_ISDIR)
            current = None
            digest = None
            if current_id is not None:
                try:
                    digest = hashlib.sha256(
                        read_root(self.current / "manifest.json", 65536)
                    ).hexdigest()
                    current = self.verify_existing(self.current, before)
                except (Failure, OSError, ValueError, RecursionError):
                    pass
            target_unit = before
            new_activation = activated
            preserve_runtime = (
                current is not None
                and current["digest"] != self.pins["manifest.json"]["sha256"]
            )
            verifier_root = current["verifier_root"] if current is not None else None
            rollback = action == "rollback"
            if rollback:
                record = self.backup_record()
                previous_unit = read_optional(self.backup / "before/unit", 65536)
                previous_runtime = self.backup / "before/runtime"
                previous_payload = self.backup / "payload"
                previous = self.verify_existing(
                    previous_payload, previous_unit, previous_runtime
                )
                if previous["digest"] != record["digest"]:
                    raise fail("rollback_invalid")
                self.verify(
                    previous_payload,
                    previous["key"],
                    previous["verifier_root"],
                    dest=self.transaction / "payload",
                )
                target_unit = previous_unit
                new_activation = read_optional(self.backup / "before/activation", 1024)
            elif action in {"update_cli", "update_native"}:
                if current is None:
                    raise fail("update_requires_valid_payload", 409)
                if not self.can_update(current["version"], current["cli_version"]):
                    raise fail("downgrade_blocked", 409)
                if current["digest"] == self.pins["manifest.json"]["sha256"]:
                    return
                default, _, members = self.stage_pinned()
                if action == "update_cli" and any(
                    members[m] != current["members"][m]
                    for m in ("craggemini", "libagy_bridge.so")
                ):
                    raise fail("cli_incompatible", 409)
                target_unit = self.write_unit(before, default)
                new_activation = None
                preserve_runtime = False
                verifier_root = self.bundle
            elif current is None:
                pinned_digest = self.pins["manifest.json"]["sha256"]
                source = options.get("--payload-source")
                materialized = False
                if source and (self.runtime / "defaults") not in Path(source).parents:
                    if release_id is not None:
                        raise fail("manual_source_configured", 409)
                    source = Path(source)
                    candidate = self.verify_existing(source, before)
                    if current_id is not None and candidate["digest"] != digest:
                        raise fail("repair_release_unknown", 409)
                    self.verify(
                        source,
                        candidate["key"],
                        candidate["verifier_root"],
                        dest=self.transaction / "payload",
                    )
                    preserve_runtime = True
                    verifier_root = candidate["verifier_root"]
                    materialized = True
                if not materialized:
                    if current_id is not None and digest != pinned_digest:
                        raise fail("repair_release_unknown", 409)
                    if current_id is None:
                        # A missing custom payload may not be silently replaced by a
                        # default just because the installer has a pinned catalog.
                        if (
                            "--release-verifier" in options
                            or exists(self.manual_release)
                            or (
                                before is not None
                                and Path(options["--public-key"]) != self.public_key
                            )
                            or (
                                "--default-release-verifier" not in options
                                and exists(self.public_key)
                            )
                        ):
                            raise fail("manual_source_required", 409)
                        if "--default-release-verifier" in options:
                            configured = read_verifier(
                                Path(options["--default-release-verifier"])
                            )
                            if configured["manifest_sha256"] != pinned_digest:
                                raise fail("repair_release_unknown", 409)
                    default, _, _ = self.stage_pinned()
                    target_unit = self.write_unit(before, default)
                    if current_id is None:
                        new_activation = None
                    verifier_root = self.bundle
            target_unit = self.write_unit(target_unit)
            self.prepare_runtime(
                keep_existing=preserve_runtime,
                verifier_root=verifier_root,
                rollback=rollback,
            )
            root_dir(self.transaction / "before", 0o700)
            root_dir(self.transaction / "after", 0o700)
            atomic_file(self.transaction / "before/unit", before)
            atomic_file(self.transaction / "before/activation", activated)
            atomic_file(self.transaction / "after/unit", target_unit)
            atomic_file(self.transaction / "after/activation", new_activation)
            candidate_id = identity(self.transaction / "payload", stat.S_ISDIR)
            good = current is not None and candidate_id is not None
            if good:
                atomic_file(
                    self.transaction / "good.json",
                    json.dumps({"digest": current["digest"]}).encode(),
                )
            sync_tree(self.transaction)
            fsync_dir(self.transaction.parent)
            journal = {
                "directory": identity(self.transaction, stat.S_ISDIR),
                "previous": current_id,
                "candidate": candidate_id,
                "active": service_info.get("ActiveState") == "active",
                "new_unit": before is None,
                "known_good": good,
                "committed": False,
            }
            self.journal(journal)
            try:
                self.phase("applying")
                if candidate_id is not None:
                    if current_id is not None:
                        exchange(self.transaction / "payload", self.current)
                    else:
                        durable_rename(self.transaction / "payload", self.current)
                self.apply_inputs(self.transaction / "after")
                self.phase("starting")
                self.service.reload()
                self.service.start()
                self.verify_existing(self.current, self.unit_bytes())
                if journal["new_unit"]:
                    self.service.set_enabled(True)
                journal["committed"] = True
                self.journal(journal)
            except (Failure, OSError, ValueError, RecursionError):
                self.phase("restoring")
                self.finish_transaction()
                raise
            self.finish_transaction()
        finally:
            if not exists(self.pending) and exists(self.transaction):
                shutil.rmtree(self.transaction)

    def journal(self, value):
        atomic_file(self.pending, json.dumps(value, separators=(",", ":")).encode())

    def apply_inputs(self, tree):
        for relative in RUNTIME_FILES:
            target = self.runtime / relative
            source = tree / "runtime" / relative
            if exists(source):
                mode = stat.S_IMODE(require_root(source, stat.S_ISREG).st_mode)
                pin = self.egress_pin if relative == "bin/kin-egress" else None
                copy_file(source, target, mode, pin=pin)
            elif exists(target):
                require_root(target, stat.S_ISREG)
                target.unlink()
                fsync_dir(target.parent)
        atomic_file(self.unit, read_optional(tree / "unit", 65536), 0o644)
        atomic_file(self.activation, read_optional(tree / "activation", 1024))

    def finish_transaction(self):
        value = parse_json(read_root(self.pending, 4096))
        keys = {
            "directory",
            "previous",
            "candidate",
            "active",
            "new_unit",
            "known_good",
            "committed",
        }

        def is_identity(item):
            return (
                isinstance(item, list)
                and len(item) == 2
                and all(type(i) is int and i >= 0 for i in item)
            )

        if (
            not isinstance(value, dict)
            or set(value) != keys
            or not is_identity(value["directory"])
            or any(
                value[k] is not None and not is_identity(value[k])
                for k in ("previous", "candidate")
            )
            or any(
                type(value[k]) is not bool
                for k in ("active", "new_unit", "known_good", "committed")
            )
        ):
            raise fail("journal_invalid")
        tx_id = identity(self.transaction, stat.S_ISDIR)
        if value["committed"]:
            if (
                value["known_good"]
                and identity(self.backup, stat.S_ISDIR) != value["directory"]
            ):
                if tx_id != value["directory"]:
                    raise fail("journal_invalid")
                after = self.transaction / "after"
                if exists(after):
                    shutil.rmtree(after)
                    fsync_dir(self.transaction)
                if exists(self.backup):
                    exchange(self.transaction, self.backup)
                else:
                    durable_rename(self.transaction, self.backup)
        else:
            if tx_id != value["directory"]:
                raise fail("journal_invalid")
            active_id = identity(self.current, stat.S_ISDIR)
            previous, candidate = value["previous"], value["candidate"]
            # An interrupted exchange is recognized by directory identity, even
            # if the daemon died immediately after renameat2 returned.
            if not value["active"] and exists(self.unit):
                self.service.stop()
            if value["new_unit"] and exists(self.unit):
                self.service.set_enabled(False)
            if candidate is not None and active_id == candidate:
                staged = self.transaction / "payload"
                if identity(staged, stat.S_ISDIR) != previous:
                    raise fail("journal_invalid")
                if previous is None:
                    durable_rename(self.current, staged)
                else:
                    exchange(self.current, staged)
            elif active_id != previous:
                raise fail("journal_invalid")
            self.apply_inputs(self.transaction / "before")
            self.service.reload()
            if value["active"]:
                self.service.start()
        atomic_file(self.pending, None)
        if exists(self.transaction):
            shutil.rmtree(self.transaction)


HEADER_TOKEN = re.compile(rb"[!#$%&'*+.^_`|~0-9A-Za-z-]+")
CONTENT_TYPE = re.compile(
    rb"application/json(?:[ \t]*;[ \t]*charset=utf-8)?", re.IGNORECASE
)
RESPONSES = {
    200: "OK",
    202: "Accepted",
    400: "Bad Request",
    403: "Forbidden",
    404: "Not Found",
    405: "Method Not Allowed",
    408: "Request Timeout",
    409: "Conflict",
    413: "Content Too Large",
    415: "Unsupported Media Type",
    431: "Request Header Fields Too Large",
    503: "Service Unavailable",
}


def get_peer_groups(connection):
    # Linux SO_PEERGROUPS gives the credentials captured on connect. Looking up
    # a username's groups would accept grants the peer has not actually acquired.
    raw = connection.getsockopt(
        socket.SOL_SOCKET, getattr(socket, "SO_PEERGROUPS", 59), 1024
    )
    return {gid for (gid,) in struct.iter_unpack("=I", raw)}


def allowed_peer(connection, group):
    try:
        _, uid, gid = struct.unpack(
            "=iII", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
        )
        return uid == 0 or gid == group or group in get_peer_groups(connection)
    except (OSError, struct.error):
        return False


class ControlHandler(socketserver.BaseRequestHandler):
    def receive(self, size, deadline):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise fail("request_timeout", 408)
        self.request.settimeout(remaining)
        block = self.request.recv(size)
        if not block:
            raise fail("invalid_request", 400)
        return block

    def request_data(self):
        deadline = time.monotonic() + REQUEST_TIMEOUT
        raw = bytearray()
        while b"\r\n\r\n" not in raw:
            if len(raw) >= HEADER_LIMIT:
                raise fail("headers_too_large", 431)
            raw.extend(self.receive(min(4096, HEADER_LIMIT - len(raw)), deadline))
        head, body = raw.split(b"\r\n\r\n", 1)
        line, *header_lines = bytes(head).split(b"\r\n")
        parts = line.split(b" ")
        if (
            len(parts) != 3
            or not HEADER_TOKEN.fullmatch(parts[0])
            or parts[2] not in {b"HTTP/1.0", b"HTTP/1.1"}
        ):
            raise fail("invalid_request", 400)
        method, target, _ = parts
        if method != b"POST":
            raise fail("method_not_allowed", 405)
        if target not in {b"/status", b"/jobs"}:
            raise fail("not_found", 404)
        headers = {}
        for line in header_lines:
            name, delimiter, value = line.partition(b":")
            name = name.lower()
            if (
                not delimiter
                or not HEADER_TOKEN.fullmatch(name)
                or name in headers
                or any(byte < 32 and byte != 9 or byte == 127 for byte in value)
            ):
                raise fail("invalid_request", 400)
            headers[name] = value.strip(b" \t")
        if {
            b"transfer-encoding",
            b"expect",
            b"upgrade",
            b"content-encoding",
        } & headers.keys():
            raise fail("invalid_request", 400)
        length = headers.get(b"content-length", b"")
        if not re.fullmatch(rb"[1-9][0-9]{0,9}", length):
            raise fail("invalid_request", 400)
        count = int(length)
        if count > BODY_LIMIT:
            raise fail("body_too_large", 413)
        if not CONTENT_TYPE.fullmatch(headers.get(b"content-type", b"")):
            raise fail("unsupported_media_type", 415)
        if len(body) > count:
            raise fail("invalid_request", 400)
        while len(body) < count:
            body.extend(self.receive(count - len(body), deadline))
        try:
            data = parse_json(body)
        except (ValueError, RecursionError):
            raise fail("invalid_request", 400) from None
        if not isinstance(data, dict):
            raise fail("invalid_request", 400)
        return target, data

    def dispatch(self):
        if not allowed_peer(self.request, self.server.gid):
            raise fail("forbidden", 403)
        target, data = self.request_data()
        if target == b"/status":
            if data:
                raise fail("invalid_request", 400)
            return 200, self.server.maintenance.snapshot()
        if set(data) not in ({"action"}, {"action", "release_id"}):
            raise fail("invalid_request", 400)
        action = data["action"]
        if not isinstance(action, str) or action not in ACTIONS:
            raise fail("invalid_action", 400)
        release = data.get("release_id")
        if "release_id" in data and (
            action not in RELEASE_ACTIONS
            or not isinstance(release, str)
            or not IDENTIFIER.fullmatch(release)
        ):
            raise fail("invalid_release", 400)
        return 202, self.server.maintenance.start_job(action, release)

    def handle(self):
        try:
            status, value = self.dispatch()
            encoded = json.dumps(
                value, ensure_ascii=True, separators=(",", ":"), allow_nan=False
            ).encode("ascii")
            if len(encoded) > SNAPSHOT_LIMIT:
                raise fail("snapshot_too_large")
        except TimeoutError:
            status, encoded = 408, b'{"code":"gemini_maintenance_request_timeout"}'
        except Failure as error:
            status, encoded = error.status, json.dumps({"code": error.code}).encode(
                "ascii"
            )
        except Exception:
            status, encoded = 503, b'{"code":"gemini_maintenance_operation_failed"}'
        try:
            self.request.settimeout(1)
            headers = (
                f"HTTP/1.1 {status} {RESPONSES[status]}\r\nContent-Type: application/json\r\n"
                f"Content-Length: {len(encoded)}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
            )
            self.request.sendall(headers.encode("ascii") + encoded)
        except OSError:
            pass


class ControlServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    request_queue_size = 16

    def __init__(self, path, maintenance, gid):
        self.maintenance = maintenance
        self.gid = gid
        self.capacity = threading.BoundedSemaphore(8)
        super().__init__(str(path), ControlHandler)
        self.timeout = 0.25

    def process_request(self, request, address):
        if not self.capacity.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.capacity.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.capacity.release()

    def handle_error(self, *_):
        # socketserver normally logs the full exception and client address.
        pass


def socket_identity(path):
    if not exists(path):
        return None
    info = path.lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != 0:
        raise ValueError("unsafe socket path")
    return info.st_dev, info.st_ino


def serve(daemon, socket_path, gid, *, stop=None):
    require_root(socket_path.parent, stat.S_ISDIR)
    existing = socket_identity(socket_path)
    if existing is not None:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
            peer.settimeout(0.25)
            try:
                peer.connect(str(socket_path))
            except ConnectionRefusedError:
                if socket_identity(socket_path) != existing:
                    raise ValueError("socket changed") from None
                socket_path.unlink()
            else:
                raise ValueError("socket already bound")
    stop = stop if stop is not None else threading.Event()
    bound = None
    try:
        with ControlServer(socket_path, daemon, gid) as server:
            bound = socket_identity(socket_path)
            os.chown(socket_path, 0, gid, follow_symlinks=False)
            socket_path.chmod(0o660)
            notify = os.environ.get("NOTIFY_SOCKET")
            if notify:
                with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as readiness:
                    readiness.connect(
                        "\0" + notify[1:] if notify.startswith("@") else notify
                    )
                    readiness.sendall(b"READY=1")
            while not stop.is_set():
                server.handle_request()
    finally:
        if bound is not None and socket_identity(socket_path) == bound:
            socket_path.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    try:
        maintenance = Maintenance.from_config(canonical(args.config))
        serve(maintenance, SOCKET, grp.getgrnam("vm2api").gr_gid, stop=stop)
    except (Failure, OSError, ValueError, KeyError, RecursionError):
        print("Gemini maintenance setup failed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
