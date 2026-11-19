import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePlatformId, platformDescriptor } from '../../src/lib/platforms/registry.mjs'
import { normalizeVmKind, isClaudeVm, isCodexVm, isAntigravityVm, stampVmKind } from '../../src/lib/vm/vm-kind.mjs'
import { detectInboundPlatform } from '../../src/lib/protocol/platform-detect.mjs'
import { evaluateSlotGate } from '../../src/lib/pool/schedule-eligibility.mjs'
import { normalizeKeyScope, keyAllowsVm, keyScopeFromRecord, applyVmPool } from '../../src/lib/admin/key-scope.mjs'
import { scopeStickyKey } from '../../src/lib/pool/sticky-router.mjs'
import { gatewayModelCatalog, validateOfficialModel, resolveCatalogModel } from '../../src/lib/protocol/models.mjs'
import {
  ANTIGRAVITY_CAPABILITIES,
  antigravityModelId,
  normalizeAntigravityRouting,
  normalizeAntigravityModels,
  resolveAntigravityVariant,
  listAntigravityPublicModels,
  validateAntigravityRoutingPatch,
} from '../../src/lib/protocol/antigravity-route.mjs'

const ag = { id: 'vm-ag-01', platform: 'antigravity', family: 'antigravity' }

test('explicit account platform owns credentials even with leftover provider fields', () => {
  const mixed = { ...ag, family: 'codex', codex_kernel: true, claude: { has_access: true } }
  assert.deepEqual(normalizeVmKind(mixed), { platform: 'antigravity', family: 'antigravity', kind: 'antigravity' })
  assert.equal(isAntigravityVm(mixed), true)
  assert.equal(isClaudeVm(mixed), false)
  assert.equal(isCodexVm(mixed), false)
  assert.equal(evaluateSlotGate(mixed).reason, 'antigravity_vm')
  assert.equal(normalizeVmKind({ platform: 'anthropic', family: 'antigravity' }).kind, 'claude')
  stampVmKind(mixed)
  assert.equal(mixed.claude, undefined)
  assert.equal(mixed.codex_kernel, undefined)
  assert.deepEqual(mixed.antigravity, {})
  assert.equal(normalizePlatformId('GPT'), 'openai')
  assert.equal(platformDescriptor('antigravity').label, 'Antigravity')
})

test('unknown explicit platform never falls through to Claude or legacy Codex', () => {
  const unknown = { platform: 'unsupported', family: 'claude', codex_kernel: true }
  assert.equal(normalizeVmKind(unknown).kind, 'unknown')
  assert.equal(isClaudeVm(unknown), false)
  assert.equal(isCodexVm(unknown), false)
  assert.equal(evaluateSlotGate(unknown).ok, false)
  assert.throws(() => stampVmKind(unknown), { code: 'platform_not_supported' })
  assert.equal(normalizeVmKind({}).kind, 'claude')
  assert.equal(normalizeVmKind({ codex_kernel: true }).kind, 'codex')
})

test('bare official IDs pick the platform; an Antigravity key group claims same-name Claude/GPT models', () => {
  assert.deepEqual(detectInboundPlatform('gemini-4-argon'), {
    ok: true,
    platform: 'antigravity',
    model: 'gemini-4-argon',
  })
  for (const groupType of [undefined, 'all', 'anthropic']) {
    assert.equal(detectInboundPlatform('claude-sonnet-5-5', { groupType }).platform, 'anthropic', groupType)
    assert.equal(detectInboundPlatform('gemini-4-argon', { groupType }).platform, 'antigravity', groupType)
  }
  assert.equal(detectInboundPlatform('gpt-oss-120b', { groupType: 'all' }).platform, 'openai')
  for (const id of ['claude-sonnet-5-5', 'gpt-oss-120b', 'gemini-4-argon']) {
    assert.deepEqual(detectInboundPlatform(id, { groupType: 'antigravity' }), {
      ok: true,
      platform: 'antigravity',
      model: id,
    })
  }
  for (const id of [
    'antigravity/gemini-4-argon',
    'antigravity/claude-sonnet-5-5',
    'Antigravity/claude-test',
    'prefix/antigravity/claude-test',
    'gemini test',
  ]) {
    assert.equal(detectInboundPlatform(id).ok, false, id)
    assert.equal(detectInboundPlatform(id, { groupType: 'antigravity' }).ok, false, id)
  }
  assert.equal(antigravityModelId('--model'), null)
  assert.equal(validateOfficialModel('antigravity/claude-sonnet-5').ok, false)
  assert.equal(resolveCatalogModel('antigravity/claude-sonnet-5', ['claude-sonnet-5']).ok, false)
})

