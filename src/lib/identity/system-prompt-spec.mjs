/**
 * Unified System Prompt SSOT & Canonical Abstract Prompt IR (`prompt_spec` v1).
 *
 * Single authoritative resolver for Claude system prompt policy across:
 *   - `cli-node` (free kernel via top-level `envelope.prompt_spec`)
 *   - `CRAG V4` (via `body.crag_prompt_spec` + backward-compatible `crag_*` fields)
 *   - Direct HTTP OAuth / API execution paths
 *
 * Precedence (strict):
 *   1. Explicit Anthropic pool policy (`poolPolicy.applies === true`, M1b)
 *   2. Explicit slot override (`slot.persona_preset`)
 *   3. Global `routing.compatibility.persona_preset` (SSOT)
 *   4. Legacy fallback ONLY when `persona_preset` is absent/empty:
 *      `compatibility.persona_inject` -> `compatibility.crag_persona_preset`
 *   5. Default: `'official_full'`
 */
import {
  CLI_IDENTITY,
  DEFAULT_PERSONA_PRESET,
  OFFICIAL_303_PRESET,
  OFFICIAL_IDENTITY_SET,
  canonicalPersonaCompat,
  isOfficialIdentityText,
  isPresetEnvEnabled,
  isPresetGuidanceEnabled,
  isPresetHarnessEnabled,
  normalizePersonaPreset,
  personaPresetFromLegacyMode,
  presetFlagEnabled,
  stripOfficialIdentityBlocks,
} from './persona-template.mjs'
import { validTimezone } from '../core/timezone.mjs'

export { CLI_IDENTITY, OFFICIAL_IDENTITY_SET, isOfficialIdentityText, stripOfficialIdentityBlocks }

export const PROMPT_SPEC_VERSION = 1
export const PROMPT_SPEC_MODES = Object.freeze(['official', 'official_full', 'zero', 'custom'])
export const CALLER_SYSTEM_POLICIES = Object.freeze(['preserve', 'relocate_user', 'replace'])

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Capability detector supporting both CRAG's JSON array contract
 * (`capabilities: [..., "prompt_spec_v1"]` / `health.prompt_spec_v1 === true`)
 * and object map form (`capabilities: { prompt_spec_v1: true }`).
 */
export function isPromptSpecV1Caps(capabilities, health = null) {
  if (Array.isArray(capabilities) && capabilities.includes('prompt_spec_v1')) return true
  if (isPlainObject(capabilities) && capabilities.prompt_spec_v1 === true) return true
  if (Array.isArray(health?.capabilities) && health.capabilities.includes('prompt_spec_v1')) return true
  if (isPlainObject(health?.capabilities) && health.capabilities.prompt_spec_v1 === true) return true
  if (health?.prompt_spec_v1 === true) return true
  return false
}

/** Canonicalize any preset string (`official_303` -> `official_full`). */
export function normalizeUnifiedPreset(value, fallback = DEFAULT_PERSONA_PRESET) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
  if (!raw || raw === 'inherit' || raw === 'global' || raw === 'default') return fallback
  if (raw === 'official_full' || raw === 'full' || raw === 'agent_official') return 'official_full'
  if (
    raw === 'official' ||
    raw === 'official_prompt' ||
    raw === 'prompt' ||
    raw === 'agent_prompt' ||
    raw === 'cc_prompt'
  ) {
    return 'official'
  }
  if (raw === 'zero' || raw === 'zero_inject' || raw === '0' || raw === '0inject' || raw === '0-inject') {
    return 'zero'
  }
  if (raw === 'custom' || raw === 'diy' || raw === 'manual') return 'custom'
  if (raw === OFFICIAL_303_PRESET || raw === '303' || raw === 'official-303') return 'official_full'
  return fallback
}

function explicitSlotPreset(slot) {
  if (!slot || typeof slot !== 'object') return null
  return normalizeUnifiedPreset(slot.persona_preset, null)
}

/**
 * Resolve the single effective global Claude preset from `routing.compatibility`.
 * `persona_preset` is SSOT; `persona_inject` and legacy `crag_persona_preset`
 * are consulted ONLY when `persona_preset` is absent/empty.
 */
