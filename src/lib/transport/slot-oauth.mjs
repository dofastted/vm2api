/**
 * Panel-owned OAuth execution via the control plane's own `bin/kin-worker`.
 *
 * Credentials are a Panel SSOT: the control plane is the sole reader/writer of
 * `vms/<id>/cli-home/.claude/credentials.json` and its `.refresh-attempt` journal.
 * Outbound OAuth requests still leave strictly through the target VM's bound exit
 * (`hostProxyUrlForVm`: slot SOCKS5/HTTP proxy, local `px-local` default route, or
 * a cluster/macOS node's loopback SSH SOCKS5 forwarder) with Go `kin-worker`'s
 * Chrome TLS impersonation. Slots never execute `kin-worker oauth` or rotate RTs;
 * after a panel refresh, the panel one-way projects the read-only credential down
 * to the slot via `slotHost(vm).syncCredentials`.
 */
import { spawn } from 'node:child_process'
import { randomUUID as cryptoRandomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { postRustKernelTelemetryEvent } from './rust-kernel-client.mjs'
import { hostProxyUrlForVm, slotHost } from '../vm/slot-host.mjs'
import { isLocalEgressProxy } from '../vm/egress.mjs'
import { proxyBlockedReason } from '../vm/proxy-policy.mjs'
import { canRefreshCredential } from '../oauth/credential-mode.mjs'
import {
  assertSafeSlotCredentialPaths,
  hasRefreshPresence,
  mirrorWorkerCredentialsToVm,
  needsRefresh,
  readWorkerCredentialFile,
  sealWorkerCredentialFile,
  slotWorkerCredentialPath,
  withCredentialRefreshLock,
} from '../oauth/oauth-credentials.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const OPS = new Set([
  'refresh',
  'usage',
  'profile',
  'models',
  'count-tokens',
  'reset-status',
  'reset-redeem',
  'guard-probe',
])

function failure(code, message = undefined) {
  const error = { code }
  if (message !== undefined) error.message = message
  return {
    ok: false,
    status: 0,
    body: { error },
    headers: {},
    via: 'panel-worker',
    transportError: true,
  }
}

export function resolvePanelWorkerBin(projectRoot = '') {
  const envBin = String(process.env.KIN_PANEL_WORKER_BIN || process.env.KIN_WORKER_BIN || '').trim()
  if (envBin) return envBin
  const candidates = [
    projectRoot ? path.join(projectRoot, 'bin', 'kin-worker') : '',
    path.join(REPO_ROOT, 'bin', 'kin-worker'),
    '/opt/vm2api/bin/kin-worker',
    '/opt/kin-gateway/bin/kin-worker',
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return candidates[0] || '/usr/local/bin/kin-worker'
}

function spawnCapturedProcess(bin, argv, { stdin = '', timeoutMs = 45000, env, onStdoutLine } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, argv, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(env ? { env } : {}),
    })
    const stdout = []
    const stderr = []
    let settled = false
    let timer = null
    let stdoutBytes = 0
    let stderrBytes = 0
    let outputLimit = false
    if (onStdoutLine) {
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
      lines.on('line', onStdoutLine)
    }
    child.stdin?.on('error', () => {})

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    child.stdout?.on('data', (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes <= 1024 * 1024) stdout.push(chunk)
      else {
        outputLimit = true
        child.kill('SIGKILL')
      }
    })
    child.stderr?.on('data', (chunk) => {
      stderrBytes += chunk.length
      if (stderrBytes <= 65536) stderr.push(chunk)
    })
    child.once('error', (error) => {
      finish({
        code: null,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: String(error?.message || error).slice(0, 300),
        timed_out: false,
      })
    })
    child.once('close', (code) => {
      finish({
        code,
        output_limit: outputLimit,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timed_out: false,
      })
    })

    const waitMs = Math.max(1, Number(timeoutMs) || 45000)
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
      finish({
        code: null,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timed_out: true,
      })
    }, waitMs)
    timer.unref?.()

    child.stdin?.end(stdin)
  })
}

/** Retained for container status probes (`slot-process-status.mjs`). */
export function runSlotProcess(argv, opts = {}) {
  return spawnCapturedProcess(process.env.KIN_DOCKER_BIN || 'docker', argv, opts)
}

export function runPanelWorkerProcess(argv, { bin = resolvePanelWorkerBin(), ...opts } = {}) {
  return spawnCapturedProcess(bin, argv, opts)
}

function lastJsonLine(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (!lines.length) return null
  try {
    return JSON.parse(lines.at(-1))
  } catch {
    return null
  }
}

const allowTestEndpoints = () => process.env.KIN_WORKER_TEST_ENDPOINTS === '1'

