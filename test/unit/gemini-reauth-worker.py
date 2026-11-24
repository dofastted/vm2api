"""Regression tests for the background re-auth worker (#1674)."""

import io
import json
import tempfile
import threading
import time
from contextlib import contextmanager
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
spec = spec_from_file_location("gemini_host_reauth_test", ROOT / "scripts/gemini-host.py")
impl = module_from_spec(spec)
spec.loader.exec_module(impl)

ENV_ID = "gemini-" + "d" * 24
PROFILE = "e" * 32
PROXY = "socks5h://u1:secret-pass@192.0.2.19:1080"
EXPIRED_RAW = json.dumps(
    {
        "token": {
            "access_token": "ya29.expired",
            "refresh_token": "1//refresh-token",
            "expiry": "2020-01-01T00:00:00Z",
        }
    }
).encode()


class FixtureHost(impl.Host):
    def payload_config(self):
        return self.payload, True, self.public_key, None, "fixture-reauth-1"

    def payload_identity(self, source, public_key, digest):
        return digest

    def verify_payload(self, source, public_key, install=False):
        return "fixture-reauth-1"

    def recover_network(self, env_dir, slot):
        pass

    def oauth_runtime_issue(self):
        return None


@contextmanager
def make_host():
    with tempfile.TemporaryDirectory(prefix="gemini-reauth-") as temporary:
        directory = Path(temporary)
        args = SimpleNamespace(
            state=directory,
            uid_base=2000,
            payload=directory / "payload",
            payload_source=None,
            public_key=None,
            default_public_key=None,
            default_release_verifier=None,
            release_verifier=None,
            egress=Path("/bin/true"),
        )
        records = {
            ENV_ID: {
                "id": ENV_ID,
                "name": "ReauthEnv",
                "proxy_id": "px-1",
                "auth_state": "authorized",
                "auth_method": "oauth",
                "profile": PROFILE,
                "max_concurrency": 1,
                "call_models": ["gemini-3-flash"],
                "updated_at": "2030-01-01T00:00:00+00:00",
                "slot": 0,
            }
        }
        (directory / "environments.json").write_text(json.dumps(records), encoding="utf-8")
        (directory / ENV_ID / PROFILE).mkdir(parents=True)
        with (
            patch.object(impl, "check_root_owned"),
            patch.object(impl, "read_root_file", side_effect=lambda path, limit: path.read_bytes()),
            patch.object(
                impl,
                "profile_secrets",
                side_effect=lambda _p, _u, *, include_raw=False: (
                    (("ya29.expired",), EXPIRED_RAW) if include_raw else ("ya29.expired",)
                ),
            ),
        ):
            host = FixtureHost(args)
            host._remember_runtime_proxy(host.environments[ENV_ID], PROXY)
            yield host


def test_lock_not_held_during_refresh_account():
    """The worker does not hold host.lock across refresh_account, so slow I/O cannot stall other callers."""
    with make_host() as host:
        entered = threading.Event()
        release_refresh = threading.Event()
        calls = []
        spawned = []
        real_thread = impl.threading.Thread

        def capture_thread(*args, **kwargs):
            t = real_thread(*args, **kwargs)
            spawned.append(t)
            return t

        def slow_refresh(cur, proxy_url, *, auto_pull_models=True):
            calls.append((cur, proxy_url, auto_pull_models))
            entered.set()
            assert release_refresh.wait(timeout=5.0), "timed out waiting for main thread lock probe"
            return host.view(cur)

        with (
            patch.object(impl.threading, "Thread", side_effect=capture_thread),
            patch.object(host, "refresh_account", side_effect=slow_refresh),
        ):
            with host.lock:
                assert host._schedule_reauth_check_locked(ENV_ID) is True
                assert ENV_ID in host._reauth_checking
                assert host._reauth_check_next_at[ENV_ID] > time.monotonic()

            assert len(spawned) == 1
            assert entered.wait(timeout=3.0), "re-auth worker did not enter refresh_account"

            acquired = host.lock.acquire(blocking=False)
            assert acquired is True, "re-auth worker held host.lock across refresh_account"
            try:
                assert ENV_ID in host._reauth_checking
                assert host._schedule_reauth_check_locked(ENV_ID) is False
            finally:
                host.lock.release()

            release_refresh.set()
            spawned[0].join(timeout=3.0)
            assert not spawned[0].is_alive()

        assert calls == [(host.environments[ENV_ID], PROXY, False)]
        assert ENV_ID not in host._reauth_checking
        assert host._reauth_check_next_at[ENV_ID] > time.monotonic()


def test_refresh_account_probes_without_lock_and_applies_under_lock():
    """Network I/O runs lock-free; every state change and the save happen under host.lock."""
    with make_host() as host:
        env = host.environments[ENV_ID]
        probing = threading.Event()
        release_probe = threading.Event()
        saved_under_lock = []
        real_save = host.save

        def slow_read_account(uid, proxy_url, mode, **kwargs):
            assert not host.lock._is_owned(), "read_account ran under host.lock"
            probing.set()
            assert release_probe.wait(timeout=5.0)
            return {"state": "ok", "checked_at": "2030-01-02T00:00:00+00:00"}

        def checked_save():
            saved_under_lock.append(host.lock._is_owned())
            real_save()

        worker = threading.Thread(target=host.refresh_account, args=(env, PROXY), kwargs={"auto_pull_models": False})
        with (
            patch.object(impl, "read_account", side_effect=slow_read_account),
            patch.object(host, "_profile_token_state", return_value=(False, False)),
            patch.object(host, "save", side_effect=checked_save),
        ):
            worker.start()
            assert probing.wait(timeout=3.0)
            acquired = host.lock.acquire(blocking=False)
            assert acquired is True, "host.lock was held during the network probe"
            host.lock.release()
            release_probe.set()
            worker.join(timeout=3.0)
            assert not worker.is_alive()

        assert saved_under_lock == [True]
        assert env["account"]["checked_at"] == "2030-01-02T00:00:00+00:00"
        assert env["auth_state"] == "authorized"


