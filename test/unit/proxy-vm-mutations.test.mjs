import test from 'node:test'
import assert from 'node:assert/strict'
import { getDb } from '../../src/lib/db/database.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { SharedVmOperations } from '../../src/lib/vm/shared-vm-operations.mjs'
import { withVmMutations } from '../../src/lib/vm/vm-mutations.mjs'
import { createRepositoryTestDatabase } from '../repository-database.mjs'

async function fixture(t, { bound = ['vm-a'] } = {}) {
  const savedMode = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'standalone'
  const db = getDb()
  const peer = await createRepositoryTestDatabase({ connectionString: db.connectionString, schema: db.schema })
  const first = await new ProxyPool({ db }).init()
  const second = await new ProxyPool({ db: peer }).init()
  const imported = await first.importLines('192.0.2.1:1080')
  const id = imported.items[0].id
  for (const vmId of bound) await first.bind(id, vmId)
  await second.refresh()
  for (const pool of [first, second]) pool.stopScheduler()
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  t.after(async () => {
    first.stopScheduler()
    second.stopScheduler()
    if (savedMode == null) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = savedMode
    await peer.close()
  })
  return {
    db,
    peer,
    first,
    second,
    id,
    operations: new SharedVmOperations(db, { ownerId: 'same-controller-owner' }),
    otherOperations: new SharedVmOperations(peer, { ownerId: 'same-controller-owner' }),
  }
}

test('a bound proxy connection edit requires current VM operation claims', async (t) => {
  const f = await fixture(t)
  await assert.rejects(f.first.update(f.id, { port: 2080 }), { code: 'vm_mutation_claim_required' })
  assert.equal((await f.first.repo.getById(f.id)).port, 1080)
})

test('the current exact claim permits a bound proxy edit and nested VM mutation', async (t) => {
  const f = await fixture(t)
  await f.operations.run('vm-a', async () => {
    assert.equal((await f.first.update(f.id, { port: 2080 })).ok, true)
    await f.otherOperations.run('vm-a', async () => {
      assert.equal((await f.second.update(f.id, { label: 'synthetic' })).ok, true)
    })
  })
  assert.equal((await f.first.repo.getById(f.id)).port, 2080)
})

test('the same owner ID in another request cannot authorize a foreign active claim', async (t) => {
  const f = await fixture(t)
  let finish
  let entered
  const pending = new Promise((resolve) => {
    finish = resolve
  })
  const ready = new Promise((resolve) => {
    entered = resolve
  })
  const editing = f.operations.run('vm-a', async () => {
    entered()
    await pending
  })
  await ready
  try {
    await f.otherOperations.run('vm-new', async () => {
      await assert.rejects(f.second.bind(f.id, 'vm-new'), { code: 'vm_operation_active' })
    })
  } finally {
    finish()
    await editing
  }
  assert.deepEqual(f.first.snapshot().proxies[0].bound_vm_ids, ['vm-a'])
})

test('the PostgreSQL binding set is rechecked after a stale replica selected its lock set', async (t) => {
  const f = await fixture(t)
  await f.otherOperations.run('vm-b', () => f.second.bind(f.id, 'vm-b'))
  await f.operations.run('vm-a', async () => {
    await assert.rejects(f.first.update(f.id, { port: 2080 }), { code: 'vm_mutation_claim_required' })
  })
  assert.equal((await f.first.repo.getById(f.id)).port, 1080)
})

test('a stale empty-proxy removal cannot delete a newly bound VM outside its claim set', async (t) => {
  const f = await fixture(t, { bound: [] })
  await f.otherOperations.run('vm-new', () => f.second.bind(f.id, 'vm-new'))
  await assert.rejects(f.first.remove(f.id), { code: 'vm_mutation_claim_required' })
  assert.ok(await f.first.repo.getById(f.id))
})

test('physical alias operations block a new binding even across node identities', async (t) => {
  const f = await fixture(t)
  const alias = await f.operations.tryAcquire({ vmId: 'a', nodeId: 'node-a' })
  await alias.markUncertain()
  await f.otherOperations.run('vm-new', async () => {
    await assert.rejects(f.second.bind(f.id, 'vm-new'), { code: 'vm_operation_active' })
  })
})

test('an uncertain current operation cannot send another proxy mutation', async (t) => {
  const f = await fixture(t)
  await f.operations.run('vm-a', async (operation) => {
    await operation.markUncertain()
    await assert.rejects(f.first.update(f.id, { port: 2080 }))
  })
  assert.equal((await f.first.repo.getById(f.id)).port, 1080)
})

test('detached work cannot reuse a callback claim after it has returned', async (t) => {
  const f = await fixture(t)
  let run
  const pending = new Promise((resolve) => {
    run = resolve
  })
  let descendant
  await f.operations.run('vm-a', async () => {
    descendant = pending.then(() => f.first.update(f.id, { port: 2080 }))
  })
  run()
  await assert.rejects(descendant, { code: 'vm_mutation_claim_required' })
})

test('global proxy settings require the complete current binding set', async (t) => {
  const f = await fixture(t, { bound: ['vm-a', 'vm-b'] })
  await f.operations.run('vm-a', async () => {
    await assert.rejects(f.first.updateConfig({ dns_primary: '1.1.1.1' }), { code: 'vm_mutation_claim_required' })
  })
  await withVmMutations(
    '/synthetic',
    ['vm-b', 'vm-a'],
    async () => {
      assert.equal((await f.first.updateConfig({ dns_primary: '1.1.1.1' })).ok, true)
    },
    { operations: f.operations },
  )
})
