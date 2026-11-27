/**
 * Shared HTTP helpers for protocol and panel. SSE headers flush immediately
 * and optionally disable Nagle so Claude Code subagent tokens are not delayed.
 */
import { ErrorCode, ErrorType, makeError } from '../core/errors.mjs'
import { CORS_ALLOW_HEADERS, corsHeadersForRequest } from './cors.mjs'

export { CORS_ALLOW_HEADERS } from './cors.mjs'

export function corsHeaders(extra = {}, req = null) {
  return corsHeadersForRequest(req, extra)
}

function requestFromResponse(res) {
  return res?.req || res?._kinReq || null
}

function collectBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      req.removeAllListeners('data')
      req.on('data', () => {})
      req.resume()
      reject(error)
    }
    req.on('data', (c) => {
      if (settled) return
      size += c.length
      if (size > maxBytes) {
        fail(
          makeError({
            type: ErrorType.INVALID_REQUEST,
            code: ErrorCode.BODY_TOO_LARGE,
            message: `Request body exceeds limit of ${maxBytes} bytes`,
            status: 413,
            details: { max_bytes: maxBytes, received: size },
          }),
        )
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', (e) =>
      fail(
        makeError({
          type: ErrorType.API,
          code: 'request_stream_error',
          message: String(e.message || e),
          status: 400,
        }),
      ),
    )
  })
}

export function readBody(req, maxBytes) {
  return collectBody(req, maxBytes).then((buf) => {
    const raw = buf.toString('utf8')
    if (!raw) return {}
    try {
      return JSON.parse(raw)
    } catch (e) {
      throw makeError({
        type: ErrorType.INVALID_REQUEST,
        code: ErrorCode.INVALID_JSON,
        message: 'Request body is not valid JSON: ' + (e.message || 'parse error'),
        status: 400,
        details: { parse_error: String(e.message || e) },
      })
    }
  })
}

/**
 * Node 的 WHATWG URL 会拒绝未加括号的 IPv6、非 ASCII Host、空 Host。
 * 安装探活打的是 127.0.0.1，浏览器若用这类 Host 打开 /cc，旧代码在进路由前就 500。
 * Host 解析失败时仍用路径路由；路径本身非法才返回 null。
 */
export function parseRequestUrl(req) {
  const raw = req?.url || '/'
  const host = String(req?.headers?.host || '').trim()
  const bases = []
  if (host) bases.push(`http://${host}`)
  bases.push('http://127.0.0.1')
  for (const base of bases) {
    try {
      return new URL(raw, base)
    } catch {
      // try the next base
    }
  }
  return null
}

export function readRawBody(req, maxBytes) {
  return collectBody(req, maxBytes)
}

export function applySseSocketTuning(res, { tcpNodelay = true } = {}) {
  if (typeof res.flushHeaders === 'function') {
    try {
      res.flushHeaders()
    } catch {}
  }
  if (tcpNodelay !== false) {
    try {
      res.socket?.setNoDelay?.(true)
    } catch {}
  }
}

const OFFICIAL_RESPONSE_HEADER_EXACT = new Set([
  'request-id',
  'retry-after',
  'x-should-retry',
  'anthropic-organization-id',
  'anthropic-should-fallback',
  'cf-ray',
])

const RESERVED_GATEWAY_HEADERS = new Set([
  'content-type',
  'cache-control',
  'connection',
  'x-accel-buffering',
  'x-kin-rewrite',
  'x-request-id',
  'x-kin-request-id',
  'set-cookie',
  'transfer-encoding',
  'content-length',
])

/**
 * Extract allowlisted official Anthropic/upstream HTTP response headers for
 * end-to-end client forwarding without ever overwriting gateway headers
 * (`x-request-id`, `x-kin-request-id`, `x-kin-rewrite`, `content-type`, CORS).
 */
export function extractOfficialResponseHeaders(upstreamHeaders = null) {
  if (!upstreamHeaders || typeof upstreamHeaders !== 'object' || Array.isArray(upstreamHeaders)) return {}
  const out = {}
  for (const [rawKey, rawValue] of Object.entries(upstreamHeaders)) {
    if (rawValue == null) continue
    const key = String(rawKey).trim().toLowerCase()
    if (!key || RESERVED_GATEWAY_HEADERS.has(key)) continue
    if (!OFFICIAL_RESPONSE_HEADER_EXACT.has(key) && !key.startsWith('anthropic-ratelimit-')) continue
    const value = Array.isArray(rawValue)
      ? rawValue
          .map((item) => String(item ?? '').trim())
          .filter(Boolean)
          .join(', ')
      : String(rawValue).trim()
    if (!value || /[\r\n]/.test(value)) continue
    out[key] = value
  }
  return out
}

export function createRespond(cfg, options = {}) {
  const resolveNodelay = () => {
    if (typeof options.tcpNodelay === 'function') return options.tcpNodelay() !== false
    return options.tcpNodelay !== false
  }

  function json(res, status, body, upstreamHeaders = null) {
    const data = JSON.stringify(body)
    const forwarded = extractOfficialResponseHeaders(upstreamHeaders)
    const headers = corsHeadersForRequest(requestFromResponse(res), {
      ...forwarded,
      'content-type': 'application/json; charset=utf-8',
      'x-kin-rewrite': cfg.rewrite.enabled ? 'on' : 'off',
    })
    if (res._kinRequestId) headers['x-request-id'] = res._kinRequestId
    if (body?.error?.details?.retryable === false && !Object.hasOwn(headers, 'x-should-retry')) {
      headers['x-should-retry'] = 'false'
    }
    res.writeHead(status, headers)
    res.end(data)
  }

  function writeSSEHeaders(res, upstreamHeaders = null) {
    const forwarded = extractOfficialResponseHeaders(upstreamHeaders)
    const headers = corsHeadersForRequest(requestFromResponse(res), {
      ...forwarded,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-kin-rewrite': cfg.rewrite.enabled ? 'on' : 'off',
    })
    if (res._kinRequestId) headers['x-request-id'] = res._kinRequestId
    res.writeHead(200, headers)
    applySseSocketTuning(res, { tcpNodelay: resolveNodelay() })
  }

  return { json, writeSSEHeaders, readBody, readRawBody, corsHeaders }
}
