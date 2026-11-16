import contextlib
import importlib.util
import io
from pathlib import Path
import struct
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / "deploy" / "check-x86-deps.py"
SPEC = importlib.util.spec_from_file_location("check_x86_deps", SCRIPT)
deps = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = deps
SPEC.loader.exec_module(deps)


def make_elf(interp=None, needed=(), machine=62, with_section_headers=False):
    """Minimal ELF64 LE image: PT_LOAD over the file, optional PT_INTERP / PT_DYNAMIC."""
    phnum = 1 + (interp is not None) + bool(needed)
    body_start = 64 + phnum * 56
    body = bytearray()
    interp_off = None
    if interp is not None:
        interp_off = body_start + len(body)
        body += interp.encode() + b"\0"
    strtab_off = body_start + len(body)
    strtab = bytearray(b"\0")
    name_offsets = []
    for name in needed:
        name_offsets.append(len(strtab))
        strtab += name.encode() + b"\0"
    body += strtab
    while (body_start + len(body)) % 8:
        body += b"\0"
    dyn_off = body_start + len(body)
    if needed:
        for offset in name_offsets:
            body += struct.pack("<qQ", 1, offset)
        body += struct.pack("<qQ", 5, strtab_off)  # vaddr == offset in this image
        body += struct.pack("<qQ", 0, 0)
    size = body_start + len(body)
    header = bytearray(b"\x7fELF\x02\x01\x01" + b"\0" * 9)
    header += struct.pack("<HHIQQQIHHHHHH", 2, machine, 1, 0, 64,
                          size if with_section_headers else 0, 0, 64, 56, phnum, 64, 0, 0)
    phdrs = struct.pack("<IIQQQQQQ", 1, 5, 0, 0, 0, size, size, 0x1000)
    if interp is not None:
        n = len(interp) + 1
        phdrs += struct.pack("<IIQQQQQQ", 3, 4, interp_off, interp_off, interp_off, n, n, 1)
    if needed:
        n = len(needed) * 16 + 32
        phdrs += struct.pack("<IIQQQQQQ", 2, 6, dyn_off, dyn_off, dyn_off, n, n, 8)
    return bytes(header + phdrs + body)


class ParseTests(unittest.TestCase):
    def test_reads_interpreter_and_needed_from_program_headers(self):
        data = make_elf("/lib64/ld-linux-x86-64.so.2", ["libc.so.6", "libm.so.6"])
        self.assertEqual(deps.x86_64_deps(data), ("/lib64/ld-linux-x86-64.so.2", ["libc.so.6", "libm.so.6"]))

    def test_static_binary_has_no_needed(self):
        self.assertEqual(deps.x86_64_deps(make_elf()), (None, []))

    def test_non_x86_and_non_elf_are_ignored(self):
        self.assertIsNone(deps.x86_64_deps(make_elf(machine=183)))
        self.assertIsNone(deps.x86_64_deps(b"#!/bin/sh\n" + b"\0" * 80))

    def test_truncated_program_headers_rejected(self):
        data = make_elf("/lib64/ld-linux-x86-64.so.2", ["libc.so.6"])
        with self.assertRaises(deps.ElfError):
            deps.x86_64_deps(data[:100])


class ClosureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.lib = self.root / "usr/lib/x86_64-linux-gnu"
        self.lib.mkdir(parents=True)
        (self.root / "lib64").mkdir()
        (self.root / "lib64/ld-linux-x86-64.so.2").write_bytes(make_elf())
        self.bins = self.root / "payload"
        self.bins.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def lib_file(self, name, needed=()):
        (self.lib / name).write_bytes(make_elf(needed=list(needed)))

    def run_check(self):
        return deps.check([self.bins], self.lib, self.root)

    def test_complete_closure_passes_including_transitive_libraries(self):
        self.lib_file("libc.so.6")
        self.lib_file("libstdc++.so.6", ["libc.so.6", "libm.so.6"])
        self.lib_file("libm.so.6", ["libc.so.6"])
        (self.bins / "kernel").write_bytes(make_elf("/lib64/ld-linux-x86-64.so.2", ["libstdc++.so.6"]))
        (self.bins / "static").write_bytes(make_elf())
        (self.bins / "notes.json").write_text("{}")
        self.assertEqual(self.run_check(), (2, []))

    def test_missing_direct_and_transitive_library_reported(self):
        self.lib_file("libstdc++.so.6", ["libgcc_s.so.1"])
        (self.bins / "auth").write_bytes(make_elf("/lib64/ld-linux-x86-64.so.2", ["libstdc++.so.6", "librt.so.1"]))
        count, problems = self.run_check()
        self.assertEqual(count, 1)
        self.assertTrue(any("librt.so.1" in p for p in problems), problems)
        self.assertTrue(any("libgcc_s.so.1" in p for p in problems), problems)

    def test_missing_interpreter_reported(self):
        self.lib_file("libc.so.6")
        (self.bins / "k").write_bytes(make_elf("/lib/ld-musl-x86_64.so.1", ["libc.so.6"]))
        _, problems = self.run_check()
        self.assertEqual(len(problems), 1)
        self.assertIn("missing interpreter", problems[0])

    def test_arm64_binaries_are_skipped(self):
        (self.bins / "native").write_bytes(make_elf("/lib/ld-linux-aarch64.so.1", ["libc.so.6"], machine=183))
        self.assertEqual(self.run_check(), (0, []))

    def test_main_exit_codes(self):
        self.lib_file("libc.so.6")
        (self.bins / "k").write_bytes(make_elf("/lib64/ld-linux-x86-64.so.2", ["libc.so.6"]))
        args = ["--lib-dir", str(self.lib), "--root", str(self.root)]
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(deps.main([str(self.bins), *args]), 0)
        (self.bins / "k2").write_bytes(make_elf("/lib64/ld-linux-x86-64.so.2", ["libgone.so"]))
        with contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(deps.main([str(self.bins), *args]), 1)
        self.assertIn("libgone.so", err.getvalue())
        empty = self.root / "empty"
        empty.mkdir()
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(deps.main([str(empty), *args]), 1)
            self.assertEqual(deps.main([str(self.root / "absent"), *args]), 2)


if __name__ == "__main__":
    unittest.main()
