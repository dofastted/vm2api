import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { Check } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { credTypeOf } from '@/lib/cred-type'
import { importErrorMessage } from '@/lib/import-errors'
import { isCodexVm } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { StatusMark } from '@/components/status-mark'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { routingQueryOptions } from '@/features/settings/queries'
import { CreateVmDialog } from '@/features/vm/create-vm-dialog'
import {
  CredentialPanel,
  type CommitResult,
} from '@/features/vm/credential-panel'
import {
  OfficialCcFacts,
  OfficialCcTrack,
  officialCcErrorHint,
  officialCcStepLabel,
} from '@/features/vm/official-cc-card'
import { officialCcBootstrapQueryOptions } from '@/features/vm/queries'
import { ImportProxyStep } from './import-proxy-step'

type Bootstrap = { scheduled?: boolean; reason?: string } | null

// 步骤定义对齐 index.html:4258 renderImportRail() —— 两边词汇必须一致。
const STEPS = [
  { n: 1, label: '空槽' },
  { n: 2, label: '代理' },
  { n: 3, label: '换票' },
  { n: 4, label: '初装' },
]

/** 该槽能否换票：权威字段优先，回落看有没有绑代理。对齐 index.html:7952。 */
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

function StepDots({
  current,
  natural,
  onGo,
}: {
  current: number
  natural: number
  onGo: (n: number) => void
}) {
  return (
    <ol
      aria-label={`上线流程，共 ${STEPS.length} 步，当前第 ${current} 步`}
      className='flex flex-wrap items-center gap-x-4 gap-y-1'
    >
      {STEPS.map((s) => {
        const done = s.n < natural
        const active = s.n === current
        const canGo = s.n < natural || (s.n === natural && current !== natural)
        const inner = (
          <>
            {done && !active ? (
              <Check className='size-3.5' aria-hidden='true' />
            ) : (
              <span
                aria-hidden='true'
                className={
                  'inline-block size-2 rounded-full ' +
                  (active ? 'bg-foreground' : 'border border-current')
                }
              />
            )}
            {s.label}
            <span className='sr-only'>
              {done ? '（已完成）' : active ? '（当前步）' : '（未开始）'}
            </span>
          </>
        )
        const cls =
          'inline-flex items-center gap-1.5 text-xs ' +
          (active ? 'font-medium text-foreground' : 'text-muted-foreground')
        return (
          <li key={s.n} aria-current={active ? 'step' : undefined}>
            {canGo ? (
              <button type='button' className={cls} onClick={() => onGo(s.n)}>
                {inner}
              </button>
            ) : (
              <span className={cls}>{inner}</span>
            )}
          </li>
        )
      })}
    </ol>
  )
}

/**
 * 堆叠里的一节。已完成的步骤不折叠 —— 留在页面上是 index 的形态，
 * 让人能回头改代理而不必倒退整个流程。对齐 .import-block 的三态。
 */
function Block({
  n,
  title,
  lead,
  step,
  done,
  children,
}: {
  n: number
  title: string
  lead: string
  step: number
  done: boolean
  children?: React.ReactNode
}) {
  const cur = step === n
  return (
    <section className='border-b py-4 last:border-b-0'>
      <div className='mb-1.5 flex items-center gap-2'>
        <span
          aria-hidden='true'
          className='inline-flex size-4 shrink-0 items-center justify-center'
          style={{
            color: cur || done ? 'var(--status-ok)' : 'var(--status-none)',
          }}
        >
          {done && !cur ? (
            <Check className='size-3.5' />
          ) : (
            <span className='inline-block size-2 rounded-full bg-current' />
          )}
        </span>
        <h3
          className={
            'text-sm ' +
            (cur || done
              ? 'font-semibold text-foreground'
              : 'font-medium text-muted-foreground')
          }
        >
          {title}
        </h3>
      </div>
      <p className='mb-3 max-w-[52ch] text-xs leading-relaxed text-muted-foreground'>
        {lead}
      </p>
      {children}
    </section>
  )
}