function readExistingWorkerConfig(slotDir) {
  if (!slotDir) return null
  let fd = null
  try {
    const runDir = path.join(slotDir, 'run')
    const dirStat = fs.lstatSync(runDir)
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return null
    const configPath = path.join(runDir, 'worker.json')
    const fileStat = fs.lstatSync(configPath)
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) return null
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    fd = fs.openSync(configPath, flags)
    if (!fs.fstatSync(fd).isFile()) return null
    const raw = fs.readFileSync(fd, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {}
    }
  }
}

/**
 * Resolve the outbound exit for panel-side OAuth (`bin/kin-worker`).
 * Strictly fail-closed: an unbound or blocked proxy never falls back to the
 * control plane's direct route unless the slot is explicitly bound to local egress.
 */
export function resolvePanelOauthEgress(vm, { proxyUrl, existingConfig } = {}) {
  if (proxyUrl !== undefined) {
    const explicit = String(proxyUrl || '').trim()
    if (explicit) return { ok: true, egress_mode: 'socks', proxy_url: explicit, proxy_required: true }
    return { ok: true, egress_mode: 'transparent', proxy_url: '', proxy_required: false }
  }
  const blocked = proxyBlockedReason(vm?.proxy)
  if (blocked) {
    return { ok: false, code: 'proxy_required', message: `slot proxy is blocked (${blocked})` }
  }
  if (isLocalEgressProxy(vm?.proxy)) {
    let resolved = ''
    try {
      resolved = hostProxyUrlForVm(vm)
    } catch (error) {
      return {
        ok: false,
        code: 'proxy_required',
        message: String(error?.message || 'node local egress is unavailable'),
      }
    }
    if (resolved) {
      return { ok: true, egress_mode: 'socks', proxy_url: resolved, proxy_required: true }
    }
    return { ok: true, egress_mode: 'transparent', proxy_url: '', proxy_required: false }
  }
  const bound = hostProxyUrlForVm(vm)
  if (bound) {
    return { ok: true, egress_mode: 'socks', proxy_url: bound, proxy_required: true }
  }
  if (allowTestEndpoints() && existingConfig?.test_endpoints === true) {
    return {
      ok: true,
      egress_mode: existingConfig.egress_mode || (existingConfig.proxy_url ? 'socks' : 'transparent'),
      proxy_url: existingConfig.proxy_url || '',
      proxy_required: existingConfig.proxy_required !== false,
    }
  }
  return { ok: false, code: 'proxy_required', message: 'slot SOCKS5 is required' }
}

export function buildPanelOauthConfig(exec, { proxyUrl } = {}) {
  const vmId = String(exec?.vmId || exec?.vm?.id || '').trim()
  const vm = { ...(exec?.vm || {}), id: vmId }
  if (exec?.homeDir) {
    try {
      assertSafeSlotCredentialPaths(exec.homeDir)
    } catch (error) {
      return {
        ok: false,
        code: error?.code || 'unsafe_credential_path',
        message: String(error?.message || 'slot credential path is unsafe'),
      }
    }
  }
  const slotDir = exec?.homeDir ? path.dirname(exec.homeDir) : ''
  const existing = readExistingWorkerConfig(slotDir)
  const egress = resolvePanelOauthEgress(vm, { proxyUrl, existingConfig: existing })
  if (!egress.ok) return egress

  const credPath = slotWorkerCredentialPath(exec?.homeDir) || '/tmp/kin-panel-missing-credentials.json'
  const socketPath = slotDir ? path.resolve(slotDir, 'run', 'worker.sock') : '/tmp/kin-panel-worker.sock'
  const testEndpointsAllowed = allowTestEndpoints() && existing?.test_endpoints === true
  const config = {
    vm_id: vmId || existing?.vm_id || 'panel',
    socket_path: socketPath,
    credential_path: path.resolve(credPath),
    egress_mode: egress.egress_mode,
    proxy_url: egress.proxy_url,
    proxy_required: egress.proxy_required,
    refresh_skew_seconds: Number(existing?.refresh_skew_seconds) > 0 ? Number(existing.refresh_skew_seconds) : 300,
    ...(existing?.oauth_user_agent ? { oauth_user_agent: existing.oauth_user_agent } : {}),
    ...(existing?.cli_version ? { cli_version: existing.cli_version } : {}),
    ...(testEndpointsAllowed && existing?.anthropic_base_url
      ? { anthropic_base_url: existing.anthropic_base_url }
      : {}),
    ...(testEndpointsAllowed && existing?.oauth_token_url ? { oauth_token_url: existing.oauth_token_url } : {}),
    ...(testEndpointsAllowed ? { test_endpoints: true } : {}),
  }
  return { ok: true, config }
}

