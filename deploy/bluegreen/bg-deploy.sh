#!/usr/bin/env bash
# vm2api 蓝绿部署：新请求不挂起，旧实例在后台跑完长流。说明见 docs/BLUEGREEN.md。
#
#   bg-deploy.sh --bootstrap   一次性：把单容器部署换成 blue + haproxy（这一次会短暂中断）
#   bg-deploy.sh               把 compose/.env 当前描述的版本部署到空闲颜色并切流量
#   bg-deploy.sh --wait        同上，但前台等旧实例排空结束
#   bg-deploy.sh --status      看颜色、角色、haproxy 状态
#
# 顺序（见 src/lib/core/handover.mjs）：
#   1 新颜色以 standby 启动（不拿锁、不跑后台任务、不改共享文件），预热完报 standby-warm
#   2 旧实例 SIGUSR1：停后台任务、释放数据目录锁，监听不关
#   3 新实例 SIGUSR2：拿锁、激活；重叠期内推迟重建出口/gate、重启内核、备份
#   4 haproxy：新 ready、旧 drain（不断已有连接）
#   5 旧实例 SIGTERM：最长排空 BG_DRAIN_MS（默认 60 分钟），不阻塞新请求
#   6 旧实例退出后给新实例 SIGHUP：同步共享二进制、补做推迟的维护
#
# 配置（环境变量，或写进 <状态目录>/bg.env）：
#   BG_PROJECT_DIR      安装目录（默认本脚本上两级）
#   BG_STATE_DIR        状态目录（默认 $BG_PROJECT_DIR/bluegreen：active、container、deploy.log）
#   BG_HOST             探活和 haproxy 后端用的地址（默认 127.0.0.1）
#   BG_BLUE_PORT / BG_GREEN_PORT   两个颜色的监听端口（默认 8788 / 8789）
#   BG_HAPROXY_SOCK     haproxy admin socket（默认 /run/haproxy/admin.sock）
#   BG_HAPROXY_BACKEND  haproxy backend 名（默认 app，里面要有 server blue / server green）
#   BG_HAPROXY_STATE    server-state-file 路径（默认 /var/lib/haproxy/server-state）
#   BG_COMPOSE_FILES    基础 compose 文件，空格分隔（默认 docker-compose.yml [+ docker-compose.override.yml]）
#   BG_SERVICE          compose 服务名（默认 vm2api）
#   BG_NAME             容器/项目名前缀（默认 vm2api → vm2api-blue / vm2api-green）
#   BG_DRAIN_MS         旧实例最长排空毫秒（默认 3600000）
# 站点自己的额外挂载/环境（补丁、调试开关）放 <状态目录>/override.yml，存在就叠在最后。
set -euo pipefail

