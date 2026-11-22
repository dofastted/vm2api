#!/usr/bin/env python3
"""Offline Docker Desktop smoke for the Gemini maintenance runtime bind mount.

Run: python3 test/deploy/gemini-maintenance-systemd-smoke.py --broker-image IMAGE
IMAGE must contain systemd, Python 3, util-linux and passwd (e.g. Ubuntu 24.04
with those packages installed). The test uses cached Linux/amd64 images only,
does not build/pull, and never mounts host data. Its isolated broker needs
SYS_ADMIN for a private cgroup2 mount. Use disposable Docker Desktop only.
"""

import argparse
import io
import json
from pathlib import Path
import signal
import subprocess
import sys
import tarfile
import time
import uuid


REPO = Path(__file__).resolve().parents[2]
UNIT = "gemini-maintenance.service"
BOOT_TARGET = "gemini-maintenance-smoke.target"
RUNTIME_NAME = "vm2api-gemini-maintenance"
RUNTIME = "/run/" + RUNTIME_NAME
SOCKET = RUNTIME + "/control.sock"
BUNDLE = "/usr/local/lib/vm2api-gemini-maintenance"
INSTALL = "/fixture/install"
NO_PRESERVE = f"/etc/systemd/system/{UNIT}.d/90-no-preserve.conf"
GID = 29643
STATUS = "/api/panel/gemini/maintenance"
BASE_URL = "http://127.0.0.1:8765"
UNAVAILABLE = {
    "available": False,
    "bootstrap_required": True,
    "code": "gemini_maintenance_unavailable",
}

# The fixture boots an empty target, never the image's default target. Mask
# these as defense in depth; in particular do not run sysctl or set up devices.
MASKS = (
    "systemd-sysctl.service",
    "procps.service",
    "systemd-modules-load.service",
    "systemd-udevd.service",
    "systemd-udevd-control.socket",
    "systemd-udevd-kernel.socket",
    "systemd-udev-trigger.service",
    "systemd-remount-fs.service",
    "systemd-tmpfiles-setup.service",
    "systemd-tmpfiles-setup-dev.service",
    "systemd-tmpfiles-setup-dev-early.service",
    "systemd-journald.service",
    "systemd-journald.socket",
    "systemd-journald-dev-log.socket",
    "systemd-journald-audit.socket",
    "systemd-journal-flush.service",
    "systemd-networkd.service",
)

INIT = r"""set -eu
fail() { echo "smoke bootstrap: $*" >&2; exit 1; }
[ "$$" -eq 1 ] || fail 'bootstrap is not PID 1'
[ "$(cat /proc/self/cgroup)" = '0::/' ] || fail 'not at private cgroup v2 root'
case ",$(findmnt -nro VFS-OPTIONS --target /proc/sys)," in
    *,ro,*) ;;
    *) fail '/proc/sys is not mounted read-only' ;;
esac
mountpoint -q /run || fail '/run volume is not mounted'
if [ ! -w /sys/fs/cgroup/cgroup.procs ]; then
    umount /sys/fs/cgroup || fail 'cannot unmount the container cgroup view'
    mount -t cgroup2 -o rw,nosuid,nodev,noexec cgroup2 /sys/fs/cgroup \
        || fail 'daemon security policy blocked a private, writable cgroup2 mount'
fi
[ "$(findmnt -nro FSTYPE,FSROOT --target /sys/fs/cgroup)" = 'cgroup2 /' ] \
    || fail 'not a cgroup2 mount rooted at the private cgroup'
[ -w /sys/fs/cgroup/cgroup.procs ] || fail 'private cgroup2 mount is not writable'
if ! getent group vm2api >/dev/null; then
    groupadd --gid "$1" vm2api
fi
[ "$(getent group vm2api | cut -d : -f 3)" = "$1" ] || fail 'unexpected vm2api gid'
export container=docker
export SYSTEMD_GENERATOR_PATH=/fixture/no-generators
export SYSTEMD_ENVIRONMENT_GENERATOR_PATH=/fixture/no-generators
exec /lib/systemd/systemd --unit="$2" --log-target=console --show-status=no
"""

