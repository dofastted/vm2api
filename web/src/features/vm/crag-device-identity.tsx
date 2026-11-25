import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/confirm-dialog'
import type { CragHostStatus } from './queries'

/** 订单号形状，与授权服务对该列的 CHECK 一致。 */
const validOrderId = (value: string) => /^[0-9a-zA-Z_-]{1,64}$/.test(value)

/** 64 位宿主机 ID 或 32 位 / 带连字符设备 UUID。 */
const validHostOrUuid = (value: string) => {
  const trimmed = value.trim().toLowerCase()
  if (/^[a-f0-9]{64}$/.test(trimmed)) return true
  const flat = trimmed.replace(/-/g, '')
  return /^[a-f0-9]{32}$/.test(flat) && !/^(0{32}|f{32})$/.test(flat)
}

export function CragDeviceIdentity({
  status,
  busy,
  onUnbind,
  onClaim,
  onMigrateHost,
}: {
  status?: CragHostStatus
  busy: boolean
  onUnbind: () => void
  onClaim: (orderId: string) => void
  onMigrateHost?: (fromHostId: string) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [claiming, setClaiming] = useState(false)
  const [migrateMode, setMigrateMode] = useState<'host' | 'order'>(
    onMigrateHost ? 'host' : 'order'
  )
  const [orderId, setOrderId] = useState('')
  const [fromHostId, setFromHostId] = useState('')
  const [copied, setCopied] = useState(false)
  const [copiedHost, setCopiedHost] = useState(false)
  const uuid = status?.device_uuid
  const hostId = status?.host_id
  if (!uuid && !hostId) return null
  const retirable = status?.state === 'active' || status?.state === 'expired'
  const trimmedOrder = orderId.trim()
  const trimmedHost = fromHostId.trim()
  const useHostMode = Boolean(onMigrateHost) && migrateMode === 'host'
  const canSubmitMigration = useHostMode
    ? validHostOrUuid(trimmedHost) && trimmedHost.toLowerCase() !== hostId
    : validOrderId(trimmedOrder)

  return (
    <div className='flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm'>
      {hostId ? (
        <>
          <span className='text-muted-foreground'>宿主机 ID</span>
          <code className='min-w-0 font-mono text-xs wrap-anywhere select-all'>
            {hostId}
          </code>
          <Button
            type='button'
            variant='ghost'
            onClick={() => {
              void navigator.clipboard?.writeText(hostId).then(
                () => setCopiedHost(true),
                () => {}
              )
            }}
          >
            {copiedHost ? '已复制' : '复制'}
          </Button>
        </>
      ) : null}
      {uuid ? (
        <>
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
        </>
      ) : null}
      {/* 迁入不要求本机已有订阅：换机的常态恰恰是新机器还是空的。 */}
      <Button
        type='button'
        variant='ghost'
        disabled={busy}
        onClick={() => {
          setOrderId('')
          setFromHostId('')
          setMigrateMode(onMigrateHost ? 'host' : 'order')
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
        disabled={!canSubmitMigration}
        title='从其他设备迁移订阅'
        handleConfirm={() => {
          if (!canSubmitMigration) return
          setClaiming(false)
          if (useHostMode && onMigrateHost) {
            onMigrateHost(trimmedHost)
          } else {
            onClaim(trimmedOrder)
          }
        }}
        desc={
          <div className='space-y-2 text-sm'>
            {onMigrateHost ? (
              <div className='flex flex-wrap gap-2'>
                <Button
                  type='button'
                  size='sm'
                  variant={useHostMode ? 'default' : 'outline'}
                  onClick={() => setMigrateMode('host')}
                >
                  按原宿主机 ID 整机迁移
                </Button>
                <Button
                  type='button'
                  size='sm'
                  variant={!useHostMode ? 'default' : 'outline'}
                  onClick={() => setMigrateMode('order')}
                >
                  按单个订单号迁入
                </Button>
              </div>
            ) : null}
            {useHostMode ? (
              <>
                <p>
                  输入<strong>原宿主机 ID（64 位十六进制）或设备 UUID</strong>
                  ，将原宿主机的全部有效兑换券、剩余有效期与历史订单一次性迁移到本机。
                </p>
                <p className='text-muted-foreground'>
                  迁移后原宿主机将自动解绑，本机立即生效，无冷却期限制。
                </p>
              </>
            ) : (
              <>
                <p>
                  输入<strong>购买时的订单号</strong>，这张兑换券会带着
                  <strong>剩余时长</strong>迁到本机，不重新起算、也不白送时长。
                </p>
                <p className='text-muted-foreground'>
                  不需要原机器在线 ——
                  它已经重装或销毁也能迁。迁移后原机器上这张券的
                  额度立即解绑并重新绑定到本机。
                </p>
              </>
            )}
          </div>
        }
      >
        {useHostMode ? (
          <Input
            value={fromHostId}
            onChange={(event) => setFromHostId(event.target.value)}
            placeholder='原宿主机 ID（64 位十六进制）或设备 UUID'
            autoComplete='off'
            spellCheck={false}
            aria-label='原宿主机 ID'
          />
        ) : (
          <Input
            value={orderId}
            onChange={(event) => setOrderId(event.target.value)}
            placeholder='订单号，例如 3f8a1c2e-...'
            autoComplete='off'
            spellCheck={false}
            aria-label='订单号'
          />
        )}
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
              <strong>宿主机 ID 迁移</strong>、<strong>订单号</strong>
              或原券码即可继承。
            </p>
            <p className='text-muted-foreground'>
              换机不必先注销：直接在新机器上「从其他设备迁移」即可自动解绑旧宿主机并绑定到新宿主机，无冷却期限制。
            </p>
          </div>
        }
      />
    </div>
  )
}
