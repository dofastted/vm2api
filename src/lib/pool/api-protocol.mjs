import { OFFICIAL_CLAUDE_CLI_UA } from '../identity/vm-identity.mjs'
import { stripIllegalCacheControlFields } from '../protocol/cache-ttl.mjs'
import { officialMessagesBody } from '../protocol/anthropic-messages.mjs'
import { restoreToolNames, restoreToolNamesInSSELine } from '../protocol/anthropic-policy.mjs'
import { prepareClassifierBody } from '../protocol/request-purpose.mjs'
import { consumeClaudeSSEData } from '../protocol/convert.mjs'
import { isCompleteAssistantMessage, mapUpstreamError } from '../core/errors.mjs'
import { isContentPolicyErrorCode } from '../core/refusal-guard.mjs'
import { forwardApi, readApiJson } from '../transport/api-kernel-client.mjs'
import { compileWithProtoFront, protoFrontMode } from '../transport/proto-front-client.mjs'
import {
  geminiGenerateUrl,
  messagesUrl,
  normalizeProtocol,
  resolvePreset,
  responsesUrl,
  upstreamAuthHeaders,
} from './api-presets.mjs'
import {
  buildGeminiRequest,
  createGeminiCollector,
  createGeminiEventDecoder,
  createGeminiProtocolStreamEncoder,
  createSseFrameSplitter,
  formatGeminiProtocolStreamError,
  parseInboundToGemini,
  renderGeminiProtocolResponse,
} from '../protocol/gemini-convert.mjs'
import { claudeToOpenAIResponsesRequest } from './api-openai.mjs'
import {
  assembleCodexBodyFromSse,
  codexBodyToAnthropicMessage,
  createAnthropicSseState,
  createChatSseState,
  responsesSseToAnthropicEvents,
  isToolArgumentsError,
  responsesSseToChatChunk,
  chatToCodexResponses,
} from '../protocol/codex-convert.mjs'
import { usageFromSseLine } from '../protocol/handle-codex.mjs'
import { BETA_CONTEXT_1M } from '../protocol/claude-code-betas.mjs'
import { shouldPassContext1mByPolicy } from '../protocol/model-policy.mjs'
import { resolveGeminiDefaultEffort } from '../protocol/gemini-model-policy.mjs'
import { createStreamTiming } from '../protocol/stream-timing.mjs'
import { firstNonEmptyEffort, isEmptyEffortValue, resolveGeminiReasoningEffort } from '../protocol/log-fields.mjs'
import { mergeUsage } from '../protocol/openai-usage.mjs'
import { ensureRedaction, maskJson, restoreSseLine } from '../redaction/runtime.mjs'
import { keyTierPolicyFromRecord } from '../admin/key-scope.mjs'
import { ownerScopeFromRequest } from '../admin/resource-owner.mjs'

export function resolveInferenceBackend(req) {
  if (req?.apiKeyKind !== 'managed') return 'oauth'
  const category = String(req.apiKeyRecord?.category || '')
    .trim()
    .toLowerCase()
  if (category === 'api') return 'api'
  if (category === 'all') return 'all'
  return 'oauth'
}

export function apiScheduleScope(req, groupType, usersRepo = null) {
  const policy = keyTierPolicyFromRecord(req?.apiKeyRecord)
  const ownerScope = ownerScopeFromRequest(req, usersRepo)
  const endpointId = policy.api_endpoint_id || null
  const allowedEndpointIds =
    policy.permission_tier === 'resource'
      ? policy.allowed_endpoints
      : policy.allowed_endpoints.length > 0
        ? policy.allowed_endpoints
        : null
  return {
    endpointId,
    groupType: endpointId ? 'all' : groupType,
    ownerScope,
    allowedEndpointIds,
  }
}

export { messagesUrl, responsesUrl } from './api-presets.mjs'

const STATELESS_RESPONSES_FIELDS = new Set([
  'model',
  'input',
  'instructions',
  'max_output_tokens',
  'max_tool_calls',
  'parallel_tool_calls',
  'reasoning',
  'text',
  'tool_choice',
  'tools',
  'truncation',
  'temperature',
  'top_p',
  'stream',
  'stream_options',
  'store',
  'metadata',
  'service_tier',
  'user',
  'safety_identifier',
  'prompt_cache_key',
  'prompt_cache_retention',
  'include',
])
const STATELESS_OPENAI_TOOLS = new Set(['function', 'custom', 'web_search', 'web_search_preview', 'image_generation'])

// Endpoint credentials are shared across managed keys; never resolve caller-supplied account resources.
export function validateApiOpenAIRequest(protocol, body = {}) {
  if (!['openai.responses', 'openai.chat'].includes(protocol)) return null
  const invalid = (field) => ({
    code: 'api_shared_resource_forbidden',
    message: `Shared API endpoints require stateless input; unsupported field or resource: ${field}`,
  })
  if (protocol === 'openai.responses') {
    for (const field of Object.keys(body)) {
      if (!STATELESS_RESPONSES_FIELDS.has(field)) return invalid(field)
    }
  }
  if (body.tools != null && !Array.isArray(body.tools)) return invalid('tools')
  for (const tool of body.tools || []) {
    if (!STATELESS_OPENAI_TOOLS.has(tool?.type)) return invalid('tools.type')
  }
  const pending = [body.input]
  for (const tool of body.tools || []) {
    if (!['function', 'custom'].includes(tool.type)) pending.push(tool)
  }
  while (pending.length) {
    const value = pending.pop()
    if (!value || typeof value !== 'object') continue
    if (Array.isArray(value)) {
      for (const child of value) pending.push(child)
      continue
    }
    if (value.type === 'item_reference' || (value.id && !value.type && !value.role))
      return invalid('input.item_reference')
    for (const [field, child] of Object.entries(value)) {
      if (['file_id', 'file_ids', 'vector_store_ids', 'container', 'server_url'].includes(field)) return invalid(field)
      pending.push(child)
    }
  }
  return null
}

