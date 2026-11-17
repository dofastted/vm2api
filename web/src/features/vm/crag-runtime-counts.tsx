import type { CragHostStatus, CragRuntimeVm } from './queries'

const numberLabel = (value: number | 'unlimited' | null | undefined) =>
  value === 'unlimited' ? '不限' : (value ?? '待核对')

export const cragHostStatusLabels: Record<CragHostStatus['state'], string> = {
  unavailable: '暂不可用',
  unredeemed: '尚未兑换',
  active: '订阅有效',
  expired: '已到期',
  sync_pending: '等待同步',
}

export function CragRuntimeCounts({ status }: { status?: CragHostStatus }) {
  return (
    <p role='status' className='text-sm break-words tabular-nums'>
      {status?.runtime?.host_over_limit === true
        ? '宿主订阅超额，仅超额槽暂停调度'
        : status
          ? cragHostStatusLabels[status.state]
          : '状态待核对'}
      {' · 剩余可绑定槽位：'}
      {numberLabel(status?.available_seats)}
      {(status?.reclaim_pending_count ?? 0) > 0 && (
        <>
          {' · 待回收绑定：'}
          {status?.reclaim_pending_count}
        </>
      )}
      {status?.runtime && (
        <>
          {' · 运行中的订阅槽：'}
          {numberLabel(status.runtime.host_running_vms)}
        </>
      )}
    </p>
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
