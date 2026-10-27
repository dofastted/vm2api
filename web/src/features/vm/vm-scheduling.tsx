import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Vm, VmQuotaOverride, VmQuotaView } from '@/types/panel-vm'
import { SlidersHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { patchVm, type VmPatch } from '@/lib/api'
import { cn } from '@/lib/utils'
import { isCodexVm } from '@/lib/vm-kind'
import { seatTitle } from '@/lib/vm-status'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SEAT_CAP_MAX, SeatCells } from '@/components/scheduler-viz'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { ChipGroup } from '@/features/settings/scheduler-controls'
import { vmQueryOptions, vmsListQueryOptions } from '@/features/vm/queries'
import {
  CONC_STEPS,
  RATIO_STEPS,
  RPM_STEPS,
  SEAT_CAP_STEPS,
  withCurrent,
} from '@/features/vm/scheduling-steps'
import { useVmPerms } from '@/features/vm/vm-perms'

function shortSession(id: string) {
  if (id.length <= 18) return id
  return `${id.slice(0, 8)}…${id.slice(-4)}`
}

/** Sessions actually holding a slot on this VM, including sticky holds with no live request. */
function SeatSessionList({ sessions }: { sessions: Vm['seat_sessions'] }) {
  const rows = Array.isArray(sessions) ? [...sessions] : []
  if (!rows.length) return null
  rows.sort((a, b) => Number(a.index) - Number(b.index))
  return (
    <ul className='space-y-0.5 font-mono text-[10px] leading-4 text-muted-foreground'>
      {rows.map((seat) => (
        <li
          key={`${seat.index}:${seat.session_id}`}
          className='truncate'
          title={seat.session_id}
        >
          #{Number(seat.index)}{' '}
          {shortSession(String(seat.session_id || '')) || '—'}
          <span className='ms-1 font-sans'>
            {seat.state === 'active'
              ? '进行中'
              : seat.state === 'held'
                ? '粘性'
                : '占用'}
            {Number(seat.inflight) > 1 ? ` ×${seat.inflight}` : ''}
          </span>
        </li>
      ))}
    </ul>
  )
}

type Knob<T> = { own: boolean; value: T }
type QuotaKey = keyof VmQuotaView
type Draft = {
  seats: Knob<number>
  conc: Knob<number>
  rpm: Knob<number>
  sessions: Knob<number>
  /** 'auto' = 按 7D 重置倒计时自动算；数字 = 手动 1–10。 */
  level: 'auto' | number
  quota: Record<QuotaKey, Knob<number | boolean>>
  /** 工作时段；own=false = 跟随全局（24h 接单）。timezone 是已钉住的值，面板不改但要原样带回。 */
  hours: {
    own: boolean
    start: string
    end: string
    days: number[]
    timezone?: string
  }
}

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const DAY_LABELS = ['日', '一', '二', '三', '四', '五', '六']

const QUOTA_FIELDS: { key: QuotaKey; label: string; desc: string }[] = [
  { key: 'limit_5h', label: '5h 闸线', desc: '5h 用量到这里写成受限并切号' },
  { key: 'limit_7d', label: '7d 闸线', desc: '7d 用量到这里写成受限并切号' },
  { key: 'block_on_5h', label: '5h 闸生效', desc: '关掉后不按 5h 拦截' },
  { key: 'block_on_7d', label: '7d 闸生效', desc: '关掉后不按 7d 拦截' },
  {
    key: 'weekly_split',
    label: '周仓拆分',
    desc: '7d 一半留给 Fable（实验）',
  },
]

const LEVELS = Array.from({ length: 10 }, (_, i) => i + 1)

function isRatio(key: QuotaKey) {
  return key === 'limit_5h' || key === 'limit_7d'
}

function fmtQuota(key: QuotaKey, value: unknown): string {
  if (isRatio(key)) return `${Math.round(Number(value) * 100)}%`
  return value ? '开' : '关'
}

