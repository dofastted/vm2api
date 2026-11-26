"""Unit tests for CRAGGemini remote release resolution and idle pool quiesce."""

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load_module(name, relative_path):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_maintenance_remote_release_resolution_and_version_ordering():
    gm = load_module("gemini_maintenance", "scripts/gemini-maintenance.py")
    daemon = gm.Maintenance.__new__(gm.Maintenance)
    daemon.crag_bundle = True
    daemon.release = {
        "id": "payload-2026.11.24-gemini-0.4.6",
        "version": "0.4.6",
        "cli_version": "1.5.9",
    }

    pinned_default = daemon.resolve_release(None)
    assert pinned_default["id"] == "payload-2026.11.24-gemini-0.4.6"
    assert pinned_default["pinned"] is True

    pinned_explicit = daemon.resolve_release("payload-2026.11.24-gemini-0.4.6")
    assert pinned_explicit["pinned"] is True

    remote = daemon.resolve_release("payload-2026.11.25-gemini-0.4.7")
    assert remote == {
        "id": "payload-2026.11.25-gemini-0.4.7",
        "version": "0.4.7",
        "cli_version": "1.5.9",
        "pinned": False,
    }

    remote_rc = daemon.resolve_release("payload-2026.11.25-gemini-0.5.0-rc.1")
    assert remote_rc["version"] == "0.5.0-rc.1"
    assert remote_rc["pinned"] is False

    assert daemon.can_update("0.4.4", "1.5.9", "0.4.7", "1.5.9") is True
    assert daemon.can_update("0.4.6", "1.5.9", "0.4.6", "1.5.9") is True
    assert daemon.can_update("0.4.7", "1.5.9", "0.4.4", "1.5.9") is False
    assert daemon.can_update("0.5.0", "1.5.9", "0.5.0-rc.1", "1.5.9") is False
    assert daemon.can_update("0.5.0-rc.1", "1.5.9", "0.5.0", "1.5.9") is True

    for invalid in (
        "not-in-catalog",
        "v0.4.6",
        "payload-2026.11.24-crag-3.1.17",
        "../evil",
        "payload-2026.11.24-gemini-0.4.6?x=1",
    ):
        try:
            daemon.resolve_release(invalid)
        except gm.Failure as error:
            assert error.status == 400
            assert error.code == "gemini_maintenance_unknown_release"
        else:
            raise AssertionError(f"resolve_release accepted invalid tag {invalid!r}")

    # Legacy non-CRAG bundles remain strictly pinned to catalog.json.
    daemon.crag_bundle = False
    try:
        daemon.resolve_release("payload-2026.11.25-gemini-0.4.7")
    except gm.Failure as error:
        assert error.status == 400
        assert error.code == "gemini_maintenance_unknown_release"
    else:
        raise AssertionError("non-CRAG bundle accepted remote release tag")


def test_host_maintenance_quiesce_stops_only_idle_resident_pools():
    gh = load_module("gemini_host", "scripts/gemini-host.py")
    host = gh.Host.__new__(gh.Host)
    host.pending = {}
    host.terminals = {}
    host.runs = {}
    host.active_infers = {}
    host.daemon_shards = {"shard-0": object()}
    host.native_sessions = {"env-1": object()}
    stopped = []

    def stop_shard(shard_id):
        host.daemon_shards.pop(shard_id)
        stopped.append(("shard", shard_id))

    def stop_session(env_id):
        host.native_sessions.pop(env_id)
        stopped.append(("session", env_id))

    host._stop_shard = stop_shard
    host.stop_native_session = stop_session

    result = host._request("maintenance-quiesce", {})
    assert result == {"busy": False, "stopped": 2}
    assert stopped == [("shard", "shard-0"), ("session", "env-1")]
    assert not host.daemon_shards and not host.native_sessions

    # Active inference must refuse quiesce without stopping any resident pool.
    host.daemon_shards = {"shard-1": object()}
    host.active_infers = {"env-1": {"req-1": object()}}
    busy = host._request("maintenance-quiesce", {})
    assert busy == {"busy": True}
    assert "shard-1" in host.daemon_shards


def test_crag_default_public_key_recognition_and_pinned_agy_reuse():
    import hashlib
    import tempfile

    gm = load_module("gemini_maintenance", "scripts/gemini-maintenance.py")
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        daemon = gm.Maintenance.__new__(gm.Maintenance)
        daemon.crag_bundle = True
        daemon.runtime = root / "runtime"
        daemon.public_key = root / "etc/gemini-ed25519.pub"
        pubkey_bytes = b"-----BEGIN PUBLIC KEY-----\nTEST\n-----END PUBLIC KEY-----\n"
        daemon.pins = {
            "crag-license-public.pem": {
                "size": len(pubkey_bytes),
                "sha256": hashlib.sha256(pubkey_bytes).hexdigest(),
            }
        }
        # Any crag-license-public.pem under runtime/defaults/ is a default CRAG key.
        assert (
            daemon.is_default_crag_public_key(
                daemon.runtime / "defaults" / ("a" * 64) / "crag-license-public.pem"
            )
            is True
        )
        assert (
            daemon.is_default_crag_public_key(
                daemon.runtime / "defaults/0.3.0/crag-license-public.pem"
            )
            is True
        )
        # An external custom key must fail closed unless it matches the pinned default key.
        custom = root / "custom-key.pem"
        custom.write_bytes(b"custom-third-party-key")
        assert daemon.is_default_crag_public_key(custom) is False
        # Non-CRAG bundles never treat external keys as default CRAG keys.
        daemon.crag_bundle = False
        assert (
            daemon.is_default_crag_public_key(
                daemon.runtime / "defaults/0.3.0/crag-license-public.pem"
            )
            is False
        )


if __name__ == "__main__":
    test_maintenance_remote_release_resolution_and_version_ordering()
    test_host_maintenance_quiesce_stops_only_idle_resident_pools()
    test_crag_default_public_key_recognition_and_pinned_agy_reuse()
    print("gemini-maintenance remote release and quiesce verified")
