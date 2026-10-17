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
  looksLikeOhMyPiSystem,
} from './crs-persona.mjs'

const CLAUDE_CODE_BETA = 'claude-code-20250219'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UA_VERSION_RE = /^claude-cli\/(\d+\.\d+\.\d+)/i
const BILLING_VERSION_RE = /x-anthropic-billing-header:[^\n]*\bcc_version=(\d+\.\d+\.\d+)/i

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
export function hasClaudeCodeClientHeaders(headers = {}) {
  if (!isOfficialClaudeUa(headerText(headers, 'user-agent'))) return false
  if (headerText(headers, 'x-app').toLowerCase() !== 'cli') return false
  if (!headerText(headers, 'anthropic-version')) return false
  const betas = headerText(headers, 'anthropic-beta')
    .split(',')
    .map((token) => token.trim())
  if (!betas.includes(CLAUDE_CODE_BETA)) return false
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
 * Direct Claude Code: client header set, plus official system + user_id (same recognition
 * the persona path uses), session id agreeing across header and body, and billing version
 * agreeing with the UA. count_tokens bodies carry no system or user_id, so they are checked on
 * the header set alone; the CLI quota probe must match its fixed body exactly. Third-party
 * probes never get here: the caller refuses every health-probe shape first.
 * Relayed Claude Code (UA rewritten) is admitted only while `detect_proxied_official_cc` is on.
 */
export function isClaudeCodeFamilyRequest(headers = {}, body = {}, { routing = {}, countTokens = false } = {}) {
  if (looksLikeOhMyPiSystem(body?.system, headers) || inboundHasOpenAIToolShape(body)) return false
  if (hasClaudeCodeClientHeaders(headers)) {
    if (countTokens || isCliQuotaProbe(headers, body)) return true
    if (
      isOfficialClaudeCodeTraffic(headers, body) &&
      sessionHeaderMatchesUserId(headers, body) &&
      billingVersionMatchesUa(headers, body)
    ) {
      return true
    }
  }
  return !countTokens && detectProxiedOfficialCcFromRouting(routing) && isProxiedOfficialClaudeCode(body, headers)
}

export function claudeCodeOnlyError() {
  return makeError({
    type: ErrorType.PERMISSION,
    code: ErrorCode.CLAUDE_CODE_ONLY,
    message: '当前仅允许官方 Claude Code 客户端调用 Claude 模型',
    status: 403,
  })
}
