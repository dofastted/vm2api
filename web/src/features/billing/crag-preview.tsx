import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Eye, EyeOff, Info, ReceiptText } from 'lucide-react'
import {
  copyDefaults,
  copyLabels,
  formatPlanDetails,
  monthlyFor,
  termLabel,
  type CopyKey,
  type DraftPlan,
} from './crag-catalog'
import {
  FEATURED_LABEL_MAX,
  densityClass,
  featuredFallback,
  join,
  normalizeLayout,
  ordersSideClass,
  pickerColumnClass,
} from './crag-layout'
import {
  CommercePlanContent,
  CommerceRulesSummary,
  PickerPlanContent,
} from './crag-plan-content'
import { PreviewField } from './crag-preview-field'
import {
  ancestorOrigin,
  parseDraftMessage,
  validOrigin,
  type DraftMessage,
  type PreviewDraft,
  type PreviewEdit,
} from './crag-preview-protocol'

export function CragPreviewPage() {
  const [message, setMessage] = useState<DraftMessage | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const parentOrigin = useRef<string | undefined>(undefined)
  const parentSource = useRef<Window | null>(null)
  const latestSeq = useRef<number | undefined>(undefined)

  useEffect(() => {
    const root = document.documentElement
    const originalThemes = ['light', 'dark'].filter((theme) =>
      root.classList.contains(theme)
    )
    const expectedOrigin = ancestorOrigin(window.location, document.referrer)
    function onMessage(event: MessageEvent) {
      if (
        window.parent === window ||
        event.source !== window.parent ||
        (parentSource.current && event.source !== parentSource.current) ||
        !validOrigin(event.origin)
      )
        return
      if (
        (expectedOrigin && event.origin !== expectedOrigin) ||
        (parentOrigin.current && event.origin !== parentOrigin.current)
      )
        return
      const incoming = parseDraftMessage(event.data)
      if (
        !incoming ||
        (latestSeq.current !== undefined &&
          (incoming.seq === undefined || incoming.seq <= latestSeq.current))
      )
        return
      parentOrigin.current = event.origin
      parentSource.current = event.source as Window
      latestSeq.current = incoming.seq
      setMessage(incoming)
      setSelected(incoming.selected ?? null)
    }
    window.addEventListener('message', onMessage)
    if (window.parent !== window)
      window.parent.postMessage(
        { type: 'crag-preview:ready', caps: ['layout-1'] },
        '*'
      )
    return () => {
      window.removeEventListener('message', onMessage)
      root.classList.remove('light', 'dark')
      root.classList.add(...originalThemes)
    }
  }, [])

  useLayoutEffect(() => {
    if (!message || !parentOrigin.current || !parentSource.current) return
    document.documentElement.classList.remove('light', 'dark')
    document.documentElement.classList.add(message.theme)
    parentSource.current.postMessage(
      { type: 'crag-preview:applied', seq: message.seq },
      parentOrigin.current
    )
  }, [message])

  function send(data: object) {
    if (parentOrigin.current && parentSource.current)
      parentSource.current.postMessage(data, parentOrigin.current)
  }

  if (!message)
    return (
      <main className='grid min-h-svh place-items-center p-6 text-sm text-muted-foreground'>
        等待后台推送草稿…
      </main>
    )

  return (
    <PreviewCanvas
      draft={message.draft}
      selected={selected}
      edit={message.edit}
      onPick={(sku) => {
        setSelected(sku)
        send({ type: 'crag-preview:select', sku })
      }}
      onFocus={(sku) =>
        send({ type: 'crag-preview:focus', sku, field: 'price' })
      }
      onEdit={(change) => {
        if (message.edit) send({ type: 'crag-preview:edit', ...change })
      }}
    />
  )
}

