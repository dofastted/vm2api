#!/usr/bin/env python3
"""Install native static QEMU and transactionally select one binfmt handler.

Run as root or as a Docker user with noninteractive sudo permission. --check
only reads installed files and kernel state. The managed systemd-binfmt config
persists the intended registration; legacy manager configuration is untouched.
On failure, restore the previous runtime descriptor and enabled state, then
remove only files newly installed by this transaction. Reboot is not tested.
"""

import argparse
from dataclasses import dataclass
import os
from pathlib import Path
import platform
import re
import stat
import struct
import subprocess
import sys
import tempfile


IMAGE = "tonistiigi/binfmt@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0"
NAME = "qemu-x86_64"
QEMU = Path("/usr/local/libexec/vm2api/qemu-x86_64")
CONF = Path("/etc/binfmt.d/qemu-x86_64.conf")
KERNEL = Path("/proc/sys/fs/binfmt_misc")
MAGIC = bytes.fromhex("7f454c4602010100000000000000000002003e00")
MASK = bytes.fromhex("fffffffffffefe00fffffffffffffffffeffffff")


def escaped(data):
    return "".join("\\x%02x" % byte for byte in data)


CONF_BYTES = (f":{NAME}:M::{escaped(MAGIC)}:{escaped(MASK)}:{QEMU}:POCF\n").encode("ascii")
PAGE_SIZE = 4096
# Same search order as systemd binfmt.d and OpenRC's binfmt service; /etc wins.
BINFMT_DIRS = (Path("/etc"), Path("/run"), Path("/usr/local/lib"), Path("/usr/lib"))
SYSTEMD_BINFMT = (Path("/usr/lib/systemd/systemd-binfmt"), Path("/lib/systemd/systemd-binfmt"))
OPENRC_RUN = (Path("/sbin/openrc-run"), Path("/usr/sbin/openrc-run"))
CONTAINER_MARKERS = (Path("/.dockerenv"), Path("/run/.containerenv"), Path("/run/systemd/container"))
# x86_64 ELF headers (EXEC and DYN) a competing handler could claim before ours.
X86_SAMPLES = (MAGIC, MAGIC[:16] + b"\x03" + MAGIC[17:])
PAGE_HINT = ("Bun (oven-sh/bun#17627) and qemu-user are not supported on 16K/64K page kernels; "
             "boot a 4K-page kernel (Ubuntu: linux-generic instead of linux-generic-64k; "
             "Raspberry Pi 5: kernel=kernel8.img in config.txt). Asahi Linux is unsupported.")


class PrepareError(RuntimeError):
    pass


@dataclass(frozen=True)
class Handler:
    enabled: bool
    interpreter: str
    offset: int
    magic: bytes
    mask: bytes
    flags: str

    def registration(self):
        return registration_bytes(self)


def parse_handler(text):
    lines = text.strip().splitlines()
    if not lines or lines[0] not in ("enabled", "disabled"):
        raise PrepareError("Cannot reconstruct old kernel handler: invalid enabled state")
    fields = {}
    for line in lines[1:]:
        if line.startswith("flags:"):
            key, value = "flags", line[6:].strip()
        else:
            parts = line.split(None, 1)
            if len(parts) != 2:
                raise PrepareError("Cannot reconstruct old kernel handler: malformed field")
            key, value = parts
        if key in fields:
            raise PrepareError("Cannot reconstruct old kernel handler: duplicate field")
        fields[key] = value
    if set(fields) != {"interpreter", "flags", "offset", "magic", "mask"}:
        raise PrepareError("Cannot reconstruct old kernel handler: incomplete descriptor")
    try:
        if not re.fullmatch(r"[0-9]+", fields["offset"]):
            raise ValueError("invalid offset")
        offset = int(fields["offset"])
        if not re.fullmatch(r"(?:[0-9a-fA-F]{2})+", fields["magic"]):
            raise ValueError("invalid magic")
        if not re.fullmatch(r"(?:[0-9a-fA-F]{2})+", fields["mask"]):
            raise ValueError("invalid mask")
        magic, mask = bytes.fromhex(fields["magic"]), bytes.fromhex(fields["mask"])
        if len(magic) != len(mask) or offset + len(magic) > 256:
            raise ValueError("invalid magic/mask length")
        if not re.fullmatch(r"[POCF]*", fields["flags"]) or len(set(fields["flags"])) != len(fields["flags"]):
            raise ValueError("invalid flags")
        interpreter = fields["interpreter"]
        if not interpreter.startswith("/") or any(c in interpreter for c in ":\n\r\x00"):
            raise ValueError("invalid interpreter")
        handler = Handler(lines[0] == "enabled", interpreter, offset, magic, mask, fields["flags"])
        registration_bytes(handler)
        return handler
    except ValueError as exc:
        raise PrepareError(f"Cannot reconstruct old kernel handler: {exc}") from exc


