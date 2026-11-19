import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { isAntigravityVm } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { useVmPerms } from '@/features/vm/vm-perms'
import { antigravityModelSyncRequest } from './antigravity-model-sync-api'
import { vmsListQueryOptions } from './queries'

export type AntigravityReasoningLevel = 'minimal' | 'low' | 'medium' | 'high'

export type AntigravityModelCatalog = {
  updated_at: string
  models: {
    id: string
    display_name?: string
    vendor?: string | null
    enabled?: boolean
    levels?: AntigravityReasoningLevel[]
  }[]
}

export function AntigravityModelSync({ vmId }: { vmId?: string }) {
  const qc = useQueryClient()
  const perms = useVmPerms()
  const [selected, setSelected] = useState('')
  const vms = useQuery({ ...vmsListQueryOptions(), enabled: !vmId })
  const slots = (vms.data?.items || []).filter(
    (vm) => isAntigravityVm(vm) && vm.antigravity?.authenticated === true
  )
  const target = vmId || selected || slots[0]?.id || ''
  const sync = useMutation({
    mutationFn: async (id: string) => {
      const request = antigravityModelSyncRequest(id)
      return api<AntigravityModelCatalog & { published_global?: boolean }>(
        request.url,
        {
          method: 'POST',
          body: JSON.stringify(request.body),
        }
      )
    },
    onSuccess: (data, id) => {
      toast.success(
        data.published_global
          ? `已同步 ${data.models.length} 个账号模型，并加入全局目录`
          : `已同步 ${data.models.length} 个账号可用模型`
      )
      void qc.invalidateQueries({ queryKey: ['panel', 'vm', id] })
      void qc.invalidateQueries({ queryKey: ['panel', 'vms'] })
      if (data.published_global) {
        void qc.invalidateQueries({ queryKey: ['panel', 'routing'] })
        void qc.invalidateQueries({ queryKey: ['panel', 'models'] })
        void qc.invalidateQueries({ queryKey: ['panel', 'vm'] })
      }
    },
    onError: (error: Error) => toast.error(error.message),
  })
  return (
    <div className='space-y-2'>
      {!vmId ? (
        <div className='space-y-1'>
          <Label htmlFor='agy-model-sync-slot'>已授权槽位</Label>
          <select
            id='agy-model-sync-slot'
            className='h-9 w-full rounded-md border bg-background px-3 text-sm'
            value={target}
            onChange={(event) => setSelected(event.target.value)}
            disabled={sync.isPending || !slots.length}
          >
            {!slots.length ? <option value=''>暂无已授权槽位</option> : null}
            {slots.map((slot) => (
              <option key={slot.id} value={slot.id}>
                {slot.name || slot.id}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <Button
        size='sm'
        variant='outline'
        loading={sync.isPending}
        disabled={!target || sync.isPending}
        onClick={() => sync.mutate(target)}
      >
        同步账号模型
      </Button>
      <p className='text-xs text-muted-foreground'>
        读取槽内官方客户端的模型目录，不发送推理请求。
        {perms.admin
          ? '新模型自动加入全局目录并启用；已有模型保留启停与显示设置。'
          : '仅更新当前槽位的可用模型；加入全局目录需管理员同步。'}
      </p>
    </div>
  )
}
