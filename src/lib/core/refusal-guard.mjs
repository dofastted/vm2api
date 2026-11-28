/**
 * Persist upstream refusals and short-circuit repeats.
 * Fingerprint is model + normalized system/user/tool names (not stream/max_tokens).
 *
 * Claude Code "API Error: ... Usage Policy" is a real refusal: cache that exact
 * prompt with no expiry and answer non-retryable 400. Do not strip envelope JSON — 1.3.8 did
 * that and later turns of normal sessions collided.
 */
import { createHash } from 'node:crypto'
import {
  isThirdPartyClientMessage,
  isUsagePolicyErrorMessage,
  makeRefusalGuardError,
  REFUSAL_GUARD_MESSAGE,
} from './errors.mjs'
import { extractPrompt, normalizeText } from './distill-detect.mjs'
import { claudeCodeAgentRootSession, extractCallerSession, parseUserId } from '../identity/identity-rewrite.mjs'
import { encodeSignature, refusalAskTurns, refusalSignature, refusalUserDocument } from './refusal-similarity.mjs'
import { stripEnvironmentSection, stripReminders } from '../protocol/jev-prepare.mjs'

export { REFUSAL_GUARD_MESSAGE }

export const REFUSAL_GUARD_SETTING = 'refusal_guard_enabled'
export const REFUSAL_SIMILARITY_SETTING = 'refusal_similarity_enabled'
export const REFUSAL_SIMILARITY_VALUE_SETTING = 'refusal_similarity'
export const REFUSAL_DEVICE_BLOCK_SETTING = 'refusal_device_block_enabled'
export const REFUSAL_SESSION_BLOCK_SETTING = 'refusal_session_block_enabled'
export const REFUSAL_SIMILARITY_CHOICES = Object.freeze([80, 85, 90, 95])
export const RISK_AUDIT_SETTING = 'risk_audit_policy'
export const DEFAULT_BAN_STEPS = Object.freeze([10, 10, 0])
export const UPSTREAM_400_SESSION_BLOCK_MS = 10 * 60_000
export const UPSTREAM_400_SESSION_REASON = 'upstream_400'

/**
 * Single source of truth for upstream HTTP 400 classification & session-block sanitization.
 *
 * - `blockSession: false` (cleaned/excluded): account, billing, credential, gateway-local,
 *   or model-availability errors that are NOT caused by a poisoned caller session.
 * - `blockSession: true` (10m session cooldown): session-history corruption, deterministic
 *   client schema/structure errors, third-party rejections, policy refusals, or unclassified
 *   real upstream 400s that would otherwise loop and keep hammering upstream.
 */
export const UPSTREAM_400_CATEGORIES = Object.freeze({
  // --- Cleaned / Excluded (do NOT block caller session) ---
  auto_mode_classifier: Object.freeze({ label: '自动模式分类器侧请求', blockSession: false, group: 'skip' }),
  gateway_local: Object.freeze({ label: '网关/内核本地前置拒绝', blockSession: false, group: 'skip' }),
  account_disabled: Object.freeze({ label: '上游账号/组织被禁用或受限', blockSession: false, group: 'skip' }),
  auth_credential: Object.freeze({ label: '上游凭据或鉴权失效', blockSession: false, group: 'skip' }),
  billing_credit: Object.freeze({ label: '上游账号余额或额度不足', blockSession: false, group: 'skip' }),
  model_unavailable: Object.freeze({ label: '上游模型不可用或无权限', blockSession: false, group: 'skip' }),

  // --- Blocked for 10m (prevent repeat upstream 400 loops) ---
  policy_refusal: Object.freeze({ label: '上游内容/使用政策拒答', blockSession: true, group: 'session_block' }),
  third_party_client: Object.freeze({ label: '第三方客户端计费拒绝', blockSession: true, group: 'session_block' }),
  context_too_long: Object.freeze({ label: '上下文或 Token 超限', blockSession: true, group: 'session_block' }),
  tool_pair_broken: Object.freeze({ label: '工具调用历史配对损坏', blockSession: true, group: 'session_block' }),
  thinking_history_broken: Object.freeze({
    label: 'Thinking/推理签名或配置损坏',
    blockSession: true,
    group: 'session_block',
  }),
  search_or_cache_invalid: Object.freeze({
    label: '搜索加密块或缓存标记非法',
    blockSession: true,
    group: 'session_block',
  }),
  media_invalid: Object.freeze({ label: '图片/文档附件超限或损坏', blockSession: true, group: 'session_block' }),
  message_structure_invalid: Object.freeze({
    label: '消息角色或空内容结构损坏',
    blockSession: true,
    group: 'session_block',
  }),
  tool_schema_invalid: Object.freeze({
    label: '工具 Schema 或参数校验失败',
    blockSession: true,
    group: 'session_block',
  }),
  state_reference_invalid: Object.freeze({
    label: '会话/响应引用 ID 已失效',
    blockSession: true,
    group: 'session_block',
  }),
  beta_or_header_invalid: Object.freeze({
    label: 'Beta 请求头或采样参数非法',
    blockSession: true,
    group: 'session_block',
  }),
  unknown: Object.freeze({ label: '其他上游 400 请求错误', blockSession: true, group: 'session_block' }),
})

export function isUpstream400Reason(reason) {
  return (
    typeof reason === 'string' &&
    (reason === UPSTREAM_400_SESSION_REASON || reason.startsWith(`${UPSTREAM_400_SESSION_REASON}:`))
  )
}

export function upstream400ReasonFor(category) {
  const key = Object.hasOwn(UPSTREAM_400_CATEGORIES, category) ? category : 'unknown'
  return `${UPSTREAM_400_SESSION_REASON}:${key}`
}

