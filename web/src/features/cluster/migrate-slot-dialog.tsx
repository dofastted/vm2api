import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ClusterApiNode } from '@/types/panel-cluster'
import type { Vm } from '@/types/panel-vm'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { CLUSTER_NODES_KEY } from '@/features/cluster/queries'
import {
  migrationMemoryOptions,
  migrationPhase,
} from '@/features/cluster/slot-migration'

type MigrationJob = {
  id: string
  status: 'running' | 'done' | 'failed' | 'needs_attention'
  phase: string
  error?: string
  warning?: string
  backup_directory?: string | null
  copied_bytes?: number
}

export function MigrateSlotDialog({
  vm,
  nodes,
  onClose,
}: {
  vm: Vm | null
  nodes: ClusterApiNode[]
  onClose: () => void
}) {
  return (
    <Dialog
      open={!!vm}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>迁移 / 扩容槽位</DialogTitle>
          <DialogDescription>
            保留原盘和账号数据；暂停调度并排空请求后，关机迁移，再验证服务。不是热迁移。
          </DialogDescription>
        </DialogHeader>
        {vm ? <MigrationForm key={vm.id} vm={vm} nodes={nodes} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function MigrationForm({ vm, nodes }: { vm: Vm; nodes: ClusterApiNode[] }) {
  const qc = useQueryClient()
  const [target, setTarget] = useState(vm.node_id || '')
  const [memory, setMemory] = useState(vm.machine?.memory || '2g')
  const [confirmed, setConfirmed] = useState(false)
  const path = `/api/panel/vms/${encodeURIComponent(vm.id)}/migration`
  const key = ['panel', 'slot-migration', path] as const
  const job = useQuery({
    queryKey: key,
    queryFn: () => api<MigrationJob | null>(path),
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 3000 : false),
    refetchOnWindowFocus: true,
    retry: false,
  })
  const start = useMutation({
    mutationFn: () =>
      api<MigrationJob>(path, {
        method: 'POST',
        body: JSON.stringify({ target_node_id: target, memory }),
      }),
    onSuccess: (data) => {
      qc.setQueryData(key, data)
      setConfirmed(false)
    },
  })
  const status = job.data?.status
  const pending = status === 'running' || start.isPending
  const blocked =
    pending || status === 'needs_attention' || job.isPending || !!job.error
  useEffect(() => {
    if (!status || status === 'running') return
    qc.invalidateQueries({ queryKey: ['panel', 'dashboard'] })
    qc.invalidateQueries({ queryKey: CLUSTER_NODES_KEY })
    qc.invalidateQueries({ queryKey: ['panel', 'vms'] })
  }, [status, job.data?.id, qc])
  const eligible = nodes.filter(
    (n) => n.platform !== 'darwin' && n.link.state === 'ready'
  )
  const unchanged = target === vm.node_id && memory === vm.machine?.memory
  return (
    <div className='space-y-4 text-sm'>
      <p className='font-medium'>{vm.name || vm.id}</p>
      <label className='grid gap-1.5'>
        目标节点
        <select
          aria-label='目标节点'
          className='h-9 rounded-md border bg-background px-2'
          value={target}
          disabled={blocked}
          onChange={(e) => {
            setTarget(e.target.value)
            setConfirmed(false)
          }}
        >
          <option value='' disabled>
            选择已连接的 Linux 节点
          </option>
          {eligible.map((n) => (
            <option key={n.id} value={n.id}>
              {n.label || n.id}
              {n.id === vm.node_id ? '（原节点，仅扩容）' : ''}
            </option>
          ))}
        </select>
      </label>
      <label className='grid gap-1.5'>
        迁移后内存
        <select
          aria-label='迁移后内存'
          className='h-9 rounded-md border bg-background px-2'
          value={memory}
          disabled={blocked}
          onChange={(e) => {
            setMemory(e.target.value)
            setConfirmed(false)
          }}
        >
          {migrationMemoryOptions(vm.machine?.memory).map((m) => (
            <option key={m} value={m}>
              {m.toUpperCase()}
            </option>
          ))}
        </select>
      </label>
      <p className='text-xs leading-relaxed text-muted-foreground'>
        仅支持运行中的远程 Linux Claude KVM（不含 crag）
        槽和内存扩容。两端镜像须完全一致；跨节点的直连或回环出口会被拒绝。任务串行执行、限速传盘，可能需要数十分钟。原节点冷盘保留为回滚资料，不自动删除。
      </p>
      <label className='flex items-start gap-2'>
        <input
          type='checkbox'
          className='mt-1'
          checked={confirmed}
          disabled={blocked}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        我确认短暂停机；如预检不通过，不会停止原槽。
      </label>
      {job.data ? (
        <div role='status' className='space-y-1 rounded-md border p-3'>
          <p>{migrationPhase(job.data.phase)}</p>
          {job.data.copied_bytes != null ? (
            <p className='text-xs text-muted-foreground'>
              已校验复制 {(job.data.copied_bytes / 1024 ** 2).toFixed(1)} MiB
            </p>
          ) : null}
          {job.data.error ? (
            <p className='text-destructive'>{job.data.error}</p>
          ) : null}
          {job.data.warning ? (
            <p className='text-amber-600'>{job.data.warning}</p>
          ) : null}
          {job.data.backup_directory ? (
            <p className='text-xs break-all text-muted-foreground'>
              原节点冷盘：{job.data.backup_directory}
            </p>
          ) : null}
          {pending ? (
            <p className='text-xs text-muted-foreground'>
              关闭窗口不会取消任务；可重新打开查看进度。
            </p>
          ) : null}
        </div>
      ) : null}
      {start.error || job.error ? (
        <p role='alert' className='text-destructive'>
          {(start.error || job.error)?.message}
        </p>
      ) : null}
      <Button
        disabled={
          blocked ||
          !target ||
          !confirmed ||
          unchanged ||
          vm.status !== 'running'
        }
        onClick={() => start.mutate()}
      >
        {pending ? '正在处理…' : '预检并执行'}
      </Button>
    </div>
  )
}
