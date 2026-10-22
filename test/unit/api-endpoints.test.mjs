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

test('create endpoint with keys and models, list masks keys', async () => {
  const store = new ApiEndpointStore({ dataDir: tmpDir() })
  const rec = await store.create({
    name: 'openrouter',
    base_url: 'https://example.com',
    prefix: 'or',
    api_key_entries: [{ api_key: 'sk-or-secret-key-one' }],
    models: [{ name: 'moonshotai/kimi', alias: 'kimi' }],
  })
  assert.equal(rec.base_url, 'https://example.com')
  assert.equal(rec.api_key_entries.length, 1)
  assert.equal(rec.models[0].alias, 'kimi')
  const listed = await store.list()
  assert.ok(listed[0].api_key_entries[0].api_key.includes('…'))
  assert.ok(!listed[0].api_key_entries[0].api_key.includes('secret-key'))
})

test('create strips trailing /v1 from base_url', async () => {
  const store = new ApiEndpointStore({ dataDir: tmpDir() })
  const rec = await store.create({
    name: 'a',
    base_url: 'https://example.com/v1/',
    api_key_entries: [{ api_key: 'sk-or-xxxx' }],
    models: [{ name: 'm', alias: 'm' }],
  })
  assert.equal(rec.base_url, 'https://example.com')
})

test('official kinds lock base_url', async () => {
  const store = new ApiEndpointStore({ dataDir: tmpDir() })
  const claude = await store.create({ kind: 'claude', api_key_entries: [{ api_key: 'sk-ant-xxxx' }] })
  assert.equal(claude.kind, 'claude')
  assert.equal(claude.base_url, 'https://api.anthropic.com')
  assert.equal(claude.protocol, 'anthropic')
  const openai = await store.create({ kind: 'openai', name: 'oai', api_key_entries: [{ api_key: 'sk-oai-xxxx' }] })
  assert.equal(openai.kind, 'openai')
  assert.equal(openai.base_url, 'https://api.openai.com')
  assert.equal(openai.protocol, 'openai')
})

test('sk-kin category defaults oauth and can switch to api', async () => {
  const keys = new ApiKeyStore({ dataDir: tmpDir() })
  const rec = await keys.create({ name: 'c' })
  assert.equal(rec.category, 'oauth')
  const updated = await keys.update(rec.id, { category: 'api' })
  assert.equal(updated.category, 'api')
  assert.equal((await keys.list())[0].category, 'api')
})
