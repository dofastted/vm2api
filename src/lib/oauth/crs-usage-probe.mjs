/**
 * CRS-aligned account status probe.
 * All Anthropic I/O runs as the VM UID (SOCKS egress). Host never calls Anthropic.
 */
import { isCrsMock } from '../transport/crs-mock.mjs'
import { callGoWorker, callWorkerGet } from '../transport/go-worker-client.mjs'
import {
  compareUsageInterpretations,
  fableScopeText,
  interpretOfficialUsage,
  normLegacyMixed,
  normUsagePercent,
  usageFablePresence,
} from './usage-interpret.mjs'

export const FABLE_PROBE_MODEL = 'claude-fable-5'
export const OAUTH_USAGE_PATH = '/api/oauth/usage'
/** sub2api Extra / Messages 响应头被动采样，不打 GET /api/oauth/usage。 */
export const PASSIVE_HEADER_SOURCE = 'messages-headers'

export function probeFromPassiveHeaders(unified = {}, nowIso = new Date().toISOString()) {
  const h5 = unified?.headers?.['5h'] || {}
  const h7 = unified?.headers?.['7d'] || {}
  const oi = unified?.['7d_oi'] || unified?.headers?.['7d_oi'] || null
  if (h5.utilization == null && !h5.status && !h5.reset && h7.utilization == null && !h7.status && !h7.reset) {
    return null
  }
  return {
    ok: true,
    source: PASSIVE_HEADER_SOURCE,
    via: 'passive-headers',
    five_hour: {
      utilization: h5.utilization ?? null,
      resets_at: h5.reset || null,
      status: h5.status || null,
    },
    seven_day: {
      utilization: h7.utilization ?? null,
      resets_at: h7.reset || null,
      status: h7.status || null,
    },
    seven_day_oi: oi,
    probed_at: nowIso,
  }
}

/** Rate-limit headers stay 0–1 (or percent when >1.5). Usage API uses percent. */
export function normUtilization(v) {
  return normLegacyMixed(v)
}

export function statusFromUtilization(u) {
  if (u == null) return null
  if (u >= 1) return 'rejected'
  if (u >= 0.85) return 'allowed_warning'
  return 'allowed'
}

function windowOf(w, scale = 'percent') {
  if (!w || typeof w !== 'object') return null
  const utilization =
    scale === 'header' ? normLegacyMixed(w.utilization ?? w.percent) : normUsagePercent(w.utilization ?? w.percent)
  if (utilization == null && !w.resets_at && !w.resetsAt && !w.status) return null
  return {
    utilization,
    utilization_pct: utilization == null ? null : Math.round(utilization * 1000) / 10,
    resets_at: w.resets_at || w.resetsAt || null,
    status: w.status || statusFromUtilization(utilization),
  }
}

function fableScopeName(value) {
  return /fable/i.test(String(value || ''))
}

/** Fable weekly window (7d_oi) from /api/oauth/usage — limits[] weekly_scoped, not a boolean. */
export function parseFableScopedWindow(data = {}) {
  const direct = windowOf(data.seven_day_overage_included || data.seven_day_oi || data.seven_day_fable, 'percent')
  if (direct) return direct
  for (const item of Array.isArray(data.limits) ? data.limits : []) {
    if (!item || typeof item !== 'object') continue
    const kind = String(item.kind || item.type || '').toLowerCase()
    const scoped = kind === 'weekly_scoped' || kind === 'seven_day_overage_included' || kind === '7d_oi'
    if (!scoped || !fableScopeName(fableScopeText(item))) continue
    return windowOf(item, 'percent')
  }
  for (const item of Array.isArray(data.model_scoped) ? data.model_scoped : []) {
    if (!item || typeof item !== 'object') continue
    if (!fableScopeName(fableScopeText(item))) continue
    return windowOf(item, 'percent')
  }
  return null
}

export { usageFablePresence, usageHasFableModel } from './usage-interpret.mjs'

