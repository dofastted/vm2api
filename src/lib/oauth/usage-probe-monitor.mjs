/**
 * Periodic Extra reconcile for live credential slots.
 *
 * Healthy Extra windows stay on Messages headers. Official GET /api/oauth/usage
 * hops when Extra never sampled (setup-token / first import), an Extra reset
 * elapsed, or a stale Pro classification needs a Fable recheck.
 * A window whose reset has already passed is not a real 0% sample: cli-hop
 * often stops sending fresh rate-limit headers, and the
 * wipe would otherwise pin the panel at 0 while usage_logs keep growing.
 * Those slots get one /usage hop, then back off.
 */
import { createHash } from 'node:crypto'
import { shouldProbeFable, usageProbeBackoffRemainingMs } from './crs-usage-probe.mjs'
import { hasRefreshPresence } from './oauth-credentials.mjs'
import { vmHasProxyPath } from './credential-refresh-monitor.mjs'
import { hasLiveExtraSample, hasOfficialUsageSample, parseResetMs } from '../pool/quota-window.mjs'
import { backgroundTasksFor } from '../core/shared-background-tasks.mjs'
import { isKubernetesMode } from '../core/control-plane-mode.mjs'
import { getSharedRoutingState } from '../admin/shared-routing-config.mjs'
import { getActivityCoordinator } from '../db/database.mjs'
export const DEFAULT_USAGE_PROBE = Object.freeze({
  enabled: false,
  interval_sec: 60,
  stale_sec: 300,
  // Opt-in: defer the first periodic hop after an Extra 5h reset.
  reset_delay_sec: 0,
  reset_jitter_sec: 0,
  run_on_start: true,
  concurrency: 2,
  timeout_ms: 60_000,
})

const HARD_DOWN = new Set(['stopped', 'dead', 'error', 'disabled'])

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function asBool(value, fallback) {
  if (value == null) return fallback
  if (typeof value === 'boolean') return value
  const s = String(value).trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false
  return fallback
}

export function normalizeUsageProbeConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: asBool(src.enabled, DEFAULT_USAGE_PROBE.enabled),
    interval_sec: clampInt(src.interval_sec, 30, 3600, DEFAULT_USAGE_PROBE.interval_sec),
    stale_sec: clampInt(src.stale_sec, 60, 86_400, DEFAULT_USAGE_PROBE.stale_sec),
    reset_delay_sec: clampInt(src.reset_delay_sec, 0, 3600, DEFAULT_USAGE_PROBE.reset_delay_sec),
    reset_jitter_sec: clampInt(src.reset_jitter_sec, 0, 3600, DEFAULT_USAGE_PROBE.reset_jitter_sec),
    run_on_start: asBool(src.run_on_start, DEFAULT_USAGE_PROBE.run_on_start),
    concurrency: clampInt(src.concurrency, 1, 8, DEFAULT_USAGE_PROBE.concurrency),
    timeout_ms: clampInt(src.timeout_ms, 10_000, 180_000, DEFAULT_USAGE_PROBE.timeout_ms),
  }
}

export function isUsageProbeTarget(vm) {
  if (!vm?.id) return false
  if (!hasRefreshPresence(vm.claude) && !vm.has_refresh && !vm.has_token) return false
  const grantErr = String(vm.claude?.refresh_error || vm.refresh_error || '')
  if (/invalid_grant|refresh token not found/i.test(grantErr)) return false
  const status = String(vm.status || '').toLowerCase()
  if (HARD_DOWN.has(status)) return false
  if (!vmHasProxyPath(vm)) return false
  return true
}

/** Re-hop a stale window at most this often after a probe that did not refresh it. */
const STALE_USAGE_PROBE_GAP_MS = 15 * 60_000

function elapsedExtraResetMs(unified = {}, now = Date.now()) {
  let resetMs = null
  const consider = (window) => {
    if (!window || typeof window !== 'object') return
    const ms = parseResetMs(window.reset)
    const elapsed = window.stale_reason === 'reset_elapsed' || (Number.isFinite(ms) && ms <= now)
    if (!elapsed) return
    const mark = Number.isFinite(ms) ? ms : 0
    resetMs = resetMs == null ? mark : Math.min(resetMs, mark)
  }
  const headers = unified?.headers
  if (headers && typeof headers === 'object') {
    for (const key of ['5h', '7d', '7d_oi']) consider(headers[key])
  }
  consider(unified['7d_oi'])
  return resetMs
}

