import type { PolicyPrice } from '@/types/panel-pricing'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { ModelVendorIcon } from '@/components/model-vendor-icon'
import { Fact } from './model-parts'
import type { ImageToolModel } from './policy'
import {
  fmtImageRates,
  fmtOpenaiRates,
  priceSourceLabel,
} from './price-display'

type Props = {
  models: ImageToolModel[]
  /** Draft switches; a model missing here shows its saved state. */
  enabled: Record<string, { enabled: boolean }> | undefined
  pricing: Record<string, PolicyPrice | null> | undefined
  onToggle: (id: string, on: boolean) => void
}

export function ImageToolSection({
  models,
  enabled,
  pricing,
  onToggle,
}: Props) {
  if (!models.length) return null
  return (
    <section className='space-y-3 rounded-2xl border border-border/70 bg-card p-4 shadow-sm'>
      <div className='max-w-3xl space-y-1'>
        <h3 className='font-semibold'>图像模型</h3>
        <p className='text-sm leading-6 text-muted-foreground'>
          两种用法：<span className='font-mono'>/v1/images/generations</span>、
          <span className='font-mono'>/v1/images/edits</span> 的{' '}
          <span className='font-mono'>model</span>，或 Responses{' '}
          <span className='font-mono'>image_generation</span> 工具的{' '}
          <span className='font-mono'>model</span>。启用后列入{' '}
          <span className='font-mono'>/v1/models</span>
          ；停用后带该模型的请求在网关本地被拒绝。Free 套餐账号不接 Images
          端点。
        </p>
      </div>
      <div className='grid gap-3 md:grid-cols-2'>
        {models.map((m) => {
          const on = enabled?.[m.id]?.enabled ?? m.enabled
          const price = pricing?.[m.id]
          return (
            <div
              key={m.id}
              className='flex gap-3 rounded-xl border border-border/70 bg-background/60 p-3 text-sm'
            >
              <div className='mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-muted/70 ring-1 ring-border/60'>
                <ModelVendorIcon modelId={m.id} className='size-5' />
              </div>
              <div className='min-w-0 flex-1 space-y-2'>
                <div className='flex flex-wrap items-center gap-2'>
                  <h4 className='truncate font-semibold'>{m.display_name}</h4>
                  <Badge variant='outline'>图像</Badge>
                  {m.upstream_default ? (
                    <Badge variant='secondary'>上游默认</Badge>
                  ) : null}
                  {on ? null : <Badge variant='outline'>停用</Badge>}
                </div>
                <p className='truncate font-mono text-[11px] text-muted-foreground'>
                  {m.id}
                  {m.snapshots.length ? ` · ${m.snapshots.join(', ')}` : ''}
                </p>
                <div className='space-y-1'>
                  <Fact
                    label='文本 input / cached / output'
                    value={`${fmtOpenaiRates(price?.effective)} / 1M`}
                    mono
                  />
                  <Fact
                    label='图像 token input / cached / output'
                    value={`${fmtImageRates(price?.effective)} / 1M`}
                    mono
                  />
                  <Fact
                    label='价格来源'
                    value={priceSourceLabel(price?.source)}
                  />
                </div>
              </div>
              <div className='flex shrink-0 flex-col items-end gap-1'>
                <Switch
                  checked={on}
                  onCheckedChange={(next) => onToggle(m.id, next)}
                  aria-label={`启用 ${m.display_name}`}
                />
                <span className='text-xs text-muted-foreground'>
                  {on ? '启用' : '停用'}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
