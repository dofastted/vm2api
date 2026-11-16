export type CommerceRules = {
  unit_amount_minor: number
  max_amount_minor: number
  min_months?: number
  max_months: number
  min_slots?: number
  max_slots: number
  custom_enabled?: boolean
  custom_renewable?: boolean
}

export type CragPlan = {
  sku: string
  term: string
  amount_minor: number
  slot_limit: number | 'unlimited'
  remaining?: number | null
  stock?: number
  renewable?: boolean
  name?: string
  description?: string
  enabled?: boolean
  months?: number
}

export type DraftPlan = Omit<CragPlan, 'amount_minor' | 'slot_limit'> & {
  amount_minor: number | null
  slot_limit: number | 'unlimited' | null
}

export type PlanOption = {
  sku: string
  term: string
  price: string
  locks: string
  name?: string
  description?: string
  enabled?: boolean
  remaining?: number | null
  renewable?: boolean
}

export const copyDefaults = {
  title: '订阅 CRAG',
  description: '查看订阅套餐和本人历史订单。付款、交付与激活状态分别确认。',
  plans_title: '订阅套餐',
  orders_title: '历史订单',
  custom_title: '自定义槽位和时长',
  unavailable_text: '当前未开放收款。可以选择和比较套餐，暂不能创建订单。',
  empty_plans_text: '暂无可购买的套餐，仍可查看历史订单。',
  empty_orders_text: '还没有订阅订单。下单后可以在这里查看支付和激活状态。',
}
export type CopyKey = keyof typeof copyDefaults
export const copyLabels: Record<CopyKey, string> = {
  title: '页面标题',
  description: '页面说明',
  plans_title: '套餐区标题',
  orders_title: '订单区标题',
  custom_title: '自定义购买标题',
  unavailable_text: '停售提示',
  empty_plans_text: '无套餐提示',
  empty_orders_text: '无历史订单提示',
}
export type Presentation = Partial<Record<CopyKey, string>>

const money = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency: 'CNY',
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
})
export const yuan = (minor: number) => money.format(minor / 100)

const terms = { '1m': '月卡', '3m': '季卡', '1y': '年卡' }
export function termLabel(term: string | null, sku: string, months?: number) {
  if (months != null)
    return `${sku === 'renewal' ? '续费 · ' : ''}${months} 个月`
  const duration =
    term &&
    (/^[1-9][0-9]*m$/.test(term)
      ? `${term.slice(0, -1)} 个月`
      : terms[term as keyof typeof terms])
  if (sku === 'renewal') return duration ? `续费 · ${duration}` : '续费'
  return (term && terms[term as keyof typeof terms]) || duration || sku
}

export function formatPlanDetails(
  amountMinor: number | null,
  slotLimit: DraftPlan['slot_limit']
) {
  return {
    price: amountMinor != null ? yuan(amountMinor) : '未定价',
    locks:
      slotLimit === 'unlimited'
        ? '应用锁不限'
        : slotLimit != null
          ? `${slotLimit} 把应用锁`
          : '槽位待填写',
  }
}
