import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import type { CragHostStatus, CragRuntimeVm } from './queries'

const numberLabel = (value: number | 'unlimited' | null | undefined) =>
  value === 'unlimited' ? '不限' : (value ?? '待核对')

const dateTime = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

export const cragHostStatusLabels: Record<CragHostStatus['state'], string> = {
  unavailable: '暂不可用',
  unredeemed: '尚未兑换',
  active: '订阅有效',
  expired: '已到期',
  sync_pending: '等待同步',
}

/**
 * 状态的语义配色。颜色不是唯一指示物 —— 徽章始终带文字标签，
 * 所以色觉障碍用户不依赖颜色也能读出状态。
 *
 * 导出是为了让订阅页复用同一份映射：同一状态在两处显示成不同颜色，
 * 和同一数字叫两个名字是同一类问题。
 */
export const cragHostStatusVariant: Record<
  CragHostStatus['state'],
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  unavailable: 'outline',
  unredeemed: 'secondary',
  active: 'default',
  expired: 'destructive',
  sync_pending: 'secondary',
}

const DAY = 86_400
/** 到期前这么久开始提示紧迫。 */
const SOON = 7 * DAY

/**
 * 订阅到期时刻。返回 null 表示上游没下发 `expires_at`（例如尚未兑换），
 * 此时不展示到期，而不是展示一个猜测值。
 */
function expiry(status?: CragHostStatus) {
  const at = status?.expires_at
  if (at == null) return null
  const date = new Date(at * 1000)
  if (!Number.isFinite(date.getTime())) return null
  const left = at - Math.floor(Date.now() / 1000)
  return { date, left, lapsed: left <= 0, soon: left > 0 && left < SOON }
}

/**
 * 使用中的槽位数。上游不一定下发 `used_slots`（`crag-subscription.mjs:90` 只在
 * payload 带它时才透传），此时用「额度 − 可用」反推 —— 这正是后端自己的关系式
 * （同文件 `:106`）。两者都拿不到时返回 null，不猜。
 *
 * 导出给订阅页复用：同一个数字在两处各算一遍，迟早会算出两个值。
 */
export function cragSlotsInUse(status?: CragHostStatus) {
  if (status?.used_slots != null) return status.used_slots
  const limit = status?.slot_limit
  const free = status?.available_seats
  if (typeof limit === 'number' && typeof free === 'number')
    return Math.max(0, limit - free)
  return null
}

function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className='inline-flex min-w-0 items-baseline gap-1'>
      <span className='text-muted-foreground'>{label}</span>
      <span className='font-medium wrap-anywhere tabular-nums'>{children}</span>
    </span>
  )
}

/**
 * 宿主订阅的额度与运行概况。
 *
 * 额度只展示两个值：**使用中** 与 **额度**。余量由用户自己相减，不再单独呈现 ——
 * 那个派生值历史上有四种叫法（「剩余可用槽位」「剩余可绑定槽位」「订阅槽位额度」
 * 「宿主机应用锁额度」），其中前两种还同屏相邻出现。少展示一个派生值，就少一处
 * 可以产生别名的地方。
 *
 * 不要再引入新叫法；「绑定」只用于绑定这个动作本身（它有自己的错误态）。
 */
export function CragRuntimeCounts({ status }: { status?: CragHostStatus }) {
  const over = status?.runtime?.host_over_limit === true
  const due = expiry(status)
  const reclaim = status?.reclaim_pending_count ?? 0
  const used = cragSlotsInUse(status)
  return (
    <div
      role='status'
      className='flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-sm'
    >
      {over ? (
        <Badge variant='destructive'>宿主订阅超额</Badge>
      ) : (
        <Badge
          variant={status ? cragHostStatusVariant[status.state] : 'outline'}
        >
          {status ? cragHostStatusLabels[status.state] : '状态待核对'}
        </Badge>
      )}
      {over ? (
        <span className='text-muted-foreground'>仅超额槽暂停调度</span>
      ) : null}
      <Metric label='使用中'>{used ?? '待核对'}</Metric>
      <Metric label='额度'>{numberLabel(status?.slot_limit)}</Metric>
      {due ? (
        <Metric label={due.lapsed ? '已于' : '到期'}>
          <time
            dateTime={due.date.toISOString()}
            className={due.soon || due.lapsed ? 'text-destructive' : undefined}
          >
            {dateTime.format(due.date)}
          </time>
          {due.lapsed ? (
            <span className='text-destructive'>{' 到期'}</span>
          ) : due.soon ? (
            <span className='text-destructive'>
              {' · 剩 '}
              {Math.max(1, Math.floor(due.left / DAY))}
              {' 天'}
            </span>
          ) : null}
        </Metric>
      ) : null}
      {reclaim > 0 ? <Metric label='待回收绑定'>{reclaim}</Metric> : null}
      {status?.runtime ? (
        <Metric label='运行中的订阅槽'>
          {numberLabel(status.runtime.host_running_vms)}
        </Metric>
      ) : null}
    </div>
  )
}

export function CragRuntimeDetail({ detail }: { detail: CragRuntimeVm }) {
  const state =
    detail.state === 'running'
      ? detail.ready
        ? '服役中 / 可接请求'
        : '服役中 / 暂不可用'
      : detail.state === 'not_running'
        ? '未运行'
        : '运行状态未知'
  const fields = [
    detail.version == null ? null : `版本 ${detail.version}`,
    detail.active_requests == null ? null : `处理中 ${detail.active_requests}`,
    detail.queued == null ? null : `排队 ${detail.queued}`,
    detail.ready_slots == null ? null : `就绪处理槽 ${detail.ready_slots}`,
  ].filter(Boolean)
  return (
    <div className='mt-2 space-y-0.5 text-sm'>
      <p>CRAG：{detail.quota_blocked ? '超出订阅额度 / 暂停调度' : state}</p>
      {fields.length > 0 ? (
        <p className='text-xs wrap-anywhere text-muted-foreground tabular-nums'>
          {fields.join(' · ')}
        </p>
      ) : null}
    </div>
  )
}