BG_PROJECT_DIR=${BG_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
BG_STATE_DIR=${BG_STATE_DIR:-$BG_PROJECT_DIR/bluegreen}
# shellcheck disable=SC1091
[[ -f $BG_STATE_DIR/bg.env ]] && . "$BG_STATE_DIR/bg.env"
BG_HOST=${BG_HOST:-127.0.0.1}
BG_BLUE_PORT=${BG_BLUE_PORT:-8788}
BG_GREEN_PORT=${BG_GREEN_PORT:-8789}
BG_HAPROXY_SOCK=${BG_HAPROXY_SOCK:-/run/haproxy/admin.sock}
BG_HAPROXY_BACKEND=${BG_HAPROXY_BACKEND:-app}
BG_HAPROXY_STATE=${BG_HAPROXY_STATE:-/var/lib/haproxy/server-state}
BG_SERVICE=${BG_SERVICE:-vm2api}
BG_NAME=${BG_NAME:-vm2api}
BG_DRAIN_MS=${BG_DRAIN_MS:-3600000}
KIT_DIR=$BG_PROJECT_DIR/deploy/bluegreen

cd "$BG_PROJECT_DIR"
mkdir -p "$BG_STATE_DIR"
if [[ -z ${BG_COMPOSE_FILES:-} ]]; then
  BG_COMPOSE_FILES=docker-compose.yml
  [[ -f docker-compose.override.yml ]] && BG_COMPOSE_FILES+=" docker-compose.override.yml"
fi
compose_args=(-f "$KIT_DIR/compose.bluegreen.yml")
[[ -f $BG_STATE_DIR/override.yml ]] && compose_args+=(-f "$BG_STATE_DIR/override.yml")
LOG=$BG_STATE_DIR/deploy.log

log() { echo "[bg $(date -u +%FT%TZ)] $*" | tee -a "$LOG" >&2; }
hap() { echo "$1" | socat - "UNIX-CONNECT:$BG_HAPROXY_SOCK"; }
hap_set() { hap "set server $BG_HAPROXY_BACKEND/$1 state $2" >/dev/null; }
hap_save() { hap "show servers state" >"$BG_HAPROXY_STATE"; }
port() { if [[ $1 == blue ]]; then echo "$BG_BLUE_PORT"; else echo "$BG_GREEN_PORT"; fi; }
cname() { echo "$BG_NAME-$1"; }
dc() { # dc <color> <compose args...>
  local c=$1 f files=()
  shift
  for f in $BG_COMPOSE_FILES; do files+=(-f "$f"); done
  BG_COLOR=$c BG_PORT=$(port "$c") BG_DRAIN_MS=$BG_DRAIN_MS BG_NAME=$BG_NAME \
    VM2API_CONTAINER_NAME=$(cname "$c") \
    docker compose -p "$(cname "$c")" "${files[@]}" "${compose_args[@]}" "$@"
}
healthz() { curl -fsS -m 3 "http://$BG_HOST:$(port "$1")/healthz" 2>/dev/null; }
role() { { healthz "$1" || true; } | sed -n 's/.*"role":"\([a-z]*\)".*/\1/p'; }
alive() { [[ $(docker inspect -f '{{.State.Running}}' "$(cname "$1")" 2>/dev/null) == true ]]; }
wait_log() { # wait_log <container> <since> <regex> <seconds>
  local i
  for ((i = 0; i < $4 * 2; i++)); do
    docker logs --since "$2" "$1" 2>&1 | grep -qE "$3" && return 0
    sleep 0.5
  done
  return 1
}
other() { if [[ $1 == blue ]]; then echo green; else echo blue; fi; }
# 宿主上要 docker exec 控制面的脚本读这个文件找当前容器
point_container() { cname "$1" >"$BG_STATE_DIR/container"; }

# 6 旧实例退出后收尾（部署时在后台以 --finish 重新调用本脚本）
finish() { # finish <old> <new>
  local old=$1 new=$2
  docker wait "$(cname "$old")" >/dev/null 2>&1 || true
  dc "$old" down --timeout 5 >/dev/null 2>&1 || true
  hap_set "$old" maint
  hap_save
  docker kill --signal=HUP "$(cname "$new")" >/dev/null
  log "$old exited; $new exclusive pass started"
}

active=$(cat "$BG_STATE_DIR/active" 2>/dev/null || echo none)
mode=${1:-}

case "$mode" in
--status)
  echo "active=$active container=$(cat "$BG_STATE_DIR/container" 2>/dev/null)"
  for c in blue green; do
    r=$(role "$c")
    h=$(healthz "$c" >/dev/null && echo up || echo down)
    [[ $h == up && -z $r ]] && r=leader
    echo "$c: running=$(alive "$c" && echo yes || echo no) http=$h role=${r:--}"
  done
  hap "show servers state $BG_HAPROXY_BACKEND" | awk 'NR>2 && NF {print "haproxy", $4, "admin_state=" $7, "op_state=" $6}'
  exit 0
  ;;
--finish)
  finish "$2" "$3"
  exit 0
  ;;
--bootstrap)
  [[ $active == none ]] || { echo "already bootstrapped (active=$active)" >&2; exit 1; }
  command -v socat >/dev/null || { echo "socat is required (apt install socat)" >&2; exit 1; }
  hap "show servers state $BG_HAPROXY_BACKEND" | grep -q " blue " &&
    hap "show servers state $BG_HAPROXY_BACKEND" | grep -q " green " || {
    echo "haproxy backend $BG_HAPROXY_BACKEND needs servers blue and green; install deploy/bluegreen/haproxy.cfg.example first" >&2
    exit 1
  }
  log "bootstrap: replacing the single $BG_NAME container with $(cname blue)"
  mkdir -p "$(dirname "$BG_HAPROXY_STATE")" data/run
  touch data/run/bg-active-blue
  point_container blue
  if docker inspect "$BG_NAME" >/dev/null 2>&1; then docker compose down --timeout 100; fi
  dc blue up -d
  for _ in $(seq 1 180); do healthz blue >/dev/null && break; sleep 1; done
  healthz blue >/dev/null || { log "FAILED: blue did not come up"; exit 1; }
  echo blue >"$BG_STATE_DIR/active"
  hap_set blue ready
  hap_set green maint
  hap_save
  log "bootstrap done: blue on :$BG_BLUE_PORT"
  exit 0
  ;;
"" | --wait) ;;
*)
  echo "usage: $0 [--bootstrap|--status|--wait]" >&2
  exit 1
  ;;
esac

