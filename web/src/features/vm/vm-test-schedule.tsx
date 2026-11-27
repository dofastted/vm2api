import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { Clock3, Save, Trash2 } from 'lucide-react'
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
import { meQueryOptions } from '@/features/auth/queries'
import { TimezonePicker } from '@/features/vm/timezone-picker'

type ScheduleFrequency = 'hourly' | 'daily' | 'weekly'

export type ScheduleMode = 'test' | 'preheat'

export type TestSchedule = {
  enabled: boolean
  mode?: ScheduleMode | string | null
  auto_renew?: boolean | null
  frequency: ScheduleFrequency
  minute?: number
  time?: string
  weekdays?: number[]
  timezone: string
  parse_error?: boolean
  model: string
  prompt: string
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
  | 'timezone'
  | 'mode'
  | 'auto_renew'
>

export function scheduleModeFrom(
  value: string | null | undefined
): ScheduleMode {
  return value === 'preheat' ? 'preheat' : 'test'
}

export function scheduleAutoRenewFrom(
  schedule:
    { mode?: string | null; auto_renew?: boolean | null } | null | undefined
): boolean {
  return (
    scheduleModeFrom(schedule?.mode) === 'preheat' &&
    schedule?.auto_renew === true
  )
}

/** Payload shape for save/sync/default; auto_renew is only true in preheat mode. */
export function scheduleModePayload(
  mode: ScheduleMode,
  autoRenew: boolean
): { mode: ScheduleMode; auto_renew: boolean } {
  return { mode, auto_renew: mode === 'preheat' && autoRenew }
}

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
    timezone: schedule.timezone || localTimezone(),
  }
}

export type FormState = {
  enabled: boolean
  structure: ScheduleStructure
  mode: ScheduleMode
  autoRenew: boolean
  model: string
  prompt: string
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
  const mode = scheduleModeFrom(schedule.mode)
  return {
    enabled: schedule.enabled,
    structure: structureFromSchedule(schedule),
    mode,
    autoRenew: scheduleAutoRenewFrom(schedule),
    model: schedule.model,
    prompt: schedule.prompt,
    maxTokens: schedule.max_tokens ?? 0,
    reasoningEffort: schedule.reasoning_effort ?? '',
    codex: schedule.reasoning_effort != null,
  }
}

/** True when the form still shows exactly this stored plan. */
function formShows(form: FormState, schedule: TestSchedule) {
  const mode = scheduleModeFrom(schedule.mode)
  return (
    form.enabled === schedule.enabled &&
    form.mode === mode &&
    form.autoRenew === scheduleAutoRenewFrom(schedule) &&
    structureEqual(form.structure, structureFromSchedule(schedule)) &&
    form.model === schedule.model &&
    form.prompt.trim() === schedule.prompt &&
    (form.codex
      ? form.reasoningEffort === schedule.reasoning_effort
      : form.maxTokens === schedule.max_tokens)
  )
}

