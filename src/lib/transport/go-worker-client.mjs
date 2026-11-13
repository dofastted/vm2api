import http from 'node:http'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { resolveStreamIdleTimeoutMs } from '../core/config.mjs'
import { prepareOutboundHeaders } from '../protocol/outbound-attempt.mjs'
import { sanitizeAnthropicBodyForBetaTokens } from '../protocol/anthropic-policy.mjs'
import { prepareCliNodeRequest, prepareCragRequest } from '../protocol/kernel-request.mjs'
import { withRequestProtocolBetas } from '../protocol/claude-code-betas.mjs'
import { pinThreadBetas, rememberThreadTurn } from '../protocol/thread-betas.mjs'
import { applyThinkingDisplay, ensureOfficialPrintThinking, thinkingDisplayMode } from '../protocol/thinking.mjs'
import { modelDirectiveForCrag } from '../protocol/model-policy.mjs'
import { capOutboundBody } from '../protocol/outbound-snapshot.mjs'
import { ccEntrypointFromRouting, stripSubagentBilling } from '../identity/crs-persona.mjs'
import { sealClaudeCodeCch } from '../identity/cch.mjs'
import { credentialModeFromOauth } from '../oauth/credential-mode.mjs'
import { isCrsMock, writeCrsTrace, mockCrsPayload, emitMockSse } from './crs-mock.mjs'
import {
  classifyCredentialRefresh,
  hasAccessPresence,
  hasCredentialPresence,
  hasRefreshPresence,
  needsRefresh,
  readWorkerCredentialFile,
  REFRESH_SKEW_MS,
  writeWorkerCredentialFile,
  ensureOfficialCredentialLink,
  authLoginBlocksRefresh,
} from '../oauth/oauth-credentials.mjs'
import { isApiKeyMode } from '../oauth/credential-mode.mjs'
import { runSlotOauth } from './slot-oauth.mjs'
import { slotHost } from '../vm/slot-host.mjs'
import { ensureRemoteOfficialCredentialLink } from '../cluster/remote-slot-files.mjs'
import { normalizeSessionIdleTtlSeconds } from '../vm/slot-engine.mjs'
import {
  cragConsumesModelDirective,
  cragV2KernelActive,
  readSlotKernelConfig,
  validateCallerCwd,
} from '../protocol/crag-print-prompt.mjs'
import { applyClaudeSSELineToMessage, createClaudeMessageAssembler } from '../protocol/convert.mjs'
import {
  clientCancelledResult,
  isClientCancelledResult,
  isCompleteAssistantMessage,
  isWrapConnectionError,
} from '../core/errors.mjs'
import { extraHeadersFromLimitError } from '../pool/quota-window.mjs'
import { createStreamTiming } from '../protocol/stream-timing.mjs'
import { mergeUsage } from '../protocol/openai-usage.mjs'
import { ensureRedaction, maskJson, restoreJsonValue, createSseRestorer } from '../redaction/runtime.mjs'
import { inferenceCodec } from './inference-codec.mjs'
import { parseWorkerJson as parseJson } from './inference-codec-json.mjs'
import {
  createNativeHandoffState,
  consumeNativeHandoffStream,
  negotiateNativeHandoff,
} from '../protocol/native-handoff.mjs'

const MAX_BODY = 64 * 1024 * 1024
const MAX_GATEWAY_CLOCK_MS = 86_400_000
const CRAG_HEADER_ALLOWANCE_MS = 5_000
const credentialRefreshTail = new Map()

function withCredentialRefreshLock(key, fn) {
  const prev = credentialRefreshTail.get(key) || Promise.resolve()
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const tail = prev.catch(() => {}).then(() => gate)
  credentialRefreshTail.set(key, tail)
  return prev
    .catch(() => {})
    .then(async () => {
      try {
        return await fn()
      } finally {
        release()
        if (credentialRefreshTail.get(key) === tail) credentialRefreshTail.delete(key)
      }
    })
}

export function workerPaths(exec = {}) {
  const slotRoot = exec.homeDir ? path.dirname(exec.homeDir) : null
  const runDir =
    exec.runRoot && exec.vm?.id
      ? path.join(exec.runRoot, exec.vm.id)
      : exec.vm?.runtime?.worker_run_dir || (slotRoot ? path.join(slotRoot, 'run') : null)
  return {
    runDir,
    socketPath: exec.vm?.runtime?.worker_socket || (runDir ? path.join(runDir, 'worker.sock') : null),
    tokenPath: exec.vm?.runtime?.worker_token_file || (runDir ? path.join(runDir, 'internal.token') : null),
  }
}

function readInternalToken(exec) {
  const { tokenPath } = workerPaths(exec)
  if (!tokenPath) return ''
  try {
    return fs.readFileSync(tokenPath, 'utf8').trim()
  } catch {
    return ''
  }
}

async function workerRequest(
  exec,
  {
    method = 'GET',
    requestPath,
    body = null,
    signal,
    timeoutMs = 180000,
    timeoutMode = 'overall',
    headers = {},
    maxRequestBytes = 0,
    inference = false,
    onRequestStarted,
    requireInternalToken = false,
  } = {},
) {
  if (signal?.aborted) throw Object.assign(new Error('The operation was aborted'), { code: 'ABORT_ERR' })
  const { socketPath } = workerPaths(exec)
  if (!socketPath) {
    throw Object.assign(new Error('slot worker socket is not configured'), { code: 'worker_socket_missing' })
  }
  const payload =
    body == null
      ? null
      : inference
        ? await inferenceCodec.encode(body, { signal })
        : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  if (signal?.aborted) throw Object.assign(new Error('The operation was aborted'), { code: 'ABORT_ERR' })
  return new Promise((resolve, reject) => {
    // Include the headers, session metadata and request_id added around the caller's body.
    if (maxRequestBytes > 0 && payload?.length > maxRequestBytes) {
      reject(
        Object.assign(new Error(`Request envelope exceeds ${maxRequestBytes} bytes`), {
          status: 413,
          code: 'body_too_large',
        }),
      )
      return
    }
    const internalToken = readInternalToken(exec)
    if (requireInternalToken && !internalToken) {
      reject(Object.assign(new Error('slot worker internal token is not configured'), { code: 'worker_token_missing' }))
      return
    }
    const requestHeaders = { ...headers }
    if (payload) {
      requestHeaders['content-type'] = 'application/json'
      requestHeaders['content-length'] = String(payload.length)
    }
    if (internalToken) {
      // Rust/Codex kernels use the namespaced header; retain the legacy worker header.
      requestHeaders['x-kin-internal-token'] = internalToken
      requestHeaders['x-internal-token'] = internalToken
    }
    let timer = null
    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
    const arm = (ms, message) => {
      clearTimer()
      const wait = Math.max(1, Number(ms) || 0)
      timer = setTimeout(() => {
        req.destroy(Object.assign(new Error(message), { code: 'worker_timeout' }))
      }, wait)
      timer.unref?.()
    }
    const req = http.request(
      {
        socketPath,
        path: requestPath,
        method,
        headers: requestHeaders,
        signal,
      },
      (res) => {
        if (timeoutMode === 'first-byte') clearTimer()
        resolve(res)
      },
    )
    if (timeoutMs != null) arm(timeoutMs, `slot worker timeout after ${timeoutMs}ms`)
    req.once('close', clearTimer)
    req.once('error', reject)
    if (payload) req.write(payload)
    req.end()
    // Once handed to HTTP, the kernel may see the request before 'finish'.
    onRequestStarted?.()
  })
}

function clockMs(value, fallback) {
  const ms = Number(value)
  return Number.isFinite(ms) && ms > 0 ? Math.min(MAX_GATEWAY_CLOCK_MS, Math.max(1, Math.round(ms))) : fallback
}

