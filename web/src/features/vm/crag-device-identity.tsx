import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/confirm-dialog'
import type { CragHostStatus } from './queries'

/** 订单号形状，与授权服务对该列的 CHECK 一致。 */
const validOrderId = (value: string) => /^[0-9a-zA-Z_-]{1,64}$/.test(value)

/**
 * 本机的设备标识，以及换机所需的两个动作：迁入与注销。
 *
 * 面板上展示 UUID 是为了报障时有东西可引用 —— 协议里走的仍是它派生出的 64 位
 * host id，这里只是同一标识的可读形式。**UUID 本身不是迁移凭据**：它就印在这个
 * 面板上，若它足够，看见的人都能把订阅认领走。
 *
 * 迁移凭据是**购买时的订单号**。券码虽然也能用，但免登录购买从不回显券码，而取回
 * 它需要只存在于原机器上的收据密钥 —— 所以机器一旦重装或销毁，订单号就是用户手里
 * 唯一还剩下的东西。迁入不需要原机器在线，这正是它能救「机器已经没了」的原因。
 */
export function CragDeviceIdentity({
  status,
  busy,
  onUnbind,
  onClaim,
}: {
  status?: CragHostStatus
  busy: boolean
  onUnbind: () => void
  onClaim: (orderId: string) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [claiming, setClaiming] = useState(false)
  const [orderId, setOrderId] = useState('')
  const [copied, setCopied] = useState(false)
  const uuid = status?.device_uuid
  if (!uuid) return null
  const retirable = status?.state === 'active' || status?.state === 'expired'
  const trimmed = orderId.trim()

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
      {/* 迁入不要求本机已有订阅：换机的常态恰恰是新机器还是空的。 */}
      <Button
        type='button'
        variant='ghost'
        disabled={busy}
        onClick={() => {
          setOrderId('')
          setClaiming(true)
        }}
      >
        从其他设备迁移
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
        open={claiming}
        onOpenChange={(open) => {
          if (!open && !busy) setClaiming(false)
        }}
        isLoading={busy}
        cancelBtnText='取消'
        confirmText='迁移到本机'
        disabled={!validOrderId(trimmed)}
        title='从其他设备迁移订阅'
        handleConfirm={() => {
          if (!validOrderId(trimmed)) return
          setClaiming(false)
          onClaim(trimmed)
        }}
        desc={
          <div className='space-y-2 text-sm'>
            <p>
              输入<strong>购买时的订单号</strong>，这张兑换券会带着
              <strong>剩余时长</strong>迁到本机，不重新起算、也不白送时长。
            </p>
            <p className='text-muted-foreground'>
              不需要原机器在线 —— 它已经重装或销毁也能迁。迁移后原机器上这张券的
              额度立即失效，其余兑换券不受影响。
            </p>
          </div>
        }
      >
        <Input
          value={orderId}
          onChange={(event) => setOrderId(event.target.value)}
          placeholder='订单号，例如 3f8a1c2e-...'
          autoComplete='off'
          spellCheck={false}
          aria-label='订单号'
        />
      </ConfirmDialog>
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
              <strong>购买时的订单号</strong>（或原券码）迁移即可继承。
            </p>
            <p className='text-muted-foreground'>
              换机其实不必先注销：直接在新机器上「从其他设备迁移」即可。注销适合
              本机不再使用、且想立刻停掉它的情形。
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
