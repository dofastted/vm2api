import json
import os
import tempfile
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
spec = spec_from_file_location("gemini_host", ROOT / "scripts/gemini-host.py")
impl = module_from_spec(spec)
spec.loader.exec_module(impl)

PROXY = "socks5h://fixture:private-proxy@192.0.2.11:1080"


class FixtureHost(impl.Host):
    def payload_config(self):
        return self.payload, True, self.public_key, None, "fixture-1"

    def payload_identity(self, source, public_key, digest):
        return digest

    def verify_payload(self, source, public_key, install=False):
        return "fixture-1"

    def recover_network(self, env_dir, slot):
        pass

    def oauth_runtime_issue(self):
        return None


def make_env(idx):
    env_id = f"gemini-{idx:024x}"
    return env_id, {
        "id": env_id,
        "name": f"Acc {idx}",
        "proxy_id": "px-1",
        "auth_state": "authorized",
        "auth_method": "oauth",
        "profile": "a" * 32,
        "call_models": ["gemini-3-pro"],
        "updated_at": "2030-01-01T00:00:00+00:00",
        "slot": idx,
    }


# 1. Policy normalization accepts both nested routing.json shape and flat shape.
pol = impl.normalize_runtime_policy(
    {
        "pool": {
            "strategy": "fill",
            "accounts_per_daemon": 50,
            "daemon_fault_isolation": True,
            "max_concurrency_per_account": 4,
            "min_warm_slots": 2,
            "circuit_failure_threshold": 5,
        },
        "sticky": {"enabled": True, "ttl_seconds": 1800},
        "shm": {"require_shm": True, "request_mb": 8, "response_mb": 32},
    }
)
assert pol["strategy"] == "fill"
assert pol["accounts_per_daemon"] == 50
assert pol["max_concurrency_per_account"] == 4
assert pol["min_warm_slots"] == 2
assert pol["sticky_ttl_secs"] == 1800
assert pol["shm_request_mb"] == 8
assert pol["shm_response_mb"] == 32

