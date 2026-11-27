import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  mergeVmTestSchedulePreserve,
  VM_TEST_RENEW_CLAIM_PREFIX,
  VM_TEST_SCHEDULE_PREFIX,
  VmTestScheduleRunner,
} from '../../src/lib/admin/vm-test-schedule.mjs'
import {
  fiveHourWindowFromCodexVm,
  preheatNextWindowEnd,
  preheatOpenAIQuotaPolicy,
  preheatRenewEpisodeKey,
  preheatWindowState,
  preheatWindowStateForVm,
  preheatWindowStateLikeServer,
  resolvePreheatFiveHourWindow,
  truncateResetSec,
} from '../../src/lib/admin/vm-test-preheat-window.mjs'
import { OPENAI_QUOTA_DEFAULTS } from '../../src/lib/pool/openai-quota-policy.mjs'
import { parseResetMs } from '../../src/lib/pool/quota-window.mjs'

const FIXED_NOW = Date.parse('2026-10-01T12:00:00.000Z')
const RESET_FUTURE_MS = FIXED_NOW + 6 * 3600_000
const RESET_EXPIRED_MS = FIXED_NOW - 3600_000

function codexVmWithReset(resetAt) {
  return {
    id: 'vm-codex',
    platform: 'openai',
    codex: {
      has_access: true,
      extra: {
        codex_secondary_used_percent: 42,
        codex_secondary_window_minutes: 300,
        codex_secondary_reset_at: resetAt,
        codex_primary_used_percent: 12,
        codex_primary_window_minutes: 10080,
        codex_primary_reset_at: new Date(FIXED_NOW + 7 * 24 * 3600_000).toISOString(),
      },
    },
  }
}

const codexVm = codexVmWithReset(new Date(RESET_FUTURE_MS).toISOString())

class MemorySettings {
  values = new Map()
  get(key, fallback = null) {
    return this.values.has(key) ? structuredClone(this.values.get(key)) : fallback
  }
  set(key, value) {
    this.values.set(key, structuredClone(value))
    return value
  }
  remove(key) {
    this.values.delete(key)
  }
  all() {
    return Object.fromEntries([...this.values].map(([key, value]) => [key, structuredClone(value)]))
  }
}

const panelSaveBody = {
  enabled: true,
  frequency: 'daily',
  time: '09:00',
  timezone: 'Asia/Shanghai',
  model: 'gpt-5-codex',
  prompt: 'ping',
  reasoning_effort: 'medium',
}

test('mergeVmTestSchedulePreserve keeps preheat mode when the save body omits it', () => {
  const merged = mergeVmTestSchedulePreserve(panelSaveBody, {
    mode: 'preheat',
    auto_renew: true,
  })
  assert.equal(merged.mode, 'preheat')
  assert.equal(merged.auto_renew, true)
  const explicit = mergeVmTestSchedulePreserve(
    { ...panelSaveBody, mode: 'test' },
    { mode: 'preheat', auto_renew: true },
  )
  assert.equal(explicit.mode, 'test')
  assert.equal(explicit.auto_renew, undefined)
})

test('VmTestScheduleRunner.save preserves preheat fields from the panel payload', () => {
  const settings = new MemorySettings()
  settings.set(`${VM_TEST_SCHEDULE_PREFIX}vm-codex`, {
    enabled: true,
    mode: 'preheat',
    auto_renew: true,
    frequency: 'daily',
    time: '09:00',
    timezone: 'Asia/Shanghai',
    cron: '0 9 * * *',
    model: 'gpt-5-codex',
    prompt: 'old',
    max_tokens: null,
    reasoning_effort: 'medium',
  })
  const schedule = new VmTestScheduleRunner({
    projectRoot: '/missing',
    settings: () => settings,
    list: () => [codexVm],
    runTest: async () => ({ ok: true }),
  })
  schedule.save('vm-codex', { ...panelSaveBody, prompt: 'new prompt' })
  const stored = settings.get(`${VM_TEST_SCHEDULE_PREFIX}vm-codex`)
  assert.equal(stored.mode, 'preheat')
  assert.equal(stored.auto_renew, true)
  assert.equal(stored.prompt, 'new prompt')
})

