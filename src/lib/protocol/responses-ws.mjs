/**
 * Inbound OpenAI Responses WebSocket (`GET /v1/responses` Upgrade).
 * Terminal / cluster upgrades stay on their own handlers.
 *
 * Each `response.create` goes through handleProtocol (auth, scope, schedule,
 * billing, logs). Downstream sees JSON frames, never SSE.
 */
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { Readable } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { computedUpstreamTransport, inferenceWebsocketEnabled } from './codex-route.mjs'
import { DEFAULT_MAX_REQUEST_BYTES, inboundBodyLimit } from '../core/config.mjs'
import { keyScopeFromRequest } from '../admin/key-scope.mjs'
import { ownerScopeFromRequest } from '../admin/resource-owner.mjs'
import { isOfficialClaudeCodeTraffic } from '../identity/crs-persona.mjs'
import { resolveInferenceBackend } from '../pool/api-protocol.mjs'
import { detectInboundPlatform } from './platform-detect.mjs'
import {
  clientBlockErrorOf,
  projectCandidateAccounts,
  resolveRiskRepos,
  runUnifiedPreDispatch,
} from './unified-pre-dispatch.mjs'
import { SchedulerApiError, SchedulerUnavailableError } from '../scheduler/scheduler-runtime.mjs'

export const RESPONSES_WS_QUEUE_LIMIT = 32
export const RESPONSES_WS_REPLAY_MAX_ITEMS = 32
export const RESPONSES_WS_REPLAY_MAX_BYTES = 8 * 1024 * 1024

export function isResponsesWsPath(pathname) {
  return pathname === '/v1/responses' || pathname === '/responses'
}

export function isProtocolWarmup(body = {}) {
  return body?.generate === false && body?.store !== true
}

export function responsesWsErrorFrame({
  status = 400,
  type = 'invalid_request_error',
  code,
  message,
  param,
  details,
  requestId,
} = {}) {
  const error = { type, code, message }
  if (param) error.param = param
  if (details && typeof details === 'object' && Object.keys(details).length) {
    error.details = details
  }
  const event = { type: 'error', status, error }
  if (requestId) {
    event.request_id = requestId
    event.headers = { 'x-request-id': requestId, 'x-gateway-request-id': requestId }
  }
  return event
}

export function decodeResponseCreate(payload) {
  let value
  try {
    value = JSON.parse(payload)
  } catch {
    return {
      ok: false,
      error: responsesWsErrorFrame({
        code: 'invalid_json',
        message: 'response.create frame must be valid JSON',
      }),
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false,
      error: responsesWsErrorFrame({
        code: 'invalid_value',
        message: 'response.create frame must be a JSON object',
        param: 'type',
      }),
    }
  }
  if (value.type !== 'response.create') {
    return {
      ok: false,
      error: responsesWsErrorFrame({
        code: 'invalid_value',
        message: 'unsupported Responses WebSocket message type',
        param: 'type',
      }),
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, 'stream') && value.stream !== true) {
    return {
      ok: false,
      error: responsesWsErrorFrame({
        code: 'invalid_value',
        message: 'Responses WebSocket requests require stream=true',
        param: 'stream',
      }),
    }
  }
  const { type: _type, ...body } = value
  body.stream = true
  return { ok: true, body }
}

export function interruptTargetResponseId(value = {}) {
  const previousId = typeof value.previous_response_id === 'string' ? value.previous_response_id.trim() : ''
  const responseId = typeof value.response_id === 'string' ? value.response_id.trim() : ''
  return previousId || responseId || ''
}