with tempfile.TemporaryDirectory(prefix="gemini-shards-") as temporary:
    directory = Path(temporary)
    # Create 55 OAuth accounts -> expects 2 shards at default accounts_per_daemon=50.
    records = dict(make_env(i) for i in range(55))
    (directory / "environments.json").write_text(json.dumps(records))
    args = SimpleNamespace(
        state=directory,
        uid_base=1000,
        payload=directory / "payload",
        payload_source=None,
        public_key=None,
        default_public_key=None,
        default_release_verifier=None,
        release_verifier=None,
        egress=None,
    )

    with (
        patch.object(impl, "check_root_owned"),
        patch.object(impl, "read_root_file", side_effect=lambda p, limit: p.read_bytes()),
    ):
        host = FixtureHost(args)
        assert host.runtime_policy["accounts_per_daemon"] == 50
        assert host._use_sharded_daemon() is True
        # UID mapping stays strictly inside [uid_base, uid_base + MAX_NETNS_SLOTS).
        for env in host.environments.values():
            uid = host.env_uid(env)
            assert 1000 <= uid < 1000 + impl.MAX_NETNS_SLOTS

        # 55 accounts deterministically shard into shard-0 (50) and shard-1 (5).
        ids = sorted(records.keys())
        shard0 = [host._shard_id_for_account(eid) for eid in ids[:50]]
        shard1 = [host._shard_id_for_account(eid) for eid in ids[50:]]
        assert set(shard0) == {"shard-0"}
        assert set(shard1) == {"shard-1"}

        # Attach a mock shard and verify apply-policy + daemon-status + daemon-action.
        mock_shard = Mock()
        mock_shard.members = {ids[0]: {}}
        mock_shard.is_alive.return_value = True
        mock_shard.apply_policy.return_value = True
        mock_shard.account_lifecycle.return_value = {"account_id": ids[0], "enabled": False}
        mock_shard.status_view.return_value = {
            "shard_id": "shard-0",
            "kind": "shard",
            "alive": True,
            "ready": True,
            "pid": 4242,
            "capacity": 50,
            "account_count": 1,
            "account_ids": [ids[0]],
            "active_slots": 1,
            "idle_slots": 2,
            "total_slots": 3,
            "circuit_open_accounts": 0,
            "shm_enabled": True,
            "shm_ring_stats": {
                "requests_total": 10,
                "responses_total": 40,
                "request_bytes_total": 4096,
                "response_bytes_total": 16384,
                "crc_errors_total": 0,
                "backpressure_waits_total": 1,
            },
            "policy": impl.runtime_policy_to_kernel_patch(host.runtime_policy),
            "accounts": [],
            "fault_isolated": False,
            "restart_count": 0,
        }
        host.daemon_shards["shard-0"] = mock_shard

        applied = host._request(
            "apply-policy",
            {"policy": {"pool": {"strategy": "round_robin", "accounts_per_daemon": 50}}},
        )
        assert applied["ok"] is True
        assert applied["shards_updated"] == 1
        assert applied["policy"]["strategy"] == "round_robin"
        assert (directory / "runtime-policy.json").exists()
        mock_shard.apply_policy.assert_called_once()

        status = host._request("daemon-status", {})
        assert status["mode"] == "sharded"
        assert status["planned_shards"] == 2
        assert status["authorized_oauth_accounts"] == 55
        assert status["total_active_slots"] == 1
        assert status["total_idle_slots"] == 2
        assert status["shm_ring_stats"]["requests_total"] == 10

        lc = host._request(
            "daemon-action",
            {
                "action": "account_lifecycle",
                "account_id": ids[0],
                "lifecycle_action": "pause",
            },
        )
        assert lc["ok"] is True
        assert lc["result"]["enabled"] is False

        restarted = host._request(
            "daemon-action", {"action": "restart_shard", "shard_id": "shard-0"}
        )
        assert restarted["ok"] is True
        mock_shard.close.assert_called_once()
        assert "shard-0" not in host.daemon_shards

        # Fault isolation: failing shard-0 isolates shard-0 and returns None for fallback,
        # without isolating shard-1.
        with patch.object(
            impl,
            "CragDaemonShard",
            side_effect=impl.Failure(503, "gemini_native_worker_unavailable"),
        ):
            ctx0 = {
                "identifier": ids[0],
                "env": records[ids[0]],
                "proxy_url": PROXY,
                "auth": (("tok",), b"{}"),
                "model": "gemini-3-pro",
            }
            shard, sid = host._acquire_shard_for_account(ctx0)
            assert shard is None
            assert sid == "shard-0"
            assert host._is_shard_isolated("shard-0") is True
            assert host._is_shard_isolated("shard-1") is False

        # Switching accounts_per_daemon=1 enters per_account mode.
        single = host._request("apply-policy", {"policy": {"pool": {"accounts_per_daemon": 1}}})
        assert single["policy"]["accounts_per_daemon"] == 1
        assert host._use_sharded_daemon() is False

        # Default concurrency and max_sessions are both 20.
        assert host.runtime_policy["max_concurrency_per_account"] == 20
        assert host.runtime_policy["max_sessions_per_account"] == 20
        assert impl.env_concurrency({}) == 20
        env0 = host.environments[ids[0]]
        view0 = host.view(env0)
        assert view0["max_concurrency"] == 20
        assert view0["max_sessions"] == 20

        # Active API inference below max_concurrency=20 must NOT block operation_account(allow_concurrent_infer=True).
        host.active_infers[ids[0]] = {"req-live-1": {"cancel_event": Mock()}}
        with patch.object(impl, "profile_secrets", return_value=(("tok",), b"{}")):
            uid, key, auth = host.operation_account(env0, allow_concurrent_infer=True)
            assert key is None and auth is not None
        host.active_infers.pop(ids[0], None)

        # Successful inference clears stale VALIDATION_REQUIRED eligibility & validation_url
        # and prevents refresh_account from re-poisoning the verified account.
        env0["account"] = {
            "state": "ok",
            "eligibility": "verification_required",
            "validation_url": "https://accounts.google.com/v3/signin/continue?plt=1",
            "checked_at": "2030-01-01T00:00:00+00:00",
        }
        cleared = host._clear_eligibility_on_inference_success_locked(ids[0])
        assert cleared is True
        assert "eligibility" not in env0["account"]
        assert "validation_url" not in env0["account"]
        assert "eligibility_verified_at" in env0["account"]

        # Refreshing a verified paid-tier account must not resurrect an advisory
        # validation_url from alternative tiers, while preserving non-verification blocks.
        with (
            patch.object(host, "_profile_token_state", return_value=(False, False)),
            patch.object(
                impl,
                "read_account",
                return_value={
                    "state": "ok",
                    "validation_url": "https://accounts.google.com/v3/signin/continue?plt=paid",
                    "checked_at": "2030-01-01T00:05:00+00:00",
                },
            ),
        ):
            host.refresh_account(env0, PROXY, auto_pull_models=False)
        assert "validation_url" not in env0["account"]
        assert "eligibility_verified_at" in env0["account"]

        with (
            patch.object(host, "_profile_token_state", return_value=(False, False)),
            patch.object(
                impl,
                "read_account",
                return_value={
                    "state": "ok",
                    "eligibility": "location_unsupported",
                    "validation_url": "https://accounts.google.com/v3/signin/continue?plt=loc",
                    "checked_at": "2030-01-01T00:06:00+00:00",
                },
            ),
        ):
            host.refresh_account(env0, PROXY, auto_pull_models=False)
        assert env0["account"].get("eligibility") == "location_unsupported"

        # Periodic eligibility probe clears stale VALIDATION_REQUIRED when inference probe succeeds.
        env1 = host.environments[ids[1]]
        env1["account"] = {
            "state": "ok",
            "eligibility": "verification_required",
            "validation_url": "https://accounts.google.com/v3/signin/continue?plt=2",
            "checked_at": "2030-01-01T00:00:00+00:00",
        }
        host._remember_runtime_proxy(env1, PROXY)
        with (
            patch.object(impl, "profile_secrets", return_value=(("tok",), b"{}")),
            patch.object(host, "refresh_account"),
            patch.object(
                host, "_probe_eligibility_via_inference", return_value=(True, None)
            ) as probe_mock,
        ):
            scheduled = host._schedule_eligibility_probe_locked(ids[1])
            assert scheduled is True
            # Wait briefly for daemon probe thread to finish.
            import time as _t

            deadline = _t.monotonic() + 3.0
            while ids[1] in getattr(host, "_eligibility_probing", set()) and _t.monotonic() < deadline:
                _t.sleep(0.02)
            probe_mock.assert_called_once()
        assert "eligibility" not in env1["account"]
        assert "validation_url" not in env1["account"]
        assert host.last_inference[ids[1]][1]["state"] == "completed"


