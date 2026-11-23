import crypto from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  FULL_GEMINI_CAPABILITIES,
  NATIVE_TUI_CAPABILITIES,
  createGeminiCollector,
  createGeminiEventDecoder,
  createSseFrameSplitter,
} from '../protocol/gemini-convert.mjs'
import { callGeminiHost, callGeminiHostStream } from './routes.mjs'
import { GEMINI_LICENSE_MESSAGES } from './subscription.mjs'

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const MODEL = /^[a-z0-9][a-z0-9._-]{0,99}$/
const RUN_ID = /^[a-f0-9]{32}$/
const POLL_MS = 250
const TURN_MS = 120_000
const STREAM_TURN_MS = 300_000

const FAILURES = {
  gemini_host_unavailable: [503, 'Gemini host is not available.'],
  gemini_host_protocol_error: [502, 'Gemini host returned an unusable response.'],
  gemini_no_account: [503, 'No authorized Gemini account is ready.'],
  gemini_model_unavailable: [404, 'This Gemini model is not available on an authorized account.'],
  gemini_proxy_unavailable: [503, 'The selected Gemini account has no usable proxy.'],
  gemini_operation_busy: [503, 'Gemini accounts are busy. Retry shortly.'],
  gemini_oauth_required: [503, 'The selected Gemini account needs authorization again.'],
  gemini_api_key_invalid: [503, 'The selected Gemini API key is not valid.'],
  gemini_location_unsupported: [403, 'Google rejected this account location for Antigravity.'],
  gemini_proxy_error: [502, 'The bound Gemini proxy could not reach Google.'],
  gemini_quota_exhausted: [429, 'The selected Gemini account quota is exhausted.'],
  gemini_inference_timeout: [504, 'The Gemini turn timed out.'],
  gemini_inference_invalid_output: [502, 'Gemini returned an unreadable response.'],
  gemini_inference_start_failed: [503, 'Gemini could not start the turn.'],
  gemini_inference_cancelled: [499, 'The Gemini turn was cancelled.'],
  gemini_inference_output_limit: [502, 'The Gemini response exceeded the text limit.'],
  gemini_inference_tool_blocked: [400, 'This Gemini route accepts one plain-text turn and no tools.'],
  gemini_inference_failed: [502, 'The Gemini turn failed.'],
  gemini_unsupported_turn: [
    400,
    'The selected Gemini environment does not support the requested tools, history, parameters, or media.',
  ],
  gemini_invalid_request: [400, 'Invalid Gemini request payload.'],
  gemini_native_tty_unavailable: [503, 'No free Linux virtual console is available for CRAGGemini.'],
  gemini_native_worker_unavailable: [503, 'The CRAGGemini native worker is unavailable.'],
  gemini_native_bridge_timeout: [503, 'The CRAGGemini TUI did not connect to its native worker in time.'],
  gemini_egress_unavailable: [503, 'Gemini egress is not available.'],
  gemini_oauth_tools_missing: [503, 'Gemini OAuth runtime tools are missing.'],
  gemini_ipv4_forwarding_unavailable: [503, 'Gemini IPv4 forwarding is not available.'],
  license_required: [403, GEMINI_LICENSE_MESSAGES.license_required],
  license_expired: [403, GEMINI_LICENSE_MESSAGES.license_expired],
  license_not_yet_valid: [403, GEMINI_LICENSE_MESSAGES.license_not_yet_valid],
  license_invalid: [403, GEMINI_LICENSE_MESSAGES.license_invalid],
  license_binding_mismatch: [403, GEMINI_LICENSE_MESSAGES.license_binding_mismatch],
  license_unconfigured: [403, GEMINI_LICENSE_MESSAGES.license_unconfigured],
}

const NON_CIRCUIT_FAILURES = new Set([
  'gemini_quota_exhausted',
  'gemini_oauth_required',
  'gemini_api_key_invalid',
  'gemini_location_unsupported',
  'gemini_model_unavailable',
  'gemini_unsupported_turn',
  'gemini_invalid_request',
  'gemini_inference_tool_blocked',
  'license_required',
  'license_expired',
  'license_not_yet_valid',
  'license_invalid',
  'license_binding_mismatch',
  'license_unconfigured',
])

