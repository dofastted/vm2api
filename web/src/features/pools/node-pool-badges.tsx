import { Link } from '@tanstack/react-router'
import type { PoolBriefRef, SchedulerPool } from '@/types/panel-pools'
import { Network } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isPromptLockedProvider, SYSTEM_PROMPT_MODE_LABELS } from './pool-rules'

/** 将分组池列表按节点 ID 索引为所属分组池数组（用于 `/vm` 与 `/import` 对齐展示）。 */
export function buildNodePoolsIndex(
  pools: SchedulerPool[] | undefined
): Map<string, PoolBriefRef[]> {
  const map = new Map<string, PoolBriefRef[]>()
  if (!pools?.length) return map

  const push = (key: string, ref: PoolBriefRef) => {
    const list = map.get(key)
    if (!list) {
      map.set(key, [ref])
      return
    }
    if (!list.some((item) => item.id === ref.id)) list.push(ref)
  }

  for (const pool of pools) {
    const ref: PoolBriefRef = {
      id: pool.id,
      name: pool.name,
      provider_scope: pool.provider_scope,
      system_prompt_mode: pool.system_prompt_mode,
      pool_role: pool.pool_role,
      enabled: pool.enabled,
    }
    for (const member of pool.members || []) {
      if (member.enabled === false) continue
      push(member.node_id, ref)
      push(`${member.node_type}:${member.node_id}`, ref)
    }
    for (const vmId of pool.vm_ids || []) {
      push(vmId, ref)
    }
  }
  return map
}

export function NodePoolBadges({
  pools,
  maxVisible = 2,
  compact = false,
  className,
}: {
  pools?: PoolBriefRef[]
  maxVisible?: number
  compact?: boolean
  className?: string
}) {
  if (!pools?.length) return null
  const shown = pools.slice(0, maxVisible)
  const rest = pools.length - shown.length
  return (
    <span
      className={cn('inline-flex flex-wrap items-center gap-1', className)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {shown.map((pool) => {
        const promptHint = isPromptLockedProvider(pool.provider_scope)
          ? '透传'
          : SYSTEM_PROMPT_MODE_LABELS[pool.system_prompt_mode] ||
            pool.system_prompt_mode
        return (
          <Link
            key={pool.id}
            to='/pools/$poolId'
            params={{ poolId: pool.id }}
            title={`所属分组池：${pool.name} · ${promptHint}${pool.enabled ? '' : '（已停用）'}`}
            className={cn(
              'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] leading-none font-medium transition-colors hover:border-primary/60 hover:text-primary',
              pool.enabled
                ? 'border-border/80 bg-background/80 text-foreground'
                : 'border-dashed border-border text-muted-foreground opacity-75',
              compact && 'max-w-[100px] truncate'
            )}
          >
            <Network className='size-2.5 shrink-0 opacity-70' aria-hidden />
            <span className='truncate'>{pool.name}</span>
          </Link>
        )
      })}
      {rest > 0 ? (
        <span
          className='rounded bg-muted px-1 py-0.5 text-[10px] leading-none text-muted-foreground tabular-nums'
          title={pools
            .slice(maxVisible)
            .map((p) => p.name)
            .join('、')}
        >
          +{rest}
        </span>
      ) : null}
    </span>
  )
}