# 2. The kernel policy keys #1704 added are withheld from a payload read as older
# than 0.4.5, which is the combination that broke v1.4.193+ against the pinned
# 0.4.4 payload (#1729).
assert impl.kernel_policy_rejected_by_payload("0.4.4") is True
assert impl.kernel_policy_rejected_by_payload("0.4.3") is True
assert impl.kernel_policy_rejected_by_payload("0.3.0") is True
assert impl.kernel_policy_rejected_by_payload("0.4.5") is False
assert impl.kernel_policy_rejected_by_payload("0.4.6") is False
assert impl.kernel_policy_rejected_by_payload("0.5.0") is False
assert impl.kernel_policy_rejected_by_payload("1.0.0") is False
# Double-digit components compare numerically, not lexically.
assert impl.kernel_policy_rejected_by_payload("0.4.10") is False
assert impl.kernel_policy_rejected_by_payload("0.10.0") is False
# A prerelease sorts below its own release, so 0.4.5-rc is not yet 0.4.5.
assert impl.kernel_policy_rejected_by_payload("0.4.5-rc.1") is True
assert impl.kernel_policy_rejected_by_payload("0.4.6-rc.1") is False
# An absent or unreadable version keeps today's behaviour rather than degrading:
# payload_failure() nulls payload_version on a healthy host.
assert impl.kernel_policy_rejected_by_payload(None) is False
assert impl.kernel_policy_rejected_by_payload("") is False
assert impl.kernel_policy_rejected_by_payload("fixture-1") is False
assert impl.kernel_policy_rejected_by_payload("0.4") is False
assert impl.kernel_policy_rejected_by_payload(404) is False

_BASE_CFG = {
    "run_dir": "/tmp/craggemini",
    "timeout_ms": 120000,
    "vm_id": "gemini-1",
    "shm_request_bytes": 4194304,
    "shm_response_bytes": 16777216,
    "strategy": "fill",
    "max_accounts": 1,
    "sticky_enabled": True,
    "sticky_ttl_secs": 1800,
    "require_shm": True,
    "circuit_failure_threshold": 5,
    "circuit_open_ms": 30000,
}

old = impl.strip_unsupported_kernel_policy(dict(_BASE_CFG), "0.4.4")
assert set(old) == {"run_dir", "timeout_ms", "vm_id"}
for field in impl.KERNEL_POLICY_FIELDS:
    assert field not in old
# Keys that already existed before #1704 survive the strip.
assert old["timeout_ms"] == 120000

kept = impl.strip_unsupported_kernel_policy(dict(_BASE_CFG), "0.4.5")
assert kept == _BASE_CFG

