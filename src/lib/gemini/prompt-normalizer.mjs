/**
 * Unified multi-CLI prompt normalization pipeline for the Gemini / CRAGGemini channel (SSOT).
 *
 * Design invariants:
 * - Pure & deterministic: byte-identical output for identical input (preserves prompt cache prefix).
 * - Strictly idempotent: `normalize(normalize(x)) === normalize(x)` (preserves failover & resume digest chains).
 * - Fenced-code-block protected: semantic rules never mutate Markdown ```...``` or ~~~...~~~ blocks.
 * - Minimal semantic diff: neutralizes conflicting third-party CLI identity assertions, stock offensive/dual-use
 *   enumeration parentheticals, cross-vendor billing/telemetry lines, and colliding `agy` official host tags
 *   while preserving user intent, coding rules, safety requirements, and factual brand references.
 * - Copy-on-write: never mutates caller request objects or arrays in place.
 */

export const CRAGGEMINI_PROMPT_NORMALIZATION_MODES = Object.freeze(['auto', 'strict', 'off'])

const FENCED_CODE_BLOCK_RE = /(?:```[\s\S]*?```|~~~[\s\S]*?~~~)/g
const ANSI_ESCAPE_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g
const ILLEGAL_CONTROL_RE = /[^\P{Cc}\n\r\t]/gu
const LEADING_SLASH_TOKEN_RE = /(^|\p{White_Space})(\/+)/gu

const SYSTEM_ENVELOPE_RE =
  /<(system-reminder|system_reminder|system|system_instruction|instructions|user_instructions|permissions\s+instructions|environment_details|agent_instructions)(\b[^>]*)>([\s\S]*?)<\/\1>/gi