def registration_bytes(handler):
    # The kernel accepts textual \\xNN escapes for binary magic and masks.
    # Escape every byte so embedded NULs cannot truncate descriptor fields.
    fields = [NAME.encode(), b"M", str(handler.offset).encode(), escaped(handler.magic).encode(),
              escaped(handler.mask).encode(), handler.interpreter.encode(), handler.flags.encode()]
    for delimiter in range(33, 127):
        sep = bytes([delimiter])
        if all(sep not in field for field in fields):
            return sep + sep.join(fields)
    raise ValueError("no safe delimiter for old kernel descriptor")


def validate_elf(data):
    """Check ELF64/AArch64 and reject PT_INTERP or dynamic DT_NEEDED."""
    if len(data) < 64 or data[:7] != b"\x7fELF\x02\x01\x01":
        raise PrepareError("QEMU must be a little-endian ELF64 executable")
    header = struct.unpack_from("<HHIQQQIHHHHHH", data, 16)
    kind, machine, version = header[:3]
    phoff, ehsize, phentsize, phnum = header[4], header[7], header[8], header[9]
    if kind not in (2, 3) or machine != 183 or version != 1 or ehsize != 64:
        raise PrepareError("QEMU must be an AArch64 executable")
    if phentsize != 56 or not phnum or phnum == 0xffff or phoff < 64 or phoff + phnum * phentsize > len(data):
        raise PrepareError("QEMU has an invalid ELF program-header table")
    executable_load = False
    for index in range(phnum):
        ptype, flags, offset, _, _, size, memsize, _ = struct.unpack_from("<IIQQQQQQ", data, phoff + index * phentsize)
        if offset + size > len(data) or (ptype == 1 and size > memsize):
            raise PrepareError("QEMU has an invalid ELF segment")
        if ptype == 1 and flags & 1:
            executable_load = True
        if ptype == 3:
            raise PrepareError("QEMU is dynamically linked (PT_INTERP)")
        if ptype == 2:
            if size % 16:
                raise PrepareError("QEMU has an invalid ELF dynamic segment")
            terminated = False
            for position in range(offset, offset + size, 16):
                tag, _ = struct.unpack_from("<qQ", data, position)
                if tag == 0:
                    terminated = True
                    break
                if tag == 1:
                    raise PrepareError("QEMU has a shared-library dependency (DT_NEEDED)")
            if not terminated:
                raise PrepareError("QEMU has an unterminated ELF dynamic segment")
    if not executable_load:
        raise PrepareError("QEMU lacks an executable ELF load segment")


@dataclass(frozen=True)
class Check:
    name: str
    ok: bool
    detail: str
    hint: str = ""

    def line(self):
        text = f"[{'ok' if self.ok else 'fail'}] {self.name}: {self.detail}"
        return text + (f"\n       -> {self.hint}" if self.hint and not self.ok else "")


def foreign_handler(text):
    """Lenient parse of another enabled magic handler; None for disabled/extension/odd ones."""
    lines = text.strip().splitlines()
    if not lines or lines[0] != "enabled":
        return None
    fields = {}
    for line in lines[1:]:
        parts = line.split(None, 1)
        if len(parts) == 2 and not line.startswith("flags:"):
            fields[parts[0]] = parts[1].strip()
    if "magic" not in fields:
        return None
    try:
        magic = bytes.fromhex(fields["magic"])
        mask = bytes.fromhex(fields.get("mask", "ff" * len(magic)))
        offset = int(fields.get("offset", "0"))
    except ValueError:
        return None
    if len(mask) != len(magic):
        return None
    return Handler(True, fields.get("interpreter", ""), offset, magic, mask, "")


