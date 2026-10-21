import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDb, withTransaction } from '../../src/lib/db/database.mjs'
import { RedeemCodesRepo } from '../../src/lib/db/repos/redeem-codes-repo.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { PanelUserStore, hashPassword, verifyPassword, publicUserView } from '../../src/lib/admin/panel-users.mjs'

async function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-users-'))
  const db = await getDb()
  return { dir, db, store: new PanelUserStore({ db, projectRoot: dir }) }
}

test('scrypt hash verifies and is not reversible', () => {
  const hashed = hashPassword('correct-horse')
  assert.match(hashed, /^scrypt\$/)
  assert.equal(verifyPassword('correct-horse', hashed), true)
  assert.equal(verifyPassword('wrong-pass', hashed), false)
  assert.doesNotMatch(hashed, /correct-horse/)
})

test('bootstrap seeds env admin once', async () => {
  const { store } = await tmpStore()
  const first = await store.bootstrapFromEnv({ username: 'admin', password: 'testpass1' })
  const second = await store.bootstrapFromEnv({ username: 'admin', password: 'otherpass' })
  assert.equal(first.username, 'admin')
  assert.equal(first.role, 'admin')
  assert.equal(second.id, first.id)
  assert.ok(await store.authenticate('admin', 'testpass1'))
  assert.equal(await store.authenticate('admin', 'otherpass'), null)
})

test('bootstrap imports legacy env passwords without relaxing user password validation', async () => {
  const { store } = await tmpStore()
  for (const [username, password] of [
    ['admin', '123456'],
    ['legacy', 'short'],
  ]) {
    const admin = await store.bootstrapFromEnv({ username, password })
    assert.equal(admin.role, 'admin')
    assert.equal(admin.enabled, true)
    assert.equal(admin.password_hash, undefined)
    assert.ok((await store.list()).some((user) => user.id === admin.id))
    assert.ok(await store.authenticate(username, password))
    assert.notEqual((await store.getById(admin.id)).password_hash, password)
    await assert.rejects(async () => await store.update(admin.id, { password: 'short' }), /密码至少 8 位/)

    await store.update(admin.id, { password: 'changed-admin-pass' })
    const again = await store.bootstrapFromEnv({ username, password })
    assert.equal(again.id, admin.id)
    assert.equal(await store.authenticate(username, password), null)
    assert.ok(await store.authenticate(username, 'changed-admin-pass'))
  }
  await assert.rejects(async () => await store.create({ username: 'reader', password: '123456' }), /密码至少 8 位/)
})

test('bootstrap preserves disabled admins and validates usernames', async () => {
  const { store } = await tmpStore()
  await store.create({ username: 'owner', password: 'owner-pass', role: 'admin' })
  const admin = await store.create({ username: 'admin', password: 'admin-pass', role: 'admin', enabled: false })
  const imported = await store.bootstrapFromEnv({ username: 'admin', password: '123456' })
  assert.equal(imported.id, admin.id)
  assert.equal(imported.enabled, false)
  assert.equal(await store.authenticate('admin', '123456'), null)
  assert.equal(await store.bootstrapFromEnv({ username: 'empty', password: '' }), null)
  await assert.rejects(async () => await store.bootstrapFromEnv({ username: '1bad', password: '123456' }), /用户名/)
})

test('create / authenticate / change password / roles', async () => {
  const { store } = await tmpStore()
  await store.bootstrapFromEnv({ username: 'admin', password: 'adminpass' })
  const viewer = await store.create({ username: 'reader', password: 'reader-pass', role: 'user' })
  const superu = await store.create({ username: 'ops', password: 'super-pass', role: 'super' })
  assert.equal(viewer.role, 'user')
  assert.equal(superu.role, 'super')
  assert.equal((await store.authenticate('reader', 'reader-pass')).role, 'user')
  assert.equal(await store.authenticate('ops', 'wrong-pass'), null)

  const updated = await store.update(viewer.id, { password: 'reader-next' })
  assert.equal(await store.authenticate('reader', 'reader-pass'), null)
  assert.ok(await store.authenticate('reader', 'reader-next'))
  assert.equal(publicUserView(updated).password_hash, undefined)
})

test('cannot remove or demote the last admin', async () => {
  const { store } = await tmpStore()
  const admin = await store.create({ username: 'admin', password: 'adminpass', role: 'admin' })
  await assert.rejects(async () => await store.update(admin.id, { role: 'user' }), /最后一个管理员/)
  await assert.rejects(async () => await store.update(admin.id, { enabled: false }), /最后一个管理员/)
  await assert.rejects(async () => await store.remove(admin.id), /最后一个管理员/)
})

test('rejects bad username / short password / unknown role', async () => {
  const { store } = await tmpStore()
  await assert.rejects(
    async () => await store.create({ username: '1bad', password: 'longenough', role: 'user' }),
    /用户名/,
  )
  await assert.rejects(async () => await store.create({ username: 'okuser', password: 'short', role: 'user' }), /密码/)
  await assert.rejects(
    async () => await store.create({ username: 'okuser', password: 'longenough', role: 'root' }),
    /角色/,
  )
})

