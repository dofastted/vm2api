/**
 * Parse official Claude Code `/stats` output into quota + account tier.
 * Accepts --output-format json envelopes or raw CLI text. Never logs secrets.
 */
import { normUtilization, parseOAuthUsage } from './crs-usage-probe.mjs'

export function officialStatsText(raw) {
  if (raw == null) return ''
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return ''
    try {
      return officialStatsText(JSON.parse(trimmed))
    } catch {
      return trimmed
    }
  }
  if (typeof raw === 'object') {
    if (typeof raw.result === 'string') return raw.result
    if (typeof raw.text === 'string') return raw.text
    return JSON.stringify(raw)
  }
  return String(raw)
}

function pctToUtil(match) {
  if (!match) return null
  return normUtilization(match)
}

function windowFromText(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re)
    if (!m) continue
    const utilization = pctToUtil(m[1])
    if (utilization == null) continue
    return {
      utilization,
      utilization_pct: Math.round(utilization * 1000) / 10,
      resets_at: null,
      status: utilization >= 1 ? 'rejected' : utilization >= 0.85 ? 'allowed_warning' : 'allowed',
    }
  }
  return null
}

export function inferTierFromOfficialStats(text = '', structured = {}) {
  if (structured?.seven_day_oi || structured?.fable?.ok || structured?.usage_has_fable) return 'max'
  const blob = `${text} ${JSON.stringify(structured || {})}`.toLowerCase()
  if (/\b(claude\s+max|max\s*20x|max plan|plan:\s*max)\b/.test(blob)) return 'max'
  if (/\b(claude\s+pro|pro plan|plan:\s*pro)\b/.test(blob)) return 'pro'
  if (structured?.fable?.plan_denied) return 'pro'
  return null
}

export function parseOfficialCcStats(raw) {
  let structured = null
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) structured = raw
  else if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw.trim())
      if (parsed && typeof parsed === 'object') structured = parsed
    } catch {}
  }

  const fromOfficialApi =
    structured && (structured.five_hour || structured.seven_day || structured.limits)
      ? parseOAuthUsage(structured)
      : null
  const nested = structured?.usage || structured?.stats || structured?.data || null
  const fromNested =
    nested && typeof nested === 'object' && (nested.five_hour || nested.seven_day) ? parseOAuthUsage(nested) : null

  const text = officialStatsText(raw)
  const fiveHour =
    fromOfficialApi?.five_hour ||
    fromNested?.five_hour ||
    windowFromText(text, [/5[\s-]*hour[^%\d]{0,40}(\d+(?:\.\d+)?)\s*%/i, /(\d+(?:\.\d+)?)\s*%[^%]{0,24}5[\s-]*hour/i])
  const sevenDay =
    fromOfficialApi?.seven_day ||
    fromNested?.seven_day ||
    windowFromText(text, [
      /7[\s-]*day[^%\d]{0,40}(\d+(?:\.\d+)?)\s*%/i,
      /weekly[^%\d]{0,40}(\d+(?:\.\d+)?)\s*%/i,
      /(\d+(?:\.\d+)?)\s*%[^%]{0,24}(7[\s-]*day|weekly)/i,
    ])
  const sevenDayOi = fromOfficialApi?.seven_day_oi || fromNested?.seven_day_oi || null
  const extra =
    fromOfficialApi?.extra_usage ||
    fromNested?.extra_usage ||
    (/extra[\s-]*usage[^.\n]{0,40}(on|enabled|true)/i.test(text)
      ? { is_enabled: true, utilization: null, resets_at: null, status: null }
      : null)

  const usage = {
    five_hour: fiveHour,
    seven_day: sevenDay,
    seven_day_sonnet: fromOfficialApi?.seven_day_sonnet || fromNested?.seven_day_sonnet || null,
    seven_day_oi: sevenDayOi,
    extra_usage: extra,
    usage_has_fable: fromOfficialApi?.usage_has_fable === true || fromNested?.usage_has_fable === true,
  }
  const accountTier = inferTierFromOfficialStats(text, { ...usage, fable: structured?.fable })
  return {
    ok: !!(fiveHour || sevenDay || sevenDayOi || extra || accountTier),
    account_tier: accountTier,
    source: 'official-cc-stats',
    text_len: text.length,
    ...usage,
  }
}
