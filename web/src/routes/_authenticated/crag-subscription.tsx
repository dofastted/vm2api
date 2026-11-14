import { createFileRoute } from '@tanstack/react-router'
import { CragSubscriptionPage } from '@/features/billing/crag-shop'

export const Route = createFileRoute('/_authenticated/crag-subscription')({
  component: CragSubscriptionPage,
})