function seedOwnedVm(project, id, owner, extra = {}) {
  const dir = path.join(project, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  const vm = {
    id,
    owner_user_id: owner,
    origin: 'admin_assigned',
    status: 'running',
    schedulable: false,
    schedule_disabled_reason: 'disabled',
    claude: { has_access: true, has_refresh: true },
    ...extra,
  }
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(vm))
  return vm
}

test('deleting a user reclaims assigned VMs while preserving private and unrelated slots', async (t) => {
  const { dir, db, store } = await tmpStore()
  t.after(async () => {
    await db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const user = await store.create({ username: 'tenant', password: 'tenant-pass' })
  const assigned = seedOwnedVm(dir, 'assigned', user.id)
  seedOwnedVm(dir, 'legacy', user.id, { origin: undefined })
  const privateVm = seedOwnedVm(dir, 'private', user.id, { origin: 'user_created' })
  const otherVm = seedOwnedVm(dir, 'other', 'another-tenant')
  const publicVm = seedOwnedVm(dir, 'public', null, { origin: 'platform' })

  assert.equal(await store.remove(user.id), true)
  assert.equal(await store.getById(user.id), null)
  const read = (id) => JSON.parse(fs.readFileSync(path.join(dir, 'vms', `${id}.json`), 'utf8'))
  const reclaimed = read('assigned')
  assert.equal(reclaimed.owner_user_id, null)
  assert.equal(reclaimed.origin, 'platform')
  const { updated_at, ...rest } = reclaimed
  assert.ok(updated_at)
  assert.deepEqual(rest, { ...assigned, owner_user_id: null, origin: 'platform' })
  assert.equal(read('legacy').owner_user_id, null)
  assert.equal(read('legacy').origin, 'platform')
  assert.deepEqual(read('private'), privateVm)
  assert.deepEqual(read('other'), otherVm)
  assert.deepEqual(read('public'), publicVm)
})

test('rejected user deletions leave assigned VMs with their owners', async (t) => {
  const { dir, db, store } = await tmpStore()
  t.after(async () => {
    await db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const admin = await store.create({ username: 'admin', password: 'admin-pass', role: 'admin' })
  const user = await store.create({ username: 'tenant', password: 'tenant-pass' })
  const assigned = seedOwnedVm(dir, 'assigned', user.id)
  const adminVm = seedOwnedVm(dir, 'admin-vm', admin.id)

  await assert.rejects(async () => await store.remove(user.id, { actorId: user.id }), /不能删除当前登录账号/)
  await assert.rejects(async () => await store.remove(admin.id), /最后一个管理员/)
  assert.equal(await store.remove('missing-user'), false)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'vms', 'assigned.json'), 'utf8')), assigned)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'vms', 'admin-vm.json'), 'utf8')), adminVm)
})

test('a VM write failure does not soft-delete the user', async (t) => {
  const { dir, db, store } = await tmpStore()
  t.after(async () => {
    await db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const user = await store.create({ username: 'tenant', password: 'tenant-pass' })
  const assigned = seedOwnedVm(dir, 'assigned', user.id)
  t.mock.method(fs, 'renameSync', () => {
    throw new Error('simulated VM write failure')
  })

  await assert.rejects(async () => await store.remove(user.id), /simulated VM write failure/)
  assert.ok(await store.getById(user.id))
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'vms', 'assigned.json'), 'utf8')), assigned)
})

test('concurrent redemption credits one balance and rolls back on a failed credit', async () => {
  const { store, db } = await tmpStore()
  const user = await store.create({ username: 'redeemer', password: 'long-password' })
  const codes = new RedeemCodesRepo(db)
  const code = await codes.create({ value: 5 })
  const results = await Promise.all(Array.from({ length: 8 }, () => codes.redeem(code.code, user.id)))
  assert.equal(results.filter((r) => r.ok).length, 1)
  assert.equal((await store.getById(user.id)).balance, 5)
  const failed = await codes.create({ value: 7 })
  codes.users.addBalance = async () => {
    throw new Error('credit failed')
  }
  await assert.rejects(codes.redeem(failed.code, user.id), /credit failed/)
  assert.equal((await codes.getByCode(failed.code)).status, 'unused')
  assert.equal((await store.getById(user.id)).balance, 5)
})

test('concurrent admin demotions keep one enabled administrator', async () => {
  const { store } = await tmpStore()
  const a = await store.create({ username: 'admin_a', password: 'long-password', role: 'admin' })
  const b = await store.create({ username: 'admin_b', password: 'long-password', role: 'admin' })
  const results = await Promise.allSettled([store.update(a.id, { role: 'user' }), store.update(b.id, { role: 'user' })])
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal(await store.countEnabledAdmins(), 1)
})

test('settings cache changes only after a successful transaction commit', async () => {
  const db = getDb()
  const settings = new SettingsRepo(db)
  await settings.set('transaction_setting', 'before')
  await assert.rejects(
    withTransaction(db, async () => {
      await settings.set('transaction_setting', 'after')
      assert.equal(db.settingsState.get('transaction_setting'), 'before')
      throw new Error('rollback')
    }),
    /rollback/,
  )
  assert.equal(await settings.get('transaction_setting'), 'before')
  assert.equal(db.settingsState.get('transaction_setting'), 'before')
  await withTransaction(db, async () => {
    await settings.set('transaction_setting', 'committed')
  })
  assert.equal(db.settingsState.get('transaction_setting'), 'committed')
})
