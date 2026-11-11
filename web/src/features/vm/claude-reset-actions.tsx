import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { RefreshCw, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { randomUUID } from '@/lib/random-uuid'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { ResetAt } from '@/features/vm/detail-section-primitives'
import { vmQueryOptions, vmsListQueryOptions } from '@/features/vm/queries'
import { useVmPerms } from '@/features/vm/vm-perms'

type ResetCredit = {
  label?: string
  resets_left?: number
  expires_at?: string
  clears?: string[]
  redeemable?: boolean
}

type ResetSnapshot = {
  eligible?: boolean
  available_count?: number
  credits?: ResetCredit[]
  cooldown_until?: string
  fetched_at?: string
}

type ResetPayload = {
  outcome?: string
  reason?: string
  claude_reset_credits?: ResetSnapshot | null
}

const WINDOW_LABEL: Record<string, string> = {
  five_hour: '5 小时',
  seven_day: '7 天',
  seven_day_overage_included: 'Fable',
}

const OUTCOME_TEXT: Record<string, string> = {
  reset: '已使用一次限额重置',
  already_used: '这次重置已经用过',
  not_limited: '当前没有打满，未消耗重置',
  cooldown: '仍在冷却，未消耗重置',
  ineligible: '当前账号不能兑换',
  unknown: '结果未确认，已暂停该组织的再次兑换',
}

function windowText(clears: string[] | undefined) {
  return (clears || []).map((item) => WINDOW_LABEL[item] || item).join('、')
}

function useClaudeResetActions(vm: Vm) {
  const qc = useQueryClient()
  const [confirm, setConfirm] = useState(false)
  const keyRef = useRef('')
  const credits = vm.claude_reset_credits
  const available = Math.max(0, Number(credits?.available_count) || 0)
  const redeemable =
    credits?.credits?.find((credit) => credit.redeemable) ||
    credits?.credits?.[0]
  const expiry = redeemable?.expires_at
  const clears = windowText(redeemable?.clears)

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
      const count = Number(data?.claude_reset_credits?.available_count)
      toast.success(
        Number.isFinite(count) ? `已查询，可兑换 ${count} 次` : '已查询限额重置'
      )
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const redeem = useMutation({
    mutationFn: () =>
      api<ResetPayload>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/claude-reset/redeem`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': keyRef.current },
          signal: AbortSignal.timeout(90_000),
        }
      ),
    onSuccess: async (data) => {
      setConfirm(false)
      keyRef.current = ''
      await refreshAll()
      const text = OUTCOME_TEXT[data?.outcome || ''] || '限额重置已返回'
      if (data?.outcome === 'reset') toast.success(text)
      else if (data?.outcome === 'unknown') toast.error(text)
      else toast.warning(text)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const openConfirm = () => {
    if (!keyRef.current) {
      keyRef.current = `claude-reset-${vm.id}-${randomUUID()}`
    }
    setConfirm(true)
  }

  return {
    available,
    busy: queryCredits.isPending || redeem.isPending,
    clears,
    confirm,
    credits,
    expiry,
    openConfirm,
    queryCredits,
    redeem,
    setConfirm,
  }
}

export function ClaudeResetActions({
  vm,
  compact = false,
  now = Date.now(),
}: {
  vm: Vm
  compact?: boolean
  now?: number
}) {
  const {
    available,
    busy,
    clears,
    confirm,
    credits,
    expiry,
    openConfirm,
    queryCredits,
    redeem,
    setConfirm,
  } = useClaudeResetActions(vm)
  const canUse = useVmPerms().credential
  const held = (credits?.credits || []).reduce(
    (sum, credit) => sum + Math.max(0, Number(credit.resets_left) || 0),
    0
  )

  if (!canUse) return null

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-1',
        !compact && 'grid gap-2'
      )}
      data-row-actions
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div
        className={cn(
          'flex flex-wrap items-center',
          compact ? 'gap-1' : 'gap-2'
        )}
      >
        <Button
          size='sm'
          variant={compact ? 'ghost' : 'outline'}
          disabled={busy}
          title='查询 Claude 原生限额重置次数（只读，不消耗）'
          className={
            compact
              ? 'h-6 gap-1 px-1.5 text-[11px] text-muted-foreground'
              : undefined
          }
          onClick={() => queryCredits.mutate()}
        >
          <RefreshCw
            className={cn('size-3', queryCredits.isPending && 'animate-spin')}
          />
          {queryCredits.isPending
            ? '查询中'
            : `限额查询${credits ? ` ${available}` : ''}`}
        </Button>
        <Button
          size='sm'
          variant={compact ? 'ghost' : 'destructive'}
          disabled={busy || available < 1}
          title={
            available < 1
              ? '先查询 Claude 限额重置次数'
              : `消费 1 / ${available} 次 Claude 限额重置`
          }
          className={
            compact
              ? 'h-6 gap-1 px-1.5 text-[11px] text-muted-foreground disabled:text-muted-foreground/50'
              : undefined
          }
          onClick={openConfirm}
        >
          <RotateCcw
            className={cn('size-3', redeem.isPending && 'animate-spin')}
          />
          {redeem.isPending ? '使用中' : '限额重置'}
        </Button>
      </div>
      {!compact && credits ? (
        <div className='grid gap-1 text-[11px] text-muted-foreground'>
          {expiry ? (
            <p className='m-0'>
              最近一次到期 <ResetAt value={expiry} now={now} />
            </p>
          ) : null}
          {credits.cooldown_until ? (
            <p className='m-0'>
              冷却至 <ResetAt value={credits.cooldown_until} now={now} />
            </p>
          ) : null}
          {credits.eligible === false ? (
            <p className='m-0'>当前账号不可兑换</p>
          ) : null}
          {credits.eligible !== false && held > 0 && available < 1 ? (
            <p className='m-0'>有次数但当前不可用</p>
          ) : null}
        </div>
      ) : null}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title='使用一次限额重置'
        desc={`将消费 1 / ${available} 次上游原生限额重置${clears ? `（清除 ${clears}）` : ''}，不可退回。`}
        confirmText='确认使用'
        destructive
        isLoading={redeem.isPending}
        handleConfirm={() => redeem.mutate()}
      />
    </div>
  )
}
