import type { PresentationLayout, ResolvedLayout } from './crag-layout'

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

export type CragProduct = 'crag-v2' | 'craggemini'

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
  product?: CragProduct
  stackable?: boolean
}

export const CRAG_GEMINI_UNIT_PRICE_MINOR = 1000

export const CRAG_GEMINI_DEFAULT_PLAN: CragPlan = {
  sku: 'craggemini-1m-10',
  term: '1m',
  amount_minor: 10000,
  slot_limit: 10,
  product: 'craggemini',
  stackable: true,
  renewable: false,
  enabled: true,
  name: 'CRAGGemini 1个月兑换码 · 10 槽',
  description:
    'CRAGGemini 1个月宿主机兑换码，含 10 个席位槽位（¥10/槽），支持多码叠加；首批测试支持 7 天 / 10 槽兑换码（单码可用 100 次）。',
}

export type DraftPlan = Omit<CragPlan, 'amount_minor' | 'slot_limit'> & {
  amount_minor: number | null
  slot_limit: number | 'unlimited' | null
}

export type PlanOption = {
  sku: string
  term: string
  price: string
  quota: string
  name?: string
  description?: string
  enabled?: boolean
  remaining?: number | null
  renewable?: boolean
  product?: CragProduct
  stackable?: boolean
  /** 已格式化的折合月价；null 表示该套餐不适用（月卡或未定价）。 */
  monthly?: string | null
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
export type Presentation = Partial<Record<CopyKey, string>> & {
  layout?: PresentationLayout | null
}

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
    quota:
      slotLimit === 'unlimited'
        ? '额度不限'
        : slotLimit != null
          ? `${slotLimit} 个槽位`
          : '槽位待填写',
  }
}

/**
 * 套餐覆盖的月数。沿用既有推导：显式 months 优先，否则从 term 解析，
 * 无法判定时按 1 个月处理（折合月价因此不会显示）。
 */
export function planMonths(term: string | null, months?: number): number {
  if (months != null && Number.isSafeInteger(months) && months >= 1)
    return months
  if (term === '1y') return 12
  if (term && /^[1-9][0-9]*m$/.test(term)) return Number(term.slice(0, -1))
  return 1
}

/**
 * 折合月价。只对跨月套餐有意义：月卡（months <= 1）或未定价时返回 null，
 * 由调用方决定不渲染。
 */
export function monthlyPrice(
  amountMinor: number | null,
  months: number
): string | null {
  if (amountMinor == null || months <= 1) return null
  return yuan(amountMinor / months)
}

/**
 * 按 layout 门控的折合月价。缺省排版就是显示月价，与 crag-auth 的默认语义一致。
 */
export function monthlyFor(
  layout: Pick<ResolvedLayout, 'showMonthlyPrice'>,
  amountMinor: number | null,
  term: string | null,
  months?: number
): string | null {
  if (!layout.showMonthlyPrice) return null
  return monthlyPrice(amountMinor, planMonths(term, months))
}
