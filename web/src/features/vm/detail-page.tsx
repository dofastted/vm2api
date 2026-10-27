import { useMemo, useState } from 'react'
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import type { Vm, VmKernelSnapshot, VmProxySnap } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import {
  canRefreshCredential,
  credTypeOf,
  supportsOfficialCc,
} from '@/lib/cred-type'
import {
  concInfo,
  fableCap,
  rpmInfo,
  vmCost,
  weeklySplitInfo,
} from '@/lib/fable-status'
import { usedPctOf } from '@/lib/format'
import { compactEmail, isCodexVm } from '@/lib/vm-kind'
import {
  accountStatus,
  claudeTier,
  poolStatus,
  restrictionCopy,
  vmRunning,
} from '@/lib/vm-status'
import { cacheHitPct } from '@/lib/vm-usage'
import { useNow } from '@/hooks/use-now'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ChoiceTiles } from '@/components/choice-tiles'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/components/page-header'
import { PlatformChip, SlotIdentity } from '@/components/platform-chip'
import { QueryGate } from '@/components/query-gate'
import { StatusMark } from '@/components/status-mark'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { proxiesForVmBind } from '@/features/proxies/proxy-sort'
import { proxiesQueryOptions } from '@/features/proxies/queries'
import { routingQueryOptions } from '@/features/settings/queries'
import { VmAccountTab } from '@/features/vm/detail-account-tab'
import { VmOpsTab } from '@/features/vm/detail-ops-tab'
import { VmOverviewTab } from '@/features/vm/detail-overview-tab'
import { VmProxyTab } from '@/features/vm/detail-proxy-tab'
import { VmDetailSkeleton } from '@/features/vm/detail-skeleton'
import { VmTestTab } from '@/features/vm/detail-test-tab'
import { bootOutcome, vmTodayCounts } from '@/features/vm/detail-today'
import { ActiveVmBadge } from '@/features/vm/active-vm-badge'
import {
  planDeleteActiveVm,
  type DeleteActiveVmPlan,
} from '@/features/vm/active-vm'
import { DeleteActiveVmHint } from '@/features/vm/delete-active-hint'
import { NodeChip } from '@/features/vm/node-chip'
import { probeOutcome, type ProbeCheck } from '@/features/vm/probe-status'
import {
  vmQueryOptions,
  vmSeedQueryOptions,
  vmSeedUploadLogQueryOptions,
  vmsListQueryOptions,
} from '@/features/vm/queries'
import { RuntimeChip } from '@/features/vm/runtime-chip'
import {
  SchedulableSwitch,
  vmSchedulableProps,
} from '@/features/vm/schedulable-switch'
import { SeedPolicyCard } from '@/features/vm/seed-policy-card'
import { usePoolSeatStream } from '@/features/vm/use-pool-seat-stream'
import { useVmTestChat } from '@/features/vm/use-vm-test-chat'
import {
  pickBindTarget,
  useVmPerms,
  visibleTab,
  vmDetailTabs,
} from '@/features/vm/vm-perms'
import { VmTestSchedule } from '@/features/vm/vm-test-schedule'

