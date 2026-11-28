/**
 * Single SSOT strict verifier for Official Claude Code traffic.
 *
 * Replaces fragmented weak checks across direct traffic, proxied relays,
 * claude_code_only gating, header forwarding, tool-name preservation, and
 * probe/warmup handling. Fail-closed by default with explicit failReasons.
 */
import { createHash } from 'node:crypto'
import { computeClaudeCodeCch, projectClaudeCodeCchText } from './cch.mjs'
import { OFFICIAL_CLI_VERSION } from './vm-identity.mjs'
import {
  OFFICIAL_303_AGENT_IDENTITY,
  OFFICIAL_303_HARNESS,
  OFFICIAL_303_IDENTITY,
  classifySystemText,
} from './official-profiles.mjs'
import {
  CRS_AGENT_EXPANSION,
  CRS_OFFICIAL_AGENT_PROMPT,
  CRS_OFFICIAL_CONTINUATION,
} from './official-cc-system-2.1.241.mjs'
import { CRS_OFFICIAL_AGENT_PROMPT_303 } from './official-cc-system-2.1.303-full.mjs'

export const FINGERPRINT_SALT = '59cf53e54c78'

export const STRICT_CLAUDE_CLI_UA_RE =
  /^claude-cli\/(\d+\.\d+\.\d+) \(external, ([a-z0-9_-]+)(?:,\s*(?:agent-sdk|client-app|workload)\/[^\s,)]+)*\)$/

const CLAUDE_CLI_PREFIX_RE = /^claude-cli\//i
const DESKTOP_AGENT_SDK_RE = /(?:^|[ (,])agent-sdk\/\d+\.\d+\.\d+(?=[,)])/
const SEMVER_RE = /^\d+\.\d+\.\d+$/
const RUNTIME_VERSION_RE = /^v?\d+\.\d+/
const PACKAGE_VERSION_RE = /^\d+\.\d+\.\d+/
const DIGITS_RE = /^\d+$/

const VALID_X_APP = new Set(['cli', 'cli-bg'])
const VALID_STAINLESS_OS = new Set(['Linux', 'MacOS', 'Windows', 'Other'])
const VALID_STAINLESS_ARCH = new Set(['x64', 'arm64', 'x32', 'other'])
const VALID_STAINLESS_RUNTIME = new Set(['node', 'bun', 'deno'])
const CLAUDE_CODE_BETA = 'claude-code-20250219'
const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14'

const HEX64_LOWER_RE = /^[0-9a-f]{64}$/
const ALL_ZERO_HEX64_RE = /^0{64}$/
const UUIDV4_LOWER_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const UUID_ANY_LOWER_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ALL_ZERO_UUID = '00000000-0000-0000-0000-000000000000'
const LEGACY_STRICT_USER_ID_RE = /^user_([0-9a-f]{64})_account_([0-9a-f-]{0,36})_session_([0-9a-f-]{36})$/
const USER_ID_MAX_BYTES = 512

const INVISIBLE_UNICODE_RE = /[\u00AD\u180E\u200B-\u200F\u2060-\u2064\uFEFF]/g
const SYSTEM_REMINDER_BLOCK_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/gi

/** Strict case-sensitive PascalCase built-in tool allowlist for CC 2.1.321–2.1.332. */
export const OFFICIAL_CLAUDE_CODE_TOOL_NAMES = Object.freeze(
  new Set([
    'Agent',
    'Artifact',
    'AskUserQuestion',
    'Bash',
    'BashOutput',
    'Brief',
    'Config',
    'CronCreate',
    'CronDelete',
    'CronList',
    'CtxInspect',
    'DeferredToolPlaceholder',
    'DesignSync',
    'Edit',
    'EnterPlanMode',
    'EnterWorktree',
    'ExitPlanMode',
    'ExitWorktree',
    'Glob',
    'Grep',
    'KillShell',
    'LS',
    'LSP',
    'ListAgents',
    'ListMcpResourcesTool',
    'ListPeers',
    'Monitor',
    'MultiEdit',
    'NotebookEdit',
    'PowerShell',
    'PushNotification',
    'REPL',
    'Read',
    'ReadMcpResourceDirTool',
    'ReadMcpResourceTool',
    'RemoteTrigger',
    'ReportFindings',
    'ScheduleWakeup',
    'SendMessage',
    'SendUserFile',
    'SendUserMessage',
    'Skill',
    'Sleep',
    'Snip',
    'StructuredOutput',
    'SubscribePR',
    'Task',
    'TaskCreate',
    'TaskGet',
    'TaskList',
    'TaskOutput',
    'TaskStop',
    'TaskUpdate',
    'TeamCreate',
    'TeamDelete',
    'TerminalCapture',
    'TodoWrite',
    'ToolSearch',
    'VerifyPlanExecution',
    'WaitForMcpServers',
    'WebBrowser',
    'WebFetch',
    'WebSearch',
    'Workflow',
    'Write',
  ]),
)

const VERSIONED_SERVER_TOOL_TYPE_RE =
  /^(?:(?:web_search|web_fetch|code_execution|text_editor|computer|bash|memory|advisor)_\d+|tool_search_tool_[a-z0-9_]+|str_replace_based_edit_tool)$/
const OFFICIAL_MCP_TOOL_RE = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_.:-]+$/

export const OFFICIAL_CC_CHILD_PROMPT_PREFIXES = Object.freeze([
  "You are Claude Code, Anthropic's official CLI for Claude",
  "You are a Claude agent, built on Anthropic's Claude Agent SDK",
  "You are Claude Code, built on Anthropic's Claude Agent SDK",
  'You are a file search specialist for Claude Code',
  'You are a helpful AI assistant tasked with summarizing conversations',
  'You are an interactive CLI tool that helps users',
  'You are an assistant for performing a web search tool use',
])

const OFFICIAL_IDENTITY_PREFIXES = Object.freeze([
  "You are Claude Code, Anthropic's official CLI for Claude",
  "You are a Claude agent, built on Anthropic's Claude Agent SDK",
  "You are Claude Code, built on Anthropic's Claude Agent SDK",
])

