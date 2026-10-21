import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { loadSettingsState, RuntimeSettings as SettingsRepo } from '../../src/lib/db/settings-state.mjs'
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

test('SettingsRepo schedules reload after restart without an immediate catch-up run', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-test-schedule-'))
  let db = await createDatabase()
  await loadSettingsState(db)
  let settings = new SettingsRepo(db)
  let first
  let restored
  t.after(async () => {
    first?.stop()
    restored?.stop()
    await db.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  first = runner({ settings }).schedule
  await first.save('vm-01', claudeConfig)
  assert.deepEqual(
    Object.keys(settings.all()).filter((key) => key.startsWith(VM_TEST_SCHEDULE_PREFIX)),
    [`${VM_TEST_SCHEDULE_PREFIX}vm-01`],
  )
  await first.start()
  assert.equal(first.jobs.has('vm-01'), true)
  assert.equal(first.get('vm-01').running, false)
  assert.ok(first.get('vm-01').next_run_at)
  assert.equal(first.get('vm-01').cron, undefined)
  first.stop()

  await db.close()
  db = await createDatabase()
  await loadSettingsState(db)
  settings = new SettingsRepo(db)
  restored = new VmTestScheduleRunner({
    projectRoot: '/missing-project',
    settings: () => settings,
    list: () => [claudeVm],
    runTest: async () => ({ ok: true }),
  })
  await restored.start()
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
  await schedule.save('vm-01', claudeConfig)
  await schedule.start()

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

test('sync overwrites schedule only and creates disabled plans with default dialog params', async () => {
  const codexVm = { id: 'vm-02', platform: 'openai' }
  const { settings, schedule } = runner({ list: () => [claudeVm, codexVm] })
  await schedule.save('vm-01', { ...claudeConfig, prompt: 'keep-me', enabled: true })
  const result = await schedule.syncSchedules({
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

test('default template persists schedule structure only', async () => {
  const { schedule } = runner()
  const saved = await schedule.saveDefaultTemplate({
    frequency: 'weekly',
    time: '10:15',
    weekdays: [5],
    timezone: 'Asia/Shanghai',
  })
  assert.equal(saved.frequency, 'weekly')
  assert.deepEqual(schedule.getDefaultTemplate(), saved)
  await schedule.clearDefaultTemplate()
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

test('sync with test copies switch and dialog to every slot of the same kind', async () => {
  const codexVm = { id: 'vm-02', platform: 'openai' }
  const otherClaude = { id: 'vm-03', platform: 'anthropic' }
  const { settings, schedule } = runner({ list: () => [claudeVm, codexVm, otherClaude] })
  await schedule.save('vm-01', { ...claudeConfig, enabled: false })
  await schedule.save('vm-02', {
    enabled: false,
    frequency: 'daily',
    time: '08:00',
    timezone: 'UTC',
    model: 'gpt-5.5',
    prompt: 'codex-own',
    max_tokens: null,
    reasoning_effort: 'low',
  })
  const result = await schedule.syncSchedules({
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

  await schedule.syncSchedules({
    scope: 'all',
    schedule: normalizeScheduleStructure({ frequency: 'hourly', minute: 0, timezone: 'Asia/Shanghai' }),
    test: { enabled: false, model: 'claude-haiku-5-5', prompt: 'ping', max_tokens: 32 },
  })
  for (const id of ['vm-01', 'vm-02', 'vm-03']) {
    assert.equal(settings.get(`${VM_TEST_SCHEDULE_PREFIX}${id}`).enabled, false, 'switching off also syncs')
  }
})

test('sync with an invalid test writes nothing', async () => {
  const { settings, schedule } = runner({ list: () => [claudeVm, { id: 'vm-03', platform: 'anthropic' }] })
  await schedule.save('vm-01', { ...claudeConfig, enabled: false })
  const before = settings.all()
  for (const test of [
    { enabled: 'yes', model: 'm', prompt: 'p', max_tokens: 1 },
    { enabled: true, model: '', prompt: 'p', max_tokens: 1 },
    { enabled: true, model: 'm', prompt: 'p' },
  ]) {
    await assert.rejects(
      async () =>
        await schedule.syncSchedules({
          scope: 'all',
          schedule: normalizeScheduleStructure({ frequency: 'hourly', minute: 0, timezone: 'Asia/Shanghai' }),
          test,
        }),
    )
  }
  assert.deepEqual(settings.all(), before)
})

test('flush waits until a scheduled result finishes persisting', async () => {
  const { settings, schedule } = runner()
  await schedule.save('vm-01', claudeConfig)
  schedule.started = true
  let release
  let entered
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const writing = new Promise((resolve) => {
    entered = resolve
  })
  const originalSet = settings.set.bind(settings)
  settings.set = async (...args) => {
    entered()
    await gate
    return originalSet(...args)
  }
  const run = schedule._run('vm-01')
  await writing
  let flushed = false
  const flush = schedule.flush().then(() => {
    flushed = true
  })
  try {
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(flushed, false, 'the scheduled result is still being written')
  } finally {
    release()
    await run
    await flush
    schedule.stop()
  }
})

test('flush reports a failed scheduled result write', async () => {
  const { settings, schedule } = runner()
  await schedule.save('vm-01', claudeConfig)
  schedule.started = true
  const failure = new Error('synthetic scheduled result write failure')
  let release
  let entered
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const writing = new Promise((resolve) => {
    entered = resolve
  })
  settings.set = async () => {
    entered()
    await gate
    throw failure
  }
  const run = schedule._run('vm-01')
  run.catch(() => {})
  await writing
  const flush = schedule.flush()
  release()
  await assert.rejects(run, (error) => error === failure)
  await assert.rejects(flush, (error) => error === failure)
  schedule.stop()
})
