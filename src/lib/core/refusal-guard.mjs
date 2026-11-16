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
export const DEFAULT_BAN_STEPS = Object.freeze([10, 1440, 0])
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
      return {
        message: session
          ? '此会话已封禁，请勿继续使用此会话。'
          : expiresAt
            ? `此设备已封禁至 ${expiresAt}。`
            : '此设备已永久封禁。',
        standalone: true,
        details: {
          reason: session ? 'session' : 'device',
          ban_reason: ban,
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
    return {
      message: ' 该会话因违反使用政策已终止。',
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
  return makeRefusalGuardError({
    requestId,
    blockedBy: match?.kind || 'exact',
    sourceRequestId: match?.row?.source_request_id,
    message: extra?.standalone ? extra.message : REFUSAL_GUARD_MESSAGE + (extra?.message || ''),
    details: extra?.details,
  })
}

const DEVICE_ID_MIN = 8
const DEVICE_ID_MAX = 200

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
      headers['x-kin-device-id'],
    ],
    DEVICE_ID_MIN,
  )
  const machine = first(
    [
      ...sources.flatMap((source) => [source?.machine_id, source?.machineId, source?.meachine_id]),
      headers['x-kin-machine-id'],
      headers['x-machine-id'],
    ],
    DEVICE_ID_MIN,
  )
  const sessionId = first([
    ...decoded.map((value) => value?.session_id),
    ...sources.flatMap((source) => [source?.session_id, source?.sessionId, source?.session]),
    headers['x-claude-code-session-id'],
    headers['x-session-id'],
    headers['session-id'],
    headers.session_id,
  ])
  return { deviceId: device || machine, machineId: machine, sessionId, principal }
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
        (index < steps.length - 1 && (minutes === 0 || (index > 0 && minutes <= steps[index - 1]))),
    )
  ) {
    problems.push('封禁阶梯必须为递增的整数分钟，末项为 0（永久），最多十级')
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
