#!/usr/bin/env python3
"""Antigravity CLI (agy) eligibility gate patcher and verifier (stdlib only).

Patches the 4-byte `hasValidAuth` check inside `handleAuthResult` in the
executable segment of `agy` / `agy.exe` (x64 & arm64) using unique byte-signature
matching, pre/post SHA-256 verification, and fail-closed rollback on error.

CLI usage:
    python3 scripts/gemini_agy_patch.py status  --path <agy> [--require-patched] [--json]
    python3 scripts/gemini_agy_patch.py patch   --path <agy> [--no-backup] [--json]
    python3 scripts/gemini_agy_patch.py restore --path <agy>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mmap
import os
from pathlib import Path
import re
import shutil
import stat
import struct
import sys

BAK = ".agybak"
CHUNK_SIZE = 1 << 20

# Official Linux amd64 Antigravity CLI 1.5.9 digests (unpatched & eligibility-patched).
AGY_UNPATCHED_SHA256 = (
    "39816d49d5ab92229952987225c23ea3fed7580699dcb4a444e0388e0ac1ce43"
)
AGY_PATCHED_SHA256 = (
    "bca88dab4d2b921d95e1228326631837ff468efef505088d9ab5dbb057f26157"
)
AGY_ALLOWED_SHA256S = frozenset({AGY_UNPATCHED_SHA256, AGY_PATCHED_SHA256})


class SignatureNotFound(LookupError):
    pass


class SignatureAmbiguous(LookupError):
    pass


def _open_regular(path: Path | str, flags: int):
    open_flags = flags | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(os.fspath(path), open_flags)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError(f"not a regular file: {path}")
        return fd, info
    except BaseException:
        os.close(fd)
        raise


def file_sha256(path: Path | str) -> str:
    fd, _ = _open_regular(path, os.O_RDONLY)
    digest = hashlib.sha256()
    with os.fdopen(fd, "rb") as stream:
        while chunk := stream.read(CHUNK_SIZE):
            digest.update(chunk)
    return digest.hexdigest()


# --------------------------------------------------------------------------
# Executable segment discovery (PE / ELF): only search executable code ranges
# --------------------------------------------------------------------------
def _ranges(raw, file_size):
    clean = [(max(0, s), min(file_size, e)) for s, e in raw]
    out = []
    for s, e in sorted(r for r in clean if r[0] < r[1]):
        if out and s <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], e))
        else:
            out.append((s, e))
    return tuple(out)


def _arch(machine):
    return {
        0x8664: "x64",
        0x3E: "x64",
        0xAA64: "arm64",
        0xB7: "arm64",
        0x01000007: "x64",
        0x0100000C: "arm64",
    }.get(machine)


def _pe_ranges(f, size):
    f.seek(0x3C)
    raw_pe = f.read(4)
    if len(raw_pe) != 4:
        raise ValueError("truncated PE header")
    pe = struct.unpack("<I", raw_pe)[0]
    f.seek(pe)
    if f.read(4) != b"PE\0\0":
        raise ValueError("invalid PE signature")
    coff = f.read(20)
    if len(coff) != 20:
        raise ValueError("truncated COFF header")
    arch = _arch(struct.unpack_from("<H", coff, 0)[0])
    count = struct.unpack_from("<H", coff, 2)[0]
    opt_size = struct.unpack_from("<H", coff, 16)[0]
    f.seek(pe + 24 + opt_size)
    table = f.read(count * 40)
    if len(table) != count * 40:
        raise ValueError("truncated PE section table")
    spans = []
    for i in range(count):
        sec = table[i * 40 : (i + 1) * 40]
        raw_size, raw_off = struct.unpack_from("<II", sec, 16)
        flags = struct.unpack_from("<I", sec, 36)[0]
        if flags & 0x20000000:  # IMAGE_SCN_MEM_EXECUTE
            spans.append((raw_off, raw_off + raw_size))
    return _ranges(spans, size), arch


def _elf_ranges(f, size):
    f.seek(0)
    ident = f.read(16)
    if len(ident) != 16 or ident[:4] != b"\x7fELF":
        raise ValueError("not ELF")
    endian = "<" if ident[5] == 1 else ">"
    is64 = ident[4] == 2
    f.seek(18)
    raw_machine = f.read(2)
    if len(raw_machine) != 2:
        raise ValueError("truncated ELF header")
    machine = struct.unpack(endian + "H", raw_machine)[0]
    f.seek(0)
    if is64:
        head = f.read(64)
        if len(head) != 64:
            raise ValueError("truncated ELF64 header")
        phoff = struct.unpack_from(endian + "Q", head, 32)[0]
        entsize, num = struct.unpack_from(endian + "HH", head, 54)
        off_fmt, size_fmt = "Q", "Q"
        flags_off, off_off, size_off = 4, 8, 32
    else:
        head = f.read(52)
        if len(head) != 52:
            raise ValueError("truncated ELF32 header")
        phoff = struct.unpack_from(endian + "I", head, 28)[0]
        entsize, num = struct.unpack_from(endian + "HH", head, 42)
        off_fmt, size_fmt = "I", "I"
        flags_off, off_off, size_off = 24, 4, 16
    if entsize < (40 if is64 else 28):
        raise ValueError("invalid ELF program header entry size")
    spans = []
    for i in range(num):
        f.seek(phoff + i * entsize)
        ent = f.read(entsize)
        if len(ent) != entsize:
            raise ValueError("truncated ELF program header")
        p_type = struct.unpack_from(endian + "I", ent, 0)[0]
        flags = struct.unpack_from(endian + "I", ent, flags_off)[0]
        off = struct.unpack_from(endian + off_fmt, ent, off_off)[0]
        sz = struct.unpack_from(endian + size_fmt, ent, size_off)[0]
        if p_type == 1 and flags & 1:  # PT_LOAD | PF_X
            spans.append((off, off + sz))
    return _ranges(spans, size), _arch(machine)


def executable_info(path: Path | str):
    fd, info = _open_regular(path, os.O_RDONLY)
    size = info.st_size
    with os.fdopen(fd, "rb") as f:
        magic = f.read(4)
        if magic[:2] == b"MZ":
            ranges, arch = _pe_ranges(f, size)
        elif magic[:4] == b"\x7fELF":
            ranges, arch = _elf_ranges(f, size)
        else:
            raise ValueError("not a supported PE/ELF executable")
    if not ranges:
        raise ValueError("no executable code ranges found")
    return ranges, arch


# --------------------------------------------------------------------------
# Signatures for Antigravity CLI handleAuthResult eligibility gate
# --------------------------------------------------------------------------
# x64:
#   48 85 c9              test rcx,rcx
#   0f 84 xx xx xx xx     je   <eligible>
#   80 79 08 00           cmp  byte ptr [rcx+8],0     <- 4-byte patch target
#   0f 85 xx xx xx xx     jne  <eligible>
#   48 89 c8 90           mov  rax,rcx ; nop
#   e8 ..                 call IneligibilityFromResult
#   48 89 84 24 e0..      spill rax/rbx/rcx -> [rsp+0xe0/+0xe8/+0xf0]
# Replacement: 48 85 c9 90 (test rcx,rcx ; nop). Since rcx != 0, ZF=0 and jne jumps.
X64_SIG = (
    rb"\x48\x85\xc9\x0f\x84....\x80\x79\x08\x00\x0f\x85....\x48\x89\xc8\x90"
    rb"\xe8....\x48\x89\x84\x24\xe0\x00\x00\x00"
    rb"\x48\x89\x9c\x24\xe8\x00\x00\x00\x48\x89\x8c\x24\xf0\x00\x00\x00"
)
X64_PATCHED = (
    rb"\x48\x85\xc9\x0f\x84....\x48\x85\xc9\x90\x0f\x85....\x48\x89\xc8\x90"
    rb"\xe8....\x48\x89\x84\x24\xe0\x00\x00\x00"
    rb"\x48\x89\x9c\x24\xe8\x00\x00\x00\x48\x89\x8c\x24\xf0\x00\x00\x00"
)
X64_FIX = b"\x48\x85\xc9\x90"
X64_OFFSET = 9

# arm64:
#   02 20 40 39           ldrb w2,[x0,#8]             <- 4-byte patch target
#   .. .. .. 37           tbnz w2,#0,<eligible>
#   .. .. .. 94-97        bl   IneligibilityFromResult
#   e0 87 0e a9 ...       stp  x0-x7, [sp,#0xe8..]
# Replacement: 22 00 80 52 (mov w2,#1).
ARM64_SIG = (
    rb"\x02\x20\x40\x39[\x02\x22\x42\x62\x82\xa2\xc2\xe2].[\x00-\x07]\x37"
    rb"...[\x94-\x97]\xe0\x87\x0e\xa9\xe2\x8f\x0f\xa9\xe4\x97\x10\xa9\xe6\x9f\x11\xa9"
)
ARM64_PATCHED = (
    rb"\x22\x00\x80\x52[\x02\x22\x42\x62\x82\xa2\xc2\xe2].[\x00-\x07]\x37"
    rb"...[\x94-\x97]\xe0\x87\x0e\xa9\xe2\x8f\x0f\xa9\xe4\x97\x10\xa9\xe6\x9f\x11\xa9"
)
ARM64_FIX = b"\x22\x00\x80\x52"


def _arm64_context(data, match, start, _end):
    """Require preceding cbnz x1 / cbz x0 guard instructions before the signature."""
    off = match.start()
    if off - 8 < start:
        return False
    cbnz_x1, cbz_x0 = struct.unpack_from("<II", data, off - 8)
    return (cbnz_x1 & 0xFF00001F) == 0xB5000001 and (cbz_x0 & 0xFF00001F) == 0xB4000000


class Gate:
    def __init__(self, sig, patched, fix, offset=0, name="", arch=None, accept=None):
        self.sig = re.compile(sig, re.S)
        self.patched = re.compile(patched, re.S)
        self.fix = fix
        self.offset = offset
        self.name = name
        self.arch = arch
        self.accept = accept

    def _unique(self, pattern, data, ranges, label):
        found = None
        for start, end in ranges:
            pos = start
            while pos < end:
                match = pattern.search(data, pos, end)
                if not match:
                    break
                if self.accept and not self.accept(data, match, start, end):
                    pos = max(match.end(), match.start() + 1)
                    continue
                if found is not None:
                    raise SignatureAmbiguous(f"{label} signature is ambiguous")
                found = match
                pos = max(match.end(), match.start() + 1)
        return found

    def resolve(self, data, ranges):
        orig = self._unique(self.sig, data, ranges, "unpatched")
        patched = self._unique(self.patched, data, ranges, "patched")
        if orig and patched:
            raise SignatureAmbiguous("both patched and unpatched signatures matched")
        if patched:
            return "patched", patched.start() + self.offset
        if orig:
            return "unpatched", orig.start() + self.offset
        raise SignatureNotFound("eligibility gate signature not found")


GATES = (
    Gate(X64_SIG, X64_PATCHED, X64_FIX, X64_OFFSET, "eligibility off (x64)", "x64"),
    Gate(
        ARM64_SIG,
        ARM64_PATCHED,
        ARM64_FIX,
        0,
        "eligibility off (arm64)",
        "arm64",
        accept=_arm64_context,
    ),
)


def _resolve_fd(fd, ranges, arch):
    if os.fstat(fd).st_size == 0:
        raise SignatureNotFound("empty file")
    with mmap.mmap(fd, 0, access=mmap.ACCESS_READ) as data:
        hits = []
        for gate in GATES:
            if gate.arch and gate.arch != arch:
                continue
            try:
                hits.append((gate.resolve(data, ranges), gate))
            except SignatureNotFound:
                pass
    if len(hits) > 1:
        raise SignatureAmbiguous("multiple architecture gates matched")
    if not hits:
        raise SignatureNotFound(f"no matching gate signature (arch={arch})")
    (state, off), gate = hits[0]
    return state, off, gate, arch


def resolve(path: Path | str):
    ranges, arch = executable_info(path)
    fd, _ = _open_regular(path, os.O_RDONLY)
    try:
        return _resolve_fd(fd, ranges, arch)
    finally:
        os.close(fd)


def inspect_agy_patch(path: Path | str) -> dict:
    """Read-only inspection returning state in {'patched','unpatched','unknown','missing'}."""
    target = Path(path)
    if not os.path.lexists(target):
        return {
            "state": "missing",
            "arch": None,
            "offset": None,
            "gate": None,
            "error": "file not found",
        }
    try:
        state, off, gate, arch = resolve(target)
        return {
            "state": state,
            "arch": arch,
            "offset": off,
            "gate": gate.name,
            "error": None,
        }
    except (LookupError, OSError, ValueError) as exc:
        return {
            "state": "unknown",
            "arch": None,
            "offset": None,
            "gate": None,
            "error": str(exc),
        }


def _same_file(a: Path | str, b: Path | str) -> bool:
    fda, _ = _open_regular(a, os.O_RDONLY)
    try:
        fdb, _ = _open_regular(b, os.O_RDONLY)
    except BaseException:
        os.close(fda)
        raise
    with os.fdopen(fda, "rb") as fa, os.fdopen(fdb, "rb") as fb:
        while True:
            chunk = fa.read(CHUNK_SIZE)
            if chunk != fb.read(CHUNK_SIZE):
                return False
            if not chunk:
                return True


def patch_agy(
    path: Path | str,
    *,
    create_backup: bool = False,
    expected_unpatched_sha256: str | None = None,
    expected_patched_sha256: str | None = None,
) -> dict:
    """Idempotently patch `path` with pre/post signature + digest verification and rollback."""
    target = Path(path)
    state, off, gate, arch = resolve(target)
    if state == "patched":
        digest = file_sha256(target) if expected_patched_sha256 else None
        if expected_patched_sha256 and digest != expected_patched_sha256:
            raise ValueError("patched agy SHA-256 mismatch")
        return {
            "changed": False,
            "state": "patched",
            "arch": arch,
            "offset": off,
            "gate": gate.name,
            "sha256": digest,
        }

    if expected_unpatched_sha256:
        actual_before = file_sha256(target)
        if actual_before != expected_unpatched_sha256:
            raise ValueError("unpatched agy SHA-256 mismatch")

    bak = Path(str(target) + BAK)
    if create_backup:
        if not os.path.lexists(bak):
            shutil.copy2(target, bak)
            if not _same_file(target, bak):
                bak.unlink(missing_ok=True)
                raise OSError("backup verification failed")
        else:
            bak_state = resolve(bak)[0]
            if bak_state != "unpatched":
                raise ValueError("existing backup is not an unpatched original")

    ranges, expected_arch = executable_info(target)
    fd, _ = _open_regular(target, os.O_RDWR)
    orig_bytes = None
    wrote = False
    try:
        now_state, now_off, now_gate, now_arch = _resolve_fd(fd, ranges, expected_arch)
        if (now_state, now_off, now_arch) != ("unpatched", off, arch):
            raise OSError("target changed before patch write")
        os.lseek(fd, off, os.SEEK_SET)
        orig_bytes = os.read(fd, len(now_gate.fix))
        if len(orig_bytes) != len(now_gate.fix) or orig_bytes == now_gate.fix:
            raise OSError("unexpected bytes at patch offset")
        os.lseek(fd, off, os.SEEK_SET)
        written = os.write(fd, now_gate.fix)
        if written != len(now_gate.fix):
            raise OSError("short write while patching agy")
        os.fsync(fd)
        wrote = True
        after_state, after_off, _, _ = _resolve_fd(fd, ranges, expected_arch)
        if (after_state, after_off) != ("patched", off):
            raise OSError("post-write signature verification failed")
        digest = None
        if expected_patched_sha256:
            os.lseek(fd, 0, os.SEEK_SET)
            h = hashlib.sha256()
            while True:
                chunk = os.read(fd, CHUNK_SIZE)
                if not chunk:
                    break
                h.update(chunk)
            digest = h.hexdigest()
            if digest != expected_patched_sha256:
                raise ValueError("post-patch SHA-256 verification failed")
        return {
            "changed": True,
            "state": "patched",
            "arch": arch,
            "offset": off,
            "gate": now_gate.name,
            "sha256": digest,
        }
    except BaseException:
        if wrote and orig_bytes is not None:
            try:
                os.lseek(fd, off, os.SEEK_SET)
                os.write(fd, orig_bytes)
                os.fsync(fd)
            except OSError:
                pass
        raise
    finally:
        os.close(fd)


def restore_agy(path: Path | str) -> dict:
    target = Path(path)
    bak = Path(str(target) + BAK)
    if not os.path.lexists(bak):
        raise FileNotFoundError(f"backup not found: {bak.name}")
    if resolve(bak)[0] != "unpatched":
        raise ValueError("backup is not an unpatched original")
    # Verify target is writable (not locked / symlink) before restoring.
    fd, _ = _open_regular(target, os.O_RDWR)
    os.close(fd)
    shutil.copy2(bak, target)
    state, off, gate, arch = resolve(target)
    if state != "unpatched":
        raise OSError("post-restore verification failed")
    return {
        "restored": True,
        "state": state,
        "arch": arch,
        "offset": off,
        "gate": gate.name,
    }


def _default_agy_path() -> Path:
    return (
        Path(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")))
        / "agy"
        / "bin"
        / ("agy.exe" if os.name == "nt" else "agy")
    )


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Antigravity CLI (agy) eligibility patcher")
    parser.add_argument("action", choices=("status", "patch", "restore"))
    parser.add_argument("--path", type=Path, default=None, help="Full path to agy / agy.exe")
    parser.add_argument(
        "--require-patched",
        action="store_true",
        help="For status: exit 0 only when patched (1 if unpatched, 2 if unknown/missing)",
    )
    parser.add_argument(
        "--no-backup",
        action="store_true",
        help="For patch: do not write sibling .agybak backup file",
    )
    parser.add_argument("--json", action="store_true", help="Emit JSON result")
    args = parser.parse_args(argv)

    target = args.path if args.path is not None else _default_agy_path()
    if args.action == "status":
        info = inspect_agy_patch(target)
        if args.json:
            print(json.dumps(info, separators=(",", ":")))
        else:
            if info["state"] in ("patched", "unpatched"):
                print(
                    f"  [ok] {info['state']}  {info['gate']}  arch={info['arch']}  file=0x{info['offset']:x}"
                )
            else:
                print(f"  [??] {info['state']}: {info['error']}")
        if info["state"] == "patched":
            return 0
        if info["state"] == "unpatched":
            return 1 if args.require_patched else 0
        return 2

    if not os.path.lexists(target):
        if args.json:
            print(json.dumps({"error": f"not found: {target}"}, separators=(",", ":")))
        else:
            print(f"  [!!] target not found: {target}")
        return 2

    try:
        if args.action == "patch":
            result = patch_agy(target, create_backup=not args.no_backup)
            if args.json:
                print(json.dumps(result, separators=(",", ":")))
            else:
                verb = "patched" if result["changed"] else "already patched"
                print(
                    f"  [ok] {verb} {result['gate']} @ 0x{result['offset']:x}"
                )
            return 0
        result = restore_agy(target)
        if args.json:
            print(json.dumps(result, separators=(",", ":")))
        else:
            print(f"  [ok] restored {target.name}")
        return 0
    except (LookupError, OSError, ValueError) as exc:
        if args.json:
            print(json.dumps({"error": str(exc)}, separators=(",", ":")))
        else:
            print(f"  [!!] {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