test('upstream variants fold into base models; admin-disabled variants drop out of the level list', () => {
  const models = normalizeAntigravityModels([
    { id: 'gemini-4-argon-low', display_name: 'Gemini 4 Argon (Low)', vendor: 'google' },
    { id: 'gemini-4-argon-high', display_name: 'Gemini 4 Argon (High)' },
    { id: 'gemini-4-argon-medium', enabled: false },
    { id: 'gpt-oss-120b-medium', enabled: false },
    { id: 'claude-sonnet-5-5', levels: ['high', 'low', 'bogus'] },
    'plain-model',
  ])
  assert.deepEqual(models, [
    { id: 'gemini-4-argon', display_name: 'Gemini 4 Argon', vendor: 'google', enabled: true, levels: ['low', 'high'] },
    { id: 'gpt-oss-120b', display_name: 'gpt-oss-120b', vendor: null, enabled: false, levels: ['medium'] },
    {
      id: 'claude-sonnet-5-5',
      display_name: 'claude-sonnet-5-5',
      vendor: null,
      enabled: true,
      levels: ['low', 'high'],
    },
    { id: 'plain-model', display_name: 'plain-model', vendor: null, enabled: true, levels: [] },
  ])
  assert.deepEqual(normalizeAntigravityModels(models), models)
})

test('level resolution defaults to medium or the nearest level and rejects levels the model lacks', () => {
  const argon = { id: 'gemini-4-argon', levels: ['low', 'medium', 'high'] }
  assert.deepEqual(resolveAntigravityVariant(argon, null), {
    ok: true,
    level: 'medium',
    upstream: 'gemini-4-argon-medium',
  })
  assert.deepEqual(resolveAntigravityVariant(argon, 'HIGH'), {
    ok: true,
    level: 'high',
    upstream: 'gemini-4-argon-high',
  })
  assert.equal(resolveAntigravityVariant({ id: 'm', levels: ['low', 'high'] }, null).level, 'low')
  assert.equal(resolveAntigravityVariant({ id: 'm', levels: ['high'] }, null).upstream, 'm-high')
  for (const effort of ['minimal', 'xhigh', 'max', 'none'])
    assert.equal(resolveAntigravityVariant(argon, effort).ok, false)
  assert.deepEqual(resolveAntigravityVariant({ id: 'plain', levels: [] }, null), {
    ok: true,
    level: null,
    upstream: 'plain',
  })
  assert.equal(resolveAntigravityVariant({ id: 'plain', levels: [] }, 'low').ok, false)
})

test('Antigravity key scope intersects platform, live pool and VM list', () => {
  const scope = normalizeKeyScope({ group_type: 'antigravity', allowed_vms: [ag.id] })
  assert.equal(keyAllowsVm(scope, ag), true)
  assert.equal(keyAllowsVm(scope, { id: ag.id, platform: 'anthropic' }), false)
  assert.equal(keyAllowsVm(scope, { ...ag, id: 'vm-other' }), false)
  const claude = normalizeKeyScope({ group_type: 'anthropic', allowed_vms: [ag.id] })
  assert.equal(keyAllowsVm(claude, ag), false)
  const pool = applyVmPool({ ...scope, vm_pool_id: 'pool_abcdef01' }, () => ({ enabled: true, vm_ids: ['vm-other'] }))
  assert.equal(keyAllowsVm(pool, ag), false)
  assert.equal(keyAllowsVm(pool, { id: 'vm-other', platform: 'anthropic' }), false)
  assert.equal(keyAllowsVm(keyScopeFromRecord({ group_type: 'unsupported' }), ag), false)
})

