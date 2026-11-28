import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import {
  compileStructuredSchedule,
  normalizeScheduleStructure,
  normalizeVmTestSchedule,
  VM_TEST_SCHEDULE_PREFIX,
  VM_TEST_RENEW_CLAIM_PREFIX,
  VmTestScheduleRunner,
} from '../../src/lib/admin/vm-test-schedule.mjs'

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

const claudeVm = { id: 'vm-01', platform: 'anthropic' }
const claudeConfig = {
  enabled: true,
  frequency: 'daily',
  time: '09:00',
  timezone: 'America/Los_Angeles',
  model: 'claude-haiku-4-5',
  prompt: 'hello',
  max_tokens: 64,
  reasoning_effort: null,
}

function runner({
  settings = new MemorySettings(),
  list = () => [claudeVm],
  runTest = async () => ({ ok: true }),
  windowState = null,
  nextWindowEnd = null,
  renewEpisodeKey = null,
  now = () => Date.parse('2026-10-16T00:00:00.000Z'),
} = {}) {
  return {
    settings,
    schedule: new VmTestScheduleRunner({
      projectRoot: '/missing-project',
      settings: () => settings,
      list,
      runTest,
      windowState,
      nextWindowEnd,
      renewEpisodeKey,
      now,
    }),
  }
}

test('structured compile and reverse parse cover hourly daily weekly', () => {
  assert.equal(compileStructuredSchedule({ frequency: 'hourly', minute: 15, timezone: 'UTC' }), '15 * * * *')
  assert.equal(compileStructuredSchedule({ frequency: 'daily', time: '09:30', timezone: 'UTC' }), '30 9 * * *')
  assert.equal(
    compileStructuredSchedule({
      frequency: 'weekly',
      time: '08:05',
      weekdays: [1, 3, 0],
      timezone: 'UTC',
    }),
    '5 8 * * 0,1,3',
  )

  const daily = normalizeVmTestSchedule(claudeConfig, claudeVm)
  assert.equal(daily.cron, '0 9 * * *')
  assert.equal(daily.frequency, 'daily')
  assert.throws(() => normalizeVmTestSchedule({ ...claudeConfig, frequency: 'monthly' }, claudeVm), /frequency/)
  assert.throws(() => normalizeVmTestSchedule({ ...claudeConfig, time: '25:99' }, claudeVm), /HH:MM/)
})

test('legacy cron input must match structured patterns', () => {
  assert.throws(
    () =>
      normalizeVmTestSchedule(
        { ...claudeConfig, frequency: undefined, cron: '*/5 * * * *', timezone: 'UTC' },
        claudeVm,
      ),
    /structured schedules/,
  )
})

test('SettingsRepo schedules reload after restart without an immediate catch-up run', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-test-schedule-'))
  const dbPath = path.join(dataDir, 'settings.db')
  let db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)')
  let settings = new SettingsRepo(db)
  let first
  let restored
  t.after(() => {
    first?.stop()
    restored?.stop()
    db.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  first = runner({ settings }).schedule
  first.save('vm-01', claudeConfig)
  assert.deepEqual(
    Object.keys(settings.all()).filter((key) => key.startsWith(VM_TEST_SCHEDULE_PREFIX)),
    [`${VM_TEST_SCHEDULE_PREFIX}vm-01`],
  )
  first.start()
  assert.equal(first.jobs.has('vm-01'), true)
  assert.equal(first.get('vm-01').running, false)
  assert.ok(first.get('vm-01').next_run_at)
  assert.equal(first.get('vm-01').cron, undefined)
  first.stop()

  db.close()
  db = new DatabaseSync(dbPath)
  settings = new SettingsRepo(db)
  restored = new VmTestScheduleRunner({
    projectRoot: '/missing-project',
    settings: () => settings,
    list: () => [claudeVm],
    runTest: async () => ({ ok: true }),
  })
  restored.start()
  assert.equal(restored.jobs.has('vm-01'), true)
  assert.equal(restored.get('vm-01').enabled, true)
  restored.stop()
})