function joinHeaderMap(headers = {}) {
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    if (v == null || v === '') continue
    out[k] = String(v)
  }
  return out
}

/**
 * Native Anthropic Messages is a compatibility boundary.  Keep protocol
 * headers supplied by the caller, including beta names this gateway does not
 * know yet.  Headers the operator configured on the endpoint win; anthropic-beta
 * is the union of endpoint and caller tokens so neither opt-in is dropped.
 */
export function forwardAnthropicProtocolHeaders(
  headers = {},
  protocol = '',
  protocolKind = '',
  { passthrough = false, officialTraffic = false } = {},
) {
  if (protocol !== 'anthropic.messages' || protocolKind !== 'anthropic') return {}
  if (!officialTraffic && !passthrough) return {}
  const out = {}
  for (const [rawName, rawValue] of Object.entries(headers || {})) {
    const name = String(rawName || '').toLowerCase()
    if (name === 'user-agent' && !passthrough) continue
    if (
      !name.startsWith('anthropic-') &&
      !name.startsWith('x-claude-code-') &&
      !name.startsWith('x-stainless-') &&
      name !== 'x-app' &&
      name !== 'x-client-request-id' &&
      name !== 'user-agent' &&
      name !== 'accept-language' &&
      name !== 'sec-fetch-mode'
    )
      continue
    if (rawValue == null || rawValue === '') continue
    out[name] = Array.isArray(rawValue) ? rawValue.join(',') : String(rawValue)
  }
  return out
}

function splitBetas(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Caller context-1m follows the model-page 1M policy, same as the slot path. */
function callerBetaTokens(value, model) {
  const tokens = splitBetas(value)
  if (!tokens.includes(BETA_CONTEXT_1M) || shouldPassContext1mByPolicy(model)) return tokens
  return tokens.filter((t) => t !== BETA_CONTEXT_1M)
}

function mergeCallerProtocolHeaders(base = {}, caller = {}, configured = {}, model = '') {
  const out = { ...base }
  const configuredNames = new Set(Object.keys(configured).map((k) => k.toLowerCase()))
  for (const [name, value] of Object.entries(caller)) {
    const existing = Object.keys(out).filter((k) => k.toLowerCase() === name)
    if (name === 'anthropic-beta') {
      const merged = new Set([...existing.flatMap((k) => splitBetas(out[k])), ...callerBetaTokens(value, model)])
      for (const k of existing) delete out[k]
      if (merged.size) out[name] = [...merged].join(',')
      continue
    }
    if (configuredNames.has(name)) continue
    for (const k of existing) delete out[k]
    out[name] = value
  }
  return out
}

async function readLines(stream, onLine) {
  let buf = ''
  let receivedAt = null
  for await (const chunk of stream) {
    receivedAt = Date.now()
    buf += chunk.toString('utf8')
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      await onLine(line, receivedAt)
    }
  }
  if (buf) await onLine(buf, receivedAt)
}

function openAIResponsesSseEvent(line) {
  const raw = String(line || '').trim()
  if (!raw.startsWith('data:')) return null
  const payload = raw.slice(5).trim()
  if (!payload || payload === '[DONE]') return null
  try {
    return JSON.parse(payload)
  } catch {
    return null
  }
}

function openAIResponsesItemHasOutput(item) {
  if (!item || typeof item !== 'object') return false
  if (item.arguments || item.input || item.result || item.encrypted_content) return true
  for (const value of [item.content, item.summary]) {
    if (!Array.isArray(value)) continue
    if (
      value.some(
        (part) =>
          part &&
          typeof part === 'object' &&
          (part.text || part.transcript || part.arguments || part.input || part.result || part.encrypted_content),
      )
    )
      return true
  }
  return false
}

/** Lifecycle events are transport metadata, not downstream model output. */
export function isOpenAIResponsesCommitEvent(event) {
  if (!event || typeof event !== 'object') return false
  const type = String(event.type || '').trim()
  if (
    !type ||
    type === 'error' ||
    type === 'response.failed' ||
    type === 'response.created' ||
    type === 'response.queued' ||
    type === 'response.in_progress' ||
    type === 'response.metadata' ||
    type === 'keepalive'
  )
    return false
  if (type === 'response.output_item.added' || type === 'response.output_item.done')
    return openAIResponsesItemHasOutput(event.item)
  if (
    type === 'response.content_part.added' ||
    type === 'response.content_part.done' ||
    type === 'response.reasoning_summary_part.added' ||
    type === 'response.reasoning_summary_part.done'
  )
    return !!(event.part?.text || event.part?.transcript)
  if (type === 'response.function_call_arguments.done') return !!event.arguments
  if (type === 'response.custom_tool_call_input.done') return !!event.input
  if (type === 'response.image_generation_call.partial_image') return !!event.partial_image_b64
  return type.startsWith('response.output_') || (type.startsWith('response.') && /\.(delta|done)$/.test(type))
}

