export type CardKind = 'session' | 'weekly' | 'fable' | 'full'

export type ResetCredit = {
  /** Opaque per-slot card handle; absent on snapshots saved before card choice existed. */
  ref?: string
  kind?: CardKind
  state?: 'ready' | 'cooldown' | 'unavailable'
  gives_back_weekly?: boolean
  label?: string
  resets_left?: number
  expires_at?: string
  clears?: string[]
  redeemable?: boolean
}

export type ResetSnapshot = {
  eligible?: boolean
  available_count?: number
  held_count?: number
  credits?: ResetCredit[]
  cooldown_until?: string
  fetched_at?: string
}

export type ResetPayload = {
  outcome?: string
  kind?: CardKind
  reason?: string
  claude_reset_credits?: ResetSnapshot | null
}

/** Current usage shown next to the cards, so the confirm dialog can warn. */
export type ResetUsage = {
  fiveHour?: number | null
  sevenDay?: number | null
  /** null = no Fable usage window (e.g. Pro). */
  fable?: number | null
  /** 7-day gate in percent; the slot is held back from here. */
  sevenDayGate?: number | null
}

export const KIND_NAME: Record<CardKind, string> = {
  session: '5 小时卡',
  weekly: '每周卡',
  fable: 'Fable 卡',
  full: '全量卡',
}

export const WINDOW_LABEL: Record<string, string> = {
  five_hour: '5 小时',
  seven_day: '7 天',
  seven_day_overage_included: 'Fable 周额度',
}

export const OUTCOME_TEXT: Record<string, string> = {
  already_used: '这张卡已经用过',
  not_limited: '当前没有打满，未消耗重置卡',
  cooldown: '仍在冷却，未消耗重置卡',
  ineligible: '当前账号不能兑换',
  unknown: '结果未确认，已暂停该组织的再次兑换',
}

export const pct = (value: number | null | undefined) =>
  value == null || !Number.isFinite(Number(value))
    ? null
    : Math.round(Number(value))

export function kindName(kind: CardKind | undefined) {
  return KIND_NAME[kind || 'full'] || KIND_NAME.full
}

/** 「使用 Fable 卡」：拉丁字母开头的卡名前补一个空格。 */
export function spaced(name: string) {
  return /^[A-Za-z]/.test(name) ? ` ${name}` : name
}

export function windows(credit: ResetCredit) {
  return (credit.clears || []).filter((item) => WINDOW_LABEL[item])
}

export function clearsText(credit: ResetCredit) {
  const list = windows(credit).map((item) => WINDOW_LABEL[item])
  const keepsWeekly = !windows(credit).includes('seven_day')
  if (!list.length)
    return credit.gives_back_weekly ? '只退回本周 Fable 用量' : ''
  return `清 ${list.join('、')}${keepsWeekly ? '（7 天不清）' : ''}`
}

/** A card past its cooldown is offered again; the server re-checks before spending it. */
export function liveState(
  credit: ResetCredit,
  snapshot: ResetSnapshot,
  now: number
) {
  if (credit.state === 'cooldown') {
    const until = Date.parse(snapshot.cooldown_until || '')
    return Number.isFinite(until) && until > now ? 'cooldown' : 'ready'
  }
  return credit.state || (credit.redeemable ? 'ready' : 'unavailable')
}

export function shownCredits(snapshot: ResetSnapshot | null | undefined) {
  return (snapshot?.credits || []).filter(
    (credit) =>
      credit.ref &&
      credit.state !== 'unavailable' &&
      Number(credit.resets_left) > 0
  )
}

export function isLegacy(snapshot: ResetSnapshot | null | undefined) {
  return (snapshot?.credits || []).some((credit) => !credit.ref)
}

/** 总张数：上游不让用的卡不算；旧格式快照沿用原来的可兑换次数。 */
export function claudeResetCount(snapshot: ResetSnapshot | null | undefined) {
  if (!snapshot) return 0
  if (isLegacy(snapshot))
    return Math.max(0, Number(snapshot.available_count) || 0)
  if (snapshot.held_count != null)
    return Math.max(0, Number(snapshot.held_count) || 0)
  return shownCredits(snapshot).reduce(
    (sum, credit) => sum + Math.max(0, Number(credit.resets_left) || 0),
    0
  )
}

export function claudeResetWarnings(
  credit: ResetCredit,
  usage: ResetUsage | undefined,
  others: ResetCredit[]
) {
  const out: string[] = []
  const clears = windows(credit)
  const seven = pct(usage?.sevenDay)
  const gate = pct(usage?.sevenDayGate) ?? 100
  if (!clears.includes('seven_day') && seven != null && seven >= gate) {
    const full = others.some(
      (other) => other !== credit && windows(other).includes('seven_day')
    )
    out.push(
      `7 天已用 ${seven}%，到了闸线，这张清不掉${full ? '；要清 7 天请用全量卡' : ''}。`
    )
  }
  if (credit.kind === 'fable' && !(pct(usage?.fable) ?? 0)) {
    const rest = clears
      .filter((item) => item !== 'seven_day_overage_included')
      .map((item) => WINDOW_LABEL[item])
    out.push(
      rest.length
        ? `这个槽本周没有 Fable 用量，用这张等于只清 ${rest.join('、')}。`
        : '这个槽本周没有 Fable 用量，用这张等于什么都不清。'
    )
  }
  return out
}