test('runs do not overlap per VM and failures persist only compact result fields', async () => {
  let releaseRun
  let calls = 0
  const { settings, schedule } = runner({
    runTest: () => {
      calls += 1
      return new Promise((resolve) => {
        releaseRun = resolve
      })
    },
  })
  schedule.save('vm-01', claudeConfig)
  schedule.start()

  const job = schedule.jobs.get('vm-01')
  const first = job.trigger()
  const second = job.trigger()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  assert.equal(schedule.get('vm-01').running, true)

  releaseRun({
    ok: false,
    duration_ms: 27,
    error: { code: 'upstream_timeout', message: 'timeout '.repeat(80) },
    text: 'response content must not be stored',
  })
  await Promise.all([first, second])

  const stored = settings.get(`${VM_TEST_SCHEDULE_PREFIX}vm-01`)
  assert.equal(stored.last_ok, false)
  assert.equal(stored.last_duration_ms, 27)
  assert.equal(stored.last_run_at, '2026-10-16T00:00:00.000Z')
  assert.ok(stored.last_error.length <= 300)
  assert.equal('text' in stored, false)
  schedule.stop()
})

test('sync overwrites schedule only and creates disabled plans with default dialog params', () => {
  const codexVm = { id: 'vm-02', platform: 'openai' }
  const { settings, schedule } = runner({ list: () => [claudeVm, codexVm] })
  schedule.save('vm-01', { ...claudeConfig, prompt: 'keep-me', enabled: true })
  const result = schedule.syncSchedules({
    scope: 'all',
    schedule: normalizeScheduleStructure({
      frequency: 'hourly',
      minute: 20,
      timezone: 'Asia/Shanghai',
    }),
  })
  assert.deepEqual(result.updated.sort(), ['vm-01', 'vm-02'])
  const existing = settings.get(`${VM_TEST_SCHEDULE_PREFIX}vm-01`)
  assert.equal(existing.enabled, true)
  assert.equal(existing.prompt, 'keep-me')
  assert.equal(existing.frequency, 'hourly')
  assert.equal(existing.minute, 20)
  assert.equal(existing.timezone, 'Asia/Shanghai')

  const created = settings.get(`${VM_TEST_SCHEDULE_PREFIX}vm-02`)
  assert.equal(created.enabled, false)
  assert.equal(created.prompt, 'hello')
  assert.ok(created.model)
  assert.equal(created.reasoning_effort, 'medium')
})

test('default template persists schedule structure and preheat fields', () => {
  const { schedule } = runner()
  const saved = schedule.saveDefaultTemplate({
    frequency: 'weekly',
    time: '10:15',
    weekdays: [5],
    timezone: 'Asia/Shanghai',
    mode: 'preheat',
    auto_renew: true,
  })
  assert.equal(saved.frequency, 'weekly')
  assert.equal(saved.mode, 'preheat')
  assert.equal(saved.auto_renew, true)
  assert.deepEqual(schedule.getDefaultTemplate(), saved)
  assert.throws(
    () =>
      schedule.saveDefaultTemplate({
        frequency: 'daily',
        time: '08:00',
        timezone: 'UTC',
        mode: 'test',
        auto_renew: true,
      }),
    /auto_renew/,
  )
  schedule.clearDefaultTemplate()
  assert.equal(schedule.getDefaultTemplate(), null)
})

const syncTime = { frequency: 'daily', time: '09:00', timezone: 'UTC' }

test('sync scope=ids applies explicit mode and auto_renew from the schedule payload', () => {
  const { settings, schedule } = runner()
  schedule.save('vm-01', claudeConfig)
  assert.equal(settings.get(`${VM_TEST_SCHEDULE_PREFIX}vm-01`).mode, 'test')
  schedule.syncSchedules({
    scope: 'ids',
    vmIds: ['vm-01'],
    schedule: { ...syncTime, mode: 'preheat', auto_renew: true },
  })
  const stored = settings.get(`${VM_TEST_SCHEDULE_PREFIX}vm-01`)
  assert.equal(stored.mode, 'preheat')
  assert.equal(stored.auto_renew, true)
})

