#!/usr/bin/env bash
#
# vm2api PostgreSQL 版一键安装 / 无缝升级迁移入口
#
# 自动识别当前环境（SSOT：全部逻辑复用 deploy/install.sh 与 deploy/replace-db-to-pg.sh）：
#   1. 全新服务器：自动补装依赖（Docker / Compose / postgresql-client 等）并部署 PostgreSQL 18 + Redis 8 + vm2api。
#   2. 存量 SQLite Docker 部署（检测到 <dir>/data/kin.db 且尚未切到 PostgreSQL）：
#      自动升级控制面 → 补齐 PG/客户端依赖 → 无缝流式迁移校验 → 原子切至 PostgreSQL（不碰运行中的 kin-* 槽位）。
#   3. 存量 SQLite systemd 宿主机部署（无 docker-compose.yml）：
#      自动校验/补装 Node 依赖（pg / ioredis）与 PG 运行时（Docker 或原生 postgresql）并完成无缝切换。
#   4. 已在 PostgreSQL 运行的部署：升级控制面与镜像并保持现有数据库配置。
#
# 用法：
#   curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install-pg.sh | sudo bash
#   curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install-pg.sh | sudo bash -s -- --database-url "postgresql://..."
#   curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install-pg.sh | sudo bash -s -- --dry-run
#   sudo bash /opt/vm2api/deploy/install-pg.sh --rollback
#
set -euo pipefail

if [ -z "${BASH_VERSION:-}" ]; then
  echo "请用 bash 运行本脚本" >&2
  exit 1
fi

GITHUB_REPO="${VM2API_GITHUB_REPO:-dofastted/vm2api}"
INSTALL_DIR="${VM2API_DIR:-/opt/vm2api}"
ACTION="auto"
PASS_ARGS=()

usage() {
  cat <<EOF
用法: $(basename "$0") [选项]

作用:
  vm2api PostgreSQL 版一键安装与存量 SQLite 无缝迁移入口。
  自动检查并安装缺失的 Docker / Compose / postgresql-client / Node(pg,ioredis) 依赖。

常用选项:
  --dir PATH                 安装目录（默认: ${INSTALL_DIR}）
  --database-url URL         使用外部/云端 PostgreSQL（跳过本地 PG 容器）
  --redis-url URL            使用外部/云端 Redis（跳过本地 Redis 容器）
  --no-redis                 仅使用 L1 + PG LISTEN/NOTIFY，不部署 Redis
  --pg-port PORT             本地 PostgreSQL 端口（默认 5432，冲突自动顺延）
  --redis-port PORT          本地 Redis 端口（默认 6379，冲突自动顺延）
  --local-data               使用宿主机目录持久化 PG/Redis（docker-compose.local.yml）
  --pg-data-dir DIR          指定本地 PG 数据目录
  --redis-data-dir DIR       指定本地 Redis 数据目录
  --pg-runtime auto|docker|native  systemd 宿主机模式指定本地 PG 运行方式
  --no-install-deps          禁用自动安装系统/Node 依赖，仅检查
  --check-deps               仅执行依赖与环境预检，不做任何变更
  --preflight                零停机 SQLite 表结构/约束隐患预扫与目标库权限检测
  --dry-run                  存量迁移预检（不停止服务、不写数据）
  --status                   查看当前数据库引擎、依赖与容器状态
  --rollback                 一键回滚回原 SQLite 配置并重启控制面
  --yes, -y                  非交互模式自动确认
  -h, --help                 显示本帮助
EOF
}

idx=1
while [ $idx -le $# ]; do
  arg="${!idx}"
  case "$arg" in
    -h|--help)
      usage
      exit 0
      ;;
    --dir)
      next=$((idx + 1))
      if [ $next -le $# ]; then
        INSTALL_DIR="${!next}"
        PASS_ARGS+=("$arg" "${!next}")
        idx=$((idx + 2))
        continue
      fi
      ;;
    --rollback)
      ACTION="db-rollback"
      idx=$((idx + 1))
      continue
      ;;
    --status)
      ACTION="db-status"
      idx=$((idx + 1))
      continue
      ;;
    --dry-run|--check-deps|--preflight|--pg-runtime|--sqlite|--truncate|--skip-debug|--skip-disk-check|--mode|--auto-pull)
      ACTION="db-migrate"
      ;;
  esac
  PASS_ARGS+=("$arg")
  idx=$((idx + 1))
