import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_GEMINI_EFFORT,
  GEMINI_SEED_VERSION,
  getGeminiModelPolicy,
  getGeminiPolicyCatalogIds,
  isDefaultSupportedGeminiModel,
  isGeminiModelEnabled,
  isGeminiSeriesId,
  isSyncableGeminiCatalogId,
  listGeminiPolicyModels,
  loadGeminiModelPolicy,
  resetGeminiModelPolicy,
  resolveGeminiDefaultEffort,
  resolveGeminiPolicyEntry,
  saveGeminiModelPolicy,
  seedGeminiPolicy,
  setGeminiModelPolicyTestHooks,
  syncGeminiIdsIntoPolicy,
} from '../../src/lib/protocol/gemini-model-policy.mjs'
import { buildGeminiRequest, parseInboundToGemini } from '../../src/lib/protocol/gemini-convert.mjs'
import { resolveGeminiReasoningEffort } from '../../src/lib/protocol/log-fields.mjs'
import {
  isAntigravityRoutedModel,
  isBlockedUpstreamGeminiModel,
  resolveUpstreamModel,
} from '../../src/lib/gemini/model-catalog.mjs'
import { createGeminiScheduler } from '../../src/lib/gemini/scheduler.mjs'
import { createMockSchedulerRuntime } from '../helpers/mock-scheduler-runtime.mjs'
import { buildPricing } from '../../src/lib/admin/pricing-view.mjs'
import { setPriceCatalogTestHooks, setPriceOverride } from '../../src/lib/admin/price-catalog.mjs'
import { syncGeminiCatalog } from '../../src/lib/admin/catalog-monitor.mjs'

function makeMemorySettings(initial = {}) {
  const store = { ...initial }
  return {
    store,
    get(key, fallback = null) {
      return Object.hasOwn(store, key) ? store[key] : fallback
    },
    set(key, value) {
      store[key] = value
      return value
    },
  }
}

