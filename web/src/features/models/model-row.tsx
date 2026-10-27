import type { PolicyPrice } from '@/types/panel-pricing'
import { BadgeDollarSign, Gauge, SlidersHorizontal } from 'lucide-react'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { ModelVendorIcon } from '@/components/model-vendor-icon'
import { EditorRow, Fact, Metric, Panel } from './model-parts'
import {
  OpenaiCapabilityFacts,
  OpenaiCardMetrics,
  OpenaiPriceFacts,
} from './openai-model-parts'
import {
  type ModelEntry,
  type ModelParams,
  type ModelPolicy,
  type Pass1mMode,
  catalogFacts,
  contextWindowLabel,
  passContext1mEffective,
  passContext1mMode,
  thinkingPolicyLabel,
} from './policy'
import {
  fmtBaseRates,
  fmtOpenaiRates,
  fmtPerM,
  priceSourceLabel,
  priceSourceVariant,
} from './price-display'

type Props = {
  model: ModelEntry
  live: boolean
  pol: ModelPolicy
  pricing?: PolicyPrice | null
  open: boolean
  platform: 'anthropic' | 'openai'
  onToggleOpen: () => void
  onToggleEnabled: (on: boolean) => void
  onModel: (fn: (rec: Omit<ModelEntry, 'id'>) => void) => void
  onParam: (key: keyof ModelParams, value: string | number) => void
  onPass1m: (mode: Pass1mMode) => void
}

