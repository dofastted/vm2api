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
import { cragV2KernelActive } from '../protocol/crag-print-prompt.mjs'
import { checkCragLicense, cragLicenseDeniedResult } from '../vm/crag-license.mjs'
import { resolveKernelDataplane } from '../vm/slot-engine.mjs'

function licenseCheck(opts, liveCrag = cragV2KernelActive({ health: opts.exec?.workerStatus })) {
  const root = opts.exec?.projectRoot || (opts.exec?.homeDir ? path.resolve(opts.exec.homeDir, '../../..') : '')
  // A live CRAG process remains licensed per slot even if the saved selection is stale.
  const vm = liveCrag ? { ...opts.exec?.vm, dataplane: 'crag', crag_kernel_version: 'v2' } : opts.exec?.vm
  const licensed = checkCragLicense(root, vm, opts.routing)
  return licensed.ok ? null : cragLicenseDeniedResult(licensed)
}

export async function checkRustInferenceAdmission(opts) {
  const { vm, workerStatus: health } = opts.exec || {}
  const liveCrag = cragV2KernelActive({ health })
  if (liveCrag || resolveKernelDataplane(vm, opts.routing) === 'crag') {
    const rejection = await opts.admitCragInference?.({ vm, routing: opts.routing, health })
    if (rejection) return rejection
    return licenseCheck(opts, liveCrag)
  }
  return null
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

async function sendRustInference(send, opts) {
  const { admitCragInference, ...sendOpts } = opts
  if (!admitCragInference) {
    const rejection = licenseCheck(opts)
    if (rejection) return rejection
  }
  return remapVia(
    await send({
      ...sendOpts,
      exec: withRustKernelExec(opts.exec),
      beforeInferencePost: admitCragInference ? () => checkRustInferenceAdmission(opts) : undefined,
    }),
  )
}

export function callRustKernel(opts = {}) {
  return sendRustInference(callGoWorker, opts)
}

export function streamRustKernel(opts = {}) {
  return sendRustInference(streamGoWorker, opts)
}

export async function postRustKernelTelemetryEvent(exec, event, options = {}) {
  return remapVia(await callWorkerPost(withRustKernelExec(exec), '/internal/v1/telemetry/events', event, options))
}

export function supportsCragTelemetryApply(health) {
  return health?.ok === true && health.crag_telemetry_apply_v1 === true && cragV2KernelActive({ health })
}

const CRAG_TELEMETRY_ERRORS = {
  telemetry_policy_not_published: 'CRAG 未读到已发布的槽内设置',
  telemetry_native_settings_blocked: 'Claude Code 槽内设置或 OS 特征阻止开启遥测',
  telemetry_restart_required: '槽内设置已发布；需排空并重启 CRAG 内核',
}

export async function verifyCragTelemetryPolicy(exec, enabled, timeoutMs) {
  const { status, body } = await callWorkerPost(
    withRustKernelExec(exec),
    '/internal/v1/telemetry/apply',
    { enabled },
    { timeoutMs, requireInternalToken: true },
  )
  if (
    status === 200 &&
    body?.ok === true &&
    body.applied === true &&
    body.enabled === enabled &&
    body.scope === 'native_claude_launch' &&
    body.upload_confirmed === false
  ) {
    return { ok: true, applied: true, action: 'applied', enabled, scope: body.scope, upload_confirmed: false }
  }
  const code = body?.error?.type
  if (status === 409 && Object.hasOwn(CRAG_TELEMETRY_ERRORS, code)) {
    return { ok: false, code, error: CRAG_TELEMETRY_ERRORS[code] }
  }
  return { ok: false, code: 'telemetry_observation_unavailable', error: 'CRAG 未确认原生遥测启动策略' }
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

export function supportsGatewayPolicy(health) {
  return health?.gateway_policy_v1 === true && cragV2KernelActive({ health })
}

export function gatewayPolicyReady(health) {
  return (
    supportsGatewayPolicy(health) &&
    health.ok === true &&
    (health.status == null || health.status === 200) &&
    health.healthy !== false &&
    health.ready !== false &&
    health.recovering !== true
  )
}

export function rustKernelProcessUp(health) {
  if (!health) return false
  if (health.ok) return true
  if (Number(health.status) === 200) return true
  if (health.engine === 'rust' || health.worker_version) return true
  return false
}

export function rustKernelCliReady(health) {
  if (health?.ready === false || health?.license_valid === false) return false
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
  if (health?.healthy === false || health?.license_valid === false) return false
  if (health?.recovering === true) return true
  if (rustKernelCliReady(health)) return false
  if (cragV2KernelActive({ health })) {
    return (
      Number(health.active) > 0 || Number(health.waiting) > 0 || Number(health.queued) > 0 || health.pids?.length > 0
    )
  }
  const pid = finiteNumber(health?.cli_pid)
  return pid != null && pid > 0
}

export function rustKernelReachable(health) {
  return (
    rustKernelProcessUp(health) &&
    health?.healthy !== false &&
    health?.recovering !== true &&
    rustKernelCliReady(health)
  )
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
