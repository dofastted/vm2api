/** Official slot-local OAuth. The control plane never reads provider tokens. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFile, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { antigravityRuntimeSupport } from '../transport/antigravity-bridge-supervisor.mjs'
import { normalizeAntigravityRouting } from '../protocol/antigravity-route.mjs'
import { slotExecArgv } from '../vm/slot-exec.mjs'
import { slotRuntimeOwner } from './oauth-credentials.mjs'
import { isValidVmId } from '../vm/vm-file.mjs'
import { patchVmRecord } from '../vm/vm-registry.mjs'

const sessions = new Map()
const ACTIVE = new Set(['starting', 'awaiting_code', 'verifying'])
const TTL = 30 * 60_000
const driver = fileURLToPath(new URL('../../../scripts/antigravity-auth-login-pty.py', import.meta.url))
const execWrapper = fileURLToPath(new URL('../../../scripts/antigravity-auth-exec.py', import.meta.url))
const assetPublisher = fileURLToPath(new URL('../../../scripts/antigravity-slot-assets.py', import.meta.url))
const guestWrapper = '/home/kincli/.kin/antigravity-auth-exec.py'
const defaultCliSource = fileURLToPath(new URL('../../../image-antigravity-cli/agy', import.meta.url))

const fail = (code, error, status = 400) => ({ ok: false, code, error, status })
const keyOf = (root, vm) => `${path.resolve(root)}:${vm.id}`
const ownerOf = (vm) => String(vm.owner_user_id ?? '')

function view(session) {
  return {
    session_id: session.id,
    status: session.status,
    auth_url: ACTIVE.has(session.status) ? session.authUrl || null : null,
    expires_at: new Date(session.expires).toISOString(),
    authenticated: session.status === 'authenticated',
    ...(session.error ? { error: session.error } : {}),
    ...(session.message ? { message: session.message } : {}),
  }
}

function terminate(session) {
  if (session.cleanup) return session.cleanup
  session.abort.abort()
  clearInterval(session.timer)
  if (!session.child) return Promise.resolve()
  const child = session.child
  const childStopped = new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {}
      resolve()
    }, 2000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    try {
      child.stdin.end(JSON.stringify({ cancel: true }) + '\n')
    } catch {
      clearTimeout(timer)
      resolve()
    }
  })
  let guestStopped = Promise.resolve()
  if (session.pidFile && !session.ops?.spawn) {
    try {
      publishAntigravitySlotAssets(session.root, session.vm, {
        markers: [`.cache/tmp/antigravity-auth-${session.id}.json.cancel`],
      })
    } catch {}
    const { uid, gid } = slotRuntimeOwner(session.vm)
    guestStopped = new Promise((resolve) =>
      execFile(
        'docker',
        slotExecArgv(session.vm, ['python3', guestWrapper, 'stop', session.pidFile], {
          user: `${uid}:${gid}`,
        }),
        { timeout: 5000, maxBuffer: 1024 },
        () => resolve(),
      ),
    )
  }
  session.cleanup = Promise.all([childStopped, guestStopped])
  return session.cleanup
}

function finish(session, status, error) {
  if (!ACTIVE.has(session.status)) return session.cleanup || Promise.resolve()
  session.status = status
  session.authUrl = null
  session.error = error || null
  const cleanup = terminate(session)
  // Keep a short terminal result for the owning browser to observe.
  const timer = setTimeout(() => {
    if (sessions.get(session.key) === session) sessions.delete(session.key)
  }, 60_000)
  timer.unref?.()
  return cleanup
}

function metadataFile(root, vm) {
  return path.join(root, 'vms', vm.id, 'run', 'antigravity-auth.json')
}

function markAuthenticated(session) {
  const file = metadataFile(session.root, session.vm)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`
  fs.writeFileSync(temporary, JSON.stringify({ authenticated: true, updated_at: new Date().toISOString() }) + '\n', {
    mode: 0o600,
    flag: 'wx',
  })
  fs.renameSync(temporary, file)
  // A new login may be another Google account; the next quota read records its email.
  patchVmRecord(session.root, session.vm.id, (record) => ({ antigravity: { ...record.antigravity, email: null } }))
  finish(session, 'authenticated')
}

/** Slot-writable directories are resolved by the helper with directory fds and O_NOFOLLOW. */
export function publishAntigravitySlotAssets(projectRoot, vm, { files = [], directories = [], markers = [] } = {}) {
  if (!projectRoot || !isValidVmId(vm?.id)) throw new TypeError('A valid slot and project root are required')
  const { uid, gid } = slotRuntimeOwner(vm)
  execFileSync(
    'python3',
    [
      assetPublisher,
      JSON.stringify({
        project_root: path.resolve(projectRoot),
        vm_id: vm.id,
        uid,
        gid,
        files,
        directories,
        markers,
      }),
    ],
    { timeout: 30_000, maxBuffer: 1024, stdio: ['ignore', 'pipe', 'pipe'] },
  )
}

