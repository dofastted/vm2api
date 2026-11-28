import { detectDistill, distillBlockError, isOpenaiPlatformModel } from '../core/distill-detect.mjs'
import { DB_INSTANCE_ID, getDb, isDbOpen } from '../db/database.mjs'
import { getCacheRuntime } from '../cache/index.mjs'
import { redactSecrets } from '../core/security.mjs'
import {
  ErrorType,
  isThirdPartyClientMessage,
  makeError,
  makePolicyOverloadError,
  makeRefusalGuardError,
} from '../core/errors.mjs'
import {
  blockedRiskTool,
  classifyUpstream400,
  classifyUpstreamError,
  DEFAULT_BAN_STEPS,
  isUpstream400Reason,
  matchRefusalSession,
  matchStoredRefusal,
  refusalFingerprint,
  refusalGuardError,
  refusalPreview,
  refusalPromptSignature,
  refusalAuditIdentity,
  refusalSessionId,
  resolveAuditSessionIdentity,
  UPSTREAM_400_SESSION_BLOCK_MS,
  UPSTREAM_400_SESSION_REASON,
} from '../core/refusal-guard.mjs'
import {
  HARD_POLICY_RULES,
  POLICY_BLOCK_MESSAGE,
  classifyJev,
  isPolicyBlockMemory,
  jevDocument,
  jevAccountInScope,
  jevModelDocument,
  jevScopeConfigured,
  jevScopeWaits,
  matchHardPolicy,
  policyBlockError,
} from './jev-intercept.mjs'
import { gateVerdict } from './intercept-stats.mjs'
import { prepareInterceptText } from './jev-prepare.mjs'