function draftOf(vm: Vm): Draft {
  const inherited = vm.scheduling_inherited
  const override = vm.quota_override || {}
  const quotaBase = vm.quota_inherited
  const quota = Object.fromEntries(
    QUOTA_FIELDS.map(({ key }) => {
      const own = override[key] != null
      const raw = own ? override[key] : quotaBase?.[key]
      const value = isRatio(key)
        ? Math.round(Number(raw ?? 0.85) * 100)
        : Boolean(raw)
      return [key, { own, value }]
    })
  ) as Draft['quota']
  return {
    seats: {
      own: vm.session_slots_override === true,
      value: Number(
        vm.session_slots ?? inherited?.session_slots ?? SEAT_CAP_MAX
      ),
    },
    conc: {
      own: vm.concurrency_override === true,
      value: Number(vm.max_concurrency ?? inherited?.max_concurrency ?? 2),
    },
    rpm: {
      own: vm.rpm_override === true,
      value: Number(vm.max_rpm ?? inherited?.max_rpm ?? 0),
    },
    sessions: {
      own: vm.max_sessions_override === true,
      value: Number(vm.max_sessions ?? inherited?.max_sessions ?? 0),
    },
    level:
      vm.schedule_level_mode === 'manual' && Number(vm.schedule_level) >= 1
        ? Number(vm.schedule_level)
        : 'auto',
    quota,
    hours: {
      own: !!vm.active_hours,
      start: vm.active_hours?.start || '08:00',
      end: vm.active_hours?.end || '22:00',
      days: vm.active_hours?.days?.length
        ? [...vm.active_hours.days]
        : ALL_DAYS,
      timezone: vm.active_hours?.timezone,
    },
  }
}

function sortedDays(days: number[]): number[] {
  return [...days].sort((a, b) => a - b)
}

function sameDays(a: number[], b: number[]): boolean {
  const x = sortedDays(a)
  const y = sortedDays(b)
  return x.length === y.length && x.every((v, i) => v === y[i])
}

function sameHours(a: Draft['hours'], b: Draft['hours']): boolean {
  if (a.own !== b.own) return false
  if (!a.own) return true
  return a.start === b.start && a.end === b.end && sameDays(a.days, b.days)
}

type DayPreset = 'all' | 'weekday' | 'weekend' | 'custom'

function dayPreset(days: number[]): DayPreset {
  if (sameDays(days, ALL_DAYS)) return 'all'
  if (sameDays(days, [1, 2, 3, 4, 5])) return 'weekday'
  if (sameDays(days, [0, 6])) return 'weekend'
  return 'custom'
}

const DAY_PRESET_DAYS: Record<Exclude<DayPreset, 'custom'>, number[]> = {
  all: ALL_DAYS,
  weekday: [1, 2, 3, 4, 5],
  weekend: [0, 6],
}

/** 只发生变化的字段；null = 去掉本槽覆盖。 */
function patchOf(vm: Vm, draft: Draft): VmPatch {
  const body: VmPatch = {}
  const before = draftOf(vm)
  const knob = (
    key: 'session_slots' | 'max_concurrency' | 'max_rpm' | 'max_sessions',
    next: Knob<number>,
    prev: Knob<number>
  ) => {
    if (next.own && (!prev.own || next.value !== prev.value)) {
      body[key] = next.value
    } else if (!next.own && prev.own) {
      body[key] = null
    }
  }
  if (!isCodexVm(vm)) knob('session_slots', draft.seats, before.seats)
  knob('max_concurrency', draft.conc, before.conc)
  knob('max_rpm', draft.rpm, before.rpm)
  if (isCodexVm(vm)) knob('max_sessions', draft.sessions, before.sessions)
  if (draft.level !== before.level) {
    body.schedule_level = draft.level === 'auto' ? null : draft.level
  }
  if (!sameHours(draft.hours, before.hours)) {
    body.active_hours = draft.hours.own
      ? {
          start: draft.hours.start,
          end: draft.hours.end,
          ...(draft.hours.timezone ? { timezone: draft.hours.timezone } : {}),
          ...(sameDays(draft.hours.days, ALL_DAYS)
            ? {}
            : { days: sortedDays(draft.hours.days) }),
        }
      : null
  }
  if (!isCodexVm(vm)) {
    const next: VmQuotaOverride = {}
    for (const { key } of QUOTA_FIELDS) {
      const k = draft.quota[key]
      if (!k.own) continue
      ;(next as Record<string, unknown>)[key] = isRatio(key)
        ? Number(k.value) / 100
        : k.value
    }
    const prev = vm.quota_override || {}
    const same = QUOTA_FIELDS.every(
      ({ key }) => (prev[key] ?? null) === (next[key] ?? null)
    )
    if (!same) body.quota_override = Object.keys(next).length ? next : null
  }
  return body
}