def matches_x86_64(handler):
    for sample in X86_SAMPLES:
        if handler.offset + len(handler.magic) > len(sample):
            continue
        window = sample[handler.offset:handler.offset + len(handler.magic)]
        if all((b & m) == (g & m) for b, g, m in zip(window, handler.magic, handler.mask)):
            return True
    return False


def host_checks(ops):
    """Everything that must hold before touching the host; pure over ops facts."""
    checks = []
    machine = ops.machine()
    checks.append(Check("arch", machine in ("linux/aarch64", "linux/arm64"), machine,
                        "run this preparer on a Linux AArch64 host"))
    page = ops.page_size()
    checks.append(Check("page-size", page == PAGE_SIZE, f"{page} bytes", PAGE_HINT))
    container = ops.container()
    checks.append(Check("container", container is None, container or "host",
                        "binfmt handlers belong to the host kernel; run this on the host, not inside a container"))
    status = ops.binfmt_status()
    checks.append(Check("binfmt_misc", status == "enabled", status or "not mounted",
                        "modprobe binfmt_misc && mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc"
                        if status is None else "echo 1 > /proc/sys/fs/binfmt_misc/status"))
    init = ops.init_system()
    checks.append(Check("init", init is not None,
                        init or "neither systemd-binfmt executable nor OpenRC binfmt service found",
                        "registration would be lost on reboot; use a systemd or OpenRC host"))
    sources = ops.conf_sources()
    managed = CONF in sources
    others = [str(path) for path in sources if path != CONF]
    detail = ("vm2api " + str(CONF) if managed else "vm2api file not installed yet")
    if others:
        detail += "; overrides distro " + ", ".join(others)
    checks.append(Check("binfmt.d", True, detail))
    shadows = ops.shadowing_handlers() if status == "enabled" else []
    checks.append(Check("other-x86-handlers", not shadows, ", ".join(shadows) or "none",
                        "another enabled handler also claims x86_64 ELF; disable it with "
                        "'echo -1 > /proc/sys/fs/binfmt_misc/<name>' and remove its binfmt.d entry or package"))
    return checks


def desired_handler(handler):
    return (handler is not None and handler.enabled and handler.interpreter == str(QEMU)
            and handler.offset == 0 and handler.magic == MAGIC and handler.mask == MASK
            and set(handler.flags) == set("POCF"))


