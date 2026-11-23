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
export function VmDesktopCard({
  vm,
  active,
}: {
  vm: Vm
  /**
   * 「桌面」页签当前是否选中。页签改为 forceMount 保活连接后本卡片在任意
   * 详情页都已挂载，没有这个闸门状态轮询会在从未打开桌面的页面上常驻。
   */
  active: boolean
}) {
  const id = vm.id
  const root = `/api/panel/vms/${encodeURIComponent(id)}`
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [clip, setClip] = useState('')
  const [remoteClip, setRemoteClip] = useState('')
  const frameRef = useRef<HTMLDivElement>(null)
  const viewer = useRef<NoVncHandle | null>(null)

  // 面板多为 HTTP 直连（非安全上下文），navigator.clipboard 不可用，
  // 用隐藏 textarea + execCommand 在点击手势内写本机剪贴板
  const copyToLocal = async (text: string) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text)
        return true
      }
    } catch {
      // 落入 execCommand 兜底
    }
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }

  // 工具栏按钮点击后自动把焦点还给桌面画面（输入框除外，用户可能要继续打字）
  const refocusDesktop = () => {
    const el = document.activeElement
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
    viewer.current?.focus()
  }

  const status = useQuery({
    queryKey: ['vm-desktop', id],
    queryFn: () =>
      api<DesktopStatus>(`/api/panel/vms/${encodeURIComponent(id)}/desktop`),
    // 打开 noVNC 后状态不再轮询（连接本身即活性信号）；页签未选中时也不轮询。
    // 首次取值仍会发生，切到桌面页签时状态是现成的。
    refetchInterval: active && !open ? 15_000 : false,
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
                onClipboard={setRemoteClip}
              />
            </div>
            <div
              className='flex flex-wrap items-center gap-2'
              onMouseUp={() => setTimeout(refocusDesktop, 0)}
            >
              <Input
                className='h-8 max-w-xs'
                placeholder='发送到桌面剪贴板（长文本兜底）'
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
                  toast.success('已写入桌面剪贴板')
                }}
              >
                发送剪贴板
              </Button>
              <Button
                size='sm'
                variant='outline'
                disabled={!remoteClip}
                title={remoteClip}
                onClick={async () => {
                  const ok = await copyToLocal(remoteClip)
                  if (ok) toast.success('已复制到本机剪贴板')
                  else toast.error('复制失败，请手动复制预览内容')
                }}
              >
                带回桌面剪贴板
              </Button>
              <span
                className='max-w-[16rem] truncate text-xs text-muted-foreground'
                title={remoteClip}
              >
                桌面剪贴板：{remoteClip || '（空）'}
              </span>
              <Button size='sm' variant='outline' onClick={goFullscreen}>
                全屏
              </Button>
              <Button size='sm' variant='ghost' onClick={() => setOpen(false)}>
                关闭
              </Button>
            </div>
            <p className='text-xs text-muted-foreground'>
              Mac 直接用 Command+C /
              V：复制粘贴与桌面双向直通（中文、链接、验证码均可直接粘贴；桌面内复制的内容点「带回桌面剪贴板」或在本面板页按
              Command+C 取回）；Command+=/- 缩放会作用到桌面内网页。
            </p>
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
