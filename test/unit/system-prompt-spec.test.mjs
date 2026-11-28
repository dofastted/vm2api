import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CLI_IDENTITY,
  OFFICIAL_IDENTITY_SET,
  compileSpecForCliNode,
  cragEnvFromSpec,
  isOfficialIdentityText,
  isPromptSpecV1Caps,
  resolveGlobalUnifiedPreset,
  resolveSystemPromptSpec,
  sanitizePromptSpec,
  stripOfficialIdentityBlocks,
} from '../../src/lib/identity/system-prompt-spec.mjs'
import {
  DEFAULT_PERSONA_TEMPLATES,
  isPresetEnvEnabled,
  isPresetGuidanceEnabled,
  isPresetHarnessEnabled,
  presetFlagEnabled,
  selectedTemplateBlocks,
} from '../../src/lib/identity/persona-template.mjs'
import {
  CRS_OFFICIAL_AGENT_PROMPT,
  CRS_OFFICIAL_CLI_SYSTEM,
  applyCrsUnofficialPersona,
  personaPreviewVars,
} from '../../src/lib/identity/crs-persona.mjs'
import { OFFICIAL_303_AGENT_IDENTITY, OFFICIAL_303_HARNESS } from '../../src/lib/identity/official-profiles.mjs'
import { prepareCragPrintBody, resolveCragPrintPersona } from '../../src/lib/protocol/crag-print-prompt.mjs'
import { sanitizeCragBodyWhitelist } from '../../src/lib/protocol/crag-whitelist.mjs'
import { prepareCliNodeRequest, prepareCragRequest } from '../../src/lib/protocol/kernel-request.mjs'
import { resolvePoolSystemPromptPolicy } from '../../src/lib/protocol/pool-prompt-policy.mjs'
import { resolveGlobalPromptPolicy } from '../../src/lib/scheduler/scheduler-runtime.mjs'
import { workerEnvelope } from '../../src/lib/transport/go-worker-client.mjs'
import { resolveCliSystemLayout, resolveSlotPersonaPreset } from '../../src/lib/vm/slot-engine.mjs'
import { validatePersonaRoutingPatch } from '../../src/lib/admin/panel-api.mjs'

const ALL_THREE_IDENTITIES = [
  "You are Claude Code, Anthropic's official CLI for Claude.",
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
]

function sampleBody(extra = {}) {
  return {
    model: 'claude-sonnet-5-5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'hello' }],
    ...extra,
  }
}

test('CLI_IDENTITY and OFFICIAL_IDENTITY_SET match canonical spec and strip cleanly', () => {
  assert.equal(CLI_IDENTITY, CRS_OFFICIAL_CLI_SYSTEM)
  assert.equal(OFFICIAL_IDENTITY_SET.size, 3)
  for (const text of ALL_THREE_IDENTITIES) {
    assert.equal(isOfficialIdentityText(text), true)
    assert.equal(isOfficialIdentityText(`  ${text}\n`), true)
  }
  assert.equal(isOfficialIdentityText('You are a helpful coding assistant.'), false)

  const businessA = { type: 'text', text: 'Business rule A', cache_control: { type: 'ephemeral', ttl: '1h' } }
  const businessB = { type: 'text', text: '  Keep whitespace  \n' }
  const mixed = [
    { type: 'text', text: ALL_THREE_IDENTITIES[0] },
    businessA,
    { type: 'text', text: `  ${ALL_THREE_IDENTITIES[1]}  ` },
    { type: 'text', text: ALL_THREE_IDENTITIES[2] },
    businessB,
  ]
  const stripped = stripOfficialIdentityBlocks(mixed)
  assert.deepEqual(stripped, [businessA, businessB])
})

