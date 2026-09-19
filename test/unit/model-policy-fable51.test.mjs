import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import {
  normalizePolicy,
  loadModelPolicy,
  getPolicyCatalogIds,
  filterPublicModelIds,
  syncWorkerModelsIntoPolicy,
} from '../../src/lib/protocol/model-policy.mjs'
import { clearModelsCache, validateOfficialModel } from '../../src/lib/protocol/models.mjs'

const legacy = 'claude-fable-5.1'
const canonical = 'claude-fable-5-1'

test('migrates saved dotted Fable 5.1 policy without losing administrator overrides', () => {
  const oldEntry = {
    enabled: false,
    display_name: 'Private Fable',
    params: { max_tokens_cap: 4096, on_adaptive: 'strip' },
    betas: { pass_context_1m: true, required: ['custom-beta'], drop: [] },
    capabilities: { context_window: 123456 },
    aliases: ['private-fable'],
  }
  const raw = {
    models: { [legacy]: oldEntry },
    aliases: { 'my-fable': legacy, unrelated: 'claude-sonnet-5' },
  }
  const before = structuredClone(raw)
  const migrated = normalizePolicy(raw)
  const model = migrated.models[canonical]
  assert.equal(migrated.models[legacy], undefined)
  assert.equal(model.enabled, false)
  assert.equal(model.display_name, oldEntry.display_name)
  assert.equal(model.params.max_tokens_cap, 4096)
  assert.equal(model.params.on_adaptive, 'strip')
  assert.equal(model.betas.pass_context_1m, true)
  assert.deepEqual(model.betas.required, ['custom-beta'])
  assert.deepEqual(model.betas.drop, [])
  assert.equal(model.capabilities.context_window, 123456)
  assert.deepEqual(model.aliases, [legacy, 'private-fable'])
  assert.equal(migrated.aliases['my-fable'], canonical)
  assert.equal(migrated.aliases[legacy], canonical)
  assert.equal(migrated.aliases.unrelated, 'claude-sonnet-5')
  assert.deepEqual(raw, before)
  assert.deepEqual(normalizePolicy(migrated), migrated)
})

test('explicit canonical overrides win over legacy fields in either insertion order', () => {
  const oldEntry = {
    enabled: false,
    params: { max_tokens_cap: 1024, max_tokens_default: 512 },
    betas: { pass_context_1m: true, required: ['legacy-beta'] },
    aliases: ['legacy-alias'],
  }
  const newEntry = {
    enabled: true,
    params: { max_tokens_cap: 2048 },
    betas: { pass_context_1m: false },
    aliases: ['canonical-alias'],
  }
  for (const entries of [
    [
      [legacy, oldEntry],
      [canonical, newEntry],
    ],
    [
      [canonical, newEntry],
      [legacy, oldEntry],
    ],
  ]) {
    const migrated = normalizePolicy({ models: Object.fromEntries(entries) })
    const model = migrated.models[canonical]
    assert.equal(model.enabled, true)
    assert.equal(model.params.max_tokens_cap, 2048)
    assert.equal(model.params.max_tokens_default, 512)
    assert.equal(model.betas.pass_context_1m, false)
    assert.deepEqual(model.betas.required, ['legacy-beta'])
    assert.deepEqual(model.aliases, [legacy, 'legacy-alias', 'canonical-alias'])
    assert.equal(migrated.models[legacy], undefined)
  }
})

test('loading a persisted disabled legacy model keeps both request spellings disabled', () => {
  openDatabase({ dbPath: ':memory:' })
  try {
    new SettingsRepo().set('model_policy', {
      catalog_mode: 'worker_only',
      models: { [legacy]: { enabled: false } },
      aliases: { private: legacy },
    })
    loadModelPolicy()
    clearModelsCache()
    const ids = getPolicyCatalogIds()
    assert.ok(ids.includes(canonical))
    assert.ok(!ids.includes(legacy))
    for (const model of [canonical, legacy, 'private']) {
      const result = validateOfficialModel(model)
      assert.equal(result.ok, false, model)
      assert.equal(result.error.code, 'model_disabled', model)
    }
    assert.deepEqual(filterPublicModelIds([legacy, canonical]), [canonical])
    syncWorkerModelsIntoPolicy([legacy])
    assert.ok(!getPolicyCatalogIds().includes(legacy))
  } finally {
    closeDatabase()
    loadModelPolicy()
    clearModelsCache()
  }
})
