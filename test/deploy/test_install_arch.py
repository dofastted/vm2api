"""Install script architecture helpers and ARM64 image-mode compose env."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


INSTALLER = Path(__file__).resolve().parents[2] / "deploy" / "install.sh"
DEFINITIONS, DISPATCH, _ = INSTALLER.read_text().partition('\nCOMMAND="install"\n')
if not DISPATCH:
    raise RuntimeError("Installer command dispatch marker not found")


def run_defs(body, extra_env=None):
    env = os.environ.copy()
    env.update(extra_env or {})
    return subprocess.run(
        ["bash", "-c", DEFINITIONS + body],
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
    )


def compose_file_in_env(env_path: Path) -> str | None:
    if not env_path.is_file():
        return None
    for line in env_path.read_text(encoding="utf-8").splitlines():
        if line.startswith("COMPOSE_FILE="):
            return line.split("=", 1)[1]
    return None


def run_prepare_arch_env(tmp: str, *, host_arch: str, mode: str) -> subprocess.CompletedProcess:
    script = (
        DEFINITIONS
        + f'INSTALL_DIR="{tmp}"\n'
        + f"HOST_ARCH={host_arch}\n"
        + f'prepare_arch_env {mode}\n'
    )
    return subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=10)


class ArchMappingTests(unittest.TestCase):
    def test_arch_of_maps_common_uname_spellings(self):
        for machine, expected in (
            ("x86_64", "amd64"),
            ("amd64", "amd64"),
            ("aarch64", "arm64"),
            ("arm64", "arm64"),
            ("ARM64", "arm64"),
            ("i686", ""),
        ):
            with self.subTest(machine=machine):
                result = run_defs(f'arch_of "{machine}"')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), expected)

    def test_image_tag_for_arm64_pins_single_arch_release(self):
        result = run_defs('HOST_ARCH=arm64; image_tag_for "v1.4.04"')
        self.assertEqual(result.stdout.strip(), "v1.4.04-arm64")

    def test_compose_file_without_arm64_override_keeps_custom_overlay(self):
        cases = (
            (
                "docker-compose.yml:docker-compose.arm64.yml",
                "docker-compose.yml",
            ),
            (
                "docker-compose.yml:docker-compose.arm64.yml:my-extra.yml",
                "docker-compose.yml:my-extra.yml",
            ),
            (
                "/opt/vm2api/docker-compose.yml:/opt/vm2api/docker-compose.arm64.yml:/opt/vm2api/my-extra.yml",
                "/opt/vm2api/docker-compose.yml:/opt/vm2api/my-extra.yml",
            ),
        )
        for before, expected in cases:
            with self.subTest(before=before):
                result = run_defs(f'compose_file_without_arm64_override "{before}"')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), expected)

    def test_image_mode_arm64_strips_only_arm64_override(self):
        with tempfile.TemporaryDirectory() as tmp:
            envf = Path(tmp) / ".env"
            envf.write_text(
                "COMPOSE_FILE=docker-compose.yml:docker-compose.arm64.yml:my-extra.yml\n",
                encoding="utf-8",
            )
            result = run_prepare_arch_env(tmp, host_arch="arm64", mode="image")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                compose_file_in_env(envf),
                "docker-compose.yml:my-extra.yml",
            )

    def test_image_mode_arm64_empty_compose_file_stays_unset(self):
        with tempfile.TemporaryDirectory() as tmp:
            envf = Path(tmp) / ".env"
            envf.write_text("VM2API_IMAGE_TAG=v1.2.0-arm64\n", encoding="utf-8")
            result = run_prepare_arch_env(tmp, host_arch="arm64", mode="image")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIsNone(compose_file_in_env(envf))

    def test_image_mode_amd64_leaves_compose_file_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            envf = Path(tmp) / ".env"
            original = "docker-compose.yml:docker-compose.arm64.yml:my-extra.yml"
            envf.write_text(f"COMPOSE_FILE={original}\n", encoding="utf-8")
            result = run_prepare_arch_env(tmp, host_arch="amd64", mode="image")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(compose_file_in_env(envf), original)

    def test_source_mode_arm64_still_sets_compose_file_when_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            envf = Path(tmp) / ".env"
            envf.write_text("PORT=8787\n", encoding="utf-8")
            (Path(tmp) / "docker-compose.arm64.yml").write_text("services: {}\n", encoding="utf-8")
            result = run_prepare_arch_env(tmp, host_arch="arm64", mode="source")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                compose_file_in_env(envf),
                "docker-compose.yml:docker-compose.arm64.yml",
            )


if __name__ == "__main__":
    unittest.main()
