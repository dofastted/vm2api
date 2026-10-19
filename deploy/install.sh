#!/usr/bin/env bash
#
# vm2api 一键安装 / 更新
# 参考 sub2api deploy/install.sh 与 CLIProxyAPI installer：
#   查 GitHub Release → 停服务 → 换版本 → 保留配置 → 拉起。
#
# 安装:
#   curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash
# 更新:
#   curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade
# 检查:
#   sudo bash /opt/vm2api/deploy/install.sh check
#
set -euo pipefail

if [ -z "${BASH_VERSION:-}" ]; then
  echo "请用 bash 运行（需要 bash 4+）" >&2
  exit 1
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

GITHUB_REPO="${VM2API_GITHUB_REPO:-dofastted/vm2api}"
INSTALL_DIR="${VM2API_DIR:-/opt/vm2api}"
SERVICE_NAME="vm2api"
DEFAULT_PORT="${PORT:-8787}"
TARGET_VERSION=""
ASSUME_YES=0
NO_START=0
SYNC_WRAP=1
FROM_SOURCE=0
DEFAULT_ADMIN_USER="admin"
DEFAULT_ADMIN_PASSWORD="123456"
WROTE_DEFAULT_PASSWORD=0
HOST_ARCH=""
REQUESTED_ARCH=""

info() { echo -e "${BLUE}[信息]${NC} $*"; }
ok() { echo -e "${GREEN}[成功]${NC} $*"; }
warn() { echo -e "${YELLOW}[警告]${NC} $*"; }
err() { echo -e "${RED}[错误]${NC} $*" >&2; }

is_interactive() {
  [ -e /dev/tty ] && [ -r /dev/tty ] && [ -w /dev/tty ]
}

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    err "请用 root 运行：curl ... | sudo bash   或   sudo bash deploy/install.sh $*"
    exit 1
  fi
}

usage() {
  cat <<EOF
用法: $(basename "$0") [命令] [选项]

命令:
  install              安装到 ${INSTALL_DIR}（默认）
  upgrade | update     升到最新 GitHub Release（保留 .env / vms / data）
  check                对比当前版本与最新 Release，打印 changelog
  changelog            打印本地 CHANGELOG.md
  status               当前版本、容器、探活
  uninstall            停控制面（默认保留 .env / vms / data）

选项:
  --version vX.Y.Z     指定 tag（可带 -amd64 / -arm64 后缀，须与宿主架构一致）
  --dir PATH           安装目录（默认 ${INSTALL_DIR}）
  --yes                非交互
  --no-start           只拉代码，不 compose up
  --no-sync-wrap       升级后不检查、不停调度、不更新槽内 kernel
  --from-source        clone 仓库并在本机构建镜像（默认拉预构建镜像）
  -h, --help           帮助
EOF
}

# 架构后缀只用于核对宿主，版本号本身不带后缀：v1.2.3-arm64 → v1.2.3。
strip_arch_suffix() {
  local v="${1:-}"
  case "$v" in
    *-amd64|*-x86_64|*-arm64|*-aarch64) echo "${v%-*}" ;;
    *) echo "$v" ;;
  esac
}

suffix_arch() {
  case "${1:-}" in
    *-amd64|*-x86_64) echo amd64 ;;
    *-arm64|*-aarch64) echo arm64 ;;
    *) echo "" ;;
  esac
}

normalize_tag() {
  local v
  v="$(strip_arch_suffix "${1:-}")"
  v="${v#v}"
  if [ -z "$v" ]; then
    echo ""
    return
  fi
  echo "v${v}"
}

version_of_tag() {
  echo "${1#v}"
}

# uname / Docker / Node 的写法统一成 Docker 架构名；不支持时为空。
arch_of() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    x86_64|amd64|x64) echo amd64 ;;
    aarch64|arm64) echo arm64 ;;
    *) echo "" ;;
  esac
}

resolve_host_arch() {
  local machine
  machine="$(uname -m)"
  HOST_ARCH="$(arch_of "$machine")"
  if [ -z "$HOST_ARCH" ]; then
    err "不支持的宿主架构 ${machine}；只支持 x86_64 (amd64) 与 aarch64 (arm64)"
    exit 1
  fi
  if [ -n "$REQUESTED_ARCH" ] && [ "$REQUESTED_ARCH" != "$HOST_ARCH" ]; then
    err "--version 后缀 -${REQUESTED_ARCH} 与宿主架构 ${HOST_ARCH} 不符"
    exit 1
  fi
}