function overrideCount(vm: Vm): number {
  const quota = Object.values(vm.quota_override || {}).filter(
    (v) => v != null
  ).length
  return (
    quota +
    Number(vm.session_slots_override === true) +
    Number(vm.concurrency_override === true) +
    Number(vm.rpm_override === true) +
    Number(vm.max_sessions_override === true) +
    Number(!!vm.active_hours)
  )
}

function Tile({
  label,
  value,
  own,
  title,
}: {
  label: string
  value: React.ReactNode
  own?: boolean
  title?: string
}) {
  return (
    <div
      title={title}
      className={cn(
        'flex min-w-0 items-baseline justify-between gap-2 rounded border px-2 py-1 text-xs',
        own
          ? 'border-primary/40 bg-background'
          : 'border-border/70 bg-background/60'
      )}
    >
      <span className='truncate text-muted-foreground'>{label}</span>
      <span
        className={cn(
          'shrink-0 whitespace-nowrap tabular-nums',
          own && 'font-medium text-primary'
        )}
      >
        {value}
      </span>
    </div>
  )
}

/**
 * VM 内的「调度」块：席位、并发、RPM、调度等级与配额闸的生效值；
 * 本槽覆盖的项高亮，悬停看全局值，一个弹窗改全部。
 */
export function VmSchedulingBlock({
  vm,
  conc,
  rpm,
}: {
  vm: Vm
  conc?: { inf: number; max: number }
  rpm?: { n: number; max: number } | null
}) {
  const codex = isCodexVm(vm)
  const inherited = vm.scheduling_inherited
  const inf = conc?.inf ?? (Number(vm.inflight) || 0)
  const concMax = conc?.max ?? Number(vm.max_concurrency ?? 0)
  const rpmMax = rpm?.max ?? Number(vm.max_rpm ?? 0)
  const rpmNow = rpm?.n ?? (Number(vm.rpm) || 0)
  const seatsMax = Number(vm.seats_max ?? vm.session_slots ?? 0)
  const seatsUsed = Number(vm.seats_used) || 0
  const queued = Number(vm.queue_depth) || 0
  const custom = overrideCount(vm)
  const policy = vm.quota_policy
  const quotaOverride = vm.quota_override || {}
  const level = Number(vm.schedule_level)
  const canEdit = useVmPerms().admin

  return (
    <div className='space-y-2 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-2'>
      <div className='flex items-center justify-between gap-2'>
        <div className='min-w-0'>
          <div className='text-xs font-medium'>调度</div>
          <div
            className={cn(
              'text-[11px]',
              custom ? 'text-primary' : 'text-muted-foreground'
            )}
          >
            {custom ? `本槽覆盖 ${custom} 项` : '全部跟随全局'}
          </div>
        </div>
        {canEdit ? <VmSchedulingEditor vm={vm} /> : null}
      </div>

      {codex ? null : (
        <div className='space-y-1' title={seatTitle(vm)}>
          <div className='flex items-baseline justify-between gap-2 text-xs'>
            <span className='text-muted-foreground'>席位</span>
            <span className='tabular-nums'>
              {seatsUsed}/{seatsMax}
              {vm.seats_grace ? ` · 交接 ${vm.seats_grace}` : ''}
              {queued ? (
                <span className='text-[color:var(--status-warn)]'>
                  {' '}
                  · 排队 {queued}
                  {vm.conc_waiting ? `（等并发 ${vm.conc_waiting}）` : ''}
                </span>
              ) : null}
            </span>
          </div>
          <SeatCells
            used={seatsUsed}
            grace={Number(vm.seats_grace) || 0}
            max={seatsMax}
            size='sm'
          />
          <SeatSessionList sessions={vm.seat_sessions} />
        </div>
      )}

      <div className='grid grid-cols-2 gap-1.5'>
        <Tile
          label='并发'
          value={`${inf}/${concMax || '不限'}`}
          own={vm.concurrency_override}
          title={
            vm.concurrency_override
              ? `本槽钉住；${codex ? 'OpenAI 全局' : '分档'}值 ${inherited?.max_concurrency ?? '—'}`
              : codex
                ? '跟随 OpenAI 全局默认'
                : '跟随分档'
          }
        />
        <Tile
          label='RPM'
          value={rpmMax ? `${rpmNow}/${rpmMax}` : '不限'}
          own={vm.rpm_override}
          title={
            vm.rpm_override
              ? `本槽钉住；${codex ? 'OpenAI 全局' : '分档'}值 ${inherited?.max_rpm || '不限'}`
              : codex
                ? '跟随 OpenAI 全局默认'
                : '跟随分档'
          }
        />
        {codex ? null : (
          <Tile
            label='席位上限'
            value={vm.session_slots ?? '—'}
            own={vm.session_slots_override}
            title={
              vm.session_slots_override
                ? `本槽钉住；全局 ${inherited?.session_slots ?? '—'}`
                : '跟随全局'
            }
          />
        )}
        {codex ? (
          <Tile
            label='会话容量'
            value={vm.max_sessions ? vm.max_sessions : '不限'}
            own={vm.max_sessions_override}
            title={
              vm.max_sessions_override
                ? `本槽钉住；全局 ${inherited?.max_sessions ?? '不限'}`
                : '跟随 OpenAI 全局默认'
            }
          />
        ) : null}
        {!codex ? (
          <Tile
            label='调度等级'
            value={
              Number.isInteger(level)
                ? `${level} 级 · ${vm.schedule_level_mode === 'manual' ? '手动' : '自动'}`
                : '—'
            }
            own={vm.schedule_level_mode === 'manual'}
            title='等级高的 VM 先开席位；自动模式按 7D 重置倒计时算'
          />
        ) : null}
        <Tile
          label='工作时段'
          value={
            vm.active_hours_active === false
              ? '休息中'
              : vm.active_hours
                ? `${vm.active_hours.start}–${vm.active_hours.end}`
                : '全天'
          }
          own={!!vm.active_hours}
          title={
            vm.active_hours
              ? `${vm.active_hours_timezone || vm.timezone || 'UTC'}` +
                (vm.active_hours.days?.length
                  ? ` · 星期${vm.active_hours.days.map((d) => DAY_LABELS[d]).join('')}`
                  : ' · 每天') +
                (vm.active_hours_active === false
                  ? ' · 当前在窗口外，不接单'
                  : ' · 当前在窗口内')
              : '跟随全局：24h 接单'
          }
        />
        {codex || !policy
          ? null
          : QUOTA_FIELDS.map(({ key, label }) => (
              <Tile
                key={key}
                label={label}
                value={fmtQuota(key, policy[key])}
                own={quotaOverride[key] != null}
                title={
                  quotaOverride[key] != null
                    ? `全局 ${fmtQuota(key, vm.quota_inherited?.[key])}`
                    : '跟随全局'
                }
              />
            ))}
      </div>
    </div>
  )
}