function openAIResponsesFailure(event) {
  if (!event || typeof event !== 'object') return null
  if (event.type === 'error') return event
  if (event.type !== 'response.failed') return null
  return {
    type: 'error',
    error: event.response?.error || event.error || { type: 'server_error', message: 'Response failed' },
  }
}

function mappedOpenAIResponsesFailure(resultBase, event, committed, extras = {}) {
  const declared = Number(event?.error?.status || event?.status)
  const mapped = mapUpstreamError(declared >= 400 && declared < 600 ? declared : 500, event)
  return {
    ...resultBase,
    ...mapped,
    upstreamError: event.error,
    ok: false,
    terminalState: committed ? 'incomplete' : 'rejected',
    committed,
    ...extras,
  }
}

export async function runApiInference({
  req,
  res,
  cfg,
  scheduler,
  picked: selected = null,
  store,
  protocol,
  inbound,
  convertedBody,
  clientStream,
  deliveryMode,
  signal,
  timeoutMs,
  personaHideTokens,
  cacheTtl,
  converters,
  onPublicLine = null,
  requestContext = null,
  passthrough = false,
  officialTraffic = false,
  toolNames = {},
  routing = null,
  redactionPrincipal = '',
  redactionSession = '',
} = {}) {
  const requestedModel = convertedBody?.model || inbound?.model || ''
  const picked = selected || scheduler.pick(requestedModel)
  if (!picked.ok) {
    return {
      ok: false,
      status: picked.code === 'model_not_found' ? 404 : 503,
      via: 'api-kernel',
      body: { type: 'error', error: { type: 'api_error', code: picked.code, message: picked.message } },
      terminalState: 'exhausted',
    }
  }

  const preset = resolvePreset(picked.endpoint.kind, picked.endpoint)
  const protocolKind = normalizeProtocol(picked.endpoint.protocol || preset.protocol, preset.kind)
  const extraHeaders = joinHeaderMap(picked.endpoint.headers)
  const isOpenAI = protocolKind === 'openai'
  const isGemini = protocolKind === 'gemini'
  if (isGemini) {
    if (requestContext) {
      return {
        ok: false,
        status: 400,
        terminalState: 'rejected',
        body: {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            code: 'classifier_model_incompatible',
            message: 'Classifier requests require the selected Anthropic model without endpoint model substitution.',
          },
        },
      }
    }
    return await runGeminiApiInference({
      req,
      res,
      cfg,
      scheduler,
      picked,
      store,
      preset,
      extraHeaders,
      protocol,
      inbound,
      clientStream,
      deliveryMode,
      signal,
      timeoutMs,
      converters,
      routing,
      redactionPrincipal,
      redactionSession,
    })
  }
  const canonical = officialMessagesBody(convertedBody)
  if (requestContext && (isOpenAI || picked.upstream_model !== canonical.model)) {
    return {
      ok: false,
      status: 400,
      terminalState: 'rejected',
      body: {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          code: 'classifier_model_incompatible',
          message: 'Classifier requests require the selected Anthropic model without endpoint model substitution.',
        },
      },
    }
  }
  let openAIBaseBody = null
  if (isOpenAI) {
    if (protoFrontMode() === 'go') {
      try {
        const pfRes = await compileWithProtoFront({
          cfg,
          inboundProtocol: protocol,
          targetFamily: 'api_openai',
          reqPath: req?.url || '',
          headers: req?.headers || {},
          body: inbound,
          routing: routing || {},
          endpointBodyPolicy: picked.endpoint.body_policy || '',
        })
        if (pfRes?.ok && pfRes.outbound_body) openAIBaseBody = pfRes.outbound_body
      } catch {}
    }
    if (!openAIBaseBody) {
      openAIBaseBody =
        protocol === 'openai.responses'
          ? inbound
          : protocol === 'openai.chat'
            ? chatToCodexResponses(inbound)
            : claudeToOpenAIResponsesRequest(canonical)
    }
  }
  let body = isOpenAI
    ? {
        ...openAIBaseBody,
        model: picked.upstream_model,
        stream: true,
        store: false,
      }
    : { ...stripIllegalCacheControlFields(canonical), model: picked.upstream_model, stream: true }
  if (isOpenAI) {
    if (protocol === 'openai.chat') {
      for (const name of ['temperature', 'top_p', 'parallel_tool_calls']) {
        if (inbound?.[name] != null) body[name] = inbound[name]
      }
    }
    const effort = firstNonEmptyEffort(body.reasoning?.effort, body.reasoning_effort)
    delete body.reasoning_effort
    if (effort !== undefined) {
      body.reasoning = { ...(body.reasoning && typeof body.reasoning === 'object' ? body.reasoning : {}), effort }
    } else if (
      body.reasoning &&
      typeof body.reasoning === 'object' &&
      Object.prototype.hasOwnProperty.call(body.reasoning, 'effort') &&
      isEmptyEffortValue(body.reasoning.effort)
    ) {
      const nextReasoning = { ...body.reasoning }
      delete nextReasoning.effort
      if (Object.keys(nextReasoning).length) body.reasoning = nextReasoning
      else delete body.reasoning
    }
  }
  if (requestContext) Object.assign(body, prepareClassifierBody(body))
  const redactionState = await ensureRedaction(routing || {}, { projectRoot: cfg?.paths?.project })
  const redaction = redactionState.enabled
    ? { principal: redactionPrincipal, session: redactionSession, maxBodyBytes: redactionState.maxBodyBytes }
    : null
  if (redaction) body = await maskJson(body, redaction)
  const callerProtocolHeaders = forwardAnthropicProtocolHeaders(req?.headers, protocol, protocolKind, {
    passthrough,
    officialTraffic,
  })
  const authHeaders = upstreamAuthHeaders(protocolKind, picked.key.api_key, {
    ...extraHeaders,
    auth_scheme: picked.endpoint.auth_scheme || extraHeaders.auth_scheme || extraHeaders.anthropic_apikey_auth_scheme,
  })
  if (
    protocolKind === 'anthropic' &&
    !passthrough &&
    !Object.keys(authHeaders).some((key) => key.toLowerCase() === 'user-agent')
  ) {
    authHeaders['user-agent'] = OFFICIAL_CLAUDE_CLI_UA
  }
  const headers = mergeCallerProtocolHeaders(
    {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...authHeaders,
    },
    callerProtocolHeaders,
    extraHeaders,
    canonical.model,
  )

  const timing = createStreamTiming()
  let upstream
  try {
    upstream = await forwardApi({
      cfg,
      url: isOpenAI ? responsesUrl(preset.base_url) : messagesUrl(preset.base_url),
      headers,
      body,
      proxyUrl: picked.key.proxy_url,
      signal,
      timeoutMs,
    })
  } catch (error) {
    return {
      ok: false,
      status: 502,
      via: 'api-kernel',
      body: {
        type: 'error',
        error: {
          type: 'api_error',
          code: error.code || 'api_kernel_transport',
          message: String(error.message || error).slice(0, 300),
        },
      },
      terminalState: 'transport_error',
      transportError: true,
    }
  }

  const status = Number(upstream.statusCode) || 502
  if (status === 429 && !picked.endpoint.disable_cooling) {
    const retry = Number(upstream.headers['retry-after'] || 30)
    const until = new Date(Date.now() + Math.max(1, retry) * 1000).toISOString()
    try {
      store.setKeyCooldown(picked.key.id, until)
    } catch {}
    scheduler.reload(store.listRaw())
  }

  const resultBase = {
    ok: status >= 200 && status < 300,
    status,
    upstreamStatus: status,
    via: 'api-kernel',
    vmId: null,
    accountId: picked.key.id,
    endpointId: picked.endpoint.id,
    model: picked.upstream_model,
    headers: { ...upstream.headers },
  }

  if (status >= 400) {
    const payload = await readApiJson(upstream).catch(() => ({}))
    const message = payload?.error?.message || payload?.message || `upstream ${status}`
    const upstreamCode = String(payload?.error?.code || payload?.code || '').trim()
    const contentCode = isContentPolicyErrorCode(upstreamCode) ? upstreamCode.toLowerCase() : ''
    return {
      ...resultBase,
      ok: false,
      body: {
        type: 'error',
        error: {
          ...(requestContext ? payload?.error : {}),
          ...(requestContext && payload?.error?.code ? { upstream_code: payload.error.code } : {}),
          ...(!requestContext && contentCode ? { code: contentCode } : {}),
          type: requestContext ? payload?.error?.type || 'api_error' : 'api_error',
          message: String(message).slice(0, 300),
        },
      },
      upstreamError: { code: upstreamCode || null, type: payload?.error?.type || null, message: String(message) },
      terminalState: 'rejected',
    }
  }

  if (isOpenAI) {
    return await runOpenAIResponsesUpstream({
      upstream,
      resultBase,
      protocol,
      inbound,
      clientStream,
      deliveryMode,
      res,
      converters,
      body,
      timing,
    })
  }

  const classifierSseState = { dataBuf: '' }
  let classifierError = null
  let classifierStopped = false
  let streamError = null
  let streamStopReason = null
  let streamedUsage = null
  const readUpstreamLines = async (onLine) => {
    try {
      await readLines(upstream, async (line, receivedAt) => {
        const event = consumeClaudeSSEData(line, classifierSseState)
        timing.observe(event, receivedAt)
        streamedUsage = mergeUsage(streamedUsage, event?.message?.usage || event?.usage)
        if (event?.type === 'error') streamError = event
        if (event?.type === 'message_delta') streamStopReason = event.delta?.stop_reason || streamStopReason
        if (requestContext) {
          // The same decoded event drives classifier validation and performance timing.
          if (event?.type === 'error')
            classifierError = {
              ...event,
              error: { ...event.error, ...(event.error?.code ? { upstream_code: event.error.code } : {}) },
            }
          if (event?.type === 'message_stop') classifierStopped = true
        }
        await onLine(line)
      })
    } catch (error) {
      if (!requestContext) throw error
      classifierError = {
        type: 'error',
        error: {
          type: 'api_error',
          code: 'upstream_stream_interrupted',
          status: 502,
          message: String(error.message || 'Classifier stream interrupted').slice(0, 300),
        },
      }
    }
  }
  const classifierFailure = () => {
    if (!requestContext || (!classifierError && classifierStopped)) return null
    const body = classifierError || {
      type: 'error',
      error: {
        type: 'api_error',
        code: 'upstream_stream_interrupted',
        status: 502,
        message: 'Classifier stream ended before message_stop',
      },
    }
    const declared = Number(body.error?.status)
    const status = declared >= 400 && declared < 600 ? declared : mapUpstreamError(200, body).status
    return {
      ...resultBase,
      ok: false,
      status,
      body,
      headers: {
        ...resultBase.headers,
        ...(body.error?.retry_after ? { 'retry-after': String(body.error.retry_after) } : {}),
      },
      terminalState: 'rejected',
    }
  }

  const hasToolNames = Boolean(toolNames && Object.keys(toolNames).length > 0)

  if (!clientStream) {
    const assembler = converters.createClaudeMessageAssembler()
    let committed = false
    let sawMessageStop = false
    let terminalError = null
    await readUpstreamLines(async (line) => {
      if (redaction) line = await restoreSseLine(line, redaction)
      if (hasToolNames) line = restoreToolNamesInSSELine(line, toolNames)
      applyMaybeUsageHide(line, personaHideTokens, cacheTtl, converters)
      converters.applyClaudeSSELineToMessage(line, assembler)
      const raw = String(line || '')
      if (raw.startsWith('data:')) {
        if (!committed) committed = true
        const piece = raw.slice(5).trim()
        if (piece && piece !== '[DONE]') {
          try {
            const evt = JSON.parse(piece)
            if (evt?.type === 'message_stop') sawMessageStop = true
            if (evt?.type === 'error') terminalError = evt
          } catch {}
        }
      }
    })
    const failure = classifierFailure()
    if (failure) return { ...failure, ...timing.snapshot(), committed: false }
    if (terminalError) {
      const declared = Number(terminalError.error?.status)
      const status = declared >= 400 && declared < 600 ? declared : mapUpstreamError(200, terminalError).status
      return {
        ...resultBase,
        ...timing.snapshot(),
        ok: false,
        status,
        body: terminalError,
        usage: assembler.message?.usage || null,
        terminalState: 'rejected',
        committed,
        sawMessageStop,
      }
    }
    const assembled =
      assembler.message && hasToolNames ? restoreToolNames(assembler.message, toolNames) : assembler.message
    if (!sawMessageStop) {
      return {
        ...resultBase,
        ...timing.snapshot(),
        ok: false,
        body: assembled || { type: 'error', error: { message: 'empty api upstream' } },
        usage: assembled?.usage || null,
        terminalState: assembled || committed ? 'incomplete' : 'rejected',
        committed,
        sawMessageStop: false,
      }
    }
    const hop = { body: assembled, stopReason: assembled?.stop_reason, sawMessageStop: true }
    const complete = resultBase.ok && isCompleteAssistantMessage(hop)
    return {
      ...resultBase,
      ...timing.snapshot(),
      ok: complete,
      body: assembled || { type: 'error', error: { message: 'empty api upstream' } },
      usage: assembled?.usage || null,
      terminalState: complete ? 'verified' : 'incomplete',
      committed,
      sawMessageStop: true,
    }
  }

  let state
  if (protocol === 'openai.chat')
    state = converters.createOpenAIChatStreamState(inbound.model || body.model, picked.endpoint.id)
  else if (protocol === 'openai.completions')
    state = converters.createOpenAICompletionStreamState(inbound.model || body.model, picked.endpoint.id)
  else if (protocol === 'openai.responses')
    state = converters.createResponsesStreamState(inbound.model || body.model, picked.endpoint.id)

  let committed = false
  let sawStop = false
  await readUpstreamLines(async (line) => {
    if (redaction) line = await restoreSseLine(line, redaction)
    if (hasToolNames) line = restoreToolNamesInSSELine(line, toolNames)
    if (personaHideTokens) line = converters.hidePersonaUsageInSseLine(line, personaHideTokens, cacheTtl) || line
    if (String(line).includes('message_stop')) sawStop = true
    if (!committed && String(line).startsWith('data:')) {
      committed = true
      if (protocol === 'anthropic.messages' && !res.headersSent) converters.writeSSEHeaders(res)
    }
    if (protocol === 'anthropic.messages') {
      if (!res.headersSent) converters.writeSSEHeaders(res)
      res.write(String(line).endsWith('\n') ? String(line) : `${line}\n`)
      onPublicLine?.(line)
      return
    }
    const writeChunks = (chunks) => {
      if (!chunks.length) return
      if (!res.headersSent) converters.writeSSEHeaders(res)
      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    }
    if (protocol === 'openai.chat') writeChunks(converters.claudeSSELineToOpenAIChatChunks(line, state))
    else if (protocol === 'openai.completions')
      writeChunks(converters.claudeSSELineToOpenAICompletionChunks(line, state))
    else writeChunks(converters.claudeSSELineToResponsesEvents(line, state))
  })

  const failure = classifierFailure()
  if (failure) return { ...failure, ...timing.snapshot(), committed }

  if (streamError) {
    return {
      ...resultBase,
      ...timing.snapshot(),
      body: streamError,
      status: mapUpstreamError(200, streamError).status,
      ok: false,
      committed,
      usage: streamedUsage,
      terminalState: 'rejected',
    }
  }

  return {
    ...resultBase,
    ...timing.snapshot(),
    usage: streamedUsage,
    stopReason: streamStopReason,
    ok: resultBase.ok && (deliveryMode !== 'verified' || sawStop),
    terminalState: sawStop ? 'verified' : committed ? 'incomplete' : 'rejected',
    committed,
  }
}