# amd64 用多架构 tag（与旧安装一致）；arm64 固定单架构镜像，
# 平台不匹配时报错，不会悄悄换成 amd64 控制面。
image_tag_for() {
  if [ "$HOST_ARCH" = arm64 ]; then
    echo "${1}-arm64"
  else
    echo "$1"
  fi
}

local_version() {
  if [ -f "${INSTALL_DIR}/VERSION" ]; then
    tr -d '[:space:]' <"${INSTALL_DIR}/VERSION"
    return
  fi
  echo "not_installed"
}

# 宿主的 DOCKER_DEFAULT_PLATFORM 只该影响槽位；控制面镜像按宿主架构选择，
# ARM64 上若带着 linux/amd64 去拉 -arm64 镜像会直接失败。槽位平台由控制面镜像自己设置。
compose() {
  if docker compose version >/dev/null 2>&1; then
    env -u DOCKER_DEFAULT_PLATFORM docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    env -u DOCKER_DEFAULT_PLATFORM docker-compose "$@"
  else
    err "需要 Docker Compose（docker compose 或 docker-compose）"
    exit 1
  fi
}

require_cmds() {
  local missing=()
  for c in git curl docker; do
    command -v "$c" >/dev/null 2>&1 || missing+=("$c")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    err "缺少依赖: ${missing[*]}"
    info "Ubuntu: apt-get update && apt-get install -y git curl ca-certificates docker.io"
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    err "Docker 未运行，或当前用户不能访问 docker.sock"
    exit 1
  fi
  compose version >/dev/null
}

github_api() {
  local url="$1"
  local args=(-fsSL --connect-timeout 10 --max-time 30
    -H "Accept: application/vnd.github+json"
    -H "User-Agent: vm2api-installer"
    -H "X-GitHub-Api-Version: 2022-11-28")
  if [ -n "${GITHUB_TOKEN:-}${VM2API_GITHUB_TOKEN:-}" ]; then
    args+=(-H "Authorization: Bearer ${GITHUB_TOKEN:-$VM2API_GITHUB_TOKEN}")
  fi
  curl "${args[@]}" "$url"
}

latest_release_tag() {
  local json tag
  json="$(github_api "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" 2>/dev/null || true)"
  tag="$(printf '%s' "$json" | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
  if [ -n "$tag" ]; then
    normalize_tag "$tag"
    return
  fi
  tag="$(git ls-remote --tags --refs "https://github.com/${GITHUB_REPO}.git" 2>/dev/null \
    | awk -F/ '{print $NF}' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1,1 -k2,2n -k3,3n | tail -n1 || true)"
  if [ -z "$tag" ]; then
    err "拿不到 GitHub 最新 Release。可设 GITHUB_TOKEN，或指定 --version vX.Y.Z"
    exit 1
  fi
  echo "$tag"
}

release_notes() {
  local tag="$1"
  github_api "https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${tag}" 2>/dev/null \
    | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
    print((d.get("body") or "").strip())
except Exception:
    pass' 2>/dev/null || true
}

print_changelog_slice() {
  local file="$1"
  local from_ver="$2"
  local to_ver="$3"
  if [ ! -f "$file" ]; then
    return
  fi
  python3 - "$file" "$from_ver" "$to_ver" <<'PY'
import re, sys
path, current, target = sys.argv[1], sys.argv[2].lstrip("v"), sys.argv[3].lstrip("v")
text = open(path, encoding="utf-8").read()
chunks = re.split(r"^## ", text, flags=re.M)[1:]
def ver(h):
    m = re.match(r"v?(\d+\.\d+\.\d+)", h)
    return m.group(1) if m else None
def tup(v):
    if not v: return (0,0,0)
    return tuple(int(x) for x in v.split(".")[:3])
cur, tgt = tup(current), tup(target)
shown = 0
for chunk in chunks:
    heading, _, body = chunk.partition("\n")
    heading = heading.strip()
    v = ver(heading)
    if not v or v == "unreleased":
        continue
    tv = tup(v)
    if tv > cur and tv <= tgt:
        print(f"## {heading.strip()}")
        print(body.strip())
        print()
        shown += 1
if shown == 0:
    sys.exit(0)
PY
}


gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return
  fi
  python3 -c 'import secrets; print(secrets.token_hex(32))'
}

env_get() {
  local name="$1"
  local envf="${2:-${INSTALL_DIR}/.env}"
  [ -f "$envf" ] || return 0
  grep -E "^${name}=" "$envf" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d "'" | tr -d '"' | tr -d '\r'
}

