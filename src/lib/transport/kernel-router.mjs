/**
 * Request-level inference hop router.
 * 公开仓只走 rust cli-hop（kernel → Claude Code）。Go HTTP 转发不再启用。
 * Credential import/ensure 仍可走 Go 客户端，但不参与推理 hop。
 */
import { clientCancelledResult, ErrorCode, isClientCancelledResult } from '../core/errors.mjs'
import { ensureWorkerCredential, repairLocalCredentialLink, slotOAuthUnavailable } from './go-worker-client.mjs'
import { credentialModeOfVm, CREDENTIAL_OAUTH } from '../oauth/credential-mode.mjs'
import { hasCredentialPresence, readWorkerCredentialFile } from '../oauth/oauth-credentials.mjs'
import { isCrsMock } from './crs-mock.mjs'
import { slotHost } from '../vm/slot-host.mjs'
import { vmNodeDataPath } from '../cluster/placement.mjs'
import { GATE_DIAL_TIMEOUT_MS } from '../cluster/direct-link.mjs'
import path from 'node:path'
import { checkCragLicense, cragLicenseDeniedResult } from '../vm/crag-license.mjs'
import { resolveKernelDataplane } from '../vm/slot-engine.mjs'
import {
  streamRustKernel,
  callRustKernel,
  checkRustInferenceAdmission,
  rustKernelHealth,
  rustKernelReachable,
  rustKernelBusy,
  gatewayPolicyReady,
  supportsGatewayPolicy,
  isNeedsRefreshResult,
  kernelFaults,
} from './rust-kernel-client.mjs'
import {
  kernelBinPath,
  awaitWrapRecycle,
  noteWrapHop,
  beginWrapHop,
  endWrapHop,
  wrapHopInflight,
} from './rust-kernel-supervisor.mjs'

const rustHealthCache = new Map()
const DEFAULT_SLOT_WAIT_MS = 30_000
const DEFAULT_SLOT_POLL_MS = 200
const CLUSTER_RECONNECTING = {
  ok: false,
  reason: ErrorCode.CLUSTER_SLOT_RECONNECTING,
  error: 'The session VM is temporarily unreachable',
}

export function rustHealthTtlMs(routing = {}) {
  const raw = routing?.inference?.health_ttl_ms
  if (raw == null || raw === '') return 2000
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return 2000
  return n
}

export function rustHealthTimeoutMs(routing = {}) {
  const n = Number(routing?.inference?.health_timeout_ms)
  // SSH relays can exceed the local-socket budget without the kernel being down.
  if (!Number.isFinite(n) || n <= 0) return 800
  return Math.min(30_000, Math.max(800, Math.round(n)))
}

/** How long a local slot whose kernel looks down is re-probed before the request fails (0 = off). */
export const RUST_DOWN_REPROBE_MS = 2500
const RUST_DOWN_REPROBE_GAP_MS = 250
export function rustDownReprobeMs(routing = {}) {
  const raw = routing?.inference?.kernel_down_reprobe_ms
  if (raw == null || raw === '') return RUST_DOWN_REPROBE_MS
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return RUST_DOWN_REPROBE_MS
  return Math.min(10_000, Math.round(n))
}

export function rustSlotWaitMs(routing = {}) {
  const raw = routing?.inference?.slot_wait_ms
  if (raw == null || raw === '') return DEFAULT_SLOT_WAIT_MS
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SLOT_WAIT_MS
  return n
}

/** Hop slot poll uses leftover wait-plan budget; never stacks a second independent 30s. */
export function resolveHopSlotWaitMs({ remainingBudgetMs, routing } = {}) {
  const configuredRaw = routing?.inference?.slot_wait_ms
  const hasConfigured = configuredRaw != null && configuredRaw !== ''
  const configured = hasConfigured ? rustSlotWaitMs(routing) : null
  const budget = Number(remainingBudgetMs)
  const hasBudget = remainingBudgetMs != null && remainingBudgetMs !== '' && Number.isFinite(budget)
  if (hasBudget) {
    if (budget <= 0) return 0
    if (configured != null) return Math.min(budget, configured)
    return budget
  }
  return rustSlotWaitMs(routing)
}

