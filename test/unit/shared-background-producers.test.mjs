import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDb, createDatabase } from '../../src/lib/db/database.mjs'
import { RuntimeSettings, loadSettingsState } from '../../src/lib/db/settings-state.mjs'
import { SharedBackgroundTasks } from '../../src/lib/core/shared-background-tasks.mjs'
import { createHealthProbeMonitor, cachedClaudeMessage } from '../../src/lib/admin/health-probe.mjs'
import { createCredentialRefreshMonitor } from '../../src/lib/oauth/credential-refresh-monitor.mjs'
import { createUsageProbeMonitor } from '../../src/lib/oauth/usage-probe-monitor.mjs'
import { BackupService } from '../../src/lib/admin/backup-service.mjs'
import { VmTestScheduleRunner, VM_TEST_SCHEDULE_PREFIX } from '../../src/lib/admin/vm-test-schedule.mjs'
import { SharedRoutingConfig } from '../../src/lib/admin/shared-routing-config.mjs'
import { RoutingConfigRepo } from '../../src/lib/db/repos/routing-config-repo.mjs'

const live = {
  id: 'vm-synthetic',
  status: 'running',
  schedulable: true,
  has_token: true,
  has_refresh: true,
  expires_at: 1,
  proxy: { host: '127.0.0.1', port: 9, url: 'socks5://127.0.0.1:9' },
}

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture(t) {
  const db = getDb()
  const other = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  t.after(() => other.close())
  const first = new SharedBackgroundTasks(db, { ownerId: 'pod-a' })
  const second = new SharedBackgroundTasks(other, { ownerId: 'pod-b' })
  return { db, other, first, second }
}

test('two health monitors execute one plan and share only approved snapshot fields', async (t) => {
  const f = await fixture(t)
  let calls = 0
  const opts = {
    config: { enabled: true },
    listTargets: () => [live],
    runChat: async () => {
      calls++
      return {
        ok: true,
        status: 200,
        text: 'synthetic-health',
        headers: { authorization: 'synthetic-private' },
        body: {
          id: 'msg_synthetic',
          model: 'claude-haiku-4-5',
          content: [{ type: 'text', text: 'synthetic-health' }],
          usage: { input_tokens: 3, output_tokens: 2, provider_extension: { secret: 'synthetic-private' } },
          stop_reason: 'stop_sequence',
          stop_sequence: 'synthetic-stop',
        },
      }
    },
  }
  const first = createHealthProbeMonitor({ ...opts, sharedTasks: f.first })
  const second = createHealthProbeMonitor({ ...opts, sharedTasks: f.second })
  await first.runRealProbe()
  await second.runRealProbe()
  assert.equal(calls, 1)
  const body = cachedClaudeMessage(second.rawSnapshot())
  assert.equal(body.id, 'msg_synthetic')
  assert.equal(body.usage.output_tokens, 2)
  assert.equal(body.stop_reason, 'stop_sequence')
  assert.equal(body.stop_sequence, 'synthetic-stop')
  const row = await f.other.prepare('SELECT shared_result FROM background_task_runs').get()
  assert.equal(JSON.stringify(row.shared_result).includes('synthetic-private'), false)
})

test('credential refresh plans deduplicate across monitors and never persist the callback result', async (t) => {
  const f = await fixture(t)
  let calls = 0
  const opts = {
    listTargets: () => [live],
    refreshOne: async () => {
      calls++
      return { ok: true, access_token: 'synthetic-private' }
    },
  }
  await createCredentialRefreshMonitor({ ...opts, sharedTasks: f.first }).runOnce()
  await createCredentialRefreshMonitor({ ...opts, sharedTasks: f.second }).runOnce()
  assert.equal(calls, 1)
  assert.equal((await f.other.prepare('SELECT shared_result FROM background_task_runs').get()).shared_result, null)
})

test('a normal credential error remains unknown and cannot be retried by another monitor', async (t) => {
  const f = await fixture(t)
  let calls = 0
  const opts = {
    listTargets: () => [live],
    refreshOne: async () => {
      calls++
      return { ok: false, refresh_class: 'retryable' }
    },
  }
  await createCredentialRefreshMonitor({ ...opts, sharedTasks: f.first }).runOnce()
  await createCredentialRefreshMonitor({ ...opts, sharedTasks: f.second }).runOnce()
  assert.equal(calls, 1)
  const row = await f.other.prepare('SELECT unknown_at, finished_at FROM background_task_runs').get()
  assert.ok(row.unknown_at)
  assert.equal(row.finished_at, null)
})

