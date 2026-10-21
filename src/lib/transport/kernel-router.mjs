/**
 * Request-level inference hop router.
 * 公开仓只走 rust cli-hop（kernel → Claude Code）。Go HTTP 转发不再启用。
 * Credential import/ensure 仍可走 Go 客户端，但不参与推理 hop。
 */
import { clientCancelledResult, isClientCancelledResult } from '../core/errors.mjs'
import { randomUUID } from 'node:crypto'
import { ensureWorkerCredential } from './go-worker-client.mjs'
import { ensureOfficialCredentialLink, slotUidGidFromHomeDir } from '../oauth/oauth-credentials.mjs'
import { slotHost } from '../vm/slot-host.mjs'
import { isKubernetesHaMode } from '../core/control-plane-mode.mjs'
import {
  streamRustKernel,
  callRustKernel,
  rustKernelHealth,
  rustKernelReachable,
  rustKernelBusy,
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

export function rustHealthTtlMs(routing = {}) {
  const raw = routing?.inference?.health_ttl_ms
  if (raw == null || raw === '') return 2000
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return 2000
  return n
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

export async function waitForReadySlot(exec, timeoutMs = DEFAULT_SLOT_WAIT_MS, pollMs = DEFAULT_SLOT_POLL_MS) {
  const parsed = Number(timeoutMs)
  const waitMs = Number.isFinite(parsed) ? Math.max(0, parsed) : DEFAULT_SLOT_WAIT_MS
  const deadline = Date.now() + waitMs
  const gap = Math.max(40, Number(pollMs) || DEFAULT_SLOT_POLL_MS)
  let last = await rustKernelHealth(exec, { timeoutMs: 400 })
  if (rustKernelReachable(last)) return { ok: true, reason: 'already_up', health: last }
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, gap))
    last = await rustKernelHealth(exec, { timeoutMs: 400 })
    if (rustKernelReachable(last)) return { ok: true, reason: 'slot_ready', health: last }
  }
  return { ok: false, reason: 'slot_busy', health: last, error: 'rust kernel has no free slot' }
}

export function clearRustHealthCache(vmId = null) {
  if (vmId) {
    for (const key of rustHealthCache.keys())
      if (key === String(vmId) || key.startsWith(`${vmId}:`)) rustHealthCache.delete(key)
  } else rustHealthCache.clear()
}

function cacheKey(exec) {
  const id = String(exec?.vmId || exec?.vm?.id || '')
  return exec?.slotgate ? `${id}:${JSON.stringify(exec.slotgate.fence)}:${JSON.stringify(exec.slotgate.manifest)}` : id
}

export function rememberRustHealth(exec, ready) {
  const key = cacheKey(exec)
  if (!key || !ready?.ok) return
  rustHealthCache.set(key, { at: Date.now(), health: ready.health || null })
}

export function peekRustHealth(exec, ttlMs, now = Date.now()) {
  if (ttlMs <= 0) return null
  const key = cacheKey(exec)
  if (!key) return null
  const hit = rustHealthCache.get(key)
  if (!hit) return null
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
  // Both mean "try another VM": the kernel answered and said so.
  const answered = ready?.reason === 'slot_busy' || ready?.reason === 'kernel_unavailable'
  return {
    ok: false,
    status: answered ? 503 : 0,
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
    terminalState: answered ? 'rejected' : 'transport_error',
    transportError: !answered,
    execution: { requestId: null, started: false, ended: true, reason: 'not_started' },
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
    ...(ensured?.credentialRefreshUnknown ? { executionUncertain: true } : {}),
    ...(ensured?.credentialRefreshNotStarted === true ? { credentialRefreshNotStarted: true } : {}),
  }
}

async function prepareSlotCredentials(exec) {
  if (!exec?.homeDir) return
  const ids = slotUidGidFromHomeDir(exec.homeDir)
  ensureOfficialCredentialLink(exec.homeDir, ids || {})
}