GATEWAY = f"""import http from 'node:http'
import {{ createGeminiMaintenanceHandler }} from './maintenance.mjs'

const status = createGeminiMaintenanceHandler({{
  json(res, code, data) {{
    res.writeHead(code, {{ 'Content-Type': 'application/json' }})
    res.end(JSON.stringify(data))
  }},
  readBody() {{ throw new Error('status fixture does not accept bodies') }},
}})
http.createServer((req, res) => {{
  if (req.method === 'GET' && req.url === {json.dumps(STATUS)}) {{
    void status(req, res, req.url)
  }} else if (req.method === 'GET' && req.url === '/ready') {{
    res.writeHead(204).end()
  }} else {{
    res.writeHead(404).end()
  }}
}}).listen(8765, '127.0.0.1')
"""

GET = """const response = await fetch(process.argv[1], { signal: AbortSignal.timeout(10000) })
if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
console.log(await response.text())
"""


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def docker(*args, data=None, timeout=30, include_stderr=False):
    argv = ["docker", *args]
    try:
        result = subprocess.run(
            argv,
            input=data,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT if include_stderr else subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(
            f"docker {' '.join(args[:3])} timed out after {timeout}s"
        ) from error
    except OSError as error:
        raise RuntimeError(f"cannot run Docker CLI: {error}") from error
    text = result.stdout.decode(errors="replace").strip()
    if result.returncode != 0:
        reason = (result.stderr or b"").decode(errors="replace").strip() or text
        raise RuntimeError(f"docker {' '.join(args[:3])}: {reason}")
    return text


def copy_archive(container, *, files, directories=(), masks=()):
    """Copy only the listed paths; no context, Dockerfile, build, or host bind."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        for path in directories:
            entry = tarfile.TarInfo(path.lstrip("/"))
            entry.type = tarfile.DIRTYPE
            entry.mode = 0o755
            archive.addfile(entry)
        for path, contents in files.items():
            payload = (
                contents.encode("utf-8") if isinstance(contents, str) else contents
            )
            entry = tarfile.TarInfo(path.lstrip("/"))
            entry.size = len(payload)
            entry.mode = 0o644
            archive.addfile(entry, io.BytesIO(payload))
        for unit in masks:
            entry = tarfile.TarInfo(f"etc/systemd/system/{unit}")
            entry.type = tarfile.SYMTYPE
            entry.linkname = "/dev/null"
            archive.addfile(entry)
    docker("cp", "-", f"{container}:/", data=buffer.getvalue())


def wait_for(description, probe):
    deadline = time.monotonic() + 25
    while True:
        try:
            probe()
            return
        except RuntimeError as error:
            if time.monotonic() >= deadline:
                raise RuntimeError(f"{description} not ready: {error}") from error
            time.sleep(0.5)


def preflight(*images):
    os_type, cgroup, operating_system, security = docker(
        "info",
        "--format",
        "{{.OSType}}\n{{.CgroupVersion}}\n{{.OperatingSystem}}\n{{json .SecurityOptions}}",
    ).splitlines()
    require(
        os_type == "linux"
        and cgroup == "2"
        and operating_system.startswith("Docker Desktop"),
        "select a Linux Docker Desktop daemon with cgroup v2 (check the Docker context)",
    )
    security = json.loads(security) or []
    require(
        not any("name=rootless" in option for option in security),
        "rootful Docker is required",
    )
    for image in images:
        platform, volumes = docker(
            "image",
            "inspect",
            image,
            "--format",
            "{{.Os}}/{{.Architecture}}\n{{json .Config.Volumes}}",
        ).splitlines()
        require(platform == "linux/amd64", f"need cached Linux/amd64 image: {image}")
        require(
            not json.loads(volumes),
            f"{image} declares anonymous volumes; use a clean base image",
        )
    # Docker's default AppArmor profile denies mount(2) even with SYS_ADMIN.
    if any("name=apparmor" in option for option in security):
        return ["--security-opt=apparmor=unconfined"]
    return []


class Fixture:
    def __init__(self, broker_image, node_image, mount_security):
        self.broker_image = broker_image
        self.node_image = node_image
        self.mount_security = mount_security
        self.prefix = "vm2api-gemini-systemd-" + uuid.uuid4().hex
        self.broker = self.prefix + "-broker"
        self.volume = self.prefix + "-run"
        self.containers = []
        self.volume_attempted = False
        self.common = [
            "--pull=never",
            "--platform=linux/amd64",
            "--network=none",
            "--cgroupns=private",
            "--no-healthcheck",
            "--restart=no",
            "--pids-limit=256",
            "--log-driver=local",
            "--security-opt=no-new-privileges=true",
            "--workdir=/",
            "--label",
            f"vm2api.gemini-systemd-smoke={self.prefix}",
        ]
        # Do not inherit injected Docker client proxy settings (which can have credentials).
        for key in ("HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "FTP_PROXY"):
            self.common.extend(["--env", key + "=", "--env", key.lower() + "="])

    def create(self, name, *options):
        self.containers.append(name)
        docker("create", "--name", name, *self.common, *options)

    def systemctl(self, *args):
        return docker("exec", self.broker, "/usr/bin/systemctl", "--no-pager", *args)

    def boot_broker(self):
        self.volume_attempted = True
        docker(
            "volume",
            "create",
            "--driver=local",
            "--label",
            f"vm2api.gemini-systemd-smoke={self.prefix}",
            self.volume,
        )
        self.create(
            self.broker,
            "--user=0:0",
            "--tty",
            "--cap-add=SYS_ADMIN",
            "--cap-drop=NET_RAW",
            "--cap-drop=MKNOD",
            *self.mount_security,
            "--mount",
            f"type=volume,source={self.volume},target=/run,volume-nocopy",
            "--entrypoint=/bin/sh",
            self.broker_image,
            "/fixture/init.sh",
            str(GID),
            BOOT_TARGET,
        )
        descriptor = (REPO / "deploy/payload.json").read_bytes()
        tag = json.loads(descriptor)["geminiDefaultLinuxAmd64"]["tag"]
        catalog = [
            {"id": tag, "version": tag.split("-gemini-", 1)[1], "cli_version": "1.5.9"}
        ]
        copy_archive(
            self.broker,
            directories=("/fixture", INSTALL, "/fixture/no-generators"),
            masks=MASKS,
            files={
                "/fixture/init.sh": INIT,
                f"/etc/systemd/system/{BOOT_TARGET}": "[Unit]\nDefaultDependencies=no\n",
                f"/etc/systemd/system/{UNIT}": (
                    REPO / "deploy/gemini-maintenance.service.example"
                ).read_bytes(),
                f"/etc/systemd/system/{UNIT}.d/10-smoke.conf": (
                    "[Unit]\nDefaultDependencies=no\n"
                    "[Service]\nStandardOutput=tty\nStandardError=inherit\nTTYPath=/dev/console\n"
                    "CapabilityBoundingSet=CAP_CHOWN\nNoNewPrivileges=yes\n"
                ),
                NO_PRESERVE: "[Service]\nRuntimeDirectoryPreserve=no\n",
                "/etc/vm2api/gemini-maintenance.json": json.dumps(
                    {"install_dir": INSTALL, "bundle_dir": BUNDLE}
                ),
                f"{BUNDLE}/scripts/gemini-maintenance.py": (
                    REPO / "scripts/gemini-maintenance.py"
                ).read_bytes(),
                f"{BUNDLE}/src/lib/gemini/payload.mjs": (
                    REPO / "src/lib/gemini/payload.mjs"
                ).read_bytes(),
                f"{BUNDLE}/deploy/payload.json": descriptor,
                f"{BUNDLE}/catalog.json": json.dumps(catalog),
            },
        )
        docker("start", self.broker)
        wait_for(
            "isolated systemd target", lambda: self.systemctl("is-active", BOOT_TARGET)
        )
        self.systemctl("start", UNIT)

    def launch_gateway(self, phase):
        gateway = self.prefix + "-" + phase
        # Mount the CHILD into the gateway, not /run. The broker has a parent
        # mount and can unlink the child; the gateway stays pinned to its inode.
        self.create(
            gateway,
            f"--user=1000:{GID}",
            "--cap-drop=ALL",
            "--env",
            f"KIN_GEMINI_MAINTENANCE_SOCKET={SOCKET}",
            "--mount",
            (
                f"type=volume,source={self.volume},target={RUNTIME},readonly,volume-nocopy,"
                f"volume-subpath={RUNTIME_NAME}"
            ),
            "--entrypoint=node",
            self.node_image,
            "/fixture/gateway.mjs",
        )
        copy_archive(
            gateway,
            directories=("/fixture",),
            files={
                "/fixture/gateway.mjs": GATEWAY,
                "/fixture/maintenance.mjs": (
                    REPO / "src/lib/gemini/maintenance.mjs"
                ).read_bytes(),
            },
        )
        docker("start", gateway)
        wait_for(f"{phase} gateway", lambda: self.http_get(gateway, "/ready"))
        return gateway

    @staticmethod
    def http_get(gateway, path):
        # The exec is just the loopback HTTP driver: PID 1 runs the actual client.
        return docker(
            "exec",
            gateway,
            "node",
            "--input-type=module",
            "--eval",
            GET,
            BASE_URL + path,
        )

    def status(self, gateway, *, available):
        reply = json.loads(self.http_get(gateway, STATUS))
        data = reply.get("data", {})
        require(reply.get("ok") is True, f"unsuccessful gateway status: {reply}")
        if available:
            checks = {check["id"]: check["state"] for check in data.get("checks", [])}
            require(
                data.get("available") is True
                and data.get("install_dir") == INSTALL
                and checks.get("systemd") == "pass"
                and checks.get("platform") == "pass",
                f"expected status from the fixture broker through the mounted socket: {data}",
            )
        else:
            require(
                data == UNAVAILABLE, f"expected stale or absent broker socket: {data}"
            )

    def broker_instance(self, preserve):
        raw = self.systemctl(
            "show",
            "--property=ActiveState,MainPID,InvocationID,RuntimeDirectoryPreserve",
            UNIT,
        )
        props = dict(line.split("=", 1) for line in raw.splitlines())
        invocation = props.get("InvocationID")
        require(
            props.get("ActiveState") == "active"
            and int(props.get("MainPID", "0")) > 0
            and invocation
            and int(invocation, 16) != 0
            and props.get("RuntimeDirectoryPreserve") == preserve,
            f"expected active broker with RuntimeDirectoryPreserve={preserve}, got: {props}",
        )
        docker("exec", self.broker, "/usr/bin/test", "-S", SOCKET)
        return invocation

    @staticmethod
    def gateway_identity(gateway):
        ident, pid, started, running = docker(
            "container",
            "inspect",
            "--format",
            "{{.Id}} {{.State.Pid}} {{.State.StartedAt}} {{.State.Running}}",
            gateway,
        ).split()
        require(running == "true" and int(pid) > 0, f"gateway {gateway} is not running")
        return ident, pid, started

    @staticmethod
    def directory_identity(container):
        return docker("exec", container, "/usr/bin/stat", "--format=%d:%i", RUNTIME)

    def exercise(self):
        self.boot_broker()
        gateway = self.launch_gateway("negative")
        original = self.directory_identity(self.broker)
        require(
            self.directory_identity(gateway) == original,
            "negative gateway did not pin the broker directory",
        )
        identity = self.gateway_identity(gateway)
        invocation = self.broker_instance("no")
        self.status(gateway, available=True)
        self.systemctl("stop", UNIT)
        docker("exec", self.broker, "/usr/bin/test", "!", "-e", RUNTIME)
        self.systemctl("start", UNIT)
        require(
            self.broker_instance("no") != invocation,
            "negative phase broker did not restart",
        )
        require(
            self.directory_identity(self.broker) != original,
            "negative phase broker directory inode did not change",
        )
        require(
            self.directory_identity(gateway) == original,
            "negative phase gateway mount did not remain stale",
        )
        self.status(gateway, available=False)
        require(
            self.gateway_identity(gateway) == identity,
            "negative phase gateway was restarted",
        )
        print(
            "PASS negative control: broker gets a new inode; unchanged gateway loses status",
            flush=True,
        )
        docker("rm", "--force", gateway)
        self.containers.remove(gateway)

        # Remount once between phases to recover from the deliberately stale mount.
        # This is the last create/start of a gateway in the whole smoke.
        docker("exec", self.broker, "/usr/bin/rm", NO_PRESERVE)
        self.systemctl("daemon-reload")
        gateway = self.launch_gateway("fixed")
        identity = self.gateway_identity(gateway)
        original = self.directory_identity(self.broker)

        def check_fixed(phase, *, available):
            for container in (self.broker, gateway):
                current = self.directory_identity(container)
                require(
                    current == original,
                    f"{phase}: {container} directory {original} changed to {current}",
                )
            self.status(gateway, available=available)
            actual = self.gateway_identity(gateway)
            require(
                actual == identity,
                f"{phase}: gateway ID/PID/StartedAt {identity} changed to {actual}",
            )

        invocation = self.broker_instance("yes")
        check_fixed("before stop", available=True)
        self.systemctl("stop", UNIT)
        docker("exec", self.broker, "/usr/bin/test", "!", "-e", SOCKET)
        check_fixed("while stopped", available=False)
        self.systemctl("start", UNIT)
        started = self.broker_instance("yes")
        require(
            started != invocation,
            "fixed phase stop/start did not replace the broker invocation",
        )
        check_fixed("after stop/start", available=True)
        self.systemctl("restart", UNIT)
        require(
            self.broker_instance("yes") != started,
            "fixed phase restart did not replace the broker invocation",
        )
        check_fixed("after restart", available=True)
        print(
            f"PASS fixed: broker stop/start and restart preserve directory {original} and gateway {identity}",
            flush=True,
        )

    def diagnostics(self):
        for name in self.containers:
            try:
                log = docker(
                    "logs", "--tail", "60", name, timeout=10, include_stderr=True
                )
            except RuntimeError as error:
                log = str(error)
            print(f"{name} logs:\n{log}", file=sys.stderr)

    def cleanup(self):
        errors = []
        commands = [("rm", "--force", name) for name in reversed(self.containers)]
        if self.volume_attempted:
            commands.append(("volume", "rm", self.volume))
        for command in commands:
            try:
                docker(*command)
            except RuntimeError as error:
                if "no such" not in str(error).lower():
                    errors.append(str(error))
        if errors:
            print(
                f"cleanup failed for {self.prefix}: {'; '.join(errors)}",
                file=sys.stderr,
            )
        return not errors


def interrupted(signum, _frame):
    raise SystemExit(128 + signum)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--broker-image",
        required=True,
        help="cached Linux/amd64 image with systemd, python3, util-linux and passwd",
    )
    parser.add_argument("--node-image", default="node:24-bookworm-slim")
    args = parser.parse_args()
    try:
        mount_security = preflight(args.broker_image, args.node_image)
    except RuntimeError as error:
        print(error, file=sys.stderr)
        return 1
    fixture = Fixture(args.broker_image, args.node_image, mount_security)
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    print(f"Gemini maintenance systemd smoke: {fixture.prefix}", flush=True)
    status = 0
    try:
        fixture.exercise()
    except (RuntimeError, ValueError, KeyError, OSError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        fixture.diagnostics()
        status = 1
    finally:
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        if not fixture.cleanup():
            status = 1
    return status


if __name__ == "__main__":
    sys.exit(main())
