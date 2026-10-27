import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeSubscriptionSessionKey,
  parseClaudeSubscription,
  queryClaudeSubscription,
} from '../../src/lib/oauth/claude-subscription.mjs'

const vm = { id: 'vm-fixture', claude: { account_uuid: 'fixture-account', org_uuid: 'fixture-org' } }
const cookie = 'sk-ant-sid01-synthetic-subscription'
const account = {
  uuid: 'fixture-account',
  memberships: [{ organization: { uuid: 'fixture-org', rate_limit_tier: 'default_claude_max_20x' } }],
}
const details = {
  status: 'active',
  next_charge_at: null,
  next_charge_date: '2026-11-05',
  plan_ending_at: null,
  plan_ending_before: null,
}

test('renewal and scheduled expiration keep their meaning and calendar precision', () => {
  assert.deepEqual(parseClaudeSubscription(details), {
    status: 'active',
    expires_at: null,
    expires_date_only: false,
    renews_at: '2026-11-05',
    renews_date_only: true,
  })
  const expires = parseClaudeSubscription({
    ...details,
    plan_ending_at: '2026-11-06T01:02:03Z',
    plan_ending_before: '2026-11-07',
  })
  assert.equal(expires.expires_at, '2026-11-06T01:02:03.000Z')
  assert.equal(expires.renews_at, null)
  assert.equal(expires.expires_date_only, false)
  assert.equal(parseClaudeSubscription({ ...details, status: 'canceled' }).renews_at, null)
  assert.equal(
    parseClaudeSubscription({ ...details, status: 'canceled', plan_ending_before: '2026-11-05' }).expires_date_only,
    true,
  )
})

test('missing dates remain unknown; malformed and unrelated dates are rejected', () => {
  const empty = parseClaudeSubscription({ ...details, next_charge_date: null })
  assert.equal(empty.renews_at, null)
  for (const body of [
    {},
    { status: 'active', resets_at: '2026-11-05' },
    { ...details, status: 'unknown' },
    { ...details, next_charge_date: '2026-02-30' },
    { ...details, next_charge_date: '2026-02-30T01:02:03Z' },
    { ...details, next_charge_date: 123 },
    { ...details, next_charge_date: '2026-11-05T01:02:03' },
  ]) {
    assert.throws(() => parseClaudeSubscription(body), { code: 'subscription_response_invalid' })
  }
})

test('only a single web session cookie value is accepted, without header injection', () => {
  assert.equal(normalizeSubscriptionSessionKey(` ${cookie} `), cookie)
  for (const key of [
    'sk-ant-api03-synthetic',
    'sk-ant-oat01-synthetic',
    `sessionKey=${cookie}`,
    `${cookie}; other=x`,
    `${cookie}\r\nX-Header: x`,
    null,
  ]) {
    assert.throws(() => normalizeSubscriptionSessionKey(key), { code: 'subscription_session_invalid' })
  }
})

test('subscription query sends exactly three fixed-origin GETs and verifies account and organization', async () => {
  const requests = []
  const result = await queryClaudeSubscription({
    vm,
    sessionKey: cookie,
    request: async (url, options) => {
      requests.push(url)
      assert.equal(options.method, 'GET')
      assert.deepEqual(options.headers, { Cookie: `sessionKey=${cookie}`, Accept: 'application/json' })
      return { status: 200, body: url.endsWith('/account') ? account : details }
    },
  })
  assert.deepEqual(requests, [
    'https://claude.ai/api/account',
    'https://claude.ai/api/organizations/fixture-org/subscription_details',
    'https://claude.ai/api/account',
  ])
  assert.equal(result.plan, 'Max 20x')
  assert.equal(result.renews_at, '2026-11-05')
  assert.equal(JSON.stringify(result).includes(cookie), false)
})

test('foreign account or organization is rejected before any billing request', async () => {
  for (const body of [
    { ...account, uuid: 'other-account' },
    { ...account, memberships: [] },
  ]) {
    let calls = 0
    await assert.rejects(
      queryClaudeSubscription({
        vm,
        sessionKey: cookie,
        request: async () => {
          calls += 1
          return { status: 200, body }
        },
      }),
      { code: 'subscription_account_mismatch' },
    )
    assert.equal(calls, 1)
  }
})

test('a web account switch during billing is rejected', async () => {
  let calls = 0
  await assert.rejects(
    queryClaudeSubscription({
      vm,
      sessionKey: cookie,
      request: async () => {
        calls += 1
        return {
          status: 200,
          body: calls === 2 ? details : calls === 3 ? { ...account, uuid: 'other-account' } : account,
        }
      },
    }),
    { code: 'subscription_account_mismatch' },
  )
})

test('HTTP and network errors never include the cookie or upstream response text', async () => {
  for (const [status, code] of [
    [401, 'subscription_session_expired'],
    [403, 'subscription_access_denied'],
    [429, 'subscription_rate_limited'],
    [500, 'subscription_request_failed'],
    [302, 'subscription_request_failed'],
  ]) {
    await assert.rejects(
      queryClaudeSubscription({ vm, sessionKey: cookie, request: async () => ({ status, body: cookie }) }),
      (error) => {
        assert.equal(error.code, code)
        assert.equal(error.message.includes(cookie), false)
        return true
      },
    )
  }
  await assert.rejects(
    queryClaudeSubscription({
      vm,
      sessionKey: cookie,
      request: async () => {
        throw new Error(cookie)
      },
    }),
    (error) => {
      assert.equal(error.message.includes(cookie), false)
      return error.code === 'subscription_request_failed'
    },
  )
})
