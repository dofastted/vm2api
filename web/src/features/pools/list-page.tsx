import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { VIEW_TITLES } from '@/config/nav'
import type {
  PoolRole,
  ProviderScope,
  SchedulerPool,
  SystemPromptMode,
} from '@/types/panel-pools'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  KeyRound,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Server,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { TableSkeleton } from '@/components/page-skeletons'
import { QueryGate } from '@/components/query-gate'
import {
  createSchedulerPool,
  deleteSchedulerPool,
  updateSchedulerPool,
} from './api'
import {
  PoolRoleBadge,
  PromptModeBadge,
  ProviderScopeBadge,
} from './pool-badges'
import { PoolFormDialog } from './pool-form-dialog'
import {
  formatTtlLabel,
  POOL_ROLE_LABELS,
  poolSummaryMetrics,
  PRESET_PLAN_TAGS,
  PROVIDER_SCOPE_LABELS,
  SYSTEM_PROMPT_MODE_LABELS,
} from './pool-rules'
import { SCHEDULER_POOLS_KEY, schedulerPoolsQueryOptions } from './queries'

const PROVIDER_TABS: Array<{ value: 'all' | ProviderScope; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'anthropic', label: PROVIDER_SCOPE_LABELS.anthropic },
  { value: 'openai', label: PROVIDER_SCOPE_LABELS.openai },
  { value: 'google', label: PROVIDER_SCOPE_LABELS.google },
  { value: 'api', label: PROVIDER_SCOPE_LABELS.api },
  { value: 'mixed', label: PROVIDER_SCOPE_LABELS.mixed },
]

function fmtRatePct(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return '—'
  const val = rate <= 1 && rate > 0 ? rate * 100 : rate
  return `${val.toFixed(0)}%`
}

