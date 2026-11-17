/**
 * presentation.layout —— crag-auth 目录里的可选排版声明。
 *
 * 全链路可选：缺失或非法时调用方退回各自的原有默认排版，绝不因排版字段
 * 让目录整体不可用。正式买家页与 /crag-preview 画布共用本模块，保证
 * 「有 layout 时」两边排版一致。
 */

/** 线上形状：全部可选，未知键由 normalizeLayout 忽略。 */
export type PresentationLayout = {
  plan_columns?: 1 | 2 | 3
  card_density?: 'regular' | 'compact'
  orders_position?: 'below' | 'side'
  show_monthly_price?: boolean
  featured_sku?: string
  featured_label?: string
}

/** 解析后形状：字段全必填，消费侧无需再处理 undefined。 */
export type ResolvedLayout = {
  planColumns: 1 | 2 | 3
  cardDensity: 'regular' | 'compact'
  ordersPosition: 'below' | 'side'
  showMonthlyPrice: boolean
  featuredSku: string | null
  /** null 表示用 featuredFallback 兜底，不是「不显示角标」。 */
  featuredLabel: string | null
}

export const FEATURED_LABEL_MAX = 12
export const featuredFallback = '推荐'

/**
 * 逐字段宽容解析：非法字段丢弃回落默认，绝不抛错。
 *
 * 缺失、非对象、全字段非法都解析为同一份缺省排版（2 列 / regular / below /
 * 显示月价 / 无推荐），与 crag-auth 的语义一致 —— Auth 在布局等于默认时直接
 * 不写 `layout` 键，所以「没有 layout」和「layout 全取默认」是同一个状态。
 */
export function normalizeLayout(value: unknown): ResolvedLayout {
  const raw: Record<string, unknown> =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  return {
    planColumns:
      raw.plan_columns === 1 || raw.plan_columns === 2 || raw.plan_columns === 3
        ? raw.plan_columns
        : 2,
    cardDensity:
      raw.card_density === 'compact' || raw.card_density === 'regular'
        ? raw.card_density
        : 'regular',
    ordersPosition:
      raw.orders_position === 'side' || raw.orders_position === 'below'
        ? raw.orders_position
        : 'below',
    showMonthlyPrice:
      typeof raw.show_monthly_price === 'boolean'
        ? raw.show_monthly_price
        : true,
    featuredSku: nonEmpty(raw.featured_sku) ? raw.featured_sku : null,
    featuredLabel:
      nonEmpty(raw.featured_label) &&
      [...raw.featured_label].length <= FEATURED_LABEL_MAX
        ? raw.featured_label
        : null,
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * 列数查表。Tailwind JIT 扫源码，类名必须是静态字面量，不能拼 `lg:grid-cols-${n}`。
 *
 * 两张表而非一张：契约只说「宽屏每行套餐数，窄屏仍单列」，没规定宽屏从哪开始。
 * 选择器与预览画布的卡片带价格和说明，挤在 640px 放两列会压掉文本区，所以从
 * lg(1024px) 起；固定套餐区的卡片是紧凑单行，sm(640px) 起两列就够。
 *
 * 3 列统一在 xl(1280px) 才放开 —— 1024px 塞 3 张含价格的卡片同样会挤压文本区。
 */
export const pickerColumnClass: Record<1 | 2 | 3, string> = {
  1: '',
  2: 'lg:grid-cols-2',
  3: 'lg:grid-cols-2 xl:grid-cols-3',
}

export const commerceColumnClass: Record<1 | 2 | 3, string> = {
  1: '',
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-2 xl:grid-cols-3',
}

/**
 * 密度类名。compact 只收紧空间，不删减任何信息。
 */
export const densityClass = {
  regular: {
    grid: 'gap-2.5',
    card: 'p-4',
    minHeight: 'min-h-16',
    content: 'gap-1',
    tags: 'mt-1',
  },
  compact: {
    grid: 'gap-2',
    card: 'p-3',
    minHeight: 'min-h-14',
    content: 'gap-0.5',
    tags: 'mt-0.5',
  },
} as const

/** 订单区是否旁置。side 仅 ≥1280px(xl) 生效，窄屏由调用方的栅格天然回落到下方。 */
export const ordersSideClass = 'xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]'

/** 拼类名并丢掉空片段，避免单列（空列数类名）留下多余空格。 */
export function join(...parts: Array<string | undefined>) {
  return parts.filter(Boolean).join(' ')
}
