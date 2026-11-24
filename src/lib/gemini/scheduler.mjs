import crypto from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  FULL_GEMINI_CAPABILITIES,
  NATIVE_TUI_CAPABILITIES,
  createGeminiCollector,
  createGeminiEventDecoder,
  createSseFrameSplitter,
} from '../protocol/gemini-convert.mjs'
import {
  classifyAntigravityModel,
  indexAccountModelCatalog,
  resolveUpstreamModel,
} from './model-catalog.mjs'
import { callGeminiHost, callGeminiHostStream } from './routes.mjs'
import { GEMINI_LICENSE_MESSAGES } from './subscription.mjs'

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const MODEL = /^[a-z0-9][a-z0-9._-]{0,99}$/
const RUN_ID = /^[a-f0-9]{32}$/
const MAX_CONCURRENCY = 64
const POLL_MS = 250
const TURN_MS = 120_000
const STREAM_TURN_MS = 300_000
const DEFAULT_QUOTA_COOLDOWN_MS = 60_000
const DEFAULT_ACCOUNT_COOLDOWN_MS = 5 * 60_000

function normalizeConcurrency(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_CONCURRENCY ? value : 1
}

const FAILURES = {
  gemini_host_unavailable: [503, 'Gemini host is not available.'],
  gemini_host_protocol_error: [502, 'Gemini host returned an unusable response.'],
  gemini_no_account: [503, 'No authorized Gemini account is ready.'],
  gemini_model_unavailable: [404, 'This Gemini model is not available on an authorized account.'],
  gemini_proxy_unavailable: [503, 'The selected Gemini account has no usable proxy.'],
  gemini_proxy_calibration_mismatch: [409, 'Bound Gemini proxy calibration digest mismatch.'],
  gemini_operation_busy: [503, 'Gemini accounts are busy. Retry shortly.'],
  gemini_oauth_required: [503, 'The selected Gemini account needs authorization again.'],
  gemini_api_key_invalid: [503, 'The selected Gemini API key is not valid.'],
  gemini_location_unsupported: [403, 'Google rejected this account location for Antigravity.'],
  gemini_account_verification_required: [
    403,
    'Google requires browser account verification before this account can use Antigravity.',
  ],
  gemini_account_ineligible: [403, 'Google rejected this account as ineligible for Antigravity.'],
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
  'gemini_account_verification_required',
  'gemini_account_ineligible',
  'gemini_model_unavailable',
  'gemini_unsupported_turn',
  'gemini_invalid_request',
  'gemini_inference_tool_blocked',
  'gemini_proxy_calibration_mismatch',
  'license_required',
  'license_expired',
  'license_not_yet_valid',
  'license_invalid',
  'license_binding_mismatch',
  'license_unconfigured',
])

const FAILOVER_ERRORS = new Set([
  'gemini_quota_exhausted',
  'gemini_account_verification_required',
  'gemini_location_unsupported',
  'gemini_account_ineligible',
  'gemini_oauth_required',
  'gemini_operation_busy',
  'gemini_proxy_unavailable',
  'gemini_proxy_error',
  'gemini_native_worker_unavailable',
  'gemini_inference_start_failed',
])

const ACCOUNT_WIDE_COOLDOWN_ERRORS = new Set([
  'gemini_account_verification_required',
  'gemini_location_unsupported',
  'gemini_account_ineligible',
  'gemini_oauth_required',
])

const INELIGIBLE_STATES = new Set(['verification_required', 'location_unsupported', 'ineligible'])

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

function quotaGroupKeyOfBucket(groupName = '', windowId = '') {
  const text = `${groupName} ${windowId}`.toLowerCase()
  if (/(claude|anthropic|3p|third|partner|openai|gpt)/.test(text)) return '3p'
  if (text.includes('argon')) return 'gemini-argon-wtu'
  if (text.includes('gemini')) return 'gemini'
  return null
}

