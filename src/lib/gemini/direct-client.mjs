import http from 'node:http'
import path from 'node:path'
import { GEMINI_LICENSE_MESSAGES } from './subscription.mjs'

const TOKEN_RE = /^[!-~]{24,4096}$/
const MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const CONV_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_ENVELOPE_BYTES = 12 * 1024 * 1024
const MAX_ERROR_BODY_BYTES = 64 * 1024
const DEFAULT_TARGET_TTL_MS = 30_000
const UNSUPPORTED_RETRY_MS = 5 * 60_000
const MAX_CACHED_TARGETS = 1024

const ALLOWED_TOP_KEYS = new Set([
  'model',
  'contents',
  'systemInstruction',
  'system_instruction',
  'system_prompt_mode',
  'tools',
  'toolConfig',
  'tool_config',
  'generationConfig',
  'generation_config',
  'safetySettings',
  'safety_settings',
  'cachedContent',
  'cached_content',
  'conversation_id',
  'conversationId',
])

const ALLOWED_PART_KEYS = new Set([
  'text',
  'inlineData',
  'inline_data',
  'fileData',
  'file_data',
  'functionCall',
  'function_call',
  'functionResponse',
  'function_response',
  'thought',
  'thoughtSignature',
  'thought_signature',
  'executableCode',
  'codeExecutionResult',
])

const SUBSTANTIVE_PART_KEYS = new Set([
  'inlineData',
  'inline_data',
  'fileData',
  'file_data',
  'functionCall',
  'function_call',
  'functionResponse',
  'function_response',
])

const ALLOWED_TOOL_KEYS = new Set([
  'functionDeclarations',
  'function_declarations',
  'googleSearch',
  'google_search',
  'googleSearchRetrieval',
  'google_search_retrieval',
  'urlContext',
  'url_context',
  'codeExecution',
  'code_execution',
])

const VALID_ASPECT_RATIOS = new Set(['1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '4:5', '5:4', '21:9'])

const VALID_IMAGE_SIZES = new Set(['1K', '2K', '4K'])
const VALID_THINKING_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'extra_high', 'none'])
// eslint-disable-next-line no-control-regex
const ILLEGAL_CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/

const LICENSE_ERROR_CODES = new Set([
  'license_required',
  'license_expired',
  'license_not_yet_valid',
  'license_invalid',
  'license_binding_mismatch',
  'license_payload_key_mismatch',
  'license_unconfigured',
])

const TRANSPORT_FALLBACK_CODES = new Set([
  'ENOENT',
  'ECONNREFUSED',
  'EACCES',
  'EPERM',
  'ECONNRESET',
  'EPIPE',
  'ENOTDIR',
])

/**
 * Prepare a Gemini request body for direct submission into CRAGGemini's
 * `/internal/v1/accounts/{id}/messages` or `/internal/v1/messages` Unix socket,
 * matching `scripts/gemini-host.py::_extract_native_turn_body` semantics.
 */
