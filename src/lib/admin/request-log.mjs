/**
 * Database-backed request logs (PostgreSQL / SQLite) for access, usage, and billing.
 *
 * Modes:
 *   off    — no writes
 *   normal — summary row (tokens, status, duration, key/vm ids; no bodies)
 *   debug  — normal + full redacted request record (headers/body/hop_meta)
 *
 * Storage: `request_logs` (summaries) + `request_log_debug` (full records).
 * Optional JSONL mirror for external log shippers: KIN_REQUEST_LOG_JSONL=1
 * (writes the previous data/request-logs/YYYY-MM-DD.jsonl format alongside).
 *
 * Env: KIN_REQUEST_LOG_MODE=off|normal|debug (default normal)
 * Per-request override: X-Kin-Debug: 1 or X-Kin-Log: debug|normal|off
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { redactSecrets } from '../core/security.mjs'
import { sanitizeErrorDetailsForLog, sanitizeErrorToken } from '../core/errors.mjs'
import { getDb, getPgPool, isDbOpen, resolveStoreDb, withSavepoint } from '../db/database.mjs'
import { enqueueWrite, writeBehindArmed } from '../db/write-behind.mjs'
import { getPgLogWriter, runRetentionCleanupAsync } from '../db/pg/pg-log-writer.mjs'
import { getCacheRuntime } from '../cache/index.mjs'
import { UsageLogsRepo } from '../db/repos/usage-logs-repo.mjs'
import { classifyRequestError, resolveMutedErrorClasses } from './error-class.mjs'
import { advisorUsageFromIterations, costColumnsFromUsage, normalizeUsage } from './pricing.mjs'
import { disjointOpenaiUsage } from '../protocol/openai-usage.mjs'
import { REASONING_EFFORTS, modelMismatch, sessionIdForLog } from '../protocol/log-fields.mjs'

/** Persist the token a client actually sent — only for failed ingress auth. */
export function presentedApiKeyForLog(token) {
  const t = String(token || '').trim()
  if (!t || t.startsWith('kin-panel-')) return ''
  return t.slice(0, 240)
}

const MODES = new Set(['off', 'normal', 'debug'])

export const LOGGING_RETAIN_DAYS_MIN = 1
export const LOGGING_RETAIN_DAYS_MAX = 90
export const LOGGING_MAX_MB_MIN = 0
export const LOGGING_MAX_MB_MAX = 102400

const DEFAULT_RETAIN_DAYS = 7
const DEFAULT_DEBUG_RETAIN_DAYS = 3
const DEFAULT_MAX_MB = 2048
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000
const PG_TOTAL_ROWS_CACHE_TTL_MS = 30_000
const SQLITE_TOTAL_ROWS_CACHE_TTL_MS = 5_000
const INFLIGHT_COUNT_CACHE_TTL_MS = 2_000
const CLEANUP_INVALIDATE_NAMESPACES = ['stats', 'overview', 'panel', 'filter-options', 'active-sessions']

function loggingValidationError(message) {
  const error = new TypeError(message)
  error.code = 'invalid_logging_config'
  return error
}

function parseStrictBoundedInt(raw, min, max, field) {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    throw loggingValidationError(`${field} 必须是 ${min}–${max} 的整数`)
  }
  return raw
}

/** PUT /api/panel/routing strict check for logging retention and debug payload bounds. */
export function validateLoggingRoutingPatch(body = {}, currentLogging = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return
  if (!Object.prototype.hasOwnProperty.call(body, 'logging')) return
  const logging = body.logging
  if (!logging || typeof logging !== 'object' || Array.isArray(logging)) {
    throw loggingValidationError('logging 必须是对象')
  }
  if (Object.prototype.hasOwnProperty.call(logging, 'mode')) {
    if (typeof logging.mode !== 'string' || !MODES.has(logging.mode.trim().toLowerCase())) {
      throw loggingValidationError('logging.mode 必须是 off / normal / debug')
    }
  }
  const hasRetain = Object.prototype.hasOwnProperty.call(logging, 'retain_days')
  const hasDebugRetain = Object.prototype.hasOwnProperty.call(logging, 'debug_retain_days')
  const current = normalizeLoggingConfig(currentLogging || {})
  const retainDays = hasRetain
    ? parseStrictBoundedInt(
        logging.retain_days,
        LOGGING_RETAIN_DAYS_MIN,
        LOGGING_RETAIN_DAYS_MAX,
        'logging.retain_days',
      )
    : current.retain_days
  const debugRetainDays = hasDebugRetain
    ? parseStrictBoundedInt(
        logging.debug_retain_days,
        LOGGING_RETAIN_DAYS_MIN,
        LOGGING_RETAIN_DAYS_MAX,
        'logging.debug_retain_days',
      )
    : current.debug_retain_days
  if ((hasRetain || hasDebugRetain) && debugRetainDays > retainDays) {
    throw loggingValidationError('logging.debug_retain_days 不能大于 logging.retain_days')
  }
  if (Object.prototype.hasOwnProperty.call(logging, 'max_mb')) {
    parseStrictBoundedInt(logging.max_mb, LOGGING_MAX_MB_MIN, LOGGING_MAX_MB_MAX, 'logging.max_mb')
  }
}

function clampInt(value, min, max, fallback) {
  if (value == null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** Keep summary retain_days, a shorter debug window, and a hard size cap. */
export function normalizeLoggingConfig(raw = {}) {
  const modeRaw = String(raw.mode || 'normal')
    .trim()
    .toLowerCase()
  const mode = MODES.has(modeRaw) ? modeRaw : 'normal'
  const retainDays = clampInt(raw.retain_days ?? raw.retainDays, 1, 90, DEFAULT_RETAIN_DAYS)
  let debugRetainDays = clampInt(
    raw.debug_retain_days ?? raw.debugRetainDays,
    1,
    90,
    Math.min(DEFAULT_DEBUG_RETAIN_DAYS, retainDays),
  )
  if (debugRetainDays > retainDays) debugRetainDays = retainDays
  return {
    ...raw,
    mode,
    retain_days: retainDays,
    debug_retain_days: debugRetainDays,
    max_mb: clampInt(raw.max_mb ?? raw.maxMb, 0, 102400, DEFAULT_MAX_MB),
  }
}

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10)
}

function safeIp(req) {
  const xf = String(req.headers?.['x-forwarded-for'] || '')
    .split(',')[0]
    .trim()
  const raw = xf || req.socket?.remoteAddress || ''
  return String(raw).slice(0, 45)
}

/**
 * Catalog size as the model sees it. `tools.length` alone cannot tell four
 * top-level entries from the ~1400 callable functions a namespaced plugin
 * catalog expands to, which is the shape that reaches an output-token limit
 * (#1310). Also records whether the caller already asked for deferred loading,
 * so a request that handles its own catalog is distinguishable from one that
 * does not.
 */
