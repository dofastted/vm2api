"""read_pins derives the release from deploy/payload.json rather than a constant.

A hardcoded VERSION used to be a second source of truth that had to be bumped in
lockstep with the manifest, and it drifted across three releases (#1677): the
manifest moved to gemini 0.4.1, 0.4.2 and 0.4.3 while the script still said 0.3.0,
so read_pins rejected the manifest it ships with and prepare-gemini could not
prepare anything. These tests pin the derivation, and the tag's shape, because the
tag now comes from a file and is interpolated into a download URL.
"""

import json
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


for name, case in sorted(globals().items()):
    if name.startswith("test_"):
        case()
print("fetch-default-gemini pin derivation verified")
