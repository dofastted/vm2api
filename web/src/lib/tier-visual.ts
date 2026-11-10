import type { Vm } from '@/types/panel-vm'
import { isCodexVm } from '@/lib/vm-kind'
import { claudeTier } from '@/lib/vm-status'

export type TierKey =
  'free' | 'pro' | 'max' | 'team' | 'enterprise' | 'codex' | 'none' | 'unknown'

/**
 * 账号等级的视觉皮肤。等级轴与健康状态轴正交：
 * 状态用形状 + 状态色（`StatusMark`），等级用色相——实心徽标、表格行首 2px、
 * 机架刀片左沿色标。等级是分类，状态才是运营信号，所以不再整卡染色。
 *
 * `none`（无凭证）不着色。Codex / GPT 槽用绿相，不走 Claude Pro/Max。
 */
export type TierVisual = {
  key: TierKey
  label: string
  /** 表格行左侧 2px 色条 + 行 hover 底色。 */
  row: string
  /** 等级 badge：实心高饱身份色。淡底淡字在一屏十几张卡里认不出来。 */
  badge: string
}

const NEUTRAL: TierVisual = {
  key: 'none',
  label: '—',
  row: '',
  badge: 'bg-muted text-muted-foreground',
}

const SKIN: Record<'pro' | 'max' | 'codex', TierVisual> = {
  pro: {
    key: 'pro',
    label: 'Pro',
    row: 'border-l-2 border-l-[color:var(--tier-pro-border)] hover:bg-[color:var(--tier-pro-surface-hover)]',
    badge:
      'bg-[color:var(--tier-pro-solid)] text-[color:var(--tier-pro-solid-fg)]',
  },
  max: {
    key: 'max',
    label: 'Max',
    row: 'border-l-2 border-l-[color:var(--tier-max-border)] hover:bg-[color:var(--tier-max-surface-hover)]',
    badge:
      'bg-[color:var(--tier-max-solid)] text-[color:var(--tier-max-solid-fg)]',
  },
  codex: {
    key: 'codex',
    label: 'GPT',
    row: 'border-l-2 border-l-[color:var(--tier-codex-border)] hover:bg-[color:var(--tier-codex-surface-hover)]',
    badge:
      'bg-[color:var(--tier-codex-solid)] text-[color:var(--tier-codex-solid-fg)]',
  },
}

export function tierVisual(vm: Vm | undefined): TierVisual {
  if (isCodexVm(vm)) return SKIN.codex
  const { key, label } = claudeTier(vm)
  if (key === 'pro' || key === 'max')
    return { ...SKIN[key], label: label || SKIN[key].label }
  if (
    key === 'free' ||
    key === 'team' ||
    key === 'enterprise' ||
    key === 'unknown'
  )
    return { ...NEUTRAL, key, label: label || '未识别' }
  return NEUTRAL
}
