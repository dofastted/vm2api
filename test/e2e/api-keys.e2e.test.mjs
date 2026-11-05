import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api } from '../harness.mjs'

const MODEL = 'claude-haiku-4-5-20251001'

test('real admin and user sessions cannot list or operate each other personal keys', async () => {
  const gw = await startGateway()
  try {
    const login = async (username, password) => {
      const response = await api(gw, 'POST', '/api/panel/login', { body: { username, password } })
      assert.equal(response.status, 200, response.text)
      return response.headers.get('set-cookie')
    }
    const adminCookie = await login('admin', 'testpass')
    const user = await api(gw, 'POST', '/api/panel/users', {
      body: { username: 'key-owner', password: 'fixture-key-owner-pass', role: 'user' },
    })
    assert.equal(user.status, 201, user.text)
    const userId = (user.json.data?.item || user.json.item).id
    const userCookie = await login('key-owner', 'fixture-key-owner-pass')
    const personal = (cookie, method, path, body) =>
      api(gw, method, path, {
        headers: { authorization: '', cookie },
        body,
      })
    const platform = await api(gw, 'POST', '/api/panel/api-keys', { body: { name: 'platform' } })
    assert.equal(platform.status, 201, platform.text)
    const userKey = await personal(userCookie, 'POST', '/api/panel/api-keys', { name: 'user-key' })
    assert.equal(userKey.status, 201, userKey.text)
    assert.equal(userKey.json.item.user_id, userId)
    const adminKey = await personal(adminCookie, 'POST', '/api/panel/api-keys', { name: 'admin-key', user_id: userId })
    assert.equal(adminKey.status, 201, adminKey.text)
    assert.ok(adminKey.json.item.user_id)
    assert.notEqual(adminKey.json.item.user_id, userId)
    for (const [cookie, own, foreign] of [
      [adminCookie, adminKey.json.item.id, userKey.json.item.id],
      [userCookie, userKey.json.item.id, adminKey.json.item.id],
    ]) {
      const list = await personal(cookie, 'GET', `/api/panel/api-keys?user_id=${userId}`)
      assert.equal(list.status, 200, list.text)
      assert.equal(list.json.total, 1)
      assert.equal(list.json.active, 1)
      assert.deepEqual(
        list.json.keys.map((key) => key.id),
        [own],
      )
      for (const [method, suffix] of [
        ['GET', '/stats'],
        ['POST', '/reveal'],
        ['PATCH', ''],
        ['POST', '/rotate'],
        ['POST', '/reset-quota'],
        ['DELETE', ''],
      ]) {
        for (const id of [foreign, platform.json.item.id, 'missing']) {
          const denied = await personal(
            cookie,
            method,
            `/api/panel/api-keys/${id}${suffix}`,
            method === 'PATCH' ? { name: 'hijacked' } : undefined,
          )
          assert.equal(denied.status, 404, `${method} ${suffix}: ${denied.text}`)
        }
      }
      const reveal = await personal(cookie, 'POST', `/api/panel/api-keys/${own}/reveal`)
      assert.equal(reveal.status, 200, reveal.text)
    }
    const masterList = await api(gw, 'GET', '/api/panel/api-keys')
    assert.deepEqual(
      masterList.json.keys.map((key) => key.id),
      [platform.json.item.id],
    )
  } finally {
    await gw.stop()
  }
})

test('panel creates managed key; key can call /v1/messages', async () => {
  const gw = await startGateway({ mockText: 'hello-key' })
  try {
    const created = await api(gw, 'POST', '/api/panel/api-keys', {
      body: { name: 'e2e', max_concurrency: 2, quota_requests: 5, rpm: 60 },
    })
    assert.equal(created.status, 201, created.text)
    assert.ok(created.json.item?.key?.startsWith('sk-vm-'))
    const key = created.json.item.key

    const r = await api(gw, 'POST', '/v1/messages', {
      headers: { authorization: `Bearer ${key}` },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(r.status, 200, r.text)
    assert.match(JSON.stringify(r.json), /hello-key/)

    const list = await api(gw, 'GET', '/api/panel/api-keys')
    assert.equal(list.status, 200)
    assert.ok(list.json.keys.some((k) => k.name === 'e2e'))
    assert.ok(list.json.keys[0].key.includes('…'))
  } finally {
    await gw.stop()
  }
})

test('panel re-reveals a used key; rotate swaps the plaintext', async () => {
  const gw = await startGateway({ mockText: 'copyable' })
  try {
    const created = await api(gw, 'POST', '/api/panel/api-keys', { body: { name: 'copy' } })
    assert.equal(created.status, 201, created.text)
    const id = created.json.item.id
    const key = created.json.item.key

    const call = await api(gw, 'POST', '/v1/messages', {
      headers: { authorization: `Bearer ${key}` },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(call.status, 200, call.text)

    const shown = await api(gw, 'POST', `/api/panel/api-keys/${id}/reveal`)
    assert.equal(shown.status, 200, shown.text)
    assert.equal(shown.json.key, key)

    const rotated = await api(gw, 'POST', `/api/panel/api-keys/${id}/rotate`)
    assert.equal(rotated.status, 200, rotated.text)
    const next = rotated.json.item.key
    assert.ok(next.startsWith('sk-vm-'))
    assert.notEqual(next, key)

    const old = await api(gw, 'POST', '/v1/messages', {
      headers: { authorization: `Bearer ${key}` },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'x' }] },
    })
    assert.equal(old.status, 401, old.text)

    const fresh = await api(gw, 'POST', '/v1/messages', {
      headers: { authorization: `Bearer ${next}` },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'x' }] },
    })
    assert.equal(fresh.status, 200, fresh.text)
  } finally {
    await gw.stop()
  }
})

