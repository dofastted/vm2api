#!/usr/bin/env python3
"""Exercise real bootstrap commits in a private root filesystem, without systemd/network."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

REPO = Path(__file__).resolve().parents[2]
ROOT = Path("/usr/local/lib/vm2api-gemini-maintenance")
CONFIG = Path("/etc/vm2api/gemini-maintenance.json")
DAEMON = ROOT / "scripts/gemini-maintenance.py"
UNIT = Path("/etc/systemd/system/vm2api-gemini-maintenance.service")
FILES = (
    "scripts/gemini-maintenance.py",
    "deploy/gemini-maintenance.service.example",
    "scripts/gemini-host.py",
    "scripts/gemini_host_account.py",
    "scripts/gemini_host_inference.py",
    "scripts/gemini_host_native.py",
    "scripts/gemini-host-egress.sh",
    "scripts/fetch-default-gemini.py",
    "scripts/install-gemini-payload.mjs",
    "src/lib/gemini/payload.mjs",
    "deploy/payload.json",
    "deploy/gemini-host.service.example",
)


def main():
    if os.geteuid() != 0 or not Path("/opt").is_dir():
        raise SystemExit(
            "Use an isolated root namespace with private /opt, /etc, /var and /usr/local/lib"
        )
    os.umask(0o077)
    with tempfile.TemporaryDirectory(
        prefix="gemini-bootstrap-", dir="/opt"
    ) as directory:
        directory = Path(directory)
        directory.chmod(0o755)
        app = directory / "app"
        app.mkdir(mode=0o755)
        for relative in FILES:
            target = app / relative
            target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            shutil.copyfile(REPO / relative, target)
            target.chmod(0o644)
        ROOT.joinpath("scripts").mkdir(parents=True, exist_ok=True)
        CONFIG.parent.mkdir(parents=True, exist_ok=True)
        UNIT.parent.mkdir(parents=True, exist_ok=True)
        original = {
            CONFIG: b'{"install_dir":"/opt/old","bundle_dir":"/opt/old-bundle"}\n',
            DAEMON: b"# previous root daemon\n",
            UNIT: b"[Service]\n# previous root unit\n",
        }
        prefix = (
            (REPO / "deploy/install.sh").read_text().partition('COMMAND="install"')[0]
        )
        assert "prepare_gemini_maintenance()" in prefix
        driver = directory / "driver.sh"
        driver.write_text(
            prefix
            + "\n"
            + f"INSTALL_DIR={app}\n"
            + r"""
getent() { return 0; }
systemctl() {
  printf '%s\n' "$*" >> /opt/bootstrap-systemctl.log
  if [ "$1" = restart ] && [ -f /opt/bootstrap-restart-fail ]; then
    rm /opt/bootstrap-restart-fail
    return 1
  fi
  return 0
}
python3() {
  if [ "$#" = 4 ] && [ "$3" = /usr/local/lib/vm2api-gemini-maintenance/scripts/gemini-maintenance.py ] &&
    [[ "$2" = */bundles/* ]] && [ -f /opt/bootstrap-copy-fail ]; then
    rm /opt/bootstrap-copy-fail
    return 1
  fi
  /usr/bin/python3 "$@"
}
prepare_gemini_maintenance v1.4.201 source
"""
        )
        for fault in ("copy", "restart"):
            for target, data in original.items():
                target.write_bytes(data)
                target.chmod(0o600 if target == CONFIG else 0o644)
            Path("/opt/bootstrap-" + fault + "-fail").touch()
            outcome = subprocess.run(
                ["/usr/bin/bash", str(driver)], cwd="/", capture_output=True, timeout=30
            )
            assert outcome.returncode == 1, (
                fault,
                outcome.returncode,
                outcome.stderr.decode(),
            )
            assert not Path(
                "/opt/bootstrap-" + fault + "-fail"
            ).exists(), outcome.stderr.decode()
            assert all(
                target.read_bytes() == data for target, data in original.items()
            ), fault
            assert (
                "stop vm2api-gemini-maintenance.service"
                in Path("/opt/bootstrap-systemctl.log").read_text()
            )
        outcome = subprocess.run(
            ["/usr/bin/bash", str(driver)], cwd="/", capture_output=True, timeout=30
        )
        assert outcome.returncode == 0, outcome.stderr.decode()
        configured = json.loads(CONFIG.read_bytes())
        assert configured["install_dir"] == str(app)
        bundle = Path(configured["bundle_dir"])
        assert bundle.is_relative_to(ROOT / "bundles")
        assert (
            DAEMON.read_bytes() == (REPO / "scripts/gemini-maintenance.py").read_bytes()
        )
        assert (
            json.loads((bundle / "catalog.json").read_bytes())[0]["id"]
            == json.loads((app / "deploy/payload.json").read_bytes())[
                "geminiDefaultLinuxAmd64"
            ]["tag"]
        )
        current = {target: target.read_bytes() for target in original}
        (app / "scripts/gemini-maintenance.py").chmod(0o666)
        outcome = subprocess.run(
            ["/usr/bin/bash", str(driver)], cwd="/", capture_output=True, timeout=30
        )
        assert outcome.returncode == 1
        assert all(target.read_bytes() == data for target, data in current.items())
        print(
            "Bootstrap smoke passed: copy/start failure restore, atomic commit and untrusted source rejection"
        )


if __name__ == "__main__":
    main()
