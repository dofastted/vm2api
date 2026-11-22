#!/bin/sh
set -eu

ROOT="${KIN_PROJECT_ROOT:-/opt/vm2api}"
IMAGE_BIN="/opt/vm2api/image-bin"
mkdir -p "$ROOT/data"
# Modes:
#   (default)  leader boot: take the data-dir lock, refresh shared binaries, exec the server.
#   standby    KIN_STANDBY=1 without its activation marker: a blue/green standby boots next to the
#              leader. It neither locks nor touches shared files; the server takes the lock when it
#              is activated and calls `vm2api-entrypoint sync` once the old controller has exited.
#   sync       refresh shared binaries only (caller already holds the lock); prints WRAP_CHANGED=0|1.
MODE="${1:-run}"
STANDBY=0
if [ "$MODE" = run ] && [ "${KIN_STANDBY:-}" = 1 ]; then
  if [ -z "${KIN_STANDBY_ACTIVE_FILE:-}" ] || [ ! -f "$KIN_STANDBY_ACTIVE_FILE" ]; then
    STANDBY=1
  fi
fi
if [ "$MODE" = run ] && [ "$STANDBY" = 0 ]; then
  # Match the Node startup lock before replacing any shared binaries or configuration.
  exec 9<"$ROOT/data"
  flock -n -E 75 9 || {
    rc=$?
    if [ "$rc" = 75 ]; then
      echo 'vm2api_control_plane_already_running: stop the other controller first' >&2
    fi
    exit "$rc"
  }
fi
mkdir -p "$ROOT/vms" "$ROOT/bin"

