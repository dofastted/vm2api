import { useState } from 'react'
import {
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { Vm, VmSeedSettings } from '@/types/panel-vm'
import { ArrowRight, ChevronRight, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { api, isApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { isCodexVm, slotNameLabel } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { routingQueryOptions } from '@/features/settings/queries'
import {
  ChipGroup,
  StepperSetting,
} from '@/features/settings/scheduler-controls'
import {
  amountIn,
  intervalLabel,
  secondsFrom,
  unitBounds,
  unitOf,
  UPLOAD_INTERVAL_PRESETS,
  type IntervalUnit,
} from '@/features/settings/telemetry-interval'
import {
  LIVE_ORDER,
  slotState,
  type LiveKey,
  type SlotState,
} from '@/features/settings/telemetry-slot-state'
import {
  relativeAgo,
  summarizeUploads,
  type UploadEntry,
} from '@/features/settings/telemetry-upload-log'
import {
  vmQueryOptions,
  vmSeedUploadLogQueryOptions,
} from '@/features/vm/queries'
import { seedSaveState } from '@/features/vm/seed-settings'
import { telemetrySeedFlags } from '@/features/vm/telemetry-policy'

const LIVE: Record<LiveKey, { legend: string; swatch: string; text: string }> =
  {
    live: {
      legend: '上传中',
      swatch: 'bg-primary',
      text: 'text-primary',
    },
    idle: {
      legend: '开 · 原生就绪',
      swatch: 'bg-[var(--status-caution-solid)]',
      text: 'text-[var(--status-caution)]',
    },
    policy: {
      legend: 'CRAG 已开 · 未验证上传',
      swatch: 'bg-[var(--status-caution-solid)]',
      text: 'text-[var(--status-caution)]',
    },
    blocked: {
      legend: '等待或失败',
      swatch: 'bg-[var(--status-warn-solid)]',
      text: 'text-[var(--status-warn)]',
    },
    parked: {
      legend: '槽已停 · 待确认',
      swatch: 'bg-[var(--ok-2)]',
      text: 'text-muted-foreground',
    },
    unknown: {
      legend: '原生状态待确认',
      swatch: 'bg-[var(--status-none)]',
      text: 'text-muted-foreground',
    },
    off: {
      legend: '关',
      swatch: 'bg-[var(--track)]',
      text: 'text-muted-foreground',
    },
  }

/** Desired policy is saved separately from publication and native acknowledgment. */
async function writeTelemetry(id: string, enabled: boolean) {
  return api<VmSeedSettings>(
    `/api/panel/vms/${encodeURIComponent(id)}/seed-settings`,
    { method: 'PUT', body: JSON.stringify(telemetrySeedFlags(enabled)) }
  )
}

async function refreshAfterWrite(qc: QueryClient, ids: string[]) {
  await Promise.all([
    qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
    qc.invalidateQueries({ queryKey: ['panel', 'vms'] }),
    ...ids.map((id) => qc.invalidateQueries({ queryKey: ['panel', 'vm', id] })),
  ])
}

const CONTRACT: { file: string; key: string; on: string; off: string }[] = [
  {
    file: 'settings.json · env',
    key: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    on: 'CRAG 不写；其他 "1"',
    off: '"0"',
  },
  {
    file: 'settings.json · env',
    key: 'DISABLE_TELEMETRY',
    on: '不写',
    off: '"1"',
  },
  {
    file: 'settings.json · env',
    key: 'CLAUDE_CODE_DISABLE_TELEMETRY（CRAG）',
    on: '不写',
    off: '"1"',
  },
  {
    file: 'settings.json · env',
    key: 'DO_NOT_TRACK',
    on: '不写',
    off: '"1"',
  },
  {
    file: 'settings.json · env',
    key: 'CLAUDE_CODE_USE_BEDROCK / VERTEX',
    on: '"0"',
    off: '"0"',
  },
  {
    file: 'settings.json',
    key: 'grove_enabled',
    on: 'false',
    off: 'false',
  },
  {
    file: 'kin-seed.json',
    key: 'telemetry',
    on: 'enabled',
    off: 'disabled',
  },
  {
    file: 'kin-seed.json',
    key: 'seed_policy.telemetry_disabled',
    on: 'false',
    off: 'true',
  },
]

function pipeline(interval: number): { title: string; body: string }[] {
  return [
    {
      title: '播种',
      body: 'cli-node 热读；CRAG 必要时排空并重启内核，随后复验并恢复调度。停机槽只发布设置。',
    },
    {
      title: '身份',
      body: '只读取当前 VM 的凭证、settings、身份和系统特征；有效票据与新鲜出口信息齐备后才可发送。',
    },
    {
      title: '上传',
      body: `必要原生 1P 事件每 ${intervalLabel(interval)} 合批；无额外 GrowthBook 实验事件或 Datadog 上传。`,
    },
    {
      title: '静默',
      body: '无事件不发空批。缺票据或出口信息就暂存；关闭立即清队列，换出口丢弃旧出口事件。',
    },
  ]
}

function IntervalSetting({
  value,
  onChange,
}: {
  value: number
  onChange: (seconds: number) => void
}) {
  const [unit, setUnit] = useState<IntervalUnit>(() => unitOf(value))
  const [min, max] = unitBounds(unit)
  const switchUnit = (next: IntervalUnit) => {
    setUnit(next)
    const seconds = secondsFrom(amountIn(value, next), next)
    if (seconds !== value) onChange(seconds)
  }
  return (
    <div className='space-y-3 border-t border-[var(--hairline)] pt-4'>
      <StepperSetting
        id='telemetry-upload-interval'
        label='上传间隔'
        desc={
          <>
            仅适用
            cli-node：有待发事件时才合批，缺有效凭证或当前出口信息时暂停上传。
          </>
        }
        value={amountIn(value, unit)}
        min={min}
        max={max}
        unit={unit === 'hour' ? '小时' : '分钟'}
        onChange={(amount) => onChange(secondsFrom(amount, unit))}
      />
      <div className='flex flex-wrap items-center justify-between gap-x-4 gap-y-2'>
        <ChipGroup
          label='常用间隔'
          value={value}
          options={UPLOAD_INTERVAL_PRESETS}
          onChange={(seconds) => {
            setUnit(unitOf(seconds))
            onChange(seconds)
          }}
        />
        <ChipGroup<IntervalUnit>
          label='单位'
          value={unit}
          options={[
            ['min', '分钟'],
            ['hour', '小时'],
          ]}
          onChange={switchUnit}
        />
      </div>
    </div>
  )
}

export function TelemetryPane({
  interval,
  defaultEnabled,
  onIntervalChange,
  onDefaultEnabledChange,
}: {
  interval: number
  defaultEnabled: boolean
  onIntervalChange: (seconds: number) => void
  onDefaultEnabledChange: (enabled: boolean) => void
}) {
  const qc = useQueryClient()
  const dash = useQuery(dashboardQueryOptions())
  const routing = useQuery(routingQueryOptions())
  const vms: Vm[] = dash.data?.vms || []
  const claude = vms.filter((vm) => !isCodexVm(vm))
  const codexCount = vms.length - claude.length
  // A saved opt-out is not proof that the VM stopped its sender.
  const probed = claude
  const details = useQueries({
    queries: probed.map((vm) => ({
      ...vmQueryOptions(vm.id),
      refetchInterval: 20_000,
      refetchOnWindowFocus: false,
    })),
  })
  const detailById = new Map(probed.map((vm, i) => [vm.id, details[i]]))
  const slots = claude.map((vm) => slotState(vm, detailById.get(vm.id)))
  const targetsFor = (enabled: boolean) =>
    slots
      .filter(
        (slot) =>
          slot.on !== enabled || (!slot.confirmed && slot.live !== 'parked')
      )
      .map((slot) => slot.vm)

  const [busy, setBusy] = useState<Set<string>>(() => new Set())
  const [bulk, setBulk] = useState<{
    enabled: boolean
    done: number
    total: number
    current: string
  } | null>(null)
  const [confirm, setConfirm] = useState<boolean | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const setOne = async (vm: Vm, enabled: boolean) => {
    setBusy((cur) => new Set(cur).add(vm.id))
    try {
      const result = await writeTelemetry(vm.id, enabled)
      const state = seedSaveState(result)
      if (state === 'applied')
        toast.success(`${vm.id} 原生已确认${enabled ? '开启' : '关闭'}`)
      else if (state === 'published')
        toast.info(`${vm.id} 文件已发布，等待 VM 确认`)
      else if (state === 'unsupported')
        toast.warning(`${vm.id} 此运行环境不支持 VM 原生遥测`)
      else toast.warning(`${vm.id} 已保存，生效状态尚未确认`)
    } catch (error) {
      const state = seedSaveState(isApiError(error) ? error.data : null)
      const message = error instanceof Error ? error.message : String(error)
      if (state !== 'unknown')
        toast.warning(`${vm.id} 已保存，发布或原生确认失败：${message}`)
      else toast.error(`${vm.id} 写入失败：${message}`)
    } finally {
      await refreshAfterWrite(qc, [vm.id])
      setBusy((cur) => {
        const next = new Set(cur)
        next.delete(vm.id)
        return next
      })
    }
  }

  const runBulk = async (enabled: boolean) => {
    const targets = targetsFor(enabled)
    setConfirm(null)
    if (!targets.length) return
    const failed: string[] = []
    const pending: string[] = []
    for (const [index, vm] of targets.entries()) {
      setBulk({ enabled, done: index, total: targets.length, current: vm.id })
      try {
        if (seedSaveState(await writeTelemetry(vm.id, enabled)) !== 'applied')
          pending.push(vm.id)
      } catch (error) {
        if (seedSaveState(isApiError(error) ? error.data : null) !== 'unknown')
          pending.push(vm.id)
        else failed.push(vm.id)
      }
    }
    setBulk(null)
    await refreshAfterWrite(
      qc,
      targets.map((vm) => vm.id)
    )
    const confirmed = targets.length - failed.length - pending.length
    const verb = enabled ? '开启' : '关闭'
    if (failed.length) {
      toast.error(
        `原生确认${verb} ${confirmed} 槽，待确认 ${pending.length}，写入失败 ${failed.length}：${failed.join('、')}`
      )
    } else if (pending.length) {
      toast.warning(
        `原生确认${verb} ${confirmed} 槽；已保存但未确认：${pending.join('、')}`
      )
    } else {
      toast.success(`原生确认${verb} ${confirmed} 槽`)
    }
  }

  const counts = LIVE_ORDER.map(
    (key) => [key, slots.filter((s) => s.live === key).length] as const
  )
  const onCount = slots.filter((s) => s.on).length
  const toEnable = targetsFor(true).length
  const toDisable = targetsFor(false).length
  const pendingTargets = confirm === null ? [] : targetsFor(confirm)
  const pendingRunning = pendingTargets.filter(
    (vm) => vm.status === 'running'
  ).length
  const pendingRemote = pendingTargets.filter((vm) => vm.node_id).length
  const fetching = dash.isFetching || details.some((d) => d.isFetching)
  const steps = pipeline(interval)
  const official = routing.data?.official_cc as
    { sync_telemetry?: boolean } | undefined
  const codex = routing.data?.codex as
    { analytics?: { enabled?: boolean } } | undefined

  return (
    <div className='space-y-3'>
      <Card className='gap-5'>
        <CardHeader className='flex flex-wrap items-start justify-between gap-x-6 gap-y-3'>
          <div className='min-w-0 space-y-1.5'>
            <CardTitle className='text-base'>遥测</CardTitle>
            <p className='max-w-[68ch] text-sm text-muted-foreground'>
              每个 Claude 槽只有一个开关。写入{' '}
              <code className='font-mono text-xs text-foreground'>
                telemetry_disabled === false
              </code>{' '}
              才算开，缺这个值也是关。把{' '}
              <code className='font-mono text-xs text-foreground'>
                settings.json
              </code>{' '}
              发布到原生 Claude 目录。CRAG
              的检测只核验原生启动策略，不发送测试遥测，也不证明上传。 其他
              Claude 槽由常驻 cli-node 发送，展开可查看最近 40 条计数日志。
              {codexCount
                ? ` GPT 使用独立统计链路，${codexCount} 个不在此列。`
                : ''}
            </p>
          </div>
          <div className='flex items-center gap-2'>
            <Button
              size='sm'
              disabled={!!bulk || toEnable === 0}
              onClick={() => setConfirm(true)}
            >
              全部开启
              {toEnable ? (
                <span className='font-mono text-xs tabular-nums opacity-80'>
                  {toEnable}
                </span>
              ) : null}
            </Button>
            <Button
              size='sm'
              variant='outline'
              disabled={!!bulk || toDisable === 0}
              onClick={() => setConfirm(false)}
            >
              全部关闭
              {toDisable ? (
                <span className='font-mono text-xs tabular-nums opacity-80'>
                  {toDisable}
                </span>
              ) : null}
            </Button>
            <Button
              size='sm'
              variant='outline'
              aria-label='重新检测遥测状态'
              disabled={fetching}
              onClick={() => {
                void dash.refetch()
                for (const d of details) void d.refetch()
              }}
            >
              <RefreshCw
                className={cn('size-4', fetching && 'motion-safe:animate-spin')}
              />
              检测
            </Button>
          </div>
        </CardHeader>
        <CardContent className='space-y-3'>
          <FleetBar counts={counts} total={slots.length} />
          <div className='flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs'>
            {counts.map(([key, n]) =>
              n ? (
                <span key={key} className='inline-flex items-center gap-1.5'>
                  <span
                    aria-hidden
                    className={cn('size-2 rounded-[2px]', LIVE[key].swatch)}
                  />
                  <span className='text-muted-foreground'>
                    {LIVE[key].legend}
                  </span>
                  <span className='font-mono text-foreground tabular-nums'>
                    {n}
                  </span>
                </span>
              ) : null
            )}
            <span className='ms-auto font-mono text-muted-foreground tabular-nums'>
              {onCount} / {slots.length} 策略开启
            </span>
          </div>
          {bulk ? (
            <div
              role='status'
              className='flex items-center gap-3 rounded-md bg-muted/60 px-3 py-2 text-xs'
            >
              <span className='text-muted-foreground'>
                正在{bulk.enabled ? '开启' : '关闭'}
              </span>
              <span className='font-mono text-foreground'>{bulk.current}</span>
              <span className='relative h-1 flex-1 overflow-hidden rounded-full bg-[var(--track)]'>
                <span
                  className='absolute inset-y-0 left-0 rounded-full bg-primary motion-safe:transition-[width] motion-safe:duration-300'
                  style={{ width: `${(bulk.done / bulk.total) * 100}%` }}
                />
              </span>
              <span className='font-mono text-muted-foreground tabular-nums'>
                {bulk.done}/{bulk.total}
              </span>
            </div>
          ) : null}
          <IntervalSetting value={interval} onChange={onIntervalChange} />
          <div className='flex items-center justify-between gap-3 border-t border-[var(--hairline)] pt-4'>
            <div className='min-w-0'>
              <Label
                htmlFor='telemetry-default-enabled'
                className='text-sm font-normal'
              >
                新建槽默认开启
              </Label>
              <p className='text-xs text-muted-foreground'>
                打开后，保存会把现有 Claude
                槽全部开启，之后新建的槽也默认开启。关闭只影响之后新建的槽。
              </p>
            </div>
            <Switch
              id='telemetry-default-enabled'
              checked={defaultEnabled}
              onCheckedChange={onDefaultEnabledChange}
              aria-label='新建槽默认开启遥测'
            />
          </div>
        </CardContent>
      </Card>

      <Card className='gap-0 py-0'>
        {dash.isLoading ? (
          <p className='px-6 py-5 text-sm text-muted-foreground'>读取槽位…</p>
        ) : slots.length === 0 ? (
          <p className='px-6 py-5 text-sm text-muted-foreground'>
            还没有 Claude 槽。建好槽并完成官方初装后，这里会列出它的遥测状态。
          </p>
        ) : (
          <ul className='divide-y divide-[var(--hairline)]'>
            {slots.map((slot) => (
              <SlotRow
                key={slot.vm.id}
                slot={slot}
                busy={busy.has(slot.vm.id) || bulk?.current === slot.vm.id}
                locked={!!bulk}
                open={open === slot.vm.id}
                onToggleOpen={() =>
                  setOpen((cur) => (cur === slot.vm.id ? null : slot.vm.id))
                }
                onSet={(enabled) => void setOne(slot.vm, enabled)}
              />
            ))}
          </ul>
        )}
      </Card>

      <Card className='gap-5'>
        <CardHeader>
          <CardTitle className='text-base'>播种写什么</CardTitle>
          <p className='text-sm text-muted-foreground'>
            开关只认
            telemetry_disabled。下面是播种时跟着写的镜像，手改环境变量不会保持，也不能单独当开关。槽内这些键是锁定项，种子页的
            extra_env 改不动。
          </p>
        </CardHeader>
        <CardContent>
          <table className='w-full text-sm'>
            <thead>
              <tr className='text-left text-xs text-(--text-tertiary)'>
                <th className='hidden pb-2 font-medium sm:table-cell'>文件</th>
                <th className='pb-2 font-medium'>键</th>
                <th className='w-px pe-4 pb-2 font-medium'>开</th>
                <th className='w-px pb-2 font-medium'>关</th>
              </tr>
            </thead>
            <tbody className='divide-y divide-[var(--hairline)]'>
              {CONTRACT.map((row) => {
                const flips = row.on !== row.off
                return (
                  <tr key={`${row.file}:${row.key}`}>
                    <td className='hidden py-2 pe-4 text-xs whitespace-nowrap text-muted-foreground sm:table-cell'>
                      {row.file}
                    </td>
                    <td className='py-2 pe-4'>
                      <div className='font-mono text-xs break-all text-foreground'>
                        {row.key}
                      </div>
                      <div className='mt-0.5 text-[11px] text-(--text-tertiary) sm:hidden'>
                        {row.file}
                      </div>
                    </td>
                    <td className='py-2 pe-4'>
                      <ValueChip value={row.on} accent={flips} />
                    </td>
                    <td className='py-2'>
                      <ValueChip value={row.off} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <ol className='mt-6 grid gap-px overflow-hidden rounded-lg bg-[var(--hairline)] sm:grid-cols-2 xl:grid-cols-4'>
            {steps.map((step, i) => (
              <li key={step.title} className='relative bg-card p-4'>
                <div className='flex items-center gap-2 text-sm font-medium'>
                  {step.title}
                  {i < steps.length - 1 ? (
                    <ArrowRight
                      aria-hidden
                      className='size-3.5 text-(--text-tertiary)'
                    />
                  ) : null}
                </div>
                <p className='mt-1.5 text-xs leading-5 text-muted-foreground'>
                  {step.body}
                </p>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <Card className='gap-0 py-0'>
        <ul className='divide-y divide-[var(--hairline)]'>
          <RelatedRow
            label='初装后发布遥测策略'
            detail='初装成功后只发布已保存的开关，不读取环境变量，不自动开启，也不改写身份。'
            on={routing.isLoading ? null : official?.sync_telemetry === true}
            tab='init'
            tabLabel='初装'
          />
          <RelatedRow
            label='Codex analytics'
            detail='GPT 内核自己的统计上报，与 Claude VM 原生遥测独立。'
            on={routing.isLoading ? null : codex?.analytics?.enabled === true}
            tab='openai'
            tabLabel='OpenAI'
          />
        </ul>
      </Card>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(next) => !next && setConfirm(null)}
        title={
          confirm ? '开启全部 Claude 槽的遥测？' : '关闭全部 Claude 槽的遥测？'
        }
        desc={
          <div className='space-y-2'>
            <p>
              依次重写 {pendingTargets.length} 个槽的种子文件
              {pendingRunning
                ? `；其中 ${pendingRunning} 个运行中。CRAG 若需重启，先排空再重启内核，不重启 VM 或出口`
                : ''}
              。
            </p>
            {confirm ? (
              <p>
                只有本 VM 的有效 profile 凭据、真实身份和新鲜出口信息齐备后，
                才按周期发送必要原生 1P 事件。不会制造初装活动或从控制面代发。
                {pendingRemote
                  ? ` ${pendingRemote} 个集群槽必须完成所在节点的文件发布与原生确认。`
                  : ''}
              </p>
            ) : null}
          </div>
        }
        cancelBtnText='取消'
        confirmText={confirm ? '开启' : '关闭'}
        destructive={confirm === false}
        handleConfirm={() => confirm !== null && void runBulk(confirm)}
      />
    </div>
  )
}

function FleetBar({
  counts,
  total,
}: {
  counts: (readonly [LiveKey, number])[]
  total: number
}) {
  return (
    <div
      role='img'
      aria-label={counts
        .filter(([, n]) => n)
        .map(([key, n]) => `${LIVE[key].legend} ${n}`)
        .join('，')}
      className='flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-[var(--track)]'
    >
      {total
        ? counts.map(([key, n]) =>
            n ? (
              <span
                key={key}
                className={cn(
                  'h-full first:rounded-s-full last:rounded-e-full motion-safe:transition-[flex-grow] motion-safe:duration-500 motion-safe:[transition-timing-function:var(--ease-out-expo)]',
                  LIVE[key].swatch
                )}
                style={{ flexGrow: n, flexBasis: 0 }}
              />
            ) : null
          )
        : null}
    </div>
  )
}

function Lamp({ live, probing }: { live: LiveKey; probing: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative inline-flex size-2 shrink-0 rounded-full',
        LIVE[live].swatch,
        live === 'off' && 'bg-muted-foreground/40',
        probing && 'motion-safe:animate-pulse'
      )}
    >
      {live === 'live' ? (
        <span className='absolute inset-0 rounded-full bg-primary/70 motion-safe:animate-ping' />
      ) : null}
    </span>
  )
}

function SlotRow({
  slot,
  busy,
  locked,
  open,
  onToggleOpen,
  onSet,
}: {
  slot: SlotState
  busy: boolean
  locked: boolean
  open: boolean
  onToggleOpen: () => void
  onSet: (enabled: boolean) => void
}) {
  const { vm, on, live, label, probing, confirmed, crag } = slot
  const name = slotNameLabel(vm)
  const panelId = `telemetry-log-${vm.id}`
  return (
    <li>
      <div className='grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3 sm:grid-cols-[auto_minmax(0,1fr)_10rem_auto] sm:px-6'>
        {crag ? (
          <span className='w-4' />
        ) : (
          <button
            type='button'
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={`${open ? '收起' : '展开'} ${vm.id} 上传记录`}
            onClick={onToggleOpen}
            className='-m-1 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
          >
            <ChevronRight
              className={cn(
                'size-4 motion-safe:transition-transform motion-safe:duration-200',
                open && 'rotate-90'
              )}
            />
          </button>
        )}
        <div className='min-w-0'>
          <div className='flex min-w-0 items-baseline gap-2'>
            <span className='truncate text-sm font-medium'>{name}</span>
            <span className='shrink-0 font-mono text-xs text-muted-foreground'>
              {vm.id}
            </span>
          </div>
          <div className='mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground sm:hidden'>
            <Lamp live={live} probing={probing} />
            <span className={LIVE[live].text}>{label}</span>
          </div>
          {vm.node_name || vm.node_id ? (
            <div className='mt-0.5 truncate text-xs text-(--text-tertiary)'>
              节点 {vm.node_name || vm.node_id}
            </div>
          ) : null}
        </div>
        <div
          className='hidden items-center gap-2 text-xs sm:flex'
          title={
            live === 'blocked'
              ? '按真实状态等待有效凭证、当前出口信息，或显示最近上传失败；不会借用宿主或其他 VM 数据。'
              : live === 'idle'
                ? '原生发送者空闲或等待下一次合批。'
                : undefined
          }
        >
          <Lamp live={live} probing={probing} />
          <span className={LIVE[live].text}>{label}</span>
        </div>
        <div
          role='group'
          aria-label={`${vm.id} 遥测开关`}
          className={cn(
            'inline-flex rounded-md border border-[var(--hairline)] bg-muted/40 p-0.5',
            busy && 'opacity-70'
          )}
        >
          {([true, false] as const).map((value) => {
            const active = on === value
            return (
              <button
                key={String(value)}
                type='button'
                aria-pressed={active}
                aria-label={`${value ? '开启' : '关闭'} ${vm.id} 遥测`}
                disabled={busy || locked || (active && confirmed)}
                title={
                  active && !confirmed
                    ? '重新发布当前策略并等待 VM 确认'
                    : undefined
                }
                onClick={() => onSet(value)}
                className={cn(
                  'min-w-9 rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-default',
                  active
                    ? value
                      ? 'bg-accent text-accent-foreground'
                      : 'bg-secondary text-foreground'
                    : 'text-muted-foreground enabled:hover:text-foreground'
                )}
              >
                {busy && !active ? '…' : value ? '开' : '关'}
              </button>
            )
          })}
        </div>
      </div>
      {open && !crag ? (
        <UploadPanel id={vm.id} panelId={panelId} on={on} />
      ) : null}
    </li>
  )
}

function UploadPanel({
  id,
  panelId,
  on,
}: {
  id: string
  panelId: string
  on: boolean
}) {
  const log = useQuery({
    ...vmSeedUploadLogQueryOptions(id),
    refetchInterval: 10_000,
  })
  const summary = summarizeUploads(log.data || [])
  const now = Date.now()
  return (
    <div
      id={panelId}
      className='animate-settings-pane-in space-y-3 border-t border-[var(--hairline)] bg-muted/25 px-4 py-4 sm:ps-13 sm:pe-6'
    >
      {log.isLoading ? (
        <p className='text-xs text-muted-foreground'>读取上传记录…</p>
      ) : log.error ? (
        <p className='text-xs text-destructive'>
          读不到上传记录：{(log.error as Error).message}
        </p>
      ) : summary.entries.length === 0 ? (
        <p className='text-xs text-muted-foreground'>
          {on
            ? '还没有上传记录。完成一次原生批量上传后会出现。'
            : '遥测关着，没有新的上传记录。'}
        </p>
      ) : (
        <>
          <dl className='flex flex-wrap gap-x-6 gap-y-1 text-xs'>
            <Stat label='最近尝试'>
              {summary.last ? relativeAgo(summary.last, now) : '—'}
            </Stat>
            <Stat label='批次'>{summary.batch}</Stat>
            <Stat label='事件尝试'>{summary.events}</Stat>
            <Stat label='失败' tone={summary.failed ? 'bad' : undefined}>
              {summary.failed}
            </Stat>
            <span className='text-(--text-tertiary)'>
              最近 {summary.entries.length} 条
            </span>
          </dl>
          <Timeline
            entries={summary.entries}
            first={summary.first}
            last={summary.last}
          />
          <details className='group'>
            <summary className='inline-flex cursor-pointer items-center gap-1 rounded text-xs text-muted-foreground select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'>
              <ChevronRight className='size-3.5 group-open:rotate-90 motion-safe:transition-transform' />
              计数 / 状态记录
            </summary>
            <pre className='mt-2 max-h-64 overflow-auto rounded-md bg-background/60 px-3 py-2 font-mono text-[11px] leading-5 text-foreground'>
              {[...summary.entries]
                .reverse()
                .map((entry) => entry.raw)
                .join('\n')}
            </pre>
          </details>
        </>
      )}
    </div>
  )
}

function Stat({
  label,
  tone,
  children,
}: {
  label: string
  tone?: 'bad'
  children: React.ReactNode
}) {
  return (
    <div className='flex items-baseline gap-1.5'>
      <dt className='text-muted-foreground'>{label}</dt>
      <dd
        className={cn(
          'font-mono tabular-nums',
          tone === 'bad' ? 'text-[var(--status-bad)]' : 'text-foreground'
        )}
      >
        {children}
      </dd>
    </div>
  )
}

function clock(at: number) {
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
}

function Timeline({
  entries,
  first,
  last,
}: {
  entries: UploadEntry[]
  first: number | null
  last: number | null
}) {
  if (first === null || last === null) return null
  const span = last - first
  return (
    <div>
      <div className='relative h-7 rounded-md bg-background/50'>
        <span
          aria-hidden
          className='absolute inset-x-2 top-1/2 h-px bg-[var(--hairline)]'
        />
        {entries.map((entry, i) => {
          const x = span > 0 ? (entry.at - first) / span : 0.5
          return (
            <span
              key={`${entry.at}:${i}`}
              title={`${clock(entry.at)} · ${entry.events} 个事件 · ${entry.ok ? '成功' : entry.error || '失败'}`}
              className={cn(
                'absolute top-1/2 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full',
                !entry.ok ? 'h-5 bg-[var(--status-bad)]' : 'h-3 bg-primary'
              )}
              style={{ left: `calc(0.5rem + ${x} * (100% - 1rem))` }}
            />
          )
        })}
      </div>
      <div className='mt-1 flex items-center justify-between font-mono text-[11px] text-(--text-tertiary) tabular-nums'>
        <span>{clock(first)}</span>
        <span className='flex items-center gap-3 font-sans'>
          <Key swatch='bg-primary' label='批次' />
          <Key swatch='bg-[var(--status-bad)]' label='失败' />
        </span>
        <span>{clock(last)}</span>
      </div>
    </div>
  )
}

function Key({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className='inline-flex items-center gap-1'>
      <span aria-hidden className={cn('h-2.5 w-[3px] rounded-full', swatch)} />
      {label}
    </span>
  )
}

function ValueChip({ value, accent }: { value: string; accent?: boolean }) {
  const literal = /^(".*"|true|false|enabled|disabled)/.test(value)
  return (
    <span
      className={cn(
        'inline-flex rounded px-1.5 py-0.5 text-xs whitespace-nowrap',
        literal ? 'font-mono' : '',
        accent
          ? 'bg-accent text-accent-foreground'
          : 'bg-muted text-muted-foreground'
      )}
    >
      {value}
    </span>
  )
}

function RelatedRow({
  label,
  detail,
  on,
  tab,
  tabLabel,
}: {
  label: string
  detail: string
  on: boolean | null
  tab: 'init' | 'openai'
  tabLabel: string
}) {
  return (
    <li className='flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3.5 sm:px-6'>
      <div className='min-w-48 flex-1'>
        <div className='text-sm font-medium'>{label}</div>
        <p className='text-xs text-muted-foreground'>{detail}</p>
      </div>
      <span
        className={cn(
          'font-mono text-xs',
          on ? 'text-primary' : 'text-muted-foreground'
        )}
      >
        {on === null ? '…' : on ? '开' : '关'}
      </span>
      <Link
        to='/settings/$tab'
        params={{ tab }}
        className='inline-flex items-center gap-1 rounded text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
      >
        在「{tabLabel}」修改
        <ArrowRight className='size-3' aria-hidden />
      </Link>
    </li>
  )
}
