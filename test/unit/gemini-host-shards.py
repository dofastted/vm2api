import json
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


print("OK")