/**
 * Does the control plane's `bin/kin-worker` keep the refresh attempt journal?
 * Asked with an operation that reads no config, no credential, and touches no network.
 */
export async function probeAttemptGuard(exec, opts = {}) {
  try {
    const result = await runSlotOauth(exec, 'guard-probe', { timeoutMs: 15000, ...opts })
    return result?.ok === true && result?.body?.attempt_guard === true
  } catch {
    return false
  }
}

const isInvalidArguments = (result) => lastJsonLine(result?.stdout)?.body?.error?.code === 'invalid_arguments'

async function projectRefreshedCredential(host, vm, slotDir) {
  const push = host?.syncCredentials || host?.onImport
  if (typeof push !== 'function') return { pushed: false, skipped: true }
  let lastError = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await push(vm, slotDir)
    } catch (error) {
      lastError = error
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  throw lastError
}

export async function runSlotOauth(exec, op, opts = {}) {
  if (process.env.KIN_CRS_MOCK === '1') return null
  if (!OPS.has(op)) return failure('worker_op_invalid', `unsupported oauth operation: ${op}`)

  if (op !== 'guard-probe' && exec?.homeDir) {
    try {
      assertSafeSlotCredentialPaths(exec.homeDir)
    } catch (error) {
      return failure(
        error?.code || 'unsafe_credential_path',
        String(error?.message || 'slot credential path is unsafe'),
      )
    }
  }

  // Non-refresh Go oauthcmd calls are strictly read-only; if the panel's credential is due
  // for refresh, rotate through the single panel SSOT refresh + one-way projection path first.
  if (op !== 'refresh' && op !== 'guard-probe' && opts.autoRefresh !== false && exec?.homeDir) {
    const cred = readWorkerCredentialFile(exec.homeDir)
    const mode = cred?.type || cred?.mode
    if (cred && canRefreshCredential(mode) && hasRefreshPresence(cred) && needsRefresh(cred.expires_at)) {
      const lockKey = String(exec.homeDir || exec.vm?.id || 'credential')
      const refreshed = await withCredentialRefreshLock(lockKey, async () => {
        const live = readWorkerCredentialFile(exec.homeDir)
        if (!live || !needsRefresh(live.expires_at)) return { ok: true }
        return runSlotOauth(exec, 'refresh', {
          timeoutMs: opts.timeoutMs,
          runWorker: opts.runWorker,
          runDocker: opts.runDocker,
          workerBin: opts.workerBin,
          postTelemetry: opts.postTelemetry,
          projectRoot: opts.projectRoot,
          proxyUrl: opts.proxyUrl,
          host: opts.host,
        })
      })
      if (refreshed && !refreshed.ok) return refreshed
    }
  }

  if (op !== 'refresh') return (await runPanelOauthProcess(exec, op, opts)).response
  // The worker's attempt journal makes refresh retry-safe after a lost answer:
  // it refuses to send a refresh token whose last send never resolved.
  const guarded = await runPanelOauthProcess(exec, op, { ...opts, attemptGuard: true })
  if (!isInvalidArguments(guarded.raw)) return { ...guarded.response, attempt_guard: true }
  const legacy = await runPanelOauthProcess(exec, op, opts)
  return { ...legacy.response, attempt_guard: false }
}