const SYSTEM_INSTRUCTIONS_HEADER_RE =
  /^(\[System Instructions\][ \t]*\r?\n)([\s\S]*?)(?=\r?\n\r?\n(?:\[User|User:|\[Conversation)|$)/

const HOST_RESERVED_TAG_MAP = Object.freeze({
  identity: 'caller_identity',
  user_request: 'caller_request',
  user_rules: 'caller_user_rules',
  user_information: 'caller_user_information',
})
const HOST_RESERVED_TAG_RE = /<(identity|USER_REQUEST|user_rules|user_information)(\b[^>]*)>([\s\S]*?)<\/\1>/gi

const SECURITY_POLICY_ANCHOR_RE =
  /\b(?:dual-use|authorized\s+security|authorization\s+context|defensive\s+security|refuse\s+requests|malicious\s+purposes|pentest(?:ing)?|security\s+(?:testing|research|assessment))\b/i
const SECURITY_PAREN_RE = /[ \t]*\(([^)\n]{6,240})\)/g
const OFFENSIVE_CLUSTER_RE =
  /\b(?:C2\s+frameworks?|command[- ]and[- ]control|exploit\s+development|credential\s+(?:testing|harvesting|dumping|stuffing)|supply\s+chain\s+compromise|ransomware|malware|reverse\s+shells?|rootkits?|keyloggers?|botnets?|zero-day|0-day)\b/i

const LEADING_CLI_IDENTITY_RE =
  /^\s*(?:(?:You\s+are|Act\s+as)\s+(?:Claude\s+Code|a\s+Claude\s+agent|Anthropic\s+Claude\s+Agent\s+SDK|OpenCode|(?:OpenAI\s+)?Codex|a\s+coding\s+agent\s+running\s+in\s+the\s+Codex\s+CLI|an\s+expert\s+coding\s+assistant\s+operating\s+inside\s+pi|omp(?:'s|’s)\s+trusted\s+coding\s+assistant|Cline|Roo\s+Code|Kilo\s+Code|Cursor|Windsurf|GitHub\s+Copilot|Aider|Gemini\s+CLI|Gemini\s+Code\s+Assist|Factory\s+Droid|Kiro|Trae|Devin|Augment\s+Code|Zed\s+AI|OpenClaw|Oh-My-Pi|Antigravity|(?:Continue|Amp|Cascade|Droid|Roo|Hermes|Pi)\s*,|(?:Claude|ChatGPT|GPT-[0-9][0-9a-z.-]{0,20})\s*,)|你是\s*(?:Claude\s*Code|OpenCode|OpenAI\s*Codex|Codex|Cursor|Cline|Roo\s*Code|Kilo\s*Code|Windsurf|Cascade|GitHub\s*Copilot|Aider|Gemini\s*CLI|Gemini\s*Code\s+Assist|Factory\s*Droid|Kiro|Trae|OpenClaw|Antigravity))/i

export function normalizePromptNormalizationMode(value) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
  if (raw === 'strict') return 'strict'
  if (raw === 'off' || raw === 'none' || raw === 'disabled' || raw === 'false') return 'off'
  return 'auto'
}

/**
 * Apply `transform(segment)` strictly to text outside Markdown fenced code blocks
 * (```...``` and ~~~...~~~), preserving fenced code verbatim.
 */
export function mapOutsideFencedCode(text, transform) {
  if (typeof text !== 'string' || !text) return ''
  let out = ''
  let lastIndex = 0
  let changed = false
  FENCED_CODE_BLOCK_RE.lastIndex = 0
  for (const match of text.matchAll(FENCED_CODE_BLOCK_RE)) {
    const before = text.slice(lastIndex, match.index)
    const nextBefore = before ? transform(before) : before
    if (nextBefore !== before) changed = true
    out += nextBefore + match[0]
    lastIndex = match.index + match[0].length
  }
  const tail = text.slice(lastIndex)
  const nextTail = tail ? transform(tail) : tail
  if (nextTail !== tail) changed = true
  out += nextTail
  return changed ? out : text
}

function isVendorBillingLine(line) {
  const trimmed = line.trim().toLowerCase()
  if (!trimmed) return false
  if (/^(?:x-[a-z0-9_-]*billing[a-z0-9_-]*|[a-z0-9_-]+-billing-(?:header|metadata|token|info)):/.test(trimmed)) {
    return true
  }
  if (/^x-[a-z0-9_-]+:/.test(trimmed) && /(?:cc_version=|cch=|cc_entrypoint=)/.test(trimmed)) {
    return true
  }
  if (
    /^x-(?:claude-code|codex|opencode|cursor|cline|aider)-(?:billing|telemetry|attribution|session-meta)[a-z0-9_-]*:/.test(
      trimmed,
    )
  ) {
    return true
  }
  return trimmed.includes('cc_version=') && trimmed.includes('cch=')
}

function stripBillingSegment(segment) {
  const lines = segment.split('\n')
  let removed = false
  const kept = lines.filter((line) => {
    if (isVendorBillingLine(line)) {
      removed = true
      return false
    }
    return true
  })
  if (!removed) return { text: segment, removed: false }
  return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n'), removed: true }
}

/**
 * Strip cross-vendor billing/attribution header lines (e.g. Anthropic `x-anthropic-billing-header:`,
 * `cc_version=`/`cch=`) strictly outside Markdown fenced code blocks.
 */
export function stripVendorBillingLines(text) {
  if (typeof text !== 'string' || !text) return ''
  let anyRemoved = false
  const out = mapOutsideFencedCode(text, (segment) => {
    const cleaned = stripBillingSegment(segment)
    if (cleaned.removed) anyRemoved = true
    return cleaned.text
  })
  return anyRemoved ? out.trim() : text
}

/**
 * Strip ANSI escape sequences and illegal Unicode Cc control characters (keeping \n, \r, \t)
 * and repair lone UTF-16 surrogates so CRAGGemini (`valid_text` / `valid_system_prompt`)
 * and `gemini-host.py` never reject pasted terminal logs or binary artifacts.
 */
export function stripIllegalControlChars(text) {
  if (typeof text !== 'string' || !text) return ''
  return text.toWellFormed().replace(ANSI_ESCAPE_RE, '').replace(ILLEGAL_CONTROL_RE, '')
}

/**
 * Neutralize whitespace-preceded `/` tokens (e.g. `/etc/hosts`, `/v1/messages`, `// comment`,
 * `a / b`, `/help`) with a non-whitespace, non-control zero-width separator (`U+200B`) so
 * CRAGGemini's `valid_text` and `agy`'s TUI slash-command parser treat them as ordinary text
 * without altering path semantics.
 */
export function escapeNativeTuiSlashes(text) {
  if (typeof text !== 'string' || !text) return ''
  return text.replace(LEADING_SLASH_TOKEN_RE, '$1\u200B$2')
}

export function sanitizeNativeTuiText(text) {
  return escapeNativeTuiSlashes(stripIllegalControlChars(text))
}

function normalizeGenericDualUsePolicy(segment) {
  if (!SECURITY_POLICY_ANCHOR_RE.test(segment) || !OFFENSIVE_CLUSTER_RE.test(segment)) {
    return segment
  }
  const lines = segment.split('\n')
  let changed = false
  const nextLines = lines.map((line) => {
    if (!SECURITY_POLICY_ANCHOR_RE.test(line) || !OFFENSIVE_CLUSTER_RE.test(line)) return line
    SECURITY_PAREN_RE.lastIndex = 0
    let lineChanged = false
    const updated = line.replace(SECURITY_PAREN_RE, (full, inner) => {
      if (!OFFENSIVE_CLUSTER_RE.test(inner)) return full
      lineChanged = true
      return ''
    })
    if (!lineChanged) return line
    changed = true
    return updated.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([.,;:])/g, '$1')
  })
  return changed ? nextLines.join('\n') : segment
}

/**
 * Ordered declarative rule table for outbound CRAGGemini semantic normalization.
 * Rules run sequentially on non-code-block text segments and must be pure + idempotent.
 */
export const NORMALIZATION_RULES = Object.freeze([
  {
    id: 'cli_identity_claude_code',
    category: 'cli_identity',
    modes: ['auto', 'strict'],
    apply: (segment) =>
      segment
        .replace(
          /\bYou\s+are\s+Claude\s+Code(?:\s*,\s*Anthropic(?:'s|’s)\s+official\s+CLI\s+for\s+Claude)?\b/gi,
          'You are a coding assistant',
        )
        .replace(
          /\bYou\s+are\s+a\s+Claude\s+agent\s*,\s*built\s+on\s+Anthropic(?:'s|’s)\s+Claude\s+Agent\s+SDK\b/gi,
          'You are a coding assistant',
        )
        .replace(/\bYou\s+are\s+Anthropic\s+Claude\s+Agent\s+SDK\b/gi, 'You are a coding assistant')
        .replace(
          /\bYou\s+are\s+a\s+file\s+search\s+specialist\s+for\s+Claude\s+Code\b/gi,
          'You are a file search specialist',
        ),
  },
  {
    id: 'cli_identity_vendor_model',
    category: 'cli_identity',
    modes: ['auto', 'strict'],
    apply: (segment) =>
      segment.replace(
        /\bYou\s+are\s+(?:Claude|ChatGPT|GPT-[0-9][0-9a-z.-]{0,20})\s*,\s*(?:an?\s+(?:AI\s+)?(?:coding\s+)?assistant\s+)?(?:created|made|built|developed|trained)\s+by\s+(?:Anthropic|OpenAI)\b/gi,
        'You are a helpful AI assistant',
      ),
  },
  {
    id: 'cli_identity_codex',
    category: 'cli_identity',
    modes: ['auto', 'strict'],
    apply: (segment) =>
      segment
        .replace(
          /\bYou\s+are\s+a\s+coding\s+agent\s+running\s+in\s+the\s+Codex\s+CLI\s*,\s*a\s+terminal-based\s+coding\s+assistant\.(?:\s*Codex\s+CLI\s+is\s+an\s+open[- ]source\s+project\s+led\s+by\s+OpenAI\.)?/gi,
          'You are a coding agent running in a terminal-based coding assistant.',
        )
        .replace(
          /\bYou\s+are\s+(?:OpenAI\s+)?Codex(?:\s*,\s*(?:based\s+on\s+GPT-[0-9a-z.-]{1,32}|OpenAI(?:'s|’s)\s+(?:coding|software\s+engineering)\s+(?:agent|CLI|assistant)|an?\s+coding\s+agent\s+(?:based\s+on\s+GPT-[0-9a-z.-]{1,32}|from\s+OpenAI)))?\b/gi,
          'You are a coding assistant',
        ),
  },
  {
    id: 'cli_identity_pi',
    category: 'cli_identity',
    modes: ['auto', 'strict'],
    apply: (segment) =>
      segment
        .replace(
          /\bYou\s+are\s+an\s+expert\s+coding\s+assistant\s+operating\s+inside\s+pi\s*,\s*a\s+coding\s+agent\s+harness\b/gi,
          'You are an expert coding assistant operating inside a coding agent harness',
        )
        .replace(
          /\bYou\s+are\s+omp(?:'s|’s)\s+trusted\s+coding\s+assistant\b/gi,
          'You are a trusted coding assistant',
        ),
  },
  {
    id: 'cli_identity_opencode',
    category: 'cli_identity',
    modes: ['auto', 'strict'],
    apply: (segment) =>
      segment.replace(
        /\bYou\s+are\s+OpenCode(?:\s*,\s*(?:the\s+best\s+(?:CLI\s+)?coding\s+agent|an?\s+(?:open-source\s+)?(?:interactive\s+)?(?:CLI\s+)?(?:coding\s+)?(?:agent|assistant)))?\b/gi,
        'You are a coding assistant',
      ),
  },
  {
    id: 'cli_identity_named_cli',
    category: 'cli_identity',
    modes: ['auto', 'strict'],
    apply: (segment) =>
      segment.replace(
        /\b(You\s+are|Act\s+as)\s+(?:Cline|Roo\s+Code|Kilo\s+Code|Cursor|Windsurf|GitHub\s+Copilot|Aider|Gemini\s+CLI|Gemini\s+Code\s+Assist|Factory\s+Droid|Kiro|Trae|Devin|Augment\s+Code|Zed\s+AI|OpenClaw|Oh-My-Pi|Antigravity)\b/gi,
        (_match, verb) => (/^act/i.test(verb) ? 'Act as a coding assistant' : 'You are a coding assistant'),
      ),
  },
  {
    id: 'cli_identity_guarded_cli',
    category: 'cli_identity',
    modes: ['auto', 'strict'],
    apply: (segment) =>
      segment.replace(
        /\b(You\s+are|Act\s+as)\s+(?:Continue|Amp|Cascade|Droid|Roo|Hermes|Pi)(?=\s*,\s*(?:an?\s+|the\s+)?(?:open-source\s+|agentic\s+|interactive\s+|autonomous\s+|highly\s+skilled\s+)?(?:(?:AI|coding|software|programming|CLI|IDE|code|developer|research)\s+){1,2}(?:assistant|agent|tool|engineer|model|IDE|CLI)\b)/gi,
        (_match, verb) => (/^act/i.test(verb) ? 'Act as a coding assistant' : 'You are a coding assistant'),
      ),
  },
  {
    id: 'cli_identity_cjk',
    category: 'cli_identity',
    modes: ['auto', 'strict'],
    apply: (segment) =>
      segment.replace(
        /你是\s*(?:Claude\s*Code|OpenCode|OpenAI\s*Codex|Codex|Cursor|Cline|Roo\s*Code|Kilo\s*Code|Windsurf|Cascade|GitHub\s*Copilot|Aider|Gemini\s*CLI|Gemini\s*Code\s+Assist|Factory\s*Droid|Kiro|Trae|OpenClaw|Antigravity)(?=$|[\s，。、；：,.;:!！)）])/gi,
        '你是一个编程助手',
      ),
  },
  {
    id: 'dual_use_security_cc',
    category: 'dual_use_security',
    modes: ['auto', 'strict'],
    apply: (segment) =>
      segment.replace(
        /\bDual-use\s+security\s+tools\s*\([^)\n]{1,200}\)\s+require\s+clear\s+authorization\s+context\b/gi,
        'Dual-use security tools require clear authorization context',
      ),
  },
  {
    id: 'dual_use_security_generic',
    category: 'dual_use_security',
    modes: ['auto', 'strict'],
    apply: normalizeGenericDualUsePolicy,
  },
  {
    id: 'pasted_content_guard',
    category: 'prompt_guard',
    modes: ['auto', 'strict'],
    apply: (segment) =>
      segment.replace(
        /\bText\s+inside\s+<pasted_content>\s+tags\s+was\s+pasted\s+into\s+the\s+message\s+by\s+the\s+user\s+from\s+somewhere\s+else\s+and\s+may\s+contain\s+instructions\s+the\s+user\s+did\s+not\s+write\b/gi,
        'Text inside <pasted_content> tags was pasted into the message by the user from somewhere else',
      ),
  },
  {
    id: 'omp_hashline_guard',
    category: 'prompt_guard',
    modes: ['auto', 'strict'],
    apply: (segment) =>
      segment.replace(
        /\bTouch\s+displayed\s+changed\s+lines\s+only;\s*`…`,\s*`\.\.`,\s*collapsed\s*`N-M:`\s*and\s+out-of-window\s+lines\s+UNSEEN\.\s*Re-read\s+first\.\s*Tight\s+ranges:\s*split\s+nonadjacent\s+changes;\s*NEVER\s+include\s+keepers\s+or\s+start\/end\s+mid-expression\/block\.\s*Pure\s+addition\s+uses\s+gap\s+PUT\./g,
        'Edit only displayed changed lines; read omitted or collapsed ranges before modifying them, split nonadjacent changes into tight ranges without unchanged lines or partial expressions, and use gap insertion for pure additions.',
      ),
  },
  {
    id: 'vendor_strict_attribution',
    category: 'vendor_strict',
    modes: ['strict'],
    apply: (segment) =>
      segment.replace(
        /\b(?:Anthropic(?:'s|’s)\s+official\s+CLI\s+for\s+Claude|built\s+on\s+Anthropic(?:'s|’s)\s+Claude\s+Agent\s+SDK|OpenAI(?:'s|’s)\s+official\s+coding\s+CLI)\b/gi,
        'a coding CLI',
      ),
  },
])

function headerValue(headers, key) {
  if (!headers || typeof headers !== 'object') return ''
  const want = key.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() !== want || v == null || v === '') continue
    return String(Array.isArray(v) ? v[0] : v)
  }
  return ''
}

function extractBodySystemSample(body) {
  const si = body?.systemInstruction
  if (typeof si === 'string') return si.slice(0, 4000)
  if (si && typeof si === 'object' && Array.isArray(si.parts)) {
    return si.parts
      .map((p) => (p && typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n')
      .slice(0, 4000)
  }
  return ''
}

function extractFirstUserSample(body) {
  if (!Array.isArray(body?.contents)) return ''
  const firstUser = body.contents.find((c) => c && (c.role === 'user' || !c.role))
  if (!firstUser || !Array.isArray(firstUser.parts)) return ''
  return firstUser.parts
    .map((p) => (p && typeof p.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('\n')
    .slice(0, 2000)
}

/**
 * Signal-only CLI family classifier for observability (`hop_meta.prompt_normalization.cli_family`).
 * Never gates semantic normalization rules.
 */
export function detectCliFamily({ headers = {}, systemText = '', firstUserText = '' } = {}) {
  const ua = `${headerValue(headers, 'user-agent')} ${headerValue(headers, 'x-client-name')}`.toLowerCase()
  const sample = `${String(systemText || '').slice(0, 4000)}\n${String(firstUserText || '').slice(0, 2000)}`
  if (
    /claude-cli|claude-code/.test(ua) ||
    /\bYou\s+are\s+Claude\s+Code\b|Claude\s+Agent\s+SDK|x-anthropic-billing-header:|cc_version=/i.test(sample)
  ) {
    return 'claude_code'
  }
  if (
    /codex[_-]?cli/.test(ua) ||
    /\bYou\s+are\s+(?:OpenAI\s+)?Codex\b|running\s+in\s+the\s+Codex\s+CLI|<permissions\s+instructions>/i.test(sample)
  ) {
    return 'codex'
  }
  if (/\bopencode\b/.test(ua) || /\bYou\s+are\s+OpenCode\b/i.test(sample)) return 'opencode'
  if (
    /gemini-cli|antigravity/.test(ua) ||
    /\bYou\s+are\s+(?:Gemini\s+CLI|Gemini\s+Code\s+Assist|Antigravity)\b/i.test(sample)
  ) {
    return 'gemini_cli'
  }
  if (/\bcursor\b/.test(ua) || /\bYou\s+are\s+Cursor\b/i.test(sample)) return 'cursor'
  if (/\bcline\b/.test(ua) || /\bYou\s+are\s+Cline\b/i.test(sample)) return 'cline'
  if (/\broo[-_\s]?code\b/.test(ua) || /\bYou\s+are\s+Roo(?:\s+Code)?\b/i.test(sample)) return 'roo_code'
  if (/\bkilo[-_\s]?code\b/.test(ua) || /\bYou\s+are\s+Kilo\s+Code\b/i.test(sample)) return 'kilo_code'
  if (/\bwindsurf\b|\bcodeium\b/.test(ua) || /\bYou\s+are\s+(?:Windsurf|Cascade)\b/i.test(sample)) return 'windsurf'
  if (/\baider\b/.test(ua) || /\bYou\s+are\s+Aider\b/i.test(sample)) return 'aider'
  if (/\bcopilot\b/.test(ua) || /\bYou\s+are\s+GitHub\s+Copilot\b/i.test(sample)) return 'copilot'
  if (/\bcontinue\//.test(ua) || /\bYou\s+are\s+Continue,/i.test(sample)) return 'continue'
  if (/\bamp[-/]/.test(ua) || /\bYou\s+are\s+Amp,/i.test(sample)) return 'amp'
  if (/\bfactory[-_]?droid\b|\bdroid\//.test(ua) || /\bYou\s+are\s+(?:Factory\s+)?Droid\b/i.test(sample)) {
    return 'droid'
  }
  if (/hermes-agent|hermes\//.test(ua) || /\bYou\s+are\s+Hermes\b/i.test(sample)) return 'hermes'
  if (/openclaw|clawdbot|moltbot/.test(ua) || /\bYou\s+are\s+OpenClaw\b|inside\s+openclaw/i.test(sample)) {
    return 'openclaw'
  }
  if (
    /oh-my-pi|\bomp\/|\bpi\/\d/.test(ua) ||
    /\bYou\s+are\s+(?:Oh-My-Pi|Pi,|omp(?:'s|’s)\s+trusted\s+coding\s+assistant)|operating\s+inside\s+pi\s*,\s*a\s+coding\s+agent\s+harness/i.test(
      sample,
    )
  ) {
    return 'oh_my_pi'
  }
  return 'generic'
}

function deconflictHostReservedTags(text, appliedRules) {
  let matched = false
  const out = mapOutsideFencedCode(text, (segment) => {
    HOST_RESERVED_TAG_RE.lastIndex = 0
    return segment.replace(HOST_RESERVED_TAG_RE, (_full, tag, attrs, inner) => {
      const mapped = HOST_RESERVED_TAG_MAP[String(tag).toLowerCase()]
      if (!mapped) return _full
      matched = true
      return `<${mapped}${attrs || ''}>${inner}</${mapped}>`
    })
  })
  if (matched) appliedRules.add('host_tag_deconflict')
  return out
}

function applySemanticRules(text, { mode = 'auto', categories = null, appliedRules = new Set() } = {}) {
  if (typeof text !== 'string' || !text || mode === 'off') return text
  return mapOutsideFencedCode(text, (segment) => {
    let current = segment
    for (const rule of NORMALIZATION_RULES) {
      if (!rule.modes.includes(mode)) continue
      if (categories && !categories.has(rule.category)) continue
      const next = rule.apply(current)
      if (next !== current) {
        appliedRules.add(rule.id)
        current = next
      }
    }
    return current
  })
}

/**
 * Normalize a system prompt text block for CRAGGemini (`antigravity`).
 * Runs transport hygiene (UTF-16/ANSI/Cc + billing lines), semantic CLI/dual-use rules,
 * and optional `official_full` host-tag de-confliction while protecting fenced code blocks.
 */
export function normalizeSystemText(
  text,
  { mode = 'auto', preset = 'official_full', deconflictHostTags = false, appliedRules = new Set() } = {},
) {
  if (typeof text !== 'string' || !text) return text
  let current = stripIllegalControlChars(text)
  if (current !== text) appliedRules.add('transport_control_chars')

  const afterBilling = stripVendorBillingLines(current)
  if (afterBilling !== current) {
    appliedRules.add('billing_header')
    current = afterBilling
  }

  if (mode !== 'off') {
    current = applySemanticRules(current, { mode, appliedRules })
    if (deconflictHostTags && preset === 'official_full') {
      current = deconflictHostReservedTags(current, appliedRules)
    }
  }
  return current
}

function normalizeSystemInstructionField(systemInstruction, opts) {
  if (!systemInstruction) return { value: systemInstruction, changed: false, emptied: false }
  if (typeof systemInstruction === 'string') {
    const next = normalizeSystemText(systemInstruction, opts)
    if (!next.trim()) return { value: undefined, changed: true, emptied: true }
    return { value: next, changed: next !== systemInstruction, emptied: false }
  }
  if (typeof systemInstruction === 'object' && Array.isArray(systemInstruction.parts)) {
    let changed = false
    const nextParts = []
    for (const part of systemInstruction.parts) {
      if (part && typeof part.text === 'string') {
        const nextText = normalizeSystemText(part.text, opts)
        if (nextText !== part.text) changed = true
        if (nextText.trim()) {
          nextParts.push(nextText === part.text ? part : { ...part, text: nextText })
        } else {
          changed = true
        }
      } else {
        nextParts.push(part)
      }
    }
    if (!nextParts.length) return { value: undefined, changed: true, emptied: true }
    return {
      value: changed ? { ...systemInstruction, parts: nextParts } : systemInstruction,
      changed,
      emptied: false,
    }
  }
  return { value: systemInstruction, changed: false, emptied: false }
}

function extractSystemText(systemInstruction) {
  if (!systemInstruction) return ''
  if (typeof systemInstruction === 'string') return systemInstruction.trim()
  if (typeof systemInstruction === 'object' && Array.isArray(systemInstruction.parts)) {
    return systemInstruction.parts
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim()
  }
  return ''
}

function normalizeContentPartText(text, { isFirstUserNoSystem, mode, appliedRules, scopesTouched }) {
  if (typeof text !== 'string' || !text || mode === 'off') return text
  let current = text
  let touchedEnvelope = false

  // 1. Normalize system-carrier XML envelopes embedded inside user/developer turns
  //    (e.g. `<system-reminder>`, `<instructions>`, `<permissions instructions>`, `<environment_details>`).
  SYSTEM_ENVELOPE_RE.lastIndex = 0
  if (SYSTEM_ENVELOPE_RE.test(current)) {
    SYSTEM_ENVELOPE_RE.lastIndex = 0
    const next = mapOutsideFencedCode(current, (segment) => {
      SYSTEM_ENVELOPE_RE.lastIndex = 0
      return segment.replace(SYSTEM_ENVELOPE_RE, (full, tag, attrs, inner) => {
        const cleanedInner = normalizeSystemText(inner, { mode, deconflictHostTags: false, appliedRules })
        if (cleanedInner === inner) return full
        touchedEnvelope = true
        return `<${tag}${attrs || ''}>${cleanedInner}</${tag}>`
      })
    })
    if (next !== current) current = next
  }

  // 2. Normalize leading `[System Instructions]` header section if present.
  if (current.startsWith('[System Instructions]')) {
    const next = current.replace(SYSTEM_INSTRUCTIONS_HEADER_RE, (full, header, body) => {
      const cleanedBody = normalizeSystemText(body, { mode, deconflictHostTags: false, appliedRules })
      if (cleanedBody === body) return full
      touchedEnvelope = true
      return `${header}${cleanedBody}`
    })
    if (next !== current) current = next
  }

  // 3. Relocated-system fallback: if the request has no top-level systemInstruction and the
  //    first user turn begins directly with a third-party CLI identity banner, normalize it.
  if (isFirstUserNoSystem && LEADING_CLI_IDENTITY_RE.test(current)) {
    const next = normalizeSystemText(current, { mode, deconflictHostTags: false, appliedRules })
    if (next !== current) {
      touchedEnvelope = true
      current = next
    }
  }

  // 4. Strict-mode safety net: scan ordinary user text (outside code blocks) for high-confidence
  //    dual-use offensive enumeration parentheticals.
  if (mode === 'strict') {
    const strictNext = applySemanticRules(current, {
      mode,
      categories: new Set(['dual_use_security']),
      appliedRules,
    })
    if (strictNext !== current) {
      scopesTouched.add('contents_strict')
      current = strictNext
    }
  }

  if (touchedEnvelope) scopesTouched.add('contents_envelope')
  if (current !== text) {
    // Re-enforce CRAGGemini TUI valid_text invariants on any mutated content part.
    current = sanitizeNativeTuiText(current)
    if (!current.trim()) return text
  }
  return current
}

function normalizeContentsField(contents, { hasSystemInstruction, mode, appliedRules, scopesTouched }) {
  if (!Array.isArray(contents) || !contents.length || mode === 'off') {
    return { value: contents, changed: false }
  }
  let anyChanged = false
  let seenFirstUser = false
  const nextContents = contents.map((turn) => {
    if (!turn || typeof turn !== 'object' || !Array.isArray(turn.parts)) return turn
    const isUser = !turn.role || turn.role === 'user'
    const isFirstUserNoSystem = isUser && !seenFirstUser && !hasSystemInstruction
    if (isUser) seenFirstUser = true
    let turnChanged = false
    const nextParts = turn.parts.map((part) => {
      if (!part || typeof part.text !== 'string' || part.thought === true) return part
      const nextText = normalizeContentPartText(part.text, {
        isFirstUserNoSystem,
        mode,
        appliedRules,
        scopesTouched,
      })
      if (nextText !== part.text) {
        turnChanged = true
        return { ...part, text: nextText }
      }
      return part
    })
    if (!turnChanged) return turn
    anyChanged = true
    return { ...turn, parts: nextParts }
  })
  return { value: anyChanged ? nextContents : contents, changed: anyChanged }
}

function normalizeToolsField(tools, { mode, appliedRules, scopesTouched }) {
  if (!Array.isArray(tools) || !tools.length || mode === 'off') {
    return { value: tools, changed: false }
  }
  let anyChanged = false
  const nextTools = tools.map((entry) => {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.functionDeclarations)) return entry
    let entryChanged = false
    const nextDecls = entry.functionDeclarations.map((decl) => {
      if (!decl || typeof decl !== 'object' || typeof decl.description !== 'string' || !decl.description) {
        return decl
      }
      const nextDesc = normalizeSystemText(decl.description, {
        mode,
        deconflictHostTags: false,
        appliedRules,
      })
      if (nextDesc !== decl.description) {
        entryChanged = true
        return { ...decl, description: nextDesc }
      }
      return decl
    })
    if (!entryChanged) return entry
    anyChanged = true
    scopesTouched.add('tools')
    return { ...entry, functionDeclarations: nextDecls }
  })
  return { value: anyChanged ? nextTools : tools, changed: anyChanged }
}

function measureTextBytes(body) {
  let total = 0
  const si = body?.systemInstruction
  if (typeof si === 'string') total += si.length
  else if (si && Array.isArray(si.parts)) {
    for (const p of si.parts) if (typeof p?.text === 'string') total += p.text.length
  }
  if (Array.isArray(body?.contents)) {
    for (const c of body.contents) {
      if (!Array.isArray(c?.parts)) continue
      for (const p of c.parts) if (typeof p?.text === 'string') total += p.text.length
    }
  }
  if (Array.isArray(body?.tools)) {
    for (const t of body.tools) {
      if (!Array.isArray(t?.functionDeclarations)) continue
      for (const d of t.functionDeclarations) if (typeof d?.description === 'string') total += d.description.length
    }
  }
  return total
}

/**
 * Single SSOT entry point for normalizing an outbound Gemini-shaped request body.
 *
 * - `target === 'antigravity'` (CRAGGemini OAuth): applies `preset` (`official_full` | `zero`),
 *   optional `globalPrompt`, transport hygiene, fenced-code-protected CLI/dual-use normalization
 *   across `systemInstruction`, `contents` system envelopes, and `tools[].description`, plus
 *   `official_full` host-tag de-confliction.
 * - `target === 'gemini'` (Direct Gemini API Key): lightweight hygiene only (billing-line strip +
 *   UTF-16 repair on `systemInstruction`), without injecting `system_prompt_mode` or altering
 *   caller personas.
 *
 * Returns `{ body, report }` where `report` contains strictly sanitized telemetry metadata.
 */
export function normalizeGeminiOutboundPrompt(body, { target = 'antigravity', policy = {}, headers = {} } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { body, report: null }
  }

  const appliedRules = new Set()
  const scopesTouched = new Set()
  const charsBefore = measureTextBytes(body)
  const cliFamily = detectCliFamily({
    headers,
    systemText: extractBodySystemSample(body),
    firstUserText: extractFirstUserSample(body),
  })

  // Direct Gemini API Key channel: hygiene-only, never inject `system_prompt_mode`.
  if (target !== 'antigravity') {
    let out = body
    if (body.systemInstruction != null) {
      const si = normalizeSystemInstructionField(body.systemInstruction, {
        mode: 'off',
        deconflictHostTags: false,
        appliedRules,
      })
      if (si.changed) {
        out = { ...body }
        if (si.value === undefined) delete out.systemInstruction
        else out.systemInstruction = si.value
        scopesTouched.add('system')
      }
    }
    const charsAfter = measureTextBytes(out)
    return {
      body: out,
      report: {
        profile: 'gemini_api',
        mode: 'hygiene',
        cli_family: cliFamily,
        changed: out !== body,
        rules_applied: [...appliedRules],
        scopes_touched: [...scopesTouched],
        chars_delta: charsAfter - charsBefore,
      },
    }
  }

  const rawPreset = String(policy?.preset ?? '')
    .trim()
    .toLowerCase()
    .replaceAll('_', '-')
  const preset =
    rawPreset === 'zero' || rawPreset === '0' || rawPreset === 'replace' || rawPreset === '0-inject'
      ? 'zero'
      : 'official_full'
  const mode = normalizePromptNormalizationMode(policy?.normalization)
  const globalPrompt =
    typeof policy?.globalPrompt === 'string' ? stripIllegalControlChars(policy.globalPrompt).trim() : ''

  const out = { ...body }
  const systemOpts = {
    mode,
    preset,
    deconflictHostTags: preset === 'official_full',
    appliedRules,
  }

  let systemChanged = false
  if (globalPrompt) {
    const existing = extractSystemText(out.systemInstruction)
    const merged = existing ? `${globalPrompt}\n\n${existing}` : globalPrompt
    const normalizedMerged = normalizeSystemText(merged, systemOpts)
    if (normalizedMerged.trim()) {
      out.systemInstruction = { parts: [{ text: normalizedMerged }] }
    } else {
      delete out.systemInstruction
    }
    systemChanged = true
  } else if (out.systemInstruction != null) {
    const si = normalizeSystemInstructionField(out.systemInstruction, systemOpts)
    if (si.changed) {
      if (si.value === undefined) delete out.systemInstruction
      else out.systemInstruction = si.value
      systemChanged = true
    }
  }
  if (systemChanged) scopesTouched.add('system')

  const hasSystemInstruction = out.systemInstruction != null
  const nextContents = normalizeContentsField(out.contents, {
    hasSystemInstruction,
    mode,
    appliedRules,
    scopesTouched,
  })
  if (nextContents.changed) out.contents = nextContents.value

  const nextTools = normalizeToolsField(out.tools, {
    mode,
    appliedRules,
    scopesTouched,
  })
  if (nextTools.changed) out.tools = nextTools.value

  out.system_prompt_mode = preset
  const charsAfter = measureTextBytes(out)

  return {
    body: out,
    report: {
      profile: 'craggemini',
      mode,
      preset,
      cli_family: cliFamily,
      changed: scopesTouched.size > 0,
      rules_applied: [...appliedRules],
      scopes_touched: [...scopesTouched],
      chars_delta: charsAfter - charsBefore,
    },
  }
}