test('sync scope=all applies explicit preheat mode from the test payload', () => {
  const { settings, schedule } = runner()
  schedule.save('vm-01', claudeConfig)
  schedule.syncSchedules({
    scope: 'all',
    schedule: syncTime,
    test: {
      enabled: false,
      model: 'claude-haiku-4-5',
      prompt: 'hello',
      max_tokens: 64,
      mode: 'preheat',
      auto_renew: true,
    },
  })
  const stored = settings.get(`${VM_TEST_SCHEDULE_PREFIX}vm-01`)
  assert.equal(stored.mode, 'preheat')
  assert.equal(stored.auto_renew, true)
})

test('sync scope=ids can clear preheat and auto_renew when switching to test', () => {
  const { settings, schedule } = runner()
  schedule.save('vm-01', { ...claudeConfig, mode: 'preheat', auto_renew: true })
  schedule.syncSchedules({
    scope: 'ids',
    vmIds: ['vm-01'],
    schedule: { ...syncTime, mode: 'test', auto_renew: false },
  })
  const stored = settings.get(`${VM_TEST_SCHEDULE_PREFIX}vm-01`)
  assert.equal(stored.mode, 'test')
  assert.equal(stored.auto_renew, false)
})

test('sync scope=all can clear preheat and auto_renew when switching to test', () => {
  const { settings, schedule } = runner()
  schedule.save('vm-01', { ...claudeConfig, mode: 'preheat', auto_renew: true })
  schedule.syncSchedules({
    scope: 'all',
    schedule: syncTime,
    test: {
      enabled: true,
      model: 'claude-haiku-4-5',
      prompt: 'hello',
      max_tokens: 64,
      mode: 'test',
      auto_renew: false,
    },
  })
  const stored = settings.get(`${VM_TEST_SCHEDULE_PREFIX}vm-01`)
  assert.equal(stored.mode, 'test')
  assert.equal(stored.auto_renew, false)
})

test('sync scope=ids creates a disabled plan with preheat mode when the slot had none', () => {
  const { settings, schedule } = runner()
  schedule.syncSchedules({
    scope: 'ids',
    vmIds: ['vm-01'],
    schedule: { ...syncTime, mode: 'preheat', auto_renew: true },
  })
  const stored = settings.get(`${VM_TEST_SCHEDULE_PREFIX}vm-01`)
  assert.ok(stored)
  assert.equal(stored.enabled, false)
  assert.equal(stored.mode, 'preheat')
  assert.equal(stored.auto_renew, true)
})

test('sync scope=all copies mode and auto_renew onto another-kind slots while keeping dialog', () => {
  const codexVm = { id: 'vm-02', platform: 'openai' }
  const { settings, schedule } = runner({ list: () => [claudeVm, codexVm] })
  schedule.save('vm-02', {
    enabled: true,
    frequency: 'daily',
    time: '08:00',
    timezone: 'UTC',
    model: 'gpt-5.5',
    prompt: 'codex-own',
    max_tokens: null,
    reasoning_effort: 'low',
    mode: 'test',
    auto_renew: false,
  })
  schedule.syncSchedules({
    scope: 'all',
    schedule: syncTime,
    test: {
      enabled: true,
      model: 'claude-haiku-4-5',
      prompt: 'ping',
      max_tokens: 32,
      mode: 'preheat',
      auto_renew: true,
    },
  })
  const codex = settings.get(`${VM_TEST_SCHEDULE_PREFIX}vm-02`)
  assert.equal(codex.mode, 'preheat', 'mode copies to Codex slots like timing and enabled')
  assert.equal(codex.auto_renew, true)
  assert.equal(codex.prompt, 'codex-own', 'cross-kind slots keep their own model and prompt')
})

