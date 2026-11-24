"""read_pins derives the release from deploy/payload.json rather than a constant.

A hardcoded VERSION used to be a second source of truth that had to be bumped in
lockstep with the manifest, and it drifted across three releases (#1677): the
manifest moved to gemini 0.4.1, 0.4.2 and 0.4.3 while the script still said 0.3.0,
so read_pins rejected the manifest it ships with and prepare-gemini could not
prepare anything. These tests pin the derivation, and the tag's shape, because the
tag now comes from a file and is interpolated into a download URL.
"""

import hashlib
import io
import json
import os
import tempfile
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = spec_from_file_location("fetch_default_gemini", ROOT / "scripts/fetch-default-gemini.py")
impl = module_from_spec(spec)
spec.loader.exec_module(impl)

MANIFEST = ROOT / "deploy/payload.json"
RELEASE_PREFIX = "https://github.com/dofastted/vm2api/releases/download/"


def shipped_tag():
    with MANIFEST.open(encoding="utf-8") as stream:
        return json.load(stream)["geminiDefaultLinuxAmd64"]["tag"]


def write_manifest(directory, default):
    path = Path(directory) / "payload.json"
    path.write_text(json.dumps({"geminiDefaultLinuxAmd64": default}), encoding="utf-8")
    return path


def test_derives_the_shipped_tag():
    """The regression itself: whatever the manifest pins is what gets fetched."""
    tag = shipped_tag()
    pins = impl.read_pins(MANIFEST)
    assert pins["release"] == RELEASE_PREFIX + tag, pins["release"]
    assert tag.endswith("-" + pins["version"]), (tag, pins["version"])
    assert set(pins["assets"]) == set(impl.NATIVE_ASSETS), sorted(pins["assets"])


def test_follows_the_manifest_to_a_different_version():
    """No constant left to drift: a manifest naming another release is honoured."""
    with MANIFEST.open(encoding="utf-8") as stream:
        default = json.load(stream)["geminiDefaultLinuxAmd64"]
    moved = dict(default, tag="payload-2030.01.02-gemini-9.8.7")
    with tempfile.TemporaryDirectory() as directory:
        pins = impl.read_pins(write_manifest(directory, moved))
    assert pins["version"] == "9.8.7", pins["version"]
    assert pins["release"] == RELEASE_PREFIX + "payload-2030.01.02-gemini-9.8.7"


def test_rejects_tags_that_are_not_release_tags():
    """The tag builds a URL, so no traversal, no scheme, no query or fragment."""
    accepted = ("payload-2026.11.23-gemini-0.4.3", "payload-2026.11.23-gemini-0.3.0-rc.2")
    refused = (
        "../../../etc/passwd",
        "payload-2026.11.23-gemini-0.4.3/../../evil",
        "https://evil.example/x",
        "payload-2026.11.23-gemini-0.4.3?a=b",
        "payload-2026.11.23-gemini-0.4.3#frag",
        "payload-2026.11.23-gemini-abc",
        "",
        None,
        17,
    )
    for tag in accepted:
        assert impl.TAG_PATTERN.fullmatch(tag), tag
    with MANIFEST.open(encoding="utf-8") as stream:
        default = json.load(stream)["geminiDefaultLinuxAmd64"]
    for tag in refused:
        with tempfile.TemporaryDirectory() as directory:
            path = write_manifest(directory, dict(default, tag=tag))
            try:
                impl.read_pins(path)
            except ValueError:
                continue
            raise AssertionError(f"read_pins accepted tag {tag!r}")


def test_still_requires_the_five_pinned_assets():
    """Deriving the tag must not have loosened the asset and digest checks."""
    with MANIFEST.open(encoding="utf-8") as stream:
        default = json.load(stream)["geminiDefaultLinuxAmd64"]
    short = {name: pin for name, pin in list(default["assets"].items())[:4]}
    broken = dict(default["assets"])
    broken["manifest.json"] = {"size": 11, "sha256": "not-a-digest"}
    for assets in (short, broken, {}):
        with tempfile.TemporaryDirectory() as directory:
            path = write_manifest(directory, dict(default, assets=assets))
            try:
                impl.read_pins(path)
            except ValueError:
                continue
            raise AssertionError("read_pins accepted invalid asset pins")


def test_redirects_allow_only_trusted_https_hosts():
    handler = impl.HttpsRedirects()
    for blocked in (
        "http://github.com/dofastted/vm2api/releases/download/x/y",
        "https://evil.example/craggemini",
        "https://github.com:8443/dofastted/vm2api/releases/download/x/y",
        "https://user:pass@github.com/dofastted/vm2api/releases/download/x/y",
    ):
        try:
            handler.redirect_request(None, None, 302, "Found", {}, blocked)
        except RuntimeError:
            continue
        raise AssertionError(f"HttpsRedirects allowed untrusted URL {blocked!r}")


