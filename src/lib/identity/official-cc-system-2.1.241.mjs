/**
 * Official Claude Code 2.1.241 continuation + KIN unofficial rewrite helpers.
 * Unofficial Environment: slot timezone is required. Caller Environment is
 * passed through with Timezone rewritten; otherwise only Timezone is written.
 * Unofficial agent block is CRS_AGENT_EXPANSION (not the official SWE prompt).
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const FIXTURE = require('./official-cc-system-2.1.241.json')

export const CRS_OFFICIAL_AGENT_IDENTITY = FIXTURE.identity
export const CRS_OFFICIAL_AGENT_PROMPT = FIXTURE.agent_prompt
export const CRS_OFFICIAL_CONTINUATION = FIXTURE.continuation
export const OFFICIAL_SLOT_CWD = '/home/kincli'
export const MAX_INBOUND_CWD_LEN = 512

/** KIN unofficial rewrite agent. Structure matches 2.1.241 block 3; wording is original. */
export const CRS_AGENT_EXPANSION = `
Help the user complete the current request. Use only the tools this request actually supplies. Do not assume a local shell, editor, or filesystem exists unless those tools are present.

Stay inside authorized defensive work, education, or other clearly permitted use. Do not invent attack steps, bypasses, or credentials. If the request is ambiguous, ask instead of guessing a harmful reading.

Do not invent or guess URLs. Use only links the user provided, links returned by a tool, or links you can confirm from this request.

# Tone and style
 - Keep answers short. Do not use emoji unless the user asks for it.
 - When you cite code, write file_path:line_number.
 - Do not put a colon immediately before a tool call.`

export const AGENT_EXPANSION_CACHE_CONTROL = Object.freeze({
  type: 'ephemeral',
  ttl: '5m',
})

export const OFFICIAL_CONTEXT_MANAGEMENT = `# Context management
When the conversation grows long, some or all of the current context is summarized; the summary, along with any remaining unsummarized context, is provided in the next context window so work can continue — you don't need to wrap up early or hand off mid-task.

When you have enough information to act, act. Do not re-derive facts already established in the conversation, re-litigate a decision the user has already made, or narrate options you will not pursue. If you are weighing a choice, give a recommendation, not an exhaustive survey

<total_tokens>15000000 tokens left</total_tokens>`

const CWD_PATTERNS = [
  /Primary working directory:\s*([^\n]+)/i,
  /current working directory is\s+['"]([^'"]+)['"]/i,
  /current working directory is\s+(\S+)/i,
  /(?:^|\n)\s*-?\s*Working directory:\s*([^\n]+)/i,
]

export function sanitizeInboundCwd(raw) {
  let value = String(raw || '').trim()
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    value = value.slice(1, -1).trim()
  }
  if (!value || value.length > MAX_INBOUND_CWD_LEN) return ''
  if (/[\x00-\x1f]/.test(value)) return ''
  if (!/^([A-Za-z]:[\\/]|\\\\|~[\\/]|\/|\.\/|\.\.\/)/.test(value)) return ''
  return value
}

export function extractCwdFromText(text) {
  const src = String(text || '')
  if (!src.trim()) return ''
  for (const pattern of CWD_PATTERNS) {
    const match = src.match(pattern)
    const cwd = sanitizeInboundCwd(match?.[1] || '')
    if (cwd) return cwd
  }
  return ''
}

