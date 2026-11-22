#!/usr/bin/env python3
"""Offline root smoke: run on private /opt (e.g. a network-isolated root namespace).

No service manager, download server, credentials, or real CLI are used. The
fetcher's network boundary is replaced by a local copy; its pin checks and the
real Ed25519/member verifier still run in separate, isolated commands.
"""

from contextlib import contextmanager
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time


REPO = Path(__file__).resolve().parents[2]
OLDER, PINNED, NEWER = "0.3.0-rc.1", "0.3.0-rc.2", "0.4.0"
EGRESS = b"offline fixture egress (never executed)\n"


def load_broker():
    source = REPO / "scripts/gemini-maintenance.py"
    spec = importlib.util.spec_from_file_location("gemini_maintenance", source)
    broker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(broker)
    return broker


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write_json(target, value):
    target.write_text(json.dumps(value, separators=(",", ":")), encoding="utf-8")


def openssl(*args):
    subprocess.run(
        ["/usr/bin/openssl", *map(str, args)],
        check=True,
        timeout=10,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def make_source(root, name, version, cli, native, *, bad_signature=False):
    path = root / name
    path.mkdir(mode=0o700)
    private = path / "test-only.key"
    openssl("genpkey", "-algorithm", "Ed25519", "-out", private)
    openssl("pkey", "-in", private, "-pubout", "-out", path / "gemini-ed25519.pub")
    members = {
        "craggemini": native,
        "libagy_bridge.so": b"fixture bridge",
        "agy": f"fixture CLI {cli}\n".encode(),
    }
    manifest = path / "manifest.json"
    write_json(
        manifest,
        {
            "schema": 1,
            "platform": "linux-amd64",
            "version": version,
            "cli_version": cli,
            "files": [
                {"name": file, "sha256": sha(data), "size": len(data)}
                for file, data in members.items()
            ],
        },
    )
    sig = path / "manifest.sig"
    openssl(
        "pkeyutl", "-sign", "-rawin", "-inkey", private, "-in", manifest, "-out", sig
    )
    private.unlink()
    if bad_signature:
        signature = sig.read_bytes()
        sig.write_bytes(bytes([signature[0] ^ 1]) + signature[1:])
    for file, data in members.items():
        (path / file).write_bytes(data)
    write_json(
        path / "gemini-release.json",
        {
            "manifest_sha256": sha(manifest.read_bytes()),
            "code_sha256": sha((name + " local fixture redemption").encode()),
        },
    )
    return path


def make_bundle(root, source, broker):
    bundle = root / (source.name + "-bundle")
    manifest = json.loads((source / "manifest.json").read_bytes())
    version, cli = manifest["version"], manifest["cli_version"]
    tag = "offline-fixture-gemini-" + version
    for relative in (*broker.RUNTIME_FILES[:-1], "deploy/gemini-host.service.example"):
        target = bundle / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(REPO / relative, target)
    verifier = bundle / "src/lib/gemini/payload.mjs"
    # Change only the fixture hash/version policy. Signatures, signed manifest
    # parsing, member verification, and staging are unmodified production code.
    code = verifier.read_text(encoding="utf-8")
    code = re.sub(
        r"AGY_SHA256 = '[0-9a-f]{64}'",
        f"AGY_SHA256 = '{sha((source / 'agy').read_bytes())}'",
        code,
    )
    code = code.replace(
        "'0.3.0-rc.1', '0.3.0-rc.2'", "'0.3.0-rc.1', '0.3.0-rc.2', '0.4.0'"
    )
    verifier.write_text(code, encoding="utf-8")
    shutil.copyfile(
        REPO / "scripts/fetch-default-gemini.py",
        bundle / "scripts/production-fetcher.py",
    )
    fetcher = bundle / "scripts/fetch-default-gemini.py"
    fetcher.write_text(
        f"""import runpy, shutil, sys
from pathlib import Path
fetcher = runpy.run_path(str(Path(__file__).with_name('production-fetcher.py')))
main = fetcher['main']
main.__globals__.update(VERSION={version!r}, TAG={tag!r})
dest = Path(sys.argv[sys.argv.index('--dest') + 1])
shutil.copytree({str(source)!r}, dest)
sys.exit(main())
""",
        encoding="utf-8",
    )
    pins = {
        name: {"size": len(data), "sha256": sha(data)}
        for name in broker.ASSETS
        for data in [(source / name).read_bytes()]
    }
    write_json(
        bundle / "deploy/payload.json",
        {
            "geminiDefaultLinuxAmd64": {"tag": tag, "assets": pins},
            "files": [
                {
                    "path": "bin/kin-egress",
                    "asset": "kin-egress",
                    "size": len(EGRESS),
                    "sha256": sha(EGRESS),
                }
            ],
        },
    )
    write_json(
        bundle / "catalog.json", [{"id": tag, "version": version, "cli_version": cli}]
    )
    return bundle, tag


class OfflineService:
    """Test-only service-manager boundary; all filesystem transactions stay real."""

    def __init__(self, broker, unit):
        self.broker = broker
        self.unit = unit
        self.active = False
        self.busy = False
        self.fail_next_start = False
        self.start_entered = threading.Event()
        self.allow_start = None

    def info(self):
        installed = self.unit.is_file()
        return {
            "LoadState": "loaded" if installed else "not-found",
            "ActiveState": "active" if self.active else "inactive",
            "FragmentPath": str(self.unit) if installed else "",
            "DropInPaths": "",
        }

    def ensure_idle(self, _info):
        if self.busy:
            raise self.broker.fail("busy", 409)

    def reload(self):
        pass

    def start(self):
        self.start_entered.set()
        if self.allow_start is not None:
            assert self.allow_start.wait(10)
        if self.fail_next_start:
            self.fail_next_start = False
            raise self.broker.fail("service_start_failed")
        assert self.unit.is_file()
        self.active = True

    def stop(self):
        self.active = False

    def set_enabled(self, _enabled):
        assert self.unit.is_file()


class Fixture:
    def __init__(self, root, broker):
        self.broker = broker
        self.install = root / "app"
        self.runtime = root / "runtime"
        self.state = root / "state"
        self.unit = root / "units/vm2api-gemini.service"
        self.trust = root / "trust"
        self.socket = root / "control.sock"
        self.runtime_socket = root / "runtime.sock"
        self.current = self.install / "share/gemini/current"
        self.activation = self.state / "release-activation.json"
        self.pending = self.state / "maintenance.pending"
        self.account = self.state / "environments.json"
        self.egress = self.install / "bin/kin-egress"
        self.service = OfflineService(broker, self.unit)
        # bwrap may map only root. Keep the real broker mode/GID test enabled
        # even when the non-root supplementary-credentials check cannot run.
        gid_map = (
            tuple(map(int, line.split()))
            for line in Path("/proc/self/gid_map").read_text().splitlines()
        )
        self.gid = (
            31000
            if any(start <= 31000 < start + count for start, _, count in gid_map)
            else 0
        )
        for path in (self.state, self.trust, self.egress.parent, self.unit.parent):
            path.mkdir(parents=True)
        self.egress.write_bytes(EGRESS)
        self.account.write_bytes(
            b'{"offline-fixture":"never-serialize-these-account-bytes"}'
        )
        self.accounts_before = self.account.read_bytes()

    def daemon(self, bundle):
        return self.broker.Maintenance(
            self.install,
            bundle,
            runtime_dir=self.runtime,
            state_dir=self.state,
            unit=self.unit,
            runtime_socket=self.runtime_socket,
            trust_dir=self.trust,
            service=self.service,
        )

    @contextmanager
    def serve(self, daemon):
        stop = threading.Event()
        server = threading.Thread(
            target=self.broker.serve,
            args=(daemon, self.socket, self.gid),
            kwargs={"stop": stop},
        )
        server.start()
        try:
            await_condition(
                lambda: self.socket.is_socket()
                and stat.S_IMODE(self.socket.stat().st_mode) == 0o660
            )
            assert (
                self.socket.stat().st_uid == 0 and self.socket.stat().st_gid == self.gid
            )
            yield
        finally:
            stop.set()
            server.join(5)
            assert not server.is_alive()
            await_condition(lambda: not daemon.inspecting)

    def http(self, target, value=None, *, body=None, method="POST", headers=None):
        client = self.broker.UnixHTTP(self.socket)
        client.timeout = 4
        try:
            try:
                client.request(
                    method,
                    target,
                    body if body is not None else json.dumps(value).encode(),
                    {"Content-Type": "application/json", **(headers or {})},
                )
            except BrokenPipeError:
                # A peer/method rejection may arrive before the body write.
                # Still require the actual HTTP response; never retry the job.
                pass
            response = client.getresponse()
            data = response.read(self.broker.SNAPSHOT_LIMIT + 1)
            assert "never-serialize-these-account-bytes" not in data.decode()
            assert len(data) <= self.broker.SNAPSHOT_LIMIT
            return response.status, json.loads(data)
        finally:
            client.close()

    def status(self):
        code, value = self.http("/status", {})
        assert code == 200, value
        return value

    def submit(self, action, release=None):
        body = {"action": action}
        if release is not None:
            body["release_id"] = release
        status, value = self.http("/jobs", body)
        assert status == 202, value
        return value["job"]["id"]

    def finish(self, job_id, error=None):
        def settled():
            status = self.status()
            job = status["job"]
            assert job["id"] == job_id
            return status if job["status"] != "running" else None

        result = await_condition(settled)
        job = result["job"]
        assert job["status"] == ("failed" if error else "completed"), job
        assert job["error_code"] == (
            f"gemini_maintenance_{error}" if error else None
        ), job
        assert self.account.read_bytes() == self.accounts_before
        return result

    def job(self, action, release=None, error=None):
        return self.finish(self.submit(action, release), error)

    def manifest(self):
        return (self.current / "manifest.json").read_bytes()

    def redeemed(self, source):
        record = (source / "gemini-release.json").read_bytes()
        self.activation.write_bytes(record)
        return record


def await_condition(predicate, seconds=25):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = predicate()
        if value:
            return value
        time.sleep(0.03)
    raise AssertionError("fixture operation timed out")


def peer_cases(fixture):
    # Some single-UID user namespaces disallow changing IDs. With mapped IDs,
    # prove supplementary membership works and a different peer receives 403.
    if fixture.gid == 0:
        return
    for groups, expected in (([fixture.gid], 200), ([], 403)):
        fixture.socket.chmod(
            0o666
        )  # isolate peer authorization from socket DAC in this fixture only
        try:
            child = os.fork()
            if child == 0:
                try:
                    os.setgroups(groups)
                    os.setgid(31001)
                    os.setuid(31001)
                except OSError:
                    os._exit(77)
                try:
                    status, body = fixture.http("/status", {})
                    os._exit(
                        0
                        if status == expected
                        and (status != 403 or set(body) == {"code"})
                        else 1
                    )
                except Exception:
                    os._exit(1)
            _, result = os.waitpid(child, 0)
            assert os.waitstatus_to_exitcode(result) in (0, 77)
        finally:
            fixture.socket.chmod(0o660)


def transport_cases(fixture):
    for target, body, expected in (
        ("/status?x=1", b"{}", 404),
        ("//status", b"{}", 404),
        ("/status", b'{"secret":true}', 400),
        ("/status", b"[{}]", 400),
        ("/status", b" " * 2049, 413),
        ("/jobs", b'{"action":"install","action":"diagnose"}', 400),
        ("/jobs", b'{"action":"install","url":"https://invalid.example"}', 400),
        ("/jobs", b'{"action":"exec"}', 400),
        ("/jobs", b'{"action":"rollback","release_id":"release"}', 400),
        ("/jobs", b'{"action":"install","release_id":"not-in-catalog"}', 400),
    ):
        code, payload = fixture.http(target, body=body)
        assert code == expected and set(payload) == {"code"}, (target, code, payload)
    assert fixture.http("/status", {}, method="GET")[0] == 405
    assert (
        fixture.http("/status", {}, headers={"Transfer-Encoding": "chunked"})[0] == 400
    )
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(4)
        connection.connect(str(fixture.socket))
        connection.sendall(
            b"POST /status HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: 2\r\ncontent-length: 2\r\n\r\n{}"
        )
        response = http.client.HTTPResponse(connection)
        response.begin()
        assert response.status == 400 and set(json.loads(response.read())) == {"code"}
    peer_cases(fixture)


def simulate_interruption(fixture, bundle, release):
    # Kill the worker process between the successful kernel exchange and the
    # next daemon instruction that would apply the new runtime inputs.
    child = os.fork()
    if child == 0:
        try:
            broker = fixture.broker
            daemon = fixture.daemon(bundle)
            daemon.job = {"phase": "checking"}
            exchange = broker.exchange

            def interrupt(left, right):
                exchange(left, right)
                if right == daemon.current:
                    os._exit(71)

            broker.exchange = interrupt
            with daemon.maintenance_lock():
                daemon.operate("update_native", release, fixture.service.info())
            os._exit(1)
        except Exception:
            os._exit(1)
    _, result = os.waitpid(child, 0)
    assert os.waitstatus_to_exitcode(result) == 71
    assert fixture.pending.is_file() and fixture.current.is_dir()


def smoke(root, broker):
    old = make_source(root, "old", OLDER, "1.5.8", b"native ABI A")
    cli = make_source(root, "cli", PINNED, "1.5.9", b"native ABI A")
    native = make_source(root, "native", PINNED, "1.5.9", b"native ABI B")
    newer = make_source(root, "newer", NEWER, "1.6.0", b"native ABI C")
    bad = make_source(root, "bad", PINNED, "1.5.9", b"native ABI B", bad_signature=True)
    old_bundle, old_id = make_bundle(root, old, broker)
    cli_bundle, cli_id = make_bundle(root, cli, broker)
    native_bundle, native_id = make_bundle(root, native, broker)
    newer_bundle, newer_id = make_bundle(root, newer, broker)
    bad_bundle, bad_id = make_bundle(root, bad, broker)
    fixture = Fixture(root, broker)
    config = root / "config.json"
    write_json(
        config,
        {
            "install_dir": str(fixture.install),
            "bundle_dir": str(old_bundle),
            "unit": str(fixture.unit),
        },
    )
    try:
        broker.Maintenance.from_config(config)
    except ValueError:
        pass
    else:
        raise AssertionError("unexpected config keys accepted")
    old_daemon = fixture.daemon(old_bundle)
    assert not old_daemon.can_update(OLDER, None)
    assert not old_daemon.can_update(OLDER, "99.0.0")
    assert old_daemon.can_update(OLDER, "1.5.8")

    with fixture.serve(fixture.daemon(bad_bundle)):
        fixture.job("install", bad_id, "fetch_failed")
        assert not fixture.current.exists() and not fixture.unit.exists()
    with fixture.serve(old_daemon):
        transport_cases(fixture)
        initial = fixture.status()
        assert initial["service"] == {"active": False, "installed": False}
        assert initial["job"] is None and initial["releases"][0]["compatible"]
        fixture.job("diagnose")
        assert not fixture.current.exists()
        with old_daemon.maintenance_lock(exclusive=False):
            fixture.job("install", old_id, "busy")
        fixture.egress.write_bytes(b"X" * len(EGRESS))
        fixture.job("install", old_id, "egress_pin_mismatch")
        assert not fixture.current.exists()
        alternate_egress = root / "egress-data"
        alternate_egress.write_bytes(EGRESS)
        fixture.egress.unlink()
        fixture.egress.symlink_to(alternate_egress)
        fixture.job("install", old_id, "egress_pin_mismatch")
        fixture.egress.unlink()
        fixture.egress.write_bytes(EGRESS)

        fixture.service.allow_start = threading.Event()
        outcome = fixture.submit("install")
        try:
            assert fixture.service.start_entered.wait(10)
            busy, error = fixture.http("/jobs", {"action": "diagnose"})
            assert (busy, error) == (409, {"code": "gemini_maintenance_busy"})
        finally:
            fixture.service.allow_start.set()
        result = fixture.finish(outcome)
        fixture.service.allow_start = None
        assert (
            result["payload"]["state"] == "awaiting_redemption"
            and result["payload"]["cli_version"] == "1.5.8"
        )
        assert (fixture.runtime / "bin/kin-egress").read_bytes() == EGRESS
        first_activation = fixture.redeemed(old)
        assert fixture.status()["payload"]["state"] == "installed"
        old_unit = fixture.unit.read_bytes()
        original_manifest = fixture.manifest()

        fixture.service.busy = True
        fixture.job("recover", error="busy")
        fixture.service.busy = False
        assert fixture.unit.read_bytes() == old_unit
        (fixture.current / "agy").write_bytes(b"damaged CLI data")
        fixture.job("repair")
        assert (
            fixture.manifest() == original_manifest
            and fixture.activation.read_bytes() == first_activation
        )
        host_egress = fixture.runtime / "bin/kin-egress"
        host_egress.unlink()
        fixture.service.active = False
        fixed = fixture.job("recover")
        assert fixed["service"]["active"] and host_egress.read_bytes() == EGRESS
        assert "gemini_maintenance_google_not_tested" in {
            check["code"] for check in fixed["checks"]
        }

    with fixture.serve(fixture.daemon(cli_bundle)):
        updated = fixture.job("update_cli", cli_id)
        assert (
            updated["payload"]["version"] == PINNED
            and updated["payload"]["activation_required"]
        )
        assert (
            not fixture.activation.exists()
            and (fixture.current / "craggemini").read_bytes() == b"native ABI A"
        )
        await_condition(lambda: fixture.status()["rollback"]["available"])
        fixture.job("rollback")
        assert (
            fixture.unit.read_bytes() == old_unit
            and fixture.activation.read_bytes() == first_activation
        )
        assert fixture.manifest() == original_manifest

    with fixture.serve(fixture.daemon(native_bundle)):
        fixture.job("update_cli", native_id, "cli_incompatible")
        fixture.service.fail_next_start = True
        fixture.job("update_native", native_id, "service_start_failed")
        assert (
            fixture.unit.read_bytes() == old_unit
            and fixture.activation.read_bytes() == first_activation
        )
        assert fixture.manifest() == original_manifest and not fixture.pending.exists()

    simulate_interruption(fixture, native_bundle, native_id)
    assert fixture.manifest() == (native / "manifest.json").read_bytes()
    with fixture.serve(fixture.daemon(native_bundle)):
        assert fixture.status()["payload"]["issue"] == "gemini_maintenance_incomplete"
        fixture.job("recover")
        assert (
            fixture.manifest() == original_manifest
            and fixture.activation.read_bytes() == first_activation
        )
        assert not fixture.pending.exists()
        fixture.job("update_native", native_id)
        assert (fixture.current / "craggemini").read_bytes() == b"native ABI B"
        fixture.job("rollback")
        assert (
            fixture.manifest() == original_manifest
            and fixture.activation.read_bytes() == first_activation
        )

    # Create a healthy newer install; then change its trusted unit to equivalent
    # administrator-managed key/release inputs. An older bundle must retain both
    # that trust configuration and the existing newer runtime verifier.
    with fixture.serve(fixture.daemon(newer_bundle)):
        fixture.job("update_native", newer_id)
        newer_activation = fixture.redeemed(newer)
    manual_key = fixture.trust / "manual-key.pub"
    manual_release = fixture.trust / "manual-release.json"
    shutil.copyfile(newer / "gemini-ed25519.pub", manual_key)
    shutil.copyfile(newer / "gemini-release.json", manual_release)
    newer_daemon = fixture.daemon(native_bundle)
    new_config = newer_daemon.unit_args(fixture.unit.read_bytes())
    new_config.pop("--default-public-key")
    new_config.pop("--default-release-verifier")
    new_config["--public-key"] = str(manual_key)
    new_config["--release-verifier"] = str(manual_release)
    line = "ExecStart=/usr/bin/python3 -I " + str(
        fixture.runtime / "scripts/gemini-host.py"
    )
    line += "".join(f" {name} {value}" for name, value in new_config.items())
    fixture.unit.write_bytes(
        re.sub(rb"(?m)^ExecStart=.*$", line.encode(), fixture.unit.read_bytes())
    )
    manual_unit = fixture.unit.read_bytes()
    verifier = fixture.runtime / "src/lib/gemini/payload.mjs"
    active_verifier = verifier.read_bytes()
    with fixture.serve(newer_daemon):
        fixture.job("diagnose")
        assert fixture.status()["releases"][0]["compatible"] is False
        fixture.job("install")
        fixture.job("repair")
        fixture.job("recover")
        fixture.job("update_native", native_id, "downgrade_blocked")
        assert fixture.manifest() == (newer / "manifest.json").read_bytes()
        assert (
            fixture.unit.read_bytes() == manual_unit
            and verifier.read_bytes() == active_verifier
        )
        assert fixture.activation.read_bytes() == newer_activation
        assert (
            manual_release.read_bytes() == (newer / "gemini-release.json").read_bytes()
        )
        assert manual_key.read_bytes() == (newer / "gemini-ed25519.pub").read_bytes()


def main():
    if os.geteuid() != 0:
        raise SystemExit(
            "run this fixture as root in an isolated Linux amd64 namespace"
        )
    os.umask(0o077)
    sys.dont_write_bytecode = True
    with tempfile.TemporaryDirectory(prefix="gemini-maint-", dir="/opt") as temp:
        root = Path(temp)
        root.chmod(0o755)  # non-root credential tests need to reach the socket
        # Native tools are not executed by this offline signed-data fixture.
        # Model their presence without invoking an OS package manager in tests.
        broker = load_broker()
        tools = root / "fixture-tools"
        tools.mkdir()
        for name in ("ip", "nft", "setpriv", "bwrap", "curl", "openvt"):
            target = tools / name
            target.write_text("#!/bin/sh\nexit 99\n")
            target.chmod(0o755)
        broker.SYSTEM_ENV["PATH"] = str(tools) + ":" + broker.SYSTEM_ENV["PATH"]
        smoke(root, broker)
    print(
        "Gemini maintenance offline smoke passed: fixed transport, trust, busy fencing, recovery, update and rollback"
    )


if __name__ == "__main__":
    main()