# 3. A payload older than 0.4.5 also turns off the shard path rather than being
# handed a shard config with its scheduling keys removed.
with tempfile.TemporaryDirectory(prefix="gemini-gate-") as temporary:
    directory = Path(temporary)
    (directory / "environments.json").write_text(json.dumps(dict([make_env(0)])))
    gate_args = SimpleNamespace(
        state=directory,
        uid_base=1000,
        payload=directory / "payload",
        payload_source=None,
        public_key=None,
        default_public_key=None,
        default_release_verifier=None,
        release_verifier=None,
        egress=None,
    )
    with (
        patch.object(impl, "check_root_owned"),
        patch.object(impl, "read_root_file", side_effect=lambda p, limit: p.read_bytes()),
    ):
        gate_host = FixtureHost(gate_args)
    assert gate_host.runtime_policy["accounts_per_daemon"] > 1
    gate_host.payload_version = "0.4.5"
    assert gate_host._use_sharded_daemon() is True
    gate_host.payload_version = "0.4.4"
    assert gate_host._use_sharded_daemon() is False
    # An unreadable version leaves the topology as it is today.
    gate_host.payload_version = None
    assert gate_host._use_sharded_daemon() is True

# 4. NativeSession.apply_policy() and CragDaemonShard.apply_policy() must hot-propagate
# session_idle_ttl_secs and min_warm_slots via POST /internal/v1/accounts/<id>/scale.
fake_calls = []


def _fake_worker_json_request(sock, token, method, path, payload=None, timeout=5.0):
    fake_calls.append((method, path, payload))
    return 200, {"ok": True}


with patch.object(impl, "native_module", return_value=SimpleNamespace(worker_json_request=_fake_worker_json_request)):
    # 4a. NativeSession (pool_mode=True)
    ns = impl.NativeSession.__new__(impl.NativeSession)
    ns.host = SimpleNamespace(runtime_policy=dict(impl.DEFAULT_RUNTIME_POLICY))
    ns.environment = {"id": "gemini-111111111111111111111111", "max_concurrency": 3}
    ns.max_concurrency = 3
    ns.pool_mode = True
    ns.native_dir = Path("/tmp/ns-test")
    ns.native_token = "tok"
    ns.is_alive = lambda: True
    assert ns.apply_policy({"pool": {"session_idle_ttl_secs": 90, "min_warm_slots": 1}}) is True
    assert len(fake_calls) == 2
    assert fake_calls[0][0] == "PUT" and fake_calls[0][1] == "/internal/v1/policy"
    assert fake_calls[1][0] == "POST"
    assert fake_calls[1][1] == "/internal/v1/accounts/gemini-111111111111111111111111/scale"
    assert fake_calls[1][2] == {
        "runnable_slots": 3,
        "max_concurrency": 3,
        "min_warm_slots": 1,
        "idle_ttl_secs": 90,
    }

    # 4b. CragDaemonShard (2 members with distinct max_concurrency, clamping min_warm_slots)
    fake_calls.clear()
    import threading as _th

    sh = impl.CragDaemonShard.__new__(impl.CragDaemonShard)
    sh._lock = _th.RLock()
    sh.policy = dict(impl.DEFAULT_RUNTIME_POLICY)
    sh.native_dir = Path("/tmp/sh-test")
    sh.native_token = "tok"
    sh.is_alive = lambda: True
    sh.members = {
        "gemini-222222222222222222222222": {"max_concurrency": 3},
        "gemini-333333333333333333333333": {"max_concurrency": 1},
    }
    assert sh.apply_policy({"pool": {"session_idle_ttl_secs": 90, "min_warm_slots": 2}}) is True
    assert len(fake_calls) == 3
    assert fake_calls[0][0] == "PUT" and fake_calls[0][1] == "/internal/v1/policy"
    scale_by_path = {path: body for method, path, body in fake_calls[1:] if method == "POST"}
    assert scale_by_path["/internal/v1/accounts/gemini-222222222222222222222222/scale"] == {
        "runnable_slots": 3,
        "max_concurrency": 3,
        "min_warm_slots": 2,
        "idle_ttl_secs": 90,
    }
    assert scale_by_path["/internal/v1/accounts/gemini-333333333333333333333333/scale"] == {
        "runnable_slots": 1,
        "max_concurrency": 1,
        "min_warm_slots": 1,
        "idle_ttl_secs": 90,
    }

# 5. License status stat-fingerprinted caching, invalidation, and Google 429 error parsing.
import time as _time

