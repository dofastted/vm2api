import { useId, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, isApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { CragRuntimeCounts } from './crag-runtime-counts'
import {
  cragHostStatusQueryOptions,
  vmCragLicenseQueryOptions,
  type CragHostStatus,
} from './queries'

const root = '/api/panel/crag-subscription'

/**
 * 宿主订阅（按槽位计）相关错误码的唯一文案表。授权编辑器展开复用它，
 * 同一个错误码不在两处各写一句。
 *
 * 用户侧只有两个数字：「充值可用槽位」与「使用中的槽位」（真正在运行调度的
 * CRAG 内核数）。文案只引用这两个名字，满了就引导继续充值。
 */
export const cragSubscriptionErrors: Record<string, string> = {
  slot_limit_reached:
    '使用中的槽位已达到充值可用槽位。请继续充值，或先停止其他正在运行的 CRAG 槽。',
  host_subscription_inactive:
    '本机没有有效订阅。请在「订阅 CRAG」充值并兑换后再绑定。',
  host_binding_conflict: '此槽的设备身份与原绑定不一致，未绑定。',
  crag_subscription_target_unready:
    '此槽暂不能绑定订阅。请确认使用可信 CRAG 包，且未绑定其他有效授权。',
  crag_subscription_target_changed: '目标槽或内核已变化，请核对后重试。',
  crag_subscription_sync_pending:
    '上次订阅变更尚未同步。请先点「继续同步」完成，再进行新的绑定或兑换。',
  crag_subscription_authority_unavailable:
    '尚未确认操作结果，请在同一目标槽重试，不必重新购买。',
  payload_key_unknown:
    '授权服务未登记此内核载荷。已到账的槽位会保留，可在兼容槽位使用。',
  payload_key_conflict:
    '内核版本冲突：本槽或此码已绑定另一版 CRAG 内核包，未能换签。请改用原内核版本。',
  license_payload_key_mismatch:
    '注册码对应另一版 CRAG 内核。请复制含载荷 ID 的机器码，向授权方申请匹配当前版本的注册码。',
  redeem_unavailable: '订阅兑换码无效、已过期或已使用，请核对原码。',
  host_redeem_conflict: '此订阅兑换码已在其他宿主机兑换，不能用于本机。',
  not_found: '授权服务找不到当前宿主机的订阅或槽位。',
  auth_forbidden: '授权服务不接受当前宿主机的订阅凭据。',
}

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
