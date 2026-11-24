#!/usr/bin/env bash
#
# vm2api 生产级数据库替换 / 切换脚本（SQLite → PostgreSQL + 可选 Redis 缓存）
#
# 安全保证：
#   1. 绝不碰运行中的 kin-* 槽容器、vms/ 槽目录或设备授权文件；只操作控制面与数据库。
#   2. 切换前自动对源 SQLite（含 WAL）与 .env / systemd 配置留存完整备份，永不删除原 kin.db。
#   3. 迁移过程全表流式写入 + 行数/金额/Token 精确校验（--verify）+ 仪表盘聚合预热（--rollup）。
#   4. 任何步骤失败自动回滚控制面与配置，或随时使用 `--rollback` 一键切回 SQLite。
#
# 支持模式：
#   - Docker Compose 部署（默认，内置本地 postgres + redis 或对接外部云 PG/Redis）
#   - 宿主机 systemd 部署（如 /opt/vm2api + vm2api.service，写入 drop-in 20-postgres.conf）
#
# 用法：
#   sudo bash deploy/replace-db-to-pg.sh [选项]
#   sudo bash deploy/replace-db-to-pg.sh --database-url postgresql://user:pass@host:5432/vm2api
#   sudo bash deploy/replace-db-to-pg.sh --rollback
#
set -euo pipefail

if [ -z "${BASH_VERSION:-}" ]; then
  echo "请用 bash 运行本脚本" >&2
  exit 1
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}[PG迁移]${NC} $*"; }
ok() { echo -e "${GREEN}[成功]${NC} $*"; }
warn() { echo -e "${YELLOW}[警告]${NC} $*"; }
err() { echo -e "${RED}[错误]${NC} $*" >&2; }

INSTALL_DIR="${VM2API_DIR:-/opt/vm2api}"
DEPLOY_MODE="auto"        # auto | docker | systemd
SERVICE_NAME="vm2api"
SYSTEMD_UNIT="vm2api.service"
SQLITE_PATH=""
DATABASE_URL_ARG=""
REDIS_URL_ARG=""
PG_HOST="127.0.0.1"
PG_PORT="5432"
PG_USER="vm2api"
PG_DB="vm2api"
PG_PASSWORD=""
REDIS_HOST="127.0.0.1"
REDIS_PORT="6379"
REDIS_PASSWORD=""
EXTERNAL_PG=0
NO_REDIS=0
TRUNCATE_TARGET=0
SKIP_DEBUG=0
SKIP_DISK_CHECK=0
DRY_RUN=0
ASSUME_YES=0
DO_ROLLBACK=0
DO_STATUS=0

usage() {
  cat <<EOF
用法: $(basename "$0") [选项]

作用:
  将现有 vm2api 数据库从 SQLite 平滑替换为 PostgreSQL（并启用 L1 + 可选 Redis L2 缓存）。
  不中断、不删除任何运行中的 kin-* 槽位容器。

模式选项:
  --dir PATH                vm2api 安装目录（默认: ${INSTALL_DIR}）
  --mode auto|docker|systemd 部署方式（默认: auto 自动识别）
  --sqlite PATH             源 SQLite 路径（默认: <dir>/data/kin.db）

数据库/缓存目标:
  --database-url URL        使用外部/云端 PostgreSQL 连接串（自动跳过本地 PG 容器）
  --redis-url URL           使用外部/云端 Redis 连接串（自动跳过本地 Redis 容器）
  --pg-port PORT            本地 PostgreSQL 监听端口（仅 127.0.0.1，默认: 5432）
  --redis-port PORT         本地 Redis 监听端口（仅 127.0.0.1，默认: 6379）
  --no-redis                不启用 Redis L2，仅启用 L1 + PG LISTEN/NOTIFY 缓存

迁移控制:
  --truncate                导入前清空目标 PostgreSQL 表（用于干净重跑）
  --skip-debug              跳过超大 request_log_debug 调试正文表
  --skip-disk-check         跳过剩余磁盘空间检查
  --dry-run                 仅执行预检并打印切换计划，不停止服务、不写数据
  --yes, -y                 非交互模式，自动确认
  --status                  查看当前数据库引擎、容器与迁移状态
  --rollback                一键回滚回原 SQLite 配置并重启控制面
  -h, --help                显示本帮助
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --mode) DEPLOY_MODE="$2"; shift 2 ;;
    --sqlite) SQLITE_PATH="$2"; shift 2 ;;
    --database-url) DATABASE_URL_ARG="$2"; EXTERNAL_PG=1; shift 2 ;;
    --redis-url) REDIS_URL_ARG="$2"; shift 2 ;;
    --pg-port) PG_PORT="$2"; shift 2 ;;
    --redis-port) REDIS_PORT="$2"; shift 2 ;;
    --no-redis) NO_REDIS=1; shift ;;
    --truncate) TRUNCATE_TARGET=1; shift ;;
    --skip-debug) SKIP_DEBUG=1; shift ;;
    --skip-disk-check) SKIP_DISK_CHECK=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --rollback) DO_ROLLBACK=1; shift ;;
    --status) DO_STATUS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) err "未知参数: $1"; usage; exit 1 ;;
  esac
