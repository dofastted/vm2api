import { useRef } from 'react'
import { Link } from '@tanstack/react-router'
import type { UsageAccountRow } from '@/types/panel-usage'
import type { Vm } from '@/types/panel-vm'
import {
  BarChart3,
  ExternalLink,
  Link2,
  Play,
  RefreshCw,
  RotateCcw,
} from 'lucide-react'
import { credTypeLabel, credTypeOf } from '@/lib/cred-type'
import { fmtExpiresAt, fmtNum, fmtUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { compactEmail, isCodexVm, slotNameLabel } from '@/lib/vm-kind'
import {
  accountStatus,
  claudeTier,
  credExpiry,
  poolStatus,
  restrictionCopy,
  seatTitle,
  vmRunning,
} from '@/lib/vm-status'
import {
  fmtHitPct,
  vmTodayStats,
  vmTotalCost,
  vmWeekOutcome,
} from '@/lib/vm-usage'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  CredLaneChip,
  PlatformChip,
  SlotIdentity,
} from '@/components/platform-chip'
import { StatusMark } from '@/components/status-mark'
import { ProxyChip } from '@/features/proxies/proxy-chip'
import { restrictionTitle } from '@/features/vm/clear-restriction'
import { Field } from '@/features/vm/detail-section-primitives'
import { NodeChip } from '@/features/vm/node-chip'
import { OpenaiPlanBadge } from '@/features/vm/openai-plan-badge'
import { RuntimeChip } from '@/features/vm/runtime-chip'
import {
  SchedulableSwitch,
  vmSchedulableProps,
} from '@/features/vm/schedulable-switch'
import { VmUsageWindows } from '@/features/vm/usage-windows'
import { refreshBlockedReason } from '@/features/vm/vm-action-menu'
import { useVmActions } from '@/features/vm/vm-actions-context'
import { VmSchedulingBlock } from '@/features/vm/vm-scheduling'

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className='min-w-0 rounded-lg border px-3 py-2.5'>
      <h3 className='mb-1 text-xs font-medium text-muted-foreground'>
        {title}
      </h3>
      {children}
    </section>
  )
}