function proactiveCooldownUntil(account, upstreamModel, quotaGroup, ts) {
  let until = 0
  if (INELIGIBLE_STATES.has(account?.eligibility)) {
    until = Math.max(until, ts + DEFAULT_ACCOUNT_COOLDOWN_MS)
  }
  const quotas = account?.quotas
  if (Array.isArray(quotas)) {
    for (const q of quotas) {
      if (q?.model !== upstreamModel) continue
      if (q.remaining_fraction === 0) {
        const parsed = q.reset_at ? Date.parse(q.reset_at) : NaN
        if (Number.isFinite(parsed) && parsed > ts) until = Math.max(until, parsed)
      }
    }
  }
  const groups = account?.quota_groups
  if (Array.isArray(groups)) {
    for (const g of groups) {
      const windows = Array.isArray(g?.windows) ? g.windows : []
      for (const w of windows) {
        const bucketGroup = quotaGroupKeyOfBucket(g?.name, w?.id)
        if (!bucketGroup) continue
        const matches =
          bucketGroup === quotaGroup || (quotaGroup === 'gemini-argon-wtu' && bucketGroup === 'gemini')
        if (!matches) continue
        if (w.remaining_fraction === 0) {
          const parsed = w.reset_at ? Date.parse(w.reset_at) : NaN
          if (Number.isFinite(parsed) && parsed > ts) until = Math.max(until, parsed)
        }
      }
    }
  }
  return until
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
  quotaCooldownMs = DEFAULT_QUOTA_COOLDOWN_MS,
  accountCooldownMs = DEFAULT_ACCOUNT_COOLDOWN_MS,
  now = () => Date.now(),
}) {
  const streamHost = callHostStream ?? (callHost === callGeminiHost ? callGeminiHostStream : null)
  const groupCooldowns = new Map()
  const modelCooldowns = new Map()
  const accountCooldowns = new Map()

  function activeCooldownUntil(account, upstreamModel, quotaGroup, ts) {
    let until = proactiveCooldownUntil(account, upstreamModel, quotaGroup, ts)
    const accUntil = accountCooldowns.get(account.id) || 0
    if (accUntil > ts) until = Math.max(until, accUntil)
    else if (accUntil) accountCooldowns.delete(account.id)

    const grpKey = `${account.id}:${quotaGroup}`
    const grpUntil = groupCooldowns.get(grpKey) || 0
    if (grpUntil > ts) until = Math.max(until, grpUntil)
    else if (grpUntil) groupCooldowns.delete(grpKey)

    const mdlKey = `${account.id}:${upstreamModel}`
    const mdlUntil = modelCooldowns.get(mdlKey) || 0
    if (mdlUntil > ts) until = Math.max(until, mdlUntil)
    else if (mdlUntil) modelCooldowns.delete(mdlKey)

    return until
  }

  function recordFailureCooldown(accountId, upstreamModel, quotaGroup, failure, ts) {
    const code = failure?.code
    if (code === 'gemini_quota_exhausted') {
      const retryMs =
        Number.isFinite(failure?.retryAfterMs) && failure.retryAfterMs > 0
          ? failure.retryAfterMs
          : quotaCooldownMs
      const until = ts + retryMs
      groupCooldowns.set(`${accountId}:${quotaGroup}`, Math.max(groupCooldowns.get(`${accountId}:${quotaGroup}`) || 0, until))
      modelCooldowns.set(`${accountId}:${upstreamModel}`, Math.max(modelCooldowns.get(`${accountId}:${upstreamModel}`) || 0, until))
      return
    }
    if (ACCOUNT_WIDE_COOLDOWN_ERRORS.has(code)) {
      const until = ts + accountCooldownMs
      accountCooldowns.set(accountId, Math.max(accountCooldowns.get(accountId) || 0, until))
    }
  }

  function clearCooldownOnSuccess(accountId, upstreamModel, quotaGroup) {
    accountCooldowns.delete(accountId)
    groupCooldowns.delete(`${accountId}:${quotaGroup}`)
    modelCooldowns.delete(`${accountId}:${upstreamModel}`)
  }

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
    cooldownSnapshot() {
      const ts = now()
      const active = (map) =>
        Object.fromEntries([...map.entries()].filter(([, until]) => until > ts))
      return {
        groups: active(groupCooldowns),
        models: active(modelCooldowns),
        accounts: active(accountCooldowns),
      }
    },

    async catalog() {
      let view = await callHost('list', {})
      if (!Array.isArray(view?.environments)) throw fail(502, 'gemini_host_protocol_error')
      if (view.payload_state !== 'installed') return { models: [], accounts: [] }
      const payloadMode = view.payload_mode === 'crag_subscription' ? 'crag_subscription' : 'legacy_release'
      if (payloadMode === 'crag_subscription' && cragSubscription?.reconcileEnvironmentSeats) {
        const needSeat = view.environments.filter(
          (environment) =>
            environment?.auth_state === 'authorized' &&
            environment.oauth_imported !== true &&
            environment.auth_method !== 'api_key' &&
            !view.oauth_runtime_issue &&
            typeof environment.id === 'string' &&
            ID.test(environment.id) &&
            environment.models_discovered === true &&
            Array.isArray(environment.models) &&
            environment.models.length > 0 &&
            environment.crag_license?.valid !== true &&
            (!environment.crag_license?.code || environment.crag_license.code === 'license_required'),
        )
        if (needSeat.length) {
          const reconciled = await cragSubscription
            .reconcileEnvironmentSeats(needSeat, { payloadMode })
            .catch(() => ({ boundIds: [] }))
          if (reconciled.boundIds?.length) {
            view = await callHost('list', {})
            if (!Array.isArray(view?.environments)) throw fail(502, 'gemini_host_protocol_error')
            if (view.payload_state !== 'installed') return { models: [], accounts: [] }
          }
        }
      }
      const accounts = []
      const unlicensedAccounts = []
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
          const catalogIndex = indexAccountModelCatalog(environment.account)
          const admission = checkEnvironmentLicense({ ...environment, auth_method: authMethod }, payloadMode)
          if (!admission.ok) {
            unlicensedAccounts.push({
              id: environment.id,
              auth_method: authMethod,
              models,
              catalogIndex,
              denial: admission,
            })
            continue
          }
          accounts.push({
            id: environment.id,
            auth_method: authMethod,
            max_concurrency: normalizeConcurrency(environment.max_concurrency),
            capabilities: accountCapabilities(environment),
            models,
            catalogIndex,
            eligibility: environment.account?.eligibility || null,
            quotas: Array.isArray(environment.account?.quotas) ? environment.account.quotas : [],
            quota_groups: Array.isArray(environment.account?.quota_groups) ? environment.account.quota_groups : [],
          })
        }
      }
      const publicModels = new Map()
      for (const account of accounts) {
        for (const rawId of account.models) {
          const hint = account.catalogIndex?.get(rawId) || null
          const classified = classifyAntigravityModel(rawId, hint?.provider, hint?.quota_group)
          if (!publicModels.has(classified.public_id)) {
            publicModels.set(classified.public_id, {
              id: classified.public_id,
              object: 'model',
              owned_by: classified.owned_by,
            })
          }
        }
      }
      return {
        models: [...publicModels.values()],
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
      allowUnprefixedNonGemini = null,
      onEvent = null,
    }) {
      const gate = apiKeyStore?.acquire?.(apiKeyRecord)
      if (gate && !gate.ok) throw fail(gate.status || 429, gate.code, gate.message)
      const allowUnprefixed = allowUnprefixedNonGemini ?? (apiKeyRecord?.group_type !== 'all')
      const excluded = new Set()
      let reservation = null
      let selected = null
      let legacyRun = null
      let activeInfer = null

      try {
        signal?.throwIfAborted()
        const catalog = await this.catalog()
        const matchedAccounts = []
        for (const account of catalog.accounts) {
          const resolved = resolveUpstreamModel(model, account.models, {
            allowUnprefixedNonGemini: allowUnprefixed,
            catalogIndex: account.catalogIndex,
          })
          if (resolved) matchedAccounts.push({ account, resolved })
        }
        if (!matchedAccounts.length) {
          const unlicensedMatch = (catalog.unlicensedAccounts || []).find((account) =>
            Boolean(
              resolveUpstreamModel(model, account.models, {
                allowUnprefixedNonGemini: allowUnprefixed,
                catalogIndex: account.catalogIndex,
              }),
            ),
          )
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
        const capableAccounts = matchedAccounts.filter(({ account }) =>
          requiredCapabilities.every((cap) => account.capabilities.has(cap)),
        )
        if (!capableAccounts.length) {
          throw fail(
            400,
            'gemini_unsupported_turn',
            'No authorized Gemini environment for this model supports the requested capabilities.',
          )
        }

        const ts = now()
        const scored = capableAccounts.map(({ account, resolved }) => {
          const until = activeCooldownUntil(account, resolved.upstreamModel, resolved.quotaGroup, ts)
          return {
            account,
            resolved,
            cooldownUntil: until,
            candidate: {
              accountId: `gemini:${account.id}`,
              vmId: `gemini:${account.id}`,
              model: resolved.publicId,
              upstreamModel: resolved.upstreamModel,
              quotaGroup: resolved.quotaGroup,
              provider: resolved.provider,
              authMethod: account.auth_method,
              maxConcurrency: normalizeConcurrency(account.max_concurrency),
              priority: account.auth_method === 'api_key' && requiredCapabilities.length ? 1 : 0,
              weight: 1,
              lastUsedAt: 0,
            },
          }
        })
        const uncooled = scored.filter((item) => item.cooldownUntil === 0)
        // Prefer uncooled accounts; if every account is currently in cooldown, fall back to
        // probing the earliest-expiring one so single-account pools and post-reset slots recover.
        const activeList = uncooled.length
          ? uncooled
          : [...scored].sort((a, b) => a.cooldownUntil - b.cooldownUntil)
        const candidates = activeList.map((item) => item.candidate)
        const resolvedByAccountId = new Map(activeList.map((item) => [item.candidate.accountId, item.resolved]))

        let lastError = null
        while (excluded.size < candidates.length) {
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
          const resolved = resolvedByAccountId.get(grant.selected.accountId)
          selected = { ...grant.selected, id, resolved }
          let emittedOutput = false

          try {
            const listed = await callHost('get', { id })
            const proxyId = listed?.proxy_id
            if (typeof proxyId !== 'string' || !ID.test(proxyId)) throw fail(502, 'gemini_host_protocol_error')
            const proxyUrl = resolveProxy ? resolveProxy(proxyId) : undefined
            signal?.throwIfAborted()
            const authMethod = listed?.auth_method === 'api_key' ? 'api_key' : selected.authMethod || 'oauth'
            const rawOutboundBody = targetBodyFor
              ? targetBodyFor(authMethod === 'api_key' ? 'gemini' : 'antigravity', {
                  upstreamModel: resolved.upstreamModel,
                  publicModel: resolved.publicId,
                })
              : geminiBody
            const outboundBody =
              rawOutboundBody && typeof rawOutboundBody === 'object' && 'model' in rawOutboundBody
                ? { ...rawOutboundBody, model: resolved.upstreamModel }
                : rawOutboundBody

            let streamResponse = null
            if (streamHost) {
              const proxySha256 = proxyUrl
                ? crypto.createHash('sha256').update(proxyUrl).digest('hex')
                : undefined
              const res = await streamHost(
                'infer',
                {
                  id,
                  proxy_id: proxyId,
                  proxy_url: proxyUrl,
                  ...(proxySha256 ? { proxy_sha256: proxySha256 } : {}),
                  model: resolved.upstreamModel,
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
              } else {
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
                    model: resolved.upstreamModel,
                    prompt: plainText,
                  })
                  if (typeof started?.run_id !== 'string' || !RUN_ID.test(started.run_id)) {
                    throw fail(502, 'gemini_host_protocol_error')
                  }
                  legacyRun = { id, run_id: started.run_id }
                } else {
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
              }
            } else {
              if (plainText == null) {
                throw fail(400, 'gemini_unsupported_turn', 'This Gemini host transport only supports plain-text turns.')
              }
              const started = await callHost('test-chat', {
                id,
                proxy_id: proxyId,
                proxy_url: proxyUrl,
                model: resolved.upstreamModel,
                prompt: plainText,
              })
              if (typeof started?.run_id !== 'string' || !RUN_ID.test(started.run_id)) {
                throw fail(502, 'gemini_host_protocol_error')
              }
              legacyRun = { id, run_id: started.run_id }
            }

            let collected
            if (streamResponse) {
              collected = await consumeStreamResponse(streamResponse, {
                model: resolved.publicId,
                signal,
                onEvent: (event) => {
                  if (event && event.kind !== 'error') emittedOutput = true
                  onEvent?.(event)
                },
              })
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
              const collector = createGeminiCollector({ fallbackModel: resolved.publicId })
              const emit = (ev) => {
                if (ev && ev.kind !== 'error') emittedOutput = true
                collector.push(ev)
                onEvent?.(ev)
              }
              emit({
                kind: 'start',
                responseId: `resp_${crypto.randomBytes(10).toString('hex')}`,
                model: resolved.publicId,
                usage,
              })
              if (result.text) emit({ kind: 'text', text: result.text })
              emit({ kind: 'stop', finishReason: 'STOP', stopReason: 'stop' })
              emit({ kind: 'usage', usage })
              collected = collector.result()
            }

            clearCooldownOnSuccess(id, resolved.upstreamModel, resolved.quotaGroup)
            recordAccountUsage(apiKeyRecord, resolved.publicId, collected.usage || {})
            poolScheduler?.unitCircuit?.recordSuccess?.(selected.accountId)
            poolScheduler?.lastUsed?.set?.(selected.accountId, now())
            return {
              ...collected,
              account_id: id,
              auth_method: authMethod,
              model: resolved.publicId,
              upstream_model: resolved.upstreamModel,
              provider: resolved.provider,
              quota_group: resolved.quotaGroup,
            }
          } catch (error) {
            if (legacyRun) {
              try {
                await callHost('test-chat-cancel', legacyRun)
              } catch {}
              legacyRun = null
            }
            if (activeInfer) {
              try {
                await callHost('infer-cancel', activeInfer)
              } catch {}
              activeInfer = null
            }
            reservation?.release()
            reservation = null

            const failure = known(error) || error
            const failureCode = failure?.code
            const cancelled = signal?.aborted || failure?.name === 'AbortError' || failureCode === 'ABORT_ERR'

            if (cancelled) {
              poolScheduler?.unitCircuit?.releaseProbe?.(selected.accountId)
              selected = null
              throw failure
            }

            if (NON_CIRCUIT_FAILURES.has(failureCode)) {
              poolScheduler?.unitCircuit?.releaseProbe?.(selected.accountId)
            } else {
              poolScheduler?.unitCircuit?.recordFailure?.(selected.accountId)
            }

            recordFailureCooldown(id, resolved.upstreamModel, resolved.quotaGroup, failure, now())
            lastError = failure
            excluded.add(selected.accountId)
            selected = null

            if (!emittedOutput && FAILOVER_ERRORS.has(failureCode) && excluded.size < candidates.length) {
              continue
            }
            throw failure
          }
        }

        throw lastError || fail(503, 'gemini_operation_busy')
      } finally {
        reservation?.release()
        try {
          apiKeyStore?.release?.(apiKeyRecord)
        } catch {}
      }
    },

    async complete({ model, text, signal, apiKeyRecord, allowUnprefixedNonGemini = null }) {
      const result = await this.stream({
        model,
        geminiBody: { contents: [{ role: 'user', parts: [{ text }] }] },
        requiredCapabilities: [],
        plainText: text,
        signal,
        apiKeyRecord,
        allowUnprefixedNonGemini,
      })
      return {
        text: result.text,
        usage: result.usage,
        account_id: result.account_id,
        auth_method: result.auth_method,
        model: result.model,
        upstream_model: result.upstream_model,
      }
    },
  }
}
