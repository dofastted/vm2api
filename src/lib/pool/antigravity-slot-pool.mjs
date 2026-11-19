import { isAntigravityVm } from '../vm/vm-kind.mjs'
import { isKvmRuntime } from '../vm/runtime-kind.mjs'
import { vmNodeId } from '../cluster/placement.mjs'
import { proxyBlockedReason } from '../vm/proxy-policy.mjs'
import { slotNetworkForVm } from '../vm/egress.mjs'
import { activeHoursOf, evaluateActiveHours } from './active-hours.mjs'
import { keyAllowsVm } from '../admin/key-scope.mjs'
import { vmMatchesOwnerScope } from '../admin/resource-owner.mjs'
import { normalizeAntigravityRouting, splitAntigravityVariant } from '../protocol/antigravity-route.mjs'
import { slotAntigravitySupportsModel } from '../oauth/antigravity-models.mjs'

/** Antigravity owns its execution seats; Claude/GPT limits and credentials never enter this pool. */
export function createAntigravityPoolRuntime({ now = Date.now, maxWaiters = 100 } = {}) {
  const slots = new Map()
  const waiters = new Set()
  let cursor = 0
  function state(id) {
    let item = slots.get(id)
    if (!item) slots.set(id, (item = { inFlight: 0, starts: [], holdUntil: 0, failures: 0 }))
    item.starts = item.starts.filter((t) => t > now() - 60_000)
    return item
  }
  function wake() {
    // Selection/claim is synchronous. Waking all cannot oversell a seat and avoids
    // starving a tenant whose eligible slots differ from the first waiter's.
    for (const waiter of [...waiters]) waiter.finish(true)
  }
  return {
    snapshot(id) {
      const s = state(id)
      return { inFlight: s.inFlight, rpm: s.starts.length, holdUntil: s.holdUntil, failures: s.failures }
    },
    order(ids, preferred = null, weights = new Map()) {
      const sorted = [...ids].sort(
        (a, b) => state(a).inFlight - state(b).inFlight || state(a).failures - state(b).failures || a.localeCompare(b),
      )
      const shift = sorted.length ? cursor++ % sorted.length : 0
      const rotated = [...sorted.slice(shift), ...sorted.slice(0, shift)]
      // A free preferred account keeps affinity, but a busy home can lend a turn
      // to another slot because every API call carries the complete history.
      rotated.sort(
        (a, b) =>
          state(a).inFlight - state(b).inFlight ||
          Number(b === preferred) - Number(a === preferred) ||
          state(a).starts.length / (weights.get(a) || 1) - state(b).starts.length / (weights.get(b) || 1),
      )
      return rotated
    },
    acquire(id, { concurrency = 1, maxRpm = 0 } = {}) {
      const s = state(id)
      const at = now()
      if (s.holdUntil > at || s.inFlight >= concurrency || (maxRpm > 0 && s.starts.length >= maxRpm)) return null
      s.inFlight++
      s.starts.push(at)
      let released = false
      return {
        release() {
          if (released) return
          released = true
          s.inFlight = Math.max(0, s.inFlight - 1)
          wake()
        },
      }
    },
    report(id, result) {
      const s = state(id)
      if (result?.ok) {
        s.failures = 0
        s.holdUntil = 0
        return
      }
      if (result?.code === 'client_cancelled' || Number(result?.status) === 499) return
      s.failures = Math.min(100, s.failures + 1)
      const status = Number(result?.status)
      if (![401, 403, 408, 429, 500, 502, 503, 504].includes(status)) return
      const retry = Number(result?.retry_after_ms)
      const delay =
        Number.isFinite(retry) && retry > 0
          ? Math.min(3_600_000, retry)
          : status === 429
            ? 60_000
            : status === 401 || status === 403
              ? 30_000
              : 3000
      s.holdUntil = Math.max(s.holdUntil, now() + delay)
      wake()
    },
    wait({ deadline, retryAt = null, signal } = {}) {
      if (signal?.aborted) return Promise.resolve(false)
      if (waiters.size >= maxWaiters)
        return Promise.reject(
          Object.assign(new Error('Antigravity wait queue is full'), { code: 'pool_wait_queue_full' }),
        )
      return new Promise((resolve) => {
        let timer
        const entry = {
          finish(value) {
            clearTimeout(timer)
            waiters.delete(entry)
            signal?.removeEventListener('abort', abort)
            resolve(value)
          },
        }
        const abort = () => entry.finish(false)
        waiters.add(entry)
        timer = setTimeout(
          () => entry.finish(false),
          Math.min(2_147_483_647, Math.max(1, Math.min(deadline, retryAt || deadline) - now())),
        )
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      })
    },
    reset() {
      slots.clear()
      cursor = 0
      wake()
    },
    get waiterCount() {
      return waiters.size
    },
  }
}

