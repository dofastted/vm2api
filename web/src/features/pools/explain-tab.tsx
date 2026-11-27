import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type {
  SchedulerEventItem,
  SchedulerExplainResponse,
  SchedulerPool,
} from '@/types/panel-pools'
import {
  Activity,
  Dices,
  Pause,
  Play,
  Radio,
  SearchCode,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { apiKeysQueryOptions } from '@/features/keys/queries'
import {
  explainSchedule,
  startSchedulerEventsStream,
  type SchedulerStreamStatus,
} from './api'
import { formatAffinityWhy, formatExplainSummary } from './pool-rules'

const QUICK_MODELS = [
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'gpt-5.4',
  'gemini-2.5-pro',
]

function randomUuidV4(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID()
  }
  return '00000000-0000-4000-8000-000000000000'
}

const TONE_CLASS: Record<string, string> = {
  ok: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200',
  caution:
    'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200',
  warn: 'border-orange-500/40 bg-orange-500/10 text-orange-800 dark:text-orange-200',
  bad: 'border-destructive/40 bg-destructive/10 text-destructive',
  neutral: 'border-border bg-muted/40 text-foreground',
}

export function PoolExplainTab({ pool }: { pool: SchedulerPool }) {
  const keysQ = useQuery(apiKeysQueryOptions())
  const keys = useMemo(() => keysQ.data?.keys || [], [keysQ.data?.keys])

  const [apiKeyId, setApiKeyId] = useState('')
  const [model, setModel] = useState(
    pool.provider_scope === 'openai'
      ? 'gpt-5.4'
      : pool.provider_scope === 'google'
        ? 'gemini-2.5-pro'
        : 'claude-sonnet-4-6'
  )
  const [machineId, setMachineId] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [result, setResult] = useState<SchedulerExplainResponse | null>(null)

  const [paused, setPaused] = useState(false)
  const [onlyThisPool, setOnlyThisPool] = useState(true)
  const [streamStatus, setStreamStatus] =
    useState<SchedulerStreamStatus>('connecting')
  const [streamDetail, setStreamDetail] = useState<string>('')
  const [lastCursor, setLastCursor] = useState<string>('')
  const [events, setEvents] = useState<SchedulerEventItem[]>([])

  const explainMut = useMutation({
    mutationFn: () =>
      explainSchedule({
        pool_id: pool.id,
        ...(apiKeyId ? { api_key_id: apiKeyId } : {}),
        model: model.trim(),
        ...(machineId.trim() ? { machine_id: machineId.trim() } : {}),
        ...(sessionId.trim() ? { session_id: sessionId.trim() } : {}),
      }),
    onSuccess: (data) => {
      setResult(data)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  useEffect(() => {
    if (paused) {
      setStreamStatus('paused')
      return
    }
    const ctrl = new AbortController()
    const stop = startSchedulerEventsStream({
      poolId: onlyThisPool ? pool.id : undefined,
      signal: ctrl.signal,
      onStatus: (status, detail) => {
        setStreamStatus(status)
        setStreamDetail(detail || '')
      },
      onSnapshotRequired: () => {
        setStreamDetail('事件环已越窗，自动重新对齐游标')
      },
      onEvent: (event, nextCursor) => {
        if (nextCursor) setLastCursor(nextCursor)
        setEvents((prev) => [event, ...prev].slice(0, 120))
      },
    })
    return () => {
      ctrl.abort()
      stop()
    }
  }, [pool.id, paused, onlyThisPool])

  const formatted = useMemo(
    () => (result ? formatExplainSummary(result) : null),
    [result]
  )

  return (
    <div className='space-y-5'>
      {/* 模拟沙箱表单 */}
      <section className='space-y-4 rounded-xl border bg-card p-4'>
        <div>
          <h3 className='flex items-center gap-1.5 text-sm font-semibold'>
            <SearchCode className='size-4 text-primary' />
            决策模拟沙箱（Explain / Dry-Run）
          </h3>
          <p className='mt-0.5 text-xs text-muted-foreground'>
            调用{' '}
            <code className='font-mono'>POST /api/panel/scheduler/explain</code>
            ，纯只读零副作用：不占并发槽、不阻塞 SessionGate、不推进 SWRR
            游标、不落粘性。
          </p>
        </div>

        <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
          <div className='space-y-1.5'>
            <Label htmlFor='explain-key' className='text-xs'>
              API 密钥（可选）
            </Label>
            <Select
              value={apiKeyId || '__none__'}
              onValueChange={(v) => setApiKeyId(v === '__none__' ? '' : v)}
            >
              <SelectTrigger id='explain-key' className='h-8 text-xs'>
                <SelectValue placeholder='模拟管理员直达本池' />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='__none__'>
                  不指定 Key（按本池模拟）
                </SelectItem>
                {keys.map((k) => (
                  <SelectItem key={k.id} value={k.id}>
                    {k.name || k.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className='space-y-1.5'>
            <Label htmlFor='explain-model' className='text-xs'>
              目标模型 *
            </Label>
            <Input
              id='explain-model'
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder='claude-sonnet-4-6'
              className='h-8 font-mono text-xs'
            />
          </div>

          <div className='space-y-1.5'>
            <Label htmlFor='explain-machine' className='text-xs'>
              machine_id（可选）
            </Label>
            <Input
              id='explain-machine'
              value={machineId}
              onChange={(e) => setMachineId(e.target.value)}
              placeholder='dev-macbook-01'
              className='h-8 font-mono text-xs'
            />
          </div>

          <div className='space-y-1.5'>
            <Label htmlFor='explain-session' className='text-xs'>
              session_id（纯 UUIDv4，可选）
            </Label>
            <div className='flex items-center gap-1'>
              <Input
                id='explain-session'
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
                placeholder='xxxxxxxx-xxxx-4xxx-...'
                className='h-8 font-mono text-xs'
              />
              <Button
                type='button'
                size='sm'
                variant='outline'
                className='h-8 px-2'
                title='生成标准 UUIDv4'
                onClick={() => setSessionId(randomUuidV4())}
              >
                <Dices className='size-3.5' />
              </Button>
            </div>
          </div>
        </div>

        <div className='flex flex-wrap items-center justify-between gap-2'>
          <div className='flex flex-wrap items-center gap-1.5'>
            <span className='text-[11px] text-muted-foreground'>
              快捷模型：
            </span>
            {QUICK_MODELS.map((m) => (
              <button
                key={m}
                type='button'
                onClick={() => setModel(m)}
                className='cursor-pointer rounded border border-border bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-muted-foreground hover:border-primary/40 hover:text-foreground'
              >
                {m}
              </button>
            ))}
          </div>
          <Button
            type='button'
            size='sm'
            disabled={!model.trim() || explainMut.isPending}
            loading={explainMut.isPending}
            onClick={() => explainMut.mutate()}
          >
            <Play className='size-3.5' />
            运行模拟（Explain）
          </Button>
        </div>

        {/* 模拟结果可视化面板 */}
        {result && formatted ? (
          <div className='space-y-4 border-t pt-4'>
            {result.error ? (
              <Alert variant='destructive'>
                <AlertTitle>
                  模拟未选中节点（{result.error.code || 'pool_exhausted'}）
                </AlertTitle>
                <AlertDescription>{result.error.message}</AlertDescription>
              </Alert>
            ) : null}

            <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
              <div className='rounded-lg border p-3'>
                <div className='text-[11px] text-muted-foreground'>
                  命中分组池
                </div>
                <div className='mt-1 text-xs font-semibold'>
                  {formatted.resolvedPoolLabel}
                </div>
                {(result.fallback_chain || []).length > 1 ? (
                  <div className='mt-1 font-mono text-[10px] text-muted-foreground'>
                    链路：{(result.fallback_chain || []).join(' → ')}
                  </div>
                ) : null}
              </div>

              <div
                className={cn(
                  'rounded-lg border p-3',
                  TONE_CLASS[formatted.jevTone]
                )}
              >
                <div className='text-[11px] opacity-80'>JEV 前置策略</div>
                <div className='mt-1 text-xs font-semibold'>
                  {formatted.jevLabel}
                </div>
              </div>

              <div
                className={cn(
                  'rounded-lg border p-3',
                  TONE_CLASS[formatted.gateTone]
                )}
              >
                <div className='text-[11px] opacity-80'>SessionGate 状态</div>
                <div className='mt-1 text-xs font-semibold'>
                  {formatted.gateLabel}
                </div>
              </div>

              <div
                className={cn(
                  'rounded-lg border p-3',
                  TONE_CLASS[formatted.affinityTone]
                )}
              >
                <div className='text-[11px] opacity-80'>粘性裁决（why）</div>
                <div className='mt-1 text-xs font-semibold'>
                  {formatted.affinityLabel}
                </div>
              </div>
            </div>

            <div className='flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 px-3.5 py-2.5 text-xs'>
              <span>
                最终选中节点：
                <strong className='ml-1 font-mono'>
                  {formatted.selectedNodeLabel}
                </strong>
              </span>
              <span className='text-muted-foreground'>·</span>
              <span>
                Prompt 策略：<strong>{formatted.promptLabel}</strong>
              </span>
              {result.affinity?.preserve_machine_home ? (
                <Badge variant='outline' className='text-[10px]'>
                  保留原 machine_id 主绑定
                </Badge>
              ) : null}
              {result.affinity?.stood_in ? (
                <Badge variant='secondary' className='text-[10px]'>
                  stood_in 临时替补
                </Badge>
              ) : null}
            </div>

            {/* 排序队列 order */}
            <div className='space-y-2'>
              <div className='text-xs font-semibold'>
                入围排序（order · {formatted.orderCount}）
              </div>
              {(result.order || []).length === 0 ? (
                <p className='text-xs text-muted-foreground'>无入围候选节点</p>
              ) : (
                <div className='rounded-lg border'>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className='w-12'>#</TableHead>
                        <TableHead>节点</TableHead>
                        <TableHead>角色</TableHead>
                        <TableHead>有效等级</TableHead>
                        <TableHead>健康子桶</TableHead>
                        <TableHead>并发 / 负载</TableHead>
                        <TableHead>429 Sink</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(result.order || []).map((row, idx) => (
                        <TableRow
                          key={row.node_key}
                          className={cn(row.selected && 'bg-primary/5')}
                        >
                          <TableCell className='font-mono text-xs'>
                            {idx + 1}
                          </TableCell>
                          <TableCell className='font-mono text-xs'>
                            {row.name || row.node_key}
                            {row.selected ? (
                              <Badge
                                variant='default'
                                className='ml-1.5 text-[10px]'
                              >
                                选中
                              </Badge>
                            ) : null}
                          </TableCell>
                          <TableCell className='text-xs'>
                            {row.member_role || 'active'}
                          </TableCell>
                          <TableCell className='font-mono text-xs tabular-nums'>
                            T{row.effective_weight_tier ?? '—'}
                          </TableCell>
                          <TableCell className='text-xs'>
                            {row.sub_bucket === 0
                              ? '正常 (<85%)'
                              : row.sub_bucket === 1
                                ? '软配额预警 (85–95%)'
                                : row.sub_bucket === 2
                                  ? '429 下沉'
                                  : '—'}
                          </TableCell>
                          <TableCell className='font-mono text-xs tabular-nums'>
                            {row.inflight ?? 0}/{row.max_concurrency ?? '—'}
                            {row.load_ratio_bps != null
                              ? ` (${(row.load_ratio_bps / 100).toFixed(0)}%)`
                              : ''}
                          </TableCell>
                          <TableCell className='font-mono text-xs tabular-nums'>
                            {row.sink_seq || 0}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>

            {/* 淘汰列表 excluded */}
            <div className='space-y-2'>
              <div className='text-xs font-semibold'>
                淘汰节点与原因码（excluded · {formatted.excludedCount}）
              </div>
              {formatted.excludedItems.length === 0 ? (
                <p className='text-xs text-muted-foreground'>无被淘汰节点</p>
              ) : (
                <div className='grid gap-1.5 sm:grid-cols-2'>
                  {formatted.excludedItems.map((ex, i) => (
                    <div
                      key={`${ex.node_key}:${ex.reasonCode}:${i}`}
                      className='flex items-center justify-between gap-2 rounded-lg border bg-muted/20 px-3 py-2 text-xs'
                    >
                      <span className='truncate font-mono'>{ex.node_key}</span>
                      <span className='flex shrink-0 items-center gap-1.5'>
                        <Badge variant='outline' className='text-[10px]'>
                          {ex.reasonLabel}
                        </Badge>
                        <code className='text-[10px] text-muted-foreground'>
                          {ex.reasonCode}
                        </code>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </section>

      {/* SSE 实时路由事件流 */}
      <section className='space-y-3 rounded-xl border bg-card p-4'>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <div className='flex items-center gap-2'>
            <Radio
              className={cn(
                'size-4',
                streamStatus === 'connected'
                  ? 'text-[color:var(--status-ok)]'
                  : 'text-muted-foreground'
              )}
            />
            <h3 className='text-sm font-semibold'>实时路由决策流（SSE）</h3>
            <Badge variant='outline' className='text-[10px]'>
              {streamStatus === 'connected'
                ? '已连接'
                : streamStatus === 'paused'
                  ? '已暂停'
                  : streamStatus === 'unavailable'
                    ? '未就绪'
                    : '连接中…'}
            </Badge>
            {lastCursor ? (
              <span className='font-mono text-[10px] text-muted-foreground'>
                cursor {lastCursor}
              </span>
            ) : null}
          </div>

          <div className='flex flex-wrap items-center gap-2'>
            <Button
              type='button'
              size='sm'
              variant={onlyThisPool ? 'secondary' : 'outline'}
              className='h-7 text-xs'
              onClick={() => setOnlyThisPool((v) => !v)}
            >
              {onlyThisPool ? '仅本池事件' : '全平台事件'}
            </Button>
            <Button
              type='button'
              size='sm'
              variant='outline'
              className='h-7 text-xs'
              onClick={() => setPaused((v) => !v)}
            >
              {paused ? (
                <>
                  <Play className='size-3.5' />
                  恢复
                </>
              ) : (
                <>
                  <Pause className='size-3.5' />
                  暂停
                </>
              )}
            </Button>
            <Button
              type='button'
              size='sm'
              variant='ghost'
              className='h-7 text-xs'
              disabled={events.length === 0}
              onClick={() => setEvents([])}
            >
              <Trash2 className='size-3.5' />
              清空
            </Button>
          </div>
        </div>

        {streamDetail ? (
          <p className='text-xs text-muted-foreground'>{streamDetail}</p>
        ) : null}

        {events.length === 0 ? (
          <div className='flex items-center justify-center gap-2 rounded-lg border border-dashed py-8 text-xs text-muted-foreground'>
            <Activity className='size-4 opacity-50' />
            等待 <code className='font-mono'>
              /api/panel/scheduler/events
            </code>{' '}
            推送实时调度轨迹…
          </div>
        ) : (
          <div className='max-h-80 overflow-y-auto rounded-lg border'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>事件</TableHead>
                  <TableHead>节点 / 模型</TableHead>
                  <TableHead>粘性 / 结果</TableHead>
                  <TableHead className='text-right'>排队耗时</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((ev, idx) => {
                  const aff = ev.affinity_why
                    ? formatAffinityWhy(ev.affinity_why)
                    : null
                  const ts = ev.ts ? new Date(ev.ts).toLocaleTimeString() : '—'
                  return (
                    <TableRow key={ev.cursor || ev.id || `${idx}`}>
                      <TableCell className='font-mono text-[11px] text-muted-foreground tabular-nums'>
                        {ts}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant='outline'
                          className='font-mono text-[10px]'
                        >
                          {ev.type || 'route'}
                        </Badge>
                      </TableCell>
                      <TableCell className='font-mono text-xs'>
                        {ev.node_key || '—'}
                        {ev.model ? (
                          <span className='ml-1.5 text-muted-foreground'>
                            · {ev.model}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className='text-xs'>
                        {aff ? aff.label : ev.outcome || ev.message || '—'}
                      </TableCell>
                      <TableCell className='text-right font-mono text-xs tabular-nums'>
                        {ev.wait_ms != null ? `${ev.wait_ms}ms` : '—'}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  )
}
