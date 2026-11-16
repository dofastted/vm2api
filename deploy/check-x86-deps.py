#!/usr/bin/env python3
"""Verify every x86_64 ELF under the given paths can load from the x86 library dir.

The ARM64 control image ships only the x86 libraries its amd64 payloads need.
This check runs at build time and in the image smoke test: each dynamic x86_64
executable's PT_INTERP must exist, and the DT_NEEDED closure must resolve inside
--lib-dir. A payload that gains a dependency therefore fails the build instead
of crashing a slot under QEMU. Only program headers are parsed, so stripped
binaries without section headers work. Standard library only.

Libraries loaded only at run time (dlopen, or a onefile bundle's unpacked child)
are invisible here; list them in the Dockerfile and cover them in the image smoke.
"""

import argparse
import mmap
import os
from pathlib import Path
import struct
import sys

EM_X86_64 = 62
PT_LOAD, PT_DYNAMIC, PT_INTERP = 1, 2, 3
DT_NULL, DT_NEEDED, DT_STRTAB = 0, 1, 5


class ElfError(ValueError):
    pass


def x86_64_deps(data):
    """Return (interp, needed) for an ELF64 LE x86_64 image, or None for other files."""
    if len(data) < 64 or data[:6] != b"\x7fELF\x02\x01":
        return None
    if struct.unpack_from("<H", data, 18)[0] != EM_X86_64:
        return None
    phoff = struct.unpack_from("<Q", data, 32)[0]
    phentsize, phnum = struct.unpack_from("<HH", data, 54)
    if phentsize != 56 or phoff + phnum * phentsize > len(data):
        raise ElfError("invalid program-header table")
    loads, dynamic, interp = [], None, None
    for i in range(phnum):
        kind, _, offset, vaddr, _, filesz, _, _ = struct.unpack_from("<IIQQQQQQ", data, phoff + i * 56)
        if offset + filesz > len(data):
            raise ElfError("segment outside file")
        if kind == PT_LOAD:
            loads.append((vaddr, offset, filesz))
        elif kind == PT_DYNAMIC:
            dynamic = (offset, filesz)
        elif kind == PT_INTERP:
            interp = bytes(data[offset:offset + filesz]).split(b"\0", 1)[0].decode()
    if dynamic is None:
        return interp, []

    def file_offset(vaddr):
        for start, offset, size in loads:
            if start <= vaddr < start + size:
                return offset + vaddr - start
        raise ElfError("dynamic address outside loaded segments")

    entries, strtab = [], None
    offset, size = dynamic
    for pos in range(offset, offset + size - 15, 16):
        tag, value = struct.unpack_from("<qQ", data, pos)
        if tag == DT_NULL:
            break
        if tag == DT_NEEDED:
            entries.append(value)
        elif tag == DT_STRTAB:
            strtab = file_offset(value)
    if entries and strtab is None:
        raise ElfError("DT_NEEDED without DT_STRTAB")
    needed = []
    for index in entries:
        end = data.find(b"\0", strtab + index)
        if end < 0:
            raise ElfError("unterminated library name")
        needed.append(bytes(data[strtab + index:end]).decode())
    return interp, needed


def read_deps(path):
    with open(path, "rb") as handle:
        if os.fstat(handle.fileno()).st_size < 64:
            return None
        with mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as data:
            return x86_64_deps(data)


def candidates(paths):
    for path in paths:
        if path.is_file():
            yield path
        elif path.is_dir():
            for file in sorted(path.rglob("*")):
                if file.is_file() and not file.is_symlink():
                    yield file
        else:
            raise FileNotFoundError(path)


def check(paths, lib_dir, root=Path("/")):
    """Return (checked_count, problems)."""
    problems, resolved, count = [], {}, 0

    def library(name, owner):
        if name in resolved:
            return
        resolved[name] = True
        path = lib_dir / name
        if not path.is_file():
            problems.append(f"{owner}: missing x86 library {name} in {lib_dir}")
            return
        deps = read_deps(path)
        if deps is None:
            problems.append(f"{path}: not an x86_64 ELF library")
            return
        for dep in deps[1]:
            library(dep, path)

    for file in candidates(paths):
        try:
            deps = read_deps(file)
        except ElfError as exc:
            problems.append(f"{file}: {exc}")
            continue
        if deps is None:
            continue
        count += 1
        interp, needed = deps
        if interp and not (root / interp.lstrip("/")).exists():
            problems.append(f"{file}: missing interpreter {interp}")
        for name in needed:
            library(name, file)
    return count, problems


def main(argv=None):
    parser = argparse.ArgumentParser(description="Verify the x86_64 ELF dependency closure.")
    parser.add_argument("paths", nargs="+", type=Path)
    parser.add_argument("--lib-dir", type=Path, default=Path("/usr/lib/x86_64-linux-gnu"))
    parser.add_argument("--root", type=Path, default=Path("/"), help="filesystem root for PT_INTERP lookup")
    args = parser.parse_args(argv)
    try:
        count, problems = check(args.paths, args.lib_dir, args.root)
    except FileNotFoundError as exc:
        print(f"path not found: {exc}", file=sys.stderr)
        return 2
    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        return 1
    if not count:
        print("no x86_64 ELF found", file=sys.stderr)
        return 1
    print(f"x86_64 dependency closure ok: {count} executables")
    return 0


if __name__ == "__main__":
    sys.exit(main())
