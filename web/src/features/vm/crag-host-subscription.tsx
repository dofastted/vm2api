import { useId, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, isApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { CragDeviceIdentity } from './crag-device-identity'
import { CragQuotaGrants } from './crag-quota-grants'
import { CragRuntimeCounts } from './crag-runtime-counts'
import {
  cragCredentialRecoveryFaults,
  cragSubscriptionErrors,
} from './crag-subscription-errors'
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

  async function perform(action: 'bind' | 'recover' | 'unbind') {
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
        const next = await api<
          CragHostStatus & { released?: { released_codes?: string[] } }
        >(`${root}/${action}`, {
          method: 'POST',
          body: '{}',
        })
        qc.setQueryData(options.queryKey, next)
        if (action === 'unbind') {
          // 说清被释放的张数，因为能迁走的恰好是这些 —— 而用户得自己有那些券码。
          const count = next.released?.released_codes?.length ?? 0
          setNotice({
            text: count
              ? `本机订阅已注销，${count} 张兑换券已释放并保留剩余时长。在新机器上用原券码兑换即可继承。`
              : '本机订阅已注销。没有仍在有效期内的兑换券可供转移。',
          })
        }
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
      {status?.credential_recovery ? (
        <p role='alert' className='text-sm text-destructive'>
          {cragCredentialRecoveryFaults[status.credential_recovery] ??
            cragSubscriptionErrors.auth_forbidden}
        </p>
      ) : null}
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
      <CragQuotaGrants status={host.isError ? undefined : status} />
      <CragDeviceIdentity
        status={host.isError ? undefined : status}
        busy={busy}
        onUnbind={() => void perform('unbind')}
      />
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
