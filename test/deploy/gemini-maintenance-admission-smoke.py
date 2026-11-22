"""Run as namespace-root in a disposable filesystem, without external network."""

import fcntl
import importlib.util
import os
from pathlib import Path
import tempfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "gemini_host", ROOT / "scripts/gemini-host.py"
)
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)

with tempfile.TemporaryDirectory(prefix="gemini-admission-", dir="/opt") as temporary:
    state = Path(temporary)
    runtime = host.Host.__new__(host.Host)
    runtime.directory = state
    runtime.pending = {}
    runtime.terminals = {}
    runtime.runs = {}
    lock = state / "maintenance.lock"
    descriptor = os.open(lock, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert runtime.request("maintenance-status", {}) == {"busy": False}
        try:
            runtime.request("create", {})
        except host.Failure as error:
            assert (error.status, error.code) == (409, "gemini_operation_busy")
        else:
            raise AssertionError("new account operation admitted during maintenance")
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        pending = state / "maintenance.pending"
        pending.write_text("{}")
        try:
            runtime.request("create", {})
        except host.Failure as error:
            assert error.code == "gemini_operation_busy"
        else:
            raise AssertionError("interrupted maintenance did not fence new operations")
        pending.unlink()
        pending.symlink_to(state / "missing-journal")
        try:
            runtime.request("create", {})
        except host.Failure as error:
            assert error.code == "gemini_operation_busy"
        else:
            raise AssertionError("unsafe pending marker bypassed the fence")
        pending.unlink()
        try:
            runtime.request("redeem", {"redemption_code": "bad"})
        except host.Failure as error:
            assert error.code == "gemini_release_code_invalid"
        else:
            raise AssertionError("invalid redemption unexpectedly accepted")
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        lock.chmod(0o660)
        try:
            runtime.request("create", {})
        except host.Failure as error:
            assert error.code == "gemini_maintenance_lock_invalid"
        else:
            raise AssertionError("group-writable lock accepted")
        assert not (state / "environments.json").exists()
    finally:
        os.close(descriptor)
print("Shared/exclusive admission, interrupted maintenance and unsafe lock fail closed")
