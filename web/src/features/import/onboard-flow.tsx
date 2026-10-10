import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { Vm } from '@/types/panel-vm'
import { Check } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { credTypeOf } from '@/lib/cred-type'
import { importErrorMessage } from '@/lib/import-errors'
import { cn } from '@/lib/utils'
import { isCodexVm } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import { ChoiceTiles, Segmented } from '@/components/choice-tiles'
import { PlatformChip } from '@/components/platform-chip'
import { StatusMark } from '@/components/status-mark'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { proxyLabel } from '@/features/proxies/proxy-sort'
import { routingQueryOptions } from '@/features/settings/queries'
import { kernelProfile } from '@/features/vm/create-options'
import {
  CreateVmForm,
  SpecSheet,
  draftSpecRows,
  machineLine,
  useCreateVmDraft,
  type SpecRow,
} from '@/features/vm/create-vm-form'
import {
  CredentialPanel,
  type CommitResult,
} from '@/features/vm/credential-panel'
import { runtimeTypeOf } from '@/features/vm/machine-spec'
import { NodeChip } from '@/features/vm/node-chip'
import {
  OfficialCcFacts,
  OfficialCcTrack,
  officialCcErrorHint,
  officialCcStepLabel,
} from '@/features/vm/official-cc-card'
import { officialCcBootstrapQueryOptions } from '@/features/vm/queries'
import { RuntimeChip } from '@/features/vm/runtime-chip'
import { ImportProxyStep } from './import-proxy-step'

type Bootstrap = { scheduled?: boolean; reason?: string } | null
type Source = 'new' | 'existing'

const STEPS = [
  { n: 1, label: '槽位' },
  { n: 2, label: '出口' },
  { n: 3, label: '账号' },
  { n: 4, label: '上线' },
] as const

/** 该槽能否换票：权威字段优先，回落看有没有绑代理。 */
function canImportOauth(vm: Vm | null): boolean {
  if (!vm?.id) return false
  if (vm.can_import_credential != null) return !!vm.can_import_credential
  return !!(vm.proxy?.host || vm.proxy_id)
}

function bootstrapOk(bs: Bootstrap) {
  if (!bs) return false
  if (bs.scheduled) return true
  return bs.reason === 'already_initialized'
}

function bootstrapReason(bs: Bootstrap) {
  const reason = bs?.reason || 'unknown'
  const map: Record<string, string> = {
    disabled: '官方初装在路由配置中被关闭',
    already_running: '该槽已有初装任务在跑',
    credential_edit: '本次只改了凭证，未触发初装',
    // 同名码在「手动初装 400」与「刷新凭证 400」下语义不同，
    // 这里只解释「导入成功后自动调度被跳过」这一种来源。
    credential_mode_unsupported:
      '此槽为 Setup Token / Console API Key 凭证，官方初装仅支持完整 OAuth',
    mock: '网关处于 mock 模式',
    'vmId required': '网关未收到槽位 ID',
  }
  return map[reason] || `原因：${reason}`
}

function slotSpecRows(vm: Vm): SpecRow[] {
  const runtime = runtimeTypeOf(vm)
  return [
    { label: '槽位', value: vm.name || vm.id },
    { label: '平台', value: <PlatformChip vm={vm} /> },
    {
      label: '形态',
      value: runtime === 'kvm' ? '虚拟机 (KVM)' : '容器 (Docker)',
    },
    {
      label: '系统',
      value: kernelProfile(vm.kernel)?.name || vm.kernel || '—',
    },
    {
      label: '规格',
      value: vm.machine
        ? machineLine(
            runtime,
            vm.machine.memory,
            vm.machine.vcpus,
            vm.machine.disk_gb
          )
        : '—',
    },
    { label: '放置', value: <NodeChip nodeId={vm.node_id} /> },
    {
      label: '出口',
      value: vm.proxy?.host ? (
        proxyLabel(vm.proxy)
      ) : (
        <span className='text-muted-foreground'>未绑定</span>
      ),
    },
    {
      label: '账号',
      value: vm.email || (
        <span className='text-muted-foreground'>
          {vm.has_token ? '已导入' : '未导入'}
        </span>
      ),
    },
  ]
}