export function prepareDirectNativeTurnBody(model, bodyObj) {
  if (!bodyObj || typeof bodyObj !== 'object' || Array.isArray(bodyObj)) return null
  for (const key of Object.keys(bodyObj)) {
    if (!ALLOWED_TOP_KEYS.has(key)) return null
  }
  const mode = bodyObj.system_prompt_mode
  if (mode !== undefined && mode !== null && mode !== 'official_full' && mode !== 'zero') {
    return null
  }
  const contents = bodyObj.contents
  if (!Array.isArray(contents) || contents.length === 0) return null

  let hasSubstantivePart = false
  const cleanedContents = []
  for (const entry of contents) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
    for (const k of Object.keys(entry)) {
      if (k !== 'role' && k !== 'parts') return null
    }
    if (entry.role !== undefined && entry.role !== null && entry.role !== 'user' && entry.role !== 'model') {
      return null
    }
    const parts = entry.parts
    if (!Array.isArray(parts) || parts.length === 0) return null
    const cleanedParts = []
    for (const part of parts) {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return null
      const partKeys = Object.keys(part)
      if (partKeys.length === 0) return null
      for (const k of partKeys) {
        if (!ALLOWED_PART_KEYS.has(k)) return null
      }
      if ('text' in part) {
        const text = part.text
        if (typeof text !== 'string' || ILLEGAL_CTRL_RE.test(text)) return null
        if (text.trim() && part.thought !== true) hasSubstantivePart = true
      }
      if (!hasSubstantivePart) {
        for (const k of partKeys) {
          if (SUBSTANTIVE_PART_KEYS.has(k)) {
            hasSubstantivePart = true
            break
          }
        }
      }
      if (part.thought === true) continue
      const fd =
        part.fileData && typeof part.fileData === 'object' && !Array.isArray(part.fileData)
          ? part.fileData
          : part.file_data && typeof part.file_data === 'object' && !Array.isArray(part.file_data)
            ? part.file_data
            : null
      if (fd) {
        const mime = fd.mimeType || fd.mime_type || 'application/octet-stream'
        const uri = fd.fileUri || fd.file_uri || ''
        cleanedParts.push({ text: uri ? `[Attached ${mime}: ${uri}]` : `[Attached ${mime}]` })
        continue
      }
      if (
        part.thoughtSignature === 'skip_thought_signature_validator' ||
        part.thought_signature === 'skip_thought_signature_validator'
      ) {
        const cleanedPart = {}
        for (const [k, v] of Object.entries(part)) {
          if ((k === 'thoughtSignature' || k === 'thought_signature') && v === 'skip_thought_signature_validator') {
            continue
          }
          cleanedPart[k] = v
        }
        if (Object.keys(cleanedPart).length > 0) cleanedParts.push(cleanedPart)
      } else {
        cleanedParts.push(part)
      }
    }
    if (cleanedParts.length > 0) {
      const cleanedEntry = { parts: cleanedParts }
      if (entry.role !== undefined && entry.role !== null) cleanedEntry.role = entry.role
      cleanedContents.push(cleanedEntry)
    }
  }
  if (!hasSubstantivePart || cleanedContents.length === 0) return null

  const forwarded = { model, contents: cleanedContents }

  const sysInst = bodyObj.systemInstruction !== undefined ? bodyObj.systemInstruction : bodyObj.system_instruction
  if (sysInst !== undefined && sysInst !== null) {
    forwarded.systemInstruction = sysInst
  }
  if (mode !== undefined && mode !== null) {
    forwarded.system_prompt_mode = mode
  }

  const rawToolCfg = bodyObj.toolConfig !== undefined ? bodyObj.toolConfig : bodyObj.tool_config
  const fcCfg =
    rawToolCfg && typeof rawToolCfg === 'object' && !Array.isArray(rawToolCfg)
      ? rawToolCfg.functionCallingConfig && typeof rawToolCfg.functionCallingConfig === 'object'
        ? rawToolCfg.functionCallingConfig
        : rawToolCfg.function_calling_config && typeof rawToolCfg.function_calling_config === 'object'
          ? rawToolCfg.function_calling_config
          : null
      : null
  const toolModeNone = Boolean(fcCfg && String(fcCfg.mode || '').toUpperCase() === 'NONE')

  if (!toolModeNone && Array.isArray(bodyObj.tools)) {
    const cleanedTools = []
    for (const t of bodyObj.tools) {
      if (!t || typeof t !== 'object' || Array.isArray(t)) continue
      const filtered = {}
      for (const [k, v] of Object.entries(t)) {
        if (ALLOWED_TOOL_KEYS.has(k)) filtered[k] = v
      }
      if (Object.keys(filtered).length > 0) cleanedTools.push(filtered)
    }
    if (cleanedTools.length > 0) {
      forwarded.tools = cleanedTools
      if (
        rawToolCfg &&
        typeof rawToolCfg === 'object' &&
        !Array.isArray(rawToolCfg) &&
        Object.keys(rawToolCfg).length > 0
      ) {
        forwarded.toolConfig = rawToolCfg
      }
    }
  }

  const rawGen = bodyObj.generationConfig !== undefined ? bodyObj.generationConfig : bodyObj.generation_config
  if (rawGen && typeof rawGen === 'object' && !Array.isArray(rawGen)) {
    const cleanedGen = {}
    const rawMods = rawGen.responseModalities !== undefined ? rawGen.responseModalities : rawGen.response_modalities
    if (Array.isArray(rawMods)) {
      const mods = rawMods
        .filter((m) => typeof m === 'string')
        .map((m) => m.toUpperCase())
        .filter((m) => m === 'TEXT' || m === 'IMAGE')
      if (mods.includes('IMAGE')) cleanedGen.responseModalities = mods
    }
    const rawImg = rawGen.imageConfig !== undefined ? rawGen.imageConfig : rawGen.image_config
    if (rawImg && typeof rawImg === 'object' && !Array.isArray(rawImg)) {
      const cleanImg = {}
      const ratio = rawImg.aspectRatio !== undefined ? rawImg.aspectRatio : rawImg.aspect_ratio
      if (typeof ratio === 'string' && VALID_ASPECT_RATIOS.has(ratio.trim())) {
        cleanImg.aspectRatio = ratio.trim()
      }
      const size = rawImg.imageSize !== undefined ? rawImg.imageSize : rawImg.image_size
      if (typeof size === 'string' && VALID_IMAGE_SIZES.has(size.trim().toUpperCase())) {
        cleanImg.imageSize = size.trim().toUpperCase()
      }
      if (Object.keys(cleanImg).length > 0) cleanedGen.imageConfig = cleanImg
    }
    const candCount = rawGen.candidateCount !== undefined ? rawGen.candidateCount : rawGen.candidate_count
    if (
      ('responseModalities' in cleanedGen || 'imageConfig' in cleanedGen) &&
      Number.isInteger(candCount) &&
      candCount >= 1 &&
      candCount <= 8
    ) {
      cleanedGen.candidateCount = candCount
    }
    const rawTc = rawGen.thinkingConfig !== undefined ? rawGen.thinkingConfig : rawGen.thinking_config
    if (rawTc && typeof rawTc === 'object' && !Array.isArray(rawTc)) {
      const cleanTc = {}
      const inc = rawTc.includeThoughts !== undefined ? rawTc.includeThoughts : rawTc.include_thoughts
      if (typeof inc === 'boolean') cleanTc.includeThoughts = inc
      const lvl = rawTc.thinkingLevel !== undefined ? rawTc.thinkingLevel : rawTc.thinking_level
      if (typeof lvl === 'string' && VALID_THINKING_LEVELS.has(lvl.trim().toLowerCase())) {
        cleanTc.thinkingLevel = lvl.trim().toLowerCase()
      }
      const budget = rawTc.thinkingBudget !== undefined ? rawTc.thinkingBudget : rawTc.thinking_budget
      if (Number.isInteger(budget) && budget >= -1 && budget <= 131072) {
        cleanTc.thinkingBudget = budget
      }
      if (Object.keys(cleanTc).length > 0) cleanedGen.thinkingConfig = cleanTc
    }
    if (Object.keys(cleanedGen).length > 0) forwarded.generationConfig = cleanedGen
  }

  const convId =
    typeof bodyObj.conversation_id === 'string' && bodyObj.conversation_id
      ? bodyObj.conversation_id
      : typeof bodyObj.conversationId === 'string' && bodyObj.conversationId
        ? bodyObj.conversationId
        : null
  if (convId && CONV_ID_RE.test(convId)) {
    forwarded.conversation_id = convId
  }

  return forwarded
}

