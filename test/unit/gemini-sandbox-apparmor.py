"""Unit tests for Gemini host unprivileged bwrap sandbox probe, TTL caching,
Agy.poll_exit_status(), and Login.challenge() early-exit vs timeout + PTY redaction.
"""

import hashlib
import importlib.util
import io
import os
from pathlib import Path
import pty
import signal
import subprocess
import sys
import tempfile
import threading
import time
import tty
import unittest
from unittest.mock import patch


REPO = Path(__file__).resolve().parents[2]


def load_host_module():
    spec = importlib.util.spec_from_file_location(
        "gemini_host_sandbox_test", REPO / "scripts/gemini-host.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SandboxProbeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="gemini-host-sandbox-")
        self.addCleanup(self.tmp.cleanup)
        self.host_root = Path(self.tmp.name)
        self._host_root_env = patch.dict(
            os.environ, {"VM2API_GEMINI_HOST_ROOT": str(self.host_root)}
        )
        self._host_root_env.start()
        self.addCleanup(self._host_root_env.stop)
        self.mod = load_host_module()
        self.host = self.mod.Host.__new__(self.mod.Host)
        self.host.uid_base = 29000
        self.host.egress = self.host_root / "kin-egress"
        self.host.egress.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        self.host.egress.chmod(0o755)
        self.host._sandbox_probe_lock = threading.Lock()
        self.host._sandbox_probe_cache = None

    def _write_aa_state(self, *, enabled="Y", restricted="1", current="unconfined"):
        files = {
            "sys/module/apparmor/parameters/enabled": enabled,
            "proc/sys/kernel/apparmor_restrict_unprivileged_userns": restricted,
            "proc/self/attr/apparmor/current": current,
        }
        for rel, val in files.items():
            path = self.host_root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            if val is None:
                path.unlink(missing_ok=True)
            else:
                path.write_text(val + "\n", encoding="utf-8")

    def test_probe_command_is_bounded_and_unprivileged(self):
        argv = self.mod._sandbox_probe_command(29000, true_bin="/usr/bin/true")
        self.assertEqual(argv[:10], [
            "setpriv",
            "--reuid", "29000",
            "--regid", "29000",
            "--clear-groups",
            "--no-new-privs",
            "--inh-caps=-all",
            "--ambient-caps=-all",
            "--bounding-set=-all",
        ])
        self.assertTrue(argv[10].endswith("bwrap"))
        for flag in (
            "--unshare-pid",
            "--unshare-ipc",
            "--unshare-uts",
            "--unshare-net",
            "--die-with-parent",
            "--clearenv",
        ):
            self.assertIn(flag, argv)
        self.assertEqual(argv[-2:], ["--", "/usr/bin/true"])

        fallback = self.mod._sandbox_probe_command(29000, true_bin="/bin/true")
        self.assertEqual(fallback[-2:], ["--", "/bin/true"])

    def test_apparmor_evidence_classification_requires_confirmed_evidence(self):
        # 1. Restricted + unconfined -> True
        self._write_aa_state(enabled="Y", restricted="1", current="unconfined")
        self.assertTrue(
            self.mod._apparmor_sandbox_evidence(b"bwrap: setting up uid map: Permission denied", host_root=self.host_root)
        )
        # 2. Restricted + unconfined even with quiet stderr -> True
        self.assertTrue(self.mod._apparmor_sandbox_evidence(b"", host_root=self.host_root))
        # 3. Restricted + already in vm2api-gemini profile + unrelated error -> False
        self._write_aa_state(enabled="Y", restricted="1", current="vm2api-gemini (unconfined)")
        self.assertFalse(
            self.mod._apparmor_sandbox_evidence(b"execvp /usr/bin/true: No such file or directory", host_root=self.host_root)
        )
        # 4. Restricted + vm2api-gemini profile + uid_map Permission denied stderr -> True
        self.assertTrue(
            self.mod._apparmor_sandbox_evidence(b"bwrap: setting up uid map: Permission denied", host_root=self.host_root)
        )
        # 5. Unrestricted sysctl (0) even with Permission denied stderr -> False
        self._write_aa_state(enabled="Y", restricted="0", current="unconfined")
        self.assertFalse(
            self.mod._apparmor_sandbox_evidence(b"bwrap: setting up uid map: Permission denied", host_root=self.host_root)
        )
        # 6. AppArmor disabled (N) even with Permission denied stderr -> False
        self._write_aa_state(enabled="N", restricted="1", current="unconfined")
        self.assertFalse(
            self.mod._apparmor_sandbox_evidence(b"bwrap: Operation not permitted", host_root=self.host_root)
        )

    def test_execvp_permission_denied_classified_as_sandbox_unavailable_not_apparmor(self):
        """Real bwrap execvp stderr must match bind-launch patterns before AppArmor heuristics."""
        self._write_aa_state(enabled="Y", restricted="1", current="unconfined")
        real_stderr = "bwrap: execvp /opt/vm2api/share/gemini/current/craggemini: Permission denied"
        self.assertEqual(
            self.mod._classify_bwrap_launch_stderr(real_stderr, host_root=self.host_root),
            (503, "gemini_sandbox_unavailable"),
        )
        self._write_aa_state(enabled="Y", restricted="1", current="unconfined")
        self.assertEqual(
            self.mod._classify_bwrap_launch_stderr(
                "bwrap: setting up uid map: Permission denied",
                host_root=self.host_root,
            ),
            (503, "gemini_sandbox_apparmor_restricted"),
        )

    def test_probe_reports_missing_managed_bwrap_on_mediated_hosts(self):
        staged = self.host_root / "etc/apparmor.d/bwrap-userns-restrict"
        staged.parent.mkdir(parents=True, exist_ok=True)
        staged.write_text("profile bwrap /usr/bin/bwrap {}\n", encoding="utf-8")
        profiles = self.host_root / "sys/kernel/security/apparmor/profiles"
        profiles.parent.mkdir(parents=True, exist_ok=True)
        profiles.write_text("bwrap (enforce)\n", encoding="utf-8")
        self._write_aa_state(enabled="Y", restricted="1", current="vm2api-gemini (unconfined)")

        def which_side(tool, path=None):
            if tool in {"setpriv", "bwrap"}:
                return f"/usr/bin/{tool}"
            return None

        with patch.object(self.mod.shutil, "which", side_effect=which_side):
            self.assertEqual(
                self.host.probe_sandbox(force=True),
                "gemini_sandbox_apparmor_restricted",
            )

    def test_probe_pass_apparmor_restricted_generic_failure_and_timeout(self):
        self._write_aa_state(enabled="Y", restricted="1", current="unconfined")
        captured_stderr = io.StringIO()

        with (
            patch.object(self.mod.shutil, "which", return_value="/usr/bin/tool"),
            patch.object(
                self.mod,
                "_apparmor_sandbox_evidence",
                side_effect=lambda b: self.mod._read_bounded_text(
                    self.host_root / "proc/sys/kernel/apparmor_restrict_unprivileged_userns"
                ) == "1" and (b"Permission denied" in b or b"uid_map" in b),
            ),
            patch.object(self.mod.sys, "stderr", captured_stderr),
        ):
            # Pass (rc == 0)
            with patch.object(self.mod, "_run_bounded_probe", return_value=(0, b"")):
                self.assertIsNone(self.host.probe_sandbox(force=True))

            # Confirmed AppArmor restriction
            raw_secret_err = b"bwrap: setting up uid map: Permission denied RAW_STDERR_MARKER"
            with patch.object(self.mod, "_run_bounded_probe", return_value=(1, raw_secret_err)):
                self.assertEqual(
                    self.host.probe_sandbox(force=True),
                    "gemini_sandbox_apparmor_restricted",
                )
            # Raw stderr must NEVER be logged
            self.assertNotIn("RAW_STDERR_MARKER", captured_stderr.getvalue())

            # Generic non-AppArmor failure
            with patch.object(self.mod, "_run_bounded_probe", return_value=(1, b"bwrap: failed")):
                self.assertEqual(
                    self.host.probe_sandbox(force=True),
                    "gemini_sandbox_unavailable",
                )

            # Timeout (rc is None) must classify as generic unavailable, not AppArmor
            with patch.object(self.mod, "_run_bounded_probe", return_value=(None, b"")):
                self.assertEqual(
                    self.host.probe_sandbox(force=True),
                    "gemini_sandbox_unavailable",
                )

    def test_bounded_probe_caps_stderr_and_kills_timed_out_child(self):
        # Spam 16 KiB to stderr; probe must cap at <= 4 KiB.
        rc, err = self.mod._run_bounded_probe(
            [sys.executable, "-c", "import sys; sys.stderr.write('X' * 16384); sys.exit(2)"],
            timeout=3.0,
            stderr_limit=4096,
        )
        self.assertEqual(rc, 2)
        self.assertEqual(len(err), 4096)

        # Timeout returns (None, b"") and terminates the child promptly.
        started = time.monotonic()
        rc_t, err_t = self.mod._run_bounded_probe(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            timeout=0.25,
            stderr_limit=4096,
        )
        elapsed = time.monotonic() - started
        self.assertIsNone(rc_t)
        self.assertEqual(err_t, b"")
        self.assertLess(elapsed, 2.0)

    def test_probe_ttl_caching_and_authorize_preflight_refresh_on_prior_failure(self):
        calls = []
        outcomes = [None, "gemini_sandbox_apparmor_restricted", None]

        def fake_run():
            calls.append(len(calls) + 1)
            return outcomes[min(len(calls) - 1, len(outcomes) - 1)]

        fake_clock = [100.0]

        with (
            patch.object(self.host, "_run_sandbox_probe", side_effect=fake_run),
            patch.object(self.mod.time, "monotonic", side_effect=lambda: fake_clock[0]),
        ):
            # 1. Positive result cached for 300s
            self.assertIsNone(self.host.probe_sandbox())
            fake_clock[0] = 350.0  # +250s < 300s -> cache hit
            self.assertIsNone(self.host.probe_sandbox())
            self.assertEqual(len(calls), 1)

            # 2. Past 300s TTL -> re-probes and caches failure for 15s
            fake_clock[0] = 405.0
            self.assertEqual(
                self.host.probe_sandbox(), "gemini_sandbox_apparmor_restricted"
            )
            self.assertEqual(len(calls), 2)

            fake_clock[0] = 415.0  # +10s < 15s -> cache hit
            self.assertEqual(
                self.host.probe_sandbox(), "gemini_sandbox_apparmor_restricted"
            )
            self.assertEqual(len(calls), 2)

            # 3. ensure_oauth_runtime() after prior failure forces refresh immediately!
            with (
                patch.object(self.host, "ensure_payload"),
                patch.object(self.mod.shutil, "which", return_value="/usr/bin/tool"),
                patch.object(self.mod, "check_root_owned"),
                patch.object(Path, "read_text", return_value="1\n"),
            ):
                self.host.ensure_oauth_runtime()
            self.assertEqual(len(calls), 3)


class AgyAndLoginExitClassificationTests(unittest.TestCase):
    def setUp(self):
        self.mod = load_host_module()

    def test_poll_exit_status_captures_real_exit_code_and_signal_before_close_sigkill(self):
        # 1. Normal non-zero exit code (exit 7)
        proc = subprocess.Popen([sys.executable, "-c", "import sys; sys.exit(7)"])
        agy = self.mod.Agy.__new__(self.mod.Agy)
        agy.pid = proc.pid
        agy._exit_status = None
        agy.terminal = None
        agy.egress = None
        agy.egress_relay = None
        agy.network_lock = None
        agy._network_lease = None
        agy.owns_directory = False
        agy.directory = Path("/nonexistent")

        deadline = time.monotonic() + 3.0
        status = None
        while time.monotonic() < deadline and status is None:
            status = agy.poll_exit_status()
            if status is None:
                time.sleep(0.01)
        self.assertEqual(status, {"exit_code": 7})
        # close() reaps pid but preserves captured exit status (not SIGKILL)
        agy.close()
        proc.returncode = 7
        self.assertIsNone(agy.pid)
        self.assertEqual(agy.poll_exit_status(), {"exit_code": 7})

        # 2. Terminated by SIGTERM before close() sends SIGKILL
        proc2 = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        os.kill(proc2.pid, signal.SIGTERM)
        agy2 = self.mod.Agy.__new__(self.mod.Agy)
        agy2.pid = proc2.pid
        agy2._exit_status = None
        agy2.terminal = None
        agy2.egress = None
        agy2.egress_relay = None
        agy2.network_lock = None
        agy2._network_lease = None
        agy2.owns_directory = False
        agy2.directory = Path("/nonexistent")

        deadline = time.monotonic() + 3.0
        status2 = None
        while time.monotonic() < deadline and status2 is None:
            status2 = agy2.poll_exit_status()
            if status2 is None:
                time.sleep(0.01)
        self.assertEqual(status2, {"signal": int(signal.SIGTERM)})
        agy2.close()
        proc2.returncode = -int(signal.SIGTERM)
        self.assertEqual(agy2.poll_exit_status(), {"signal": int(signal.SIGTERM)})

    def _make_login_with_pty(self, *, sandbox_issue=None):
        master, slave = pty.openpty()
        tty.setraw(slave)
        os.set_blocking(master, False)
        self.addCleanup(lambda: os.close(master) if master is not None else None)
        self.addCleanup(lambda: os.close(slave) if slave is not None else None)

        fake_host = type(
            "FakeHost",
            (),
            {"probe_sandbox": staticmethod(lambda *, force=False: sandbox_issue)},
        )()
        fake_egress = type("FakeEgress", (), {"poll": staticmethod(lambda: None)})()

        login = self.mod.Login.__new__(self.mod.Login)
        login.host = fake_host
        login.attempt = "a" * 32
        login.terminal = master
        login.egress = fake_egress
        login.egress_relay = None
        login.pid = 999999
        login._exit_status = None
        login.buffer = b""
        login.state = None
        login.sent = False
        return login, slave

    def test_login_challenge_early_exit_confirms_sandbox_and_redacts_pty_buffer(self):
        login, slave = self._make_login_with_pty(
            sandbox_issue="gemini_sandbox_apparmor_restricted"
        )
        secret_pty = (
            b"https://accounts.google.com/o/oauth2/auth?state=TOP_SECRET_STATE&code_challenge=TOP_SECRET_CHALLENGE\n"
            b"bwrap: setting up uid map: Permission denied\n"
        )
        os.write(slave, secret_pty)
        login._exit_status = {"exit_code": 1}

        with self.assertRaises(self.mod.Failure) as ctx:
            login.challenge()
        err = ctx.exception
        self.assertEqual(err.code, "gemini_sandbox_apparmor_restricted")
        self.assertEqual(err.stage, "sandbox_denied")
        self.assertEqual(err.reason, "exit_code=1")
        self.assertNotIn("TOP_SECRET_STATE", repr(err.__dict__))
        self.assertNotIn("TOP_SECRET_CHALLENGE", repr(err.__dict__))
        self.assertNotIn("Permission denied", repr(err.__dict__))

    def test_login_challenge_early_exit_without_sandbox_issue_reports_cli_early_exit(self):
        login, slave = self._make_login_with_pty(sandbox_issue=None)
        os.write(slave, b"SECRET_OAUTH_TOKEN_XYZ\n")
        login._exit_status = {"exit_code": 2}

        with self.assertRaises(self.mod.Failure) as ctx:
            login.challenge()
        err = ctx.exception
        self.assertIsNone(err.code)
        self.assertEqual(err.stage, "cli_early_exit")
        self.assertEqual(err.reason, "exit_code=2")
        self.assertNotIn("SECRET_OAUTH_TOKEN_XYZ", repr(err.__dict__))

    def test_login_challenge_alive_at_8s_reports_genuine_timeout(self):
        login, _slave = self._make_login_with_pty(sandbox_issue=None)
        clock = [0.0]

        def advance_select(*_args):
            clock[0] += 4.5
            return ([], [], [])

        with (
            patch.object(login, "alive", return_value=True),
            patch.object(login, "poll_exit_status", return_value=None),
            patch.object(self.mod.select, "select", side_effect=advance_select),
            patch.object(self.mod.time, "monotonic", side_effect=lambda: clock[0]),
        ):
            with self.assertRaises(self.mod.Failure) as ctx:
                login.challenge()
        err = ctx.exception
        self.assertEqual(err.stage, "challenge_wait")
        self.assertEqual(err.reason, "timeout")

    def test_authorize_request_logs_only_safe_stage_and_reason_never_pty_secrets(self):
        with tempfile.TemporaryDirectory(prefix="gemini-auth-redact-") as tmpdir:
            root = Path(tmpdir)
            host = self.mod.Host.__new__(self.mod.Host)
            host.directory = root
            host.state_file = root / "environments.json"
            host.pending = {}
            host.terminals = {}
            host.runs = {}
            host.active_infers = {}
            host.last_inference = {}
            host.native_sessions = {}
            host.daemon_shards = {}
            host._account_shard_map = {}
            host._sandbox_probe_lock = threading.Lock()
            host._sandbox_probe_cache = None
            env_id = "gemini-" + "1" * 24
            proxy_url = "socks5h://user:SUPER_SECRET_PASS@192.0.2.25:1080"
            proxy_sha = hashlib.sha256(proxy_url.encode()).hexdigest()
            host.environments = {
                env_id: {
                    "id": env_id,
                    "name": "test",
                    "proxy_id": "px-1",
                    "slot": 0,
                    "auth_method": "oauth",
                    "auth_state": "unverified",
                }
            }

            class FakeLogin:
                def __init__(inner_self, *_args):
                    inner_self.buffer = b"PTY_SECRET_URL_STATE_999"

                def challenge(inner_self):
                    raise self.mod.Failure(
                        503,
                        "gemini_sandbox_apparmor_restricted",
                        stage="sandbox_denied",
                        reason="exit_code=1",
                    )

                def close(inner_self):
                    pass

            captured = io.StringIO()
            with (
                patch.object(host, "ensure_oauth_runtime"),
                patch.object(host, "save"),
                patch.object(self.mod, "Login", FakeLogin),
                patch.object(self.mod.sys, "stderr", captured),
            ):
                with self.assertRaises(self.mod.Failure) as ctx:
                    host._request(
                        "authorize",
                        {
                            "id": env_id,
                            "proxy_id": "px-1",
                            "proxy_url": proxy_url,
                            "proxy_sha256": proxy_sha,
                        },
                    )
            self.assertEqual(ctx.exception.code, "gemini_sandbox_apparmor_restricted")
            self.assertEqual(ctx.exception.stage, "sandbox_denied")
            stderr_out = captured.getvalue()
            self.assertIn(
                "Gemini CLI authorization did not start stage=sandbox_denied reason=exit_code=1",
                stderr_out,
            )
            self.assertNotIn("PTY_SECRET_URL_STATE_999", stderr_out)
            self.assertNotIn("SUPER_SECRET_PASS", stderr_out)

    def test_sandbox_ca_cert_mounts_cover_multi_distro_public_trust_only(self):
        mounts = self.mod._sandbox_ca_cert_mounts()
        self.assertEqual(len(mounts) % 3, 0)
        triples = [tuple(mounts[i : i + 3]) for i in range(0, len(mounts), 3)]
        bound_paths = []
        for flag, src, dst in triples:
            self.assertEqual(flag, "--ro-bind-try")
            self.assertEqual(src, dst)
            bound_paths.append(src)
        for required in (
            "/etc/ssl/certs",
            "/etc/ssl/cert.pem",
            "/etc/ssl/ca-bundle.pem",
            "/etc/ca-certificates",
            "/etc/pki/ca-trust",
            "/etc/pki/tls/certs",
            "/etc/pki/tls/cert.pem",
            "/var/lib/ca-certificates",
        ):
            self.assertIn(required, bound_paths)
        for forbidden in (
            "/etc/ssl",
            "/etc/ssl/private",
            "/etc/pki",
            "/etc/pki/tls",
            "/etc/pki/tls/private",
        ):
            self.assertNotIn(forbidden, bound_paths)

    def test_agy_and_shard_worker_bwrap_include_ca_cert_mounts(self):
        expected_ca = self.mod._sandbox_ca_cert_mounts()
        with tempfile.TemporaryDirectory(prefix="gemini-ca-mounts-") as tmpdir:
            root = Path(tmpdir)
            payload = root / "payload"
            payload.mkdir()
            for name in ("agy", "craggemini", "libagy_bridge.so"):
                (payload / name).write_bytes(b"stub")
            native_dir = root / "native"
            native_dir.mkdir()

            host = self.mod.Host.__new__(self.mod.Host)
            host.directory = root
            host.payload = payload
            host.payload_mode = "legacy"
            host.crag_host_dir = None
            host.uid_base = 29000
            host.egress_uid = 29008
            host.egress = root / "kin-egress"
            host.runtime_policy = self.mod.normalize_runtime_policy({})
            host.env_uid = lambda _env: 29000
            host.ensure_env_machine_id = lambda _env: root / "machine-id"
            (root / "machine-id").write_text("0" * 32 + "\n", encoding="utf-8")
            host.installed_agy_sha256 = lambda: "a" * 64
            host.spawn = lambda fn: fn()
            host.acquire_slot_network = lambda *_args, **_kwargs: {
                "lock": None,
                "egress": None,
                "relay": None,
            }
            host._allocate_native_dir = lambda *_args, **_kwargs: (native_dir, False)

            env_id = "gemini-" + "a" * 24
            profile_dir = root / env_id / "p1"
            (profile_dir / "home").mkdir(parents=True)
            env = {
                "id": env_id,
                "name": "acc",
                "proxy_id": "px-1",
                "slot": 0,
                "auth_method": "oauth",
                "auth_state": "authorized",
                "profile": "p1",
                "call_models": ["gemini-3-flash"],
            }

            captured_agy = {}

            def fake_launch_cli(_self, argv, _size):
                captured_agy["argv"] = list(argv)

            with (
                patch.object(self.mod.os, "chown"),
                patch.object(self.mod, "private_json"),
                patch.object(self.mod.Agy, "launch_cli", fake_launch_cli),
                patch.object(self.mod.Agy, "launch_args", return_value=["setpriv"]),
            ):
                self.mod.Agy(
                    host,
                    env,
                    "socks5h://u1:pass@192.0.2.15:1080",
                    profile=profile_dir,
                    size=(24, 80),
                )

            agy_argv = captured_agy["argv"]
            ca_start = agy_argv.index("/etc/ssl/certs") - 1
            self.assertEqual(agy_argv[ca_start : ca_start + len(expected_ca)], expected_ca)

            captured_shard = {}

            class FakeProc:
                def poll(self):
                    return None

            def fake_popen(argv, **_kwargs):
                captured_shard["argv"] = list(argv)
                return FakeProc()

            with (
                patch.object(self.mod.os, "chown"),
                patch.object(self.mod, "private_json"),
                patch.object(
                    self.mod.CragDaemonShard,
                    "_stage_account_files",
                    return_value=(f"/accounts/{env_id}/home", f"/accounts/{env_id}/work"),
                ),
                patch.object(self.mod.subprocess, "Popen", side_effect=fake_popen),
            ):
                self.mod.CragDaemonShard(
                    host,
                    "shard-0",
                    [(env, "socks5h://u1:pass@192.0.2.15:1080", ((), b""), "gemini-3-flash")],
                )

            shard_argv = captured_shard["argv"]
            shard_ca_start = shard_argv.index("/etc/ssl/certs") - 1
            self.assertEqual(
                shard_argv[shard_ca_start : shard_ca_start + len(expected_ca)],
                expected_ca,
            )


if __name__ == "__main__":
    unittest.main()
