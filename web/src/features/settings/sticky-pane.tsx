import { useEffect, useRef, useState } from 'react'
import { Clock3, Link2, Radio, type LucideIcon } from 'lucide-react'
import { fmtDuration } from '@/lib/format'
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
import { withCurrent } from '@/features/vm/scheduling-steps'

type Obj = Record<string, unknown>
type StickyDialog = 'binding' | 'ttl' | 'outbound'

type StickyPaneProps = {
  value: Obj
  onChange: (patch: Obj) => void
  saving?: boolean
  pending?: boolean
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

  const open = (kind: StickyDialog) => {
    if (saving) return
    setLocal({ ...sticky })
    setDialog(kind)
  }
  const close = () => {
    if (!saving) setDialog(null)
  }
  const apply = () => {
    if (!dialog || saving) return
    if (dialog === 'binding') {
      onChange({ enabled: local.enabled !== false })
    } else if (dialog === 'ttl') {
      onChange({ ttl_seconds: Number(local.ttl_seconds ?? 86400) })
    } else {
      onChange({
        outbound_session: String(local.outbound_session || 'rebuild'),
      })
    }
    setDialog(null)
  }
  const enabled = sticky.enabled !== false
  const ttl = Number(sticky.ttl_seconds ?? 86400)
  const outbound = String(sticky.outbound_session || 'rebuild')
  const ttlOptions = withCurrent(
    [3600, 21600, 86400, 604800, 2592000].map((seconds): [number, string] => [
      seconds,
      fmtDuration(seconds * 1000),
    ]),
    ttl
  )

  return (
    <div className='space-y-4'>
      <div>
        <h2 className='text-base font-semibold'>粘性</h2>
        <p className='mt-1 text-sm text-muted-foreground'>
          当前配置由 Claude 与 OpenAI 共享；绑定记录和两个平台的回路不同。
        </p>
      </div>
      <div className='grid grid-cols-1 gap-3 lg:grid-cols-2'>
        <div>
          <SummaryButton
            icon={Link2}
            title='会话绑定'
            value={enabled ? '已启用' : '已停用'}
            desc='优先回到绑定 VM；session 占着的槽位跟这个绑定一起留'
            pending={pending}
            disabled={saving}
            buttonRef={(node) => {
              triggerRefs.current.binding = node
            }}
            onClick={() => open('binding')}
          />
        </div>
        <div>
          <SummaryButton
            icon={Clock3}
            title='绑定保持时间'
            value={fmtDuration(ttl * 1000)}
            desc='绑定 TTL，也是请求结束后 session 继续占槽的时间'
            pending={pending}
            disabled={saving}
            buttonRef={(node) => {
              triggerRefs.current.ttl = node
            }}
            onClick={() => open('ttl')}
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
            {pending ? (
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
        <h3 className='font-medium'>身份识别与平台回路</h3>
        <p className='mt-2 leading-6 text-muted-foreground'>
          网关先取调用方显式 session，再按现有回退路径提取身份。Claude
          保留设备/席位亲和； OpenAI
          保留绑定账号与忙时借槽，previous_response_id 不能跨账号任意续接。 旧
          mode、header_keys 和 body_keys
          继续保存在路由配置中，但不在此提供没有生效路径的编辑器。
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
                : dialog === 'ttl'
                  ? '绑定保持时间'
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
                    同一来源在 TTL 内优先回到原账号。
                  </p>
                </div>
                <Switch
                  id='sticky-dialog-enabled'
                  checked={local.enabled !== false}
                  onCheckedChange={(enabled) =>
                    setLocal((current) => ({ ...current, enabled }))
                  }
                />
              </div>
            ) : null}
            {dialog === 'ttl' ? (
              <div className='space-y-2'>
                <Label htmlFor='sticky-dialog-ttl'>绑定保持时间</Label>
                <Select
                  value={String(local.ttl_seconds ?? ttl)}
                  onValueChange={(next) =>
                    setLocal((current) => ({
                      ...current,
                      ttl_seconds: Number(next),
                    }))
                  }
                >
                  <SelectTrigger id='sticky-dialog-ttl' className='min-h-11'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ttlOptions.map(([seconds, label]) => (
                      <SelectItem key={seconds} value={String(seconds)}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
