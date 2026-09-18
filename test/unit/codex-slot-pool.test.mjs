import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  pickCodexSlots,
  isCodexSlotParked,
  isCodexFailoverError,
  evaluateCodexQuotaSchedule,
} from '../../src/lib/pool/codex-slot-pool.mjs'

function gpt(id, patch = {}) {
  return {
    id,
    platform: 'openai',
    family: 'codex',
    has_token: true,
    schedulable: true,
    status: 'running',
    ...patch,
  }
}

test('ready slots sort by remaining 5h/7d stress', () => {
  const picked = pickCodexSlots([
    gpt('vm-b', { utilization_5h: 0.9, utilization_7d: 0.1 }),
    gpt('vm-a', { utilization_5h: 0.1, utilization_7d: 0.2 }),
    { id: 'vm-claude', platform: 'anthropic', family: 'claude', has_token: true, schedulable: true },
  ])
  assert.deepEqual(picked.ids, ['vm-a', 'vm-b'])
  assert.equal(picked.error, undefined)
})

test('parked slots come after ready ones', () => {
  const now = Date.parse('2026-09-17T00:00:00.000Z')
  const picked = pickCodexSlots(
    [
      gpt('vm-spent', {
        utilization_5h: 1,
        reset_5h: new Date(now + 60_000).toISOString(),
        codex_limited_until: new Date(now + 60_000).toISOString(),
      }),
      gpt('vm-ok', { utilization_5h: 0.2 }),
    ],
    { now },
  )
  assert.deepEqual(picked.ready, ['vm-ok'])
  assert.deepEqual(picked.parked, ['vm-spent'])
  assert.deepEqual(picked.ids, ['vm-ok', 'vm-spent'])
})

test('master pin stays on that GPT slot', () => {
  const picked = pickCodexSlots([gpt('vm-a'), gpt('vm-b')], { pin: 'vm-b' })
  assert.deepEqual(picked.ids, ['vm-b'])
  assert.equal(picked.pin, 'vm-b')
})

test('pin on a Claude slot is platform_mismatch', () => {
  const picked = pickCodexSlots([{ id: 'vm-claude', platform: 'anthropic', family: 'claude', has_token: true }], {
    pin: 'vm-claude',
  })
  assert.equal(picked.error, 'platform_mismatch')
  assert.deepEqual(picked.ids, [])
})

test('empty GPT inventory is no_codex_vm', () => {
  const picked = pickCodexSlots([{ id: 'vm-claude', platform: 'anthropic', family: 'claude', has_token: true }])
  assert.equal(picked.error, 'no_codex_vm')
})

test('capped 5h window parks the slot', () => {
  const now = Date.parse('2026-09-17T00:00:00.000Z')
  assert.equal(
    isCodexSlotParked(
      gpt('vm-x', {
        utilization_5h: 1,
        reset_5h: new Date(now + 10_000).toISOString(),
        codex_usage: {
          windows: [{ id: '5h', used_percent: 100, reset_at: new Date(now + 10_000).toISOString() }],
        },
      }),
      now,
    ),
    true,
  )
})

test('429 and usage_limit_reached fail over; committed hops do not', () => {
  assert.equal(isCodexFailoverError({ ok: false, status: 429, committed: false }), true)
  assert.equal(isCodexFailoverError({ ok: false, status: 502, body: { error: { code: 'usage_limit_reached' } } }), true)
  assert.equal(isCodexFailoverError({ ok: false, status: 429, committed: true }), false)
  assert.equal(isCodexFailoverError({ ok: false, status: 502, body: { error: { code: 'upstream_transport' } } }), false)
})

test('spent 5h window evaluates to 调度关', () => {
  const now = Date.parse('2026-09-17T00:00:00.000Z')
  const ev = evaluateCodexQuotaSchedule(
    gpt('vm-x', {
      utilization_5h: 1,
      reset_5h: new Date(now + 60_000).toISOString(),
      codex_usage: {
        windows: [{ id: '5h', used_percent: 100, reset_at: new Date(now + 60_000).toISOString(), window_minutes: 300 }],
      },
    }),
    now,
  )
  assert.equal(ev.action, 'disable')
  assert.equal(ev.reason, 'quota_5h_header')
})

test('open window restores only quota 调度关', () => {
  const now = Date.parse('2026-09-17T00:00:00.000Z')
  const restore = evaluateCodexQuotaSchedule(
    gpt('vm-x', {
      schedulable: false,
      schedule_disabled_reason: 'quota_5h_header',
      utilization_5h: 0.2,
      reset_5h: new Date(now + 60_000).toISOString(),
      codex_usage: {
        windows: [{ id: '5h', used_percent: 20, reset_at: new Date(now + 60_000).toISOString(), window_minutes: 300 }],
      },
    }),
    now,
  )
  assert.equal(restore.action, 'enable')
  const keep = evaluateCodexQuotaSchedule(
    gpt('vm-x', {
      schedulable: false,
      schedule_disabled_reason: 'disabled',
      utilization_5h: 0.2,
    }),
    now,
  )
  assert.equal(keep.action, 'keep')
})

test('elapsed 5h reset is not a live park', () => {
  const now = Date.parse('2026-09-17T00:00:00.000Z')
  assert.equal(
    isCodexSlotParked(
      gpt('vm-x', {
        utilization_5h: 1,
        reset_5h: new Date(now - 1000).toISOString(),
        codex_usage: {
          windows: [{ id: '5h', used_percent: 100, reset_at: new Date(now - 1000).toISOString(), window_minutes: 300 }],
        },
      }),
      now,
    ),
    false,
  )
})