export function resolveGlobalUnifiedPreset(routing = {}) {
  const compat = canonicalPersonaCompat(routing?.compatibility || {})
  const rawPersona = String(compat?.persona_preset ?? '').trim()
  if (rawPersona) return normalizeUnifiedPreset(rawPersona, DEFAULT_PERSONA_PRESET)
  const rawInject = String(compat?.persona_inject ?? '').trim()
  if (rawInject) return normalizeUnifiedPreset(personaPresetFromLegacyMode(rawInject), DEFAULT_PERSONA_PRESET)
  const rawLegacyCrag = String(compat?.crag_persona_preset ?? '').trim()
  if (rawLegacyCrag) return normalizeUnifiedPreset(rawLegacyCrag, DEFAULT_PERSONA_PRESET)
  return DEFAULT_PERSONA_PRESET
}

/**
 * Resolve unified preset with full SSOT precedence:
 *   poolPolicy (M1b) > explicit slot override > global `compatibility.persona_preset` > legacy fallback.
 */
export function resolveUnifiedPreset({ routing = {}, slot = null, poolPolicy = null, modeOverride = null } = {}) {
  if (poolPolicy?.applies) {
    if (poolPolicy.mode === 'passthrough') {
      return { mode: 'official_full', preset: null, source: 'pool', passthrough: true, poolMode: 'passthrough' }
    }
    if (poolPolicy.mode === 'zero_inject') {
      return { mode: 'zero', preset: 'zero', source: 'pool', passthrough: false, poolMode: 'zero_inject' }
    }
    if (poolPolicy.mode === 'override') {
      return { mode: 'zero', preset: 'zero', source: 'pool', passthrough: false, poolMode: 'override' }
    }
    if (poolPolicy.mode === 'official' || poolPolicy.mode === 'append') {
      const preset = normalizeUnifiedPreset(poolPolicy.preset, 'official_full')
      return { mode: preset, preset, source: 'pool', passthrough: false, poolMode: poolPolicy.mode }
    }
  }
  const fromOverride = modeOverride ? normalizeUnifiedPreset(modeOverride, null) : null
  if (fromOverride) {
    return { mode: fromOverride, preset: fromOverride, source: 'slot', passthrough: false, poolMode: null }
  }
  const fromSlot = explicitSlotPreset(slot)
  if (fromSlot) {
    return { mode: fromSlot, preset: fromSlot, source: 'slot', passthrough: false, poolMode: null }
  }
  const fromGlobal = resolveGlobalUnifiedPreset(routing)
  return { mode: fromGlobal, preset: fromGlobal, source: 'global', passthrough: false, poolMode: null }
}

function emptyEnvironmentSections() {
  return {
    enabled: false,
    instructions: false,
    timezone: false,
    locale: false,
    model_extra: false,
    timezone_value: null,
    locale_value: null,
  }
}

function resolveLocaleValue(slot, identity) {
  const raw = String(
    slot?.locale || slot?.fingerprint?.locale || identity?.locale || identity?.fingerprint?.locale || '',
  ).trim()
  return raw || null
}

function resolveTimezoneValue(slot, identity) {
  for (const candidate of [
    slot?.timezone,
    slot?.fingerprint?.timezone,
    identity?.timezone,
    identity?.fingerprint?.timezone,
  ]) {
    const valid = validTimezone(candidate)
    if (valid) return valid
  }
  return null
}

function normalizeCustomBlocksPayload(customBlocks) {
  if (!isPlainObject(customBlocks)) return null
  const action = customBlocks.action === 'append' ? 'append' : customBlocks.action === 'replace' ? 'replace' : null
  if (!action) return null
  const rawList = Array.isArray(customBlocks.blocks) ? customBlocks.blocks : []
  const blocks = []
  for (const item of rawList) {
    if (!isPlainObject(item) || typeof item.text !== 'string') continue
    const block = {
      type: 'text',
      text: item.text,
      cache_control: isPlainObject(item.cache_control) ? { ...item.cache_control } : null,
    }
    blocks.push(block)
  }
  return { action, blocks }
}

/**
 * Resolve the Canonical Abstract Prompt IR (`prompt_spec`, v1, snake_case JSON).
 */