test('VmTestScheduleRunner.save accepts mode=test when stored plan was preheat+auto_renew', () => {
  const settings = new MemorySettings()
  settings.set(`${VM_TEST_SCHEDULE_PREFIX}vm-codex`, {
    enabled: true,
    mode: 'preheat',
    auto_renew: true,
    frequency: 'daily',
    time: '09:00',
    timezone: 'Asia/Shanghai',
    cron: '0 9 * * *',
    model: 'gpt-5-codex',
    prompt: 'old',
    max_tokens: null,
    reasoning_effort: 'medium',
  })
  const schedule = new VmTestScheduleRunner({
    projectRoot: '/missing',
    settings: () => settings,
    list: () => [codexVm],
    runTest: async () => ({ ok: true }),
  })
  const saved = schedule.save('vm-codex', { ...panelSaveBody, mode: 'test' })
  assert.equal(saved.mode, 'test')
  assert.equal(saved.auto_renew, false)
})

test('resolvePreheatFiveHourWindow reads Codex extra instead of accountQuota.unified', () => {
  const quota = {
    snapshot: () => ({
      accounts: [{ vm_id: 'vm-codex', account_id: 'vm-codex', unified: { '5h': { utilization: 0, reset: null } } }],
    }),
  }
  const w5 = resolvePreheatFiveHourWindow(codexVm, {
    projectRoot: null,
    accountQuota: quota,
    now: FIXED_NOW,
  })
  assert.ok(w5.reset)
  assert.equal(Number(w5.utilization).toFixed(2), '0.42')
})

test('preheatNextWindowEnd returns Codex 5h reset without a Claude quota row', () => {
  const end = preheatNextWindowEnd(codexVm, {
    projectRoot: null,
    accountQuota: { snapshot: () => ({ accounts: [] }) },
    now: FIXED_NOW,
  })
  assert.equal(end, RESET_FUTURE_MS)
  const live = preheatWindowState(codexVm, {
    projectRoot: null,
    accountQuota: { snapshot: () => ({ accounts: [] }) },
    now: FIXED_NOW,
  })
  assert.equal(live.windowLive, true)
  assert.equal(live.hasCredential, true)
})

test('preheatNextWindowEnd keeps elapsed Codex reset for auto-renew sweeps', () => {
  const expiredVm = codexVmWithReset(new Date(RESET_EXPIRED_MS).toISOString())
  expiredVm.codex.extra.codex_secondary_used_percent = 100
  const end = preheatNextWindowEnd(expiredVm, {
    projectRoot: null,
    accountQuota: { snapshot: () => ({ accounts: [] }) },
    now: FIXED_NOW,
  })
  assert.equal(end, RESET_EXPIRED_MS)
  const live = preheatWindowState(expiredVm, {
    projectRoot: null,
    accountQuota: { snapshot: () => ({ accounts: [] }) },
    now: FIXED_NOW,
  })
  assert.equal(live.windowLive, false)
})

test('auto-renew sweep fires preheat when Codex 5h reset has elapsed', async () => {
  const expiredVm = codexVmWithReset(new Date(RESET_EXPIRED_MS).toISOString())
  expiredVm.codex.extra.codex_secondary_used_percent = 100
  let calls = 0
  const settings = new MemorySettings()
  settings.set(`${VM_TEST_SCHEDULE_PREFIX}vm-codex`, {
    enabled: true,
    mode: 'preheat',
    auto_renew: true,
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
    list: () => [expiredVm],
    runTest: async () => {
      calls += 1
      return { ok: true, duration_ms: 1 }
    },
    windowState: () => ({ hasCredential: true, schedulable: true, windowLive: false }),
    nextWindowEnd: (vmId) =>
      preheatNextWindowEnd(expiredVm, {
        projectRoot: null,
        accountQuota: { snapshot: () => ({ accounts: [] }) },
        now: FIXED_NOW,
      }),
    now: () => FIXED_NOW,
  })
  schedule.start()
  await schedule._sweepElapsedWindows()
  assert.equal(calls, 1)
  schedule.stop()
})

