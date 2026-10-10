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

const SHELL_RE = /^\/api\/panel\/vms\/([^/]+)\/shell$/
const TICKET_TTL_MS = 30_000
const MAX_TICKETS = 64
const MAX_SESSIONS = 8
const SESSION_ENV = 'KIN_PANEL_SHELL'
const RC_ENV = 'KIN_PANEL_RC'

/**
 * Interactive shell for one panel session. `claude` is this slot's cli-node,
 * not whatever `claude` is on PATH. The rcfile is session-only; the slot's
 * own ~/.bashrc is sourced, not rewritten.
 * @returns {{ cmd: string[], rc: string }}
 */
export function panelShellLaunch(cliBin) {
  const bin = String(cliBin || '')
  if (!bin.startsWith('/') || /[\n\r\0]/.test(bin)) throw new Error('invalid cli-node path')
  const q = `'${bin.replace(/'/g, `'\\''`)}'`
  const rc = [
    '[ -f /etc/bash.bashrc ] && . /etc/bash.bashrc',
    '[ -f ~/.bashrc ] && . ~/.bashrc',
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

export function createSlotShell({ projectRoot, logger = console }) {
  const tickets = new Map()
  const liveTokens = new Set()
  let sessions = 0
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 })

  function issueTicket(vmId) {
    const vm = getVm(projectRoot, vmId)
    if (!vm) return refuse(404, 'vm_not_found', 'vm not found')
    if (isCodexVm(vm)) return refuse(409, 'no_container', 'GPT 槽没有容器，无法打开终端')
    if (sessions >= MAX_SESSIONS) return refuse(429, 'shell_limit', `终端会话已达上限 ${MAX_SESSIONS}`)
    const now = Date.now()
    for (const [t, v] of tickets) if (v.exp <= now) tickets.delete(t)
    if (tickets.size >= MAX_TICKETS) return refuse(429, 'shell_limit', '终端 ticket 过多，请稍后再试')
    const ticket = crypto.randomBytes(24).toString('base64url')
    tickets.set(ticket, { vmId: vm.id, exp: now + TICKET_TTL_MS })
    return { ok: true, ticket, expires_in: TICKET_TTL_MS / 1000 }
  }

  /** Single use: the ticket is burned whether or not it matches. */
  function consumeTicket(ticket, vmId) {
    const entry = tickets.get(ticket)
    tickets.delete(ticket)
    return !!entry && entry.vmId === vmId && entry.exp > Date.now()
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
    if (!consumeTicket(url.searchParams.get('ticket') || '', vmId)) {
      rejectUpgrade(socket, 401, 'Unauthorized')
      return true
    }
    const vm = getVm(projectRoot, vmId)
    if (!vm || isCodexVm(vm)) {
      rejectUpgrade(socket, 404, 'Not Found')
      return true
    }
    if (sessions >= MAX_SESSIONS) {
      rejectUpgrade(socket, 429, 'Too Many Requests')
      return true
    }
    sessions += 1
    const size = {
      cols: clampInt(url.searchParams.get('cols'), 10, 500, 80),
      rows: clampInt(url.searchParams.get('rows'), 5, 200, 24),
    }
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, vm, size))
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
      release()
      if (!session) return
      session.stream.destroy()
      reap().catch((err) => {
        logger.warn?.(`[slot-shell] ${vm.id} reap failed: ${err.message}`)
      })
    })
    try {
      connect = slotHost(vm).dockerApi()
      const launch = panelShellLaunch(slotHost(vm).bins.cli)
      const env = ['TERM=xterm-256color', `${SESSION_ENV}=${token}`, `${RC_ENV}=${launch.rc}`]
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
    if (closed) {
      // The close handler ran before the session existed: reap here instead.
      session.stream.destroy()
      reap().catch(() => {})
      return
    }
    // ConsoleSize on exec start is API >= 1.42; resize covers older daemons.
    resize(size.cols, size.rows)
    let ended = false
    const onEnd = async () => {
      if (ended) return
      ended = true
      const info = await inspectExec(connect, session.execId).catch(() => null)
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