export function rustShouldWaitForSlot(health, inflight = 0) {
  return rustKernelBusy(health) || Number(inflight) > 0
}

function rustHopReady(health) {
  // Native admission can resume a continuation or queue even with no free slot.
  if (supportsGatewayPolicy(health)) return gatewayPolicyReady(health)
  return rustKernelReachable(health)
}

function hopSlotWaitDeadline({ slotWaitDeadlineMs, slotWaitMs } = {}) {
  if (Number.isFinite(slotWaitDeadlineMs)) return slotWaitDeadlineMs
  return Date.now() + (Number.isFinite(slotWaitMs) ? Math.max(0, slotWaitMs) : 0)
}

export async function waitForReadySlot(
  exec,
  timeoutMs = DEFAULT_SLOT_WAIT_MS,
  pollMs = DEFAULT_SLOT_POLL_MS,
  initialHealth = null,
) {
  const parsed = Number(timeoutMs)
  const waitMs = Number.isFinite(parsed) ? Math.max(0, parsed) : DEFAULT_SLOT_WAIT_MS
  const deadline = Date.now() + waitMs
  const gap = Math.max(40, Number(pollMs) || DEFAULT_SLOT_POLL_MS)
  let last = initialHealth || (await rustKernelHealth(exec, { timeoutMs: 400 }))
  if (rustHopReady(last)) return { ok: true, reason: 'already_up', health: last }
  for (let remaining = deadline - Date.now(); remaining > 0; remaining = deadline - Date.now()) {
    await new Promise((resolve) => setTimeout(resolve, initialHealth ? Math.min(gap, remaining) : gap))
    const probeBudget = deadline - Date.now()
    if (initialHealth && probeBudget <= 0) break
    last = await rustKernelHealth(exec, { timeoutMs: initialHealth ? Math.min(400, probeBudget) : 400 })
    if (rustHopReady(last)) return { ok: true, reason: 'slot_ready', health: last }
  }
  return { ok: false, reason: 'slot_busy', health: last, error: 'rust kernel has no free slot' }
}

export function clearRustHealthCache(vmId = null) {
  if (vmId) rustHealthCache.delete(String(vmId))
  else rustHealthCache.clear()
}

function cacheKey(exec) {
  return String(exec?.vmId || exec?.vm?.id || '')
}

export function rememberRustHealth(exec, ready) {
  const key = cacheKey(exec)
  if (!key || !ready?.ok) return
  rustHealthCache.set(key, { at: Date.now(), health: ready.health || null, dataPath: vmNodeDataPath(exec?.vm) })
}

export function peekRustHealth(exec, ttlMs, now = Date.now()) {
  if (ttlMs <= 0) return null
  const key = cacheKey(exec)
  if (!key) return null
  const hit = rustHealthCache.get(key)
  if (!hit || hit.dataPath !== vmNodeDataPath(exec?.vm)) return null
  if (now - hit.at > ttlMs) return null
  return hit
}

export function resolveHopEngine(vm, _routing = {}, { rustReady = null, binPath = null } = {}) {
  const wanted = 'rust'
  // A baked slot image carries its own kernel; the host binary only matters for local mounts.
  const bin = slotHost(vm).bakedKernel ? 'image' : binPath != null ? String(binPath).trim() : kernelBinPath()
  if (rustReady === true) {
    return { engine: 'rust', wanted, reason: 'configured_rust', fallback: false }
  }
  if (rustReady === false || !bin) {
    return {
      engine: 'rust',
      wanted,
      reason: rustReady === false ? 'rust_unhealthy' : 'bin_missing',
      fallback: false,
      blocked: true,
    }
  }
  return { engine: 'rust', wanted, reason: 'configured_rust', fallback: false }
}