function summarizeTools(tools) {
  const empty = { count: 0, functions: 0, bytes: 0, deferred: 0, search: false }
  if (!Array.isArray(tools) || !tools.length) return empty
  let functions = 0
  let deferred = 0
  let search = false
  const visit = (tool) => {
    if (!tool || typeof tool !== 'object') return
    const type = typeof tool.type === 'string' ? tool.type.trim() : ''
    if (type.startsWith('tool_search')) search = true
    if (tool.defer_loading === true || tool.custom?.defer_loading === true) deferred += 1
    const members = Array.isArray(tool.tools) ? tool.tools : null
    if (members) {
      // A namespace is a container; only its members are callable.
      for (const member of members) visit(member)
      return
    }
    const geminiDecls = Array.isArray(tool.functionDeclarations)
      ? tool.functionDeclarations
      : Array.isArray(tool.function_declarations)
        ? tool.function_declarations
        : null
    if (geminiDecls) {
      functions += geminiDecls.length
      return
    }
    if (type === 'function' || type === 'custom' || (!type && typeof tool.name === 'string')) functions += 1
  }
  for (const tool of tools) visit(tool)
  let bytes = 0
  try {
    bytes = Buffer.byteLength(JSON.stringify(tools))
  } catch {
    // An unserializable catalog still reports its counts.
  }
  return { count: tools.length, functions, bytes, deferred, search }
}

function systemInstructionLen(value) {
  if (typeof value === 'string') return value.length
  if (Array.isArray(value)) {
    return value.reduce((n, b) => n + (typeof b === 'string' ? b.length : (b?.text || '').length), 0)
  }
  if (value && typeof value === 'object' && Array.isArray(value.parts)) {
    return value.parts.reduce((n, p) => n + (typeof p?.text === 'string' ? p.text.length : 0), 0)
  }
  return 0
}

function summarizeBody(body) {
  if (!body || typeof body !== 'object') return { empty: true }
  const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.contents) ? body.contents : null
  const roles = messages ? messages.map((m) => m?.role).filter(Boolean) : []
  const toolStats = summarizeTools(body.tools)
  const gc = body.generationConfig ?? body.generation_config
  const systemLen =
    systemInstructionLen(body.system) ||
    systemInstructionLen(body.systemInstruction ?? body.system_instruction) ||
    systemInstructionLen(body.instructions)
  const hasThinking =
    body.thinking != null ||
    body.reasoning != null ||
    body.reasoning_effort != null ||
    gc?.thinkingConfig != null ||
    gc?.thinking_config != null
  return {
    model: body.model || null,
    stream: !!body.stream,
    max_tokens:
      body.max_tokens ??
      body.max_output_tokens ??
      body.max_completion_tokens ??
      gc?.maxOutputTokens ??
      gc?.max_output_tokens ??
      null,
    messages_count: messages
      ? messages.length
      : Array.isArray(body.input)
        ? body.input.length
        : body.input != null
          ? 1
          : 0,
    roles,
    tools_count: Array.isArray(body.tools) ? body.tools.length : 0,
    tool_functions_count: toolStats.functions,
    tools_bytes: toolStats.bytes,
    tools_deferred_count: toolStats.deferred,
    tools_search_declared: toolStats.search,
    has_thinking: hasThinking,
    system_len: systemLen,
    top_level_keys: Object.keys(body).sort(),
  }
}

/**
 * Cache-creation TTL breakdown.
 * Prefer usage.cache_creation.ephemeral_5m/1h; cache_creation_input_tokens beyond
 * that split (absent, or stale after message_delta) bills 1h only on an explicit cache_ttl === '1h',
 * else 5m. DEFAULT_CACHE_TTL is not a billing fallback.
 */
function cacheCreationBreakdown(usage) {
  if (!usage || typeof usage !== 'object') {
    return { cache_creation_5m_tokens: null, cache_creation_1h_tokens: null }
  }
  const nested = usage.cache_creation
  let five = Number(nested?.ephemeral_5m_input_tokens) || 0
  let hour = Number(nested?.ephemeral_1h_input_tokens) || 0
  const total = Number(usage.cache_creation_input_tokens ?? usage.cache_creation_tokens) || 0
  const unsplit = total - five - hour
  if (unsplit > 0) {
    if (usage.cache_ttl === '1h') hour += unsplit
    else five += unsplit
  }
  if (five === 0 && hour === 0) {
    return { cache_creation_5m_tokens: null, cache_creation_1h_tokens: null }
  }
  return { cache_creation_5m_tokens: five, cache_creation_1h_tokens: hour }
}

function imageTokenCount(v) {
  return Number.isSafeInteger(v) && v > 0 ? v : 0
}

function webSearchRequestsOf(usage) {
  const n = Number(usage?.server_tool_use?.web_search_requests ?? usage?.web_search_requests)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

const PRICED_COLUMN_KEYS = [
  'input_cost',
  'output_cost',
  'cache_read_cost',
  'cache_creation_cost',
  'web_search_cost',
  'image_cost',
  'advisor_cost',
  'total_cost',
  'pricing_model',
  'price_source',
  'price_version',
  'service_tier',
  'speed',
  'long_context',
]

/** Image generation usage on this row; an Images endpoint row (`openai.images`) bills it alone. */
function imageForLog(extra) {
  const only = extra.protocol === 'openai.images'
  if (!extra.image_usage && !only) return null
  return { usage: extra.image_usage || null, model: extra.image_model || null, only }
}

function costColumnsForLog(usage, model, extra = {}) {
  if (extra.pricing_model != null) {
    const out = {}
    for (const key of PRICED_COLUMN_KEYS) out[key] = extra[key] ?? null
    return out
  }
  const priced = costColumnsFromUsage(usage, model, imageForLog(extra))
  return {
    input_cost: priced.input_cost ?? null,
    output_cost: priced.output_cost ?? null,
    cache_read_cost: priced.cache_read_cost ?? null,
    cache_creation_cost: priced.cache_creation_cost ?? null,
    web_search_cost: priced.web_search_cost ?? null,
    image_cost: priced.image_cost ?? null,
    advisor_cost: priced.advisor_cost ?? null,
    total_cost: priced.total_cost ?? null,
    pricing_model: priced.pricing_model ?? null,
    price_source: priced.price_source ?? null,
    price_version: priced.price_version ?? null,
    service_tier: priced.service_tier ?? null,
    speed: priced.speed ?? null,
    long_context: priced.long_context ?? null,
  }
}

function appendCapturedHeader(target, rawKey, value) {
  if (rawKey == null || value === undefined) return
  const key = String(rawKey).trim().toLowerCase()
  if (!key) return
  if (Object.hasOwn(target, key)) {
    const prev = target[key]
    target[key] = Array.isArray(prev) ? [...prev, value] : [prev, value]
  } else {
    target[key] = value
  }
}

function normalizeWriteHeadHeaders(raw) {
  if (!raw || typeof raw !== 'object') return null
  const out = {}
  if (Array.isArray(raw)) {
    if (raw.length > 0 && Array.isArray(raw[0])) {
      for (const pair of raw) {
        if (Array.isArray(pair) && pair.length >= 2) appendCapturedHeader(out, pair[0], pair[1])
      }
    } else {
      for (let i = 0; i + 1 < raw.length; i += 2) {
        appendCapturedHeader(out, raw[i], raw[i + 1])
      }
    }
  } else {
    for (const [k, v] of Object.entries(raw)) {
      if (v === undefined) continue
      const key = String(k).trim().toLowerCase()
      if (key) out[key] = v
    }
  }
  return Object.keys(out).length ? out : null
}

function redactHeaders(headers = {}) {
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    const key = String(k).toLowerCase()
    if (
      key === 'authorization' ||
      key === 'x-api-key' ||
      key === 'x-goog-api-key' ||
      key === 'cookie' ||
      key === 'set-cookie'
    ) {
      out[key] = '***REDACTED***'
    } else if (key === 'x-panel-token') {
      out[key] = '***REDACTED***'
    } else {
      out[key] = typeof v === 'string' ? v.slice(0, 512) : v
    }
  }
  return out
}

