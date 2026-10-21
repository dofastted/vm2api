import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, closeDatabase, getDb } from '../../src/lib/db/database.mjs'
import { VmsRepo } from '../../src/lib/db/repos/vms-repo.mjs'
import { UsersRepo } from '../../src/lib/db/repos/users-repo.mjs'
import { encryptString, decryptString, isEncrypted } from '../../src/lib/db/secure.mjs'
import {
  initVmDbSync,
  stopVmWatch,
  syncVmFile,
  removeVmFromDb,
  reconcileVms,
  flushVmDbSync,
} from '../../src/lib/vm/vm-db-sync.mjs'
import { setVmWriteHook, atomicWriteJson } from '../../src/lib/vm/vm-file.mjs'
import { persistOauthToVm } from '../../src/lib/oauth/oauth-credentials.mjs'
import { setVmSchedulable, setActiveVm } from '../../src/lib/vm/vm-registry.mjs'

let project

function seedVmFile(id = 'vm-t1', extra = {}) {
  const dir = path.join(project, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  const vm = {
    id,
    name: 'test',
    status: 'running',
    timezone: 'UTC',
    claude: {
      access_token: 'sk-ant-oat01-AAA',
      refresh_token: 'sk-ant-ort01-BBB',
      session_key: 'sk-ant-sid01-CCC',
      email: 't@x.io',
      account_uuid: 'acct-1',
      expires_at: 1893456000,
      source: 'test',
    },
    ...extra,
  }
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(vm, null, 2))
  return vm
}

beforeEach(async () => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vmsync-'))
  await openDatabase({ dataDir: path.join(project, 'data') })
})

afterEach(async () => {
  stopVmWatch()
  setVmWriteHook(null)
  await closeDatabase()
  fs.rmSync(project, { recursive: true, force: true })
  delete process.env.KIN_DB_SECRET
})

test('initVmDbSync reconciles existing vm files into DB (credentials included)', async () => {
  seedVmFile('vm-t1')
  setActiveVm(project, 'vm-t1')
  const res = await initVmDbSync(project, { watch: false })
  assert.equal(res.upserted, 1)
  const repo = new VmsRepo(getDb())
  await flushVmDbSync()
  const row = await repo.get('vm-t1')
  assert.equal(row.access_token, null)
  assert.equal(row.refresh_token, null)
  assert.equal(row.session_key, null)
  assert.equal(row.email, 't@x.io')
  assert.equal(row.vm.claude.access_token, undefined)
  assert.equal(row.vm.claude.has_access, true)
  assert.equal(row.vm.claude.has_refresh, true)
  assert.equal(await repo.getActiveVmId(), 'vm-t1')
})

test('startup reclaims deleted users assigned VMs, including DB-only restored records', async () => {
  process.env.KIN_DB_SECRET = 'reclaim-test-secret'
  const users = new UsersRepo(getDb())
  for (const id of ['deleted-owner', 'live-owner', 'disabled-owner']) {
    await users.insert({ id, username: id, password_hash: 'unused', role: 'user', enabled: id !== 'disabled-owner' })
  }
  await users.remove('deleted-owner')
  seedVmFile('assigned', { owner_user_id: 'deleted-owner', origin: 'admin_assigned' })
  seedVmFile('legacy', { owner_user_id: 'deleted-owner' })
  seedVmFile('private', { owner_user_id: 'deleted-owner', origin: 'user_created' })
  seedVmFile('live', { owner_user_id: 'live-owner', origin: 'admin_assigned' })
  seedVmFile('disabled', { owner_user_id: 'disabled-owner', origin: 'admin_assigned' })
  seedVmFile('unknown', { owner_user_id: 'unknown-owner', origin: 'admin_assigned' })
  const restored = seedVmFile('restored', { owner_user_id: 'deleted-owner', origin: 'admin_assigned' })
  const repo = new VmsRepo(getDb())
  await repo.upsertFromVmJson(restored)
  fs.rmSync(path.join(project, 'vms', 'restored.json'))

  const result = await initVmDbSync(project, { watch: false })
  assert.deepEqual(result.reclaimed_vm_ids.sort(), ['assigned', 'legacy', 'restored'])
  for (const id of result.reclaimed_vm_ids) {
    const vm = JSON.parse(fs.readFileSync(path.join(project, 'vms', `${id}.json`), 'utf8'))
    assert.equal(vm.owner_user_id, null)
    assert.equal(vm.origin, 'platform')
    await flushVmDbSync()
    const row = await repo.get(id)
    assert.equal(row.vm.owner_user_id, null)
    const raw = await getDb().prepare('SELECT owner_user_id, origin FROM vms WHERE id = $1').get(id)
    assert.equal(raw.owner_user_id, null)
    assert.equal(raw.origin, 'platform')
    assert.equal(row.vm.claude.has_access, true)
    assert.equal(row.encrypted, true)
  }
  for (const [id, owner] of [
    ['private', 'deleted-owner'],
    ['live', 'live-owner'],
    ['disabled', 'disabled-owner'],
    ['unknown', 'unknown-owner'],
  ]) {
    assert.equal((await repo.get(id)).vm.owner_user_id, owner)
  }
  const before = fs.readFileSync(path.join(project, 'vms', 'assigned.json'), 'utf8')
  assert.deepEqual((await initVmDbSync(project, { watch: false })).reclaimed_vm_ids, [])
  assert.equal(fs.readFileSync(path.join(project, 'vms', 'assigned.json'), 'utf8'), before)
})

