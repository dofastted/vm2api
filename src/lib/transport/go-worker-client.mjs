import http from 'node:http'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { prepareOutboundHeaders } from '../protocol/outbound-attempt.mjs'
import { sanitizeAnthropicBodyForBetaTokens } from '../protocol/anthropic-policy.mjs'
import { withRequestProtocolBetas } from '../protocol/claude-code-betas.mjs'
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
} from '../oauth/oauth-credentials.mjs'
import { isApiKeyMode } from '../oauth/credential-mode.mjs'
import { runSlotOauth } from './slot-oauth.mjs'
import { slotHost } from '../vm/slot-host.mjs'
import { applyClaudeSSELineToMessage, createClaudeMessageAssembler } from '../protocol/convert.mjs'
import {
  clientCancelledResult,
  isClientCancelledResult,
  isCompleteAssistantMessage,
  isWrapConnectionError,
} from '../core/errors.mjs'
import { extraHeadersFromLimitError, isPlanLimitMessage } from '../pool/quota-window.mjs'

const MAX_BODY = 64 * 1024 * 1024
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
  const runDir = exec.vm?.runtime?.worker_run_dir || (slotRoot ? path.join(slotRoot, 'run') : null)
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

function workerRequest(
  exec,
  { method = 'GET', requestPath, body = null, signal, timeoutMs = 180000, timeoutMode = 'overall', headers = {} } = {},
) {
  return new Promise((resolve, reject) => {
    const { socketPath } = workerPaths(exec)
    if (!socketPath) {
      reject(Object.assign(new Error('slot worker socket is not configured'), { code: 'worker_socket_missing' }))
      return
    }
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    const internalToken = readInternalToken(exec)
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
    arm(timeoutMs, `slot worker timeout after ${timeoutMs}ms`)
    req.once('close', clearTimer)
    req.once('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/**
 * Client went away: name the hop to the kernel so it cancels that job on the
 * CLI right now. The dropped socket alone left the kernel guessing whether
 * the CLI still owned the job. Best effort: the kernel also sees the drop,
 * and an old worker without the route just answers 404.
 */
function cancelOnAbort(exec, signal, requestId) {
  if (!signal || signal.aborted) return () => {}
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

function parseJson(buffer) {
  try {
    return JSON.parse(String(buffer || ''))
  } catch {
    return {
      type: 'error',
      error: { type: 'worker_error', code: 'worker_invalid_json', message: String(buffer || '').slice(0, 400) },
    }
  }
}

function publicHeaders(headers = {}) {
  const result = {}
  for (const [key, value] of Object.entries(headers || {})) {
    if (value == null) continue
    const lower = String(key).toLowerCase()
    if (lower === 'set-cookie' || lower === 'authorization' || lower === 'x-api-key') continue
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

function mergeUsage(current, next) {
  if (!next || typeof next !== 'object') return current
  const out = { ...(current || {}) }
  for (const [key, value] of Object.entries(next)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = { ...(typeof out[key] === 'object' && out[key] ? out[key] : {}), ...value }
    } else {
      out[key] = value
    }
  }
  return out
}

/** First user-visible assistant output — never transport/terminal metadata alone. */
export function isDownstreamCommitEvent(event) {
  if (!event || typeof event !== 'object') return false
  const t = String(event.type || '')
  if (t === 'error' || t === 'message_start' || t === 'response_headers') return false
  if (t === 'message_stop' || t === 'response.completed' || t === 'response.done' || t === 'message_delta') return false

  if (t === 'content_block_delta') {
    const d = event.delta || {}
    return !!(d.text || d.thinking || d.partial_json || d.refusal || d.signature)
  }
  if (t === 'content_block_start') {
    const b = event.content_block || {}
    const kind = String(b.type || '')
    return (
      kind === 'text' ||
      kind === 'thinking' ||
      kind === 'redacted_thinking' ||
      kind === 'refusal' ||
      kind === 'tool_use' ||
      kind === 'server_tool_use' ||
      kind === 'mcp_tool_use' ||
      kind.endsWith('_tool_use') ||
      !!(b.text || b.thinking)
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

const AUTH_ERROR_TEXT =
  /authentication_error|token has been revoked|oauth_revoked|invalid_grant|invalid (?:bearer|x-api-key)|OAuth token has expired/i
// cli-hop can flatten an organization permission denial into generic api_error.
// Preserve the denial instead of replacing it with an empty-hop error.
const PERMISSION_ERROR_TEXT = /organization does not have access to claude/i

/**
 * The kernel cli-hop answers 200 and then streams `event: error` (sub2api
 * sseStreamErrorEventError). Before any downstream byte, restore the HTTP
 * status the upstream meant so the pool classifies it like a real response.
 */
export function semanticStatusForStreamError(errorBody) {
  const type = String(errorBody?.error?.type || errorBody?.type || '')
  const message = String(errorBody?.error?.message || errorBody?.message || '')
  if (isPlanLimitMessage(message)) return 429
  // The kernel names the status the job failed with; older kernels did not.
  const explicit = Number(errorBody?.error?.status)
  if (explicit >= 400 && explicit < 600) return explicit
  if (type === 'rate_limit_error') return 429
  if (type === 'overloaded_error') return 529
  if (type === 'authentication_error' || AUTH_ERROR_TEXT.test(message)) return 401
  if (type === 'permission_error' || PERMISSION_ERROR_TEXT.test(message)) return 403
  if (type === 'invalid_request_error') return 400
  return 502
}

/**
 * Kernel `map_kernel` folds every provider failure into 502 `provider_error`.
 * Restore recognized permission denials and plan-limit / overload statuses.
 */
export function restoreKernelErrorStatus(result = {}, { now = Date.now() } = {}) {
  if (!result || result.ok || Number(result.status) !== 502) return result
  const body = result.body
  if (!(body?.type === 'error' || body?.error)) return result
  const status = semanticStatusForStreamError(body)
  if (status !== 403 && status !== 429 && status !== 529) return result
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
      note: 'This is the JSON body+headers the slot worker POSTs to api.anthropic.com/v1/messages. Authorization is attached by the worker from OAuth and is not in this envelope.',
      stream: envelope.stream,
      delivery_mode: envelope.delivery_mode,
      headers,
      body: envelope.body,
    }
    const name = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}-envelope.json`
    fs.writeFileSync(path.join(dir, name), JSON.stringify(rec, null, 2))
  } catch {}
}

/**
 * `cliHop`: the slot cli-node builds the wire and always sends
 * mid-conversation-system; the kernel drops these envelope headers. Gating the
 * body on the VM's HTTP betas would lift every role=system turn into system[],
 * so system grows each turn and no cached prefix is ever read.
 */
export function finalizeWorkerPayload({ body, reqHeaders, exec, identity, want1m = false, cliHop = false }) {
  const model = body?.model || ''
  const credMode = credentialModeFromOauth(exec?.vm?.claude || {})
  const headers = prepareOutboundHeaders(reqHeaders, exec?.homeDir, identity, model, {
    credentialMode: credMode,
    want1m: want1m === true,
  })
  const betas = withRequestProtocolBetas(String(headers?.['anthropic-beta'] || '').split(','), body)
  headers['anthropic-beta'] = betas.join(',')
  // Envelope headers are discarded; the existing MessageRequest.betas channel
  // carries request gates to the native CLI, which builds the actual HTTP wire.
  const gated = cliHop ? { ...body, betas } : sanitizeAnthropicBodyForBetaTokens(body, headers['anthropic-beta'])
  return { headers, body: sealClaudeCodeCch(gated) }
}

function workerEnvelope({
  requestContext = null,
  body,
  reqHeaders,
  exec,
  identity,
  stream,
  deliveryMode,
  want1m = false,
  cacheTtl = null,
  preserveCacheBreakpoints = null,
  cliHop = false,
} = {}) {
  const finalized = finalizeWorkerPayload({ body, reqHeaders, exec, identity, want1m, cliHop })
  const envelope = {
    ...(requestContext ? { request_context: requestContext } : {}),
    body: finalized.body,
    headers: finalized.headers,
    stream: !!stream,
    delivery_mode: deliveryMode || 'realtime',
    preserve_cache_breakpoints: preserveCacheBreakpoints == null ? cacheTtl == null : preserveCacheBreakpoints === true,
    cache_ttl: cacheTtl == null ? null : String(cacheTtl),
  }
  dumpSessionEnvelope(envelope)
  return envelope
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
  identity = null,
  signal,
  want1m = false,
  cacheTtl = null,
  preserveCacheBreakpoints = null,
  requestPath = '/internal/v1/messages',
  envelope = null,
  cliHop = false,
} = {}) {
  if (isCrsMock()) {
    const { body: outboundBody, headers } = finalizeWorkerPayload({ body, reqHeaders, exec, identity, want1m, cliHop })
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
  const stopCancel = cancelOnAbort(exec, signal, requestId)
  try {
    const response = await workerRequest(exec, {
      method: 'POST',
      requestPath,
      body: {
        ...(envelope ||
          workerEnvelope({
            body,
            reqHeaders,
            exec,
            identity,
            stream: false,
            want1m,
            cacheTtl,
            preserveCacheBreakpoints,
            cliHop,
            requestContext,
          })),
        request_id: requestId,
      },
      signal,
      timeoutMs,
    })
    const data = await readAll(response)
    const parsed = parseJson(data)
    const headers = mergeRateLimitHeaders(publicHeaders(response.headers))
    return restoreKernelErrorStatus({
      ok: response.statusCode >= 200 && response.statusCode < 300 && parsed?.type !== 'error',
      status: response.statusCode || 0,
      via: 'go-worker',
      body: parsed,
      headers,
      usage: parsed?.usage || null,
      model: parsed?.model || null,
      stopReason: parsed?.stop_reason || null,
      terminalState: headers['x-terminal-state'] || null,
      transportError: false,
    })
  } catch (error) {
    return {
      ok: false,
      status: 0,
      via: 'go-worker',
      body: {
        type: 'error',
        error: {
          type: 'worker_error',
          code: error.code || 'worker_transport_error',
          message: String(error.message || error).slice(0, 300),
        },
      },
      headers: {},
      terminalState: 'transport_error',
      transportError: true,
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
  identity = null,
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
} = {}) {
  if (isCrsMock()) {
    const { body: outboundBody, headers } = finalizeWorkerPayload({ body, reqHeaders, exec, identity, want1m, cliHop })
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
    let mockTtftMs = null
    await emitMockSse(async (line) => {
      if (line.startsWith('data:')) {
        if (mockTtftMs == null) mockTtftMs = Date.now() - mockStartedAt
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
      ttftMs: mockTtftMs,
    }
  }
  let committed = false
  const startedAt = Date.now()
  let ttftMs = null
  const requestId = randomUUID()
  const stopCancel = cancelOnAbort(exec, signal, requestId)
  try {
    const response = await workerRequest(exec, {
      method: 'POST',
      requestPath,
      body: {
        ...(envelope ||
          workerEnvelope({
            body,
            reqHeaders,
            exec,
            identity,
            stream: true,
            deliveryMode,
            want1m,
            cacheTtl,
            preserveCacheBreakpoints,
            cliHop,
            requestContext,
          })),
        request_id: requestId,
      },
      signal,
      timeoutMs,
      timeoutMode: 'first-byte',
      headers: { te: 'trailers' },
    })
    const headers = mergeRateLimitHeaders(publicHeaders(response.headers))
    if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
      const data = await readAll(response, 1024 * 1024)
      return restoreKernelErrorStatus({
        ok: false,
        status: response.statusCode || 0,
        via: 'go-worker-stream',
        body: parseJson(data),
        headers,
        committed: false,
        terminalState: headers['x-terminal-state'] || 'error',
        transportError: false,
      })
    }
    let buffer = ''
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
      if (event.type === 'response_headers' && event.headers && typeof event.headers === 'object') {
        sseRateHeaders = { ...sseRateHeaders, ...event.headers }
      }
      if (event.type === 'error') lastError = event
      if (event.type === 'message_stop') sawMessageStop = true
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
    let idleTimer = null
    if (firstByteMs > 0 || idleMs > 0) {
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
      for await (const chunk of response) {
        sawChunk = true
        lastChunkAt = Date.now()
        buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
        let newline
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '')
          buffer = buffer.slice(newline + 1)
          applyClaudeSSELineToMessage(line, assembler)
          if (line.startsWith('data:')) {
            const piece = line.slice(5).trim()
            if (piece && piece !== '[DONE]') {
              dataBuf = dataBuf ? `${dataBuf}\n${piece}` : piece
              const event = observeSseEvent(takeSseEvent())
              if (isDownstreamCommitEvent(event)) await flushCommit()
            }
            if (ttftMs == null) ttftMs = Date.now() - startedAt
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
      }
      if (buffer) {
        applyClaudeSSELineToMessage(buffer, assembler)
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
      return restoreUncommittedHop({
        ok: response.statusCode === 200 && !lastError && complete,
        status: response.statusCode || 0,
        via: 'go-worker-stream',

        body: lastError || assembled || { type: 'message', role: 'assistant', content: [] },
        headers: rateHeaders,
        // Trailer stays authoritative, but it may carry totals only (Codex/Responses hops).
        // Merge so SSE `input_tokens_details` / cache breakdown survives instead of being short-circuited.
        usage: mergeUsage(mergeUsage(assembled?.usage || null, sseUsage), meta.usage),
        model: meta.model || sseModel || assembled?.model || null,
        stopReason,
        sawMessageStop,
        ttftMs,
        committed,
        terminalState,
        transportError: false,
      })
    } finally {
      if (idleTimer) clearInterval(idleTimer)
    }
  } catch (error) {
    if (signal?.aborted) {
      return clientCancelledResult({
        via: 'go-worker-stream',
        ttftMs,
        committed,
      })
    }
    return {
      ok: false,
      status: 0,
      via: 'go-worker-stream',
      body: {
        type: 'error',
        error: {
          type: 'worker_error',
          code: error.code || 'worker_transport_error',
          message: String(error.message || error).slice(0, 300),
        },
      },
      headers: {},
      ttftMs,
      committed,
      terminalState: committed ? 'incomplete' : 'transport_error',
      transportError: true,
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

function credentialSummary(credential, now = Date.now()) {
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
  try {
    writeWorkerCredentialFile(exec.homeDir, credential)
    // Import is the one case where the control plane's credential replaces the slot's copy.
    await slotHost(exec.vm).onImport(exec.vm, path.dirname(exec.homeDir))
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: { code: 'credential_import_failed', message: String(error.message || error).slice(0, 300) },
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
