import type { BillingItem } from '@/types/panel-billing'
import type { Vm } from '@/types/panel-vm'
import { type VmKind, vmKindOf } from '@/lib/vm-kind'

export function emptyTotals(): BillingItem {
  return {
    requests: 0,
    ok: 0,
    fail: 0,
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
  }
}

function addItem(acc: BillingItem, row: BillingItem): BillingItem {
  return {
    requests: acc.requests + row.requests,
    ok: acc.ok + row.ok,
    fail: acc.fail + row.fail,
    tokens_in: acc.tokens_in + row.tokens_in,
    tokens_out: acc.tokens_out + row.tokens_out,
    cost_usd: acc.cost_usd + row.cost_usd,
  }
}

/**
 * 按槽位种类拆 Claude / GPT。查不到槽位（还没加载、已删除）时不猜：
 * vmKindOf(undefined) 会默认 Claude，把 GPT 费用算进 Claude。
 */
export function splitBilling(
  items: BillingItem[],
  groupBy: 'vm' | 'key',
  vms: Map<string, Vm>
) {
  const rows = items.map((row) => {
    const vm = row.vm_id ? vms.get(row.vm_id) : undefined
    const kind: VmKind | null = groupBy === 'vm' && vm ? vmKindOf(vm) : null
    return { row, vm, kind }
  })
  let claude = emptyTotals()
  let gpt = emptyTotals()
  let antigravity = emptyTotals()
  for (const item of rows) {
    if (item.kind === 'codex') gpt = addItem(gpt, item.row)
    else if (item.kind === 'antigravity')
      antigravity = addItem(antigravity, item.row)
    else if (item.kind === 'claude') claude = addItem(claude, item.row)
  }
  return { rows, claude, gpt, antigravity }
}