def test_refresh_account_skips_apply_when_environment_was_removed_during_probe():
    """An environment deleted while its probe ran is not written back or saved."""
    with make_host() as host:
        env = host.environments[ENV_ID]

        def read_then_delete(uid, proxy_url, mode, **kwargs):
            with host.lock:
                del host.environments[ENV_ID]
            return {"state": "reauth_required", "checked_at": "2030-01-02T00:00:00+00:00"}

        with (
            patch.object(impl, "read_account", side_effect=read_then_delete),
            patch.object(host, "_profile_token_state", return_value=(False, False)),
            patch.object(host, "save") as save,
        ):
            host.refresh_account(env, PROXY, auto_pull_models=False)

        save.assert_not_called()
        assert env["auth_state"] == "authorized"
        assert ENV_ID not in host.environments


def test_exception_logged_checking_cleaned_and_base_exceptions_propagate():
    """Exceptions in refresh_account are logged with env id + error details; BaseExceptions are not swallowed."""
    with make_host() as host:
        real_thread = impl.threading.Thread

        for raised, expected_fragments in (
            (
                RuntimeError(f"token endpoint unreachable via {PROXY}"),
                (ENV_ID, "RuntimeError", "token endpoint unreachable"),
            ),
            (
                impl.Failure(503, "gemini_egress_unavailable"),
                (ENV_ID, "Failure", "503", "gemini_egress_unavailable"),
            ),
        ):
            host._reauth_check_next_at = {}
            spawned = []
            stderr_buf = io.StringIO()
            with (
                patch.object(
                    impl.threading,
                    "Thread",
                    side_effect=lambda *a, **kw: (spawned.append(real_thread(*a, **kw)) or spawned[-1]),
                ),
                patch.object(host, "refresh_account", side_effect=raised),
                patch.object(impl.sys, "stderr", new=stderr_buf),
            ):
                with host.lock:
                    assert host._schedule_reauth_check_locked(ENV_ID) is True
                spawned[0].join(timeout=3.0)
                assert not spawned[0].is_alive()

            logged = stderr_buf.getvalue()
            for fragment in expected_fragments:
                assert fragment in logged, (fragment, logged)
            assert "secret-pass" not in logged and PROXY not in logged, logged
            assert ENV_ID not in host._reauth_checking
            # Cooldown stays intact so a broken credential does not immediately retry.
            assert host._reauth_check_next_at[ENV_ID] > time.monotonic()

        # KeyboardInterrupt and SystemExit must NOT be swallowed, while finally still cleans _reauth_checking.
        for fatal in (KeyboardInterrupt("interrupted"), SystemExit(2)):
            host._reauth_check_next_at = {}
            stderr_buf = io.StringIO()
            with (
                patch.object(impl.threading, "Thread") as thread_cls,
                patch.object(host, "refresh_account", side_effect=fatal),
                patch.object(impl.sys, "stderr", new=stderr_buf),
            ):
                with host.lock:
                    assert host._schedule_reauth_check_locked(ENV_ID) is True
                assert ENV_ID in host._reauth_checking
                worker_fn = thread_cls.call_args.kwargs["target"]
                try:
                    worker_fn()
                except type(fatal) as caught:
                    assert caught is fatal
                else:
                    raise AssertionError(f"{type(fatal).__name__} was swallowed by _worker")

            assert ENV_ID not in host._reauth_checking
            assert stderr_buf.getvalue() == ""


def test_non_authorized_or_missing_environment_skips_refresh_and_cleans_checking():
    """If the environment transitions away from authorized or is deleted before _worker runs, skip refresh cleanly."""
    with make_host() as host:
        real_thread = impl.threading.Thread

        for next_state in ("reauth_required", "disabled", "authorizing", "unverified", None):
            host._reauth_check_next_at = {}
            if ENV_ID not in host.environments:
                host.environments[ENV_ID] = {
                    "id": ENV_ID,
                    "name": "ReauthEnv",
                    "proxy_id": "px-1",
                    "auth_state": "authorized",
                    "auth_method": "oauth",
                    "profile": PROFILE,
                    "slot": 0,
                }
            else:
                host.environments[ENV_ID]["auth_state"] = "authorized"

            spawned = []
            refresh_mock = Mock()
            stderr_buf = io.StringIO()
            with (
                patch.object(
                    impl.threading,
                    "Thread",
                    side_effect=lambda *a, **kw: (spawned.append(real_thread(*a, **kw)) or spawned[-1]),
                ),
                patch.object(host, "refresh_account", new=refresh_mock),
                patch.object(impl.sys, "stderr", new=stderr_buf),
            ):
                with host.lock:
                    assert host._schedule_reauth_check_locked(ENV_ID) is True
                    assert ENV_ID in host._reauth_checking
                    if next_state is None:
                        del host.environments[ENV_ID]
                    else:
                        host.environments[ENV_ID]["auth_state"] = next_state
                spawned[0].join(timeout=3.0)
                assert not spawned[0].is_alive()

            refresh_mock.assert_not_called()
            assert ENV_ID not in host._reauth_checking
            assert stderr_buf.getvalue() == ""


for _name, _case in sorted(globals().items()):
    if _name.startswith("test_"):
        _case()
print("gemini-reauth-worker: ALL PASS")
