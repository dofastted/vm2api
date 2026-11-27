/**
 * Warm-up monitor: periodic engine driving {@link ./account-warmup.mjs}.
 *
 * Every interval it enumerates warming slots, snapshots the world outside
 * vm.json (effective pin, schedulability, pool membership, usage stats) and
 * applies the state machine's decision under the vm lock. Pin changes are
 * mirrored through accountQuota.setMaxRpmForVm so the runtime gate
 * (rpmLimitFor) and the panel stay in sync with vm.policy.
 *
 * The monitor only manages state it created; operator actions on the same
 * fields always win (see account-warmup.mjs). Disabling the config stops new
 * decisions but never interrupts an in-flight warm-up.
 */
import { SUCCESS_PRED } from '../db/repos/usage-log-preds.mjs'
import { applyWarmupAction, evaluateWarmup, FATAL_ERROR_SQL, warmupOf } from './account-warmup.mjs'

function clampNum(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, Math.max(min, n))
}

export function fatalCountSince(db, vmId, hours, now = Date.now()) {
  const rows = db
    .prepare(
      `SELECT count(*) c FROM usage_logs
       WHERE vm_id = ? AND datetime(created_at) > datetime(?, 'unixepoch', ?)
       AND ${FATAL_ERROR_SQL}`,
    )
    .all(vmId, Math.floor(now / 1000), `-${clampNum(hours, 1, 168, 6)} hours`)
  return Number(rows?.[0]?.c || 0)
}

export function successCountSince(db, vmId, sinceIso) {
  if (!sinceIso) return 0
  const rows = db
    .prepare(
      `SELECT count(*) c FROM usage_logs
       WHERE vm_id = ? AND datetime(created_at) > datetime(?) AND ${SUCCESS_PRED}`,
    )
    .all(vmId, sinceIso)
  return Number(rows?.[0]?.c || 0)
}

/**
 * Bare-SQL pool membership (vm ids across enabled pools). Kept free of the
 * repo layer so this module stays importable without the optional `pg`
 * package (unit tests, worker contexts).
 */
export function poolMemberVmIds(db) {
  const out = new Set()
  const enabled = new Set(
    (db.prepare('SELECT id FROM vm_pools WHERE COALESCE(enabled, 1) = 1').all() || []).map((r) => r.id),
  )
  for (const row of db.prepare('SELECT pool_id, vm_id FROM vm_pool_members').all() || []) {
    if (enabled.has(row.pool_id)) out.add(String(row.vm_id))
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
  const now = opts.now || (() => Date.now())
  let config = opts.config || {}
  let timer = null
  let running = null

  const listFull = () => {
    const vms = typeof opts.listVms === 'function' ? opts.listVms() || [] : []
    return vms
      .map((vm) => (typeof opts.getVm === 'function' ? opts.getVm(vm.id) : vm) || vm)
      .filter((vm) => warmupOf(vm) !== null)
  }

  async function tick() {
    // Lazy import keeps this module dependency-free on import (unit tests
    // inject getDb; the real chain pulls the optional `pg` package).
    const db = typeof opts.getDb === 'function'
      ? opts.getDb()
      : (await import('../db/database.mjs')).getDb()
    const poolIds =
      typeof opts.poolMemberVmIds === 'function' ? opts.poolMemberVmIds(db) : poolMemberVmIds(db)
    const intervalMinutes = Math.round(clampNum(config.interval_sec, 60, 3600, 600) / 60)
    for (const vm of listFull()) {
      const id = vm.id
      const w = warmupOf(vm)
      if (!w) continue
      try {
        const fatal = fatalCountSince(db, id, clampNum(config.fatal_window_hours, 1, 168, 6), now())
        const snapshot = {
          pinnedRpm: pinnedRpmOf(vm),
          schedulable: vm?.schedulable !== false,
          inPool: poolIds.has(id),
          recentFatal: fatal,
          successRequests: Math.max(
            0,
            successCountSince(db, id, w.started_at) - Number(w.base_success_requests || 0),
          ),
        }
        const decision = evaluateWarmup(vm, snapshot, config)
        if (decision.action === 'none' || decision.action === 'pause' || decision.action === 'hold_fatal') {
          if (decision.action === 'hold_fatal') {
            log(`warmup ${id}: holding, ${fatal} fatal error(s) in window`)
          }
          continue
        }
        const result = await applyWarmupAction(id, decision, {
          load: opts.loadVm,
          save: opts.saveVm,
          intervalMinutes,
          now: new Date(now()).toISOString(),
          config,
        })
        // Mirror pin changes into the accounts repo so rpmLimitFor() agrees.
        if (result?.applied === 'graduate' && typeof opts.setPin === 'function') {
          opts.setPin(id, 0, { override: false })
          log(`warmup ${id}: graduated -> pin dropped`)
        }
        if (result?.applied === 'exit') {
          log(`warmup ${id}: exited (${result.reason})`)
        }
        if (result?.applied === 'follow' || result?.applied === 'accumulate') {
          log(`warmup ${id}: ${result.applied}${result.target_rpm ? ` rpm=${result.target_rpm}` : ''} (${(result.accumulated_minutes || w.accumulated_minutes || 0)}min)`)
        }
      } catch (error) {
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

  return {
    start() {
      if (timer) return { started: false }
      const intervalMs = clampNum(config.interval_sec, 60, 3600, 600) * 1000
      timer = setInterval(() => {
        run().catch(() => {})
      }, intervalMs)
      if (timer.unref) timer.unref()
      run().catch(() => {})
      return { started: true, interval_sec: Math.round(intervalMs / 1000) }
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    setConfig(next = {}) {
      config = next
    },
    tickNow: run,
  }
}
