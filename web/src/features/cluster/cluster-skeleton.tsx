import { Skeleton } from '@/components/ui/skeleton'
import { CardGridSkeleton, TableSkeleton } from '@/components/page-skeletons'

export function ClusterSkeleton() {
  return (
    <div className='space-y-3'>
      <CardGridSkeleton cards={4} className='sm:grid-cols-2 xl:grid-cols-4' />
      <div className='rounded-xl border'>
        <Skeleton className='h-11 w-full rounded-none rounded-t-xl' />
        <div className='p-3'>
          <TableSkeleton rows={4} columns={8} />
        </div>
      </div>
      <Skeleton className='h-[260px] w-full rounded-xl' />
    </div>
  )
}
