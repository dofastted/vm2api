import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, closeDatabase, getDb } from '../../src/lib/db/database.mjs'
import { VmsRepo } from '../../src/lib/db/repos/vms-repo.mjs'
import { UsersRepo } from '../../src/lib/db/repos/users-repo.mjs'
import { VmPoolsRepo } from '../../src/lib/db/repos/vm-pools-repo.mjs'
import { encryptString, decryptString, isEncrypted } from '../../src/lib/db/secure.mjs'
import { initVmDbSync, stopVmWatch, syncVmFile, removeVmFromDb, reconcileVms } from '../../src/lib/vm/vm-db-sync.mjs'
import { setVmWriteHook, atomicWriteJson } from '../../src/lib/vm/vm-file.mjs'
import { persistOauthToVm } from '../../src/lib/oauth/oauth-credentials.mjs'
import { clearScheduleHold, setVmSchedulable, setActiveVm } from '../../src/lib/vm/vm-registry.mjs'

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

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vmsync-'))
  openDatabase({ dataDir: path.join(project, 'data') })
})

afterEach(() => {
  stopVmWatch()
  setVmWriteHook(null)
  closeDatabase()
  fs.rmSync(project, { recursive: true, force: true })
  delete process.env.KIN_DB_SECRET
})

test('initVmDbSync reconciles existing vm files into DB (credentials included)', () => {
  seedVmFile('vm-t1')
  setActiveVm(project, 'vm-t1')
  const res = initVmDbSync(project, { watch: false })
  assert.equal(res.upserted, 1)
  const repo = new VmsRepo(getDb())
  const row = repo.get('vm-t1')
  assert.equal(row.access_token, null)
  assert.equal(row.refresh_token, null)
  assert.equal(row.session_key, null)
  assert.equal(row.email, 't@x.io')
  assert.equal(row.vm.claude.access_token, undefined)
  assert.equal(row.vm.claude.has_access, true)
  assert.equal(row.vm.claude.has_refresh, true)
  assert.equal(repo.getActiveVmId(), 'vm-t1')
})

test('Antigravity DB mirrors only display metadata, never CLI or leftover provider secrets', () => {
  const vm = seedVmFile('vm-ag', {
    platform: 'antigravity',
    antigravity: {
      email: 'ag@example.com',
      access_token: 'ag-secret',
      refresh_token: 'ag-refresh',
      keyring: { secret: 'keyring-secret' },
    },
    codex: { access_token: 'old-gpt-secret' },
  })
  const repo = new VmsRepo(getDb())
  repo.upsertFromVmJson(vm)
  const row = repo.get(vm.id)
  assert.equal(row.email, 'ag@example.com')
  assert.equal(row.access_token, null)
  assert.equal(row.refresh_token, null)
  assert.deepEqual(row.vm.antigravity, { email: 'ag@example.com' })
  assert.equal(row.vm.claude, undefined)
  assert.equal(row.vm.codex, undefined)
  const stored = getDb().prepare('SELECT vm_json FROM vms WHERE id = ?').get(vm.id).vm_json
  assert.doesNotMatch(stored, /ag-secret|ag-refresh|keyring-secret|old-gpt-secret|sk-ant-/)
})

test('startup reclaims deleted users assigned VMs, including DB-only restored records', () => {
  process.env.KIN_DB_SECRET = 'reclaim-test-secret'
  const users = new UsersRepo(getDb())
  for (const id of ['deleted-owner', 'live-owner', 'disabled-owner']) {
    users.insert({ id, username: id, password_hash: 'unused', role: 'user', enabled: id !== 'disabled-owner' })
  }
  users.remove('deleted-owner')
  seedVmFile('assigned', { owner_user_id: 'deleted-owner', origin: 'admin_assigned' })
  seedVmFile('legacy', { owner_user_id: 'deleted-owner' })
  seedVmFile('private', { owner_user_id: 'deleted-owner', origin: 'user_created' })
  seedVmFile('live', { owner_user_id: 'live-owner', origin: 'admin_assigned' })
  seedVmFile('disabled', { owner_user_id: 'disabled-owner', origin: 'admin_assigned' })
  seedVmFile('unknown', { owner_user_id: 'unknown-owner', origin: 'admin_assigned' })
  const restored = seedVmFile('restored', { owner_user_id: 'deleted-owner', origin: 'admin_assigned' })
  const repo = new VmsRepo(getDb())
  repo.upsertFromVmJson(restored)
  fs.rmSync(path.join(project, 'vms', 'restored.json'))

  const result = initVmDbSync(project, { watch: false })
  assert.deepEqual(result.reclaimed_vm_ids.sort(), ['assigned', 'legacy', 'restored'])
  for (const id of result.reclaimed_vm_ids) {
    const vm = JSON.parse(fs.readFileSync(path.join(project, 'vms', `${id}.json`), 'utf8'))
    assert.equal(vm.owner_user_id, null)
    assert.equal(vm.origin, 'platform')
    const row = repo.get(id)
    assert.equal(row.vm.owner_user_id, null)
    const raw = getDb().prepare('SELECT owner_user_id, origin FROM vms WHERE id = ?').get(id)
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
    assert.equal(repo.get(id).vm.owner_user_id, owner)
  }
  const before = fs.readFileSync(path.join(project, 'vms', 'assigned.json'), 'utf8')
  assert.deepEqual(initVmDbSync(project, { watch: false }).reclaimed_vm_ids, [])
  assert.equal(fs.readFileSync(path.join(project, 'vms', 'assigned.json'), 'utf8'), before)
})

