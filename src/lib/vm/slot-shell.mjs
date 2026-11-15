/**
 * Panel terminal into a slot's container: `docker exec -it` over the Engine
 * API, bridged to a browser WebSocket. Browsers cannot put Authorization on a
 * WebSocket handshake, so `POST /api/panel/vms/:id/shell-ticket` (panel auth +
 * ACL) trades the session for a 30s single-use ticket, same contract as the
 * cluster node shell. Wire protocol matches it too:
 *   client → {t:'d', d} input · {t:'r', c, r} resize
 *   server → binary output · {t:'exit', code} · {t:'error', message}
 */

import path from 'node:path'
import crypto from 'node:crypto'
import { WebSocketServer } from 'ws'
import { execCapture, execDetached, inspectExec, openExecTty, resizeExec } from '../cluster/docker-remote.mjs'
import { slotHost } from './slot-host.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { isKvmRuntime } from './runtime-kind.mjs'
import { slotExecCmd, slotExecContainer } from './slot-exec.mjs'
import { getVm } from './vm-registry.mjs'
import {
  assertAuthLoginReady,
  nativeLoginLaunch,
  readNativeLoginOauth,
  resolveAuthLoginClaude,
} from '../oauth/claude-auth-login.mjs'
import { prepareClaudeClientCredentials } from '../transport/go-worker-client.mjs'
import { slotExec } from './slot-runtime.mjs'
import { hasBoundExit } from './egress.mjs'
import { proxyBlockedReason } from './proxy-policy.mjs'

const SHELL_RE = /^\/api\/panel\/vms\/([^/]+)\/shell$/
const TICKET_TTL_MS = 30_000
const MAX_TICKETS = 64
const MAX_SESSIONS = 8
const SESSION_ENV = 'KIN_PANEL_SHELL'
const RC_ENV = 'KIN_PANEL_RC'
const CREDENTIAL_SYNC_INTERVAL_MS = 60_000

