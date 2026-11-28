"""Unit tests for Antigravity CLI (agy) eligibility patcher, auto-patch, and checks."""

import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load_module(name, relative_path):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


patcher = load_module("gemini_agy_patch_test", "scripts/gemini_agy_patch.py")
fetcher = load_module("fetch_default_gemini_test", "scripts/fetch-default-gemini.py")
maintenance_mod = load_module("gemini_maintenance_test", "scripts/gemini-maintenance.py")
host_mod = load_module("gemini_host_test", "scripts/gemini-host.py")


def build_elf64(machine: int, code: bytes, *, extra_data: bytes = b"", executable: bool = True) -> bytes:
    """Build a minimal valid little-endian ELF64 with one PT_LOAD segment."""
    ehdr_size = 64
    phdr_size = 56
    seg_off = 0x1000
    payload = code + extra_data
    e_ident = b"\x7fELF" + bytes([2, 1, 1, 0]) + b"\x00" * 8
    ehdr = struct.pack(
        "<16sHHIQQQIHHHHHH",
        e_ident,
        3,  # ET_DYN
        machine,
        1,
        0,
        ehdr_size,
        0,
        0,
        ehdr_size,
        phdr_size,
        1,
        0,
        0,
        0,
    )
    p_flags = 5 if executable else 4  # PF_R|PF_X vs PF_R
    phdr = struct.pack(
        "<IIQQQQQQ",
        1,  # PT_LOAD
        p_flags,
        seg_off,
        seg_off,
        seg_off,
        len(payload),
        len(payload),
        0x1000,
    )
    header = ehdr + phdr
    assert len(header) <= seg_off
    return header + b"\x00" * (seg_off - len(header)) + payload


def sample_x64_unpatched_seq() -> bytes:
    return (
        b"\x48\x85\xc9"
        b"\x0f\x84\x1e\x02\x00\x00"
        b"\x80\x79\x08\x00"
        b"\x0f\x85\x14\x02\x00\x00"
        b"\x48\x89\xc8\x90"
        b"\xe8\x1b\x0d\xfc\xff"
        b"\x48\x89\x84\x24\xe0\x00\x00\x00"
        b"\x48\x89\x9c\x24\xe8\x00\x00\x00"
        b"\x48\x89\x8c\x24\xf0\x00\x00\x00"
    )


def sample_arm64_unpatched_seq() -> bytes:
    # cbnz x1, +0x10 (0xb5000081) ; cbz x0, +0x20 (0xb4000100)
    prefix = struct.pack("<II", 0xB5000081, 0xB4000100)
    body = (
        b"\x02\x20\x40\x39"
        b"\x42\x01\x00\x37"
        b"\x10\x00\x00\x94"
        b"\xe0\x87\x0e\xa9\xe2\x8f\x0f\xa9\xe4\x97\x10\xa9\xe6\x9f\x11\xa9"
    )
    return prefix + body


class _FakeHttpResponse(io.BytesIO):
    def __init__(self, payload):
        super().__init__(payload)
        self.status = 200

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()


class _FakeOpener:
    def __init__(self, by_url):
        self.by_url = by_url

    def open(self, request, timeout=60):
        url = request.full_url if hasattr(request, "full_url") else str(request)
        if url not in self.by_url:
            raise RuntimeError(f"unexpected url: {url}")
        return _FakeHttpResponse(self.by_url[url])


