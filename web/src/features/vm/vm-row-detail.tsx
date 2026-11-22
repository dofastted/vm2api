import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { UsageAccountRow } from '@/types/panel-usage'
import type { Vm } from '@/types/panel-vm'
import { fmtResetClock, resetCountdown } from '@/lib/fable-status'
import { fmtNum, fmtUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  fmtHealthPct,
  HEALTH_FG,
  healthSummary,
  SLOT_BG,
  SLOT_LABEL,
} from '@/lib/vm-health'
import {
  usageAccountForVm,
  vmCacheHitPct,
  vmCostLedger,
  vmTodayStats,
  vmWeekOutcome,
} from '@/lib/vm-usage'
import { Button } from '@/components/ui/button'
import { vmHealthQueryOptions, type VmHealthRange } from './queries'
import { riskFg } from './usage-meter'
import { VmQuotaActions, WindowBar } from './usage-windows'
import { vmWindows } from './vm-rack-model'
import { windowTiming } from './window-timing'

const CARD = 'min-w-0 rounded-lg border bg-card p-3'
const CARD_HEAD =
  'mb-2.5 flex items-baseline justify-between gap-2 text-xs font-semibold'
const CARD_NOTE = 'text-[11px] font-normal text-muted-foreground'
const KV_LABEL = 'text-[11px] text-muted-foreground'
const KV_VALUE = 'mt-0.5 block font-mono text-sm font-bold tabular-nums'

