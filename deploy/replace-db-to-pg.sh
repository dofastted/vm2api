#!/usr/bin/env bash
#
# vm2api 生产级数据库替换 / 切换脚本（SQLite → PostgreSQL + 可选 Redis 缓存）
#
# 安全保证：
#   1. 绝不碰运行中的 kin-* 槽容器、vms/ 槽目录或设备授权文件；只操作控制面与数据库。
#   2. 停服前完成全部依赖检查/补装、端口冲突检测、目标库连通性探针、迁移镜像/Node依赖校验，
#      任何前置条件不满足都在零停机状态下中止。
#   3. 切换前自动执行 SQLite WAL checkpoint 并留存完整备份（含 .env / systemd 配置），永不删除原 kin.db。
#   4. 迁移过程全表流式写入 + 行数/金额/Token 精确校验（--verify）+ 仪表盘聚合预热（--rollup）。
#   5. 任何步骤失败自动回滚控制面与配置，或随时使用 `--rollback` 一键切回 SQLite。
#
# 支持模式：
#   - Docker Compose 部署（默认，内置本地 postgres:18-alpine + redis:8-alpine 或对接外部云 PG/Redis）
#   - 蓝绿 Docker 部署（自动识别 bluegreen/active）
#   - 宿主机 systemd 部署（如 /opt/vm2api + vm2api.service，写入 drop-in 20-postgres.conf；
#     自动校验/补装 Node 依赖 pg/ioredis，并支持本地 Docker PG 或宿主机原生 postgresql/redis-server）
#
# 用法：
#   sudo bash deploy/replace-db-to-pg.sh [选项]
#   sudo bash deploy/replace-db-to-pg.sh --check-deps
#   sudo bash deploy/replace-db-to-pg.sh --dry-run
#   sudo bash deploy/replace-db-to-pg.sh --database-url postgresql://user:pass@host:5432/vm2api?sslmode=require
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

GITHUB_REPO="${VM2API_GITHUB_REPO:-dofastted/vm2api}"
INSTALL_DIR="${VM2API_DIR:-/opt/vm2api}"
DEPLOY_MODE="auto"        # auto | docker | systemd
PG_RUNTIME="auto"         # auto | docker | native
SERVICE_NAME="vm2api"
SYSTEMD_UNIT="${VM2API_SYSTEMD_UNIT:-vm2api.service}"
SQLITE_PATH=""
DATABASE_URL_ARG=""
REDIS_URL_ARG=""
PG_HOST="127.0.0.1"
PG_PORT=""
PG_PORT_EXPLICIT=0
PG_USER=""
PG_DB=""
PG_PASSWORD=""
REDIS_HOST="127.0.0.1"
REDIS_PORT=""
REDIS_PORT_EXPLICIT=0
REDIS_PASSWORD=""
LOCAL_DATA=0
PG_DATA_DIR_ARG=""
REDIS_DATA_DIR_ARG=""
EXTERNAL_PG=0
NO_REDIS=0
AUTO_INSTALL_DEPS=1
CHECK_DEPS_ONLY=0
PREFLIGHT_ONLY=0
AUTO_PULL=0
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
  停服前自动补齐缺失的 PG/Node/客户端依赖并验证目标库连通性；不中断任何运行中的 kin-* 槽位容器。

模式选项:
  --dir PATH                 vm2api 安装目录（默认: ${INSTALL_DIR}）
  --mode auto|docker|systemd 部署方式（默认: auto 自动识别）
  --pg-runtime auto|docker|native 本地 PG/Redis 运行方式（默认: auto；无 Docker 的 systemd 宿主自动选 native）
  --sqlite PATH              源 SQLite 路径（默认: <dir>/data/kin.db）

数据库/缓存目标:
  --database-url URL         使用外部/云端 PostgreSQL 连接串（自动跳过本地 PG）
  --redis-url URL            使用外部/云端 Redis 连接串（自动跳过本地 Redis）
  --pg-port PORT             本地 PostgreSQL 监听端口（仅 127.0.0.1，默认: 5432，冲突自动顺延）
  --redis-port PORT          本地 Redis 监听端口（仅 127.0.0.1，默认: 6379，冲突自动顺延）
  --local-data               使用宿主机目录挂载 PG/Redis 数据（启用 docker-compose.local.yml）
  --pg-data-dir PATH         指定本地 PG 数据目录（隐含 --local-data）
  --redis-data-dir PATH      指定本地 Redis 数据目录（隐含 --local-data）
  --no-redis                 不启用 Redis L2，仅启用 L1 + PG LISTEN/NOTIFY 缓存

依赖与迁移控制:
  --install-deps             自动安装缺失的宿主/PG/Node 依赖（默认开启）
  --no-install-deps          禁用自动安装依赖，缺失时仅报错提示
  --check-deps               仅检查依赖与环境就绪情况，不修改配置、不停止服务
  --preflight                零停机 SQLite 完整性/表结构/约束隐患预扫与目标库权限检测
  --auto-pull                Docker 模式下若镜像版本过旧缺少迁移脚本，自动执行 compose pull
  --truncate                 导入前清空目标 PostgreSQL 表（用于干净重跑）
  --skip-debug               跳过超大 request_log_debug 调试正文表
  --skip-disk-check          跳过剩余磁盘空间检查
  --dry-run                  仅执行全量预检并打印切换计划，不停止服务、不写数据
  --yes, -y                  非交互模式，自动确认
  --status                   查看当前数据库引擎、容器与迁移状态
  --rollback                 一键回滚回原 SQLite 配置并重启控制面
  -h, --help                 显示本帮助
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --mode) DEPLOY_MODE="$2"; shift 2 ;;
    --pg-runtime) PG_RUNTIME="$2"; shift 2 ;;
    --sqlite) SQLITE_PATH="$2"; shift 2 ;;
    --database-url) DATABASE_URL_ARG="$2"; EXTERNAL_PG=1; shift 2 ;;
    --redis-url) REDIS_URL_ARG="$2"; shift 2 ;;
    --pg-port) PG_PORT="$2"; PG_PORT_EXPLICIT=1; shift 2 ;;
    --redis-port) REDIS_PORT="$2"; REDIS_PORT_EXPLICIT=1; shift 2 ;;
    --local-data) LOCAL_DATA=1; shift ;;
    --pg-data-dir) PG_DATA_DIR_ARG="$2"; LOCAL_DATA=1; shift 2 ;;
    --redis-data-dir) REDIS_DATA_DIR_ARG="$2"; LOCAL_DATA=1; shift 2 ;;
    --no-redis) NO_REDIS=1; shift ;;
    --install-deps) AUTO_INSTALL_DEPS=1; shift ;;
    --no-install-deps) AUTO_INSTALL_DEPS=0; shift ;;
    --check-deps) CHECK_DEPS_ONLY=1; shift ;;
    --preflight) PREFLIGHT_ONLY=1; shift ;;
    --auto-pull) AUTO_PULL=1; shift ;;
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

case "$DEPLOY_MODE" in
  auto|docker|systemd) ;;
  *) err "无效 --mode: ${DEPLOY_MODE}（仅支持 auto | docker | systemd）"; exit 1 ;;
esac

case "$PG_RUNTIME" in
  auto|docker|native) ;;
  *) err "无效 --pg-runtime: ${PG_RUNTIME}（仅支持 auto | docker | native）"; exit 1 ;;
esac

ENV_FILE="${INSTALL_DIR}/.env"
SYSTEMD_PG_ENV_FILE="${INSTALL_DIR}/.env.postgres"
SYSTEMD_DROPIN_DIR="${VM2API_SYSTEMD_DROPIN_DIR:-/etc/systemd/system/${SYSTEMD_UNIT}.d}"
SYSTEMD_DROPIN_FILE="${SYSTEMD_DROPIN_DIR}/20-postgres.conf"
BACKUP_ROOT="${INSTALL_DIR}/data/backups"
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

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

# Read an effective environment key from systemd unit + drop-ins (e.g. strangler.conf PORT=8788,
# KIN_API_KEY, KIN_DB_PATH) so systemd/overlay hosts do not depend on stale values in .env.
systemd_env_get() {
  local key="$1"
  command -v systemctl >/dev/null 2>&1 || return 0
  local env_line env_files_line
  env_line="$(systemctl show "$SYSTEMD_UNIT" --property=Environment --value 2>/dev/null || true)"
  env_files_line="$(systemctl show "$SYSTEMD_UNIT" --property=EnvironmentFiles --value 2>/dev/null || true)"
  if [ -z "$env_line" ] && [ -z "$env_files_line" ]; then
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    _SD_KEY="$key" _SD_ENV="$env_line" _SD_FILES="$env_files_line" python3 - <<'PY' 2>/dev/null || true
import os, re, shlex
target = os.environ["_SD_KEY"]
found = None
# EnvironmentFiles are applied before unit Environment= or in drop-in order; load files first.
for m in re.finditer(r"(\S+)\s+\(ignore_errors=", os.environ.get("_SD_FILES", "")):
    fp = m.group(1).lstrip("-")
    if not os.path.isfile(fp):
        continue
    try:
        with open(fp, encoding="utf-8", errors="ignore") as f:
            for raw in f:
                s = raw.strip()
                if not s or s.startswith("#") or "=" not in s:
                    continue
                k, v = s.split("=", 1)
                if k.strip() == target:
                    found = v.strip().strip("'\"")
    except OSError:
        pass
try:
    tokens = shlex.split(os.environ.get("_SD_ENV", ""))
except ValueError:
    tokens = os.environ.get("_SD_ENV", "").split()
for tok in tokens:
    if "=" in tok:
        k, v = tok.split("=", 1)
        if k == target:
            found = v
if found is not None:
    print(found, end="")
PY
    return 0
  fi
  local tok
  for tok in $env_line; do
    case "$tok" in
      "${key}="*) printf '%s' "${tok#*=}" ;;
    esac
  done
}

