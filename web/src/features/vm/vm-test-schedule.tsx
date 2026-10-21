import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { Clock3, Plus, Save, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { validTimezone } from '@/lib/timezone'
import { isCodexVm } from '@/lib/vm-kind'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
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
import { Textarea } from '@/components/ui/textarea'
import { meQueryOptions } from '@/features/auth/queries'
import { TimezonePicker } from '@/features/vm/timezone-picker'

type ScheduleFrequency = 'hourly' | 'daily' | 'weekly' | 'interval'

export type TestSchedule = {
  enabled: boolean
  frequency: ScheduleFrequency
  minute?: number
  time?: string
  weekdays?: number[]
  interval_minutes?: number
  jitter_min_minutes?: number
  jitter_max_minutes?: number
  timezone: string
  parse_error?: boolean
  model: string
  prompt: string
  /** All candidate prompts, `prompts[0] === prompt`; one is picked per run. */
  prompts?: string[]
  max_tokens: number | null
  reasoning_effort: string | null
  last_run_at: string | null
  last_ok: boolean | null
  last_duration_ms: number | null
  last_error: string | null
  next_run_at: string | null
  running: boolean
}

export type ScheduleStructure = Pick<
  TestSchedule,
  | 'frequency'
  | 'minute'
  | 'time'
  | 'weekdays'
  | 'interval_minutes'
  | 'jitter_min_minutes'
  | 'jitter_max_minutes'
  | 'timezone'
>

type SchedulePayload = { schedule: TestSchedule | null }
type DefaultPayload = { schedule: ScheduleStructure | null }
type SyncPayload = {
  updated: string[]
  missing: string[]
  schedule: ScheduleStructure
}

type TestParams = {
  vm: Vm
  models: { id: string }[]
  model: string
  prompt: string
  maxTokens: number
  reasoningEffort: string
  onPromptChange: (value: string) => void
  onLoadSchedule: (schedule: TestSchedule) => void
}

const WEEKDAY_OPTIONS = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 0, label: '周日' },
]

const MINUTES = Array.from({ length: 60 }, (_, i) => i)

function localTimezone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return validTimezone(tz) || 'Asia/Shanghai'
  } catch {
    return 'Asia/Shanghai'
  }
}

function defaultStructure(): ScheduleStructure {
  return { frequency: 'daily', time: '09:00', timezone: localTimezone() }
}

function formatAt(value: string | null, timezone: string) {
  if (!value) return '—'
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(value))
  } catch {
    return value
  }
}

function structureFromSchedule(
  schedule: TestSchedule | ScheduleStructure | null
) {
  if (!schedule) return defaultStructure()
  return {
    frequency: schedule.frequency || 'daily',
    minute: schedule.minute ?? 0,
    time: schedule.time || '09:00',
    weekdays: schedule.weekdays?.length ? schedule.weekdays : [1],
    interval_minutes: schedule.interval_minutes ?? 300,
    jitter_min_minutes: schedule.jitter_min_minutes ?? 0,
    jitter_max_minutes: schedule.jitter_max_minutes ?? 60,
    timezone: schedule.timezone || localTimezone(),
  }
}

/** Extra prompts beyond the main one, as stored. */
function extrasOf(schedule: TestSchedule | null) {
  return schedule?.prompts?.slice(1) ?? []
}

function cleanExtras(extras: string[]) {
  return extras.map((item) => item.trim()).filter(Boolean)
}

function sameList(a: string[], b: string[]) {
  return a.length === b.length && a.every((item, i) => item === b[i])
}

export type FormState = {
  enabled: boolean
  structure: ScheduleStructure
  model: string
  prompt: string
  /** Extra prompts picked at random together with `prompt`. */
  extraPrompts?: string[]
  maxTokens: number
  reasoningEffort: string
  codex: boolean
}

/**
 * A refreshed plan: unchanged → keep; form already shows it → track; form
 * untouched since the last load → adopt; user is editing → stale (warn, never overwrite).
 */
export function reconcileSchedule(
  form: FormState,
  base: TestSchedule | null,
  schedule: TestSchedule
): 'keep' | 'track' | 'adopt' | 'stale' {
  if (base && formShows(formFrom(base), schedule)) return 'keep'
  if (formShows(form, schedule)) return 'track'
  if (!base || formShows(form, base)) return 'adopt'
  return 'stale'
}

