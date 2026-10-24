import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CLEAR_BY,
  applyClearHold,
  applyClearUnschedulable,
  applyHold,
  applyScheduleOff,
  applyUnschedulable,
  migrateScheduleRecord,
  pickScheduleFields,
  resolveSlotState,
  stateOfReason,
} from '../../src/lib/pool/schedule-state.mjs'
import { ErrorCode } from '../../src/lib/core/errors.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** Every reason literal the pool, the eligibility gates and the error policy emit. */
function emittedReasons() {
  const files = [
    'src/lib/pool/pool-scheduler.mjs',
    'src/lib/pool/schedule-eligibility.mjs',
    'src/lib/pool/availability.mjs',
    'src/lib/pool/upstream-error-policy.mjs',
    'src/lib/pool/account-quota.mjs',
  ]
  const codes = new Set()
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8')
    for (const match of text.matchAll(/reason: '([a-z0-9_]+)'/g)) codes.add(match[1])
    for (const match of text.matchAll(/markWait\('([a-z0-9_]+)'/g)) codes.add(match[1])
  }
  return [...codes].sort()
}

test('every emitted reason has exactly one row in the table', () => {
  const missing = emittedReasons().filter((code) => !stateOfReason(code))
  assert.deepEqual(missing, [], `add these reasons to schedule-state.mjs: ${missing.join(', ')}`)
})

test('risk-audit and request-level codes never change the slot state', () => {
  const stateless = [
    ErrorCode.DISTILL_BLOCKED,
    ErrorCode.REFUSAL_GUARD,
    ErrorCode.POLICY_BLOCKED,
    'content_filter_refusal',
    'content_policy_refusal',
    'usage_policy_refusal',
    'invalid_request',
    'entitlement_required',
    'signature_repairable',
    'http_404',
    'wrap_connection_error',
    'worker_transport_failure',
    'worker_timeout',
    'slot_busy',
    'concurrency_limit',
    'model_cooldown',
  ]
  for (const code of stateless) assert.equal(stateOfReason(code)?.state, 'on', code)
})

test('deterministic failures are 不可调度, self-healing ones are 受限', () => {
  for (const code of [
    'no_credential',
    'oauth_revoked',
    'oauth_invalid_grant',
    'oauth_no_refresh',
    'organization_disabled',
    'proxy_required',
    'proxy_desynced',
    'runtime_start_failed',
    'circuit_escalated',
  ]) {
    assert.equal(stateOfReason(code).state, 'unschedulable', code)
  }
  for (const code of [
    'quota_5h_header',
    'quota_7d_safety',
    'account_quota_exhausted',
    'rate_limited_unknown',
    'opus_rate_limited',
    'auth_cooldown',
    'permission_denied',
    'circuit_open',
    'provider_overloaded',
    'proxy_transport_failure',
    'node_offline',
    'kernel_faulted',
    'maintenance',
    'rest_period',
  ]) {
    const row = stateOfReason(code)
    assert.equal(row.state, 'restricted', code)
    assert.equal(row.scope, 'slot', code)
  }
  assert.deepEqual(
    { ...stateOfReason('gate_7d_draining'), text: undefined },
    { state: 'restricted', scope: 'new_session', soft: true, text: undefined },
  )
  assert.equal(stateOfReason('seats_full').soft, false)
  assert.equal(stateOfReason('sessions_full').scope, 'new_session')
})

test('mutators keep the legacy trio in step', () => {
  const vm = { id: 'vm-01', status: 'running', schedulable: true }
  applyUnschedulable(vm, 'organization_disabled', { status: 403 })
  assert.equal(vm.schedulable, false)
  assert.equal(vm.schedule_disabled_reason, 'organization_disabled')
  assert.equal(vm.schedule_manual, false)
  assert.equal(vm.status, 'running')

  applyHold(vm, 'proxy_cooldown', { tag: 'p1' })
  assert.equal(vm.schedule_disabled_reason, 'organization_disabled', 'a hold never renames 不可调度')
  applyClearHold(vm, 'proxy_cooldown', { tag: 'p2' })
  assert.ok(vm.schedule_hold, 'another proxy cannot lift this hold')
  applyClearHold(vm, 'proxy_cooldown', { tag: 'p1' })
  assert.equal(vm.schedule_hold, undefined)

  applyScheduleOff(vm, true)
  assert.equal(vm.schedule_manual, true)
  assert.equal(vm.schedule_disabled_reason, 'disabled')
  assert.equal(vm.unschedulable.reason, 'organization_disabled')

  applyScheduleOff(vm, false)
  assert.equal(vm.schedulable, true, 'operator 调度开 clears 不可调度 too')
  assert.equal(vm.unschedulable, undefined)
})