test('gemini-model-policy v2 seeds only default-supported Gemini 4, 3.8 Flash, and Nano Banana 2', () => {
  const settings = makeMemorySettings()
  setGeminiModelPolicyTestHooks({ settings })
  try {
    const seed = seedGeminiPolicy()
    assert.equal(seed.platform, 'google')
    assert.equal(seed.seed_version, GEMINI_SEED_VERSION)
    assert.equal(seed.seed_version, 2)
    assert.equal(seed.allow_third_party_models, false)

    const ids = Object.keys(seed.models).sort()
    assert.deepEqual(ids, [
      'gemini-3.1-flash-image',
      'gemini-3.8-flash',
      'gemini-4-argon',
      'gemini-4-carbon',
      'gemini-4-hydrogen',
      'gemini-4-neon',
    ])

    for (const [id, row] of Object.entries(seed.models)) {
      assert.equal(isGeminiSeriesId(id), true, `${id} should be a Gemini series id`)
      assert.equal(row.family, 'gemini')
      assert.equal(row.enabled, true)
      if (id === 'gemini-3.1-flash-image') {
        assert.equal(row.display_name, 'Nano Banana 2')
        assert.deepEqual(row.aliases, ['nano-banana-2'])
        assert.equal(row.params.default_effort, 'off')
        assert.equal(row.capabilities.supports_effort, false)
      } else {
        assert.equal(row.params.default_effort, DEFAULT_GEMINI_EFFORT)
        assert.equal(row.params.default_effort, 'medium')
      }
    }

    // isDefaultSupportedGeminiModel exact allow/deny matrix
    for (const okId of [
      'gemini-4-neon',
      'gemini-4-neon-low',
      'gemini-4-neon-medium',
      'gemini-4-neon-high',
      'gemini-4-neon-xhigh',
      'gemini-4-hydrogen-high',
      'gemini-4-hydrogen-xhigh',
      'gemini-4-argon-medium',
      'gemini-4-carbon-high',
      'gemini-3.8-flash',
      'gemini-3.8-flash-low',
      'gemini-3.8-flash-medium',
      'gemini-3.8-flash-high',
      'gemini-3.1-flash-image',
      'nano-banana-2',
      'models/nano-banana-2',
    ]) {
      assert.equal(isDefaultSupportedGeminiModel(okId), true, `${okId} must be default-supported`)
      assert.equal(isGeminiModelEnabled(seed, okId), true, `${okId} must be enabled by default policy`)
    }

    for (const badId of [
      'gemini-4-neon-disabled',
      'gemini-4-argon-disabled',
      'gemini-4-carbon-disabled',
      'gemini-4-hydrogen-sonar',
      'gemini-4-hydrogen-tiered-high',
      'gemini-4-hydrogen-tiered-xhigh',
      'gemini-3.8-flash-tiered',
      'gemini-3.8-flash-xhigh',
      'tab_flash_lite_preview',
      'tab_jump_flash_lite_preview',
      'gemini-2.0-flash',
      'gemini-2.5-flash',
      'gemini-2.5-flash-thinking',
      'gemini-2.5-pro',
      'gemini-2.5-flash-image',
      'gemini-3-flash',
      'gemini-3-pro',
      'gemini-3-pro-image',
      'gemini-3.1-pro',
      'gemini-3.1-flash-lite',
      'gemini-3.1-flash-lite-image',
      'gemini-3.5-flash-lite',
      'gemini-3.6-flash',
      'gemini-3.7-flash',
      'ag-claude-sonnet-4-6-high',
      'ag-gpt-oss-120b-medium',
      'claude-sonnet-5-5',
      'gpt-5.4',
    ]) {
      assert.equal(isDefaultSupportedGeminiModel(badId), false, `${badId} must NOT be default-supported`)
      if (badId !== 'gemini-3.8-flash-xhigh') {
        assert.equal(isGeminiModelEnabled(seed, badId), false, `${badId} must be disabled by default policy`)
      }
    }

    assert.equal(isGeminiSeriesId('claude-sonnet-5-5'), false)
    assert.equal(isGeminiSeriesId('gpt-5.4'), false)
    assert.equal(isSyncableGeminiCatalogId('gemini-embedding-001'), false)
    assert.equal(isSyncableGeminiCatalogId('gemini-4-neon-disabled'), false)
    assert.equal(isSyncableGeminiCatalogId('tab_flash_lite_preview'), false)
    assert.equal(isSyncableGeminiCatalogId('gemini-4-neon'), true)
    assert.equal(isSyncableGeminiCatalogId('gemini-3.1-flash-image'), true)
    assert.equal(resolveGeminiPolicyEntry('nano-banana-2')?.id, 'gemini-3.1-flash-image')
    assert.equal(resolveGeminiDefaultEffort('gemini-3.1-flash-image'), 'off')
    assert.equal(resolveGeminiDefaultEffort('nano-banana-2'), 'off')
    assert.equal(resolveGeminiDefaultEffort('gemini-4-neon'), 'medium')
    assert.equal(resolveGeminiDefaultEffort('claude-sonnet-5-5'), null)
  } finally {
    setGeminiModelPolicyTestHooks(null)
  }
})

