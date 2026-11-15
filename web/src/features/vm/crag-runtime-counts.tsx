import type { CragHostStatus, CragRuntimeVm } from './queries'

const numberLabel = (value: number | 'unlimited' | null | undefined) =>
  value === 'unlimited' ? '不限' : (value ?? '待核对')

export function CragRuntimeCounts({ status }: { status?: CragHostStatus }) {
  const runtime = status?.runtime
  const quota = status?.slot_limit
  const redeemed =
    status?.state === 'unredeemed'
      ? '尚未兑换'
      : quota == null
        ? '待核对'
        : `${numberLabel(quota)}${status?.state === 'expired' ? '（已到期）' : ''}`
  const rows = [
    ['已兑换槽位', redeemed],
    ['宿主机服役', numberLabel(runtime?.host_running_vms)],
    ['可用运行名额', numberLabel(runtime?.host_runtime_available)],
    [
      'CRAG 服役 / 可用',
      `${numberLabel(runtime?.running_vms)} / ${numberLabel(runtime?.ready_vms)}`,
    ],
  ]
  return (
    <div className='mt-3 space-y-2'>
      <dl className='grid grid-cols-2 gap-x-4 gap-y-2 text-sm'>
        {rows.map(([label, value]) => (
          <div key={label} className='min-w-0'>
            <dt className='text-xs text-muted-foreground'>{label}</dt>
            <dd className='mt-0.5 font-medium tabular-nums'>{value}</dd>
          </div>
        ))}
      </dl>
      {runtime?.host_over_limit === true ? (
        <p role='status' className='text-sm text-destructive'>
          已暂停宿主机 CRAG 调用
        </p>
      ) : runtime?.host_over_limit == null &&
        status?.state !== 'unredeemed' &&
        status?.state !== 'expired' ? (
        <p className='text-sm text-muted-foreground'>宿主机运行额度待核对</p>
      ) : null}
      {runtime && (runtime.unknown_vms > 0 || runtime.host_unknown_vms > 0) ? (
        <p className='text-xs text-muted-foreground'>
          待核对：运行状态 {runtime.unknown_vms} 台，宿主机用量{' '}
          {runtime.host_unknown_vms} 台
        </p>
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
      <p>CRAG：{state}</p>
      {fields.length > 0 ? (
        <p className='text-xs wrap-anywhere text-muted-foreground tabular-nums'>
          {fields.join(' · ')}
        </p>
      ) : null}
    </div>
  )
}
