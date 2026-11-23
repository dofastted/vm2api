#!/usr/bin/env python3
"""Stage the pinned Linux amd64 Gemini payload without touching the installed payload."""

import argparse
import fcntl
import hashlib
import http.client
import json
import os
import platform
import re
import stat
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

VERSION = "0.3.0"
TAG = f"payload-2026.11.23-gemini-{VERSION}"
NATIVE_RELEASE = f"https://github.com/dofastted/vm2api/releases/download/{TAG}"
NATIVE_ASSETS = (
    "craggemini",
    "craggemini.payload.enc",
    "libagy_bridge.so",
    "crag-license-public.pem",
    "manifest.json",
)
AGY_URL = (
    "https://storage.googleapis.com/antigravity-public/antigravity-cli/"
    "1.5.9-4515810895593472/linux-x64/cli_linux_x64.tar.gz"
)
AGY_SIZE = 99166075
AGY_SHA256 = "8b1f5e56779f2434a0af36f1b715a8392a084de550f8c68bc79821f95fabf3fa"
CHUNK_SIZE = 1024 * 1024
MAX_MEMBER_SIZE = 512 * 1024 * 1024  # Same limit as the signed-payload verifier.


class HttpsRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urlsplit(newurl).scheme != "https":
            raise RuntimeError("download redirected to a non-HTTPS URL")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def read_pins(manifest):
    with manifest.open(encoding="utf-8") as stream:
        data = json.load(stream)
    default = data.get("geminiDefaultLinuxAmd64") if isinstance(data, dict) else None
    if not isinstance(default, dict) or default.get("tag") != TAG:
        raise ValueError(f"{manifest} must pin Gemini release {TAG}")
    assets = default.get("assets")
    if not isinstance(assets, dict) or set(assets) != set(NATIVE_ASSETS):
        raise ValueError(f"{manifest} must pin exactly the five Gemini release assets")
    for name, pin in assets.items():
        if (
            not isinstance(pin, dict)
            or set(pin) != {"size", "sha256"}
            or type(pin.get("size")) is not int
            or not 0 < pin["size"] <= MAX_MEMBER_SIZE
            or not isinstance(pin.get("sha256"), str)
            or not re.fullmatch(r"[a-f0-9]{64}", pin["sha256"])
        ):
            raise ValueError(f"invalid size or SHA-256 pin for {name} in {manifest}")
    return assets


def copy_checked(stream, size, sha256, output=None):
    digest = hashlib.sha256()
    remaining = size
    while remaining:
        chunk = stream.read(min(CHUNK_SIZE, remaining))
        if not chunk:
            raise ValueError(f"truncated download or file (expected {size} bytes)")
        remaining -= len(chunk)
        digest.update(chunk)
        if output is not None:
            output.write(chunk)
    if stream.read(1):
        raise ValueError(f"download or file exceeds its {size}-byte pin")
    if digest.hexdigest() != sha256:
        raise ValueError("SHA-256 does not match the pin")


def download(opener, url, dest, size, sha256):
    print(f"Fetching pinned Gemini asset: {dest.name}", flush=True)
    try:
        request = Request(url, headers={"User-Agent": "vm2api-gemini-payload"})
        with opener.open(request, timeout=60) as response, dest.open("xb") as output:
            if response.status != 200:
                raise RuntimeError(f"unexpected HTTP status {response.status}")
            copy_checked(response, size, sha256, output)
    except (OSError, http.client.HTTPException, ValueError, RuntimeError) as error:
        raise RuntimeError(f"download {dest.name} from {url}: {error}") from error


def extract_agy(archive, output):
    with tarfile.open(archive, mode="r:gz") as tar:
        member = tar.next()
        if (
            member is None
            or member.name != "antigravity"
            or member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE)
            or not 0 < member.size <= MAX_MEMBER_SIZE
        ):
            raise ValueError(
                "the Antigravity archive must contain a regular antigravity file"
            )
        # Copy only the member body and assign the local name; never use archive paths or modes.
        with tar.extractfile(member) as source, output.open("xb") as dest:
            while chunk := source.read(CHUNK_SIZE):
                dest.write(chunk)
        if tar.next() is not None:
            raise ValueError(
                "the Antigravity archive contains unexpected additional entries"
            )
    archive.unlink()


def require_private(info, path, kind):
    if not kind(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ValueError(
            f"{path} must be owned by the installer user and have no group/other access"
        )


def check_cached(dest, assets):
    require_private(dest.lstat(), dest, stat.S_ISDIR)
    for name in (*NATIVE_ASSETS, "agy"):
        path = dest / name
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            require_private(os.fstat(fd), path, stat.S_ISREG)
            if name in assets:
                with os.fdopen(fd, "rb", closefd=False) as stream:
                    copy_checked(stream, **assets[name])
        except ValueError as error:
            raise ValueError(f"{path}: {error}") from error
        finally:
            os.close(fd)


def verify_signed_payload(dest):
    verifier = Path(__file__).resolve().with_name("install-gemini-payload.mjs")
    result = subprocess.run(
        [
            "node",
            str(verifier),
            "--check",
            "--source",
            str(dest),
            "--public-key",
            str(dest / "crag-license-public.pem"),
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if (
        result.returncode
        or result.stdout.strip() != f"Gemini payload {VERSION} verified"
    ):
        detail = result.stderr.strip() or f"expected verified Gemini payload {VERSION}"
        raise RuntimeError(f"signed Gemini payload verification failed: {detail}")


def prepare(dest, assets):
    if not dest.is_absolute() or not dest.name or ".." in dest.parts:
        raise ValueError(
            "--dest must be an absolute directory path with a private parent"
        )
    parent_fd = os.open(dest.parent, os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY)
    try:
        require_private(os.fstat(parent_fd), dest.parent, stat.S_ISDIR)
        fcntl.flock(parent_fd, fcntl.LOCK_EX)
        if os.path.lexists(dest):
            try:
                check_cached(dest, assets)
                verify_signed_payload(dest)
            except (
                OSError,
                ValueError,
                RuntimeError,
                subprocess.SubprocessError,
            ) as error:
                raise RuntimeError(
                    f"existing default cache was preserved; inspect or move {dest} before retrying: {error}"
                ) from error
            return

        opener = build_opener(HttpsRedirects())
        with tempfile.TemporaryDirectory(prefix=".gemini-", dir=dest.parent) as staging:
            stage = Path(staging)
            for name in NATIVE_ASSETS:
                download(
                    opener, f"{NATIVE_RELEASE}/{name}", stage / name, **assets[name]
                )
            archive = stage / "cli_linux_x64.tar.gz"
            download(opener, AGY_URL, archive, AGY_SIZE, AGY_SHA256)
            extract_agy(archive, stage / "agy")
            verify_signed_payload(stage)
            stage.rename(dest)
    finally:
        os.close(parent_fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--dest", type=Path, required=True)
    args = parser.parse_args()
    try:
        if sys.platform != "linux" or platform.machine() not in ("x86_64", "amd64"):
            raise RuntimeError("default Gemini payload requires Linux amd64")
        os.umask(0o077)
        prepare(args.dest, read_pins(args.manifest))
    except (
        OSError,
        ValueError,
        RuntimeError,
        tarfile.TarError,
        subprocess.SubprocessError,
    ) as error:
        print(f"Gemini default payload: {error}", file=sys.stderr)
        return 1
    print(f"Verified Gemini payload {VERSION}: {args.dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
