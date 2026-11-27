import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createCodexRecoveryStore,
  setCodexRecoveryStore,
  codexRecoveryOverlay,
  parseRecoveryCooldownMinutesStrict,
  codexQuotaSnapshotFresh,
  RECOVERY_LEVEL,
  RECOVERY_EXTEND_MAX_MULTIPLIER,
  RECOVERY_MINUTES_MAX,
} from '../../src/lib/pool/codex-recovery.mjs'
import { codexScheduleLevel, pickCodexSlots } from '../../src/lib/pool/codex-slot-pool.mjs'
import { ingestCodexHop } from '../../src/lib/protocol/handle-codex.mjs'
import { normalizeCodexRouting } from '../../src/lib/protocol/codex-route.mjs'
import { VmTestScheduleRunner, VM_TEST_SCHEDULE_PREFIX } from '../../src/lib/admin/vm-test-schedule.mjs'
import { getCodexRecoveryStore } from '../../src/lib/pool/codex-recovery.mjs'

class MemorySettings {
  values = new Map()
  getCalls = 0
  setCalls = 0
  get(key, fallback = null) {
    this.getCalls += 1
    return this.values.has(key) ? structuredClone(this.values.get(key)) : fallback
  }
  set(key, value) {
    this.setCalls += 1
    this.values.set(key, structuredClone(value))
    return value
  }
}

const NOW = Date.parse('2026-11-27T12:00:00.000Z')
const NEW_RESET = new Date(NOW + 5 * 3600_000).toISOString()
const QUOTA = { limit_5h: 0.85, limit_7d: 0.9 }

function freshExtra(at = NOW) {
  return {
    codex_secondary_used_percent: 10,
    codex_secondary_reset_at: NEW_RESET,
    codex_primary_used_percent: 5,
    codex_primary_reset_at: new Date(at + 7 * 86400_000).toISOString(),
    codex_usage_updated_at: new Date(at - 30_000).toISOString(),
  }
}

function gpt(id, patch = {}) {
  return {
    id,
    platform: 'openai',
    has_token: true,
    schedulable: true,
    status: 'running',
    schedule_level_manual: 8,
    policy: { priority: 8, weight: 40 },
    codex: { extra: freshExtra() },
    ...patch,
  }
}

test('parseRecoveryCooldownMinutesStrict rejects non-integer shapes and accepts 1440', () => {
  assert.deepEqual(parseRecoveryCooldownMinutesStrict('15'), { ok: true, value: 15 })
  assert.deepEqual(parseRecoveryCooldownMinutesStrict(' 15 '), { ok: false, value: null })
  assert.deepEqual(parseRecoveryCooldownMinutesStrict(false), { ok: false, value: null })
  assert.deepEqual(parseRecoveryCooldownMinutesStrict('1440'), { ok: true, value: 1440 })
  assert.deepEqual(parseRecoveryCooldownMinutesStrict('1441'), { ok: false, value: null })
})

test('normalizeCodexRouting defaults sticky_keep_session to false', () => {
  assert.equal(normalizeCodexRouting({}).recovery.sticky_keep_session, false)
})

test('tryStartAfterPreheat happy path arms cooldown with global quota policy', () => {
  const settings = new MemorySettings()
  const store = createCodexRecoveryStore({ settingsRepo: settings, now: () => NOW })
  const vm = gpt('vm-a')
  const started = store.tryStartAfterPreheat({
    vmId: 'vm-a',
    result: { ok: true },
    schedule: { mode: 'preheat', recovery_cooldown_minutes: 15 },
    beforeResets: { reset5h: Date.parse(NEW_RESET) - 3600_000 },
    vm,
    quotaPolicy: QUOTA,
    at: NOW,
  })
  assert.equal(started.started, true)
  assert.equal(started.state.base_level, 8)
  assert.equal(settings.setCalls, 1)
})

test('tryStartAfterPreheat requires result.ok', () => {
  const store = createCodexRecoveryStore({ now: () => NOW })
  const vm = gpt('vm-a')
  const started = store.tryStartAfterPreheat({
    vmId: 'vm-a',
    result: { ok: false },
    schedule: { mode: 'preheat', recovery_cooldown_minutes: 15 },
    beforeResets: { reset5h: Date.parse(NEW_RESET) - 3600_000 },
    vm,
    quotaPolicy: QUOTA,
    at: NOW,
  })
  assert.equal(started.reason, 'not_ok')
})