done

ENV_FILE="${INSTALL_DIR}/.env"
SYSTEMD_DROPIN_DIR="${VM2API_SYSTEMD_DROPIN_DIR:-/etc/systemd/system/${SYSTEMD_UNIT}.d}"
SYSTEMD_DROPIN_FILE="${SYSTEMD_DROPIN_DIR}/20-postgres.conf"
BACKUP_ROOT="${INSTALL_DIR}/data/backups"

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import secrets; print(secrets.token_hex(24))'
  else
    head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

env_get() {
  local key="$1" file="${2:-$ENV_FILE}" line
  [ -f "$file" ] || return 0
  line="$(grep -E "^${key}=" "$file" 2>/dev/null | tail -n1 || true)"
  [ -n "$line" ] || return 0
  printf '%s' "$line" | cut -d= -f2- | tr -d "'" | tr -d '"' | tr -d '\r'
}

env_set() {
  local key="$1" val="$2" file="${3:-$ENV_FILE}"
  touch "$file"
  chmod 600 "$file" 2>/dev/null || true
  if grep -qE "^${key}=" "$file" 2>/dev/null; then
    local tmp
    tmp="$(mktemp "${file}.XXXXXX")"
    awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k {print k, v; next} {print}' "$file" >"$tmp"
    mv -f "$tmp" "$file"
  else
    printf '%s=%s\n' "$key" "$val" >>"$file"
  fi
  chmod 600 "$file" 2>/dev/null || true
}

compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    (cd "$INSTALL_DIR" && env -u DOCKER_DEFAULT_PLATFORM docker compose "$@")
  elif command -v docker-compose >/dev/null 2>&1; then
    (cd "$INSTALL_DIR" && env -u DOCKER_DEFAULT_PLATFORM docker-compose "$@")
  else
    err "未检测到 docker compose 或 docker-compose"
    exit 1
  fi
}

detect_mode() {
  if [ "$DEPLOY_MODE" != "auto" ]; then
    echo "$DEPLOY_MODE"
    return
  fi
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files "$SYSTEMD_UNIT" >/dev/null 2>&1 && systemctl is-enabled "$SYSTEMD_UNIT" >/dev/null 2>&1; then
    if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$SERVICE_NAME"; then
      echo "systemd"
      return
    fi
  fi
  if [ -f "${INSTALL_DIR}/docker-compose.yml" ] && command -v docker >/dev/null 2>&1; then
    echo "docker"
    return
  fi
  if command -v systemctl >/dev/null 2>&1 && systemctl cat "$SYSTEMD_UNIT" >/dev/null 2>&1; then
    echo "systemd"
    return
  fi
  echo "docker"
}

