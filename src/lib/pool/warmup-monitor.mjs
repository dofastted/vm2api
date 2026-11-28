/**
 * Warm-up monitor: periodic engine driving {@link ./account-warmup.mjs}.
 *
 * Every interval it enumerates warming slots, snapshots the world outside
 * vm.json (effective pin, schedulability, scheduler pool membership, usage
 * stats) and applies the state machine's decision under `withVmLock(vmPath)`.
 * Graduation restores the slot's tier/default RPM via `inheritVmScheduling`
 * (clearing `rpm_override`) and pushes the updated snapshot to Rust
 * `kin-scheduler` via `schedulerRuntime.syncConfigNow`.
 *
 * The monitor only manages state it created; operator actions on the same
 * fields always win (see account-warmup.mjs). Disabling the config stops new
 * onboarding only; in-flight warm-ups still run to graduation.
 */
import path from 'node:path'
import { SUCCESS_PRED } from '../db/repos/usage-log-preds.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import {
  applyWarmupAction,
  evaluateWarmup,
  FATAL_ERROR_SQL,
  normalizeWarmupConfig,
  warmupOf,
} from './account-warmup.mjs'

const NON_CLAUDE_POOL_SCOPES = new Set(['openai', 'google', 'gemini', 'api'])

function clampNum(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, Math.max(min, n))
}

function toIsoCutoff(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Date(value).toISOString() : null
  }
  const raw = String(value).trim()
  if (!raw) return null
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : raw
}

function isClaudeEligiblePoolScope(scope) {
  const norm = String(scope ?? 'mixed')
    .trim()
    .toLowerCase()
  return !NON_CLAUDE_POOL_SCOPES.has(norm)
}

function isEnabledClaudeVm(vm) {
  if (!vm || isCodexVm(vm)) return false
  const statusLower = String(vm.status || '').toLowerCase()
  return statusLower !== 'deleted' && statusLower !== 'disabled'
}

export function fatalCountSince(db, vmId, hours, now = Date.now()) {
  const windowHours = clampNum(hours, 1, 168, 6)
  const sinceIso = new Date(now - windowHours * 3600 * 1000).toISOString()
  const rows = db
    .prepare(
      `SELECT count(*) AS c FROM usage_logs
       WHERE vm_id = ? AND created_at >= ?
       AND ${FATAL_ERROR_SQL}`,
    )
    .all(vmId, sinceIso)
  return Number(rows?.[0]?.c || 0)
}

export function successCountSince(db, vmId, sinceIso) {
  const cutoff = toIsoCutoff(sinceIso)
  if (!cutoff) return 0
  const rows = db
    .prepare(
      `SELECT count(*) AS c FROM usage_logs
       WHERE vm_id = ? AND created_at >= ? AND ${SUCCESS_PRED}`,
    )
    .all(vmId, cutoff)
  return Number(rows?.[0]?.c || 0)
}

/**
 * Bare-SQL pool membership from `scheduler_pools` / `scheduler_pool_members`.
 * Kept free of the repo layer so this module stays importable without the
 * optional `pg` package (unit tests, worker contexts).
 *
 * Returns `null` when no custom Claude-eligible pools exist (default
 * deployments route all enabled Claude slots through built-in virtual pool
 * `__virtual_claude__`). Returns a `Set<string>` of enabled `claude_vm` node
 * IDs when custom Claude-eligible pools are configured.
 */
export function poolMemberVmIds(db) {
  const pools =
    db
      .prepare(
        `SELECT id, COALESCE(enabled, 1) AS enabled, COALESCE(provider_scope, 'mixed') AS provider_scope
         FROM scheduler_pools`,
      )
      .all() || []
  const claudePools = pools.filter((r) => isClaudeEligiblePoolScope(r.provider_scope))
  if (claudePools.length === 0) return null

  const enabled = new Set(claudePools.filter((r) => Number(r.enabled) === 1).map((r) => String(r.id)))
  const out = new Set()
  if (enabled.size === 0) return out
  for (const row of db
    .prepare(
      `SELECT pool_id, node_id FROM scheduler_pool_members
       WHERE node_type = 'claude_vm' AND COALESCE(enabled, 1) = 1`,
    )
    .all() || []) {
    if (enabled.has(String(row.pool_id))) out.add(String(row.node_id))
  }
  return out
}

/**
 * Effective manual pin as seen from vm.policy. `override=true` with a zero
 * value is an empty flag (no pin) — treated as unpinned so a leftover
 * half-state exits warm-up instead of guarding it.
 */
export function pinnedRpmOf(vm) {
  const p = vm?.policy
  if (!p || p.rpmOverride !== true) return null
  const n = Number(p.maxRpm)
  return Number.isFinite(n) && n > 0 ? n : null
}