test('tryStartAfterPreheat cooldown_disabled when minutes=0', () => {
  const store = createCodexRecoveryStore({ now: () => NOW })
  const out = store.tryStartAfterPreheat({
    vmId: 'vm-a',
    result: { ok: true },
    schedule: { mode: 'preheat', recovery_cooldown_minutes: 0 },
    vm: gpt('vm-a'),
    quotaPolicy: QUOTA,
    at: NOW,
    beforeResets: { reset5h: Date.parse(NEW_RESET) - 3600_000 },
  })
  assert.equal(out.reason, 'cooldown_disabled')
})

test('tryStartAfterPreheat not_preheat for test mode', () => {
  const store = createCodexRecoveryStore({ now: () => NOW })
  const out = store.tryStartAfterPreheat({
    vmId: 'vm-a',
    result: { ok: true },
    schedule: { mode: 'test', recovery_cooldown_minutes: 15 },
    vm: gpt('vm-a'),
    quotaPolicy: QUOTA,
    at: NOW,
  })
  assert.equal(out.reason, 'not_preheat')
})

test('tryStartAfterPreheat reset_not_refreshed when 5h unchanged', () => {
  const store = createCodexRecoveryStore({ now: () => NOW })
  const resetMs = Date.parse(NEW_RESET)
  const out = store.tryStartAfterPreheat({
    vmId: 'vm-a',
    result: { ok: true },
    schedule: { mode: 'preheat', recovery_cooldown_minutes: 15 },
    beforeResets: { reset5h: resetMs },
    vm: gpt('vm-a'),
    quotaPolicy: QUOTA,
    at: NOW,
  })
  assert.equal(out.reason, 'reset_not_refreshed')
})

test('tryStartAfterPreheat honors injected quotaPolicy on soft gate', () => {
  const store = createCodexRecoveryStore({ now: () => NOW })
  const vm = gpt('vm-a', {
    codex: {
      extra: {
        ...freshExtra(),
        codex_secondary_used_percent: 80,
        codex_primary_used_percent: 80,
      },
    },
  })
  const loose = { limit_5h: 0.85, limit_7d: 0.9 }
  const tight = { limit_5h: 0.7, limit_7d: 0.7 }
  const args = {
    vmId: 'vm-a',
    result: { ok: true },
    schedule: { mode: 'preheat', recovery_cooldown_minutes: 15 },
    beforeResets: { reset5h: Date.parse(NEW_RESET) - 3600_000 },
    vm,
    at: NOW,
  }
  assert.equal(store.tryStartAfterPreheat({ ...args, quotaPolicy: loose }).started, true)
  const tightResult = store.tryStartAfterPreheat({ ...args, quotaPolicy: tight })
  assert.equal(tightResult.started, false)
  assert.equal(tightResult.reason, 'above_soft_limit')
})

test('tryStartAfterPreheat above_soft_limit when over quota gate', () => {
  const store = createCodexRecoveryStore({ now: () => NOW })
  const vm = gpt('vm-a', {
    codex: {
      extra: {
        ...freshExtra(),
        codex_secondary_used_percent: 99,
        codex_primary_used_percent: 99,
      },
    },
  })
  const out = store.tryStartAfterPreheat({
    vmId: 'vm-a',
    result: { ok: true },
    schedule: { mode: 'preheat', recovery_cooldown_minutes: 15 },
    beforeResets: { reset5h: Date.parse(NEW_RESET) - 3600_000 },
    vm,
    quotaPolicy: QUOTA,
    at: NOW,
  })
  assert.equal(out.reason, 'above_soft_limit')
})

test('tryStartAfterPreheat not_schedulable when slot disabled', () => {
  const store = createCodexRecoveryStore({ now: () => NOW })
  const out = store.tryStartAfterPreheat({
    vmId: 'vm-a',
    result: { ok: true },
    schedule: { mode: 'preheat', recovery_cooldown_minutes: 15 },
    beforeResets: { reset5h: Date.parse(NEW_RESET) - 3600_000 },
    vm: gpt('vm-a', { schedulable: false }),
    quotaPolicy: QUOTA,
    at: NOW,
  })
  assert.equal(out.reason, 'not_schedulable')
})

test('tryStartAfterPreheat refuses stale quota snapshot', () => {
  const store = createCodexRecoveryStore({ now: () => NOW })
  const stale = gpt('vm-a', {
    codex: {
      extra: { ...freshExtra(NOW - 60 * 60_000), codex_usage_updated_at: new Date(NOW - 60 * 60_000).toISOString() },
    },
  })
  const started = store.tryStartAfterPreheat({
    vmId: 'vm-a',
    result: { ok: true },
    schedule: { mode: 'preheat', recovery_cooldown_minutes: 15 },
    beforeResets: { reset5h: Date.parse(NEW_RESET) - 3600_000 },
    vm: stale,
    quotaPolicy: QUOTA,
    at: NOW,
  })
  assert.equal(started.reason, 'stale_snapshot')
})

