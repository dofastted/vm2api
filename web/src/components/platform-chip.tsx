import type { Vm } from '@/types/panel-vm'
import { type CredType, credLaneLabel, credTypeOf } from '@/lib/cred-type'
import { cn } from '@/lib/utils'
import {
  compactEmail,
  kindFromModel,
  platformLabelOf,
  slotAccountLabel,
  type VmKind,
  vmKindOf,
} from '@/lib/vm-kind'

export function PlatformChip({
  vm,
  kind,
  className,
}: {
  vm?: Vm
  kind?: VmKind
  className?: string
}) {
  const resolved = kind ?? (vm ? vmKindOf(vm) : 'claude')
  const gpt = resolved === 'codex'
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-[5px] border px-1.5 py-0.5 text-[10px] leading-none font-semibold tracking-[0.03em]',
        gpt
          ? 'border-[color:var(--tier-codex-border)] text-[color:var(--tier-codex-fg)]'
          : 'border-[color:var(--tier-pro-border)] text-[color:var(--tier-pro-fg)]',
        className
      )}
    >
      {platformLabelOf(resolved)}
    </span>
  )
}

/** `[Claude|GPT] 邮箱`。`compact` 给卡片 / 表格：字号下调并缩短本地段。 */
export function SlotIdentity({
  vm,
  vmId,
  email,
  model,
  protocol,
  compact = false,
  className,
}: {
  vm?: Vm
  vmId?: string | null
  email?: string | null
  model?: string | null
  protocol?: string | null
  compact?: boolean
  className?: string
}) {
  const kind = vm ? vmKindOf(vm) : kindFromModel(model, protocol)
  const full = slotAccountLabel(vm, { email, vmId })
  const shown = compact && full.includes('@') ? compactEmail(full) : full
  return (
    <span
      className={cn(
        'flex max-w-full min-w-0 items-center gap-1.5 overflow-hidden',
        compact && 'text-[12px] leading-[1.3] tracking-[-0.01em]',
        className
      )}
      title={full.includes('@') ? full : undefined}
    >
      <PlatformChip kind={kind} />
      <span className='min-w-0 flex-1 truncate'>{shown}</span>
    </span>
  )
}

export function BrandPlatforms({ className }: { className?: string }) {
  return (
    <span
      className={cn('flex flex-wrap gap-1', className)}
      aria-label='Anthropic 与 GPT'
    >
      <span className='inline-flex items-center rounded-[5px] border border-[color:var(--tier-pro-border)] px-1.5 py-0.5 text-[10px] leading-none font-semibold tracking-[0.03em] text-[color:var(--tier-pro-fg)]'>
        Anthropic
      </span>
      <span className='inline-flex items-center rounded-[5px] border border-[color:var(--tier-codex-border)] px-1.5 py-0.5 text-[10px] leading-none font-semibold tracking-[0.03em] text-[color:var(--tier-codex-fg)]'>
        GPT
      </span>
    </span>
  )
}

const LANE_CLASS: Record<CredType, string> = {
  oauth:
    'border-[color:var(--tier-pro-border)] text-[color:var(--tier-pro-fg)]',
  'setup-token':
    'border-[color:var(--status-info,oklch(0.7 0.1 210))] text-[color:var(--status-info,oklch(0.78 0.08 210))]',
  apikey:
    'border-[color:var(--tier-codex-border)] text-[color:var(--tier-codex-fg)]',
  none: 'border-border/70 text-muted-foreground',
}

/** 集群卡片 / 用量队列：OAuth vs Console（setup-token）vs API Key。 */
export function CredLaneChip({
  vm,
  type,
  className,
}: {
  vm?: Vm
  type?: CredType
  className?: string
}) {
  const lane = type || credTypeOf(vm)
  if (lane === 'none') return null
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-[5px] border px-1.5 py-0.5 text-[10px] leading-none font-semibold tracking-[0.03em]',
        LANE_CLASS[lane],
        className
      )}
    >
      {credLaneLabel(lane)}
    </span>
  )
}
