/**
 * User protocol: POST /v1/messages/count_tokens and GET /v1/usage.
 * Peek only — never bind/unbind sticky or bill tokens_in.
 */
import { makeError, rewritePoolErrorForClient, ErrorType, ErrorCode } from '../core/errors.mjs'
import { detectDistill, distillBlockError } from '../core/distill-detect.mjs'
import { isRefusalGuardEnabled, refusalFingerprint, refusalGuardError } from '../core/refusal-guard.mjs'
import { RefusalGuardsRepo } from '../db/repos/refusal-guards-repo.mjs'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { readRoutingConfigFile } from '../core/config.mjs'
import {
  detectProxiedOfficialCcFromRouting,
  isOfficialClaudeCodeTraffic,
  isProxiedOfficialClaudeCode,
} from '../identity/crs-persona.mjs'
import { canCountTokens, canOfficialUsage, credentialModeOfVm, isApiKeyMode } from '../oauth/credential-mode.mjs'
import { getUsageCache } from '../oauth/usage-cache.mjs'
import { probeAccount } from '../oauth/usage-probe.mjs'
import { isOfficialUsageRateLimited, shouldHopOfficialUsage } from '../oauth/crs-usage-probe.mjs'
import { countTokensViaWorker } from '../transport/go-worker-client.mjs'
import { apiKeyBetaHeader, setupTokenBetaHeader } from './claude-code-betas.mjs'
import { listQuotaFromHeaders, publicUsageWindow, usageWindowsEmpty } from '../pool/quota-window.mjs'
import { ownerScopeFromRequest } from '../admin/resource-owner.mjs'
import { detectInboundPlatform } from './platform-detect.mjs'
import { resolveInboundIdentity } from '../identity/identity-rewrite.mjs'
export function countTokensUnsupportedError() {
  return makeError({
    type: ErrorType.INVALID_REQUEST,
    code: ErrorCode.COUNT_TOKENS_UNSUPPORTED,
    message: 'count_tokens 只支持 Setup Token / Console API Key，OAuth 请用 GET /v1/usage',
    status: 400,
  })
}

export function usageUnsupportedError() {
  return makeError({
    type: ErrorType.INVALID_REQUEST,
    code: ErrorCode.USAGE_UNSUPPORTED,
    message: 'usage 只支持 OAuth / Setup Token 账户，API Key 请用 POST /v1/messages/count_tokens',
    status: 400,
  })
}

export function parseCountTokensBody(inbound = {}) {
  const model = String(inbound.model || inbound.model_id || '').trim()
  const messages = Array.isArray(inbound.messages) ? inbound.messages : null
  if (!model || !messages?.length) {
    return {
      ok: false,
      error: makeError({
        type: ErrorType.INVALID_REQUEST,
        code: ErrorCode.MISSING_FIELD,
        message: 'model 与 messages 必填',
        param: model ? 'messages' : 'model',
        status: 400,
      }),
    }
  }
  const body = { model, messages }
  if (inbound.system != null) body.system = inbound.system
  if (Array.isArray(inbound.tools)) body.tools = inbound.tools
  return { ok: true, body }
}

export function buildUsageView(listed = {}, source = 'extra') {
  return {
    unit: 'percent_used',
    five_hour: publicUsageWindow(
      listed['5h'] || {
        utilization: listed.utilization_5h,
        status: listed.status_5h,
        reset: listed.reset_5h,
      },
    ),
    seven_day: publicUsageWindow(
      listed['7d'] || {
        utilization: listed.utilization_7d,
        status: listed.status_7d,
        reset: listed.reset_7d,
      },
    ),
    source,
  }
}