// Only an order to the model to drop its system prompt counts. Docs and skills
// talk about "changing the system message" all the time, so the verb must open
// a clause (or follow please / you must), only determiners may sit between verb
// and target, and "system message" is not a target. "Change/edit/set/modify the
// system prompt" is ordinary developer talk and is not matched.
const REWRITE_LEAD = String.raw`(?:^|[.!?:;,，。、！？；"'(\[#>*-]\s*|\b(?:please|now|just|and|then|so|ok|okay|also|instead|first|you\s+(?:must|should|will|need\s+to|have\s+to)|i\s+(?:want|need)\s+you\s+to)\s+)`
const REWRITE_DET = String.raw`(?:(?:all|any|every|of|the|your|my|these|those|previous|prior|above|earlier|preceding|original|existing|current|default|built-?in)\s+){1,4}(?:\w+\s+)?`
const REWRITE_TARGET = String.raw`(?:system|developer)[\s_-]*(?:prompts?|instructions?|rules|directives?)\b`
const SYSTEM_REWRITE = [
  new RegExp(
    `${REWRITE_LEAD}(?:ignore|disregard|forget|override|bypass|discard|drop)\\s+${REWRITE_DET}${REWRITE_TARGET}`,
    'giu',
  ),
  // "ignore all previous system instructions" reads as an order anywhere.
  new RegExp(
    String.raw`\b(?:ignore|disregard|forget|override|bypass)\s+(?:all|any)\s+(?:of\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier|preceding)\s+${REWRITE_TARGET}`,
    'giu',
  ),
  new RegExp(
    `${REWRITE_LEAD}(?:replace|rewrite|overwrite)\\s+(?:your|the)\\s+(?:\\w+\\s+)?(?:system|developer)[\\s_-]*(?:prompts?|instructions?)\\s+with\\b`,
    'giu',
  ),
  /(?:忽略|无视|忘记|忘掉|绕过|跳过|覆盖|抛弃|丢弃)掉?(?:你|你的|之前|之前的|此前的|上面|上面的|以上|以上的|前面的|原有的|原来的|原始|全部|所有|一切)[^。\n！？；;]{0,8}?(?:系统提示词|系统提示|系统指令|系统设定|开发者指令|system\s*prompt)/giu,
  /(?:把|将)?你的(?:系统提示词|系统提示|系统指令)(?:改|换|替换|改写|重写)(?:成|为)/giu,
]
const NEGATED_REWRITE =
  /(?:\b(?:do not|don't|never|must not|should not|cannot|can't|won't)\s+|(?:不得|禁止|不要|不可|不允许|不能|勿|别)\s*)$/iu
const REWRITE_LEAD_TAIL = /[.!?:;,，。、！？；"'([#>*-]\s*$/u
const REWRITE_LEAD_PREFIX = new RegExp(`^${REWRITE_LEAD}`, 'iu')

/** Exported for tests. Returns the matched order, or '' when none. */
export function systemRewrite(document) {
  const text = String(document || '').normalize('NFKC')
  for (const rule of SYSTEM_REWRITE) {
    for (const match of text.matchAll(rule)) {
      const lead = match[0].length - match[0].replace(REWRITE_LEAD_PREFIX, '').length
      const at = match.index + lead
      const head = text.slice(Math.max(0, at - 40), at).replace(REWRITE_LEAD_TAIL, '')
      if (!NEGATED_REWRITE.test(head)) return match[0].slice(lead).trim()
    }
  }
  return ''
}

function isJevReason(reason) {
  return typeof reason === 'string' && reason.startsWith('jev:') && reason !== 'jev:unavailable'
}

function retryAfterFromExpiry(expiresAt, now, fallbackSec = 600) {
  const ms = expiresAt ? Date.parse(expiresAt) - now : NaN
  if (!Number.isFinite(ms) || ms <= 0) return fallbackSec
  return Math.max(1, Math.ceil(ms / 1000))
}

function enforcesBan(policy, row) {
  if (isJevReason(row?.reason) || isUpstream400Reason(row?.reason)) {
    if (row?.subject_kind === 'session' && policy?.session_block_enabled === false) return false
    return true
  }
  return !!(policy?.enabled && (policy.device_block_enabled || row?.reason?.endsWith(':nsfw')))
}

const RISK_BAN_PREFIX = 'risk:bans:'
const RISK_SESSION_PREFIX = 'risk:bans:session:'
const RISK_DEVICE_PREFIX = 'risk:bans:device:'
const RISK_BAN_L1_TTL_MS = 10_000
const RISK_BAN_L2_TTL_MS = 15_000

const wrappedBanRepos = new WeakSet()
const wrappedBanProtos = new WeakSet()

function riskScopePrefix(db) {
  if (!db) return 'mock:'
  if (isDbOpen() && db === getDb()) return ''
  return `${db?.[DB_INSTANCE_ID] || 'isolated'}:`
}

/**
 * Invalidate cached refusal session/device ban verdicts across L1 + Redis L2.
 * Accepts `{ kind?: 'session'|'device'|'all'|null, db?: Database|null }` or a
 * shorthand kind string (`'session'|'device'|'all'`). Safe to call fire-and-forget.
 */
export function invalidateRiskBanCache(opts = {}) {
  const client = getCacheRuntime()?.client
  if (!client) return Promise.resolve()
  const kind = typeof opts === 'string' ? opts : (opts?.kind ?? null)
  const db = typeof opts === 'object' && opts !== null ? (opts.db ?? null) : null
  const prefix =
    kind === 'session'
      ? `${RISK_SESSION_PREFIX}${db ? riskScopePrefix(db) : ''}`
      : kind === 'device'
        ? `${RISK_DEVICE_PREFIX}${db ? riskScopePrefix(db) : ''}`
        : `${RISK_BAN_PREFIX}`
  return client.invalidate({ prefixes: [prefix] }).catch(() => {})
}

function attachBanRepoInvalidationHooks(repo, kind) {
  if (!repo || !repo.db) return
  const methods =
    kind === 'session'
      ? ['block', 'remove', 'clear']
      : ['block', 'blockSession', 'recordViolation', 'remove', 'clear', 'linkAlias']
  const proto = Object.getPrototypeOf(repo)
  if (proto && proto !== Object.prototype) {
    if (wrappedBanProtos.has(proto)) return
    wrappedBanProtos.add(proto)
    for (const name of methods) {
      const orig = proto[name]
      if (typeof orig !== 'function') continue
      proto[name] = function wrappedRiskBanWrite(...args) {
        const out = orig.apply(this, args)
        if (this?.db) invalidateRiskBanCache({ kind, db: this.db })
        return out
      }
    }
    return
  }
  if (wrappedBanRepos.has(repo)) return
  wrappedBanRepos.add(repo)
  for (const name of methods) {
    if (typeof repo[name] !== 'function') continue
    const orig = repo[name].bind(repo)
    repo[name] = (...args) => {
      const out = orig(...args)
      invalidateRiskBanCache({ kind, db: repo.db })
      return out
    }
  }
}

function deviceBanCacheKey(db, identity, policy) {
  const scope = riskScopePrefix(db)
  const policyKey = `${policy?.enabled ? 1 : 0}:${policy?.device_block_enabled ? 1 : 0}:${policy?.session_block_enabled === false ? 0 : 1}`
  const parts = [
    identity?.principal || '',
    identity?.deviceId || '',
    identity?.sessionId || '',
    identity?.ip || '',
    identity?.keyId || '',
    identity?.userId || '',
    ...(Array.isArray(identity?.aliases) ? identity.aliases : []),
  ]
  return `${RISK_DEVICE_PREFIX}${scope}${policyKey}:${parts.join('|')}`
}

async function cachedMatchRefusalSession({ inbound, body, headers, sessions, now }) {
  if (!sessions) return null
  const useCache = Boolean(sessions.db && getCacheRuntime()?.client?.enabled && Math.abs(now - Date.now()) <= 60_000)
  if (!useCache) {
    return matchRefusalSession({ inbound, body, headers, sessions })
  }
  attachBanRepoInvalidationHooks(sessions, 'session')
  const sessionId = refusalSessionId({ inbound, body, headers })
  if (!sessionId) return null
  const scope = riskScopePrefix(sessions.db)
  const key = `${RISK_SESSION_PREFIX}${scope}${sessionId}`
  const client = getCacheRuntime().client
  const isPrimary = scope === ''
  const hit = await client.get(key, {
    useL2: isPrimary,
    prefixes: [RISK_BAN_PREFIX, RISK_SESSION_PREFIX],
    maxL1TtlMs: RISK_BAN_L1_TTL_MS,
  })
  if (hit.hit) {
    const cached = hit.value?.v ?? null
    if (!cached) return null
    if (cached.row?.expires_at && Date.parse(cached.row.expires_at) <= now) {
      invalidateRiskBanCache({ kind: 'session', db: sessions.db })
      return null
    }
    return cached
  }
  const matched = matchRefusalSession({ inbound, body, headers, sessions })
  if (isPrimary) {
    await client.set(
      key,
      { v: matched || null },
      {
        ttlMs: RISK_BAN_L2_TTL_MS,
        l1TtlMs: RISK_BAN_L1_TTL_MS,
        prefixes: [RISK_BAN_PREFIX, RISK_SESSION_PREFIX],
      },
    )
  } else {
    client.setL1(key, { v: matched || null }, RISK_BAN_L1_TTL_MS)
  }
  return matched
}

async function cachedFindDeviceBan({ devices, identity, policy, now }) {
  if (!devices?.findBan) return null
  const useCache = Boolean(devices.db && getCacheRuntime()?.client?.enabled && Math.abs(now - Date.now()) <= 60_000)
  const accepts = (row) => enforcesBan(policy, row)
  if (!useCache) {
    return devices.findBan(identity, now, accepts)
  }
  attachBanRepoInvalidationHooks(devices, 'device')
  const scope = riskScopePrefix(devices.db)
  const key = deviceBanCacheKey(devices.db, identity, policy)
  const client = getCacheRuntime().client
  const isPrimary = scope === ''
  const hit = await client.get(key, {
    useL2: isPrimary,
    prefixes: [RISK_BAN_PREFIX, RISK_DEVICE_PREFIX],
    maxL1TtlMs: RISK_BAN_L1_TTL_MS,
  })
  if (hit.hit) {
    const cached = hit.value?.v ?? null
    if (!cached) return null
    if (cached.expires_at && Date.parse(cached.expires_at) <= now) {
      invalidateRiskBanCache({ kind: 'device', db: devices.db })
    } else {
      return cached
    }
  }
  const found = devices.findBan(identity, now, accepts) || null
  if (isPrimary) {
    await client.set(
      key,
      { v: found },
      {
        ttlMs: RISK_BAN_L2_TTL_MS,
        l1TtlMs: RISK_BAN_L1_TTL_MS,
        prefixes: [RISK_BAN_PREFIX, RISK_DEVICE_PREFIX],
      },
    )
  } else {
    client.setL1(key, { v: found }, RISK_BAN_L1_TTL_MS)
  }
  return found
}

function recordBan(decision, { devices, policy, requestId, now = Date.now() }) {
  if (!decision.banDevice || !decision.identity) return null
  const jevHit = isJevReason(decision.reason)
  if (!jevHit && (!policy?.enabled || (!policy.device_block_enabled && !decision.forceDeviceBan))) return null
  const identity =
    policy?.session_block_enabled === false && decision.identity.sessionId
      ? { ...decision.identity, sessionId: '' }
      : decision.identity
  const store = devices
  const evidence = { requestId, fingerprint: decision.fingerprint || null, reason: decision.reason || decision.kind }
  try {
    if (store?.recordViolation) {
      const ban =
        store.recordViolation(identity, {
          ...evidence,
          steps: policy?.risk_audit?.ban_steps || DEFAULT_BAN_STEPS,
          now,
          accepts: (row) => enforcesBan(policy, row),
        }) || null
      if (ban) invalidateRiskBanCache({ kind: 'device', db: store.db || null })
      return ban
    }
    if (identity.deviceId) {
      const ban = store?.block?.({ ...evidence, deviceId: identity.deviceId }) || null
      if (ban) invalidateRiskBanCache({ kind: 'device', db: store.db || null })
      return ban
    }
  } catch {
    console.warn('[risk-audit] failed to persist ban')
  }
  return null
}

const OVER_REFUSAL_SAFE_FLOOR = 0.85

/**
 * Single non-NSFW JEV hits at or above this floor refuse only the current
 * request without permanently banning the session or adding a device strike.
 * NSFW hits, multi-question hits, and scores strictly below this floor still
 * escalate to session + 3-strike device bans.
 */
export const JEV_BAN_CONFIDENCE_FLOOR = 0.25

/** Flatten JEV per-question scores into scalar error_details fields (`jev_score_<id>`). */
export function jevScoreDetails(scores) {
  if (!scores || typeof scores !== 'object') return {}
  const out = {}
  for (const [id, raw] of Object.entries(scores)) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id)) continue
    const num = Number(raw)
    if (Number.isFinite(num) && num >= 0 && num <= 1) {
      out[`jev_score_${id}`] = Math.round(num * 1000) / 1000
    }
  }
  return out
}

