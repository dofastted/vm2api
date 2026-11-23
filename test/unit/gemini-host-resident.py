"""Unit tests for resident CRAGGemini NativeSession, SlotNetworkLease, and auto-heal."""

import hashlib
import json
import os
import tempfile
import threading
import time
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
spec = spec_from_file_location("gemini_host", ROOT / "scripts/gemini-host.py")
impl = module_from_spec(spec)
spec.loader.exec_module(impl)

ENV_ID = "gemini-" + "a" * 24
PROFILE = "b" * 32
PROXY = "socks5h://u1:secret-pass@192.0.2.15:1080"
PROXY_SHA = hashlib.sha256(PROXY.encode()).hexdigest()
PROXY_DIGEST = hashlib.sha256(PROXY.encode()).digest()
MODEL_A = "gemini-3-flash"
MODEL_B = "gemini-3-pro"


class FixtureHost(impl.Host):
    def payload_config(self):
        return self.payload, True, self.public_key, None, "fixture-resident-1"

    def payload_identity(self, source, public_key, digest):
        return digest

    def verify_payload(self, source, public_key, install=False):
        return "fixture-resident-1"

    def recover_network(self, env_dir, slot):
        pass

    def oauth_runtime_issue(self):
        return None


def make_fake_session(proxy_digest=PROXY_DIGEST, concurrency=1, alive=True):
    sess = Mock()
    sess.model = MODEL_A
    sess.max_concurrency = concurrency
    sess.proxy_hash = proxy_digest
    sess.socket_path = "/tmp/fake-kernel.sock"
    sess.native_token = "t" * 64
    sess.native_diagnostic = None
    sess.last_used = time.monotonic()
    sess._last_health_at = time.monotonic()
    sess._health_failures = 0
    sess._fail_next_health = False
    sess._alive = alive
    sess.is_alive.side_effect = lambda: sess._alive
    sess.is_severely_unhealthy.side_effect = (
        lambda: (not sess._alive) or sess._health_failures >= impl.NATIVE_HEALTH_FAIL_THRESHOLD
    )

    def _health(timeout=0.5):
        sess._last_health_at = time.monotonic()
        if not sess._alive:
            sess._health_failures = impl.NATIVE_HEALTH_FAIL_THRESHOLD
            return None
        if getattr(sess, "_fail_next_health", False):
            sess._health_failures += 1
            return None
        sess._health_failures = 0
        return {"ready": True, "ok": True, "needs_recovery": False}

    sess.health.side_effect = _health
    return sess