/**
 * 步骤点。done = 已过，current = 正在做；能回去的步骤是按钮。
 * rail（桌面右栏）竖排带说明，inline（窄屏）横排只留名称。
 */
function Stepper({
  current,
  natural,
  captions,
  onGo,
  layout,
}: {
  current: number
  natural: number
  captions: Record<number, ReactNode>
  onGo: (n: number) => void
  layout: 'rail' | 'inline'
}) {
  return (
    <ol
      aria-label={`上线流程，共 ${STEPS.length} 步，当前第 ${current} 步`}
      className={
        layout === 'rail'
          ? 'relative space-y-0'
          : 'flex flex-wrap items-center gap-x-4 gap-y-1'
      }
    >
      {STEPS.map((s, i) => {
        const done = s.n < natural && s.n !== current
        const active = s.n === current
        const canGo = s.n < natural || (s.n === natural && current !== natural)
        const mark = (
          <span
            aria-hidden='true'
            className={cn(
              'relative z-10 inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold tabular-nums transition-colors duration-150',
              active &&
                'border-select-solid bg-select-solid text-select-solid-fg',
              done && 'border-select-border bg-background text-select-fg',
              !active && !done && 'bg-background text-muted-foreground'
            )}
          >
            {done ? <Check className='size-3' strokeWidth={3} /> : s.n}
          </span>
        )
        const text = (
          <span className='min-w-0'>
            <span
              className={cn(
                'block text-sm leading-5',
                active
                  ? 'font-semibold text-foreground'
                  : 'text-muted-foreground',
                done && 'text-foreground'
              )}
            >
              {s.label}
            </span>
            {layout === 'rail' && captions[s.n] ? (
              <span className='block truncate text-xs text-muted-foreground'>
                {captions[s.n]}
              </span>
            ) : null}
            <span className='sr-only'>
              {done ? '（已完成）' : active ? '（当前步）' : '（未开始）'}
            </span>
          </span>
        )
        const body = (
          <>
            {mark}
            {text}
          </>
        )
        const cls = cn(
          'flex min-w-0 items-start gap-2.5 rounded-md text-left',
          layout === 'rail' && 'w-full py-2',
          canGo && 'hover:[&>span:last-child>span:first-child]:text-foreground'
        )
        return (
          <li
            key={s.n}
            aria-current={active ? 'step' : undefined}
            className='relative'
          >
            {layout === 'rail' && i < STEPS.length - 1 ? (
              <span
                aria-hidden='true'
                className={cn(
                  'absolute top-7 bottom-0 left-[9.5px] w-px',
                  s.n < natural ? 'bg-select-border/70' : 'bg-border'
                )}
              />
            ) : null}
            {canGo ? (
              <button type='button' className={cls} onClick={() => onGo(s.n)}>
                {body}
              </button>
            ) : (
              <span className={cls}>{body}</span>
            )}
          </li>
        )
      })}
    </ol>
  )
}

/**
 * 流程里的一节。过了的步骤不折叠成看不见：留一行回执，
 * 能回头改出口而不必倒退整个流程。
 */
function Step({
  n,
  title,
  lead,
  step,
  done,
  children,
}: {
  n: number
  title: string
  lead?: ReactNode
  step: number
  done: boolean
  children?: ReactNode
}) {
  const cur = step === n
  return (
    <section
      aria-labelledby={`onboard-step-${n}`}
      className='border-t py-6 first:border-t-0 first:pt-0 last:pb-0'
    >
      <div className='mb-1 flex items-center gap-2.5'>
        <span
          aria-hidden='true'
          className={cn(
            'inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold tabular-nums',
            cur && 'border-select-solid bg-select-solid text-select-solid-fg',
            done && !cur && 'border-select-border text-select-fg',
            !cur && !done && 'text-muted-foreground'
          )}
        >
          {done && !cur ? <Check className='size-3' strokeWidth={3} /> : n}
        </span>
        <h3
          id={`onboard-step-${n}`}
          className={cn(
            'text-base',
            cur || done
              ? 'font-semibold text-foreground'
              : 'font-medium text-muted-foreground'
          )}
        >
          {title}
        </h3>
      </div>
      {lead ? (
        <p className='mb-4 ml-[30px] max-w-[60ch] text-xs leading-relaxed text-muted-foreground'>
          {lead}
        </p>
      ) : null}
      {children ? <div className='sm:ml-[30px]'>{children}</div> : null}
    </section>
  )
}

