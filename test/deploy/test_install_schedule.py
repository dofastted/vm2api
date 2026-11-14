"""Run with: python3 -m unittest discover -s test/deploy -v."""

import ast
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest


INSTALLER = Path(__file__).resolve().parents[2] / "deploy" / "install.sh"
# Load definitions without running the installer's command dispatch.
DEFINITIONS, DISPATCH, DISPATCH_BODY = INSTALLER.read_text().partition('\nCOMMAND="install"\n')
if not DISPATCH:
    raise RuntimeError("Installer command dispatch marker not found")


def run_installer(command, response=None, extra_env=None, mock=None):
    env = os.environ.copy()
    env["MOCK_RESPONSE"] = json.dumps(response)
    env.update(extra_env or {})
    script = DEFINITIONS + '\ncurl() { printf "%s" "$MOCK_RESPONSE"; }\n'
    if mock:
        script += mock + "\n"
    return subprocess.run(
        ["bash", "-c", script + command],
        env=env, capture_output=True, text=True, timeout=10,
    )


def run_installer_cli(args, mock, extra_env=None):
    env = os.environ.copy()
    env.update(extra_env or {})
    return subprocess.run(
        ["bash", "-c", DEFINITIONS + "\n" + mock + DISPATCH + DISPATCH_BODY,
         "install.sh", *args],
        env=env, capture_output=True, text=True, timeout=10,
    )


