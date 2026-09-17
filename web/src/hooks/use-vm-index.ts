import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { indexVms } from '@/lib/vm-kind'
import { dashboardQueryOptions } from '@/features/overview/queries'

/** 总览已缓存的槽位表，给日志 / 计费 / 用量拼邮箱和平台徽标。 */
export function useVmIndex() {
  const dash = useQuery(dashboardQueryOptions())
  const vms = useMemo(() => indexVms(dash.data?.vms), [dash.data?.vms])
  return { vms, list: dash.data?.vms || [], isLoading: dash.isLoading }
}