const OFFICIAL_CHILD_ONLY_PREFIXES = Object.freeze([
  'You are a file search specialist for Claude Code',
  'You are a helpful AI assistant tasked with summarizing conversations',
  'You are an interactive CLI tool that helps users',
  'You are an assistant for performing a web search tool use',
])

const SIDE_QUERY_IDENTITY_PREFIXES = Object.freeze([
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  "You are Claude Code, Anthropic's official CLI for Claude.",
])

const OFFICIAL_TITLE_PREFIX = 'You write short session titles'

export const CLAUDE_CODE_SECURITY_MONITOR_PREFIX = 'You are a security monitor for autonomous AI coding agents.'
export const CLAUDE_CODE_SECURITY_MONITOR_MIN_LEN = 10_000
export const CLAUDE_CODE_SECURITY_MONITOR_MARKERS = Object.freeze([
  '## Threat Model',
  '- `<transcript>`:',
  '## HARD BLOCK',
  '## SOFT BLOCK',
  '## Classification Process',
  '## Output Format',
])

const ALLOWED_PROXIED_ENTRYPOINTS = new Set([
  'cli',
  'sdk-cli',
  'cli-bg',
  'sdk-ts',
  'claude-desktop-3p',
  'claude-desktop',
  'claude-vscode',
  'vscode',
  'cowork',
  'desktop',
  'local-agent',
])

const OFFICIAL_SERVER_TOOL_NAMES = new Set([
  'web_search',
  'web_fetch',
  'code_execution',
  'str_replace_based_edit_tool',
  'str_replace_editor',
  'bash',
  'computer',
  'memory',
  'advisor',
  'tool_search_tool_regex',
  'tool_search_tool_bm25',
])
const OPTIONAL_USER_ID_PROXIED_ENTRYPOINTS = new Set(['claude-desktop-3p', 'sdk-ts'])
const AUXILIARY_REQUEST_CLASSES = new Set(['compaction', 'auxiliary', 'side_reply', 'subagent'])

const KNOWN_OFFICIAL_SYSTEM_SET = new Set(
  [
    OFFICIAL_303_IDENTITY,
    OFFICIAL_303_AGENT_IDENTITY,
    "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
    "You are Claude Code, built on Anthropic's Claude Agent SDK.",
    'You are Anthropic Claude Agent SDK.',
    'You are Claude Agent SDK.',
    CRS_OFFICIAL_AGENT_PROMPT,
    CRS_OFFICIAL_AGENT_PROMPT_303,
    CRS_AGENT_EXPANSION,
    CRS_OFFICIAL_CONTINUATION,
    OFFICIAL_303_HARNESS,
  ].map((s) => s.trim()),
)

export function stripInvisibleUnicode(text) {
  return String(text ?? '').replace(INVISIBLE_UNICODE_RE, '')
}

function normalizeHeaders(reqOrHeaders) {
  const src =
    reqOrHeaders && typeof reqOrHeaders === 'object' && reqOrHeaders.headers && typeof reqOrHeaders.headers === 'object'
      ? reqOrHeaders.headers
      : reqOrHeaders
  const out = {}
  if (!src || typeof src !== 'object') return out
  for (const [k, v] of Object.entries(src)) {
    if (v == null || v === '') continue
    out[String(k).toLowerCase()] = Array.isArray(v) ? v.join(',') : String(v)
  }
  return out
}

function headerStr(headers, key) {
  return String(headers?.[key] ?? '').trim()
}

function betaTokens(headers) {
  return headerStr(headers, 'anthropic-beta')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
}

function extractSystemBlockTexts(system) {
  if (!system) return []
  if (typeof system === 'string') return system.trim() ? [system] : []
  if (Array.isArray(system)) {
    const out = []
    for (const block of system) {
      if (typeof block === 'string') {
        if (block.trim()) out.push(block)
      } else if (block && typeof block === 'object' && typeof block.text === 'string' && block.text.trim()) {
        out.push(block.text)
      }
    }
    return out
  }
  if (typeof system === 'object' && typeof system.text === 'string' && system.text.trim()) {
    return [system.text]
  }
  return []
}

function isNonZeroUuid(raw) {
  const s = String(raw || '')
  return UUID_ANY_LOWER_RE.test(s) && s !== ALL_ZERO_UUID
}

/**
 * Strict case-sensitive official Claude Code tool check.
 * Rejects lowercase built-ins (`bash`, `read`), `_bash`, `bash_exec`, `memory_save`, etc.
 */
export function isOfficialClaudeToolName(
  name,
  toolObj = null,
  { allowClassifierTool = false, allowOpenClawMcp = false } = {},
) {
  const toolType = typeof toolObj?.type === 'string' ? toolObj.type.trim() : ''
  const rawName = String(name ?? toolObj?.name ?? '').trim()

  if (toolType && toolType !== 'custom') {
    // Non-custom tool types MUST be versioned Anthropic server tools with an official server tool name (or empty name).
    if (!VERSIONED_SERVER_TOOL_TYPE_RE.test(toolType)) return false
    if (!rawName) return true
    return OFFICIAL_SERVER_TOOL_NAMES.has(rawName)
  }

  if (!rawName) return false
  if (OFFICIAL_CLAUDE_CODE_TOOL_NAMES.has(rawName)) return true
  if (OFFICIAL_MCP_TOOL_RE.test(rawName)) {
    if (!allowOpenClawMcp && rawName.startsWith('mcp__openclaw__')) return false
    return true
  }
  if (allowClassifierTool && rawName === 'classify_result') return true
  return false
}

/**
 * Strict metadata.user_id parser & validator.
 * - JSON (<= 512 UTF-8 bytes): 64 lowercase hex non-zero `device_id`,
 *   non-zero UUIDv4 `session_id`, `account_uuid` empty or valid non-zero UUID.
 * - Legacy: `user_<64hex>_account_<uuid?>_session_<uuidv4>` with non-zero device_id.
 */
