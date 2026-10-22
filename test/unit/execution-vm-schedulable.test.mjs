import test from 'node:test'
import assert from 'node:assert/strict'
import { getDb } from '../../src/lib/db/database.mjs'
import { VmsRepo } from '../../src/lib/db/repos/vms-repo.mjs'
import { ExecutionAdmissionsRepo } from '../../src/lib/db/repos/execution-admissions-repo.mjs'
import { SharedVmOperations } from '../../src/lib/vm/shared-vm-operations.mjs'
import { createRepositoryTestDatabase } from '../repository-database.mjs'

const input = (vmId) => ({ vmId, accountId: 'synthetic', accountLimit: 2, vmLimit: 2, rpmLimit: 0, fableLimit: 0 })

async function fixture(t) {
  const db = getDb()
  const peer = await createRepositoryTestDatabase({ connectionString: db.connectionString, schema: db.schema })
  t.after(() => peer.close())
  return {
    db,
    peer,
    vms: new VmsRepo(peer),
    admissions: new ExecutionAdmissionsRepo(db),
    operations: new SharedVmOperations(peer),
  }
}

test('a candidate read before a completed hold cannot reserve after its claim is released', async (t) => {
  const f = await fixture(t)
  await f.vms.upsertFromVmJson({ id: 'vm-synthetic', status: 'running', schedulable: true })
  const candidate = input('vm-synthetic')
  const hold = await f.operations.tryAcquire({ vmId: candidate.vmId })
  await f.vms.upsertFromVmJson({ id: candidate.vmId, status: 'running', schedulable: false })
  await hold.release()
  const result = await f.admissions.tryReserve(candidate)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'vm_not_schedulable')
})

test('every physical alias record must be schedulable regardless of node placement', async (t) => {
  const f = await fixture(t)
  await f.vms.upsertFromVmJson({ id: 'vm-synthetic', node_id: 'node-a', status: 'running', schedulable: true })
  await f.vms.upsertFromVmJson({ id: 'synthetic', node_id: 'node-b', status: 'running', schedulable: false })
  for (const id of ['synthetic', 'vm-synthetic']) {
    const result = await f.admissions.tryReserve(input(id))
    assert.equal(result.ok, false)
    assert.equal(result.code, 'vm_not_schedulable')
  }
})

test('re-enabling the committed record admits the next request', async (t) => {
  const f = await fixture(t)
  await f.vms.upsertFromVmJson({ id: 'vm-synthetic', status: 'running', schedulable: false })
  assert.equal((await f.admissions.tryReserve(input('vm-synthetic'))).ok, false)
  await f.vms.upsertFromVmJson({ id: 'vm-synthetic', status: 'running', schedulable: true })
  const result = await f.admissions.tryReserve(input('vm-synthetic'))
  assert.equal(result.ok, true)
  await result.release()
})

test('repo-only callers without mirrored VM metadata keep their existing admission behavior', async (t) => {
  const f = await fixture(t)
  const result = await f.admissions.tryReserve(input('vm-synthetic'))
  assert.equal(result.ok, true)
  await result.release()
})
