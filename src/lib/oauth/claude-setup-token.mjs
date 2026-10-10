/**
 * `claude setup-token` on a slot via its cli-node: start Claude Code, extract
 * the CAI authorize URL, feed the pasted code, persist the 1-year oat (no refresh).
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { containerName } from '../vm/vm-runtime.mjs'
import { AUTH_SCHEME_BEARER } from './auth-scheme.mjs'
import { officialCcUidGid, officialCcHome, officialCcHostCli } from './official-cc-bootstrap.mjs'
import { CONTAINER_CLI_NODE_BIN } from '../vm/slot-engine.mjs'
import { OFFICIAL_CLI_VERSION } from '../identity/vm-identity.mjs'
import { slotExecArgv } from '../vm/slot-exec.mjs'
import { getVm } from '../vm/vm-registry.mjs'
import { slotHost } from '../vm/slot-host.mjs'

export const SETUP_TOKEN_SESSION_TTL_MS = 30 * 60 * 1000
export const SETUP_TOKEN_SOURCE = 'claude-setup-token'
export const SETUP_TOKEN_FLAVOR = 'claude_setup_token'

const URL_WAIT_MS = 45_000
const TOKEN_WAIT_MS = 90_000

function fail(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

function scriptsDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts')
}

export function setupTokenSessionDir(projectRoot, vmId) {
  return path.join(projectRoot, 'vms', vmId, 'run', 'setup-token')
}

export function extractSetupTokenAuthUrl(raw = '') {
  const text = String(raw || '')
  const osc = text.match(/\x1b\]8;[^;]*;(https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\x07]+)\x07/)
  if (osc?.[1]) return osc[1].trim()
  const stripped = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '')
  const compact = stripped.replace(/\s+/g, '')
  const m = compact.match(/https:\/\/claude\.com\/cai\/oauth\/authorize\?[A-Za-z0-9_\-.=&%+]+/)
  return m ? m[0] : ''
}

export function extractSetupTokenValue(raw = '') {
  const stripped = String(raw || '').replace(/\x1b(?:\[[0-9;]*[A-Za-z]|].*?(?:\x07|\x1b\\))/g, '')
  const compact = stripped.replace(/[\r\n\s]+/g, '')
  const m = compact.match(/sk-ant-oat01-[A-Za-z0-9._~+/-]{80,}=*/i)
  return m ? m[0].replace(/[.,;:]+$/, '') : ''
}

/** Official CLI JSON first. PTY extract can glue a trailing `.` + next line and look longer. */
export function pickPreferredSetupToken(fromDisk, ...rest) {
  const disk = String(fromDisk || '')
    .replace(/[\r\n\s]+/g, '')
    .trim()
  if (looksLikeOfficialSetupToken(disk)) return disk
  for (const value of rest) {
    const token = String(value || '')
      .replace(/[\r\n\s]+/g, '')
      .trim()
    if (looksLikeOfficialSetupToken(token)) return token
  }
  return ''
}

export function looksLikeOfficialSetupToken(value) {
  const s = String(value || '')
    .replace(/[\r\n\s]+/g, '')
    .trim()
  return /^sk-ant-oat01-/i.test(s) && s.length >= 100
}

function readFreshOfficialSetupToken(homeDir, sinceMs) {
  // Official CLI writes ~/.claude/.credentials.json. Worker credentials.json is
  // our persist and may still hold a previous truncated PTY extract.
  const file = path.join(homeDir, '.claude', '.credentials.json')
  try {
    if (sinceMs && fs.statSync(file).mtimeMs + 2_000 < sinceMs) return ''
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    const oauth = doc?.claudeAiOauth && typeof doc.claudeAiOauth === 'object' ? doc.claudeAiOauth : doc
    const access = oauth?.accessToken || oauth?.access_token || ''
    const refresh = oauth?.refreshToken || oauth?.refresh_token || ''
    if (!looksLikeOfficialSetupToken(access) || refresh) return ''
    return access
  } catch {
    return ''
  }
}