const SENSITIVE_KEY = /authorization|token|password|secret|cookie|api[_-]?key/i
const SNAP_MAX_STRING = 80
const SNAP_MAX_ARRAY = 24
const SNAP_MAX_DEPTH = 6
const SNAP_MAX_TOTAL = 12000
const IMAGE_DATA_KEYS = new Set(['data', 'base64', 'b64_json'])

function imagePayloadSummary(value) {
  if (typeof value === 'string') return `…[${value.length} bytes]`
  return '[omitted-image]'
}

function redactImagePayloads(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => redactImagePayloads(item, seen))
  const type = value.type
  const isImage = type === 'image' || type === 'input_image' || type === 'image_url' || value.source || value.image_url
  const out = {}
  for (const [key, nested] of Object.entries(value)) {
    if (IMAGE_DATA_KEYS.has(key) && typeof nested === 'string' && nested.length > 32) {
      out[key] = imagePayloadSummary(nested)
      continue
    }
    if (isImage && key === 'source' && nested && typeof nested === 'object') {
      out[key] = {
        type: nested.type || 'base64',
        media_type: nested.media_type || null,
        url: Boolean(nested.url),
        bytes: typeof nested.data === 'string' ? nested.data.length : 0,
      }
      continue
    }
    if (isImage && key === 'image_url' && nested && typeof nested === 'object') {
      out[key] = { url: Boolean(nested.url), detail: nested.detail || null }
      continue
    }
    out[key] = redactImagePayloads(nested, seen)
  }
  return out
}

export function sanitizeRequestBodySnapshot(value, opts = {}, seen = new WeakSet(), depth = 0) {
  const maxString = opts.maxStringChars ?? SNAP_MAX_STRING
  const maxArray = opts.maxArrayItems ?? SNAP_MAX_ARRAY
  const maxDepth = opts.maxDepth ?? SNAP_MAX_DEPTH
  if (value == null) return value
  if (typeof value === 'string') {
    return value.length > maxString ? value.slice(0, maxString) + `…[${value.length}]` : value
  }
  if (typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  if (depth >= maxDepth) return '[MaxDepth]'
  seen.add(value)
  if (Array.isArray(value)) {
    const items = value.slice(0, maxArray).map((v) => sanitizeRequestBodySnapshot(v, opts, seen, depth + 1))
    if (value.length > maxArray) items.push(`…[${value.length - maxArray} more]`)
    return items
  }
  const out = {}
  const isImage =
    value.type === 'image' ||
    value.type === 'input_image' ||
    value.type === 'image_url' ||
    value.source ||
    value.image_url
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(k)) {
      out[k] = '[REDACTED]'
      continue
    }
    if (k === 'encrypted_content') {
      out[k] = `…[${String(v || '').length} chars]`
      continue
    }
    if (k === 'tools' && Array.isArray(v)) {
      out[k] = v
        .slice(0, maxArray)
        .map((t) => ({ type: t?.type || 'function', name: t?.name || t?.function?.name || null }))
      continue
    }
    if (IMAGE_DATA_KEYS.has(k) && typeof v === 'string' && v.length > 32) {
      out[k] = imagePayloadSummary(v)
      continue
    }
    if (isImage && k === 'source' && v && typeof v === 'object') {
      out[k] = {
        type: v.type || 'base64',
        media_type: v.media_type || null,
        url: Boolean(v.url),
        bytes: typeof v.data === 'string' ? v.data.length : 0,
      }
      continue
    }
    out[k] = sanitizeRequestBodySnapshot(v, opts, seen, depth + 1)
  }
  let raw = ''
  try {
    raw = JSON.stringify(out)
  } catch {
    return out
  }
  if (raw.length > (opts.maxTotalChars ?? SNAP_MAX_TOTAL)) {
    return { _truncated: true, _chars: raw.length, preview: raw.slice(0, opts.maxTotalChars ?? SNAP_MAX_TOTAL) }
  }
  return out
}

function clampBody(obj, maxChars = 200_000) {
  let raw
  try {
    raw = redactSecrets(redactImagePayloads(obj))
  } catch {
    raw = '{"error":"redact_failed"}'
  }
  if (raw.length <= maxChars) {
    try {
      return JSON.parse(raw)
    } catch {
      return { _raw: raw.slice(0, maxChars) }
    }
  }
  return { _truncated: true, _chars: raw.length, preview: raw.slice(0, maxChars) }
}

/**
 * Client-facing response as stored in a debug record. The body stays raw text
 * (SSE frames or JSON) so the panel can show exactly what went out; only
 * credential-shaped substrings are masked.
 */
function debugResponse(captured) {
  let body = captured.body || ''
  try {
    body = JSON.parse(redactSecrets(body))
  } catch {}
  return {
    status: captured.status ?? null,
    headers: captured.headers || null,
    body,
    bytes: captured.bytes || 0,
    truncated: !!captured.truncated,
  }
}

export function resolveLogMode(envMode, req) {
  const hdr = String(req?.headers?.['x-kin-log'] || '')
    .trim()
    .toLowerCase()
  if (MODES.has(hdr)) return hdr
  if (String(req?.headers?.['x-kin-debug'] || '') === '1') return 'debug'
  const base = String(envMode || 'normal')
    .trim()
    .toLowerCase()
  return MODES.has(base) ? base : 'normal'
}

export function newRequestId(req) {
  const incoming = String(req?.headers?.['x-request-id'] || '').trim()
  if (incoming && incoming.length <= 128) return incoming
  return crypto.randomUUID()
}

export class RequestLogStore {
  constructor({
    dataDir,
    db,
    mode = process.env.KIN_REQUEST_LOG_MODE || 'normal',
    maxDebugBodyChars = Number(process.env.KIN_REQUEST_LOG_DEBUG_CHARS || 200000),
    retainDays = Number(process.env.KIN_REQUEST_LOG_RETAIN_DAYS || DEFAULT_RETAIN_DAYS),
    debugRetainDays = Number(process.env.KIN_REQUEST_LOG_DEBUG_RETAIN_DAYS || DEFAULT_DEBUG_RETAIN_DAYS),
    maxMb = Number(process.env.KIN_REQUEST_LOG_MAX_MB || DEFAULT_MAX_MB),
    jsonlMirror = process.env.KIN_REQUEST_LOG_JSONL === '1',
    cache = null,
    pgLogWriter = null,
    pgPool = null,
    forceSyncWrite = false,
  } = {}) {
    this.dataDir = dataDir || path.join(process.cwd(), 'data')
    this.db = resolveStoreDb({ db, dataDir: this.dataDir })
    this.repo = new UsageLogsRepo(this.db)
    this.root = path.join(this.dataDir, 'request-logs')
    this.mode = MODES.has(String(mode).toLowerCase()) ? String(mode).toLowerCase() : 'normal'
    this.maxDebugBodyChars = Number.isFinite(maxDebugBodyChars) ? maxDebugBodyChars : 200000
    this.retainDays = Number.isFinite(retainDays) && retainDays > 0 ? retainDays : DEFAULT_RETAIN_DAYS
    this.debugRetainDays =
      Number.isFinite(debugRetainDays) && debugRetainDays > 0 ? debugRetainDays : DEFAULT_DEBUG_RETAIN_DAYS
    if (this.debugRetainDays > this.retainDays) this.debugRetainDays = this.retainDays
    this.maxMb = Number.isFinite(maxMb) && maxMb >= 0 ? maxMb : DEFAULT_MAX_MB
    this.jsonlMirror = !!jsonlMirror
    this.mutedErrorClasses = resolveMutedErrorClasses(null)
    this._cache = cache
    this._hasExplicitCache = cache != null
    this._pgLogWriter = pgLogWriter
    this._pgPool = pgPool
    this._forceSyncWrite = !!forceSyncWrite
    this._recentNormalCount = 0
    this._memMax = 200
    this._totalRowsCache = { value: null, at: 0 }
    this._totalRowsRefreshPromise = null
    this._inflightCache = { value: null, at: 0 }
    this._inflightRefreshPromise = null
    this._cleanupTimer = null
    this._cleanupInFlight = null
  }

