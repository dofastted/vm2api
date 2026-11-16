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
const operationErrors: Record<string, string> = {
  slot_limit_reached: '订阅槽位额度已用完。',
  host_subscription_inactive: '本机没有有效订阅，请兑换或续费。',
  host_binding_conflict: '此槽的设备身份与原绑定不一致。',
  crag_subscription_target_unready:
    '此槽不兼容订阅，或尚未配置可信的 CRAG 包。',
  crag_subscription_target_changed: '槽位或内核已变更，请确认目标后重试。',
  crag_subscription_sync_pending: '上次订阅变更尚未同步，请先完成同步。',
  payload_key_unknown: '鉴权服务未登记此 CRAG 包的载荷密钥。',
  payload_key_conflict: '此槽仍绑定旧 CRAG 包，未能换签。',
  license_payload_key_mismatch: '签发的许可与此槽的 CRAG 包不匹配。',
  not_found: '鉴权服务找不到当前宿主机的订阅或槽位。',
  auth_forbidden: '鉴权服务不接受当前宿主机的订阅凭据。',
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
          text: '本槽已绑定。如内核尚未加载授权，请重启本槽。',
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
          (isApiError(error) && operationErrors[error.code]) ||
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
          ? '同步完成前，订阅槽不会接收新请求。手动激活中断时，请在原槽提交原码；自动激活中断时，请处理原订单。'
          : '本机与集群的 Docker、KVM 槽共享订阅额度。绑定不会自动启动或重启槽位。'}
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
