import { queryOptions } from '@tanstack/react-query'
import {
  getSchedulerPool,
  listSchedulerPools,
  listSchedulerSticky,
  type StickyQueryParams,
} from './api'

export const SCHEDULER_POOLS_KEY = ['panel', 'scheduler-pools'] as const

export function schedulerPoolsQueryOptions(refetchInterval?: number | false) {
  return queryOptions({
    queryKey: SCHEDULER_POOLS_KEY,
    queryFn: ({ signal }) => listSchedulerPools(signal),
    ...(refetchInterval ? { refetchInterval } : {}),
  })
}

export function schedulerPoolDetailQueryOptions(
  poolId: string,
  refetchInterval?: number | false
) {
  return queryOptions({
    queryKey: ['panel', 'scheduler-pools', poolId] as const,
    queryFn: ({ signal }) => getSchedulerPool(poolId, signal),
    enabled: Boolean(poolId),
    ...(refetchInterval ? { refetchInterval } : {}),
  })
}

export function schedulerStickyQueryOptions(params: StickyQueryParams) {
  return queryOptions({
    queryKey: ['panel', 'scheduler-sticky', params] as const,
    queryFn: ({ signal }) => listSchedulerSticky(params, signal),
  })
}