test('unparseable stored cron surfaces parse_error without exposing cron string', () => {
  const { settings, schedule } = runner()
  settings.set(`${VM_TEST_SCHEDULE_PREFIX}vm-01`, {
    enabled: false,
    cron: '*/5 * * * *',
    timezone: 'UTC',
    model: 'claude-haiku-4-5',
    prompt: 'hello',
    max_tokens: 64,
  })
  const view = schedule.get('vm-01')
  assert.equal(view.parse_error, true)
  assert.equal(view.cron, undefined)
})

test('sync with test copies switch and dialog to every slot of the same kind', () => {
  const codexVm = { id: 'vm-02', platform: 'openai' }
  const otherClaude = { id: 'vm-03', platform: 'anthropic' }
  const { settings, schedule } = runner({ list: () => [claudeVm, codexVm, otherClaude] })
  schedule.save('vm-01', { ...claudeConfig, enabled: false })
  schedule.save('vm-02', {
    enabled: false,
    frequency: 'daily',
    time: '08:00',
    timezone: 'UTC',
    model: 'gpt-5.5',
    prompt: 'codex-own',
    max_tokens: null,
    reasoning_effort: 'low',
  })
  const result = schedule.syncSchedules({
    scope: 'all',
    schedule: normalizeScheduleStructure({ frequency: 'hourly', minute: 0, timezone: 'Asia/Shanghai' }),
    test: { enabled: true, model: 'claude-haiku-5-5', prompt: 'ping', max_tokens: 32 },
  })
  assert.deepEqual(result.updated.sort(), ['vm-01', 'vm-02', 'vm-03'])
  for (const id of ['vm-01', 'vm-03']) {
    const row = settings.get(`${VM_TEST_SCHEDULE_PREFIX}${id}`)
    assert.equal(row.enabled, true)
    assert.equal(row.model, 'claude-haiku-5-5')
    assert.equal(row.prompt, 'ping')
    assert.equal(row.max_tokens, 32)
    assert.equal(row.frequency, 'hourly')
    assert.equal(row.timezone, 'Asia/Shanghai')
  }
  const codex = settings.get(`${VM_TEST_SCHEDULE_PREFIX}vm-02`)
  assert.equal(codex.enabled, true, 'the switch applies to every slot')
  assert.equal(codex.prompt, 'codex-own', 'a Codex slot keeps its own model and prompt')
  assert.equal(codex.reasoning_effort, 'low')
  assert.equal(codex.max_tokens, null)

  schedule.syncSchedules({
    scope: 'all',
    schedule: normalizeScheduleStructure({ frequency: 'hourly', minute: 0, timezone: 'Asia/Shanghai' }),
    test: { enabled: false, model: 'claude-haiku-5-5', prompt: 'ping', max_tokens: 32 },
  })
  for (const id of ['vm-01', 'vm-02', 'vm-03']) {
    assert.equal(settings.get(`${VM_TEST_SCHEDULE_PREFIX}${id}`).enabled, false, 'switching off also syncs')
  }
})

test('sync with an invalid test writes nothing', () => {
  const { settings, schedule } = runner({ list: () => [claudeVm, { id: 'vm-03', platform: 'anthropic' }] })
  schedule.save('vm-01', { ...claudeConfig, enabled: false })
  const before = settings.all()
  for (const test of [
    { enabled: 'yes', model: 'm', prompt: 'p', max_tokens: 1 },
    { enabled: true, model: '', prompt: 'p', max_tokens: 1 },
    { enabled: true, model: 'm', prompt: 'p' },
  ]) {
    assert.throws(() =>
      schedule.syncSchedules({
        scope: 'all',
        schedule: normalizeScheduleStructure({ frequency: 'hourly', minute: 0, timezone: 'Asia/Shanghai' }),
        test,
      }),
    )
  }
  assert.deepEqual(settings.all(), before)
})

// ---------------------------------------------------------------------------
// #979 preheat mode: tiny real request on a schedule, gated on window liveness.

const preheatConfig = {
  ...claudeConfig,
  mode: 'preheat',
}