export function PoolsListPage() {
  const qc = useQueryClient()
  const poolsQ = useQuery(schedulerPoolsQueryOptions(10000))
  const pools = useMemo(() => poolsQ.data || [], [poolsQ.data])

  const [providerFilter, setProviderFilter] = useState<'all' | ProviderScope>(
    'all'
  )
  const [planFilter, setPlanFilter] = useState<string>('all')
  const [roleFilter, setRoleFilter] = useState<'all' | PoolRole>('all')
  const [promptFilter, setPromptFilter] = useState<'all' | SystemPromptMode>(
    'all'
  )
  const [queryText, setQueryText] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<SchedulerPool | null>(null)
  const [deleting, setDeleting] = useState<SchedulerPool | null>(null)

  const refresh = () => qc.invalidateQueries({ queryKey: SCHEDULER_POOLS_KEY })

  const createMut = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      createSchedulerPool(payload),
    onSuccess: async (created) => {
      toast.success(`已创建分组池「${created.name}」`)
      setCreateOpen(false)
      await refresh()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const editMut = useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string
      payload: Record<string, unknown>
    }) => updateSchedulerPool(id, payload),
    onSuccess: async (updated) => {
      toast.success(`已更新分组池「${updated.name}」`)
      setEditing(null)
      await refresh()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const toggleMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      updateSchedulerPool(id, { enabled }),
    onSuccess: async (updated) => {
      toast.success(
        updated.enabled
          ? `已启用「${updated.name}」`
          : `已停用「${updated.name}」`
      )
      await refresh()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteSchedulerPool(id),
    onSuccess: async () => {
      toast.success(`已删除分组池「${deleting?.name || ''}」`)
      setDeleting(null)
      await refresh()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const availablePlanTags = useMemo(() => {
    const set = new Set<string>(PRESET_PLAN_TAGS)
    for (const p of pools) {
      for (const tag of p.plan_tags || []) set.add(tag)
    }
    return [...set]
  }, [pools])

  const filtered = useMemo(() => {
    const needle = queryText.trim().toLowerCase()
    return pools
      .filter((p) => {
        if (providerFilter !== 'all' && p.provider_scope !== providerFilter)
          return false
        if (planFilter !== 'all' && !(p.plan_tags || []).includes(planFilter))
          return false
        if (roleFilter !== 'all' && p.pool_role !== roleFilter) return false
        if (promptFilter !== 'all' && p.system_prompt_mode !== promptFilter)
          return false
        if (!needle) return true
        const hay = [
          p.name,
          p.slug,
          p.id,
          p.description,
          ...(p.plan_tags || []),
        ]
          .join(' ')
          .toLowerCase()
        return hay.includes(needle)
      })
      .sort(
        (a, b) =>
          (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
          a.name.localeCompare(b.name)
      )
  }, [pools, providerFilter, planFilter, roleFilter, promptFilter, queryText])

  const overview = useMemo(() => {
    let enabledPools = 0
    let healthyMembers = 0
    let totalMembers = 0
    let inflight = 0
    let maxConcurrency = 0
    let boundKeys = 0
    for (const p of pools) {
      if (p.enabled) enabledPools += 1
      const m = poolSummaryMetrics(p)
      healthyMembers += m.healthyMembers
      totalMembers += m.totalMembers
      inflight += m.inflight
      maxConcurrency += m.maxConcurrency
      boundKeys += m.boundKeysCount
    }
    return {
      totalPools: pools.length,
      enabledPools,
      healthyMembers,
      totalMembers,
      inflight,
      maxConcurrency,
      boundKeys,
    }
  }, [pools])

  const deleteMetrics = deleting ? poolSummaryMetrics(deleting) : null
  const hasActiveKeysOnDelete =
    (deleteMetrics?.activeBoundKeysCount ?? 0) > 0 ||
    (deleteMetrics?.boundKeysCount ?? 0) > 0

  return (
    <PageHeader
      title={VIEW_TITLES.pools}
      description='全 Provider 分组池与调度中心工作台：按套餐/角色编排节点权重等级、双级粘性与 Anthropic 池级 System Prompt 隔离。'
      fluid
      extra={
        <div className='flex flex-wrap items-center gap-2'>
          <Button
            variant='outline'
            size='sm'
            onClick={() => void refresh()}
            disabled={poolsQ.isFetching}
          >
            <RefreshCw
              className={cn('size-3.5', poolsQ.isFetching && 'animate-spin')}
            />
            刷新
          </Button>
          <Button size='sm' onClick={() => setCreateOpen(true)}>
            <Plus className='size-4' />
            新建分组池
          </Button>
        </div>
      }
    >
      <QueryGate
        loading={poolsQ.isLoading}
        error={poolsQ.error}
        skeleton={<TableSkeleton rows={6} columns={5} />}
      >
        {/* 概览 KPI 条 */}
        <section
          aria-label='分组池总览'
          className='mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4'
        >
          <div className='rounded-xl border bg-card px-4 py-3'>
            <div className='text-xs text-muted-foreground'>
              分组池（启用 / 总计）
            </div>
            <div className='mt-1 font-mono text-xl font-semibold tabular-nums'>
              {overview.enabledPools}
              <span className='text-sm font-normal text-muted-foreground'>
                {' '}
                / {overview.totalPools}
              </span>
            </div>
          </div>
          <div className='rounded-xl border bg-card px-4 py-3'>
            <div className='text-xs text-muted-foreground'>健康成员节点</div>
            <div className='mt-1 font-mono text-xl font-semibold tabular-nums'>
              <span className='text-[color:var(--status-ok)]'>
                {overview.healthyMembers}
              </span>
              <span className='text-sm font-normal text-muted-foreground'>
                {' '}
                / {overview.totalMembers}
              </span>
            </div>
          </div>
          <div className='rounded-xl border bg-card px-4 py-3'>
            <div className='text-xs text-muted-foreground'>
              当前在途并发水位
            </div>
            <div className='mt-1 font-mono text-xl font-semibold tabular-nums'>
              {overview.inflight}
              <span className='text-sm font-normal text-muted-foreground'>
                {' '}
                / {overview.maxConcurrency || '—'}
              </span>
            </div>
          </div>
          <div className='rounded-xl border bg-card px-4 py-3'>
            <div className='text-xs text-muted-foreground'>已绑定 API 密钥</div>
            <div className='mt-1 font-mono text-xl font-semibold tabular-nums'>
              {overview.boundKeys}
            </div>
          </div>
        </section>

        {/* 多维筛选条 */}
        <section
          aria-label='分组池筛选'
          className='mb-4 flex flex-col gap-3 rounded-xl border bg-card/60 p-3'
        >
          <div className='flex flex-wrap items-center gap-1.5'>
            {PROVIDER_TABS.map((tab) => {
              const count =
                tab.value === 'all'
                  ? pools.length
                  : pools.filter((p) => p.provider_scope === tab.value).length
              const active = providerFilter === tab.value
              return (
                <button
                  key={tab.value}
                  type='button'
                  aria-pressed={active}
                  onClick={() => setProviderFilter(tab.value)}
                  className={cn(
                    'inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors',
                    active
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground'
                  )}
                >
                  <span>{tab.label}</span>
                  <span className='font-mono text-[11px] tabular-nums opacity-80'>
                    {count}
                  </span>
                </button>
              )
            })}
          </div>

          <div className='flex flex-wrap items-center gap-2'>
            <div className='relative min-w-[200px] flex-1 sm:max-w-xs'>
              <Search
                className='pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground'
                aria-hidden
              />
              <Input
                value={queryText}
                onChange={(e) => setQueryText(e.target.value)}
                placeholder='搜索名称 / Slug / 套餐标签…'
                className='h-8 pl-8 text-xs'
              />
            </div>

            <Select value={planFilter} onValueChange={setPlanFilter}>
              <SelectTrigger className='h-8 w-36 text-xs' aria-label='套餐标签'>
                <SelectValue placeholder='套餐标签' />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='all'>全部套餐标签</SelectItem>
                {availablePlanTags.map((tag) => (
                  <SelectItem key={tag} value={tag}>
                    {tag}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={roleFilter}
              onValueChange={(v) => setRoleFilter(v as 'all' | PoolRole)}
            >
              <SelectTrigger className='h-8 w-36 text-xs' aria-label='池角色'>
                <SelectValue placeholder='池角色' />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='all'>全部角色</SelectItem>
                {(
                  [
                    'primary',
                    'standard',
                    'overflow',
                    'downgrade',
                    'dedicated',
                  ] as const
                ).map((role) => (
                  <SelectItem key={role} value={role}>
                    {POOL_ROLE_LABELS[role]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={promptFilter}
              onValueChange={(v) =>
                setPromptFilter(v as 'all' | SystemPromptMode)
              }
            >
              <SelectTrigger
                className='h-8 w-40 text-xs'
                aria-label='System Prompt 模式'
              >
                <SelectValue placeholder='Prompt 模式' />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='all'>全部 Prompt 模式</SelectItem>
                {(
                  [
                    'official',
                    'zero_inject',
                    'override',
                    'append',
                    'passthrough',
                    'inherit_global',
                  ] as const
                ).map((m) => (
                  <SelectItem key={m} value={m}>
                    {SYSTEM_PROMPT_MODE_LABELS[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {providerFilter !== 'all' ||
            planFilter !== 'all' ||
            roleFilter !== 'all' ||
            promptFilter !== 'all' ||
            queryText ? (
              <Button
                variant='ghost'
                size='sm'
                className='h-8 text-xs'
                onClick={() => {
                  setProviderFilter('all')
                  setPlanFilter('all')
                  setRoleFilter('all')
                  setPromptFilter('all')
                  setQueryText('')
                }}
              >
                重置筛选
              </Button>
            ) : null}
          </div>
        </section>

        {/* 分组池卡片网格 */}
        {filtered.length === 0 ? (
          <EmptyState
            reason={
              pools.length === 0
                ? '尚无分组池。创建一个分组池即可编排多平台节点、权重等级、双级粘性与 Anthropic System Prompt 隔离。'
                : '没有符合当前筛选条件的分组池。'
            }
            actionLabel={pools.length === 0 ? '新建分组池' : undefined}
            onAction={
              pools.length === 0 ? () => setCreateOpen(true) : undefined
            }
          />
        ) : (
          <div className='grid gap-4 md:grid-cols-2 xl:grid-cols-3'>
            {filtered.map((pool) => {
              const metrics = poolSummaryMetrics(pool)
              return (
                <Card
                  key={pool.id}
                  className={cn(
                    'flex flex-col gap-4 py-4 transition-colors hover:border-primary/40',
                    !pool.enabled && 'opacity-75'
                  )}
                >
                  <CardHeader className='gap-2 px-4 pb-0'>
                    <div className='flex items-start justify-between gap-2'>
                      <div className='min-w-0 flex-1'>
                        <CardTitle className='flex items-center gap-1.5 text-base'>
                          <Link
                            to='/pools/$poolId'
                            params={{ poolId: pool.id }}
                            className='truncate hover:text-primary hover:underline'
                          >
                            {pool.name}
                          </Link>
                          {pool.exclusive_members ? (
                            <span title='成员独占池'>
                              <Lock
                                className='size-3.5 shrink-0 text-muted-foreground'
                                aria-label='成员独占池'
                              />
                            </span>
                          ) : null}
                        </CardTitle>
                        <CardDescription className='mt-0.5 truncate font-mono text-[11px]'>
                          {pool.slug} · {pool.id}
                        </CardDescription>
                      </div>
                      <Switch
                        checked={pool.enabled}
                        aria-label={`启停分组池 ${pool.name}`}
                        disabled={toggleMut.isPending}
                        onCheckedChange={(enabled) =>
                          toggleMut.mutate({ id: pool.id, enabled })
                        }
                      />
                    </div>
                    <div className='flex flex-wrap items-center gap-1.5 pt-0.5'>
                      <ProviderScopeBadge scope={pool.provider_scope} />
                      <PoolRoleBadge role={pool.pool_role} />
                      <PromptModeBadge
                        providerScope={pool.provider_scope}
                        mode={pool.system_prompt_mode}
                      />
                    </div>
                    {(pool.plan_tags || []).length > 0 ? (
                      <div className='flex flex-wrap gap-1'>
                        {pool.plan_tags.map((tag) => (
                          <span
                            key={tag}
                            className='rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground'
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {pool.description ? (
                      <p className='line-clamp-2 text-xs text-muted-foreground'>
                        {pool.description}
                      </p>
                    ) : null}
                  </CardHeader>

                  <CardContent className='space-y-3 px-4'>
                    {/* 并发水位条 */}
                    <div className='space-y-1'>
                      <div className='flex items-center justify-between text-xs'>
                        <span className='inline-flex items-center gap-1 text-muted-foreground'>
                          <Activity className='size-3.5' aria-hidden />
                          并发水位
                        </span>
                        <span className='font-mono tabular-nums'>
                          <b>{metrics.inflight}</b> /{' '}
                          {metrics.maxConcurrency || '—'}
                          {metrics.maxConcurrency > 0
                            ? ` (${metrics.concurrencyPct}%)`
                            : ''}
                        </span>
                      </div>
                      <Progress
                        value={metrics.concurrencyPct}
                        className='h-1.5'
                      />
                    </div>

                    {/* 成员健康 / 粘性命中 / 溢出 / Key 绑定 */}
                    <div className='grid grid-cols-2 gap-2 rounded-lg border bg-muted/25 p-2.5 text-xs'>
                      <div>
                        <div className='text-[11px] text-muted-foreground'>
                          健康成员
                        </div>
                        <div className='mt-0.5 flex items-center gap-1 font-mono font-semibold tabular-nums'>
                          <Server
                            className='size-3 text-muted-foreground'
                            aria-hidden
                          />
                          <span
                            className={cn(
                              metrics.healthyMembers === 0
                                ? 'text-[color:var(--status-bad)]'
                                : 'text-[color:var(--status-ok)]'
                            )}
                          >
                            {metrics.healthyMembers}
                          </span>
                          <span className='font-normal text-muted-foreground'>
                            /{metrics.totalMembers}
                          </span>
                        </div>
                      </div>
                      <div>
                        <div className='text-[11px] text-muted-foreground'>
                          绑定密钥
                        </div>
                        <div className='mt-0.5 flex items-center gap-1 font-mono font-semibold tabular-nums'>
                          <KeyRound
                            className='size-3 text-muted-foreground'
                            aria-hidden
                          />
                          <span>{metrics.boundKeysCount}</span>
                          {metrics.activeBoundKeysCount > 0 ? (
                            <span className='font-sans text-[10px] font-normal text-muted-foreground'>
                              ({metrics.activeBoundKeysCount} 活跃)
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <div>
                        <div className='text-[11px] text-muted-foreground'>
                          粘性命中（设备/会话）
                        </div>
                        <div className='mt-0.5 font-mono text-[11px] tabular-nums'>
                          {fmtRatePct(metrics.machineHitRate)} /{' '}
                          {fmtRatePct(metrics.sessionHitRate)}
                        </div>
                      </div>
                      <div>
                        <div className='text-[11px] text-muted-foreground'>
                          溢出率 · 策略
                        </div>
                        <div className='mt-0.5 truncate font-mono text-[11px] tabular-nums'>
                          {fmtRatePct(metrics.spillRate)} ·{' '}
                          {pool.session_overflow_policy === 'spill_immediately'
                            ? '满了就换'
                            : pool.session_overflow_policy === 'wait_then_spill'
                              ? '短等后切'
                              : '严格守槽'}
                        </div>
                      </div>
                    </div>

                    <div className='flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground'>
                      <span>
                        设备粘性：
                        {pool.machine_sticky_enabled
                          ? formatTtlLabel(pool.machine_ttl_seconds)
                          : '关'}
                      </span>
                      <span>
                        会话粘性：
                        {pool.session_sticky_enabled
                          ? formatTtlLabel(pool.session_ttl_seconds)
                          : '关'}
                      </span>
                      <span>队列上限 {pool.session_queue_max}</span>
                    </div>
                  </CardContent>

                  <CardFooter className='mt-auto flex items-center justify-between gap-2 border-t px-4 pt-3'>
                    <div className='flex items-center gap-1'>
                      <Button
                        size='sm'
                        variant='ghost'
                        className='h-7 px-2 text-xs'
                        onClick={() => setEditing(pool)}
                      >
                        <Pencil className='size-3.5' />
                        编辑
                      </Button>
                      <Button
                        size='sm'
                        variant='ghost'
                        className='h-7 px-2 text-xs text-destructive hover:text-destructive'
                        onClick={() => setDeleting(pool)}
                      >
                        <Trash2 className='size-3.5' />
                        删除
                      </Button>
                    </div>
                    <Button
                      asChild
                      size='sm'
                      variant='outline'
                      className='h-7 text-xs'
                    >
                      <Link to='/pools/$poolId' params={{ poolId: pool.id }}>
                        进入详情
                        <ArrowRight className='size-3.5' />
                      </Link>
                    </Button>
                  </CardFooter>
                </Card>
              )
            })}
          </div>
        )}
      </QueryGate>

      <PoolFormDialog
        mode='create'
        open={createOpen}
        onOpenChange={setCreateOpen}
        pending={createMut.isPending}
        onSubmit={(payload) => createMut.mutate(payload)}
      />

      <PoolFormDialog
        mode='edit'
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
        initial={editing}
        pending={editMut.isPending}
        onSubmit={(payload) => {
          if (editing) editMut.mutate({ id: editing.id, payload })
        }}
      />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
        title={`删除分组池 · ${deleting?.name || ''}`}
        desc={
          <div className='space-y-3'>
            <p>
              删除后该分组池的成员编排、池级 System Prompt
              与双级粘性配置将立即移除，此操作不可撤销。
            </p>
            {hasActiveKeysOnDelete ? (
              <Alert variant='destructive'>
                <AlertTriangle className='size-4' />
                <AlertTitle>
                  存在 {deleteMetrics?.boundKeysCount || 0} 个绑定 API
                  密钥（其中 {deleteMetrics?.activeBoundKeysCount || 0} 个活跃）
                </AlertTitle>
                <AlertDescription>
                  后端 Fail-Closed
                  保护默认拒绝删除仍有活跃密钥绑定的分组池。请先在详情页「绑定
                  API
                  密钥」标签解绑或改绑到其他分组池，否则删除会被拒绝且受影响密钥将立即返回
                  403。
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
        }
        confirmText={hasActiveKeysOnDelete ? '仍尝试删除' : '确认删除'}
        cancelBtnText='取消'
        destructive
        isLoading={deleteMut.isPending}
        handleConfirm={() => {
          if (deleting) deleteMut.mutate(deleting.id)
        }}
      />
    </PageHeader>
  )
}
