"""Offline maintenance diagnostics; generated service template, inert binary.

Run as root in a disposable container with a root-owned, non-writable TMPDIR
and ancestors. No service, installer, network or real binary is executed.
"""
import hashlib
import importlib.util
import os
from pathlib import Path
import stat
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("maintenance_fixture", ROOT / "scripts/gemini-maintenance.py")
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class EgressInspectionTests(unittest.TestCase):
    def setUp(self):
        if os.geteuid() != 0:
            self.skipTest("root-owned path trust checks need an isolated root runner")
        try:
            module.require_root(Path(tempfile.gettempdir()), stat.S_ISDIR)
        except ValueError:
            self.skipTest("use a root-owned non-writable TMPDIR and ancestors")
        self.tmp = tempfile.TemporaryDirectory(prefix="maintenance-egress-")
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.m = module.Maintenance.__new__(module.Maintenance)
        for attr, name in [("install", "app"), ("runtime", "runtime"), ("state", "state"),
                           ("current", "payload"), ("backup", "backup")]:
            setattr(self.m, attr, root / name)
        self.m.pending = root / "pending"
        self.m.unit = root / "gemini.service"
        self.m.runtime_socket = root / "control.sock"
        self.m.guard = threading.Lock()
        self.m.egress_ok = None
        self.binary = b"synthetic egress fixture; never executed\n"
        self.m.egress_pin = {"size": len(self.binary), "sha256": hashlib.sha256(self.binary).hexdigest()}
        self.app_egress = self.m.install / "bin/kin-egress"
        self.runtime_egress = self.m.runtime / "bin/kin-egress"
        self.write_binary(self.app_egress)
        template = (ROOT / "deploy/gemini-host.service.example").read_text()
        self.template = (template.replace("@INSTALL_DIR@", str(self.m.install))
                         .replace("@PAYLOAD_SOURCE_ARG@", "").replace("@DEFAULT_PAYLOAD_ARGS@", "")
                         .replace("/usr/local/lib/vm2api-gemini", str(self.m.runtime))
                         .replace("/var/lib/vm2api-gemini", str(self.m.state))
                         .replace(str(self.m.install / "share/gemini/current"), str(self.m.current))
                         .replace("/run/vm2api-gemini/control.sock", str(self.m.runtime_socket)))
        self.m.unit.write_text(self.template)

    def write_binary(self, path, data=None, mode=0o755):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(self.binary if data is None else data)
        path.chmod(mode)

    def inspect(self):
        with patch.object(module.subprocess, "run", side_effect=AssertionError("no subprocess allowed")):
            self.m.inspect()
        return self.m.egress_ok

    def test_installer_template_uses_existing_pinned_app_binary(self):
        args = self.m.unit_args(self.m.unit_bytes())
        self.assertEqual(args["--egress"], str(self.app_egress))
        self.assertFalse(self.runtime_egress.exists())
        self.assertTrue(self.inspect())

    def test_recovered_unit_checks_runtime_binary_not_old_app_copy(self):
        self.m.unit.write_text(self.template.replace(str(self.app_egress), str(self.runtime_egress)))
        self.write_binary(self.runtime_egress)
        self.write_binary(self.app_egress, b"old ignored app copy")
        self.assertTrue(self.inspect())

    def test_unused_valid_runtime_copy_cannot_hide_broken_configured_binary(self):
        self.write_binary(self.runtime_egress)
        self.write_binary(self.app_egress, b"corrupted")
        self.assertFalse(self.inspect())

    def test_missing_nonexecutable_writable_and_symlink_targets_fail(self):
        for kind in ("missing", "nonexec", "writable", "symlink"):
            with self.subTest(kind=kind):
                self.app_egress.unlink(missing_ok=True)
                if kind == "nonexec":
                    self.write_binary(self.app_egress, mode=0o644)
                elif kind == "writable":
                    self.write_binary(self.app_egress, mode=0o777)
                elif kind == "symlink":
                    self.write_binary(self.runtime_egress)
                    self.app_egress.symlink_to(self.runtime_egress)
                self.assertFalse(self.inspect())

    def test_malformed_or_missing_unit_fails_even_with_valid_runtime_copy(self):
        self.write_binary(self.runtime_egress)
        for body in ("[Service]\nExecStart=/bin/true\n", self.template + "\nExecStart=/bin/true\n", None):
            with self.subTest(body=body):
                if body is None:
                    self.m.unit.unlink()
                else:
                    self.m.unit.write_text(body)
                self.assertFalse(self.inspect())

    def test_pending_transaction_keeps_inspection_unchanged(self):
        self.m.pending.write_text("synthetic transaction")
        self.m.egress_ok = None
        self.assertIsNone(self.inspect())


if __name__ == "__main__":
    unittest.main()