/** Install the checksum-pinned release already bundled in the control image. */
export function materializeAntigravityCli(
  projectRoot,
  vm,
  { source = process.env.KIN_ANTIGRAVITY_CLI_SOURCE || defaultCliSource } = {},
) {
  if (!fs.existsSync(source)) throw new Error('镜像未包含官方 Antigravity CLI，请更新主控镜像。')
  publishAntigravitySlotAssets(projectRoot, vm, { files: [{ source, path: '.local/bin/agy' }] })
  return '/home/kincli/.local/bin/agy'
}

function authExecOptions(vm) {
  const { uid, gid } = slotRuntimeOwner(vm)
  return {
    user: `${uid}:${gid}`,
    workdir: '/home/kincli',
    env: {
      HOME: '/home/kincli',
      PATH: '/home/kincli/.local/bin:/usr/local/bin:/usr/bin:/bin',
      XDG_CONFIG_HOME: '/home/kincli/.config',
      XDG_DATA_HOME: '/home/kincli/.local/share',
      XDG_CACHE_HOME: '/home/kincli/.cache',
      TMPDIR: '/home/kincli/.cache/tmp',
      SSH_CONNECTION: '127.0.0.1 1 127.0.0.1 22',
      SSH_TTY: '/dev/pts/0',
      LANG: vm.locale || 'C.UTF-8',
      TZ: vm.timezone || 'UTC',
      TERM: 'xterm-256color',
      COLUMNS: '220',
      LINES: '60',
    },
  }
}

export function antigravityAuthExecArgv(vm, cli = 'agy', pidFile = null) {
  return [
    'docker',
    ...slotExecArgv(vm, pidFile ? ['python3', guestWrapper, 'start', pidFile, cli] : [cli], {
      ...authExecOptions(vm),
      interactive: true,
      tty: true,
    }),
  ]
}

export function antigravityAuthVerifyArgv(vm, cli = 'agy') {
  return ['docker', ...slotExecArgv(vm, ['timeout', '-k', '2s', '15s', cli, 'models'], authExecOptions(vm))]
}

async function prepare(session, routing, ops) {
  try {
    await session.previousCleanup
    const { startVmRuntime } = await import('../vm/vm-runtime.mjs')
    if (!ACTIVE.has(session.status)) return
    const boot = await (ops.startRuntime || startVmRuntime)(session.vm, session.root, {
      routing,
      forAuthentication: true,
    })
    if (!ACTIVE.has(session.status)) return
    if (!boot?.ok) throw new Error(boot?.error || '无法启动 Antigravity 槽位')
    if (fs.existsSync(path.join(session.root, 'vms', `${session.vm.id}.json`))) {
      const { persistVmRuntime, patchVmRecord } = await import('../vm/vm-registry.mjs')
      if (!ACTIVE.has(session.status)) return
      persistVmRuntime(session.root, session.vm.id, boot.runtime || session.vm.runtime)
      patchVmRecord(session.root, session.vm.id, { status: 'running' })
    }
    const options = normalizeAntigravityRouting(routing.antigravity || {})
    const cli =
      options.cli_bin === 'agy'
        ? (ops.materializeCli || materializeAntigravityCli)(session.root, session.vm)
        : options.cli_bin
    publishAntigravitySlotAssets(session.root, session.vm, {
      directories: ['.cache/tmp'],
      files: [{ source: execWrapper, path: '.kin/antigravity-auth-exec.py' }],
    })
    session.pidFile = `/home/kincli/.cache/tmp/antigravity-auth-${session.id}.json`
    if (!ACTIVE.has(session.status)) return
    const child = (ops.spawn || spawn)('python3', [driver], {
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin',
        LANG: 'C.UTF-8',
        KIN_ANTIGRAVITY_EXEC_ARGV: JSON.stringify(antigravityAuthExecArgv(session.vm, cli, session.pidFile)),
        KIN_ANTIGRAVITY_VERIFY_ARGV: JSON.stringify(antigravityAuthVerifyArgv(session.vm, cli)),
      },
      stdio: ['pipe', 'pipe', 'ignore'],
      shell: false,
    })
    session.child = child
    child.stdin.on('error', () => finish(session, 'failed', '官方客户端授权输入已关闭。'))
    let pending = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (part) => {
      if (!ACTIVE.has(session.status)) return
      pending += part
      if (pending.length > 65536) return finish(session, 'failed', '官方客户端授权响应超出限制。')
      let index
      while ((index = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, index)
        pending = pending.slice(index + 1)
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (event.status === 'awaiting_code' && session.status === 'starting' && validAuthUrl(event.auth_url)) {
          session.authUrl = event.auth_url
          session.status = 'awaiting_code'
          session.message = '在浏览器完成 Google 授权后，将页面显示的授权码粘贴到下方。'
        } else if (event.status === 'authenticated' && event.authenticated === true) {
          try {
            markAuthenticated(session)
          } catch {
            finish(session, 'failed', '无法保存槽位授权状态。')
          }
        } else if (event.status === 'failed') {
          // Never forward arbitrary CLI stdout, exception strings, or submitted codes.
          finish(session, 'failed', '官方客户端授权失败，请检查授权码、账号权限和槽位网络后重新生成链接。')
        }
      }
    })
    child.on('error', () => finish(session, 'failed', '无法启动官方客户端授权进程。'))
    child.on('exit', () => finish(session, 'failed', '官方客户端授权进程已结束，请重新生成链接。'))
  } catch {
    finish(session, 'failed', '无法准备官方客户端授权，请检查主控镜像、槽位运行状态和专属出口网络。')
  }
}