test('only operator actions clear 不可调度', () => {
  const vm = { schedulable: true }
  applyUnschedulable(vm, 'oauth_revoked')
  assert.throws(() => applyClearUnschedulable(vm, { by: 'refresh' }), /not allowed/)
  assert.throws(() => applyClearUnschedulable(vm, { by: 'probe' }), /not allowed/)
  applyClearUnschedulable(vm, { by: 'credential_present' })
  assert.equal(vm.unschedulable.reason, 'oauth_revoked', 'a ticket on disk only lifts a no-ticket park')
  for (const by of CLEAR_BY.filter((name) => name !== 'credential_present')) {
    const copy = structuredClone(vm)
    applyClearUnschedulable(copy, { by })
    assert.equal(copy.schedulable, true, by)
  }
  const empty = { schedulable: true }
  applyUnschedulable(empty, 'no_credential')
  applyClearUnschedulable(empty, { by: 'credential_present' })
  assert.equal(empty.schedulable, true)
  assert.throws(() => applyUnschedulable({}, 'quota_5h_header'), /not an unschedulable reason/)
})

test('migration maps every legacy reason and is idempotent', () => {
  const cases = [
    [{ schedulable: false, schedule_manual: true, schedule_disabled_reason: 'disabled' }, 'off', null],
    [{ schedulable: false, schedule_disabled_reason: 'disabled' }, 'off', null],
    [{ schedulable: false, schedule_disabled_reason: 'stopped' }, 'off', null],
    [{ schedulable: false, schedule_manual: true, schedule_disabled_reason: 'oauth_cleared' }, 'off', null],
    [{ schedulable: false, schedule_disabled_reason: 'oauth_revoked' }, 'unschedulable', 'oauth_revoked'],
    [{ schedulable: false, schedule_disabled_reason: 'no_credential' }, 'unschedulable', 'no_credential'],
    [{ schedulable: false, schedule_disabled_reason: 'proxy_desynced' }, 'unschedulable', 'proxy_desynced'],
    [
      { schedulable: false, schedule_disabled_reason: 'slot SOCKS5 proxy is required' },
      'unschedulable',
      'proxy_required',
    ],
    [
      { schedulable: false, schedule_disabled_reason: 'docker: container exited (137)' },
      'unschedulable',
      'runtime_start_failed',
    ],
    [{ schedulable: false, schedule_disabled_reason: 'kernel_update' }, 'hold', 'maintenance'],
    [{ schedulable: false, schedule_disabled_reason: 'proxy_edit_worker_reload' }, 'hold', 'maintenance'],
    [{ schedulable: false, schedule_disabled_reason: 'egress_down|proxy=p9' }, 'hold', 'proxy_cooldown'],
    [{ schedulable: false, schedule_disabled_reason: 'quota_5h_header' }, 'on', null],
    [{ schedulable: false, schedule_disabled_reason: 'quota_refresh_failed' }, 'on', null],
    [{ schedulable: false, schedule_disabled_reason: 'something new' }, 'unschedulable', 'legacy_unknown'],
  ]
  for (const [record, state, reason] of cases) {
    const vm = { id: 'vm-x', ...record }
    assert.equal(migrateScheduleRecord(vm), true, JSON.stringify(record))
    const got = vm.schedule_off ? 'off' : vm.unschedulable ? 'unschedulable' : vm.schedule_hold ? 'hold' : 'on'
    assert.equal(got, state, JSON.stringify(record))
    assert.equal(vm.unschedulable?.reason || vm.schedule_hold?.reason || null, reason, JSON.stringify(record))
    assert.equal(vm.schedulable, state === 'on', JSON.stringify(record))
    assert.equal(migrateScheduleRecord(vm), false, 'second run is a no-op')
  }
  assert.equal(migrateScheduleRecord({ schedulable: true }), false)
  assert.deepEqual(
    pickScheduleFields({ schedulable: false, schedule_disabled_reason: 'oauth_revoked' }).unschedulable.reason,
    'oauth_revoked',
  )
})