env_set() {
  local name="$1"
  local value="$2"
  local envf="${INSTALL_DIR}/.env"
  if grep -qE "^${name}=" "$envf" 2>/dev/null; then
    sed -i "s|^${name}=.*|${name}=${value}|" "$envf"
  else
    printf '%s=%s\n' "$name" "$value" >>"$envf"
  fi
}

env_set_if_empty() {
  local name="$1"
  local value="$2"
  if [ -z "$(env_get "$name")" ]; then
    env_set "$name" "$value"
    return 0
  fi
  return 1
}

ensure_git_safe() {
  if [ -d "${INSTALL_DIR}/.git" ]; then
    git config --global --add safe.directory "${INSTALL_DIR}" 2>/dev/null || true
  fi
}

guide_changelog_error() {
  echo ""
  warn "错误类型 1：构建找不到 CHANGELOG.md"
  echo "  识别: COPY VERSION CHANGELOG.md ./  或  \"/CHANGELOG.md\": not found"
  echo "  原因: .dockerignore 的 *.md 把 CHANGELOG.md 挡在构建上下文外（v1.2.7）。"
  echo "  在 ${INSTALL_DIR} 执行:"
  echo "    grep -q '!CHANGELOG.md' .dockerignore || echo '!CHANGELOG.md' >> .dockerignore"
  echo "    docker compose up -d --build"
  echo "  或一键升到已修复版本:"
  echo "    curl -sSL https://raw.githubusercontent.com/${GITHUB_REPO}/main/deploy/install.sh | sudo bash -s -- upgrade"
  echo ""
}

guide_auth_error() {
  local port
  port="$(env_get PORT)"
  port="${port:-$DEFAULT_PORT}"
  echo ""
  warn "错误类型 2：管理台 Missing credentials / 鉴权失效"
  echo "  识别: 总览「加载失败」或 toast「鉴权失效，请重新登录」"
  echo "  处理: 打开登录页，不要直接进总览"
  echo "    http://127.0.0.1:${port}/cc#/login"
  if [ "${WROTE_DEFAULT_PASSWORD:-0}" = 1 ]; then
    echo "  默认账密: admin / 123456（本次写入的空密码默认值，登录后请改）"
  else
    echo "  已有密码见:"
    echo "    grep '^VM2API_ADMIN_PASSWORD=' ${INSTALL_DIR}/.env"
  fi
  echo ""
}

print_login_banner() {
  local port
  port="$(env_get PORT)"
  port="${port:-$DEFAULT_PORT}"
  echo ""
  info "管理台登录: http://127.0.0.1:${port}/cc#/login"
  info "探活:       curl -sS --noproxy '*' http://127.0.0.1:${port}/health"
  if [ "${WROTE_DEFAULT_PASSWORD:-0}" = 1 ]; then
    info "默认账号:   ${DEFAULT_ADMIN_USER}"
    info "默认密码:   ${DEFAULT_ADMIN_PASSWORD}（仅空字段写入；请登录后尽快改）"
  else
    info "管理台密码见 ${INSTALL_DIR}/.env 的 VM2API_ADMIN_PASSWORD"
  fi
  info "若总览报鉴权失效: 先打开上面的登录页"
}

ensure_build_context() {
  local ignore="${INSTALL_DIR}/.dockerignore"
  local changelog="${INSTALL_DIR}/CHANGELOG.md"
  local version="${INSTALL_DIR}/VERSION"
  if [ ! -f "$version" ]; then
    err "缺少 ${version}。控制面镜像无法构建。"
    guide_changelog_error
    exit 1
  fi
  if [ ! -f "$changelog" ]; then
    err "缺少 ${changelog}。Docker 会报 COPY CHANGELOG.md not found。"
    guide_changelog_error
    exit 1
  fi
  if [ -f "$ignore" ] && ! grep -qE '^!CHANGELOG\.md$' "$ignore"; then
    echo '!CHANGELOG.md' >>"$ignore"
    warn "已在 .dockerignore 补上 !CHANGELOG.md（避免 *.md 挡住构建）"
  fi
}

