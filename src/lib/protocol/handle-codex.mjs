/**
 * Codex hop from handle-protocol. Claude convert/pool/CRS never runs here.
 */
import path from 'node:path'
import { getVm, listVms, persistCodexUsage, syncCodexQuotaSchedule } from '../vm/vm-registry.mjs'
import { isValidVmId } from '../vm/vm-file.mjs'
import { isCodexProtocolAllowed, isCodexVm, normalizeCodexRouting } from './codex-route.mjs'
import { restrictCodexClient } from './codex-restriction.mjs'
import {
  responsesSseToChatChunk,
  responsesSseToAnthropicEvents,
  createAnthropicSseState,
  assembleCodexBodyFromSse,
  codexBodyToAnthropicMessage,
  toCodexResponses,
} from './codex-convert.mjs'
import { extraFromCodexHeaders, codexQuotaPark, CODEX_DEFAULT_PARK_MS } from './codex-usage.mjs'
import { extractOpenaiUsage } from './openai-usage.mjs'
import { streamCodexKernel } from '../transport/codex-kernel-client.mjs'
import { ensureCodexKernel, writeCodexKernelConfig } from '../transport/codex-kernel-supervisor.mjs'
import { boundProxyUrl } from '../vm/egress.mjs'
import { orderCodexSessionSlots, codexSlotAllowsModel, isCodexFailoverError } from '../pool/codex-slot-pool.mjs'
import {
  reportOpenAIAttempt,
  tryAcquireOpenAISlot,
  waitForOpenAICapacity,
  wakeOpenAIWaiter,
} from '../pool/openai-account-runtime.mjs'
import { CLIENT_POOL_BUSY_MESSAGE } from '../core/errors.mjs'
import { applyOpenaiWashLog } from './openai-wash.mjs'
import {
  extractCallerSession,
  firstUserContentFingerprint,
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
export function pickCodexCandidates(
  projectRoot,
  req,
  { stickyRouter = null, sessions = null, body = null, excluded = null } = {},
) {
  const pin = pinnedVmId(req)
  const model = body?.model || null
  if (pin) {
    const vm = getVm(projectRoot, pin)
    if (!vm || !isCodexVm(vm)) return { error: 'platform_mismatch', pin, ids: [] }
    if (!codexSlotAllowsModel(vm, model)) return { error: 'model_not_allowed', pin, ids: [] }
    const ordered = orderCodexSessionSlots([vm], { pin, excluded })
    return { ...ordered, pin, sticky: false, sessionKey: null, stickyKeys: [] }
  }
  for (const item of listVms(projectRoot)) {
    if (!isCodexVm(item)) continue
    syncCodexQuotaSchedule(projectRoot, getVm(projectRoot, item.id) || item)
  }
  const stickyKeys = stickyRouter?.collectPoolKeys?.(req, body || {}, { platform: 'openai' }) || []
  const sessionKey = stickyRouter?.extractPoolKey?.(req, body || {}, { platform: 'openai' }) || stickyKeys[0] || null
  const bound = sessionKey ? stickyRouter?.resolve?.(sessionKey) : null
  const vms = listVms(projectRoot)
  const continuesResponse = !!body?.previous_response_id && !!bound?.vmId
  const ordered = orderCodexSessionSlots(continuesResponse ? vms.filter((vm) => vm.id === bound.vmId) : vms, {
    boundVmId: bound?.vmId || null,
    sessionKey,
    sessionLimit: sessions,
    model,
    excluded,
  })
  if (bound?.vmId && sessionKey && ordered.boundState === 'gone') {
    for (const key of stickyKeys.length ? stickyKeys : [sessionKey]) stickyRouter?.unbind?.(key)
    try {
      sessions?.drop?.(bound.vmId, sessionKey)
    } catch {}
  }
  if (continuesResponse && (ordered.boundState === 'gone' || ordered.error === 'candidates_exhausted')) {
    return { error: 'response_not_portable', ids: [], sessionKey, stickyKeys, boundVmId: bound.vmId }
  }
  return { ...ordered, sessionKey, stickyKeys }
}

function ingestCodexHop(projectRoot, vmId, result, now = Date.now()) {
  const headers = result?.headers || {}
  const extra = extraFromCodexHeaders(headers, now)
  let limitedUntil = null
  if (
    isCodexFailoverError(result) &&
    (Number(result?.status) === 429 || /usage_limit_reached/.test(String(result?.body?.error?.code || '')))
  ) {
    const park = extra ? codexQuotaPark(extra, now) : { limited: true, until: now + CODEX_DEFAULT_PARK_MS }
    limitedUntil = park.until || now + CODEX_DEFAULT_PARK_MS
  }
  if (!extra && !limitedUntil) return null
  return persistCodexUsage(projectRoot, vmId, { headers, extra, limitedUntil, now })
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
  for (;;) {
    const picked = pickCodexCandidates(projectRoot, req, opts)
    if (picked.error && picked.error !== 'capacity_unavailable') return { picked }
    for (const candidate of picked.candidates || []) {
      const lease = tryAcquireOpenAISlot(candidate.id, {
        concurrency: candidate.concurrency,
        maxRpm: candidate.maxRpm,
      })
      if (lease) return { picked, vmId: candidate.id, lease }
    }
    // A woken waiter that still missed hands the wake to the next in line.
    if (woken) wakeOpenAIWaiter()
    const now = Date.now()
    if (now >= deadline) return { picked: { ...picked, error: 'capacity_unavailable', ids: [] } }
    const retryAt = Number(picked.retryAt)
    const sliceDeadline = Number.isFinite(retryAt) && retryAt > now ? Math.min(deadline, retryAt) : deadline
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

export async function runCodexKernelHop({ hop, args = {}, onEvent } = {}) {
  let emitted = false
  const wrapped = async (line) => {
    emitted = true
    if (onEvent) await onEvent(line)
  }
  let result = await hop({ ...args, onEvent: wrapped })
  if (!result?.ok && !emitted && isRetryableCodexTransport(result)) {
    result = { ...(await hop({ ...args, onEvent: wrapped })), transport_retried: true }
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
  const firstUserIdentity = firstUserContentFingerprint(converted.body) || firstUserContentFingerprint(inbound)
  const hop = ops.streamCodexKernel || streamCodexKernel
  const writeCfg = ops.writeCodexKernelConfig || writeCodexKernelConfig
  const ensure = ops.ensureCodexKernel || ensureCodexKernel
  const anthropicSse = protocol === 'anthropic.messages' ? createAnthropicSseState() : null
  const chatSse =
    protocol === 'openai.chat' || protocol === 'openai.completions'
      ? { id: 'codex', seq: 0, tools: new Map(), sawTool: false }
      : null
  const pickOpts = { stickyRouter, sessions, body: body || converted.body || inbound, excluded: new Set() }
  const deadline = Date.now() + codexWaitTimeoutMs(routing)
  const gone = clientGoneSignal(req, res)
  logBag.via = 'codex-kernel'
  logBag.attempt_count = 0
  let last = null
  let hops = 0
  let counted = false
  try {
    for (;;) {
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
      if (!vm || !isCodexVm(vm)) {
        lease.release()
        pickOpts.excluded.add(admitted.vmId)
        continue
      }
      if (!counted) {
        counted = true
        stats.requests++
        stats.by_route[protocol] = (stats.by_route[protocol] || 0) + 1
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
      const ownsPin = !!stickyBound?.vmId && stickyBound.vmId === vm.id
      const bindSticky = (sessionId = null) => {
        if (!picked.sessionKey || !stickyRouter?.bind) return
        const payload = { accountId: vm.id, vmId: vm.id }
        if (sessionId) payload.sessionId = sessionId
        for (const key of stickyKeys) stickyRouter.bind(key, payload)
      }
      const leaveSticky = () => {
        if (!ownsPin || !picked.sessionKey) return
        try {
          sessions?.drop?.(vm.id, picked.sessionKey)
        } catch {}
        for (const key of stickyKeys) stickyRouter?.unbind?.(key)
      }
      let attemptKind = 'failed'
      try {
        writeCfg(projectRoot, vm, {
          proxyUrl: boundProxyUrl(vm.proxy),
          proxyRequired: true,
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
          if (!res.headersSent) continue
          stats.errors++
          logBag.error_code = 'codex_kernel_unavailable'
          return json(res, 503, last.body)
        }
        hops += 1
        logBag.vm_id = vm.id
        logBag.attempt_count = hops
        const chunks = []
        let responseServiceTier = null
        let streamedUsage = null
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
        // Passthrough keeps an explicit inbound session verbatim; without one it
        // must still derive the deterministic first-user fallback (never null).
        const outboundSessionId =
          sessionMode === 'passthrough'
            ? inboundSession.session_id ||
              resolveOutboundSessionId(callerSession, {
                ...sessionOptions,
                mode: 'passthrough',
                officialClient: true,
              })
            : resolveOutboundSessionId(callerSession, { ...sessionOptions, mode: sessionMode })
        const session = {
          session_id: outboundSessionId,
          previous_response_id: inboundSession.previous_response_id,
        }
        const outboundBody = applyCodexRebuildBody({ ...converted.body, stream: true }, outboundSessionId, sessionMode)
        const result = await runCodexKernelHop({
          hop,
          args: {
            exec: execFor(projectRoot, vm),
            body: outboundBody,
            reqHeaders: req.headers,
            envelope: {
              body: outboundBody,
              headers: codexKernelHeaders(req.headers, outboundBody, session),
              stream: true,
              session,
            },
          },
          onEvent: async (line) => {
            const tier = serviceTierFromSseLine(line)
            if (tier) responseServiceTier = tier
            const seen = usageFromSseLine(line)
            if (seen) streamedUsage = preferUsage(streamedUsage, seen)
            if (!stream) {
              chunks.push(line)
              return
            }
            if (!res.headersSent) writeSSEHeaders(res)
            if (protocol === 'openai.chat' || protocol === 'openai.completions') {
              const mapped = responsesSseToChatChunk(line, 'codex', chatSse)
              if (mapped) res.write(mapped)
              return
            }
            if (protocol === 'anthropic.messages') {
              const mapped = responsesSseToAnthropicEvents(line, anthropicSse)
              if (mapped) res.write(mapped)
              return
            }
            res.write(line.endsWith('\n') ? `${line}\n` : `${line}\n`)
          },
        })
        ingestCodexHop(projectRoot, vm.id, result)
        if (result?.transport_retried) logBag.transport_retried = true
        last = result
        const hopUsage = result.usage || result.body?.usage || result.body?.response?.usage || null
        const usage = preferUsage(hopUsage, streamedUsage)
        // Responses SSE is not a Claude assistant message, so the stream client
        // reports ok:false / incomplete. A 200 hop that carried tokens still billed.
        const delivered = result?.ok || (Number(result?.status) === 200 && usageTokens(usage) > 0)
        if (delivered) {
          attemptKind = 'succeeded'
          bindSticky(outboundSessionId)
          const extracted = extractOpenaiUsage(usage)
          const serviceTier = responseServiceTier || converted.body?.service_tier || usage?.service_tier || null
          logBag.usage = usage && serviceTier ? { ...usage, service_tier: serviceTier } : usage
          logBag.input_tokens = extracted?.input_tokens ?? usage?.input_tokens ?? usage?.prompt_tokens ?? null
          logBag.output_tokens = extracted?.output_tokens ?? usage?.output_tokens ?? usage?.completion_tokens ?? null
          logBag.cache_read_tokens =
            extracted?.cached_tokens ?? usage?.input_tokens_details?.cached_tokens ?? usage?.cache_read_tokens ?? null
          logBag.cache_creation_tokens =
            extracted?.cache_write_tokens ??
            usage?.input_tokens_details?.cache_write_tokens ??
            usage?.cache_creation_tokens ??
            null
          logBag.first_token_ms = result.ttftMs ?? null
          reportOpenAIAttempt(vm.id, 'succeeded', result.ttftMs ?? null)
          logBag.final_state = result?.ok ? result.terminalState || 'verified' : 'verified'
          logBag.upstream_model = converted.body.model
          if (hops > 1) logBag.codex_failed_over = true
          if (!stream) {
            const assembled = assembleCodexBodyFromSse(chunks, result.body || {})
            const body =
              protocol === 'anthropic.messages'
                ? codexBodyToAnthropicMessage(assembled, converted.body.model)
                : assembled
            return json(res, 200, body)
          }
          if (!res.headersSent) writeSSEHeaders(res)
          return res.end()
        }
        reportOpenAIAttempt(vm.id, attemptKind, result?.ttftMs ?? null)
        if (res.headersSent) {
          stats.errors++
          logBag.error_code = result?.body?.error?.code || 'codex_upstream'
          logBag.upstream_status = result?.status || 0
          return res.end()
        }
        if (isCodexFailoverError(result)) {
          pickOpts.excluded.add(vm.id)
          leaveSticky()
          continue
        }
        break
      } finally {
        lease.release()
        if (claimsWindow) {
          try {
            sessions?.release?.(vm.id, picked.sessionKey, { gen: windowGen })
          } catch {}
        }
      }
    }
  } finally {
    gone.settle()
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
    const waitMs = Number(picked.retryAt) - Date.now()
    if (waitMs > 0) res.setHeader?.('retry-after', String(Math.ceil(waitMs / 1000)))
    return json(res, 429, {
      error: {
        type: 'rate_limit_error',
        code: 'pool_overloaded',
        message: CLIENT_POOL_BUSY_MESSAGE,
        details: { reason: picked.error },
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
