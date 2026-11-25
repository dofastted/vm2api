import assert from 'node:assert/strict'
import test from 'node:test'
import { validatePersonaRoutingPatch } from '../../src/lib/admin/panel-api.mjs'
import {
  applyCragGeminiPromptPolicy,
  normalizeCragGeminiPersonaPreset,
  resolveCragGeminiPromptPolicy,
  sanitizeCragGeminiSystemText,
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
  assert.deepEqual(validatePersonaRoutingPatch({ compatibility: { craggemini_system_prompt: 'Be concise.' } }), [])
  assert.match(
    validatePersonaRoutingPatch({ compatibility: { craggemini_system_prompt: 123 } })[0],
    /craggemini_system_prompt/,
  )
  assert.match(
    validatePersonaRoutingPatch({ compatibility: { craggemini_system_prompt: 'x'.repeat(32_769) } })[0],
    /32768/,
  )
  assert.deepEqual(validatePersonaRoutingPatch({ compatibility: { craggemini_prompt_normalization: 'auto' } }), [])
  assert.deepEqual(validatePersonaRoutingPatch({ compatibility: { craggemini_prompt_normalization: 'strict' } }), [])
  assert.deepEqual(validatePersonaRoutingPatch({ compatibility: { craggemini_prompt_normalization: 'off' } }), [])
  assert.deepEqual(validatePersonaRoutingPatch({ compatibility: { craggemini_prompt_normalization: '' } }), [])
  assert.match(
    validatePersonaRoutingPatch({ compatibility: { craggemini_prompt_normalization: 'custom' } })[0],
    /craggemini_prompt_normalization/,
  )
})

test('applyCragGeminiPromptPolicy normalizes conflicting third-party CLI identity banners that trigger Antigravity 429', () => {
  const claudeCodeReq = {
    model: 'gemini-4-neon-xhigh',
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    systemInstruction: {
      parts: [
        {
          text: "You are Claude Code, Anthropic's official CLI for Claude.\nFollow project instructions carefully.",
        },
        { text: 'you are opencode, an interactive agent.' },
      ],
    },
  }
  const normalized = applyCragGeminiPromptPolicy(claudeCodeReq, { preset: 'official_full', globalPrompt: '' })
  assert.equal(
    normalized.systemInstruction.parts[0].text,
    'You are a coding assistant.\nFollow project instructions carefully.',
  )
  assert.equal(normalized.systemInstruction.parts[1].text, 'You are a coding assistant.')
  assert.doesNotMatch(normalized.systemInstruction.parts[0].text, /you are claude code|anthropic/i)
  assert.doesNotMatch(normalized.systemInstruction.parts[1].text, /you are opencode/i)
  // Original object must not be mutated.
  assert.match(claudeCodeReq.systemInstruction.parts[0].text, /You are Claude Code/)
  // Non-conflicting references stay untouched.
  assert.equal(sanitizeCragGeminiSystemText('This is a Claude Code session.'), 'This is a Claude Code session.')
})

test('applyCragGeminiPromptPolicy normalizes Claude Code dual-use security parenthetical that triggers Antigravity 429', () => {
  const stockPara =
    'IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. ' +
    'Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. ' +
    'Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: ' +
    'pentesting engagements, CTF competitions, security research, or defensive use cases.'
  const req = {
    model: 'gemini-4-neon-xhigh',
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    systemInstruction: {
      parts: [{ text: `You are Claude Code, Anthropic's official CLI for Claude.\n\n${stockPara}` }],
    },
  }
  const normalized = applyCragGeminiPromptPolicy(req, { preset: 'official_full', globalPrompt: '' })
  const outText = normalized.systemInstruction.parts[0].text
  assert.doesNotMatch(outText, /you are claude code/i)
  assert.doesNotMatch(outText, /C2 frameworks/i)
  assert.match(outText, /Refuse requests for destructive techniques/)
  assert.match(
    outText,
    /Dual-use security tools require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases\./,
  )
  // Original request object must remain untouched.
  assert.match(req.systemInstruction.parts[0].text, /C2 frameworks/)
})