test('platform sticky namespaces never reuse another platform conversation', () => {
  const keys = ['anthropic', 'openai', 'antigravity'].map((platform) => scopeStickyKey('key:session', platform))
  assert.equal(new Set(keys).size, 3)
  assert.equal(keys[2], 'p:antigravity:key:session')
  assert.equal(scopeStickyKey(keys[2], 'antigravity'), keys[2])
})

test('routing remains opt-in and advertises its independent API capabilities', () => {
  const defaults = normalizeAntigravityRouting()
  assert.deepEqual(defaults, {
    enabled: false,
    cli_bin: 'agy',
    models: [],
    max_sessions: 1,
    idle_ttl_seconds: 600,
    timeout_ms: 180000,
    queue_timeout_ms: 120000,
    affinity_wait_ms: 15000,
  })
  assert.deepEqual(listAntigravityPublicModels({ models: ['gemini-test-low'] }), [])
  assert.equal(ANTIGRAVITY_CAPABILITIES.client_tools, true)
  assert.equal(ANTIGRAVITY_CAPABILITIES.history_import, true)
  assert.deepEqual(ANTIGRAVITY_CAPABILITIES.protocols, [
    'anthropic.messages',
    'openai.chat',
    'openai.responses',
    'openai.completions',
  ])
  for (const config of [
    null,
    [],
    { enabled: 'true' },
    { max_sessions: 0 },
    { timeout_ms: 999 },
    { queue_timeout_ms: 300001 },
    { affinity_wait_ms: -1 },
    { affinity_wait_ms: 120001 },
    { models: ['--bad'] },
    { cli_bin: 'agy\nother' },
  ]) {
    assert.throws(() => validateAntigravityRoutingPatch({ antigravity: config }), { code: 'invalid_antigravity' })
  }
  assert.doesNotThrow(() => validateAntigravityRoutingPatch({ unrelated_setting: true }))
})

test('local catalog lists base IDs with levels, once, under the platform the key reaches', () => {
  const antigravityRouting = {
    enabled: true,
    models: [
      { id: 'claude-test-low', vendor: 'anthropic', display_name: 'AG Claude (Low)' },
      'gemini-test-low',
      'gemini-test-high',
      { id: 'disabled-test', enabled: false },
    ],
  }
  const agCatalog = gatewayModelCatalog({ groupType: 'antigravity', antigravityRouting })
  assert.deepEqual(
    agCatalog.data.map((row) => [row.id, row.reasoning_levels, row.default_reasoning_level]),
    [
      ['claude-test', ['low'], 'low'],
      ['gemini-test', ['low', 'high'], 'low'],
    ],
  )
  const model = agCatalog.data[0]
  assert.equal(model.platform, 'antigravity')
  assert.equal(model.vendor, 'anthropic')
  assert.equal(model.display_name, 'AG Claude')
  assert.equal(model.owned_by, 'anthropic')
  const all = gatewayModelCatalog({ groupType: 'all', antigravityRouting }).data
  assert.deepEqual(
    all.filter((row) => row.platform === 'antigravity').map((row) => row.id),
    ['gemini-test'],
  )
  for (const groupType of ['anthropic', 'openai', 'unknown']) {
    assert.equal(
      gatewayModelCatalog({ groupType, antigravityRouting }).data.some((row) => row.platform === 'antigravity'),
      false,
    )
  }
  assert.equal(gatewayModelCatalog({ groupType: 'antigravity' }).data.length, 0)
})