export const antigravityPoolRuntime = createAntigravityPoolRuntime()

/** Allowlists name base models; entries saved by earlier releases may still carry `antigravity/` or a level suffix. */
export function antigravitySlotAllowsModel(vm, model) {
  const base = splitAntigravityVariant(model)?.base
  if (!base) return false
  const allowed = vm?.allowed_models ?? vm?.policy?.allowed_models
  return (
    !Array.isArray(allowed) ||
    !allowed.length ||
    allowed.some((entry) => splitAntigravityVariant(String(entry).replace(/^antigravity\//i, ''))?.base === base)
  )
}

export function pickAntigravityCandidates(
  vms,
  {
    projectRoot,
    model,
    upstreamModel = model,
    routing = {},
    scope,
    ownerScope,
    pin = null,
    excluded = new Set(),
    preferred = null,
    runtime = antigravityPoolRuntime,
    now = Date.now(),
    supportsModel = slotAntigravitySupportsModel,
  } = {},
) {
  const config = normalizeAntigravityRouting(routing.antigravity)
  if (!config.enabled) return { error: 'antigravity_disabled', status: 503, candidates: [] }
  const slots = (vms || []).filter((vm) => isAntigravityVm(vm) && (!pin || vm.id === pin))
  if (pin && !slots.length) return { error: 'platform_mismatch', status: 400, candidates: [] }
  const candidates = []
  let retryAt = null
  let capacity = false
  let modelMissing = false
  let preferredBusy = false
  for (const vm of slots) {
    if (!keyAllowsVm(scope, vm) || !vmMatchesOwnerScope(vm, pin ? { type: 'any' } : ownerScope)) continue
    if (excluded.has(vm.id)) continue
    if (vm.antigravity?.authenticated !== true || !['running', 'paused'].includes(vm.status)) continue
    if (vmNodeId(vm) || isKvmRuntime(vm) || !slotNetworkForVm(vm) || proxyBlockedReason(vm.proxy)) continue
    if (!pin && vm.schedulable === false) continue
    if (!antigravitySlotAllowsModel(vm, model) || !supportsModel(projectRoot, vm, upstreamModel)) {
      modelMissing = true
      continue
    }
    const active = evaluateActiveHours(activeHoursOf(vm), now, vm.timezone)
    if (!pin && !active.active) {
      if (active.until) retryAt = Math.min(retryAt || Infinity, active.until)
      continue
    }
    const state = runtime.snapshot(vm.id)
    // listVms summaries already resolve the slot pin against the global `max_sessions`.
    const concurrency = Math.max(1, Math.min(config.max_sessions, Number(vm.max_concurrency) || config.max_sessions))
    const maxRpm = Math.max(0, Number(vm.max_rpm ?? vm.policy?.maxRpm) || 0)
    if (state.holdUntil > now) {
      retryAt = Math.min(retryAt || Infinity, state.holdUntil)
      capacity = true
      continue
    }
    if (state.inFlight >= concurrency || (maxRpm > 0 && state.rpm >= maxRpm)) {
      capacity = true
      retryAt = Math.min(retryAt || Infinity, now + 1000)
      if (vm.id === preferred && state.inFlight >= concurrency) preferredBusy = true
      continue
    }
    candidates.push({ vm, concurrency, maxRpm })
  }
  const order = runtime.order(
    candidates.map((c) => c.vm.id),
    preferred,
    new Map(candidates.map((c) => [c.vm.id, Math.max(1, Number(c.vm.weight ?? c.vm.policy?.weight) || 1)])),
  )
  candidates.sort((a, b) => order.indexOf(a.vm.id) - order.indexOf(b.vm.id))
  return {
    candidates,
    retryAt,
    preferredBusy,
    error: candidates.length
      ? null
      : capacity
        ? 'antigravity_capacity_unavailable'
        : modelMissing
          ? 'antigravity_model_unavailable'
          : retryAt
            ? 'pool_resting'
            : 'no_antigravity_vm',
    status: capacity ? 429 : 503,
    waitable: capacity || !!retryAt,
  }
}

export function isAntigravityFailoverError(result) {
  if (
    /content_policy|safety|refusal|invalid_request|feature_not_supported|model_not_supported|protocol_error/i.test(
      String(result?.code || ''),
    )
  )
    return false
  // An upstream usage receipt proves consumption even when the client did not
  // receive a complete message. Do not silently spend a second account's quota.
  if (result?.usage && Object.values(result.usage).some((value) => typeof value === 'number' && value > 0)) return false
  return (
    result?.ok !== true &&
    result?.output_committed !== true &&
    [401, 403, 408, 429, 500, 502, 503, 504].includes(Number(result?.status))
  )
}