function CardBody({ vm, accounts }: { vm: Vm; accounts?: UsageAccountRow[] }) {
  const actions = useVmActions()
  const today = vmTodayStats(vm, accounts)
  const week = vmWeekOutcome(vm, accounts)
  const codex = isCodexVm(vm)
  const credType = credTypeOf(vm)
  const tier = claudeTier(vm)
  const blocked = refreshBlockedReason(vm)
  const restricted = restrictionTitle(vm)
  const inflight = Number(vm.inflight) || 0
  const queued = Number(vm.queue_depth) || 0
  return (
    <>
      <div className='flex flex-wrap items-center gap-1.5'>
        <PlatformChip vm={vm} />
        <StatusMark tone={accountStatus(vm)} variant='pill' />
        {tier.key !== 'none' ? <StatusMark tone={tier} variant='pill' /> : null}
        {poolStatus(vm).key !== accountStatus(vm).key ? (
          <StatusMark tone={poolStatus(vm)} variant='pill' />
        ) : null}
        <span className='text-xs text-muted-foreground'>
          {vmRunning(vm) ? '运行' : '停止'}
          {inflight > 0 ? ` · 在飞 ${inflight}` : ''}
        </span>
        {vm.seats_max != null ? (
          <span
            className={cn(
              'text-xs text-muted-foreground tabular-nums',
              queued > 0 && 'text-[color:var(--status-warn)]'
            )}
            title={seatTitle(vm)}
          >
            席位 {Number(vm.seats_used) || 0}/{vm.seats_max}
            {queued > 0 ? ` · 排队 ${queued}` : ''}
          </span>
        ) : null}
        <div className='ms-auto flex items-center gap-1.5 text-xs text-muted-foreground'>
          调度
          <SchedulableSwitch {...vmSchedulableProps(vm)} />
        </div>
      </div>
      <p className='text-xs text-muted-foreground'>{restrictionCopy(vm)}</p>

      <Section title='用量窗口'>
        <VmUsageWindows vm={vm} accounts={accounts} quotaActions />
      </Section>

      <VmSchedulingBlock vm={vm} />

      <div className='grid gap-2 sm:grid-cols-2'>
        <Section title='今日'>
          <div className='flex items-baseline justify-between'>
            <span className='text-lg leading-tight font-semibold tabular-nums'>
              {fmtUsd(today.today, 2)}
            </span>
            <span className='font-mono text-xs text-muted-foreground tabular-nums'>
              {fmtNum(today.req)} req · {fmtNum(today.tok)} tok
            </span>
          </div>
          <div className='mt-1 font-mono text-[11px] text-muted-foreground tabular-nums'>
            入 {fmtNum(today.inn)} · 出 {fmtNum(today.out)} · 缓存{' '}
            {fmtNum(today.read)}/{fmtNum(today.write)} · 命中{' '}
            {fmtHitPct(today.hit)}
          </div>
        </Section>
        <Section title='累计 / 7d 结果'>
          <div className='flex items-baseline justify-between'>
            <span className='text-lg leading-tight font-semibold tabular-nums'>
              {fmtUsd(vmTotalCost(vm, accounts), 2)}
            </span>
            <span className='font-mono text-xs tabular-nums'>
              <span className='text-[color:var(--status-ok)]'>
                {week.known ? fmtNum(week.success) : '—'}
              </span>
              {' / '}
              <span className='text-[color:var(--status-bad)]'>
                {week.known ? fmtNum(week.fail) : '—'}
              </span>
            </span>
          </div>
          <div className='mt-1 text-[11px] text-muted-foreground'>
            7d 成功 / 失败 · 官方价累计
          </div>
        </Section>
      </div>

      <div className='grid gap-2 sm:grid-cols-2'>
        <Section title='账号'>
          <div className='divide-y'>
            <Field label='类型' compact>
              {credType === 'none' ? (
                '-'
              ) : (
                <span className='flex flex-wrap items-center gap-1.5'>
                  <CredLaneChip vm={vm} />
                  <span className='text-xs text-muted-foreground'>
                    凭证 {credTypeLabel(credType)}
                  </span>
                  {codex ? <OpenaiPlanBadge vm={vm} /> : null}
                </span>
              )}
            </Field>
            <Field label='邮箱' compact>
              <span className='text-xs' title={String(vm.email || '')}>
                {vm.email ? compactEmail(String(vm.email), 30) : '-'}
              </span>
            </Field>
            <Field label='过期' compact>
              <StatusMark tone={credExpiry(vm)} variant='pill' />{' '}
              <span className='text-xs text-muted-foreground'>
                {fmtExpiresAt(vm.expires_at)}
              </span>
            </Field>
            <Field label='令牌' compact>
              <span className='text-xs'>
                Access {vm.has_token ? '已写入' : '-'} · Refresh{' '}
                {vm.has_refresh ? '已绑定' : '-'}
              </span>
            </Field>
          </div>
        </Section>
        <Section title='槽位'>
          <div className='divide-y'>
            <Field label='名称' compact>
              <span className='text-xs'>{slotNameLabel(vm)}</span>
            </Field>
            <Field label='ID' compact>
              <span className='font-mono text-xs'>{vm.id}</span>
            </Field>
            <Field label='代理' compact>
              <ProxyChip vm={vm} compact />
            </Field>
          </div>
        </Section>
      </div>

      <div className='flex flex-wrap gap-1.5 border-t pt-3'>
        <Button
          size='sm'
          variant='outline'
          onClick={() => actions.openTest(vm)}
        >
          <Play /> 测试链接
        </Button>
        <Button
          size='sm'
          variant='outline'
          onClick={() => actions.openStats(vm)}
        >
          <BarChart3 /> 查看统计
        </Button>
        <Button
          size='sm'
          variant='outline'
          onClick={() => actions.openReauth(vm)}
        >
          <Link2 /> 重新授权
        </Button>
        <Button
          size='sm'
          variant='outline'
          disabled={Boolean(blocked) || actions.refreshingId === vm.id}
          title={blocked || undefined}
          onClick={() => actions.refreshToken(vm)}
        >
          <RefreshCw /> 刷新令牌
        </Button>
        <Button
          size='sm'
          variant='outline'
          disabled={!restricted || actions.recoveringId === vm.id}
          title={restricted ?? '当前没有冷却或熔断'}
          onClick={() => actions.recover(vm)}
        >
          <RotateCcw /> 恢复状态
        </Button>
        <Button size='sm' variant='ghost' className='ms-auto' asChild>
          <Link to='/vm/$id' params={{ id: vm.id }}>
            <ExternalLink /> 完整页面
          </Link>
        </Button>
      </div>
    </>
  )
}

/** 点击槽位弹出的详情卡：身份、状态、用量窗口、账号信息与常用操作。 */
export function VmDetailCard({
  vm,
  accounts,
  onOpenChange,
}: {
  vm: Vm | null
  accounts?: UsageAccountRow[]
  onOpenChange: (open: boolean) => void
}) {
  const contentRef = useRef<HTMLDivElement>(null)
  return (
    <Dialog open={vm != null} onOpenChange={onOpenChange}>
      <DialogContent
        className='flex max-h-[90vh] flex-col gap-3 sm:max-w-2xl'
        // 首个可聚焦元素是调度开关，自动聚焦会弹出它的 tooltip 并有误触风险；
        // 改为聚焦弹窗本身，Esc 与焦点陷阱照常工作。
        ref={contentRef}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          contentRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle className='flex min-w-0 items-center gap-1.5 text-base'>
            {vm ? <SlotIdentity vm={vm} compact /> : '槽位详情'}
            {vm ? <RuntimeChip vm={vm} /> : null}
            {vm ? <NodeChip nodeId={vm.node_id} /> : null}
          </DialogTitle>
          <DialogDescription className='sr-only'>槽位详情</DialogDescription>
        </DialogHeader>
        <div className='-me-3 min-h-0 flex-1 overflow-y-auto pe-3'>
          <div className='space-y-2.5 pb-1'>
            {vm ? <CardBody vm={vm} accounts={accounts} /> : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
