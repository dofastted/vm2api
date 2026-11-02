import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULT_OVERLAY_TEMPLATES,
  DEFAULT_PERSONA_TEMPLATES,
  DEFAULT_AGENT_STANDING,
  agentStandingVar,
  extractTemplateVars,
  normalizeOverlayPreset,
  normalizePersonaPreset,
  parsePersonaHides,
  parsePersonaTemplateLines,
  personaPresetFromLegacyMode,
  presetFlagEnabled,
  renderOverlayTemplate,
  renderPersonaTemplate,
  resolveOverlayTemplate,
  resolvePersonaTemplate,
  selectedTemplateBlocks,
  stringifyPersonaTemplate,
  templateHidesAnything,
  validatePersonaTemplate,
} from '../../src/lib/identity/persona-template.mjs'
import {
  CRS_COMPACT_IDENTITY,
  CRS_EMPTY_IDENTITY_TEXT,
  CRS_OFFICIAL_AGENT_PROMPT,
  CRS_OFFICIAL_AGENT_PROMPT_303,
  CRS_OFFICIAL_SYSTEM,
  CRS_OFFICIAL_CLI_SYSTEM,
  CRS_STANDING_CONSTRAINT,
  DEFAULT_CLI_VERSION,
  applyCrsUnofficialPersona,
  buildBillingAttributionText,
  buildZeroBillingText,
  overlayPresetFromCompat,
  personaHidesUsageFromRoutingFile,
  personaPresetFromHopMode,
  personaTemplateSettingsFromRouting,
  personaTemplateVars,
  wrapMandatoryConstraint,
} from '../../src/lib/identity/crs-persona.mjs'
import { OFFICIAL_303_HARNESS, renderOfficial303Guidance } from '../../src/lib/identity/official-profiles.mjs'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'
import { validatePersonaRoutingPatch } from '../../src/lib/admin/panel-api.mjs'
import {
  buildOfficialEnvironmentSection,
  buildOverwriteEnvironmentSection,
  displayNameForModel,
} from '../../src/lib/identity/official-cc-system-2.1.241.mjs'

test('Fable 5.1 display names support canonical and legacy model IDs', () => {
  for (const modelId of ['claude-fable-5-1', 'claude-fable-5.1']) {
    for (const suffix of ['', '[1m]']) {
      const id = modelId + suffix
      assert.equal(displayNameForModel(id), 'Fable 5.1')
      assert.ok(
        buildOverwriteEnvironmentSection({ modelId: id }).includes(
          `You are powered by the model named Fable 5.1. The exact model ID is ${modelId}.`,
        ),
      )
    }
  }
  assert.equal(displayNameForModel('claude-fable-5'), 'Fable 5')
})

test('Opus 5.5 display names support canonical and legacy model IDs', () => {
  for (const modelId of ['claude-opus-5-5', 'claude-opus-5.5']) {
    assert.equal(displayNameForModel(modelId), 'Opus 5.5')
    assert.equal(displayNameForModel(`${modelId}[1m]`), 'Opus 5.5')
  }
  assert.equal(displayNameForModel('claude-opus-5'), 'Opus 5')
})

function withRoutingFile(compatibility, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tpl-'))
  const file = path.join(dir, 'routing.json')
  fs.writeFileSync(file, JSON.stringify({ compatibility }))
  try {
    return fn(file)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function firstUserText(out) {
  const content = out.messages?.[0]?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? b : b?.text || '')).join('')
  return content == null ? '' : String(content)
}

test('guidance is off by default and explicit enable keeps cwd memory behavior', () => {
  const vars = personaTemplateVars({ firstUserText: 'hello', sessionId: 's-guidance', env: { cwd: '/srv/app' } })
  const off = renderPersonaTemplate(selectedTemplateBlocks(DEFAULT_PERSONA_TEMPLATES.official, {}, 'official'), vars)
  assert.equal(
    off.some((block) => String(block.text).includes('Write code that reads like the surrounding code')),
    false,
  )
  const compat = { persona_guidance_presets: { official: true } }
  const enabledVars = personaTemplateVars({
    firstUserText: 'hello',
    sessionId: 's-guidance',
    env: { cwd: '/srv/app' },
    compat,
    preset: 'official',
  })
  const on = renderPersonaTemplate(
    selectedTemplateBlocks(DEFAULT_PERSONA_TEMPLATES.official, compat, 'official'),
    enabledVars,
  )
  assert.equal(
    on.some((block) => String(block.text).includes('/srv/app/.claude/projects/-srv-app/memory/')),
    true,
  )
  const omittedVars = personaTemplateVars({
    firstUserText: 'hello',
    sessionId: 's-guidance',
    compat,
    preset: 'official',
  })
  const omitted = renderPersonaTemplate(
    selectedTemplateBlocks(DEFAULT_PERSONA_TEMPLATES.official, compat, 'official'),
    omittedVars,
  )
  assert.equal(
    omitted.some((block) => String(block.text).includes('# Memory')),
    false,
  )
  assert.equal(
    omitted.some((block) => String(block.text).includes('Write code that reads like the surrounding code')),
    true,
  )
})

function envMessages(out) {
  return (out.messages || []).filter((message) => message?.role === 'system').map((message) => String(message.content))
}

test('official preset renders caller system as a first-user reminder block, not a system segment', () => {
  const vars = personaTemplateVars({
    firstUserText: 'hi',
    leftover: '你是一个高速收费员。',
  })
  const top = renderPersonaTemplate(
    DEFAULT_PERSONA_TEMPLATES.official.filter((block) => block.id !== 'caller_system'),
    vars,
  )
  assert.equal(
    top.some((block) => String(block.text).includes('你是一个高速收费员。')),
    false,
  )
  const caller = renderPersonaTemplate(
    DEFAULT_PERSONA_TEMPLATES.official.filter((block) => block.id === 'caller_system'),
    vars,
  )
  assert.deepEqual(
    caller.map((block) => block.text),
    ['<system-reminder>\n你是一个高速收费员。\n</system-reminder>\n'],
  )
  assert.ok(!top.some((block) => String(block.text).includes('{{caller_agent}}')))
})

