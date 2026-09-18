/**
 * Codex hop from handle-protocol. Claude convert/pool/CRS never runs here.
 */
import path from 'node:path'
import { getVm, listVms, persistCodexUsage, syncCodexQuotaSchedule } from '../vm/vm-registry.mjs'
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
import { streamCodexKernel } from '../transport/codex-kernel-client.mjs'
import { ensureCodexKernel, writeCodexKernelConfig } from '../transport/codex-kernel-supervisor.mjs'
import { boundProxyUrl } from '../vm/egress.mjs'
import { pickCodexSlots, isCodexFailoverError, CODEX_FAILOVER_MAX } from '../pool/codex-slot-pool.mjs'

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

function pinnedVmId(req) {
  const pinVmRaw = String(req?.headers?.['x-kin-vm'] || '').trim()
  if (req?.apiKeyKind !== 'master') return null
  return /^vm-[a-z0-9-]+$/i.test(pinVmRaw) ? pinVmRaw : null
}

export function pickCodexCandidates(projectRoot, req) {
  const pin = pinnedVmId(req)
  if (pin) {
    const vm = getVm(projectRoot, pin)
    if (!vm || !isCodexVm(vm)) return { error: 'platform_mismatch', pin, ids: [] }
    return { ids: [vm.id], pin }
  }
  for (const item of listVms(projectRoot)) {
    if (!isCodexVm(item)) continue
    syncCodexQuotaSchedule(projectRoot, getVm(projectRoot, item.id) || item)
  }
  return pickCodexSlots(listVms(projectRoot))
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
    logBag.error_code = converted.code
    return json(res, 400, {
      error: {
        type: 'invalid_request_error',
        code: converted.code,
        message: 'request could not be converted to Codex Responses',
      },
    })
  }
  const picked = pickCodexCandidates(projectRoot, req)
  if (picked.error === 'platform_mismatch') {
    stats.errors++
    logBag.via = 'codex-kernel'
    logBag.error_code = 'platform_mismatch'
    return json(res, 400, {
      error: {
        type: 'invalid_request_error',
        code: 'platform_mismatch',
        message: `vm '${picked.pin}' is not a GPT slot`,
      },
    })
  }
  const candidateIds = (picked.ids || []).slice(0, CODEX_FAILOVER_MAX)
  if (!candidateIds.length) {
    stats.errors++
    logBag.via = 'codex-kernel'
    logBag.error_code = 'no_codex_vm'
    return json(res, 503, {
      error: { type: 'api_error', code: 'no_codex_vm', message: 'no Codex kernel VM is configured' },
    })
  }
  logBag.via = 'codex-kernel'
  stats.requests++
  stats.by_route[protocol] = (stats.by_route[protocol] || 0) + 1

  const stream = inbound?.stream !== false && ctx.body?.stream !== false
  const session = sessionFrom(req, converted.body)
  const outboundBody = { ...converted.body, stream: true }
  const hop = ops.streamCodexKernel || streamCodexKernel
  const writeCfg = ops.writeCodexKernelConfig || writeCodexKernelConfig
  const ensure = ops.ensureCodexKernel || ensureCodexKernel
  const anthropicSse = protocol === 'anthropic.messages' ? createAnthropicSseState() : null
  let last = null
  for (let i = 0; i < candidateIds.length; i++) {
    const vm = getVm(projectRoot, candidateIds[i])
    if (!vm || !isCodexVm(vm)) continue
    logBag.vm_id = vm.id
    writeCfg(projectRoot, vm, {
      proxyUrl: boundProxyUrl(vm.proxy),
      proxyRequired: true,
    })
    const ready = await ensure(execFor(projectRoot, vm))
    if (!ready?.ok) {
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
      if (i + 1 < candidateIds.length && !res.headersSent) continue
      stats.errors++
      logBag.error_code = 'codex_kernel_unavailable'
      return json(res, 503, last.body)
    }
    const chunks = []
    const result = await runCodexKernelHop({
      hop,
      args: {
        exec: execFor(projectRoot, vm),
        body: outboundBody,
        reqHeaders: req.headers,
        envelope: { body: outboundBody, stream: true, session },
      },
      onEvent: async (line) => {
        if (!stream) {
          chunks.push(line)
          return
        }
        if (!res.headersSent) writeSSEHeaders(res)
        if (protocol === 'openai.chat' || protocol === 'openai.completions') {
          const mapped = responsesSseToChatChunk(line)
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
    if (result?.ok) {
      const usage = result.usage || result.body?.usage || result.body?.response?.usage || null
      logBag.usage = usage
      logBag.input_tokens = usage?.input_tokens ?? usage?.prompt_tokens ?? null
      logBag.output_tokens = usage?.output_tokens ?? usage?.completion_tokens ?? null
      logBag.cache_read_tokens = usage?.input_tokens_details?.cached_tokens ?? usage?.cache_read_tokens ?? null
      logBag.first_token_ms = result.ttftMs ?? null
      logBag.final_state = result.terminalState || 'verified'
      logBag.upstream_model = converted.body.model
      if (i > 0) logBag.codex_failed_over = true
      if (!stream) {
        const assembled = assembleCodexBodyFromSse(chunks, result.body || {})
        const body =
          protocol === 'anthropic.messages' ? codexBodyToAnthropicMessage(assembled, converted.body.model) : assembled
        return json(res, 200, body)
      }
      if (!res.headersSent) writeSSEHeaders(res)
      return res.end()
    }
    if (res.headersSent) {
      stats.errors++
      logBag.error_code = result?.body?.error?.code || 'codex_upstream'
      logBag.upstream_status = result?.status || 0
      return res.end()
    }
    if (i + 1 < candidateIds.length && isCodexFailoverError(result)) continue
    break
  }
  stats.errors++
  logBag.error_code = last?.body?.error?.code || 'codex_upstream'
  logBag.upstream_status = last?.status || 0
  return json(res, last?.status || 502, last?.body || { error: { type: 'api_error', code: 'codex_upstream' } })
}