export function parseStrictOfficialUserId(raw) {
  if (raw == null) return null

  const validateObj = (obj) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
    const deviceId = typeof obj.device_id === 'string' ? obj.device_id : ''
    const sessionId = typeof obj.session_id === 'string' ? obj.session_id : ''
    const accountUuid =
      obj.account_uuid === undefined ? '' : typeof obj.account_uuid === 'string' ? obj.account_uuid : null
    if (!HEX64_LOWER_RE.test(deviceId) || ALL_ZERO_HEX64_RE.test(deviceId)) return null
    if (!UUIDV4_LOWER_RE.test(sessionId)) return null
    if (accountUuid === null) return null
    if (accountUuid !== '' && !isNonZeroUuid(accountUuid)) return null
    const parentSessionId =
      typeof obj.parent_session_id === 'string' && obj.parent_session_id ? obj.parent_session_id : ''
    const rootSessionId = typeof obj.root_session_id === 'string' && obj.root_session_id ? obj.root_session_id : ''
    if (parentSessionId && !isNonZeroUuid(parentSessionId)) return null
    if (rootSessionId && !isNonZeroUuid(rootSessionId)) return null
    return {
      valid: true,
      format: 'json',
      deviceId,
      accountUuid,
      sessionId,
      parentSessionId,
      rootSessionId,
    }
  }

  if (typeof raw === 'object') {
    let serialized = ''
    try {
      serialized = JSON.stringify(raw)
    } catch {
      return null
    }
    if (Buffer.byteLength(serialized, 'utf8') > USER_ID_MAX_BYTES) return null
    return validateObj(raw)
  }

  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s || Buffer.byteLength(s, 'utf8') > USER_ID_MAX_BYTES) return null

  if (s.startsWith('{')) {
    try {
      return validateObj(JSON.parse(s))
    } catch {
      return null
    }
  }

  const m = LEGACY_STRICT_USER_ID_RE.exec(s)
  if (!m) return null
  const [, deviceId, accountUuid, sessionId] = m
  if (ALL_ZERO_HEX64_RE.test(deviceId)) return null
  if (accountUuid !== '' && !isNonZeroUuid(accountUuid)) return null
  if (!UUIDV4_LOWER_RE.test(sessionId)) return null
  return {
    valid: true,
    format: 'legacy',
    deviceId,
    accountUuid,
    sessionId,
    parentSessionId: '',
    rootSessionId: '',
  }
}

export function isValidStrictOfficialUserId(raw) {
  return parseStrictOfficialUserId(raw) !== null
}

/** Check Claude Desktop Cowork direct headers (required when entrypoint is local-agent on claude-cli UA). */
export function hasVerifiedDesktopHeaders(headers = {}) {
  const h = normalizeHeaders(headers)
  const ua = headerStr(h, 'user-agent')
  const match = STRICT_CLAUDE_CLI_UA_RE.exec(ua)
  if (!match || match[2] !== 'local-agent') return false
  if (!DESKTOP_AGENT_SDK_RE.test(ua)) return false
  if (headerStr(h, 'anthropic-client-platform') !== 'desktop_app') return false
  return SEMVER_RE.test(headerStr(h, 'anthropic-client-version'))
}

/**
 * Verify the complete direct Claude Code header bundle (H1 + H2, plus optional H3 beta).
 */
export function verifyDirectClaudeCodeHeaders(reqOrHeaders = {}, { requireCodeBeta = true } = {}) {
  const h = normalizeHeaders(reqOrHeaders)
  const failReasons = []
  const ua = headerStr(h, 'user-agent')
  const uaMatch = STRICT_CLAUDE_CLI_UA_RE.exec(ua)
  const uaVersion = uaMatch?.[1] || ''
  const uaEntrypoint = uaMatch?.[2] || ''

  if (!uaMatch) {
    failReasons.push('ua_syntax')
  } else if (uaEntrypoint === 'local-agent' && !hasVerifiedDesktopHeaders(h)) {
    failReasons.push('desktop_headers_missing')
  }

  if (!VALID_X_APP.has(headerStr(h, 'x-app').toLowerCase())) failReasons.push('invalid_x_app')
  if (headerStr(h, 'anthropic-version') !== '2023-06-01') failReasons.push('invalid_anthropic_version')
  if (headerStr(h, 'anthropic-dangerous-direct-browser-access').toLowerCase() !== 'true') {
    failReasons.push('missing_browser_access_header')
  }
  if (headerStr(h, 'x-stainless-lang') !== 'js') failReasons.push('invalid_stainless_lang')
  if (!VALID_STAINLESS_OS.has(headerStr(h, 'x-stainless-os'))) failReasons.push('invalid_stainless_os')
  if (!VALID_STAINLESS_ARCH.has(headerStr(h, 'x-stainless-arch'))) failReasons.push('invalid_stainless_arch')
  if (!VALID_STAINLESS_RUNTIME.has(headerStr(h, 'x-stainless-runtime'))) failReasons.push('invalid_stainless_runtime')
  if (!RUNTIME_VERSION_RE.test(headerStr(h, 'x-stainless-runtime-version'))) {
    failReasons.push('invalid_stainless_runtime_version')
  }
  if (!PACKAGE_VERSION_RE.test(headerStr(h, 'x-stainless-package-version'))) {
    failReasons.push('invalid_stainless_package_version')
  }
  if (!DIGITS_RE.test(headerStr(h, 'x-stainless-retry-count'))) failReasons.push('invalid_stainless_retry_count')
  if (!DIGITS_RE.test(headerStr(h, 'x-stainless-timeout'))) failReasons.push('invalid_stainless_timeout')

  const sessionId = headerStr(h, 'x-claude-code-session-id')
  if (!UUIDV4_LOWER_RE.test(sessionId)) failReasons.push('invalid_session_header')

  const hasCodeBeta = betaTokens(h).includes(CLAUDE_CODE_BETA)
  if (requireCodeBeta && !hasCodeBeta) failReasons.push('missing_claude_code_beta')

  return {
    ok: failReasons.length === 0,
    uaVersion,
    uaEntrypoint,
    sessionId,
    hasCodeBeta,
    failReasons,
  }
}

/**
 * Strip invisible/zero-width Unicode and test if a single text block carries
 * a known third-party clone / harness signature.
 */
