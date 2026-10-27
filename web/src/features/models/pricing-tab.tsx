import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PricingEntry } from '@/types/panel-pricing'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtAgo, fmtNum } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { EmptyState } from '@/components/empty-state'
import { QueryGate } from '@/components/query-gate'
import {
  fmtBaseRates,
  fmtImageRates,
  fmtPerM,
  modeKeys,
  openaiServiceModes,
  priceSourceLabel,
  priceSourceVariant,
  tiersSummary,
} from '@/features/models/price-display'
import { PriceOverrideDialog } from '@/features/models/price-override-dialog'
import {
  invalidatePricing,
  pricingQueryOptions,
} from '@/features/models/queries'
import { RepriceDialog } from '@/features/models/reprice-dialog'
import { type ModelsDevSyncResult, modelsDevSyncOutcome } from './page-messages'

function modelsDevCopy(status: {
  fetched_at: string | null
  status: 'ok' | 'error' | 'never'
  error: string | null
  models: number
}): { title: string; detail: string } {
  if (status.status === 'never') {
    return { title: '从未同步', detail: '尚未拉过 models.dev，计价走内置表。' }
  }
  const when = status.fetched_at
    ? fmtAgo(status.fetched_at) || status.fetched_at
    : '未知时间'
  if (status.status === 'ok') {
    return {
      title: `已同步 · ${when}`,
      detail: `${fmtNum(status.models)} 个模型`,
    }
  }
  return {
    title: `失败 · ${when}`,
    detail: status.error || '拉取失败，保留上一份快照。',
  }
}

function DiffMark({ entry }: { entry: PricingEntry }) {
  if (!entry.diff) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant='outline' className='cursor-default font-mono'>
          差异
        </Badge>
      </TooltipTrigger>
      <TooltipContent className='max-w-xs space-y-1'>
        <p>内置 {fmtBaseRates(entry.builtin)}</p>
        <p>models.dev {fmtBaseRates(entry.models_dev)}</p>
      </TooltipContent>
    </Tooltip>
  )
}

function RateCell({ value }: { value: number | null | undefined }) {
  return (
    <TableCell className='text-end font-mono text-xs tabular-nums'>
      {fmtPerM(value)}
    </TableCell>
  )
}