[[ $active == blue || $active == green ]] || { echo "no active color; run --bootstrap first" >&2; exit 1; }
old=$active
new=$(other "$old")
alive "$old" || { echo "active $old is not running" >&2; exit 1; }
r=$(role "$old")
[[ -z $r ]] || { echo "active $old reports role=$r, expected leader" >&2; exit 1; }
alive "$new" && { echo "$(cname "$new") still running (old drain not finished?)" >&2; exit 1; }
log "deploy: $old -> $new"

# 预检：compose 能渲染；挂进来的项目内文件都在；挂载的入口脚本可执行（丢了 x 位容器会一直 126 重启）
dc "$new" config -q || { echo "compose config for $new does not render" >&2; exit 1; }
rendered=$(dc "$new" config)
while read -r src; do
  [[ -e $src ]] || { echo "mounted file missing: $src" >&2; exit 1; }
done < <(awk -v root="$BG_PROJECT_DIR/" '$1 == "source:" && index($2, root) == 1 {print $2}' <<<"$rendered")
entry=$(awk '$1 == "source:" {src = $2} $1 == "target:" && $2 == "/usr/local/bin/vm2api-entrypoint" {print src; exit}' <<<"$rendered")
[[ -z $entry || -x $entry ]] || { echo "entrypoint $entry is not executable (chmod +x)" >&2; exit 1; }

# 迁移护栏：新镜像带新迁移时两个控制面不能共用库，退回停机重启
dc "$new" pull -q "$BG_SERVICE" || true
mig_old=$(docker exec "$(cname "$old")" ls /opt/vm2api/src/lib/db/migrations | sort)
mig_new=$(dc "$new" run --rm --no-deps -T --entrypoint ls "$BG_SERVICE" /opt/vm2api/src/lib/db/migrations | sort)
added=$(comm -13 <(echo "$mig_old") <(echo "$mig_new"))
if [[ -n $added ]]; then
  log "new image adds migrations: $(echo "$added" | tr '\n' ' ')"
  log "refusing blue/green; deploy this release with a plain restart (see docs/BLUEGREEN.md)"
  exit 2
fi

# 1 standby
rm -f "data/run/bg-active-$new"
dc "$new" down --timeout 5 >/dev/null 2>&1 || true
since=$(date -u +%Y-%m-%dT%H:%M:%S)
dc "$new" up -d
abort() { log "FAILED: $*; removing $new, $old keeps serving"; dc "$new" down --timeout 5 || true; exit 1; }
wait_log "$(cname "$new")" "$since" '"event":"vm2api-started"' 180 || abort "standby did not start"
[[ $(role "$new") == standby ]] || abort "$new did not boot as standby"
log "$new standby up"
# 预热：standby 先算完槽镜像摘要、连上节点链路，激活后首批请求不再卡事件循环
if wait_log "$(cname "$new")" "$since" '"event":"standby-warm"' 90; then
  log "$new warm: $(docker logs --since "$since" "$(cname "$new")" 2>&1 | grep -o '"event":"standby-warm".*' | tail -1)"
else
  log "$new did not report standby-warm within 90s; activating anyway"
fi

# 2 旧实例让出领导权
since=$(date -u +%Y-%m-%dT%H:%M:%S)
docker kill --signal=USR1 "$(cname "$old")" >/dev/null
wait_log "$(cname "$old")" "$since" '"event":"handover-released","ok":true' 20 || abort "$old did not release the lock"

# 3 新实例激活（marker 先写：之后新容器若重启，直接以 leader 启动）
touch "data/run/bg-active-$new"
since=$(date -u +%Y-%m-%dT%H:%M:%S)
docker kill --signal=USR2 "$(cname "$new")" >/dev/null
if ! wait_log "$(cname "$new")" "$since" '"event":"standby-activated"' 40; then
  # 旧实例已停后台任务、没有锁：重启它（会中断一次）让它重新做 leader
  rm -f "data/run/bg-active-$new"
  dc "$new" down --timeout 5 || true
  log "FAILED: $new did not activate; restarting $old as leader"
  docker restart -t 100 "$(cname "$old")"
  exit 1
fi
log "$new is leader"

# 4 切流量
hap_set "$new" ready
hap_set "$old" drain
hap_save
echo "$new" >"$BG_STATE_DIR/active"
point_container "$new"
rm -f "data/run/bg-active-$old"
log "traffic on $new (:$(port "$new")); $old draining"

# 5 旧实例长排空（不阻塞）
docker update --restart=no "$(cname "$old")" >/dev/null
docker kill --signal=TERM "$(cname "$old")" >/dev/null

if [[ $mode == --wait ]]; then
  finish "$old" "$new"
else
  nohup setsid "${BASH_SOURCE[0]}" --finish "$old" "$new" >/dev/null 2>&1 &
  log "drain watcher running in background (pid $!); see $LOG"
fi