export function textMatchesCloneSignature(rawText) {
  const text = stripInvisibleUnicode(rawText)
  if (!text.trim()) return null

  // oh-my-pi / omp / pi-coding-agent
  if (/^You are omp['’]s trusted coding assistant\.?\s*$/im.test(text)) return 'omp'
  if (/RFC 2119 keywords:\s*MUST,\s*REQUIRED,\s*SHOULD/i.test(text)) return 'omp'
  if (/<project-context>[\s\S]*?<workstation>/i.test(text)) return 'omp'
  if (/<system-conventions>/i.test(text) && (/<workstation>/i.test(text) || /Oh My Pi/i.test(text))) return 'omp'
  if (/^ROLE\s*\n\s*=+/m.test(text) && /^PROJECT\s*\n\s*=+/m.test(text)) return 'omp'
  if (/\b(?:oh my pi|pi coding harness|omp coding harness)\b/i.test(text)) return 'omp'
  if (/\ba coding assistant running inside pi\b/i.test(text)) return 'pi'
  if (/\b__pi_deferred_placeholder__\b/.test(text)) return 'pi'

  // OpenCode
  if (/^\s*You are OpenCode\b/im.test(text)) return 'opencode'

  // OpenClaw / Clawdbot / Moltbot
  if (
    /\brunning inside OpenClaw\b/i.test(text) ||
    /^## OpenClaw Control\b/m.test(text) ||
    /"schema"\s*:\s*"openclaw\.inbound_meta\./.test(text) ||
    /\bdocs\.openclaw\.ai\b/i.test(text)
  ) {
    return 'openclaw'
  }

  // Hermes Agent / Nous Research
  if (
    /\bYou are Hermes Agent\b/i.test(text) ||
    /\ban intelligent AI assistant (?:created|built) by Nous Research\b/i.test(text) ||
    /\bNous Research\b/i.test(text)
  ) {
    return 'hermes'
  }

  // Codex CLI
  if (
    /\bYou are Codex,\s*an?\s*(?:coding\s+)?agent based on GPT-/i.test(text) ||
    /\bYou are a coding agent running in the Codex CLI\b/i.test(text)
  ) {
    return 'codex'
  }

  // Cline / Roo Code / Kilo Code
  if (/^\s*You are (?:Cline|Roo|Kilo Code)\b/im.test(text)) return 'cline'

  // DeepSeek Harness
  if (/\bpowered by DeepSeek Harness\b/i.test(text)) return 'deepseek_harness'

  // Keli Agent
  if (/^\s*你是\s*Keli Agent\b/im.test(text) || /\bKeli Agent\b/.test(text)) return 'keli_agent'

  // Toonflow
  if (/^\s*你是\s*Toonflow\b/im.test(text)) return 'toonflow'

  return null
}

function isVerifiedProxiedCoworkLocalAgent(headers, body, blocks) {
  const ua = headerStr(headers, 'user-agent')
  if (!ua || CLAUDE_CLI_PREFIX_RE.test(ua)) return false
  if (!blocks.length) return false
  if (!/^x-anthropic-billing-header:[ \t]*/i.test(blocks[0])) return false
  if (!/\bcc_entrypoint=local-agent(?=;|\s|$)/i.test(blocks[0].split(/\r?\n/, 1)[0])) return false
  if (/\bcch=00000(?=;|\s|$)/i.test(blocks[0])) return false
  if (!isValidStrictOfficialUserId(body?.metadata?.user_id)) return false
  const second = String(blocks[1] || '').trimStart()
  if (!OFFICIAL_IDENTITY_PREFIXES.some((prefix) => second.startsWith(prefix))) return false
  return blocks.some(isCoworkApplicationDetailsBlock)
}

/**
 * Detect known third-party clones / harnesses spoofing Claude Code.
 * Strips invisible/zero-width Unicode before matching. Inspects headers,
 * body.system, and body.tools (never user conversation messages).
 * @returns {string | null} clone identifier or null
 */
export function detectCloneHarness(reqOrHeaders = {}, body = {}) {
  const h = normalizeHeaders(reqOrHeaders)
  const ua = stripInvisibleUnicode(headerStr(h, 'user-agent'))

  // Header-level clone detection
  if (/\b(?:oh-my-pi|omp\/|pi-coding-agent|pi-ai)\b/i.test(ua)) return 'omp'
  if (/\bopencode\b/i.test(ua)) return 'opencode'
  if (/\b(?:openclaw|clawdbot|moltbot)\b/i.test(ua)) return 'openclaw'
  if (/\b(?:hermes-agent|hermes\/)/i.test(ua)) return 'hermes'
  if (
    /\bcodex_cli(?:_rs)?\b/i.test(ua) ||
    /^codex_/i.test(headerStr(h, 'originator')) ||
    headerStr(h, 'x-codex-installation-id')
  ) {
    return 'codex'
  }
  if (/\b(?:cline|roo-code|kilo-code)\b/i.test(ua)) return 'cline'

  // Tool-level clone detection
  const tools = Array.isArray(body?.tools) ? body.tools : []
  for (const tool of tools) {
    const name = stripInvisibleUnicode(tool?.name ?? tool?.function?.name ?? '').trim()
    if (!name) continue
    if (name === '__pi_deferred_placeholder__') return 'pi'
    if (name.startsWith('mcp__openclaw__')) return 'openclaw'
  }

  // System-level clone detection (per-block AND combined, zero-width stripped)
  const blocks = extractSystemBlockTexts(body?.system)
  if (!blocks.length) return null

  const cleanedBlocks = blocks.map(stripInvisibleUnicode)
  for (const blockText of cleanedBlocks) {
    const hit = textMatchesCloneSignature(blockText)
    if (hit) return hit
  }
  const combined = cleanedBlocks.join('\n')
  const combinedHit = textMatchesCloneSignature(combined)
  if (combinedHit) return combinedHit

  // local-agent entrypoint requires verified Desktop headers on direct traffic
  // (or verified proxied Cowork envelope on non-claude-cli relay traffic).
  if (/\bcc_entrypoint\s*=\s*local-agent\b/i.test(combined)) {
    if (hasVerifiedDesktopHeaders(h)) return null
    if (isVerifiedProxiedCoworkLocalAgent(h, body, cleanedBlocks)) return null
    return 'omp_local_agent'
  }

  return null
}

function isSystemReminderOnly(text) {
  const t = String(text ?? '').trim()
  return t !== '' && t.replace(SYSTEM_REMINDER_BLOCK_RE, '').trim() === ''
}

function stripLeadingSystemReminders(text) {
  return String(text ?? '')
    .replace(/^(?:\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*)+/i, '')
    .trimStart()
}

function firstTextFromMessage(msg) {
  const content = msg?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'string') return block
      if (block?.type === 'text' && typeof block.text === 'string') return block.text
    }
  }
  return ''
}