test('hot path codexScheduleLevel clears expired overlay when vm and quota provided', () => {
  const at = NOW + 20 * 60_000
  const store = createCodexRecoveryStore({ now: () => at })
  setCodexRecoveryStore(store)
  store.put(
    'vm-a',
    {
      until: NOW + 15 * 60_000,
      started_at: NOW,
      minutes: 15,
      base_level: 8,
      base_mode: 'manual',
      rate_limited: false,
      extended: 0,
    },
    { force: true },
  )
  const vm = gpt('vm-a', { codex: { extra: freshExtra(at) } })
  const level = codexScheduleLevel(vm, at, undefined, { quotaPolicy: QUOTA })
  assert.equal(level.level, 8)
  assert.equal(store.get('vm-a', at).state, null)
})

test('hot path codexRecoveryOverlay without vm on expired does not extend cooldown', () => {
  const at = NOW + 20 * 60_000
  const store = createCodexRecoveryStore({ now: () => at })
  setCodexRecoveryStore(store)
  store.put(
    'vm-a',
    {
      until: NOW + 15 * 60_000,
      started_at: NOW,
      minutes: 15,
      extended: 0,
      rate_limited: false,
    },
    { force: true },
  )
  codexRecoveryOverlay('vm-a', at, {})
  const state = store.get('vm-a', at).state
  assert.equal(state.extended, 0)
  assert.equal(store.get('vm-a', at).expired, true)
})

test('maybeExpire clears healthy slot after until', () => {
  const at = NOW + 20 * 60_000
  const store = createCodexRecoveryStore({ now: () => at })
  store.put(
    'vm-a',
    {
      until: NOW + 15 * 60_000,
      started_at: NOW,
      minutes: 15,
      rate_limited: false,
      extended: 0,
    },
    { force: true },
  )
  const out = store.maybeExpire('vm-a', { vm: gpt('vm-a', { codex: { extra: freshExtra(at) } }), quotaPolicy: QUOTA })
  assert.equal(out.active, false)
  assert.equal(out.state, null)
})

test('maybeExpire handles rate_limited branch at expiry', () => {
  const at = NOW + 20 * 60_000
  const store = createCodexRecoveryStore({ now: () => at })
  store.put(
    'vm-a',
    { until: NOW + 15 * 60_000, started_at: NOW, minutes: 15, rate_limited: true, extended: 1 },
    { force: true },
  )
  const out = store.maybeExpire('vm-a', { vm: gpt('vm-a', { codex: { extra: freshExtra(at) } }), quotaPolicy: QUOTA })
  assert.equal(out.active, true)
  assert.equal(out.state.rate_limited, false)
})

test('maybeExpire extends when unhealthy at expiry', () => {
  const at = NOW + 20 * 60_000
  const store = createCodexRecoveryStore({ now: () => at })
  store.put(
    'vm-a',
    { until: NOW + 15 * 60_000, started_at: NOW, minutes: 15, rate_limited: false, extended: 0 },
    { force: true },
  )
  const out = store.maybeExpire('vm-a', { vm: gpt('vm-a', { schedulable: false }), quotaPolicy: QUOTA })
  assert.equal(out.state.extended, 1)
})

test('recordRateLimit extends active cooldown and respects 4x cap', () => {
  const settings = new MemorySettings()
  const store = createCodexRecoveryStore({ settingsRepo: settings, now: () => NOW })
  store.put(
    'vm-a',
    { until: NOW + 15 * 60_000, started_at: NOW, minutes: 15, rate_limited: false, extended: 0 },
    { force: true },
  )
  assert.equal(store.recordRateLimit('vm-a', NOW), true)
  assert.equal(store.recordRateLimit('vm-a', NOW + 100), true)
  const hardCap = NOW + 15 * 60_000 * 4
  assert.ok(store.get('vm-a', NOW).state.until <= hardCap)
  assert.equal(RECOVERY_EXTEND_MAX_MULTIPLIER, 4)
})

test('recordRateLimit no-op when slot not in recovery', () => {
  const store = createCodexRecoveryStore({ now: () => NOW })
  assert.equal(store.recordRateLimit('missing', NOW), false)
})

