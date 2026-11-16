"""Entrypoint warns (without failing) when an ARM64 host cannot execute x86 helpers."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ENTRYPOINT = Path(__file__).resolve().parents[2] / "scripts" / "docker-entrypoint.sh"
TEXT = ENTRYPOINT.read_text()
START = TEXT.index('X86_PROBE="${KIN_X86_PROBE_BIN')
END = TEXT.index("# No seeded vm-01", START)
SNIPPET = "set -eu\n" + TEXT[START:END] + "echo reached\n"


def run(machine, probe_body):
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        (tmp / "uname").write_text(f"#!/bin/sh\necho {machine}\n")
        (tmp / "uname").chmod(0o755)
        env = dict(os.environ, PATH=f"{tmp}:{os.environ['PATH']}")
        if probe_body is not None:
            probe = tmp / "probe"
            probe.write_text(probe_body)
            probe.chmod(0o755)
            env["KIN_X86_PROBE_BIN"] = str(probe)
        else:
            env["KIN_X86_PROBE_BIN"] = str(tmp / "absent")
        return subprocess.run(["sh", "-c", SNIPPET], env=env, capture_output=True, text=True, timeout=10)


class ProbeTests(unittest.TestCase):
    def test_working_handler_is_silent(self):
        result = run("aarch64", "#!/bin/sh\nexit 2\n")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "")
        self.assertIn("reached", result.stdout)

    def test_unexecutable_binary_warns_and_continues(self):
        for body in ("#!/no/such/interpreter\n", "\x7fELF not really\n"):
            result = run("aarch64", body)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("qemu-x86_64 binfmt handler", result.stderr)
            self.assertIn("reached", result.stdout)

    def test_amd64_host_and_missing_probe_skip(self):
        self.assertEqual(run("x86_64", "#!/no/such/interpreter\n").stderr, "")
        result = run("aarch64", None)
        self.assertEqual(result.stderr, "")
        self.assertIn("reached", result.stdout)


if __name__ == "__main__":
    unittest.main()
