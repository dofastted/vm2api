import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { VIEW_TITLES } from '@/config/nav'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { wrapSyncKernelFails } from '@/lib/wrap-health'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { CardGridSkeleton } from '@/components/page-skeletons'
import { QueryGate } from '@/components/query-gate'
import { dashboardQueryOptions } from '@/features/overview/queries'
import {
  inferenceEngineLabel,
  normalizeInferenceEngine,
} from '@/features/vm/engine-contract'
import {
  makeWrapSample,
  promoteWrapSample,
  repairWrapSample,
  syncWrapSample,
  wrapSampleQueryOptions,
  type WrapSyncReport,
} from '@/features/wrap/queries'

function sampleDirLabel(dir?: string) {
  if (!dir) return 'share/wrap-cli'
  const parts = dir.replace(/\\/g, '/').split('/')
  const i = parts.lastIndexOf('share')
  if (i >= 0) return parts.slice(i).join('/')
  return parts.slice(-2).join('/')
}

function osOf(vm: Vm) {
  const runtime = vm.runtime && typeof vm.runtime === 'object' ? vm.runtime : {}
  const os = String(runtime.os || runtime.image || vm.kernel || '').trim()
  return os || '—'
}

function engineOf(vm: Vm) {
  return vm.resolved_inference_engine || vm.inference_engine || 'auto'
}

function toastSync(report: WrapSyncReport) {
  const total = report.total ?? 0
  const ok = report.ok_count ?? 0
  const failed = report.failed_count ?? 0
  const kernelFail = wrapSyncKernelFails(report.items)
  if (failed > 0) toast.error(`wrap 母样本同步 ${ok}/${total}`)
  else if (kernelFail > 0)
    toast.error(`wrap 文件 ${ok}/${total}，kernel 未起来 ${kernelFail}`)
  else toast.success(`wrap 母样本同步 ${ok}/${total}`)
}

function Flag({ ok, label }: { ok?: boolean; label: string }) {
  return (
    <div className='flex items-center justify-between gap-2 text-sm'>
      <span className='text-muted-foreground'>{label}</span>
      <span className={ok ? 'text-foreground' : 'text-destructive'}>
        {ok ? '有' : '缺'}
      </span>
    </div>
  )
}