function formFrom(schedule: TestSchedule): FormState {
  return {
    enabled: schedule.enabled,
    structure: structureFromSchedule(schedule),
    model: schedule.model,
    prompt: schedule.prompt,
    extraPrompts: extrasOf(schedule),
    maxTokens: schedule.max_tokens ?? 0,
    reasoningEffort: schedule.reasoning_effort ?? '',
    codex: schedule.reasoning_effort != null,
  }
}

/** True when the form still shows exactly this stored plan. */
function formShows(form: FormState, schedule: TestSchedule) {
  return (
    form.enabled === schedule.enabled &&
    structureEqual(form.structure, structureFromSchedule(schedule)) &&
    form.model === schedule.model &&
    form.prompt.trim() === schedule.prompt &&
    sameList(cleanExtras(form.extraPrompts ?? []), extrasOf(schedule)) &&
    (form.codex
      ? form.reasoningEffort === schedule.reasoning_effort
      : form.maxTokens === schedule.max_tokens)
  )
}

function structureEqual(a: ScheduleStructure, b: ScheduleStructure) {
  if (a.frequency === 'interval' || b.frequency === 'interval') {
    return (
      a.frequency === b.frequency &&
      a.timezone === b.timezone &&
      a.time === b.time &&
      a.interval_minutes === b.interval_minutes &&
      a.jitter_min_minutes === b.jitter_min_minutes &&
      a.jitter_max_minutes === b.jitter_max_minutes
    )
  }
  return (
    a.frequency === b.frequency &&
    a.timezone === b.timezone &&
    (a.frequency !== 'hourly' || a.minute === b.minute) &&
    (a.frequency === 'hourly' ||
      (a.time === b.time &&
        (a.frequency !== 'weekly' ||
          JSON.stringify([...(a.weekdays || [])].sort()) ===
            JSON.stringify([...(b.weekdays || [])].sort()))))
  )
}

