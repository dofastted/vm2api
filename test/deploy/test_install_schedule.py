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
DEFINITIONS, DISPATCH, _ = INSTALLER.read_text().partition('\nCOMMAND="install"\n')
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


class ScheduleTests(unittest.TestCase):
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