effective_env_get() {
  local key="$1" mode="${2:-}" val=""
  if [ "$mode" = "systemd" ]; then
    val="$(systemd_env_get "$key")"
    if [ -n "$val" ]; then
      printf '%s' "$val"
      return 0
    fi
    val="$(env_get "$key" "$SYSTEMD_PG_ENV_FILE")"
    if [ -n "$val" ]; then
      printf '%s' "$val"
      return 0
    fi
  fi
  env_get "$key" "$ENV_FILE"
}

resolve_control_plane_port() {
  local mode="${1:-}" port=""
  port="$(effective_env_get PORT "$mode")"
  printf '%s' "${port:-8787}"
}

resolve_api_key() {
  local mode="${1:-}" key=""
  if [ "$mode" = "systemd" ]; then
    # Prefer live systemd unit/drop-in keys before falling back to a possibly stale .env file.
    key="$(systemd_env_get VM2API_API_KEY)"
    if [ -z "$key" ]; then
      key="$(systemd_env_get KIN_API_KEY)"
    fi
    if [ -z "$key" ]; then
      key="$(env_get VM2API_API_KEY "$SYSTEMD_PG_ENV_FILE")"
    fi
    if [ -z "$key" ]; then
      key="$(env_get KIN_API_KEY "$SYSTEMD_PG_ENV_FILE")"
    fi
  fi
  if [ -z "$key" ]; then
    key="$(env_get VM2API_API_KEY "$ENV_FILE")"
  fi
  if [ -z "$key" ]; then
    key="$(env_get KIN_API_KEY "$ENV_FILE")"
  fi
  printf '%s' "$key"
}

# Literal, injection-safe env upsert (preserves &, |, ?, = in DATABASE_URL / REDIS_URL).
env_set() {
  local key="$1" val="$2" file="${3:-$ENV_FILE}" tmp
  touch "$file"
  chmod 600 "$file" 2>/dev/null || true
  tmp="$(mktemp "${file}.XXXXXX")"
  _VM2API_ENV_KEY="$key" _VM2API_ENV_VAL="$val" awk '
    BEGIN { key = ENVIRON["_VM2API_ENV_KEY"]; val = ENVIRON["_VM2API_ENV_VAL"]; done = 0 }
    {
      idx = index($0, "=")
      if (idx > 0 && substr($0, 1, idx - 1) == key) {
        print key "=" val
        done = 1
        next
      }
      print
    }
    END { if (!done) print key "=" val }
  ' "$file" >"$tmp"
  mv -f "$tmp" "$file"
  chmod 600 "$file" 2>/dev/null || true
}

ensure_compose_file_includes() {
  local extra="$1" cur
  [ -f "${INSTALL_DIR}/${extra}" ] || return 0
  cur="$(env_get COMPOSE_FILE)"
  if [ -z "$cur" ]; then
    env_set COMPOSE_FILE "docker-compose.yml:${extra}"
  elif ! printf ':%s:' "$cur" | grep -Fq ":${extra}:"; then
    env_set COMPOSE_FILE "${cur}:${extra}"
  fi
}

has_docker_compose() {
  command -v docker >/dev/null 2>&1 && { docker compose version >/dev/null 2>&1 || command -v docker-compose >/dev/null 2>&1; }
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

compose_has_service() {
  local svc="$1"
  [ -f "${INSTALL_DIR}/docker-compose.yml" ] && grep -qE "^[[:space:]]+${svc}:" "${INSTALL_DIR}/docker-compose.yml"
}

detect_pkg_mgr() {
  if command -v apt-get >/dev/null 2>&1; then
    echo "apt"
  elif command -v dnf >/dev/null 2>&1; then
    echo "dnf"
  elif command -v yum >/dev/null 2>&1; then
    echo "yum"
  elif command -v apk >/dev/null 2>&1; then
    echo "apk"
  else
    echo ""
  fi
}

APT_UPDATED=0
install_os_pkgs() {
  local mgr
  mgr="$(detect_pkg_mgr)"
  if [ $# -eq 0 ]; then
    return 0
  fi
  if [ "$AUTO_INSTALL_DEPS" != 1 ]; then
    err "缺少系统依赖软件包: $*（已启用 --no-install-deps，请手动安装后重试）"
    return 1
  fi
  if [ "$(id -u)" -ne 0 ]; then
    err "需要 root 权限自动安装缺失依赖: $*（请使用 sudo 运行或手动安装）"
    return 1
  fi
  case "$mgr" in
    apt)
      if [ "$APT_UPDATED" = 0 ]; then
        DEBIAN_FRONTEND=noninteractive apt-get update -qq
        APT_UPDATED=1
      fi
      info "安装缺失系统依赖 (apt): $*"
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"
      ;;
    dnf)
      info "安装缺失系统依赖 (dnf): $*"
      dnf install -y "$@"
      ;;
    yum)
      info "安装缺失系统依赖 (yum): $*"
      yum install -y "$@"
      ;;
    apk)
      info "安装缺失系统依赖 (apk): $*"
      apk add --no-cache "$@"
      ;;
    *)
      err "无法识别包管理器，请手动安装缺失依赖: $*"
      return 1
      ;;
  esac
}

install_os_pkg_best_effort() {
  local pkg="$1" mgr
  [ "$AUTO_INSTALL_DEPS" = 1 ] || return 0
  [ "$(id -u)" -eq 0 ] || return 0
  mgr="$(detect_pkg_mgr)"
  case "$mgr" in
    apt)
      if [ "$APT_UPDATED" = 0 ]; then
        DEBIAN_FRONTEND=noninteractive apt-get update -qq || return 0
        APT_UPDATED=1
      fi
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$pkg" >/dev/null 2>&1 || true
      ;;
    dnf) dnf install -y "$pkg" >/dev/null 2>&1 || true ;;
    yum) yum install -y "$pkg" >/dev/null 2>&1 || true ;;
    apk) apk add --no-cache "$pkg" >/dev/null 2>&1 || true ;;
  esac
}

ensure_docker_runtime() {
  local mgr
  mgr="$(detect_pkg_mgr)"
  if ! command -v docker >/dev/null 2>&1; then
    if [ "$AUTO_INSTALL_DEPS" != 1 ]; then
      err "未安装 Docker（请安装 Docker Engine + Compose 插件，或移除 --no-install-deps 自动安装）"
      return 1
    fi
    if [ "$(id -u)" -ne 0 ]; then
      err "需要 root 权限安装 Docker（请使用 sudo 运行）"
      return 1
    fi
    info "未检测到 Docker，正在自动安装 Docker Engine 与 Compose 插件..."
    case "$mgr" in
      apt)
        install_os_pkgs ca-certificates curl gnupg || return 1
        if ! (curl -fsSL https://get.docker.com | sh); then
          install_os_pkgs docker.io docker-compose-v2 || install_os_pkgs docker.io docker-compose || return 1
        fi
        ;;
      dnf|yum)
        install_os_pkgs ca-certificates curl || return 1
        if ! (curl -fsSL https://get.docker.com | sh); then
          install_os_pkgs docker docker-compose-plugin || return 1
        fi
        ;;
      apk)
        install_os_pkgs docker docker-cli-compose || return 1
        ;;
      *)
        err "请先手动安装 Docker Engine >= 20.10 与 docker compose"
        return 1
        ;;
    esac
  fi

  if ! docker compose version >/dev/null 2>&1 && ! command -v docker-compose >/dev/null 2>&1; then
    info "未检测到 Docker Compose 插件，尝试自动补装..."
    case "$mgr" in
      apt) install_os_pkgs docker-compose-plugin || install_os_pkgs docker-compose-v2 || install_os_pkgs docker-compose || return 1 ;;
      dnf|yum) install_os_pkgs docker-compose-plugin || install_os_pkgs docker-compose || return 1 ;;
      apk) install_os_pkgs docker-cli-compose || return 1 ;;
      *) err "缺少 Docker Compose（docker compose / docker-compose）"; return 1 ;;
    esac
  fi

  if ! docker info >/dev/null 2>&1; then
    if command -v systemctl >/dev/null 2>&1 && [ "$(id -u)" -eq 0 ]; then
      info "启动 Docker 服务..."
      systemctl enable --now docker >/dev/null 2>&1 || systemctl start docker >/dev/null 2>&1 || true
    fi
  fi
  if ! docker info >/dev/null 2>&1; then
    err "Docker 守护进程未运行或无权访问 /var/run/docker.sock"
    return 1
  fi
}