test('preheat mode normalizes and round-trips through the store', () => {
  const { settings, schedule } = runner()
  const saved = schedule.save('vm-01', preheatConfig)
  assert.equal(saved.mode, 'preheat')
  assert.equal(saved.auto_renew, false)
  assert.equal(saved.last_skipped, null)
  const stored = settings.get(`${VM_TEST_SCHEDULE_PREFIX}vm-01`)
  assert.equal(stored.mode, 'preheat')
  assert.equal(stored.auto_renew, false)
  // Unknown mode rejects; auto_renew requires preheat.
  assert.throws(() => schedule.save('vm-01', { ...preheatConfig, mode: 'both' }), /mode/)
  assert.throws(() => schedule.save('vm-01', { ...claudeConfig, mode: 'test', auto_renew: true }), /auto_renew/)
})

test('preheat fires only when the window is not live and the slot is healthy', async () => {
  let calls = 0
  const states = []
  const { settings, schedule } = runner({
    runTest: async () => {
      calls += 1
      return { ok: true, duration_ms: 5 }
    },
    windowState: (vmId) => states[vmId],
  })
  schedule.save('vm-01', { ...preheatConfig, enabled: true })
  schedule.start()

  // Live window: skip, no request.
  states['vm-01'] = { hasCredential: true, schedulable: true, windowLive: true }
  await schedule.jobs.get('vm-01').trigger()
  let stored = settings.get(`${VM_TEST_SCHEDULE_PREFIX}vm-01`)
  assert.equal(calls, 0, 'a live window must not be preheated')
  assert.equal(stored.last_ok, null)
  assert.equal(stored.last_skipped, 'window_live')

  // Dead window: fire once.
  states['vm-01'] = { hasCredential: true, schedulable: true, windowLive: false }
  await schedule.jobs.get('vm-01').trigger()
  stored = settings.get(`${VM_TEST_SCHEDULE_PREFIX}vm-01`)
  assert.equal(calls, 1)
  assert.equal(stored.last_ok, true)
  assert.equal(stored.last_skipped, null)

  // Parked slot (no credential / unschedulable): skip, never retry in a loop.
  states['vm-01'] = { hasCredential: false, schedulable: true, windowLive: false }
  await schedule.jobs.get('vm-01').trigger()
  stored = settings.get(`${VM_TEST_SCHEDULE_PREFIX}vm-01`)
  assert.equal(calls, 1)
  assert.equal(stored.last_skipped, 'no_credential')
  states['vm-01'] = { hasCredential: true, schedulable: false, windowLive: false }
  await schedule.jobs.get('vm-01').trigger()
  stored = settings.get(`${VM_TEST_SCHEDULE_PREFIX}vm-01`)
  assert.equal(calls, 1)
  assert.equal(stored.last_skipped, 'slot_not_schedulable')
  schedule.stop()
})

test('preheat gates are optional: without a probe the request always fires', async () => {
  let calls = 0
  const { schedule } = runner({ runTest: async () => (calls++, { ok: true }) })
  schedule.save('vm-01', { ...preheatConfig, enabled: true })
  schedule.start()
  await schedule.jobs.get('vm-01').trigger()
  assert.equal(calls, 1)
  schedule.stop()
})

test('a preheat gate crash is not a scheduling failure', async () => {
  let calls = 0
  const { schedule } = runner({
    runTest: async () => (calls++, { ok: true }),
    windowState: () => {
      throw new Error('probe exploded')
    },
  })
  schedule.save('vm-01', { ...preheatConfig, enabled: true })
  schedule.start()
  await schedule.jobs.get('vm-01').trigger()
  assert.equal(calls, 1, 'unknown liveness reads as not-live; the tiny request still goes out')
  schedule.stop()
})

