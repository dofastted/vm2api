import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { type NoVncHandle, NoVncViewer } from '@/components/novnc-viewer-lazy'

type DesktopStatus = {
  enabled: boolean
  supported: boolean
  state: 'running' | 'stale' | 'absent' | 'unsupported'
  reason?: string
  image: string
  container?: string
}

const UNSUPPORTED_TEXT: Record<string, string> = {
  no_container: 'Codex 槽位没有槽容器，不支持浏览器桌面。',
  kvm_unsupported: 'KVM 槽位暂不支持浏览器桌面。',
  native_node_unsupported: 'macOS 原生节点上的槽位不支持浏览器桌面。',
}

const STATE_TEXT: Record<DesktopStatus['state'], string> = {
  running: '运行中',
  stale: '待同步（槽位重启后会在打开时自动重连网络）',
  absent: '未运行',
  unsupported: '不支持',
}

/**
 * Browser desktop that shares this slot's egress. Admin-only (server ACL);
 * the companion container is started on slot start when enabled.
 */
export function VmDesktopCard({ vm }: { vm: Vm }) {
  const id = vm.id
  const root = `/api/panel/vms/${encodeURIComponent(id)}`
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [clip, setClip] = useState('')
  const frameRef = useRef<HTMLDivElement>(null)
  const viewer = useRef<NoVncHandle | null>(null)

  const status = useQuery({
    queryKey: ['vm-desktop', id],
    queryFn: () =>
      api<DesktopStatus>(`/api/panel/vms/${encodeURIComponent(id)}/desktop`),
    refetchInterval: open ? false : 15_000,
  })
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api<{ enabled: boolean; state: string }>(`${root}/desktop`, {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: (r) => {
      if (!r.enabled) setOpen(false)
      if (r.state === 'pending_slot_start')
        toast.info('已启用，槽位启动后自动拉起桌面')
      void qc.invalidateQueries({ queryKey: ['vm-desktop', id] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const s = status.data
  if (status.isError || (s && !s.supported)) {
    const text = status.isError
      ? `读取桌面状态失败：${status.error instanceof Error ? status.error.message : String(status.error)}`
      : UNSUPPORTED_TEXT[s?.reason || ''] || '当前槽位不支持浏览器桌面。'
    return <p className='text-sm text-muted-foreground'>{text}</p>
  }

  const goFullscreen = () => {
    const el = frameRef.current
    if (!el) return
    const sync = () => {
      setFullscreen(document.fullscreenElement === el)
      if (document.fullscreenElement !== el)
        el.removeEventListener('fullscreenchange', sync)
    }
    el.addEventListener('fullscreenchange', sync)
    void el.requestFullscreen?.()
  }

  return (
    <Card>
      <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
        <CardTitle className='text-sm'>浏览器桌面</CardTitle>
        <div className='flex items-center gap-2 text-xs text-muted-foreground'>
          <span>{s ? (s.enabled ? STATE_TEXT[s.state] : '未启用') : '…'}</span>
          <Switch
            checked={!!s?.enabled}
            disabled={!s || toggle.isPending}
            onCheckedChange={(v) => toggle.mutate(v)}
          />
        </div>
      </CardHeader>
      <CardContent className='space-y-3 pt-0'>
        {open ? (
          <>
            <div
              ref={frameRef}
              className={
                fullscreen
                  ? 'h-screen w-screen'
                  : 'h-[calc(100vh-280px)] min-h-[480px]'
              }
            >
              <NoVncViewer
                ticketPath={`${root}/desktop-ticket`}
                socketPath={`${root}/desktop/ws`}
                handleRef={viewer}
                onPhase={(p) => {
                  if (p === 'open')
                    void qc.invalidateQueries({ queryKey: ['vm-desktop', id] })
                }}
              />
            </div>
            <div className='flex flex-wrap items-center gap-2'>
              <Input
                className='h-8 max-w-xs'
                placeholder='粘贴到桌面剪贴板（验证码等）'
                value={clip}
                onChange={(e) => setClip(e.target.value)}
              />
              <Button
                size='sm'
                variant='outline'
                disabled={!clip}
                onClick={() => {
                  viewer.current?.paste(clip)
                  setClip('')
                  toast.success('已写入桌面剪贴板，在浏览器内 Ctrl+V 粘贴')
                }}
              >
                发送剪贴板
              </Button>
              <Button size='sm' variant='outline' onClick={goFullscreen}>
                全屏
              </Button>
              <Button size='sm' variant='ghost' onClick={() => setOpen(false)}>
                关闭
              </Button>
            </div>
          </>
        ) : (
          <div className='flex flex-wrap items-center gap-3'>
            <Button
              size='sm'
              variant='outline'
              disabled={!s?.enabled}
              onClick={() => setOpen(true)}
            >
              打开桌面
            </Button>
            <span className='text-xs text-muted-foreground'>
              独立桌面容器与本槽共享网络，浏览器流量走本槽出口；浏览器资料随槽位保留，删除/重置槽位时清除。
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
