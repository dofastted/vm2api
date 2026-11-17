import type { QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { cragHostStatusQueryOptions, vmsListQueryOptions } from './queries'

export type VmDeleteResult = {
  deleted: string
  reclaim_pending?: boolean
}

export async function completeVmDeletion(
  qc: QueryClient,
  result: VmDeleteResult,
  message = '已删除'
) {
  if (result.reclaim_pending) {
    toast.warning(message, {
      description: 'CRAG 绑定额度待回收确认；旧订阅需先启用槽位回收。',
    })
  } else {
    toast.success(message)
  }
  await Promise.all([
    qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
    qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
    qc.invalidateQueries({ queryKey: cragHostStatusQueryOptions().queryKey }),
  ])
}