test('auto-renew fires once per elapsed window and re-arms on the next window', async () => {
  let calls = 0
  const NOW = Date.parse('2026-10-16T00:00:00.000Z')
  let windowEnd = NOW - 60_000 // already elapsed
  const { settings, schedule } = runner({
    runTest: async () => (calls++, { ok: true }),
    nextWindowEnd: () => windowEnd,
    renewEpisodeKey: () => ({ key: `vm-01\x1evm-01\x1e${Math.floor(windowEnd / 1000)}\x1e` }),
    windowState: () => ({ hasCredential: true, schedulable: true, windowLive: false }),
    now: () => NOW,
  })
  schedule.save('vm-01', { ...preheatConfig, enabled: true, auto_renew: true })
  schedule.start()

  await schedule._sweepElapsedWindows()
  assert.equal(calls, 1, 'elapsed window fires one preheat')

  // Same window, sweep again: no double fire.
  await schedule._sweepElapsedWindows()
  assert.equal(calls, 1)

  // A new window elapsed: re-arm and fire again.
  windowEnd = NOW + 5 * 3600_000
  await schedule._sweepElapsedWindows()
  assert.equal(calls, 1, 'a future window does not fire')
  windowEnd = NOW - 1_000
  await schedule._sweepElapsedWindows()
  assert.equal(calls, 2)
  schedule.stop()
})

test('auto-renew never fires for plain test schedules or disabled plans', async () => {
  let calls = 0
  const { settings, schedule } = runner({
    runTest: async () => (calls++, { ok: true }),
    nextWindowEnd: () => Date.now() - 1,
  })
  // Plain test mode rejects auto_renew outright.
  assert.throws(() => schedule.save('vm-01', { ...claudeConfig, enabled: true, auto_renew: true }), /auto_renew/)
  // A disabled preheat plan never fires even with an elapsed window.
  schedule.save('vm-01', { ...preheatConfig, enabled: false, auto_renew: true })
  schedule.start()
  await schedule._sweepElapsedWindows()
  assert.equal(calls, 0)
  assert.equal(settings.get(`${VM_TEST_SCHEDULE_PREFIX}vm-01`).enabled, false)
  schedule.stop()
})

test('a skipped preheat is visible on the public read, a fired one clears it', async () => {
  const { settings, schedule } = runner({
    windowState: () => ({ hasCredential: true, schedulable: true, windowLive: true }),
  })
  schedule.save('vm-01', { ...preheatConfig, enabled: true })
  schedule.start()
  await schedule.jobs.get('vm-01').trigger()
  const pub = schedule.get('vm-01')
  assert.equal(pub.last_skipped, 'window_live')
  assert.equal(pub.last_ok, null)
  assert.match(pub.last_error, /skipped: window_live/)
  schedule.stop()
})

test('#1874 auto-renew persists episode claims across stop/reload', async () => {
  let calls = 0
  const NOW = Date.parse('2026-10-16T00:00:00.000Z')
  const windowEnd = NOW - 60_000
  const episodeKey = `vm-01\x1evm-01\x1e${Math.floor(windowEnd / 1000)}\x1e`
  const settings = new MemorySettings()
  const shared = {
    settings,
    runTest: async () => (calls++, { ok: true }),
    nextWindowEnd: () => windowEnd,
    renewEpisodeKey: () => ({ key: episodeKey }),
    windowState: () => ({ hasCredential: true, schedulable: true, windowLive: false }),
    now: () => NOW,
    list: () => [claudeVm],
  }
  const first = runner(shared).schedule
  first.save('vm-01', { ...preheatConfig, enabled: true, auto_renew: true })
  first.start()
  await first._sweepElapsedWindows()
  assert.equal(calls, 1)
  assert.equal(settings.get(`${VM_TEST_RENEW_CLAIM_PREFIX}vm-01`).episode_key, episodeKey)
  first.stop()

  const second = runner(shared).schedule
  second.start()
  await second._sweepElapsedWindows()
  assert.equal(calls, 1, 'reload must not resend the same episode')
  second.stop()
})