export function buildDirectEnvelope({ model, requestId, bodyObj, gatewayPolicy = null, restartResume = false }) {
  if (
    typeof model !== 'string' ||
    !MODEL_RE.test(model) ||
    typeof requestId !== 'string' ||
    !REQUEST_ID_RE.test(requestId)
  ) {
    return null
  }
  const nativeBody = prepareDirectNativeTurnBody(model, bodyObj)
  if (!nativeBody) return null
  let wireBody = nativeBody
  const mode = nativeBody.system_prompt_mode
  if (mode !== undefined) {
    wireBody = { ...nativeBody }
    delete wireBody.system_prompt_mode
  }
  const envelope = {
    request_id: requestId,
    stream: true,
    body: wireBody,
  }
  if (mode === 'zero') envelope.system_prompt_mode = 'zero'
  const convId = wireBody.conversation_id || wireBody.conversationId
  if (typeof convId === 'string' && CONV_ID_RE.test(convId)) {
    envelope.conversation_id = convId
  }
  if (gatewayPolicy && typeof gatewayPolicy === 'object' && Object.keys(gatewayPolicy).length > 0) {
    envelope.gateway_policy = gatewayPolicy
  }
  if (restartResume === true) {
    envelope.restart_resume = true
  }
  return envelope
}

const UPSTREAM_403_REASON_TOKENS = ['TOS_VIOLATION', 'UNSUPPORTED_REGION', 'VALIDATION_REQUIRED', 'UNSUPPORTED_CLIENT']

