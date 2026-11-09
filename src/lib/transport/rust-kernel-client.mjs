/**
 * Rust kin-kernel hop client. Same envelope / Unix-socket contract as
 * go-worker-client; the socket is run/kernel.sock instead of worker.sock.
 */
import path from 'node:path'
import {
  callGoWorker,
  callWorkerPost,
  credentialSummary,
  streamGoWorker,
  workerHealth,
  workerPaths,
} from './go-worker-client.mjs'
import { readWorkerCredentialFile } from '../oauth/oauth-credentials.mjs'
import { checkCragLicense, cragLicenseDeniedResult } from '../vm/crag-license.mjs'

function licenseCheck(opts) {
  const root = opts.exec?.projectRoot || (opts.exec?.homeDir ? path.resolve(opts.exec.homeDir, '../../..') : '')
  return checkCragLicense(root, opts.exec?.vm, opts.routing)
}

export function rustKernelPaths(exec = {}) {
  const base = workerPaths(exec)
  const runDir = base.runDir
  return {
    runDir,
    socketPath: exec.vm?.runtime?.kernel_socket || (runDir ? path.join(runDir, 'kernel.sock') : null),
    tokenPath: base.tokenPath,
    configPath: runDir ? path.join(runDir, 'kernel.json') : null,
  }
}

export function withRustKernelExec(exec) {
  const paths = rustKernelPaths(exec)
  return {
    ...exec,
    vm: {
      ...(exec?.vm || {}),
      runtime: {
        ...(exec?.vm?.runtime || {}),
        worker_socket: paths.socketPath,
        worker_token_file: paths.tokenPath,
        worker_run_dir: paths.runDir,
      },
    },
  }
}

function remapVia(result) {
  if (!result || typeof result !== 'object') return result
  return {
    ...result,
    via: String(result.via || 'go-worker').replace(/go-worker/g, 'rust-kernel'),
  }
}

export async function callRustKernel(opts = {}) {
  const licensed = licenseCheck(opts)
  if (!licensed.ok) return cragLicenseDeniedResult(licensed)
  return remapVia(await callGoWorker({ ...opts, exec: withRustKernelExec(opts.exec) }))
}

export async function streamRustKernel(opts = {}) {
  const licensed = licenseCheck(opts)
  if (!licensed.ok) return cragLicenseDeniedResult(licensed)
  return remapVia(await streamGoWorker({ ...opts, exec: withRustKernelExec(opts.exec) }))
}

export async function postRustKernelTelemetryEvent(exec, event, options = {}) {
  return remapVia(await callWorkerPost(withRustKernelExec(exec), '/internal/v1/telemetry/events', event, options))
}

export function withCragCredential(exec, health) {
  if (!health || health.credential) return health
  const native = health.runtime_variant === 'crag-v2' || (health.dataplane === 'crag' && health.kernel_version === 'v2')
  if (!native) return health
  const file = readWorkerCredentialFile(exec?.homeDir)
  if (!file) return health
  return { ...health, credential: credentialSummary(file) }
}

export async function rustKernelHealth(exec, opts = {}) {
  const health = await workerHealth(withRustKernelExec(exec), opts)
  const reported = health?.source
    ? { ...health, source: String(health.source).replace(/go-worker/g, 'rust-kernel') }
    : health
  return withCragCredential(exec, reported)
}

export function rustKernelProcessUp(health) {
  if (!health) return false
  if (health.ok) return true
  if (Number(health.status) === 200) return true
  if (health.engine === 'rust' || health.worker_version) return true
  return false
}

export function rustKernelCliReady(health) {
  if (health?.ready_slots == null) return true
  const n = Number(health.ready_slots)
  return Number.isFinite(n) && n > 0
}

/**
 * Process is up and CLI is alive; idle slots=0 means busy, not dead.
 * A kernel restarting its own CLI (`recovering`) is busy too: the control
 * plane waits instead of restarting the container under it. A kernel that
 * spent its own restarts (`healthy:false`) is never busy.
 */
export function rustKernelBusy(health) {
  if (!rustKernelProcessUp(health)) return false
  if (health?.healthy === false) return false
  if (health?.recovering === true) return true
  if (rustKernelCliReady(health)) return false
  const pid = finiteNumber(health?.cli_pid)
  return pid != null && pid > 0
}

export function rustKernelReachable(health) {
  return rustKernelProcessUp(health) && health?.healthy !== false && rustKernelCliReady(health)
}

/** Only the container restart (L4) can help: the kernel is gone, gave up on CLI, or all slots are closed. */
export function rustKernelNeedsRestart(health) {
  if (!rustKernelProcessUp(health) || health?.healthy === false) return true
  if (health?.ready_slots === 0 && Number(health?.closed_slots) > 0) return true
  return false
}

/**
 * vmId -> reason, for kernels whose container restarts are spent (L5).
 * The watchdog writes it; scheduling and the hop path skip these VMs.
 */
export const kernelFaults = new Map()

function finiteNumber(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const TELEMETRY_STATES = new Set(['disabled', 'idle', 'waiting_credentials', 'waiting_egress', 'uploading', 'error'])

export function toPublicTelemetryState(value) {
  if (!value || typeof value.enabled !== 'boolean' || !TELEMETRY_STATES.has(value.state)) return null
  const pending = finiteNumber(value.pending_events)
  if (!Number.isInteger(pending) || pending < 0) return null
  return {
    enabled: value.enabled,
    state: value.state,
    pending_events: pending,
    last_upload_at:
      typeof value.last_upload_at === 'string' && Number.isFinite(Date.parse(value.last_upload_at))
        ? value.last_upload_at
        : null,
    last_error:
      typeof value.last_error === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value.last_error) ? value.last_error : null,
  }
}

/**
 * Panel-safe kernel health. Wrap / cli-hop `/internal/health` carries
 * `provider`, `ready_slots`, `cli_pid`; Go hop omits them.
 */
export function toPublicKernelHealth(health, engine) {
  const processUp =
    engine === 'rust'
      ? rustKernelProcessUp(health)
      : health?.ok === true ||
        Number(health?.status) === 200 ||
        health?.worker_version != null ||
        health?.version != null
  const reachable = engine === 'rust' ? rustKernelReachable(health) : processUp
  return {
    reachable,
    process_up: processUp,
    status: health?.status ?? null,
    worker_version: health?.worker_version || health?.version || null,
    engine: health?.engine || engine,
    provider: health?.provider ?? null,
    ready_slots: finiteNumber(health?.ready_slots),
    closed_slots: finiteNumber(health?.closed_slots),
    cli_restarts: finiteNumber(health?.cli_restarts),
    recovering: health?.recovering === true,
    healthy: health?.healthy !== false,
    unhealthy_reason: health?.unhealthy_reason || null,
    cli_pid: finiteNumber(health?.cli_pid),
    vm_telemetry: health?.vm_telemetry === true,
    telemetry_ready: health?.telemetry_ready === true,
    telemetry: toPublicTelemetryState(health?.telemetry),
    error_code: reachable ? null : health?.code || `${engine}_worker_unavailable`,
  }
}

export function isNeedsRefreshResult(result) {
  const status = Number(result?.status) || 0
  const code = String(result?.body?.error?.code || result?.error?.code || '')
  const message = String(result?.body?.error?.message || result?.error?.message || '')
  const hay = `${code} ${message}`
  if (code.startsWith('license_')) return false
  if (code === 'needs_refresh' || /needs_refresh/i.test(hay)) return true
  if (status === 401) return true
  if (/authentication_error|token has been revoked|oauth_revoked|invalid_grant/i.test(hay)) return true
  return false
}
