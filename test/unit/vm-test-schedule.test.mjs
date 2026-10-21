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
} = {}) {
  return {
    settings,
    schedule: new VmTestScheduleRunner({
      projectRoot: '/missing-project',
      settings: () => settings,
      list,
      runTest,
      now: () => Date.parse('2026-10-16T00:00:00.000Z'),
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

test('default template persists schedule structure only', () => {
  const { schedule } = runner()
  const saved = schedule.saveDefaultTemplate({
    frequency: 'weekly',
    time: '10:15',
    weekdays: [5],
    timezone: 'Asia/Shanghai',
  })
  assert.equal(saved.frequency, 'weekly')
  assert.deepEqual(schedule.getDefaultTemplate(), saved)
  schedule.clearDefaultTemplate()
  assert.equal(schedule.getDefaultTemplate(), null)
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

const intervalConfig = {
  ...claudeConfig,
  frequency: 'interval',
  time: '09:00',
  timezone: 'UTC',
  interval_minutes: 300,
  jitter_min_minutes: 0,
  jitter_max_minutes: 60,
}

function clockRunner({ at = '2026-10-16T00:00:00.000Z', random = () => 0, runTest, settings, list } = {}) {
  const clock = { now: Date.parse(at) }
  const store = settings || new MemorySettings()
  const calls = []
  const schedule = new VmTestScheduleRunner({
    projectRoot: '/missing-project',
    settings: () => store,
    list: list || (() => [claudeVm]),
    runTest:
      runTest ||
      (async (_vmId, params) => {
        calls.push(params)
        return { ok: true, duration_ms: 5 }
      }),
    now: () => clock.now,
    random,
  })
  return { clock, settings: store, schedule, calls }
}

const row = (settings, id = 'vm-01') => settings.get(`${VM_TEST_SCHEDULE_PREFIX}${id}`)

test('interval structure validates its fields and compiles the first-run time', () => {
  const structure = normalizeScheduleStructure({
    frequency: 'interval',
    time: '9:05',
    interval_minutes: 300,
    jitter_max_minutes: 60,
    timezone: 'UTC',
  })
  assert.deepEqual(structure, {
    frequency: 'interval',
    time: '09:05',
    interval_minutes: 300,
    jitter_min_minutes: 0,
    jitter_max_minutes: 60,
    timezone: 'UTC',
  })
  assert.equal(compileStructuredSchedule(structure), '5 9 * * *')
  const noJitter = normalizeScheduleStructure({ ...structure, jitter_max_minutes: undefined, jitter_min_minutes: 15 })
  assert.equal(noJitter.jitter_max_minutes, 15, 'max defaults to min')
  for (const bad of [
    { interval_minutes: undefined },
    { interval_minutes: 5 },
    { interval_minutes: 7 * 24 * 60 + 1 },
    { interval_minutes: 90.5 },
    { jitter_min_minutes: 30, jitter_max_minutes: 10 },
    { jitter_max_minutes: 24 * 60 + 1 },
    { time: undefined },
  ]) {
    assert.throws(() => normalizeScheduleStructure({ ...structure, ...bad }), /interval_minutes|jitter|HH:MM/)
  }
})

test('interval plan first runs at the next `time`, then at actual run + interval + random delay', async () => {
  let draw = 0.5
  const { clock, settings, schedule, calls } = clockRunner({ random: () => draw })
  const saved = schedule.save('vm-01', intervalConfig)
  assert.equal(saved.frequency, 'interval')
  assert.equal(saved.next_run_at, '2026-10-16T09:00:00.000Z', 'shown before the runner starts')
  schedule.start()
  t_assertJob(schedule, '2026-10-16T09:00:00.000Z')

  // The run fires late (09:07); the next one counts from the actual run.
  clock.now = Date.parse('2026-10-16T09:07:00.000Z')
  await schedule.jobs.get('vm-01').trigger()
  assert.equal(calls.length, 1)
  const next = Date.parse(row(settings).next_run_at)
  assert.equal(next, Date.parse('2026-10-16T14:07:00.000Z') + Math.floor(0.5 * (3_600_000 + 1)))
  assert.equal(schedule.get('vm-01').next_run_at, new Date(next).toISOString())
  assert.equal(row(settings).last_run_at, '2026-10-16T09:07:00.000Z')
  assert.equal(row(settings).last_ok, true)

  for (const value of [0, 0.999999]) {
    draw = value
    clock.now += 6 * 3_600_000
    await schedule.jobs.get('vm-01').trigger()
    const at = Date.parse(row(settings).next_run_at) - clock.now
    assert.ok(at >= 300 * 60_000 && at <= 360 * 60_000, `delay ${at} within interval + [0, 60] min`)
  }
  schedule.stop()
})

function t_assertJob(schedule, iso) {
  const job = schedule.jobs.get('vm-01')
  assert.ok(job, 'interval job armed')
  assert.equal(job.nextRun().toISOString(), iso)
}

test('saving an interval plan keeps its pending run unless the timing changes', () => {
  const { clock, settings, schedule } = clockRunner()
  schedule.save('vm-01', intervalConfig)
  const pending = '2026-10-16T12:34:00.000Z'
  settings.set(`${VM_TEST_SCHEDULE_PREFIX}vm-01`, { ...row(settings), next_run_at: pending })
  clock.now = Date.parse('2026-10-16T01:00:00.000Z')
  assert.equal(schedule.save('vm-01', { ...intervalConfig, prompt: 'edited' }).next_run_at, pending)
  assert.equal(
    schedule.save('vm-01', { ...intervalConfig, interval_minutes: 120 }).next_run_at,
    '2026-10-16T09:00:00.000Z',
    'new timing restarts from the first-run time',
  )
  assert.equal(schedule.save('vm-01', { ...intervalConfig, enabled: false }).next_run_at, null)
})

test('interval plan restored after restart keeps or rolls forward its next run without catching up', () => {
  for (const [stored, expected] of [
    ['2026-10-16T03:00:00.000Z', '2026-10-16T03:00:00.000Z'],
    // Missed at 2026-10-15T20:00 while down: moved by whole 5 h intervals, no immediate run.
    ['2026-10-15T20:00:00.000Z', '2026-10-16T06:00:00.000Z'],
    [null, '2026-10-16T09:00:00.000Z'],
  ]) {
    const { settings, schedule, calls } = clockRunner({ at: '2026-10-16T02:00:00.000Z' })
    schedule.save('vm-01', intervalConfig)
    const raw = row(settings)
    if (stored) raw.next_run_at = stored
    else delete raw.next_run_at
    settings.set(`${VM_TEST_SCHEDULE_PREFIX}vm-01`, raw)
    schedule.start()
    assert.equal(row(settings).next_run_at, expected)
    assert.equal(schedule.jobs.get('vm-01').nextRun().toISOString(), expected)
    assert.equal(calls.length, 0)
    schedule.stop()
  }
})

test('interval timer splits delays longer than setTimeout allows', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { clock, settings, schedule } = clockRunner({ runTest: () => new Promise(() => {}) })
  schedule.save('vm-01', intervalConfig)
  const far = clock.now + 30 * 24 * 3_600_000
  settings.set(`${VM_TEST_SCHEDULE_PREFIX}vm-01`, { ...row(settings), next_run_at: new Date(far).toISOString() })
  schedule.start()
  const max = 2 ** 31 - 1
  clock.now += max
  t.mock.timers.tick(max)
  assert.equal(schedule.running.has('vm-01'), false, 'not due yet after the first segment')
  const rest = far - clock.now
  clock.now = far
  t.mock.timers.tick(rest)
  assert.equal(schedule.running.has('vm-01'), true)
  schedule.stop()
})

test('prompts are de-duplicated, validated, and one is picked at random per run', async () => {
  const plan = normalizeVmTestSchedule({ ...claudeConfig, prompt: ' a ', prompts: ['a', 'b', '', ' c '] }, claudeVm)
  assert.equal(plan.prompt, 'a')
  assert.deepEqual(plan.prompts, ['a', 'b', 'c'])
  assert.deepEqual(normalizeVmTestSchedule({ ...claudeConfig, prompt: '', prompts: ['x', 'y'] }, claudeVm).prompts, [
    'x',
    'y',
  ])
  assert.throws(() => normalizeVmTestSchedule({ ...claudeConfig, prompts: 'a' }, claudeVm), /array/)
  assert.throws(() => normalizeVmTestSchedule({ ...claudeConfig, prompts: [1] }, claudeVm), /strings/)
  assert.throws(
    () =>
      normalizeVmTestSchedule({ ...claudeConfig, prompts: Array.from({ length: 21 }, (_, i) => `p${i}`) }, claudeVm),
    /at most 20/,
  )
  assert.throws(
    () => normalizeVmTestSchedule({ ...claudeConfig, prompts: ['x'.repeat(16_000), 'y'.repeat(16_001)] }, claudeVm),
    /16000/,
  )
  assert.throws(
    () =>
      normalizeVmTestSchedule({ ...claudeConfig, prompts: ['x'.repeat(16_000), 'y'.repeat(16_000), 'z'] }, claudeVm),
    /total/,
  )

  const draws = [0, 0.4, 0.99]
  const { schedule, calls } = clockRunner({ random: () => draws.shift() ?? 0 })
  schedule.save('vm-01', { ...claudeConfig, prompts: ['hello', 'second', 'third'] })
  assert.deepEqual(schedule.get('vm-01').prompts, ['hello', 'second', 'third'])
  schedule.start()
  const job = schedule.jobs.get('vm-01')
  for (let i = 0; i < 3; i++) await job.trigger()
  assert.deepEqual(
    calls.map((c) => c.prompt),
    ['hello', 'second', 'third'],
  )
  schedule.stop()
})

test('rows saved before interval/prompts load unchanged', () => {
  const { settings, schedule } = clockRunner()
  settings.set(`${VM_TEST_SCHEDULE_PREFIX}vm-01`, {
    enabled: true,
    frequency: 'daily',
    time: '09:00',
    timezone: 'UTC',
    cron: '0 9 * * *',
    model: 'claude-haiku-4-5',
    prompt: 'legacy',
    max_tokens: 64,
    reasoning_effort: null,
    revision: 'r1',
  })
  const view = schedule.get('vm-01')
  assert.equal(view.parse_error, false)
  assert.deepEqual(view.prompts, ['legacy'])
  assert.match(view.next_run_at, /T09:00:00\.000Z$/, 'cron plans still probe croner')
  schedule.start()
  assert.equal(row(settings).next_run_at, undefined, 'cron plans never store next_run_at')
  schedule.stop()
})

test('sync and default template carry interval timing and prompts', () => {
  const otherClaude = { id: 'vm-03', platform: 'anthropic' }
  const { settings, schedule } = clockRunner({ list: () => [claudeVm, otherClaude] })
  const structure = normalizeScheduleStructure(intervalConfig)
  assert.deepEqual(schedule.saveDefaultTemplate(intervalConfig), structure)
  assert.deepEqual(schedule.getDefaultTemplate(), structure)
  schedule.save('vm-01', { ...claudeConfig, prompts: ['keep', 'also'] })
  schedule.syncSchedules({ scope: 'ids', vmIds: ['vm-01'], schedule: structure })
  assert.deepEqual(row(settings).prompts, ['hello', 'keep', 'also'])
  assert.equal(row(settings).frequency, 'interval')
  assert.equal(row(settings).next_run_at, '2026-10-16T09:00:00.000Z')

  schedule.syncSchedules({
    scope: 'all',
    schedule: structure,
    test: { enabled: true, model: 'claude-haiku-5-5', prompt: 'p1', prompts: ['p1', 'p2'], max_tokens: 32 },
  })
  for (const id of ['vm-01', 'vm-03']) {
    assert.deepEqual(row(settings, id).prompts, ['p1', 'p2'])
    assert.equal(row(settings, id).interval_minutes, 300)
  }
})