function minJevScore(scores) {
  if (!scores || typeof scores !== 'object') return null
  const vals = Object.values(scores)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 1)
  return vals.length ? Math.min(...vals) : null
}

function lowestHitScore(verdict) {
  const hitScores = Array.isArray(verdict?.hits)
    ? verdict.hits.map((h) => Number(h?.score)).filter((n) => Number.isFinite(n) && n >= 0 && n <= 1)
    : []
  if (hitScores.length) return Math.min(...hitScores)
  const raw = Number(verdict?.score)
  if (Number.isFinite(raw) && raw >= 0 && raw <= 1) return raw
  return minJevScore(verdict?.scores)
}

export function shouldEscalateJevBan(verdict, jev = null) {
  if (!verdict || verdict.action !== 'block' || verdict.reason === 'unavailable') return false
  if (jev?.block_if_below === false) return true
  const categories =
    Array.isArray(verdict.categories) && verdict.categories.length
      ? verdict.categories
      : verdict.category
        ? [verdict.category]
        : []
  if (categories.includes('nsfw') || categories.length >= 2) return true
  const score = lowestHitScore(verdict)
  if (score === null) return true
  return score < JEV_BAN_CONFIDENCE_FLOOR
}

function mergeLogErrorDetails(logBag, patch) {
  if (!logBag || !patch || !Object.keys(patch).length) return
  logBag.error_details = { ...(logBag.error_details || {}), ...patch }
}

