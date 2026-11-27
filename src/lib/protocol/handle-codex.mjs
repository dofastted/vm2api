/**
 * Codex hop from handle-protocol backed solely by Rust `kin-scheduler` (M3 / D4).
 * Claude convert/pool/CRS never runs here; OpenAI nodes are hard-locked to passthrough.
 */
import crypto from 'node:crypto'
import path from 'node:path'
import { resolveStreamIdleTimeoutMs } from '../core/config.mjs'
import { upstreamRiskClientError } from './intercept-gate.mjs'
import { buildAnthropicSseError } from './stream-truncation.mjs'
import { isClientStream, fromClaudeToOpenAIChat, fromClaudeToOpenAICompletions } from './convert.mjs'
import { getVm, listVms, persistCodexUsage } from '../vm/vm-registry.mjs'
import { isCodexProtocolAllowed, isCodexVm, normalizeCodexRouting } from './codex-route.mjs'
import { keyAllowsVm, keyScopeFromRequest, vmPoolDenial } from '../admin/key-scope.mjs'
import { ownerScopeFromRequest, pinnedVmIdFromRequest, vmMatchesOwnerScope } from '../admin/resource-owner.mjs'
import { restrictCodexClient } from './codex-restriction.mjs'
import {
  responsesSseToChatChunk,
  responsesSseToAnthropicEvents,
  createAnthropicSseState,
  createResponsesSseEventNamer,
  assembleCodexBodyFromSse,
  codexBodyToAnthropicMessage,
  codexCompatibleFunctionTools,
  isToolArgumentsError,
  toCodexResponses,
} from './codex-convert.mjs'
import {
  extraFromCodexHeaders,
  codexCreditsFromHeaders,
  codexQuotaPark,
  CODEX_DEFAULT_PARK_MS,
} from './codex-usage.mjs'
import { disjointOpenaiUsage, mergeUsage, preferUsage } from './openai-usage.mjs'
import { streamCodexKernel } from '../transport/codex-kernel-client.mjs'
import { ensureRedaction, maskJson, restoreJsonValue } from '../redaction/runtime.mjs'
import {
  codexKernelRequestOptions,
  ensureCodexKernel,
  writeCodexKernelConfig,
} from '../transport/codex-kernel-supervisor.mjs'
import { isLocalEgressProxy } from '../vm/egress.mjs'
import { vmNodeId } from '../cluster/placement.mjs'
import { hostProxyUrlForVm } from '../vm/slot-host.mjs'
import {
  openaiUsageAccountId,
  readCodexAccounts,
  upsertCodexAccount,
  persistCodexCredentialState,
  markCodexGrantDead,
} from '../vm/codex-slot.mjs'
import {
  clientBlockErrorOf,
  isTrustedGateDecision,
  projectCandidateAccounts,
  resolveRiskRepos,
  runUnifiedPreDispatch,
} from './unified-pre-dispatch.mjs'
import {
  CODEX_APP_VERSION,
  CODEX_CATALOG_ORIGINATOR,
  CODEX_IMAGE_EDITS_URL,
  CODEX_IMAGE_GENERATIONS_URL,
  CODEX_SEARCH_URL,
  CODEX_USER_AGENT,
  makeProxyFetch,
  refreshCodexAccessToken,
} from './codex-models.mjs'
import { codexSlotAllowsModel, isCodexFailoverError } from '../pool/codex-slot-pool.mjs'
import { applyOpenaiWashLog } from './openai-wash.mjs'
import { canonicalImageToolModel, imageGenerationTools } from './image-tool-models.mjs'
import { isImageToolModelEnabled, resolveGptFastAlias } from './gpt-model-policy.mjs'
import { sessionIdForLog } from './log-fields.mjs'
import { redactHeaders } from '../admin/request-log.mjs'
import {
  extractCallerSession,
  extractFirstUserIdentity,
  firstUserIdentityText,
  outboundSessionMode,
  resolveOutboundSessionId,
  resolveSchedulerIdentity,
} from '../identity/identity-rewrite.mjs'
import { clientIp } from '../pool/sticky-router.mjs'
import { withCredentialRefreshLock } from '../transport/go-worker-client.mjs'
import { compileWithProtoFront, protoFrontMode, transcodeWithProtoFront } from '../transport/proto-front-client.mjs'
import { queueAllowedByHeaders } from './queue-hint.mjs'
import {
  SchedulerApiError,
  SchedulerUnavailableError,
  VIRTUAL_POOL_IDS,
  classifyErrorClass,
  formatNodeKey,
  formatSchedulerError,
} from '../scheduler/scheduler-runtime.mjs'

// Official Codex client headers for ChatGPT Responses. Auth is attached by the kernel.
const CODEX_KERNEL_HEADER_ALLOWLIST = Object.freeze([
  'openai-beta',
  'session-id',
  'thread-id',
  'x-client-request-id',
  'x-codex-beta-features',
  'x-codex-installation-id',
  'x-codex-parent-thread-id',
  'x-codex-turn-metadata',
  'x-codex-turn-state',
  'x-codex-window-id',
  'x-openai-internal-codex-responses-lite',
  'x-openai-memgen-request',
  'x-openai-subagent',
])

function headerString(headers, name) {
  const value = headers?.[name]
  return typeof value === 'string' && value.trim() ? value : ''
}

function codexKernelHeaders(reqHeaders = {}, body = {}, session = null) {
  const headers = {}
  for (const name of CODEX_KERNEL_HEADER_ALLOWLIST) {
    const value = headerString(reqHeaders, name)
    if (value) headers[name] = value
  }
  if (typeof session?.session_id === 'string' && session.session_id) {
    headers['session-id'] = session.session_id
  }
  const model = typeof body?.model === 'string' ? body.model.trim() : ''
  if (model) {
    const tier = typeof body?.service_tier === 'string' ? body.service_tier.trim().toLowerCase() : ''
    headers['x-codex-routing-hint'] =
      tier && tier !== 'default' && tier !== 'standard' && tier !== 'auto'
        ? `model=${model};tier=${tier}`
        : `model=${model}`
  }
  return headers
}

function sessionFrom(req, body) {
  const headers = req.headers || {}
  return {
    session_id:
      headers['x-session-id'] ||
      headers['session-id'] ||
      headers['x-conversation-id'] ||
      body?.conversation_id ||
      body?.session_id ||
      null,
    previous_response_id: body?.previous_response_id || null,
  }
}

/** Session seed identity: first non-empty input item, first non-reminder block (firstUserIdentityText). */
function firstUserIdentityFromCodex(body = {}) {
  if (typeof body?.input === 'string') return body.input
  if (Array.isArray(body?.input)) {
    for (const item of body.input) {
      const texts =
        typeof item === 'string'
          ? [item]
          : typeof item?.content === 'string'
            ? [item.content]
            : Array.isArray(item?.content)
              ? item.content.map((part) =>
                  typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '',
                )
              : []
      const text = firstUserIdentityText(texts).trim()
      if (text) return text
    }
  }
  return extractFirstUserIdentity(body?.messages) || String(body?.prompt || '')
}

/** Codex failover shares the Claude pool's attempt budget. */
export function codexFailoverBudget(routing = {}) {
  const failover = routing?.failover || {}
  const attempts = Number(failover.max_total_attempts)
  const switches = Number(failover.max_account_switches)
  const sameRetries = Number(failover.max_same_account_retries)
  return {
    maxAttempts: Number.isFinite(attempts) && attempts > 0 ? Math.min(64, Math.floor(attempts)) : 12,
    maxSwitches: Number.isFinite(switches) && switches >= 0 ? Math.min(63, Math.floor(switches)) : 3,
    maxSameAccountRetries: Number.isFinite(sameRetries) && sameRetries >= 0 ? Math.min(16, Math.floor(sameRetries)) : 3,
  }
}

/** Same-account retries are only useful for transient failures; auth and quota errors switch seats. */
export function isRetryableSameCodexAccount(
  result,
  { headersSent = false, conversionError = null, signal = null } = {},
) {
  if (!result || result.ok === true || result.committed === true || headersSent || conversionError) return false
  if (signal?.aborted) return false
  const status = Number(result.status) || 0
  const code = String(result.body?.error?.code || result.error_code || '')
  const message = String(result.body?.error?.message || result.error || '')
  if (
    /content_policy|refusal|usage_policy|guard|tool_arguments_mismatch|upstream_protocol_error/i.test(
      `${code} ${message}`,
    )
  )
    return false
  if (result.transportError === true || status === 0) return true
  if (status === 408) return true
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return (
      code === '' ||
      /server_error|provider_error|upstream_error|overloaded_error|internal_error|server_is_overloaded|transport/i.test(
        code,
      )
    )
  }
  return false
}

function applyCodexRebuildBody(body, sessionId, mode) {
  const out = { ...body }
  if (mode !== 'rebuild') return out
  out.prompt_cache_key = sessionId
  delete out.conversation_id
  delete out.session_id
  return out
}

function ingestCodexHop(projectRoot, vmId, result, now = Date.now(), policy = null) {
  const headers = result?.headers || {}
  const extra = extraFromCodexHeaders(headers, now)
  let limitedUntil = null
  let quotaExceeded = false
  if (
    isCodexFailoverError(result) &&
    (Number(result?.status) === 429 || /usage_limit_reached/.test(String(result?.body?.error?.code || '')))
  ) {
    const park = extra ? codexQuotaPark(extra, now) : { limited: true, until: now + CODEX_DEFAULT_PARK_MS }
    limitedUntil = park.until || now + CODEX_DEFAULT_PARK_MS
    quotaExceeded = String(result?.body?.error?.code || result?.error_code || '') === 'usage_limit_reached'
  }
  if (!extra && !limitedUntil && !codexCreditsFromHeaders(headers, now)) return null
  return persistCodexUsage(projectRoot, vmId, { headers, extra, limitedUntil, quotaExceeded, now, policy })
}

function execFor(projectRoot, vm) {
  return {
    vmId: vm.id,
    homeDir: path.join(projectRoot, 'vms', vm.id, 'cli-home'),
    vm,
  }
}

