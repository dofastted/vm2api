import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createCodexRecoveryStore,
  setCodexRecoveryStore,
  normalizeRecoveryCooldownMinutes,
  RECOVERY_LEVEL,
} from '../../src/lib/pool/codex-recovery.mjs'
import { codexScheduleLevel, orderCodexSessionSlots } from '../../src/lib/pool/codex-slot-pool.mjs'
import { orderOpenAIAccounts } from '../../src/lib/pool/openai-account-selector.mjs'
import { isCodexVmTestTerminalSuccess } from '../../src/lib/admin/vm-test-terminal.mjs'

class MemorySettings {
  values = new Map()
  get(key, fallback = null) {
    return this.values.has(key) ? structuredClone(this.values.get(key)) : fallback
  }
  set(key, value) {
    this.values.set(key, structuredClone(value))
    return value
  }
}

const NOW = Date.parse('2026-11-27T12:00:00.000Z')
const NEW_RESET = new Date(NOW + 5 * 3600_000).toISOString()
const OLD_RESET = new Date(NOW - 3600_000).toISOString()

function gpt(id, patch = {}) {
  return {
    id,
    platform: 'openai',
    has_token: true,
    schedulable: true,
    status: 'running',
    schedule_level_manual: 8,
    policy: { priority: 8, weight: 40 },
    ...patch,
  }
}

test('normalizeRecoveryCooldownMinutes defaults and bounds', () => {
  assert.equal(normalizeRecoveryCooldownMinutes(null), 15)
  assert.equal(normalizeRecoveryCooldownMinutes(0), 0)
  assert.equal(normalizeRecoveryCooldownMinutes(1440), 1440)
  assert.equal(normalizeRecoveryCooldownMinutes(2000), 15)
})

test('isCodexVmTestTerminalSuccess requires completed', () => {
  assert.equal(isCodexVmTestTerminalSuccess({ ok: true, stop_reason: 'completed' }), true)
  assert.equal(isCodexVmTestTerminalSuccess({ ok: true, body: { status: 'completed' } }), true)
  assert.equal(isCodexVmTestTerminalSuccess({ ok: true, stop_reason: 'incomplete' }), false)
  assert.equal(isCodexVmTestTerminalSuccess({ ok: true }), false)
})

test('recovery overlays effective priority to P1 without changing base policy', () => {
  const settings = new MemorySettings()
  const store = createCodexRecoveryStore({ settingsRepo: settings, now: () => NOW })
  setCodexRecoveryStore(store)
  store.put('vm-a', {
    until: NOW + 15 * 60_000,
    minutes: 15,
    base_level: 8,
    base_mode: 'manual',
    reset5h_at: Date.parse(NEW_RESET),
    rate_limited: false,
    extended: 0,
  })
  const vm = gpt('vm-a', {
    codex: {
      extra: {
        codex_secondary_used_percent: 10,
        codex_secondary_reset_at: NEW_RESET,
        codex_primary_used_percent: 5,
        codex_primary_reset_at: new Date(NOW + 7 * 86400_000).toISOString(),
      },
    },
  })
  const level = codexScheduleLevel(vm, NOW)
  assert.equal(level.level, RECOVERY_LEVEL)
  assert.equal(level.base_level, 8)
  assert.equal(vm.policy.priority, 8)
})

test('sticky keeps recovery home by default when a higher-P slot exists', () => {
  const settings = new MemorySettings()
  const store = createCodexRecoveryStore({ settingsRepo: settings, now: () => NOW })
  setCodexRecoveryStore(store)
  store.put('vm-home', {
    until: NOW + 60_000,
    minutes: 15,
    base_level: 8,
    base_mode: 'manual',
    rate_limited: false,
    extended: 0,
  })
  const home = gpt('vm-home', {
    schedule_level_manual: 8,
    policy: { priority: 8, weight: 40 },
    codex: {
      extra: {
        codex_secondary_used_percent: 5,
        codex_secondary_reset_at: NEW_RESET,
      },
    },
  })
  const better = gpt('vm-high', {
    schedule_level_manual: 9,
    policy: { priority: 9, weight: 1 },
    codex: {
      extra: {
        codex_secondary_used_percent: 5,
        codex_secondary_reset_at: NEW_RESET,
      },
    },
  })
  const ordered = orderCodexSessionSlots([home, better], {
    boundVmId: 'vm-home',
    sessionKey: 'sess',
    now: NOW,
    recoveryStickyKeep: true,
  })
  assert.equal(ordered.ids[0], 'vm-home')
  assert.equal(ordered.sticky, true)
})

