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
import { shouldProbeFable, usageProbeBackoffRemainingMs } from './crs-usage-probe.mjs'
import { hasRefreshPresence } from './oauth-credentials.mjs'
import { vmHasProxyPath } from './credential-refresh-monitor.mjs'
import { hasLiveExtraSample, hasOfficialUsageSample, parseResetMs } from '../pool/quota-window.mjs'
export const DEFAULT_USAGE_PROBE = Object.freeze({
  enabled: true,
  interval_sec: 60,
  stale_sec: 300,
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
  const headers = unified?.headers
  if (!headers || typeof headers !== 'object') return null
  let resetMs = null
  for (const key of ['5h', '7d']) {
    const window = headers[key]
    if (!window || typeof window !== 'object') continue
    const ms = parseResetMs(window.reset)
    const elapsed = window.stale_reason === 'reset_elapsed' || (Number.isFinite(ms) && ms <= now)
    if (!elapsed) continue
    const mark = Number.isFinite(ms) ? ms : 0
    resetMs = resetMs == null ? mark : Math.min(resetMs, mark)
  }
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
  const nowFn = opts.now || (() => Date.now())
  // One /usage hop per VM at a time, shared by the timer and 429 events.
  const probing = new Map()
  const backoff = new Map()
  const queue = []
  let running = 0

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
  const probeVm = (vm, reason) => {
    const id = vm.id
    if (probing.has(id)) return probing.get(id)
    const parked = backoff.get(id)
    if (parked && parked.until > nowFn()) {
      return Promise.resolve({ vm_id: id, ok: false, reason: 'probe_backoff', source: null })
    }
    const worker = takeWorker()
    if (!worker) return Promise.resolve({ vm_id: id, ok: false, reason: 'probe_queue_full', source: null })
    const run = worker
      .then(async () => {
        try {
          const result = await withTimeout(Promise.resolve(opts.probeOne(vm)), config.timeout_ms)
          const ok = result?.ok !== false
          if (ok) backoff.delete(id)
          else {
            const failures = (backoff.get(id)?.failures || 0) + 1
            backoff.set(id, {
              failures,
              until: nowFn() + Math.min(STALE_USAGE_PROBE_GAP_MS, PROBE_BACKOFF_BASE_MS * 2 ** (failures - 1)),
            })
          }
          return { vm_id: id, ok, reason, source: result?.source || (ok ? 'oauth-usage' : null) }
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
  const probeNow = (vmId, reason = 'event') => {
    if (typeof opts.probeOne !== 'function') return Promise.resolve({ vm_id: vmId, ok: false, reason: 'no_prober' })
    const vm = listTargets().find((item) => item.id === vmId)
    if (!vm) return Promise.resolve({ vm_id: vmId, ok: false, reason: 'not_target', source: null })
    return probeVm(vm, reason)
  }

  const runOnce = async () => {
    if (inflight) return inflight
    inflight = (async () => {
      const started = nowFn()
      const targets = listTargets()
      const items = []
      const due = []
      const staleMs = config.stale_sec * 1000
      for (const vm of targets) {
        const account = typeof opts.accountForVm === 'function' ? opts.accountForVm(vm) : null
        if (typeof opts.reconcile === 'function') {
          try {
            opts.reconcile(vm, account)
          } catch {}
        }
        let active = false
        if (typeof opts.isActive === 'function') {
          try {
            active = !!opts.isActive(vm, account)
          } catch {}
        }
        const decision = isUsageProbeDue(account || {}, { now: nowFn(), staleMs, active })
        if (!decision.due || typeof opts.probeOne !== 'function') {
          items.push({
            vm_id: vm.id,
            ok: true,
            reason: 'reconcile_extra',
            source: null,
          })
          continue
        }
        due.push({ vm, reason: decision.reason })
      }
      items.push(...(await Promise.all(due.map(({ vm, reason }) => probeVm(vm, reason)))))
      lastRun = {
        at: new Date(nowFn()).toISOString(),
        duration_ms: nowFn() - started,
        due: due.length,
        items,
      }
      return lastRun
    })().finally(() => {
      inflight = null
    })
    return inflight
  }

  const stop = () => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  const start = ({ immediate = false } = {}) => {
    stop()
    if (!config.enabled) return { started: false, reason: 'disabled' }
    timer = setInterval(() => {
      runOnce().catch(() => {})
    }, config.interval_sec * 1000)
    if (typeof timer.unref === 'function') timer.unref()
    if (immediate && config.run_on_start) {
      queueMicrotask(() => {
        runOnce().catch(() => {})
      })
    }
    return { started: true, interval_sec: config.interval_sec, run_on_start: config.run_on_start }
  }

  const setConfig = (next, { restart = true } = {}) => {
    config = normalizeUsageProbeConfig(next)
    if (restart) start({ immediate: false })
    return config
  }

  return {
    getConfig: () => config,
    setConfig,
    getSnapshot: () => lastRun,
    runOnce,
    probeNow,
    start,
    stop,
  }
}