async function runOpenAIResponsesUpstream({
  upstream,
  resultBase,
  protocol,
  inbound,
  clientStream,
  deliveryMode,
  res,
  converters,
  body,
  timing,
}) {
  const chunks = []
  const anthropicSse = protocol === 'anthropic.messages' ? createAnthropicSseState() : null
  const chatSse = createChatSseState()
  let conversionError = null
  let committed = false
  let completed = false
  let sawTerminal = false
  let streamedUsage = null
  let terminalFailure = null
  const pendingLines = []

  const writeStreamLine = (raw) => {
    if (!res.headersSent) converters.writeSSEHeaders(res)
    if (protocol === 'openai.responses') {
      res.write(raw.endsWith('\n') ? raw : raw + '\n')
      if (/response\.(completed|done)/.test(raw)) completed = true
      return
    }
    try {
      const mapped =
        protocol === 'anthropic.messages'
          ? responsesSseToAnthropicEvents(raw, anthropicSse)
          : responsesSseToChatChunk(raw, 'codex', chatSse)
      if (mapped) {
        res.write(mapped)
        if (mapped.includes('[DONE]') || mapped.includes('event: message_stop\n')) completed = true
      }
    } catch (error) {
      if (error.code !== 'tool_arguments_mismatch') throw error
      conversionError = { type: 'upstream_protocol_error', code: error.code, message: error.message }
      const payload = JSON.stringify({ error: conversionError })
      res.write(
        protocol === 'anthropic.messages'
          ? 'event: error\ndata: ' + JSON.stringify({ type: 'error', error: conversionError }) + '\n\n'
          : 'data: ' + payload + '\n\ndata: [DONE]\n\n',
      )
    }
  }

  await readLines(upstream, async (line, receivedAt) => {
    if (conversionError) return
    const raw = String(line || '')
    const event = openAIResponsesSseEvent(raw)
    timing.observe(event, receivedAt)
    const failure = openAIResponsesFailure(event)
    if (failure) terminalFailure = failure
    const seen = usageFromSseLine(raw)
    if (seen) streamedUsage = mergeUsage(streamedUsage, seen)
    const startsOutput = isOpenAIResponsesCommitEvent(event)
    const completes = event?.type === 'response.completed' || event?.type === 'response.done'
    const wasCommitted = committed
    if (!committed && (startsOutput || completes)) committed = true
    if (!clientStream) {
      chunks.push(raw)
      if (/response\.(completed|done)/.test(raw) || raw.trim() === 'data: [DONE]') sawTerminal = true
      return
    }
    if (!wasCommitted) {
      pendingLines.push(raw)
      if (!committed) return
      for (const pending of pendingLines.splice(0)) writeStreamLine(pending)
      return
    }
    writeStreamLine(raw)
  })

  if (!clientStream) {
    if (terminalFailure)
      return mappedOpenAIResponsesFailure(resultBase, terminalFailure, committed, {
        usage: streamedUsage,
        ...timing.snapshot(),
      })
    let assembled
    let outBody
    try {
      assembled = assembleCodexBodyFromSse(chunks, {})
      outBody =
        protocol !== 'openai.responses'
          ? codexBodyToAnthropicMessage(assembled, inbound?.model || body?.model)
          : assembled
    } catch (error) {
      if (!isToolArgumentsError(error)) throw error
      return {
        ...resultBase,
        ...timing.snapshot(),
        ok: false,
        status: 502,
        body: { error: { type: 'upstream_protocol_error', code: error.code, message: error.message } },
        terminalState: 'incomplete',
        committed,
        usage: streamedUsage,
      }
    }
    const hasBody = !!(assembled && (assembled.output || assembled.id || outBody))
    const complete = resultBase.ok && sawTerminal && hasBody
    return {
      ...resultBase,
      ...timing.snapshot(),
      ok: complete,
      body: outBody,
      usage: mergeUsage(streamedUsage, assembled?.usage || outBody?.usage),
      terminalState: complete ? 'verified' : hasBody ? 'incomplete' : 'rejected',
      committed,
    }
  }
  if (terminalFailure)
    return mappedOpenAIResponsesFailure(resultBase, terminalFailure, committed, {
      usage: streamedUsage,
      ...timing.snapshot(),
    })
  if (conversionError)
    return {
      ...resultBase,
      ok: false,
      status: 502,
      body: { error: conversionError },
      terminalState: 'incomplete',
      committed,
      usage: streamedUsage,
      ...timing.snapshot(),
    }

  return {
    ...resultBase,
    ok: resultBase.ok && (deliveryMode !== 'verified' || completed || committed),
    usage: streamedUsage,
    terminalState: completed ? 'verified' : committed ? 'incomplete' : 'rejected',
    committed,
    ...timing.snapshot(),
  }
}

