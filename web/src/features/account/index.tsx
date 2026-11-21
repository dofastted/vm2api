import { useQuery } from '@tanstack/react-query'
import { useAuthStore } from '@/stores/auth-store'
import { PageHeader } from '@/components/page-header'
import { QueryGate } from '@/components/query-gate'
import { twoFactorQueryOptions } from './queries'
import { TwoFactorPane } from './two-factor-pane'

/**
 * 账号安全页。路由在 `ROUTE_VIEWS` 里映射为 `null`，
 * 所以任何角色都能管理自己的登录鉴权，不需要 settings 视图权限。
 */
export function AccountPage() {
  const user = useAuthStore((s) => s.user) || ''
  const { data, isPending, error } = useQuery(twoFactorQueryOptions())
  return (
    <PageHeader
      title='账号安全'
      description={user ? `当前账号：${user}` : '当前登录账号的登录鉴权设置'}
    >
      <div className='max-w-2xl'>
        <QueryGate loading={isPending} error={error}>
          {data ? <TwoFactorPane status={data} /> : null}
        </QueryGate>
      </div>
    </PageHeader>
  )
}