function nativeCragRequest(exec, cragPrint) {
  return (
    cragPrint !== false &&
    cragV2KernelActive({
      vm: exec?.vm,
      health: exec?.workerStatus,
      kernelConfig: readSlotKernelConfig(exec?.homeDir),
    })
  )
}

function inferenceRequest(
  exec,
  {
    envelope,
    requestId,
    stream,
    deliveryMode,
    managedCrag,
    nativeHandoff = false,
    tenantId,
    slotWaitDeadlineMs,
    timeoutMs,
    idleTimeoutMs,
    routing,
    requestPath,
    ...options
  },
) {
  const headers = stream ? { te: 'trailers' } : {}
  const body = { ...envelope, request_id: requestId }
  const authenticatedPolicy = managedCrag && requestPath === '/internal/v1/messages'
  if (authenticatedPolicy) {
    body.stream = stream
    body.delivery_mode = deliveryMode === 'verified' ? 'verified' : 'realtime'
    if (tenantId) headers['x-tenant-id'] = tenantId
    const firstByteMs = clockMs(timeoutMs, 600_000)
    const idleMs = clockMs(idleTimeoutMs, clockMs(resolveStreamIdleTimeoutMs(routing), 180_000))
    const queueWaitMs = Number.isFinite(slotWaitDeadlineMs)
      ? Math.min(MAX_GATEWAY_CLOCK_MS, Math.max(0, Math.floor(slotWaitDeadlineMs - Date.now())))
      : 0
    body.gateway_policy = {
      queue_wait_ms: queueWaitMs,
      first_byte_timeout_ms: firstByteMs,
      stream_idle_timeout_ms: idleMs,
      session_idle_ttl_seconds: normalizeSessionIdleTtlSeconds(routing?.inference?.session_idle_ttl_seconds),
    }
    if (nativeHandoff) body.gateway_policy.native_handoff_v1 = true
    // Only realtime exposes headers before completion. The native worker owns
    // activity deadlines while verified and JSON responses are held back.
    timeoutMs =
      stream && body.delivery_mode === 'realtime' ? queueWaitMs + firstByteMs + CRAG_HEADER_ALLOWANCE_MS : null
  }
  return workerRequest(exec, {
    ...options,
    requestPath,
    // Do not let async codec queue time be added back to the worker's budget.
    inference: options.inference && !authenticatedPolicy,
    requireInternalToken: authenticatedPolicy,
    method: 'POST',
    body,
    headers,
    timeoutMs,
    timeoutMode: stream ? 'first-byte' : 'overall',
  })
}

function classifyManagedQueueRejection(result, managedCrag) {
  const error = result.body?.error
  if (!managedCrag || result.ok || result.body?.type !== 'error') return result
  if (
    !(result.status === 503 && error?.type === 'overloaded_error' && error.message === 'runtime queue is full') &&
    !(result.status === 504 && error?.type === 'timeout_error' && error.message === 'runtime queue timeout')
  ) {
    return result
  }
  return {
    ...result,
    body: { ...result.body, error: { ...error, code: 'slot_busy' } },
    upstreamExecutions: 0,
    terminalState: 'rejected',
  }
}

/**
 * Client went away: name the hop to the kernel so it cancels that job on the
 * CLI right now. The dropped socket alone left the kernel guessing whether
 * the CLI still owned the job. Best effort: the kernel also sees the drop,
 * and an old worker without the route just answers 404.
 */
function cancelOnAbort(exec, signal, requestId) {
  if (!signal) return () => {}
  const onAbort = () => {
    workerRequest(exec, {
      method: 'POST',
      requestPath: '/internal/v1/cancel',
      body: { request_id: requestId },
      timeoutMs: 3000,
    })
      .then((res) => res.resume())
      .catch((error) => {
        console.warn(`[kernel-cancel] ${exec?.vmId || 'slot'} ${requestId}: ${error?.code || error?.message || error}`)
      })
  }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  return () => signal.removeEventListener('abort', onAbort)
}

