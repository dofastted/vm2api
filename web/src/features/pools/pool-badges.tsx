import type {
  PoolRole,
  ProviderScope,
  SystemPromptMode,
  WeightTierMode,
} from '@/types/panel-pools'
import ClaudeColor from '@lobehub/icons/es/Claude/components/Color'
import GeminiColor from '@lobehub/icons/es/Gemini/components/Color'
import OpenAI from '@lobehub/icons/es/OpenAI/components/Mono'
import { Layers, Send, Sparkles, ShieldCheck, ShieldOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import {
  isPromptLockedProvider,
  POOL_ROLE_LABELS,
  PROVIDER_SCOPE_LABELS,
  SYSTEM_PROMPT_MODE_LABELS,
} from './pool-rules'

const PROVIDER_STYLE: Record<ProviderScope, string> = {
  anthropic:
    'border-orange-300/80 bg-orange-50 text-orange-900 dark:border-orange-500/35 dark:bg-orange-500/15 dark:text-orange-200',
  openai:
    'border-emerald-300/80 bg-emerald-50 text-emerald-900 dark:border-emerald-500/35 dark:bg-emerald-500/15 dark:text-emerald-200',
  google:
    'border-sky-300/80 bg-sky-50 text-sky-900 dark:border-sky-500/35 dark:bg-sky-500/15 dark:text-sky-200',
  api: 'border-zinc-300/80 bg-zinc-50 text-zinc-800 dark:border-zinc-600 dark:bg-zinc-800/70 dark:text-zinc-200',
  mixed:
    'border-violet-300/80 bg-violet-50 text-violet-900 dark:border-violet-500/35 dark:bg-violet-500/15 dark:text-violet-200',
}

export function ProviderScopeBadge({
  scope,
  className,
}: {
  scope: ProviderScope
  className?: string
}) {
  return (
    <Badge
      variant='outline'
      className={cn(
        'gap-1 font-medium',
        PROVIDER_STYLE[scope] || PROVIDER_STYLE.mixed,
        className
      )}
    >
      {scope === 'anthropic' ? (
        <ClaudeColor className='size-3' aria-hidden />
      ) : scope === 'openai' ? (
        <OpenAI className='size-3' aria-hidden />
      ) : scope === 'google' ? (
        <GeminiColor className='size-3' aria-hidden />
      ) : scope === 'api' ? (
        <Send className='size-3' aria-hidden />
      ) : (
        <Layers className='size-3' aria-hidden />
      )}
      {PROVIDER_SCOPE_LABELS[scope] || scope}
    </Badge>
  )
}

const ROLE_STYLE: Record<PoolRole, string> = {
  primary:
    'border-primary/40 bg-primary/10 text-primary dark:border-primary/40 dark:bg-primary/15',
  standard: 'border-border bg-muted/60 text-muted-foreground',
  overflow:
    'border-amber-300/80 bg-amber-50 text-amber-900 dark:border-amber-500/35 dark:bg-amber-500/15 dark:text-amber-200',
  downgrade:
    'border-rose-300/80 bg-rose-50 text-rose-900 dark:border-rose-500/35 dark:bg-rose-500/15 dark:text-rose-200',
  dedicated:
    'border-indigo-300/80 bg-indigo-50 text-indigo-900 dark:border-indigo-500/35 dark:bg-indigo-500/15 dark:text-indigo-200',
}

export function PoolRoleBadge({
  role,
  className,
}: {
  role: PoolRole
  className?: string
}) {
  return (
    <Badge
      variant='outline'
      className={cn(
        'font-medium',
        ROLE_STYLE[role] || ROLE_STYLE.standard,
        className
      )}
    >
      {POOL_ROLE_LABELS[role] || role}
    </Badge>
  )
}

/**
 * 强视觉区分：
 * - OpenAI / Google：中性灰「无 Prompt 注入 / 透传」
 * - Anthropic `official`：鲜明青绿实感徽章「官方提示词」
 * - Anthropic `zero_inject`：高辨识琥珀橙徽章「0 注入」
 * - `override` / `append` / `inherit_global` / `passthrough` 各自清晰辨识
 */
export function PromptModeBadge({
  providerScope,
  mode,
  compact = false,
  className,
}: {
  providerScope: ProviderScope
  mode: SystemPromptMode
  compact?: boolean
  className?: string
}) {
  if (isPromptLockedProvider(providerScope)) {
    return (
      <Badge
        variant='outline'
        className={cn(
          'border-border/80 bg-muted/50 text-muted-foreground',
          className
        )}
        title='OpenAI / Google 分组池不使用 System Prompt 注入，固定原样透传'
      >
        {compact ? '透传' : '无 Prompt 注入 / 透传'}
      </Badge>
    )
  }

  if (mode === 'official') {
    return (
      <Badge
        variant='outline'
        className={cn(
          'border-emerald-500/60 bg-emerald-600 text-white shadow-xs dark:border-emerald-400/50 dark:bg-emerald-500/25 dark:text-emerald-200',
          className
        )}
      >
        <ShieldCheck className='size-3' aria-hidden />
        官方提示词
      </Badge>
    )
  }

  if (mode === 'zero_inject') {
    return (
      <Badge
        variant='outline'
        className={cn(
          'border-amber-500/70 bg-amber-500 text-amber-950 shadow-xs dark:border-amber-400/50 dark:bg-amber-500/25 dark:text-amber-200',
          className
        )}
      >
        <ShieldOff className='size-3' aria-hidden />0 注入
      </Badge>
    )
  }

  if (mode === 'override') {
    return (
      <Badge
        variant='outline'
        className={cn(
          'border-purple-400/70 bg-purple-100 text-purple-900 dark:border-purple-400/40 dark:bg-purple-500/20 dark:text-purple-200',
          className
        )}
      >
        <Sparkles className='size-3' aria-hidden />
        自定义覆写
      </Badge>
    )
  }

  if (mode === 'append') {
    return (
      <Badge
        variant='outline'
        className={cn(
          'border-cyan-400/70 bg-cyan-100 text-cyan-900 dark:border-cyan-400/40 dark:bg-cyan-500/20 dark:text-cyan-200',
          className
        )}
      >
        尾部追加
      </Badge>
    )
  }

  if (mode === 'inherit_global') {
    return (
      <Badge
        variant='outline'
        className={cn(
          'border-dashed border-border text-muted-foreground',
          className
        )}
      >
        继承全局
      </Badge>
    )
  }

  return (
    <Badge
      variant='outline'
      className={cn('border-border text-muted-foreground', className)}
    >
      {SYSTEM_PROMPT_MODE_LABELS[mode] || mode}
    </Badge>
  )
}

export function WeightTierBadge({
  tier,
  mode,
  override = false,
  className,
}: {
  tier: number | null | undefined
  mode?: WeightTierMode | null
  override?: boolean
  className?: string
}) {
  const n = Number(tier)
  const valid = Number.isInteger(n) && n >= 1 && n <= 10
  const isManual = override || mode === 'manual'
  const high = valid && n >= 8
  const mid = valid && n >= 5 && n < 8
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums',
        high
          ? 'bg-primary/15 text-primary ring-1 ring-primary/40 ring-inset'
          : mid
            ? 'bg-muted text-foreground ring-1 ring-border ring-inset'
            : 'bg-muted/60 text-muted-foreground',
        className
      )}
      title={
        valid
          ? `有效权重等级 ${n}（${override ? '池成员覆盖' : isManual ? '手动 manual' : '自动 auto'}，1–10 数值越高越优先）`
          : '未设置权重等级'
      }
    >
      <span>有效 {valid ? n : '—'}</span>
      <span className='font-sans text-[10px] font-normal opacity-80'>
        ({override ? '池覆写' : isManual ? 'manual' : 'auto'})
      </span>
    </span>
  )
}