function candidateFirstUserTexts(messages) {
  if (!Array.isArray(messages)) return ['']
  const out = []
  const add = (val) => {
    if (typeof val !== 'string') return
    if (!out.includes(val)) out.push(val)
  }

  let sawFirstUser = false
  for (const msg of messages) {
    if (msg?.role !== 'user') continue
    const content = msg.content
    if (!sawFirstUser) {
      sawFirstUser = true
      const rawFirst = firstTextFromMessage(msg)
      add(rawFirst)
      const stripped = stripLeadingSystemReminders(rawFirst)
      if (stripped !== rawFirst) add(stripped)
      if (Array.isArray(content)) {
        for (const block of content) {
          const text =
            typeof block === 'string'
              ? block
              : block?.type === 'text' && typeof block.text === 'string'
                ? block.text
                : ''
          if (!text) continue
          if (!isSystemReminderOnly(text)) {
            add(text)
            const s = stripLeadingSystemReminders(text)
            if (s !== text) add(s)
            break
          }
        }
      }
    }
    // Also check first non-isMeta / non-reminder user message
    const first = firstTextFromMessage(msg)
    if (first && !isSystemReminderOnly(first)) {
      add(first)
      const stripped = stripLeadingSystemReminders(first)
      if (stripped !== first) add(stripped)
      break
    }
  }

  if (!out.length) out.push('')
  return out
}

/** Compute 3-hex SHA-256 fingerprint using UTF-16 code unit indexing (matches cli-node/src/utils/fingerprint.ts). */
export function computeFingerprintFromTextUtf16(text = '', semver = OFFICIAL_CLI_VERSION) {
  const s = String(text ?? '')
  const chars = [4, 7, 20].map((i) => (i < s.length ? s[i] : '0')).join('')
  return createHash('sha256').update(`${FINGERPRINT_SALT}${chars}${semver}`, 'utf8').digest('hex').slice(0, 3)
}

/**
 * Compute CC billing fingerprint using UTF-16 code units.
 * Accepts either a messages array or a raw first-user text string.
 */
export function computeClaudeCodeFingerprintUtf16(messages, semver = OFFICIAL_CLI_VERSION) {
  if (typeof messages === 'string') {
    return computeFingerprintFromTextUtf16(messages, semver)
  }
  const candidates = candidateFirstUserTexts(messages)
  return computeFingerprintFromTextUtf16(candidates[0] || '', semver)
}

function unprojectedCchFallback(rawStr, cchVal) {
  const re = new RegExp(`(\\bcch=)${cchVal}(?=[;\\s"\\\\])`, 'i')
  if (!re.test(rawStr)) return null
  const reset = rawStr.replace(re, '$100000')
  return computeClaudeCodeCch(Buffer.from(reset, 'utf8'))
}

/**
 * Verify an inbound `x-anthropic-billing-header` anchored at start of `system[0]`.
 */
export function verifyBillingHeader(
  systemBlocks,
  messages,
  { uaVersion = '', uaEntrypoint = '', rawBodyBytes = null } = {},
) {
  const blocks = extractSystemBlockTexts(systemBlocks)
  const base = {
    present: false,
    valid: true,
    unanchoredBilling: false,
    version: '',
    fp3: '',
    entrypoint: '',
    cch: '',
    fp3Verified: false,
    cchVerified: false,
    hasTrailingContent: false,
    failReasons: [],
  }

  if (!blocks.length) return base

  const firstRaw = blocks[0]
  const anchored = /^x-anthropic-billing-header:[ \t]*/i.test(firstRaw)
  if (!anchored) {
    if (blocks.some((b) => /x-anthropic-billing-header/i.test(b))) {
      base.unanchoredBilling = true
    }
    return base
  }

  base.present = true
  const lines = firstRaw.split(/\r?\n/)
  const firstLine = lines[0]
  if (lines.slice(1).some((l) => l.trim().length > 0)) {
    base.hasTrailingContent = true
    base.failReasons.push('billing_trailing_content')
  }

  // cc_version=<semver>(.<3hex>)?
  const verField = /\bcc_version=([^;\s]*)/i.exec(firstLine)
  if (!verField) {
    base.failReasons.push('billing_version_missing')
  } else {
    const parsedVer = /^(\d+\.\d+\.\d+)(?:\.([0-9a-f]{3}))?$/.exec(verField[1])
    if (!parsedVer) {
      base.failReasons.push('billing_version_invalid')
    } else {
      base.version = parsedVer[1]
      base.fp3 = parsedVer[2] || ''
    }
  }

  // cc_entrypoint=<ep>
  const epField = /\bcc_entrypoint=([^;\s]*)/i.exec(firstLine)
  if (!epField || !/^[a-z0-9_-]+$/i.test(epField[1])) {
    base.failReasons.push('billing_entrypoint_missing')
  } else {
    base.entrypoint = epField[1].toLowerCase()
  }

  // Optional cch=<5hex> (reject cch=00000 or invalid format)
  const cchField = /\bcch=([^;\s]*)/i.exec(firstLine)
  if (cchField) {
    const cchVal = cchField[1]
    base.cch = cchVal
    if (cchVal === '00000') {
      base.failReasons.push('cch_zero')
    } else if (!/^[0-9a-f]{5}$/.test(cchVal)) {
      base.failReasons.push('cch_invalid')
    } else if (rawBodyBytes != null) {
      const rawStr = Buffer.isBuffer(rawBodyBytes) ? rawBodyBytes.toString('utf8') : String(rawBodyBytes)
      let matched = false
      try {
        const projected = projectClaudeCodeCchText(rawStr)
        if (computeClaudeCodeCch(Buffer.from(projected, 'utf8')) === cchVal) {
          matched = true
        }
      } catch {
        // fall through to legacy <2.1.296 raw check
      }
      if (!matched) {
        const fallback = unprojectedCchFallback(rawStr, cchVal)
        if (fallback === cchVal) matched = true
      }
      if (matched) {
        base.cchVerified = true
      } else {
        base.failReasons.push('cch_mismatch')
      }
    }
  }

  // Cross-check UA version and entrypoint if provided
  if (uaVersion && base.version && base.version !== uaVersion) {
    base.failReasons.push('billing_version_mismatch')
  }
  if (uaEntrypoint && base.entrypoint && base.entrypoint !== uaEntrypoint.toLowerCase()) {
    base.failReasons.push('billing_entrypoint_mismatch')
  }

  // Cryptographic UTF-16 fp3 verification when present and messages supplied
  if (base.version && base.fp3 && messages != null) {
    const candidates = candidateFirstUserTexts(messages)
    const matched = candidates.some((txt) => computeFingerprintFromTextUtf16(txt, base.version) === base.fp3)
    if (matched) {
      base.fp3Verified = true
    } else {
      base.failReasons.push('fp3_mismatch')
    }
  }

  base.valid = base.failReasons.length === 0
  return base
}