function payloadUpstreamReason(obj) {
  const raw = typeof obj.upstream_reason === 'string' ? obj.upstream_reason.trim() : ''
  if (raw.length > 0) return raw.toUpperCase()
  for (const key of ['message', 'error']) {
    const val = typeof obj[key] === 'string' ? obj[key].trim() : ''
    if (val.length === 0) continue
    const upper = val.toUpperCase()
    for (const token of UPSTREAM_403_REASON_TOKENS) {
      if (upper.includes(token)) return token
    }
  }
  return null
}

function mapEffective403(obj, message, makeErr) {
  const reason = payloadUpstreamReason(obj)
  if (reason === 'TOS_VIOLATION') return makeErr(403, 'gemini_account_ineligible', message)
  return makeErr(403, 'gemini_location_unsupported', message)
}

/**
 * Map a CRAGGemini kernel JSON error response identically to
 * `scripts/gemini_host_native.py::_map_worker_error`.
 */
export function mapCragWorkerError(httpStatus, payload) {
  const obj = payload && typeof payload === 'object' ? payload : {}
  const code = typeof obj.code === 'string' ? obj.code : null
  const upstream =
    Number.isInteger(obj.upstream_status) && obj.upstream_status >= 400 && obj.upstream_status <= 599
      ? obj.upstream_status
      : null
  const message = typeof obj.error === 'string' && obj.error ? obj.error : undefined
  const makeErr = (status, errCode, errMsg) => {
    const err = new Error(errMsg || errCode)
    err.status = status
    err.code = errCode
    err.upstreamStatus = upstream ?? (Number.isInteger(httpStatus) ? httpStatus : status)
    if (code) err.workerCode = code
    if (code === 'bridge_disconnected' && upstream == null) err.bridgeDisconnected = true
    return err
  }
  if (code && LICENSE_ERROR_CODES.has(code)) {
    return makeErr(403, code, message || GEMINI_LICENSE_MESSAGES[code] || code)
  }
  if (code === 'gemini_subscription_sync_pending') {
    return makeErr(503, code, message || GEMINI_LICENSE_MESSAGES[code] || code)
  }
  const effectiveStatus = upstream ?? httpStatus
  if (code === 'unsupported_turn') return makeErr(400, 'gemini_unsupported_turn', message)
  if (code === 'invalid_envelope' || code === 'invalid_json') return makeErr(400, 'gemini_invalid_request', message)
  if (
    code === 'queue_full' ||
    code === 'native_unavailable' ||
    code === 'kernel_stopping' ||
    code === 'slot_shm_required' ||
    code === 'account_circuit_open'
  ) {
    return makeErr(503, code === 'queue_full' ? 'gemini_operation_busy' : 'gemini_native_worker_unavailable', message)
  }
  if (code === 'first_byte_timeout' || code === 'turn_timeout' || code === 'idle_timeout' || code === 'queue_timeout') {
    return makeErr(504, 'gemini_inference_timeout', message)
  }
  if (code === 'cancelled') return makeErr(499, 'gemini_inference_cancelled', message)
  if (effectiveStatus === 429) {
    const contentRejected = obj.content_rejected === true || code === 'gemini_content_rejected'
    const err = makeErr(429, contentRejected ? 'gemini_content_rejected' : 'gemini_quota_exhausted', message)
    if (Number.isInteger(obj.retry_after_ms) && obj.retry_after_ms >= 1 && obj.retry_after_ms <= 3_600_000) {
      err.retryAfterMs = obj.retry_after_ms
      err.retryAfter = Math.ceil(obj.retry_after_ms / 1000)
    }
    if (typeof obj.upstream_reason === 'string' && obj.upstream_reason) {
      err.upstreamReason = obj.upstream_reason
    }
    if (contentRejected) err.contentRejected = true
    return err
  }
  if (code === 'tool_continuation_aborted' || code === 'gemini_session_conflict') {
    return makeErr(409, 'gemini_session_conflict', message)
  }
  if (effectiveStatus === 401) return makeErr(401, 'gemini_oauth_required', message)
  if (effectiveStatus === 403) return mapEffective403(obj, message, makeErr)
  if (effectiveStatus === 404) return makeErr(404, 'gemini_model_unavailable', message)
  if (code === 'upstream_unavailable' || effectiveStatus === 503) {
    const err = makeErr(
      503,
      'gemini_upstream_unavailable',
      message || 'Gemini upstream service temporarily unavailable',
    )
    if (Number.isInteger(obj.retry_after_ms) && obj.retry_after_ms >= 1 && obj.retry_after_ms <= 3_600_000) {
      err.retryAfterMs = obj.retry_after_ms
      err.retryAfter = Math.ceil(obj.retry_after_ms / 1000)
    }
    return err
  }
  return makeErr(
    effectiveStatus >= 400 && effectiveStatus <= 599 ? effectiveStatus : 502,
    'gemini_inference_failed',
    message,
  )
}

