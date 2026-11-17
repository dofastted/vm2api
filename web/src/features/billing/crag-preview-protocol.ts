import {
  copyDefaults,
  type CommerceRules,
  type DraftPlan,
  type CopyKey,
  type Presentation,
} from './crag-catalog'

export type PreviewDraft = {
  plans: DraftPlan[]
  commerce?: CommerceRules | null
  presentation?: Presentation | null
}

export type DraftMessage = {
  type: 'crag-preview:draft'
  draft: PreviewDraft
  selected?: string | null
  theme: 'light' | 'dark'
  edit: boolean
  seq?: number
}

export type PreviewEdit =
  | { target: 'copy'; key: CopyKey; value: string }
  | {
      target: 'plan'
      sku: string
      field: 'name' | 'description'
      value: string
    }
  // 推荐角标文案走 edit 通道而不是 layout 通道：父页的 crag-preview:layout
  // 只认 plan_columns / orders_position / featured_sku，其余 key 一律丢弃，
  // featured_label 在它的 crag-preview:edit 分支里以 target:'layout' 处理，
  // 且父页未设推荐位时会拒收。画布目前不做列数/密度/位置/推荐位控件，
  // 所以没有往 crag-preview:layout 发消息的路径。
  | { target: 'layout'; key: 'featured_label'; value: string }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function integer(value: unknown, min = 0): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min
  )
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

function validPlan(value: unknown): value is DraftPlan {
  if (!record(value)) return false
  return (
    text(value.sku, 128) &&
    value.sku.trim().length > 0 &&
    value.sku !== 'custom' &&
    ['1m', '3m', '1y'].includes(value.term as string) &&
    (value.amount_minor === null || integer(value.amount_minor)) &&
    (value.slot_limit === null ||
      value.slot_limit === 'unlimited' ||
      integer(value.slot_limit)) &&
    (value.remaining === undefined ||
      value.remaining === null ||
      integer(value.remaining)) &&
    (value.stock === undefined || integer(value.stock)) &&
    (value.months === undefined || integer(value.months, 1)) &&
    (value.enabled === undefined || typeof value.enabled === 'boolean') &&
    (value.renewable === undefined || typeof value.renewable === 'boolean') &&
    (value.name === undefined || text(value.name, 120)) &&
    (value.description === undefined || text(value.description, 500))
  )
}

function validCommerce(value: unknown): value is CommerceRules {
  if (!record(value)) return false
  return (
    integer(value.unit_amount_minor, 1) &&
    integer(value.max_amount_minor, 1) &&
    integer(value.max_slots, 1) &&
    integer(value.max_months, 1) &&
    (value.min_slots === undefined ||
      (integer(value.min_slots, 1) && value.min_slots <= value.max_slots)) &&
    (value.min_months === undefined ||
      (integer(value.min_months, 1) && value.min_months <= value.max_months)) &&
    (value.custom_enabled === undefined ||
      typeof value.custom_enabled === 'boolean') &&
    (value.custom_renewable === undefined ||
      typeof value.custom_renewable === 'boolean')
  )
}

/**
 * presentation 校验。`layout` 的内容只校验到「是对象」为止，具体取值交
 * normalizeLayout 逐字段兜底 —— 一个排版字段的取值错不该让整条草稿被丢弃。
 *
 * 顶层未知文案键仍整条拒绝，沿用既有协议强度，未在本次放宽。
 */
function validPresentation(value: unknown): value is Presentation {
  return (
    record(value) &&
    Object.entries(value).every(([key, content]) =>
      key === 'layout'
        ? content == null || record(content)
        : Object.prototype.hasOwnProperty.call(copyDefaults, key) &&
          text(content, key.includes('title') ? 120 : 500)
    )
  )
}

export function parseDraftMessage(data: unknown): DraftMessage | null {
  if (
    !record(data) ||
    data.type !== 'crag-preview:draft' ||
    !record(data.draft)
  )
    return null
  const { draft } = data
  if (
    !Array.isArray(draft.plans) ||
    draft.plans.length > 128 ||
    !draft.plans.every(validPlan) ||
    new Set(draft.plans.map((plan) => plan.sku)).size !== draft.plans.length ||
    (draft.commerce != null && !validCommerce(draft.commerce)) ||
    (draft.presentation != null && !validPresentation(draft.presentation)) ||
    (data.theme !== 'light' && data.theme !== 'dark') ||
    typeof data.edit !== 'boolean' ||
    (data.seq !== undefined && !integer(data.seq)) ||
    (data.selected != null && !text(data.selected, 128))
  )
    return null
  return data as DraftMessage
}

export function validOrigin(origin: string) {
  try {
    const url = new URL(origin)
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.origin === origin
    )
  } catch {
    return false
  }
}

export function ancestorOrigin(location: Location, referrer: string) {
  const ancestor = Array.from(location.ancestorOrigins ?? []).find(validOrigin)
  if (ancestor) return ancestor
  if (!referrer) return undefined
  try {
    const origin = new URL(referrer).origin
    return validOrigin(origin) ? origin : undefined
  } catch {
    return undefined
  }
}