export function findSecurityMonitorSystemBlock(system) {
  for (const text of extractSystemBlockTexts(system)) {
    if (text.length < CLAUDE_CODE_SECURITY_MONITOR_MIN_LEN) continue
    if (!text.trimStart().startsWith(CLAUDE_CODE_SECURITY_MONITOR_PREFIX)) continue
    if (CLAUDE_CODE_SECURITY_MONITOR_MARKERS.every((marker) => text.includes(marker))) return text
  }
  return null
}

function isCoworkApplicationDetailsBlock(text) {
  const t = String(text || '').trimStart()
  return t.startsWith('<application_details>') && t.includes('Claude is powering Cowork mode')
}

function isOfficialAgentPromptText(text) {
  const t = String(text || '').trim()
  if (!t) return false
  if (KNOWN_OFFICIAL_SYSTEM_SET.has(t)) return true
  if (t.includes('# Doing tasks') && t.includes('# Tone and style')) return true
  if (/You are an interactive agent that helps users with software engineering tasks/i.test(t)) return true
  if (/Help the user complete the current request/.test(t)) return true
  return false
}

function isAnchoredOfficialPrefix(text, { allowChild = true, allowTitle = false } = {}) {
  const t = String(text || '').trimStart()
  if (!t) return false
  const prefixes = allowChild ? OFFICIAL_CC_CHILD_PROMPT_PREFIXES : OFFICIAL_IDENTITY_PREFIXES
  if (prefixes.some((p) => t.startsWith(p))) return true
  if (allowTitle && t.startsWith(OFFICIAL_TITLE_PREFIX)) return true
  return false
}

function isPureBillingLineBlock(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
  return lines.length > 0 && lines.every((l) => /^[ \t]*x-anthropic-billing-header:/i.test(l))
}

/**
 * Whether a single system block is foreign (non-official).
 * Fixes V5: ANY block matching a clone/harness signature (even embedded with
 * "You are Claude Code" or official prompts) is positively foreign!
 */
export function isForeignOfficialSystemBlock(block, { isSecurityMonitor = false, allowTitle = false } = {}) {
  const text = typeof block === 'string' ? block : block?.text
  if (typeof block === 'object' && block !== null && block.type !== undefined && block.type !== 'text') return false
  if (typeof text !== 'string' || !text.trim()) return false

  // V5: clone/third-party harness instructions embedded anywhere in the block ALWAYS mark it foreign.
  if (textMatchesCloneSignature(text)) return true

  // Pure billing block (no extra foreign lines attached)
  if (isPureBillingLineBlock(text)) return false

  // If a block starts with billing header AND has extra non-billing lines, it's foreign unless standalone identity
  if (/^[ \t]*x-anthropic-billing-header:/i.test(text)) {
    const rest = text.split(/\r?\n/).slice(1).join('\n').trim()
    if (rest && !KNOWN_OFFICIAL_SYSTEM_SET.has(rest)) return true
    return false
  }

  const trimmed = text.trim()
  if (KNOWN_OFFICIAL_SYSTEM_SET.has(trimmed)) return false
  if (isOfficialAgentPromptText(trimmed)) return false
  if (classifySystemText(text) !== 'other') return false
  if (/^[ \t]*# Environment\b/m.test(text)) return false
  if (isAnchoredOfficialPrefix(text, { allowChild: true, allowTitle })) return false
  if (isCoworkApplicationDetailsBlock(text)) return false
  if (
    isSecurityMonitor &&
    (findSecurityMonitorSystemBlock(text) !== null || trimmed.startsWith('## Session Context'))
  ) {
    return false
  }

  return true
}

export function hasForeignOfficialSystem(system, { isSecurityMonitor = false, allowTitle = false } = {}) {
  const blocks = extractSystemBlockTexts(system)
  return blocks.some((text) => isForeignOfficialSystemBlock({ type: 'text', text }, { isSecurityMonitor, allowTitle }))
}

function hasOpenAIToolShape(body = {}) {
  const tools = Array.isArray(body?.tools) ? body.tools : []
  if (tools.some((tool) => tool && (tool.type === 'function' || (tool.function && !tool.name)))) return true
  const choice = body?.tool_choice
  return !!(choice && typeof choice === 'object' && String(choice.type || '').toLowerCase() === 'function')
}

function singleTurnText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content) || content.length !== 1) return null
  const block = content[0]
  return block?.type === 'text' && typeof block.text === 'string' ? block.text : null
}

function sessionMatchesUserId(sessionHeader, userId) {
  if (!sessionHeader || !userId) return false
  const needle = sessionHeader.toLowerCase()
  return [userId.sessionId, userId.parentSessionId, userId.rootSessionId].some(
    (id) => id && id.toLowerCase() === needle,
  )
}