with tempfile.TemporaryDirectory(prefix="gemini-host-lic-cache-") as lic_tmp:
    lic_root = Path(lic_tmp)
    env_id = "gemini-444444444444444444444444"
    lic_dir = lic_root / env_id / "crag-license"
    host_dir = lic_root / "crag-host"
    lic_dir.mkdir(parents=True)
    host_dir.mkdir(parents=True)
    reg_file = lic_dir / "registration.code"
    reg_file.write_text("CRAGS1.v1", encoding="utf-8")

    ch = impl.Host.__new__(impl.Host)
    ch.directory = lic_root
    ch.crag_host_dir = host_dir
    ch.payload_mode = "crag_subscription"
    ch.verified_payload = "v1"
    ch.lock = _th.RLock()
    ch.environments = {
        env_id: {
            "id": env_id,
            "name": "Cache Env",
            "proxy_id": "px-1",
            "slot": 0,
            "auth_method": "oauth",
            "auth_state": "authorized",
            "account": {"state": "ok"},
        }
    }
    ch.native_sessions = {}
    ch.daemon_shards = {}
    ch._account_shard_map = {}
    ch.active_infers = {}
    ch.last_inference = {}
    ch.runtime_policy = dict(impl.DEFAULT_RUNTIME_POLICY)
    ch.payload_state = "installed"
    ch.payload_issue = None
    ch.payload_version = "0.4.10"
    ch.inspect_payload = lambda: None
    ch.oauth_runtime_issue = lambda: None
    ch._profile_credential_health = lambda _env: None
    ch.last_inference_view = lambda _env: {}

    cli_calls = [0]

    def fake_cli(_env, _args, input_code=None):
        cli_calls[0] += 1
        return {"status": "valid", "valid": True, "seat": 1, "expires_at": int(_time.time()) + 3600}

    ch.run_craggemini_license_cli = fake_cli
    res1 = ch.request("list", {})
    res2 = ch.request("list", {})
    assert cli_calls[0] == 1, f"expected cached license_status hit, got {cli_calls[0]} CLI calls"
    assert res1["environments"][0]["crag_license"]["valid"] is True
    assert res2["environments"][0]["crag_license"]["valid"] is True

    # Modifying registration.code changes lstat fingerprint and triggers fresh verification.
    reg_file.write_text("CRAGS1.v2-longer", encoding="utf-8")
    ch.request("list", {})
    assert cli_calls[0] == 2, f"expected cache invalidation on stat change, got {cli_calls[0]}"

    # Google JSON 429 parsing (quotaResetDelay, reason, and content_rejected).
    ms, reason, rejected = impl.Host._parse_google_quota_error(
        {
            "error": {
                "code": 429,
                "status": "RESOURCE_EXHAUSTED",
                "details": [{"reason": "QUOTA_EXHAUSTED", "metadata": {"quotaResetDelay": "1m15s"}}],
            }
        }
    )
    assert (ms, reason, rejected) == (75_000, "QUOTA_EXHAUSTED", False)

    ms2, reason2, rejected2 = impl.Host._parse_google_quota_error(
        {"error": {"code": 429, "status": "RESOURCE_EXHAUSTED", "message": "Resource exhausted"}}
    )
    assert (ms2, reason2, rejected2) == (None, None, True)

# 6. Native body control-char regex fast path & Unix HTTP/1.1 keep-alive connection pool reuse.
clean_body = {"contents": [{"role": "user", "parts": [{"text": "hello\tworld\nline2"}]}]}
extracted = impl.Host._extract_native_turn_body("gemini-3-pro", clean_body)
assert extracted is not None and extracted["contents"][0]["parts"][0]["text"] == "hello\tworld\nline2"
assert impl.Host._extract_native_turn_body(
    "gemini-3-pro", {"contents": [{"role": "user", "parts": [{"text": "bad\x07bell"}]}]}
) is None

import socket as _sock

with patch.object(impl, "check_root_owned"):
    native_mod = impl.native_module()
with tempfile.TemporaryDirectory(prefix="gemini-keepalive-") as ka_tmp:
    sock_path = str(Path(ka_tmp) / "kernel.sock")
    accepted = [0]
    served = [0]
    stop_ka = _th.Event()
    srv = _sock.socket(_sock.AF_UNIX, _sock.SOCK_STREAM)
    srv.bind(sock_path)
    srv.listen(4)
    srv.settimeout(0.5)

    def _serve_keepalive():
        body = b'{"ready":true,"native_pid":42}'
        resp = (
            b"HTTP/1.1 200 OK\r\n"
            b"Content-Type: application/json\r\n"
            b"Connection: keep-alive\r\n"
            + f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
            + body
        )
        while not stop_ka.is_set():
            try:
                conn, _ = srv.accept()
            except TimeoutError:
                continue
            except OSError:
                break
            accepted[0] += 1
            conn.settimeout(1.0)
            try:
                while not stop_ka.is_set():
                    data = conn.recv(4096)
                    if not data:
                        break
                    served[0] += 1
                    conn.sendall(resp)
            except OSError:
                pass
            finally:
                conn.close()

    t = _th.Thread(target=_serve_keepalive, daemon=True)
    t.start()
    try:
        tok = "a" * 32
        r1 = native_mod.worker_status(sock_path, tok, timeout=1.0)
        r2 = native_mod.worker_status(sock_path, tok, timeout=1.0)
        assert r1 == {"ready": True, "native_pid": 42}
        assert r2 == {"ready": True, "native_pid": 42}
        assert served[0] == 2
        assert accepted[0] == 1, f"expected keep-alive socket reuse (1 accept), got {accepted[0]}"
    finally:
        stop_ka.set()
        srv.close()
        t.join(timeout=2.0)