resolve_sqlite_path() {
  if [ -n "$SQLITE_PATH" ]; then
    echo "$SQLITE_PATH"
    return
  fi
  local from_env
  from_env="$(env_get KIN_DB_PATH)"
  if [ -n "$from_env" ]; then
    echo "$from_env"
    return
  fi
  echo "${INSTALL_DIR}/data/kin.db"
}

show_status() {
  local mode port driver
  mode="$(detect_mode)"
  port="$(env_get PORT)"
  port="${port:-8787}"
  driver="$(env_get VM2API_DB_DRIVER)"
  echo "安装目录:   ${INSTALL_DIR}"
  echo "部署模式:   ${mode}"
  echo "DB 驱动:    ${driver:-auto}"
  echo "SQLite 文件: $(resolve_sqlite_path) ($([ -f "$(resolve_sqlite_path)" ] && ls -lh "$(resolve_sqlite_path)" | awk '{print $5}' || echo '不存在'))"
  if [ -f "$SYSTEMD_DROPIN_FILE" ]; then
    echo "Systemd PG: ${SYSTEMD_DROPIN_FILE} (已启用)"
  fi
  if command -v docker >/dev/null 2>&1; then
    docker ps -a --filter "name=vm2api" --format "容器:       {{.Names}}  {{.Status}}  {{.Ports}}" 2>/dev/null || true
  fi
  if curl -fsS --noproxy '*' "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
    echo "控制面探活: ok (http://127.0.0.1:${port}/health)"
  else
    echo "控制面探活: down"
  fi
}

do_rollback() {
  local mode latest_env port
  mode="$(detect_mode)"
  info "开始回滚到 SQLite（模式=${mode}，不删除 PostgreSQL 数据以便排障）..."

  if [ "$mode" = "systemd" ]; then
    systemctl stop "$SYSTEMD_UNIT" || true
    if [ -f "$SYSTEMD_DROPIN_FILE" ]; then
      rm -f "$SYSTEMD_DROPIN_FILE"
      ok "已移除 systemd drop-in: ${SYSTEMD_DROPIN_FILE}"
    fi
    systemctl daemon-reload
  else
    compose_cmd stop "$SERVICE_NAME" 2>/dev/null || docker stop "$SERVICE_NAME" 2>/dev/null || true
  fi

  latest_env="$(ls -1t "${BACKUP_ROOT}"/pre-pg-migration-*/.env.bak 2>/dev/null | head -n1 || true)"
  if [ -n "$latest_env" ] && [ -f "$latest_env" ]; then
    cp -f "$latest_env" "$ENV_FILE"
    chmod 600 "$ENV_FILE" || true
    ok "已还原切换前 .env 备份: ${latest_env}"
  fi
  env_set VM2API_DB_DRIVER sqlite

  if [ "$mode" = "systemd" ]; then
    systemctl start "$SYSTEMD_UNIT"
  else
    compose_cmd up -d --no-deps "$SERVICE_NAME"
  fi

  port="$(env_get PORT)"
  port="${port:-8787}"
  for _ in $(seq 1 30); do
    if curl -fsS --noproxy '*' "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      ok "回滚完成，控制面已切回 SQLite 并通过健康检查！"
      exit 0
    fi
    sleep 2
  done
  err "回滚后控制面探活超时，请检查日志"
  exit 1
}

if [ "$DO_STATUS" = 1 ]; then
  show_status
  exit 0
fi

if [ "$DO_ROLLBACK" = 1 ]; then
  do_rollback
  exit 0
fi

MODE="$(detect_mode)"
SRC_SQLITE="$(resolve_sqlite_path)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
MIGRATION_BACKUP_DIR="${BACKUP_ROOT}/pre-pg-migration-${STAMP}"

info "部署模式: ${MODE} | 安装目录: ${INSTALL_DIR}"
info "源 SQLite: ${SRC_SQLITE}"

if [ ! -f "$SRC_SQLITE" ]; then
  err "找不到源 SQLite 文件: ${SRC_SQLITE}"
  exit 1
fi