ensure_env() {
  local envf="${INSTALL_DIR}/.env"
  if [ ! -f "$envf" ]; then
    local example="${INSTALL_DIR}/.env.example"
    if [ ! -f "$example" ]; then
      err "没有 .env.example，无法生成 .env"
      exit 1
    fi
    cp "$example" "$envf"
  fi
  chmod 600 "$envf" || true
  env_set_if_empty VM2API_ADMIN_USER "$DEFAULT_ADMIN_USER" || true
  if env_set_if_empty VM2API_ADMIN_PASSWORD "$DEFAULT_ADMIN_PASSWORD"; then
    WROTE_DEFAULT_PASSWORD=1
    ok "已补默认管理台账密  ${DEFAULT_ADMIN_USER} / ${DEFAULT_ADMIN_PASSWORD}（只填空，已有密码未改）"
  else
    info "保留已有管理台密码"
  fi
  env_set_if_empty VM2API_API_KEY "$(gen_secret)" || true
  env_set_if_empty VM2API_DB_SECRET "$(gen_secret)" || true
  chmod 600 "$envf" || true
}

wait_health() {
  local port url i
  port="$(grep -E '^PORT=' "${INSTALL_DIR}/.env" 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
  port="${port:-$DEFAULT_PORT}"
  url="http://127.0.0.1:${port}/health"
  info "等待控制面 ${url}"
  for i in $(seq 1 45); do
    if curl -fsS --noproxy '*' "$url" >/dev/null 2>&1; then
      ok "探活通过"
      return 0
    fi
    sleep 2
  done
  warn "探活超时。看日志: docker logs ${SERVICE_NAME}"
  return 1
}

read_env_key() {
  local name="$1"
  grep -E "^${name}=" "${INSTALL_DIR}/.env" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d "'" | tr -d '"'
}

pause_schedulable_slots() {
  local key="$1" port="$2" response
  info "暂停可调度槽，等待在途请求"
  response="$(curl -fsS -X POST "http://127.0.0.1:${port}/api/panel/vms/schedule/hold" \
    -H "Authorization: Bearer ${key}" \
    -H "Content-Type: application/json" \
    -d '{"reason":"kernel_update"}')" || return 1
  printf '%s' "$response" | python3 -c 'import json, sys
d = json.load(sys.stdin)
r = d.get("data") or {}
paused = int(r.get("paused") or 0)
inflight = int(r.get("inflight") or 0)
print(f"schedule hold: paused={paused} inflight={inflight}")
raise SystemExit(0 if d.get("ok") else 1)'
}

resume_schedulable_slots() {
  local key="$1" port="$2" response
  response="$(curl -fsS -X POST "http://127.0.0.1:${port}/api/panel/vms/schedule/resume" \
    -H "Authorization: Bearer ${key}" \
    -H "Content-Type: application/json" \
    -d '{"reason":"kernel_update"}')" || return 1
  printf '%s' "$response" | python3 -c 'import json, sys
d = json.load(sys.stdin)
r = d.get("data") or {}
restored = int(r.get("restored") or 0)
print(f"schedule resume: restored={restored}")
raise SystemExit(0 if d.get("ok") else 1)'
}

sync_wrap_cli() {
  local key port response changed
  key="$(read_env_key VM2API_API_KEY)"
  port="$(read_env_key PORT)"
  port="${port:-$DEFAULT_PORT}"
  if [ -z "$key" ]; then
    warn "没有 VM2API_API_KEY，跳过 wrap-cli/sync。可稍后："
    echo "  curl -sS -X POST http://127.0.0.1:${port}/api/panel/wrap-cli/sync -H \"Authorization: Bearer \$VM2API_API_KEY\" -H 'Content-Type: application/json' -d '{\"restart\":true}'"
    return 1
  fi
  info "检查槽内 kernel 是否变化"
  response="$(curl -fsS -X POST "http://127.0.0.1:${port}/api/panel/wrap-cli/sync" \
    -H "Authorization: Bearer ${key}" \
    -H "Content-Type: application/json" \
    -d '{"restart":false}')" || return 1
  probe="$(printf '%s' "$response" | python3 -c 'import json, sys
d = json.load(sys.stdin)
r = d.get("data") or {}
failed = int(r.get("failed_count") or 0)
total = int(r.get("total") or 0)
changed = int(r.get("changed_count") or 0)
print(f"wrap-cli/check: changed={changed}/{total}, failed={failed}", file=sys.stderr)
if not d.get("ok") or failed:
    raise SystemExit(2)
print("1" if changed else "0")')" || return 1
  if [ "$probe" != "1" ]; then
    ok "kernel 未变化，跳过停调度和重启"
    return 0
  fi
  pause_schedulable_slots "$key" "$port" || { resume_schedulable_slots "$key" "$port" || true; return 1; }
  info "kernel 已变化，重启受影响的槽"
  response="$(curl -fsS -X POST "http://127.0.0.1:${port}/api/panel/wrap-cli/sync" \
    -H "Authorization: Bearer ${key}" \
    -H "Content-Type: application/json" \
    -d '{"restart":true}')" || { resume_schedulable_slots "$key" "$port" || true; return 1; }
  resume_schedulable_slots "$key" "$port" || return 1
  printf '%s' "$response" | python3 -c 'import json, sys
