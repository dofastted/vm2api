/**
 * Parse official Claude Code `/usage` output (`/stats` is an alias since
 * 2.1.28x) into quota + a fallback account tier. Accepts stream-json event
 * lines, --output-format json envelopes, or raw CLI text. Never logs secrets.
 */
import { isCompleteOAuthUsage, normUtilization, parseOAuthUsage } from './crs-usage-probe.mjs'

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

/**
 * Authoritative tier from GET /api/oauth/profile (what the official CLI
 * reads for "Max"/"Pro"). Returns null when the profile does not say.
 */
export function tierFromOauthProfile(profile = {}) {
  const account = profile?.account || {}
  const org = profile?.organization || {}
  if (account.has_claude_max === true) return 'max'
  const orgType = String(org.organization_type || '').toLowerCase()
  const rateTier = String(org.rate_limit_tier || '').toLowerCase()
  if (orgType === 'claude_max' || rateTier.includes('max')) return 'max'
  if (account.has_claude_pro === true || orgType === 'claude_pro' || rateTier.includes('pro')) return 'pro'
  return null
}

export function inferTierFromOfficialStats(text = '', structured = {}) {
  if (structured?.seven_day_oi || structured?.fable?.ok || structured?.usage_has_fable) return 'max'
  if (structured?.usage_has_fable === false) return 'pro'
  const blob = `${text} ${JSON.stringify(structured || {})}`.toLowerCase()
  if (/\b(claude\s+max|max\s*20x|max plan|plan:\s*max)\b/.test(blob)) return 'max'
  if (/\b(claude\s+pro|pro plan|plan:\s*pro)\b/.test(blob)) return 'pro'
  if (structured?.fable?.plan_denied) return 'pro'
  return null
}

/**
 * `claude -p /usage --output-format stream-json --verbose` prints one JSON
 * event per line. The synthetic assistant event carries `usage_report`
 * (server limits[] verbatim); the final `result` event carries the text.
 */
export function officialUsageEvents(raw) {
  if (typeof raw !== 'string') return null
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length < 2) return null
  const events = []
  for (const line of lines) {
    try {
      const doc = JSON.parse(line)
      if (doc && typeof doc === 'object') events.push(doc)
    } catch {}
  }
  if (!events.length) return null
  const report = events.map((e) => e.usage_report).find((r) => r && typeof r === 'object') || null
  const result = [...events].reverse().find((e) => e.type === 'result') || null
  return { report, result }
}

/** Map server limits[] rows onto the /api/oauth/usage window shape. */
export function usageFromLimits(rateLimits) {
  const limits = Array.isArray(rateLimits?.limits) ? rateLimits.limits : null
  if (!limits) return null
  const win = (row) => (row ? { utilization: row.percent, resets_at: row.resets_at || null } : null)
  const byKind = (kind) => limits.find((row) => String(row?.kind || '').toLowerCase() === kind)
  const scoped = (name) =>
    limits.find(
      (row) =>
        String(row?.kind || '').toLowerCase() === 'weekly_scoped' &&
        new RegExp(name, 'i').test(String(row?.scope?.model?.display_name || '')),
    )
  return {
    five_hour: win(byKind('session')),
    seven_day: win(byKind('weekly_all')),
    seven_day_sonnet: win(scoped('sonnet')),
    limits,
    extra_usage: rateLimits.extra_usage || null,
  }
}

const TEXT_ROW = /^Current (session|week \(([^)]+)\)):\s*(\d+(?:\.\d+)?)%\s*used/gim

/** Text rows printed by 2.1.28x `/usage`: `Current week (Fable): 21% used · resets …`. */
export function usageFromText(text = '') {
  const rows = [...String(text).matchAll(TEXT_ROW)]
  if (!rows.length) return null
  const out = { limits: [] }
  for (const m of rows) {
    const pct = Number(m[3])
    if (m[1].toLowerCase() === 'session') {
      out.five_hour = { utilization: pct }
      continue
    }
    const scope = m[2]
    if (/^all models$/i.test(scope)) out.seven_day = { utilization: pct }
    else if (/^sonnet only$/i.test(scope)) out.seven_day_sonnet = { utilization: pct }
    else out.limits.push({ kind: 'weekly_scoped', percent: pct, scope: { model: { display_name: scope } } })
  }
  out.limits_present = !!(out.five_hour && out.seven_day)
  return out
}

export function parseOfficialCcStats(raw) {
  const events = officialUsageEvents(raw)
  if (events) {
    const fromReport = usageFromLimits(events.report?.rate_limits)
    const base = parseOfficialCcStats(fromReport || events.result || '')
    // null limits = the CLI answered from a cached/seeded read without the
    // server rows; that is where Max accounts lose the Fable window.
    return { ...base, limits_present: base.limits_present === true }
  }
  let structured = null
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) structured = raw
  else if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw.trim())
      if (parsed && typeof parsed === 'object') structured = parsed
    } catch {}
  }
  if (!structured || !(structured.five_hour || structured.seven_day || structured.limits)) {
    const fromText = usageFromText(officialStatsText(raw))
    if (fromText) {
      const base = parseOfficialCcStats({ ...fromText, fable: structured?.fable })
      const limitsPresent = fromText.limits_present === true
      return { ...base, account_tier: limitsPresent ? base.account_tier : null, limits_present: limitsPresent }
    }
  }

  const fromOfficialApi =
    structured && (structured.five_hour || structured.seven_day || structured.limits || structured.model_scoped)
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
    usage_has_fable: fromOfficialApi?.usage_has_fable ?? fromNested?.usage_has_fable ?? null,
  }
  const accountTier = inferTierFromOfficialStats(text, { ...usage, fable: structured?.fable })
  const limitsPresent = structured ? isCompleteOAuthUsage(structured, fromOfficialApi) : false
  return {
    ok: !!(fiveHour || sevenDay || sevenDayOi || extra || accountTier),
    account_tier: limitsPresent ? accountTier : null,
    limits_present: limitsPresent,
    source: 'official-cc-usage-cli',
    text_len: text.length,
    ...usage,
  }
}
