import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDb, getActivityCoordinator } from '../../src/lib/db/database.mjs'
import { withDatabaseActivities } from '../maintenance-fixture.mjs'
import { createRepositoryTestDatabase } from '../repository-database.mjs'
import { SharedBackgroundTasks } from '../../src/lib/core/shared-background-tasks.mjs'
import { SharedVmOperations } from '../../src/lib/vm/shared-vm-operations.mjs'
import { ExecutionAdmissionsRepo } from '../../src/lib/db/repos/execution-admissions-repo.mjs'
import {
  officialCcHome,
  readOfficialCcStatus,
  scheduleOfficialCcBootstrap,
  runOfficialCcBootstrap,
} from '../../src/lib/oauth/official-cc-bootstrap.mjs'
import { writeWorkerCredentialFile } from '../../src/lib/oauth/oauth-credentials.mjs'

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'official-shared-lifecycle-'))
  fs.mkdirSync(path.join(root, 'vms'))
  // The baseline returns before seeing this credential-less record. It cannot run a real command.
  const vm = { id: 'vm-synthetic', status: 'running', claude: { mode: 'oauth' } }
  fs.writeFileSync(path.join(root, 'vms', vm.id + '.json'), JSON.stringify(vm))
  const db = getDb()
  await withDatabaseActivities([db], () => Promise.resolve())
  const peer = await createRepositoryTestDatabase({ connectionString: db.connectionString, schema: db.schema })
  const mode = process.env.VM2API_CONTROL_PLANE_MODE
  const mock = process.env.KIN_CRS_MOCK
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  delete process.env.KIN_CRS_MOCK
  const tasks = new SharedBackgroundTasks(db)
  const operations = new SharedVmOperations(db)
  const other = new SharedVmOperations(peer)
  let finish
  const pending = new Promise((resolve) => {
    finish = resolve
  })
  const options = {
    vmId: vm.id,
    projectRoot: root,
    vm,
    manual: true,
    force: true,
    config: { resident: false },
    backgroundTasks: tasks,
    vmOperations: operations,
    runBootstrap: async () => pending,
  }
  t.after(async () => {
    finish({ ok: true })
    await tasks.flush()
    await peer.close()
    if (mode == null) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = mode
    if (mock == null) delete process.env.KIN_CRS_MOCK
    else process.env.KIN_CRS_MOCK = mock
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { db, peer, tasks, other, options, finish, vm, root }
}

function prepareRawBootstrap(f, t) {
  const home = officialCcHome(f.root, f.vm.id)
  f.vm.claude.has_access = true
  fs.writeFileSync(path.join(f.root, 'vms', f.vm.id + '.json'), JSON.stringify(f.vm))
  writeWorkerCredentialFile(home, {
    mode: 'oauth',
    access_token: 'synthetic-access',
    expires_at: '2099-01-01T00:00:00Z',
  })
  fs.mkdirSync(path.join(home, '.kin'), { recursive: true })
  fs.writeFileSync(path.join(home, '.kin', 'cli-node'), '#!/bin/sh\nprintf synthetic-version\n', { mode: 0o700 })
  const bin = path.join(f.root, 'bin')
  fs.mkdirSync(bin)
  // Every Docker call uses this synthetic executable; no daemon or VM is contacted.
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nprintf "{}"\n', { mode: 0o700 })
  const previous = process.env.PATH
  process.env.PATH = bin + path.delimiter + previous
  t.after(() => {
    process.env.PATH = previous
  })
  delete f.options.runBootstrap
  Object.assign(f.options, {
    wipe: false,
    applySeed: false,
    reconcileFingerprint: false,
    syncTelemetry: false,
    retryDelayMs: 0,
    slotOauth: async (_exec, op) => ({
      ok: true,
      attemptFinished: true,
      body: op === 'profile' ? { account: {}, organization: {} } : { data: [] },
    }),
  })
}

test('a raw bootstrap usage timeout keeps task and VM ownership and prevents a later retry', async (t) => {
  const f = await fixture(t)
  prepareRawBootstrap(f, t)
  let calls = 0
  f.options.runTurn = async ({ prompt, outFile }) => {
    if (prompt !== '/usage') return { ok: true, code: 0, timed_out: false }
    calls++
    fs.writeFileSync(
      outFile,
      calls === 1
        ? ''
        : [
            JSON.stringify({
              type: 'assistant',
              usage_report: {
                rate_limits: {
                  limits: [
                    { kind: 'session', percent: 10 },
                    { kind: 'weekly_all', percent: 30 },
                  ],
                },
              },
            }),
            JSON.stringify({ type: 'result', result: 'ok' }),
          ].join('\n'),
    )
    return calls === 1 ? { ok: false, code: null, timed_out: true } : { ok: true, code: 0, timed_out: false }
  }
  await scheduleOfficialCcBootstrap(f.options)
  await f.tasks.flush()
  assert.equal((await f.other.tryAcquire({ vmId: f.vm.id })).ok, false)
  const claim = await f.peer.prepare('SELECT unknown_at, finished_at FROM background_task_runs').get()
  assert.notEqual(claim.unknown_at, null)
  assert.equal(claim.finished_at, null)
  assert.equal(calls, 1)
})

for (const auxiliary of ['profile', 'models', 'identity', 'stats']) {
  test(`raw bootstrap reports an unknown ${auxiliary} even when hello and usage succeed`, async (t) => {
    const f = await fixture(t)
    prepareRawBootstrap(f, t)
    f.options.runTurn = async ({ prompt, outFile }) => {
      fs.writeFileSync(
        outFile,
        prompt === '/usage'
          ? JSON.stringify({ five_hour: { utilization: 0.1 }, seven_day: { utilization: 0.2 } })
          : '{}',
      )
      return { ok: true, code: 0, timed_out: false }
    }
    const call = f.options.slotOauth
    f.options.slotOauth = (exec, op) =>
      op === auxiliary
        ? { ok: false, status: 0, attemptFinished: false, body: { error: { code: 'timeout' } } }
        : call(exec, op)
    if (auxiliary === 'identity') f.options.collectIdentity = async () => ({ ok: false, error: 'synthetic timeout' })
    if (auxiliary === 'stats')
      f.options.onStats = async () => {
        throw new Error('synthetic persistence failure')
      }
    let raw
    f.options.runBootstrap = async (options) => {
      raw = await runOfficialCcBootstrap(options)
      return raw
    }
    await scheduleOfficialCcBootstrap(f.options)
    await f.tasks.flush()
    assert.equal(raw.ok, true)
    assert.equal(raw.attemptFinished, false)
    assert.equal(raw.vmOperationUncertain, true)
    assert.equal((await f.other.tryAcquire({ vmId: f.vm.id })).ok, false)
    assert.equal((await f.peer.prepare('SELECT finished_at FROM background_task_runs').get()).finished_at, null)
  })
}

for (const rejectProfile of [false, true]) {
  test(`raw bootstrap releases after confirmed foreground completion (profile rejected: ${rejectProfile})`, async (t) => {
    const f = await fixture(t)
    prepareRawBootstrap(f, t)
    f.options.runTurn = async ({ prompt, outFile }) => {
      fs.writeFileSync(
        outFile,
        prompt === '/usage'
          ? JSON.stringify({ five_hour: { utilization: 0.1 }, seven_day: { utilization: 0.2 } })
          : '{}',
      )
      return { ok: true, code: 0, timed_out: false, attemptFinished: true }
    }
    if (rejectProfile) {
      const call = f.options.slotOauth
      f.options.slotOauth = (exec, op) =>
        op === 'profile'
          ? { ok: false, status: 403, attemptFinished: true, body: { error: { code: 'permission_denied' } } }
          : call(exec, op)
    }
    let raw
    f.options.runBootstrap = async (options) => {
      raw = await runOfficialCcBootstrap(options)
      return raw
    }
    await scheduleOfficialCcBootstrap(f.options)
    await f.tasks.flush()
    assert.equal(raw.ok, true)
    assert.equal(raw.attemptFinished, true)
    assert.equal(raw.status.attempt_finished, true)
    assert.equal(raw.vmOperationUncertain, false)
    const next = await f.other.tryAcquire({ vmId: f.vm.id })
    assert.equal(next.ok, true)
    await next.release()
    assert.notEqual((await f.peer.prepare('SELECT finished_at FROM background_task_runs').get()).finished_at, null)
  })
}

test('manual bootstrap rejects a busy VM before queued status or background effects are written', async (t) => {
  const f = await fixture(t)
  await new ExecutionAdmissionsRepo(f.peer).tryReserve({
    vmId: f.vm.id,
    accountId: 'synthetic',
    vmLimit: 1,
    accountLimit: 1,
    fableLimit: 0,
    rpmLimit: 0,
  })
  await assert.rejects(async () => scheduleOfficialCcBootstrap(f.options), { code: 'vm_execution_active' })
  assert.equal(readOfficialCcStatus(officialCcHome(f.root, f.vm.id)), null)
})

test('scheduled bootstrap keeps an independent activity and VM claim until the original promise completes', async (t) => {
  const f = await fixture(t)
  const scheduled = await scheduleOfficialCcBootstrap(f.options)
  assert.equal(scheduled.scheduled, true)
  assert.equal(
    (await f.peer.prepare('SELECT count(*) AS n FROM background_task_runs WHERE finished_at IS NULL').get()).n,
    1,
  )
  assert.equal((await f.other.tryAcquire({ vmId: f.vm.id })).ok, false)
  const coordinator = getActivityCoordinator(f.db)
  assert.equal(
    (
      await f.db.pool.query(
        `SELECT count(*) AS n FROM ${coordinator.qualified}.activities WHERE kind='background' AND completed_at IS NULL`,
      )
    ).rows[0].n,
    1,
  )
  let drained = false
  const flush = f.tasks.flush().then(() => {
    drained = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(drained, false)
  f.finish({ ok: true })
  await flush
  const next = await f.other.tryAcquire({ vmId: f.vm.id })
  assert.equal(next.ok, true)
  await next.release()
  assert.equal(
    (await f.peer.prepare('SELECT count(*) AS n FROM background_task_runs WHERE finished_at IS NULL').get()).n,
    0,
  )
})

test('ordinary error and timeout results keep bootstrap task and VM ownership without TTL', async (t) => {
  const f = await fixture(t)
  await scheduleOfficialCcBootstrap(f.options)
  f.finish({ ok: false, timed_out: true, error: 'synthetic timeout' })
  await f.tasks.flush()
  assert.equal((await f.other.tryAcquire({ vmId: f.vm.id })).ok, false)
  const claim = await f.peer.prepare('SELECT unknown_at, finished_at FROM background_task_runs').get()
  assert.notEqual(claim.unknown_at, null)
  assert.equal(claim.finished_at, null)
})

test('a normally returned bootstrap error remains unknown even without a timeout flag', async (t) => {
  const f = await fixture(t)
  await scheduleOfficialCcBootstrap(f.options)
  f.finish({ ok: false, error: 'synthetic worker ACK missing' })
  await f.tasks.flush()
  assert.equal((await f.other.tryAcquire({ vmId: f.vm.id })).ok, false)
})

test('a successful response with an unknown auxiliary operation retains ownership', async (t) => {
  const f = await fixture(t)
  await scheduleOfficialCcBootstrap(f.options)
  f.finish({ ok: true, vmOperationUncertain: true })
  await f.tasks.flush()
  assert.equal((await f.other.tryAcquire({ vmId: f.vm.id })).ok, false)
})

test('successful hello with an auxiliary profile timeout still retains ownership', async (t) => {
  const f = await fixture(t)
  await scheduleOfficialCcBootstrap(f.options)
  f.finish({ ok: true, status: { profile_error: 'synthetic timeout', models_error: null } })
  await f.tasks.flush()
  assert.equal((await f.other.tryAcquire({ vmId: f.vm.id })).ok, false)
})

test('the real bootstrap can release a credential validation failure before any command is sent', async (t) => {
  const f = await fixture(t)
  delete f.options.runBootstrap
  await scheduleOfficialCcBootstrap(f.options)
  await f.tasks.flush()
  const next = await f.other.tryAcquire({ vmId: f.vm.id })
  assert.equal(next.ok, true)
  await next.release()
})

test('successful bootstrap keeps ownership until queued persistence has completed', async (t) => {
  const f = await fixture(t)
  let finishFlush
  let enteredFlush
  const flushing = new Promise((resolve) => {
    finishFlush = resolve
  })
  const entered = new Promise((resolve) => {
    enteredFlush = resolve
  })
  f.options.flush = async () => {
    enteredFlush()
    await flushing
  }
  await scheduleOfficialCcBootstrap(f.options)
  f.finish({ ok: true })
  await entered
  try {
    assert.equal((await f.other.tryAcquire({ vmId: f.vm.id })).ok, false)
  } finally {
    finishFlush()
  }
  await f.tasks.flush()
  const next = await f.other.tryAcquire({ vmId: f.vm.id })
  assert.equal(next.ok, true)
  await next.release()
})
