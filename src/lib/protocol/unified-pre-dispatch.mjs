/**
 * Unified pre-dispatch JEV intercept gate (SSOT).
 *
 * Every public inference, generation, search, and Responses WebSocket frame
 * must pass through `runUnifiedPreDispatch` BEFORE any VM/Gemini/API slot
 * reservation. Metadata and token-counting routes (`/v1/models`, `/v1beta/models`,
 * `/v1/messages/count_tokens`) stay on their own non-inference handlers.
 *
 * Security invariant: `jev_downgrade_pool_id` is produced exclusively by
 * trusted server-side JEV / risk_audit_policy evaluation and stamped with an
 * unforgeable Symbol tag; caller headers or body fields can never inject it.
 */
import { keyAllowsVm, vmGroupType } from '../admin/key-scope.mjs'
import { findAccount } from '../admin/panel-api.mjs'
import { vmMatchesOwnerScope } from '../admin/resource-owner.mjs'
import { CLIENT_POOL_BUSY_MESSAGE, makePolicyOverloadError } from '../core/errors.mjs'
import { refusalAuditIdentity, refusalGuardPolicy, riskPrincipal } from '../core/refusal-guard.mjs'
import { RefusalDeviceBlocksRepo } from '../db/repos/refusal-device-blocks-repo.mjs'
import { RefusalGuardsRepo } from '../db/repos/refusal-guards-repo.mjs'
import { RefusalSessionBlocksRepo } from '../db/repos/refusal-session-blocks-repo.mjs'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { listVms } from '../vm/vm-registry.mjs'
import { normalizeJevProfile, runProtocolIntercept } from './intercept-gate.mjs'
import { readJevConfig, scopeAccountFromVm } from './jev-intercept.mjs'

const TRUSTED_DECISION_TAG = Symbol('vm2api.trusted_pre_dispatch')

export function isTrustedGateDecision(decision) {
  return Boolean(decision && typeof decision === 'object' && decision[TRUSTED_DECISION_TAG] === true)
}

/**
 * Extract strictly client-safe error fields from a blocking `GateDecision`.
 * Never exposes internal log fields (`decision.error_code`, `decision.message`,
 * `decision.error_details` / `jev_score_*`); falls back to a disguised 429
 * overload error if `decision.error.body` is absent.
 */
export function clientBlockErrorOf(decision) {
  const err = decision?.error?.body?.error
  if (err && typeof err === 'object') {
    const hasDetails = Boolean(err.details && typeof err.details === 'object' && Object.keys(err.details).length)
    return {
      status: Number(decision?.error?.status) || Number(decision?.status) || 400,
      type: err.type || 'api_error',
      code: err.code || 'api_error',
      message: err.message || CLIENT_POOL_BUSY_MESSAGE,
      details: hasDetails ? err.details : undefined,
      requestId: err.request_id || undefined,
      body: decision.error.body,
    }
  }
  const fallback = makePolicyOverloadError({
    requestId: decision?.audit_id || undefined,
    retryAfterSec: decision?.retry_after_sec,
  })
  return {
    status: fallback.status,
    type: fallback.body.error.type,
    code: fallback.body.error.code,
    message: fallback.body.error.message,
    details: undefined,
    requestId: fallback.body.error.request_id || undefined,
    body: fallback.body,
  }
}

export function readRuntimeJevConfig(settings = null) {
  try {
    const repo = settings || new SettingsRepo()
    return readJevConfig((key, fallback) => repo.get(key, fallback))
  } catch {
    return readJevConfig()
  }
}

export function readRuntimeRefusalPolicy(settings = null) {
  try {
    const repo = settings || new SettingsRepo()
    return refusalGuardPolicy((key, fallback) => repo.get(key, fallback))
  } catch {
    return refusalGuardPolicy()
  }
}

export function resolveRiskRepos({
  settings = null,
  refusalGuards = null,
  refusalDevices = null,
  refusalSessions = null,
} = {}) {
  const safe = (provided, Factory) => {
    if (provided) return provided
    try {
      return new Factory()
    } catch {
      return null
    }
  }
  return {
    policy: readRuntimeRefusalPolicy(settings),
    repo: safe(refusalGuards, RefusalGuardsRepo),
    devices: safe(refusalDevices, RefusalDeviceBlocksRepo),
    sessions: safe(refusalSessions, RefusalSessionBlocksRepo),
  }
}

/**
 * Statically project eligible VMs for the current request's key/owner/platform
 * scope so legacy `jev.account_ids` / `account_platform_plans` are decided
 * BEFORE slot reservation instead of deferring to Phase 3 `scope-wait`.
 */
export function projectCandidateAccounts({
  projectRoot = '',
  keyScope = null,
  ownerScope = null,
  platform = '',
  accountQuota = null,
} = {}) {
  if (!projectRoot) return []
  let vms
  try {
    vms = listVms(projectRoot)
  } catch {
    return []
  }
  if (!Array.isArray(vms) || !vms.length) return []
  const wantPlatform = String(platform || '')
    .trim()
    .toLowerCase()
  const accounts = []
  for (const vm of vms) {
    if (!vm || vm.disabled || vm.schedulable === false) continue
    if (ownerScope && !vmMatchesOwnerScope(vm, ownerScope)) continue
    if (keyScope && !keyAllowsVm(keyScope, vm)) continue
    if (wantPlatform && wantPlatform !== 'all') {
      const vmType = vmGroupType(vm)
      if (wantPlatform === 'openai' || wantPlatform === 'gpt' || wantPlatform === 'codex') {
        if (vmType !== 'openai') continue
      } else if (wantPlatform === 'anthropic' || wantPlatform === 'claude') {
        if (vmType !== 'anthropic') continue
      }
    }
    const unified = accountQuota ? findAccount(accountQuota, vm)?.unified : null
    const account = scopeAccountFromVm(vm, unified)
    if (account) accounts.push(account)
  }
  return accounts
}

