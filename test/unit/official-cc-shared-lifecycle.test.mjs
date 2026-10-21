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
} from '../../src/lib/oauth/official-cc-bootstrap.mjs'

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
    '1',
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