test('loadGeminiModelPolicy migrates seed_version < 2 auto-synced DB while preserving panel edits', () => {
  const settings = makeMemorySettings({
    gemini_model_policy: {
      version: 1,
      seed_version: 1,
      source: 'google',
      platform: 'google',
      models: {
        'gemini-4-neon': { id: 'gemini-4-neon', display_name: 'Gemini 4 Neon', enabled: true },
        'gemini-4-neon-high': { id: 'gemini-4-neon-high', display_name: 'gemini-4-neon-high', enabled: true },
        'gemini-4-neon-disabled': { id: 'gemini-4-neon-disabled', enabled: true },
        'gemini-4-hydrogen-sonar': { id: 'gemini-4-hydrogen-sonar', enabled: true },
        'gemini-4-hydrogen-tiered-high': { id: 'gemini-4-hydrogen-tiered-high', enabled: true },
        'gemini-3.8-flash-medium': { id: 'gemini-3.8-flash-medium', enabled: true },
        'gemini-3.8-flash-tiered': { id: 'gemini-3.8-flash-tiered', enabled: true },
        'gemini-3.1-flash-image': {
          id: 'gemini-3.1-flash-image',
          display_name: 'Nano Banana 2',
          enabled: true,
          params: { default_effort: 'medium' },
        },
        'gemini-3-flash': { id: 'gemini-3-flash', enabled: true },
        'gemini-2.5-flash': { id: 'gemini-2.5-flash', enabled: true },
        'gemini-3-pro-image': { id: 'gemini-3-pro-image', display_name: 'Nano Banana Pro', enabled: true },
      },
    },
  })
  setGeminiModelPolicyTestHooks({ settings })
  try {
    const migrated = loadGeminiModelPolicy({ force: true })
    assert.equal(migrated.seed_version, 2)
    assert.equal(migrated.allow_third_party_models, false)
    assert.equal(migrated.models['gemini-4-neon-disabled'], undefined)
    assert.equal(migrated.models['gemini-4-neon'].enabled, true)
    assert.equal(migrated.models['gemini-4-neon-high'].enabled, true)
    assert.equal(migrated.models['gemini-4-carbon'].enabled, true)
    assert.equal(migrated.models['gemini-3.8-flash'].enabled, true)
    assert.equal(migrated.models['gemini-3.8-flash-medium'].enabled, true)
    assert.equal(migrated.models['gemini-3.1-flash-image'].enabled, true)
    assert.equal(migrated.models['gemini-3.1-flash-image'].params.default_effort, 'off')
    assert.deepEqual(migrated.models['gemini-3.1-flash-image'].aliases, ['nano-banana-2'])
    assert.equal(migrated.models['gemini-4-hydrogen-sonar'].enabled, false)
    assert.equal(migrated.models['gemini-4-hydrogen-tiered-high'].enabled, false)
    assert.equal(migrated.models['gemini-3.8-flash-tiered'].enabled, false)
    assert.equal(migrated.models['gemini-3-flash'].enabled, false)
    assert.equal(migrated.models['gemini-2.5-flash'].enabled, false)
    assert.equal(migrated.models['gemini-3-pro-image'].enabled, false)
    assert.equal(settings.store.gemini_model_policy.seed_version, 2)

    // Manual panel policy (`source: 'panel'`) is NOT overwritten by v2 migration
    const panelSettings = makeMemorySettings({
      gemini_model_policy: {
        version: 1,
        seed_version: 1,
        source: 'panel',
        platform: 'google',
        models: {
          'gemini-3-flash': { id: 'gemini-3-flash', enabled: true },
          'gemini-4-neon': { id: 'gemini-4-neon', enabled: false },
          'gemini-4-neon-disabled': { id: 'gemini-4-neon-disabled', enabled: true },
        },
      },
    })
    setGeminiModelPolicyTestHooks({ settings: panelSettings })
    const kept = loadGeminiModelPolicy({ force: true })
    assert.equal(kept.models['gemini-3-flash'].enabled, true)
    assert.equal(kept.models['gemini-4-neon'].enabled, false)
    assert.equal(kept.models['gemini-4-neon-disabled'], undefined)
    assert.equal(isGeminiModelEnabled(kept, 'gemini-3-flash'), true)
    assert.equal(isGeminiModelEnabled(kept, 'gemini-4-neon'), false)
  } finally {
    setGeminiModelPolicyTestHooks(null)
  }
})