function postVm<T = unknown>(id: string, path: string, body?: unknown) {
  return api<T>(`/api/panel/vms/${encodeURIComponent(id)}${path}`, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

type VmJob = {
  key: string
  run: () => Promise<unknown>
  done?: (data: unknown) => void
}

/** 页签留在外层：切槽位时主体按 id 重挂清掉上一个槽的输入，但停在同一页签。 */
export function VmDetailPage() {
  const { id } = useParams({ from: '/_authenticated/vm/$id' })
  const [tab, setTab] = useState('overview')
  return <VmDetailBody key={id} id={id} tab={tab} onTabChange={setTab} />
}

function VmDetailBody({
  id,
  tab: wantedTab,
  onTabChange,
}: {
  id: string
  tab: string
  onTabChange: (tab: string) => void
}) {
  const navigate = useNavigate()
  const [seedDebug, setSeedDebug] = useState(false)
  const qc = useQueryClient()
  const perms = useVmPerms()
  const dash = useQuery({
    ...dashboardQueryOptions(5000),
    enabled: perms.dashboard,
  })
  // 租户读不了 dashboard，槽位下拉改用自己能看到的列表。
  const slots = useQuery({
    ...vmsListQueryOptions(),
    enabled: perms.known && !perms.dashboard,
  })
  const proxies = useQuery({ ...proxiesQueryOptions(), enabled: perms.admin })
  const detail = useQuery({
    ...vmQueryOptions(id),
    refetchInterval: wantedTab === 'seed' ? 2000 : false,
  })
  const seed = useQuery({
    ...vmSeedQueryOptions(id),
    enabled: perms.admin && wantedTab === 'seed',
    refetchInterval: wantedTab === 'seed' ? 2000 : false,
  })
  const seedUploadLog = useQuery({
    ...vmSeedUploadLogQueryOptions(id),
    enabled: perms.admin && wantedTab === 'seed' && seedDebug,
    refetchInterval: seedDebug && wantedTab === 'seed' ? 2000 : false,
  })
  const routing = useQuery({ ...routingQueryOptions(), enabled: perms.admin })
  usePoolSeatStream()

  const tabs = vmDetailTabs(perms)
  const tab = visibleTab(wantedTab, tabs)

  const [bindId, setBindId] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [resetMode, setResetMode] = useState<'keep' | 'traits'>('keep')
  const [resetInput, setResetInput] = useState('')
  const data = detail.data || {}
  const slotList: Vm[] =
    (perms.dashboard ? dash.data?.vms : slots.data?.items) || []
  const listVm = slotList.find((v) => v.id === id)
  const vm = ((data.vm as Vm | undefined) || listVm || { id }) as Vm
  const kernel = (data.kernel as VmKernelSnapshot | undefined) || null
  const acc = (data.account as Record<string, unknown> | undefined) || {}
  const proxy = ((data.proxy as VmProxySnap | undefined) ||
    vm.proxy ||
    {}) as VmProxySnap
  const seedSlot = useMemo(() => {
    const locale =
      typeof vm.locale === 'string'
        ? vm.locale
        : vm.locale === null
          ? null
          : undefined
    return {
      timezone: vm.timezone,
      timezone_source: vm.timezone_source,
      locale,
    }
  }, [vm.timezone, vm.timezone_source, vm.locale])
  const test = useVmTestChat(vm)
  const refreshAll = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: vmQueryOptions(id).queryKey }),
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: proxiesQueryOptions().queryKey }),
    ])
  }
  // 每个按钮按自己的 key 记进行中，可同时跑多个而互不覆盖。
  const jobKey = ['panel', 'vm-detail-job', id] as const
  const job = useMutation({
    mutationKey: jobKey,
    mutationFn: (j: VmJob) => j.run(),
    onSuccess: async (data, j) => {
      j.done?.(data)
      await refreshAll()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const pendingKeys = useMutationState({
    filters: { mutationKey: jobKey, status: 'pending' },
    select: (m) => (m.state.variables as VmJob | undefined)?.key ?? '',
  })
  const busy = (key: string) => pendingKeys.includes(key)
  const runJob = (j: VmJob) => {
    if (!busy(j.key)) job.mutate(j)
  }
  const act = (path: string, body?: unknown) =>
    runJob({
      key: path,
      run: () => postVm(id, path, body),
      done: (data) => {
        if (path === '/probe') {
          const probe = data as ProbeCheck
          if (probe.ok === true) toast.success(probeOutcome(probe))
          else toast.error(probeOutcome({ ...probe, ok: false }))
        } else if (path === '/start') {
          const boot = bootOutcome(data)
          if (boot.ok) toast.success(boot.message)
          else toast.warning(boot.message)
        } else if (path === '/stop') {
          toast.success('已关机，调度已关闭')
        } else if (path === '/activate') {
          toast.success('已设为活跃槽')
        } else {
          toast.success('已执行 ' + path)
        }
      },
    })
  const saveTimezone = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/api/panel/vms/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: async (saved, body) => {
      const sync = (
        saved as { timezone_sync?: { kernel_hot?: boolean } } | undefined
      )?.timezone_sync
      const hot = sync?.kernel_hot ? ' · 已热更新 kernel.json' : ''
      toast.success(
        (body.timezone_follow_proxy ? '已跟随代理时区' : '已保存时区') + hot
      )
      await refreshAll()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const saveSeed = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/api/panel/vms/${encodeURIComponent(id)}/seed-settings`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: async () => {
      toast.success('已播种')
      await refreshAll()
      await qc.invalidateQueries({
        queryKey: ['panel', 'vm', id, 'seed'],
      })
      await qc.invalidateQueries({
        queryKey: ['panel', 'vm', id, 'seed-upload-log'],
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const deletePlan: DeleteActiveVmPlan = planDeleteActiveVm(vm, slotList)
  const remove = useMutation({
    mutationFn: async () => {
      if (deletePlan.kind === 'switch') {
        await api(
          `/api/panel/vms/${encodeURIComponent(deletePlan.replacement.id)}/activate`,
          { method: 'POST' }
        )
      }
      return api(`/api/panel/vms/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
    },
    onSuccess: async () => {
      toast.success(
        deletePlan.kind === 'switch'
          ? `已切换活跃到 ${deletePlan.replacement.id} 并删除 ${id}`
          : '已删除'
      )
      await qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey })
      navigate({ to: '/vm' })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const resetVm = useMutation({
    mutationFn: (mode: 'keep' | 'traits') => postVm(id, '/reset', { mode }),
    onSuccess: async (_data, mode) => {
      toast.success(
        mode === 'keep' ? `已保留原数据重建 ${id}` : `已按新特征重建 ${id}`
      )
      setConfirmReset(false)
      setResetInput('')
      await refreshAll()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const pool = proxies.data?.proxies || []
  const boundId = String(proxy.id || vm.proxy_id || '')
  // 本地代理固定第一。已绑到本槽的留在下拉里，否则正在用它时列表里没有。
  const free = proxiesForVmBind(pool, id, 5, vm.node_id ?? null)
  const bindTarget = pickBindTarget(bindId, free)
  const syncTelemetry =
    (routing.data?.official_cc as { sync_telemetry?: boolean } | undefined)
      ?.sync_telemetry === true
  const quotaSrc = {
    utilization_5h: acc.utilization_5h ?? vm.utilization_5h,
    utilization_7d: acc.utilization_7d ?? vm.utilization_7d,
    codex_usage: (acc.codex_usage as Vm['codex_usage']) || vm.codex_usage,
  }
  const u5 = usedPctOf(quotaSrc, '5h')
  const u7 = usedPctOf(quotaSrc, '7d')
  const tierKey = claudeTier(vm).key
  const now = useNow()
  const cost = vmCost(vm)
  const split = weeklySplitInfo(
    (acc.weekly_split ? acc : vm) as Record<string, unknown>
  )
  const conc = concInfo(vm, dash.data?.routing?.tiers, fableCap(dash.data))
  const rpm = rpmInfo(vm, acc)
  const todayReadCache = Number(
    acc.today_cache_read_tokens ?? vm.today_cache_read_tokens ?? 0
  )
  const todayWriteCache = Number(
    acc.today_cache_creation_tokens ?? vm.today_cache_creation_tokens ?? 0
  )
  const todayInput = Number(
    acc.today_input_tokens ??
      vm.today_input_tokens ??
      acc.tokens_in ??
      vm.tokens_in ??
      0
  )
  const todayHit = cacheHitPct(todayInput, todayReadCache, todayWriteCache)
  const today = vmTodayCounts(vm, data.billing)
  const credType = credTypeOf(vm)
  const officialCc = supportsOfficialCc(vm)
  const canRefresh = canRefreshCredential(vm)
  // gateway 的 credential_mode_unsupported 在「手动初装」与「刷新凭证」下
  // 语义不同，这里按各自来源给文案，提前禁用而不是等 400。
  const refreshBlocked =
    credType === 'apikey'
      ? 'Console API Key 不能刷新'
      : credType === 'setup-token' && !vm.has_refresh
        ? '官方 Setup Token（无 refresh）不能刷新'
        : ''

  return (
    <PageHeader
      title={vm.email ? compactEmail(vm.email, 28) : vm.name || vm.id}
      fluid
    >
      <QueryGate
        loading={detail.isLoading && !listVm}
        error={detail.error}
        skeleton={<VmDetailSkeleton />}
      >
        <div className='mb-4 flex flex-wrap items-center gap-2'>
          <Button variant='ghost' size='sm' asChild>
            <Link to='/vm'>列表</Link>
          </Button>
          {slotList.length > 1 ? (
            <Select
              value={id}
              onValueChange={(next) =>
                navigate({ to: '/vm/$id', params: { id: next } })
              }
            >
              <SelectTrigger className='h-8 w-[220px]' aria-label='切换节点'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {slotList.map((v) => (
                  <SelectItem key={v.id} value={v.id} className='max-w-[280px]'>
                    <SlotIdentity vm={v} compact />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <PlatformChip vm={vm} />
          <ActiveVmBadge vm={vm} className='text-[11px]' />
          <RuntimeChip vm={vm} className='text-[11px]' />
          <NodeChip nodeId={vm.node_id} className='text-[11px]' />
          <StatusMark tone={accountStatus(vm)} variant='pill' />
          {claudeTier(vm).key !== 'none' ? (
            <StatusMark tone={claudeTier(vm)} variant='pill' />
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <StatusMark tone={poolStatus(vm)} variant='pill' />
              </span>
            </TooltipTrigger>
            <TooltipContent>{restrictionCopy(vm)}</TooltipContent>
          </Tooltip>
          <span className='text-sm text-muted-foreground'>
            {vmRunning(vm) ? '运行' : '停止'}
          </span>
          <div className='flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm text-muted-foreground'>
            调度
            <SchedulableSwitch {...vmSchedulableProps(vm)} />
          </div>
          {perms.power ? (
            <div className='ms-auto flex flex-wrap gap-2'>
              {vmRunning(vm) ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <Button
                        size='sm'
                        variant='outline'
                        loading={busy('/stop')}
                        disabled={busy('/start')}
                        onClick={() => act('/stop')}
                      >
                        关机
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>关机会同时关闭调度</TooltipContent>
                </Tooltip>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <Button
                        size='sm'
                        loading={busy('/start')}
                        disabled={busy('/stop')}
                        onClick={() => act('/start')}
                      >
                        开机
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>有凭证时开机会重新开启调度</TooltipContent>
                </Tooltip>
              )}
              <Button
                size='sm'
                variant='outline'
                loading={busy('/probe')}
                onClick={() => act('/probe', {})}
              >
                探测
              </Button>
            </div>
          ) : null}
        </div>
        <Tabs value={tab} onValueChange={onTabChange}>
          <TabsList>
            <TabsTrigger value='overview'>概览</TabsTrigger>
            <TabsTrigger value='account'>账号</TabsTrigger>
            <TabsTrigger value='proxy'>代理</TabsTrigger>
            {tabs.includes('test') ? (
              <TabsTrigger value='test'>测试</TabsTrigger>
            ) : null}
            {tabs.includes('ops') ? (
              <TabsTrigger value='ops'>运维</TabsTrigger>
            ) : null}
            {tabs.includes('seed') ? (
              <TabsTrigger value='seed'>种子</TabsTrigger>
            ) : null}
          </TabsList>
          <VmOverviewTab
            kernel={kernel}
            vm={vm}
            acc={acc}
            proxy={proxy}
            dash={dash}
            u5={u5}
            u7={u7}
            tierKey={tierKey}
            now={now}
            cost={cost}
            split={split}
            conc={conc}
            rpm={rpm}
            today={today}
            costByModel={data.billing?.by_model}
            billing={data.billing}
          />
          <VmAccountTab
            id={id}
            vm={vm}
            acc={acc}
            dash={dash}
            credType={credType}
            officialCc={officialCc}
            u5={u5}
            u7={u7}
            tierKey={tierKey}
            todayReadCache={todayReadCache}
            todayWriteCache={todayWriteCache}
            todayHit={todayHit}
            today={today}
            canRefresh={canRefresh}
            refreshBlocked={refreshBlocked}
            busy={busy}
            onNeedProxy={() => onTabChange('proxy')}
            onAction={act}
            onCredentialCommitted={async (_data, _target, what) => {
              toast.success(what)
              await refreshAll()
            }}
          />
          <VmProxyTab
            vm={vm}
            proxy={proxy}
            boundId={boundId}
            free={free}
            pool={pool}
            bindId={bindTarget}
            canManage={perms.admin}
            busy={busy}
            onBindIdChange={setBindId}
            onUnbind={() =>
              runJob({
                key: 'proxy:unbind',
                run: () =>
                  api(`/api/panel/proxies/${boundId}/unbind`, {
                    method: 'POST',
                    body: JSON.stringify({ vm_id: id }),
                  }),
                done: () => toast.success('已解绑'),
              })
            }
            onAllocate={() => act('/allocate-proxy')}
            onBind={() =>
              runJob({
                key: 'proxy:bind',
                run: () =>
                  api(`/api/panel/proxies/${bindTarget}/bind`, {
                    method: 'POST',
                    body: JSON.stringify({ vm_id: id }),
                  }),
                done: () => toast.success('已绑定'),
              })
            }
            onProbe={() =>
              runJob({
                key: 'proxy:probe',
                run: () =>
                  api(`/api/panel/proxies/${boundId}/probe`, {
                    method: 'POST',
                  }),
                done: () => toast.success('探测完成'),
              })
            }
            onGeo={() =>
              runJob({
                key: 'proxy:geo',
                run: () =>
                  api(`/api/panel/proxies/${boundId}/geo`, { method: 'POST' }),
                done: (data) => {
                  const geo = (
                    data as {
                      geo?: {
                        timezone?: string | null
                        country?: string | null
                      }
                    }
                  )?.geo
                  const where = [geo?.country, geo?.timezone]
                    .filter(Boolean)
                    .join(' · ')
                  toast.success(where ? `出口位置 ${where}` : '已检测')
                },
              })
            }
          />
          {perms.test ? (
            <VmTestTab
              {...test}
              vm={vm}
              credType={credType}
              isCodex={isCodexVm(vm)}
              dataplane={vm.resolved_dataplane}
              schedule={<VmTestSchedule key={vm.id} vm={vm} {...test} />}
            />
          ) : null}
          {perms.admin ? (
            <>
              <VmOpsTab
                vm={vm}
                proxy={proxy}
                officialCc={officialCc}
                credType={credType}
                canRefresh={canRefresh}
                refreshBlocked={refreshBlocked}
                savingTimezone={saveTimezone.isPending}
                onAction={act}
                busy={busy}
                onRefresh={() => void refreshAll()}
                onTimezoneSave={(timezone) => saveTimezone.mutate({ timezone })}
                onTimezoneFollowProxy={() =>
                  saveTimezone.mutate({ timezone_follow_proxy: true })
                }
                onReset={() => {
                  setResetInput('')
                  setConfirmReset(true)
                }}
                onDelete={() => setConfirmDel(true)}
              />
              <TabsContent value='seed' className='pt-4'>
                {seed.data ? (
                  <SeedPolicyCard
                    seed={seed.data}
                    slot={seedSlot}
                    telemetry={kernel?.telemetry}
                    saving={saveSeed.isPending}
                    syncTelemetry={syncTelemetry}
                    debug={seedDebug}
                    onDebug={setSeedDebug}
                    uploadLog={seedUploadLog.data}
                    proxyTimezone={proxy.geo?.timezone || ''}
                    onSave={(next) => saveSeed.mutate(next)}
                  />
                ) : (
                  <p className='text-sm text-muted-foreground'>
                    {seed.isError ? '种子策略读取失败' : '读取种子策略…'}
                  </p>
                )}
              </TabsContent>
            </>
          ) : null}
        </Tabs>
        <ConfirmDialog
          open={confirmDel}
          onOpenChange={setConfirmDel}
          title={`删除 ${id}`}
          desc={
            <>
              <p>删除槽位不可恢复。</p>
              <DeleteActiveVmHint target={vm} vms={slotList} />
            </>
          }
          confirmText={
            deletePlan.kind === 'switch' ? '切换活跃并删除' : '删除'
          }
          cancelBtnText='取消'
          destructive
          disabled={deletePlan.kind === 'blocked'}
          isLoading={remove.isPending}
          handleConfirm={() => {
            if (!remove.isPending && deletePlan.kind !== 'blocked') {
              remove.mutate()
            }
          }}
        />
        <ConfirmDialog
          open={confirmReset}
          onOpenChange={(open) => {
            setConfirmReset(open)
            if (!open) setResetInput('')
          }}
          title='重建槽位'
          desc={
            <>
              <p>
                {vm.name && vm.name !== id ? `${vm.name} · ` : ''}
                {id}
              </p>
              <p className='mt-2'>
                本地槽和集群槽都换当前 kernel、cli-node 与 Go 遥测后的容器。
              </p>
            </>
          }
          confirmText={resetMode === 'keep' ? '保留原数据重建' : '重建新特征'}
          cancelBtnText='取消'
          destructive={resetMode === 'traits'}
          disabled={resetInput.trim() !== id}
          isLoading={resetVm.isPending}
          handleConfirm={() => resetVm.mutate(resetMode)}
        >
          <ChoiceTiles
            label='重建方式'
            value={resetMode}
            onChange={setResetMode}
            choices={[
              {
                value: 'keep',
                title: '保留原数据重建',
                detail: '留下凭证、指纹、主机名和统计，只换容器里的服务。',
              },
              {
                value: 'traits',
                title: '重建新特征',
                detail:
                  '清掉凭证和家目录，重新生成主机名、machine-id 和设备特征。',
              },
            ]}
          />
          <Input
            autoFocus
            autoComplete='off'
            spellCheck={false}
            placeholder={id}
            aria-label='确认 ID'
            value={resetInput}
            onChange={(e) => setResetInput(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                resetInput.trim() === id &&
                !resetVm.isPending
              ) {
                resetVm.mutate(resetMode)
              }
            }}
          />
        </ConfirmDialog>
      </QueryGate>
    </PageHeader>
  )
}
