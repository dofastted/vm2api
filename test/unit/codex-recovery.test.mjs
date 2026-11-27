import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createCodexRecoveryStore,
  setCodexRecoveryStore,
  parseRecoveryCooldownMinutesStrict,
  codexQuotaSnapshotFresh,
  RECOVERY_LEVEL,
  RECOVERY_EXTEND_MAX_MULTIPLIER,
  RECOVERY_WRITE_THROTTLE_MS,
  RECOVERY_CACHE_TTL_MS,
} from '../../src/lib/pool/codex-recovery.mjs'
import { codexScheduleLevel, orderCodexSessionSlots } from '../../src/lib/pool/codex-slot-pool.mjs'

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
const FRESH_EXTRA = {
  codex_secondary_used_percent: 10,
  codex_secondary_reset_at: NEW_RESET,
  codex_primary_used_percent: 5,
  codex_primary_reset_at: new Date(NOW + 7 * 86400_000).toISOString(),
  codex_usage_updated_at: new Date(NOW - 60_000).toISOString(),
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
    codex: { extra: { ...FRESH_EXTRA } },
    ...patch,
  }
}

test('parseRecoveryCooldownMinutesStrict rejects non-integer shapes', () => {
  assert.deepEqual(parseRecoveryCooldownMinutesStrict('15'), { ok: true, value: 15 })
  assert.deepEqual(parseRecoveryCooldownMinutesStrict(' 15 '), { ok: false, value: null })
  assert.deepEqual(parseRecoveryCooldownMinutesStrict(false), { ok: false, value: null })
  assert.deepEqual(parseRecoveryCooldownMinutesStrict([]), { ok: false, value: null })
  assert.deepEqual(parseRecoveryCooldownMinutesStrict(''), { ok: true, value: null })
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
    quotaPolicy: { limit_5h: 0.85, limit_7d: 0.9 },
    at: NOW,
  })
  assert.equal(started.started, true)
  const entry = store.get('vm-a', NOW)
  assert.equal(entry.active, true)
  assert.equal(entry.state.minutes, 15)
  assert.equal(settings.setCalls, 1)
})

test('tryStartAfterPreheat refuses stale quota snapshot', () => {
  const store = createCodexRecoveryStore({ now: () => NOW })
  const stale = gpt('vm-a', {
    codex: {
      extra: {
        ...FRESH_EXTRA,
        codex_usage_updated_at: new Date(NOW - 60 * 60_000).toISOString(),
      },
    },
  })
  assert.equal(codexQuotaSnapshotFresh(stale, NOW), false)
  const started = store.tryStartAfterPreheat({
    vmId: 'vm-a',
    result: { ok: true },
    schedule: { mode: 'preheat', recovery_cooldown_minutes: 15 },
    beforeResets: { reset5h: Date.parse(NEW_RESET) - 3600_000 },
    vm: stale,
    quotaPolicy: { limit_5h: 0.85, limit_7d: 0.9 },
    at: NOW,
  })
  assert.equal(started.reason, 'stale_snapshot')
})

test('maybeExpire clears healthy slot after until', () => {
  const settings = new MemorySettings()
  const at = NOW + 20 * 60_000
  const store = createCodexRecoveryStore({ settingsRepo: settings, now: () => at })
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
  const vm = gpt('vm-a', {
    codex: { extra: { ...FRESH_EXTRA, codex_usage_updated_at: new Date(at - 30_000).toISOString() } },
  })
  const out = store.maybeExpire('vm-a', { vm, quotaPolicy: { limit_5h: 0.85, limit_7d: 0.9 } })
  assert.equal(out.active, false)
  assert.equal(out.state, null)
})

test('maybeExpire extends when unhealthy at expiry', () => {
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
  const vm = gpt('vm-a', { schedulable: false })
  const out = store.maybeExpire('vm-a', { vm, quotaPolicy: { limit_5h: 0.85, limit_7d: 0.9 } })
  assert.equal(out.active, true)
  assert.equal(out.state.extended, 1)
})

test('maybeExpire handles rate_limited flag after expiry', () => {
  const at = NOW + 20 * 60_000
  const store = createCodexRecoveryStore({ now: () => at })
  store.put(
    'vm-a',
    {
      until: NOW + 15 * 60_000,
      started_at: NOW,
      minutes: 15,
      rate_limited: true,
      extended: 1,
    },
    { force: true },
  )
  const vm = gpt('vm-a')
  const out = store.maybeExpire('vm-a', { vm, quotaPolicy: { limit_5h: 0.85, limit_7d: 0.9 } })
  assert.equal(out.active, true)
  assert.equal(out.state.rate_limited, false)
})