# 镜像安装没有仓库 checkout：把镜像内默认配置补进被 bind-mount 覆盖的 src/config。
mkdir -p "$ROOT/src/config"
if [ -d /opt/vm2api/image-config ]; then
  for f in /opt/vm2api/image-config/*; do
    [ -f "$f" ] || continue
    dest="$ROOT/src/config/$(basename "$f")"
    [ -f "$dest" ] || cp "$f" "$dest"
  done
fi

# ARM64 主机上 slot 是 amd64，依赖宿主 qemu-x86_64 binfmt handler（重启后可能丢失）。
# 静态 amd64 kin-worker 无参数时以 2 退出；shell 返回 126/127 表示无法执行 x86 程序。
# 只提示不阻塞：面板仍要能打开。
X86_PROBE="${KIN_X86_PROBE_BIN:-/opt/vm2api/cluster-bin-amd64/kin-worker}"
if [ "$(uname -m)" = aarch64 ] && [ -f "$X86_PROBE" ]; then
  probe_rc=0
  "$X86_PROBE" >/dev/null 2>&1 || probe_rc=$?
  if [ "$probe_rc" -eq 126 ] || [ "$probe_rc" -eq 127 ]; then
    echo "vm2api: 宿主缺少 qemu-x86_64 binfmt handler，amd64 slot 将无法启动。" >&2
    echo "vm2api: 在宿主执行 python3 deploy/prepare-arm64.py（详见 docs/ARM64.md）。" >&2
  fi
fi

# No seeded vm-01. A fresh fleet is empty. Seeding an active placeholder made
# the only slot undeletable: DELETE refuses the active VM, and the next start
# would recreate the files.

ensure_bin() {
  name="$1"
  dest="$ROOT/bin/$name"
  src="$IMAGE_BIN/$name"
  if [ ! -f "$src" ]; then
    if [ -f "$dest" ]; then
      chmod 755 "$dest" || true
    fi
    return 0
  fi
  tmp="$dest.new"
  cp "$src" "$tmp"
  chmod 755 "$tmp"
  mv -f "$tmp" "$dest"
}

sync_shared() {
  ensure_bin kin-kernel
  ensure_bin kin-egress
  ensure_bin kin-slot-gate
  ensure_bin kin-worker
  ensure_bin kin-api-kernel
  ensure_bin kin-redact
  ensure_bin kin-codex-kernel
  ensure_bin kin-oauth-auth
  ensure_bin kin-computer
  KERNEL="${KIN_KERNEL_BIN:-$ROOT/bin/kin-kernel}"
  if [ ! -x "$KERNEL" ]; then
    echo "vm2api: $KERNEL missing or not executable after image-bin copy. Rebuild with docker compose build, or put linux amd64 Release files in $ROOT/bin." >&2
    exit 1
  fi
  API_KERNEL="${KIN_API_KERNEL_BIN:-$ROOT/bin/kin-api-kernel}"
  if [ ! -x "$API_KERNEL" ]; then
    echo "vm2api: $API_KERNEL missing or not executable after image-bin copy. Rebuild the control-plane image so kin-api-kernel is staged in image-bin." >&2
    exit 1
  fi
  mkdir -p "$ROOT/share/wrap-cli"
  WRAP_CHANGED=0
  if [ -d /opt/vm2api/image-wrap-cli ]; then
    # 首装先整目录落地（glibc239 / SAMPLE.json），再由下面的循环按内容覆盖可执行文件。
    if [ ! -f "$ROOT/share/wrap-cli/cli-node" ]; then
      cp -a /opt/vm2api/image-wrap-cli/. "$ROOT/share/wrap-cli/"
      WRAP_CHANGED=1
    fi
    # cli-node 也随镜像覆盖：只在缺失时复制会让升级用户一直留着旧 ELF（#120 baseline 换不进去）。
    for name in kin-kernel.bin kin-kernel cli-node cc-node; do
      src="/opt/vm2api/image-wrap-cli/$name"
      dest="$ROOT/share/wrap-cli/$name"
      if [ -f "$src" ]; then
        if [ ! -f "$dest" ] || ! cmp -s "$src" "$dest"; then
          WRAP_CHANGED=1
        fi
        cp "$src" "$dest.new"
        chmod 755 "$dest.new"
        mv -f "$dest.new" "$dest"
      fi
    done
  fi
  # The crag kernel no longer comes from a repo checkout; refresh it from the image like the wrap ELFs.
  if [ -f /opt/vm2api/image-crag/kin-kernel ]; then
    mkdir -p "$ROOT/share/crag"
    dest="$ROOT/share/crag/kin-kernel"
    if [ ! -f "$dest" ] || ! cmp -s /opt/vm2api/image-crag/kin-kernel "$dest"; then
      cp /opt/vm2api/image-crag/kin-kernel "$dest.new"
      chmod 755 "$dest.new"
      mv -f "$dest.new" "$dest"
      WRAP_CHANGED=1
    fi
  fi
  # Bind-mounted share starts empty; seed the image's signed native package once.
  node /opt/vm2api/scripts/seed-crag.mjs "$ROOT" /opt/vm2api/image-crag
}

WRAP_CHANGED=0
if [ "$STANDBY" = 0 ]; then
  sync_shared
fi
if [ "$MODE" = sync ]; then
  echo "WRAP_CHANGED=$WRAP_CHANGED"
  exit 0
fi

if [ ! -S /var/run/docker.sock ]; then
  echo "vm2api: /var/run/docker.sock not mounted; slot create/start will fail." >&2
elif [ -f /opt/vm2api/docker/kin-os/build.mjs ]; then
  # 只拉预构建客体镜像；拉不到不阻塞启动，建槽时再兜底构建。
  node /opt/vm2api/docker/kin-os/build.mjs --pull-only ubuntu || true
fi

env_get_file() {
  name="$1"
  file="$2"
  [ -f "$file" ] || return 0
  grep -E "^${name}=" "$file" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d "'" | tr -d '"' | tr -d '\r'
}

env_upsert_if_empty() {
  name="$1"
  value="$2"
  file="$3"
  [ -n "$file" ] || return 0
  if [ -f "$file" ]; then
    current="$(env_get_file "$name" "$file")"
    if [ -n "$current" ]; then
      return 0
    fi
    if grep -qE "^${name}=" "$file"; then
      sed -i "s|^${name}=.*|${name}=${value}|" "$file"
    else
      printf '%s=%s\n' "$name" "$value" >>"$file"
    fi
  fi
}

rand_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    python3 -c 'import secrets; print(secrets.token_hex(32))'
  fi
}

ENVF="${ROOT}/.env"
if [ -z "${VM2API_ADMIN_USER:-}" ]; then
  VM2API_ADMIN_USER=admin
  export VM2API_ADMIN_USER
  env_upsert_if_empty VM2API_ADMIN_USER admin "$ENVF"
fi
if [ -z "${VM2API_ADMIN_PASSWORD:-}" ]; then
  VM2API_ADMIN_PASSWORD=123456
  export VM2API_ADMIN_PASSWORD
  env_upsert_if_empty VM2API_ADMIN_PASSWORD 123456 "$ENVF"
  echo "vm2api: VM2API_ADMIN_PASSWORD was empty; using default admin / 123456 (change after login)." >&2
fi
if [ -z "${VM2API_API_KEY:-}" ] && [ -z "${KIN_API_KEY:-}" ]; then
  VM2API_API_KEY="$(rand_hex)"
  export VM2API_API_KEY
  env_upsert_if_empty VM2API_API_KEY "$VM2API_API_KEY" "$ENVF"
  echo "vm2api: generated VM2API_API_KEY (empty in env)." >&2
fi
if [ -z "${VM2API_DB_SECRET:-}" ] && [ -z "${KIN_DB_SECRET:-}" ]; then
  VM2API_DB_SECRET="$(rand_hex)"
  export VM2API_DB_SECRET
  env_upsert_if_empty VM2API_DB_SECRET "$VM2API_DB_SECRET" "$ENVF"
fi

if [ "$STANDBY" = 0 ]; then
  export VM2API_BOOTSTRAP_LOCK_FD=9 VM2API_BOOTSTRAP_WRAP_CHANGED="$WRAP_CHANGED"
fi
cd /opt/vm2api
exec node src/server.mjs