SRC_SIZE_BYTES="$(stat -c '%s' "$SRC_SQLITE" 2>/dev/null || stat -f '%z' "$SRC_SQLITE" 2>/dev/null || echo 0)"
SRC_SIZE_MB="$((SRC_SIZE_BYTES / 1048576))"
info "源 SQLite 大小: ${SRC_SIZE_MB} MiB"

if [ "$SKIP_DISK_CHECK" = 0 ]; then
  DISK_CHECK_DIR="${INSTALL_DIR}/data"
  [ -d "$DISK_CHECK_DIR" ] || DISK_CHECK_DIR="${INSTALL_DIR}"
  [ -d "$DISK_CHECK_DIR" ] || DISK_CHECK_DIR="$(dirname "$SRC_SQLITE")"
  AVAIL_KB="$(df -Pk "$DISK_CHECK_DIR" 2>/dev/null | awk 'NR==2{print $4}' || echo 0)"
  AVAIL_MB="$((AVAIL_KB / 1024))"
  NEED_MB="$((SRC_SIZE_MB * 2 + 512))"
  if [ "$EXTERNAL_PG" = 1 ]; then
    NEED_MB="$((SRC_SIZE_MB + 256))"
  fi
  info "目标磁盘可用空间: ${AVAIL_MB} MiB（建议至少 ${NEED_MB} MiB）"
  if [ "$AVAIL_MB" -lt "$NEED_MB" ]; then
    err "磁盘空间不足（剩余 ${AVAIL_MB} MiB < 建议 ${NEED_MB} MiB）。清理空间或传 --skip-disk-check 强制继续。"
    exit 1
  fi
fi

# Resolve PostgreSQL target credentials & DSN
if [ "$EXTERNAL_PG" = 1 ]; then
  TARGET_DSN="$DATABASE_URL_ARG"
  info "目标 PostgreSQL: 外部/云端数据库（跳过本地 PG 容器）"
else
  PG_PORT="${PG_PORT:-$(env_get VM2API_PG_PORT)}"
  PG_PORT="${PG_PORT:-5432}"
  PG_USER="$(env_get POSTGRES_USER)"
  PG_USER="${PG_USER:-vm2api}"
  PG_DB="$(env_get POSTGRES_DB)"
  PG_DB="${PG_DB:-vm2api}"
  PG_PASSWORD="$(env_get POSTGRES_PASSWORD)"
  if [ -z "$PG_PASSWORD" ]; then
    PG_PASSWORD="$(gen_secret)"
  fi
  TARGET_DSN="postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DB}?sslmode=disable"
  info "目标 PostgreSQL: 本地容器 127.0.0.1:${PG_PORT}/${PG_DB}"
fi

if [ "$NO_REDIS" = 1 ]; then
  TARGET_REDIS_URL=""
  info "目标缓存: L1 + PostgreSQL LISTEN/NOTIFY（已禁用 Redis）"
elif [ -n "$REDIS_URL_ARG" ]; then
  TARGET_REDIS_URL="$REDIS_URL_ARG"
  info "目标缓存: L1 + 外部 Redis"
else
  REDIS_PORT="${REDIS_PORT:-$(env_get VM2API_REDIS_PORT)}"
  REDIS_PORT="${REDIS_PORT:-6379}"
  REDIS_PASSWORD="$(env_get REDIS_PASSWORD)"
  if [ -z "$REDIS_PASSWORD" ]; then
    REDIS_PASSWORD="$(gen_secret)"
  fi
  TARGET_REDIS_URL="redis://:${REDIS_PASSWORD}@127.0.0.1:${REDIS_PORT}/0"
  info "目标缓存: L1 + 本地 Redis 容器 127.0.0.1:${REDIS_PORT}"
fi