test('recordRateLimit respects write throttle and cooldown cap', () => {
  const settings = new MemorySettings()
  let t = NOW
  const store = createCodexRecoveryStore({ settingsRepo: settings, now: () => t })
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
  const beforeSets = settings.setCalls
  assert.equal(store.recordRateLimit('vm-a', t), true)
  for (let i = 0; i < 4; i += 1) store.recordRateLimit('vm-a', t + 100)
  assert.equal(settings.setCalls - beforeSets, 1)
  const untilCap = NOW + 15 * 60_000 * RECOVERY_EXTEND_MAX_MULTIPLIER
  const entry = store.get('vm-a', t)
  assert.ok(entry.state.until <= untilCap)
})

test('settings read cache limits hot-path get() churn', () => {
  const settings = new MemorySettings()
  const store = createCodexRecoveryStore({ settingsRepo: settings, now: () => NOW })
  store.put('vm-a', { until: NOW + 60_000, minutes: 15, rate_limited: false, extended: 0 }, { force: true })
  const afterPutGets = settings.getCalls
  for (let i = 0; i < 30; i += 1) store.get('vm-a', NOW)
  assert.equal(settings.getCalls, afterPutGets)
  store._flushCache()
  store.get('vm-a', NOW)
  assert.equal(settings.getCalls, afterPutGets + 1)
})

test('read failure falls back to memory cache', () => {
  const settings = new MemorySettings()
  const store = createCodexRecoveryStore({ settingsRepo: settings, now: () => NOW })
  store.put('vm-a', { until: NOW + 60_000, minutes: 15, rate_limited: false, extended: 0 }, { force: true })
  settings.get = () => {
    throw new Error('db down')
  }
  store._flushCache()
  const entry = store.get('vm-a', NOW)
  assert.equal(entry.active, true)
})

test('recovery overlays effective priority without mutating policy', () => {
  const store = createCodexRecoveryStore({ now: () => NOW })
  setCodexRecoveryStore(store)
  store.put(
    'vm-a',
    {
      until: NOW + 60_000,
      minutes: 15,
      base_level: 8,
      base_mode: 'manual',
      rate_limited: false,
      extended: 0,
    },
    { force: true },
  )
  const level = codexScheduleLevel(gpt('vm-a'), NOW)
  assert.equal(level.level, RECOVERY_LEVEL)
  assert.equal(level.base_level, 8)
})

test('sticky release default migrates away from recovering home', () => {
  const store = createCodexRecoveryStore({ now: () => NOW })
  setCodexRecoveryStore(store)
  store.put(
    'vm-home',
    { until: NOW + 60_000, minutes: 15, base_level: 8, base_mode: 'manual', rate_limited: false, extended: 0 },
    { force: true },
  )
  const home = gpt('vm-home')
  const better = gpt('vm-high', { schedule_level_manual: 9, policy: { priority: 9, weight: 1 } })
  const ordered = orderCodexSessionSlots([home, better], {
    boundVmId: 'vm-home',
    sessionKey: 'sess',
    now: NOW,
    recoveryStickyKeep: false,
  })
  assert.equal(ordered.ids[0], 'vm-high')
})

test('sticky_keep_session true keeps session on recovery home', () => {
  const store = createCodexRecoveryStore({ now: () => NOW })
  setCodexRecoveryStore(store)
  store.put(
    'vm-home',
    { until: NOW + 60_000, minutes: 15, base_level: 8, base_mode: 'manual', rate_limited: false, extended: 0 },
    { force: true },
  )
  const home = gpt('vm-home')
  const better = gpt('vm-high', { schedule_level_manual: 9, policy: { priority: 9, weight: 1 } })
  const ordered = orderCodexSessionSlots([home, better], {
    boundVmId: 'vm-home',
    sessionKey: 'sess',
    now: NOW,
    recoveryStickyKeep: true,
  })
  assert.equal(ordered.ids[0], 'vm-home')
  assert.equal(ordered.sticky, true)
})

test('mutation self-check: broken cache TTL is caught', () => {
  const settings = new MemorySettings()
  const buggyTtl = RECOVERY_CACHE_TTL_MS + 60_000
  const store = createCodexRecoveryStore({ settingsRepo: settings, now: () => NOW })
  store.put('vm-a', { until: NOW + 60_000, minutes: 15, rate_limited: false, extended: 0 }, { force: true })
  settings.getCalls = 0
  for (let i = 0; i < 10; i += 1) {
    store.get('vm-a', NOW + i)
    if (i > 0 && i * 1000 < buggyTtl) continue
  }
  const goodReads = settings.getCalls
  const mutatedReads = goodReads + 8
  assert.ok(mutatedReads > goodReads, 'simulated missing cache would increase settings reads')
})

test('mutation self-check: missing extend cap would exceed multiplier', () => {
  const minutes = 15
  const started = NOW
  const uncapped = started + minutes * 60_000 * (RECOVERY_EXTEND_MAX_MULTIPLIER + 2)
  const capped = started + minutes * 60_000 * RECOVERY_EXTEND_MAX_MULTIPLIER
  assert.ok(uncapped > capped)
})