export function decodeResponseInterrupt(payload) {
  let value
  if (typeof payload === 'string') {
    try {
      value = JSON.parse(payload)
    } catch {
      return {
        ok: false,
        error: responsesWsErrorFrame({
          code: 'invalid_json',
          message: 'response.interrupt frame must be valid JSON',
        }),
      }
    }
  } else {
    value = payload
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false,
      error: responsesWsErrorFrame({
        code: 'invalid_value',
        message: 'response.interrupt frame must be a JSON object',
        param: 'type',
      }),
    }
  }
  if (value.type !== 'response.interrupt') {
    return {
      ok: false,
      error: responsesWsErrorFrame({
        code: 'invalid_value',
        message: 'unsupported Responses WebSocket message type',
        param: 'type',
      }),
    }
  }
  return { ok: true, value }
}

export function parseResponsesWsClientMessage(raw) {
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    return { kind: 'queue' }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'queue' }
  if (value.type !== 'response.interrupt') return { kind: 'queue' }
  const decoded = decodeResponseInterrupt(value)
  if (!decoded.ok) return { kind: 'interrupt_error', error: decoded.error }
  return { kind: 'interrupt', value: decoded.value }
}

export function responseInterruptAcceptedFrame(value = {}) {
  const frame = { type: 'response.interrupt.accepted' }
  const previousId = typeof value.previous_response_id === 'string' ? value.previous_response_id.trim() : ''
  const responseId = typeof value.response_id === 'string' ? value.response_id.trim() : ''
  if (previousId) frame.previous_response_id = previousId
  else if (responseId) frame.response_id = responseId
  if (typeof value.mode === 'string' && value.mode) frame.mode = value.mode
  return frame
}

function cloneJson(value) {
  if (value == null) return value
  return JSON.parse(JSON.stringify(value))
}

export function normalizeResponsesInput(input) {
  if (typeof input === 'string') {
    return input ? [{ type: 'message', role: 'user', content: input }] : []
  }
  if (Array.isArray(input)) return cloneJson(input)
  return []
}

export function expandPreviousResponse(body, snapshot) {
  const next = { ...body }
  delete next.previous_response_id
  next.input = [
    ...normalizeResponsesInput(snapshot.input),
    ...(Array.isArray(snapshot.output) ? cloneJson(snapshot.output) : []),
    ...normalizeResponsesInput(body.input),
  ]
  return next
}

export function createConnectionReplay({
  maxItems = RESPONSES_WS_REPLAY_MAX_ITEMS,
  maxBytes = RESPONSES_WS_REPLAY_MAX_BYTES,
} = {}) {
  const items = new Map()
  const order = []
  let bytes = 0

  function forget(id) {
    const prev = items.get(id)
    if (!prev) return
    items.delete(id)
    bytes = Math.max(0, bytes - prev.bytes)
  }

  function evict() {
    while (order.length && (order.length > maxItems || bytes > maxBytes)) {
      forget(order.shift())
    }
  }

  return {
    remember(id, snapshot) {
      if (typeof id !== 'string' || !id || !snapshot) return
      forget(id)
      const stored = {
        input: cloneJson(snapshot.input),
        output: Array.isArray(snapshot.output) ? cloneJson(snapshot.output) : [],
        bytes: 0,
      }
      stored.bytes = Buffer.byteLength(JSON.stringify({ id, input: stored.input, output: stored.output }))
      items.set(id, stored)
      order.push(id)
      bytes += stored.bytes
      evict()
    },
    resolve(previousId) {
      if (!previousId) return { ok: true, known: false }
      const stored = items.get(previousId)
      if (!stored) {
        return {
          ok: false,
          error: responsesWsErrorFrame({
            code: 'previous_response_not_found',
            message:
              'previous_response_id is not from this WebSocket connection; resend the full input history without it',
          }),
        }
      }
      return { ok: true, known: true, snapshot: { input: stored.input, output: stored.output } }
    },
  }
}

function headerMap(headers = {}) {
  const out = {}
  for (const [key, value] of Object.entries(headers)) {
    const name = String(key).toLowerCase()
    if (name === 'connection' || name === 'upgrade' || name.startsWith('sec-websocket-')) continue
    out[name] = value
  }
  return out
}