if [ "$DRY_RUN" = 1 ]; then
  echo ""
  ok "[DRY-RUN] 预检全部通过！拟执行步骤："
  echo "  1. 备份 ${SRC_SQLITE} 及 .env 到 ${MIGRATION_BACKUP_DIR}"
  echo "  2. 启动/验证 PostgreSQL${NO_REDIS:+（无 Redis）}"
  echo "  3. 仅停止控制面（${MODE}），保持全部 kin-* 槽位运行"
  echo "  4. 流式迁移全部表并执行 --verify + --rollup"
  echo "  5. 切换配置为 VM2API_DB_DRIVER=postgres 并启动控制面验证 /health 与 /api/panel/database/metrics"
  exit 0
fi

if [ "$ASSUME_YES" != 1 ] && [ -e /dev/tty ]; then
  echo ""
  warn "即将短暂停机控制面以完成一致性数据迁移（运行中的 kin-* 槽位不受影响）。"
  printf "确认继续切换至 PostgreSQL？[y/N] " >/dev/tty
  read -r ans </dev/tty || true
  case "$ans" in
    y|Y|yes|YES) ;;
    *) info "已取消"; exit 0 ;;
  esac
fi

mkdir -p "$MIGRATION_BACKUP_DIR"
chmod 700 "$MIGRATION_BACKUP_DIR" || true

# Persist PG/Redis credentials into .env BEFORE starting compose postgres/redis
if [ -f "$ENV_FILE" ]; then
  cp -f "$ENV_FILE" "${MIGRATION_BACKUP_DIR}/.env.bak"
  chmod 600 "${MIGRATION_BACKUP_DIR}/.env.bak" || true
fi
if [ "$EXTERNAL_PG" = 0 ]; then
  env_set POSTGRES_USER "$PG_USER"
  env_set POSTGRES_PASSWORD "$PG_PASSWORD"
  env_set POSTGRES_DB "$PG_DB"
  env_set VM2API_PG_PORT "$PG_PORT"
fi
if [ "$NO_REDIS" = 0 ] && [ -z "$REDIS_URL_ARG" ]; then
  env_set REDIS_PASSWORD "$REDIS_PASSWORD"
  env_set VM2API_REDIS_PORT "$REDIS_PORT"
fi

# Start local PostgreSQL (+ optional Redis) container if not external
start_local_pg_redis() {
  if [ "$EXTERNAL_PG" = 0 ]; then
    info "启动本地 PostgreSQL 容器..."
    if [ -f "${INSTALL_DIR}/docker-compose.yml" ] && grep -qE '^\s+postgres:' "${INSTALL_DIR}/docker-compose.yml"; then
      compose_cmd up -d postgres
    else
      if ! docker ps -a --format '{{.Names}}' | grep -qx 'vm2api-postgres'; then
        mkdir -p "${INSTALL_DIR}/data/postgres"
        docker run -d --name vm2api-postgres --restart unless-stopped \
          -e POSTGRES_USER="$PG_USER" \
          -e POSTGRES_PASSWORD="$PG_PASSWORD" \
          -e POSTGRES_DB="$PG_DB" \
          -e PGDATA=/var/lib/postgresql/data \
          -p "127.0.0.1:${PG_PORT}:5432" \
          -v "${INSTALL_DIR}/data/postgres:/var/lib/postgresql/data" \
          postgres:18-alpine \
          -c max_connections=200 -c shared_buffers=256MB
      else
        docker start vm2api-postgres >/dev/null
      fi
    fi

    info "等待 PostgreSQL 就绪..."
    local pg_cid
    pg_cid="$(docker ps -q --filter "name=postgres" | head -n1 || true)"
    for _ in $(seq 1 45); do
      if [ -n "$pg_cid" ] && docker exec "$pg_cid" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
        ok "PostgreSQL 已就绪"
        break
      fi
      sleep 2
    done
  fi

  if [ "$NO_REDIS" = 0 ] && [ -z "$REDIS_URL_ARG" ]; then
    info "启动本地 Redis 容器..."
    if [ -f "${INSTALL_DIR}/docker-compose.yml" ] && grep -qE '^\s+redis:' "${INSTALL_DIR}/docker-compose.yml"; then
      compose_cmd up -d redis
    else
      if ! docker ps -a --format '{{.Names}}' | grep -qx 'vm2api-redis'; then
        mkdir -p "${INSTALL_DIR}/data/redis"
        docker run -d --name vm2api-redis --restart unless-stopped \
          -p "127.0.0.1:${REDIS_PORT}:6379" \
          -v "${INSTALL_DIR}/data/redis:/data" \
          redis:8-alpine redis-server --appendonly yes --requirepass "$REDIS_PASSWORD"
      else
        docker start vm2api-redis >/dev/null
      fi
    fi
  fi
}

