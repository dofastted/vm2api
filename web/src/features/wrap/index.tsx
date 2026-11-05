import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { VIEW_TITLES } from '@/config/nav'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { fmtBytes } from '@/lib/format'
import { cn } from '@/lib/utils'
import { isCodexVm } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
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
import { dataplaneLabel } from '@/features/vm/dataplane-contract'
import {
  inferenceEngineLabel,
  normalizeInferenceEngine,
} from '@/features/vm/engine-contract'
import {
  installReleaseKernel,
  makeWrapSample,
  promoteWrapSample,
  setKernelDataplane,
  syncWrapSample,
  uploadCragKernelBinary,
  uploadKernelBinary,
  wrapSampleQueryOptions,
  type WrapKernelPayload,
  type WrapSyncReport,
} from '@/features/wrap/queries'
import {
  slotFailureLabel,
  syncItemFailed,
  syncReportFromError,
  syncReportSummary,
} from './sync-report'

const MAX_KERNEL_UPLOAD_BYTES = 32 * 1024 * 1024

function sampleDirLabel(dir?: string) {
  if (!dir) return 'share/wrap-cli'
  const parts = dir.replace(/\\/g, '/').split('/')
  const i = parts.lastIndexOf('share')
  if (i >= 0) return parts.slice(i).join('/')
  return parts.slice(-2).join('/')
}

