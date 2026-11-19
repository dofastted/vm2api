import crypto from 'node:crypto'
import { listVms, getVm } from '../vm/vm-registry.mjs'
import { isAntigravityVm } from '../vm/vm-kind.mjs'
import { isClientStream } from './convert.mjs'
import { ErrorCode } from '../core/errors.mjs'
import { keyScopeFromRequest, vmPoolDenial } from '../admin/key-scope.mjs'
import { ownerScopeFromRequest, pinnedVmIdFromRequest } from '../admin/resource-owner.mjs'
import { normalizeAntigravityRouting, antigravityModelId, resolveAntigravityVariant } from './antigravity-route.mjs'
import {
  normalizeAntigravityRequest,
  renderAntigravityResponse,
  createAntigravityProtocolStream,
} from './antigravity-convert.mjs'
import { runAntigravityInference } from '../transport/antigravity-bridge-supervisor.mjs'
import {
  antigravityPoolRuntime,
  pickAntigravityCandidates,
  isAntigravityFailoverError,
} from '../pool/antigravity-slot-pool.mjs'
import { antigravityResponseStore, antigravityResponseScope } from './antigravity-response-store.mjs'

function errorBody(code, message, status = 400, param = null) {
  return {
    error: {
      type:
        status === 429
          ? 'rate_limit_error'
          : status >= 500
            ? 'api_error'
            : status === 403
              ? 'permission_error'
              : status === 404
                ? 'not_found_error'
                : 'invalid_request_error',
      code,
      message,
      ...(param ? { param } : {}),
    },
  }
}

const ADMISSION_MESSAGES = {
  antigravity_disabled: 'Antigravity 尚未启用，请在设置中开启。',
  no_antigravity_vm: '没有可调度的 Antigravity 槽位，请检查授权、运行状态、出口与调度开关。',
  antigravity_model_unavailable: '此模型在当前密钥可用的 Antigravity 槽位中不可用，请同步账号模型目录。',
  antigravity_capacity_unavailable: 'Antigravity 槽位并发或请求速率已满，请稍后重试。',
  pool_resting: 'Antigravity 槽位当前处于休息时段。',
  pool_wait_queue_full: 'Antigravity 等待队列已满。',
  platform_mismatch: '指定槽位不属于 Antigravity 平台。',
}

const CONTENT_BLOCKED_MESSAGE = 'The request was blocked by content safety review.'

// The bridge reports provider-specific wording; clients and tenant logs must only see a generic moderation block.
function contentBlockedLogMessage(bridgeMessage) {
  const reason = /ended with ([A-Z_]+)/.exec(String(bridgeMessage || ''))?.[1] || 'PROMPT_BLOCKED'
  return `${CONTENT_BLOCKED_MESSAGE} (${reason})`
}

// Clients and tenant-visible logs must not reveal which upstream account type served the request.
function hideUpstream(text) {
  if (text == null) return text
  return String(text)
    .replace(/\s?Antigravity\s?(?=[\u4e00-\u9fff，。])/g, '上游')
    .replace(/(^|[.!?]\s+)Antigravity/g, '$1Upstream')
    .replace(/Antigravity/g, 'upstream')
}