test('fiveHourWindowFromCodexVm reads vm file extra on disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-1874-'))
  const vmId = 'vm-codex-disk'
  const vmDir = path.join(root, 'vms', vmId)
  fs.mkdirSync(vmDir, { recursive: true })
  const diskReset = new Date(FIXED_NOW + 5 * 3600_000).toISOString()
  const extra = {
    codex_secondary_used_percent: 5,
    codex_secondary_window_minutes: 300,
    codex_secondary_reset_at: diskReset,
  }
  fs.writeFileSync(
    path.join(root, 'vms', `${vmId}.json`),
    JSON.stringify({ id: vmId, platform: 'openai', codex: { extra } }),
  )
  const w5 = fiveHourWindowFromCodexVm(root, { id: vmId, platform: 'openai' }, FIXED_NOW)
  assert.equal(parseResetMs(w5.reset), Date.parse(diskReset))
})

function routingWithCodexQuota(quota) {
  return { codex: { quota: { ...OPENAI_QUOTA_DEFAULTS, ...quota } } }
}

function codexExtraVm(overrides = {}) {
  return {
    id: 'vm-codex',
    platform: 'openai',
    has_token: true,
    schedulable: true,
    codex: {
      has_access: true,
      extra: {
        codex_secondary_used_percent: 20,
        codex_secondary_window_minutes: 300,
        codex_secondary_reset_at: new Date(FIXED_NOW + 3_600_000).toISOString(),
        codex_primary_used_percent: 20,
        codex_primary_window_minutes: 10080,
        codex_primary_reset_at: new Date(FIXED_NOW + 7 * 24 * 3600_000).toISOString(),
        ...overrides,
      },
    },
  }
}

test('preheatRenewEpisodeKey uses whole-second reset anchors', () => {
  const vm = codexVmWithReset(new Date(RESET_FUTURE_MS).toISOString())
  const episode = preheatRenewEpisodeKey(vm, { projectRoot: null, now: FIXED_NOW })
  assert.ok(episode?.key)
  assert.equal(episode.reset5hSec, truncateResetSec(new Date(RESET_FUTURE_MS).toISOString()))
  assert.ok(episode.reset7dSec)
})

test('preheatWindowState blocks only exhausted 5h (7d still healthy)', () => {
  const vm = codexExtraVm({
    codex_secondary_used_percent: 100,
    codex_secondary_reset_at: new Date(FIXED_NOW + 3_600_000).toISOString(),
    codex_primary_used_percent: 34,
  })
  const state = preheatWindowState(vm, { projectRoot: null, now: FIXED_NOW })
  assert.equal(state.windowLive, true)
  assert.equal(state.reason, 'quota_5h_header')
})

test('preheatWindowState blocks only exhausted 7d (5h still healthy)', () => {
  const vm = codexExtraVm({
    codex_primary_used_percent: 100,
    codex_primary_reset_at: new Date(FIXED_NOW + 5 * 24 * 3600_000).toISOString(),
    codex_secondary_used_percent: 34,
  })
  const state = preheatWindowState(vm, { projectRoot: null, now: FIXED_NOW })
  assert.equal(state.windowLive, true)
  assert.equal(state.reason, 'quota_7d_header')
})

test('preheatWindowState blocks when both 5h and 7d are capped', () => {
  const vm = codexExtraVm({
    codex_secondary_used_percent: 100,
    codex_secondary_reset_at: new Date(FIXED_NOW + 3_600_000).toISOString(),
    codex_primary_used_percent: 100,
    codex_primary_reset_at: new Date(FIXED_NOW + 5 * 24 * 3600_000).toISOString(),
  })
  const state = preheatWindowState(vm, { projectRoot: null, now: FIXED_NOW })
  assert.equal(state.windowLive, true)
  assert.match(state.reason, /^quota_(5h|7d)_header$/)
})

test('preheatWindowStateForVm skips when 7d usage exceeds configured codex.quota limit_7d but is below hard cap', () => {
  const vm = codexExtraVm({
    codex_primary_used_percent: 92,
    codex_primary_reset_at: new Date(FIXED_NOW + 5 * 24 * 3600_000).toISOString(),
    codex_secondary_used_percent: 40,
  })
  const routing = routingWithCodexQuota({ limit_7d: 0.9 })
  const state = preheatWindowStateForVm(vm, { projectRoot: null, routingConfig: routing, now: FIXED_NOW })
  assert.equal(state.windowLive, true)
  assert.equal(state.reason, 'quota_7d_local')
})

