import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import type {
  TestModelsPayload,
  Vm,
  VmKernelSnapshot,
  VmProxySnap,
} from '@/types/panel-vm'
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
  sessionCapOf,
  vmCost,
  weeklySplitInfo,
} from '@/lib/fable-status'
import { usedPctOf } from '@/lib/format'
import { compactEmail, isCodexVm } from '@/lib/vm-kind'
import {
  accountStatus,
  claudeTier,
  poolStatus,
  vmCooldownTitle,
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
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/components/page-header'
import { PlatformChip, SlotIdentity } from '@/components/platform-chip'
import { QueryGate } from '@/components/query-gate'
import { StatusMark } from '@/components/status-mark'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { proxiesQueryOptions } from '@/features/proxies/queries'
import { VmAccountTab } from '@/features/vm/detail-account-tab'
import { VmOpsTab } from '@/features/vm/detail-ops-tab'
import { VmOverviewTab } from '@/features/vm/detail-overview-tab'
import { VmProxyTab } from '@/features/vm/detail-proxy-tab'
import { VmDetailSkeleton } from '@/features/vm/detail-skeleton'
import { VmTestTab } from '@/features/vm/detail-test-tab'
import {
  testModelsQueryOptions,
  vmQueryOptions,
  vmSeedQueryOptions,
} from '@/features/vm/queries'
import { SchedulableSwitch } from '@/features/vm/schedulable-switch'
import { SeedPolicyCard } from '@/features/vm/seed-policy-card'
import type { TestChatResult } from '@/features/vm/test-chat-types'

function postVm<T = unknown>(id: string, path: string, body?: unknown) {
  return api<T>(`/api/panel/vms/${encodeURIComponent(id)}${path}`, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

export function VmDetailPage() {
  const { id } = useParams({ from: '/_authenticated/vm/$id' })
  const navigate = useNavigate()
  const qc = useQueryClient()
  const dash = useQuery(dashboardQueryOptions(5000))
  const proxies = useQuery(proxiesQueryOptions())
  const detail = useQuery(vmQueryOptions(id))
  const seed = useQuery(vmSeedQueryOptions(id))
  const testModels = useQuery(testModelsQueryOptions(id))
  const [tab, setTab] = useState('overview')
  const [prompt, setPrompt] = useState('hello')
  const [model, setModel] = useState('')
  const [maxTokens, setMaxTokens] = useState(8192)
  const [reasoningEffort, setReasoningEffort] = useState('medium')
  const [testResult, setTestResult] = useState<TestChatResult | null>(null)
  const [bindId, setBindId] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [resetInput, setResetInput] = useState('')
  const data = detail.data || {}
  const listVm = (dash.data?.vms || []).find((v) => v.id === id)
  const vm = ((data.vm as Vm | undefined) || listVm || { id }) as Vm
  const kernel = (data.kernel as VmKernelSnapshot | undefined) || null
  const acc = (data.account as Record<string, unknown> | undefined) || {}
  const proxy = ((data.proxy as VmProxySnap | undefined) ||
    vm.proxy ||
    {}) as VmProxySnap
  const models = testModels.data?.items || testModels.data?.models || []
  useEffect(() => {
    if (!models.length) return
    if (!model || !models.some((item) => item.id === model)) {
      setModel(models[0].id)
    }
  }, [models, model])
  const refreshAll = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: vmQueryOptions(id).queryKey }),
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: proxiesQueryOptions().queryKey }),
    ])
  }
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) =>
      postVm(id, path, body),
    onSuccess: async (_data, vars) => {
      toast.success('已执行 ' + vars.path)
      await refreshAll()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const saveTimezone = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/api/panel/vms/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: async (_data, body) => {
      toast.success(
        body.timezone_follow_proxy ? '已跟随代理时区' : '已保存时区'
      )
      await refreshAll()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const testChat = useMutation({
    mutationFn: () =>
      postVm<TestChatResult>(id, '/test-chat', {
        model: model || models[0]?.id,
        prompt,
        ...(isCodexVm(vm)
          ? { reasoning_effort: reasoningEffort }
          : { max_tokens: maxTokens }),
      }),
    onSuccess: (data) => {
      setTestResult(data)
      // 外层 envelope 的 ok 恒为 true（业务成败在剥壳后的 data.ok），
      // 所以失败也会走到这里 —— 不能只 toast.success。
      if (data?.ok) {
        toast.success(`测试成功 · ${data.duration_ms ?? 0}ms`)
      } else {
        toast.error(`测试失败：${data?.error?.message || '未知错误'}`)
      }
    },
    onError: (error: Error) => {
      setTestResult({
        ok: false,
        duration_ms: 0,
        log: [],
        error: { message: error.message },
      })
      toast.error(error.message)
    },
  })
  const saveSeed = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/api/panel/vms/${encodeURIComponent(id)}/seed-settings`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: async () => {
      toast.success('已播种')
      await qc.invalidateQueries({
        queryKey: vmSeedQueryOptions(id).queryKey,
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const remove = useMutation({
    mutationFn: () =>
      api(`/api/panel/vms/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: async () => {
      toast.success('已删除')
      await qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey })
      navigate({ to: '/vm' })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const resetVm = useMutation({
    mutationFn: () => postVm(id, '/reset', {}),
    onSuccess: async () => {
      toast.success(`已销毁并重建 ${id}`)
      setConfirmReset(false)
      setResetInput('')
      await refreshAll()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const pool = proxies.data?.proxies || []
  const boundId = String(proxy.id || vm.proxy_id || '')
  const free = pool.filter((p) => {
    if (!p.enabled || p.status === 'dead') return false
    const ids = p.bound_vm_ids || (p.bound_vm_id ? [p.bound_vm_id] : [])
    return !ids.includes(id) && ids.length < (p.bind_limit || 5)
  })
  const pol =
    (seed.data?.seed_policy as Record<string, unknown> | undefined) || {}
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
  const sess = sessionCapOf(vm)
  const conc = concInfo(vm, dash.data?.routing?.tiers, fableCap(dash.data))
  const rpm = rpmInfo(vm, acc)
  const todayReadCache = Number(
    acc.today_cache_read_tokens ?? vm.today_cache_read_tokens ?? 0
  )
  const todayWriteCache = Number(
    acc.today_cache_creation_tokens ?? vm.today_cache_creation_tokens ?? 0
  )
  const todayInput = Number(acc.tokens_in ?? vm.tokens_in ?? 0)
  const todayHit = cacheHitPct(todayInput, todayReadCache, todayWriteCache)
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
          {(dash.data?.vms || []).length > 1 ? (
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
                {(dash.data?.vms || []).map((v) => (
                  <SelectItem key={v.id} value={v.id} className='max-w-[280px]'>
                    <SlotIdentity vm={v} compact />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <PlatformChip vm={vm} />
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
            <TooltipContent>{vmCooldownTitle(vm)}</TooltipContent>
          </Tooltip>
          <span className='text-sm text-muted-foreground'>
            {vmRunning(vm) ? '运行' : '停止'}
          </span>
          <div className='flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm text-muted-foreground'>
            调度
            <SchedulableSwitch
              vmId={id}
              schedulable={vm.schedulable !== false}
            />
          </div>
          <div className='ms-auto flex flex-wrap gap-2'>
            {vmRunning(vm) ? (
              <Button
                size='sm'
                variant='outline'
                onClick={() => act.mutate({ path: '/stop' })}
              >
                关机
              </Button>
            ) : (
              <Button size='sm' onClick={() => act.mutate({ path: '/start' })}>
                开机
              </Button>
            )}
            <Button
              size='sm'
              variant='outline'
              onClick={() => act.mutate({ path: '/probe', body: {} })}
            >
              探测
            </Button>
          </div>
        </div>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value='overview'>概览</TabsTrigger>
            <TabsTrigger value='account'>账号</TabsTrigger>
            <TabsTrigger value='proxy'>代理</TabsTrigger>
            <TabsTrigger value='test'>测试</TabsTrigger>
            <TabsTrigger value='ops'>运维</TabsTrigger>
            <TabsTrigger value='seed'>种子</TabsTrigger>
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
            sess={sess}
            conc={conc}
            rpm={rpm}
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
            canRefresh={canRefresh}
            refreshBlocked={refreshBlocked}
            busyPath={act.isPending ? act.variables?.path : null}
            onNeedProxy={() => setTab('proxy')}
            onAction={(path, body) => act.mutate({ path, body })}
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
            bindId={bindId}
            onBindIdChange={setBindId}
            onUnbind={() =>
              api(`/api/panel/proxies/${boundId}/unbind`, {
                method: 'POST',
                body: JSON.stringify({ vm_id: id }),
              })
                .then(refreshAll)
                .catch((error: Error) => toast.error(error.message))
            }
            onAllocate={() => act.mutate({ path: '/allocate-proxy' })}
            onBind={() =>
              api(`/api/panel/proxies/${bindId || free[0].id}/bind`, {
                method: 'POST',
                body: JSON.stringify({ vm_id: id }),
              })
                .then(() => {
                  toast.success('已绑定')
                  return refreshAll()
                })
                .catch((error: Error) => toast.error(error.message))
            }
          />
          <VmTestTab
            models={models}
            model={model}
            prompt={prompt}
            maxTokens={maxTokens}
            reasoningEffort={reasoningEffort}
            credType={credType}
            isCodex={isCodexVm(vm)}
            result={testResult}
            running={testChat.isPending}
            modelsRefreshing={testModels.isFetching}
            onModelChange={setModel}
            onPromptChange={setPrompt}
            onMaxTokensChange={setMaxTokens}
            onReasoningEffortChange={setReasoningEffort}
            onTest={() => {
              setTestResult(null)
              testChat.mutate()
            }}
            onRefreshModels={() => {
              void (async () => {
                try {
                  const data = await api<TestModelsPayload>(
                    `/api/panel/test-models?vm_id=${encodeURIComponent(id)}&refresh=1`
                  )
                  qc.setQueryData(testModelsQueryOptions(id).queryKey, data)
                } catch (error) {
                  toast.error((error as Error).message || '刷新模型失败')
                }
              })()
            }}
          />
          <VmOpsTab
            vm={vm}
            proxy={proxy}
            officialCc={officialCc}
            credType={credType}
            canRefresh={canRefresh}
            refreshBlocked={refreshBlocked}
            savingTimezone={saveTimezone.isPending}
            onAction={(path, body) => act.mutate({ path, body })}
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
          <TabsContent value='seed' className='space-y-3 pt-4'>
            <p className='text-sm text-muted-foreground'>
              官方 Claude Code 初装之后的后置覆写。开=删键 · 关=写 1。
            </p>
            <SeedPolicyCard
              policy={pol}
              saving={saveSeed.isPending}
              onSave={(next) => saveSeed.mutate(next)}
            />
          </TabsContent>
        </Tabs>
        <ConfirmDialog
          open={confirmDel}
          onOpenChange={setConfirmDel}
          title={`删除 ${id}`}
          desc='删除槽位不可恢复。'
          confirmText='删除'
          cancelBtnText='取消'
          destructive
          handleConfirm={() => remove.mutate()}
        />
        <ConfirmDialog
          open={confirmReset}
          onOpenChange={(open) => {
            setConfirmReset(open)
            if (!open) setResetInput('')
          }}
          title='重置'
          desc={
            <>
              <p>
                {vm.name && vm.name !== id ? `${vm.name} · ` : ''}
                {id}
              </p>
              <p className='mt-2 text-destructive'>
                销毁容器与家目录，再按原槽位重新创建。保留
                ID、名称、内核、时区、代理和种子策略。凭证、指纹、统计和 guest
                家目录会清空。
              </p>
            </>
          }
          confirmText='销毁并重建'
          cancelBtnText='取消'
          destructive
          disabled={resetInput.trim() !== id}
          isLoading={resetVm.isPending}
          handleConfirm={() => resetVm.mutate()}
        >
          <Input
            autoFocus
            autoComplete='off'
            spellCheck={false}
            placeholder={id}
            aria-label='确认 ID'
            value={resetInput}
            onChange={(e) => setResetInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && resetInput.trim() === id) {
                resetVm.mutate()
              }
            }}
          />
        </ConfirmDialog>
      </QueryGate>
    </PageHeader>
  )
}
