import { readRoutingDocument } from '../core/routing-document.mjs'
import { trackPendingWrite } from '../db/pending-writes.mjs'
import { currentHaRequestContext } from '../core/ha-request-context.mjs'
import { captureHaBillingSnapshot } from '../core/ha-request-billing.mjs'
import { isKubernetesHaMode, isKubernetesMode } from '../core/control-plane-mode.mjs'
/**
 * /v1 protocol handler. URLs, auth, and response envelopes stay with the
 * server wiring; this factory owns convert → pool → Go/Rust hop → client.
 */
import { applyIntercept } from '../core/intercept.mjs'
import { resolveStreamIdleTimeoutMs, inboundBodyLimit, queueKeepaliveDelayMs } from '../core/config.mjs'
import { applyEagerToolStreaming } from './eager-tool-streaming.mjs'
import {
  inboundRefusalDeviceId,
  isRefusalGuardEnabled,
  isUpstreamRefusal,
  refusalFingerprint,
  refusalGuardPolicy,
  refusalPreview,
  refusalPromptSignature,
} from '../core/refusal-guard.mjs'
import { RefusalGuardsRepo } from '../db/repos/refusal-guards-repo.mjs'
import { RefusalDeviceBlocksRepo } from '../db/repos/refusal-device-blocks-repo.mjs'
import { RuntimeSettings as SettingsRepo } from '../db/settings-state.mjs'
import { findAccount } from '../admin/panel-api.mjs'
import { jevScopeWaits, readJevConfig, scopeAccountFromVm } from './jev-intercept.mjs'
import { runProtocolIntercept } from './intercept-gate.mjs'
import {
  toClaudeMessages,
  isClientStream,
  fromClaudeToOpenAIChat,
  fromClaudeToOpenAICompletions,
  fromClaudeToResponses,
  createOpenAIChatStreamState,
  claudeSSELineToOpenAIChatChunks,
  createOpenAICompletionStreamState,
  claudeSSELineToOpenAICompletionChunks,
  createResponsesStreamState,
  claudeSSELineToResponsesEvents,
  createClaudeMessageAssembler,
  applyClaudeSSELineToMessage,
} from './convert.mjs'
import { sanitizeInboundBody, defaultSeedPolicy, callerAutoCompactWindow } from './seed-policy.mjs'
import { fingerprintRequest } from './client-fingerprint.mjs'
import { validateOfficialModel } from './models.mjs'
import { handleCodexImages, handleCodexProtocol, handleCodexSearch } from './handle-codex.mjs'
import { isMultipartFormData, normalizeImageEditBody } from './image-edit-multipart.mjs'
import { readRawBody } from '../http/respond.mjs'
import { disjointOpenaiUsage } from './openai-usage.mjs'
import { costColumnsFromUsage } from '../admin/pricing.mjs'
import { detectInboundPlatform } from './platform-detect.mjs'
import { normalizeCodexRouting } from './codex-route.mjs'
import { applyCodexInboundModelRewrite } from './codex-model-mapping.mjs'
import { hasClaudeCode1mSuffix } from './context-1m.mjs'
import {
  DEFAULT_HEALTH_PROBE,
  isHealthRealBypass,
  isHealthShape,
  synthesizeProtocolResponse,
  formatHealthSse,
  healthUnavailableError,
} from '../admin/health-probe.mjs'
import { resolveInferenceBackend, runApiInference } from '../pool/api-protocol.mjs'
import { classifyClaudeRequestPurpose, prepareClassifierBody, classifierRequestSummary } from './request-purpose.mjs'
import { summarizeBody, redactHeaders, presentedApiKeyForLog } from '../admin/request-log.mjs'
import { reasoningEffortOf, sessionIdForLog } from './log-fields.mjs'
import { ownerScopeFromRequest } from '../admin/resource-owner.mjs'
import { keyScopeFromRequest, vmPoolDenial } from '../admin/key-scope.mjs'
import {
  resolveInferenceEngine,
  resolveOfficialCcInference,
  resolveSlotPersonaPreset,
  slotPersonaModeOverride,
} from '../vm/slot-engine.mjs'
import { isValidVmId } from '../vm/vm-file.mjs'
import {
  makeError,
  mapUpstreamError,
  rewritePoolErrorForClient,
  validateRequestBody,
  mapModelError,
  isClientCancelledResult,
  isIncompleteAssistantMessage,
  finalizeAssembledAssistantHop,
  mergeAssembledAssistantHop,
  incompleteAssistantClientError,
  ErrorType,
  ErrorCode,
} from '../core/errors.mjs'
import { resolveWorkspaceMode, isOfficialClaudeClient } from './workspace-mode.mjs'
import { officialMessagesBody } from './anthropic-messages.mjs'
import { prepareOutboundEnvelope, prepareCliHopBody, prepareOfficialPassthroughBody } from './outbound-attempt.mjs'
import { profileForPreset } from '../identity/official-profiles.mjs'
import { loadVmIdentity, OFFICIAL_CLI_VERSION } from '../identity/vm-identity.mjs'
import { touchTelemetrySession } from '../vm/worker-telemetry.mjs'
import {
  applyCrsIdentityReplace,
  extractCallerSession,
  extractFirstUserIdentity,
  outboundSessionMode,
  resolveInboundIdentity,
  resolveSeatIdentity,
  resolveOutboundSessionId,
  sessionIdFromOutboundBody,
  sessionContextDiscriminator,
} from '../identity/identity-rewrite.mjs'
import {
  clientIp,
  childDeclaredWithoutParent,
  explicitParentSessionId,
  isParentSessionCompanion,
  isShortProbeRequest,
} from '../pool/sticky-router.mjs'
import {
  applyCrsUnofficialPersona,
  detectProxiedOfficialCcFromRoutingFile,
  billingIndexesFromMessages,
  ccEntrypointFromRouting,
  ensureBillingAttribution,
  extractFirstUserText,
  isOfficialClaudeCodeTraffic,
  isProxiedOfficialClaudeCode,
  officialCcPassthroughFromRouting,
  personaHidesUsageFromRoutingFile,
  standingUsageFromRoutingFile,
  personaModeFromRoutingFile,
} from '../identity/crs-persona.mjs'
import { presetFlagEnabled } from '../identity/persona-template.mjs'
import {
  claudeCodeOnlyError,
  claudeCodeOnlyFromRouting,
  isClaudeCodeFamilyRequest,
} from '../identity/claude-code-only.mjs'
import { createDownstreamKeepalive } from './stream-keepalive.mjs'
import {
  buildAnthropicSseError,
  createAnthropicSseErrorRemapper,
  createAnthropicStreamTracker,
  isRecoverableTruncation,
} from './stream-truncation.mjs'
import {
  hidePersonaUsageInSseLine,
  hidePersonaUsageOnMessage,
  personaHideForUnofficial,
  personaHideForCliZero,
} from '../identity/crs-persona-usage.mjs'
import {
  applyCacheTtlToUsage,
  cacheBreakpointsFromRoutingFile,
  pinConversationCacheTtl,
  resolveCacheTtl,
  fillMissingCacheTtl,
  validateCacheBreakpoints,
} from './cache-ttl.mjs'
import { confirmCachePrefix, describeCacheContinuity, formatCacheBreak, prepareCachePrefix } from './cache-prefix.mjs'
import { ensureClaudeWebSearch, shouldInjectClaudeWebSearch } from './web-search.mjs'
import { dispatchStreamInference } from '../transport/kernel-router.mjs'
import { syncClaudeKernelConfigsFromFile } from '../transport/rust-kernel-supervisor.mjs'
import { ensureWorkerCredential } from '../transport/go-worker-client.mjs'
import { formatPoolSelectionSummary } from '../pool/pool-scheduler.mjs'
import { extraHeadersFromLimitError, isAccountQuotaExhausted } from '../pool/quota-window.mjs'
import {
  filterThinkingForAccount,
  recordThinkingOwners,
  thinkingOwners as defaultThinkingOwners,
} from '../pool/thinking-owner.mjs'
import { getVm } from '../vm/vm-registry.mjs'
import { credentialModeFromOauth, isApiKeyMode } from '../oauth/credential-mode.mjs'
import {
  prepareAnthropicRequest,
  enforceCacheLimit,
  rewriteToolNames,
  restoreToolNames,
  restoreToolNamesInSSELine,
  wantsFastMode,
} from './anthropic-policy.mjs'
import { materializeRemoteImageSources } from './images.mjs'
import { applyMinMaxTokens } from './min-max-tokens.mjs'
import { detectWarmupIntercept, formatWarmupSse, warmupMockMessage } from './warmup-intercept.mjs'