test('startup ownership recovery skips an unreadable slot and continues with valid assignments', (t) => {
  const users = new UsersRepo(getDb())
  users.insert({ id: 'deleted-owner', username: 'deleted', password_hash: 'unused', role: 'user' })
  users.remove('deleted-owner')
  seedVmFile('assigned', { owner_user_id: 'deleted-owner', origin: 'admin_assigned' })
  fs.writeFileSync(path.join(project, 'vms', 'broken.json'), '{')
  const warnings = []
  t.mock.method(console, 'warn', (message) => warnings.push(message))

  const result = initVmDbSync(project, { watch: false })
  assert.deepEqual(result.reclaimed_vm_ids, ['assigned'])
  assert.ok(warnings.some((message) => /ownership recovery skipped broken.json/.test(message)))
  assert.equal(new VmsRepo(getDb()).get('assigned').vm.owner_user_id, null)
})

test('write-through hook mirrors persistOauthToVm into DB', () => {
  seedVmFile('vm-t2')
  initVmDbSync(project, { watch: false })
  const vmPath = path.join(project, 'vms', 'vm-t2.json')
  persistOauthToVm(vmPath, {
    access_token: 'sk-ant-oat01-NEW',
    refresh_token: 'sk-ant-ort01-NEW',
    expires_at: 1893460000,
  })
  const repo = new VmsRepo(getDb())
  const row = repo.get('vm-t2')
  assert.equal(row.access_token, null)
  assert.equal(row.refresh_token, null)
  assert.equal(row.vm.claude.has_access, true)
  assert.equal(row.vm.claude.has_refresh, true)
  assert.equal(row.vm.claude.access_token, undefined)
})

test('vm-registry writes are mirrored (setVmSchedulable)', () => {
  seedVmFile('vm-t3')
  initVmDbSync(project, { watch: false })
  setVmSchedulable(project, 'vm-t3', false, 'proxy_desynced')
  const row = new VmsRepo(getDb()).get('vm-t3')
  assert.equal(row.schedulable, false)
  assert.equal(row.vm.schedule_disabled_reason, 'proxy_desynced')
  assert.equal(row.vm.unschedulable.reason, 'proxy_desynced')
})

test('setVmSchedulable preserveStatus keeps running when operator disables', () => {
  seedVmFile('vm-t3c')
  initVmDbSync(project, { watch: false })
  setVmSchedulable(project, 'vm-t3c', false, 'disabled', { preserveStatus: true })
  const off = JSON.parse(fs.readFileSync(path.join(project, 'vms', 'vm-t3c.json'), 'utf8'))
  assert.equal(off.status, 'running')
  assert.equal(off.schedulable, false)
  assert.equal(off.schedule_disabled_reason, 'disabled')
})

test('lifting a worker-reload hold restores soft-paused status to running', () => {
  seedVmFile('vm-t3b')
  initVmDbSync(project, { watch: false })
  setVmSchedulable(project, 'vm-t3b', false, 'proxy_rebind_worker_reload')
  const paused = JSON.parse(fs.readFileSync(path.join(project, 'vms', 'vm-t3b.json'), 'utf8'))
  assert.equal(paused.status, 'paused')
  assert.equal(paused.schedulable, false)
  clearScheduleHold(project, 'vm-t3b', 'maintenance')
  const ready = JSON.parse(fs.readFileSync(path.join(project, 'vms', 'vm-t3b.json'), 'utf8'))
  assert.equal(ready.status, 'running')
  assert.equal(ready.schedulable, true)
  assert.equal(ready.schedule_disabled_reason, null)
})