d = json.load(sys.stdin)
r = d.get("data") or {}
failed = int(r.get("failed_count") or 0)
total = int(r.get("total") or 0)
ok = int(r.get("ok_count") or 0)
print(f"wrap-cli/sync: {ok}/{total}, failed={failed}")
raise SystemExit(0 if d.get("ok") and failed == 0 else 1)'
  ok "槽内 kernel 已更新"
}

RAW_BASE="https://raw.githubusercontent.com/${GITHUB_REPO}"

# 有 .git 就是源码安装（本机构建），否则是镜像安装（只拉预构建镜像）。
install_mode() {
  if [ -d "${INSTALL_DIR}/.git" ]; then
    echo source
  else
    echo image
  fi
}

fetch_file() {
  local tag="$1" rel="$2" dest="$3" optional="${4:-0}"
  if curl -fsSL --connect-timeout 10 --max-time 60 "${RAW_BASE}/${tag}/${rel}" -o "${dest}.new"; then
    mv -f "${dest}.new" "$dest"
    return 0
  fi
  rm -f "${dest}.new"
  if [ "$optional" = 1 ]; then
    return 0
  fi
  err "下载失败: ${RAW_BASE}/${tag}/${rel}"
  exit 1
}

# 镜像安装：只落部署文件，不 clone 仓库，不在本机构建。
fetch_release_files() {
  local tag="$1"
  mkdir -p "${INSTALL_DIR}/deploy"
  info "下载部署文件 ${tag} → ${INSTALL_DIR}"
  fetch_file "$tag" docker-compose.yml "${INSTALL_DIR}/docker-compose.yml"
  fetch_file "$tag" .env.example "${INSTALL_DIR}/.env.example"
  fetch_file "$tag" VERSION "${INSTALL_DIR}/VERSION"
  fetch_file "$tag" CHANGELOG.md "${INSTALL_DIR}/CHANGELOG.md" 1
  fetch_file "$tag" deploy/install.sh "${INSTALL_DIR}/deploy/install.sh" 1
  chmod +x "${INSTALL_DIR}/deploy/install.sh" 2>/dev/null || true
  if [ "$HOST_ARCH" = arm64 ]; then
    fetch_file "$tag" deploy/prepare-arm64.py "${INSTALL_DIR}/deploy/prepare-arm64.py" 1
    if [ ! -f "${INSTALL_DIR}/deploy/prepare-arm64.py" ]; then
      err "${tag} 没有 ARM64 发布（缺 deploy/prepare-arm64.py）。请选择带 ARM64 镜像的版本。"
      exit 1
    fi
  fi
  mkdir -p "${INSTALL_DIR}/vms" "${INSTALL_DIR}/data" "${INSTALL_DIR}/bin" \
    "${INSTALL_DIR}/share" "${INSTALL_DIR}/src/config"
}

# 安装目录写进 .env：面板一键更新的 helper 容器按它挂载宿主目录。
# 源码安装再写 COMPOSE_FILE，让裸 docker compose（包括面板更新）也按本机 checkout 构建：
# amd64 叠 docker-compose.build.yml（基础文件只拉镜像），ARM64 叠 arm64 override，
# 不会退回基础服务和 ./vms、./data。
prepare_arch_env() {
  local mode="$1"
  env_set_if_empty VM2API_HOST_ROOT "${INSTALL_DIR}" || true
  if [ "$mode" != source ]; then
    return 0
  fi
  if [ "$HOST_ARCH" != arm64 ]; then
    env_set_if_empty COMPOSE_FILE "docker-compose.yml:docker-compose.build.yml" || true
    return 0
  fi
  if [ ! -f "${INSTALL_DIR}/docker-compose.arm64.yml" ]; then
    err "该版本没有 ARM64 部署文件 docker-compose.arm64.yml"
    exit 1
  fi
  env_set_if_empty COMPOSE_FILE "docker-compose.yml:docker-compose.arm64.yml" || true
}