export function isRetryableCodexTransport(result) {
  if (!result || result.ok === true) return false
  if (result.committed === true) return false
  const code = String(result.body?.error?.code || result.error_code || '')
  const msg = String(result.body?.error?.message || result.error || '')
  const status = Number(result.status) || 0
  if (result.transportError === true) return true
  if (status === 0) return true
  if (status === 502 && /upstream_transport|worker_transport|transport/i.test(`${code} ${msg}`)) return true
  return /upstream_transport|worker_transport_error/i.test(code)
}

export function isCodexGrantDead(result) {
  if (!result || result.ok === true) return false
  const status = Number(result.status) || 0
  if (status !== 401 && status !== 403) return false
  const hay = `${result.body?.error?.code || ''} ${result.body?.error?.message || ''} ${result.error_code || ''}`
  return /token_revoked|invalidated oauth token|token has been revoked|oauth_revoked/i.test(hay)
}

export function codexFailureHold(result, now = Date.now()) {
  if (!result || result.ok === true || result.committed === true) return null
  const status = Number(result.status) || 0
  const code = String(result.body?.error?.code || result.error_code || '')
  const message = String(result.body?.error?.message || result.error || '')
  if (status === 400 || status === 422) return null
  if (
    /content_policy|refusal|usage_policy|guard|tool_arguments_mismatch|upstream_protocol_error/i.test(
      `${code} ${message}`,
    )
  )
    return null
  if (status === 401) {
    if (isCodexGrantDead(result)) return { until: Number.MAX_SAFE_INTEGER, reason: 'oauth_revoked' }
    return { until: now + 5 * 60_000, reason: 'oauth_401' }
  }
  if (status === 403) return { until: now + 5 * 60_000, reason: 'permission_denied' }
  if (status === 429) return { until: now + 60_000, reason: 'rate_limited' }
  if (status === 408 || status >= 500) return { until: now + 30_000, reason: 'upstream_5xx' }
  if (result.transportError === true || status === 0) return { until: now + 30_000, reason: 'transport_error' }
  return null
}

function normalizeServiceTier(raw) {
  if (typeof raw !== 'string') return null
  const tier = raw.trim().toLowerCase()
  return tier && tier.length <= 64 && !/[\x00-\x1f\x7f]/.test(tier) ? tier : null
}

export function serviceTierFromSseLine(line) {
  if (typeof line !== 'string' || !line.startsWith('data:') || !line.includes('service_tier')) return null
  try {
    const ev = JSON.parse(line.slice(5).trim())
    return normalizeServiceTier(ev?.response?.service_tier ?? ev?.service_tier)
  } catch {
    return null
  }
}

export function usageFromSseLine(line) {
  if (typeof line !== 'string' || !line.startsWith('data:') || !line.includes('usage')) return null
  try {
    const ev = JSON.parse(line.slice(5).trim())
    const usage = ev?.response?.usage || ev?.usage
    return usage && typeof usage === 'object' ? usage : null
  } catch {
    return null
  }
}

export function imageGenUsageFromSseLine(line) {
  if (typeof line !== 'string' || !line.startsWith('data:') || !line.includes('tool_usage')) return null
  try {
    const ev = JSON.parse(line.slice(5).trim())
    if (ev?.type !== 'response.completed' && ev?.type !== 'response.incomplete') return null
    const usage = ev.response?.tool_usage?.image_gen
    return usage && typeof usage === 'object' ? usage : null
  } catch {
    return null
  }
}

function disabledImageTool(body, logBag) {
  for (const tool of imageGenerationTools(body)) {
    const model = typeof tool.model === 'string' ? tool.model.trim() : ''
    if (!model) continue
    logBag.image_model = canonicalImageToolModel(model) || model
    if (isImageToolModelEnabled(model) === false) return model
  }
  return null
}

function clientGoneSignal(req, res) {
  const controller = new AbortController()
  const onGone = () => controller.abort()
  req?.once?.('aborted', onGone)
  res?.once?.('close', onGone)
  return {
    signal: controller.signal,
    settle() {
      req?.off?.('aborted', onGone)
      res?.off?.('close', onGone)
    },
  }
}

function isAbortErr(err, signal) {
  return Boolean(signal?.aborted || err?.name === 'AbortError' || err?.code === 'ABORT_ERR')
}

