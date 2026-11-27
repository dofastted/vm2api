import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_WARMUP,
  FATAL_ERROR_SQL,
  applyWarmupAction,
  clearWarmup,
  evaluateWarmup,
  graduateWarmup,
  isWarming,
  normalizeWarmupConfig,
  startWarmup,
  warmupOf,
  warmupPhase,
} from '../../src/lib/pool/account-warmup.mjs'

function freshVm() {
  return { id: 'vm-1', policy: {} }
}

function snap(overrides = {}) {
  return { pinnedRpm: 30, schedulable: true, inPool: true, recentFatal: 0, successRequests: 0, ...overrides }
}

test('normalizeWarmupConfig clamps and falls back', () => {
  const c = normalizeWarmupConfig({ enabled: 'off', target_rpm: 9999, min_hours: 0, min_requests: 50, fatal_window_hours: 3 })
  assert.equal(c.enabled, false)
  assert.equal(c.target_rpm, 200)   // clamped to max
  assert.equal(c.min_hours, DEFAULT_WARMUP.min_hours) // invalid -> fallback
  assert.equal(c.min_requests, 50)
  assert.equal(c.fatal_window_hours, 3)
  assert.deepEqual(Object.keys(normalizeWarmupConfig({})), Object.keys(DEFAULT_WARMUP))
})

test('startWarmup writes the segment and pins rpm', () => {
  const vm = freshVm()
  const w = startWarmup(vm, { targetRpm: 30, baseSuccessRequests: 12, now: '2026-11-27T00:00:00Z' })
  assert.equal(w.started_at, '2026-11-27T00:00:00Z')
  assert.equal(w.target_rpm, 30)
  assert.equal(w.accumulated_minutes, 0)
  assert.equal(w.base_success_requests, 12)
  assert.equal(vm.policy.maxRpm, 30)
  assert.equal(vm.policy.rpmOverride, true)
  assert.ok(isWarming(vm))
  assert.equal(warmupPhase(vm), 'warming')

  // restart resets counters and keeps a restart event
  const w2 = startWarmup(vm, { now: '2026-11-28T00:00:00Z' })
  assert.equal(w2.accumulated_minutes, 0)
  assert.equal(w2.events.at(-1).kind, 'restart')
})

test('operator clearing the pin exits warm-up (operator override)', () => {
  const vm = freshVm()
  startWarmup(vm, { targetRpm: 30 })
  const d = evaluateWarmup(vm, snap({ pinnedRpm: null }))
  assert.equal(d.action, 'exit')
  assert.equal(d.reason, 'operator_override')
})

test('operator retuning the pin is followed, not overwritten', () => {
  const vm = freshVm()
  startWarmup(vm, { targetRpm: 30 })
  const d = evaluateWarmup(vm, snap({ pinnedRpm: 50 }))
  assert.equal(d.action, 'follow')
  assert.equal(d.targetRpm, 50)
})

test('unschedulable or out-of-pool slots pause instead of accruing time', () => {
  const vm = freshVm()
  startWarmup(vm, { targetRpm: 30 })
  assert.equal(evaluateWarmup(vm, snap({ schedulable: false })).action, 'pause')
  assert.equal(evaluateWarmup(vm, snap({ inPool: false })).action, 'pause')
  assert.equal(warmupPhase(vm, { schedulable: false }), 'paused')
})

test('recent fatal errors hold graduation and surface abnormal', () => {
  const vm = freshVm()
  startWarmup(vm, { targetRpm: 30 })
  vm.policy.warmup.accumulated_minutes = 60 * 48
  const d = evaluateWarmup(vm, snap({ successRequests: 500, recentFatal: 1 }))
  assert.equal(d.action, 'hold_fatal')
  assert.equal(warmupPhase(vm, { recentFatal: 1 }), 'abnormal')
})

test('graduation needs both time served and successful requests', () => {
  const vm = freshVm()
  startWarmup(vm, { targetRpm: 30 })
  vm.policy.warmup.accumulated_minutes = 60 * 24
  assert.equal(evaluateWarmup(vm, snap({ successRequests: 99 })).action, 'accumulate')
  vm.policy.warmup.accumulated_minutes = 60 * 23
  assert.equal(evaluateWarmup(vm, snap({ successRequests: 500 })).action, 'accumulate')
  vm.policy.warmup.accumulated_minutes = 60 * 24
  assert.equal(evaluateWarmup(vm, snap({ successRequests: 100 })).action, 'graduate')
})

test('graduateWarmup drops the pin and clears the segment', () => {
  const vm = freshVm()
  startWarmup(vm, { targetRpm: 30, now: '2026-11-26T00:00:00Z' })
  vm.policy.warmup.accumulated_minutes = 1441
  const record = graduateWarmup(vm, '2026-11-27T01:00:00Z')
  assert.equal(record.accumulated_minutes, 1441)
  assert.equal(record.target_rpm, 30)
  assert.equal(vm.policy.maxRpm, null)
  assert.equal(vm.policy.rpmOverride, false)
  assert.equal(warmupOf(vm), null)
  assert.equal(warmupPhase(vm), null)
})

test('clearWarmup keeps the pin and reports exit events', () => {
  const vm = freshVm()
  startWarmup(vm, { targetRpm: 30 })
  const out = clearWarmup(vm, 'operator_override')
  assert.equal(out.reason, undefined) // top level is the exited segment
  assert.equal(out.exited.target_rpm, 30)
  assert.equal(out.events.at(-1).kind, 'exit')
  assert.equal(vm.policy.maxRpm, 30) // pin untouched on exit
  assert.equal(warmupOf(vm), null)
})

test('applyWarmupAction applies decisions under the vm lock', async () => {
  const store = new Map()
  const vm = freshVm()
  startWarmup(vm, { targetRpm: 30 })
  store.set('vm-1', vm)
  const load = async (id) => store.get(id)
  const save = async (v) => store.set(v.id, v)

  let r = await applyWarmupAction('vm-1', { action: 'accumulate' }, { load, save, intervalMinutes: 10 })
  assert.equal(r.applied, 'accumulate')
  assert.equal(store.get('vm-1').policy.warmup.accumulated_minutes, 10)

  r = await applyWarmupAction('vm-1', { action: 'follow', targetRpm: 50 }, { load, save })
  assert.equal(store.get('vm-1').policy.warmup.target_rpm, 50)

  r = await applyWarmupAction('vm-1', { action: 'graduate' }, { load, save, now: '2026-11-28T00:00:00Z' })
  assert.equal(r.applied, 'graduate')
  assert.equal(store.get('vm-1').policy.rpmOverride, false)

  // gone segment -> skip
  r = await applyWarmupAction('vm-1', { action: 'accumulate' }, { load, save, intervalMinutes: 10 })
  assert.equal(r.applied, 'skip_gone')
})

test('fatal error predicate covers credential, risk and org classes', () => {
  for (const frag of ["error_code LIKE 'upstream_auth%'", "'refusal_guard'", "'kernel_unavailable'", "'upstream_forbidden'", "%organization%"]) {
    assert.ok(FATAL_ERROR_SQL.includes(frag), frag)
  }
})