with tempfile.TemporaryDirectory(prefix="gemini-resident-") as temporary:
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
            "name": "ResidentEnv",
            "proxy_id": "px-1",
            "auth_state": "authorized",
            "auth_method": "oauth",
            "profile": PROFILE,
            "max_concurrency": 1,
            "call_models": [MODEL_A, MODEL_B],
            "updated_at": "2030-01-01T00:00:00+00:00",
            "slot": 0,
        }
    }
    (directory / "environments.json").write_text(json.dumps(records))
    (directory / ENV_ID / PROFILE).mkdir(parents=True)

    with (
        patch.object(impl, "check_root_owned"),
        patch.object(
            impl, "read_root_file", side_effect=lambda path, limit: path.read_bytes()
        ),
        patch.object(
            impl, "profile_secrets", return_value=(("tok",), b'{"token":{}}')
        ),
    ):
        host = FixtureHost(args)

        # 1. Unified pool_mode: max_concurrency == 1 MUST still enable pool_mode for NativeSession.
        probe_obj = impl.NativeAgy.__new__(impl.NativeAgy)
        probe_obj.max_concurrency = 1
        assert (None is None) is True
        with patch.object(impl.Agy, "__init__", return_value=None):
            na = impl.NativeAgy(
                host, records[ENV_ID], PROXY, (("tok",), b""), MODEL_A, None
            )
            assert na.pool_mode is True, "concurrency=1 NativeSession must use managed pool_mode"
            na_oneshot = impl.NativeAgy(
                host, records[ENV_ID], PROXY, (("tok",), b""), MODEL_A, "hi"
            )
            assert na_oneshot.pool_mode is False

        # 2. Warm RPC starts background NativeSession and populates runtime_ready=True.
        warmed_evt = threading.Event()
        created_sessions = []

        def fake_native_session(h, env, purl, auth, model):
            s = make_fake_session()
            s.model = model
            created_sessions.append(s)
            warmed_evt.set()
            return s

        with patch.object(impl, "NativeSession", side_effect=fake_native_session):
            res = host._request(
                "warm",
                {
                    "id": ENV_ID,
                    "proxy_id": "px-1",
                    "proxy_url": PROXY,
                    "proxy_sha256": PROXY_SHA,
                },
            )
            assert res["warming"] is True
            assert warmed_evt.wait(timeout=3.0), "background warm worker did not start session"
            # Wait briefly for worker to install into host.native_sessions under lock.
            deadline = time.monotonic() + 2.0
            while ENV_ID not in host.native_sessions and time.monotonic() < deadline:
                time.sleep(0.01)
            assert ENV_ID in host.native_sessions
            first_session = host.native_sessions[ENV_ID]
            assert host.view(host.environments[ENV_ID])["runtime_ready"] is True

            # Calling warm again while healthy is an instant no-op.
            res2 = host._request(
                "warm",
                {
                    "id": ENV_ID,
                    "proxy_id": "px-1",
                    "proxy_url": PROXY,
                    "proxy_sha256": PROXY_SHA,
                },
            )
            assert res2 == {"warmed": True, "runtime_ready": True, "warming": False}
            assert len(created_sessions) == 1

            # 3. Idle survival: even if last_used is 10 hours ago, cleanup() NEVER kills NativeSession!
            first_session.last_used = time.monotonic() - 36000
            first_session._last_health_at = time.monotonic() - 30
            host.cleanup()
            assert host.native_sessions.get(ENV_ID) is first_session
            first_session.close.assert_not_called()

            # 4. Model switch reuses the EXACT SAME NativeSession without tearing it down!
            ctx_b = {
                "identifier": ENV_ID,
                "env": dict(host.environments[ENV_ID]),
                "auth": (("tok",), b""),
                "proxy_url": PROXY,
                "model": MODEL_B,
            }
            acquired = host._acquire_native_session(ctx_b)
            assert acquired is first_session
            assert len(created_sessions) == 1

            # 5. Single transient health failure does NOT kill NativeSession; only >=3 misses or exit does!
            first_session._fail_next_health = True
            first_session._last_health_at = 0.0
            host.cleanup()
            assert first_session._health_failures == 1
            assert host.native_sessions.get(ENV_ID) is first_session
            first_session.close.assert_not_called()
            first_session._fail_next_health = False

            # 6. test-chat reuses resident NativeSession and does NOT stop it!
            fake_run = Mock()
            fake_run.poll.return_value = {
                "state": "completed",
                "text": "ok",
                "usage": {"total_tokens": 5},
            }
            with patch.object(impl, "ResidentTestChatRun", return_value=fake_run) as run_cls:
                run_resp = host._request(
                    "test-chat",
                    {
                        "id": ENV_ID,
                        "proxy_id": "px-1",
                        "proxy_url": PROXY,
                        "model": MODEL_B,
                        "prompt": "ping resident",
                    },
                )
                assert "run_id" in run_resp
                run_cls.assert_called_once()
                assert run_cls.call_args.args[0] is first_session
                assert host.native_sessions.get(ENV_ID) is first_session
                status = host._request(
                    "test-chat-status",
                    {"id": ENV_ID, "run_id": run_resp["run_id"]},
                )
                assert status["state"] == "completed"
                assert host.native_sessions.get(ENV_ID) is first_session
                first_session.close.assert_not_called()

            # 7. Crash auto-heal: when resident session dies, cleanup() stops it and auto-warms a replacement!
            warmed_evt.clear()
            first_session._alive = False
            host.cleanup()
            first_session.close.assert_called_once()
            assert warmed_evt.wait(timeout=3.0), "crashed resident session was not auto-healed"
            deadline = time.monotonic() + 2.0
            while (
                host.native_sessions.get(ENV_ID) is None
                or host.native_sessions.get(ENV_ID) is first_session
            ) and time.monotonic() < deadline:
                time.sleep(0.01)
            healed = host.native_sessions.get(ENV_ID)
            assert healed is not None and healed is not first_session
            assert len(created_sessions) == 2

        # 8. SlotNetworkLease refcounting: sharing vm2agy<slot> + kin-egress across NativeSession & Headless.
        start_calls = []
        stop_calls = []
        fake_egress = Mock()
        fake_egress.poll.return_value = None

        def fake_start_network(lease_dir, network):
            start_calls.append((lease_dir, list(network)))
            r_fd, w_fd = os.pipe()
            os.close(w_fd)
            return r_fd

        def fake_stop_network(lease_dir, network, lock_fd):
            stop_calls.append((lease_dir, list(network)))

        with (
            patch.object(host, "start_network", side_effect=fake_start_network),
            patch.object(host, "stop_network", side_effect=fake_stop_network),
            patch.object(impl.os, "chown"),
            patch.object(
                impl.subprocess,
                "run",
                return_value=SimpleNamespace(returncode=0),
            ),
            patch.object(impl.subprocess, "Popen", return_value=fake_egress),
        ):
            env_dir = directory / ENV_ID
            net = ["0", "2016", "192.0.2.15", "1080"]
            lease1 = host.acquire_slot_network(
                0, env_dir, net, "px-1", PROXY, PROXY_DIGEST, lambda u: ["true"]
            )
            assert lease1["refcount"] == 1
            assert len(start_calls) == 1

            # Second holder (e.g. Headless `agy models`) borrows the SAME netns + egress without colliding!
            lease2 = host.acquire_slot_network(
                0, env_dir, net, "px-1", PROXY, PROXY_DIGEST, lambda u: ["true"]
            )
            assert lease2 is lease1
            assert lease1["refcount"] == 2
            assert len(start_calls) == 1

            # Closing Headless decrements refcount -> egress & netns stay alive!
            host.release_slot_network(0, lease2)
            assert lease1["refcount"] == 1
            assert len(stop_calls) == 0
            fake_egress.kill.assert_not_called()

            # Closing last holder tears down egress & netns cleanly!
            host.release_slot_network(0, lease1)
            assert lease1["refcount"] == 0
            assert len(stop_calls) == 1
            fake_egress.kill.assert_called_once()

        # 9. Unready NativeSession crash records exponential backoff (no 32s tight loop).
        unready = make_fake_session()
        unready._ever_ready = False
        unready._health_failures = impl.NATIVE_HEALTH_FAIL_THRESHOLD
        unready._last_health_at = 0.0
        unready._fail_next_health = True
        host.native_sessions[ENV_ID] = unready
        host._warm_backoff = {}
        with patch.object(impl.threading, "Thread") as thread_cls:
            host.cleanup()
            assert ENV_ID not in host.native_sessions
            assert ENV_ID in host._warm_backoff
            assert host._warm_backoff[ENV_ID][0] == 1
            assert host._warm_backoff[ENV_ID][1] > time.monotonic()
            spawned_names = [call.kwargs.get("name", "") for call in thread_cls.call_args_list]
            # Backoff MUST block immediate re-warm spawn; missing/expired token schedules reauth check.
            assert not any(n.startswith("gemini-warm-") for n in spawned_names), spawned_names
            assert any(n.startswith("gemini-reauth-") for n in spawned_names), spawned_names

print("gemini-host-resident: ALL PASS")