function fail(status, code, message = FAILURES[code]?.[1] || code) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

function known(error) {
  const code = error?.code
  if (typeof code === 'string' && Object.hasOwn(FAILURES, code)) {
    const [status, message] = FAILURES[code]
    return fail(Number.isInteger(error.status) ? error.status : status, code, error.message || message)
  }
  return null
}

function accountCapabilities(environment) {
  if (Array.isArray(environment.capabilities) && environment.capabilities.length) {
    return new Set(environment.capabilities.filter((cap) => typeof cap === 'string' && cap))
  }
  return new Set(environment.auth_method === 'api_key' ? FULL_GEMINI_CAPABILITIES : NATIVE_TUI_CAPABILITIES)
}

async function readRun(callHost, id, runId, signal) {
  const deadline = Date.now() + TURN_MS
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    const result = await callHost('test-chat-status', { id, run_id: runId })
    if (result?.state === 'completed' || result?.state === 'failed') return result
    if (result?.state !== 'running') throw fail(502, 'gemini_host_protocol_error')
    await sleep(POLL_MS, undefined, { signal })
  }
  throw fail(504, 'gemini_inference_timeout')
}

async function consumeStreamResponse(response, { model, onEvent, signal }) {
  const decoder = createGeminiEventDecoder({ fallbackModel: model })
  const collector = createGeminiCollector({ fallbackModel: model })
  let streamError = null
  const emit = (event) => {
    collector.push(event)
    if (event.kind === 'error' && !streamError) streamError = event
    onEvent?.(event)
  }
  const splitter = createSseFrameSplitter((frame) => {
    decoder.decodeSseFrame(frame, emit)
  })
  const onAbort = () => {
    try {
      response.destroy()
    } catch {}
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    for await (const chunk of response) {
      signal?.throwIfAborted()
      splitter.push(chunk)
    }
    signal?.throwIfAborted()
    splitter.flush()
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  const result = collector.result()
  if (streamError) {
    const code = Object.hasOwn(FAILURES, streamError.code)
      ? streamError.code
      : streamError.status === 429
        ? 'gemini_quota_exhausted'
        : streamError.status === 401
          ? 'gemini_oauth_required'
          : streamError.status === 403
            ? 'gemini_location_unsupported'
            : streamError.status === 404
              ? 'gemini_model_unavailable'
              : streamError.status === 400
                ? 'gemini_invalid_request'
                : 'gemini_inference_failed'
    throw fail(streamError.status || FAILURES[code][0], code, streamError.message)
  }
  if (!result.sawFinish && !result.text && !result.toolCalls.length && !result.images.length) {
    throw fail(502, 'gemini_inference_invalid_output')
  }
  return result
}

async function readErrorPayload(response) {
  const chunks = []
  let total = 0
  for await (const chunk of response) {
    total += chunk.length
    if (total > 64 * 1024) break
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

export function createGeminiScheduler({
  callHost,
  callHostStream,
  resolveProxy,
  poolScheduler,
  apiKeyStore,
  groupsRepo,
  cragSubscription = null,
}) {
  const streamHost = callHostStream ?? (callHost === callGeminiHost ? callGeminiHostStream : null)

  function checkEnvironmentLicense(environment, payloadMode) {
    if (environment.auth_method === 'api_key') return { ok: true, seat_required: false }
    if (cragSubscription?.checkAdmission) {
      return cragSubscription.checkAdmission(environment, { payloadMode })
    }
    if (payloadMode !== 'crag_subscription' && !environment.crag_license) {
      return { ok: true, seat_required: false }
    }
    if (environment.crag_license?.valid === true) {
      return { ok: true, seat_required: true }
    }
    const code =
      typeof environment.crag_license?.code === 'string' && Object.hasOwn(FAILURES, environment.crag_license.code)
        ? environment.crag_license.code
        : 'license_required'
    return { ok: false, status: 403, code, message: FAILURES[code][1] }
  }

  function recordAccountUsage(apiKeyRecord, model, usage) {
    if (!apiKeyRecord || !apiKeyStore?.recordUsage) return
    const multiplier = groupsRepo?.rateMultiplier?.(apiKeyRecord.group_id ?? 1) ?? 1
    apiKeyStore.recordUsage(
      apiKeyRecord,
      {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        ...(usage.cache_read_tokens ? { cache_read_input_tokens: usage.cache_read_tokens } : {}),
        ...(usage.reasoning_tokens ? { reasoning_tokens: usage.reasoning_tokens } : {}),
      },
      { model, rateMultiplier: multiplier },
    )
  }

  return {
    async catalog() {
      const view = await callHost('list', {})
      if (!Array.isArray(view?.environments)) throw fail(502, 'gemini_host_protocol_error')
      if (view.payload_state !== 'installed') return { models: [], accounts: [] }
      const accounts = []
      const unlicensedAccounts = []
      const payloadMode = view.payload_mode === 'crag_subscription' ? 'crag_subscription' : 'legacy_release'
      for (const environment of view.environments) {
        if (
          environment?.auth_state !== 'authorized' ||
          environment.oauth_imported === true ||
          (environment.auth_method === 'oauth' && view.oauth_runtime_issue) ||
          typeof environment.id !== 'string' ||
          !ID.test(environment.id) ||
          typeof environment.proxy_id !== 'string' ||
          !ID.test(environment.proxy_id) ||
          environment.models_discovered !== true ||
          !Array.isArray(environment.models)
        )
          continue
        if (resolveProxy) {
          try {
            resolveProxy(environment.proxy_id)
          } catch (error) {
            if (error?.code === 'gemini_proxy_unavailable') continue
            throw error
          }
        }
        const models = []
        for (const model of environment.models || []) {
          if (typeof model === 'string' && MODEL.test(model)) models.push(model)
        }
        if (models.length) {
          const authMethod = environment.auth_method === 'api_key' ? 'api_key' : 'oauth'
          const admission = checkEnvironmentLicense({ ...environment, auth_method: authMethod }, payloadMode)
          if (!admission.ok) {
            unlicensedAccounts.push({
              id: environment.id,
              auth_method: authMethod,
              models,
              denial: admission,
            })
            continue
          }
          accounts.push({
            id: environment.id,
            auth_method: authMethod,
            capabilities: accountCapabilities(environment),
            models,
          })
        }
      }
      return {
        models: [...new Set(accounts.flatMap((account) => account.models))].map((id) => ({
          id,
          object: 'model',
          owned_by: 'google',
        })),
        accounts,
        unlicensedAccounts,
      }
    },

    async stream({
      model,
      geminiBody,
      targetBodyFor = null,
      requiredCapabilities = [],
      plainText = null,
      requestId = `gem_${crypto.randomBytes(12).toString('hex')}`,
      signal,
      apiKeyRecord,
      onEvent = null,
    }) {
      const gate = apiKeyStore?.acquire?.(apiKeyRecord)
      if (gate && !gate.ok) throw fail(gate.status || 429, gate.code, gate.message)
      const excluded = new Set()
      let reservation = null
      let selected = null
      let legacyRun = null
      let activeInfer = null

      try {
        signal?.throwIfAborted()
        const catalog = await this.catalog()
        const modelAccounts = catalog.accounts.filter((account) => account.models.includes(model))
        if (!modelAccounts.length) {
          const unlicensedMatch = (catalog.unlicensedAccounts || []).find((account) => account.models.includes(model))
          if (unlicensedMatch) {
            throw fail(
              unlicensedMatch.denial.status || 403,
              unlicensedMatch.denial.code || 'license_required',
              unlicensedMatch.denial.message,
            )
          }
          throw fail(
            catalog.accounts.length ? 404 : 503,
            catalog.accounts.length ? 'gemini_model_unavailable' : 'gemini_no_account',
          )
        }
        const accounts = modelAccounts.filter((account) =>
          requiredCapabilities.every((cap) => account.capabilities.has(cap)),
        )
        if (!accounts.length) {
          throw fail(
            400,
            'gemini_unsupported_turn',
            'No authorized Gemini environment for this model supports the requested capabilities.',
          )
        }
        const candidates = accounts.map((account) => ({
          accountId: `gemini:${account.id}`,
          vmId: `gemini:${account.id}`,
          model,
          authMethod: account.auth_method,
          maxConcurrency: 1,
          priority: account.auth_method === 'api_key' && requiredCapabilities.length ? 1 : 0,
          weight: 1,
          lastUsedAt: 0,
        }))

        let streamResponse = null
        while (!streamResponse && !legacyRun && excluded.size < candidates.length) {
          signal?.throwIfAborted()
          const grant = poolScheduler
            ? poolScheduler.reserveExternalCandidates(candidates, { excluded })
            : {
                selected: candidates.find((c) => !excluded.has(c.accountId)),
                reservation: { release() {} },
              }
          if (!grant?.selected) break
          reservation = grant.reservation
          const id = grant.selected.accountId.slice('gemini:'.length)
          selected = { ...grant.selected, id }
          try {
            const listed = await callHost('get', { id })
            const proxyId = listed?.proxy_id
            if (typeof proxyId !== 'string' || !ID.test(proxyId)) throw fail(502, 'gemini_host_protocol_error')
            const proxyUrl = resolveProxy ? resolveProxy(proxyId) : undefined
            signal?.throwIfAborted()
            const authMethod = listed?.auth_method === 'api_key' ? 'api_key' : selected.authMethod || 'oauth'
            const outboundBody = targetBodyFor
              ? targetBodyFor(authMethod === 'api_key' ? 'gemini' : 'antigravity')
              : geminiBody

            if (streamHost) {
              const res = await streamHost(
                'infer',
                {
                  id,
                  proxy_id: proxyId,
                  proxy_url: proxyUrl,
                  model,
                  request_id: requestId,
                  body: outboundBody,
                },
                { signal, timeoutMs: STREAM_TURN_MS },
              )
              const contentType = String(res.headers?.['content-type'] || '')
                .split(';')[0]
                .trim()
                .toLowerCase()
              if (res.statusCode === 200 && contentType === 'text/event-stream') {
                activeInfer = { id, request_id: requestId }
                streamResponse = res
                break
              }
              const errBody = await readErrorPayload(res)
              if (
                res.statusCode === 404 &&
                (!errBody?.code || errBody.code === 'not_found' || errBody.code === 'gemini_host_protocol_error') &&
                plainText != null
              ) {
                // Backward compatibility with an older host without /infer.
                const started = await callHost('test-chat', {
                  id,
                  proxy_id: proxyId,
                  proxy_url: proxyUrl,
                  model,
                  prompt: plainText,
                })
                if (typeof started?.run_id !== 'string' || !RUN_ID.test(started.run_id)) {
                  throw fail(502, 'gemini_host_protocol_error')
                }
                legacyRun = { id, run_id: started.run_id }
                break
              }
              const errCode =
                typeof errBody?.code === 'string' && Object.hasOwn(FAILURES, errBody.code)
                  ? errBody.code
                  : res.statusCode === 429
                    ? 'gemini_quota_exhausted'
                    : res.statusCode === 400
                      ? 'gemini_invalid_request'
                      : res.statusCode === 404
                        ? 'gemini_model_unavailable'
                        : 'gemini_inference_failed'
              throw fail(res.statusCode || FAILURES[errCode][0], errCode, errBody?.message || FAILURES[errCode][1])
            }

            if (plainText == null) {
              throw fail(400, 'gemini_unsupported_turn', 'This Gemini host transport only supports plain-text turns.')
            }
            const started = await callHost('test-chat', {
              id,
              proxy_id: proxyId,
              proxy_url: proxyUrl,
              model,
              prompt: plainText,
            })
            if (typeof started?.run_id !== 'string' || !RUN_ID.test(started.run_id)) {
              throw fail(502, 'gemini_host_protocol_error')
            }
            legacyRun = { id, run_id: started.run_id }
          } catch (error) {
            reservation.release()
            reservation = null
            if (error?.code === 'gemini_operation_busy' || error?.code === 'gemini_proxy_unavailable') {
              excluded.add(selected.accountId)
              selected = null
              continue
            }
            throw error
          }
        }

        if ((!streamResponse && !legacyRun) || !selected || !reservation) {
          throw fail(503, 'gemini_operation_busy')
        }

        let collected
        if (streamResponse) {
          collected = await consumeStreamResponse(streamResponse, { model, onEvent, signal })
          activeInfer = null
        } else {
          const result = await readRun(callHost, legacyRun.id, legacyRun.run_id, signal)
          legacyRun = null
          if (result.state === 'failed') {
            const code = typeof result.error?.code === 'string' ? result.error.code : 'gemini_inference_failed'
            const mapped = Object.hasOwn(FAILURES, code) ? FAILURES[code] : null
            throw fail(mapped?.[0] || 502, mapped ? code : 'gemini_inference_failed')
          }
          if (typeof result.text !== 'string') throw fail(502, 'gemini_host_protocol_error')
          const usage = {}
          for (const key of [
            'input_tokens',
            'output_tokens',
            'cache_read_tokens',
            'reasoning_tokens',
            'total_tokens',
          ]) {
            const count = result.usage?.[key]
            if (Number.isSafeInteger(count) && count >= 0) usage[key] = count
          }
          const collector = createGeminiCollector({ fallbackModel: model })
          const emit = (ev) => {
            collector.push(ev)
            onEvent?.(ev)
          }
          emit({ kind: 'start', responseId: `resp_${crypto.randomBytes(10).toString('hex')}`, model, usage })
          if (result.text) emit({ kind: 'text', text: result.text })
          emit({ kind: 'stop', finishReason: 'STOP', stopReason: 'stop' })
          emit({ kind: 'usage', usage })
          collected = collector.result()
        }

        recordAccountUsage(apiKeyRecord, model, collected.usage || {})
        poolScheduler?.unitCircuit?.recordSuccess?.(selected.accountId)
        poolScheduler?.lastUsed?.set?.(selected.accountId, Date.now())
        return { ...collected, account_id: selected.id, model }
      } catch (error) {
        if (legacyRun) {
          try {
            await callHost('test-chat-cancel', legacyRun)
          } catch {}
        }
        if (activeInfer) {
          try {
            await callHost('infer-cancel', activeInfer)
          } catch {}
        }
        const failure = known(error) || error
        const failureCode = failure?.code
        const cancelled = signal?.aborted || failure?.name === 'AbortError' || failureCode === 'ABORT_ERR'
        if (selected && cancelled) {
          poolScheduler?.unitCircuit?.releaseProbe?.(selected.accountId)
        } else if (selected && !NON_CIRCUIT_FAILURES.has(failureCode)) {
          poolScheduler?.unitCircuit?.recordFailure?.(selected.accountId)
        } else if (selected) {
          poolScheduler?.unitCircuit?.releaseProbe?.(selected.accountId)
        }
        throw failure
      } finally {
        reservation?.release()
        try {
          apiKeyStore?.release?.(apiKeyRecord)
        } catch {}
      }
    },

    async complete({ model, text, signal, apiKeyRecord }) {
      const result = await this.stream({
        model,
        geminiBody: { contents: [{ role: 'user', parts: [{ text }] }] },
        requiredCapabilities: [],
        plainText: text,
        signal,
        apiKeyRecord,
      })
      return { text: result.text, usage: result.usage, account_id: result.account_id, model }
    },
  }
}