export function windowFromRateLimitHeaders(headers = {}, prefix = '7d_oi') {
  const h = {}
  for (const [key, value] of Object.entries(headers || {})) h[String(key).toLowerCase()] = value
  return windowOf(
    {
      utilization: h[`anthropic-ratelimit-unified-${prefix}-utilization`],
      resets_at: h[`anthropic-ratelimit-unified-${prefix}-reset`] || null,
      status: h[`anthropic-ratelimit-unified-${prefix}-status`] || null,
    },
    'header',
  )
}

export function parseOAuthUsage(data = {}) {
  const extra = data.extra_usage || data.extraUsage || null
  return {
    five_hour: windowOf(data.five_hour),
    seven_day: windowOf(data.seven_day),
    seven_day_sonnet: windowOf(data.seven_day_sonnet),
    seven_day_opus: windowOf(data.seven_day_opus || data.seven_day_sonnet),
    seven_day_oi: parseFableScopedWindow(data),
    usage_has_fable: usageFablePresence(data),
    extra_usage:
      extra && typeof extra === 'object'
        ? {
            is_enabled: !!(extra.is_enabled ?? extra.enabled),
            utilization: normUsagePercent(extra.utilization),
            resets_at: extra.resets_at || extra.resetsAt || null,
            status: extra.status || extra.overage_status || extra.overageStatus || null,
          }
        : null,
  }
}

export function parseFableProbe({ status, body, transportError, headers } = {}) {
  const err = body?.error || {}
  const msg = String(err.message || body?.message || err.code || '')
  const typ = String(err.type || err.code || '')
  const transport =
    !!transportError ||
    status === 0 ||
    /SOCKS|transport|connection reset|worker_error|upstream_transport|refusing SOCKS/i.test(msg) ||
    /SOCKS|transport/i.test(typ) ||
    (status === 502 && /SOCKS|greeting|reset by peer/i.test(msg))
  const planDenied = !transport && (status === 403 || (/permission/i.test(typ) && status !== 401))
  const limited = !transport && !planDenied && (status === 429 || /rate.?limit/i.test(typ) || /rate.?limit/i.test(msg))
  // 401 / oauth 才是整号吊销。403 permission 是 Pro 无 Fable，不是封号。
  const banned = !transport && !planDenied && (status === 401 || /oauth|authentication/i.test(typ))
  const oi = windowFromRateLimitHeaders(headers)
  // 不要把无 7d_oi 窗的 429 写成 100%——Pro 探测 Fable 也会 429。
  const utilization = oi?.utilization ?? null
  return {
    model: FABLE_PROBE_MODEL,
    status: status || 0,
    ok: status === 200 && !limited && !banned && !transport && !planDenied,
    limited,
    banned,
    plan_denied: planDenied,
    transport,
    utilization,
    reset_at: body?.error?.resets_at || body?.resets_at || oi?.resets_at || null,
    seven_day_oi:
      oi ||
      (utilization != null
        ? {
            utilization,
            utilization_pct: Math.round(utilization * 1000) / 10,
            resets_at: body?.error?.resets_at || body?.resets_at || null,
            status: limited ? 'rejected' : statusFromUtilization(utilization),
          }
        : null),
    error: limited || banned || planDenied || transport || status >= 400 ? msg || typ || `http_${status}` : null,
  }
}

/** Fable 403/permission = 套餐没有 Fable（Pro），不是账号吊销。 */
export function isFablePlanDenied(fb = {}) {
  if (!fb || typeof fb !== 'object') return false
  if (fb.plan_denied) return true
  const st = Number(fb.status || 0)
  const err = String(fb.error || fb.type || '')
  if (st === 401 || /oauth|authentication/i.test(err)) return false
  return st === 403 || /permission/i.test(err)
}

function normOiUtil(u) {
  if (u == null || u === '') return null
  const n = Number(u)
  if (!Number.isFinite(n)) return null
  return n > 1.5 ? n / 100 : n
}