class ScheduleTests(unittest.TestCase):
    install_mock = r'''
need_root() { :; }
require_cmds() { :; }
resolve_host_arch() { HOST_ARCH="${TEST_ARCH:-amd64}"; }
fetch_release_files() { :; }
ensure_env() { :; }
env_set() { :; }
prepare_arch_env() { :; }
prepare_arm64_host() { :; }
start_stack() { :; }
sync_wrap_cli() { :; }
print_login_banner() { :; }
print_changelog_slice() { :; }
release_notes() { :; }
local_version() { echo 0.0.0; }
install_mode() { echo image; }
TARGET_VERSION=v1.0.0
'''

    def test_empty_install_and_upgrade_fail_if_default_crag_download_fails(self):
        for command in ("cmd_install", "cmd_upgrade"):
            for container in (False, True):
                with self.subTest(command=command, container=container), tempfile.TemporaryDirectory() as tmp:
                    (Path(tmp) / "docker-compose.yml").write_text("services: {}\n")
                    mock = self.install_mock + r'''
docker() {
  if [ "$1" = inspect ]; then echo "$CONTAINER"; return; fi
  if [ "$1" = exec ] && [ "$3" = node ]; then
    echo 'CRAG supplier download failed' >&2
    return 22
  fi
  return 1
}
node() { echo 'CRAG supplier download failed' >&2; return 22; }
'''
                    result = run_installer(
                        'INSTALL_DIR="$TEST_ROOT"; ' + command,
                        mock=mock,
                        extra_env={"TEST_ROOT": tmp, "CONTAINER": str(container).lower()},
                    )
                    self.assertEqual(result.returncode, 1, result.stderr)
                    self.assertIn("CRAG supplier download failed", result.stderr)
                    self.assertNotIn("安装完成", result.stdout)
                    self.assertNotIn("已更新到", result.stdout)
                    self.assertFalse((Path(tmp) / "share").exists())

    def test_default_crag_download_respects_no_start_no_sync_and_arm64(self):
        for command in ("cmd_install", "cmd_upgrade"):
            for setup in ("NO_START=1", "SYNC_WRAP=0", "TEST_ARCH=arm64"):
                with self.subTest(command=command, setup=setup), tempfile.TemporaryDirectory() as tmp:
                    (Path(tmp) / "docker-compose.yml").write_text("services: {}\n")
                    result = run_installer(
                        'INSTALL_DIR="$TEST_ROOT"; ' + setup + '; ' + command,
                        mock=self.install_mock + '\ndocker() { exit 99; }; node() { exit 99; }',
                        extra_env={"TEST_ROOT": tmp},
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertFalse((Path(tmp) / "share").exists())

    def test_crag_update_rejects_no_start_before_any_mutation(self):
        result = run_installer(
            'NO_START=1; cmd_update_crag',
            mock='need_root() { :; }; node() { exit 99; }; docker() { exit 99; }',
        )
        self.assertEqual(result.returncode, 1, result.stderr)

    def test_crag_pull_only_dispatches_a_separate_entrypoint_in_both_deployments(self):
        mock = r'''
need_root() { :; }
docker() {
  if [ "$1" = inspect ]; then echo "$CONTAINER"; return; fi
  printf 'docker:%s\n' "$@"
}
node() { printf 'node:%s\n' "$@"; }
'''
        for container in (False, True):
            for pull_only in (False, True):
                for tag in ("", "v2.8.15"):
                    with self.subTest(container=container, pull_only=pull_only, tag=tag):
                        args = ["crag-update", "--dir", "/custom/vm2api install"]
                        if pull_only:
                            args.append("--pull-only")
                        if tag:
                            args += ["--crag-version", tag]
                        result = run_installer_cli(
                            args, mock, {"CONTAINER": str(container).lower()},
                        )
                        self.assertEqual(result.returncode, 0, result.stderr)
                        entry = "pull-crag.mjs" if pull_only else "update-crag.mjs"
                        if container:
                            expected = ["exec", "vm2api", "node",
                                        f"/opt/vm2api/scripts/{entry}", "/opt/vm2api", tag]
                            prefix = "docker:"
                        else:
                            expected = [f"/custom/vm2api install/scripts/{entry}",
                                        "/custom/vm2api install", tag]
                            prefix = "node:"
                        self.assertEqual(result.stdout.splitlines(),
                                         [prefix + arg for arg in expected])

    def test_pull_only_rejects_other_commands_before_running_them(self):
        mock = 'need_root() { exit 99; }; node() { exit 99; }; docker() { exit 99; }'
        for command in ("install", "upgrade", "status"):
            with self.subTest(command=command):
                result = run_installer_cli([command, "--pull-only"], mock)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn("--pull-only 仅用于 crag-update", result.stderr)

    def test_pull_only_cannot_fall_back_to_an_old_full_updater(self):
        with tempfile.TemporaryDirectory() as tmp:
            scripts = Path(tmp) / "scripts"
            scripts.mkdir()
            (scripts / "update-crag.mjs").write_text("console.log('FULL_UPDATER_EXECUTED')\n")
            result = run_installer_cli(
                ["crag-update", "--pull-only", "--crag-version", "v2.8.15", "--dir", tmp],
                'need_root() { :; }; docker() { return 1; }',
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("pull-crag.mjs", result.stderr)
            self.assertNotIn("FULL_UPDATER_EXECUTED", result.stdout)

    def test_inline_python_supports_python_38_grammar(self):
        snippets = re.findall(r"python3 -c '([^']*)'", DEFINITIONS)
        self.assertTrue(snippets)
        for i, code in enumerate(snippets, 1):
            with self.subTest(snippet=i):
                ast.parse(code, feature_version=(3, 8))

    def test_hold_and_resume_responses(self):
        for function, data, message in (
            ("pause_schedulable_slots", {"paused": 2, "inflight": 1},
             "schedule hold: paused=2 inflight=1"),
            ("resume_schedulable_slots", {"restored": 2},
             "schedule resume: restored=2"),
            ("pause_schedulable_slots", {},
             "schedule hold: paused=0 inflight=0"),
            ("resume_schedulable_slots", {"restored": None},
             "schedule resume: restored=0"),
        ):
            for ok in (True, False):
                with self.subTest(function=function, data=data, ok=ok):
                    result = run_installer(
                        function + " test-key 16801", {"ok": ok, "data": data}
                    )
                    self.assertEqual(result.returncode, 0 if ok else 1, result.stderr)
                    self.assertIn(message, result.stdout)

    def test_http_failure_is_propagated(self):
        for function in ("pause_schedulable_slots", "resume_schedulable_slots"):
            with self.subTest(function=function):
                result = run_installer(
                    function + " test-key 16801", mock="curl() { return 22; }"
                )
                self.assertEqual(result.returncode, 1, result.stderr)

    def test_sync_sequence_and_recovery(self):
        mock = r'''
read_env_key() {
  case "$1" in
    VM2API_API_KEY) echo test-key ;;
    PORT) echo 16801 ;;
  esac
}
curl() {
  local args="$*" step
  case "$args" in
    */schedule/hold*)
      step=hold
      printf '%s' '{"ok":true,"data":{"paused":2,"inflight":0}}'
      ;;
    */schedule/resume*)
      step=resume
      printf '%s' '{"ok":true,"data":{"restored":2}}'
      ;;
    *'"restart":false'*)
      step=check
      printf '%s' '{"ok":true,"data":{"total":2,"changed_count":2,"failed_count":0}}'
      ;;
    *'"restart":true'*)
      step=sync
      if [ "$FAIL_SYNC" = 1 ]; then
        echo "$step" >> "$TRACE"
        return 22
      fi
      printf '%s' '{"ok":true,"data":{"total":2,"ok_count":2,"failed_count":0}}'
      ;;
    *) return 22 ;;
  esac
  echo "$step" >> "$TRACE"
}
'''
        for fail in (False, True):
            with self.subTest(fail_sync=fail), tempfile.TemporaryDirectory() as tmp:
                trace = Path(tmp) / "trace"
                result = run_installer(
                    "sync_wrap_cli", mock=mock,
                    extra_env={"TRACE": str(trace), "FAIL_SYNC": str(int(fail))},
                )
                self.assertEqual(result.returncode, int(fail), result.stderr)
                self.assertEqual(trace.read_text().splitlines(),
                                 ["check", "hold", "sync", "resume"])
                self.assertIn("schedule resume: restored=2", result.stdout)
                if not fail:
                    self.assertIn("wrap-cli/sync: 2/2, failed=0", result.stdout)


if __name__ == "__main__":
    unittest.main()