function rustUnavailableResult(ready) {
  const reconnecting = ready?.reason === ErrorCode.CLUSTER_SLOT_RECONNECTING
  const rejected = reconnecting || ready?.reason === 'slot_busy' || ready?.reason === 'kernel_unavailable'
  return {
    ok: false,
    status: rejected ? 503 : 0,
    via: 'rust-kernel',
    engine: 'rust',
    body: {
      type: 'error',
      error: {
        type: 'worker_error',
        code: ready?.reason || 'rust_unavailable',
        message: ready?.error || 'rust kernel is not available',
      },
    },
    headers: {},
    ...(rejected ? { upstreamExecutions: 0 } : {}),
    ...(reconnecting ? { retryAfterSec: 1 } : {}),
    terminalState: rejected ? 'rejected' : 'transport_error',
    transportError: !rejected,
  }
}

function credentialEnsureFailure(result, ensured) {
  const rawError = ensured?.error
  const error = rawError && typeof rawError === 'object' ? rawError : {}
  const blob = `${error.code || ''} ${error.message || ''} ${typeof rawError === 'string' ? rawError : ''}`
  const fatal = /invalid_grant|oauth_revoked|token has been revoked|refresh_token_missing/i.test(blob)
  const revoked = /token has been revoked|oauth_revoked/i.test(blob)
  return {
    ...result,
    ok: false,
    status: fatal ? 401 : Number(ensured?.status) || result.status,
    committed: fatal ? false : result.committed,
    terminalState: fatal ? 'rejected' : result.terminalState,
    body: {
      type: 'error',
      error: {
        type: fatal ? 'authentication_error' : error.type || 'worker_error',
        code: fatal
          ? revoked
            ? 'oauth_revoked'
            : error.code || 'invalid_grant'
          : error.code || 'credential_refresh_failed',
        message: fatal
          ? revoked
            ? 'OAuth access token has been revoked'
            : 'OAuth credential was rejected'
          : String(error.message || rawError || 'credential ensure failed').slice(0, 300),
      },
    },
    credential_ensure_failed: true,
  }
}

