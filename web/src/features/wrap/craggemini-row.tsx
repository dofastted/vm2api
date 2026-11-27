import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  Check,
  CheckCircle2,
  Copy,
  Download,
  KeyRound,
  Loader2,
  RefreshCw,
  RotateCcw,
  TriangleAlert,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { isApiError } from '@/lib/api'
import { GEMINI_MAINTENANCE_SECTION_ID } from '@/lib/gemini-recovery'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { geminiInventoryOptions } from '@/features/import/gemini-environments'
import {
  compareGeminiVersions,
  GEMINI_INSTALL_COMMAND,
  geminiMaintenanceCodeLabel,
  geminiMaintenanceErrorMessage,
  geminiPayloadLabels,
  geminiPhaseLabels,
  geminiReleaseVersionLabel,
  maintenanceActionLabels,
  maintenanceQueryOptions,
  startMaintenance,
  type MaintenanceRequest,
} from '@/features/settings/gemini-maintenance'
import { kernelCatalogQueryOptions } from './queries'

type ReleaseOption = {
  tag: string
  version: string
  installed: boolean
  compatible: boolean
  pinned: boolean
}

type ConfirmAction = {
  request: MaintenanceRequest
  title: string
  description: string
  confirmText: string
  targetLabel?: string
}

export type CragGeminiKernelRowProps = {
  canEdit: boolean
  parentBusy: boolean
  geminiPin?: { tag: string; version?: string } | null
  remoteVersions?: string[]
  versionsFetching: boolean
  versionsError: boolean
  onOpenVersionMenu: () => void
}