class _FakeHttpResponse(io.BytesIO):
    def __init__(self, payload):
        super().__init__(payload)
        self.status = 200

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()


class _FakeOpener:
    def __init__(self, assets_by_url):
        self.assets_by_url = assets_by_url

    def open(self, request, timeout=60):
        url = request.full_url if hasattr(request, "full_url") else str(request)
        if url not in self.assets_by_url:
            raise RuntimeError(f"unexpected URL requested: {url}")
        return _FakeHttpResponse(self.assets_by_url[url])


def _sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def _run_remote_tag_case(sha_map_override=None, *, pubkey_bytes=b"test-pubkey-pem", agy_bytes=b"test-agy-bin"):
    tag = "payload-2026.11.24-gemini-0.4.7"
    release_url = RELEASE_PREFIX + tag
    members = {
        "craggemini": b"craggemini-bin",
        "craggemini.payload.enc": b"encrypted-payload",
        "libagy_bridge.so": b"bridge-so",
    }
    sha_map = {
        **{name: _sha256_hex(raw) for name, raw in members.items()},
        "crag-license-public.pem": _sha256_hex(pubkey_bytes),
        "agy": _sha256_hex(agy_bytes),
    }
    if sha_map_override is not None:
        sha_map = sha_map_override(sha_map)
    manifest_bytes = json.dumps(
        {
            "family": "crag",
            "encrypted": True,
            "software_version": "0.4.7",
            "sha256": sha_map,
        }
    ).encode("utf-8")
    assets_by_url = {
        f"{release_url}/crag-license-public.pem": pubkey_bytes,
        f"{release_url}/manifest.json": manifest_bytes,
        **{f"{release_url}/{name}": raw for name, raw in members.items()},
    }
    pubkey_pin = {"size": len(pubkey_bytes), "sha256": _sha256_hex(pubkey_bytes)}

    orig_agy_sha = impl.AGY_BINARY_SHA256
    impl.AGY_BINARY_SHA256 = _sha256_hex(agy_bytes)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            parent = root / "private"
            parent.mkdir(mode=0o700)
            os.chmod(parent, 0o700)
            reuse_agy = root / "agy"
            reuse_agy.write_bytes(agy_bytes)
            os.chmod(reuse_agy, 0o644)
            dest = parent / "staged"
            verified_calls = []

            def _verify(stage, version):
                verified_calls.append((sorted(p.name for p in stage.iterdir()), version))

            result = impl.prepare_remote_tag(
                dest,
                tag,
                pubkey_pin,
                reuse_agy=reuse_agy,
                opener=_FakeOpener(assets_by_url),
                verify=_verify,
            )
            return result, sorted(p.name for p in dest.iterdir()), verified_calls
    finally:
        impl.AGY_BINARY_SHA256 = orig_agy_sha


def test_prepare_remote_tag_accepts_manifest_without_self_digest():
    """Remote CRAG manifest.json lists members and agy, never its own sha256."""
    version, files, verified = _run_remote_tag_case()
    assert version == "0.4.7", version
    expected_files = sorted([*impl.NATIVE_ASSETS, "agy"])
    assert files == expected_files, files
    assert verified == [(expected_files, "0.4.7")], verified


def test_prepare_remote_tag_rejects_missing_member_digest():
    """Every downloaded member binary digest must remain mandatory in manifest.sha256."""
    try:
        _run_remote_tag_case(lambda m: {k: v for k, v in m.items() if k != "libagy_bridge.so"})
    except RuntimeError as error:
        assert "pinned trust checks" in str(error), str(error)
        return
    raise AssertionError("prepare_remote_tag accepted manifest missing libagy_bridge.so digest")


def test_prepare_remote_tag_rejects_mismatched_pubkey_or_agy():
    """Mismatched crag-license-public.pem or agy digests in remote manifest must fail."""
    bad_hex = "0" * 64
    for key in ("crag-license-public.pem", "agy"):
        try:
            _run_remote_tag_case(lambda m, target=key: {**m, target: bad_hex})
        except RuntimeError as error:
            assert "pinned trust checks" in str(error), str(error)
            continue
        raise AssertionError(f"prepare_remote_tag accepted mismatched {key} digest")


for name, case in sorted(globals().items()):
    if name.startswith("test_"):
        case()
print("fetch-default-gemini pin derivation verified")