function contentTypeOf(headers = {}) {
  return String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase()
}

export function createSseJsonBridge() {
  let buf = ''
  const dataLines = []
  const frames = []
  let terminal = null
  let responseId = null
  let output = null

  function takeData() {
    if (!dataLines.length) return null
    const data = dataLines.join('\n')
    dataLines.length = 0
    return data
  }

  function ingestParsed(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const type = parsed.type
    const id = parsed.response?.id
    if (typeof id === 'string' && id) responseId = id
    if (Array.isArray(parsed.response?.output)) output = parsed.response.output
    if (type === 'response.completed') terminal = 'completed'
    else if (type === 'response.failed') terminal = 'failed'
    else if (type === 'response.incomplete') terminal = 'incomplete'
    else if (type === 'error') terminal = 'error'
    frames.push(parsed)
  }

  function flushEvent() {
    const data = takeData()
    if (data == null || data === '[DONE]') return
    try {
      ingestParsed(JSON.parse(data))
    } catch {
      // Kernel / hop garbage is not turned into a successful completed frame.
    }
  }

  function pushLine(line) {
    const raw = line.endsWith('\r') ? line.slice(0, -1) : line
    if (raw === '') {
      flushEvent()
      return
    }
    if (raw.startsWith('event:')) {
      flushEvent()
      return
    }
    if (raw.startsWith('data:')) dataLines.push(raw.slice(5).replace(/^ /, ''))
  }

  return {
    push(chunk) {
      buf += String(chunk ?? '')
      const parts = buf.split('\n')
      buf = parts.pop() ?? ''
      for (const line of parts) pushLine(line)
    },
    finish() {
      if (buf) {
        pushLine(buf)
        buf = ''
      }
      flushEvent()
    },
    get frames() {
      return frames
    },
    get terminal() {
      return terminal
    },
    snapshot() {
      if (!responseId) return null
      return { id: responseId, output: Array.isArray(output) ? output : [] }
    },
  }
}

function createProtocolReq(upgradeReq, body) {
  const payload = Buffer.from(JSON.stringify(body))
  const req = Readable.from([payload])
  req.method = 'POST'
  req.url = '/v1/responses'
  req.httpVersion = '1.1'
  req.socket = upgradeReq.socket
  req.connection = upgradeReq.socket
  req.complete = false
  req.aborted = false
  const headers = {
    ...headerMap(upgradeReq.headers),
    'content-type': 'application/json',
    'content-length': String(payload.length),
  }
  // Never inherit an upgrade-level client X-Request-Id across individual WS turns.
  delete headers['x-request-id']
  req.headers = headers
  req.apiKeyKind = upgradeReq.apiKeyKind
  req.apiKeyRecord = upgradeReq.apiKeyRecord
  req.presentedApiKey = upgradeReq.presentedApiKey
  req.panelUser = upgradeReq.panelUser
  req.panelRole = upgradeReq.panelRole
  req.panelUserId = upgradeReq.panelUserId
  req.panelVmCreateQuota = upgradeReq.panelVmCreateQuota
  req.abort = () => {
    if (req.aborted) return
    req.aborted = true
    req.emit('aborted')
  }
  return req
}

function createProtocolRes() {
  const res = new EventEmitter()
  res.statusCode = 200
  res.headersSent = false
  res.writableEnded = false
  res.destroyed = false
  res.closed = false
  res._headers = {}
  res.writeHead = function writeHead(status, headers) {
    this.statusCode = status
    for (const [name, value] of Object.entries(headers || {})) {
      this._headers[String(name).toLowerCase()] = value
    }
    this.headersSent = true
  }
  res.setHeader = function setHeader(name, value) {
    this._headers[String(name).toLowerCase()] = value
  }
  res.write = function write(chunk, encoding, cb) {
    const text = chunk == null ? '' : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    this.emit('chunk', text)
    const done = typeof encoding === 'function' ? encoding : cb
    if (typeof done === 'function') done()
    return true
  }
  res.end = function end(chunk, encoding, cb) {
    if (chunk && typeof chunk !== 'function') this.write(chunk)
    this.writableEnded = true
    this.closed = true
    this.emit('finish')
    this.emit('close')
    const done = typeof chunk === 'function' ? chunk : typeof encoding === 'function' ? encoding : cb
    if (typeof done === 'function') done()
  }
  res.destroy = function destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.closed = true
    this.emit('close')
  }
  return res
}

