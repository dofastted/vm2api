import { queryOptions, type QueryClient } from '@tanstack/react-query'
import type { ModelsPayload } from '@/types/panel-models'
import type { PricingPayload } from '@/types/panel-pricing'
import { api } from '@/lib/api'
import type { ModelPlatform, PolicyPayload } from '@/features/models/policy'

export function modelPolicyQueryOptions(platform: ModelPlatform = 'anthropic') {
  return queryOptions({
    queryKey: ['panel', 'model-policy', platform] as const,
    queryFn: () =>
      api<PolicyPayload>(`/api/panel/model-policy?platform=${platform}`),
  })
}

export function modelsQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'models'] as const,
    queryFn: () => api<ModelsPayload>('/api/panel/models'),
  })
}

export function pricingQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'pricing'] as const,
    queryFn: () => api<PricingPayload>('/api/panel/pricing'),
  })
}

export async function invalidatePricing(qc: QueryClient) {
  await Promise.all([
    qc.invalidateQueries({ queryKey: ['panel', 'pricing'] }),
    qc.invalidateQueries({ queryKey: ['panel', 'model-policy'] }),
  ])
}