export function recordUpstream400SessionBlock({
  inbound,
  body = inbound,
  headers,
  identity,
  result,
  logBag = null,
  requestId = null,
  policy = null,
  devices = null,
  classifier = null,
  now = Date.now(),
} = {}) {
  const verdict = classifyUpstream400(result, {
    phrases: policy?.risk_audit?.upstream_policy_phrases,
    classifier,
  })
  if (!verdict) return null
  if (!verdict.blockSession) {
    if (logBag) logBag.risk_session_block_skipped = verdict.skipReason || verdict.category
    mergeLogErrorDetails(logBag, {
      upstream_400_category: verdict.category,
      upstream_400_action: 'skipped',
    })
    return null
  }
  if (policy?.session_block_enabled === false) {
    mergeLogErrorDetails(logBag, {
      upstream_400_category: verdict.category,
      upstream_400_action: 'skipped',
    })
    return null
  }
  const effectiveIdentity = resolveAuditSessionIdentity({ inbound, body, headers, identity })
  if (!effectiveIdentity.sessionId) {
    mergeLogErrorDetails(logBag, {
      upstream_400_category: verdict.category,
      upstream_400_action: 'no_session',
    })
    return null
  }
  try {
    const ban =
      devices?.blockSession?.(effectiveIdentity, {
        requestId,
        reason: verdict.reason || UPSTREAM_400_SESSION_REASON,
        ttlMs: UPSTREAM_400_SESSION_BLOCK_MS,
        now,
      }) || null
    if (ban) invalidateRiskBanCache({ kind: 'device', db: devices?.db || null })
    if (ban && ban.expires_at) {
      mergeLogErrorDetails(logBag, {
        upstream_400_category: verdict.category,
        upstream_400_action: 'session_10m',
        punishment: 'session_10m_400',
      })
    } else if (ban && !ban.expires_at) {
      mergeLogErrorDetails(logBag, {
        upstream_400_category: verdict.category,
        upstream_400_action: 'permanent_kept',
      })
    } else {
      mergeLogErrorDetails(logBag, {
        upstream_400_category: verdict.category,
      })
    }
    return ban
  } catch {
    console.warn('[risk-audit] failed to persist upstream 400 session block')
    return null
  }
}

export function observeUpstreamRisk({
  inbound,
  body = inbound,
  headers,
  identity,
  result,
  logBag,
  requestId,
  policy,
  repo,
  devices,
  classifier = null,
  blockSessionOn400 = true,
  now = Date.now(),
}) {
  if (!result || result.upstreamExecutions === 0 || result.transportError === true) return ''
  const rawMessage =
    result.upstreamError?.message ||
    result.body?.error?.message ||
    result.body?.message ||
    (typeof result.body === 'string' ? result.body : '')
  const classified = classifyUpstreamError(result, policy?.risk_audit?.upstream_policy_phrases)
  const isBadRequest = classified.status === 400 && result.ok !== true
  const reason = classified.bucket === 'policy' ? classified.reason : ''
  if (
    !isBadRequest &&
    classified.bucket !== 'policy' &&
    classified.bucket !== 'third_party' &&
    classified.bucket !== 'auth_suspect'
  ) {
    return ''
  }
  const effectiveIdentity = resolveAuditSessionIdentity({ inbound, body, headers, identity })
  const message = JSON.parse(redactSecrets(String(rawMessage))).slice(0, 500)
  if (isBadRequest) {
    logBag.audit_upstream_400 = true
    logBag.audit_upstream_400_message ||= message
    if (blockSessionOn400) {
      recordUpstream400SessionBlock({
        inbound,
        body,
        headers,
        identity: effectiveIdentity,
        result,
        logBag,
        requestId,
        policy,
        devices,
        classifier,
        now,
      })
    }
  }
  if (classified.bucket === 'protocol') {
    mergeLogErrorDetails(logBag, { risk_bucket: 'protocol' })
    return ''
  }
  if (classified.bucket === 'third_party') {
    mergeLogErrorDetails(logBag, { risk_bucket: 'third_party' })
    return ''
  }
  if (classified.bucket === 'auth_suspect') {
    logBag.audit_upstream_error_status = classified.status
    logBag.audit_upstream_400_message ||= message
    if (logBag._jevPassState) logBag.jev_state ||= logBag._jevPassState
    mergeLogErrorDetails(logBag, {
      risk_bucket: 'auth_suspect',
      ...(logBag._jevPassed ? { gate_miss: true } : {}),
      ...jevScoreDetails(logBag._jevPassScores),
    })
    return ''
  }
  if (!reason) return ''
  if (message) logBag.error_message = message
  logBag.error_code ||= 'content_filter_refusal'
  if (classified.status && classified.status >= 400 && !isBadRequest) {
    logBag.audit_upstream_error_status = classified.status
  }
  if (logBag._jevPassState) logBag.jev_state ||= logBag._jevPassState
  const minScore = minJevScore(logBag._jevPassScores)
  const fingerprint = reason === 'upstream:flagged_session' ? null : refusalFingerprint(body, inbound)
  const alreadyKnown = !!(fingerprint && repo?.get?.(fingerprint))
  // Dual-track anti-over-refusal guard: if JEV scored every question >= 0.85 and
  // this exact prompt has not failed before, cache the exact fingerprint only
  // (no global MinHash pollution and no device strike yet).
  const suspectOverRefusal =
    !!logBag._jevPassed &&
    reason === 'upstream:usage_policy' &&
    minScore !== null &&
    minScore >= OVER_REFUSAL_SAFE_FLOOR &&
    !alreadyKnown
  mergeLogErrorDetails(logBag, {
    risk_bucket: suspectOverRefusal ? 'policy_suspect' : 'policy',
    ...(logBag._jevPassed ? { gate_miss: true } : {}),
    ...jevScoreDetails(logBag._jevPassScores),
  })
  if (!policy?.enabled) return reason
  try {
    if (fingerprint)
      repo?.remember?.({
        fingerprint,
        model: body?.model || inbound?.model || '',
        requestId,
        errorMessage: message || reason,
        preview: refusalPreview(body, inbound),
        signature: suspectOverRefusal ? null : refusalPromptSignature(inbound, body),
      })
  } catch {
    console.warn('[risk-audit] failed to persist upstream refusal')
  }
  if (reason !== 'upstream:billing_refusal' && !suspectOverRefusal) {
    const escalated = recordBan(
      { identity: effectiveIdentity, fingerprint, reason, banDevice: true },
      { devices, policy, requestId, now },
    )
    if (isBadRequest && blockSessionOn400 && escalated && logBag?.error_details) {
      const nextDetails = { ...logBag.error_details, upstream_400_action: 'permanent_kept' }
      delete nextDetails.punishment
      logBag.error_details = nextDetails
    }
  }
  return reason
}

