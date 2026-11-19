import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ScheduleState, Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { expiresAtToMs } from '@/lib/fable-status'
import { isRestrictedSchedule, restrictionUntilOf } from '@/lib/vm-status'
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { vmQueryOptions, vmsListQueryOptions } from '@/features/vm/queries'

function formatRestrictionUntil(until: number | null | undefined): string {
  const ms = expiresAtToMs(until)
  if (!ms) return ''
  return new Date(ms).toLocaleString()
}

export function vmSchedulableProps(vm: Vm) {
  const scheduleState: ScheduleState | undefined = isRestrictedSchedule(vm)
    ? 'restricted'
    : vm.schedule_state
  return {
    vmId: vm.id,
    // 受限（含维护 / 代理暂停）仍是「开」：开关只表达操作员意图和不可调度。
    schedulable:
      scheduleState === 'restricted'
        ? true
        : scheduleState
          ? scheduleState === 'on'
          : vm.schedulable !== false,
    scheduleState,
    restrictionUntil: restrictionUntilOf(vm),
    restrictionReason: vm.restriction_reason,
    unschedulableText: vm.unschedulable_text || vm.unschedulable_reason || null,
  }
}

export function SchedulableSwitch({
  vmId,
  schedulable,
  scheduleState,
  restrictionUntil,
  unschedulableText,
  className,
  unsupported = false,
}: {
  vmId: string
  schedulable: boolean
  scheduleState?: ScheduleState
  restrictionUntil?: number | null
  restrictionReason?: string | null
  unschedulableText?: string | null
  className?: string
  unsupported?: boolean
}) {
  const qc = useQueryClient()
  const restricted = scheduleState === 'restricted'
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  const checked = !unsupported && (optimistic ?? schedulable)
  const mutation = useMutation({
    mutationFn: (next: boolean) =>
      api(`/api/panel/vms/${encodeURIComponent(vmId)}/schedulable`, {
        method: 'POST',
        body: JSON.stringify({ schedulable: next }),
      }),
    onMutate: (next) => setOptimistic(next),
    onSuccess: async (_data, next) => {
      toast.success(next ? '已开启调度' : '已关闭调度')
      await Promise.all([
        qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: vmQueryOptions(vmId).queryKey }),
      ])
    },
    onError: (error: Error) => {
      setOptimistic(null)
      toast.error(error.message)
    },
    onSettled: () => setOptimistic(null),
  })

  const untilText = formatRestrictionUntil(restrictionUntil)
  const tooltip = unsupported
    ? '当前槽位不支持 API 调度'
    : scheduleState === 'unschedulable' && !checked
      ? `不可调度：${unschedulableText || '错误'}。处理后点击重新开启调度`
      : restricted && checked
        ? untilText
          ? `调度开，当前受限至 ${untilText}`
          : '调度开，当前受限'
        : checked
          ? '点击关闭调度'
          : '点击开启调度'

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={className}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <Switch
            checked={checked}
            disabled={unsupported || mutation.isPending}
            onCheckedChange={(next) => mutation.mutate(next)}
            aria-label={tooltip}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