test('#1874 auto-renew gate skip writes last_run only once while the skip reason stays the same', async () => {
  const NOW = Date.parse('2026-10-16T00:00:00.000Z')
  const windowEnd = NOW - 60_000
  const episodeKey = `vm-01\x1evm-01\x1e${Math.floor(windowEnd / 1000)}\x1e`
  const { settings, schedule } = runner({
    runTest: async () => ({ ok: true }),
    nextWindowEnd: () => windowEnd,
    renewEpisodeKey: () => ({ key: episodeKey }),
    windowState: () => ({ hasCredential: true, schedulable: true, windowLive: true, reason: 'quota_7d_local' }),
    now: () => NOW,
  })
  schedule.save('vm-01', { ...preheatConfig, enabled: true, auto_renew: true })
  const scheduleKey = `${VM_TEST_SCHEDULE_PREFIX}vm-01`
  settings.set(scheduleKey, {
    ...settings.get(scheduleKey),
    last_run_at: '2026-09-01T00:00:00.000Z',
    last_ok: true,
    last_skipped: null,
  })
  schedule.start()
  await schedule._sweepElapsedWindows()
  let stored = settings.get(scheduleKey)
  const recordedAt = stored.last_run_at
  assert.equal(stored.last_skipped, 'quota_7d_local')
  assert.equal(stored.last_ok, null)
  assert.notEqual(recordedAt, '2026-09-01T00:00:00.000Z')
  for (let i = 0; i < 4; i++) await schedule._sweepElapsedWindows()
  stored = settings.get(scheduleKey)
  assert.equal(stored.last_run_at, recordedAt)
  assert.equal(stored.last_skipped, 'quota_7d_local')
  schedule.stop()
})

test('#1874 auto-renew gate skip records again when the skip reason changes', async () => {
  const NOW = Date.parse('2026-10-16T00:00:00.000Z')
  const windowEnd = NOW - 60_000
  const episodeKey = `vm-01\x1evm-01\x1e${Math.floor(windowEnd / 1000)}\x1e`
  let gateReason = 'quota_5h_local'
  let tick = 0
  const { settings, schedule } = runner({
    runTest: async () => ({ ok: true }),
    nextWindowEnd: () => windowEnd,
    renewEpisodeKey: () => ({ key: episodeKey }),
    windowState: () => ({ hasCredential: true, schedulable: true, windowLive: true, reason: gateReason }),
    now: () => NOW + tick * 1000,
  })
  schedule.save('vm-01', { ...preheatConfig, enabled: true, auto_renew: true })
  const scheduleKey = `${VM_TEST_SCHEDULE_PREFIX}vm-01`
  schedule.start()
  await schedule._sweepElapsedWindows()
  let stored = settings.get(scheduleKey)
  const firstAt = stored.last_run_at
  assert.equal(stored.last_skipped, 'quota_5h_local')
  for (let i = 0; i < 3; i++) await schedule._sweepElapsedWindows()
  assert.equal(settings.get(scheduleKey).last_run_at, firstAt)
  gateReason = 'quota_7d_local'
  tick += 1
  await schedule._sweepElapsedWindows()
  stored = settings.get(scheduleKey)
  assert.equal(stored.last_skipped, 'quota_7d_local')
  assert.notEqual(stored.last_run_at, firstAt)
  schedule.stop()
})

test('#1874 a skipped auto-renew sweep does not consume the episode claim', async () => {
  let calls = 0
  const NOW = Date.parse('2026-10-16T00:00:00.000Z')
  const windowEnd = NOW - 60_000
  const episodeKey = `vm-01\x1evm-01\x1e${Math.floor(windowEnd / 1000)}\x1e`
  let live = true
  const { settings, schedule } = runner({
    runTest: async () => (calls++, { ok: true }),
    nextWindowEnd: () => windowEnd,
    renewEpisodeKey: () => ({ key: episodeKey }),
    windowState: () => ({ hasCredential: true, schedulable: true, windowLive: live }),
    now: () => NOW,
  })
  schedule.save('vm-01', { ...preheatConfig, enabled: true, auto_renew: true })
  schedule.start()

  await schedule._sweepElapsedWindows()
  assert.equal(calls, 0)
  assert.equal(settings.get(`${VM_TEST_RENEW_CLAIM_PREFIX}vm-01`), null)

  live = false
  await schedule._sweepElapsedWindows()
  assert.equal(calls, 1)
  schedule.stop()
})

