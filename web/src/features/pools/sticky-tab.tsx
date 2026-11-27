import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  IntraTierStrategy,
  SchedulerPool,
  SessionOverflowPolicy,
} from '@/types/panel-pools'
import {
  AlertTriangle,
  Lock,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  deleteSchedulerSticky,
  resetPoolMachineSticky,
  updateSchedulerPool,
} from './api'
import {
  INTRA_TIER_STRATEGY_LABELS,
  isPromptLockedProvider,
  MACHINE_TTL_MAX_SECONDS,
  MACHINE_TTL_MIN_SECONDS,
  POOL_LOCKED_DEFAULTS,
  POOL_QUEUE_MAX_LIMIT,
  POOL_QUEUE_MAX_MIN,
  POOL_QUEUE_WAIT_MAX_MS,
  POOL_QUEUE_WAIT_MIN_MS,
  SESSION_BUSY_WAIT_MAX_MS,
  SESSION_QUEUE_MAX_LIMIT,
  SESSION_QUEUE_MAX_MIN,
  SESSION_QUEUE_TIMEOUT_MAX_MS,
  SESSION_QUEUE_TIMEOUT_MIN_MS,
  SESSION_TTL_MAX_SECONDS,
  SESSION_TTL_MIN_SECONDS,
  validateFallbackPool,
} from './pool-rules'
import { SCHEDULER_POOLS_KEY, schedulerStickyQueryOptions } from './queries'
import { TtlDurationInput } from './ttl-input'

const OVERFLOW_OPTIONS: Array<{
  value: SessionOverflowPolicy
  title: string
  badge?: string
  desc: string
}> = [
  {
    value: 'spill_immediately',
    title: '满了就换（spill_immediately）',
    badge: 'v4 锁定默认',
    desc: '老 session 轮到执行但绑定 VM 被其他会话占满时，零等待零冷却立即切至同池次优高权 VM（不改写原 machine_id 主绑定）。',
  },
  {
    value: 'wait_then_spill',
    title: '短等后切（wait_then_spill）',
    desc: '先等待绑定 VM 释槽（上限 session_busy_wait_ms），超时再零冷却溢出到次优节点。',
  },
  {
    value: 'strict',
    title: '严格守槽（strict）',
    desc: '绝不溢出到其他节点，等待超时直接返回忙错误。仅建议对上下文强绑定单机的特殊池开启。',
  },
]

