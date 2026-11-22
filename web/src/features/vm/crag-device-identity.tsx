import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import type { CragHostStatus } from './queries'

/**
 * 本机的设备标识，以及注销它的入口。
 *
 * 面板上展示 UUID 是为了报障时有东西可引用 —— 协议里走的仍是它派生出的 64 位
 * host id，这里只是同一标识的可读形式。
 *
 * 注销的文案必须把「要用原兑换券才能在新机恢复」说在动手之前。授权服务从不回显
 * 券码（连持有者也不回显），所以注销后没有任何办法再要一份；而**只凭 UUID 迁移
 * 是做不到的** —— UUID 就印在这个面板上，若它本身足够，看见的人都能把订阅认领走。
 * 换机必须有一个秘密跟着走，而那个秘密就是券码。
 */
export function CragDeviceIdentity({
  status,
  busy,
  onUnbind,
}: {
  status?: CragHostStatus
  busy: boolean
  onUnbind: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [copied, setCopied] = useState(false)
  const uuid = status?.device_uuid
  if (!uuid) return null
  const retirable = status?.state === 'active' || status?.state === 'expired'

  return (
    <div className='flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm'>
      <span className='text-muted-foreground'>设备标识</span>
      <code className='min-w-0 font-mono text-xs wrap-anywhere select-all'>
        {uuid}
      </code>
      <Button
        type='button'
        variant='ghost'
        onClick={() => {
          void navigator.clipboard?.writeText(uuid).then(
            () => setCopied(true),
            // 复制失败不提示失败：标识本身带 select-all，手动选中照样能取。
            () => {}
          )
        }}
      >
        {copied ? '已复制' : '复制'}
      </Button>
      {retirable ? (
        <Button
          type='button'
          variant='ghost'
          className='text-destructive'
          disabled={busy}
          onClick={() => setConfirming(true)}
        >
          注销本机订阅
        </Button>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title='注销本机订阅？'
        destructive
        isLoading={busy}
        cancelBtnText='取消'
        confirmText='注销'
        handleConfirm={() => {
          setConfirming(false)
          onUnbind()
        }}
        desc={
          <div className='space-y-2 text-sm'>
            <p>
              本机的订阅会从授权服务移除，已绑定的槽位随之失效。每张还在有效期内
              的兑换券会带着<strong>剩余时长</strong>被释放 —— 在新机器上用
              <strong>原兑换券码</strong>兑换即可继承，不会重新起算、
              也不会白送时长。
            </p>
            <p className='text-destructive'>
              必须你自己还留着那些券码：授权服务不会回显券码，注销后也没有办法
              再要一份。只凭这个设备标识是无法把订阅迁走的。
            </p>
            <p className='text-muted-foreground'>
              注销后短期内不能再次注销（转移冷却期）。
            </p>
          </div>
        }
      />
    </div>
  )
}
