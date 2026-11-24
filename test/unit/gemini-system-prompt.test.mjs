import assert from 'node:assert/strict'
import test from 'node:test'
import { validatePersonaRoutingPatch } from '../../src/lib/admin/panel-api.mjs'
import {
  applyCragGeminiPromptPolicy,
  normalizeCragGeminiPersonaPreset,
  resolveCragGeminiPromptPolicy,
} from '../../src/lib/gemini/system-prompt.mjs'

test('normalizeCragGeminiPersonaPreset maps aliases and defaults to official_full', () => {
  assert.equal(normalizeCragGeminiPersonaPreset(undefined), 'official_full')
  assert.equal(normalizeCragGeminiPersonaPreset(''), 'official_full')
  assert.equal(normalizeCragGeminiPersonaPreset('official_full'), 'official_full')
  assert.equal(normalizeCragGeminiPersonaPreset('official'), 'official_full')
  assert.equal(normalizeCragGeminiPersonaPreset('zero'), 'zero')
  assert.equal(normalizeCragGeminiPersonaPreset('0'), 'zero')
  assert.equal(normalizeCragGeminiPersonaPreset('replace'), 'zero')
})

test('applyCragGeminiPromptPolicy handles official_full and zero modes with optional globalPrompt', () => {
  const base = {
    model: 'gemini-3-flash',
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    systemInstruction: { parts: [{ text: 'Respond in JSON.' }] },
  }

  const official = applyCragGeminiPromptPolicy(base, { preset: 'official_full', globalPrompt: '' })
  assert.equal(official.system_prompt_mode, 'official_full')
  assert.deepEqual(official.systemInstruction, { parts: [{ text: 'Respond in JSON.' }] })

  const officialWithGlobal = applyCragGeminiPromptPolicy(base, {
    preset: 'official_full',
    globalPrompt: 'Global rule.',
  })
  assert.equal(officialWithGlobal.system_prompt_mode, 'official_full')
  assert.deepEqual(officialWithGlobal.systemInstruction, {
    parts: [{ text: 'Global rule.\n\nRespond in JSON.' }],
  })

  const zeroWithCaller = applyCragGeminiPromptPolicy(base, { preset: 'zero', globalPrompt: '' })
  assert.equal(zeroWithCaller.system_prompt_mode, 'zero')
  assert.deepEqual(zeroWithCaller.systemInstruction, { parts: [{ text: 'Respond in JSON.' }] })

  const zeroNoCaller = applyCragGeminiPromptPolicy(
    { model: 'gemini-3-flash', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    { preset: 'zero', globalPrompt: '' },
  )
  assert.equal(zeroNoCaller.system_prompt_mode, 'zero')
  assert.equal(zeroNoCaller.systemInstruction, undefined)

  const zeroGlobalFallback = applyCragGeminiPromptPolicy(
    { model: 'gemini-3-flash', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    resolveCragGeminiPromptPolicy({
      compatibility: {
        craggemini_persona_preset: 'zero',
        craggemini_system_prompt: 'Only speak Chinese.',
      },
    }),
  )
  assert.equal(zeroGlobalFallback.system_prompt_mode, 'zero')
  assert.deepEqual(zeroGlobalFallback.systemInstruction, { parts: [{ text: 'Only speak Chinese.' }] })
})

test('validatePersonaRoutingPatch validates craggemini_persona_preset and craggemini_system_prompt', () => {
  assert.deepEqual(validatePersonaRoutingPatch({ compatibility: { craggemini_persona_preset: 'official_full' } }), [])
  assert.deepEqual(validatePersonaRoutingPatch({ compatibility: { craggemini_persona_preset: 'zero' } }), [])
  assert.deepEqual(validatePersonaRoutingPatch({ compatibility: { craggemini_persona_preset: '' } }), [])
  assert.match(
    validatePersonaRoutingPatch({ compatibility: { craggemini_persona_preset: 'custom' } })[0],
    /craggemini_persona_preset/,
  )
  assert.deepEqual(
    validatePersonaRoutingPatch({ compatibility: { craggemini_system_prompt: 'Be concise.' } }),
    [],
  )
  assert.match(
    validatePersonaRoutingPatch({ compatibility: { craggemini_system_prompt: 123 } })[0],
    /craggemini_system_prompt/,
  )
  assert.match(
    validatePersonaRoutingPatch({ compatibility: { craggemini_system_prompt: 'x'.repeat(32_769) } })[0],
    /32768/,
  )
})