test('startup ownership recovery skips an unreadable slot and continues with valid assignments', async (t) => {
  const users = new UsersRepo(getDb())
  await users.insert({ id: 'deleted-owner', username: 'deleted', password_hash: 'unused', role: 'user' })
  await users.remove('deleted-owner')
  seedVmFile('assigned', { owner_user_id: 'deleted-owner', origin: 'admin_assigned' })
  fs.writeFileSync(path.join(project, 'vms', 'broken.json'), '{')
  const warnings = []
  t.mock.method(console, 'warn', (message) => warnings.push(message))

  const result = await initVmDbSync(project, { watch: false })
  assert.deepEqual(result.reclaimed_vm_ids, ['assigned'])
  assert.ok(warnings.some((message) => /ownership recovery skipped broken.json/.test(message)))
  assert.equal((await new VmsRepo(getDb()).get('assigned')).vm.owner_user_id, null)
})

test('write-through hook mirrors persistOauthToVm into DB', async () => {
  seedVmFile('vm-t2')
  await initVmDbSync(project, { watch: false })
  const vmPath = path.join(project, 'vms', 'vm-t2.json')
  persistOauthToVm(vmPath, {
    access_token: 'sk-ant-oat01-NEW',
    refresh_token: 'sk-ant-ort01-NEW',
    expires_at: 1893460000,
  })
  const repo = new VmsRepo(getDb())
  await flushVmDbSync()
  const row = await repo.get('vm-t2')
  assert.equal(row.access_token, null)
  assert.equal(row.refresh_token, null)
  assert.equal(row.vm.claude.has_access, true)
  assert.equal(row.vm.claude.has_refresh, true)
  assert.equal(row.vm.claude.access_token, undefined)
})

test('vm-registry writes are mirrored (setVmSchedulable)', async () => {
  seedVmFile('vm-t3')
  await initVmDbSync(project, { watch: false })
  setVmSchedulable(project, 'vm-t3', false, 'test-reason')
  await flushVmDbSync()
  const row = await new VmsRepo(getDb()).get('vm-t3')
  assert.equal(row.schedulable, false)
  assert.equal(row.vm.schedule_disabled_reason, 'test-reason')
})

test('setVmSchedulable preserveStatus keeps running when operator disables', async () => {
  seedVmFile('vm-t3c')
  await initVmDbSync(project, { watch: false })
  setVmSchedulable(project, 'vm-t3c', false, 'disabled', { preserveStatus: true })
  const off = JSON.parse(fs.readFileSync(path.join(project, 'vms', 'vm-t3c.json'), 'utf8'))
  assert.equal(off.status, 'running')
  assert.equal(off.schedulable, false)
  assert.equal(off.schedule_disabled_reason, 'disabled')
})

test('setVmSchedulable(true) restores soft-paused status to running', async () => {
  seedVmFile('vm-t3b')
  await initVmDbSync(project, { watch: false })
  setVmSchedulable(project, 'vm-t3b', false, 'proxy_rebind_worker_restart')
  const paused = JSON.parse(fs.readFileSync(path.join(project, 'vms', 'vm-t3b.json'), 'utf8'))
  assert.equal(paused.status, 'paused')
  assert.equal(paused.schedulable, false)
  setVmSchedulable(project, 'vm-t3b', true)
  const ready = JSON.parse(fs.readFileSync(path.join(project, 'vms', 'vm-t3b.json'), 'utf8'))
  assert.equal(ready.status, 'running')
  assert.equal(ready.schedulable, true)
  assert.equal(ready.schedule_disabled_reason, null)
})

test('reconcile rebuilds missing vm file from DB (restore pull-up)', async () => {
  const vm = seedVmFile('vm-t4')
  await initVmDbSync(project, { watch: false })
  const vmPath = path.join(project, 'vms', 'vm-t4.json')
  fs.rmSync(vmPath)
  const res = await reconcileVms(project)
  assert.equal(res.rebuilt, 1)
  assert.ok(fs.existsSync(vmPath))
  const back = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(back.claude.access_token, undefined)
  assert.equal(back.claude.has_access, true)
  assert.equal(back.claude.has_refresh, true)
  assert.equal(back.claude.email, vm.claude.email)
})

test('removeVmFromDb drops the row', async () => {
  seedVmFile('vm-t5')
  await initVmDbSync(project, { watch: false })
  assert.equal(await removeVmFromDb('vm-t5'), true)
  assert.equal(await new VmsRepo(getDb()).get('vm-t5'), null)
})