function CatalogTable({
  title,
  rows,
  openai = false,
  onEdit,
}: {
  title: string
  rows: PricingEntry[]
  /** OpenAI terms: cached input, one cache-write rate, service tiers, image tokens. */
  openai?: boolean
  onEdit: (entry: PricingEntry) => void
}) {
  const [inPolicyOnly, setInPolicyOnly] = useState(true)
  const visible = inPolicyOnly ? rows.filter((r) => r.in_policy) : rows
  return (
    <section className='space-y-3 rounded-2xl border border-border/70 bg-card p-4 shadow-sm'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div>
          <h3 className='text-lg font-semibold tracking-tight'>{title}</h3>
          <p className='text-xs text-muted-foreground'>
            {inPolicyOnly
              ? `策略内 ${visible.length} / 目录 ${rows.length}`
              : `全部 ${visible.length}`}
          </p>
        </div>
        <label className='flex items-center gap-2 text-sm'>
          <Switch checked={inPolicyOnly} onCheckedChange={setInPolicyOnly} />
          仅策略内
        </label>
      </div>
      {visible.length === 0 ? (
        <EmptyState reason='没有符合筛选的模型。' />
      ) : (
        <Table density='compact'>
          <TableHeader>
            <TableRow>
              <TableHead>id</TableHead>
              <TableHead>名称</TableHead>
              {openai ? (
                <>
                  <TableHead className='text-end'>input</TableHead>
                  <TableHead className='text-end'>cached input</TableHead>
                  <TableHead className='text-end'>output</TableHead>
                  <TableHead className='text-end'>cache write</TableHead>
                  <TableHead>长上下文</TableHead>
                  <TableHead>服务档位</TableHead>
                  <TableHead>图像 token</TableHead>
                </>
              ) : (
                <>
                  <TableHead className='text-end'>input</TableHead>
                  <TableHead className='text-end'>output</TableHead>
                  <TableHead className='text-end'>cache read</TableHead>
                  <TableHead className='text-end'>5m write</TableHead>
                  <TableHead className='text-end'>1h write</TableHead>
                  <TableHead>档位</TableHead>
                  <TableHead>modes</TableHead>
                </>
              )}
              <TableHead>来源</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((row) => {
              const price = row.effective
              return (
                <TableRow
                  key={`${row.platform}/${row.id}`}
                  className='cursor-pointer'
                  onClick={() => onEdit(row)}
                >
                  <TableCell className='font-mono text-xs'>{row.id}</TableCell>
                  <TableCell className='max-w-[10rem] truncate'>
                    {row.name || '—'}
                  </TableCell>
                  {openai ? (
                    <>
                      <RateCell value={price?.input} />
                      <RateCell value={price?.cache_read} />
                      <RateCell value={price?.output} />
                      <RateCell value={price?.cache_5m} />
                      <TableCell className='text-xs'>
                        {tiersSummary(price)}
                      </TableCell>
                      <TableCell className='font-mono text-xs'>
                        {openaiServiceModes(price).join(' / ') || '—'}
                      </TableCell>
                      <TableCell className='font-mono text-xs tabular-nums'>
                        {fmtImageRates(price)}
                      </TableCell>
                    </>
                  ) : (
                    <>
                      <RateCell value={price?.input} />
                      <RateCell value={price?.output} />
                      <RateCell value={price?.cache_read} />
                      <RateCell value={price?.cache_5m} />
                      <RateCell value={price?.cache_1h} />
                      <TableCell className='text-xs'>
                        {tiersSummary(price)}
                      </TableCell>
                      <TableCell>
                        <div className='flex flex-wrap gap-1'>
                          {modeKeys(price).map((mode) => (
                            <Badge
                              key={mode}
                              variant='outline'
                              className='font-mono'
                              title={
                                row.mode_sources[mode]
                                  ? `${mode} · ${priceSourceLabel(row.mode_sources[mode])}`
                                  : mode
                              }
                            >
                              {mode}
                            </Badge>
                          ))}
                          {modeKeys(price).length === 0 ? (
                            <span className='text-xs text-muted-foreground'>
                              —
                            </span>
                          ) : null}
                        </div>
                      </TableCell>
                    </>
                  )}
                  <TableCell>
                    <div className='flex flex-wrap items-center gap-1'>
                      <Badge variant={priceSourceVariant(row.source)}>
                        {priceSourceLabel(row.source)}
                      </Badge>
                      <DiffMark entry={row} />
                    </div>
                  </TableCell>
                  <TableCell>
                    <Button
                      size='sm'
                      variant='ghost'
                      onClick={(e) => {
                        e.stopPropagation()
                        onEdit(row)
                      }}
                    >
                      覆盖
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </section>
  )
}

export function PricingTab() {
  const qc = useQueryClient()
  const q = useQuery(pricingQueryOptions())
  const [edit, setEdit] = useState<PricingEntry | null>(null)
  const [repriceOpen, setRepriceOpen] = useState(false)

  const sync = useMutation({
    mutationFn: () =>
      api<ModelsDevSyncResult>('/api/panel/pricing/sync', {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: async (data) => {
      const out = modelsDevSyncOutcome(data)
      if (out.ok) toast.success(out.text)
      else toast.error(out.text)
      await invalidatePricing(qc)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const grouped = useMemo(() => {
    const models = q.data?.models || []
    return {
      anthropic: models.filter((m) => m.platform === 'anthropic'),
      openai: models.filter((m) => m.platform === 'openai'),
    }
  }, [q.data?.models])

  const modelsDev = q.data?.models_dev
  const md = modelsDev ? modelsDevCopy(modelsDev) : null
  const unpriced = q.data?.unpriced || []

  return (
    <QueryGate loading={q.isLoading} error={q.error}>
      <div className='space-y-4'>
        <section className='grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]'>
          <div className='rounded-2xl border border-border/70 bg-card p-4 shadow-sm'>
            <div className='flex flex-wrap items-start justify-between gap-3'>
              <div className='space-y-1'>
                <h3 className='font-semibold'>models.dev</h3>
                <p className='text-sm text-muted-foreground'>
                  {md ? `${md.title} · ${md.detail}` : '—'}
                </p>
                {modelsDev?.status === 'error' && modelsDev.error ? (
                  <p className='text-xs text-[color:var(--status-warn)]'>
                    {modelsDev.error}
                  </p>
                ) : null}
              </div>
              <Button
                variant='outline'
                className='cursor-pointer'
                disabled={sync.isPending}
                onClick={() => sync.mutate()}
              >
                {sync.isPending ? '同步中…' : '同步 models.dev'}
              </Button>
            </div>
          </div>
          <div className='flex items-center rounded-2xl border border-border/70 bg-card p-4 shadow-sm'>
            <Button
              variant='outline'
              className='cursor-pointer'
              onClick={() => setRepriceOpen(true)}
            >
              按当前价重算
            </Button>
          </div>
        </section>

        {unpriced.length ? (
          <section className='rounded-2xl border border-[color:var(--status-caution)]/40 bg-card p-4 shadow-sm'>
            <h3 className='font-semibold'>未定价模型</h3>
            <p className='mt-1 text-xs text-muted-foreground'>
              窗口估算遇到这些请求会标 unpriced，不出总量。
            </p>
            <ul className='mt-3 space-y-1.5 text-sm'>
              {unpriced.map((row) => (
                <li
                  key={row.model}
                  className='flex flex-wrap items-baseline justify-between gap-2 font-mono text-xs'
                >
                  <span>{row.model || '（空）'}</span>
                  <span className='text-muted-foreground'>
                    {fmtNum(row.requests)} 次
                    {row.last_seen
                      ? ` · ${fmtAgo(row.last_seen) || row.last_seen}`
                      : ''}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <CatalogTable
          title='Anthropic'
          rows={grouped.anthropic}
          onEdit={setEdit}
        />
        <CatalogTable
          title='OpenAI'
          rows={grouped.openai}
          openai
          onEdit={setEdit}
        />
      </div>

      <PriceOverrideDialog
        entry={edit}
        open={Boolean(edit)}
        onOpenChange={(next) => {
          if (!next) setEdit(null)
        }}
      />
      <RepriceDialog open={repriceOpen} onOpenChange={setRepriceOpen} />
    </QueryGate>
  )
}
