import { useQuery } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { meQueryOptions } from '@/features/auth/queries'
import { rentedMark } from '@/features/vm/vm-owner'

/** Admin-only。有租户才显示；平台池不占这一格。 */
export function VmRentedMark({ vm }: { vm: Vm }) {
  const me = useQuery(meQueryOptions())
  if (me.data?.role !== 'admin') return null
  const label = rentedMark(vm.owner_user_id)
  if (!label) return null
  return (
    <span
      className='rounded bg-[color:var(--status-warn-bg)] px-1 font-semibold text-[color:var(--status-warn)]'
      title='已分配租户'
    >
      {label}
    </span>
  )
}