detect_bluegreen_active() {
  local bg_file="${INSTALL_DIR}/bluegreen/active" val=""
  if [ -f "$bg_file" ]; then
    val="$(tr -d '[:space:]' <"$bg_file" 2>/dev/null || true)"
    if [ "$val" = "blue" ] || [ "$val" = "green" ]; then
      echo "$val"
      return 0
    fi
  fi
  echo ""
}

detect_mode() {
  if [ "$DEPLOY_MODE" != "auto" ]; then
    echo "$DEPLOY_MODE"
    return
  fi
  if [ -n "$(detect_bluegreen_active)" ]; then
    echo "docker"
    return
  fi
  if command -v systemctl >/dev/null 2>&1 && { systemctl is-active --quiet "$SYSTEMD_UNIT" 2>/dev/null || systemctl is-enabled --quiet "$SYSTEMD_UNIT" 2>/dev/null; }; then
    if ! command -v docker >/dev/null 2>&1 || ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$SERVICE_NAME"; then
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

resolve_pg_runtime() {
  local mode="$1"
  if [ "$EXTERNAL_PG" = 1 ]; then
    echo "external"
    return
  fi
  if [ "$PG_RUNTIME" != "auto" ]; then
    echo "$PG_RUNTIME"
    return
  fi
  if [ "$mode" = "systemd" ] && ! command -v docker >/dev/null 2>&1; then
    echo "native"
    return
  fi
  echo "docker"
}

resolve_sqlite_path() {
  local mode="${1:-}"
  if [ -n "$SQLITE_PATH" ]; then
    echo "$SQLITE_PATH"
    return
  fi
  local from_env data_dir
  from_env="$(effective_env_get KIN_DB_PATH "$mode")"
  if [ -n "$from_env" ]; then
    echo "$from_env"
    return
  fi
  data_dir="$(effective_env_get KIN_DATA_DIR "$mode")"
  if [ -n "$data_dir" ]; then
    echo "${data_dir%/}/kin.db"
    return
  fi
  echo "${INSTALL_DIR}/data/kin.db"
}

is_local_port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH "sport = :${port}" 2>/dev/null | grep -q . && return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import socket,sys
s=socket.socket(socket.AF_INET,socket.SOCK_STREAM)
s.settimeout(0.3)
rc=s.connect_ex(('127.0.0.1',int(sys.argv[1])))
s.close()
sys.exit(0 if rc==0 else 1)" "$port" 2>/dev/null && return 0
  fi
  return 1
}

container_owns_local_port() {
  local cname="$1" port="$2"
  command -v docker >/dev/null 2>&1 || return 1
  docker ps --filter "name=^/${cname}$" --format '{{.Ports}}' 2>/dev/null | grep -qE "127\.0\.0\.1:${port}->|:${port}->"
}

resolve_safe_local_port() {
  local label="$1" desired="$2" explicit="$3" own_container="$4" scan_start="$5" scan_end="$6" runtime="$7"
  if ! is_local_port_in_use "$desired"; then
    echo "$desired"
    return 0
  fi
  if [ "$runtime" = "docker" ] && container_owns_local_port "$own_container" "$desired"; then
    echo "$desired"
    return 0
  fi
  if [ "$runtime" = "native" ]; then
    # Native PostgreSQL/Redis services intentionally bind their own standard port.
    echo "$desired"
    return 0
  fi
  if [ "$explicit" = 1 ]; then
    err "${label} 指定端口 127.0.0.1:${desired} 已被本机其他服务占用，请换用空闲端口或释放该端口后重试"
    return 1
  fi
  local p
  for p in $(seq "$scan_start" "$scan_end"); do
    if ! is_local_port_in_use "$p"; then
      warn "${label} 默认端口 127.0.0.1:${desired} 已被本机其他服务占用，自动改用空闲端口 ${p}" >&2
      echo "$p"
      return 0
    fi
  done
  err "${label} 端口 ${desired} 及备用区间 ${scan_start}-${scan_end} 均被占用，请用 --pg-port / --redis-port 指定空闲端口"
  return 1
}

resolve_exact_container_id() {
  local svc="$1" fallback_name="$2" cid=""
  if compose_has_service "$svc" && has_docker_compose; then
    cid="$(compose_cmd ps -q "$svc" 2>/dev/null | head -n1 || true)"
  fi
  if [ -z "$cid" ]; then
    cid="$(docker ps -q --filter "name=^/${fallback_name}$" 2>/dev/null | head -n1 || true)"
  fi
  echo "$cid"
}

node_supports_sqlite() {
  command -v node >/dev/null 2>&1 && node -e "import('node:sqlite').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null
}

host_has_pg_npm_deps() {
  command -v node >/dev/null 2>&1 && (
    cd "$INSTALL_DIR" 2>/dev/null \
      && node -e "Promise.all([import('pg'), import('ioredis')]).then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null
  )
}

ensure_host_migrator_script() {
  local target="${INSTALL_DIR}/scripts/migrate-sqlite-to-pg.mjs"
  if [ ! -f "$target" ]; then
    if [ -n "$SCRIPT_DIR" ] && [ -f "${SCRIPT_DIR}/../scripts/migrate-sqlite-to-pg.mjs" ]; then
      mkdir -p "${INSTALL_DIR}/scripts"
      cp -f "${SCRIPT_DIR}/../scripts/migrate-sqlite-to-pg.mjs" "$target"
      ok "已同步迁移脚本至 ${target}"
    elif [ "$AUTO_INSTALL_DEPS" = 1 ] && command -v curl >/dev/null 2>&1; then
      local ref="main" ver=""
      if [ -f "${INSTALL_DIR}/VERSION" ]; then
        ver="$(tr -d '[:space:]' <"${INSTALL_DIR}/VERSION" 2>/dev/null || true)"
        [ -n "$ver" ] && ref="v${ver#v}"
      fi
      mkdir -p "${INSTALL_DIR}/scripts"
      info "缺少 ${target}，正在自动获取 scripts/migrate-sqlite-to-pg.mjs (${ref})..."
      if ! curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 60 \
        "https://raw.githubusercontent.com/${GITHUB_REPO}/${ref}/scripts/migrate-sqlite-to-pg.mjs" -o "${target}.new"; then
        rm -f "${target}.new"
        curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 60 \
          "https://raw.githubusercontent.com/${GITHUB_REPO}/main/scripts/migrate-sqlite-to-pg.mjs" -o "${target}.new" || {
          rm -f "${target}.new"
          err "无法自动获取 ${target}，请手动同步最新 scripts/migrate-sqlite-to-pg.mjs 后重试（控制面尚未停止）"
          return 1
        }
      fi
      mv -f "${target}.new" "$target"
      ok "已自动补齐迁移脚本: ${target}"
    else
      err "缺少迁移脚本 ${target}（请先同步最新 scripts/migrate-sqlite-to-pg.mjs 或移除 --no-install-deps 自动获取；控制面尚未停止）"
      return 1
    fi
  fi
  if ! node --check "$target" >/dev/null 2>&1; then
    err "迁移脚本语法检查失败: ${target}"
    return 1
  fi
}

verify_pg_sync_rpc_safety() {
  local sync_file="${INSTALL_DIR}/src/lib/db/pg/pg-sync-db.mjs"
  if [ ! -f "$sync_file" ] || ! grep -q 'PG_SYNC_PROTOCOL_ERROR' "$sync_file" 2>/dev/null; then
    err "当前 ${INSTALL_DIR} 的 PostgreSQL 同步桥接层（src/lib/db/pg/pg-sync-db.mjs）缺少 #1905 RPC 关联修复（>= v1.4.227），在 Atomics.wait 虚假唤醒或超时后会发生永久查询错位！"
    err "控制面尚未停止（零停机中止）。请先将控制面升级至 >= v1.4.227 再切换 PostgreSQL。"
    return 1
  fi
}

