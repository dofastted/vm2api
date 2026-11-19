import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BadgeDollarSign, Gauge, SlidersHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { EmptyState } from '@/components/empty-state'
import { ModelVendorIcon } from '@/components/model-vendor-icon'
import { QueryGate } from '@/components/query-gate'
import { ANTIGRAVITY_REASONING_LEVELS } from '@/features/settings/antigravity-models'
import { routingQueryOptions } from '@/features/settings/queries'
import {
  AntigravityModelSync,
  type AntigravityModelCatalog,
} from '@/features/vm/antigravity-model-sync'
import { EditorRow, Fact, Metric, Panel } from './model-parts'
import { formatK } from './model-row'

type CatalogModel = AntigravityModelCatalog['models'][number] & {
  context_window?: number
  max_output_tokens?: number
}

const VENDORS: Record<string, string> = {
  google: 'Google',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
}

function catalogModels(value: unknown): CatalogModel[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item === 'string') return [{ id: item, enabled: true }]
    if (item && typeof item === 'object' && typeof item.id === 'string')
      return [item as CatalogModel]
    return []
  })
}

export function AntigravityCatalog({
  platformTabs,
}: {
  platformTabs: ReactNode
}) {
  const qc = useQueryClient()
  const routing = useQuery(routingQueryOptions())
  const [qtext, setQtext] = useState('')
  const [vendor, setVendor] = useState('all')
  const config = (routing.data?.antigravity || {}) as Record<string, unknown>
  const platformOn = config.enabled === true
  const models = catalogModels(config.models)
  const enabledCount = models.filter((m) => m.enabled !== false).length
  const vendors = [
    'all',
    ...new Set(models.map((m) => m.vendor).filter((v): v is string => !!v)),
  ]
  const needle = qtext.trim().toLowerCase()
  const visible = models.filter(
    (m) =>
      (vendor === 'all' || m.vendor === vendor) &&
      (!needle ||
        [m.id, m.display_name, m.vendor].some((v) =>
          v?.toLowerCase().includes(needle)
        ))
  )
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api('/api/panel/routing', {
        method: 'PUT',
        body: JSON.stringify({ antigravity: patch }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['panel', 'routing'] })
      void qc.invalidateQueries({ queryKey: ['panel', 'models'] })
      void qc.invalidateQueries({ queryKey: ['panel', 'vm'] })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const setEnabled = (pick: (model: CatalogModel) => boolean) =>
    save.mutate({
      models: models.map((m) => ({ ...m, enabled: pick(m) })),
    })

  return (
    <div className='space-y-4'>
      <section className='rounded-2xl border border-border/70 bg-card p-4 shadow-sm'>
        <div className='grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end'>
          <div className='min-w-0 space-y-3'>
            {platformTabs}
            <div className='max-w-3xl space-y-1'>
              <h3 className='text-xl font-semibold tracking-tight'>
                Antigravity 官方模型矩阵
              </h3>
              <p className='text-sm leading-6 text-muted-foreground'>
                Antigravity 号池。直接使用官方模型 ID；同名 Claude / GPT
                模型需使用 antigravity 分组密钥调用，推理强度通过请求参数选择。
              </p>
            </div>
            <div className='flex items-center gap-2'>
              <Switch
                id='agy-catalog-enabled'
                checked={platformOn}
                disabled={!routing.data || save.isPending}
                onCheckedChange={(on) => save.mutate({ enabled: on })}
              />
              <Label htmlFor='agy-catalog-enabled'>
                启用 Antigravity API 接入
              </Label>
            </div>
          </div>
          <div className='grid grid-cols-3 gap-2 lg:w-[21rem]'>
            <Stat label='配置' value={models.length} />
            <Stat label='启用' value={enabledCount} />
            <Stat label='对外' value={platformOn ? enabledCount : 0} />
          </div>
        </div>
      </section>

      <section className='rounded-2xl border border-border/70 bg-card p-4 shadow-sm'>
        <AntigravityModelSync />
      </section>

      <QueryGate loading={routing.isLoading} error={routing.error}>
        <section className='rounded-2xl border border-border/70 bg-card p-3 shadow-sm'>
          <div className='grid gap-2 lg:grid-cols-[18rem_minmax(0,1fr)_auto] lg:items-center'>
            <Input
              className='w-full'
              type='search'
              placeholder='搜索模型 / 供应商…'
              aria-label='搜索 Antigravity 模型'
              value={qtext}
              onChange={(e) => setQtext(e.target.value)}
            />
            <div className='flex flex-wrap gap-1.5'>
              {vendors.map((v) => (
                <Button
                  key={v}
                  size='sm'
                  className='cursor-pointer'
                  variant={vendor === v ? 'default' : 'outline'}
                  onClick={() => setVendor(v)}
                >
                  {v === 'all' ? '全部' : VENDORS[v] || v}
                </Button>
              ))}
            </div>
            <div className='flex flex-wrap gap-1.5 lg:justify-end'>
              <Button
                size='sm'
                variant='ghost'
                disabled={!models.length || save.isPending}
                onClick={() => setEnabled(() => true)}
              >
                全开
              </Button>
              <Button
                size='sm'
                variant='ghost'
                disabled={!models.length || save.isPending}
                onClick={() => setEnabled(() => false)}
              >
                全关
              </Button>
            </div>
          </div>
        </section>
        {visible.length ? (
          <div className='grid gap-3 md:grid-cols-2 xl:grid-cols-3'>
            {visible.map((m) => (
              <AntigravityModelCard
                key={m.id}
                model={m}
                platformOn={platformOn}
                saving={save.isPending}
                onSave={(next) =>
                  save.mutate(
                    {
                      models: models.map((row) =>
                        row.id === m.id ? next : row
                      ),
                    },
                    { onSuccess: () => toast.success('Antigravity 模型已保存') }
                  )
                }
                onToggle={(on) =>
                  setEnabled((row) =>
                    row.id === m.id ? on : row.enabled !== false
                  )
                }
              />
            ))}
          </div>
        ) : (
          <EmptyState
            reason={
              needle
                ? '无匹配模型。改搜索条件。'
                : '暂无模型。从已授权槽位同步账号模型，新模型会自动加入并启用。'
            }
          />
        )}
      </QueryGate>
    </div>
  )
}

// Mirrors the gateway: no requested effort picks medium, or the nearest available level.
function defaultLevel(levels: string[]) {
  const order = ANTIGRAVITY_REASONING_LEVELS as readonly string[]
  const target = order.indexOf('medium')
  return (
    [...levels].sort(
      (a, b) =>
        Math.abs(order.indexOf(a) - target) -
          Math.abs(order.indexOf(b) - target) ||
        order.indexOf(a) - order.indexOf(b)
    )[0] || null
  )
}

function AntigravityModelCard({
  model,
  platformOn,
  saving,
  onSave,
  onToggle,
}: {
  model: CatalogModel
  platformOn: boolean
  saving: boolean
  onSave: (next: CatalogModel) => void
  onToggle: (on: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(model)
  const on = model.enabled !== false
  const live = on && platformOn
  const name = model.display_name || model.id
  const levels = model.levels || []
  const fallback = defaultLevel(levels)
  const draftLevels = draft.levels || []
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setDraft(model)
        setOpen(next)
      }}
    >
      <div
        className={cn(
          'group rounded-xl border border-border/70 bg-card p-3 text-sm shadow-sm transition-[border-color,box-shadow,transform,background-color] duration-200 hover:-translate-y-0.5 hover:border-primary/35 hover:bg-muted/15 hover:shadow-md',
          !on && 'opacity-65'
        )}
      >
        <div
          role='button'
          tabIndex={0}
          className='grid gap-3 outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:grid-cols-[minmax(0,1fr)_auto]'
          onClick={() => {
            setDraft(model)
            setOpen(true)
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            setDraft(model)
            setOpen(true)
          }}
        >
          <div className='min-w-0 space-y-3'>
            <div className='flex items-start gap-3'>
              <div className='mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-muted/70 ring-1 ring-border/60'>
                <ModelVendorIcon modelId={model.id} className='size-5' />
              </div>
              <div className='min-w-0 flex-1'>
                <div className='flex flex-wrap items-center gap-2'>
                  <h3 className='truncate text-base font-semibold tracking-tight'>
                    {name}
                  </h3>
                  <Badge variant={live ? 'default' : 'secondary'}>
                    {live ? '对外' : '隐藏'}
                  </Badge>
                  {on ? null : <Badge variant='outline'>停用</Badge>}
                </div>
                <p className='mt-1 truncate font-mono text-[11px] text-muted-foreground'>
                  {model.id}
                </p>
                <div className='mt-1.5 flex flex-wrap items-center gap-1.5'>
                  <span className='text-xs'>账号订阅计费</span>
                  <Badge variant='secondary'>antigravity</Badge>
                </div>
              </div>
            </div>

            <div className='grid gap-2 text-xs sm:grid-cols-3'>
              <Metric
                label='上下文'
                value={
                  model.context_window ? formatK(model.context_window) : '—'
                }
                strong
              />
              <Metric
                label='输出上限'
                value={
                  model.max_output_tokens
                    ? formatK(model.max_output_tokens)
                    : '—'
                }
              />
              <Metric
                label='Thinking'
                value={levels.length ? `${levels.join('/')}` : '不支持'}
              />
            </div>

            <div className='flex flex-wrap gap-1.5'>
              {model.vendor ? (
                <Badge variant='outline'>
                  {VENDORS[model.vendor] || model.vendor}
                </Badge>
              ) : null}
              {fallback ? (
                <Badge variant='outline' className='font-mono'>
                  默认 {fallback}
                </Badge>
              ) : (
                <span className='text-xs text-muted-foreground'>
                  不支持推理强度参数
                </span>
              )}
            </div>
          </div>

          <div className='flex items-center justify-between gap-3 sm:w-32 sm:flex-col sm:items-end'>
            <div
              className='flex items-center gap-2 rounded-lg border border-border/60 bg-background/70 px-2 py-1.5'
              onClick={(event) => event.stopPropagation()}
            >
              <Checkbox
                checked={on}
                disabled={saving}
                onCheckedChange={(value) => onToggle(value === true)}
                aria-label={`启用 ${name}`}
              />
              <span className='text-xs text-muted-foreground'>启用</span>
            </div>
            <Button size='sm' variant='outline' className='gap-1.5'>
              <SlidersHorizontal className='size-3.5' />
              配置
            </Button>
          </div>
        </div>
      </div>

      <DialogContent className='max-h-[min(92svh,760px)] overflow-y-auto sm:max-w-3xl'>
        <DialogHeader className='gap-3'>
          <div className='flex items-start gap-3'>
            <div className='grid size-11 shrink-0 place-items-center rounded-xl bg-muted ring-1 ring-border/70'>
              <ModelVendorIcon modelId={model.id} className='size-6' />
            </div>
            <div className='min-w-0'>
              <DialogTitle className='truncate text-xl'>{name}</DialogTitle>
              <DialogDescription className='font-mono text-xs break-all'>
                {model.id}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className='grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]'>
          <section className='space-y-4'>
            <Panel
              title='模型覆写'
              icon={<SlidersHorizontal className='size-4' />}
            >
              <EditorRow label='对外启用'>
                <div className='flex items-center gap-2'>
                  <Checkbox
                    checked={draft.enabled !== false}
                    onCheckedChange={(value) =>
                      setDraft({ ...draft, enabled: value === true })
                    }
                    aria-label='对外启用'
                  />
                  <span className='text-xs text-muted-foreground'>
                    关闭后仍保留配置，但不进入公开模型目录。
                  </span>
                </div>
              </EditorRow>
              <EditorRow label='显示名称'>
                <Input
                  className='h-8 w-full sm:w-[260px]'
                  value={draft.display_name || ''}
                  placeholder={model.id}
                  onChange={(event) =>
                    setDraft({ ...draft, display_name: event.target.value })
                  }
                />
              </EditorRow>
              <EditorRow label='供应商'>
                <Select
                  value={draft.vendor || 'none'}
                  onValueChange={(value) =>
                    setDraft({
                      ...draft,
                      vendor: value === 'none' ? null : value,
                    })
                  }
                >
                  <SelectTrigger className='h-8 w-full sm:w-[220px]'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(VENDORS).map(([id, label]) => (
                      <SelectItem key={id} value={id}>
                        {label}
                      </SelectItem>
                    ))}
                    <SelectItem value='none'>未指定</SelectItem>
                  </SelectContent>
                </Select>
              </EditorRow>
              {(
                [
                  ['context_window', '上下文窗口'],
                  ['max_output_tokens', '输出上限'],
                ] as const
              ).map(([field, label]) => (
                <EditorRow key={field} label={label}>
                  <Input
                    className='field-count h-8 w-full sm:w-[150px]'
                    type='number'
                    min={0}
                    value={draft[field] || ''}
                    placeholder='未设置'
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        [field]:
                          Math.floor(Number(event.target.value)) || undefined,
                      })
                    }
                  />
                  <span className='text-xs text-muted-foreground'>token</span>
                </EditorRow>
              ))}
              <p className='text-xs text-muted-foreground'>
                同步账号模型时从 models.dev 自动填入，已设置的值不会被覆盖。
              </p>
            </Panel>

            <Panel title='推理强度' icon={<Gauge className='size-4' />}>
              <EditorRow label='可用档位'>
                <div className='flex flex-wrap gap-3'>
                  {ANTIGRAVITY_REASONING_LEVELS.map((level) => (
                    <div key={level} className='flex items-center gap-1'>
                      <Checkbox
                        id={`agy-card-${model.id}-${level}`}
                        checked={draftLevels.includes(level)}
                        onCheckedChange={(checked) =>
                          setDraft({
                            ...draft,
                            levels: ANTIGRAVITY_REASONING_LEVELS.filter(
                              (item) =>
                                item === level
                                  ? checked === true
                                  : draftLevels.includes(item)
                            ),
                          })
                        }
                      />
                      <Label
                        htmlFor={`agy-card-${model.id}-${level}`}
                        className='text-xs font-normal'
                      >
                        {level}
                      </Label>
                    </div>
                  ))}
                </div>
              </EditorRow>
              <p className='text-xs text-muted-foreground'>
                请求通过 reasoning_effort、reasoning.effort 或
                output_config.effort
                选择档位；未传时使用默认档位，传入未勾选的档位返回 400。
              </p>
            </Panel>
          </section>

          <aside className='space-y-4'>
            <Panel
              title='价格 / 计费'
              icon={<BadgeDollarSign className='size-4' />}
              compact
            >
              <Fact label='来源' value='Antigravity 账号订阅' />
              <Fact label='官方 API 价' value='不套用' />
              <Fact label='用量记录' value={`antigravity/${model.id}`} mono />
            </Panel>

            <Panel title='能力' icon={<Gauge className='size-4' />} compact>
              <Fact
                label='上下文'
                value={
                  model.context_window
                    ? model.context_window.toLocaleString()
                    : '—'
                }
              />
              <Fact
                label='输出上限'
                value={
                  model.max_output_tokens
                    ? model.max_output_tokens.toLocaleString()
                    : '—'
                }
              />
              <Fact label='默认档位' value={fallback || '—'} />
              <Fact label='协议' value='Messages / Chat / Responses' />
              <Fact
                label='调用'
                value={
                  model.id.startsWith('gemini-')
                    ? '任意密钥'
                    : 'antigravity 分组密钥'
                }
              />
              <Fact label='目录状态' value={live ? '对外可见' : '未进入目录'} />
            </Panel>
          </aside>
        </div>

        <DialogFooter className='items-center gap-2 sm:justify-between'>
          <p className='text-xs text-muted-foreground'>
            保存后立即写入全局 Antigravity 目录。
          </p>
          <div className='flex gap-2'>
            <DialogClose asChild>
              <Button type='button' variant='outline'>
                取消
              </Button>
            </DialogClose>
            <Button
              type='button'
              disabled={saving}
              loading={saving}
              onClick={() => {
                onSave({
                  ...draft,
                  display_name: draft.display_name?.trim() || model.id,
                })
                setOpen(false)
              }}
            >
              保存
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className='rounded-xl border border-border/70 bg-background/60 px-3 py-2'>
      <div className='text-[11px] font-medium tracking-wide text-muted-foreground'>
        {label}
      </div>
      <div className='field-count mt-1 text-lg font-semibold'>{value}</div>
    </div>
  )
}
