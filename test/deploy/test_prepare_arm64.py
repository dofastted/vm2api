import contextlib
import importlib.util
import io
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[2] / "deploy" / "prepare-arm64.py"
SPEC = importlib.util.spec_from_file_location("prepare_arm64", SCRIPT)
arm64 = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = arm64
SPEC.loader.exec_module(arm64)


def elf(machine=183, extra_segment=None):
    """Small ELF fixtures with actual program headers, not mocked validation."""
    count = 1 + (extra_segment is not None)
    data = bytearray(64 + 56 * count + 32)
    data[:16] = b"\x7fELF\x02\x01\x01" + b"\x00" * 9
    struct.pack_into("<HHIQQQIHHHHHH", data, 16,
                     2, machine, 1, 0, 64, 0, 0, 64, 56, count, 0, 0, 0)
    struct.pack_into("<IIQQQQQQ", data, 64, 1, 5, 0, 0, 0, len(data), len(data), 4096)
    if extra_segment is not None:
        kind, contents = extra_segment
        offset = 64 + 56 * count
        data[offset:offset + len(contents)] = contents
        struct.pack_into("<IIQQQQQQ", data, 120, kind, 4, offset, 0, 0,
                         len(contents), len(contents), 8)
    return bytes(data)


def old_handler(enabled=True):
    return arm64.Handler(enabled, "/usr/bin/qemu-x86_64-static", 4,
                         b"\x7fELF\x00\x3a", b"\xff" * 6, "F")


def managed_handler():
    return arm64.Handler(True, str(arm64.QEMU), 0, arm64.MAGIC, arm64.MASK, "POCF")


class FakeOperations:
    def __init__(self, handler=None, installed=False):
        self.handler = handler
        self.files = ({arm64.QEMU: elf(), arm64.CONF: arm64.CONF_BYTES} if installed else {})
        self.calls = []
        self.fail_registration = False
        self.fail_restore = False
        self.fail_install = None
        self.bad_interpreter = False
        self.openrc = False
        self.boot_binfmt = False

    def preflight(self):
        self.calls.append("preflight")

    def report(self):
        return [arm64.Check("arch", True, "linux/aarch64")]

    def persistence_ok(self):
        return not self.openrc or self.boot_binfmt

    def enable_persistence(self):
        if not self.openrc or self.boot_binfmt:
            return False
        self.calls.append("enable_persistence")
        self.boot_binfmt = True
        return True

    def disable_persistence(self):
        self.calls.append("disable_persistence")
        self.boot_binfmt = False

    def managed_bytes(self, path):
        self.calls.append(("read", path))
        value = self.files.get(path)
        if value == "symlink":
            raise arm64.PrepareError("Refusing symlink in managed path")
        return value

    def executable(self, path):
        return not self.bad_interpreter

    def kernel_handler(self):
        return self.handler

    def extract(self):
        self.calls.append("extract")
        return elf()

    def install(self, path, data, mode):
        self.calls.append(("install", path, mode))
        if path == self.fail_install:
            raise arm64.PrepareError("install failed")
        if path in self.files:
            raise arm64.PrepareError("would overwrite file")
        self.files[path] = data

    def remove_file(self, path, expected):
        self.calls.append(("remove_file", path))
        if self.files.get(path) != expected:
            raise arm64.PrepareError("file changed")
        del self.files[path]

    def remove_handler(self):
        self.calls.append("remove_handler")
        self.handler = None

    def restore_handler(self, handler):
        self.calls.append(("restore_handler", handler))
        if self.fail_restore:
            raise arm64.PrepareError("kernel restore denied")
        self.handler = handler

    def register_managed(self):
        self.calls.append("register_managed")
        self.handler = managed_handler()
        if self.fail_registration:
            raise arm64.PrepareError("registration failed after write")


