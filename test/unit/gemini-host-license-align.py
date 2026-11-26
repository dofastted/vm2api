import base64
import json
import tempfile
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = spec_from_file_location("gemini_host", ROOT / "scripts/gemini-host.py")
impl = module_from_spec(spec)
spec.loader.exec_module(impl)

native_spec = spec_from_file_location("gemini_host_native", ROOT / "scripts/gemini_host_native.py")
native_impl = module_from_spec(native_spec)
native_spec.loader.exec_module(native_impl)

KEY_A = "a" * 64
KEY_B = "b" * 64


def make_permit(payload_key_id):
    body = json.dumps({"version": 1, "product": "craggemini", "payload_key_id": payload_key_id}).encode("utf-8")
    encoded = base64.urlsafe_b64encode(body).decode("ascii").rstrip("=")
    return f"CRAGS1.{encoded}.{'A' * 86}"


# 1. CLI error classification preserves structured JSON codes, stderr semantics, and sync-pending.
assert impl.classify_craggemini_license_cli_error(
    json.dumps({"code": "license_payload_key_mismatch"}), ""
) == (403, "license_payload_key_mismatch")
assert impl.classify_craggemini_license_cli_error(
    json.dumps({"code": "license_invalid"}), "", sync_pending=True
) == (503, "gemini_subscription_sync_pending")
assert impl.classify_craggemini_license_cli_error(
    "", "craggemini: The CRAGGemini license payload key does not match the installed package."
) == (403, "license_payload_key_mismatch")
assert impl.classify_craggemini_license_cli_error(
    "", "craggemini: This CRAGGemini permit belongs to a different instance, seat, or host."
) == (403, "license_binding_mismatch")
assert impl.classify_craggemini_license_cli_error(
    "", "craggemini: The CRAGGemini license has expired."
) == (403, "license_expired")
assert impl.classify_craggemini_license_cli_error(
    "", "craggemini: The CRAGGemini license is not valid yet."
) == (403, "license_not_yet_valid")
assert impl.classify_craggemini_license_cli_error(
    "", "craggemini: CRAGGemini license trust is unconfigured."
) == (403, "license_unconfigured")
assert impl.classify_craggemini_license_cli_error(
    "", "craggemini: A CRAG subscription permit or registration code is required for craggemini."
) == (403, "license_required")
assert impl.classify_craggemini_license_cli_error(
    "", "craggemini: The CRAGGemini license or encrypted package is invalid.", sync_pending=True
) == (503, "gemini_subscription_sync_pending")
assert impl.classify_craggemini_license_cli_error(
    "", "craggemini: The CRAGGemini license or encrypted package is invalid.", sync_pending=False
) == (403, "license_invalid")

assert impl.classify_craggemini_license_cli_error(
    "",
    "bwrap: Can't find source path /opt/vm2api/share/gemini/current/craggemini: Permission denied",
) == (503, "gemini_sandbox_unavailable")
assert impl.classify_craggemini_license_cli_error(
    "", "bwrap: Can't bind mount on /usr/var/www/bwrap-test: Permission denied"
) == (503, "gemini_sandbox_unavailable")
assert impl.classify_craggemini_license_cli_error(
    "", "bwrap: Can't mount proc on /newroot/proc: Operation not permitted"
) == (503, "gemini_sandbox_unavailable")
assert impl.classify_craggemini_license_cli_error(
    "", "bwrap: execvp /opt/craggemini: Permission denied"
) == (503, "gemini_sandbox_unavailable")
assert impl.classify_craggemini_license_cli_error(
    "",
    "bwrap: Warning: hiding non-empty subdir /tmp\n"
    "craggemini: The CRAGGemini license or encrypted package is invalid.",
    sync_pending=False,
) == (403, "license_invalid")
assert impl.classify_craggemini_license_cli_error(
    "",
    "bwrap: Can't find source path /opt/vm2api/share/gemini/current/craggemini: Permission denied",
    sync_pending=True,
) == (503, "gemini_sandbox_unavailable")
with patch.object(impl, "_apparmor_sandbox_evidence", return_value=True):
    assert impl.classify_craggemini_license_cli_error(
        "", "bwrap: setting up uid map: Permission denied"
    ) == (503, "gemini_sandbox_apparmor_restricted")