/** 选中的槽在第 1 步缩成的一行：是谁、什么形态、在哪。 */
function SlotReceipt({ vm, onChange }: { vm: Vm; onChange?: () => void }) {
  return (
    <div className='flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-lg border px-3 py-2.5'>
      <span className='text-sm font-semibold'>{vm.name || vm.id}</span>
      <PlatformChip vm={vm} />
      <RuntimeChip vm={vm} />
      <NodeChip nodeId={vm.node_id} />
      <span className='text-xs text-muted-foreground'>
        {kernelProfile(vm.kernel)?.name || vm.kernel}
      </span>
      {onChange ? (
        <Button
          size='sm'
          variant='ghost'
          className='ms-auto h-7 px-2 text-xs'
          onClick={onChange}
        >
          换一台
        </Button>
      ) : null}
    </div>
  )
}

export function OnboardFlow() {
  const dash = useQuery(dashboardQueryOptions())
  const routing = useQuery(routingQueryOptions())
  const qc = useQueryClient()

  const [source, setSource] = useState<Source>('new')
  const [vmId, setVmId] = useState('')
  /** 换票成功后钉住的槽：留在本页看初装与开机。 */
  const [pinnedId, setPinnedId] = useState('')
  const [backTo, setBackTo] = useState<number | null>(null)
  const [pendingBootstrap, setPendingBootstrap] = useState('')
  const bootSeen = useRef('')

  const draft = useCreateVmDraft({
    pinnedAfter: 'idle',
    onCreated: (id) => {
      setVmId(id)
      setBackTo(null)
    },
  })

  const vms: Vm[] = dash.data?.vms || []
  const empty = vms.filter((v) => !v.has_token)
  const pinned = pinnedId ? vms.find((v) => v.id === pinnedId) || null : null
  const current = pinned || vms.find((v) => v.id === vmId) || null
  const activeId = pinned ? pinnedId : current ? vmId : ''
  const hasProxy = canImportOauth(current)

  const natural = pinned
    ? 4
    : !current
      ? 1
      : !hasProxy
        ? 2
        : current.has_token
          ? 4
          : 3
  const step = backTo != null && backTo < natural ? backTo : natural

  useEffect(() => {
    if (backTo != null && natural <= backTo) setBackTo(null)
  }, [natural, backTo])

  // 选中的槽被别处导入了凭证 / 被删了，就从选中态退出来。
  // pinned 分支放行：换票成功的那一刻本槽正好会从 empty 里消失。
  const stillEmpty = !!vmId && vms.some((v) => v.id === vmId && !v.has_token)
  useEffect(() => {
    if (pinnedId) return
    if (vmId && !stillEmpty) setVmId('')
  }, [pinnedId, vmId, stillEmpty])

  const boot = useQuery(
    officialCcBootstrapQueryOptions(
      activeId,
      !!activeId && !!current?.has_token
    )
  )
  const bootStatus = boot.data?.status || null
  const bootDone = bootStatus?.status === 'ok'

  useEffect(() => {
    const st = bootStatus?.status
    if (!st || st === 'running') {
      if (st === 'running') bootSeen.current = 'running'
      return
    }
    if (bootSeen.current !== 'running') return
    bootSeen.current = st
    if (st === 'ok') {
      toast.success(
        '官方初装完成' +
          (bootStatus?.account_tier ? ` · ${bootStatus.account_tier}` : '') +
          (bootStatus?.telemetry_official ? ' · 遥测已对齐' : '')
      )
    } else if (st === 'error') {
      const hint = officialCcErrorHint(bootStatus?.error)
      toast.error(
        (bootStatus?.error || '官方初装失败') + (hint ? `。${hint}` : '')
      )
    }
  }, [bootStatus])

  const bootstrap = useMutation({
    mutationFn: (target: string) =>
      api<Bootstrap>(
        `/api/panel/vms/${encodeURIComponent(target)}/official-cc-bootstrap`,
        { method: 'POST', body: JSON.stringify({ force: true, manual: true }) }
      ),
    onSuccess: async (data) => {
      if (bootstrapOk(data)) {
        setPendingBootstrap('')
        toast.success('已重新触发官方初装')
      } else {
        toast.error(`官方初装仍未启动。${bootstrapReason(data)}`)
      }
      await qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey })
      await boot.refetch()
    },
    onError: (error: Error) => toast.error(importErrorMessage(error)),
  })

  const start = useMutation({
    mutationFn: (target: string) =>
      api(`/api/panel/vms/${encodeURIComponent(target)}/start`, {
        method: 'POST',
      }),
    onSuccess: async () => {
      toast.success('已开机')
      await qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey })
    },
    onError: (error: Error) => toast.error(importErrorMessage(error)),
  })

  async function afterCommit(data: CommitResult, target: string, ok: string) {
    const vm = vms.find((item) => item.id === target) || current
    setBackTo(null)
    setPinnedId(target)
    if (isCodexVm(vm ?? undefined)) {
      setPendingBootstrap('')
      toast.success(ok)
      await qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey })
      return
    }
    const bs = data?.official_cc_bootstrap ?? null
    if (bootstrapOk(bs)) {
      setPendingBootstrap('')
      toast.success(ok)
    } else if (bs?.reason === 'credential_mode_unsupported') {
      setPendingBootstrap('')
      toast.success(`${ok}。${bootstrapReason(bs)}`)
    } else {
      setPendingBootstrap(target)
      toast.warning(`${ok}，但官方初装未启动。${bootstrapReason(bs)}`)
    }
    await qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey })
    await qc.invalidateQueries({
      queryKey: officialCcBootstrapQueryOptions(target).queryKey,
    })
  }

  function restart() {
    setPinnedId('')
    setVmId('')
    setBackTo(null)
    setPendingBootstrap('')
    bootSeen.current = ''
  }

  function finishWithoutImport() {
    toast.success('槽已就绪，可稍后导入账号')
    restart()
  }

  function stepBack(n: number) {
    if (pinnedId) {
      restart()
      return
    }
    if (n <= 1) {
      setVmId('')
      setBackTo(null)
      return
    }
    setBackTo(n === natural ? null : n)
  }

  const credType = credTypeOf(current ?? undefined)
  const autoOff =
    (routing.data?.official_cc as { enabled?: boolean } | undefined)
      ?.enabled === false
  const running = pinned?.status === 'running'

  const bootTone = bootDone
    ? { key: 'bootstrap', text: '初装完成', cls: 'ok' }
    : bootStatus?.status === 'error'
      ? { key: 'bootstrap', text: '初装失败', cls: 'bad' }
      : { key: 'bootstrap', text: '初装进行中', cls: 'warn' }

  const captions: Record<number, ReactNode> = {
    1: current
      ? current.name || current.id
      : source === 'new'
        ? '新建一台'
        : '从空槽里选',
    2: current ? (hasProxy ? '已绑出口' : '待绑定') : null,
    3: pinned || current?.has_token ? current?.email || '已导入' : null,
    4: pinned
      ? isCodexVm(pinned) || credType !== 'oauth'
        ? running
          ? '运行中'
          : '待开机'
        : bootTone.text
      : null,
  }

  const sheetRows = current
    ? slotSpecRows(current)
    : source === 'new'
      ? draftSpecRows(draft)
      : null

  return (
    <div className='grid items-start gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,1fr)_17rem]'>
      <div className='min-w-0'>
        <div className='mb-6 lg:hidden'>
          <Stepper
            layout='inline'
            current={step}
            natural={natural}
            captions={captions}
            onGo={stepBack}
          />
        </div>

        <Step
          n={1}
          step={step}
          done={!!current}
          title='槽位'
          lead={
            current
              ? undefined
              : source === 'new'
                ? '新建一台空槽：定平台、形态、系统与规格。账号在后面两步再接。'
                : '只列出还没有账号的槽。'
          }
        >
          {current ? (
            <SlotReceipt
              vm={current}
              onChange={pinned ? undefined : () => stepBack(1)}
            />
          ) : (
            <div className='space-y-5'>
              <Segmented
                label='槽位来源'
                value={source}
                onChange={setSource}
                options={[
                  { value: 'new', label: '新建' },
                  {
                    value: 'existing',
                    label: (
                      <span className='inline-flex items-center gap-1.5'>
                        已有空槽
                        <span className='text-xs text-muted-foreground tabular-nums'>
                          {empty.length}
                        </span>
                      </span>
                    ),
                  },
                ]}
              />
              {source === 'new' ? (
                <CreateVmForm draft={draft} variant='flow' />
              ) : empty.length ? (
                <ChoiceTiles
                  label='待导入的空槽'
                  layout='list'
                  value={vmId}
                  onChange={(id) => {
                    setVmId(id)
                    setBackTo(null)
                  }}
                  choices={empty.map((vm) => ({
                    value: vm.id,
                    title: (
                      <span className='inline-flex items-center gap-2'>
                        <span>{vm.name || vm.id}</span>
                        <PlatformChip vm={vm} />
                        <RuntimeChip vm={vm} />
                        <NodeChip nodeId={vm.node_id} />
                      </span>
                    ),
                    detail: [
                      kernelProfile(vm.kernel)?.name || vm.kernel,
                      vm.machine
                        ? machineLine(
                            runtimeTypeOf(vm),
                            vm.machine.memory,
                            vm.machine.vcpus,
                            vm.machine.disk_gb
                          )
                        : null,
                      canImportOauth(vm) ? '已绑出口' : '未绑出口',
                    ]
                      .filter(Boolean)
                      .join(' · '),
                  }))}
                />
              ) : (
                <div className='rounded-lg border border-dashed px-4 py-6 text-center'>
                  <p className='text-sm'>没有空槽</p>
                  <p className='mt-1 text-xs text-muted-foreground'>
                    每台槽都已有账号。新建一台，或在虚拟机页卸下某台的凭证。
                  </p>
                  <Button
                    size='sm'
                    variant='outline'
                    className='mt-3'
                    onClick={() => setSource('new')}
                  >
                    新建一台
                  </Button>
                </div>
              )}
            </div>
          )}
        </Step>

        <Step
          n={2}
          step={step}
          done={!!current && hasProxy}
          title='出口'
          lead={
            !current
              ? '槽位就绪后绑一条 SOCKS5，换票与转发都走它。'
              : hasProxy
                ? '已绑到本槽。改选或粘贴新行会盖掉这条。'
                : '转发必须走槽上的出口。选一条现成的，或粘贴一行新的。'
          }
        >
          {current && !pinned ? (
            <ImportProxyStep vmId={current.id} nodeId={current.node_id} />
          ) : null}
        </Step>

        <Step
          n={3}
          step={step}
          done={!!pinned || !!current?.has_token}
          title={current && isCodexVm(current) ? '导入 GPT 账号' : '账号'}
          lead={
            !current || !hasProxy
              ? '出口绑好后在这里换票：Cookie、授权链接或官方 Claude Code。'
              : isCodexVm(current)
                ? 'Codex OAuth 或账号文件（auth.json）。不要用 Setup Token / Console Key。'
                : 'Cookie、授权链接或官方 Claude Code，都经刚绑的出口。成功后留在本页看初装。'
          }
        >
          {current && hasProxy && !pinned ? (
            <div className='space-y-3'>
              <CredentialPanel
                vm={current}
                onCommitted={(data, target, what) =>
                  void afterCommit(data, target, what)
                }
              />
              <Button size='sm' variant='ghost' onClick={finishWithoutImport}>
                先到这里，稍后导入账号
              </Button>
            </div>
          ) : null}
        </Step>

        <Step
          n={4}
          step={step}
          done={false}
          title='上线'
          lead={
            pinned
              ? undefined
              : '账号写入后：Claude OAuth 槽自动跑官方初装，完成即可调度。'
          }
        >
          {pinned ? (
            <div className='space-y-4'>
              <div className='flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2.5'>
                <StatusMark
                  variant='pill'
                  tone={
                    running
                      ? { key: 'run', text: '运行中', cls: 'ok' }
                      : { key: 'run', text: '未开机', cls: 'none' }
                  }
                />
                <span className='min-w-0 text-sm break-all'>
                  {pinned.email ||
                    (isCodexVm(pinned) ? 'GPT OAuth 已写入' : '凭证已写入')}
                </span>
                <div className='ms-auto flex items-center gap-2'>
                  {!running ? (
                    <Button
                      size='sm'
                      variant='outline'
                      onClick={() => start.mutate(pinned.id)}
                      disabled={start.isPending}
                      loading={start.isPending}
                    >
                      开机
                    </Button>
                  ) : null}
                </div>
              </div>

              {isCodexVm(pinned) ? (
                <p className='text-xs text-muted-foreground'>
                  GPT 槽不跑 Claude 官方初装。
                </p>
              ) : credType === 'oauth' ? (
                <div className='space-y-2 rounded-lg border p-3'>
                  {autoOff ? (
                    <p className='text-xs text-muted-foreground'>
                      设置里关闭了换票后自动初装，可在下面手动执行。
                    </p>
                  ) : null}
                  <div className='flex items-center gap-2'>
                    <StatusMark tone={bootTone} variant='pill' />
                    {bootStatus?.step ? (
                      <span className='text-xs text-muted-foreground'>
                        {officialCcStepLabel(bootStatus.step)}
                      </span>
                    ) : null}
                  </div>
                  <OfficialCcTrack cc={bootStatus} />
                  <OfficialCcFacts cc={bootStatus} />
                  {bootStatus?.error ? (
                    <div className='space-y-1 text-xs'>
                      <p className='text-[color:var(--status-bad)]'>
                        {bootStatus.error}
                      </p>
                      {officialCcErrorHint(bootStatus.error) ? (
                        <p className='text-muted-foreground'>
                          {officialCcErrorHint(bootStatus.error)}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  {pendingBootstrap || bootStatus?.status === 'error' ? (
                    <Button
                      size='sm'
                      variant='outline'
                      onClick={() =>
                        bootstrap.mutate(pendingBootstrap || pinnedId)
                      }
                      disabled={bootstrap.isPending}
                      loading={bootstrap.isPending}
                    >
                      重试官方初装
                    </Button>
                  ) : null}
                  {boot.error ? (
                    <p className='text-xs text-[color:var(--status-bad)]'>
                      {importErrorMessage(boot.error)}
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className='text-xs text-muted-foreground'>
                  {credType === 'apikey'
                    ? 'Console Key 不跑官方初装。'
                    : 'Setup Token 不跑官方初装。'}
                </p>
              )}

              <div className='flex flex-wrap items-center gap-2 border-t pt-4'>
                <Button size='sm' onClick={restart}>
                  再上线一台
                </Button>
                <Button size='sm' variant='ghost' asChild>
                  <Link to='/vm/$id' params={{ id: pinned.id }}>
                    打开槽位详情
                  </Link>
                </Button>
              </div>
            </div>
          ) : null}
        </Step>
      </div>

      <aside
        aria-label='进度与规格'
        className='sticky top-20 hidden space-y-6 lg:block'
      >
        <Stepper
          layout='rail'
          current={step}
          natural={natural}
          captions={captions}
          onGo={stepBack}
        />
        {sheetRows ? (
          <div className='space-y-3 border-t pt-5'>
            <h4 className='text-xs font-medium text-muted-foreground'>
              {current ? '这台槽' : '将要创建'}
            </h4>
            <SpecSheet rows={sheetRows} />
          </div>
        ) : null}
      </aside>
    </div>
  )
}