test('SSOT precedence: pool > slot > global persona_preset > legacy fallback, canonicalizing official_303', () => {
  // Global persona_preset wins over stale legacy crag_persona_preset
  assert.equal(
    resolveGlobalUnifiedPreset({ compatibility: { persona_preset: 'official', crag_persona_preset: 'zero' } }),
    'official',
  )
  // Legacy crag_persona_preset applies ONLY when persona_preset and persona_inject are absent
  assert.equal(resolveGlobalUnifiedPreset({ compatibility: { crag_persona_preset: 'zero' } }), 'zero')
  // official_303 canonicalizes to official_full everywhere
  assert.equal(resolveGlobalUnifiedPreset({ compatibility: { persona_preset: 'official_303' } }), 'official_full')
  assert.equal(resolveSlotPersonaPreset({ persona_preset: 'official_303' }, {}), 'official_full')
  assert.equal(resolveCragPrintPersona({ persona_preset: 'official_303' }, {}), 'official_full')
  assert.equal(resolveGlobalPromptPolicy({ compatibility: { persona_preset: 'official_303' } }).preset, 'official_full')

  // Slot overrides global; CRAG and cli-node agree on unified SSOT
  const routing = { compatibility: { persona_preset: 'official', crag_persona_preset: 'zero' } }
  assert.equal(resolveCragPrintPersona({}, routing), 'official')
  assert.equal(resolveSlotPersonaPreset({}, routing), 'official')
  assert.equal(resolveCragPrintPersona({ persona_preset: 'zero' }, routing), 'zero')
  assert.equal(resolveSlotPersonaPreset({ persona_preset: 'zero' }, routing), 'zero')

  // Pool overrides slot and global, preserving Mode 1 (official) vs Mode 2 (official_full) on CRAG
  const poolOfficial = resolvePoolSystemPromptPolicy(
    { id: 'p1', provider_scope: 'anthropic', system_prompt_mode: 'official', system_prompt_preset: 'official' },
    { compatibility: { persona_preset: 'zero' } },
  )
  assert.equal(poolOfficial.cragPreset, 'official')
  assert.equal(poolOfficial.cliPreset, 'official')

  const spec = resolveSystemPromptSpec({
    routing: { compatibility: { persona_preset: 'zero' } },
    slot: { persona_preset: 'official_full' },
    poolPolicy: poolOfficial,
  })
  assert.equal(spec.mode, 'official')
  assert.equal(spec.identity.in_system, true)
  assert.equal(spec.identity.in_billing, false)
})