export function PreviewCanvas({
  draft,
  selected,
  edit = false,
  onPick,
  onFocus,
  onEdit,
}: {
  draft: PreviewDraft
  selected: string | null
  edit?: boolean
  onPick: (sku: string) => void
  onFocus?: (sku: string) => void
  onEdit?: (change: PreviewEdit) => void
}) {
  const presentation = draft.presentation ?? {}
  const commerce = draft.commerce
  const plans = draft.plans.filter((plan) => plan.enabled !== false)
  const hiddenPlan = draft.plans.find(
    (plan) => plan.sku === selected && plan.enabled === false
  )
  const customEnabled = !!commerce && commerce.custom_enabled !== false
  const empty = !plans.length && !customEnabled

  // 纯函数，不包 useMemo：本文件的测试用手搓的 react mock 按调用顺序分配
  // useState/useRef/useEffect 游标，这里新增任何 hook 都会让既有断言错位。
  const layout = normalizeLayout(presentation.layout)
  const density = layout.cardDensity
  const space = densityClass[density]
  const featuredSku =
    layout.featuredSku && plans.some((plan) => plan.sku === layout.featuredSku)
      ? layout.featuredSku
      : null
  // 与正式买家页走同一张表、同一套缺省语义，这样父页未开布局时画布与真实
  // 买家页也一致（本页原先恒单列、恒旁置，与买家页默认并不相符）。
  const planGrid = join(
    'grid',
    space.grid,
    pickerColumnClass[layout.planColumns]
  )
  const ordersSide = layout.ordersPosition === 'side'

  function copy(key: CopyKey) {
    const maxLength = key.includes('title') ? 120 : 500
    return (
      <PreviewField
        key={key}
        label={copyLabels[key]}
        value={presentation[key] ?? ''}
        fallback={copyDefaults[key]}
        editable={edit}
        maxLength={maxLength}
        multiline={maxLength === 500}
        onSave={(value) => onEdit?.({ target: 'copy', key, value })}
      />
    )
  }

  function card(plan: DraftPlan) {
    const displayPlan = {
      ...plan,
      amount_minor:
        plan.amount_minor != null && plan.amount_minor > 0
          ? plan.amount_minor
          : null,
      slot_limit:
        plan.slot_limit === 'unlimited' ||
        (plan.slot_limit != null && plan.slot_limit > 0)
          ? plan.slot_limit
          : null,
    }
    const details = formatPlanDetails(
      displayPlan.amount_minor,
      displayPlan.slot_limit
    )
    const option = {
      ...plan,
      ...details,
      term: termLabel(plan.term, plan.sku, plan.months),
    }
    const monthly = monthlyFor(
      layout,
      displayPlan.amount_minor,
      plan.term,
      plan.months
    )
    // 推荐角标是布局在画布上唯一有自然落点的可视元素，故只让它内联可编辑；
    // 列数 / 密度 / 订单区位置 / featured_sku 仍由父页属性栏负责。
    // 回传走 edit 通道的 target:'layout'，不是 crag-preview:layout —— 父页那条
    // 通道只认 plan_columns / orders_position / featured_sku，别的 key 会被丢弃。
    const featured =
      plan.sku === featuredSku ? (
        edit ? (
          <PreviewField
            label='推荐角标'
            value={layout.featuredLabel ?? ''}
            fallback={featuredFallback}
            editable
            maxLength={FEATURED_LABEL_MAX}
            onSave={(value) =>
              onEdit?.({ target: 'layout', key: 'featured_label', value })
            }
          />
        ) : (
          (layout.featuredLabel ?? featuredFallback)
        )
      ) : undefined
    const slots = edit
      ? {
          name: (
            <PreviewField
              label='套餐名称'
              value={plan.name ?? ''}
              fallback={option.term}
              editable
              maxLength={120}
              onSave={(value) =>
                onEdit?.({
                  target: 'plan',
                  sku: plan.sku,
                  field: 'name',
                  value,
                })
              }
            />
          ),
          description: (
            <span className='block text-[13px] leading-5 text-muted-foreground'>
              <PreviewField
                label='套餐说明'
                value={plan.description ?? ''}
                fallback='添加套餐说明'
                placeholder
                editable
                multiline
                maxLength={500}
                onSave={(value) =>
                  onEdit?.({
                    target: 'plan',
                    sku: plan.sku,
                    field: 'description',
                    value,
                  })
                }
              />
            </span>
          ),
          price: (
            <button
              type='button'
              aria-label='编辑价格'
              title='在属性栏修改售价'
              className='cursor-pointer rounded-sm decoration-primary/60 decoration-dashed underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-ring'
              onClick={(event) => {
                event.stopPropagation()
                onFocus?.(plan.sku)
              }}
            >
              {details.price}
            </button>
          ),
        }
      : undefined
    return (
      <div
        key={plan.sku}
        data-sku={plan.sku}
        data-active={selected === plan.sku || undefined}
        onClick={() => {
          if (edit || plan.remaining !== 0) onPick(plan.sku)
        }}
        className={`${commerce ? 'flex items-start gap-3 text-sm' : join('grid', space.minHeight, 'min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3')} cursor-pointer rounded-xl border bg-card ${space.card} text-card-foreground shadow-xs transition-colors hover:border-primary/50 ${selected === plan.sku ? 'border-primary bg-primary/5 ring-2 ring-primary/20' : ''}`}
        data-density={density}
        data-featured={plan.sku === featuredSku || undefined}
      >
        <input
          type='radio'
          name='preview-plan'
          aria-label={`选择${plan.name || option.term}`}
          checked={selected === plan.sku}
          disabled={!edit && plan.remaining === 0}
          onChange={() => onPick(plan.sku)}
          onClick={(event) => event.stopPropagation()}
          className='mt-1 size-4 shrink-0 accent-primary'
        />
        {commerce ? (
          <CommercePlanContent
            plan={displayPlan}
            slots={slots}
            density={density}
            featured={featured}
            monthly={monthly}
          />
        ) : (
          <PickerPlanContent
            plan={option}
            slots={slots}
            density={density}
            featured={featured}
            monthly={monthly}
            duplicateTerm={
              plans.filter(
                (candidate) =>
                  termLabel(candidate.term, candidate.sku, candidate.months) ===
                  option.term
              ).length > 1
            }
          />
        )}
      </div>
    )
  }

  return (
    <main className='min-h-svh bg-muted/40 text-foreground'>
      <div className='mx-auto max-w-5xl px-4 py-5 sm:px-6 sm:py-8'>
        <div
          role='note'
          className='mb-6 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-900 dark:text-amber-100'
        >
          <Eye className='mt-0.5 size-3.5 shrink-0' aria-hidden />
          <span>
            未发布草稿 · 仅预览，不可购买；库存为草稿配置，不是实时余量。
          </span>
        </div>
        <header className='mb-6'>
          <h2 className='text-2xl font-bold tracking-tight sm:text-3xl'>
            {copy('title')}
          </h2>
          <p className='mt-2 max-w-prose text-sm leading-6 text-muted-foreground'>
            {copy('description')}
          </p>
        </header>
        <div
          className={`grid min-w-0 items-start gap-5 ${ordersSide ? ordersSideClass : ''}`}
        >
          <section className='min-w-0 space-y-4 rounded-2xl border bg-card p-4 text-card-foreground shadow-sm sm:p-5'>
            <div className='flex items-center justify-between gap-3'>
              <h2 className='min-w-0 flex-1 text-base leading-6 font-semibold'>
                {copy('plans_title')}
              </h2>
              {plans.length ? (
                <span className='shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs leading-5 text-muted-foreground tabular-nums'>
                  {plans.length} 个套餐
                </span>
              ) : null}
            </div>
            {empty ? (
              <p className='rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground'>
                {copy('empty_plans_text')}
              </p>
            ) : null}
            {commerce ? (
              <CommerceRulesSummary rules={commerce} />
            ) : edit ? (
              <p className='flex items-center gap-1.5 text-xs text-muted-foreground'>
                <Info className='size-3.5 shrink-0' aria-hidden />
                自定义计价未启用或规则未完整。
              </p>
            ) : null}
            <div className={planGrid}>{plans.map(card)}</div>
            {customEnabled ? (
              <label className='flex cursor-pointer items-start gap-3 rounded-xl border bg-card p-4 text-sm shadow-xs transition-colors hover:border-primary/50 has-checked:border-primary has-checked:bg-primary/5 has-checked:ring-2 has-checked:ring-primary/20'>
                <input
                  type='radio'
                  name='preview-plan'
                  aria-label='选择自定义套餐'
                  checked={selected === 'custom'}
                  onChange={() => onPick('custom')}
                  className='mt-1 size-4 accent-primary'
                />
                <span className='grid gap-1'>
                  <span className='text-[15px] font-semibold'>
                    {copy('custom_title')}
                  </span>
                  <span className='text-[13px] text-muted-foreground'>
                    {commerce.min_slots ?? 1}–{commerce.max_slots} 槽位 ·{' '}
                    {commerce.min_months ?? 1}–{commerce.max_months} 个月
                  </span>
                </span>
              </label>
            ) : null}
            {edit && hiddenPlan ? (
              <section
                aria-label='下架套餐编辑区'
                className='space-y-3 rounded-xl border border-dashed bg-muted/40 p-3'
              >
                <h3 className='flex items-center gap-1.5 text-xs font-medium text-muted-foreground'>
                  <EyeOff className='size-3.5' aria-hidden />
                  已下架 · 仅编辑展示，不出现在买家页
                </h3>
                {card(hiddenPlan)}
              </section>
            ) : null}
          </section>
          <section className='min-w-0 space-y-4 rounded-2xl border bg-card p-4 text-card-foreground shadow-sm sm:p-5'>
            <h2 className='text-base font-semibold'>{copy('orders_title')}</h2>
            <div className='flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-7 text-center'>
              <ReceiptText
                className='size-6 text-muted-foreground/70'
                aria-hidden
              />
              <p className='max-w-xs text-sm leading-6 text-muted-foreground'>
                {copy('empty_orders_text')}
              </p>
            </div>
            <section
              aria-label='状态文案预览'
              className='space-y-2 border-t pt-4 text-sm leading-6 text-muted-foreground'
            >
              <h3 className='text-xs font-semibold text-foreground/70'>
                状态文案预览 · 不代表实际收款状态
              </h3>
              <p>{copy('unavailable_text')}</p>
              {edit && !empty ? <p>{copy('empty_plans_text')}</p> : null}
              {edit && !customEnabled ? <p>{copy('custom_title')}</p> : null}
            </section>
          </section>
        </div>
      </div>
    </main>
  )
}
