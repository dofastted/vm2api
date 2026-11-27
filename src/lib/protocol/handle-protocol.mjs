/**
 * /v1 protocol handler. URLs, auth, and response envelopes stay with the
 * server wiring; this factory owns convert → pool → Go/Rust hop → client.
 */
import crypto from 'node:crypto'
import { applyIntercept } from '../core/intercept.mjs'
import { resolveStreamIdleTimeoutMs, inboundBodyLimit, queueKeepaliveDelayMs } from '../core/config.mjs'
import { hashKey } from '../core/security.mjs'
import { applyEagerToolStreaming } from './eager-tool-streaming.mjs'
import {
  defaultMaxTokensForModel,
  getCapabilities,
  normalizeThinkingByPolicy,
  validateBetweenToolsThinking,
  validateToolChoice,
} from './model-policy.mjs'
import { ToolResultPruneCache, dshPruneScope } from './tool-result-prune-cache.mjs'
import {
  refusalAuditIdentity,
  refusalGuardPolicy,
  refusalPreview,
  refusalSessionId,
  riskPrincipal,
} from '../core/refusal-guard.mjs'
import { isDbOpen } from '../db/database.mjs'
import { RefusalGuardsRepo } from '../db/repos/refusal-guards-repo.mjs'
import { RefusalDeviceBlocksRepo } from '../db/repos/refusal-device-blocks-repo.mjs'
import { RefusalSessionBlocksRepo } from '../db/repos/refusal-session-blocks-repo.mjs'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { makeApiKeyGateError } from '../admin/api-keys.mjs'
import { readJevConfig } from './jev-intercept.mjs'
import { observeUpstreamRisk, upstreamRiskClientError } from './intercept-gate.mjs'
import {
  clientBlockErrorOf,
  isTrustedGateDecision,
  projectCandidateAccounts,
  runUnifiedPreDispatch,
} from './unified-pre-dispatch.mjs'
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
import {
  sanitizeInboundBody,
  sanitizeOutboundHeaders,
  defaultSeedPolicy,
  callerAutoCompactWindow,
} from './seed-policy.mjs'
import { fingerprintRequest } from './client-fingerprint.mjs'
import { validateOfficialModel } from './models.mjs'
import { handleCodexImages, handleCodexProtocol, handleCodexSearch } from './handle-codex.mjs'
import { isAntigravityRoutedModel } from '../gemini/model-catalog.mjs'
import { parseGeminiGeneratePath } from '../gemini/routes.mjs'
import { compileWithProtoFront, protoFrontMode, transcodeWithProtoFront } from '../transport/proto-front-client.mjs'
import { isMultipartFormData, normalizeImageEditBody } from './image-edit-multipart.mjs'
import { readRawBody } from '../http/respond.mjs'
import { disjointOpenaiUsage } from './openai-usage.mjs'
import { costColumnsFromUsage } from '../admin/pricing.mjs'
import { detectInboundPlatform } from './platform-detect.mjs'
import { canonicalImageToolModel } from './image-tool-models.mjs'
import { imageModelAnswer, imageModelStreamError, imagesRequestFromTurn } from './image-model-bridge.mjs'
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
import {
  apiScheduleScope,
  resolveInferenceBackend,
  runApiInference,
  validateApiOpenAIRequest,
} from '../pool/api-protocol.mjs'
import { classifyClaudeRequestPurpose, prepareClassifierBody, classifierRequestSummary } from './request-purpose.mjs'
import { agentSummarySession } from './agent-summary.mjs'
import { summarizeBody, redactHeaders, presentedApiKeyForLog } from '../admin/request-log.mjs'
import { loggedReasoningEffort } from './thinking.mjs'
import { extractProviderCorrelation, reasoningEffortOf, sessionIdForLog } from './log-fields.mjs'
import { ownerScopeFromRequest, pinnedVmIdFromRequest, vmMatchesOwnerScope } from '../admin/resource-owner.mjs'
import {
  applyVmPool,
  keyAllowsVm,
  keyScopeFromRequest,
  keyTierPolicyFromRecord,
  resolvePoolAccessForKey,
  vmGroupType,
  vmPoolDenial,
} from '../admin/key-scope.mjs'
import {
  applyPoolPromptToAnthropicBody,
  isPoolZeroInjectMode,
  requestedPoolIdFromHeaders,
  resolvePoolSystemPromptPolicy,
} from './pool-prompt-policy.mjs'
import { keyModelError } from '../admin/key-models.mjs'
import {
  isHeadlessBridgeCaps,
  resolveInferenceEngine,
  resolveOfficialCcInference,
  resolveSlotPersonaPreset,
  slotPersonaModeOverride,
} from '../vm/slot-engine.mjs'
import { readJsonParsedCached } from '../vm/vm-file.mjs'
import {
  makeError,
  mapUpstreamError,
  passthroughUpstreamError,
  rewritePoolErrorForClient,
  validateRequestBody,
  mapModelError,
  extractErrorLogFields,
  resolveLoggedErrorCode,
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
import { canReuseCanonicalHistory } from './sanitize.mjs'
import { hasForeignSystemBlock, relocateThirdPartySystem, thirdPartyRelocateEnabled } from './third-party-system.mjs'
import { blockedClientError, blockedClientFor } from '../identity/blocked-clients.mjs'
import { prepareOutboundEnvelope, prepareCliHopBody, prepareCliPersonaInput } from './outbound-attempt.mjs'
import {
  callerCwdDeclaration,
  cragV2KernelActive,
  prepareCragPrintBody,
  projectCallerSystem,
  readSlotKernelConfig,
  resolveCragCustomTemplate,
  resolveCragPrintPersona,
  trackCallerSystemBlock,
} from './crag-print-prompt.mjs'
import { sanitizeCragEnv } from './crag-whitelist.mjs'
import { repairAnthropicRequest } from '../pool/upstream-error-policy.mjs'
import { profileForPreset } from '../identity/official-profiles.mjs'
import { loadVmIdentity, OFFICIAL_CLI_VERSION } from '../identity/vm-identity.mjs'
import {
  applyCrsIdentityReplace,
  subagentRootSession,
  extractCallerSession,
  extractFirstUserIdentity,
  outboundSessionMode,
  resolveInboundIdentity,
  resolveSchedulerIdentity,
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
  scopeStickyKey,
} from '../pool/sticky-router.mjs'
import {
  BatchGroups,
  batchGroupAppliesToKey,
  batchGroupKey,
  batchMemberSeatKey,
  mergeBatchGroupConfig,
} from '../pool/batch-group.mjs'
import {
  applyCrsUnofficialPersona,
  configuredTimezone,
  cragStrictPassthroughEnabled,
  detectProxiedOfficialCcFromRoutingFile,
  billingIndexesFromMessages,
  ccEntrypointFromRouting,
  ensureBillingAttribution,
  extractFirstUserText,
  isOfficialClaudeCodeTraffic,
  isProxiedOfficialClaudeCode,
  officialFamilyBodyPassthrough,
  personaHidesUsageFromRoutingFile,
  personaUsagePassthroughFromRoutingFile,
  standingUsageFromRoutingFile,
  personaModeFromRoutingFile,
} from '../identity/crs-persona.mjs'
import { canonicalPersonaCompat, presetFlagEnabled } from '../identity/persona-template.mjs'
import {
  claudeCodeOnlyError,
  claudeCodeOnlyFromRouting,
  isClaudeCodeFamilyRequest,
  isClaudeDesktopConnectionProbe,
} from '../identity/claude-code-only.mjs'
import { createDownstreamKeepalive } from './stream-keepalive.mjs'
import {
  buildAnthropicSseError,
  buildRetryableTruncationError,
  createAnthropicSseErrorRemapper,
  createAnthropicStreamTracker,
  isRecoverableTruncation,
  truncationReason,
} from './stream-truncation.mjs'
import {
  hidePersonaUsageInSseLine,
  hidePersonaUsageOnMessage,
  personaHideForUnofficial,
  personaHideForCliZero,
} from '../identity/crs-persona-usage.mjs'
import {
  applyCacheBreakpoints,
  applyCacheTtlToUsage,
  cacheTtlFromRouting,
  cacheBreakpointsFromRoutingFile,
  pinConversationCacheTtl,
  repairCacheBreakpoints,
  resolveCacheTtl,
} from './cache-ttl.mjs'
import { needsCragProviderCompatibility } from './kernel-request.mjs'
import {
  confirmCachePrefix,
  describeCacheContinuity,
  formatCacheBreak,
  peekInterceptSession,
  prepareCachePrefix,
} from './cache-prefix.mjs'
import { createIssuedToolReplay } from './issued-tool-replay.mjs'
import { createIssuedToolStream } from './issued-tool-stream.mjs'
import { createRequestBodyContext, shallowCopyBody } from './request-body-context.mjs'
import { jevInterceptSessionCache } from './jev-intercept.mjs'
import { ensureClaudeWebSearch, shouldInjectClaudeWebSearch } from './web-search.mjs'
import { dispatchStreamInference, prepareInferenceHop } from '../transport/kernel-router.mjs'
import { syncClaudeKernelConfigsFromFile } from '../transport/rust-kernel-supervisor.mjs'
import { ensureWorkerCredential, isNativeCragV3Plus } from '../transport/go-worker-client.mjs'
import { formatPoolSelectionSummary } from '../pool/pool-scheduler.mjs'
import { extraHeadersFromLimitError, isAccountQuotaExhausted } from '../pool/quota-window.mjs'
import {
  cragForeignThinkingMode,
  dropForeignThinkingForCrag,
  filterThinkingForAccount,
  inspectForeignThinking,
  recordThinkingOwners,
  thinkingOwners as defaultThinkingOwners,
} from '../pool/thinking-owner.mjs'
import { getVm, listVms } from '../vm/vm-registry.mjs'
import { credentialModeFromOauth, isApiKeyMode } from '../oauth/credential-mode.mjs'
import {
  prepareAnthropicRequest,
  rewriteToolNames,
  scrubUpstreamClientBody,
  toStandardAnthropicBody,
  composeToolNames,
  restoreToolNames,
  restoreToolNamesInSSELine,
  wantsFastMode,
} from './anthropic-policy.mjs'
import { materializeRemoteImageSources, validateImageDimensions } from './images.mjs'
import { applyMinMaxTokens } from './min-max-tokens.mjs'
import { detectWarmupIntercept, formatWarmupSse, warmupMockMessage } from './warmup-intercept.mjs'
import { queueAllowedByHeaders } from './queue-hint.mjs'
import {
  SchedulerApiError,
  SchedulerUnavailableError,
  VIRTUAL_POOL_IDS,
  classifyErrorClass,
  formatSchedulerError,
} from '../scheduler/scheduler-runtime.mjs'

/**
 * Which upstream refusals end the caller session. Claude Code's auto-mode
 * classifier is a side request judging one tool action: its refusal stays on
 * that request. The main conversation carries the same transcript, so a real
 * violation still ends the session the first time the conversation itself is
 * refused.
 */
export function refusalSessionBlockDecision(reason, classifier = null) {
  if (reason !== 'upstream:usage_policy' && reason !== 'upstream:flagged_session') return { block: false }
  if (classifier?.purpose === 'auto_mode_classifier') return { block: false, skipped: 'auto_mode_classifier' }
  return { block: true }
}

/**
 * Drop only genuine internal `response_headers` SSE control frames, never
 * normal model deltas whose text or tool JSON happens to mention the literal
 * substring `response_headers` (which would otherwise orphan `event:` with an
 * empty `data` payload and trigger Claude Code's malformed-stream SyntaxError).
 */
export function createResponseHeadersSseFilter() {
  let skipping = false
  return function shouldSkip(line) {
    const trimmed = String(line ?? '').trim()
    if (skipping) {
      if (trimmed === '') {
        skipping = false
        return true
      }
      if (trimmed.startsWith('event:') && !/^event:\s*response_headers$/.test(trimmed)) {
        skipping = false
      } else {
        return true
      }
    }
    if (/^event:\s*response_headers$/.test(trimmed)) {
      skipping = true
      return true
    }
    if (trimmed.startsWith('data:') && trimmed.includes('response_headers')) {
      try {
        const parsed = JSON.parse(trimmed.slice(5).trim())
        if (parsed?.type === 'response_headers') {
          skipping = true
          return true
        }
      } catch {
        // Non-JSON or partial line: never drop on substring match.
      }
    }
    return false
  }
}

function authenticatedTenant(req) {
  if (req.apiKeyRecord?.id != null) return `key:${req.apiKeyRecord.id}`
  if (req.apiKeyKind === 'master') return 'master'
  if (req.panelUserId != null) return `panel-id:${req.panelUserId}`
  if (req.panelUser) return `panel-user:${req.panelUser}`
  return ''
}

/**
 * Extract read-only scheduler identity strictly before sanitizeInboundBody /
 * sanitizeOutboundHeaders strip client machine_id/device_id/metadata.user_id.
 */
export function prepareInboundProtocolContext({
  inbound,
  headers = {},
  pathName = '',
  protocol = '',
  poolId = '',
  apiKeyId = '',
  seedPolicy = defaultSeedPolicy(),
  autoCompactWindow = callerAutoCompactWindow(inbound),
} = {}) {
  const inboundIdentity = resolveSchedulerIdentity({
    inbound,
    headers,
    poolId,
    apiKeyId,
  })
  const legacyInboundIdentity = resolveInboundIdentity({
    inbound,
    headers,
  })
  const ctx = {
    path: pathName,
    protocol,
    body: sanitizeInboundBody(inbound, seedPolicy),
    headers: sanitizeOutboundHeaders(headers),
    autoCompactWindow,
    inboundIdentity,
  }
  return { ctx, inboundIdentity, legacyInboundIdentity }
}

export function createHandleProtocol(deps) {
  const issuedTools = createIssuedToolReplay()
  const json = (...args) => deps.json(...args)
  const writeSSEHeaders = (...args) => deps.writeSSEHeaders(...args)
  const readBody = (...args) => deps.readBody(...args)
  const requireAuth = (...args) => deps.requireAuth(...args)
  const cfg = deps.cfg
  const requestLog = deps.requestLog
  const stickyRouter = deps.stickyRouter
  const getBatchGroups = () =>
    (deps.batchGroups ||= new BatchGroups({
      onExpire: (memberKey) => stickyRouter?.unbind?.(scopeStickyKey(memberKey, 'anthropic')),
    }))
  const accountQuota = deps.accountQuota
  const apiKeyStore = deps.apiKeyStore
  const apiScheduler = deps.apiScheduler
  const apiEndpointStore = deps.apiEndpointStore
  const stats = deps.stats
  const toolPruneCache = new ToolResultPruneCache()
  const routingConfigPath = deps.routingConfigPath
  const getRouting = () => (typeof deps.getRoutingConfig === 'function' ? deps.getRoutingConfig() : deps.routingConfig)
  const getHealthMonitor = () =>
    typeof deps.getHealthMonitor === 'function' ? deps.getHealthMonitor() : deps.healthMonitor
  const getFailoverRunner = () =>
    typeof deps.getFailoverRunner === 'function' ? deps.getFailoverRunner() : deps.failoverRunner
  const getSchedulerRuntime = (req = null) =>
    (typeof deps.getSchedulerRuntime === 'function' ? deps.getSchedulerRuntime() : deps.schedulerRuntime) ||
    req?._schedulerRuntime ||
    null
  const thinkingOwnerStore = deps.thinkingOwners || defaultThinkingOwners

  function resolveAttemptPoolPromptPolicy(
    rustPolicy,
    fallbackPool,
    routing,
    { nodeProvider = 'anthropic', isInternalCall = false } = {},
  ) {
    if (isInternalCall) {
      return resolvePoolSystemPromptPolicy(fallbackPool, routing, { nodeProvider, isInternalCall: true })
    }
    if (!rustPolicy || typeof rustPolicy !== 'object') {
      return resolvePoolSystemPromptPolicy(fallbackPool, routing, { nodeProvider, isInternalCall: false })
    }
    if (rustPolicy.source === 'provider_exempt') {
      return resolvePoolSystemPromptPolicy(
        { id: rustPolicy.pool_id || fallbackPool?.id || null, provider_scope: 'openai' },
        routing,
        { nodeProvider, isInternalCall: false },
      )
    }
    if (rustPolicy.source === 'global') {
      return resolvePoolSystemPromptPolicy(
        {
          id: rustPolicy.pool_id || fallbackPool?.id || null,
          provider_scope: 'anthropic',
          system_prompt_mode: 'inherit_global',
        },
        routing,
        { nodeProvider, isInternalCall: false },
      )
    }
    return resolvePoolSystemPromptPolicy(
      {
        id: rustPolicy.pool_id || fallbackPool?.id || null,
        provider_scope: 'anthropic',
        system_prompt_mode: rustPolicy.mode || 'inherit_global',
        system_prompt_preset: rustPolicy.preset || 'official_full',
        system_prompt_text: rustPolicy.text || '',
        client_system_policy: rustPolicy.client_system_policy || 'prepend_pool',
      },
      routing,
      { nodeProvider, isInternalCall: false },
    )
  }
  function responseClosed(res) {
    return !!(res?.destroyed || res?.writableEnded || res?.closed)
  }

  function usageForLog(usage, { cacheTtl = null, requestedSpeed = null } = {}) {
    let next = usage
    if (next && cacheTtl) next = applyCacheTtlToUsage(next, cacheTtl)
    if (next && requestedSpeed) next = { ...next, requested_speed: requestedSpeed }
    return disjointOpenaiUsage(next)
  }

  function attachPricing(logBag, { managedKey = null, rateMultiplier = 1, bill = false } = {}) {
    const model = logBag.upstream_model || logBag.model
    const priced = costColumnsFromUsage(logBag.usage || {}, model)
    Object.assign(logBag, priced)
    if (!bill || !managedKey) return
    try {
      apiKeyStore.recordUsage(managedKey, logBag.usage || {}, {
        model,
        rateMultiplier,
        officialCost: priced.total_cost,
      })
    } catch {}
  }

  function respondKeyGateError(res, gate) {
    const err = makeApiKeyGateError(gate)
    if (err.headers) {
      for (const [header, value] of Object.entries(err.headers)) {
        if (value != null) res.setHeader?.(header, value)
      }
    }
    return json(res, err.status, err.body)
  }

  /** Key allowlist on the model the client named, before any mapping: 400 in the caller's protocol. */
  function rejectKeyModel(req, res, protocol, model, logBag) {
    const denied = keyModelError(req, model, { anthropic: protocol === 'anthropic.messages' })
    if (!denied) return false
    stats.errors++
    logBag.error_code = denied.body.error.code
    logBag.error_message = denied.body.error.message
    json(res, denied.status, denied.body)
    return true
  }

  // Codex handlers write usage onto logBag themselves. The key is charged the
  // official cost usage_logs prices for the same row (image generation
  // included) times the group rate; logBag is left as is so the row is too.
  function billCodexKey(managedKey, logBag) {
    if (
      logBag.final_state !== 'verified' &&
      !(logBag.final_state === 'incomplete' && logBag.usage && !logBag.error_code)
    )
      return
    const model = logBag.upstream_model || logBag.model
    const image = logBag.image_usage
      ? { usage: logBag.image_usage, model: logBag.image_model || null, only: logBag.protocol === 'openai.images' }
      : null
    try {
      const priced = costColumnsFromUsage(logBag.usage || {}, model, image)
      apiKeyStore.recordUsage(managedKey, logBag.usage || {}, {
        model,
        rateMultiplier: deps.groupsRepo.rateMultiplier(managedKey.group_id ?? 1),
        officialCost: priced.total_cost,
      })
    } catch {}
  }

  /** Codex handlers take the same managed-key acquire / release / spend as the Claude paths. */
  async function runWithCodexKey(req, res, logBag, run) {
    const managedKey = req.apiKeyRecord || null
    if (!managedKey) return run()
    const gate = apiKeyStore.acquire(managedKey)
    if (!gate.ok) {
      stats.errors++
      logBag.error_code = gate.code
      logBag.error_message = gate.message
      return respondKeyGateError(res, gate)
    }
    try {
      return await run()
    } finally {
      try {
        apiKeyStore.release(managedKey)
      } catch {}
      billCodexKey(managedKey, logBag)
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

  function mapProtocolClientError(result, logBag, fallbackCode, { strictPassthrough = false } = {}) {
    const opaqueCrag429 = result?.policy?.reason === 'crag_opaque_429'
    const explicitCode = opaqueCrag429 ? result.policy.reason : result?.body?.error?.code || null
    const originalMessage = result?.body?.error?.message || null
    if (explicitCode === 'scheduler_unavailable') {
      logBag.error_code = 'scheduler_unavailable'
      logBag.error_message = originalMessage || 'Rust scheduler sidecar is unavailable'
      return {
        status: 503,
        retryAfterSec: 1,
        body: {
          type: 'error',
          error: {
            type: 'api_error',
            code: 'scheduler_unavailable',
            message: logBag.error_message,
          },
        },
      }
    }
    if (explicitCode === 'poison_abort') {
      logBag.error_code = 'poison_abort'
      logBag.error_message = originalMessage || 'Request rejected by scheduler poison guard'
      return {
        status: 422,
        body: result?.body || {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            code: 'poison_abort',
            message: logBag.error_message,
          },
        },
      }
    }
    if (
      explicitCode === 'session_in_flight' ||
      explicitCode === 'session_queue_full' ||
      explicitCode === 'session_queue_timeout' ||
      explicitCode === 'session_node_busy' ||
      explicitCode === 'pool_queue_full'
    ) {
      logBag.error_code = explicitCode
      logBag.error_message = originalMessage || 'Scheduler queue limit reached'
      return {
        status: 429,
        retryAfterSec: Math.max(1, Math.ceil(Number(result?.retryAfterSec) || 1)),
        body: result?.body || {
          type: 'error',
          error: {
            type: 'rate_limit_error',
            code: explicitCode,
            message: logBag.error_message,
          },
        },
      }
    }
    const details = result?.explain || result?.body?.error?.details || {}
    const policyRefusal =
      !opaqueCrag429 && logBag.risk_upstream_reason && logBag.risk_upstream_reason !== 'upstream:billing_refusal'
    const mapped = policyRefusal
      ? upstreamRiskClientError(logBag.risk_upstream_reason, logBag.risk_request_id)
      : strictPassthrough
        ? passthroughUpstreamError(result?.status || 503, result?.body, result?.headers || {})
        : rewritePoolErrorForClient(
            mapUpstreamError(result?.status || 503, result?.body, result?.headers || {}),
            result?.body,
          )
    if (mapped.body.error.code === ErrorCode.POOL_OVERLOADED && result?.poolReason === 'subagent_limit') {
      mapped.body.error.details = { reason: result.poolReason }
    }
    // Do not turn this opaque rejection into advice to wait or switch accounts.
    if (opaqueCrag429) mapped.body.error.message = originalMessage
    const summary = formatPoolSelectionSummary(details)
    const mappedCode = mapped.body?.error?.code
    const { upstream_type, error_details } = extractErrorLogFields(result, mapped)
    const loggedCode = resolveLoggedErrorCode({
      explicitCode,
      mappedCode,
      upstreamType: upstream_type,
      fallbackCode,
    })
    logBag.upstream_type = upstream_type
    logBag.error_details = error_details
    if (mappedCode === ErrorCode.REFUSAL_GUARD || mappedCode === ErrorCode.THIRD_PARTY_CLIENT) {
      // The kernel often names an AUP refusal upstream_invalid_request, and a
      // third-party extra-usage 400 upstream_error. Keep the mapped code so the
      // logs count it, and the upstream sentence so the row shows what happened.
      logBag.error_code = mappedCode
      logBag.error_message = logBag.error_message || originalMessage || mapped.body?.error?.message || null
    } else {
      logBag.error_code = loggedCode
      logBag.error_message = summary || originalMessage || mapped.body?.error?.message || null
    }
    if (logBag.classifier) {
      logBag.classifier.error = {
        status: result?.status || null,
        type: result?.body?.error?.type || null,
        code: loggedCode || fallbackCode || null,
        upstream_code: result?.body?.error?.upstream_code || null,
        stop_reason: result?.stopReason || null,
        stop_details: result?.stopDetails ?? null,
        request_id: result?.body?.error?.request_id || result?.headers?.['request-id'] || null,
        retry_after: result?.body?.error?.retry_after || result?.headers?.['retry-after'] || null,
      }
    }
    // Pool 529 / pool-wide 429 always carry Retry-After: the runner's wake estimate, floored at 1s.
    // A 503 carries one only when the runner knows a wake (all-rest pool).
    if (!policyRefusal && Number(result?.retryAfterSec) > 0) {
      mapped.retryAfterSec = Math.max(1, Math.ceil(Number(result.retryAfterSec)))
    }
    if (!policyRefusal && result?.headers && typeof result.headers === 'object') {
      mapped.headers = result.headers
    }
    return mapped
  }

  function sendMapped(res, mapped) {
    const forwardHeaders = mapped.headers && typeof mapped.headers === 'object' ? { ...mapped.headers } : {}
    const hasRetryAfter = Object.keys(forwardHeaders).some((k) => k.toLowerCase() === 'retry-after')
    if (mapped.retryAfterSec) {
      if (!hasRetryAfter) forwardHeaders['retry-after'] = String(mapped.retryAfterSec)
      res.setHeader?.('retry-after', String(mapped.retryAfterSec))
    }
    return json(res, mapped.status, mapped.body, forwardHeaders)
  }

  function acceptAssistantHop(result) {
    return finalizeAssembledAssistantHop(result)
  }

  function readRuntimeJev() {
    try {
      const settings = deps.settings || new SettingsRepo()
      return readJevConfig((key, fallback) => settings.get(key, fallback))
    } catch {
      return readJevConfig()
    }
  }

  function applyGateDecisionToLogBag(decision, logBag, { mandatoryOnly = false } = {}) {
    if (!decision) return
    if (!mandatoryOnly && decision.intercept) logBag.intercept = decision.intercept
    if (decision.action === 'downgrade' && decision.route) logBag.risk_route = decision.route
    if (decision.action === 'downgrade' && decision.jev_downgrade_pool_id) {
      logBag.jev_downgrade_pool_id = decision.jev_downgrade_pool_id
    }
    if (!mandatoryOnly) logBag.risk_wait = false
    if (decision.jev_passed) {
      logBag._jevPassed = true
      if (decision.jev_state) logBag._jevPassState = decision.jev_state
      if (decision.scores) logBag._jevPassScores = decision.scores
    }
  }

  function writeGateBlockResponse(decision, { res, logBag }) {
    stats.errors++
    logBag.via = decision.via
    logBag.attempt_count = 0
    logBag.final_state = decision.final_state
    logBag.error_code = decision.error_code || decision.error?.body?.error?.code || null
    logBag.error_message = decision.message || decision.error?.body?.error?.message || null
    if (decision.error_details) {
      logBag.error_details = { ...(logBag.error_details || {}), ...decision.error_details }
    }
    logBag.intercept = decision.intercept || null
    logBag.jev_state = decision.jev_state || null
    const clientErr = clientBlockErrorOf(decision)
    const errPayload = clientErr.body
    if (res.headersSent && logBag.protocol === 'anthropic.messages') {
      res.write(buildAnthropicSseError(errPayload.error))
      res.end()
    } else {
      const retryAfter = decision.retry_after_sec || decision.error?.retryAfterSec
      if (retryAfter) res.setHeader?.('retry-after', String(retryAfter))
      json(res, clientErr.status, errPayload)
    }
  }

  async function applyProtocolIntercept({
    req,
    inbound,
    body,
    fp,
    logBag,
    requestId,
    res,
    account = null,
    scopeMatched = false,
    candidateAccounts = null,
    poolJevProfile = null,
    zeroInject = undefined,
    channel = 'anthropic',
    skipDistill = undefined,
    enforceHardAndJev = undefined,
    bodyCtx = null,
    interceptSessionKey = null,
    identity,
    mandatoryOnly = false,
    skipMandatory = false,
    backend,
    apiPlatform,
    riskState,
  }) {
    // Reuse a trusted frame-level pre-dispatch verdict (e.g. Responses WebSocket)
    // only when its evaluated backend matches the resolved inference backend and
    // an API endpoint-level review requirement was not skipped upstream.
    const prevDecision = req?._preDispatchDecision
    let prevInterceptBy = ''
    if (typeof prevDecision?.intercept === 'string' && prevDecision.intercept) {
      try {
        prevInterceptBy = String(JSON.parse(prevDecision.intercept)?.by || '')
      } catch {
        prevInterceptBy = ''
      }
    }
    const canReusePreDispatch =
      isTrustedGateDecision(prevDecision) &&
      prevDecision.action !== 'block' &&
      (!backend || !prevDecision.backend || prevDecision.backend === backend) &&
      !(backend === 'api' && scopeMatched && ['scope', 'platform', 'unchecked'].includes(prevInterceptBy))
    if (canReusePreDispatch) {
      applyGateDecisionToLogBag(prevDecision, logBag, { mandatoryOnly })
      return false
    }
    const official =
      isOfficialClaudeCodeTraffic(req.headers, inbound) ||
      isOfficialClaudeClient(fp.client_class) ||
      (detectProxiedOfficialCcFromRoutingFile(routingConfigPath) && isProxiedOfficialClaudeCode(inbound, req.headers))
    const classifier = classifyClaudeRequestPurpose(inbound, { officialTraffic: official })
    const interceptSession = interceptSessionKey ? peekInterceptSession(interceptSessionKey) : null
    const decision = await runUnifiedPreDispatch({
      req,
      inbound,
      body,
      headers: req.headers,
      identity,
      official,
      classifier,
      zeroInject:
        typeof zeroInject === 'boolean'
          ? zeroInject
          : isZeroInjectMode(req?._poolAccess?.effectivePool || null, channel),
      distillRules: cfg.distill,
      policy: riskState.policy,
      jev: mandatoryOnly ? null : readRuntimeJev(),
      repo: riskState.repo,
      devices: riskState.devices,
      sessions: riskState.sessions,
      requestId,
      account,
      scopeMatched,
      candidateAccounts,
      poolJevProfile: poolJevProfile || req.poolJevProfile || req.apiKeyRecord?.jev_profile || null,
      channel,
      skipDistill,
      enforceHardAndJev,
      bodyCtx,
      interceptSession,
      mandatoryOnly,
      skipMandatory,
      backend,
      openaiPlatform: apiPlatform,
    })
    if (!decision || decision.action !== 'block') {
      applyGateDecisionToLogBag(decision, logBag, { mandatoryOnly })
      if (!mandatoryOnly && req) req._preDispatchDecision = decision
      return false
    }
    writeGateBlockResponse(decision, { res, logBag })
    return true
  }

  function isZeroInjectMode(effectivePool = null, nodeProvider = 'anthropic') {
    return isPoolZeroInjectMode(effectivePool, getRouting() || {}, { nodeProvider })
  }

  function legacyPoolAccessResult() {
    return {
      ok: true,
      status: 200,
      code: null,
      mode: 'legacy_scope',
      legacy: true,
      isDowngraded: false,
      originPool: null,
      effectivePool: null,
      allowedPoolIds: [],
      allowedMembers: null,
      allowedVmIds: null,
      allowedClaudeVmIds: null,
      allowedCodexVmIds: null,
      allowedGeminiEnvIds: null,
      allowedEndpointIds: null,
      allowedModels: [],
    }
  }

  function intersectAllowedIds(existing, poolIds) {
    const allowed = Array.isArray(poolIds) ? poolIds : []
    if (Array.isArray(existing) && existing.length > 0) {
      return existing.filter((id) => allowed.includes(id))
    }
    return [...allowed]
  }

  function loadVmInventoryForPoolAccess() {
    if (Array.isArray(deps.vms)) return deps.vms
    if (typeof deps.listVms === 'function') {
      try {
        const rows = deps.listVms()
        if (Array.isArray(rows)) return rows
      } catch {}
    }
    if (cfg?.paths?.project) {
      try {
        const rows = listVms(cfg.paths.project)
        if (Array.isArray(rows)) return rows
      } catch {}
    }
    return null
  }

  function loadApiEndpointInventoryForPoolAccess() {
    if (Array.isArray(deps.apiEndpoints)) return deps.apiEndpoints
    try {
      const rows = apiEndpointStore?.listRaw?.() ?? apiEndpointStore?.list?.()
      if (Array.isArray(rows)) return rows
    } catch {}
    return null
  }

  function loadGeminiOwnerMapForPoolAccess() {
    if (typeof deps.geminiOwnerMap === 'function') {
      try {
        return deps.geminiOwnerMap()
      } catch {}
    }
    return deps.geminiOwnerMap || null
  }

  function hasExplicitPoolIntent(req, { requestedPoolId = null, jevDowngradePoolId = null } = {}) {
    if (requestedPoolId || jevDowngradePoolId) return true
    const rec = req?.apiKeyRecord
    if (!rec) return false
    if (rec.pool_binding_mode === 'strict_pool') return true
    if (rec.default_pool_id) return true
    if (Array.isArray(rec.allowed_pool_ids) && rec.allowed_pool_ids.length > 0) return true
    return false
  }

  function resolveRequestPoolAccess(
    req,
    {
      model = null,
      ownerScope = null,
      jevDowngradePoolId = null,
      isTrustedDowngrade = false,
      trustedDowngradePoolIds = null,
      geminiEnvs = null,
    } = {},
  ) {
    const requestedPoolId = requestedPoolIdFromHeaders(req?.headers || {})
    const explicitIntent = hasExplicitPoolIntent(req, { requestedPoolId, jevDowngradePoolId })
    if (!deps.poolsRepo && !isDbOpen() && !explicitIntent) {
      return legacyPoolAccessResult()
    }
    const resolvedGeminiEnvs = Array.isArray(geminiEnvs)
      ? geminiEnvs
      : Array.isArray(deps.geminiEnvs)
        ? deps.geminiEnvs
        : null
    const resolvedGeminiOwnerMap = loadGeminiOwnerMapForPoolAccess()
    const access = resolvePoolAccessForKey({
      key: req?.apiKeyRecord || null,
      apiKeyKind: req?.apiKeyKind || null,
      requestedPoolId,
      jevDowngradePoolId,
      isTrustedDowngrade,
      trustedDowngradePoolIds,
      model,
      poolsRepo: deps.poolsRepo || null,
      vms: loadVmInventoryForPoolAccess(),
      geminiEnvs: resolvedGeminiEnvs,
      geminiOwnerMap: resolvedGeminiOwnerMap,
      apiEndpoints: loadApiEndpointInventoryForPoolAccess(),
      ownerScope,
    })
    return {
      ...access,
      _geminiOwnerMapChecked: Boolean(resolvedGeminiOwnerMap),
      _geminiEnvsChecked: Array.isArray(resolvedGeminiEnvs),
    }
  }

  function rejectPoolAccess(res, poolAccess, logBag, protocol = '') {
    stats.errors++
    const status = poolAccess?.status || 403
    const code = poolAccess?.code || 'pool_unavailable'
    const message = poolAccess?.message || '分组池不可用'
    logBag.error_code = code
    logBag.error_message = message
    logBag.final_state = 'policy_blocked'
    logBag.attempt_count = 0
    if (protocol === 'google.gemini') {
      return json(res, status, {
        error: {
          code: status,
          status: status === 403 ? 'PERMISSION_DENIED' : 'FAILED_PRECONDITION',
          message,
          details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: code }],
        },
      })
    }
    return json(
      res,
      status,
      makeError({
        type: ErrorType.PERMISSION,
        code,
        message,
        status,
      }).body,
    )
  }

  function refusalRepo() {
    if (deps.refusalGuards) return deps.refusalGuards
    try {
      return new RefusalGuardsRepo()
    } catch {
      return null
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

  function sessionRepo() {
    if (deps.refusalSessions) return deps.refusalSessions
    try {
      return new RefusalSessionBlocksRepo()
    } catch {
      return null
    }
  }

  /** An upstream content refusal ends the caller session for good (own switch, default on). */
  function blockRefusedSession({ inbound, body, headers, result, requestId, policy, sessions }) {
    if (policy?.session_block_enabled === false) return
    const sessionId = refusalSessionId({ inbound, body, headers })
    if (!sessionId) return
    try {
      sessions?.block?.({
        sessionId,
        requestId,
        accountId: result?.accountId || null,
        model: body?.model || inbound?.model || '',
        preview: refusalPreview(body, inbound),
        reason: 'upstream_refusal',
      })
    } catch {
      /* the refusal itself still goes back to the caller */
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
    cragPrint = false,
    preparedHop = null,
    callerCwd = null,
    repaired = false,
    dropSampling = false,
    strictPassthrough = false,
    safeguardsSanitized = false,
    requestContext = null,
    routing = {},
    noGoFallback = false,
    onEnvelope = null,
    onOutboundHeaders = null,
    redactionPrincipal = '',
    redactionSession = '',
    cancelSessionId = '',
    tenantId = '',
    gatewayRequestId = null,
  }) {
    const assembler = createClaudeMessageAssembler()
    const skipResponseHeaders = createResponseHeadersSseFilter()
    const workerResult = await dispatchStreamInference({
      exec: candidate.exec,
      admitCragInference: deps.admitCragInference,
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
      cragPrint,
      preparedHop,
      callerCwd,
      repaired,
      dropSampling,
      strictPassthrough,
      safeguardsSanitized,
      requestContext,
      slotWaitMs: candidate.slotWaitMs,
      slotWaitDeadlineMs: candidate.slotWaitDeadlineMs,
      tenantId,
      gatewayRequestId,
      noGoFallback,
      ensureCredential: (exec) => ensureWorkerCredential(exec),
      redactionPrincipal,
      redactionSession,
      cancelSessionId,
      onEnvelope,
      onOutboundHeaders,
      onEvent: async (line) => {
        if (skipResponseHeaders(line)) return
        applyClaudeSSELineToMessage(restoreToolNamesInSSELine(line, toolNames), assembler)
      },
    })
    Object.assign(workerResult, mergeAssembledAssistantHop(workerResult, assembler.message))
    if (workerResult?.body) {
      workerResult.body = restoreToolNames(workerResult.body, toolNames)
    }
    return acceptAssistantHop(workerResult)
  }

  async function handleProtocol(req, res, protocol, pathName, routeMeta = null) {
    const logCtx = requestLog.start(req, { protocol, pathName })
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
      upstream_type: null,
      error_details: null,
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
    let toolPruneAttempt = null
    let toolPruneClosed = false
    const discardToolPrune = () => {
      toolPruneClosed = true
      toolPruneAttempt?.rollback()
    }
    res.once('close', discardToolPrune)
    req.once('aborted', discardToolPrune)
    res.on('finish', () => {
      const usage = logBag.usage || {}
      toolPruneAttempt?.commit({
        verified: res.statusCode === 200 && logBag.final_state === 'verified',
        attemptCount: logBag.attempt_count,
        inputTokens:
          Number(usage.input_tokens || 0) +
          Number(usage.cache_read_tokens ?? usage.cache_read_input_tokens ?? 0) +
          Number(usage.cache_creation_tokens ?? usage.cache_creation_input_tokens ?? 0),
        outputTokens: Number(usage.output_tokens || 0),
      })
      try {
        const groupId = req.apiKeyRecord?.group_id ?? 1
        requestLog.finish(logCtx, {
          status: res.statusCode || 0,
          api_key_kind: req.apiKeyKind || null,
          api_key_id: req.apiKeyRecord?.id || null,
          user_id: req.apiKeyRecord?.user_id ?? null,
          group_id: groupId,
          rate_multiplier: deps.groupsRepo.rateMultiplier(groupId),
          ...logBag,
        })
      } catch {}
    })
    if (!requireAuth(req, res)) {
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
    const gemPathMeta =
      protocol === 'google.gemini' ? parseGeminiGeneratePath(String(pathName || '').split('?')[0]) : null
    const effectiveRouteModel = routeMeta?.routeModel || gemPathMeta?.model || null
    const effectiveRouteStream =
      typeof routeMeta?.routeStream === 'boolean' ? routeMeta.routeStream : gemPathMeta?.stream === true
    if (
      protocol === 'google.gemini' &&
      effectiveRouteModel &&
      inbound &&
      typeof inbound === 'object' &&
      !Array.isArray(inbound)
    ) {
      if (!inbound.model) inbound = { ...inbound, model: effectiveRouteModel }
    }
    logBag.inbound_body = logCtx.mode === 'debug' ? inbound : null
    logBag.inbound_summary = summarizeBody(inbound)
    logBag.model = inbound?.model || effectiveRouteModel || null
    logBag.requested_model = inbound?.model || effectiveRouteModel || null
    logBag.stream = protocol === 'google.gemini' ? effectiveRouteStream : isClientStream(inbound, req.headers)
    logBag.has_tools = Array.isArray(inbound?.tools) && inbound.tools.length > 0
    const auditIdentity = refusalAuditIdentity({ inbound, headers: req.headers, principal: riskPrincipal(req) })
    logBag.session_id = sessionIdForLog(
      auditIdentity.sessionId || extractCallerSession({ inbound, headers: req.headers }),
    )
    logBag.inbound_device_id = sessionIdForLog(auditIdentity.deviceId)
    logBag.reasoning_effort = reasoningEffortOf(inbound)
    const fp = fingerprintRequest(req, inbound)
    const riskState = { policy: refusalPolicy(), repo: refusalRepo(), devices: deviceRepo(), sessions: sessionRepo() }
    const gateArgs = { req, inbound, fp, logBag, requestId: logCtx.request_id, res, identity: auditIdentity, riskState }

    // Bypass #3 closed: `/v1/messages` with a Gemini-scoped key must pass pool
    // Fail-Closed authorization AND unified pre-dispatch JEV BEFORE delegating.
    if (protocol === 'anthropic.messages' && req.apiKeyRecord?.group_type === 'gemini') {
      const bypassOwnerScope = ownerScopeFromRequest(req, apiKeyStore?.users)
      let bypassGeminiCatalog = null
      if (
        !Array.isArray(deps.geminiEnvs) &&
        typeof deps.geminiScheduler?.catalog === 'function' &&
        hasExplicitPoolIntent(req, { requestedPoolId: requestedPoolIdFromHeaders(req?.headers || {}) })
      ) {
        try {
          bypassGeminiCatalog = await deps.geminiScheduler.catalog({ ownerScope: bypassOwnerScope })
        } catch {}
      }
      const bypassPoolAccess = resolveRequestPoolAccess(req, {
        model: inbound?.model || null,
        ownerScope: bypassOwnerScope,
        geminiEnvs: Array.isArray(bypassGeminiCatalog?.accounts) ? bypassGeminiCatalog.accounts : null,
      })
      if (!bypassPoolAccess.ok) {
        return rejectPoolAccess(res, bypassPoolAccess, logBag, protocol)
      }
      req._poolAccess = bypassPoolAccess
      if (bypassPoolAccess.effectivePool?.id) {
        logBag.resolved_pool_id = bypassPoolAccess.effectivePool.id
      }
      if (bypassPoolAccess.effectivePool?.jev_profile) {
        req.poolJevProfile = bypassPoolAccess.effectivePool.jev_profile
      }
      if (
        await applyProtocolIntercept({
          ...gateArgs,
          body: inbound,
          poolJevProfile: bypassPoolAccess.effectivePool?.jev_profile || req.poolJevProfile || null,
          zeroInject: isPoolZeroInjectMode(bypassPoolAccess.effectivePool, getRouting() || {}, {
            nodeProvider: 'google',
          }),
          channel: 'gemini',
          enforceHardAndJev: true,
          backend: 'oauth',
          apiPlatform: false,
        })
      ) {
        return
      }
      req.body = inbound
      return deps.handleGeminiMessages(req, res, {
        logBag,
        logCtx,
        preDispatchDecision: req._preDispatchDecision || null,
        ...(bypassGeminiCatalog ? { catalogSnapshot: bypassGeminiCatalog } : {}),
      })
    }

    const rawInboundBackend = resolveInferenceBackend(req)
    const inboundKeyPolicy = req.apiKeyKind === 'managed' ? keyTierPolicyFromRecord(req.apiKeyRecord) : null
    if (
      req.apiKeyKind === 'managed' &&
      keyScopeFromRequest(req).group_type === 'all' &&
      rawInboundBackend !== 'api' &&
      isAntigravityRoutedModel(inbound?.model) &&
      (protocol === 'openai.chat' || protocol === 'openai.responses' || protocol === 'anthropic.messages') &&
      typeof (deps.handleGeminiPublic || deps.handleGeminiMessages) === 'function'
    ) {
      let preferGeminiApiChannel = false
      let preloadedGeminiCatalog = null
      if (rawInboundBackend === 'all') {
        const hasPinnedEndpoints =
          Boolean(inboundKeyPolicy?.api_endpoint_id) || (inboundKeyPolicy?.allowed_endpoints?.length || 0) > 0
        if (
          inboundKeyPolicy?.permission_tier === 'resource' &&
          inboundKeyPolicy.allowed_gemini_envs.length === 0 &&
          hasPinnedEndpoints
        ) {
          preferGeminiApiChannel = true
        } else if (apiScheduler?.pick) {
          const gemScope = {
            ownerScope: ownerScopeFromRequest(req, apiKeyStore?.users),
            allowedEnvIds:
              inboundKeyPolicy?.permission_tier === 'resource'
                ? inboundKeyPolicy.allowed_gemini_envs
                : inboundKeyPolicy?.allowed_gemini_envs?.length
                  ? inboundKeyPolicy.allowed_gemini_envs
                  : null,
          }
          let hasOwnedGeminiEnv = false
          if (typeof deps.geminiScheduler?.catalog === 'function') {
            try {
              const cat = await deps.geminiScheduler.catalog(gemScope)
              preloadedGeminiCatalog = cat
              hasOwnedGeminiEnv = Array.isArray(cat?.accounts) && cat.accounts.length > 0
            } catch {
              hasOwnedGeminiEnv = false
            }
          }
          if (!hasOwnedGeminiEnv) {
            const probe = (apiScheduler.matchEndpoints || apiScheduler.pick).call(
              apiScheduler,
              inbound?.model,
              Date.now(),
              apiScheduleScope(req, 'all', apiKeyStore?.users),
            )
            if (probe?.ok) preferGeminiApiChannel = true
          }
        }
      }
      if (!preferGeminiApiChannel) {
        // Bypass #4 closed: `all` key + Antigravity model must pass pool
        // Fail-Closed authorization AND unified pre-dispatch JEV BEFORE delegating.
        const bypassOwnerScope = ownerScopeFromRequest(req, apiKeyStore?.users)
        if (
          !preloadedGeminiCatalog &&
          !Array.isArray(deps.geminiEnvs) &&
          typeof deps.geminiScheduler?.catalog === 'function' &&
          hasExplicitPoolIntent(req, { requestedPoolId: requestedPoolIdFromHeaders(req?.headers || {}) })
        ) {
          try {
            preloadedGeminiCatalog = await deps.geminiScheduler.catalog({ ownerScope: bypassOwnerScope })
          } catch {}
        }
        const bypassPoolAccess = resolveRequestPoolAccess(req, {
          model: inbound?.model || null,
          ownerScope: bypassOwnerScope,
          geminiEnvs: Array.isArray(preloadedGeminiCatalog?.accounts) ? preloadedGeminiCatalog.accounts : null,
        })
        if (!bypassPoolAccess.ok) {
          return rejectPoolAccess(res, bypassPoolAccess, logBag, protocol)
        }
        req._poolAccess = bypassPoolAccess
        if (bypassPoolAccess.effectivePool?.id) {
          logBag.resolved_pool_id = bypassPoolAccess.effectivePool.id
        }
        if (bypassPoolAccess.effectivePool?.jev_profile) {
          req.poolJevProfile = bypassPoolAccess.effectivePool.jev_profile
        }
        if (
          await applyProtocolIntercept({
            ...gateArgs,
            body: inbound,
            poolJevProfile: bypassPoolAccess.effectivePool?.jev_profile || req.poolJevProfile || null,
            zeroInject: isPoolZeroInjectMode(bypassPoolAccess.effectivePool, getRouting() || {}, {
              nodeProvider: 'google',
            }),
            channel: 'gemini',
            enforceHardAndJev: true,
            backend: 'oauth',
            apiPlatform: false,
          })
        ) {
          return
        }
        req.body = inbound
        return (deps.handleGeminiPublic || deps.handleGeminiMessages)(req, res, {
          logBag,
          logCtx,
          preDispatchDecision: req._preDispatchDecision || null,
          ...(preloadedGeminiCatalog ? { catalogSnapshot: preloadedGeminiCatalog } : {}),
        })
      }
    }

    // Before the health probe: its synthesized or fail-closed replies would otherwise answer
    // probe-shaped third-party traffic, and with the switch on no probe is answered at all.
    // Official Claude Code only ever speaks Messages, so other inbound protocols on a Claude
    // model are third-party by construction. Master-key pinned calls are the panel's own
    // test chat and health monitor, not inbound clients. An admin's key may pin a slot too,
    // but it stays an inbound client: same client gate, same owner and key scope.
    const routingNow = getRouting()
    const pinVmId = pinnedVmIdFromRequest(req, apiKeyStore?.users)
    const panelDiagnostics = req.apiKeyKind === 'master' && !!pinVmId
    if (
      claudeCodeOnlyFromRouting(routingNow) &&
      !panelDiagnostics &&
      protocol === 'anthropic.messages' &&
      isClaudeDesktopConnectionProbe(req.headers, inbound)
    ) {
      // Claude Desktop's gateway sign-in check: acknowledge the authenticated connection
      // locally. No account is picked and no model runs, so the fixed body spends nothing.
      stats.requests++
      stats.by_route[protocol] = (stats.by_route[protocol] || 0) + 1
      logBag.via = 'desktop-connection-probe'
      logBag.attempt_count = 0
      logBag.usage = { input_tokens: 0, output_tokens: 0 }
      logBag.stop_reason = 'end_turn'
      logBag.final_state = 'desktop-connection-probe'
      return json(res, 200, {
        id: `msg_probe_${logCtx.request_id}`,
        type: 'message',
        role: 'assistant',
        model: inbound.model,
        content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: logBag.usage,
      })
    }
    // After the Desktop sign-in probe, which runs no model.
    if (rejectKeyModel(req, res, protocol, inbound?.model, logBag)) return
    if (await applyProtocolIntercept({ ...gateArgs, body: inbound, mandatoryOnly: true })) return
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
      logBag.final_state = 'claude_code_only'
      logBag.error_code = ErrorCode.CLAUDE_CODE_ONLY
      logBag.error_message = errorResult.body?.error?.message || null
      res.statusCode = errorResult.status
      return json(res, errorResult.status, errorResult.body)
    }
    // Per-client switches, independent of claude_code_only: some clients run the official
    // CLI and append their own agent prompt, which Anthropic bills as a third-party app.
    const blockedClient =
      !panelDiagnostics && detectInboundPlatform(inbound?.model).platform === 'anthropic'
        ? blockedClientFor(inbound, routingNow)
        : null
    if (blockedClient) {
      stats.errors++
      const errorResult = blockedClientError(blockedClient)
      logBag.final_state = 'client_blocked'
      logBag.error_code = ErrorCode.CLIENT_BLOCKED
      logBag.error_message = errorResult.body?.error?.message || null
      res.statusCode = errorResult.status
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
        const wantHealthStream =
          protocol === 'google.gemini' ? routeMeta?.routeStream === true : isClientStream(inbound, req.headers)
        if (wantHealthStream) {
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

    const callerEnvironment = protocol === 'anthropic.messages' ? callerCwdDeclaration(inbound?.system) : null
    const autoCompactWindow = callerAutoCompactWindow(inbound)
    const { ctx: preparedCtx, legacyInboundIdentity } = prepareInboundProtocolContext({
      inbound,
      headers: req.headers,
      pathName,
      protocol,
      poolId:
        requestedPoolIdFromHeaders(req.headers) ||
        req.apiKeyRecord?.default_pool_id ||
        req.apiKeyRecord?.vm_pool_id ||
        '',
      apiKeyId: req.apiKeyRecord?.id ?? '',
      seedPolicy: defaultSeedPolicy(),
      autoCompactWindow,
    })
    const outboundReqHeaders = preparedCtx.headers
    let ctx = preparedCtx
    ctx = applyIntercept(cfg.intercept.rules, 'before_convert', ctx)
    const bodyCheck = protocol === 'google.gemini' ? { ok: true } : validateRequestBody(protocol, ctx.body)
    if (!bodyCheck.ok) {
      stats.errors++
      const errorResult = bodyCheck.errorResult
      logBag.error_code = errorResult.body?.error?.code || 'invalid_request'
      logBag.error_message = errorResult.body?.error?.message || null
      return json(res, errorResult.status, errorResult.body)
    }
    const rawBackend = resolveInferenceBackend(req)
    const reqOwnerScope = panelDiagnostics ? { type: 'any' } : ownerScopeFromRequest(req, apiKeyStore?.users)
    let keyScope = keyScopeFromRequest(req)
    if (inboundKeyPolicy) {
      keyScope = { ...keyScope, permission_tier: inboundKeyPolicy.permission_tier }
    }
    // Step [2]: Fail-Closed pool authorization & effectivePool pre-evaluation
    // strictly BEFORE JEV (Step [4]) and slot/endpoint admission.
    let activePoolAccess = resolveRequestPoolAccess(req, {
      model: ctx.body?.model || inbound?.model || null,
      ownerScope: reqOwnerScope,
    })
    if (
      !activePoolAccess.ok &&
      activePoolAccess.reason === 'missing' &&
      req.apiKeyRecord?.pool_binding_mode !== 'strict_pool' &&
      !req.apiKeyRecord?.default_pool_id &&
      !(Array.isArray(req.apiKeyRecord?.allowed_pool_ids) && req.apiKeyRecord.allowed_pool_ids.length) &&
      !requestedPoolIdFromHeaders(req.headers) &&
      keyScope.vm_pool_id &&
      !keyScope.vm_pool_error
    ) {
      activePoolAccess = legacyPoolAccessResult()
    }
    if (!activePoolAccess.ok) {
      return rejectPoolAccess(res, activePoolAccess, logBag, protocol)
    }
    let effectivePool = activePoolAccess.effectivePool || null
    req._poolAccess = activePoolAccess
    if (effectivePool) {
      logBag.resolved_pool_id = effectivePool.id
      if (effectivePool.jev_profile) {
        req.poolJevProfile = effectivePool.jev_profile
      }
      if (!activePoolAccess.legacy) {
        keyScope = {
          ...keyScope,
          vm_pool_id: effectivePool.id,
          vm_pool_error: null,
          allowed_vms: activePoolAccess.allowedVmIds || [],
          ...(effectivePool.jev_profile ? { jev_profile: effectivePool.jev_profile } : {}),
        }
        if (effectivePool.id && !ctx.inboundIdentity?.poolId) {
          ctx = {
            ...ctx,
            inboundIdentity: { ...ctx.inboundIdentity, poolId: effectivePool.id },
          }
        }
      }
    }
    let inferenceBackend = rawBackend === 'api' ? 'api' : 'oauth'
    let apiScope = rawBackend === 'api' ? apiScheduleScope(req, keyScope.group_type, apiKeyStore?.users) : null
    if (!activePoolAccess.legacy && apiScope) {
      apiScope = {
        ...apiScope,
        allowedEndpointIds: intersectAllowedIds(apiScope.allowedEndpointIds, activePoolAccess.allowedEndpointIds || []),
      }
    }
    if (rawBackend === 'api') {
      if (reqOwnerScope.type !== 'platform' && !apiScheduler?.hasOwnedEndpoints?.(reqOwnerScope, apiScope)) {
        stats.errors++
        const errorResult = makeError({
          type: ErrorType.PERMISSION,
          code: ErrorCode.API_BACKEND_FORBIDDEN,
          message: '租户密钥只能调用自己名下的槽位或 API 渠道',
          status: 403,
        })
        logBag.error_code = ErrorCode.API_BACKEND_FORBIDDEN
        logBag.error_message = errorResult.body?.error?.message || null
        return json(res, 403, errorResult.body)
      }
    } else if (rawBackend === 'all') {
      let candidateApiScope = apiScheduleScope(req, keyScope.group_type, apiKeyStore?.users)
      if (!activePoolAccess.legacy) {
        candidateApiScope = {
          ...candidateApiScope,
          allowedEndpointIds: intersectAllowedIds(
            candidateApiScope.allowedEndpointIds,
            activePoolAccess.allowedEndpointIds || [],
          ),
        }
      }
      if (protocol === 'google.gemini') {
        inferenceBackend = 'api'
        apiScope = candidateApiScope
      } else if (
        !activePoolAccess.legacy &&
        (activePoolAccess.allowedVmIds?.length || 0) === 0 &&
        (activePoolAccess.allowedEndpointIds?.length || 0) > 0
      ) {
        inferenceBackend = 'api'
        apiScope = candidateApiScope
      } else if (apiScheduler?.hasOwnedEndpoints?.(reqOwnerScope, candidateApiScope)) {
        const detected = detectInboundPlatform(ctx.body?.model)
        const targetPlatform = detected?.ok ? detected.platform : null
        let hasOwnedVm = false
        const vmDeniedByResourcePin =
          keyScope.permission_tier === 'resource' && !keyScope.vm_pool_id && (keyScope.allowed_vms?.length || 0) === 0
        if (!vmDeniedByResourcePin && keyScope.group_type !== 'gemini' && cfg.paths?.project) {
          try {
            hasOwnedVm = listVms(cfg.paths.project).some(
              (vm) =>
                !vm.disabled &&
                vm.schedulable !== false &&
                vmMatchesOwnerScope(vm, reqOwnerScope) &&
                keyAllowsVm(keyScope, vm) &&
                (!targetPlatform || vmGroupType(vm) === targetPlatform),
            )
          } catch {
            hasOwnedVm = false
          }
        }
        if (!hasOwnedVm) {
          inferenceBackend = 'api'
          apiScope = candidateApiScope
        }
      }
    }
    let want1m = hasClaudeCode1mSuffix(inbound?.model) || hasClaudeCode1mSuffix(ctx.body?.model)
    const modelRewrite =
      inferenceBackend === 'api'
        ? { ok: true, mapped: false }
        : applyCodexInboundModelRewrite(ctx.body, getRouting() || {})
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
    // Image models are listed in /v1/models but are not chat models: they run on the Images endpoint.
    // API endpoint protocols own routing; apply model overrides before choosing the channel.
    if (inferenceBackend === 'api') ctx = applyIntercept(cfg.intercept.rules, 'before_upstream', ctx)
    let apiInbound = inferenceBackend === 'api' ? ctx.body : null
    // Pure read-only metadata lookup BEFORE JEV (zero slot reservation prior to JEV).
    let apiPicked = apiScope
      ? (apiScheduler.matchEndpoints || apiScheduler.pick).call(apiScheduler, ctx.body?.model, Date.now(), apiScope)
      : null
    if (
      apiPicked &&
      !apiPicked.ok &&
      apiPicked.code === 'no_ready_api_key' &&
      !activePoolAccess.legacy &&
      effectivePool?.fallback_pool_id &&
      !apiScope.endpointId
    ) {
      // Allow Stage 4 fallback_pool_id endpoints owned by the same scope when originPool keys are cooling down.
      apiPicked = (apiScheduler.matchEndpoints || apiScheduler.pick).call(apiScheduler, ctx.body?.model, Date.now(), {
        ...apiScope,
        allowedEndpointIds: null,
      })
    }
    if (apiPicked && !apiPicked.ok) {
      stats.errors++
      logBag.error_code = apiPicked.code
      logBag.error_message = apiPicked.message
      return json(res, apiPicked.code === 'model_not_found' ? 404 : 503, {
        type: 'error',
        error: { type: 'api_error', code: apiPicked.code, message: apiPicked.message },
      })
    }
    const imageModel = inferenceBackend === 'api' ? null : canonicalImageToolModel(ctx.body?.model)
    const platform = apiPicked
      ? {
          ok: true,
          platform:
            apiPicked.endpoint.protocol === 'openai'
              ? 'openai'
              : apiPicked.endpoint.protocol === 'gemini'
                ? 'gemini'
                : 'anthropic',
        }
      : imageModel
        ? { ok: true, platform: 'openai' }
        : detectInboundPlatform(ctx.body?.model)
    const pfMode = protoFrontMode()
    const apiOpenAI = inferenceBackend === 'api' && platform.platform === 'openai'
    const apiGemini = inferenceBackend === 'api' && platform.platform === 'gemini'
    const apiNonAnthropic = apiOpenAI || apiGemini
    if (protocol === 'google.gemini' && !apiGemini && pfMode !== 'go') {
      stats.errors++
      logBag.error_code = 'gemini_unsupported_protocol'
      logBag.error_message = 'Native Gemini endpoints require a Gemini API channel.'
      return json(res, 400, {
        error: {
          code: 400,
          status: 'INVALID_ARGUMENT',
          message: logBag.error_message,
          details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: logBag.error_code }],
        },
      })
    }
    const apiInputError = apiOpenAI ? validateApiOpenAIRequest(protocol, apiInbound) : null
    if (apiInputError) {
      stats.errors++
      logBag.error_code = apiInputError.code
      logBag.error_message = apiInputError.message
      return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', ...apiInputError } })
    }
    const apiRiskReview = apiPicked?.endpoint.risk_review_enabled === true
    const preReviewEnabled =
      !apiPicked ||
      apiOpenAI ||
      apiRiskReview ||
      !!riskState.policy.risk_audit.downgrade_endpoint ||
      !!riskState.policy.risk_audit.downgrade_model
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
    if (platform.platform === 'anthropic') {
      try {
        validateImageDimensions(ctx.body)
      } catch (error) {
        if (!error.body?.error) throw error
        stats.errors++
        logBag.attempt_count = 0
        logBag.final_state = 'invalid_request'
        logBag.error_code = error.body.error.code
        logBag.error_message = error.body.error.message
        return json(res, error.status, error.body)
      }
    }
    // Codex returns before conversion. Distill does not apply to OpenAI platform models; the rest
    // of the gate scans them only when jev.openai_platform_enabled is on or pool/scope matches.
    if (
      !imageModel &&
      platform.platform !== 'openai' &&
      inferenceBackend !== 'api' &&
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
    const auditBody = ctx.body
    const earlyBodyCtx = createRequestBodyContext(auditBody)
    const candidateAccounts =
      inferenceBackend === 'api' || imageModel
        ? null
        : projectCandidateAccounts({
            projectRoot: cfg.paths?.project,
            keyScope,
            ownerScope: reqOwnerScope,
            platform: platform.platform,
            accountQuota,
          })
    const gateChannel = imageModel
      ? 'images'
      : protocol === 'google.gemini' || platform.platform === 'gemini'
        ? 'gemini'
        : platform.platform === 'openai'
          ? 'openai'
          : 'anthropic'
    const poolIsZeroInject = isPoolZeroInjectMode(effectivePool, getRouting() || {}, {
      nodeProvider: platform.platform,
      isInternalCall: Boolean(req.apiKeyKind === 'master' && isHealthRealBypass(req.headers)),
    })
    if (
      preReviewEnabled &&
      (await applyProtocolIntercept({
        ...gateArgs,
        body: auditBody,
        scopeMatched: apiRiskReview,
        candidateAccounts,
        poolJevProfile: effectivePool?.jev_profile || req.poolJevProfile || keyScope.jev_profile || null,
        zeroInject: poolIsZeroInject,
        channel: gateChannel,
        enforceHardAndJev: imageModel || gateChannel === 'gemini',
        skipDistill: Boolean(imageModel),
        bodyCtx: earlyBodyCtx,
        skipMandatory: true,
        backend: inferenceBackend,
        apiPlatform: imageModel ? false : apiPicked ? apiOpenAI : undefined,
      }))
    ) {
      return
    }
    if (imageModel) return serveImageModelTurn({ req, res, protocol, body: ctx.body, logBag, keyScope })
    let observedHop = false
    const afterHop = (result) => {
      observedHop = true
      const reason = observeUpstreamRisk({
        ...riskState,
        inbound,
        body: inbound,
        identity: auditIdentity,
        result,
        logBag,
        requestId: logCtx.request_id,
      })
      const sessionBlock = refusalSessionBlockDecision(reason, logBag.classifier)
      if (sessionBlock.skipped) logBag.risk_session_block_skipped = sessionBlock.skipped
      if (sessionBlock.block) {
        blockRefusedSession({
          inbound,
          body: inbound,
          headers: req.headers,
          result,
          requestId: logCtx.request_id,
          policy: riskState.policy,
          sessions: riskState.sessions,
        })
      }
      if (reason) {
        logBag.risk_upstream_reason = reason
        logBag.risk_request_id = logCtx.request_id
      }
      return reason
    }
    const route = logBag.risk_route
    if (route) {
      const unavailable = () => {
        stats.errors++
        logBag.error_code = 'risk_route_unavailable'
        logBag.error_message = '审核指定的降级路线不可用；未使用原路线。'
        return json(
          res,
          503,
          makeError({
            type: ErrorType.OVERLOADED,
            code: logBag.error_code,
            message: logBag.error_message,
            status: 503,
          }).body,
        )
      }
      if (route.kind === 'pool') {
        const pin = pinVmId || ''
        const owner = panelDiagnostics ? { type: 'any' } : ownerScopeFromRequest(req, apiKeyStore?.users)
        const preDecision = req._preDispatchDecision
        const isTrustedDowngrade =
          isTrustedGateDecision(preDecision) &&
          preDecision.action === 'downgrade' &&
          preDecision.jev_downgrade_pool_id === route.target
        const trustedDowngradePoolIds = [riskState.policy?.risk_audit?.downgrade_pool].filter(Boolean)
        let handledBySchedulerPool = false
        if (isTrustedDowngrade && (!activePoolAccess.legacy || deps.poolsRepo || isDbOpen())) {
          const downgradedAccess = resolveRequestPoolAccess(req, {
            model: ctx.body?.model || inbound?.model || null,
            ownerScope: owner,
            jevDowngradePoolId: route.target,
            isTrustedDowngrade: true,
            trustedDowngradePoolIds,
          })
          if (downgradedAccess.ok && !downgradedAccess.legacy) {
            if (inferenceBackend === 'api') {
              const allowedEps = downgradedAccess.allowedEndpointIds || []
              if (!allowedEps.length) return unavailable()
              apiScope = { ...apiScope, allowedEndpointIds: allowedEps }
            } else {
              const platformVmIds =
                platform.platform === 'openai'
                  ? downgradedAccess.allowedCodexVmIds || []
                  : downgradedAccess.allowedClaudeVmIds || []
              if (!platformVmIds.length || (pin && !platformVmIds.includes(pin))) return unavailable()
              keyScope = {
                ...keyScope,
                vm_pool_id: route.target,
                vm_pool_error: null,
                allowed_vms: platformVmIds,
              }
            }
            activePoolAccess = downgradedAccess
            effectivePool = downgradedAccess.effectivePool
            req._poolAccess = downgradedAccess
            logBag.resolved_pool_id = effectivePool?.id || route.target
            logBag.is_downgraded = true
            logBag.jev_downgrade_pool_id = effectivePool?.id || route.target
            handledBySchedulerPool = true
          } else if (!activePoolAccess.legacy) {
            return unavailable()
          }
        }
        if (!handledBySchedulerPool) {
          if (!activePoolAccess.legacy) return unavailable()
          const narrowed = applyVmPool({ ...keyScope, vm_pool_id: route.target })
          const eligible = narrowed.allowed_vms.filter((id) => {
            const vm = getVm(cfg.paths.project, id)
            return (
              vm &&
              vmMatchesOwnerScope(vm, owner) &&
              keyAllowsVm({ ...narrowed, group_type: platform.platform }, vm) &&
              keyAllowsVm(keyScope, vm)
            )
          })
          if (narrowed.vm_pool_error || !eligible.length || (pin && !eligible.includes(pin))) return unavailable()
          keyScope = { ...narrowed, allowed_vms: eligible }
        }
      }
      if (route.kind === 'model') {
        if (keyModelError(req, route.target, { anthropic: protocol === 'anthropic.messages' })) return unavailable()
        if (inferenceBackend !== 'api') {
          const target = detectInboundPlatform(route.target)
          if (!target.ok || target.platform !== platform.platform || canonicalImageToolModel(route.target))
            return unavailable()
          want1m = hasClaudeCode1mSuffix(route.target)
        }
        ctx.body = { ...ctx.body, model: route.target }
        logBag.upstream_model = route.target
      }
      if (inferenceBackend === 'api') {
        if (apiScope.endpointId && route.kind === 'endpoint' && route.target !== apiScope.endpointId)
          return unavailable()
        if (
          route.kind === 'endpoint' &&
          Array.isArray(apiScope.allowedEndpointIds) &&
          !apiScope.allowedEndpointIds.includes(route.target)
        ) {
          return unavailable()
        }
        apiInbound = ctx.body
        apiPicked = (apiScheduler.matchEndpoints || apiScheduler.pick).call(apiScheduler, ctx.body.model, Date.now(), {
          groupType: platform.platform,
          endpointId: route.kind === 'endpoint' ? route.target : apiScope.endpointId,
          ownerScope: apiScope.ownerScope,
          allowedEndpointIds: apiScope.allowedEndpointIds,
        })
        if (!apiPicked.ok) return unavailable()
        if (apiOpenAI && validateApiOpenAIRequest(protocol, apiInbound)) return unavailable()
      }
    }
    if (platform.platform === 'openai' && inferenceBackend !== 'api') {
      const routing = getRouting() || {}
      const codexSticky = {
        cfg,
        requestStartedAt: logCtx.t0,
        stickyRouter,
        sessions: accountQuota?.sessions || null,
        body: ctx.body,
        ownerScope: ownerScopeFromRequest(req, apiKeyStore?.users),
        pinVmId,
        keyScope,
        afterHop,
        poolAccess: activePoolAccess,
        originPoolId: activePoolAccess.originPool?.id || effectivePool?.id || null,
        jevDowngradePoolId:
          logBag.jev_downgrade_pool_id || (activePoolAccess.isDowngraded ? effectivePool?.id || null : null),
        inboundIdentity: ctx.inboundIdentity,
        isAdminDiagnostic: panelDiagnostics,
        allowQueue: queueAllowedByHeaders(req.headers),
        schedulerRuntime: getSchedulerRuntime(req),
      }
      // Pre-dispatch JEV has already run before slot admission (zero Phase-3 inversion).
      if (protocol === 'anthropic.messages') {
        const codex = normalizeCodexRouting(routing.codex)
        return runWithCodexKey(req, res, logBag, () =>
          handleCodexProtocol({
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
            preDispatchDecision: req._preDispatchDecision || null,
            ops: deps.codexOps || {},
            ...codexSticky,
          }),
        )
      }
      return runWithCodexKey(req, res, logBag, () =>
        handleCodexProtocol({
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
          preDispatchDecision: req._preDispatchDecision || null,
          ops: deps.codexOps || {},
          ...codexSticky,
        }),
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
    const officialTraffic = officialInbound
    const requestContext = classifyClaudeRequestPurpose(inbound, { officialTraffic })
    const summarySession = agentSummarySession(inbound, { officialTraffic })
    const tenantPrincipal = authenticatedTenant(req)
    // Match on what the caller saw, before conversion, persona or outbound session rebuild.
    const publicSession =
      protocol === 'anthropic.messages' && !apiNonAnthropic && tenantPrincipal && !requestContext && !summarySession
        ? extractCallerSession({ inbound, headers: req.headers })
        : ''
    const replayScope = publicSession ? JSON.stringify([tenantPrincipal, publicSession, inbound.model]) : ''
    const rememberPublic = (content) => {
      if (replayScope && Array.isArray(content)) issuedTools.remember(replayScope, inbound.messages, content)
    }
    const sendPublicJson = (message, upstreamHeaders = null) => {
      const sent = json(res, 200, message, upstreamHeaders)
      if (message?.role === 'assistant' && message.type === 'message') rememberPublic(message.content)
      return sent
    }
    if (replayScope) ctx.body = issuedTools.restore(replayScope, ctx.body)
    // Recognition alone is not passthrough. Only the protocol-tab switch keeps
    // the Claude Code family body; every other inbound is rewritten below.
    let officialPassthrough = officialFamilyBodyPassthrough(officialInbound, getRouting())
    // Operator opt-in, per API endpoint: forward the caller's own identity and
    // billing blocks instead of preparing them for the configured persona (#1321).
    // Evaluated here on purpose -- after the risk/route pass may have re-picked
    // `apiPicked`, so the policy always comes from the endpoint actually used.
    // Never derived from caller input.
    const apiPoolPrompt =
      inferenceBackend === 'api'
        ? resolvePoolSystemPromptPolicy(effectivePool, getRouting() || {}, {
            nodeProvider: platform.platform,
            isInternalCall: Boolean(requestContext || (req.apiKeyKind === 'master' && isHealthRealBypass(req.headers))),
          })
        : null
    const preserveApiCallerBody =
      inferenceBackend === 'api' &&
      !apiNonAnthropic &&
      (apiPoolPrompt?.applies
        ? apiPoolPrompt.apiBodyPolicy === 'caller'
        : apiPicked?.endpoint?.body_policy === 'caller')
    const pfTarget =
      inferenceBackend === 'api'
        ? apiOpenAI
          ? 'api_openai'
          : apiGemini
            ? 'api_gemini'
            : 'api_anthropic'
        : 'claude_crag'
    let pfCompile = null
    if (pfMode === 'go' && !apiGemini && !apiOpenAI) {
      try {
        pfCompile = await compileWithProtoFront({
          cfg,
          inboundProtocol: protocol,
          targetFamily: pfTarget,
          handoffMode: 'canonical',
          reqPath: pathName,
          headers: outboundReqHeaders,
          body: ctx.body,
          routing: getRouting() || {},
          endpointBodyPolicy: apiPicked?.endpoint?.body_policy || '',
          routeModel: effectiveRouteModel || ctx.body?.model || '',
          routeStream: protocol === 'google.gemini' ? effectiveRouteStream : undefined,
        })
        if (pfCompile) {
          if (inferenceBackend !== 'api' && pfCompile.decision) {
            officialPassthrough = pfCompile.decision.allow_passthrough === true
          }
          logBag.hop_meta = {
            ...logBag.hop_meta,
            proto_front: {
              mode: pfCompile.mode || null,
              decision: pfCompile.decision || null,
              stripped_fields: pfCompile.stripped_fields || [],
            },
          }
        }
      } catch (err) {
        logBag.hop_meta = { ...logBag.hop_meta, proto_front_error: err?.code || err?.message || 'error' }
      }
    } else if (pfMode === 'shadow' && !apiGemini && !apiOpenAI) {
      void compileWithProtoFront({
        cfg,
        inboundProtocol: protocol,
        targetFamily: pfTarget,
        handoffMode: 'canonical',
        reqPath: pathName,
        headers: outboundReqHeaders,
        body: ctx.body,
        routing: getRouting() || {},
        endpointBodyPolicy: apiPicked?.endpoint?.body_policy || '',
        routeModel: effectiveRouteModel || ctx.body?.model || '',
        routeStream: protocol === 'google.gemini' ? effectiveRouteStream : undefined,
      })
        .then((shadowRes) => {
          logBag.hop_meta = {
            ...logBag.hop_meta,
            proto_front_shadow: { ok: shadowRes?.ok === true, mode: shadowRes?.mode, decision: shadowRes?.decision },
          }
        })
        .catch(() => {})
    }
    const strictPassthroughAtIngress =
      inferenceBackend !== 'api' &&
      !requestContext &&
      protocol === 'anthropic.messages' &&
      cragStrictPassthroughEnabled(officialPassthrough, getRouting())
    let converted
    try {
      if (pfMode === 'go' && !apiGemini && !apiOpenAI && pfCompile) {
        if (!pfCompile.ok) {
          stats.errors++
          logBag.error_code = pfCompile.code || 'invalid_messages_conversion'
          logBag.error_message = pfCompile.error_body?.error?.message || 'Protocol conversion failed'
          return json(
            res,
            pfCompile.status || 400,
            pfCompile.error_body || { error: { code: logBag.error_code, message: logBag.error_message } },
          )
        }
        const goBody = pfCompile.outbound_body
        if (!goBody.max_tokens) goBody.max_tokens = defaultMaxTokensForModel(goBody.model)
        if (protocol === 'openai.responses') normalizeThinkingByPolicy(goBody)
        if (inferenceBackend !== 'api' && !officialPassthrough && Array.isArray(goBody.system)) {
          const track = trackCallerSystemBlock(ctx.body?.system, callerEnvironment)
          if (typeof track === 'function') {
            for (let i = 0; i < goBody.system.length; i++) {
              track(goBody.system[i], Array.isArray(ctx.body?.system) ? ctx.body.system[i] : ctx.body?.system)
            }
          }
        }
        converted = { claude: goBody, mode: pfCompile.mode === 'passthrough' ? 'passthrough' : 'convert' }
      } else {
        converted =
          apiGemini || apiOpenAI
            ? { claude: ctx.body, mode: 'passthrough' }
            : toClaudeMessages(protocol, ctx.body, {
                rewrite: rewriteEnabled,
                model_map: false,
                preserve_content_shape: officialPassthrough,
                strict_passthrough: strictPassthroughAtIngress,
                onSystemBlock:
                  inferenceBackend !== 'api' && !officialPassthrough
                    ? trackCallerSystemBlock(ctx.body?.system, callerEnvironment)
                    : undefined,
              })
      }
    } catch (error) {
      if (
        !['invalid_responses_conversion', 'invalid_messages_conversion', 'thinking_incompatible'].includes(error.code)
      )
        throw error
      stats.errors++
      logBag.error_code = error.code
      logBag.error_message = error.body.error.message
      return json(res, error.status, error.body)
    }
    stats.requests++
    stats.by_route[protocol] = (stats.by_route[protocol] || 0) + 1
    if (converted.mode === 'passthrough') stats.passthrough++
    else if (converted.mode === 'rewrite') stats.rewrite++
    else stats.convert++

    ctx = { ...ctx, body: converted.claude }
    if (inferenceBackend !== 'api') {
      ctx = applyIntercept(cfg.intercept.rules, 'before_upstream', ctx)
      if (route?.kind === 'model') ctx.body = { ...ctx.body, model: validateOfficialModel(route.target).model }
    }
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
    } else if (!apiNonAnthropic) {
      // Classify against the original budget, before the floor and persona add content.
      // The health monitor can carry a longer diagnostic marker than an external short probe.
      if (
        !officialPassthrough &&
        !Object.hasOwn(ctx.body, 'thinking') &&
        !ctx.body.system?.length &&
        /^claude-haiku-4-5(?:-|$)/i.test(ctx.body.model || '') &&
        Number.isInteger(inbound.max_tokens) &&
        inbound.max_tokens > 0 &&
        inbound.max_tokens <= 64 &&
        (isShortProbeRequest(inbound) ||
          (isHealthRealBypass(req.headers) &&
            !ctx.body.tools?.length &&
            ctx.body.messages?.length === 1 &&
            ctx.body.messages[0]?.role === 'user'))
      ) {
        ctx.body = { ...ctx.body, thinking: { type: 'disabled' } }
      }
      if (!strictPassthroughAtIngress) {
        ctx.body = applyMinMaxTokens(ctx.body, getRouting()?.compatibility?.min_max_tokens)
      }
    }
    let inboundToolReverse = {}
    const deferToolNameRewrite =
      (protocol === 'anthropic.messages' && inferenceBackend !== 'api') || protocol === 'openai.responses'
    let cragSystem = projectCallerSystem(ctx.body.system, callerEnvironment)
    const hasCragSystem = cragSystem !== ctx.body.system
    try {
      if (!preserveApiCallerBody && !apiNonAnthropic && !requestContext && !officialPassthrough) {
        const standard = toStandardAnthropicBody(ctx.body, {
          official: officialTraffic === true,
          rewriteTools: getRouting()?.compatibility?.tool_name_rewrite !== false,
          preserveToolNames: deferToolNameRewrite,
          reuseCanonicalHistory: inferenceBackend !== 'api',
        })
        ctx.body = standard.body
        inboundToolReverse = standard.reverse
      }
      if (!apiGemini && !strictPassthroughAtIngress) {
        validateBetweenToolsThinking(ctx.body)
        validateToolChoice(ctx.body)
      }
    } catch (error) {
      if (!error.body?.error) throw error
      stats.errors++
      logBag.error_code = error.body.error.code
      logBag.error_message = error.body.error.message
      return json(res, error.status, error.body)
    }
    if (!requestContext && officialPassthrough && !strictPassthroughAtIngress) {
      ctx.body = repairCacheBreakpoints(ctx.body, {
        limit: Number(getRouting()?.compatibility?.cache_control_limit) || 4,
        fallbackTtl: cacheTtlFromRouting(getRouting()),
        fillMissing: false,
      })
    }

    if (
      !toolPruneClosed &&
      !req.aborted &&
      !responseClosed(res) &&
      !requestContext &&
      inferenceBackend !== 'api' &&
      getRouting()?.compatibility?.preserve_pruned_tool_results === true
    ) {
      const scope = dshPruneScope({ headers: req.headers, apiKey: req.presentedApiKey })
      if (scope) {
        toolPruneAttempt = toolPruneCache.prepare({
          scope,
          body: ctx.body,
          contextWindow: Number(getCapabilities(ctx.body.model)?.context_window),
          maxBodyBytes: inboundBodyLimit(getRouting(), cfg.limits.max_body_bytes),
        })
        ctx.body = toolPruneAttempt.body
        logBag.hop_meta = {
          ...logBag.hop_meta,
          tool_result_prune: { restored: toolPruneAttempt.restored, reason: toolPruneAttempt.reason },
        }
      }
    }
    const bodyCtx = createRequestBodyContext(ctx.body)
    const officialClient = isOfficialClaudeClient(fp.client_class)
    const callerSession = extractCallerSession({ inbound, body: ctx.body, headers: req.headers })
    const executionSession = summarySession || callerSession
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
    // extracted before sanitizeInboundBody ran. API key never scopes it.
    const inboundIdentity = legacyInboundIdentity
    const stickyDeviceId = inboundIdentity.deviceId
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
    // One-shot account and channel tests keep their sticky identity without
    // holding a session seat the main conversation needs.
    const seatless = isProbe || isShortProbeRequest(inbound)
    // Seat = this client session. Same device, other session = other slot.
    let seatKey = seatless
      ? null
      : summarySession
        ? `seat:sess:${summarySession}`
        : resolveSeatIdentity({ inbound, body: ctx.body, headers: req.headers, clientIp: clientIp(req) }).key
    // Summary forks retain parent affinity, but must not migrate/bind its
    // aliases or join its serialization queue while the parent is streaming.
    const sessionKeys = summarySession
      ? { stickyKey: null, stickyKeys: [] }
      : stickyRouter?.sessionPoolKeys
        ? stickyRouter.sessionPoolKeys(req, inbound, {
            sessionId: inboundIdentity.sessionId,
            deviceId: stickyDeviceId,
            migrate: !isProbe,
          })
        : {
            stickyKey: stickyRouter?.extractPoolKey?.(req, inbound, { platform: 'anthropic' }) || null,
            stickyKeys: stickyRouter?.collectPoolKeys?.(req, inbound, { platform: 'anthropic' }) || [],
          }
    // Sessionless batch traffic: stick (key, workload) to a small elastic group
    // of accounts instead of fanning out over the pool. See pool/batch-group.mjs.
    let batchPick = null
    let batchApplied = false
    const batchCfg = mergeBatchGroupConfig(getRouting()?.batch_group)
    if (
      batchGroupAppliesToKey(batchCfg, req.apiKeyRecord?.id) &&
      !seatless &&
      !summarySession &&
      !callerSession &&
      !stickyDeviceId &&
      seatKey
    ) {
      const workload = String(req.headers['x-heyroute-user'] || '').trim()
      const groupKey = batchGroupKey({
        keyId: req.apiKeyRecord?.id,
        seatKey,
        workloadId: /^[A-Za-z0-9_-]{8,128}$/.test(workload) ? workload : '',
      })
      if (groupKey) {
        batchPick = getBatchGroups().acquire(groupKey, batchCfg)
        res.once('close', batchPick.release)
        logBag.batch_member = `${groupKey}#${batchPick.index}${batchCfg.observe ? ' (observe)' : ''}`
        if (!batchCfg.observe) {
          batchApplied = true
          seatKey = batchMemberSeatKey(groupKey, batchPick.index)
        }
      }
    }
    const batchStickyKey = batchApplied ? scopeStickyKey(batchPick.memberKey, 'anthropic') : null
    const stickyKey = batchStickyKey || sessionKeys.stickyKey || null
    const stickyKeys = batchStickyKey ? [batchStickyKey] : sessionKeys.stickyKeys || []
    const deviceKey = stickyDeviceId ? stickyRouter?.canonicalDeviceKey?.(stickyDeviceId) || null : null
    const parentSession = explicitParentSessionId(inbound, req.headers)
    const familySession = parentSession || callerSession
    const familyTrusted =
      !!parentSession || (!!inboundIdentity.sessionId && familySession === inboundIdentity.sessionId)
    const familyKey = !familySession
      ? null
      : stickyRouter?.familyPoolKey
        ? stickyRouter.familyPoolKey(req, familySession, { trusted: familyTrusted })
        : stickyRouter?.familyKey?.(req, familySession, 'anthropic') || null
    const familyVmId = familyKey ? stickyRouter?.resolve?.(familyKey)?.vmId || null : null
    const stickyBound =
      stickyKey && typeof stickyRouter?.resolve === 'function' ? stickyRouter.resolve(stickyKey) : null
    const outboundSessionId = resolveOutboundSessionId(executionSession, {
      ...sessionContext,
      accountId: stickyBound?.accountId || '',
      boundSessionId: stickyBound?.sessionId || '',
      boundAccountId: stickyBound?.accountId || '',
      boundVmId: stickyBound?.vmId || '',
      vmId: stickyBound?.vmId || '',
      epoch: 'pending',
    })
    let routingForCacheTtl = getRouting()
    try {
      const disk = routingConfigPath ? readJsonParsedCached(routingConfigPath) : null
      if (disk) routingForCacheTtl = disk
    } catch {}
    const requestedCacheTtl = pinConversationCacheTtl(
      stickyKey || callerSession || outboundSessionId,
      resolveCacheTtl({
        headers: req.headers,
        body: apiNonAnthropic ? inbound : ctx.body,
        routing: routingForCacheTtl,
        routingFile: routingConfigPath,
      }),
    )
    let cacheTtl = requestedCacheTtl
    let preserveCacheBreakpoints = false
    const cacheBreakpoints = cacheBreakpointsFromRoutingFile(routingConfigPath)
    const openaiCompat = String(protocol || '').startsWith('openai.')
    syncClaudeKernelConfigsFromFile(cfg.paths?.project, routingConfigPath)
    const personaMode = personaModeFromRoutingFile(routingConfigPath)
    if (!apiNonAnthropic && !requestContext && !officialClient && !officialTraffic) {
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
    if (!apiNonAnthropic && !strictPassthroughAtIngress) ctx.body = applyEagerToolStreaming(ctx.body, getRouting())
    // Fill omitted TTLs from the resolved Web/session default before rendering,
    // retaining explicit caller 5m/1h (and legal 1h → 5m). Official passthrough
    // and caller-policy API endpoints leave caller omissions untouched.
    if (!apiNonAnthropic && !requestContext && !officialPassthrough) {
      const cacheLimit = Number(getRouting()?.compatibility?.cache_control_limit) || 4
      if (!preserveApiCallerBody) {
        ctx.body = repairCacheBreakpoints(ctx.body, {
          limit: cacheLimit,
          fallbackTtl: requestedCacheTtl,
          fillMissing: true,
        })
        if (hasCragSystem) {
          cragSystem = repairCacheBreakpoints(
            { tools: ctx.body.tools, system: cragSystem },
            { limit: cacheLimit, fallbackTtl: requestedCacheTtl, fillMissing: true },
          ).system
        }
      } else {
        ctx.body = repairCacheBreakpoints(ctx.body, {
          limit: cacheLimit,
          fallbackTtl: requestedCacheTtl,
          fillMissing: false,
        })
      }
    }
    // Anthropic 400s a subscription request whose system field carries a third-party
    // agent prompt; the same text in the first user message is accepted.
    // Skip relocation when an explicit Anthropic pool policy (`zero_inject` /
    // `override` / `passthrough`) owns `system` directly.
    const preRelocatePoolPrompt = resolvePoolSystemPromptPolicy(effectivePool, getRouting() || {}, {
      nodeProvider: platform.platform,
      isInternalCall: Boolean(requestContext || (req.apiKeyKind === 'master' && isHealthRealBypass(req.headers))),
    })
    const preRelocateBody = ctx.body
    const preRelocateCragSystem = cragSystem
    const shouldRelocateForAttempt = (policy, routingSnap) =>
      !apiNonAnthropic &&
      inferenceBackend !== 'api' &&
      !requestContext &&
      !officialPassthrough &&
      !(policy?.applies && ['zero_inject', 'override', 'passthrough'].includes(policy.mode)) &&
      (!officialTraffic || hasForeignSystemBlock(preRelocateBody.system)) &&
      thirdPartyRelocateEnabled(routingSnap)
    let relocatedCache = null
    const getRelocatedForAttempt = () => {
      if (!relocatedCache) {
        const relocated = relocateThirdPartySystem(preRelocateBody, { onlyForeign: officialTraffic === true })
        let cragBody = null
        if (relocated.moved && hasCragSystem) {
          cragBody = relocateThirdPartySystem(
            { ...preRelocateBody, system: preRelocateCragSystem },
            { onlyForeign: officialTraffic === true },
          ).body
        }
        relocatedCache = {
          body: relocated.moved ? relocated.body : preRelocateBody,
          cragBody,
          moved: relocated.moved,
        }
      }
      return relocatedCache
    }
    if (shouldRelocateForAttempt(preRelocatePoolPrompt, getRouting())) {
      // Official traffic only gets here because the gate found a positively
      // foreign block, so move just that block: the real official envelope has
      // standalone harness/boundary/guidance blocks that the greedy predicate
      // would strip along with it.
      const relocated = getRelocatedForAttempt()
      if (relocated.moved) {
        ctx.body = relocated.body
      }
    }
    const personaIn = ctx.body
    // Capture ownership before rendering supplies gateway markers or projects
    // the caller's automatic cache policy onto a CLI message block.
    const preserveMessageCache =
      personaIn.cache_control != null ||
      // A zero template can interpolate cached caller system blocks into a
      // message. Those boundaries must remain caller-owned after rendering.
      (Array.isArray(personaIn.system) && personaIn.system.some((block) => block?.cache_control != null)) ||
      (Array.isArray(personaIn.messages) &&
        personaIn.messages.some(
          (message) => Array.isArray(message?.content) && message.content.some((block) => block?.cache_control != null),
        ))
    let personaHideTokens = 0
    const renderApiAttemptBody = (attemptPrompt) => {
      let attemptBody = shallowCopyBody(personaIn)
      const attemptPreserveCaller =
        !apiNonAnthropic && (attemptPrompt?.applies ? attemptPrompt.apiBodyPolicy === 'caller' : preserveApiCallerBody)
      if (!apiNonAnthropic && !requestContext) {
        if (attemptPrompt?.applies && attemptPrompt.mode === 'override') {
          attemptBody = applyPoolPromptToAnthropicBody(attemptBody, attemptPrompt)
        } else if (!attemptPreserveCaller) {
          attemptBody = applyCrsUnofficialPersona(attemptBody, {
            officialClient: officialPassthrough,
            forceConfigured: !officialPassthrough,
            ...(attemptPrompt?.applies && attemptPrompt.cliPreset ? { mode: attemptPrompt.cliPreset } : {}),
            routingFile: routingConfigPath,
            cacheTtl: requestedCacheTtl,
            headers: req.headers,
            sessionId: outboundSessionId,
            model: attemptBody?.model,
            cliVersion: OFFICIAL_CLI_VERSION,
          })
          if (attemptPrompt?.applies && attemptPrompt.mode === 'append') {
            attemptBody = applyPoolPromptToAnthropicBody(attemptBody, attemptPrompt)
          }
        }
      }
      if (!officialPassthrough && !requestContext && !apiGemini) {
        attemptBody = repairCacheBreakpoints(attemptBody, {
          limit: Number(getRouting()?.compatibility?.cache_control_limit) || 4,
          fallbackTtl: requestedCacheTtl,
          fillMissing: !attemptPreserveCaller,
        })
      }
      const apiEffectivePersonaMode =
        attemptPrompt?.applies && attemptPrompt.cliPreset ? attemptPrompt.cliPreset : personaMode
      const hideTokens =
        requestContext ||
        apiNonAnthropic ||
        attemptPreserveCaller ||
        personaUsagePassthroughFromRoutingFile(routingConfigPath, apiEffectivePersonaMode)
          ? 0
          : personaHideForUnofficial(personaIn, attemptBody, {
              officialClient: officialPassthrough,
              mode: apiEffectivePersonaMode,
              hides: personaHidesUsageFromRoutingFile(routingConfigPath, apiEffectivePersonaMode),
              standing: standingUsageFromRoutingFile(routingConfigPath, apiEffectivePersonaMode),
            })
      return { attemptBody, hideTokens }
    }

    if (inferenceBackend === 'api') {
      const managedKey = req.apiKeyRecord || null
      if (managedKey) {
        const gate = apiKeyStore.acquire(managedKey)
        if (!gate.ok) {
          stats.errors++
          return respondKeyGateError(res, gate)
        }
      }
      const clientAbort = bindClientAbort(req, res)
      const clientStream =
        protocol === 'google.gemini' ? routeMeta?.routeStream === true : isClientStream(inbound, req.headers)
      const publicStream = replayScope && clientStream && !apiNonAnthropic ? createIssuedToolStream() : null
      const requestedDelivery = String(
        req.headers['x-kin-delivery'] || getRouting()?.failover?.delivery_mode || 'realtime',
      )
      const deliveryMode = requestedDelivery === 'verified' ? 'verified' : 'realtime'
      logBag.via = 'api-kernel'
      cacheTtl = null

      const apiRt = getSchedulerRuntime(req)
      const apiAcquireScope = {
        groupType: route?.kind === 'endpoint' ? platform.platform : apiScope.groupType,
        endpointId: route?.kind === 'endpoint' ? route.target : apiScope.endpointId,
        ownerScope: apiScope.ownerScope,
        allowedEndpointIds: activePoolAccess.legacy ? apiScope.allowedEndpointIds : null,
      }
      const apiOriginPoolId = activePoolAccess.originPool?.id || effectivePool?.id || VIRTUAL_POOL_IDS.api
      const apiNoQueue = !queueAllowedByHeaders(req.headers)
      const apiMaxSwitches = Math.max(0, Number(getRouting()?.failover?.max_account_switches ?? 3))
      const excludedApiNodes = new Set()
      let activeApiLeaseId = null
      let activeApiSelection = null
      let apiAttempts = 0
      let apiFinalConvertedBody = ctx.body
      let result = null

      const isRetryableApiFailure = (r) => {
        if (!r || r.ok || res.headersSent || clientAbort.signal.aborted) return false
        const st = Number(r.upstreamStatus ?? r.status) || 0
        if (st === 0 || st === 408 || st === 429 || st === 529) return true
        return st >= 500 && st < 600
      }

      const sendApiSchedulerError = (err) => {
        stats.errors++
        if (err instanceof SchedulerUnavailableError || err?.code === 'scheduler_unavailable') {
          logBag.error_code = 'scheduler_unavailable'
          logBag.error_message = err?.message || 'Rust scheduler sidecar is unavailable'
          logBag.final_state = 'scheduler_unavailable'
          res.setHeader?.('retry-after', '1')
          return json(res, 503, {
            type: 'error',
            error: {
              type: 'api_error',
              code: 'scheduler_unavailable',
              message: logBag.error_message,
            },
          })
        }
        const formatted = formatSchedulerError(err)
        logBag.error_code = formatted.code
        logBag.error_message = formatted.body?.error?.message || null
        if (formatted.explain) logBag.scheduler_explain = formatted.explain
        logBag.final_state = formatted.status === 422 ? 'poison_abort' : 'failed'
        if (formatted.retryAfterSec != null) res.setHeader?.('retry-after', String(formatted.retryAfterSec))
        return json(res, formatted.status, formatted.body)
      }

      try {
        try {
          activeApiSelection = await apiScheduler.acquire(ctx.body?.model, {
            schedulerRuntime: apiRt,
            // Security: mint an unpredictable per-request UUID for Rust idempotency; never pass client X-Request-Id.
            requestId: crypto.randomUUID(),
            attemptNo: 1,
            originPoolId: apiOriginPoolId,
            jevDowngradePoolId:
              logBag.jev_downgrade_pool_id || (activePoolAccess.isDowngraded ? effectivePool?.id || null : null),
            apiKeyRecord: req.apiKeyRecord || null,
            apiKeyKind: req.apiKeyKind || null,
            poolAccess: activePoolAccess,
            ownerScope: apiAcquireScope.ownerScope,
            groupType: apiAcquireScope.groupType,
            endpointId: apiAcquireScope.endpointId,
            allowedEndpointIds: apiAcquireScope.allowedEndpointIds,
            protocol,
            inboundIdentity: summarySession
              ? {
                  ...(ctx.inboundIdentity || {}),
                  sessionId: summarySession,
                  sessionSource: 'summary_fork',
                  parentSessionId: ctx.inboundIdentity?.sessionId || null,
                  isEphemeralProbe: true,
                }
              : ctx.inboundIdentity,
            noQueue: apiNoQueue,
            isAdminDiagnostic: panelDiagnostics,
            signal: clientAbort.signal,
          })
        } catch (err) {
          if (clientAbort.signal.aborted || err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
            return finishClientCancel(res, { cancelled: true }, logBag)
          }
          return sendApiSchedulerError(err)
        }
        if (!activeApiSelection?.ok) {
          stats.errors++
          logBag.error_code = activeApiSelection?.code || 'no_ready_api_key'
          logBag.error_message = activeApiSelection?.message || 'No ready API endpoint'
          return json(res, activeApiSelection?.code === 'model_not_found' ? 404 : 503, {
            type: 'error',
            error: { type: 'api_error', code: logBag.error_code, message: logBag.error_message },
          })
        }
        activeApiLeaseId = activeApiSelection.leaseId
        if (activeApiSelection.resolvedPoolId) logBag.resolved_pool_id = activeApiSelection.resolvedPoolId

        for (;;) {
          apiAttempts += 1
          const attemptPrompt = resolveAttemptPoolPromptPolicy(
            activeApiSelection.promptPolicy,
            effectivePool,
            getRouting() || {},
            {
              nodeProvider: apiNonAnthropic ? platform.platform : 'anthropic',
              isInternalCall: Boolean(
                requestContext || (req.apiKeyKind === 'master' && isHealthRealBypass(req.headers)),
              ),
            },
          )
          logBag.prompt_policy = {
            mode: attemptPrompt.mode,
            source: attemptPrompt.source,
            pool_id: attemptPrompt.poolId,
          }
          const rendered = renderApiAttemptBody(attemptPrompt)
          apiFinalConvertedBody = rendered.attemptBody
          personaHideTokens = rendered.hideTokens

          result = await runApiInference({
            req,
            res,
            cfg,
            scheduler: apiScheduler,
            picked: activeApiSelection,
            store: apiEndpointStore,
            protocol,
            inbound: apiInbound,
            convertedBody: apiFinalConvertedBody,
            clientStream,
            deliveryMode,
            signal: clientAbort.signal,
            timeoutMs: cfg.limits.upstream_timeout_ms,
            personaHideTokens,
            cacheTtl,
            onPublicLine: publicStream ? (line) => publicStream.observe(line) : null,
            requestContext,
            passthrough: officialPassthrough,
            routing: getRouting(),
            redactionPrincipal: req.apiKeyRecord?.id || (req.apiKeyKind === 'master' ? 'master' : ''),
            redactionSession: String(req.headers?.['x-claude-code-session-id'] || ''),
            converters: {
              createClaudeMessageAssembler,
              applyClaudeSSELineToMessage,
              createOpenAIChatStreamState,
              claudeSSELineToOpenAIChatChunks,
              createOpenAICompletionStreamState,
              claudeSSELineToOpenAICompletionChunks,
              createResponsesStreamState: (model, id) => createResponsesStreamState(model, id, converted.responseTools),
              claudeSSELineToResponsesEvents,
              hidePersonaUsageInSseLine,
              writeSSEHeaders,
            },
          })

          if (result?.ok) {
            await apiScheduler.commitLease(activeApiLeaseId, { schedulerRuntime: apiRt }).catch(() => {})
            const lid = activeApiLeaseId
            activeApiLeaseId = null
            await apiScheduler
              .releaseLease(
                lid,
                {
                  outcome: 'ok',
                  http_status: Number(result.upstreamStatus) || 200,
                  ...(Number.isFinite(result.ttftMs) ? { ttft_ms: Math.max(0, Math.round(result.ttftMs)) } : {}),
                },
                { schedulerRuntime: apiRt },
              )
              .catch(() => {})
            break
          }

          const failStatus = Number(result?.upstreamStatus ?? result?.status) || 0
          const failCode = String(result?.body?.error?.code || 'upstream_error')
          const failMsg = String(result?.body?.error?.message || '').slice(0, 300)
          const failureReport = {
            http_status: failStatus,
            error_class: classifyErrorClass({
              status: failStatus,
              errorCode: failCode,
              reason: failMsg,
              isTransport: failStatus === 0,
            }),
            error_signature: failCode.slice(0, 128),
            ...(failMsg ? { error_message: failMsg } : {}),
          }

          if (!isRetryableApiFailure(result) || apiAttempts > apiMaxSwitches) {
            const lid = activeApiLeaseId
            activeApiLeaseId = null
            await apiScheduler
              .releaseLease(
                lid,
                {
                  outcome: clientAbort.signal.aborted
                    ? 'aborted'
                    : failureReport.error_class === 'timeout'
                      ? 'timeout'
                      : 'error',
                  http_status: failStatus || undefined,
                  error_class: failureReport.error_class,
                  error_signature: failureReport.error_signature,
                  error_message: failureReport.error_message,
                },
                { schedulerRuntime: apiRt },
              )
              .catch(() => {})
            break
          }

          if (activeApiSelection.nodeKey) excludedApiNodes.add(activeApiSelection.nodeKey)
          const prevLeaseId = activeApiLeaseId
          activeApiLeaseId = null
          try {
            const switched = await apiScheduler.switchEndpoint({
              schedulerRuntime: apiRt,
              releaseLeaseId: prevLeaseId,
              failure: failureReport,
              nextAttempt: {
                ...(activeApiSelection.acquireParams || {}),
                attemptNo: apiAttempts + 1,
                excludeNodes: [...excludedApiNodes],
              },
              requestedModel: ctx.body?.model,
              groupType: apiAcquireScope.groupType,
              endpointId: apiAcquireScope.endpointId,
              ownerScope: apiAcquireScope.ownerScope,
              allowedEndpointIds: apiAcquireScope.allowedEndpointIds,
              poolAccess: activePoolAccess,
              signal: clientAbort.signal,
            })
            if (!switched?.ok) break
            activeApiSelection = switched
            activeApiLeaseId = switched.leaseId
            if (switched.resolvedPoolId) logBag.resolved_pool_id = switched.resolvedPoolId
          } catch (switchErr) {
            if (clientAbort.signal.aborted || switchErr?.name === 'AbortError' || switchErr?.code === 'ABORT_ERR') {
              return finishClientCancel(res, { cancelled: true }, logBag)
            }
            if (
              switchErr instanceof SchedulerUnavailableError ||
              switchErr?.code === 'scheduler_unavailable' ||
              (switchErr instanceof SchedulerApiError &&
                (switchErr.code === 'poison_abort' || switchErr.status === 422))
            ) {
              return sendApiSchedulerError(switchErr)
            }
            break
          }
        }
      } finally {
        if (activeApiLeaseId) {
          const lid = activeApiLeaseId
          activeApiLeaseId = null
          await apiScheduler
            .releaseLease(
              lid,
              { outcome: clientAbort.signal.aborted ? 'aborted' : 'error' },
              { schedulerRuntime: apiRt },
            )
            .catch(() => {})
        }
        clientAbort.settle()
        if (managedKey) {
          try {
            apiKeyStore.release(managedKey)
          } catch {}
        }
      }
      ctx.body = apiFinalConvertedBody
      // The api backend forwards the converted body untouched: its session is the outbound one.
      logBag.outbound_session_id = sessionIdForLog(sessionIdFromOutboundBody(ctx.body) || logBag.session_id)
      if (result?.outboundBody != null) {
        logBag.outbound_summary = summarizeBody(result.outboundBody)
        if (logCtx.capture_outbound) {
          logBag.outbound_body = result.outboundBody
          if (result.outboundBodySource) logBag.outbound_body_source = result.outboundBodySource
        }
      }
      if (apiGemini && logBag.outbound_headers_source === 'unavailable') {
        logBag.outbound_headers_source = null
      }
      if (result?.reasoningEffort) logBag.reasoning_effort = result.reasoningEffort
      if (result?.stopReason) logBag.stop_reason = result.stopReason
      logBag.account_id = result?.accountId || null
      logBag.final_account_id = result?.accountId || null
      logBag.upstream_status = result?.upstreamStatus ?? null
      logBag.usage = usageForLog(result?.usage || result?.body?.usage || null, { cacheTtl })
      logBag.upstream_model = result?.model || null
      // TTFT is generated content; the upstream window also includes hidden reasoning.
      logBag.first_token_ms = Number.isFinite(result?.firstTokenAt)
        ? Math.max(0, result.firstTokenAt - logCtx.t0)
        : (result?.ttftMs ?? null)
      logBag.first_byte_ms = Number.isFinite(result?.firstByteAt)
        ? Math.max(0, result.firstByteAt - logCtx.t0)
        : (result?.firstByteMs ?? null)
      logBag.generation_ms = result?.generationMs ?? null
      logBag.final_state = result?.terminalState || null
      logBag.attempt_count = apiAttempts || (result?.endpointId ? 1 : 0)
      if (result?.upstreamStatus != null) afterHop(result)
      attachPricing(logBag, {
        managedKey,
        rateMultiplier: deps.groupsRepo.rateMultiplier(managedKey?.group_id ?? 1),
        bill: !!(result?.ok && managedKey),
      })
      if (clientStream) {
        if (result?.ok && !logBag.risk_upstream_reason) rememberPublic(publicStream?.completedContent())
        if (isClientCancelledResult(result)) return finishClientCancel(res, result, logBag)
        if (!res.headersSent) {
          const mapped = mapProtocolClientError(result, logBag, 'api_pool_exhausted')
          if (!isClientCancelledResult(result)) stats.errors++
          return sendMapped(res, mapped)
        }
        if (logBag.risk_upstream_reason && !apiNonAnthropic && protocol !== 'anthropic.messages') {
          const mapped = mapProtocolClientError(result, logBag, 'upstream_error')
          res.write(`data: ${JSON.stringify(mapped.body)}\n\n`)
          return res.end()
        }
        if (result?.ok && protocol !== 'anthropic.messages' && !apiGemini) res.write('data: [DONE]\n\n')
        return res.end()
      }
      if (!result?.ok || logBag.risk_upstream_reason || (!apiGemini && isIncompleteAssistantMessage(result))) {
        if (isClientCancelledResult(result)) return finishClientCancel(res, result, logBag)
        const failed =
          !apiGemini && isIncompleteAssistantMessage(result) ? incompleteAssistantClientError(result) : result
        const mapped = mapProtocolClientError(failed, logBag, failed?.body?.error?.code || 'upstream_error')
        stats.errors++
        return sendMapped(res, mapped)
      }
      let output
      if (apiGemini) {
        output = result.body
      } else {
        const clientBody = hidePersonaUsageOnMessage(result.body, personaHideTokens)
        if (protocol === 'anthropic.messages') output = clientBody
        else if (protocol === 'openai.chat') output = fromClaudeToOpenAIChat(clientBody, inbound.model)
        else if (protocol === 'openai.completions') output = fromClaudeToOpenAICompletions(clientBody, inbound.model)
        else
          output = apiOpenAI
            ? result.body
            : fromClaudeToResponses(
                clientBody,
                inbound.model,
                result.endpointId,
                converted.mode,
                converted.responseTools,
              )
      }
      return sendPublicJson(output, result?.headers)
    }

    const canonicalBody = strictPassthroughAtIngress ? ctx.body : officialMessagesBody(ctx.body)
    const streamKeepaliveMs = Number(
      getRouting()?.failover?.stream_keepalive_ms ?? cfg.limits.stream_keepalive_ms ?? 15_000,
    )
    // First downstream byte during a queue wait. Short misses stay HTTP 429/529;
    // anything still waiting past this writes SSE so Cloudflare does not 524.
    const queueKeepaliveDelay = queueKeepaliveDelayMs(getRouting(), cfg.limits?.queue_keepalive_delay_ms)
    const streamIdleTimeoutMs = resolveStreamIdleTimeoutMs(getRouting(), cfg)
    const managedKey = req.apiKeyRecord || null
    const tenantId = tenantPrincipal ? hashKey(`crag-tenant:${tenantPrincipal}`) : ''
    if (managedKey) {
      const gate = apiKeyStore.acquire(managedKey)
      if (!gate.ok) {
        stats.errors++
        return respondKeyGateError(res, gate)
      }
    }

    const clientAbort = bindClientAbort(req, res)

    const clientStream = protocol === 'google.gemini' ? effectiveRouteStream : isClientStream(inbound, req.headers)
    const streamTracker = clientStream && protocol === 'anthropic.messages' ? createAnthropicStreamTracker() : null
    const anthropicSseErrorRemapper =
      clientStream && protocol === 'anthropic.messages'
        ? createAnthropicSseErrorRemapper({
            strictPassthrough: strictPassthroughAtIngress,
            isStarted: () => streamTracker?.hasStarted() === true,
            // The client is told to retry, so the real cause has to survive here or
            // it survives nowhere: this relay path sets no other logBag fields, and
            // a deterministic capture fault would otherwise read exactly like a
            // transient disconnect while the client retries into it.
            onRetryableTruncation: (payload, mapped) => {
              const raw = payload?.error || payload || {}
              logBag.client_error_type = 'rate_limit_error'
              logBag.truncation_reason = 'mid_stream_error'
              logBag.error_code = raw.code || raw.type || mapped?.body?.error?.code || logBag.error_code || null
              logBag.error_message = raw.message || mapped?.body?.error?.message || logBag.error_message || null
            },
          })
        : null
    // One keepalive for the whole Claude stream, including session/seat queues
    // and the gaps between failover attempts. OpenAI keeps its per-attempt one.
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
    const allowQueue = queueAllowedByHeaders(req.headers)
    // A master-key pin is panel test-chat / diagnostics (manage). Everything else is dispatch.
    const ownerScope = panelDiagnostics ? { type: 'any' } : ownerScopeFromRequest(req, apiKeyStore?.users)
    // Cache bypass is a client hint; only authenticated master-key probes may skip accounting.
    const healthReal = req.apiKeyKind === 'master' && isHealthRealBypass(req.headers)
    // Cache lives per account; a failover to another account starts cold by design.
    // The image floor follows the caller session across accounts, scoped to its key.
    // Returns the body to send: the image floor and break anchor may rewrite it.
    const imageKey = callerSession ? `${req.apiKeyRecord?.id || req.apiKeyKind || ''}:${callerSession}` : null
    const noteCachePrefix = (selected, sessionId, body) => {
      if (!sessionId) return body
      const key = `${selected.accountId}:${sessionId}`
      const { body: prepared, ...prefix } = prepareCachePrefix(key, body, Date.now(), {
        imageKey,
        preserveMessageCache,
        ctx: bodyCtx,
      }) || { body }
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
      if (envelope?.body) logBag.reasoning_effort = loggedReasoningEffort(envelope.body)
      logBag.worker_envelope_headers = envelope?.headers ? redactHeaders(envelope.headers) : null
      logBag.outbound_headers = null
      logBag.outbound_headers_source = 'unavailable'
    }
    const noteOutboundHeaders = (headers, extra = {}) => {
      if (!logCtx.capture_outbound) return
      logBag.outbound_headers = redactHeaders(headers)
      logBag.outbound_headers_source = 'cli_final'
      if (extra?.body != null) {
        logBag.outbound_body = extra.body
        logBag.outbound_body_source = 'cli_final'
        logBag.outbound_body_truncated = extra.body_truncated === true
      }
    }
    let result
    try {
      result = await getFailoverRunner().run({
        requestId: logCtx.request_id,
        canonicalBody,
        model: canonicalBody.model,
        stickyKey: isProbe ? null : stickyKey,
        stickyKeys: isProbe ? [] : stickyKeys,
        // Set only when a group member actually supplied the sticky key.
        batchMember: !isProbe && batchApplied,
        stickyDeviceId,
        inboundIdentity: summarySession
          ? {
              ...(ctx.inboundIdentity || {}),
              sessionId: summarySession,
              sessionSource: 'summary_fork',
              parentSessionId: ctx.inboundIdentity?.sessionId || null,
              isEphemeralProbe: true,
            }
          : ctx.inboundIdentity,
        deviceKey,
        skipSessionSeat: seatless,
        familyKey: summarySession ? null : familyKey,
        summarySession,
        rootSessionId: seatless && !summarySession ? null : subagentRootSession(inbound, req.headers, !!summarySession),
        seatKey,
        familyVmId,
        pinVmId,
        isAdminDiagnostic: panelDiagnostics,
        ownerScope,
        keyScope,
        apiKeyRecord: req.apiKeyRecord || null,
        apiKeyKind: req.apiKeyKind || null,
        poolAccess: activePoolAccess,
        originPoolId: activePoolAccess.originPool?.id || effectivePool?.id || null,
        jevDowngradePoolId:
          logBag.jev_downgrade_pool_id || (activePoolAccess.isDowngraded ? effectivePool?.id || null : null),
        protocol,
        schedulerRuntime: getSchedulerRuntime(req),
        countUsage: !healthReal,
        quotaRequest: {
          body: canonicalBody,
          sessionId: outboundSessionId || callerSession || stickyKey,
          preserveMessageCache,
          bodyCtx,
        },
        stream: upstreamStream,
        deliveryMode,
        allowQueue,
        signal: clientAbort.signal,
        applyAttempt: async (body, selected, extra = {}) => {
          const applyAccountThinkingFilter = (target) => {
            // Only this account's own thinking replays as thinking on non-CRAG
            // paths. Another account's signature, or one with no record, goes out as text.
            const owned = filterThinkingForAccount(target, selected.accountId, thinkingOwnerStore)
            if (owned.kept || owned.converted || owned.dropped) {
              const { kept, converted, dropped, unknown } = owned
              logBag.hop_meta = {
                ...logBag.hop_meta,
                thinking_owner: { account_id: selected.accountId, kept, converted, dropped, unknown },
              }
            }
            return owned.body
          }
          const attemptStartedAt = extra.attemptStartedAt ?? Date.now()
          // The runner snapshots after this session's queue turn, before VM prebinding.
          const attemptBound = extra.stickyBound
          const keptSession = extra.freshSlot ? '' : attemptBound?.sessionId || ''
          const keptAccount = extra.freshSlot ? '' : attemptBound?.accountId || ''
          const keptVm = extra.freshSlot ? '' : attemptBound?.vmId || ''
          const attemptSessionId = resolveOutboundSessionId(executionSession, {
            ...sessionContext,
            accountId: selected.accountId,
            boundSessionId: keptSession,
            boundAccountId: keptAccount,
            boundVmId: keptVm,
            vmId: selected.vmId,
            epoch: extra.freshSlot
              ? `slot:${selected.slotIndex ?? 'x'}:${attemptStartedAt}`
              : `${attemptStartedAt}:${selected.vmId || extra.attemptNo || ''}`,
          })
          const identity = loadVmIdentity(selected.exec)
          if (identity && attemptSessionId) identity.callerSessionId = attemptSessionId
          const credMode = credentialModeFromOauth(selected.vm?.claude || {})
          const modeOverride = slotPersonaModeOverride(selected.vm)
          let routingNow = getRouting()
          try {
            const disk = readJsonParsedCached(routingConfigPath)
            if (disk) routingNow = disk
          } catch {
            // A mid-write routing file keeps the in-memory snapshot for this request.
          }
          const entrypointNow = ccEntrypointFromRouting(routingNow)
          const repaired = extra.repaired === true
          // An upstream that refused the sampling fields themselves gets a retry
          // with none of them; the assembly rebuilds from caller input after the
          // repairs replay, so the decision has to ride along to it.
          const dropSampling = (extra.repairs || []).some((policy) => policy?.reason === 'sampling_repairable')
          const cacheControlRepaired = (extra.repairs || []).some(
            (policy) => policy?.reason === 'cache_control_repairable',
          )
          const thinkingRepaired =
            repaired &&
            !(extra.repairs || []).every((policy) =>
              ['cache_control_repairable', 'sampling_repairable', 'search_repairable'].includes(policy?.reason),
            )
          const preserveThinkingBlocks =
            !thinkingRepaired &&
            routingNow?.failover?.signature_repair !== true &&
            (!keptAccount || keptAccount === selected.accountId)
          // cli-node receives the cleaned body after this boundary. Keep every
          // thinking block on the first hop and only let a repaired retry strip it.
          const preserveCliHopThinkingBlocks = !thinkingRepaired
          const cliHop = resolveOfficialCcInference(selected.vm, routingNow) === 'cli-hop'
          const resolvedPersona = resolveSlotPersonaPreset(selected.vm, routingNow)
          const attemptPoolPrompt = resolveAttemptPoolPromptPolicy(selected.promptPolicy, effectivePool, routingNow, {
            nodeProvider: 'anthropic',
            isInternalCall: Boolean(requestContext || healthReal),
          })
          if (selected.resolvedPoolId) logBag.resolved_pool_id = selected.resolvedPoolId
          logBag.prompt_policy = {
            mode: attemptPoolPrompt.mode,
            source: attemptPoolPrompt.source,
            pool_id: attemptPoolPrompt.poolId,
          }
          const effectiveCliPersona =
            attemptPoolPrompt.applies && attemptPoolPrompt.cliPreset ? attemptPoolPrompt.cliPreset : resolvedPersona
          const preserveCallerEnvironment = !presetFlagEnabled(
            routingNow?.compatibility,
            'persona_env_presets',
            effectiveCliPersona,
          )
          const attemptPoolOwnsSystemDirectly =
            attemptPoolPrompt.applies && ['zero_inject', 'override', 'passthrough'].includes(attemptPoolPrompt.mode)
          const attemptNeedsRelocate = shouldRelocateForAttempt(attemptPoolPrompt, routingNow)
          const attemptPersonaIn = attemptPoolOwnsSystemDirectly
            ? preRelocateBody
            : attemptNeedsRelocate
              ? getRelocatedForAttempt().body
              : preRelocateBody
          let hopBody = body
          if (cliHop) {
            const transportRouting = getRouting()
            const preparedHop = await prepareInferenceHop({
              exec: selected.exec,
              admitCragInference: deps.admitCragInference,
              routing: transportRouting,
              slotWaitMs: selected.slotWaitMs,
              slotWaitDeadlineMs: selected.slotWaitDeadlineMs,
            })
            const cragPrint =
              !requestContext &&
              preparedHop.ready?.ok === true &&
              cragV2KernelActive({
                vm: selected.vm,
                health: preparedHop.ready.health,
                kernelConfig: readSlotKernelConfig(selected.exec?.homeDir),
              })
            if (cragPrint) {
              const cragPersona =
                attemptPoolPrompt.applies && attemptPoolPrompt.cragPreset
                  ? attemptPoolPrompt.cragPreset
                  : resolveCragPrintPersona(selected.vm, routingNow)
              const caps = preparedHop.ready.health?.capabilities
              const headlessBridge = isHeadlessBridgeCaps(caps)
              const strictPassthrough =
                !requestContext &&
                protocol === 'anthropic.messages' &&
                cragStrictPassthroughEnabled(officialPassthrough, routingNow)
              // CRAG V4 (headless_claude_bridge_v1) removed the claude CLI MCP
              // tool-wrapping layer while still advertising generation_controls_v3,
              // so vm2api must rewrite third-party tool names to mcp__<name> here.
              const preserveToolNames =
                deferToolNameRewrite && caps?.includes('generation_controls_v3') && !headlessBridge
              const customCragTemplate =
                headlessBridge && !officialPassthrough && !strictPassthrough
                  ? resolveCragCustomTemplate(selected.vm, routingNow, cragPersona)
                  : null
              const customCragTemplateUsesCallerSystem =
                customCragTemplate != null &&
                (customCragTemplate.preset === 'zero' ||
                  (Array.isArray(customCragTemplate.blocks) &&
                    customCragTemplate.blocks.some(
                      (block) =>
                        block?.id === 'caller_system' ||
                        /\{\{\s*(?:caller_system|caller_agent|agent_official)\s*\}\}/i.test(String(block?.text || '')),
                    )))
              const usePreRelocate =
                !officialPassthrough &&
                (attemptPoolOwnsSystemDirectly ||
                  (headlessBridge && (cragPersona === 'zero' || customCragTemplateUsesCallerSystem)))
              const attemptRelocated =
                !strictPassthrough && !usePreRelocate && attemptNeedsRelocate ? getRelocatedForAttempt() : null
              const cragInput = strictPassthrough
                ? personaIn
                : usePreRelocate
                  ? hasCragSystem
                    ? { ...preRelocateBody, system: preRelocateCragSystem }
                    : preRelocateBody
                  : attemptRelocated?.cragBody ||
                    (attemptRelocated?.moved
                      ? attemptRelocated.body
                      : hasCragSystem
                        ? { ...preRelocateBody, system: preRelocateCragSystem }
                        : preRelocateBody)
              const reuseHistory = !officialPassthrough && !repaired && !extra.repairs?.length
              const reuseIngress =
                reuseHistory &&
                preserveToolNames &&
                isNativeCragV3Plus(caps) &&
                !hasCragSystem &&
                !summarySession &&
                !toolPruneAttempt &&
                cragInput.thread == null &&
                (!Array.isArray(cragInput.system) ||
                  !cragInput.system.some((block) => /x-anthropic-billing-header:/i.test(block?.text || ''))) &&
                canReuseCanonicalHistory(cragInput.messages)
              const scrubOptions = {
                official: officialTraffic === true,
                rewriteTools: routingNow?.compatibility?.tool_name_rewrite !== false,
                preserveToolNames,
                shareUnchanged: reuseHistory,
              }
              let toolNames = inboundToolReverse
              let source = strictPassthrough ? shallowCopyBody(cragInput) : cragInput
              if (!strictPassthrough && !reuseIngress) {
                const standard = toStandardAnthropicBody(cragInput, {
                  ...scrubOptions,
                  reuseCanonicalHistory: reuseHistory,
                })
                source = shallowCopyBody(standard.body)
                toolNames = composeToolNames(toolNames, standard.reverse)
              }
              // The CRAG kernel fingerprints the public stream it already sent,
              // including thinking. Rewriting an unrecorded signature into text
              // makes the tool continuation fail with tool_result history mismatch.
              // Single SQLite pass per CRAG hop: when crag_drop_foreign_thinking is
              // enabled, dropForeignThinkingForCrag handles both dropping and foreign
              // signature counting; when 'off' (and not strictPassthrough),
              // inspectForeignThinking checks ownership read-only without cloning.
              const cragForeignMode = cragForeignThinkingMode(routingNow?.compatibility?.crag_drop_foreign_thinking)
              let cragOwned = { body: source, foreign: 0 }
              let foreignThinking = false
              if (cragForeignMode !== 'off') {
                cragOwned = dropForeignThinkingForCrag(source, selected.accountId, thinkingOwnerStore, {
                  mode: cragForeignMode,
                })
                source = cragOwned.body
                foreignThinking = !strictPassthrough && cragOwned.foreign > 0
                if (cragOwned.dropped || cragOwned.bailed) {
                  const { kept, unknownKept, dropped, droppedTurns, openLoop, thinkingOff, bailed } = cragOwned
                  logBag.hop_meta = {
                    ...logBag.hop_meta,
                    thinking_owner_crag: {
                      account_id: selected.accountId,
                      mode: cragForeignMode,
                      kept,
                      unknown_kept: unknownKept,
                      dropped,
                      dropped_turns: droppedTurns,
                      open_loop: openLoop,
                      thinking_off: thinkingOff,
                      bailed,
                    },
                  }
                }
              } else if (!strictPassthrough) {
                const inspected = inspectForeignThinking(source, selected.accountId, thinkingOwnerStore)
                foreignThinking = inspected.foreign > 0
                if (inspected.kept || inspected.foreign) {
                  logBag.hop_meta = {
                    ...logBag.hop_meta,
                    thinking_owner: {
                      account_id: selected.accountId,
                      kept: inspected.kept,
                      converted: 0,
                      dropped: 0,
                      unknown: inspected.unknown,
                      foreign: inspected.foreign,
                    },
                  }
                }
              }
              if (!strictPassthrough) {
                for (const policy of extra.repairs || []) source = repairAnthropicRequest(source, policy)
              }
              hopBody = prepareCragPrintBody(source, {
                preset: cragPersona,
                officialPassthrough: headlessBridge
                  ? officialPassthrough
                  : officialPassthrough && !cacheControlRepaired,
                capabilities: Array.isArray(caps) ? caps : [],
                health: preparedHop.ready.health || null,
                promptPolicy: attemptPoolPrompt.applies ? attemptPoolPrompt : null,
                agentSummary: !!summarySession,
                foldSystemMessages:
                  strictPassthrough || headlessBridge
                    ? false
                    : routingNow?.compatibility?.crag_fold_history_system !== false,
                strictPassthrough,
                routing: officialPassthrough ? null : routingNow,
                vm: selected.vm,
                identity,
                sessionId: attemptSessionId,
                entrypoint: entrypointNow,
                cacheTtl: requestedCacheTtl,
              })
              const poolBlocksCragEnv =
                attemptPoolPrompt.applies && ['zero_inject', 'passthrough'].includes(attemptPoolPrompt.mode)
              if (headlessBridge && !strictPassthrough && !officialPassthrough && !poolBlocksCragEnv) {
                const compat = canonicalPersonaCompat(routingNow?.compatibility || {})
                const envPreset = effectiveCliPersona
                const envEnabled = presetFlagEnabled(compat, 'persona_env_presets', envPreset)
                const tzEnabled = envEnabled && presetFlagEnabled(compat, 'persona_timezone_presets', envPreset)
                const localeEnabled = envEnabled && presetFlagEnabled(compat, 'persona_locale_presets', envPreset)
                const tz = tzEnabled ? configuredTimezone(selected.vm, {}) || configuredTimezone(identity, {}) : ''
                const loc = localeEnabled
                  ? String(
                      selected.vm?.locale ||
                        selected.vm?.fingerprint?.locale ||
                        identity?.locale ||
                        identity?.fingerprint?.locale ||
                        '',
                    ).trim()
                  : ''
                const cragEnv = sanitizeCragEnv({
                  ...(tz ? { timezone: tz } : {}),
                  ...(loc ? { locale: loc } : {}),
                  inject_if_missing: envEnabled,
                })
                if (cragEnv) hopBody.crag_env = cragEnv
              }
              if (!strictPassthrough && cacheControlRepaired && needsCragProviderCompatibility(hopBody, caps)) {
                hopBody = repairCacheBreakpoints(
                  applyCacheBreakpoints(hopBody, {
                    ttl: requestedCacheTtl,
                    config: cacheBreakpoints,
                  }),
                  {
                    limit: Number(routingNow?.compatibility?.cache_control_limit) || 4,
                    fallbackTtl: requestedCacheTtl,
                  },
                )
              }
              if (!strictPassthrough) {
                const materialized = await materializeRemoteImageSources(hopBody)
                if (materialized !== hopBody) {
                  validateImageDimensions(materialized)
                  hopBody = materialized
                }
              }
              const nativeCragV3 = isNativeCragV3Plus(caps)
              if (!strictPassthrough && identity && !nativeCragV3) {
                hopBody = applyCrsIdentityReplace(hopBody, identity, inbound, outboundReqHeaders, {
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
              if (
                !strictPassthrough &&
                caps?.includes('generation_controls_v3') &&
                hopBody.cache_ttl == null &&
                hopBody.crag_options?.cache_ttl == null
              ) {
                // Carry the resolved session/menu default separately from usage accounting.
                hopBody.cache_ttl = requestedCacheTtl
              }
              preserveCacheBreakpoints = strictPassthrough || (officialPassthrough && !cacheControlRepaired)
              cacheTtl = null
              personaHideTokens = 0
              logBag.inference_engine = resolveInferenceEngine(selected.vm, routingNow)
              logBag.persona_preset = cragPersona
              logBag.crag_print = {
                transport: preparedHop.ready.health?.transport,
                persona: cragPersona,
                prompt_mode: hopBody.crag_prompt?.mode || hopBody.crag_persona_preset || 'default',
                ...(attemptPoolPrompt.applies ? { pool_prompt_mode: attemptPoolPrompt.mode } : {}),
                strict_passthrough: strictPassthrough,
                safeguards_stripped: Boolean(personaIn.safeguards != null && hopBody.safeguards == null),
                ...(cacheControlRepaired ? { cache_control_repaired: true } : {}),
              }
              logBag.official_cc_inference = 'crag-print'
              logBag.provider = 'local_cli'
              if (!strictPassthrough) hopBody = noteCachePrefix(selected, attemptSessionId, hopBody)
              logBag.outbound_summary = summarizeBody(hopBody)
              logBag.outbound_session_id = sessionIdForLog(sessionIdFromOutboundBody(hopBody) || attemptSessionId)
              return {
                body: hopBody,
                meta: {
                  toolNames,
                  sessionId: attemptSessionId,
                  cliHop: true,
                  cragPrint: true,
                  strictPassthrough,
                  stripClientBeta:
                    headlessBridge &&
                    !strictPassthrough &&
                    !officialPassthrough &&
                    !(attemptPoolPrompt.applies && attemptPoolPrompt.mode === 'passthrough'),
                  safeguardsSanitized: !strictPassthrough,
                  // CRAG replays caller thinking unfiltered; signatures this pool never
                  // issued make an "Invalid signature" 400 safe to strip and retry.
                  foreignThinking,
                  callerCwd: callerEnvironment?.cwd,
                  preparedHop,
                  transportRouting,
                  requestContext,
                  // thinking was dropped for this hop: skip ensureOfficialPrintThinking, which
                  // would otherwise re-add adaptive thinking to a body whose loop lost its blocks.
                  repaired: thinkingRepaired || cragOwned.thinkingOff === true,
                  dropSampling,
                },
              }
            }
            hopBody = applyAccountThinkingFilter(body)
            // The front rewrite already produces the official two-block shape.
            const cliPoolPassthrough = attemptPoolPrompt.applies && attemptPoolPrompt.mode === 'passthrough'
            const effectiveOfficialPassthrough =
              attemptPoolPrompt.applies && attemptPoolPrompt.mode !== 'official' ? false : officialPassthrough
            const outboundProfile = profileForPreset(effectiveCliPersona)
            // Render once from caller input with the selected slot's identity, not the pre-selection environment.
            if (!requestContext && !effectiveOfficialPassthrough) {
              if (cliPoolPassthrough) {
                hopBody = shallowCopyBody(attemptPersonaIn)
              } else if (attemptPoolPrompt.applies && attemptPoolPrompt.mode === 'override') {
                const overridden = applyPoolPromptToAnthropicBody(shallowCopyBody(attemptPersonaIn), attemptPoolPrompt)
                hopBody = applyCrsUnofficialPersona(prepareCliPersonaInput(overridden, 'zero'), {
                  forceConfigured: true,
                  routingFile: routingConfigPath,
                  cacheTtl: requestedCacheTtl,
                  mode: 'zero',
                  sessionId: attemptSessionId,
                  model: hopBody?.model,
                  cliVersion: outboundProfile.cliVersion,
                  identity,
                  entrypoint: entrypointNow,
                })
              } else {
                hopBody = applyCrsUnofficialPersona(
                  prepareCliPersonaInput(shallowCopyBody(attemptPersonaIn), effectiveCliPersona),
                  {
                    forceConfigured: true,
                    routingFile: routingConfigPath,
                    cacheTtl: requestedCacheTtl,
                    mode: effectiveCliPersona,
                    sessionId: attemptSessionId,
                    model: hopBody?.model,
                    cliVersion: outboundProfile.cliVersion,
                    identity,
                    entrypoint: entrypointNow,
                  },
                )
                if (attemptPoolPrompt.applies && attemptPoolPrompt.mode === 'append') {
                  hopBody = applyPoolPromptToAnthropicBody(hopBody, attemptPoolPrompt)
                }
              }
              // The re-render starts from the raw caller body; re-apply this account's thinking ownership to it.
              hopBody = filterThinkingForAccount(hopBody, selected.accountId, thinkingOwnerStore).body
              for (const policy of extra.repairs || []) hopBody = repairAnthropicRequest(hopBody, policy)
            }
            hopBody = prepareCliHopBody(hopBody, {
              stream: upstreamStream,
              repaired: thinkingRepaired,
              cacheTtl: requestedCacheTtl,
              requestContext,
              preserveSystem: cliPoolPassthrough,
              preserveCacheTtl: effectiveOfficialPassthrough && !cacheControlRepaired,
              preserveThinkingBlocks: preserveCliHopThinkingBlocks,
              preserveCallerEnvironment,
              autoCompactWindow: ctx.autoCompactWindow,
              routing: routingNow,
              personaPreset:
                !requestContext && !effectiveOfficialPassthrough && !cliPoolPassthrough ? effectiveCliPersona : null,
            })
            if (!requestContext) {
              hopBody = ensureBillingAttribution(hopBody, {
                firstUserText,
                sessionId: attemptSessionId,
                cliVersion: outboundProfile.cliVersion,
                indexes: billingIndexesFromMessages(hopBody.messages),
                entrypoint: entrypointNow,
                passthrough: effectiveOfficialPassthrough,
              })
            }
            const materialized = await materializeRemoteImageSources(hopBody)
            if (materialized !== hopBody) {
              validateImageDimensions(materialized)
              hopBody = materialized
            }
            if (identity) {
              hopBody = applyCrsIdentityReplace(hopBody, identity, inbound, outboundReqHeaders, {
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
            let clientToolNames = {}
            if (!requestContext) {
              const scrubbed = scrubUpstreamClientBody(hopBody, {
                official: officialTraffic === true,
                rewriteTools: routingNow?.compatibility?.tool_name_rewrite !== false,
              })
              hopBody = scrubbed.body
              clientToolNames = scrubbed.reverse
            }
            preserveCacheBreakpoints = true
            // Native wire may mix TTLs or leave caller TTL absent. The menu is
            // not an accounting authority; retain the upstream 5m/1h split.
            cacheTtl = null

            personaHideTokens = 0
            logBag.inference_engine = resolveInferenceEngine(selected.vm, routingNow)
            logBag.persona_preset = effectiveCliPersona
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
              ctx: bodyCtx,
            })
            logBag.outbound_session_id = sessionIdForLog(sessionIdFromOutboundBody(hopBody) || attemptSessionId)
            return {
              body: hopBody,
              meta: {
                toolNames: composeToolNames(inboundToolReverse, clientToolNames),
                sessionId: attemptSessionId,
                cliHop: true,
                cragPrint: false,
                preparedHop,
                transportRouting,
                requestContext,
                repaired,
                dropSampling,
              },
            }
          }

          hopBody = applyAccountThinkingFilter(body)
          const effectiveHttpOfficialPassthrough =
            attemptPoolPrompt.applies && attemptPoolPrompt.mode !== 'official' ? false : officialPassthrough
          preserveCacheBreakpoints = effectiveHttpOfficialPassthrough && !cacheControlRepaired
          cacheTtl = requestedCacheTtl
          const configuredMode =
            attemptPoolPrompt.applies && attemptPoolPrompt.cliPreset
              ? attemptPoolPrompt.cliPreset
              : modeOverride || resolveSlotPersonaPreset(selected.vm, routingNow)
          if (!requestContext && !effectiveHttpOfficialPassthrough) {
            if (attemptPoolPrompt.applies && attemptPoolPrompt.mode === 'passthrough') {
              hopBody = officialMessagesBody(shallowCopyBody(attemptPersonaIn))
              for (const policy of extra.repairs || []) hopBody = repairAnthropicRequest(hopBody, policy)
              personaHideTokens = 0
            } else if (attemptPoolPrompt.applies && attemptPoolPrompt.mode === 'override') {
              const overridden = applyPoolPromptToAnthropicBody(shallowCopyBody(attemptPersonaIn), attemptPoolPrompt)
              const rewritten = repairCacheBreakpoints(
                applyCrsUnofficialPersona(overridden, {
                  officialClient: false,
                  forceConfigured: true,
                  routingFile: routingConfigPath,
                  cacheTtl: requestedCacheTtl,
                  mode: 'zero',
                  headers: req.headers,
                  sessionId: attemptSessionId,
                  model: attemptPersonaIn?.model,
                  cliVersion: OFFICIAL_CLI_VERSION,
                  identity,
                }),
                {
                  limit: Number(routingNow?.compatibility?.cache_control_limit) || 4,
                  fallbackTtl: requestedCacheTtl,
                  fillMissing: true,
                },
              )
              hopBody = officialMessagesBody(rewritten)
              for (const policy of extra.repairs || []) hopBody = repairAnthropicRequest(hopBody, policy)
              personaHideTokens = 0
            } else {
              let rendered = applyCrsUnofficialPersona(shallowCopyBody(attemptPersonaIn), {
                officialClient: false,
                forceConfigured: true,
                routingFile: routingConfigPath,
                cacheTtl: requestedCacheTtl,
                mode: configuredMode,
                headers: req.headers,
                sessionId: attemptSessionId,
                model: attemptPersonaIn?.model,
                cliVersion: OFFICIAL_CLI_VERSION,
                identity,
              })
              if (attemptPoolPrompt.applies && attemptPoolPrompt.mode === 'append') {
                rendered = applyPoolPromptToAnthropicBody(rendered, attemptPoolPrompt)
              }
              const rewritten = repairCacheBreakpoints(rendered, {
                limit: Number(routingNow?.compatibility?.cache_control_limit) || 4,
                fallbackTtl: requestedCacheTtl,
                fillMissing: true,
              })
              hopBody = officialMessagesBody(rewritten)
              for (const policy of extra.repairs || []) hopBody = repairAnthropicRequest(hopBody, policy)
              personaHideTokens = personaUsagePassthroughFromRoutingFile(routingConfigPath, configuredMode)
                ? 0
                : personaHideForUnofficial(attemptPersonaIn, rewritten, {
                    officialClient: false,
                    mode: configuredMode,
                    hides: personaHidesUsageFromRoutingFile(routingConfigPath, configuredMode),
                    standing: standingUsageFromRoutingFile(routingConfigPath, configuredMode),
                  })
            }
          }
          logBag.inference_engine = resolveInferenceEngine(selected.vm, routingNow)
          logBag.persona_preset = configuredMode
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
            mode: sessionMode,
            routing: routingNow,
            clientDiscriminator,
            firstUserText,
            firstUserIdentity,
            apiKeyId: req.apiKeyRecord?.id ?? '',
            stream: upstreamStream,
            cacheControlLimit: Number(getRouting()?.compatibility?.cache_control_limit) || 4,
            toolNameRewrite: openaiCompat ? false : getRouting()?.compatibility?.tool_name_rewrite !== false,
            cacheTtl,
            cacheBreakpoints,
            preserveThinkingBlocks,
            preserveCallerEnvironment,
            reqHeaders: outboundReqHeaders,
            homeDir: selected.exec?.homeDir || '',
            credentialMode: credMode,
            authScheme: isApiKeyMode(credMode) ? 'apikey' : 'oauth',
            want1m,
            dropSampling,
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
            ctx: bodyCtx,
          })
          logBag.outbound_session_id = sessionIdForLog(sessionIdFromOutboundBody(outbound) || attemptSessionId)
          return {
            body: outbound,
            meta: {
              toolNames: composeToolNames(inboundToolReverse, prepared.toolNames),
              sessionId: attemptSessionId,
              repaired,
              dropSampling,
            },
          }
        },
        onUpstreamRisk: afterHop,
        callAttempt: async ({ candidate, body, attemptMeta, deliveryMode: attemptDelivery, signal, onCommit }) => {
          const attemptReqHeaders =
            attemptMeta?.stripClientBeta && outboundReqHeaders && typeof outboundReqHeaders === 'object'
              ? Object.fromEntries(
                  Object.entries(outboundReqHeaders).filter(
                    ([k]) => String(k || '').toLowerCase() !== 'anthropic-beta',
                  ),
                )
              : outboundReqHeaders
          if (!clientStream) {
            return streamAndAssembleClaudeMessage({
              candidate,
              body,
              reqHeaders: attemptReqHeaders,
              timeoutMs: cfg.limits.upstream_timeout_ms,
              idleTimeoutMs: streamIdleTimeoutMs,
              signal,
              deliveryMode: attemptDelivery,
              toolNames: attemptMeta?.toolNames || {},
              cacheTtl,
              preserveCacheBreakpoints,
              cliHop: attemptMeta?.cliHop === true,
              cragPrint: attemptMeta?.cragPrint === true,
              callerCwd: attemptMeta?.callerCwd,
              preparedHop: attemptMeta?.preparedHop,
              repaired: attemptMeta?.repaired === true,
              dropSampling: attemptMeta?.dropSampling === true,
              strictPassthrough: attemptMeta?.strictPassthrough === true,
              safeguardsSanitized: attemptMeta?.safeguardsSanitized === true,
              requestContext: attemptMeta?.requestContext || requestContext,
              want1m,
              routing: attemptMeta?.transportRouting ?? getRouting(),
              noGoFallback: !!pinVmId,
              onEnvelope: noteOutboundEnvelope,
              onOutboundHeaders: noteOutboundHeaders,
              redactionPrincipal: req.apiKeyRecord?.id || (req.apiKeyKind === 'master' ? 'master' : ''),
              redactionSession: String(req.headers?.['x-claude-code-session-id'] || ''),
              cancelSessionId: String(req.headers?.['x-claude-code-session-id'] || ''),
              tenantId,
              gatewayRequestId: logCtx.request_id,
            })
          }
          const publicStream = replayScope ? createIssuedToolStream() : null
          const geminiCrossSseLines = protocol === 'google.gemini' ? [] : null
          let sseUpstreamHeaders = null
          let state
          if (protocol === 'openai.chat') {
            state = createOpenAIChatStreamState(inbound.model || body.model, candidate.vmId)
          } else if (protocol === 'openai.completions') {
            state = createOpenAICompletionStreamState(inbound.model || body.model, candidate.vmId)
          } else if (protocol === 'openai.responses') {
            state = createResponsesStreamState(inbound.model || body.model, candidate.vmId, converted.responseTools)
          }
          const keepalive =
            anthropicKeepalive ||
            createDownstreamKeepalive({
              intervalMs: streamKeepaliveMs,
              userAgent: req.headers['user-agent'] || req.headers['User-Agent'] || '',
              protocol,
              write: (chunk) => {
                if (res.writableEnded || res.destroyed) return
                if (!res.headersSent) writeSSEHeaders(res, sseUpstreamHeaders)
                res.write(chunk)
              },
            })
          keepalive.arm()
          const skipResponseHeaders = createResponseHeadersSseFilter()
          try {
            const streamed = await dispatchStreamInference({
              exec: candidate.exec,
              admitCragInference: deps.admitCragInference,
              cacheTtl,
              preserveCacheBreakpoints,
              cliHop: attemptMeta?.cliHop === true,
              cragPrint: attemptMeta?.cragPrint === true,
              callerCwd: attemptMeta?.callerCwd,
              preparedHop: attemptMeta?.preparedHop,
              repaired: attemptMeta?.repaired === true,
              dropSampling: attemptMeta?.dropSampling === true,
              strictPassthrough: attemptMeta?.strictPassthrough === true,
              safeguardsSanitized: attemptMeta?.safeguardsSanitized === true,
              requestContext: attemptMeta?.requestContext || requestContext,
              body,
              reqHeaders: attemptReqHeaders,
              timeoutMs: cfg.limits.upstream_timeout_ms,
              idleTimeoutMs: streamIdleTimeoutMs,
              identity: loadVmIdentity(candidate.exec),
              signal,
              deliveryMode: attemptDelivery,
              want1m,
              routing: attemptMeta?.transportRouting ?? getRouting(),
              slotWaitMs: candidate.slotWaitMs,
              slotWaitDeadlineMs: candidate.slotWaitDeadlineMs,
              tenantId,
              gatewayRequestId: logCtx.request_id,
              noGoFallback: !!pinVmId,
              ensureCredential: (exec) => ensureWorkerCredential(exec),
              redactionPrincipal: req.apiKeyRecord?.id || (req.apiKeyKind === 'master' ? 'master' : ''),
              redactionSession: String(req.headers?.['x-claude-code-session-id'] || ''),
              cancelSessionId: String(req.headers?.['x-claude-code-session-id'] || ''),
              onEnvelope: noteOutboundEnvelope,
              onOutboundHeaders: noteOutboundHeaders,
              onCommit: (upstreamHeaders) => {
                if (upstreamHeaders && typeof upstreamHeaders === 'object') sseUpstreamHeaders = upstreamHeaders
                if (protocol === 'anthropic.messages' && !res.headersSent) writeSSEHeaders(res, sseUpstreamHeaders)
                onCommit()
              },
              onEvent: async (line) => {
                if (skipResponseHeaders(line)) return
                line = restoreToolNamesInSSELine(line, attemptMeta?.toolNames || {})
                if (personaHideTokens) line = hidePersonaUsageInSseLine(line, personaHideTokens, cacheTtl)
                keepalive.observeLine(line)
                if (protocol === 'anthropic.messages') {
                  streamTracker?.observe(line)
                  if (!res.headersSent) writeSSEHeaders(res, sseUpstreamHeaders)
                  const outbound = anthropicSseErrorRemapper ? anthropicSseErrorRemapper.remapLine(line) : line
                  res.write(String(outbound).endsWith('\n') ? String(outbound) : String(outbound) + '\n')
                  publicStream?.observe(outbound)
                  return
                }
                const writeChunks = (chunks) => {
                  if (!chunks.length) return
                  if (!res.headersSent) writeSSEHeaders(res, sseUpstreamHeaders)
                  for (const chunk of chunks) {
                    const event = protocol === 'openai.responses' ? `event: ${chunk.type}\n` : ''
                    res.write(`${event}data: ${JSON.stringify(chunk)}\n\n`)
                  }
                }
                if (protocol === 'google.gemini') {
                  geminiCrossSseLines.push(String(line).endsWith('\n') ? String(line) : `${line}\n`)
                  return
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
            if (protocol === 'google.gemini' && streamed?.ok && geminiCrossSseLines?.length) {
              const tc = await transcodeWithProtoFront({
                cfg,
                upstreamProtocol: 'anthropic.messages',
                inboundProtocol: 'google.gemini',
                model: inbound.model || body.model,
                stream: true,
                payload: geminiCrossSseLines.join(''),
              })
              if (tc?.ok && tc.body) {
                if (!res.headersSent) writeSSEHeaders(res)
                res.write(tc.body)
              }
            }
            if (streamed?.ok) rememberPublic(publicStream?.completedContent())
            return streamed
          } finally {
            if (anthropicKeepalive) anthropicKeepalive.endAttempt()
            else keepalive.stop()
          }
        },
      })
    } finally {
      anthropicKeepalive?.stop()
      clientAbort.settle()
      if (managedKey) {
        try {
          apiKeyStore.release(managedKey)
        } catch {}
      }
    }

    if (result?.responseSent) return

    result = acceptAssistantHop(result)
    if (result?.finalState === 'verified' && logBag.cache_prefix_key) {
      confirmCachePrefix(logBag.cache_prefix_key, Date.now(), {
        intercept: jevInterceptSessionCache(inbound, ctx.body, { ctx: bodyCtx }),
      })
    }
    logBag.vm_id = result?.vmId || null
    logBag.account_id = result?.accountId || null
    logBag.final_account_id = result?.accountId || null
    if (result?.threadBetas) logBag.hop_meta = { ...logBag.hop_meta, thread_betas: result.threadBetas }
    const correlation = extractProviderCorrelation(result)
    if (correlation.hop_request_id) {
      logBag.hop_meta = { ...logBag.hop_meta, hop_request_id: correlation.hop_request_id }
    }
    if (result?.nativeHandoff === true) {
      const provider = result.providerResult
      logBag.hop_meta = {
        ...logBag.hop_meta,
        native_handoff: {
          ...(correlation.hop_request_id ? { hop_request_id: correlation.hop_request_id } : {}),
          message_id: provider?.message_id ?? null,
          stop_reason: provider?.stop_reason ?? null,
          usage_complete: provider?.usage_complete === true,
          run_id: correlation.run_id,
          turn_id: correlation.turn_id,
          attempt_id: correlation.attempt_id,
          request_id: correlation.provider_request_id,
          ...(provider?.schema_version === 2
            ? {
                provider_complete: provider.provider_complete,
                handoff_complete: provider.handoff_complete ?? null,
                delivery_complete: provider.delivery_complete ?? null,
                response_valid: provider.response_valid ?? null,
                source: provider.source ?? null,
                http_status: provider.http_status ?? null,
                public_status: provider.public_status ?? null,
              }
            : {}),
        },
      }
    } else if (result?.providerResult) {
      const provider = result.providerResult
      logBag.hop_meta = {
        ...logBag.hop_meta,
        provider_result: {
          ...(correlation.hop_request_id ? { hop_request_id: correlation.hop_request_id } : {}),
          message_id: provider?.message_id ?? null,
          stop_reason: provider?.stop_reason ?? null,
          run_id: correlation.run_id,
          turn_id: correlation.turn_id,
          attempt_id: correlation.attempt_id,
          request_id: correlation.provider_request_id,
        },
      }
    }
    if (result?.accountId && (result.ok || result.committed))
      recordThinkingOwners(result.body, result.accountId, thinkingOwnerStore)
    // Zero executions is a real 0, not unknown; the VM is the last one that ran.
    logBag.attempt_count = result?.attemptCount ?? 0
    logBag.final_state = result?.finalState || result?.terminalState || null
    logBag.upstream_status =
      result?.providerResult?.http_status ?? result?.upstreamStatus ?? (result?.attemptCount > 0 ? result.status : null)
    logBag.usage = usageForLog(result?.usage || result?.body?.usage || null, {
      cacheTtl,
      requestedSpeed: wantsFastMode(ctx.body) ? 'fast' : null,
    })
    logBag.upstream_model = result?.body?.model || result?.model || null
    // Kernel stream firstTokenAt is generated content; include admission/setup via t0.
    logBag.first_token_ms = Number.isFinite(result?.firstTokenAt)
      ? Math.max(0, result.firstTokenAt - logCtx.t0)
      : (result?.ttftMs ?? null)
    logBag.first_byte_ms = Number.isFinite(result?.firstByteAt)
      ? Math.max(0, result.firstByteAt - logCtx.t0)
      : (result?.firstByteMs ?? null)
    logBag.generation_ms = result?.generationMs ?? null
    logBag.stop_reason = result?.body?.stop_reason || result?.stopReason || null
    logBag.via = result?.via || 'go-worker-pool'
    if (result?.finalState === 'content_filter' || logBag.stop_reason === 'refusal') {
      logBag.error_code = logBag.error_code || 'content_filter_refusal'
      logBag.error_message = logBag.error_message || 'upstream stop_reason=refusal'
    }
    if (!observedHop && result?.attemptCount > 0) afterHop(result)

    // Zero-execution rejections (e.g. session_home_slot_busy) and opaque CRAG 429s never reached generation.
    if (result?.accountId && result.attemptCount !== 0 && result.policy?.reason !== 'crag_opaque_429') {
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
        const headerTiming = {
          requestStartedAt: result.attemptStartedAt ?? logCtx.t0,
          ...(result.attemptResetGenerations ? { resetGenerations: result.attemptResetGenerations } : {}),
        }
        accountQuota.ingestHeaders(result.accountId, headers, healthReal ? null : logBag.usage, {
          exhausted,
          status: result.status,
          countRequest: !healthReal,
          ...headerTiming,
        })
        const pool = typeof deps.getPoolScheduler === 'function' ? deps.getPoolScheduler() : deps.poolScheduler
        // Live `5h-status` on every response; `allowed` is the only early unblock.
        if (!exhausted) {
          pool?.rateLimitService?.updateSessionWindow?.({
            accountId: result.accountId,
            vmId: result.vmId || null,
            headers: result.headers || {},
            ...headerTiming,
          })
        }
        if (pool?.syncQuotaSchedule && result.vmId && cfg?.paths?.project) {
          const vm = getVm(cfg.paths.project, result.vmId)
          if (vm) pool.syncQuotaSchedule(vm)
        }
      } catch {}
      attachPricing(logBag, {
        managedKey,
        rateMultiplier: deps.groupsRepo.rateMultiplier(managedKey?.group_id ?? 1),
        bill: !!managedKey,
      })
    }

    if (clientStream) {
      if (isClientCancelledResult(result)) return finishClientCancel(res, result, logBag)
      if (!res.headersSent) {
        const mapped = mapProtocolClientError(result, logBag, result?.body?.error?.code || 'upstream_error', {
          strictPassthrough: strictPassthroughAtIngress,
        })
        if (!isClientCancelledResult(result) && mapped.body?.error?.code !== 'client_cancelled') stats.errors++
        return sendMapped(res, mapped)
      }
      if (logBag.risk_upstream_reason && protocol !== 'anthropic.messages') {
        const mapped = mapProtocolClientError(result, logBag, 'upstream_error')
        res.write(`data: ${JSON.stringify(mapped.body)}\n\n`)
        return res.end()
      }
      if (result?.ok && protocol !== 'anthropic.messages' && protocol !== 'google.gemini') {
        res.write('data: [DONE]\n\n')
      }
      if (!result?.ok) {
        stats.errors++
        const streamErr = extractErrorLogFields(result)
        logBag.error_code = resolveLoggedErrorCode({
          explicitCode: result?.body?.error?.code,
          upstreamType: streamErr.upstream_type,
          fallbackCode: 'stream_incomplete',
        })
        logBag.upstream_type = streamErr.upstream_type
        logBag.error_details = streamErr.error_details
        logBag.error_message = result?.body?.error?.message || 'Stream did not reach a verified terminal state'
        if (protocol === 'openai.responses' && !res.writableEnded) {
          const { code, message, param = null } = mapProtocolClientError(result, logBag, logBag.error_code).body.error
          res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', code, message, param })}\n\n`)
          return res.end()
        }
        if (
          (logBag.error_code === ErrorCode.CLUSTER_DELIVERY_UNCONFIRMED ||
            logBag.error_code === ErrorCode.SLOT_OAUTH_UNAVAILABLE) &&
          !res.writableEnded
        ) {
          const { body } = mapProtocolClientError(result, logBag, logBag.error_code)
          if (protocol === 'anthropic.messages') {
            if (!streamTracker?.isFinished()) res.write(buildAnthropicSseError(body.error))
          } else {
            res.write(`data: ${JSON.stringify(body)}\n\n`)
          }
          return res.end()
        }
        const closing =
          !strictPassthroughAtIngress && isRecoverableTruncation(result) && !res.writableEnded
            ? streamTracker?.closingEvents()
            : null
        if (closing) res.write(closing)
        else if (protocol === 'anthropic.messages' && !res.writableEnded && !streamTracker?.isFinished()) {
          const mapped = mapProtocolClientError(result, logBag, logBag.error_code, {
            strictPassthrough: strictPassthroughAtIngress,
          })
          const mappedErr = mapped.body?.error || {}
          if (strictPassthroughAtIngress) {
            res.write(
              buildAnthropicSseError(mappedErr, result?.poolReason, {
                requestId:
                  mapped.body?.request_id || result?.body?.request_id || result?.headers?.['request-id'] || null,
                strictPassthrough: true,
              }),
            )
          } else {
            const retryableStartedHandoff =
              result?.nativeHandoff === true &&
              streamTracker?.hasStarted() === true &&
              mapped.status >= 500 &&
              mappedErr.type === 'upstream_error' &&
              !/timeout/i.test(`${logBag.error_code || ''} ${mappedErr.type || ''} ${logBag.error_message || ''}`)
            if (retryableStartedHandoff || (result?.nativeHandoff !== true && streamTracker?.hasStarted() === true)) {
              // Started but not closable: ask the client to retry instead of
              // dropping the connection. error_code/error_message keep the cause.
              logBag.client_error_type = 'rate_limit_error'
              logBag.truncation_reason = retryableStartedHandoff
                ? 'native_handoff_incomplete'
                : truncationReason(result, streamTracker)
              res.write(buildRetryableTruncationError())
            } else {
              // Unstarted streams (or non-retryable strict handoff failures like
              // 4xx/timeout/policy) keep the mapped SSE error.
              res.write(buildAnthropicSseError(mappedErr, result?.poolReason))
            }
          }
        }
      }
      return res.end()
    }

    if (!result?.ok || logBag.risk_upstream_reason || isIncompleteAssistantMessage(result)) {
      if (isClientCancelledResult(result)) return finishClientCancel(res, result, logBag)
      const failed = isIncompleteAssistantMessage(result) ? incompleteAssistantClientError(result) : result
      const mapped = mapProtocolClientError(failed, logBag, failed?.body?.error?.code || 'upstream_error', {
        strictPassthrough: strictPassthroughAtIngress,
      })
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
    } else if (protocol === 'google.gemini') {
      const tc = await transcodeWithProtoFront({
        cfg,
        upstreamProtocol: 'anthropic.messages',
        inboundProtocol: 'google.gemini',
        model: inbound.model || clientBody?.model || '',
        stream: false,
        payload: JSON.stringify(clientBody),
      })
      output = tc?.ok && tc.body ? JSON.parse(tc.body) : clientBody
    } else {
      output = fromClaudeToResponses(clientBody, inbound.model, result.vmId, converted.mode, converted.responseTools)
    }
    ctx = applyIntercept(cfg.intercept.rules, 'before_client', { ...ctx, body: output })
    return sendPublicJson(ctx.body, result?.headers)
  }

  /** POST /v1/alpha/search (Codex web search): same logging, auth and body handling as handleProtocol. */
  async function handleSearch(req, res, pathName) {
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
      upstream_type: null,
      error_details: null,
      via: 'codex-search',
      attempt_count: null,
      final_state: null,
    }
    res.on('finish', () => {
      try {
        const groupId = req.apiKeyRecord?.group_id ?? 1
        requestLog.finish(logCtx, {
          status: res.statusCode || 0,
          api_key_kind: req.apiKeyKind || null,
          api_key_id: req.apiKeyRecord?.id || null,
          user_id: req.apiKeyRecord?.user_id ?? null,
          group_id: groupId,
          rate_multiplier: deps.groupsRepo.rateMultiplier(groupId),
          ...logBag,
        })
      } catch {}
    })
    if (!requireAuth(req, res)) {
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
    if (rejectKeyModel(req, res, protocol, body?.model, logBag)) return
    const searchOwnerScope = ownerScopeFromRequest(req, apiKeyStore?.users)
    const searchPoolAccess = resolveRequestPoolAccess(req, {
      model: body?.model || null,
      ownerScope: searchOwnerScope,
    })
    if (!searchPoolAccess.ok) {
      return rejectPoolAccess(res, searchPoolAccess, logBag, protocol)
    }
    req._poolAccess = searchPoolAccess
    if (searchPoolAccess.effectivePool?.id) logBag.resolved_pool_id = searchPoolAccess.effectivePool.id
    const searchIdentity = refusalAuditIdentity({
      inbound: body,
      body,
      headers: req.headers,
      principal: riskPrincipal(req),
    })
    const searchRiskState = {
      policy: refusalPolicy(),
      repo: refusalRepo(),
      devices: deviceRepo(),
      sessions: sessionRepo(),
    }
    if (
      await applyProtocolIntercept({
        req,
        inbound: body,
        body,
        fp: fingerprintRequest(req, body),
        logBag,
        requestId: logCtx.request_id,
        res,
        identity: searchIdentity,
        riskState: searchRiskState,
        poolJevProfile: searchPoolAccess.effectivePool?.jev_profile || req.poolJevProfile || null,
        zeroInject: false,
        channel: 'search',
        enforceHardAndJev: true,
        skipDistill: true,
        backend: 'oauth',
        apiPlatform: false,
      })
    ) {
      return
    }
    const searchKeyScope =
      !searchPoolAccess.legacy && searchPoolAccess.effectivePool
        ? {
            ...keyScopeFromRequest(req),
            vm_pool_id: searchPoolAccess.effectivePool.id,
            vm_pool_error: null,
            allowed_vms: searchPoolAccess.allowedVmIds || [],
          }
        : undefined
    return runWithCodexKey(req, res, logBag, () =>
      handleCodexSearch({
        req,
        res,
        body,
        logBag,
        stats,
        json,
        routing: getRouting() || {},
        projectRoot: cfg.paths.project,
        stickyRouter,
        ownerScope: searchOwnerScope,
        poolAccess: searchPoolAccess,
        originPoolId: searchPoolAccess.originPool?.id || searchPoolAccess.effectivePool?.id || null,
        schedulerRuntime: getSchedulerRuntime(req),
        ops: deps.codexOps || {},
        ...(searchKeyScope ? { keyScope: searchKeyScope } : {}),
      }),
    )
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

  /**
   * Chat Completions / Responses turn on an image model: one Images call (generation, or edit
   * when the last user message carries images) answered in the caller's protocol. The row is
   * an Images row, so it bills image usage alone like /v1/images.
   */
  async function serveImageModelTurn({ req, res, protocol, body, logBag, keyScope = null }) {
    const turn = imagesRequestFromTurn(protocol, body)
    if (!turn.ok) {
      stats.errors++
      logBag.error_code = turn.code
      logBag.error_message = turn.message
      return json(
        res,
        400,
        makeError({
          type: ErrorType.INVALID_REQUEST,
          code: turn.code,
          message: turn.message,
          status: 400,
          param: turn.param,
        }).body,
      )
    }
    logBag.protocol = 'openai.images'
    logBag.inbound_summary = summarizeImagesBody(turn.body)
    const stream = isClientStream(body, req.headers)
    const streamKeepaliveMs = Number(
      getRouting()?.failover?.stream_keepalive_ms ?? cfg.limits.stream_keepalive_ms ?? 15_000,
    )
    // Generation takes minutes: past the queue delay a stream commits SSE and pings so a
    // proxy in front does not time out. Before that, failures keep their HTTP status.
    const keepalive =
      stream && streamKeepaliveMs > 0
        ? createDownstreamKeepalive({
            intervalMs: streamKeepaliveMs,
            protocol,
            write: (chunk) => {
              if (responseClosed(res)) return
              if (!res.headersSent) writeSSEHeaders(res)
              res.write(chunk)
            },
          })
        : null
    let reply = null
    try {
      await runWithCodexKey(req, res, logBag, () => {
        keepalive?.armAfter(queueKeepaliveDelayMs(getRouting(), cfg.limits?.queue_keepalive_delay_ms))
        return handleCodexImages({
          req,
          res,
          kind: turn.kind,
          body: turn.body,
          logBag,
          stats,
          json: (_res, status, payload) => {
            reply = { status, payload }
          },
          routing: getRouting() || {},
          projectRoot: cfg.paths.project,
          stickyRouter,
          ownerScope: ownerScopeFromRequest(req, apiKeyStore?.users),
          poolAccess: req._poolAccess || null,
          originPoolId: req._poolAccess?.originPool?.id || req._poolAccess?.effectivePool?.id || null,
          schedulerRuntime: getSchedulerRuntime(req),
          ops: deps.codexOps || {},
          ...(keyScope ? { keyScope } : {}),
        })
      })
    } finally {
      keepalive?.stop()
    }
    if (responseClosed(res)) return
    if (!reply) {
      // Client gone (cancelled) or the key gate already answered.
      if (res.headersSent && !res.writableEnded) res.end()
      return
    }
    let { status, payload } = reply
    if (status < 400) {
      const answer = imageModelAnswer(protocol, payload, {
        model: body.model,
        stream,
        includeUsage: body.stream_options?.include_usage === true,
      })
      if (answer.ok) {
        if (!stream) return json(res, 200, answer.body)
        if (!res.headersSent) writeSSEHeaders(res)
        res.write(answer.sse)
        return res.end()
      }
      stats.errors++
      logBag.final_state = 'upstream_error'
      logBag.error_code = answer.code
      logBag.error_message = answer.message
      status = 502
      payload = { error: { type: 'api_error', code: answer.code, message: answer.message } }
    } else if (!logBag.error_message) {
      logBag.error_message = payload?.error?.message || null
    }
    if (!res.headersSent) return json(res, status, payload)
    res.write(imageModelStreamError(protocol, payload))
    return res.end()
  }

  /** POST /v1/images/{generations,edits}: same logging and auth as search; edits also take multipart. */
  async function handleImages(req, res, pathName, kind) {
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
      upstream_type: null,
      error_details: null,
      via: 'codex-images',
      attempt_count: null,
      final_state: null,
    }
    res.on('finish', () => {
      try {
        const groupId = req.apiKeyRecord?.group_id ?? 1
        requestLog.finish(logCtx, {
          status: res.statusCode || 0,
          api_key_kind: req.apiKeyKind || null,
          api_key_id: req.apiKeyRecord?.id || null,
          user_id: req.apiKeyRecord?.user_id ?? null,
          group_id: groupId,
          rate_multiplier: deps.groupsRepo.rateMultiplier(groupId),
          ...logBag,
        })
      } catch {}
    })
    if (!requireAuth(req, res)) {
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
    // No model means the upstream default, which a limited key cannot name.
    if (rejectKeyModel(req, res, protocol, body?.model, logBag)) return
    const imagesOwnerScope = ownerScopeFromRequest(req, apiKeyStore?.users)
    const imagesPoolAccess = resolveRequestPoolAccess(req, {
      model: body?.model || null,
      ownerScope: imagesOwnerScope,
    })
    if (!imagesPoolAccess.ok) {
      return rejectPoolAccess(res, imagesPoolAccess, logBag, protocol)
    }
    req._poolAccess = imagesPoolAccess
    if (imagesPoolAccess.effectivePool?.id) logBag.resolved_pool_id = imagesPoolAccess.effectivePool.id
    const imagesIdentity = refusalAuditIdentity({
      inbound: body,
      body,
      headers: req.headers,
      principal: riskPrincipal(req),
    })
    const imagesRiskState = {
      policy: refusalPolicy(),
      repo: refusalRepo(),
      devices: deviceRepo(),
      sessions: sessionRepo(),
    }
    if (
      await applyProtocolIntercept({
        req,
        inbound: body,
        body,
        fp: fingerprintRequest(req, body),
        logBag,
        requestId: logCtx.request_id,
        res,
        identity: imagesIdentity,
        riskState: imagesRiskState,
        poolJevProfile: imagesPoolAccess.effectivePool?.jev_profile || req.poolJevProfile || null,
        zeroInject: false,
        channel: 'images',
        enforceHardAndJev: true,
        skipDistill: true,
        backend: 'oauth',
        apiPlatform: false,
      })
    ) {
      return
    }
    const imagesKeyScope =
      !imagesPoolAccess.legacy && imagesPoolAccess.effectivePool
        ? {
            ...keyScopeFromRequest(req),
            vm_pool_id: imagesPoolAccess.effectivePool.id,
            vm_pool_error: null,
            allowed_vms: imagesPoolAccess.allowedVmIds || [],
          }
        : undefined
    return runWithCodexKey(req, res, logBag, () =>
      handleCodexImages({
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
        ownerScope: imagesOwnerScope,
        poolAccess: imagesPoolAccess,
        originPoolId: imagesPoolAccess.originPool?.id || imagesPoolAccess.effectivePool?.id || null,
        schedulerRuntime: getSchedulerRuntime(req),
        ops: deps.codexOps || {},
        ...(imagesKeyScope ? { keyScope: imagesKeyScope } : {}),
      }),
    )
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
