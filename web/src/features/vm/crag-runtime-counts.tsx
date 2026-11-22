import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import type { CragHostStatus, CragRuntimeVm } from './queries'

/**
 * 槽位数的统一写法。导出理由同 `cragHostStatusVariant`：同一个「不限」在两处
 * 写成不同字样，和同一数字叫两个名字是同一类问题。
 */
export const numberLabel = (value: number | 'unlimited' | null | undefined) =>
  value === 'unlimited' ? '不限' : (value ?? '待核对')

/** 时刻的统一格式。导出理由同上 —— 同一个时间不该在两处长得不一样。 */
export const dateTime = new Intl.DateTimeFormat('zh-CN', {
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
 * 使用中的槽位数 —— **只取真值：真正运行中的 CRAG 内核数**。
 *
 * 读 `runtime.host_running_vms`，不从绑定数反推。这不是风格选择：
 * `crag-runtime-inventory.mjs:430-435` 把同一个 `hostRunning` 既喂给该字段、
 * 又喂给 `hostQuota` 算出 `host_over_limit: running > limit`，所以运行数**就是**
 * 准入强制所依据的真值。而 `available_seats` / `used_slots` 走的是席位与绑定
 * （roster 长度），与强制逻辑不同源 —— 拿它反推会让「显示的数」和「真正卡住
 * 用户的数」对不上，用户照着它充值可能白充。
 *
 * 关调度的内核、以及缺 permit/claims 的，都不计入（见同文件 `:414` 的就绪判定）。
 * 切换到 CRAG 内核本身不受额度限制，只有真正要调度才需要槽位凭证。
 *
 * 返回 null 表示运行状态未知，此时展示「待核对」而不是一个可能错的 0 ——
 * 上游也遵循同一原则：「Status must not present a wholly failed sample as a
 * verified zero.」
 */
export function cragSlotsInUse(status?: CragHostStatus) {
  return status?.runtime?.host_running_vms ?? null
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
 * 宿主订阅概况。
 *
 * 用户侧只看两个数字：**使用中的槽位** 与 **充值可用槽位**。满了就继续充 ——
 * 这是个余额心智，其余计数一概不展示。
 *
 * 历史上同一个量有过四种叫法（「剩余可用槽位」「剩余可绑定槽位」「订阅槽位额度」
 * 「宿主机应用锁额度」），其中两种还同屏相邻出现；此外还有「CRAG 运行数」
 * 「当前 VM 总数」「运行中的订阅槽」三个看起来都像「在用多少」的计数。少展示
 * 一个数字，就少一处能产生别名的地方。
 *
 * 唯一的例外是**用户能据此行动**的异常态：超额时说明为什么被暂停调度。
 */
export function CragRuntimeCounts({ status }: { status?: CragHostStatus }) {
  const over = status?.runtime?.host_over_limit === true
  const due = expiry(status)
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
      <Metric label='使用中的槽位'>{used ?? '待核对'}</Metric>
      <Metric label='充值可用槽位'>{numberLabel(status?.slot_limit)}</Metric>
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