class Operations:
    """Host operations kept separate so tests never need Docker or root."""

    def run(self, args, privileged=False, data=None):
        if privileged and os.geteuid() != 0:
            args = ["sudo", "-n", "--"] + list(args)
        result = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode:
            detail = result.stderr.decode(errors="replace").strip()
            raise PrepareError(f"{' '.join(args)} failed ({result.returncode}): {detail}")
        return result.stdout

    def machine(self):
        return f"{platform.system().lower()}/{platform.machine().lower()}"

    def page_size(self):
        return os.sysconf("SC_PAGE_SIZE")

    def container(self):
        for marker in CONTAINER_MARKERS:
            if marker.exists():
                return f"container ({marker})"
        try:
            environ = Path("/proc/1/environ").read_bytes()
        except OSError:
            return None
        for item in environ.split(b"\0"):
            if item.startswith(b"container="):
                return "container (" + item.decode(errors="replace") + ")"
        return None

    def binfmt_status(self):
        if not (KERNEL / "register").exists():
            return None
        return (KERNEL / "status").read_text().strip()

    def systemd_binfmt(self):
        return next((str(p) for p in SYSTEMD_BINFMT if p.is_file()), None)

    def init_system(self):
        if self.systemd_binfmt():
            return "systemd"
        if any(p.is_file() for p in OPENRC_RUN) and Path("/etc/init.d/binfmt").is_file():
            return "openrc"
        return None

    def conf_sources(self):
        return [path for path in (d / "binfmt.d" / f"{NAME}.conf" for d in BINFMT_DIRS) if path.exists()]

    def shadowing_handlers(self):
        names = []
        for entry in sorted(KERNEL.iterdir()):
            if entry.name in ("register", "status", NAME):
                continue
            try:
                handler = foreign_handler(entry.read_text())
            except OSError:
                continue
            if handler is not None and matches_x86_64(handler):
                names.append(f"{entry.name} ({handler.interpreter})")
        return names

    def report(self):
        return host_checks(self)

    def preflight(self):
        failures = [check for check in host_checks(self) if not check.ok]
        if failures:
            raise PrepareError("Host is not supported:\n" + "\n".join(c.line() for c in failures))

    def managed_bytes(self, path):
        for part in (path, *path.parents):
            if part.is_symlink():
                raise PrepareError(f"Refusing symlink in managed path: {part}")
        try:
            mode = path.stat().st_mode
        except FileNotFoundError:
            return None
        if not stat.S_ISREG(mode):
            raise PrepareError(f"Managed path is not a regular file: {path}")
        return path.read_bytes()

    def executable(self, path):
        return Path(path).is_file() and os.access(path, os.X_OK)

    def kernel_handler(self):
        try:
            text = (KERNEL / NAME).read_text()
        except FileNotFoundError:
            return None
        return parse_handler(text)

    def extract(self):
        self.run(["docker", "pull", "--platform=linux/arm64", IMAGE])
        container = None
        failure = None
        result = None
        try:
            container = self.run(["docker", "create", "--platform=linux/arm64", IMAGE]).decode().strip()
            if not re.fullmatch(r"[0-9a-f]{12,64}", container):
                raise PrepareError("Docker did not return a valid container ID")
            with tempfile.TemporaryDirectory(prefix="vm2api-arm64-") as directory:
                destination = Path(directory) / NAME
                self.run(["docker", "cp", f"{container}:/usr/bin/{NAME}", str(destination)])
                if destination.is_symlink() or not destination.is_file():
                    raise PrepareError("Extracted QEMU is not a regular file")
                result = destination.read_bytes()
                validate_elf(result)
        except BaseException as exc:
            failure = exc
        finally:
            if container and re.fullmatch(r"[0-9a-f]{12,64}", container):
                try:
                    self.run(["docker", "rm", container])
                except BaseException as exc:
                    if failure is not None:
                        raise PrepareError(f"{failure}; Docker container cleanup failed: {exc}") from failure
                    raise PrepareError(f"Docker container cleanup failed: {exc}") from exc
        if failure is not None:
            raise failure
        return result

    def install(self, path, data, mode):
        # Exclusive creation prevents a file appearing after the initial read
        # from being overwritten. No privileged shell or shell interpolation.
        program = """
import os, pathlib, sys
p = pathlib.Path(sys.argv[1])
for parent in reversed(p.parents):
    if parent.is_symlink(): raise RuntimeError('refusing symlink: ' + str(parent))
    parent.mkdir(exist_ok=True)
fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, int(sys.argv[2], 8))
try:
    with os.fdopen(fd, 'wb') as f:
        f.write(sys.stdin.buffer.read())
        f.flush()
        os.fchmod(f.fileno(), int(sys.argv[2], 8))
        os.fsync(f.fileno())
except BaseException:
    p.unlink()
    raise
"""
        self.run([sys.executable, "-c", program, str(path), oct(mode)], privileged=True, data=data)

    def remove_file(self, path, expected):
        program = """
import pathlib, sys
p = pathlib.Path(sys.argv[1])
if p.is_symlink(): raise RuntimeError('refusing symlink: ' + str(p))
if p.exists():
    if p.read_bytes() != sys.stdin.buffer.read(): raise RuntimeError('managed file changed: ' + str(p))
    p.unlink()
"""
        self.run([sys.executable, "-c", program, str(path)], privileged=True, data=expected)

    def remove_handler(self):
        if (KERNEL / NAME).exists():
            self.run(["tee", str(KERNEL / NAME)], privileged=True, data=b"-1")

    def restore_handler(self, handler):
        self.run(["tee", str(KERNEL / "register")], privileged=True, data=registration_bytes(handler))
        if not handler.enabled:
            self.run(["tee", str(KERNEL / NAME)], privileged=True, data=b"0")

    def register_managed(self):
        if self.init_system() == "systemd":
            self.run([self.systemd_binfmt(), str(CONF)], privileged=True)
        else:
            # OpenRC reads the same /etc/binfmt.d file at boot; register it now directly.
            handler = Handler(True, str(QEMU), 0, MAGIC, MASK, "POCF")
            self.run(["tee", str(KERNEL / "register")], privileged=True, data=registration_bytes(handler))

    def _openrc_boot_has_binfmt(self):
        listing = self.run(["rc-update", "show", "boot"]).decode(errors="replace")
        return any(line.split("|")[0].strip() == "binfmt" for line in listing.splitlines())

    def persistence_ok(self):
        # systemd-binfmt.service is static and always applies /etc/binfmt.d at boot.
        return self.init_system() != "openrc" or self._openrc_boot_has_binfmt()

    def enable_persistence(self):
        """Return True only when this call newly enabled boot-time registration."""
        if self.init_system() != "openrc" or self._openrc_boot_has_binfmt():
            return False
        self.run(["rc-update", "add", "binfmt", "boot"], privileged=True)
        return True

    def disable_persistence(self):
        self.run(["rc-update", "del", "binfmt", "boot"], privileged=True)