/** Live guest MOTD. Optional probes must not fail startup or print secrets. */
const SYSTEM_FACTS_RC = [
  'case $- in *i*)',
  '(set +e',
  "tab=$(printf '\\t')",
  'nvl() {',
  '  v=$1',
  '  case "$v" in',
  "    ''|none|None|NONE|null|NULL|n/a|N/A|NotSpecified|NotApplicable|00000000-0000-0000-0000-000000000000|00:00:00:00:00:00) printf %s 未采集 ;;",
  "    'To be filled by O.E.M.'|'Default string'|'Not Specified'|'Not Applicable'|'System Serial Number') printf %s 未采集 ;;",
  '    *) printf %s "$v" ;;',
  '  esac',
  '}',
  'hsize() {',
  '  kb=$1',
  '  case "$kb" in *[!0-9]*|\'\') printf %s unknown; return ;; esac',
  '  if [ "$kb" -ge 1048576 ]; then printf %sG $(( (kb + 524288) / 1048576 ))',
  '  elif [ "$kb" -ge 1024 ]; then printf %sM $(( (kb + 512) / 1024 ))',
  '  else printf %sk "$kb"; fi',
  '}',
  'rd() {',
  '  [ -r "$1" ] || { printf %s 未采集; return; }',
  '  IFS= read -r x < "$1" || x=',
  '  nvl "$x"',
  '}',
  'num() {',
  '  x=',
  '  [ -r "$1" ] && { IFS= read -r x < "$1" || :; }',
  '  case "$x" in 0|*[!0-9]*) x= ;; esac',
  '  printf %s "$x"',
  '}',
  // Docker slots see the host in /proc and /sys/class/dmi; the slot computer and cgroup limits win.
  'khw=${KIN_HW_DIR:-/etc/kin-hardware}',
  'kdmi=${KIN_DMI_DIR:-/etc/kin-dmi}',
  'kcg=${KIN_CGROUP_DIR:-/sys/fs/cgroup}',
  'host=$(hostname 2>/dev/null || uname -n 2>/dev/null || printf %s unknown)',
  '[ -n "$host" ] || host=unknown',
  'os_pretty=unknown',
  'os_id=unknown',
  'if [ -r /etc/os-release ]; then',
  '  while IFS= read -r line || [ -n "$line" ]; do',
  '    case "$line" in',
  '      PRETTY_NAME=*) os_pretty=${line#PRETTY_NAME=}; os_pretty=${os_pretty#\\"}; os_pretty=${os_pretty%\\"} ;;',
  '      ID=*) os_id=${line#ID=}; os_id=${os_id#\\"}; os_id=${os_id%\\"} ;;',
  '    esac',
  '  done < /etc/os-release',
  'fi',
  '[ -n "$os_pretty" ] || os_pretty=unknown',
  '[ -n "$os_id" ] || os_id=unknown',
  'krel=$(uname -r 2>/dev/null || printf %s unknown)',
  'kmach=$(uname -m 2>/dev/null || printf %s unknown)',
  '[ -n "$krel" ] || krel=unknown',
  '[ -n "$kmach" ] || kmach=unknown',
  'cpu_model=unknown',
  'cpu_n=0',
  'if [ -r /proc/cpuinfo ]; then',
  '  while IFS= read -r line || [ -n "$line" ]; do',
  '    case "$line" in',
  '      [Pp]rocessor*) cpu_n=$((cpu_n + 1)) ;;',
  '      "model name"*|"Model name"*|"cpu model"*|Hardware*)',
  '        if [ "$cpu_model" = unknown ]; then',
  '          cpu_model=${line#*:}',
  '          cpu_model=${cpu_model# }',
  '          cpu_model=${cpu_model#$tab}',
  '          [ -n "$cpu_model" ] || cpu_model=unknown',
  '        fi ;;',
  '    esac',
  '  done < /proc/cpuinfo',
  'fi',
  'n=0',
  'for d in /sys/devices/system/cpu/cpu[0-9]*; do',
  '  [ -d "$d" ] && n=$((n + 1))',
  'done',
  '[ "$n" -gt 0 ] && cpu_n=$n',
  '[ "$cpu_n" -gt 0 ] 2>/dev/null || cpu_n=unknown',
  'if [ -r "$khw/cpu_brand" ]; then IFS= read -r x < "$khw/cpu_brand" || x=; [ -z "$x" ] || cpu_model=$x; fi',
  'q=; p=; lim=',
  'if [ -r "$kcg/cpu.max" ]; then read -r q p < "$kcg/cpu.max" || :',
  'else q=$(num "$kcg/cpu/cpu.cfs_quota_us"); p=$(num "$kcg/cpu/cpu.cfs_period_us"); fi',
  'case "$q" in \'\'|*[!0-9]*) ;; *) case "$p" in \'\'|0|*[!0-9]*) ;; *) lim=$(( (q + p - 1) / p )) ;; esac ;; esac',
  '[ -n "$lim" ] || lim=$(num "$khw/logical_cpus")',
  '[ -z "$lim" ] || cpu_n=$lim',
  'mem=unknown',
  'if [ -r /proc/meminfo ]; then',
  '  while IFS= read -r line; do',
  '    case "$line" in',
  '      MemTotal:*) set -- $line; mem=$(hsize "$2"); break ;;',
  '    esac',
  '  done < /proc/meminfo',
  'fi',
  'b=$(num "$kcg/memory.max")',
  '[ -n "$b" ] || b=$(num "$kcg/memory/memory.limit_in_bytes")',
  '[ ${#b} -lt 19 ] || b=',
  '[ -n "$b" ] || b=$(num "$khw/ram_bytes")',
  '[ -z "$b" ] || mem=$(hsize $((b / 1024)))',
  'disk=未采集',
  'df_out=$(df -kP / 2>/dev/null || df -k / 2>/dev/null)',
  'if [ -n "$df_out" ]; then',
  '  nl="',
  '"',
  '  body=${df_out#*"$nl"}',
  '  line=${body%%"$nl"*}',
  '  set -- $line',
  '  case "$2" in *[!0-9]*|\'\') ;; *) disk=$(hsize "$2") ;; esac',
  'fi',
  'mac=未采集',
  'if [ -r "$khw/mac" ]; then IFS= read -r x < "$khw/mac" || x=; case "$x" in \'\'|00:00:00:00:00:00) ;; *) mac=$x ;; esac; fi',
  'for pass in up any; do',
  '  [ "$mac" = 未采集 ] || break',
  '  for n in /sys/class/net/*; do',
  '    [ -r "$n/address" ] && [ -r "$n/type" ] || continue',
  '    iface=${n##*/}',
  '    case "$iface" in lo|docker0|br-*|veth*|virbr*|cni*|flannel*|cali*|tun*|tap*|wg*) continue ;; esac',
  '    IFS= read -r ty < "$n/type"',
  '    [ "$ty" = 1 ] || continue',
  '    if [ "$pass" = up ]; then',
  '      IFS= read -r st < "$n/operstate"',
  '      [ "$st" = up ] || continue',
  '    fi',
  '    IFS= read -r addr < "$n/address"',
  '    case "$addr" in \'\'|00:00:00:00:00:00) continue ;; esac',
  '    mac=$addr',
  '    break',
  '  done',
  'done',
  'dmi=/sys/class/dmi/id',
  '[ -d "$dmi" ] || dmi=/sys/devices/virtual/dmi/id',
  '[ -d "$kdmi" ] && dmi=$kdmi',
  'vendor=$(rd "$dmi/sys_vendor")',
  'product=$(rd "$dmi/product_name")',
  'serial=$(rd "$dmi/product_serial")',
  'uuid=$(rd "$dmi/product_uuid")',
  'if [ "$product" = 未采集 ] && [ -r /proc/device-tree/model ]; then',
  '  IFS= read -r product < /proc/device-tree/model || product=',
  '  product=$(nvl "$product")',
  'fi',
  'if [ -n "${BASH_VERSION:-}" ]; then cur_shell=bash',
  'elif [ -n "${ZSH_VERSION:-}" ]; then cur_shell=zsh',
  'else cur_shell=sh; fi',
  'pkgs=',
  'for spec in apt:apt-get dpkg:dpkg apk:apk pacman:pacman dnf:dnf yum:yum zypper:zypper; do',
  '  name=${spec%%:*}',
  '  bin=${spec#*:}',
  '  command -v "$bin" >/dev/null 2>&1 || continue',
  '  case " $pkgs " in *" $name "*) ;; *) pkgs="$pkgs $name" ;; esac',
  'done',
  'pkgs=${pkgs# }',
  '[ -n "$pkgs" ] || pkgs=未采集',
  'rts=',
  'for spec in node:node python:python3 python:python go:go java:java rustc:rustc ruby:ruby php:php perl:perl bun:bun; do',
  '  name=${spec%%:*}',
  '  bin=${spec#*:}',
  '  command -v "$bin" >/dev/null 2>&1 || continue',
  '  case " $rts " in *" $name "*) ;; *) rts="$rts $name" ;; esac',
  'done',
  'rts=${rts# }',
  '[ -n "$rts" ] || rts=未采集',
  'if [ -s /etc/machine-id ] || [ -s /var/lib/dbus/machine-id ]; then mid=已采集; else mid=未采集; fi',
  'printf "%s\\n" 系统特征',
  'printf "  主机    %s\\n" "$host"',
  'printf "  系统    %s (%s)\\n" "$os_pretty" "$os_id"',
  'printf "  内核    %s\\n" "$krel"',
  'printf "  架构    %s\\n" "$kmach"',
  'printf "  CPU     %s\\n" "$cpu_model"',
  'printf "  核数    %s\\n" "$cpu_n"',
  'printf "  内存    %s\\n" "$mem"',
  'printf "  磁盘    %s\\n" "$disk"',
  'printf "  MAC     %s\\n" "$mac"',
  'printf "  厂商    %s\\n" "$vendor"',
  'printf "  产品    %s\\n" "$product"',
  'printf "  序列号  %s\\n" "$serial"',
  'printf "  UUID    %s\\n" "$uuid"',
  'printf "  Shell   %s\\n" "$cur_shell"',
  'printf "  包管理  %s\\n" "$pkgs"',
  'printf "  工具链  %s\\n" "$rts"',
  'printf "  机器ID  %s\\n" "$mid"',
  ') || true',
  'esac',
].join('\n')

