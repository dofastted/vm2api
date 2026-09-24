import type { Dashboard } from '@/types/panel-overview'
import type { Vm, VmKernelSnapshot, VmProxySnap } from '@/types/panel-vm'
import type { StatusTone } from '@/types/status'
import {
  fableCap,
  fableCardInfo,
  type ConcurrencyInfo,
  type RpmInfo,
  type SessionCapacity,
  type VmCostSummary,
  type WeeklySplitSummary,
} from '@/lib/fable-status'
import { fmtNum, fmtUsd } from '@/lib/format'
import { isCodexVm } from '@/lib/vm-kind'
import {
  accountStatus,
  accountUsable,
  poolStatus,
  proxyHostLabel,
  restrictionCopy,
  restrictionUntilOf,
  scheduleStateLabel,
  vmRunning,
} from '@/lib/vm-status'
import {
  kernelHopReady,
  kernelProcessUp,
  wrapHealthLabel,
} from '@/lib/wrap-health'
import { SlotIdentity } from '@/components/platform-chip'
import { StatusMark } from '@/components/status-mark'
import { CodexKernelHealthFields } from '@/features/vm/codex-kernel-health-card'
import { ConcRpmEditor } from '@/features/vm/conc-rpm-editor'
import { dataplaneLabel } from '@/features/vm/dataplane-contract'
import { CircuitField } from '@/features/vm/detail-circuit-field'
import {
  Field,
  Meter,
  quotaWindowHint,
  ResetAt,
} from '@/features/vm/detail-section-primitives'
import { KernelFeatTags } from '@/features/vm/kernel-feat-tags'
import { OpenaiPlanBadge } from '@/features/vm/openai-plan-badge'
import { OpenaiQuotaPanel } from '@/features/vm/openai-quota-panel'
import { proxyHealthOf } from '@/features/vm/proxy-health'
import { SessionSlotsEditor } from '@/features/vm/session-slots-editor'
import { telemetryStatusLabel } from './telemetry-status'

type Props = {
  vm: Vm
  kernel?: VmKernelSnapshot | null
  acc: Record<string, unknown>
  proxy: VmProxySnap
  dash: { data: Dashboard | undefined }
  u5: number
  u7: number
  tierKey: string
  now: number
  cost: VmCostSummary
  split: WeeklySplitSummary | null
  sess: SessionCapacity | null
  conc: ConcurrencyInfo
  rpm: RpmInfo | null
}

type Verdict = {
  tone: StatusTone
  notes: string[]
}

/**
 * 可服务跟账号 `availability` / 凭证死活走。
 * wrap `rust_health.reachable` 是 hop 就绪（process_up 且 ready_slots>=1），
 * 不能当成槽不可用。
 */
function slotVerdict(
  vm: Vm,
  kernel: VmKernelSnapshot | null | undefined,
  proxy: VmProxySnap
): Verdict {
  const acc = accountStatus(vm)
  const proxyH = proxyHealthOf(vm, proxy)
  const hop = kernel?.rust_health || kernel?.go_health
  const notes: string[] = []
  const proxyFailClosed =
    !!vm.has_token && proxyH.score === 0 && proxyH.tone.cls === 'bad'

  if (acc.cls === 'none') {
    return {
      tone: {
        key: 'none',
        text: '无凭证',
        cls: 'none',
        label: acc.text,
      },
      notes: [acc.text],
    }
  }
  if (acc.cls === 'bad' || proxyFailClosed) {
    const why = acc.cls === 'bad' ? acc.text : proxyH.tone.text
    return {
      tone: {
        key: 'bad',
        text: '不可服务',
        cls: 'bad',
        label: why,
      },
      notes: [why],
    }
  }
  if (acc.cls === 'off') {
    return {
      tone: {
        key: 'off',
        text: '未调度',
        cls: 'off',
        label: acc.text,
      },
      notes: [acc.text],
    }
  }
  if (acc.cls === 'warn' || acc.cls === 'caution') notes.push(acc.text)
  if (hop && kernelProcessUp(hop) && !kernelHopReady(hop)) {
    notes.push('CLI 未就绪')
  }
  return {
    tone: {
      key: 'ok',
      text: accountUsable(vm) ? '可服务' : acc.text,
      cls: acc.cls === 'ok' ? 'ok' : acc.cls,
      label: notes.join(' · ') || '凭证有效',
    },
    notes,
  }
}

