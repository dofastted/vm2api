import { useId, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, isApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { CragRuntimeCounts } from './crag-runtime-counts'
import { cragSubscriptionErrors } from './crag-subscription-errors'
import {
  cragHostStatusQueryOptions,
  vmCragLicenseQueryOptions,
  type CragHostStatus,
} from './queries'

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
  const busy = host.isFetching || working

  async function perform(action: 'bind' | 'recover') {
    if (busy) return
    setWorking(true)
    setNotice(undefined)
    try {
      if (action === 'bind') {
        await api<{ seat: number }>(
          `/api/panel/vms/${encodeURIComponent(vmId)}/crag-license/bind`,
          {
            method: 'POST',
            body: '{}',
          }
        )
        setNotice({
          text: '本槽已绑定，开始运行调度后计入使用中的槽位。如内核尚未加载授权，请重启本槽。',
        })
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
          (isApiError(error) && cragSubscriptionErrors[error.code]) ||
          '无法确认订阅操作，请检查连接后重试。',
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
          宿主订阅（按槽位计）
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
      <CragRuntimeCounts status={host.isError ? undefined : status} />
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
          ? '上次订阅变更尚未同步。已在运行的槽不受影响；请点「继续同步」完成后，再进行新的绑定或兑换。'
          : '切换到 CRAG 内核不占槽位。只有绑定订阅且正在运行调度的 CRAG 槽计入使用中的槽位；本机与集群的 Docker、KVM 槽共用同一份充值可用槽位，用满后继续充值即可。绑定不会自动启动或重启槽位。'}
      </p>
      {status?.state === 'active' ? (
        <Button
          type='button'
          variant='outline'
          disabled={busy || host.isError}
          onClick={() => void perform('bind')}
        >
          用现有订阅绑定本槽
        </Button>
      ) : null}
    </section>
  )
}
