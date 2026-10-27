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
export const OFFICIAL_303_AGENT_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK."
/** Harness ends before guidance. `{{memory_dir}}` lives in guidance and is filled per slot. */
export const OFFICIAL_303_HARNESS = FIXTURE_303.harness
export const OFFICIAL_303_GUIDANCE = FIXTURE_303.guidance
/** Harness plus guidance, the previous single main block. */
export const OFFICIAL_303_MAIN_PROMPT = `${OFFICIAL_303_HARNESS}${OFFICIAL_303_GUIDANCE}`
export const OFFICIAL_303_ENV_INTRO = FIXTURE_303.environment_intro
export const OFFICIAL_303_ENV_UNTRUSTED = FIXTURE_303.environment_untrusted
export const OFFICIAL_303_ENV_INSTRUCTIONS = FIXTURE_303.environment_instructions
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
      Object.freeze({ slot: 'identity', cache: false }),
      Object.freeze({ slot: 'harness', cache: true, scope: 'global' }),
      Object.freeze({ slot: 'guidance', cache: true }),
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
    raw === 'official-303' ||
    raw === 'zero'
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

/** 2.1.303 catalog (display_name, knowledge_cutoff). Full-prompt models still get this sentence. */
const MODEL_SENTENCE_CATALOG = Object.freeze({
  'claude-3-5-haiku': ['Haiku 3.5', 'February 2025'],
  'claude-haiku-4': ['Haiku 4.5', 'February 2025'],
  'claude-haiku-4-5': ['Haiku 4.5', 'February 2025'],
  'claude-haiku-5-5': ['Haiku 5.5', 'June 2026'],
  'claude-3-5-sonnet': ['Sonnet 3.5', 'January 2025'],
  'claude-3-7-sonnet': ['Sonnet 3.7', 'January 2025'],
  'claude-sonnet-4': ['Sonnet 4', 'January 2025'],
  'claude-sonnet-4-5': ['Sonnet 4.5', 'January 2025'],
  'claude-sonnet-4-6': ['Sonnet 4.6', 'August 2025'],
  'claude-sonnet-5': ['Sonnet 5', 'January 2026'],
  'claude-sonnet-5-5': ['Sonnet 5.5', 'June 2026'],
  'claude-opus-4-0': ['Opus 4', 'January 2025'],
  'claude-opus-4-1': ['Opus 4.1', 'January 2025'],
  'claude-opus-4-5': ['Opus 4.5', 'May 2025'],
  'claude-opus-4-6': ['Opus 4.6', 'May 2025'],
  'claude-opus-4-7': ['Opus 4.7', 'January 2026'],
  'claude-opus-4-8': ['Opus 4.8', 'January 2026'],
  'claude-opus-5': ['Opus 5', 'May 2026'],
  'claude-opus-5-5': ['Opus 5.5', 'June 2026'],
  'claude-fable-5': ['Fable 5', 'January 2026'],
  'claude-fable-5-1': ['Fable 5.1', 'June 2026'],
  'claude-mythos-5': ['Mythos 5', 'January 2026'],
  'claude-mythos-5-1': ['Mythos 5.1', 'June 2026'],
})

/** Official runtime sentence. `auto` names the selector and omits the cutoff. Unknown ids do the same. */
export function officialModelLine(model = '', { oneM = false } = {}) {
  const raw = canonicalPromptModel(model)
  if (raw === 'auto') return 'You are powered by the model auto.'
  const exact = `${raw}${oneM ? '[1m]' : ''}`
  const entry = MODEL_SENTENCE_CATALOG[raw]
  if (!entry) return `You are powered by the model ${exact}.`
  const [name, cutoff] = entry
  return `You are powered by the model named ${name}${oneM ? ' (1M context)' : ''}. The exact model ID is ${exact}. Assistant knowledge cutoff is ${cutoff}.`
}

/** Memory lives under the slot user's home, bucketed by the working directory (official `~/.claude/projects/<slug>/memory/`). */
const INTERACTIVE_GUIDANCE_BULLET =
  ' - If you need the user to run a shell command themselves (e.g., an interactive login like `gcloud auth login`), suggest they type `! <command>` in the prompt \u2014 the `!` prefix runs the command in this session so its output lands directly in the conversation.\n'

/** `cli` keeps the interactive `!` bullet. `sdk-cli` is the --print capture and drops it. */
export function renderOfficial303Guidance({ cwd = '', entrypoint = 'sdk-cli' } = {}) {
  const home = sanitizeInboundCwd(cwd)
  const slug = officialProjectSlug(home)
  let text = OFFICIAL_303_GUIDANCE
  if (home && slug) text = text.replace('{{memory_dir}}', `${home}/.claude/projects/${slug}/memory/`)
  else text = text.replace(/\n# Memory\n[\s\S]*?(?=\n# Environment\n)/, '')
  if (entrypoint !== 'cli') text = text.replace(INTERACTIVE_GUIDANCE_BULLET, '')
  return text
}

export function renderOfficial303MainPrompt({ cwd = '', entrypoint = 'sdk-cli' } = {}) {
  return `${OFFICIAL_303_HARNESS}${renderOfficial303Guidance({ cwd, entrypoint })}`
}

/**
 * 2.1.303 `# Environment` section. `env` is `officialSystemEnvFromIdentity(..., { overwrite: true })`:
 * caller facts first, slot workstation profile for what the caller did not say.
 * No timezone line: 2.1.303 does not write one.
 */
export function buildOfficial303Environment(env = {}, { model = '', oneM = false } = {}) {
  const cwd = sanitizeInboundCwd(env.cwd)
  const os = String(env.osVersion || '').trim() || (env.kernel ? `Linux ${env.kernel}` : '')
  const lines = [
    '# Environment',
    OFFICIAL_303_ENV_INTRO,
    ...(cwd ? [` - Primary working directory: ${cwd}`] : []),
    ` - Is a git repository: ${env.git === true ? 'true' : 'false'}`,
    ` - Platform: ${String(env.platform || '').trim() || 'linux'}`,
    ` - Shell: ${String(env.shell || '').trim() || 'bash'}`,
  ]
  if (os) lines.push(` - OS Version: ${os}`)
  lines.push(OFFICIAL_303_ENV_UNTRUSTED)
  return lines.join('\n')
}

const BILLING_RE = /^\s*x-anthropic-billing-header:/i
const IDENTITY_TEXTS = new Set([
  OFFICIAL_303_IDENTITY,
  OFFICIAL_303_AGENT_IDENTITY,
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
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
  if (t.includes('You are an agent working with the user toward their goals')) return 'harness'
  if (t.trim() === '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__') return 'boundary'
  if (t.includes('Write code that reads like the surrounding code')) return 'guidance'
  if (t.includes('You are an interactive agent that helps users')) return 'main_full'
  if (t.trimStart().startsWith('# Reporting outcomes')) return 'reporting'
  return 'other'
}
