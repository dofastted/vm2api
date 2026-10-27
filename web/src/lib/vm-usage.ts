import type { BillingAccountRow } from '@/types/panel-overview'
import type { WindowEstimate } from '@/types/panel-pricing'
import type { UsageAccountRow } from '@/types/panel-usage'
import type { Vm, VmClosedWindow } from '@/types/panel-vm'
import { fmtNum, fmtUsd } from '@/lib/format'

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * A usage row keyed by the slot id rather than the account uuid, with no email —
 * left behind by an earlier credential on the same slot. Not this account's data.
 * No uuid (GPT / unbound) is the live row, not leftover — same as
 * `isLeftoverVmKeyedAccount`.
 */
export function isLeftoverUsageRow(row: UsageAccountRow, vm: Vm): boolean {
  const id = String(row.account_id || '')
  if (!id) return false
  const uuid = String(vm.account_uuid || '')
  if (!uuid) return false
  return id === String(vm.id || '') && id !== uuid && !row.email
}

/**
 * A usage row whose account_id equals its own vm_id and has no email — a
 * slot with no real credential bound, not an actual account. Distinct from
 * `isLeftoverUsageRow` (which needs a `Vm` to compare against); this one
 * only needs the row itself, for list-wide filtering. Mirrors index.html's
 * `isLeftoverUsageAccount(a)`. Spend on that key is a live GPT/slot row.
 */
export function isLeftoverUsageAccount(row: UsageAccountRow): boolean {
  const id = String(row.account_id || '')
  const vmId = String(row.vm_id || '')
  if (!id || id !== vmId || row.email) return false
  return (
    num(row.total_cost) === 0 &&
    num(row.today_cost) === 0 &&
    num(row.requests) === 0 &&
    num(row.window_5h_cost) === 0 &&
    num(row.window_7d_cost) === 0
  )
}

/**
 * The slot a billing row may be shown as. Slot ids get reused, so a row from an
 * earlier account on the same id belongs to that account, not the slot's current one.
 */
export function billingRowSlot(
  row: BillingAccountRow,
  byId: Map<string, Vm>
): Vm | undefined {
  const vm = row.vm_id ? byId.get(String(row.vm_id)) : undefined
  if (!vm?.account_uuid) return vm
  return vm.account_uuid === row.account_id ? vm : undefined
}

export function usageAccountForVm(
  vm: Vm | null | undefined,
  accounts: UsageAccountRow[] | undefined
): UsageAccountRow | null {
  if (!vm || !accounts?.length) return null
  if (vm.account_uuid) {
    const byUuid = accounts.find((a) => a.account_id === vm.account_uuid)
    if (byUuid) return byUuid
  }
  return (
    accounts.find(
      (a) =>
        (a.vm_id === vm.id || a.account_id === vm.id) &&
        !isLeftoverUsageRow(a, vm)
    ) || null
  )
}

/**
 * Merge the dashboard's today counters with the richer /usage account row.
 * The usage row wins only when it actually carries more, so a stale or empty
 * account row can never erase live dashboard numbers.
 */
export function vmTodayView(vm: Vm, accounts?: UsageAccountRow[]): Vm {
  const acc = usageAccountForVm(vm, accounts)
  const t = acc?.today && typeof acc.today === 'object' ? acc.today : null

  const accRead = num(t?.cache_read_tokens ?? acc?.today_cache_read_tokens)
  const accWrite = num(
    t?.cache_creation_tokens ?? acc?.today_cache_creation_tokens
  )
  const accInn = num(t?.input_tokens ?? acc?.today_input_tokens)
  const accOut = num(t?.output_tokens ?? acc?.today_output_tokens)
  const accReq = num(t?.requests ?? acc?.today_requests)
  const accCost = num(acc?.today_cost ?? t?.total_cost)

  const dashRead = num(vm.today_cache_read_tokens)
  const dashWrite = num(vm.today_cache_creation_tokens)
  const dashInn = num(vm.today_input_tokens)
  const dashOut = num(vm.today_output_tokens)
  const dashReq = num(vm.today_requests)
  const dashCost = num(vm.today_cost)

  const accRicher =
    !!(acc || t) &&
    (accRead > dashRead ||
      accWrite > dashWrite ||
      accReq > dashReq ||
      accCost > dashCost ||
      (dashRead === 0 && dashInn === 0 && accRead + accWrite + accInn > 0))

  if (!accRicher) {
    return {
      ...vm,
      today_requests: dashReq,
      today_cost: dashCost,
      today_input_tokens: dashInn,
      today_output_tokens: dashOut,
      today_cache_read_tokens: dashRead,
      today_cache_creation_tokens: dashWrite,
      today_tokens:
        num(vm.today_tokens) || dashInn + dashOut + dashRead + dashWrite,
    }
  }

  return {
    ...vm,
    today_requests: Math.max(dashReq, accReq),
    today_input_tokens: dashInn || accInn,
    today_output_tokens: dashOut || accOut,
    today_cache_read_tokens: Math.max(dashRead, accRead),
    today_cache_creation_tokens: Math.max(dashWrite, accWrite),
    today_tokens:
      num(vm.today_tokens) ||
      num(acc?.today_tokens) ||
      (dashInn || accInn) +
        (dashOut || accOut) +
        Math.max(dashRead, accRead) +
        Math.max(dashWrite, accWrite),
    today_cost: Math.max(dashCost, accCost),
    cache_hit_rate: vm.cache_hit_rate ?? null,
  }
}