  _getCache() {
    if (this._cache) return this._cache
    try {
      return getCacheRuntime()
    } catch {
      return null
    }
  }

  _activePgLogWriter() {
    if (this._forceSyncWrite) return null
    if (this._pgLogWriter) {
      return this._pgLogWriter.stats?.().closed ? null : this._pgLogWriter
    }
    if (this.db?.engine !== 'postgres') return null
    const writer = getPgLogWriter()
    return writer && !writer.stats?.().closed ? writer : null
  }

  _resolvePgPool() {
    if (this._pgPool) return this._pgPool
    if (this.db?.engine !== 'postgres') return null
    return getPgPool()
  }

  _resolveVmOwner(vmId) {
    if (!vmId) return null
    const id = String(vmId)
    const cache = this._getCache()
    const entity = cache?.entity
    const useCache =
      entity &&
      typeof entity.getVmOwnerSync === 'function' &&
      (this.db?.engine === 'postgres' || this._hasExplicitCache || Boolean(cache?.client?.hasRedis))
    if (useCache) {
      return entity.getVmOwnerSync(id, () => this.repo.vmOwnerOf(id)) ?? null
    }
    return this.repo.vmOwnerOf(id) ?? null
  }

  _finishLive(requestId, completedSummary = null) {
    if (!requestId) return
    try {
      const liveLogs = this._getCache()?.liveLogs
      if (liveLogs && typeof liveLogs.finishRequest === 'function') {
        Promise.resolve(liveLogs.finishRequest(requestId, completedSummary)).catch(() => {})
      }
    } catch {}
  }

  _buildDebugRecord(ctx, summary, extra) {
    return {
      ...summary,
      headers: ctx.headers,
      inbound_summary: extra.inbound_summary || summarizeBody(extra.inbound_body),
      request_body_snapshot:
        !extra.classifier && extra.inbound_body != null ? sanitizeRequestBodySnapshot(extra.inbound_body) : null,
      inbound_body:
        !extra.classifier && extra.inbound_body != null ? clampBody(extra.inbound_body, this.maxDebugBodyChars) : null,
      hop_meta: extra.hop_meta || null,
      batch_member: extra.batch_member || null,
      via: extra.via || extra.hop_meta?.via || null,
      outbound_summary: extra.outbound_summary || null,
      cache_prefix: extra.cache_prefix || null,
      cache_continuity: extra.cache_continuity || null,
      classifier: extra.classifier || null,
      outbound_headers:
        ctx.capture_outbound && extra.outbound_headers != null ? redactHeaders(extra.outbound_headers) : null,
      outbound_headers_source: ctx.capture_outbound ? extra.outbound_headers_source || null : null,
      worker_envelope_headers:
        ctx.capture_outbound && extra.worker_envelope_headers != null
          ? redactHeaders(extra.worker_envelope_headers)
          : null,
      outbound_body:
        ctx.capture_outbound && !extra.classifier && extra.outbound_body != null
          ? clampBody(extra.outbound_body, this.maxDebugBodyChars)
          : null,
      outbound_body_source: ctx.capture_outbound ? extra.outbound_body_source || null : null,
      outbound_body_truncated: ctx.capture_outbound ? extra.outbound_body_truncated === true : false,
      response: ctx.response ? debugResponse(ctx.response) : null,
    }
  }

  _invalidateTotalRowsCache() {
    this._totalRowsCache = { value: null, at: 0 }
  }

  _snapshotTotalRows() {
    const now = Date.now()
    if (this.db?.engine === 'postgres') {
      if (this._totalRowsCache.value != null && now - this._totalRowsCache.at < PG_TOTAL_ROWS_CACHE_TTL_MS) {
        return this._totalRowsCache.value
      }
      const pool = this._resolvePgPool()
      if (pool && typeof pool.query === 'function' && !this._totalRowsRefreshPromise) {
        this._totalRowsRefreshPromise = (async () => {
          try {
            const est = await pool.query(
              "SELECT COALESCE(reltuples, -1)::bigint AS est FROM pg_class WHERE relname = 'usage_logs' LIMIT 1",
            )
            let count = Number(est?.rows?.[0]?.est ?? -1)
            if (!Number.isFinite(count) || count < 0) {
              const exact = await pool.query('SELECT COUNT(*)::bigint AS c FROM usage_logs')
              count = Number(exact?.rows?.[0]?.c ?? 0)
            }
            this._totalRowsCache = { value: Math.max(0, Math.trunc(count)), at: Date.now() }
          } catch {
            // Preserve last known value on failure
          } finally {
            this._totalRowsRefreshPromise = null
          }
        })()
      }
      return this._totalRowsCache.value
    }

    const useSqliteCache = isDbOpen() && this.db === getDb()
    if (
      useSqliteCache &&
      this._totalRowsCache.value != null &&
      now - this._totalRowsCache.at < SQLITE_TOTAL_ROWS_CACHE_TTL_MS
    ) {
      return this._totalRowsCache.value
    }
    try {
      const count = this.repo.count()
      if (useSqliteCache) {
        this._totalRowsCache = { value: count, at: now }
      }
      return count
    } catch {
      return null
    }
  }

  _snapshotInflightCount() {
    const liveLogs = this._getCache()?.liveLogs
    if (!liveLogs) return 0
    if (liveLogs.cache?.hasRedis && typeof liveLogs.getInflightCount === 'function') {
      const now = Date.now()
      if (!this._inflightRefreshPromise && now - this._inflightCache.at >= INFLIGHT_COUNT_CACHE_TTL_MS) {
        this._inflightRefreshPromise = Promise.resolve(liveLogs.getInflightCount())
          .then((n) => {
            this._inflightCache = { value: Math.max(0, Number(n) || 0), at: Date.now() }
          })
          .catch(() => {})
          .finally(() => {
            this._inflightRefreshPromise = null
          })
      }
      return this._inflightCache.value ?? liveLogs._localInflight?.size ?? 0
    }
    return liveLogs._localInflight?.size ?? 0
  }

