import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api } from '../harness.mjs'

const MODEL = 'claude-haiku-4-5-20251001'

test('managed keys read their own quota and usage; expired keys still can, disabled cannot', async () => {
  const gw = await startGateway()
  try {
    const create = async (body) => {
      const created = await api(gw, 'POST', '/api/panel/api-keys', { body })
      assert.equal(created.status, 201, created.text)
      return created.json.item
    }
    const as = (key) => ({ headers: { authorization: `Bearer ${key}` } })

    const live = await create({ name: 'self', quota_usd: 5, rate_limit_5h: 2, rpm: 30, max_concurrency: 3 })
    const quota = await api(gw, 'GET', '/v1/me/quota', as(live.key))
    assert.equal(quota.status, 200, quota.text)
    assert.equal(quota.json.object, 'api_key_quota')
    assert.equal(quota.json.key.name, 'self')
    assert.equal(quota.json.accepting, true)
    assert.deepEqual(quota.json.usd, { limit: 5, used: 0, remaining: 5, exceeded: false })
    assert.equal(quota.json.windows['5h'].limit, 2)
    assert.deepEqual(quota.json.rpm, { limit: 30, current: 0, exceeded: false })
    assert.deepEqual(quota.json.concurrency, { limit: 3, inflight: 0, exceeded: false })
    assert.ok(!quota.text.includes(live.key))

    const usage = await api(gw, 'GET', '/v1/me/usage?limit=5', {
      headers: { 'x-api-key': live.key, authorization: '' },
    })
    assert.equal(usage.status, 200, usage.text)
    assert.equal(usage.json.periods.today.requests, 0)
    assert.deepEqual(usage.json.recent, { items: [], has_more: false, next_before: null })

    const master = await api(gw, 'GET', '/v1/me/quota')
    assert.equal(master.status, 400, master.text)
    assert.equal(master.json.error.code, 'managed_key_required')

    const old = await create({ name: 'old', expires_at: new Date(Date.now() - 60_000).toISOString() })
    const refused = await api(gw, 'POST', '/v1/messages', {
      ...as(old.key),
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(refused.status, 403, refused.text)
    assert.equal(refused.json.error.code, 'api_key_expired')
    const why = await api(gw, 'GET', '/v1/me/quota', as(old.key))
    assert.equal(why.status, 200, why.text)
    assert.equal(why.json.key.expired, true)
    assert.equal(why.json.blocked_by.code, 'api_key_expired')

    await api(gw, 'PATCH', `/api/panel/api-keys/${live.id}`, { body: { status: 'disabled' } })
    const disabled = await api(gw, 'GET', '/v1/me/quota', as(live.key))
    assert.equal(disabled.status, 401, disabled.text)
    assert.equal(disabled.json.error.code, 'api_key_disabled')

    await api(gw, 'DELETE', `/api/panel/api-keys/${old.id}`)
    const deleted = await api(gw, 'GET', '/v1/me/usage', as(old.key))
    assert.equal(deleted.status, 401, deleted.text)
  } finally {
    await gw.stop()
  }
})
