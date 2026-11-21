import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { CragLicenseStatus, Vm } from '@/types/panel-vm'
import {
  CheckCircle2,
  Download,
  KeyRound,
  Loader2,
  Power,
  RefreshCw,
  Terminal,
  TriangleAlert,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { isApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { isCodexVm } from '@/lib/vm-kind'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/components/page-header'
import { QueryGate } from '@/components/query-gate'
import { meQueryOptions } from '@/features/auth/queries'
import { dashboardQueryOptions } from '@/features/overview/queries'
import {
  CragRuntimeCounts,
  CragRuntimeDetail,
} from '@/features/vm/crag-runtime-counts'
import { cragHostStatusQueryOptions } from '@/features/vm/queries'
import { KernelLicenseDialog } from './license-dialog'
import {
  installKernelTargets,
  cancelKernelInstall,
  kernelCatalogQueryOptions,
  kernelVersionsQueryOptions,
  pullKernelRelease,
  updateCragTargets,
  type KernelId,
  type KernelInstallItem,
  type KernelTarget,
} from './queries'

const KERNEL_NAMES = { 'cli-node': 'cli-node', crag: 'CRAG' } as const
const LICENSE_LABELS: Record<CragLicenseStatus['status'], string> = {
  valid: '授权有效',
  unlicensed: '未授权',
  expired: '已到期',
  not_yet_valid: '尚未生效',
  invalid: '授权无效',
  unconfigured: '未配置',
}

const VM_STATUS: Record<string, string> = {
  running: '运行中',
  stopped: '已停用',
  created: '未启动',
  unknown: '未知',
  error: '异常',
}

type InstallProgress = {
  total: number
  completed: number
  activeId: string | null
  results: Record<string, KernelInstallItem>
}

/**
 * `crag-update` swaps the payload on slots that already run CRAG; `install`
 * is the ordinary path that can also switch a slot's kernel type.
 */
type InstallMode = 'install' | 'crag-update'
type ConfirmState = { targets: KernelTarget[]; mode: InstallMode }

export function WrapSamplePage() {
  const qc = useQueryClient()
  const catalog = useQuery(kernelCatalogQueryOptions())
  const dashboard = useQuery(dashboardQueryOptions())
  const me = useQuery(meQueryOptions())
  const canEdit = me.data?.role === 'admin'
  const cragHost = useQuery({
    ...cragHostStatusQueryOptions(),
    enabled: canEdit,
    refetchInterval: canEdit ? 10_000 : false,
  })
  const cragStatus = canEdit && !cragHost.isError ? cragHost.data : undefined
  const [versionMenuOpened, setVersionMenuOpened] = useState(false)
  const versions = useQuery({
    ...kernelVersionsQueryOptions(),
    enabled: canEdit && versionMenuOpened,
  })
  const [selectedTags, setSelectedTags] = useState<Record<KernelId, string>>({
    'cli-node': 'latest',
    crag: 'latest',
  })
  const [drafts, setDrafts] = useState<Record<string, KernelId>>({})
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [licenseVm, setLicenseVm] = useState<Vm | null>(null)
  const [installing, setInstalling] = useState(false)
  const [job, setJob] = useState<InstallProgress | null>(null)
  const [pullError, setPullError] = useState<{
    kernel: KernelId
    message: string
  } | null>(null)
  const rows = useMemo<{ vm: Vm; kernel: KernelId }[]>(
    () =>
      (dashboard.data?.vms || [])
        .filter((vm) => !isCodexVm(vm))
        .map((vm) => ({
          vm,
          kernel:
            drafts[vm.id] ??
            (vm.resolved_dataplane === 'crag' ? 'crag' : 'cli-node'),
        })),
    [dashboard.data?.vms, drafts]
  )
  const vmById = useMemo(
    () => new Map(rows.map(({ vm }) => [vm.id, vm])),
    [rows]
  )
  const cragProduct = catalog.data?.kernels.find(
    (product) => product.id === 'crag'
  )
  const cragOptions = cragProduct?.release_options

  function cragReleaseLabel(tag?: string) {
    if (!tag) return tag
    const named = cragOptions?.find((option) => option.tag === tag)?.label
    // A payload tag carries a date before its version, so read the version out
    // of the `-crag-` segment rather than letting the date match first.
    const pinned = /-crag-(\d+\.\d+\.\d+)(?:-|$)/.exec(tag)?.[1]
    const version = /(?:^|-)(\d+\.\d+\.\d+)(?:-|$)/.exec(named || tag)?.[1]
    return pinned || version || named || tag
  }

  const pull = useMutation({
    mutationFn: pullKernelRelease,
    onMutate: () => setPullError(null),
    onSuccess: async (data, { kernel }) => {
      await qc.invalidateQueries({
        queryKey: kernelCatalogQueryOptions().queryKey,
      })
      toast.success(
        `${KERNEL_NAMES[kernel]} ${data.release?.tag || ''} 安装包已下载`
      )
    },
    onError: (error: Error, { kernel }) => {
      const message =
        isApiError(error) && error.code === 'crag_v2_asset_missing'
          ? '发布源尚无 CRAG 授权包，现有版本未改动。'
          : error.message
      setPullError({ kernel, message })
    },
  })
  const busy = installing || pull.isPending
  const eligible = rows.filter(({ vm }) => vm.node_platform !== 'darwin')
  const allTargets = eligible.map(({ vm, kernel }) => ({ id: vm.id, kernel }))
  function slotTargets(kernel: KernelId) {
    return eligible.map(({ vm }) => ({ id: vm.id, kernel }))
  }
  const failedCount = job
    ? Object.values(job.results).filter((item) => !item.ok).length
    : 0
  const succeededCount = job
    ? Object.values(job.results).filter((item) => item.ok).length
    : 0
  const installUnconfirmed = Object.values(job?.results || {}).some(
    (item) => item.code === 'kernel_install_unconfirmed'
  )
  const confirmTargets = confirm?.targets
  const confirmedCrag = confirmTargets?.find(
    (target) => target.kernel === 'crag'
  )
  const confirmedCragTag =
    confirmedCrag?.payload_tag ?? confirmedCrag?.expected_tag
  const confirmedCragLabel = cragReleaseLabel(confirmedCragTag)
  const confirmedMigration = confirmTargets?.some(
    (target) => target.reissue === true
  )

  function requestInstall(targets: KernelTarget[]) {
    if (!canEdit || busy || !targets.length) return
    const missingPackage = targets.find(
      (target) =>
        !catalog.data?.kernels.some((p) => p.id === target.kernel && p.ready)
    )
    if (missingPackage) {
      toast.error(`请先下载 ${KERNEL_NAMES[missingPackage.kernel]} 安装包`)
      return
    }
    const products = new Map(
      catalog.data?.kernels.map((product) => [product.id, product])
    )
    const pending = targets.find(
      ({ kernel }) =>
        selectedTags[kernel] !== 'latest' &&
        (products.get(kernel)?.payload_tag ||
          products.get(kernel)?.release_tag) !== selectedTags[kernel]
    )
    if (pending) {
      toast.error(
        `请先拉取 ${KERNEL_NAMES[pending.kernel]} ${selectedTags[pending.kernel]}`
      )
      return
    }
    const mac = targets.find(
      (target) => vmById.get(target.id)?.node_platform === 'darwin'
    )
    if (mac) {
      toast.error(
        `${vmById.get(mac.id)?.name || mac.id} 是 macOS 原生节点，不能在内核页重装`
      )
      return
    }
    const pinned = targets.map((target): KernelTarget => {
      const product = products.get(target.kernel)
      return {
        ...target,
        ...(product?.payload_tag
          ? { payload_tag: product.payload_tag }
          : { expected_tag: product?.release_tag }),
      }
    })
    if (
      pinned.some(
        (target) =>
          target.reissue && !(target.payload_tag || target.expected_tag)
      )
    ) {
      toast.error('迁移授权前请先拉取并确认 CRAG 发行版本')
      return
    }
    setConfirm({ targets: pinned, mode: 'install' })
  }

  /**
   * One click upgrades every CRAG slot to the payload this deployment pins,
   * skipping the slots already on it. Unlike the two-step flow above this does
   * not consult the version selector: the pin is the target by definition.
   */
  function requestCragUpgrade() {
    if (!canEdit || busy) return
    const pin = catalog.data?.crag_pin?.tag
    if (!pin) {
      toast.error('本次部署未固定 CRAG 版本，请用上方版本选择拉取并安装')
      return
    }
    const cragSlots = eligible.filter(
      ({ vm }) => vm.resolved_dataplane === 'crag'
    )
    if (!cragSlots.length) {
      toast.error('没有正在运行 CRAG 的槽位')
      return
    }
    const targets = cragSlots
      .filter(
        ({ vm }) => catalog.data?.installations?.[vm.id]?.payload_tag !== pin
      )
      .map((row): KernelTarget => ({
        id: row.vm.id,
        kernel: 'crag',
        payload_tag: pin,
      }))
    if (!targets.length) {
      toast.success(
        `${cragSlots.length} 个 CRAG 槽位已是锁定版本 ${cragReleaseLabel(pin) || pin}，无需升级`
      )
      return
    }
    setConfirm({ targets, mode: 'crag-update' })
  }

  async function forceCancel(id: string) {
    try {
      await cancelKernelInstall(id)
      toast.warning('已强制取消该虚拟机的安装', {
        description: '已停止的槽位保持维护状态，请检查后重装或手动启动。',
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '取消失败')
    }
  }

  async function runInstall(targets: KernelTarget[], mode: InstallMode) {
    setConfirm(null)
    setInstalling(true)
    const submit =
      mode === 'crag-update' ? updateCragTargets : installKernelTargets
    let failures = 0
    let reclaimPending = 0
    let unconfirmed = false
    try {
      // The install reads the cached package, so the pin has to be local before
      // the first slot stops. A failed download must never touch a slot.
      if (
        mode === 'crag-update' &&
        cragProduct?.payload_tag !== targets[0].payload_tag
      ) {
        try {
          await pullKernelRelease({ kernel: 'crag', latest: false })
          await qc.invalidateQueries({
            queryKey: kernelCatalogQueryOptions().queryKey,
          })
        } catch (error) {
          toast.error(
            error instanceof Error ? error.message : '拉取锁定版本失败',
            { description: '槽位未改动，请确认发布源后重试。' }
          )
          return
        }
      }
      setJob({
        total: targets.length,
        completed: 0,
        activeId: targets[0].id,
        results: {},
      })
      for (let index = 0; index < targets.length; index++) {
        const target = targets[index]
        setJob((previous) =>
          previous ? { ...previous, activeId: target.id } : previous
        )
        let result: KernelInstallItem
        try {
          const report = await submit([target])
          const item = report.items.find(
            (entry) => entry.id === target.id && entry.kernel === target.kernel
          )
          result = item || {
            ...target,
            ok: false,
            stopped: false,
            code: 'kernel_install_unconfirmed',
            error: '未收到该 VM 的安装结果',
          }
          if (result.ok && result.restarted !== true)
            result = { ...result, ok: false, error: '服务未确认重启完成' }
        } catch (error) {
          const data = isApiError(error)
            ? (error.data as { items?: KernelInstallItem[] } | undefined)
            : undefined
          const item = Array.isArray(data?.items)
            ? data.items.find((entry) => entry.id === target.id)
            : undefined
          result = {
            ...target,
            ok: false,
            stopped: item?.stopped === true,
            code: item?.code || (isApiError(error) ? error.code : undefined),
            error:
              item?.error ||
              (error instanceof Error ? error.message : '安装失败'),
          }
        }
        if (!result.ok) failures++
        else if (result.reclaim_pending) reclaimPending++
        setJob((previous) =>
          previous
            ? {
                ...previous,
                completed: index + 1,
                results: { ...previous.results, [target.id]: result },
              }
            : previous
        )
        if (result.code === 'kernel_install_unconfirmed') {
          unconfirmed = true
          break
        }
      }
      if (unconfirmed)
        toast.warning('安装结果未确认，已停止提交后续槽位', {
          description: '请先核对当前槽位的实际状态，再决定是否重新安装。',
        })
      else if (failures)
        toast.error(
          `${targets.length - failures}/${targets.length} 台安装成功，请检查失败项`
        )
      else if (reclaimPending)
        toast.warning(
          `${targets.length} 台内核已安装并重启，${reclaimPending} 个 CRAG 绑定待回收`,
          {
            description:
              '启用槽位回收后，请重装 cli-node 完成回收，额度以服务端确认为准。',
          }
        )
      else
        toast.success(
          mode === 'crag-update'
            ? `${targets.length} 个 CRAG 槽位已升级到锁定版本并重启`
            : `${targets.length} 台内核已安装并重启，调度状态已更新`
        )
    } finally {
      setJob((previous) =>
        previous ? { ...previous, activeId: null } : previous
      )
      await Promise.all([
        qc.invalidateQueries({
          queryKey: kernelCatalogQueryOptions().queryKey,
        }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: ['panel', 'vms'] }),
        qc.invalidateQueries({
          queryKey: cragHostStatusQueryOptions().queryKey,
        }),
      ])
      setInstalling(false)
    }
  }

  return (
    <PageHeader
      title='内核'
      description='可拉取最新或指定版本。拉取只更新缓存；确认重装后才应用到 VM。'
      extra={
        <Button
          variant='ghost'
          className='h-11'
          disabled={busy}
          onClick={() => {
            void catalog.refetch()
            void dashboard.refetch()
            if (canEdit) void cragHost.refetch()
          }}
        >
          <RefreshCw aria-hidden='true' />
          刷新
        </Button>
      }
    >
      <QueryGate
        loading={catalog.isLoading || dashboard.isLoading}
        error={catalog.error || dashboard.error}
        skeleton={
          <div className='space-y-6'>
            <Skeleton className='h-48 rounded-xl' />
            <Skeleton className='h-80 rounded-xl' />
          </div>
        }
      >
        <div className='space-y-7 motion-reduce:[&_svg]:animate-none'>
          <section
            aria-label='可用内核'
            className='divide-y rounded-xl border bg-card'
          >
            {catalog.data?.kernels.map((product) => (
              <div
                key={product.id}
                className={cn(
                  'grid gap-3 p-4 sm:items-center sm:px-5',
                  product.id === 'crag'
                    ? 'lg:grid-cols-[minmax(0,1fr)_auto]'
                    : 'sm:grid-cols-[minmax(0,1fr)_auto]'
                )}
              >
                <div className='min-w-0'>
                  <div className='flex flex-wrap items-center gap-2.5'>
                    {product.paid ? (
                      <KeyRound
                        aria-hidden='true'
                        className='size-5 text-muted-foreground'
                      />
                    ) : (
                      <Terminal
                        aria-hidden='true'
                        className='size-5 text-muted-foreground'
                      />
                    )}
                    <h3 className='text-lg font-semibold'>
                      {KERNEL_NAMES[product.id]}
                    </h3>
                    <Badge variant='secondary'>
                      {product.paid ? '付费 · 授权码' : '默认 · 免费'}
                    </Badge>
                  </div>
                  <div className='mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-base sm:text-sm'>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1.5',
                        product.ready ? 'text-primary' : 'text-muted-foreground'
                      )}
                    >
                      {product.ready ? (
                        <CheckCircle2 aria-hidden='true' className='size-4' />
                      ) : (
                        <TriangleAlert aria-hidden='true' className='size-4' />
                      )}
                      {product.ready ? '已下载' : '未就绪'}
                    </span>
                    <span className='min-w-0 wrap-anywhere text-muted-foreground'>
                      {product.ready ? '缓存：' : ''}
                      {cragReleaseLabel(product.payload_tag) ||
                        product.release_tag ||
                        product.version ||
                        '版本未记录'}
                    </span>
                  </div>
                  {product.id === 'crag' && canEdit ? (
                    <>
                      <CragRuntimeCounts status={cragStatus} />
                      <Link
                        to='/crag-subscription'
                        className='mt-2 inline-flex text-sm text-primary underline underline-offset-4'
                      >
                        兑换槽位
                      </Link>
                    </>
                  ) : null}
                  {product.error && !product.ready ? (
                    <p className='mt-2 text-base break-words text-destructive sm:text-sm'>
                      {product.error}
                    </p>
                  ) : null}
                  {pullError?.kernel === product.id ? (
                    <p
                      role='alert'
                      className='mt-2 flex items-start gap-2 text-base text-destructive sm:text-sm'
                    >
                      <TriangleAlert
                        aria-hidden='true'
                        className='mt-0.5 size-4 shrink-0'
                      />
                      <span className='min-w-0 break-words'>
                        {pullError.message}
                      </span>
                    </p>
                  ) : null}
                </div>
                <div className='flex flex-wrap gap-2'>
                  <Select
                    value={selectedTags[product.id]}
                    disabled={!canEdit || busy}
                    onOpenChange={(open) => {
                      if (open) {
                        if (versions.isError) void versions.refetch()
                        setVersionMenuOpened(true)
                      }
                    }}
                    onValueChange={(tag) =>
                      setSelectedTags((previous) => ({
                        ...previous,
                        [product.id]: tag,
                      }))
                    }
                  >
                    <SelectTrigger
                      aria-label={`${KERNEL_NAMES[product.id]} 下载版本`}
                      className='min-h-11 min-w-32'
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='latest'>最新版本</SelectItem>
                      {Array.from(
                        new Set([
                          ...(versions.data?.[product.id] || []),
                          ...(product.release_options?.map(({ tag }) => tag) ||
                            []),
                          ...(selectedTags[product.id] !== 'latest'
                            ? [selectedTags[product.id]]
                            : []),
                        ])
                      ).map((tag) => (
                        <SelectItem key={tag} value={tag}>
                          {cragReleaseLabel(tag)}
                        </SelectItem>
                      ))}
                      {versions.isFetching ? (
                        <div
                          role='status'
                          className='px-2 py-1.5 text-sm text-muted-foreground'
                        >
                          正在读取历史版本…
                        </div>
                      ) : null}
                      {versions.isError ? (
                        <div
                          role='status'
                          className='px-2 py-1.5 text-sm text-muted-foreground'
                        >
                          历史版本暂不可用，重开菜单可重试
                        </div>
                      ) : null}
                      {versions.isSuccess &&
                      !versions.data[product.id].length &&
                      !product.release_options?.length ? (
                        <div className='px-2 py-1.5 text-sm text-muted-foreground'>
                          暂无可选版本
                        </div>
                      ) : null}
                    </SelectContent>
                  </Select>
                  <Button
                    variant='outline'
                    className='h-11'
                    aria-label={`拉取 ${KERNEL_NAMES[product.id]} ${selectedTags[product.id] === 'latest' ? '最新版本' : selectedTags[product.id]}`}
                    disabled={!canEdit || busy}
                    loading={
                      pull.isPending && pull.variables?.kernel === product.id
                    }
                    onClick={() =>
                      pull.mutate({
                        kernel: product.id,
                        tag:
                          selectedTags[product.id] === 'latest'
                            ? undefined
                            : selectedTags[product.id],
                      })
                    }
                  >
                    <Download aria-hidden='true' />
                    {selectedTags[product.id] === 'latest'
                      ? '拉取最新'
                      : '拉取版本'}
                  </Button>
                  <Button
                    variant='outline'
                    className='h-11'
                    aria-label={`把 ${KERNEL_NAMES[product.id]} 更新到全部槽位`}
                    disabled={
                      !canEdit || busy || !product.ready || !eligible.length
                    }
                    onClick={() => requestInstall(slotTargets(product.id))}
                  >
                    应用缓存到全部槽位
                  </Button>
                  {product.id === 'crag' && catalog.data?.crag_pin ? (
                    <Button
                      className='h-11'
                      aria-label={`把全部 CRAG 槽位升级到锁定版本 ${catalog.data.crag_pin.tag}`}
                      disabled={!canEdit || busy || !eligible.length}
                      onClick={requestCragUpgrade}
                    >
                      <RefreshCw aria-hidden='true' />
                      升级到锁定版本
                      {cragReleaseLabel(catalog.data.crag_pin.tag)
                        ? ` ${cragReleaseLabel(catalog.data.crag_pin.tag)}`
                        : ''}
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </section>

          <section aria-labelledby='kernel-vms-heading' className='space-y-3'>
            <div className='flex flex-wrap items-end justify-between gap-3'>
              <div>
                <h3 id='kernel-vms-heading' className='text-lg font-semibold'>
                  VM 安装
                </h3>
                <p className='mt-1 text-base text-muted-foreground sm:text-sm'>
                  按所选内核重装并重启，完成后恢复调度状态。
                </p>
              </div>
              <Button
                variant='destructive'
                className='h-11'
                disabled={!canEdit || busy || !rows.length}
                loading={installing && (job?.total || 0) > 1}
                onClick={() => requestInstall(allTargets)}
              >
                <Power aria-hidden='true' />
                全部重装并重启{rows.length ? ` · ${rows.length} 台` : ''}
              </Button>
            </div>

            {job ? (
              <div
                role='status'
                aria-live='polite'
                className='space-y-2 rounded-lg bg-muted/60 p-3'
              >
                <div className='flex flex-wrap items-center justify-between gap-2 text-base sm:text-sm'>
                  <span className='inline-flex items-center gap-2'>
                    {installing ? (
                      <Loader2
                        aria-hidden='true'
                        className='size-4 animate-spin motion-reduce:animate-none'
                      />
                    ) : failedCount || installUnconfirmed ? (
                      <TriangleAlert
                        aria-hidden='true'
                        className='size-4 text-destructive'
                      />
                    ) : (
                      <CheckCircle2
                        aria-hidden='true'
                        className='size-4 text-primary'
                      />
                    )}
                    {installing
                      ? `正在安装 ${Math.min(job.completed + (job.activeId ? 1 : 0), job.total)}/${job.total}`
                      : installUnconfirmed
                        ? `已暂停：${succeededCount} 台成功，当前槽位结果未确认`
                        : `已完成：${succeededCount} 台成功${failedCount ? `，${failedCount} 台失败` : ''}`}
                  </span>
                  {installing && job.activeId ? (
                    <Button
                      variant='outline'
                      size='sm'
                      onClick={() => void forceCancel(job.activeId!)}
                    >
                      强制取消
                    </Button>
                  ) : null}
                  {!installing ? (
                    <Button
                      variant='ghost'
                      className='size-11 p-0'
                      aria-label='收起安装结果'
                      onClick={() => setJob(null)}
                    >
                      <X aria-hidden='true' />
                    </Button>
                  ) : null}
                </div>
                <Progress
                  aria-label='内核安装进度'
                  value={(job.completed / job.total) * 100}
                  className='h-1.5'
                />
              </div>
            ) : null}

            {!rows.length ? (
              <div className='rounded-xl border border-dashed py-12 text-center text-muted-foreground'>
                暂无 Claude VM。
                <Link to='/vm' className='ml-2 underline underline-offset-4'>
                  前往创建
                </Link>
              </div>
            ) : (
              <div
                role='table'
                aria-label='VM 内核安装'
                aria-colcount={4}
                className='overflow-hidden rounded-xl border bg-card'
              >
                <div
                  role='row'
                  className='hidden grid-cols-[minmax(160px,1fr)_minmax(180px,230px)_minmax(160px,1fr)_120px] gap-4 border-b bg-muted/40 px-5 py-3 text-sm text-muted-foreground xl:grid'
                >
                  <div role='columnheader'>虚拟机</div>
                  <div role='columnheader'>安装内核</div>
                  <div role='columnheader'>授权</div>
                  <div role='columnheader' className='text-right'>
                    操作
                  </div>
                </div>
                <div role='rowgroup' className='divide-y'>
                  {rows.map(({ vm, kernel }) => {
                    const license = catalog.data?.licenses[vm.id]
                    const installLicense =
                      catalog.data?.install_licenses?.[vm.id]
                    const installed = catalog.data?.installations?.[vm.id]
                    const result = job?.results[vm.id]
                    const runtime = cragStatus?.runtime?.vms[vm.id]
                    const active = installing && job?.activeId === vm.id
                    const macNative = vm.node_platform === 'darwin'
                    const migrationRequired =
                      kernel === 'crag' &&
                      !macNative &&
                      (installLicense?.code ===
                        'license_payload_key_mismatch' ||
                        result?.code === 'crag_subscription_migration_required')
                    const kvm = ['kvm', 'qemu', 'libvirt'].includes(
                      String(vm.runtime?.type || vm.runtime_type || '')
                        .trim()
                        .toLowerCase()
                    )
                    const repairCrag =
                      kvm &&
                      !macNative &&
                      !(
                        installed?.kernel === 'crag' &&
                        installed.version?.trim()
                      )
                    const currentKernel =
                      vm.resolved_dataplane === 'crag' &&
                      vm.resolved_crag_kernel_version === 'v2'
                        ? 'crag'
                        : vm.resolved_dataplane === 'wrap'
                          ? 'cli-node'
                          : null
                    const changed = kernel !== currentKernel
                    return (
                      <div
                        role='row'
                        key={vm.id}
                        className='grid min-w-0 gap-3 p-4 sm:grid-cols-2 sm:gap-4 xl:grid-cols-[minmax(160px,1fr)_minmax(180px,230px)_minmax(160px,1fr)_120px] xl:items-center xl:px-5'
                      >
                        <div role='cell' className='min-w-0'>
                          <Link
                            to='/vm/$id'
                            params={{ id: vm.id }}
                            className='inline-block min-h-11 max-w-full content-center truncate font-medium underline-offset-4 hover:underline'
                          >
                            {vm.name || vm.id}
                          </Link>
                          <div className='flex flex-wrap items-center gap-2 text-base text-muted-foreground sm:text-sm'>
                            <span
                              className={cn(
                                'size-1.5 rounded-full',
                                vm.status === 'running'
                                  ? 'bg-primary'
                                  : 'bg-muted-foreground/60'
                              )}
                              aria-hidden='true'
                            />
                            {result?.restarted
                              ? '运行中'
                              : result?.stopped
                                ? '已停用'
                                : VM_STATUS[vm.status || 'unknown'] ||
                                  vm.status ||
                                  '未知'}
                            {installed && installed.kernel === currentKernel ? (
                              installed.kernel === 'crag' ? (
                                <span className='min-w-0 wrap-anywhere'>
                                  已安装：
                                  {cragReleaseLabel(installed.payload_tag) ||
                                    installed.version ||
                                    '版本未记录'}
                                </span>
                              ) : installed.version ? (
                                <span>{installed.version}</span>
                              ) : null
                            ) : null}
                            {kvm ? <Badge variant='outline'>KVM</Badge> : null}
                          </div>
                          {runtime ? (
                            <CragRuntimeDetail detail={runtime} />
                          ) : canEdit && currentKernel === 'crag' ? (
                            <p className='mt-2 text-sm text-muted-foreground'>
                              CRAG：运行状态未知
                            </p>
                          ) : null}
                          {repairCrag ? (
                            <p className='mt-2 text-sm text-muted-foreground'>
                              未记录 CRAG 版本，可重装补齐内核和配置。
                            </p>
                          ) : null}
                          {result ? (
                            <p
                              className={cn(
                                'mt-2 flex min-w-0 items-start gap-2 text-base break-words sm:text-sm',
                                result.ok ? 'text-primary' : 'text-destructive'
                              )}
                            >
                              {result.ok ? (
                                <CheckCircle2
                                  aria-hidden='true'
                                  className='mt-0.5 size-4 shrink-0'
                                />
                              ) : (
                                <TriangleAlert
                                  aria-hidden='true'
                                  className='mt-0.5 size-4 shrink-0'
                                />
                              )}
                              <span>
                                {result.ok
                                  ? `重启完成${result.schedulable ? '，已恢复调度' : '，原调度限制保留'}${result.reclaim_pending ? '；CRAG 绑定待回收' : ''}`
                                  : `${result.error || '安装失败'}${result.stopped ? '；服务已停用' : ''}`}
                              </span>
                            </p>
                          ) : null}
                        </div>
                        <div role='cell' className='min-w-0 space-y-1.5'>
                          <span className='text-sm text-muted-foreground xl:hidden'>
                            安装内核
                          </span>
                          <Select
                            value={kernel}
                            disabled={!canEdit || busy}
                            onValueChange={(value) => {
                              if (value === 'cli-node' || value === 'crag')
                                setDrafts((previous) => ({
                                  ...previous,
                                  [vm.id]: value,
                                }))
                            }}
                          >
                            <SelectTrigger
                              className='w-full text-base data-[size=default]:h-11 sm:text-sm'
                              aria-label={`${vm.name || vm.id} 安装内核`}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className='motion-reduce:animate-none [&_[role=option]]:min-h-11'>
                              <SelectItem value='cli-node'>
                                cli-node · 默认
                              </SelectItem>
                              <SelectItem value='crag' disabled={macNative}>
                                CRAG · 付费
                              </SelectItem>
                            </SelectContent>
                          </Select>
                          {changed ? (
                            <span className='text-sm text-muted-foreground'>
                              待安装
                            </span>
                          ) : null}
                        </div>
                        <div
                          role='cell'
                          className='flex min-w-0 flex-wrap items-center gap-2 sm:content-center'
                        >
                          {kernel === 'crag' ? (
                            <>
                              <div className='min-w-0 space-y-1 text-base sm:text-sm'>
                                <div
                                  className={
                                    license?.valid
                                      ? 'text-primary'
                                      : 'text-destructive'
                                  }
                                >
                                  {macNative
                                    ? 'macOS 原生节点不支持'
                                    : license
                                      ? LICENSE_LABELS[license.status]
                                      : '状态未知'}
                                </div>
                                {license?.valid && license.expires_at ? (
                                  <div className='text-sm text-muted-foreground tabular-nums'>
                                    {new Date(license.expires_at * 1000)
                                      .toISOString()
                                      .slice(0, 10)}{' '}
                                    UTC
                                  </div>
                                ) : null}
                              </div>
                              <Button
                                variant='ghost'
                                className='h-11'
                                disabled={!canEdit || busy || macNative}
                                onClick={() => setLicenseVm(vm)}
                                aria-label={`管理 ${vm.name || vm.id} CRAG 授权`}
                              >
                                <KeyRound aria-hidden='true' />
                                {license?.valid ? '续期' : '激活'}
                              </Button>
                              {migrationRequired ? (
                                <p className='w-full text-sm text-muted-foreground'>
                                  所选发行包需要迁移现有授权。请确认迁移后再安装，服务端将核对本机订阅和目标槽位。
                                </p>
                              ) : null}
                            </>
                          ) : (
                            <span className='text-base text-muted-foreground sm:text-sm'>
                              无需授权
                            </span>
                          )}
                        </div>
                        <div
                          role='cell'
                          className='flex flex-wrap items-center justify-end gap-2'
                        >
                          {migrationRequired ? (
                            <Button
                              variant='outline'
                              className='h-auto min-h-11 w-full whitespace-normal sm:w-auto'
                              disabled={!canEdit || busy}
                              aria-label={`迁移 ${vm.name || vm.id} 授权并安装 CRAG`}
                              onClick={() =>
                                requestInstall([
                                  { id: vm.id, kernel: 'crag', reissue: true },
                                ])
                              }
                            >
                              迁移授权并安装
                            </Button>
                          ) : null}
                          {repairCrag ? (
                            <Button
                              variant='outline'
                              className='h-11 w-full sm:w-auto'
                              disabled={!canEdit || busy}
                              loading={active}
                              aria-label={`重装 ${vm.name || vm.id} 的 CRAG 并重启`}
                              onClick={() =>
                                requestInstall([{ id: vm.id, kernel: 'crag' }])
                              }
                            >
                              <RefreshCw aria-hidden='true' />
                              重装 CRAG
                            </Button>
                          ) : null}
                          <Button
                            variant='outline'
                            className='h-11 w-full sm:w-auto'
                            disabled={!canEdit || busy || macNative}
                            loading={active}
                            aria-label={`${changed ? '安装' : '重装'} ${vm.name || vm.id} 并重启`}
                            onClick={() =>
                              requestInstall([{ id: vm.id, kernel }])
                            }
                          >
                            <Power aria-hidden='true' />
                            {changed ? '安装' : '重装'}
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
            {!canEdit ? (
              <p className='text-sm text-muted-foreground'>
                仅管理员可安装或管理授权。
              </p>
            ) : null}
          </section>
        </div>
      </QueryGate>
      <ConfirmDialog
        open={confirm != null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null)
        }}
        title={
          confirmedMigration
            ? `迁移 ${vmById.get(confirmTargets?.[0]?.id || '')?.name || confirmTargets?.[0]?.id} 的授权并安装 CRAG？`
            : confirm?.mode === 'crag-update'
              ? `把 ${confirmTargets?.length || 0} 个 CRAG 槽位升级到锁定版本并重启？`
              : confirmTargets?.length === 1
                ? `重装 ${vmById.get(confirmTargets[0].id)?.name || confirmTargets[0].id} 并重启？`
                : `重装全部 ${confirmTargets?.length || 0} 台 VM 并重启？`
        }
        desc={
          <>
            {confirmedMigration
              ? '确认使用本机有效订阅，为此槽位换签所选发行包的授权，再安装并重启 CRAG。校验失败会明确报错；不会自动改用其他发行包。'
              : confirm?.mode === 'crag-update'
                ? '只替换 CRAG 发行包并重启，内核类型、凭据和工作数据不变；已是锁定版本的槽位已跳过。'
                : '按所选内核安装并重启，健康检查完成后恢复调度；手动关闭和凭证限制保留。凭据和工作数据不变。'}
            {confirmedCrag ? (
              <>
                <p className='mt-2'>
                  CRAG 会在停机前校验授权和运行名额。校验未通过的 VM 不会停机。
                </p>
                <p className='mt-2 wrap-anywhere'>
                  CRAG 安装版本：{confirmedCragTag || '未记录'}
                  {confirmedCragLabel && confirmedCragLabel !== confirmedCragTag
                    ? `（${confirmedCragLabel}）`
                    : null}
                </p>
              </>
            ) : null}
          </>
        }
        confirmText={
          confirmedMigration
            ? '确认迁移并安装'
            : confirm?.mode === 'crag-update'
              ? '升级并重启'
              : '重装并重启'
        }
        cancelBtnText='取消'
        disabled={!canEdit || busy}
        destructive
        className='motion-reduce:animate-none [&_button]:min-h-11'
        handleConfirm={() => {
          if (confirm && canEdit && !busy)
            void runInstall(confirm.targets, confirm.mode)
        }}
      >
        <ul className='max-h-56 space-y-2 overflow-y-auto rounded-lg bg-muted/50 p-3 text-sm'>
          {confirmTargets?.map((target) => (
            <li
              key={target.id}
              className='flex items-center justify-between gap-3'
            >
              <span className='min-w-0 truncate'>
                {vmById.get(target.id)?.name || target.id}
              </span>
              <span className='shrink-0 font-medium'>
                {KERNEL_NAMES[target.kernel]}
                {target.expected_tag ? ` ${target.expected_tag}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </ConfirmDialog>
      {licenseVm ? (
        <KernelLicenseDialog
          key={licenseVm.id}
          vm={licenseVm}
          onClose={() => setLicenseVm(null)}
        />
      ) : null}
    </PageHeader>
  )
}