start_local_pg_redis

# Stop control plane cleanly so SQLite WAL flushes with zero concurrent writers
info "停止 vm2api 控制面（保留全部 kin-* 槽位继续运行）..."
if [ "$MODE" = "systemd" ]; then
  systemctl stop "$SYSTEMD_UNIT"
else
  compose_cmd stop "$SERVICE_NAME" 2>/dev/null || docker stop "$SERVICE_NAME" 2>/dev/null || true
fi

# Rollback trap if migration or restart fails
MIGRATION_COMMITTED=0
cleanup_on_failure() {
  if [ "$MIGRATION_COMMITTED" = 1 ]; then
    return
  fi
  err "迁移未完成，正在自动恢复原 SQLite 配置与控制面..."
  if [ -f "${MIGRATION_BACKUP_DIR}/.env.bak" ]; then
    cp -f "${MIGRATION_BACKUP_DIR}/.env.bak" "$ENV_FILE"
    chmod 600 "$ENV_FILE" || true
  fi
  if [ "$MODE" = "systemd" ]; then
    rm -f "$SYSTEMD_DROPIN_FILE" 2>/dev/null || true
    systemctl daemon-reload || true
    systemctl start "$SYSTEMD_UNIT" || true
  else
    if [ "$EXTERNAL_PG" = 1 ]; then
    compose_cmd up -d --no-deps "$SERVICE_NAME"
  else
    compose_cmd up -d "$SERVICE_NAME"
  fi || true
  fi
}
trap cleanup_on_failure ERR

# Consistent SQLite backup snapshot (copy db + wal + shm)
info "备份原 SQLite 数据库到 ${MIGRATION_BACKUP_DIR}/ ..."
cp -a "$SRC_SQLITE" "${MIGRATION_BACKUP_DIR}/kin.db"
[ -f "${SRC_SQLITE}-wal" ] && cp -a "${SRC_SQLITE}-wal" "${MIGRATION_BACKUP_DIR}/kin.db-wal" || true
[ -f "${SRC_SQLITE}-shm" ] && cp -a "${SRC_SQLITE}-shm" "${MIGRATION_BACKUP_DIR}/kin.db-shm" || true
chmod 600 "${MIGRATION_BACKUP_DIR}/kin.db"* 2>/dev/null || true
ok "原 SQLite 备份完成"

# Run Node migrator (prefer host node if repo scripts + node_modules exist; else run inside vm2api image)
MIGRATE_FLAGS=(--verify --rollup)
[ "$TRUNCATE_TARGET" = 1 ] && MIGRATE_FLAGS+=(--truncate)
[ "$SKIP_DEBUG" = 1 ] && MIGRATE_FLAGS+=(--skip-debug)

info "执行流式全量迁移与校验..."
if command -v node >/dev/null 2>&1 && [ -f "${INSTALL_DIR}/scripts/migrate-sqlite-to-pg.mjs" ] && [ -d "${INSTALL_DIR}/node_modules/pg" ]; then
  node "${INSTALL_DIR}/scripts/migrate-sqlite-to-pg.mjs" \
    --sqlite "$SRC_SQLITE" \
    --pg-url "$TARGET_DSN" \
    "${MIGRATE_FLAGS[@]}"
else
  # Image-only Docker install: run migrator using the vm2api container image (network_mode: host)
  compose_cmd run --rm --no-deps --entrypoint node "$SERVICE_NAME" \
    /opt/vm2api/scripts/migrate-sqlite-to-pg.mjs \
    --sqlite /opt/vm2api/data/kin.db \
    --pg-url "$TARGET_DSN" \
    "${MIGRATE_FLAGS[@]}"
