import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import {
  normalizePolicy,
  loadModelPolicy,
  seedDefaultPolicy,
  normalizeThinkingByPolicy,
} from '../../src/lib/protocol/model-policy.mjs'
import { clearModelsCache } from '../../src/lib/protocol/models.mjs'

const legacy = 'claude-opus-5.5'
const canonical = 'claude-opus-5-5'

test('seed Opus 5.5 uses the 2.1.280 id, medium effort, and 128k output', () => {
  const seed = seedDefaultPolicy()
  const model = seed.models[canonical]
  assert.equal(model.display_name, 'Opus 5.5')
  assert.equal(model.params.max_tokens_default, 128000)
  assert.equal(model.params.max_tokens_cap, 128000)
  assert.equal(model.params.default_effort, 'medium')
  assert.equal(model.params.on_enabled, 'convert_to_adaptive')
  assert.equal(model.betas.pass_context_1m, true)
  assert.deepEqual(model.aliases, [legacy])
  assert.equal(seed.aliases.opus, 'claude-opus-5')
  assert.equal(seed.aliases[legacy], canonical)
  assert.equal(seed.models[legacy], undefined)
})

test('a saved dotted Opus 5.5 row keeps administrator overrides on the hyphen id', () => {
  const migrated = normalizePolicy({
    models: {
      [legacy]: {
        enabled: false,
        display_name: 'private 5.5',
        params: { max_tokens_cap: 4096 },
      },
    },
    aliases: { 'my-opus': legacy },
  })
  assert.equal(migrated.models[legacy], undefined)
  assert.equal(migrated.models[canonical].enabled, false)
  assert.equal(migrated.models[canonical].display_name, 'private 5.5')
  assert.equal(migrated.models[canonical].params.max_tokens_cap, 4096)
  assert.equal(migrated.models[canonical].params.on_enabled, 'convert_to_adaptive')
  assert.equal(migrated.aliases['my-opus'], canonical)
  assert.equal(migrated.aliases[legacy], canonical)
})

test('loading settings that predate Opus 5.5 appends the model without resetting Opus 5', async () => {
  await openDatabase({ dbPath: ':memory:' })
  try {
    const repo = new SettingsRepo()
    await repo.set('model_policy', {
      source: 'panel',
      models: { 'claude-opus-5': { enabled: false, display_name: 'kept' } },
      aliases: { opus: 'claude-opus-5' },
    })
    await loadModelPolicy({ force: true })
    const stored = await repo.get('model_policy')
    assert.equal(stored.models['claude-opus-5'].enabled, false)
    assert.equal(stored.models['claude-opus-5'].display_name, 'kept')
    assert.equal(stored.models[canonical].display_name, 'Opus 5.5')
    assert.equal(stored.models[canonical].params.default_effort, 'medium')
    assert.equal(stored.aliases[legacy], canonical)
    assert.equal(stored.models[legacy], undefined)
    const thinking = normalizeThinkingByPolicy({
      model: legacy,
      thinking: { type: 'disabled', budget_tokens: 1000 },
    })
    assert.deepEqual(thinking.thinking, { type: 'adaptive' })
    assert.equal(thinking.thinking.budget_tokens, undefined)
  } finally {
    await closeDatabase()
    clearModelsCache()
  }
})
