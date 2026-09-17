import type { RequestAttempt, RequestLogItem } from '@/types/panel-logs'
import type { Vm } from '@/types/panel-vm'
import { FileText, Gauge, GitBranch } from 'lucide-react'
import { fmtExpiresAt, fmtNum, fmtTok, fmtUsd } from '@/lib/format'
import { maskPresentedKey } from '@/lib/log-mute'
import { errorClassTone, statusTone } from '@/lib/log-tone'
import { CircularProgress } from '@/components/ui/circular-progress'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SlotIdentity } from '@/components/platform-chip'
import { QueryGate } from '@/components/query-gate'
import { StatusMark } from '@/components/status-mark'
import { LatencyBreakdownBar } from '@/features/logs/latency-breakdown-bar'

const SECRET_KEY =
  /access_token|refresh_token|session_key|password|secret|authorization|cookie|master_key|api_key|proxy_url|oauth/i

const SKIP_DUMP_KEYS: Record<string, true> = {
  request_body_snapshot: true,
  inbound_summary: true,
  headers: true,
  raw_body: true,
  body: true,
  request_body: true,
  response_body: true,
  hop_meta: true,
  usage: true,
}

const SUMMARY_KEYS: Record<string, true> = {
  request_id: true,
  id: true,
  created_at: true,
  ts: true,
  status: true,
  upstream_status: true,
  model: true,
  requested_model: true,
  upstream_model: true,
  model_mismatch: true,
  input_tokens: true,
  output_tokens: true,
  cache_read_tokens: true,
  cache_creation_tokens: true,
  cache_creation_5m_tokens: true,
  cache_creation_1h_tokens: true,
  first_token_ms: true,
  duration_ms: true,
  stop_reason: true,
  error_class: true,
  error_label: true,
  error_owner: true,
  error_code: true,
  error_message: true,
  vm_id: true,
  attempt_count: true,
  via: true,
  protocol: true,
  ip: true,
  // 已有专属掩码渲染行。同时 SECRET_KEY 也会拦住它 —— 两道锁都留着，
  // 免得将来有人放宽那条正则时这里悄悄变成明文直出。
  api_key_presented: true,
  stream: true,
  total_cost: true,
  actual_cost: true,
  rate_multiplier: true,
}

const ATTEMPT_KEYS: Record<string, true> = {
  attempt_no: true,
  vm_id: true,
  account_id: true,
  error_scope: true,
  error_domain: true,
  error_class: true,
  error_label: true,
  error_owner: true,
  error_code: true,
  error_message: true,
  cooldown: true,
  cooldown_until: true,
  cooldown_ms: true,
  cooldown_reason: true,
  selection_reason: true,
  wait_ms: true,
  latency_ms: true,
  ttft_ms: true,
  started_at: true,
  completed_at: true,
  downstream_committed: true,
  upstream_status: true,
  terminal_state: true,
  action: true,
  status: true,
}

