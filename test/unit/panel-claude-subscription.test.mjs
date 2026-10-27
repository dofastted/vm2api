import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { buildVmList } from '../../src/lib/admin/panel-api.mjs'
import { getDb } from '../../src/lib/db/database.mjs'
import { VmsRepo } from '../../src/lib/db/repos/vms-repo.mjs'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'

const cookie = 'sk-ant-sid01-synthetic-billing-cookie'
const accountId = '11111111-1111-4111-8111-111111111111'
const orgId = '22222222-2222-4222-8222-222222222222'
const details = {
  status: 'active',
  next_charge_at: null,
  next_charge_date: '2026-11-05',
  plan_ending_at: null,
  plan_ending_before: null,
}

async function fixture(t) {
  const previous = process.env.KIN_DB_SECRET
  process.env.KIN_DB_SECRET = 'synthetic-subscription-test-key'
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-subscription-'))
  t.after(() => {
    if (previous === undefined) delete process.env.KIN_DB_SECRET
    else process.env.KIN_DB_SECRET = previous
    fs.rmSync(root, { recursive: true, force: true })
  })
  const vm = {
    id: 'vm-billing',
    status: 'stopped',
    owner_user_id: 'tenant-a',
    claude: {
      account_uuid: accountId,
      org_uuid: orgId,
      email: 'fixture@example.com',
      has_access: true,
      account_tier: 'max',
    },
  }
  fs.mkdirSync(path.join(root, 'vms', vm.id, 'cli-home', '.claude'), { recursive: true })
  const recordPath = path.join(root, 'vms', `${vm.id}.json`)
  fs.writeFileSync(recordPath, JSON.stringify(vm))
  const credentialPath = path.join(root, 'vms', vm.id, 'cli-home', '.claude', 'credentials.json')
  fs.writeFileSync(
    credentialPath,
    JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-inference-token', refreshToken: 'synthetic-refresh' } }),
  )
  await new VmsRepo().upsertFromVmJson(vm)
  const state = { status: 200, calls: [], body: {}, response: {}, beforeReturn: null }
  const cfg = { paths: { project: root }, limits: { max_body_bytes: 8192 } }
  const handler = createPanelHandler({
    cfg,
    requireAuth: () => true,
    json: (_res, status, body) => {
      state.response = { status, body }
      return true
    },
    readBody: async () => state.body,
    requireSlotProxy: () => ({ ok: true, proxyUrl: 'socks5://synthetic.invalid:1080' }),
    claudeSubscriptionRequest: async (url) => {
      state.calls.push(url)
      await state.beforeReturn?.(url)
      return {
        status: state.status,
        body: url.endsWith('/account')
          ? {
              uuid: accountId,
              memberships: [{ organization: { uuid: orgId, rate_limit_tier: 'default_claude_max_5x' } }],
            }
          : details,
      }
    },
  })
  return {
    state,
    root,
    vm,
    cfg,
    recordPath,
    credentialPath,
    request: async (method, body = {}, role = 'admin', userId = 'tenant-a') => {
      state.body = body
      const req = { method, panelRole: role, panelUserId: userId, panelUser: 'fixture-user' }
      await handler(req, {}, new URL(`http://fixture/api/panel/vms/${vm.id}/claude-subscription`))
      return state.response
    },
  }
}

test('subscription management ACL allows owned-user mutations and super metadata only', () => {
  const url = '/api/panel/vms/vm-billing/claude-subscription'
  for (const method of ['GET', 'PUT', 'POST', 'DELETE']) {
    assert.equal(authorizePanelRoute(method, url, 'user').ok, true)
    assert.equal(authorizePanelRoute(method, url, 'super').ok, method === 'GET')
  }
})

test('save, read, replace, refresh and delete affect only the subscription credential', async (t) => {
  const f = await fixture(t)
  const beforeRecord = fs.readFileSync(f.recordPath, 'utf8')
  const beforeCredential = fs.readFileSync(f.credentialPath, 'utf8')
  let result = await f.request('PUT', { session_key: cookie })
  assert.equal(result.status, 200, JSON.stringify(result))
  assert.equal(result.body.data.plan, 'Max 5x')
  assert.equal(result.body.data.renews_at, '2026-11-05')
  assert.equal(JSON.stringify(result).includes(cookie), false)
  const calls = f.state.calls.length
  result = await f.request('GET')
  assert.equal(f.state.calls.length, calls, 'GET metadata must not call Claude')
  assert.equal(result.body.data.configured, true)
  assert.equal((await f.request('PUT', { session_key: `${cookie}-replacement` })).status, 200)
  assert.equal((await f.request('POST')).status, 200)
  const list = await buildVmList({ cfg: f.cfg })
  assert.equal(list.data.items[0].claude_subscription.plan, 'Max 5x')
  assert.equal(JSON.stringify(list).includes(cookie), false)
  result = await f.request('DELETE')
  assert.equal(result.status, 200)
  assert.equal(result.body.data.configured, false)
  assert.equal((await getDb().prepare('SELECT count(*) AS n FROM claude_subscriptions').get()).n, 0)
  assert.equal(fs.readFileSync(f.recordPath, 'utf8'), beforeRecord)
  assert.equal(fs.readFileSync(f.credentialPath, 'utf8'), beforeCredential)
})

test('expired stored cookie records a query error without changing OAuth or previously captured dates', async (t) => {
  const f = await fixture(t)
  await f.request('PUT', { session_key: cookie })
  f.state.status = 401
  const result = await f.request('POST')
  assert.equal(result.status, 422)
  assert.equal(result.body.error.code, 'subscription_session_expired')
  assert.equal(result.body.data.renews_at, '2026-11-05')
  assert.equal(result.body.data.last_error, 'subscription_session_expired')
  assert.equal(JSON.stringify(result).includes(cookie), false)
})

test('foreign tenants cannot read, replace, refresh or delete the saved billing cookie', async (t) => {
  const f = await fixture(t)
  await f.request('PUT', { session_key: cookie })
  const calls = f.state.calls.length
  for (const method of ['GET', 'PUT', 'POST', 'DELETE']) {
    assert.equal((await f.request(method, { session_key: cookie }, 'user', 'tenant-b')).status, 404)
  }
  assert.equal(f.state.calls.length, calls)
  assert.equal((await f.request('GET')).body.data.configured, true)
})

test('a slot account change while querying discards the result and never publishes it to the new account', async (t) => {
  const f = await fixture(t)
  f.state.beforeReturn = (url) => {
    if (url.endsWith('/subscription_details')) {
      fs.writeFileSync(
        f.recordPath,
        JSON.stringify({ ...f.vm, claude: { ...f.vm.claude, account_uuid: 'other-account' } }),
      )
    }
  }
  const result = await f.request('PUT', { session_key: cookie })
  assert.equal(result.status, 409, JSON.stringify(result))
  assert.equal(result.body.error.code, 'subscription_changed')
  assert.equal((await getDb().prepare('SELECT count(*) AS n FROM claude_subscriptions').get()).n, 0)
})

test('invalid replacement input keeps the previously saved credential', async (t) => {
  const f = await fixture(t)
  await f.request('PUT', { session_key: cookie })
  const before = await getDb().prepare('SELECT version,encrypted_session_key FROM claude_subscriptions').get()
  const result = await f.request('PUT', { session_key: 'sk-ant-api03-not-a-cookie' })
  assert.equal(result.status, 400)
  assert.deepEqual(
    await getDb().prepare('SELECT version,encrypted_session_key FROM claude_subscriptions').get(),
    before,
  )
})