test('official_full template orders billing, CLI identity, harness, boundary, then opt-in guidance', () => {
  const compat = { persona_guidance_presets: { official_full: true } }
  const vars = personaTemplateVars({
    firstUserText: 'hello',
    sessionId: 's-full',
    withEnv: true,
    preset: 'official_full',
    compat,
  })
  const blocks = selectedTemplateBlocks(DEFAULT_PERSONA_TEMPLATES.official_full, compat, 'official_full').filter(
    (block) => block.id !== 'caller_system',
  )
  const out = renderPersonaTemplate(blocks, vars)
  assert.match(out[0].text, /^x-anthropic-billing-header: /)
  assert.equal(out[1].text, CRS_OFFICIAL_CLI_SYSTEM)
  assert.equal(out[2].text, OFFICIAL_303_HARNESS)
  assert.deepEqual(out[2].cache_control, { type: 'ephemeral', scope: 'global' })
  assert.equal(out[3].text, '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__')
  assert.equal(out[4].text, renderOfficial303Guidance())
  assert.deepEqual(out[4].cache_control, { type: 'ephemeral' })
  assert.equal(
    out.some((block) => block.text.startsWith('# Environment')),
    false,
  )
  assert.match(renderPersonaTemplate(blocks, vars, { role: 'system' })[0].text, /^# Environment/)
  assert.equal(
    out.some((block) => block.text.includes(CRS_OFFICIAL_AGENT_PROMPT_303.slice(0, 40))),
    false,
  )
  const off = renderPersonaTemplate(
    selectedTemplateBlocks(DEFAULT_PERSONA_TEMPLATES.official_full, {}, 'official_full'),
    personaTemplateVars({ firstUserText: 'hello', withEnv: true, preset: 'official_full' }),
  )
  assert.equal(
    off.some((block) => block.text.startsWith('Write code that reads like the surrounding code')),
    false,
  )
})

test('agent standing preset flags default off and isolate per preset', () => {
  for (const preset of ['official', 'official_full', 'zero', 'custom']) {
    assert.equal(presetFlagEnabled({}, 'agent_standing_presets', preset), false)
    assert.equal(agentStandingVar({}, preset), '')
  }
  assert.equal(presetFlagEnabled({}, 'persona_env_presets', 'official'), true)
  assert.equal(presetFlagEnabled({}, 'agent_standing_hide_presets', 'official'), true)
  assert.equal(
    agentStandingVar({ agent_standing_presets: { official: true } }, 'official'),
    `${DEFAULT_AGENT_STANDING}\n`,
  )
  assert.equal(agentStandingVar({ agent_standing_presets: { official: true } }, 'zero'), '')
  assert.equal(agentStandingVar({ agent_standing_presets: { zero: false } }, 'zero'), '')
  assert.equal(agentStandingVar({ agent_standing: '', agent_standing_presets: { official: true } }, 'official'), '')
})

test('zero prompt_version uses the interactive CLI identity', () => {
  const billing = buildZeroBillingText('ping', '2.1.241', 's-2')
  assert.ok(billing.includes(`prompt_version=<${CRS_OFFICIAL_CLI_SYSTEM}>`))
  assert.ok(!billing.includes(CRS_OFFICIAL_SYSTEM))
  assert.ok(!billing.includes(CRS_COMPACT_IDENTITY))
})

test('whole-preset usage mask: persona_hide_presets > persona_hides > template hide flags', () => {
  withRoutingFile({ persona_preset: 'zero' }, (file) => {
    assert.equal(personaHidesUsageFromRoutingFile(file), true)
  })
  withRoutingFile({ persona_preset: 'zero', persona_hides: false }, (file) => {
    assert.equal(personaHidesUsageFromRoutingFile(file), false)
  })
  withRoutingFile({ persona_preset: 'official', persona_hides: true }, (file) => {
    assert.equal(personaHidesUsageFromRoutingFile(file), true)
  })
  withRoutingFile(
    { persona_preset: 'zero', persona_hides: true, persona_hide_presets: { zero: false, official: true } },
    (file) => {
      assert.equal(personaHidesUsageFromRoutingFile(file), false)
      // A slot hop override reads its own preset's switch, not the stored preset's.
      assert.equal(personaHidesUsageFromRoutingFile(file, 'official_prompt'), true)
    },
  )
  withRoutingFile({ persona_preset: 'official' }, (file) => {
    assert.equal(personaHidesUsageFromRoutingFile(file, 'zero'), true)
  })
  assert.equal(parsePersonaHides(false), false)
  assert.equal(parsePersonaHides('off'), false)
})

test('official overlay renders byte-identical to wrapMandatoryConstraint', () => {
  const standing = CRS_STANDING_CONSTRAINT
  const rendered = renderOverlayTemplate(DEFAULT_OVERLAY_TEMPLATES.official, { standing })
  assert.equal(rendered, wrapMandatoryConstraint(standing))
})

test('minimal overlay drops the MANDATORY sentence but keeps the reminder shell', () => {
  const rendered = renderOverlayTemplate(DEFAULT_OVERLAY_TEMPLATES.minimal, { standing: 'be brief' })
  assert.equal(rendered, '<system-reminder>\nbe brief\n</system-reminder>\n')
  assert.ok(!rendered.includes('MANDATORY'))
})

test('overlay with no body renders nothing at all', () => {
  assert.equal(renderOverlayTemplate(DEFAULT_OVERLAY_TEMPLATES.official, { standing: '' }), '')
})

test('JSONL round-trips losslessly and keeps note metadata', () => {
  const jsonl = stringifyPersonaTemplate(DEFAULT_PERSONA_TEMPLATES.official)
  assert.equal(jsonl.split('\n').length, DEFAULT_PERSONA_TEMPLATES.official.length)
  const { blocks, errors } = parsePersonaTemplateLines(jsonl)
  assert.deepEqual(errors, [])
  assert.deepEqual(
    blocks,
    DEFAULT_PERSONA_TEMPLATES.official.map((b) => JSON.parse(JSON.stringify(b))),
  )
  assert.equal(blocks[0].note, '计费归因头：cc_version / cc_entrypoint / cch / cc_prompt_id，官方必带')
  assert.equal(stringifyPersonaTemplate(blocks), jsonl)
})

test('parse reports the offending line number and skips blanks and comments', () => {
  const { blocks, errors } = parsePersonaTemplateLines(
    ['{"type":"text","text":"{{billing}}"}', '', '// a comment', '{"type":"text","text":', '[1,2]'].join('\n'),
  )
  assert.equal(blocks.length, 1)
  assert.equal(errors.length, 2)
  assert.equal(errors[0].line, 4)
  assert.match(errors[0].message, /不是合法 JSON/)
  assert.equal(errors[1].line, 5)
  assert.match(errors[1].message, /JSON 对象/)
})

test('meta keys never reach the outbound block', () => {
  const out = renderPersonaTemplate(
    [{ id: 'x', note: 'n', hide: true, drop_if_empty: false, type: 'text', text: 'body' }],
    {},
  )
  assert.deepEqual(out, [{ type: 'text', text: 'body' }])
})

test('unknown placeholders are rejected by validation', () => {
  const errors = validatePersonaTemplate([{ type: 'text', text: '{{billing}} {{nope}}' }])
  assert.equal(errors.length, 1)
  assert.match(errors[0], /未登记的占位符 \{\{nope\}\}/)
})

test('validation requires exactly one overlay wrapper carrying overlay_body', () => {
  assert.deepEqual(validatePersonaTemplate(DEFAULT_OVERLAY_TEMPLATES.official, { overlay: true }), [])
  const noWrapper = validatePersonaTemplate([{ type: 'body', text: '{{standing}}' }], { overlay: true })
  assert.match(noWrapper.join(' '), /恰好有一个 wrapper/)
  const bodyUsesBody = validatePersonaTemplate(
    [
      { type: 'wrapper', text: '{{overlay_body}}' },
      { type: 'body', text: '{{overlay_body}}' },
    ],
    { overlay: true },
  )
  assert.match(bodyUsesBody.join(' '), /不能使用 \{\{overlay_body\}\}/)
})

test('validation rejects non-text persona blocks and missing text', () => {
  assert.match(validatePersonaTemplate([{ type: 'wrapper', text: 'x' }]).join(' '), /type 只能是 text/)
  assert.match(validatePersonaTemplate([{ type: 'text' }]).join(' '), /缺少字符串 text/)
})

test('built-in presets pass their own validation', () => {
  assert.deepEqual(validatePersonaTemplate(DEFAULT_PERSONA_TEMPLATES.official), [])
  assert.deepEqual(validatePersonaTemplate(DEFAULT_PERSONA_TEMPLATES.official_full), [])
  assert.deepEqual(validatePersonaTemplate(DEFAULT_PERSONA_TEMPLATES.zero), [])
  assert.deepEqual(validatePersonaTemplate(DEFAULT_OVERLAY_TEMPLATES.minimal, { overlay: true }), [])
})

test('hide metadata drives usage masking: official hides nothing, zero hides billing and env', () => {
  assert.equal(templateHidesAnything(DEFAULT_PERSONA_TEMPLATES.official), false)
  assert.equal(templateHidesAnything(DEFAULT_PERSONA_TEMPLATES.official_full), false)
  assert.equal(templateHidesAnything(DEFAULT_PERSONA_TEMPLATES.zero), false)
})

test('empty template array falls back to the built-in preset; empty custom falls back to official', () => {
  assert.deepEqual(resolvePersonaTemplate('zero', { zero: [] }), DEFAULT_PERSONA_TEMPLATES.zero)
  assert.deepEqual(resolvePersonaTemplate('custom', {}), DEFAULT_PERSONA_TEMPLATES.official)
  assert.deepEqual(resolveOverlayTemplate('off', { official: [] }), [])
  assert.deepEqual(resolveOverlayTemplate('custom', {}), DEFAULT_OVERLAY_TEMPLATES.official)
})

test('preset normalization accepts legacy aliases', () => {
  assert.equal(normalizePersonaPreset('official_full'), 'official_full')
  assert.equal(normalizePersonaPreset('full'), 'official_full')
  assert.equal(normalizePersonaPreset('official_prompt'), 'official')
  assert.equal(normalizePersonaPreset('0-inject'), 'zero')
  assert.equal(normalizePersonaPreset('nonsense'), 'official_full')
  assert.equal(normalizeOverlayPreset('disabled'), 'off')
  assert.equal(normalizeOverlayPreset('slim'), 'minimal')
  assert.equal(personaPresetFromLegacyMode('rewrite'), 'custom')
  assert.equal(personaPresetFromLegacyMode('overwrite'), 'custom')
  assert.equal(personaPresetFromLegacyMode('zero'), 'zero')
  assert.equal(personaPresetFromLegacyMode('official_prompt'), 'official')
})

test('overlay_preset is derived from persona_park when absent', () => {
  assert.equal(overlayPresetFromCompat({ persona_park: false }), 'off')
  assert.equal(overlayPresetFromCompat({ persona_park: true }), 'official')
  assert.equal(overlayPresetFromCompat({ persona_park: true, overlay_preset: 'off' }), 'off')
  assert.equal(overlayPresetFromCompat({ persona_park: false, overlay_preset: 'minimal' }), 'minimal')
})

test('extractTemplateVars tolerates spacing and is case-insensitive', () => {
  assert.deepEqual(extractTemplateVars('{{ billing }} and {{IDENTITY}}'), ['billing', 'identity'])
})

test('overlay and environment off: messages pass through by reference', () => {
  withRoutingFile(
    { persona_preset: 'official', overlay_preset: 'off', persona_env_presets: { official: false } },
    (file) => {
      const messages = [{ role: 'user', content: 'hello' }]
      const out = applyCrsUnofficialPersona({ messages }, { routingFile: file })
      assert.equal(out.messages, messages)
      assert.equal(firstUserText(out), 'hello')
      assert.ok(!firstUserText(out).includes('system-reminder'))
    },
  )
})

test('zero preset ignores a stored overlay_preset and never parks', () => {
  withRoutingFile({ persona_preset: 'zero', overlay_preset: 'official' }, (file) => {
    const messages = [{ role: 'user', content: 'hello' }]
    const out = applyCrsUnofficialPersona({ messages }, { routingFile: file })
    assert.equal(out.messages, messages)
    assert.ok(!firstUserText(out).includes('MANDATORY'))
    assert.equal(out.system.length, 1)
    assert.match(out.system[0].text, /prompt_version=<You are Claude Code, Anthropic's official CLI for Claude\.>/)
    assert.equal(
      out.system.some((block) => block.text === '\u200b'),
      false,
    )
    assert.equal(
      out.system.some((block) => String(block.text).startsWith('# Environment')),
      false,
    )
  })
})

test('official preset with overlay official parks the mandatory reminder without default standing', () => {
  withRoutingFile({ persona_preset: 'official', overlay_preset: 'official' }, (file) => {
    const out = applyCrsUnofficialPersona(
      {
        messages: [{ role: 'user', content: 'hello' }],
      },
      { routingFile: file },
    )
    assert.match(firstUserText(out), /MANDATORY constraints for this turn/)
    assert.ok(firstUserText(out).includes('hello'))
    assert.ok(!out.system.some((b) => String(b?.text || '').includes(DEFAULT_AGENT_STANDING)))
    assert.match(out.system[0].text, /^x-anthropic-billing-header: /)
    assert.equal(out.system[1].text, CRS_OFFICIAL_CLI_SYSTEM)
    assert.equal(out.system[2].text, OFFICIAL_303_HARNESS)
    assert.equal(
      out.system.some((block) => String(block.text).startsWith('Write code that reads like the surrounding code')),
      false,
    )
  })
})
test('official_full routing preset writes the 303 harness, Environment as role=system, and guidance only on opt-in', () => {
  withRoutingFile({ persona_preset: 'official_full', overlay_preset: 'off' }, (file) => {
    const out = applyCrsUnofficialPersona(
      { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hello' }] },
      { routingFile: file },
    )
    assert.match(out.system[0].text, /^x-anthropic-billing-header: /)
    assert.equal(out.system[1].text, CRS_OFFICIAL_CLI_SYSTEM)
    assert.equal(out.system[2].text, OFFICIAL_303_HARNESS)
    assert.deepEqual(out.system[2].cache_control, { type: 'ephemeral', scope: 'global' })
    assert.equal(out.system[3].text, '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__')
    assert.equal(
      out.system.some((block) => String(block.text).startsWith('Write code that reads like the surrounding code')),
      false,
    )
    assert.equal(
      out.system.some((block) => String(block.text).startsWith('# Environment')),
      false,
    )
    assert.deepEqual(
      out.messages.map((message) => message.role),
      ['user', 'system'],
    )
    assert.match(envMessages(out)[0], /^# Environment/)
  })
  withRoutingFile(
    { persona_preset: 'official_full', overlay_preset: 'off', persona_guidance_presets: { official_full: true } },
    (file) => {
      const out = applyCrsUnofficialPersona({ messages: [{ role: 'user', content: 'hello' }] }, { routingFile: file })
      assert.equal(out.system[3].text, '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__')
      assert.equal(out.system[4].text, renderOfficial303Guidance())
    },
  )
})
test('cli-hop renders official and official_full from the configured template, then strips the Environment', () => {
  const inbound = {
    model: 'claude-sonnet-4-6',
    max_tokens: 128,
    system: 'CALLER_APPEND',
    messages: [{ role: 'user', content: 'hi' }],
  }
  for (const preset of ['official', 'official_full']) {
    withRoutingFile({ persona_preset: preset, overlay_preset: 'off' }, (file) => {
      // Production renders once from the caller input, then hands the body to the cli-hop preparer.
      const hop = prepareCliHopBody(
        applyCrsUnofficialPersona(structuredClone(inbound), {
          routingFile: file,
          mode: preset,
          identity: { timezone: 'America/New_York' },
        }),
      )
      const texts = hop.system.map((block) => String(block.text || ''))
      assert.equal(texts.filter((text) => text.startsWith('x-anthropic-billing-header')).length, 1, preset)
      assert.equal(texts.filter((text) => text === CRS_OFFICIAL_CLI_SYSTEM).length, 1, preset)
      assert.equal(texts.filter((text) => text === OFFICIAL_303_HARNESS).length, 1, preset)
      // sonnet-4-6 has no mid-conversation system: the Environment is lifted out of messages.
      assert.equal(
        hop.messages.some((message) => message.role === 'system'),
        false,
        preset,
      )
      assert.ok(
        texts.some((text) => /# Environment/.test(text)),
        preset,
      )
      assert.ok(firstUserText(hop).startsWith('<system-reminder>\nCALLER_APPEND\n</system-reminder>\n'), preset)
      assert.equal(
        texts.some((text) => text.includes('CALLER_APPEND')),
        false,
        preset,
      )
    })
  }
})

test('caller system becomes a first-user reminder and role=system stays in the transcript', () => {
  withRoutingFile({ persona_preset: 'official_full', overlay_preset: 'off' }, (file) => {
    const out = applyCrsUnofficialPersona(
      {
        model: 'claude-sonnet-5-5',
        system: '不要使用你现在的identity跟我对话',
        messages: [
          { role: 'user', content: '你是谁？' },
          { role: 'system', content: 'role-system-note' },
        ],
      },
      { routingFile: file },
    )
    assert.equal(
      out.system.some((block) => String(block.text).includes('不要使用你现在的identity跟我对话')),
      false,
    )
    assert.equal(
      firstUserText(out),
      '<system-reminder>\n不要使用你现在的identity跟我对话\n</system-reminder>\n你是谁？',
    )
    assert.equal(out.messages[1].role, 'system')
    assert.match(out.messages[1].content, /^# Environment/)
    assert.equal(out.messages.at(-1).role, 'system')
    assert.equal(out.messages.at(-1).content, 'role-system-note')
  })
})

test('hop mode official_full is a template preset, not overwrite', () => {
  assert.equal(personaPresetFromHopMode('official_full'), 'official_full')
  assert.equal(personaPresetFromHopMode('official_prompt'), 'official')
  assert.equal(personaPresetFromHopMode('zero'), 'zero')
  assert.equal(personaPresetFromHopMode('custom'), 'custom')
  withRoutingFile({ persona_preset: 'zero', overlay_preset: 'off' }, (file) => {
    const out = applyCrsUnofficialPersona(
      { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hello' }] },
      { routingFile: file, mode: 'official_full' },
    )
    assert.equal(out.system[1].text, CRS_OFFICIAL_CLI_SYSTEM)
    assert.equal(out.system[2].text, OFFICIAL_303_HARNESS)
    assert.equal(out.system[3].text, '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__')
    assert.match(envMessages(out)[0], /^# Environment/)
    assert.doesNotMatch(out.system[0].text, /prompt_version=/)
  })
})

test('PUT routing accepts official_full and empty follow-preset templates', () => {
  assert.deepEqual(
    validatePersonaRoutingPatch({
      compatibility: {
        persona_preset: 'official_full',
        overlay_preset: 'off',
        persona_templates: { official_full: [], zero: [] },
      },
    }),
    [],
  )
  assert.ok(validatePersonaRoutingPatch({ compatibility: { persona_preset: 'official_prompt' } }).length > 0)
})

test('PUT routing accepts only 5m and 1h cache TTL values', () => {
  assert.deepEqual(validatePersonaRoutingPatch({ compatibility: { cache_ttl: '5m' } }), [])
  assert.deepEqual(validatePersonaRoutingPatch({ compatibility: { cache_ttl: '1h' } }), [])
  assert.match(validatePersonaRoutingPatch({ compatibility: { cache_ttl: '60m' } })[0], /5m \/ 1h/)
})

test('PUT routing accepts summarized and passthrough thinking display', () => {
  assert.deepEqual(validatePersonaRoutingPatch({ compatibility: { thinking_display: 'summarized' } }), [])
  assert.deepEqual(validatePersonaRoutingPatch({ compatibility: { thinking_display: 'passthrough' } }), [])
  assert.match(
    validatePersonaRoutingPatch({ compatibility: { thinking_display: 'omitted' } })[0],
    /summarized \/ passthrough/,
  )
})

test('legacy routing without persona_preset keeps the old rewrite path', () => {
  withRoutingFile({ persona_inject: 'rewrite', persona_park: false }, (file) => {
    const out = applyCrsUnofficialPersona(
      {
        messages: [{ role: 'user', content: 'hello' }],
      },
      { routingFile: file },
    )
    assert.equal(out.system.length, 4)
    assert.ok(!firstUserText(out).includes('MANDATORY'))
  })
})

test('no persona preset and no inject uses the full official prompt', () => {
  assert.equal(personaTemplateSettingsFromRouting({}).preset, 'official_full')
  assert.equal(personaTemplateSettingsFromRouting({ compatibility: {} }).preset, 'official_full')
  withRoutingFile({ overlay_preset: 'off' }, (file) => {
    const out = applyCrsUnofficialPersona({ messages: [{ role: 'user', content: 'hello' }] }, { routingFile: file })
    assert.equal(out.system[2].text, OFFICIAL_303_HARNESS)
  })
})

test('custom template drives the outbound system verbatim', () => {
  withRoutingFile(
    {
      persona_preset: 'custom',
      overlay_preset: 'off',
      persona_timezone_presets: { custom: true },
      persona_templates: {
        custom: [{ id: 'only', note: '只有一行身份', type: 'text', text: 'You are {{identity}} at {{timezone}}' }],
      },
    },
    (file) => {
      const out = applyCrsUnofficialPersona(
        {
          messages: [{ role: 'user', content: 'hi' }],
        },
        { routingFile: file, identity: { timezone: 'Asia/Tokyo' } },
      )
      assert.equal(out.system.length, 1)
      assert.equal(out.system[0].text, `You are ${CRS_OFFICIAL_CLI_SYSTEM} at Asia/Tokyo`)
    },
  )
})

test('built-in templates omit cache_control.scope; custom explicit scope and caller body stay', () => {
  const vars = personaTemplateVars({
    firstUserText: 'hello',
    sessionId: 's-scope',
    leftover: 'KEEP_CALLER_SYSTEM',
    withEnv: true,
  })
  const full = renderPersonaTemplate(DEFAULT_PERSONA_TEMPLATES.official_full, vars)
  assert.deepEqual(full[2].cache_control, { type: 'ephemeral', scope: 'global' })
  assert.equal(full[2].text, OFFICIAL_303_HARNESS)
  assert.equal(full.at(-1).text, '<system-reminder>\nKEEP_CALLER_SYSTEM\n</system-reminder>\n')

  const official = renderPersonaTemplate(DEFAULT_PERSONA_TEMPLATES.official, {
    ...vars,
    caller_agent: 'KEEP_CALLER_AGENT',
  })
  assert.equal(
    official.some((block) => String(block.text).includes('KEEP_CALLER_AGENT')),
    false,
  )
  assert.equal(official.at(-1).text, '<system-reminder>\nKEEP_CALLER_SYSTEM\n</system-reminder>\n')

  withRoutingFile(
    {
      persona_preset: 'custom',
      overlay_preset: 'off',
      persona_templates: {
        custom: [
          {
            id: 'scoped',
            type: 'text',
            text: 'custom-scoped',
            cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' },
          },
        ],
      },
    },
    (file) => {
      const out = applyCrsUnofficialPersona({ messages: [{ role: 'user', content: 'hi' }] }, { routingFile: file })
      assert.equal(out.system.length, 1)
      assert.equal(out.system[0].text, 'custom-scoped')
      assert.deepEqual(out.system[0].cache_control, { type: 'ephemeral', ttl: '1h', scope: 'global' })
    },
  )

  withRoutingFile(
    {
      persona_preset: 'official',
      overlay_preset: 'off',
      persona_templates: {
        official: [
          { id: 'billing', type: 'text', text: '{{billing}}' },
          { id: 'identity', type: 'text', text: '{{identity}}' },
          { id: 'env', drop_if_empty: true, type: 'text', text: '{{env}}' },
          { id: 'caller_system', drop_if_empty: true, type: 'text', text: '{{caller_system}}' },
        ],
      },
    },
    (file) => {
      const out = applyCrsUnofficialPersona(
        {
          system: [
            { type: 'text', text: CRS_OFFICIAL_AGENT_PROMPT },
            { type: 'text', text: 'KEEP_CALLER_SYSTEM' },
          ],
          messages: [{ role: 'user', content: 'hi' }],
        },
        { routingFile: file },
      )
      const injected = out.system.find((block) => String(block?.text || '').includes('# Doing tasks'))
      assert.ok(injected)
      assert.equal(injected.text, CRS_OFFICIAL_AGENT_PROMPT)
      assert.deepEqual(injected.cache_control, { type: 'ephemeral', ttl: '1h' })
      assert.equal(
        out.system.some((block) => String(block.text).includes('KEEP_CALLER_SYSTEM')),
        false,
      )
      // A saved bare {{caller_system}} block is unwrapped once and re-wrapped as the first-user reminder.
      assert.ok(firstUserText(out).startsWith('<system-reminder>\nKEEP_CALLER_SYSTEM\n</system-reminder>\n'))
    },
  )
})

test('edited built-in templates saved with the old global-scope default stop sending scope', () => {
  const legacyCache = { type: 'ephemeral', ttl: '1h', scope: 'global' }
  const legacy = (preset) =>
    DEFAULT_PERSONA_TEMPLATES[preset].map((block) =>
      block.id === 'harness' || block.id === 'guidance'
        ? { ...block, note: `${block.note || ''} edited`, cache_control: legacyCache }
        : { ...block },
    )
  for (const preset of ['official', 'official_full']) {
    withRoutingFile(
      { persona_preset: preset, overlay_preset: 'off', persona_templates: { [preset]: legacy(preset) } },
      (file) => {
        const out = applyCrsUnofficialPersona({ messages: [{ role: 'user', content: 'hi' }] }, { routingFile: file })
        const scoped = out.system.filter((block) => block?.cache_control?.scope)
        assert.ok(scoped.length > 0, preset)
        assert.ok(
          out.system.some((block) => block?.cache_control?.scope === 'global' || block?.cache_control?.ttl === '1h'),
        )
      },
    )
  }
  const explicit = DEFAULT_PERSONA_TEMPLATES.official_full.map((block) =>
    block.id === 'guidance'
      ? { ...block, cache_control: { type: 'ephemeral', ttl: '5m', scope: 'global' } }
      : { ...block },
  )
  withRoutingFile(
    {
      persona_preset: 'official_full',
      overlay_preset: 'off',
      persona_guidance_presets: { official_full: true },
      persona_templates: { official_full: explicit },
    },
    (file) => {
      const out = applyCrsUnofficialPersona({ messages: [{ role: 'user', content: 'hi' }] }, { routingFile: file })
      assert.ok(
        out.system.some((block) => block?.cache_control?.scope === 'global' && block.cache_control.ttl === '5m'),
      )
    },
  )
})

test('custom overlay template replaces the reminder shell', () => {
  withRoutingFile(
    {
      persona_preset: 'official',
      overlay_preset: 'custom',
      persona_standing: 'stay terse',
      overlay_templates: {
        custom: [
          { id: 'shell', type: 'wrapper', text: '<<{{overlay_body}}>>' },
          { id: 'standing', type: 'body', drop_if_empty: true, text: '{{standing}}' },
        ],
      },
    },
    (file) => {
      const out = applyCrsUnofficialPersona(
        {
          messages: [{ role: 'user', content: 'hi' }],
        },
        { routingFile: file },
      )
      assert.ok(firstUserText(out).startsWith('<<stay terse>>'))
    },
  )
})

test('template edits are hot-read without a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-tpl-hot-'))
  const file = path.join(dir, 'routing.json')
  const write = (compat) => fs.writeFileSync(file, JSON.stringify({ compatibility: compat }))
  try {
    write({ persona_preset: 'official', overlay_preset: 'off' })
    const before = applyCrsUnofficialPersona(
      {
        messages: [{ role: 'user', content: 'hi' }],
      },
      { routingFile: file },
    )
    assert.equal(before.system[1].text, CRS_OFFICIAL_CLI_SYSTEM)
    write({ persona_preset: 'zero', overlay_preset: 'off' })
    const after = applyCrsUnofficialPersona(
      {
        messages: [{ role: 'user', content: 'hi' }],
      },
      { routingFile: file },
    )
    assert.match(after.system[0].text, /prompt_version=</)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('agent standing: default off, explicit per-preset on, and custom text replaces the default', () => {
  const caller = '你是一个高速收费员。'
  const body = () => ({ system: caller, messages: [{ role: 'user', content: 'hi' }] })
  withRoutingFile({ persona_preset: 'official', overlay_preset: 'off' }, (file) => {
    const out = applyCrsUnofficialPersona(body(), { routingFile: file })
    assert.ok(firstUserText(out).startsWith(`<system-reminder>\n${caller}\n</system-reminder>\n`))
    assert.ok(!out.system.some((block) => String(block.text).includes(DEFAULT_AGENT_STANDING)))
  })
  withRoutingFile(
    { persona_preset: 'official', overlay_preset: 'off', agent_standing_presets: { official: true } },
    (file) => {
      const out = applyCrsUnofficialPersona({ messages: [{ role: 'user', content: 'hi' }] }, { routingFile: file })
      assert.ok(out.system[2].text.startsWith(`${DEFAULT_AGENT_STANDING}\n${OFFICIAL_303_HARNESS}`))
      assert.ok(out.system[2].text.includes('You are an agent working with the user'))
    },
  )
  withRoutingFile({ persona_preset: 'official', overlay_preset: 'off' }, (file) => {
    const out = applyCrsUnofficialPersona({ messages: [{ role: 'user', content: 'hi' }] }, { routingFile: file })
    assert.equal(out.system[2].text, OFFICIAL_303_HARNESS)
    assert.equal(
      out.system.some((block) => String(block.text).startsWith('Write code that reads like the surrounding code')),
      false,
    )
  })
  withRoutingFile({ persona_preset: 'official_full', overlay_preset: 'off' }, (file) => {
    const out = applyCrsUnofficialPersona(body(), { routingFile: file })
    assert.equal(out.system[2].text, OFFICIAL_303_HARNESS)
  })
  withRoutingFile(
    { persona_preset: 'zero', agent_standing: 'Stay terse.', agent_standing_presets: { zero: true } },
    (file) => {
      const out = applyCrsUnofficialPersona(body(), { routingFile: file })
      assert.equal(out.system.length, 2)
      assert.equal(out.system[0].text.includes('Stay terse.'), false)
      assert.deepEqual(out.system.at(-1), { type: 'text', text: caller })
    },
  )
  withRoutingFile({ persona_preset: 'zero' }, (file) => {
    const out = applyCrsUnofficialPersona({ messages: [{ role: 'user', content: 'hi' }] }, { routingFile: file })
    assert.equal(out.system.length, 1)
  })
  withRoutingFile({ persona_preset: 'zero', agent_standing: '', agent_standing_presets: { zero: true } }, (file) => {
    const out = applyCrsUnofficialPersona({ messages: [{ role: 'user', content: 'hi' }] }, { routingFile: file })
    assert.equal(out.system.length, 1)
  })
})

test('each preset switch injects standing even if that template dropped the placeholder', () => {
  const zwsp = '\u200b'
  const zeroTemplate = [
    { id: 'billing_zero', type: 'text', text: '{{billing_semi}}' },
    { id: 'identity_slot', type: 'text', text: zwsp },
    { id: 'agent_slot', type: 'text', text: zwsp },
    { id: 'caller_system', type: 'text', text: '{{caller_system}}', drop_if_empty: true },
  ]
  withRoutingFile(
    {
      persona_preset: 'zero',
      agent_standing: 'Stay terse.',
      agent_standing_presets: { zero: true },
      persona_templates: { zero: zeroTemplate },
    },
    (file) => {
      const out = applyCrsUnofficialPersona({ messages: [{ role: 'user', content: 'hi' }] }, { routingFile: file })
      assert.equal(
        out.system.some((block) => String(block.text || '').startsWith('Stay terse.')),
        false,
      )
    },
  )
  withRoutingFile(
    {
      persona_preset: 'zero',
      agent_standing: 'Stay terse.',
      agent_standing_presets: { zero: false, official_full: true },
      persona_templates: { zero: zeroTemplate },
    },
    (file) => {
      const out = applyCrsUnofficialPersona({ messages: [{ role: 'user', content: 'hi' }] }, { routingFile: file })
      assert.equal(
        out.system.some((block) => String(block.text || '').includes('Stay terse.')),
        false,
      )
    },
  )
})

test('official env block goes to a role=system message and is switchable per preset', () => {
  const identity = { timezone: 'Asia/Tokyo' }
  const body = () => ({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] })
  const everything = (out) => [...out.system.map((block) => String(block.text)), ...envMessages(out)].join('\n')
  withRoutingFile({ persona_preset: 'official', overlay_preset: 'off' }, (file) => {
    const out = applyCrsUnofficialPersona(body(), { routingFile: file, identity })
    assert.match(envMessages(out)[0], /^# Environment/)
    assert.equal(
      out.system.some((block) => String(block.text).includes('# Environment')),
      false,
    )
  })
  withRoutingFile(
    { persona_preset: 'official', overlay_preset: 'off', persona_timezone_presets: { official: true } },
    (file) => {
      const out = applyCrsUnofficialPersona(body(), { routingFile: file, identity })
      assert.match(envMessages(out)[0], / - Timezone: Asia\/Tokyo/)
    },
  )
  withRoutingFile({ persona_preset: 'official', persona_env_presets: { official: false } }, (file) => {
    const out = applyCrsUnofficialPersona(body(), { routingFile: file, identity })
    assert.deepEqual(envMessages(out), [])
    assert.ok(!everything(out).includes('Asia/Tokyo'))
  })
  withRoutingFile({ persona_preset: 'official' }, (file) => {
    const out = applyCrsUnofficialPersona(body(), { routingFile: file })
    assert.equal(everything(out).includes('# Environment\n - Timezone: UTC'), false)
  })
})

test('environment opt-out removes generated blocks for every preset and preserves caller environment verbatim', () => {
  const caller = '  # Environment\n - Timezone: Pacific/Auckland\n - Caller-only fact: KEEP_ME\n '
  for (const preset of ['official', 'official_full', 'zero', 'custom']) {
    withRoutingFile(
      { persona_preset: preset, overlay_preset: 'off', persona_env_presets: { [preset]: false } },
      (file) => {
        const options = { routingFile: file, identity: { timezone: 'Asia/Tokyo' } }
        const bare = applyCrsUnofficialPersona({ messages: [{ role: 'user', content: 'hi' }] }, options)
        assert.equal(
          bare.system.some((block) => /Asia\/Tokyo/.test(block.text)),
          false,
          preset,
        )
        assert.deepEqual(envMessages(bare), [], preset)
        const supplied = applyCrsUnofficialPersona(
          { system: [{ type: 'text', text: caller }], messages: [{ role: 'user', content: 'hi' }] },
          options,
        )
        // zero keeps only billing; the other presets carry the caller text inside the first-user reminder.
        if (preset !== 'zero') {
          assert.equal(firstUserText(supplied), `<system-reminder>\n${caller.trim()}\n</system-reminder>\nhi`, preset)
        }
        assert.equal(
          supplied.system.some((block) => block.text.includes('Asia/Tokyo')),
          false,
          preset,
        )
        assert.deepEqual(envMessages(supplied), [], preset)
      },
    )
  }
})

test('disabled generated environment macros leave no empty cached block but retain literal custom environment', () => {
  const envBlocks = ['env', 'env_timezone_only', 'env_official'].map((name) => ({
    type: 'text',
    text: `{{${name}}}`,
    cache_control: { type: 'ephemeral', ttl: '1h' },
  }))
  const literal = { type: 'text', text: '# Environment\n - Timezone: Europe/Paris' }
  const vars = personaTemplateVars({ env: { timezone: 'Asia/Tokyo' }, withEnv: false })
  assert.deepEqual(renderPersonaTemplate([...envBlocks, literal], vars), [literal])
  assert.equal(vars.timezone, '')
})

test('environment opt-out keeps a caller continuation environment instead of discarding it as generated text', () => {
  const caller =
    '# Text output (does not apply to tool calls)\nCaller instructions.\n\n# Environment\n - Timezone: Pacific/Auckland\n'
  withRoutingFile(
    { persona_preset: 'official_full', overlay_preset: 'off', persona_env_presets: { official_full: false } },
    (file) => {
      const output = applyCrsUnofficialPersona(
        { system: caller, messages: [{ role: 'user', content: 'hi' }] },
        { routingFile: file, identity: { timezone: 'Asia/Tokyo' } },
      )
      assert.equal(firstUserText(output), `<system-reminder>\n${caller.trim()}\n</system-reminder>\nhi`)
      assert.equal(
        output.system.some((block) => block.text.includes('Asia/Tokyo')),
        false,
      )
      assert.deepEqual(envMessages(output), [])
    },
  )
})

test('per-preset switch maps are validated on PUT', () => {
  assert.deepEqual(
    validatePersonaRoutingPatch({
      compatibility: {
        agent_standing: 'ok',
        agent_standing_presets: { official: false, zero: true },
        persona_env_presets: { official: false },
      },
    }),
    [],
  )
  const problems = validatePersonaRoutingPatch({
    compatibility: {
      agent_standing: 7,
      agent_standing_presets: { nope: true, zero: 'no' },
      persona_env_presets: [],
    },
  })
  assert.equal(problems.length, 4)
})

test('official full can drop the env block while the opt-in timezone switch still writes timezone', () => {
  withRoutingFile(
    {
      persona_preset: 'official_full',
      overlay_preset: 'off',
      persona_guidance_presets: { official_full: true },
      persona_timezone_presets: { official_full: true },
      persona_block_presets: { official_full: { env: false } },
    },
    (file) => {
      const out = applyCrsUnofficialPersona(
        { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] },
        { routingFile: file, identity: { timezone: 'Asia/Tokyo' } },
      )
      assert.equal(
        out.system.some((block) => block.text.startsWith('Write code that reads like the surrounding code')),
        true,
      )
      assert.deepEqual(envMessages(out), [' - Timezone: Asia/Tokyo'])
    },
  )
  withRoutingFile(
    {
      persona_preset: 'official_full',
      overlay_preset: 'off',
      persona_env_presets: { official_full: false },
      persona_timezone_presets: { official_full: true },
      persona_block_presets: { official_full: { env: false } },
    },
    (file) => {
      const out = applyCrsUnofficialPersona(
        { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] },
        { routingFile: file, identity: { timezone: 'Asia/Tokyo' } },
      )
      assert.deepEqual(envMessages(out), [])
      assert.equal(
        out.system.some((block) => block.text.includes('Asia/Tokyo')),
        false,
      )
    },
  )
  assert.deepEqual(
    validatePersonaRoutingPatch({
      compatibility: { persona_block_presets: { official_full: { env_official: false } } },
    }),
    [],
  )
})

test('official preset preserves caller system verbatim in a reminder at the front of the first user turn', () => {
  const caller = '你是一个高速收费员。\n  Keep THIS exact.'
  withRoutingFile({ persona_preset: 'official', overlay_preset: 'off' }, (file) => {
    const out = applyCrsUnofficialPersona(
      { model: 'claude-opus-5-5', system: caller, messages: [{ role: 'user', content: 'hi' }] },
      { routingFile: file },
    )
    assert.equal(firstUserText(out), `<system-reminder>\n${caller.trim()}\n</system-reminder>\nhi`)
    assert.equal(
      out.system.some((block) => String(block.text).includes('高速收费员')),
      false,
    )
  })
})

test('routing persona_guidance_presets turns the 303 guidance block on; default leaves it off', () => {
  const guidance = (out) => out.system.filter((block) => String(block.text).startsWith('Write code that reads like'))
  withRoutingFile({ persona_preset: 'official_full', overlay_preset: 'off' }, (file) => {
    const out = applyCrsUnofficialPersona({ messages: [{ role: 'user', content: 'hi' }] }, { routingFile: file })
    assert.equal(guidance(out).length, 0)
  })
  withRoutingFile(
    { persona_preset: 'official_full', overlay_preset: 'off', persona_guidance_presets: { official_full: true } },
    (file) => {
      const out = applyCrsUnofficialPersona({ messages: [{ role: 'user', content: 'hi' }] }, { routingFile: file })
      const [block] = guidance(out)
      assert.equal(block?.text, renderOfficial303Guidance())
      assert.deepEqual(block.cache_control, { type: 'ephemeral', ttl: '5m' })
      assert.equal(
        out.system.indexOf(block),
        out.system.findIndex((b) => b.text === '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__') + 1,
      )
    },
  )
})

test('Environment is a role=system message only for models that accept mid-conversation system', () => {
  withRoutingFile({ persona_preset: 'official_full', overlay_preset: 'off' }, (file) => {
    for (const model of ['claude-haiku-4-5', 'claude-opus-4-6', 'claude-sonnet-4-5']) {
      const out = applyCrsUnofficialPersona(
        { model, system: 'CALLER', messages: [{ role: 'user', content: 'hi' }] },
        { routingFile: file },
      )
      assert.equal(
        out.messages.some((message) => message.role === 'system'),
        false,
        model,
      )
      assert.match(out.system.at(-1).text, /^# Environment/, model)
      assert.ok(firstUserText(out).startsWith('<system-reminder>\nCALLER\n</system-reminder>\n'), model)
    }
    for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5']) {
      const out = applyCrsUnofficialPersona(
        {
          model,
          messages: [
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
            { role: 'user', content: 'c' },
          ],
        },
        { routingFile: file },
      )
      assert.deepEqual(
        out.messages.map((message) => message.role),
        ['user', 'system', 'assistant', 'user'],
        model,
      )
      assert.match(out.messages[1].content, /^# Environment/, model)
      assert.equal(
        out.system.some((block) => String(block.text).includes('# Environment')),
        false,
        model,
      )
    }
  })
})

test('legacy rewrite Environment never adds the slot locale but keeps a caller Locale line', () => {
  const identity = { timezone: 'Asia/Tokyo', locale: 'ja_JP.UTF-8', fingerprint: { locale: 'ja_JP.UTF-8' } }
  const envTexts = (system) =>
    applyCrsUnofficialPersona(
      { model: 'claude-sonnet-5', system, messages: [{ role: 'user', content: 'hi' }] },
      { mode: 'rewrite', identity },
    )
      .system.map((block) => String(block.text))
      .filter((text) => text.startsWith('# Environment'))
  const bare = envTexts(undefined)
  assert.ok(bare.length > 0)
  assert.equal(
    bare.some((text) => text.includes('Locale:') || text.includes('ja_JP')),
    false,
  )
  const supplied = envTexts('# Environment\n - Locale: fr_FR.UTF-8\n - Timezone: Europe/Paris')
  assert.ok(supplied.some((text) => text.includes(' - Locale: fr_FR.UTF-8')))
  assert.equal(
    supplied.some((text) => text.includes('ja_JP')),
    false,
  )
})