class AgyCliPatchTests(unittest.TestCase):
    def test_x64_elf_patch_idempotent_backup_and_restore(self):
        with tempfile.TemporaryDirectory() as tmp:
            agy = Path(tmp) / "agy"
            raw = build_elf64(0x3E, b"\x90" * 16 + sample_x64_unpatched_seq() + b"\xc3")
            agy.write_bytes(raw)

            before = patcher.inspect_agy_patch(agy)
            self.assertEqual(before["state"], "unpatched")
            self.assertEqual(before["arch"], "x64")
            self.assertEqual(before["offset"], 0x1000 + 16 + 9)
            self.assertEqual(patcher.main(["status", "--require-patched", "--path", str(agy)]), 1)

            res1 = patcher.patch_agy(agy, create_backup=True)
            self.assertTrue(res1["changed"])
            self.assertEqual(res1["state"], "patched")
            self.assertEqual(res1["offset"], 0x1000 + 16 + 9)
            self.assertEqual(patcher.inspect_agy_patch(agy)["state"], "patched")
            self.assertEqual(patcher.main(["status", "--require-patched", "--path", str(agy)]), 0)
            self.assertEqual((Path(str(agy) + patcher.BAK)).read_bytes(), raw)

            # Second patch is idempotent.
            res2 = patcher.patch_agy(agy, create_backup=True)
            self.assertFalse(res2["changed"])
            self.assertEqual(res2["state"], "patched")

            # Restore brings back exact original bytes.
            restored = patcher.restore_agy(agy)
            self.assertTrue(restored["restored"])
            self.assertEqual(agy.read_bytes(), raw)
            self.assertEqual(patcher.inspect_agy_patch(agy)["state"], "unpatched")

    def test_arm64_elf_patch_requires_context_and_patches_4_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            agy = Path(tmp) / "agy-arm64"
            raw = build_elf64(0xB7, b"\x1f\x20\x03\xd5" * 4 + sample_arm64_unpatched_seq())
            agy.write_bytes(raw)
            info = patcher.inspect_agy_patch(agy)
            self.assertEqual(info["state"], "unpatched")
            self.assertEqual(info["arch"], "arm64")

            res = patcher.patch_agy(agy, create_backup=False)
            self.assertTrue(res["changed"])
            self.assertEqual(patcher.inspect_agy_patch(agy)["state"], "patched")
            self.assertFalse(Path(str(agy) + patcher.BAK).exists())

    def test_rejects_non_executable_segment_ambiguous_and_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            # Non-executable segment -> unknown
            non_exec = root / "nonexec"
            non_exec.write_bytes(build_elf64(0x3E, sample_x64_unpatched_seq(), executable=False))
            self.assertEqual(patcher.inspect_agy_patch(non_exec)["state"], "unknown")
            self.assertEqual(patcher.main(["status", "--require-patched", "--path", str(non_exec)]), 2)

            # Duplicate signature -> ambiguous -> unknown
            dup = root / "dup"
            seq = sample_x64_unpatched_seq()
            dup.write_bytes(build_elf64(0x3E, seq + b"\x90" * 8 + seq))
            self.assertEqual(patcher.inspect_agy_patch(dup)["state"], "unknown")
            with self.assertRaises(patcher.SignatureAmbiguous):
                patcher.patch_agy(dup)

            # Symlink rejected
            real = root / "real"
            real.write_bytes(build_elf64(0x3E, seq))
            link = root / "link"
            link.symlink_to(real)
            self.assertEqual(patcher.inspect_agy_patch(link)["state"], "unknown")
            with self.assertRaises(OSError):
                patcher.patch_agy(link)

    def test_post_patch_sha256_mismatch_rolls_back_4_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            agy = Path(tmp) / "agy"
            raw = build_elf64(0x3E, sample_x64_unpatched_seq())
            agy.write_bytes(raw)
            with self.assertRaises(ValueError):
                patcher.patch_agy(agy, expected_patched_sha256="0" * 64)
            # File must be rolled back identically to original bytes.
            self.assertEqual(agy.read_bytes(), raw)
            self.assertEqual(patcher.inspect_agy_patch(agy)["state"], "unpatched")

    def test_fetch_default_gemini_auto_patches_staged_and_cached_agy(self):
        tag = "payload-2026.11.27-gemini-0.5.0"
        release_url = fetcher.RELEASE_BASE + "/" + tag
        agy_raw = build_elf64(0x3E, sample_x64_unpatched_seq())
        native_bytes = {
            "craggemini": b"craggemini-bin",
            "craggemini.payload.enc": b"encrypted-payload",
            "libagy_bridge.so": b"bridge-so",
            "crag-license-public.pem": b"pubkey-pem",
            "manifest.json": b'{"family":"crag","encrypted":true,"software_version":"0.5.0"}',
        }
        pins = {
            "tag": tag,
            "version": "0.5.0",
            "release": release_url,
            "assets": {
                name: {"size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
                for name, raw in native_bytes.items()
            },
        }
        assets_by_url = {f"{release_url}/{name}": raw for name, raw in native_bytes.items()}

        def _patch_synth(path):
            patcher.patch_agy(path, create_backup=False)

        orig_agy_sha = fetcher.AGY_BINARY_SHA256
        fetcher.AGY_BINARY_SHA256 = hashlib.sha256(agy_raw).hexdigest()
        old_umask = os.umask(0o077)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                parent = root / "private"
                parent.mkdir(mode=0o700)
                os.chmod(parent, 0o700)
                reuse_agy = root / "existing-agy"
                reuse_agy.write_bytes(agy_raw)
                os.chmod(reuse_agy, 0o600)
                dest = parent / "pinned-dest"

                seen_states = []

                def _verify(stage, ver):
                    seen_states.append((ver, patcher.inspect_agy_patch(stage / "agy")["state"]))

                fetcher.prepare(
                    dest,
                    pins,
                    reuse_agy=reuse_agy,
                    opener=_FakeOpener(assets_by_url),
                    verify=_verify,
                    patch_agy=_patch_synth,
                )
                self.assertEqual(seen_states, [("0.5.0", "patched")])
                self.assertEqual(patcher.inspect_agy_patch(dest / "agy")["state"], "patched")

                # Re-running against an already-cached dir whose agy was reverted to unpatched
                # must auto-patch it before verify().
                (dest / "agy").write_bytes(agy_raw)
                os.chmod(dest / "agy", 0o600)
                self.assertEqual(patcher.inspect_agy_patch(dest / "agy")["state"], "unpatched")
                fetcher.prepare(
                    dest,
                    pins,
                    reuse_agy=reuse_agy,
                    opener=_FakeOpener(assets_by_url),
                    verify=_verify,
                    patch_agy=_patch_synth,
                )
                self.assertEqual(seen_states[-1], ("0.5.0", "patched"))
                self.assertEqual(patcher.inspect_agy_patch(dest / "agy")["state"], "patched")
        finally:
            os.umask(old_umask)
            fetcher.AGY_BINARY_SHA256 = orig_agy_sha

    def test_maintenance_assess_and_ensure_staged_agy_patch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            current = root / "current"
            current.mkdir()
            agy = current / "agy"
            agy.write_bytes(build_elf64(0x3E, sample_x64_unpatched_seq()))

            daemon = maintenance_mod.Maintenance.__new__(maintenance_mod.Maintenance)
            daemon.current = current
            daemon.guard = threading.Lock()
            daemon.agy_patch_status = None
            daemon.agy_patch_cache = None

            with patch.object(maintenance_mod, "require_root", side_effect=lambda p, _k: p.lstat()):
                self.assertEqual(
                    daemon.assess_agy_patch(),
                    ("fail", "gemini_maintenance_agy_patch_missing"),
                )
                changed = daemon.ensure_staged_agy_patched(current)
                self.assertTrue(changed)
                self.assertEqual(daemon.assess_agy_patch(), ("pass", None))
                self.assertFalse(daemon.ensure_staged_agy_patched(current))

                # Missing agy -> warning
                agy.unlink()
                self.assertEqual(
                    daemon.assess_agy_patch(),
                    ("warning", "gemini_payload_not_installed"),
                )

    def test_host_installed_agy_sha256_and_patch_status(self):
        with tempfile.TemporaryDirectory() as tmp:
            payload = Path(tmp)
            agy = payload / "agy"
            agy.write_bytes(build_elf64(0x3E, sample_x64_unpatched_seq()))

            host = host_mod.Host.__new__(host_mod.Host)
            host.payload = payload
            self.assertEqual(host.agy_patch_status()["state"], "unpatched")

            patcher.patch_agy(agy, create_backup=False)
            self.assertEqual(host.agy_patch_status()["state"], "patched")

            with patch.object(host_mod, "agy_file_sha256", return_value=patcher.AGY_PATCHED_SHA256):
                host._agy_inspect_cache = None
                self.assertEqual(host.installed_agy_sha256(), patcher.AGY_PATCHED_SHA256)

            with patch.object(host_mod, "agy_file_sha256", return_value=patcher.AGY_UNPATCHED_SHA256):
                host._agy_inspect_cache = None
                self.assertEqual(host.installed_agy_sha256(), patcher.AGY_UNPATCHED_SHA256)


if __name__ == "__main__":
    unittest.main()
