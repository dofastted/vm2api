import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase, getDb, withTransaction } from '../../src/lib/db/database.mjs'
import { RuntimeSettings } from '../../src/lib/db/settings-state.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import * as claudePolicy from '../../src/lib/protocol/model-policy.mjs'
import * as gptPolicy from '../../src/lib/protocol/gpt-model-policy.mjs'
import { clearModelsCache, gatewayModelCatalog } from '../../src/lib/protocol/models.mjs'
import { invalidatePriceCatalog, resolvePrice } from '../../src/lib/admin/price-catalog.mjs'

const claude = 'claude-sonnet-5-5'
const gpt = 'gpt-5.6'
const price = (input) => ({ input, output: 11, cache_read: 0.9, cache_5m: 11.25, cache_1h: 18 })

function refreshPolicies(snapshot) {
  const nextClaude = claudePolicy.refreshModelPolicy(snapshot.model_policy)
  const nextGpt = gptPolicy.refreshGptModelPolicy(snapshot.gpt_model_policy)
  invalidatePriceCatalog()
  assert.equal(nextClaude, claudePolicy.getModelPolicy())
  assert.equal(nextGpt, gptPolicy.getGptModelPolicy())
  assert.equal(nextClaude.then, undefined)
  assert.equal(nextGpt.then, undefined)
}

test('a refreshed PG settings snapshot updates model switches, catalog and prices without writing settings', async (t) => {
  const db = getDb()
  const settings = new RuntimeSettings(db)
  const repo = new SettingsRepo(db)
  const other = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  t.after(async () => {
    await other.close()
    clearModelsCache()
    invalidatePriceCatalog()
  })
  await repo.set('model_policy', claudePolicy.seedDefaultPolicy())
  await repo.set('gpt_model_policy', gptPolicy.seedGptPolicy())
  await repo.set('model_price_overrides', { [`anthropic/${claude}`]: price(1) })
  await claudePolicy.loadModelPolicy({ force: true })
  await gptPolicy.loadGptModelPolicy({ force: true })
  clearModelsCache()
  invalidatePriceCatalog()
  assert.equal(claudePolicy.isModelEnabled(claude), true)
  assert.equal(gptPolicy.isGptModelEnabled(gpt), true)
  assert.equal(resolvePrice(claude).price.input, 1)

  const remote = new SettingsRepo(other)
  await withTransaction(other, async () => {
    await remote.set('model_policy', {
      catalog_mode: 'policy_only',
      models: { [claude]: { enabled: false }, 'claude-sonnet-9-review': { enabled: true } },
    })
    await remote.set('gpt_model_policy', {
      source: 'codex',
      models: { [gpt]: { enabled: false }, 'gpt-9-review': { enabled: true } },
    })
    await remote.set('model_price_overrides', { [`anthropic/${claude}`]: price(9) })
  })
  const before = await db.prepare('SELECT key, value, updated_at FROM settings ORDER BY key').all()
  // A write from another connection does not change this process's loaded policies.
  assert.equal(claudePolicy.isModelEnabled(claude), true)
  assert.equal(gptPolicy.isGptModelEnabled(gpt), true)
  assert.equal(resolvePrice(claude).price.input, 1)

  const snapshot = await settings.refresh()
  const originalSnapshot = structuredClone(snapshot)
  refreshPolicies(snapshot)
  assert.deepEqual(snapshot, originalSnapshot)
  assert.equal(claudePolicy.isModelEnabled(claude), false)
  assert.equal(gptPolicy.isGptModelEnabled(gpt), false)
  const ids = gatewayModelCatalog().data.map((row) => row.id)
  assert.equal(ids.includes(claude), false)
  assert.equal(ids.includes(gpt), false)
  assert.equal(ids.includes('claude-sonnet-9-review'), true)
  assert.equal(ids.includes('gpt-9-review'), true)
  // A live GPT catalog must not add seed-only ids on every refresh.
  assert.equal(ids.includes('gpt-6-sol'), false)
  assert.equal(resolvePrice(claude).price.input, 9)
  // Loaded state prevents a later ordinary load from persisting a seed or migration.
  await claudePolicy.loadModelPolicy()
  await gptPolicy.loadGptModelPolicy()
  assert.deepEqual(await db.prepare('SELECT key, value, updated_at FROM settings ORDER BY key').all(), before)
})

test('missing policy values use runtime defaults without seeding PostgreSQL', async () => {
  const db = getDb()
  const settings = new RuntimeSettings(db)
  const before = await db.prepare('SELECT key, value, updated_at FROM settings ORDER BY key').all()
  refreshPolicies(await settings.refresh())
  assert.equal(claudePolicy.isModelEnabled(claude), true)
  assert.equal(gptPolicy.isGptModelEnabled(gpt), true)
  await claudePolicy.loadModelPolicy()
  await gptPolicy.loadGptModelPolicy()
  assert.deepEqual(await db.prepare('SELECT key, value, updated_at FROM settings ORDER BY key').all(), before)
  assert.equal(await new SettingsRepo(db).has('model_policy'), false)
  assert.equal(await new SettingsRepo(db).has('gpt_model_policy'), false)
})
