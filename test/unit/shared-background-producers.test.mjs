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