test('syncGeminiIdsIntoPolicy adds non-default models disabled, filters blocked IDs, and preserves operator overrides', () => {
  const settings = makeMemorySettings()
  setGeminiModelPolicyTestHooks({ settings })
  try {
    const pol = getGeminiModelPolicy()
    pol.models['gemini-4-neon'].params.default_effort = 'high'
    pol.models['gemini-4-argon'].enabled = false
    saveGeminiModelPolicy(pol)

    const result = syncGeminiIdsIntoPolicy([
      { id: 'gemini-4.5-pro', display_name: 'Gemini 4.5 Pro', context: 2_000_000 },
      { id: 'gemini-4-neon', display_name: 'Gemini 4 Neon' },
      { id: 'gemini-4-neon-high', display_name: 'Gemini 4 Neon High' },
      { id: 'gemini-4-neon-disabled', display_name: 'Disabled' },
      { id: 'gemini-3-flash', display_name: 'Gemini 3 Flash' },
      { id: 'tab_flash_lite_preview', display_name: 'Tab' },
      { id: 'claude-sonnet-4-6-high', display_name: 'Claude' },
      { id: 'gpt-oss-120b-medium', display_name: 'GPT OSS' },
      { id: 'gemini-embedding-001', display_name: 'Embedding' },
    ])

    assert.equal(result.ok, true)
    assert.equal(result.synced, 4)
    assert.deepEqual(result.added, ['gemini-4.5-pro', 'gemini-4-neon-high', 'gemini-3-flash'])
    const updated = getGeminiModelPolicy()
    assert.ok(updated.models['gemini-4.5-pro'])
    assert.equal(updated.models['gemini-4.5-pro'].enabled, false)
    assert.equal(updated.models['gemini-4.5-pro'].params.default_effort, 'medium')
    assert.equal(updated.models['gemini-4.5-pro'].capabilities.context_window, 2_000_000)
    assert.equal(updated.models['gemini-3-flash'].enabled, false)
    assert.equal(updated.models['gemini-4-neon-high'].enabled, true)
    assert.equal(updated.models['gemini-4-neon'].params.default_effort, 'high')
    assert.equal(updated.models['gemini-4-argon'].enabled, false)
    assert.equal(updated.models['gemini-4-neon-disabled'], undefined)
    assert.equal(updated.models['tab_flash_lite_preview'], undefined)
    assert.equal(updated.models['claude-sonnet-4-6-high'], undefined)
    assert.equal(updated.models['gpt-oss-120b-medium'], undefined)
    assert.equal(updated.models['gemini-embedding-001'], undefined)
    assert.ok(getGeminiPolicyCatalogIds().includes('gemini-4.5-pro'))
    assert.equal(
      listGeminiPolicyModels().some((m) => m.id === 'gemini-4-argon'),
      false,
    )
    assert.equal(
      listGeminiPolicyModels().some((m) => m.id === 'gemini-4.5-pro'),
      false,
    )
    assert.equal(isGeminiModelEnabled('gemini-4-argon'), false)
    assert.equal(isGeminiModelEnabled('gemini-4.5-pro'), false)
    assert.equal(isGeminiModelEnabled('gemini-3-flash'), false)
    assert.equal(isGeminiModelEnabled('ag-claude-sonnet-4-6-high'), false)

    // Operator can explicitly enable a synced model or third-party Antigravity models
    updated.models['gemini-4.5-pro'].enabled = true
    updated.allow_third_party_models = true
    saveGeminiModelPolicy(updated)
    assert.equal(isGeminiModelEnabled('gemini-4.5-pro'), true)
    assert.equal(isGeminiModelEnabled('ag-claude-sonnet-4-6-high'), true)
    assert.equal(isGeminiModelEnabled('ag-tab_flash_lite_preview'), false)

    resetGeminiModelPolicy()
    assert.equal(resolveGeminiDefaultEffort('gemini-4-neon'), 'medium')
    assert.equal(isGeminiModelEnabled('gemini-4-argon'), true)
    assert.equal(isGeminiModelEnabled('ag-claude-sonnet-4-6-high'), false)
  } finally {
    setGeminiModelPolicyTestHooks(null)
  }
})