async function prepareRust(exec, { ensure, routing, slotWaitMs, slotWaitDeadlineMs } = {}) {
  await awaitWrapRecycle(exec)
  const fault = kernelFaults.get(cacheKey(exec))
  if (fault) return { ok: false, reason: 'kernel_unavailable', error: fault }
  if (typeof ensure === 'function') return ensure(exec)
  const dataPath = vmNodeDataPath(exec?.vm)
  if (dataPath === 'offline') {
    clearRustHealthCache(cacheKey(exec))
    return CLUSTER_RECONNECTING
  }
  if (exec?.homeDir && slotHost(exec.vm).kind === 'local' && !isCrsMock()) {
    const expectsOAuth =
      credentialModeOfVm(exec.vm) === CREDENTIAL_OAUTH && hasCredentialPresence(exec.vm?.claude || {})
    try {
      const link = await repairLocalCredentialLink(exec.homeDir)
      if (expectsOAuth && (!link.linked || !hasCredentialPresence(readWorkerCredentialFile(exec.homeDir) || {}))) {
        return { ok: false, reason: ErrorCode.SLOT_OAUTH_UNAVAILABLE }
      }
    } catch (error) {
      if (!expectsOAuth) throw error
      return { ok: false, reason: ErrorCode.SLOT_OAUTH_UNAVAILABLE }
    }
  }
  const ttl = rustHealthTtlMs(routing)
  const cached = peekRustHealth(exec, ttl)
  if (cached && rustHopReady(cached.health)) {
    return { ok: true, reason: 'health_cache', health: cached.health }
  }
  const health = await rustKernelHealth(exec, {
    timeoutMs:
      dataPath !== 'local' ? GATE_DIAL_TIMEOUT_MS + rustHealthTimeoutMs(routing) : rustHealthTimeoutMs(routing),
  })
  if (
    dataPath !== 'local' &&
    (vmNodeDataPath(exec?.vm) === 'offline' || (health?.ok !== true && health?.status === 0))
  ) {
    clearRustHealthCache(cacheKey(exec))
    return CLUSTER_RECONNECTING
  }
  if (rustHopReady(health)) {
    const ready = { ok: true, reason: 'already_up', health }
    if (dataPath === vmNodeDataPath(exec?.vm)) rememberRustHealth(exec, ready)
    return ready
  }
  // The kernel spent its own CLI restarts, or the watchdog spent its container
  // restarts. Only the watchdog restarts it, bounded; a request must not.
  if (health?.healthy === false) {
    return {
      ok: false,
      reason: 'kernel_unavailable',
      error: health?.unhealthy_reason || 'rust kernel unhealthy',
    }
  }
  const waitForSlotFrom = async (seen) => {
    const managed = supportsGatewayPolicy(seen)
    const remainingBudgetMs =
      managed && Number.isFinite(slotWaitDeadlineMs) ? Math.max(0, slotWaitDeadlineMs - Date.now()) : slotWaitMs
    const waited = await waitForReadySlot(
      exec,
      resolveHopSlotWaitMs({ remainingBudgetMs, routing }),
      DEFAULT_SLOT_POLL_MS,
      managed ? seen : null,
    )
    if (vmNodeDataPath(exec?.vm) === 'offline') return CLUSTER_RECONNECTING
    if (waited?.ok && dataPath === vmNodeDataPath(exec?.vm)) rememberRustHealth(exec, waited)
    return waited
  }
  if (rustShouldWaitForSlot(health, wrapHopInflight(exec))) return waitForSlotFrom(health)
  // A single health probe that is neither ready nor busy (no request in flight,
  // not unhealthy) is often a kernel that is still settling after the slot's
  // previous request; the next probe a moment later is ready. On a local slot,
  // re-probe briefly instead of failing the request at once, and log what the
  // kernel reported when it really stays down.
  let last = health
  if (dataPath === 'local') {
    // Same budget rule as the slot wait above: a managed (gateway-policy) kernel
    // honours the request's slot deadline, the others the remaining slot wait.
    const planBudget =
      supportsGatewayPolicy(health) && Number.isFinite(slotWaitDeadlineMs)
        ? Math.max(0, slotWaitDeadlineMs - Date.now())
        : Number.isFinite(slotWaitMs)
          ? Math.max(0, slotWaitMs)
          : Infinity
    const deadline = Date.now() + Math.min(rustDownReprobeMs(routing), planBudget)
    let probes = 0
    let pathChanged = false
    while (Date.now() + RUST_DOWN_REPROBE_GAP_MS < deadline) {
      await new Promise((resolve) => setTimeout(resolve, RUST_DOWN_REPROBE_GAP_MS))
      // Bound each probe by what is left of the window rather than by the full
      // health timeout. The loop condition only reserves the gap, while
      // `rustHealthTimeoutMs` has a floor of 800ms and a ceiling of 30s, so an
      // unbounded probe overruns both `kernel_down_reprobe_ms` and the request's
      // own slot budget by up to a whole timeout -- the very budget computed
      // above. Clipping it cannot manufacture a failure: `workerHealth` reports a
      // timeout as `{ ok: false, status: 0 }` with no `healthy: false`, so a
      // clipped probe reads as not-ready and leaves the verdict below unchanged.
      last = await rustKernelHealth(exec, {
        timeoutMs: Math.max(1, Math.min(rustHealthTimeoutMs(routing), deadline - Date.now())),
      })
      probes++
      const pathNow = vmNodeDataPath(exec?.vm)
      if (pathNow !== dataPath) {
        // The slot left the local data path while it was being re-probed. An
        // offline slot gets the same answer as everywhere else in prepareRust
        // (and waitForSlotFrom): reconnecting, not a kernel that is down. Any
        // other move ends the re-probe without the down-kernel log, because the
        // kernel was never seen to stay down on the path it started on.
        if (pathNow === 'offline') {
          clearRustHealthCache(cacheKey(exec))
          return CLUSTER_RECONNECTING
        }
        pathChanged = true
        break
      }
      if (rustHopReady(last)) {
        const ready = { ok: true, reason: 'ready_after_reprobe', health: last }
        rememberRustHealth(exec, ready)
        return ready
      }
      if (last?.healthy === false) {
        return { ok: false, reason: 'kernel_unavailable', error: last?.unhealthy_reason || 'rust kernel unhealthy' }
      }
      if (rustShouldWaitForSlot(last, wrapHopInflight(exec))) return waitForSlotFrom(last)
    }
    // Only a re-probe that actually ran and saw the kernel stay down is worth a
    // line: with kernel_down_reprobe_ms = 0 (or a window too small for one
    // probe) this path behaves exactly as it did before the re-probe existed.
    if (probes > 0 && !pathChanged)
      console.warn(
        '[kernel] ' +
          JSON.stringify({
            event: 'rust_kernel_down',
            vm: cacheKey(exec),
            probes,
            first: healthSnapshot(health),
            last: healthSnapshot(last),
          }),
      )
  }
  clearRustHealthCache(cacheKey(exec))
  return { ok: false, reason: 'kernel_unavailable', error: 'rust kernel is down; watchdog recovery pending' }
}

