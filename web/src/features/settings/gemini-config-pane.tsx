import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  Cpu,
  Gauge,
  Layers,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Wrench,
} from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtDuration } from '@/lib/format'
import { GEMINI_MAINTENANCE_SECTION_ID } from '@/lib/gemini-recovery'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'
import {
  geminiDaemonStatusQueryOptions,
  type GeminiDaemonStatus,
} from './queries'
import {
  ChipGroup,
  PaneSection,
  SliderSetting,
  StepperSetting,
} from './scheduler-controls'

type Block = Record<string, unknown>
type Strategy = 'balanced' | 'fill' | 'round_robin'
type GeminiPerformanceTier = 'low' | 'medium' | 'high'

const GEMINI_PERFORMANCE_TIERS: readonly {
  id: GeminiPerformanceTier
  title: string
  desc: string
  shm: {
    require_shm: true
    request_mb: number
    response_mb: number
  }
}[] = [
  {
    id: 'low',
    title: '初',
    desc: '轻量内存占用，适合常规请求与内存偏紧的宿主机。',
    shm: { require_shm: true, request_mb: 2, response_mb: 8 },
  },
  {
    id: 'medium',
    title: '中',
    desc: '性能与内存均衡，适合绝大多数并发与流式场景。',
    shm: { require_shm: true, request_mb: 4, response_mb: 16 },
  },
  {
    id: 'high',
    title: '高',
    desc: '大吞吐缓冲，适合高并发、大上下文与长流式输出场景。',
    shm: { require_shm: true, request_mb: 16, response_mb: 64 },
  },
]

function resolveGeminiPerformanceTier(
  requestMb: number,
  responseMb: number
): GeminiPerformanceTier {
  const totalMb = requestMb + responseMb
  if (totalMb <= 14) return 'low'
  if (totalMb >= 40) return 'high'
  return 'medium'
}

const GEMINI_DEFAULTS = {
  pool: {
    strategy: 'balanced' as Strategy,
    accounts_per_daemon: 50,
    daemon_fault_isolation: true,
    max_concurrency_per_account: 20,
    max_sessions_per_account: 20,
    min_warm_slots: 1,
    session_idle_ttl_secs: 600,
    max_queue: 32,
    queue_timeout_ms: 10_000,
    timeout_ms: 120_000,
    first_byte_timeout_ms: 90_000,
    idle_timeout_ms: 15_000,
    circuit_failure_threshold: 3,
    circuit_open_ms: 30_000,
    eligibility_probe_interval_secs: 180,
    account_check_interval_secs: 300,
  },
  sticky: {
    enabled: true,
    ttl_seconds: 3600,
  },
  failover: {
    max_account_switches: 3,
    quota_cooldown_ms: 60_000,
    account_cooldown_ms: 300_000,
    unschedulable_on_502: true,
  },
  shm: {
    require_shm: true,
    request_mb: 4,
    response_mb: 16,
  },
}

const STRATEGIES: {
  id: Strategy
  title: string
  desc: string
}[] = [
  {
    id: 'balanced',
    title: '平衡',
    desc: '优先分配给占用率最低的 Gemini 账号与 agy 槽位，摊平并发与配额消耗。',
  },
  {
    id: 'fill',
    title: '填充',
    desc: '优先填满已预热、活跃度最高且未满的账号，减少空闲账号唤醒。',
  },
  {
    id: 'round_robin',
    title: '轮询',
    desc: '按顺序轮转选择可用账号，适合均匀压测或分散短时突发流量。',
  },
]

const PROTOCOL_ITEMS: {
  key: string
  label: string
  desc: string
  mode: 'native' | 'convert'
}[] = [
  {
    key: 'google.gemini',
    label: 'Google 原生 (/v1beta/models)',
    desc: '原生 Gemini generateContent / streamGenerateContent 入口。',
    mode: 'native',
  },
  {
    key: 'anthropic.messages',
    label: 'Anthropic Messages (/v1/messages)',
    desc: '将 Gemini 模型名请求经 Anthropic 协议转换接入 CRAGGemini。',
    mode: 'convert',
  },
  {
    key: 'openai.chat',
    label: 'OpenAI Chat (/v1/chat/completions)',
    desc: '兼容 OpenAI Chat Completions 客户端路由至 Gemini 账号池。',
    mode: 'convert',
  },
  {
    key: 'openai.responses',
    label: 'OpenAI Responses (/v1/responses)',
    desc: '兼容 OpenAI Responses API 客户端路由至 Gemini 账号池。',
    mode: 'convert',
  },
  {
    key: 'google.gemini.session',
    label: 'Gemini 会话 (/v1/gemini/sessions)',
    desc: '独立会话化入口，支持多轮上下文粘性绑定。',
    mode: 'native',
  },
]