export function PoolStickyTab({
  pool,
  allPools,
}: {
  pool: SchedulerPool
  allPools: SchedulerPool[]
}) {
  const qc = useQueryClient()
  const [machineEnabled, setMachineEnabled] = useState(
    pool.machine_sticky_enabled
  )
  const [machineTtl, setMachineTtl] = useState(pool.machine_ttl_seconds)
  const [sessionEnabled, setSessionEnabled] = useState(
    pool.session_sticky_enabled
  )
  const [sessionTtl, setSessionTtl] = useState(pool.session_ttl_seconds)
  const [overflowPolicy, setOverflowPolicy] = useState<SessionOverflowPolicy>(
    pool.session_overflow_policy
  )
  const [busyWaitMs, setBusyWaitMs] = useState(pool.session_busy_wait_ms)
  const [sessionQueueMax, setSessionQueueMax] = useState(pool.session_queue_max)
  const [sessionQueueTimeoutMs, setSessionQueueTimeoutMs] = useState(
    pool.session_queue_timeout_ms
  )
  const [queueWaitMs, setQueueWaitMs] = useState(pool.queue_wait_ms)
  const [queueMax, setQueueMax] = useState(pool.queue_max)
  const [strategy, setStrategy] = useState<IntraTierStrategy>(
    pool.intra_tier_strategy
  )
  const [fallbackPoolId, setFallbackPoolId] = useState<string>(
    pool.fallback_pool_id || ''
  )
  const [allowCrossPrompt, setAllowCrossPrompt] = useState(
    pool.allow_cross_prompt_fallback
  )
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
  const [stickyKindFilter, setStickyKindFilter] = useState<
    'all' | 'machine' | 'session'
  >('all')

  useEffect(() => {
    setMachineEnabled(pool.machine_sticky_enabled)
    setMachineTtl(pool.machine_ttl_seconds)
    setSessionEnabled(pool.session_sticky_enabled)
    setSessionTtl(pool.session_ttl_seconds)
    setOverflowPolicy(pool.session_overflow_policy)
    setBusyWaitMs(pool.session_busy_wait_ms)
    setSessionQueueMax(pool.session_queue_max)
    setSessionQueueTimeoutMs(pool.session_queue_timeout_ms)
    setQueueWaitMs(pool.queue_wait_ms)
    setQueueMax(pool.queue_max)
    setStrategy(pool.intra_tier_strategy)
    setFallbackPoolId(pool.fallback_pool_id || '')
    setAllowCrossPrompt(pool.allow_cross_prompt_fallback)
  }, [pool])

  const stickyQ = useQuery({
    ...schedulerStickyQueryOptions({
      pool_id: pool.id,
      ...(stickyKindFilter !== 'all' ? { scope_kind: stickyKindFilter } : {}),
    }),
    retry: false,
  })

  const fallbackCheck = useMemo(
    () =>
      validateFallbackPool({
        sourcePool: {
          ...pool,
          allow_cross_prompt_fallback: allowCrossPrompt,
        },
        nextFallbackPoolId: fallbackPoolId || null,
        allPools,
      }),
    [pool, allowCrossPrompt, fallbackPoolId, allPools]
  )

  const saveMut = useMutation({
    mutationFn: () =>
      updateSchedulerPool(pool.id, {
        machine_sticky_enabled: machineEnabled,
        machine_ttl_seconds: machineTtl,
        session_sticky_enabled: sessionEnabled,
        session_ttl_seconds: sessionTtl,
        session_overflow_policy: overflowPolicy,
        session_busy_wait_ms:
          overflowPolicy === 'spill_immediately' ? 0 : busyWaitMs,
        session_queue_max: sessionQueueMax,
        session_queue_timeout_ms: sessionQueueTimeoutMs,
        queue_wait_ms: queueWaitMs,
        queue_max: queueMax,
        intra_tier_strategy: strategy,
        fallback_pool_id: fallbackPoolId || null,
        allow_cross_prompt_fallback: isPromptLockedProvider(pool.provider_scope)
          ? false
          : allowCrossPrompt,
      }),
    onSuccess: async () => {
      toast.success('粘性、队列与溢出策略已保存')
      await Promise.all([
        qc.invalidateQueries({ queryKey: SCHEDULER_POOLS_KEY }),
        qc.invalidateQueries({
          queryKey: ['panel', 'scheduler-pools', pool.id],
        }),
      ])
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const resetMachineMut = useMutation({
    mutationFn: () => resetPoolMachineSticky(pool.id),
    onSuccess: async (res) => {
      const n = res.cleared ?? res.count
      toast.success(
        n != null
          ? `已重置本池 ${n} 条设备粘性绑定`
          : '已重置本池全部设备粘性绑定'
      )
      setResetConfirmOpen(false)
      await qc.invalidateQueries({ queryKey: ['panel', 'scheduler-sticky'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const unbindMut = useMutation({
    mutationFn: (item: {
      scope_kind: 'machine' | 'session'
      model_family: string
      identity_id: string
    }) =>
      deleteSchedulerSticky({
        pool_id: pool.id,
        scope_kind: item.scope_kind,
        model_family: item.model_family,
        identity_id: item.identity_id,
      }),
    onSuccess: async () => {
      toast.success('已解绑粘性记录')
      await qc.invalidateQueries({ queryKey: ['panel', 'scheduler-sticky'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const dirty =
    machineEnabled !== pool.machine_sticky_enabled ||
    machineTtl !== pool.machine_ttl_seconds ||
    sessionEnabled !== pool.session_sticky_enabled ||
    sessionTtl !== pool.session_ttl_seconds ||
    overflowPolicy !== pool.session_overflow_policy ||
    (overflowPolicy === 'spill_immediately' ? 0 : busyWaitMs) !==
      pool.session_busy_wait_ms ||
    sessionQueueMax !== pool.session_queue_max ||
    sessionQueueTimeoutMs !== pool.session_queue_timeout_ms ||
    queueWaitMs !== pool.queue_wait_ms ||
    queueMax !== pool.queue_max ||
    strategy !== pool.intra_tier_strategy ||
    (fallbackPoolId || null) !== (pool.fallback_pool_id || null) ||
    allowCrossPrompt !== pool.allow_cross_prompt_fallback

  return (
    <div className='space-y-5'>
      {/* 双级粘性配置 */}
      <section className='grid gap-4 lg:grid-cols-2'>
        <div className='space-y-3 rounded-xl border bg-card p-4'>
          <div className='flex items-start justify-between gap-3'>
            <div>
              <Label htmlFor='pool-machine-sticky' className='text-sm'>
                L2 设备粘性（machine_id）
              </Label>
              <p className='mt-0.5 text-xs text-muted-foreground'>
                池内粘性权重
                1：同机器新会话优先落主节点，主节点占满零惩罚立即溢出次优节点且保留原主绑定。
              </p>
            </div>
            <Switch
              id='pool-machine-sticky'
              checked={machineEnabled}
              onCheckedChange={setMachineEnabled}
            />
          </div>
          <div className='space-y-1.5'>
            <Label className='text-xs text-muted-foreground'>
              设备粘性 TTL（默认 7 天，范围 1 分钟 ~ 30 天）
            </Label>
            <TtlDurationInput
              seconds={machineTtl}
              minSeconds={MACHINE_TTL_MIN_SECONDS}
              maxSeconds={MACHINE_TTL_MAX_SECONDS}
              preferredUnit='days'
              presets={[86400, 259200, 604800, 1209600, 2592000]}
              disabled={!machineEnabled}
              onChange={setMachineTtl}
            />
          </div>
          <div className='border-t pt-3'>
            <Button
              type='button'
              size='sm'
              variant='outline'
              onClick={() => setResetConfirmOpen(true)}
            >
              <RotateCcw className='size-3.5' />
              重置本池设备粘性
            </Button>
          </div>
        </div>

        <div className='space-y-3 rounded-xl border bg-card p-4'>
          <div className='flex items-start justify-between gap-3'>
            <div>
              <Label htmlFor='pool-session-sticky' className='text-sm'>
                L1 会话粘性（session_id）
              </Label>
              <p className='mt-0.5 text-xs text-muted-foreground'>
                严格遵循 Claude Code 官方纯标准 UUIDv4
                协议（零附加头与前缀），1:1 绑定单节点保持上下文连续。
              </p>
            </div>
            <Switch
              id='pool-session-sticky'
              checked={sessionEnabled}
              onCheckedChange={setSessionEnabled}
            />
          </div>
          <div className='space-y-1.5'>
            <Label className='text-xs text-muted-foreground'>
              会话粘性 TTL（默认 24 小时，范围 1 分钟 ~ 7 天）
            </Label>
            <TtlDurationInput
              seconds={sessionTtl}
              minSeconds={SESSION_TTL_MIN_SECONDS}
              maxSeconds={SESSION_TTL_MAX_SECONDS}
              preferredUnit='hours'
              presets={[3600, 21600, 86400, 259200, 604800]}
              disabled={!sessionEnabled}
              onChange={setSessionTtl}
            />
          </div>
        </div>
      </section>

      {/* 场景 C 单机满载溢出策略（D2） */}
      <section className='space-y-3 rounded-xl border bg-card p-4'>
        <div>
          <h3 className='text-sm font-semibold'>
            场景 C：已有会话遇绑定节点被他会话占满时的溢出策略
          </h3>
          <p className='text-xs text-muted-foreground'>
            同机新会话（场景
            B）固定零排队立即溢出。此处控制老会话轮到执行但原绑定节点满载时的行为。
          </p>
        </div>
        <div
          role='radiogroup'
          aria-label='场景 C 溢出策略'
          className='grid gap-3 md:grid-cols-3'
        >
          {OVERFLOW_OPTIONS.map((opt) => {
            const active = overflowPolicy === opt.value
            return (
              <button
                key={opt.value}
                type='button'
                role='radio'
                aria-checked={active}
                onClick={() => {
                  setOverflowPolicy(opt.value)
                  if (opt.value === 'spill_immediately') setBusyWaitMs(0)
                  else if (busyWaitMs === 0) setBusyWaitMs(3000)
                }}
                className={cn(
                  'flex cursor-pointer flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors',
                  active
                    ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                    : 'border-border bg-background hover:border-primary/40'
                )}
              >
                <div className='flex items-center justify-between gap-2'>
                  <span className='text-xs font-semibold'>{opt.title}</span>
                  {opt.badge ? (
                    <Badge variant='secondary' className='text-[10px]'>
                      {opt.badge}
                    </Badge>
                  ) : null}
                </div>
                <p className='text-[11px] leading-4 text-muted-foreground'>
                  {opt.desc}
                </p>
              </button>
            )
          })}
        </div>
        <div className='flex flex-wrap items-center gap-3 pt-1'>
          <Label htmlFor='pool-busy-wait-ms' className='text-xs'>
            单机占满等待上限 session_busy_wait_ms（默认{' '}
            {POOL_LOCKED_DEFAULTS.session_busy_wait_ms}ms）
          </Label>
          <Input
            id='pool-busy-wait-ms'
            type='number'
            min={0}
            max={SESSION_BUSY_WAIT_MAX_MS}
            step={500}
            disabled={overflowPolicy === 'spill_immediately'}
            value={overflowPolicy === 'spill_immediately' ? 0 : busyWaitMs}
            onChange={(e) =>
              setBusyWaitMs(
                Math.min(
                  SESSION_BUSY_WAIT_MAX_MS,
                  Math.max(0, Number(e.target.value) || 0)
                )
              )
            }
            className='h-8 w-28 font-mono text-xs tabular-nums'
          />
          <span className='text-xs text-muted-foreground'>
            {overflowPolicy === 'spill_immediately'
              ? '满了就换模式强制为 0ms（零干等）'
              : 'ms（0 ~ 30000）'}
          </span>
        </div>
      </section>

      {/* SessionGate 单会话 FIFO 队列（无关闭开关！） */}
      <section className='space-y-3 rounded-xl border bg-card p-4'>
        <div className='flex flex-wrap items-start justify-between gap-2'>
          <div>
            <h3 className='text-sm font-semibold'>
              SessionGate 单会话 FIFO 串行队列
            </h3>
            <p className='text-xs text-muted-foreground'>
              同一 session_id 并发到达时（场景 A）在选节点前进入专属 FIFO
              门闩串行排队。
            </p>
          </div>
          <Badge variant='outline' className='gap-1 text-xs'>
            <Lock className='size-3' />
            强制串行 · 并发上限恒为 1
          </Badge>
        </div>
        <Alert>
          <Lock className='size-4' />
          <AlertTitle>
            同一 session_id 由 Rust 内核 SessionGate 强制 FIFO 串行，严禁真并发
          </AlertTitle>
          <AlertDescription>
            系统不提供关闭单会话串行的开关，以彻底杜绝同会话在同机或跨机产生并发冲突、409
            与工具调用乱序。超队列上限返 429{' '}
            <code className='font-mono'>session_queue_full</code>，超时返 429{' '}
            <code className='font-mono'>session_queue_timeout</code>。
          </AlertDescription>
        </Alert>
        <div className='grid gap-4 sm:grid-cols-2'>
          <div className='space-y-1.5'>
            <Label htmlFor='pool-session-queue-max' className='text-xs'>
              单会话最大 FIFO 排队深度 session_queue_max（1–128，默认 16）
            </Label>
            <Input
              id='pool-session-queue-max'
              type='number'
              min={SESSION_QUEUE_MAX_MIN}
              max={SESSION_QUEUE_MAX_LIMIT}
              value={sessionQueueMax}
              onChange={(e) =>
                setSessionQueueMax(
                  Math.min(
                    SESSION_QUEUE_MAX_LIMIT,
                    Math.max(SESSION_QUEUE_MAX_MIN, Number(e.target.value) || 1)
                  )
                )
              }
              className='h-8 font-mono text-xs tabular-nums'
            />
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='pool-session-queue-timeout' className='text-xs'>
              单会话最长等待超时 session_queue_timeout_ms（1000–300000，默认
              60000ms）
            </Label>
            <Input
              id='pool-session-queue-timeout'
              type='number'
              min={SESSION_QUEUE_TIMEOUT_MIN_MS}
              max={SESSION_QUEUE_TIMEOUT_MAX_MS}
              step={1000}
              value={sessionQueueTimeoutMs}
              onChange={(e) =>
                setSessionQueueTimeoutMs(
                  Math.min(
                    SESSION_QUEUE_TIMEOUT_MAX_MS,
                    Math.max(
                      SESSION_QUEUE_TIMEOUT_MIN_MS,
                      Number(e.target.value) || 60000
                    )
                  )
                )
              }
              className='h-8 font-mono text-xs tabular-nums'
            />
          </div>
        </div>
      </section>

      {/* 全池满载排队、同层均衡与 Fallback 链 */}
      <section className='space-y-4 rounded-xl border bg-card p-4'>
        <h3 className='text-sm font-semibold'>
          全池满载排队、同层均衡与 Fallback
        </h3>
        <div className='grid gap-4 sm:grid-cols-3'>
          <div className='space-y-1.5'>
            <Label htmlFor='pool-intra-strategy' className='text-xs'>
              同权重等级内均衡策略
            </Label>
            <Select
              value={strategy}
              onValueChange={(v) => setStrategy(v as IntraTierStrategy)}
            >
              <SelectTrigger id='pool-intra-strategy' className='h-8 text-xs'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(
                  [
                    'least_inflight_swrr',
                    'balanced',
                    'fill',
                    'ordered',
                  ] as const
                ).map((s) => (
                  <SelectItem key={s} value={s}>
                    {INTRA_TIER_STRATEGY_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='pool-queue-wait' className='text-xs'>
              全池满载抢槽等待 queue_wait_ms（0–60000，默认 15000）
            </Label>
            <Input
              id='pool-queue-wait'
              type='number'
              min={POOL_QUEUE_WAIT_MIN_MS}
              max={POOL_QUEUE_WAIT_MAX_MS}
              step={1000}
              value={queueWaitMs}
              onChange={(e) =>
                setQueueWaitMs(
                  Math.min(
                    POOL_QUEUE_WAIT_MAX_MS,
                    Math.max(
                      POOL_QUEUE_WAIT_MIN_MS,
                      Number(e.target.value) || 0
                    )
                  )
                )
              }
              className='h-8 font-mono text-xs tabular-nums'
            />
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='pool-queue-max' className='text-xs'>
              全池最大满载排队数 queue_max（1–999，默认 50）
            </Label>
            <Input
              id='pool-queue-max'
              type='number'
              min={POOL_QUEUE_MAX_MIN}
              max={POOL_QUEUE_MAX_LIMIT}
              value={queueMax}
              onChange={(e) =>
                setQueueMax(
                  Math.min(
                    POOL_QUEUE_MAX_LIMIT,
                    Math.max(POOL_QUEUE_MAX_MIN, Number(e.target.value) || 50)
                  )
                )
              }
              className='h-8 font-mono text-xs tabular-nums'
            />
          </div>
        </div>

        <div className='space-y-2 border-t pt-3'>
          <div className='grid gap-3 sm:grid-cols-2'>
            <div className='space-y-1.5'>
              <Label htmlFor='pool-fallback-select' className='text-xs'>
                Fallback 降级目标池（最大链深 3，自动判环）
              </Label>
              <Select
                value={fallbackPoolId || '__none__'}
                onValueChange={(v) =>
                  setFallbackPoolId(v === '__none__' ? '' : v)
                }
              >
                <SelectTrigger
                  id='pool-fallback-select'
                  className='h-8 text-xs'
                >
                  <SelectValue placeholder='不配置 Fallback' />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='__none__'>不配置 Fallback</SelectItem>
                  {allPools
                    .filter((p) => p.id !== pool.id)
                    .map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name} ({p.provider_scope} · {p.system_prompt_mode})
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            {!isPromptLockedProvider(pool.provider_scope) ? (
              <div className='flex items-end pb-1'>
                <label className='flex cursor-pointer items-center gap-2 text-xs'>
                  <Checkbox
                    checked={allowCrossPrompt}
                    onCheckedChange={(v) => setAllowCrossPrompt(v === true)}
                  />
                  允许跨不同 System Prompt 模式 Fallback（默认禁止）
                </label>
              </div>
            ) : null}
          </div>
          {!fallbackCheck.ok && fallbackCheck.error ? (
            <Alert variant='destructive'>
              <AlertTriangle className='size-4' />
              <AlertTitle>Fallback 校验不通过</AlertTitle>
              <AlertDescription>{fallbackCheck.error}</AlertDescription>
            </Alert>
          ) : fallbackCheck.warning ? (
            <Alert className='border-amber-500/50 bg-amber-500/10'>
              <AlertTriangle className='size-4' />
              <AlertTitle>跨 Prompt 回落警示</AlertTitle>
              <AlertDescription>{fallbackCheck.warning}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <div className='flex items-center justify-end gap-2 border-t pt-3'>
          <Button
            type='button'
            size='sm'
            disabled={!dirty || !fallbackCheck.ok || saveMut.isPending}
            loading={saveMut.isPending}
            onClick={() => saveMut.mutate()}
          >
            <Save className='size-3.5' />
            保存策略更改
          </Button>
        </div>
      </section>

      {/* 当前池内粘性绑定运维检索与解绑 */}
      <section className='space-y-3 rounded-xl border bg-card p-4'>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <div>
            <h3 className='text-sm font-semibold'>本池活跃粘性绑定</h3>
            <p className='text-xs text-muted-foreground'>
              按池与模型家族隔离展示设备 / 会话绑定记录，支持单条人工解绑。
            </p>
          </div>
          <div className='flex items-center gap-2'>
            <Select
              value={stickyKindFilter}
              onValueChange={(v) =>
                setStickyKindFilter(v as 'all' | 'machine' | 'session')
              }
            >
              <SelectTrigger className='h-8 w-28 text-xs'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='all'>全部维度</SelectItem>
                <SelectItem value='machine'>仅设备粘性</SelectItem>
                <SelectItem value='session'>仅会话粘性</SelectItem>
              </SelectContent>
            </Select>
            <Button
              type='button'
              size='sm'
              variant='outline'
              onClick={() => void stickyQ.refetch()}
              disabled={stickyQ.isFetching}
            >
              <RefreshCw
                className={cn('size-3.5', stickyQ.isFetching && 'animate-spin')}
              />
              刷新
            </Button>
          </div>
        </div>
        {stickyQ.isError ? (
          <p className='text-xs text-muted-foreground'>
            暂无法读取粘性记录（{(stickyQ.error as Error).message}）。
          </p>
        ) : (stickyQ.data || []).length === 0 ? (
          <p className='py-4 text-center text-xs text-muted-foreground'>
            当前池无活跃粘性绑定记录
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>维度</TableHead>
                <TableHead>模型家族</TableHead>
                <TableHead>身份 ID</TableHead>
                <TableHead>目标节点</TableHead>
                <TableHead>命中</TableHead>
                <TableHead>到期</TableHead>
                <TableHead className='text-right'>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(stickyQ.data || []).slice(0, 50).map((item) => (
                <TableRow
                  key={`${item.scope_kind}:${item.model_family}:${item.identity_id}`}
                >
                  <TableCell>
                    <Badge variant='outline' className='text-[10px]'>
                      {item.scope_kind === 'machine' ? '设备 1w' : '会话 1:1'}
                    </Badge>
                  </TableCell>
                  <TableCell className='font-mono text-xs'>
                    {item.model_family}
                  </TableCell>
                  <TableCell className='max-w-[180px] truncate font-mono text-xs'>
                    {item.identity_id}
                  </TableCell>
                  <TableCell className='font-mono text-xs'>
                    {item.node_key || `${item.node_type}:${item.node_id}`}
                    {item.stood_in ? (
                      <Badge variant='secondary' className='ml-1.5 text-[10px]'>
                        替补
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className='font-mono text-xs tabular-nums'>
                    {item.hits ?? 0}
                  </TableCell>
                  <TableCell className='text-xs text-muted-foreground'>
                    {item.expires_at_ms
                      ? new Date(item.expires_at_ms).toLocaleString()
                      : '—'}
                  </TableCell>
                  <TableCell className='text-right'>
                    <Button
                      size='sm'
                      variant='ghost'
                      className='h-7 px-2 text-xs text-destructive hover:text-destructive'
                      disabled={unbindMut.isPending}
                      onClick={() =>
                        unbindMut.mutate({
                          scope_kind: item.scope_kind,
                          model_family: item.model_family,
                          identity_id: item.identity_id,
                        })
                      }
                    >
                      <Trash2 className='size-3.5' />
                      解绑
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <ConfirmDialog
        open={resetConfirmOpen}
        onOpenChange={setResetConfirmOpen}
        title={`重置「${pool.name}」的设备粘性`}
        desc='将清除本池内全部 1 周周期的 machine_id 主节点绑定，后续新会话将按权重等级重新分配并重定锚。不影响在途请求。'
        confirmText='确认重置'
        cancelBtnText='取消'
        destructive
        isLoading={resetMachineMut.isPending}
        handleConfirm={() => resetMachineMut.mutate()}
      />
    </div>
  )
}
