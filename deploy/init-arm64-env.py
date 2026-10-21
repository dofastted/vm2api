#!/usr/bin/env python3
"""Create a local ARM64 deployment .env without replacing an existing file."""

import argparse
import ipaddress
import os
from pathlib import Path
import re
import secrets
import sys


def valid_port(value: str) -> int:
    try:
        port = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("port must be an integer") from exc
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("port must be between 1 and 65535")
    return port


def valid_container_name(value: str) -> str:
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*", value):
        raise argparse.ArgumentTypeError("container name must match [a-zA-Z0-9][a-zA-Z0-9_.-]*")
    return value


def valid_bind_host(value: str) -> str:
    try:
        ipaddress.ip_address(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("bind host must be an IPv4 or IPv6 address") from exc
    return value


def env_has(path: Path, key: str) -> bool:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return False
    return any(line.startswith(f"{key}=") and line[len(key) + 1:].strip() for line in lines)


# Bare `docker compose` (including the panel's one-click upgrade helper) reads
# COMPOSE_FILE from .env; without it the base service would start on ./vms and
# ./data instead of .local/arm64. The helper mounts VM2API_HOST_ROOT.
COMPOSE_FILE = "docker-compose.yml:docker-compose.arm64.yml"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=valid_port, default=8787)
    parser.add_argument("--container-name", type=valid_container_name, default="vm2api")
    parser.add_argument("--bind-host", type=valid_bind_host, default="127.0.0.1")
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[1]
    env_path = root / ".env"
    postgres_password = secrets.token_hex(32)
    values = {
        "VM2API_ADMIN_USER": "admin",
        "VM2API_ADMIN_PASSWORD": secrets.token_urlsafe(24),
        "VM2API_API_KEY": secrets.token_hex(32),
        "VM2API_DB_SECRET": secrets.token_hex(32),
        "COMPOSE_PROFILES": "postgres",
        "VM2API_POSTGRES_PORT": "55432",
        "VM2API_POSTGRES_PASSWORD": postgres_password,
        "VM2API_DATABASE_URL": f"postgresql://vm2api:{postgres_password}@127.0.0.1:55432/vm2api",
        "VM2API_CONTAINER_NAME": args.container_name,
        "VM2API_BIND_HOST": args.bind_host,
        "PORT": str(args.port),
        "COMPOSE_FILE": COMPOSE_FILE,
        "VM2API_HOST_ROOT": str(root),
    }
    try:
        fd = os.open(env_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        print("Existing .env preserved. Review it locally before starting this deployment.")
        missing = [key for key in ("COMPOSE_FILE", "VM2API_HOST_ROOT", "VM2API_DATABASE_URL") if not env_has(env_path, key)]
        if missing:
            print(f"Add to .env: COMPOSE_FILE={COMPOSE_FILE} and VM2API_HOST_ROOT={root} "
                  f"(missing: {', '.join(missing)}).")
        return 0
    except OSError as exc:
        print(f"Could not create .env: {exc}", file=sys.stderr)
        return 1

    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            stream.write("# Local deployment credentials; do not commit this file.\n")
            stream.writelines(f"{key}={value}\n" for key, value in values.items())
    except OSError as exc:
        print(f"Could not finish writing .env: {exc}. Review the file locally before starting.", file=sys.stderr)
        return 1

    print("Created .env with mode 0600. Open it locally to retrieve the administrator password.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