export async function peekCurrentAccount({
  poolScheduler,
  stickyRouter,
  req,
  inbound = {},
  model,
  signal,
  usersRepo = null,
} = {}) {
  const detected = detectInboundPlatform(model)
  const platform = detected.ok ? detected.platform : undefined
  const identity = resolveInboundIdentity({ inbound, body: inbound, headers: req?.headers || {} })
  const stickyKey =
    (platform === 'anthropic' && identity.sessionId && stickyRouter?.sessionPoolKeys
      ? stickyRouter.sessionPoolKeys(req, inbound, {
          sessionId: identity.sessionId,
          deviceId: identity.deviceId,
          migrate: false,
        }).stickyKey
      : stickyRouter?.extractPoolKey?.(req, inbound, { platform })) || null
  if (!poolScheduler?.peekAccount) {
    return { ok: false, code: 'no_eligible_accounts' }
  }
  return poolScheduler.peekAccount({
    model,
    stickyKey,
    signal,
    ownerScope: ownerScopeFromRequest(req, usersRepo),
  })
}
function poolFail(peeked) {
  return rewritePoolErrorForClient(
    makeError({
      type: ErrorType.OVERLOADED,
      code: peeked?.code || ErrorCode.SERVER_OVERLOADED,
      message: peeked?.code || 'no_eligible_accounts',
      status: 503,
    }),
  )
}

function distillContext(req, inbound) {
  let routing = null
  try {
    routing = readRoutingConfigFile()
  } catch {
    routing = null
  }
  const official =
    isOfficialClaudeCodeTraffic(req?.headers || {}, inbound) ||
    (detectProxiedOfficialCcFromRouting(routing || {}) && isProxiedOfficialClaudeCode(inbound, req?.headers || {}))
  const inject = String(routing?.compatibility?.persona_inject || '')
    .trim()
    .toLowerCase()
  const preset = String(routing?.compatibility?.persona_preset || '')
    .trim()
    .toLowerCase()
  return { official, zeroInject: inject === 'zero' || preset === 'zero' }
}

function refusalEnabled(deps) {
  try {
    const settings = deps.settings || new SettingsRepo()
    return isRefusalGuardEnabled((key, fallback) => settings.get(key, fallback))
  } catch {
    return isRefusalGuardEnabled()
  }
}

function refusalRepo(deps) {
  if (deps.refusalGuards) return deps.refusalGuards
  try {
    return new RefusalGuardsRepo()
  } catch {
    return null
  }
}

/** Distill and refusal-cache hits return before peek or worker hop. */
export function blockCountTokensBeforeHop(req, inbound, deps = {}) {
  const hit = detectDistill({ inbound, body: inbound, ...distillContext(req, inbound) }, deps.cfg?.distill)
  if (hit.action === 'block') return distillBlockError(deps.cfg?.distill)
  if (!refusalEnabled(deps)) return null
  const repo = refusalRepo(deps)
  if (!repo) return null
  const row = repo.get(refusalFingerprint(inbound, inbound))
  if (!row) return null
  try {
    repo.hit(row.fingerprint)
  } catch {
    /* counter is best-effort; the response still must not hop */
  }
  return refusalGuardError()
}

