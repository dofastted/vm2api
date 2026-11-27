import { apiKeyGateDetails } from '../admin/api-keys.mjs'
import crypto from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  FULL_GEMINI_CAPABILITIES,
  NATIVE_TUI_CAPABILITIES,
  createGeminiCollector,
  createGeminiEventDecoder,
  createGeminiRestoreTransform,
  createSseFrameSplitter,
} from '../protocol/gemini-convert.mjs'
import { createStreamTiming } from '../protocol/stream-timing.mjs'
import { isGeminiModelEnabled, isGeminiSeriesId, resolveGeminiDefaultEffort } from '../protocol/gemini-model-policy.mjs'
import { classifyAntigravityModel, indexAccountModelCatalog, resolveUpstreamModel } from './model-catalog.mjs'
import { createDirectCragClient } from './direct-client.mjs'
import { callGeminiHost, callGeminiHostStream } from './routes.mjs'
import { DEFAULT_GEMINI_ROUTING, normalizeGeminiRouting } from './routing-config.mjs'
import { GEMINI_LICENSE_MESSAGES, RECOVERABLE_GEMINI_SEAT_CODES } from './subscription.mjs'
import { PLATFORM_SCOPE, geminiEnvMatchesOwnerScope } from '../admin/resource-owner.mjs'

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const MODEL = /^[a-z0-9][a-z0-9._-]{0,99}$/
const RUN_ID = /^[a-f0-9]{32}$/
const CONV_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_CONCURRENCY = 64
const DEFAULT_CONCURRENCY = 20
const DEFAULT_MAX_SESSIONS = 20
const POLL_MS = 250
const TURN_MS = 120_000
const STREAM_TURN_MS = 300_000
const DEFAULT_QUOTA_COOLDOWN_MS = 60_000
const DEFAULT_ACCOUNT_COOLDOWN_MS = 5 * 60_000
const TOOL_CONTINUATION_TTL_MS = 10 * 60_000
const TOOL_CONTINUATION_MAX = 2048
const MAX_TRACKED_CONVERSATION_IDS = 32

function mintOutboundConversationId(avoidSet = null) {
  for (let i = 0; i < 8; i += 1) {
    const id = `gc_${crypto.randomBytes(12).toString('hex')}`
    if (!avoidSet || !avoidSet.has(id)) return id
  }
  return `gc_${crypto.randomBytes(16).toString('hex')}`
}

function normalizeConcurrency(value, fallback = DEFAULT_CONCURRENCY) {
  if (Number.isSafeInteger(value) && value >= 1 && value <= MAX_CONCURRENCY) return value
  return Number.isSafeInteger(fallback) && fallback >= 1 && fallback <= MAX_CONCURRENCY ? fallback : DEFAULT_CONCURRENCY
}

const FAILURES = {
  gemini_host_unavailable: [503, 'Gemini host is not available.'],
  gemini_host_protocol_error: [502, 'Gemini host returned an unusable response.'],
  gemini_no_account: [429, '号池负载过高，请稍后再试'],
  gemini_pool_overloaded: [429, '号池负载过高，请稍后再试'],
  gemini_upstream_unavailable: [503, 'Gemini upstream service temporarily unavailable.'],
  gemini_model_unavailable: [404, 'This Gemini model is not available on an authorized account.'],
  gemini_proxy_unavailable: [503, 'The selected Gemini account has no usable proxy.'],
  gemini_proxy_calibration_mismatch: [409, 'Bound Gemini proxy calibration digest mismatch.'],
  gemini_operation_busy: [503, 'Gemini accounts are busy. Retry shortly.'],
  gemini_oauth_required: [503, 'The selected Gemini account needs authorization again.'],
  gemini_api_key_invalid: [503, 'The selected Gemini API key is not valid.'],
  gemini_location_unsupported: [403, 'Google rejected this account location for Antigravity.'],
  gemini_account_verification_required: [
    403,
    'Google requires browser account verification before this account can use Antigravity.',
  ],
  gemini_client_unsupported: [
    403,
    'Google rejected the current Antigravity client version or metadata (UNSUPPORTED_CLIENT).',
  ],
  gemini_account_ineligible: [403, 'Google rejected this account as ineligible for Antigravity.'],
  gemini_proxy_error: [502, 'The bound Gemini proxy could not reach Google.'],
  gemini_quota_exhausted: [429, 'The selected Gemini account quota is exhausted.'],
  gemini_content_rejected: [
    429,
    'The request prompt was rejected by upstream content filtering (429); account quota was not exhausted.',
  ],
  gemini_inference_timeout: [504, 'The Gemini turn timed out.'],
  gemini_inference_invalid_output: [502, 'Gemini returned an unreadable response.'],
  gemini_tool_call_required: [
    502,
    'Upstream completed without a required function call (functionCallingConfig.mode=ANY / tool_choice required).',
  ],
  gemini_inference_start_failed: [503, 'Gemini could not start the turn.'],
  gemini_inference_cancelled: [499, 'The Gemini turn was cancelled.'],
  gemini_inference_output_limit: [502, 'The Gemini response exceeded the text limit.'],
  gemini_inference_tool_blocked: [400, 'This Gemini route accepts one plain-text turn and no tools.'],
  gemini_session_conflict: [
    409,
    'The outbound session cannot continue after appended input while a tool turn is still suspended.',
  ],
  gemini_inference_failed: [502, 'The Gemini turn failed.'],
  gemini_unsupported_turn: [
    400,
    'The selected Gemini environment does not support the requested tools, history, parameters, or media.',
  ],
  gemini_invalid_request: [400, 'Invalid Gemini request payload.'],
  gemini_native_tty_unavailable: [503, 'No free Linux virtual console is available for CRAGGemini.'],
  gemini_native_worker_unavailable: [503, 'The CRAGGemini native worker is unavailable.'],
  gemini_native_config_invalid: [
    503,
    'CRAGGemini rejected the host-generated worker configuration; align the host script and signed payload versions.',
  ],
  gemini_native_bridge_timeout: [503, 'The CRAGGemini TUI did not connect to its native worker in time.'],
  gemini_egress_unavailable: [503, 'Gemini egress is not available.'],
  gemini_oauth_tools_missing: [503, 'Gemini OAuth runtime tools are missing.'],
  gemini_ipv4_forwarding_unavailable: [503, 'Gemini IPv4 forwarding is not available.'],
  gemini_sandbox_apparmor_restricted: [
    503,
    'The host AppArmor policy blocks Gemini unprivileged sandboxes; run prepare-gemini or open Gemini maintenance.',
  ],
  gemini_sandbox_unavailable: [
    503,
    'The host unprivileged bwrap sandbox is unavailable; inspect Gemini maintenance and host service logs.',
  ],
  license_required: [403, GEMINI_LICENSE_MESSAGES.license_required],
  license_expired: [403, GEMINI_LICENSE_MESSAGES.license_expired],
  license_not_yet_valid: [403, GEMINI_LICENSE_MESSAGES.license_not_yet_valid],
  license_invalid: [403, GEMINI_LICENSE_MESSAGES.license_invalid],
  license_binding_mismatch: [403, GEMINI_LICENSE_MESSAGES.license_binding_mismatch],
  license_payload_key_mismatch: [403, GEMINI_LICENSE_MESSAGES.license_payload_key_mismatch],
  license_unconfigured: [403, GEMINI_LICENSE_MESSAGES.license_unconfigured],
  gemini_subscription_sync_pending: [503, GEMINI_LICENSE_MESSAGES.gemini_subscription_sync_pending],
}

const NON_CIRCUIT_FAILURES = new Set([
  'gemini_quota_exhausted',
  'gemini_content_rejected',
  'gemini_upstream_unavailable',
  'gemini_oauth_required',
  'gemini_api_key_invalid',
  'gemini_model_unavailable',
  'gemini_unsupported_turn',
  'gemini_inference_tool_blocked',
  'gemini_session_conflict',
  'gemini_tool_call_required',
  'gemini_native_config_invalid',
  'gemini_proxy_calibration_mismatch',
  'license_required',
  'license_expired',
  'license_not_yet_valid',
  'license_invalid',
  'license_binding_mismatch',
  'license_payload_key_mismatch',
  'license_unconfigured',
  'gemini_subscription_sync_pending',
])

const FAILOVER_ERRORS = new Set([
  'gemini_quota_exhausted',
  'gemini_upstream_unavailable',
  'gemini_account_verification_required',
  'gemini_location_unsupported',
  'gemini_client_unsupported',
  'gemini_account_ineligible',
  'gemini_oauth_required',
  'gemini_operation_busy',
  'gemini_proxy_unavailable',
  'gemini_proxy_error',
  'gemini_native_worker_unavailable',
  'gemini_native_bridge_timeout',
  'gemini_inference_start_failed',
  'gemini_inference_failed',
  'gemini_inference_timeout',
  'gemini_inference_invalid_output',
  'gemini_host_protocol_error',
])

const ACCOUNT_WIDE_COOLDOWN_ERRORS = new Set([
  'gemini_account_verification_required',
  'gemini_location_unsupported',
  'gemini_client_unsupported',
  'gemini_account_ineligible',
  'gemini_oauth_required',
])

const INELIGIBLE_STATES = new Set(['verification_required', 'location_unsupported', 'client_unsupported', 'ineligible'])

const CONTENT_OUTPUT_EVENTS = new Set([
  'text',
  'thinking',
  'thinking_signature',
  'text_signature',
  'tool_call',
  'image',
  'search',
  'stop',
])

const GROUP_QUOTA_EXHAUSTED_REASONS = new Set(['QUOTA_EXHAUSTED', 'INSUFFICIENT_G1_CREDITS_BALANCE'])
const SHORT_RATE_LIMIT_MAX_MS = 5_000
const WORKER_SESSION_CONFLICT_CODES = new Set(['tool_continuation_aborted', 'gemini_session_conflict'])

function resolveInferFailureCode(errBody, statusCode) {
  const rawCode = typeof errBody?.code === 'string' ? errBody.code : null
  if (rawCode && Object.hasOwn(FAILURES, rawCode)) return rawCode
  if (rawCode && WORKER_SESSION_CONFLICT_CODES.has(rawCode)) return 'gemini_session_conflict'
  if (statusCode === 429) {
    const quotaMeta = parseUpstreamQuotaMeta(errBody)
    return quotaMeta.contentRejected ? 'gemini_content_rejected' : 'gemini_quota_exhausted'
  }
  if (statusCode === 503) return 'gemini_upstream_unavailable'
  if (statusCode === 400) return 'gemini_invalid_request'
  if (statusCode === 404) return 'gemini_model_unavailable'
  if (statusCode === 409 && rawCode && WORKER_SESSION_CONFLICT_CODES.has(rawCode)) {
    return 'gemini_session_conflict'
  }
  return 'gemini_inference_failed'
}

function parseGoDurationMs(raw) {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text || text.length > 64) return null
  let totalMs = 0
  let pos = 0
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g
  for (const match of text.matchAll(re)) {
    if (match.index !== pos) return null
    pos = match.index + match[0].length
    const val = Number(match[1])
    if (!Number.isFinite(val) || val < 0) return null
    const unit = match[2]
    const factor = unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : 3_600_000
    totalMs += val * factor
  }
  if (pos !== text.length || !Number.isFinite(totalMs) || totalMs <= 0) return null
  return Math.min(3_600_000, Math.max(1, Math.ceil(totalMs)))
}