function sendFrame(ws, event) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  ws.send(JSON.stringify(event))
  return true
}

function httpErrorToFrame(status, raw) {
  let parsed = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
  }
  const err = parsed?.error || parsed
  if (err && typeof err === 'object' && (err.code || err.message || err.type)) {
    return responsesWsErrorFrame({
      status: status || 400,
      type: err.type || 'invalid_request_error',
      code: err.code || 'invalid_request_error',
      message: err.message || 'request failed',
      param: err.param,
      details: err.details,
    })
  }
  return responsesWsErrorFrame({
    status: status || 502,
    type: 'api_error',
    code: 'upstream_error',
    message: 'Upstream request failed',
  })
}

function writeHttpSocket(socket, status, body) {
  const payload = JSON.stringify(body)
  const reason = http.STATUS_CODES[status] || 'Error'
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      'Content-Type: application/json; charset=utf-8\r\n' +
      'Connection: close\r\n' +
      `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
      `\r\n${payload}`,
  )
  socket.destroy()
}

export function createResponsesWsHandler({
  handleProtocol,
  requireAuth,
  json,
  getRouting,
  maxBodyBytes = DEFAULT_MAX_REQUEST_BYTES,
  cfg = null,
  settings = null,
  refusalGuards = null,
  refusalDevices = null,
  refusalSessions = null,
  accountQuota = null,
  apiKeyStore = null,
  preDispatch = null,
  schedulerRuntime = null,
  getSchedulerRuntime = null,
} = {}) {
  const resolveSchedulerRuntime = () =>
    (typeof getSchedulerRuntime === 'function' ? getSchedulerRuntime() : schedulerRuntime) || null
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxBodyBytes })

  function handshakeRes(socket) {
    return {
      statusCode: 200,
      headersSent: false,
      _headers: {},
      setHeader(name, value) {
        this._headers[String(name).toLowerCase()] = value
      },
      writeHead(status, headers) {
        this.statusCode = status
        for (const [name, value] of Object.entries(headers || {})) {
          this._headers[String(name).toLowerCase()] = value
        }
        this.headersSent = true
      },
      end(data) {
        const payload = data == null ? '' : Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
        const status = this.statusCode || 500
        const reason = http.STATUS_CODES[status] || 'Error'
        const headers = { connection: 'close', ...(this._headers || {}) }
        if (!headers['content-length'] && payload) headers['content-length'] = String(Buffer.byteLength(payload))
        let out = `HTTP/1.1 ${status} ${reason}\r\n`
        for (const [key, value] of Object.entries(headers)) out += `${key}: ${value}\r\n`
        out += `\r\n${payload}`
        try {
          socket.write(out)
        } catch {}
        socket.destroy()
      },
    }
  }

  function rejectNewWs(socket, routing) {
    if (inferenceWebsocketEnabled(routing)) return false
    const body = {
      error: {
        type: 'permission_error',
        code: 'websocket_disabled',
        message: 'Responses WebSocket is disabled',
      },
    }
    if (typeof json === 'function') json(handshakeRes(socket), 403, body)
    else writeHttpSocket(socket, 403, body)
    return true
  }

  function attach(ws, upgradeReq) {
    const replay = createConnectionReplay()
    const queue = []
    let queuedBytes = 0
    let busy = false
    let closed = false
    let currentReq = null
    let currentRes = null
    let activeResponseId = null
    let activeHopCompleted = false

    const abortCurrent = () => {
      try {
        currentReq?.abort?.()
      } catch {}
      try {
        currentRes?.destroy?.()
      } catch {}
    }

    const pump = async () => {
      if (busy) return
      busy = true
      try {
        while (!closed && queue.length) {
          const payload = queue.shift()
          queuedBytes -= Buffer.byteLength(payload)
          const decoded = decodeResponseCreate(payload)
          if (!decoded.ok) {
            sendFrame(ws, decoded.error)
            continue
          }
          const routing = typeof getRouting === 'function' ? getRouting() || {} : {}
          if (!inferenceWebsocketEnabled(routing)) {
            sendFrame(
              ws,
              responsesWsErrorFrame({
                status: 403,
                type: 'permission_error',
                code: 'websocket_disabled',
                message: 'Responses WebSocket is disabled',
              }),
            )
            continue
          }
          if (isProtocolWarmup(decoded.body) && computedUpstreamTransport(routing) === 'http') {
            sendFrame(
              ws,
              responsesWsErrorFrame({
                status: 400,
                type: 'invalid_request_error',
                code: 'unsupported_prewarm',
                message: 'generate=false warmup requires upstream WebSocket',
              }),
            )
            continue
          }
          let hopBody = { ...decoded.body, stream: true }
          const previousId = typeof hopBody.previous_response_id === 'string' ? hopBody.previous_response_id.trim() : ''
          if (previousId) {
            const resolved = replay.resolve(previousId)
            if (!resolved.ok) {
              sendFrame(ws, resolved.error)
              continue
            }
            hopBody = expandPreviousResponse(hopBody, resolved.snapshot)
          }
          activeResponseId = null
          activeHopCompleted = false
          const req = createProtocolReq(upgradeReq, hopBody)
          const activeRt = resolveSchedulerRuntime()
          if (activeRt) req._schedulerRuntime = activeRt
          currentReq = req

          // Frame-level pre-dispatch JEV gate: every `response.create` frame
          // must clear JEV BEFORE handleProtocol/slot admission. Blocked frames
          // receive a standardized WS error frame while the socket stays alive.
          const detected = detectInboundPlatform(hopBody?.model)
          const framePlatform = detected?.ok ? detected.platform : ''
          const rawBackend = resolveInferenceBackend(req)
          const frameBackend = rawBackend === 'api' ? 'api' : 'oauth'
          const frameKeyScope = keyScopeFromRequest(req)
          const frameOwnerScope = ownerScopeFromRequest(req, apiKeyStore?.users)
          const frameCandidates =
            frameBackend === 'api' || !cfg?.paths?.project
              ? null
              : projectCandidateAccounts({
                  projectRoot: cfg.paths.project,
                  keyScope: frameKeyScope,
                  ownerScope: frameOwnerScope,
                  platform: framePlatform,
                  accountQuota,
                })
          const personaInject = String(routing?.compatibility?.persona_inject || '')
            .trim()
            .toLowerCase()
          const personaPreset = String(routing?.compatibility?.persona_preset || '')
            .trim()
            .toLowerCase()
          const zeroInject = personaInject === 'zero' || personaPreset === 'zero'
          const official = isOfficialClaudeCodeTraffic(req.headers, hopBody)
          const riskState = resolveRiskRepos({ settings, refusalGuards, refusalDevices, refusalSessions })
          const preDispatchInput = {
            req,
            inbound: hopBody,
            body: hopBody,
            headers: req.headers,
            official,
            zeroInject,
            distillRules: cfg?.distill,
            policy: riskState.policy,
            settings,
            repo: riskState.repo,
            devices: riskState.devices,
            sessions: riskState.sessions,
            candidateAccounts: frameCandidates,
            poolJevProfile: req.poolJevProfile || req.apiKeyRecord?.jev_profile || null,
            channel: framePlatform === 'gemini' ? 'gemini' : framePlatform === 'openai' ? 'openai' : 'anthropic',
            backend: frameBackend,
            openaiPlatform: framePlatform === 'openai',
          }
          let frameDecision = null
          try {
            frameDecision =
              typeof preDispatch === 'function'
                ? await preDispatch(preDispatchInput)
                : await runUnifiedPreDispatch(preDispatchInput)
          } catch (error) {
            console.warn('[responses-ws] pre-dispatch gate error', error?.code || error?.name || 'unknown_error')
            currentReq = null
            sendFrame(
              ws,
              responsesWsErrorFrame({
                status: 503,
                type: 'overloaded_error',
                code: 'policy_gate_error',
                message: 'Pre-dispatch policy check failed',
              }),
            )
            continue
          }
          if (closed) return
          if (frameDecision?.action === 'block') {
            currentReq = null
            const clientErr = clientBlockErrorOf(frameDecision)
            sendFrame(
              ws,
              responsesWsErrorFrame({
                status: clientErr.status,
                type: clientErr.type,
                code: clientErr.code,
                message: clientErr.message,
                details: clientErr.details,
                requestId: clientErr.requestId,
              }),
            )
            continue
          }
          if (frameDecision) req._preDispatchDecision = frameDecision

          let hopClientAborted = false
          const res = createProtocolRes()
          currentRes = res
          const bridge = createSseJsonBridge()
          let jsonBody = ''
          const flushBridge = () => {
            for (const frame of bridge.frames) sendFrame(ws, frame)
            bridge.frames.length = 0
            const snap = bridge.snapshot()
            if (snap?.id) activeResponseId = snap.id
            if (bridge.terminal === 'completed') activeHopCompleted = true
          }
          req.once('aborted', () => {
            if (bridge.terminal === 'completed' || activeHopCompleted) return
            hopClientAborted = true
          })
          res.on('chunk', (text) => {
            if (contentTypeOf(res._headers).includes('application/json')) {
              jsonBody += text
              return
            }
            bridge.push(text)
            flushBridge()
          })
          try {
            await handleProtocol(req, res, 'openai.responses', '/v1/responses')
          } catch (error) {
            console.warn('[responses-ws] request failed', error?.code || error?.name || 'unknown_error')
            if (!res.writableEnded) res.end()
            if (error instanceof SchedulerUnavailableError || error?.code === 'scheduler_unavailable') {
              sendFrame(
                ws,
                responsesWsErrorFrame({
                  status: 503,
                  type: 'api_error',
                  code: 'scheduler_unavailable',
                  message: error?.message || 'Rust scheduler sidecar is unavailable',
                  details: { retry_after_sec: 1 },
                }),
              )
            } else if (error instanceof SchedulerApiError) {
              const status = error.status || 503
              sendFrame(
                ws,
                responsesWsErrorFrame({
                  status,
                  type:
                    status === 429
                      ? 'rate_limit_error'
                      : status === 403
                        ? 'permission_error'
                        : status === 422
                          ? 'invalid_request_error'
                          : 'api_error',
                  code: error.code || 'scheduler_error',
                  message: error.message || 'scheduler request rejected',
                  ...(error.retryAfterSec ? { details: { retry_after_sec: error.retryAfterSec } } : {}),
                }),
              )
            } else {
              sendFrame(
                ws,
                responsesWsErrorFrame({
                  status: 500,
                  type: 'api_error',
                  code: 'api_error',
                  message: 'Responses request failed',
                }),
              )
            }
            continue
          } finally {
            currentReq = null
            currentRes = null
          }
          if (closed) return
          bridge.finish()
          flushBridge()
          if (hopClientAborted && bridge.terminal !== 'completed') continue
          if (contentTypeOf(res._headers).includes('application/json')) {
            sendFrame(ws, httpErrorToFrame(res.statusCode, jsonBody))
            continue
          }
          if (bridge.terminal === 'completed') {
            const snap = bridge.snapshot()
            // A warmup settles with an id the client may continue from, so it
            // enters the replay cache like any other hop. The cache still lives
            // only on this connection: `store` never turns into persistence.
            if (snap) {
              replay.remember(snap.id, { input: hopBody.input, output: snap.output })
            }
            continue
          }
          if (bridge.terminal === 'error' || bridge.terminal === 'failed' || bridge.terminal === 'incomplete') continue
          sendFrame(
            ws,
            responsesWsErrorFrame({
              status: res.statusCode && res.statusCode >= 400 ? res.statusCode : 502,
              type: 'upstream_error',
              code: 'incomplete_response',
              message: 'Assistant hop ended without a terminal Responses event',
            }),
          )
        }
      } finally {
        busy = false
        currentReq = null
      }
    }

    ws.on('message', (data, isBinary) => {
      if (closed) return
      if (isBinary) {
        closed = true
        try {
          ws.close(1003, 'Responses WebSocket accepts text frames only')
        } catch {}
        abortCurrent()
        return
      }
      const raw = String(data)
      const clientMessage = parseResponsesWsClientMessage(raw)
      if (clientMessage.kind === 'interrupt_error') {
        sendFrame(ws, clientMessage.error)
        return
      }
      if (clientMessage.kind === 'interrupt') {
        const routing = typeof getRouting === 'function' ? getRouting() || {} : {}
        if (!inferenceWebsocketEnabled(routing)) {
          sendFrame(
            ws,
            responsesWsErrorFrame({
              status: 403,
              type: 'permission_error',
              code: 'websocket_disabled',
              message: 'Responses WebSocket is disabled',
            }),
          )
          return
        }
        const targetId = interruptTargetResponseId(clientMessage.value)
        const shouldAbort =
          currentReq && !activeHopCompleted && (!targetId || (activeResponseId && targetId === activeResponseId))
        if (shouldAbort) abortCurrent()
        sendFrame(ws, responseInterruptAcceptedFrame(clientMessage.value))
        return
      }
      const routing = typeof getRouting === 'function' ? getRouting() || {} : {}
      const bytes = Buffer.byteLength(raw)
      if (bytes + queuedBytes > inboundBodyLimit(routing, maxBodyBytes)) {
        closed = true
        ws.close(1009, 'Responses WebSocket receive buffer exceeds request body limit')
        abortCurrent()
        return
      }
      if (queue.length >= RESPONSES_WS_QUEUE_LIMIT) {
        sendFrame(
          ws,
          responsesWsErrorFrame({
            code: 'websocket_queue_full',
            message: 'Responses WebSocket receive queue is full',
          }),
        )
        closed = true
        try {
          ws.close(1008, 'Responses WebSocket receive queue is full')
        } catch {}
        abortCurrent()
        return
      }
      queue.push(raw)
      queuedBytes += bytes
      pump().catch((error) => {
        console.warn('[responses-ws] connection failed', error?.code || error?.name || 'unknown_error')
        sendFrame(
          ws,
          responsesWsErrorFrame({
            status: 500,
            type: 'api_error',
            code: 'api_error',
            message: 'Responses connection failed',
          }),
        )
      })
    })
    ws.on('close', () => {
      closed = true
      queue.length = 0
      queuedBytes = 0
      abortCurrent()
    })
    ws.on('error', () => {
      closed = true
      abortCurrent()
    })
  }

  function handleUpgrade(req, socket, head) {
    let pathname = '/v1/responses'
    try {
      pathname = new URL(req.url || '/', 'http://local').pathname
    } catch {
      return false
    }
    if (!isResponsesWsPath(pathname)) return false
    const routing = typeof getRouting === 'function' ? getRouting() || {} : {}
    if (rejectNewWs(socket, routing)) return true
    const res = handshakeRes(socket)
    if (typeof requireAuth === 'function' && !requireAuth(req, res)) return true
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, req))
    return true
  }

  return { handleUpgrade, wss }
}
