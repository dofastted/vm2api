import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDb } from '../../src/lib/db/database.mjs'
import { createRepositoryTestDatabase } from '../repository-database.mjs'
import { withDatabaseActivities } from '../maintenance-fixture.mjs'
import { SharedVmOperations } from '../../src/lib/vm/shared-vm-operations.mjs'
import { getSharedBackgroundTasks } from '../../src/lib/core/shared-background-tasks.mjs'
import { BackgroundTaskRunsRepo } from '../../src/lib/db/repos/background-task-runs-repo.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

const TASK_KEY = 'vm_artifact_mutation'
const elf = Buffer.alloc(64)
elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
elf.writeUInt16LE(62, 18)

async function fixture(t, { empty = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-vm-artifacts-'))
  fs.mkdirSync(path.join(root, 'vms'))
  if (!empty)
    fs.writeFileSync(
      path.join(root, 'vms', 'vm-a.json'),
      JSON.stringify({ id: 'vm-a', status: 'stopped', inference_engine: 'go' }),
    )
  const db = getDb()
  await withDatabaseActivities([db], () => Promise.resolve())
  const peer = await createRepositoryTestDatabase({ connectionString: db.connectionString, schema: db.schema })
  const mode = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  const tasks = getSharedBackgroundTasks(db)
  t.after(async () => {
    await tasks.flush()
    await peer.close()
    if (mode == null) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = mode
    fs.rmSync(root, { recursive: true, force: true })
  })
  const other = new SharedVmOperations(peer)
  function handler(body = {}, extra = {}) {
    const response = {}
    const handle = createPanelHandler({
      cfg: { paths: { project: root } },
      routingConfig: {},
      vmOperations: new SharedVmOperations(db),
      backgroundTasks: tasks,
      proxyPool: { refresh: async () => {} },
      requireAuth(req) {
        req.apiKeyKind = 'master'
        req.panelRole = 'admin'
        return true
      },
      json(_res, status, payload) {
        response.status = status
        response.body = payload
        return true
      },
      readBody: async () => body,
      readRawBody: async () => elf,
      fetchImpl: async () => {
        throw new Error('synthetic no network')
      },
      persistRoutingPatch: async () => {},
      ...extra,
    })
    return { response, request: (route) => handle({ method: 'POST' }, {}, new URL('http://localhost' + route)) }
  }
  return { root, db, peer, tasks, other, handler }
}

for (const [route, body] of [
  ['/api/panel/dataplane', { dataplane: 'wrap' }],
  ['/api/panel/wrap-cli/crag-kernel', {}],
  ['/api/panel/wrap-cli/make', {}],
  ['/api/panel/wrap-cli/kernel/release', { tag: 'v1.2.3' }],
  ['/api/panel/wrap-cli/kernel', {}],
  ['/api/panel/wrap-cli/sync', {}],
  ['/api/panel/vms/vm-a/wrap-cli/promote', {}],
]) {
  test(`artifact ${route} claims affected VMs before its first file or remote effect`, async (t) => {
    const f = await fixture(t)
    await f.other.tryAcquire({ vmId: 'vm-a' })
    const h = f.handler(body)
    await h.request(route)
    assert.equal(h.response.status, 409, JSON.stringify(h.response.body))
    assert.equal(fs.existsSync(path.join(f.root, 'share')), false)
    assert.equal(fs.existsSync(path.join(f.root, 'bin')), false)
  })
}

test('an empty fleet still respects a persistent artifact owner', async (t) => {
  const f = await fixture(t, { empty: true })
  await new BackgroundTaskRunsRepo(f.peer).tryClaim({ taskKey: TASK_KEY, executionId: 'foreign', ownerId: 'synthetic' })
  const h = f.handler()
  await h.request('/api/panel/wrap-cli/kernel')
  assert.equal(h.response.status, 409)
  assert.equal(h.response.body.error.code, 'vm_artifact_operation_active')
  assert.equal(fs.existsSync(path.join(f.root, 'share')), false)
})

test('an idle artifact upload completes its durable operation and releases VM ownership', async (t) => {
  const f = await fixture(t)
  const h = f.handler()
  await h.request('/api/panel/wrap-cli/kernel')
  assert.equal(h.response.status, 200, JSON.stringify(h.response.body))
  const row = await f.peer
    .prepare('SELECT finished_at, unknown_at FROM background_task_runs WHERE task_key = $1')
    .get(TASK_KEY)
  assert.notEqual(row?.finished_at, null)
  assert.equal(row?.unknown_at, null)
  const next = await f.other.tryAcquire({ vmId: 'vm-a' })
  assert.equal(next.ok, true)
  await next.release()
})
