import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  pickCodexSlots,
  isCodexSlotParked,
  isCodexFailoverError,
  evaluateCodexQuotaSchedule,
  codexSlotAllowsModel,
  codexScheduleLevel,
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

test('expired GPT access is ready only while a refresh token exists', () => {
  const now = Date.parse('2026-10-18T00:00:00.000Z')
  const expired = Math.floor((now - 6 * 3600_000) / 1000)
  const dead = gpt('vm-expired', { expires_at: expired, has_refresh: false })
  const refreshable = gpt('vm-refreshable', { expires_at: expired, has_refresh: true })
  assert.deepEqual(pickCodexSlots([dead], { now }).ids, [])
  assert.deepEqual(pickCodexSlots([refreshable], { now }).ids, ['vm-refreshable'])
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
  assert.equal(isCodexFailoverError({ ok: false, status: 500, body: { error: { code: 'server_error' } } }), true)
  assert.equal(isCodexFailoverError({ ok: false, status: 502, body: { error: { code: 'provider_error' } } }), true)
  assert.equal(
    isCodexFailoverError({ ok: false, status: 400, body: { error: { code: 'invalid_request_error' } } }),
    false,
  )
  assert.equal(isCodexFailoverError({ ok: false, transportError: true, status: 0 }), true)
  assert.equal(isCodexFailoverError({ ok: false, status: 429, committed: true }), false)
  assert.equal(isCodexFailoverError({ ok: false, status: 502, body: { error: { code: 'upstream_transport' } } }), true)
  assert.equal(
    isCodexFailoverError({
      ok: false,
      status: 403,
      body: { error: { code: 'content_policy_violation', message: 'blocked' } },
    }),
    false,
  )
  assert.equal(
    isCodexFailoverError({
      ok: false,
      status: 401,
      body: { error: { code: 'invalid_request', message: 'token expired' } },
    }),
    true,
  )
  assert.equal(
    isCodexFailoverError({ ok: false, status: 503, committed: false, body: { error: { code: 'server_error' } } }),
    true,
  )
  assert.equal(
    isCodexFailoverError({ ok: false, status: 503, committed: false, body: { error: { code: 'overloaded' } } }),
    true,
  )
  assert.equal(
    isCodexFailoverError({
      ok: false,
      status: 413,
      body: { error: { code: 'invalid_request', message: 'request exceeds slot memory' } },
    }),
    false,
  )
  assert.equal(
    isCodexFailoverError({ ok: false, status: 503, committed: true, body: { error: { code: 'server_error' } } }),
    false,
  )
  assert.equal(
    isCodexFailoverError({
      ok: false,
      status: 503,
      body: { error: { code: 'codex_kernel_unavailable' } },
    }),
    false,
  )
})

test('a held GPT slot records hold state until expiry for Rust telemetry', async () => {
  const rt = await import('../../src/lib/pool/openai-account-runtime.mjs')
  rt.resetOpenAIAccountRuntime()
  const now = Date.parse('2026-10-18T00:00:00.000Z')
  rt.holdOpenAIAccount('vm-failed', { until: now + 60_000, reason: 'oauth_401', now })
  assert.equal(rt.openAIAccountHold('vm-failed', now)?.reason, 'oauth_401')
  assert.equal(rt.openAIAccountHold('vm-failed', now)?.until, now + 60_000)
  assert.equal(rt.openAIAccountHold('vm-failed', now + 60_001), null)
  rt.resetOpenAIAccountRuntime()
})

test('spent 5h window evaluates to restriction, not 调度关', () => {
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
  assert.equal(ev.action, 'restrict')
  assert.equal(ev.reason, 'quota_5h_header')
  assert.equal(ev.until, now + 60_000)
})

