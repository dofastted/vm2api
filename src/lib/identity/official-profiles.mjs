/**
 * Official Claude Code outbound profiles: the reference every outbound shape is
 * compared against. Data plus small lookups only; no request mutation here.
 *
 * Named official presets use 2.1.303. Empty and legacy presets retain 2.1.296.
 */
import { createRequire } from 'node:module'
import { OFFICIAL_SLOT_CWD, officialProjectSlug, sanitizeInboundCwd } from './official-cc-system-2.1.241.mjs'
import { OFFICIAL_303_PRESET, normalizePersonaPreset } from './persona-template.mjs'

const require = createRequire(import.meta.url)
const FIXTURE_303 = require('./official-cc-system-2.1.303.json')

export { OFFICIAL_303_PRESET }

export const OFFICIAL_303_IDENTITY = FIXTURE_303.identity_cli
/** Starts with `\n`, exactly as captured. `{{memory_dir}}` is filled per slot. */
export const OFFICIAL_303_MAIN_PROMPT = FIXTURE_303.main_prompt
export const OFFICIAL_303_ENV_INTRO = FIXTURE_303.environment_intro
export const OFFICIAL_303_ENV_UNTRUSTED = FIXTURE_303.environment_untrusted

export const OFFICIAL_PROFILES = Object.freeze({
  '2.1.303': Object.freeze({
    cliVersion: FIXTURE_303.meta.cli_version,
    stainlessPackageVersion: FIXTURE_303.meta.stainless_package_version,
    buildTime: FIXTURE_303.meta.build_time,
    gitSha: FIXTURE_303.meta.git_sha,
    topLevelOrder: Object.freeze([
      'model',
      'messages',
      'system',
      'tools',
      'metadata',
      'max_tokens',
      'thinking',
      'output_config',
      'stream',
    ]),
    system: Object.freeze([
      Object.freeze({ slot: 'billing', cache: false }),
      Object.freeze({ slot: 'identity', cache: true }),
      Object.freeze({ slot: 'main', cache: true }),
    ]),
    messages: Object.freeze({
      reminder: 'first_user_head',
      marker: 'last_two_users',
      environment: 'tail_system_message',
    }),
    environmentFallback: 'merge_into_main',
    maxMarkers: 4,
    ttlSource: 'panel',
    autoFill: Object.freeze([]),
  }),
  '2.1.296': Object.freeze({
    cliVersion: '2.1.296',
    stainlessPackageVersion: '0.128.0',
    system: Object.freeze([
      Object.freeze({ slot: 'billing', cache: false }),
      Object.freeze({ slot: 'identity', cache: true }),
      Object.freeze({ slot: 'caller', cache: true }),
    ]),
    messages: Object.freeze({
      reminder: 'caller',
      marker: 'last_user',
      environment: 'caller',
    }),
    ttlSource: 'request',
  }),
})

export function profileForPreset(preset) {
  const raw = String(preset ?? '')
    .trim()
    .toLowerCase()
  if (
    raw === 'official' ||
    raw === 'official_full' ||
    raw === 'official_303' ||
    raw === '303' ||
    raw === 'official-303'
  )
    return OFFICIAL_PROFILES['2.1.303']
  return OFFICIAL_PROFILES['2.1.296']
}

/** Proxy prefixes (`test-pro/`), `[1m]` and date suffixes do not change the official model id. */
export function canonicalPromptModel(model = '') {
  let id = String(model || '')
    .trim()
    .toLowerCase()
  const slash = id.lastIndexOf('/')
  if (slash >= 0) id = id.slice(slash + 1)
  id = id.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '')
  if (id === 'claude-opus-4') return 'claude-opus-4-0'
  return id
}

const FULL_PROMPT_OPUS = new Set([
  'claude-opus-4-0',
  'claude-opus-4-1',
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
])

/**
 * Official 2.1.303 `he(model)`: Sonnet, Haiku, Claude 3 and Opus 4.0–4.7 keep the
 * full prompt; Mythos 5 and every other model get the lean prompt. Remote flags,
 * client data and CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT are not replicated.
 */