export function CragGeminiKernelRow({
  canEdit,
  parentBusy,
  geminiPin,
  remoteVersions,
  versionsFetching,
  versionsError,
  onOpenVersionMenu,
}: CragGeminiKernelRowProps) {
  const qc = useQueryClient()
  const maintenance = useQuery({
    ...maintenanceQueryOptions,
    enabled: canEdit,
  })
  const inventory = useQuery({
    ...geminiInventoryOptions(),
    enabled: canEdit,
  })
  const statusKey = maintenanceQueryOptions.queryKey
  const mutationKey = [...statusKey, 'start']

  const [selectedTag, setSelectedTag] = useState<string>('latest')
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null)
  const [dismissedJobId, setDismissedJobId] = useState<string | null>(null)
  const [copiedBootstrap, setCopiedBootstrap] = useState(false)
  const trackedJobId = useRef<string | null>(null)
  const announcedJobId = useRef<string | null>(null)

  const submit = useMutation({
    mutationKey,
    mutationFn: startMaintenance,
    networkMode: 'always',
    retry: false,
    onSuccess: async (result) => {
      if (result.job?.id) {
        trackedJobId.current = result.job.id
        setDismissedJobId(null)
      }
      await qc.cancelQueries?.({ queryKey: statusKey })
      qc.setQueryData?.(statusKey, result)
    },
    onError: (error: Error) => {
      const code = isApiError(error) ? error.code : undefined
      toast.error(geminiMaintenanceErrorMessage(code || error.message))
      void qc.invalidateQueries?.({ queryKey: statusKey })
    },
  })

  const snapshot =
    maintenance.data?.available === true ? maintenance.data : undefined
  const unavailable =
    maintenance.data?.available === false ? maintenance.data : undefined
  const job = snapshot?.job ?? null
  const jobId = job?.id ?? null
  const jobStatus = job?.status ?? null
  const jobAction = job?.action ?? null
  const jobErrorCode = job?.error_code ?? null
  const running = jobStatus === 'running'
  const geminiOperationBusy =
    (typeof qc.isMutating === 'function'
      ? qc.isMutating({ mutationKey: ['panel', 'gemini-operation'] })
      : 0) > 0
  const busy = parentBusy || running || submit.isPending || geminiOperationBusy
  const supportsRemote = snapshot?.supports_remote_releases === true
  const bundledReleases = useMemo(
    () => snapshot?.releases ?? [],
    [snapshot?.releases]
  )
  const payload = snapshot?.payload
  const hasInstalledPayload = Boolean(
    payload?.version &&
    ['installed', 'awaiting_redemption'].includes(payload.state)
  )
  const installedVersion = payload?.version ?? null

  const pinTag = supportsRemote
    ? geminiPin?.tag || bundledReleases[0]?.id || null
    : bundledReleases[0]?.id || null
  const pinVersion = pinTag
    ? (supportsRemote && geminiPin?.tag === pinTag
        ? geminiPin.version
        : null) ||
      bundledReleases.find((item) => item.id === pinTag)?.version ||
      geminiReleaseVersionLabel(pinTag)
    : null

  const options = useMemo<ReleaseOption[]>(() => {
    const byTag = new Map<string, ReleaseOption>()
    for (const item of bundledReleases) {
      byTag.set(item.id, {
        tag: item.id,
        version: item.version,
        installed: item.installed,
        compatible: item.compatible,
        pinned: item.id === pinTag,
      })
    }
    if (supportsRemote) {
      const candidates = [
        ...(remoteVersions || []),
        ...(geminiPin?.tag ? [geminiPin.tag] : []),
      ]
      for (const tag of candidates) {
        if (!tag || byTag.has(tag)) continue
        const version = geminiReleaseVersionLabel(tag)
        const order = hasInstalledPayload
          ? compareGeminiVersions(installedVersion, version)
          : -1
        byTag.set(tag, {
          tag,
          version,
          installed: Boolean(
            hasInstalledPayload && installedVersion === version
          ),
          compatible: !hasInstalledPayload || (order !== null && order <= 0),
          pinned: tag === pinTag,
        })
      }
    }
    return Array.from(byTag.values())
  }, [
    bundledReleases,
    geminiPin?.tag,
    hasInstalledPayload,
    installedVersion,
    pinTag,
    remoteVersions,
    supportsRemote,
  ])

  const effectiveSelected = useMemo(() => {
    if (supportsRemote) {
      if (selectedTag === 'latest') return 'latest'
      if (options.some((item) => item.tag === selectedTag)) return selectedTag
      return 'latest'
    }
    if (options.some((item) => item.tag === selectedTag)) return selectedTag
    return options[0]?.tag ?? ''
  }, [options, selectedTag, supportsRemote])

  const resolvedTarget = useMemo<ReleaseOption | undefined>(() => {
    if (effectiveSelected === 'latest') {
      const latestRemote = remoteVersions?.[0]
      if (latestRemote) {
        const hit = options.find((item) => item.tag === latestRemote)
        if (hit) return hit
      }
      if (pinTag) {
        const hit = options.find((item) => item.tag === pinTag)
        if (hit) return hit
      }
      return options[0]
    }
    return options.find((item) => item.tag === effectiveSelected)
  }, [effectiveSelected, options, pinTag, remoteVersions])

  const pinOption = pinTag
    ? options.find((item) => item.tag === pinTag)
    : undefined

  const outdatedBrokerPinNotice =
    Boolean(snapshot) &&
    !supportsRemote &&
    Boolean(geminiPin?.tag) &&
    bundledReleases[0]?.id !== geminiPin?.tag

  const refetchMaintenance = maintenance.refetch
  const maintenanceIdleWithoutData =
    canEdit && maintenance.isPending && maintenance.fetchStatus === 'idle'
  useEffect(() => {
    // A cancelled first read (e.g. cancelQueries with revert) leaves the query
    // pending but idle, and nothing would ever fetch it again.
    if (maintenanceIdleWithoutData) void refetchMaintenance()
  }, [maintenanceIdleWithoutData, refetchMaintenance])

  useEffect(() => {
    if (!jobId || (jobStatus !== 'completed' && jobStatus !== 'failed')) return
    void qc.invalidateQueries?.({
      queryKey: geminiInventoryOptions().queryKey,
    })
    void qc.invalidateQueries?.({
      queryKey: kernelCatalogQueryOptions().queryKey,
    })
    if (
      trackedJobId.current === jobId &&
      announcedJobId.current !== jobId &&
      jobAction
    ) {
      announcedJobId.current = jobId
      if (jobStatus === 'completed') {
        toast.success(`CRAGGemini ${maintenanceActionLabels[jobAction]}已完成`)
      } else {
        toast.error(geminiMaintenanceErrorMessage(jobErrorCode))
      }
    }
  }, [jobAction, jobErrorCode, jobId, jobStatus, qc])

  function openConfirm(action: ConfirmAction) {
    if (!canEdit || busy || !snapshot) return
    setConfirm(action)
  }

  function requestInstall() {
    if (!canEdit || busy || !snapshot) return
    const targetTag = resolvedTarget?.tag
    const targetVersion =
      resolvedTarget?.version || pinVersion || '默认锁定版本'
    openConfirm({
      request: targetTag
        ? { action: 'install', release_id: targetTag }
        : { action: 'install' },
      title: '安装 CRAGGemini 内核并启动宿主服务？',
      description:
        '将通过宿主机维护服务下载、验签并安装 CRAGGemini 与官方 CLI（agy），随后启动 vm2api-gemini.service。不会重启控制面，也不影响 Claude / Codex 槽位。',
      confirmText: '确认安装',
      targetLabel: targetTag
        ? `CRAGGemini ${targetVersion}（${targetTag}）`
        : `CRAGGemini ${targetVersion}`,
    })
  }

  function requestUpdate(
    target: ReleaseOption | undefined,
    isPinUpgrade: boolean
  ) {
    if (!canEdit || busy || !snapshot) return
    if (!target) {
      toast.error('当前没有可用的 CRAGGemini 目标版本')
      return
    }
    if (target.installed) {
      toast.success(
        isPinUpgrade
          ? `CRAGGemini 已是锁定版本 ${target.version}，无需升级`
          : `CRAGGemini 已安装 ${target.version}，无需重复更新`
      )
      return
    }
    if (!target.compatible) {
      toast.error(
        `当前已安装 ${installedVersion || '未知版本'}，不能直接切换到 ${target.version}；如需退回上一版请使用「回滚」`
      )
      return
    }
    openConfirm({
      request: { action: 'update_native', release_id: target.tag },
      title: isPinUpgrade
        ? `将 CRAGGemini 升级到锁定版本 ${target.version} 并重启服务？`
        : `将 CRAGGemini 更新到 ${target.version} 并重启服务？`,
      description:
        '宿主机将完整验签并原子切换 CRAGGemini 载荷，随后重启 vm2api-gemini.service，同时保留上一版以供回滚。不会重启控制面或影响 Claude / Codex 槽位；若宿主仍有进行中的授权、终端或推理任务会拒绝变更。',
      confirmText: isPinUpgrade ? '升级并重启' : '更新并重启',
      targetLabel: `CRAGGemini ${target.version}（${target.tag}）`,
    })
  }

  function requestRollback() {
    if (!canEdit || busy || !snapshot?.rollback.available) return
    const target = snapshot.rollback.version
    openConfirm({
      request: { action: 'rollback' },
      title: `回滚 CRAGGemini 到上一版本${target ? ` ${target}` : ''}？`,
      description:
        '将恢复上一版已验证的 CRAGGemini 载荷及激活配置并重启 vm2api-gemini.service。若宿主仍有进行中的授权、终端或推理任务会拒绝变更。',
      confirmText: '确认回滚',
      targetLabel: target ? `CRAGGemini ${target}` : '上一已备份版本',
    })
  }

  function executeConfirm() {
    if (!confirm || !canEdit || busy) return
    const req = confirm.request
    setConfirm(null)
    submit.mutate(req)
  }

  async function copyBootstrapCommand() {
    try {
      await navigator.clipboard.writeText(GEMINI_INSTALL_COMMAND)
      setCopiedBootstrap(true)
      toast.success('已复制宿主机初始化命令')
      setTimeout(() => setCopiedBootstrap(false), 2000)
    } catch {
      toast.error('无法访问剪贴板，请手动复制命令')
    }
  }

  const statusErrorCode = isApiError(maintenance.error)
    ? maintenance.error.code
    : ''
  const retryStatusButton = (
    <Button
      type='button'
      size='sm'
      variant='ghost'
      className='h-7 px-2'
      aria-label='重新读取 CRAGGemini 宿主状态'
      disabled={maintenance.isFetching}
      onClick={() => void refetchMaintenance()}
    >
      <RefreshCw aria-hidden='true' />
      重试
    </Button>
  )

  const invData = inventory.data?.available ? inventory.data : undefined
  const sub = invData?.crag_subscription
  const envCount = invData?.environments.length ?? 0
  const oauthEnvCount =
    invData?.environments.filter((env) => env.auth_method === 'oauth').length ??
    0

  const showJobBanner =
    Boolean(job) &&
    (running ||
      (jobId !== dismissedJobId &&
        (jobStatus === 'failed' || trackedJobId.current === jobId)))

  const payloadReady = payload?.state === 'installed'
  const agyPatchCheck = snapshot?.checks.find((item) => item.id === 'agy_patch')
  const agyPatchMissing =
    agyPatchCheck?.state === 'fail' &&
    agyPatchCheck.code === 'gemini_maintenance_agy_patch_missing'
  const payloadLabel = payload
    ? (geminiPayloadLabels[payload.state] ?? payload.state)
    : null

  return (
    <div className='grid gap-3 p-4 sm:items-center sm:px-5 lg:grid-cols-[minmax(0,1fr)_auto]'>
      <div className='min-w-0'>
        <div className='flex flex-wrap items-center gap-2.5'>
          <KeyRound
            aria-hidden='true'
            className='size-5 text-muted-foreground'
          />
          <h3 className='text-lg font-semibold'>CRAGGemini</h3>
          <Badge variant='secondary'>付费 · 授权码</Badge>
          <Badge variant='outline'>宿主服务</Badge>
        </div>

        <div className='mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-base sm:text-sm'>
          {!canEdit ? (
            <span className='text-muted-foreground'>
              仅管理员可查看或管理 CRAGGemini 宿主内核
            </span>
          ) : unavailable ? (
            <span className='inline-flex items-center gap-1.5 text-muted-foreground'>
              <TriangleAlert aria-hidden='true' className='size-4' />
              {unavailable.bootstrap_required
                ? '宿主维护未就绪，需先初始化'
                : (geminiMaintenanceCodeLabel(unavailable.code) ??
                  `维护服务不可用（${unavailable.code}）`)}
            </span>
          ) : maintenance.isError ? (
            <span className='inline-flex flex-wrap items-center gap-1.5 text-destructive'>
              <TriangleAlert aria-hidden='true' className='size-4' />
              无法读取 CRAGGemini 维护状态
              {statusErrorCode ? `（${statusErrorCode}）` : ''}
              {retryStatusButton}
            </span>
          ) : maintenance.isPending ? (
            maintenanceIdleWithoutData ? (
              <span className='inline-flex items-center gap-1.5 text-muted-foreground'>
                宿主状态尚未读取
                {retryStatusButton}
              </span>
            ) : (
              <span className='inline-flex items-center gap-1.5 text-muted-foreground'>
                <Loader2 aria-hidden='true' className='size-4 animate-spin' />
                正在读取宿主状态…
              </span>
            )
          ) : snapshot && payload ? (
            <>
              <span
                className={cn(
                  'inline-flex items-center gap-1.5',
                  payloadReady ? 'text-primary' : 'text-muted-foreground'
                )}
              >
                {payloadReady ? (
                  <CheckCircle2 aria-hidden='true' className='size-4' />
                ) : payload.state === 'unverified' ? (
                  <Loader2 aria-hidden='true' className='size-4 animate-spin' />
                ) : (
                  <TriangleAlert aria-hidden='true' className='size-4' />
                )}
                {payloadLabel}
              </span>
              <span className='min-w-0 wrap-anywhere text-muted-foreground'>
                {hasInstalledPayload
                  ? `当前：${payload.version}${payload.cli_version ? ` · CLI ${payload.cli_version}` : ''}`
                  : pinVersion
                    ? `锁定版本：${pinVersion}`
                    : '尚未安装'}
              </span>
              <span className='text-muted-foreground'>
                服务：
                {snapshot.service.active
                  ? '运行中'
                  : snapshot.service.installed
                    ? '已安装未运行'
                    : '未安装'}
              </span>
            </>
          ) : (
            <span className='text-muted-foreground'>宿主状态未知</span>
          )}
        </div>

        {canEdit ? (
          <div className='mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground'>
            {sub ? (
              <span>
                宿主订阅：
                {sub.active
                  ? `已绑 ${sub.used_slots ?? 0} / ${sub.slot_limit === 'unlimited' ? '不限' : sub.slot_limit} 席位`
                  : '未激活'}
              </span>
            ) : null}
            {envCount > 0 ? (
              <span>
                Gemini 环境 {envCount} 个（OAuth {oauthEnvCount} 个）
              </span>
            ) : null}
            <Link
              to='/crag-subscription'
              className='inline-flex text-sm text-primary underline underline-offset-4'
            >
              兑换槽位
            </Link>
            <Link
              to='/settings/$tab'
              params={{ tab: 'gemini' }}
              hash={GEMINI_MAINTENANCE_SECTION_ID}
              className='inline-flex text-sm text-primary underline underline-offset-4'
            >
              诊断与高级维护
            </Link>
          </div>
        ) : null}

        {payload?.issue && !payloadReady ? (
          <p className='mt-2 text-base break-words text-destructive sm:text-sm'>
            状态码：{payload.issue}
          </p>
        ) : null}

        {agyPatchCheck && agyPatchCheck.state === 'fail' ? (
          <div className='mt-2 flex flex-wrap items-center gap-2 text-sm text-destructive'>
            <TriangleAlert aria-hidden='true' className='size-4 shrink-0' />
            <span className='min-w-0 break-words'>
              {geminiMaintenanceCodeLabel(agyPatchCheck.code) ??
                `Antigravity CLI 资格补丁状态异常（${agyPatchCheck.code ?? 'unknown'}）`}
            </span>
            {agyPatchMissing ? (
              <Button
                type='button'
                size='sm'
                variant='outline'
                disabled={!canEdit || busy || !snapshot}
                onClick={() =>
                  openConfirm({
                    request: { action: 'repair' },
                    title: '为 Antigravity CLI（agy）自动应用资格补丁并重启服务？',
                    description:
                      '宿主机维护服务将复制当前 agy、验证并应用 4 字节资格补丁、原子切换目录并重启 vm2api-gemini.service，同时保留上一版以供回滚。',
                    confirmText: '应用补丁并重启',
                  })
                }
              >
                修复补丁
              </Button>
            ) : null}
          </div>
        ) : null}

        {outdatedBrokerPinNotice ? (
          <p className='mt-2 text-sm text-muted-foreground'>
            控制面锁定版本为{' '}
            <span className='font-mono'>
              {geminiPin?.version || geminiReleaseVersionLabel(geminiPin?.tag)}
            </span>
            ，当前宿主维护服务仅内置{' '}
            <span className='font-mono'>
              {bundledReleases[0]?.version || '旧版'}
            </span>
            ；更新宿主维护服务（<code>prepare-gemini</code>
            ）后可在面板直接升级到最新或指定版本。
          </p>
        ) : null}

        {canEdit && unavailable?.bootstrap_required ? (
          <div className='mt-3 space-y-2 rounded-lg border bg-muted/40 p-3 text-sm'>
            <p className='text-muted-foreground'>
              {unavailable.code === 'maintenance_endpoint_missing'
                ? '当前控制面缺少 Gemini 维护接口，请先升级控制面后再在宿主机初始化。'
                : '控制面无法连接宿主维护服务，请先在 Linux amd64 宿主机运行以下命令初始化，完成后点右上角刷新：'}
            </p>
            <div className='flex flex-wrap items-center gap-2'>
              <code className='min-w-0 flex-1 rounded bg-background px-2.5 py-1.5 font-mono text-xs [overflow-wrap:anywhere]'>
                {GEMINI_INSTALL_COMMAND}
              </code>
              <Button
                type='button'
                size='sm'
                variant='outline'
                onClick={() => void copyBootstrapCommand()}
              >
                {copiedBootstrap ? (
                  <Check aria-hidden='true' />
                ) : (
                  <Copy aria-hidden='true' />
                )}
                复制命令
              </Button>
            </div>
          </div>
        ) : null}

        {showJobBanner && job ? (
          <div
            role='status'
            aria-live='polite'
            className='mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/60 px-3 py-2 text-sm'
          >
            <div className='flex min-w-0 items-start gap-2'>
              {running ? (
                <Loader2
                  aria-hidden='true'
                  className='mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none'
                />
              ) : jobStatus === 'failed' ? (
                <TriangleAlert
                  aria-hidden='true'
                  className='mt-0.5 size-4 shrink-0 text-destructive'
                />
              ) : (
                <CheckCircle2
                  aria-hidden='true'
                  className='mt-0.5 size-4 shrink-0 text-primary'
                />
              )}
              <span
                className={cn(
                  'min-w-0 break-words',
                  jobStatus === 'failed' && 'text-destructive'
                )}
              >
                {running
                  ? `正在${maintenanceActionLabels[job.action]}：${geminiPhaseLabels[job.phase] ?? job.phase}`
                  : jobStatus === 'completed'
                    ? `${maintenanceActionLabels[job.action]}已完成`
                    : geminiMaintenanceErrorMessage(job.error_code)}
              </span>
            </div>
            {!running ? (
              <Button
                type='button'
                variant='ghost'
                size='sm'
                className='size-8 shrink-0 p-0'
                aria-label='收起 CRAGGemini 任务结果'
                onClick={() => setDismissedJobId(job.id)}
              >
                <X aria-hidden='true' />
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className='flex flex-wrap gap-2'>
        <Select
          value={effectiveSelected}
          disabled={
            !canEdit ||
            busy ||
            !snapshot ||
            (!supportsRemote && !options.length)
          }
          onOpenChange={(open) => {
            if (open && supportsRemote) onOpenVersionMenu()
          }}
          onValueChange={setSelectedTag}
        >
          <SelectTrigger
            aria-label='CRAGGemini 目标版本'
            className='min-h-11 min-w-32'
          >
            <SelectValue placeholder='选择版本' />
          </SelectTrigger>
          <SelectContent>
            {supportsRemote ? (
              <SelectItem value='latest'>最新版本</SelectItem>
            ) : null}
            {options.map((item) => (
              <SelectItem key={item.tag} value={item.tag}>
                {item.version}
                {item.pinned ? '（锁定）' : ''}
                {item.installed ? ' · 已安装' : ''}
              </SelectItem>
            ))}
            {supportsRemote && versionsFetching ? (
              <div
                role='status'
                className='px-2 py-1.5 text-sm text-muted-foreground'
              >
                正在读取历史版本…
              </div>
            ) : null}
            {supportsRemote && versionsError ? (
              <div
                role='status'
                className='px-2 py-1.5 text-sm text-muted-foreground'
              >
                历史版本暂不可用，重开菜单可重试
              </div>
            ) : null}
            {!supportsRemote && !options.length ? (
              <div className='px-2 py-1.5 text-sm text-muted-foreground'>
                暂无可选版本
              </div>
            ) : null}
          </SelectContent>
        </Select>

        {!hasInstalledPayload ? (
          <Button
            className='h-11'
            aria-label='安装 CRAGGemini 内核'
            disabled={!canEdit || busy || !snapshot}
            loading={
              (submit.isPending || running) &&
              (submit.variables?.action === 'install' ||
                job?.action === 'install')
            }
            onClick={requestInstall}
          >
            <Download aria-hidden='true' />
            安装 CRAGGemini
          </Button>
        ) : (
          <>
            <Button
              variant='outline'
              className='h-11'
              aria-label={`更新 CRAGGemini 到 ${resolvedTarget?.version || '所选版本'}`}
              disabled={!canEdit || busy || !snapshot || !resolvedTarget}
              loading={
                (submit.isPending || running) &&
                (submit.variables?.action === 'update_native' ||
                  job?.action === 'update_native')
              }
              onClick={() => requestUpdate(resolvedTarget, false)}
            >
              <Download aria-hidden='true' />
              更新到所选版本
            </Button>
            {pinOption ? (
              <Button
                className='h-11'
                aria-label={`将 CRAGGemini 升级到锁定版本 ${pinOption.tag}`}
                disabled={!canEdit || busy || !snapshot}
                loading={
                  (submit.isPending || running) &&
                  (submit.variables?.action === 'update_native' ||
                    job?.action === 'update_native')
                }
                onClick={() => requestUpdate(pinOption, true)}
              >
                <RefreshCw aria-hidden='true' />
                升级到锁定版本 {pinOption.version}
              </Button>
            ) : null}
          </>
        )}

        {snapshot?.rollback.available ? (
          <Button
            variant='outline'
            className='h-11'
            aria-label={`回滚 CRAGGemini 到上一版${snapshot.rollback.version ? ` ${snapshot.rollback.version}` : ''}`}
            disabled={!canEdit || busy}
            loading={
              (submit.isPending || running) &&
              (submit.variables?.action === 'rollback' ||
                job?.action === 'rollback')
            }
            onClick={requestRollback}
          >
            <RotateCcw aria-hidden='true' />
            回滚
            {snapshot.rollback.version
              ? ` ${snapshot.rollback.version}`
              : '上一版'}
          </Button>
        ) : null}
      </div>

      {confirm ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirm(null)
          }}
          title={confirm.title}
          desc={
            <>
              <p>{confirm.description}</p>
              {confirm.targetLabel ? (
                <p className='mt-2 font-medium wrap-anywhere'>
                  目标版本：{confirm.targetLabel}
                </p>
              ) : null}
            </>
          }
          confirmText={confirm.confirmText}
          cancelBtnText='取消'
          disabled={!canEdit || busy}
          destructive
          className='motion-reduce:animate-none [&_button]:min-h-11'
          handleConfirm={executeConfirm}
        />
      ) : null}
    </div>
  )
}
