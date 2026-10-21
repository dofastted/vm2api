/**
 * Panel terminal into a slot's container: `docker exec -it` over the Engine
 * API, bridged to a browser WebSocket. Browsers cannot put Authorization on a
 * WebSocket handshake, so `POST /api/panel/vms/:id/shell-ticket` (panel auth +
 * ACL) trades the session for a 30s single-use ticket, same contract as the
 * cluster node shell. Wire protocol matches it too:
 *   client → {t:'d', d} input · {t:'r', c, r} resize
 *   server → binary output · {t:'exit', code} · {t:'error', message}
 */

import crypto from 'node:crypto'
import { WebSocketServer } from 'ws'
import { execDetached, inspectExec, openExecTty, resizeExec } from '../cluster/docker-remote.mjs'
import { slotContainerName } from '../transport/rust-kernel-supervisor.mjs'
import { slotHost } from './slot-host.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { isKvmRuntime } from './runtime-kind.mjs'
import { slotExecCmd } from './slot-exec.mjs'
import { getVm } from './vm-registry.mjs'
import { OFFICIAL_CLI_VERSION } from '../identity/vm-identity.mjs'
import { ensureOfficialCredentialLink, writeWorkerCredentialFile } from '../oauth/oauth-credentials.mjs'
import { assertAuthLoginReady, officialLoginCredentialToOauth } from '../oauth/claude-auth-login.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { ensureRemoteOfficialCredentialLink, reconcileSlotCredentials } from '../cluster/remote-slot-files.mjs'
import { officialCcUidGid } from './vm-runtime.mjs'

const SHELL_RE = /^\/api\/panel\/vms\/([^/]+)\/shell$/
const TICKET_TTL_MS = 30_000
const MAX_TICKETS = 64
const MAX_SESSIONS = 8
const SESSION_ENV = 'KIN_PANEL_SHELL'
const RC_ENV = 'KIN_PANEL_RC'

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * The shell obtains the grant. The existing importer owns the worker file,
 * worker notification, and vm.json metadata. The terminal keeps reading that
 * same file through .credentials.json.
 */
/** Cluster slots write OAuth on the node claude/ mount; mirror it before adopt. */
export async function syncShellLoginCredentials(
  projectRoot,
  vm,
  {
    phase,
    host = slotHost(vm),
    reconcile = reconcileSlotCredentials,
    ensureRemoteLink = ensureRemoteOfficialCredentialLink,
  } = {},
) {
  if (host.kind !== 'node') return { synced: false }
  const slotDir = path.join(projectRoot, 'vms', vm.id)
  if (phase === 'prepare') {
    const reconciled = await reconcile(vm, slotDir)
    await ensureRemoteLink(vm, slotDir)
    return reconciled
  }
  if (phase === 'adopt') return host.afterRefresh(vm, slotDir)
  return { synced: false }
}

export async function preparePanelShellLogin(projectRoot, vm) {
  const home = path.join(projectRoot, 'vms', vm.id, 'cli-home')
  const linked = ensureOfficialCredentialLink(home, {
    ...officialCcUidGid(vm.id),
    create: true,
  })
  if (!linked?.linked) {
    const err = new Error(linked?.error || '官方凭证链接失败')
    err.code = 'credential_link_failed'
    throw err
  }
  await syncShellLoginCredentials(projectRoot, vm, { phase: 'prepare' })
  return linked
}

export async function adoptShellLogin(projectRoot, vm, { importOauth = null, loginHost = null } = {}) {
  const home = path.join(projectRoot, 'vms', vm.id, 'cli-home')
  await syncShellLoginCredentials(projectRoot, vm, { phase: 'adopt', host: loginHost || slotHost(vm) })
  ensureOfficialCredentialLink(home, officialCcUidGid(vm.id))
  const official = path.join(home, '.claude', '.credentials.json')
  const oauth = officialLoginCredentialToOauth(readJsonFile(official) || {})
  const vmPath = path.join(projectRoot, 'vms', `${vm.id}.json`)
  const existing = getVm(projectRoot, vm.id) || { ...vm, id: vm.id }
  if (typeof importOauth === 'function') {
    const committed = await importOauth({
      vmId: vm.id,
      vmPath,
      existing,
      oauth,
      source: oauth.source,
    })
    if (!committed?.ok) {
      const err = new Error(committed?.error?.message || '官方登录凭证未能导入槽凭证')
      err.code = committed?.error?.code || 'credential_import_failed'
      throw err
    }
  } else {
    const written = writeWorkerCredentialFile(home, oauth)
    if (!written) {
      const err = new Error('官方登录凭证未能写入槽凭证')
      err.code = 'credential_import_failed'
      throw err
    }
  }
  const linked = ensureOfficialCredentialLink(home, officialCcUidGid(vm.id))
  if (!linked?.linked) {
    const err = new Error(linked?.error || '终端凭证链接失败')
    err.code = 'credential_link_failed'
    throw err
  }
  return { imported: true, linked: true }
}