  setConfig({ mode, retainDays, debugRetainDays, maxMb, mutedErrorClasses } = {}) {
    if (mode != null) {
      const m = String(mode).trim().toLowerCase()
      if (MODES.has(m)) this.mode = m
    }
    if (retainDays != null) {
      const n = Number(retainDays)
      if (Number.isFinite(n) && n > 0) this.retainDays = n
    }
    if (debugRetainDays != null) {
      const n = Number(debugRetainDays)
      if (Number.isFinite(n) && n > 0) this.debugRetainDays = n
    }
    if (maxMb != null) {
      const n = Number(maxMb)
      if (Number.isFinite(n) && n >= 0) this.maxMb = n
    }
    if (this.debugRetainDays > this.retainDays) this.debugRetainDays = this.retainDays
    if (mutedErrorClasses !== undefined) {
      this.mutedErrorClasses = resolveMutedErrorClasses(mutedErrorClasses)
    }
    return this.snapshot()
  }

  /** Kept for API compat + post-restore hook (state lives in DB). */
  reload() {
    this._recentNormalCount = 0
    this._invalidateTotalRowsCache()
  }

  /** Re-bind to a fresh DB connection (after backup restore). */
  rebind(db) {
    this.db = db
    this.repo = new UsageLogsRepo(db)
    this._recentNormalCount = 0
    this._invalidateTotalRowsCache()
  }

  start(
    req,
    {
      protocol = null,
      pathName = null,
      model = null,
      user_id = null,
      owner_user_id = null,
      api_key_id = null,
      session_key = null,
      session_id = null,
      outbound_session_id = null,
      vm_id = null,
      account_id = null,
      stream = null,
      has_tools = null,
      phase = 'routing',
      res = null,
    } = {},
  ) {
    const requestId = newRequestId(req)
    try {
      req.headers = req.headers || {}
    } catch {}
    const mode = resolveLogMode(this.mode, req)
    const t0 = Date.now()
    const cleanPath = pathName || String(req?.url || '').split('?', 1)[0]
    const method = req?.method || 'POST'
    const ip = safeIp(req)
    const userAgent = String(req?.headers?.['user-agent'] || '').slice(0, 512)
    const ctx = {
      request_id: requestId,
      mode,
      t0,
      protocol,
      // 兜底剥掉查询串：调用方都传 url.pathname，但 #1637 起 /v1beta/models 允许
      // 用 ?key= 携带凭据，一旦有新调用点漏传 pathName，原始 req.url 会带着真 key
      // 被 _appendJsonl 原样写进 request-logs（redactSecrets 只作用于 body）。
      path: cleanPath,
      method,
      ip,
      user_agent: userAgent,
      headers: mode === 'debug' ? redactHeaders(req?.headers) : null,
      // Outbound bodies carry the gateway's rewrite (persona / overlay) and are
      // readable by the owning tenant; only the operator's configured mode may
      // enable them, never the caller's x-kin-debug / x-kin-log header.
      capture_outbound: this.mode === 'debug',
      _liveSettled: false,
      _detachLifecycle: null,
    }

    if (mode !== 'off') {
      const alreadyClosed =
        Boolean(req?.aborted) ||
        (req?.destroyed === true && req?.complete === false) ||
        Boolean(res && (res.destroyed || res.closed) && !res.writableFinished)
      if (alreadyClosed) {
        ctx._liveSettled = true
      } else {
        try {
          const liveLogs = this._getCache()?.liveLogs
          if (liveLogs && typeof liveLogs.startRequest === 'function') {
            const resolvedUserId = user_id ?? req?.apiKeyRecord?.user_id ?? null
            const resolvedVmOwnerId = vm_id ? this._resolveVmOwner(vm_id) : null
            const resolvedOwnerId = owner_user_id ?? resolvedUserId ?? resolvedVmOwnerId ?? null
            const resolvedKeyId = api_key_id ?? req?.apiKeyRecord?.id ?? null
            const resolvedSessionKey = session_key || session_id || outbound_session_id || null
            Promise.resolve(
              liveLogs.startRequest(requestId, {
                request_id: requestId,
                started_at: t0,
                created_at: new Date(t0).toISOString(),
                log_mode: mode,
                method,
                path: cleanPath,
                endpoint: cleanPath,
                protocol,
                model: model || null,
                requested_model: model || null,
                stream: stream == null ? null : !!stream,
                has_tools: has_tools == null ? null : !!has_tools,
                user_id: resolvedUserId ?? null,
                owner_user_id: resolvedOwnerId ?? null,
                vm_owner_user_id: resolvedVmOwnerId ?? null,
                api_key_id: resolvedKeyId ?? null,
                session_key: resolvedSessionKey,
                session_id: session_id ?? resolvedSessionKey ?? null,
                outbound_session_id: outbound_session_id ?? null,
                client_ip: ip || null,
                ip_address: ip || null,
                user_agent: userAgent || null,
                vm_id: vm_id || null,
                account_id: account_id || null,
                phase,
                attempt_count: 0,
              }),
            ).catch(() => {})
          }
        } catch {}
        this.bindLifecycle(ctx, req, res)
      }
    }

    return ctx
  }

  _detachLifecycle(ctx) {
    if (!ctx || typeof ctx._detachLifecycle !== 'function') return
    const detach = ctx._detachLifecycle
    ctx._detachLifecycle = null
    try {
      detach()
    } catch {}
  }

  /**
   * Bind idempotent abort/close listeners on `req` and `res` so client disconnects,
   * timeouts, or premature socket closes that never emit `res` `finish` still
   * clean up `live:inflight` and `live:sess:conc:*` via `liveLogs.finishRequest(id, null)`.
   */
  bindLifecycle(ctx, req = null, res = null) {
    if (!ctx || ctx.mode === 'off' || ctx._liveSettled) return () => {}
    this._detachLifecycle(ctx)
    if (
      req?.aborted ||
      (req?.destroyed === true && req?.complete === false) ||
      (res && (res.destroyed || res.closed) && !res.writableFinished)
    ) {
      this.abort(ctx)
      return () => {}
    }
    const cleanups = []
    const onAbort = () => {
      this.abort(ctx)
    }
    const onReqClose = () => {
      if (req?.aborted || req?.complete === false) {
        this.abort(ctx)
      }
    }
    const onResClose = () => {
      if (!res?.writableFinished) {
        this.abort(ctx)
      }
    }
    const bind = (emitter, event, fn) => {
      if (!emitter || typeof emitter.once !== 'function') return
      emitter.once(event, fn)
      cleanups.push(() => {
        try {
          if (typeof emitter.off === 'function') emitter.off(event, fn)
          else if (typeof emitter.removeListener === 'function') emitter.removeListener(event, fn)
        } catch {}
      })
    }
    bind(req, 'aborted', onAbort)
    bind(req, 'close', onReqClose)
    bind(res, 'close', onResClose)
    const detach = () => {
      if (ctx._detachLifecycle === detach) ctx._detachLifecycle = null
      for (const fn of cleanups.splice(0)) fn()
    }
    ctx._detachLifecycle = detach
    return detach
  }

  /**
   * Idempotently settle an in-flight request that aborted, disconnected, or exited
   * early without reaching `finish()`, cleaning up `live:inflight` and `live:sess:conc:*`.
   */
  abort(ctx) {
    if (!ctx || ctx.mode === 'off' || ctx._liveSettled) return false
    ctx._liveSettled = true
    this._detachLifecycle(ctx)
    this._finishLive(ctx.request_id, null)
    return true
  }