export function VmTestSchedule({
  vm,
  models,
  model,
  prompt,
  maxTokens,
  reasoningEffort,
  onPromptChange,
  onLoadSchedule,
}: TestParams) {
  const codex = isCodexVm(vm)
  const qc = useQueryClient()
  const me = useQuery(meQueryOptions())
  const isAdmin = me.data?.role === 'admin'
  const queryKey = ['panel', 'vm', vm.id, 'test-schedule'] as const
  const endpoint = `/api/panel/vms/${encodeURIComponent(vm.id)}/test-schedule`
  const loaded = useRef(false)
  // The stored plan the form was last filled from; later refreshes compare against it.
  const base = useRef<TestSchedule | null>(null)
  const [stale, setStale] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [structure, setStructure] =
    useState<ScheduleStructure>(defaultStructure)
  const [extras, setExtras] = useState<string[]>([])
  const [syncOpen, setSyncOpen] = useState(false)
  const [syncAllOpen, setSyncAllOpen] = useState(false)
  const scheduleQuery = useQuery({
    queryKey,
    queryFn: ({ queryKey: key, signal }) =>
      api<SchedulePayload>(
        `/api/panel/vms/${encodeURIComponent(key[2])}/test-schedule`,
        { signal }
      ),
    retry: false,
    // Another tab, another admin or "sync to all" may change this plan while it is open.
    refetchInterval: 30_000,
  })
  const defaultQuery = useQuery({
    queryKey: ['panel', 'test-schedule', 'default'] as const,
    queryFn: ({ signal }) =>
      api<DefaultPayload>('/api/panel/test-schedule/default', { signal }),
    retry: false,
  })
  const saved = scheduleQuery.data?.schedule || null

  const selectedModel = model || models[0]?.id || ''
  const form: FormState = {
    enabled,
    structure,
    model: selectedModel,
    prompt,
    extraPrompts: extras,
    maxTokens,
    reasoningEffort,
    codex,
  }
  const adopt = (schedule: TestSchedule) => {
    base.current = schedule
    setStale(false)
    setEnabled(schedule.enabled)
    setStructure(structureFromSchedule(schedule))
    setExtras(extrasOf(schedule))
    onLoadSchedule(schedule)
  }

  useEffect(() => {
    if (!scheduleQuery.data) return
    const schedule = scheduleQuery.data.schedule
    if (!loaded.current) {
      loaded.current = true
      if (schedule) adopt(schedule)
      else if (defaultQuery.data?.schedule) {
        setStructure(structureFromSchedule(defaultQuery.data.schedule))
      }
      return
    }
    if (!schedule) {
      base.current = null
      return
    }
    const action = reconcileSchedule(form, base.current, schedule)
    if (action === 'track') {
      base.current = schedule
      setStale(false)
    } else if (action === 'adopt') adopt(schedule)
    else if (action === 'stale') setStale(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run on new data, not on each keystroke
  }, [defaultQuery.data?.schedule, scheduleQuery.data])

  const savedStructure = useMemo(
    () => (saved ? structureFromSchedule(saved) : null),
    [saved]
  )
  const dirty = saved
    ? enabled !== saved.enabled ||
      !savedStructure ||
      !structureEqual(structure, savedStructure) ||
      selectedModel !== saved.model ||
      prompt.trim() !== saved.prompt ||
      !sameList(cleanExtras(extras), extrasOf(saved)) ||
      (codex
        ? reasoningEffort !== saved.reasoning_effort
        : maxTokens !== saved.max_tokens)
    : enabled ||
      !structureEqual(structure, defaultStructure()) ||
      cleanExtras(extras).length > 0
  const prompts = [prompt.trim(), ...cleanExtras(extras)]

  const save = useMutation({
    onMutate: () => qc.cancelQueries({ queryKey }),
    mutationFn: () =>
      api<SchedulePayload>(endpoint, {
        method: 'PUT',
        body: JSON.stringify({
          enabled,
          ...structure,
          model: selectedModel,
          prompt,
          prompts,
          ...(codex
            ? { reasoning_effort: reasoningEffort }
            : { max_tokens: maxTokens }),
        }),
      }),
    onSuccess: (data) => {
      qc.setQueryData(queryKey, data)
      if (data.schedule) {
        base.current = data.schedule
        setStale(false)
        setEnabled(data.schedule.enabled)
        setStructure(structureFromSchedule(data.schedule))
        setExtras(extrasOf(data.schedule))
        onPromptChange(data.schedule.prompt)
      }
      toast.success(
        data.schedule?.enabled ? '定时测试已启用' : '测试计划已保存'
      )
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => qc.invalidateQueries({ queryKey }),
  })
  const remove = useMutation({
    onMutate: () => qc.cancelQueries({ queryKey }),
    mutationFn: () => api<SchedulePayload>(endpoint, { method: 'DELETE' }),
    onSuccess: (data) => {
      qc.setQueryData(queryKey, data)
      base.current = null
      setStale(false)
      setEnabled(false)
      setStructure(defaultStructure())
      setExtras([])
      toast.success('测试计划已删除')
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => qc.invalidateQueries({ queryKey }),
  })
  const saveDefault = useMutation({
    mutationFn: () =>
      api<DefaultPayload>('/api/panel/test-schedule/default', {
        method: 'PUT',
        body: JSON.stringify({ schedule: structure }),
      }),
    onSuccess: (data) => {
      qc.setQueryData(['panel', 'test-schedule', 'default'], data)
      toast.success('已保存全局默认调度模板')
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const syncSchedule = useMutation({
    mutationFn: (scope: 'ids' | 'all') =>
      api<SyncPayload>('/api/panel/test-schedule/sync', {
        method: 'POST',
        body: JSON.stringify({
          scope,
          ...(scope === 'ids' ? { vm_ids: [vm.id] } : {}),
          schedule: structure,
          // "All slots" copies the whole scheduled test, switch included.
          ...(scope === 'all'
            ? {
                test: {
                  enabled,
                  model: selectedModel,
                  prompt: prompt.trim(),
                  prompts,
                  ...(codex
                    ? { reasoning_effort: reasoningEffort }
                    : { max_tokens: maxTokens }),
                },
              }
            : {}),
        }),
      }),
    onSuccess: (data, scope) => {
      toast.success(
        scope === 'all'
          ? `已把定时测试同步到 ${data.updated.length} 个槽`
          : `已覆盖 ${data.updated.length} 个槽的调度时间`
      )
      void qc.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === 'panel' &&
          query.queryKey[1] === 'vm' &&
          query.queryKey[3] === 'test-schedule',
      })
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => {
      setSyncOpen(false)
      setSyncAllOpen(false)
    },
  })
  const busy =
    save.isPending ||
    remove.isPending ||
    saveDefault.isPending ||
    syncSchedule.isPending

  const toggleWeekday = (value: number, checked: boolean) => {
    setStructure((prev) => {
      const set = new Set(prev.weekdays || [])
      if (checked) set.add(value)
      else set.delete(value)
      const weekdays = [...set].sort((a, b) => a - b)
      return { ...prev, weekdays: weekdays.length ? weekdays : [value] }
    })
  }

  return (
    <section className='space-y-3 border-t pt-3'>
      <div className='flex items-center justify-between gap-3'>
        <h3 className='flex items-center gap-1.5 text-sm font-medium'>
          <Clock3 className='size-4' /> 定时测试
        </h3>
        <div className='flex items-center gap-2'>
          {dirty && loaded.current ? (
            <span className='text-xs text-muted-foreground'>未保存</span>
          ) : null}
          <Switch
            aria-label='启用定时测试'
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={scheduleQuery.isPending || scheduleQuery.isError || busy}
          />
        </div>
      </div>

      {stale ? (
        <div
          className='flex items-center gap-2 text-xs text-amber-600'
          role='alert'
        >
          <span>此槽的计划已在别处修改，保存会覆盖它。</span>
          <Button
            size='sm'
            variant='ghost'
            onClick={() =>
              scheduleQuery.data?.schedule && adopt(scheduleQuery.data.schedule)
            }
          >
            载入最新
          </Button>
        </div>
      ) : null}

      {scheduleQuery.isPending ? (
        <p className='text-xs text-muted-foreground'>正在读取计划…</p>
      ) : scheduleQuery.isError ? (
        <div className='flex items-center gap-2 text-xs text-destructive'>
          <span role='alert'>计划读取失败：{scheduleQuery.error.message}</span>
          <Button
            size='sm'
            variant='ghost'
            onClick={() => void scheduleQuery.refetch()}
          >
            重试
          </Button>
        </div>
      ) : (
        <>
          {saved?.parse_error ? (
            <p className='text-xs text-destructive' role='alert'>
              已存计划无法识别为结构化调度，请重新选择频率与时间后保存。
            </p>
          ) : null}
          <div className='grid gap-3 sm:grid-cols-2'>
            <div className='space-y-1.5 sm:col-span-2'>
              <Label htmlFor={`vm-test-frequency-${vm.id}`}>频率</Label>
              <Select
                value={structure.frequency}
                onValueChange={(value: ScheduleFrequency) =>
                  setStructure((prev) => ({
                    ...prev,
                    frequency: value,
                    minute: prev.minute ?? 0,
                    time: prev.time || '09:00',
                    weekdays: prev.weekdays?.length ? prev.weekdays : [1],
                    interval_minutes: prev.interval_minutes ?? 300,
                    jitter_min_minutes: prev.jitter_min_minutes ?? 0,
                    jitter_max_minutes: prev.jitter_max_minutes ?? 60,
                  }))
                }
              >
                <SelectTrigger id={`vm-test-frequency-${vm.id}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='hourly'>每小时</SelectItem>
                  <SelectItem value='daily'>每天</SelectItem>
                  <SelectItem value='weekly'>每周</SelectItem>
                  <SelectItem value='interval'>间隔</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {structure.frequency === 'hourly' ? (
              <div className='space-y-1.5'>
                <Label htmlFor={`vm-test-minute-${vm.id}`}>分钟</Label>
                <Select
                  value={String(structure.minute ?? 0)}
                  onValueChange={(value) =>
                    setStructure((prev) => ({ ...prev, minute: Number(value) }))
                  }
                >
                  <SelectTrigger id={`vm-test-minute-${vm.id}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className='max-h-60'>
                    {MINUTES.map((minute) => (
                      <SelectItem key={minute} value={String(minute)}>
                        {minute === 0 ? '整点 (0)' : String(minute)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className='space-y-1.5'>
                <Label htmlFor={`vm-test-time-${vm.id}`}>
                  {structure.frequency === 'interval' ? '首次时刻' : '时刻'}
                </Label>
                <Input
                  id={`vm-test-time-${vm.id}`}
                  type='time'
                  value={structure.time || '09:00'}
                  onChange={(event) =>
                    setStructure((prev) => ({
                      ...prev,
                      time: event.target.value,
                    }))
                  }
                />
              </div>
            )}

            <div className='space-y-1.5'>
              <Label>时区</Label>
              <TimezonePicker
                value={structure.timezone}
                onChange={(timezone) =>
                  setStructure((prev) => ({ ...prev, timezone }))
                }
                className='w-full'
              />
              <p className='text-xs text-muted-foreground'>
                当前：{structure.timezone} · 真实调用会消耗额度
              </p>
            </div>

            {structure.frequency === 'interval' ? (
              <>
                <div className='space-y-1.5'>
                  <Label htmlFor={`vm-test-interval-${vm.id}`}>
                    间隔（分钟）
                  </Label>
                  <Input
                    id={`vm-test-interval-${vm.id}`}
                    type='number'
                    min={10}
                    max={10080}
                    value={structure.interval_minutes ?? 300}
                    onChange={(event) =>
                      setStructure((prev) => ({
                        ...prev,
                        interval_minutes: Number(event.target.value),
                      }))
                    }
                  />
                </div>
                <div className='space-y-1.5'>
                  <Label htmlFor={`vm-test-jitter-${vm.id}`}>
                    随机延迟（分钟）
                  </Label>
                  <div className='flex items-center gap-2'>
                    <Input
                      id={`vm-test-jitter-${vm.id}`}
                      type='number'
                      min={0}
                      max={1440}
                      aria-label='随机延迟下限（分钟）'
                      value={structure.jitter_min_minutes ?? 0}
                      onChange={(event) =>
                        setStructure((prev) => ({
                          ...prev,
                          jitter_min_minutes: Number(event.target.value),
                        }))
                      }
                    />
                    <span className='text-muted-foreground'>～</span>
                    <Input
                      type='number'
                      min={0}
                      max={1440}
                      aria-label='随机延迟上限（分钟）'
                      value={structure.jitter_max_minutes ?? 0}
                      onChange={(event) =>
                        setStructure((prev) => ({
                          ...prev,
                          jitter_max_minutes: Number(event.target.value),
                        }))
                      }
                    />
                  </div>
                </div>
                <p className='text-xs text-muted-foreground sm:col-span-2'>
                  首次在「首次时刻」运行；之后每次 = 上次实际运行 + 间隔 +
                  本轮随机延迟。
                </p>
              </>
            ) : null}

            {structure.frequency === 'weekly' ? (
              <div className='space-y-2 sm:col-span-2'>
                <Label>星期</Label>
                <div className='flex flex-wrap gap-3'>
                  {WEEKDAY_OPTIONS.map((day) => {
                    const checked = (structure.weekdays || []).includes(
                      day.value
                    )
                    return (
                      <label
                        key={day.value}
                        className='flex items-center gap-2 text-sm'
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(next) =>
                            toggleWeekday(day.value, next === true)
                          }
                        />
                        {day.label}
                      </label>
                    )
                  })}
                </div>
              </div>
            ) : null}
          </div>

          <div className='space-y-1.5'>
            <Label>备选题目</Label>
            {extras.map((item, index) => (
              <div key={index} className='flex items-start gap-2'>
                <Textarea
                  aria-label={`备选题目 ${index + 1}`}
                  className='min-h-9'
                  rows={1}
                  value={item}
                  onChange={(event) =>
                    setExtras((prev) =>
                      prev.map((value, i) =>
                        i === index ? event.target.value : value
                      )
                    )
                  }
                />
                <Button
                  size='icon'
                  variant='ghost'
                  className='size-8 shrink-0 text-muted-foreground'
                  aria-label={`删除备选题目 ${index + 1}`}
                  onClick={() =>
                    setExtras((prev) => prev.filter((_, i) => i !== index))
                  }
                >
                  <X />
                </Button>
              </div>
            ))}
            <div className='flex items-center gap-2'>
              <Button
                size='sm'
                variant='ghost'
                disabled={extras.length >= 19}
                onClick={() => setExtras((prev) => [...prev, ''])}
              >
                <Plus /> 添加题目
              </Button>
              <span className='text-xs text-muted-foreground'>
                每次从上方 Prompt 与备选题目里随机抽一道
              </span>
            </div>
          </div>

          <div className='flex flex-wrap items-center gap-2'>
            <Button
              size='sm'
              onClick={() => save.mutate()}
              disabled={
                busy ||
                !selectedModel ||
                !prompt.trim() ||
                (structure.frequency === 'weekly' &&
                  !(structure.weekdays || []).length)
              }
              loading={save.isPending}
            >
              <Save /> 保存计划
            </Button>
            {saved ? (
              <Button
                size='icon'
                variant='ghost'
                className='size-8 text-muted-foreground'
                aria-label='删除定时测试'
                title='删除定时测试'
                onClick={() => remove.mutate()}
                disabled={busy}
              >
                <Trash2 />
              </Button>
            ) : null}
            <Button
              size='sm'
              variant='outline'
              disabled={busy}
              onClick={() => setSyncOpen(true)}
            >
              同步到本槽
            </Button>
            <Button
              size='sm'
              variant='outline'
              disabled={busy || !selectedModel || !prompt.trim()}
              onClick={() => setSyncAllOpen(true)}
            >
              同步到全部槽
            </Button>
            {isAdmin ? (
              <Button
                size='sm'
                variant='ghost'
                disabled={busy}
                onClick={() => saveDefault.mutate()}
                loading={saveDefault.isPending}
              >
                保存为全局默认
              </Button>
            ) : null}
          </div>

          {saved ? (
            <div className='space-y-1 text-xs text-muted-foreground'>
              <p>
                当前计划：{saved.enabled ? '启用' : '暂停'} · {saved.model}
                {saved.running ? ' · 运行中' : ''}
              </p>
              <p>下次运行：{formatAt(saved.next_run_at, saved.timezone)}</p>
              <p>
                上次运行：{formatAt(saved.last_run_at, saved.timezone)}
                {saved.last_ok != null
                  ? ` · ${saved.last_ok ? '成功' : '失败'}`
                  : ''}
                {saved.last_duration_ms != null
                  ? ` · ${saved.last_duration_ms}ms`
                  : ''}
              </p>
              {saved.last_error ? (
                <p className='break-words text-destructive'>
                  {saved.last_error}
                </p>
              ) : null}
            </div>
          ) : (
            <p className='text-xs text-muted-foreground'>尚未创建计划</p>
          )}
        </>
      )}

      <AlertDialog open={syncOpen} onOpenChange={setSyncOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>同步调度时间？</AlertDialogTitle>
            <AlertDialogDescription>
              将把当前表单的调度时间（频率、时刻/分钟、星期、间隔、时区）覆盖写入本槽
              {saved ? '' : '（若无计划将创建且保持关闭）'}
              。不会修改 Prompt、模型、token/effort 或启用开关。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={syncSchedule.isPending}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={syncSchedule.isPending}
              onClick={(event) => {
                event.preventDefault()
                syncSchedule.mutate('ids')
              }}
            >
              覆盖写入
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={syncAllOpen} onOpenChange={setSyncAllOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>同步到全部槽？</AlertDialogTitle>
            <AlertDialogDescription>
              把本槽当前显示的定时测试整个覆盖到你有权限的全部槽（租户仅自己的槽）：
              开关（{enabled ? '启用' : '暂停'}
              ）、频率、时刻/分钟、星期、间隔、时区、模型、Prompt 与备选题目、
              {codex ? 'effort' : 'token 上限'}。不用先点保存。
              另一类槽（Claude/Codex 不同）只同步开关和时间，保留自己的模型与
              Prompt。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={syncSchedule.isPending}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={syncSchedule.isPending}
              onClick={(event) => {
                event.preventDefault()
                syncSchedule.mutate('all')
              }}
            >
              覆盖全部
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