export function WrapSamplePage() {
  const qc = useQueryClient()
  const sample = useQuery(wrapSampleQueryOptions())
  const dash = useQuery(dashboardQueryOptions())
  const vms: Vm[] = dash.data?.vms || []
  const [restart, setRestart] = useState(true)
  const [selected, setSelected] = useState<string[]>([])
  const [promoteId, setPromoteId] = useState<string | null>(null)
  const [makeOpen, setMakeOpen] = useState(false)
  const [glibcVm, setGlibcVm] = useState('')

  const rustVms = useMemo(
    () => vms.filter((vm) => engineOf(vm) === 'rust'),
    [vms]
  )

  const invalidate = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: wrapSampleQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
    ])
  }

  const sync = useMutation({
    mutationFn: () =>
      syncWrapSample({
        ids: selected.length ? selected : undefined,
        restart,
      }),
    onSuccess: async (report) => {
      toastSync(report)
      await invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const promote = useMutation({
    mutationFn: (id: string) => promoteWrapSample(id),
    onSuccess: async (_data, id) => {
      toast.success(`已从 ${id} 设为 wrap 母样本`)
      setPromoteId(null)
      await invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const make = useMutation({
    mutationFn: () => makeWrapSample({ glibc_vm: glibcVm || undefined }),
    onSuccess: async () => {
      toast.success('已单独制作 wrap 母样本')
      setMakeOpen(false)
      await invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const repair = useMutation({
    mutationFn: (id: string) => repairWrapSample(id),
    onSuccess: async (report, id) => {
      const kernelOk = report.kernel?.ok !== false
      toast[kernelOk ? 'success' : 'error'](
        kernelOk
          ? `${id} 已从此样本重装 wrap`
          : `${id} wrap 文件已写入，kernel 未起来`
      )
      await invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const toggle = (id: string, on: boolean) => {
    setSelected((cur) =>
      on ? Array.from(new Set([...cur, id])) : cur.filter((x) => x !== id)
    )
  }

  const data = sample.data
  const complete = data?.ok === true

  return (
    <PageHeader
      title={VIEW_TITLES.wrap}
      extra={
        <div className='flex gap-2'>
          <Button
            size='sm'
            variant='outline'
            disabled={make.isPending}
            loading={make.isPending}
            onClick={() => setMakeOpen(true)}
          >
            制作母样本
          </Button>
          <Button
            size='sm'
            disabled={!complete || sync.isPending}
            loading={sync.isPending}
            onClick={() => sync.mutate()}
          >
            {selected.length ? `同步所选 ${selected.length} 槽` : '全槽同步'}
          </Button>
        </div>
      }
    >
      <QueryGate
        loading={sample.isLoading || dash.isLoading}
        error={sample.error || dash.error}
        skeleton={
          <CardGridSkeleton cards={2} className='grid gap-4 lg:grid-cols-2' />
        }
      >
        <p className='mb-4 max-w-3xl text-sm leading-relaxed text-muted-foreground'>
          母样本是唯一一份已验证的 wrap 运行时（patched Claude Code + kernel +
          CONNECT 桥）。同步只覆盖槽内运行时目录，不改票、不改 SOCKS、不 docker
          rm。Debian 12 靠样本里的 glibc 2.39 shim。
        </p>
        <div className='grid gap-4 lg:grid-cols-2'>
          <Card>
            <CardHeader>
              <CardTitle>当前母样本</CardTitle>
            </CardHeader>
            <CardContent className='space-y-2'>
              {complete ? (
                <>
                  <div className='flex items-center justify-between gap-2 text-sm'>
                    <span className='text-muted-foreground'>目录</span>
                    <code className='text-xs'>{sampleDirLabel(data?.dir)}</code>
                  </div>
                  <div className='flex items-center justify-between gap-2 text-sm'>
                    <span className='text-muted-foreground'>来源</span>
                    <span>
                      {data?.meta?.source === 'manual'
                        ? '单独制作'
                        : data?.meta?.source_vm || '—'}
                    </span>
                  </div>
                  <div className='flex items-center justify-between gap-2 text-sm'>
                    <span className='text-muted-foreground'>捕获时间</span>
                    <span className='font-mono text-xs'>
                      {data?.meta?.captured_at || '—'}
                    </span>
                  </div>
                  <Flag ok={data?.kernel_bin} label='kernel.bin' />
                  <Flag ok={data?.wrapper} label='kernel wrapper' />
                  <Flag ok={data?.glibc_shim} label='glibc 2.39 shim' />
                </>
              ) : (
                <EmptyState
                  reason={
                    data?.error ||
                    '还没有可用母样本。点「制作母样本」用 share/wrap-cli 现有文件重整，或从已停的 rust 槽晋升。不要对正在跑 wrap 的槽原地覆盖 bun。'
                  }
                />
              )}
              <label className='mt-3 flex items-center gap-2 text-sm'>
                <Checkbox
                  checked={restart}
                  onCheckedChange={(v) => setRestart(v === true)}
                />
                同步后重启 rust kernel（默认开，让 CONNECT 桥跟着起来）
              </label>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>怎么用</CardTitle>
            </CardHeader>
            <CardContent className='space-y-2 text-sm leading-relaxed text-muted-foreground'>
              <p>
                1. 「制作母样本」只重整 <code>share/wrap-cli</code>
                （补 kernel wrapper / shim），不从在跑槽拷贝。
              </p>
              <p>
                2. 已验证的 rust 槽仍可「设为母样本」。全槽同步把这一份铺进每台{' '}
                <code>.kin</code>。
              </p>
              <p>
                3. 单槽「重装 wrap」只修这一台，不碰凭证。覆盖在跑的 bun 会先
                unlink 再换上新文件。
              </p>
            </CardContent>
          </Card>
        </div>

        <Card className='mt-4'>
          <CardHeader>
            <CardTitle>槽位</CardTitle>
          </CardHeader>
          <CardContent>
            {vms.length === 0 ? (
              <EmptyState
                reason='还没有槽位。'
                actionLabel='去虚拟机'
                to='/vm'
              />
            ) : (
              <div className='overflow-x-auto'>
                <table className='w-full text-sm'>
                  <thead className='text-left text-muted-foreground'>
                    <tr className='border-b'>
                      <th className='w-8 py-2 font-medium'>选</th>
                      <th className='py-2 font-medium'>槽</th>
                      <th className='py-2 font-medium'>OS</th>
                      <th className='py-2 font-medium'>引擎</th>
                      <th className='py-2 font-medium'>母本</th>
                      <th className='py-2 text-right font-medium'>动作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vms.map((vm) => {
                      const engine = engineOf(vm)
                      const rust = engine === 'rust'
                      const source = data?.meta?.source_vm === vm.id
                      return (
                        <tr key={vm.id} className='border-b last:border-0'>
                          <td className='py-2'>
                            <Checkbox
                              checked={selected.includes(vm.id)}
                              onCheckedChange={(v) => toggle(vm.id, v === true)}
                              aria-label={`选择 ${vm.id}`}
                            />
                          </td>
                          <td className='py-2 font-mono text-xs'>
                            <Link
                              to='/vm/$id'
                              params={{ id: vm.id }}
                              className='underline underline-offset-4'
                            >
                              {vm.id}
                            </Link>
                          </td>
                          <td className='py-2 text-muted-foreground'>
                            {osOf(vm)}
                          </td>
                          <td className='py-2'>
                            {inferenceEngineLabel(
                              normalizeInferenceEngine(engine, 'auto')
                            )}
                          </td>
                          <td className='py-2 text-muted-foreground'>
                            {source
                              ? '当前来源'
                              : rust
                                ? '可晋升'
                                : 'go 槽只收文件'}
                          </td>
                          <td className='py-2'>
                            <div className='flex justify-end gap-2'>
                              <Button
                                size='sm'
                                variant='outline'
                                disabled={!rust || promote.isPending}
                                onClick={() => setPromoteId(vm.id)}
                              >
                                设为母样本
                              </Button>
                              <Button
                                size='sm'
                                variant='outline'
                                disabled={!complete || repair.isPending}
                                loading={
                                  repair.isPending && repair.variables === vm.id
                                }
                                onClick={() => repair.mutate(vm.id)}
                              >
                                重装 wrap
                              </Button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {rustVms.length === 0 ? (
              <p className='mt-3 text-xs text-muted-foreground'>
                没有 wrap cli-hop 槽时仍可同步文件，但不会启动 wrap kernel。
              </p>
            ) : null}
          </CardContent>
        </Card>
      </QueryGate>

      <ConfirmDialog
        open={!!promoteId}
        onOpenChange={(open) => {
          if (!open) setPromoteId(null)
        }}
        title='覆盖 wrap 母样本？'
        desc={`用 ${promoteId || ''} 槽内已验证的 .kin 覆盖 share/wrap-cli。不会复制凭证或 SOCKS。`}
        confirmText='设为母样本'
        cancelBtnText='取消'
        isLoading={promote.isPending}
        handleConfirm={() => {
          if (promoteId) promote.mutate(promoteId)
        }}
      />
      <ConfirmDialog
        open={makeOpen}
        onOpenChange={setMakeOpen}
        title='单独制作 wrap 母样本？'
        desc='用当前 share/wrap-cli 里已有的 bun / CLI / kernel 重整 wrapper 和 shim，不从正在运行的槽拷贝。缺文件会失败。Debian 12 可从一台 Ubuntu 槽拷 glibc 2.39 shim。'
        confirmText='制作'
        cancelBtnText='取消'
        isLoading={make.isPending}
        handleConfirm={() => make.mutate()}
      >
        <div className='space-y-1'>
          <p className='text-sm'>glibc shim 来源槽（可选）</p>
          <Select
            value={glibcVm || 'none'}
            onValueChange={(v) => setGlibcVm(v === 'none' ? '' : v)}
          >
            <SelectTrigger aria-label='glibc shim 来源槽'>
              <SelectValue placeholder='不拷 shim' />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='none'>不拷 shim</SelectItem>
              {vms.map((vm) => (
                <SelectItem key={vm.id} value={vm.id}>
                  {vm.id} · {osOf(vm)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </ConfirmDialog>
    </PageHeader>
  )
}
