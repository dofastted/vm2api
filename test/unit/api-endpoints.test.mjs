import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ApiEndpointStore } from '../../src/lib/admin/api-endpoints.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kin-api-ep-'))
}

test('create endpoint with keys and models, list masks keys', () => {
  const store = new ApiEndpointStore({ dataDir: tmpDir() })
  const rec = store.create({
    name: 'openrouter',
    base_url: 'https://example.com',
    prefix: 'or',
    api_key_entries: [{ api_key: 'sk-or-secret-key-one' }],
    models: [{ name: 'moonshotai/kimi', alias: 'kimi' }],
  })
  assert.equal(rec.base_url, 'https://example.com')
  assert.equal(rec.api_key_entries.length, 1)
  assert.equal(rec.models[0].alias, 'kimi')
  const listed = store.list()
  assert.ok(listed[0].api_key_entries[0].api_key.includes('…'))
  assert.ok(!listed[0].api_key_entries[0].api_key.includes('secret-key'))
})

test('create strips trailing /v1 from base_url', () => {
  const store = new ApiEndpointStore({ dataDir: tmpDir() })
  const rec = store.create({
    name: 'a',
    base_url: 'https://example.com/v1/',
    api_key_entries: [{ api_key: 'sk-or-xxxx' }],
    models: [{ name: 'm', alias: 'm' }],
  })
  assert.equal(rec.base_url, 'https://example.com')
})

test('official kinds lock base_url', () => {
  const store = new ApiEndpointStore({ dataDir: tmpDir() })
  const claude = store.create({ kind: 'claude', api_key_entries: [{ api_key: 'sk-ant-xxxx' }] })
  assert.equal(claude.kind, 'claude')
  assert.equal(claude.base_url, 'https://api.anthropic.com')
  assert.equal(claude.protocol, 'anthropic')
  const openai = store.create({ kind: 'openai', name: 'oai', api_key_entries: [{ api_key: 'sk-oai-xxxx' }] })
  assert.equal(openai.kind, 'openai')
  assert.equal(openai.base_url, 'https://api.openai.com')
  assert.equal(openai.protocol, 'openai')
})

test('endpoint risk review defaults off and preserves explicit toggles across reloads', () => {
  const dataDir = tmpDir()
  let store = new ApiEndpointStore({ dataDir })
  try {
    const rec = store.create({ kind: 'claude' })
    assert.equal(rec.risk_review_enabled, false)
    assert.equal(store.listRaw()[0].risk_review_enabled, false)
    assert.equal(store.update(rec.id, { risk_review_enabled: true }).risk_review_enabled, true)
    store.db.close()
    store = new ApiEndpointStore({ dataDir })
    assert.equal(store.list()[0].risk_review_enabled, true)
    assert.equal(store.update(rec.id, { name: 'renamed' }).risk_review_enabled, true)
    assert.equal(store.update(rec.id, { risk_review_enabled: false }).risk_review_enabled, false)
    const enabled = store.create({ kind: 'claude', risk_review_enabled: true })
    assert.equal(enabled.risk_review_enabled, true)
    store.db.close()
    store = new ApiEndpointStore({ dataDir })
    assert.equal(store.getRaw(rec.id).risk_review_enabled, false)
    assert.equal(store.getRaw(enabled.id).risk_review_enabled, true)
  } finally {
    store.db.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('endpoint risk review rejects nonboolean values without changing the stored setting', () => {
  const dataDir = tmpDir()
  const store = new ApiEndpointStore({ dataDir })
  try {
    const rec = store.create({ kind: 'claude', risk_review_enabled: true })
    for (const value of ['false', 0, null, {}]) {
      assert.throws(() => store.create({ kind: 'claude', risk_review_enabled: value }), { code: 'invalid_risk_review' })
      assert.throws(() => store.update(rec.id, { risk_review_enabled: value }), { code: 'invalid_risk_review' })
      assert.equal(store.getRaw(rec.id).risk_review_enabled, true)
    }
  } finally {
    store.db.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('sk-kin category defaults oauth and can switch to api', () => {
  const keys = new ApiKeyStore({ dataDir: tmpDir() })
  const rec = keys.create({ name: 'c' })
  assert.equal(rec.category, 'oauth')
  const updated = keys.update(rec.id, { category: 'api' })
  assert.equal(updated.category, 'api')
  assert.equal(keys.list()[0].category, 'api')
})
