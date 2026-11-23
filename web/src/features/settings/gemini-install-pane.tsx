import { useEffect, useId, useRef, useState, type MouseEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Check, Copy, RefreshCw } from 'lucide-react'
import { isApiError } from '@/lib/api'
import { geminiAuthorizationLabel } from '@/lib/gemini-account-status'
import { GEMINI_MAINTENANCE_SECTION_ID } from '@/lib/gemini-recovery'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { geminiInventoryOptions } from '@/features/import/gemini-environments'
import { useGeminiBusy } from '@/features/import/gemini-operations'
import { GeminiTestPanel } from '@/features/import/gemini-test-panel'
import {
  type MaintenanceRelease,
  type MaintenanceRequest,
  type MaintenanceSnapshot,
  maintenanceActionLabels,
  maintenanceQueryOptions,
  startMaintenance,
} from './gemini-maintenance'

const COMMAND =
  'curl -fsSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install-gemini.sh | sudo bash -s -- --dir /opt/vm2api'

const payloadLabels: Record<string, string> = {
  installed: '已安装',
  invalid: '校验失败',
  missing: '未安装',
  not_installed: '未安装',
  not_configured: '未配置',
  awaiting_redemption: '等待兑换',
  unknown: '未知',
  unverified: '正在验证',
}

const checkStates = { pass: '通过', fail: '失败', warning: '警告' } as const
const jobStates = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
} as const
const phaseLabels: Record<string, string> = {
  queued: '等待执行',
  checking: '检查宿主',
  dependencies: '准备宿主依赖',
  diagnosing: '诊断宿主',
  fetching: '下载签名载荷',
  preparing_runtime: '准备运行文件',
  restoring: '恢复未完成的维护',
  downloading: '下载签名载荷',
  verifying: '验证载荷',
  applying: '应用变更',
  starting: '启动 Gemini 服务',
  installing: '安装运行环境',
  restarting: '重启 Gemini 服务',
  completed: '执行完成',
  failed: '执行失败',
}

const restartCopy =
  '此操作可能启动或重启 Gemini 服务，使该服务短暂不可用；不会重启控制面。宿主仍有授权、终端或推理任务时，会拒绝变更，不会强制停止任务。'

type Confirmation = {
  request: MaintenanceRequest
  target: string | null
}

function Code({ value }: { value: string }) {
  return <code className='text-xs [overflow-wrap:anywhere]'>{value}</code>
}

function BootstrapNotice({ endpointMissing }: { endpointMissing: boolean }) {
  const [clipboard, setClipboard] = useState<'copied' | 'failed' | null>(null)

  async function copy() {
    try {
      await navigator.clipboard.writeText(COMMAND)
      setClipboard('copied')
    } catch {
      setClipboard('failed')
    }
  }

  return (
    <div className='min-w-0 space-y-3'>
      <Alert>
        <AlertTitle>需要宿主机初始化</AlertTitle>
        <AlertDescription>
          {endpointMissing
            ? '控制面没有 Gemini 维护接口。请先升级控制面；若宿主的维护服务尚未初始化，再运行下方命令。'
            : '控制面无法连接 Gemini 维护服务，面板不能代为初始化。请在 Linux amd64 宿主机运行以下命令，完成后刷新状态。'}
        </AlertDescription>
      </Alert>
      <p className='text-sm text-muted-foreground'>
        如果安装目录不是 <code>/opt/vm2api</code>，请先替换为宿主机现有 vm2api
        安装目录的绝对路径。
      </p>
      <pre className='rounded-md border bg-muted/40 p-3 text-xs [overflow-wrap:anywhere] whitespace-pre-wrap'>
        {COMMAND}
      </pre>
      <div className='flex flex-wrap items-center gap-2'>
        <Button
          type='button'
          size='sm'
          variant='outline'
          onClick={() => void copy()}
        >
          {clipboard === 'copied' ? <Check /> : <Copy />}
          复制安装命令
        </Button>
        <span role='status' className='text-sm text-muted-foreground'>
          {clipboard === 'copied' ? '已复制。' : null}
          {clipboard === 'failed'
            ? '无法访问剪贴板，请手动选择并复制命令。'
            : null}
        </span>
      </div>
    </div>
  )
}