/** Import one new interactive grant. The same refresh is not imported twice. */
export async function adoptLiveShellLogin(projectRoot, vm, { importOauth = null, loginHost = null, seen = '' } = {}) {
  const home = path.join(projectRoot, 'vms', vm.id, 'cli-home')
  await syncShellLoginCredentials(projectRoot, vm, { phase: 'adopt', host: loginHost || slotHost(vm) })
  ensureOfficialCredentialLink(home, officialCcUidGid(vm.id))
  const doc = readJsonFile(path.join(home, '.claude', '.credentials.json'))
  const grant = doc?.claudeAiOauth
  const refresh = String(grant?.refreshToken || grant?.refresh_token || '')
  if (!refresh || refresh === seen) return { imported: false, refresh: seen }
  await adoptShellLogin(projectRoot, vm, { importOauth, loginHost })
  return { imported: true, refresh }
}

/** One interactive import at a time. A tick and terminal close share it. */
export function createLiveLoginAdoption({ adopt, onImported, onError }) {
  let seen = ''
  let pending = null
  return (report = false) => {
    if (pending) return pending
    pending = (async () => {
      try {
        const adopted = await adopt(seen)
        if (!adopted?.imported || !adopted.refresh || adopted.refresh === seen) {
          return { imported: false, refresh: seen }
        }
        seen = adopted.refresh
        onImported?.(adopted)
        return adopted
      } catch (err) {
        onError?.(err, report)
        return { imported: false, refresh: seen, error: err }
      } finally {
        pending = null
      }
    })()
    return pending
  }
}

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
  'mem=unknown',
  'if [ -r /proc/meminfo ]; then',
  '  while IFS= read -r line; do',
  '    case "$line" in',
  '      MemTotal:*) set -- $line; mem=$(hsize "$2"); break ;;',
  '    esac',
  '  done < /proc/meminfo',
  'fi',
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
 * Interactive shell for one panel session. `claude` is this slot's cli-node,
 * not whatever `claude` is on PATH. The rcfile is session-only; the slot's
 * own ~/.bashrc is sourced, not rewritten. Startup prints a live 系统特征
 * block from guest /proc and sysfs; missing optional probes become
 * unknown/未采集 and must not prevent the prompt.
 * @returns {{ cmd: string[], rc: string }}
 */