function workerLabel(value: unknown) {
  const raw = String(value || '').trim()
  if (raw === 'go' || raw === 'rust') return 'Rust · cli-hop'
  return raw || '—'
}

function topologyLabel(
  topology: VmKernelSnapshot['process_topology'] | undefined
) {
  if (topology?.rust_pid1) return 'kernel PID1'
  if (topology?.go_worker_pid1) return '旧拓扑'
  return '未知'
}

function money(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

export function VmStatusBoard(props: Props) {
  const {
    vm,
    kernel,
    acc,
    proxy,
    dash,
    u5,
    u7,
    tierKey,
    now,
    cost,
    split,
    sess,
    conc,
    rpm,
  } = props
  const verdict = slotVerdict(vm, kernel, proxy)
  const proxyH = proxyHealthOf(vm, proxy)
  const fable = fableCardInfo(vm, tierKey, fableCap(dash.data))
  const reset5 = acc.reset_5h ?? vm.reset_5h
  const reset7 = acc.reset_7d ?? vm.reset_7d
  const cost5 = money(acc.window_5h_cost ?? vm.window_5h_cost ?? cost.w)
  const cost7 = money(acc.window_7d_cost ?? vm.window_7d_cost)
  const telemetry = kernel?.telemetry
  const topology = kernel?.process_topology
  const rust = wrapHealthLabel(kernel?.rust_health)

  return (
    <section className='rounded-lg border bg-card'>
      <div className='grid xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1.15fr)_minmax(0,0.95fr)]'>
        <div className='min-w-0 p-4 xl:pr-5'>
          <div className='flex items-start justify-between gap-3'>
            <div className='min-w-0'>
              <h2 className='text-lg leading-none font-semibold'>现状</h2>
              <p className='mt-1.5 text-xs text-muted-foreground'>
                {verdict.notes.length
                  ? verdict.notes.join(' · ')
                  : '这槽现在可以接推理'}
              </p>
            </div>
            <StatusMark tone={verdict.tone} variant='pill' />
          </div>
          <div className='mt-4 flex flex-wrap items-center gap-1.5'>
            {isCodexVm(vm) ? <OpenaiPlanBadge vm={vm} size='sm' /> : null}
            <StatusMark tone={accountStatus(vm)} variant='pill' />
            <StatusMark tone={poolStatus(vm)} variant='pill' />
            <StatusMark tone={proxyH.tone} variant='pill' />
            <StatusMark
              tone={{
                key: vmRunning(vm) ? 'ok' : 'off',
                text: vmRunning(vm) ? '运行' : '停止',
                cls: vmRunning(vm) ? 'ok' : 'off',
              }}
              variant='pill'
            />
          </div>
          <div className='mt-4 divide-y'>
            <Field label='邮箱' compact>
              <SlotIdentity
                vm={vm}
                email={
                  vm.email || (typeof acc.email === 'string' ? acc.email : null)
                }
                compact
              />
            </Field>
            {isCodexVm(vm) ? (
              <Field label='平台' compact>
                OpenAI / Codex
              </Field>
            ) : (
              <>
                <Field label='镜像' compact>
                  <div className='space-y-1'>
                    <div>{String(vm.kernel || '—')}</div>
                    <KernelFeatTags kernel={vm.kernel} />
                  </div>
                </Field>
                <Field label='Worker' compact>
                  {workerLabel(
                    (vm.runtime as Record<string, unknown> | undefined)?.worker
                  )}
                </Field>
              </>
            )}
            <Field label='调度状态' compact>
              {scheduleStateLabel(vm)}
            </Field>
            <Field label='限制至' compact>
              {restrictionUntilOf(vm) ? (
                <ResetAt value={restrictionUntilOf(vm)} now={now} />
              ) : (
                '—'
              )}
            </Field>
            <Field label='冷却' compact>
              {restrictionCopy(vm)}
            </Field>
            <CircuitField vm={vm} now={now} />
          </div>
        </div>

        <div className='min-w-0 border-t p-4 xl:border-t-0 xl:border-l xl:px-5'>
          <h3 className='text-sm font-medium'>额度</h3>
          <div className='mt-3 grid gap-3'>
            {isCodexVm(vm) ? (
              <OpenaiQuotaPanel
                vm={vm}
                u5={u5}
                u7={u7}
                now={now}
                cost5={cost5}
                cost7={cost7}
              />
            ) : (
              <>
                <Meter
                  label='5 小时已用'
                  value={u5}
                  hint={`${quotaWindowHint(u5, reset5, now)} · 合计 ${fmtUsd(cost5, 2)}`}
                />
                <Meter
                  label='7 天已用'
                  value={u7}
                  hint={`${quotaWindowHint(u7, reset7, now)} · 合计 ${fmtUsd(cost7, 2)}`}
                />
                {fable.usedPct != null ? (
                  <Meter
                    label='Fable 已用'
                    value={fable.usedPct}
                    hint={fable.bits.join(' · ')}
                  />
                ) : (
                  <div className='flex items-center justify-between gap-2 text-sm'>
                    <span className='text-xs text-muted-foreground'>Fable</span>
                    <span>{fable.badgeText}</span>
                  </div>
                )}
                {split ? (
                  <div className='grid grid-cols-2 gap-3'>
                    <Meter
                      label='普通半仓'
                      value={Math.min(100, split.regularFill)}
                      hint={`周限 ${(split.regularUsed * 100).toFixed(1)}%`}
                    />
                    <Meter
                      label='Fable 半仓'
                      value={Math.min(100, split.fableFill)}
                      hint={`周限 ${(split.fableUsed * 100).toFixed(1)}%`}
                    />
                  </div>
                ) : null}
                {sess ? (
                  <Meter
                    label='会话'
                    value={sess.max > 0 ? (sess.active / sess.max) * 100 : 0}
                    hint={`${sess.active}/${sess.max}`}
                  />
                ) : null}
              </>
            )}
          </div>
        </div>

        <div className='min-w-0 border-t p-4 xl:border-t-0 xl:border-l xl:pl-5'>
          <h3 className='text-sm font-medium'>运行</h3>
          <div className='mt-3 grid grid-cols-2 gap-3'>
            <div>
              <div className='text-xs text-muted-foreground'>今日</div>
              <div className='mt-0.5 text-lg font-semibold tabular-nums'>
                {fmtUsd(
                  Number(acc.today_cost ?? vm.today_cost ?? cost.today),
                  2
                )}
              </div>
              <div className='text-[11px] text-muted-foreground'>
                {fmtNum(cost.req)} req
              </div>
            </div>
            <div>
              <div className='text-xs text-muted-foreground'>5h 窗口</div>
              <div className='mt-0.5 text-lg font-semibold tabular-nums'>
                {fmtUsd(cost.w, 2)}
              </div>
              <div className='text-[11px] text-muted-foreground'>
                {fmtNum(cost.tok)} tok
              </div>
            </div>
          </div>
          <div className='mt-3 divide-y'>
            <Field label='代理' compact>
              <span className='font-mono text-xs'>{proxyHostLabel(proxy)}</span>
            </Field>
            <Field label='并发 / RPM' compact>
              <div className='flex items-center gap-1'>
                <span className='tabular-nums'>
                  {conc.inf}/{conc.max}
                  {' · '}
                  {rpm ? `${rpm.n}/${rpm.max} rpm` : 'rpm 不限'}
                </span>
                <ConcRpmEditor vm={vm} />
              </div>
            </Field>
            {isCodexVm(vm) ? null : (
              <Field label='Session 槽位' compact>
                <div className='flex items-center gap-1'>
                  <span className='tabular-nums'>
                    {Number(vm.session_slots ?? 20)}/20
                  </span>
                  <SessionSlotsEditor vm={vm} />
                </div>
              </Field>
            )}
            {isCodexVm(vm) ? null : (
              <>
                <Field label='5h 重置' compact>
                  <ResetAt value={reset5} now={now} />
                </Field>
                <Field label='7d 重置' compact>
                  <ResetAt value={reset7} now={now} />
                </Field>
              </>
            )}
            {isCodexVm(vm) ? (
              <CodexKernelHealthFields health={kernel?.codex_health} />
            ) : (
              <>
                <Field label='cli-hop' compact>
                  {rust}
                </Field>
                <Field label='内核' compact>
                  {isCodexVm(vm) ? '—' : dataplaneLabel(vm.resolved_dataplane)}
                </Field>
                <Field label='拓扑' compact>
                  {topologyLabel(topology)}
                  {topology?.go_telemetry ? ' · Go telemetry' : ''}
                </Field>
                <Field label='遥测' compact>
                  {telemetryStatusLabel(telemetry)}
                </Field>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