function sealDecision(decision) {
  Object.defineProperty(decision, TRUSTED_DECISION_TAG, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  })
  return Object.freeze(decision)
}

/**
 * Normalize raw `runProtocolIntercept` verdict into Architecture v4 §2.2
 * `GateDecision`: `allow | block | downgrade`.
 */
export function toGateDecision(rawDecision, { requestId = '', backend = '' } = {}) {
  const decisionBackend = backend ? String(backend) : ''
  if (!rawDecision || rawDecision.action === 'pass') {
    const route = rawDecision?.route || null
    if (route && typeof route === 'object' && route.target) {
      return sealDecision({
        action: 'downgrade',
        ...(decisionBackend ? { backend: decisionBackend } : {}),
        ...(route.kind === 'pool' ? { jev_downgrade_pool_id: String(route.target) } : {}),
        ...(route.kind === 'model' ? { override_model: String(route.target) } : {}),
        ...(route.kind === 'endpoint' ? { override_endpoint_id: String(route.target) } : {}),
        reason: rawDecision.downgradeReason || `jev:${route.kind || 'downgrade'}`,
        route,
        jev_state: rawDecision.jevState || '',
        scores: rawDecision.jevScores || null,
        audit_id: String(requestId || ''),
        intercept: rawDecision.intercept || null,
        jev_passed: rawDecision.jevPassed === true,
        raw: rawDecision,
      })
    }
    return sealDecision({
      action: 'allow',
      ...(decisionBackend ? { backend: decisionBackend } : {}),
      jev_state: rawDecision?.jevState || '',
      scores: rawDecision?.jevScores || null,
      audit_id: String(requestId || ''),
      intercept: rawDecision?.intercept || null,
      jev_passed: rawDecision?.jevPassed === true,
      raw: rawDecision || null,
    })
  }

  const status = Number(rawDecision.error?.status) || 400
  const retryAfterSec = Number(rawDecision.error?.retryAfterSec)
  return sealDecision({
    action: 'block',
    status,
    error_code: rawDecision.logErrorCode || rawDecision.error?.body?.error?.code || 'policy_blocked',
    message: rawDecision.errorMessage || rawDecision.error?.body?.error?.message || '请求被协议拦截',
    ...(Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? { retry_after_sec: retryAfterSec } : {}),
    error: rawDecision.error,
    via: rawDecision.via || 'jev',
    final_state: rawDecision.final_state || 'policy_blocked',
    intercept: rawDecision.intercept || null,
    jev_state: rawDecision.jevState || null,
    error_details: rawDecision.errorDetails || null,
    raw: rawDecision,
  })
}

/**
 * Single pre-dispatch JEV entry shared by Anthropic, OpenAI HTTP/WS, Gemini,
 * `/v1/alpha/search`, and `/v1/images/*`.
 *
 * Never reads `jev_downgrade_pool_id` or `jev_profile` from caller headers.
 */
export async function runUnifiedPreDispatch({
  req = null,
  inbound,
  body = inbound,
  headers = req?.headers || {},
  identity = null,
  official = false,
  classifier = null,
  zeroInject = false,
  distillRules = null,
  policy = null,
  jev = undefined,
  settings = null,
  repo = null,
  devices = null,
  sessions = null,
  requestId = '',
  account = null,
  scopeMatched = false,
  candidateAccounts = null,
  poolJevProfile = null,
  channel = 'anthropic',
  skipDistill = undefined,
  enforceHardAndJev = undefined,
  bodyCtx = null,
  interceptSession = null,
  mandatoryOnly = false,
  skipMandatory = false,
  backend = 'oauth',
  openaiPlatform = undefined,
  fetchImpl = undefined,
  now = undefined,
} = {}) {
  const effectiveChannel = String(channel || 'anthropic')
    .trim()
    .toLowerCase()
  const effectiveProfile = normalizeJevProfile(poolJevProfile)
  const resolvedIdentity =
    identity ||
    refusalAuditIdentity({
      inbound,
      body,
      headers,
      principal: req ? riskPrincipal(req) : '',
    })
  const resolvedJev = mandatoryOnly ? null : jev !== undefined ? jev : readRuntimeJevConfig(settings)
  const resolvedPolicy = policy || readRuntimeRefusalPolicy(settings)

  // Public non-Claude generation/search/Gemini endpoints must never be skipped
  // by `openai_platform_enabled=false`.
  const forceGate =
    enforceHardAndJev !== undefined
      ? enforceHardAndJev === true
      : effectiveChannel === 'gemini' || effectiveChannel === 'search' || effectiveChannel === 'images'
  const effectiveSkipDistill =
    skipDistill !== undefined ? skipDistill === true : effectiveChannel === 'search' || effectiveChannel === 'images'

  const rawDecision = await runProtocolIntercept({
    inbound,
    body,
    headers,
    identity: resolvedIdentity,
    official,
    classifier,
    zeroInject,
    distillRules,
    policy: resolvedPolicy,
    jev: resolvedJev,
    repo,
    devices,
    sessions,
    requestId,
    account,
    scopeMatched,
    candidateAccounts,
    jevProfile: effectiveProfile,
    preDispatch: true,
    skipDistill: effectiveSkipDistill,
    enforceHardAndJev: forceGate,
    bodyCtx,
    interceptSession,
    mandatoryOnly,
    skipMandatory,
    backend,
    ...(openaiPlatform !== undefined ? { openaiPlatform } : {}),
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    ...(now !== undefined ? { now } : {}),
  })

  return toGateDecision(rawDecision, { requestId, backend })
}
