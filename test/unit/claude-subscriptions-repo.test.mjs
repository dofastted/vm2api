import test from 'node:test'
import assert from 'node:assert/strict'
import { getDb } from '../../src/lib/db/database.mjs'
import { ClaudeSubscriptionsRepo, stampClaudeSubscriptions } from '../../src/lib/db/repos/claude-subscriptions-repo.mjs'
import { VmsRepo } from '../../src/lib/db/repos/vms-repo.mjs'

const identity = { vm_id: 'vm-subscription', account_uuid: 'fixture-account', org_uuid: 'fixture-org' }
const secret = 'sk-ant-sid01-synthetic-private-cookie'
const snapshot = {
  plan: 'Max 5x',
  expires_at: '2026-11-05',
  expires_date_only: true,
  fetched_at: '2026-10-27T00:00:00Z',
}

async function fixture(t) {
  const saved = { VM2API_DB_SECRET: process.env.VM2API_DB_SECRET, KIN_DB_SECRET: process.env.KIN_DB_SECRET }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  delete process.env.VM2API_DB_SECRET
  process.env.KIN_DB_SECRET = 'synthetic-test-encryption-key'
  const db = getDb()
  await new VmsRepo(db).upsertFromVmJson({ id: identity.vm_id, claude: identity })
  return new ClaudeSubscriptionsRepo(db)
}

test('subscription cookie is encrypted, survives a new repository instance, and never enters public metadata', async (t) => {
  const repo = await fixture(t)
  await repo.save(identity, secret, snapshot)
  const stored = await getDb().prepare('SELECT * FROM claude_subscriptions').get()
  assert.ok(stored.encrypted_session_key.startsWith('enc:v1:'))
  assert.equal(JSON.stringify(stored).includes(secret), false)
  assert.equal((await new ClaudeSubscriptionsRepo().credential(identity)).sessionKey, secret)
  const view = await repo.view(identity)
  assert.equal(view.plan, 'Max 5x')
  assert.equal(view.configured, true)
  assert.equal('encrypted_session_key' in view, false)
  assert.equal(JSON.stringify(view).includes(secret), false)
  const vms = [{ id: identity.vm_id, account_uuid: identity.account_uuid, org_uuid: identity.org_uuid }]
  await stampClaudeSubscriptions(vms)
  assert.equal(vms[0].claude_subscription.expires_at, '2026-11-05')
  assert.equal(JSON.stringify(vms).includes(secret), false)
})

test('saving a cookie requires configured encryption and never falls back to plaintext', async (t) => {
  const repo = await fixture(t)
  delete process.env.KIN_DB_SECRET
  delete process.env.VM2API_DB_SECRET
  await assert.rejects(repo.save(identity, secret, snapshot), { code: 'subscription_encryption_required' })
  assert.equal((await repo.view(identity)).configured, false)
  assert.equal((await getDb().prepare('SELECT count(*) AS n FROM claude_subscriptions').get()).n, 0)
})

test('reusing the slot for another account or organization cannot read or publish the previous subscription', async (t) => {
  const repo = await fixture(t)
  await repo.save(identity, secret, snapshot)
  for (const changed of [{ account_uuid: 'other-account' }, { org_uuid: 'other-org' }]) {
    assert.equal((await repo.view({ ...identity, ...changed })).configured, false)
    await assert.rejects(repo.credential({ ...identity, ...changed }), { code: 'subscription_credential_missing' })
    const vms = [{ id: identity.vm_id, account_uuid: identity.account_uuid, org_uuid: identity.org_uuid, ...changed }]
    await stampClaudeSubscriptions(vms)
    assert.equal(vms[0].claude_subscription, undefined)
  }
})

test('refresh failure retains the last successful dates and records the failure separately', async (t) => {
  const repo = await fixture(t)
  await repo.save(identity, secret, snapshot)
  const { version } = await repo.credential(identity)
  const view = await repo.update(identity, version, { error: 'subscription_session_expired' })
  assert.equal(view.expires_at, snapshot.expires_at)
  assert.equal(view.fetched_at, snapshot.fetched_at)
  assert.equal(view.last_error, 'subscription_session_expired')
})

test('a delayed refresh cannot overwrite a replaced or deleted cookie', async (t) => {
  const repo = await fixture(t)
  await repo.save(identity, secret, snapshot)
  const { version } = await repo.credential(identity)
  await repo.save(identity, `${secret}-new`, { ...snapshot, plan: 'Pro' })
  await assert.rejects(repo.update(identity, version, { snapshot }), { code: 'subscription_changed' })
  assert.equal((await repo.view(identity)).plan, 'Pro')
  const replacement = await repo.credential(identity)
  await repo.remove(identity)
  await assert.rejects(repo.update(identity, replacement.version, { snapshot }), { code: 'subscription_changed' })
  assert.equal((await repo.view(identity)).configured, false)
})

test('deleting a VM cascades only its saved subscription credential and snapshot', async (t) => {
  const repo = await fixture(t)
  await repo.save(identity, secret, snapshot)
  await new VmsRepo().remove(identity.vm_id)
  assert.equal((await getDb().prepare('SELECT count(*) AS n FROM claude_subscriptions').get()).n, 0)
})