function structureEqual(a: ScheduleStructure, b: ScheduleStructure) {
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
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>('test')
  const [autoRenew, setAutoRenew] = useState(false)
  const [structure, setStructure] =
    useState<ScheduleStructure>(defaultStructure)
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
    mode: scheduleMode,
    autoRenew,
    model: selectedModel,
    prompt,
    maxTokens,
    reasoningEffort,
    codex,
  }
  const modeFields = scheduleModePayload(scheduleMode, autoRenew)
  const adopt = (schedule: TestSchedule) => {
    base.current = schedule
    setStale(false)
    setEnabled(schedule.enabled)
    setStructure(structureFromSchedule(schedule))
    setScheduleMode(scheduleModeFrom(schedule.mode))
    setAutoRenew(scheduleAutoRenewFrom(schedule))
    onLoadSchedule(schedule)
  }

  useEffect(() => {
    if (!scheduleQuery.data) return
    const schedule = scheduleQuery.data.schedule
    if (!loaded.current) {
      loaded.current = true
      if (schedule) adopt(schedule)
      else if (defaultQuery.data?.schedule) {
        const template = defaultQuery.data.schedule
        setStructure(structureFromSchedule(template))
        setScheduleMode(scheduleModeFrom(template.mode))
        setAutoRenew(scheduleAutoRenewFrom(template))
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
      scheduleMode !== scheduleModeFrom(saved.mode) ||
      autoRenew !== scheduleAutoRenewFrom(saved) ||
      !savedStructure ||
      !structureEqual(structure, savedStructure) ||
      selectedModel !== saved.model ||
      prompt.trim() !== saved.prompt ||
      (codex
        ? reasoningEffort !== saved.reasoning_effort
        : maxTokens !== saved.max_tokens)
    : enabled ||
      scheduleMode !== 'test' ||
      autoRenew ||
      !structureEqual(structure, defaultStructure())

  const save = useMutation({
    onMutate: () => qc.cancelQueries({ queryKey }),
    mutationFn: () =>
      api<SchedulePayload>(endpoint, {
        method: 'PUT',
        body: JSON.stringify({
          enabled,
          ...structure,
          ...modeFields,
          model: selectedModel,
          prompt,
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
        setScheduleMode(scheduleModeFrom(data.schedule.mode))
        setAutoRenew(scheduleAutoRenewFrom(data.schedule))
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
      setScheduleMode('test')
      setAutoRenew(false)
      setStructure(defaultStructure())
      toast.success('测试计划已删除')
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => qc.invalidateQueries({ queryKey }),
  })
  const saveDefault = useMutation({
    mutationFn: () =>
      api<DefaultPayload>('/api/panel/test-schedule/default', {
        method: 'PUT',
        body: JSON.stringify({
          schedule: { ...structure, ...modeFields },
        }),
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
          schedule: { ...structure, ...modeFields },
          // "All slots" copies the whole scheduled test, switch included.
          ...(scope === 'all'
            ? {
                test: {
                  enabled,
                  model: selectedModel,
                  prompt: prompt.trim(),
                  ...modeFields,
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
                <Label htmlFor={`vm-test-time-${vm.id}`}>时刻</Label>
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

            <div className='space-y-1.5 sm:col-span-2'>
              <Label htmlFor={`vm-test-mode-${vm.id}`}>运行模式</Label>
              <Select
                value={scheduleMode}
                onValueChange={(value: ScheduleMode) => {
                  setScheduleMode(value)
                  if (value !== 'preheat') setAutoRenew(false)
                }}
              >
                <SelectTrigger id={`vm-test-mode-${vm.id}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='test'>定时测试</SelectItem>
                  <SelectItem value='preheat'>窗口续热</SelectItem>
                </SelectContent>
              </Select>
              <p className='text-xs text-muted-foreground'>
                续热模式在官方窗口已用尽时发一笔极小真实请求，窗口仍活跃时跳过。
              </p>
            </div>

            <div className='space-y-2 sm:col-span-2'>
              <label className='flex items-center gap-2 text-sm'>
                <Checkbox
                  checked={autoRenew}
                  disabled={scheduleMode !== 'preheat'}
                  onCheckedChange={(next) => setAutoRenew(next === true)}
                />
                5 小时窗口结束后自动续热
              </label>
              <p className='text-xs text-muted-foreground'>
                仅「窗口续热」可启用；关闭后只按上方 cron 触发。
              </p>
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
                当前计划：{saved.enabled ? '启用' : '暂停'} ·{' '}
                {scheduleModeFrom(saved.mode) === 'preheat' ? '续热' : '测试'} ·{' '}
                {saved.model}
                {scheduleAutoRenewFrom(saved) ? ' · 自动续热' : ''}
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
              将把当前表单的调度时间（频率、时刻/分钟、星期、时区）及运行模式、自动续热覆盖写入本槽
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
              ）、频率、时刻/分钟、星期、时区、运行模式、自动续热、模型、Prompt、
              {codex ? 'effort' : 'token 上限'}。不用先点保存。
              另一类槽（Claude/Codex 不同）保留自己的模型与
              Prompt，但仍同步开关、时间，以及本表单显式提供的运行模式与自动续热。
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
