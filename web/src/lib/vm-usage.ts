import type { UsageAccountRow } from '@/types/panel-usage'
import type { Vm } from '@/types/panel-vm'
import { isCodexVm } from '@/lib/vm-kind'

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * A usage row keyed by the slot id rather than the account uuid, with no email —
 * left behind by an earlier credential on the same slot. Not this account's data.
 */
export function isLeftoverUsageRow(row: UsageAccountRow, vm: Vm): boolean {
  const id = String(row.account_id || '')
  if (!id) return false
  return (
    id === String(vm.id || '') &&
    id !== String(vm.account_uuid || '') &&
    !row.email
  )
}

/**
 * A usage row whose account_id equals its own vm_id and has no email — a
 * slot with no real credential bound, not an actual account. Distinct from
 * `isLeftoverUsageRow` (which needs a `Vm` to compare against); this one
 * only needs the row itself, for list-wide filtering. Mirrors index.html's
 * `isLeftoverUsageAccount(a)`.
 */
export function isLeftoverUsageAccount(row: UsageAccountRow): boolean {
  const id = String(row.account_id || '')
  const vmId = String(row.vm_id || '')
  return !!id && id === vmId && !row.email
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
      today_tokens: num(vm.today_tokens) || dashInn + dashOut,
    }
  }

  return {
    ...vm,
    today_requests: Math.max(dashReq, accReq),
    today_input_tokens: dashInn || accInn,
    today_output_tokens: dashOut || accOut,
    today_cache_read_tokens: Math.max(dashRead, accRead),
    today_cache_creation_tokens: Math.max(dashWrite, accWrite),
    today_tokens: (dashInn || accInn) + (dashOut || accOut),
    today_cost: Math.max(dashCost, accCost),
    cache_hit_rate: vm.cache_hit_rate ?? null,
  }
}

/** `null` means no prompt tokens at all — distinct from a real 0% hit rate. */
export function cacheHitPct(
  input: unknown,
  read: unknown,
  write: unknown,
  scheme: 'anthropic' | 'openai' = 'anthropic'
): number | null {
  const prompt =
    scheme === 'openai' ? num(input) : num(input) + num(read) + num(write)
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
    row.today_cache_creation_tokens,
    isCodexVm(vm) ? 'openai' : 'anthropic'
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
    tok: num(row.today_tokens) || inn + out,
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
