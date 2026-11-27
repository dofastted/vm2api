import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Clock3, Laptop, Link2, Radio, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  formatTtlLabel,
  MACHINE_TTL_MAX_SECONDS,
  MACHINE_TTL_MIN_SECONDS,
  POOL_LOCKED_DEFAULTS,
  SESSION_TTL_MAX_SECONDS,
  SESSION_TTL_MIN_SECONDS,
} from '@/features/pools/pool-rules'
import { TtlDurationInput } from '@/features/pools/ttl-input'

type Obj = Record<string, unknown>
type StickyDialog = 'binding' | 'machine_ttl' | 'session_ttl' | 'outbound'

type StickyPaneProps = {
  value: Obj
  onChange: (patch: Obj) => void
  saving?: boolean
  pending?: boolean
  pendingCards?: Partial<Record<'binding' | 'ttl' | 'outbound', boolean>>
}

function SummaryButton({
  icon: Icon,
  title,
  value,
  desc,
  pending,
  buttonRef,
  disabled,
  onClick,
}: {
  icon: LucideIcon
  title: string
  value: string
  desc: string
  pending: boolean
  buttonRef: (node: HTMLButtonElement | null) => void
  disabled: boolean
  onClick: () => void
}) {
  return (
    <Button
      ref={buttonRef}
      type='button'
      variant='outline'
      disabled={disabled}
      onClick={onClick}
      className='h-auto min-h-24 w-full min-w-0 justify-start gap-3 px-4 py-3 text-left'
    >
      <Icon className='size-4 shrink-0 text-primary' aria-hidden />
      <span className='min-w-0 flex-1'>
        <span className='flex items-center gap-2 text-xs text-muted-foreground'>
          <span className='truncate'>{title}</span>
          {pending ? (
            <span className='shrink-0 rounded bg-[color:var(--status-caution)]/15 px-1.5 py-0.5 text-[10px] text-[color:var(--status-caution)]'>
              待保存
            </span>
          ) : null}
        </span>
        <span className='block truncate text-sm font-semibold'>{value}</span>
        <span className='block truncate text-xs font-normal text-muted-foreground'>
          {desc}
        </span>
      </span>
    </Button>
  )
}

