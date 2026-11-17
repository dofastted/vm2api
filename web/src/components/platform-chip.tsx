import type { Vm } from '@/types/panel-vm'
import {
  type CredEndpoint,
  credEndpointLabel,
  credEndpointOf,
} from '@/lib/cred-type'
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
  kind?: VmKind | 'gemini'
  className?: string
}) {
  const resolved = kind ?? (vm?.gemini ? 'gemini' : vmKindOf(vm))
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
      {resolved === 'gemini' ? 'Gemini' : platformLabelOf(resolved)}
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
  emptyLabel,
  compact = false,
  className,
}: {
  vm?: Vm
  vmId?: string | null
  email?: string | null
  model?: string | null
  protocol?: string | null
  emptyLabel?: string
  compact?: boolean
  className?: string
}) {
  const kind = vm ? vmKindOf(vm) : kindFromModel(model, protocol)
  const full = slotAccountLabel(vm, { email, vmId, emptyLabel })
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

/** Console = Anthropic 陶土橙实心；OAuth = 蓝；API = 白。色值见 theme.css 的 --lane-*。 */
const LANE_CLASS: Record<CredEndpoint, string> = {
  console:
    'border-[color:var(--lane-console-bg)] bg-[color:var(--lane-console-bg)] text-[color:var(--lane-console-fg)]',
  oauth:
    'border-[color:var(--tier-pro-border)] bg-[color:var(--tier-pro-badge-bg)] text-[color:var(--tier-pro-fg)]',
  api: 'border-[color:var(--lane-api-border)] bg-[color:var(--lane-api-bg)] text-[color:var(--lane-api-fg)]',
  none: 'border-border/70 text-muted-foreground',
}

/**
 * 集群卡片 / 列表 / 用量队列：Console / OAuth / API 三类。
 * 传 `vm` 按实际认证方案归类；只有 `endpoint` 时（用量行没有槽位）直接用它。
 */
export function CredLaneChip({
  vm,
  endpoint,
  className,
}: {
  vm?: Vm
  endpoint?: CredEndpoint
  className?: string
}) {
  const lane = endpoint ?? credEndpointOf(vm)
  if (lane === 'none') return null
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-[5px] border px-1.5 py-0.5 text-[10px] leading-none font-semibold tracking-[0.03em]',
        LANE_CLASS[lane],
        className
      )}
    >
      {credEndpointLabel(lane)}
    </span>
  )
}