function deterministicUuidFromSeed(seed) {
  const hash = crypto.createHash('sha256').update(String(seed)).digest()
  hash[6] = (hash[6] & 0x0f) | 0x40
  hash[8] = (hash[8] & 0x3f) | 0x80
  const hex = hash.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function buildCodexFailureReport(result) {
  const httpStatus = Number(result?.status) || 0
  const code = String(result?.body?.error?.code || result?.error_code || result?.error || '').trim()
  const msg = String(result?.body?.error?.message || result?.error || '').trim()
  let errorClass
  if (result?.grantDead === true || isCodexGrantDead(result)) {
    errorClass = 'permanent_ban'
  } else if (code === 'usage_limit_reached') {
    errorClass = 'quota_exhausted'
  } else {
    errorClass = classifyErrorClass({
      status: httpStatus,
      errorCode: code,
      reason: msg,
      isTransport: Boolean(result?.transportError) || httpStatus === 0,
      isTimeout: httpStatus === 408 || httpStatus === 504 || code === 'upstream_timeout',
    })
  }
  const retryHdr = Number(result?.headers?.['retry-after'] ?? result?.headers?.['Retry-After'])
  const retryAfterSec = Number.isFinite(retryHdr) && retryHdr > 0 ? Math.max(1, Math.ceil(retryHdr)) : undefined
  return {
    http_status: httpStatus,
    error_class: errorClass,
    ...(code ? { error_signature: code.slice(0, 128) } : {}),
    ...(msg ? { error_message: msg.slice(0, 300) } : {}),
    ...(retryAfterSec != null ? { retry_after_sec: retryAfterSec } : {}),
  }
}

function respondCodexSchedulerError({ res, json, stats, logBag, err }) {
  stats.errors++
  if (err instanceof SchedulerUnavailableError || err?.code === 'scheduler_unavailable') {
    logBag.error_code = 'scheduler_unavailable'
    logBag.error_message = err?.message || 'Rust scheduler sidecar is unavailable'
    logBag.final_state = 'scheduler_unavailable'
    if (!res.headersSent) res.setHeader?.('retry-after', '1')
    return json(res, 503, {
      type: 'error',
      error: {
        type: 'api_error',
        code: 'scheduler_unavailable',
        message: logBag.error_message,
      },
    })
  }
  const formatted = formatSchedulerError(err)
  logBag.error_code = formatted.code
  logBag.error_message = formatted.body?.error?.message || null
  if (formatted.explain) logBag.scheduler_explain = formatted.explain
  logBag.final_state = formatted.status === 422 ? 'poison_abort' : 'failed'
  if (formatted.retryAfterSec != null && !res.headersSent) {
    res.setHeader?.('retry-after', String(formatted.retryAfterSec))
  }
  return json(res, formatted.status, formatted.body)
}

function validateCodexPreconditions({
  projectRoot,
  req,
  keyScope,
  ownerScope,
  pinVmId,
  model,
  res,
  json,
  stats,
  logBag,
}) {
  const scope = keyScope || keyScopeFromRequest(req)
  const poolDenial = vmPoolDenial(scope)
  if (poolDenial) {
    stats.errors++
    logBag.error_code = 'vm_pool_unavailable'
    json(res, 403, {
      error: {
        type: 'permission_error',
        code: 'vm_pool_unavailable',
        message: poolDenial.message || '账号池不可用',
      },
    })
    return { ok: false, scope }
  }
  if (scope.group_type === 'anthropic') {
    stats.errors++
    logBag.error_code = 'key_group_mismatch'
    json(res, 403, {
      error: { type: 'permission_error', code: 'key_group_mismatch', message: '此密钥不能调用 openai' },
    })
    return { ok: false, scope }
  }
  const pin = pinVmId === undefined ? pinnedVmIdFromRequest(req) : pinVmId
  if (pin) {
    const vm = getVm(projectRoot, pin)
    if (!vm || !isCodexVm(vm)) {
      stats.errors++
      logBag.error_code = 'platform_mismatch'
      json(res, 400, {
        error: { type: 'invalid_request_error', code: 'platform_mismatch', message: `vm '${pin}' is not a GPT slot` },
      })
      return { ok: false, scope, pin }
    }
    if (!keyAllowsVm(scope, vm)) {
      stats.errors++
      logBag.error_code = 'key_group_mismatch'
      json(res, 403, {
        error: { type: 'permission_error', code: 'key_group_mismatch', message: '此密钥不能调用 openai' },
      })
      return { ok: false, scope, pin }
    }
    if (!codexSlotAllowsModel(vm, model)) {
      stats.errors++
      logBag.error_code = 'model_not_allowed'
      json(res, 400, {
        error: {
          type: 'invalid_request_error',
          code: 'model_not_allowed',
          message: `model '${model || ''}' is not allowed on any GPT slot`,
          param: 'model',
        },
      })
      return { ok: false, scope, pin }
    }
  }
  const owner = ownerScope || ownerScopeFromRequest(req)
  return { ok: true, scope, owner, pin }
}

export function reasoningHistoryFallback(args, result) {
  if (process.env.KIN_CODEX_REASONING_HISTORY_FALLBACK === '0') return null
  const body = args.body
  const error = result?.body?.error || result?.body?.response?.error
  if (result?.ok || result?.committed || result?.transportError || args.signal?.aborted) return null
  if (![500, 502].includes(Number(result?.status)) || error?.code !== 'server_error') return null
  if (body?.model !== 'gpt-6-astra' || body?.reasoning?.context !== 'all_turns' || !Array.isArray(body.input))
    return null
  if (String(args.envelope?.headers?.['x-openai-internal-codex-responses-lite']).toLowerCase() !== 'true') return null
  if (body.previous_response_id || args.envelope?.session?.previous_response_id) return null
  const encrypted = (item) =>
    item?.type === 'reasoning' && typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0
  const history = body.input.filter(encrypted)
  const originalBytes = Buffer.byteLength(JSON.stringify(history.map((item) => item.encrypted_content)))
  if (originalBytes <= 128 * 1024) return null
  let retainedBytes = 2
  const keep = new Set()
  for (let i = body.input.length - 1; i >= 0; i--) {
    const item = body.input[i]
    if (!encrypted(item)) continue
    const bytes = Buffer.byteLength(JSON.stringify(item.encrypted_content)) + (keep.size ? 1 : 0)
    if (retainedBytes + bytes > 120 * 1024) break
    retainedBytes += bytes
    keep.add(i)
  }
  if (!keep.size || keep.size === history.length) return null
  const nextBody = { ...body, input: body.input.filter((item, i) => !encrypted(item) || keep.has(i)) }
  return {
    args: { ...args, body: nextBody, envelope: { ...args.envelope, body: nextBody } },
    info: {
      original_array_bytes: originalBytes,
      retained_array_bytes: retainedBytes,
      original_items: history.length,
      retained_items: keep.size,
      omitted_items: history.length - keep.size,
    },
  }
}

export async function runCodexKernelHop({ hop, args = {}, onEvent, onReasoningFallback } = {}) {
  let emitted = false
  const wrapped = async (line) => {
    emitted = true
    if (onEvent) await onEvent(line)
  }
  let result = await hop({ ...args, onEvent: wrapped })
  if (!result?.ok && !emitted && isRetryableCodexTransport(result)) {
    result = { ...(await hop({ ...args, onEvent: wrapped })), transport_retried: true }
  }
  const fallback = !emitted && !result?.transport_retried ? reasoningHistoryFallback(args, result) : null
  if (fallback) {
    if (onReasoningFallback)
      await onReasoningFallback({ originalResult: result, body: fallback.args.body, ...fallback.info })
    if (args.signal?.aborted) return result
    result = {
      ...(await hop({ ...fallback.args, onEvent: wrapped })),
      reasoning_history_retried: true,
      reasoning_history_fallback: fallback.info,
    }
  }
  return result
}

export async function handleCodexProtocol({
  req,
  res,
  protocol,
  ctx,
  inbound,
  logBag,
  stats,
  json,
  writeSSEHeaders,
  routing = {},
  projectRoot,
  ops = {},
  body = null,
  captureOutbound = false,
  requestStartedAt = Date.now(),
  preDispatchDecision = null,
  settings = null,
  refusalGuards = null,
  refusalDevices = null,
  refusalSessions = null,
  keyScope = null,
  afterHop = null,
  ownerScope = null,
  pinVmId = undefined,
  poolAccess = null,
  originPoolId = null,
  jevDowngradePoolId = null,
  inboundIdentity = null,
  isAdminDiagnostic = undefined,
  allowQueue = undefined,
  schedulerRuntime = null,
  cfg = null,
}) {
  const pfMode = protoFrontMode()
  const codex = normalizeCodexRouting(routing.codex)
  const allowed =
    pfMode === 'go' && protocol === 'google.gemini' ? { ok: true } : isCodexProtocolAllowed(protocol, { codex })
  if (!allowed.ok) {
    stats.errors++
    logBag.via = 'codex-kernel'
    logBag.error_code = allowed.code
    return json(res, 400, {
      error: {
        type: 'invalid_request_error',
        code: allowed.code,
        message: `protocol '${protocol}' is not allowed on the Codex hop`,
      },
    })
  }
  const restriction = restrictCodexClient(req.headers, ctx.body || inbound, { codex }, protocol)
  if (!restriction.ok) {
    stats.errors++
    logBag.via = 'codex-kernel'
    logBag.error_code = restriction.code
    return json(res, 403, {
      error: { type: 'permission_error', code: restriction.code, message: restriction.message },
    })
  }
  let pfCompile = null
  if (pfMode === 'go') {
    try {
      pfCompile = await compileWithProtoFront({
        cfg: cfg || { paths: { project: projectRoot } },
        inboundProtocol: protocol,
        targetFamily: 'codex_kernel',
        reqPath: ctx.path,
        headers: req.headers,
        body: ctx.body,
        routing,
        routeModel: ctx.body?.model || '',
        routeStream:
          protocol === 'google.gemini' ? String(ctx?.path || '').includes(':streamGenerateContent') : undefined,
      })
      if (pfCompile) {
        logBag.hop_meta = {
          ...logBag.hop_meta,
          proto_front: {
            mode: pfCompile.mode || null,
            decision: pfCompile.decision || null,
            stripped_fields: pfCompile.stripped_fields || [],
          },
        }
      }
    } catch (err) {
      logBag.hop_meta = { ...logBag.hop_meta, proto_front_error: err?.code || err?.message || 'error' }
    }
  } else if (pfMode === 'shadow') {
    void compileWithProtoFront({
      cfg: cfg || { paths: { project: projectRoot } },
      inboundProtocol: protocol,
      targetFamily: 'codex_kernel',
      reqPath: ctx.path,
      headers: req.headers,
      body: ctx.body,
      routing,
      routeModel: ctx.body?.model || '',
    })
      .then((shadowRes) => {
        logBag.hop_meta = {
          ...logBag.hop_meta,
          proto_front_shadow: { ok: shadowRes?.ok === true, mode: shadowRes?.mode, decision: shadowRes?.decision },
        }
      })
      .catch(() => {})
  }
  let converted
  if (pfMode === 'go' && pfCompile) {
    const fast = resolveGptFastAlias(ctx.body?.model)
    if (fast.kind === 'unavailable') {
      converted = { ok: false, code: fast.reason === 'base_disabled' ? 'model_disabled' : 'model_fast_unavailable' }
    } else if (!pfCompile.ok) {
      stats.errors++
      logBag.via = 'codex-kernel'
      logBag.error_code = pfCompile.code || 'codex_convert_failed'
      return json(
        res,
        pfCompile.status || 400,
        pfCompile.error_body || {
          error: {
            type: 'invalid_request_error',
            code: logBag.error_code,
            message: 'request could not be converted to Codex Responses',
          },
        },
      )
    } else {
      const goBody = pfCompile.outbound_body
      if (fast.kind === 'fast') {
        const parts = String(goBody.model || '')
          .trim()
          .split('/')
          .filter(Boolean)
        if (parts.length) parts[parts.length - 1] = fast.base
        goBody.model = parts.join('/')
        goBody.service_tier = fast.service_tier
      }
      converted = { ok: true, converted: pfCompile.mode !== 'passthrough', body: goBody }
    }
  } else {
    converted = toCodexResponses(protocol, ctx.body, codex.convert)
  }
  if (!converted.ok) {
    stats.errors++
    logBag.via = 'codex-kernel'
    applyOpenaiWashLog(logBag, {
      inboundPath: ctx.path,
      inboundProtocol: protocol,
      converted: false,
    })
    logBag.error_code = converted.code
    return json(res, 400, {
      error: {
        type: 'invalid_request_error',
        code: converted.code,
        message: 'request could not be converted to Codex Responses',
      },
    })
  }
  applyOpenaiWashLog(logBag, {
    inboundPath: ctx.path,
    inboundProtocol: protocol,
    converted: converted.converted,
    outboundBody: converted.body,
  })
  const disabledImage = disabledImageTool(converted.body, logBag)
  if (disabledImage) {
    stats.errors++
    logBag.via = 'codex-kernel'
    logBag.error_code = 'model_disabled'
    return json(res, 400, {
      error: {
        type: 'invalid_request_error',
        code: 'model_disabled',
        message: `image_generation model '${disabledImage}' is disabled by gateway GPT model policy`,
      },
    })
  }

  // Enforce pre-dispatch JEV BEFORE Rust `acquireNode` so blocked requests reserve zero slots.
  if (!isTrustedGateDecision(preDispatchDecision || req?._preDispatchDecision) && settings) {
    const riskState = resolveRiskRepos({ settings, refusalGuards, refusalDevices, refusalSessions })
    const candidateAccounts = projectCandidateAccounts({
      projectRoot,
      keyScope,
      ownerScope,
      platform: 'openai',
    })
    const decision = await runUnifiedPreDispatch({
      req,
      inbound: inbound || body,
      body: body || converted.body || inbound,
      headers: req.headers,
      distillRules: cfg?.distill,
      policy: riskState.policy,
      settings,
      repo: riskState.repo,
      devices: riskState.devices,
      sessions: riskState.sessions,
      requestId: res?._kinRequestId || '',
      candidateAccounts,
      poolJevProfile: req?.poolJevProfile || keyScope?.jev_profile || null,
      channel: 'openai',
      backend: 'oauth',
      openaiPlatform: true,
    })
    if (decision.action === 'block') {
      stats.errors++
      logBag.via = decision.via
      logBag.attempt_count = 0
      logBag.final_state = decision.final_state
      logBag.error_code = decision.error_code
      logBag.error_message = decision.message
      if (decision.error_details) {
        logBag.error_details = { ...(logBag.error_details || {}), ...decision.error_details }
      }
      logBag.intercept = decision.intercept || null
      logBag.jev_state = decision.jev_state || null
      if (decision.retry_after_sec) res.setHeader?.('retry-after', String(decision.retry_after_sec))
      const clientErr = clientBlockErrorOf(decision)
      return json(res, clientErr.status, clientErr.body)
    }
  }

  const preCheck = validateCodexPreconditions({
    projectRoot,
    req,
    keyScope,
    ownerScope,
    pinVmId,
    model: converted.body?.model,
    res,
    json,
    stats,
    logBag,
  })
  if (!preCheck.ok) return

  const rt = schedulerRuntime || req?._schedulerRuntime || null
  if (!rt) {
    return respondCodexSchedulerError({
      res,
      json,
      stats,
      logBag,
      err: new SchedulerUnavailableError('Rust scheduler runtime is unavailable for Codex dispatch', {
        reason: 'runtime_missing',
      }),
    })
  }

  const stream =
    protocol === 'google.gemini'
      ? String(ctx?.path || '').includes(':streamGenerateContent')
      : isClientStream(inbound || ctx.body, req.headers) && ctx.body?.stream !== false
  const useGoEgress =
    pfMode === 'go' &&
    (protocol === 'anthropic.messages' || protocol === 'google.gemini' || (protocol === 'openai.completions' && stream))
  const inboundSession = sessionFrom(req, converted.body)
  const sessionMode = outboundSessionMode(routing)
  const callerSession = extractCallerSession({
    inbound: converted.body,
    body: converted.body,
    headers: req.headers,
  })
  if (!logBag.session_id) logBag.session_id = sessionIdForLog(callerSession)
  const firstUserIdentity = firstUserIdentityFromCodex(converted.body)
  const hop = ops.streamCodexKernel || streamCodexKernel
  const writeCfg = ops.writeCodexKernelConfig || writeCodexKernelConfig
  const ensure = ops.ensureCodexKernel || ensureCodexKernel
  const anthropicSse = protocol === 'anthropic.messages' ? createAnthropicSseState() : null
  const chatSse =
    protocol === 'openai.chat' || protocol === 'openai.completions'
      ? { id: 'codex', seq: 0, tools: new Map(), sawTool: false }
      : null

  const effectivePoolAccess = poolAccess || req?._poolAccess || null
  const effectiveIdentity =
    inboundIdentity ||
    ctx?.inboundIdentity ||
    resolveSchedulerIdentity({
      inbound: inbound || body || converted.body,
      headers: req.headers,
      poolId: originPoolId || effectivePoolAccess?.effectivePool?.id || '',
      apiKeyId: req.apiKeyRecord?.id || '',
    })
  const resolvedOriginPoolId =
    originPoolId ||
    effectivePoolAccess?.originPool?.id ||
    effectivePoolAccess?.effectivePool?.id ||
    preCheck.scope?.vm_pool_id ||
    VIRTUAL_POOL_IDS.codex
  const isManagedPool = Boolean(effectivePoolAccess && effectivePoolAccess.legacy === false)
  const resolvedAllowedNodeKeys =
    !isManagedPool && Array.isArray(preCheck.scope?.allowed_vms) && preCheck.scope.allowed_vms.length > 0
      ? preCheck.scope.allowed_vms.map((id) => formatNodeKey('codex_vm', id))
      : undefined
  const baseAcquireParams = {
    requestId: crypto.randomUUID(),
    originPoolId: resolvedOriginPoolId,
    jevDowngradePoolId: jevDowngradePoolId || logBag.jev_downgrade_pool_id || null,
    apiKeyRecord: req.apiKeyRecord || null,
    apiKeyKind: req.apiKeyKind || null,
    poolAccess: effectivePoolAccess,
    ownerScope: preCheck.owner,
    allowedNodeKeys: resolvedAllowedNodeKeys,
    nodeTypes: ['codex_vm'],
    model: String(converted.body?.model || ''),
    modelFamily: 'openai',
    protocol: protocol || 'openai.responses',
    machineId: effectiveIdentity?.machineId || null,
    sessionId: effectiveIdentity?.sessionId || callerSession || crypto.randomUUID(),
    sessionIdSource: effectiveIdentity?.sessionSource || null,
    parentSessionId: effectiveIdentity?.parentSessionId || null,
    isEphemeralProbe: Boolean(effectiveIdentity?.isEphemeralProbe),
    noQueue: allowQueue === false || !queueAllowedByHeaders(req.headers),
    isAdminDiagnostic: isAdminDiagnostic !== undefined ? Boolean(isAdminDiagnostic) : Boolean(preCheck.pin),
    pinNodeKey: preCheck.pin ? formatNodeKey('codex_vm', preCheck.pin) : null,
  }

  const excludedNodeKeys = new Set()
  const gone = clientGoneSignal(req, res)
  const failoverBudget = codexFailoverBudget(routing)
  const sameRetryDelay = Number(routing?.failover?.same_account_retry_delay_ms)
  const sameRetryDelayMs =
    Number.isFinite(sameRetryDelay) && sameRetryDelay >= 0 ? Math.min(10_000, sameRetryDelay) : 100
  logBag.via = 'codex-kernel'
  logBag.attempt_count = 0

  let activeLeaseId = null
  let activeVmId = null
  let activeCommitted = false
  let commitPromise = null
  let last = null
  let hops = 0
  let attempts = 0
  let switches = 0
  let counted = false
  let compatibleTools = null

  const releaseActiveLeaseNow = async (payload) => {
    const lid = activeLeaseId
    activeLeaseId = null
    if (!lid) return
    try {
      await rt.releaseLease(lid, payload)
    } catch {}
  }

  const markCommitted = () => {
    activeCommitted = true
    if (activeLeaseId && !commitPromise) {
      const lid = activeLeaseId
      commitPromise = rt.commitLease(lid).catch(() => {})
    }
  }

  try {
    let acquired
    try {
      acquired = await rt.acquireNode(
        { ...baseAcquireParams, attemptNo: 1, excludeNodes: [...excludedNodeKeys] },
        { signal: gone.signal },
      )
    } catch (err) {
      if (isAbortErr(err, gone.signal)) {
        logBag.final_state = 'cancelled'
        return
      }
      return respondCodexSchedulerError({ res, json, stats, logBag, err })
    }

    activeLeaseId = acquired.lease_id
    activeVmId = String(acquired.selected_node?.node_id || '')
    if (acquired.resolved_pool_id) logBag.resolved_pool_id = acquired.resolved_pool_id

    const switchCodexNode = async (failureReport) => {
      excludedNodeKeys.add(formatNodeKey('codex_vm', activeVmId))
      switches += 1
      if (switches > failoverBudget.maxSwitches || attempts >= failoverBudget.maxAttempts || preCheck.pin) {
        await releaseActiveLeaseNow({
          outcome: failureReport.error_class === 'timeout' ? 'timeout' : 'error',
          http_status: failureReport.http_status || undefined,
          error_class: failureReport.error_class,
          error_signature: failureReport.error_signature,
          error_message: failureReport.error_message,
          retry_after_sec: failureReport.retry_after_sec,
        })
        return { ok: false, exhausted: true }
      }
      const prevLeaseId = activeLeaseId
      activeLeaseId = null
      try {
        const switched = await rt.switchNode(
          {
            release_lease_id: prevLeaseId,
            failure: failureReport,
            next_attempt: {
              ...baseAcquireParams,
              attemptNo: attempts + 1,
              excludeNodes: [...excludedNodeKeys],
            },
          },
          { signal: gone.signal },
        )
        activeLeaseId = switched.lease_id
        activeVmId = String(switched.selected_node?.node_id || '')
        activeCommitted = false
        commitPromise = null
        if (switched.resolved_pool_id) logBag.resolved_pool_id = switched.resolved_pool_id
        return { ok: true }
      } catch (switchErr) {
        if (isAbortErr(switchErr, gone.signal)) return { ok: false, aborted: true }
        if (
          switchErr instanceof SchedulerUnavailableError ||
          switchErr?.code === 'scheduler_unavailable' ||
          (switchErr instanceof SchedulerApiError && (switchErr.code === 'poison_abort' || switchErr.status === 422))
        ) {
          return { ok: false, fatalErr: switchErr }
        }
        return { ok: false, exhausted: true, switchErr }
      }
    }

    for (;;) {
      const vm = getVm(projectRoot, activeVmId)
      if (!vm || !isCodexVm(vm)) {
        const sw = await switchCodexNode({
          http_status: 503,
          error_class: 'server5xx',
          error_signature: 'codex_vm_missing',
        })
        if (sw.ok) continue
        if (sw.aborted) {
          logBag.final_state = 'cancelled'
          return
        }
        if (sw.fatalErr) return respondCodexSchedulerError({ res, json, stats, logBag, err: sw.fatalErr })
        break
      }
      attempts += 1
      if (attempts > failoverBudget.maxAttempts) {
        await releaseActiveLeaseNow({ outcome: 'error' })
        break
      }
      if (!counted) {
        counted = true
        stats.requests++
        stats.by_route[protocol] = (stats.by_route[protocol] || 0) + 1
      }

      const localExit = isLocalEgressProxy(vm.proxy)
      const written = writeCfg(projectRoot, vm, {
        proxyUrl: localExit && !vmNodeId(vm) ? '' : hostProxyUrlForVm(vm),
        proxyRequired: true,
        routing,
      })
      const ready = await ensure(execFor(projectRoot, vm))
      if (!ready?.ok) {
        last = {
          ok: false,
          status: 503,
          committed: false,
          body: {
            error: {
              type: 'api_error',
              code: 'codex_kernel_unavailable',
              message: `Codex kernel 未就绪（${ready?.reason || 'not_ready'}）。GPT 槽走独立 kernel，不是 wrap cli-hop。`,
            },
          },
        }
        if (!res.headersSent) {
          const sw = await switchCodexNode({
            http_status: 503,
            error_class: 'server5xx',
            error_signature: 'codex_kernel_unavailable',
            error_message: last.body.error.message,
          })
          if (sw.ok) continue
          if (sw.aborted) {
            logBag.final_state = 'cancelled'
            return
          }
          if (sw.fatalErr) return respondCodexSchedulerError({ res, json, stats, logBag, err: sw.fatalErr })
          break
        }
        await releaseActiveLeaseNow({ outcome: 'error', http_status: 503, error_class: 'server5xx' })
        stats.errors++
        logBag.error_code = 'codex_kernel_unavailable'
        return json(res, 503, last.body)
      }

      hops += 1
      logBag.vm_id = vm.id
      logBag.attempt_count += 1
      logBag.usage_account_id = openaiUsageAccountId(searchCredentials(projectRoot, vm).accountId)
      const chunks = []
      const nameSseEvent = createResponsesSseEventNamer()
      let responseServiceTier = null
      let streamedUsage = null
      let streamedImageUsage = null
      let conversionError = null
      const attemptStartedAt = Date.now()
      const sessionOptions = {
        boundSessionId: '',
        boundVmId: '',
        vmId: vm.id,
        accountId: vm.id,
        firstUserIdentity,
        clientIp: clientIp(req),
        userAgent: req.headers?.['user-agent'] || '',
        epoch: `${attemptStartedAt}:${vm.id}:${hops}`,
      }
      const outboundSessionId =
        sessionMode === 'passthrough'
          ? inboundSession.session_id ||
            resolveOutboundSessionId(callerSession, { ...sessionOptions, mode: 'passthrough', officialClient: true })
          : resolveOutboundSessionId(callerSession, { ...sessionOptions, mode: sessionMode })
      const session = {
        session_id: outboundSessionId,
        previous_response_id: inboundSession.previous_response_id,
      }
      logBag.outbound_session_id = sessionIdForLog(outboundSessionId)
      // OpenAI / Codex nodes strictly enforce passthrough (zero Anthropic prompt injection).
      let outboundBody = applyCodexRebuildBody(
        { ...converted.body, ...(compatibleTools && { tools: compatibleTools }), stream: true },
        outboundSessionId,
        sessionMode,
      )
      const outboundHeaders = codexKernelHeaders(req.headers, outboundBody, session)
      if (captureOutbound) logBag.outbound_body = outboundBody
      logBag.outbound_headers = redactHeaders(outboundHeaders)
      let hopEmitted = false
      const runHop = () =>
        runCodexKernelHop({
          hop,
          args: {
            exec: execFor(projectRoot, vm),
            signal: gone.signal,
            timeoutMs: cfg?.limits?.upstream_timeout_ms ?? 600_000,
            idleTimeoutMs: resolveStreamIdleTimeoutMs(routing, cfg),
            routing,
            redactionPrincipal: req.apiKeyRecord?.id || (req.apiKeyKind === 'master' ? 'master' : ''),
            redactionSession: String(req.headers?.['x-session-id'] || inboundSession.session_id || ''),
            gatewayRequestId: res?._kinRequestId || null,
            body: outboundBody,
            envelope: {
              body: outboundBody,
              headers: outboundHeaders,
              stream: true,
              session,
              options: { ...codexKernelRequestOptions(routing, vm), installation_id: written?.installationId },
            },
          },
          onReasoningFallback: ({ body: retryBody }) => {
            if (captureOutbound) logBag.outbound_body = retryBody
          },
          onEvent: async (line) => {
            hopEmitted = true
            markCommitted()
            if (conversionError) return
            const tier = serviceTierFromSseLine(line)
            if (tier) responseServiceTier = tier
            const seen = usageFromSseLine(line)
            if (seen) streamedUsage = mergeUsage(streamedUsage, seen)
            const imageGen = imageGenUsageFromSseLine(line)
            if (imageGen) streamedImageUsage = imageGen
            if (!stream || useGoEgress) {
              chunks.push(line)
              return
            }
            if (!res.headersSent) writeSSEHeaders(res)
            if (protocol !== 'openai.responses') {
              try {
                const mapped =
                  protocol === 'anthropic.messages'
                    ? responsesSseToAnthropicEvents(line, anthropicSse)
                    : responsesSseToChatChunk(line, 'codex', chatSse)
                if (mapped) res.write(mapped)
              } catch (error) {
                if (error.code !== 'tool_arguments_mismatch') throw error
                conversionError = { type: 'upstream_protocol_error', code: error.code, message: error.message }
                res.write(
                  protocol === 'anthropic.messages'
                    ? `event: error\ndata: ${JSON.stringify({ type: 'error', error: conversionError })}\n\n`
                    : `data: ${JSON.stringify({ error: conversionError })}\n\ndata: [DONE]\n\n`,
                )
              }
              return
            }
            const named = nameSseEvent(line)
            if (named) res.write(named)
          },
        })

      const runAttempt = async () => {
        let result = await runHop()
        let policyRefusal = afterHop?.(result)
        const error = result?.body?.error
        if (
          !compatibleTools &&
          !policyRefusal &&
          !result?.ok &&
          Number(result?.status) === 400 &&
          error?.code === 'invalid_json_schema' &&
          /^Invalid schema for 'tools\[\d+\]\.parameters': Unsatisfiable schema:/.test(error.message || '') &&
          !result.committed &&
          !result.transportError &&
          !hopEmitted &&
          !res.headersSent &&
          !gone.signal.aborted &&
          attempts < failoverBudget.maxAttempts
        ) {
          compatibleTools = codexCompatibleFunctionTools(outboundBody.tools)
          if (compatibleTools) {
            attempts += 1
            logBag.attempt_count += 1
            outboundBody = { ...outboundBody, tools: compatibleTools }
            if (captureOutbound) logBag.outbound_body = outboundBody
            result = await runHop()
            policyRefusal = afterHop?.(result)
          }
        }
        return { result, policyRefusal }
      }

      let { result, policyRefusal } = await runAttempt()
      let sameAccountRetries = result?.transport_retried || result?.reasoning_history_retried ? 1 : 0
      while (
        !policyRefusal &&
        sameAccountRetries < failoverBudget.maxSameAccountRetries &&
        attempts < failoverBudget.maxAttempts &&
        isRetryableSameCodexAccount(result, {
          headersSent: res.headersSent || hopEmitted,
          conversionError,
          signal: gone.signal,
        })
      ) {
        sameAccountRetries += 1
        attempts += 1
        hops += 1
        logBag.attempt_count += 1
        logBag.codex_same_account_retried = sameAccountRetries
        await new Promise((resolve) => setTimeout(resolve, sameRetryDelayMs))
        hopEmitted = false
        const retried = await runAttempt()
        result = retried.result
        policyRefusal = retried.policyRefusal
      }

      logBag.first_token_ms = Number.isFinite(result?.firstTokenAt)
        ? Math.max(0, result.firstTokenAt - requestStartedAt)
        : (result?.ttftMs ?? null)
      logBag.first_byte_ms = Number.isFinite(result?.firstByteAt)
        ? Math.max(0, result.firstByteAt - requestStartedAt)
        : (result?.firstByteMs ?? null)
      logBag.generation_ms = result?.generationMs ?? null
      if (conversionError) {
        result.ok = false
        result.status = 502
        result.terminalState = 'incomplete'
        result.body = { error: conversionError }
      }
      ingestCodexHop(projectRoot, vm.id, result, Date.now(), normalizeCodexRouting(routing.codex).quota)
      if (result?.hopRequestId) {
        logBag.hop_meta = { ...logBag.hop_meta, hop_request_id: result.hopRequestId }
      }
      if (result?.transport_retried) logBag.transport_retried = true
      if (result?.reasoning_history_retried) {
        logBag.attempt_count += 1
        logBag.reasoning_history_retried = true
      }
      last = result
      const hopUsage = result.usage || result.body?.usage || result.body?.response?.usage || null
      const preferredUsage = preferUsage(hopUsage, streamedUsage)
      const usage = mergeUsage(preferredUsage === hopUsage ? streamedUsage : hopUsage, preferredUsage)
      const delivered = !policyRefusal && !conversionError && result?.ok

      if (delivered) {
        const serviceTier = normalizeServiceTier(outboundBody.service_tier)
        logBag.upstream_service_tier = responseServiceTier
        const logged = disjointOpenaiUsage(usage ? { ...usage, service_tier: serviceTier } : usage)
        logBag.usage = logged
        const imageUsage =
          result.body?.tool_usage?.image_gen || result.body?.response?.tool_usage?.image_gen || streamedImageUsage
        if (imageUsage) logBag.image_usage = imageUsage
        logBag.input_tokens = logged?.input_tokens ?? null
        logBag.output_tokens = logged?.output_tokens ?? null
        logBag.cache_read_tokens = logged?.cache_read_input_tokens ?? logged?.cache_read_tokens ?? null
        logBag.cache_creation_tokens = logged?.cache_creation_input_tokens ?? logged?.cache_creation_tokens ?? null
        logBag.final_state = result.terminalState || 'verified'
        logBag.stop_reason = result.body?.incomplete_details?.reason || null
        logBag.upstream_model = converted.body.model
        if (hops > 1) logBag.codex_failed_over = true

        if (activeLeaseId) {
          await (commitPromise || rt.commitLease(activeLeaseId).catch(() => {}))
        }
        const totalTokens = Number(logged?.input_tokens || 0) + Number(logged?.output_tokens || 0)
        await releaseActiveLeaseNow({
          outcome: 'ok',
          http_status: 200,
          ...(Number.isFinite(result?.ttftMs) ? { ttft_ms: Math.max(0, Math.round(result.ttftMs)) } : {}),
          ...(totalTokens > 0 ? { tokens_used: totalTokens } : {}),
        })

        if (!stream) {
          if (useGoEgress) {
            const tc = await transcodeWithProtoFront({
              cfg: cfg || { paths: { project: projectRoot } },
              upstreamProtocol: 'openai.responses',
              inboundProtocol: protocol,
              model: converted.body.model,
              stream: false,
              payload: chunks.join(''),
            })
            if (tc?.ok && tc.body) return json(res, 200, JSON.parse(tc.body))
          }
          if (protocol === 'openai.responses' && result.body?.status === 'incomplete')
            return json(res, 200, result.body)
          let assembledOut
          try {
            const assembled = assembleCodexBodyFromSse(chunks, result.body || {})
            assembledOut = assembled
            if (protocol !== 'openai.responses') {
              const message = codexBodyToAnthropicMessage(assembled, converted.body.model)
              assembledOut =
                protocol === 'openai.chat'
                  ? fromClaudeToOpenAIChat(message, converted.body.model)
                  : protocol === 'openai.completions'
                    ? fromClaudeToOpenAICompletions(message, converted.body.model)
                    : message
            }
          } catch (error) {
            if (!isToolArgumentsError(error)) throw error
            stats.errors++
            logBag.error_code = error.code
            logBag.final_state = 'incomplete'
            return json(res, 502, {
              error: { type: 'upstream_protocol_error', code: error.code, message: error.message },
            })
          }
          return json(res, 200, assembledOut)
        }
        if (useGoEgress) {
          const tc = await transcodeWithProtoFront({
            cfg: cfg || { paths: { project: projectRoot } },
            upstreamProtocol: 'openai.responses',
            inboundProtocol: protocol,
            model: converted.body.model,
            stream: true,
            payload: chunks.join(''),
          })
          if (!res.headersSent) writeSSEHeaders(res)
          if (tc?.ok && tc.body) res.write(tc.body)
          return res.end()
        }
        if (!res.headersSent) writeSSEHeaders(res)
        return res.end()
      }

      if (!policyRefusal && isCodexGrantDead(result)) {
        try {
          persistCodexCredentialState(projectRoot, vm.id, { error: 'oauth_revoked' })
          markCodexGrantDead(projectRoot, vm.id, {
            description: result?.body?.error?.message || result?.body?.error?.code || null,
            status: Number(result.status) || 0,
          })
          rt.enqueueTelemetry?.([
            {
              node_key: formatNodeKey('codex_vm', vm.id),
              schedulable: false,
              unschedulable_reason: 'oauth_revoked',
            },
          ])
        } catch {}
      }

      if (policyRefusal && policyRefusal !== 'upstream:billing_refusal') {
        await releaseActiveLeaseNow({ outcome: 'ok', http_status: Number(result?.status) || 400 })
        stats.errors++
        const error = upstreamRiskClientError(policyRefusal, res._kinRequestId)
        logBag.error_code = error.body.error.code
        logBag.upstream_status = result?.status ?? null
        if (!res.headersSent && !hopEmitted) return json(res, error.status, error.body)
        if (protocol === 'anthropic.messages') res.write(buildAnthropicSseError(error.body.error))
        else if (protocol !== 'openai.responses') res.write(`data: ${JSON.stringify(error.body)}\n\n`)
        return res.end()
      }

      const failureReport = buildCodexFailureReport(result)
      if (res.headersSent || hopEmitted) {
        await releaseActiveLeaseNow({
          outcome: failureReport.error_class === 'timeout' ? 'timeout' : 'error',
          http_status: failureReport.http_status || undefined,
          error_class: failureReport.error_class,
          error_signature: failureReport.error_signature,
          error_message: failureReport.error_message,
          retry_after_sec: failureReport.retry_after_sec,
        })
        stats.errors++
        logBag.error_code = result?.body?.error?.code || 'codex_upstream'
        logBag.upstream_status = result?.status || 0
        logBag.final_state = result?.terminalState || 'incomplete'
        if (stream) return res.end()
        return json(res, result?.status >= 400 ? result.status : 502, result?.body)
      }

      if (!policyRefusal && isCodexFailoverError(result)) {
        const sw = await switchCodexNode(failureReport)
        if (sw.ok) continue
        if (sw.aborted) {
          logBag.final_state = 'cancelled'
          return
        }
        if (sw.fatalErr) return respondCodexSchedulerError({ res, json, stats, logBag, err: sw.fatalErr })
        break
      }

      await releaseActiveLeaseNow({
        outcome: failureReport.error_class === 'timeout' ? 'timeout' : 'error',
        http_status: failureReport.http_status || undefined,
        error_class: failureReport.error_class,
        error_signature: failureReport.error_signature,
        error_message: failureReport.error_message,
        retry_after_sec: failureReport.retry_after_sec,
      })
      break
    }
  } finally {
    if (activeLeaseId) {
      await releaseActiveLeaseNow({
        outcome: gone.signal.aborted ? 'aborted' : activeCommitted ? 'ok' : 'error',
      })
    }
    gone.settle()
  }

  stats.errors++
  logBag.error_code = last?.body?.error?.code || 'codex_upstream'
  logBag.error_message ||= last?.body?.error?.message || null
  logBag.upstream_status = last?.status || 0
  return json(res, last?.status || 502, last?.body || { error: { type: 'api_error', code: 'codex_upstream' } })
}

const CODEX_SEARCH_TIMEOUT_MS = 120000
const CODEX_SEARCH_DROP_FIELDS = Object.freeze(['prompt_cache_key', 'prompt_cache_retention', 'store'])
const searchRefreshes = new Map()

function searchCredentials(projectRoot, vm) {
  const first = readCodexAccounts(projectRoot, vm.id)[0] || {}
  return {
    first,
    access: String(first.access_token || vm.codex?.access_token || '').trim(),
    refresh: String(first.refresh_token || vm.codex?.refresh_token || '').trim(),
    accountId: String(first.chatgpt_account_id || vm.codex?.chatgpt_account_id || '').trim(),
  }
}

function refreshSearchAccess(projectRoot, vm, usedAccess, { proxyUrl, fetchImpl, refresh }) {
  const now = searchCredentials(projectRoot, vm)
  if (now.access && now.access !== usedAccess) return now.access
  if (!now.refresh) return ''
  let pending = searchRefreshes.get(vm.id)
  if (!pending) {
    pending = withCredentialRefreshLock(`codex:${vm.id}`, async () => {
      const again = searchCredentials(projectRoot, vm)
      if (again.access && again.access !== usedAccess) return again.access
      const tok = await refresh({ refreshToken: again.refresh || now.refresh, proxyUrl, fetchImpl })
      if (!tok?.ok && tok?.error === 'oauth_revoked') return `grant-dead:${tok.error}`
      if (!tok?.ok || !tok.access_token) return ''
      const latest = readCodexAccounts(projectRoot, vm.id)[0] || {}
      if (latest.refresh_token && latest.refresh_token !== (again.refresh || now.refresh)) {
        return latest.access_token || tok.access_token
      }
      upsertCodexAccount(projectRoot, vm.id, {
        access_token: tok.access_token,
        refresh_token: tok.refresh_token || again.refresh || now.refresh,
        id_token: tok.id_token || latest.id_token || now.first.id_token,
        expires_at: tok.expires_at || latest.expires_at || now.first.expires_at,
      })
      return tok.access_token
    }).finally(() => searchRefreshes.delete(vm.id))
    searchRefreshes.set(vm.id, pending)
  }
  return pending
}

function plainHeaders(headers) {
  if (typeof headers?.entries === 'function') return Object.fromEntries(headers.entries())
  return { ...(headers || {}) }
}

async function postCodexJson({
  url,
  timeoutMs,
  projectRoot,
  vm,
  body,
  turnMetadata,
  extraHeaders = {},
  fetchImpl,
  refresh = refreshCodexAccessToken,
}) {
  const proxyUrl = hostProxyUrlForVm(vm)
  if (!fetchImpl && !proxyUrl && !isLocalEgressProxy(vm.proxy)) return { status: 0, error: 'proxy_required' }
  const doFetch = fetchImpl || makeProxyFetch(proxyUrl, timeoutMs, { maxMs: timeoutMs })
  const creds = searchCredentials(projectRoot, vm)
  const send = async (access) => {
    const headers = {
      authorization: `Bearer ${access}`,
      'content-type': 'application/json',
      accept: 'application/json',
      originator: CODEX_CATALOG_ORIGINATOR,
      'user-agent': CODEX_USER_AGENT,
      version: CODEX_APP_VERSION,
    }
    if (creds.accountId) headers['chatgpt-account-id'] = creds.accountId
    if (turnMetadata) headers['x-codex-turn-metadata'] = turnMetadata
    Object.assign(headers, extraHeaders)
    try {
      const res = await doFetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
      return {
        status: Number(res?.status) || 0,
        text: await res.text(),
        headers: plainHeaders(res?.headers),
        accountId: creds.accountId,
      }
    } catch (e) {
      return { status: 0, error: /abort/i.test(`${e?.name} ${e?.message}`) ? 'upstream_timeout' : 'upstream_transport' }
    }
  }
  if (!creds.access && !creds.refresh) return { status: 0, error: 'no_oauth_token' }
  let out = creds.access ? await send(creds.access) : { status: 401 }
  if (out.status === 401 || out.status === 403) {
    const access = await refreshSearchAccess(projectRoot, vm, creds.access, { proxyUrl, fetchImpl, refresh })
    if (typeof access === 'string' && access.startsWith('grant-dead:')) {
      try {
        persistCodexCredentialState(projectRoot, vm.id, { error: 'oauth_revoked' })
        markCodexGrantDead(projectRoot, vm.id, { description: 'token endpoint answered revocation', status: 401 })
      } catch {}
      return { status: 401, error: 'oauth_revoked', grantDead: true, accountId: creds.accountId }
    }
    if (access) out = await send(access)
  }
  return out
}

function postCodexSearch(args) {
  return postCodexJson({ ...args, url: CODEX_SEARCH_URL, timeoutMs: CODEX_SEARCH_TIMEOUT_MS })
}

function isSearchFailover(out) {
  const status = Number(out?.status) || 0
  return status === 0 || status === 401 || status === 402 || status === 403 || status === 429 || status >= 500
}

export function parkCodexGrantDeadIfHit(projectRoot, vmId, last) {
  if (Number(last?.status) !== 401) return
  const parsed = parseJson(last.text)
  if (!isCodexGrantDead({ ok: false, status: last.status, body: parsed || null })) return
  try {
    persistCodexCredentialState(projectRoot, vmId, { error: 'oauth_revoked' })
    markCodexGrantDead(projectRoot, vmId, {
      description: parsed?.error?.message || parsed?.error?.code || null,
      status: last.status,
    })
  } catch {}
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export async function handleCodexSearch({
  req,
  res,
  body,
  logBag,
  stats,
  json,
  routing = {},
  projectRoot,
  ops = {},
  keyScope = null,
  ownerScope = null,
  poolAccess = null,
  originPoolId = null,
  schedulerRuntime = null,
}) {
  logBag.via = 'codex-search'
  const reject = (status, type, code, message) => {
    stats.errors++
    logBag.error_code = code
    return json(res, status, { error: { type, code, message } })
  }
  const codex = normalizeCodexRouting(routing.codex)
  if (!codex.enabled) return reject(400, 'invalid_request_error', 'codex_disabled', 'Codex routing is disabled')
  const restriction = restrictCodexClient(req.headers, body, { codex }, 'openai.search')
  if (!restriction.ok) return reject(403, 'permission_error', restriction.code, restriction.message)
  if (!body || typeof body !== 'object' || typeof body.model !== 'string' || !body.model.trim()) {
    return reject(400, 'invalid_request_error', 'model_required', 'model is required')
  }
  const preCheck = validateCodexPreconditions({
    projectRoot,
    req,
    keyScope,
    ownerScope,
    pinVmId: null,
    model: body.model,
    res,
    json,
    stats,
    logBag,
  })
  if (!preCheck.ok) return

  const rt = schedulerRuntime || req?._schedulerRuntime || null
  if (!rt) {
    return respondCodexSchedulerError({
      res,
      json,
      stats,
      logBag,
      err: new SchedulerUnavailableError('Rust scheduler runtime is unavailable for Codex search', {
        reason: 'runtime_missing',
      }),
    })
  }

  const outbound = { ...body }
  for (const key of CODEX_SEARCH_DROP_FIELDS) delete outbound[key]
  const turnMetadata = headerString(req.headers, 'x-codex-turn-metadata')
  const redactionState = await ensureRedaction(routing, { projectRoot })
  const redaction = redactionState.enabled
    ? {
        maxBodyBytes: redactionState.maxBodyBytes,
        principal: req.apiKeyRecord?.id || (req.apiKeyKind === 'master' ? 'master' : ''),
        session: String(req.headers?.['x-session-id'] || ''),
      }
    : null
  if (redaction) Object.assign(outbound, await maskJson(outbound, redaction))

  const post = ops.postCodexSearch || postCodexSearch
  const effectivePoolAccess = poolAccess || req?._poolAccess || null
  const isSearchManagedPool = Boolean(effectivePoolAccess && effectivePoolAccess.legacy === false)
  const baseAcquireParams = {
    requestId: crypto.randomUUID(),
    originPoolId:
      originPoolId ||
      effectivePoolAccess?.originPool?.id ||
      effectivePoolAccess?.effectivePool?.id ||
      preCheck.scope?.vm_pool_id ||
      VIRTUAL_POOL_IDS.codex,
    apiKeyRecord: req.apiKeyRecord || null,
    apiKeyKind: req.apiKeyKind || null,
    poolAccess: effectivePoolAccess,
    ownerScope: preCheck.owner,
    allowedNodeKeys:
      !isSearchManagedPool && Array.isArray(preCheck.scope?.allowed_vms) && preCheck.scope.allowed_vms.length > 0
        ? preCheck.scope.allowed_vms.map((id) => formatNodeKey('codex_vm', id))
        : undefined,
    nodeTypes: ['codex_vm'],
    model: outbound.model,
    modelFamily: 'openai',
    protocol: 'openai.search',
    sessionId: crypto.randomUUID(),
    isEphemeralProbe: true,
    noQueue: !queueAllowedByHeaders(req.headers),
  }

  const excludedNodeKeys = new Set()
  const gone = clientGoneSignal(req, res)
  let activeLeaseId = null
  let activeVmId = null
  let last = null
  let attempts = 0
  const maxSwitches = codexFailoverBudget(routing).maxSwitches

  const releaseActiveLeaseNow = async (payload) => {
    const lid = activeLeaseId
    activeLeaseId = null
    if (!lid) return
    try {
      await rt.releaseLease(lid, payload)
    } catch {}
  }

  try {
    let acquired
    try {
      acquired = await rt.acquireNode(
        { ...baseAcquireParams, attemptNo: 1, excludeNodes: [...excludedNodeKeys] },
        { signal: gone.signal },
      )
    } catch (err) {
      if (isAbortErr(err, gone.signal)) {
        logBag.final_state = 'cancelled'
        return
      }
      return respondCodexSchedulerError({ res, json, stats, logBag, err })
    }
    activeLeaseId = acquired.lease_id
    activeVmId = String(acquired.selected_node?.node_id || '')

    for (;;) {
      const vm = getVm(projectRoot, activeVmId)
      excludedNodeKeys.add(formatNodeKey('codex_vm', activeVmId))
      if (!vm || !isCodexVm(vm)) {
        const prev = activeLeaseId
        activeLeaseId = null
        try {
          const sw = await rt.switchNode(
            {
              release_lease_id: prev,
              failure: { http_status: 503, error_class: 'server5xx', error_signature: 'codex_vm_missing' },
              next_attempt: { ...baseAcquireParams, attemptNo: attempts + 1, excludeNodes: [...excludedNodeKeys] },
            },
            { signal: gone.signal },
          )
          activeLeaseId = sw.lease_id
          activeVmId = String(sw.selected_node?.node_id || '')
          continue
        } catch (err) {
          if (isAbortErr(err, gone.signal)) {
            logBag.final_state = 'cancelled'
            return
          }
          if (err instanceof SchedulerUnavailableError || err?.code === 'scheduler_unavailable') {
            return respondCodexSchedulerError({ res, json, stats, logBag, err })
          }
          if (last) break
          return respondCodexSchedulerError({ res, json, stats, logBag, err })
        }
      }

      if (!attempts) {
        stats.requests++
        stats.by_route['openai.search'] = (stats.by_route['openai.search'] || 0) + 1
      }
      attempts += 1
      logBag.vm_id = vm.id
      logBag.account_id = vm.id
      logBag.attempt_count = attempts
      last = await post({
        projectRoot,
        vm,
        body: outbound,
        turnMetadata,
        fetchImpl: ops.fetchImpl,
        refresh: ops.refresh,
      })
      logBag.usage_account_id = openaiUsageAccountId(last.accountId)
      logBag.upstream_status = last.status || null
      const parsedBody = parseJson(last.text)
      ingestCodexHop(projectRoot, vm.id, {
        ok: last.status >= 200 && last.status < 300,
        status: last.status,
        headers: last.headers || {},
        body: parsedBody,
      })
      parkCodexGrantDeadIfHit(projectRoot, vm.id, last)

      if (!isSearchFailover(last)) {
        await rt.commitLease(activeLeaseId).catch(() => {})
        await releaseActiveLeaseNow({ outcome: 'ok', http_status: last.status || 200 })
        break
      }

      const failureReport = buildCodexFailureReport({
        status: last.status,
        body: parsedBody,
        headers: last.headers,
        error: last.error,
        grantDead: last.grantDead,
      })
      if (attempts > maxSwitches) {
        await releaseActiveLeaseNow({
          outcome: failureReport.error_class === 'timeout' ? 'timeout' : 'error',
          http_status: failureReport.http_status || undefined,
          error_class: failureReport.error_class,
          error_signature: failureReport.error_signature,
          error_message: failureReport.error_message,
          retry_after_sec: failureReport.retry_after_sec,
        })
        break
      }

      const prevLeaseId = activeLeaseId
      activeLeaseId = null
      try {
        const sw = await rt.switchNode(
          {
            release_lease_id: prevLeaseId,
            failure: failureReport,
            next_attempt: {
              ...baseAcquireParams,
              attemptNo: attempts + 1,
              excludeNodes: [...excludedNodeKeys],
            },
          },
          { signal: gone.signal },
        )
        activeLeaseId = sw.lease_id
        activeVmId = String(sw.selected_node?.node_id || '')
      } catch (switchErr) {
        if (isAbortErr(switchErr, gone.signal)) {
          logBag.final_state = 'cancelled'
          return
        }
        if (
          switchErr instanceof SchedulerUnavailableError ||
          switchErr?.code === 'scheduler_unavailable' ||
          (switchErr instanceof SchedulerApiError && (switchErr.code === 'poison_abort' || switchErr.status === 422))
        ) {
          return respondCodexSchedulerError({ res, json, stats, logBag, err: switchErr })
        }
        break
      }
    }
  } finally {
    if (activeLeaseId) {
      await releaseActiveLeaseNow({ outcome: gone.signal.aborted ? 'aborted' : 'error' })
    }
    gone.settle()
  }

  if (!last || !last.status) {
    logBag.final_state = 'upstream_error'
    return reject(502, 'api_error', last?.error || 'upstream_transport', 'Codex search upstream request failed')
  }
  const payload = parseJson(last.text)
  if (payload === undefined) {
    logBag.final_state = 'upstream_error'
    return reject(
      502,
      'api_error',
      'upstream_invalid_body',
      `Codex search upstream answered ${last.status} without JSON`,
    )
  }
  logBag.final_state = last.status < 300 ? 'verified' : 'upstream_error'
  if (last.status >= 400) {
    stats.errors++
    logBag.error_code = payload?.error?.code || `upstream_${last.status}`
  }
  const responseBody = redaction ? await restoreJsonValue(payload, redaction) : payload
  return json(res, last.status, responseBody)
}

const CODEX_IMAGES_TIMEOUT_MS = 600000
const CODEX_IMAGES_URLS = Object.freeze({
  generations: CODEX_IMAGE_GENERATIONS_URL,
  edits: CODEX_IMAGE_EDITS_URL,
})

function isFreePlanSlot(projectRoot, vm) {
  const plan = vm?.codex?.plan_type || readCodexAccounts(projectRoot, vm.id)[0]?.chatgpt_plan_type || ''
  return String(plan).trim().toLowerCase() === 'free'
}

export async function handleCodexImages({
  req,
  res,
  kind,
  body,
  logBag,
  stats,
  json,
  routing = {},
  projectRoot,
  ops = {},
  keyScope = null,
  ownerScope = null,
  poolAccess = null,
  originPoolId = null,
  schedulerRuntime = null,
}) {
  logBag.via = 'codex-images'
  const reject = (status, type, code, message) => {
    stats.errors++
    logBag.error_code = code
    return json(res, status, { error: { type, code, message } })
  }
  const codex = normalizeCodexRouting(routing.codex)
  if (!codex.enabled) return reject(400, 'invalid_request_error', 'codex_disabled', 'Codex routing is disabled')
  const restriction = restrictCodexClient(req.headers, body, { codex }, 'openai.images')
  if (!restriction.ok) return reject(403, 'permission_error', restriction.code, restriction.message)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return reject(400, 'invalid_request_error', 'invalid_request', 'Images request body must be a JSON object')
  }
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (model) {
    logBag.image_model = canonicalImageToolModel(model) || model
    if (isImageToolModelEnabled(model) === false) {
      return reject(
        400,
        'invalid_request_error',
        'model_disabled',
        `image model '${model}' is disabled by gateway GPT model policy`,
      )
    }
  }
  const preCheck = validateCodexPreconditions({
    projectRoot,
    req,
    keyScope,
    ownerScope,
    pinVmId: null,
    model,
    res,
    json,
    stats,
    logBag,
  })
  if (!preCheck.ok) return

  const effectivePoolAccess = poolAccess || req?._poolAccess || null
  const isImageManagedPool = Boolean(effectivePoolAccess && effectivePoolAccess.legacy === false)
  const hasFallbackPool = Boolean(isImageManagedPool && effectivePoolAccess?.effectivePool?.fallback_pool_id)
  const excludedNodeKeys = new Set()
  let usable = 0
  let freeExcluded = 0
  for (const item of listVms(projectRoot)) {
    if (!isCodexVm(item)) continue
    if (preCheck.owner && !vmMatchesOwnerScope(item, preCheck.owner)) continue
    const inOriginScope = keyAllowsVm(preCheck.scope, item)
    if (isFreePlanSlot(projectRoot, getVm(projectRoot, item.id) || item)) {
      // Exclude Free-plan slots globally across origin and any Stage 4 fallback pools.
      excludedNodeKeys.add(formatNodeKey('codex_vm', item.id))
      if (inOriginScope) freeExcluded += 1
    } else if (inOriginScope) {
      usable += 1
    }
  }
  if (!usable && freeExcluded > 0 && !hasFallbackPool) {
    return reject(
      403,
      'permission_error',
      'image_generation_unavailable',
      'Image generation is not available on Free-plan GPT slots',
    )
  }

  const rt = schedulerRuntime || req?._schedulerRuntime || null
  if (!rt) {
    return respondCodexSchedulerError({
      res,
      json,
      stats,
      logBag,
      err: new SchedulerUnavailableError('Rust scheduler runtime is unavailable for Codex images', {
        reason: 'runtime_missing',
      }),
    })
  }

  const turnMetadata = headerString(req.headers, 'x-codex-turn-metadata')
  const imageTurnId = headerString(req.headers, 'x-codex-image-turn-id')
  const extraHeaders = imageTurnId ? { 'x-codex-image-turn-id': imageTurnId } : {}
  const redactionState = await ensureRedaction(routing, { projectRoot })
  const redaction = redactionState.enabled
    ? {
        maxBodyBytes: redactionState.maxBodyBytes,
        principal: req.apiKeyRecord?.id || (req.apiKeyKind === 'master' ? 'master' : ''),
        session: String(req.headers?.['x-session-id'] || ''),
      }
    : null
  const outboundBody = redaction ? await maskJson(body, redaction) : body
  const post = ops.postCodexJson || postCodexJson

  const baseAcquireParams = {
    requestId: crypto.randomUUID(),
    originPoolId:
      originPoolId ||
      effectivePoolAccess?.originPool?.id ||
      effectivePoolAccess?.effectivePool?.id ||
      preCheck.scope?.vm_pool_id ||
      VIRTUAL_POOL_IDS.codex,
    apiKeyRecord: req.apiKeyRecord || null,
    apiKeyKind: req.apiKeyKind || null,
    poolAccess: effectivePoolAccess,
    ownerScope: preCheck.owner,
    allowedNodeKeys:
      !isImageManagedPool && Array.isArray(preCheck.scope?.allowed_vms) && preCheck.scope.allowed_vms.length > 0
        ? preCheck.scope.allowed_vms.map((id) => formatNodeKey('codex_vm', id))
        : undefined,
    nodeTypes: ['codex_vm'],
    model: model || '',
    modelFamily: 'openai',
    protocol: 'openai.images',
    sessionId: imageTurnId ? deterministicUuidFromSeed(`codex-image-turn:${imageTurnId}`) : crypto.randomUUID(),
    isEphemeralProbe: !imageTurnId,
    noQueue: !queueAllowedByHeaders(req.headers),
  }

  const gone = clientGoneSignal(req, res)
  let activeLeaseId = null
  let activeVmId = null
  let last = null
  let attempts = 0
  const maxSwitches = codexFailoverBudget(routing).maxSwitches

  const releaseActiveLeaseNow = async (payload) => {
    const lid = activeLeaseId
    activeLeaseId = null
    if (!lid) return
    try {
      await rt.releaseLease(lid, payload)
    } catch {}
  }

  try {
    let acquired
    try {
      acquired = await rt.acquireNode(
        { ...baseAcquireParams, attemptNo: 1, excludeNodes: [...excludedNodeKeys] },
        { signal: gone.signal },
      )
    } catch (err) {
      if (isAbortErr(err, gone.signal)) {
        logBag.final_state = 'cancelled'
        return
      }
      return respondCodexSchedulerError({ res, json, stats, logBag, err })
    }
    activeLeaseId = acquired.lease_id
    activeVmId = String(acquired.selected_node?.node_id || '')

    for (;;) {
      const vm = getVm(projectRoot, activeVmId)
      excludedNodeKeys.add(formatNodeKey('codex_vm', activeVmId))
      if (!vm || !isCodexVm(vm)) {
        const prev = activeLeaseId
        activeLeaseId = null
        try {
          const sw = await rt.switchNode(
            {
              release_lease_id: prev,
              failure: { http_status: 503, error_class: 'server5xx', error_signature: 'codex_vm_missing' },
              next_attempt: { ...baseAcquireParams, attemptNo: attempts + 1, excludeNodes: [...excludedNodeKeys] },
            },
            { signal: gone.signal },
          )
          activeLeaseId = sw.lease_id
          activeVmId = String(sw.selected_node?.node_id || '')
          continue
        } catch (err) {
          if (isAbortErr(err, gone.signal)) {
            logBag.final_state = 'cancelled'
            return
          }
          if (err instanceof SchedulerUnavailableError || err?.code === 'scheduler_unavailable') {
            return respondCodexSchedulerError({ res, json, stats, logBag, err })
          }
          if (last) break
          return respondCodexSchedulerError({ res, json, stats, logBag, err })
        }
      }

      if (!attempts) {
        stats.requests++
        stats.by_route['openai.images'] = (stats.by_route['openai.images'] || 0) + 1
      }
      attempts += 1
      logBag.vm_id = vm.id
      logBag.account_id = vm.id
      logBag.attempt_count = attempts
      last = await post({
        url: CODEX_IMAGES_URLS[kind] || CODEX_IMAGE_GENERATIONS_URL,
        timeoutMs: CODEX_IMAGES_TIMEOUT_MS,
        projectRoot,
        vm,
        body: outboundBody,
        turnMetadata,
        extraHeaders,
        fetchImpl: ops.fetchImpl,
        refresh: ops.refresh,
      })
      logBag.usage_account_id = openaiUsageAccountId(last.accountId)
      logBag.upstream_status = last.status || null
      const parsedBody = parseJson(last.text)
      ingestCodexHop(projectRoot, vm.id, {
        ok: last.status >= 200 && last.status < 300,
        status: last.status,
        headers: last.headers || {},
        body: parsedBody,
      })
      parkCodexGrantDeadIfHit(projectRoot, vm.id, last)

      if (!isSearchFailover(last)) {
        await rt.commitLease(activeLeaseId).catch(() => {})
        await releaseActiveLeaseNow({ outcome: 'ok', http_status: last.status || 200 })
        break
      }

      const failureReport = buildCodexFailureReport({
        status: last.status,
        body: parsedBody,
        headers: last.headers,
        error: last.error,
        grantDead: last.grantDead,
      })
      if (attempts > maxSwitches) {
        await releaseActiveLeaseNow({
          outcome: failureReport.error_class === 'timeout' ? 'timeout' : 'error',
          http_status: failureReport.http_status || undefined,
          error_class: failureReport.error_class,
          error_signature: failureReport.error_signature,
          error_message: failureReport.error_message,
          retry_after_sec: failureReport.retry_after_sec,
        })
        break
      }

      const prevLeaseId = activeLeaseId
      activeLeaseId = null
      try {
        const sw = await rt.switchNode(
          {
            release_lease_id: prevLeaseId,
            failure: failureReport,
            next_attempt: {
              ...baseAcquireParams,
              attemptNo: attempts + 1,
              excludeNodes: [...excludedNodeKeys],
            },
          },
          { signal: gone.signal },
        )
        activeLeaseId = sw.lease_id
        activeVmId = String(sw.selected_node?.node_id || '')
      } catch (switchErr) {
        if (isAbortErr(switchErr, gone.signal)) {
          logBag.final_state = 'cancelled'
          return
        }
        if (
          switchErr instanceof SchedulerUnavailableError ||
          switchErr?.code === 'scheduler_unavailable' ||
          (switchErr instanceof SchedulerApiError && (switchErr.code === 'poison_abort' || switchErr.status === 422))
        ) {
          return respondCodexSchedulerError({ res, json, stats, logBag, err: switchErr })
        }
        break
      }
    }
  } finally {
    if (activeLeaseId) {
      await releaseActiveLeaseNow({ outcome: gone.signal.aborted ? 'aborted' : 'error' })
    }
    gone.settle()
  }

  if (!last || !last.status) {
    logBag.final_state = 'upstream_error'
    return reject(502, 'api_error', last?.error || 'upstream_transport', 'Codex images upstream request failed')
  }
  const payload = parseJson(last.text)
  if (payload === undefined) {
    logBag.final_state = 'upstream_error'
    return reject(
      502,
      'api_error',
      'upstream_invalid_body',
      `Codex images upstream answered ${last.status} without JSON`,
    )
  }
  logBag.final_state = last.status < 300 ? 'verified' : 'upstream_error'
  if (last.status >= 400) {
    stats.errors++
    logBag.error_code = payload?.error?.code || `upstream_${last.status}`
  } else if (payload?.usage && typeof payload.usage === 'object') {
    logBag.image_usage = payload.usage
  }
  const responseBody = redaction ? await restoreJsonValue(payload, redaction) : payload
  return json(res, last.status, responseBody)
}