async function prepareRust(exec, { ensure, routing, slotWaitMs } = {}) {
  if (exec?.slotgate != null) {
    const health = await rustKernelHealth(exec, { timeoutMs: 800 })
    // The node validates the captured fence and manifest. Never use the local
    // credential, host binary/recycler or an injected legacy ensure callback.
    return rustKernelReachable(health)
      ? { ok: true, reason: 'node_health', health }
      : { ok: false, reason: 'kernel_unavailable', health, error: health?.code || 'node health unavailable' }
  }
  if (isKubernetesHaMode())
    throw Object.assign(new Error('trusted node capability required'), { code: 'slotgate_capability_required' })
  await awaitWrapRecycle(exec)
  const fault = kernelFaults.get(cacheKey(exec))
  if (fault) return { ok: false, reason: 'kernel_unavailable', error: fault }
  if (typeof ensure === 'function') return ensure(exec)
  await prepareSlotCredentials(exec)
  const ttl = rustHealthTtlMs(routing)
  const cached = peekRustHealth(exec, ttl)
  if (cached && rustKernelReachable(cached.health)) {
    return { ok: true, reason: 'health_cache', health: cached.health }
  }
  const health = await rustKernelHealth(exec, { timeoutMs: 800 })
  if (rustKernelReachable(health)) {
    const ready = { ok: true, reason: 'already_up', health }
    rememberRustHealth(exec, ready)
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
  if (rustShouldWaitForSlot(health, wrapHopInflight(exec))) {
    const waited = await waitForReadySlot(exec, resolveHopSlotWaitMs({ remainingBudgetMs: slotWaitMs, routing }))
    if (waited?.ok) {
      rememberRustHealth(exec, waited)
      return waited
    }
    return waited
  }
  clearRustHealthCache(cacheKey(exec))
  return { ok: false, reason: 'kernel_unavailable', error: 'rust kernel is down; watchdog recovery pending' }
}

async function runHop({ mode, opts }) {
  if (isKubernetesHaMode() && opts.exec?.slotgate == null)
    throw Object.assign(new Error('trusted node capability required'), { code: 'slotgate_capability_required' })
  const routing = opts.routing || {}
  const decision =
    opts.exec?.slotgate != null
      ? { engine: 'rust', wanted: 'rust', reason: 'node_capability', fallback: false }
      : resolveHopEngine(opts.exec?.vm, routing)
  let engine = 'rust'
  let reason = decision.reason
  if (!decision.blocked) {
    const ready = await prepareRust(opts.exec, {
      ensure: opts.ensureRust,
      routing,
      slotWaitMs: opts.slotWaitMs,
    })
    if (ready?.ok) {
      if (opts.requestContext && opts.cliHop && ready.health?.classifier_request_context !== true) {
        return {
          ok: false,
          status: 400,
          terminalState: 'rejected',
          upstreamExecutions: 0,
          execution: { requestId: null, started: false, ended: true, reason: 'not_started' },
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
  const sharedExecution = typeof opts.onExecutionStart === 'function' || typeof opts.onExecutionEnd === 'function'
  const canRetry = (value) => !sharedExecution || value?.execution?.ended === true
  let hop = 0
  const sendHop = async () => {
    let startError
    let bound = false
    const value = await send({
      ...opts,
      requestId: hop++ === 0 && opts.requestId != null ? opts.requestId : randomUUID(),
      onExecutionStart:
        typeof opts.onExecutionStart === 'function'
          ? async (execution) => {
              try {
                const acknowledgement = await opts.onExecutionStart(execution)
                bound = true
                return acknowledgement
              } catch (error) {
                startError = error
                throw error
              }
            }
          : opts.onExecutionStart,
    })
    // The worker returns transport results for errors, including callback errors.
    // A failed durable start must retain the original exception and cannot retry.
    if (startError) throw startError
    if (typeof opts.onExecutionEnd === 'function' && (typeof opts.onExecutionStart !== 'function' || bound)) {
      await opts.onExecutionEnd(value?.execution)
    }
    return value
  }
  beginWrapHop(opts.exec)
  let result
  try {
    result = await sendHop()
    noteWrapHop(opts.exec)
    if (opts.signal?.aborted || isClientCancelledResult(result)) {
      result = clientCancelledResult(result)
    } else if (result.transportError === true && result.committed !== true && canRetry(result)) {
      result = await sendHop()
      result = { ...result, rust_transport_retried: true }
      noteWrapHop(opts.exec)
    }
    if (!isClientCancelledResult(result) && isNeedsRefreshResult(result) && canRetry(result)) {
      const ensure = opts.ensureCredential || ensureWorkerCredential
      let ensured
      try {
        ensured = await ensure(opts.exec, { force: true })
      } catch (error) {
        if (error.credentialRefreshNotStarted !== true || result.execution?.ended !== true || result.executionUncertain)
          throw error
        ensured = {
          ok: false,
          status: 503,
          credentialRefreshNotStarted: true,
          error: { code: error.code, message: error.message },
        }
      }
      if (ensured?.ok !== true) result = credentialEnsureFailure(result, ensured)
      else {
        // The CLI invalidates its OAuth cache from the shared credential file
        // before creating each API client. Recycling here kills sibling hops.
        result = await sendHop()
        result = { ...result, credential_retried: true }
        noteWrapHop(opts.exec)
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
    if (result?.transportError || result?.body?.error?.code === 'kernel_unavailable') {
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
