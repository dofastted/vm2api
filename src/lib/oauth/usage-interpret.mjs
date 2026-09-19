/**
 * Official Claude Code `/usage` and sub2api both read GET /api/oauth/usage.
 * Official Settings Usage treats `utilization` as a 0–100 percent
 * (`Math.floor(utilization)% used`, bar ratio = utilization / 100).
 * sub2api copies the same number onto 0–100 progress bars.
 * KIN used to treat values ≤ 1.5 as a 0–1 fraction, so `1` became 100% used.
 */

export function rawNumber(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Official /usage + sub2api: utilization is percent 0–100. */
export function normUsagePercent(v) {
  const n = rawNumber(v)
  if (n == null || n < 0) return null
  return Math.min(n / 100, 4)
}

/** KIN legacy + rate-limit headers: >1.5 is percent, otherwise 0–1 fraction. */
export function normLegacyMixed(v) {
  const n = rawNumber(v)
  if (n == null || n < 0) return null
  return n > 1.5 ? n / 100 : n
}

export function statusFromUsedFrac(u) {
  if (u == null) return null
  if (u >= 1) return 'rejected'
  if (u >= 0.85) return 'allowed_warning'
  return 'allowed'
}

export function fableScopeText(item = {}) {
  if (!item || typeof item !== 'object') return ''
  const model = item.scope?.model
  const modelObj = model && typeof model === 'object' ? model : null
  const modelStr = typeof model === 'string' ? model : typeof item.model === 'string' ? item.model : ''
  return [
    modelObj?.display_name,
    modelObj?.id,
    modelObj?.name,
    item.scope?.display_name,
    item.scope?.id,
    item.display_name,
    item.name,
    modelStr,
    typeof item.model === 'object' ? item.model?.id || item.model?.display_name : '',
  ]
    .filter(Boolean)
    .join(' ')
}

function fableCatalogItems(data = {}) {
  const limits = Array.isArray(data.limits) ? data.limits : []
  const scoped = Array.isArray(data.model_scoped) ? data.model_scoped : []
  return [...limits, ...scoped]
}

/** True when official /usage lists a Fable model. Presence is Max; missing catalog is unknown. */
export function usageHasFableModel(data = {}) {
  if (!data || typeof data !== 'object') return false
  if (data.seven_day_overage_included || data.seven_day_oi || data.seven_day_fable) return true
  return fableCatalogItems(data).some((item) => item && typeof item === 'object' && /fable/i.test(fableScopeText(item)))
}

/** `true` / `false` when limits or fable windows exist; `null` when usage has no model catalog. */
export function usageFablePresence(data = {}) {
  if (!data || typeof data !== 'object') return null
  if (usageHasFableModel(data)) return true
  if (
    Array.isArray(data.limits) ||
    Array.isArray(data.model_scoped) ||
    data.seven_day_oi === null ||
    data.seven_day_fable === null ||
    data.seven_day_overage_included === null
  ) {
    return false
  }
  return null
}

function viewWindow(rawWin, scale) {
  if (!rawWin || typeof rawWin !== 'object') return null
  const raw = rawNumber(rawWin.utilization ?? rawWin.percent)
  const resetsAt = rawWin.resets_at || rawWin.resetsAt || null
  const rawStatus = rawWin.status || null
  if (raw == null && !resetsAt && !rawStatus) return null
  const utilization = scale === 'legacy' ? normLegacyMixed(raw) : normUsagePercent(raw)
  const usedPct = utilization == null ? null : Math.round(utilization * 1000) / 10
  const remainPct = usedPct == null ? null : Math.round((100 - usedPct) * 10) / 10
  return {
    raw,
    utilization,
    utilization_pct: usedPct,
    used_pct: usedPct,
    remain_pct: remainPct == null ? null : Math.max(0, remainPct),
    resets_at: resetsAt,
    status: rawStatus || statusFromUsedFrac(utilization),
  }
}

function fableFromLimits(data = {}, scale) {
  const direct = data.seven_day_overage_included || data.seven_day_oi || data.seven_day_fable
  if (direct) return viewWindow(direct, scale)
  for (const item of Array.isArray(data.limits) ? data.limits : []) {
    if (!item || typeof item !== 'object') continue
    const kind = String(item.kind || item.type || '').toLowerCase()
    const scoped = kind === 'weekly_scoped' || kind === 'seven_day_overage_included' || kind === '7d_oi'
    if (!scoped || !/fable/i.test(fableScopeText(item))) continue
    return viewWindow(item, scale)
  }
  return null
}

function extraView(data = {}, scale) {
  const extra = data.extra_usage || data.extraUsage
  if (!extra || typeof extra !== 'object') return null
  const utilization = scale === 'legacy' ? normLegacyMixed(extra.utilization) : normUsagePercent(extra.utilization)
  return {
    is_enabled: !!(extra.is_enabled ?? extra.enabled),
    monthly_limit: extra.monthly_limit ?? extra.monthlyLimit ?? null,
    used_credits: extra.used_credits ?? extra.usedCredits ?? null,
    utilization,
    used_pct: utilization == null ? null : Math.round(utilization * 1000) / 10,
    resets_at: extra.resets_at || extra.resetsAt || null,
    status: extra.status || extra.overage_status || extra.overageStatus || null,
  }
}

/** Official Claude Code `/usage` Settings tab. */
export function interpretOfficialUsage(data = {}) {
  const fiveHour = viewWindow(data.five_hour, 'percent')
  const sevenDay = viewWindow(data.seven_day, 'percent')
  const sevenDaySonnet = viewWindow(data.seven_day_sonnet, 'percent')
  const sevenDayOauthApps = viewWindow(data.seven_day_oauth_apps, 'percent')
  const sevenDayOpus = viewWindow(data.seven_day_opus, 'percent')
  return {
    ok: !!(fiveHour || sevenDay || sevenDaySonnet || extraView(data, 'percent')),
    source: 'official-cc-usage',
    five_hour: fiveHour,
    seven_day: sevenDay,
    seven_day_sonnet: sevenDaySonnet,
    seven_day_oauth_apps: sevenDayOauthApps,
    seven_day_opus: sevenDayOpus,
    extra_usage: extraView(data, 'percent'),
  }
}

/** sub2api AccountUsageService.buildUsageInfo. */
export function interpretSub2apiUsage(data = {}) {
  const fiveHour = viewWindow(data.five_hour, 'percent')
  const sevenDay = viewWindow(data.seven_day, 'percent')
  const sevenDaySonnet = viewWindow(data.seven_day_sonnet, 'percent')
  const sevenDayFable = fableFromLimits(data, 'percent')
  return {
    ok: !!(fiveHour || sevenDay || sevenDaySonnet || sevenDayFable),
    source: 'sub2api-oauth-usage',
    five_hour: fiveHour,
    seven_day: sevenDay,
    seven_day_sonnet: sevenDaySonnet,
    seven_day_fable: sevenDayFable,
    seven_day_oi: sevenDayFable,
    extra_usage: extraView(data, 'percent'),
  }
}

/** Previous KIN mixed scale (1 → 100% used). */
export function interpretKinLegacyUsage(data = {}) {
  const fiveHour = viewWindow(data.five_hour, 'legacy')
  const sevenDay = viewWindow(data.seven_day, 'legacy')
  const sevenDaySonnet = viewWindow(data.seven_day_sonnet, 'legacy')
  const sevenDayOi = fableFromLimits(data, 'legacy')
  return {
    ok: !!(fiveHour || sevenDay || sevenDaySonnet || sevenDayOi),
    source: 'kin-legacy-mixed',
    five_hour: fiveHour,
    seven_day: sevenDay,
    seven_day_sonnet: sevenDaySonnet,
    seven_day_oi: sevenDayOi,
    extra_usage: extraView(data, 'legacy'),
  }
}

export function compareUsageInterpretations(data = {}) {
  const official = interpretOfficialUsage(data)
  const sub2api = interpretSub2apiUsage(data)
  const kin_legacy = interpretKinLegacyUsage(data)
  const keys = ['five_hour', 'seven_day', 'seven_day_sonnet']
  const disagree = []
  for (const key of keys) {
    const a = official[key]?.used_pct
    const b = sub2api[key]?.used_pct
    const c = kin_legacy[key]?.used_pct
    if (a == null && b == null && c == null) continue
    if (a !== c || a !== b) {
      disagree.push({
        window: key,
        raw: official[key]?.raw ?? sub2api[key]?.raw ?? kin_legacy[key]?.raw ?? null,
        official_used_pct: a,
        sub2api_used_pct: b,
        kin_legacy_used_pct: c,
      })
    }
  }
  return {
    official,
    sub2api,
    kin_legacy,
    disagree,
    same_official_sub2api: disagree.every((row) => row.official_used_pct === row.sub2api_used_pct),
  }
}
