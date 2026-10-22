import test from 'node:test'
import assert from 'node:assert/strict'
import { detectInboundPlatform } from '../../src/lib/protocol/platform-detect.mjs'
import {
  applyCodexInboundModelRewrite,
  DEFAULT_CODEX_MODEL_MAPPING_FALLBACK,
  DEFAULT_CODEX_MODEL_MAPPINGS,
  normalizeCodexModelMappings,
  validateCodexModelMappingTarget,
  validateCodexModelMappingsPatch,
} from '../../src/lib/protocol/codex-model-mapping.mjs'
import { normalizeCodexRouting } from '../../src/lib/protocol/codex-route.mjs'
import { resetGptModelPolicy, saveGptModelPolicy } from '../../src/lib/protocol/gpt-model-policy.mjs'
import fs from 'node:fs'
import path from 'node:path'

test('default map rewrites codex-auto-review before platform detect', () => {
  resetGptModelPolicy()
  const rewrite = applyCodexInboundModelRewrite({ model: 'codex-auto-review' }, {})
  assert.equal(rewrite.ok, true)
  assert.equal(rewrite.mapped, true)
  assert.equal(rewrite.requestedModel, 'codex-auto-review')
  assert.equal(rewrite.upstreamModel, DEFAULT_CODEX_MODEL_MAPPINGS['codex-auto-review'])
  const platform = detectInboundPlatform(rewrite.body.model)
  assert.equal(platform.ok, true)
  assert.equal(platform.platform, 'openai')
  assert.equal(platform.model, 'gpt-6-luna')
})

test('literal detectInboundPlatform still fail-closes codex-auto-review', () => {
  assert.equal(detectInboundPlatform('codex-auto-review').ok, false)
})

test('custom routing.model_mappings overrides default target', () => {
  resetGptModelPolicy()
  const routing = { codex: { model_mappings: { 'codex-auto-review': 'gpt-6-sol' } } }
  const rewrite = applyCodexInboundModelRewrite({ model: 'codex-auto-review' }, routing)
  assert.equal(rewrite.upstreamModel, 'gpt-6-sol')
  assert.equal(detectInboundPlatform(rewrite.body.model).platform, 'openai')
})

test('empty configured target for codex-auto-review uses fallback sol model', () => {
  resetGptModelPolicy()
  const mappings = normalizeCodexModelMappings({ 'codex-auto-review': '' })
  assert.equal(mappings['codex-auto-review'], DEFAULT_CODEX_MODEL_MAPPING_FALLBACK)
  const rewrite = applyCodexInboundModelRewrite(
    { model: 'codex-auto-review' },
    { codex: { model_mappings: { 'codex-auto-review': '' } } },
  )
  assert.equal(rewrite.upstreamModel, DEFAULT_CODEX_MODEL_MAPPING_FALLBACK)
})

test('invalid non-GPT mapping target returns codex_model_mapping_invalid', () => {
  resetGptModelPolicy()
  const rewrite = applyCodexInboundModelRewrite(
    { model: 'codex-auto-review' },
    { codex: { model_mappings: { 'codex-auto-review': 'claude-sonnet-4-6' } } },
  )
  assert.equal(rewrite.ok, false)
  assert.equal(rewrite.code, 'codex_model_mapping_invalid')
})

test('disabled GPT mapping target returns model_disabled', () => {
  resetGptModelPolicy()
  saveGptModelPolicy({
    models: {
      'gpt-6-luna': { id: 'gpt-6-luna', enabled: false },
    },
  })
  const check = validateCodexModelMappingTarget('gpt-6-luna')
  assert.equal(check.ok, false)
  assert.equal(check.code, 'model_disabled')
  const rewrite = applyCodexInboundModelRewrite({ model: 'codex-auto-review' }, {})
  assert.equal(rewrite.ok, false)
  assert.equal(rewrite.code, 'model_disabled')
})

test('normalizeCodexRouting hot-loads model_mappings defaults', () => {
  const codex = normalizeCodexRouting({})
  assert.equal(codex.model_mappings['codex-auto-review'], 'gpt-6-luna')
})

test('handle-protocol applies codex model rewrite before detectInboundPlatform', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/protocol/handle-protocol.mjs'), 'utf8')
  const rewriteAt = src.indexOf('applyCodexInboundModelRewrite')
  const detectAt = src.indexOf('detectInboundPlatform(ctx.body?.model)')
  assert.ok(rewriteAt > 0 && detectAt > rewriteAt)
})

test('mapping patch rejects aliases that would hijack Claude or image requests', () => {
  resetGptModelPolicy()
  for (const alias of [
    'claude-opus-5-5',
    'anthropic.claude-sonnet-5',
    'sonnet-5',
    'gpt-image-2.5-flare',
    'gpt-image-2.5-sunburst-2026-09-08',
    'my alias',
    'tab\talias',
  ]) {
    assert.throws(
      () => validateCodexModelMappingsPatch({ [alias]: 'gpt-6-luna' }),
      (error) => error.code === 'invalid_codex_model_mappings',
      alias,
    )
  }
})

test('mapping patch accepts plain aliases and codex-auto-review', () => {
  resetGptModelPolicy()
  assert.doesNotThrow(() =>
    validateCodexModelMappingsPatch({
      'codex-auto-review': 'gpt-6-sol',
      'my-fast': 'gpt-6-luna',
      'gpt-5': 'gpt-6-luna',
    }),
  )
  assert.doesNotThrow(() => validateCodexModelMappingsPatch({ 'codex-auto-review': null }))
})

test('stored invalid aliases are kept on normalize; only new writes are rejected', () => {
  const merged = normalizeCodexModelMappings({ 'claude-x': 'gpt-6-luna' })
  assert.equal(merged['claude-x'], 'gpt-6-luna')
})

test('mapping patch rejects a disabled GPT target with model_disabled', () => {
  resetGptModelPolicy()
  saveGptModelPolicy({ models: { 'gpt-6-sol': { id: 'gpt-6-sol', enabled: false } } })
  assert.throws(
    () => validateCodexModelMappingsPatch({ 'codex-auto-review': 'gpt-6-sol' }),
    (error) => error.code === 'model_disabled',
  )
  resetGptModelPolicy()
})