test('Gemini requests without thinking level inject default medium across all 4 inbound protocols', () => {
  const settings = makeMemorySettings()
  setGeminiModelPolicyTestHooks({ settings })
  try {
    const cases = [
      [
        'gemini',
        { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
        { routeModel: 'gemini-3.1-pro', routeStream: false },
      ],
      ['openai-chat', { model: 'gemini-4-neon', messages: [{ role: 'user', content: 'hello' }] }, {}],
      ['openai-responses', { model: 'gemini-3-pro', input: 'hello' }, {}],
      ['anthropic', { model: 'gemini-3.8-flash', max_tokens: 128, messages: [{ role: 'user', content: 'hello' }] }, {}],
    ]
    for (const [proto, body, opts] of cases) {
      const ir = parseInboundToGemini(proto, body, opts)
      const out = buildGeminiRequest(ir, { target: 'gemini' })
      assert.deepEqual(
        out.generationConfig?.thinkingConfig,
        { thinkingLevel: 'medium', includeThoughts: true },
        `[${proto}] should inject medium thinkingLevel when omitted`,
      )
      // Antigravity SHM keeps minimal generationConfig contract
      const agOut = buildGeminiRequest(ir, { target: 'antigravity' })
      assert.equal('generationConfig' in agOut, false, `[${proto}] antigravity must keep minimal generationConfig`)
    }

    // Gemini 2.5 uses thinkingBudget (medium = 8192)
    const ir25 = parseInboundToGemini('openai-chat', {
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'hello' }],
    })
    assert.deepEqual(buildGeminiRequest(ir25, { target: 'gemini' }).generationConfig?.thinkingConfig, {
      thinkingBudget: 8192,
      includeThoughts: true,
    })

    // Non-thinking Gemini 2.0 flash does not get thinkingConfig injected
    const ir20 = parseInboundToGemini('openai-chat', {
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'hello' }],
    })
    assert.equal(buildGeminiRequest(ir20, { target: 'gemini' }).generationConfig?.thinkingConfig, undefined)

    // Explicit caller thinking level or disabled thinking must never be overwritten
    const explicitHigh = parseInboundToGemini('openai-chat', {
      model: 'gemini-3.1-pro',
      reasoning_effort: 'high',
      messages: [{ role: 'user', content: 'hello' }],
    })
    assert.equal(
      buildGeminiRequest(explicitHigh, { target: 'gemini' }).generationConfig?.thinkingConfig?.thinkingLevel,
      'high',
    )

    const explicitDisabled = parseInboundToGemini('anthropic', {
      model: 'gemini-3.1-pro',
      max_tokens: 64,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: 'hello' }],
    })
    assert.deepEqual(buildGeminiRequest(explicitDisabled, { target: 'gemini' }).generationConfig?.thinkingConfig, {
      thinkingLevel: 'low',
      includeThoughts: false,
    })

    // Operator panel override to off disables default injection
    const pol = getGeminiModelPolicy()
    pol.models['gemini-4-neon'].params.default_effort = 'off'
    saveGeminiModelPolicy(pol)
    const irOff = parseInboundToGemini('openai-chat', {
      model: 'gemini-4-neon',
      messages: [{ role: 'user', content: 'hello' }],
    })
    assert.equal(buildGeminiRequest(irOff, { target: 'gemini' }).generationConfig?.thinkingConfig, undefined)
  } finally {
    setGeminiModelPolicyTestHooks(null)
  }
})