# 7. P2-A & P2-B: crag_subscription CragDaemonShard per-account license staging/sync + /infer-target.
with tempfile.TemporaryDirectory(prefix="gemini-p2-shard-") as p2_tmp:
    p2_root = Path(p2_tmp)
    env_a_id, env_a = make_env(10)
    env_b_id, env_b = make_env(11)
    for eid, code_val in ((env_a_id, "CRAGS1.seat-a"), (env_b_id, "CRAGS1.seat-b")):
        ldir = p2_root / eid / "crag-license"
        ldir.mkdir(parents=True)
        (ldir / "device.json").write_text('{"device_id":"dev-1"}', encoding="utf-8")
        (ldir / "registration.code").write_text(code_val, encoding="utf-8")

    sh_sub = impl.CragDaemonShard.__new__(impl.CragDaemonShard)
    sh_sub._lock = _th.RLock()
    sh_sub.uid = os.getuid()
    sh_sub.policy = dict(impl.DEFAULT_RUNTIME_POLICY)
    sh_sub.accounts_root = p2_root / "_shards" / "shard-0" / "accounts"
    sh_sub.host = SimpleNamespace(
        directory=p2_root,
        payload_mode="crag_subscription",
    )
    sh_sub.members = {env_a_id: {}, env_b_id: {}}

    with patch.object(impl.os, "chown"):
        sh_sub._sync_account_license_files(env_a)
        sh_sub._sync_account_license_files(env_b)
    staged_a = sh_sub.accounts_root / env_a_id / "crag-license"
    staged_b = sh_sub.accounts_root / env_b_id / "crag-license"
    assert (staged_a / "registration.code").read_text(encoding="utf-8") == "CRAGS1.seat-a"
    assert (staged_b / "registration.code").read_text(encoding="utf-8") == "CRAGS1.seat-b"

    binding_a = sh_sub._account_binding_payload(env_a, PROXY, "gemini-3-pro")
    assert binding_a["vm_id"] == env_a_id
    assert binding_a["license_dir"] == f"/accounts/{env_a_id}/crag-license"

    # Clearing host registration.code for env_a removes ONLY env_a's staged permit; env_b stays intact.
    (p2_root / env_a_id / "crag-license" / "registration.code").unlink()
    with patch.object(impl.os, "chown"):
        sh_sub.sync_account_license(env_a)
    assert not (staged_a / "registration.code").exists()
    assert (staged_b / "registration.code").read_text(encoding="utf-8") == "CRAGS1.seat-b"

    # /infer-target returns direct=True with Unix socket target for warm per-account pool
    # under crag_subscription (sharded daemon is disabled because each environment has its
    # own /etc/machine-id bound to device.json), and direct=True kind=shard under non-subscription.
    sock_file = p2_root / "kernel.sock"
    direct_srv = _sock.socket(_sock.AF_UNIX, _sock.SOCK_STREAM)
    direct_srv.bind(str(sock_file))
    direct_srv.listen(2)
    try:
        p2_host = impl.Host.__new__(impl.Host)
        p2_host.directory = p2_root
        p2_host.payload_mode = "crag_subscription"
        p2_host.payload_version = "0.4.12"
        p2_host.lock = _th.RLock()
        p2_host.environments = {env_a_id: env_a}
        p2_host.runtime_policy = dict(impl.DEFAULT_RUNTIME_POLICY)
        p2_host.daemon_shards = {}
        p2_host.native_sessions = {}
        p2_host._account_shard_map = {}
        p2_host._shard_faults = {}
        p2_host.active_infers = {}
        p2_host.runs = {}
        p2_host.terminals = {}
        p2_host.pending = {}
        p2_host.gateway_gid = None
        p2_host.socket_path = None
        p2_host.operation_account = lambda env, **kw: (os.getuid(), None, (("tok",), b"{}"))

        assert p2_host._use_sharded_daemon() is False
        sub_status = p2_host.daemon_status()
        assert sub_status["mode"] == "per_account"
        assert sub_status["planned_shards"] == 1

        warm_session = SimpleNamespace(
            uid=os.getuid(),
            socket_path=str(sock_file),
            native_token="s" * 40,
            attempt="epoch-session-1",
            pool_mode=True,
            _ever_ready=True,
            is_alive=lambda: True,
            is_severely_unhealthy=lambda: False,
        )
        p2_host._acquire_native_session = lambda ctx: warm_session
        sub_target = p2_host.request(
            "infer-target",
            {
                "id": env_a_id,
                "proxy_id": "px-1",
                "proxy_url": PROXY,
                "model": "gemini-3-pro",
            },
        )
        assert sub_target["direct"] is True
        assert sub_target["kind"] == "session"
        assert sub_target["socket_path"] == str(sock_file)
        assert sub_target["token"] == "s" * 40
        assert sub_target["message_path"] == f"/internal/v1/accounts/{env_a_id}/messages"
        assert sub_target["cancel_path"] == f"/internal/v1/accounts/{env_a_id}/cancel"
        assert sub_target["account_id"] == env_a_id

        p2_host.payload_mode = "signed_manifest"
        assert p2_host._use_sharded_daemon() is True
        warm_shard = SimpleNamespace(
            uid=os.getuid(),
            socket_path=str(sock_file),
            native_token="t" * 40,
            attempt="epoch-direct-1",
            _ever_ready=True,
            is_alive=lambda: True,
            is_severely_unhealthy=lambda: False,
        )
        p2_host._acquire_shard_for_account = lambda ctx: (warm_shard, "shard-0")

        target_info = p2_host.request(
            "infer-target",
            {
                "id": env_a_id,
                "proxy_id": "px-1",
                "proxy_url": PROXY,
                "model": "gemini-3-pro",
            },
        )
        assert target_info["direct"] is True
        assert target_info["kind"] == "shard"
        assert target_info["socket_path"] == str(sock_file)
        assert target_info["token"] == "t" * 40
        assert target_info["message_path"] == f"/internal/v1/accounts/{env_a_id}/messages"
        assert target_info["cancel_path"] == f"/internal/v1/accounts/{env_a_id}/cancel"
        assert target_info["account_id"] == env_a_id
    finally:
        direct_srv.close()

    # Direct runtime directory permissions:
    # 1) _allocate_native_dir creates direct_root with 0o711 (so unprivileged bwrap UIDs
    #    can traverse it) and native_dir with 0o700 (uid:uid) so craggemini's startup
    #    run_dir==0700 check succeeds.
    # 2) _expose_direct_socket transitions native_dir to 0o710 (uid:gateway_gid) and
    #    kernel.sock to 0o660 (uid:gateway_gid) once the worker is ready.
    perm_root = p2_root / "run-gemini"
    perm_root.mkdir(mode=0o755)
    perm_host = impl.Host.__new__(impl.Host)
    perm_host.socket_path = perm_root / "control.sock"
    perm_host.gateway_gid = 995
    chown_calls = []

    def _record_chown(target, uid_val, gid_val):
        chown_calls.append((Path(target), uid_val, gid_val))

    with (
        patch.object(impl, "check_root_owned"),
        patch.object(impl.os, "geteuid", return_value=0),
        patch.object(impl.os, "chown", side_effect=_record_chown),
    ):
        allocated_dir, owns_dir = perm_host._allocate_native_dir(
            os.getuid(), p2_root / "fallback-native", "sh-shard-0-deadbeef01"
        )
        assert owns_dir is True
        assert allocated_dir == perm_root / "d" / "sh-shard-0-deadbeef01"
        assert ((perm_root / "d").stat().st_mode & 0o7777) == 0o711
        assert (allocated_dir.stat().st_mode & 0o7777) == 0o700
        assert (perm_root / "d", 0, 995) in chown_calls
        assert (allocated_dir, os.getuid(), os.getuid()) in chown_calls

        alloc_sock = allocated_dir / "kernel.sock"
        alloc_srv = _sock.socket(_sock.AF_UNIX, _sock.SOCK_STREAM)
        alloc_srv.bind(str(alloc_sock))
        alloc_srv.listen(1)
        try:
            os.chmod(alloc_sock, 0o600)
            chown_calls.clear()
            exposed = perm_host._expose_direct_socket(
                SimpleNamespace(uid=os.getuid(), socket_path=str(alloc_sock))
            )
            assert exposed is True
            assert (allocated_dir.stat().st_mode & 0o7777) == 0o710
            assert (alloc_sock.stat().st_mode & 0o7777) == 0o660
            assert (allocated_dir, os.getuid(), 995) in chown_calls
            assert (alloc_sock, os.getuid(), 995) in chown_calls
        finally:
            alloc_srv.close()

