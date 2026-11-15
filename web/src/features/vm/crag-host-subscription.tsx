import { useId, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, isApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { vmCragLicenseQueryOptions } from './queries'

type HostStatus = {
  ready: boolean
  state: 'unavailable' | 'unredeemed' | 'active' | 'expired' | 'sync_pending'
  slot_limit?: number | 'unlimited'
  expires_at?: number
}

const statusLabels: Record<HostStatus['state'], string> = {
  unavailable: '暂不可用',
  unredeemed: '尚未兑换',
  active: '订阅有效',
  expired: '订阅已到期',
  sync_pending: '等待同步',
}
const root = '/api/panel/crag-subscription'
const queryKey = ['crag-host-subscription'] as const

export function CragHostSubscription({ vmId }: { vmId: string }) {
  const id = useId()
  const qc = useQueryClient()
  const host = useQuery({
    queryKey,
    queryFn: () => api<HostStatus>(root),
    retry: false,
  })
  const [code, setCode] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [working, setWorking] = useState(false)
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>()
  const status = host.data
  const pending = status?.state === 'sync_pending'
  const ready = status?.ready && !pending && !host.isError
  const usableCode = /^CRAGR1\.[A-Za-z0-9_-]{43}$/.test(code.trim())
  const busy = host.isFetching || working

  async function perform(action: 'redeem' | 'bind' | 'recover') {
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
        const next = await api<HostStatus>(`${root}/${action}`, {
          method: 'POST',
          body:
            action === 'redeem'
              ? JSON.stringify({ redemption_code: code.trim() })
              : '{}',
        })
        qc.setQueryData(queryKey, next)
        if (action === 'redeem') {
          setCode('')
          setNotice({
            text: '宿主机权益已更新。绑定应用锁后，本槽才能使用订阅授权。',
          })
        }
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
      setConfirming(false)
      await Promise.all([
        qc.invalidateQueries({ queryKey }),
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
          ? '同步完成前，已绑定的订阅槽不会接收新请求。请继续同步，不要提交另一张兑换码。'
          : '订阅只绑定一台宿主机。仅支持本机 Linux Docker 的 Claude 槽；需要已安装支持订阅的可信 CRAG 包，并就绪只读挂载。'}
      </p>
      <div className='space-y-2'>
        <Label htmlFor={id}>宿主机兑换码</Label>
        <Textarea
          id={id}
          rows={2}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          disabled={!ready || busy}
          autoComplete='off'
          autoCapitalize='none'
          spellCheck={false}
          maxLength={256}
          placeholder='CRAGR1.…'
        />
      </div>
      <div className='flex flex-wrap gap-2'>
        <Button
          type='button'
          disabled={!ready || busy || !usableCode}
          onClick={() => setConfirming(true)}
        >
          兑换到本机
        </Button>
        <Button
          type='button'
          variant='outline'
          disabled={!ready || busy || status?.state !== 'active'}
          onClick={() => void perform('bind')}
        >
          给本槽绑定应用锁
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!working) setConfirming(open)
        }}
        title='确认兑换到本机？'
        confirmText='确认兑换'
        cancelBtnText='取消'
        desc='兑换后不可转到其他宿主机。未用完的有效期会叠加；新套餐的应用锁额度会立即替换现有额度。超出新额度的槽按绑定顺序停止接收新请求。请先核对原订单中的额度与期限。'
        isLoading={working}
        disabled={!ready || !usableCode}
        handleConfirm={() => void perform('redeem')}
      />
    </section>
  )
}