export function officialSetupTokenToOauth(token, extra = {}) {
  const access = String(token || '')
    .replace(/[\r\n\s]+/g, '')
    .trim()
  if (!looksLikeOfficialSetupToken(access)) {
    throw fail('setup_token_invalid', '需要官方 claude setup-token 打印的一年期 sk-ant-oat01-…')
  }
  return {
    type: 'official-setup-token',
    mode: 'official-setup-token',
    access_token: access,
    refresh_token: '',
    expires_at: Date.now() + 365 * 24 * 60 * 60 * 1000,
    scope: 'user:inference',
    scopes: ['user:inference'],
    source: SETUP_TOKEN_SOURCE,
    flavor: SETUP_TOKEN_FLAVOR,
    auth_scheme: AUTH_SCHEME_BEARER,
    ...extra,
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readPidFile(file) {
  try {
    const n = Number(String(fs.readFileSync(file, 'utf8')).trim())
    return Number.isFinite(n) && n > 1 ? n : null
  } catch {
    return null
  }
}

export function readSetupTokenSession(projectRoot, vmId) {
  const dir = setupTokenSessionDir(projectRoot, vmId)
  const status = readJson(path.join(dir, 'status.json'))
  if (!status) return null
  const ptyPid = readPidFile(path.join(dir, 'pty.pid'))
  const alive = !!(ptyPid && pidAlive(ptyPid))
  const expired = Number(status.expires_at || 0) && Date.now() > Number(status.expires_at)
  return {
    session_id: status.session_id || '',
    vm_id: status.vm_id || vmId,
    status: status.status || '',
    auth_url: status.auth_url || '',
    error: status.error || null,
    code_fed: !!status.code_fed,
    created_at: status.created_at || 0,
    updated_at: status.updated_at || 0,
    expires_at: status.expires_at || 0,
    flavor: SETUP_TOKEN_FLAVOR,
    source: SETUP_TOKEN_SOURCE,
    alive,
    expired: !!expired,
  }
}

/** Same official CLI / PKCE pair stays up until the operator force-regenerates. */
export function isPersistentSetupTokenSession(session, { force = false } = {}) {
  if (force || !session) return false
  return !!(session.alive && session.auth_url && !session.expired)
}

export async function stopClaudeSetupTokenSession(projectRoot, vmId, { spawn = spawnSync } = {}) {
  const dir = setupTokenSessionDir(projectRoot, vmId)
  const ptyPid = readPidFile(path.join(dir, 'pty.pid'))
  const childPid = readPidFile(path.join(dir, 'child.pid'))
  for (const pid of [ptyPid, childPid]) {
    if (pid && pidAlive(pid)) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {}
    }
  }
  const vm = { ...(getVm(projectRoot, vmId) || {}), id: vmId }
  try {
    const env = slotHost(vm).dockerEnv()
    spawn(
      'docker',
      slotExecArgv(vm, ['sh', '-lc', `pkill -f '${CONTAINER_CLI_NODE_BIN} setup-token' >/dev/null 2>&1 || true`]),
      {
        stdio: 'ignore',
        timeout: 5000,
        ...(env ? { env } : {}),
      },
    )
  } catch {}

  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (![ptyPid, childPid].some((pid) => pid && pidAlive(pid))) break
    await sleep(50)
  }
  for (const pid of [ptyPid, childPid]) {
    if (pid && pidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  }
  for (const name of ['code.inbox', 'token', 'pty.pid', 'child.pid', 'pty.out', 'status.json']) {
    try {
      fs.unlinkSync(path.join(dir, name))
    } catch {}
  }
  return { ok: true }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(fn, timeoutMs, intervalMs = 200) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const value = fn()
    if (value) return value
    await sleep(intervalMs)
  }
  return null
}

function ensureCli(projectRoot, vmId) {
  if (!fs.existsSync(officialCcHostCli(officialCcHome(projectRoot, vmId)))) {
    throw fail('cli_node_missing', '当前槽没有 cli-node，请先同步 wrap-cli')
  }
}