export function resolveSystemPromptSpec({
  routing = {},
  slot = null,
  poolPolicy = null,
  identity = null,
  officialPassthrough = false,
  strictPassthrough = false,
  modeOverride = null,
  relocateCallerSystem = true,
  customBlocks = null,
} = {}) {
  const compat = canonicalPersonaCompat(routing?.compatibility || {})
  const chosen = resolveUnifiedPreset({ routing, slot, poolPolicy, modeOverride })

  // Pool non-official policies (`zero_inject` / `override` / `append` / `passthrough`) take precedence
  // over global officialPassthrough / strictPassthrough.
  const effectiveOfficialPassthrough =
    poolPolicy?.applies && poolPolicy.mode !== 'official' ? false : officialPassthrough === true
  const effectiveStrictPassthrough =
    poolPolicy?.applies && poolPolicy.mode !== 'official' && poolPolicy.mode !== 'passthrough'
      ? false
      : strictPassthrough === true

  if (effectiveStrictPassthrough || chosen.passthrough || effectiveOfficialPassthrough) {
    return {
      version: PROMPT_SPEC_VERSION,
      mode: chosen.mode || 'official_full',
      identity: {
        text: CLI_IDENTITY,
        in_system: false,
        in_billing: false,
      },
      sections: {
        core_prompt: false,
        behavior_guidance: false,
        environment: emptyEnvironmentSections(),
      },
      caller_system: {
        policy: 'preserve',
        strip_official_identity: false,
      },
      custom_blocks: null,
      passthrough: true,
    }
  }

  // Pool override: billing carries prompt_version=CLI_IDENTITY; caller/pool blocks replace system.
  if (chosen.poolMode === 'override') {
    const clientPolicy = String(poolPolicy?.clientSystemPolicy || 'prepend_pool')
      .trim()
      .toLowerCase()
    const normalizedCustom = normalizeCustomBlocksPayload(customBlocks)
    return {
      version: PROMPT_SPEC_VERSION,
      mode: 'zero',
      identity: {
        text: CLI_IDENTITY,
        in_system: false,
        in_billing: true,
      },
      sections: {
        core_prompt: false,
        behavior_guidance: false,
        environment: emptyEnvironmentSections(),
      },
      caller_system: {
        policy: clientPolicy === 'replace_client' ? 'replace' : 'preserve',
        strip_official_identity: true,
      },
      custom_blocks:
        normalizedCustom ||
        (typeof poolPolicy?.text === 'string' && poolPolicy.text
          ? {
              action: 'replace',
              blocks: [{ type: 'text', text: poolPolicy.text, cache_control: null }],
            }
          : { action: 'replace', blocks: [] }),
      passthrough: false,
    }
  }

  // Mode 3 (`zero` / pool `zero_inject`):
  // Strip all official system prompts (including all 3 identity strings) from system[],
  // put CLI_IDENTITY into billing prompt_version, zero sections, preserve caller business system verbatim.
  if (chosen.mode === 'zero') {
    return {
      version: PROMPT_SPEC_VERSION,
      mode: 'zero',
      identity: {
        text: CLI_IDENTITY,
        in_system: false,
        in_billing: true,
      },
      sections: {
        core_prompt: false,
        behavior_guidance: false,
        environment: emptyEnvironmentSections(),
      },
      caller_system: {
        policy: 'preserve',
        strip_official_identity: true,
      },
      custom_blocks: normalizeCustomBlocksPayload(customBlocks),
      passthrough: false,
    }
  }

  // Mode `custom`: user-defined template blocks compiled by vm2api SSOT.
  if (chosen.mode === 'custom') {
    const normalizedCustom = normalizeCustomBlocksPayload(customBlocks)
    return {
      version: PROMPT_SPEC_VERSION,
      mode: 'custom',
      identity: {
        text: CLI_IDENTITY,
        in_system: false,
        in_billing: false,
      },
      sections: {
        core_prompt: false,
        behavior_guidance: false,
        environment: emptyEnvironmentSections(),
      },
      caller_system: {
        policy: relocateCallerSystem ? 'relocate_user' : 'preserve',
        strip_official_identity: false,
      },
      custom_blocks: normalizedCustom,
      passthrough: false,
    }
  }

  // Mode 1 (`official`) and Mode 2 (`official_full`):
  const mode = chosen.mode === 'official' ? 'official' : 'official_full'
  const corePrompt = isPresetHarnessEnabled(compat, mode)
  const behaviorGuidance = isPresetGuidanceEnabled(compat, mode)
  const envEnabled = isPresetEnvEnabled(compat, mode)
  const envInstructions = envEnabled && presetFlagEnabled(compat, 'persona_env_instructions_presets', mode)
  const envTimezone = envEnabled && presetFlagEnabled(compat, 'persona_timezone_presets', mode)
  const envLocale = envEnabled && presetFlagEnabled(compat, 'persona_locale_presets', mode)
  const envModelExtra = envEnabled && presetFlagEnabled(compat, 'model_env_extra_presets', mode)
  const tzValue = envTimezone ? resolveTimezoneValue(slot, identity) : null
  const localeValue = envLocale ? resolveLocaleValue(slot, identity) : null

  let resolvedCustomBlocks = normalizeCustomBlocksPayload(customBlocks)
  if (
    !resolvedCustomBlocks &&
    chosen.poolMode === 'append' &&
    typeof poolPolicy?.text === 'string' &&
    poolPolicy.text
  ) {
    resolvedCustomBlocks = {
      action: 'append',
      blocks: [{ type: 'text', text: poolPolicy.text, cache_control: null }],
    }
  }

  return {
    version: PROMPT_SPEC_VERSION,
    mode,
    identity: {
      text: CLI_IDENTITY,
      in_system: true,
      in_billing: false,
    },
    sections: {
      core_prompt: corePrompt,
      behavior_guidance: behaviorGuidance,
      environment: {
        enabled: envEnabled,
        instructions: envInstructions,
        timezone: envTimezone,
        locale: envLocale,
        model_extra: envModelExtra,
        timezone_value: tzValue,
        locale_value: localeValue,
      },
    },
    caller_system: {
      policy: relocateCallerSystem ? 'relocate_user' : 'preserve',
      strip_official_identity: true,
    },
    custom_blocks: resolvedCustomBlocks,
    passthrough: false,
  }
}