test('ingestCodexHop 429 does not create recovery when slot not cooling', () => {
  const settings = new MemorySettings()
  const store = createCodexRecoveryStore({ settingsRepo: settings, now: () => NOW })
  setCodexRecoveryStore(store)
  const beforeSets = settings.setCalls
  ingestCodexHop(
    '/tmp',
    'vm-a',
    { ok: false, status: 429, body: { error: { code: 'usage_limit_reached' } }, headers: {} },
    NOW,
  )
  assert.equal(store.get('vm-a', NOW).state, null)
  assert.equal(store.recordRateLimit('vm-a', NOW), false)
  assert.equal(settings.setCalls, beforeSets)
})

test('readAll hydrates from settings when cache is cold', () => {
  const settings = new MemorySettings()
  settings.set('codex_recovery_state', {
    'vm-a': { until: NOW + 60_000, minutes: 15, rate_limited: false, extended: 0 },
  })
  const store = createCodexRecoveryStore({ settingsRepo: settings, now: () => NOW })
  assert.equal(store.get('vm-a', NOW).active, true)
  assert.ok(settings.getCalls >= 1)
})

test('recordRateLimit stops growing past four minute windows', () => {
  const store = createCodexRecoveryStore({ now: () => NOW })
  store.put(
    'vm-a',
    { until: NOW + 15 * 60_000, started_at: NOW, minutes: 15, rate_limited: false, extended: 0 },
    { force: true },
  )
  const hardCap = NOW + 15 * 60_000 * 4
  for (const stepMin of [0, 15, 30, 45, 60]) {
    const at = NOW + stepMin * 60_000
    store.recordRateLimit('vm-a', at)
    assert.ok(store.get('vm-a', at).state.until <= hardCap)
  }
  assert.equal(store.get('vm-a', NOW).state.until, hardCap)
  store.recordRateLimit('vm-a', NOW + 90 * 60_000)
  assert.equal(store.get('vm-a', NOW).state.until, hardCap)
})

test('recordRateLimit throttles duplicate 429 bumps within write window', () => {
  const store = createCodexRecoveryStore({ now: () => NOW })
  store.put(
    'vm-a',
    { until: NOW + 60_000, started_at: NOW, minutes: 15, rate_limited: false, extended: 0 },
    { force: true },
  )
  assert.equal(store.recordRateLimit('vm-a', NOW), true)
  const afterFirst = store.get('vm-a', NOW).state
  assert.equal(afterFirst.rate_limited, true)
  assert.equal(afterFirst.extended, 1)
  store.recordRateLimit('vm-a', NOW + 500)
  store.recordRateLimit('vm-a', NOW + 1000)
  const afterBurst = store.get('vm-a', NOW).state
  assert.equal(afterBurst.extended, afterFirst.extended)
  assert.equal(afterBurst.until, afterFirst.until)
})

test('settings read cache limits hot-path get() churn', () => {
  const settings = new MemorySettings()
  const store = createCodexRecoveryStore({ settingsRepo: settings, now: () => NOW })
  store.put('vm-a', { until: NOW + 60_000, minutes: 15, rate_limited: false, extended: 0 }, { force: true })
  const afterPut = settings.getCalls
  for (let i = 0; i < 30; i += 1) store.get('vm-a', NOW)
  assert.equal(settings.getCalls, afterPut)
})

test('read failure falls back to memory cache', () => {
  const settings = new MemorySettings()
  const store = createCodexRecoveryStore({ settingsRepo: settings, now: () => NOW })
  store.put('vm-a', { until: NOW + 60_000, minutes: 15, rate_limited: false, extended: 0 }, { force: true })
  settings.get = () => {
    throw new Error('db down')
  }
  store._flushCache()
  assert.equal(store.get('vm-a', NOW).active, true)
})

test('recovery overlay preserves base_level on candidate priority', () => {
  const store = createCodexRecoveryStore({ now: () => NOW })
  setCodexRecoveryStore(store)
  store.put(
    'vm-a',
    { until: NOW + 60_000, minutes: 15, base_level: 8, base_mode: 'manual', rate_limited: false, extended: 0 },
    { force: true },
  )
  const level = codexScheduleLevel(gpt('vm-a'), NOW, undefined, { quotaPolicy: QUOTA })
  assert.equal(level.level, RECOVERY_LEVEL)
  assert.equal(level.base_level, 8)
})