function validTarget(raw) {
  if (!raw || raw.direct !== true) return null
  if (typeof raw.socket_path !== 'string' || !path.isAbsolute(raw.socket_path)) return null
  if (typeof raw.token !== 'string' || !TOKEN_RE.test(raw.token)) return null
  if (typeof raw.message_path !== 'string' || !raw.message_path.startsWith('/internal/')) return null
  const cancelPath =
    typeof raw.cancel_path === 'string' && raw.cancel_path.startsWith('/internal/')
      ? raw.cancel_path
      : raw.account_id
        ? `/internal/v1/accounts/${raw.account_id}/cancel`
        : '/internal/v1/cancel'
  const ttlMs =
    Number.isInteger(raw.ttl_ms) && raw.ttl_ms >= 1000 && raw.ttl_ms <= 120_000 ? raw.ttl_ms : DEFAULT_TARGET_TTL_MS
  return {
    socketPath: raw.socket_path,
    token: raw.token,
    messagePath: raw.message_path,
    cancelPath,
    accountId: typeof raw.account_id === 'string' ? raw.account_id : null,
    epoch: typeof raw.epoch === 'string' ? raw.epoch : '',
    ttlMs,
  }
}

function readJsonErrorBody(res) {
  return new Promise((resolve) => {
    const chunks = []
    let total = 0
    res.on('data', (chunk) => {
      if (total < MAX_ERROR_BODY_BYTES) {
        const take = chunk.subarray(0, MAX_ERROR_BODY_BYTES - total)
        chunks.push(take)
        total += take.length
      }
    })
    res.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve({})
      }
    })
    res.on('error', () => resolve({}))
  })
}

/**
 * 1-hop direct Unix socket client (`Node -> CRAGGemini kernel.sock`) with
 * short-TTL target caching and transparent fail-closed fallback to Python `/infer`.
 */