class DescriptorTests(unittest.TestCase):
    def test_parse_enabled_and_disabled_and_reconstruct_binary_magic(self):
        for enabled in (True, False):
            expected = old_handler(enabled)
            text = (f"{'enabled' if enabled else 'disabled'}\ninterpreter {expected.interpreter}\n"
                    f"flags: {expected.flags}\noffset 4\nmagic {expected.magic.hex()}\nmask {expected.mask.hex()}\n")
            self.assertEqual(arm64.parse_handler(text), expected)
            descriptor = expected.registration()
            self.assertNotIn(b"\x00", descriptor)
            self.assertIn(b"\\x00\\x3a", descriptor)
            delimiter = descriptor[:1]
            self.assertEqual(descriptor.split(delimiter)[1:4], [b"qemu-x86_64", b"M", b"4"])

    def test_reject_incomplete_and_unrepresentable_old_descriptor(self):
        for text in ("enabled\ninterpreter /old\n", "enabled\ninterpreter /old\nflags: F\noffset 0\nmagic ff\nmask ffff\n"):
            with self.assertRaisesRegex(arm64.PrepareError, "Cannot reconstruct"):
                arm64.parse_handler(text)

    def test_conf_matches_shipped_file_and_production_mask(self):
        self.assertEqual(SCRIPT.with_name("qemu-x86_64.conf").read_bytes(), arm64.CONF_BYTES)
        self.assertEqual(arm64.MASK[5:7], b"\xfe\xfe")

    def test_static_native_elf_and_reject_foreign_or_dynamic(self):
        arm64.validate_elf(elf())
        for data in (elf(machine=62), elf(extra_segment=(3, b"/lib/ld.so\x00")),
                     elf(extra_segment=(2, struct.pack("<qQqQ", 1, 1, 0, 0))), elf()[:100]):
            with self.assertRaises(arm64.PrepareError):
                arm64.validate_elf(data)


class TransactionTests(unittest.TestCase):
    def test_first_install_and_idempotence(self):
        ops = FakeOperations()
        self.assertEqual(arm64.prepare(ops), "Configured ARM64 QEMU for x86_64")
        self.assertEqual(ops.handler, managed_handler())
        ops.calls.clear()
        self.assertEqual(arm64.prepare(ops), "Already configured")
        self.assertNotIn("register_managed", ops.calls)
        self.assertNotIn("remove_handler", ops.calls)
        self.assertFalse(any(isinstance(call, tuple) and call[0] == "install" for call in ops.calls))

    def test_exact_enabled_and_disabled_kernel_snapshots_restored(self):
        for enabled in (True, False):
            with self.subTest(enabled=enabled):
                snapshot = old_handler(enabled)
                ops = FakeOperations(snapshot)
                ops.fail_registration = True
                with self.assertRaisesRegex(arm64.PrepareError, "rollback completed"):
                    arm64.prepare(ops)
                self.assertEqual(ops.handler, snapshot)
                self.assertEqual(ops.files, {})

    def test_first_install_failure_restores_absent_handler_and_files(self):
        ops = FakeOperations()
        ops.fail_registration = True
        with self.assertRaisesRegex(arm64.PrepareError, "rollback completed"):
            arm64.prepare(ops)
        self.assertIsNone(ops.handler)
        self.assertEqual(ops.files, {})

    def test_interruption_during_switch_also_restores_snapshot(self):
        snapshot = old_handler(False)
        ops = FakeOperations(snapshot)
        with mock.patch.object(ops, "register_managed", side_effect=KeyboardInterrupt):
            with self.assertRaisesRegex(arm64.PrepareError, "rollback completed"):
                arm64.prepare(ops)
        self.assertEqual(ops.handler, snapshot)
        self.assertEqual(ops.files, {})

    def test_partial_file_install_failure_removes_only_new_file(self):
        ops = FakeOperations(old_handler(False))
        ops.fail_install = arm64.CONF
        with self.assertRaisesRegex(arm64.PrepareError, "install failed"):
            arm64.prepare(ops)
        self.assertEqual(ops.files, {})
        self.assertEqual(ops.handler, old_handler(False))

    def test_existing_identical_files_survive_failed_registration(self):
        ops = FakeOperations(old_handler(), installed=True)
        previous = dict(ops.files)
        ops.fail_registration = True
        with self.assertRaises(arm64.PrepareError):
            arm64.prepare(ops)
        self.assertEqual(ops.files, previous)
        self.assertFalse(any(isinstance(call, tuple) and call[0] == "remove_file" for call in ops.calls))

    def test_differing_or_symlink_managed_files_are_never_overwritten(self):
        for path in (arm64.QEMU, arm64.CONF):
            for data in (b"other content", "symlink"):
                with self.subTest(path=path, data=data):
                    ops = FakeOperations(old_handler())
                    ops.files[path] = data
                    with self.assertRaisesRegex(arm64.PrepareError, "Refusing"):
                        arm64.prepare(ops)
                    self.assertEqual(ops.files[path], data)
                    self.assertNotIn("remove_handler", ops.calls)
                    self.assertFalse(any(isinstance(call, tuple) and call[0] == "install" for call in ops.calls))

    def test_missing_old_interpreter_rejected_before_mutation(self):
        ops = FakeOperations(old_handler())
        ops.bad_interpreter = True
        with self.assertRaisesRegex(arm64.PrepareError, "interpreter unavailable"):
            arm64.prepare(ops)
        self.assertEqual(ops.files, {})
        self.assertNotIn("remove_handler", ops.calls)

    def test_rollback_failure_is_reported_with_exact_failed_step(self):
        ops = FakeOperations(old_handler(False))
        ops.fail_registration = ops.fail_restore = True
        with self.assertRaisesRegex(arm64.PrepareError, "ROLLBACK FAILED: kernel handler: kernel restore denied"):
            arm64.prepare(ops)
        self.assertEqual(ops.files, {})

    def test_check_has_no_extract_or_mutations(self):
        ops = FakeOperations(managed_handler(), installed=True)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(arm64.main(["--check"], ops), 0)
        self.assertTrue(all(call == "preflight" or (isinstance(call, tuple) and call[0] == "read") for call in ops.calls))

    def test_check_rejects_disabled_wrong_interpreter_or_missing_f(self):
        valid = managed_handler()
        for handler in (arm64.Handler(False, valid.interpreter, 0, valid.magic, valid.mask, valid.flags),
                        arm64.Handler(True, "/other/qemu", 0, valid.magic, valid.mask, valid.flags),
                        arm64.Handler(True, valid.interpreter, 0, valid.magic, valid.mask, "POC")):
            ops = FakeOperations(handler, installed=True)
            with self.assertRaisesRegex(arm64.PrepareError, "Kernel"):
                arm64.check(ops)
            self.assertNotIn("extract", ops.calls)