export function validAuthUrl(value) {
  if (typeof value !== 'string' || value.length > 16384) return false
  try {
    const url = new URL(value)
    return (
      url.origin === 'https://accounts.google.com' &&
      !url.username &&
      !url.password &&
      url.searchParams.get('redirect_uri') === 'https://antigravity.google/oauth-callback' &&
      url.searchParams.get('response_type') === 'code' &&
      !!url.searchParams.get('state') &&
      !!url.searchParams.get('code_challenge')
    )
  } catch {
    return false
  }
}

function lookup({ projectRoot, vm, actor, sessionId }) {
  const session = sessions.get(keyOf(projectRoot, vm))
  if (!session || session.id !== sessionId)
    return fail('antigravity_auth_session_not_found', '授权会话不存在或已结束', 404)
  if (session.actor !== actor) return fail('antigravity_auth_forbidden', '无权访问此授权会话', 403)
  if (session.owner !== ownerOf(vm)) {
    finish(session, 'cancelled')
    return fail('antigravity_auth_session_not_found', '槽位归属已变化，请重新授权', 404)
  }
  if (ACTIVE.has(session.status) && Date.now() >= session.expires) finish(session, 'expired')
  return session
}

export function startAntigravityAuthLogin({ projectRoot, vm, routing = {}, actor, ops = {} }) {
  const support = antigravityRuntimeSupport(vm)
  if (!support.ok) return support
  if (!actor || !projectRoot) return fail('invalid_auth_actor', '授权用户不能为空')
  const key = keyOf(projectRoot, vm)
  const previous = sessions.get(key)
  if (previous && ACTIVE.has(previous.status)) {
    if (previous.owner === ownerOf(vm) && previous.actor !== actor)
      return fail('antigravity_auth_busy', '当前槽位已有其他用户正在授权', 409)
    if (previous.owner === ownerOf(vm) && Date.now() < previous.expires) return { ok: true, session: view(previous) }
    finish(previous, 'cancelled')
  }
  const session = {
    key,
    root: projectRoot,
    vm,
    owner: ownerOf(vm),
    actor,
    id: crypto.randomBytes(24).toString('hex'),
    status: 'starting',
    expires: Date.now() + TTL,
    abort: new AbortController(),
    ops,
    previousCleanup: previous?.cleanup,
  }
  sessions.set(key, session)
  session.timer = setInterval(() => {
    if (Date.now() >= session.expires) finish(session, 'expired')
  }, 1000)
  session.timer.unref?.()
  // Return immediately: image preparation may take longer than an HTTP request timeout.
  void prepare(session, routing, ops)
  return { ok: true, session: view(session) }
}

export function readAntigravityAuthLogin(args) {
  const session = lookup(args)
  return session.ok === false ? session : { ok: true, session: view(session) }
}

export function completeAntigravityAuthLogin(args) {
  const session = lookup(args)
  if (session.ok === false) return session
  const code = typeof args.code === 'string' ? args.code.trim() : ''
  if (!code || code.length > 4096 || /[\x00-\x20\x7f]/.test(code))
    return fail('invalid_authorization_code', '请粘贴浏览器显示的完整单行授权码')
  if (session.status !== 'awaiting_code') return fail('antigravity_auth_not_waiting', '当前授权会话未等待授权码', 409)
  session.status = 'verifying'
  session.authUrl = null
  session.message = '官方客户端正在验证授权码…'
  try {
    session.child.stdin.write(JSON.stringify({ code }) + '\n', (error) => {
      if (error) finish(session, 'failed', '无法向官方客户端提交授权码。')
    })
  } catch {
    finish(session, 'failed', '无法向官方客户端提交授权码。')
  }
  return { ok: true, session: view(session) }
}

export function cancelAntigravityAuthLogin(args) {
  const session = lookup(args)
  if (session.ok === false) return session
  finish(session, 'cancelled')
  return { ok: true, session: view(session) }
}

export function stopAntigravityAuthLogin(vmId) {
  return Promise.all(
    [...sessions.values()].filter((session) => session.vm.id === vmId).map((session) => finish(session, 'cancelled')),
  )
}

export function stopAllAntigravityAuthLogins() {
  return Promise.all([...sessions.values()].map((session) => finish(session, 'cancelled')))
}