  /**
   * Non-blocking phase/attempt/TTFT update for an in-flight request.
   * Forwards to `LiveLogCache.updatePhase()` (microtask coalesced, zero PG write).
   */
  updatePhase(requestId, patch = {}) {
    const id = typeof requestId === 'object' ? requestId?.request_id : requestId
    if (!id || !patch || typeof patch !== 'object') return
    try {
      const liveLogs = this._getCache()?.liveLogs
      if (liveLogs && typeof liveLogs.updatePhase === 'function') {
        const enrichedPatch =
          patch.vm_id && patch.vm_owner_user_id === undefined
            ? { ...patch, vm_owner_user_id: this._resolveVmOwner(patch.vm_id) }
            : patch
        liveLogs.updatePhase(id, enrichedPatch)
      }
    } catch {}
  }

  /**
   * Debug mode only: mirror what the client actually received (status,
   * headers, body bytes up to maxDebugBodyChars) onto `ctx.response` so
   * finish() can store it next to the inbound/outbound bodies. Normal mode
   * never wraps the response.
   */
  tapResponse(ctx, res) {
    if (!ctx || ctx.mode !== 'debug' || !res || ctx.response) return
    const limit = Math.max(0, this.maxDebugBodyChars)
    const captured = { status: null, headers: null, body: '', bytes: 0, truncated: false }
    ctx.response = captured
    const decoder = new TextDecoder()
    const take = (chunk, encoding) => {
      if (chunk == null || typeof chunk === 'function') return
      const buf =
        typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8') : chunk
      if (!(buf instanceof Uint8Array)) return
      captured.bytes += buf.byteLength
      if (captured.truncated) return
      const room = limit - captured.body.length
      const text = decoder.decode(buf, { stream: true })
      if (text.length <= room) {
        captured.body += text
        return
      }
      captured.body += text.slice(0, Math.max(0, room))
      captured.truncated = true
    }
    let writeHeadStatus = null
    let writeHeadHeaders = null
    if (typeof res.writeHead === 'function') {
      const writeHead = res.writeHead
      res.writeHead = function tappedWriteHead(statusCode, statusMessage, headers) {
        let rawHeaders = null
        if (typeof statusMessage === 'string') rawHeaders = headers
        else if (statusMessage != null) rawHeaders = statusMessage
        else if (headers != null) rawHeaders = headers
        const out = writeHead.apply(this, arguments)
        const parsedStatus = Number(statusCode)
        if (Number.isInteger(parsedStatus) && parsedStatus > 0) writeHeadStatus = parsedStatus
        const normalized = normalizeWriteHeadHeaders(rawHeaders)
        if (normalized) writeHeadHeaders = { ...(writeHeadHeaders || {}), ...normalized }
        return out
      }
    }
    const write = res.write
    const end = res.end
    res.write = function tappedWrite(chunk, encoding, cb) {
      take(chunk, encoding)
      return write.call(this, chunk, encoding, cb)
    }
    res.end = function tappedEnd(chunk, encoding, cb) {
      take(chunk, encoding)
      return end.call(this, chunk, encoding, cb)
    }
    res.once('finish', () => {
      captured.status = res.statusCode || writeHeadStatus || null
      try {
        const merged = {}
        const fromSetHeader = res.getHeaders?.() || {}
        for (const [k, v] of Object.entries(fromSetHeader)) {
          if (v === undefined) continue
          const key = String(k).trim().toLowerCase()
          if (key) merged[key] = v
        }
        if (writeHeadHeaders) Object.assign(merged, writeHeadHeaders)
        captured.headers = redactHeaders(merged)
      } catch {}
    })
  }