function parseUpstreamQuotaMeta(rawBody) {
  let upstreamReason =
    typeof rawBody?.upstream_reason === 'string' && rawBody.upstream_reason ? rawBody.upstream_reason : null
  const errObj = rawBody?.error && typeof rawBody.error === 'object' ? rawBody.error : rawBody
  const details = Array.isArray(errObj?.details) ? errObj.details : []
  for (const item of details) {
    if (!item || typeof item !== 'object') continue
    if (!upstreamReason && typeof item.reason === 'string' && item.reason) {
      upstreamReason = item.reason
    }
  }
  const explicitContentRejected = rawBody?.content_rejected === true || rawBody?.code === 'gemini_content_rejected'
  return { upstreamReason, contentRejected: explicitContentRejected }
}

function parseRetryAfterMs(rawBody, headers) {
  const bodyMs = Number(rawBody?.retry_after_ms ?? rawBody?.retryAfterMs)
  if (Number.isFinite(bodyMs) && bodyMs > 0) {
    return Math.min(3_600_000, Math.max(1_000, Math.round(bodyMs)))
  }
  const bodySec = Number(rawBody?.retry_after ?? rawBody?.retryAfter)
  if (Number.isFinite(bodySec) && bodySec > 0) {
    return Math.min(3_600_000, Math.max(1_000, Math.round(bodySec * 1000)))
  }
  const errObj = rawBody?.error && typeof rawBody.error === 'object' ? rawBody.error : rawBody
  const details = Array.isArray(errObj?.details) ? errObj.details : []
  let googleMs = null
  for (const item of details) {
    if (!item || typeof item !== 'object') continue
    const rd = parseGoDurationMs(item.retryDelay)
    if (rd != null) googleMs = Math.max(googleMs || 0, rd)
    const meta = item.metadata && typeof item.metadata === 'object' ? item.metadata : null
    if (meta) {
      const qd = parseGoDurationMs(meta.quotaResetDelay)
      if (qd != null) googleMs = Math.max(googleMs || 0, qd)
      if (typeof meta.quotaResetTimeStamp === 'string' && meta.quotaResetTimeStamp.trim()) {
        const parsedTs = Date.parse(meta.quotaResetTimeStamp.trim())
        if (Number.isFinite(parsedTs)) {
          const delta = parsedTs - Date.now()
          if (delta > 0) googleMs = Math.max(googleMs || 0, Math.min(3_600_000, Math.round(delta)))
        }
      }
    }
  }
  if (googleMs != null && googleMs > 0) {
    return Math.min(3_600_000, Math.max(1_000, googleMs))
  }
  const headerVal = headers?.['retry-after'] ?? headers?.['Retry-After']
  if (headerVal != null && headerVal !== '') {
    const asNum = Number(headerVal)
    if (Number.isFinite(asNum) && asNum > 0) {
      return Math.min(3_600_000, Math.max(1_000, Math.round(asNum * 1000)))
    }
    const asDur = parseGoDurationMs(String(headerVal))
    if (asDur != null) {
      return Math.min(3_600_000, Math.max(1_000, asDur))
    }
    const asDate = Date.parse(String(headerVal))
    if (Number.isFinite(asDate)) {
      const delta = asDate - Date.now()
      if (delta > 0) return Math.min(3_600_000, Math.max(1_000, Math.round(delta)))
    }
  }
  return null
}

function fail(status, code, message = FAILURES[code]?.[1] || code) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

function known(error) {
  const code = error?.code
  if (typeof code === 'string' && Object.hasOwn(FAILURES, code)) {
    const [status, message] = FAILURES[code]
    const out = fail(Number.isInteger(error.status) ? error.status : status, code, error.message || message)
    if (Number.isInteger(error.upstreamStatus)) out.upstreamStatus = error.upstreamStatus
    if (Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0) out.retryAfterMs = error.retryAfterMs
    if (error.retryAfter != null) out.retryAfter = error.retryAfter
    if (typeof error.upstreamReason === 'string' && error.upstreamReason) out.upstreamReason = error.upstreamReason
    if (error.contentRejected === true) out.contentRejected = true
    if (error.timing) out.timing = error.timing
    if (error.usage) out.usage = error.usage
    if (error.details) out.details = error.details
    return out
  }
  return null
}

function accountCapabilities(environment) {
  if (Array.isArray(environment.capabilities) && environment.capabilities.length) {
    return new Set(environment.capabilities.filter((cap) => typeof cap === 'string' && cap))
  }
  return new Set(environment.auth_method === 'api_key' ? FULL_GEMINI_CAPABILITIES : NATIVE_TUI_CAPABILITIES)
}

function quotaGroupKeyOfBucket(groupName = '', windowId = '') {
  const text = `${groupName} ${windowId}`.toLowerCase()
  if (/(claude|anthropic|3p|third|partner|openai|gpt)/.test(text)) return '3p'
  if (text.includes('argon')) return 'gemini-argon-wtu'
  if (text.includes('gemini')) return 'gemini'
  return null
}

function proactiveCooldownUntil(account, upstreamModel, quotaGroup, ts) {
  let until = 0
  const inferenceVerified = account?.last_inference?.state === 'completed'
  if (INELIGIBLE_STATES.has(account?.eligibility) && !inferenceVerified) {
    until = Math.max(until, ts + DEFAULT_ACCOUNT_COOLDOWN_MS)
  }
  const quotas = account?.quotas
  if (Array.isArray(quotas)) {
    for (const q of quotas) {
      if (q?.model !== upstreamModel) continue
      if (q.remaining_fraction === 0) {
        const parsed = q.reset_at ? Date.parse(q.reset_at) : NaN
        if (Number.isFinite(parsed) && parsed > ts) until = Math.max(until, parsed)
      }
    }
  }
  const groups = account?.quota_groups
  if (Array.isArray(groups)) {
    for (const g of groups) {
      const windows = Array.isArray(g?.windows) ? g.windows : []
      for (const w of windows) {
        const bucketGroup = quotaGroupKeyOfBucket(g?.name, w?.id)
        if (!bucketGroup) continue
        const matches = bucketGroup === quotaGroup || (quotaGroup === 'gemini-argon-wtu' && bucketGroup === 'gemini')
        if (!matches) continue
        if (w.remaining_fraction === 0) {
          const parsed = w.reset_at ? Date.parse(w.reset_at) : NaN
          if (Number.isFinite(parsed) && parsed > ts) until = Math.max(until, parsed)
        }
      }
    }
  }
  return until
}

async function readRun(callHost, id, runId, signal) {
  const deadline = Date.now() + TURN_MS
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    const result = await callHost('test-chat-status', { id, run_id: runId })
    if (result?.state === 'completed' || result?.state === 'failed') return result
    if (result?.state !== 'running') throw fail(502, 'gemini_host_protocol_error')
    await sleep(POLL_MS, undefined, { signal })
  }
  throw fail(504, 'gemini_inference_timeout')
}

async function consumeStreamResponse(
  response,
  {
    model,
    target = 'antigravity',
    restoreContext = null,
    onEvent,
    signal,
    onEarlyStop = null,
    startedAt = null,
    now = () => Date.now(),
  },
) {
  const decoder = createGeminiEventDecoder({ fallbackModel: model })
  const collector = createGeminiCollector({ fallbackModel: model })
  const timing = createStreamTiming(Number.isFinite(startedAt) ? startedAt : now())
  let streamError = null
  let sawChunk = false
  let earlyStopped = false
  const emit = (event) => {
    const at = now()
    if (event?.kind === 'start') {
      timing.observe({ type: 'message_start' }, at)
    } else if (
      event?.kind === 'text' ||
      event?.kind === 'thinking' ||
      event?.kind === 'tool_call' ||
      event?.kind === 'image'
    ) {
      timing.observe({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } }, at)
    } else if (event?.kind === 'stop') {
      timing.observe({ type: 'message_delta', delta: { stop_reason: event.stopReason || 'end_turn' } }, at)
    }
    collector.push(event)
    if (event.kind === 'error' && !streamError) streamError = event
    onEvent?.(event)
  }
  const restore = createGeminiRestoreTransform(restoreContext, {
    target,
    model,
    onEarlyStop: () => {
      if (earlyStopped) return
      earlyStopped = true
      onEarlyStop?.()
      try {
        response.destroy()
      } catch {}
    },
  })
  const splitter = createSseFrameSplitter((frame) => {
    if (earlyStopped) return
    decoder.decodeSseFrame(frame, (ev) => {
      if (!earlyStopped) restore.push(ev, emit)
    })
  })
  const onAbort = () => {
    try {
      response.destroy()
    } catch {}
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    for await (const chunk of response) {
      if (earlyStopped) break
      signal?.throwIfAborted()
      if (!sawChunk) {
        sawChunk = true
        timing.observe({ type: 'message_start' }, now())
      }
      splitter.push(chunk)
      if (earlyStopped) break
    }
    if (!earlyStopped) {
      signal?.throwIfAborted()
      splitter.flush()
      decoder.flush?.((ev) => {
        if (!earlyStopped) restore.push(ev, emit)
      })
      restore.flush(emit)
    }
  } catch (err) {
    if (!earlyStopped) throw err
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  const result = collector.result()
  if (streamError) {
    const code = Object.hasOwn(FAILURES, streamError.code)
      ? streamError.code
      : streamError.status === 429
        ? 'gemini_quota_exhausted'
        : streamError.status === 401
          ? 'gemini_oauth_required'
          : streamError.status === 403
            ? 'gemini_location_unsupported'
            : streamError.status === 404
              ? 'gemini_model_unavailable'
              : streamError.status === 400
                ? 'gemini_invalid_request'
                : 'gemini_inference_failed'
    const err = fail(streamError.status || FAILURES[code][0], code, streamError.message)
    if (Number.isInteger(streamError.status)) err.upstreamStatus = streamError.status
    err.timing = timing.snapshot()
    err.usage = result.usage
    throw err
  }
  if (!result.sawFinish && !result.text && !result.toolCalls.length && !result.images.length) {
    const err = fail(502, 'gemini_inference_invalid_output')
    err.timing = timing.snapshot()
    err.usage = result.usage
    throw err
  }
  const requiredChoice = typeof restoreContext?.toolChoice === 'string' ? restoreContext.toolChoice : ''
  const requiresToolCall =
    (requiredChoice === 'required' || requiredChoice.startsWith('name:')) && (restoreContext?.toolMap?.size ?? 0) > 0
  if (
    requiresToolCall &&
    result.toolCalls.length === 0 &&
    (result.stopReason === 'stop' || (!result.sawFinish && result.text))
  ) {
    const message = requiredChoice.startsWith('name:')
      ? `Upstream completed without calling required function "${requiredChoice.slice(5)}".`
      : FAILURES.gemini_tool_call_required[1]
    const err = fail(502, 'gemini_tool_call_required', message)
    err.timing = timing.snapshot()
    err.usage = result.usage
    throw err
  }
  if (!result.sawFinish) {
    timing.observe({ type: 'message_stop' }, now())
  }
  return { ...result, timing: timing.snapshot() }
}