function fmtDur(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  const min = Math.max(0, Math.round(ms / 60_000))
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return min % 60 ? `${h}h${min % 60}m` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d${h % 24}h` : `${d}d`
}

function fmtClock(ms: number | null): string {
  return ms ? (fmtResetClock(new Date(ms).toISOString()) ?? '—') : '—'
}

function healthAxisMarks(range: VmHealthRange) {
  return range === '7d'
    ? [
        { label: '7 天前', at: 0 },
        { label: '5d', at: 2 / 7 },
        { label: '3d', at: 4 / 7 },
        { label: '1d', at: 6 / 7 },
        { label: '现在', at: 1 },
      ]
    : [
        { label: '24h 前', at: 0 },
        { label: '18h', at: 0.25 },
        { label: '12h', at: 0.5 },
        { label: '6h', at: 0.75 },
        { label: '现在', at: 1 },
      ]
}

export function HealthAxis({ range }: { range: VmHealthRange }) {
  return (
    <div className='relative mt-1 h-4 text-[10.5px] text-[color:var(--text-tertiary)]'>
      {healthAxisMarks(range).map((mark) => (
        <span
          key={mark.label}
          className='absolute whitespace-nowrap'
          style={{
            left: `${mark.at * 100}%`,
            transform:
              mark.at === 0
                ? undefined
                : mark.at === 1
                  ? 'translateX(-100%)'
                  : 'translateX(-50%)',
          }}
        >
          {mark.label}
        </span>
      ))}
    </div>
  )
}

function HealthCard({ vm }: { vm: Vm }) {
  const [range, setRange] = useState<VmHealthRange>('24h')
  const q = useQuery(vmHealthQueryOptions(vm.id, range))
  const slots = range === '7d' ? 84 : 48
  const slotMin = q.data?.slot_min ?? (range === '7d' ? 120 : 30)
  const s = healthSummary(q.data?.buckets ?? null, slots)
  const startMs = q.data ? Date.parse(q.data.start) : null
  return (
    <section className={CARD} aria-label='请求健康'>
      <div className={CARD_HEAD}>
        <span>请求健康</span>
        <span className='flex items-center gap-2'>
          <span className={CARD_NOTE}>按错误率着色 · 无请求不计</span>
          <span
            role='group'
            aria-label='健康时间范围'
            className='inline-flex overflow-hidden rounded-md border'
          >
            {(['24h', '7d'] as const).map((r) => (
              <button
                key={r}
                type='button'
                aria-pressed={range === r}
                onClick={() => setRange(r)}
                className={cn(
                  'px-2 py-0.5 text-[11px] font-medium transition-colors',
                  range === r
                    ? 'bg-foreground text-background'
                    : 'text-muted-foreground hover:bg-muted'
                )}
              >
                {r === '24h' ? '24h' : '近 7 天'}
              </button>
            ))}
          </span>
        </span>
      </div>
      {q.isPending ? (
        <div className='h-7 animate-pulse rounded bg-muted' />
      ) : q.isError ? (
        <div className='text-xs text-[color:var(--status-bad)]'>
          加载失败：{(q.error as Error).message}
        </div>
      ) : (
        <>
          <div className='flex h-7 gap-px' aria-label='请求健康时间线'>
            {s.slots.map((state, i) => (
              <span
                key={i}
                className='flex-1 rounded-[2px]'
                style={{ backgroundColor: SLOT_BG[state] }}
                title={`${startMs ? fmtClock(startMs + i * slotMin * 60_000) : ''} · ${SLOT_LABEL[state]}`}
              />
            ))}
          </div>
          <HealthAxis range={range} />
          <div className='mt-3 grid grid-cols-4 gap-2'>
            <div>
              <span className={KV_LABEL}>成功率</span>
              <b className={cn(KV_VALUE, HEALTH_FG[s.tone])}>
                {fmtHealthPct(s.pct)}
              </b>
            </div>
            <div>
              <span className={KV_LABEL}>请求</span>
              <b className={KV_VALUE}>{fmtNum(s.req)}</b>
            </div>
            <div>
              <span className={KV_LABEL}>失败</span>
              <b
                className={cn(
                  KV_VALUE,
                  s.err > 0 && 'text-[color:var(--status-bad)]'
                )}
              >
                {fmtNum(s.err)}
              </b>
            </div>
            <div>
              <span className={KV_LABEL}>有请求的时间段</span>
              <b className={KV_VALUE}>
                {fmtNum(s.active)} 段 · 每段{' '}
                {slotMin >= 60 ? `${slotMin / 60} 小时` : `${slotMin} 分钟`}
              </b>
            </div>
          </div>
          <div className='mt-3 border-t pt-2'>
            <div className={cn(KV_LABEL, 'mb-1 font-medium')}>主要错误</div>
            {q.data?.top_errors?.length ? (
              q.data.top_errors.map((e) => (
                <div
                  key={e.code}
                  className='grid grid-cols-[1fr_auto_auto] gap-3 py-0.5 text-[11.5px]'
                >
                  <span className='truncate font-mono'>
                    {e.status && String(e.status) !== e.code
                      ? `${e.status} `
                      : ''}
                    {e.code}
                  </span>
                  <span className='font-mono text-[color:var(--status-bad)] tabular-nums'>
                    × {fmtNum(e.count)}
                  </span>
                  <span className='font-mono text-muted-foreground tabular-nums'>
                    {fmtResetClock(e.last_at) ?? ''}
                  </span>
                </div>
              ))
            ) : (
              <div className='text-[11.5px] text-[color:var(--text-tertiary)]'>
                {s.req ? '该时段无失败请求' : '该时段无请求'}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  )
}

function WindowsCard({ vm, now }: { vm: Vm; now: number }) {
  const hasToken = Boolean(vm.has_token)
  return (
    <section className={CARD} aria-label='用量窗口明细'>
      <div className={CARD_HEAD}>
        <span>用量窗口</span>
        <span className={CARD_NOTE}>
          竖线 = 时间进度 · 节奏 = 用量% ÷ 时间%
        </span>
      </div>
      <div className='grid gap-3'>
        {vmWindows(vm).map((w) => {
          const t = windowTiming(w, now)
          const full = w.pct != null && w.pct >= 100
          return (
            <div key={w.key}>
              <div className='flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground'>
                <span>
                  <b className='text-foreground'>{w.label}</b>{' '}
                  {w.note ? (
                    <span className='text-[color:var(--status-warn)]'>
                      {w.note}
                    </span>
                  ) : (
                    <b
                      className={cn(
                        'font-mono tabular-nums',
                        w.pct == null
                          ? 'text-[color:var(--text-tertiary)]'
                          : riskFg(w.pct)
                      )}
                    >
                      {w.pct == null ? '未探测' : `${w.pct.toFixed(0)}%`}
                    </b>
                  )}
                </span>
                <span>
                  {full && hasToken ? (
                    <span className='text-[color:var(--status-bad)]'>
                      已满 · {resetCountdown(w.reset, now)}后恢复
                    </span>
                  ) : (
                    <>
                      {t.pace != null ? (
                        <>
                          节奏{' '}
                          <b
                            className={cn(
                              'font-mono tabular-nums',
                              t.pace >= 1.15 &&
                                'text-[color:var(--status-warn)]'
                            )}
                          >
                            {t.pace.toFixed(2)}×
                          </b>
                        </>
                      ) : null}
                      {t.fullInMs != null ? (
                        <span className='text-[color:var(--status-warn)]'>
                          {' '}
                          · 约 {fmtDur(t.fullInMs)} 用满
                        </span>
                      ) : null}
                    </>
                  )}
                </span>
              </div>
              {w.note ? null : (
                <>
                  <div className='my-1.5'>
                    <WindowBar w={w} timing={t} size='md' />
                  </div>
                  <div className='flex justify-between gap-2 font-mono text-[10.5px] text-muted-foreground tabular-nums'>
                    <span>{fmtClock(t.startMs)}</span>
                    <span>
                      时间已过{' '}
                      {t.elapsedPct == null
                        ? '—'
                        : `${t.elapsedPct.toFixed(0)}%`}
                    </span>
                    <span>
                      {t.resetMs ? `${fmtClock(t.resetMs)} 重置` : '—'}
                    </span>
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>
      <div className='mt-3 border-t pt-2.5'>
        <VmQuotaActions vm={vm} now={now} />
      </div>
    </section>
  )
}

function CostCard({ vm, accounts }: { vm: Vm; accounts?: UsageAccountRow[] }) {
  const acc = usageAccountForVm(vm, accounts) ?? vm
  const ledger = vmCostLedger(vm, accounts)
  const today = vmTodayStats(vm, accounts)
  const week = vmWeekOutcome(vm, accounts)
  const hit = vmCacheHitPct(vm, accounts)
  const rows: Array<{
    label: string
    req: number | null
    tokens: number
    cost: number
    total?: boolean
    note?: string
  }> = [
    {
      label: '今日 · 北京时间',
      req: today.req,
      tokens: today.tok,
      cost: today.today,
    },
    {
      label: '5H',
      req: Number(acc.window_5h_requests ?? 0) || null,
      tokens: ledger[0].tokens,
      cost: ledger[0].cost,
    },
    {
      label: '7 天额度窗口',
      req: week.req || null,
      tokens: ledger[1].tokens,
      cost: ledger[1].cost,
    },
    {
      label: ledger[2].label,
      note: ledger[2].note,
      req: null,
      tokens: ledger[2].tokens,
      cost: ledger[2].cost,
      total: true,
    },
  ]
  const perReq = week.req > 0 && week.cost > 0 ? week.cost / week.req : null
  return (
    <section className={CARD} aria-label='成本拆分'>
      <div className={CARD_HEAD}>
        <span>成本</span>
        <span className={CARD_NOTE}>官方价估算 · 网关外用量不计</span>
      </div>
      <table className='w-full text-xs'>
        <thead>
          <tr className='text-[11px] text-muted-foreground'>
            <th className='py-1 text-left font-medium' />
            <th className='py-1 text-right font-medium'>请求</th>
            <th className='py-1 text-right font-medium'>token</th>
            <th className='py-1 text-right font-medium'>花费</th>
          </tr>
        </thead>
        <tbody className='font-mono tabular-nums'>
          {rows.map((r) => (
            <tr
              key={r.label}
              className={cn(
                'border-t border-[color:var(--hairline)]',
                r.total && 'font-bold'
              )}
            >
              <td className='py-1 font-sans' title={r.note}>
                {r.label}
              </td>
              <td className='py-1 text-right'>
                {r.req == null ? '—' : fmtNum(r.req)}
              </td>
              <td className='py-1 text-right text-muted-foreground'>
                {r.tokens ? fmtNum(r.tokens) : '—'}
              </td>
              <td className='py-1 text-right'>
                {r.cost ? fmtUsd(r.cost, 2) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className='mt-3 grid grid-cols-3 gap-2 border-t pt-2.5'>
        <div>
          <span className={KV_LABEL}>7 天额度窗口 · 成功 / 失败</span>
          <b className={KV_VALUE}>
            <span className='text-[color:var(--status-ok)]'>
              {fmtNum(week.success)}
            </span>
            {' / '}
            <span
              className={
                week.fail ? 'text-[color:var(--status-bad)]' : undefined
              }
            >
              {week.known ? fmtNum(week.fail) : '—'}
            </span>
          </b>
        </div>
        <div>
          <span className={KV_LABEL}>每请求 · 7 天额度窗口</span>
          <b className={KV_VALUE}>
            {perReq == null ? '—' : `$${perReq.toFixed(3)}`}
          </b>
        </div>
        <div>
          <span className={KV_LABEL}>缓存命中 · 今日</span>
          <b className={KV_VALUE}>{hit == null ? '—' : `${hit.toFixed(0)}%`}</b>
        </div>
      </div>
    </section>
  )
}

/** 列表行展开区：请求健康 / 用量窗口 / 成本。 */
export function VmRowDetail({
  vm,
  accounts,
  now,
  onOpenDetail,
  id,
}: {
  vm: Vm
  accounts?: UsageAccountRow[]
  now: number
  onOpenDetail: () => void
  id: string
}) {
  return (
    <div
      id={id}
      role='region'
      aria-label={`${vm.id} 明细`}
      className='border-b border-border/40 bg-muted/40 py-3 pr-4 pl-12'
    >
      <div className='mb-2 flex justify-end'>
        <Button
          type='button'
          variant='link'
          size='sm'
          className='h-6 px-0 text-xs'
          onClick={onOpenDetail}
        >
          打开完整详情 →
        </Button>
      </div>
      <div className='grid gap-3 lg:grid-cols-[1.3fr_1fr_1.1fr]'>
        <HealthCard vm={vm} />
        <WindowsCard vm={vm} now={now} />
        <CostCard vm={vm} accounts={accounts} />
      </div>
    </div>
  )
}