ensure_host_node_pg_deps() {
  local mode="$1"
  if [ "$mode" = "systemd" ]; then
    if [ ! -f "${INSTALL_DIR}/src/lib/db/pg/config.mjs" ]; then
      err "当前 ${INSTALL_DIR} 代码版本尚未包含 PostgreSQL 模块（缺少 src/lib/db/pg/config.mjs）。请先升级至支持 PostgreSQL 的版本再执行迁移！"
      return 1
    fi
    verify_pg_sync_rpc_safety || return 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    err "宿主机未安装 Node.js（systemd / 本机模式需要 Node.js >= 22.5 以支持 node:sqlite 与 pg/ioredis）"
    return 1
  fi
  if ! node_supports_sqlite; then
    err "宿主机 Node.js 版本过低（当前 $(node -v 2>/dev/null || echo unknown)），迁移脚本需要 Node.js >= 22.5（内置 node:sqlite）"
    return 1
  fi

  ensure_host_migrator_script || return 1

  if ! host_has_pg_npm_deps; then
    if [ ! -f "${INSTALL_DIR}/package.json" ]; then
      err "${INSTALL_DIR} 缺少 package.json，无法安装 pg / ioredis 依赖"
      return 1
    fi
    if [ "$AUTO_INSTALL_DEPS" != 1 ]; then
      err "宿主机缺少 Node PostgreSQL/Redis 依赖（pg / ioredis）。请执行: cd ${INSTALL_DIR} && npm ci --omit=dev"
      return 1
    fi
    if ! command -v npm >/dev/null 2>&1; then
      err "缺少 npm，无法自动补装 pg / ioredis；请先安装 npm 或手动执行 npm ci --omit=dev"
      return 1
    fi
    info "检测到 ${INSTALL_DIR} 缺少 PostgreSQL/Redis Node 依赖（pg / ioredis），正在自动安装..."
    if [ -f "${INSTALL_DIR}/package-lock.json" ]; then
      (cd "$INSTALL_DIR" && npm ci --omit=dev --no-audit --no-fund)
    else
      (cd "$INSTALL_DIR" && npm install --omit=dev --no-audit --no-fund)
    fi
    if ! host_has_pg_npm_deps; then
      err "自动安装后仍无法加载 pg 或 ioredis，请检查 ${INSTALL_DIR}/node_modules 与网络"
      return 1
    fi
    ok "已自动补装并验证 Node 依赖（pg + ioredis + node:sqlite）"
  else
    ok "Node 运行时与 PG/Redis 依赖（pg + ioredis + node:sqlite）已就绪"
  fi
}

verify_docker_migrator_image() {
  local probe_js="import fs from 'node:fs'; if (!fs.existsSync('/opt/vm2api/scripts/migrate-sqlite-to-pg.mjs')) process.exit(2); const syncPath = '/opt/vm2api/src/lib/db/pg/pg-sync-db.mjs'; if (!fs.existsSync(syncPath) || !fs.readFileSync(syncPath, 'utf8').includes('PG_SYNC_PROTOCOL_ERROR')) process.exit(3); await import('pg'); await import('ioredis'); await import('node:sqlite');"
  info "校验 Docker 控制面镜像是否包含 PG 驱动（pg/ioredis）、迁移脚本及 PgSyncDb 安全修复 (>= v1.4.227)..."
  local rc=0
  compose_cmd run --rm --no-deps --entrypoint node "$SERVICE_NAME" -e "$probe_js" >/dev/null 2>&1 || rc=$?
  if [ "$rc" = 0 ]; then
    ok "Docker 控制面镜像 PG 迁移依赖与 PgSyncDb 安全门禁校验通过"
    return 0
  fi
  if [ "$AUTO_PULL" = 1 ]; then
    warn "本地控制面镜像版本过旧（退出码 ${rc}：缺少 PG 依赖或 #1905 PgSyncDb 修复），尝试自动拉取最新镜像..."
    compose_cmd pull "$SERVICE_NAME"
    rc=0
    compose_cmd run --rm --no-deps --entrypoint node "$SERVICE_NAME" -e "$probe_js" >/dev/null 2>&1 || rc=$?
    if [ "$rc" = 0 ]; then
      ok "拉取新镜像后 PG 迁移依赖与 PgSyncDb 安全门禁校验通过"
      return 0
    fi
  fi
  if [ "$rc" = 3 ]; then
    err "当前控制面镜像仍含旧版 PgSyncDb（缺少 #1905 RPC 关联修复，存在虚假唤醒/超时后永久查询错位风险）！"
  else
    err "当前控制面镜像版本过旧，缺少 PostgreSQL 依赖（pg / ioredis）或 /opt/vm2api/scripts/migrate-sqlite-to-pg.mjs！"
  fi
  err "控制面尚未停止（零停机中止）。请先升级控制面至 >= v1.4.227 后再迁移："
  info "  sudo bash ${INSTALL_DIR}/deploy/install.sh upgrade --auto-migrate"
  info "  或先执行: sudo bash ${INSTALL_DIR}/deploy/install.sh upgrade && sudo bash ${INSTALL_DIR}/deploy/replace-db-to-pg.sh"
  return 1
}

ensure_base_host_deps() {
  local mgr
  mgr="$(detect_pkg_mgr)"
  local -a missing_pkgs=()

  if ! command -v curl >/dev/null 2>&1; then missing_pkgs+=(curl); fi
  if ! command -v openssl >/dev/null 2>&1; then missing_pkgs+=(openssl); fi
  if ! command -v python3 >/dev/null 2>&1; then missing_pkgs+=(python3); fi
  if ! command -v psql >/dev/null 2>&1 || ! command -v pg_dump >/dev/null 2>&1 || ! command -v pg_isready >/dev/null 2>&1; then
    case "$mgr" in
      apt|apk) missing_pkgs+=(postgresql-client) ;;
      dnf|yum) missing_pkgs+=(postgresql) ;;
      *) missing_pkgs+=(postgresql-client) ;;
    esac
  fi

  if [ "${#missing_pkgs[@]}" -gt 0 ]; then
    install_os_pkgs "${missing_pkgs[@]}" || return 1
  fi

  # Optional redis-cli for Redis readiness & ops diagnostics (non-fatal if repo lacks it)
  if [ "$NO_REDIS" = 0 ] && ! command -v redis-cli >/dev/null 2>&1; then
    case "$mgr" in
      apt) install_os_pkg_best_effort redis-tools ;;
      dnf|yum|apk) install_os_pkg_best_effort redis ;;
    esac
  fi
  ok "宿主机基础与 PostgreSQL 客户端依赖（curl/openssl/python3/psql/pg_dump/pg_isready）已就绪"
}

ensure_native_pg_redis_deps() {
  local mgr
  mgr="$(detect_pkg_mgr)"
  local -a native_pkgs=()

  if ! command -v postgres >/dev/null 2>&1 && ! [ -d /etc/postgresql ] && ! command -v initdb >/dev/null 2>&1; then
    case "$mgr" in
      apt) native_pkgs+=(postgresql postgresql-client) ;;
      dnf|yum) native_pkgs+=(postgresql-server postgresql) ;;
      apk) native_pkgs+=(postgresql postgresql-client) ;;
      *) err "请先手动安装系统 PostgreSQL 服务"; return 1 ;;
    esac
  fi

  if [ "$NO_REDIS" = 0 ] && [ -z "$REDIS_URL_ARG" ] && ! command -v redis-server >/dev/null 2>&1; then
    case "$mgr" in
      apt) native_pkgs+=(redis-server) ;;
      dnf|yum|apk) native_pkgs+=(redis) ;;
      *) warn "未检测到 redis-server，将降级为 L1 + PG LISTEN/NOTIFY" ;;
    esac
  fi

  if [ "${#native_pkgs[@]}" -gt 0 ]; then
    install_os_pkgs "${native_pkgs[@]}" || return 1
  fi
  ok "宿主机原生 PostgreSQL / Redis 服务包已就绪"
}

provision_native_pg_redis() {
  if [ "$(id -u)" -ne 0 ]; then
    err "原生 PostgreSQL/Redis 初始化需要 root 权限（请使用 sudo 运行）"
    return 1
  fi
  # RHEL/CentOS style initdb if cluster not initialized yet
  if command -v postgresql-setup >/dev/null 2>&1 && [ ! -f /var/lib/pgsql/data/PG_VERSION ]; then
    postgresql-setup --initdb || true
  fi
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now postgresql >/dev/null 2>&1 || systemctl start postgresql
  elif command -v service >/dev/null 2>&1; then
    service postgresql start
  fi

  local pg_ready=0
  for _ in $(seq 1 30); do
    if pg_isready -h 127.0.0.1 -p "$PG_PORT" >/dev/null 2>&1; then
      pg_ready=1
      break
    fi
    sleep 1
  done
  if [ "$pg_ready" != 1 ]; then
    err "宿主机原生 PostgreSQL 未在 127.0.0.1:${PG_PORT} 就绪，请检查 systemctl status postgresql"
    return 1
  fi

  info "初始化原生 PostgreSQL 角色与数据库 (${PG_USER} / ${PG_DB} on port ${PG_PORT})..."
  local esc_user esc_db esc_pass
  esc_user="${PG_USER//\'/\'\'}"
  esc_db="${PG_DB//\'/\'\'}"
  esc_pass="${PG_PASSWORD//\'/\'\'}"
  su - postgres -c "psql -p \"${PG_PORT}\" -v ON_ERROR_STOP=1" <<SQL >/dev/null
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${esc_user}') THEN
    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', '${esc_user}', '${esc_pass}');
  ELSE
    EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L', '${esc_user}', '${esc_pass}');
  END IF;
END
\$\$;
SQL
  if ! su - postgres -c "psql -p \"${PG_PORT}\" -tAc \"SELECT 1 FROM pg_database WHERE datname='${esc_db}'\"" | grep -qx 1; then
    su - postgres -c "createdb -p \"${PG_PORT}\" -O \"${PG_USER}\" \"${PG_DB}\""
  fi
  # PostgreSQL 15+ revokes CREATE on schema public from PUBLIC; ensure role owns DB & public schema.
  su - postgres -c "psql -p \"${PG_PORT}\" -d \"${PG_DB}\" -v ON_ERROR_STOP=1" <<SQL >/dev/null
ALTER DATABASE "${PG_DB}" OWNER TO "${PG_USER}";
GRANT ALL ON SCHEMA public TO "${PG_USER}";
ALTER SCHEMA public OWNER TO "${PG_USER}";
SQL
  ok "宿主机原生 PostgreSQL 角色与数据库已就绪"

  if [ "$NO_REDIS" = 0 ] && [ -z "$REDIS_URL_ARG" ] && command -v redis-server >/dev/null 2>&1; then
    if command -v systemctl >/dev/null 2>&1; then
      systemctl enable --now redis-server >/dev/null 2>&1 || systemctl enable --now redis >/dev/null 2>&1 || true
    elif command -v service >/dev/null 2>&1; then
      service redis-server start >/dev/null 2>&1 || true
    fi
    # Use passwordless local redis URL if system redis-server has no requirepass configured
    if command -v redis-cli >/dev/null 2>&1 && redis-cli -h 127.0.0.1 -p "$REDIS_PORT" ping 2>/dev/null | grep -qx PONG; then
      REDIS_PASSWORD=""
      TARGET_REDIS_URL="redis://127.0.0.1:${REDIS_PORT}/0"
      ok "宿主机原生 Redis (127.0.0.1:${REDIS_PORT}) 已就绪"
    fi
  fi
}