async function readErrorPayload(response) {
  const chunks = []
  let total = 0
  for await (const chunk of response) {
    total += chunk.length
    if (total > 64 * 1024) break
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

export function createGeminiScheduler({
  callHost,
  callHostStream,
  resolveProxy,
  poolScheduler,
  stickyRouter = null,
  apiKeyStore,
  groupsRepo,
  geminiOwnersRepo = null,
  getEnvOwner = null,
  slotPrefs = null,
  cragSubscription = null,
  getRoutingConfig = null,
  attemptsRepo = null,
  getAttemptsRepo = null,
  quotaCooldownMs = null,
  accountCooldownMs = null,
  rateLimitRetryDelayMs = 250,
  listCacheTtlMs = callHost === callGeminiHost ? 2000 : 0,
  directClient = undefined,
  now = () => Date.now(),
}) {
  const resolveAttemptsRepo = () => (typeof getAttemptsRepo === 'function' ? getAttemptsRepo() : attemptsRepo) || null
  const envOwnerOf = (envId) => {
    if (typeof getEnvOwner === 'function') return getEnvOwner(envId) ?? null
    if (geminiOwnersRepo?.getOwner) return geminiOwnersRepo.getOwner(envId) ?? null
    return null
  }
  const streamHost = callHostStream ?? (callHost === callGeminiHost ? callGeminiHostStream : null)
  const effectiveDirectClient =
    directClient !== undefined
      ? directClient
      : callHost === callGeminiHost && streamHost === callGeminiHostStream
        ? createDirectCragClient({ callHost, now })
        : null
  const effectiveListCacheTtlMs = Number.isFinite(listCacheTtlMs) && listCacheTtlMs > 0 ? Math.floor(listCacheTtlMs) : 0
  let hostListCache = null
  let hostListInFlight = null
  const groupCooldowns = new Map()
  const modelCooldowns = new Map()
  const accountCooldowns = new Map()
  const stickyBindings = new Map()
  const toolContinuationBindings = new Map()
  const localInflight = new Map()
  let rrCursor = 0

  function invalidateCatalogCache() {
    hostListCache = null
    effectiveDirectClient?.invalidate?.()
  }

  async function fetchHostList({ force = false } = {}) {
    if (!force && effectiveListCacheTtlMs > 0 && hostListCache) {
      if (now() - hostListCache.fetchedAt < effectiveListCacheTtlMs) {
        return hostListCache.view
      }
    }
    if (!force && hostListInFlight) {
      return hostListInFlight
    }
    const pending = Promise.resolve()
      .then(() => callHost('list', {}))
      .then((view) => {
        if (effectiveListCacheTtlMs > 0 && Array.isArray(view?.environments)) {
          hostListCache = { view, fetchedAt: now() }
        }
        return view
      })
      .finally(() => {
        if (hostListInFlight === pending) hostListInFlight = null
      })
    if (!force) hostListInFlight = pending
    return pending
  }

  function resolveToolContinuation(callIds, ts) {
    if (!Array.isArray(callIds) || !callIds.length) return null
    for (let i = callIds.length - 1; i >= 0; i -= 1) {
      const cid = callIds[i]
      if (typeof cid !== 'string' || !cid) continue
      const entry = toolContinuationBindings.get(cid)
      if (!entry) continue
      if (entry.expiresAt <= ts) {
        toolContinuationBindings.delete(cid)
        continue
      }
      return entry
    }
    return null
  }

  function clearToolContinuation(callIds) {
    if (!Array.isArray(callIds)) return
    for (const cid of callIds) {
      if (typeof cid === 'string' && cid) toolContinuationBindings.delete(cid)
    }
  }

  function recordToolContinuation(
    accountId,
    collected,
    ts,
    consumedCallIds = [],
    stickyKey = null,
    parentRequestId = null,
  ) {
    if (Array.isArray(consumedCallIds)) {
      for (const cid of consumedCallIds) {
        if (typeof cid === 'string' && cid) toolContinuationBindings.delete(cid)
      }
    }
    const meta = collected?.meta
    if (
      !meta?.awaitingToolResults ||
      !meta.conversationId ||
      !CONV_ID.test(meta.conversationId) ||
      !Array.isArray(collected?.toolCalls) ||
      !collected.toolCalls.length
    ) {
      return
    }
    if (toolContinuationBindings.size >= TOOL_CONTINUATION_MAX) {
      for (const [k, v] of toolContinuationBindings.entries()) {
        if (v.expiresAt <= ts) toolContinuationBindings.delete(k)
      }
      if (toolContinuationBindings.size >= TOOL_CONTINUATION_MAX) toolContinuationBindings.clear()
    }
    const entry = {
      accountId,
      conversationId: meta.conversationId,
      stickyKey,
      parentRequestId: parentRequestId || null,
      expiresAt: ts + TOOL_CONTINUATION_TTL_MS,
    }
    for (const tc of collected.toolCalls) {
      if (typeof tc?.id === 'string' && tc.id) toolContinuationBindings.set(tc.id, entry)
      if (typeof tc?.signedId === 'string' && tc.signedId && tc.signedId !== tc.id) {
        toolContinuationBindings.set(tc.signedId, entry)
      }
    }
  }

  function currentPolicy() {
    const raw = typeof getRoutingConfig === 'function' ? getRoutingConfig()?.gemini : null
    return raw ? normalizeGeminiRouting(raw) : DEFAULT_GEMINI_ROUTING
  }

  function resolveStickyBinding(stickyKey, ts) {
    if (!stickyKey) return null
    const mem = stickyBindings.get(stickyKey)
    if (mem) {
      if (mem.expiresAt <= ts) {
        stickyBindings.delete(stickyKey)
      } else {
        return mem
      }
    }
    // Reuse Codex/Anthropic SQLite StickyRouter when available so sticky affinity
    // survives restarts and stays consistent across control-plane pools.
    if (stickyRouter?.resolve) {
      try {
        const persisted = stickyRouter.resolve(stickyKey, { platform: 'gemini' })
        if (persisted?.accountId) {
          const outboundConversationId =
            typeof persisted.sessionId === 'string' && CONV_ID.test(persisted.sessionId) ? persisted.sessionId : null
          return {
            accountId: persisted.accountId,
            outboundConversationId,
            usedConversationIds: new Set(outboundConversationId ? [outboundConversationId] : []),
            touchedAt: ts,
            expiresAt: ts + (currentPolicy().sticky.ttl_seconds || 3600) * 1000,
          }
        }
      } catch {}
    }
    return null
  }

  function releaseStickyAccount(stickyKey, expectedAccountId = null) {
    if (!stickyKey) return false
    let released = false
    const mem = stickyBindings.get(stickyKey)
    if (mem && (!expectedAccountId || mem.accountId === expectedAccountId)) {
      stickyBindings.delete(stickyKey)
      released = true
    }
    if (stickyRouter?.unbind) {
      try {
        if (!expectedAccountId) {
          stickyRouter.unbind(stickyKey, { platform: 'gemini' })
          released = true
        } else {
          const bound = stickyRouter.resolve?.(stickyKey, { platform: 'gemini' })
          if (!bound || bound.accountId === expectedAccountId) {
            stickyRouter.unbind(stickyKey, { platform: 'gemini' })
            released = true
          }
        }
      } catch {}
    }
    return released
  }

  function recordStickyAccount(stickyKey, accountId, outboundConversationId, policy, ts, extraUsedIds = null) {
    if (!stickyKey || !policy.sticky.enabled || !policy.sticky.ttl_seconds) return
    const prev = stickyBindings.get(stickyKey)
    const maxSessions = Number.isSafeInteger(policy.pool?.max_sessions_per_account)
      ? policy.pool.max_sessions_per_account
      : DEFAULT_MAX_SESSIONS
    if (maxSessions > 0) {
      let oldestKey = null
      let oldestAt = Infinity
      let countForAccount = 0
      for (const [k, v] of stickyBindings.entries()) {
        if (v.expiresAt <= ts) {
          stickyBindings.delete(k)
          continue
        }
        if (k !== stickyKey && v.accountId === accountId) {
          countForAccount += 1
          if (v.touchedAt < oldestAt) {
            oldestAt = v.touchedAt
            oldestKey = k
          }
        }
      }
      if (countForAccount >= maxSessions && oldestKey) {
        stickyBindings.delete(oldestKey)
      }
    }
    if (stickyBindings.size >= 4096) {
      for (const [k, v] of stickyBindings.entries()) {
        if (v.expiresAt <= ts) stickyBindings.delete(k)
      }
      if (stickyBindings.size >= 4096) stickyBindings.clear()
    }
    const usedConversationIds = new Set(prev?.usedConversationIds || [])
    if (extraUsedIds) {
      for (const cid of extraUsedIds) {
        if (typeof cid === 'string' && CONV_ID.test(cid)) usedConversationIds.add(cid)
      }
    }
    if (typeof outboundConversationId === 'string' && CONV_ID.test(outboundConversationId)) {
      usedConversationIds.add(outboundConversationId)
    }
    while (usedConversationIds.size > MAX_TRACKED_CONVERSATION_IDS) {
      const oldest = usedConversationIds.values().next().value
      usedConversationIds.delete(oldest)
    }
    const resolvedOutboundConvId =
      typeof outboundConversationId === 'string' && CONV_ID.test(outboundConversationId)
        ? outboundConversationId
        : prev?.accountId === accountId
          ? prev.outboundConversationId || null
          : null
    stickyBindings.set(stickyKey, {
      accountId,
      outboundConversationId: resolvedOutboundConvId,
      usedConversationIds,
      touchedAt: ts,
      expiresAt: ts + policy.sticky.ttl_seconds * 1000,
    })
    if (stickyRouter?.bind) {
      try {
        stickyRouter.bind(
          stickyKey,
          {
            accountId,
            vmId: `gemini:${accountId}`,
            sessionId: resolvedOutboundConvId || '',
          },
          { platform: 'gemini', ttlSeconds: policy.sticky.ttl_seconds },
        )
      } catch {}
    }
  }

  function pickCandidateWithPolicy(candidates, excluded, { strategy, stickyAccountId }) {
    const inflightOf = (id) => (poolScheduler ? poolScheduler.inflight?.get?.(id) || 0 : localInflight.get(id) || 0)
    const reserve = (list) =>
      poolScheduler
        ? poolScheduler.reserveExternalCandidates(list, { excluded })
        : (() => {
            const found = list.find(
              (c) => !excluded.has(c.accountId) && inflightOf(c.accountId) < Math.max(1, c.maxConcurrency),
            )
            if (!found) return null
            localInflight.set(found.accountId, inflightOf(found.accountId) + 1)
            let released = false
            return {
              selected: found,
              reservation: {
                release() {
                  if (released) return
                  released = true
                  const next = Math.max(0, (localInflight.get(found.accountId) || 1) - 1)
                  if (next === 0) localInflight.delete(found.accountId)
                  else localInflight.set(found.accountId, next)
                },
              },
            }
          })()

    const available = candidates.filter((c) => !excluded.has(c.accountId))
    if (!available.length) return null

    if (stickyAccountId) {
      const hit = available.find((c) => c.accountId === `gemini:${stickyAccountId}`)
      if (hit) {
        const stickyGrant = reserve([hit])
        if (stickyGrant?.selected) return stickyGrant
      }
    }

    if (strategy === 'round_robin') {
      const start = rrCursor++ % available.length
      for (let offset = 0; offset < available.length; offset += 1) {
        const candidate = available[(start + offset) % available.length]
        const grant = reserve([candidate])
        if (grant?.selected) return grant
      }
      return null
    }

    if (strategy === 'fill') {
      const ordered = [...available].sort((a, b) => {
        const loadA = inflightOf(a.accountId) / Math.max(1, a.maxConcurrency)
        const loadB = inflightOf(b.accountId) / Math.max(1, b.maxConcurrency)
        const satA = loadA >= 1 ? 1 : 0
        const satB = loadB >= 1 ? 1 : 0
        if (satA !== satB) return satA - satB
        if (satA === 0 && loadB !== loadA) return loadB - loadA
        if (a.priority !== b.priority) return b.priority - a.priority
        return a.accountId.localeCompare(b.accountId)
      })
      for (const candidate of ordered) {
        const grant = reserve([candidate])
        if (grant?.selected) return grant
      }
      return null
    }

    const balancedOrdered = [...available].sort((a, b) => {
      const loadA = inflightOf(a.accountId) / Math.max(1, a.maxConcurrency)
      const loadB = inflightOf(b.accountId) / Math.max(1, b.maxConcurrency)
      if (loadA !== loadB) return loadA - loadB
      if (a.priority !== b.priority) return b.priority - a.priority
      return a.accountId.localeCompare(b.accountId)
    })
    return reserve(balancedOrdered)
  }

  function activeCooldownState(account, upstreamModel, quotaGroup, ts) {
    const proactiveUntil = proactiveCooldownUntil(account, upstreamModel, quotaGroup, ts)
    let accountUntil = 0
    const accUntil = accountCooldowns.get(account.id) || 0
    if (accUntil > ts) accountUntil = accUntil
    else if (accUntil) accountCooldowns.delete(account.id)

    let reactiveQuotaUntil = 0
    const grpKey = `${account.id}:${quotaGroup}`
    const grpUntil = groupCooldowns.get(grpKey) || 0
    if (grpUntil > ts) reactiveQuotaUntil = Math.max(reactiveQuotaUntil, grpUntil)
    else if (grpUntil) groupCooldowns.delete(grpKey)

    const mdlKey = `${account.id}:${upstreamModel}`
    const mdlUntil = modelCooldowns.get(mdlKey) || 0
    if (mdlUntil > ts) reactiveQuotaUntil = Math.max(reactiveQuotaUntil, mdlUntil)
    else if (mdlUntil) modelCooldowns.delete(mdlKey)

    const hardUntil = Math.max(proactiveUntil, accountUntil)
    const cooldownUntil = Math.max(hardUntil, reactiveQuotaUntil)
    return { cooldownUntil, hardUntil, reactiveQuotaUntil }
  }

  function recordFailureCooldown(accountId, upstreamModel, quotaGroup, failure, ts) {
    const code = failure?.code
    if (code === 'gemini_content_rejected' || failure?.contentRejected === true) {
      // Prompt content rejection (reasonless 429) is request-scoped, not account exhaustion.
      return 0
    }
    const policy = currentPolicy()
    const effectiveQuotaCooldown = quotaCooldownMs ?? policy.failover.quota_cooldown_ms ?? DEFAULT_QUOTA_COOLDOWN_MS
    const effectiveAccountCooldown =
      accountCooldownMs ?? policy.failover.account_cooldown_ms ?? DEFAULT_ACCOUNT_COOLDOWN_MS
    if (code === 'gemini_quota_exhausted') {
      const retryMs =
        Number.isFinite(failure?.retryAfterMs) && failure.retryAfterMs > 0
          ? failure.retryAfterMs
          : effectiveQuotaCooldown
      const until = ts + retryMs
      // Scope generic/capacity reactive 429 cooldown to the specific upstream model so a
      // single model's RPM/capacity 429 does not poison healthy sibling models. When upstream
      // explicitly reports QUOTA_EXHAUSTED / INSUFFICIENT_G1_CREDITS_BALANCE, also cool the
      // shared quota group so sibling models on the same exhausted bucket fail over cleanly.
      modelCooldowns.set(
        `${accountId}:${upstreamModel}`,
        Math.max(modelCooldowns.get(`${accountId}:${upstreamModel}`) || 0, until),
      )
      if (quotaGroup && GROUP_QUOTA_EXHAUSTED_REASONS.has(failure?.upstreamReason)) {
        groupCooldowns.set(
          `${accountId}:${quotaGroup}`,
          Math.max(groupCooldowns.get(`${accountId}:${quotaGroup}`) || 0, until),
        )
      }
      return until
    }
    if (code === 'gemini_upstream_unavailable') {
      // Transient 503: brief per-model cooldown to let another account take over immediately
      // without poisoning the account or tripping circuit/unschedulable loops.
      const retryMs =
        Number.isFinite(failure?.retryAfterMs) && failure.retryAfterMs > 0
          ? Math.min(failure.retryAfterMs, effectiveQuotaCooldown)
          : Math.min(10_000, effectiveQuotaCooldown)
      const until = ts + retryMs
      modelCooldowns.set(
        `${accountId}:${upstreamModel}`,
        Math.max(modelCooldowns.get(`${accountId}:${upstreamModel}`) || 0, until),
      )
      return until
    }
    if (ACCOUNT_WIDE_COOLDOWN_ERRORS.has(code)) {
      const until = ts + effectiveAccountCooldown
      accountCooldowns.set(accountId, Math.max(accountCooldowns.get(accountId) || 0, until))
      return until
    }
    return 0
  }

  function clearCooldownOnSuccess(accountId, upstreamModel, quotaGroup) {
    accountCooldowns.delete(accountId)
    groupCooldowns.delete(`${accountId}:${quotaGroup}`)
    modelCooldowns.delete(`${accountId}:${upstreamModel}`)
  }

  function checkEnvironmentLicense(environment, payloadMode) {
    if (environment.auth_method === 'api_key') return { ok: true, seat_required: false }
    if (cragSubscription?.checkAdmission) {
      return cragSubscription.checkAdmission(environment, { payloadMode })
    }
    if (payloadMode !== 'crag_subscription' && !environment.crag_license) {
      return { ok: true, seat_required: false }
    }
    if (environment.crag_license?.valid === true) {
      return { ok: true, seat_required: true }
    }
    const licCode = typeof environment.crag_license?.code === 'string' ? environment.crag_license.code : null
    if (licCode && Object.hasOwn(FAILURES, licCode)) {
      const [status, message] = FAILURES[licCode]
      return { ok: false, status, code: licCode, message }
    }
    return {
      ok: false,
      status: 403,
      code: 'license_required',
      message: FAILURES.license_required[1],
    }
  }

  function recordAccountUsage(apiKeyRecord, model, usage) {
    if (!apiKeyRecord || !apiKeyStore?.recordUsage) return
    const multiplier = groupsRepo?.rateMultiplier?.(apiKeyRecord.group_id ?? 1) ?? 1
    apiKeyStore.recordUsage(
      apiKeyRecord,
      {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        ...(usage.cache_read_tokens ? { cache_read_input_tokens: usage.cache_read_tokens } : {}),
        ...(usage.reasoning_tokens ? { reasoning_tokens: usage.reasoning_tokens } : {}),
      },
      { model, rateMultiplier: multiplier },
    )
  }

  return {
    cooldownSnapshot() {
      const ts = now()
      const active = (map) => Object.fromEntries([...map.entries()].filter(([, until]) => until > ts))
      return {
        groups: active(groupCooldowns),
        models: active(modelCooldowns),
        accounts: active(accountCooldowns),
      }
    },

    environmentRestriction(envId, ts = now()) {
      if (!envId) return { restriction: null, circuit: null }
      const rawCircuit = poolScheduler?.unitCircuit?.view?.(`gemini:${envId}`, ts) || null
      const circuit = rawCircuit && rawCircuit.state !== 'closed' ? rawCircuit : null

      let accountUntil = accountCooldowns.get(envId) || 0
      if (accountUntil <= ts) {
        if (accountUntil) accountCooldowns.delete(envId)
        accountUntil = 0
      }

      const prefix = `${envId}:`
      let groupUntil = 0
      for (const [key, until] of groupCooldowns.entries()) {
        if (!key.startsWith(prefix)) continue
        if (until > ts) groupUntil = Math.max(groupUntil, until)
        else groupCooldowns.delete(key)
      }

      let modelUntil = 0
      for (const [key, until] of modelCooldowns.entries()) {
        if (!key.startsWith(prefix)) continue
        if (until > ts) modelUntil = Math.max(modelUntil, until)
        else modelCooldowns.delete(key)
      }

      let restriction = null
      if (circuit?.state === 'open') {
        restriction = { reason: 'circuit_open', text: '熔断中', until: circuit.open_until ?? null }
      } else if (circuit?.state === 'half_open') {
        restriction = { reason: 'circuit_probe', text: '熔断探测', until: null }
      } else if (accountUntil > 0) {
        restriction = { reason: 'account_cooldown', text: '账号冷却中', until: accountUntil }
      } else if (groupUntil > 0) {
        restriction = { reason: 'quota_group_cooldown', text: '配额组冷却中', until: groupUntil }
      } else if (modelUntil > 0) {
        restriction = { reason: 'model_quota_cooldown', text: '模型冷却中', until: modelUntil }
      }
      return { restriction, circuit }
    },

    clearRestriction(envId) {
      if (!envId) return { cleared: false }
      accountCooldowns.delete(envId)
      const prefix = `${envId}:`
      for (const key of [...groupCooldowns.keys()]) {
        if (key.startsWith(prefix)) groupCooldowns.delete(key)
      }
      for (const key of [...modelCooldowns.keys()]) {
        if (key.startsWith(prefix)) modelCooldowns.delete(key)
      }
      poolScheduler?.unitCircuit?.reset?.(`gemini:${envId}`)
      slotPrefs?.clearUnschedulable?.(envId)
      invalidateCatalogCache()
      return { cleared: true }
    },

    /**
     * Replenish expired/recovered model & group cooldowns when periodic account status
     * checks report healthy quota remaining (> 0), modeled after Antigravity2API Pool.Replenish.
     */
    syncAccountQuotaState(envId, account) {
      if (!envId || !account || typeof account !== 'object') return { clearedModels: 0, clearedGroups: 0 }
      let clearedModels = 0
      let clearedGroups = 0
      const quotas = Array.isArray(account.quotas) ? account.quotas : []
      for (const q of quotas) {
        if (typeof q?.model === 'string' && Number.isFinite(q.remaining_fraction) && q.remaining_fraction > 0) {
          if (modelCooldowns.delete(`${envId}:${q.model}`)) clearedModels += 1
        }
      }
      const groups = Array.isArray(account.quota_groups) ? account.quota_groups : []
      for (const g of groups) {
        const name = typeof g?.name === 'string' ? g.name : ''
        const windows = Array.isArray(g?.windows) ? g.windows : []
        if (
          name &&
          windows.length > 0 &&
          windows.every(
            (w) => w?.remaining_fraction == null || (Number.isFinite(w.remaining_fraction) && w.remaining_fraction > 0),
          )
        ) {
          if (groupCooldowns.delete(`${envId}:${name}`)) clearedGroups += 1
        }
      }
      if (account.state === 'ok' && !account.eligibility) {
        accountCooldowns.delete(envId)
      }
      if (clearedModels > 0 || clearedGroups > 0) invalidateCatalogCache()
      return { clearedModels, clearedGroups }
    },

    invalidateCatalogCache,

    async catalog({ ownerScope = PLATFORM_SCOPE, allowedEnvIds = null, forceRefresh = false } = {}) {
      if (cragSubscription?.hasSyncPending?.()) {
        await cragSubscription.recover().catch(() => null)
        invalidateCatalogCache()
      }
      let view = await fetchHostList({ force: forceRefresh })
      if (!Array.isArray(view?.environments)) throw fail(502, 'gemini_host_protocol_error')
      if (view.payload_state !== 'installed') return { models: [], accounts: [] }
      const payloadMode = view.payload_mode === 'crag_subscription' ? 'crag_subscription' : 'legacy_release'
      if (payloadMode === 'crag_subscription' && cragSubscription?.reconcileEnvironmentSeats) {
        const needSeat = view.environments.filter(
          (environment) =>
            environment?.auth_state === 'authorized' &&
            environment.oauth_imported !== true &&
            environment.auth_method !== 'api_key' &&
            !view.oauth_runtime_issue &&
            typeof environment.id === 'string' &&
            ID.test(environment.id) &&
            environment.models_discovered === true &&
            Array.isArray(environment.models) &&
            environment.models.length > 0 &&
            environment.crag_license?.valid !== true &&
            (!environment.crag_license?.code || RECOVERABLE_GEMINI_SEAT_CODES.has(environment.crag_license.code)),
        )
        if (needSeat.length) {
          const reconciled = await cragSubscription
            .reconcileEnvironmentSeats(needSeat, { payloadMode })
            .catch(() => ({ boundIds: [] }))
          if (reconciled.boundIds?.length) {
            invalidateCatalogCache()
            view = await fetchHostList({ force: true })
            if (!Array.isArray(view?.environments)) throw fail(502, 'gemini_host_protocol_error')
            if (view.payload_state !== 'installed') return { models: [], accounts: [] }
          }
        }
      }
      const accounts = []
      const unlicensedAccounts = []
      for (const environment of view.environments) {
        if (
          environment?.auth_state !== 'authorized' ||
          environment.oauth_imported === true ||
          (environment.auth_method === 'oauth' && view.oauth_runtime_issue) ||
          typeof environment.id !== 'string' ||
          !ID.test(environment.id) ||
          typeof environment.proxy_id !== 'string' ||
          !ID.test(environment.proxy_id) ||
          environment.models_discovered !== true ||
          !Array.isArray(environment.models)
        )
          continue
        const envOwner = envOwnerOf(environment.id)
        if (!geminiEnvMatchesOwnerScope(envOwner, ownerScope)) continue
        if (Array.isArray(allowedEnvIds) && !allowedEnvIds.includes(environment.id)) continue
        const pref = slotPrefs?.resolved?.(environment.id) ?? null
        if (pref && (pref.schedulable === false || pref.unschedulable != null)) continue
        if (resolveProxy) {
          try {
            resolveProxy(environment.proxy_id, envOwner)
          } catch (error) {
            if (error?.code === 'gemini_proxy_unavailable') continue
            throw error
          }
        }
        const models = []
        for (const model of environment.models || []) {
          if (typeof model === 'string' && MODEL.test(model)) models.push(model)
        }
        if (models.length) {
          const authMethod = environment.auth_method === 'api_key' ? 'api_key' : 'oauth'
          const catalogIndex = indexAccountModelCatalog(environment.account)
          const admission = checkEnvironmentLicense({ ...environment, auth_method: authMethod }, payloadMode)
          if (!admission.ok) {
            unlicensedAccounts.push({
              id: environment.id,
              auth_method: authMethod,
              models,
              catalogIndex,
              denial: admission,
            })
            continue
          }
          accounts.push({
            id: environment.id,
            proxy_id: environment.proxy_id,
            auth_method: authMethod,
            schedule_level: pref?.schedule_level ?? 5,
            max_concurrency: normalizeConcurrency(
              environment.max_concurrency,
              currentPolicy().pool.max_concurrency_per_account,
            ),
            capabilities: accountCapabilities(environment),
            models,
            catalogIndex,
            eligibility: environment.account?.eligibility || null,
            last_inference: environment.last_inference || null,
            quotas: Array.isArray(environment.account?.quotas) ? environment.account.quotas : [],
            quota_groups: Array.isArray(environment.account?.quota_groups) ? environment.account.quota_groups : [],
          })
        }
      }
      const publicModels = new Map()
      for (const account of accounts) {
        for (const rawId of account.models) {
          const hint = account.catalogIndex?.get(rawId) || null
          const classified = classifyAntigravityModel(rawId, hint?.provider, hint?.quota_group)
          if (classified.provider === 'google' && !isGeminiModelEnabled(classified.public_id)) continue
          if (!publicModels.has(classified.public_id)) {
            publicModels.set(classified.public_id, {
              id: classified.public_id,
              object: 'model',
              owned_by: classified.owned_by,
            })
          }
        }
      }
      return {
        models: [...publicModels.values()],
        accounts,
        unlicensedAccounts,
      }
    },

    async stream({
      model,
      requestedEffort = null,
      geminiBody,
      targetBodyFor = null,
      restoreContext = null,
      continuationCallIds = [],
      inboundConversationId = null,
      requiredCapabilities = [],
      unsupportedFields = [],
      plainText = null,
      requestId = `gem_${crypto.randomBytes(12).toString('hex')}`,
      startedAt = null,
      stickyKey = null,
      signal,
      apiKeyRecord,
      allowUnprefixedNonGemini = null,
      ownerScope = PLATFORM_SCOPE,
      allowedEnvIds = null,
      catalogSnapshot = null,
      onEvent = null,
    }) {
      const turnStartedAt = Number.isFinite(startedAt) ? startedAt : now()
      const gate = apiKeyStore?.acquire?.(apiKeyRecord)
      if (gate && !gate.ok) {
        const err = fail(gate.status || 429, gate.code, gate.message)
        const details = apiKeyGateDetails(gate)
        if (details) err.details = details
        if (gate.retry_after != null) err.retryAfter = gate.retry_after
        throw err
      }
      const allowUnprefixed = allowUnprefixedNonGemini ?? apiKeyRecord?.group_type !== 'all'
      const excluded = new Set()
      const rateLimitRetried = new Set()
      let preferredRetryAccountId = null
      let sessionConflictRetried = false
      let pendingRestartResume = null
      let accountSwitches = 0
      let reservation = null
      let selected = null
      let legacyRun = null
      let activeInfer = null
      let attempts = 0
      let lastUpstreamStatus = null
      let lastAccountId = null
      let lastAuthMethod = null
      let lastUpstreamModel = null
      let lastConversationId = null
      let lastTiming = null
      let lastUsage = null
      const attemptRecords = []
      const attemptsRepoRef = resolveAttemptsRepo()
      const attachAttemptMeta = (err) => {
        if (!err || typeof err !== 'object') return err
        if (err.attemptCount == null) err.attemptCount = attempts
        if (err.upstreamStatus == null && lastUpstreamStatus != null) {
          err.upstreamStatus = lastUpstreamStatus
        }
        if (err.accountId == null && lastAccountId) err.accountId = lastAccountId
        if (err.authMethod == null && lastAuthMethod) err.authMethod = lastAuthMethod
        if (err.upstreamModel == null && lastUpstreamModel) err.upstreamModel = lastUpstreamModel
        if (err.conversationId == null && lastConversationId) err.conversationId = lastConversationId
        if (err.timing == null && lastTiming) err.timing = lastTiming
        if (err.usage == null && lastUsage) err.usage = lastUsage
        if (err.attempts == null && attemptRecords.length) err.attempts = attemptRecords
        return err
      }

      try {
        signal?.throwIfAborted()
        if (isGeminiSeriesId(model) && !isGeminiModelEnabled(model)) {
          throw fail(404, 'gemini_model_unavailable', `Gemini model '${model}' is disabled by model policy.`)
        }
        const defaultEffort = isGeminiSeriesId(model) ? resolveGeminiDefaultEffort(model) : null
        const catalog =
          catalogSnapshot && Array.isArray(catalogSnapshot.accounts)
            ? catalogSnapshot
            : await this.catalog({ ownerScope, allowedEnvIds })
        const matchedAccounts = []
        for (const account of catalog.accounts) {
          const resolved = resolveUpstreamModel(model, account.models, {
            allowUnprefixedNonGemini: allowUnprefixed,
            catalogIndex: account.catalogIndex,
            requestedEffort,
            defaultEffort,
          })
          if (resolved) matchedAccounts.push({ account, resolved })
        }
        if (!matchedAccounts.length) {
          const unlicensedMatch = (catalog.unlicensedAccounts || []).find((account) =>
            Boolean(
              resolveUpstreamModel(model, account.models, {
                allowUnprefixedNonGemini: allowUnprefixed,
                catalogIndex: account.catalogIndex,
                requestedEffort,
                defaultEffort,
              }),
            ),
          )
          if (unlicensedMatch) {
            throw fail(
              unlicensedMatch.denial.status || 403,
              unlicensedMatch.denial.code || 'license_required',
              unlicensedMatch.denial.message,
            )
          }
          if (!catalog.accounts.length) {
            const overloaded = fail(429, 'gemini_pool_overloaded', '号池负载过高，请稍后再试')
            overloaded.retryAfter = 5
            throw overloaded
          }
          throw fail(404, 'gemini_model_unavailable')
        }
        const canTransformForNative = Boolean(streamHost && targetBodyFor)
        const capableAccounts = matchedAccounts.filter(({ account }) =>
          requiredCapabilities.every(
            (cap) =>
              account.capabilities.has(cap) ||
              (cap === 'full_gemini_api' && canTransformForNative && account.capabilities.has('multi_turn')),
          ),
        )
        if (!capableAccounts.length) {
          throw fail(
            400,
            'gemini_unsupported_turn',
            'No authorized Gemini environment for this model supports the requested capabilities.',
          )
        }

        const ts = now()
        const policy = currentPolicy()
        const continuationBinding = resolveToolContinuation(continuationCallIds, ts)
        const effectiveStickyKey = stickyKey || continuationBinding?.stickyKey || null
        const prevStickyBinding = resolveStickyBinding(effectiveStickyKey, ts)
        const stickyAccountId =
          continuationBinding?.accountId || (policy.sticky.enabled ? prevStickyBinding?.accountId || null : null)
        const attemptUsedConversationIds = new Set(prevStickyBinding?.usedConversationIds || [])
        if (prevStickyBinding?.outboundConversationId) {
          attemptUsedConversationIds.add(prevStickyBinding.outboundConversationId)
        }
        if (continuationBinding?.conversationId) {
          attemptUsedConversationIds.add(continuationBinding.conversationId)
        }
        if (typeof inboundConversationId === 'string' && inboundConversationId) {
          attemptUsedConversationIds.add(inboundConversationId)
        }
        if (typeof geminiBody?.conversation_id === 'string' && geminiBody.conversation_id) {
          attemptUsedConversationIds.add(geminiBody.conversation_id)
        }
        const maxAccountSwitches =
          typeof getRoutingConfig === 'function'
            ? Math.max(0, policy.failover.max_account_switches ?? 3)
            : Math.max(0, capableAccounts.length - 1)
        const maxAttempts = Math.max(1, (maxAccountSwitches + 1) * 2)
        const scored = capableAccounts.map(({ account, resolved }) => {
          const cd = activeCooldownState(account, resolved.upstreamModel, resolved.quotaGroup, ts)
          const effectiveMaxConc = normalizeConcurrency(
            account.max_concurrency,
            policy.pool.max_concurrency_per_account,
          )
          return {
            account,
            resolved,
            cooldownUntil: cd.cooldownUntil,
            hardUntil: cd.hardUntil,
            reactiveQuotaUntil: cd.reactiveQuotaUntil,
            candidate: {
              accountId: `gemini:${account.id}`,
              vmId: `gemini:${account.id}`,
              model: resolved.publicId,
              upstreamModel: resolved.upstreamModel,
              quotaGroup: resolved.quotaGroup,
              provider: resolved.provider,
              authMethod: account.auth_method,
              maxConcurrency: effectiveMaxConc,
              priority:
                (Number.isSafeInteger(account.schedule_level) ? account.schedule_level : 5) * 10 +
                (account.auth_method === 'api_key' && requiredCapabilities.length ? 1 : 0),
              weight: 1,
              lastUsedAt: 0,
            },
          }
        })
        const uncooled = scored.filter((item) => item.cooldownUntil === 0)
        const reactiveQuotaCooled = scored
          .filter((item) => item.hardUntil === 0 && item.reactiveQuotaUntil > 0)
          .sort((a, b) => a.reactiveQuotaUntil - b.reactiveQuotaUntil)
        const hardCooled = scored.filter((item) => item.hardUntil > 0).sort((a, b) => a.cooldownUntil - b.cooldownUntil)
        // If every capable account is hard-cooled (0% quota / account-wide cooldown / ineligible),
        // fail immediately with 429 High Load instead of hammering unschedulable accounts.
        if (!uncooled.length && !reactiveQuotaCooled.length && hardCooled.length) {
          const earliestUntil = hardCooled[0].cooldownUntil
          const overloaded = fail(429, 'gemini_pool_overloaded', '号池负载过高，请稍后再试')
          overloaded.retryAfter = Math.max(1, Math.ceil((earliestUntil - ts) / 1000))
          throw overloaded
        }
        // Tier 1: uncooled accounts (always tried first with policy strategy + sticky affinity).
        // Tier 2: reactive short-cooldown (429) accounts ordered by earliest expiry, used ONLY
        // when all Tier 1 accounts fail.
        const primaryItems = uncooled.length ? uncooled : reactiveQuotaCooled
        const fallbackItems = uncooled.length ? reactiveQuotaCooled : []
        const allItems = [...primaryItems, ...fallbackItems]
        const primaryCandidates = primaryItems.map((item) => item.candidate)
        const fallbackCandidates = fallbackItems.map((item) => item.candidate)
        const totalCandidates = allItems.length
        const resolvedByAccountId = new Map(allItems.map((item) => [item.candidate.accountId, item.resolved]))
        const accountByAccountId = new Map(allItems.map((item) => [item.candidate.accountId, item.account]))

        let lastError = null
        while (excluded.size < totalCandidates && attempts < maxAttempts) {
          signal?.throwIfAborted()
          let fromFallback = false
          let grant = null
          if (preferredRetryAccountId && !excluded.has(preferredRetryAccountId)) {
            const retryCand = allItems.find((item) => item.candidate.accountId === preferredRetryAccountId)?.candidate
            preferredRetryAccountId = null
            if (retryCand) {
              grant = pickCandidateWithPolicy([retryCand], excluded, {
                strategy: 'balanced',
                stickyAccountId: null,
              })
            }
          }
          if (!grant?.selected && uncooled.length) {
            grant = pickCandidateWithPolicy(primaryCandidates, excluded, {
              strategy: policy.pool.strategy,
              stickyAccountId,
            })
          } else if (!grant?.selected) {
            // Preserve earliest-expiry order across cooled candidates instead of letting
            // balanced/lastUsed sorting lock every probe onto the same account sequence.
            for (const candidate of primaryCandidates) {
              if (excluded.has(candidate.accountId)) continue
              const probeGrant = pickCandidateWithPolicy([candidate], excluded, {
                strategy: 'balanced',
                stickyAccountId: null,
              })
              if (probeGrant?.selected) {
                grant = probeGrant
                break
              }
            }
          }
          if (!grant?.selected && fallbackCandidates.length) {
            for (const candidate of fallbackCandidates) {
              if (excluded.has(candidate.accountId)) continue
              const fb = pickCandidateWithPolicy([candidate], excluded, {
                strategy: 'balanced',
                stickyAccountId: null,
              })
              if (fb?.selected) {
                grant = fb
                fromFallback = true
                break
              }
            }
          }
          if (!grant?.selected) break
          attempts += 1
          const attemptStartedAt = now()
          reservation = grant.reservation
          const id = grant.selected.accountId.slice('gemini:'.length)
          const resolved = resolvedByAccountId.get(grant.selected.accountId)
          selected = { ...grant.selected, id, resolved }
          poolScheduler?.lastUsed?.set?.(selected.accountId, attemptStartedAt)
          lastAccountId = id
          lastAuthMethod = selected.authMethod || 'oauth'
          lastUpstreamModel = resolved.upstreamModel
          lastUpstreamStatus = null
          let emittedOutput = false
          let attemptConversationId = null
          const selectionReason = fromFallback
            ? 'cooldown_fallback'
            : !uncooled.length
              ? 'all_cooled_probe'
              : stickyAccountId === id && attempts === 1
                ? 'sticky'
                : attempts > 1
                  ? 'failover'
                  : policy.pool.strategy || 'balanced'
          try {
            attemptsRepoRef?.begin?.({
              requestId,
              attemptNo: attempts,
              vmId: selected.vmId,
              accountId: selected.accountId,
              model: resolved.publicId,
              selectionReason,
            })
          } catch {}

          try {
            const envOwner = envOwnerOf(id)
            if (
              !geminiEnvMatchesOwnerScope(envOwner, ownerScope) ||
              (Array.isArray(allowedEnvIds) && !allowedEnvIds.includes(id))
            ) {
              throw fail(403, 'gemini_model_unavailable')
            }
            const cachedAccount = accountByAccountId.get(selected.accountId)
            let proxyId = cachedAccount?.proxy_id
            let authMethod = cachedAccount?.auth_method === 'api_key' ? 'api_key' : selected.authMethod || 'oauth'
            if (typeof proxyId !== 'string' || !ID.test(proxyId)) {
              const listed = await callHost('get', { id })
              proxyId = listed?.proxy_id
              if (listed?.auth_method === 'api_key') authMethod = 'api_key'
              else if (listed?.auth_method === 'oauth') authMethod = 'oauth'
            }
            if (typeof proxyId !== 'string' || !ID.test(proxyId)) throw fail(502, 'gemini_host_protocol_error')
            const proxyUrl = resolveProxy ? resolveProxy(proxyId, envOwner) : undefined
            signal?.throwIfAborted()
            lastAuthMethod = authMethod
            const target = authMethod === 'api_key' ? 'gemini' : 'antigravity'
            // Account-scoped outbound conversation_id policy for CRAGGemini:
            // - Reuse the active conversation_id ONLY when staying on the exact same account
            //   (same-account resume or suspended MCP tool continuation).
            // - On ANY account switch (failover, cooldown rotation, A->B->A return, or tool
            //   continuation failover), ALWAYS mint a brand-new conversation_id that never
            //   reuses any previous account's or caller's raw conversation_id.
            const isRestartResumeRetry = Boolean(
              pendingRestartResume && pendingRestartResume.accountId === selected.accountId,
            )
            const restartResumeConvId = isRestartResumeRetry ? pendingRestartResume.conversationId : null
            if (isRestartResumeRetry) pendingRestartResume = null

            let outboundConversationId = null
            let switchedAccount = false
            if (target === 'antigravity') {
              if (isRestartResumeRetry && CONV_ID.test(restartResumeConvId || '')) {
                outboundConversationId = restartResumeConvId
              } else if (
                continuationBinding &&
                !sessionConflictRetried &&
                continuationBinding.accountId === id &&
                CONV_ID.test(continuationBinding.conversationId)
              ) {
                outboundConversationId = continuationBinding.conversationId
              } else if (
                policy.sticky.enabled &&
                prevStickyBinding &&
                prevStickyBinding.accountId === id &&
                attempts === 1 &&
                CONV_ID.test(prevStickyBinding.outboundConversationId || '')
              ) {
                outboundConversationId = prevStickyBinding.outboundConversationId
              } else {
                outboundConversationId = mintOutboundConversationId(attemptUsedConversationIds)
                attemptUsedConversationIds.add(outboundConversationId)
                switchedAccount = Boolean(
                  (prevStickyBinding && prevStickyBinding.accountId !== id) ||
                    (continuationBinding && continuationBinding.accountId !== id) ||
                    attempts > 1,
                )
              }
            }
            attemptConversationId = outboundConversationId
            if (outboundConversationId) lastConversationId = outboundConversationId
            const rawOutboundBody = targetBodyFor
              ? targetBodyFor(target, {
                  upstreamModel: resolved.upstreamModel,
                  publicModel: resolved.publicId,
                  ...(outboundConversationId ? { conversationId: outboundConversationId } : {}),
                  switchedAccount,
                })
              : outboundConversationId && geminiBody && typeof geminiBody === 'object'
                ? { ...geminiBody, conversation_id: outboundConversationId }
                : geminiBody
            const outboundBody =
              rawOutboundBody && typeof rawOutboundBody === 'object' && 'model' in rawOutboundBody
                ? { ...rawOutboundBody, model: resolved.upstreamModel }
                : rawOutboundBody
            const attemptRequestId = attempts === 1 ? requestId : `${requestId}_a${attempts}`.slice(0, 128)

            let streamResponse = null
            if (streamHost) {
              const proxySha256 = proxyUrl ? crypto.createHash('sha256').update(proxyUrl).digest('hex') : undefined
              const gatewayPolicy =
                typeof getRoutingConfig === 'function'
                  ? {
                      queue_wait_ms: policy.pool.queue_timeout_ms,
                      first_byte_timeout_ms: policy.pool.first_byte_timeout_ms,
                      stream_idle_timeout_ms: policy.pool.idle_timeout_ms,
                    }
                  : undefined
              const turnTimeoutMs = Math.max(STREAM_TURN_MS, (policy.pool.timeout_ms || 120_000) + 15_000)
              if (target === 'antigravity' && effectiveDirectClient) {
                const directTarget = await effectiveDirectClient.resolveTarget({
                  id,
                  proxyId,
                  proxyUrl,
                  proxySha256,
                  model: resolved.upstreamModel,
                })
                if (directTarget) {
                  const directOutcome = await effectiveDirectClient.openDirectStream(directTarget, {
                    model: resolved.upstreamModel,
                    requestId: attemptRequestId,
                    bodyObj: outboundBody,
                    gatewayPolicy,
                    restartResume: isRestartResumeRetry,
                    signal,
                    timeoutMs: turnTimeoutMs,
                  })
                  if (directOutcome.ok) {
                    lastUpstreamStatus = 200
                    activeInfer = { id, request_id: attemptRequestId, directTarget }
                    streamResponse = directOutcome.res
                  } else if (!directOutcome.fallback) {
                    if (
                      typeof directOutcome.error?.code === 'string' &&
                      (directOutcome.error.code.startsWith('license_') ||
                        directOutcome.error.code === 'gemini_native_worker_unavailable')
                    ) {
                      effectiveDirectClient.invalidate(id)
                    }
                    if (Number.isInteger(directOutcome.error?.upstreamStatus)) {
                      lastUpstreamStatus = directOutcome.error.upstreamStatus
                    }
                    throw directOutcome.error
                  } else {
                    effectiveDirectClient.invalidate(id)
                  }
                }
              }
              if (!streamResponse) {
                const res = await streamHost(
                  'infer',
                  {
                    id,
                    proxy_id: proxyId,
                    proxy_url: proxyUrl,
                    ...(proxySha256 ? { proxy_sha256: proxySha256 } : {}),
                    model: resolved.upstreamModel,
                    request_id: attemptRequestId,
                    ...(gatewayPolicy ? { gateway_policy: gatewayPolicy } : {}),
                    ...(isRestartResumeRetry ? { restart_resume: true } : {}),
                    body: outboundBody,
                  },
                  { signal, timeoutMs: turnTimeoutMs },
                )
                if (Number.isInteger(res?.statusCode)) lastUpstreamStatus = res.statusCode
                const contentType = String(res.headers?.['content-type'] || '')
                  .split(';')[0]
                  .trim()
                  .toLowerCase()
                if (res.statusCode === 200 && contentType === 'text/event-stream') {
                  activeInfer = { id, request_id: attemptRequestId }
                  streamResponse = res
                } else {
                  const errBody = await readErrorPayload(res)
                  if (
                    res.statusCode === 404 &&
                    (!errBody?.code || errBody.code === 'not_found' || errBody.code === 'gemini_host_protocol_error') &&
                    plainText != null
                  ) {
                    // Backward compatibility with an older host without /infer.
                    const started = await callHost('test-chat', {
                      id,
                      proxy_id: proxyId,
                      proxy_url: proxyUrl,
                      model: resolved.upstreamModel,
                      prompt: plainText,
                    })
                    if (typeof started?.run_id !== 'string' || !RUN_ID.test(started.run_id)) {
                      throw fail(502, 'gemini_host_protocol_error')
                    }
                    legacyRun = { id, run_id: started.run_id }
                  } else {
                    const quotaMeta = parseUpstreamQuotaMeta(errBody)
                    const errCode = resolveInferFailureCode(errBody, res.statusCode)
                    const err = fail(
                      res.statusCode || FAILURES[errCode][0],
                      errCode,
                      errBody?.message || FAILURES[errCode][1],
                    )
                    if (Number.isInteger(res.statusCode)) err.upstreamStatus = res.statusCode
                    if (quotaMeta.upstreamReason) err.upstreamReason = quotaMeta.upstreamReason
                    if (quotaMeta.contentRejected || errCode === 'gemini_content_rejected') err.contentRejected = true
                    const retryAfterMs = parseRetryAfterMs(errBody, res.headers)
                    if (retryAfterMs != null) {
                      err.retryAfterMs = retryAfterMs
                      err.retryAfter = Math.ceil(retryAfterMs / 1000)
                    }
                    throw err
                  }
                }
              }
            } else {
              if (plainText == null) {
                // Name the fields, not just the verdict: this transport carries a
                // prompt string and nothing else, so the caller's only way forward
                // is to drop the offending field, and they cannot do that from
                // "unsupported turn" alone (#1703).
                const offending = unsupportedFields.join(', ')
                const detail = offending ? `; unsupported in this request: ${offending}` : ''
                throw fail(
                  400,
                  'gemini_unsupported_turn',
                  `This Gemini host transport only supports plain-text turns${detail}.`,
                )
              }
              const started = await callHost('test-chat', {
                id,
                proxy_id: proxyId,
                proxy_url: proxyUrl,
                model: resolved.upstreamModel,
                prompt: plainText,
              })
              if (typeof started?.run_id !== 'string' || !RUN_ID.test(started.run_id)) {
                throw fail(502, 'gemini_host_protocol_error')
              }
              legacyRun = { id, run_id: started.run_id }
            }

            let collected
            if (streamResponse) {
              collected = await consumeStreamResponse(streamResponse, {
                model: resolved.publicId,
                target,
                restoreContext,
                signal,
                startedAt: turnStartedAt,
                now,
                onEarlyStop: () => {
                  if (activeInfer) {
                    const ref = activeInfer
                    activeInfer = null
                    if (ref.directTarget && effectiveDirectClient) {
                      effectiveDirectClient.cancelDirectTurn(ref.directTarget, ref.request_id).catch(() => {})
                    } else {
                      callHost('infer-cancel', ref).catch(() => {})
                    }
                  }
                },
                onEvent: (event) => {
                  const committed = onEvent?.(event)
                  if (typeof committed === 'boolean') {
                    if (committed) emittedOutput = true
                  } else if (event && CONTENT_OUTPUT_EVENTS.has(event.kind)) {
                    emittedOutput = true
                  }
                },
              })
              activeInfer = null
            } else {
              const result = await readRun(callHost, legacyRun.id, legacyRun.run_id, signal)
              legacyRun = null
              if (result.state === 'failed') {
                const code = typeof result.error?.code === 'string' ? result.error.code : 'gemini_inference_failed'
                const mapped = Object.hasOwn(FAILURES, code) ? FAILURES[code] : null
                throw fail(mapped?.[0] || 502, mapped ? code : 'gemini_inference_failed')
              }
              if (typeof result.text !== 'string') throw fail(502, 'gemini_host_protocol_error')
              lastUpstreamStatus = 200
              const finishedAt = now()
              const usage = {}
              for (const key of [
                'input_tokens',
                'output_tokens',
                'cache_read_tokens',
                'reasoning_tokens',
                'total_tokens',
              ]) {
                const count =
                  key === 'reasoning_tokens'
                    ? (result.usage?.reasoning_tokens ?? result.usage?.thinking_tokens)
                    : result.usage?.[key]
                if (Number.isSafeInteger(count) && count >= 0) usage[key] = count
              }
              const collector = createGeminiCollector({ fallbackModel: resolved.publicId })
              const emit = (ev) => {
                if (ev && ev.kind !== 'error') emittedOutput = true
                collector.push(ev)
                onEvent?.(ev)
              }
              emit({
                kind: 'start',
                responseId: `resp_${crypto.randomBytes(10).toString('hex')}`,
                model: resolved.publicId,
                usage,
              })
              if (result.text) emit({ kind: 'text', text: result.text })
              emit({ kind: 'stop', finishReason: 'STOP', stopReason: 'stop' })
              emit({ kind: 'usage', usage })
              collected = {
                ...collector.result(),
                timing: {
                  firstByteAt: finishedAt,
                  firstByteMs: Math.max(0, finishedAt - turnStartedAt),
                  firstTokenAt: finishedAt,
                  ttftMs: Math.max(0, finishedAt - turnStartedAt),
                  generationMs: null,
                },
              }
            }

            clearCooldownOnSuccess(id, resolved.upstreamModel, resolved.quotaGroup)
            const reportedConvId =
              target === 'antigravity' &&
              typeof collected.meta?.conversationId === 'string' &&
              CONV_ID.test(collected.meta.conversationId) &&
              !(
                switchedAccount &&
                attemptUsedConversationIds.has(collected.meta.conversationId) &&
                collected.meta.conversationId !== outboundConversationId
              )
                ? collected.meta.conversationId
                : outboundConversationId
            const finishedAt = now()
            const attemptLatencyMs = Math.max(0, finishedAt - attemptStartedAt)
            if (reportedConvId) lastConversationId = reportedConvId
            const reportedModel =
              typeof collected.reportedModel === 'string' && collected.reportedModel.trim()
                ? collected.reportedModel.trim()
                : null
            const usageObj = collected.usage || {}
            const totalUsedTokens =
              Number(usageObj.input_tokens || 0) +
              Number(usageObj.output_tokens || 0) +
              Number(usageObj.cache_read_tokens || 0) +
              Number(usageObj.cache_read_input_tokens || 0) +
              Number(usageObj.reasoning_tokens || 0)
            const isLocalToolDrain =
              target === 'antigravity' &&
              Boolean(continuationBinding) &&
              continuationBinding.accountId === id &&
              collected.meta?.awaitingToolResults === true &&
              Array.isArray(collected.toolCalls) &&
              collected.toolCalls.length > 0 &&
              totalUsedTokens === 0 &&
              !reportedModel
            const effectiveParentRequestId = isLocalToolDrain
              ? continuationBinding.parentRequestId || null
              : requestId || null
            recordStickyAccount(effectiveStickyKey, id, reportedConvId, policy, finishedAt, attemptUsedConversationIds)
            recordToolContinuation(
              id,
              collected,
              finishedAt,
              continuationCallIds,
              effectiveStickyKey,
              effectiveParentRequestId,
            )
            recordAccountUsage(apiKeyRecord, resolved.publicId, collected.usage || {})
            poolScheduler?.unitCircuit?.recordSuccess?.(selected.accountId)
            poolScheduler?.lastUsed?.set?.(selected.accountId, finishedAt)
            try {
              if (isLocalToolDrain) {
                attemptsRepoRef?.removeByRequestId?.(requestId)
              } else {
                attemptsRepoRef?.complete?.(requestId, attempts, {
                  upstreamStatus: lastUpstreamStatus ?? 200,
                  errorScope: null,
                  action: 'ok',
                  cooldownUntil: null,
                  downstreamCommitted: true,
                  terminalState: 'verified',
                  usage: collected.usage || null,
                  ttftMs: collected.timing?.ttftMs ?? null,
                  latencyMs: attemptLatencyMs,
                })
              }
            } catch {}
            attemptRecords.push({
              attempt_no: attempts,
              account_id: id,
              vm_id: selected.vmId,
              upstream_model: reportedModel || resolved.upstreamModel,
              ...(reportedConvId ? { conversation_id: reportedConvId } : {}),
              selection_reason: selectionReason,
              upstream_status: lastUpstreamStatus ?? 200,
              error_code: null,
              action: 'ok',
              latency_ms: attemptLatencyMs,
            })
            return {
              ...collected,
              account_id: id,
              auth_method: authMethod,
              model: resolved.publicId,
              dispatched_model: resolved.upstreamModel,
              response_model: reportedModel,
              upstream_model: reportedModel || resolved.upstreamModel,
              provider: resolved.provider,
              quota_group: resolved.quotaGroup,
              attempt_count: attempts,
              attempts: attemptRecords,
              upstream_status: lastUpstreamStatus ?? 200,
              ...(reportedConvId ? { conversation_id: reportedConvId } : {}),
              ...(isLocalToolDrain
                ? {
                    local_tool_drain: true,
                    ...(effectiveParentRequestId
                      ? { tool_continuation_parent_request_id: effectiveParentRequestId }
                      : {}),
                  }
                : {}),
            }
          } catch (error) {
            if (legacyRun) {
              try {
                await callHost('test-chat-cancel', legacyRun)
              } catch {}
              legacyRun = null
            }
            if (activeInfer) {
              try {
                if (activeInfer.directTarget && effectiveDirectClient) {
                  await effectiveDirectClient.cancelDirectTurn(activeInfer.directTarget, activeInfer.request_id)
                } else {
                  await callHost('infer-cancel', activeInfer)
                }
              } catch {}
              activeInfer = null
            }
            reservation?.release()
            reservation = null

            if (error?.timing) lastTiming = error.timing
            if (error?.usage) lastUsage = error.usage
            const failedAt = now()
            const attemptLatencyMs = Math.max(0, failedAt - attemptStartedAt)
            const failure = known(error) || error
            const failureCode = failure?.code
            const cancelled = signal?.aborted || failure?.name === 'AbortError' || failureCode === 'ABORT_ERR'
            const attemptUpstreamStatus = Number.isInteger(failure?.upstreamStatus)
              ? failure.upstreamStatus
              : Number.isInteger(lastUpstreamStatus)
                ? lastUpstreamStatus
                : Number.isInteger(failure?.status)
                  ? failure.status
                  : null

            if (cancelled) {
              try {
                attemptsRepoRef?.complete?.(requestId, attempts, {
                  upstreamStatus: attemptUpstreamStatus,
                  errorScope: 'request',
                  action: 'stop',
                  cooldownUntil: null,
                  downstreamCommitted: emittedOutput,
                  terminalState: 'cancelled',
                  usage: error?.usage || null,
                  ttftMs: error?.timing?.ttftMs ?? null,
                  latencyMs: attemptLatencyMs,
                })
              } catch {}
              attemptRecords.push({
                attempt_no: attempts,
                account_id: id,
                vm_id: selected.vmId,
                upstream_model: resolved.upstreamModel,
                ...(attemptConversationId ? { conversation_id: attemptConversationId } : {}),
                selection_reason: selectionReason,
                upstream_status: attemptUpstreamStatus,
                error_code: 'gemini_inference_cancelled',
                action: 'stop',
                latency_ms: attemptLatencyMs,
              })
              poolScheduler?.unitCircuit?.releaseProbe?.(selected.accountId)
              selected = null
              throw attachAttemptMeta(failure)
            }

            const isUpstream503 =
              failureCode === 'gemini_upstream_unavailable' ||
              (attemptUpstreamStatus === 503 &&
                failureCode !== 'gemini_operation_busy' &&
                failureCode !== 'gemini_native_worker_unavailable')
            const isUpstream502 =
              !isUpstream503 &&
              (attemptUpstreamStatus === 502 ||
                failureCode === 'gemini_proxy_error' ||
                (failureCode === 'gemini_inference_failed' &&
                  (attemptUpstreamStatus == null || attemptUpstreamStatus === 502)))
            const willMarkUnschedulable502 = Boolean(
              isUpstream502 &&
                policy.failover.unschedulable_on_502 === true &&
                typeof slotPrefs?.markUnschedulable === 'function',
            )

            if (willMarkUnschedulable502) {
              // Park the account cleanly into persisted unschedulable state and reset circuit
              // instead of entering a 502 -> circuit-open 503 -> half-open 502 infinite loop.
              slotPrefs.markUnschedulable(
                id,
                failureCode === 'gemini_proxy_error' ? 'proxy_502' : 'upstream_502',
                failure?.message || '上游返回 502 错误',
                { upstream_status: 502, error_code: failureCode || 'gemini_inference_failed' },
              )
              poolScheduler?.unitCircuit?.reset?.(selected.accountId)
              invalidateCatalogCache()
            } else if (NON_CIRCUIT_FAILURES.has(failureCode) || isUpstream503) {
              // Transient 503 must never trip the circuit breaker (prevents 502->503->503 loop).
              poolScheduler?.unitCircuit?.releaseProbe?.(selected.accountId)
            } else {
              poolScheduler?.unitCircuit?.recordFailure?.(selected.accountId)
            }
            if (
              failureCode === 'gemini_proxy_unavailable' ||
              failureCode === 'gemini_model_unavailable' ||
              failureCode === 'gemini_oauth_required' ||
              failureCode === 'gemini_host_protocol_error' ||
              failureCode === 'gemini_environment_conflict' ||
              (typeof failureCode === 'string' && failureCode.startsWith('license_'))
            ) {
              invalidateCatalogCache()
            }

            // On 429 (non-content-rejected, non-all-cooled-probe): actively retry 1 time on the
            // same account by restarting `agy` with `resume` (`restart_resume: true`). If it hits
            // 429 again on the retry, cool down, release sticky binding, and switch accounts.
            const canRateLimitRetryOnce =
              !emittedOutput &&
              failureCode === 'gemini_quota_exhausted' &&
              failure?.contentRejected !== true &&
              !rateLimitRetried.has(selected.accountId) &&
              uncooled.length > 0 &&
              attempts < maxAttempts

            if (canRateLimitRetryOnce) {
              rateLimitRetried.add(selected.accountId)
              preferredRetryAccountId = selected.accountId
              pendingRestartResume = {
                accountId: selected.accountId,
                conversationId: attemptConversationId || null,
              }
              try {
                attemptsRepoRef?.complete?.(requestId, attempts, {
                  upstreamStatus: attemptUpstreamStatus,
                  errorScope: 'quota',
                  action: 'retry_restart_resume',
                  cooldownUntil: null,
                  downstreamCommitted: false,
                  terminalState: 'failed_retryable',
                  usage: error?.usage || null,
                  ttftMs: error?.timing?.ttftMs ?? null,
                  latencyMs: attemptLatencyMs,
                })
              } catch {}
              attemptRecords.push({
                attempt_no: attempts,
                account_id: id,
                vm_id: selected.vmId,
                upstream_model: resolved.upstreamModel,
                ...(attemptConversationId ? { conversation_id: attemptConversationId } : {}),
                selection_reason: selectionReason,
                upstream_status: attemptUpstreamStatus,
                error_code: failureCode,
                action: 'retry_restart_resume',
                latency_ms: attemptLatencyMs,
              })
              lastError = attachAttemptMeta(failure)
              selected = null
              const waitMs =
                Number.isFinite(failure?.retryAfterMs) &&
                failure.retryAfterMs > 0 &&
                failure.retryAfterMs <= SHORT_RATE_LIMIT_MAX_MS
                  ? failure.retryAfterMs
                  : Math.max(0, Math.min(SHORT_RATE_LIMIT_MAX_MS, Number(rateLimitRetryDelayMs) || 0))
              if (waitMs > 0) {
                try {
                  await sleep(waitMs, undefined, { signal })
                } catch (sleepErr) {
                  throw attachAttemptMeta(sleepErr)
                }
              }
              continue
            }

            if (!emittedOutput && failureCode === 'gemini_session_conflict') {
              if (effectiveStickyKey) releaseStickyAccount(effectiveStickyKey)
              clearToolContinuation(continuationCallIds)
            }

            const canSessionConflictRetry =
              !emittedOutput &&
              failureCode === 'gemini_session_conflict' &&
              !sessionConflictRetried &&
              maxAccountSwitches > 0 &&
              attempts < maxAttempts

            if (canSessionConflictRetry) {
              sessionConflictRetried = true
              preferredRetryAccountId = selected.accountId
              try {
                attemptsRepoRef?.complete?.(requestId, attempts, {
                  upstreamStatus: attemptUpstreamStatus ?? 409,
                  errorScope: 'request',
                  action: 'session_retry',
                  cooldownUntil: null,
                  downstreamCommitted: false,
                  terminalState: 'failed_retryable',
                  usage: error?.usage || null,
                  ttftMs: error?.timing?.ttftMs ?? null,
                  latencyMs: attemptLatencyMs,
                })
              } catch {}
              attemptRecords.push({
                attempt_no: attempts,
                account_id: id,
                vm_id: selected.vmId,
                upstream_model: resolved.upstreamModel,
                ...(attemptConversationId ? { conversation_id: attemptConversationId } : {}),
                selection_reason: selectionReason,
                upstream_status: attemptUpstreamStatus ?? 409,
                error_code: failureCode,
                action: 'session_retry',
                latency_ms: attemptLatencyMs,
              })
              lastError = attachAttemptMeta(failure)
              selected = null
              continue
            }

            const cooldownUntilMs = willMarkUnschedulable502
              ? 0
              : recordFailureCooldown(id, resolved.upstreamModel, resolved.quotaGroup, failure, failedAt)
            // Release sticky binding when leaving/failing an account on quota/proxy/502/503/auth errors
            // so future turns cleanly migrate to the newly selected account instead of sticking to a bad one.
            if (failure?.contentRejected !== true && (FAILOVER_ERRORS.has(failureCode) || willMarkUnschedulable502)) {
              releaseStickyAccount(effectiveStickyKey, id)
            }
            excluded.add(selected.accountId)
            const willFailover =
              !emittedOutput &&
              failure?.contentRejected !== true &&
              FAILOVER_ERRORS.has(failureCode) &&
              excluded.size < totalCandidates &&
              accountSwitches < maxAccountSwitches &&
              attempts < maxAttempts
            if (willFailover) {
              accountSwitches += 1
            }
            const errorScope = ACCOUNT_WIDE_COOLDOWN_ERRORS.has(failureCode)
              ? 'account'
              : failureCode === 'gemini_content_rejected'
                ? 'request'
                : failureCode === 'gemini_quota_exhausted'
                  ? 'quota'
                  : 'upstream'
            const action = willFailover ? 'failover' : 'stop'
            try {
              attemptsRepoRef?.complete?.(requestId, attempts, {
                upstreamStatus: attemptUpstreamStatus,
                errorScope,
                action,
                cooldownUntil: cooldownUntilMs > 0 ? Math.trunc(cooldownUntilMs) : null,
                downstreamCommitted: emittedOutput,
                terminalState: willFailover ? 'failed_retryable' : 'failed',
                usage: error?.usage || null,
                ttftMs: error?.timing?.ttftMs ?? null,
                latencyMs: attemptLatencyMs,
              })
            } catch {}
            attemptRecords.push({
              attempt_no: attempts,
              account_id: id,
              vm_id: selected.vmId,
              upstream_model: resolved.upstreamModel,
              ...(attemptConversationId ? { conversation_id: attemptConversationId } : {}),
              selection_reason: selectionReason,
              upstream_status: attemptUpstreamStatus,
              error_code: failureCode || 'gemini_inference_failed',
              action,
              latency_ms: attemptLatencyMs,
            })
            lastError = attachAttemptMeta(failure)
            selected = null

            if (willFailover) {
              continue
            }
            throw lastError
          }
        }

        if (!lastError) {
          const allCandidates = [...primaryCandidates, ...fallbackCandidates].filter((c) => !excluded.has(c.accountId))
          const nowTs = now()
          let earliestRetrySec = 5
          for (const c of allCandidates) {
            const view = poolScheduler?.unitCircuit?.view?.(c.accountId, nowTs)
            if (view?.open_until && view.open_until > nowTs) {
              const sec = Math.max(1, Math.ceil((view.open_until - nowTs) / 1000))
              earliestRetrySec = Math.min(earliestRetrySec, sec)
            }
          }
          const overloaded = fail(429, 'gemini_pool_overloaded', '号池负载过高，请稍后再试')
          overloaded.retryAfter = Math.max(1, earliestRetrySec)
          throw attachAttemptMeta(overloaded)
        }
        throw attachAttemptMeta(lastError)
      } finally {
        reservation?.release()
        try {
          apiKeyStore?.release?.(apiKeyRecord)
        } catch {}
      }
    },

    async complete({
      model,
      text,
      requestId,
      startedAt = null,
      stickyKey = null,
      signal,
      apiKeyRecord,
      allowUnprefixedNonGemini = null,
      ownerScope = PLATFORM_SCOPE,
      allowedEnvIds = null,
      catalogSnapshot = null,
    }) {
      const result = await this.stream({
        model,
        geminiBody: { contents: [{ role: 'user', parts: [{ text }] }] },
        requiredCapabilities: [],
        plainText: text,
        ...(requestId ? { requestId } : {}),
        startedAt,
        stickyKey,
        signal,
        apiKeyRecord,
        allowUnprefixedNonGemini,
        ownerScope,
        allowedEnvIds,
        catalogSnapshot,
      })
      return {
        text: result.text,
        usage: result.usage,
        account_id: result.account_id,
        auth_method: result.auth_method,
        model: result.model,
        dispatched_model: result.dispatched_model ?? null,
        response_model: result.response_model ?? null,
        upstream_model: result.upstream_model,
        stopReason: result.stopReason,
        searches: result.searches,
        attempt_count: result.attempt_count,
        attempts: result.attempts,
        upstream_status: result.upstream_status,
        timing: result.timing,
        ...(result.conversation_id ? { conversation_id: result.conversation_id } : {}),
      }
    },
  }
}