export async function startClaudeSetupTokenSession({ vm, projectRoot, force = false } = {}) {
  const vmId = vm?.id
  if (!vmId || !projectRoot) throw fail('vm_required', 'vm_id required')
  if (process.env.KIN_FAKE_SESSION_OAUTH === '1' || process.env.KIN_FAKE_SESSION_OAUTH === 'true') {
    return {
      session_id: 'fake-setup-token',
      auth_url: 'https://claude.com/cai/oauth/authorize?code=true&fake=setup-token',
      expires_at: Date.now() + SETUP_TOKEN_SESSION_TTL_MS,
      vm_id: vmId,
      flavor: SETUP_TOKEN_FLAVOR,
      source: SETUP_TOKEN_SOURCE,
    }
  }
  const existing = readSetupTokenSession(projectRoot, vmId)
  if (isPersistentSetupTokenSession(existing, { force })) {
    return {
      session_id: existing.session_id,
      auth_url: existing.auth_url,
      expires_at: existing.expires_at,
      vm_id: vmId,
      flavor: SETUP_TOKEN_FLAVOR,
      source: SETUP_TOKEN_SOURCE,
      reused: true,
    }
  }
  ensureCli(projectRoot, vmId)
  await stopClaudeSetupTokenSession(projectRoot, vmId)
  const dir = setupTokenSessionDir(projectRoot, vmId)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const sessionId = crypto.randomBytes(16).toString('hex')
  const createdAt = Date.now()
  const expiresAt = createdAt + SETUP_TOKEN_SESSION_TTL_MS
  const ids = officialCcUidGid(vmId)
  const ptyScript = path.join(scriptsDir(), 'claude-setup-token-pty.py')
  const execArgv = slotExecArgv(vm, [CONTAINER_CLI_NODE_BIN, 'setup-token'], {
    user: `${ids.uid}:${ids.gid}`,
    env: [
      'HOME=/home/kincli',
      'TMPDIR=/home/kincli/.cache/tmp',
      `TZ=${vm.timezone || vm.fingerprint?.timezone || 'UTC'}`,
      `LANG=${vm.locale || vm.fingerprint?.locale || 'en_US.UTF-8'}`,
      `LC_ALL=${vm.locale || vm.fingerprint?.locale || 'en_US.UTF-8'}`,
      'PATH=/home/kincli/.local/bin:/usr/bin:/bin',
      'CLAUDE_CODE_HOST_REFRESH=1',
      `CLAUDE_CODE_VERSION=${OFFICIAL_CLI_VERSION}`,
      'USER_TYPE=external',
      'KIN_SETUP_TOKEN=1',
      'CLAUDE_CODE_USE_BEDROCK=0',
      'CLAUDE_CODE_USE_VERTEX=0',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=0',
      'DISABLE_TELEMETRY=1',
      'DO_NOT_TRACK=1',
      'ANTHROPIC_BASE_URL=',
      'ANTHROPIC_API_KEY=',
      'ANTHROPIC_AUTH_TOKEN=',
      'CLAUDE_CODE_OAUTH_TOKEN=',
      'TERM=xterm-256color',
      'COLUMNS=220',
      'LINES=40',
    ],
    workdir: '/home/kincli',
    interactive: true,
    tty: true,
  })
  const child = spawn('python3', [ptyScript], {
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: process.env.HOME || '/root',
      LANG: vm.locale || vm.fingerprint?.locale || 'en_US.UTF-8',
      LC_ALL: vm.locale || vm.fingerprint?.locale || 'en_US.UTF-8',
      TZ: vm.timezone || vm.fingerprint?.timezone || 'UTC',
      TERM: 'xterm-256color',
      KIN_CONTAINER: containerName(vmId),
      KIN_UID: String(ids.uid),
      KIN_GID: String(ids.gid),
      KIN_CLI_BIN: CONTAINER_CLI_NODE_BIN,
      KIN_CLI_VERSION: OFFICIAL_CLI_VERSION,
      KIN_SESSION_DIR: dir,
      KIN_SESSION_ID: sessionId,
      KIN_VM_ID: vmId,
      KIN_CREATED_AT: String(createdAt),
      KIN_EXPIRES_AT: String(expiresAt),
      KIN_SESSION_TTL_MS: String(SETUP_TOKEN_SESSION_TTL_MS),
      KIN_DOCKER_ARGV: JSON.stringify(execArgv),
    },
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  const found = await waitFor(() => {
    const s = readSetupTokenSession(projectRoot, vmId)
    if (Number(s?.updated_at || 0) < createdAt) return null
    if (s?.error && s.status === 'error') throw fail('setup_token_failed', s.error)
    return s?.auth_url ? s : null
  }, URL_WAIT_MS)
  if (!found?.auth_url) {
    const s = readSetupTokenSession(projectRoot, vmId)
    throw fail('setup_token_url_timeout', s?.error || '槽内 claude setup-token 未给出授权链接')
  }
  return {
    session_id: found.session_id || sessionId,
    auth_url: found.auth_url,
    expires_at: found.expires_at || expiresAt,
    vm_id: vmId,
    flavor: SETUP_TOKEN_FLAVOR,
    source: SETUP_TOKEN_SOURCE,
    reused: false,
  }
}

export async function completeClaudeSetupToken({ projectRoot, vmId, sessionId, code } = {}) {
  const raw = String(code || '').trim()
  if (!raw) throw fail('code_required', '请粘贴授权码，或直接粘贴一年期 sk-ant-oat01-…')
  if (process.env.KIN_FAKE_SESSION_OAUTH === '1' || process.env.KIN_FAKE_SESSION_OAUTH === 'true') {
    return officialSetupTokenToOauth('sk-ant-oat01-' + 'F'.repeat(96))
  }
  if (looksLikeOfficialSetupToken(raw)) {
    await stopClaudeSetupTokenSession(projectRoot, vmId)
    return officialSetupTokenToOauth(raw)
  }
  const session = readSetupTokenSession(projectRoot, vmId)
  if (!session?.alive || session.expired) {
    throw fail('session_expired', '官方 setup-token 会话不存在或已过期，请重新生成授权链接')
  }
  if (session.status === 'token_ready') {
    const fromDisk = readFreshOfficialSetupToken(
      officialCcHome(projectRoot, vmId),
      session.created_at || session.updated_at || 0,
    )
    let fromPty = ''
    try {
      fromPty = extractSetupTokenValue(
        fs.readFileSync(path.join(setupTokenSessionDir(projectRoot, vmId), 'token'), 'utf8'),
      )
    } catch {}
    const found = pickPreferredSetupToken(fromDisk, fromPty)
    if (found) {
      await stopClaudeSetupTokenSession(projectRoot, vmId)
      return officialSetupTokenToOauth(found)
    }
  }
  if (sessionId && session.session_id && session.session_id !== String(sessionId)) {
    throw fail('session_vm_mismatch', '授权会话与当前虚拟机不匹配')
  }
  const dir = setupTokenSessionDir(projectRoot, vmId)
  const home = officialCcHome(projectRoot, vmId)
  const fedAt = Date.now()
  const statusPath = path.join(dir, 'status.json')
  const prev = readJson(statusPath) || {}
  fs.writeFileSync(
    statusPath,
    JSON.stringify({
      ...prev,
      status: 'code_fed',
      error: null,
      code_fed: true,
      updated_at: fedAt,
    }) + '\n',
    { encoding: 'utf8', mode: 0o600 },
  )
  fs.writeFileSync(path.join(dir, 'code.inbox'), raw + '\n', { mode: 0o600 })
  const token = await waitFor(
    () => {
      const s = readSetupTokenSession(projectRoot, vmId)
      if (s?.error && Number(s.updated_at || 0) > fedAt) {
        throw fail(s.status === 'error' ? 'setup_token_oauth_failed' : 'setup_token_invalid_code', s.error)
      }
      return readFreshOfficialSetupToken(home, fedAt) || null
    },
    TOKEN_WAIT_MS,
    300,
  )
  let fromPty = ''
  try {
    fromPty = extractSetupTokenValue(fs.readFileSync(path.join(dir, 'token'), 'utf8'))
  } catch {}
  const latest = pickPreferredSetupToken(token, readFreshOfficialSetupToken(home, fedAt), fromPty)
  if (!latest) {
    const s = readSetupTokenSession(projectRoot, vmId)
    throw fail(
      'setup_token_timeout',
      s?.error || '官方 CLI 未写入一年期 Setup Token。请再打开当前链接粘贴完整授权码（含 # 后半段），不要重新生成',
    )
  }
  await stopClaudeSetupTokenSession(projectRoot, vmId)
  return officialSetupTokenToOauth(latest)
}
