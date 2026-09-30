import { queryOptions, useQueryClient } from '@tanstack/react-query'
import type { ProxyPoolPayload } from '@/types/panel-proxy'
import { api } from '@/lib/api'
import { dashboardQueryOptions } from '@/features/overview/queries'

export function proxiesQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'proxies'] as const,
    queryFn: () => api<ProxyPoolPayload>('/api/panel/proxies'),
  })
}

/** 代理池写操作后同时刷新池与槽位：绑定关系两边都展示。 */
export function useRefreshProxies() {
  const qc = useQueryClient()
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: proxiesQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: ['panel', 'vm'] }),
      qc.invalidateQueries({ queryKey: ['panel', 'vms'] }),
    ])
}