done

SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

INSTALLER=""
TMP_INSTALLER=""
if [ -n "$SCRIPT_DIR" ] && [ -f "${SCRIPT_DIR}/install.sh" ]; then
  INSTALLER="${SCRIPT_DIR}/install.sh"
elif [ -f "${INSTALL_DIR}/deploy/install.sh" ] && [ "$ACTION" != "auto" ] && grep -q 'url_points_to_local_host' "${INSTALL_DIR}/deploy/install.sh" 2>/dev/null; then
  INSTALLER="${INSTALL_DIR}/deploy/install.sh"
else
  TMP_INSTALLER="$(mktemp)"
  trap 'rm -f "$TMP_INSTALLER"' EXIT
  url="https://raw.githubusercontent.com/${GITHUB_REPO}/main/deploy/install.sh"
  curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 60 "$url" -o "$TMP_INSTALLER"
  INSTALLER="$TMP_INSTALLER"
fi

if [ "$ACTION" = "db-rollback" ]; then
  exec bash "$INSTALLER" db-rollback --dir "$INSTALL_DIR"
elif [ "$ACTION" = "db-status" ]; then
  exec bash "$INSTALLER" db-status --dir "$INSTALL_DIR"
elif [ "$ACTION" = "db-migrate" ]; then
  exec bash "$INSTALLER" db-migrate "${PASS_ARGS[@]}"
fi

SYSTEMD_UNIT="${VM2API_SYSTEMD_UNIT:-vm2api.service}"
SYSTEMD_DROPIN_DIR="${VM2API_SYSTEMD_DROPIN_DIR:-/etc/systemd/system/${SYSTEMD_UNIT}.d}"

is_systemd_host() {
  # Blue/green Docker hosts take precedence over systemd detection.
  if [ -f "${INSTALL_DIR}/bluegreen/active" ]; then
    return 1
  fi
  command -v systemctl >/dev/null 2>&1 || return 1
  if systemctl is-active --quiet "$SYSTEMD_UNIT" 2>/dev/null || systemctl is-enabled --quiet "$SYSTEMD_UNIT" 2>/dev/null; then
    if ! command -v docker >/dev/null 2>&1 || ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'vm2api'; then
      return 0
    fi
  fi
  return 1
}

read_env_driver() {
  local f val=""
  for f in "${INSTALL_DIR}/.env" "${INSTALL_DIR}/.env.postgres" "${SYSTEMD_DROPIN_DIR}/20-postgres.conf"; do
    [ -f "$f" ] || continue
    local line
    line="$(grep -E '^(Environment=)?VM2API_DB_DRIVER=' "$f" 2>/dev/null | tail -n1 || true)"
    if [ -n "$line" ]; then
      val="$(printf '%s' "$line" | sed -E 's/^Environment=//' | cut -d= -f2- | tr -d "'" | tr -d '"' | tr -d '\r')"
    fi
  done
  printf '%s' "$val"
}

# Auto-detect fresh PG install vs existing SQLite systemd/Docker migration vs existing PG upgrade
env_driver="$(read_env_driver)"

if [ -f "${INSTALL_DIR}/data/kin.db" ] && [ "$env_driver" != "postgres" ]; then
  if is_systemd_host; then
    exec bash "$INSTALLER" db-migrate "${PASS_ARGS[@]}"
  elif [ -f "${INSTALL_DIR}/docker-compose.yml" ]; then
    exec bash "$INSTALLER" upgrade --auto-migrate "${PASS_ARGS[@]}"
  else
    exec bash "$INSTALLER" db-migrate "${PASS_ARGS[@]}"
  fi
elif is_systemd_host; then
  exec bash "$INSTALLER" db-status --dir "$INSTALL_DIR"
elif [ -f "${INSTALL_DIR}/docker-compose.yml" ]; then
  exec bash "$INSTALLER" upgrade --db postgres "${PASS_ARGS[@]}"
else
  exec bash "$INSTALLER" install --db postgres "${PASS_ARGS[@]}"
fi