export function panelShellLaunch(cliBin) {
  const bin = String(cliBin || '')
  if (!bin.startsWith('/') || /[\n\r\0]/.test(bin)) throw new Error('invalid cli-node path')
  const q = `'${bin.replace(/'/g, `'\\''`)}'`
  const rc = [
    'if [ -n "${BASH_VERSION:-}" ]; then [ -f /etc/bash.bashrc ] && . /etc/bash.bashrc; [ -f ~/.bashrc ] && . ~/.bashrc; fi',
    'unalias claude 2>/dev/null || true',
    // Official CLI reads ~/.claude/.credentials.json and, unless CLAUDE_CONFIG_DIR
    // is set, ~/.claude.json. Slot tokens already live in .claude; point the
    // session there and expose the nested account file at the home path.
    'export HOME="${HOME:-/home/kincli}"',
    'export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"',
    // Same credentials.json as the host Refresher; a second refresher here would spend the shared RT.
    `export CLAUDE_CODE_HOST_REFRESH=1`,
    `export CLAUDE_CODE_VERSION=${OFFICIAL_CLI_VERSION}`,
    'export USER_TYPE=external',
    'mkdir -p "$CLAUDE_CONFIG_DIR"',
    'if [ -f "$CLAUDE_CONFIG_DIR/credentials.json" ] && [ ! -e "$CLAUDE_CONFIG_DIR/.credentials.json" ]; then ln -s credentials.json "$CLAUDE_CONFIG_DIR/.credentials.json" 2>/dev/null || true; fi',
    'if [ ! -e "$HOME/.claude.json" ] && [ -f "$CLAUDE_CONFIG_DIR/.claude.json" ]; then ln -s .claude/.claude.json "$HOME/.claude.json" 2>/dev/null || true; fi',
    `claude() { export HOME="\${HOME:-/home/kincli}"; export CLAUDE_CONFIG_DIR="\${CLAUDE_CONFIG_DIR:-\$HOME/.claude}"; if [ -x ${q} ]; then ${q} "$@"; else echo "cli-node 不在 ${q}" >&2; return 127; fi; }`,
    SYSTEM_FACTS_RC,
    'if [ -n "${KIN_PANEL_LOGIN:-}" ]; then printf "\\n"; claude; fi',
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
const REAP_SCRIPT = `for d in /proc/[0-9]*; do tr '\\0' '\\n' < "$d/environ" 2>/dev/null | grep -qx "${SESSION_ENV}=$1" || continue; cmd=$(tr '\\0' ' ' < "$d/cmdline" 2>/dev/null || true); case "$cmd" in *cli-node*) kill -KILL "\${d#/proc/}" 2>/dev/null || true ;; *) kill -HUP "\${d#/proc/}" 2>/dev/null || true ;; esac; done; exit 0`

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
  logger = console,
  importOauth = null,
  authLoginReady = null,
  upgradeLoginReady = null,
} = {}) {
  const tickets = new Map()
  const liveTokens = new Set()
  let sessions = 0
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 })
  const pendingTasks = new Set()
  const connections = new Map()
  let draining = false
  let drainError = null
  function track(task) {
    const tracked = Promise.resolve(task)
      .catch((error) => {
        drainError ||= error
      })
      .finally(() => pendingTasks.delete(tracked))
    pendingTasks.add(tracked)
  }

  async function issueTicket(vmId, { login = false } = {}) {
    if (draining) return refuse(503, 'control_plane_draining', 'Control plane is draining')
    const vm = getVm(projectRoot, vmId)
    if (!vm) return refuse(404, 'vm_not_found', 'vm not found')
    if (isCodexVm(vm)) return refuse(409, 'no_container', 'GPT 槽没有容器，无法打开终端')
    if (login) {
      try {
        await (authLoginReady || assertAuthLoginReady)(projectRoot, vm)
      } catch (err) {
        return refuse(409, err.code || 'auth_login_not_ready', err.message)
      }
    }
    if (draining) return refuse(503, 'control_plane_draining', 'Control plane is draining')
    if (sessions >= MAX_SESSIONS) return refuse(429, 'shell_limit', `终端会话已达上限 ${MAX_SESSIONS}`)
    const now = Date.now()
    for (const [t, v] of tickets) if (v.exp <= now) tickets.delete(t)
    if (tickets.size >= MAX_TICKETS) return refuse(429, 'shell_limit', '终端 ticket 过多，请稍后再试')
    const ticket = crypto.randomBytes(24).toString('base64url')
    tickets.set(ticket, { vmId: vm.id, exp: now + TICKET_TTL_MS, login })
    return { ok: true, ticket, expires_in: TICKET_TTL_MS / 1000 }
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
    if (draining) {
      rejectUpgrade(socket, 503, 'Service Unavailable')
      return true
    }
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
    const login = !!entry.login
    const accept = () => {
      if (draining) {
        rejectUpgrade(socket, 503, 'Service Unavailable')
        return
      }
      if (sessions >= MAX_SESSIONS) {
        rejectUpgrade(socket, 429, 'Too Many Requests')
        return
      }
      sessions += 1
      const size = {
        cols: clampInt(url.searchParams.get('cols'), 10, 500, 80),
        rows: clampInt(url.searchParams.get('rows'), 5, 200, 24),
        login,
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        track(new Promise((resolve) => ws.once('close', resolve)))
        track(attach(ws, vm, size))
      })
    }
    if (!login) {
      accept()
      return true
    }
    track(
      Promise.resolve()
        .then(() => (upgradeLoginReady || authLoginReady || assertAuthLoginReady)(projectRoot, vm))
        .then(accept, (err) =>
          rejectUpgrade(
            socket,
            409,
            String(err?.message || 'Conflict')
              .replace(/[\r\n]+/g, ' ')
              .slice(0, 120) || 'Conflict',
          ),
        ),
    )
    return true
  }

  async function attach(ws, vm, size) {
    const token = crypto.randomBytes(12).toString('hex')
    liveTokens.add(token)
    const container = slotContainerName({ vm })
    let connect = null
    let session = null
    let closed = false
    let released = false
    let adoptTimer = null
    connections.set(ws, () => {
      clearInterval(adoptTimer)
      ws.close(1001, 'Control plane is draining')
    })
    const release = () => {
      if (released) return
      released = true
      liveTokens.delete(token)
      sessions -= 1
    }
    const send = (data) => ws.readyState === ws.OPEN && ws.send(data)
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
    const reap = () => {
      const { Cmd, User } = slotExecCmd(vm, ['/bin/sh', '-c', REAP_SCRIPT, 'reap', token], {
        detach: true,
        user: isKvmRuntime(vm) ? '0' : undefined,
      })
      return execDetached(connect, container, Cmd, { user: User })
    }
    ws.on('close', () => {
      closed = true
      connections.delete(ws)
      clearInterval(adoptTimer)
      release()
      if (!session) return
      session.stream.destroy()
      track(
        reap().catch((err) => {
          logger.warn?.(`[slot-shell] ${vm.id} reap failed: ${err.message}`)
        }),
      )
    })
    try {
      connect = slotHost(vm).dockerApi()
      if (size.login) await preparePanelShellLogin(projectRoot, vm)
      const launch = panelShellLaunch(slotHost(vm).bins.cli)
      const env = ['TERM=xterm-256color', `${SESSION_ENV}=${token}`, `${RC_ENV}=${launch.rc}`]
      if (size.login) env.push('KIN_PANEL_LOGIN=1')
      const { Cmd } = slotExecCmd(vm, launch.cmd, {
        env: isKvmRuntime(vm) ? env : undefined,
        interactive: true,
        tty: true,
        user: isKvmRuntime(vm) ? slotHost(vm).execUser(vm) : undefined,
      })
      session = await openExecTty(connect, container, {
        cmd: Cmd,
        env: isKvmRuntime(vm) ? [] : env,
        cols: size.cols,
        rows: size.rows,
      })
    } catch (err) {
      send(JSON.stringify({ t: 'error', message: `打开终端失败：${err.message}` }))
      ws.close(1011)
      return
    }
    if (closed || draining) {
      // The close handler ran before the session existed: reap here instead.
      session.stream.destroy()
      await reap().catch(() => {})
      return
    }
    // ConsoleSize on exec start is API >= 1.42; resize covers older daemons.
    resize(size.cols, size.rows)
    const adoptLive = createLiveLoginAdoption({
      adopt: (seen) => {
        if (!size.login) return { imported: false, refresh: seen }
        return adoptLiveShellLogin(projectRoot, vm, {
          importOauth,
          loginHost: slotHost(vm),
          seen,
        })
      },
      onImported() {
        send(JSON.stringify({ t: 'login', ok: true }))
      },
      onError(err, report) {
        if (err?.code === 'auth_login_incomplete' || err?.code === 'auth_login_scope') return
        logger.warn?.(`[slot-shell] ${vm.id} login import failed: ${err.message}`)
        if (report) send(JSON.stringify({ t: 'error', message: '官方登录凭证未能导入槽凭证' }))
      },
    })
    adoptTimer = size.login ? setInterval(() => track(adoptLive()), 1000) : null
    adoptTimer?.unref?.()
    let completeTerminal
    track(
      new Promise((resolve) => {
        completeTerminal = resolve
      }),
    )
    let ended = false
    const onEnd = () => {
      if (ended) return
      ended = true
      clearInterval(adoptTimer)
      track(
        (async () => {
          try {
            if (size.login) {
              const adopted = await adoptLive(true)
              if (
                draining &&
                adopted.error &&
                !['auth_login_incomplete', 'auth_login_scope'].includes(adopted.error.code)
              ) {
                throw adopted.error
              }
            }
            const info = await inspectExec(connect, session.execId).catch(() => null)
            send(JSON.stringify({ t: 'exit', code: info?.ExitCode ?? null }))
            ws.close(1000)
          } finally {
            completeTerminal()
          }
        })(),
      )
    }
    session.stream.on('data', (chunk) => send(chunk))
    session.stream.on('end', onEnd)
    session.stream.on('close', onEnd)
    session.stream.on('error', () => onEnd())
    for (const msg of pending.splice(0)) apply(msg)
  }

  function beginDrain() {
    draining = true
    tickets.clear()
    for (const close of connections.values()) close()
  }

  async function drain() {
    beginDrain()
    while (pendingTasks.size) await Promise.all([...pendingTasks])
    if (drainError) throw drainError
  }

  function terminate() {
    beginDrain()
    for (const ws of connections.keys()) ws.terminate()
  }

  return { issueTicket, handleUpgrade, liveShellTokens: () => [...liveTokens], beginDrain, drain, terminate }
}