test('reconcile rebuilds missing vm file from DB (restore pull-up)', () => {
  const vm = seedVmFile('vm-t4')
  initVmDbSync(project, { watch: false })
  const vmPath = path.join(project, 'vms', 'vm-t4.json')
  fs.rmSync(vmPath)
  const res = reconcileVms(project)
  assert.equal(res.rebuilt, 1)
  assert.ok(fs.existsSync(vmPath))
  const back = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(back.claude.access_token, undefined)
  assert.equal(back.claude.has_access, true)
  assert.equal(back.claude.has_refresh, true)
  assert.equal(back.claude.email, vm.claude.email)
})

test('removing a slot drops it from every named pool', () => {
  seedVmFile('vm-p5')
  seedVmFile('vm-p6')
  initVmDbSync(project, { watch: false })
  const pools = new VmPoolsRepo(getDb())
  const pool = pools.insert({ name: 'shared' })
  pools.setMembers(pool.id, ['vm-p5', 'vm-p6'])
  assert.equal(removeVmFromDb('vm-p5'), true)
  assert.deepEqual(pools.get(pool.id).vm_ids, ['vm-p6'])
})

test('reconcile prunes pool members whose slot vanished outside the panel', () => {
  seedVmFile('vm-p7')
  initVmDbSync(project, { watch: false })
  const pools = new VmPoolsRepo(getDb())
  const pool = pools.insert({ name: 'ghosts' })
  pools.setMembers(pool.id, ['vm-p7'])
  getDb()
    .prepare('INSERT INTO vm_pool_members (pool_id, vm_id, created_at) VALUES (?, ?, ?)')
    .run(pool.id, 'niutopia2000', new Date().toISOString())
  const res = reconcileVms(project)
  assert.deepEqual(res.pruned_pool_members, ['niutopia2000'])
  assert.deepEqual(pools.get(pool.id).vm_ids, ['vm-p7'])
})

test('removeVmFromDb drops the row', () => {
  seedVmFile('vm-t5')
  initVmDbSync(project, { watch: false })
  assert.equal(removeVmFromDb('vm-t5'), true)
  assert.equal(new VmsRepo(getDb()).get('vm-t5'), null)
})

test('KIN_DB_SECRET encrypts credentials at rest, decrypts on read', () => {
  process.env.KIN_DB_SECRET = 'test-secret-123'
  seedVmFile('vm-t6')
  initVmDbSync(project, { watch: false })
  // raw row must be ciphertext
  const raw = getDb().prepare('SELECT access_token, vm_json, encrypted FROM vms WHERE id = ?').get('vm-t6')
  assert.equal(raw.encrypted, 1)
  assert.equal(raw.access_token, null)
  assert.ok(isEncrypted(raw.vm_json), 'vm_json should be encrypted')
  assert.doesNotMatch(String(raw.vm_json), /sk-ant-oat01/)
  const row = new VmsRepo(getDb()).get('vm-t6')
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

test('syncVmFile no-ops safely when DB is closed', () => {
  seedVmFile('vm-t7')
  closeDatabase()
  assert.equal(syncVmFile(path.join(project, 'vms', 'vm-t7.json')), false)
  assert.equal(removeVmFromDb('vm-t7'), false)
  // atomicWriteJson still works without a hook/DB
  atomicWriteJson(path.join(project, 'vms', 'vm-t7.json'), { id: 'vm-t7' })
})

test('file newer than DB wins on reconcile (mtime compare)', async () => {
  seedVmFile('vm-t8')
  initVmDbSync(project, { watch: false })
  // simulate external edit with a newer mtime
  await new Promise((r) => setTimeout(r, 20))
  const vmPath = path.join(project, 'vms', 'vm-t8.json')
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  vm.claude.access_token = 'sk-ant-oat01-EXTERNAL'
  fs.writeFileSync(vmPath, JSON.stringify(vm, null, 2))
  const res = reconcileVms(project)
  assert.equal(res.upserted, 1)
  const row = new VmsRepo(getDb()).get('vm-t8')
  assert.equal(row.access_token, null)
  assert.equal(row.vm.claude.has_access, true)
  assert.equal(row.vm.claude.access_token, undefined)
})