async function readAll(stream, limit = MAX_BODY) {
  const chunks = []
  let size = 0
  for await (const chunk of stream) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.length
    if (size > limit) {
      stream.destroy?.()
      throw Object.assign(new Error(`worker response exceeds ${limit} bytes`), { code: 'worker_response_too_large' })
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

function publicHeaders(headers = {}) {
  const result = {}
  for (const [key, value] of Object.entries(headers || {})) {
    if (value == null) continue
    const lower = String(key).toLowerCase()
    if (lower === 'set-cookie' || lower === 'authorization' || lower === 'x-api-key') continue
    if (lower === 'x-kin-provider-result') continue
    if (lower === 'trailer') {
      const visible = String(value)
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.toLowerCase() !== 'x-kin-provider-result')
      if (visible.length) result[lower] = visible.join(', ')
      continue
    }
    result[lower] = Array.isArray(value) ? value.join(',') : String(value)
  }
  return result
}

/** Flatten wrap `X-Rate-Limit-Headers` JSON into Anthropic Extra keys. */
function mergeRateLimitHeaders(headers = {}) {
  const out = { ...headers }
  const packed = headers['x-rate-limit-headers']
  if (!packed) return out
  try {
    const parsed = typeof packed === 'string' ? JSON.parse(packed) : packed
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out
    for (const [key, value] of Object.entries(parsed)) {
      if (value == null || value === '') continue
      const lower = String(key).toLowerCase()
      if (lower.startsWith('anthropic-ratelimit-') || lower === 'retry-after' || lower === 'request-id') {
        out[lower] = String(value)
      }
    }
  } catch {}
  return out
}

/** Parse the X-Usage / X-Model / X-Stop-Reason worker metadata. */
function streamMetaFromHeaders(headers = {}) {
  let usage = null
  if (headers['x-usage']) {
    try {
      usage = JSON.parse(headers['x-usage'])
    } catch {}
  }
  return {
    usage,
    model: headers['x-model'] || null,
    stopReason: headers['x-stop-reason'] || null,
  }
}

/** First user-visible assistant output — never transport/terminal metadata alone. */
export function isDownstreamCommitEvent(event) {
  if (!event || typeof event !== 'object') return false
  const t = String(event.type || '')
  if (t === 'error' || t === 'message_start' || t === 'response_headers') return false
  if (t === 'message_stop' || t === 'response.completed' || t === 'response.done' || t === 'message_delta') return false

  if (t === 'content_block_delta') {
    const d = event.delta || {}
    return !!(
      d.text ||
      d.thinking ||
      d.partial_json ||
      d.refusal ||
      d.signature ||
      (d.type === 'thinking_delta' && Number.isFinite(d.estimated_tokens) && d.estimated_tokens > 0)
    )
  }
  if (t === 'content_block_start') {
    const b = event.content_block || {}
    const kind = String(b.type || '')
    return (
      (kind === 'redacted_thinking' && !!b.data) ||
      kind === 'tool_use' ||
      kind === 'server_tool_use' ||
      kind === 'mcp_tool_use' ||
      kind.endsWith('_tool_use') ||
      !!(b.text || b.thinking || b.refusal)
    )
  }
  return t.startsWith('response.output_')
}

/** Anthropic SSE: message_start.message.usage + message_delta.usage. OpenAI Responses: response.usage. */
export function usageFromSseEvent(event) {
  if (!event || typeof event !== 'object') return null
  if (event.usage && typeof event.usage === 'object') return event.usage
  if (event.response?.usage && typeof event.response.usage === 'object') return event.response.usage
  if (event.message?.usage && typeof event.message.usage === 'object') return event.message.usage
  return null
}

import { semanticStatusForStreamError } from '../protocol/stream-error-status.mjs'

export { semanticStatusForStreamError } from '../protocol/stream-error-status.mjs'

/**
 * Kernel `map_kernel` folds every provider failure into 502 `provider_error`.
 * Restore recognized permission denials and plan-limit / overload statuses.
 */
export function restoreKernelErrorStatus(result = {}, { now = Date.now() } = {}) {
  if (!result || result.ok || Number(result.status) !== 502) return result
  const body = result.body
  if (!(body?.type === 'error' || body?.error)) return result
  const status = semanticStatusForStreamError(body)
  if (status !== 403 && status !== 429 && status !== 503 && status !== 529) return result
  const headers =
    status === 429
      ? extraHeadersFromLimitError(String(body?.error?.message || ''), result.headers || {}, now)
      : result.headers
  return { ...result, status, headers, terminalState: 'rejected' }
}

/**
 * Uncommitted hop that streamed a real provider error gets that status.
 * A hop that ended with no visible output stays on its 2xx status and is an
 * empty hop. Promoting it to 502 makes a healthy VM look overloaded.
 */
function unfinishedEmptyHop(result) {
  return {
    ...result,
    ok: false,
    terminalState: 'incomplete',
    body: {
      type: 'error',
      error: {
        type: 'api_error',
        code: 'empty_response',
        message: 'Upstream stream ended without visible output',
      },
    },
  }
}

export function restoreUncommittedHop(result = {}, { now = Date.now() } = {}) {
  if (!result || result.committed || result.ok || isClientCancelledResult(result)) return result
  if (Number(result.status) < 200 || Number(result.status) >= 300) return result
  const body = result.body
  if (body?.type === 'error' || body?.error) {
    const status = semanticStatusForStreamError(body)
    const message = String(body?.error?.message || body?.message || '')
    const code = String(body?.error?.code || '')
    if (code && code !== 'empty_response') {
      const retryAfter = body?.error?.retry_after
      const coded = retryAfter ? { ...(result.headers || {}), 'retry-after': String(retryAfter) } : result.headers
      const headers = status === 429 ? extraHeadersFromLimitError(message, coded || {}, now) : coded
      return {
        ...result,
        status,
        headers,
        terminalState: status === 502 ? result.terminalState || 'incomplete' : 'rejected',
        streamError: status !== 502,
      }
    }
    if (status === 502 && !/overload|usage policy/i.test(message)) {
      if (isWrapConnectionError(message)) return { ...result, ok: false, terminalState: 'incomplete' }
      return unfinishedEmptyHop(result)
    }
    const headers =
      status === 429 ? extraHeadersFromLimitError(String(message), result.headers || {}, now) : result.headers
    const terminalState = status === 502 ? result.terminalState : 'rejected'
    return { ...result, status, headers, terminalState, streamError: status !== 502 }
  }
  if (Array.isArray(body?.content) && body.content.length) return result
  return unfinishedEmptyHop(result)
}

function dumpSessionEnvelope(envelope) {
  const dir = process.env.KIN_SESSION_DUMP
  if (!dir) return
  try {
    fs.mkdirSync(dir, { recursive: true })
    const headers = {}
    for (const [key, value] of Object.entries(envelope.headers || {})) {
      headers[key] = /authorization|api-key|cookie|token/i.test(key) ? '***REDACTED***' : value
    }
    const rec = {
      ts: new Date().toISOString(),
      hop: 'go-worker-envelope',
      note: 'Panel-to-kernel body and protocol headers, not the final Anthropic wire request. The selected CLI owns outbound authentication and wire assembly.',
      stream: envelope.stream,
      delivery_mode: envelope.delivery_mode,
      headers,
      body: envelope.body,
    }
    const name = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}-envelope.json`
    fs.writeFileSync(path.join(dir, name), JSON.stringify(rec, null, 2))
  } catch {}
}

function gateCragBody(body, print, health) {
  if (!body || typeof body !== 'object') return body
  const caps = print && Array.isArray(health?.capabilities) ? health.capabilities : []
  const prompt = body.crag_prompt
  const model = print && cragConsumesModelDirective(health) ? modelDirectiveForCrag(body.model) : null
  const hasAlias = body.crag_options != null && Object.hasOwn(body.crag_options, 'prompt')
  if (!model && !Object.hasOwn(body, 'crag_prompt') && !Object.hasOwn(body, 'crag_model') && !hasAlias) {
    return body
  }
  const out = { ...body }
  if (!['append', 'replace'].includes(prompt?.mode) || !caps.includes(`prompt_${prompt.mode}`)) delete out.crag_prompt
  if (model) out.crag_model = model
  else delete out.crag_model
  if (out.crag_options && typeof out.crag_options === 'object' && !Array.isArray(out.crag_options)) {
    const { prompt: _prompt, ...rest } = out.crag_options
    if (Object.keys(rest).length) out.crag_options = rest
    else delete out.crag_options
  }
  return out
}

/**
 * `cliHop`: the slot cli-node builds the wire and always sends
 * mid-conversation-system; the kernel drops these envelope headers. Gating the
 * body on the VM's HTTP betas would lift every role=system turn into system[],
 * so system grows each turn and no cached prefix is ever read.
 * `cragPrint`: explicit hop decision. Null derives it from the VM's own kernel,
 * never from routing.inference.
 */
export function prepareWorkerPayload({
  body,
  reqHeaders,
  exec,
  identity,
  routing,
  want1m = false,
  cliHop = false,
  cragPrint = null,
  requestContext = null,
  repaired = false,
} = {}) {
  const health = exec?.workerStatus
  const print = nativeCragRequest(exec, cragPrint)
  const canonicalBody = print ? prepareCragRequest(body) : prepareCliNodeRequest(body)
  const model = canonicalBody?.model || ''
  const credMode = credentialModeFromOauth(exec?.vm?.claude || {})
  const headers = prepareOutboundHeaders(reqHeaders, exec?.homeDir, identity, model, {
    credentialMode: credMode,
    routing,
    want1m: want1m === true,
  })
  const displayed =
    requestContext?.purpose === 'auto_mode_classifier' || repaired
      ? canonicalBody
      : ensureOfficialPrintThinking(
          applyThinkingDisplay(canonicalBody, thinkingDisplayMode(routing)),
          ccEntrypointFromRouting(routing),
        )
  const main = stripSubagentBilling(displayed)
  const thread = pinThreadBetas(
    main,
    withRequestProtocolBetas(String(headers?.['anthropic-beta'] || '').split(','), main),
  )
  const betas = thread.betas
  headers['anthropic-beta'] = betas.join(',')
  // Envelope headers are discarded; the existing MessageRequest.betas channel
  // carries request gates to the native CLI, which builds the actual HTTP wire.
  const gated = cliHop ? { ...main, betas } : sanitizeAnthropicBodyForBetaTokens(main, headers['anthropic-beta'])
  const directed = gateCragBody(gated, print, health)
  return {
    headers,
    gated: directed,
    cliHop,
    routing,
    acceptsCallerCwd: print && Array.isArray(health?.capabilities) && health.capabilities.includes('caller_cwd'),
    thread: thread.turn,
  }
}

function sealPreparedPayload(prepared, gated) {
  return {
    headers: prepared.headers,
    body: sealClaudeCodeCch(gated, {
      enabled: prepared.routing?.compatibility?.cch_enabled !== false,
      seal: !prepared.cliHop,
    }),
    thread: prepared.thread,
  }
}

export function finalizeWorkerPayload(args = {}) {
  const prepared = prepareWorkerPayload(args)
  return sealPreparedPayload(prepared, prepared.gated)
}

async function workerEnvelope({
  requestContext = null,
  body,
  reqHeaders,
  exec,
  identity,
  routing,
  stream,
  deliveryMode,
  want1m = false,
  cacheTtl = null,
  preserveCacheBreakpoints = null,
  cliHop = false,
  cragPrint = null,
  callerCwd = null,
  repaired = false,
  redactionPrincipal = '',
  redactionSession = '',
} = {}) {
  const prepared = prepareWorkerPayload({
    body,
    reqHeaders,
    exec,
    identity,
    routing,
    want1m,
    cliHop,
    cragPrint,
    requestContext,
    repaired,
  })
  const redaction = await redactionContext({ routing, exec, redactionPrincipal, redactionSession })
  // Mask the separated path with the same policy as the original system text.
  const cwd = (prepared.acceptsCallerCwd && validateCallerCwd(callerCwd)) || undefined
  const masked = redaction ? await maskJson({ body: prepared.gated, caller_cwd: cwd }, redaction) : null
  const gated = redaction ? masked.body : prepared.gated
  const outgoingCwd = redaction ? validateCallerCwd(masked.caller_cwd) : cwd
  const finalized = sealPreparedPayload(prepared, gated)
  const envelope = {
    ...(requestContext ? { request_context: requestContext } : {}),
    ...(typeof outgoingCwd === 'string' ? { caller_cwd: outgoingCwd } : {}),
    body: finalized.body,
    headers: finalized.headers,
    stream: !!stream,
    delivery_mode: deliveryMode || 'realtime',
    preserve_cache_breakpoints: preserveCacheBreakpoints == null ? cacheTtl == null : preserveCacheBreakpoints === true,
    cache_ttl: cacheTtl == null ? null : String(cacheTtl),
  }
  dumpSessionEnvelope(envelope)
  return { envelope, thread: finalized.thread, redaction }
}

async function redactionContext({ routing, exec, redactionPrincipal, redactionSession }) {
  const projectRoot = exec?.projectRoot || process.env.KIN_PROJECT_ROOT || ''
  const state = await ensureRedaction(routing, { projectRoot })
  if (!state.enabled) return null
  return { principal: redactionPrincipal, session: redactionSession || '', maxBodyBytes: state.maxBodyBytes }
}

async function preparePrebuiltEnvelope(envelope, redaction, messages, exec, cragPrint) {
  // A prebuilt (e.g. Codex) envelope has no trusted Messages-side cwd source.
  const { caller_cwd: _callerCwd, ...out } = envelope
  if (messages) {
    delete out.gateway_policy
    const print = nativeCragRequest(exec, cragPrint)
    out.body = gateCragBody(
      print ? prepareCragRequest(out.body) : prepareCliNodeRequest(out.body),
      print,
      exec?.workerStatus,
    )
    if (out.headers && typeof out.headers === 'object') {
      out.headers = Object.fromEntries(
        Object.entries(out.headers).filter(([name]) => name.toLowerCase() !== 'x-tenant-id'),
      )
    }
  }
  if (out.body && Object.hasOwn(out.body, 'caller_cwd')) {
    const { caller_cwd: _bodyCwd, ...body } = out.body
    out.body = body
  }
  if (redaction && out.body) out.body = await maskJson(out.body, redaction)
  return out
}

function invalidKernelResult(error) {
  return {
    ok: false,
    status: 400,
    via: 'kernel-preflight',
    body: error.body,
    headers: {},
    terminalState: 'rejected',
    transportError: false,
    committed: false,
    upstreamExecutions: 0,
  }
}

function redactionResult(error) {
  if (!String(error?.code || '').startsWith('redaction_')) return null
  return {
    ok: false,
    status: error.status || 503,
    via: 'redaction',
    body: {
      type: 'error',
      error: {
        type: error.status === 413 ? 'invalid_request_error' : 'api_error',
        code: error.code,
        message: String(error.message || error).slice(0, 300),
        ...(error.status === 413 ? { details: { retryable: false } } : {}),
      },
    },
    headers: {},
    terminalState: 'rejected',
    transportError: false,
    committed: false,
    upstreamExecutions: 0,
  }
}

/**
 * 把这一跳真正 POST 给槽位 worker 的 envelope 交给调用方（请求日志据此记录出站 body / headers）。
 * 只是旁路观察：回调抛错也不能影响这一跳。
 */
function reportEnvelope(onEnvelope, envelope) {
  if (typeof onEnvelope !== 'function') return
  try {
    onEnvelope(envelope)
  } catch {}
}

function mockScenario(exec) {
  try {
    const configured = JSON.parse(process.env.KIN_MOCK_ACCOUNT_SCENARIOS || '{}')
    return configured?.[exec?.vmId] || null
  } catch {
    return null
  }
}

export async function callGoWorker({
  requestContext = null,
  exec,
  body,
  reqHeaders = {},
  timeoutMs,
  idleTimeoutMs,
  managedCrag = false,
  tenantId = '',
  slotWaitDeadlineMs,
  maxRequestBytes = 0,
  identity = null,
  routing,
  signal,
  want1m = false,
  cacheTtl = null,
  preserveCacheBreakpoints = null,
  requestPath = '/internal/v1/messages',
  envelope = null,
  cliHop = false,
  cragPrint = null,
  callerCwd = null,
  repaired = false,
  onEnvelope = null,
  redactionPrincipal = '',
  redactionSession = '',
} = {}) {
  if (isCrsMock()) {
    const { body: outboundBody, headers } = finalizeWorkerPayload({
      body,
      reqHeaders,
      exec,
      identity,
      routing,
      want1m,
      cliHop,
      cragPrint,
      requestContext,
      repaired,
    })
    reportEnvelope(onEnvelope, { body: outboundBody, headers })
    writeCrsTrace({ body: outboundBody, headers, stream: false })
    const mock = mockCrsPayload({ scenario: mockScenario(exec) })
    return {
      ...mock,
      via: 'go-worker-mock',
      terminalState: mock.ok ? 'verified' : 'error',
      usage: mock.body?.usage || null,
      model: mock.body?.model || null,
      stopReason: mock.body?.stop_reason || null,
    }
  }
  const requestId = randomUUID()
  let stopCancel = () => {}
  let nativeHandoff = false
  let handoff = null
  let observedHeaders = {}
  const nativeMetadata = () => (nativeHandoff ? handoff.metadata : { nativeHandoff: false, providerResult: null })
  try {
    const redaction = await redactionContext({ routing, exec, redactionPrincipal, redactionSession })
    const prepared = envelope
      ? {
          envelope: await preparePrebuiltEnvelope(
            envelope,
            redaction,
            requestPath === '/internal/v1/messages',
            exec,
            cragPrint,
          ),
          thread: null,
          redaction,
        }
      : await workerEnvelope({
          body,
          reqHeaders,
          exec,
          identity,
          routing,
          stream: false,
          want1m,
          cacheTtl,
          preserveCacheBreakpoints,
          cliHop,
          cragPrint,
          callerCwd,
          requestContext,
          repaired,
          redactionPrincipal,
          redactionSession,
        })
    reportEnvelope(onEnvelope, prepared.envelope)
    const useNativeHandoff = negotiateNativeHandoff(exec, {
      managedCrag,
      requestPath,
      requestContext,
      envelope: prepared.envelope,
    })
    if (useNativeHandoff) handoff = createNativeHandoffState()
    const response = await inferenceRequest(exec, {
      stream: false,
      managedCrag,
      nativeHandoff: useNativeHandoff,
      tenantId,
      slotWaitDeadlineMs,
      idleTimeoutMs,
      routing,
      requestPath,
      envelope: prepared.envelope,
      requestId,
      maxRequestBytes,
      inference: true,
      onRequestStarted: () => {
        nativeHandoff = useNativeHandoff
        stopCancel = cancelOnAbort(exec, signal, requestId)
      },
      signal,
      timeoutMs,
    })
    observedHeaders = mergeRateLimitHeaders(publicHeaders(response.headers))
    handoff?.observeHeaders(response.headers)
    const data = await readAll(response)
    const parsedRaw = await inferenceCodec.decode(data, { status: response.statusCode, signal })
    let parsed = prepared.redaction ? await restoreJsonValue(parsedRaw, prepared.redaction) : parsedRaw
    if (handoff) {
      handoff.observeHeaders(response.trailers)
      handoff.observeMessage(parsed?.type === 'error' ? null : parsed)
      parsed = handoff.finish(parsed)
    }
    const headers = mergeRateLimitHeaders(
      publicHeaders(nativeHandoff ? { ...response.headers, ...response.trailers } : response.headers),
    )
    const ok =
      response.statusCode >= 200 &&
      response.statusCode < 300 &&
      parsed?.type !== 'error' &&
      (!nativeHandoff || !parsed?.error)
    const result = restoreKernelErrorStatus({
      ok,
      status:
        nativeHandoff && parsed?.type === 'error' && response.statusCode < 400
          ? handoff.providerResult?.http_status || semanticStatusForStreamError(parsed)
          : response.statusCode || 0,
      via: 'go-worker',
      body: parsed,
      headers,
      usage: parsed?.usage || null,
      model: parsed?.model || null,
      stopReason: parsed?.stop_reason || null,
      terminalState: headers['x-terminal-state'] || null,
      transportError: false,
      threadBetas: prepared.thread,
      ...nativeMetadata(),
    })
    return classifyManagedQueueRejection(result, managedCrag)
  } catch (error) {
    const blocked = redactionResult(error)
    if (blocked) return { ...blocked, ...nativeMetadata() }
    if (error.code === 'invalid_kernel_request') return { ...invalidKernelResult(error), ...nativeMetadata() }
    if (signal?.aborted) return clientCancelledResult({ via: 'go-worker', ...nativeMetadata() })
    return {
      ok: false,
      status:
        nativeHandoff && handoff?.errorBody
          ? handoff.providerResult?.http_status || semanticStatusForStreamError(handoff.errorBody)
          : nativeHandoff
            ? error.status || 0
            : error.status === 413
              ? 413
              : 0,
      via: 'go-worker',
      body: handoff?.errorBody || {
        type: 'error',
        error: {
          type: error.status === 413 ? 'invalid_request_error' : 'worker_error',
          ...(error.status === 413 ? { details: { retryable: false } } : {}),
          code: error.code || 'worker_transport_error',
          message: String(error.message || error).slice(0, 300),
        },
      },
      headers: observedHeaders,
      ...nativeMetadata(),
      terminalState:
        nativeHandoff && String(error.code).startsWith('native_handoff_')
          ? 'incomplete'
          : error.status === 413
            ? 'rejected'
            : 'transport_error',
      transportError: error.status !== 413 && !(nativeHandoff && String(error.code).startsWith('native_handoff_')),
    }
  } finally {
    stopCancel()
  }
}

export async function streamGoWorker({
  requestContext = null,
  exec,
  body,
  reqHeaders = {},
  timeoutMs,
  idleTimeoutMs = 0,
  managedCrag = false,
  tenantId = '',
  slotWaitDeadlineMs,
  maxRequestBytes = 0,
  identity = null,
  routing,
  signal,
  deliveryMode = 'realtime',
  onEvent,
  onCommit,
  want1m = false,
  cacheTtl = null,
  preserveCacheBreakpoints = null,
  requestPath = '/internal/v1/messages',
  envelope = null,
  cliHop = false,
  cragPrint = null,
  callerCwd = null,
  repaired = false,
  onEnvelope = null,
  onOutboundHeaders = null,
  redactionPrincipal = '',
  redactionSession = '',
} = {}) {
  if (isCrsMock()) {
    const { body: outboundBody, headers } = finalizeWorkerPayload({
      body,
      reqHeaders,
      exec,
      identity,
      routing,
      want1m,
      cliHop,
      cragPrint,
      requestContext,
      repaired,
    })
    reportEnvelope(onEnvelope, { body: outboundBody, headers })
    writeCrsTrace({ body: outboundBody, headers, stream: true })
    const scenario = mockScenario(exec)
    const mockStartedAt = Date.now()
    if (scenario === 'incomplete_stream') {
      if (deliveryMode === 'verified') {
        return {
          ok: false,
          status: 502,
          via: 'go-worker-mock-stream',
          body: { type: 'error', error: { type: 'api_error', message: 'stream closed before message_stop' } },
          headers: {},
          terminalState: 'incomplete',
          committed: false,
        }
      }
      if (typeof onCommit === 'function') onCommit()
      if (onEvent) {
        await onEvent('event: message_start')
        await onEvent('data: {"type":"message_start","message":{"content":[]}}')
        await onEvent('')
        await onEvent('event: content_block_delta')
        await onEvent('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}')
        await onEvent('')
        await onEvent('event: error')
        await onEvent('data: {"type":"error","error":{"type":"api_error","message":"stream incomplete"}}')
        await onEvent('')
      }
      return {
        ok: false,
        status: 200,
        via: 'go-worker-mock-stream',
        body: { type: 'error', error: { type: 'api_error', message: 'stream incomplete' } },
        headers: {},
        terminalState: 'incomplete',
        committed: true,
      }
    }
    const payload = mockCrsPayload({ scenario })
    if (!payload.ok) {
      return {
        ...payload,
        via: 'go-worker-mock-stream',
        terminalState: 'rejected',
        committed: false,
      }
    }
    const mockTiming = createStreamTiming(mockStartedAt)
    await emitMockSse(async (line) => {
      if (line.startsWith('data:')) {
        try {
          mockTiming.observe(JSON.parse(line.slice(5)))
        } catch {}
        if (typeof onCommit === 'function') onCommit()
      }
      if (onEvent) await onEvent(line)
    }, payload)
    return {
      ...payload,
      via: 'go-worker-mock-stream',
      terminalState: payload.ok ? 'verified' : 'error',
      committed: !!payload.ok,
      usage: payload.body?.usage || null,
      model: payload.body?.model || null,
      stopReason: payload.body?.stop_reason || null,
      ...mockTiming.snapshot(),
    }
  }
  let committed = false
  const timing = createStreamTiming()
  const requestId = randomUUID()
  let stopCancel = () => {}
  let nativeHandoff = false
  let handoff = null
  let observedHeaders = {}
  const nativeMetadata = () => (nativeHandoff ? handoff.metadata : { nativeHandoff: false, providerResult: null })
  try {
    const redaction = await redactionContext({ routing, exec, redactionPrincipal, redactionSession })
    const prepared = envelope
      ? {
          envelope: await preparePrebuiltEnvelope(
            envelope,
            redaction,
            requestPath === '/internal/v1/messages',
            exec,
            cragPrint,
          ),
          thread: null,
          redaction,
        }
      : await workerEnvelope({
          body,
          reqHeaders,
          exec,
          identity,
          routing,
          stream: true,
          deliveryMode,
          want1m,
          cacheTtl,
          preserveCacheBreakpoints,
          cliHop,
          cragPrint,
          callerCwd,
          requestContext,
          repaired,
          redactionPrincipal,
          redactionSession,
        })
    reportEnvelope(onEnvelope, prepared.envelope)
    const useNativeHandoff = negotiateNativeHandoff(exec, {
      managedCrag,
      requestPath,
      requestContext,
      envelope: prepared.envelope,
    })
    if (useNativeHandoff) handoff = createNativeHandoffState()
    const response = await inferenceRequest(exec, {
      stream: true,
      deliveryMode,
      managedCrag,
      nativeHandoff: useNativeHandoff,
      tenantId,
      slotWaitDeadlineMs,
      idleTimeoutMs,
      routing,
      requestPath,
      envelope: prepared.envelope,
      requestId,
      maxRequestBytes,
      inference: true,
      onRequestStarted: () => {
        nativeHandoff = useNativeHandoff
        stopCancel = cancelOnAbort(exec, signal, requestId)
      },
      signal,
      timeoutMs,
    })
    const headers = mergeRateLimitHeaders(publicHeaders(response.headers))
    observedHeaders = headers
    handoff?.observeHeaders(response.headers)
    if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
      const data = await readAll(response, 1024 * 1024)
      const decoded = await inferenceCodec.decode(data, { status: response.statusCode, signal })
      handoff?.observeHeaders(response.trailers)
      // A real HTTP error remains the failure, even if handoff metadata is absent.
      const result = restoreKernelErrorStatus({
        ok: false,
        status: response.statusCode || 0,
        via: 'go-worker-stream',
        body: decoded,
        headers,
        committed: false,
        terminalState: headers['x-terminal-state'] || 'error',
        transportError: false,
        threadBetas: prepared.thread,
        ...nativeMetadata(),
      })
      return classifyManagedQueueRejection(result, managedCrag)
    }
    if (nativeHandoff) {
      const received = await consumeNativeHandoffStream(response, {
        state: handoff,
        deliveryMode,
        onEvent,
        isCommitEvent: isDownstreamCommitEvent,
        onCommit: () => {
          committed = true
          onCommit?.()
        },
        onObserve: (event) => {
          timing.observe(event)
          if (event.type === 'message_start') rememberThreadTurn(event.message?.id, prepared.thread)
        },
        onProviderResult: (result) => {
          // Freeze the already-observed generation window at the native stop;
          // internal metadata alone must not start a TTFT/generation clock.
          if (result.stop_reason && timing.snapshot().firstByteAt != null) {
            timing.observe({ type: 'message_delta', delta: { stop_reason: result.stop_reason } })
          }
        },
        restoreEvent: prepared.redaction ? (event) => restoreJsonValue(event, prepared.redaction) : null,
        onOutboundHeaders: (event) => {
          if (
            !event.headers ||
            typeof event.headers !== 'object' ||
            Array.isArray(event.headers) ||
            typeof onOutboundHeaders !== 'function'
          )
            return
          try {
            const body = event.body == null ? undefined : capOutboundBody(event.body)
            onOutboundHeaders(event.headers, {
              body,
              body_truncated: event.body_truncated === true || (typeof event.body === 'string' && body !== event.body),
            })
          } catch {
            console.warn('[worker] outbound header observer failed')
          }
        },
      })
      const body = received.body
      const failed = body?.type === 'error' || !!body?.error
      const trailers = publicHeaders(response.trailers)
      return {
        ok: !failed,
        status: failed
          ? handoff.providerResult?.http_status || semanticStatusForStreamError(body)
          : response.statusCode,
        via: 'go-worker-stream',
        body,
        headers: mergeRateLimitHeaders(publicHeaders({ ...received.headers, ...headers, ...trailers })),
        ...nativeMetadata(),
        ...timing.snapshot(),
        sawMessageStop: received.sawMessageStop,
        committed,
        terminalState: failed ? 'incomplete' : 'verified',
        transportError: false,
        threadBetas: prepared.thread,
      }
    }
    let buffer = ''
    let receivedAt = null
    let lastError = null
    let dataBuf = ''
    let sseUsage = null
    let sseModel = null
    let sseStop = null
    let sseRateHeaders = {}
    const assembler = createClaudeMessageAssembler()
    const pendingLines = []
    const takeSseEvent = () => {
      try {
        const event = JSON.parse(dataBuf)
        dataBuf = ''
        return event && typeof event === 'object' ? event : null
      } catch {
        return null
      }
    }
    const flushCommit = async () => {
      if (committed) return
      committed = true
      if (typeof onCommit === 'function') onCommit()
      if (onEvent) {
        for (const queued of pendingLines) await onEvent(queued)
      }
      pendingLines.length = 0
    }
    const emitLine = async (line) => {
      if (!committed) {
        pendingLines.push(line)
        return
      }
      if (onEvent) await onEvent(line)
    }
    const observeSseEvent = (event) => {
      if (!event) return event
      timing.observe(event, receivedAt)
      if (event.type === 'response_headers' && event.headers && typeof event.headers === 'object') {
        sseRateHeaders = { ...sseRateHeaders, ...event.headers }
      }
      if (event.type === 'error') lastError = event
      if (event.type === 'message_stop') sawMessageStop = true
      if (event.type === 'message_start') rememberThreadTurn(event.message?.id, prepared.thread)
      const evUsage = usageFromSseEvent(event)
      if (evUsage) sseUsage = mergeUsage(sseUsage, evUsage)
      if (event.message?.model) sseModel = event.message.model
      const stop = event.message?.stop_reason || event.delta?.stop_reason
      if (stop) sseStop = stop
      return event
    }
    const firstByteMs = Math.max(0, Number(timeoutMs) || 0)
    const idleMs = Math.max(0, Number(idleTimeoutMs) || 0)
    let lastChunkAt = Date.now()
    let sawChunk = false
    let sawMessageStop = false
    let outboundHeadersFrame = false
    let idleTimer = null
    if (!managedCrag && (firstByteMs > 0 || idleMs > 0)) {
      idleTimer = setInterval(() => {
        const limit = sawChunk ? idleMs : firstByteMs
        if (limit <= 0) return
        if (Date.now() - lastChunkAt < limit) return
        const which = sawChunk ? 'idle' : 'first-byte'
        response.destroy(
          Object.assign(new Error(`slot worker ${which} timeout after ${limit}ms`), { code: 'worker_timeout' }),
        )
      }, 1000)
      idleTimer.unref?.()
    }
    try {
      // message_stop is the protocol terminal event, but the kernel still sends
      // job_done and its trailers afterward. Keep reading until the worker
      // closes the response so a normal completion is not mistaken for cancel.
      const sseRestorer = prepared.redaction ? createSseRestorer(prepared.redaction) : null
      for await (const chunk of response) {
        receivedAt = Date.now()
        buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
        let newline
        while ((newline = buffer.indexOf('\n')) >= 0) {
          let line = buffer.slice(0, newline).replace(/\r$/, '')
          if (sseRestorer) line = await sseRestorer.line(line)
          buffer = buffer.slice(newline + 1)
          // CLI diagnostics share the internal stream, never the caller's SSE.
          if (line.startsWith('event:'))
            outboundHeadersFrame = ['kin_outbound_headers', 'kin_provider_result'].includes(line.slice(6).trim())
          if (outboundHeadersFrame) {
            if (line.startsWith('data:')) {
              const event = parseJson(line.slice(5).trim())
              if (
                event?.type === 'kin_outbound_headers' &&
                event.headers &&
                typeof event.headers === 'object' &&
                !Array.isArray(event.headers) &&
                typeof onOutboundHeaders === 'function'
              ) {
                try {
                  const body = event.body == null ? undefined : capOutboundBody(event.body)
                  onOutboundHeaders(event.headers, {
                    body,
                    body_truncated:
                      event.body_truncated === true || (typeof event.body === 'string' && body !== event.body),
                  })
                } catch {
                  console.warn('[worker] outbound header observer failed')
                }
              }
            }
            if (line === '') outboundHeadersFrame = false
            continue
          }
          if (line) {
            sawChunk = true
            lastChunkAt = Date.now()
          }
          applyClaudeSSELineToMessage(line, assembler)
          if (line.startsWith('data:')) {
            const piece = line.slice(5).trim()
            if (piece && piece !== '[DONE]') {
              dataBuf = dataBuf ? `${dataBuf}\n${piece}` : piece
              const event = observeSseEvent(takeSseEvent())
              if (isDownstreamCommitEvent(event)) await flushCommit()
            }
          } else if (line === '') {
            if (dataBuf) {
              const event = takeSseEvent()
              dataBuf = ''
              observeSseEvent(event)
              if (isDownstreamCommitEvent(event)) await flushCommit()
            }
          } else if (dataBuf && !line.startsWith('event:') && !line.startsWith(':')) {
            dataBuf = `${dataBuf}\n${line}`
            const event = observeSseEvent(takeSseEvent())
            if (isDownstreamCommitEvent(event)) await flushCommit()
          }
          await emitLine(line)
        }
        if (sawChunk && !outboundHeadersFrame && buffer) lastChunkAt = Date.now()
      }
      if (buffer && !outboundHeadersFrame) {
        applyClaudeSSELineToMessage(buffer, assembler)
        if (buffer.startsWith('data:')) {
          const piece = buffer.slice(5).trim()
          if (piece && piece !== '[DONE]') {
            dataBuf = dataBuf ? `${dataBuf}\n${piece}` : piece
            const event = observeSseEvent(takeSseEvent())
            if (isDownstreamCommitEvent(event)) await flushCommit()
          }
        }
        await emitLine(buffer)
      }
      if (dataBuf) {
        const event = observeSseEvent(takeSseEvent())
        if (isDownstreamCommitEvent(event)) await flushCommit()
      }
      const trailers = mergeRateLimitHeaders(publicHeaders(response.trailers))
      const meta = streamMetaFromHeaders({ ...headers, ...trailers })
      const assembled = assembler.message
      const stopReason = meta.stopReason || sseStop || assembled?.stop_reason || null
      const complete = !lastError && isCompleteAssistantMessage({ body: assembled, stopReason, sawMessageStop })
      if (!committed && complete) await flushCommit()
      const terminalState = complete ? 'verified' : 'incomplete'
      const rateHeaders = mergeRateLimitHeaders({ ...sseRateHeaders, ...headers, ...trailers })
      // A native activity timeout can follow HTTP/SSE metadata but precede
      // visible output. It is neither an empty hop nor a transport failure.
      const nativeTimeout = managedCrag && lastError?.error?.type === 'timeout_error'
      return restoreUncommittedHop({
        ok: response.statusCode === 200 && !lastError && complete,
        status: nativeTimeout && !committed ? 504 : response.statusCode || 0,
        via: 'go-worker-stream',

        body: lastError || assembled || { type: 'message', role: 'assistant', content: [] },
        headers: rateHeaders,
        // Trailer stays authoritative, but it may carry totals only (Codex/Responses hops).
        // Merge so SSE `input_tokens_details` / cache breakdown survives instead of being short-circuited.
        usage: mergeUsage(mergeUsage(assembled?.usage || null, sseUsage), meta.usage),
        model: meta.model || sseModel || assembled?.model || null,
        stopReason,
        sawMessageStop,
        ...timing.snapshot(),
        committed,
        terminalState: nativeTimeout && !committed ? 'rejected' : terminalState,
        transportError: false,
        threadBetas: prepared.thread,
      })
    } finally {
      if (idleTimer) clearInterval(idleTimer)
    }
  } catch (error) {
    const blocked = redactionResult(error)
    if (blocked) return { ...blocked, ...timing.snapshot(), committed, ...nativeMetadata() }
    if (error.code === 'invalid_kernel_request')
      return { ...invalidKernelResult(error), ...timing.snapshot(), committed, ...nativeMetadata() }
    if (signal?.aborted) {
      return clientCancelledResult({
        via: 'go-worker-stream',
        ...timing.snapshot(),
        committed,
        ...nativeMetadata(),
      })
    }
    return {
      ok: false,
      status:
        nativeHandoff && handoff?.errorBody
          ? handoff.providerResult?.http_status || semanticStatusForStreamError(handoff.errorBody)
          : nativeHandoff
            ? error.status || 0
            : error.status === 413
              ? 413
              : 0,
      via: 'go-worker-stream',
      body: handoff?.errorBody || {
        type: 'error',
        error: {
          type: error.status === 413 ? 'invalid_request_error' : 'worker_error',
          ...(error.status === 413 ? { details: { retryable: false } } : {}),
          code: error.code || 'worker_transport_error',
          message: String(error.message || error).slice(0, 300),
        },
      },
      headers: observedHeaders,
      ...nativeMetadata(),
      ...timing.snapshot(),
      committed,
      terminalState:
        committed || (nativeHandoff && String(error.code).startsWith('native_handoff_'))
          ? 'incomplete'
          : error.status === 413
            ? 'rejected'
            : 'transport_error',
      transportError: error.status !== 413 && !(nativeHandoff && String(error.code).startsWith('native_handoff_')),
    }
  } finally {
    stopCancel()
  }
}

export async function workerHealth(exec, { timeoutMs = 3000, signal } = {}) {
  if (isCrsMock()) {
    const claude = exec?.vm?.claude || {}
    const hasCredential = hasCredentialPresence(claude)
    return {
      ok: hasCredential,
      status: hasCredential ? 'ready' : 'degraded',
      vm_id: exec?.vmId || null,
      proxy_configured: true,
      credential: {
        has_access: hasAccessPresence(claude),
        has_refresh: hasRefreshPresence(claude),
        generation: 1,
        needs_refresh: !hasAccessPresence(claude),
      },
      source: 'go-worker-mock',
    }
  }
  try {
    const response = await workerRequest(exec, {
      requestPath: '/internal/health',
      timeoutMs,
      signal,
    })
    const body = parseJson(await readAll(response, 1024 * 1024))
    return { ok: response.statusCode === 200 && body?.ok === true, status: response.statusCode || 0, ...body }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: String(error.message || error).slice(0, 300),
      code: error.code || 'worker_unavailable',
    }
  }
}

export async function ensureWorkerCredential(exec, { force = false } = {}) {
  if (isCrsMock()) {
    return {
      ok: true,
      status: 200,
      refreshed: !!force,
      credential: {
        has_access: hasAccessPresence(exec?.vm?.claude),
        has_refresh: hasRefreshPresence(exec?.vm?.claude),
        generation: exec?.vm?.claude?._token_version || 1,
      },
    }
  }

  if (exec?.homeDir) ensureOfficialCredentialLink(exec.homeDir)
  const credential = readWorkerCredentialFile(exec.homeDir)
  if (!credential) {
    return {
      ok: false,
      status: 400,
      refreshed: false,
      error: { code: 'credential_required', message: 'slot has no credential file' },
    }
  }

  const now = Date.now()
  const apiKey = isApiKeyMode(credential.type || credential.mode)
  if (!apiKey && authLoginBlocksRefresh(exec?.homeDir, now)) {
    return {
      ok: true,
      status: 200,
      refreshed: false,
      refresh_class: 'login_in_progress',
      credential: credentialSummary(credential, now),
    }
  }
  const alreadyFresh = apiKey || (!force && !needsRefresh(credential.expires_at, now, REFRESH_SKEW_MS))
  if (alreadyFresh) {
    return {
      ok: true,
      status: 200,
      refreshed: false,
      refresh_class: 'already_fresh',
      credential: credentialSummary(credential, now),
    }
  }

  const snapshotRefresh = String(credential.refresh_token || '')
  const lockKey = String(exec.homeDir || exec.vm?.id || 'credential')
  return withCredentialRefreshLock(lockKey, async () => {
    if (exec?.homeDir) ensureOfficialCredentialLink(exec.homeDir)
    if (!apiKey && authLoginBlocksRefresh(exec?.homeDir)) {
      const held = readWorkerCredentialFile(exec.homeDir) || credential
      return {
        ok: true,
        status: 200,
        refreshed: false,
        refresh_class: 'login_in_progress',
        credential: credentialSummary(held, Date.now()),
      }
    }
    const live = readWorkerCredentialFile(exec.homeDir) || credential
    const liveRefresh = String(live?.refresh_token || '')
    if (snapshotRefresh && liveRefresh && snapshotRefresh !== liveRefresh) {
      return {
        ok: true,
        status: 200,
        refreshed: false,
        refresh_class: 'already_fresh',
        credential: credentialSummary(live, Date.now()),
      }
    }
    const liveNow = Date.now()
    if (!force && !needsRefresh(live.expires_at, liveNow, REFRESH_SKEW_MS) && !isApiKeyMode(live.type || live.mode)) {
      return {
        ok: true,
        status: 200,
        refreshed: false,
        refresh_class: 'already_fresh',
        credential: credentialSummary(live, liveNow),
      }
    }
    const result = await runSlotOauth(exec, 'refresh', { force: !!force })
    const body = result?.body || {}
    const refreshedCredential = readWorkerCredentialFile(exec.homeDir)
    const mapped = {
      ok: !!result?.ok,
      status: result?.status || 0,
      refreshed: !!body.refreshed,
      refresh_class: result?.ok ? (body.refreshed ? 'rotated' : 'already_fresh') : undefined,
      credential: result?.ok ? credentialSummary({ ...(refreshedCredential || {}), ...body }, Date.now()) : undefined,
      error: result?.ok ? undefined : body.error,
    }
    if (!mapped.ok) mapped.refresh_class = classifyCredentialRefresh(mapped)
    return mapped
  })
}

export function credentialSummary(credential, now = Date.now()) {
  if (!credential) return undefined
  const expiresAt = credential.expires_at ?? null
  const expiresAtMs =
    Number(expiresAt) && Number(expiresAt) < 10_000_000_000 ? Number(expiresAt) * 1000 : Number(expiresAt)
  return {
    type: credential.type || credential.mode || null,
    mode: credential.mode || credential.type || null,
    account_uuid: credential.account_uuid || null,
    org_uuid: credential.org_uuid || null,
    email: credential.email || null,
    scope: credential.scope || null,
    auth_scheme: credential.auth_scheme || null,
    has_access: credential.has_access ?? !!(credential.access_token || credential.api_key),
    has_refresh: credential.has_refresh ?? !!credential.refresh_token,
    needs_refresh: isApiKeyMode(credential.type || credential.mode)
      ? false
      : needsRefresh(expiresAt, now, REFRESH_SKEW_MS),
    expires_at: expiresAt,
    ttl_seconds:
      Number.isFinite(expiresAtMs) && expiresAtMs > 0 ? Math.max(0, Math.ceil((expiresAtMs - now) / 1000)) : null,
    generation: credential._token_version || null,
  }
}

export async function importWorkerCredential(exec, credential, { timeoutMs = 60000, signal } = {}) {
  return withCredentialRefreshLock(String(exec.homeDir || exec.vm?.id || 'credential'), async () => {
    try {
      if (!writeWorkerCredentialFile(exec.homeDir, credential)) throw new Error('credential_required')
      // Import is the one case where the control plane's credential replaces the slot's copy.
      await slotHost(exec.vm).onImport(exec.vm, path.dirname(exec.homeDir))
    } catch (error) {
      return {
        ok: false,
        status: 500,
        error: { code: 'credential_import_failed', message: '凭证导入未完成，请检查 VM 连接后重试面板导入' },
      }
    }
    return {
      ok: true,
      status: 200,
      credential: {
        has_access: !!credential?.access_token || !!credential?.api_key,
        has_refresh: !!credential?.refresh_token,
        expires_at: credential?.expires_at || null,
        generation: Date.now(),
      },
    }
  })
}

export async function syncClaudeClientCredentials(
  exec,
  { host = slotHost(exec.vm), ensureRemoteLink = ensureRemoteOfficialCredentialLink } = {},
) {
  return withCredentialRefreshLock(String(exec.homeDir || exec.vm?.id || 'credential'), async () => {
    try {
      const slotDir = path.dirname(exec.homeDir)
      if (host.kind === 'node') {
        const pulled = await host.afterRefresh(exec.vm, slotDir)
        if (pulled?.reason === 'remote_missing') throw new Error('remote_missing')
        const linked = await ensureRemoteLink(exec.vm, slotDir)
        if (!linked?.linked) throw new Error('remote_link_failed')
      }
      const credential = readWorkerCredentialFile(exec.homeDir)
      if (!credential?.access_token && !credential?.api_key) {
        return { ok: false, status: 409, error: { code: 'credential_required', message: '请先在面板导入凭证' } }
      }
      const linked = ensureOfficialCredentialLink(exec.homeDir, { adoptOfficial: false })
      if (!linked.linked) throw new Error('credential_link_failed')
      return { ok: true, synced: true, credential: credentialSummary(credential) }
    } catch {
      return {
        ok: false,
        status: 502,
        error: {
          code: 'client_credential_sync_failed',
          message: '客户端凭证同步失败，请检查 VM 连接后重试同步；无需重新换票',
        },
      }
    }
  })
}

export async function callWorkerPost(exec, requestPath, body, { timeoutMs = 20000, signal } = {}) {
  try {
    const response = await workerRequest(exec, {
      method: 'POST',
      requestPath,
      body,
      timeoutMs,
      signal,
      maxRequestBytes: 8192,
    })
    const parsed = parseJson(await readAll(response, 16384), response.statusCode)
    return {
      ok: response.statusCode >= 200 && response.statusCode < 300 && parsed?.ok !== false,
      status: response.statusCode || 0,
      body: parsed,
      headers: publicHeaders(response.headers),
      via: 'go-worker',
    }
  } catch (error) {
    return {
      ok: false,
      status: error.status === 413 ? 413 : 0,
      body: { error: { code: error.code || 'worker_transport_error', message: 'Slot control request failed' } },
      headers: {},
      via: 'go-worker',
      transportError: error.status !== 413,
    }
  }
}

export async function callWorkerGet(exec, requestPath, { timeoutMs = 30000, signal } = {}) {
  if (isCrsMock()) {
    if (requestPath === '/internal/v1/models') {
      return {
        ok: true,
        status: 200,
        body: {
          object: 'list',
          data: [
            {
              id: process.env.KIN_MOCK_MODEL || 'claude-haiku-4-5-20251001',
              object: 'model',
              owned_by: 'anthropic',
            },
          ],
        },
        headers: {},
        via: 'go-worker-mock',
      }
    }
    if (requestPath === '/internal/identity') {
      return {
        ok: true,
        status: 200,
        body: {
          ok: true,
          identity: {
            schema_version: '1',
            runtime_kind: exec?.vm?.runtime?.type || 'docker',
            hostname: exec?.vmId || 'mock',
            os_pretty: 'Mock OS',
            arch: 'x64',
            goos: 'linux',
            worker_version: 'mock',
            collected_at: new Date().toISOString(),
          },
        },
        headers: {},
        via: 'go-worker-mock',
      }
    }
    if (requestPath === '/internal/oauth/usage') {
      return {
        ok: true,
        status: 200,
        body: {
          five_hour: { utilization: 0.12, resets_at: '2026-08-19T20:00:00Z' },
          seven_day: { utilization: 0.34, resets_at: '2026-08-25T00:00:00Z' },
          limits: [
            {
              kind: 'weekly_scoped',
              percent: 21,
              resets_at: '2026-08-25T00:00:00Z',
              scope: { model: { display_name: 'Fable' } },
            },
          ],
        },
        headers: {},
        via: 'go-worker-mock',
      }
    }
  }
  if (requestPath === '/internal/v1/models') {
    return runSlotOauth(exec, 'models', { timeoutMs })
  }
  if (requestPath === '/internal/oauth/usage') {
    return runSlotOauth(exec, 'usage', { timeoutMs })
  }
  try {
    const response = await workerRequest(exec, { requestPath, timeoutMs, signal })
    const data = await readAll(response)
    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode || 0,
      body: parseJson(data),
      headers: mergeRateLimitHeaders(publicHeaders(response.headers)),
      via: 'go-worker',
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: {
        error: { code: error.code || 'worker_unavailable', message: String(error.message || error).slice(0, 300) },
      },
      headers: {},
      via: 'go-worker',
      transportError: true,
    }
  }
}

export async function countTokensViaWorker(exec, { body, headers = {}, timeoutMs = 45000 } = {}) {
  if (isCrsMock()) {
    return { ok: true, status: 200, body: { input_tokens: 8 }, headers: {}, via: 'go-worker-mock' }
  }
  return runSlotOauth(exec, 'count-tokens', { body, headers, timeoutMs })
}
