#!/bin/sh
set -eu

ROOT="${KIN_PROJECT_ROOT:-/opt/vm2api}"
IMAGE_BIN="/opt/vm2api/image-bin"
mkdir -p "$ROOT/vms" "$ROOT/data" "$ROOT/bin"

if [ ! -f "$ROOT/vms/active.json" ]; then
  printf '%s\n' '{ "active_vm": "vm-01" }' > "$ROOT/vms/active.json"
fi
if [ ! -f "$ROOT/vms/vm-01.json" ]; then
  cat > "$ROOT/vms/vm-01.json" <<'EOF'
{
  "id": "vm-01",
  "name": "vm-01",
  "status": "stopped",
  "schedulable": false,
  "policy": { "maxConcurrency": 2 }
}
EOF
fi

ensure_bin() {
  name="$1"
  dest="$ROOT/bin/$name"
  src="$IMAGE_BIN/$name"
  if [ -f "$src" ]; then
    cp "$src" "$dest"
    chmod 755 "$dest"
    return 0
  fi
  if [ -f "$dest" ]; then
    chmod 755 "$dest" || true
  fi
}
ensure_bin kin-kernel
ensure_bin kin-egress
ensure_bin kin-worker

KERNEL="${KIN_KERNEL_BIN:-$ROOT/bin/kin-kernel}"
if [ ! -x "$KERNEL" ]; then
  echo "vm2api: $KERNEL missing or not executable after image-bin copy. Rebuild with docker compose build, or put linux amd64 Release files in $ROOT/bin." >&2
  exit 1
fi

if [ ! -S /var/run/docker.sock ]; then
  echo "vm2api: /var/run/docker.sock not mounted; slot create/start will fail." >&2
elif [ -f /opt/vm2api/docker/kin-os/build.mjs ]; then
  node /opt/vm2api/docker/kin-os/build.mjs ubuntu
fi

cd /opt/vm2api
exec node src/server.mjs