/** One panel-local `bin/kin-worker` run: `raw` is the process result, `response` the mapped answer. */
async function runPanelOauthProcess(
  exec,
  op,
  {
    body,
    headers,
    force = false,
    attemptGuard = false,
    timeoutMs = 45000,
    runWorker,
    runDocker,
    workerBin,
    projectRoot,
    proxyUrl,
    host: hostOverride,
    postTelemetry = postRustKernelTelemetryEvent,
  } = {},
) {
  const vmId = String(exec?.vmId || exec?.vm?.id || '').trim()
  const vm = { ...(exec?.vm || {}), id: vmId }
  const host = hostOverride || slotHost(vm)
  const slotDir = exec?.homeDir ? path.dirname(exec.homeDir) : ''
  const resolvedRoot = projectRoot || exec?.projectRoot || (slotDir ? path.dirname(path.dirname(slotDir)) : '')
  const runner = runWorker || runDocker || runPanelWorkerProcess
  const bin = workerBin || resolvePanelWorkerBin(resolvedRoot)

  let tmpConfigPath = null
  let configArg = '/dev/null'
  let panelConfig = null
  if (op !== 'guard-probe') {
    const built = buildPanelOauthConfig(exec, { proxyUrl })
    if (!built.ok) {
      return { raw: null, response: failure(built.code || 'proxy_required', built.message) }
    }
    panelConfig = built.config
    tmpConfigPath = path.join(os.tmpdir(), `kin-panel-oauth-${vmId || 'slot'}-${cryptoRandomUUID()}.json`)
    fs.writeFileSync(tmpConfigPath, `${JSON.stringify(panelConfig)}\n`, { mode: 0o600 })
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(tmpConfigPath, 0o600)
      } catch {}
    }
    configArg = tmpConfigPath
  }

  const argv = ['oauth', op, '--config', configArg]
  if (force) argv.push('--force')
  if (attemptGuard) argv.push('--attempt-guard')

  const stdin =
    op === 'count-tokens'
      ? JSON.stringify({ body: body || {}, headers: headers || {} })
      : op === 'reset-redeem'
        ? JSON.stringify(body || {})
        : ''

  // Only the unique panel refresher emits oauth_attempt events when an upstream POST runs.
  let telemetry = Promise.resolve()
  let telemetryError = null
  const attempts = new Map()
  const onStdoutLine = (line) => {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      return
    }
    if (
      event?.type !== 'oauth_attempt' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.attempt_id)
    )
      return
    const prior = attempts.get(event.attempt_id)
    if (event.phase === 'start') {
      if (prior || attempts.size >= 64) return
      attempts.set(event.attempt_id, 'start')
    } else if (event.phase === 'success' || event.phase === 'failure') {
      if (prior !== 'start') return
      attempts.set(event.attempt_id, event.phase)
    } else return
    const notification = {
      event_id: cryptoRandomUUID(),
      kind: 'oauth',
      attempt_id: event.attempt_id,
      operation: 'refresh',
      phase: event.phase,
      ...(event.phase === 'failure'
        ? { error_code: /^[a-z][a-z0-9_]{0,63}$/.test(event.error_code) ? event.error_code : 'refresh_failed' }
        : {}),
    }
    telemetry = telemetry.then(async () => {
      try {
        const recorded = await postTelemetry(exec, notification, { timeoutMs: 20000 })
        if (!recorded?.ok) telemetryError = 'oauth_telemetry_unavailable'
      } catch {
        telemetryError = 'oauth_telemetry_unavailable'
      }
    })
  }

  let result
  try {
    result = await runner(argv, { bin, stdin, timeoutMs, onStdoutLine, panelConfig })
  } catch (error) {
    result = { execError: String(error?.message || error).slice(0, 300) }
  } finally {
    if (tmpConfigPath) {
      try {
        fs.rmSync(tmpConfigPath, { force: true })
      } catch {}
    }
  }

  for (const [attempt_id, phase] of attempts) {
    if (phase === 'start')
      onStdoutLine(
        JSON.stringify({
          type: 'oauth_attempt',
          attempt_id,
          phase: 'failure',
          // Started but never reported back: the worker may or may not have sent the token.
          error_code: 'refresh_outcome_unknown',
        }),
      )
  }
  await telemetry
  const failed = (code, message) => ({
    ...failure(code, message),
    ...(telemetryError ? { telemetry_error: telemetryError } : {}),
  })
  const done = (response) => ({ raw: result, response })
  if (result?.execError) return done(failed('worker_exec_failed', result.execError))
  if (result?.timed_out) return done(failed('worker_timeout'))
  if (result?.output_limit) return done(failed('worker_output_limit'))
  if (attemptGuard && isInvalidArguments(result)) return done(failed('invalid_arguments'))

  const payload = lastJsonLine(result?.stdout)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return done(failed('worker_output_invalid', String(result?.stderr || '').slice(0, 300)))
  }

  const status = Number.isInteger(payload.status) ? payload.status : Number(payload.status) || 0
  const response = {
    ok: !!payload.ok,
    status,
    body: payload.body && typeof payload.body === 'object' ? payload.body : {},
    headers: payload.headers && typeof payload.headers === 'object' ? payload.headers : {},
    via: 'panel-worker',
  }

  // Panel is the sole writer: after a successful refresh, re-seal the panel file (0444 +
  // relative symlink), mirror metadata to vm.json, and one-way project down to the slot.
  if (op === 'refresh' && response.ok && exec?.homeDir) {
    try {
      sealWorkerCredentialFile(exec.homeDir)
      if (vmId && slotDir) {
        const vmPath = path.join(path.dirname(slotDir), `${vmId}.json`)
        if (fs.existsSync(vmPath)) {
          const mirrored = mirrorWorkerCredentialsToVm(vmPath, exec.homeDir)
          if (mirrored && exec.vm && typeof exec.vm === 'object') exec.vm.claude = mirrored.claude
        }
      }
      if (slotDir) {
        await projectRefreshedCredential(host, vm, slotDir)
      }
    } catch (error) {
      return done(failed('credential_sync_failed', String(error?.message || error).slice(0, 300)))
    }
  }

  if (telemetryError) response.telemetry_error = telemetryError
  if (status === 0) response.transportError = true
  return done(response)
}