test('open window restores leftover quota-off and keeps operator 调度关', () => {
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

test('Codex schedule level resolves manual override and 7d reset tier without legacy Node ordering', () => {
  const now = Date.parse('2026-10-18T00:00:00.000Z')
  const low = gpt('vm-low', { schedule_level_manual: 1, weight: 1, utilization_5h: 0.1 })
  const high = gpt('vm-high-a', { schedule_level_manual: 10, weight: 2, utilization_5h: 0.3 })
  assert.equal(codexScheduleLevel(low, now).level, 1)
  assert.equal(codexScheduleLevel(high, now).level, 10)
  assert.equal(pickCodexSlots([low, high], { now }).ids[0], 'vm-high-a')
})

test('panel max_concurrency on the listVms summary is enforced by runtime slot cap (#150)', async () => {
  const { tryAcquireOpenAISlot, resetOpenAIAccountRuntime } = await import(
    '../../src/lib/pool/openai-account-runtime.mjs'
  )
  resetOpenAIAccountRuntime()
  tryAcquireOpenAISlot('vm-a', { concurrency: 4 })
  tryAcquireOpenAISlot('vm-a', { concurrency: 4 })
  tryAcquireOpenAISlot('vm-a', { concurrency: 4 })
  tryAcquireOpenAISlot('vm-a', { concurrency: 4 })
  assert.equal(tryAcquireOpenAISlot('vm-a', { concurrency: 4 }), null)
  resetOpenAIAccountRuntime()
})

test('panel max_rpm caps starts per minute on a GPT slot', async () => {
  const { tryAcquireOpenAISlot, resetOpenAIAccountRuntime } = await import(
    '../../src/lib/pool/openai-account-runtime.mjs'
  )
  resetOpenAIAccountRuntime()
  const now = Date.parse('2026-09-27T00:00:00.000Z')
  for (let i = 0; i < 2; i++) tryAcquireOpenAISlot('vm-a', { concurrency: 2, maxRpm: 2, now }).release()
  assert.equal(tryAcquireOpenAISlot('vm-a', { concurrency: 2, maxRpm: 2, now: now + 1000 }), null)
  const reopened = tryAcquireOpenAISlot('vm-a', { concurrency: 2, maxRpm: 2, now: now + 61_000 })
  assert.ok(reopened)
  reopened.release()
  resetOpenAIAccountRuntime()
})

test('panel allowed_models keeps a GPT slot out of other models', () => {
  const restricted = gpt('vm-a', { allowed_models: ['gpt-5.5'] })
  const unrestricted = gpt('vm-b')
  assert.equal(codexSlotAllowsModel(restricted, 'gpt-5.4'), false)
  assert.equal(codexSlotAllowsModel(restricted, 'gpt-5.5'), true)
  assert.equal(codexSlotAllowsModel(unrestricted, 'gpt-5.4'), true)
})

test('GPT wait queue wakes FIFO on release and caps at 100 waiters', async () => {
  const rt = await import('../../src/lib/pool/openai-account-runtime.mjs')
  rt.resetOpenAIAccountRuntime()
  assert.equal(rt.OPENAI_MAX_WAITERS, 100)
  const deadline = Date.now() + 5000
  const order = []
  const first = rt.waitForOpenAICapacity({ deadline }).then((r) => order.push(['a', r.woken]))
  const second = rt.waitForOpenAICapacity({ deadline }).then((r) => order.push(['b', r.woken]))
  const lease = rt.tryAcquireOpenAISlot('vm-a')
  lease.release()
  await first
  assert.deepEqual(order, [['a', true]])
  lease.release()
  rt.tryAcquireOpenAISlot('vm-a').release()
  await second
  assert.deepEqual(order, [
    ['a', true],
    ['b', true],
  ])
  const parked = Array.from({ length: 100 }, () => rt.waitForOpenAICapacity({ deadline }))
  assert.equal(rt.openAIWaiterCount(), 100)
  await assert.rejects(rt.waitForOpenAICapacity({ deadline }), { code: 'pool_wait_queue_full' })
  const ac = new AbortController()
  rt.resetOpenAIAccountRuntime()
  await Promise.all(parked)
  const aborted = rt.waitForOpenAICapacity({ deadline, signal: ac.signal })
  ac.abort()
  assert.deepEqual(await aborted, { woken: false, aborted: true })
  assert.equal(rt.openAIWaiterCount(), 0)
})

test('GPT wait queue wakes the oldest waiter for the freed account', async () => {
  const rt = await import('../../src/lib/pool/openai-account-runtime.mjs')
  rt.resetOpenAIAccountRuntime()
  const deadline = Date.now() + 5000
  const order = []
  const onlyB = rt.waitForOpenAICapacity({ deadline, accounts: ['vm-b'] }).then((r) => order.push(['b', r.accountId]))
  const onlyA = rt.waitForOpenAICapacity({ deadline, accounts: ['vm-a'] }).then((r) => order.push(['a', r.accountId]))
  rt.tryAcquireOpenAISlot('vm-a').release()
  await onlyA
  assert.deepEqual(order, [['a', 'vm-a']])
  assert.equal(rt.openAIWaiterCount(), 1)
  // No waiter takes vm-c: the release wakes nobody.
  rt.tryAcquireOpenAISlot('vm-c').release()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(rt.openAIWaiterCount(), 1)
  // An unscoped wake (routing change) still reaches the oldest waiter.
  rt.wakeOpenAIWaiter()
  await onlyB
  assert.deepEqual(order, [
    ['a', 'vm-a'],
    ['b', null],
  ])
  rt.resetOpenAIAccountRuntime()
})

test('GPT wait queue re-parks a woken waiter at the head past the cap', async () => {
  const rt = await import('../../src/lib/pool/openai-account-runtime.mjs')
  rt.resetOpenAIAccountRuntime()
  const deadline = Date.now() + 5000
  const parked = Array.from({ length: rt.OPENAI_MAX_WAITERS }, (_, i) =>
    rt.waitForOpenAICapacity({ deadline }).then((r) => ({ i, ...r })),
  )
  await assert.rejects(rt.waitForOpenAICapacity({ deadline }), { code: 'pool_wait_queue_full' })
  const again = rt
    .waitForOpenAICapacity({ deadline, accounts: ['vm-a'], front: true })
    .then((r) => ({ i: 'again', ...r }))
  assert.equal(rt.openAIWaiterCount(), rt.OPENAI_MAX_WAITERS + 1)
  rt.tryAcquireOpenAISlot('vm-a').release()
  assert.deepEqual(await again, { i: 'again', woken: true, accountId: 'vm-a' })
  rt.resetOpenAIAccountRuntime()
  await Promise.all(parked)
})

test('RPM-only capacity miss blocks until the 60s window reopens', async () => {
  const { tryAcquireOpenAISlot, resetOpenAIAccountRuntime } = await import(
    '../../src/lib/pool/openai-account-runtime.mjs'
  )
  resetOpenAIAccountRuntime()
  const now = Date.parse('2026-09-27T00:00:00.000Z')
  tryAcquireOpenAISlot('vm-a', { concurrency: 1, maxRpm: 1, now }).release()
  assert.equal(tryAcquireOpenAISlot('vm-a', { concurrency: 1, maxRpm: 1, now: now + 1000 }), null)
  const reopened = tryAcquireOpenAISlot('vm-a', { concurrency: 1, maxRpm: 1, now: now + 60_000 })
  assert.ok(reopened)
  reopened.release()
  resetOpenAIAccountRuntime()
})

test('a slot inside its rest window is neither ready nor parked', () => {
  const now = Date.parse('2026-09-17T12:00:00.000Z')
  const resting = gpt('vm-rest', {
    timezone: 'UTC',
    policy: { active_hours: { start: '20:00', end: '08:00', timezone: 'UTC' } },
  })
  const picked = pickCodexSlots([resting, gpt('vm-on')], { now })
  assert.deepEqual(picked.ready, ['vm-on'])
  assert.deepEqual(picked.parked, [])
  assert.deepEqual(picked.ids, ['vm-on'])
})

test('an all-rest pool reports pool_resting with the first window open', () => {
  const now = Date.parse('2026-09-17T12:00:00.000Z')
  const resting = gpt('vm-rest', {
    policy: { active_hours: { start: '20:00', end: '08:00', timezone: 'UTC' } },
  })
  const picked = pickCodexSlots([resting], { now })
  assert.equal(picked.error, 'pool_resting')
  assert.equal(picked.retryAt, Date.parse('2026-09-17T20:00:00.000Z'))
  assert.deepEqual(picked.ids, [])
})

test('a resting slot that cannot serve the model promises no wake time', () => {
  const now = Date.parse('2026-09-17T12:00:00.000Z')
  const resting = gpt('vm-rest', {
    policy: { allowed_models: ['gpt-other'], active_hours: { start: '20:00', end: '08:00', timezone: 'UTC' } },
  })
  assert.equal(pickCodexSlots([resting], { now, model: 'gpt-test' }).error, 'no_codex_vm')
})

test('a resting home is skipped in pickCodexSlots until its active window opens', () => {
  const now = Date.parse('2026-09-17T12:00:00.000Z')
  const home = gpt('vm-home', {
    policy: { active_hours: { start: '20:00', end: '08:00', timezone: 'UTC' } },
  })
  const other = pickCodexSlots([home, gpt('vm-on')], { now })
  assert.deepEqual(other.ids, ['vm-on'])
  const alone = pickCodexSlots([home], { now })
  assert.equal(alone.error, 'pool_resting')
  assert.equal(alone.retryAt, Date.parse('2026-09-17T20:00:00.000Z'))
})

test('a pin still reaches a resting GPT slot', () => {
  const now = Date.parse('2026-09-17T12:00:00.000Z')
  const resting = gpt('vm-rest', {
    policy: { active_hours: { start: '20:00', end: '08:00', timezone: 'UTC' } },
  })
  const picked = pickCodexSlots([resting], { pin: 'vm-rest', now })
  assert.deepEqual(picked.ids, ['vm-rest'])
})

test('a listVms summary (top-level active_hours) is gated too', () => {
  const now = Date.parse('2026-09-17T12:00:00.000Z')
  const resting = gpt('vm-rest', {
    timezone: 'UTC',
    active_hours: { start: '20:00', end: '08:00', timezone: 'UTC' },
  })
  const picked = pickCodexSlots([resting, gpt('vm-on')], { now })
  assert.deepEqual(picked.ids, ['vm-on'])
})

test('24h window + 0-minute record: local 5h/7d gate stays open while 100% 24h cap parks and restricts (#1744)', async () => {
  const { codexQuotaWindowReason, evaluateCodexQuotaSchedule } = await import('../../src/lib/pool/codex-slot-pool.mjs')
  const { buildCodexUsageView } = await import('../../src/lib/protocol/codex-usage.mjs')
  const { evaluateOpenAIQuotaGate } = await import('../../src/lib/pool/openai-quota-policy.mjs')
  const { isQuotaWindowReason } = await import('../../src/lib/pool/availability.mjs')
  const { stateOfReason } = await import('../../src/lib/pool/schedule-state.mjs')
  const now = Date.parse('2026-11-24T12:00:00.000Z')
  const resetAt = new Date(now + 4 * 3600_000).toISOString()

  const healthyExtra = {
    codex_primary_window_minutes: 1440,
    codex_primary_used_percent: 92,
    codex_primary_reset_at: resetAt,
    codex_secondary_window_minutes: 0,
    codex_secondary_used_percent: 0,
    // Stale misclassified aliases from older builds must not trigger 7d local gate.
    codex_5h_window_minutes: 0,
    codex_5h_used_percent: 0,
    codex_7d_window_minutes: 1440,
    codex_7d_used_percent: 92,
  }
  const healthyVm = {
    id: 'vm-24h-a',
    platform: 'openai',
    family: 'codex',
    status: 'running',
    schedulable: true,
    has_token: true,
    codex: { extra: healthyExtra, usage: buildCodexUsageView(healthyExtra) },
    codex_usage: buildCodexUsageView(healthyExtra),
  }
  assert.equal(evaluateOpenAIQuotaGate(healthyVm, { limit_5h: 0.8, limit_7d: 0.8 }, now).limited, false)
  assert.equal(isCodexSlotParked(healthyVm, now, { limit_5h: 0.8, limit_7d: 0.8 }), false)
  assert.equal(codexQuotaWindowReason(healthyVm, now), null)

  // Summary-only VM (no codex.extra) with 100% 24h cap must still park with quota_24h_header.
  const cappedExtra = {
    codex_primary_window_minutes: 1440,
    codex_primary_used_percent: 100,
    codex_primary_reset_at: resetAt,
    codex_secondary_window_minutes: 0,
    codex_secondary_used_percent: 0,
  }
  const cappedSummaryVm = {
    id: 'vm-24h-capped',
    platform: 'openai',
    family: 'codex',
    status: 'running',
    schedulable: true,
    has_token: true,
    codex_usage: buildCodexUsageView(cappedExtra),
  }
  assert.equal(isCodexSlotParked(cappedSummaryVm, now), true)
  assert.equal(codexQuotaWindowReason(cappedSummaryVm, now), 'quota_24h_header')
  assert.equal(isQuotaWindowReason('quota_24h_header'), true)
  assert.equal(stateOfReason('quota_24h_header')?.text, '24h 限制')

  const sched = evaluateCodexQuotaSchedule(cappedSummaryVm, now)
  assert.equal(sched.action, 'restrict')
  assert.equal(sched.reason, 'quota_24h_header')
  assert.equal(sched.until, Date.parse(resetAt))

  // Summary-only VM without snapshot or window_minutes still infers 24h from window id.
  const windowsOnlyVm = {
    id: 'vm-24h-windows-only',
    platform: 'openai',
    family: 'codex',
    status: 'running',
    schedulable: true,
    has_token: true,
    codex_usage: {
      windows: [{ id: '24h', used_percent: 100, reset_at: resetAt }],
    },
  }
  assert.equal(isCodexSlotParked(windowsOnlyVm, now), true)
  assert.equal(codexQuotaWindowReason(windowsOnlyVm, now), 'quota_24h_header')

  // Stress sorting compares actual 24h utilization across 24h-only summary VMs.
  const low24h = {
    id: 'vm-24h-low',
    platform: 'openai',
    family: 'codex',
    status: 'running',
    schedulable: true,
    has_token: true,
    codex_usage: buildCodexUsageView({
      codex_primary_window_minutes: 1440,
      codex_primary_used_percent: 10,
      codex_secondary_window_minutes: 0,
      codex_secondary_used_percent: 0,
    }),
  }
  const high24h = {
    id: 'vm-24h-high',
    platform: 'openai',
    family: 'codex',
    status: 'running',
    schedulable: true,
    has_token: true,
    codex_usage: buildCodexUsageView({
      codex_primary_window_minutes: 1440,
      codex_primary_used_percent: 80,
      codex_secondary_window_minutes: 0,
      codex_secondary_used_percent: 0,
    }),
  }
  const picked = pickCodexSlots([high24h, low24h, cappedSummaryVm], { now })
  assert.deepEqual(picked.ready, ['vm-24h-low', 'vm-24h-high'])
  assert.deepEqual(picked.parked, ['vm-24h-capped'])
})
