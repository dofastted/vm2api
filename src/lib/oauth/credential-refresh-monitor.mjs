/**
 * Periodic OAuth refresh for every slot that still has a refresh token,
 * including operator 调度关. Inference no longer reaches those workers, so
 * Go Ensure never runs unless Node asks. Fatal refresh is written onto
 * vm.json as refresh_error → evaluateAccount shows 无效凭证.
 */
import { isLocalEgressProxy } from '../vm/egress.mjs'
import { proxyBlockedReason } from '../vm/proxy-policy.mjs'
import { hasRefreshPresence, needsRefresh } from './oauth-credentials.mjs'
import { backgroundTasksFor } from '../core/shared-background-tasks.mjs'
import { isKubernetesMode } from '../core/control-plane-mode.mjs'
import { getSharedRoutingState } from '../admin/shared-routing-config.mjs'
import { getActivityCoordinator } from '../db/database.mjs'

export const DEFAULT_CREDENTIAL_REFRESH = Object.freeze({
  enabled: true,
  interval_sec: 300,
  run_on_start: true,
  concurrency: 3,
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

export function normalizeCredentialRefreshConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: asBool(src.enabled, DEFAULT_CREDENTIAL_REFRESH.enabled),
    interval_sec: clampInt(src.interval_sec, 60, 3600, DEFAULT_CREDENTIAL_REFRESH.interval_sec),
    run_on_start: asBool(src.run_on_start, DEFAULT_CREDENTIAL_REFRESH.run_on_start),
    concurrency: clampInt(src.concurrency, 1, 8, DEFAULT_CREDENTIAL_REFRESH.concurrency),
    timeout_ms: clampInt(src.timeout_ms, 10_000, 180_000, DEFAULT_CREDENTIAL_REFRESH.timeout_ms),
  }
}

export function vmHasProxyPath(vm) {
  if (!vm) return false
  if (proxyBlockedReason(vm.proxy)) return false
  if (isLocalEgressProxy(vm.proxy)) return true
  if (vm.proxy_cli_enabled && (vm.proxy?.url || vm.proxy?.host || vm.proxy_id)) return true
  return !!(vm.proxy?.url || (vm.proxy?.host && vm.proxy?.port))
}

export function isCredentialRefreshTarget(vm) {
  if (!vm?.id) return false
  if (!hasRefreshPresence(vm.claude) && !vm.has_refresh) return false
  const status = String(vm.status || '').toLowerCase()
  if (HARD_DOWN.has(status)) return false
  if (!vmHasProxyPath(vm)) return false
  return true
}

const REVOKED_ACCESS = /access token has been revoked|token has been revoked|oauth_revoked/i

/** Operator hint only. Scheduled Ensure must not auto-force a still-unexpired ticket. */
export function shouldForceRefresh(vm) {
  const probe = vm?.last_probe || vm?.claude?.last_probe || null
  if (!probe || probe.ok === true) return false
  const blob = `${probe.error || ''} ${probe.message || ''}`
  if (!REVOKED_ACCESS.test(blob)) return false
  const probeAt = Date.parse(probe.at || probe.probed_at || '')
  const refreshedAt = Date.parse(vm?.claude?.refreshed_at || vm?.refreshed_at || '')
  if (Number.isFinite(probeAt) && Number.isFinite(refreshedAt) && probeAt < refreshedAt) return false
  return true
}

export function needsScheduledRefresh(vm, now = Date.now()) {
  if (vm?.refresh_error || vm?.claude?.refresh_error) return false
  return needsRefresh(vm?.expires_at || vm?.claude?.expires_at, now)
}

function mapPool(items, concurrency, fn) {
  const out = new Array(items.length)
  let cursor = 0
  const n = Math.max(1, Math.min(Number(concurrency) || 1, items.length || 1))
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++
      out[index] = await fn(items[index], index)
    }
  }
  return Promise.all(Array.from({ length: Math.min(n, items.length || 1) }, () => worker())).then(() => out)
}

export function createCredentialRefreshMonitor(opts = {}) {
  let config = normalizeCredentialRefreshConfig(opts.config)
  let timer = null
  let inflight = null
  let lastRun = null
  let generation = 0
  const sharedTasks = backgroundTasksFor(opts.sharedTasks)
  const nowFn = opts.now || (() => Date.now())

  const listDue = () => {
    const vms = typeof opts.listTargets === 'function' ? opts.listTargets() || [] : []
    return vms.filter((vm) => isCredentialRefreshTarget(vm) && needsScheduledRefresh(vm, nowFn()))
  }

  const runOnce = async ({ scheduled = false } = {}) => {
    if (inflight) return inflight
    const current = generation
    inflight = (async () => {
      if (isKubernetesMode()) {
        const routing = getSharedRoutingState(sharedTasks?.repo.db)
        if (!routing)
          throw Object.assign(new Error('shared routing unavailable'), { code: 'routing_config_unavailable' })
        const coordinator = getActivityCoordinator(routing.db)
        if (!coordinator)
          throw Object.assign(new Error('activity coordinator unavailable'), { code: 'maintenance_unavailable' })
        await coordinator.runActivity({ kind: 'credential_refresh_configuration' }, async () => ({
          ended: true,
          value: await routing.refresh(),
        }))
      }
      if (scheduled && (current !== generation || !config.enabled)) return lastRun
      const started = nowFn()
      const due = listDue()
      const items = []
      if (due.length && typeof opts.refreshOne === 'function') {
        await mapPool(due, config.concurrency, async (vm) => {
          try {
            const refresh = async () => {
              if (scheduled && (current !== generation || !config.enabled)) {
                return {
                  notStarted: true,
                  value: { vm_id: vm.id, ok: false, refresh_class: 'skipped', reason: 'stopped' },
                }
              }
              const result = await opts.refreshOne(vm, config)
              return {
                terminal: result?.ok === true || result?.taskTerminal === true || result?.taskNotStarted === true,
                value: {
                  vm_id: vm.id,
                  schedulable: vm.schedulable !== false,
                  ok: !!result?.ok,
                  refresh_class: result?.refresh_class || (result?.ok ? 'already_fresh' : 'failed'),
                },
              }
            }
            if (sharedTasks) {
              const result = await sharedTasks.run(
                { taskKey: `credential-refresh:${vm.id}`, intervalMs: config.interval_sec * 1000 },
                refresh,
              )
              items.push(
                result.ran ? result.value : { vm_id: vm.id, ok: false, refresh_class: 'skipped', reason: result.code },
              )
            } else items.push((await refresh()).value)
          } catch (error) {
            items.push({
              vm_id: vm.id,
              schedulable: vm.schedulable !== false,
              ok: false,
              refresh_class: 'retryable',
              error: String(error?.message || error).slice(0, 200),
            })
          }
        })
      }
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
    generation++
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    return inflight ? Promise.allSettled([inflight]) : Promise.resolve()
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
    config = normalizeCredentialRefreshConfig(next)
    if (restart) start({ immediate: false })
    return config
  }

  return {
    getConfig: () => config,
    setConfig,
    getSnapshot: () => lastRun,
    runOnce,
    start,
    flush: async () => {
      while (inflight) await inflight
    },
    stop,
  }
}
