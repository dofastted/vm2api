/**
 * Codex hop from handle-protocol. Claude convert/pool/CRS never runs here.
 */
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import fetch from 'node-fetch'
import { isKubernetesMode } from '../core/control-plane-mode.mjs'
import { SharedCodexRuntime } from '../pool/shared-codex-runtime.mjs'
import { getVm, listVms, persistCodexUsage, syncCodexQuotaSchedule } from '../vm/vm-registry.mjs'
import { isValidVmId } from '../vm/vm-file.mjs'
import { isCodexProtocolAllowed, isCodexVm, normalizeCodexRouting } from './codex-route.mjs'
import { keyAllowsVm, keyScopeFromRequest, vmPoolDenial } from '../admin/key-scope.mjs'
import { normalizeOpenAIQuotaPolicy } from '../pool/openai-quota-policy.mjs'
import { restrictCodexClient } from './codex-restriction.mjs'
import {
  responsesSseToChatChunk,
  responsesSseToAnthropicEvents,
  createAnthropicSseState,
  createResponsesSseEventNamer,
  assembleCodexBodyFromSse,
  codexBodyToAnthropicMessage,
  isToolArgumentsError,
  toCodexResponses,
} from './codex-convert.mjs'
import {
  extraFromCodexHeaders,
  codexCreditsFromHeaders,
  codexQuotaPark,
  CODEX_DEFAULT_PARK_MS,
} from './codex-usage.mjs'
import { extractOpenaiUsage, openaiAnthropicUsageFromExtract, disjointOpenaiUsage } from './openai-usage.mjs'
import { streamCodexKernel } from '../transport/codex-kernel-client.mjs'
import {
  codexKernelRequestOptions,
  ensureCodexKernel,
  writeCodexKernelConfig,
} from '../transport/codex-kernel-supervisor.mjs'
import { isLocalEgressProxy } from '../vm/egress.mjs'
import { vmNodeId } from '../cluster/placement.mjs'
import { hostProxyUrlForVm } from '../vm/slot-host.mjs'
import { createProxyAgent } from '../vm/proxy-agent.mjs'
import { readCodexAccounts, upsertCodexAccount } from '../vm/codex-slot.mjs'
import { scopeAccountFromVm } from './jev-intercept.mjs'
import {
  CODEX_APP_VERSION,
  CODEX_CATALOG_ORIGINATOR,
  CODEX_SEARCH_URL,
  CODEX_USER_AGENT,
  refreshCodexAccessToken,
} from './codex-models.mjs'
import { orderCodexSessionSlots, codexSlotAllowsModel, isCodexFailoverError } from '../pool/codex-slot-pool.mjs'
import {
  holdOpenAIAccount,
  reportOpenAIAttempt,
  tryAcquireOpenAISlot,
  waitForOpenAICapacity,
  wakeOpenAIWaiter,
} from '../pool/openai-account-runtime.mjs'
import { CLIENT_POOL_BUSY_MESSAGE, CLIENT_POOL_UNAVAILABLE_MESSAGE, ErrorCode } from '../core/errors.mjs'
import { applyOpenaiWashLog } from './openai-wash.mjs'
import { sessionIdForLog } from './log-fields.mjs'
import { redactHeaders } from '../admin/request-log.mjs'
import {
  extractCallerSession,
  extractFirstUserIdentity,
  firstUserIdentityText,
  outboundSessionMode,
  resolveOutboundSessionId,
} from '../identity/identity-rewrite.mjs'
import { clientIp } from '../pool/sticky-router.mjs'

