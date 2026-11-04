/**
 * routing.compatibility.claude_code_only — sub2api's group `claude_code_only`, made strict.
 * On: Anthropic-platform models accept only the official Claude Code family.
 * Callers gate on the detected platform first; OpenAI-platform models never reach this.
 */
import { makeError, ErrorType, ErrorCode } from '../core/errors.mjs'
import { isOfficialClaudeUa } from './official-claude-ua.mjs'
import { parseUserId } from './identity-rewrite.mjs'
import {
  detectProxiedOfficialCcFromRouting,
  eachSystemText,
  inboundHasOpenAIToolShape,
  isOfficialClaudeCodeTraffic,
  isProxiedOfficialClaudeCode,
  isValidOfficialUserId,
  looksLikeOhMyPiSystem,
  systemLooksLikeRelayedClaudeCode,
} from './crs-persona.mjs'

const CLAUDE_CODE_BETA = 'claude-code-20250219'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UA_VERSION_RE = /^claude-cli\/(\d+\.\d+\.\d+)/i
const BILLING_VERSION_RE = /x-anthropic-billing-header:[^\n]*\bcc_version=(\d+\.\d+\.\d+)/i
// The CLI's own billing line, exactly as it opens every system prompt it sends.
const BILLING_LINE_RE =
  /^x-anthropic-billing-header: cc_version=(\d+\.\d+\.\d+)\.[0-9a-f]+; cc_entrypoint=[a-z0-9-]+;(?: cch=[^;\s]+;)?$/
// The prompt the CLI puts right after that line on its side queries (SDK and interactive builds).
const SIDE_QUERY_PROMPTS = [
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  "You are Claude Code, Anthropic's official CLI for Claude.",
]

export function claudeCodeOnlyFromRouting(routing) {
  return routing?.compatibility?.claude_code_only === true
}

function headerText(headers, key) {
  return String(headers?.[key] ?? '').trim()
}

/**
 * Headers the CLI sends on every Messages and count_tokens call (captured from 2.1.280).
 * A UA alone is one string to copy; this set comes from the Stainless SDK plus the
 * CLI's own session header. Relays rewrite them, which is why the relayed path is
 * body-only and follows its own switch.
 */
export function hasClaudeCodeClientHeaders(headers = {}, { requireCodeBeta = true } = {}) {
  if (!isOfficialClaudeUa(headerText(headers, 'user-agent'))) return false
  if (headerText(headers, 'x-app').toLowerCase() !== 'cli') return false
  if (!headerText(headers, 'anthropic-version')) return false
  const betas = headerText(headers, 'anthropic-beta')
    .split(',')
    .map((token) => token.trim())
  if (requireCodeBeta && !betas.includes(CLAUDE_CODE_BETA)) return false
  if (headerText(headers, 'x-stainless-lang').toLowerCase() !== 'js') return false
  if (!headerText(headers, 'x-stainless-runtime') || !headerText(headers, 'x-stainless-package-version')) return false
  return UUID_RE.test(headerText(headers, 'x-claude-code-session-id'))
}

/** The CLI stamps one session id into both the header and metadata.user_id. */
function sessionHeaderMatchesUserId(headers, body) {
  const session = headerText(headers, 'x-claude-code-session-id').toLowerCase()
  const parsed = parseUserId(body?.metadata?.user_id)
  if (!parsed) return false
  return [parsed.session_id, parsed.parent_session_id, parsed.root_session_id].some(
    (id) => id && String(id).trim().toLowerCase() === session,
  )
}

/** UA and billing block come from the same build constant; child prompts carry no billing block. */
function billingVersionMatchesUa(headers, body) {
  const uaVersion = UA_VERSION_RE.exec(headerText(headers, 'user-agent'))?.[1]
  for (const text of eachSystemText(body?.system)) {
    const billed = BILLING_VERSION_RE.exec(text)?.[1]
    if (billed) return billed === uaVersion
  }
  return true
}

function messageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content) || content.length !== 1) return null
  const block = content[0]
  return block?.type === 'text' && typeof block.text === 'string' ? block.text : null
}

/**
 * The CLI's quota check (`makeTestQuery`): `max_tokens: 1`, one user turn `quota`, its
 * metadata.user_id, no system, no tools. The body is fixed, so admitting it on the header set
 * spends nothing a caller controls. Anything else with `max_tokens: 1` is a normal request:
 * the output floor would turn it into a real completion on the pool.
 */
function isCliQuotaProbe(headers, body) {
  if (body?.max_tokens !== 1 || body.system != null) return false
  if (Array.isArray(body.tools) ? body.tools.length : body.tools != null) return false
  const messages = Array.isArray(body.messages) ? body.messages : []
  if (messages.length !== 1 || messages[0]?.role !== 'user') return false
  if (messageText(messages[0].content) !== 'quota') return false
  return sessionHeaderMatchesUserId(headers, body)
}