test('resolveUpstreamModel and Gemini scheduler respect default_effort, aliases, blocked IDs, and policy switch', async () => {
  const settings = makeMemorySettings()
  setGeminiModelPolicyTestHooks({ settings })
  try {
    // Tiered Antigravity slot without bare model resolves unsuffixed request to `-medium` by default
    const tiered = ['gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high']
    const defaultHit = resolveUpstreamModel('gemini-3.8-flash', tiered, { defaultEffort: 'medium' })
    assert.equal(defaultHit?.upstreamModel, 'gemini-3.8-flash-medium')

    // Explicit requestedEffort takes precedence over default
    const explicitHit = resolveUpstreamModel('gemini-3.8-flash', tiered, {
      requestedEffort: 'high',
      defaultEffort: 'medium',
    })
    assert.equal(explicitHit?.upstreamModel, 'gemini-3.8-flash-high')

    // Exact bare match still wins when no explicit effort override is given
    const bareAndTiered = ['gemini-4-neon', 'gemini-4-neon-medium']
    const bareHit = resolveUpstreamModel('gemini-4-neon', bareAndTiered, { defaultEffort: 'medium' })
    assert.equal(bareHit?.upstreamModel, 'gemini-4-neon')

    // Nano Banana 2 alias maps to gemini-3.1-flash-image and routes to Antigravity
    assert.equal(isAntigravityRoutedModel('nano-banana-2'), true)
    assert.equal(isAntigravityRoutedModel('models/nano-banana-2'), true)
    const nb2 = resolveUpstreamModel('nano-banana-2', ['gemini-3.1-flash-image', 'gemini-4-neon-disabled'])
    assert.equal(nb2?.upstreamModel, 'gemini-3.1-flash-image')
    assert.equal(nb2?.publicId, 'gemini-3.1-flash-image')

    // Blocked upstream slugs (*-disabled / tab_*) are never resolved
    assert.equal(isBlockedUpstreamGeminiModel('gemini-4-neon-disabled'), true)
    assert.equal(isBlockedUpstreamGeminiModel('tab_flash_lite_preview'), true)
    assert.equal(isBlockedUpstreamGeminiModel('ag-tab_jump_flash_lite_preview'), true)
    assert.equal(
      resolveUpstreamModel('gemini-4-neon-disabled', ['gemini-4-neon-disabled', 'tab_flash_lite_preview']),
      null,
    )
    assert.equal(
      resolveUpstreamModel('tab_flash_lite_preview', ['gemini-4-neon-disabled', 'tab_flash_lite_preview']),
      null,
    )

    // Disabling a Gemini model in policy hides it from scheduler.catalog() and blocks scheduling
    const pol = getGeminiModelPolicy()
    pol.models['gemini-4-carbon'].enabled = false
    saveGeminiModelPolicy(pol)

    const scheduler = createGeminiScheduler({
      schedulerRuntime: createMockSchedulerRuntime(),
      callHost: async (op) => {
        if (op === 'list') {
          return {
            payload_state: 'installed',
            environments: [
              {
                id: 'env-1',
                proxy_id: 'px-1',
                auth_state: 'authorized',
                auth_method: 'oauth',
                models_discovered: true,
                models: [
                  'gemini-3.1-pro-medium',
                  'gemini-4-carbon-medium',
                  'gemini-4-neon',
                  'gemini-3.1-flash-image',
                  'gemini-4-neon-disabled',
                  'tab_flash_lite_preview',
                ],
                account: {
                  state: 'ok',
                  model_catalog: [
                    { id: 'gemini-3.1-pro-medium', provider: 'google', quota_group: 'gemini' },
                    { id: 'gemini-4-carbon-medium', provider: 'google', quota_group: 'gemini' },
                    { id: 'gemini-4-neon', provider: 'google', quota_group: 'gemini' },
                    { id: 'gemini-3.1-flash-image', provider: 'google', quota_group: 'gemini' },
                    { id: 'gemini-4-neon-disabled', provider: 'google', quota_group: 'gemini' },
                    { id: 'tab_flash_lite_preview', provider: 'google', quota_group: 'gemini' },
                  ],
                },
              },
            ],
          }
        }
        throw new Error(`unexpected op: ${op}`)
      },
    })

    const cat = await scheduler.catalog()
    const ids = cat.models.map((m) => m.id)
    assert.equal(ids.includes('gemini-3.1-pro-medium'), false)
    assert.equal(ids.includes('gemini-4-carbon-medium'), false)
    assert.equal(ids.includes('gemini-4-neon-disabled'), false)
    assert.equal(ids.includes('tab_flash_lite_preview'), false)
    assert.equal(ids.includes('gemini-4-neon'), true)
    assert.equal(ids.includes('gemini-3.1-flash-image'), true)

    await assert.rejects(
      () =>
        scheduler.stream({
          model: 'gemini-4-carbon',
          geminiBody: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
        }),
      (err) => err?.code === 'gemini_model_unavailable' && err?.status === 404,
    )
    await assert.rejects(
      () =>
        scheduler.stream({
          model: 'gemini-3.1-pro',
          geminiBody: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
        }),
      (err) => err?.code === 'gemini_model_unavailable' && err?.status === 404,
    )
  } finally {
    setGeminiModelPolicyTestHooks(null)
  }
})