const HEALTH_SNAPSHOT_KEYS = [
  'ok',
  'status',
  'code',
  'error',
  'healthy',
  'ready',
  'ready_slots',
  'closed_slots',
  'active',
  'waiting',
  'queued',
  'recovering',
  'cleaning',
  'cli_pid',
  'unhealthy_reason',
  'runtime_variant',
]
function healthSnapshot(health) {
  if (!health || typeof health !== 'object') return null
  const out = {}
  for (const key of HEALTH_SNAPSHOT_KEYS) {
    if (health[key] !== undefined) out[key] = typeof health[key] === 'string' ? health[key].slice(0, 160) : health[key]
  }
  return out
}

// Resolve before shaping the attempt; the same worker report gates serialization.
export async function prepareInferenceHop({
  exec,
  routing = {},
  slotWaitMs,
  slotWaitDeadlineMs,
  ensureRust,
  admitCragInference,
} = {}) {
  const deadline = hopSlotWaitDeadline({ slotWaitDeadlineMs, slotWaitMs })
  if (resolveKernelDataplane(exec?.vm, routing) === 'crag') {
    const rejection = await admitCragInference?.({ vm: exec?.vm, routing, slotWaitDeadlineMs: deadline })
    if (rejection) return { rejection }
  }
  const projectRoot = exec?.projectRoot || (exec?.homeDir ? path.resolve(exec.homeDir, '../../..') : '')
  const licensed = checkCragLicense(projectRoot, exec?.vm, routing)
  if (!licensed.ok) return { rejection: cragLicenseDeniedResult(licensed) }
  const decision = resolveHopEngine(exec?.vm, routing)
  if (decision.blocked) return { decision }
  const ready = await prepareRust(exec, { ensure: ensureRust, routing, slotWaitMs, slotWaitDeadlineMs: deadline })
  if (ready?.reason === ErrorCode.SLOT_OAUTH_UNAVAILABLE) {
    return { rejection: slotOAuthUnavailable({ committed: false, upstreamExecutions: 0 }) }
  }
  return { decision, ready, slotWaitDeadlineMs: deadline }
}