# ARM64 槽位是 linux/amd64 镜像，宿主需要固定版本的 qemu-x86_64 binfmt handler。
prepare_arm64_host() {
  local script="${INSTALL_DIR}/deploy/prepare-arm64.py"
  if [ "$HOST_ARCH" != arm64 ] || [ "$NO_START" = 1 ]; then
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    err "ARM64 需要 python3 来准备 QEMU：apt-get install -y python3"
    exit 1
  fi
  info "ARM64：准备 x86_64 QEMU handler（槽位镜像为 linux/amd64）"
  if ! python3 "$script" || ! python3 "$script" --check; then
    err "QEMU 准备失败，按上方提示处理，详见 docs/ARM64.md"
    exit 1
  fi
}

checkout_tag() {
  local tag="$1"
  cd "${INSTALL_DIR}"
  if [ ! -d .git ]; then
    err "${INSTALL_DIR} 不是 git 仓库。请重新安装，或手动 git clone。"
    exit 1
  fi
  ensure_git_safe
  info "fetch tags"
  # History was rewritten once to drop build artifacts; --force lets old clones take the new tags.
  git fetch --force --tags origin
  if ! git rev-parse -q --verify "refs/tags/${tag}" >/dev/null && \
     ! git rev-parse -q --verify "origin/${tag}" >/dev/null && \
     ! git cat-file -t "${tag}" >/dev/null 2>&1; then
    # fetch may have created the tag
    if ! git ls-remote --tags origin "refs/tags/${tag}" | grep -q .; then
      err "找不到 tag ${tag}"
      exit 1
    fi
  fi
  info "checkout ${tag}（不碰 .env / vms / data）"
  git checkout -f "${tag}"
  chmod 755 bin/kin-* 2>/dev/null || true
}

fresh_clone() {
  local tag="$1"
  if [ -d "${INSTALL_DIR}/.git" ]; then
    info "已有仓库，改为升级路径"
    checkout_tag "$tag"
    return
  fi
  if [ -e "${INSTALL_DIR}" ] && [ -n "$(ls -A "${INSTALL_DIR}" 2>/dev/null || true)" ]; then
    err "${INSTALL_DIR} 已存在且不是 git 仓库"
    exit 1
  fi
  info "clone ${GITHUB_REPO} → ${INSTALL_DIR}"
  git clone --branch "$tag" --depth 1 "https://github.com/${GITHUB_REPO}.git" "${INSTALL_DIR}" \
    || git clone "https://github.com/${GITHUB_REPO}.git" "${INSTALL_DIR}"
  cd "${INSTALL_DIR}"
  ensure_git_safe
  git fetch --force --tags origin
  git checkout -f "$tag"
  chmod 755 bin/kin-* 2>/dev/null || true
}

start_stack() {
  local mode auto_sync_wrap log
  mode="$(install_mode)"
  if [ "$NO_START" = 1 ]; then
    warn "--no-start：跳过 compose up"
    return
  fi
  cd "${INSTALL_DIR}"
  auto_sync_wrap="${KIN_AUTO_SYNC_WRAP:-0}"
  if [ "$mode" = image ]; then
    info "docker compose pull && up -d（拉预构建镜像，本机不构建）"
    if ! compose pull; then
      if [ "$HOST_ARCH" = arm64 ]; then
        err "拉取 ARM64 控制面镜像失败：检查网络，并确认该版本已发布 $(env_get VM2API_IMAGE_TAG) 镜像。"
      else
        err "拉取控制面镜像失败。检查网络与 registry 可达性，或用 --from-source 走本机构建。"
      fi
      exit 1
    fi
    if KIN_AUTO_SYNC_WRAP="$auto_sync_wrap" compose up -d; then
      wait_health || true
      refresh_slot_services
      return
    fi
    err "docker compose 失败。日志: docker logs ${SERVICE_NAME}"
    exit 1
  fi
  ensure_build_context
  info "docker compose up -d --build（源码模式；只重建控制面，不 docker rm 槽）"
  log="$(mktemp)"
  if KIN_AUTO_SYNC_WRAP="$auto_sync_wrap" compose up -d --build >"$log" 2>&1; then
    cat "$log"
    rm -f "$log"
    wait_health || true
    refresh_slot_services
    return
  fi
  cat "$log"
  if grep -qE 'CHANGELOG\.md|"/CHANGELOG\.md": not found' "$log"; then
    warn "compose 因 CHANGELOG.md 失败，补 .dockerignore 后重试一次"
    ensure_build_context
    if KIN_AUTO_SYNC_WRAP="$auto_sync_wrap" compose up -d --build; then
      rm -f "$log"
      wait_health || true
      refresh_slot_services
      return
    fi
    guide_changelog_error
    rm -f "$log"
    exit 1
  fi
  err "docker compose 失败"
  guide_changelog_error
  rm -f "$log"
  exit 1
}

