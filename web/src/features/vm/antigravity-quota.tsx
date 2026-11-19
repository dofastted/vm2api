import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { AntigravityQuotaBucket, Vm } from '@/types/panel-vm'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtResetClock, resetCountdown } from '@/lib/fable-status'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { vmQueryOptions, vmsListQueryOptions } from '@/features/vm/queries'
import { riskFg, UsageMeter } from '@/features/vm/usage-meter'
import { useVmPerms } from '@/features/vm/vm-perms'

const GRID =
  'grid grid-cols-[2.25rem_minmax(2.5rem,1fr)_2.75rem_3.75rem] items-center gap-x-1'

/** 官方 window / bucket id 归一成与 Claude 行一致的短标签：5H、7D。 */
export function antigravityWindowLabel(bucket: AntigravityQuotaBucket): string {
  const source = `${bucket.window || ''} ${bucket.id || ''}`.toLowerCase()
  const span = source.match(/(\d+)\s*(h|d)\b/)
  if (span) return `${span[1]}${span[2].toUpperCase()}`
  if (/week/.test(source)) return '7D'
  if (/dai|day/.test(source)) return '1D'
  if (/month/.test(source)) return '30D'
  return (bucket.name || bucket.window || '—').slice(0, 4)
}

function BucketRow({
  bucket,
  now,
  quiet,
}: {
  bucket: AntigravityQuotaBucket
  now: number
  quiet: boolean
}) {
  const left =
    bucket.remaining == null ? null : Math.round(bucket.remaining * 100)
  const used = left == null ? null : 100 - left
  const name = bucket.name || bucket.window || bucket.id || ''
  const clock = fmtResetClock(bucket.reset_at)
  return (
    <div
      className={cn(GRID, 'h-5')}
      title={[name, bucket.description].filter(Boolean).join(' · ')}
    >
      <span className='text-xs font-medium text-muted-foreground'>
        {antigravityWindowLabel(bucket)}
      </span>
      {bucket.disabled ? (
        <span className='col-span-2 truncate text-xs text-muted-foreground'>
          已停用
        </span>
      ) : (
        <>
          {used == null ? (
            <div
              className='h-[5px] w-full rounded-full track-recessed'
              aria-hidden='true'
            />
          ) : (
            <UsageMeter value={used} size='sm' ticks={false} />
          )}
          <span
            className={cn(
              'text-right font-mono text-xs font-medium tabular-nums',
              used != null && (!quiet || used >= 70) && riskFg(used)
            )}
          >
            {left != null
              ? `剩${left}%`
              : bucket.remaining_amount != null
                ? `剩${bucket.remaining_amount}`
                : '—'}
          </span>
        </>
      )}
      <span
        className='truncate text-right font-mono text-[11px] text-muted-foreground tabular-nums'
        title={clock ? `重置于 ${clock}` : undefined}
      >
        {resetCountdown(bucket.reset_at, now) ?? ''}
      </span>
    </div>
  )
}

function RefreshQuota({ vm }: { vm: Vm }) {
  const qc = useQueryClient()
  const canUse = useVmPerms().credential
  const refresh = useMutation({
    mutationFn: () =>
      api(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/antigravity/quota/refresh`,
        { method: 'POST', signal: AbortSignal.timeout(60_000) }
      ),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
        qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
        qc.invalidateQueries({
          queryKey: ['panel', 'vm', vm.id, 'antigravity'],
        }),
      ])
      toast.success('已刷新 Antigravity 额度')
    },
    onError: async (error: Error) => {
      await qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey })
      toast.error(error.message)
    },
  })
  if (!canUse) return null
  return (
    <Button
      size='sm'
      variant='ghost'
      disabled={refresh.isPending}
      title='查询官方账号额度'
      className='h-6 gap-1 px-1.5 text-[11px] text-muted-foreground'
      data-row-actions
      onClick={(event) => {
        event.stopPropagation()
        refresh.mutate()
      }}
    >
      <RefreshCw
        className={cn('size-3', refresh.isPending && 'animate-spin')}
      />
      {refresh.isPending ? '查询中' : '刷新额度'}
    </Button>
  )
}

/** 每组（Gemini / Claude 与 GPT / 单模型）一个小标题，下挂官方窗口；数值是剩余比例。 */
export function AntigravityQuotaWindows({
  vm,
  now,
  quiet = false,
  actions = false,
  className,
}: {
  vm: Vm
  now: number
  quiet?: boolean
  actions?: boolean
  className?: string
}) {
  const quota = vm.antigravity_quota
  const groups = quota?.groups || []
  const signedIn = vm.antigravity?.authenticated === true
  return (
    <div className={cn('grid min-w-0 gap-1', className)}>
      {groups.map((group, index) => (
        <div key={`${group.name}-${index}`} className='grid min-w-0 gap-0.5'>
          {group.name ? (
            <span
              className='truncate text-[11px] text-muted-foreground'
              title={group.description || group.name}
            >
              {group.name}
            </span>
          ) : null}
          {group.buckets.map((bucket, i) => (
            <BucketRow
              key={bucket.id || i}
              bucket={bucket}
              now={now}
              quiet={quiet}
            />
          ))}
        </div>
      ))}
      {!groups.length ? (
        <p className='text-xs text-muted-foreground'>
          {signedIn ? '尚未查询额度' : '授权后可查询额度'}
        </p>
      ) : null}
      {quota?.error ? (
        <p
          className='truncate text-[11px] text-[color:var(--status-warn)]'
          title={quota.error.message}
        >
          {groups.length ? '最近查询失败：' : ''}
          {quota.error.message}
        </p>
      ) : null}
      {actions && signedIn ? (
        <div className='flex items-center gap-1'>
          <RefreshQuota vm={vm} />
          {quota?.updated_at ? (
            <span className='text-[11px] text-muted-foreground'>
              {new Date(quota.updated_at).toLocaleTimeString()}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