export function LogDetailSheet({
  open,
  requestId,
  item,
  attempts,
  vms,
  loading,
  error,
  onOpenChange,
}: {
  open: boolean
  requestId: string
  item?: RequestLogItem
  attempts: RequestAttempt[]
  vms?: Map<string, Vm>
  loading: boolean
  error: unknown
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side='right'
        className='w-[95vw] overflow-y-auto sm:w-[560px] sm:max-w-none md:w-[720px] lg:w-[820px]'
      >
        <SheetHeader className='pb-2'>
          <SheetTitle>请求详情</SheetTitle>
          <SheetDescription className='font-mono text-xs break-all'>
            {requestId || '—'}
          </SheetDescription>
        </SheetHeader>
        <div className='pb-8'>
          <QueryGate loading={loading} error={error}>
            <Tabs key={requestId} defaultValue='summary' className='w-full'>
              <TabsList className='grid h-auto w-full grid-cols-3 p-1'>
                <TabsTrigger
                  value='summary'
                  className='gap-1.5 text-xs sm:text-sm'
                >
                  <FileText className='size-3.5 shrink-0 sm:size-4' />
                  摘要
                </TabsTrigger>
                <TabsTrigger
                  value='trace'
                  className='gap-1.5 text-xs sm:text-sm'
                >
                  <GitBranch className='size-3.5 shrink-0 sm:size-4' />
                  调用轨迹
                </TabsTrigger>
                <TabsTrigger
                  value='performance'
                  className='gap-1.5 text-xs sm:text-sm'
                >
                  <Gauge className='size-3.5 shrink-0 sm:size-4' />
                  性能
                </TabsTrigger>
              </TabsList>
              <TabsContent value='summary' className='mt-4'>
                <SummaryTab
                  item={item}
                  attemptCount={attempts.length}
                  vms={vms}
                />
              </TabsContent>
              <TabsContent value='trace' className='mt-4'>
                <TraceTab attempts={attempts} vms={vms} />
              </TabsContent>
              <TabsContent value='performance' className='mt-4'>
                <PerformanceTab item={item} />
              </TabsContent>
            </Tabs>
          </QueryGate>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function SummaryTab({
  item,
  attemptCount,
  vms,
}: {
  item?: RequestLogItem
  attemptCount: number
  vms?: Map<string, Vm>
}) {
  if (!item) {
    return <p className='text-sm text-muted-foreground'>没有这条请求的详情。</p>
  }
  const requested =
    item.requested_model == null ? '' : String(item.requested_model)
  const upstream =
    item.upstream_model == null ? '' : String(item.upstream_model)
  const namesDiffer = !!(requested && upstream && requested !== upstream)
  const mismatch = namesDiffer || item.model_mismatch === true
  const model =
    requested || (item.model == null ? '' : String(item.model)) || '—'
  const hop = item.hop_meta
  const via = item.via ?? (asRecord(hop) ? hop.via : undefined)
  const rows: Array<[string, React.ReactNode]> = [
    ['时间', fmtExpiresAt(item.created_at ?? item.ts)],
    [
      '模型',
      <span className='font-mono text-xs'>
        {model}
        {namesDiffer ? ` → ${upstream}` : ''}
      </span>,
    ],
    ['Token', fmtTok(item)],
  ]
  pushPresent(rows, '缓存读', item.cache_read_tokens, fmtNum)
  pushPresent(rows, '缓存写', item.cache_creation_tokens, fmtNum)
  pushPresent(rows, '缓存写 5m', item.cache_creation_5m_tokens, fmtNum)
  pushPresent(rows, '缓存写 1h', item.cache_creation_1h_tokens, fmtNum)
  rows.push(['结束原因', dash(item.stop_reason)])
  rows.push([
    '账号',
    <SlotIdentity
      vm={item.vm_id ? vms?.get(String(item.vm_id)) : undefined}
      vmId={item.vm_id}
      model={item.requested_model || item.model}
      protocol={item.protocol == null ? undefined : String(item.protocol)}
    />,
  ])
  rows.push(['尝试数', dash(item.attempt_count ?? attemptCount)])
  pushPresent(rows, '归属', item.error_owner)
  pushPresent(rows, '错误码', item.error_code, mono)
  pushPresent(rows, '错误', item.error_message)
  pushPresent(rows, '官方费用', item.total_cost, fmtUsd)
  pushPresent(rows, '实际费用', item.actual_cost, fmtUsd)
  pushPresent(rows, '倍率', item.rate_multiplier)
  pushPresent(rows, '实际链路', via, mono)
  pushPresent(rows, '协议', item.protocol)
  pushPresent(rows, '流式', item.stream)
  pushPresent(rows, 'IP', item.ip, mono)
  // 入站 Key 是攻击者可控的明文，后端不掩码 —— 只渲染掩码结果，
  // 不设 title、不提供复制。（未命中时 SECRET_KEY 正则也会拦住兜底 dump。）
  if (item.api_key_presented) {
    rows.push([
      '入站 Key',
      <span className='font-mono text-xs'>
        {maskPresentedKey(item.api_key_presented)}
      </span>,
    ])
  }
  for (const [key, value] of leftoverFields(item, SUMMARY_KEYS)) {
    rows.push([key, <span className='font-mono text-xs'>{value}</span>])
  }

  return (
    <div className='divide-y'>
      <div className='flex flex-wrap items-center gap-2 pb-3'>
        <StatusMark tone={statusTone(item.status)} variant='pill' />
        {item.upstream_status != null &&
        item.upstream_status !== '' &&
        item.upstream_status !== item.status ? (
          <StatusMark tone={statusTone(item.upstream_status)} variant='pill' />
        ) : null}
        <ErrorClassMark item={item} />
        {mismatch ? (
          <StatusMark
            variant='pill'
            tone={{
              key: 'mismatch',
              text: '不一致',
              cls: 'caution',
              label: '不一致',
            }}
          />
        ) : null}
      </div>
      {rows.map(([label, value]) => (
        <Field key={label} label={label}>
          {value}
        </Field>
      ))}
    </div>
  )
}

function ttftAssessment(ms: number): { label: string; cls: string } {
  if (ms < 1000)
    return { label: '优秀', cls: 'text-emerald-600 dark:text-emerald-400' }
  if (ms < 2000)
    return { label: '良好', cls: 'text-blue-600 dark:text-blue-400' }
  if (ms < 3000)
    return { label: '偏慢', cls: 'text-amber-600 dark:text-amber-400' }
  return { label: '过慢', cls: 'text-rose-600 dark:text-rose-400' }
}

function outputRateAssessment(rate: number): { label: string; cls: string } {
  if (rate >= 80)
    return { label: '优秀', cls: 'text-emerald-600 dark:text-emerald-400' }
  if (rate >= 50)
    return { label: '良好', cls: 'text-blue-600 dark:text-blue-400' }
  if (rate >= 30)
    return { label: '偏慢', cls: 'text-amber-600 dark:text-amber-400' }
  return { label: '过慢', cls: 'text-rose-600 dark:text-rose-400' }
}

function PerformanceTab({ item }: { item?: RequestLogItem }) {
  if (!item) {
    return <p className='text-sm text-muted-foreground'>没有这条请求的详情。</p>
  }
  const ttftMs =
    item.first_token_ms == null ? null : Number(item.first_token_ms)
  const durationMs = item.duration_ms == null ? null : Number(item.duration_ms)
  const outputTokens =
    item.output_tokens == null ? null : Number(item.output_tokens)
  const generationMs =
    ttftMs != null && durationMs != null ? durationMs - ttftMs : null
  const outputRate =
    outputTokens != null && generationMs != null && generationMs > 0
      ? (outputTokens / generationMs) * 1000
      : null
  const ttft = ttftMs != null ? ttftAssessment(ttftMs) : null
  const rate = outputRate != null ? outputRateAssessment(outputRate) : null

  if (ttftMs == null && durationMs == null && outputRate == null) {
    return <p className='text-sm text-muted-foreground'>没有性能数据。</p>
  }

  return (
    <div className='space-y-6'>
      <div className='flex flex-col gap-4 sm:flex-row'>
        {ttftMs != null ? (
          <div className='flex flex-1 items-center gap-4 rounded-lg border p-4'>
            <CircularProgress
              value={Math.min(ttftMs, 3000)}
              max={3000}
              size={64}
              strokeWidth={5}
              showPercentage={false}
              toneClassName={ttft?.cls}
            />
            <div className='min-w-0 flex-1'>
              <p className='text-xs text-muted-foreground'>首字延迟</p>
              <p className='font-mono text-xl font-bold'>{fmtMs(ttftMs)}</p>
              {ttft ? (
                <span className={`text-[10px] ${ttft.cls}`}>{ttft.label}</span>
              ) : null}
            </div>
          </div>
        ) : null}
        {outputRate != null ? (
          <div className='flex flex-1 items-center gap-4 rounded-lg border p-4'>
            <CircularProgress
              value={Math.min(outputRate, 100)}
              max={100}
              size={64}
              strokeWidth={5}
              showPercentage={false}
              toneClassName={rate?.cls}
            />
            <div className='min-w-0 flex-1'>
              <p className='text-xs text-muted-foreground'>输出速率</p>
              <p className='font-mono text-xl font-bold'>
                {outputRate.toFixed(1)} tok/s
              </p>
              {rate ? (
                <span className={`text-[10px] ${rate.cls}`}>{rate.label}</span>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
      {ttftMs != null && durationMs != null ? (
        <div className='space-y-2'>
          <h4 className='text-sm font-semibold'>延迟分解</h4>
          <div className='rounded-lg border p-4'>
            <LatencyBreakdownBar ttftMs={ttftMs} durationMs={durationMs} />
          </div>
        </div>
      ) : null}
      <div className='divide-y rounded-lg border'>
        {durationMs != null ? (
          <div className='flex items-center justify-between px-4 py-3'>
            <span className='text-sm text-muted-foreground'>总耗时</span>
            <span className='font-mono text-sm font-medium'>
              {fmtMs(durationMs)}
            </span>
          </div>
        ) : null}
        {outputTokens != null ? (
          <div className='flex items-center justify-between px-4 py-3'>
            <span className='text-sm text-muted-foreground'>输出 Token</span>
            <span className='font-mono text-sm font-medium'>
              {fmtNum(outputTokens)}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function TraceTab({
  attempts,
  vms,
}: {
  attempts: RequestAttempt[]
  vms?: Map<string, Vm>
}) {
  if (!attempts.length) {
    return (
      <p className='text-sm text-muted-foreground'>
        没有调用轨迹。该请求可能没有写入 attempts，或 attempts
        接口返回了空列表。
      </p>
    )
  }
  return (
    <div className='space-y-3'>
      {attempts.map((attempt, index) => (
        <AttemptBlock key={index} attempt={attempt} index={index} vms={vms} />
      ))}
    </div>
  )
}

function AttemptBlock({
  attempt,
  index,
  vms,
}: {
  attempt: RequestAttempt
  index: number
  vms?: Map<string, Vm>
}) {
  if (!asRecord(attempt)) {
    return (
      <div className='space-y-2 rounded-md border p-3'>
        <div className='text-xs text-muted-foreground'>#{index + 1}</div>
        <div className='font-mono text-xs'>{dash(attempt)}</div>
      </div>
    )
  }
  const n = attempt.attempt_no ?? index + 1
  const rows: Array<[string, React.ReactNode]> = [
    [
      '账号',
      <SlotIdentity
        vm={attempt.vm_id ? vms?.get(String(attempt.vm_id)) : undefined}
        vmId={attempt.vm_id}
      />,
    ],
  ]
  pushPresent(rows, '选择原因', attempt.selection_reason)
  pushPresent(rows, '错误域', attempt.error_scope)
  pushPresent(rows, '等待', attempt.wait_ms, fmtMs)
  pushPresent(rows, '耗时', attempt.latency_ms, fmtMs)
  pushPresent(rows, '首字', attempt.ttft_ms, fmtMs)
  pushPresent(rows, '开始', attempt.started_at, fmtExpiresAt)
  pushPresent(rows, '结束', attempt.completed_at, fmtExpiresAt)
  pushPresent(
    rows,
    '已提交',
    attempt.downstream_committed == null
      ? undefined
      : attempt.downstream_committed
        ? '是'
        : '否'
  )
  pushPresent(rows, '终态', attempt.terminal_state)
  pushPresent(rows, '动作', attempt.action)
  pushPresent(rows, '冷却', cooldownText(attempt))
  for (const [key, value] of leftoverFields(attempt, ATTEMPT_KEYS)) {
    rows.push([key, <span className='font-mono text-xs'>{value}</span>])
  }

  return (
    <div className='space-y-1 rounded-md border p-3'>
      <div className='flex flex-wrap items-center gap-2 pb-1'>
        <span className='text-xs text-muted-foreground'>#{String(n)}</span>
        {attempt.status != null && attempt.status !== '' ? (
          <StatusMark tone={statusTone(attempt.status)} variant='pill' />
        ) : null}
        {attempt.upstream_status != null && attempt.upstream_status !== '' ? (
          <StatusMark
            tone={statusTone(attempt.upstream_status)}
            variant='pill'
          />
        ) : null}
        <ErrorClassMark item={attempt} />
      </div>
      {rows.map(([label, value]) => (
        <Field key={label} label={label}>
          {value}
        </Field>
      ))}
    </div>
  )
}

function ErrorClassMark({ item }: { item: Record<string, unknown> }) {
  const tone = errorClassTone(item)
  if (!tone) return null
  return <StatusMark tone={tone} variant='pill' />
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className='grid grid-cols-[6.5rem_1fr] items-start gap-x-3 py-1.5 text-sm'>
      <div className='text-muted-foreground'>{label}</div>
      <div className='min-w-0 break-all'>{children}</div>
    </div>
  )
}

function leftoverFields(
  rec: Record<string, unknown>,
  known: Record<string, true>
): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const [key, value] of Object.entries(rec)) {
    if (known[key] || SKIP_DUMP_KEYS[key] || SECRET_KEY.test(key)) continue
    if (value == null || value === '') continue
    const t = typeof value
    if (t !== 'string' && t !== 'number' && t !== 'boolean') continue
    out.push([key, String(value)])
  }
  return out
}

function cooldownText(rec: Record<string, unknown>): string | null {
  const parts: string[] = []
  if (rec.cooldown_reason) parts.push(String(rec.cooldown_reason))
  if (rec.cooldown_until) {
    parts.push(fmtExpiresAt(rec.cooldown_until))
    return parts.join(' · ')
  }
  if (rec.cooldown_ms != null && rec.cooldown_ms !== '') {
    parts.push(fmtMs(rec.cooldown_ms))
    return parts.join(' · ')
  }
  const cooldown = rec.cooldown
  if (
    typeof cooldown === 'string' ||
    typeof cooldown === 'number' ||
    typeof cooldown === 'boolean'
  ) {
    parts.push(String(cooldown))
  }
  return parts.length ? parts.join(' · ') : null
}

function pushPresent(
  rows: Array<[string, React.ReactNode]>,
  label: string,
  value: unknown,
  format: (value: unknown) => React.ReactNode = String
) {
  if (value == null || value === '') return
  rows.push([label, format(value)])
}

function asRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function dash(value: unknown): string {
  if (value == null || value === '') return '—'
  return String(value)
}

function mono(value: unknown): React.ReactNode {
  return <span className='font-mono text-xs'>{String(value)}</span>
}

function fmtMs(value: unknown): string {
  if (value == null || value === '') return '—'
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value)
  return `${Math.round(n)}ms`
}
