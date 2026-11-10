/**
 * Official `claude auth login` inside a slot that already has a running
 * container and its selected Claude CLI. The CLI owns PKCE, the authorize URL
 * and the token exchange. The host only extracts the URL, feeds the pasted
 * code, and reads the full OAuth grant the CLI wrote.
 *
 * This is not `claude setup-token` or the separate kin-oauth-auth helper.
 * Cookie import and setup-token stay on their own paths.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { containerName, inspectContainer, officialCcUidGid } from '../vm/vm-runtime.mjs'
import { officialCcHome } from './official-cc-bootstrap.mjs'
import { execDetached, inspectContainerOrNull } from '../cluster/docker-remote.mjs'
import {
  CONTAINER_CLI_NODE_BIN,
  CONTAINER_CC_NODE_BIN,
  LOCAL_CRAG_CLAUDE,
  REMOTE_CRAG_CLAUDE,
  resolveSlotClaude,
} from '../vm/slot-engine.mjs'
import { OFFICIAL_CLI_VERSION } from '../identity/vm-identity.mjs'
import { slotExecArgv, slotExecCmd } from '../vm/slot-exec.mjs'
import { getVm } from '../vm/vm-registry.mjs'
import { slotHost } from '../vm/slot-host.mjs'
import { FULL_OAUTH_SCOPE } from './oauth-contract.mjs'
import { flattenOauthIdentity } from './oauth-identity.mjs'
import { prepareSlotOAuth } from './guest-oauth-helper.mjs'
import { slotExec } from '../vm/slot-runtime.mjs'

export const AUTH_LOGIN_SESSION_TTL_MS = 30 * 60 * 1000
export const AUTH_LOGIN_SOURCE = 'claude-auth-login'
export const AUTH_LOGIN_FLAVOR = 'claude_code'

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

export function authLoginSessionDir(projectRoot, vmId) {
  return path.join(projectRoot, 'vms', vmId, 'run', 'auth-login')
}

/** Official `claude auth login` prints the manual CAI URL, not the console authorize page. */
export function extractAuthLoginUrl(raw = '') {
  const text = String(raw || '')
  const osc = text.match(/\x1b\]8;[^;]*;(https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\x07]+)\x07/)
  if (osc?.[1]) return osc[1].trim()
  const stripped = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '')
  const compact = stripped.replace(/\s+/g, '')
  const m = compact.match(/https:\/\/claude\.com\/cai\/oauth\/authorize\?[A-Za-z0-9_\-.=&%+]+/)
  return m ? m[0] : ''
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
    return Number.isInteger(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

export function readAuthLoginSession(projectRoot, vmId) {
  const dir = authLoginSessionDir(projectRoot, vmId)
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
    flavor: AUTH_LOGIN_FLAVOR,
    source: AUTH_LOGIN_SOURCE,
    cli_bin: status.cli_bin || '',
    alive,
    expired: !!expired,
  }
}

