import test from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { applyModelRequestRules, loadModelPolicy, seedDefaultPolicy } from '../../src/lib/protocol/model-policy.mjs'

test('haiku 5.5 is in the panel seed and keeps forced tool choice', () => {
  const seed = seedDefaultPolicy()
  const row = seed.models['claude-haiku-5-5']
  assert.equal(row.params.max_tokens_default, 100000)
  assert.equal(row.params.max_tokens_cap, 100000)
  assert.equal(row.params.default_effort, 'medium')
  assert.equal(row.capabilities.context_window, 100000)
  assert.equal(row.capabilities.supports_effort, true)
  assert.equal(row.betas.pass_context_1m, false)
  assert.equal(seed.aliases.haiku, 'claude-haiku-4-5-20251001')

  const enabled = applyModelRequestRules({
    model: 'claude-haiku-5-5',
    thinking: { type: 'enabled', budget_tokens: 2048, display: 'omitted' },
    tool_choice: { type: 'tool', name: 'lookup' },
  })
  assert.deepEqual(enabled.thinking, { type: 'adaptive', display: 'omitted' })
  assert.deepEqual(enabled.tool_choice, { type: 'tool', name: 'lookup' })

  const kept = applyModelRequestRules({
    model: 'claude-haiku-5-5',
    output_config: { effort: 'high' },
    thinking: { type: 'disabled' },
  })
  assert.deepEqual(kept.thinking, { type: 'disabled' })

  const blocked = applyModelRequestRules({
    model: 'claude-haiku-5-5',
    output_config: { effort: 'max' },
    thinking: { type: 'disabled' },
  })
  assert.deepEqual(blocked.thinking, { type: 'adaptive' })
})

test('loading old Haiku 5.5 seed migrates only the old 1M defaults to 100K', async () => {
  await openDatabase({ dbPath: ':memory:' })
  try {
    const repo = new SettingsRepo()
    await repo.set('model_policy', {
      source: 'panel',
      models: {
        'claude-haiku-5-5': {
          display_name: 'Haiku 5.5',
          capabilities: { context_window: 1000000, supports_effort: true },
          params: {
            max_tokens_default: 128000,
            max_tokens_cap: 128000,
            default_effort: 'medium',
          },
        },
      },
    })
    await loadModelPolicy({ force: true })
    const stored = await repo.get('model_policy')
    const row = stored.models['claude-haiku-5-5']
    assert.equal(row.capabilities.context_window, 100000)
    assert.equal(row.params.max_tokens_default, 100000)
    assert.equal(row.params.max_tokens_cap, 100000)
    assert.equal(row.params.default_effort, 'medium')
  } finally {
    await closeDatabase()
  }
})