function asBlock(value: unknown): Block {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Block)
    : {}
}

function numOf(source: Block, key: string, fallback: number): number {
  const n = Number(source[key] ?? fallback)
  return Number.isFinite(n) ? n : fallback
}

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes >= 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${bytes} B`
}

function DaemonLivePanel({
  status,
  loading,
  onRefresh,
  onAction,
  actionPending,
}: {
  status: GeminiDaemonStatus | undefined
  loading: boolean
  onRefresh: () => void
  onAction: (payload: Record<string, unknown>) => void
  actionPending: boolean
}) {
  const available = status?.available === true
  const shards = status?.shards ?? []
  const shm = status?.shm_ring_stats ?? null

  return (
    <PaneSection
      icon={Cpu}
      title='CRAGGemini 守护进程与运行状态'
      desc='实时查看单进程分片接管的多账号状态、agy 槽位水位与通道吞吐。'
      aside={
        <div className='flex items-center gap-1.5'>
          <Badge variant={available ? 'default' : 'secondary'}>
            {available
              ? status?.mode === 'sharded'
                ? `分片接管 · ${status?.accounts_per_daemon ?? 50}/进程`
                : '单账号隔离'
              : loading
                ? '读取中'
                : '宿主未连接'}
          </Badge>
          <Button
            type='button'
            size='sm'
            variant='outline'
            className='h-7 gap-1 px-2 text-xs'
            onClick={onRefresh}
            disabled={loading}
          >
            <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
            刷新
          </Button>
          <Button
            type='button'
            size='sm'
            variant='ghost'
            className='h-7 gap-1 px-2 text-xs'
            asChild
          >
            <Link
              to='/settings/$tab'
              params={{ tab: 'gemini' }}
              hash={GEMINI_MAINTENANCE_SECTION_ID}
            >
              <Wrench className='size-3' />
              Gemini 维护
            </Link>
          </Button>
        </div>
      }
    >
      {!available ? (
        <div className='flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground'>
          <span>
            {status?.host_message ||
              '未检测到在线的 Gemini 宿主机服务；下方配置仍可保存，宿主启动后自动生效。'}
          </span>
        </div>
      ) : (
        <div className='space-y-3'>
          <div className='grid grid-cols-2 gap-2.5 sm:grid-cols-4'>
            <div className='rounded-md border bg-muted/25 px-3 py-2'>
              <div className='text-[11px] text-muted-foreground'>
                活跃分片 / 规划
              </div>
              <div className='mt-0.5 text-sm font-semibold tabular-nums'>
                {shards.length} / {status?.planned_shards ?? 0}
              </div>
            </div>
            <div className='rounded-md border bg-muted/25 px-3 py-2'>
              <div className='text-[11px] text-muted-foreground'>
                接管账号 / 已授权
              </div>
              <div className='mt-0.5 text-sm font-semibold tabular-nums'>
                {status?.total_accounts ?? 0} /{' '}
                {status?.authorized_oauth_accounts ?? 0}
              </div>
            </div>
            <div className='rounded-md border bg-muted/25 px-3 py-2'>
              <div className='text-[11px] text-muted-foreground'>
                agy 槽位 (活跃/空闲)
              </div>
              <div className='mt-0.5 text-sm font-semibold tabular-nums'>
                {status?.total_active_slots ?? 0} /{' '}
                {status?.total_idle_slots ?? 0}
              </div>
            </div>
            <div className='rounded-md border bg-muted/25 px-3 py-2'>
              <div className='text-[11px] text-muted-foreground'>
                通道请求 / 校验异常
              </div>
              <div className='mt-0.5 text-sm font-semibold tabular-nums'>
                {shm
                  ? `${shm.requests_total} / ${shm.crc_errors_total}`
                  : '待建立'}
              </div>
            </div>
          </div>

          {shm ? (
            <div className='flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground tabular-nums'>
              <span>通道入站：{fmtBytes(shm.request_bytes_total)}</span>
              <span>通道出站：{fmtBytes(shm.response_bytes_total)}</span>
              <span>响应帧：{shm.responses_total}</span>
              <span>背压等待：{shm.backpressure_waits_total}</span>
            </div>
          ) : null}

          {shards.length > 0 ? (
            <div className='divide-y rounded-md border'>
              {shards.map((shard) => (
                <div
                  key={shard.shard_id}
                  className='flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs'
                >
                  <div className='flex flex-wrap items-center gap-2'>
                    <span className='font-mono font-medium'>
                      {shard.shard_id}
                    </span>
                    <Badge
                      variant={
                        shard.fault_isolated
                          ? 'destructive'
                          : shard.ready
                            ? 'secondary'
                            : 'outline'
                      }
                    >
                      {shard.fault_isolated
                        ? '已故障隔离'
                        : shard.ready
                          ? '就绪'
                          : shard.alive
                            ? '预热中'
                            : '已停止'}
                    </Badge>
                    <span className='text-muted-foreground tabular-nums'>
                      账号 {shard.account_count}/{shard.capacity} · 槽位{' '}
                      {shard.active_slots} 忙 / {shard.idle_slots} 闲
                      {shard.circuit_open_accounts > 0
                        ? ` · 熔断 ${shard.circuit_open_accounts}`
                        : ''}
                    </span>
                  </div>
                  {shard.kind === 'shard' ? (
                    <Button
                      type='button'
                      size='sm'
                      variant='ghost'
                      className='h-6 gap-1 px-2 text-[11px]'
                      disabled={actionPending}
                      onClick={() =>
                        onAction({
                          action: 'restart_shard',
                          shard_id: shard.shard_id,
                        })
                      }
                    >
                      <RotateCcw className='size-3' />
                      重启此分片
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          <div className='flex flex-wrap items-center justify-end gap-2'>
            <Button
              type='button'
              size='sm'
              variant='outline'
              className='h-7 gap-1 px-2.5 text-xs'
              disabled={actionPending}
              onClick={() => onAction({ action: 'rebalance' })}
            >
              <Layers className='size-3' />
              重平衡分片
            </Button>
          </div>
        </div>
      )}
    </PaneSection>
  )
}

export function GeminiConfigPane({
  value,
  onChange,
  saving = false,
}: {
  value: Block
  onChange: (next: Block) => void
  saving?: boolean
}) {
  const qc = useQueryClient()
  const daemonQuery = useQuery(geminiDaemonStatusQueryOptions())
  const daemonAction = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api('/api/panel/gemini/daemon-action', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: async () => {
      toast.success('守护进程操作已执行')
      await qc.invalidateQueries({
        queryKey: geminiDaemonStatusQueryOptions().queryKey,
      })
    },
    onError: (err: Error) => toast.error(err.message || '操作失败'),
  })

  const root = asBlock(value)
  const routeOn = root.enabled !== false
  const protocols = asBlock(root.protocols)
  const pool = asBlock(root.pool)
  const sticky = asBlock(root.sticky)
  const failover = asBlock(root.failover)
  const shm = asBlock(root.shm)

  const strategy: Strategy =
    pool.strategy === 'fill' || pool.strategy === 'round_robin'
      ? pool.strategy
      : 'balanced'
  const accountsPerDaemon = numOf(
    pool,
    'accounts_per_daemon',
    GEMINI_DEFAULTS.pool.accounts_per_daemon
  )
  const daemonFaultIsolation = pool.daemon_fault_isolation !== false
  const maxConc = numOf(
    pool,
    'max_concurrency_per_account',
    GEMINI_DEFAULTS.pool.max_concurrency_per_account
  )
  const maxSessions = numOf(
    pool,
    'max_sessions_per_account',
    GEMINI_DEFAULTS.pool.max_sessions_per_account
  )
  const minWarm = Math.min(
    maxConc,
    numOf(pool, 'min_warm_slots', GEMINI_DEFAULTS.pool.min_warm_slots)
  )
  const eligibilityProbeInterval = numOf(
    pool,
    'eligibility_probe_interval_secs',
    GEMINI_DEFAULTS.pool.eligibility_probe_interval_secs
  )
  const accountCheckInterval = numOf(
    pool,
    'account_check_interval_secs',
    GEMINI_DEFAULTS.pool.account_check_interval_secs
  )
  const idleTtlSecs = numOf(
    pool,
    'session_idle_ttl_secs',
    GEMINI_DEFAULTS.pool.session_idle_ttl_secs
  )
  const maxQueue = numOf(pool, 'max_queue', GEMINI_DEFAULTS.pool.max_queue)
  const queueTimeoutMs = numOf(
    pool,
    'queue_timeout_ms',
    GEMINI_DEFAULTS.pool.queue_timeout_ms
  )
  const timeoutMs = numOf(pool, 'timeout_ms', GEMINI_DEFAULTS.pool.timeout_ms)
  const firstByteTimeoutMs = numOf(
    pool,
    'first_byte_timeout_ms',
    GEMINI_DEFAULTS.pool.first_byte_timeout_ms
  )
  const idleTimeoutMs = numOf(
    pool,
    'idle_timeout_ms',
    GEMINI_DEFAULTS.pool.idle_timeout_ms
  )
  const circuitThreshold = numOf(
    pool,
    'circuit_failure_threshold',
    GEMINI_DEFAULTS.pool.circuit_failure_threshold
  )
  const circuitOpenMs = numOf(
    pool,
    'circuit_open_ms',
    GEMINI_DEFAULTS.pool.circuit_open_ms
  )
  const stickyEnabled = sticky.enabled !== false
  const stickyTtlSecs = numOf(
    sticky,
    'ttl_seconds',
    GEMINI_DEFAULTS.sticky.ttl_seconds
  )
  const maxSwitches = numOf(
    failover,
    'max_account_switches',
    GEMINI_DEFAULTS.failover.max_account_switches
  )
  const quotaCooldownMs = numOf(
    failover,
    'quota_cooldown_ms',
    GEMINI_DEFAULTS.failover.quota_cooldown_ms
  )
  const accountCooldownMs = numOf(
    failover,
    'account_cooldown_ms',
    GEMINI_DEFAULTS.failover.account_cooldown_ms
  )
  const unschedulableOn502 = failover.unschedulable_on_502 !== false
  const shmReqMb = numOf(shm, 'request_mb', GEMINI_DEFAULTS.shm.request_mb)
  const shmRespMb = numOf(shm, 'response_mb', GEMINI_DEFAULTS.shm.response_mb)
  const perfTier = resolveGeminiPerformanceTier(shmReqMb, shmRespMb)

  const update = (patch: Block) => onChange({ ...root, ...patch })
  const updatePool = (patch: Block) => {
    const nextPool = { ...pool, ...patch }
    if (
      typeof nextPool.max_concurrency_per_account === 'number' &&
      typeof nextPool.min_warm_slots === 'number' &&
      nextPool.min_warm_slots > nextPool.max_concurrency_per_account
    ) {
      nextPool.min_warm_slots = nextPool.max_concurrency_per_account
    }
    update({ pool: nextPool })
  }
  const updateSticky = (patch: Block) =>
    update({ sticky: { ...sticky, ...patch } })
  const updateFailover = (patch: Block) =>
    update({ failover: { ...failover, ...patch } })
  const updateShm = (patch: Block) => update({ shm: { ...shm, ...patch } })
  const setProtocol = (
    key: string,
    mode: 'native' | 'convert',
    enabled: boolean
  ) =>
    update({
      protocols: {
        ...protocols,
        [key]: { mode, enabled },
      },
    })

  return (
    <div className='space-y-4'>
      <DaemonLivePanel
        status={daemonQuery.data}
        loading={daemonQuery.isFetching}
        onRefresh={() => void daemonQuery.refetch()}
        onAction={(payload) => daemonAction.mutate(payload)}
        actionPending={daemonAction.isPending}
      />

      <PaneSection
        icon={ShieldCheck}
        title='入口与协议准入'
        desc={
          routeOn
            ? '控制 Gemini 总开关及各协议入口是否允许调度至 CRAGGemini。'
            : '已关闭：所有 Gemini 公共入口返回 403（gemini_disabled），不消耗账号配额。'
        }
        aside={
          <Switch
            checked={routeOn}
            disabled={saving}
            onCheckedChange={(enabled) => update({ enabled })}
            aria-label='启用 Gemini 入口路由'
          />
        }
      >
        <div
          className={cn(
            'divide-y transition-opacity duration-200',
            !routeOn && 'opacity-55'
          )}
        >
          {PROTOCOL_ITEMS.map((item) => {
            const entry = asBlock(protocols[item.key])
            const enabled = entry.enabled !== false
            return (
              <SettingRow key={item.key} label={item.label} desc={item.desc}>
                <Switch
                  checked={enabled}
                  disabled={saving}
                  onCheckedChange={(checked) =>
                    setProtocol(item.key, item.mode, checked)
                  }
                  aria-label={item.label}
                />
              </SettingRow>
            )
          })}
          <SettingRow
            label='官方 Gemini 请求体透传'
            desc={
              root.official_passthrough !== false
                ? '开：仅经校验的原生 Google Gemini 请求体走透传路径（仍执行 8-Key SHM 投影与提示词归一化）；第三方冲突指纹与跨协议一律走 IR 归一化。'
                : '关：原生 Gemini 请求也强制走统一 IR 归一，不透传原始请求体。'
            }
          >
            <Switch
              checked={root.official_passthrough !== false}
              disabled={saving}
              onCheckedChange={(official_passthrough) =>
                update({ official_passthrough })
              }
              aria-label='官方 Gemini 请求体透传'
            />
          </SettingRow>
        </div>
      </PaneSection>

      <PaneSection
        icon={Sparkles}
        title='调度策略与粘性会话'
        desc='借鉴 Anthropic 账号池策略；保存后热更新至在线 CRAGGemini 分片与网关调度器。'
      >
        <div
          role='radiogroup'
          aria-label='Gemini 调度策略'
          className='grid gap-3 sm:grid-cols-3'
        >
          {STRATEGIES.map((item) => {
            const selected = item.id === strategy
            return (
              <button
                key={item.id}
                type='button'
                role='radio'
                aria-checked={selected}
                disabled={saving}
                onClick={() => updatePool({ strategy: item.id })}
                className={cn(
                  'flex cursor-pointer flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors duration-150 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
                  selected
                    ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                    : 'hover:border-primary/40 hover:bg-accent/40'
                )}
              >
                <div className='flex items-center justify-between gap-2'>
                  <span className='text-sm font-semibold'>{item.title}</span>
                  <span
                    aria-hidden
                    className={cn(
                      'grid size-4 place-items-center rounded-full border',
                      selected ? 'border-primary' : 'border-muted-foreground/40'
                    )}
                  >
                    {selected ? (
                      <span className='size-2 rounded-full bg-primary' />
                    ) : null}
                  </span>
                </div>
                <p className='text-xs leading-5 text-muted-foreground'>
                  {item.desc}
                </p>
              </button>
            )
          })}
        </div>

        <div className='divide-y border-t pt-3'>
          <SettingRow
            label='会话粘性绑定'
            desc='同一会话标识优先回到原 Gemini 账号与对应 agy 槽位，保持上下文连续性。'
          >
            <Switch
              checked={stickyEnabled}
              disabled={saving}
              onCheckedChange={(enabled) => updateSticky({ enabled })}
              aria-label='会话粘性绑定'
            />
          </SettingRow>
          <div className='pt-3'>
            <SliderSetting
              id='gemini-sticky-ttl'
              label='粘性保留时长'
              desc='超时未活跃后释放会话与账号的绑定；设为 0 时不保留跨请求粘性绑定。'
              value={stickyTtlSecs}
              min={0}
              max={86400}
              step={60}
              format={(s) => (s === 0 ? '不保留' : fmtDuration(s * 1000))}
              fallback={GEMINI_DEFAULTS.sticky.ttl_seconds}
              presets={[300, 1800, 3600, 14400, 86400]}
              onChange={(ttl_seconds) => updateSticky({ ttl_seconds })}
            />
          </div>
        </div>
      </PaneSection>

      <PaneSection
        icon={Layers}
        title='单 CRAGGemini 多账号接管与并发'
        desc='每个 CRAGGemini 进程通过独立代理桥与隔离目录接管多账号 agy CLI 生命周期；按分片上限自动切分故障域。'
      >
        <div className='space-y-4'>
          <div className='space-y-2'>
            <StepperSetting
              id='gemini-accounts-per-daemon'
              label='单 CRAGGemini 接管账号上限'
              desc='默认 50 账号/分片；超过上限自动分配新分片进程。设为 1 时退化为单账号独立守护进程隔离。'
              value={accountsPerDaemon}
              min={1}
              max={256}
              unit='个'
              fallback={GEMINI_DEFAULTS.pool.accounts_per_daemon}
              onChange={(accounts_per_daemon) =>
                updatePool({ accounts_per_daemon })
              }
            />
            <ChipGroup
              label='分片容量常用值'
              value={accountsPerDaemon}
              disabled={saving}
              options={[
                [1, '1 (单账号隔离)'],
                [10, '10'],
                [25, '25'],
                [50, '50 (推荐)'],
                [100, '100'],
              ]}
              onChange={(accounts_per_daemon) =>
                updatePool({ accounts_per_daemon })
              }
            />
          </div>

          <SettingRow
            label='分片故障域隔离与自动回退'
            desc='单个 CRAGGemini 分片异常或崩溃时仅隔离该分片并自动重启/回退，不影响同宿主其他分片账号。'
          >
            <Switch
              checked={daemonFaultIsolation}
              disabled={saving}
              onCheckedChange={(daemon_fault_isolation) =>
                updatePool({ daemon_fault_isolation })
              }
              aria-label='分片故障域隔离与自动回退'
            />
          </SettingRow>

          <div className='grid gap-4 border-t pt-4 sm:grid-cols-3'>
            <StepperSetting
              id='gemini-max-concurrency'
              label='单账号默认并发槽位'
              desc='单个账号可同时运行的 agy CLI 进程上限（默认 20）。'
              value={maxConc}
              min={1}
              max={64}
              unit='并发'
              fallback={GEMINI_DEFAULTS.pool.max_concurrency_per_account}
              onChange={(max_concurrency_per_account) =>
                updatePool({ max_concurrency_per_account })
              }
            />
            <StepperSetting
              id='gemini-max-sessions'
              label='单账号默认会话上限'
              desc='单账号可并发粘性绑定的 Session 上限（默认 20）。'
              value={maxSessions}
              min={1}
              max={64}
              unit='会话'
              fallback={GEMINI_DEFAULTS.pool.max_sessions_per_account}
              onChange={(max_sessions_per_account) =>
                updatePool({ max_sessions_per_account })
              }
            />
            <StepperSetting
              id='gemini-min-warm-slots'
              label='每账号最小常驻热槽'
              desc='低延迟预热 agy 进程数（不可超过单账号并发上限）。'
              value={minWarm}
              min={0}
              max={Math.min(16, maxConc)}
              unit='槽'
              fallback={GEMINI_DEFAULTS.pool.min_warm_slots}
              onChange={(min_warm_slots) => updatePool({ min_warm_slots })}
            />
          </div>

          <div className='grid gap-4 border-t pt-4 sm:grid-cols-2'>
            <StepperSetting
              id='gemini-max-queue'
              label='分片最大排队长度'
              desc='单账号槽位占满时可排队的请求数量（0 表示直接拒绝）。'
              value={maxQueue}
              min={0}
              max={64}
              unit='个'
              fallback={GEMINI_DEFAULTS.pool.max_queue}
              onChange={(max_queue) => updatePool({ max_queue })}
            />
            <StepperSetting
              id='gemini-idle-ttl'
              label='突发槽位空闲回收'
              desc='超出常驻热槽的突发 agy 进程空闲超时后自动回收（0 表示不回收）。'
              value={idleTtlSecs}
              min={0}
              max={86400}
              step={60}
              unit='秒'
              fallback={GEMINI_DEFAULTS.pool.session_idle_ttl_secs}
              onChange={(session_idle_ttl_secs) =>
                updatePool({
                  session_idle_ttl_secs:
                    session_idle_ttl_secs > 0 && session_idle_ttl_secs < 10
                      ? 10
                      : session_idle_ttl_secs,
                })
              }
            />
          </div>

          <div className='grid gap-4 border-t pt-4 sm:grid-cols-2'>
            <SliderSetting
              id='gemini-queue-timeout'
              label='排队等待超时'
              value={queueTimeoutMs}
              min={1000}
              max={120000}
              step={1000}
              format={fmtDuration}
              fallback={GEMINI_DEFAULTS.pool.queue_timeout_ms}
              presets={[3000, 10000, 30000, 60000]}
              onChange={(queue_timeout_ms) => updatePool({ queue_timeout_ms })}
            />
            <SliderSetting
              id='gemini-first-byte-timeout'
              label='首字节超时'
              value={firstByteTimeoutMs}
              min={5000}
              max={300000}
              step={5000}
              format={fmtDuration}
              fallback={GEMINI_DEFAULTS.pool.first_byte_timeout_ms}
              presets={[30000, 60000, 90000, 180000]}
              onChange={(first_byte_timeout_ms) =>
                updatePool({ first_byte_timeout_ms })
              }
            />
            <SliderSetting
              id='gemini-turn-timeout'
              label='单轮总超时'
              value={timeoutMs}
              min={10000}
              max={600000}
              step={10000}
              format={fmtDuration}
              fallback={GEMINI_DEFAULTS.pool.timeout_ms}
              presets={[60000, 120000, 300000, 600000]}
              onChange={(timeout_ms) => updatePool({ timeout_ms })}
            />
            <SliderSetting
              id='gemini-stream-idle-timeout'
              label='流式空闲超时'
              value={idleTimeoutMs}
              min={5000}
              max={180000}
              step={5000}
              format={fmtDuration}
              fallback={GEMINI_DEFAULTS.pool.idle_timeout_ms}
              presets={[15000, 30000, 60000, 120000]}
              onChange={(idle_timeout_ms) => updatePool({ idle_timeout_ms })}
            />
          </div>
        </div>
      </PaneSection>

      <PaneSection
        icon={Gauge}
        title='CRAGGemini 性能配置'
        desc='按宿主机内存与并发负载选择运行性能等级，保存后应用到 CRAGGemini 数据通道。'
      >
        <div
          role='radiogroup'
          aria-label='CRAGGemini 性能配置'
          className='grid gap-3 sm:grid-cols-3'
        >
          {GEMINI_PERFORMANCE_TIERS.map((tier) => {
            const selected = tier.id === perfTier
            return (
              <button
                key={tier.id}
                type='button'
                role='radio'
                aria-checked={selected}
                disabled={saving}
                onClick={() => updateShm({ ...tier.shm })}
                className={cn(
                  'flex cursor-pointer flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors duration-150 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
                  selected
                    ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                    : 'hover:border-primary/40 hover:bg-accent/40'
                )}
              >
                <div className='flex items-center justify-between gap-2'>
                  <div className='flex items-center gap-1.5'>
                    <span className='text-sm font-semibold'>{tier.title}</span>
                    {tier.id === 'medium' ? (
                      <Badge
                        variant='secondary'
                        className='h-4 px-1.5 text-[10px]'
                      >
                        默认
                      </Badge>
                    ) : null}
                  </div>
                  <span
                    aria-hidden
                    className={cn(
                      'grid size-4 place-items-center rounded-full border',
                      selected ? 'border-primary' : 'border-muted-foreground/40'
                    )}
                  >
                    {selected ? (
                      <span className='size-2 rounded-full bg-primary' />
                    ) : null}
                  </span>
                </div>
                <p className='text-xs leading-5 text-muted-foreground'>
                  {tier.desc}
                </p>
              </button>
            )
          })}
        </div>
      </PaneSection>

      <PaneSection
        icon={ShieldAlert}
        title='故障切号与熔断保护'
        desc='单账号 400/403/429/5xx 或桥接异常时自动隔离与切号，保护同分片其余账号稳定。'
      >
        <div className='space-y-4'>
          <div className='grid gap-4 sm:grid-cols-2'>
            <StepperSetting
              id='gemini-max-switches'
              label='单次请求最大切号次数'
              desc='遇到限流或账号异常时最多切换其他候选账号的次数。'
              value={maxSwitches}
              min={0}
              max={20}
              unit='次'
              fallback={GEMINI_DEFAULTS.failover.max_account_switches}
              onChange={(max_account_switches) =>
                updateFailover({ max_account_switches })
              }
            />
            <StepperSetting
              id='gemini-circuit-threshold'
              label='分片内单账号熔断阈值'
              desc='连续失败达到该次数后临时摘除该账号（0 表示关闭单账号熔断）。'
              value={circuitThreshold}
              min={0}
              max={20}
              unit='次'
              fallback={GEMINI_DEFAULTS.pool.circuit_failure_threshold}
              onChange={(circuit_failure_threshold) =>
                updatePool({ circuit_failure_threshold })
              }
            />
          </div>

          <div className='grid gap-4 border-t pt-4 sm:grid-cols-3'>
            <SliderSetting
              id='gemini-circuit-open'
              label='熔断冷却时长'
              value={circuitOpenMs}
              min={1000}
              max={300000}
              step={1000}
              format={fmtDuration}
              fallback={GEMINI_DEFAULTS.pool.circuit_open_ms}
              presets={[15000, 30000, 60000]}
              onChange={(circuit_open_ms) => updatePool({ circuit_open_ms })}
            />
            <SliderSetting
              id='gemini-quota-cooldown'
              label='配额 429 冷却'
              value={quotaCooldownMs}
              min={5000}
              max={600000}
              step={5000}
              format={fmtDuration}
              fallback={GEMINI_DEFAULTS.failover.quota_cooldown_ms}
              presets={[30000, 60000, 180000]}
              onChange={(quota_cooldown_ms) =>
                updateFailover({ quota_cooldown_ms })
              }
            />
            <SliderSetting
              id='gemini-account-cooldown'
              label='账号故障冷却'
              value={accountCooldownMs}
              min={10000}
              max={1800000}
              step={10000}
              format={fmtDuration}
              fallback={GEMINI_DEFAULTS.failover.account_cooldown_ms}
              presets={[60000, 300000, 600000]}
              onChange={(account_cooldown_ms) =>
                updateFailover({ account_cooldown_ms })
              }
            />
          </div>

          <div className='border-t pt-4'>
            <SettingRow
              label='502 自动打入不可调度'
              desc='请求触发上游/代理 502 错误时自动将该 Gemini 账号置为不可调度（类似 Codex 不可调度态），避免 502→503 死循环；恢复可点「恢复状态」或刷新账号。'
            >
              <Switch
                id='gemini-unschedulable-502'
                checked={unschedulableOn502}
                disabled={saving}
                onCheckedChange={(unschedulable_on_502) =>
                  updateFailover({ unschedulable_on_502 })
                }
              />
            </SettingRow>
          </div>

          <div className='grid gap-4 border-t pt-4 sm:grid-cols-2'>
            <SliderSetting
              id='gemini-account-check-interval'
              label='账号定时状态检查间隔'
              desc='定期巡检所有已启用 Gemini 账号的凭证、资格与额度状态，自动刷新错误归因并在额度恢复时解除冷却（0 表示关闭）。'
              value={accountCheckInterval}
              min={0}
              max={3600}
              step={60}
              format={(s) => (s === 0 ? '关闭' : fmtDuration(s * 1000))}
              fallback={GEMINI_DEFAULTS.pool.account_check_interval_secs}
              presets={[60, 300, 600, 1800]}
              onChange={(account_check_interval_secs) =>
                updatePool({
                  account_check_interval_secs:
                    account_check_interval_secs > 0 &&
                    account_check_interval_secs < 60
                      ? 60
                      : account_check_interval_secs,
                })
              }
            />
            <SliderSetting
              id='gemini-eligibility-probe'
              label='资格警告定时探测间隔'
              desc='对标记 VALIDATION_REQUIRED 等上游受限状态的账号定期探测；一旦能够成功推理即自动清除警告并恢复调度（0 表示关闭定时探测）。'
              value={eligibilityProbeInterval}
              min={0}
              max={3600}
              step={30}
              format={(s) => (s === 0 ? '关闭' : fmtDuration(s * 1000))}
              fallback={GEMINI_DEFAULTS.pool.eligibility_probe_interval_secs}
              presets={[60, 180, 300, 900]}
              onChange={(eligibility_probe_interval_secs) =>
                updatePool({
                  eligibility_probe_interval_secs:
                    eligibility_probe_interval_secs > 0 &&
                    eligibility_probe_interval_secs < 30
                      ? 30
                      : eligibility_probe_interval_secs,
                })
              }
            />
          </div>
        </div>
      </PaneSection>
    </div>
  )
}