test('#1874 auto-renew with a throwing probe does not send', async () => {
  let calls = 0
  const NOW = Date.parse('2026-10-16T00:00:00.000Z')
  const { schedule } = runner({
    runTest: async () => (calls++, { ok: true }),
    nextWindowEnd: () => NOW - 1,
    renewEpisodeKey: () => ({ key: 'vm-01\x1evm-01\x1e1\x1e' }),
    windowState: () => {
      throw new Error('probe exploded')
    },
    now: () => NOW,
  })
  schedule.save('vm-01', { ...preheatConfig, enabled: true, auto_renew: true })
  schedule.start()
  await schedule._sweepElapsedWindows()
  assert.equal(calls, 0)
  schedule.stop()
})

test('#1874 successful renew clears gate-skip memory so the same reason can be recorded again', async () => {
  let calls = 0
  let gateLive = true
  const NOW = Date.parse('2026-10-16T00:00:00.000Z')
  let tick = 0
  const windowEnd = NOW - 60_000
  let episodeKey = `vm-01\x1evm-01\x1e${Math.floor(windowEnd / 1000)}\x1e-old`
  const { settings, schedule } = runner({
    runTest: async () => {
      calls += 1
      return { ok: true, duration_ms: 3 }
    },
    nextWindowEnd: () => windowEnd,
    renewEpisodeKey: () => ({ key: episodeKey }),
    windowState: () =>
      gateLive
        ? { hasCredential: true, schedulable: true, windowLive: true, reason: 'quota_7d_local' }
        : { hasCredential: true, schedulable: true, windowLive: false },
    now: () => NOW + tick * 1000,
  })
  schedule.save('vm-01', { ...preheatConfig, enabled: true, auto_renew: true })
  const scheduleKey = `${VM_TEST_SCHEDULE_PREFIX}vm-01`
  schedule.start()

  await schedule._sweepElapsedWindows()
  const firstAt = settings.get(scheduleKey).last_run_at
  assert.equal(settings.get(scheduleKey).last_skipped, 'quota_7d_local')
  await schedule._sweepElapsedWindows()
  assert.equal(settings.get(scheduleKey).last_run_at, firstAt)

  gateLive = false
  tick += 1
  await schedule._sweepElapsedWindows()
  assert.equal(calls, 1)
  assert.equal(settings.get(scheduleKey).last_ok, true)
  assert.equal(settings.get(scheduleKey).last_skipped, null)

  episodeKey = `vm-01\x1evm-01\x1e${Math.floor(windowEnd / 1000)}\x1e-new`
  gateLive = true
  tick += 1
  await schedule._sweepElapsedWindows()
  const secondAt = settings.get(scheduleKey).last_run_at
  assert.equal(settings.get(scheduleKey).last_skipped, 'quota_7d_local')
  assert.notEqual(secondAt, firstAt)
  schedule.stop()
})

test('#1874 repeated minute sweeps send only one auto-renew request', async () => {
  let calls = 0
  const NOW = Date.parse('2026-10-16T00:00:00.000Z')
  const windowEnd = NOW - 5_000
  const { schedule } = runner({
    runTest: async () => (calls++, { ok: true }),
    nextWindowEnd: () => windowEnd,
    renewEpisodeKey: () => ({ key: `vm-01\x1evm-01\x1e${Math.floor(windowEnd / 1000)}\x1e` }),
    windowState: () => ({ hasCredential: true, schedulable: true, windowLive: false }),
    now: () => NOW,
  })
  schedule.save('vm-01', { ...preheatConfig, enabled: true, auto_renew: true })
  schedule.start()
  for (let i = 0; i < 5; i++) await schedule._sweepElapsedWindows()
  assert.equal(calls, 1)
  schedule.stop()
})
