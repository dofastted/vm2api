import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDb } from '../../src/lib/db/database.mjs'
import { VmsRepo } from '../../src/lib/db/repos/vms-repo.mjs'
import { getVm, listVms } from '../../src/lib/vm/vm-registry.mjs'

test('HA reads VM metadata from PostgreSQL and never trusts or rebuilds Pod VM files', async (t) => {
  const { HaVmCatalog, bindHaVmCatalog } = await import('../../src/lib/vm/ha-vm-catalog.mjs')
  const previous = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes-ha'
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-ha-vm-catalog-'))
  t.after(() => {
    bindHaVmCatalog(null)
    if (previous === undefined) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = previous
    fs.rmSync(root, { recursive: true, force: true })
  })
  const db = getDb()
  const repo = new VmsRepo(db)
  const original = {
    id: 'ha-catalog-vm',
    node_id: 'ha-node',
    status: 'running',
    claude: { account_uuid: 'database-account', access_token: 'synthetic-secret', has_access: true },
  }
  await repo.upsertFromVmJson(original)
  fs.mkdirSync(path.join(root, 'vms'))
  const file = path.join(root, 'vms', 'ha-catalog-vm.json')
  const forged = JSON.stringify({ ...original, claude: { account_uuid: 'forged-account' } })
  fs.writeFileSync(file, forged)
  const catalog = new HaVmCatalog(db)
  bindHaVmCatalog(catalog)
  assert.throws(() => getVm(root, original.id), { code: 'ha_vm_catalog_unavailable' })
  await catalog.refresh()
  assert.equal(getVm(root, original.id).claude.account_uuid, 'database-account')
  assert.equal(getVm(root, original.id).claude.access_token, undefined)
  assert.equal(listVms(root).find((vm) => vm.id === original.id).account_uuid, 'database-account')
  const copy = getVm(root, original.id)
  copy.claude.account_uuid = 'mutated-copy'
  assert.equal(getVm(root, original.id).claude.account_uuid, 'database-account')
  assert.equal(fs.readFileSync(file, 'utf8'), forged)
  await repo.upsertFromVmJson({ ...original, name: 'changed-in-database' })
  await catalog.refresh()
  assert.equal(getVm(root, original.id).name, 'changed-in-database')
  await repo.remove(original.id)
  await catalog.refresh()
  assert.equal(getVm(root, original.id), null, 'deletion cannot fall back to an old Pod file')
  assert.equal(fs.readFileSync(file, 'utf8'), forged)
})

test('HA catalog failure refuses cached metadata and does not restore legacy file authority', async (t) => {
  const { HaVmCatalog } = await import('../../src/lib/vm/ha-vm-catalog.mjs')
  const catalog = new HaVmCatalog(getDb())
  await catalog.refresh()
  t.mock.method(catalog.repo, 'list', async () => {
    throw new Error('synthetic PostgreSQL unavailable')
  })
  await assert.rejects(catalog.refresh(), /PostgreSQL unavailable/)
  assert.throws(() => catalog.list(), { code: 'ha_vm_catalog_unavailable' })
  assert.throws(() => catalog.get('ha-catalog-vm'), { code: 'ha_vm_catalog_unavailable' })
})