with patch.object(impl, "_apparmor_sandbox_evidence", return_value=False):
    assert impl.classify_craggemini_license_cli_error(
        "", "bwrap: failed to setup new user namespace: Operation not permitted"
    ) == (503, "gemini_sandbox_unavailable")

# 2. Permit payload_key_id extraction & status reconciliation (including v0.4.10 compatibility).
assert impl.extract_permit_payload_key_id(make_permit(KEY_A)) == KEY_A
assert impl.extract_permit_payload_key_id("invalid-token") is None

reconciled_sync = impl.reconcile_craggemini_license_status(
    {"product": "craggemini", "status": "invalid", "valid": False, "code": "license_invalid"},
    sync_pending=True,
)
assert reconciled_sync["valid"] is False
assert reconciled_sync["status"] == "sync_pending"
assert reconciled_sync["code"] == "gemini_subscription_sync_pending"
assert reconciled_sync["sync_pending"] is True

reconciled_mismatch = impl.reconcile_craggemini_license_status(
    {"product": "craggemini", "status": "valid", "valid": True, "seat": 2},
    expected_payload_key_id=KEY_B,
    permit_payload_key_id=KEY_A,
    sync_pending=False,
)
assert reconciled_mismatch["valid"] is False
assert reconciled_mismatch["status"] == "invalid"
assert reconciled_mismatch["code"] == "license_payload_key_mismatch"
assert reconciled_mismatch["payload_key_id"] == KEY_A

reconciled_match = impl.reconcile_craggemini_license_status(
    {"product": "craggemini", "status": "valid", "valid": True, "seat": 2},
    expected_payload_key_id=KEY_B,
    permit_payload_key_id=KEY_B,
    sync_pending=False,
)
assert reconciled_match["valid"] is True
assert reconciled_match.get("code") is None

# 3. Host.license_status reads manifest.json, registration.code, and sync-pending end-to-end.
with tempfile.TemporaryDirectory(prefix="gemini-license-align-") as tmp:
    root = Path(tmp)
    payload_dir = root / "payload"
    payload_dir.mkdir()
    (payload_dir / "manifest.json").write_text(json.dumps({"payload": {"key_id": KEY_B}}))
    host_dir = root / "host-public"
    host_dir.mkdir()
    env_id = "gemini-env-1"
    lic_dir = root / env_id / "crag-license"
    lic_dir.mkdir(parents=True)
    (lic_dir / "registration.code").write_text(make_permit(KEY_A) + "\n")

    host = object.__new__(impl.Host)
    host.directory = root
    host.payload = payload_dir
    host.payload_mode = "crag_subscription"
    host.crag_host_dir = host_dir
    env = {"id": env_id, "auth_method": "oauth"}

    with patch.object(
        host,
        "run_craggemini_license_cli",
        return_value={"product": "craggemini", "status": "valid", "valid": True, "seat": 1},
    ):
        status = host.license_status(env)
    assert status["valid"] is False
    assert status["code"] == "license_payload_key_mismatch"
    assert status["payload_key_id"] == KEY_A
    assert status["seat_required"] is True

    (host_dir / "sync-pending").write_text("pending\n")
    with patch.object(
        host,
        "run_craggemini_license_cli",
        return_value={"product": "craggemini", "status": "invalid", "valid": False, "code": "license_invalid"},
    ):
        sync_status = host.license_status(env)
    assert sync_status["valid"] is False
    assert sync_status["code"] == "gemini_subscription_sync_pending"
    assert sync_status["sync_pending"] is True

    with patch.object(
        host,
        "run_craggemini_license_cli",
        side_effect=impl.Failure(503, "gemini_sandbox_unavailable"),
    ):
        sandbox_status = host.license_status(env, use_cache=False)
    assert sandbox_status["valid"] is False
    assert sandbox_status["code"] == "gemini_sandbox_unavailable"

# 4. Native worker error mapping preserves new codes with aligned HTTP statuses.
err_key = native_impl._map_worker_error(403, {"code": "license_payload_key_mismatch", "error": "mismatch"})
assert (err_key.code, err_key.status) == ("license_payload_key_mismatch", 403)
err_sync = native_impl._map_worker_error(503, {"code": "gemini_subscription_sync_pending", "error": "syncing"})
assert (err_sync.code, err_sync.status) == ("gemini_subscription_sync_pending", 503)

print("gemini-host-license-align: ok")