export function upstream400CategoryFromReason(reason) {
  if (!isUpstream400Reason(reason)) return ''
  if (reason === UPSTREAM_400_SESSION_REASON) return 'unknown'
  const suffix = reason.slice(UPSTREAM_400_SESSION_REASON.length + 1).trim()
  return Object.hasOwn(UPSTREAM_400_CATEGORIES, suffix) ? suffix : 'unknown'
}

export function upstream400CategoryLabel(category) {
  const meta = Object.hasOwn(UPSTREAM_400_CATEGORIES, category) ? UPSTREAM_400_CATEGORIES[category] : null
  return meta ? meta.label : ''
}
const DEFAULT_RISK_POLICY = Object.freeze({
  ban_steps: DEFAULT_BAN_STEPS,
  blocked_tools: [],
  block_system_prompt_rewrite: true,
  upstream_policy_phrases: [],
  downgrade_pool: '',
  downgrade_endpoint: '',
  downgrade_model: '',
  route_margin: 0.15,
  model_margin: 0.05,
})

export function isRefusalGuardEnabled(readSetting) {
  const flag = process.env.VM2API_REFUSAL_GUARD || process.env.REFUSAL_GUARD || process.env.KIN_REFUSAL_GUARD
  if (flag === '0' || flag === 'false') return false
  if (typeof readSetting === 'function') {
    try {
      const v = readSetting(REFUSAL_GUARD_SETTING, true)
      if (v === false || v === 0 || v === '0' || v === 'false') return false
    } catch {
      /* sqlite missing → default on */
    }
  }
  return true
}

export function toolNamesOf(body) {
  if (!Array.isArray(body?.tools)) return []
  return body.tools
    .map((t) => String(t?.name || '').trim())
    .filter(Boolean)
    .sort()
}

export function blockedRiskTool(inbound, body, rules = []) {
  if (!rules.length) return null
  const names = new Set()
  for (const source of [inbound, body]) {
    for (const tool of Array.isArray(source?.tools) ? source.tools : []) {
      for (const name of [tool?.name, tool?.function?.name, tool?.type]) {
        if (typeof name === 'string') names.add(name.trim().toLowerCase())
      }
      for (const decl of [
        ...(Array.isArray(tool?.functionDeclarations) ? tool.functionDeclarations : []),
        ...(Array.isArray(tool?.function_declarations) ? tool.function_declarations : []),
      ]) {
        if (typeof decl?.name === 'string') names.add(decl.name.trim().toLowerCase())
      }
    }
  }
  return rules.find((rule) => names.has(rule.name.toLowerCase())) || null
}

const ATTACHMENT_TYPES = new Set(['document', 'file', 'input_file', 'image', 'image_url', 'input_image', 'input_audio'])

function* refusalAttachments(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const input = Array.isArray(body?.input) ? body.input : []
  const pending = [...messages, ...input].reverse()
  while (pending.length) {
    const node = pending.pop()
    if (!node || typeof node !== 'object' || (node.role && node.role !== 'user')) continue
    if (ATTACHMENT_TYPES.has(node.type)) {
      yield node
      continue
    }
    if (node.type && node.type !== 'message') continue
    if (!Array.isArray(node.content)) continue
    for (let index = node.content.length - 1; index >= 0; index--) pending.push(node.content[index])
  }
}

export function refusalFingerprint(body = {}, inbound = body) {
  const prompt = extractPrompt(inbound, body)
  const model = String(body?.model || inbound?.model || '')
    .trim()
    .toLowerCase()
  const payload = {
    model,
    prompt: normalizeText([prompt.joined, typeof inbound?.prompt === 'string' ? inbound.prompt : ''].join('\n')),
    tools: toolNamesOf(body).length ? toolNamesOf(body) : toolNamesOf(inbound),
  }
  const attachments = [...refusalAttachments(inbound ?? body)].map((item) =>
    createHash('sha256').update(JSON.stringify(item)).digest('hex'),
  )
  if (attachments.length) payload.attachments = attachments
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

function cleanAsk(text) {
  return stripEnvironmentSection(stripReminders(String(text || '')))
    .replace(/\s+/g, ' ')
    .trim()
}

/** Latest user sentence. Shared reminders, environment, and tool payloads are not the ask. */
export function refusalPreview(body = {}, inbound = body) {
  const asks = refusalAskTurns(inbound, body).map(cleanAsk).filter(Boolean)
  return (asks.at(-1) || '').slice(0, 240)
}

/**
 * Near-match document. Exact SHA-256 still covers the full prompt.
 * A shared Claude Code reminder must not cross the similarity line, and a
 * short ask has no signature: only the exact fingerprint applies.
 */
export function refusalStrictDocument(inbound, body = inbound) {
  if (!refusalAttachments(inbound ?? body).next().done) return ''
  return refusalUserDocument(inbound, body, {
    includeToolResults: false,
    clean: cleanAsk,
  })
}

const CONTENT_POLICY_ERROR_CODES = new Set([
  'content_policy',
  'content_filter',
  'content_filter_refusal',
  'cyber_policy',
  'moderation_blocked',
  'safety_violation',
  'usage_policy',
])

export function isContentPolicyErrorCode(code) {
  return CONTENT_POLICY_ERROR_CODES.has(
    String(code || '')
      .trim()
      .toLowerCase(),
  )
}

export function isUpstreamRefusal(result = {}, extra = {}) {
  if (result?.finalState === 'content_filter') return true
  const stop = String(result?.stopReason || result?.body?.stop_reason || extra.stop_reason || '')
  if (stop === 'refusal') return true
  const blocks = result?.body?.content
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      if (block?.type === 'refusal' && String(block.refusal || block.text || '').trim()) return true
    }
  }
  const error = result?.body?.error
  const success = Number(result?.status) >= 200 && Number(result?.status) < 300 && !error
  const message = [error?.message, success ? null : result?.body?.message, extra?.error_message, extra?.message]
    .filter(Boolean)
    .join('\n')
  if (isUsagePolicyErrorMessage(message)) return true
  const codes = [
    result?.body?.error?.code,
    result?.body?.error?.upstream_code,
    error?.type,
    result?.upstreamError?.code,
    result?.upstreamError?.type,
    result?.body?.code,
    result?.code,
    result?.error_code,
    extra?.error_code,
    extra?.code,
    extra?.upstream_code,
  ]
  return codes.some(isContentPolicyErrorCode)
}