/**
 * Interactive shell for one panel session. `claude` uses the package's native
 * client independently of the slot's selected inference kernel.
 * Not whatever `claude` is on PATH. The rcfile is session-only; the slot's
 * own ~/.bashrc is sourced, not rewritten. Startup prints a live 系统特征
 * block: slot computer files and cgroup limits first, then guest /proc and
 * sysfs; missing optional probes become
 * unknown/未采集 and must not prevent the prompt.
 */
export const terminalClaudeBin = resolveAuthLoginClaude

/** @returns {{ cmd: string[], rc: string }} */
export function panelShellLaunch(cliBin) {
  const bin = String(cliBin || '')
  if (!bin.startsWith('/') || /[\n\r\0]/.test(bin)) throw new Error('invalid Claude CLI path')
  const q = `'${bin.replace(/'/g, `'\\''`)}'`
  const rc = [
    'if [ -n "${BASH_VERSION:-}" ]; then [ -f /etc/bash.bashrc ] && . /etc/bash.bashrc; [ -f ~/.bashrc ] && . ~/.bashrc; fi',
    'unalias claude cc usage /usage 2>/dev/null || true',
    // Official CLI reads ~/.claude/.credentials.json and, unless CLAUDE_CONFIG_DIR
    // is set, ~/.claude.json. Slot tokens already live in .claude; point the
    // session there and expose the nested account file at the home path.
    'export HOME="${HOME:-/home/kincli}"',
    'export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"',
    'unset CLAUDE_CODE_VERSION ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
    'export USER_TYPE=external',
    'mkdir -p "$CLAUDE_CONFIG_DIR"',
    'if [ ! -e "$HOME/.claude.json" ] && [ -f "$CLAUDE_CONFIG_DIR/.claude.json" ]; then ln -s .claude/.claude.json "$HOME/.claude.json" 2>/dev/null || true; fi',
    `claude() { case "$1:$2" in auth:login|setup-token:*) echo "请在面板账号页完成换票，再使用 /sync 同步凭证" >&2; return 2 ;; esac; export HOME="\${HOME:-/home/kincli}"; export CLAUDE_CONFIG_DIR="\${CLAUDE_CONFIG_DIR:-\$HOME/.claude}"; if [ -x ${q} ]; then ${q} "$@"; else echo "原生 Claude Code 未安装，请同步客户端" >&2; return 127; fi; }`,
    'cc() { claude "$@"; }',
    'usage() { claude /usage "$@"; }',
    'if [ -n "${BASH_VERSION:-}" ]; then eval \'/usage() { usage "$@"; }\'; fi',
    // OSC 133 distinguishes a real shell prompt from a normal-buffer CLI TUI.
    'if [ -n "${BASH_VERSION:-}" ]; then PS1=\'\\[\\e]133;A\\a\\]\'"${PS1:-$ }"; PS0=$(printf \'\\033]133;C\\007\'); else PS1="$(printf \'\\033]133;A\\007\')${PS1:-$ }"; fi',
    SYSTEM_FACTS_RC,
    'rm -f "$KIN_PANEL_RCFILE"',
  ].join('\n')
  return {
    cmd: [
      '/bin/sh',
      '-c',
      `rc=$(mktemp) && printf '%s\\n' "$${RC_ENV}" > "$rc" && export KIN_PANEL_RCFILE=$rc && if command -v bash >/dev/null 2>&1; then exec bash --rcfile "$rc" -i; fi; ENV=$rc exec sh -i`,
    ],
    rc,
  }
}
// Closing the hijacked stream does not end a TTY exec: bash would linger in the
// slot. Every process of the session inherits the marker, so HUP them by it.
const REAP_SCRIPT = `for d in /proc/[0-9]*; do tr '\\0' '\\n' < "$d/environ" 2>/dev/null | grep -qx "${SESSION_ENV}=$1" || continue; cmd=$(tr '\\0' ' ' < "$d/cmdline" 2>/dev/null || true); case "$cmd" in *cli-node*|*"$2"*) kill -KILL "\${d#/proc/}" 2>/dev/null || true ;; *) kill -HUP "\${d#/proc/}" 2>/dev/null || true ;; esac; done; exit 0`

function clampInt(v, lo, hi, dflt) {
  const n = Number.parseInt(v, 10)
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, n))
}

function refuse(status, code, message) {
  return { ok: false, status, error: { code, message } }
}

export function createSlotShell({
  projectRoot,
  checkClaude = assertAuthLoginReady,
  logger = console,
  importOauth = null,
} = {}) {
  const tickets = new Map()
  const liveTokens = new Set()
  const activeLogins = new Set()
  let sessions = 0
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 })

  async function issueTicket(vmId, { login = false } = {}) {
    const vm = getVm(projectRoot, vmId)
    if (!vm) return refuse(404, 'vm_not_found', 'vm not found')
    if (isCodexVm(vm)) return refuse(409, 'no_container', 'GPT 槽没有容器，无法打开终端')
    if (slotHost(vm).native) return refuse(409, 'native_node_unsupported', '此节点不支持 VM 终端')
    if (login && (!hasBoundExit(vm.proxy) || proxyBlockedReason(vm.proxy))) {
      return refuse(409, 'proxy_required', '请先为槽位绑定可用出口，再生成授权链接')
    }
    if (login && activeLogins.has(vm.id)) return refuse(409, 'login_in_progress', '该槽已有原生 CC 登录会话')
    if (sessions >= MAX_SESSIONS) return refuse(429, 'shell_limit', `终端会话已达上限 ${MAX_SESSIONS}`)
    const now = Date.now()
    for (const [t, v] of tickets) if (v.exp <= now) tickets.delete(t)
    if (tickets.size >= MAX_TICKETS) return refuse(429, 'shell_limit', '终端 ticket 过多，请稍后再试')
    const ticket = crypto.randomBytes(24).toString('base64url')
    tickets.set(ticket, { vmId: vm.id, exp: now + TICKET_TTL_MS, login })
    return { ok: true, ticket, expires_in: TICKET_TTL_MS / 1000, cli_bin: terminalClaudeBin(vm) }
  }

  /** Single use: the ticket is burned whether or not it matches. */
  function consumeTicket(ticket, vmId) {
    const entry = tickets.get(ticket)
    tickets.delete(ticket)
    if (!entry || entry.vmId !== vmId || entry.exp <= Date.now()) return null
    return entry
  }

  function rejectUpgrade(socket, status, text) {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    socket.destroy()
  }

  /** @returns {boolean} whether this upgrade belonged to the slot shell */
  function handleUpgrade(req, socket, head) {
    const url = new URL(req.url || '/', 'http://local')
    const sm = SHELL_RE.exec(url.pathname)
    if (!sm) return false
    const vmId = decodeURIComponent(sm[1])
    const ticket = url.searchParams.get('ticket') || ''
    const entry = consumeTicket(ticket, vmId)
    if (!entry) {
      rejectUpgrade(socket, 401, 'Unauthorized')
      return true
    }
    const vm = getVm(projectRoot, vmId)
    if (!vm || isCodexVm(vm)) {
      rejectUpgrade(socket, 404, 'Not Found')
      return true
    }
    const requestedLogin = url.searchParams.get('login') === '1'
    if (requestedLogin !== !!entry.login) {
      rejectUpgrade(socket, 409, 'Conflict')
      return true
    }
    if (entry.login && activeLogins.has(vmId)) {
      rejectUpgrade(socket, 409, 'Conflict')
      return true
    }
    if (sessions >= MAX_SESSIONS) {
      rejectUpgrade(socket, 429, 'Too Many Requests')
      return true
    }
    const size = {
      cols: clampInt(url.searchParams.get('cols'), 10, 500, 80),
      rows: clampInt(url.searchParams.get('rows'), 5, 200, 24),
      login: entry.login,
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sessions += 1
      if (entry.login) activeLogins.add(vmId)
      void attach(ws, vm, size)
    })
    return true
  }

  async function attach(ws, vm, size) {
    const token = crypto.randomBytes(12).toString('hex')
    liveTokens.add(token)
    const container = slotExecContainer(vm)
    let connect = null
    let session = null
    let closed = false
    let syncTimer
    let syncing = false
    let lastSyncError = ''
    const sessionCli = terminalClaudeBin(vm)
    const configDir = `/tmp/kin-auth-${token}`
    let released = false
    const release = () => {
      if (released) return
      released = true
      liveTokens.delete(token)
      sessions -= 1
      if (size.login) activeLogins.delete(vm.id)
    }
    const send = (data) => ws.readyState === ws.OPEN && ws.send(data)
    const sendError = (message) => send(JSON.stringify({ t: 'error', message }))
    const capture = (args, options) => {
      const { Cmd, User } = slotExecCmd(vm, args, { user: slotHost(vm).execUser(vm) })
      return execCapture(connect, container, Cmd, { ...options, user: User })
    }
    const sync = async () => {
      if (syncing || closed) return
      syncing = true
      try {
        const currentVm = getVm(projectRoot, vm.id)
        if (!currentVm || slotExecContainer(currentVm) !== container || currentVm.node_id !== vm.node_id) return
        const result = await prepareClaudeClientCredentials(slotExec(projectRoot, currentVm))
        const message = result.ok ? '' : result.error.message
        if (message && message !== lastSyncError) sendError(message)
        lastSyncError = message
      } catch {
        const message = '客户端凭证同步失败，请在面板检查槽位凭证'
        if (message !== lastSyncError) sendError(message)
        lastSyncError = message
      } finally {
        syncing = false
      }
    }
    const resize = (cols, rows) => {
      resizeExec(connect, session.execId, { cols, rows }).catch(() => {})
    }
    // Listen before the exec opens: input/resize sent during the Docker round
    // trip would otherwise be dropped (ws does not buffer unhandled messages).
    const pending = []
    const apply = (msg) => {
      if (msg?.t === 'd' && typeof msg.d === 'string') session.stream.write(msg.d)
      else if (msg?.t === 'r') resize(clampInt(msg.c, 10, 500, 80), clampInt(msg.r, 5, 200, 24))
    }
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return
      let msg
      try {
        msg = JSON.parse(raw.toString('utf8'))
      } catch {
        return
      }
      if (session) apply(msg)
      else if (pending.length < 256) pending.push(msg)
    })
    const reap = async () => {
      const { Cmd, User } = slotExecCmd(vm, ['/bin/sh', '-c', REAP_SCRIPT, 'reap', token, sessionCli], {
        user: isKvmRuntime(vm) ? '0' : undefined,
      })
      if (size.login) {
        await execCapture(connect, container, Cmd, { user: User })
        await capture(['/bin/rm', '-rf', '--', configDir])
      } else {
        await execDetached(connect, container, Cmd, { user: User })
      }
    }
    const closeExec = async () => {
      try {
        await reap()
      } catch {
        logger.warn?.(`[slot-shell] ${vm.id} session cleanup failed`)
      } finally {
        release()
      }
    }
    let ended = false
    ws.on('close', () => {
      closed = true
      clearInterval(syncTimer)
      if (!session || ended) return
      ended = true
      session.stream.destroy()
      void closeExec()
    })
    try {
      const host = slotHost(vm)
      connect = host.dockerApi()
      if (size.login && (!hasBoundExit(vm.proxy) || proxyBlockedReason(vm.proxy))) {
        throw new Error('槽位未绑定可用出口')
      }
      if (size.login) await checkClaude(projectRoot, vm)
      else {
        try {
          await checkClaude(projectRoot, vm)
        } catch (err) {
          if (err.code !== 'claude_cli_missing') throw err
          sendError(err.message)
        }
        await sync()
      }
      if (closed) {
        release()
        return
      }
      const launch = size.login ? nativeLoginLaunch(sessionCli, configDir) : panelShellLaunch(sessionCli)
      const env = [
        'TERM=xterm-256color',
        'HOME=/home/kincli',
        `${SESSION_ENV}=${token}`,
        ...(size.login ? launch.env : ['CLAUDE_CONFIG_DIR=/home/kincli/.claude', `${RC_ENV}=${launch.rc}`]),
      ]
      const kvm = isKvmRuntime(vm)
      const { Cmd, User } = slotExecCmd(vm, launch.cmd, {
        env: kvm ? env : undefined,
        workdir: '/home/kincli',
        interactive: true,
        tty: true,
        user: host.execUser(vm),
      })
      session = await openExecTty(connect, container, {
        cmd: Cmd,
        env: kvm ? [] : env,
        workingDir: kvm ? undefined : '/home/kincli',
        user: User,
        cols: size.cols,
        rows: size.rows,
      })
    } catch (err) {
      sendError(`打开终端失败：${err.message}`)
      if (size.login && connect) void closeExec()
      else release()
      ws.close(1011)
      return
    }
    if (closed) {
      session.stream.destroy()
      void closeExec()
      return
    }
    // ConsoleSize on exec start is API >= 1.42; resize covers older daemons.
    resize(size.cols, size.rows)
    if (!size.login) {
      syncTimer = setInterval(() => void sync(), CREDENTIAL_SYNC_INTERVAL_MS)
      syncTimer.unref()
    }
    const onEnd = async () => {
      if (ended) return
      ended = true
      clearInterval(syncTimer)
      const info = await inspectExec(connect, session.execId).catch(() => null)
      if (size.login && info?.ExitCode !== 124) {
        try {
          const oauth = await readNativeLoginOauth((args) => capture(args, { maxOutputBytes: 132_000 }), configDir)
          const existing = getVm(projectRoot, vm.id)
          if (!existing || existing.node_id !== vm.node_id || slotExecContainer(existing) !== container) {
            throw new Error('虚拟机已迁移或删除，请重新生成授权链接')
          }
          const committed = await importOauth?.({
            vmId: vm.id,
            vmPath: path.join(projectRoot, 'vms', `${vm.id}.json`),
            existing,
            oauth,
            source: oauth.source,
            fromNativeLogin: true,
          })
          if (!committed?.ok) {
            sendError(committed?.error?.message || '授权成功，但面板未能同步凭证')
          } else {
            send(
              JSON.stringify({ t: 'login', ok: true, official_cc_bootstrap: committed.official_cc_bootstrap ?? null }),
            )
          }
        } catch (err) {
          sendError(err.code?.startsWith('auth_login_') ? err.message : '面板未能保存原生 CC 凭证，请检查槽位后重试')
        }
      } else if (size.login) {
        sendError('授权会话已超时，请重新生成链接')
      }
      await closeExec()
      send(JSON.stringify({ t: 'exit', code: info?.ExitCode ?? null }))
      ws.close(1000)
    }
    session.stream.on('data', (chunk) => send(chunk))
    session.stream.on('end', onEnd)
    session.stream.on('close', onEnd)
    session.stream.on('error', () => onEnd())
    for (const msg of pending.splice(0)) apply(msg)
  }

  return { issueTicket, handleUpgrade, liveShellTokens: () => [...liveTokens] }
}
