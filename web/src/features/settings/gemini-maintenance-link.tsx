import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { GEMINI_MAINTENANCE_SECTION_ID } from '@/lib/gemini-recovery'
import { meQueryOptions } from '@/features/auth/queries'

export function GeminiMaintenanceLink() {
  const me = useQuery(meQueryOptions())
  return (
    <span className='block text-sm'>
      {me.data?.role === 'admin' ? (
        <Link
          to='/settings/$tab'
          params={{ tab: 'gemini' }}
          hash={GEMINI_MAINTENANCE_SECTION_ID}
          className='text-primary underline underline-offset-4'
        >
          设置 → Gemini：诊断与维护
        </Link>
      ) : (
        <span className='text-muted-foreground'>
          请联系管理员在「设置 → Gemini」诊断与维护。
        </span>
      )}
    </span>
  )
}