async function runHop({ mode, opts }) {
  const prepared = opts.preparedHop || (await prepareInferenceHop(opts))
  const { rejection, decision, ready } = prepared
  if (rejection) return rejection
  if (ready?.ok && vmNodeDataPath(opts.exec?.vm) === 'offline') return rustUnavailableResult(CLUSTER_RECONNECTING)
  const engine = 'rust'
  let reason = decision.reason
  if (!decision.blocked) {
    if (ready?.ok) {
      if (opts.requestContext && opts.cliHop && ready.health?.classifier_request_context !== true) {
        return {
          ok: false,
          status: 400,
          terminalState: 'rejected',
          upstreamExecutions: 0,
          body: {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              code: 'classifier_runtime_unsupported',
              message: 'The kernel/CLI runtime does not support classifier request context.',
            },
          },
        }
      }
      reason = ready.reason || 'configured_rust'
    } else {
      return {
        ...rustUnavailableResult(ready),
        wanted_engine: 'rust',
        engine_reason: ready?.reason || 'rust_unavailable',
      }
    }
  } else {
    return {
      ...rustUnavailableResult({ reason: decision.reason }),
      wanted_engine: 'rust',
      engine_reason: decision.reason,
    }
  }
  const send = mode === 'stream' ? streamRustKernel : callRustKernel
  // The worker that passed readiness may not match the scheduler's snapshot.
  const managedCrag =
    gatewayPolicyReady(ready.health) && (opts.requestPath ?? '/internal/v1/messages') === '/internal/v1/messages'
  const sendOpts = {
    ...opts,
    exec: { ...opts.exec, workerStatus: ready.health },
    managedCrag,
    slotWaitDeadlineMs: prepared.slotWaitDeadlineMs ?? hopSlotWaitDeadline(opts),
  }
  beginWrapHop(opts.exec)
  let result
  try {
    result = await send(sendOpts)
    noteWrapHop(opts.exec)
    if (opts.signal?.aborted || isClientCancelledResult(result)) {
      result = clientCancelledResult(result)
    } else if (
      result.transportError === true &&
      result.clusterDeliveryUnconfirmed !== true &&
      result.committed !== true &&
      !(managedCrag && result.body?.error?.code === 'worker_timeout')
    ) {
      result = await send(sendOpts)
      result = { ...result, rust_transport_retried: true }
      noteWrapHop(opts.exec)
    }
    if (
      !opts.signal?.aborted &&
      !isClientCancelledResult(result) &&
      result.clusterDeliveryUnconfirmed !== true &&
      isNeedsRefreshResult(result)
    ) {
      const rejection = await checkRustInferenceAdmission(sendOpts)
      if (rejection) result = rejection
      else if (!opts.signal?.aborted) {
        const ensure = opts.ensureCredential || ensureWorkerCredential
        const ensured = await ensure(opts.exec, { force: true })
        if (ensured?.ok !== true) result = credentialEnsureFailure(result, ensured)
        else if (!opts.signal?.aborted) {
          // The CLI invalidates its OAuth cache from the shared credential file
          // before creating each API client. Recycling here kills sibling hops.
          result = await send(sendOpts)
          result = { ...result, credential_retried: true }
          noteWrapHop(opts.exec)
        }
      }
    }
    if (opts.signal?.aborted) result = clientCancelledResult(result)
    if (result.clusterDeliveryUnconfirmed === true && !isClientCancelledResult(result)) {
      result = {
        ...result,
        ok: false,
        status: 502,
        terminalState: 'incomplete',
        body: {
          type: 'error',
          error: {
            type: 'api_error',
            code: ErrorCode.CLUSTER_DELIVERY_UNCONFIRMED,
            message:
              'The cluster connection closed before the request result could be confirmed; the request was not replayed.',
          },
        },
      }
    }
    return {
      ...result,
      engine,
      wanted_engine: decision.wanted,
      engine_reason: reason,
    }
  } finally {
    endWrapHop(opts.exec)
    // Inference failures only invalidate health. The watchdog owns container
    // recovery, so concurrent requests cannot bypass its restart budget.
    if (
      result?.transportError ||
      result?.clusterDeliveryUnconfirmed ||
      result?.body?.error?.code === 'kernel_unavailable'
    ) {
      clearRustHealthCache(cacheKey(opts.exec))
    }
  }
}

export function dispatchStreamInference(opts = {}) {
  return runHop({ mode: 'stream', opts })
}

export function dispatchCallInference(opts = {}) {
  return runHop({ mode: 'call', opts })
}