export function upstreamRiskClientError(reason, requestId) {
  return makeRefusalGuardError({
    requestId,
    message:
      reason === 'upstream:flagged_session'
        ? '上游已标记此会话，请勿继续使用此会话。'
        : reason === 'upstream:configured_policy'
          ? '上游因内容策略拒绝了此请求，请勿重试。'
          : '上游因使用政策拒绝了此请求，请勿重试。',
  })
}

function distillEvidenceMessage(message, evidence) {
  const text = String(message || '').trim()
  const why = String(evidence || '').trim()
  if (text && why) return `${text}: ${why}`
  return text || why
}

function hardRulesFor(jev, distillOn, openai) {
  const hardOn = jev?.hard_regex_enabled !== false
  const base = Array.isArray(jev?.rules) ? jev.rules : HARD_POLICY_RULES
  return base.filter((rule) => {
    if (!rule || rule.enabled === false) return false
    if (rule.category === 'distill') return distillOn && !openai
    return hardOn
  })
}

function similarityRatio(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0.9
  return n > 1 ? n / 100 : n
}

export function commitProtocolBlock(decision, { repo, devices, sessions, policy, requestId, now = Date.now() } = {}) {
  if (!decision || decision.action !== 'block') return
  if (decision.kind === 'session') {
    try {
      sessions?.hit?.(decision.sessionId)
    } catch {
      /* counter is best-effort */
    }
    return
  }
  if (decision.kind === 'device') {
    try {
      devices?.hit?.(decision.deviceId)
    } catch {
      console.warn('[risk-audit] failed to record ban hit')
    }
    return
  }
  if ((decision.kind === 'exact' || decision.kind === 'similar') && decision.fingerprint) {
    try {
      repo?.hit?.(decision.fingerprint)
    } catch {
      console.warn('[risk-audit] failed to record refusal cache hit')
    }
  }
  // JEV session bans are persisted tenant-scoped via devices.recordViolation
  // (keyed by sha256(principal, 'session', rootSessionId)) instead of the
  // unscoped global refusal_session_blocks table, preventing cross-tenant DoS.
  const ban = recordBan(decision, { devices, policy, requestId, now })
  if (decision.kind === 'jev' && isJevReason(decision.reason) && ban?.subject_kind === 'device') {
    if (!ban.expires_at) {
      decision.error = refusalGuardError(requestId, { kind: 'device', row: ban })
      decision.errorMessage = `${POLICY_BLOCK_MESSAGE}: ${decision.category}（第 ${ban.violations || 3} 次违规，设备永久封禁）`
    } else {
      decision.error = makePolicyOverloadError({
        requestId,
        retryAfterSec: retryAfterFromExpiry(ban.expires_at, now),
      })
      decision.errorMessage = `${POLICY_BLOCK_MESSAGE}: ${decision.category}（第 ${ban.violations || 1} 次违规，设备封禁至 ${ban.expires_at}）`
    }
  }
}

function pass(by, keyword = '', route = null, extra = null) {
  return {
    action: 'pass',
    route,
    wait: by === 'scope-wait',
    intercept: gateVerdict({ kind: 'pass', by, keyword, route }),
    ...(extra || {}),
  }
}

function block(fields) {
  return { action: 'block', ...fields }
}

function hardPolicyError(requestId, code, message, details = {}) {
  return makeError({
    type: ErrorType.POLICY,
    code,
    message,
    status: 400,
    request_id: requestId,
    details: { ...details, retryable: false },
  })
}

export const JEV_PROFILES = Object.freeze(['inherit_global', 'enforce', 'downgrade_only', 'bypass_trusted'])

export function normalizeJevProfile(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
  return JEV_PROFILES.includes(raw) ? raw : 'inherit_global'
}

/**
 * Resolve pre-dispatch scope statically so requests never wait for slot
 * reservation (`scope-wait`) before running JEV.
 */
function resolvePreDispatchOutside({
  jev,
  jevProfile,
  scopeMatched,
  openaiPlatform,
  enforceHardAndJev,
  account,
  candidateAccounts,
  routeConfigured,
}) {
  if (jevProfile === 'bypass_trusted') return 'trusted'
  if (jevProfile === 'enforce') return ''
  if (scopeMatched) return ''
  if (enforceHardAndJev) return ''
  const scopePlatform = openaiPlatform ? 'gpt' : 'claude'
  if (jevScopeConfigured(jev)) {
    if (account) return jevAccountInScope(jev, account) ? '' : 'scope'
    if (Array.isArray(candidateAccounts) && candidateAccounts.length > 0) {
      return candidateAccounts.some((cand) => jevAccountInScope(jev, cand)) ? '' : 'scope'
    }
    if (routeConfigured) return ''
    return jevScopeWaits(jev, scopePlatform) ? '' : 'scope'
  }
  if (openaiPlatform && jev?.openai_platform_enabled !== true) return 'platform'
  return ''
}