export function createHandleProtocol(deps) {
  const json = (...args) => deps.json(...args)
  const writeSSEHeaders = (...args) => deps.writeSSEHeaders(...args)
  const readBody = (...args) => deps.readBody(...args)
  const requireAuth = async (...args) => await deps.requireAuth(...args)
  const cfg = deps.cfg
  const requestLog = deps.requestLog
  const stickyRouter = deps.stickyRouter
  const accountQuota = deps.accountQuota
  const apiKeyStore = deps.apiKeyStore
  const apiScheduler = deps.apiScheduler
  const rejectHaOperation = (res) =>
    json(
      res,
      503,
      makeError({
        type: ErrorType.INVALID_REQUEST,
        code: 'ha_operation_unsupported',
        message: '该操作暂不支持多副本部署',
        status: 503,
      }).body,
    )
  const apiEndpointStore = deps.apiEndpointStore
  const stats = deps.stats
  const routingConfigPath = deps.routingConfigPath
  const getRouting = () => (typeof deps.getRoutingConfig === 'function' ? deps.getRoutingConfig() : deps.routingConfig)
  const getHealthMonitor = () =>
    typeof deps.getHealthMonitor === 'function' ? deps.getHealthMonitor() : deps.healthMonitor
  const getFailoverRunner = () =>
    typeof deps.getFailoverRunner === 'function' ? deps.getFailoverRunner() : deps.failoverRunner
  const thinkingOwnerStore = deps.thinkingOwners || defaultThinkingOwners
  function responseClosed(res) {
    return !!(res?.destroyed || res?.writableEnded || res?.closed)
  }

  function usageForLog(usage, { cacheTtl = null, requestedSpeed = null } = {}) {
    let next = usage
    if (next && cacheTtl) next = applyCacheTtlToUsage(next, cacheTtl)
    if (next && requestedSpeed) next = { ...next, requested_speed: requestedSpeed }
    return disjointOpenaiUsage(next)
  }

  async function attachPricing(
    logBag,
    { managedKey = null, rateMultiplier = 1, bill = false, reservation = null, execution = null } = {},
  ) {
    if (isKubernetesHaMode() && bill && managedKey && reservation?.shared) {
      try {
        let nodeStatus
        if (execution?.requestId && execution?.nodeBinding) {
          try {
            nodeStatus = await deps.readNodeRecoveryStatus?.({
              requestId: execution.requestId,
              nodeBinding: execution.nodeBinding,
            })
          } catch {}
        }
        const settled = await apiKeyStore.recordHaUsage({ reservation, commandId: execution?.requestId, nodeStatus })
        const price = settled.pricing
        Object.assign(logBag, {
          input_cost: price?.input_cost ?? null,
          output_cost: price?.output_cost ?? null,
          cache_read_cost: price?.cache_read_cost ?? null,
          cache_creation_cost: price?.cache_creation_cost ?? null,
          web_search_cost: price?.web_search_cost ?? null,
          total_cost: price?.total_cost ?? null,
          pricing_model: price?.pricing_key ?? 'unpriced',
          price_source: price?.price_source ?? null,
          price_version: price?.price_version ?? null,
          service_tier: price?.service_tier ?? null,
          speed: price?.speed ?? null,
          long_context: price ? (price.long_context ? 1 : 0) : null,
        })
        if (!settled.settled) reservation.billingFailed = true
      } catch (error) {
        reservation.billingFailed = true
        throw error
      }
      return
    }
    const model = logBag.upstream_model || logBag.model
    const image =
      logBag.image_usage || logBag.protocol === 'openai.images'
        ? {
            usage: logBag.image_usage || null,
            model: logBag.image_model || null,
            only: logBag.protocol === 'openai.images',
          }
        : null
    const priced = costColumnsFromUsage(logBag.usage || {}, model, image)
    Object.assign(logBag, priced)
    if (!bill || !managedKey) return
    try {
      await apiKeyStore.recordUsage(managedKey, logBag.usage || {}, {
        model,
        rateMultiplier,
        officialCost: priced.total_cost,
        reservation,
      })
    } catch (error) {
      if (reservation?.shared) {
        // The request executed but its quota settlement is uncertain. Preserve the
        // durable reservation until recovery can establish the result.
        reservation.billingFailed = true
        throw error
      }
    }
  }

  function finishClientCancel(res, result, logBag) {
    // Client cancellation is a lifecycle terminal, not a request error. Keep
    // final_state for audit, but leave error fields empty so the cancelled turn
    // can continue on the same sticky session with an edited request.
    logBag.error_code = null
    logBag.final_state = 'cancelled'
    logBag.error_message = null
    if (responseClosed(res)) return
    if (res.headersSent) res.end()
  }

  function bindClientAbort(req, res) {
    const abortController = new AbortController()
    let settled = false
    const onGone = () => {
      if (settled) return
      if (!abortController.signal.aborted) abortController.abort(new Error('client_aborted'))
    }
    req.once('aborted', onGone)
    res.once('close', onGone)
    return {
      signal: abortController.signal,
      settle() {
        settled = true
        req.off('aborted', onGone)
        res.off('close', onGone)
      },
    }
  }

  function mapProtocolClientError(result, logBag, fallbackCode) {
    const originalCode = result?.body?.error?.code || fallbackCode
    const originalMessage = result?.body?.error?.message || null
    const details = result?.body?.error?.details || {}
    const mapped = rewritePoolErrorForClient(
      mapUpstreamError(result?.status || 503, result?.body, result?.headers || {}),
      result?.body,
    )
    const summary = formatPoolSelectionSummary(details)
    logBag.error_code = originalCode || mapped.body?.error?.code
    logBag.error_message = summary || originalMessage || mapped.body?.error?.message || null
    if (logBag.classifier) {
      logBag.classifier.error = {
        status: result?.status || null,
        type: result?.body?.error?.type || null,
        code: originalCode,
        upstream_code: result?.body?.error?.upstream_code || null,
        request_id: result?.body?.error?.request_id || result?.headers?.['request-id'] || null,
        retry_after: result?.body?.error?.retry_after || result?.headers?.['retry-after'] || null,
      }
    }
    // Pool 529 / pool-wide 429 always carry Retry-After: the runner's wake estimate, floored at 1s.
    // A 503 carries one only when the runner knows a wake (all-rest pool).
    if (Number(result?.retryAfterSec) > 0) {
      mapped.retryAfterSec = Math.max(1, Math.ceil(Number(result.retryAfterSec)))
    }
    return mapped
  }

  function sendMapped(res, mapped) {
    if (mapped.retryAfterSec) res.setHeader?.('retry-after', String(mapped.retryAfterSec))
    return json(res, mapped.status, mapped.body)
  }

  function acceptAssistantHop(result) {
    return finalizeAssembledAssistantHop(result)
  }

  function claudeScopePending() {
    let jev
    try {
      const settings = deps.settings || new SettingsRepo()
      jev = readJevConfig((key, fallback) => settings.get(key, fallback))
    } catch {
      jev = readJevConfig()
    }
    return jevScopeWaits(jev, 'claude')
  }

  async function applyProtocolIntercept({ req, inbound, body, fp, logBag, requestId, res, account = null }) {
    const official =
      isOfficialClaudeCodeTraffic(req.headers, inbound) ||
      isOfficialClaudeClient(fp.client_class) ||
      (detectProxiedOfficialCcFromRoutingFile(routingConfigPath) && isProxiedOfficialClaudeCode(inbound, req.headers))
    let jev
    try {
      const settings = deps.settings || new SettingsRepo()
      jev = readJevConfig((key, fallback) => settings.get(key, fallback))
    } catch {
      jev = readJevConfig()
    }
    const decision = await runProtocolIntercept({
      inbound,
      body,
      headers: req.headers,
      official,
      zeroInject: isZeroInjectMode(),
      distillRules: cfg.distill,
      policy: refusalPolicy(),
      jev,
      repo: refusalRepo(),
      devices: deviceRepo(),
      requestId,
      account,
    })
    if (!decision || decision.action !== 'block') {
      if (decision?.intercept) logBag.intercept = decision.intercept
      return false
    }
    stats.errors++
    logBag.via = decision.via
    logBag.attempt_count = 0
    logBag.final_state = decision.final_state
    logBag.error_code = decision.error?.body?.error?.code || null
    logBag.error_message = decision.errorMessage || decision.error?.body?.error?.message || null
    logBag.intercept = decision.intercept || null
    json(res, decision.error.status, decision.error.body)
    return true
  }

  function isZeroInjectMode() {
    const routing = getRouting() || {}
    const inject = String(routing?.compatibility?.persona_inject || '')
      .trim()
      .toLowerCase()
    const preset = String(routing?.compatibility?.persona_preset || '')
      .trim()
      .toLowerCase()
    return inject === 'zero' || preset === 'zero'
  }

  function refusalRepo() {
    if (deps.refusalGuards) return deps.refusalGuards
    try {
      return new RefusalGuardsRepo()
    } catch {
      return null
    }
  }

  function refusalEnabled() {
    try {
      const settings = deps.settings || new SettingsRepo()
      return isRefusalGuardEnabled((key, fallback) => settings.get(key, fallback))
    } catch {
      return isRefusalGuardEnabled()
    }
  }

  function deviceRepo() {
    if (deps.refusalDevices) return deps.refusalDevices
    try {
      return new RefusalDeviceBlocksRepo()
    } catch {
      return null
    }
  }

  async function banRefusalDevice(deviceId, { requestId, fingerprint, reason }) {
    if (!deviceId) return
    try {
      await deviceRepo()?.block?.({ deviceId, requestId, fingerprint, reason })
    } catch {
      /* the prompt block still stands */
    }
  }

  function refusalPolicy() {
    try {
      const settings = deps.settings || new SettingsRepo()
      return refusalGuardPolicy((key, fallback) => settings.get(key, fallback))
    } catch {
      return refusalGuardPolicy()
    }
  }

  async function rememberRefusal({ inbound, body, headers, result, logBag, requestId }) {
    if (!refusalEnabled()) return
    const contentRefusal = isUpstreamRefusal(result, logBag)
    const timed = result?.policy?.rememberRefusal === true
    if (!contentRefusal && !timed) return
    const repo = refusalRepo()
    if (!repo) return
    const fingerprint = refusalFingerprint(body, inbound)
    try {
      const ttl = Number(result?.policy?.refusalTtlMs) || 0
      await repo.remember({
        fingerprint,
        model: body?.model || inbound?.model || '',
        requestId,
        errorMessage: logBag.error_message || result?.body?.error?.message || null,
        preview: refusalPreview(body, inbound),
        expiresAt: contentRefusal || ttl <= 0 ? null : new Date(Date.now() + ttl).toISOString(),
        signature: refusalPromptSignature(inbound, body),
      })
    } catch {
      return
    }
    if (!contentRefusal || !refusalPolicy().device_block_enabled) return
    await banRefusalDevice(inboundRefusalDeviceId({ inbound, body, headers }), {
      requestId,
      fingerprint,
      reason: 'refusal_guard',
    })
  }

  async function streamAndAssembleClaudeMessage({
    candidate,
    body,
    reqHeaders,
    timeoutMs,
    idleTimeoutMs,
    signal,
    deliveryMode,
    toolNames = {},
    want1m = false,
    preserveCacheBreakpoints = false,
    cliHop = false,
    repaired = false,
    requestContext = null,
    routing = {},
    noGoFallback = false,
    accountObservation = null,
    onExecutionStart = candidate.bindExecution,
    onExecutionEnd = candidate.completeExecution,
    onEnvelope = null,
    onOutboundHeaders = null,
  }) {
    const assembler = createClaudeMessageAssembler()
    const workerResult = await dispatchStreamInference({
      exec: candidate.exec,
      onExecutionStart,
      onExecutionEnd,
      body,
      reqHeaders,
      timeoutMs,
      idleTimeoutMs,
      identity: loadVmIdentity(candidate.exec),
      signal,
      deliveryMode,
      want1m,
      routing,
      preserveCacheBreakpoints,
      cliHop,
      repaired,
      requestContext,
      slotWaitMs: candidate.slotWaitMs,
      noGoFallback,
      ensureCredential: async (exec, opts) => await ensureWorkerCredential(exec, opts),
      onEnvelope,
      onOutboundHeaders,
      onEvent: async (line) => {
        if (/response_headers/.test(String(line))) return
        applyClaudeSSELineToMessage(restoreToolNamesInSSELine(line, toolNames), assembler)
      },
    })
    Object.assign(workerResult, mergeAssembledAssistantHop(workerResult, assembler.message))
    workerResult.accountObservation = accountObservation
    if (workerResult?.body) {
      workerResult.body = restoreToolNames(workerResult.body, toolNames)
    }
    return acceptAssistantHop(workerResult)
  }

  async function handleProtocol(req, res, protocol, pathName) {
    const admission = { lease: null }
    try {
      return await handleProtocolRequest(req, res, protocol, pathName, admission)
    } catch (error) {
      if (admission.executionStarted && admission.lease?.shared && !admission.lease.settled) {
        admission.lease.billingFailed = true
      }
      throw error
    } finally {
      if (!admission.lease?.billingFailed && !admission.lease?.executionUncertain) await admission.lease?.release?.()
    }
  }

  async function observeExecution(req, admission, execution) {
    await deps.onExecutionState?.(req, execution)
    if (!execution?.requestId) return
    admission.pendingExecutions ||= new Set()
    if (execution.ended === true) admission.pendingExecutions.delete(execution.requestId)
    else if (execution.started === true) {
      admission.executionStarted = true
      admission.pendingExecutions.add(execution.requestId)
    }
    if (admission.lease?.shared) admission.lease.executionUncertain = admission.pendingExecutions.size > 0
  }

  function executionHooks(req, admission, candidate = {}, billingSnapshot = null) {
    if (!deps.onExecutionState && !admission.lease?.shared && !candidate.bindExecution) return {}
    return {
      onExecutionStart: async (execution) => {
        await observeExecution(req, admission, { ...execution, started: true, ended: false })
        return await candidate.bindExecution?.(billingSnapshot ? { ...execution, billingSnapshot } : execution)
      },
      onExecutionEnd: async (execution) => {
        await candidate.completeExecution?.(execution)
        await observeExecution(req, admission, execution)
      },
    }
  }

  async function reserveManagedKey(req, res) {
    if (!req.apiKeyRecord) return { ok: true }
    const gate = await apiKeyStore.reserve(req.apiKeyRecord)
    if (!gate.ok) {
      stats.errors++
      json(
        res,
        gate.status,
        makeError({
          type: gate.status === 429 ? ErrorType.RATE_LIMIT : ErrorType.PERMISSION,
          code: gate.code,
          message: gate.message,
          status: gate.status,
          details: gate.detail || undefined,
        }).body,
      )
    } else if (gate.record) {
      req.apiKeyRecord = gate.record
    }
    return gate
  }

  async function handleProtocolRequest(req, res, protocol, pathName, admission) {
    const logCtx = requestLog.start(req, { protocol, pathName })
    if (isKubernetesHaMode()) logCtx.request_id = currentHaRequestContext().requestId
    res._kinRequestId = logCtx.request_id
    // Registers its own 'finish' listener first so status/headers are final when finish() runs.
    requestLog.tapResponse?.(logCtx, res)
    const logBag = {
      protocol,
      model: null,
      stream: false,
      inbound_body: null,
      inbound_summary: null,
      hop_meta: null,
      upstream_status: null,
      outbound_body: null,
      outbound_headers: null,
      outbound_headers_source: 'unavailable',
      worker_envelope_headers: null,
      outbound_summary: null,
      cache_continuity: null,
      vm_id: null,
      account_id: null,
      workspace: 'client',
      has_tools: null,
      usage: null,
      error_code: null,
      error_message: null,
      via: 'go-worker-pool',
      attempt_count: null,
      final_state: null,
      final_account_id: null,
      requested_model: null,
      upstream_model: null,
      first_token_ms: null,
      stop_reason: null,
      session_id: null,
      reasoning_effort: null,
      outbound_session_id: null,
    }
    res.on('finish', () =>
      trackPendingWrite(
        (async () => {
          try {
            const groupId = req.apiKeyRecord?.group_id ?? 1
            await requestLog.finish(logCtx, {
              status: res.statusCode || 0,
              api_key_kind: req.apiKeyKind || null,
              api_key_id: req.apiKeyRecord?.id || null,
              user_id: req.apiKeyRecord?.user_id ?? null,
              group_id: groupId,
              rate_multiplier: await deps.groupsRepo.rateMultiplier(groupId),
              ...logBag,
            })
          } catch (error) {
            throw error
          }
        })(),
      ),
    )
    if (!(await requireAuth(req, res))) {
      logBag.error_code = req.authError?.code || ErrorCode.INVALID_API_KEY
      logBag.error_message = req.authError?.message || 'Invalid credentials'
      logBag.api_key_presented = presentedApiKeyForLog(req.presentedApiKey)
      return
    }

    let inbound
    try {
      inbound = await readBody(req, inboundBodyLimit(getRouting(), cfg.limits.max_body_bytes))
    } catch (error) {
      stats.errors++
      logBag.error_code = error?.body?.error?.code || ErrorCode.INVALID_JSON
      logBag.error_message = error?.body?.error?.message || String(error?.message || error)
      if (error?.body?.error) return json(res, error.status || 400, error.body)
      return json(
        res,
        400,
        makeError({
          type: ErrorType.INVALID_REQUEST,
          code: ErrorCode.INVALID_JSON,
          message: String(error?.message || error),
          status: 400,
        }).body,
      )
    }
    logBag.inbound_body = inbound
    logBag.inbound_summary = summarizeBody(inbound)
    logBag.model = inbound?.model || null
    logBag.requested_model = inbound?.model || null
    logBag.stream = isClientStream(inbound, req.headers)
    logBag.has_tools = Array.isArray(inbound?.tools) && inbound.tools.length > 0
    logBag.session_id = sessionIdForLog(extractCallerSession({ inbound, headers: req.headers }))
    logBag.reasoning_effort = reasoningEffortOf(inbound)

    if (
      isKubernetesHaMode() &&
      (!['anthropic.messages', 'openai.chat', 'openai.completions', 'openai.responses'].includes(protocol) ||
        resolveInferenceBackend(req) === 'api' ||
        detectInboundPlatform(inbound?.model).platform === 'openai')
    )
      return rejectHaOperation(res)

    const fp = fingerprintRequest(req, inbound)
    // Before the health probe: its synthesized or fail-closed replies would otherwise answer
    // probe-shaped third-party traffic, and with the switch on no probe is answered at all.
    // Official Claude Code only ever speaks Messages, so other inbound protocols on a Claude
    // model are third-party by construction. Master-key pinned calls are the panel's own
    // test chat and health monitor, not inbound clients.
    const routingNow = getRouting()
    const panelDiagnostics = req.apiKeyKind === 'master' && isValidVmId(String(req.headers['x-kin-vm'] || '').trim())
    if (
      claudeCodeOnlyFromRouting(routingNow) &&
      !panelDiagnostics &&
      detectInboundPlatform(inbound?.model).platform === 'anthropic' &&
      (protocol !== 'anthropic.messages' ||
        isHealthShape(req.headers, inbound, getHealthMonitor()?.getConfig?.() || DEFAULT_HEALTH_PROBE, protocol) ||
        !isClaudeCodeFamilyRequest(req.headers, inbound, { routing: routingNow }))
    ) {
      stats.errors++
      const errorResult = claudeCodeOnlyError()
      logBag.error_code = ErrorCode.CLAUDE_CODE_ONLY
      logBag.error_message = errorResult.body?.error?.message || null
      return json(res, errorResult.status, errorResult.body)
    }
    const healthDecision = getHealthMonitor()?.decide?.(req.headers, inbound, protocol)
    if (healthDecision?.action === 'fail') {
      stats.requests++
      stats.by_route[protocol] = (stats.by_route[protocol] || 0) + 1
      logBag.via = healthDecision.via
      logBag.attempt_count = 0
      logBag.vm_id = healthDecision.snapshot?.vm_id || null
      logBag.usage = { input_tokens: 0, output_tokens: 0 }
      logBag.stop_reason = null
      logBag.final_state = healthDecision.via
      stats.errors++
      const errBody = healthUnavailableError(healthDecision.snapshot, logCtx.request_id)
      logBag.error_code = ErrorCode.HEALTH_UNAVAILABLE
      logBag.error_message = errBody.error?.message || 'health probe unavailable'
      return json(res, 503, { error: errBody.error })
    }
    if (healthDecision?.action === 'cache') {
      const hpCfg = getHealthMonitor().getConfig()
      const cached = synthesizeProtocolResponse(protocol, inbound, healthDecision.snapshot || {}, hpCfg)
      if (cached) {
        stats.requests++
        stats.by_route[protocol] = (stats.by_route[protocol] || 0) + 1
        logBag.via = healthDecision.via
        logBag.attempt_count = 0
        logBag.vm_id = healthDecision.snapshot?.vm_id || null
        logBag.usage = healthDecision.snapshot?.body?.usage || { input_tokens: 0, output_tokens: 0 }
        logBag.stop_reason = healthDecision.snapshot?.body?.stop_reason || 'end_turn'
        logBag.final_state = healthDecision.via
        if (isClientStream(inbound, req.headers)) {
          writeSSEHeaders(res)
          res.write(formatHealthSse(protocol, inbound, healthDecision.snapshot || {}, hpCfg))
          return res.end()
        }
        return json(res, 200, cached)
      }
    }
    const workspace = resolveWorkspaceMode(req, inbound, fp.client_class)
    if (workspace !== 'client') {
      stats.errors++
      logBag.error_code = 'vm_workspace_removed'
      logBag.error_message = 'VM workspace inference was removed; use client workspace'
      return json(
        res,
        400,
        makeError({
          type: ErrorType.INVALID_REQUEST,
          code: 'vm_workspace_removed',
          message:
            'x-kin-workspace: vm is no longer supported. Go slot workers only relay Messages; tools execute on the client.',
          status: 400,
        }).body,
      )
    }

    const autoCompactWindow = callerAutoCompactWindow(inbound)
    let ctx = {
      path: pathName,
      protocol,
      body: sanitizeInboundBody(inbound, defaultSeedPolicy()),
      headers: { ...req.headers },
      autoCompactWindow,
    }
    ctx = applyIntercept(cfg.intercept.rules, 'before_convert', ctx)
    const bodyCheck = validateRequestBody(protocol, ctx.body)
    if (!bodyCheck.ok) {
      stats.errors++
      const errorResult = bodyCheck.errorResult
      logBag.error_code = errorResult.body?.error?.code || 'invalid_request'
      logBag.error_message = errorResult.body?.error?.message || null
      return json(res, errorResult.status, errorResult.body)
    }
    const inferenceBackend = resolveInferenceBackend(req)
    let want1m = hasClaudeCode1mSuffix(inbound?.model) || hasClaudeCode1mSuffix(ctx.body?.model)
    const modelRewrite = applyCodexInboundModelRewrite(ctx.body, getRouting() || {})
    if (!modelRewrite.ok) {
      stats.errors++
      const errorResult = makeError({
        type: ErrorType.INVALID_REQUEST,
        code: modelRewrite.code || 'codex_model_mapping_invalid',
        message: modelRewrite.message,
        status: 400,
        param: 'model',
      })
      logBag.error_code = errorResult.body?.error?.code || modelRewrite.code
      logBag.error_message = errorResult.body?.error?.message || null
      return json(res, errorResult.status, errorResult.body)
    }
    if (modelRewrite.mapped) {
      ctx = { ...ctx, body: modelRewrite.body }
      logBag.upstream_model = modelRewrite.upstreamModel || null
    }
    const platform = detectInboundPlatform(ctx.body?.model)
    // A model mapping must not redirect an otherwise supported Claude request
    // into the unfenced Codex backend after the initial capability check.
    if (isKubernetesHaMode() && platform.ok && platform.platform !== 'anthropic') return rejectHaOperation(res)
    if (!platform.ok) {
      stats.errors++
      const errorResult = makeError({
        type: ErrorType.INVALID_REQUEST,
        code: platform.code || 'model_not_supported',
        message: platform.message,
        status: 400,
        param: 'model',
      })
      logBag.error_code = errorResult.body?.error?.code || 'model_not_supported'
      logBag.error_message = errorResult.body?.error?.message || null
      return json(res, errorResult.status, errorResult.body)
    }
    const keyScope = await keyScopeFromRequest(req)
    const poolDenial = vmPoolDenial(keyScope)
    if (poolDenial) {
      stats.errors++
      const errorResult = makeError({
        type: ErrorType.PERMISSION,
        code: ErrorCode.VM_POOL_UNAVAILABLE,
        message: poolDenial.message,
        status: 403,
      })
      logBag.error_code = ErrorCode.VM_POOL_UNAVAILABLE
      logBag.error_message = errorResult.body?.error?.message || null
      return json(res, 403, errorResult.body)
    }
    if (keyScope.group_type !== 'all' && keyScope.group_type !== platform.platform) {
      stats.errors++
      const errorResult = makeError({
        type: ErrorType.PERMISSION,
        code: ErrorCode.KEY_GROUP_MISMATCH,
        message: `此密钥仅可调用 ${keyScope.group_type}`,
        status: 403,
      })
      logBag.error_code = ErrorCode.KEY_GROUP_MISMATCH
      logBag.error_message = errorResult.body?.error?.message || null
      return json(res, 403, errorResult.body)
    }
    // Codex returns before conversion. Distill does not apply to OpenAI platform models; the rest
    // of the gate scans them only when jev.openai_platform_enabled is on.
    if (
      platform.platform !== 'openai' &&
      protocol === 'anthropic.messages' &&
      getHealthMonitor()?.getConfig?.()?.intercept_warmup === true
    ) {
      const warmupKind = detectWarmupIntercept(inbound, { userAgent: req.headers['user-agent'] || '' })
      if (warmupKind) {
        stats.requests++
        stats.by_route[protocol] = (stats.by_route[protocol] || 0) + 1
        const mock = warmupMockMessage(warmupKind, inbound?.model)
        logBag.via = 'warmup-intercept'
        logBag.attempt_count = 0
        logBag.usage = mock.usage
        logBag.stop_reason = mock.stop_reason
        logBag.final_state = 'warmup-intercept'
        if (isClientStream(inbound, req.headers)) {
          writeSSEHeaders(res)
          res.write(formatWarmupSse(warmupKind, inbound?.model))
          return res.end()
        }
        return json(res, 200, mock)
      }
    }
    if (await applyProtocolIntercept({ req, inbound, body: ctx.body, fp, logBag, requestId: logCtx.request_id, res })) {
      return
    }
    if (platform.platform === 'openai') {
      const gate = await reserveManagedKey(req, res)
      if (!gate.ok) return
      admission.lease = gate
      const runCodex = async (options) => {
        const output = await handleCodexProtocol({
          ...options,
          onExecutionState:
            deps.onExecutionState || gate.shared
              ? (_req, execution) => observeExecution(req, admission, execution)
              : undefined,
        })
        await attachPricing(logBag, {
          managedKey: req.apiKeyRecord,
          reservation: gate,
          rateMultiplier: await deps.groupsRepo.rateMultiplier(req.apiKeyRecord?.group_id ?? 1),
          bill: !!req.apiKeyRecord && logBag.final_state === 'verified',
        })
        return output
      }
      const routing = getRouting() || {}
      const codexSticky = {
        requestStartedAt: logCtx.t0,
        stickyRouter,
        sessions: accountQuota?.sessions || null,
        body: ctx.body,
        ownerScope: await ownerScopeFromRequest(req, apiKeyStore?.users),
      }
      // Account scope needs the slot, so the Codex hop runs the same gate again
      // once a candidate is claimed. Without a scope the pre-hop verdict stands.
      const accountGate = async (account) =>
        await applyProtocolIntercept({
          req,
          inbound,
          body: ctx.body,
          fp,
          logBag,
          requestId: logCtx.request_id,
          res,
          account,
        })
      if (protocol === 'anthropic.messages') {
        const codex = normalizeCodexRouting(routing.codex)
        return await runCodex({
          req,
          res,
          protocol,
          ctx,
          inbound,
          logBag,
          stats,
          json,
          writeSSEHeaders,
          routing: {
            ...routing,
            codex: {
              ...codex,
              protocols: {
                ...codex.protocols,
                'anthropic.messages': { mode: 'convert', enabled: true },
              },
              convert: { ...codex.convert, anthropic_to_codex: true },
            },
          },
          projectRoot: cfg.paths.project,
          captureOutbound: logCtx.capture_outbound === true,
          accountGate,
          ops: deps.codexOps || {},
          ...codexSticky,
        })
      }
      return await runCodex({
        req,
        res,
        protocol,
        ctx,
        inbound,
        logBag,
        stats,
        json,
        writeSSEHeaders,
        routing,
        projectRoot: cfg.paths.project,
        captureOutbound: logCtx.capture_outbound === true,
        accountGate,
        ops: deps.codexOps || {},
        ...codexSticky,
      })
    }
    if (protocol === 'openai.responses') {
      stats.errors++
      logBag.error_code = 'protocol_not_allowed'
      return json(
        res,
        400,
        makeError({
          type: ErrorType.INVALID_REQUEST,
          code: 'protocol_not_allowed',
          message: 'Claude models are not accepted on /v1/responses',
          status: 400,
          param: 'model',
        }).body,
      )
    }
    if (inferenceBackend !== 'api') {
      const modelCheck = validateOfficialModel(ctx.body?.model)
      if (!modelCheck.ok) {
        stats.errors++
        const errorResult = mapModelError(modelCheck)
        logBag.error_code = errorResult.body?.error?.code || 'model_not_supported'
        logBag.error_message = errorResult.body?.error?.message || null
        return json(res, errorResult.status, errorResult.body)
      }
      want1m = want1m || !!modelCheck.want1m
      ctx.body = { ...ctx.body, model: modelCheck.model }
    }

    const hdrRewrite = String(req.headers['x-kin-rewrite'] || '') === '1'
    const rewriteEnabled = cfg.rewrite.enabled || hdrRewrite
    const officialInbound =
      isOfficialClaudeCodeTraffic(req.headers, inbound) ||
      (detectProxiedOfficialCcFromRoutingFile(routingConfigPath) && isProxiedOfficialClaudeCode(inbound, req.headers))
    const converted = toClaudeMessages(protocol, ctx.body, {
      rewrite: rewriteEnabled,
      model_map: false,
      strict_passthrough: String(req.headers['x-kin-strict-passthrough'] || '') === '1',
      preserve_content_shape: officialInbound,
    })
    stats.requests++
    stats.by_route[protocol] = (stats.by_route[protocol] || 0) + 1
    if (converted.mode === 'passthrough') stats.passthrough++
    else if (converted.mode === 'rewrite') stats.rewrite++
    else stats.convert++

    ctx = applyIntercept(cfg.intercept.rules, 'before_upstream', { ...ctx, body: converted.claude })
    const officialTraffic = officialInbound
    const requestContext = classifyClaudeRequestPurpose(inbound, { officialTraffic })
    if (requestContext) {
      logBag.classifier = classifierRequestSummary(inbound, ctx.body, requestContext)
      try {
        ctx.body = prepareClassifierBody(ctx.body)
        logBag.classifier = classifierRequestSummary(inbound, ctx.body, requestContext)
      } catch (error) {
        if (!error.body?.error) throw error
        stats.errors++
        logBag.error_code = error.body.error.code
        logBag.error_message = error.body.error.message
        return json(res, error.status, error.body)
      }
    } else ctx.body = applyMinMaxTokens(ctx.body, getRouting()?.compatibility?.min_max_tokens)
    if (!requestContext && officialTraffic && officialCcPassthroughFromRouting(getRouting())) {
      try {
        validateCacheBreakpoints(ctx.body)
      } catch (error) {
        if (!error.body?.error) throw error
        stats.errors++
        logBag.error_code = error.body.error.code
        logBag.error_message = error.body.error.message
        return json(res, error.status, error.body)
      }
    }

    if (await applyProtocolIntercept({ req, inbound, body: ctx.body, fp, logBag, requestId: logCtx.request_id, res })) {
      return
    }
    const officialClient = isOfficialClaudeClient(fp.client_class)
    const callerSession = extractCallerSession({ inbound, body: ctx.body, headers: req.headers })
    const firstUserText = extractFirstUserText(ctx.body?.messages) || extractFirstUserText(inbound?.messages)
    // Seed identity skips a leading <system-reminder>; firstUserText stays billing-only.
    const firstUserIdentity =
      extractFirstUserIdentity(ctx.body?.messages) || extractFirstUserIdentity(inbound?.messages)
    const clientDiscriminator = sessionContextDiscriminator({
      clientIp: clientIp(req),
      userAgent: req.headers['user-agent'] || '',
      apiKeyId: req.apiKeyRecord?.id ?? '',
    })
    const sessionMode = outboundSessionMode(getRouting())
    const sessionContext = {
      officialClient: officialTraffic,
      clientDiscriminator,
      firstUserIdentity,
      mode: sessionMode,
      routing: getRouting(),
    }
    // Pool identity comes from inbound metadata.user_id (or an explicit device_id),
    // read before outbound cleaning. API key never scopes it.
    const inboundIdentity = resolveInboundIdentity({ inbound, body: ctx.body, headers: req.headers })
    const stickyDeviceId = inboundIdentity.deviceId
    logBag.inbound_device_id = sessionIdForLog(stickyDeviceId)
    if (childDeclaredWithoutParent(inbound, req.headers)) {
      stats.errors++
      logBag.error_code = 'family_relation_required'
      logBag.error_message = 'Child request is missing parent or root session'
      return json(
        res,
        400,
        makeError({
          type: ErrorType.INVALID_REQUEST,
          code: 'family_relation_required',
          message: 'Child request is missing parent or root session',
          status: 400,
        }).body,
      )
    }
    const isProbe = isParentSessionCompanion(inbound) || isParentSessionCompanion(ctx.body)
    // One-shot test calls (sub2api account test, new-api channel test) keep their
    // sticky identity but never hold a session seat the main conversation needs.
    const seatless = isProbe || isShortProbeRequest(inbound)
    // Seat = this client session. Same device, other session = other slot.
    const seatKey = seatless
      ? null
      : resolveSeatIdentity({ inbound, body: ctx.body, headers: req.headers, clientIp: clientIp(req) }).key
    const sessionKeys = stickyRouter?.sessionPoolKeys
      ? await (stickyRouter.shared ? stickyRouter.sessionPoolKeysShared : stickyRouter.sessionPoolKeys).call(
          stickyRouter,
          req,
          inbound,
          {
            sessionId: inboundIdentity.sessionId,
            deviceId: stickyDeviceId,
            migrate: !isProbe,
          },
        )
      : {
          stickyKey: stickyRouter?.extractPoolKey?.(req, inbound, { platform: 'anthropic' }) || null,
          stickyKeys: stickyRouter?.collectPoolKeys?.(req, inbound, { platform: 'anthropic' }) || [],
        }
    const stickyKey = sessionKeys.stickyKey || null
    const stickyKeys = sessionKeys.stickyKeys || []
    const deviceKey = stickyDeviceId ? stickyRouter?.canonicalDeviceKey?.(stickyDeviceId) || null : null
    const parentSession = explicitParentSessionId(inbound, req.headers)
    const familySession = parentSession || callerSession
    const familyTrusted =
      !!parentSession || (!!inboundIdentity.sessionId && familySession === inboundIdentity.sessionId)
    const familyKey = !familySession
      ? null
      : stickyRouter?.familyPoolKey
        ? await (stickyRouter.shared ? stickyRouter.familyPoolKeyShared : stickyRouter.familyPoolKey).call(
            stickyRouter,
            req,
            familySession,
            { trusted: familyTrusted },
          )
        : stickyRouter?.familyKey?.(req, familySession, 'anthropic') || null
    const familyVmId = familyKey ? stickyRouter?.resolve?.(familyKey)?.vmId || null : null
    const stickyBound =
      stickyKey && typeof stickyRouter?.resolve === 'function' ? stickyRouter.resolve(stickyKey) : null
    const outboundSessionId = resolveOutboundSessionId(callerSession, {
      ...sessionContext,
      accountId: stickyBound?.accountId || '',
      boundSessionId: stickyBound?.sessionId || '',
      boundAccountId: stickyBound?.accountId || '',
      boundVmId: stickyBound?.vmId || '',
      vmId: stickyBound?.vmId || '',
      epoch: 'pending',
    })
    const requestedCacheTtl = pinConversationCacheTtl(
      stickyKey || callerSession || outboundSessionId,
      resolveCacheTtl({ headers: req.headers, body: inbound, routingFile: routingConfigPath }),
    )
    let cacheTtl = requestedCacheTtl
    let preserveCacheBreakpoints = false
    const cacheBreakpoints = cacheBreakpointsFromRoutingFile(routingConfigPath)
    const openaiCompat = String(protocol || '').startsWith('openai.')
    try {
      if (!isKubernetesHaMode())
        await syncClaudeKernelConfigsFromFile(cfg.paths?.project, routingConfigPath)?.publication
    } catch (error) {
      if (
        error?.publicationFinished === true &&
        error?.executionUncertain !== true &&
        error?.vmOperationUncertain !== true
      )
        throw error
      admission.executionStarted = true
      if (admission.lease?.shared) admission.lease.executionUncertain = true
      await observeExecution(req, admission, { started: true, ended: false, reason: 'remote_publication_unknown' })
      throw error
    }
    const personaMode = personaModeFromRoutingFile(routingConfigPath)
    if (!requestContext && !officialClient && !officialTraffic) {
      ctx.body = ensureClaudeWebSearch(ctx.body, {
        enabled: shouldInjectClaudeWebSearch({
          officialClient: officialTraffic,
          clientClass: fp.client_class,
          headers: req.headers,
          body: inbound,
        }),
      })
    }
    // After OpenAI→Anthropic conversion so function tools already have input_schema;
    // leftover OpenAI-shaped tools are still marked (rewrite / mixed inbound).
    ctx.body = applyEagerToolStreaming(ctx.body, getRouting())
    const personaIn = ctx.body
    if (!requestContext)
      ctx.body = applyCrsUnofficialPersona(ctx.body, {
        officialClient: officialTraffic,
        routingFile: routingConfigPath,
        headers: req.headers,
        sessionId: outboundSessionId,
        model: ctx.body?.model,
        cliVersion: OFFICIAL_CLI_VERSION,
      })
    let personaHideTokens = requestContext
      ? 0
      : personaHideForUnofficial(personaIn, ctx.body, {
          officialClient: officialTraffic,
          mode: personaMode,
          hides: personaHidesUsageFromRoutingFile(routingConfigPath),
          standing: standingUsageFromRoutingFile(routingConfigPath),
        })

    if (
      inferenceBackend === 'api' &&
      !requestContext &&
      officialTraffic &&
      !officialCcPassthroughFromRouting(getRouting() || {})
    ) {
      ctx.body = applyCrsUnofficialPersona(ctx.body, {
        officialClient: false,
        forceConfigured: true,
        routingFile: routingConfigPath,
        headers: req.headers,
        sessionId: outboundSessionId,
        model: ctx.body?.model,
        cliVersion: OFFICIAL_CLI_VERSION,
      })
      personaHideTokens = personaHideForUnofficial(personaIn, ctx.body, {
        officialClient: false,
        mode: personaMode,
        hides: personaHidesUsageFromRoutingFile(routingConfigPath),
        standing: standingUsageFromRoutingFile(routingConfigPath),
      })
    }
    if (inferenceBackend === 'api') {
      // API 直连走平台端点，不经过槽位；门禁与 api-kernel hop 同位，勿提前于 credential/intercept 链
      if ((await ownerScopeFromRequest(req, apiKeyStore?.users)).type !== 'platform') {
        stats.errors++
        const errorResult = makeError({
          type: ErrorType.PERMISSION,
          code: ErrorCode.API_BACKEND_FORBIDDEN,
          message: '租户密钥只能调用自己名下的槽位',
          status: 403,
        })
        logBag.error_code = ErrorCode.API_BACKEND_FORBIDDEN
        logBag.error_message = errorResult.body?.error?.message || null
        return json(res, 403, errorResult.body)
      }
      const gate = await reserveManagedKey(req, res)
      if (!gate.ok) return
      admission.lease = gate
      const managedKey = req.apiKeyRecord || null
      const clientAbort = bindClientAbort(req, res)
      const clientStream = isClientStream(inbound, req.headers)
      const requestedDelivery = String(
        req.headers['x-kin-delivery'] || getRouting()?.failover?.delivery_mode || 'realtime',
      )
      // Worker hop stays realtime unless the caller asked for verified.
      // stream:false only changes the client response shape (assembled JSON).
      const deliveryMode = requestedDelivery === 'verified' ? 'verified' : 'realtime'
      logBag.via = 'api-kernel'
      let result
      try {
        result = await runApiInference({
          ...executionHooks(req, admission),
          req,
          res,
          cfg,
          scheduler: apiScheduler,
          store: apiEndpointStore,
          protocol,
          inbound,
          convertedBody: ctx.body,
          clientStream,
          deliveryMode,
          signal: clientAbort.signal,
          timeoutMs: cfg.limits.upstream_timeout_ms,
          personaHideTokens,
          cacheTtl,
          requestContext,
          converters: {
            createClaudeMessageAssembler,
            applyClaudeSSELineToMessage,
            createOpenAIChatStreamState,
            claudeSSELineToOpenAIChatChunks,
            createOpenAICompletionStreamState,
            claudeSSELineToOpenAICompletionChunks,
            createResponsesStreamState,
            claudeSSELineToResponsesEvents,
            hidePersonaUsageInSseLine,
            writeSSEHeaders,
          },
        })
      } finally {
        clientAbort.settle()
      }
      // The api backend forwards the converted body untouched: its session is the outbound one.
      logBag.outbound_session_id = sessionIdForLog(sessionIdFromOutboundBody(ctx.body) || logBag.session_id)
      logBag.account_id = result?.accountId || null
      logBag.final_account_id = result?.accountId || null
      logBag.upstream_status = result?.status ?? null
      logBag.usage = usageForLog(result?.body?.usage || result?.usage || null, { cacheTtl })
      logBag.upstream_model = result?.model || null
      // API transport still stamps the first data: line; subtract t0 for queue wait only.
      logBag.first_token_ms = Number.isFinite(result?.firstTokenAt)
        ? Math.max(0, result.firstTokenAt - logCtx.t0)
        : (result?.ttftMs ?? null)
      logBag.final_state = result?.terminalState || null
      await attachPricing(logBag, {
        managedKey,
        reservation: admission.lease,
        rateMultiplier: await deps.groupsRepo.rateMultiplier(managedKey?.group_id ?? 1),
        bill: !!(result?.ok && managedKey),
      })
      if (clientStream) {
        if (isClientCancelledResult(result)) return finishClientCancel(res, result, logBag)
        if (!res.headersSent) {
          const mapped = mapProtocolClientError(result, logBag, 'api_pool_exhausted')
          if (!isClientCancelledResult(result)) stats.errors++
          return sendMapped(res, mapped)
        }
        if (result?.ok && protocol !== 'anthropic.messages') res.write('data: [DONE]\n\n')
        return res.end()
      }
      if (!result?.ok || isIncompleteAssistantMessage(result)) {
        if (isClientCancelledResult(result)) return finishClientCancel(res, result, logBag)
        const failed = isIncompleteAssistantMessage(result) ? incompleteAssistantClientError(result) : result
        const mapped = mapProtocolClientError(failed, logBag, failed?.body?.error?.code || 'upstream_error')
        stats.errors++
        return sendMapped(res, mapped)
      }
      let output
      const clientBody = hidePersonaUsageOnMessage(result.body, personaHideTokens)
      if (protocol === 'anthropic.messages') output = clientBody
      else if (protocol === 'openai.chat') output = fromClaudeToOpenAIChat(clientBody, inbound.model)
      else if (protocol === 'openai.completions') output = fromClaudeToOpenAICompletions(clientBody, inbound.model)
      else output = fromClaudeToResponses(clientBody, inbound.model, result.endpointId, converted.mode)
      return json(res, 200, output)
    }

    const canonicalBody = officialMessagesBody(ctx.body)
    const streamKeepaliveMs = Number(
      getRouting()?.failover?.stream_keepalive_ms ?? cfg.limits.stream_keepalive_ms ?? 15_000,
    )
    // First downstream byte during a queue wait. Short misses stay HTTP 429/529;
    // anything still waiting past this writes SSE so Cloudflare does not 524.
    const queueKeepaliveDelay = queueKeepaliveDelayMs(getRouting(), cfg.limits?.queue_keepalive_delay_ms)
    const streamIdleTimeoutMs = resolveStreamIdleTimeoutMs(getRouting(), cfg)
    const gate = await reserveManagedKey(req, res)
    if (!gate.ok) return
    admission.lease = gate
    const managedKey = req.apiKeyRecord || null

    const clientAbort = bindClientAbort(req, res)

    const clientStream = isClientStream(inbound, req.headers)
    const streamTracker = clientStream && protocol === 'anthropic.messages' ? createAnthropicStreamTracker() : null
    const anthropicSseErrorRemapper =
      clientStream && protocol === 'anthropic.messages' ? createAnthropicSseErrorRemapper() : null
    // One keepalive for the whole Claude stream, including session/seat queues
    // and the gaps between failover attempts. OpenAI keeps its per-attempt one.
    let activeAttemptCommit = null
    const anthropicKeepalive =
      clientStream && protocol === 'anthropic.messages' && streamKeepaliveMs > 0
        ? createDownstreamKeepalive({
            intervalMs: streamKeepaliveMs,
            userAgent: req.headers['user-agent'] || req.headers['User-Agent'] || '',
            protocol,
            write: (chunk) => {
              if (res.writableEnded || res.destroyed) return
              if (!res.headersSent) writeSSEHeaders(res)
              res.write(chunk)
              // A queue ping commits the HTTP response only. The slot commits
              // while an attempt is active, same as an in-attempt ping.
              activeAttemptCommit?.()
            },
          })
        : null
    anthropicKeepalive?.armAfter(queueKeepaliveDelay)
    const upstreamStream = true
    const requestedDelivery = String(
      req.headers['x-kin-delivery'] || getRouting()?.failover?.delivery_mode || 'realtime',
    )
    // Worker hop stays realtime unless the caller asked for verified.
    // stream:false only changes the client response shape (assembled JSON).
    const deliveryMode = requestedDelivery === 'verified' ? 'verified' : 'realtime'
    const pinVmRaw = String(req.headers['x-kin-vm'] || '').trim()
    const pinVmId = req.apiKeyKind === 'master' && isValidVmId(pinVmRaw) ? pinVmRaw : null
    // Pin is panel test-chat / diagnostics (manage). Unpinned /v1 is dispatch.
    const ownerScope = pinVmId ? { type: 'any' } : await ownerScopeFromRequest(req, apiKeyStore?.users)
    // Cache bypass is a client hint; only authenticated master-key probes may skip accounting.
    const healthReal = req.apiKeyKind === 'master' && isHealthRealBypass(req.headers)
    // Cache lives per account; a failover to another account starts cold by design.
    // The image floor follows the caller session across accounts, scoped to its key.
    // Returns the body to send: the image floor and break anchor may rewrite it.
    const imageKey = callerSession ? `${req.apiKeyRecord?.id || req.apiKeyKind || ''}:${callerSession}` : null
    const noteCachePrefix = (selected, sessionId, body) => {
      if (!sessionId) return body
      const key = `${selected.accountId}:${sessionId}`
      const { body: prepared, ...prefix } = prepareCachePrefix(key, body, Date.now(), { imageKey }) || { body }
      logBag.cache_prefix = prefix
      logBag.cache_prefix_key = key
      if (prefix.image_floor_moved) {
        console.warn(
          `[cache-prefix] request ${logCtx.request_id} turn ${prefix.turn} image floor messages[${prefix.image_floor}]`,
        )
      }
      if (!prefix.break) return prepared
      const where = formatCacheBreak(prefix)
      const anchor = prefix.anchor == null ? '' : `; anchored messages[${prefix.anchor}]`
      const checkpoint = prefix.checkpoint == null ? '' : `; checkpoint messages[${prefix.checkpoint}]`
      console.warn(
        `[cache-prefix] request ${logCtx.request_id} turn ${prefix.turn} broke at ${where}${anchor}${checkpoint}`,
      )
      return prepared
    }
    // Keep the envelope separately; only the CLI send boundary owns final headers.
    // Clear each attempt so a failed retry cannot retain the previous hop's snapshot.
    const noteOutboundEnvelope = (envelope) => {
      if (logCtx.capture_outbound) logBag.outbound_body = envelope?.body ?? null
      logBag.worker_envelope_headers = envelope?.headers ? redactHeaders(envelope.headers) : null
      logBag.outbound_headers = null
      logBag.outbound_headers_source = 'unavailable'
    }
    const noteOutboundHeaders = (headers) => {
      if (!logCtx.capture_outbound) return
      logBag.outbound_headers = redactHeaders(headers)
      logBag.outbound_headers_source = 'cli_final'
    }
    let result
    try {
      admission.executionStarted = true
      result = await getFailoverRunner().run({
        requestId: logCtx.request_id,
        canonicalBody,
        model: canonicalBody.model,
        stickyKey: isProbe ? null : stickyKey,
        stickyKeys: isProbe ? [] : stickyKeys,
        stickyDeviceId,
        deviceKey,
        skipSessionSeat: seatless,
        familyKey,
        seatKey,
        familyVmId,
        pinVmId,
        ownerScope,
        keyScope,
        countUsage: !healthReal,
        quotaRequest: {
          body: canonicalBody,
          sessionId: outboundSessionId || callerSession || stickyKey,
        },
        stream: upstreamStream,
        deliveryMode,
        signal: clientAbort.signal,
        applyAttempt: async (body, selected, extra = {}) => {
          // Only this account's own thinking replays as thinking. Another
          // account's signature, or one with no record, goes out as text.
          const owned = await filterThinkingForAccount(body, selected.accountId, thinkingOwnerStore)
          body = owned.body
          if (owned.kept || owned.converted || owned.dropped) {
            const { kept, converted, dropped, unknown } = owned
            logBag.hop_meta = {
              ...logBag.hop_meta,
              thinking_owner: { account_id: selected.accountId, kept, converted, dropped, unknown },
            }
          }
          if (claudeScopePending()) {
            const blocked = await applyProtocolIntercept({
              req,
              inbound,
              body: ctx.body,
              fp,
              logBag,
              requestId: logCtx.request_id,
              res,
              account: scopeAccountFromVm(selected?.vm, findAccount(accountQuota, selected?.vm)?.unified),
            })
            if (blocked) {
              const error = new Error('response already sent')
              error.code = 'response_sent'
              throw error
            }
          }
          try {
            if (!isKubernetesHaMode())
              await touchTelemetrySession(cfg.paths.project, selected.vmId, selected.exec?.vm)?.publication
          } catch (error) {
            if (
              error?.publicationFinished === true &&
              error?.executionUncertain !== true &&
              error?.vmOperationUncertain !== true
            )
              throw error
            error.executionUncertain = true
            admission.executionStarted = true
            if (admission.lease?.shared) admission.lease.executionUncertain = true
            await selected.markUncertain?.()
            await observeExecution(req, admission, {
              started: true,
              ended: false,
              reason: 'remote_publication_unknown',
            })
            throw error
          }
          const identity = loadVmIdentity(selected.exec)
          const attemptStartedAt = extra.attemptStartedAt ?? Date.now()
          // The runner snapshots after this session's queue turn, before VM prebinding.
          const attemptBound = extra.stickyBound
          const keptSession = extra.freshSlot ? '' : attemptBound?.sessionId || ''
          const keptAccount = extra.freshSlot ? '' : attemptBound?.accountId || ''
          const keptVm = extra.freshSlot ? '' : attemptBound?.vmId || ''
          let routingNow = getRouting()
          if (!isKubernetesMode()) {
            try {
              routingNow = readRoutingDocument(routingConfigPath)
            } catch {}
          }
          const cliHop = resolveOfficialCcInference(selected.vm, routingNow) === 'cli-hop'
          // Official Claude Code already carries the real system, cache markers
          // and sampling fields. Content stays on the wire; slot identity and
          // outbound session still follow attempt/VM rebuild semantics.
          const officialPassthrough = officialTraffic && cliHop && officialCcPassthroughFromRouting(routingNow)
          const attemptSessionMode = officialPassthrough ? 'rebuild' : sessionContext.mode
          const attemptSessionId = resolveOutboundSessionId(callerSession, {
            ...sessionContext,
            mode: attemptSessionMode,
            accountId: selected.accountId,
            boundSessionId: keptSession,
            boundAccountId: keptAccount,
            boundVmId: keptVm,
            vmId: selected.vmId,
            epoch: extra.freshSlot
              ? `slot:${selected.slotIndex ?? 'x'}:${attemptStartedAt}`
              : `${attemptStartedAt}:${selected.vmId || extra.attemptNo || ''}`,
          })
          if (identity && attemptSessionId) identity.callerSessionId = attemptSessionId
          const credMode = credentialModeFromOauth(selected.vm?.claude || {})
          const modeOverride = slotPersonaModeOverride(selected.vm)
          const entrypointNow = ccEntrypointFromRouting(routingNow)
          const repaired = extra.repaired === true
          const preserveThinkingBlocks =
            !repaired &&
            routingNow?.failover?.signature_repair !== true &&
            (!keptAccount || keptAccount === selected.accountId)
          // cli-node receives the cleaned body after this boundary. Keep every
          // thinking block on the first hop and only let a repaired retry strip it.
          const preserveCliHopThinkingBlocks = !repaired
          const resolvedPersona = resolveSlotPersonaPreset(selected.vm, routingNow)
          const preserveCallerEnvironment = !presetFlagEnabled(
            routingNow?.compatibility,
            'persona_env_presets',
            resolvedPersona,
          )
          let hopBody = body
          if (cliHop) {
            // The front rewrite already produces the official two-block shape.
            const outboundProfile = profileForPreset(resolvedPersona)
            if (officialPassthrough && !requestContext) {
              hopBody = prepareOfficialPassthroughBody(hopBody, {
                stream: upstreamStream,
                identity,
                inbound,
                reqHeaders: req.headers,
                sessionId: attemptSessionId,
              })
              logBag.official_passthrough = true
            } else {
              if (!requestContext && !officialTraffic) {
                hopBody = applyCrsUnofficialPersona(
                  { ...structuredClone(personaIn), messages: hopBody.messages },
                  {
                    forceConfigured: true,
                    routingFile: routingConfigPath,
                    mode: resolvedPersona,
                    sessionId: attemptSessionId,
                    model: hopBody?.model,
                    cliVersion: outboundProfile.cliVersion,
                    identity,
                    entrypoint: entrypointNow,
                  },
                )
              }
              hopBody = prepareCliHopBody(repaired ? body : hopBody, {
                stream: upstreamStream,
                repaired,
                cacheTtl: requestedCacheTtl,
                requestContext,
                preserveSystem: false,
                preserveThinkingBlocks: preserveCliHopThinkingBlocks,
                preserveCallerEnvironment,
                autoCompactWindow: ctx.autoCompactWindow,
                routing: routingNow,
              })
              if (!requestContext) {
                hopBody = ensureBillingAttribution(hopBody, {
                  firstUserText,
                  sessionId: attemptSessionId,
                  cliVersion: outboundProfile.cliVersion,
                  indexes: billingIndexesFromMessages(hopBody.messages),
                  entrypoint: entrypointNow,
                })
              }
            }
            hopBody = await materializeRemoteImageSources(hopBody)
            if (identity) {
              hopBody = applyCrsIdentityReplace(hopBody, identity, inbound, req.headers, {
                officialClient: officialTraffic,
                sessionId: attemptSessionId,
                mode: sessionMode,
                boundSessionId: keptSession,
                boundAccountId: keptAccount,
                boundVmId: keptVm,
                vmId: selected.vmId,
                epoch: attemptStartedAt,
              })
            }
            preserveCacheBreakpoints = true
            // Native wire may mix TTLs or leave caller TTL absent. The menu is
            // not an accounting authority; retain the upstream 5m/1h split.
            cacheTtl = null

            personaHideTokens = 0
            logBag.inference_engine = resolveInferenceEngine(selected.vm, routingNow)
            logBag.persona_preset = resolveSlotPersonaPreset(selected.vm, routingNow)
            logBag.outbound_profile = { cli_version: outboundProfile.cliVersion }
            logBag.official_cc_inference = 'cli-hop'
            logBag.provider = 'local_cli'
            hopBody = noteCachePrefix(selected, attemptSessionId, hopBody)
            logBag.outbound_summary = summarizeBody(hopBody)
            logBag.cache_continuity = describeCacheContinuity({
              inbound,
              outbound: hopBody,
              layer: 'node_object',
              ttl: requestedCacheTtl,
              sessionId: attemptSessionId,
              vmId: selected.vmId,
              accountId: selected.accountId,
              requestId: logCtx.request_id,
            })
            logBag.outbound_session_id = sessionIdForLog(sessionIdFromOutboundBody(hopBody) || attemptSessionId)
            return {
              body: hopBody,
              meta: {
                toolNames: {},
                sessionId: attemptSessionId,
                cliHop: true,
                repaired,
                requestContext,
                accountObservation: await accountQuota?.beginObservation?.(),
              },
            }
          }

          cacheTtl = requestedCacheTtl
          if (!requestContext && !officialPassthrough && (modeOverride || officialTraffic)) {
            const configuredMode = modeOverride || resolveSlotPersonaPreset(selected.vm, routingNow)
            const rewritten = applyCrsUnofficialPersona(
              { ...structuredClone(personaIn), messages: hopBody.messages },
              {
                officialClient: false,
                forceConfigured: true,
                routingFile: routingConfigPath,
                mode: configuredMode,
                sessionId: attemptSessionId,
                model: personaIn?.model,
                cliVersion: OFFICIAL_CLI_VERSION,
                identity,
              },
            )
            hopBody = officialMessagesBody(rewritten)
            personaHideTokens = personaHideForUnofficial(personaIn, rewritten, {
              officialClient: false,
              mode: configuredMode,
              hides: personaHidesUsageFromRoutingFile(routingConfigPath, configuredMode),
              standing: standingUsageFromRoutingFile(routingConfigPath, configuredMode),
            })
          }
          logBag.inference_engine = resolveInferenceEngine(selected.vm, routingNow)
          logBag.persona_preset = resolveSlotPersonaPreset(selected.vm, routingNow)
          logBag.official_cc_inference = 'http'
          logBag.provider = 'anthropic_api'
          const prepared = prepareOutboundEnvelope({
            requestContext,
            canonicalBody: hopBody,
            inbound,
            identity,
            unofficial: !officialTraffic,
            officialClient: officialTraffic,
            sessionId: attemptSessionId,
            accountId: selected.accountId,
            boundSessionId: keptSession,
            boundAccountId: keptAccount,
            boundVmId: keptVm,
            vmId: selected.vmId,
            epoch: attemptStartedAt,
            mode: officialPassthrough ? 'rebuild' : sessionMode,
            routing: routingNow,
            clientDiscriminator,
            firstUserText,
            firstUserIdentity,
            apiKeyId: req.apiKeyRecord?.id ?? '',
            stream: upstreamStream,
            cacheControlLimit: Number(getRouting()?.compatibility?.cache_control_limit) || 4,
            toolNameRewrite: officialPassthrough
              ? false
              : openaiCompat
                ? false
                : getRouting()?.compatibility?.tool_name_rewrite !== false,
            cacheTtl,
            cacheBreakpoints,
            preserveThinkingBlocks,
            preserveCallerEnvironment: officialPassthrough ? true : preserveCallerEnvironment,
            officialPassthrough,
            reqHeaders: req.headers,
            homeDir: selected.exec?.homeDir || '',
            credentialMode: credMode,
            authScheme: isApiKeyMode(credMode) ? 'apikey' : 'oauth',
            want1m,
          })
          const outbound = noteCachePrefix(selected, attemptSessionId, prepared.body)
          logBag.outbound_summary = summarizeBody(outbound)
          logBag.cache_continuity = describeCacheContinuity({
            inbound,
            outbound,
            layer: 'node_object',
            ttl: cacheTtl,
            sessionId: attemptSessionId,
            vmId: selected.vmId,
            accountId: selected.accountId,
            requestId: logCtx.request_id,
          })
          noteCachePrefix(selected, attemptSessionId, outbound)
          logBag.outbound_session_id = sessionIdForLog(sessionIdFromOutboundBody(outbound) || attemptSessionId)
          return {
            body: outbound,
            meta: {
              toolNames: prepared.toolNames,
              sessionId: attemptSessionId,
              repaired,
              accountObservation: await accountQuota?.beginObservation?.(),
            },
          }
        },
        callAttempt: async ({ candidate, body, attemptMeta, deliveryMode: attemptDelivery, signal, onCommit }) => {
          const billingSnapshot =
            isKubernetesHaMode() && managedKey
              ? captureHaBillingSnapshot({
                  model: body.model,
                  rateMultiplier: await deps.groupsRepo.rateMultiplier(managedKey.group_id ?? 1),
                  cacheTtl,
                  requestedSpeed: wantsFastMode(ctx.body) ? 'fast' : null,
                })
              : null
          const hooks = executionHooks(req, admission, candidate, billingSnapshot)
          if (!clientStream) {
            return await streamAndAssembleClaudeMessage({
              ...hooks,
              candidate,
              body,
              reqHeaders: req.headers,
              timeoutMs: cfg.limits.upstream_timeout_ms,
              idleTimeoutMs: streamIdleTimeoutMs,
              signal,
              deliveryMode: attemptDelivery,
              toolNames: attemptMeta?.toolNames || {},
              cacheTtl,
              preserveCacheBreakpoints,
              cliHop: attemptMeta?.cliHop === true,
              repaired: attemptMeta?.repaired === true,
              requestContext: attemptMeta?.requestContext || requestContext,
              want1m,
              routing: getRouting(),
              noGoFallback: !!pinVmId,
              accountObservation: attemptMeta?.accountObservation,
              onEnvelope: noteOutboundEnvelope,
              onOutboundHeaders: noteOutboundHeaders,
            })
          }
          let state
          if (protocol === 'openai.chat') {
            state = createOpenAIChatStreamState(inbound.model || body.model, candidate.vmId)
          } else if (protocol === 'openai.completions') {
            state = createOpenAICompletionStreamState(inbound.model || body.model, candidate.vmId)
          } else if (protocol === 'openai.responses') {
            state = createResponsesStreamState(inbound.model || body.model, candidate.vmId)
          }
          const keepalive =
            anthropicKeepalive ||
            createDownstreamKeepalive({
              intervalMs: streamKeepaliveMs,
              userAgent: req.headers['user-agent'] || req.headers['User-Agent'] || '',
              protocol,
              write: (chunk) => {
                if (res.writableEnded || res.destroyed) return
                if (!res.headersSent) writeSSEHeaders(res)
                res.write(chunk)
                // A ping is already a downstream byte. Commit so a later upstream
                // failure cannot switch slots onto this socket.
                onCommit()
              },
            })
          if (anthropicKeepalive) activeAttemptCommit = onCommit
          keepalive.arm()
          try {
            const workerResult = await dispatchStreamInference({
              exec: candidate.exec,
              ...hooks,
              cacheTtl,
              preserveCacheBreakpoints,
              cliHop: attemptMeta?.cliHop === true,
              repaired: attemptMeta?.repaired === true,
              requestContext: attemptMeta?.requestContext || requestContext,
              body,
              reqHeaders: req.headers,
              timeoutMs: cfg.limits.upstream_timeout_ms,
              idleTimeoutMs: streamIdleTimeoutMs,
              identity: loadVmIdentity(candidate.exec),
              signal,
              deliveryMode: attemptDelivery,
              want1m,
              routing: getRouting(),
              slotWaitMs: candidate.slotWaitMs,
              noGoFallback: !!pinVmId,
              ensureCredential: async (exec, opts) => await ensureWorkerCredential(exec, opts),
              onEnvelope: noteOutboundEnvelope,
              onOutboundHeaders: noteOutboundHeaders,
              onCommit: () => {
                if (protocol === 'anthropic.messages' && !res.headersSent) writeSSEHeaders(res)
                onCommit()
              },
              onEvent: async (line) => {
                if (/response_headers/.test(String(line))) return
                line = restoreToolNamesInSSELine(line, attemptMeta?.toolNames || {})
                if (personaHideTokens) line = hidePersonaUsageInSseLine(line, personaHideTokens, cacheTtl)
                keepalive.observeLine(line)
                if (protocol === 'anthropic.messages') {
                  streamTracker?.observe(line)
                  if (!res.headersSent) writeSSEHeaders(res)
                  const outbound = anthropicSseErrorRemapper ? anthropicSseErrorRemapper.remapLine(line) : line
                  res.write(String(outbound).endsWith('\n') ? String(outbound) : String(outbound) + '\n')
                  return
                }
                const writeChunks = (chunks) => {
                  if (!chunks.length) return
                  if (!res.headersSent) writeSSEHeaders(res)
                  for (const chunk of chunks) {
                    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
                  }
                }
                if (protocol === 'openai.chat') {
                  writeChunks(claudeSSELineToOpenAIChatChunks(line, state))
                  return
                }
                if (protocol === 'openai.completions') {
                  writeChunks(claudeSSELineToOpenAICompletionChunks(line, state))
                  return
                }
                writeChunks(claudeSSELineToResponsesEvents(line, state))
              },
            })
            return { ...workerResult, accountObservation: attemptMeta?.accountObservation }
          } finally {
            if (anthropicKeepalive) {
              activeAttemptCommit = null
              anthropicKeepalive.endAttempt()
            } else keepalive.stop()
          }
        },
      })
      if (result?.executionUncertain && admission.lease?.shared) admission.lease.executionUncertain = true
    } finally {
      anthropicKeepalive?.stop()
      clientAbort.settle()
    }

    if (result?.responseSent) return

    result = acceptAssistantHop(result)
    if (result?.finalState === 'verified' && logBag.cache_prefix_key) {
      confirmCachePrefix(logBag.cache_prefix_key)
    }
    logBag.vm_id = result?.vmId || null
    logBag.account_id = result?.accountId || null
    logBag.final_account_id = result?.accountId || null
    if (result?.threadBetas) logBag.hop_meta = { ...logBag.hop_meta, thread_betas: result.threadBetas }
    if (result?.accountId && (result.ok || result.committed))
      await recordThinkingOwners(result.body, result.accountId, thinkingOwnerStore)
    // Zero executions is a real 0, not unknown; the VM is the last one that ran.
    logBag.attempt_count = result?.attemptCount ?? 0
    logBag.final_state = result?.finalState || result?.terminalState || null
    logBag.upstream_status = result?.status ?? null
    logBag.usage = usageForLog(result?.body?.usage || result?.usage || null, {
      cacheTtl,
      requestedSpeed: wantsFastMode(ctx.body) ? 'fast' : null,
    })
    logBag.upstream_model = result?.body?.model || result?.model || null
    // Kernel stream firstTokenAt is generated content; include admission/setup via t0.
    logBag.first_token_ms = Number.isFinite(result?.firstTokenAt)
      ? Math.max(0, result.firstTokenAt - logCtx.t0)
      : (result?.ttftMs ?? null)
    logBag.stop_reason = result?.body?.stop_reason || result?.stopReason || null
    logBag.via = result?.via || 'go-worker-pool'
    if (result?.finalState === 'content_filter' || logBag.stop_reason === 'refusal') {
      logBag.error_code = logBag.error_code || 'content_filter_refusal'
      logBag.error_message = logBag.error_message || 'upstream stop_reason=refusal'
    }
    await rememberRefusal({
      inbound,
      body: ctx.body,
      headers: req.headers,
      result,
      logBag,
      requestId: logCtx.request_id,
    })

    if (result?.accountId) {
      try {
        const limitText = [
          logBag.error_message,
          result?.body?.error?.message,
          result?.error?.message,
          typeof result?.error === 'string' ? result.error : '',
        ]
          .filter(Boolean)
          .join('\n')
        const headers = extraHeadersFromLimitError(limitText, result.headers || {})
        const exhausted = isAccountQuotaExhausted(result, limitText)
        accountQuota.ingestHeaders(result.accountId, headers, healthReal ? null : logBag.usage, {
          exhausted,
          status: result.status,
          countRequest: !healthReal,
          observation: result?.accountObservation,
        })
        const pool = typeof deps.getPoolScheduler === 'function' ? deps.getPoolScheduler() : deps.poolScheduler
        // Live `5h-status` on every response; `allowed` is the only early unblock.
        if (!exhausted) {
          await pool?.rateLimitService?.updateSessionWindow?.({
            accountId: result.accountId,
            vmId: result.vmId || null,
            headers: result.headers || {},
            observation: result?.accountObservation,
          })
        }
        if (pool?.syncQuotaSchedule && result.vmId && cfg?.paths?.project) {
          const vm = getVm(cfg.paths.project, result.vmId)
          if (vm) await pool.syncQuotaSchedule(vm)
        }
      } catch {}
      await attachPricing(logBag, {
        managedKey,
        reservation: admission.lease,
        rateMultiplier: isKubernetesHaMode() ? 1 : await deps.groupsRepo.rateMultiplier(managedKey?.group_id ?? 1),
        bill: !!managedKey,
        execution: result?.execution,
      })
    }

    if (clientStream) {
      if (isClientCancelledResult(result)) return finishClientCancel(res, result, logBag)
      if (!res.headersSent) {
        const mapped = mapProtocolClientError(result, logBag, result?.body?.error?.code || 'upstream_error')
        if (!isClientCancelledResult(result) && mapped.body?.error?.code !== 'client_cancelled') stats.errors++
        return sendMapped(res, mapped)
      }
      if (result?.ok && protocol !== 'anthropic.messages') {
        res.write('data: [DONE]\n\n')
      }
      if (!result?.ok) {
        stats.errors++
        logBag.error_code = result?.body?.error?.code || 'stream_incomplete'
        logBag.error_message = result?.body?.error?.message || 'Stream did not reach a verified terminal state'
        const closing = isRecoverableTruncation(result) && !res.writableEnded ? streamTracker?.closingEvents() : null
        if (closing) res.write(closing)
        else if (
          protocol === 'anthropic.messages' &&
          !res.writableEnded &&
          !streamTracker?.hasStarted() &&
          !streamTracker?.isFinished()
        ) {
          // Headers already went out (queue ping or an in-attempt ping), so the
          // status can no longer be 429/529/503. Close with the Anthropic event.
          const mapped = mapProtocolClientError(result, logBag, logBag.error_code)
          res.write(buildAnthropicSseError(mapped.body?.error || {}))
        }
      }
      await rememberRefusal({
        inbound,
        body: ctx.body,
        headers: req.headers,
        result,
        logBag,
        requestId: logCtx.request_id,
      })
      return res.end()
    }

    if (!result?.ok || isIncompleteAssistantMessage(result)) {
      if (isClientCancelledResult(result)) return finishClientCancel(res, result, logBag)
      const failed = isIncompleteAssistantMessage(result) ? incompleteAssistantClientError(result) : result
      const mapped = mapProtocolClientError(failed, logBag, failed?.body?.error?.code || 'upstream_error')
      if (mapped.body?.error?.code !== 'client_cancelled') stats.errors++
      return sendMapped(res, mapped)
    }

    let output
    const clientBody = hidePersonaUsageOnMessage(result.body, personaHideTokens, cacheTtl)
    if (protocol === 'anthropic.messages') {
      output = { ...clientBody }
      if (String(req.headers['x-kin-debug'] || '') === '1') {
        output.kin = {
          vm_id: result.vmId,
          account_id: result.accountId,
          attempts: result.attemptCount,
          terminal_state: result.finalState,
        }
      }
    } else if (protocol === 'openai.chat') {
      output = fromClaudeToOpenAIChat(clientBody, inbound.model, result.vmId, converted.mode)
    } else if (protocol === 'openai.completions') {
      output = fromClaudeToOpenAICompletions(clientBody, inbound.model)
    } else {
      output = fromClaudeToResponses(clientBody, inbound.model, result.vmId, converted.mode)
    }
    ctx = applyIntercept(cfg.intercept.rules, 'before_client', { ...ctx, body: output })
    return json(res, 200, ctx.body)
  }

  /** POST /v1/alpha/search (Codex web search): same logging, auth and body handling as handleProtocol. */
  async function handleSearch(req, res, pathName) {
    if (isKubernetesHaMode()) {
      if (!(await requireAuth(req, res))) return
      return rejectHaOperation(res)
    }
    const protocol = 'openai.search'
    const logCtx = requestLog.start(req, { protocol, pathName })
    res._kinRequestId = logCtx.request_id
    requestLog.tapResponse?.(logCtx, res)
    const logBag = {
      protocol,
      model: null,
      stream: false,
      inbound_summary: null,
      upstream_status: null,
      vm_id: null,
      account_id: null,
      usage: null,
      error_code: null,
      error_message: null,
      via: 'codex-search',
      attempt_count: null,
      final_state: null,
    }
    res.on('finish', () =>
      trackPendingWrite(
        (async () => {
          try {
            const groupId = req.apiKeyRecord?.group_id ?? 1
            await requestLog.finish(logCtx, {
              status: res.statusCode || 0,
              api_key_kind: req.apiKeyKind || null,
              api_key_id: req.apiKeyRecord?.id || null,
              user_id: req.apiKeyRecord?.user_id ?? null,
              group_id: groupId,
              rate_multiplier: await deps.groupsRepo.rateMultiplier(groupId),
              ...logBag,
            })
          } catch (error) {
            throw error
          }
        })(),
      ),
    )
    if (!(await requireAuth(req, res))) {
      logBag.error_code = req.authError?.code || ErrorCode.INVALID_API_KEY
      logBag.error_message = req.authError?.message || 'Invalid credentials'
      logBag.api_key_presented = presentedApiKeyForLog(req.presentedApiKey)
      return
    }
    let body
    try {
      body = await readBody(req, inboundBodyLimit(getRouting(), cfg.limits.max_body_bytes))
    } catch (error) {
      stats.errors++
      logBag.error_code = error?.body?.error?.code || ErrorCode.INVALID_JSON
      logBag.error_message = error?.body?.error?.message || String(error?.message || error)
      if (error?.body?.error) return json(res, error.status || 400, error.body)
      return json(
        res,
        400,
        makeError({
          type: ErrorType.INVALID_REQUEST,
          code: ErrorCode.INVALID_JSON,
          message: String(error?.message || error),
          status: 400,
        }).body,
      )
    }
    logBag.model = typeof body?.model === 'string' ? body.model : null
    logBag.inbound_summary = summarizeBody(body)
    const gate = await reserveManagedKey(req, res)
    if (!gate.ok) return
    const admission = { lease: gate }
    try {
      const output = await handleCodexSearch({
        req,
        res,
        body,
        logBag,
        stats,
        json,
        routing: getRouting() || {},
        projectRoot: cfg.paths.project,
        stickyRouter,
        ownerScope: await ownerScopeFromRequest(req, apiKeyStore?.users),
        onExecutionState:
          deps.onExecutionState || gate.shared
            ? (_req, execution) => observeExecution(req, admission, execution)
            : undefined,
      })
      await attachPricing(logBag, {
        managedKey: req.apiKeyRecord,
        reservation: gate,
        rateMultiplier: await deps.groupsRepo.rateMultiplier(req.apiKeyRecord?.group_id ?? 1),
        bill: !!req.apiKeyRecord && logBag.final_state === 'verified',
      })
      return output
    } catch (error) {
      if (gate.shared && !gate.settled) gate.billingFailed = true
      throw error
    } finally {
      if (!gate.billingFailed && !gate.executionUncertain) await gate.release?.()
    }
  }

  /** Field names and image count only: Images bodies carry base64 uploads. */
  function summarizeImagesBody(body) {
    if (!body || typeof body !== 'object') return null
    return {
      model: typeof body.model === 'string' ? body.model : null,
      fields: Object.keys(body).sort(),
      images: Array.isArray(body.images) ? body.images.length : body.image ? 1 : 0,
      mask: body.mask != null,
    }
  }

  /** POST /v1/images/{generations,edits}: same logging and auth as search; edits also take multipart. */
  async function handleImages(req, res, pathName, kind) {
    if (isKubernetesHaMode()) {
      if (!(await requireAuth(req, res))) return
      return rejectHaOperation(res)
    }
    const protocol = 'openai.images'
    const logCtx = requestLog.start(req, { protocol, pathName })
    res._kinRequestId = logCtx.request_id
    requestLog.tapResponse?.(logCtx, res)
    const logBag = {
      protocol,
      model: null,
      stream: false,
      inbound_summary: null,
      upstream_status: null,
      vm_id: null,
      account_id: null,
      usage: null,
      error_code: null,
      error_message: null,
      via: 'codex-images',
      attempt_count: null,
      final_state: null,
    }
    res.on('finish', () =>
      trackPendingWrite(
        (async () => {
          try {
            const groupId = req.apiKeyRecord?.group_id ?? 1
            await requestLog.finish(logCtx, {
              status: res.statusCode || 0,
              api_key_kind: req.apiKeyKind || null,
              api_key_id: req.apiKeyRecord?.id || null,
              user_id: req.apiKeyRecord?.user_id ?? null,
              group_id: groupId,
              rate_multiplier: await deps.groupsRepo.rateMultiplier(groupId),
              ...logBag,
            })
          } catch (error) {
            throw error
          }
        })(),
      ),
    )
    if (!(await requireAuth(req, res))) {
      logBag.error_code = req.authError?.code || ErrorCode.INVALID_API_KEY
      logBag.error_message = req.authError?.message || 'Invalid credentials'
      logBag.api_key_presented = presentedApiKeyForLog(req.presentedApiKey)
      return
    }
    let body
    try {
      const raw = await readRawBody(req, inboundBodyLimit(getRouting(), cfg.limits.max_body_bytes))
      const contentType = req.headers?.['content-type']
      if (kind === 'edits' && isMultipartFormData(contentType)) {
        const converted = await normalizeImageEditBody(raw, contentType)
        if (!converted.ok) {
          stats.errors++
          logBag.error_code = 'invalid_image_edit'
          logBag.error_message = converted.message
          return json(
            res,
            400,
            makeError({
              type: ErrorType.INVALID_REQUEST,
              code: 'invalid_image_edit',
              message: converted.message,
              status: 400,
            }).body,
          )
        }
        body = converted.body
      } else {
        const text = raw.toString('utf8')
        body = text ? JSON.parse(text) : {}
      }
    } catch (error) {
      stats.errors++
      logBag.error_code = error?.body?.error?.code || ErrorCode.INVALID_JSON
      logBag.error_message = error?.body?.error?.message || String(error?.message || error)
      if (error?.body?.error) return json(res, error.status || 400, error.body)
      return json(
        res,
        400,
        makeError({
          type: ErrorType.INVALID_REQUEST,
          code: ErrorCode.INVALID_JSON,
          message: String(error?.message || error),
          status: 400,
        }).body,
      )
    }
    logBag.model = typeof body?.model === 'string' ? body.model : null
    logBag.inbound_summary = summarizeImagesBody(body)
    const gate = await reserveManagedKey(req, res)
    if (!gate.ok) return
    const admission = { lease: gate }
    try {
      const output = await handleCodexImages({
        req,
        res,
        kind,
        body,
        logBag,
        stats,
        json,
        routing: getRouting() || {},
        projectRoot: cfg.paths.project,
        stickyRouter,
        ownerScope: await ownerScopeFromRequest(req, apiKeyStore?.users),
        onExecutionState:
          deps.onExecutionState || gate.shared
            ? (_req, execution) => observeExecution(req, admission, execution)
            : undefined,
      })
      await attachPricing(logBag, {
        managedKey: req.apiKeyRecord,
        reservation: gate,
        rateMultiplier: await deps.groupsRepo.rateMultiplier(req.apiKeyRecord?.group_id ?? 1),
        bill: !!req.apiKeyRecord && logBag.final_state === 'verified',
      })
      return output
    } catch (error) {
      if (gate.shared && !gate.settled) gate.billingFailed = true
      throw error
    } finally {
      if (!gate.billingFailed && !gate.executionUncertain) await gate.release?.()
    }
  }

  return {
    handleProtocol,
    handleSearch,
    handleImages,
    mapProtocolClientError,
    applyProtocolIntercept,
    streamAndAssembleClaudeMessage,
  }
}