probe_pg_connectivity() {
  local dsn="$1" runner="$2"
  info "验证目标 PostgreSQL 连通性与读写权限..."
  if command -v psql >/dev/null 2>&1; then
    if PGCONNECT_TIMEOUT=10 psql "$dsn" -v ON_ERROR_STOP=1 -tAc "SELECT current_database(), current_user, version();" >/dev/null 2>&1; then
      ok "PostgreSQL 连通性验证通过（psql SELECT 1）"
      return 0
    fi
  fi
  local probe_js="import pg from 'pg'; const c = new pg.Client({ connectionString: process.env.PROBE_DSN, connectionTimeoutMillis: 10000, ssl: /sslmode=(require|verify)/i.test(process.env.PROBE_DSN) ? { rejectUnauthorized: false } : false }); await c.connect(); await c.query('SELECT 1'); await c.end();"
  if [ "$runner" = "host" ]; then
    if (cd "$INSTALL_DIR" && PROBE_DSN="$dsn" node -e "$probe_js") >/dev/null 2>&1; then
      ok "PostgreSQL 连通性验证通过（Node pg SELECT 1）"
      return 0
    fi
  elif [ "$runner" = "docker" ]; then
    if compose_cmd run --rm --no-deps -e PROBE_DSN="$dsn" --entrypoint node "$SERVICE_NAME" -e "$probe_js" >/dev/null 2>&1; then
      ok "PostgreSQL 连通性验证通过（容器 Node pg SELECT 1）"
      return 0
    fi
  fi
  err "无法连接目标 PostgreSQL！请检查 --database-url、密码、防火墙/白名单或 sslmode 配置。"
  return 1
}

probe_redis_connectivity() {
  local rurl="$1" runner="$2"
  [ -n "$rurl" ] || return 0
  info "验证目标 Redis 连通性..."
  if command -v redis-cli >/dev/null 2>&1; then
    if redis-cli -u "$rurl" --no-auth-warning ping 2>/dev/null | grep -qx PONG; then
      ok "Redis 连通性验证通过（PONG）"
      return 0
    fi
  fi
  local probe_js="import Redis from 'ioredis'; const r = new Redis(process.env.PROBE_REDIS, { connectTimeout: 5000, maxRetriesPerRequest: 1 }); try { const res = await r.ping(); if (res !== 'PONG') process.exit(1); } finally { r.disconnect(); }"
  if [ "$runner" = "host" ]; then
    if (cd "$INSTALL_DIR" && PROBE_REDIS="$rurl" node -e "$probe_js") >/dev/null 2>&1; then
      ok "Redis 连通性验证通过（Node ioredis PONG）"
      return 0
    fi
  elif [ "$runner" = "docker" ]; then
    if compose_cmd run --rm --no-deps -e PROBE_REDIS="$rurl" --entrypoint node "$SERVICE_NAME" -e "$probe_js" >/dev/null 2>&1; then
      ok "Redis 连通性验证通过（容器 ioredis PONG）"
      return 0
    fi
  fi
  warn "Redis 暂不可达（vm2api 启动时会自动 fail-open 降级至 L1 + PG LISTEN/NOTIFY，不阻断 PG 迁移）"
  return 0
}

stop_control_plane() {
  local mode="$1" bg_active="$2"
  if [ "$mode" = "systemd" ]; then
    systemctl stop "$SYSTEMD_UNIT"
  elif [ -n "$bg_active" ]; then
    docker stop -t 60 "${SERVICE_NAME}-${bg_active}" 2>/dev/null || true
  else
    compose_cmd stop "$SERVICE_NAME" 2>/dev/null || docker stop "$SERVICE_NAME" 2>/dev/null || true
  fi
}

start_control_plane() {
  local mode="$1" bg_active="$2" use_no_deps="${3:-0}"
  if [ "$mode" = "systemd" ]; then
    systemctl start "$SYSTEMD_UNIT"
  elif [ -n "$bg_active" ]; then
    if [ -x "${INSTALL_DIR}/deploy/bluegreen/bg-deploy.sh" ]; then
      bash "${INSTALL_DIR}/deploy/bluegreen/bg-deploy.sh" --restart
    else
      docker start "${SERVICE_NAME}-${bg_active}"
    fi
  else
    if [ "$use_no_deps" = 1 ]; then
      compose_cmd up -d --no-deps --force-recreate "$SERVICE_NAME"
    else
      compose_cmd up -d --force-recreate "$SERVICE_NAME"
    fi
  fi
}

run_sqlite_preflight() {
  local runner="$1" sqlite_file="$2" dsn="${3:-}"
  info "执行零停机 SQLite 表结构与约束预检（--preflight）..."
  local -a extra=()
  [ -n "$dsn" ] && extra+=(--pg-url "$dsn")
  if [ "$runner" = "host" ]; then
    node "${INSTALL_DIR}/scripts/migrate-sqlite-to-pg.mjs" \
      --sqlite "$sqlite_file" \
      --preflight \
      "${extra[@]}"
  else
    local default_sqlite="${INSTALL_DIR}/data/kin.db"
    if [ "$sqlite_file" = "$default_sqlite" ]; then
      compose_cmd run --rm --no-deps --entrypoint node "$SERVICE_NAME" \
        /opt/vm2api/scripts/migrate-sqlite-to-pg.mjs \
        --sqlite /opt/vm2api/data/kin.db \
        --preflight \
        "${extra[@]}"
    else
      local src_dir src_base
      src_dir="$(cd "$(dirname "$sqlite_file")" && pwd)"
      src_base="$(basename "$sqlite_file")"
      compose_cmd run --rm --no-deps \
        -v "${src_dir}:/tmp/vm2api-migrate-src:ro" \
        --entrypoint node "$SERVICE_NAME" \
        /opt/vm2api/scripts/migrate-sqlite-to-pg.mjs \
        --sqlite "/tmp/vm2api-migrate-src/${src_base}" \
        --preflight \
        "${extra[@]}"
    fi
  fi
}

show_status() {
  local mode port driver bg_active sqlite_file
  mode="$(detect_mode)"
  bg_active="$(detect_bluegreen_active)"
  port="$(resolve_control_plane_port "$mode")"
  driver="$(effective_env_get VM2API_DB_DRIVER "$mode")"
  sqlite_file="$(resolve_sqlite_path "$mode")"
  echo "安装目录:   ${INSTALL_DIR}"
  echo "部署模式:   ${mode}${bg_active:+ (bluegreen:${bg_active})}"
  echo "DB 驱动:    ${driver:-auto}"
  echo "SQLite 文件: ${sqlite_file} ($([ -f "$sqlite_file" ] && ls -lh "$sqlite_file" | awk '{print $5}' || echo '不存在'))"
  echo "宿主依赖:   psql=$(command -v psql >/dev/null 2>&1 && echo ok || echo missing) pg_dump=$(command -v pg_dump >/dev/null 2>&1 && echo ok || echo missing) docker=$(command -v docker >/dev/null 2>&1 && echo ok || echo missing) node=$(command -v node >/dev/null 2>&1 && node -v || echo missing)"
  if [ -f "${INSTALL_DIR}/src/lib/db/pg/pg-sync-db.mjs" ]; then
    if grep -q 'PG_SYNC_PROTOCOL_ERROR' "${INSTALL_DIR}/src/lib/db/pg/pg-sync-db.mjs" 2>/dev/null; then
      echo "PG 同步桥:  safe (已含 #1905 RPC 关联与虚假唤醒修复)"
    else
      echo "PG 同步桥:  UNSAFE (缺少 #1905 修复，请立即升级控制面至 >= v1.4.227)"
    fi
  fi
  if [ -f "$SYSTEMD_DROPIN_FILE" ]; then
    echo "Systemd PG: ${SYSTEMD_DROPIN_FILE} (已启用${SYSTEMD_PG_ENV_FILE:+, env=${SYSTEMD_PG_ENV_FILE}})"
  fi
  if command -v docker >/dev/null 2>&1; then
    docker ps -a --filter "name=vm2api" --format "容器:       {{.Names}}  {{.Status}}  {{.Ports}}" 2>/dev/null || true
  fi
  if curl -fsS --noproxy '*' "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
    echo "控制面探活: ok (http://127.0.0.1:${port}/health)"
  else
    echo "控制面探活: down (http://127.0.0.1:${port}/health)"
  fi
}