function isQuotaProbeBody(body) {
  if (body?.max_tokens !== 1 || body.system != null) return false
  if (Array.isArray(body.tools) ? body.tools.length : body.tools != null) return false
  const messages = Array.isArray(body.messages) ? body.messages : []
  if (messages.length !== 1 || messages[0]?.role !== 'user') return false
  return singleTurnText(messages[0].content) === 'quota'
}

function isSideQueryBody(body, billing, blocks) {
  if (!billing.present || !billing.valid) return false
  const second = String(blocks[1] || '')
  if (!SIDE_QUERY_IDENTITY_PREFIXES.some((prefix) => second.startsWith(prefix))) return false
  const messages = Array.isArray(body?.messages) ? body.messages : []
  if (messages.length !== 1 || messages[0]?.role !== 'user') return false
  const text = singleTurnText(messages[0].content) ?? ''
  const tools = body?.tools == null ? [] : body.tools
  if (!Array.isArray(tools)) return false
  if (tools.length === 0) return text.startsWith('\nWeb page content:\n---\n')
  return (
    tools.length === 1 &&
    /^web_search_\d+$/.test(String(tools[0]?.type ?? '')) &&
    tools[0]?.name === 'web_search' &&
    text.startsWith('Perform a web search for the query: ')
  )
}

function hasTranscriptOrClassifyTool(body) {
  if (body?.tool_choice?.type === 'tool' && body.tool_choice.name === 'classify_result') return true
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (const m of messages) {
    const c = m?.content
    if (typeof c === 'string' && c.includes('<transcript>')) return true
    if (Array.isArray(c) && c.some((b) => typeof b?.text === 'string' && b.text.includes('<transcript>'))) return true
  }
  return false
}

function hasSubstantialOfficialHarness(blocks) {
  if (blocks.length < 2) return false
  for (const block of blocks.slice(1)) {
    const kind = classifySystemText(block)
    if (['harness', 'guidance', 'main_full', 'env'].includes(kind) && block.length >= 80) return true
    if (isOfficialAgentPromptText(block) && block.length >= 120) return true
  }
  return false
}

/**
 * Single SSOT verifier for Official Claude Code traffic.
 *
 * @param {object} reqOrHeaders HTTP request or headers map
 * @param {object} body parsed request body
 * @param {{ rawBodyBytes?: Buffer|string|null, routing?: object|null, detectProxiedOfficialCc?: boolean|null, countTokens?: boolean }} [opts]
 */