test('resolveGeminiReasoningEffort falls back to defaultEffort=medium only when omitted and not disabled', () => {
  assert.equal(
    resolveGeminiReasoningEffort({
      inbound: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      model: 'gemini-4-neon',
      defaultEffort: 'medium',
    }),
    'medium',
  )
  assert.equal(
    resolveGeminiReasoningEffort({
      inbound: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      model: 'gemini-4-neon',
      defaultEffort: 'off',
    }),
    null,
  )
  assert.equal(
    resolveGeminiReasoningEffort({
      inbound: { thinking: { type: 'disabled' } },
      parsed: { thinking: { disabled: true } },
      model: 'gemini-4-neon',
      defaultEffort: 'medium',
    }),
    'none',
  )
})

test('buildPricing includes Google Gemini policy models and supports google/* price overrides', () => {
  const settings = makeMemorySettings()
  setGeminiModelPolicyTestHooks({ settings })
  setPriceCatalogTestHooks({ settings, backgroundRefresh: false })
  try {
    const view = buildPricing()
    assert.ok(view.policy['gemini-4-neon']?.effective)
    assert.equal(Object.hasOwn(view.policy, 'gemini-3.1-flash-image'), true)
    assert.equal(view.models.find((m) => m.platform === 'google' && m.id === 'gemini-4-neon')?.in_policy, true)
    assert.equal(view.models.find((m) => m.platform === 'google' && m.id === 'gemini-3.8-flash')?.in_policy, true)

    const ov = setPriceOverride('google/gemini-4-neon', { input: 3, output: 15, cache_read: 0.3 })
    assert.equal(ov.ok, true)
    const after = buildPricing()
    assert.equal(after.policy['gemini-4-neon']?.source, 'override')
    assert.equal(after.policy['gemini-4-neon']?.effective?.input, 3)
  } finally {
    setPriceCatalogTestHooks(null)
    setGeminiModelPolicyTestHooks(null)
  }
})