function KnobRow({
  label,
  desc,
  inheritedText,
  own,
  onOwnChange,
  children,
  disabled,
}: {
  label: string
  desc?: string
  inheritedText: string
  own: boolean
  onOwnChange: (own: boolean) => void
  children: React.ReactNode
  disabled?: boolean
}) {
  return (
    <div
      className={cn(
        'space-y-2 rounded-lg border p-3 transition-colors duration-150',
        own ? 'border-primary/50 bg-primary/5' : 'bg-muted/20'
      )}
    >
      <div className='flex flex-wrap items-start justify-between gap-2'>
        <div className='min-w-0 space-y-0.5'>
          <Label>{label}</Label>
          {desc ? (
            <p className='text-[11px] leading-4 text-muted-foreground'>
              {desc}
            </p>
          ) : null}
        </div>
        <ChipGroup
          label={`${label}来源`}
          value={own ? 'own' : 'inherit'}
          options={[
            ['inherit', `跟随 · ${inheritedText}`],
            ['own', '本槽'],
          ]}
          onChange={(v) => onOwnChange(v === 'own')}
          disabled={disabled}
        />
      </div>
      {own ? children : null}
    </div>
  )
}

export function VmSchedulingEditor({ vm }: { vm: Vm }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(() => draftOf(vm))
  const codex = isCodexVm(vm)
  const inherited = vm.scheduling_inherited
  const quotaBase = vm.quota_inherited

  const save = useMutation({
    mutationFn: (body: VmPatch) => patchVm(vm.id, body),
    onSuccess: async () => {
      toast.success('调度配置已热更新')
      await Promise.all([
        qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      ])
      setOpen(false)
    },
    onError: (error: Error) => toast.error(error.message || '更新失败'),
  })

  const submit = () => {
    // 退格清掉一段时 <input type=time> 给出 ''；草稿留空，到这里再拦。
    if (
      draft.hours.own &&
      !(HHMM.test(draft.hours.start) && HHMM.test(draft.hours.end))
    ) {
      toast.error('请填写完整的开工与收工时间')
      return
    }
    if (draft.hours.own && draft.hours.start === draft.hours.end) {
      toast.error('开工与收工时间不能相同')
      return
    }
    if (draft.hours.own && !draft.hours.days.length) {
      toast.error('至少保留一个工作日')
      return
    }
    const body = patchOf(vm, draft)
    if (!Object.keys(body).length) {
      setOpen(false)
      return
    }
    save.mutate(body)
  }

  const setQuota = (key: QuotaKey, next: Partial<Knob<number | boolean>>) =>
    setDraft({
      ...draft,
      quota: { ...draft.quota, [key]: { ...draft.quota[key], ...next } },
    })

  const allInherit = () =>
    setDraft({
      ...draft,
      seats: { ...draft.seats, own: false },
      conc: { ...draft.conc, own: false },
      rpm: { ...draft.rpm, own: false },
      sessions: { ...draft.sessions, own: false },
      level: 'auto',
      hours: { ...draft.hours, own: false },
      quota: Object.fromEntries(
        QUOTA_FIELDS.map(({ key }) => [
          key,
          { ...draft.quota[key], own: false },
        ])
      ) as Draft['quota'],
    })

  const pending = save.isPending

  return (
    <>
      <Button
        size='sm'
        className='h-7 shrink-0 cursor-pointer gap-1 px-2.5 text-xs shadow-sm'
        onClick={() => {
          setDraft(draftOf(vm))
          setOpen(true)
        }}
      >
        <SlidersHorizontal className='size-3.5' aria-hidden />
        调度配置
      </Button>
      <Dialog open={open} onOpenChange={(v) => !pending && setOpen(v)}>
        <DialogContent className='max-h-[88vh] overflow-y-auto sm:max-w-2xl'>
          <DialogHeader>
            <DialogTitle>调度配置 · {vm.name || vm.id}</DialogTitle>
            <DialogDescription>
              只作用于本槽，热更新不重启。选「跟随」的项随 设置 → 账号池 / 配额
              变化；选「本槽」后全局保存不会改它。
            </DialogDescription>
          </DialogHeader>

          <div className='space-y-4'>
            <section className='space-y-2'>
              <h4 className='text-xs font-medium text-muted-foreground'>
                席位与流量
              </h4>
              {codex ? null : (
                <KnobRow
                  label='席位上限'
                  desc='本 VM 同时能占住的 client session 数。请求进行中占槽，对话结束即释放；粘性 TTL 只记住 VM，不占席位。同 session 的并发请求共用一个席位。'
                  inheritedText={String(inherited?.session_slots ?? '—')}
                  own={draft.seats.own}
                  onOwnChange={(own) =>
                    setDraft({ ...draft, seats: { ...draft.seats, own } })
                  }
                  disabled={pending}
                >
                  <ChipGroup
                    label='席位上限'
                    value={draft.seats.value}
                    options={withCurrent(
                      SEAT_CAP_STEPS.map((n): [number, string] => [
                        n,
                        String(n),
                      ]),
                      draft.seats.value
                    )}
                    onChange={(value) =>
                      setDraft({ ...draft, seats: { own: true, value } })
                    }
                    disabled={pending}
                  />
                  <SeatCells
                    used={Number(vm.seats_used) || 0}
                    grace={Number(vm.seats_grace) || 0}
                    max={draft.seats.value}
                  />
                </KnobRow>
              )}
              <KnobRow
                label='并发上限'
                desc={
                  codex
                    ? '同时在飞的 OpenAI 请求数；执行满时按账号池等待或借执行，保留会话绑定。'
                    : '同一时刻在飞的请求数；满了在本 VM 排队，不切号。'
                }
                inheritedText={
                  inherited ? String(inherited.max_concurrency || '不限') : '—'
                }
                own={draft.conc.own}
                onOwnChange={(own) =>
                  setDraft({ ...draft, conc: { ...draft.conc, own } })
                }
                disabled={pending}
              >
                <ChipGroup
                  label='并发上限'
                  value={draft.conc.value}
                  options={withCurrent(CONC_STEPS, draft.conc.value)}
                  onChange={(value) =>
                    setDraft({ ...draft, conc: { own: true, value } })
                  }
                  disabled={pending}
                />
              </KnobRow>
              {codex ? (
                <KnobRow
                  label='会话容量'
                  desc='每个 OpenAI 账号同时保留的活跃对话窗口；0 表示不限。'
                  inheritedText={
                    inherited ? String(inherited.max_sessions || '不限') : '—'
                  }
                  own={draft.sessions.own}
                  onOwnChange={(own) =>
                    setDraft({ ...draft, sessions: { ...draft.sessions, own } })
                  }
                  disabled={pending}
                >
                  <ChipGroup
                    label='会话容量'
                    value={draft.sessions.value}
                    options={withCurrent(
                      [0, 1, 2, 4, 8, 16, 32, 64, 128, 256].map(
                        (n): [number, string] => [
                          n,
                          n === 0 ? '不限' : String(n),
                        ]
                      ),
                      draft.sessions.value
                    )}
                    onChange={(value) =>
                      setDraft({
                        ...draft,
                        sessions: { own: true, value },
                      })
                    }
                    disabled={pending}
                  />
                </KnobRow>
              ) : null}
              <KnobRow
                label='RPM 上限'
                desc='每分钟请求数；满了排队等窗口，不切号。'
                inheritedText={
                  inherited ? String(inherited.max_rpm || '不限') : '—'
                }
                own={draft.rpm.own}
                onOwnChange={(own) =>
                  setDraft({ ...draft, rpm: { ...draft.rpm, own } })
                }
                disabled={pending}
              >
                <ChipGroup
                  label='RPM 上限'
                  value={draft.rpm.value}
                  options={withCurrent(RPM_STEPS, draft.rpm.value)}
                  onChange={(value) =>
                    setDraft({ ...draft, rpm: { own: true, value } })
                  }
                  disabled={pending}
                />
              </KnobRow>
              {!codex ? (
                <div className='space-y-2 rounded-lg border p-3'>
                  <div className='space-y-0.5'>
                    <Label>调度等级</Label>
                    <p className='text-[11px] leading-4 text-muted-foreground'>
                      等级高的 VM 先开新席位，同等级才看开席策略。自动 = 按 7D
                      重置倒计时算（1–7）；手动 1–10。
                    </p>
                  </div>
                  <ChipGroup
                    label='调度等级'
                    value={draft.level}
                    options={[
                      [
                        'auto',
                        vm.schedule_level_mode === 'auto' &&
                        Number.isInteger(Number(vm.schedule_level))
                          ? `自动（当前 ${vm.schedule_level}）`
                          : '自动',
                      ] as ['auto' | number, string],
                      ...LEVELS.map((n): ['auto' | number, string] => [
                        n,
                        String(n),
                      ]),
                    ]}
                    onChange={(level) => setDraft({ ...draft, level })}
                    disabled={pending}
                  />
                </div>
              ) : null}
              <KnobRow
                label='工作时段'
                desc='只在此时段内接单，窗口外此号不参与调度（模拟真人作息）。开始晚于结束 = 跨夜班次；时区跟随槽位。'
                inheritedText='全天'
                own={draft.hours.own}
                onOwnChange={(own) =>
                  setDraft({ ...draft, hours: { ...draft.hours, own } })
                }
                disabled={pending}
              >
                <div className='flex flex-wrap items-center gap-2'>
                  <Input
                    type='time'
                    aria-label='开工时间'
                    className='h-8 w-28'
                    value={draft.hours.start}
                    disabled={pending}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        hours: {
                          ...draft.hours,
                          start: event.target.value,
                        },
                      })
                    }
                  />
                  <span className='text-xs text-muted-foreground'>至</span>
                  <Input
                    type='time'
                    aria-label='收工时间'
                    className='h-8 w-28'
                    value={draft.hours.end}
                    disabled={pending}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        hours: {
                          ...draft.hours,
                          end: event.target.value,
                        },
                      })
                    }
                  />
                  <span className='text-[11px] text-muted-foreground'>
                    {vm.active_hours_timezone || vm.timezone || 'UTC'}
                  </span>
                </div>
                <ChipGroup
                  label='工作日预设'
                  value={dayPreset(draft.hours.days)}
                  options={[
                    ['all', '每天'],
                    ['weekday', '工作日'],
                    ['weekend', '周末'],
                    ['custom', '自定义'],
                  ]}
                  onChange={(preset) => {
                    if (preset === 'custom') return
                    setDraft({
                      ...draft,
                      hours: { ...draft.hours, days: DAY_PRESET_DAYS[preset] },
                    })
                  }}
                  disabled={pending}
                />
                <div className='flex flex-wrap gap-1.5'>
                  {DAY_LABELS.map((label, day) => {
                    const on = draft.hours.days.includes(day)
                    return (
                      <button
                        key={day}
                        type='button'
                        disabled={
                          pending || (on && draft.hours.days.length === 1)
                        }
                        onClick={() =>
                          setDraft({
                            ...draft,
                            hours: {
                              ...draft.hours,
                              days: on
                                ? draft.hours.days.filter((v) => v !== day)
                                : sortedDays([...draft.hours.days, day]),
                            },
                          })
                        }
                        className={cn(
                          'h-7 min-w-8 cursor-pointer rounded-md border px-2 text-xs transition-colors duration-150 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
                          on
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border bg-background text-muted-foreground hover:border-primary/50 hover:text-foreground'
                        )}
                      >
                        {label}
                      </button>
                    )
                  })}
                </div>
              </KnobRow>
            </section>

            {codex || !quotaBase ? null : (
              <section className='space-y-2'>
                <h4 className='text-xs font-medium text-muted-foreground'>
                  配额闸
                </h4>
                <div className='grid gap-2 sm:grid-cols-2'>
                  {QUOTA_FIELDS.map(({ key, label, desc }) => {
                    const k = draft.quota[key]
                    return (
                      <KnobRow
                        key={key}
                        label={label}
                        desc={desc}
                        inheritedText={fmtQuota(key, quotaBase[key])}
                        own={k.own}
                        onOwnChange={(own) => setQuota(key, { own })}
                        disabled={pending}
                      >
                        {isRatio(key) ? (
                          <ChipGroup
                            label={label}
                            value={Number(k.value)}
                            options={withCurrent(
                              RATIO_STEPS.map((p): [number, string] => [
                                p,
                                `${p}%`,
                              ]),
                              Number(k.value)
                            )}
                            onChange={(value) => setQuota(key, { value })}
                            disabled={pending}
                          />
                        ) : (
                          <ChipGroup
                            label={label}
                            value={k.value ? 'on' : 'off'}
                            options={[
                              ['on', '开'],
                              ['off', '关'],
                            ]}
                            onChange={(v) =>
                              setQuota(key, { value: v === 'on' })
                            }
                            disabled={pending}
                          />
                        )}
                      </KnobRow>
                    )
                  })}
                </div>
              </section>
            )}
          </div>

          <DialogFooter className='sm:justify-between'>
            <Button
              size='sm'
              variant='outline'
              className='cursor-pointer'
              disabled={pending}
              onClick={allInherit}
            >
              全部改回跟随
            </Button>
            <div className='flex gap-2'>
              <Button
                size='sm'
                variant='outline'
                className='cursor-pointer'
                disabled={pending}
                onClick={() => setOpen(false)}
              >
                取消
              </Button>
              <Button
                size='sm'
                className='cursor-pointer'
                disabled={pending}
                onClick={submit}
              >
                {pending ? '保存中…' : '保存'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