test('Kubernetes health uses the default shared service and refreshes routing before executing', async (t) => {
  const f = await fixture(t)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-health-routing-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'routing.json')
  fs.writeFileSync(file, JSON.stringify({ health_probe: { enabled: true, real: { prompt: 'old prompt' } } }))
  const previousMode = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  t.after(() => {
    if (previousMode === undefined) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = previousMode
  })
  let monitor
  const routing = new SharedRoutingConfig({
    db: f.db,
    file,
    normalize: (value) => value,
    merge: (current, patch) => ({ ...current, ...patch }),
    apply: (config) => monitor?.setConfig(config.health_probe, { restart: false }),
  })
  await routing.init()
  monitor = createHealthProbeMonitor({
    config: { enabled: true, real: { prompt: 'old prompt' } },
    listTargets: () => [live],
    runChat: async (_vm, config) => {
      assert.equal(config.prompt, 'new prompt')
      return { ok: true, text: 'synthetic', body: { id: 'synthetic-message' } }
    },
  })
  await new RoutingConfigRepo(f.other).patch((current) => ({
    ...current,
    health_probe: { enabled: true, real: { prompt: 'new prompt' } },
  }))
  assert.equal((await monitor.runRealProbe()).ok, true)
  assert.equal((await f.other.prepare('SELECT count(*) AS n FROM background_task_runs').get()).n, 1)
})

test('usage timer and event probes share one persisted VM task plan across monitors', async (t) => {
  const f = await fixture(t)
  let calls = 0
  const opts = {
    config: { enabled: true },
    listTargets: () => [live],
    probeOne: async () => {
      calls++
      return { ok: true, source: 'synthetic-usage' }
    },
  }
  await createUsageProbeMonitor({ ...opts, sharedTasks: f.first }).runOnce()
  await createUsageProbeMonitor({ ...opts, sharedTasks: f.second }).probeNow(live.id)
  assert.equal(calls, 1)
})

test('usage reconcile is awaited before the probe callback', async (t) => {
  await fixture(t)
  const entered = deferred()
  const finish = deferred()
  let reconciled = false
  let calls = 0
  const monitor = createUsageProbeMonitor({
    listTargets: () => [live],
    reconcile: async () => {
      entered.resolve()
      await finish.promise
      reconciled = true
    },
    probeOne: async () => {
      assert.equal(reconciled, true)
      calls++
      return { ok: true }
    },
  })
  const pending = monitor.runOnce()
  await entered.promise
  try {
    assert.equal(calls, 0)
  } finally {
    finish.resolve()
    await pending
  }
  assert.equal(calls, 1)
})

test('usage timeout keeps the shared claim and flush waits for the original operation', async (t) => {
  const f = await fixture(t)
  const originalTimeout = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) =>
    originalTimeout(callback, ms === 10_000 ? 5 : ms, ...args),
  )
  const finish = deferred()
  let calls = 0
  const opts = {
    config: { timeout_ms: 10_000 },
    listTargets: () => [live],
    probeOne: async () => {
      calls++
      await finish.promise
      return { ok: true }
    },
  }
  const first = createUsageProbeMonitor({ ...opts, sharedTasks: f.first })
  const second = createUsageProbeMonitor({ ...opts, sharedTasks: f.second })
  await first.probeNow(live.id)
  let flushed = false
  const flushing = first.flush().then(() => {
    flushed = true
  })
  try {
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(flushed, false)
    await second.probeNow(live.id)
    assert.equal(calls, 1)
  } finally {
    finish.resolve()
    await flushing
  }
  assert.equal(
    (await f.other.prepare('SELECT count(*) AS n FROM background_task_runs WHERE finished_at IS NULL').get()).n,
    1,
  )
})

test('stop prevents an already queued immediate monitor run from sending a new task', async (t) => {
  const f = await fixture(t)
  let calls = 0
  const monitor = createCredentialRefreshMonitor({
    sharedTasks: f.first,
    listTargets: () => [live],
    refreshOne: async () => {
      calls++
      return { ok: true }
    },
  })
  monitor.start({ immediate: true })
  monitor.stop()
  await new Promise((resolve) => setImmediate(resolve))
  await monitor.flush()
  assert.equal(calls, 0)
})