export async function handleAntigravityProtocol({
  req,
  res,
  protocol,
  ctx,
  inbound = ctx?.body,
  logBag,
  stats,
  json,
  writeSSEHeaders,
  routing = {},
  projectRoot,
  stickyRouter = null,
  apiKeyStore = null,
  accountGate = null,
  recordUsage = null,
  requestStartedAt = Date.now(),
  ops = {},
}) {
  const config = normalizeAntigravityRouting(routing.antigravity)
  const fail = (status, code, rawMessage, param) => {
    const message = hideUpstream(rawMessage)
    stats.errors++
    logBag.error_code = code
    logBag.error_message = message
    logBag.final_state = 'rejected'
    if (!res.destroyed && !res.writableEnded) json(res, status, errorBody(code, message, status, param))
  }
  logBag.via = 'antigravity-slot'
  logBag.attempt_count = 0
  if (!config.enabled) return fail(503, 'antigravity_disabled', ADMISSION_MESSAGES.antigravity_disabled)
  const model = antigravityModelId(ctx.body?.model)
  const entry = model && config.models.find((m) => m.id === model && m.enabled)
  if (!entry) return fail(400, 'model_not_allowed', '请选择已配置并启用的 Antigravity 模型。', 'model')
  const scope = (ops.keyScope || keyScopeFromRequest)(req)
  const denial = vmPoolDenial(scope)
  if (denial) return fail(403, denial.code, denial.message)
  if (!['all', 'antigravity'].includes(scope.group_type))
    return fail(403, 'key_group_mismatch', '此密钥不可调用 Antigravity。')
  const pin = pinnedVmIdFromRequest(req, apiKeyStore?.users)
  const ownerScope = ownerScopeFromRequest(req, apiKeyStore?.users)
  const responseStore = ops.responseStore || antigravityResponseStore
  const responseScope = antigravityResponseScope(req)
  let previous = null
  if (protocol === 'openai.responses' && ctx.body.previous_response_id) {
    previous = responseStore.get(ctx.body.previous_response_id, { scope: responseScope, model })
    if (!previous)
      return fail(
        404,
        'previous_response_not_found',
        'Previous response was not found for this API key/model or has expired.',
        'previous_response_id',
      )
  }
  const normalized = normalizeAntigravityRequest(protocol, ctx.body, {
    ...(previous ? { previousMessages: previous.messages } : {}),
  })
  if (!normalized.ok)
    return fail(normalized.status || 400, normalized.code || 'invalid_request', normalized.message, normalized.param)
  const variant = resolveAntigravityVariant(entry, normalized.request.reasoning?.effort)
  if (!variant.ok)
    return fail(
      400,
      'reasoning_effort_not_supported',
      variant.message,
      protocol === 'openai.chat'
        ? 'reasoning_effort'
        : protocol === 'openai.responses'
          ? 'reasoning.effort'
          : 'output_config.effort',
    )
  logBag.reasoning_effort = variant.level
  const request = {
    ...normalized.request,
    model: variant.upstream,
    ...(variant.level ? { reasoning: { effort: variant.level } } : {}),
  }
  const stream = isClientStream(inbound, req.headers)
  const id = `${protocol === 'anthropic.messages' ? 'msg_' : protocol === 'openai.responses' ? 'resp_' : 'chatcmpl_'}${crypto.randomBytes(16).toString('hex')}`
  const makeStream = () =>
    createAntigravityProtocolStream(protocol, {
      id,
      model: ctx.body.model,
      includeUsage: ctx.body.stream_options?.include_usage === true,
    })
  let streamState = stream ? makeStream() : null
  const runtime = ops.runtime || antigravityPoolRuntime
  const list = ops.listVms || listVms
  const lookup = ops.getVm || getVm
  const run = ops.runInference || runAntigravityInference
  const excluded = new Set()
  // The sticky namespace includes this API key. A caller-supplied session ID
  // cannot accidentally share another tenant's account preference. Upstream
  // prompt caches live per account and per prefix, so side requests that reuse
  // the session ID (title generation, summaries) get their own affinity row.
  const rawSticky = stickyRouter?.extractPoolKey?.(req, ctx.body, { platform: 'antigravity' }) || null
  const prefix = crypto
    .createHash('sha256')
    .update(JSON.stringify([request.model, request.system, request.tools, request.messages[0]]))
    .digest('hex')
    .slice(0, 16)
  const stickyKey = rawSticky && responseScope ? `antigravity:${responseScope}:${rawSticky}:${prefix}` : null
  const preferred = previous?.vmId || (stickyKey ? stickyRouter?.resolve?.(stickyKey)?.vmId : null)
  const deadline = Date.now() + config.queue_timeout_ms
  // A short wait for the warm slot is cheaper than re-sending the whole prefix cold elsewhere.
  let affinityUntil = preferred ? Date.now() + config.affinity_wait_ms : 0
  const budget = Math.min(16, Math.max(1, Number(routing.failover?.max_total_attempts) || 4))
  const controller = new AbortController()
  const abort = () => {
    if (!res.writableEnded) controller.abort()
  }
  req.once('aborted', abort)
  res.once('close', abort)
  if (req.aborted || res.destroyed || res.writableEnded) controller.abort()
  let last = null
  let counted = false
  const write = (chunk) => {
    if (!chunk || controller.signal.aborted || res.destroyed || res.writableEnded) return
    if (res.writableLength > 1024 * 1024) {
      controller.abort()
      throw new Error('slow_consumer')
    }
    if (!res.headersSent) writeSSEHeaders(res)
    res.write(chunk)
  }
  let keyAcquired = false
  if (req.apiKeyRecord && apiKeyStore?.acquire) {
    const gate = apiKeyStore.acquire(req.apiKeyRecord)
    if (!gate.ok) {
      req.off('aborted', abort)
      res.off('close', abort)
      return fail(
        gate.status || 429,
        gate.code || 'rate_limit_exceeded',
        gate.message || 'API key capacity is exhausted.',
      )
    }
    keyAcquired = true
  }
  try {
    while (!controller.signal.aborted && logBag.attempt_count < budget) {
      const picked = pickAntigravityCandidates(list(projectRoot, routing), {
        projectRoot,
        model,
        upstreamModel: variant.upstream,
        routing,
        scope,
        ownerScope,
        pin,
        excluded,
        preferred,
        runtime,
        ...(ops.supportsModel ? { supportsModel: ops.supportsModel } : {}),
      })
      if (picked.preferredBusy && Date.now() < affinityUntil) {
        try {
          await runtime.wait({ deadline: Math.min(affinityUntil, deadline), signal: controller.signal })
        } catch {
          affinityUntil = 0
        }
        continue
      }
      let admission = null
      for (const candidate of picked.candidates) {
        const lease = runtime.acquire(candidate.vm.id, candidate)
        if (lease) {
          admission = { ...candidate, lease }
          break
        }
      }
      if (!admission) {
        if (last) break
        if (!picked.waitable || Date.now() >= deadline)
          return fail(
            picked.status || 503,
            picked.error || 'antigravity_capacity_unavailable',
            ADMISSION_MESSAGES[picked.error] || ADMISSION_MESSAGES.antigravity_capacity_unavailable,
          )
        try {
          await runtime.wait({ deadline, retryAt: picked.retryAt, signal: controller.signal })
        } catch {
          return fail(429, 'pool_wait_queue_full', ADMISSION_MESSAGES.pool_wait_queue_full)
        }
        continue
      }
      const { lease } = admission
      const vm = lookup(projectRoot, admission.vm.id)
      try {
        if (!vm || !isAntigravityVm(vm)) {
          excluded.add(admission.vm.id)
          continue
        }
        if (!counted) {
          counted = true
          stats.requests++
          stats.by_route[protocol] = (stats.by_route[protocol] || 0) + 1
        }
        logBag.vm_id = vm.id
        logBag.account_id = vm.id
        logBag.final_account_id = vm.id
        logBag.attempt_count++
        logBag.upstream_model = model
        if (accountGate && (await accountGate(vm))) return
        if (controller.signal.aborted) break
        let emitted = false
        const onEvent = (event) => {
          if (
            logBag.first_token_ms == null &&
            (event?.type === 'text_delta' ||
              event?.event === 'text_delta' ||
              event?.type === 'tool_use' ||
              event?.type === 'content_block_delta')
          )
            logBag.first_token_ms = Math.max(0, Date.now() - requestStartedAt)
          if (!stream) return
          const chunk = streamState.push(event)
          if (chunk) {
            emitted = true
            write(chunk)
          }
        }
        let result
        try {
          result = await run({ projectRoot, vm, routing, request, signal: controller.signal, onEvent })
        } catch {
          result = {
            ok: false,
            status: 502,
            code: 'antigravity_transport_error',
            message: 'Antigravity transport failed.',
          }
        }
        last = result || {
          ok: false,
          status: 502,
          code: 'antigravity_stream_incomplete',
          message: 'Antigravity did not return a terminal response.',
        }
        if (controller.signal.aborted)
          last = { ...last, ok: false, status: 499, code: 'client_cancelled', terminalState: 'cancelled' }
        last.output_committed ||= emitted
        runtime.report(vm.id, last)
        logBag.upstream_status = last.upstream_status ?? last.status ?? null
        if (last.usage) {
          logBag.usage = last.usage
          logBag.input_tokens = last.usage.input_tokens ?? null
          logBag.output_tokens = last.usage.output_tokens ?? null
          logBag.cache_read_tokens = last.usage.cache_read_input_tokens ?? last.usage.cache_read_tokens ?? null
        }
        if (last.ok) {
          let rendered, tail
          try {
            rendered = renderAntigravityResponse(protocol, last, { id, model: ctx.body.model })
            if (stream) tail = streamState.finish(last)
          } catch {
            last = {
              ...last,
              ok: false,
              status: 502,
              code: 'antigravity_protocol_error',
              message: 'Antigravity response did not match the completed stream.',
              output_committed: emitted,
              terminalState: 'incomplete',
            }
            runtime.report(vm.id, last)
            break
          }
          logBag.final_state = last.terminalState || 'verified'
          logBag.stop_reason = last.stop_reason || 'end_turn'
          logBag.first_token_ms ??= Math.max(0, Date.now() - requestStartedAt)
          if (stickyKey) {
            // The serving slot now holds the longest cached prefix; a plain bind keeps the first slot forever.
            const bound = stickyRouter?.resolve?.(stickyKey)?.vmId
            if (bound && bound !== vm.id) stickyRouter?.rebindFamily?.(stickyKey, { vmId: vm.id, accountId: vm.id })
            else stickyRouter?.bind?.(stickyKey, { vmId: vm.id, accountId: vm.id })
          }
          if (protocol === 'openai.responses' && ctx.body.store !== false)
            responseStore.put(id, {
              scope: responseScope,
              model,
              messages: request.messages,
              content: last.content || [],
              vmId: vm.id,
            })
          recordUsage?.(last.usage)
          if (stream) {
            write(tail)
            if (!res.destroyed && !res.writableEnded) res.end()
            return
          }
          return json(res, 200, rendered)
        }
        if (controller.signal.aborted || last.code === 'client_cancelled' || last.status === 499) break
        if (res.headersSent || !isAntigravityFailoverError(last)) break
        excluded.add(vm.id)
        if (stream) streamState = makeStream()
      } finally {
        lease.release()
      }
    }
    if (controller.signal.aborted || last?.code === 'client_cancelled' || last?.status === 499) {
      logBag.final_state = 'cancelled'
      logBag.error_code = null
      if (last?.usage) recordUsage?.(last.usage)
      if (!res.destroyed && !res.writableEnded) res.end()
      return
    }
    const blocked = last?.code === 'antigravity_content_blocked'
    const code = blocked ? ErrorCode.CONTENT_FILTER_REFUSAL : last?.code || 'antigravity_unavailable'
    const message = blocked
      ? CONTENT_BLOCKED_MESSAGE
      : hideUpstream(last?.message) || 'Upstream is temporarily unavailable.'
    const logMessage = blocked ? contentBlockedLogMessage(last.message) : message
    if (res.headersSent) {
      stats.errors++
      logBag.error_code = code
      logBag.error_message = logMessage
      logBag.final_state = last?.terminalState || 'incomplete'
      if (last?.usage) recordUsage?.(last.usage)
      write(streamState.error({ code, message }))
      if (!res.destroyed && !res.writableEnded) res.end()
      return
    }
    if (last?.usage) recordUsage?.(last.usage)
    fail(last?.status >= 400 ? last.status : 503, code, message)
    logBag.error_message = logMessage
  } finally {
    req.off('aborted', abort)
    res.off('close', abort)
    if (keyAcquired) apiKeyStore.release(req.apiKeyRecord)
  }
}
