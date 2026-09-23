/**
 * /v1 protocol handler. URLs, auth, and response envelopes stay with the
 * server wiring; this factory owns convert → pool → Go/Rust hop → client.
 */
import { applyIntercept } from '../core/intercept.mjs'
import { detectDistill, distillBlockError } from '../core/distill-detect.mjs'
import {
  isRefusalGuardEnabled,
  isUpstreamRefusal,
  refusalFingerprint,
  refusalGuardError,
  refusalPreview,
} from '../core/refusal-guard.mjs'
import { RefusalGuardsRepo } from '../db/repos/refusal-guards-repo.mjs'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
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
import { sanitizeInboundBody, defaultSeedPolicy } from './seed-policy.mjs'
import { fingerprintRequest } from './client-fingerprint.mjs'
import { validateOfficialModel } from './models.mjs'
import { handleCodexProtocol } from './handle-codex.mjs'
import { detectInboundPlatform } from './platform-detect.mjs'
import { normalizeCodexRouting } from './codex-route.mjs'
import { hasClaudeCode1mSuffix } from './context-1m.mjs'
import {
  HEALTH_REAL_HEADER,
  isHealthRealBypass,
  synthesizeProtocolResponse,
  formatHealthSse,
  healthUnavailableError,
} from '../admin/health-probe.mjs'
import { resolveInferenceBackend, runApiInference } from '../pool/api-protocol.mjs'
import { summarizeBody, redactHeaders, presentedApiKeyForLog } from '../admin/request-log.mjs'
import { ownerScopeFromRequest } from '../admin/resource-owner.mjs'
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
import { prepareOutboundEnvelope, prepareCliHopBody } from './outbound-attempt.mjs'
import { loadVmIdentity, OFFICIAL_CLI_VERSION } from '../identity/vm-identity.mjs'
import { touchTelemetrySession } from '../vm/worker-telemetry.mjs'
import {
  applyCrsIdentityReplace,
  extractCallerSession,
  resolveOutboundSessionId,
  sessionContextDiscriminator,
} from '../identity/identity-rewrite.mjs'
import { clientIp } from '../pool/sticky-router.mjs'
import {
  applyCrsUnofficialPersona,
  detectProxiedOfficialCcFromRoutingFile,
  extractFirstUserText,
  isOfficialClaudeCodeTraffic,
  isProxiedOfficialClaudeCode,
  personaHidesUsageFromRoutingFile,
  personaModeFromRoutingFile,
} from '../identity/crs-persona.mjs'
import { createDownstreamKeepalive } from './stream-keepalive.mjs'
import {
  hidePersonaUsageInSseLine,
  hidePersonaUsageOnMessage,
  personaHideForUnofficial,
  personaHideForCliZero,
} from '../identity/crs-persona-usage.mjs'
import { applyCacheTtlToUsage, cacheBreakpointsFromRoutingFile, resolveCacheTtl } from './cache-ttl.mjs'
import { ensureClaudeWebSearch, shouldInjectClaudeWebSearch } from './web-search.mjs'
import { dispatchStreamInference } from '../transport/kernel-router.mjs'
import { syncClaudeKernelConfigsFromFile } from '../transport/rust-kernel-supervisor.mjs'
import { ensureWorkerCredential } from '../transport/go-worker-client.mjs'
import { formatPoolSelectionSummary } from '../pool/pool-scheduler.mjs'
import { extraHeadersFromLimitError } from '../pool/account-quota.mjs'
import { getVm } from '../vm/vm-registry.mjs'
import { credentialModeFromOauth, isApiKeyMode } from '../oauth/credential-mode.mjs'
import {
  prepareAnthropicRequest,
  rewriteToolNames,
  restoreToolNames,
  restoreToolNamesInSSELine,
} from './anthropic-policy.mjs'
import { materializeRemoteImageSources } from './images.mjs'