test('scheduled backups execute once across services without touching business files', async (t) => {
  const f = await fixture(t)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-bg-backup-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let calls = 0
  const services = [f.first, f.second].map((sharedTasks) => {
    const backup = new BackupService({ dataDir: root, sharedTasks })
    backup.getSchedule = async () => ({ enabled: true, interval_hours: 24, retention: 7 })
    backup.shouldRunScheduled = async () => true
    backup.createBackup = async () => {
      calls++
      return { status: 'ok', size_bytes: 0 }
    }
    return backup
  })
  await Promise.all(services.map((backup) => backup.runScheduled()))
  assert.equal(calls, 1)
})

async function schedules(t) {
  const f = await fixture(t)
  const settings = new RuntimeSettings(f.db)
  await loadSettingsState(f.other)
  const manager = new RuntimeSettings(f.other)
  let calls = 0
  const create = (store, tasks, runTest = async () => ({ ok: true })) =>
    new VmTestScheduleRunner({
      projectRoot: '/synthetic-missing-project',
      settings: store,
      sharedTasks: tasks,
      list: () => [live],
      runTest: async () => {
        calls++
        return runTest()
      },
    })
  const first = create(settings, f.first)
  await first.save(live.id, {
    enabled: true,
    frequency: 'daily',
    time: '09:00',
    timezone: 'UTC',
    model: 'claude-haiku-4-5',
    prompt: 'synthetic',
    max_tokens: 16,
  })
  await manager.refresh()
  const second = create(manager, f.second)
  await first.start()
  await second.start()
  t.after(() => {
    first.stop()
    second.stop()
  })
  return { ...f, first, second, settings, manager, calls: () => calls, create }
}

test('scheduled VM tests use one occurrence ID across controllers', async (t) => {
  const f = await schedules(t)
  await Promise.all([f.first._run(live.id), f.second._run(live.id)])
  assert.equal(f.calls(), 1)
})

test('a stale scheduled VM plan is refreshed and validated before invoking its callback', async (t) => {
  const f = await schedules(t)
  const key = `${VM_TEST_SCHEDULE_PREFIX}${live.id}`
  await f.manager.set(key, { ...f.manager.get(key), revision: 'changed-by-other-controller', enabled: false })
  await f.first._run(live.id)
  assert.equal(f.calls(), 0)
})

test('late VM test results cannot replace a concurrently changed schedule', async (t) => {
  const f = await schedules(t)
  const key = `${VM_TEST_SCHEDULE_PREFIX}${live.id}`
  const old = f.settings.get(key)
  f.first.runTest = async () => {
    await f.manager.set(key, { ...old, revision: 'changed-by-other-controller', prompt: 'new prompt' })
    return { ok: true }
  }
  await f.first._run(live.id)
  await f.manager.refresh()
  assert.equal(f.manager.get(key).prompt, 'new prompt')
  assert.equal(f.manager.get(key).revision, 'changed-by-other-controller')
})

test('VM schedule result SQL patches only the matching revision and preserves other fields', async (t) => {
  const f = await schedules(t)
  const { VmTestScheduleResultsRepo } = await import('../../src/lib/db/repos/vm-test-schedule-results-repo.mjs')
  const repo = new VmTestScheduleResultsRepo(f.db)
  const key = `${VM_TEST_SCHEDULE_PREFIX}${live.id}`
  const before = f.settings.get(key)
  const result = { last_run_at: new Date().toISOString(), last_ok: true, last_duration_ms: 3, last_error: null }
  assert.equal(await repo.record(live.id, before.revision, result), true)
  await f.manager.refresh()
  assert.equal(f.manager.get(key).prompt, before.prompt)
  await f.manager.set(key, { ...f.manager.get(key), revision: 'new-revision', prompt: 'new prompt' })
  assert.equal(await repo.record(live.id, before.revision, { ...result, last_ok: false }), false)
  await f.manager.refresh()
  assert.equal(f.manager.get(key).prompt, 'new prompt')
  assert.equal(f.manager.get(key).last_ok, true)
})