test('pickCodexSlots sorts by recovery overlay level not raw manual P', () => {
  const store = createCodexRecoveryStore({ now: () => NOW })
  setCodexRecoveryStore(store)
  store.put(
    'vm-hot',
    { until: NOW + 60_000, minutes: 15, base_level: 9, base_mode: 'manual', rate_limited: false, extended: 0 },
    { force: true },
  )
  const recoveringP9 = gpt('vm-hot', { schedule_level_manual: 9, policy: { priority: 9, weight: 1 } })
  const steadyP8 = gpt('vm-cool', { schedule_level_manual: 8, policy: { priority: 8, weight: 1 } })
  assert.equal(codexScheduleLevel(recoveringP9, NOW, undefined, { quotaPolicy: QUOTA }).level, RECOVERY_LEVEL)
  assert.equal(codexScheduleLevel(steadyP8, NOW, undefined, { quotaPolicy: QUOTA }).level, 8)
  const picked = pickCodexSlots([recoveringP9, steadyP8], { now: NOW, quotaPolicy: QUOTA })
  assert.deepEqual(picked.ids, ['vm-cool', 'vm-hot'])
})

test('normalizeCodexRouting sticky_keep_session true only when configured', () => {
  assert.equal(normalizeCodexRouting({ recovery: { sticky_keep_session: true } }).recovery.sticky_keep_session, true)
})

test('VmTestScheduleRunner invokes tryStartAfterPreheat on preheat ok', async () => {
  const settings = new MemorySettings()
  const store = createCodexRecoveryStore({ settingsRepo: settings, now: () => NOW })
  let tries = 0
  const original = store.tryStartAfterPreheat.bind(store)
  store.tryStartAfterPreheat = (...args) => {
    tries += 1
    return original(...args)
  }
  settings.set(`${VM_TEST_SCHEDULE_PREFIX}vm-codex`, {
    enabled: true,
    mode: 'preheat',
    frequency: 'daily',
    time: '09:00',
    timezone: 'Asia/Shanghai',
    cron: '0 9 * * *',
    model: 'gpt-5-codex',
    prompt: 'ping',
    max_tokens: null,
    reasoning_effort: 'medium',
    recovery_cooldown_minutes: 15,
  })
  const vm = gpt('vm-codex')
  const schedule = new VmTestScheduleRunner({
    projectRoot: '/missing',
    settings: () => settings,
    list: () => [vm],
    codexRecovery: store,
    quotaPolicy: QUOTA,
    runTest: async () => ({ ok: true }),
    windowState: () => ({ hasCredential: true, schedulable: true, windowLive: false }),
    now: () => NOW,
  })
  schedule.start()
  await schedule._run('vm-codex')
  schedule.stop()
  assert.equal(tries, 1)
})

test('VmTestScheduleRunner tryStart failure does not abort recordRun', async () => {
  const settings = new MemorySettings()
  const store = createCodexRecoveryStore({ settingsRepo: settings, now: () => NOW })
  store.tryStartAfterPreheat = () => {
    throw new Error('boom')
  }
  settings.set(`${VM_TEST_SCHEDULE_PREFIX}vm-codex`, {
    enabled: true,
    mode: 'preheat',
    frequency: 'daily',
    time: '09:00',
    timezone: 'Asia/Shanghai',
    cron: '0 9 * * *',
    model: 'gpt-5-codex',
    prompt: 'ping',
    max_tokens: null,
    reasoning_effort: 'medium',
  })
  const schedule = new VmTestScheduleRunner({
    projectRoot: '/missing',
    settings: () => settings,
    list: () => [gpt('vm-codex')],
    codexRecovery: store,
    runTest: async () => ({ ok: true }),
    windowState: () => ({ hasCredential: true, schedulable: true, windowLive: false }),
    now: () => NOW,
  })
  schedule.start()
  await schedule._run('vm-codex')
  schedule.stop()
  const saved = settings.get(`${VM_TEST_SCHEDULE_PREFIX}vm-codex`)
  assert.equal(saved.last_ok, true)
})

test('ingestCodexHop records recovery rate limit on usage_limit 429', () => {
  const store = createCodexRecoveryStore({ now: () => NOW })
  setCodexRecoveryStore(store)
  store.put(
    'vm-a',
    { until: NOW + 60_000, started_at: NOW, minutes: 15, rate_limited: false, extended: 0 },
    { force: true },
  )
  ingestCodexHop(
    '/tmp',
    'vm-a',
    { ok: false, status: 429, body: { error: { code: 'usage_limit_reached' } }, headers: {} },
    NOW,
  )
  assert.equal(store.get('vm-a', NOW).state.rate_limited, true)
})
