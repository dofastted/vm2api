import { Skeleton } from '@/components/ui/skeleton'
import { CardGridSkeleton, TableSkeleton } from '@/components/page-skeletons'

export function ClusterSkeleton() {
  return (
    <div className='space-y-3'>
      <CardGridSkeleton cards={5} className='sm:grid-cols-2 xl:grid-cols-5' />
      <Skeleton className='h-[148px] w-full rounded-xl' />
      <div className='rounded-xl border'>
        <Skeleton className='h-11 w-full rounded-none rounded-t-xl' />
        <div className='p-3'>
          <TableSkeleton rows={3} columns={7} />
        </div>
      </div>
    </div>
  )
}