export function upstreamRiskReason(result, phrases = []) {
  const status = Number(result?.status)
  const httpStatus = Number(result?.providerResult?.http_status ?? result?.upstreamStatus ?? result?.status)
  if (
    status === 401 ||
    status === 429 ||
    httpStatus === 401 ||
    httpStatus === 429 ||
    [result?.body?.error?.type, result?.upstreamError?.type].includes('authentication_error')
  ) {
    return ''
  }
  const error = result?.body?.error
  const text = [
    error?.type,
    error?.code,
    error?.upstream_code,
    result?.upstreamError?.type,
    result?.upstreamError?.code,
    result?.upstreamError?.message,
    error?.message,
    result?.body?.message,
    typeof result?.body === 'string' ? result.body : '',
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
  // Third-party client billed against extra usage: not a refusal, not risk.
  if (isThirdPartyClientMessage(text)) return ''
  const isRejection = [400, 403, 422].includes(status) || [400, 403, 422].includes(httpStatus)
  const failed = isRejection || result?.ok === false || !!error
  if (
    isRejection &&
    /\b(?:flag(?:ged)?[\s_-]+(?:this\s+|the\s+)?session|session[\s_-]+(?:was\s+|has\s+been\s+)?flagged)\b/.test(text)
  ) {
    return 'upstream:flagged_session'
  }
  if (isUpstreamRefusal(result) || (failed && isUsagePolicyErrorMessage(text))) return 'upstream:usage_policy'
  if (!isRejection) return ''
  return phrases.some((phrase) => text.includes(phrase.trim().toLowerCase())) ? 'upstream:configured_policy' : ''
}

const AUTH_ACCOUNT_BAN_RE =
  /\b(?:organization_disabled|account_disabled|account_suspended|account\s+has\s+been\s+(?:disabled|suspended|banned|terminated)|this\s+organization\s+has\s+been\s+disabled)\b/i

const UPSTREAM_400_GATEWAY_LOCAL_CODES = new Set([
  'invalid_kernel_request',
  'invalid_envelope',
  'classifier_model_incompatible',
  'classifier_runtime_unsupported',
  'classifier_invalid_cache',
  'invalid_request_context',
  'slot_oauth_unavailable',
])
const UPSTREAM_400_LICENSE_CODE_RE =
  /^license_(?:required|expired|not_yet_valid|invalid|binding_mismatch|unconfigured|crag_host_over_quota|crag_host_usage_unverified)$/i
const UPSTREAM_400_ACCOUNT_DISABLED_RE =
  /organization has been disabled|oauth authentication is currently not allowed|organization[^.\n]{0,60}(?:blocked|banned|disabled)|account[_\s-]?(?:disabled|suspended|banned|ineligible)|account has been (?:disabled|suspended|banned|terminated)|tos_violation|verification_required|location_unsupported|unsupported_region|country,\s*region,\s*or\s*territory\s*not\s*supported/i
const UPSTREAM_400_AUTH_CREDENTIAL_CODES = new Set([
  'authentication_error',
  'oauth_revoked',
  'token_revoked',
  'invalid_grant',
  'invalid_api_key',
  'gemini_oauth_required',
])
const UPSTREAM_400_AUTH_CREDENTIAL_RE =
  /\b(?:token has been revoked|token_revoked|invalidated oauth token|oauth_revoked|invalid_grant|api[_\s-]?key[_\s-]+(?:not[_\s-]+valid|invalid|expired)|invalid[_\s-]+x-api-key|credential[_\s-]+(?:needs refresh|refresh failed|required)|slot has no credential)\b/i
const UPSTREAM_400_BILLING_CREDIT_CODES = new Set([
  'billing_error',
  'insufficient_quota',
  'usage_limit_reached',
  'billing_hard_limit_reached',
  'upstream:billing_refusal',
])
const UPSTREAM_400_BILLING_CREDIT_RE =
  /credit balance is too low|extra usage required|usage credits? (?:are )?required|out of extra usage|you['’]?ve hit your limit|insufficient[_\s-]?(?:quota|credits?|balance|funds)|billing[_\s-]?(?:hard[_\s-]?limit|not[_\s-]?active|error)|exceeded your current quota|plan does not include/i
const UPSTREAM_400_MODEL_UNAVAILABLE_CODES = new Set([
  'model_not_found',
  'model_not_supported',
  'model_not_allowed',
  'unsupported_model',
  'gemini_model_unavailable',
])
const UPSTREAM_400_MODEL_UNAVAILABLE_RE =
  /\bthe model\b[^.\n]{0,80}\b(?:does not exist|not found|is not supported|not supported|not available|has been (?:deprecated|decommissioned|retired)|access)\b|\b(?:unknown|invalid|unsupported)\s+model(?:\s+(?:id|name))?\b|\bmodel\b[^.\n]{0,60}\b(?:not found|does not exist|is not supported|has been deprecated|has been retired|decommissioned)\b/i
const UPSTREAM_400_CONTEXT_TOO_LONG_CODES = new Set([
  'context_length_exceeded',
  'prompt_too_long',
  'request_too_large',
  'max_tokens_exceeded',
])
const UPSTREAM_400_CONTEXT_TOO_LONG_RE =
  /prompt is too long|input is too long|context[_\s-]?length[_\s-]?exceeded|maximum context length|exceeds? (?:the )?(?:maximum|max) (?:number of )?(?:tokens|context|input|length)|too many (?:input )?tokens|token count exceeds|request (?:payload )?size exceeds|input exceeds the context window/i
const UPSTREAM_400_TOOL_PAIR_RE =
  /tool_use_id|tool_use[^.\n]{0,120}tool_result|tool_result[^.\n]{0,120}(?:required|missing|expected|without)|no tool (?:output|call) found for function call|function[_\s-]?(?:call|response) turn (?:must come|comes) immediately|number of function response parts|tool_call_id/i
const UPSTREAM_400_THINKING_CODES = new Set(['thinking_incompatible'])
const UPSTREAM_400_THINKING_RE =
  /invalid signature in thinking|thinking(?: or redacted_thinking)? blocks?[^.\n]{0,120}cannot be modified|expected [`'"]?thinking|must contain thinking|each thinking block|thinking\.budget_tokens|adaptive thinking|does not support adaptive|thought[_\s-]?signature|between_tools|reasoning[^.\n]{0,80}encrypted_content|encrypted_content[^.\n]{0,80}reasoning/i
const UPSTREAM_400_SEARCH_OR_CACHE_RE =
  /cache_control|maximum of \d+ blocks with [`'"]?cache_control|`?search_result`?\s+block|web_search_result|encrypted_content/i
const UPSTREAM_400_MEDIA_CODES = new Set([
  'image_too_large',
  'invalid_image',
  'invalid_image_format',
  'invalid_image_url',
])
const UPSTREAM_400_MEDIA_RE =
  /image dimensions? exceed max allowed size|could not process (?:image|pdf|document|audio|video)|image exceeds \d+\s*mb|invalid (?:image|media_type|mime_type|base64)|unsupported (?:image|media|mime|file) (?:type|format)|unable to (?:download|decode|parse) (?:image|media|document)|base64[^.\n]{0,60}(?:invalid|decode|corrupt)|inline_data[^.\n]{0,60}(?:invalid|mime)/i
const UPSTREAM_400_MESSAGE_STRUCTURE_CODES = new Set(['invalid_messages', 'invalid_content'])
const UPSTREAM_400_MESSAGE_STRUCTURE_RE =
  /roles must alternate|conversation must (?:end|start)|final (?:assistant )?message|messages?:[^.\n]{0,80}(?:end|start)[^.\n]{0,80}(?:user|assistant)|must (?:end|start) with a user|must have non-empty content|content blocks? must be non-empty|empty (?:text|content|message|messages)|alternate between user and model|contents[^.\n]{0,60}must not be empty|at least one message|messages[^.\n]{0,40}cannot be empty/i
const UPSTREAM_400_TOOL_SCHEMA_CODES = new Set([
  'invalid_json_schema',
  'invalid_request_schema',
  'invalid_function_parameters',
  'unknown_parameter',
  'missing_required_parameter',
])
const UPSTREAM_400_TOOL_SCHEMA_RE =
  /invalid_json_schema|invalid schema for [`'"]?tools|unsatisfiable schema|additionalProperties|output_config|tool_choice|input_schema|extra inputs are not permitted|input tag\b.+\bdoes not match|field required|input should be|invalid json payload received|unknown name [`'"]|invalid_type|missing required parameter|unknown parameter|\btools\.\d+/i
const UPSTREAM_400_STATE_REF_CODES = new Set([
  'previous_response_not_found',
  'item_not_found',
  'conversation_not_found',
  'thread_not_found',
])
const UPSTREAM_400_STATE_REF_RE =
  /previous_response_id[^.\n]{0,60}(?:not found|invalid|expired)|item with id [^\s]+ not found|response [`'"]?resp_[^`'"]+['"`]? not found|conversation (?:id )?[^.\n]{0,60}not found|thread (?:id )?[^.\n]{0,60}not found/i
const UPSTREAM_400_BETA_OR_HEADER_RE =
  /anthropic-beta|unexpected value\(s\)[^.\n]{0,80}beta|invalid beta|beta header|(?:does not support|unsupported)[^.\n]{0,60}\b(?:temperature|top_p|top_k)\b|`?(?:temperature|top_p|top_k)`?\s+(?:is|are|may only be)\s+(?:deprecated|not supported|set to)/i

function makeUpstream400Verdict(category, status = 400) {
  const key = Object.hasOwn(UPSTREAM_400_CATEGORIES, category) ? category : 'unknown'
  const meta = UPSTREAM_400_CATEGORIES[key]
  return {
    status,
    category: key,
    group: meta.group,
    blockSession: meta.blockSession,
    skipReason: meta.blockSession ? '' : key,
    reason: meta.blockSession ? upstream400ReasonFor(key) : '',
    label: meta.label,
  }
}

/**
 * Classify a real upstream HTTP 400 response and decide whether the caller session
 * must be blocked for 10 minutes (`blockSession: true`) or cleaned/skipped (`false`).
 * Returns `null` when `result` is not a real upstream HTTP 400.
 */
export function classifyUpstream400(result, { phrases = [], classifier = null } = {}) {
  if (
    !result ||
    result.ok === true ||
    result.upstreamExecutions === 0 ||
    result.transportError === true ||
    result.via === 'kernel-preflight'
  ) {
    return null
  }
  const status = Number(result?.providerResult?.http_status ?? result?.upstreamStatus ?? result?.status) || 0
  if (status !== 400) return null
  if (classifier?.purpose === 'auto_mode_classifier') return makeUpstream400Verdict('auto_mode_classifier', status)
  if (result.credential_ensure_failed === true) return makeUpstream400Verdict('auth_credential', status)

  const error = result?.body?.error
  const codes = [
    error?.code,
    error?.upstream_code,
    error?.type,
    result?.upstreamError?.code,
    result?.upstreamError?.type,
    result?.code,
    result?.error_code,
  ]
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => v.trim().toLowerCase())
  const text = [
    error?.type,
    error?.code,
    error?.upstream_code,
    result?.upstreamError?.type,
    result?.upstreamError?.code,
    result?.upstreamError?.message,
    error?.message,
    result?.body?.message,
    typeof result?.body === 'string' ? result.body : '',
  ]
    .filter(Boolean)
    .join('\n')

  // 1. Non-session exclusions (cleaned out so account/billing/credential/gateway issues never lock user sessions).
  if (codes.some((code) => UPSTREAM_400_GATEWAY_LOCAL_CODES.has(code) || UPSTREAM_400_LICENSE_CODE_RE.test(code))) {
    return makeUpstream400Verdict('gateway_local', status)
  }
  if (AUTH_ACCOUNT_BAN_RE.test(text) || UPSTREAM_400_ACCOUNT_DISABLED_RE.test(text)) {
    return makeUpstream400Verdict('account_disabled', status)
  }
  if (
    codes.some((code) => UPSTREAM_400_AUTH_CREDENTIAL_CODES.has(code)) ||
    UPSTREAM_400_AUTH_CREDENTIAL_RE.test(text)
  ) {
    return makeUpstream400Verdict('auth_credential', status)
  }
  // Check third-party extra-usage rejection BEFORE account billing_credit because its wording mentions "extra usage".
  if (isThirdPartyClientMessage(text)) {
    return makeUpstream400Verdict('third_party_client', status)
  }
  if (codes.some((code) => UPSTREAM_400_BILLING_CREDIT_CODES.has(code)) || UPSTREAM_400_BILLING_CREDIT_RE.test(text)) {
    return makeUpstream400Verdict('billing_credit', status)
  }
  if (
    codes.some((code) => UPSTREAM_400_MODEL_UNAVAILABLE_CODES.has(code)) ||
    UPSTREAM_400_MODEL_UNAVAILABLE_RE.test(text)
  ) {
    return makeUpstream400Verdict('model_unavailable', status)
  }

  // 2. Session-poisoned / deterministic loop 400 categories (block session for 10m).
  if (upstreamRiskReason(result, phrases)) {
    return makeUpstream400Verdict('policy_refusal', status)
  }
  if (
    codes.some((code) => UPSTREAM_400_CONTEXT_TOO_LONG_CODES.has(code)) ||
    UPSTREAM_400_CONTEXT_TOO_LONG_RE.test(text)
  ) {
    return makeUpstream400Verdict('context_too_long', status)
  }
  if (UPSTREAM_400_TOOL_PAIR_RE.test(text)) {
    return makeUpstream400Verdict('tool_pair_broken', status)
  }
  if (codes.some((code) => UPSTREAM_400_THINKING_CODES.has(code)) || UPSTREAM_400_THINKING_RE.test(text)) {
    return makeUpstream400Verdict('thinking_history_broken', status)
  }
  if (UPSTREAM_400_SEARCH_OR_CACHE_RE.test(text)) {
    return makeUpstream400Verdict('search_or_cache_invalid', status)
  }
  if (codes.some((code) => UPSTREAM_400_MEDIA_CODES.has(code)) || UPSTREAM_400_MEDIA_RE.test(text)) {
    return makeUpstream400Verdict('media_invalid', status)
  }
  if (
    codes.some((code) => UPSTREAM_400_MESSAGE_STRUCTURE_CODES.has(code)) ||
    UPSTREAM_400_MESSAGE_STRUCTURE_RE.test(text)
  ) {
    return makeUpstream400Verdict('message_structure_invalid', status)
  }
  if (codes.some((code) => UPSTREAM_400_TOOL_SCHEMA_CODES.has(code)) || UPSTREAM_400_TOOL_SCHEMA_RE.test(text)) {
    return makeUpstream400Verdict('tool_schema_invalid', status)
  }
  if (codes.some((code) => UPSTREAM_400_STATE_REF_CODES.has(code)) || UPSTREAM_400_STATE_REF_RE.test(text)) {
    return makeUpstream400Verdict('state_reference_invalid', status)
  }
  if (UPSTREAM_400_BETA_OR_HEADER_RE.test(text)) {
    return makeUpstream400Verdict('beta_or_header_invalid', status)
  }
  return makeUpstream400Verdict('unknown', status)
}

/**
 * Orthogonal post-hop error classifier so risk feedback never confuses protocol
 * 400s, third-party billing rejections, or auth bans with content refusals.
 */
export function classifyUpstreamError(result, phrases = []) {
  const status = Number(result?.providerResult?.http_status ?? result?.upstreamStatus ?? result?.status) || 0
  const error = result?.body?.error
  const text = [
    error?.type,
    error?.code,
    error?.upstream_code,
    result?.upstreamError?.type,
    result?.upstreamError?.code,
    result?.upstreamError?.message,
    error?.message,
    result?.body?.message,
    typeof result?.body === 'string' ? result.body : '',
  ]
    .filter(Boolean)
    .join('\n')
  if (isThirdPartyClientMessage(text)) return { bucket: 'third_party', reason: '', status }
  const reason = upstreamRiskReason(result, phrases)
  if (reason) return { bucket: 'policy', reason, status }
  if ((status === 401 || status === 403) && AUTH_ACCOUNT_BAN_RE.test(text)) {
    return { bucket: 'auth_suspect', reason: 'upstream:auth_ban_suspect', status }
  }
  if (status === 400 || status === 409 || status === 410) {
    return { bucket: 'protocol', reason: '', status }
  }
  return { bucket: 'other', reason: '', status }
}

function refusalBlockSuffix(match) {
  if (!match || typeof match !== 'object') return null
  if (match.kind === 'device') {
    const ban = String(match.row?.reason || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
    const expiresAt = match.row?.expires_at
    const session = match.row?.subject_kind === 'session'
    if (session || expiresAt || (match.row?.identity_value && match.row.identity_value !== match.row.device_id)) {
      const u400Category = isUpstream400Reason(ban) ? upstream400CategoryFromReason(ban) : ''
      const u400Label = u400Category && u400Category !== 'unknown' ? upstream400CategoryLabel(u400Category) : ''
      const sessionMessage = expiresAt
        ? isUpstream400Reason(ban)
          ? u400Label
            ? `此会话因上游 400 错误（${u400Label}）已临时封禁至 ${expiresAt}，请开启新会话或稍后再试。`
            : `此会话因上游 400 错误已临时封禁至 ${expiresAt}，请开启新会话或稍后再试。`
          : `此会话已临时封禁至 ${expiresAt}，请开启新会话或稍后再试。`
        : '此会话已封禁，请勿继续使用此会话。'
      return {
        message: session ? sessionMessage : expiresAt ? `此设备已封禁至 ${expiresAt}。` : '此设备已永久封禁。',
        standalone: true,
        details: {
          reason: session ? 'session' : 'device',
          ban_reason: ban,
          ...(u400Category ? { upstream_400_category: u400Category } : {}),
          ...(expiresAt ? { expires_at: expiresAt } : {}),
        },
      }
    }
    return {
      message: ban ? ` 该设备此前已被封禁（${ban}）。` : ' 该设备此前已被封禁。',
      details: ban ? { reason: 'device', ban_reason: ban } : { reason: 'device' },
    }
  }
  if (match.kind === 'session') {
    const jevBlocked = String(match.row?.reason || '').startsWith('jev:')
    if (jevBlocked) {
      return {
        message: '此会话已封禁，请开启新会话。',
        standalone: true,
        details: { reason: 'session', ban_reason: String(match.row.reason).slice(0, 80) },
      }
    }
    return {
      message: ' 这个会话此前被上游拒答，已永久停止转发；请开启新会话。',
      details: { reason: 'session' },
    }
  }
  if (match.kind === 'similar') {
    const score = Number(match.score)
    const finite = Number.isFinite(score)
    const pct = finite ? Math.round(score * 100) : null
    return {
      message:
        pct == null ? ' 当前提示词与曾被拒答的内容相似。' : ` 当前提示词与曾被拒答的内容相似（相似度 ${pct}%）。`,
      details: finite ? { reason: 'similar', score } : { reason: 'similar' },
    }
  }
  if (match.kind === 'exact') {
    return {
      message: ' 当前提示词与曾被拒答的内容完全一致。',
      details: { reason: 'exact' },
    }
  }
  return null
}

/** Original sentence stays; a match only appends why this call was blocked. */
export function refusalGuardError(requestId, match) {
  const extra = refusalBlockSuffix(match)
  const blockedBy =
    match?.kind === 'device' && match?.row?.subject_kind === 'session' ? 'session' : match?.kind || 'exact'
  return makeRefusalGuardError({
    requestId,
    blockedBy,
    sourceRequestId: match?.row?.source_request_id,
    message: extra?.standalone ? extra.message : REFUSAL_GUARD_MESSAGE + (extra?.message || ''),
    details: extra?.details,
  })
}

const DEVICE_ID_MIN = 8
const DEVICE_ID_MAX = 200

function headerValueOf(headers, name) {
  if (!headers || typeof headers !== 'object') return ''
  if (Object.hasOwn(headers, name) && headers[name] != null) {
    const raw = headers[name]
    return Array.isArray(raw) ? String(raw[0] ?? '') : String(raw)
  }
  const want = String(name).toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() !== want || v == null) continue
    return Array.isArray(v) ? String(v[0] ?? '') : String(v)
  }
  return ''
}

/** Inbound client device. Never the slot's rewritten outbound id, and never IP/UA/API key. */
export function inboundRefusalDeviceId({ inbound, body, headers } = {}) {
  return refusalAuditIdentity({ inbound, body, headers }).deviceId
}

export function refusalAuditIdentity({ inbound, body = inbound, headers = {}, principal = '' } = {}) {
  const valid = (value, min = 1) => {
    const text = typeof value === 'string' ? value.trim() : ''
    return text.length >= min && text.length <= DEVICE_ID_MAX && /^[\w.:@+/-]+$/.test(text) ? text : ''
  }
  const first = (values, min) => values.map((value) => valid(value, min)).find(Boolean) || ''
  const bodies = inbound === body ? [inbound] : [inbound, body]
  const decoded = bodies.map((source) => parseUserId(source?.metadata?.user_id))
  const sources = [...decoded, ...bodies.flatMap((source) => [source?.metadata, source])]
  const device = first(
    [
      ...decoded.map((value) => value?.device_id),
      ...sources.flatMap((source) => [source?.device_id, source?.deviceId]),
      headerValueOf(headers, 'x-kin-device-id'),
    ],
    DEVICE_ID_MIN,
  )
  const machine = first(
    [
      ...sources.flatMap((source) => [source?.machine_id, source?.machineId, source?.meachine_id]),
      headerValueOf(headers, 'x-kin-machine-id'),
      headerValueOf(headers, 'x-machine-id'),
    ],
    DEVICE_ID_MIN,
  )
  const agentRoot = claudeCodeAgentRootSession({ inbound: inbound || {}, body: body || {}, headers: headers || {} })
  const sessionId = first([
    agentRoot,
    ...decoded.map((value) => value?.session_id),
    ...sources.flatMap((source) => [
      source?.session_id,
      source?.sessionId,
      source?.session,
      source?.conversation_id,
      source?.conversationId,
      source?.thread_id,
      source?.prompt_cache_key,
    ]),
    headerValueOf(headers, 'x-claude-code-session-id'),
    headerValueOf(headers, 'x-session-id'),
    headerValueOf(headers, 'x-conversation-id'),
    headerValueOf(headers, 'x-opencode-session'),
    headerValueOf(headers, 'x-opencode-session-id'),
    headerValueOf(headers, 'session-id'),
    headerValueOf(headers, 'session_id'),
    headerValueOf(headers, 'thread-id'),
  ])
  return { deviceId: device || machine, machineId: machine, sessionId, principal }
}

/**
 * SSOT audit identity shared by pre-dispatch enforcement and post-hop recording.
 * Preserves an explicit caller-supplied identity while normalizing any root
 * session from inbound/body/headers (including Claude Code sub-agents and Codex
 * conversation/cache keys).
 */
export function resolveAuditSessionIdentity({
  inbound,
  body = inbound,
  headers = {},
  identity = null,
  principal = '',
} = {}) {
  const base = identity || refusalAuditIdentity({ inbound, body, headers, principal })
  const extracted =
    refusalSessionId({ inbound, body, headers }) ||
    refusalAuditIdentity({ inbound, body, headers, principal: base?.principal || principal }).sessionId
  const rootSessionId = extracted || base?.sessionId || ''
  if (!base) return { deviceId: '', machineId: '', sessionId: rootSessionId, principal }
  return rootSessionId && rootSessionId !== base.sessionId ? { ...base, sessionId: rootSessionId } : base
}

export function riskPrincipal(req) {
  const user = req?.apiKeyRecord?.user_id ?? req?.panelUserId
  if (user != null && user !== '') return `user:${user}`
  const key = req?.apiKeyRecord?.id
  return key ? `key:${key}` : 'platform'
}

const SESSION_ID_MIN = 8
const SESSION_ID_MAX = 200

/**
 * Root caller session for the session block. A Claude Code sub-agent hop maps
 * back to the main session it belongs to, so a refused session's sub-agents
 * are blocked with it. '' when the caller sent no usable session.
 */
export function refusalSessionId({ inbound, body = inbound, headers } = {}) {
  const ctx = { inbound: inbound || {}, body: body || {}, headers: headers || {} }
  const id = String(claudeCodeAgentRootSession(ctx) || extractCallerSession(ctx) || '').trim()
  if (id.length < SESSION_ID_MIN || id.length > SESSION_ID_MAX) return ''
  return id
}

export function refusalPromptSignature(inbound, body = inbound) {
  return encodeSignature(refusalSignature(refusalStrictDocument(inbound, body)))
}

function flagOn(value) {
  return !(value === false || value === 0 || value === '0' || value === 'false')
}

/** Panel policy. Missing settings stay on, with similarity at 90. */
export function refusalGuardPolicy(readSetting) {
  const read = typeof readSetting === 'function' ? readSetting : () => undefined
  const raw = read(REFUSAL_SIMILARITY_VALUE_SETTING, 90)
  const similarity = REFUSAL_SIMILARITY_CHOICES.includes(Number(raw)) ? Number(raw) : 90
  const stored = read(RISK_AUDIT_SETTING, DEFAULT_RISK_POLICY)
  const audit = Object.fromEntries(
    Object.entries(DEFAULT_RISK_POLICY).map(([key, fallback]) => [key, stored?.[key] ?? fallback]),
  )
  const validAudit = !validateRiskPolicy(audit).length
  return {
    enabled: isRefusalGuardEnabled(readSetting),
    similarity_enabled: flagOn(read(REFUSAL_SIMILARITY_SETTING, true)),
    similarity,
    device_block_enabled: flagOn(read(REFUSAL_DEVICE_BLOCK_SETTING, true)),
    risk_audit: validAudit ? audit : { ...DEFAULT_RISK_POLICY },
    // Independent of `enabled`: a refused session stops even with the prompt cache off.
    session_block_enabled: flagOn(read(REFUSAL_SESSION_BLOCK_SETTING, true)),
  }
}

function validateRiskPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return ['risk_audit 必须是对象']
  const problems = []
  const steps = policy.ban_steps
  if (
    !Array.isArray(steps) ||
    steps.length < 1 ||
    steps.length > 10 ||
    steps.at(-1) !== 0 ||
    steps.some(
      (minutes, index) =>
        !Number.isInteger(minutes) ||
        minutes < 0 ||
        minutes > 525600 ||
        (index < steps.length - 1 && (minutes === 0 || (index > 0 && minutes < steps[index - 1]))),
    )
  ) {
    problems.push('封禁阶梯必须为非递减的整数分钟，末项为 0（永久），最多十级')
  }
  if (
    !Array.isArray(policy.blocked_tools) ||
    policy.blocked_tools.length > 100 ||
    policy.blocked_tools.some(
      (rule) =>
        typeof rule?.name !== 'string' ||
        !/^[\w.:-]{1,120}$/.test(rule.name) ||
        typeof rule.message !== 'string' ||
        !rule.message.trim() ||
        rule.message.length > 240,
    )
  )
    problems.push('工具规则需要精确工具名和错误提示，最多 100 条')
  if (typeof policy.block_system_prompt_rewrite !== 'boolean') problems.push('block_system_prompt_rewrite 必须是布尔')
  if (
    !Array.isArray(policy.upstream_policy_phrases) ||
    policy.upstream_policy_phrases.length > 30 ||
    policy.upstream_policy_phrases.some(
      (phrase) =>
        typeof phrase !== 'string' ||
        phrase.trim().length < 6 ||
        phrase.length > 120 ||
        /^(?:api error|session|400错误)$/i.test(phrase.trim()),
    )
  ) {
    problems.push('上游策略关键字须为明确的拒答短语，不能是通用错误词')
  }
  if (
    typeof policy.downgrade_pool !== 'string' ||
    (policy.downgrade_pool && !/^pool_[a-f0-9]{8}$/.test(policy.downgrade_pool))
  ) {
    problems.push('降级账号池 ID 不正确')
  }
  for (const key of ['downgrade_endpoint', 'downgrade_model']) {
    if (typeof policy[key] !== 'string' || !/^[\w.:[\]+/-]{0,120}$/.test(policy[key])) problems.push(`${key} 不正确`)
  }
  if (
    ![policy.route_margin, policy.model_margin].every((value) => Number.isFinite(value) && value >= 0 && value <= 1) ||
    policy.model_margin > policy.route_margin
  )
    problems.push('降级分差须在 0～1，模型分差不能大于分组分差')
  return problems
}

export function normalizeRefusalSimilarity(value) {
  const n = Number(value)
  return REFUSAL_SIMILARITY_CHOICES.includes(n) ? n : null
}

/** Apply a panel PUT. Unknown similarity values are rejected, not coerced. */
export function applyRefusalGuardPatch(settings, body = {}) {
  const problems = []
  if (Object.hasOwn(body, 'enabled') && typeof body.enabled !== 'boolean') problems.push('enabled 必须是布尔')
  if (Object.hasOwn(body, 'similarity_enabled') && typeof body.similarity_enabled !== 'boolean') {
    problems.push('similarity_enabled 必须是布尔')
  }
  if (Object.hasOwn(body, 'device_block_enabled') && typeof body.device_block_enabled !== 'boolean') {
    problems.push('device_block_enabled 必须是布尔')
  }
  if (Object.hasOwn(body, 'session_block_enabled') && typeof body.session_block_enabled !== 'boolean') {
    problems.push('session_block_enabled 必须是布尔')
  }
  if (Object.hasOwn(body, 'similarity') && normalizeRefusalSimilarity(body.similarity) == null) {
    problems.push('similarity 只能是 80、85、90、95')
  }
  const risk = Object.hasOwn(body, 'risk_audit') ? body.risk_audit : undefined
  if (Object.hasOwn(body, 'risk_audit')) problems.push(...validateRiskPolicy(risk))
  if (problems.length) return { ok: false, problems }
  if (typeof body.enabled === 'boolean') settings.set(REFUSAL_GUARD_SETTING, body.enabled)
  if (typeof body.similarity_enabled === 'boolean') settings.set(REFUSAL_SIMILARITY_SETTING, body.similarity_enabled)
  if (typeof body.device_block_enabled === 'boolean') {
    settings.set(REFUSAL_DEVICE_BLOCK_SETTING, body.device_block_enabled)
  }
  if (typeof body.session_block_enabled === 'boolean') {
    settings.set(REFUSAL_SESSION_BLOCK_SETTING, body.session_block_enabled)
  }
  if (Object.hasOwn(body, 'similarity')) {
    settings.set(REFUSAL_SIMILARITY_VALUE_SETTING, normalizeRefusalSimilarity(body.similarity))
  }
  if (risk) settings.set(RISK_AUDIT_SETTING, risk)
  return { ok: true }
}

/** Pre-hop session decision. Does not write. */
export function matchRefusalSession({ inbound, body = inbound, headers, sessions } = {}) {
  if (!sessions || typeof sessions.get !== 'function') return null
  const sessionId = refusalSessionId({ inbound, body, headers })
  if (!sessionId) return null
  const row = sessions.get(sessionId)
  if (!row) return null
  return { kind: 'session', sessionId, row }
}

/**
 * Pre-hop decision. Device ban wins, then the exact fingerprint, then a
 * user-text signature at or above the configured similarity. Does not write.
 */
export function matchStoredRefusal({
  inbound,
  body = inbound,
  headers,
  repo,
  devices,
  similarityEnabled = true,
  similarity = 0.9,
  deviceBlockEnabled = true,
} = {}) {
  const deviceId = inboundRefusalDeviceId({ inbound, body, headers })
  if (deviceBlockEnabled && deviceId && typeof devices?.get === 'function') {
    const banned = devices.get(deviceId)
    if (banned) return { kind: 'device', deviceId, row: banned }
  }
  if (!repo || typeof repo.get !== 'function') return null
  const fingerprint = refusalFingerprint(body, inbound)
  const exact = repo.get(fingerprint)
  if (exact) return { kind: 'exact', deviceId, fingerprint, row: exact }
  if (!similarityEnabled || typeof repo.nearest !== 'function') return null
  const signature = refusalSignature(refusalStrictDocument(inbound, body))
  if (!signature) return null
  const near = repo.nearest(signature, similarity)
  if (!near) return null
  return { kind: 'similar', deviceId, fingerprint: near.fingerprint, score: near.score, row: near }
}