/** 429 残渣写成的 100% 7d_oi，没有 usage 窗的 reset，不是 Max。 */
export function isInventedFableWindow(fb = {}, quota = {}) {
  const st = Number(fb.status || 0)
  if (fb.ok) return false
  if (st !== 429 && !fb.limited) return false
  const oi = normOiUtil(quota.utilization_7d_oi ?? quota['7d_oi']?.utilization)
  const reset = quota.reset_7d_oi || quota['7d_oi']?.reset || null
  if (oi == null && !reset) return true
  return oi != null && oi >= 1 && !reset
}

/** Pro：套餐没有 Fable。含 403、plan_denied、以及无真实 7d_oi 窗的 429。 */
export function isFableUnavailablePro(fb = {}, quota = {}) {
  if (isFablePlanDenied(fb)) return true
  return isInventedFableWindow(fb, quota)
}

export function shouldProbeFable({ fable = {}, quota = {}, storedTier = null } = {}) {
  if (quota.usage_has_fable === true) return false
  if (quota.utilization_7d_oi != null || quota.reset_7d_oi || quota.status_7d_oi || quota['7d_oi']?.reset) {
    return false
  }
  const stored = String(storedTier || quota.account_tier || '').toLowerCase()
  if (stored === 'pro') return false
  return !isFableUnavailablePro(fable, quota)
}

export function usageErrorText(probe = {}) {
  const raw = probe.usage_error || probe.error || probe.message || ''
  if (raw && typeof raw === 'object') return String(raw.message || raw.type || raw.code || '')
  return String(raw || '')
}

export function parseUsageRetryAfterMs(headers = {}, body = {}) {
  const h = {}
  for (const [key, value] of Object.entries(headers || {})) h[String(key).toLowerCase()] = value
  const raw = h['retry-after'] ?? body?.error?.retry_after ?? body?.retry_after
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return null
  return n > 180 ? n : n * 1000
}

/** Official /usage 429 is quota-API throttling, not a dead grant. */
export function isOfficialUsageRateLimited(probe = {}) {
  if (!probe || typeof probe !== 'object') return false
  if (probe.rate_limited === true) return true
  const status = Number(probe.usage_status || probe.status || 0)
  if (status === 429) return true
  return /rate limited|please try again later|too many requests/i.test(usageErrorText(probe))
}

/** Remaining backoff after official /usage 429. 0 = may hop. */
export function usageProbeBackoffRemainingMs(unified = {}, now = Date.now()) {
  const until = Date.parse(unified?.usage_rate_limited_until || '')
  if (Number.isFinite(until) && until > now) return until - now
  return 0
}

/** List/batch never hop. Single hop still waits out the 429 window. */
export function shouldHopOfficialUsage(unified = {}, { now = Date.now(), hop = true } = {}) {
  if (hop === false) return false
  return usageProbeBackoffRemainingMs(unified, now) <= 0
}

function mockUsage() {
  return {
    five_hour: { utilization: 12, resets_at: '2026-08-18T20:00:00Z' },
    seven_day: { utilization: 34, resets_at: '2026-08-24T00:00:00Z' },
    seven_day_sonnet: { utilization: 8, resets_at: '2026-08-24T00:00:00Z' },
    extra_usage: { is_enabled: false, utilization: 0 },
    limits: [
      {
        kind: 'weekly_scoped',
        percent: 21,
        resets_at: '2026-08-24T00:00:00Z',
        scope: { model: { display_name: 'Fable' } },
      },
    ],
  }
}

