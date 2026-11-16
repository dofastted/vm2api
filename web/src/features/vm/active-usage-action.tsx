import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { vmQueryOptions, vmsListQueryOptions } from './queries'
import { useVmPerms } from './vm-perms'

export function ActiveUsageAction({ vm }: { vm: Vm }) {
  const qc = useQueryClient()
  const canUse = useVmPerms().usageQuery
  const query = useMutation({
    mutationKey: ['active-usage', vm.id],
    mutationFn: () =>
      api(`/api/panel/vms/${encodeURIComponent(vm.id)}/usage/query`, {
        method: 'POST',
        signal: AbortSignal.timeout(75_000),
      }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
        qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
      ])
      toast.success('已更新官方额度')
    },
    onError: (error: Error) => toast.error(error.message),
  })
  if (!canUse) return null
  const unsupported = ['official-setup-token', 'apikey'].includes(
    vm.credential_mode || ''
  )
  return (
    <div
      data-row-actions
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Button
        type='button'
        size='sm'
        variant='ghost'
        className='h-6 gap-1 px-1.5 text-[11px] text-muted-foreground'
        disabled={query.isPending || !vm.has_token || unsupported}
        loading={query.isPending}
        title={
          unsupported
            ? '当前凭证不支持官方额度查询，请导入完整 OAuth'
            : '查询官方最新额度并更新用量'
        }
        onClick={() => query.mutate()}
      >
        <RefreshCw className='size-3' />
        {query.isPending ? '查询中' : '主动查询'}
      </Button>
    </div>
  )
}