function HostStatus({ snapshot }: { snapshot: MaintenanceSnapshot }) {
  const { service, payload } = snapshot
  return (
    <>
      <dl className='grid grid-cols-1 gap-x-4 gap-y-3 text-sm sm:grid-cols-2'>
        <div>
          <dt className='text-muted-foreground'>Gemini 服务</dt>
          <dd className='mt-1'>
            <Badge variant={service.active ? 'secondary' : 'outline'}>
              {service.active
                ? '运行中'
                : service.installed
                  ? '已安装，未运行'
                  : '未安装'}
            </Badge>
          </dd>
        </div>
        <div>
          <dt className='text-muted-foreground'>签名载荷</dt>
          <dd className='mt-1 break-all'>
            {payloadLabels[payload.state] ?? payload.state}
            {payload.issue ? (
              <>
                {' '}
                · <Code value={payload.issue} />
              </>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className='text-muted-foreground'>当前 CRAGGemini 版本</dt>
          <dd className='font-mono break-all'>{payload.version ?? '未报告'}</dd>
        </div>
        <div>
          <dt className='text-muted-foreground'>当前 Antigravity CLI 版本</dt>
          <dd className='font-mono break-all'>
            {payload.cli_version ?? '未报告'}
          </dd>
        </div>
      </dl>
      {payload.activation_required ? (
        <Alert>
          <AlertTitle>当前版本需要兑换</AlertTitle>
          <AlertDescription>
            请前往{' '}
            <Link to='/crag-subscription' className='text-primary underline'>
              订阅 CRAG
            </Link>{' '}
            兑换当前版本后再验证推理。
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  )
}

function MaintenanceActivity({ snapshot }: { snapshot: MaintenanceSnapshot }) {
  const { job, checks } = snapshot
  return (
    <div className='space-y-4 border-t pt-4'>
      <div className='space-y-2'>
        <h3 className='text-sm font-medium'>最近一次维护任务</h3>
        <div role='status' className='space-y-1 text-sm'>
          {job ? (
            <>
              <p className='flex flex-wrap items-center gap-2'>
                <span>{maintenanceActionLabels[job.action]}</span>
                <Badge
                  variant={
                    job.status === 'failed' ? 'destructive' : 'secondary'
                  }
                >
                  {jobStates[job.status]}
                </Badge>
              </p>
              <p className='text-muted-foreground'>
                阶段：{phaseLabels[job.phase] ?? <Code value={job.phase} />}
              </p>
              {job.status === 'failed' ? (
                <p className='text-destructive'>
                  {job.error_code ? (
                    <>
                      错误代码：
                      <Code value={job.error_code} />
                    </>
                  ) : (
                    '宿主未返回错误代码。'
                  )}{' '}
                  请查看下方诊断结果，再决定是否重试或恢复环境。
                </p>
              ) : null}
            </>
          ) : (
            <p className='text-muted-foreground'>尚无任务。可先诊断宿主。</p>
          )}
        </div>
      </div>
      <div className='space-y-2'>
        <h3 className='text-sm font-medium'>诊断结果</h3>
        {checks.length ? (
          <ul className='divide-y rounded-md border'>
            {checks.map(({ id, state, code }) => (
              <li
                key={id}
                className='flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2'
              >
                <span className='mr-auto text-sm [overflow-wrap:anywhere]'>
                  {id}
                </span>
                <Badge variant={state === 'fail' ? 'destructive' : 'outline'}>
                  {checkStates[state]}
                </Badge>
                {code ? <Code value={code} /> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className='text-sm text-muted-foreground'>
            暂无检查结果。运行「诊断宿主」查看详情。
          </p>
        )}
      </div>
    </div>
  )
}

function releaseLabel(release: MaintenanceRelease) {
  return `CRAGGemini ${release.version} / CLI ${release.cli_version} · ${release.compatible ? '兼容' : '不兼容'}${release.installed ? ' · 已安装' : ''}`
}

function InferenceValidation({
  maintenanceBusy,
  geminiBusy,
}: {
  maintenanceBusy: boolean
  geminiBusy: boolean
}) {
  const id = useId()
  const inventory = useQuery(geminiInventoryOptions())
  const [environmentId, setEnvironmentId] = useState('')
  const environments = inventory.data?.environments ?? []
  const environment = environments.find((item) => item.id === environmentId)
  const available = inventory.data?.available === true && !inventory.isError
  const disabled = maintenanceBusy || !available

  return (
    <section
      aria-labelledby={`${id}-title`}
      className='min-w-0 space-y-3 border-t pt-4'
    >
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='min-w-0 space-y-1'>
          <h3 id={`${id}-title`} className='text-base font-medium'>
            验证真实推理
          </h3>
          <p className='max-w-prose text-sm text-muted-foreground'>
            宿主修复或更新成功不代表 Google
            账号已获授权、具备资格或能成功推理。选择现有环境后，可自行拉取模型并发送一条真实测试对话；测试可能消耗账号额度或积分，不会自动发送。
          </p>
        </div>
        <Button asChild size='sm' variant='outline'>
          <Link to='/import' search={{ tab: 'gemini' }}>
            导入或授权 Gemini
          </Link>
        </Button>
      </div>
      {inventory.isPending ? (
        <p role='status' className='text-sm text-muted-foreground'>
          正在读取 Gemini 环境…
        </p>
      ) : null}
      {inventory.isError || inventory.data?.available === false ? (
        <div className='space-y-2'>
          <Alert variant={inventory.isError ? 'destructive' : 'default'}>
            <AlertTitle>
              {inventory.isError ? '读取环境失败' : 'Gemini 宿主不可用'}
            </AlertTitle>
            <AlertDescription className='[overflow-wrap:anywhere]'>
              {inventory.isError
                ? '请刷新环境后再测试。'
                : inventory.data?.host_message ||
                  '请先恢复 Gemini 服务，然后刷新环境。'}
            </AlertDescription>
          </Alert>
          <Button
            type='button'
            variant='outline'
            size='sm'
            loading={inventory.isFetching}
            onClick={() => void inventory.refetch()}
          >
            刷新环境
          </Button>
        </div>
      ) : null}
      {available && !environments.length ? (
        <p className='text-sm text-muted-foreground'>
          暂无 Gemini 环境。请先导入或新建环境并完成授权。
        </p>
      ) : null}
      {environments.length ? (
        <div className='space-y-2'>
          <Label htmlFor={`${id}-environment`}>测试环境</Label>
          <Select
            value={environment?.id ?? ''}
            onValueChange={setEnvironmentId}
            disabled={disabled || geminiBusy}
          >
            <SelectTrigger
              id={`${id}-environment`}
              className='w-full max-w-full sm:max-w-md'
            >
              <SelectValue placeholder='选择现有 Gemini 环境' />
            </SelectTrigger>
            <SelectContent className='max-w-(--radix-select-content-available-width)'>
              {environments.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  <span className='[overflow-wrap:anywhere]'>
                    {item.name} ({item.id})
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {maintenanceBusy ? (
        <p role='status' className='text-sm text-muted-foreground'>
          维护任务结束后可验证推理。
        </p>
      ) : null}
      {environment ? (
        <>
          <p className='text-sm text-muted-foreground'>
            {geminiAuthorizationLabel(environment)}
            {environment.auth_method === 'oauth' && environment.oauth_imported
              ? '（需完成官方 CLI 授权）'
              : null}
          </p>
          <fieldset disabled={disabled} className='min-w-0'>
            <legend className='sr-only'>推理测试</legend>
            <GeminiTestPanel
              key={JSON.stringify([environment.id, environment.proxy_id])}
              environment={environment}
            />
          </fieldset>
        </>
      ) : null}
    </section>
  )
}

export function GeminiInstallPane() {
  const id = useId()
  const client = useQueryClient()
  const returnFocus = useRef<HTMLButtonElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const status = useQuery(maintenanceQueryOptions)
  const geminiBusy = useGeminiBusy()
  const [releaseId, setReleaseId] = useState('')
  const [confirm, setConfirm] = useState<Confirmation | null>(null)
  const snapshot = status.data?.available ? status.data : undefined
  const unavailable = status.data?.available === false ? status.data : undefined
  const jobId = snapshot?.job?.id
  const jobStatus = snapshot?.job?.status
  const statusKey = maintenanceQueryOptions.queryKey
  const mutationKey = [...statusKey, 'start']
  const submit = useMutation({
    mutationKey,
    mutationFn: startMaintenance,
    networkMode: 'always',
    retry: false,
    onSuccess: async (result) => {
      // Discard status reads that may have begun before the job was accepted.
      await client.cancelQueries({ queryKey: statusKey })
      client.setQueryData(statusKey, result)
    },
    onError: () => client.invalidateQueries({ queryKey: statusKey }),
  })

  useEffect(() => {
    if (jobId && (jobStatus === 'completed' || jobStatus === 'failed')) {
      void client.invalidateQueries({
        queryKey: geminiInventoryOptions().queryKey,
      })
    }
  }, [client, jobId, jobStatus])

  const running = jobStatus === 'running'
  const maintenanceBusy = running || submit.isPending
  const blocked = status.isError || maintenanceBusy || geminiBusy
  const releases = snapshot?.releases ?? []
  const selection = releases.find(({ id }) => id === releaseId)
  const compatibleReleases = releases.filter(({ compatible }) => compatible)
  const release =
    selection ??
    (compatibleReleases.length === 1 ? compatibleReleases[0] : undefined)
  const hasInstalledPayload =
    !!snapshot?.payload.version &&
    ['installed', 'awaiting_redemption'].includes(snapshot.payload.state)
  const canUpdateCli = !!release?.compatible && hasInstalledPayload
  const submitCode = isApiError(submit.error) ? submit.error.code : ''
  const statusCode = isApiError(status.error) ? status.error.code : ''

  function start(request: MaintenanceRequest) {
    if (blocked || client.isMutating({ mutationKey })) return
    setConfirm(null)
    submit.mutate(request)
  }

  function confirmAction(
    request: MaintenanceRequest,
    target: string | null = null
  ) {
    return (event: MouseEvent<HTMLButtonElement>) => {
      returnFocus.current = event.currentTarget
      setConfirm({ request, target })
    }
  }

  const confirmedRelease = releases.find(
    ({ id }) => id === confirm?.request.release_id
  )
  const confirmDisabled =
    blocked ||
    !snapshot ||
    (!!confirm?.request.release_id && !confirmedRelease?.compatible) ||
    (confirm?.request.action === 'rollback' &&
      (!snapshot.rollback.available ||
        snapshot.rollback.version !== confirm.target)) ||
    ((confirm?.request.action === 'update_cli' ||
      confirm?.request.action === 'update_native') &&
      !hasInstalledPayload)

  return (
    <section
      id={GEMINI_MAINTENANCE_SECTION_ID}
      aria-labelledby={`${id}-title`}
      className='max-w-3xl min-w-0 space-y-4'
    >
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='space-y-1'>
          <h2
            ref={heading}
            id={`${id}-title`}
            tabIndex={-1}
            className='text-base font-medium'
          >
            Gemini 维护
          </h2>
          <p className='max-w-prose text-sm text-muted-foreground'>
            检查宿主、修复运行环境，并管理受信签名版本。
          </p>
        </div>
        <Button
          type='button'
          size='sm'
          variant='outline'
          disabled={submit.isPending}
          loading={!running && status.isFetching}
          onClick={() => void status.refetch({ cancelRefetch: false })}
        >
          <RefreshCw aria-hidden='true' /> 刷新状态
        </Button>
      </div>

      {status.isPending ? (
        <div role='status' className='space-y-2 rounded-md border p-4'>
          <span className='sr-only'>正在读取 Gemini 维护状态…</span>
          <Skeleton className='h-4 w-1/3 motion-reduce:animate-none' />
          <Skeleton className='h-4 w-2/3 motion-reduce:animate-none' />
        </div>
      ) : null}
      {status.isError ? (
        <Alert variant='destructive'>
          <AlertTitle>无法读取维护状态</AlertTitle>
          <AlertDescription>
            {snapshot ? '下方为上次读取的状态。' : null}请刷新状态后再提交操作。
            {statusCode ? (
              <>
                {' '}
                错误代码：
                <Code value={statusCode} />
              </>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {submit.isError ? (
        <Alert variant='destructive'>
          <AlertTitle>未能确认任务已提交</AlertTitle>
          <AlertDescription>
            {submitCode ? (
              <>
                错误代码：
                <Code value={submitCode} />。{' '}
              </>
            ) : null}
            请先查看最新任务状态；若宿主繁忙，等待授权、终端或推理任务退出后再试。
          </AlertDescription>
        </Alert>
      ) : null}
      {submit.isPending && !running ? (
        <p role='status' className='text-sm text-muted-foreground'>
          正在向宿主提交任务…
        </p>
      ) : null}
      {!status.isError && unavailable ? (
        unavailable.bootstrap_required ? (
          <BootstrapNotice
            endpointMissing={
              unavailable.code === 'maintenance_endpoint_missing'
            }
          />
        ) : (
          <Alert variant='destructive'>
            <AlertTitle>维护服务不可访问</AlertTitle>
            <AlertDescription>
              请在宿主机检查控制面是否有权访问维护服务，然后刷新状态。错误代码：
              <Code value={unavailable.code} />
            </AlertDescription>
          </Alert>
        )
      ) : null}
      {snapshot ? (
        <Card className='min-w-0'>
          <CardHeader>
            <CardTitle role='heading' aria-level={3}>
              宿主状态与维护
            </CardTitle>
          </CardHeader>
          <CardContent className='min-w-0 space-y-4 px-4 sm:px-6'>
            <HostStatus snapshot={snapshot} />
            <div className='flex flex-wrap gap-2'>
              <Button
                type='button'
                size='sm'
                variant='outline'
                disabled={blocked}
                onClick={() => start({ action: 'diagnose' })}
              >
                {maintenanceActionLabels.diagnose}
              </Button>
              <Button
                type='button'
                size='sm'
                variant='outline'
                disabled={blocked}
                onClick={confirmAction({ action: 'install' })}
              >
                {maintenanceActionLabels.install}
              </Button>
              <Button
                type='button'
                size='sm'
                variant='outline'
                disabled={blocked}
                onClick={confirmAction({ action: 'repair' })}
              >
                {maintenanceActionLabels.repair}
              </Button>
              <Button
                type='button'
                size='sm'
                variant='outline'
                disabled={blocked}
                onClick={confirmAction({ action: 'recover' })}
              >
                {maintenanceActionLabels.recover}
              </Button>
            </div>
            <p className='max-w-prose text-sm text-muted-foreground'>
              安装沿用宿主机已配置的来源；首次安装使用随维护服务提供的受信版本。
            </p>
            {geminiBusy && !maintenanceBusy ? (
              <p role='status' className='text-sm text-muted-foreground'>
                请等待当前 Gemini 操作结束后再维护宿主。
              </p>
            ) : null}
            <div className='min-w-0 space-y-3 border-t pt-4'>
              <h3 className='text-sm font-medium'>签名版本管理</h3>
              {releases.length ? (
                <div className='min-w-0 space-y-2'>
                  <Label htmlFor={`${id}-release`}>更新目标版本</Label>
                  <Select
                    value={release?.id ?? ''}
                    onValueChange={setReleaseId}
                    disabled={blocked}
                  >
                    <SelectTrigger
                      id={`${id}-release`}
                      aria-describedby={`${id}-compatibility`}
                      className='w-full max-w-full'
                    >
                      <SelectValue placeholder='选择签名版本' />
                    </SelectTrigger>
                    <SelectContent className='max-w-(--radix-select-content-available-width)'>
                      {releases.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          <span className='[overflow-wrap:anywhere]'>
                            {releaseLabel(item)}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              <p
                id={`${id}-compatibility`}
                className='max-w-prose text-sm text-muted-foreground'
              >
                {!releases.length
                  ? '受信版本目录为空，不能从目录更新。'
                  : !compatibleReleases.length
                    ? '目录没有与此宿主兼容的版本。'
                    : !release?.compatible
                      ? '请选择兼容版本后再更新。'
                      : '已选择兼容版本。'}{' '}
                仅更新 CLI
                需要已安装的原生组件。宿主会验证它们与目标签名清单一致后才执行变更。
              </p>
              <div className='flex flex-wrap gap-2'>
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  disabled={blocked || !canUpdateCli}
                  onClick={
                    release &&
                    confirmAction(
                      { action: 'update_cli', release_id: release.id },
                      releaseLabel(release)
                    )
                  }
                >
                  {maintenanceActionLabels.update_cli}
                </Button>
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  disabled={
                    blocked || !release?.compatible || !hasInstalledPayload
                  }
                  onClick={
                    release &&
                    confirmAction(
                      { action: 'update_native', release_id: release.id },
                      releaseLabel(release)
                    )
                  }
                >
                  {maintenanceActionLabels.update_native}
                </Button>
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  disabled={blocked || !snapshot.rollback.available}
                  onClick={confirmAction(
                    { action: 'rollback' },
                    snapshot.rollback.version
                  )}
                >
                  {maintenanceActionLabels.rollback}
                </Button>
              </div>
              <p className='text-sm [overflow-wrap:anywhere] text-muted-foreground'>
                {snapshot.rollback.available
                  ? `可回滚版本：${snapshot.rollback.version ?? '宿主未报告版本号'}。`
                  : '没有可回滚的上一版本。'}{' '}
                签名清单变更后可能需要重新兑换激活；回滚会恢复上一版本保存的激活记录。
              </p>
            </div>
            <MaintenanceActivity snapshot={snapshot} />
          </CardContent>
        </Card>
      ) : null}

      <InferenceValidation
        maintenanceBusy={maintenanceBusy}
        geminiBusy={geminiBusy}
      />

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const trigger = returnFocus.current
            if (trigger?.isConnected && !trigger.disabled) trigger.focus()
            else heading.current?.focus()
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm
                ? `${maintenanceActionLabels[confirm.request.action]}？`
                : '确认维护操作'}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className='space-y-2 [overflow-wrap:anywhere]'>
                {confirm?.target ? <p>目标：{confirm.target}</p> : null}
                <p>{restartCopy}</p>
                {confirm?.request.release_id ? (
                  <p>如果签名清单变更，可能需要重新兑换激活。</p>
                ) : null}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <Button
              type='button'
              disabled={confirmDisabled}
              onClick={() => confirm && start(confirm.request)}
            >
              {confirm
                ? maintenanceActionLabels[confirm.request.action]
                : '确认'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