export function officialPromptShape(model = '') {
  const id = canonicalPromptModel(model)
  if (!id) return 'full'
  if (id === 'claude-mythos-5') return 'lean'
  if (id.includes('claude-3-') || id.includes('haiku') || id.includes('sonnet') || FULL_PROMPT_OPUS.has(id)) {
    return 'full'
  }
  return 'lean'
}

/** 2.1.303 model catalog entries for lean models (display_name, knowledge_cutoff). */
const LEAN_MODEL_CATALOG = Object.freeze({
  'claude-opus-4-8': ['Opus 4.8', 'January 2026'],
  'claude-opus-5': ['Opus 5', 'May 2026'],
  'claude-opus-5-5': ['Opus 5.5', 'June 2026'],
  'claude-fable-5': ['Fable 5', 'January 2026'],
  'claude-fable-5-1': ['Fable 5.1', 'June 2026'],
  'claude-mythos-5': ['Mythos 5', 'January 2026'],
  'claude-mythos-5-1': ['Mythos 5.1', 'June 2026'],
})

/** Official `SZn` + `bZn`: unknown models name the id only and omit the cutoff. */
export function officialModelLine(model = '', { oneM = false } = {}) {
  const id = canonicalPromptModel(model)
  const exact = `${id}${oneM ? '[1m]' : ''}`
  const entry = LEAN_MODEL_CATALOG[id]
  if (!entry) return `You are powered by the model ${exact}.`
  const [name, cutoff] = entry
  return `You are powered by the model named ${name}${oneM ? ' (1M context)' : ''}. The exact model ID is ${exact}. Assistant knowledge cutoff is ${cutoff}.`
}

/** Memory lives under the slot user's home, bucketed by the working directory (official `~/.claude/projects/<slug>/memory/`). */
export function renderOfficial303MainPrompt({ cwd = '' } = {}) {
  const slug = officialProjectSlug(sanitizeInboundCwd(cwd) || OFFICIAL_SLOT_CWD)
  return OFFICIAL_303_MAIN_PROMPT.replace('{{memory_dir}}', `${OFFICIAL_SLOT_CWD}/.claude/projects/${slug}/memory/`)
}

/**
 * 2.1.303 `# Environment` section. `env` is `officialSystemEnvFromIdentity(..., { overwrite: true })`:
 * caller facts first, slot workstation profile for what the caller did not say.
 * No timezone line: 2.1.303 does not write one.
 */
export function buildOfficial303Environment(env = {}, { model = '', oneM = false } = {}) {
  const os = String(env.osVersion || '').trim() || (env.kernel ? `Linux ${env.kernel}` : '')
  const lines = [
    '# Environment',
    OFFICIAL_303_ENV_INTRO,
    ` - Primary working directory: ${sanitizeInboundCwd(env.cwd) || OFFICIAL_SLOT_CWD}`,
    ` - Is a git repository: ${env.git === true ? 'true' : 'false'}`,
    ` - Platform: ${String(env.platform || '').trim() || 'linux'}`,
    ` - Shell: ${String(env.shell || '').trim() || 'bash'}`,
  ]
  if (os) lines.push(` - OS Version: ${os}`)
  lines.push(OFFICIAL_303_ENV_UNTRUSTED)
  return `${lines.join('\n')}\n\n${officialModelLine(model || env.modelId, { oneM })}`
}

const BILLING_RE = /^\s*x-anthropic-billing-header:/i
const IDENTITY_TEXTS = new Set([
  "You are Claude Code, Anthropic's official CLI for Claude.",
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
])

export function isOfficialIdentityText(text) {
  return IDENTITY_TEXTS.has(String(text || '').trim())
}

export function isBillingText(text) {
  return BILLING_RE.test(String(text || ''))
}

/** Category only. Used by the shape tool; never by assembly. */
export function classifySystemText(text) {
  const t = String(text || '')
  if (isBillingText(t)) return 'billing'
  if (isOfficialIdentityText(t)) return 'identity'
  if (t.trimStart().startsWith('# Environment')) return 'env'
  if (t.includes('You are an agent working with the user toward their goals')) return 'main'
  if (t.includes('You are an interactive agent that helps users')) return 'main_full'
  if (t.trimStart().startsWith('# Reporting outcomes')) return 'reporting'
  return 'other'
}