refresh_slot_services() {
  # The control-plane image carries the freshly built Go binaries. Publish them
  # into persistent slot-bin mounts and restart only kin-worker/kin-egress.
  # A stale kin-egress can keep the old binary and its listen port after this
  # refresh. Leaving that as a warning reports the upgrade done while the old
  # exit is still serving traffic.
  if ! docker exec "$SERVICE_NAME" test -f /opt/vm2api/scripts/fleet-services.mjs >/dev/null 2>&1; then
    err "控制面缺少 Go 服务刷新脚本，不能确认 kin-egress 已换到当前二进制"
    exit 1
  elif ! docker exec "$SERVICE_NAME" node /opt/vm2api/scripts/fleet-services.mjs; then
    err "Go slot service refresh failed; VM containers were left untouched, but kin-egress may still be the previous binary"
    exit 1
  fi
}

print_banner() {
  echo ""
  echo -e "${CYAN}==============================================${NC}"
  echo -e "${CYAN}  vm2api${NC}"
  echo -e "${CYAN}==============================================${NC}"
}

cmd_install() {
  need_root
  require_cmds
  resolve_host_arch
  print_banner
  local tag mode
  tag="${TARGET_VERSION:-$(latest_release_tag)}"
  tag="$(normalize_tag "$tag")"
  info "目标版本 ${tag}（linux/${HOST_ARCH}）"
  if [ "$FROM_SOURCE" = 1 ] || [ -d "${INSTALL_DIR}/.git" ]; then
    mode=source
    fresh_clone "$tag"
    ensure_git_safe
    ensure_env
  else
    mode=image
    fetch_release_files "$tag"
    ensure_env
    env_set VM2API_IMAGE_TAG "$(image_tag_for "$tag")"
  fi
  prepare_arch_env "$mode"
  prepare_arm64_host
  start_stack
  ok "安装完成  ${INSTALL_DIR}  @ $(local_version)"
  if [ "$NO_START" = 0 ] && [ "$SYNC_WRAP" = 1 ]; then
    sync_wrap_cli || { err "槽内 wrap CLI / kernel 同步失败，安装未完成"; exit 1; }
  fi

  print_login_banner
  info "以后更新: curl -sSL https://raw.githubusercontent.com/${GITHUB_REPO}/main/deploy/install.sh | sudo bash -s -- upgrade"
}

cmd_upgrade() {
  need_root
  require_cmds
  resolve_host_arch
  print_banner
  if [ ! -f "${INSTALL_DIR}/docker-compose.yml" ]; then
    err "未安装。先: curl -sSL https://raw.githubusercontent.com/${GITHUB_REPO}/main/deploy/install.sh | sudo bash"
    exit 1
  fi
  local current tag mode
  current="$(local_version)"
  tag="${TARGET_VERSION:-$(latest_release_tag)}"
  tag="$(normalize_tag "$tag")"
  info "当前 ${current}  →  目标 ${tag}（linux/${HOST_ARCH}）"
  if [ "v${current}" = "$tag" ]; then
    ok "已经是 ${tag}，仍会对齐镜像与部署文件"
  fi
  mode="$(install_mode)"
  if [ "$mode" = source ]; then
    checkout_tag "$tag"
    ensure_git_safe
    ensure_env
  else
    fetch_release_files "$tag"
    ensure_env
    env_set VM2API_IMAGE_TAG "$(image_tag_for "$tag")"
  fi
  prepare_arch_env "$mode"
  echo ""
  info "本版 changelog"
  print_changelog_slice "${INSTALL_DIR}/CHANGELOG.md" "$current" "$(version_of_tag "$tag")" || true
  local notes
  notes="$(release_notes "$tag" || true)"
  if [ -n "$notes" ]; then
    echo "$notes"
    echo ""
  fi
  prepare_arm64_host
  start_stack
  if [ "$NO_START" = 0 ] && [ "$SYNC_WRAP" = 1 ]; then
    sync_wrap_cli || { err "槽内 wrap CLI / kernel 同步失败，升级未完成"; exit 1; }

  elif [ "$NO_START" = 1 ]; then
    warn "--no-start：控制面未启动，已跳过槽内 CLI / kernel 同步"
  else
    warn "--no-sync-wrap：已跳过槽内 CLI / kernel 同步"
  fi
  ok "已更新到 $(local_version)"
  print_login_banner
}