export async function probeVmUsage({ exec, includeFable = true, timeoutMs = 20000, identity = null } = {}) {
  if (!exec) {
    return { ok: false, source: 'official-cc-usage', error: 'no_exec', probed_at: new Date().toISOString() }
  }
  if (isCrsMock()) {
    const raw = mockUsage()
    const parsed = parseOAuthUsage(raw)
    const official = interpretOfficialUsage(raw)
    return {
      ok: true,
      source: 'official-cc-usage',
      via: 'crs-mock',
      interpretations: compareUsageInterpretations(raw),
      ...parsed,
      five_hour: official.five_hour || parsed.five_hour,
      seven_day: official.seven_day || parsed.seven_day,
      seven_day_sonnet: official.seven_day_sonnet || parsed.seven_day_sonnet,
      fable: includeFable
        ? {
            model: FABLE_PROBE_MODEL,
            status: 200,
            ok: true,
            limited: false,
            banned: false,
            utilization: parsed.seven_day_oi?.utilization ?? 0.21,
            reset_at: parsed.seven_day_oi?.resets_at || null,
            error: null,
          }
        : null,
      probed_at: new Date().toISOString(),
    }
  }
  const usageRes = await callWorkerGet(exec, '/internal/oauth/usage', { timeoutMs })
  const usageRateLimited =
    usageRes.status === 429 ||
    isOfficialUsageRateLimited({
      usage_status: usageRes.status,
      usage_error: usageRes.body?.error?.message || usageRes.body?.error,
      rate_limited: false,
    })
  const rawBody = usageRes.ok && usageRes.body && typeof usageRes.body === 'object' ? usageRes.body : {}
  const official = usageRes.ok ? interpretOfficialUsage(rawBody) : null
  const parsed = usageRes.ok
    ? parseOAuthUsage(rawBody)
    : {
        five_hour: null,
        seven_day: null,
        seven_day_sonnet: null,
        seven_day_opus: null,
        seven_day_oi: null,
        usage_has_fable: null,
        extra_usage: null,
      }

  let fable = null
  if (includeFable) {
    const fableRes = await callGoWorker({
      exec,
      timeoutMs,
      identity,
      body: {
        model: FABLE_PROBE_MODEL,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      },
      // Do not send inbound anthropic-beta — unofficial probes must replay
      // the slot's stored Claude Code betas, not overwrite them.
    })
    fable = parseFableProbe(fableRes)
    const hasFableUsage = parsed.usage_has_fable === true || !!parsed.seven_day_oi
    // Usage listing a Fable model is Max. Hop 401/403 is format noise, not Pro.
    if (usageRes.ok && fable && hasFableUsage) {
      fable = { ...fable, banned: false, plan_denied: false }
    } else if (
      usageRes.ok &&
      fable &&
      (fable.banned || fable.status === 401 || /revoked|oauth|authentication/i.test(String(fable.error || '')))
    ) {
      fable = {
        ...fable,
        banned: false,
        plan_denied: true,
        error: fable.plan_denied || fable.status === 403 ? fable.error : 'plan_denied',
      }
    }
  }

  const sevenDayOi = parsed.seven_day_oi || fable?.seven_day_oi || null
  if (fable && sevenDayOi) {
    const oiFull =
      ['rejected', 'rate_limited'].includes(String(sevenDayOi.status || '').toLowerCase()) ||
      (sevenDayOi.utilization != null && Number(sevenDayOi.utilization) >= 1)
    fable = {
      ...fable,
      utilization: sevenDayOi.utilization ?? fable.utilization ?? null,
      reset_at: sevenDayOi.resets_at || fable.reset_at || null,
      limited: oiFull || (fable.limited && sevenDayOi.utilization == null),
    }
  }

  const usageDenied = usageRes.status === 401 || usageRes.status === 403
  return {
    ok: !!(usageRes.ok || (includeFable && fable?.ok)) && !usageDenied,
    rate_limited: usageRateLimited && !usageRes.ok,
    retry_after_ms: usageRateLimited ? parseUsageRetryAfterMs(usageRes.headers, usageRes.body) || 15 * 60_000 : null,
    source: 'official-cc-usage',
    via: usageRes.via || 'go-worker',
    usage_status: usageRes.status,
    usage_error: usageRes.ok
      ? null
      : usageRes.body?.error?.message || usageRes.body?.error || `http_${usageRes.status}`,
    ...parsed,
    five_hour: official?.five_hour || parsed.five_hour,
    seven_day: official?.seven_day || parsed.seven_day,
    seven_day_sonnet: official?.seven_day_sonnet || parsed.seven_day_sonnet,
    seven_day_oi: sevenDayOi,
    extra_usage: official?.extra_usage || parsed.extra_usage,
    interpretations: usageRes.ok ? compareUsageInterpretations(rawBody) : null,
    fable,
    probed_at: new Date().toISOString(),
  }
}
