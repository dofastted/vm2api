"""Gemini maintenance daemon must import gemini_host_apparmor from its scripts dir."""

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DAEMON = ROOT / "scripts/gemini-maintenance.py"
APPARMOR = ROOT / "scripts/gemini_host_apparmor.py"


class GeminiMaintenanceDaemonImportTests(unittest.TestCase):
    def _stage_scripts(self, *, include_apparmor: bool) -> Path:
        tmp = tempfile.TemporaryDirectory(prefix="gemini-maint-daemon-")
        self.addCleanup(tmp.cleanup)
        scripts = Path(tmp.name) / "scripts"
        scripts.mkdir()
        shutil.copy2(DAEMON, scripts / "gemini-maintenance.py")
        if include_apparmor:
            shutil.copy2(APPARMOR, scripts / "gemini_host_apparmor.py")
        return scripts

    def test_python_i_help_imports_apparmor_sibling(self):
        scripts = self._stage_scripts(include_apparmor=True)
        outcome = subprocess.run(
            [sys.executable, "-I", str(scripts / "gemini-maintenance.py"), "--help"],
            capture_output=True,
            text=True,
            timeout=15,
            cwd=scripts.parent,
        )
        self.assertEqual(outcome.returncode, 0, outcome.stderr or outcome.stdout)
        self.assertIn("usage:", outcome.stdout.lower())

    def test_missing_apparmor_sibling_fails_at_import(self):
        scripts = self._stage_scripts(include_apparmor=False)
        outcome = subprocess.run(
            [sys.executable, "-I", str(scripts / "gemini-maintenance.py"), "--help"],
            capture_output=True,
            text=True,
            timeout=15,
            cwd=scripts.parent,
        )
        self.assertNotEqual(outcome.returncode, 0)
        combined = f"{outcome.stdout}\n{outcome.stderr}"
        self.assertIn("gemini_host_apparmor", combined)


if __name__ == "__main__":
    unittest.main()