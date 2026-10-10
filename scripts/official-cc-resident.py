#!/usr/bin/env python3
"""Keep the slot cli-node attached after init hello.

Host PTY + `docker exec -it` so the CLI stays in an interactive session.
Does not print credentials. Exits when the guest CLI process exits.
"""
from __future__ import annotations

import json
import os
import pty
import sys


def build_argv() -> list[str]:
    raw = os.environ.get("KIN_DOCKER_ARGV", "").strip()
    if raw:
        argv = json.loads(raw)
        if not isinstance(argv, list) or not argv or argv[0] != "exec":
            raise SystemExit(2)
        return ["docker", *argv]
    container = os.environ.get("KIN_CONTAINER", "").strip()
    uid = os.environ.get("KIN_UID", "").strip()
    gid = os.environ.get("KIN_GID", "").strip()
    if not container or not uid or not gid:
        return []
    tz = os.environ.get("TZ", "UTC")
    lang = os.environ.get("LANG", "en_US.UTF-8")
    cli = os.environ["KIN_CLI_BIN"]
    return [
        "docker", "exec", "-it",
        "-u", f"{uid}:{gid}",
        "-e", "HOME=/home/kincli",
        "-e", "TMPDIR=/home/kincli/.cache/tmp",
        "-e", f"TZ={tz}",
        "-e", f"LANG={lang}",
        "-e", f"LC_ALL={lang}",
        "-e", "PATH=/home/kincli/.local/bin:/usr/bin:/bin",
        "-e", "CLAUDE_CODE_HOST_REFRESH=1",
        "-e", f"CLAUDE_CODE_VERSION={os.environ.get('KIN_CLI_VERSION', '2.1.293')}",
        "-e", "USER_TYPE=external",
        "-e", "KIN_OFFICIAL_CC=1",
        "-e", "CLAUDE_CODE_USE_BEDROCK=0",
        "-e", "CLAUDE_CODE_USE_VERTEX=0",
        "-e", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=0",
        "-e", "DISABLE_TELEMETRY=1",
        "-e", "DO_NOT_TRACK=1",
        "-e", "ANTHROPIC_BASE_URL=",
        "-e", "ANTHROPIC_API_KEY=",
        "-e", "ANTHROPIC_AUTH_TOKEN=",
        "-w", "/home/kincli",
        container,
        cli,
    ]


def main() -> int:
    argv = build_argv()
    if not argv:
        return 2
    return pty.spawn(argv) or 0


if __name__ == "__main__":
    sys.exit(main())
