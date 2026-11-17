import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import {
  GPT_SEED_VERSION,
  getGptModelPolicy,
  isGptFastAliasAvailable,
  isGptModelEnabled,
  isImageToolModelEnabled,
  listGptPolicyModels,
  listGptFastAliases,
  listImageToolModels,
  loadGptModelPolicy,
  resetGptModelPolicy,
  saveGptModelPolicy,
  syncGptIdsIntoPolicy,
} from '../../src/lib/protocol/gpt-model-policy.mjs'

function withDb(t) {
  openDatabase({ dbPath: ':memory:' })
  loadGptModelPolicy({ force: true })
  t.after(() => {
    closeDatabase()
    loadGptModelPolicy({ force: true })
  })
}

test('seed enables image models', (t) => {
  withDb(t)
  assert.deepEqual(getGptModelPolicy().image_tools, {
    'gpt-image-2.6-flare': { enabled: true },
    'gpt-image-2.6-sunburst': { enabled: true },
    'gpt-image-2.5-flare': { enabled: true },
    'gpt-image-2.5-sunburst': { enabled: true },
    'gpt-image-2': { enabled: true },
  })
  assert.deepEqual(
    listImageToolModels().map((m) => [m.id, m.enabled, m.upstream_default]),
    [
      ['gpt-image-2.6-flare', true, true],
      ['gpt-image-2.6-sunburst', true, false],
      ['gpt-image-2.5-flare', true, false],
      ['gpt-image-2.5-sunburst', true, false],
      ['gpt-image-2', true, false],
    ],
  )
})

test('save keeps only known image ids with boolean enabled', (t) => {
  withDb(t)
  saveGptModelPolicy({
    image_tools: {
      'gpt-image-2.5-sunburst': { enabled: false },
      'gpt-image-2': { enabled: false },
      'gpt-image-future': { enabled: false },
      'gpt-image-2.5-flare': { enabled: 'no' },
    },
  })
  assert.deepEqual(getGptModelPolicy().image_tools, {
    'gpt-image-2.6-flare': { enabled: true },
    'gpt-image-2.6-sunburst': { enabled: true },
    'gpt-image-2.5-flare': { enabled: true },
    'gpt-image-2.5-sunburst': { enabled: false },
    'gpt-image-2': { enabled: false },
  })
  const stored = new SettingsRepo().get('gpt_model_policy', null)
  assert.equal(stored.image_tools['gpt-image-2.5-sunburst'].enabled, false)
  assert.equal(stored.image_tools['gpt-image-future'], undefined)
})

test('save without image_tools keeps the current switches', (t) => {
  withDb(t)
  saveGptModelPolicy({ image_tools: { 'gpt-image-2.5-flare': { enabled: false } } })
  saveGptModelPolicy({ models: { 'gpt-6-luna': { enabled: true } } })
  assert.equal(getGptModelPolicy().image_tools['gpt-image-2.5-flare'].enabled, false)
})

test('reset and reload restore image switches', (t) => {
  withDb(t)
  saveGptModelPolicy({ image_tools: { 'gpt-image-2.5-flare': { enabled: false } } })
  loadGptModelPolicy({ force: true })
  assert.equal(isImageToolModelEnabled('gpt-image-2.5-flare'), false)
  resetGptModelPolicy()
  assert.equal(isImageToolModelEnabled('gpt-image-2.5-flare'), true)
})

test('isImageToolModelEnabled folds snapshots and returns null for unknown ids', (t) => {
  withDb(t)
  saveGptModelPolicy({ image_tools: { 'gpt-image-2.5-sunburst': { enabled: false } } })
  assert.equal(isImageToolModelEnabled('gpt-image-2.5-sunburst-2026-09-08'), false)
  assert.equal(isImageToolModelEnabled('gpt-image-2.5-flare'), true)
  assert.equal(isImageToolModelEnabled('gpt-image-future'), null)
  assert.equal(isImageToolModelEnabled(''), null)
})

test('image models never enter the GPT chat catalog', (t) => {
  withDb(t)
  saveGptModelPolicy({ models: { 'gpt-image-2.5-flare': { enabled: true } } })
  assert.equal(getGptModelPolicy().models['gpt-image-2.5-flare'], undefined)
  const synced = syncGptIdsIntoPolicy([{ id: 'gpt-6-luna' }, { id: 'gpt-image-2.5-flare' }])
  assert.deepEqual(synced.ids, ['gpt-6-luna'])
})