  /**
   * Write normal summary always (unless off).
   * Write debug full record when mode===debug.
   */
  finish(ctx, extra = {}) {
    if (!ctx || ctx.mode === 'off') return null
    ctx._liveSettled = true
    this._detachLifecycle(ctx)
    const duration_ms = Math.max(0, Date.now() - (ctx.t0 || Date.now()))
    if (extra.merge_into_request_id) {
      this._finishLive(ctx.request_id, null)
      const parentId = String(extra.merge_into_request_id).trim()
      if (parentId) {
        const continuation =
          ctx.mode === 'debug'
            ? {
                request_id: ctx.request_id,
                ts: new Date().toISOString(),
                duration_ms,
                ...(extra.tool_continuation && typeof extra.tool_continuation === 'object'
                  ? extra.tool_continuation
                  : {}),
              }
            : null
        const persistMerge = () => {
          try {
            withSavepoint(this.repo.db, 'reqlog_merge', () => {
              this.repo.mergeToolContinuation(parentId, { durationMs: duration_ms, continuation })
            })
          } catch {}
        }
        const pgWriter = this._activePgLogWriter()
        if (pgWriter && pgWriter.pending() > 0) {
          // Ensure parent row queued in PgLogWriter is flushed before merging continuation duration/debug.
          Promise.resolve(pgWriter.flush())
            .catch(() => {})
            .finally(() => {
              if (writeBehindArmed()) enqueueWrite(persistMerge)
              else persistMerge()
            })
        } else if (writeBehindArmed()) {
          enqueueWrite(persistMerge)
        } else {
          persistMerge()
        }
      }
      return null
    }
    if (extra.skip_log) {
      this._finishLive(ctx.request_id, null)
      return null
    }
    const usage = normalizeUsage(disjointOpenaiUsage(extra.usage || {}) || {})
    const breakdown = cacheCreationBreakdown(usage)
    const webSearch = extra.web_search_requests ?? webSearchRequestsOf(usage)
    const billedUsage = {
      ...usage,
      input_tokens: extra.input_tokens ?? usage.input_tokens,
      output_tokens: extra.output_tokens ?? usage.output_tokens,
      cache_read_tokens: extra.cache_read_tokens ?? usage.cache_read_input_tokens ?? usage.cache_read_tokens,
      cache_creation_tokens:
        extra.cache_creation_tokens ?? usage.cache_creation_input_tokens ?? usage.cache_creation_tokens,
      cache_creation_5m_tokens:
        extra.cache_creation_5m_tokens ?? usage.cache_creation_5m_tokens ?? breakdown.cache_creation_5m_tokens,
      cache_creation_1h_tokens:
        extra.cache_creation_1h_tokens ?? usage.cache_creation_1h_tokens ?? breakdown.cache_creation_1h_tokens,
      cache_creation: usage.cache_creation,
      web_search_requests: webSearch,
      cache_ttl: usage.cache_ttl,
      service_tier: extra.service_tier ?? usage.service_tier,
      speed: extra.speed ?? usage.speed,
      requested_speed: extra.requested_speed ?? usage.requested_speed,
    }
    const upstreamType = sanitizeErrorToken(extra.upstream_type ?? extra.error_details?.upstream_type, 128)
    const errorDetails = sanitizeErrorDetailsForLog(extra.error_details, {
      status: extra.status ?? null,
      upstreamType,
    })
    const summary = {
      id: 'log_' + crypto.randomBytes(6).toString('hex'),
      request_id: ctx.request_id,
      ts: new Date().toISOString(),
      log_mode: ctx.mode,
      method: ctx.method,
      path: extra.path || ctx.path,
      protocol: extra.protocol || ctx.protocol || null,
      model: extra.model || null,
      stream: !!extra.stream,
      status: extra.status ?? null,
      upstream_status: extra.audit_upstream_400
        ? 400
        : Number.isInteger(extra.audit_upstream_error_status) && extra.audit_upstream_error_status >= 400
          ? extra.audit_upstream_error_status
          : Number(extra.upstream_status) === 400
            ? null
            : (extra.upstream_status ?? null),
      upstream_400_message: extra.audit_upstream_400_message
        ? String(extra.audit_upstream_400_message).slice(0, 300)
        : null,
      duration_ms,
      api_key_kind: extra.api_key_kind || null,
      api_key_id: extra.api_key_id || null,
      vm_id: extra.vm_id || null,
      account_id: extra.account_id || null,
      workspace: extra.workspace || null,
      input_tokens: extra.input_tokens ?? usage.input_tokens ?? null,
      output_tokens: extra.output_tokens ?? usage.output_tokens ?? null,
      error_code: extra.error_code || null,
      error_message: extra.error_message ? String(extra.error_message).slice(0, 300) : null,
      upstream_type: upstreamType,
      error_details: errorDetails,
      user_agent: ctx.user_agent,
      ip: ctx.ip,
      api_key_presented: extra.api_key_presented ? presentedApiKeyForLog(extra.api_key_presented) : null,
      has_tools: extra.has_tools ?? null,
      via: extra.via || extra.hop_meta?.via || null,
      cache_read_tokens: extra.cache_read_tokens ?? usage.cache_read_tokens ?? usage.cache_read_input_tokens ?? null,
      cache_creation_tokens:
        extra.cache_creation_tokens ?? usage.cache_creation_tokens ?? usage.cache_creation_input_tokens ?? null,
      ...breakdown,
      web_search_requests: webSearch,
      requested_model: extra.requested_model || extra.model || null,
      upstream_model: extra.upstream_model || null,
      model_mismatch: modelMismatch(extra.requested_model || extra.model, extra.upstream_model),
      first_token_ms: extra.first_token_ms ?? null,
      first_byte_ms: extra.first_byte_ms ?? null,
      generation_ms: extra.generation_ms ?? null,
      stop_reason: extra.stop_reason || usage.stop_reason || null,
      attempt_count: extra.attempt_count ?? null,
      final_state: extra.final_state || null,
      final_account_id: extra.final_account_id || extra.account_id || null,
      usage_account_id: extra.usage_account_id || null,
      session_id: sessionIdForLog(extra.session_id),
      outbound_session_id: sessionIdForLog(extra.outbound_session_id),
      reasoning_effort: REASONING_EFFORTS.has(extra.reasoning_effort) ? extra.reasoning_effort : null,
      inbound_device_id: sessionIdForLog(extra.inbound_device_id),
      // Gate verdict JSON from intercept-gate; the risk audit groups on it.
      intercept: extra.intercept ? String(extra.intercept).slice(0, 400) : null,
      // Exact classifyJev payload.state. Context, not a span the model named.
      jev_state: extra.jev_state ? String(extra.jev_state).slice(0, 64000) : null,
      image_model: extra.image_model || null,
      image_usage: extra.image_usage ? JSON.stringify(extra.image_usage) : null,
      image_input_tokens: imageTokenCount(extra.image_usage?.input_tokens),
      image_output_tokens: imageTokenCount(extra.image_usage?.output_tokens),
      advisor_usage: (() => {
        const detail = Array.isArray(extra.advisor_usage)
          ? extra.advisor_usage
          : advisorUsageFromIterations(billedUsage)
        return detail?.length ? JSON.stringify(detail) : null
      })(),
      // Ownership and billing columns
      user_id: extra.user_id ?? null,
      vm_owner_user_id: null,
      group_id: extra.group_id ?? 1,
      rate_multiplier: Number.isFinite(Number(extra.rate_multiplier)) ? Number(extra.rate_multiplier) : 1,
      ...costColumnsForLog(billedUsage, extra.upstream_model || extra.model || extra.requested_model, extra),
      upstream_service_tier: extra.upstream_service_tier || null,
    }
    // Unless supplied, actual_cost is the official cost × group rate (0 is valid).
    if (summary.total_cost != null) {
      summary.actual_cost = extra.actual_cost ?? summary.total_cost * summary.rate_multiplier
    }
    const classified = classifyRequestError(summary)
    if (classified?.error_class) summary.error_class = classified.error_class

    summary.vm_owner_user_id = this._resolveVmOwner(extra.vm_id)

    this._finishLive(ctx.request_id, {
      ...summary,
      created_at: summary.ts,
      ip_address: summary.ip,
      completed_at: Date.now(),
      owner_user_id: summary.user_id ?? summary.vm_owner_user_id ?? null,
      session_key: summary.session_id || summary.outbound_session_id || null,
    })

    this._recentNormalCount = Math.min(this._memMax, this._recentNormalCount + 1)
    if (this.db?.engine === 'postgres') {
      if (this._totalRowsCache.value != null) {
        this._totalRowsCache.value += 1
      }
    } else {
      this._invalidateTotalRowsCache()
    }

    const pgWriter = this._activePgLogWriter()
    if (pgWriter) {
      const debugRec = ctx.mode === 'debug' ? this._buildDebugRecord(ctx, summary, extra) : null
      pgWriter.enqueueUsageLog(summary, debugRec)
      if (this.jsonlMirror) this._appendJsonl(summary)
      return summary
    }

    const persist = () => {
      try {
        withSavepoint(this.repo.db, 'reqlog_sum', () => {
          this.repo.insertSummaryIfAbsent(summary)
        })
      } catch {}
      if (this.jsonlMirror) this._appendJsonl(summary)
      if (ctx.mode !== 'debug') return
      const debugRec = this._buildDebugRecord(ctx, summary, extra)
      try {
        withSavepoint(this.repo.db, 'reqlog_dbg', () => {
          this.repo.insertDebug(summary.request_id || summary.id, summary.ts, debugRec)
        })
      } catch {}
    }
    if (writeBehindArmed()) enqueueWrite(persist)
    else persist()
    return summary
  }

  /** Optional legacy JSONL mirror for external log collectors. */
  _appendJsonl(summary) {
    try {
      fs.mkdirSync(this.root, { recursive: true })
      const file = path.join(this.root, `${dayKey()}.jsonl`)
      fs.appendFileSync(file, JSON.stringify(summary) + '\n', { mode: 0o600 })
    } catch {}
  }

  _mutedExclude(opts = {}) {
    if (opts.error_class || opts.include_muted) return null
    if (opts.exclude_error_class != null && String(opts.exclude_error_class).trim() !== '') {
      return opts.exclude_error_class
    }
    return this.mutedErrorClasses.length ? this.mutedErrorClasses.join(',') : null
  }