export function StickyPane({
  value: sticky,
  onChange,
  saving = false,
  pending = false,
  pendingCards,
}: StickyPaneProps) {
  const [dialog, setDialog] = useState<StickyDialog | null>(null)
  const [local, setLocal] = useState<Obj>({ ...sticky })
  const triggerRefs = useRef<
    Partial<Record<StickyDialog, HTMLButtonElement | null>>
  >({})
  const previousDialog = useRef<StickyDialog | null>(null)

  useEffect(() => {
    if (previousDialog.current && !dialog) {
      triggerRefs.current[previousDialog.current]?.focus()
    }
    previousDialog.current = dialog
  }, [dialog])

  const enabled = sticky.enabled !== false
  const machineTtl = Number(
    sticky.machine_ttl_seconds ?? POOL_LOCKED_DEFAULTS.machine_ttl_seconds
  )
  const sessionTtl = Number(
    sticky.session_ttl_seconds ??
      sticky.ttl_seconds ??
      POOL_LOCKED_DEFAULTS.session_ttl_seconds
  )
  const outbound = String(sticky.outbound_session || 'rebuild')

  const open = (kind: StickyDialog) => {
    if (saving) return
    setLocal({
      ...sticky,
      machine_ttl_seconds: machineTtl,
      session_ttl_seconds: sessionTtl,
    })
    setDialog(kind)
  }
  const close = () => {
    if (!saving) setDialog(null)
  }
  const apply = () => {
    if (!dialog || saving) return
    if (dialog === 'binding') {
      onChange({ enabled: local.enabled !== false })
    } else if (dialog === 'machine_ttl') {
      onChange({
        machine_ttl_seconds: Number(
          local.machine_ttl_seconds ?? POOL_LOCKED_DEFAULTS.machine_ttl_seconds
        ),
      })
    } else if (dialog === 'session_ttl') {
      const nextSession = Number(
        local.session_ttl_seconds ?? POOL_LOCKED_DEFAULTS.session_ttl_seconds
      )
      onChange({
        session_ttl_seconds: nextSession,
        ttl_seconds: nextSession,
      })
    } else {
      onChange({
        outbound_session: String(local.outbound_session || 'rebuild'),
      })
    }
    setDialog(null)
  }

  return (
    <div className='space-y-4'>
      <div>
        <h2 className='text-base font-semibold'>粘性</h2>
        <p className='mt-1 text-sm text-muted-foreground'>
          全局默认设备粘性（默认 7 天）与会话粘性（默认 24
          小时）参数；各分组池可在「
          <Link
            to='/pools'
            className='text-primary underline underline-offset-4'
          >
            分组池
          </Link>
          」独立覆写双级 TTL 与单会话 FIFO 队列参数。
        </p>
      </div>
      <div className='grid grid-cols-1 gap-3 lg:grid-cols-3'>
        <div>
          <SummaryButton
            icon={Link2}
            title='会话绑定'
            value={enabled ? '已启用' : '已停用'}
            desc='同一会话在 TTL 内优先回到绑定 VM；单轮结束即归还并发池席位'
            pending={pendingCards ? !!pendingCards.binding : pending}
            disabled={saving}
            buttonRef={(node) => {
              triggerRefs.current.binding = node
            }}
            onClick={() => open('binding')}
          />
        </div>
        <div>
          <SummaryButton
            icon={Laptop}
            title='默认设备粘性 TTL（machine_id）'
            value={formatTtlLabel(machineTtl)}
            desc='默认 7 天；同设备新会话优先命中主节点，满载即刻零惩罚溢出并保留主绑定'
            pending={pendingCards ? !!pendingCards.ttl : pending}
            disabled={saving}
            buttonRef={(node) => {
              triggerRefs.current.machine_ttl = node
            }}
            onClick={() => open('machine_ttl')}
          />
        </div>
        <div>
          <SummaryButton
            icon={Clock3}
            title='默认会话粘性 TTL（session_id）'
            value={formatTtlLabel(sessionTtl)}
            desc='默认 24 小时；仅记忆 session → VM 路由亲和，不占并发池席位；CLI 空闲进程回收见「协议 → 槽空闲超时」'
            pending={pendingCards ? !!pendingCards.ttl : pending}
            disabled={saving}
            buttonRef={(node) => {
              triggerRefs.current.session_ttl = node
            }}
            onClick={() => open('session_ttl')}
          />
        </div>
      </div>
      <Button
        type='button'
        variant='ghost'
        disabled={saving}
        ref={(node) => {
          triggerRefs.current.outbound = node
        }}
        className='h-auto min-h-11 w-full justify-start gap-2 px-2 py-2 text-left'
        onClick={() => open('outbound')}
      >
        <Radio className='size-4 text-muted-foreground' aria-hidden />
        <span>
          <span className='block text-sm font-medium'>
            出站 session · {outbound === 'passthrough' ? '透传' : '重建'}
            {(pendingCards ? !!pendingCards.outbound : pending) ? (
              <span className='ml-2 rounded bg-[color:var(--status-caution)]/15 px-1.5 py-0.5 text-[10px] font-normal text-[color:var(--status-caution)]'>
                待保存
              </span>
            ) : null}
          </span>
          <span className='block text-xs font-normal text-muted-foreground'>
            仅调整出站身份兼容策略
          </span>
        </span>
      </Button>
      <div className='rounded-lg border bg-muted/20 p-4 text-sm'>
        <h3 className='font-medium'>身份识别与双级粘性</h3>
        <p className='mt-2 leading-6 text-muted-foreground'>
          网关严格沿用 Claude Code 官方纯标准 UUIDv4 session
          契约（零附加响应头），并由 Rust 调度中心对同一会话强制 FIFO
          串行（单机占满默认「满了就换」立即切次优节点）。 设备粘性（默认 7
          天）与会话粘性（默认 24 小时）均按分组池与模型家族严格隔离；
          单轮请求结束即立即归还并发池席位，原生 CLI 空闲进程回收见「设置 → 协议
          → 槽空闲超时」。
        </p>
      </div>
      <Dialog
        open={dialog !== null}
        onOpenChange={(next) => {
          if (!next && !saving) close()
        }}
      >
        <DialogContent
          showCloseButton={!saving}
          className='flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-lg'
        >
          <DialogHeader>
            <DialogTitle>
              {dialog === 'binding'
                ? '会话绑定'
                : dialog === 'machine_ttl'
                  ? '默认设备粘性 TTL（machine_id）'
                  : dialog === 'session_ttl'
                    ? '默认会话粘性 TTL（session_id）'
                    : '出站 session'}
            </DialogTitle>
            <DialogDescription>
              应用到草稿后，仍需点击页面底部保存才会写入运行配置。
            </DialogDescription>
          </DialogHeader>
          <fieldset
            disabled={saving}
            className='min-h-0 flex-1 space-y-4 overflow-y-auto pr-1'
          >
            {dialog === 'binding' ? (
              <div className='flex items-center justify-between gap-4 rounded-lg border p-3'>
                <div>
                  <Label htmlFor='sticky-dialog-enabled'>启用绑定</Label>
                  <p className='mt-1 text-xs text-muted-foreground'>
                    同一会话在 TTL 内优先回到绑定
                    VM；单轮请求结束后立即归还并发池席位，不占用席位。
                  </p>
                </div>
                <Switch
                  id='sticky-dialog-enabled'
                  checked={local.enabled !== false}
                  onCheckedChange={(nextEnabled) =>
                    setLocal((current) => ({
                      ...current,
                      enabled: nextEnabled,
                    }))
                  }
                />
              </div>
            ) : null}
            {dialog === 'machine_ttl' ? (
              <div className='space-y-2'>
                <Label htmlFor='sticky-dialog-machine-ttl'>
                  默认设备粘性保持时间（默认 7 天，范围 1 分钟 ~ 30 天）
                </Label>
                <TtlDurationInput
                  id='sticky-dialog-machine-ttl'
                  seconds={Number(local.machine_ttl_seconds ?? machineTtl)}
                  minSeconds={MACHINE_TTL_MIN_SECONDS}
                  maxSeconds={MACHINE_TTL_MAX_SECONDS}
                  preferredUnit='days'
                  presets={[
                    3600, 21600, 86400, 259200, 604800, 1209600, 2592000,
                  ]}
                  disabled={saving}
                  onChange={(machine_ttl_seconds) =>
                    setLocal((current) => ({ ...current, machine_ttl_seconds }))
                  }
                />
                <p className='text-xs leading-5 text-muted-foreground'>
                  同一 machine_id 下的新会话在 TTL
                  内优先命中主节点；主节点占满时零惩罚立即溢出次优高权节点且保留原主绑定。
                </p>
              </div>
            ) : null}
            {dialog === 'session_ttl' ? (
              <div className='space-y-2'>
                <Label htmlFor='sticky-dialog-session-ttl'>
                  默认会话粘性保持时间（默认 24 小时，范围 1 分钟 ~ 7 天）
                </Label>
                <TtlDurationInput
                  id='sticky-dialog-session-ttl'
                  seconds={Number(local.session_ttl_seconds ?? sessionTtl)}
                  minSeconds={SESSION_TTL_MIN_SECONDS}
                  maxSeconds={SESSION_TTL_MAX_SECONDS}
                  preferredUnit='hours'
                  presets={[900, 3600, 21600, 86400, 259200, 604800]}
                  disabled={saving}
                  onChange={(session_ttl_seconds) =>
                    setLocal((current) => ({
                      ...current,
                      session_ttl_seconds,
                      ttl_seconds: session_ttl_seconds,
                    }))
                  }
                />
                <p className='text-xs leading-5 text-muted-foreground'>
                  仅记忆 session → VM
                  路由亲和，单轮请求结束即立即归还并发池席位，不占用席位。原生
                  Claude CLI 空闲进程回收由「设置 → 协议 → 槽空闲超时」控制。
                </p>
              </div>
            ) : null}
            {dialog === 'outbound' ? (
              <div className='space-y-2'>
                <Label htmlFor='sticky-dialog-outbound'>出站身份</Label>
                <Select
                  value={String(local.outbound_session || 'rebuild')}
                  onValueChange={(outbound_session) =>
                    setLocal((current) => ({
                      ...current,
                      outbound_session,
                    }))
                  }
                >
                  <SelectTrigger
                    id='sticky-dialog-outbound'
                    className='min-h-11'
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='rebuild'>重建</SelectItem>
                    <SelectItem value='passthrough'>透传</SelectItem>
                  </SelectContent>
                </Select>
                <p className='text-xs leading-5 text-muted-foreground'>
                  透传依赖上游接受调用方 session；重建由网关生成稳定的出站身份。
                </p>
              </div>
            ) : null}
          </fieldset>
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              disabled={saving}
              className='min-h-11'
              onClick={close}
            >
              取消
            </Button>
            <Button
              type='button'
              disabled={saving}
              className='min-h-11'
              onClick={apply}
            >
              应用到草稿
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