test('a controller discovers remote schedule creation, updates and deletion using its lifecycle poll', async (t) => {
  const f = await fixture(t)
  const polls = []
  const originalInterval = globalThis.setInterval
  t.mock.method(globalThis, 'setInterval', (callback, ms, ...args) => {
    if (ms !== 1000) return originalInterval(callback, ms, ...args)
    const timer = { callback, unref() {} }
    polls.push(timer)
    return timer
  })
  const originalClear = globalThis.clearInterval
  t.mock.method(globalThis, 'clearInterval', (timer) => {
    if (timer?.callback) timer.stopped = true
    else originalClear(timer)
  })
  const settings = new RuntimeSettings(f.db)
  await loadSettingsState(f.other)
  const manager = new RuntimeSettings(f.other)
  let calls = 0
  const create = (store, sharedTasks) =>
    new VmTestScheduleRunner({
      projectRoot: '/synthetic-missing',
      settings: store,
      sharedTasks,
      list: () => [live],
      runTest: async () => {
        calls++
        return { ok: true }
      },
    })
  const writer = create(manager, f.second)
  const observer = create(settings, f.first)
  await observer.start()
  t.after(() => observer.stop())
  assert.equal(polls.length, 1)
  const config = {
    enabled: true,
    frequency: 'daily',
    time: '09:00',
    timezone: 'UTC',
    model: 'claude-haiku-4-5',
    prompt: 'synthetic',
    max_tokens: 16,
  }
  await writer.save(live.id, config)
  assert.equal(observer.jobs.has(live.id), false)
  await polls[0].callback()
  assert.equal(observer.jobs.get(live.id).getPattern(), '0 9 * * *')
  let clock = await f.first.now()
  f.first.now = async () => clock
  await observer._run(live.id)
  await writer.stop()
  clock += 24 * 3600_000
  await observer._run(live.id)
  assert.equal(calls, 2)
  await writer.save(live.id, { ...config, time: '12:30' })
  await polls[0].callback()
  assert.equal(observer.jobs.get(live.id).getPattern(), '30 12 * * *')
  await writer.remove(live.id)
  await polls[0].callback()
  assert.equal(observer.jobs.has(live.id), false)
  await observer.stop()
  assert.equal(polls[0].stopped, true)
})

test('a late discovery cannot replace a job accepted by a newer discovery', async (t) => {
  const f = await schedules(t)
  const oldRead = f.first.resultRepo.listPlans.bind(f.first.resultRepo)
  const entered = deferred()
  const finish = deferred()
  let reads = 0
  f.first.resultRepo.listPlans = async () => {
    const snapshot = await oldRead()
    if (++reads === 1) {
      entered.resolve()
      await finish.promise
    }
    return snapshot
  }
  const older = f.first.reload()
  await entered.promise
  const key = `${VM_TEST_SCHEDULE_PREFIX}${live.id}`
  await f.manager.set(key, { ...f.manager.get(key), revision: 'new-revision', time: '12:30', cron: '30 12 * * *' })
  await f.first.reload()
  const accepted = f.first.jobs.get(live.id)
  finish.resolve()
  await older
  assert.equal(f.first.jobs.get(live.id), accepted)
})

test('a late discovery cannot replace a locally saved schedule revision', async (t) => {
  const f = await schedules(t)
  const read = f.first.resultRepo.listPlans.bind(f.first.resultRepo)
  const entered = deferred()
  const finish = deferred()
  f.first.resultRepo.listPlans = async () => {
    const snapshot = await read()
    entered.resolve()
    await finish.promise
    return snapshot
  }
  const older = f.first.reload()
  await entered.promise
  await f.first.save(live.id, { ...f.first.get(live.id), time: '12:30' })
  const accepted = f.first.jobs.get(live.id)
  finish.resolve()
  await older
  assert.equal(f.first.jobs.get(live.id), accepted)
})

test('stop awaits its pending discovery and does not publish jobs after stopping', async (t) => {
  const f = await schedules(t)
  const read = f.first.resultRepo.listPlans.bind(f.first.resultRepo)
  const entered = deferred()
  const finish = deferred()
  f.first.resultRepo.listPlans = async () => {
    const snapshot = await read()
    entered.resolve()
    await finish.promise
    return snapshot
  }
  const discovering = f.first.reload()
  await entered.promise
  let stopped = false
  const stopping = Promise.resolve(f.first.stop()).then(() => {
    stopped = true
  })
  try {
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(stopped, false)
  } finally {
    finish.resolve()
    await Promise.all([discovering, stopping])
  }
  assert.equal(f.first.jobs.size, 0)
})

test('removing or revising a schedule never frees an unknown execution claim', async (t) => {
  const f = await schedules(t)
  f.first.runTest = async () => ({ ok: false, error: 'synthetic unknown' })
  await f.first._run(live.id)
  const key = `${VM_TEST_SCHEDULE_PREFIX}${live.id}`
  const plan = f.settings.get(key)
  await f.manager.remove(key)
  await f.first.reload()
  await f.manager.set(key, { ...plan, revision: 'recreated-plan' })
  await f.second.reload()
  await f.second._run(live.id)
  assert.equal(f.calls(), 0)
  assert.equal(
    (await f.db.prepare('SELECT count(*) AS n FROM background_task_runs WHERE finished_at IS NULL').get()).n,
    1,
  )
})