/** Newest real quota sample: a Messages header read or an official /usage hop. */
export function latestUsageSampleMs(account = {}) {
  const unified = account?.unified || {}
  const times = [
    unified.headers?.sampled_at,
    account?.last_probe?.at,
    unified.last_probe?.at,
    unified.last_probe?.probed_at,
  ]
    .map((value) => Date.parse(value || ''))
    .filter(Number.isFinite)
  return times.length ? Math.max(...times) : null
}

/**
 * Hop /usage after Extra never sampled, a 5h/7d Extra reset elapsed, or Pro recheck.
 * An account in use (serving traffic or holding pinned conversations) also
 * hops once its newest real sample is older than `staleMs`: a reset still in
 * the future says nothing about how fresh the utilization number is (#163).
 * Live Extra or an existing official sample otherwise stays passive.
 * @returns {{ due: boolean, reason?: string }}
 */
export function isUsageProbeDue(account = {}, opts = {}) {
  const now = opts.now || Date.now()
  const unified = account?.unified || {}
  if (usageProbeBackoffRemainingMs(unified, now) > 0) {
    return { due: false, reason: 'usage_backoff' }
  }
  if (
    String(unified.account_tier || '').toLowerCase() === 'pro' &&
    shouldProbeFable({ fable: unified.fable || {}, quota: unified, storedTier: 'pro', now })
  ) {
    const attemptedAt = Date.parse(unified.fable_probe_attempted_at || unified.fable?.probed_at || '')
    if (!Number.isFinite(attemptedAt) || now - attemptedAt >= 60 * 60_000) {
      return { due: true, reason: 'pro_tier_recheck' }
    }
  }
  const staleMs = Number(opts.staleMs)
  if (opts.active && Number.isFinite(staleMs) && staleMs > 0) {
    const sampledMs = latestUsageSampleMs(account)
    if (sampledMs == null || now - sampledMs >= staleMs) return { due: true, reason: 'sample_stale' }
  }
  const resetMs = elapsedExtraResetMs(unified, now)
  const probedAt = Date.parse(account?.last_probe?.at || unified.last_probe?.at || unified.last_probe?.probed_at || '')
  if (resetMs == null) {
    if (hasOfficialUsageSample(unified) || hasLiveExtraSample(unified, { now })) {
      return { due: false, reason: 'list_passive_only' }
    }
    const sampledAt = Date.parse(
      account?.last_probe?.at ||
        unified.last_probe?.at ||
        unified.last_probe?.probed_at ||
        unified.fable_probe_attempted_at ||
        unified.fable?.probed_at ||
        '',
    )
    if (Number.isFinite(sampledAt) && now - sampledAt < STALE_USAGE_PROBE_GAP_MS) {
      return { due: false, reason: 'probed_recently' }
    }
    return { due: true, reason: 'never_sampled_official' }
  }
  if (Number.isFinite(probedAt) && probedAt > resetMs && now - probedAt < STALE_USAGE_PROBE_GAP_MS) {
    return { due: false, reason: 'probed_recently' }
  }
  return { due: true, reason: 'extra_window_elapsed' }
}

/** A stable deadline, not a sleep or a fresh random draw on each timer tick.
 * Only gates an already-due periodic hop; never creates extra requests or delays
 * real traffic, manual probeNow, or the separate Messages health monitor.
 */
function resetProbeAt(account, vm, config, now) {
  if (!config.reset_delay_sec && !config.reset_jitter_sec) return null
  const unified = account?.unified || {}
  const reset = parseResetMs(unified.headers?.['5h']?.reset)
  if (!Number.isFinite(reset) || reset > now) return null
  const probe = account?.last_probe || unified.last_probe
  const probed = Date.parse(probe?.at || probe?.probed_at || '')
  if (probe?.ok === true && Number.isFinite(probed) && probed >= reset) return null
  const id = String(account?.account_id || vm.claude?.account_uuid || vm.account_uuid || vm.id)
  const hash = createHash('sha256')
    .update(JSON.stringify([id, reset]))
    .digest()
    .readUInt32BE(0)
  const jitter = hash % (config.reset_jitter_sec + 1)
  return reset + (config.reset_delay_sec + jitter) * 1000
}

/** Queued probes beyond the running `concurrency` workers; more are dropped, never blocked on. */
const MAX_QUEUED_PROBES = 64
const PROBE_BACKOFF_BASE_MS = 60_000