test('KIN_DB_SECRET encrypts credentials at rest, decrypts on read', async () => {
  process.env.KIN_DB_SECRET = 'test-secret-123'
  seedVmFile('vm-t6')
  await initVmDbSync(project, { watch: false })
  // raw row must be ciphertext
  const raw = await getDb().prepare('SELECT access_token, vm_json, encrypted FROM vms WHERE id = $1').get('vm-t6')
  assert.equal(raw.encrypted, 1)
  assert.equal(raw.access_token, null)
  assert.ok(isEncrypted(raw.vm_json), 'vm_json should be encrypted')
  assert.doesNotMatch(String(raw.vm_json), /sk-ant-oat01/)
  const row = await new VmsRepo(getDb()).get('vm-t6')
  assert.equal(row.access_token, null)
  assert.equal(row.vm.claude.has_access, true)
  assert.equal(row.vm.claude.refresh_token, undefined)
})

test('secure round-trip + tamper detection', () => {
  const ct = encryptString('hello', 's3cret')
  assert.ok(isEncrypted(ct))
  assert.equal(decryptString(ct, 's3cret'), 'hello')
  assert.throws(() => decryptString(ct, 'wrong-secret'))
  assert.equal(decryptString('plain-value', 's3cret'), 'plain-value')
})

test('syncVmFile no-ops safely when DB is closed', async () => {
  seedVmFile('vm-t7')
  await closeDatabase()
  assert.equal(await syncVmFile(path.join(project, 'vms', 'vm-t7.json')), false)
  assert.equal(await removeVmFromDb('vm-t7'), false)
  // atomicWriteJson still works without a hook/DB
  atomicWriteJson(path.join(project, 'vms', 'vm-t7.json'), { id: 'vm-t7' })
})

test('file newer than DB wins on reconcile (mtime compare)', async () => {
  seedVmFile('vm-t8')
  await initVmDbSync(project, { watch: false })
  // simulate external edit with a newer mtime
  await new Promise((r) => setTimeout(r, 20))
  const vmPath = path.join(project, 'vms', 'vm-t8.json')
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  vm.claude.access_token = 'sk-ant-oat01-EXTERNAL'
  fs.writeFileSync(vmPath, JSON.stringify(vm, null, 2))
  const res = await reconcileVms(project)
  assert.equal(res.upserted, 1)
  const row = await new VmsRepo(getDb()).get('vm-t8')
  assert.equal(row.access_token, null)
  assert.equal(row.vm.claude.has_access, true)
  assert.equal(row.vm.claude.access_token, undefined)
})

test('queued VM upserts finish before deletion and cannot rebuild the deleted VM', async () => {
  seedVmFile('vm-ordered')
  await initVmDbSync(project, { watch: false })
  const file = path.join(project, 'vms', 'vm-ordered.json')
  const vm = JSON.parse(fs.readFileSync(file, 'utf8'))
  atomicWriteJson(file, { ...vm, name: 'first update' })
  atomicWriteJson(file, { ...vm, name: 'last update' })
  fs.unlinkSync(file)
  assert.equal(await removeVmFromDb('vm-ordered'), true)
  await flushVmDbSync()
  const restored = await reconcileVms(project)
  assert.equal(restored.rebuilt, 0)
  assert.equal(await new VmsRepo(getDb()).get('vm-ordered'), null)
  assert.equal(fs.existsSync(file), false)
})

test('reconciliation cannot overwrite a newer queued VM snapshot', async () => {
  seedVmFile('vm-race', { name: 'old snapshot' })
  await initVmDbSync(project, { watch: false })
  const db = getDb()
  await db.prepare('UPDATE vms SET file_mtime_ms = 0 WHERE id = $1').run('vm-race')
  const query = db.query.bind(db)
  let enteredResolve
  let releaseResolve
  const entered = new Promise((resolve) => {
    enteredResolve = resolve
  })
  const release = new Promise((resolve) => {
    releaseResolve = resolve
  })
  let intercepted = false
  db.query = async (sql, values) => {
    const result = await query(sql, values)
    if (!intercepted && sql === 'SELECT * FROM vms WHERE id = $1') {
      intercepted = true
      enteredResolve()
      await release
    }
    return result
  }
  const reconcile = reconcileVms(project)
  let flush
  try {
    await entered
    atomicWriteJson(path.join(project, 'vms', 'vm-race.json'), { id: 'vm-race', name: 'new snapshot' })
    let flushed = false
    flush = flushVmDbSync().then(() => {
      flushed = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(flushed, false, 'flush must wait for the reconciliation preceding the new snapshot')
  } finally {
    releaseResolve()
    await reconcile
    await flush
    db.query = query
  }
  const row = await new VmsRepo(db).get('vm-race')
  assert.equal(row.vm.name, 'new snapshot')
})
