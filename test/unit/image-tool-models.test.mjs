import test from 'node:test'
import assert from 'node:assert/strict'
import {
  IMAGE_TOOL_MODELS,
  canonicalImageToolModel,
  imageGenerationTools,
} from '../../src/lib/protocol/image-tool-models.mjs'
import { detectInboundPlatform } from '../../src/lib/protocol/platform-detect.mjs'

test('ships flare as upstream default and sunburst', () => {
  assert.deepEqual(
    IMAGE_TOOL_MODELS.map((m) => [m.id, m.upstream_default]),
    [
      ['gpt-image-2.5-flare', true],
      ['gpt-image-2.5-sunburst', false],
    ],
  )
})

test('canonicalImageToolModel folds snapshots, case and provider prefix', () => {
  assert.equal(canonicalImageToolModel('gpt-image-2.5-flare'), 'gpt-image-2.5-flare')
  assert.equal(canonicalImageToolModel('GPT-Image-2.5-Sunburst-2026-09-08'), 'gpt-image-2.5-sunburst')
  assert.equal(canonicalImageToolModel('openai/gpt-image-2.5-flare-2026-09-08'), 'gpt-image-2.5-flare')
  assert.equal(canonicalImageToolModel(' gpt-image-2.5-flare '), 'gpt-image-2.5-flare')
})

test('canonicalImageToolModel returns null for other ids', () => {
  for (const id of ['', null, undefined, 'gpt-image-2', 'gpt-image-2.5', 'gpt-6-luna', 'gpt-image-2.5-flare-x']) {
    assert.equal(canonicalImageToolModel(id), null, String(id))
  }
})

test('imageGenerationTools picks only image_generation entries', () => {
  const body = {
    tools: [
      { type: 'function', name: 'f' },
      { type: 'image_generation', model: 'gpt-image-2.5-sunburst' },
      null,
      { type: 'image_generation' },
    ],
  }
  assert.deepEqual(imageGenerationTools(body), [
    { type: 'image_generation', model: 'gpt-image-2.5-sunburst' },
    { type: 'image_generation' },
  ])
  assert.deepEqual(imageGenerationTools({}), [])
  assert.deepEqual(imageGenerationTools(null), [])
})

test('image models stay out of chat routing', () => {
  const detected = detectInboundPlatform('gpt-image-2.5-flare')
  assert.equal(detected.ok, false)
  assert.equal(detected.code, 'model_not_supported')
})