function kernelPathLabel(p?: string) {
  if (!p) return '—'
  const parts = p.replace(/\\/g, '/').split('/')
  const i = Math.max(
    parts.lastIndexOf('bin'),
    parts.lastIndexOf('wrap-cli'),
    parts.lastIndexOf('crag')
  )
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

function selectedDataplane(
  value: string | null | undefined
): 'wrap' | 'cc' | 'crag' {
  return value === 'cc' || value === 'crag' ? value : 'wrap'
}

function dataplaneOf(vm: Vm): 'wrap' | 'cc' | 'crag' | '—' {
  if (isCodexVm(vm)) return '—'
  return selectedDataplane(vm.resolved_dataplane)
}

function isNativeCragV2(vm?: Vm) {
  return (
    vm?.resolved_dataplane === 'crag' &&
    vm.resolved_crag_kernel_version === 'v2'
  )
}

function kernelLabel(vm: Vm) {
  if (isNativeCragV2(vm)) return 'CRAG V2 · 授权加密版'
  return dataplaneOf(vm) === '—' ? '—' : dataplaneLabel(dataplaneOf(vm))
}

function DataplaneOption({
  value,
  title,
  desc,
  current,
  disabled,
  children,
}: {
  value: 'wrap' | 'cc' | 'crag'
  title: string
  desc: string
  current: boolean
  disabled?: boolean
  children?: ReactNode
}) {
  return (
    <div
      className={cn(
        'rounded-lg border border-border/60 transition-colors',
        current && 'border-primary/50 bg-primary/5',
        disabled && 'opacity-60'
      )}
    >
      <Label
        className={cn(
          'flex items-start gap-3 p-4 font-normal',
          disabled ? 'cursor-not-allowed' : 'cursor-pointer'
        )}
      >
        <RadioGroupItem value={value} className='mt-0.5' disabled={disabled} />
        <span className='min-w-0 flex-1 space-y-2'>
          <span className='flex items-center justify-between gap-2'>
            <span className='text-sm leading-none font-medium'>{title}</span>
            {current ? (
              <span className='text-xs text-muted-foreground'>当前</span>
            ) : null}
          </span>
          <span className='block text-xs leading-snug text-muted-foreground'>
            {desc}
          </span>
        </span>
      </Label>
      <div className='space-y-3 px-4 pb-4'>{children}</div>
    </div>
  )
}

type HopJob = {
  phase: 'download' | 'slots' | 'done'
  done: number
  total: number
  current: string
  failed: string[]
}

function hopProgressValue(job: HopJob) {
  if (job.phase === 'download') return 8
  if (!job.total) return 0
  return Math.round((job.done / job.total) * 100)
}

function slotSyncFailed(report: WrapSyncReport, id: string) {
  const item = report.items?.find((row) => row.id === id) || report.items?.[0]
  if (!item) return report.ok === false
  return syncItemFailed(item)
}

function slotFailure(report: WrapSyncReport, id: string) {
  const item = report.items?.find((row) => row.id === id) || report.items?.[0]
  return item ? slotFailureLabel({ ...item, id }) : id
}

function HopProgress({ job }: { job: HopJob }) {
  const label =
    job.phase === 'download'
      ? '拉取 GitHub wrap kernel、cli-node、cc-node 和 crag kernel'
      : job.phase === 'done'
        ? job.failed.length
          ? `内核重装结束，失败 ${job.failed.length}`
          : `最新内核已重装 ${job.done}/${job.total}`
        : `正在按当前数据面换 ${job.current || '槽'} 的内核`
  return (
    <div className='space-y-1.5'>
      <div className='flex items-center justify-between gap-3 text-xs text-muted-foreground'>
        <span>{label}</span>
        <span>
          {job.phase === 'download' ? '下载中' : `${job.done}/${job.total}`}
        </span>
      </div>
      <Progress
        value={hopProgressValue(job)}
        className='h-2'
        indicatorClassName={job.phase === 'done' ? undefined : 'animate-pulse'}
      />
      {job.failed.length ? (
        <p className='text-xs text-destructive'>
          失败：{job.failed.join('、')}
        </p>
      ) : null}
    </div>
  )
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

function KernelPayload({
  payload,
  kind = 'kernel',
}: {
  payload?: WrapKernelPayload | null
  kind?: 'kernel' | 'cli'
}) {
  const label =
    payload?.source === 'configured'
      ? '仓内最新 kernel'
      : payload?.source === 'sample'
        ? kind === 'cli'
          ? '仓内 CLI'
          : '母样本 kernel'
        : kind === 'cli'
          ? '未找到 CLI'
          : '未找到 kernel'
  return (
    <div className='space-y-2 text-sm'>
      <div className='flex items-center justify-between gap-2'>
        <span className='text-muted-foreground'>来源</span>
        <span className='font-medium'>{label}</span>
      </div>
      <div className='flex items-center justify-between gap-2'>
        <span className='text-muted-foreground'>文件</span>
        <code className='text-xs'>{kernelPathLabel(payload?.path)}</code>
      </div>
      <div className='flex items-center justify-between gap-2'>
        <span className='text-muted-foreground'>大小</span>
        <span className='font-mono text-xs'>
          {payload?.size ? fmtBytes(payload.size) : '—'}
        </span>
      </div>
      <div className='flex items-center justify-between gap-2'>
        <span className='text-muted-foreground'>mtime</span>
        <span className='font-mono text-xs'>{payload?.mtime || '—'}</span>
      </div>
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
  const [pendingDataplane, setPendingDataplane] = useState<
    'wrap' | 'cc' | 'crag' | null
  >(null)
  const [promoteId, setPromoteId] = useState<string | null>(null)
  const [makeOpen, setMakeOpen] = useState(false)
  const [glibcVm, setGlibcVm] = useState('')
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [releaseOpen, setReleaseOpen] = useState(false)
  const [hopOpen, setHopOpen] = useState(false)
  const [hopIds, setHopIds] = useState<string[]>([])
  const [pullLatest, setPullLatest] = useState(true)
  const [hopJob, setHopJob] = useState<HopJob | null>(null)
  const [hopBusy, setHopBusy] = useState(false)
  const hopToken = useRef(0)
  const fileRef = useRef<HTMLInputElement>(null)

  const rustVms = useMemo(
    () => vms.filter((vm) => engineOf(vm) === 'rust'),
    [vms]
  )
  const reinstallIds = selected.length ? selected : vms.map((vm) => vm.id)
  const nativeV2Ids = reinstallIds.filter((id) =>
    isNativeCragV2(vms.find((vm) => vm.id === id))
  )

  const invalidate = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: wrapSampleQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
    ])
  }

  const openHop = (ids: string[], pull: boolean) => {
    setHopIds(ids)
    setPullLatest(pull)
    setHopOpen(true)
  }

  const runHop = async (ids: string[], pull: boolean) => {
    if (!ids.length || hopBusy) return
    const fetchLegacyRelease =
      pull && ids.some((id) => !isNativeCragV2(vms.find((vm) => vm.id === id)))
    const token = hopToken.current + 1
    hopToken.current = token
    const alive = () => hopToken.current === token
    setHopBusy(true)
    setHopJob({
      phase: fetchLegacyRelease ? 'download' : 'slots',
      done: 0,
      total: ids.length,
      current: ids[0] || '',
      failed: [],
    })
    const failed: string[] = []
    try {
      if (fetchLegacyRelease) {
        await installReleaseKernel({ ids: [], restart: false })
        if (!alive()) return
      }
      for (let i = 0; i < ids.length; i++) {
        if (!alive()) return
        const id = ids[i]
        setHopJob({
          phase: 'slots',
          done: i,
          total: ids.length,
          current: id,
          failed: [...failed],
        })
        try {
          const report = await syncWrapSample({ ids: [id], restart })
          if (slotSyncFailed(report, id)) failed.push(slotFailure(report, id))
        } catch (error) {
          const report = syncReportFromError(error)
          failed.push(
            report
              ? slotFailure(report, id)
              : `${id}（${error instanceof Error ? error.message : '失败'}）`
          )
        }
      }
      if (!alive()) return
      setHopJob({
        phase: 'done',
        done: ids.length,
        total: ids.length,
        current: '',
        failed: [...failed],
      })
      if (failed.length) {
        toast.error(`内核重装 ${ids.length - failed.length}/${ids.length}`)
      } else {
        toast.success(`内核重装 ${ids.length}/${ids.length}`)
      }
      await invalidate()
    } catch (error) {
      if (!alive()) return
      toast.error(error instanceof Error ? error.message : '内核重装失败')
      setHopJob((cur) =>
        cur
          ? { ...cur, phase: 'done', failed: failed.length ? failed : ['下载'] }
          : cur
      )
    } finally {
      if (alive()) setHopBusy(false)
    }
  }

  const promote = useMutation({
    mutationFn: (id: string) => promoteWrapSample(id),
    onSuccess: async (_data, id) => {
      toast.success(`已把 ${id} 收成母本`)
      setPromoteId(null)
      await invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const make = useMutation({
    mutationFn: () => makeWrapSample({ glibc_vm: glibcVm || undefined }),
    onSuccess: async () => {
      toast.success('已重整 wrap 文件')
      setMakeOpen(false)
      await invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const upload = useMutation({
    mutationFn: (file: File) => uploadKernelBinary(file),
    onSuccess: async () => {
      toast.success('已写入仓内 wrap kernel。再重装铺到槽')
      setUploadFile(null)
      await invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const releaseUpdate = useMutation({
    mutationFn: () => installReleaseKernel({ ids: [], restart: false }),
    onSuccess: async (result) => {
      setReleaseOpen(false)
      const tag = result.release?.tag || 'Release'
      const cli = result.release?.cli_node_size
        ? `，cli-node ${fmtBytes(result.release.cli_node_size)}`
        : ''
      const cc = result.release?.cc_node_size
        ? `，cc-node ${fmtBytes(result.release.cc_node_size)}`
        : ''
      const crag = result.release?.crag_size
        ? `，crag ${fmtBytes(result.release.crag_size)}`
        : ''
      toast.success(`已下载 ${tag}${cli}${cc}${crag}。尚未铺到槽`)
      await invalidate()
    },
    onError: async (error: Error) => {
      const report = syncReportFromError(error)
      toast.error(
        report
          ? `${error.message}：${syncReportSummary(report)}`
          : error.message
      )
      if (report) {
        setReleaseOpen(false)
        await invalidate()
      }
    },
  })
  const dataplane = useMutation({
    mutationFn: (next: 'wrap' | 'cc' | 'crag') => {
      const ids = selected.filter((id) => {
        const vm = vms.find((item) => item.id === id)
        return Boolean(vm && !isCodexVm(vm))
      })
      if (selected.length && !ids.length) {
        return Promise.reject(
          new Error('所选槽都是 Codex，Claude 内核切不到它们')
        )
      }
      return setKernelDataplane({
        dataplane: next,
        ids: ids.length ? ids : undefined,
        all: ids.length === 0,
        restart,
      })
    },
    onSuccess: async (report, next) => {
      setPendingDataplane(null)
      const failed = Number(report.failed_count || 0)
      if (failed) {
        toast.error(`已切 ${next}，${syncReportSummary(report)}`)
      } else {
        toast.success(
          next === 'crag'
            ? '已切换到 CRAG 数据面（按槽位版本）'
            : next === 'cc'
              ? '已切换到 cc-node + kernel'
              : '已切换到 cli-node + kernel'
        )
      }
    },
    onError: (error: Error, next) => {
      // 部分槽失败时网关回 400/503，正文仍带逐槽结果；数据面已经写入，按部分成功处理。
      const report = syncReportFromError(error)
      if (report) {
        setPendingDataplane(null)
        toast.error(`已切 ${next}，${syncReportSummary(report)}`)
      } else {
        toast.error(error.message)
      }
    },
    onSettled: () => invalidate(),
  })
  const uploadCrag = useMutation({
    mutationFn: (file: File) => uploadCragKernelBinary(file),
    onSuccess: async () => {
      toast.success('已写入 Crag kernel。再点切换铺到槽')
      await invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const cragFileRef = useRef<HTMLInputElement>(null)

  const toggle = (id: string, on: boolean) => {
    setSelected((cur) =>
      on ? Array.from(new Set([...cur, id])) : cur.filter((x) => x !== id)
    )
  }

  const pickKernelFile = (file?: File) => {
    if (!file) return
    if (file.size > MAX_KERNEL_UPLOAD_BYTES) {
      toast.error('kernel 不能超过 32MB')
      return
    }
    if (!file.size) {
      toast.error('kernel 文件为空')
      return
    }
    setUploadFile(file)
  }

  const data = sample.data
  const complete = data?.ok === true

  return (
    <PageHeader
      title={VIEW_TITLES.wrap}
      description='切换数据面和重装内核。重装不改凭证、不改代理、不删容器。'
      extra={
        <div className='flex flex-wrap gap-2'>
          <input
            ref={fileRef}
            type='file'
            className='hidden'
            onChange={(event) => {
              pickKernelFile(event.target.files?.[0])
              event.target.value = ''
            }}
          />
          <Button
            size='sm'
            variant='outline'
            disabled={releaseUpdate.isPending || hopBusy}
            loading={releaseUpdate.isPending}
            onClick={() => setReleaseOpen(true)}
          >
            拉取 wrap/crag
          </Button>
          <Button
            size='sm'
            variant='outline'
            disabled={upload.isPending || hopBusy}
            loading={upload.isPending}
            onClick={() => fileRef.current?.click()}
          >
            本地上传
          </Button>
          <Button
            size='sm'
            variant='outline'
            disabled={make.isPending || hopBusy}
            loading={make.isPending}
            onClick={() => setMakeOpen(true)}
          >
            重整母本
          </Button>
          <Button
            size='sm'
            disabled={!complete || !reinstallIds.length || hopBusy}
            loading={hopBusy && hopIds.length !== 1}
            onClick={() => openHop(reinstallIds, true)}
          >
            {selected.length
              ? `重装当前内核 ${selected.length}`
              : '重装当前内核'}
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
          默认是 <code>cli-node + kernel</code>。<code>cc-node + kernel</code>
          使用同一份 wrap kernel。CRAG 按槽位版本使用 legacy 母本或授权加密 V2；
          V2 的切换、机器码与授权在对应 VM 的「运维 → 推理内核」管理。
          未勾选时重装当前类型的全部槽，勾选后只处理所选槽。不改凭据、不删容器。
        </p>
        <Card className='mb-4'>
          <CardHeader>
            <CardTitle>CRAG V2 · 授权加密版</CardTitle>
          </CardHeader>
          <CardContent className='space-y-3'>
            <p className='text-sm text-muted-foreground'>
              从服务器已安装的受信任加密包重装，不拉取 legacy GitHub Release。
              每槽仍须通过注册码验证；未授权或已到期时，请先在该槽运维页激活或续期。
            </p>
            <Button
              disabled={!nativeV2Ids.length || hopBusy}
              loading={hopBusy}
              onClick={() => openHop(nativeV2Ids, false)}
            >
              {selected.length ? '重装所选 CRAG V2' : '重装 CRAG V2'}
              {nativeV2Ids.length ? ` · ${nativeV2Ids.length} 槽` : ''}
            </Button>
            {!nativeV2Ids.length ? (
              <p className='text-xs text-muted-foreground'>
                当前范围内没有已切换到 CRAG V2 的槽；请先进入对应 VM
                的运维页切换。
              </p>
            ) : null}
          </CardContent>
        </Card>
        <Card className='mb-4'>
          <CardHeader>
            <CardTitle>内核</CardTitle>
          </CardHeader>
          <CardContent className='space-y-3'>
            <RadioGroup
              value={selectedDataplane(data?.dataplane)}
              onValueChange={(value) => {
                if (value !== 'wrap' && value !== 'cc' && value !== 'crag')
                  return
                if (value === selectedDataplane(data?.dataplane)) return
                setPendingDataplane(value)
              }}
              disabled={dataplane.isPending || hopBusy}
              className='grid gap-3 lg:grid-cols-3'
            >
              <DataplaneOption
                value='wrap'
                title='cli-node + kernel'
                desc='默认。patched cli-node，一进程 20 native 槽。kernel.json.claude_bin 指向仓内 cli-node。'
                current={data?.dataplane !== 'cc' && data?.dataplane !== 'crag'}
                disabled={!data?.ok}
              >
                <KernelPayload payload={data?.kernel} />
                <div className='pt-1 text-xs font-medium text-muted-foreground'>
                  cli-node
                </div>
                <KernelPayload payload={data?.cli_node} kind='cli' />
                <Flag ok={Boolean(data?.cli_node?.size)} label='cli-node' />
                <Flag ok={data?.kernel_bin} label='kernel.bin' />
              </DataplaneOption>
              <DataplaneOption
                value='cc'
                title='cc-node + kernel'
                desc='同一份 wrap kernel。claude_bin 指向仓内 cc-node。'
                current={data?.dataplane === 'cc'}
                disabled={!data?.cc_node?.size}
              >
                <KernelPayload payload={data?.kernel} />
                <div className='pt-1 text-xs font-medium text-muted-foreground'>
                  cc-node
                </div>
                <KernelPayload payload={data?.cc_node} kind='cli' />
                <Flag ok={Boolean(data?.cc_node?.size)} label='cc-node' />
                <Flag ok={data?.kernel_bin} label='kernel.bin' />
              </DataplaneOption>
              <DataplaneOption
                value='crag'
                title='CRAG 数据面'
                desc='版本以槽位固定值或全局配置为准。下方 ELF 是 legacy 母本；V2 请使用上方授权加密版入口。'
                current={data?.dataplane === 'crag'}
                disabled={!data?.crag?.ok || !data?.cc_node?.size}
              >
                <KernelPayload payload={data?.crag || undefined} />
                <Flag
                  ok={Boolean(data?.crag?.ok)}
                  label='share/crag/kin-kernel'
                />
                <Flag ok={Boolean(data?.cc_node?.size)} label='cc-node' />
                <input
                  ref={cragFileRef}
                  type='file'
                  className='hidden'
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    event.target.value = ''
                    if (!file) return
                    if (file.size > MAX_KERNEL_UPLOAD_BYTES) {
                      toast.error('kernel 不能超过 32MB')
                      return
                    }
                    uploadCrag.mutate(file)
                  }}
                />
                <Button
                  size='sm'
                  variant='outline'
                  disabled={uploadCrag.isPending || hopBusy}
                  loading={uploadCrag.isPending}
                  onClick={(event) => {
                    event.preventDefault()
                    cragFileRef.current?.click()
                  }}
                >
                  上传 Crag ELF
                </Button>
              </DataplaneOption>
            </RadioGroup>
            <div className='flex items-center gap-2 text-sm'>
              <Checkbox
                checked={restart}
                onCheckedChange={(v) => setRestart(v === true)}
              />
              <label>切换后重启 rust kernel，让槽用上对应二进制</label>
            </div>
          </CardContent>
        </Card>

        <div className='grid gap-4 lg:grid-cols-2'>
          <Card>
            <CardHeader>
              <CardTitle>wrap 文件</CardTitle>
            </CardHeader>
            <CardContent className='space-y-2'>
              {data?.meta?.release_tag ? (
                <div className='flex items-center justify-between gap-2 text-sm'>
                  <span className='text-muted-foreground'>GitHub</span>
                  <span className='font-mono text-xs'>
                    {data.meta.release_tag}
                  </span>
                </div>
              ) : null}
              <div className='flex items-center justify-between gap-2 text-sm'>
                <span className='text-muted-foreground'>目录</span>
                <code className='text-xs'>{sampleDirLabel(data?.dir)}</code>
              </div>
              <Flag ok={data?.wrapper} label='kernel wrapper' />
              <Flag ok={data?.glibc_shim} label='glibc 2.39 shim' />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>内核重装</CardTitle>
            </CardHeader>
            <CardContent className='space-y-3 text-sm leading-relaxed text-muted-foreground'>
              <p>
                按各槽当前数据面铺内核：cli-node + kernel、cc-node + kernel，或
                crag + cc-node。可先从 GitHub Release 拉 linux amd64
                文件。不改凭证、不改 SOCKS、不删容器。
              </p>
              <Button
                size='sm'
                disabled={!complete || vms.length === 0 || hopBusy}
                loading={hopBusy && hopIds.length > 1}
                onClick={() =>
                  openHop(
                    vms.map((vm) => vm.id),
                    true
                  )
                }
              >
                一键全部重装最新内核
              </Button>
              {hopJob ? <HopProgress job={hopJob} /> : null}
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
                    <tr>
                      <th className='w-8 py-2 font-medium'>选</th>
                      <th className='py-2 font-medium'>槽</th>
                      <th className='py-2 font-medium'>OS</th>
                      <th className='py-2 font-medium'>引擎</th>
                      <th className='py-2 font-medium'>内核</th>
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
                          <td className='py-2 font-mono text-xs'>
                            {kernelLabel(vm)}
                          </td>
                          <td className='py-2 text-muted-foreground'>
                            {source ? '当前母本' : rust ? '可收成' : '只收文件'}
                          </td>
                          <td className='py-2'>
                            <div className='flex justify-end gap-2'>
                              <Button
                                size='sm'
                                variant='outline'
                                disabled={!rust || promote.isPending || hopBusy}
                                onClick={() => setPromoteId(vm.id)}
                              >
                                晋升母本
                              </Button>
                              <Button
                                size='sm'
                                variant='outline'
                                disabled={!complete || hopBusy}
                                loading={
                                  hopBusy &&
                                  hopIds.length === 1 &&
                                  hopIds[0] === vm.id
                                }
                                onClick={() => openHop([vm.id], false)}
                              >
                                替换此槽
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
                没有 rust cli-hop 槽时仍会铺文件，但不会重启 kernel。
              </p>
            ) : null}
          </CardContent>
        </Card>
      </QueryGate>
      <ConfirmDialog
        open={pendingDataplane != null}
        onOpenChange={(open) => {
          if (!open) setPendingDataplane(null)
        }}
        title={
          pendingDataplane === 'crag'
            ? '切到 crag + cc-node？'
            : pendingDataplane === 'cc'
              ? '切到 cc-node + kernel？'
              : '切到 cli-node + kernel？'
        }
        desc={
          pendingDataplane === 'crag'
            ? `${selected.length ? `所选 ${selected.length} 个 Claude 槽` : '全部 Claude 槽'}将铺 crag kernel，claude_bin 指向 /home/kincli/.kin/cc-node，并重启 rust kernel。Codex 不动。不改凭证、不删容器。`
            : pendingDataplane === 'cc'
              ? `${selected.length ? `所选 ${selected.length} 个 Claude 槽` : '全部 Claude 槽'}将铺 wrap kernel 和 cc-node，并重启 rust kernel。Codex 不动。不改凭证、不删容器。`
              : `${selected.length ? `所选 ${selected.length} 个 Claude 槽` : '全部 Claude 槽'}将铺 wrap kernel 和 cli-node，并重启 rust kernel。Codex 不动。不改凭证、不删容器。`
        }
        confirmText='切换'
        cancelBtnText='取消'
        isLoading={dataplane.isPending}
        handleConfirm={() => {
          if (pendingDataplane) dataplane.mutate(pendingDataplane)
        }}
      />

      <ConfirmDialog
        open={!!promoteId}
        onOpenChange={(open) => {
          if (!open) setPromoteId(null)
        }}
        title='收成母本？'
        desc={`把 ${promoteId || '此槽'} 里已跑通的 cli-node 收成以后重装用的母本。不拷凭证。kernel 仍用仓内文件。`}
        confirmText='晋升'
        cancelBtnText='取消'
        isLoading={promote.isPending}
        handleConfirm={() => {
          if (promoteId) promote.mutate(promoteId)
        }}
      />
      <ConfirmDialog
        open={makeOpen}
        onOpenChange={setMakeOpen}
        title='重整 wrap 文件？'
        desc='用当前 share/wrap-cli 里已有的 cli-node，补 kernel wrapper / shim，并叠上仓内最新 kernel。缺 cli-node 会失败。Debian 12 可从一台 Ubuntu 槽拷 glibc 2.39 shim。'
        confirmText='重整'
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
      <ConfirmDialog
        open={!!uploadFile}
        onOpenChange={(open) => {
          if (!open) setUploadFile(null)
        }}
        title='上传 kernel？'
        desc={`用 ${uploadFile?.name || '所选文件'}（${fmtBytes(uploadFile?.size || 0)}）覆盖仓内 kernel。不会自动改槽。`}
        confirmText='上传'
        cancelBtnText='取消'
        isLoading={upload.isPending}
        handleConfirm={() => {
          if (uploadFile) upload.mutate(uploadFile)
        }}
      />
      <ConfirmDialog
        open={releaseOpen}
        onOpenChange={setReleaseOpen}
        title='拉取 GitHub 内核？'
        desc='下载最新 Release 的 linux amd64 wrap kin-kernel、cli-node、cc-node 和 crag kin-kernel 到仓内。不改槽、不重启。'
        confirmText='下载'
        cancelBtnText='取消'
        isLoading={releaseUpdate.isPending}
        handleConfirm={() => releaseUpdate.mutate()}
      />
      <ConfirmDialog
        open={hopOpen}
        onOpenChange={(open) => {
          if (!open) setHopOpen(false)
        }}
        title={
          hopIds.length === 1
            ? `替换 ${hopIds[0]}？`
            : hopIds.length === vms.length
              ? '一键重装全部槽的最新内核？'
              : `重装所选 ${hopIds.length} 槽？`
        }
        desc={
          hopIds.length > 0 &&
          hopIds.every((id) => isNativeCragV2(vms.find((vm) => vm.id === id)))
            ? '使用服务器已验证的授权加密 V2 包，逐槽核验注册码并重装。不拉取 legacy Release，不改凭据，不删容器。'
            : hopIds.length === 1
              ? '按该槽当前数据面铺内核并重启 rust kernel。不改凭证，不删容器。'
              : pullLatest
                ? '先从 GitHub 拉 wrap kernel、cli-node、cc-node 和 crag kernel，再按各槽数据面逐槽换上。不改凭证，不删容器。'
                : '按各槽当前数据面铺仓内内核并显示进度。不改凭证，不删容器。'
        }
        confirmText={
          hopIds.length === 1
            ? '替换'
            : hopIds.length === vms.length
              ? '全部重装'
              : '开始重装'
        }
        cancelBtnText='取消'
        isLoading={hopBusy}
        handleConfirm={() => {
          const ids = hopIds
          const pull = ids.length === 1 ? false : pullLatest
          setHopOpen(false)
          void runHop(ids, pull)
        }}
      >
        {hopIds.length === 1 ? null : (
          <label className='flex items-center gap-2 text-sm'>
            <Checkbox
              checked={pullLatest}
              onCheckedChange={(v) => setPullLatest(v === true)}
            />
            先拉取 GitHub 最新 wrap/crag
          </label>
        )}
      </ConfirmDialog>
    </PageHeader>
  )
}
