import { queryOptions } from '@tanstack/react-query'
import type { TwoFactorStatus } from '@/types/panel-auth'
import { twoFactorStatusRequest } from '@/lib/api'

export const TWO_FACTOR_QUERY_KEY = ['panel', '2fa'] as const

export function twoFactorQueryOptions() {
  return queryOptions({
    queryKey: TWO_FACTOR_QUERY_KEY,
    queryFn: (): Promise<TwoFactorStatus> => twoFactorStatusRequest(),
    // 安全状态不做后台缓存复用，进页面即取最新。
    staleTime: 0,
  })
}