  _dropMuted(items, exclude) {
    if (!exclude) return items
    const blocked = new Set(
      String(exclude)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    if (!blocked.size) return items
    return (items || []).filter((row) => !row.error_class || !blocked.has(row.error_class))
  }

  listNormal({ limit = 50, ...filters } = {}) {
    return this.queryNormal({ limit, ...filters }).items
  }

  /** Filtered + paginated query with total (panel). Default hides muted classes. */
  queryNormal(opts = {}) {
    const exclude = this._mutedExclude(opts)
    const result = this.repo.query({ ...opts, exclude_error_class: exclude })
    result.items = this._dropMuted(result.items, exclude)
    return result
  }

  exportRows(opts = {}) {
    const limit = Math.max(1, Math.min(5000, Number(opts.limit) || 2000))
    return this.queryNormal({ ...opts, limit, offset: 0, maxLimit: 5000 })
  }

  /** Aggregated stats for charts. */
  aggregate(opts = {}) {
    return this.repo.aggregate(opts)
  }

  totals() {
    return this.repo.totals()
  }

  hasSuccessfulRequest(opts = {}) {
    return this.repo.hasSuccessfulRequest(opts)
  }

  billingStats(opts = {}) {
    return this.repo.billingStats(opts)
  }

  healthBuckets(opts = {}) {
    return this.repo.healthBuckets(opts)
  }

  topErrors(opts) {
    return this.repo.topErrors(opts)
  }

  ownerBilling(opts = {}) {
    return this.repo.ownerBilling(opts)
  }

  costByModel(opts = {}) {
    return this.repo.costByModel(opts)
  }

  vmUsageStats(opts = {}) {
    return this.repo.vmUsageStats(opts)
  }

  costBetween(opts = {}) {
    return this.repo.costBetween(opts)
  }

  keyUsageStats(opts = {}) {
    return this.repo.keyUsageStats(opts)
  }

  /** Windowed SLA / QPS / TTFT snapshot for overview + log analysis. */
  windowStats(opts = {}) {
    return this.repo.windowStats(opts)
  }

  protocolEntryStats(opts = {}) {
    return this.repo.protocolEntryStats(opts)
  }

  listDebug({
    limit = 20,
    exclude_error_class = null,
    include_muted = false,
    error_class = null,
    owner_user_id = null,
  } = {}) {
    const exclude = this._mutedExclude({ exclude_error_class, include_muted, error_class })
    const n = Math.max(1, Math.min(100, Number(limit) || 20))
    const pool = this.repo.listDebug({ limit: exclude ? Math.min(200, n * 15) : n, owner_user_id })
    const items = error_class ? pool.filter((row) => row.error_class === error_class) : this._dropMuted(pool, exclude)
    return items.slice(0, n)
  }

  getDebug(requestId, { owner_user_id = null } = {}) {
    if (!requestId) return null
    const rec = this.repo.getDebug(requestId) || this.repo.getByRequestId(requestId)
    if (!rec) return null
    if (owner_user_id && !this.repo.belongsToOwner(requestId, owner_user_id)) return null
    return rec
  }

  snapshot() {
    const pgWriter = this._activePgLogWriter()
    return {
      mode: this.mode,
      retain_days: this.retainDays,
      debug_retain_days: this.debugRetainDays,
      max_mb: this.maxMb,
      muted_error_classes: this.mutedErrorClasses.slice(),
      recent_normal: this._recentNormalCount,
      backend: this.db?.engine === 'postgres' ? 'postgres' : 'sqlite',
      jsonl_mirror: this.jsonlMirror,
      total_rows: this._snapshotTotalRows(),
      inflight_count: this._snapshotInflightCount(),
      pg_log_writer: pgWriter ? pgWriter.stats() : null,
    }
  }

  /**
   * Retention: delete rows older than retain windows, then enforce max_mb.
   * On PostgreSQL with an async pool, runs non-blocking ctid-batched cleanup off
   * the main thread and invalidates dashboard caches afterward; on SQLite runs
   * the synchronous repository cleanup.
   */
  cleanup() {
    const opts = {
      retainDays: this.retainDays,
      debugRetainDays: this.debugRetainDays,
      maxBytes: this.maxMb > 0 ? this.maxMb * 1024 * 1024 : 0,
    }
    this._invalidateTotalRowsCache()

    const pool = this._resolvePgPool()
    if (this.db?.engine === 'postgres' && pool && typeof pool.query === 'function') {
      if (this._cleanupInFlight) return this._cleanupInFlight
      const task = (async () => {
        try {
          const result = await runRetentionCleanupAsync(pool, opts)
          this._invalidateTotalRowsCache()
          if (result && !result.skipped && (result.usage_logs > 0 || result.request_log_debug > 0)) {
            await this._getCache()
              ?.dashboard?.invalidateNamespaces?.(CLEANUP_INVALIDATE_NAMESPACES)
              .catch(() => {})
          }
          this._cleanupLegacyFiles(this.retainDays, this.root)
          this._cleanupLegacyFiles(this.debugRetainDays, path.join(this.root, 'debug'))
          return result
        } catch (err) {
          console.warn('[request-log] async retention cleanup failed:', err?.message || err)
          return null
        } finally {
          this._cleanupInFlight = null
        }
      })()
      this._cleanupInFlight = task
      return task
    }

    let result = null
    try {
      result = this.repo.cleanup(opts)
    } catch {}
    if (result && (result.usage_logs > 0 || result.request_log_debug > 0)) {
      this._getCache()
        ?.dashboard?.invalidateNamespaces?.(CLEANUP_INVALIDATE_NAMESPACES)
        .catch(() => {})
    }
    this._cleanupLegacyFiles(this.retainDays, this.root)
    this._cleanupLegacyFiles(this.debugRetainDays, path.join(this.root, 'debug'))
    return result
  }

  startCleanupScheduler({ intervalMs = CLEANUP_INTERVAL_MS } = {}) {
    this.stopCleanupScheduler()
    const ms = Math.max(60_000, Number(intervalMs) || CLEANUP_INTERVAL_MS)
    const run = () => {
      try {
        Promise.resolve(this.cleanup()).catch(() => {})
      } catch {}
    }
    this._cleanupTimer = setInterval(run, ms)
    if (typeof this._cleanupTimer.unref === 'function') this._cleanupTimer.unref()
  }

  stopCleanupScheduler() {
    clearInterval(this._cleanupTimer)
    this._cleanupTimer = null
  }

  _cleanupLegacyFiles(days, dir) {
    const cutoff = Date.now() - days * 86400_000
    try {
      if (!fs.existsSync(dir)) return
      for (const name of fs.readdirSync(dir)) {
        if (!/^\d{4}-\d{2}-\d{2}/.test(name)) continue
        const dayMs = Date.parse(name.slice(0, 10) + 'T00:00:00Z')
        if (!Number.isFinite(dayMs) || dayMs >= cutoff) continue
        fs.rmSync(path.join(dir, name), { recursive: true, force: true })
      }
    } catch {}
  }
}

const EXPORT_COLUMNS = [
  'ts',
  'request_id',
  'method',
  'path',
  'protocol',
  'status',
  'error_class',
  'error_code',
  'error_message',
  'error_label',
  'upstream_type',
  'error_details',
  'model',
  'vm_id',
  'ip',
  'api_key_presented',
  'duration_ms',
  'first_token_ms',
  'first_byte_ms',
  'generation_ms',
  'input_tokens',
  'output_tokens',
  'total_cost',
  'api_key_id',
  'api_key_kind',
]

function csvCell(v) {
  if (v == null || v === '') return ''
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function logsToCsv(items = []) {
  const header = EXPORT_COLUMNS.join(',')
  const rows = items.map((row) => EXPORT_COLUMNS.map((k) => csvCell(row[k])).join(','))
  return [header, ...rows].join('\n') + (items.length ? '\n' : '')
}

export function logsToJsonl(items = []) {
  return (
    items
      .map((row) => {
        const out = {}
        for (const k of EXPORT_COLUMNS) out[k] = row[k] ?? null
        return JSON.stringify(out)
      })
      .join('\n') + (items.length ? '\n' : '')
  )
}

export { summarizeBody, redactHeaders, clampBody, DEFAULT_RETAIN_DAYS, DEFAULT_DEBUG_RETAIN_DAYS, DEFAULT_MAX_MB }
