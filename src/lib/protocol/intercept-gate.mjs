import { detectDistill, distillBlockError, isOpenaiPlatformModel } from '../core/distill-detect.mjs'
import { redactSecrets } from '../core/security.mjs'
import { ErrorType, isThirdPartyClientMessage, makeError, makeRefusalGuardError } from '../core/errors.mjs'
import {
  blockedRiskTool,
  DEFAULT_BAN_STEPS,
  matchRefusalSession,
  matchStoredRefusal,
  refusalFingerprint,
  refusalGuardError,
  refusalPreview,
  refusalPromptSignature,
  refusalAuditIdentity,
  upstreamRiskReason,
} from '../core/refusal-guard.mjs'
import {
  HARD_POLICY_RULES,
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

function enforcesBan(policy, row) {
  return !!(policy?.enabled && (policy.device_block_enabled || row.reason?.endsWith(':nsfw')))
}

function recordBan(decision, { devices, policy, requestId }) {
  if (!decision.banDevice || !decision.identity) return
  if (!policy?.enabled || (!policy.device_block_enabled && !decision.forceDeviceBan)) return
  const identity = decision.identity
  const store = devices
  const evidence = { requestId, fingerprint: decision.fingerprint || null, reason: decision.reason || decision.kind }
  try {
    if (store?.recordViolation) {
      store.recordViolation(identity, {
        ...evidence,
        steps: policy?.risk_audit?.ban_steps || DEFAULT_BAN_STEPS,
        accepts: (row) => enforcesBan(policy, row),
      })
    } else if (identity.deviceId) {
      store?.block?.({ ...evidence, deviceId: identity.deviceId })
    }
  } catch {
    console.warn('[risk-audit] failed to persist ban')
  }
}

export function observeUpstreamRisk({ inbound, body, identity, result, logBag, requestId, policy, repo, devices }) {
  if (!result || result.upstreamExecutions === 0 || result.transportError === true) return ''
  const rawMessage =
    result.upstreamError?.message ||
    result.body?.error?.message ||
    result.body?.message ||
    (typeof result.body === 'string' ? result.body : '')
  const upstreamStatus = result.providerResult?.http_status ?? result.upstreamStatus ?? result.status
  const isBadRequest = Number(upstreamStatus) === 400
  const reason = upstreamRiskReason(result, policy?.risk_audit?.upstream_policy_phrases)
  if (!isBadRequest && !reason) return ''
  const message = JSON.parse(redactSecrets(String(rawMessage))).slice(0, 500)
  if (isBadRequest) {
    logBag.audit_upstream_400 = true
    logBag.audit_upstream_400_message ||= message
  }
  if (!reason) return ''
  if (message) logBag.error_message = message
  logBag.error_code ||= 'content_filter_refusal'
  if (!policy?.enabled) return reason
  const fingerprint = reason === 'upstream:flagged_session' ? null : refusalFingerprint(body, inbound)
  try {
    if (fingerprint)
      repo?.remember?.({
        fingerprint,
        model: body?.model || inbound?.model || '',
        requestId,
        errorMessage: message || reason,
        preview: refusalPreview(body, inbound),
        signature: refusalPromptSignature(inbound, body),
      })
  } catch {
    console.warn('[risk-audit] failed to persist upstream refusal')
  }
  if (reason !== 'upstream:billing_refusal') {
    recordBan({ identity, fingerprint, reason, banDevice: true }, { devices, policy, requestId })
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

export function commitProtocolBlock(decision, { repo, devices, sessions, policy, requestId } = {}) {
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
  recordBan(decision, { devices, policy, requestId })
}

function pass(by, keyword = '', route = null) {
  return {
    action: 'pass',
    route,
    wait: by === 'scope-wait',
    intercept: gateVerdict({ kind: 'pass', by, keyword, route }),
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

/**
 * Does not write. `commitProtocolBlock` records hits and violations.
 */
export async function evaluateProtocolIntercept({
  inbound,
  body = inbound,
  headers,
  identity = refusalAuditIdentity({ inbound, body, headers }),
  official = false,
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
  fetchImpl,
  bodyCtx = null,
  interceptSession = null,
  mandatoryOnly = false,
  backend = 'oauth',
  openaiPlatform = isOpenaiPlatformModel(inbound, body),
  skipMandatory = false,
} = {}) {
  const audit = policy?.risk_audit
  const reject = (fields) => block({ deviceId: identity.deviceId, identity, ...fields })
  const interceptOpts = { interceptSession, ctx: bodyCtx }
  let rawDocument
  if (!skipMandatory) {
    // A session the provider already refused never hops again: before every
    // other layer, whatever the prompt now says.
    if (policy?.session_block_enabled !== false && sessions) {
      const refused = matchRefusalSession({ inbound, body, headers, sessions })
      if (refused) {
        const error = refusalGuardError(requestId, refused)
        return block({
          kind: 'session',
          via: 'refusal-guard',
          final_state: 'refusal_session',
          error,
          errorMessage: error.body?.error?.message,
          intercept: gateVerdict({ kind: 'block', by: 'refusal', keyword: 'session' }),
          sessionId: refused.sessionId,
          banDevice: false,
          remember: false,
          reason: 'refusal_session',
        })
      }
    }
    const banned = devices?.findBan?.(identity, Date.now(), (row) => enforcesBan(policy, row))
    if (banned) {
      const error = refusalGuardError(requestId, { kind: 'device', row: banned })
      return reject({
        kind: 'device',
        reason: 'refusal_device',
        deviceId: banned.device_id,
        via: 'refusal-guard',
        final_state: 'refusal_device',
        error,
        errorMessage: error.body.error.message,
        intercept: gateVerdict({ kind: 'block', by: 'refusal', keyword: banned.subject_kind }),
      })
    }
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
  const routeTarget = backend === 'api' ? audit?.downgrade_endpoint : audit?.downgrade_pool
  const routeConfigured = !!(jev?.enabled && (routeTarget || audit?.downgrade_model))
  let outside = ''
  if (!scopeMatched && openaiPlatform) {
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
    const distill = openaiPlatform ? null : detectDistill({ inbound, body, official, zeroInject }, distillRules)
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
    const distillOn = distillRules?.enabled !== false
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
          banDevice: true,
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
    const verdict = await classifyJev(modelDocument, { ...jev, policy_request_id: requestId }, fetchImpl)
    if (verdict.action === 'block') {
      const unavailable = verdict.reason === 'unavailable'
      const error = policyBlockError(requestId)
      const detail = String(verdict.detail || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120)
      if (unavailable) {
        error.status = 503
        error.body.error.type = ErrorType.OVERLOADED
        error.body.error.message = detail
          ? `${error.body.error.message}: 决策模型不可用（${detail}）。本次请求已拦截，未封禁设备`
          : `${error.body.error.message}: 决策模型不可用。本次请求已拦截，未封禁设备`
        error.body.error.details = { reason: 'unavailable', ...(detail ? { detail } : {}) }
      }
      const category = verdict.category || 'safety'
      if (!unavailable) error.body.error.details = { reason: `jev:${category}`, retryable: false }
      return reject({
        kind: 'jev',
        via: 'jev',
        final_state: 'policy_blocked',
        error,
        errorMessage: unavailable ? error.body.error.message : `${error.body?.error?.message}: ${category}`,
        intercept: gateVerdict({
          kind: 'block',
          by: 'jev',
          keyword: unavailable ? 'unavailable' : category,
        }),
        // Exact payload.state. Context the model scored, not a span it named.
        jevState: unavailable ? '' : verdict.state || '',
        category: unavailable ? 'unavailable' : category,
        banDevice: !unavailable,
        forceDeviceBan: !unavailable && (category === 'nsfw' || (verdict.categories || []).includes('nsfw')),
        reason: unavailable ? 'jev:unavailable' : `jev:${category}`,
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
    return pass(by, verdict.reason === 'unavailable' ? verdict.detail || '' : '', route)
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