export function verifyOfficialClaudeCode(reqOrHeaders = {}, body = {}, opts = {}) {
  const h = normalizeHeaders(reqOrHeaders)
  const ua = headerStr(h, 'user-agent')
  const uaStartsWithClaudeCli = CLAUDE_CLI_PREFIX_RE.test(ua)
  const countTokens = opts?.countTokens === true
  const detectProxied =
    typeof opts?.detectProxiedOfficialCc === 'boolean'
      ? opts.detectProxiedOfficialCc
      : opts?.routing != null
        ? opts.routing?.compatibility?.detect_proxied_official_cc !== false
        : false

  const safeBody = body && typeof body === 'object' ? body : {}
  const blocks = extractSystemBlockTexts(safeBody.system)
  const tools = Array.isArray(safeBody.tools) ? safeBody.tools : []
  const zeroTools = tools.length === 0
  const isSecurityMonitor = findSecurityMonitorSystemBlock(safeBody.system) !== null
  const userId = parseStrictOfficialUserId(safeBody?.metadata?.user_id)
  const uaParsed = STRICT_CLAUDE_CLI_UA_RE.exec(ua)
  const billing = verifyBillingHeader(safeBody.system, countTokens ? null : safeBody.messages, {
    uaVersion: uaStartsWithClaudeCli ? uaParsed?.[1] || '' : '',
    uaEntrypoint: uaStartsWithClaudeCli ? uaParsed?.[2] || '' : '',
    rawBodyBytes: opts?.rawBodyBytes ?? null,
  })

  const failReasons = []
  let hasNonOfficialTools = false
  let cloneId = null

  // --- Gate 0: Hard Disqualifiers (Fail-Closed) ---
  if (hasOpenAIToolShape(safeBody)) {
    failReasons.push('openai_tool_shape')
  }

  cloneId = detectCloneHarness(h, safeBody)
  if (cloneId) {
    failReasons.push(`clone:${cloneId}`)
  }

  for (const tool of tools) {
    if (!isOfficialClaudeToolName(tool?.name, tool, { allowClassifierTool: isSecurityMonitor })) {
      hasNonOfficialTools = true
      const label = String(tool?.name || tool?.type || 'unknown').slice(0, 64)
      failReasons.push(`non_official_tool:${label}`)
    }
  }

  if (billing.present && !billing.valid) {
    failReasons.push(...billing.failReasons)
  }

  const hasForeignSystem = hasForeignOfficialSystem(safeBody.system, {
    isSecurityMonitor,
    allowTitle: zeroTools,
  })

  const makeResult = (tier, extraFail = []) => {
    const reasons = extraFail.length ? [...failReasons, ...extraFail] : failReasons
    const official = tier === 'official_direct' || tier === 'official_auxiliary' || tier === 'official_proxied'
    const direct = tier === 'official_direct' || tier === 'official_auxiliary'
    const proxied = tier === 'official_proxied'
    const auxiliary = tier === 'official_auxiliary'
    return {
      tier,
      official,
      direct,
      proxied,
      auxiliary,
      allowPassthrough: official && !hasForeignSystem && !hasNonOfficialTools && !cloneId,
      hasForeignSystem,
      hasNonOfficialTools,
      cloneId,
      failReasons: reasons,
      userId,
      billing,
    }
  }

  if (failReasons.length > 0) {
    return makeResult(uaStartsWithClaudeCli ? 'spoofed_cc' : 'third_party')
  }

  // --- Direct CC Path (UA starts with claude-cli/) — NEVER falls back to Tier 3 ---
  if (uaStartsWithClaudeCli) {
    const headerCheck = verifyDirectClaudeCodeHeaders(h, { requireCodeBeta: false })
    if (!headerCheck.ok) {
      return makeResult('spoofed_cc', headerCheck.failReasons)
    }

    // Tier 2a: count_tokens (requires claude-code beta + H1 + H2, Gate 0 already passed)
    if (countTokens) {
      if (!headerCheck.hasCodeBeta) return makeResult('spoofed_cc', ['missing_claude_code_beta'])
      return makeResult('official_auxiliary')
    }

    // All non-count_tokens direct CC calls require strict user_id + matching session header
    if (!userId) return makeResult('spoofed_cc', ['invalid_user_id'])
    if (!sessionMatchesUserId(headerCheck.sessionId, userId)) {
      return makeResult('spoofed_cc', ['session_mismatch'])
    }

    // Tier 2b: CLI quota probe (makeTestQuery — no claude-code beta required)
    if (isQuotaProbeBody(safeBody)) {
      return makeResult('official_auxiliary')
    }

    // Tier 2c: WebSearch / WebFetch side queries (no claude-code beta required)
    if (isSideQueryBody(safeBody, billing, blocks)) {
      return makeResult('official_auxiliary')
    }

    // Tier 2d: Auto-mode security monitor classifier
    if (isSecurityMonitor && hasTranscriptOrClassifyTool(safeBody)) {
      return makeResult('official_auxiliary')
    }

    const anchorIdx = billing.present ? 1 : 0
    const anchorBlock = blocks[anchorIdx] || ''
    const requestClass = headerStr(h, 'x-claude-code-request-class').toLowerCase()

    // Tier 2e: Compaction / title / summary / explore child side-calls without claude-code beta.
    // Both explicit auxiliary request classes and 0-tool child/title side-calls MUST carry an
    // anchored official system prefix (matches Go protofront isDirectAuxiliaryRequest 1:1).
    const anchorTrimmed = String(anchorBlock || '').trimStart()
    const isChildOrTitleOnly =
      OFFICIAL_CHILD_ONLY_PREFIXES.some((p) => anchorTrimmed.startsWith(p)) ||
      anchorTrimmed.startsWith(OFFICIAL_TITLE_PREFIX)
    const isExplicitAuxClass =
      AUXILIARY_REQUEST_CLASSES.has(requestClass) &&
      isAnchoredOfficialPrefix(anchorBlock, { allowChild: true, allowTitle: zeroTools })
    if (!headerCheck.hasCodeBeta && (isExplicitAuxClass || (zeroTools && isChildOrTitleOnly))) {
      return makeResult('official_auxiliary')
    }

    // Tier 1: Standard Direct Official CC
    if (!headerCheck.hasCodeBeta) return makeResult('spoofed_cc', ['missing_claude_code_beta'])
    if (!isAnchoredOfficialPrefix(anchorBlock, { allowChild: true, allowTitle: zeroTools })) {
      return makeResult('spoofed_cc', ['missing_official_system_prefix'])
    }

    return makeResult('official_direct')
  }

  // --- Tier 3: Proxied / Relayed Official CC (ONLY when detectProxied && !claude-cli/ UA && !countTokens) ---
  if (!detectProxied || countTokens) {
    return makeResult('third_party', [countTokens ? 'proxied_count_tokens_disallowed' : 'proxied_detection_disabled'])
  }

  if (hasForeignSystem) {
    return makeResult('third_party', ['foreign_system_block'])
  }

  // Tier 3a: Anchored verified billing header with cc_version=<ver>.<fp3> + valid fp3 + no cch=00000
  if (billing.present) {
    if (!billing.fp3 || !billing.fp3Verified) {
      return makeResult('third_party', ['proxied_fp3_required'])
    }
    if (!ALLOWED_PROXIED_ENTRYPOINTS.has(billing.entrypoint)) {
      return makeResult('third_party', ['proxied_entrypoint_not_allowed'])
    }
    const secondBlock = blocks[1] || ''
    if (OPTIONAL_USER_ID_PROXIED_ENTRYPOINTS.has(billing.entrypoint)) {
      // user_id is optional for claude-desktop-3p / sdk-ts, BUT if supplied it MUST be strictly valid!
      if (safeBody?.metadata?.user_id != null && !userId) {
        return makeResult('third_party', ['invalid_user_id'])
      }
      if (!isAnchoredOfficialPrefix(secondBlock, { allowChild: false, allowTitle: zeroTools })) {
        return makeResult('third_party', ['missing_official_system_prefix'])
      }
      return makeResult('official_proxied')
    }

    // Other allowed entrypoints (cli, sdk-cli, local-agent, claude-vscode, ...): require strict user_id!
    if (!userId) {
      return makeResult('third_party', ['invalid_user_id'])
    }
    const validSystem =
      isAnchoredOfficialPrefix(secondBlock, { allowChild: true, allowTitle: zeroTools }) || isSecurityMonitor
    if (!validSystem) {
      return makeResult('third_party', ['missing_official_system_prefix'])
    }
    return makeResult('official_proxied')
  }

  // Tier 3b: Billing header stripped by relay (must not have an unanchored/forged billing mention)
  if (billing.unanchoredBilling) {
    return makeResult('third_party', ['unanchored_billing_header'])
  }
  if (!userId) {
    return makeResult('third_party', ['invalid_user_id'])
  }
  const betas = betaTokens(h)
  if (!betas.includes(CLAUDE_CODE_BETA)) {
    return makeResult('third_party', ['missing_claude_code_beta'])
  }

  const firstBlock = blocks[0] || ''
  const multiBlockOfficial =
    (isAnchoredOfficialPrefix(firstBlock, { allowChild: true, allowTitle: false }) &&
      hasSubstantialOfficialHarness(blocks)) ||
    isSecurityMonitor
  const verifiedZeroToolWarmup =
    zeroTools &&
    isAnchoredOfficialPrefix(firstBlock, { allowChild: false, allowTitle: false }) &&
    betas.includes(INTERLEAVED_THINKING_BETA)

  if (multiBlockOfficial || verifiedZeroToolWarmup) {
    return makeResult('official_proxied')
  }

  return makeResult('third_party', ['insufficient_proxied_signals'])
}
