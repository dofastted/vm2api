/**
 * Persist upstream refusals and short-circuit repeats.
 * Fingerprint is model + normalized system/user/tool names (not stream/max_tokens).
 *
 * Claude Code "API Error: ... Usage Policy" is a real refusal: cache that exact
 * prompt with no expiry and answer non-retryable 400. Do not strip envelope JSON — 1.3.8 did
 * that and later turns of normal sessions collided.
 */
import { createHash } from 'node:crypto'
import { isUsagePolicyErrorMessage, makeRefusalGuardError, REFUSAL_GUARD_MESSAGE } from './errors.mjs'
import { extractPrompt, normalizeText } from './distill-detect.mjs'
import { resolveInboundIdentity } from '../identity/identity-rewrite.mjs'
import { encodeSignature, refusalAskTurns, refusalSignature, refusalUserDocument } from './refusal-similarity.mjs'
import { stripEnvironmentSection, stripReminders } from '../protocol/jev-prepare.mjs'

export { REFUSAL_GUARD_MESSAGE }

export const REFUSAL_GUARD_SETTING = 'refusal_guard_enabled'
export const REFUSAL_SIMILARITY_SETTING = 'refusal_similarity_enabled'
export const REFUSAL_SIMILARITY_VALUE_SETTING = 'refusal_similarity'
export const REFUSAL_DEVICE_BLOCK_SETTING = 'refusal_device_block_enabled'
export const REFUSAL_SIMILARITY_CHOICES = Object.freeze([80, 85, 90, 95])

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

export function refusalFingerprint(body = {}, inbound = body) {
  const prompt = extractPrompt(inbound, body)
  const model = String(body?.model || inbound?.model || '')
    .trim()
    .toLowerCase()
  const payload = {
    model,
    prompt: normalizeText(prompt.joined),
    tools: toolNamesOf(body).length ? toolNamesOf(body) : toolNamesOf(inbound),
  }
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
  const message = [result?.body?.error?.message, result?.body?.message, extra?.error_message, extra?.message]
    .filter(Boolean)
    .join('\n')
  if (isUsagePolicyErrorMessage(message)) return true
  const codes = [
    result?.body?.error?.code,
    result?.body?.error?.upstream_code,
    result?.body?.code,
    result?.code,
    result?.error_code,
    extra?.error_code,
    extra?.code,
    extra?.upstream_code,
  ]
  return codes.some(isContentPolicyErrorCode)
}

function refusalBlockSuffix(match) {
  if (!match || typeof match !== 'object') return null
  if (match.kind === 'device') {
    const ban = String(match.row?.reason || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
    return {
      message: ban ? ` 该设备此前已被封禁（${ban}）。` : ' 该设备此前已被封禁。',
      details: ban ? { reason: 'device', ban_reason: ban } : { reason: 'device' },
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
    message: extra ? REFUSAL_GUARD_MESSAGE + extra.message : REFUSAL_GUARD_MESSAGE,
    details: extra?.details,
  })
}

const DEVICE_ID_MIN = 8
const DEVICE_ID_MAX = 200

/** Inbound client device. Never the slot's rewritten outbound id, and never IP/UA/API key. */
export function inboundRefusalDeviceId({ inbound, body, headers } = {}) {
  const id = resolveInboundIdentity({ inbound, body, headers }).deviceId
  if (id.length < DEVICE_ID_MIN || id.length > DEVICE_ID_MAX) return ''
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
  return {
    enabled: isRefusalGuardEnabled(readSetting),
    similarity_enabled: flagOn(read(REFUSAL_SIMILARITY_SETTING, true)),
    similarity,
    device_block_enabled: flagOn(read(REFUSAL_DEVICE_BLOCK_SETTING, true)),
  }
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
  if (Object.hasOwn(body, 'similarity') && normalizeRefusalSimilarity(body.similarity) == null) {
    problems.push('similarity 只能是 80、85、90、95')
  }
  if (problems.length) return { ok: false, problems }
  if (typeof body.enabled === 'boolean') settings.set(REFUSAL_GUARD_SETTING, body.enabled)
  if (typeof body.similarity_enabled === 'boolean') settings.set(REFUSAL_SIMILARITY_SETTING, body.similarity_enabled)
  if (typeof body.device_block_enabled === 'boolean') {
    settings.set(REFUSAL_DEVICE_BLOCK_SETTING, body.device_block_enabled)
  }
  if (Object.hasOwn(body, 'similarity')) {
    settings.set(REFUSAL_SIMILARITY_VALUE_SETTING, normalizeRefusalSimilarity(body.similarity))
  }
  return { ok: true }
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