export function createWarmupMonitor(opts = {}) {
  const log = opts.log || (() => {})
  const warn =
    opts.warn ||
    ((payload) => {
      console.warn(JSON.stringify(payload))
    })
  const now = opts.now || (() => Date.now())
  let config = normalizeWarmupConfig(opts.config)
  let timer = null
  let running = null

  const resolveVmPath = (id) => {
    if (typeof opts.vmPath === 'function') return opts.vmPath(id)
    if (opts.projectRoot) return path.join(opts.projectRoot, 'vms', `${id}.json`)
    return path.join('vms', `${id}.json`)
  }

  const listFull = () => {
    const vms = typeof opts.listVms === 'function' ? opts.listVms() || [] : []
    return vms
      .map((vm) => (typeof opts.getVm === 'function' ? opts.getVm(vm.id) : vm) || vm)
      .filter((vm) => warmupOf(vm) !== null)
  }

  async function tick() {
    const warming = listFull()
    if (!warming.length) return
    let db
    let poolIds
    try {
      // Lazy import keeps this module dependency-free on import (unit tests
      // inject getDb; the real chain pulls the optional `pg` package).
      db = typeof opts.getDb === 'function' ? opts.getDb() : (await import('../db/database.mjs')).getDb()
      poolIds = typeof opts.poolMemberVmIds === 'function' ? opts.poolMemberVmIds(db) : poolMemberVmIds(db)
    } catch (error) {
      warn({
        event: 'warmup_pool_query_failed',
        error: String(error?.message || error),
      })
      return
    }
    const intervalMinutes = Math.round(clampNum(config.interval_sec, 60, 3600, 600) / 60)
    for (const vm of warming) {
      const id = vm.id
      const w = warmupOf(vm)
      if (!w) continue
      try {
        const fatal = fatalCountSince(db, id, clampNum(config.fatal_window_hours, 1, 168, 6), now())
        const successTotal = successCountSince(db, id, w.started_at)
        const inPool = poolIds === null ? isEnabledClaudeVm(vm) : poolIds.has(id)
        const snapshot = {
          pinnedRpm: pinnedRpmOf(vm),
          schedulable: vm?.schedulable !== false,
          inPool,
          recentFatal: fatal,
          successRequests: Math.max(0, successTotal - Number(w.base_success_requests || 0)),
        }
        const decision = evaluateWarmup(vm, snapshot, config)
        if (decision.action === 'none' || decision.action === 'pause' || decision.action === 'hold_fatal') {
          if (decision.action === 'hold_fatal') {
            log(`warmup ${id}: holding, ${fatal} fatal error(s) in window`)
          }
          continue
        }
        const lockPath = resolveVmPath(id)
        const result = await applyWarmupAction(lockPath, decision, {
          vmId: id,
          load: opts.loadVm,
          save: opts.saveVm,
          onGraduate: typeof opts.inheritRpm === 'function' ? () => opts.inheritRpm(id) : null,
          intervalMinutes,
          now: new Date(now()).toISOString(),
          config,
        })
        if (result?.applied === 'graduate') {
          if (typeof opts.inheritRpm !== 'function' && typeof opts.setPin === 'function') {
            opts.setPin(id, 0, { override: false })
          }
          if (typeof opts.syncScheduler === 'function') {
            try {
              await opts.syncScheduler('warmup_graduate')
            } catch (syncError) {
              warn({
                event: 'warmup_scheduler_sync_failed',
                vm_id: id,
                reason: 'warmup_graduate',
                error: String(syncError?.message || syncError),
              })
            }
          }
          log(`warmup ${id}: graduated -> inherited scheduling RPM`)
        }
        if (result?.applied === 'exit') {
          log(`warmup ${id}: exited (${result.reason})`)
        }
        if (result?.applied === 'follow' || result?.applied === 'accumulate') {
          log(
            `warmup ${id}: ${result.applied}${result.target_rpm ? ` rpm=${result.target_rpm}` : ''} (${result.accumulated_minutes || w.accumulated_minutes || 0}min)`,
          )
        }
      } catch (error) {
        warn({
          event: 'warmup_tick_failed',
          vm_id: id,
          error: String(error?.message || error),
        })
        log(`warmup ${id}: tick failed: ${error?.message || error}`)
      }
    }
  }

  async function run() {
    if (running) return running
    running = (async () => {
      try {
        await tick()
      } finally {
        running = null
      }
    })()
    return running
  }

  function schedule() {
    if (timer) clearInterval(timer)
    const intervalMs = clampNum(config.interval_sec, 60, 3600, 600) * 1000
    timer = setInterval(() => {
      run().catch(() => {})
    }, intervalMs)
    if (timer.unref) timer.unref()
    return intervalMs
  }

  return {
    getConfig: () => config,
    start() {
      if (timer) return { started: false }
      const intervalMs = schedule()
      run().catch(() => {})
      return { started: true, interval_sec: Math.round(intervalMs / 1000) }
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    setConfig(next = {}) {
      const before = clampNum(config.interval_sec, 60, 3600, 600)
      config = normalizeWarmupConfig(next)
      const after = clampNum(config.interval_sec, 60, 3600, 600)
      if (timer && before !== after) schedule()
    },
    tickNow: run,
  }
}