test('Mode 1 (official) defaults to billing + CLI_IDENTITY only, with independent section toggles', () => {
  const compat = { persona_preset: 'official' }
  assert.equal(isPresetHarnessEnabled(compat, 'official'), false)
  assert.equal(isPresetGuidanceEnabled(compat, 'official'), false)
  assert.equal(isPresetEnvEnabled(compat, 'official'), false)
  assert.equal(presetFlagEnabled(compat, 'persona_env_presets', 'official'), false)

  const specDefault = resolveSystemPromptSpec({ routing: { compatibility: compat } })
  assert.deepEqual(specDefault, {
    version: 1,
    mode: 'official',
    identity: { text: CLI_IDENTITY, in_system: true, in_billing: false },
    sections: {
      core_prompt: false,
      behavior_guidance: false,
      environment: {
        enabled: false,
        instructions: false,
        timezone: false,
        locale: false,
        model_extra: false,
        timezone_value: null,
        locale_value: null,
      },
    },
    caller_system: { policy: 'relocate_user', strip_official_identity: true },
    custom_blocks: null,
    passthrough: false,
  })

  // Render default Mode 1: ONLY [billing, CLI_IDENTITY], no harness, no guidance, no dynamic_boundary, no env, no legacy agent prompt
  const rendered = applyCrsUnofficialPersona(sampleBody(), {
    forceConfigured: true,
    routing: { compatibility: compat },
    sessionId: 'mode1-default',
    entrypoint: 'sdk-cli', // must STILL use CLI_IDENTITY, never Agent SDK identity!
  })
  assert.equal(rendered.system.length, 2)
  assert.match(rendered.system[0].text, /^x-anthropic-billing-header:/i)
  assert.equal(rendered.system[1].text, CLI_IDENTITY)
  assert.equal(
    rendered.system.some((b) => b.text.includes(OFFICIAL_303_AGENT_IDENTITY)),
    false,
  )
  assert.equal(
    rendered.system.some((b) => b.text.includes(OFFICIAL_303_HARNESS.slice(0, 40))),
    false,
  )
  assert.equal(
    rendered.system.some((b) => b.text.includes(CRS_OFFICIAL_AGENT_PROMPT.slice(0, 40))),
    false,
  )
  assert.equal(
    rendered.system.some((b) => b.text.includes('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__')),
    false,
  )
  assert.equal(
    rendered.messages.some((m) => m.role === 'system'),
    false,
  )

  // Toggle ON core_prompt (harness)
  const compatCore = { persona_preset: 'official', persona_block_presets: { official: { harness: true } } }
  assert.equal(resolveSystemPromptSpec({ routing: { compatibility: compatCore } }).sections.core_prompt, true)
  const renderedCore = applyCrsUnofficialPersona(sampleBody(), {
    forceConfigured: true,
    routing: { compatibility: compatCore },
    sessionId: 'mode1-core',
  })
  assert.equal(
    renderedCore.system.some((b) => b.text.includes(OFFICIAL_303_HARNESS.slice(0, 40))),
    true,
  )

  // Toggle ON behavior_guidance via EITHER persona_block_presets.official.guidance OR persona_guidance_presets.official (no double-gate bug!)
  for (const guidanceCompat of [
    { persona_preset: 'official', persona_block_presets: { official: { guidance: true } } },
    { persona_preset: 'official', persona_guidance_presets: { official: true } },
  ]) {
    const gSpec = resolveSystemPromptSpec({ routing: { compatibility: guidanceCompat } })
    assert.equal(gSpec.sections.behavior_guidance, true)
    const gRendered = applyCrsUnofficialPersona(sampleBody(), {
      forceConfigured: true,
      routing: { compatibility: guidanceCompat },
      sessionId: 'mode1-guidance',
    })
    assert.equal(
      gRendered.system.some((b) => b.text.includes('When you use a pronoun for someone')),
      true,
    )
    assert.equal(
      gRendered.system.some((b) => b.text === '\u200b'),
      false,
    )
  }

  // Toggle ON environment + sub-toggles (timezone, locale, instructions, model_extra)
  const compatEnv = {
    persona_preset: 'official',
    persona_env_presets: { official: true },
    persona_env_instructions_presets: { official: true },
    persona_timezone_presets: { official: true },
    persona_locale_presets: { official: true },
    model_env_extra_presets: { official: true },
  }
  const envSpec = resolveSystemPromptSpec({
    routing: { compatibility: compatEnv },
    slot: { timezone: 'Asia/Shanghai', locale: 'zh-CN' },
  })
  assert.deepEqual(envSpec.sections.environment, {
    enabled: true,
    instructions: true,
    timezone: true,
    locale: true,
    model_extra: true,
    timezone_value: 'Asia/Shanghai',
    locale_value: 'zh-CN',
  })
  assert.deepEqual(cragEnvFromSpec(envSpec), {
    timezone: 'Asia/Shanghai',
    locale: 'zh-CN',
    inject_if_missing: true,
  })
  const envRendered = applyCrsUnofficialPersona(sampleBody(), {
    forceConfigured: true,
    routing: { compatibility: compatEnv },
    identity: { timezone: 'Asia/Shanghai', locale: 'zh-CN' },
    sessionId: 'mode1-env',
  })
  const sysMsgText = envRendered.messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n')
  assert.match(sysMsgText, /# Environment/)
  assert.match(sysMsgText, /Timezone: Asia\/Shanghai/)
  assert.match(sysMsgText, /Language: zh-CN/)
})

test('Mode 2 (official_full) keeps full official CC prompt and never swaps CLI_IDENTITY on sdk-cli', () => {
  const compat = { persona_preset: 'official_full' }
  const spec = resolveSystemPromptSpec({ routing: { compatibility: compat } })
  assert.equal(spec.mode, 'official_full')
  assert.equal(spec.identity.text, CLI_IDENTITY)
  assert.equal(spec.identity.in_system, true)
  assert.equal(spec.identity.in_billing, false)
  assert.equal(spec.sections.core_prompt, true)
  assert.equal(spec.sections.behavior_guidance, false)
  assert.equal(spec.sections.environment.enabled, true)

  const rendered = applyCrsUnofficialPersona(sampleBody(), {
    forceConfigured: true,
    routing: { compatibility: compat },
    entrypoint: 'sdk-cli',
    sessionId: 'mode2-sdk',
  })
  assert.equal(rendered.system[1].text, CLI_IDENTITY)
  assert.equal(
    rendered.system.some((b) => b.text.includes(OFFICIAL_303_HARNESS.slice(0, 40))),
    true,
  )
  assert.equal(
    rendered.messages.some((m) => m.role === 'system' && String(m.content).includes('# Environment')),
    true,
  )

  // guidance enabled solely via persona_block_presets.official_full.guidance = true renders real guidance
  const gBlockOnly = applyCrsUnofficialPersona(sampleBody(), {
    forceConfigured: true,
    routing: {
      compatibility: { persona_preset: 'official_full', persona_block_presets: { official_full: { guidance: true } } },
    },
    sessionId: 'mode2-guidance-block',
  })
  assert.equal(
    gBlockOnly.system.some((b) => b.text.includes('When you use a pronoun for someone')),
    true,
  )
  assert.equal(
    gBlockOnly.system.some((b) => b.text === '\u200b'),
    false,
  )
})

test('Mode 3 (zero) strips all 3 official identities, preserves caller business blocks verbatim, and places CLI_IDENTITY in billing prompt_version', () => {
  const businessA = {
    type: 'text',
    text: 'You are my custom SQL tutor.',
    cache_control: { type: 'ephemeral', ttl: '1h' },
  }
  const businessB = { type: 'text', text: 'Always answer in JSON.' }
  const input = sampleBody({
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.303.000; cc_entrypoint=cli; cch=00000;' },
      { type: 'text', text: ALL_THREE_IDENTITIES[0] },
      businessA,
      { type: 'text', text: ALL_THREE_IDENTITIES[1] },
      { type: 'text', text: ALL_THREE_IDENTITIES[2] },
      businessB,
    ],
  })

  const spec = resolveSystemPromptSpec({
    routing: {
      compatibility: {
        persona_preset: 'zero',
        persona_timezone_presets: { zero: true },
        persona_locale_presets: { zero: true },
      },
    },
    slot: { timezone: 'Asia/Shanghai', locale: 'zh-CN' },
  })
  assert.equal(spec.mode, 'zero')
  assert.deepEqual(spec.identity, { text: CLI_IDENTITY, in_system: false, in_billing: true })
  assert.equal(spec.sections.core_prompt, false)
  assert.equal(spec.sections.behavior_guidance, false)
  assert.equal(spec.sections.environment.enabled, false)
  assert.deepEqual(spec.caller_system, { policy: 'preserve', strip_official_identity: true })
  assert.equal(cragEnvFromSpec(spec), null)

  // cli-node / HTTP render
  const rendered = applyCrsUnofficialPersona(input, {
    forceConfigured: true,
    routing: { compatibility: { persona_preset: 'zero' } },
    entrypoint: 'sdk-cli',
    sessionId: 'mode3-zero',
  })
  assert.equal(rendered.system.length, 3)
  assert.ok(
    rendered.system[0].text.endsWith(`prompt_version=<${CLI_IDENTITY}>`),
    `expected billing prompt_version=<CLI_IDENTITY>, got: ${rendered.system[0].text}`,
  )
  assert.deepEqual(rendered.system.slice(1), [businessA, businessB])
  assert.equal(
    rendered.messages.some((m) => m.role === 'system'),
    false,
  )

  // CRAG V4 with prompt_spec_v1
  const cragOut = prepareCragPrintBody(input, {
    preset: 'zero',
    promptSpec: spec,
    capabilities: ['headless_claude_bridge_v1', 'prompt_spec_v1'],
    routing: {
      compatibility: {
        persona_preset: 'zero',
        persona_timezone_presets: { zero: true },
      },
    },
    vm: { timezone: 'Asia/Shanghai' },
  })
  assert.equal(cragOut.crag_persona_preset, 'zero')
  assert.equal(cragOut.crag_prompt_version, CLI_IDENTITY)
  assert.deepEqual(cragOut.crag_prompt_spec, spec)
  assert.deepEqual(cragOut.system, [businessA, businessB])
  assert.equal('crag_env' in cragOut, false)
})