export function isPersistentAuthLoginSession(session, { force = false, cliBin = null } = {}) {
  if (force || !session) return false
  if (cliBin && (session.cli_bin || CONTAINER_CLI_NODE_BIN) !== cliBin) return false
  return !!(session.alive && session.auth_url && !session.expired && session.status !== 'login_ready')
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

/**
 * Official login may run only after the slot container is running and its CLI
 * is executable inside it. A local slot keeps that binary on the host home;
 * a cluster slot bakes it into the image, so the host file is not the check.
 * A seed file or a stopped container is not enough.
 */

export async function assertAuthLoginReady(
  projectRoot,
  vm,
  { inspect = inspectContainer, cliExists = null, routing = {} } = {},
) {
  const vmId = vm?.id
  if (!vmId || !projectRoot) throw fail('vm_required', 'vm_id required')
  const host = slotHost(vm)
  const name = containerName(vmId)
  let inspected
  if (host.bakedKernel) {
    try {
      const info = await inspectContainerOrNull(host.dockerApi(), name)
      const state = info?.State || {}
      inspected = info ? { running: state.Running === true && state.Restarting !== true } : null
    } catch (err) {
      throw fail('container_unreadable', err.message || '无法检查槽位容器')
    }
  } else {
    inspected = inspect(name)
  }
  if (!inspected?.running) {
    throw fail('container_not_ready', '容器尚未创建或未运行，请先完成容器创建再登录')
  }
  const selected = resolveSlotClaude(vm, routing, host)
  const cli = host.bakedKernel
    ? selected.bin
    : path.join(officialCcHome(projectRoot, vmId), '.kin', path.posix.relative('/home/kincli/.kin', selected.bin))
  const present = cliExists ? await cliExists(cli, vm) : host.bakedKernel ? true : fs.existsSync(cli)
  if (!present) {
    throw fail(
      selected.native ? 'claude_cli_missing' : 'cli_node_missing',
      '所选内核的 Claude CLI 尚未安装，请先同步对应内核',
    )
  }
  return { container: name, cli }
}

export async function stopClaudeAuthLoginSession(projectRoot, vmId, { execDetach = execDetached } = {}) {
  const dir = authLoginSessionDir(projectRoot, vmId)
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
    const host = slotHost(vm)
    const connect = host.dockerApi()
    // A kernel switch may leave the previous CLI's login alive. Match only known
    // in-slot binaries; [/] keeps pkill from matching its own shell command.
    const bins = [
      ...new Set([
        host.bins.cli,
        host.bins.cc,
        CONTAINER_CLI_NODE_BIN,
        CONTAINER_CC_NODE_BIN,
        LOCAL_CRAG_CLAUDE,
        REMOTE_CRAG_CLAUDE,
      ]),
    ]
    const cleanup = bins
      .map(
        (bin) =>
          `pkill -f '${bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/^\//, '[/]')} auth login' >/dev/null 2>&1 || true`,
      )
      .join('; ')
    const { Cmd, User } = slotExecCmd(vm, ['sh', '-lc', cleanup])
    await execDetach(connect, containerName(vmId), Cmd, User ? { user: User } : {})
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
  for (const name of ['code.inbox', 'credential.json', 'pty.pid', 'child.pid', 'pty.out', 'status.json']) {
    try {
      fs.unlinkSync(path.join(dir, name))
    } catch {}
  }
  return { ok: true }
}

function loginEnv(vm, { native = false } = {}) {
  const locale = vm.locale || vm.fingerprint?.locale || 'en_US.UTF-8'
  const tz = vm.timezone || vm.fingerprint?.timezone || 'UTC'
  return [
    'HOME=/home/kincli',
    'TMPDIR=/home/kincli/.cache/tmp',
    'CLAUDE_CONFIG_DIR=/home/kincli/.claude',
    'KERNEL_CONFIG=/run/kin/kernel.json',
    `TZ=${tz}`,
    `LANG=${locale}`,
    `LC_ALL=${locale}`,
    'PATH=/home/kincli/.local/bin:/usr/bin:/bin',
    'CLAUDE_CODE_HOST_REFRESH=1',
    ...(!native ? [`CLAUDE_CODE_VERSION=${OFFICIAL_CLI_VERSION}`] : []),
    'USER_TYPE=external',
    // The slot cli-node guard spares this host-run official login.
    'KIN_AUTH_LOGIN=1',
    'CLAUDE_CODE_USE_BEDROCK=0',
    'CLAUDE_CODE_USE_VERTEX=0',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=0',
    'DISABLE_TELEMETRY=1',
    'DO_NOT_TRACK=1',
    'ANTHROPIC_BASE_URL=',
    'ANTHROPIC_API_KEY=',
    'ANTHROPIC_AUTH_TOKEN=',
    'CLAUDE_CODE_OAUTH_TOKEN=',
    'CLAUDE_CODE_OAUTH_REFRESH_TOKEN=',
    'TERM=xterm-256color',
    'COLUMNS=220',
    'LINES=40',
  ]
}

export async function startClaudeAuthLoginSession({
  vm,
  projectRoot,
  routing,
  force = false,
  inspect = inspectContainer,
  prepare = prepareSlotOAuth,
  spawnPty = spawn,
  stopSession = stopClaudeAuthLoginSession,
} = {}) {
  const vmId = vm?.id
  if (!vmId || !projectRoot) throw fail('vm_required', 'vm_id required')
  const fake = process.env.KIN_FAKE_SESSION_OAUTH === '1' || process.env.KIN_FAKE_SESSION_OAUTH === 'true'
  if (!fake) {
    const prepared = await prepare({ exec: slotExec(projectRoot, vm), projectRoot, routing })
    vm = prepared.exec.vm
  }
  const selected = resolveSlotClaude(vm, routing || {}, slotHost(vm))
  await assertAuthLoginReady(projectRoot, vm, { inspect, routing })
  if (fake) {
    return {
      session_id: 'fake-auth-login',
      auth_url: 'https://claude.com/cai/oauth/authorize?code=true&fake=auth-login',
      expires_at: Date.now() + AUTH_LOGIN_SESSION_TTL_MS,
      vm_id: vmId,
      flavor: AUTH_LOGIN_FLAVOR,
      source: AUTH_LOGIN_SOURCE,
    }
  }
  const existing = readAuthLoginSession(projectRoot, vmId)
  if (isPersistentAuthLoginSession(existing, { force, cliBin: selected.bin })) {
    return {
      session_id: existing.session_id,
      auth_url: existing.auth_url,
      expires_at: existing.expires_at,
      vm_id: vmId,
      flavor: AUTH_LOGIN_FLAVOR,
      source: AUTH_LOGIN_SOURCE,
      reused: true,
    }
  }
  await stopSession(projectRoot, vmId)
  const dir = authLoginSessionDir(projectRoot, vmId)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const sessionId = crypto.randomBytes(16).toString('hex')
  const createdAt = Date.now()
  const expiresAt = createdAt + AUTH_LOGIN_SESSION_TTL_MS
  const host = slotHost(vm)
  const user = host.execUser(vm)
  const [uid, gid] = user.split(':')
  const dockerEnv = host.dockerEnv()
  const ptyScript = path.join(scriptsDir(), 'claude-auth-login-pty.py')
  const execArgv = slotExecArgv(vm, [selected.bin, 'auth', 'login'], {
    user,
    env: loginEnv(vm, selected),
    workdir: '/home/kincli',
    interactive: true,
    tty: true,
  })
  const child = spawnPty('python3', [ptyScript], {
    env: {
      ...(dockerEnv?.DOCKER_HOST ? { DOCKER_HOST: dockerEnv.DOCKER_HOST } : {}),
      PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: process.env.HOME || '/root',
      LANG: vm.locale || vm.fingerprint?.locale || 'en_US.UTF-8',
      LC_ALL: vm.locale || vm.fingerprint?.locale || 'en_US.UTF-8',
      TZ: vm.timezone || vm.fingerprint?.timezone || 'UTC',
      TERM: 'xterm-256color',
      KIN_CONTAINER: containerName(vmId),
      KIN_UID: uid,
      KIN_GID: gid,
      KIN_CLI_BIN: selected.bin,
      KIN_SESSION_DIR: dir,
      KIN_CREDENTIAL_FILE: path.join(officialCcHome(projectRoot, vmId), '.claude', '.credentials.json'),
      KIN_SESSION_ID: sessionId,
      KIN_VM_ID: vmId,
      KIN_CREATED_AT: String(createdAt),
      KIN_EXPIRES_AT: String(expiresAt),
      KIN_SESSION_TTL_MS: String(AUTH_LOGIN_SESSION_TTL_MS),
      KIN_DOCKER_ARGV: JSON.stringify(execArgv),
      KIN_CREDENTIAL_ARGV: JSON.stringify(
        slotExecArgv(
          vm,
          [
            'sh',
            '-c',
            'f=/home/kincli/.claude/credentials.json; [ -f "$f" ] && [ ! -L "$f" ] && dd if="$f" iflag=nofollow,nonblock bs=65536 count=16 status=none',
          ],
          { user },
        ),
      ),
    },
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  const found = await waitFor(() => {
    const s = readAuthLoginSession(projectRoot, vmId)
    if (Number(s?.updated_at || 0) < createdAt) return null
    if (s?.error && (s.status === 'error' || s.status === 'exited')) throw fail('auth_login_failed', s.error)
    return s?.auth_url ? s : null
  }, URL_WAIT_MS)
  if (!found?.auth_url) {
    const s = readAuthLoginSession(projectRoot, vmId)
    throw fail('auth_login_url_timeout', s?.error || '槽内 claude auth login 未给出授权链接')
  }
  return {
    session_id: found.session_id || sessionId,
    auth_url: found.auth_url,
    expires_at: found.expires_at || expiresAt,
    vm_id: vmId,
    flavor: AUTH_LOGIN_FLAVOR,
    source: AUTH_LOGIN_SOURCE,
    reused: false,
  }
}

function scopeText(oauth) {
  if (Array.isArray(oauth?.scopes) && oauth.scopes.length) return oauth.scopes.filter(Boolean).join(' ')
  return String(oauth?.scope || '').trim()
}

/** Full OAuth written by official login. Setup-token oats and refresh-less grants are not this flow. */
export function officialLoginCredentialToOauth(doc, extra = {}) {
  const oauth = doc?.claudeAiOauth && typeof doc.claudeAiOauth === 'object' ? doc.claudeAiOauth : doc || {}
  const access = String(oauth.accessToken || oauth.access_token || '').trim()
  const refresh = String(oauth.refreshToken || oauth.refresh_token || '').trim()
  const scope = scopeText(oauth)
  const inferenceOnly = scope && !/\buser:profile\b/.test(scope) && /\buser:inference\b/.test(scope)
  if (!access || !refresh || inferenceOnly) {
    throw fail('auth_login_incomplete', '官方登录未写入完整 OAuth（需要 access、refresh 和 user:profile）')
  }
  if (!/\buser:profile\b/.test(scope) || !/\buser:inference\b/.test(scope)) {
    throw fail('auth_login_scope', '官方登录没有拿到完整 OAuth scope')
  }
  const expiresAt = Number(oauth.expiresAt || oauth.expires_at || 0)
  const expiresIn = expiresAt > Date.now() ? Math.floor((expiresAt - Date.now()) / 1000) : 0
  const identity = flattenOauthIdentity({
    ...oauth,
    email: oauth.email || oauth.emailAddress || oauth.email_address,
    account_uuid: oauth.accountUuid || oauth.account_uuid,
    org_uuid: oauth.orgUuid || oauth.org_uuid,
    subscription_type: oauth.subscriptionType || oauth.subscription_type,
  })
  return {
    access_token: access,
    refresh_token: refresh,
    token_type: 'Bearer',
    expires_in: expiresIn,
    expires_at: expiresAt ? Math.floor(expiresAt / 1000) : null,
    scope,
    email: identity.email,
    email_address: identity.email,
    account_uuid: identity.account_uuid,
    org_uuid: identity.org_uuid,
    subscription_type: identity.subscription_type,
    rate_limit_tier: identity.rate_limit_tier,
    type: 'oauth',
    mode: 'oauth',
    source: AUTH_LOGIN_SOURCE,
    flavor: AUTH_LOGIN_FLAVOR,
    ...extra,
  }
}

function readLoginCredential(file) {
  const doc = readJson(file)
  if (!doc) return null
  try {
    return officialLoginCredentialToOauth(doc)
  } catch (err) {
    if (err.code === 'auth_login_incomplete') return null
    throw err
  }
}

export async function completeClaudeAuthLogin({ projectRoot, vmId, sessionId, code } = {}) {
  const raw = String(code || '').trim()
  if (!raw) throw fail('code_required', '请粘贴授权码（含 # 后半段）')
  if (process.env.KIN_FAKE_SESSION_OAUTH === '1' || process.env.KIN_FAKE_SESSION_OAUTH === 'true') {
    return officialLoginCredentialToOauth({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-FAKE-AUTH-URL',
        refreshToken: 'sk-ant-ort01-' + 'R'.repeat(24),
        expiresAt: Date.now() + 8 * 3600 * 1000,
        scopes: FULL_OAUTH_SCOPE.split(' '),
        email: 'fake-oauth@kin.test',
        accountUuid: 'acct-fake-auth-login',
        orgUuid: 'org-fake-auth-login',
        subscriptionType: 'pro',
      },
    })
  }
  const session = readAuthLoginSession(projectRoot, vmId)
  if (!session?.alive || session.expired) {
    throw fail('session_expired', '官方登录会话不存在或已过期，请重新生成授权链接')
  }
  if (sessionId && session.session_id && session.session_id !== String(sessionId)) {
    throw fail('session_vm_mismatch', '授权会话与当前虚拟机不匹配')
  }
  const dir = authLoginSessionDir(projectRoot, vmId)
  const credFile = path.join(dir, 'credential.json')
  if (session.status === 'login_ready') {
    const ready = readLoginCredential(credFile)
    if (ready) {
      await stopClaudeAuthLoginSession(projectRoot, vmId)
      return ready
    }
  }
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
  const credential = await waitFor(
    () => {
      const s = readAuthLoginSession(projectRoot, vmId)
      if (s?.error && Number(s.updated_at || 0) > fedAt) {
        throw fail(s.status === 'error' ? 'auth_login_oauth_failed' : 'auth_login_invalid_code', s.error)
      }
      if (s?.status !== 'login_ready') return null
      return readLoginCredential(credFile)
    },
    TOKEN_WAIT_MS,
    300,
  )
  if (!credential) {
    const s = readAuthLoginSession(projectRoot, vmId)
    throw fail(
      'auth_login_timeout',
      s?.error || '官方 CLI 未完成换票。请再打开当前链接粘贴完整授权码（含 # 后半段），不要重新生成',
    )
  }
  await stopClaudeAuthLoginSession(projectRoot, vmId)
  return credential
}