test('quota_requests=1 rejects second call', async () => {
  const gw = await startGateway({ mockText: 'once' })
  try {
    const created = await api(gw, 'POST', '/api/panel/api-keys', {
      body: { name: 'quota1', max_concurrency: 2, quota_requests: 1, rpm: 0 },
    })
    assert.equal(created.status, 201, created.text)
    const key = created.json.item.key

    const a = await api(gw, 'POST', '/v1/messages', {
      headers: { authorization: `Bearer ${key}` },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: '1' }] },
    })
    assert.equal(a.status, 200, a.text)

    const b = await api(gw, 'POST', '/v1/messages', {
      headers: { authorization: `Bearer ${key}` },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: '2' }] },
    })
    assert.equal(b.status, 429, b.text)
    assert.match(JSON.stringify(b.json), /quota/i)
  } finally {
    await gw.stop()
  }
})

test('panel quota aliases keep request and USD units consistent on create and update', async () => {
  const gw = await startGateway()
  try {
    const created = await api(gw, 'POST', '/api/panel/api-keys', {
      body: { name: 'quota-aliases', quota: 10, quota_usd: 5 },
    })
    assert.equal(created.status, 201, created.text)
    assert.equal(created.json.item.quota_requests, 10)
    assert.equal(created.json.item.quota_usd, 5)

    const updated = await api(gw, 'PATCH', `/api/panel/api-keys/${created.json.item.id}`, {
      body: { quota: 20, quota_usd: 7 },
    })
    assert.equal(updated.status, 200, updated.text)
    assert.equal(updated.json.item.quota_requests, 20)
    assert.equal(updated.json.item.quota_usd, 7)
  } finally {
    await gw.stop()
  }
})

test('disabled key returns 403', async () => {
  const gw = await startGateway()
  try {
    const created = await api(gw, 'POST', '/api/panel/api-keys', {
      body: { name: 'off' },
    })
    const id = created.json.item.id
    const key = created.json.item.key
    await api(gw, 'PATCH', `/api/panel/api-keys/${id}`, { body: { status: 'disabled' } })
    const r = await api(gw, 'POST', '/v1/messages', {
      headers: { authorization: `Bearer ${key}` },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'x' }] },
    })
    assert.equal(r.status, 403, r.text)
  } finally {
    await gw.stop()
  }
})

test('master key still works; delete key invalidates', async () => {
  const gw = await startGateway({ mockText: 'master' })
  try {
    const created = await api(gw, 'POST', '/api/panel/api-keys', { body: { name: 'tmp' } })
    const id = created.json.item.id
    const key = created.json.item.key
    const del = await api(gw, 'DELETE', `/api/panel/api-keys/${id}`)
    assert.equal(del.status, 200)
    const r = await api(gw, 'POST', '/v1/messages', {
      headers: { authorization: `Bearer ${key}` },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'x' }] },
    })
    assert.equal(r.status, 401, r.text)

    // master (harness apiKey) still works
    const m = await api(gw, 'POST', '/v1/messages', {
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'x' }] },
    })
    assert.equal(m.status, 200, m.text)
  } finally {
    await gw.stop()
  }
})

test('managed key cannot access panel admin APIs', async () => {
  const gw = await startGateway()
  try {
    const created = await api(gw, 'POST', '/api/panel/api-keys', {
      body: { name: 'client-only', max_concurrency: 2 },
    })
    assert.equal(created.status, 201, created.text)
    const key = created.json.item.key

    const dash = await api(gw, 'GET', '/api/panel/dashboard', {
      headers: { authorization: `Bearer ${key}` },
    })
    assert.equal(dash.status, 403, dash.text)

    const logs = await api(gw, 'GET', '/api/panel/request-logs?mode=debug', {
      headers: { authorization: `Bearer ${key}` },
    })
    assert.equal(logs.status, 403, logs.text)

    const keys = await api(gw, 'GET', '/api/panel/api-keys', {
      headers: { authorization: `Bearer ${key}` },
    })
    assert.equal(keys.status, 403, keys.text)
  } finally {
    await gw.stop()
  }
})