test('cli-node envelope carries top-level prompt_spec and NEVER leaks prompt_spec inside body', async () => {
  const spec = resolveSystemPromptSpec({ routing: { compatibility: { persona_preset: 'official' } } })
  const { body, promptSpec } = compileSpecForCliNode(spec, sampleBody({ prompt_spec: { leaked: true } }))
  const cleanedCliBody = prepareCliNodeRequest(body)
  assert.equal('prompt_spec' in cleanedCliBody, false)

  const { envelope } = await workerEnvelope({
    body,
    reqHeaders: {},
    exec: { vm: { id: 'vm-wrap', dataplane: 'wrap' }, workerStatus: { runtime_variant: 'cli-node' } },
    routing: { compatibility: { persona_preset: 'official', cch_enabled: false } },
    stream: true,
    cliHop: true,
    cragPrint: false,
    promptSpec,
  })
  assert.deepEqual(envelope.prompt_spec, spec)
  assert.equal('prompt_spec' in envelope.body, false)
  assert.equal('crag_prompt_spec' in envelope.body, false)
})

test('CRAG V4 prompt_spec_v1 capability detection, whitelist, and legacy CRAG fallback for Mode 1', () => {
  assert.equal(isPromptSpecV1Caps(['headless_claude_bridge_v1', 'prompt_spec_v1']), true)
  assert.equal(isPromptSpecV1Caps({ prompt_spec_v1: true }), true)
  assert.equal(isPromptSpecV1Caps(['headless_claude_bridge_v1'], { prompt_spec_v1: true }), true)
  assert.equal(isPromptSpecV1Caps(['headless_claude_bridge_v1']), false)

  const mode1Spec = resolveSystemPromptSpec({ routing: { compatibility: { persona_preset: 'official' } } })

  // Modern CRAG V4 (with prompt_spec_v1)
  const modernCrag = prepareCragPrintBody(sampleBody(), {
    preset: 'official',
    promptSpec: mode1Spec,
    capabilities: ['headless_claude_bridge_v1', 'prompt_spec_v1'],
    routing: { compatibility: { persona_preset: 'official' } },
  })
  assert.equal(modernCrag.crag_persona_preset, 'official')
  assert.deepEqual(modernCrag.crag_prompt_spec, mode1Spec)
  assert.equal('crag_env' in modernCrag, false)

  const whitelistedModern = sanitizeCragBodyWhitelist(modernCrag, {
    capabilities: ['headless_claude_bridge_v1', 'prompt_spec_v1'],
  })
  assert.equal(whitelistedModern.body.crag_persona_preset, 'official')
  assert.deepEqual(whitelistedModern.body.crag_prompt_spec, mode1Spec)

  // Legacy CRAG V4 (headless_claude_bridge_v1 WITHOUT prompt_spec_v1): Mode 1 falls back cleanly to crag_prompt replace
  const legacyCrag = prepareCragPrintBody(sampleBody(), {
    preset: 'official',
    promptSpec: mode1Spec,
    capabilities: ['headless_claude_bridge_v1'],
    routing: { compatibility: { persona_preset: 'official' } },
  })
  assert.equal('crag_prompt_spec' in legacyCrag, false)
  assert.equal('crag_persona_preset' in legacyCrag, false)
  assert.equal('crag_prompt_version' in legacyCrag, false)
  assert.deepEqual(legacyCrag.crag_prompt, {
    mode: 'replace',
    blocks: [{ type: 'text', text: CLI_IDENTITY }],
  })

  // Whitelist strips crag_prompt_spec if worker lacks prompt_spec_v1
  const whitelistedLegacy = sanitizeCragBodyWhitelist(modernCrag, {
    capabilities: ['headless_claude_bridge_v1'],
  })
  assert.equal('crag_prompt_spec' in whitelistedLegacy.body, false)
  assert.ok(whitelistedLegacy.strippedFields.includes('crag_prompt_spec'))
})

