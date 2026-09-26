import type { Vm } from '@/types/panel-vm'
import { isCodexVm } from '@/lib/vm-kind'
import { claudeTier } from '@/lib/vm-status'

export type TierKey = 'pro' | 'max' | 'codex' | 'none' | 'unknown'

/**
 * 账号等级的视觉皮肤。等级轴与健康状态轴正交：
 * 状态用形状 + 状态色（`StatusMark`），等级用整卡底色 + 色相。
 * 两者共处一卡时状态永远压在等级之上——等级是分类，状态才是运营信号。
 *
 * `none`（无凭证）不着色：没有等级可分，走中性卡。
 * Codex / GPT 槽用绿相，不走 Claude Pro/Max。
 */
export type TierVisual = {
  key: TierKey
  label: string
  /** 整卡：底色 + 1px 边框 + hover 底色。none 时回落到中性 card。 */
  card: string
  /** 表格行左侧 2px 色条 + 行 hover 底色。 */
  row: string
  /** 等级 badge：实心高饱身份色。淡底淡字在一屏十几张卡里认不出来。 */
  badge: string
  /** 卡内次级文字（等级色相的灰，不用中性灰以免和底色打架）。 */
  muted: string
  /** 卡内强调数字（等级色相实色）。 */
  accent: string
}

const NEUTRAL: TierVisual = {
  key: 'none',
  label: '—',
  card: 'border-[color:var(--tier-none-border)] bg-card hover:bg-accent/40',
  row: '',
  badge: 'bg-muted text-muted-foreground',
  muted: 'text-muted-foreground',
  accent: 'text-foreground',
}

const UNCONFIRMED: TierVisual = { ...NEUTRAL, label: '待探测' }

const SKIN: Record<'pro' | 'max' | 'codex', TierVisual> = {
  pro: {
    key: 'pro',
    label: 'Pro',
    card: 'border-[color:var(--tier-pro-border)] bg-[color:var(--tier-pro-surface)] hover:bg-[color:var(--tier-pro-surface-hover)]',
    row: 'border-l-2 border-l-[color:var(--tier-pro-border)] hover:bg-[color:var(--tier-pro-surface-hover)]',
    badge:
      'bg-[color:var(--tier-pro-solid)] text-[color:var(--tier-pro-solid-fg)]',
    muted: 'text-[color:var(--tier-pro-muted)]',
    accent: 'text-[color:var(--tier-pro-fg)]',
  },
  max: {
    key: 'max',
    label: 'Max',
    card: 'border-[color:var(--tier-max-border)] bg-[color:var(--tier-max-surface)] hover:bg-[color:var(--tier-max-surface-hover)]',
    row: 'border-l-2 border-l-[color:var(--tier-max-border)] hover:bg-[color:var(--tier-max-surface-hover)]',
    badge:
      'bg-[color:var(--tier-max-solid)] text-[color:var(--tier-max-solid-fg)]',
    muted: 'text-[color:var(--tier-max-muted)]',
    accent: 'text-[color:var(--tier-max-fg)]',
  },
  codex: {
    key: 'codex',
    label: 'GPT',
    card: 'border-[color:var(--tier-codex-border)] bg-[color:var(--tier-codex-surface)] hover:bg-[color:var(--tier-codex-surface-hover)]',
    row: 'border-l-2 border-l-[color:var(--tier-codex-border)] hover:bg-[color:var(--tier-codex-surface-hover)]',
    badge:
      'bg-[color:var(--tier-codex-solid)] text-[color:var(--tier-codex-solid-fg)]',
    muted: 'text-[color:var(--tier-codex-muted)]',
    accent: 'text-[color:var(--tier-codex-fg)]',
  },
}

export function tierVisual(vm: Vm | undefined): TierVisual {
  if (isCodexVm(vm)) return SKIN.codex
  const key = claudeTier(vm).key
  if (key === 'pro' || key === 'max') return SKIN[key]
  if (key === 'unknown') return UNCONFIRMED
  return NEUTRAL
}
