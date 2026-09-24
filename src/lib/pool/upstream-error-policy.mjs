import { normalizeThinkingForModel } from '../protocol/thinking.mjs'
import { flattenSearchResultHistory, rectifyUnofficialRequestForRetry } from '../protocol/request-rectifier.mjs'
import {
  assistantStopReason,
  assistantVisibleOutput,
  isCompleteAssistantMessage,
  isIncompleteAssistantMessage,
  isWrapConnectionError,
} from '../core/errors.mjs'
import { isPlanLimitMessage, parseLimitResetFromMessage, parseResetMs } from './quota-window.mjs'
import { attachFailureDecision } from './unit-decision.mjs'

const ENTITLEMENT_PATTERNS = [
  /extra usage required/i,
  /usage credits? (?:are )?required/i,
  /fast (?:mode|request).*(?:credit|entitlement)/i,
]

const SIGNATURE_PATTERNS = [
  /signature/i,
  /expected[`\s].*thinking/i,
  /cannot be modified/i,
  /must contain thinking/i,
  /each thinking block/i,
]

const PREFILL_PATTERNS = [
  /conversation must (?:end|start)/i,
  /final (?:assistant )?message/i,
  /messages?:.*(?:end|start).*(?:user|assistant)/i,
  /must (?:end|start) with a user/i,
]

const TOOL_PAIR_PATTERNS = [/tool_use.*tool_result/i, /tool_result.*(?:required|missing|expected)/i, /tool_use_id/i]

const SCHEMA_PATTERNS = [/additionalProperties/i, /output_config/i]

// Replayed search history encrypted for another account/organization.
const SEARCH_HISTORY_PATTERNS = [/encrypted_content/i, /`?search_result`?\s+block/i, /web_search_result/i]

const ADAPTIVE_PATTERNS = [/adaptive thinking/i, /thinking\.type.*adaptive/i, /does not support adaptive/i]

const ORGANIZATION_DISABLED_PATTERNS = [
  /organization has been disabled/i,
  /oauth authentication is currently not allowed/i,
  /organization.*(?:blocked|banned|disabled)/i,
]

function bodyMessage(body) {
  if (typeof body === 'string') return body
  return String(body?.error?.message || body?.error?.error || body?.message || body?.error || '')
}

function bodyCode(body) {
  return String(body?.error?.code || body?.error?.type || body?.type || '')
}

function header(headers, name) {
  const target = String(name).toLowerCase()
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === target) return Array.isArray(value) ? value[0] : value
  }
  return null
}

function resetFromHeaders(headers, now = Date.now()) {
  const retryAfter = header(headers, 'retry-after')
  if (retryAfter != null) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000
    const parsed = Date.parse(String(retryAfter))
    if (Number.isFinite(parsed)) return parsed
  }
  const resetNames = [
    'anthropic-ratelimit-unified-5h-reset',
    'anthropic-ratelimit-unified-7d-reset',
    'anthropic-ratelimit-requests-reset',
  ]
  const resets = resetNames
    .map((name) => header(headers, name))
    .map((value) => {
      if (value == null) return null
      const number = Number(value)
      if (Number.isFinite(number)) return number < 1e12 ? number * 1000 : number
      const parsed = Date.parse(String(value))
      return Number.isFinite(parsed) ? parsed : null
    })
    .filter((value) => value && value > now)
  return resets.length ? Math.min(...resets) : null
}

function usageWindowReset(usage, now = Date.now()) {
  if (!usage || typeof usage !== 'object') return null
  const candidates = [usage.reset_5h, usage.reset_7d, usage['5h']?.reset, usage['7d']?.reset]
    .map((value) => parseResetMs(value))
    .filter((value) => Number.isFinite(value) && value > now)
  return candidates.length ? Math.min(...candidates) : null
}

function accountLimitUntil(reset, usage, now, message = '') {
  return reset || parseLimitResetFromMessage(message, now) || usageWindowReset(usage, now) || now + 30 * 60_000
}

function isUsagePolicyMessage(message) {
  return /usage policy|violate our usage policy/i.test(String(message || ''))
}

export const FABLE_FAMILY_KEY = 'fable'

function modelFamily(model) {
  const value = String(model || '').toLowerCase()
  for (const family of ['opus', 'sonnet', 'haiku', 'fable']) {
    if (value.includes(family)) return family
  }
  return null
}

export function isFableModel(model) {
  return String(model || '')
    .toLowerCase()
    .includes('fable')
}

export function modelCooldownKeys(model) {
  const key = normalizeModelKey(model)
  if (!key) return []
  const keys = [key]
  if (isFableModel(key) && key !== FABLE_FAMILY_KEY) keys.push(FABLE_FAMILY_KEY)
  return keys
}

function isFableWindowLimit(headers) {
  const claim = String(header(headers, 'anthropic-ratelimit-unified-representative-claim') || '')
  const statusOi = String(header(headers, 'anthropic-ratelimit-unified-7d_oi-status') || '').toLowerCase()
  return /seven_day_overage_included|7d_oi/i.test(claim) || statusOi === 'rejected' || statusOi === 'rate_limited'
}

function fableResetFromHeaders(headers, now = Date.now()) {
  const raw = header(headers, 'anthropic-ratelimit-unified-7d_oi-reset')
  if (raw == null) return null
  const number = Number(raw)
  if (Number.isFinite(number)) {
    const ms = number < 1e12 ? number * 1000 : number
    return ms > now ? ms : null
  }
  const parsed = Date.parse(String(raw))
  return Number.isFinite(parsed) && parsed > now ? parsed : null
}

function isUnifiedAccountLimit(headers) {
  const status5h = String(header(headers, 'anthropic-ratelimit-unified-5h-status') || '').toLowerCase()
  const status7d = String(header(headers, 'anthropic-ratelimit-unified-7d-status') || '').toLowerCase()
  return [status5h, status7d].some((status) => status === 'rejected' || status === 'rate_limited')
}

function resultErrorCode(result) {
  return String(result?.body?.error?.code || result?.body?.error?.type || '')
}

/**
 * First wrap hop after idle often streams a local/stale 401
 * (`request_id:null` or `upstream_stream_incomplete`) because the CLI
 * has not loaded the host ticket yet. That is not grant death.
 */
export function isUnconfirmedAuthFailure(result = {}) {
  const message = bodyMessage(result.body)
  const code = bodyCode(result.body)
  const workerCode = resultErrorCode(result)
  const hay = `${code} ${message} ${workerCode}`
  const authish =
    Number(result.status) === 401 ||
    /token has been revoked|oauth_revoked|invalid_grant|authentication_error|needs_refresh|credential needs refresh|no credential|credential_required/i.test(
      hay,
    )
  if (!authish) return false
  if (result.terminalState === 'incomplete' || /upstream_stream_incomplete/i.test(hay)) return true
  if (/"request_id"\s*:\s*null/.test(message)) return true
  if (/needs_refresh|credential needs refresh|slot has no credential|credential_required/i.test(hay)) return true
  return false
}

const TIMEOUT_PATTERNS = /timeout|deadline|response header|timed out/i

function isTimeoutFailure(workerCode, message) {
  return TIMEOUT_PATTERNS.test(`${workerCode} ${message}`)
}

function isProxyFailure(workerCode, message) {
  const hay = `${workerCode} ${message}`
  if (isTimeoutFailure(workerCode, message)) return false
  return /proxy|socks|dial|dns|tls|connect/i.test(hay)
}

function continueWithoutCooldown({ scope, reason, retrySameAccount = true } = {}) {
  return {
    scope,
    action: 'continue',
    reason,
    cooldownUntil: null,
    retrySameAccount,
  }
}

function claudeStopReasonOf(result) {
  return assistantStopReason(result)
}

function claudeHasVisibleOutput(body) {
  return assistantVisibleOutput(body)
}

/** 200 + stop_reason=refusal with no visible text — not a successful empty reply. */
function isContentFilterRefusal(result = {}) {
  return isSilentClaudeRefusal(result)
}

export function isSilentClaudeRefusal(result = {}) {
  if (claudeStopReasonOf(result) !== 'refusal') return false
  return !claudeHasVisibleOutput(result.body)
}

export const DEFAULT_OAUTH_401_COOLDOWN_MS = 120_000
export const MAX_OAUTH_401_COOLDOWN_MS = 600_000
/** Upstream 5xx: stop the account and the same prompt. Do not open another slot. */
export const PROVIDER_PAUSE_MS = 60 * 60 * 1000

export function clampOauth401CooldownMs(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n)) return DEFAULT_OAUTH_401_COOLDOWN_MS
  return Math.min(MAX_OAUTH_401_COOLDOWN_MS, Math.max(5_000, n))
}

const GRANT_DEAD = /token has been revoked|oauth_revoked|invalid_grant/i

function classifyOAuth401(hasRefresh, hay) {
  if (hasRefresh === false) {
    return {
      scope: 'account',
      action: 'continue-and-cooldown',
      reason: 'oauth_no_refresh',
      cooldownUntil: Number.MAX_SAFE_INTEGER,
      retrySameAccount: false,
    }
  }
  if (GRANT_DEAD.test(String(hay || ''))) {
    return {
      scope: 'account',
      action: 'continue-and-cooldown',
      reason: 'oauth_revoked',
      cooldownUntil: Number.MAX_SAFE_INTEGER,
      retrySameAccount: false,
    }
  }
  return {
    scope: 'credential',
    action: 'continue',
    reason: 'oauth_refresh_required',
    cooldownUntil: null,
    retrySameAccount: true,
  }
}

function overloadedUnit(now) {
  return {
    scope: 'provider',
    action: 'continue',
    reason: 'provider_overloaded',
    cooldownUntil: null,
    retrySameAccount: false,
    circuit: true,
  }
}

function classifyUpstreamResultRaw(
  result = {},
  {
    model = null,
    now = Date.now(),
    repaired = false,
    hasRefresh = null,
    oauth401CooldownMs = DEFAULT_OAUTH_401_COOLDOWN_MS,
    credentialGeneration = null,
    priorAuth401Generation = null,
    signatureRepair = false,
    usage = null,
  } = {},
) {
  if (isContentFilterRefusal(result) && !result.committed) {
    return { scope: 'request', action: 'stop', reason: 'content_filter_refusal', cooldownUntil: null }
  }
  const completeAssistant = isCompleteAssistantMessage(result)
  const malformedSuccess =
    !completeAssistant &&
    (result.ok === true || result.terminalState === 'verified') &&
    Number(result.status || 200) >= 200 &&
    Number(result.status || 200) < 300
  if ((isIncompleteAssistantMessage(result) || malformedSuccess) && !result.committed) {
    return continueWithoutCooldown({
      scope: 'stream',
      reason: 'incomplete_assistant',
      retrySameAccount: true,
    })
  }
  if (completeAssistant) {
    return { scope: 'success', action: 'complete', cooldownUntil: null }
  }
  const status = Number(result.status) || 0
  const message = bodyMessage(result.body)
  const code = bodyCode(result.body)
  const workerCode = resultErrorCode(result)
  const reset = resetFromHeaders(result.headers, now)

  if (workerCode === 'selection_cancelled' || /aborted|cancelled|canceled/i.test(workerCode)) {
    return { scope: 'client_lifecycle', action: 'stop', reason: 'client_cancelled', cooldownUntil: null }
  }
  const hay = `${code} ${message} ${workerCode}`
  if (/token has been revoked|oauth_revoked|invalid_grant|authentication_error/i.test(hay) || status === 401) {
    if (isUnconfirmedAuthFailure(result)) {
      return {
        scope: 'account',
        action: result.committed ? 'stop' : 'continue',
        reason: 'oauth_unconfirmed',
        cooldownUntil: null,
      }
    }
    return classifyOAuth401(hasRefresh, hay)
  }

  if (result.committed) {
    return {
      scope: 'stream',
      action: 'stop',
      reason: 'downstream_committed_or_incomplete',
      cooldownUntil: null,
    }
  }
  // Plan limit arrives as 429, as a kernel 502 provider_error, or (pre-restore)
  // as 200 + SSE error. The text decides, not the status (sub2api handle429).
  if (isPlanLimitMessage(message)) {
    return {
      scope: 'account',
      action: 'continue-and-cooldown',
      reason: 'account_quota_exhausted',
      cooldownUntil: accountLimitUntil(reset, usage, now, message),
      retrySameAccount: false,
    }
  }
  if (workerCode === 'empty_response') {
    return {
      scope: 'account',
      action: 'continue',
      reason: 'empty_response',
      cooldownUntil: null,
      retrySameAccount: true,
    }
  }
  if (isWrapConnectionError(message) || isWrapConnectionError(hay)) {
    return continueWithoutCooldown({
      scope: 'worker',
      reason: 'wrap_connection_error',
      retrySameAccount: true,
    })
  }
  if (result.transportError || status === 0) {
    if (isProxyFailure(workerCode, message)) {
      return {
        scope: 'proxy',
        action: 'continue-and-cooldown',
        reason: 'proxy_transport_failure',
        cooldownUntil: now + 60_000,
      }
    }
    return continueWithoutCooldown({
      scope: 'worker',
      reason: isTimeoutFailure(workerCode, message) ? 'worker_timeout' : 'worker_transport_failure',
    })
  }
  if (status === 400) {
    const hay = `${code} ${message}`
    // Default off. Turning this on drops thinking history and retries, so the
    // client sees 200 and never learns the upstream rejected the signature.
    // Probe / forged signatures need the 400. Search / prefill / tool-pair
    // / schema / adaptive repairs are independent of this switch.
    if (!repaired && signatureRepair && SIGNATURE_PATTERNS.some((pattern) => pattern.test(hay))) {
      return {
        scope: 'request',
        action: 'repair-and-retry',
        reason: 'signature_repairable',
        cooldownUntil: null,
      }
    }
    if (!repaired && SEARCH_HISTORY_PATTERNS.some((pattern) => pattern.test(hay))) {
      return {
        scope: 'request',
        action: 'repair-and-retry',
        reason: 'search_repairable',
        cooldownUntil: null,
      }
    }
    if (!repaired && PREFILL_PATTERNS.some((pattern) => pattern.test(hay))) {
      return {
        scope: 'request',
        action: 'repair-and-retry',
        reason: 'prefill_repairable',
        cooldownUntil: null,
      }
    }
    if (!repaired && TOOL_PAIR_PATTERNS.some((pattern) => pattern.test(hay))) {
      return {
        scope: 'request',
        action: 'repair-and-retry',
        reason: 'tool_pair_repairable',
        cooldownUntil: null,
      }
    }
    if (!repaired && SCHEMA_PATTERNS.some((pattern) => pattern.test(hay))) {
      return {
        scope: 'request',
        action: 'repair-and-retry',
        reason: 'schema_repairable',
        cooldownUntil: null,
      }
    }
    if (!repaired && ADAPTIVE_PATTERNS.some((pattern) => pattern.test(hay))) {
      return {
        scope: 'request',
        action: 'repair-and-retry',
        reason: 'thinking_repairable',
        cooldownUntil: null,
      }
    }
    return { scope: 'request', action: 'stop', reason: 'invalid_request', cooldownUntil: null }
  }
  if (status === 401) return classifyOAuth401(hasRefresh, hay)
  if (status === 403) {
    if (ORGANIZATION_DISABLED_PATTERNS.some((pattern) => pattern.test(message))) {
      return {
        scope: 'account',
        action: 'disable',
        reason: 'organization_disabled',
        cooldownUntil: null,
      }
    }
    if (/<html|cloudflare|proxy/i.test(message)) {
      return {
        scope: 'proxy',
        action: 'continue-and-cooldown',
        reason: 'proxy_or_edge_forbidden',
        cooldownUntil: now + 60_000,
      }
    }
    if (isFableModel(model)) {
      return {
        scope: 'account',
        action: 'continue',
        reason: 'fable_plan_denied',
        cooldownUntil: null,
        retrySameAccount: false,
        mark_tier: 'pro',
      }
    }
    return {
      scope: 'credential',
      action: 'continue-and-cooldown',
      reason: 'permission_denied',
      cooldownUntil: now + clampOauth401CooldownMs(oauth401CooldownMs),
    }
  }
  if (status === 429) {
    if (ENTITLEMENT_PATTERNS.some((pattern) => pattern.test(message))) {
      return { scope: 'request', action: 'stop', reason: 'entitlement_required', cooldownUntil: null }
    }
    if (isUnifiedAccountLimit(result.headers)) {
      return {
        scope: 'account',
        action: 'continue-and-cooldown',
        reason: 'account_quota_exhausted',
        cooldownUntil: accountLimitUntil(reset, usage, now, message),
      }
    }
    if (isFableWindowLimit(result.headers) || isFableModel(model)) {
      const fableReset = fableResetFromHeaders(result.headers, now) || reset
      return {
        scope: 'model',
        action: 'continue-and-cooldown',
        reason: 'fable_rate_limited',
        model: FABLE_FAMILY_KEY,
        cooldownUntil: fableReset || now + 60_000,
      }
    }
    const family = modelFamily(model)
    if (family) {
      return {
        scope: 'model',
        action: 'continue-and-cooldown',
        reason: `${family}_rate_limited`,
        model: family === 'fable' ? FABLE_FAMILY_KEY : normalizeModelKey(model),
        cooldownUntil: reset || now + 60_000,
      }
    }
    return {
      scope: 'account',
      action: 'continue-and-cooldown',
      reason: 'rate_limited',
      cooldownUntil: accountLimitUntil(reset, usage, now, message),
    }
  }
  if (status === 529) {
    // Original gate: RateLimitService writes overload_until. Do not also open the unit circuit.
    return {
      scope: 'provider',
      action: 'continue',
      reason: 'provider_overloaded',
      cooldownUntil: null,
      retrySameAccount: false,
    }
  }
  if (status === 408 || status === 502 || status === 503 || status === 504 || status >= 500) {
    if (workerCode === 'slot_busy' || /no free slot|slot_busy/i.test(hay)) {
      return continueWithoutCooldown({
        scope: 'worker',
        reason: 'slot_busy',
        retrySameAccount: false,
      })
    }
    if (isFableModel(model) && (status === 408 || status === 504 || /timeout/i.test(message))) {
      return {
        scope: 'model',
        action: 'continue-and-cooldown',
        reason: 'fable_timeout',
        model: FABLE_FAMILY_KEY,
        cooldownUntil: now + 30_000,
      }
    }
    if (status === 408 || isTimeoutFailure(workerCode, message)) {
      return continueWithoutCooldown({
        scope: 'provider',
        reason: 'provider_timeout',
      })
    }
    if (isUsagePolicyMessage(message)) {
      return {
        scope: 'account',
        action: 'pause',
        reason: 'provider_pause',
        cooldownUntil: now + PROVIDER_PAUSE_MS,
        retrySameAccount: false,
        rememberRefusal: true,
        refusalTtlMs: PROVIDER_PAUSE_MS,
      }
    }
    // A 2xx stream that died before visible output used to be rewritten to 502.
    // Kernel may also send that 502 with terminal incomplete. Neither is overload.
    if (
      result.terminalState === 'incomplete' &&
      !result.committed &&
      !isUsagePolicyMessage(message) &&
      !/overload/i.test(message)
    ) {
      return continueWithoutCooldown({
        scope: 'stream',
        reason: 'empty_response',
        retrySameAccount: true,
      })
    }
    return overloadedUnit(now)
  }
  return { scope: 'request', action: 'stop', reason: `http_${status}`, cooldownUntil: null }
}

export function classifyUpstreamResult(result, opts) {
  return attachFailureDecision(classifyUpstreamResultRaw(result, opts))
}

export function shouldContinue(policy) {
  return policy?.action === 'continue' || policy?.action === 'continue-and-cooldown'
}

export function normalizeModelKey(model) {
  return String(model || '')
    .trim()
    .toLowerCase()
}

function placeholderContent(role) {
  return [
    {
      type: 'text',
      text: role === 'assistant' ? '(assistant content removed)' : '(content removed)',
    },
  ]
}

function rectifyMessageContent(content, role) {
  if (!Array.isArray(content)) return content
  const next = []
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      next.push(block)
      continue
    }
    if (block.type === 'text' && !String(block.text || '').trim()) continue
    if (block.type === 'thinking') {
      const text = String(block.thinking || '').trim()
      if (text) next.push({ type: 'text', text })
      continue
    }
    if (block.type === 'redacted_thinking') continue
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      next.push({ ...block, content: rectifyMessageContent(block.content, role) })
      continue
    }
    next.push(block)
  }
  return next.length ? next : placeholderContent(role)
}

/** Convert every thinking block to text and disable top-level thinking (sub2api retry). */
export function repairAnthropicRequest(body = {}, policy = {}) {
  if (policy.action !== 'repair-and-retry') return body
  const reason = String(policy.reason || '')
  if (reason === 'prefill_repairable' || reason === 'tool_pair_repairable' || reason === 'schema_repairable') {
    return rectifyUnofficialRequestForRetry(body)
  }
  if (reason === 'search_repairable') {
    return flattenSearchResultHistory(body)
  }
  if (reason === 'thinking_repairable') {
    const next = structuredClone(body)
    normalizeThinkingForModel(next)
    return next
  }
  const out = structuredClone(body)
  if (out.thinking) delete out.thinking
  if (Array.isArray(out.context_management?.edits)) {
    const edits = out.context_management.edits.filter((edit) => edit?.type !== 'clear_thinking_20251015')
    if (edits.length) out.context_management.edits = edits
    else delete out.context_management.edits
  }
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((message) => {
      if (!Array.isArray(message?.content)) return message
      return { ...message, content: rectifyMessageContent(message.content, message.role) }
    })
  }
  return out
}