test('personaPreviewVars returns real guidance_303 and CLI_IDENTITY; validatePersonaRoutingPatch accepts all 4 presets for legacy crag_persona_preset', () => {
  const preview = personaPreviewVars({ timezone: 'Asia/Shanghai' })
  assert.equal(preview.identity, CLI_IDENTITY)
  assert.equal(preview.identity_cli, CLI_IDENTITY)
  assert.ok(preview.guidance_303.includes('When you use a pronoun for someone'))
  assert.ok(preview.main_prompt_303.includes(OFFICIAL_303_HARNESS.slice(0, 40)))

  for (const preset of ['official', 'official_full', 'zero', 'custom', '']) {
    assert.deepEqual(validatePersonaRoutingPatch({ compatibility: { crag_persona_preset: preset } }), [])
  }
  assert.ok(validatePersonaRoutingPatch({ compatibility: { crag_persona_preset: 'bogus' } }).length > 0)
  assert.equal(sanitizePromptSpec({ version: 2, mode: 'official' }), null)
  assert.equal(
    selectedTemplateBlocks(DEFAULT_PERSONA_TEMPLATES.official, {}, 'official').some(
      (b) => b.id === 'harness' || b.id === 'guidance' || b.id === 'dynamic_boundary',
    ),
    false,
  )
})