test('sync stores catalog metadata and replaces it on the next sync', (t) => {
  withDb(t)
  syncGptIdsIntoPolicy([
    {
      id: 'gpt-6-luna',
      display_name: 'GPT-6 Luna',
      catalog: { context_window: 272000, supported_reasoning_levels: ['low', 'high'] },
    },
  ])
  const first = getGptModelPolicy().models['gpt-6-luna'].catalog
  assert.equal(first.context_window, 272000)
  assert.deepEqual(first.supported_reasoning_levels, ['low', 'high'])
  assert.match(first.synced_at, /^\d{4}-\d{2}-\d{2}T/)
  syncGptIdsIntoPolicy([{ id: 'gpt-6-luna', catalog: { max_context_window: 1000000 } }])
  const second = getGptModelPolicy().models['gpt-6-luna'].catalog
  assert.equal(second.context_window, undefined)
  assert.equal(second.max_context_window, 1000000)
  assert.equal(listGptPolicyModels().find((m) => m.id === 'gpt-6-luna').catalog.max_context_window, 1000000)
})

test('Fast exposure defaults off, survives sync, and is persisted by panel save', (t) => {
  withDb(t)
  assert.equal(getGptModelPolicy().models['gpt-6-luna'].expose_fast, false)
  syncGptIdsIntoPolicy([
    {
      id: 'gpt-6-luna',
      catalog: { service_tiers: [{ id: 'priority', name: 'fast' }] },
    },
  ])
  saveGptModelPolicy({ models: { 'gpt-6-luna': { enabled: true, expose_fast: true } } })
  assert.equal(getGptModelPolicy().models['gpt-6-luna'].expose_fast, true)
  assert.equal(isGptFastAliasAvailable('gpt-6-luna-fast'), true)
  assert.equal(listGptFastAliases()[0].id, 'gpt-6-luna-fast')
  syncGptIdsIntoPolicy([{ id: 'gpt-6-luna', catalog: { service_tiers: [{ id: 'priority', name: 'Fast' }] } }])
  assert.equal(isGptFastAliasAvailable('gpt-6-luna-fast'), true)
  loadGptModelPolicy({ force: true })
  assert.equal(getGptModelPolicy().models['gpt-6-luna'].expose_fast, true)
  syncGptIdsIntoPolicy([{ id: 'gpt-6-luna', catalog: { service_tiers: [] } }])
  assert.equal(isGptFastAliasAvailable('gpt-6-luna-fast'), false)
  assert.equal(getGptModelPolicy().models['gpt-6-luna'].expose_fast, true)
  assert.deepEqual(listGptFastAliases(), [])
})

test('Fast aliases require priority and never replace actual or mapped ids', (t) => {
  withDb(t)
  syncGptIdsIntoPolicy([
    { id: 'gpt-6-luna', catalog: { service_tiers: [{ id: 'flex', name: 'flex' }] } },
    { id: 'gpt-6-luna-fast', catalog: { service_tiers: [{ id: 'priority', name: 'fast' }] } },
  ])
  saveGptModelPolicy({
    models: {
      'gpt-6-luna': { enabled: true, expose_fast: true },
      'gpt-6-luna-fast': { enabled: true },
    },
  })
  assert.equal(isGptFastAliasAvailable('gpt-6-luna-fast'), false)
  assert.deepEqual(listGptFastAliases(), [])

  resetGptModelPolicy()
  syncGptIdsIntoPolicy([{ id: 'gpt-6-luna', catalog: { service_tiers: [{ id: 'priority', name: 'fast' }] } }])
  saveGptModelPolicy({ models: { 'gpt-6-luna': { enabled: true, expose_fast: true } } })
  assert.deepEqual(listGptFastAliases({ mappingKeys: ['gpt-6-luna-fast'] }), [])
})

test('sync without metadata keeps the previous catalog', (t) => {
  withDb(t)
  syncGptIdsIntoPolicy([{ id: 'gpt-6-luna', catalog: { context_window: 272000 } }])
  syncGptIdsIntoPolicy(['gpt-6-luna'])
  assert.equal(getGptModelPolicy().models['gpt-6-luna'].catalog.context_window, 272000)
})

test('panel save keeps the synced catalog; only a sync writes it', (t) => {
  withDb(t)
  syncGptIdsIntoPolicy([{ id: 'gpt-6-luna', catalog: { context_window: 272000 } }])
  saveGptModelPolicy({
    models: { 'gpt-6-luna': { enabled: true, catalog: { context_window: 1, synced_at: 'stale' } } },
  })
  assert.equal(getGptModelPolicy().models['gpt-6-luna'].catalog.context_window, 272000)
  saveGptModelPolicy({ models: { 'gpt-7': { enabled: true, catalog: { context_window: 9 } } } })
  assert.equal(getGptModelPolicy().models['gpt-7'].catalog, undefined)
})