function cleanShortString(value, maxLen = 256) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLen || /[\r\n\0]/.test(trimmed)) return null
  return trimmed
}

/**
 * Strict schema sanitizer for `prompt_spec` v1 (used at both `crag_prompt_spec`
 * whitelist and `workerEnvelope.prompt_spec` boundaries). Returns `null` if invalid.
 */
export function sanitizePromptSpec(raw) {
  if (!isPlainObject(raw)) return null
  const version = Number(raw.version)
  if (version !== PROMPT_SPEC_VERSION) return null
  const mode = String(raw.mode ?? '')
    .trim()
    .toLowerCase()
  if (!PROMPT_SPEC_MODES.includes(mode)) return null

  const rawId = isPlainObject(raw.identity) ? raw.identity : {}
  const cleanedIdText = cleanShortString(rawId.text, 512) || CLI_IDENTITY
  const idText = mode !== 'custom' && isOfficialIdentityText(cleanedIdText) ? CLI_IDENTITY : cleanedIdText
  const rawSections = isPlainObject(raw.sections) ? raw.sections : {}
  const rawEnv = isPlainObject(rawSections.environment) ? rawSections.environment : {}
  const envEnabled = rawEnv.enabled === true
  const envTimezone = envEnabled && rawEnv.timezone === true
  const envLocale = envEnabled && rawEnv.locale === true

  const rawCaller = isPlainObject(raw.caller_system) ? raw.caller_system : {}
  const policyRaw = String(rawCaller.policy ?? 'preserve')
    .trim()
    .toLowerCase()
  const policy = CALLER_SYSTEM_POLICIES.includes(policyRaw) ? policyRaw : 'preserve'

  let customBlocks = null
  if (isPlainObject(raw.custom_blocks)) {
    const action = raw.custom_blocks.action
    if (action === 'append' || action === 'replace') {
      const list = Array.isArray(raw.custom_blocks.blocks) ? raw.custom_blocks.blocks : []
      const cleanBlocks = []
      for (const entry of list.slice(0, 64)) {
        if (!isPlainObject(entry) || typeof entry.text !== 'string') continue
        let cc = null
        if (isPlainObject(entry.cache_control) && entry.cache_control.type === 'ephemeral') {
          cc = { type: 'ephemeral' }
          if (entry.cache_control.ttl === '5m' || entry.cache_control.ttl === '1h') {
            cc.ttl = entry.cache_control.ttl
          }
          if (entry.cache_control.scope === 'global' || entry.cache_control.scope === 'org') {
            cc.scope = entry.cache_control.scope
          }
        }
        cleanBlocks.push({
          type: 'text',
          text: entry.text,
          cache_control: cc,
        })
      }
      customBlocks = { action, blocks: cleanBlocks }
    }
  }

  return {
    version: PROMPT_SPEC_VERSION,
    mode,
    identity: {
      text: idText,
      in_system: rawId.in_system === true,
      in_billing: rawId.in_billing === true,
    },
    sections: {
      core_prompt: rawSections.core_prompt === true,
      behavior_guidance: rawSections.behavior_guidance === true,
      environment: {
        enabled: envEnabled,
        instructions: envEnabled && rawEnv.instructions === true,
        timezone: envTimezone,
        locale: envLocale,
        model_extra: envEnabled && rawEnv.model_extra === true,
        timezone_value: envTimezone ? cleanShortString(rawEnv.timezone_value, 128) : null,
        locale_value: envLocale ? cleanShortString(rawEnv.locale_value, 64) : null,
      },
    },
    caller_system: {
      policy,
      strip_official_identity:
        rawCaller.strip_official_identity === undefined
          ? mode !== 'custom'
          : rawCaller.strip_official_identity !== false,
    },
    custom_blocks: customBlocks,
    passthrough: raw.passthrough === true,
  }
}