fi
ok "数据迁移与一致性校验通过（0 差异）"

# Switch config atomically to PostgreSQL
info "更新运行配置为 PostgreSQL..."
env_set VM2API_DB_DRIVER postgres
env_set DATABASE_URL "$TARGET_DSN"
if [ -n "$TARGET_REDIS_URL" ]; then
  env_set REDIS_URL "$TARGET_REDIS_URL"
  env_set VM2API_REDIS_DISABLED 0
else
  env_set VM2API_REDIS_DISABLED 1
fi

if [ "$MODE" = "systemd" ]; then
  mkdir -p "$SYSTEMD_DROPIN_DIR"
  {
    printf '# Managed by deploy/replace-db-to-pg.sh (%s)\n' "$STAMP"
    printf '[Service]\n'
    printf 'Environment=VM2API_DB_DRIVER=postgres\n'
    printf 'Environment=DATABASE_URL=%s\n' "$TARGET_DSN"
    if [ -n "$TARGET_REDIS_URL" ]; then
      printf 'Environment=REDIS_URL=%s\n' "$TARGET_REDIS_URL"
      printf 'Environment=VM2API_REDIS_DISABLED=0\n'
    else
      printf 'Environment=VM2API_REDIS_DISABLED=1\n'
    fi
  } >"$SYSTEMD_DROPIN_FILE"
  chmod 600 "$SYSTEMD_DROPIN_FILE"
  systemctl daemon-reload
  systemctl start "$SYSTEMD_UNIT"
else
  if [ "$EXTERNAL_PG" = 1 ]; then
    compose_cmd up -d --no-deps "$SERVICE_NAME"
  else
    compose_cmd up -d "$SERVICE_NAME"
  fi
fi

# Verify live health + PostgreSQL engine metrics
PORT_VAL="$(env_get PORT)"
PORT_VAL="${PORT_VAL:-8787}"
info "等待控制面就绪 (http://127.0.0.1:${PORT_VAL}/health)..."
HEALTH_OK=0
for _ in $(seq 1 45); do
  if curl -fsS --noproxy '*' "http://127.0.0.1:${PORT_VAL}/health" >/dev/null 2>&1; then
    HEALTH_OK=1
    break
  fi
  sleep 2
done
if [ "$HEALTH_OK" != 1 ]; then
  err "控制面健康检查超时"
  false
fi

API_KEY_VAL="$(env_get VM2API_API_KEY)"
API_KEY_VAL="${API_KEY_VAL:-$(env_get KIN_API_KEY)}"
if [ -n "$API_KEY_VAL" ] && command -v python3 >/dev/null 2>&1; then
  METRICS_JSON="$(curl -fsS --noproxy '*' -H "Authorization: Bearer ${API_KEY_VAL}" "http://127.0.0.1:${PORT_VAL}/api/panel/database/metrics" 2>/dev/null || true)"
  if [ -n "$METRICS_JSON" ]; then
    printf '%s' "$METRICS_JSON" | python3 -c '
import json, sys
d = json.load(sys.stdin).get("data") or {}
db = d.get("database") or {}
cache = d.get("cache") or {}
print("已验证运行引擎: engine=%s ok=%s pg_version=%s cache_mode=%s" % (db.get("engine"), db.get("ok"), db.get("pg_version"), cache.get("mode")))
if db.get("engine") != "postgres" or not db.get("ok"):
    raise SystemExit(1)
'
  fi
fi

MIGRATION_COMMITTED=1
trap - ERR
echo ""
ok "PostgreSQL 替换切换全部完成！"
info "原 SQLite 备份保留在: ${MIGRATION_BACKUP_DIR}/"
info "如需回滚到 SQLite:   sudo bash ${INSTALL_DIR}/deploy/replace-db-to-pg.sh --rollback"
