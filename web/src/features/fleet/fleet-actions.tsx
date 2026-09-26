import { useState } from 'react'
import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { wrapSyncKernelFails } from '@/lib/wrap-health'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  dashboardQueryOptions,
  usageQueryOptions,
} from '@/features/overview/queries'
import { proxiesQueryOptions } from '@/features/proxies/queries'
import { vmsListQueryOptions } from '@/features/vm/queries'

type FleetAction = 'roll' | 'collect'

type FleetReport = {
  action?: FleetAction
  total?: number
  ok_count?: number
  items?: { id?: string; ok?: boolean }[]
}

type ProbeItem = {
  vm_id?: string
  id?: string
  ok?: boolean
  error?: unknown
}

function errorText(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>
    const nested = rec.error as Record<string, unknown> | undefined
    return String(
      rec.message ||
        nested?.message ||
        rec.code ||
        nested?.code ||
        JSON.stringify(value)
    )
  }
  return String(value)
}

async function invalidateFleet(qc: QueryClient) {
  await Promise.all([
    qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
    qc.invalidateQueries({ queryKey: usageQueryOptions().queryKey }),
    qc.invalidateQueries({ queryKey: proxiesQueryOptions().queryKey }),
    qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
    qc.invalidateQueries({
      predicate: (q) =>
        Array.isArray(q.queryKey) &&
        q.queryKey[0] === 'panel' &&
        q.queryKey[1] === 'vm',
    }),
  ])
}

export function FleetActions() {
  const qc = useQueryClient()
  const [fleetOpen, setFleetOpen] = useState(false)
  const refresh = useMutation({
    mutationFn: () => invalidateFleet(qc),
    onSuccess: () => toast.success('已刷新'),
  })
  const probe = useMutation({
    mutationFn: () =>
      api<{ items?: ProbeItem[] }>('/api/panel/probe', {
        method: 'POST',
        body: JSON.stringify({ hop: true, force: true }),
      }),
    onSuccess: async (data) => {
      const items = data.items || []
      const ok = items.filter((x) => x && x.ok).length
      const failed = items.filter((x) => x && !x.ok)
      if (failed.length) {
        const reasons = failed
          .slice(0, 2)
          .map(
            (x) => `${x.vm_id || x.id || '?'} ${errorText(x.error) || '失败'}`
          )
          .join('；')
        toast.error(
          `探测 ${ok}/${items.length} · 失败 ${failed.length}${reasons ? ` · ${reasons}` : ''}`
        )
      } else {
        toast.success(`探测完成 ${ok}/${items.length}`)
      }
      await invalidateFleet(qc)
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const fleet = useMutation({
    mutationFn: (action: FleetAction) =>
      api<FleetReport>('/api/panel/vms/fleet-update', {
        method: 'POST',
        body: JSON.stringify({ action, concurrency: 4 }),
      }),
    onSuccess: async (report) => {
      const items = report.items || []
      const total = report.total ?? items.length
      const ok = report.ok_count ?? items.filter((x) => x?.ok).length
      const failed = items.filter((x) => x && !x.ok).map((x) => x.id || '?')
      const label = report.action === 'collect' ? '仅采集' : '重载并采集'
      if (failed.length) {
        toast.error(`${label} ${ok}/${total} · 失败 ${failed.join('、')}`)
      } else {
        toast.success(`${label} ${ok}/${total}`)
      }
      setFleetOpen(false)
      await invalidateFleet(qc)
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const wrapSync = useMutation({
    mutationFn: () =>
      api<{
        ok_count?: number
        total?: number
        failed_count?: number
        items?: { ok?: boolean; kernel?: { ok?: boolean } }[]
      }>('/api/panel/wrap-cli/sync', {
        method: 'POST',
        body: JSON.stringify({ restart: true }),
      }),
    onSuccess: async (report) => {
      const total = report.total ?? 0
      const ok = report.ok_count ?? 0
      const kernelFail = wrapSyncKernelFails(report.items)
      if ((report.failed_count || 0) > 0) {
        toast.error(`kernel 重装 ${ok}/${total}`)
      } else if (kernelFail > 0) {
        toast.error(`kernel 文件 ${ok}/${total}，进程未起来 ${kernelFail}`)
      } else {
        toast.success(`kernel 重装 ${ok}/${total}`)
      }
      await invalidateFleet(qc)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  return (
    <div className='hidden items-center gap-2 md:flex'>
      <Button
        variant='outline'
        size='sm'
        onClick={() => refresh.mutate()}
        disabled={refresh.isPending}
        loading={refresh.isPending}
      >
        刷新
      </Button>
      <Button
        variant='outline'
        size='sm'
        onClick={() => probe.mutate()}
        disabled={probe.isPending}
        loading={probe.isPending}
      >
        额度探测
      </Button>
      <Button
        variant='outline'
        size='sm'
        onClick={() => setFleetOpen(true)}
        disabled={fleet.isPending}
        loading={fleet.isPending}
      >
        全槽更新
      </Button>
      <Button
        variant='outline'
        size='sm'
        onClick={() => wrapSync.mutate()}
        disabled={wrapSync.isPending}
        loading={wrapSync.isPending}
      >
        重装当前内核
      </Button>

      <Dialog open={fleetOpen} onOpenChange={setFleetOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>全槽更新</DialogTitle>
          </DialogHeader>
          <p className='text-sm text-muted-foreground'>
            滚动处理全部槽位的 kernel / slot runtime。不重启控制面，不 docker
            rm，不启动 Go worker hop。
          </p>
          <p className='text-sm text-muted-foreground'>
            重载会吃到新二进制再采集 guest 特征。KVM
            槽在适配器未接线时会失败并跳过。
          </p>
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() => setFleetOpen(false)}
              disabled={fleet.isPending}
            >
              取消
            </Button>
            <Button
              variant='outline'
              disabled={fleet.isPending}
              loading={fleet.isPending}
              onClick={() => fleet.mutate('collect')}
            >
              只采集
            </Button>
            <Button
              disabled={fleet.isPending}
              loading={fleet.isPending}
              onClick={() => fleet.mutate('roll')}
            >
              重载并采集
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