function textContainsEnvironmentSection(text) {
  return /(?:^|\n)[ \t]*# Environment\b/i.test(String(text || ''))
}

function bodyHasRenderedEnvironment(body) {
  if (!body || typeof body !== 'object') return false
  if (typeof body.system === 'string' && textContainsEnvironmentSection(body.system)) return true
  if (Array.isArray(body.system)) {
    for (const block of body.system) {
      const text = typeof block === 'string' ? block : typeof block?.text === 'string' ? block.text : ''
      if (textContainsEnvironmentSection(text)) return true
    }
  }
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (message?.role !== 'system') continue
      if (typeof message.content === 'string' && textContainsEnvironmentSection(message.content)) return true
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          const text = typeof block === 'string' ? block : typeof block?.text === 'string' ? block.text : ''
          if (textContainsEnvironmentSection(text)) return true
        }
      }
    }
  }
  return false
}

/**
 * Compile resolved `SystemPromptSpec` for `cli-node` (free kernel).
 * Never mutates or embeds `prompt_spec` inside `body`; returns `{ body, promptSpec }`
 * so transport attaches `promptSpec` at top-level `envelope.prompt_spec`.
 *
 * - When `poolSystemApplied` is true (`append`/`override` already merged into `body.system`
 *   by `vm2api`), clears `custom_blocks` so `cli-node` neither double-appends nor wipes
 *   merged caller blocks.
 * - When `body` already carries a rendered `# Environment` block (in `messages` as
 *   `role: 'system'` or in `system[]`), zeroes `sections.environment` so `cli-node` does
 *   not push a duplicate `# Environment` into `system[]` ahead of `harness`.
 */
export function compileSpecForCliNode(spec, body, { poolSystemApplied = false } = {}) {
  const cleanSpec = sanitizePromptSpec(spec)
  if (!cleanSpec) return { body, promptSpec: null }
  let nextSpec = cleanSpec
  if (poolSystemApplied) {
    nextSpec = {
      ...nextSpec,
      custom_blocks: null,
      caller_system: {
        ...nextSpec.caller_system,
        policy: 'preserve',
      },
    }
  }
  if (nextSpec.sections?.environment?.enabled && bodyHasRenderedEnvironment(body)) {
    nextSpec = {
      ...nextSpec,
      sections: {
        ...nextSpec.sections,
        environment: emptyEnvironmentSections(),
      },
    }
  }
  return {
    body,
    promptSpec: nextSpec,
  }
}

/**
 * Derive `crag_env` strictly from `spec.sections.environment` (returns `null` when
 * environment injection is disabled, passthrough, zero, or override).
 */
export function cragEnvFromSpec(spec) {
  if (!spec || spec.passthrough === true) return null
  const env = spec.sections?.environment
  if (!env || env.enabled !== true) return null
  const tz = env.timezone && env.timezone_value ? env.timezone_value : ''
  const loc = env.locale && env.locale_value ? env.locale_value : ''
  if (!tz && !loc) return null
  return {
    ...(tz ? { timezone: tz } : {}),
    ...(loc ? { locale: loc } : {}),
    inject_if_missing: true,
  }
}