test('syncGeminiCatalog filters blocked IDs and adds non-default discovered models disabled by default', async () => {
  const settings = makeMemorySettings({
    price_catalog_modelsdev: {
      fetched_at: '2026-11-25T00:00:00.000Z',
      status: 'ok',
      error: null,
      anthropic: {},
      openai: {},
      google: {
        'gemini-4.2-pro': { name: 'Gemini 4.2 Pro', context: 2_000_000, price: null },
        'gemini-3.1-flash-image': { name: 'Nano Banana 2', context: 1_048_576, price: null },
        'gemini-embedding-001': { name: 'Embedding', context: 2048, price: null },
      },
    },
  })
  setGeminiModelPolicyTestHooks({ settings })
  setPriceCatalogTestHooks({ settings, backgroundRefresh: false })
  try {
    const res = await syncGeminiCatalog({
      callGeminiHost: async (op) => {
        if (op === 'list') {
          return {
            environments: [
              {
                id: 'env-g1',
                proxy_id: 'px-1',
                auth_state: 'authorized',
                models_discovered: true,
                models: ['gemini-4-neon', 'gemini-4-neon-disabled', 'tab_flash_lite_preview', 'claude-sonnet-4-6-high'],
                account: {
                  model_catalog: [
                    { id: 'gemini-4-neon', provider: 'google', quota_group: 'gemini' },
                    { id: 'gemini-4-neon-disabled', provider: 'google', quota_group: 'gemini' },
                    { id: 'tab_flash_lite_preview', provider: 'google', quota_group: 'gemini' },
                    { id: 'claude-sonnet-4-6-high', provider: 'anthropic', quota_group: '3p' },
                  ],
                },
              },
            ],
          }
        }
        return {}
      },
      refreshModelsDev: false,
      settingsRepo: settings,
    })
    assert.equal(res.ok, true)
    assert.ok(res.ids.includes('gemini-4-neon'))
    assert.ok(res.ids.includes('gemini-3.1-flash-image'))
    assert.equal(res.ids.includes('gemini-4.2-pro'), false)
    assert.equal(getGeminiModelPolicy().models['gemini-4.2-pro']?.enabled, false)
    assert.equal(getGeminiModelPolicy().models['gemini-4-neon-disabled'], undefined)
    assert.equal(getGeminiModelPolicy().models['tab_flash_lite_preview'], undefined)
    assert.equal(res.ids.includes('claude-sonnet-4-6-high'), false)
    assert.equal(res.ids.includes('gemini-embedding-001'), false)
    assert.equal(resolveGeminiDefaultEffort('gemini-4.2-pro'), 'medium')
    assert.equal(resolveGeminiDefaultEffort('gemini-3.1-flash-image'), 'off')
    assert.equal(settings.store.model_catalog_sync?.gemini?.status, 'ok')
  } finally {
    setPriceCatalogTestHooks(null)
    setGeminiModelPolicyTestHooks(null)
  }
})

test('gemini-4-carbon-high and parenthesized effort resolve cleanly across tiered and untiered catalogs', () => {
  const settings = makeMemorySettings()
  setGeminiModelPolicyTestHooks({ settings })
  try {
    const seeded = seedGeminiPolicy()
    assert.ok(seeded.models['gemini-4-carbon'], 'gemini-4-carbon must exist in seedGeminiPolicy')
    assert.equal(seeded.models['gemini-4-carbon'].params.default_effort, 'medium')
    assert.equal(resolveGeminiDefaultEffort('gemini-4-carbon-high'), 'medium')

    // 1. Account exposes tiered carbon slugs
    const tieredCarbon = ['gemini-4-carbon-low', 'gemini-4-carbon-medium', 'gemini-4-carbon-high']
    const exactHigh = resolveUpstreamModel('gemini-4-carbon-high', tieredCarbon)
    assert.equal(exactHigh?.upstreamModel, 'gemini-4-carbon-high')
    assert.equal(exactHigh?.publicId, 'gemini-4-carbon-high')

    const parenHigh = resolveUpstreamModel('gemini-4-carbon(high)', tieredCarbon)
    assert.equal(parenHigh?.upstreamModel, 'gemini-4-carbon-high')

    // xhigh/max clamps to high when carbon only exposes low/medium/high
    const clampedHigh = resolveUpstreamModel('gemini-4-carbon-xhigh', tieredCarbon)
    assert.equal(clampedHigh?.upstreamModel, 'gemini-4-carbon-high')

    // 2. Account only exposes untiered base `gemini-4-carbon` -> `gemini-4-carbon-high` still resolves!
    const untieredCarbon = ['gemini-4-carbon']
    const fallbackBase = resolveUpstreamModel('gemini-4-carbon-high', untieredCarbon)
    assert.equal(fallbackBase?.upstreamModel, 'gemini-4-carbon')
    assert.equal(fallbackBase?.publicId, 'gemini-4-carbon-high')
  } finally {
    setGeminiModelPolicyTestHooks(null)
  }
})