export async function handleUserCountTokens(req, res, deps) {
  const json = (...args) => deps.json(...args)
  if (!deps.requireAuth(req, res)) return
  let inbound
  try {
    inbound = await deps.readBody(req, deps.cfg.limits.max_body_bytes)
  } catch (error) {
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
  const parsed = parseCountTokensBody(inbound)
  if (!parsed.ok) return json(res, parsed.error.status, parsed.error.body)
  const blocked = blockCountTokensBeforeHop(req, parsed.body, deps)
  if (blocked) return json(res, blocked.status, blocked.body)
  const peeked = await peekCurrentAccount({
    poolScheduler: typeof deps.getPoolScheduler === 'function' ? deps.getPoolScheduler() : deps.poolScheduler,
    stickyRouter: deps.stickyRouter,
    req,
    inbound,
    model: parsed.body.model,
    usersRepo: deps.apiKeyStore?.users || null,
  })
  if (!peeked.ok) {
    const mapped = poolFail(peeked)
    return json(res, mapped.status, mapped.body)
  }
  const mode = credentialModeOfVm(peeked.vm)
  if (!canCountTokens(mode)) {
    const { listed, source } = await resolveUsageWindows({
      accountQuota: deps.accountQuota,
      accountId: peeked.accountId,
      vmId: peeked.vmId,
      exec: peeked.exec,
      vm: peeked.vm,
      usageCache: deps.usageCache,
      probe: deps.probeAccount,
    })
    return json(res, 200, buildUsageView(listed, source))
  }
  const hop = await (deps.countTokensViaWorker || countTokensViaWorker)(peeked.exec, {
    body: parsed.body,
    headers: {
      'user-agent': 'kin-inference/1.0',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': isApiKeyMode(mode) ? apiKeyBetaHeader('') : setupTokenBetaHeader(parsed.body.model),
    },
    timeoutMs: 45000,
  })
  if (!hop.ok) {
    const err = hop.body?.error || {}
    return json(
      res,
      hop.status && hop.status >= 400 ? hop.status : 502,
      makeError({
        type: err.type || ErrorType.UPSTREAM,
        code: err.code || 'count_tokens_failed',
        message: err.message || 'count_tokens 失败',
        status: hop.status && hop.status >= 400 ? hop.status : 502,
      }).body,
    )
  }
  const raw = hop.body && typeof hop.body === 'object' ? hop.body : {}
  const inputTokens = Number(raw.input_tokens)
  return json(res, 200, { ...raw, input_tokens: Number.isFinite(inputTokens) ? inputTokens : 0 })
}

export async function resolveUsageWindows({
  accountQuota,
  accountId,
  vmId,
  exec,
  vm,
  usageCache,
  probe = probeAccount,
} = {}) {
  const acc =
    accountQuota?.repo?.get?.(accountId) || accountQuota?.ensure?.({ account_id: accountId, vm_id: vmId }) || null
  let listed = listQuotaFromHeaders(acc?.unified || {})
  let source = 'extra'
  if (!usageWindowsEmpty(listed)) return { listed, source }
  if (!shouldHopOfficialUsage(acc?.unified, { hop: true })) return { listed, source }
  const cache = usageCache || getUsageCache()
  let result
  try {
    result = await cache.load(accountId, () => probe({ exec, vm, includeFable: false }))
  } catch {
    return { listed, source }
  }
  if (!result || isOfficialUsageRateLimited(result)) return { listed, source }
  try {
    accountQuota?.ingestOAuthUsage?.(accountId, result)
  } catch {}
  const next = accountQuota?.repo?.get?.(accountId) || acc
  listed = listQuotaFromHeaders(next?.unified || {})
  source = 'oauth-usage'
  return { listed, source }
}

export async function handleUserUsage(req, res, deps) {
  const json = (...args) => deps.json(...args)
  if (!deps.requireAuth(req, res)) return
  const peeked = await peekCurrentAccount({
    poolScheduler: typeof deps.getPoolScheduler === 'function' ? deps.getPoolScheduler() : deps.poolScheduler,
    stickyRouter: deps.stickyRouter,
    req,
    inbound: {},
    usersRepo: deps.apiKeyStore?.users || null,
  })
  if (!peeked.ok) {
    const mapped = poolFail(peeked)
    return json(res, mapped.status, mapped.body)
  }
  const mode = credentialModeOfVm(peeked.vm)
  if (!canOfficialUsage(mode)) {
    const err = usageUnsupportedError()
    return json(res, err.status, err.body)
  }
  const { listed, source } = await resolveUsageWindows({
    accountQuota: deps.accountQuota,
    accountId: peeked.accountId,
    vmId: peeked.vmId,
    exec: peeked.exec,
    vm: peeked.vm,
    usageCache: deps.usageCache,
    probe: deps.probeAccount,
  })
  return json(res, 200, buildUsageView(listed, source))
}
