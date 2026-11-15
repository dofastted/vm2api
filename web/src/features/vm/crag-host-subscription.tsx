import { useId, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, isApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  cragHostStatusQueryOptions,
  vmCragLicenseQueryOptions,
  type CragHostStatus,
} from './queries'

const statusLabels: Record<CragHostStatus['state'], string> = {
  unavailable: '暂不可用',
  unredeemed: '尚未兑换',
  active: '订阅有效',
  expired: '订阅已到期',
  sync_pending: '等待同步',
}
const root = '/api/panel/crag-subscription'

export function CragHostSubscription({ vmId }: { vmId: string }) {
  const id = useId()
  const qc = useQueryClient()
  const options = cragHostStatusQueryOptions()
  const host = useQuery(options)
  const [working, setWorking] = useState(false)
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>()
  const status = host.data
  const pending = status?.state === 'sync_pending'
  const ready = status?.ready && !pending && !host.isError
  const busy = host.isFetching || working

  async function perform(action: 'bind' | 'recover') {
    if (busy) return
    setWorking(true)
    setNotice(undefined)
    try {
      if (action === 'bind') {
        const result = await api<{ seat: number }>(
          `/api/panel/vms/${encodeURIComponent(vmId)}/crag-license/bind`,
          {
            method: 'POST',
            body: '{}',
          }
        )
        setNotice({ text: `本槽已绑定应用锁 ${result.seat}。` })
      } else {
        const next = await api<CragHostStatus>(`${root}/${action}`, {
          method: 'POST',
          body: '{}',
        })
        qc.setQueryData(options.queryKey, next)
      }
    } catch (error) {
      setNotice({
        text:
          isApiError(error) && error.code === 'slot_limit_reached'
            ? '应用锁额度已用完。本槽未绑定。'
            : '操作未确认。请先刷新宿主机订阅状态，再按提示重试。',
        error: true,
      })
    } finally {
      await Promise.all([
        qc.invalidateQueries({ queryKey: options.queryKey }),
        qc.invalidateQueries({
          queryKey: vmCragLicenseQueryOptions(vmId).queryKey,
        }),
      ])
      setWorking(false)
    }
  }

  return (
    <section
      className='min-w-0 space-y-3 border-t pt-4'
      aria-labelledby={`${id}-heading`}
      aria-busy={busy}
    >
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <h4 id={`${id}-heading`} className='text-sm font-medium'>
          宿主机订阅
        </h4>
        <Button
          type='button'
          variant='ghost'
          disabled={busy}
          onClick={() =>
            pending ? void perform('recover') : void host.refetch()
          }
        >
          {pending ? '继续同步' : '刷新订阅'}
        </Button>
      </div>
      <p role='status' className='text-sm break-words tabular-nums'>
        {status ? statusLabels[status.state] : '正在读取宿主机订阅…'}
        {status?.slot_limit != null
          ? ` · ${status.slot_limit === 'unlimited' ? '不限应用锁' : `${status.slot_limit} 把应用锁`}`
          : ''}
        {status?.expires_at
          ? ` · 到期 ${new Date(status.expires_at * 1000).toLocaleString()}`
          : ''}
      </p>
      {host.isError ? (
        <p role='alert' className='text-sm text-destructive'>
          读取失败。请刷新订阅后重试。
        </p>
      ) : null}
      {notice ? (
        <p
          role={notice.error ? 'alert' : 'status'}
          className={notice.error ? 'text-sm text-destructive' : 'text-sm'}
        >
          {notice.text}
        </p>
      ) : null}
      <p className='text-sm text-muted-foreground'>
        {pending
          ? '同步完成前，订阅槽不会接收新请求。手动激活中断请在原槽提交原码；自动激活中断请回原订单处理。'
          : '订阅只绑定一台宿主机。仅支持本机 Linux Docker 的 Claude 槽；需要已安装支持订阅的可信 CRAG 包，并就绪只读挂载。'}
      </p>
      {status?.state === 'active' ? (
        <Button
          type='button'
          variant='outline'
          disabled={!ready || busy}
          onClick={() => void perform('bind')}
        >
          用现有订阅绑定本槽
        </Button>
      ) : null}
    </section>
  )
}