# 8. Startup shard crash keeps exponential backoff and transparently falls back to per-account session.
with tempfile.TemporaryDirectory(prefix="gemini-shard-fallback-") as fb_tmp:
    fb_root = Path(fb_tmp)
    fb_id, fb_env = make_env(20)
    (fb_root / "environments.json").write_text(json.dumps({fb_id: fb_env}))
    fb_args = SimpleNamespace(
        state=fb_root,
        uid_base=1000,
        payload=fb_root / "payload",
        payload_source=None,
        public_key=None,
        default_public_key=None,
        default_release_verifier=None,
        release_verifier=None,
        egress=None,
    )
    with (
        patch.object(impl, "check_root_owned"),
        patch.object(impl, "read_root_file", side_effect=lambda p, limit: p.read_bytes()),
    ):
        fb_host = FixtureHost(fb_args)
        fb_host.payload_mode = "signed_manifest"
        fb_host.payload_version = "0.4.12"

        # 8a. Respawning after a prior fault must NOT reset failures until shard becomes ready.
        ctx_fb = {
            "identifier": fb_id,
            "env": fb_env,
            "proxy_url": PROXY,
            "auth": (("tok",), b"{}"),
            "model": "gemini-3-pro",
            "request_id": "req-fb-1",
            "native_body": {"contents": [{"role": "user", "parts": [{"text": "hi"}]}]},
            "entry": {"cancel_event": _th.Event(), "cancel_fn": None},
        }
        fb_host._record_shard_fault("shard-0")
        assert fb_host._shard_faults["shard-0"]["failures"] == 1
        # Simulate isolation window expiring.
        fb_host._shard_faults["shard-0"]["isolated_until"] = 0.0

        dead_shard = Mock()
        dead_shard.members = {fb_id: {}}
        dead_shard.is_alive.return_value = False
        dead_shard.is_severely_unhealthy.return_value = True
        dead_shard.open_stream.side_effect = native_mod.NativeFailure(
            "gemini_native_worker_unavailable", 503
        )

        class _FakeResp:
            def __init__(self):
                self._chunks = [b'data: {"candidates":[{"finishReason":"STOP"}]}\n\n', b""]

            def read1(self, _n):
                return self._chunks.pop(0) if self._chunks else b""

        class _FakeHandler:
            def __init__(self):
                self.sse_started = False
                self.chunks = []
                self.errors = []

            def begin_sse(self):
                self.sse_started = True

            def write_sse_chunk(self, chunk):
                self.chunks.append(chunk)

            def send_json_error(self, status, code=None, *args, **kwargs):
                self.errors.append((status, code))

        fallback_session = Mock()
        fallback_session.is_alive.return_value = True
        fallback_session.is_severely_unhealthy.return_value = False
        fallback_session.native_diagnostic = None
        fallback_session.open_stream.return_value = (Mock(), _FakeResp())

        handler = _FakeHandler()
        with (
            patch.object(impl, "CragDaemonShard", return_value=dead_shard),
            patch.object(fb_host, "_acquire_native_session", return_value=fallback_session),
            patch.object(impl, "native_module", return_value=native_mod),
            patch.object(impl, "session_diagnostic", return_value=None),
        ):
            state, err_code = fb_host._stream_native_infer(ctx_fb, handler)

        assert (state, err_code) == ("completed", None)
        assert handler.sse_started is True
        assert handler.errors == []
        assert len(handler.chunks) == 1
        assert "shard-0" not in fb_host.daemon_shards
        # failures escalated from 1 -> 2 instead of being reset to 0 on spawn.
        assert fb_host._shard_faults["shard-0"]["failures"] == 2
        assert fb_host._is_shard_isolated("shard-0") is True
        dead_shard.close.assert_called_once()
        fallback_session.open_stream.assert_called_once()

        # 8b. Once a shard succeeds open_stream, failures reset back to 0.
        fb_host._shard_faults["shard-0"]["isolated_until"] = 0.0
        healthy_shard = Mock()
        healthy_shard.members = {fb_id: {}}
        healthy_shard.is_alive.return_value = True
        healthy_shard.is_severely_unhealthy.return_value = False
        healthy_shard.open_stream.return_value = (Mock(), _FakeResp())
        handler2 = _FakeHandler()
        with (
            patch.object(impl, "CragDaemonShard", return_value=healthy_shard),
            patch.object(impl, "native_module", return_value=native_mod),
        ):
            state2, err_code2 = fb_host._stream_native_infer(ctx_fb, handler2)
        assert (state2, err_code2) == ("completed", None)
        assert fb_host._shard_faults["shard-0"]["failures"] == 0
        assert fb_host._is_shard_isolated("shard-0") is False

print("OK")