export function createHandleProtocol(deps) {
  const json = (...args) => deps.json(...args)
  const writeSSEHeaders = (...args) => deps.writeSSEHeaders(...args)
  const readBody = (...args) => deps.readBody(...args)
  const requireAuth = (...args) => deps.requireAuth(...args)
  const cfg = deps.cfg
  const requestLog = deps.requestLog
  const stickyRouter = deps.stickyRouter
  const accountQuota = deps.accountQuota
  const apiKeyStore = deps.apiKeyStore
  const apiScheduler = deps.apiScheduler
  const apiEndpointStore = deps.apiEndpointStore
  const stats = deps.stats
  const routingConfigPath = deps.routingConfigPath
  const getRouting = () => (typeof deps.getRoutingConfig === 'function' ? deps.getRoutingConfig() : deps.routingConfig)
  const getHealthMonitor = () =>
    typeof deps.getHealthMonitor === 'function' ? deps.getHealthMonitor() : deps.healthMonitor
  const getFailoverRunner = () =>
    typeof deps.getFailoverRunner === 'function' ? deps.getFailoverRunner() : deps.failoverRunner
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
    return mapped
  }

  function acceptAssistantHop(result) {
    return finalizeAssembledAssistantHop(result)
  }

  function applyDistillGuard({ req, inbound, body, fp, logBag, requestId, res }) {
    const official =
      isOfficialClaudeCodeTraffic(req.headers, inbound) ||
      isOfficialClaudeClient(fp.client_class) ||
      (detectProxiedOfficialCcFromRoutingFile(routingConfigPath) && isProxiedOfficialClaudeCode(inbound))
    const zeroInject = isZeroInjectMode()
    const hit = detectDistill({ inbound, body, official, zeroInject }, cfg.distill)
    if (hit.action !== 'block') return false
    stats.errors++
    logBag.via = 'distill-detect'
    logBag.attempt_count = 0
    logBag.final_state = 'distill_blocked'
    logBag.error_code = hit.error.code
    const evidence = (hit.hits || [])
      .map((item) => item.evidence || item.rule)
      .filter(Boolean)
      .join(';')
    logBag.error_message = evidence ? `${hit.error.message}: ${evidence}` : hit.error.message
    const blocked = distillBlockError(cfg.distill, requestId)
    json(res, blocked.status, blocked.body)
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

  function applyRefusalGuard({ inbound, body, logBag, requestId, res }) {
    if (!refusalEnabled()) return false
    const repo = refusalRepo()
    if (!repo) return false
    const hit = repo.get(refusalFingerprint(body, inbound))
    if (!hit) return false
    repo.hit(hit.fingerprint)
    logBag.via = 'refusal-guard'
    logBag.attempt_count = 0
    logBag.final_state = 'refusal_guard'
    logBag.error_code = 'refusal_guard'
    const blocked = refusalGuardError(requestId)
    logBag.error_message = blocked.body?.error?.message
    json(res, blocked.status, blocked.body)
    return true
  }

  function rememberRefusal({ inbound, body, result, logBag, requestId }) {
    if (!refusalEnabled()) return
    const contentRefusal = isUpstreamRefusal(result, logBag)
    const timed = result?.policy?.rememberRefusal === true
    if (!contentRefusal && !timed) return
    const repo = refusalRepo()
    if (!repo) return
    try {
      const ttl = Number(result?.policy?.refusalTtlMs) || 0
      repo.remember({
        fingerprint: refusalFingerprint(body, inbound),
        model: body?.model || inbound?.model || '',
        requestId,
        errorMessage: logBag.error_message || result?.body?.error?.message || null,
        preview: refusalPreview(body, inbound),
        expiresAt: contentRefusal || ttl <= 0 ? null : new Date(Date.now() + ttl).toISOString(),
      })
    } catch {}
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
    routing = {},
    noGoFallback = false,
  }) {
    const assembler = createClaudeMessageAssembler()
    const workerResult = await dispatchStreamInference({
      exec: candidate.exec,
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
      slotWaitMs: candidate.slotWaitMs,
      noGoFallback,
      ensureCredential: (exec) => ensureWorkerCredential(exec),
      onEvent: async (line) => {
        if (/kin_response_headers/.test(String(line))) return
        applyClaudeSSELineToMessage(restoreToolNamesInSSELine(line, toolNames), assembler)
      },
    })
    Object.assign(workerResult, mergeAssembledAssistantHop(workerResult, assembler.message))
    if (workerResult?.body) {
      workerResult.body = restoreToolNames(workerResult.body, toolNames)
    }
    return acceptAssistantHop(workerResult)
  }

  async function handleProtocol(req, res, protocol, pathName) {
    const logCtx = requestLog.start(req, { protocol, pathName })
    res._kinRequestId = logCtx.request_id
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
      outbound_summary: null,
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

    let inbound
    try {
      inbound = await readBody(req, cfg.limits.max_body_bytes)
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

    const fp = fingerprintRequest(req, inbound)
    const healthDecision = getHealthMonitor()?.decide?.(req.headers, inbound)
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

    let ctx = {
      path: pathName,
      protocol,
      body: sanitizeInboundBody(inbound, defaultSeedPolicy()),
      headers: { ...req.headers },
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
    const platform = detectInboundPlatform(ctx.body?.model)
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
    // Codex returns before conversion. Distill does not apply to OpenAI platform models.
    // Refusal still scans here so a cached refusal never reaches a slot.
    if (applyDistillGuard({ req, inbound, body: ctx.body, fp, logBag, requestId: logCtx.request_id, res })) {
      return
    }
    if (applyRefusalGuard({ inbound, body: ctx.body, logBag, requestId: logCtx.request_id, res })) {
      return
    }
    if (platform.platform === 'openai') {
      const routing = getRouting() || {}
      const codexSticky = {
        stickyRouter,
        sessions: accountQuota?.sessions || null,
        body: ctx.body,
      }
      if (protocol === 'anthropic.messages') {
        const codex = normalizeCodexRouting(routing.codex)
        return handleCodexProtocol({
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
          ...codexSticky,
        })
      }
      return handleCodexProtocol({
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
    const converted = toClaudeMessages(protocol, ctx.body, {
      rewrite: rewriteEnabled,
      model_map: false,
      strict_passthrough: String(req.headers['x-kin-strict-passthrough'] || '') === '1',
    })
    stats.requests++
    stats.by_route[protocol] = (stats.by_route[protocol] || 0) + 1
    if (converted.mode === 'passthrough') stats.passthrough++
    else if (converted.mode === 'rewrite') stats.rewrite++
    else stats.convert++

    ctx = applyIntercept(cfg.intercept.rules, 'before_upstream', { ...ctx, body: converted.claude })

    if (applyDistillGuard({ req, inbound, body: ctx.body, fp, logBag, requestId: logCtx.request_id, res })) {
      return
    }
    if (applyRefusalGuard({ inbound, body: ctx.body, logBag, requestId: logCtx.request_id, res })) {
      return
    }
    const officialClient = isOfficialClaudeClient(fp.client_class)
    const officialTraffic =
      isOfficialClaudeCodeTraffic(req.headers, inbound) ||
      (detectProxiedOfficialCcFromRoutingFile(routingConfigPath) && isProxiedOfficialClaudeCode(inbound))
    const callerSession = extractCallerSession({ inbound, body: ctx.body, headers: req.headers })
    const firstUserText = extractFirstUserText(ctx.body?.messages) || extractFirstUserText(inbound?.messages)
    const clientDiscriminator = sessionContextDiscriminator({
      clientIp: clientIp(req),
      userAgent: req.headers['user-agent'] || '',
      apiKeyId: req.apiKeyRecord?.id ?? '',
    })
    const sessionContext = {
      officialClient: officialTraffic,
      clientDiscriminator,
      firstUserText,
    }
    // Family device_id wins when already bound so a child hop cannot open a second VM session.
    const stickyKey = stickyRouter?.extractPoolKey?.(req, inbound, { platform: 'anthropic' }) || null
    const stickyKeys = stickyRouter?.collectPoolKeys?.(req, inbound, { platform: 'anthropic' }) || []
    const stickyBound =
      stickyKey && typeof stickyRouter?.resolve === 'function' ? stickyRouter.resolve(stickyKey) : null
    const outboundSessionId = resolveOutboundSessionId(callerSession, {
      ...sessionContext,
      accountId: stickyBound?.accountId || '',
      boundSessionId: stickyBound?.sessionId || '',
      boundAccountId: stickyBound?.accountId || '',
    })
    const requestedCacheTtl = resolveCacheTtl({
      headers: req.headers,
      body: inbound,
      routingFile: routingConfigPath,
      officialTraffic,
    })
    let cacheTtl = requestedCacheTtl
    let preserveCacheBreakpoints = false
    const cacheBreakpoints = cacheBreakpointsFromRoutingFile(routingConfigPath)
    const openaiCompat = String(protocol || '').startsWith('openai.')
    syncClaudeKernelConfigsFromFile(cfg.paths?.project, routingConfigPath)
    const personaMode = personaModeFromRoutingFile(routingConfigPath)
    if (!officialClient && !officialTraffic) {
      ctx.body = ensureClaudeWebSearch(ctx.body, {
        enabled: shouldInjectClaudeWebSearch({
          officialClient: officialTraffic,
          clientClass: fp.client_class,
          headers: req.headers,
          body: inbound,
        }),
      })
    }
    const personaIn = ctx.body
    ctx.body = applyCrsUnofficialPersona(ctx.body, {
      officialClient: officialTraffic,
      routingFile: routingConfigPath,
      headers: req.headers,
      sessionId: outboundSessionId,
      model: ctx.body?.model,
      cliVersion: OFFICIAL_CLI_VERSION,
    })
    let personaHideTokens = personaHideForUnofficial(personaIn, ctx.body, {
      officialClient: officialTraffic,
      mode: personaMode,
      hides: personaHidesUsageFromRoutingFile(routingConfigPath),
    })

    if (inferenceBackend === 'api') {
      const managedKey = req.apiKeyRecord || null
      if (managedKey) {
        const gate = apiKeyStore.acquire(managedKey)
        if (!gate.ok) {
          stats.errors++
          return json(
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
        }
      }
      const abortController = new AbortController()
      const onAborted = () => {
        if (!abortController.signal.aborted) abortController.abort(new Error('client_aborted'))
      }
      req.once('aborted', onAborted)
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
          signal: abortController.signal,
          timeoutMs: cfg.limits.upstream_timeout_ms,
          personaHideTokens,
          cacheTtl,
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
        req.off('aborted', onAborted)
        if (managedKey) {
          try {
            apiKeyStore.release(managedKey)
          } catch {}
        }
      }
      logBag.account_id = result?.accountId || null
      logBag.final_account_id = result?.accountId || null
      logBag.upstream_status = result?.status ?? null
      logBag.usage = result?.body?.usage || result?.usage || null
      logBag.upstream_model = result?.model || null
      logBag.first_token_ms = result?.ttftMs ?? null
      logBag.final_state = result?.terminalState || null
      if (result?.ok && managedKey) {
        try {
          apiKeyStore.recordUsage(managedKey, logBag.usage || {}, {
            model: logBag.upstream_model || logBag.model,
            rateMultiplier: deps.groupsRepo.rateMultiplier(managedKey.group_id ?? 1),
          })
        } catch {}
      }
      if (clientStream) {
        if (!res.headersSent) {
          const mapped = mapProtocolClientError(result, logBag, 'api_pool_exhausted')
          if (!isClientCancelledResult(result)) stats.errors++
          return json(res, mapped.status, mapped.body)
        }
        if (result?.ok && protocol !== 'anthropic.messages') res.write('data: [DONE]\n\n')
        return res.end()
      }
      if (!result?.ok) {
        const mapped = mapProtocolClientError(result, logBag, 'upstream_error')
        stats.errors++
        return json(res, mapped.status, mapped.body)
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
    const streamIdleTimeoutMs = Number(cfg.limits.stream_idle_timeout_ms || 180_000)
    const managedKey = req.apiKeyRecord || null
    if (managedKey) {
      const gate = apiKeyStore.acquire(managedKey)
      if (!gate.ok) {
        stats.errors++
        return json(
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
      }
    }

    const abortController = new AbortController()
    const onAborted = () => {
      if (!abortController.signal.aborted) abortController.abort(new Error('client_aborted'))
    }
    req.once('aborted', onAborted)

    const clientStream = isClientStream(inbound, req.headers)
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
    const ownerScope = pinVmId ? { type: 'any' } : ownerScopeFromRequest(req, apiKeyStore?.users)
    const healthReal = isHealthRealBypass(req.headers)
    let result
    try {
      result = await getFailoverRunner().run({
        requestId: logCtx.request_id,
        canonicalBody,
        model: canonicalBody.model,
        stickyKey,
        stickyKeys,
        pinVmId,
        ownerScope,
        countUsage: !healthReal,
        stream: upstreamStream,
        deliveryMode,
        signal: abortController.signal,
        applyAttempt: async (body, selected, extra = {}) => {
          try {
            touchTelemetrySession(cfg.paths.project, selected.vmId)
          } catch {}
          const identity = loadVmIdentity(selected.exec)
          const attemptSessionId = resolveOutboundSessionId(callerSession, {
            ...sessionContext,
            accountId: selected.accountId,
            boundSessionId: stickyBound?.sessionId || '',
            boundAccountId: stickyBound?.accountId || '',
          })
          const credMode = credentialModeFromOauth(selected.vm?.claude || {})
          const modeOverride = slotPersonaModeOverride(selected.vm)
          const routingNow = getRouting()
          const cliHop = resolveOfficialCcInference(selected.vm, routingNow) === 'cli-hop'
          let hopBody = body
          if (cliHop) {
            const repaired = extra.repaired === true
            const resolvedPersona = resolveSlotPersonaPreset(selected.vm, routingNow)
            const cliAppliesNodePersona =
              !officialTraffic && resolvedPersona !== 'zero' && resolvedPersona !== 'official_full'
            if (cliAppliesNodePersona) {
              hopBody = applyCrsUnofficialPersona(structuredClone(personaIn), {
                officialClient: false,
                routingFile: routingConfigPath,
                mode: resolvedPersona,
                headers: req.headers,
                sessionId: attemptSessionId,
                model: personaIn?.model,
                cliVersion: OFFICIAL_CLI_VERSION,
                identity,
              })
            }
            hopBody = prepareCliHopBody(repaired ? body : hopBody, {
              stream: upstreamStream,
              repaired,
            })
            hopBody = await materializeRemoteImageSources(hopBody)
            if (identity) {
              hopBody = applyCrsIdentityReplace(hopBody, identity, inbound, req.headers, {
                officialClient: officialTraffic,
                sessionId: attemptSessionId,
                accountId: selected.accountId,
                boundSessionId: stickyBound?.sessionId || '',
                boundAccountId: stickyBound?.accountId || '',
              })
            }
            if (getRouting()?.logging?.mode === 'debug') logBag.outbound_body = hopBody

            const cliHide = personaHideForCliZero(personaIn, hopBody, {
              officialClient: officialTraffic,
              timezone: selected.vm?.timezone || selected.vm?.fingerprint?.timezone,
            })
            personaHideTokens = cliAppliesNodePersona ? (Number(personaHideTokens) || 0) + cliHide : cliHide
            logBag.inference_engine = resolveInferenceEngine(selected.vm, routingNow)
            logBag.persona_preset = resolveSlotPersonaPreset(selected.vm, routingNow)
            logBag.official_cc_inference = 'cli-hop'
            logBag.provider = 'local_cli'
            logBag.outbound_summary = summarizeBody(hopBody)
            return { body: hopBody, meta: { toolNames: {}, sessionId: attemptSessionId } }
          }

          cacheTtl = requestedCacheTtl
          if (!officialTraffic && modeOverride) {
            const rewritten = applyCrsUnofficialPersona(structuredClone(personaIn), {
              officialClient: officialTraffic,
              routingFile: routingConfigPath,
              mode: modeOverride,
              headers: req.headers,
              sessionId: attemptSessionId,
              model: personaIn?.model,
              cliVersion: OFFICIAL_CLI_VERSION,
              identity,
            })
            hopBody = officialMessagesBody(rewritten)
            personaHideTokens = personaHideForUnofficial(personaIn, rewritten, {
              officialClient: officialTraffic,
              mode: modeOverride,
              hides: personaHidesUsageFromRoutingFile(routingConfigPath),
            })
          }
          logBag.inference_engine = resolveInferenceEngine(selected.vm, routingNow)
          logBag.persona_preset = resolveSlotPersonaPreset(selected.vm, routingNow)
          logBag.official_cc_inference = 'http'
          logBag.provider = 'anthropic_api'
          const prepared = prepareOutboundEnvelope({
            canonicalBody: hopBody,
            inbound,
            identity,
            unofficial: !officialTraffic,
            officialClient: officialTraffic,
            sessionId: attemptSessionId,
            accountId: selected.accountId,
            boundSessionId: stickyBound?.sessionId || '',
            boundAccountId: stickyBound?.accountId || '',
            clientDiscriminator,
            firstUserText,
            apiKeyId: req.apiKeyRecord?.id ?? '',
            stream: upstreamStream,
            cacheControlLimit: Number(getRouting()?.compatibility?.cache_control_limit) || 4,
            toolNameRewrite: openaiCompat ? false : getRouting()?.compatibility?.tool_name_rewrite !== false,
            cacheTtl,
            cacheBreakpoints,
            reqHeaders: req.headers,
            homeDir: selected.exec?.homeDir || '',
            credentialMode: credMode,
            authScheme: isApiKeyMode(credMode) ? 'apikey' : 'oauth',
            want1m,
          })
          if (getRouting()?.logging?.mode === 'debug') logBag.outbound_body = prepared.body
          logBag.outbound_headers = redactHeaders(prepared.headers || {})
          logBag.outbound_summary = summarizeBody(prepared.body)
          return { body: prepared.body, meta: { toolNames: prepared.toolNames, sessionId: attemptSessionId } }
        },
        callAttempt: async ({ candidate, body, attemptMeta, deliveryMode: attemptDelivery, signal, onCommit }) => {
          if (!clientStream) {
            return streamAndAssembleClaudeMessage({
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
              want1m,
              routing: getRouting(),
              noGoFallback: !!pinVmId,
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
          const keepalive = createDownstreamKeepalive({
            intervalMs: streamKeepaliveMs,
            userAgent: req.headers['user-agent'] || req.headers['User-Agent'] || '',
            protocol,
            write: (chunk) => {
              if (res.writableEnded || res.destroyed) return
              if (!res.headersSent) writeSSEHeaders(res)
              res.write(chunk)
            },
          })
          keepalive.start()
          try {
            return await dispatchStreamInference({
              exec: candidate.exec,
              cacheTtl,
              preserveCacheBreakpoints,
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
              ensureCredential: (exec) => ensureWorkerCredential(exec),
              onCommit: () => {
                if (protocol === 'anthropic.messages' && !res.headersSent) writeSSEHeaders(res)
                onCommit()
              },
              onEvent: async (line) => {
                if (/kin_response_headers/.test(String(line))) return
                line = restoreToolNamesInSSELine(line, attemptMeta?.toolNames || {})
                if (personaHideTokens) line = hidePersonaUsageInSseLine(line, personaHideTokens, cacheTtl)
                keepalive.observeLine(line)
                if (protocol === 'anthropic.messages') {
                  if (!res.headersSent) writeSSEHeaders(res)
                  res.write(String(line).endsWith('\n') ? String(line) : String(line) + '\n')
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
          } finally {
            keepalive.stop()
          }
        },
      })
    } finally {
      req.off('aborted', onAborted)
      if (managedKey) {
        try {
          apiKeyStore.release(managedKey)
        } catch {}
      }
    }

    result = acceptAssistantHop(result)
    logBag.vm_id = result?.vmId || null
    logBag.account_id = result?.accountId || null
    logBag.final_account_id = result?.accountId || null
    logBag.attempt_count = result?.attemptCount || null
    logBag.final_state = result?.finalState || result?.terminalState || null
    logBag.upstream_status = result?.status ?? null
    logBag.usage = result?.body?.usage || result?.usage || null
    if (logBag.usage && cacheTtl) logBag.usage = applyCacheTtlToUsage(logBag.usage, cacheTtl)
    logBag.upstream_model = result?.body?.model || result?.model || null
    logBag.first_token_ms = result?.ttftMs ?? null
    logBag.stop_reason = result?.body?.stop_reason || result?.stopReason || null
    logBag.via = result?.via || 'go-worker-pool'
    if (result?.finalState === 'content_filter' || logBag.stop_reason === 'refusal') {
      logBag.error_code = logBag.error_code || 'content_filter_refusal'
      logBag.error_message = logBag.error_message || 'upstream stop_reason=refusal'
    }
    rememberRefusal({ inbound, body: ctx.body, result, logBag, requestId: logCtx.request_id })

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
        accountQuota.ingestHeaders(result.accountId, headers, healthReal ? null : logBag.usage, {
          exhausted: !result.ok && (Number(result.status) === 429 || /hit your limit/i.test(limitText)),
          status: result.status,
          countRequest: !healthReal,
        })
        const pool = typeof deps.getPoolScheduler === 'function' ? deps.getPoolScheduler() : deps.poolScheduler
        if (pool?.syncQuotaSchedule && result.vmId && cfg?.paths?.project) {
          const vm = getVm(cfg.paths.project, result.vmId)
          if (vm) pool.syncQuotaSchedule(vm)
        }
      } catch {}
      if (managedKey && !healthReal) {
        try {
          apiKeyStore.recordUsage(managedKey, logBag.usage || {}, {
            model: logBag.upstream_model || logBag.model,
            rateMultiplier: deps.groupsRepo.rateMultiplier(managedKey.group_id ?? 1),
          })
        } catch {}
      }
    }

    if (clientStream) {
      if (!res.headersSent) {
        const mapped = mapProtocolClientError(result, logBag, result?.body?.error?.code || 'upstream_error')
        if (!isClientCancelledResult(result) && mapped.body?.error?.code !== 'client_cancelled') stats.errors++
        return json(res, mapped.status, mapped.body)
      }
      if (result?.ok && protocol !== 'anthropic.messages') {
        res.write('data: [DONE]\n\n')
      }
      if (!result?.ok) {
        if (isClientCancelledResult(result)) {
          logBag.error_code = 'client_cancelled'
          logBag.error_message = result?.body?.error?.message || 'Client closed the connection'
        } else {
          stats.errors++
          logBag.error_code = result?.body?.error?.code || 'stream_incomplete'
          logBag.error_message = result?.body?.error?.message || 'Stream did not reach a verified terminal state'
        }
      }
      rememberRefusal({ inbound, body: ctx.body, result, logBag, requestId: logCtx.request_id })
      return res.end()
    }

    if (!result?.ok || isIncompleteAssistantMessage(result)) {
      const failed = isIncompleteAssistantMessage(result) ? incompleteAssistantClientError(result) : result
      const mapped = mapProtocolClientError(failed, logBag, failed?.body?.error?.code || 'upstream_error')
      if (mapped.body?.error?.code !== 'client_cancelled') stats.errors++
      return json(res, mapped.status, mapped.body)
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

  return { handleProtocol, mapProtocolClientError, applyDistillGuard, streamAndAssembleClaudeMessage }
}