test('preheatWindowStateLikeServer reads live routingConfig.codex.quota without an explicit openaiQuotaPolicy', () => {
  const vm = codexExtraVm({
    codex_primary_used_percent: 92,
    codex_primary_reset_at: new Date(FIXED_NOW + 5 * 24 * 3600_000).toISOString(),
    codex_secondary_used_percent: 100,
    codex_secondary_reset_at: new Date(FIXED_NOW - 1_000).toISOString(),
  })
  let routingConfig = routingWithCodexQuota({ limit_7d: 1 })
  let state = preheatWindowStateLikeServer(vm, () => routingConfig, { projectRoot: null, now: FIXED_NOW })
  assert.equal(state.windowLive, false)

  routingConfig = routingWithCodexQuota({ limit_7d: 0.9 })
  state = preheatWindowStateLikeServer(vm, () => routingConfig, { projectRoot: null, now: FIXED_NOW })
  assert.equal(state.windowLive, true)
  assert.equal(state.reason, 'quota_7d_local')
})

test('preheatWindowStateForVm skips when 5h reset elapsed but 7d still exceeds configured soft limit', () => {
  const vm = codexExtraVm({
    codex_secondary_used_percent: 100,
    codex_secondary_reset_at: new Date(FIXED_NOW - 3_600_000).toISOString(),
    codex_primary_used_percent: 91,
    codex_primary_reset_at: new Date(FIXED_NOW + 5 * 24 * 3600_000).toISOString(),
  })
  const state = preheatWindowStateForVm(vm, {
    projectRoot: null,
    routingConfig: routingWithCodexQuota({ limit_7d: 0.9 }),
    now: FIXED_NOW,
  })
  assert.equal(state.windowLive, true)
  assert.equal(state.reason, 'quota_7d_local')
})

test('preheatOpenAIQuotaPolicy ignores vm.policy.quota on Codex (global routing only)', () => {
  const vm = codexExtraVm()
  vm.policy = { quota: { limit_7d: 0.5 } }
  const global = routingWithCodexQuota({ limit_7d: 0.9 })
  const policy = preheatOpenAIQuotaPolicy(vm, global)
  assert.equal(policy.limit_7d, 0.9)
  const vm2 = codexExtraVm({
    codex_primary_used_percent: 60,
    codex_primary_reset_at: new Date(FIXED_NOW + 5 * 24 * 3600_000).toISOString(),
    codex_secondary_used_percent: 100,
    codex_secondary_reset_at: new Date(FIXED_NOW - 1_000).toISOString(),
  })
  vm2.policy = { quota: { limit_7d: 0.5 } }
  const blocked = preheatWindowStateForVm(vm2, { projectRoot: null, routingConfig: global, now: FIXED_NOW })
  assert.equal(blocked.windowLive, false, 'hand-edited per-vm limits must not tighten preheat vs scheduler')
})

test('auto-renew sweep survives stop/reload without resending the same episode', async () => {
  const expiredVm = codexVmWithReset(new Date(RESET_EXPIRED_MS).toISOString())
  expiredVm.codex.extra.codex_secondary_used_percent = 100
  let calls = 0
  const settings = new MemorySettings()
  const shared = {
    projectRoot: '/missing',
    settings: () => settings,
    list: () => [expiredVm],
    runTest: async () => {
      calls += 1
      return { ok: true, duration_ms: 1 }
    },
    windowState: () => ({ hasCredential: true, schedulable: true, windowLive: false }),
    nextWindowEnd: () => RESET_EXPIRED_MS,
    now: () => FIXED_NOW,
  }
  const schedule = new VmTestScheduleRunner(shared)
  settings.set(`${VM_TEST_SCHEDULE_PREFIX}vm-codex`, {
    enabled: true,
    mode: 'preheat',
    auto_renew: true,
    frequency: 'daily',
    time: '09:00',
    timezone: 'Asia/Shanghai',
    cron: '0 9 * * *',
    model: 'gpt-5-codex',
    prompt: 'ping',
    max_tokens: null,
    reasoning_effort: 'medium',
  })
  schedule.start()
  await schedule._sweepElapsedWindows()
  assert.equal(calls, 1)
  const claim = settings.get(`${VM_TEST_RENEW_CLAIM_PREFIX}vm-codex`)
  assert.ok(claim?.episode_key)
  schedule.stop()

  const restored = new VmTestScheduleRunner(shared)
  restored.start()
  await restored._sweepElapsedWindows()
  assert.equal(calls, 1)
  restored.stop()
})
