export type BillingItem = {
  vm_id?: string | null
  api_key_id?: string | null
  requests: number
  ok: number
  fail: number
  tokens_in: number
  tokens_out: number
  /** 乘分组倍率后的费用（actual_cost） */
  cost_usd: number
  /** 官方价（total_cost），与 dashboard 今日/累计同口径 */
  official_cost_usd?: number
}

export type BillingPayload = {
  group_by?: 'vm' | 'key'
  since?: string | null
  until?: string | null
  totals?: BillingItem
  items?: BillingItem[]
}