test('resolveSlotState: off > unschedulable > restricted > on', () => {
  const now = 1_000_000
  const offAndBroken = { schedulable: false }
  applyUnschedulable(offAndBroken, 'organization_disabled')
  applyScheduleOff(offAndBroken, true)
  const off = resolveSlotState({ vm: offAndBroken, now })
  assert.equal(off.schedule_state, 'off')
  assert.equal(off.unschedulable_reason, 'organization_disabled', 'details keep the error under 调度关')

  const broken = { schedulable: true }
  applyUnschedulable(broken, 'organization_disabled', { status: 403 })
  const bad = resolveSlotState({ vm: broken, availability: { key: 'quota', reason: 'quota_5h_header' }, now })
  assert.equal(bad.schedule_state, 'unschedulable')
  assert.equal(bad.unschedulable_text, '组织禁用')
  assert.deepEqual(bad.unschedulable_detail, { status: 403 })

  const quota = resolveSlotState({
    vm: { schedulable: true },
    availability: { key: 'quota', reason: 'quota_5h_header', until: now + 60_000 },
    circuit: { state: 'open', open_until: now + 5_000 },
    seats: { used: 4, max: 4 },
    now,
  })
  assert.equal(quota.restriction_reason, 'quota_5h_header', 'quota outranks circuit and seats')
  assert.equal(quota.restriction_scope, 'slot')

  const circuit = resolveSlotState({
    vm: { schedulable: true },
    availability: { key: 'ok' },
    circuit: { state: 'open', open_until: now + 5_000 },
    seats: { used: 4, max: 4 },
    now,
  })
  assert.equal(circuit.restriction_reason, 'circuit_open')
  assert.equal(circuit.restriction_text, '熔断中')

  const drain = resolveSlotState({
    vm: { schedulable: true },
    availability: { key: 'drain', reason: 'gate_7d_draining' },
    seats: { used: 4, max: 4 },
    now,
  })
  assert.equal(drain.restriction_reason, 'gate_7d_draining')
  assert.equal(drain.restriction_scope, 'new_session')
  assert.equal(drain.restriction_soft, true)

  const seats = resolveSlotState({ vm: { schedulable: true }, availability: { key: 'ok' }, seats: { used: 4, max: 4 } })
  assert.equal(seats.schedule_state, 'restricted')
  assert.equal(seats.restriction_reason, 'seats_full')
  assert.equal(seats.restriction_scope, 'new_session')
  assert.equal(seats.restriction_soft, false)

  const sessions = resolveSlotState({ vm: { schedulable: true }, sessions: { active: 3, max: 3 } })
  assert.equal(sessions.restriction_reason, 'sessions_full')
  assert.equal(resolveSlotState({ vm: { schedulable: true }, sessions: { active: 3, max: 0 } }).schedule_state, 'on')

  const held = { schedulable: true }
  applyHold(held, 'maintenance', { tag: 'kernel_update' })
  assert.equal(resolveSlotState({ vm: held, availability: { key: 'off' } }).restriction_text, '维护中')

  const dead = resolveSlotState({ vm: { schedulable: true }, availability: { key: 'bad', reason: 'oauth_revoked' } })
  assert.equal(dead.schedule_state, 'unschedulable')
  assert.equal(dead.unschedulable_reason, 'oauth_revoked')
  assert.equal(resolveSlotState({ vm: { schedulable: true }, availability: { key: 'ok' } }).schedule_state, 'on')
})

test('resolveSlotState reads records written before the migration', () => {
  assert.equal(
    resolveSlotState({ vm: { schedulable: false, schedule_disabled_reason: 'oauth_revoked' } }).schedule_state,
    'unschedulable',
  )
  assert.equal(
    resolveSlotState({ vm: { schedulable: false, schedule_manual: true, schedule_disabled_reason: 'disabled' } })
      .schedule_state,
    'off',
  )
  const leftover = resolveSlotState({
    vm: { schedulable: false, schedule_disabled_reason: 'quota_5h_header' },
    availability: { key: 'quota', reason: 'quota_5h_header' },
  })
  assert.equal(leftover.schedule_state, 'restricted')
})