export function ModelRow({
  model,
  live,
  pol,
  pricing,
  open,
  platform,
  onToggleOpen,
  onToggleEnabled,
  onModel,
  onParam,
  onPass1m,
}: Props) {
  const on = model.enabled !== false
  const win = contextWindowLabel(model)
  const caps = model.capabilities || {}
  const params = model.params || {}
  const defs = pol.defaults || {}
  const mode = passContext1mMode(model)
  const effective = passContext1mEffective(model, pol)
  const inheritHit = mode === 'inherit' && effective
  const drop = (model.betas?.drop || []).join(', ') || '—'
  const onEnabled =
    params.on_enabled === 'convert_to_adaptive'
      ? 'passthrough'
      : params.on_enabled || 'passthrough'
  const fallback =
    params.thinking_fallback_budget != null
      ? params.thinking_fallback_budget
      : defs.thinking_fallback_budget || 4096
  const displayName = model.display_name || model.id
  const price = pricing?.effective ?? null
  const priceSource = pricing?.source ?? null
  // GPT rows show upstream catalog facts; Claude thinking / max_tokens / 1M knobs do not apply.
  const claude = platform === 'anthropic'
  const facts = claude ? null : catalogFacts(model)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next !== open) onToggleOpen()
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
          onClick={onToggleOpen}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            onToggleOpen()
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
                    {displayName}
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
                  <span className='font-mono text-xs tabular-nums'>
                    {claude ? fmtBaseRates(price) : fmtOpenaiRates(price)}
                  </span>
                  <span className='text-[10px] text-muted-foreground'>
                    每 1M
                  </span>
                  <Badge variant={priceSourceVariant(priceSource)}>
                    {priceSourceLabel(priceSource)}
                  </Badge>
                </div>
              </div>
            </div>

            {facts ? (
              <OpenaiCardMetrics facts={facts} />
            ) : (
              <div className='grid gap-2 text-xs sm:grid-cols-3'>
                <Metric label='上下文' value={win.text} strong />
                <Metric
                  label='输出上限'
                  value={`${formatK(params.max_tokens_cap ?? 64000)}`}
                />
                <Metric label='Thinking' value={thinkingPolicyLabel(model)} />
                <Metric
                  label='缺省 effort'
                  value={
                    caps.supports_effort
                      ? params.default_effort === 'off'
                        ? '不补'
                        : params.default_effort || 'high'
                      : '上游不接受'
                  }
                />
              </div>
            )}

            {claude ? (
              <div className='flex flex-wrap gap-1.5'>
                {(model.aliases || []).slice(0, 4).map((alias) => (
                  <Badge key={alias} variant='outline' className='font-mono'>
                    {alias}
                  </Badge>
                ))}
                {(model.aliases || []).length > 4 ? (
                  <Badge variant='secondary'>
                    +{(model.aliases || []).length - 4}
                  </Badge>
                ) : null}
                {!(model.aliases || []).length ? (
                  <span className='text-xs text-muted-foreground'>
                    未设置别名
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className='flex items-center justify-between gap-3 sm:w-32 sm:flex-col sm:items-end'>
            <div
              className='flex items-center gap-2 rounded-lg border border-border/60 bg-background/70 px-2 py-1.5'
              onClick={(event) => event.stopPropagation()}
            >
              <Checkbox
                checked={on}
                onCheckedChange={(value) => onToggleEnabled(value === true)}
                aria-label={`启用 ${displayName}`}
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
              <DialogTitle className='truncate text-xl'>
                {displayName}
              </DialogTitle>
              <DialogDescription className='font-mono text-xs break-all'>
                {model.id}
              </DialogDescription>
              {facts?.description ? (
                <p className='mt-1 text-xs leading-5 text-muted-foreground'>
                  {facts.description}
                </p>
              ) : null}
            </div>
          </div>
        </DialogHeader>

        <div className='grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]'>
          <section className='space-y-4'>
            <Panel
              title={claude ? '模型覆写' : '目录'}
              icon={<SlidersHorizontal className='size-4' />}
            >
              <EditorRow label='对外启用'>
                <div className='flex items-center gap-2'>
                  <Checkbox
                    checked={on}
                    onCheckedChange={(value) => onToggleEnabled(value === true)}
                    aria-label='对外启用'
                  />
                  <span className='text-xs text-muted-foreground'>
                    关闭后仍保留配置，但不进入公开模型目录。
                  </span>
                </div>
              </EditorRow>
              {claude ? (
                <>
                  <EditorRow label='上下文窗口'>
                    <NumberInput
                      value={Number(caps.context_window || 0)}
                      onChange={(value) =>
                        onModel((rec) => {
                          rec.capabilities = {
                            ...(rec.capabilities || {}),
                            context_window: value,
                          }
                        })
                      }
                    />
                    <span className='text-xs text-muted-foreground'>token</span>
                  </EditorRow>
                  <div className='space-y-2'>
                    <span className='text-xs font-medium text-muted-foreground'>
                      别名
                    </span>
                    <Textarea
                      className='min-h-24 font-mono text-xs'
                      value={(model.aliases || []).join('\n')}
                      placeholder='每行一个别名，例如 claude-haiku-5-5-private'
                      onChange={(event) =>
                        onModel((rec) => {
                          rec.aliases = splitList(event.target.value)
                        })
                      }
                    />
                  </div>
                </>
              ) : (
                <p className='text-xs leading-5 text-muted-foreground'>
                  上下文、推理强度等能力来自上游 Codex 目录，点「同步
                  GPT」刷新；GPT 请求不经过 Claude 的 thinking / max_tokens
                  整流，因此这里没有参数可调。别名请用上方的「模型映射」。
                </p>
              )}
            </Panel>

            {claude ? (
              <Panel title='模型参数' icon={<Gauge className='size-4' />}>
                <EditorRow label='默认 max_tokens'>
                  <NumberInput
                    value={params.max_tokens_default ?? 8192}
                    onChange={(value) => onParam('max_tokens_default', value)}
                  />
                </EditorRow>
                <EditorRow label='max_tokens 上限'>
                  <NumberInput
                    value={params.max_tokens_cap ?? 64000}
                    onChange={(value) => onParam('max_tokens_cap', value)}
                  />
                </EditorRow>
                <EditorRow label='fallback budget'>
                  <NumberInput
                    value={fallback}
                    onChange={(value) =>
                      onParam('thinking_fallback_budget', value)
                    }
                  />
                </EditorRow>
                <EditorRow label='adaptive'>
                  <Select
                    value={params.on_adaptive || 'passthrough'}
                    onValueChange={(value) => onParam('on_adaptive', value)}
                  >
                    <SelectTrigger className='h-8 w-full sm:w-[220px]'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='passthrough'>透传</SelectItem>
                      <SelectItem value='convert_to_enabled'>
                        转为 enabled + budget
                      </SelectItem>
                      <SelectItem value='strip'>剥离 thinking</SelectItem>
                    </SelectContent>
                  </Select>
                </EditorRow>
                <EditorRow label='enabled'>
                  <Select
                    value={onEnabled}
                    onValueChange={(value) => onParam('on_enabled', value)}
                  >
                    <SelectTrigger className='h-8 w-full sm:w-[220px]'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='passthrough'>透传</SelectItem>
                      <SelectItem value='strip'>剥离 thinking</SelectItem>
                    </SelectContent>
                  </Select>
                </EditorRow>
                <EditorRow label='缺省 effort'>
                  <Select
                    value={params.default_effort || 'high'}
                    onValueChange={(value) => onParam('default_effort', value)}
                    disabled={!caps.supports_effort}
                  >
                    <SelectTrigger className='h-8 w-full sm:w-[220px]'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='off'>不补</SelectItem>
                      <SelectItem value='low'>low</SelectItem>
                      <SelectItem value='medium'>medium</SelectItem>
                      <SelectItem value='high'>high</SelectItem>
                      <SelectItem value='xhigh'>xhigh</SelectItem>
                      <SelectItem value='max'>max</SelectItem>
                    </SelectContent>
                  </Select>
                </EditorRow>
                {caps.supports_effort ? null : (
                  <p className='text-xs leading-5 text-muted-foreground'>
                    cli-node 目录可能写了缺省值，但该模型上游拒绝
                    effort，所以这里不补。
                  </p>
                )}
              </Panel>
            ) : null}
          </section>

          <aside className='space-y-4'>
            {claude ? (
              <Panel
                title='官方 beta'
                icon={<Gauge className='size-4' />}
                compact
              >
                <Select
                  value={mode}
                  onValueChange={(value) => {
                    if (
                      value === 'true' ||
                      value === 'false' ||
                      value === 'inherit'
                    ) {
                      onPass1m(value)
                    }
                  }}
                >
                  <SelectTrigger
                    className={cn('h-9 w-full', inheritHit && 'text-primary')}
                    title={
                      inheritHit
                        ? '未设开关，命中回退通配'
                        : mode === 'true'
                          ? '矩阵指定透传'
                          : mode === 'false'
                            ? '矩阵指定剥离'
                            : '未设，走回退通配'
                    }
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='true'>透传 1M beta</SelectItem>
                    <SelectItem value='false'>剥离 1M beta</SelectItem>
                    <SelectItem value='inherit'>
                      {effective ? '通配 → 透传' : '通配 → 剥离'}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className='text-xs text-muted-foreground'>
                  Beta drop：<span className='font-mono'>{drop}</span>
                </p>
              </Panel>
            ) : null}

            <Panel
              title='价格 / 计费'
              icon={<BadgeDollarSign className='size-4' />}
              compact
            >
              {claude ? (
                <>
                  <Fact label='来源' value={priceSourceLabel(priceSource)} />
                  <Fact
                    label='input / output / cache read'
                    value={`${fmtBaseRates(price)} / 1M`}
                    mono
                  />
                  {price ? (
                    <Fact
                      label='cache 5m / 1h'
                      value={`${fmtPerM(price.cache_5m)} / ${fmtPerM(price.cache_1h)}`}
                      mono
                    />
                  ) : null}
                </>
              ) : (
                <OpenaiPriceFacts price={price} source={priceSource} />
              )}
            </Panel>

            <Panel title='能力' icon={<Gauge className='size-4' />} compact>
              {facts ? (
                <OpenaiCapabilityFacts facts={facts} live={live} />
              ) : (
                <>
                  <Fact label='上下文' value={win.text} />
                  <Fact label='Thinking' value={thinkingPolicyLabel(model)} />
                  <Fact
                    label='目录状态'
                    value={live ? '对外可见' : '未进入目录'}
                  />
                </>
              )}
            </Panel>
          </aside>
        </div>

        <DialogFooter className='items-center gap-2 sm:justify-between'>
          <p className='text-xs text-muted-foreground'>
            关闭弹窗不会保存；右上角「保存更改」才会写入策略。
          </p>
          <DialogClose asChild>
            <Button type='button' variant='outline'>
              完成
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function NumberInput({
  value,
  onChange,
}: {
  value: number
  onChange: (value: number) => void
}) {
  return (
    <Input
      className='field-count h-8 w-full sm:w-[150px]'
      type='number'
      min={0}
      value={value}
      onChange={(event) => onChange(Number(event.target.value) || 0)}
    />
  )
}

function splitList(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function formatK(value: number): string {
  if (value >= 1_000_000) return `${Math.floor(value / 1_000_000)}M`
  if (value >= 1000) return `${Math.floor(value / 1000)}K`
  return String(value)
}