// Official Codex client headers for ChatGPT Responses. Auth is attached by the kernel.
const CODEX_KERNEL_HEADER_ALLOWLIST = Object.freeze([
  'originator',
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
      code === '' || /server_error|provider_error|upstream_error|overloaded_error|internal_error|transport/i.test(code)
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

function pinnedVmId(req) {
  const pinVmRaw = String(req?.headers?.['x-kin-vm'] || '').trim()
  if (req?.apiKeyKind !== 'master') return null
  return isValidVmId(pinVmRaw) ? pinVmRaw : null
}

/**
 * Current OpenAI candidates, re-read on every admission. A busy home keeps
 * its pin; only a home that left the pool for good releases the session.
 * A request that continues a stored response (`previous_response_id`) can
 * only run where that response lives.
 */
export async function pickCodexCandidates(
  projectRoot,
  req,
  { stickyRouter = null, sessions = null, body = null, excluded = null, routing = {}, sharedRuntime = null } = {},
) {
  const pin = pinnedVmId(req)
  const model = body?.model || null
  const snapshot = sharedRuntime ? await sharedRuntime.routingSnapshot(routing) : null
  const liveRouting = snapshot?.config || routing
  const routingPolicy = normalizeCodexRouting(liveRouting.codex || liveRouting).quota
  const withPolicy = (ordered) =>
    sharedRuntime
      ? {
          ...ordered,
          quotaPolicy: routingPolicy,
          candidates: (ordered.candidates || []).map((candidate) => ({
            ...candidate,
            routingRevision: snapshot.revision,
          })),
        }
      : ordered
  const scope = await keyScopeFromRequest(req)
  const poolDenial = vmPoolDenial(scope)
  if (poolDenial) return { error: 'vm_pool_unavailable', message: poolDenial.message, ids: [], candidates: [] }
  if (scope.group_type === 'anthropic') return { error: 'key_group_mismatch', ids: [], candidates: [] }
  if (pin) {
    const vm = getVm(projectRoot, pin)
    if (!vm || !isCodexVm(vm)) return { error: 'platform_mismatch', pin, ids: [] }
    if (!keyAllowsVm(scope, vm)) return { error: 'key_group_mismatch', pin, ids: [] }
    if (!codexSlotAllowsModel(vm, model)) return { error: 'model_not_allowed', pin, ids: [] }
    const runtimeSignals = sharedRuntime ? await sharedRuntime.signals(projectRoot, [vm], routingPolicy) : null
    if (runtimeSignals && !runtimeSignals.has(vm.id))
      return { error: 'codex_account_identity_unavailable', ids: [], candidates: [] }
    const ordered = orderCodexSessionSlots([vm], {
      pin,
      excluded,
      quotaPolicy: routingPolicy,
      runtimeSignals,
    })
    return { ...withPolicy(ordered), pin, sticky: false, sessionKey: null, stickyKeys: [] }
  }
  for (const item of listVms(projectRoot, { codex: { quota: routingPolicy } })) {
    if (!isCodexVm(item)) continue
    syncCodexQuotaSchedule(projectRoot, getVm(projectRoot, item.id) || item, {
      policy: routingPolicy,
    })
  }
  if (stickyRouter?.shared) await stickyRouter.refresh()
  const stickyKeys = stickyRouter?.collectPoolKeys?.(req, body || {}, { platform: 'openai' }) || []
  const sessionKey = stickyRouter?.extractPoolKey?.(req, body || {}, { platform: 'openai' }) || stickyKeys[0] || null
  const stickyVersions = new Map(stickyKeys.map((key) => [key, stickyRouter?.shared ? stickyRouter.versionOf(key) : 0]))
  const bound = sessionKey ? stickyRouter?.resolve?.(sessionKey) : null
  let vms = listVms(projectRoot, { codex: { quota: routingPolicy } }).filter((vm) => keyAllowsVm(scope, vm))
  if (sharedRuntime) vms = vms.filter(isCodexVm)
  const runtimeSignals = sharedRuntime ? await sharedRuntime.signals(projectRoot, vms, routingPolicy) : null
  if (runtimeSignals) {
    const hadCandidates = vms.length > 0
    vms = vms.filter((vm) => runtimeSignals.has(vm.id))
    if (hadCandidates && !vms.length) return { error: 'codex_account_identity_unavailable', ids: [], candidates: [] }
  }
  const continuesResponse = !!body?.previous_response_id && !!bound?.vmId
  if (scope.vm_pool_id && vms.length === 0 && !continuesResponse) {
    return { error: 'vm_pool_unavailable', message: '账号池没有可调度的 GPT 槽位', ids: [], candidates: [] }
  }
  const ordered = orderCodexSessionSlots(continuesResponse ? vms.filter((vm) => vm.id === bound.vmId) : vms, {
    boundVmId: bound?.vmId || null,
    sessionKey,
    sessionLimit: sessions,
    model,
    excluded,
    quotaPolicy: routingPolicy,
    runtimeSignals,
  })
  // A resting home migrates the conversation like a gone one: the next slot rebinds it.
  const boundLeft = ordered.boundState === 'gone' || ordered.boundState === 'resting'
  if (bound?.vmId && sessionKey && boundLeft) {
    for (const key of stickyKeys.length ? stickyKeys : [sessionKey]) {
      if (stickyRouter?.shared) {
        const result = await stickyRouter.unbindShared(key, {
          ifGeneration: stickyVersions.get(key) ?? stickyRouter.versionOf(key),
        })
        if (!result.applied) return { error: 'sticky_binding_conflict', ids: [], candidates: [] }
        stickyVersions.set(key, result.generation)
      } else stickyRouter?.unbind?.(key)
    }
    try {
      sessions?.drop?.(bound.vmId, sessionKey)
    } catch {}
  }
  if (continuesResponse && (boundLeft || ordered.error === 'candidates_exhausted')) {
    return { error: 'response_not_portable', ids: [], sessionKey, stickyKeys, boundVmId: bound.vmId }
  }
  return { ...withPolicy(ordered), sessionKey, stickyKeys, ...(stickyRouter?.shared ? { stickyVersions } : {}) }
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

/**
 * Short process-local hold for an account that just failed upstream. This is
 * not the operator scheduling switch: it expires by itself and keeps the next
 * request from spending another turn on the same dead 401 / rate-limited
 * account. Committed streams and request-shaped errors are never parked.
 */
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
  if (status === 401) return { until: now + 5 * 60_000, reason: 'oauth_401' }
  if (status === 403) return { until: now + 5 * 60_000, reason: 'permission_denied' }
  if (status === 429) return { until: now + 60_000, reason: 'rate_limited' }
  if (status === 408 || status >= 500) return { until: now + 30_000, reason: 'upstream_5xx' }
  if (result.transportError === true || status === 0) return { until: now + 30_000, reason: 'transport_error' }
  return null
}

/** Idle SOCKS / first hop 502 is retryable only before any SSE byte is committed. */
/** `response.service_tier` from a Responses SSE data line, if present. */
export function serviceTierFromSseLine(line) {
  if (typeof line !== 'string' || !line.startsWith('data:') || !line.includes('service_tier')) return null
  try {
    const ev = JSON.parse(line.slice(5).trim())
    const tier = ev?.response?.service_tier ?? ev?.service_tier
    return typeof tier === 'string' && tier ? tier : null
  } catch {
    return null
  }
}

/** Responses `usage` object from one SSE data line, if it carries token counts. */
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

function usageTokens(usage) {
  const extracted = extractOpenaiUsage(usage)
  if (!extracted) return 0
  return (
    (extracted.input_tokens || 0) +
    (extracted.output_tokens || 0) +
    (extracted.cached_tokens || 0) +
    (extracted.cache_write_tokens || 0)
  )
}

function preferUsage(left, right) {
  if (usageTokens(right) > usageTokens(left)) return right
  return left || right || null
}

const WAIT_TIMEOUT_MIN_MS = 1000
const WAIT_TIMEOUT_MAX_MS = 120000
const DEFAULT_WAIT_TIMEOUT_MS = 30000

/** Same knob and clamp as the Claude pool's fallback wait. */
function codexWaitTimeoutMs(routing) {
  const n = Number(routing?.pool?.fallback_wait_timeout_ms)
  if (!Number.isFinite(n)) return DEFAULT_WAIT_TIMEOUT_MS
  return Math.min(WAIT_TIMEOUT_MAX_MS, Math.max(WAIT_TIMEOUT_MIN_MS, n))
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

/**
 * Admission = fresh candidates + one synchronous seat claim. Candidates are
 * re-read every round, so a seat taken while another request awaited kernel
 * init is never double-sold. All full: FIFO wait for a release or the RPM
 * window, up to the pool wait deadline.
 */
async function admitCodexCandidate(projectRoot, req, opts, { deadline, signal }) {
  let woken = false
  selection: for (;;) {
    const picked = await pickCodexCandidates(projectRoot, req, opts)
    const livePolicy = picked.quotaPolicy || normalizeCodexRouting(opts.routing?.codex || opts.routing).quota
    if (picked.error && picked.error !== 'capacity_unavailable') return { picked }
    for (const candidate of picked.candidates || []) {
      let lease
      try {
        lease = opts.sharedRuntime
          ? await opts.sharedRuntime.tryReserve(projectRoot, getVm(projectRoot, candidate.id), candidate, livePolicy)
          : tryAcquireOpenAISlot(candidate.id, {
              concurrency: candidate.concurrency,
              maxRpm: candidate.maxRpm,
              quotaPolicy: livePolicy,
            })
      } catch (error) {
        if (!opts.sharedRuntime || error?.code !== 'routing_config_stale') throw error
        if (signal?.aborted) return { picked: { error: 'client_cancelled', ids: [] } }
        if (Date.now() >= deadline) return { picked: { error: 'capacity_unavailable', ids: [] } }
        continue selection
      }
      if (lease) return { picked, vmId: candidate.id, lease }
    }
    // A woken waiter that still missed hands the wake to the next in line.
    if (woken) wakeOpenAIWaiter()
    const now = Date.now()
    if (now >= deadline) return { picked: { ...picked, error: 'capacity_unavailable', ids: [] } }
    const retryAt = Number(picked.retryAt)
    const sliceDeadline = opts.sharedRuntime
      ? Math.min(deadline, now + 250)
      : Number.isFinite(retryAt) && retryAt > now
        ? Math.min(deadline, retryAt)
        : deadline
    let waited
    try {
      waited = await waitForOpenAICapacity({ deadline: sliceDeadline, signal })
    } catch (error) {
      if (error?.code === 'pool_wait_queue_full') return { picked: { error: 'pool_wait_queue_full', ids: [] } }
      throw error
    }
    if (waited.aborted) return { picked: { error: 'client_cancelled', ids: [] } }
    woken = !!waited.woken
  }
}

// Observed with gpt-6-astra + Responses Lite, not a documented upstream limit.
// Keep the model gate tight until another Lite model shows the same 128 KiB failure.
// Retry only a failed full-history attempt, keeping the newest reasoning suffix.
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

export async function runCodexKernelHop({
  hop,
  args = {},
  onEvent,
  onReasoningFallback,
  sharedExecution = false,
} = {}) {
  let emitted = false
  const wrapped = async (line) => {
    emitted = true
    if (onEvent) await onEvent(line)
  }
  let sends = 0
  const send = (input) =>
    hop({
      ...input,
      ...(sharedExecution
        ? {
            requestId: sends++ === 0 && args.requestId != null ? args.requestId : randomUUID(),
          }
        : {}),
      onEvent: wrapped,
    })
  const canRetry = (value) => !sharedExecution || (value?.execution?.ended === true && !value?.executionUncertain)
  let result = await send(args)
  if (!result?.ok && !emitted && canRetry(result) && isRetryableCodexTransport(result)) {
    result = { ...(await send(args)), transport_retried: true }
  }
  const fallback =
    !emitted && !result?.transport_retried && canRetry(result) ? reasoningHistoryFallback(args, result) : null
  if (fallback) {
    if (onReasoningFallback)
      await onReasoningFallback({ originalResult: result, body: fallback.args.body, ...fallback.info })
    if (args.signal?.aborted) return result
    result = {
      ...(await send(fallback.args)),
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
  stickyRouter = null,
  sessions = null,
  body = null,
  captureOutbound = false,
  requestStartedAt = Date.now(),
  accountGate = null,
  onExecutionState = null,
}) {
  const codex = normalizeCodexRouting(routing.codex)
  const allowed = isCodexProtocolAllowed(protocol, { codex })
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
  const converted = toCodexResponses(protocol, ctx.body, codex.convert)
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
  const stream = inbound?.stream !== false && ctx.body?.stream !== false
  const inboundSession = sessionFrom(req, converted.body)
  const sessionMode = outboundSessionMode(routing)
  const callerSession = extractCallerSession({
    inbound: converted.body,
    body: converted.body,
    headers: req.headers,
  })
  // Chat→Responses conversion can surface a session key the raw inbound lacked.
  if (!logBag.session_id) logBag.session_id = sessionIdForLog(callerSession)
  const firstUserIdentity = firstUserIdentityFromCodex(converted.body)
  const sharedRuntime = ops.sharedRuntime || (isKubernetesMode() ? new SharedCodexRuntime() : null)
  const hop = ops.streamCodexKernel || streamCodexKernel
  const writeCfg = ops.writeCodexKernelConfig || writeCodexKernelConfig
  const ensure = ops.ensureCodexKernel || ensureCodexKernel
  const anthropicSse = protocol === 'anthropic.messages' ? createAnthropicSseState() : null
  const chatSse =
    protocol === 'openai.chat' || protocol === 'openai.completions'
      ? { id: 'codex', seq: 0, tools: new Map(), sawTool: false }
      : null
  const pickOpts = {
    stickyRouter,
    sessions,
    body: body || converted.body || inbound,
    excluded: new Set(),
    routing,
    sharedRuntime,
  }
  let deadline = Date.now() + codexWaitTimeoutMs(routing)
  const gone = clientGoneSignal(req, res)
  const failoverBudget = codexFailoverBudget(routing)
  const sameRetryDelay = Number(routing?.failover?.same_account_retry_delay_ms)
  const sameRetryDelayMs =
    Number.isFinite(sameRetryDelay) && sameRetryDelay >= 0 ? Math.min(10_000, sameRetryDelay) : 100
  logBag.via = 'codex-kernel'
  logBag.attempt_count = 0
  let last = null
  let hops = 0
  let attempts = 0
  let switches = 0
  let counted = false
  let turn = null
  let activeLease = null
  let executionUncertain = false
  try {
    if (sharedRuntime) {
      if (stickyRouter?.shared) await stickyRouter.refresh()
      const turnKey =
        stickyRouter?.extractPoolKey?.(req, pickOpts.body, { platform: 'openai' }) ||
        (callerSession ? `codex:${req.apiKeyRecord?.id || ''}:${callerSession}` : null)
      if (turnKey)
        turn = await sharedRuntime.turns.acquire(turnKey, {
          signal: gone.signal,
          requestId: logBag.request_id,
          timeoutMs: routing?.failover?.session_queue_timeout_ms ?? 900_000,
        })
      deadline = Date.now() + codexWaitTimeoutMs(routing)
    }
    for (;;) {
      if (executionUncertain)
        throw Object.assign(new Error('Codex execution termination is unknown'), { code: 'codex_execution_uncertain' })
      const admitted = await admitCodexCandidate(projectRoot, req, pickOpts, { deadline, signal: gone.signal })
      const picked = admitted.picked
      if (!admitted.lease) {
        if (picked.error === 'client_cancelled') {
          logBag.final_state = 'cancelled'
          return
        }
        // Real upstream failures already happened: report the last one, not the pool.
        if (last) break
        return rejectCodexAdmission({ res, json, stats, logBag, picked, model: converted.body?.model })
      }
      const vm = getVm(projectRoot, admitted.vmId)
      const lease = admitted.lease
      activeLease = lease
      if (!vm || !isCodexVm(vm)) {
        await lease.release()
        pickOpts.excluded.add(admitted.vmId)
        continue
      }
      attempts += 1
      if (attempts > failoverBudget.maxAttempts) {
        await lease.release()
        break
      }
      if (!counted) {
        counted = true
        stats.requests++
        stats.by_route[protocol] = (stats.by_route[protocol] || 0) + 1
      }
      // The slot is known here, so an account scope can be applied. `true`
      // means the 403 is already written.
      if (accountGate) {
        logBag.vm_id = vm.id
        const blocked = await accountGate(scopeAccountFromVm(vm))
        if (blocked) {
          await lease.release()
          return
        }
      }
      const stickyKeys = picked.stickyKeys?.length ? picked.stickyKeys : picked.sessionKey ? [picked.sessionKey] : []
      const stickyBound = picked.sessionKey ? stickyRouter?.resolve?.(picked.sessionKey) : null
      // The home (or first placement) owns the conversation window; a borrowed
      // seat elsewhere takes only this request's execution lease.
      const claimsWindow = !!picked.sessionKey && (!picked.home || picked.home === vm.id)
      let windowGen = null
      if (claimsWindow) {
        try {
          windowGen = sessions?.touch?.(vm.id, picked.sessionKey) ?? null
        } catch {}
      }
      let ownsPin = !!stickyBound?.vmId && stickyBound.vmId === vm.id
      const stickyVersions = picked.stickyVersions || new Map()
      const bindSticky = async (sessionId = null) => {
        if (!picked.sessionKey || !stickyRouter) return true
        const payload = { accountId: vm.id, vmId: vm.id }
        if (sessionId) payload.sessionId = sessionId
        for (const key of stickyKeys) {
          if (stickyRouter.shared) {
            const result = await stickyRouter.bindShared(key, payload, { ifGeneration: stickyVersions.get(key) ?? 0 })
            if (!result.applied || result.record?.vmId !== vm.id || result.nativeSessionId !== sessionId) return false
            stickyVersions.set(key, result.generation)
            ownsPin = true
          } else stickyRouter.bind?.(key, payload)
        }
        return true
      }
      const leaveSticky = async () => {
        if (!ownsPin || !picked.sessionKey) return
        try {
          sessions?.drop?.(vm.id, picked.sessionKey)
        } catch {}
        for (const key of stickyKeys) {
          if (stickyRouter?.shared) await stickyRouter.unbindShared(key, { ifGeneration: stickyVersions.get(key) ?? 0 })
          else stickyRouter?.unbind?.(key)
        }
      }
      let attemptKind = 'failed'
      try {
        const localExit = isLocalEgressProxy(vm.proxy)
        const written = writeCfg(projectRoot, vm, {
          // Same rule as slot start: a node on local egress must leave through
          // that node's forwarder, not the control plane's deployment proxy.
          proxyUrl: localExit && !vmNodeId(vm) ? '' : hostProxyUrlForVm(vm),
          proxyRequired: true,
          routing,
        })
        const ready = await ensure(execFor(projectRoot, vm))
        if (!ready?.ok) {
          // Kernel init failed: this seat goes back and the next candidate is re-admitted.
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
          pickOpts.excluded.add(vm.id)
          switches += 1
          if (!res.headersSent) {
            if (switches > failoverBudget.maxSwitches || attempts >= failoverBudget.maxAttempts) break
            continue
          }
          stats.errors++
          logBag.error_code = 'codex_kernel_unavailable'
          return json(res, 503, last.body)
        }
        hops += 1
        logBag.vm_id = vm.id
        logBag.attempt_count = hops
        const chunks = []
        const nameSseEvent = createResponsesSseEventNamer()
        let responseServiceTier = null
        let streamedUsage = null
        let conversionError = null
        const attemptStartedAt = Date.now()
        const sessionOptions = {
          boundSessionId: stickyBound?.sessionId || '',
          boundVmId: stickyBound?.vmId || '',
          vmId: vm.id,
          accountId: vm.id,
          firstUserIdentity,
          clientIp: clientIp(req),
          userAgent: req.headers?.['user-agent'] || '',
          epoch: `${attemptStartedAt}:${vm.id}:${hops}`,
        }
        // passthrough forwards an explicit inbound session verbatim; without
        // one it still derives the deterministic seed instead of sending null.
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
        const outboundBody = applyCodexRebuildBody({ ...converted.body, stream: true }, outboundSessionId, sessionMode)
        const outboundHeaders = codexKernelHeaders(req.headers, outboundBody, session)
        if (captureOutbound) logBag.outbound_body = outboundBody
        logBag.outbound_headers = redactHeaders(outboundHeaders)
        let hopEmitted = false
        const runHop = async () =>
          await runCodexKernelHop({
            sharedExecution: !!sharedRuntime,
            hop:
              sharedRuntime || stickyRouter?.shared
                ? async (args) => {
                    // Confirm each actual submission, including hidden retries. A CAS
                    // conflict must never send a body carrying a different native session.
                    if (stickyRouter?.shared && !(await bindSticky(outboundSessionId))) {
                      throw Object.assign(new Error('Shared session binding changed before Codex submission'), {
                        code: 'sticky_binding_conflict',
                      })
                    }
                    return sharedRuntime ? sharedRuntime.invoke(lease, hop, args) : hop(args)
                  }
                : hop,
            args: {
              exec: execFor(projectRoot, vm),
              onExecutionStart: onExecutionState
                ? (execution) => onExecutionState(req, { ...execution, started: true, ended: false })
                : undefined,
              onExecutionEnd: onExecutionState ? (execution) => onExecutionState(req, execution) : undefined,
              signal: gone.signal,
              body: outboundBody,
              reqHeaders: req.headers,
              envelope: {
                body: outboundBody,
                headers: outboundHeaders,
                stream: true,
                session,
                options: { ...codexKernelRequestOptions(routing), installation_id: written?.installationId },
              },
            },
            onReasoningFallback: ({ body: retryBody }) => {
              if (captureOutbound) logBag.outbound_body = retryBody
            },
            onEvent: async (line) => {
              hopEmitted = true
              if (conversionError) return
              const tier = serviceTierFromSseLine(line)
              if (tier) responseServiceTier = tier
              const seen = usageFromSseLine(line)
              if (seen) streamedUsage = preferUsage(streamedUsage, seen)
              if (!stream) {
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
        let result = await runHop()
        // A transient seat-local failure gets the same account up to N retries
        // before the request spends a switch. 401/403/429 are never retried here:
        // they are credential/account state and must move to another seat.
        let sameAccountRetries = result?.transport_retried || result?.reasoning_history_retried ? 1 : 0
        while (
          sameAccountRetries < failoverBudget.maxSameAccountRetries &&
          attempts < failoverBudget.maxAttempts &&
          isRetryableSameCodexAccount(result, {
            headersSent: res.headersSent || hopEmitted,
            conversionError,
            signal: gone.signal,
          }) &&
          (!sharedRuntime || (result?.execution?.ended === true && !result?.executionUncertain))
        ) {
          sameAccountRetries += 1
          attempts += 1
          hops += 1
          logBag.attempt_count = hops
          logBag.codex_same_account_retried = sameAccountRetries
          await new Promise((resolve) => setTimeout(resolve, sameRetryDelayMs))
          hopEmitted = false
          result = await runHop()
        }
        // The log and total duration share ingress time; pool scoring keeps hop TTFT.
        logBag.first_token_ms = Number.isFinite(result?.firstTokenAt)
          ? Math.max(0, result.firstTokenAt - requestStartedAt)
          : (result?.ttftMs ?? null)
        if (conversionError) {
          result.ok = false
          result.status = 502
          result.terminalState = 'incomplete'
          result.body = { error: conversionError }
        }
        if (sharedRuntime && (result?.executionUncertain || result?.execution?.ended !== true)) {
          executionUncertain = true
          logBag.final_state = gone.signal.aborted ? 'cancelled' : 'incomplete'
          logBag.error_code = 'codex_execution_uncertain'
          if (gone.signal.aborted) return
          stats.errors++
          if (res.headersSent || hopEmitted) return res.end()
          return json(res, 502, {
            error: {
              type: 'api_error',
              code: 'codex_execution_uncertain',
              message: 'Codex execution termination is unknown',
            },
          })
        }
        ingestCodexHop(
          projectRoot,
          vm.id,
          result,
          Date.now(),
          picked.quotaPolicy || normalizeCodexRouting(routing.codex).quota,
        )
        if (result?.transport_retried) logBag.transport_retried = true
        if (result?.reasoning_history_retried) {
          logBag.attempt_count += 1
          logBag.reasoning_history_retried = true
        }
        last = result
        const hopUsage = result.usage || result.body?.usage || result.body?.response?.usage || null
        const usage = preferUsage(hopUsage, streamedUsage)
        // Responses SSE is not a Claude assistant message, so the stream client
        // reports ok:false / incomplete. A 200 hop that carried tokens still billed.
        const delivered = !conversionError && (result?.ok || (Number(result?.status) === 200 && usageTokens(usage) > 0))
        if (delivered) {
          attemptKind = 'succeeded'
          await bindSticky(outboundSessionId)
          const extracted = extractOpenaiUsage(usage)
          const serviceTier = responseServiceTier || converted.body?.service_tier || usage?.service_tier || null
          const disjoint = extracted ? openaiAnthropicUsageFromExtract(extracted) : null
          const logged = disjointOpenaiUsage(usage && serviceTier ? { ...usage, service_tier: serviceTier } : usage)
          logBag.usage = logged
          logBag.input_tokens = disjoint?.input_tokens ?? usage?.input_tokens ?? usage?.prompt_tokens ?? null
          logBag.output_tokens = disjoint?.output_tokens ?? usage?.output_tokens ?? usage?.completion_tokens ?? null
          logBag.cache_read_tokens =
            disjoint?.cache_read_input_tokens ??
            extracted?.cached_tokens ??
            usage?.input_tokens_details?.cached_tokens ??
            usage?.cache_read_tokens ??
            null
          logBag.cache_creation_tokens =
            disjoint?.cache_creation_input_tokens ??
            extracted?.cache_write_tokens ??
            usage?.input_tokens_details?.cache_write_tokens ??
            usage?.cache_creation_tokens ??
            null
          reportOpenAIAttempt(vm.id, 'succeeded', result.ttftMs ?? null)
          logBag.final_state = result?.ok ? result.terminalState || 'verified' : 'verified'
          logBag.upstream_model = converted.body.model
          if (hops > 1) logBag.codex_failed_over = true
          if (!stream) {
            let body
            try {
              const assembled = assembleCodexBodyFromSse(chunks, result.body || {})
              body =
                protocol === 'anthropic.messages'
                  ? codexBodyToAnthropicMessage(assembled, converted.body.model)
                  : assembled
            } catch (error) {
              if (!isToolArgumentsError(error)) throw error
              stats.errors++
              logBag.error_code = error.code
              logBag.final_state = 'incomplete'
              return json(res, 502, {
                error: { type: 'upstream_protocol_error', code: error.code, message: error.message },
              })
            }
            return json(res, 200, body)
          }
          if (!res.headersSent) writeSSEHeaders(res)
          return res.end()
        }
        reportOpenAIAttempt(vm.id, attemptKind, result?.ttftMs ?? null)
        const failureHold = codexFailureHold(result)
        if (failureHold) holdOpenAIAccount(vm.id, failureHold)
        if (res.headersSent || hopEmitted) {
          stats.errors++
          logBag.error_code = result?.body?.error?.code || 'codex_upstream'
          logBag.upstream_status = result?.status || 0
          return res.end()
        }
        if (isCodexFailoverError(result)) {
          pickOpts.excluded.add(vm.id)
          await leaveSticky()
          switches += 1
          if (switches > failoverBudget.maxSwitches || attempts >= failoverBudget.maxAttempts) break
          continue
        }
        break
      } catch (error) {
        if (error?.code !== 'sticky_binding_conflict') throw error
        stats.errors++
        logBag.error_code = error.code
        logBag.final_state = 'rejected'
        return json(res, 503, { error: { type: 'api_error', code: error.code, message: '会话绑定已变更，请重试请求' } })
      } finally {
        try {
          await lease.release()
        } finally {
          if (sharedRuntime && (lease.uncertain || !lease.released)) executionUncertain = true
        }
        if (claimsWindow) {
          try {
            sessions?.release?.(vm.id, picked.sessionKey, { gen: windowGen })
          } catch {}
        }
      }
    }
  } catch (error) {
    if (error?.code === 'request_cancelled') {
      logBag.final_state = 'cancelled'
      return
    }
    if (error?.code === 'session_queue_timeout') {
      return rejectCodexAdmission({
        res,
        json,
        stats,
        logBag,
        picked: { error: 'capacity_unavailable' },
        model: converted.body.model,
      })
    }
    throw error
  } finally {
    try {
      try {
        if (sharedRuntime && activeLease && !activeLease.released) await activeLease.release()
      } finally {
        if (turn) {
          if (executionUncertain || activeLease?.uncertain || (activeLease && !activeLease.released))
            await turn.markUncertain()
          else await turn.release()
        }
      }
    } finally {
      gone.settle()
    }
  }
  stats.errors++
  logBag.error_code = last?.body?.error?.code || 'codex_upstream'
  logBag.upstream_status = last?.status || 0
  return json(res, last?.status || 502, last?.body || { error: { type: 'api_error', code: 'codex_upstream' } })
}

/** No seat was admitted and nothing ran: say which gate stopped the request. */
function rejectCodexAdmission({ res, json, stats, logBag, picked, model }) {
  stats.errors++
  logBag.error_code = picked.error || 'no_codex_vm'
  if (picked.error === 'platform_mismatch') {
    return json(res, 400, {
      error: {
        type: 'invalid_request_error',
        code: 'platform_mismatch',
        message: `vm '${picked.pin}' is not a GPT slot`,
      },
    })
  }
  if (picked.error === 'key_group_mismatch') {
    return json(res, 403, {
      error: {
        type: 'permission_error',
        code: 'key_group_mismatch',
        message: '此密钥不能调用 openai',
      },
    })
  }
  if (picked.error === 'vm_pool_unavailable') {
    return json(res, 403, {
      error: {
        type: 'permission_error',
        code: 'vm_pool_unavailable',
        message: picked.message || '账号池不可用',
      },
    })
  }
  if (picked.error === 'model_not_allowed') {
    return json(res, 400, {
      error: {
        type: 'invalid_request_error',
        code: 'model_not_allowed',
        message: `model '${model || ''}' is not allowed on any GPT slot`,
        param: 'model',
      },
    })
  }
  if (picked.error === 'response_not_portable') {
    return json(res, 409, {
      error: {
        type: 'invalid_request_error',
        code: 'response_not_portable',
        message: 'previous_response_id 所在的 GPT 账号已不可用；该响应无法在其他账号继续，请携带完整上下文重新发起',
      },
    })
  }
  if (
    picked.error === 'capacity_unavailable' ||
    picked.error === 'session_window_full' ||
    picked.error === 'pool_wait_queue_full'
  ) {
    // Queue-full has no retryAt. Every Codex pool_overloaded 429 still advertises >= 1s.
    const waitMs = Number(picked.retryAt) - Date.now()
    const retryAfterSec = Math.max(1, waitMs > 0 ? Math.ceil(waitMs / 1000) : 0)
    res.setHeader?.('retry-after', String(retryAfterSec))
    return json(res, 429, {
      error: {
        type: 'rate_limit_error',
        code: 'pool_overloaded',
        message: CLIENT_POOL_BUSY_MESSAGE,
        details: { reason: picked.error },
      },
    })
  }
  if (picked.error === 'pool_resting') {
    // Every slot is off-shift: 503 like the Claude pool, timed to the first window open.
    const waitMs = Number(picked.retryAt) - Date.now()
    res.setHeader?.('retry-after', String(Math.max(1, Math.ceil(waitMs / 1000) || 1)))
    return json(res, 503, {
      error: {
        type: 'api_error',
        code: ErrorCode.POOL_UNAVAILABLE,
        message: CLIENT_POOL_UNAVAILABLE_MESSAGE,
        details: { reason: 'pool_resting' },
      },
    })
  }
  if (picked.error === 'quota_exhausted') {
    return json(res, 503, {
      error: { type: 'api_error', code: 'quota_exhausted', message: 'OpenAI 号池额度已耗尽' },
    })
  }
  return json(res, 503, {
    error: { type: 'api_error', code: picked.error || 'no_codex_vm', message: 'no Codex kernel VM is configured' },
  })
}

// Codex web search (`web.run`) is a plain JSON POST to `{base_url}/alpha/search`. Responses-Lite
// models (gpt-6.1-sol, gpt-6-astra) have no hosted web_search tool, and the CLI fails the whole
// turn on a non-2xx answer, so a missing route breaks every turn that searches.
const CODEX_SEARCH_TIMEOUT_MS = 120000
// The backend answers "Unknown parameter" for these.
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

/**
 * Access token to retry with after a 401/403. The kernel refreshes the same rotating
 * refresh token on its own, so first adopt a token it wrote meanwhile; otherwise refresh
 * once per slot, shared by concurrent callers.
 */
async function refreshSearchAccess(projectRoot, vm, usedAccess, { proxyUrl, fetchImpl, refresh }) {
  const now = searchCredentials(projectRoot, vm)
  if (now.access && now.access !== usedAccess) return now.access
  if (!now.refresh) return ''
  let pending = searchRefreshes.get(vm.id)
  if (!pending) {
    pending = (async () => {
      const tok = await refresh({ refreshToken: now.refresh, proxyUrl, fetchImpl })
      if (!tok?.ok || !tok.access_token) return ''
      upsertCodexAccount(projectRoot, vm.id, {
        access_token: tok.access_token,
        refresh_token: tok.refresh_token || now.refresh,
        id_token: tok.id_token || now.first.id_token,
        expires_at: tok.expires_at || now.first.expires_at,
      })
      return tok.access_token
    })().finally(() => searchRefreshes.delete(vm.id))
    searchRefreshes.set(vm.id, pending)
  }
  return pending
}

function plainHeaders(headers) {
  if (typeof headers?.entries === 'function') return Object.fromEntries(headers.entries())
  return { ...(headers || {}) }
}

/** One search call on one slot. Resolves `{ status, text, headers }`, or `{ status: 0, error }`. */
async function postCodexSearch({
  projectRoot,
  vm,
  body,
  turnMetadata,
  fetchImpl,
  refresh = refreshCodexAccessToken,
  signal,
  timeoutMs = CODEX_SEARCH_TIMEOUT_MS,
  onExecutionStart,
  onExecutionEnd,
}) {
  const notStarted = { requestId: null, started: false, ended: true, reason: 'not_started' }
  const proxyUrl = hostProxyUrlForVm(vm)
  if (!fetchImpl && !proxyUrl && !isLocalEgressProxy(vm.proxy))
    return { status: 0, error: 'proxy_required', execution: notStarted }
  let agent
  try {
    if (!fetchImpl && proxyUrl) agent = createProxyAgent(proxyUrl.replace(/^socks5:\/\//i, 'socks5h://'))
  } catch {
    return { status: 0, error: 'upstream_transport', execution: notStarted }
  }
  const doFetch = fetchImpl || fetch
  const creds = searchCredentials(projectRoot, vm)
  const send = async (access) => {
    if (signal?.aborted) return { status: 0, error: 'client_cancelled', execution: notStarted }
    const requestId = randomUUID()
    // Same identity as the slot's kernel; the backend wants originator, User-Agent and version to agree.
    const headers = {
      authorization: `Bearer ${access}`,
      'content-type': 'application/json',
      accept: 'application/json',
      originator: CODEX_CATALOG_ORIGINATOR,
      'user-agent': CODEX_USER_AGENT,
      version: CODEX_APP_VERSION,
      'x-client-request-id': requestId,
    }
    if (creds.accountId) headers['chatgpt-account-id'] = creds.accountId
    if (turnMetadata) headers['x-codex-turn-metadata'] = turnMetadata
    const payload = JSON.stringify(body)
    await onExecutionStart?.({ requestId, started: false, ended: false, reason: 'before_send' })
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    let out
    let execution
    try {
      const res = await doFetch(CODEX_SEARCH_URL, {
        method: 'POST',
        headers,
        body: payload,
        agent,
        signal: controller.signal,
        ...(onExecutionStart ? { redirect: 'manual' } : {}),
      })
      out = { status: Number(res?.status) || 0, text: await res.text(), headers: plainHeaders(res?.headers) }
      execution = { requestId, started: true, ended: true, reason: 'http_body_complete' }
    } catch (e) {
      const aborted = timedOut || signal?.aborted || /abort/i.test(`${e?.name} ${e?.message}`)
      out = { status: 0, error: aborted ? 'upstream_timeout' : 'upstream_transport' }
      execution = { requestId, started: true, ended: false, reason: timedOut ? 'http_timeout' : 'http_transport' }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    await onExecutionEnd?.(execution)
    return { ...out, execution }
  }
  if (!creds.access && !creds.refresh) return { status: 0, error: 'no_oauth_token', execution: notStarted }
  let out = creds.access ? await send(creds.access) : { status: 401, execution: notStarted }
  if ((out.status === 401 || out.status === 403) && !signal?.aborted) {
    const access = await refreshSearchAccess(projectRoot, vm, creds.access, { proxyUrl, fetchImpl, refresh })
    if (access) out = await send(access)
  }
  return out
}

function isSearchFailover(out) {
  const status = Number(out?.status) || 0
  return status === 0 || status === 401 || status === 402 || status === 403 || status === 429 || status >= 500
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * POST /v1/alpha/search for Codex web search. Not inference: no session window, sticky bind
 * or latency report, but the call holds a seat on the slot it runs on. Auth/quota/rate-limit
 * failures move to the next GPT slot; anything else is the backend's answer, passed through.
 */
export async function handleCodexSearch({
  req,
  res,
  body,
  logBag,
  stats,
  json,
  routing = {},
  projectRoot,
  stickyRouter = null,
  ops = {},
  onExecutionState = null,
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
  const outbound = { ...body }
  for (const key of CODEX_SEARCH_DROP_FIELDS) delete outbound[key]
  const turnMetadata = headerString(req.headers, 'x-codex-turn-metadata')
  const post = ops.postCodexSearch || postCodexSearch
  const sharedRuntime = ops.sharedRuntime || (isKubernetesMode() ? new SharedCodexRuntime() : null)
  const pickOpts = { stickyRouter, sessions: null, body: outbound, excluded: new Set(), routing, sharedRuntime }
  const deadline = Date.now() + codexWaitTimeoutMs(routing)
  const gone = clientGoneSignal(req, res)
  let last = null
  let attempts = 0
  try {
    for (;;) {
      const admitted = await admitCodexCandidate(projectRoot, req, pickOpts, { deadline, signal: gone.signal })
      if (!admitted.lease) {
        if (admitted.picked.error === 'client_cancelled') {
          logBag.final_state = 'cancelled'
          return
        }
        if (last) break
        return rejectCodexAdmission({ res, json, stats, logBag, picked: admitted.picked, model: outbound.model })
      }
      try {
        const vm = getVm(projectRoot, admitted.vmId)
        pickOpts.excluded.add(admitted.vmId)
        if (!vm || !isCodexVm(vm)) continue
        if (!attempts) {
          stats.requests++
          stats.by_route['openai.search'] = (stats.by_route['openai.search'] || 0) + 1
        }
        attempts += 1
        logBag.vm_id = vm.id
        logBag.account_id = vm.id
        logBag.attempt_count = attempts
        const args = {
          projectRoot,
          vm,
          body: outbound,
          turnMetadata,
          fetchImpl: ops.fetchImpl,
          refresh: ops.refresh,
          signal: gone.signal,
          timeoutMs: ops.searchTimeoutMs,
          onExecutionStart: onExecutionState
            ? (execution) => onExecutionState(req, { ...execution, started: true, ended: false })
            : undefined,
          onExecutionEnd: onExecutionState ? (execution) => onExecutionState(req, execution) : undefined,
        }
        last = sharedRuntime ? await sharedRuntime.invoke(admitted.lease, post, args) : await post(args)
        if (sharedRuntime && (last?.executionUncertain || last?.execution?.ended !== true)) {
          logBag.final_state = gone.signal.aborted ? 'cancelled' : 'incomplete'
          if (gone.signal.aborted) return
          return reject(
            502,
            'api_error',
            'codex_search_execution_uncertain',
            'Codex search execution termination is unknown',
          )
        }
        if (gone.signal.aborted) {
          logBag.final_state = 'cancelled'
          return
        }
        logBag.upstream_status = last.status || null
        ingestCodexHop(
          projectRoot,
          vm.id,
          {
            ok: last.status >= 200 && last.status < 300,
            status: last.status,
            headers: last.headers || {},
            body: parseJson(last.text),
          },
          Date.now(),
          admitted.picked.quotaPolicy || codex.quota,
        )
        if (!isSearchFailover(last)) break
      } finally {
        await admitted.lease.release()
      }
    }
  } finally {
    gone.settle()
  }
  if (!last.status) {
    logBag.final_state = 'upstream_error'
    return reject(502, 'api_error', last.error || 'upstream_transport', 'Codex search upstream request failed')
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
  return json(res, last.status, payload)
}
