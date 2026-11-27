import errno
import subprocess
import tempfile
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = spec_from_file_location("gemini_host", ROOT / "scripts/gemini-host.py")
impl = module_from_spec(spec)
spec.loader.exec_module(impl)


def test_classify_emfile_enfile():
    emfile = OSError(errno.EMFILE, "Too many open files")
    enfile = OSError(errno.ENFILE, "File table overflow")
    assert impl.classify_craggemini_license_host_error(emfile) == (
        503,
        "gemini_host_resource_exhausted",
    )
    assert impl.classify_craggemini_license_host_error(enfile) == (
        503,
        "gemini_host_resource_exhausted",
    )
    wrapped = subprocess.SubprocessError("launch failed")
    wrapped.__cause__ = emfile
    assert impl.classify_craggemini_license_host_error(wrapped) == (
        503,
        "gemini_host_resource_exhausted",
    )
    assert impl.classify_craggemini_license_host_error(OSError(errno.EACCES, "nope")) is None


def test_run_craggemini_license_cli_emfile():
    with tempfile.TemporaryDirectory(prefix="gemini-license-resource-") as tmp:
        root = Path(tmp)
        payload = root / "payload"
        payload.mkdir()
        (payload / "craggemini").write_bytes(b"")
        (payload / "manifest.json").write_text('{"payload":{}}')
        (payload / "craggemini.payload.enc").write_bytes(b"x")
        (payload / "crag-license-public.pem").write_text("x")
        host = object.__new__(impl.Host)
        host.directory = root
        host.payload = payload
        host.payload_mode = "crag_subscription"
        host.crag_host_dir = root / "host"
        host.verified_payload = True
        env = {"id": "env-1", "auth_method": "oauth", "uid": 1000}
        with patch.object(host, "ensure_payload", return_value=None), patch.object(
            host, "env_uid", return_value=1000
        ), patch.object(
            host, "ensure_env_machine_id", return_value=root / "machine-id"
        ), patch.object(
            host, "ensure_env_license_dir", return_value=root / "crag-license"
        ), patch(
            "subprocess.run", side_effect=OSError(errno.EMFILE, "pipe2")
        ):
            try:
                host.run_craggemini_license_cli(env, ["--license-status"])
            except impl.Failure as failure:
                assert failure.status == 503
                assert failure.code == "gemini_host_resource_exhausted"
            else:
                raise AssertionError("expected Failure for EMFILE")


def test_license_status_preserves_resource_code():
    with tempfile.TemporaryDirectory(prefix="gemini-license-resource-") as tmp:
        root = Path(tmp)
        host = object.__new__(impl.Host)
        host.directory = root
        host.payload = root / "payload"
        host.payload_mode = "crag_subscription"
        host.crag_host_dir = root / "host"
        env = {"id": "env-1", "auth_method": "oauth"}
        with patch.object(
            host,
            "run_craggemini_license_cli",
            side_effect=impl.Failure(503, "gemini_host_resource_exhausted"),
        ):
            status = host.license_status(env, use_cache=False)
        assert status["code"] == "gemini_host_resource_exhausted"
        assert status["code"] != "license_unconfigured"
        assert status["code"] != "license_invalid"
        assert status["status"] == "host_resource_exhausted"
        assert status["status"] != "unconfigured"


test_classify_emfile_enfile()
test_run_craggemini_license_cli_emfile()
test_license_status_preserves_resource_code()

assert "gemini_host_resource_exhausted" in impl.HOST_RESOURCE_ERROR_CODES
assert "gemini_host_resource_exhausted" not in impl.SANDBOX_ERROR_CODES

print("gemini-host-license-resource: ok")