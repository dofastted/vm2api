import test from 'node:test'
import assert from 'node:assert/strict'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { createVmPool, deleteVmPool, updateVmPool } from '../../src/lib/admin/vm-pools.mjs'
import { applyVmPool, keyScopeFromRecord } from '../../src/lib/admin/key-scope.mjs'
import { VmPoolsRepo } from '../../src/lib/db/repos/vm-pools-repo.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const vms = [{ id: 'vm-01' }, { id: 'vm-02' }, { id: 'vm-03' }]

function open() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-pools-'))
  const store = new ApiKeyStore({ dataDir: dir })
  return { dir, store, repo: new VmPoolsRepo(store.db) }
}

test('pool membership is shared by keys and applied on the next read', async () => {
  const { dir, store, repo } = open()
  try {
    const pool = await createVmPool(repo, { name: 'Pool A', vm_ids: ['vm-01', 'vm-02'] }, vms)
    const key = await store.create({ name: 'a', vm_pool_id: pool.id })
    const other = await store.create({ name: 'b', vm_pool_id: pool.id })
    assert.equal(key.vm_pool_id, pool.id)
    assert.equal(other.vm_pool_id, pool.id)
    const before = await applyVmPool(keyScopeFromRecord(await store.getById(key.id)), async (id) => await repo.get(id))
    assert.deepEqual(before.allowed_vms, ['vm-01', 'vm-02'])
    await updateVmPool(repo, pool.id, { vm_ids: ['vm-03'] }, vms)
    const after = await applyVmPool(keyScopeFromRecord(await store.getById(other.id)), async (id) => await repo.get(id))
    assert.deepEqual(after.allowed_vms, ['vm-03'])
    assert.equal(after.vm_pool_error, null)
    await assert.rejects(async () => await createVmPool(repo, { name: 'Pool B', vm_ids: ['vm-03'] }, vms), /其他账号池/)
    assert.equal(
      (await repo.list()).some((item) => item.name === 'Pool B'),
      false,
    )
    await updateVmPool(repo, pool.id, { enabled: false }, vms)
    const disabled = await applyVmPool(
      keyScopeFromRecord(await store.getById(key.id)),
      async (id) => await repo.get(id),
    )
    assert.equal(disabled.vm_pool_error, 'disabled')
    assert.deepEqual(disabled.allowed_vms, [])
    assert.equal((await deleteVmPool(repo, pool.id)).error, 'vm_pool_in_use')
    await store.update(key.id, { vm_pool_id: null })
    await store.update(other.id, { vm_pool_id: null })
    assert.equal((await deleteVmPool(repo, pool.id)).ok, true)
    const gone = await applyVmPool(
      keyScopeFromRecord({ vm_pool_id: pool.id, group_type: 'all' }),
      async (id) => await repo.get(id),
    )
    assert.equal(gone.vm_pool_error, 'missing')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('deleting a slot or pruning removes it from pool membership', async () => {
  const { dir, store, repo } = await open()
  try {
    const pool = await createVmPool(repo, { name: 'P1', vm_ids: ['vm-01', 'vm-02'] }, vms)
    const other = await createVmPool(repo, { name: 'P2', vm_ids: ['vm-03'] }, vms)
    assert.equal(await repo.removeVm('vm-01'), 1)
    assert.deepEqual((await repo.get(pool.id)).vm_ids, ['vm-02'])
    assert.deepEqual((await repo.get(other.id)).vm_ids, ['vm-03'])
    assert.equal(await repo.removeVm('vm-01'), 0)
    // A membership left behind by a slot deleted outside the panel.
    await repo.db
      .prepare('INSERT INTO vm_pool_members (pool_id, vm_id, created_at) VALUES ($1, $2, $3)')
      .run(pool.id, 'vm-gone', new Date().toISOString())
    assert.deepEqual(await repo.pruneUnknown(['vm-02', 'vm-03']), ['vm-gone'])
    assert.deepEqual((await repo.get(pool.id)).vm_ids, ['vm-02'])
    assert.deepEqual((await repo.get(other.id)).vm_ids, ['vm-03'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an empty pool stays empty instead of meaning every VM', async () => {
  const { dir, store, repo } = open()
  try {
    const pool = await createVmPool(repo, { name: 'Empty' }, vms)
    const key = await store.create({ name: 'e', vm_pool_id: pool.id })
    const scope = await applyVmPool(keyScopeFromRecord(await store.getById(key.id)), async (id) => await repo.get(id))
    assert.equal(scope.vm_pool_error, 'empty')
    assert.deepEqual(scope.allowed_vms, [])
    assert.equal((await store.list())[0].vm_pool_name, 'Empty')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