export function CredentialFlow() {
  const dash = useQuery(dashboardQueryOptions())
  const routing = useQuery(routingQueryOptions())
  const qc = useQueryClient()

  const [vmId, setVmId] = useState('')
  /** 换票成功后钉住的槽：留在本页看初装，对齐 index 的 importDoneVmId。 */
  const [pinnedId, setPinnedId] = useState('')
  const [backTo, setBackTo] = useState<number | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [pendingBootstrap, setPendingBootstrap] = useState('')
  const bootSeen = useRef('')

  const vms: Vm[] = dash.data?.vms || []
  const empty = vms.filter((v) => !v.has_token)
  const pinned = pinnedId ? vms.find((v) => v.id === pinnedId) || null : null
  const current = pinned || vms.find((v) => v.id === vmId) || null
  const activeId = pinned ? pinnedId : current ? vmId : ''
  const hasProxy = canImportOauth(current)

  // 对齐 index.html:4198 importNaturalStep()
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
  // 注意 pinned 分支要放行：换票成功的那一刻本槽正好会从 empty 里消失。
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

  function continueImport() {
    setPinnedId('')
    setVmId('')
    setBackTo(null)
    setPendingBootstrap('')
    bootSeen.current = ''
  }

  function finishWithoutImport() {
    toast.success('槽已就绪，可稍后导入账号')
    continueImport()
  }

  function stepBack(n: number) {
    if (pinnedId) {
      continueImport()
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

  return (
    <Card className='max-w-2xl'>
      <CardHeader className='gap-3'>
        <CardTitle>上线一台槽</CardTitle>
        <StepDots current={step} natural={natural} onGo={stepBack} />
      </CardHeader>
      <CardContent>
        {pinned ? (
          <div className='space-y-4'>
            <div className='flex items-start justify-between gap-3 border-b pb-4'>
              <div className='min-w-0'>
                <p className='text-base font-semibold'>
                  {pinned.name || pinned.id}
                </p>
                <p className='mt-0.5 text-xs break-all text-muted-foreground'>
                  {pinned.email ||
                    (isCodexVm(pinned)
                      ? 'GPT OAuth 已写入'
                      : credType === 'oauth'
                        ? '票已写入，正在本页初装'
                        : '凭证已写入')}
                </p>
              </div>
              <Button size='sm' variant='outline' onClick={continueImport}>
                继续导入
              </Button>
            </div>

            {isCodexVm(pinned) ? (
              <p className='text-xs text-muted-foreground'>
                GPT 槽不跑 Claude 官方初装。账号用 Codex OAuth 或 auth.json。
              </p>
            ) : credType === 'oauth' ? (
              <>
                {autoOff ? (
                  <p className='text-xs text-muted-foreground'>
                    设置里关闭了换票后自动初装，可在下面手动执行。
                  </p>
                ) : null}
                <div className='space-y-2 rounded-md border p-3'>
                  <div className='flex items-center gap-2'>
                    <StatusMark
                      tone={{
                        key: 'bootstrap',
                        text: bootDone
                          ? '初装完成'
                          : bootStatus?.status === 'error'
                            ? '初装失败'
                            : '初装进行中',
                        cls: bootDone
                          ? 'ok'
                          : bootStatus?.status === 'error'
                            ? 'bad'
                            : 'warn',
                      }}
                      variant='pill'
                    />
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
                      <p style={{ color: 'var(--status-bad)' }}>
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
                </div>
                {boot.error ? (
                  <p className='text-xs' style={{ color: 'var(--status-bad)' }}>
                    {importErrorMessage(boot.error)}
                  </p>
                ) : null}
              </>
            ) : (
              <p className='text-xs text-muted-foreground'>
                {credType === 'apikey'
                  ? 'Console Key 不跑官方初装。'
                  : 'Setup Token 不跑官方初装。'}
              </p>
            )}
          </div>
        ) : (
          <div className='flex flex-col'>
            <Block
              n={1}
              step={step}
              done={!!current}
              title='选一台空槽'
              lead={
                empty.length
                  ? '只列出还没有凭证的虚拟机。可先创建空槽，账号稍后导入。'
                  : '现在没有空槽。先创建一台，或等有槽卸下凭证。'
              }
            >
              <div className='flex items-center gap-2'>
                <Select value={vmId || undefined} onValueChange={setVmId}>
                  <SelectTrigger className='flex-1' aria-label='待导入虚拟机'>
                    <SelectValue
                      placeholder={empty.length ? '选择空槽' : '没有空槽'}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {empty.map((vm) => (
                      <SelectItem key={vm.id} value={vm.id}>
                        {vm.name || vm.id}
                        {isCodexVm(vm) ? ' · GPT' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size='sm'
                  variant='outline'
                  onClick={() => setCreateOpen(true)}
                >
                  创建
                </Button>
                {current ? (
                  <Button
                    size='sm'
                    variant='ghost'
                    onClick={finishWithoutImport}
                  >
                    稍后导入账号
                  </Button>
                ) : null}
              </div>
              {!current && empty.length ? (
                <p className='mt-2.5 text-xs text-muted-foreground tabular-nums'>
                  {empty.length} 个空槽可导入
                </p>
              ) : null}
            </Block>

            {current ? (
              <Block
                n={2}
                step={step}
                done={hasProxy}
                title='绑 SOCKS5'
                lead={
                  hasProxy
                    ? '已绑到本槽。改选或粘贴新行会盖掉这条。'
                    : '转发必须走槽上代理。选一条现成的，或粘贴一行新的。'
                }
              >
                <ImportProxyStep vmId={vmId} />
              </Block>
            ) : null}

            {current && hasProxy ? (
              <Block
                n={3}
                step={step}
                done={false}
                title={isCodexVm(current) ? '导入 GPT 账号' : '换票'}
                lead={
                  isCodexVm(current)
                    ? 'Codex OAuth 或账号文件（auth.json）。不要用 Setup Token / Console Key。'
                    : 'Cookie、授权链接或官方 Claude Code，都经刚绑的 SOCKS5。成功后留在本页看初装。'
                }
              >
                <CredentialPanel
                  vm={current}
                  onCommitted={(data, target, what) =>
                    void afterCommit(data, target, what)
                  }
                />
                <Button
                  size='sm'
                  variant='ghost'
                  className='mt-2'
                  onClick={finishWithoutImport}
                >
                  稍后导入账号
                </Button>
              </Block>
            ) : null}
          </div>
        )}
      </CardContent>
      <CreateVmDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        // 导入流程下不自动分配代理 —— 第 2 步要手选。对齐 index.html:3687
        // `state.view === 'import' ? 'idle' : tpl.after`。
        defaultAfter='idle'
        onCreated={(id) => {
          setVmId(id)
          setBackTo(null)
        }}
      />
    </Card>
  )
}
