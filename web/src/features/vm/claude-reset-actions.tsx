import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { Vm } from '@/types/panel-vm'
import { RefreshCw, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { randomUUID } from '@/lib/random-uuid'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { dashboardQueryOptions } from '@/features/overview/queries'
import {
  claudeResetCount,
  claudeResetWarnings,
  clearsText,
  isLegacy,
  kindName,
  liveState,
  OUTCOME_TEXT,
  pct,
  shownCredits,
  spaced,
  windows,
  WINDOW_LABEL,
  type ResetCredit,
  type ResetPayload,
  type ResetSnapshot,
  type ResetUsage,
} from '@/features/vm/claude-reset-cards'
import { ResetAt } from '@/features/vm/detail-section-primitives'
import { vmQueryOptions, vmsListQueryOptions } from '@/features/vm/queries'
import { useVmPerms } from '@/features/vm/vm-perms'

function useResetMutations(vm: Vm) {
  const qc = useQueryClient()
  const refreshAll = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
      qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
    ])
  }
  const queryCredits = useMutation({
    mutationFn: () =>
      api<ResetPayload>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/claude-reset/query`,
        { method: 'POST' }
      ),
    onSuccess: async (data) => {
      await refreshAll()
      const count = claudeResetCount(data?.claude_reset_credits)
      toast.success(
        data?.claude_reset_credits
          ? `已查询，重置卡 ${count} 张`
          : '已查询限额重置'
      )
    },
    onError: (error: Error) => toast.error(error.message),
  })
  return { queryCredits, refreshAll }
}

/** 列表 / 卡片 / 统计弹窗：只显示总张数，点「限额重置」去详情页选卡。 */
function CompactResetActions({ vm }: { vm: Vm }) {
  const navigate = useNavigate()
  const { queryCredits } = useResetMutations(vm)
  const credits = vm.claude_reset_credits
  const count = claudeResetCount(credits)
  return (
    <div
      className='flex flex-wrap items-center gap-1'
      data-row-actions
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Button
        size='sm'
        variant='ghost'
        disabled={queryCredits.isPending}
        title='查询 Claude 原生限额重置卡（只读，不消耗）'
        className='h-6 gap-1 px-1.5 text-[11px] text-muted-foreground'
        onClick={() => queryCredits.mutate()}
      >
        <RefreshCw
          className={cn('size-3', queryCredits.isPending && 'animate-spin')}
        />
        {queryCredits.isPending
          ? '查询中'
          : `限额查询${credits ? ` ${count}` : ''}`}
      </Button>
      <Button
        size='sm'
        variant='ghost'
        disabled={queryCredits.isPending || count < 1}
        title={
          count < 1 ? '先查询 Claude 限额重置卡' : '到详情页选择要用的重置卡'
        }
        className='h-6 gap-1 px-1.5 text-[11px] text-muted-foreground disabled:text-muted-foreground/50'
        onClick={() => navigate({ to: '/vm/$id', params: { id: vm.id } })}
      >
        <RotateCcw className='size-3' />
        限额重置
      </Button>
    </div>
  )
}

/** 详情页：一张卡一行，各自「使用」，确认框只问这一张。 */
function FullResetActions({
  vm,
  now,
  usage,
}: {
  vm: Vm
  now: number
  usage?: ResetUsage
}) {
  const { queryCredits, refreshAll } = useResetMutations(vm)
  const [picked, setPicked] = useState<ResetCredit | null>(null)
  const keyRef = useRef<{ card: string; key: string } | null>(null)
  const snapshot = vm.claude_reset_credits as ResetSnapshot | null | undefined
  const cards = shownCredits(snapshot)
  const legacy = isLegacy(snapshot)
  const count = claudeResetCount(snapshot)

  const redeem = useMutation({
    mutationFn: (card: ResetCredit) =>
      api<ResetPayload>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/claude-reset/redeem`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': keyRef.current?.key || '' },
          body: JSON.stringify({ card: card.ref }),
          signal: AbortSignal.timeout(90_000),
        }
      ),
    onSuccess: async (data, card) => {
      setPicked(null)
      keyRef.current = null
      await refreshAll()
      const name = kindName(data?.kind || card.kind)
      if (data?.outcome === 'reset') {
        toast.success(`已用掉 1 张${spaced(name)}`)
        return
      }
      const text = OUTCOME_TEXT[data?.outcome || ''] || '限额重置已返回'
      if (data?.outcome === 'unknown') toast.error(text)
      else toast.warning(text)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const busy = queryCredits.isPending || redeem.isPending
  const openConfirm = (card: ResetCredit) => {
    if (keyRef.current?.card !== card.ref) {
      keyRef.current = {
        card: card.ref || '',
        key: `claude-reset-${vm.id}-${randomUUID()}`,
      }
    }
    setPicked(card)
  }
  const fetchedAt = Date.parse(snapshot?.fetched_at || '')
  const pickedName = picked ? kindName(picked.kind) : ''
  const warnings = picked ? claudeResetWarnings(picked, usage, cards) : []
  const keepsWeekly = picked ? !windows(picked).includes('seven_day') : false
  const five = pct(usage?.fiveHour)
  const seven = pct(usage?.sevenDay)
  const fable = pct(usage?.fable)

  return (
    <div
      className='grid gap-2 border-t pt-3'
      data-row-actions
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <span className='text-xs text-muted-foreground'>
          重置卡{' '}
          <b className='font-semibold text-foreground tabular-nums'>
            {snapshot ? count : '—'}
          </b>{' '}
          张
        </span>
        <span className='flex items-center gap-2'>
          {Number.isFinite(fetchedAt) ? (
            <span className='text-[11px] text-muted-foreground tabular-nums'>
              查询于 {new Date(fetchedAt).toLocaleTimeString()}
            </span>
          ) : null}
          <Button
            size='sm'
            variant='outline'
            disabled={busy}
            title='查询 Claude 原生限额重置卡（只读，不消耗）'
            onClick={() => queryCredits.mutate()}
          >
            <RefreshCw
              className={cn('size-3', queryCredits.isPending && 'animate-spin')}
            />
            {queryCredits.isPending ? '查询中' : '限额查询'}
          </Button>
        </span>
      </div>
      {snapshot?.eligible === false ? (
        <p className='m-0 text-[11px] text-muted-foreground'>
          当前账号不可兑换
        </p>
      ) : null}
      {legacy ? (
        <p className='m-0 text-[11px] text-muted-foreground'>
          卡片信息是旧格式，点「限额查询」刷新后才能选卡
        </p>
      ) : null}
      {cards.length ? (
        <div className='divide-y rounded-md border'>
          {cards.map((card) => {
            const state = liveState(card, snapshot || {}, now)
            return (
              <div
                key={card.ref}
                className='grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-3 py-2'
              >
                <div className='text-sm font-semibold'>
                  {kindName(card.kind)}
                  <span className='ml-1.5 text-xs font-normal text-muted-foreground tabular-nums'>
                    ×{card.resets_left}
                  </span>
                </div>
                <Button
                  size='sm'
                  variant='outline'
                  className='row-span-3'
                  disabled={busy || state !== 'ready'}
                  title={`使用${spaced(kindName(card.kind))}`}
                  onClick={() => openConfirm(card)}
                >
                  <RotateCcw
                    className={cn(
                      'size-3',
                      redeem.isPending &&
                        redeem.variables?.ref === card.ref &&
                        'animate-spin'
                    )}
                  />
                  使用
                </Button>
                <div className='text-[11px] text-muted-foreground'>
                  {clearsText(card)}
                </div>
                <div className='text-[11px] text-muted-foreground'>
                  {card.expires_at ? (
                    <>
                      到期 <ResetAt value={card.expires_at} now={now} />
                    </>
                  ) : (
                    '不过期'
                  )}
                </div>
                {state === 'cooldown' ? (
                  <div className='text-[11px] text-[color:var(--status-warn)]'>
                    冷却中 ·{' '}
                    <ResetAt value={snapshot?.cooldown_until} now={now} />{' '}
                    后可用
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
      <ConfirmDialog
        open={picked != null}
        onOpenChange={(open) => {
          if (!open && !redeem.isPending) setPicked(null)
        }}
        title={`使用${spaced(pickedName)}？`}
        desc={
          picked ? (
            <div className='grid gap-2'>
              <p className='m-0'>
                会清：
                <b className='font-semibold text-foreground'>
                  {windows(picked)
                    .map((item) => WINDOW_LABEL[item])
                    .join('、') || '—'}
                </b>
                。
                {keepsWeekly
                  ? picked.gives_back_weekly
                    ? '7 天额度不清，只退回本周 Fable 用掉的那部分。'
                    : '7 天额度不清。'
                  : null}
              </p>
              {usage ? (
                <p className='m-0'>
                  这个槽现在：5 小时{' '}
                  <b className='font-semibold text-foreground'>
                    {five == null ? '—' : `${five}%`}
                  </b>{' '}
                  · 7 天{' '}
                  <b className='font-semibold text-foreground'>
                    {seven == null ? '—' : `${seven}%`}
                  </b>{' '}
                  · Fable{' '}
                  <b className='font-semibold text-foreground'>
                    {fable == null ? '无' : `${fable}%`}
                  </b>
                </p>
              ) : null}
              {warnings.length ? (
                <div className='grid gap-0.5 rounded-md bg-[color:var(--status-warn-bg)] px-2.5 py-2 text-[color:var(--status-warn)]'>
                  {warnings.map((line) => (
                    <span key={line}>{line}</span>
                  ))}
                </div>
              ) : null}
              <p className='m-0 text-xs'>
                用掉不能退回 · 这种卡还剩 {picked.resets_left} 张
              </p>
            </div>
          ) : (
            ''
          )
        }
        confirmText={`确认使用${spaced(pickedName)}`}
        cancelBtnText='取消'
        destructive
        isLoading={redeem.isPending}
        handleConfirm={() => picked && redeem.mutate(picked)}
      />
    </div>
  )
}

export function ClaudeResetActions({
  vm,
  compact = false,
  now = Date.now(),
  usage,
}: {
  vm: Vm
  compact?: boolean
  now?: number
  usage?: ResetUsage
}) {
  const canUse = useVmPerms().credential
  if (!canUse) return null
  return compact ? (
    <CompactResetActions vm={vm} />
  ) : (
    <FullResetActions vm={vm} now={now} usage={usage} />
  )
}
