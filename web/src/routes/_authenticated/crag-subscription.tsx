import { createFileRoute } from '@tanstack/react-router'
import { CragSubscriptionPage } from '@/features/billing/crag-shop'

export const Route = createFileRoute('/_authenticated/crag-subscription')({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(search.product === 'craggemini'
      ? { product: 'craggemini' as const }
      : {}),
  }),
  component: CragSubscriptionPage,
})
