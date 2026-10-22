import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { loadModelPolicy, getModelPolicy } from '../../src/lib/protocol/model-policy.mjs'
import {
  loadGptModelPolicy,
  getGptModelPolicy,
  syncGptIdsIntoPolicy,
} from '../../src/lib/protocol/gpt-model-policy.mjs'
import { clearModelsCache } from '../../src/lib/protocol/models.mjs'
import { readCatalogSync, syncClaudeCatalog } from '../../src/lib/admin/catalog-monitor.mjs'

function seedClaudeVm(root, id) {
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', `${id}.json`),
    JSON.stringify({
      id,
      status: 'running',
      claude: { access_token: 'at', refresh_token: 'rt', account_uuid: `acc-${id}` },
      proxy: { url: 'socks5h://127.0.0.1:1080' },
    }),
  )
}

async function withDb(t, catalogMode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-catalog-sync-'))
  await openDatabase({ dbPath: ':memory:' })
  if (catalogMode) await new SettingsRepo().set('model_policy', { catalog_mode: catalogMode, models: {} })
  await loadModelPolicy({ force: true })
  await loadGptModelPolicy({ force: true })
  clearModelsCache()
  t.after(async () => {
    await closeDatabase()
    await loadModelPolicy({ force: true })
    await loadGptModelPolicy({ force: true })
    clearModelsCache()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}

const upstream = (ids) => async () => ({ ok: true, status: 200, body: { data: ids.map((id) => ({ id })) } })

test('a Claude id new to the policy is added disabled outside worker_only', async (t) => {
  const root = await withDb(t, 'policy_only')
  seedClaudeVm(root, 'vm-1')
  const before = getModelPolicy().models['claude-opus-5']
  const status = await syncClaudeCatalog({
    projectRoot: root,
    runOauth: upstream(['claude-opus-5', 'claude-opus-6-preview']),
  })
  assert.equal(status.status, 'ok')
  assert.deepEqual(status.added, ['claude-opus-6-preview'])
  const models = getModelPolicy().models
  assert.equal(models['claude-opus-6-preview'].enabled, false)
  assert.deepEqual(models['claude-opus-5'], before)
  assert.equal(readCatalogSync().claude.status, 'ok')
})

test('worker_only publishes a new Claude id immediately', async (t) => {
  const root = await withDb(t, 'worker_only')
  seedClaudeVm(root, 'vm-1')
  await syncClaudeCatalog({ projectRoot: root, runOauth: upstream(['claude-opus-6-preview']) })
  assert.equal(getModelPolicy().models['claude-opus-6-preview'].enabled, true)
})

test('Claude sync without a reachable slot records the failure and changes nothing', async (t) => {
  const root = await withDb(t, 'policy_only')
  seedClaudeVm(root, 'vm-1')
  const before = structuredClone(getModelPolicy().models)
  const status = await syncClaudeCatalog({
    projectRoot: root,
    runOauth: async () => ({ ok: false, status: 401, body: { error: { code: 'upstream_auth' } } }),
  })
  assert.equal(status.status, 'error')
  assert.equal(status.error, 'upstream_auth')
  assert.deepEqual(getModelPolicy().models, before)
})

test('a GPT id new to the policy starts disabled; known ids keep their switch', async (t) => {
  await withDb(t)
  const result = await syncGptIdsIntoPolicy([{ id: 'gpt-5.6' }, { id: 'gpt-7-preview' }])
  assert.deepEqual(result.added, ['gpt-7-preview'])
  const models = getGptModelPolicy().models
  assert.equal(models['gpt-5.6'].enabled, true)
  assert.equal(models['gpt-7-preview'].enabled, false)
  assert.ok(!result.ids.includes('gpt-7-preview'))
})
