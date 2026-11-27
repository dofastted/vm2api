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

        # 8. SlotNetworkLease refcounting: sharing vm2agy<slot> + host relay + kin-egress across NativeSession & Headless.
        assert (
            impl.rewrite_proxy_endpoint("socks5h://u%401:p%3A2@192.0.2.15:1080", "198.18.252.1", 41080)
            == "socks5h://u%401:p%3A2@198.18.252.1:41080"
        )
        assert (
            impl.rewrite_proxy_endpoint("socks5h://192.0.2.15:1080", "198.18.252.1", 41080)
            == "socks5h://198.18.252.1:41080"
        )
        start_calls = []
        stop_calls = []
        fake_relay = Mock()
        fake_relay.poll.return_value = None
        fake_egress = Mock()
        fake_egress.poll.return_value = None
        seen_egress_cfg = []

        def fake_start_network(lease_dir, network):
            start_calls.append((lease_dir, list(network)))
            seen_egress_cfg.append(json.loads((lease_dir / "egress.json").read_text()))
            r_fd, w_fd = os.pipe()
            os.close(w_fd)
            return r_fd

        def fake_stop_network(lease_dir, network, lock_fd):
            stop_calls.append((lease_dir, list(network)))

        with (
            patch.object(host, "start_network", side_effect=fake_start_network),
            patch.object(host, "stop_network", side_effect=fake_stop_network),
            patch.object(impl, "host_tcp_listening", return_value=True),
            patch.object(impl.os, "chown"),
            patch.object(
                impl.subprocess,
                "run",
                return_value=SimpleNamespace(returncode=0),
            ),
            patch.object(impl.subprocess, "Popen", side_effect=[fake_relay, fake_egress]),
        ):
            env_dir = directory / ENV_ID
            net = ["0", "2016", "192.0.2.15", "1080"]
            lease1 = host.acquire_slot_network(
                0, env_dir, net, "px-1", PROXY, PROXY_DIGEST, lambda u: ["true"]
            )
            assert lease1["refcount"] == 1
            assert len(start_calls) == 1
            # Relay mode configures netns toward the slot gateway IP (198.18.252.1:<ephemeral>).
            assert start_calls[0][1][2] == "198.18.252.1", start_calls[0][1]
            assert seen_egress_cfg[0]["proxy_url"].startswith("socks5h://")
            assert "@198.18.252.1:" in seen_egress_cfg[0]["proxy_url"] or seen_egress_cfg[0]["proxy_url"].startswith(
                "socks5h://198.18.252.1:"
            )

            # Second holder (e.g. Headless `agy models`) borrows the SAME netns + relay + egress without colliding!
            lease2 = host.acquire_slot_network(
                0, env_dir, net, "px-1", PROXY, PROXY_DIGEST, lambda u: ["true"]
            )
            assert lease2 is lease1
            assert lease1["refcount"] == 2
            assert len(start_calls) == 1

            # Closing Headless decrements refcount -> relay, egress & netns stay alive!
            host.release_slot_network(0, lease2)
            assert lease1["refcount"] == 1
            assert len(stop_calls) == 0
            fake_relay.kill.assert_not_called()
            fake_egress.kill.assert_not_called()

            # Closing last holder tears down relay, egress & netns cleanly!
            host.release_slot_network(0, lease1)
            assert lease1["refcount"] == 0
            assert len(stop_calls) == 1
            fake_relay.kill.assert_called_once()
            fake_egress.kill.assert_called_once()

        # 8b. #1622 authorize failing-stage reporting & redaction (no proxy secrets leaked to stderr).
        import io
        prev_auth_state = host.environments[ENV_ID]["auth_state"]
        auth_secret_proxy = "socks5h://authuser:supersecretpass@192.0.2.15:1080"
        auth_secret_sha = hashlib.sha256(auth_secret_proxy.encode()).hexdigest()
        for expected_stage in ("network_prepare", "relay_start", "proxy_probe", "egress_start", "cli_launch", "challenge_wait"):
            captured_err = io.StringIO()
            with (
                patch.object(host, "ensure_oauth_runtime"),
                patch.object(
                    impl,
                    "Login",
                    side_effect=impl.Failure(503, stage=expected_stage),
                ),
                patch.object(impl.sys, "stderr", captured_err),
            ):
                try:
                    host._request(
                        "authorize",
                        {
                            "id": ENV_ID,
                            "proxy_id": "px-1",
                            "proxy_url": auth_secret_proxy,
                            "proxy_sha256": auth_secret_sha,
                        },
                    )
                except impl.Failure as err:
                    assert err.status == 503
                    assert err.code == "gemini_authorization_unavailable"
                    assert err.stage == expected_stage, (err.stage, expected_stage)
                else:
                    raise AssertionError(f"expected Failure for stage={expected_stage}")
            stderr_text = captured_err.getvalue()
            assert f"Gemini CLI authorization did not start stage={expected_stage}" in stderr_text, stderr_text
            assert "supersecretpass" not in stderr_text
            assert "192.0.2.15" not in stderr_text
        host.environments[ENV_ID]["auth_state"] = prev_auth_state

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

        # 10. Blocking account.eligibility prevents resident pre-warming and reports runtime_ready=False.
        host.environments[ENV_ID]["account"] = {
            "state": "ok",
            "eligibility": "verification_required",
        }
        host.native_sessions.clear()
        host._warm_backoff = {}
        assert host._can_keep_resident(host.environments[ENV_ID]) is False
        warm_blocked = host._request(
            "warm",
            {
                "id": ENV_ID,
                "proxy_id": "px-1",
                "proxy_url": PROXY,
                "proxy_sha256": PROXY_SHA,
            },
        )
        assert warm_blocked == {"warmed": False, "runtime_ready": False, "warming": False}
        assert ENV_ID not in host.native_sessions

        # 11. Poisoned native_diagnostic marks live session not ready and cleanup() stops it without re-warming.
        poisoned_diag = SimpleNamespace(
            poll=lambda *, final=False: "gemini_account_verification_required"
        )
        poisoned = make_fake_session()
        poisoned.native_diagnostic = poisoned_diag
        poisoned.is_severely_unhealthy.side_effect = lambda: True
        poisoned._last_health_at = 0.0
        host.environments[ENV_ID]["account"] = {"state": "ok"}
        host.native_sessions[ENV_ID] = poisoned
        assert host.view(host.environments[ENV_ID])["runtime_ready"] is False
        with patch.object(impl.threading, "Thread") as thread_cls:
            host.cleanup()
            poisoned.close.assert_called_once()
            assert ENV_ID not in host.native_sessions
            spawned_names = [call.kwargs.get("name", "") for call in thread_cls.call_args_list]
            assert not any(n.startswith("gemini-warm-") for n in spawned_names), spawned_names

        # 12. refresh_account() recycles a stale/poisoned NativeSession when eligibility clears and re-warms.
        stale = make_fake_session()
        stale.native_diagnostic = poisoned_diag
        host.environments[ENV_ID]["account"] = {
            "state": "ok",
            "eligibility": "verification_required",
        }
        host.native_sessions[ENV_ID] = stale
        host._warm_backoff = {}
        with (
            patch.object(impl, "read_account", return_value={"state": "ok", "email": "u@example.com"}),
            patch.object(host, "_schedule_warm_locked") as sched_warm,
        ):
            host.refresh_account(host.environments[ENV_ID], PROXY, auto_pull_models=False)
            stale.close.assert_called_once()
            assert ENV_ID not in host.native_sessions
            sched_warm.assert_called_once_with(ENV_ID, force=True)

        # 13. Terminal.relay() method must NOT be shadowed by Agy's egress_relay handle.
        fake_term_egress = Mock()
        fake_term_egress.poll.return_value = None
        fake_term_relay = Mock()
        fake_term_relay.poll.return_value = None

        def fake_terminal_start(self_term, _proxy_url, _size):
            self_term.pid = 4242
            self_term.terminal = 99
            self_term.egress = fake_term_egress
            self_term.egress_relay = fake_term_relay

        with (
            patch.object(impl.Agy, "start", fake_terminal_start),
            patch.object(impl.Terminal, "await_start", return_value=None),
            patch.object(impl.Terminal, "exited", return_value=False),
            patch.object(impl.Terminal, "live_profile", return_value=True),
            patch.object(impl.os, "read", return_value=b"hi"),
        ):
            term = impl.Terminal(
                host,
                records[ENV_ID],
                PROXY,
                directory / ENV_ID / PROFILE,
                (80, 24),
                "sess-relay-check",
                ("tok",),
            )
            assert term.egress_relay is fake_term_relay
            assert callable(term.relay), "Terminal.relay method must remain callable"
            assert term.relay.__func__ is impl.Terminal.relay
            assert term.alive() is True
            assert term.relay(b"", None) == "aGk="
            fake_term_relay.poll.return_value = 1
            assert term.alive() is False

        # NativeSession.is_alive() also tracks egress_relay.
        ns_probe = impl.NativeSession.__new__(impl.NativeSession)
        ns_probe.egress = fake_term_egress
        ns_probe.native_tui = Mock()
        ns_probe.native_tui.poll.return_value = None
        ns_probe.egress_relay = fake_term_relay
        fake_term_relay.poll.return_value = None
        assert ns_probe.is_alive() is True
        fake_term_relay.poll.return_value = 1
        assert ns_probe.is_alive() is False

        # 14. ThreadingUnixStreamServer must configure a large listen backlog (>= 128) for burst concurrency.
        assert impl.ThreadingUnixStreamServer.request_queue_size >= 128, (
            impl.ThreadingUnixStreamServer.request_queue_size
        )

        # 15. _stream_native_infer handles http.client.IncompleteRead cleanly as 502 gemini_inference_failed.
        from http.client import IncompleteRead

        bad_sess = make_fake_session()
        bad_conn = Mock()
        bad_resp = Mock()
        bad_resp.read1.side_effect = IncompleteRead(b"")
        bad_sess.open_stream.return_value = (bad_conn, bad_resp)
        host.native_sessions[ENV_ID] = bad_sess
        fake_handler = Mock()
        fake_ctx = {
            "identifier": ENV_ID,
            "request_id": "req-incomplete-read",
            "native_body": {"model": MODEL_A, "contents": [{"role": "user", "parts": [{"text": "hi"}]}]},
            "model": MODEL_A,
            "auth": ((), None),
            "entry": {"cancel_event": threading.Event()},
            "gateway_policy": None,
        }
        with (
            patch.object(host, "_use_sharded_daemon", return_value=False),
            patch.object(host, "_acquire_native_session", return_value=bad_sess),
        ):
            state, err_code = host._stream_native_infer(fake_ctx, fake_handler)
        assert (state, err_code) == ("failed", "gemini_inference_failed")
        fake_handler.send_json_error.assert_called_once_with(502, "gemini_inference_failed")
        bad_conn.close.assert_called_once()

        # 16. proxy_config accepts HTTP + domain proxies while rejecting localhost/loopback/IPv6/numeric-TLD.
        assert impl.proxy_config("http://user:pw@192.0.2.20:8080") == ("192.0.2.20", "8080")
        assert impl.proxy_config("http://proxy.example.com") == ("proxy.example.com", "80")
        assert impl.proxy_config("socks5://proxy.example.com:1080") == ("proxy.example.com", "1080")
        assert impl.proxy_config("socks5h://u:p@sub.proxy-1.example.com:1080") == (
            "sub.proxy-1.example.com",
            "1080",
        )
        for bad_proxy in (
            "http://localhost:8080",
            "socks5h://foo.localhost:1080",
            "http://127.0.0.1:8080",
            "socks5h://169.254.1.1:1080",
            "socks5h://[2001:db8::1]:1080",
            "http://2130706433:8080",
            "https://proxy.example.com:443",
        ):
            try:
                impl.proxy_config(bad_proxy)
                raise AssertionError(f"expected Failure for {bad_proxy}")
            except impl.Failure as err:
                assert err.status == 400

        # 17. acquire_slot_network writes egress_options (domain_forward/dns_empty_types/dns_upstream)
        #     into egress.json and recycles the lease when egress_options change.
        egress_cfgs = []

        def fake_start_net_opts(lease_dir, network):
            egress_cfgs.append(json.loads((lease_dir / "egress.json").read_text()))
            r_fd, w_fd = os.pipe()
            os.close(w_fd)
            return r_fd

        relay_a, egress_a = Mock(), Mock()
        relay_a.poll.return_value = None
        egress_a.poll.return_value = None
        relay_b, egress_b = Mock(), Mock()
        relay_b.poll.return_value = None
        egress_b.poll.return_value = None
        opts_a = {
            "domain_forward": True,
            "dns_empty_types": [64, 65],
            "dns_upstream": "https://8.8.8.8/dns-query",
        }
        opts_b = {"domain_forward": False, "dns_empty_types": [64, 65]}
        with (
            patch.object(host, "start_network", side_effect=fake_start_net_opts),
            patch.object(host, "stop_network"),
            patch.object(impl, "host_tcp_listening", return_value=True),
            patch.object(impl.os, "chown"),
            patch.object(impl.subprocess, "run", return_value=SimpleNamespace(returncode=0)),
            patch.object(
                impl.subprocess, "Popen", side_effect=[relay_a, egress_a, relay_b, egress_b]
            ),
        ):
            env_dir = directory / ENV_ID
            net = ["1", "2016", "proxy.example.com", "8080"]
            http_proxy = "http://u:p@proxy.example.com:8080"
            http_hash = hashlib.sha256(http_proxy.encode()).digest()
            l1 = host.acquire_slot_network(
                1, env_dir, net, "px-http", http_proxy, http_hash, lambda u: ["true"], egress_options=opts_a
            )
            assert egress_cfgs[0]["domain_forward"] is True
            assert egress_cfgs[0]["dns_empty_types"] == [64, 65]
            assert egress_cfgs[0]["dns_upstream"] == "https://8.8.8.8/dns-query"
            assert egress_cfgs[0]["proxy_url"].startswith("http://u:p@198.18.252.5:")
            # Matching egress_options reuses existing lease.
            l1_reuse = host.acquire_slot_network(
                1, env_dir, net, "px-http", http_proxy, http_hash, lambda u: ["true"], egress_options=opts_a
            )
            assert l1_reuse is l1
            host.release_slot_network(1, l1_reuse)
            host.release_slot_network(1, l1)
            # Different egress_options creates fresh lease with updated egress.json.
            l2 = host.acquire_slot_network(
                1, env_dir, net, "px-http", http_proxy, http_hash, lambda u: ["true"], egress_options=opts_b
            )
            assert l2 is not l1
            assert "domain_forward" not in egress_cfgs[1]
            assert egress_cfgs[1]["dns_empty_types"] == [64, 65]
            host.release_slot_network(1, l2)

print("gemini-host-resident: ALL PASS")