/** `null` means no prompt tokens at all — distinct from a real 0% hit rate.
 *  Input is disjoint (excludes cache) on every platform. */
export function cacheHitPct(
  input: unknown,
  read: unknown,
  write: unknown
): number | null {
  const prompt = num(input) + num(read) + num(write)
  if (!prompt) return null
  return Math.min(100, (num(read) / prompt) * 100)
}

/** Prefers the gateway's own `cache_hit_rate` (0–1) and falls back to local math. */
export function vmCacheHitPct(
  vm: Vm,
  accounts?: UsageAccountRow[]
): number | null {
  const row = vmTodayView(vm, accounts)
  const rate = row.cache_hit_rate
  if (rate != null && Number.isFinite(Number(rate))) return Number(rate) * 100
  return cacheHitPct(
    row.today_input_tokens,
    row.today_cache_read_tokens,
    row.today_cache_creation_tokens
  )
}

export function fmtHitPct(p: number | null): string {
  if (p == null || !Number.isFinite(p)) return '—'
  return `${p.toFixed(p >= 10 ? 1 : 2)}%`
}

export function vmTodayStats(vm: Vm, accounts?: UsageAccountRow[]) {
  const row = vmTodayView(vm, accounts)
  const inn = num(row.today_input_tokens)
  const out = num(row.today_output_tokens)
  return {
    row,
    today: num(row.today_cost),
    req: num(row.today_requests),
    tok:
      num(row.today_tokens) ||
      inn +
        out +
        num(row.today_cache_read_tokens) +
        num(row.today_cache_creation_tokens),
    inn,
    out,
    read: num(row.today_cache_read_tokens),
    write: num(row.today_cache_creation_tokens),
    hit: vmCacheHitPct(vm, accounts),
  }
}

/** 近 7 天官方计费窗口的成功 / 失败。缺字段时 `known` 为 false，列表不编造失败数。 */
export type VmWeekOutcome = {
  known: boolean
  success: number
  fail: number
  req: number
  tok: number
  cost: number
}

export function vmWeekOutcome(
  vm: Vm,
  accounts?: UsageAccountRow[]
): VmWeekOutcome {
  const acc = usageAccountForVm(vm, accounts)
  const src = acc ?? vm
  const successRaw = src.window_7d_success
  const failRaw = src.window_7d_errors
  const known = successRaw != null || failRaw != null
  return {
    known,
    success: num(successRaw),
    fail: num(failRaw),
    req: num(src.window_7d_requests ?? vm.window_7d_requests),
    tok: num(src.window_7d_tokens ?? vm.window_7d_tokens),
    cost: num(src.window_7d_cost ?? vm.window_7d_cost),
  }
}

/** 5h / 7d 窗口的官方调用费用合计。用量行有字段时优先，否则用槽位快照。 */
export function vmWindowCosts(
  vm: Vm,
  accounts?: UsageAccountRow[]
): { h5: number; d7: number } {
  const acc = usageAccountForVm(vm, accounts)
  return {
    h5: num(acc?.window_5h_cost ?? vm.window_5h_cost),
    d7: num(acc?.window_7d_cost ?? vm.window_7d_cost),
  }
}

/** 5h / 7d 窗口 token（含缓存）。取值顺序同 `vmWindowCosts`。 */
export function vmWindowTokens(
  vm: Vm,
  accounts?: UsageAccountRow[]
): { h5: number; d7: number } {
  const acc = usageAccountForVm(vm, accounts)
  return {
    h5: num(acc?.window_5h_tokens ?? vm.window_5h_tokens),
    d7: num(acc?.window_7d_tokens ?? vm.window_7d_tokens),
  }
}