def check(ops):
    ops.preflight()
    conf = ops.managed_bytes(CONF)
    qemu = ops.managed_bytes(QEMU)
    if conf != CONF_BYTES or qemu is None:
        raise PrepareError("Managed ARM64 QEMU files are missing or configuration differs")
    validate_elf(qemu)
    if not ops.executable(QEMU):
        raise PrepareError("Managed QEMU is not executable")
    if not desired_handler(ops.kernel_handler()):
        raise PrepareError("Kernel qemu-x86_64 handler differs, is disabled, or lacks F")
    if not ops.persistence_ok():
        raise PrepareError("OpenRC binfmt service is not in the boot runlevel; "
                           "the handler will be lost on reboot (rc-update add binfmt boot)")


def prepare(ops):
    ops.preflight()
    existing_conf = ops.managed_bytes(CONF)
    existing_qemu = ops.managed_bytes(QEMU)
    if existing_conf is not None and existing_conf != CONF_BYTES:
        raise PrepareError(f"Refusing differing existing managed file: {CONF}")
    qemu = ops.extract()
    validate_elf(qemu)
    if existing_qemu is not None and existing_qemu != qemu:
        raise PrepareError(f"Refusing differing existing managed file: {QEMU}")
    if existing_qemu is not None and not ops.executable(QEMU):
        raise PrepareError(f"Existing managed QEMU is not executable: {QEMU}")
    old_handler = ops.kernel_handler()
    if existing_conf is not None and existing_qemu is not None and desired_handler(old_handler):
        ops.enable_persistence()
        return "Already configured"
    if old_handler is not None:
        if not ops.executable(old_handler.interpreter):
            raise PrepareError(f"Cannot safely replace old handler: interpreter unavailable: {old_handler.interpreter}")
        registration_bytes(old_handler)
    installed = []
    persisted = False
    try:
        if existing_qemu is None:
            ops.install(QEMU, qemu, 0o755)
            installed.append((QEMU, qemu))
        if existing_conf is None:
            ops.install(CONF, CONF_BYTES, 0o644)
            installed.append((CONF, CONF_BYTES))
        ops.remove_handler()
        ops.register_managed()
        persisted = ops.enable_persistence()
        check(ops)
        return "Configured ARM64 QEMU for x86_64"
    except BaseException as failure:
        rollback_errors = []
        try:
            ops.remove_handler()
            if old_handler is not None:
                ops.restore_handler(old_handler)
            if ops.kernel_handler() != old_handler:
                raise PrepareError("Kernel handler readback differs from snapshot")
        except BaseException as exc:
            rollback_errors.append(f"kernel handler: {exc}")
        if persisted:
            try:
                ops.disable_persistence()
            except BaseException as exc:
                rollback_errors.append(f"OpenRC boot runlevel: {exc}")
        for path, contents in reversed(installed):
            try:
                ops.remove_file(path, contents)
            except BaseException as exc:
                rollback_errors.append(f"remove newly installed {path}: {exc}")
        suffix = ("; ROLLBACK FAILED: " + "; ".join(rollback_errors)) if rollback_errors else "; rollback completed"
        raise PrepareError(f"Preparation failed: {failure}{suffix}") from failure


def main(argv=None, ops=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="read-only validation; do not pull Docker images")
    args = parser.parse_args(argv)
    ops = ops or Operations()
    try:
        if args.check:
            for item in ops.report():
                print(item.line())
            check(ops)
            print("ARM64 QEMU configuration is valid")
        else:
            print(prepare(ops))
        return 0
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
