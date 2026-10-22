import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api } from '../harness.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'

const env = { VM2API_CONTROL_PLANE_MODE: 'kubernetes', KIN_BACKUP_DISABLED: '1' }
const model = 'claude-haiku-4-5-20251001'

test('Kubernetes HTTP inference atomically reserves the last request quota and releases after settlement', async () => {
  const gw = await startGateway({ env, mockText: 'one-global-request' })
  try {
    const created = await api(gw, 'POST', '/api/panel/api-keys', {
      body: { name: 'shared-quota', max_concurrency: 0, quota_requests: 1, rpm: 0 },
    })
    assert.equal(created.status, 201, created.text)
    const key = created.json.item
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        api(gw, 'POST', '/v1/messages', {
          headers: { authorization: `Bearer ${key.key}` },
          body: { model, max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'one request' }] },
        }),
      ),
    )
    assert.equal(results.filter((r) => r.status === 200).length, 1, results.map((r) => r.text).join('\n'))
    assert.ok(results.filter((r) => r.status !== 200).every((r) => r.status === 429))
    const saved = await gw.db.prepare('SELECT requests, quota_requests_used FROM api_keys WHERE id = $1').get(key.id)
    assert.deepEqual(saved, { requests: 1, quota_requests_used: 1 })
    let remaining
    const deadline = Date.now() + 2000
    do {
      remaining = (
        await gw.db
          .prepare('SELECT count(*) AS n FROM api_key_admissions WHERE key_id = $1 AND released_at IS NULL')
          .get(key.id)
      ).n
      if (!remaining) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    } while (Date.now() < deadline)
    assert.equal(remaining, 0)
    const rows = await gw.db
      .prepare('SELECT settled_at, released_at FROM api_key_admissions WHERE key_id = $1')
      .all(key.id)
    assert.equal(rows.length, 1)
    assert.ok(rows[0].settled_at <= rows[0].released_at)
  } finally {
    await gw.stop()
  }
})

test('Kubernetes request authentication reloads a model policy changed by another process connection', async () => {
  const gw = await startGateway({ env })
  try {
    const settings = new SettingsRepo(gw.db)
    const policy = await settings.get('model_policy')
    assert.ok(policy.models[model])
    policy.models[model].enabled = false
    await settings.set('model_policy', policy)
    const before = await gw.db.prepare("SELECT value, updated_at FROM settings WHERE key = 'model_policy'").get()
    const response = await api(gw, 'GET', '/api/panel/model-policy')
    assert.equal(response.status, 200, response.text)
    assert.equal(response.json.data.policy.models[model].enabled, false)
    assert.deepEqual(
      await gw.db.prepare("SELECT value, updated_at FROM settings WHERE key = 'model_policy'").get(),
      before,
    )
  } finally {
    await gw.stop()
  }
})

test('Kubernetes panel proxy reads reload a record committed by another process connection', async () => {
  const gw = await startGateway({ env })
  try {
    const added = await api(gw, 'POST', '/api/panel/proxies/import', { body: { text: '127.0.0.1:1080' } })
    assert.equal(added.status, 200, added.text)
    const id = (added.json.data || added.json).items[0].id
    await gw.db.prepare('UPDATE proxies SET label = $2 WHERE id = $1').run(id, 'external-label')
    const listed = await api(gw, 'GET', '/api/panel/proxies')
    assert.equal(listed.status, 200, listed.text)
    const current = (listed.json.data || listed.json).proxies.find((row) => row.id === id)
    assert.equal(current?.label, 'external-label')
  } finally {
    await gw.stop()
  }
})