export function createDirectCragClient({ callHost, now = () => Date.now() }) {
  const targets = new Map()
  const cancelAgent = new http.Agent({ keepAlive: true, maxSockets: 32, keepAliveMsecs: 15_000 })
  let unsupportedUntil = 0

  const invalidate = (envId = null) => {
    if (envId == null) {
      targets.clear()
    } else {
      targets.delete(envId)
    }
  }

  const resolveTarget = async ({ id, proxyId, proxyUrl, proxySha256, egressOptions = null, model }) => {
    const ts = now()
    if (ts < unsupportedUntil) return null
    const egressKey = egressOptions && typeof egressOptions === 'object' ? JSON.stringify(egressOptions) : ''
    const cached = targets.get(id)
    if (
      cached &&
      cached.expiresAt > ts &&
      cached.proxyId === proxyId &&
      cached.proxySha256 === (proxySha256 || '') &&
      (cached.egressKey || '') === egressKey
    ) {
      return cached.target
    }
    let response
    try {
      response = await callHost('infer-target', {
        id,
        proxy_id: proxyId,
        proxy_url: proxyUrl,
        ...(proxySha256 ? { proxy_sha256: proxySha256 } : {}),
        ...(egressOptions ? { egress_options: egressOptions } : {}),
        model,
      })
    } catch (err) {
      // Older Python hosts without /infer-target return 404 -> disable briefly & fall back cleanly.
      if (err?.status === 404 || err?.code === 'gemini_environment_not_found' || err?.code === 'not_found') {
        unsupportedUntil = now() + UNSUPPORTED_RETRY_MS
      }
      return null
    }
    const target = validTarget(response)
    if (!target) {
      targets.delete(id)
      return null
    }
    if (targets.size >= MAX_CACHED_TARGETS) targets.clear()
    targets.set(id, {
      target,
      proxyId,
      proxySha256: proxySha256 || '',
      egressKey,
      expiresAt: now() + target.ttlMs,
    })
    return target
  }

  const openDirectStream = (
    target,
    { model, requestId, bodyObj, gatewayPolicy = null, restartResume = false, signal, timeoutMs = 300_000 },
  ) => {
    const envelope = buildDirectEnvelope({ model, requestId, bodyObj, gatewayPolicy, restartResume })
    if (!envelope) {
      const err = new Error('The selected Gemini environment does not support the requested turn.')
      err.status = 400
      err.code = 'gemini_unsupported_turn'
      return Promise.resolve({ ok: false, fallback: false, error: err })
    }
    const bodyBuf = Buffer.from(JSON.stringify(envelope), 'utf8')
    if (bodyBuf.length > MAX_ENVELOPE_BYTES) {
      const err = new Error('Direct CRAGGemini request body exceeds size limit.')
      err.status = 413
      err.code = 'gemini_inference_output_limit'
      return Promise.resolve({ ok: false, fallback: false, error: err })
    }
    return new Promise((resolve) => {
      let settled = false
      const finish = (outcome) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (signal && onAbort) signal.removeEventListener('abort', onAbort)
        resolve(outcome)
      }
      const req = http.request(
        {
          socketPath: target.socketPath,
          method: 'POST',
          path: target.messagePath,
          agent: false,
          headers: {
            Host: 'localhost',
            'X-Kin-Internal-Token': target.token,
            'Content-Type': 'application/json',
            'Content-Length': bodyBuf.length,
            Connection: 'close',
          },
        },
        async (res) => {
          const contentType = String(res.headers['content-type'] || '')
            .split(';')[0]
            .trim()
            .toLowerCase()
          if (res.statusCode === 200 && contentType === 'text/event-stream') {
            finish({ ok: true, res })
            return
          }
          // Rotated token or account/route disappeared on shard -> fall back to Python /infer.
          if (res.statusCode === 401 || res.statusCode === 404) {
            res.resume()
            finish({ ok: false, fallback: true })
            return
          }
          const payload = await readJsonErrorBody(res)
          const mapped = mapCragWorkerError(res.statusCode || 502, payload)
          finish({ ok: false, fallback: false, error: mapped })
        },
      )
      const onAbort = () => {
        req.destroy()
        const err = new Error('The Gemini turn was cancelled.')
        err.status = 499
        err.code = 'gemini_inference_cancelled'
        finish({ ok: false, fallback: false, error: err })
      }
      if (signal) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      const timer = setTimeout(() => {
        req.destroy()
        const err = new Error('The Gemini turn timed out.')
        err.status = 504
        err.code = 'gemini_inference_timeout'
        finish({ ok: false, fallback: false, error: err })
      }, timeoutMs)
      req.once('error', (err) => {
        if (signal?.aborted) {
          onAbort()
          return
        }
        if (TRANSPORT_FALLBACK_CODES.has(err?.code)) {
          finish({ ok: false, fallback: true })
          return
        }
        finish({ ok: false, fallback: true })
      })
      req.end(bodyBuf)
    })
  }

  const cancelDirectTurn = (target, requestId) => {
    if (!target || typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) {
      return Promise.resolve(false)
    }
    const payload = Buffer.from(JSON.stringify({ request_id: requestId }), 'utf8')
    return new Promise((resolve) => {
      const req = http.request(
        {
          socketPath: target.socketPath,
          method: 'POST',
          path: target.cancelPath,
          agent: cancelAgent,
          timeout: 2000,
          headers: {
            Host: 'localhost',
            'X-Kin-Internal-Token': target.token,
            'Content-Type': 'application/json',
            'Content-Length': payload.length,
          },
        },
        (res) => {
          res.resume()
          resolve(res.statusCode === 200)
        },
      )
      req.once('timeout', () => {
        req.destroy()
        resolve(false)
      })
      req.once('error', () => resolve(false))
      req.end(payload)
    })
  }

  const close = () => {
    targets.clear()
    cancelAgent.destroy()
  }

  return {
    resolveTarget,
    openDirectStream,
    cancelDirectTurn,
    invalidate,
    close,
  }
}