class HostOperationTests(unittest.TestCase):
    def test_legacy_manager_is_not_queried_for_check_or_idempotent_prepare(self):
        ops = arm64.Operations()
        # A legacy qemu-x86_64 record may coexist with the managed kernel
        # handler. update-binfmts --display reports kernel existence, so it
        # cannot be used to require an independent "disabled" legacy state.
        with mock.patch.object(ops, "preflight"), \
             mock.patch.object(ops, "managed_bytes", side_effect=lambda path: arm64.CONF_BYTES if path == arm64.CONF else elf()), \
             mock.patch.object(ops, "executable", return_value=True), \
             mock.patch.object(ops, "kernel_handler", return_value=managed_handler()), \
             mock.patch.object(ops, "extract", return_value=elf()), \
             mock.patch.object(ops, "run") as run:
            arm64.check(ops)
            self.assertEqual(arm64.prepare(ops), "Already configured")
            run.assert_not_called()

    def test_missing_systemd_binfmt_is_rejected_in_preflight(self):
        ops = arm64.Operations()
        with mock.patch.object(arm64.platform, "system", return_value="Linux"), \
             mock.patch.object(arm64.platform, "machine", return_value="aarch64"), \
             mock.patch.object(arm64.Path, "exists", return_value=True), \
             mock.patch.object(arm64.Path, "read_text", return_value="enabled\n"), \
             mock.patch.object(arm64.Path, "is_file", return_value=False), \
             mock.patch.object(ops, "run") as run:
            with self.assertRaisesRegex(arm64.PrepareError, "systemd-binfmt executable"):
                arm64.prepare(ops)
            run.assert_not_called()

    def test_docker_extraction_uses_native_pin_and_always_cleans_container(self):
        ops = arm64.Operations()
        calls = []

        def run(args, **kwargs):
            calls.append(args)
            if args[1] == "create":
                return b"a" * 64 + b"\n"
            if args[1] == "cp":
                raise arm64.PrepareError("copy failed")
            return b""

        with mock.patch.object(ops, "run", side_effect=run):
            with self.assertRaisesRegex(arm64.PrepareError, "copy failed"):
                ops.extract()
        self.assertEqual(calls[0], ["docker", "pull", "--platform=linux/arm64", arm64.IMAGE])
        self.assertEqual(calls[1], ["docker", "create", "--platform=linux/arm64", arm64.IMAGE])
        self.assertEqual(calls[-1], ["docker", "rm", "a" * 64])

    def test_sudo_is_noninteractive_and_root_needs_no_sudo(self):
        ops = arm64.Operations()
        result = mock.Mock(returncode=0, stdout=b"", stderr=b"")
        for uid in (0, 1000):
            with mock.patch.object(arm64.os, "geteuid", return_value=uid, create=True), mock.patch.object(arm64.subprocess, "run", return_value=result) as run:
                args = ["/usr/lib/systemd/systemd-binfmt", str(arm64.CONF)]
                ops.run(args, privileged=True)
                expected = (["sudo", "-n", "--"] if uid else []) + args
                self.assertEqual(run.call_args.args[0], expected)

    def test_nonregular_managed_path_rejected_using_real_filesystem(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "managed"
            target.mkdir()
            with self.assertRaisesRegex(arm64.PrepareError, "regular file"):
                arm64.Operations().managed_bytes(target)


class HostFacts:
    """Facts a healthy Ubuntu/systemd 4K ARM64 host reports."""

    def __init__(self, **overrides):
        self.values = dict(machine="linux/aarch64", page=4096, container=None, status="enabled",
                           init="systemd", sources=[], shadows=[])
        self.values.update(overrides)

    def machine(self): return self.values["machine"]
    def page_size(self): return self.values["page"]
    def container(self): return self.values["container"]
    def binfmt_status(self): return self.values["status"]
    def init_system(self): return self.values["init"]
    def conf_sources(self): return self.values["sources"]
    def shadowing_handlers(self): return self.values["shadows"]


def failed(**overrides):
    return {c.name: c for c in arm64.host_checks(HostFacts(**overrides)) if not c.ok}


class HostCheckTests(unittest.TestCase):
    def test_healthy_4k_systemd_host_passes(self):
        self.assertEqual(failed(), {})

    def test_large_pages_rejected_with_kernel_hint(self):
        for page in (16384, 65536):
            result = failed(page=page)
            self.assertEqual(list(result), ["page-size"])
            self.assertIn("4K-page kernel", result["page-size"].hint)

    def test_container_binfmt_and_init_failures_are_all_reported_together(self):
        result = failed(container="container (/.dockerenv)", status=None, init=None)
        self.assertEqual(set(result), {"container", "binfmt_misc", "init"})
        self.assertIn("modprobe binfmt_misc", result["binfmt_misc"].hint)
        self.assertIn("echo 1", failed(status="disabled")["binfmt_misc"].hint)

    def test_wrong_arch_and_shadowing_handler(self):
        self.assertIn("arch", failed(machine="linux/x86_64"))
        result = failed(shadows=["qemu-x86_64-static (/usr/bin/qemu-x86_64-static)"])
        self.assertEqual(list(result), ["other-x86-handlers"])

    def test_openrc_and_distro_conf_are_accepted(self):
        self.assertEqual(failed(init="openrc"), {})
        checks = {c.name: c for c in arm64.host_checks(HostFacts(
            sources=[arm64.CONF, Path("/usr/lib/binfmt.d/qemu-x86_64.conf")]))}
        self.assertTrue(checks["binfmt.d"].ok)
        self.assertIn("overrides distro /usr/lib/binfmt.d/qemu-x86_64.conf", checks["binfmt.d"].detail)

    def test_preflight_raises_before_any_host_mutation(self):
        ops = arm64.Operations()
        facts = HostFacts(page=65536, init=None)
        with mock.patch.multiple(ops, **{name: getattr(facts, name) for name in (
                "machine", "page_size", "container", "binfmt_status", "init_system",
                "conf_sources", "shadowing_handlers")}), \
             mock.patch.object(ops, "run") as run:
            with self.assertRaises(arm64.PrepareError) as raised:
                arm64.prepare(ops)
            run.assert_not_called()
        self.assertIn("page-size", str(raised.exception))
        self.assertIn("init", str(raised.exception))


class ForeignHandlerTests(unittest.TestCase):
    def test_debian_static_handler_matches_x86_64(self):
        text = ("enabled\ninterpreter /usr/libexec/qemu-binfmt/x86_64-binfmt-P\nflags: PF\noffset 0\n"
                "magic " + arm64.MAGIC.hex() + "\nmask " + arm64.MASK.hex() + "\n")
        handler = arm64.foreign_handler(text)
        self.assertTrue(arm64.matches_x86_64(handler))

    def test_aarch64_disabled_and_extension_handlers_ignored(self):
        aarch64 = "enabled\ninterpreter /usr/bin/qemu-aarch64\nflags: F\noffset 0\nmagic 7f454c460201010000000000000000000200b700\nmask fffffffffffffffcfffffffffffffffffeffffff\n"
        self.assertFalse(arm64.matches_x86_64(arm64.foreign_handler(aarch64)))
        self.assertIsNone(arm64.foreign_handler("disabled\nmagic 7f45\n"))
        self.assertIsNone(arm64.foreign_handler("enabled\ninterpreter /usr/bin/wine\nextension .exe\n"))


class OpenRCTests(unittest.TestCase):
    def test_first_install_enables_boot_runlevel(self):
        ops = FakeOperations()
        ops.openrc = True
        self.assertEqual(arm64.prepare(ops), "Configured ARM64 QEMU for x86_64")
        self.assertIn("enable_persistence", ops.calls)
        self.assertTrue(ops.boot_binfmt)

    def test_failed_check_rolls_back_runlevel_and_files(self):
        ops = FakeOperations()
        ops.openrc = True
        original = arm64.check
        with mock.patch.object(arm64, "check", side_effect=arm64.PrepareError("readback differs")):
            with self.assertRaisesRegex(arm64.PrepareError, "rollback completed"):
                arm64.prepare(ops)
        self.assertIs(arm64.check, original)
        self.assertIn("disable_persistence", ops.calls)
        self.assertFalse(ops.boot_binfmt)
        self.assertEqual(ops.files, {})

    def test_preexisting_runlevel_is_not_removed_on_failure(self):
        ops = FakeOperations()
        ops.openrc = ops.boot_binfmt = True
        ops.fail_registration = True
        with self.assertRaises(arm64.PrepareError):
            arm64.prepare(ops)
        self.assertNotIn("disable_persistence", ops.calls)
        self.assertTrue(ops.boot_binfmt)

    def test_check_rejects_missing_boot_runlevel(self):
        ops = FakeOperations(handler=managed_handler(), installed=True)
        ops.openrc = True
        with self.assertRaisesRegex(arm64.PrepareError, "rc-update add binfmt boot"):
            arm64.check(ops)
        self.assertEqual(arm64.prepare(ops), "Already configured")
        self.assertTrue(ops.boot_binfmt)
        arm64.check(ops)

    def test_openrc_registration_writes_register_directly(self):
        ops = arm64.Operations()
        with mock.patch.object(ops, "init_system", return_value="openrc"), \
             mock.patch.object(ops, "run") as run:
            ops.register_managed()
        args, kwargs = run.call_args
        self.assertEqual(args[0], ["tee", str(arm64.KERNEL / "register")])
        self.assertIn(str(arm64.QEMU).encode(), kwargs["data"])
        self.assertTrue(kwargs["data"].endswith(b"POCF"))

    def test_runlevel_parsing(self):
        ops = arm64.Operations()
        listing = b"             binfmt | boot\n              hwclock | boot\n"
        with mock.patch.object(ops, "init_system", return_value="openrc"), \
             mock.patch.object(ops, "run", return_value=listing) as run:
            self.assertTrue(ops.persistence_ok())
            self.assertFalse(ops.enable_persistence())
        run.assert_called_with(["rc-update", "show", "boot"])


if __name__ == "__main__":
    unittest.main()