function geminiProtocolOf(protocol) {
  switch (protocol) {
    case 'google.gemini':
      return 'gemini'
    case 'anthropic.messages':
      return 'anthropic'
    case 'openai.chat':
      return 'openai-chat'
    case 'openai.responses':
      return 'openai-responses'
    default:
      return null
  }
}

async function runGeminiApiInference({
  req,
  res,
  cfg,
  scheduler,
  picked,
  store,
  preset,
  extraHeaders,
  protocol,
  inbound,
  clientStream,
  deliveryMode,
  signal,
  timeoutMs,
  converters,
  routing,
  redactionPrincipal,
  redactionSession,
}) {
  const geminiProto = geminiProtocolOf(protocol)
  if (!geminiProto) {
    return {
      ok: false,
      status: 400,
      via: 'api-kernel',
      body: {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          code: 'gemini_unsupported_protocol',
          message: `Unsupported inbound protocol for Gemini API endpoint: ${String(protocol)}`,
        },
      },
      terminalState: 'rejected',
    }
  }

  let parsed
  try {
    parsed = parseInboundToGemini(geminiProto, inbound, {
      routeModel: picked.requested_model || inbound?.model || picked.upstream_model,
      routeStream: clientStream,
      headers: req?.headers || {},
    })
  } catch (error) {
    return {
      ok: false,
      status: Number.isInteger(error?.status) ? error.status : 400,
      via: 'api-kernel',
      body: {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          code: error?.code || 'gemini_invalid_request',
          message: String(error?.message || 'Invalid Gemini request.'),
        },
      },
      terminalState: 'rejected',
    }
  }

  const inboundModel = picked.requested_model || inbound?.model || picked.upstream_model
  const defaultGeminiEffort =
    resolveGeminiDefaultEffort(picked.upstream_model) ?? resolveGeminiDefaultEffort(inboundModel)
  let body = buildGeminiRequest(
    { ...parsed, model: picked.upstream_model },
    { target: 'gemini', defaultEffort: defaultGeminiEffort },
  )
  const redactionState = await ensureRedaction(routing || {}, { projectRoot: cfg?.paths?.project })
  const redaction = redactionState.enabled
    ? { principal: redactionPrincipal, session: redactionSession, maxBodyBytes: redactionState.maxBodyBytes }
    : null
  if (redaction) body = await maskJson(body, redaction)

  const authHeaders = upstreamAuthHeaders('gemini', picked.key.api_key, {
    ...extraHeaders,
    auth_scheme: picked.endpoint.auth_scheme || extraHeaders.auth_scheme || extraHeaders.anthropic_apikey_auth_scheme,
  })
  const headers = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...authHeaders,
  }

  const timing = createStreamTiming()
  const dialVersion = async (version) =>
    await forwardApi({
      cfg,
      url: geminiGenerateUrl(preset.base_url, picked.upstream_model, { stream: true, version }),
      headers,
      body,
      proxyUrl: picked.key.proxy_url,
      signal,
      timeoutMs,
    })

  let upstream
  try {
    upstream = await dialVersion('v1beta')
    const ct = String(upstream.headers?.['content-type'] || '').toLowerCase()
    if (upstream.statusCode === 404 || upstream.statusCode === 405 || ct.includes('text/html')) {
      try {
        upstream.resume?.()
      } catch {}
      upstream = await dialVersion('v1')
    }
  } catch (error) {
    return {
      ok: false,
      status: 502,
      via: 'api-kernel',
      body: {
        type: 'error',
        error: {
          type: 'api_error',
          code: error.code || 'api_kernel_transport',
          message: String(error.message || error).slice(0, 300),
        },
      },
      terminalState: 'transport_error',
      transportError: true,
    }
  }

  const status = Number(upstream.statusCode) || 502
  if (status === 429 && !picked.endpoint.disable_cooling) {
    const retry = Number(upstream.headers?.['retry-after'] || 30)
    const until = new Date(Date.now() + Math.max(1, retry) * 1000).toISOString()
    try {
      store.setKeyCooldown(picked.key.id, until)
    } catch {}
    scheduler.reload(store.listRaw())
  }

  const reasoningEffort = resolveGeminiReasoningEffort({
    inbound,
    parsed,
    outboundBody: body,
    model: inboundModel,
    upstreamModel: picked.upstream_model,
    defaultEffort: defaultGeminiEffort,
  })
  const resultBase = {
    ok: status >= 200 && status < 300,
    status,
    upstreamStatus: status,
    via: 'api-kernel',
    vmId: null,
    accountId: picked.key.id,
    endpointId: picked.endpoint.id,
    model: picked.upstream_model,
    headers: { ...(upstream.headers || {}) },
    outboundBody: body,
    outboundBodySource: 'gemini_api',
    reasoningEffort,
  }

  if (status >= 400) {
    const payload = await readApiJson(upstream).catch(() => ({}))
    const isJson = payload != null && typeof payload === 'object'
    const message = isJson ? payload?.error?.message || payload?.message || `upstream ${status}` : `upstream ${status}`
    const upstreamCode = isJson ? String(payload?.error?.code || payload?.code || '').trim() : ''
    const contentCode = isContentPolicyErrorCode(upstreamCode) ? upstreamCode.toLowerCase() : ''
    return {
      ...resultBase,
      ok: false,
      body: {
        type: 'error',
        error: {
          ...(contentCode ? { code: contentCode } : {}),
          type: 'api_error',
          message: String(message).slice(0, 300),
        },
      },
      upstreamError: {
        code: upstreamCode || null,
        type: isJson ? payload?.error?.type || null : null,
        message: String(message),
      },
      terminalState: 'rejected',
    }
  }

  const decoder = createGeminiEventDecoder({ fallbackModel: inboundModel })
  const collector = createGeminiCollector({ fallbackModel: inboundModel })
  const encoder = clientStream ? createGeminiProtocolStreamEncoder(geminiProto, { model: inboundModel }) : null
  let streamError = null
  let committed = false
  let sawFirstByte = false
  const emit = (event) => {
    const at = Date.now()
    if (event.kind === 'start') {
      timing.observe({ type: 'message_start' }, at)
    } else if (
      event.kind === 'text' ||
      event.kind === 'thinking' ||
      event.kind === 'tool_call' ||
      event.kind === 'image'
    ) {
      timing.observe({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } }, at)
    } else if (event.kind === 'stop') {
      timing.observe({ type: 'message_delta', delta: { stop_reason: event.stopReason || 'end_turn' } }, at)
    }
    collector.push(event)
    if (event.kind === 'error' && !streamError) {
      streamError = event
      return
    }
    if (!clientStream || !encoder) return
    const chunk = encoder.push(event)
    if (!chunk) return
    if (!res.headersSent) converters.writeSSEHeaders(res)
    committed = true
    res.write(chunk)
  }
  const splitter = createSseFrameSplitter((frame) => {
    decoder.decodeSseFrame(frame, emit)
  })
  for await (const chunk of upstream) {
    if (!sawFirstByte) {
      sawFirstByte = true
      timing.observe({ type: 'message_start' }, Date.now())
    }
    const piece = redaction ? await restoreSseLine(chunk.toString('utf8'), redaction) : chunk
    splitter.push(piece)
  }
  splitter.flush()
  decoder.flush?.(emit)

  const collected = collector.result()
  const webSearches = Array.isArray(collected.searches) ? collected.searches.length : 0
  const usage = collected.usage
    ? {
        input_tokens: collected.usage.input_tokens || 0,
        output_tokens: collected.usage.output_tokens || 0,
        ...(collected.usage.cache_read_tokens
          ? {
              cache_read_input_tokens: collected.usage.cache_read_tokens,
              cache_read_tokens: collected.usage.cache_read_tokens,
            }
          : {}),
        ...(collected.usage.reasoning_tokens ? { reasoning_tokens: collected.usage.reasoning_tokens } : {}),
        ...(webSearches > 0 ? { web_search_requests: webSearches } : {}),
      }
    : null

  if (streamError) {
    const errStatus =
      Number(streamError.status) >= 400 && Number(streamError.status) < 600 ? Number(streamError.status) : 502
    const errCode = streamError.code || 'gemini_inference_failed'
    const errMsg = streamError.message || 'Gemini stream error'
    if (clientStream && res.headersSent) {
      try {
        res.write(formatGeminiProtocolStreamError(geminiProto, errStatus, errCode, errMsg))
      } catch {}
    }
    return {
      ...resultBase,
      ...timing.snapshot(),
      ok: false,
      status: errStatus,
      body: { type: 'error', error: { type: 'api_error', code: errCode, message: errMsg } },
      usage,
      committed,
      terminalState: committed ? 'incomplete' : 'rejected',
    }
  }

  const hasContent = Boolean(
    collected.sawFinish || collected.text || collected.toolCalls.length || collected.images.length,
  )
  if (!hasContent) {
    return {
      ...resultBase,
      ...timing.snapshot(),
      ok: false,
      status: 502,
      body: {
        type: 'error',
        error: {
          type: 'api_error',
          code: 'gemini_inference_invalid_output',
          message: 'Empty Gemini upstream response.',
        },
      },
      usage,
      committed,
      terminalState: committed ? 'incomplete' : 'rejected',
    }
  }
  if (!collected.sawFinish) {
    timing.observe({ type: 'message_stop' }, Date.now())
  }

  if (clientStream) {
    const tail = encoder.finish()
    if (tail) {
      if (!res.headersSent) converters.writeSSEHeaders(res)
      committed = true
      res.write(tail)
    }
    return {
      ...resultBase,
      ...timing.snapshot(),
      ok: resultBase.ok && (deliveryMode !== 'verified' || collected.sawFinish || committed),
      usage,
      stopReason: collected.stopReason || 'end_turn',
      committed,
      terminalState: collected.sawFinish ? 'verified' : committed ? 'incomplete' : 'rejected',
    }
  }

  return {
    ...resultBase,
    ...timing.snapshot(),
    ok: true,
    body: renderGeminiProtocolResponse(geminiProto, collected, { model: inboundModel }),
    usage,
    stopReason: collected.stopReason || 'end_turn',
    committed: true,
    terminalState: 'verified',
  }
}

function applyMaybeUsageHide() {}