do_rollback() {
  local mode latest_env port bg_active
  mode="$(detect_mode)"
  bg_active="$(detect_bluegreen_active)"
  info "开始回滚到 SQLite（模式=${mode}${bg_active:+/bluegreen:${bg_active}}，保留 PostgreSQL 数据以便排障）..."

  stop_control_plane "$mode" "$bg_active" || true
  if [ "$mode" = "systemd" ]; then
    if [ -f "$SYSTEMD_DROPIN_FILE" ]; then
      rm -f "$SYSTEMD_DROPIN_FILE"
      ok "已移除 systemd drop-in: ${SYSTEMD_DROPIN_FILE}"
    fi
    if [ -f "$SYSTEMD_PG_ENV_FILE" ]; then
      rm -f "$SYSTEMD_PG_ENV_FILE"
      ok "已移除 systemd PG 环境文件: ${SYSTEMD_PG_ENV_FILE}"
    fi
    systemctl daemon-reload
  fi

  latest_env="$(ls -1t "${BACKUP_ROOT}"/pre-pg-migration-*/.env.bak 2>/dev/null | head -n1 || true)"
  if [ -n "$latest_env" ] && [ -f "$latest_env" ]; then
    cp -f "$latest_env" "$ENV_FILE"
    chmod 600 "$ENV_FILE" || true
    ok "已还原切换前 .env 备份: ${latest_env}"
  fi
  env_set VM2API_DB_DRIVER sqlite

  # Rollback to SQLite must NEVER depend on PG/Redis containers.
  start_control_plane "$mode" "$bg_active" 1

  port="$(resolve_control_plane_port "$mode")"
  for _ in $(seq 1 30); do
    if curl -fsS --noproxy '*' "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      ok "回滚完成，控制面已切回 SQLite 并通过健康检查！(http://127.0.0.1:${port}/health)"
      exit 0
    fi
    sleep 2
  done
  err "回滚后控制面探活超时 (http://127.0.0.1:${port}/health)，请检查日志"
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
BG_ACTIVE="$(detect_bluegreen_active)"
RESOLVED_PG_RUNTIME="$(resolve_pg_runtime "$MODE")"
SRC_SQLITE="$(resolve_sqlite_path "$MODE")"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
MIGRATION_BACKUP_DIR="${BACKUP_ROOT}/pre-pg-migration-${STAMP}"

info "部署模式: ${MODE}${BG_ACTIVE:+ (bluegreen:${BG_ACTIVE})} | PG 运行方式: ${RESOLVED_PG_RUNTIME} | 安装目录: ${INSTALL_DIR}"

# ---------------------------------------------------------------------------
# Phase 0: Complete Dependency Preflight & Auto-Install (ZERO downtime)
# ---------------------------------------------------------------------------
ensure_base_host_deps

if [ "$RESOLVED_PG_RUNTIME" = "docker" ] || [ "$MODE" = "docker" ]; then
  ensure_docker_runtime
elif [ "$RESOLVED_PG_RUNTIME" = "native" ]; then
  ensure_native_pg_redis_deps
fi

# Determine migrator runner (host Node vs Docker image) BEFORE stopping anything!
MIGRATOR_RUNNER=""
if [ "$MODE" = "systemd" ]; then
  ensure_host_node_pg_deps "$MODE"
  MIGRATOR_RUNNER="host"
elif [ -f "${INSTALL_DIR}/scripts/migrate-sqlite-to-pg.mjs" ] && node_supports_sqlite; then
  if host_has_pg_npm_deps; then
    MIGRATOR_RUNNER="host"
    ok "将使用宿主机 Node 运行时（pg + ioredis + node:sqlite 已就绪）"
  elif [ -f "${INSTALL_DIR}/package.json" ] && [ "$AUTO_INSTALL_DEPS" = 1 ] && command -v npm >/dev/null 2>&1 && ! [ -f "${INSTALL_DIR}/docker-compose.yml" ]; then
    ensure_host_node_pg_deps "$MODE"
    MIGRATOR_RUNNER="host"
  else
    verify_docker_migrator_image
    MIGRATOR_RUNNER="docker"
  fi
else
  verify_docker_migrator_image
  MIGRATOR_RUNNER="docker"
fi

if [ "$CHECK_DEPS_ONLY" = 1 ]; then
  echo ""
  ok "全部依赖检查通过！（模式=${MODE}，PG运行方式=${RESOLVED_PG_RUNTIME}，迁移执行器=${MIGRATOR_RUNNER}）"
  exit 0
fi

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

# Resolve PostgreSQL & Redis target credentials, ports (with conflict detection), and DSNs
PG_CONTAINER_NAME="$(env_get VM2API_PG_CONTAINER_NAME)"
PG_CONTAINER_NAME="${PG_CONTAINER_NAME:-vm2api-postgres}"
REDIS_CONTAINER_NAME="$(env_get VM2API_REDIS_CONTAINER_NAME)"
REDIS_CONTAINER_NAME="${REDIS_CONTAINER_NAME:-vm2api-redis}"

if [ "$EXTERNAL_PG" = 1 ]; then
  TARGET_DSN="$DATABASE_URL_ARG"
  info "目标 PostgreSQL: 外部/云端数据库（跳过本地 PG）"
else
  if [ -z "$PG_PORT" ]; then
    PG_PORT="$(env_get VM2API_PG_PORT)"
  fi
  PG_PORT="${PG_PORT:-5432}"
  PG_PORT="$(resolve_safe_local_port "PostgreSQL" "$PG_PORT" "$PG_PORT_EXPLICIT" "$PG_CONTAINER_NAME" 5433 5460 "$RESOLVED_PG_RUNTIME")"
  PG_USER="$(env_get POSTGRES_USER)"
  PG_USER="${PG_USER:-vm2api}"
  PG_DB="$(env_get POSTGRES_DB)"
  PG_DB="${PG_DB:-vm2api}"
  PG_PASSWORD="$(env_get POSTGRES_PASSWORD)"
  if [ -z "$PG_PASSWORD" ]; then
    PG_PASSWORD="$(gen_secret)"
  fi
  TARGET_DSN="postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DB}?sslmode=disable"
  info "目标 PostgreSQL: 本地(${RESOLVED_PG_RUNTIME}) 127.0.0.1:${PG_PORT}/${PG_DB}"
fi

if [ "$NO_REDIS" = 1 ]; then
  TARGET_REDIS_URL=""
  info "目标缓存: L1 + PostgreSQL LISTEN/NOTIFY（已禁用 Redis）"
elif [ -n "$REDIS_URL_ARG" ]; then
  TARGET_REDIS_URL="$REDIS_URL_ARG"
  info "目标缓存: L1 + 外部 Redis"
else
  if [ -z "$REDIS_PORT" ]; then
    REDIS_PORT="$(env_get VM2API_REDIS_PORT)"
  fi
  REDIS_PORT="${REDIS_PORT:-6379}"
  REDIS_PORT="$(resolve_safe_local_port "Redis" "$REDIS_PORT" "$REDIS_PORT_EXPLICIT" "$REDIS_CONTAINER_NAME" 6380 6409 "$RESOLVED_PG_RUNTIME")"
  REDIS_PASSWORD="$(env_get REDIS_PASSWORD)"
  if [ -z "$REDIS_PASSWORD" ]; then
    REDIS_PASSWORD="$(gen_secret)"
  fi
  TARGET_REDIS_URL="redis://:${REDIS_PASSWORD}@127.0.0.1:${REDIS_PORT}/0"
  info "目标缓存: L1 + 本地(${RESOLVED_PG_RUNTIME}) Redis 127.0.0.1:${REDIS_PORT}"
fi

# External target pre-flight probe + zero-downtime SQLite schema/hazard preflight BEFORE stopping control plane
if [ "$EXTERNAL_PG" = 1 ]; then
  probe_pg_connectivity "$TARGET_DSN" "$MIGRATOR_RUNNER"
  run_sqlite_preflight "$MIGRATOR_RUNNER" "$SRC_SQLITE" "$TARGET_DSN"
else
  run_sqlite_preflight "$MIGRATOR_RUNNER" "$SRC_SQLITE"
fi
if [ -n "$REDIS_URL_ARG" ] && [ "$NO_REDIS" = 0 ]; then
  probe_redis_connectivity "$TARGET_REDIS_URL" "$MIGRATOR_RUNNER"
fi

if [ "$PREFLIGHT_ONLY" = 1 ]; then
  echo ""
  ok "[PREFLIGHT] 零停机 SQLite 结构/约束与依赖预检全部通过！"
  exit 0
fi

if [ "$DRY_RUN" = 1 ]; then
  local_redis_note=""
  [ "$NO_REDIS" = 1 ] && local_redis_note="（无 Redis）"
  echo ""
  ok "[DRY-RUN] 全部依赖、SQLite 预扫与预检通过！拟执行步骤："
  echo "  1. 备份 ${SRC_SQLITE} 及 .env 到 ${MIGRATION_BACKUP_DIR}"
  echo "  2. 准备并校验 PostgreSQL（${RESOLVED_PG_RUNTIME}）${local_redis_note}"
  echo "  3. 仅停止控制面（${MODE}${BG_ACTIVE:+/bluegreen:${BG_ACTIVE}}），保持全部 kin-* 槽位运行"
  echo "  4. 使用 ${MIGRATOR_RUNNER} 执行器流式迁移全部表并运行 --verify + --rollup"
  echo "  5. 切换配置为 VM2API_DB_DRIVER=postgres 并重启控制面验证 http://127.0.0.1:$(resolve_control_plane_port "$MODE")/health 与 /api/panel/database/metrics"
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

# Persist PG/Redis credentials into .env BEFORE starting local PG/Redis
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
if [ "$LOCAL_DATA" = 1 ]; then
  [ -n "$PG_DATA_DIR_ARG" ] && env_set VM2API_PG_DATA_DIR "$PG_DATA_DIR_ARG"
  [ -n "$REDIS_DATA_DIR_ARG" ] && env_set VM2API_REDIS_DATA_DIR "$REDIS_DATA_DIR_ARG"
  if [ "$RESOLVED_PG_RUNTIME" = "docker" ]; then
    ensure_compose_file_includes "docker-compose.local.yml"
  fi
fi

# Start local PostgreSQL (+ optional Redis) and verify readiness BEFORE stopping control plane!
start_local_pg_redis() {
  if [ "$RESOLVED_PG_RUNTIME" = "native" ]; then
    provision_native_pg_redis
    return 0
  fi

  local pg_cid="" redis_cid="" pg_ready=0 redis_ready=0
  if [ "$EXTERNAL_PG" = 0 ]; then
    info "启动本地 PostgreSQL 容器 (${PG_CONTAINER_NAME} on 127.0.0.1:${PG_PORT})..."
    if compose_has_service postgres; then
      compose_cmd pull postgres >/dev/null 2>&1 || true
      compose_cmd up -d postgres
    else
      local need_create_pg=0
      if ! docker ps -a --format '{{.Names}}' | grep -qx "$PG_CONTAINER_NAME"; then
        need_create_pg=1
      else
        local pg_running pg_mapped_port
        pg_running="$(docker inspect -f '{{.State.Running}}' "$PG_CONTAINER_NAME" 2>/dev/null || echo false)"
        pg_mapped_port="$(docker inspect -f '{{(index (index .HostConfig.PortBindings "5432/tcp") 0).HostPort}}' "$PG_CONTAINER_NAME" 2>/dev/null || true)"
        if [ "$pg_running" != "true" ] && [ -n "$pg_mapped_port" ] && [ "$pg_mapped_port" != "$PG_PORT" ]; then
          warn "已停止的容器 ${PG_CONTAINER_NAME} 端口映射(${pg_mapped_port})与目标端口(${PG_PORT})不一致，重建容器（保留数据目录）..."
          docker rm "$PG_CONTAINER_NAME" >/dev/null
          need_create_pg=1
        fi
      fi
      if [ "$need_create_pg" = 1 ]; then
        local pg_host_dir="${PG_DATA_DIR_ARG:-${INSTALL_DIR}/data/postgres}"
        mkdir -p "$pg_host_dir"
        docker run -d --name "$PG_CONTAINER_NAME" --restart unless-stopped \
          -e POSTGRES_USER="$PG_USER" \
          -e POSTGRES_PASSWORD="$PG_PASSWORD" \
          -e POSTGRES_DB="$PG_DB" \
          -e PGDATA=/var/lib/postgresql/data \
          -p "127.0.0.1:${PG_PORT}:5432" \
          -v "${pg_host_dir}:/var/lib/postgresql/data" \
          --health-cmd "pg_isready -U ${PG_USER} -d ${PG_DB}" \
          --health-interval 5s --health-timeout 5s --health-retries 12 \
          postgres:18-alpine \
          -c max_connections=200 \
          -c shared_buffers=256MB \
          -c effective_cache_size=768MB \
          -c work_mem=16MB \
          -c maintenance_work_mem=128MB \
          -c wal_buffers=16MB \
          -c checkpoint_completion_target=0.9 \
          -c max_wal_size=1GB \
          -c idle_in_transaction_session_timeout=60000 \
          -c random_page_cost=1.1
      else
        docker start "$PG_CONTAINER_NAME" >/dev/null
      fi
    fi

    info "等待 PostgreSQL 就绪..."
    for _ in $(seq 1 45); do
      pg_cid="$(resolve_exact_container_id postgres "$PG_CONTAINER_NAME")"
      if [ -n "$pg_cid" ] && docker exec "$pg_cid" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
        pg_ready=1
        break
      fi
      sleep 2
    done
    if [ "$pg_ready" != 1 ]; then
      err "本地 PostgreSQL 容器在 90 秒内未就绪！（控制面尚未停止，零停机中止）"
      [ -n "$pg_cid" ] && docker logs --tail 30 "$pg_cid" >&2 || true
      exit 1
    fi
    ok "本地 PostgreSQL 容器已就绪"
  fi

  if [ "$NO_REDIS" = 0 ] && [ -z "$REDIS_URL_ARG" ]; then
    info "启动本地 Redis 容器 (${REDIS_CONTAINER_NAME} on 127.0.0.1:${REDIS_PORT})..."
    if compose_has_service redis; then
      compose_cmd pull redis >/dev/null 2>&1 || true
      compose_cmd up -d redis
    else
      local need_create_redis=0
      if ! docker ps -a --format '{{.Names}}' | grep -qx "$REDIS_CONTAINER_NAME"; then
        need_create_redis=1
      else
        local r_running r_mapped_port
        r_running="$(docker inspect -f '{{.State.Running}}' "$REDIS_CONTAINER_NAME" 2>/dev/null || echo false)"
        r_mapped_port="$(docker inspect -f '{{(index (index .HostConfig.PortBindings "6379/tcp") 0).HostPort}}' "$REDIS_CONTAINER_NAME" 2>/dev/null || true)"
        if [ "$r_running" != "true" ] && [ -n "$r_mapped_port" ] && [ "$r_mapped_port" != "$REDIS_PORT" ]; then
          warn "已停止的容器 ${REDIS_CONTAINER_NAME} 端口映射(${r_mapped_port})与目标端口(${REDIS_PORT})不一致，重建容器（保留数据目录）..."
          docker rm "$REDIS_CONTAINER_NAME" >/dev/null
          need_create_redis=1
        fi
      fi
      if [ "$need_create_redis" = 1 ]; then
        local redis_host_dir="${REDIS_DATA_DIR_ARG:-${INSTALL_DIR}/data/redis}"
        mkdir -p "$redis_host_dir"
        docker run -d --name "$REDIS_CONTAINER_NAME" --restart unless-stopped \
          -p "127.0.0.1:${REDIS_PORT}:6379" \
          -v "${redis_host_dir}:/data" \
          --health-cmd "redis-cli -a \"${REDIS_PASSWORD}\" --no-auth-warning ping | grep -q PONG" \
          --health-interval 5s --health-timeout 5s --health-retries 10 \
          redis:8-alpine redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru --requirepass "$REDIS_PASSWORD"
      else
        docker start "$REDIS_CONTAINER_NAME" >/dev/null
      fi
    fi

    for _ in $(seq 1 25); do
      redis_cid="$(resolve_exact_container_id redis "$REDIS_CONTAINER_NAME")"
      if [ -n "$redis_cid" ] && docker exec "$redis_cid" redis-cli -a "$REDIS_PASSWORD" --no-auth-warning ping 2>/dev/null | grep -qx PONG; then
        redis_ready=1
        break
      fi
      sleep 1
    done
    if [ "$redis_ready" = 1 ]; then
      ok "本地 Redis 容器已就绪（PONG）"
    else
      warn "本地 Redis 容器探活超时（vm2api 启动时将自动降级为 L1 + PG LISTEN/NOTIFY）"
      [ -n "$redis_cid" ] && docker logs --tail 15 "$redis_cid" >&2 || true
    fi
  fi
}

if [ "$EXTERNAL_PG" = 0 ] || { [ "$NO_REDIS" = 0 ] && [ -z "$REDIS_URL_ARG" ]; }; then
  start_local_pg_redis
fi

# Verify end-to-end local PG authentication & SQL query BEFORE stopping live control plane!
# (External PG was already probed above prior to confirmation.)
if [ "$EXTERNAL_PG" = 0 ]; then
  probe_pg_connectivity "$TARGET_DSN" "$MIGRATOR_RUNNER"
fi

# ---------------------------------------------------------------------------
# Phase 1: Stop control plane cleanly (short cutover window; kin-* untouched)
# ---------------------------------------------------------------------------
info "停止 vm2api 控制面（保留全部 kin-* 槽位继续运行）..."
stop_control_plane "$MODE" "$BG_ACTIVE"

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
  else
    env_set VM2API_DB_DRIVER sqlite
  fi
  if [ "$MODE" = "systemd" ]; then
    rm -f "$SYSTEMD_DROPIN_FILE" "$SYSTEMD_PG_ENV_FILE" 2>/dev/null || true
    systemctl daemon-reload || true
  fi
  # Stop first if Phase 3 already started the control plane so rollback genuinely restarts onto SQLite.
  stop_control_plane "$MODE" "$BG_ACTIVE" || true
  # Always roll back to SQLite with --no-deps so PG/Redis never blocks recovery.
  start_control_plane "$MODE" "$BG_ACTIVE" 1 || true
}
trap cleanup_on_failure ERR

# Flush WAL cleanly if present so backup snapshot is self-contained
if [ -f "${SRC_SQLITE}-wal" ] && node_supports_sqlite; then
  node -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close();" "$SRC_SQLITE" 2>/dev/null || true
fi

# Consistent SQLite backup snapshot (copy db + wal + shm)
info "备份原 SQLite 数据库到 ${MIGRATION_BACKUP_DIR}/ ..."
cp -a "$SRC_SQLITE" "${MIGRATION_BACKUP_DIR}/kin.db"
[ -f "${SRC_SQLITE}-wal" ] && cp -a "${SRC_SQLITE}-wal" "${MIGRATION_BACKUP_DIR}/kin.db-wal" || true
[ -f "${SRC_SQLITE}-shm" ] && cp -a "${SRC_SQLITE}-shm" "${MIGRATION_BACKUP_DIR}/kin.db-shm" || true
chmod 600 "${MIGRATION_BACKUP_DIR}/kin.db"* 2>/dev/null || true
ok "原 SQLite 备份完成"

# ---------------------------------------------------------------------------
# Phase 2: Streaming full migration + --verify + --rollup
# ---------------------------------------------------------------------------
MIGRATE_FLAGS=(--verify --rollup)
[ "$TRUNCATE_TARGET" = 1 ] && MIGRATE_FLAGS+=(--truncate)
[ "$SKIP_DEBUG" = 1 ] && MIGRATE_FLAGS+=(--skip-debug)

info "执行流式全量迁移与一致性校验（执行器=${MIGRATOR_RUNNER}）..."
if [ "$MIGRATOR_RUNNER" = "host" ]; then
  node "${INSTALL_DIR}/scripts/migrate-sqlite-to-pg.mjs" \
    --sqlite "$SRC_SQLITE" \
    --pg-url "$TARGET_DSN" \
    "${MIGRATE_FLAGS[@]}"
else
  # Docker image-only install: honor custom --sqlite path via read-only bind mount
  DEFAULT_SQLITE="${INSTALL_DIR}/data/kin.db"
  if [ "$SRC_SQLITE" = "$DEFAULT_SQLITE" ]; then
    compose_cmd run --rm --no-deps --entrypoint node "$SERVICE_NAME" \
      /opt/vm2api/scripts/migrate-sqlite-to-pg.mjs \
      --sqlite /opt/vm2api/data/kin.db \
      --pg-url "$TARGET_DSN" \
      "${MIGRATE_FLAGS[@]}"
  else
    SRC_DIR="$(cd "$(dirname "$SRC_SQLITE")" && pwd)"
    SRC_BASE="$(basename "$SRC_SQLITE")"
    compose_cmd run --rm --no-deps \
      -v "${SRC_DIR}:/tmp/vm2api-migrate-src:ro" \
      --entrypoint node "$SERVICE_NAME" \
      /opt/vm2api/scripts/migrate-sqlite-to-pg.mjs \
      --sqlite "/tmp/vm2api-migrate-src/${SRC_BASE}" \
      --pg-url "$TARGET_DSN" \
      "${MIGRATE_FLAGS[@]}"
  fi
fi
ok "数据迁移与一致性校验通过（0 差异）"

# ---------------------------------------------------------------------------
# Phase 3: Atomic config switch & restart
# ---------------------------------------------------------------------------
info "更新运行配置为 PostgreSQL..."
env_set VM2API_DB_DRIVER postgres
env_set DATABASE_URL "$TARGET_DSN"
if [ -n "$TARGET_REDIS_URL" ]; then
  env_set REDIS_URL "$TARGET_REDIS_URL"
  env_set VM2API_REDIS_DISABLED 0
else
  env_set VM2API_REDIS_DISABLED 1
fi

USE_NO_DEPS=0
if [ "$EXTERNAL_PG" = 1 ] || [ "$NO_REDIS" = 1 ] || [ -n "$REDIS_URL_ARG" ] || [ "$RESOLVED_PG_RUNTIME" = "native" ] || ! compose_has_service postgres; then
  USE_NO_DEPS=1
fi

if [ "$MODE" = "systemd" ]; then
  # Write credentials to a 0600 EnvironmentFile rather than inline Environment= lines:
  # avoids systemd %-specifier expansion on URL-encoded passwords and hides secrets from `systemctl cat`.
  local_tmp_pg_env="$(mktemp "${SYSTEMD_PG_ENV_FILE}.XXXXXX")"
  {
    printf '# Managed by deploy/replace-db-to-pg.sh (%s)\n' "$STAMP"
    printf 'VM2API_DB_DRIVER=postgres\n'
    printf 'DATABASE_URL=%s\n' "$TARGET_DSN"
    if [ -n "$TARGET_REDIS_URL" ]; then
      printf 'REDIS_URL=%s\n' "$TARGET_REDIS_URL"
      printf 'VM2API_REDIS_DISABLED=0\n'
    else
      printf 'VM2API_REDIS_DISABLED=1\n'
    fi
  } >"$local_tmp_pg_env"
  chmod 600 "$local_tmp_pg_env"
  mv -f "$local_tmp_pg_env" "$SYSTEMD_PG_ENV_FILE"

  mkdir -p "$SYSTEMD_DROPIN_DIR"
  {
    printf '# Managed by deploy/replace-db-to-pg.sh (%s)\n' "$STAMP"
    printf '[Service]\n'
    printf 'EnvironmentFile=%s\n' "$SYSTEMD_PG_ENV_FILE"
  } >"$SYSTEMD_DROPIN_FILE"
  chmod 644 "$SYSTEMD_DROPIN_FILE"
  systemctl daemon-reload
fi

start_control_plane "$MODE" "$BG_ACTIVE" "$USE_NO_DEPS"

# ---------------------------------------------------------------------------
# Phase 4: Verify live /health and /api/panel/database/metrics
# ---------------------------------------------------------------------------
PORT_VAL="$(resolve_control_plane_port "$MODE")"
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
  err "控制面健康检查超时 (http://127.0.0.1:${PORT_VAL}/health)"
  false
fi

API_KEY_VAL="$(resolve_api_key "$MODE")"
if [ -n "$API_KEY_VAL" ]; then
  METRICS_JSON="$(curl -fsS --noproxy '*' -H "Authorization: Bearer ${API_KEY_VAL}" "http://127.0.0.1:${PORT_VAL}/api/panel/database/metrics" 2>/dev/null || true)"
  if [ -z "$METRICS_JSON" ]; then
    err "无法获取 /api/panel/database/metrics 以验证 PostgreSQL 引擎状态"
    false
  fi
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$METRICS_JSON" | python3 -c '
import json, sys
d = json.load(sys.stdin).get("data") or {}
db = d.get("database") or {}
cache = d.get("cache") or {}
print("已验证运行引擎: engine=%s ok=%s pg_version=%s cache_mode=%s" % (db.get("engine"), db.get("ok"), db.get("pg_version"), cache.get("mode")))
if db.get("engine") != "postgres" or not db.get("ok"):
    raise SystemExit(1)
'
  elif command -v node >/dev/null 2>&1; then
    printf '%s' "$METRICS_JSON" | node -e '
const d = (JSON.parse(require("node:fs").readFileSync(0, "utf8")).data) || {};
const db = d.database || {};
const cache = d.cache || {};
console.log(`已验证运行引擎: engine=${db.engine} ok=${db.ok} pg_version=${db.pg_version} cache_mode=${cache.mode}`);
if (db.engine !== "postgres" || !db.ok) process.exit(1);
'
  fi
fi

MIGRATION_COMMITTED=1
trap - ERR
echo ""
ok "PostgreSQL 替换切换全部完成！"
info "原 SQLite 备份保留在: ${MIGRATION_BACKUP_DIR}/"
info "如需回滚到 SQLite:   sudo bash ${INSTALL_DIR}/deploy/replace-db-to-pg.sh --rollback"
