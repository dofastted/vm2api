import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { VmPool } from '@/types/panel-keys'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  missingMemberIds,
  poolOwners,
  saveableMemberIds,
} from './vm-pool-members'

export function vmPoolsQueryOptions() {
  return {
    queryKey: ['panel', 'vm-pools'] as const,
    queryFn: () => api<{ pools?: VmPool[] }>('/api/panel/vm-pools'),
  }
}

export function VmPoolsCard({ vms }: { vms: Vm[] }) {
  const qc = useQueryClient()
  const q = useQuery(vmPoolsQueryOptions())
  const pools = q.data?.pools || []
  const refresh = () =>
    qc.invalidateQueries({ queryKey: vmPoolsQueryOptions().queryKey })

  const save = useMutation({
    mutationFn: (body: {
      id?: string
      name?: string
      enabled?: boolean
      vm_ids?: string[]
    }) => {
      if (!body.id) {
        return api('/api/panel/vm-pools', {
          method: 'POST',
          body: JSON.stringify({ name: body.name, vm_ids: body.vm_ids }),
        })
      }
      const { id, ...patch } = body
      return api(`/api/panel/vm-pools/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })
    },
    onSuccess: async () => {
      toast.success('账号池已保存')
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/panel/vm-pools/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    onSuccess: async () => {
      toast.success('账号池已删除')
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  return (
    <section className='mb-4 space-y-3 rounded-md border p-3'>
      <div>
        <h2 className='text-sm font-medium'>账号池</h2>
        <p className='text-xs text-muted-foreground'>
          一台槽只属于一个池。密钥绑定池之后，选槽、重试、排队和粘性会话都只落在当前成员里，池停用或为空时直接失败，不回落到全局。
        </p>
      </div>
      <PoolEditor
        vms={vms}
        owners={poolOwners(pools)}
        pending={save.isPending}
        onSubmit={(name, vmIds) => save.mutate({ name, vm_ids: vmIds })}
      />
      {pools.map((pool) => (
        <PoolRow
          key={pool.id}
          pool={pool}
          vms={vms}
          owners={poolOwners(pools, pool.id)}
          pending={save.isPending || remove.isPending}
          onSave={(patch) => save.mutate({ id: pool.id, ...patch })}
          onDelete={() => remove.mutate(pool.id)}
        />
      ))}
    </section>
  )
}

function PoolEditor({
  vms,
  owners,
  pending,
  onSubmit,
}: {
  vms: Vm[]
  owners: Map<string, VmPool>
  pending: boolean
  onSubmit: (name: string, vmIds: string[]) => void
}) {
  const [name, setName] = useState('')
  const [ids, setIds] = useState<string[]>([])
  return (
    <div className='space-y-2'>
      <div className='flex flex-wrap items-center gap-2'>
        <Input
          value={name}
          placeholder='池名称'
          className='max-w-xs'
          onChange={(e) => setName(e.target.value)}
        />
        <Button
          size='sm'
          disabled={pending || !name.trim()}
          onClick={() => {
            onSubmit(name.trim(), saveableMemberIds(ids, vms, owners))
            setName('')
            setIds([])
          }}
        >
          新建
        </Button>
      </div>
      <VmChecks vms={vms} ids={ids} owners={owners} onChange={setIds} />
    </div>
  )
}

function PoolRow({
  pool,
  vms,
  owners,
  pending,
  onSave,
  onDelete,
}: {
  pool: VmPool
  vms: Vm[]
  owners: Map<string, VmPool>
  pending: boolean
  onSave: (patch: {
    name?: string
    enabled?: boolean
    vm_ids?: string[]
  }) => void
  onDelete: () => void
}) {
  const [name, setName] = useState(pool.name)
  const [ids, setIds] = useState(pool.vm_ids)
  // Server membership wins once it actually changes (save dropped dead slots,
  // another pool took one) without clobbering local boxes on equal refetches.
  useEffect(() => setIds(pool.vm_ids), [pool.vm_ids])
  return (
    <div className='space-y-2 rounded-md border p-2'>
      <div className='flex flex-wrap items-center gap-2'>
        <Input
          value={name}
          className='max-w-xs'
          onChange={(e) => setName(e.target.value)}
        />
        <span className='text-xs text-muted-foreground'>
          {pool.enabled ? '启用' : '停用'}
        </span>
        <Button
          size='sm'
          variant='outline'
          disabled={pending || !name.trim()}
          onClick={() =>
            onSave({
              name: name.trim(),
              vm_ids: saveableMemberIds(ids, vms, owners),
            })
          }
        >
          保存成员
        </Button>
        <Button
          size='sm'
          variant='outline'
          disabled={pending}
          onClick={() => onSave({ enabled: !pool.enabled })}
        >
          {pool.enabled ? '停用' : '启用'}
        </Button>
        <Button
          size='sm'
          variant='destructive'
          disabled={pending}
          onClick={onDelete}
        >
          删除
        </Button>
      </div>
      <VmChecks vms={vms} ids={ids} owners={owners} onChange={setIds} />
    </div>
  )
}

function VmChecks({
  vms,
  ids,
  owners,
  onChange,
}: {
  vms: Vm[]
  ids: string[]
  owners: Map<string, VmPool>
  onChange: (ids: string[]) => void
}) {
  const missing = missingMemberIds(ids, vms)
  if (!vms.length)
    return <p className='text-xs text-muted-foreground'>还没有槽位。</p>
  return (
    <div className='space-y-1'>
      <div className='flex max-h-28 flex-wrap gap-x-3 gap-y-1 overflow-y-auto'>
        {vms.map((vm) => {
          const owner = owners.get(vm.id)
          return (
            <label
              key={vm.id}
              className='flex items-center gap-1 text-xs'
              title={owner ? `已在「${owner.name}」池` : undefined}
            >
              <input
                type='checkbox'
                disabled={!!owner}
                checked={!owner && ids.includes(vm.id)}
                onChange={(e) => {
                  onChange(
                    e.target.checked
                      ? [...ids, vm.id]
                      : ids.filter((id) => id !== vm.id)
                  )
                }}
              />
              {vm.id}
              {owner && (
                <span className='text-muted-foreground'>· {owner.name}</span>
              )}
            </label>
          )
        })}
      </div>
      {missing.length > 0 && (
        <p className='text-xs text-amber-600'>
          已不存在的槽位：{missing.join('、')}（保存时自动移除）
        </p>
      )}
    </div>
  )
}
