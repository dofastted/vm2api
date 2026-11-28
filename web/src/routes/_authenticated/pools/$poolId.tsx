import { createFileRoute } from '@tanstack/react-router'
import { PoolDetailPage } from '@/features/pools/detail-page'

export const Route = createFileRoute('/_authenticated/pools/$poolId')({
  component: PoolDetailPage,
})
