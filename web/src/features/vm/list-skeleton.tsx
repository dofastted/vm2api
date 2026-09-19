import { Skeleton } from '@/components/ui/skeleton'
import { TableSkeleton } from '@/components/page-skeletons'

/** 对应：筛选筹码行 → 搜索 / 排序 / 视图工具行 → 表格（默认列表视图）。 */
export function VmListSkeleton() {
  return (
    <div>
      <div className='mb-3 flex flex-wrap gap-2'>
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={`filter-${i}`} className='h-8 w-20 rounded-md' />
        ))}
      </div>
      <div className='mb-4 flex flex-wrap items-center gap-2'>
        <Skeleton className='h-8 w-64 rounded-md' />
        <div className='ms-auto flex gap-2'>
          <Skeleton className='h-8 w-28 rounded-md' />
          <Skeleton className='h-8 w-10 rounded-md' />
          <Skeleton className='h-8 w-10 rounded-md' />
          <Skeleton className='h-8 w-10 rounded-md' />
        </div>
      </div>
      <TableSkeleton rows={8} columns={6} />
    </div>
  )
}