/**
 * 账号累计官方价费用。`/api/panel/vms` 不带任何费用字段，累计值只在 `/usage`
 * 账号行和 `/dashboard` 的槽位里；两边都可能缺，取较大者，和 `vmTodayView`
 * 同一取舍——累计只增不减，较小的一定是过期或缺失。
 */
export function vmTotalCost(vm: Vm, accounts?: UsageAccountRow[]): number {
  return Math.max(
    num(vm.total_cost),
    num(usageAccountForVm(vm, accounts)?.total_cost)
  )
}

/** 累计 token，与 `vmTotalCost` 同源同取舍。 */
export function vmTotalTokens(vm: Vm, accounts?: UsageAccountRow[]): number {
  return Math.max(
    num(vm.total_tokens),
    num(usageAccountForVm(vm, accounts)?.total_tokens)
  )
}

export type VmLedgerRow = {
  key: '5h' | '7d' | 'total'
  label: string
  cost: number
  tokens: number
}

/** 一台槽位的费用与 token 只走这一份：5H / 7D 窗口 + 账号总计。 */
export function vmCostLedger(
  vm: Vm,
  accounts?: UsageAccountRow[]
): VmLedgerRow[] {
  const cost = vmWindowCosts(vm, accounts)
  const tok = vmWindowTokens(vm, accounts)
  return [
    { key: '5h', label: '5H', cost: cost.h5, tokens: tok.h5 },
    { key: '7d', label: '7D', cost: cost.d7, tokens: tok.d7 },
    {
      key: 'total',
      label: '总计',
      cost: vmTotalCost(vm, accounts),
      tokens: vmTotalTokens(vm, accounts),
    },
  ]
}

export const ESTIMATE_STATUS_ZH: Record<WindowEstimate['status'], string> = {
  ok: '估算有效',
  no_data: '无用量读数',
  no_reset: '无重置时间',
  log_gap: '日志未覆盖窗口',
  low_usage: '用量<5%',
  unpriced: '窗口内有未定价请求',
}

const ESTIMATE_CAVEAT = '按官方价估算；账号在网关外使用会偏低'

export function estimateTooltip(
  est: WindowEstimate | null | undefined
): string {
  const bits = [est ? ESTIMATE_STATUS_ZH[est.status] : '暂无估算']
  if (est?.total_tokens != null && Number.isFinite(est.total_tokens)) {
    bits.push(`约 ${fmtNum(est.total_tokens)} tok`)
  }
  bits.push(ESTIMATE_CAVEAT)
  return bits.join('\n')
}

export function formatWindowSpend(
  spent: number,
  est: WindowEstimate | null | undefined
): { costText: string; remainText: string; tooltip: string } {
  const tooltip = estimateTooltip(est)
  const spentUsd = fmtUsd(est?.spent_usd ?? spent, 2)
  if (!est) {
    return {
      costText: spent > 0 ? fmtUsd(spent, 2) : '',
      remainText: '',
      tooltip,
    }
  }
  if (est.status !== 'ok') {
    return {
      costText: `${spentUsd} / —`,
      remainText: '—',
      tooltip,
    }
  }
  const total =
    est.total_usd == null || !Number.isFinite(est.total_usd)
      ? '—'
      : fmtUsd(est.total_usd, 2)
  const remain =
    est.remaining_usd == null || !Number.isFinite(est.remaining_usd)
      ? '—'
      : `余 ${fmtUsd(est.remaining_usd, 2)}`
  return {
    costText: `${spentUsd} / ≈${total}`,
    remainText: remain,
    tooltip,
  }
}

/** 窗口起止 `MM-DD HH:mm – HH:mm`；跨天时结束端也带日期。本地时区，与重置时刻同口径。 */
export function fmtWindowSpan(start: string, end: string): string {
  const a = new Date(start)
  const b = new Date(end)
  if (!Number.isFinite(a.getTime()) || !Number.isFinite(b.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  const day = (d: Date) => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const tail = day(a) === day(b) ? clock(b) : `${day(b)} ${clock(b)}`
  return `${day(a)} ${clock(a)} – ${tail}`
}

/** 上个窗口一行说明：起止 · 官方价花费 · 请求数。 */
export function closedWindowHint(w: VmClosedWindow): string {
  return [
    fmtWindowSpan(w.start, w.end),
    fmtUsd(w.total_cost, 2),
    `${fmtNum(w.requests)} req`,
  ].join(' · ')
}