function withTimeout(promise, ms) {
  let timer
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('usage probe timed out'), { code: 'probe_timeout' })), ms)
    timer.unref?.()
  })
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer))
}

export function createUsageProbeMonitor(opts = {}) {
  let config = normalizeUsageProbeConfig(opts.config)
  let timer = null
  let inflight = null
  let lastRun = null
  let generation = 0
  const sharedTasks = backgroundTasksFor(opts.sharedTasks)
  const operations = new Set()
  const nowFn = opts.now || (() => Date.now())
  // One /usage hop per VM at a time, shared by the timer and 429 events.
  const probing = new Map()
  const backoff = new Map()
  const queue = []
  let running = 0

  const refreshRouting = async () => {
    if (!isKubernetesMode()) return
    const routing = getSharedRoutingState(sharedTasks?.repo.db)
    if (!routing) throw Object.assign(new Error('shared routing unavailable'), { code: 'routing_config_unavailable' })
    const coordinator = getActivityCoordinator(routing.db)
    if (!coordinator)
      throw Object.assign(new Error('activity coordinator unavailable'), { code: 'maintenance_unavailable' })
    await coordinator.runActivity({ kind: 'usage_probe_configuration' }, async () => ({
      ended: true,
      value: await routing.refresh(),
    }))
  }

  const listTargets = () => {
    const vms = typeof opts.listTargets === 'function' ? opts.listTargets() || [] : []
    return vms.filter((vm) => isUsageProbeTarget(vm))
  }

  const takeWorker = () => {
    if (running < config.concurrency) {
      running += 1
      return Promise.resolve(true)
    }
    if (queue.length >= MAX_QUEUED_PROBES) return null
    return new Promise((resolve) => queue.push(resolve))
  }

  const giveWorker = () => {
    const next = queue.shift()
    if (next) next(true)
    else running -= 1
  }

  /**
   * Failures keep the old sample (never a 0%), back off exponentially, and
   * surface in the run snapshot. A success clears the backoff.
   */
  const probeVm = (vm, reason, prepare) => {
    const id = vm.id
    if (probing.has(id)) return probing.get(id)
    const worker = takeWorker()
    if (!worker) return Promise.resolve({ vm_id: id, ok: false, reason: 'probe_queue_full', source: null })
    const run = worker
      .then(async () => {
        try {
          const probe = async () => {
            const prepared = await prepare?.()
            if (prepared?.item) return { notStarted: true, value: prepared.item }
            const probeReason = prepared?.reason || reason
            const parked = backoff.get(id)
            if (parked && parked.until > nowFn()) {
              return { notStarted: true, value: { vm_id: id, ok: false, reason: 'probe_backoff', source: null } }
            }
            // The timeout only stops this caller waiting. Shutdown still observes the original work.
            const operation = Promise.resolve().then(() => opts.probeOne(vm))
            operations.add(operation)
            operation.then(
              () => operations.delete(operation),
              () => operations.delete(operation),
            )
            const result = await withTimeout(operation, config.timeout_ms)
            const payload = result?.data || result?.body?.data || result
            const ok = result?.ok !== false && payload?.ok !== false
            if (ok) backoff.delete(id)
            else {
              const failures = (backoff.get(id)?.failures || 0) + 1
              backoff.set(id, {
                failures,
                until: nowFn() + Math.min(STALE_USAGE_PROBE_GAP_MS, PROBE_BACKOFF_BASE_MS * 2 ** (failures - 1)),
              })
            }
            return {
              terminal: (result != null && ok) || result?.taskTerminal === true || result?.taskNotStarted === true,
              value: { vm_id: id, ok, reason: probeReason, source: payload?.source || (ok ? 'oauth-usage' : null) },
            }
          }
          if (!sharedTasks) return (await probe()).value
          const result = await sharedTasks.run(
            { taskKey: `usage-probe:${id}`, intervalMs: config.interval_sec * 1000 },
            probe,
          )
          return result.ran ? result.value : { vm_id: id, ok: false, reason: result.code, source: null }
        } catch (error) {
          const failures = (backoff.get(id)?.failures || 0) + 1
          backoff.set(id, {
            failures,
            until: nowFn() + Math.min(STALE_USAGE_PROBE_GAP_MS, PROBE_BACKOFF_BASE_MS * 2 ** (failures - 1)),
          })
          return { vm_id: id, ok: false, reason, source: null, error: error?.code || 'probe_failed' }
        } finally {
          giveWorker()
        }
      })
      .finally(() => probing.delete(id))
    probing.set(id, run)
    return run
  }

  /** Event-driven hop (unknown 429, reset recheck). Same single-flight and bounds as the timer. */
  const probeNow = async (vmId, reason = 'event') => {
    await refreshRouting()
    if (typeof opts.probeOne !== 'function') return Promise.resolve({ vm_id: vmId, ok: false, reason: 'no_prober' })
    const vm = listTargets().find((item) => item.id === vmId)
    if (!vm) return Promise.resolve({ vm_id: vmId, ok: false, reason: 'not_target', source: null })
    return probeVm(vm, reason)
  }

  const runOnce = async ({ scheduled = false } = {}) => {
    if (inflight) return inflight
    const current = generation
    inflight = (async () => {
      await refreshRouting()
      if (scheduled && (current !== generation || !config.enabled)) return lastRun
      const started = nowFn()
      const targets = listTargets()
      let due = 0
      const staleMs = config.stale_sec * 1000
      const prepare = async (vm) => {
        if (scheduled && (current !== generation || !config.enabled)) {
          return { item: { vm_id: vm.id, ok: false, reason: 'stopped', source: null } }
        }
        const account = typeof opts.accountForVm === 'function' ? opts.accountForVm(vm) : null
        if (typeof opts.reconcile === 'function') await opts.reconcile(vm, account)
        let active = false
        if (typeof opts.isActive === 'function') active = !!opts.isActive(vm, account)
        const decision = isUsageProbeDue(account || {}, { now: nowFn(), staleMs, active })
        if (!decision.due || typeof opts.probeOne !== 'function') {
          return { item: { vm_id: vm.id, ok: true, reason: 'reconcile_extra', source: null } }
        }
        const nextProbeAt = resetProbeAt(account, vm, config, nowFn())
        if (nextProbeAt != null && nextProbeAt > nowFn()) {
          return {
            item: {
              vm_id: vm.id,
              ok: true,
              reason: 'reset_probe_delay',
              source: null,
              next_probe_at: new Date(nextProbeAt).toISOString(),
            },
          }
        }
        due++
        return { reason: decision.reason }
      }
      const items = []
      if (sharedTasks) {
        let cursor = 0
        await Promise.all(
          Array.from({ length: Math.min(config.concurrency, targets.length) }, async () => {
            while (cursor < targets.length) {
              const index = cursor++
              const vm = targets[index]
              items[index] = await probeVm(vm, 'scheduled', () => prepare(vm))
            }
          }),
        )
      } else {
        const probes = []
        for (const vm of targets) {
          const prepared = await prepare(vm)
          if (prepared.item) items.push(prepared.item)
          else probes.push({ vm, reason: prepared.reason })
        }
        items.push(...(await Promise.all(probes.map(({ vm, reason }) => probeVm(vm, reason)))))
      }
      lastRun = {
        at: new Date(nowFn()).toISOString(),
        duration_ms: nowFn() - started,
        due,
        items,
      }
      return lastRun
    })().finally(() => {
      inflight = null
    })
    return inflight
  }

  const stop = () => {
    generation++
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    return flush()
  }

  const start = ({ immediate = false } = {}) => {
    stop()
    if (!config.enabled) return { started: false, reason: 'disabled' }
    const current = generation
    timer = setInterval(() => {
      if (current === generation) runOnce({ scheduled: true }).catch(() => {})
    }, config.interval_sec * 1000)
    if (typeof timer.unref === 'function') timer.unref()
    if (immediate && config.run_on_start) {
      queueMicrotask(() => {
        if (current === generation) runOnce({ scheduled: true }).catch(() => {})
      })
    }
    return { started: true, interval_sec: config.interval_sec, run_on_start: config.run_on_start }
  }

  const setConfig = (next, { restart = true } = {}) => {
    config = normalizeUsageProbeConfig(next)
    if (restart) start({ immediate: false })
    return config
  }

  const flush = async () => {
    while (inflight || probing.size || operations.size) {
      await Promise.allSettled([...(inflight ? [inflight] : []), ...probing.values(), ...operations])
    }
  }

  return {
    getConfig: () => config,
    setConfig,
    getSnapshot: () => lastRun,
    runOnce,
    probeNow,
    start,
    flush,
    stop,
  }
}
