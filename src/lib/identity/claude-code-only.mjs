/**
 * Strict client-family gate: routing.compatibility.claude_code_only.
 * On: Anthropic-platform models accept only the official Claude Code family.
 * Callers gate on the detected platform first; OpenAI-platform models never reach this.
 */
import { makeError, ErrorType, ErrorCode } from '../core/errors.mjs'
import { detectProxiedOfficialCcFromRouting } from './crs-persona.mjs'
import { verifyDirectClaudeCodeHeaders, verifyOfficialClaudeCode } from './official-cc-verifier.mjs'

export function claudeCodeOnlyFromRouting(routing) {
  return routing?.compatibility?.claude_code_only === true
}

function headerText(headers, key) {
  return String(headers?.[key] ?? '').trim()
}

/**
 * Complete direct Claude Code header bundle (strict UA + x-app + anthropic-version +
 * browser-access + all 8 Stainless JS headers + UUIDv4 session header + optional beta).
 */
export function hasClaudeCodeClientHeaders(headers = {}, { requireCodeBeta = true } = {}) {
  return verifyDirectClaudeCodeHeaders(headers, { requireCodeBeta }).ok
}

/**
 * Claude Desktop's fixed gateway sign-in check (4.4212.0): Electron UA, `anthropic-version`,
 * one user turn `.`, `max_tokens` 1 (a local gateway may raise it to 16), no
 * system/tools/metadata, never streamed. It carries no Claude Code session, so it can
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
 * Delegates to the single SSOT strict verifier (`verifyOfficialClaudeCode`).
 * Closes V2 (weak user_id, empty/forged billing, proxied bypasses) while keeping
 * genuine direct, auxiliary (count_tokens / quota / WebSearch / WebFetch / classifier),
 * Desktop Cowork, and relayed Claude Code traffic working.
 */
export function isClaudeCodeFamilyRequest(
  headers = {},
  body = {},
  { routing = {}, countTokens = false, rawBodyBytes = null } = {},
) {
  return verifyOfficialClaudeCode(headers, body, {
    detectProxiedOfficialCc: detectProxiedOfficialCcFromRouting(routing),
    countTokens,
    rawBodyBytes,
  }).official
}

export function claudeCodeOnlyError() {
  return makeError({
    type: ErrorType.PERMISSION,
    code: ErrorCode.CLAUDE_CODE_ONLY,
    message: '当前仅允许官方 Claude Code 客户端调用 Claude 模型。请使用 Claude 官方客户端。',
    status: 403,
  })
}