/**
 * The CLI's own side queries go out without the claude-code beta (captured from 2.1.318):
 * the WebSearch tool's search turn (only the server `web_search` tool, one user turn
 * `Perform a web search for the query: …`) and the WebFetch page summary (no tools, one user
 * turn opening with the fetched page). Both open with the CLI's billing line for the UA's
 * build, then its own prompt. Only these two shapes may skip the beta; every other identity
 * check still applies.
 */
function isCliSideQuery(headers, body) {
  const uaVersion = UA_VERSION_RE.exec(headerText(headers, 'user-agent'))?.[1]
  const [first, second] = [...eachSystemText(body?.system)]
  if (!uaVersion || BILLING_LINE_RE.exec(String(first ?? '').trim())?.[1] !== uaVersion) return false
  if (!SIDE_QUERY_PROMPTS.some((prefix) => String(second ?? '').startsWith(prefix))) return false
  const messages = Array.isArray(body?.messages) ? body.messages : []
  if (messages.length !== 1 || messages[0]?.role !== 'user') return false
  const text = messageText(messages[0].content) ?? ''
  const tools = body.tools == null ? [] : body.tools
  if (!Array.isArray(tools)) return false
  if (tools.length === 0) return text.startsWith('\nWeb page content:\n---\n')
  return (
    tools.length === 1 &&
    /^web_search_\d+$/.test(String(tools[0]?.type ?? '')) &&
    tools[0]?.name === 'web_search' &&
    text.startsWith('Perform a web search for the query: ')
  )
}

/**
 * Claude Desktop's fixed gateway sign-in check (4.4212.0): Electron UA, `anthropic-version`,
 * one user turn `.`, `max_tokens` 1 (16 when a local gateway such as Magpie 0.1.2597 raises
 * it), no system/tools/metadata, never streamed. It carries no Claude Code session, so it can
 * never pass the family check; the caller answers it locally without a model call.
 */
export function isClaudeDesktopConnectionProbe(headers = {}, body = {}) {
  const ua = headerText(headers, 'user-agent')
  if (!/^Mozilla\/5\.0 /.test(ua) || !/\bClaude\/\d+\.\d+\.\d+\b/.test(ua) || !/\bElectron\/\d+\.\d+\.\d+\b/.test(ua)) {
    return false
  }
  if (headerText(headers, 'anthropic-version') !== '2023-06-01') return false
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  if (Object.keys(body).some((key) => !['model', 'max_tokens', 'messages', 'stream'].includes(key))) return false
  if (!/^claude-(?:haiku|sonnet|opus)-[a-z0-9.-]+$/.test(body.model || '') || ![1, 16].includes(body.max_tokens))
    return false
  if (body.stream !== undefined && body.stream !== false) return false
  if (!Array.isArray(body.messages) || body.messages.length !== 1) return false
  const turn = body.messages[0]
  return !!turn && Object.keys(turn).length === 2 && turn.role === 'user' && turn.content === '.'
}

/**
 * Direct Claude Code: client header set, plus official system + user_id (same recognition
 * the persona path uses), session id agreeing across header and body, and billing version
 * agreeing with the UA. count_tokens bodies carry no system or user_id, so they are checked on
 * the header set alone; the CLI quota probe must match its fixed body exactly. Third-party
 * probes never get here: the caller refuses every health-probe shape first.
 * Relayed Claude Code (UA rewritten) is admitted only while `detect_proxied_official_cc` is on.
 */
export function isClaudeCodeFamilyRequest(headers = {}, body = {}, { routing = {}, countTokens = false } = {}) {
  if (looksLikeOhMyPiSystem(body?.system, headers) || inboundHasOpenAIToolShape(body)) return false
  const fullHeaders = hasClaudeCodeClientHeaders(headers)
  if (
    fullHeaders ||
    (!countTokens && hasClaudeCodeClientHeaders(headers, { requireCodeBeta: false }) && isCliSideQuery(headers, body))
  ) {
    if (fullHeaders && (countTokens || isCliQuotaProbe(headers, body))) return true
    if (
      isOfficialClaudeCodeTraffic(headers, body) &&
      sessionHeaderMatchesUserId(headers, body) &&
      billingVersionMatchesUa(headers, body)
    ) {
      return true
    }
  }
  // The persona/cache claim may rest on the billing block alone (relays that drop user_id), but
  // that block is one line any client can paste, so admission also needs a valid user_id and an
  // official Claude Code system.
  return (
    !countTokens &&
    detectProxiedOfficialCcFromRouting(routing) &&
    isProxiedOfficialClaudeCode(body, headers) &&
    isValidOfficialUserId(body?.metadata?.user_id) &&
    systemLooksLikeRelayedClaudeCode(body?.system)
  )
}

export function claudeCodeOnlyError() {
  return makeError({
    type: ErrorType.PERMISSION,
    code: ErrorCode.CLAUDE_CODE_ONLY,
    message: '当前仅允许官方 Claude Code 客户端调用 Claude 模型',
    status: 403,
  })
}
