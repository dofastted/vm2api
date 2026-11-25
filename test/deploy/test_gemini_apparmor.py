"""Tests for Gemini host AppArmor userns profile preparation, inline unit attachment,
and gemini-maintenance.py integration (active live probe vs stopped static check).
"""

from contextlib import ExitStack
import hashlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import socketserver
import stat
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch


REPO = Path(__file__).resolve().parents[2]
INSTALLER = REPO / "deploy/install.sh"
DEFINITIONS = INSTALLER.read_text(encoding="utf-8").split('\nCOMMAND="install"\n')[0]
UNIT_EXAMPLE = (REPO / "deploy/gemini-host.service.example").read_text(encoding="utf-8")


def load_maintenance_module():
    spec = importlib.util.spec_from_file_location(
        "gemini_maintenance_apparmor_test", REPO / "scripts/gemini-maintenance.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class InstallerGeminiAppArmorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="gemini-aa-install-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for rel, value in {
            "sys/module/apparmor/parameters/enabled": "Y\n",
            "proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1\n",
            "etc/apparmor.d/abi/4.0": "fixture ABI\n",
        }.items():
            path = self.root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(value, encoding="utf-8")
        self.profile = self.root / "etc/apparmor.d/vm2api-gemini"
        self.unit = self.root / "etc/systemd/system/vm2api-gemini.service"
        self.unit.parent.mkdir(parents=True, exist_ok=True)

    def run_bash(
        self,
        body,
        *,
        fail_parser="",
        missing_parser=False,
        apparmor_load_state="loaded",
        unit_apparmor_profile="",
    ):
        fake_bin = self.root / "fake-bin"
        fake_bin.mkdir(exist_ok=True)
        parser_path = fake_bin / "apparmor_parser"
        if missing_parser:
            parser_path.unlink(missing_ok=True)
            # Restrict PATH so real host apparmor_parser cannot leak in.
            safe_bin = self.root / "safe-bin"
            safe_bin.mkdir(exist_ok=True)
            for cmd in ("tr", "head", "mktemp", "chmod", "mv", "rm", "cat", "grep", "sed", "dirname", "basename"):
                resolved = subprocess.run(["which", cmd], capture_output=True, text=True).stdout.strip()
                if resolved and not (safe_bin / cmd).exists():
                    (safe_bin / cmd).symlink_to(resolved)
            path_env = f"{fake_bin}:{safe_bin}"
        else:
            parser_path.write_text(
                "#!/usr/bin/env bash\n"
                'printf "%s %s\\n" "$1" "$2" >> "$TEST_ROOT/parser.calls"\n'
                '[ "$1" != "$FAIL_PARSER" ]\n',
                encoding="utf-8",
            )
            parser_path.chmod(0o755)
            path_env = f"{fake_bin}:{os.environ.get('PATH', '/usr/bin:/bin')}"

        systemctl_path = fake_bin / "systemctl"
        systemctl_path.write_text(
            "#!/usr/bin/env bash\n"
            'printf "%s\\n" "$*" >> "$TEST_ROOT/systemctl.calls"\n'
            'if [ "$*" = "show --property=LoadState --value apparmor.service" ]; then\n'
            '  printf "%s\\n" "$APPARMOR_LOAD_STATE"\n'
            "  exit 0\n"
            "fi\n"
            'if [ "$*" = "show --property=AppArmorProfile --value vm2api-gemini.service" ]; then\n'
            '  printf "%s\\n" "$UNIT_APPARMOR_PROFILE"\n'
            "  exit 0\n"
            "fi\n"
            "exit 0\n",
            encoding="utf-8",
        )
        systemctl_path.chmod(0o755)

        env = dict(
            os.environ,
            PATH=path_env,
            TEST_ROOT=str(self.root),
            TEST_UNIT=str(self.unit),
            FAIL_PARSER=fail_parser,
            APPARMOR_LOAD_STATE=apparmor_load_state,
            UNIT_APPARMOR_PROFILE=unit_apparmor_profile,
        )
        return subprocess.run(
            ["/usr/bin/bash", "-c", DEFINITIONS + "\n" + body],
            env=env,
            text=True,
            capture_output=True,
            timeout=10,
        )

    def test_restricted_ubuntu_24_04_loads_scoped_profile_idempotently(self):
        for _ in range(2):
            result = self.run_bash('prepare_gemini_apparmor "$TEST_ROOT" "$TEST_UNIT"')
            self.assertEqual(result.returncode, 0, result.stderr)
            content = self.profile.read_text(encoding="utf-8")
            self.assertEqual(
                content,
                "# Managed by vm2api Gemini host userns preparation.\n"
                "abi <abi/4.0>,\n"
                "profile vm2api-gemini flags=(unconfined) {\n"
                "  userns,\n"
                "}\n",
            )
            self.assertEqual(self.profile.stat().st_mode & 0o777, 0o644)
        self.assertEqual(
            (self.root / "parser.calls").read_text(encoding="utf-8").splitlines(),
            ["-Q -K", "-r -K", "-Q -K", "-r -K"],
        )
        # Never relaxes host sysctl or attaches to /usr/bin/bwrap.
        self.assertEqual(
            (self.root / "proc/sys/kernel/apparmor_restrict_unprivileged_userns").read_text(encoding="utf-8"),
            "1\n",
        )
        self.assertNotIn("/usr/bin/bwrap", self.profile.read_text(encoding="utf-8"))

    def test_accepts_enabled_1_and_yes_values(self):
        for val in ("1\n", "yes\n"):
            with self.subTest(enabled=val.strip()):
                (self.root / "sys/module/apparmor/parameters/enabled").write_text(val, encoding="utf-8")
                self.profile.unlink(missing_ok=True)
                result = self.run_bash('prepare_gemini_apparmor "$TEST_ROOT" "$TEST_UNIT"')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(self.profile.is_file())

    def test_unrestricted_and_non_apparmor_hosts_are_untouched(self):
        cases = [
            ("proc/sys/kernel/apparmor_restrict_unprivileged_userns", "0\n"),
            ("sys/module/apparmor/parameters/enabled", "N\n"),
            ("proc/sys/kernel/apparmor_restrict_unprivileged_userns", None),
            ("sys/module/apparmor/parameters/enabled", None),
        ]
        for rel, value in cases:
            with self.subTest(rel=rel, value=value):
                path = self.root / rel
                original = path.read_text(encoding="utf-8")
                if value is None:
                    path.unlink()
                else:
                    path.write_text(value, encoding="utf-8")
                try:
                    result = self.run_bash('prepare_gemini_apparmor "$TEST_ROOT" "$TEST_UNIT"')
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertFalse(self.profile.exists())
                    self.assertFalse((self.root / "parser.calls").exists())
                finally:
                    path.write_text(original, encoding="utf-8")

    def test_operator_owned_profile_symlink_and_non_regular_fail_closed(self):
        self.profile.write_text("# operator custom\nprofile vm2api-gemini {}\n", encoding="utf-8")
        res = self.run_bash('prepare_gemini_apparmor "$TEST_ROOT" "$TEST_UNIT"')
        self.assertNotEqual(res.returncode, 0)
        self.assertEqual(
            self.profile.read_text(encoding="utf-8"),
            "# operator custom\nprofile vm2api-gemini {}\n",
        )
        self.assertFalse((self.root / "parser.calls").exists())

        target = self.root / "etc/apparmor.d/operator-target"
        self.profile.rename(target)
        self.profile.symlink_to(target)
        res = self.run_bash('prepare_gemini_apparmor "$TEST_ROOT" "$TEST_UNIT"')
        self.assertNotEqual(res.returncode, 0)
        self.assertTrue(self.profile.is_symlink())
        self.assertFalse((self.root / "parser.calls").exists())

        self.profile.unlink()
        self.profile.mkdir()
        res = self.run_bash('prepare_gemini_apparmor "$TEST_ROOT" "$TEST_UNIT"')
        self.assertNotEqual(res.returncode, 0)
        self.assertTrue(self.profile.is_dir())

    def test_operator_configured_unit_apparmor_profile_fails_closed(self):
        self.unit.write_text(
            UNIT_EXAMPLE + "\nAppArmorProfile=custom-operator\n", encoding="utf-8"
        )
        res = self.run_bash('prepare_gemini_apparmor "$TEST_ROOT" "$TEST_UNIT"')
        self.assertNotEqual(res.returncode, 0)
        self.assertFalse(self.profile.exists())
        self.assertFalse((self.root / "parser.calls").exists())

        # Also fail closed if systemd reports a different active AppArmorProfile=.
        self.unit.unlink()
        res = self.run_bash(
            'prepare_gemini_apparmor "$TEST_ROOT" "$TEST_UNIT"',
            unit_apparmor_profile="custom-live-profile",
        )
        self.assertNotEqual(res.returncode, 0)
        self.assertFalse(self.profile.exists())

    def test_missing_abi_missing_parser_and_unloaded_service_fail_closed(self):
        # Missing ABI 4.0
        abi = self.root / "etc/apparmor.d/abi/4.0"
        abi.unlink()
        res = self.run_bash('prepare_gemini_apparmor "$TEST_ROOT" "$TEST_UNIT"')
        self.assertNotEqual(res.returncode, 0)
        self.assertFalse(self.profile.exists())
        self.assertFalse((self.root / "parser.calls").exists())
        abi.write_text("fixture ABI\n", encoding="utf-8")

        # Missing apparmor_parser
        res = self.run_bash(
            'prepare_gemini_apparmor "$TEST_ROOT" "$TEST_UNIT"', missing_parser=True
        )
        self.assertNotEqual(res.returncode, 0)
        self.assertFalse(self.profile.exists())

        # apparmor.service LoadState != loaded
        for state in ("not-found", "masked", "error", ""):
            with self.subTest(load_state=state):
                res = self.run_bash(
                    'prepare_gemini_apparmor "$TEST_ROOT" "$TEST_UNIT"',
                    apparmor_load_state=state,
                )
                self.assertNotEqual(res.returncode, 0)
                self.assertFalse(self.profile.exists())
                self.assertFalse((self.root / "parser.calls").exists())

    def test_parser_check_and_load_failures_leave_existing_profile_untouched(self):
        res = self.run_bash('prepare_gemini_apparmor "$TEST_ROOT" "$TEST_UNIT"')
        self.assertEqual(res.returncode, 0, res.stderr)
        previous = self.profile.read_bytes()
        for phase in ("-Q", "-r"):
            with self.subTest(phase=phase):
                res = self.run_bash(
                    'prepare_gemini_apparmor "$TEST_ROOT" "$TEST_UNIT"',
                    fail_parser=phase,
                )
                self.assertNotEqual(res.returncode, 0)
                self.assertEqual(self.profile.read_bytes(), previous)
                leftovers = list((self.root / "etc/apparmor.d").glob(".vm2api-gemini.*"))
                self.assertEqual(leftovers, [])

    def test_inline_unit_attachment_is_idempotent_and_rejects_conflict(self):
        self.unit.write_text(UNIT_EXAMPLE, encoding="utf-8")
        res1 = self.run_bash('render_gemini_unit_apparmor "$TEST_UNIT"')
        self.assertEqual(res1.returncode, 0, res1.stderr)
        rendered_once = self.unit.read_text(encoding="utf-8")
        self.assertIn("After=apparmor.service\n", rendered_once)
        self.assertIn("Requires=apparmor.service\n", rendered_once)
        self.assertIn("AppArmorProfile=vm2api-gemini\n", rendered_once)
        # Ensure directives land in their proper sections.
        unit_section = rendered_once.split("[Service]")[0]
        service_section = rendered_once.split("[Service]")[1].split("[Install]")[0]
        self.assertIn("After=apparmor.service", unit_section)
        self.assertIn("Requires=apparmor.service", unit_section)
        self.assertIn("AppArmorProfile=vm2api-gemini", service_section)

        # Second pass is byte-for-byte idempotent.
        res2 = self.run_bash('render_gemini_unit_apparmor "$TEST_UNIT"')
        self.assertEqual(res2.returncode, 0, res2.stderr)
        self.assertEqual(self.unit.read_text(encoding="utf-8"), rendered_once)

        # Operator custom AppArmorProfile= in unit fails closed.
        self.unit.write_text(
            rendered_once.replace("AppArmorProfile=vm2api-gemini", "AppArmorProfile=other-profile"),
            encoding="utf-8",
        )
        res3 = self.run_bash('render_gemini_unit_apparmor "$TEST_UNIT"')
        self.assertNotEqual(res3.returncode, 0)

    def test_installer_failure_semantics_prepare_gemini_fails_loudly_full_stack_warns(self):
        # prepare_gemini_host returns non-zero when prepare_gemini_apparmor fails.
        body = r'''
NO_START=0
HOST_ARCH=amd64
INSTALL_DIR="$TEST_ROOT/app"
mkdir -p "$INSTALL_DIR"
env_get() { echo ""; }
prepare_gemini_maintenance() { return 0; }
gemini_node_supported() { return 0; }
gemini_apparmor_userns_restricted() { return 0; }
prepare_gemini_apparmor() { err "synthetic apparmor failure"; return 1; }
fetch_gemini_host_file() { return 44; }
systemctl() {
  if [ "$1" = "is-active" ]; then
    return 1
  fi
  return 0
}
prepare_gemini_host v1.4.220 source required
'''
        res = self.run_bash(body)
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("synthetic apparmor failure", res.stderr + res.stdout)

        # Full-stack install/upgrade continues with warning rather than exiting non-zero.
        install_text = INSTALLER.read_text(encoding="utf-8")
        self.assertIn(
            'prepare_gemini_host "$tag" "$mode" || warn "Gemini 宿主服务未就绪；控制面继续安装，请修复后单独执行 prepare-gemini"',
            install_text,
        )
        self.assertIn(
            'prepare_gemini_host "$tag" "$mode" || warn "Gemini 宿主服务未就绪；控制面继续升级，请修复后单独执行 prepare-gemini"',
            install_text,
        )


class MaintenanceAppArmorAndSandboxTests(unittest.TestCase):
    def setUp(self):
        self.mod = load_maintenance_module()
        self.tmp = tempfile.TemporaryDirectory(prefix="gemini-maint-aa-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.host_root = self.root / "host"
        for rel, value in {
            "sys/module/apparmor/parameters/enabled": "Y\n",
            "proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1\n",
            "etc/apparmor.d/abi/4.0": "fixture ABI\n",
            "sys/kernel/security/apparmor/profiles": "default (enforce)\n",
        }.items():
            path = self.host_root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(value, encoding="utf-8")

        self.install = self.root / "app"
        self.bundle = self.root / "bundle"
        self.runtime = self.root / "runtime"
        self.state = self.root / "state"
        self.unit = self.root / "units/vm2api-gemini.service"
        self.runtime_socket = self.root / "run/control.sock"
        self.trust = self.root / "trust"
        for d in (
            self.install / "share/gemini",
            self.bundle / "deploy",
            self.runtime,
            self.state,
            self.unit.parent,
            self.runtime_socket.parent,
            self.trust,
        ):
            d.mkdir(parents=True, exist_ok=True)
        (self.bundle / "deploy/gemini-host.service.example").write_text(
            UNIT_EXAMPLE, encoding="utf-8"
        )

        self.m = self.mod.Maintenance.__new__(self.mod.Maintenance)
        self.m.install = self.install
        self.m.bundle = self.bundle
        self.m.runtime = self.runtime
        self.m.state = self.state
        self.m.unit = self.unit
        self.m.runtime_socket = self.runtime_socket
        self.m.trust = self.trust
        self.m.host_root = self.host_root
        self.m.current = self.install / "share/gemini/current"
        self.m.transaction = self.m.current.parent / ".maintenance-transaction"
        self.m.backup = self.m.current.parent / ".maintenance-rollback"
        self.m.pending = self.state / "maintenance.pending"
        self.m.activation = self.state / "release-activation.json"
        self.m.public_key = self.trust / "gemini-ed25519.pub"
        self.m.manual_release = self.trust / "gemini-release.json"
        self.m.crag_bundle = False
        self.m.pins = {"manifest.json": {"sha256": "0" * 64, "size": 10}}
        self.m.egress_pin = {"sha256": "0" * 64, "size": 10}
        self.m.guard = threading.Lock()
        self.m.job = {"phase": "checking"}
        self.m.verified = {}
        self.m.egress_ok = True
        self.m.sandbox_status = None
        self.m.sandbox_checked_at = 0.0

        self.service_info = {
            "LoadState": "loaded",
            "ActiveState": "inactive",
            "FragmentPath": str(self.unit),
            "DropInPaths": "",
            "AppArmorProfile": "",
        }
        self.apparmor_state = "loaded"

        class FakeService:
            def __init__(inner_self):
                pass

            def info(inner_self):
                return dict(self.service_info)

            def apparmor_load_state(inner_self):
                return self.apparmor_state

            def reload(inner_self):
                pass

            def start(inner_self):
                pass

            def stop(inner_self):
                pass

            def set_enabled(inner_self, _enabled):
                pass

        self.m.service = FakeService()

    def _mock_root_trust(self):
        stack = ExitStack()
        stack.enter_context(patch.object(self.mod, "require_root", return_value=None))
        stack.enter_context(
            patch.object(
                self.mod,
                "read_root",
                side_effect=lambda p, limit: Path(p).read_bytes(),
            )
        )
        return stack

    def test_prepare_apparmor_and_inline_unit_attachment(self):
        parser_calls = []

        def fake_command(argv, timeout, code, **_kwargs):
            parser_calls.append(argv[:3])
            self.assertEqual(code, "apparmor_load_failed")
            return b""

        with (
            self._mock_root_trust(),
            patch.object(self.mod.shutil, "which", return_value="/usr/sbin/apparmor_parser"),
            patch.object(self.mod, "command", side_effect=fake_command),
        ):
            applied = self.m.prepare_apparmor(self.service_info, None)
            self.assertTrue(applied)
            profile = self.host_root / "etc/apparmor.d/vm2api-gemini"
            self.assertEqual(profile.read_bytes(), self.mod.APPARMOR_PROFILE_CONTENT)
            self.assertEqual(profile.stat().st_mode & 0o777, 0o644)
            self.assertEqual(
                parser_calls,
                [
                    ["/usr/sbin/apparmor_parser", "-Q", "-K"],
                    ["/usr/sbin/apparmor_parser", "-r", "-K"],
                ],
            )

            # Re-run is idempotent.
            self.assertTrue(self.m.prepare_apparmor(self.service_info, None))

            # write_unit renders inline directives without drop-ins.
            unit_bytes = self.m.write_unit(None, apparmor=True)
            text = unit_bytes.decode("utf-8")
            self.assertIn("After=apparmor.service\n", text)
            self.assertIn("Requires=apparmor.service\n", text)
            self.assertIn("AppArmorProfile=vm2api-gemini\n", text)
            self.assertEqual(self.m.write_unit(unit_bytes, apparmor=True), unit_bytes)

    def test_prepare_apparmor_fail_closed_conditions(self):
        profile = self.host_root / "etc/apparmor.d/vm2api-gemini"

        with self._mock_root_trust():
            # 1. Missing apparmor_parser
            with patch.object(self.mod.shutil, "which", return_value=None):
                with self.assertRaises(self.mod.Failure) as ctx:
                    self.m.prepare_apparmor(self.service_info, None)
                self.assertEqual(ctx.exception.code, "gemini_maintenance_apparmor_unavailable")

            # 2. Missing abi/4.0
            abi = self.host_root / "etc/apparmor.d/abi/4.0"
            abi.unlink()
            with patch.object(self.mod.shutil, "which", return_value="/usr/sbin/apparmor_parser"):
                with self.assertRaises(self.mod.Failure) as ctx:
                    self.m.prepare_apparmor(self.service_info, None)
                self.assertEqual(ctx.exception.code, "gemini_maintenance_apparmor_unavailable")
            abi.write_text("fixture ABI\n", encoding="utf-8")

            # 3. Unloaded apparmor.service
            self.apparmor_state = "not-found"
            with patch.object(self.mod.shutil, "which", return_value="/usr/sbin/apparmor_parser"):
                with self.assertRaises(self.mod.Failure) as ctx:
                    self.m.prepare_apparmor(self.service_info, None)
                self.assertEqual(ctx.exception.code, "gemini_maintenance_apparmor_unavailable")
            self.apparmor_state = "loaded"

            # 4. Operator-configured AppArmorProfile= in unit file
            custom_unit = (UNIT_EXAMPLE + "\nAppArmorProfile=operator-custom\n").encode("utf-8")
            with patch.object(self.mod.shutil, "which", return_value="/usr/sbin/apparmor_parser"):
                with self.assertRaises(self.mod.Failure) as ctx:
                    self.m.prepare_apparmor(self.service_info, custom_unit)
                self.assertEqual(ctx.exception.code, "gemini_maintenance_unsupported_service_config")

            # 5. Operator-configured AppArmorProfile= in live systemd properties
            self.service_info["AppArmorProfile"] = "operator-live"
            with patch.object(self.mod.shutil, "which", return_value="/usr/sbin/apparmor_parser"):
                with self.assertRaises(self.mod.Failure) as ctx:
                    self.m.prepare_apparmor(self.service_info, None)
                self.assertEqual(ctx.exception.code, "gemini_maintenance_unsupported_service_config")
            self.service_info["AppArmorProfile"] = ""

            # 6. Operator-owned profile (no managed marker)
            profile.write_text("# operator policy\nprofile vm2api-gemini {}\n", encoding="utf-8")
            with patch.object(self.mod.shutil, "which", return_value="/usr/sbin/apparmor_parser"):
                with self.assertRaises(self.mod.Failure) as ctx:
                    self.m.prepare_apparmor(self.service_info, None)
                self.assertEqual(ctx.exception.code, "gemini_maintenance_apparmor_policy_conflict")

            # 7. Symlink profile
            target = profile.with_name("other-policy")
            profile.rename(target)
            profile.symlink_to(target)
            with patch.object(self.mod.shutil, "which", return_value="/usr/sbin/apparmor_parser"):
                with self.assertRaises(self.mod.Failure) as ctx:
                    self.m.prepare_apparmor(self.service_info, None)
                self.assertEqual(ctx.exception.code, "gemini_maintenance_apparmor_policy_conflict")
            profile.unlink()

            # 8. Parser -Q / -r failure preserves existing profile
            profile.write_bytes(self.mod.APPARMOR_PROFILE_CONTENT)
            for fail_flag in ("-Q", "-r"):
                with self.subTest(fail_flag=fail_flag):
                    def fail_cmd(argv, _timeout, code, **_kwargs):
                        if argv[1] == fail_flag:
                            raise self.mod.fail(code)
                        return b""

                    with (
                        patch.object(self.mod.shutil, "which", return_value="/usr/sbin/apparmor_parser"),
                        patch.object(self.mod, "command", side_effect=fail_cmd),
                    ):
                        with self.assertRaises(self.mod.Failure) as ctx:
                            self.m.prepare_apparmor(self.service_info, None)
                        self.assertEqual(ctx.exception.code, "gemini_maintenance_apparmor_load_failed")
                        self.assertEqual(profile.read_bytes(), self.mod.APPARMOR_PROFILE_CONTENT)

    def test_operate_preserves_dropin_rejection_and_fails_loudly_on_apparmor_error(self):
        # DropInPaths rejection must still fire first.
        with self.assertRaises(self.mod.Failure) as ctx:
            self.m.operate(
                "repair",
                None,
                {**self.service_info, "DropInPaths": "/etc/systemd/system/vm2api-gemini.service.d/10-custom.conf"},
            )
        self.assertEqual(ctx.exception.code, "gemini_maintenance_unsupported_service_config")

        # Missing apparmor_parser during repair fails loudly before touching payload/unit.
        with (
            self._mock_root_trust(),
            patch.object(self.m, "prepare_dependencies"),
            patch.object(self.mod.shutil, "which", return_value=None),
        ):
            with self.assertRaises(self.mod.Failure) as ctx:
                self.m.operate("repair", None, dict(self.service_info))
            self.assertEqual(ctx.exception.code, "gemini_maintenance_apparmor_unavailable")
            self.assertFalse(self.unit.exists())

    def test_stopped_service_static_sandbox_inspection_without_subprocess(self):
        with (
            patch.object(self.mod.subprocess, "run", side_effect=AssertionError("no subprocess allowed")),
            patch.object(self.mod.subprocess, "Popen", side_effect=AssertionError("no subprocess allowed")),
            patch.object(self.mod.shutil, "which", return_value="/usr/bin/tool"),
        ):
            # Restricted host, profile NOT loaded and unit NOT attached -> fail AppArmor restricted
            self.assertEqual(
                self.m.assess_sandbox(self.service_info),
                ("fail", "gemini_sandbox_apparmor_restricted"),
            )

            # Profile loaded in kernel, but unit still lacks AppArmorProfile=vm2api-gemini -> still fail
            (self.host_root / "sys/kernel/security/apparmor/profiles").write_text(
                "default (enforce)\nvm2api-gemini (unconfined)\n", encoding="utf-8"
            )
            self.assertEqual(
                self.m.assess_sandbox(self.service_info),
                ("fail", "gemini_sandbox_apparmor_restricted"),
            )

            # Both profile loaded AND unit attached -> pass
            self.service_info["AppArmorProfile"] = "vm2api-gemini"
            self.assertEqual(self.m.assess_sandbox(self.service_info), ("pass", None))

            # Unrestricted host -> pass without requiring profile
            (self.host_root / "proc/sys/kernel/apparmor_restrict_unprivileged_userns").write_text(
                "0\n", encoding="utf-8"
            )
            self.service_info["AppArmorProfile"] = ""
            self.assertEqual(self.m.assess_sandbox(self.service_info), ("pass", None))

    def test_active_service_reads_live_sandbox_status_from_host_socket(self):
        received = []
        reply_payload = {"ok": False, "code": "gemini_sandbox_apparmor_restricted"}

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(inner_self):
                length = int(inner_self.headers.get("Content-Length", 0))
                body = json.loads(inner_self.rfile.read(length))
                received.append((inner_self.path, body))
                raw = json.dumps(reply_payload).encode("ascii")
                inner_self.send_response(200)
                inner_self.send_header("Content-Type", "application/json")
                inner_self.send_header("Content-Length", str(len(raw)))
                inner_self.end_headers()
                inner_self.wfile.write(raw)

            def log_message(inner_self, *_args):
                pass

        class UnixServer(socketserver.UnixStreamServer):
            pass

        server = UnixServer(str(self.runtime_socket), Handler)
        self.runtime_socket.chmod(0o660)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.shutdown)
        self.addCleanup(server.server_close)

        self.service_info["ActiveState"] = "active"
        fake_sock_stat = os.stat_result(
            (stat.S_IFSOCK | 0o660, 0, 0, 1, 0, 0, 0, 0, 0, 0)
        )
        with (
            self._mock_root_trust(),
            patch.object(Path, "lstat", return_value=fake_sock_stat),
            patch.object(self.mod.subprocess, "run", side_effect=AssertionError("no subprocess allowed")),
        ):
            self.assertEqual(
                self.m.assess_sandbox(self.service_info, force_live=True),
                ("fail", "gemini_sandbox_apparmor_restricted"),
            )
            self.assertEqual(received[-1], ("/maintenance-sandbox", {"force": True}))

            reply_payload.update({"ok": True, "code": None})
            self.assertEqual(
                self.m.assess_sandbox(self.service_info, force_live=True),
                ("pass", None),
            )
            self.assertEqual(received[-1], ("/maintenance-sandbox", {"force": True}))


if __name__ == "__main__":
    unittest.main()