/** Claude Code project bucket: /home/kincli → -home-kincli */
export function officialProjectSlug(cwd = '') {
  const normalized = String(cwd || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
  const slug = normalized
    .replace(/[^A-Za-z0-9._]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  if (!slug) return ''
  return slug.startsWith('-') ? slug : `-${slug}`
}

function sanitizeEnvToken(raw, max = 64) {
  const value = String(raw || '').trim()
  if (!value || value.length > max || /[\x00-\x1f]/.test(value)) return ''
  if (!/^[A-Za-z0-9._+/-]+$/.test(value)) return ''
  return value
}

function firstEnvField(raw) {
  return String(raw || '')
    .split(/\s+-\s+(?:Locale|Timezone|Platform|Shell|OS Version):/i)[0]
    .trim()
}

function sanitizeOsVersion(raw, max = 128) {
  const value = firstEnvField(raw)
  if (!value || value.length > max || /[\x00-\x1f]/.test(value)) return ''
  if (!/^[A-Za-z0-9._+/-]+(?: [A-Za-z0-9._+/-]+)*$/.test(value)) return ''
  return value
}

/** Parse caller Environment / cwd phrases. First non-empty field wins. */
export function parseInboundEnvFacts(texts = []) {
  const facts = {
    cwd: '',
    git: null,
    shell: '',
    platform: '',
    osVersion: '',
    kernel: '',
    timezone: '',
    locale: '',
  }
  for (const raw of texts) {
    const text = String(raw || '')
    if (!facts.cwd) facts.cwd = extractCwdFromText(text)
    if (facts.git == null) {
      const git = text.match(/Is a git repository:\s*(true|false)/i)
      if (git) facts.git = git[1].toLowerCase() === 'true'
    }
    if (!facts.shell) {
      const shell = text.match(/(?:^|\n)\s*-?\s*Shell:\s*([^\n]+)/i)
      const token = sanitizeEnvToken(firstEnvField(shell?.[1] || ''))
      if (token && !/^unknown$/i.test(token)) facts.shell = token
    }
    if (!facts.platform) {
      const plat = text.match(/(?:^|\n)\s*-?\s*Platform:\s*([^\n]+)/i)
      facts.platform = sanitizeEnvToken(firstEnvField(plat?.[1] || ''), 32)
    }
    if (!facts.locale) {
      const loc = text.match(/\bLocale:\s*([^\n]+)/i)
      facts.locale = sanitizeEnvToken(firstEnvField(loc?.[1] || ''), 64)
    }
    if (!facts.timezone) {
      const tz = text.match(/\bTimezone:\s*([^\n]+)/i)
      facts.timezone = sanitizeEnvToken(firstEnvField(tz?.[1] || ''), 64)
    }
    if (!facts.osVersion) {
      const os = text.match(/(?:^|\n)\s*-?\s*OS Version:\s*([^\n]+)/i)
      const version = sanitizeOsVersion(os?.[1] || '')
      if (version) {
        facts.osVersion = version
        const linux = version.match(/^Linux\s+(\S+)/i)
        if (linux) facts.kernel = linux[1]
      }
    }
  }
  return facts
}

export function displayNameForModel(modelId = '') {
  const id = String(modelId || '').split('[')[0]
  if (/fable-5[-.]1/i.test(id)) return 'Fable 5.1'
  if (/fable-5/i.test(id)) return 'Fable 5'
  if (/opus-5/i.test(id)) return 'Opus 5'
  if (/sonnet-5/i.test(id)) return 'Sonnet 5'
  if (/haiku-4-5/i.test(id)) return 'Haiku 4.5'
  if (/opus/i.test(id)) return 'Opus'
  if (/sonnet/i.test(id)) return 'Sonnet'
  if (/haiku/i.test(id)) return 'Haiku'
  return id || 'Claude'
}

export function inboundEnvFactsPresent(facts = {}) {
  return Boolean(
    facts.cwd ||
      facts.shell ||
      facts.platform ||
      facts.osVersion ||
      facts.kernel ||
      facts.timezone ||
      facts.locale ||
      facts.git === true ||
      facts.git === false,
  )
}

export function extractInboundEnvironmentSection(texts = []) {
  for (const raw of texts) {
    const text = String(raw || '')
    const start = text.search(/^# Environment\b/m)
    if (start < 0) continue
    const rest = text.slice(start)
    const next = rest.search(/\n# (?!Environment\b)/)
    return (next >= 0 ? rest.slice(0, next) : rest).replace(/\s+$/, '')
  }
  return ''
}

export function applySlotTimezone(text, timezone) {
  const src = String(text || '')
  const tz = sanitizeEnvToken(timezone, 64) || 'UTC'
  if (/\bTimezone:\s*/i.test(src)) {
    return src.replace(/\bTimezone:\s*[^\n]*/i, `Timezone: ${tz}`)
  }
  if (/^# Environment\b/m.test(src)) {
    return src.replace(/^(# Environment[^\n]*\n)/m, `$1 - Timezone: ${tz}\n`)
  }
  return `${src.replace(/\s+$/, '')}\n - Timezone: ${tz}`
}

function buildEnvironmentFromFacts(facts = {}, timezone = '') {
  const tz = sanitizeEnvToken(timezone, 64) || 'UTC'
  const lines = ['# Environment']
  const cwd = sanitizeInboundCwd(facts.cwd)
  if (cwd) lines.push(` - Primary working directory: ${cwd}`)
  if (facts.git === true || facts.git === false) {
    lines.push(` - Is a git repository: ${facts.git ? 'true' : 'false'}`)
  }
  const plat = sanitizeEnvToken(facts.platform, 32)
  if (plat) lines.push(` - Platform: ${plat}`)
  const shell = sanitizeEnvToken(facts.shell)
  if (shell) lines.push(` - Shell: ${shell}`)
  const os = sanitizeOsVersion(facts.osVersion)
  if (os) lines.push(` - OS Version: ${os}`)
  const loc = sanitizeEnvToken(facts.locale, 64)
  if (loc) lines.push(` - Locale: ${loc}`)
  lines.push(` - Timezone: ${tz}`)
  return lines.join('\n')
}

/** Previous default: synthesize a full official Environment (cwd/git/OS/catalog). */
export function buildOverwriteEnvironmentSection({
  cwd = '',
  kernel = '',
  osPretty = '',
  osVersion = '',
  platform = '',
  modelId = 'claude-sonnet-5',
  timezone = '',
  locale = '',
  git = false,
  shell = 'unknown',
} = {}) {
  const resolvedOs =
    sanitizeOsVersion(osVersion) || (kernel ? sanitizeOsVersion(`Linux ${kernel}`) : '') || sanitizeOsVersion(osPretty)
  const plat = sanitizeEnvToken(platform, 32)
  const locValue = sanitizeEnvToken(locale, 64)
  const tzValue = sanitizeEnvToken(timezone, 64)
  const modelName = displayNameForModel(modelId)
  const exact = String(modelId || 'claude-sonnet-5').split('[')[0] || 'claude-sonnet-5'
  const loc = locValue ? ` - Locale: ${locValue}` : ''
  const tz = tzValue ? ` - Timezone: ${tzValue}` : ''
  const cwdLine = cwd ? ` - Primary working directory: ${cwd}\n` : ''
  const gitLine = ` - Is a git repository: ${git === true ? 'true' : 'false'}`
  const platformLine = plat ? `\n - Platform: ${plat}` : ''
  const shellLine = `\n - Shell: ${sanitizeEnvToken(shell) || 'unknown'}`
  const osLine = resolvedOs
    ? `\n - OS Version: ${resolvedOs}${loc}${tz}`
    : loc || tz
      ? `\n - OS Version:${loc}${tz}`
      : ''
  return `# Environment
You have been invoked in the following environment: 
${cwdLine}${gitLine}${platformLine}${shellLine}${osLine}
 - You are powered by the model named ${modelName}. The exact model ID is ${exact}.
 - Assistant knowledge cutoff is January 2026.
 - The most recent Claude models are the Claude 5 family and Haiku 4.5. Model IDs — Fable 5: 'claude-fable-5', Opus 5: 'claude-opus-5', Sonnet 5: 'claude-sonnet-5', Haiku 4.5: 'claude-haiku-4-5-20251001'. When building AI applications, default to the latest and most capable Claude models.
 - Claude Code is available as a CLI in the terminal, desktop app (Mac/Windows), web app (claude.ai/code), and IDE extensions (VS Code, JetBrains).
 - Fast mode for Claude Code uses Claude Opus with faster output (it does not downgrade to a smaller model). It can be toggled with /fast and is available on Opus 5/4.8.

${OFFICIAL_CONTEXT_MANAGEMENT}`
}

export function applySlotLocale(text, locale) {
  const src = String(text || '')
  const loc = sanitizeEnvToken(locale, 64)
  if (!loc) return src
  if (/\bLocale:\s*/i.test(src)) return src.replace(/\bLocale:\s*[^\n]*/i, `Locale: ${loc}`)
  return src
}

export function isOverwriteEnvironmentText(text) {
  const t = String(text || '')
  return (
    t.includes('You have been invoked in the following environment:') ||
    t.includes('You are powered by the model named')
  )
}

export function buildOfficialEnvironmentSection(env = {}, { sourceTexts = [], contextManagement = true } = {}) {
  const tz = sanitizeEnvToken(env.timezone, 64) || 'UTC'
  const inboundSection = extractInboundEnvironmentSection(sourceTexts)
  let envBlock
  if (inboundSection) {
    envBlock = applySlotTimezone(inboundSection, tz)
  } else if (inboundEnvFactsPresent(env)) {
    envBlock = buildEnvironmentFromFacts(env, tz)
  } else {
    envBlock = `# Environment\n - Timezone: ${tz}`
  }
  if (!contextManagement) return envBlock
  return `${envBlock}\n\n${OFFICIAL_CONTEXT_MANAGEMENT}`
}

export function buildOfficialContinuationText(env = {}, sourceTexts = [], { overwrite = false } = {}) {
  const cwd = sanitizeInboundCwd(env.cwd)
  let body = String(CRS_OFFICIAL_CONTINUATION || '')
  const slug = officialProjectSlug(cwd)
  if (cwd && slug) {
    body = body.replaceAll(
      '/home/kincli/.claude/projects/-home-kincli/memory/',
      `${cwd}/.claude/projects/${slug}/memory/`,
    )
  }
  const envSection = overwrite
    ? buildOverwriteEnvironmentSection({ ...env, cwd })
    : buildOfficialEnvironmentSection({ ...env, cwd }, { sourceTexts })
  return `${body}\n\n${envSection}`
}
