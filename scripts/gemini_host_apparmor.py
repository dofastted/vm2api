"""Shared Gemini host AppArmor userns helpers and managed bwrap entry resolution."""

from __future__ import annotations

import errno
import os
import shutil
import stat
import tempfile
from pathlib import Path

APPARMOR_MARKER = "# Managed by vm2api Gemini host userns preparation."
APPARMOR_PROFILE_NAME = "vm2api-gemini"
GEMINI_RUNTIME_DIR = Path("/usr/local/lib/vm2api-gemini")
GEMINI_BWRAP_ENTRY = GEMINI_RUNTIME_DIR / "exec" / "bwrap"
BWRAP_USERNS_RESTRICT_STAGED = Path("/etc/apparmor.d/bwrap-userns-restrict")
BWRAP_ENV_OVERRIDE = "VM2API_GEMINI_BWRAP"
HOST_ROOT_OVERRIDE = "VM2API_GEMINI_HOST_ROOT"


def active_host_root() -> Path:
    override = os.environ.get(HOST_ROOT_OVERRIDE, "").strip()
    if override:
        return Path(override)
    return Path("/")


def host_path(host_root: Path, relative: str | Path) -> Path:
    rel = Path(relative)
    parts = rel.parts
    if rel.is_absolute():
        parts = parts[1:] if parts and parts[0] == "/" else parts
    return host_root.joinpath(*parts)


def _read_flag(path: Path, accepted: frozenset[str]) -> bool:
    try:
        value = path.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return False
    return value in accepted


def apparmor_userns_restricted(*, host_root: Path = Path("/")) -> bool:
    enabled = host_path(host_root, "/sys/module/apparmor/parameters/enabled")
    restricted = host_path(
        host_root, "/proc/sys/kernel/apparmor_restrict_unprivileged_userns"
    )
    return _read_flag(enabled, frozenset({"Y", "1", "yes"})) and _read_flag(
        restricted, frozenset({"1"})
    )


def bwrap_userns_mediated(*, host_root: Path = Path("/")) -> bool:
    staged = host_path(host_root, BWRAP_USERNS_RESTRICT_STAGED)
    if not staged.is_file():
        return False
    profiles = host_path(host_root, "/sys/kernel/security/apparmor/profiles")
    if profiles.is_file():
        try:
            raw = profiles.read_bytes()[: 2 * 1024 * 1024]
        except OSError:
            return True
        if "bwrap" not in raw.decode("utf-8", errors="replace"):
            return False
    return True


def managed_bwrap_required(*, host_root: Path = Path("/")) -> bool:
    return apparmor_userns_restricted(host_root=host_root) and bwrap_userns_mediated(
        host_root=host_root
    )


def resolve_bwrap_argv0(*, host_root: Path = Path("/")) -> str:
    override = os.environ.get(BWRAP_ENV_OVERRIDE, "").strip()
    if override:
        candidate = Path(override)
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    entry = host_path(host_root, GEMINI_BWRAP_ENTRY)
    if entry.is_file() and os.access(entry, os.X_OK):
        return str(entry)
    found = shutil.which("bwrap")
    if found:
        return found
    return "bwrap"


def apparmor_profile_bytes(*, bwrap_entry: Path | None = None) -> bytes:
    entry_rule = ""
    if bwrap_entry is not None:
        entry_rule = f"  {bwrap_entry} ix,\n"
    text = (
        f"{APPARMOR_MARKER}\n"
        "abi <abi/4.0>,\n"
        f"profile {APPARMOR_PROFILE_NAME} flags=(unconfined) {{\n"
        "  userns,\n"
        f"{entry_rule}"
        "}\n"
    )
    return text.encode("ascii")


def managed_bwrap_entry_configured(*, host_root: Path = Path("/")) -> bool:
    if not managed_bwrap_required(host_root=host_root):
        return True
    entry = host_path(host_root, GEMINI_BWRAP_ENTRY)
    if not entry.is_file():
        return False
    profile = host_path(host_root, f"/etc/apparmor.d/{APPARMOR_PROFILE_NAME}")
    if not profile.is_file():
        return False
    try:
        body = profile.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    return f"  {entry} ix," in body or f"{entry} ix," in body


def _validate_managed_bwrap_entry(entry: Path) -> None:
    info = entry.stat()
    if not stat.S_ISREG(info.st_mode):
        raise OSError("managed bwrap entry is not a regular file")
    if info.st_mode & 0o022:
        raise OSError("managed bwrap entry is group/world writable")


def install_managed_bwrap(*, host_root: Path = Path("/")) -> Path:
    entry = host_path(host_root, GEMINI_BWRAP_ENTRY)
    source = shutil.which("bwrap")
    if not source:
        raise FileNotFoundError("bwrap")
    entry.parent.mkdir(parents=True, mode=0o755, exist_ok=True)
    desired = Path(source).read_bytes()
    if entry.is_file():
        try:
            if entry.read_bytes() == desired:
                os.chmod(entry, stat.S_IMODE(0o755))
                _validate_managed_bwrap_entry(entry)
                return entry
        except OSError:
            pass
    fd, tmp_name = tempfile.mkstemp(
        dir=entry.parent, prefix=".bwrap-install-", suffix=".tmp"
    )
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(desired)
        os.chmod(tmp_path, stat.S_IMODE(0o755))
        os.replace(tmp_path, entry)
        with open(entry, "rb") as installed:
            os.fsync(installed.fileno())
        directory = os.open(entry.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise
    _validate_managed_bwrap_entry(entry)
    return entry