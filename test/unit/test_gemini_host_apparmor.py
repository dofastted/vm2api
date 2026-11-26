"""Unit tests for Gemini managed bwrap entry and AppArmor profile helpers."""

import errno
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import importlib.util

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "gemini_host_apparmor_unit", REPO / "scripts/gemini_host_apparmor.py"
)
mod = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(mod)


class GeminiHostAppArmorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="gemini-aa-helper-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def _stage_userns_restricted(self, *, mediated=False):
        for rel, value in {
            "sys/module/apparmor/parameters/enabled": "Y\n",
            "proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1\n",
        }.items():
            path = self.root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(value, encoding="utf-8")
        if mediated:
            staged = self.root / "etc/apparmor.d/bwrap-userns-restrict"
            staged.parent.mkdir(parents=True, exist_ok=True)
            staged.write_text("profile bwrap /usr/bin/bwrap {}\n", encoding="utf-8")
            profiles = self.root / "sys/kernel/security/apparmor/profiles"
            profiles.parent.mkdir(parents=True, exist_ok=True)
            profiles.write_text("bwrap (enforce)\n", encoding="utf-8")

    def test_profile_body_only_adds_ix_rule_when_mediated(self):
        plain = mod.apparmor_profile_bytes().decode("ascii")
        self.assertIn("  userns,\n", plain)
        self.assertNotIn("exec/bwrap", plain)
        with_rule = mod.apparmor_profile_bytes(
            bwrap_entry=Path("/usr/local/lib/vm2api-gemini/exec/bwrap")
        ).decode("ascii")
        self.assertIn("  /usr/local/lib/vm2api-gemini/exec/bwrap ix,\n", with_rule)

    def test_resolve_bwrap_prefers_managed_entry_and_override(self):
        entry = mod.host_path(self.root, mod.GEMINI_BWRAP_ENTRY)
        entry.parent.mkdir(parents=True, exist_ok=True)
        entry.write_text("#!/bin/sh\n", encoding="utf-8")
        os.chmod(entry, 0o755)
        custom = self.root / "custom-bwrap"
        custom.write_text("#!/bin/sh\n", encoding="utf-8")
        os.chmod(custom, 0o755)
        with patch.dict(os.environ, {mod.BWRAP_ENV_OVERRIDE: str(custom)}):
            self.assertEqual(mod.resolve_bwrap_argv0(host_root=self.root), str(custom))
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop(mod.BWRAP_ENV_OVERRIDE, None)
            self.assertEqual(
                mod.resolve_bwrap_argv0(host_root=self.root), str(entry)
            )

    def test_install_managed_bwrap_copies_system_binary(self):
        source = self.root / "system-bwrap"
        source.write_bytes(b"#!/bin/sh\necho ok\n")
        os.chmod(source, 0o755)
        with patch.object(mod.shutil, "which", return_value=str(source)):
            installed = mod.install_managed_bwrap(host_root=self.root)
        self.assertEqual(installed.read_bytes(), source.read_bytes())
        info = installed.stat()
        self.assertTrue(stat.S_ISREG(info.st_mode))
        self.assertEqual(info.st_mode & 0o777, 0o755)

    def test_install_managed_bwrap_skips_when_content_matches(self):
        source = self.root / "system-bwrap"
        payload = b"#!/bin/sh\nnoop\n"
        source.write_bytes(payload)
        os.chmod(source, 0o755)
        entry = mod.host_path(self.root, mod.GEMINI_BWRAP_ENTRY)
        entry.parent.mkdir(parents=True, exist_ok=True)
        entry.write_bytes(payload)
        before = entry.stat().st_mtime_ns
        with (
            patch.object(mod.shutil, "which", return_value=str(source)),
            patch.object(mod.os, "replace") as replace_mock,
            patch.object(mod.shutil, "copy2") as copy_mock,
        ):
            with self.subTest("identical"):
                result = mod.install_managed_bwrap(host_root=self.root)
                replace_mock.assert_not_called()
                copy_mock.assert_not_called()
            self.assertEqual(result, entry)
            self.assertEqual(entry.stat().st_mtime_ns, before)

    def test_install_managed_bwrap_surfaces_etxtbsy_from_replace(self):
        source = self.root / "system-bwrap"
        source.write_bytes(b"#!/bin/sh\nbusy\n")
        os.chmod(source, 0o755)
        entry = mod.host_path(self.root, mod.GEMINI_BWRAP_ENTRY)
        entry.parent.mkdir(parents=True, exist_ok=True)

        def busy_replace(*_args, **_kwargs):
            raise OSError(errno.ETXTBSY, "Text file busy")

        with (
            patch.object(mod.shutil, "which", return_value=str(source)),
            patch.object(mod.os, "replace", side_effect=busy_replace),
        ):
            with self.assertRaises(OSError) as caught:
                mod.install_managed_bwrap(host_root=self.root)
        self.assertEqual(caught.exception.errno, errno.ETXTBSY)

    def test_install_managed_bwrap_uses_atomic_replace(self):
        source = self.root / "system-bwrap"
        source.write_bytes(b"#!/bin/sh\nv2\n")
        os.chmod(source, 0o755)
        entry = mod.host_path(self.root, mod.GEMINI_BWRAP_ENTRY)
        entry.parent.mkdir(parents=True, exist_ok=True)
        entry.write_bytes(b"#!/bin/sh\nv1\n")
        with (
            patch.object(mod.shutil, "which", return_value=str(source)),
            patch.object(mod.os, "replace", wraps=mod.os.replace) as replace_mock,
        ):
            mod.install_managed_bwrap(host_root=self.root)
        replace_mock.assert_called_once()
        self.assertEqual(entry.read_bytes(), source.read_bytes())

    def test_managed_entry_configuration_detection(self):
        self._stage_userns_restricted(mediated=True)
        self.assertFalse(mod.managed_bwrap_entry_configured(host_root=self.root))
        source = self.root / "system-bwrap"
        source.write_bytes(b"#!/bin/sh\n")
        os.chmod(source, 0o755)
        with patch.object(mod.shutil, "which", return_value=str(source)):
            entry = mod.install_managed_bwrap(host_root=self.root)
        profile = self.root / "etc/apparmor.d/vm2api-gemini"
        profile.parent.mkdir(parents=True, exist_ok=True)
        profile.write_bytes(mod.apparmor_profile_bytes(bwrap_entry=entry))
        self.assertTrue(mod.managed_bwrap_entry_configured(host_root=self.root))

    def test_mediated_detection_ignores_staged_file_without_loaded_profile(self):
        self._stage_userns_restricted(mediated=False)
        staged = self.root / "etc/apparmor.d/bwrap-userns-restrict"
        staged.parent.mkdir(parents=True, exist_ok=True)
        staged.write_text("profile bwrap {}\n", encoding="utf-8")
        profiles = self.root / "sys/kernel/security/apparmor/profiles"
        profiles.parent.mkdir(parents=True, exist_ok=True)
        profiles.write_text("default (enforce)\n", encoding="utf-8")
        self.assertFalse(mod.bwrap_userns_mediated(host_root=self.root))


if __name__ == "__main__":
    unittest.main()