"""RUNTIME_FILES / VERIFIER_FILES contract for Gemini maintenance bundles."""

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "gemini_maintenance_runtime_files", ROOT / "scripts/gemini-maintenance.py"
)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

EXPECTED_VERIFIER_FILES = (
    "scripts/install-gemini-payload.mjs",
    "src/lib/gemini/payload.mjs",
)


class GeminiMaintenanceRuntimeFilesTests(unittest.TestCase):
    def test_runtime_files_includes_apparmor_helper(self):
        self.assertIn("scripts/gemini_host_apparmor.py", module.RUNTIME_FILES)
        apparmor = ROOT / "scripts/gemini_host_apparmor.py"
        self.assertTrue(apparmor.is_file(), "apparmor helper must exist in repo")

    def test_verifier_files_stay_on_payload_install_pair(self):
        self.assertEqual(module.VERIFIER_FILES, EXPECTED_VERIFIER_FILES)
        self.assertEqual(module.RUNTIME_FILES[5:7], EXPECTED_VERIFIER_FILES)

    def test_apparmor_helper_after_kin_egress_does_not_shift_verifier_slice(self):
        kin_idx = module.RUNTIME_FILES.index("bin/kin-egress")
        apparmor_idx = module.RUNTIME_FILES.index("scripts/gemini_host_apparmor.py")
        self.assertGreater(apparmor_idx, kin_idx)
        self.assertEqual(
            module.RUNTIME_FILES[kin_idx + 1], "scripts/gemini_host_apparmor.py"
        )

    def test_runtime_files_includes_agy_patch_helper_after_apparmor(self):
        self.assertIn("scripts/gemini_agy_patch.py", module.RUNTIME_FILES)
        agy_patch = ROOT / "scripts/gemini_agy_patch.py"
        self.assertTrue(agy_patch.is_file(), "agy patch helper must exist in repo")
        apparmor_idx = module.RUNTIME_FILES.index("scripts/gemini_host_apparmor.py")
        agy_patch_idx = module.RUNTIME_FILES.index("scripts/gemini_agy_patch.py")
        self.assertGreater(agy_patch_idx, apparmor_idx)


if __name__ == "__main__":
    unittest.main()