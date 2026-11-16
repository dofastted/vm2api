import { createFileRoute } from '@tanstack/react-router'
import { CragDevicePurchasePage } from '@/features/billing/crag-shop'

export const Route = createFileRoute('/crag-purchase')({
  component: CragDevicePurchasePage,
})