test('the static fallback catalog ships the 6.2 series enabled', (t) => {
  withDb(t)
  assert.equal(isGptModelEnabled('gpt-6.2-astra'), true)
  assert.equal(isGptModelEnabled('gpt-6.2-sol'), true)
  const ids = listGptPolicyModels().map((m) => m.id)
  assert.ok(ids.includes('gpt-6.2-astra'))
  assert.ok(ids.includes('gpt-6.2-sol'))
  // 6.2 sorts ahead of the 6.1 and 6 entries on the models page.
  assert.ok(ids.indexOf('gpt-6.2-astra') < ids.indexOf('gpt-6.1-sol'))
  assert.equal(getGptModelPolicy().seed_version, GPT_SEED_VERSION)
})

test('an id outside the fallback catalog still requires explicit enablement', (t) => {
  withDb(t)
  const id = 'gpt-6.2-not-in-account-catalog'
  syncGptIdsIntoPolicy([{ id, display_name: 'Account catalog model', catalog: {} }])
  assert.equal(isGptModelEnabled(id), false)
  assert.equal(getGptModelPolicy().models[id].capabilities.context_window, undefined)
  assert.equal(getGptModelPolicy().models[id].params.max_tokens_cap, undefined)
  saveGptModelPolicy({ models: { [id]: { enabled: true } } })
  loadGptModelPolicy({ force: true })
  syncGptIdsIntoPolicy([{ id, catalog: {} }])
  assert.equal(isGptModelEnabled(id), true)
  assert.equal(isGptModelEnabled('gpt-7-unknown-to-the-catalog'), false)
})

test('a sync that confirms the 6.2 series keeps it enabled and takes the upstream catalog', (t) => {
  withDb(t)
  syncGptIdsIntoPolicy([
    { id: 'gpt-6.2-astra', catalog: { context_window: 272000 } },
    { id: 'gpt-6.2-sol', catalog: {} },
  ])
  const models = getGptModelPolicy().models
  assert.equal(models['gpt-6.2-astra'].enabled, true)
  assert.equal(models['gpt-6.2-sol'].enabled, true)
  assert.equal(models['gpt-6.2-astra'].catalog.context_window, 272000)
  assert.ok(models['gpt-6.2-astra'].catalog.synced_at)
})

test('a synced policy backfills the seed generation without reviving dropped ids', (t) => {
  withDb(t)
  new SettingsRepo().set('gpt_model_policy', {
    version: 1,
    source: 'codex',
    models: { 'gpt-6-astra': { enabled: true } },
  })
  loadGptModelPolicy({ force: true })
  const pol = getGptModelPolicy()
  assert.equal(pol.models['gpt-6.2-astra'].enabled, true)
  assert.equal(pol.models['gpt-6.2-sol'].enabled, true)
  // 6.1 belongs to the previous seed generation; a sync dropped it on purpose.
  assert.equal(pol.models['gpt-6.1-sol'], undefined)
  assert.equal(pol.seed_version, GPT_SEED_VERSION)
  assert.equal(new SettingsRepo().get('gpt_model_policy', null).seed_version, GPT_SEED_VERSION)
})

test('the backfill corrects a 6.2 row the old sync default had disabled, keeping upstream facts', (t) => {
  withDb(t)
  new SettingsRepo().set('gpt_model_policy', {
    version: 1,
    source: 'codex',
    models: { 'gpt-6.2-astra': { enabled: false, catalog: { context_window: 9 } } },
  })
  loadGptModelPolicy({ force: true })
  const row = getGptModelPolicy().models['gpt-6.2-astra']
  assert.equal(row.enabled, true)
  assert.equal(row.catalog.context_window, 9)
})

test('the backfill runs once; a policy already on this generation is left alone', (t) => {
  withDb(t)
  new SettingsRepo().set('gpt_model_policy', {
    version: 1,
    seed_version: GPT_SEED_VERSION,
    source: 'codex',
    models: { 'gpt-6-astra': { enabled: true } },
  })
  loadGptModelPolicy({ force: true })
  const pol = getGptModelPolicy()
  assert.equal(pol.models['gpt-6.2-astra'], undefined)
  assert.equal(pol.models['gpt-6.2-sol'], undefined)
})