cmd_check() {
  local current tag
  current="$(local_version)"
  tag="$(latest_release_tag)"
  echo "当前: ${current}"
  echo "最新: ${tag}"
  if [ "v${current}" = "$tag" ]; then
    ok "已是最新"
  else
    warn "有新版本 ${tag}"
    echo ""
    echo "一键更新:"
    echo "  curl -sSL https://raw.githubusercontent.com/${GITHUB_REPO}/main/deploy/install.sh | sudo bash -s -- upgrade"
    echo ""
    if [ -f "${INSTALL_DIR}/CHANGELOG.md" ]; then
      print_changelog_slice "${INSTALL_DIR}/CHANGELOG.md" "$current" "$(version_of_tag "$tag")" || true
    fi
    local notes
    notes="$(release_notes "$tag" || true)"
    if [ -n "$notes" ]; then
      echo "## ${tag} Release notes"
      echo "$notes"
    fi
  fi
}

cmd_changelog() {
  local file="${INSTALL_DIR}/CHANGELOG.md"
  if [ ! -f "$file" ]; then
    file="$(cd "$(dirname "$0")/.." && pwd)/CHANGELOG.md"
  fi
  if [ ! -f "$file" ]; then
    err "找不到 CHANGELOG.md"
    exit 1
  fi
  cat "$file"
}

cmd_status() {
  local current port
  current="$(local_version)"
  echo "目录:    ${INSTALL_DIR}"
  echo "版本:    ${current}"
  echo "架构:    $(arch_of "$(uname -m)" || true)  ($(uname -m))"
  if [ -f "${INSTALL_DIR}/.env" ] && [ -n "$(env_get VM2API_IMAGE_TAG)" ]; then
    echo "镜像:    $(env_get VM2API_IMAGE_TAG)"
  fi
  if [ -d "${INSTALL_DIR}/.git" ]; then
    echo "git:     $(git -C "${INSTALL_DIR}" describe --tags --always 2>/dev/null || echo unknown)"
  fi
  if command -v docker >/dev/null 2>&1; then
    docker ps --filter "name=${SERVICE_NAME}" --format '容器:    {{.Names}}  {{.Status}}' || true
  fi
  port="$(read_env_key PORT 2>/dev/null || true)"
  port="${port:-$DEFAULT_PORT}"
  if curl -fsS --noproxy '*' "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
    echo "探活:    ok  http://127.0.0.1:${port}/health"
  else
    echo "探活:    down"
  fi
}

cmd_uninstall() {
  need_root
  print_banner
  if [ "$ASSUME_YES" != 1 ] && is_interactive; then
    echo -n "停止并删除控制面容器，保留 .env / vms / data。继续? [y/N] " >/dev/tty
    read -r ans </dev/tty || true
    case "$ans" in
      y|Y|yes|YES) ;;
      *) info "已取消"; exit 0 ;;
    esac
  fi
  if [ -d "${INSTALL_DIR}" ]; then
    (cd "${INSTALL_DIR}" && compose down) || docker rm -f "${SERVICE_NAME}" 2>/dev/null || true
  fi
  ok "控制面已停。数据仍在 ${INSTALL_DIR}/{.env,vms,data}"
  info "若要整目录删除: rm -rf ${INSTALL_DIR}"
}

COMMAND="install"
while [ $# -gt 0 ]; do
  case "$1" in
    install|upgrade|update|check|changelog|status|uninstall)
      COMMAND="$1"
      shift
      ;;
    --version)
      if [ $# -lt 2 ]; then
        err "--version 需要参数，例如 v1.2.3 或 v1.2.3-arm64"
        exit 1
      fi
      REQUESTED_ARCH="$(suffix_arch "$2")"
      TARGET_VERSION="$(normalize_tag "$2")"
      if ! [[ "$TARGET_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        err "无效版本 $2：格式 vX.Y.Z，可带 -amd64 / -arm64 后缀"
        exit 1
      fi
      shift 2
      ;;
    --dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    --yes|-y)
      ASSUME_YES=1
      shift
      ;;
    --no-start)
      NO_START=1
      shift
      ;;
    --sync-wrap)
      SYNC_WRAP=1
      shift
      ;;
    --no-sync-wrap)
      SYNC_WRAP=0
      shift
      ;;
    --from-source)
      FROM_SOURCE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      err "未知参数: $1"
      usage
      exit 1
      ;;
  esac
done

case "$COMMAND" in
  install) cmd_install ;;
  upgrade|update) cmd_upgrade ;;
  check) cmd_check ;;
  changelog) cmd_changelog ;;
  status) cmd_status ;;
  uninstall) cmd_uninstall ;;
  *) usage; exit 1 ;;
esac
