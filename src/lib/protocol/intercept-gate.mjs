/**
 * One pre-hop gate for /v1 and count_tokens.
 *
 * Order matches sub2api content-moderation Check: cheap hard rules, then the
 * persisted refusal/device cache, then the model. A block never hops.
 * Device bans and refusal rows are written here so both entry points share them.
 */
import { detectDistill, distillBlockError, isOpenaiPlatformModel } from '../core/distill-detect.mjs'
import {
  inboundRefusalDeviceId,
  matchStoredRefusal,
  refusalFingerprint,
  refusalGuardError,
  refusalPreview,
  refusalPromptSignature,
} from '../core/refusal-guard.mjs'
import { RefusalDeviceBlocksRepo } from '../db/repos/refusal-device-blocks-repo.mjs'
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

function deviceStore(devices) {
  if (devices) return devices
  try {
    return new RefusalDeviceBlocksRepo()
  } catch {
    return null
  }
}
function distillEvidenceMessage(message, evidence) {
  const text = String(message || '').trim()
  const why = String(evidence || '').trim()
  if (text && why) return `${text}: ${why}`
  return text || why
}

function hardRulesFor(inbound, body, jev, distillOn) {
  const hardOn = jev?.hard_regex_enabled !== false
  const base = Array.isArray(jev?.rules) ? jev.rules : HARD_POLICY_RULES
  const openai = isOpenaiPlatformModel(inbound, body)
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

export async function commitProtocolBlock(decision, { repo, devices, policy, requestId } = {}) {
  if (!decision || decision.action !== 'block') return
  if (decision.kind === 'device') {
    try {
      await devices?.hit?.(decision.deviceId)
    } catch {
      /* counter is best-effort */
    }
    return
  }
  if ((decision.kind === 'exact' || decision.kind === 'similar') && decision.fingerprint) {
    try {
      await repo?.hit?.(decision.fingerprint)
    } catch {
      /* counter is best-effort */
    }
  }
  if (decision.remember && policy?.enabled && repo && decision.fingerprint) {
    try {
      await repo.remember?.({
        fingerprint: decision.fingerprint,
        model: decision.model || '',
        requestId: requestId || null,
        errorMessage: decision.errorMessage || null,
        preview: decision.preview || null,
        expiresAt: null,
        signature: decision.signature || null,
      })
    } catch {
      /* the response still must not hop */
    }
  }
  if (!decision.banDevice || !policy?.enabled || !policy?.device_block_enabled || !decision.deviceId) return
  try {
    await deviceStore(devices)?.block?.({
      deviceId: decision.deviceId,
      requestId: requestId || null,
      fingerprint: decision.fingerprint || null,
      reason: decision.reason || decision.kind,
    })
  } catch {
    /* the prompt block still stands */
  }
}

function pass(by, keyword = '') {
  return { action: 'pass', intercept: gateVerdict({ kind: 'pass', by, keyword }) }
}

function block(fields) {
  return { action: 'block', ...fields }
}

/**
 * Does not write. `commitProtocolBlock` applies hit / remember / device ban.
 */
export async function evaluateProtocolIntercept({
  inbound,
  body = inbound,
  headers,
  official = false,
  zeroInject = false,
  distillRules,
  policy,
  jev,
  repo,
  devices,
  requestId,
  account = null,
  fetchImpl,
} = {}) {
  // GPT / Codex skips every layer unless the panel opts it in. Once a scope
  // is set, the slot decides GPT: a scope with no GPT pair and no named
  // account is out of range. Claude stays in the gate until a Claude pair
  // or a named account is selected; a GPT-only scope does not turn it off.
  if (isOpenaiPlatformModel(inbound, body)) {
    if (!jevScopeConfigured(jev)) {
      if (jev?.openai_platform_enabled !== true) return pass('platform')
    } else if (!jevScopeWaits(jev, 'gpt')) {
      return pass('scope')
    } else if (!account) {
      return pass('scope-wait')
    } else if (!jevAccountInScope(jev, account)) {
      return pass('scope')
    }
  } else if (jevScopeWaits(jev, 'claude')) {
    if (!account) return pass('scope-wait')
    if (!jevAccountInScope(jev, account)) return pass('scope')
  }
  const distill = detectDistill({ inbound, body, official, zeroInject }, distillRules)
  if (distill.action === 'block') {
    const evidence = (distill.hits || [])
      .map((item) => item.evidence || item.rule)
      .filter(Boolean)
      .join(';')
    return block({
      kind: 'distill',
      via: 'distill-detect',
      final_state: 'distill_blocked',
      error: distillBlockError(distillRules, requestId),
      errorMessage: distillEvidenceMessage(distill.error?.message, evidence),
      intercept: gateVerdict({ kind: 'block', by: 'distill', keyword: evidence.slice(0, 40) }),
      deviceId: inboundRefusalDeviceId({ inbound, body, headers }),
      fingerprint: refusalFingerprint(body, inbound),
      banDevice: true,
      remember: false,
      reason: 'distill',
    })
  }

  const document = prepareInterceptText(jevDocument(inbound, body), {
    stripReminders: jev?.strip_reminders !== false,
    expandBase64: jev?.expand_base64 !== false,
  })
  const modelDocument = prepareInterceptText(jevModelDocument(inbound, body), {
    stripReminders: jev?.strip_reminders !== false,
    expandBase64: jev?.expand_base64 !== false,
  })
  const distillOn = distillRules?.enabled !== false
  const hardOn = jev?.hard_regex_enabled !== false
  const rules = hardRulesFor(inbound, body, jev, distillOn)
  const extra = hardOn ? jev?.patterns : []
  const scanned = rules.length > 0 || (Array.isArray(extra) && extra.length > 0)
  if (rules.length || (Array.isArray(extra) && extra.length)) {
    const hard = matchHardPolicy(document, extra, rules)
    if (hard?.category === 'distill') {
      const keyword = hard.keyword || hard.category
      const error = distillBlockError(distillRules, requestId)
      return block({
        kind: 'distill',
        via: 'distill-detect',
        final_state: 'distill_blocked',
        error,
        errorMessage: distillEvidenceMessage(error.body?.error?.message, keyword),
        intercept: gateVerdict({ kind: 'block', by: 'distill', keyword: keyword.slice(0, 40) }),
        deviceId: inboundRefusalDeviceId({ inbound, body, headers }),
        fingerprint: refusalFingerprint(body, inbound),
        banDevice: true,
        remember: false,
        reason: 'distill',
      })
    }
    if (hard) {
      const error = policyBlockError(requestId)
      const label = hard.keyword && hard.keyword !== hard.category ? `${hard.category}: ${hard.keyword}` : hard.category
      return block({
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
        deviceId: inboundRefusalDeviceId({ inbound, body, headers }),
        fingerprint: refusalFingerprint(body, inbound),
        signature: refusalPromptSignature(inbound, body),
        model: body?.model || inbound?.model || '',
        preview: refusalPreview(body, inbound),
        banDevice: true,
        remember: false,
        reason: `hard_regex:${hard.category}`,
      })
    }
  }

  if (policy?.enabled && repo && typeof repo.get === 'function') {
    let match = await matchStoredRefusal({
      inbound,
      body,
      headers,
      repo,
      devices,
      similarityEnabled: policy.similarity_enabled,
      similarity: similarityRatio(policy.similarity),
      deviceBlockEnabled: policy.device_block_enabled,
    })
    // Our own Jev/regex block used to be stored here and then blocked every retry.
    if (match && match.kind !== 'device' && isPolicyBlockMemory(match.row?.error_message)) match = null
    if (match) {
      const error = refusalGuardError(requestId, match)
      return block({
        kind: match.kind,
        via: 'refusal-guard',
        final_state:
          match.kind === 'device' ? 'refusal_device' : match.kind === 'similar' ? 'refusal_similar' : 'refusal_guard',
        error,
        errorMessage: error.body?.error?.message,
        intercept: gateVerdict({ kind: 'block', by: 'refusal', keyword: match.kind }),
        deviceId: match.deviceId,
        fingerprint: match.fingerprint,
        banDevice: match.kind !== 'device',
        remember: false,
        reason:
          match.kind === 'device' ? 'refusal_device' : match.kind === 'similar' ? 'refusal_similar' : 'refusal_guard',
      })
    }
  }

  if (jev?.enabled) {
    const verdict = await classifyJev(modelDocument, jev, fetchImpl)
    if (verdict.action === 'block') {
      const unavailable = verdict.reason === 'unavailable'
      const error = policyBlockError(requestId)
      const detail = String(verdict.detail || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120)
      if (unavailable) {
        error.body.error.message = detail
          ? `${error.body.error.message}: 决策模型不可用（${detail}）。本次请求已拦截，未封禁设备`
          : `${error.body.error.message}: 决策模型不可用。本次请求已拦截，未封禁设备`
        error.body.error.details = { reason: 'unavailable', ...(detail ? { detail } : {}) }
      }
      const category = verdict.category || 'safety'
      return block({
        kind: 'jev',
        via: 'jev',
        final_state: 'policy_blocked',
        error,
        errorMessage: unavailable ? error.body.error.message : `${error.body?.error?.message}: ${category}`,
        intercept: gateVerdict({ kind: 'block', by: 'jev', keyword: unavailable ? 'unavailable' : category }),
        category: unavailable ? 'unavailable' : category,
        deviceId: inboundRefusalDeviceId({ inbound, body, headers }),
        fingerprint: refusalFingerprint(body, inbound),
        signature: refusalPromptSignature(inbound, body),
        model: body?.model || inbound?.model || '',
        preview: refusalPreview(body, inbound),
        banDevice: !unavailable,
        remember: false,
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
    return pass(by, verdict.reason === 'unavailable' ? verdict.detail || '' : '')
  }

  return pass(scanned ? 'regex' : 'unchecked')
}

/** Block decision after side effects, or the pass verdict when the request may hop. */
export async function runProtocolIntercept(ctx = {}) {
  const decision = await evaluateProtocolIntercept(ctx)
  if (decision.action !== 'block') return decision
  await commitProtocolBlock(decision, ctx)
  return decision
}