test('sticky release migrates when routing disables keep', () => {
  const settings = new MemorySettings()
  const store = createCodexRecoveryStore({ settingsRepo: settings, now: () => NOW })
  setCodexRecoveryStore(store)
  store.put('vm-home', {
    until: NOW + 60_000,
    minutes: 15,
    base_level: 8,
    base_mode: 'manual',
    rate_limited: false,
    extended: 0,
  })
  const home = gpt('vm-home', {
    codex: {
      extra: {
        codex_secondary_used_percent: 5,
        codex_secondary_reset_at: NEW_RESET,
      },
    },
  })
  const better = gpt('vm-high', {
    schedule_level_manual: 9,
    policy: { priority: 9, weight: 1 },
    codex: {
      extra: {
        codex_secondary_used_percent: 5,
        codex_secondary_reset_at: NEW_RESET,
      },
    },
  })
  const ordered = orderCodexSessionSlots([home, better], {
    boundVmId: 'vm-home',
    sessionKey: 'sess',
    now: NOW,
    recoveryStickyKeep: false,
  })
  assert.equal(ordered.ids[0], 'vm-high')
  assert.notEqual(ordered.sticky, true)
})

test('tryStartAfterPreheat skips when 5h reset did not refresh', () => {
  const settings = new MemorySettings()
  const store = createCodexRecoveryStore({ settingsRepo: settings, now: () => NOW })
  const vm = gpt('vm-a', {
    codex: {
      extra: {
        codex_secondary_used_percent: 10,
        codex_secondary_reset_at: OLD_RESET,
      },
    },
  })
  const started = store.tryStartAfterPreheat({
    projectRoot: null,
    vmId: 'vm-a',
    result: { ok: true, stop_reason: 'completed' },
    schedule: { mode: 'preheat', recovery_cooldown_minutes: 15 },
    beforeResets: { reset5h: Date.parse(OLD_RESET) },
    vm,
    at: NOW,
  })
  assert.equal(started.started, false)
})

test('recordRateLimit extends active recovery cooldown', () => {
  const settings = new MemorySettings()
  const store = createCodexRecoveryStore({ settingsRepo: settings, now: () => NOW })
  store.put('vm-a', {
    until: NOW + 60_000,
    minutes: 15,
    rate_limited: false,
    extended: 0,
  })
  store.recordRateLimit('vm-a', NOW)
  const next = store.get('vm-a', NOW)
  assert.equal(next.state.rate_limited, true)
  assert.ok(next.state.until >= NOW + 15 * 60_000)
})

test('recovery state survives store recreation (settings persistence)', () => {
  const settings = new MemorySettings()
  const store = createCodexRecoveryStore({ settingsRepo: settings, now: () => NOW })
  store.put('vm-a', { until: NOW + 60_000, minutes: 15, base_level: 8, base_mode: 'manual', rate_limited: false, extended: 0 })
  const store2 = createCodexRecoveryStore({ settingsRepo: settings, now: () => NOW })
  assert.equal(store2.get('vm-a', NOW).active, true)
})

test('pin path ignores sticky policy', () => {
  const picked = orderCodexSessionSlots(
    [gpt('vm-a', { schedule_level_manual: 1 }), gpt('vm-b', { schedule_level_manual: 10 })],
    { pin: 'vm-a', now: NOW },
  )
  assert.deepEqual(picked.ids, ['vm-a'])
})