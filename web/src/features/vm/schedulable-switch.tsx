import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
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
import { vmQueryOptions } from '@/features/vm/queries'

function formatRestrictionUntil(until: number | null | undefined): string {
  const ms = expiresAtToMs(until)
  if (!ms) return ''
  return new Date(ms).toLocaleString()
}

export function vmSchedulableProps(vm: Vm) {
  return {
    vmId: vm.id,
    schedulable: vm.schedulable !== false,
    scheduleState: isRestrictedSchedule(vm)
      ? ('restricted' as const)
      : vm.schedule_state,
    restrictionUntil: restrictionUntilOf(vm),
    restrictionReason: vm.restriction_reason,
  }
}

export function SchedulableSwitch({
  vmId,
  schedulable,
  scheduleState,
  restrictionUntil,
  className,
}: {
  vmId: string
  schedulable: boolean
  scheduleState?: 'on' | 'restricted' | 'off'
  restrictionUntil?: number | null
  restrictionReason?: string | null
  className?: string
}) {
  const qc = useQueryClient()
  const restricted = scheduleState === 'restricted'
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  const checked = optimistic ?? schedulable
  const mutation = useMutation({
    mutationFn: (next: boolean) =>
      api(`/api/panel/vms/${encodeURIComponent(vmId)}/schedulable`, {
        method: 'POST',
        body: JSON.stringify({ schedulable: next }),
      }),
    onMutate: (next) => setOptimistic(next),
    onSuccess: async (_data, next) => {
      toast.success(next ? '已开启调度' : '已关闭调度')
      await qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey })
      await qc.invalidateQueries({ queryKey: vmQueryOptions(vmId).queryKey })
    },
    onError: (error: Error) => {
      setOptimistic(null)
      toast.error(error.message)
    },
    onSettled: () => setOptimistic(null),
  })

  const untilText = formatRestrictionUntil(restrictionUntil)
  const tooltip =
    restricted && checked
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
            disabled={mutation.isPending}
            onCheckedChange={(next) => mutation.mutate(next)}
            aria-label={tooltip}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
