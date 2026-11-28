import { createFileRoute } from '@tanstack/react-router'
import { PoolsListPage } from '@/features/pools/list-page'

export const Route = createFileRoute('/_authenticated/pools/')({
  component: PoolsListPage,
})