function buildDowngradeRoute(audit, backend, score = null) {
  const routeTarget = backend === 'api' ? audit?.downgrade_endpoint : audit?.downgrade_pool
  if (audit?.downgrade_model) return { kind: 'model', target: audit.downgrade_model, score }
  if (routeTarget) return { kind: backend === 'api' ? 'endpoint' : 'pool', target: routeTarget, score }
  return null
}

/**
 * Does not write. `commitProtocolBlock` records hits and violations.
 */
export async function evaluateProtocolIntercept({
  inbound,
  body = inbound,
  headers,
  identity = refusalAuditIdentity({ inbound, body, headers }),
  official = false,
  classifier = null,
  zeroInject = false,
  distillRules,
  policy,
  jev,
  repo,
  devices,
  sessions = null,
  requestId,
  account = null,
  scopeMatched = false,
  candidateAccounts = null,
  jevProfile = 'inherit_global',
  preDispatch = false,
  skipDistill = false,
  enforceHardAndJev = false,
  fetchImpl,
  bodyCtx = null,
  interceptSession = null,
  mandatoryOnly = false,
  backend = 'oauth',
  openaiPlatform = isOpenaiPlatformModel(inbound, body),
  skipMandatory = false,
  now = Date.now(),
} = {}) {
  const profile = normalizeJevProfile(jevProfile)
  const audit = policy?.risk_audit
  const isAutoModeClassifier = classifier?.purpose === 'auto_mode_classifier'
  const effectiveIdentity = resolveAuditSessionIdentity({ inbound, body, headers, identity })
  const rootSessionId = effectiveIdentity.sessionId || ''
  const reject = (fields) => block({ deviceId: effectiveIdentity.deviceId, identity: effectiveIdentity, ...fields })
  const interceptOpts = { interceptSession, ctx: bodyCtx }
  let rawDocument
  if (!skipMandatory) {
    // A session the provider already refused never hops again: before every
    // other layer, whatever the prompt now says.
    if (policy?.session_block_enabled !== false && sessions) {
      const refused = await cachedMatchRefusalSession({ inbound, body, headers, sessions, now })
      if (refused) {
        const error = refusalGuardError(requestId, refused)
        return block({
          kind: 'session',
          via: 'refusal-guard',
          final_state: 'refusal_session',
          error,
          logErrorCode: 'refusal_guard',
          errorMessage: error.body?.error?.message,
          intercept: gateVerdict({ kind: 'block', by: 'refusal', keyword: 'session' }),
          sessionId: refused.sessionId,
          banDevice: false,
          remember: false,
          reason: 'refusal_session',
        })
      }
    }
    const banned = await cachedFindDeviceBan({ devices, identity: effectiveIdentity, policy, now })
    if (banned) {
      const tempJevBan = banned.subject_kind === 'device' && isJevReason(banned.reason) && !!banned.expires_at
      const error = tempJevBan
        ? makePolicyOverloadError({ requestId, retryAfterSec: retryAfterFromExpiry(banned.expires_at, now) })
        : refusalGuardError(requestId, { kind: 'device', row: banned })
      const errorMessage = tempJevBan
        ? `此设备因 ${banned.reason} 临时封禁至 ${banned.expires_at}（第 ${banned.violations || 1} 次违规）`
        : error.body.error.message
      return reject({
        kind: 'device',
        reason: banned.subject_kind === 'session' ? 'refusal_session' : 'refusal_device',
        deviceId: banned.device_id,
        via: 'refusal-guard',
        final_state: banned.subject_kind === 'session' ? 'refusal_session' : 'refusal_device',
        error,
        logErrorCode: 'refusal_guard',
        errorMessage,
        errorDetails: error.body?.error?.details || null,
        intercept: gateVerdict({ kind: 'block', by: 'refusal', keyword: banned.subject_kind }),
      })
    }
    // Claude Code's built-in auto-mode classifier is a safety side-request
    // wrapping `<transcript>` + review prompt. Pre-existing session/device bans
    // still apply above, but it must never trigger new keyword/JEV blocks or
    // kill the main coding session (matching `refusalSessionBlockDecision`).
    if (isAutoModeClassifier) return pass(mandatoryOnly ? 'unchecked' : 'classifier')
    const tool = blockedRiskTool(inbound, body, audit?.blocked_tools)
    if (tool) {
      const error = hardPolicyError(requestId, 'risk_tool_blocked', tool.message, { tool: tool.name })
      return reject({
        kind: 'hard_regex',
        via: 'hard-regex',
        final_state: 'policy_blocked',
        error,
        intercept: gateVerdict({ kind: 'block', by: 'hard-regex', keyword: tool.name, rule: 'blocked_tool' }),
        banDevice: true,
        reason: `blocked_tool:${tool.name}`,
      })
    }
    if (audit?.block_system_prompt_rewrite !== false) {
      rawDocument = jevDocument(inbound, body, { ...interceptOpts, keepPromptReminders: true })
      const scanned = prepareInterceptText(rawDocument, { stripReminders: false, stripEnvironment: false })
      const system = systemRewrite(scanned)
      if (system) {
        const error = hardPolicyError(requestId, 'system_prompt_rewrite_blocked', '不允许改写或绕过系统提示词。')
        // A keyword hit only refuses this request. It does not ban the device
        // or end the session: the client can rephrase, and a real jailbreak
        // still meets the provider refusal and the refused-session block.
        return reject({
          kind: 'hard_regex',
          via: 'hard-regex',
          final_state: 'policy_blocked',
          error,
          errorMessage: error.body.error.message,
          intercept: gateVerdict({ kind: 'block', by: 'hard-regex', keyword: system, rule: 'system_prompt_rewrite' }),
          banDevice: false,
          reason: 'system_prompt_rewrite',
        })
      }
    }
  }
  if (isAutoModeClassifier) return pass(mandatoryOnly ? 'unchecked' : 'classifier')
  const routeTarget = backend === 'api' ? audit?.downgrade_endpoint : audit?.downgrade_pool
  const routeConfigured = !!(jev?.enabled && (routeTarget || audit?.downgrade_model))
  let outside = ''
  if (preDispatch || profile !== 'inherit_global' || enforceHardAndJev) {
    outside = resolvePreDispatchOutside({
      jev,
      jevProfile: profile,
      scopeMatched,
      openaiPlatform,
      enforceHardAndJev,
      account,
      candidateAccounts,
      routeConfigured,
    })
  } else if (!scopeMatched && openaiPlatform) {
    if (!jevScopeConfigured(jev)) {
      if (jev?.openai_platform_enabled !== true) outside = 'platform'
    } else if (!jevScopeWaits(jev, 'gpt')) {
      outside = 'scope'
    } else if (!account && !routeConfigured) {
      outside = 'scope-wait'
    } else if (account && !jevAccountInScope(jev, account)) {
      outside = 'scope'
    }
  } else if (!scopeMatched && !routeConfigured && jevScopeWaits(jev, 'claude')) {
    if (!account) outside = 'scope-wait'
    else if (!jevAccountInScope(jev, account)) outside = 'scope'
  }
  const hardEnabled = !mandatoryOnly && !outside
  let scanned = false
  if (hardEnabled) {
    const distill =
      openaiPlatform || skipDistill ? null : detectDistill({ inbound, body, official, zeroInject }, distillRules)
    if (distill?.action === 'block') {
      const evidence = (distill.hits || [])
        .map((item) => item.evidence || item.rule)
        .filter(Boolean)
        .join(';')
      return reject({
        kind: 'distill',
        via: 'distill-detect',
        final_state: 'distill_blocked',
        error: distillBlockError(distillRules, requestId),
        errorMessage: distillEvidenceMessage(distill.error?.message, evidence),
        intercept: gateVerdict({ kind: 'block', by: 'distill', keyword: evidence.slice(0, 40) }),
        banDevice: true,
        reason: 'distill',
      })
    }

    const document = prepareInterceptText(rawDocument ?? jevDocument(inbound, body, interceptOpts), {
      stripReminders: jev?.strip_reminders !== false,
      expandBase64: jev?.expand_base64 !== false,
    })
    const distillOn = distillRules?.enabled !== false && !skipDistill
    const hardOn = jev?.hard_regex_enabled !== false
    const rules = hardRulesFor(jev, distillOn, openaiPlatform)
    const extra = hardOn ? jev?.patterns : []
    scanned = rules.length > 0 || (Array.isArray(extra) && extra.length > 0)
    if (scanned) {
      const hard = matchHardPolicy(document, extra, rules)
      if (hard?.category === 'distill') {
        const keyword = hard.keyword || hard.category
        const error = distillBlockError(distillRules, requestId)
        return reject({
          kind: 'distill',
          via: 'distill-detect',
          final_state: 'distill_blocked',
          error,
          errorMessage: distillEvidenceMessage(error.body?.error?.message, keyword),
          intercept: gateVerdict({ kind: 'block', by: 'distill', keyword: keyword.slice(0, 40) }),
          banDevice: true,
          reason: 'distill',
        })
      }
      if (hard) {
        const error = policyBlockError(requestId)
        const label =
          hard.keyword && hard.keyword !== hard.category ? `${hard.category}: ${hard.keyword}` : hard.category
        error.body.error.details = { reason: `hard_regex:${hard.category}`, retryable: false }
        return reject({
          kind: 'hard_regex',
          via: 'hard-regex',
          final_state: 'policy_blocked',
          error,
          errorMessage: `${error.body?.error?.message}: ${label}`,
          intercept: gateVerdict({
            kind: 'block',
            by: 'hard-regex',
            keyword: hard.keyword || hard.category,
            rule: hard.evidence,
          }),
          category: hard.category,
          // A keyword hit refuses this request only, same reasoning as the
          // system-prompt rewrite rule (cd14409c): ordinary documents quote
          // subcommand names like `openstar-sign keygen`, and a real
          // jailbreak still meets the provider refusal and the
          // refused-session block. NSFW stays a forced ban: its evidence is
          // explicit content, not an ambiguous keyword.
          banDevice: hard.category === 'nsfw',
          forceDeviceBan: hard.category === 'nsfw',
          reason: `hard_regex:${hard.category}`,
        })
      }
    }
  }

  if (!skipMandatory && policy?.enabled && repo && typeof repo.get === 'function') {
    let match = matchStoredRefusal({
      inbound,
      body: inbound ?? body,
      headers,
      repo,
      devices: devices?.findBan ? null : devices,
      similarityEnabled: policy.similarity_enabled,
      similarity: similarityRatio(policy.similarity),
      deviceBlockEnabled: policy.device_block_enabled,
    })
    // Our own Jev/regex block used to be stored here and then blocked every retry.
    if (match && match.kind !== 'device' && isPolicyBlockMemory(match.row?.error_message)) match = null
    if (match) {
      const error = refusalGuardError(requestId, match)
      return reject({
        kind: match.kind,
        via: 'refusal-guard',
        final_state:
          match.kind === 'device' ? 'refusal_device' : match.kind === 'similar' ? 'refusal_similar' : 'refusal_guard',
        error,
        errorMessage: error.body?.error?.message,
        intercept: gateVerdict({ kind: 'block', by: 'refusal', keyword: match.kind }),
        deviceId: match.deviceId,
        fingerprint: match.fingerprint,
        banDevice: match.kind !== 'device' && !isThirdPartyClientMessage(match.row?.error_message),
        reason:
          match.kind === 'device' ? 'refusal_device' : match.kind === 'similar' ? 'refusal_similar' : 'refusal_guard',
      })
    }
  }
  if (mandatoryOnly || outside) return pass(outside || 'unchecked')

  if (jev?.enabled) {
    const modelDocument = jevModelDocument(inbound, body, interceptOpts)
    const verdict = await classifyJev(modelDocument, { ...jev, policy_request_id: requestId }, fetchImpl, now)
    if (verdict.action === 'block') {
      const unavailable = verdict.reason === 'unavailable'
      const detail = String(verdict.detail || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120)
      if (unavailable) {
        const error = policyBlockError(requestId)
        error.status = 503
        error.body.error.type = ErrorType.OVERLOADED
        error.body.error.message = detail
          ? `${error.body.error.message}: 决策模型不可用（${detail}）。本次请求已拦截，未封禁设备`
          : `${error.body.error.message}: 决策模型不可用。本次请求已拦截，未封禁设备`
        error.body.error.details = { reason: 'unavailable', ...(detail ? { detail } : {}) }
        return reject({
          kind: 'jev',
          via: 'jev',
          final_state: 'policy_blocked',
          error,
          logErrorCode: 'policy_blocked',
          errorMessage: error.body.error.message,
          intercept: gateVerdict({
            kind: 'block',
            by: 'jev',
            keyword: 'unavailable',
          }),
          jevState: '',
          category: 'unavailable',
          banSession: false,
          banDevice: false,
          forceDeviceBan: false,
          reason: 'jev:unavailable',
        })
      }
      const category = verdict.category || 'safety'
      if (profile === 'downgrade_only') {
        const downgradeRoute = buildDowngradeRoute(audit, backend, verdict.score ?? null)
        if (downgradeRoute) {
          return pass('jev-downgrade', category, downgradeRoute, {
            jevPassed: false,
            jevState: verdict.state || '',
            jevScores: verdict.scores || null,
            downgradeReason: `jev:${category}`,
          })
        }
      }
      const escalateBan = shouldEscalateJevBan(verdict, jev)
      const steps = policy?.risk_audit?.ban_steps || DEFAULT_BAN_STEPS
      const firstMinutes = Number(steps[0]) > 0 ? Number(steps[0]) : 10
      const error = makePolicyOverloadError({
        requestId,
        retryAfterSec: escalateBan ? firstMinutes * 60 : 60,
      })
      return reject({
        kind: 'jev',
        via: 'jev',
        final_state: 'policy_blocked',
        error,
        logErrorCode: 'policy_blocked',
        errorDetails: {
          reason: `jev:${category}`,
          ...(!escalateBan ? { ban_skipped: 'borderline_score' } : {}),
          ...jevScoreDetails(verdict.scores),
        },
        errorMessage: escalateBan
          ? `${POLICY_BLOCK_MESSAGE}: ${category}`
          : `${POLICY_BLOCK_MESSAGE}: ${category}（单次拦截，未达封禁置信线，未封禁会话/设备）`,
        intercept: gateVerdict({
          kind: 'block',
          by: 'jev',
          keyword: category,
        }),
        // Exact payload.state. Context the model scored, not a span it named.
        jevState: verdict.state || '',
        category,
        sessionId: rootSessionId,
        model: body?.model || inbound?.model || '',
        preview: refusalPreview(body, inbound),
        banSession: escalateBan,
        banDevice: escalateBan,
        forceDeviceBan: escalateBan,
        reason: `jev:${category}`,
      })
    }
    const by =
      verdict.reason === 'safe' || verdict.reason === 'replay'
        ? 'jev'
        : verdict.reason === 'skip'
          ? scanned
            ? 'regex'
            : 'unchecked'
          : 'fail-open'
    const route =
      !account && Number.isFinite(verdict.margin)
        ? audit?.downgrade_model && verdict.margin <= audit.model_margin + Number.EPSILON
          ? { kind: 'model', target: audit.downgrade_model, score: verdict.score }
          : routeTarget && verdict.margin <= audit.route_margin + Number.EPSILON
            ? { kind: backend === 'api' ? 'endpoint' : 'pool', target: routeTarget, score: verdict.score }
            : null
        : null
    return pass(by, verdict.reason === 'unavailable' ? verdict.detail || '' : '', route, {
      jevPassed: by === 'jev',
      jevState: by === 'jev' ? verdict.state || '' : '',
      jevScores: by === 'jev' ? verdict.scores || null : null,
    })
  }

  return pass(scanned ? 'regex' : 'unchecked')
}

/** Block decision after side effects, or the pass verdict when the request may hop. */
export async function runProtocolIntercept(ctx = {}) {
  const decision = await evaluateProtocolIntercept(ctx)
  if (decision.action !== 'block') return decision
  commitProtocolBlock(decision, ctx)
  return decision
}