test('Cross-repo parity fixes (items 1-8): pool append/override, cli-node env dedup, custom identity, strictPassthrough, system_layout, health.prompt_spec_v1', () => {
  // Item 1: Pool append does not double-inject or mis-relocate on cli-node or CRAG V4 (prompt_spec_v1 & legacy Mode 1)
  const appendPool = resolvePoolSystemPromptPolicy(
    {
      id: 'pool_ap',
      provider_scope: 'anthropic',
      system_prompt_mode: 'append',
      system_prompt_preset: 'official',
      system_prompt_text: 'POOL_APPEND_ONCE',
    },
    { compatibility: { persona_preset: 'official' } },
  )
  const appendSpec = resolveSystemPromptSpec({
    routing: { compatibility: { persona_preset: 'official' } },
    poolPolicy: appendPool,
    relocateCallerSystem: false,
  })
  assert.equal(appendSpec.caller_system.policy, 'preserve')
  assert.deepEqual(appendSpec.custom_blocks, {
    action: 'append',
    blocks: [{ type: 'text', text: 'POOL_APPEND_ONCE', cache_control: null }],
  })
  // cli-node: when vm2api already applied pool append to hopBody.system, compileSpecForCliNode clears custom_blocks
  const cliAppendCompiled = compileSpecForCliNode(
    appendSpec,
    sampleBody({ system: [{ type: 'text', text: 'POOL_APPEND_ONCE' }] }),
    {
      poolSystemApplied: true,
    },
  )
  assert.equal(cliAppendCompiled.promptSpec.custom_blocks, null)

  // CRAG V4 prompt_spec_v1 Mode 1 & Mode 2: out.system omits pool text, crag_prompt_spec.custom_blocks carries it ONCE
  for (const mode of ['official', 'official_full']) {
    const modeAppendPool = resolvePoolSystemPromptPolicy(
      {
        id: `pool_ap_${mode}`,
        provider_scope: 'anthropic',
        system_prompt_mode: 'append',
        system_prompt_preset: mode,
        system_prompt_text: 'POOL_APPEND_ONCE',
      },
      { compatibility: { persona_preset: mode } },
    )
    const modeAppendSpec = resolveSystemPromptSpec({
      routing: { compatibility: { persona_preset: mode } },
      poolPolicy: modeAppendPool,
      relocateCallerSystem: false,
    })
    const cragV4Append = prepareCragPrintBody(sampleBody({ system: [{ type: 'text', text: CLI_IDENTITY }] }), {
      preset: mode,
      promptSpec: modeAppendSpec,
      capabilities: ['headless_claude_bridge_v1', 'prompt_spec_v1'],
      promptPolicy: modeAppendPool,
      routing: { compatibility: { persona_preset: mode } },
    })
    assert.equal(cragV4Append.system, undefined)
    assert.equal(cragV4Append.crag_persona_preset, mode)
    assert.equal(cragV4Append.crag_prompt_spec.caller_system.policy, 'preserve')
    assert.deepEqual(cragV4Append.crag_prompt_spec.custom_blocks, {
      action: 'append',
      blocks: [{ type: 'text', text: 'POOL_APPEND_ONCE', cache_control: null }],
    })
  }

  // CRAG legacy (!prompt_spec_v1) Mode 1 append: pool text is NOT relocated into messages[0] and appears ONCE in crag_prompt.blocks
  const legacyMode1Append = prepareCragPrintBody(sampleBody({ system: [{ type: 'text', text: 'CALLER_RULE' }] }), {
    preset: 'official',
    promptSpec: appendSpec,
    capabilities: ['headless_claude_bridge_v1'],
    promptPolicy: appendPool,
    routing: { compatibility: { persona_preset: 'official' } },
  })
  assert.equal('crag_prompt_spec' in legacyMode1Append, false)
  assert.equal(JSON.stringify(legacyMode1Append.messages).includes('POOL_APPEND_ONCE'), false)
  assert.equal(legacyMode1Append.crag_prompt.blocks.filter((b) => b.text === 'POOL_APPEND_ONCE').length, 1)
  assert.equal(legacyMode1Append.crag_prompt.blocks[0].text, CLI_IDENTITY)

  // Item 2: Pool override preserves merged caller system on cli-node and strips billing + all 3 official identities on CRAG V4
  const overridePool = resolvePoolSystemPromptPolicy({
    id: 'pool_ov',
    provider_scope: 'anthropic',
    system_prompt_mode: 'override',
    system_prompt_text: 'POOL_OVERRIDE_RULE',
    client_system_policy: 'prepend_pool',
  })
  const overrideSpec = resolveSystemPromptSpec({
    routing: { compatibility: { persona_preset: 'official_full' } },
    poolPolicy: overridePool,
    relocateCallerSystem: false,
  })
  const cliOverrideCompiled = compileSpecForCliNode(overrideSpec, sampleBody(), { poolSystemApplied: true })
  assert.equal(cliOverrideCompiled.promptSpec.mode, 'zero')
  assert.equal(cliOverrideCompiled.promptSpec.identity.in_billing, true)
  assert.equal(cliOverrideCompiled.promptSpec.custom_blocks, null)
  assert.equal(cliOverrideCompiled.promptSpec.caller_system.policy, 'preserve')

  // Item 2b: override + replace_client on cli-node must ALSO reset caller_system.policy to 'preserve'
  // when poolSystemApplied=true so cli-node keeps poolPolicy.text already placed in hopBody.system.
  const overrideReplacePool = resolvePoolSystemPromptPolicy({
    id: 'pool_ov_replace',
    provider_scope: 'anthropic',
    system_prompt_mode: 'override',
    system_prompt_text: 'POOL_ONLY_RULE',
    client_system_policy: 'replace_client',
  })
  const overrideReplaceSpec = resolveSystemPromptSpec({
    routing: { compatibility: { persona_preset: 'official_full' } },
    poolPolicy: overrideReplacePool,
    relocateCallerSystem: false,
  })
  assert.equal(overrideReplaceSpec.caller_system.policy, 'replace')
  const cliOverrideReplaceCompiled = compileSpecForCliNode(
    overrideReplaceSpec,
    sampleBody({ system: [{ type: 'text', text: 'POOL_ONLY_RULE' }] }),
    { poolSystemApplied: true },
  )
  assert.equal(cliOverrideReplaceCompiled.promptSpec.mode, 'zero')
  assert.equal(cliOverrideReplaceCompiled.promptSpec.identity.in_billing, true)
  assert.equal(cliOverrideReplaceCompiled.promptSpec.custom_blocks, null)
  assert.equal(cliOverrideReplaceCompiled.promptSpec.caller_system.policy, 'preserve')

  const callerBiz = { type: 'text', text: 'CALLER_BIZ', cache_control: { type: 'ephemeral', ttl: '1h' } }
  const cragOverride = prepareCragPrintBody(
    sampleBody({
      system: [
        { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.321.000; cc_entrypoint=cli; cch=00000;' },
        { type: 'text', text: ALL_THREE_IDENTITIES[0] },
        { type: 'text', text: ALL_THREE_IDENTITIES[1] },
        { type: 'text', text: ALL_THREE_IDENTITIES[2] },
        callerBiz,
      ],
    }),
    {
      preset: 'zero',
      promptSpec: overrideSpec,
      capabilities: ['headless_claude_bridge_v1', 'prompt_spec_v1'],
      promptPolicy: overridePool,
      routing: { compatibility: { persona_preset: 'official_full' } },
    },
  )
  assert.equal(cragOverride.crag_persona_preset, 'zero')
  assert.equal(cragOverride.crag_prompt_version, CLI_IDENTITY)
  assert.deepEqual(cragOverride.crag_prompt.blocks, [{ type: 'text', text: 'POOL_OVERRIDE_RULE' }, callerBiz])
  assert.deepEqual(cragOverride.crag_prompt_spec.custom_blocks, {
    action: 'replace',
    blocks: [
      { type: 'text', text: 'POOL_OVERRIDE_RULE', cache_control: null },
      { type: 'text', text: 'CALLER_BIZ', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ],
  })

  // Item 3: compileSpecForCliNode zeroes sections.environment when body already has rendered # Environment (messages or system)
  const envSpec = resolveSystemPromptSpec({
    routing: {
      compatibility: {
        persona_preset: 'official',
        persona_env_presets: { official: true },
        persona_timezone_presets: { official: true },
      },
    },
    slot: { timezone: 'Asia/Shanghai' },
  })
  assert.equal(envSpec.sections.environment.enabled, true)
  const bodyWithMidEnv = sampleBody({
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: '# Environment\n - Timezone: Asia/Shanghai' },
    ],
  })
  const compiledMidEnv = compileSpecForCliNode(envSpec, bodyWithMidEnv)
  assert.equal(compiledMidEnv.promptSpec.sections.environment.enabled, false)
  assert.equal(compiledMidEnv.promptSpec.sections.environment.timezone, false)
  assert.equal(compiledMidEnv.promptSpec.sections.environment.timezone_value, null)
  const compiledSysEnv = compileSpecForCliNode(
    envSpec,
    sampleBody({ system: [{ type: 'text', text: '# Environment\n - Timezone: Asia/Shanghai' }] }),
  )
  assert.equal(compiledSysEnv.promptSpec.sections.environment.enabled, false)
  const compiledNoEnv = compileSpecForCliNode(envSpec, sampleBody())
  assert.equal(compiledNoEnv.promptSpec.sections.environment.enabled, true)
  assert.equal(compiledNoEnv.promptSpec.sections.environment.timezone_value, 'Asia/Shanghai')

  // Item 5: Mode custom preserves user's {{identity_cli}} block (strip_official_identity: false)
  const customSpec = resolveSystemPromptSpec({ routing: { compatibility: { persona_preset: 'custom' } } })
  assert.equal(customSpec.mode, 'custom')
  assert.equal(customSpec.caller_system.strip_official_identity, false)
  assert.equal(sanitizePromptSpec({ version: 1, mode: 'custom' }).caller_system.strip_official_identity, false)

  // Item 6: strictPassthrough on CRAG V4 attaches crag_prompt_spec { passthrough: true } without mutating body
  const strictInput = sampleBody({
    system: [{ type: 'text', text: CLI_IDENTITY }],
    cache_control: { type: 'ephemeral' },
  })
  const strictV4 = prepareCragPrintBody(strictInput, {
    strictPassthrough: true,
    capabilities: ['headless_claude_bridge_v1', 'prompt_spec_v1'],
    routing: { compatibility: { persona_preset: 'zero' } },
  })
  assert.equal(strictV4.crag_prompt_spec?.passthrough, true)
  assert.deepEqual(strictV4.system, strictInput.system)
  assert.deepEqual(strictV4.cache_control, strictInput.cache_control)
  assert.equal('crag_persona_preset' in strictV4, false)
  assert.equal('crag_prompt' in strictV4, false)
  const strictPrepared = prepareCragRequest(
    strictV4,
    { capabilities: ['headless_claude_bridge_v1', 'prompt_spec_v1'] },
    { strictPassthrough: true },
  )
  assert.equal(strictPrepared.crag_prompt_spec?.passthrough, true)

  const strictLegacy = prepareCragPrintBody(strictInput, {
    strictPassthrough: true,
    capabilities: ['headless_claude_bridge_v1'],
    routing: { compatibility: { persona_preset: 'zero' } },
  })
  assert.equal('crag_prompt_spec' in strictLegacy, false)

  // Item 7: resolveCliSystemLayout returns unified layout names (never 'identity')
  assert.equal(resolveCliSystemLayout({}, { compatibility: { persona_preset: 'official' } }), 'official')
  assert.equal(resolveCliSystemLayout({}, { compatibility: { persona_preset: 'official_full' } }), 'official_full')
  assert.equal(resolveCliSystemLayout({}, { compatibility: { persona_preset: 'official_303' } }), 'official_full')
  assert.equal(resolveCliSystemLayout({}, { compatibility: { persona_preset: 'zero' } }), 'zero')
  assert.equal(resolveCliSystemLayout({}, { compatibility: { persona_preset: 'custom' } }), 'custom')

  // Item 8: prepareCragRequest & sanitizeCragBodyWhitelist honor top-level health.prompt_spec_v1 === true
  const healthFlagOnly = { capabilities: ['headless_claude_bridge_v1'], prompt_spec_v1: true }
  const specMode1 = resolveSystemPromptSpec({ routing: { compatibility: { persona_preset: 'official' } } })
  const withHealthFlag = prepareCragPrintBody(sampleBody(), {
    preset: 'official',
    promptSpec: specMode1,
    capabilities: healthFlagOnly.capabilities,
    health: healthFlagOnly,
    routing: { compatibility: { persona_preset: 'official' } },
  })
  assert.deepEqual(withHealthFlag.crag_prompt_spec, specMode1)
  const reqPrepared = prepareCragRequest(withHealthFlag, healthFlagOnly)
  assert.deepEqual(reqPrepared.crag_prompt_spec, specMode1)
  const reqWithoutFlag = prepareCragRequest(withHealthFlag, { capabilities: ['headless_claude_bridge_v1'] })
  assert.equal('crag_prompt_spec' in reqWithoutFlag, false)
})
