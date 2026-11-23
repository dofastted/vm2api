import { useEffect, useRef, useState } from 'react'
import RFB from '@novnc/novnc'
import { api } from '@/lib/api'
import { apiBase } from '@/lib/session'

type Phase = 'connecting' | 'open' | 'closed' | 'error'

export type NoVncHandle = {
  paste: (text: string) => void
  focus: () => void
}

// X11 keysym 标准值（noVNC 的 KeyTable 未从包入口导出，直接内联）
const XK_Control_L = 0xffe3
const XK_v = 0x0076

// Mac 客户端需要把 Cmd 重映射为 Ctrl：noVNC 原生把 Cmd 键（XK_Super_L）映射成
// 远端 Alt，导致 Mac 上 Cmd+C/V 在远端变成 Alt+C/V 完全无效。
const IS_MAC =
  /mac|iPhone|iPad|iPod/i.test(navigator.platform || '') ||
  /Macintosh/.test(navigator.userAgent)

// Cmd+=/-/0 等：焦点不在桌面时会被本地浏览器当缩放快捷键吃掉
const LOCAL_ZOOM_CODES = new Set(['Equal', 'Minus', 'Digit0'])

const isEditable = (t: EventTarget | null): boolean => {
  const n = t as HTMLElement | null
  return (
    !!n &&
    (n.tagName === 'INPUT' ||
      n.tagName === 'TEXTAREA' ||
      n.isContentEditable)
  )
}

// KeyboardEvent 的 code/metaKey 等是原型上的只读 getter，
// 在事件实例上定义同名属性即可遮蔽，noVNC 读到的就是改写后的值。
const overrideProp = (
  e: KeyboardEvent,
  prop: string,
  value: string | boolean
) => {
  Object.defineProperty(e, prop, { get: () => value })
}

/** Mac：把 Cmd 组合键改写成 Ctrl 组合（修饰键本体与组合键都改） */
const remapCmdToCtrl = (e: KeyboardEvent) => {
  if (e.code === 'MetaLeft' || e.code === 'MetaRight') {
    overrideProp(e, 'code', e.code === 'MetaLeft' ? 'ControlLeft' : 'ControlRight')
    overrideProp(e, 'key', 'Control')
  }
  overrideProp(e, 'metaKey', false)
  overrideProp(e, 'ctrlKey', true)
}

/**
 * noVNC client over the panel's ticketed WebSocket. The server side pipes raw
 * RFB (no websockify), so the socket is passed straight to RFB.
 *
 * 键盘/剪贴板增强（对所有平台生效，Mac 收益最大）：
 * - Mac 的 Cmd 组合键改写为 Ctrl 转发（Cmd+C/V/= 等在远端成为对应 Ctrl 快捷键）；
 * - Cmd/Ctrl+V 直通：先写远端剪贴板再注入 Ctrl+V，Mac 复制的内容直接可粘贴；
 * - 远端复制（ServerCutText）回调 onClipboard，面板可一键带回本机；
 * - 桌面打开期间拦截本地 Cmd+=/-/0 缩放，避免面板被误缩放；
 * - 连接建立后自动聚焦画面，无需先点击即可打字。
 */
export function NoVncViewer({
  ticketPath,
  socketPath,
  onPhase,
  onClipboard,
  handleRef,
}: {
  ticketPath: string
  socketPath: string
  onPhase?: (phase: Phase, detail?: string) => void
  onClipboard?: (text: string) => void
  handleRef?: React.MutableRefObject<NoVncHandle | null>
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<Phase>('connecting')
  const [detail, setDetail] = useState('')
  const onPhaseRef = useRef(onPhase)
  onPhaseRef.current = onPhase
  const onClipboardRef = useRef(onClipboard)
  onClipboardRef.current = onClipboard
  const remoteClipRef = useRef('')
  // 已拦下 Cmd/Ctrl+V、正等 paste 事件：若浏览器没派发 paste（极少数环境），
  // 超时后降级为直接注入 Ctrl+V，保证粘贴不失效
  const pendingPasteV = useRef(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    let rfb: RFB | null = null
    let connected = false
    const report = (p: Phase, d = '') => {
      if (disposed) return
      setPhase(p)
      setDetail(d)
      onPhaseRef.current?.(p, d)
    }

    // 注入 Ctrl+V 键序（同一条 WebSocket 上必然排在剪贴板写入之后）
    const injectCtrlV = () => {
      if (!rfb) return
      rfb.sendKey(XK_Control_L, 'ControlLeft', true)
      rfb.sendKey(XK_v, 'KeyV', true)
      rfb.sendKey(XK_v, 'KeyV', false)
      rfb.sendKey(XK_Control_L, 'ControlLeft', false)
    }

    // —— host 捕获阶段拦截（host 是 canvas 祖先，先于 noVNC 在 canvas 上的监听）——
    const onHostKeyDown = (e: KeyboardEvent) => {
      if (!rfb) return
      if (isEditable(e.target)) return
      // Cmd/Ctrl+V 直通：拦掉 noVNC 的直接转发，交给浏览器 paste 事件统一处理
      // （先写远端剪贴板、再注入 Ctrl+V，保证远端粘贴到的是本地最新内容）。
      // 不 preventDefault：paste 事件必须能派发。
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyV') {
        e.stopImmediatePropagation()
        pendingPasteV.current = true
        setTimeout(() => {
          // paste 未派生（浏览器差异）：降级为直接转发，不让 V 键失效
          if (pendingPasteV.current) {
            pendingPasteV.current = false
            injectCtrlV()
          }
        }, 80)
        return
      }
      if (IS_MAC && e.metaKey) remapCmdToCtrl(e)
    }
    const onHostKeyUp = (e: KeyboardEvent) => {
      if (!rfb || !IS_MAC) return
      if (e.code === 'MetaLeft' || e.code === 'MetaRight') remapCmdToCtrl(e)
    }
    host.addEventListener('keydown', onHostKeyDown, true)
    host.addEventListener('keyup', onHostKeyUp, true)

    // —— document 级：剪贴板直通与本地快捷键兜底 ——
    const onDocPaste = (e: ClipboardEvent) => {
      if (!rfb || !connected) return
      if (isEditable(e.target)) return // 面板输入框正常粘贴
      pendingPasteV.current = false
      const text = e.clipboardData?.getData('text/plain') ?? ''
      e.preventDefault()
      // 经典 RFB ClientCutText 只支持 Latin-1，中文会被截成 '?'；
      // 验证码/链接/密码场景均为 ASCII，长中文仍可用「发送剪贴板」兜底输入。
      if (text) rfb.clipboardPasteFrom(text)
      injectCtrlV()
    }
    const onDocCopy = (e: ClipboardEvent) => {
      // 把桌面侧最近一次复制的内容带回本机（ServerCutText 已到达的值）
      if (!remoteClipRef.current) return
      if (isEditable(e.target)) return
      e.preventDefault()
      e.clipboardData?.setData('text/plain', remoteClipRef.current)
    }
    const onDocKeyDown = (e: KeyboardEvent) => {
      // 焦点在页面非输入区时，Cmd+=/-/0 不再缩放本地面板
      // （焦点在桌面画面时 noVNC 自己就会 stopEvent）
      if (!IS_MAC || !e.metaKey) return
      if (isEditable(e.target)) return
      if (LOCAL_ZOOM_CODES.has(e.code)) e.preventDefault()
    }
    document.addEventListener('paste', onDocPaste)
    document.addEventListener('copy', onDocCopy)
    document.addEventListener('keydown', onDocKeyDown, true)

    api<{ ticket: string }>(ticketPath, { method: 'POST' })
      .then(({ ticket }) => {
        if (disposed) return
        const url = new URL(apiBase() || window.location.origin)
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        url.pathname = socketPath
        url.search = new URLSearchParams({ ticket }).toString()
        rfb = new RFB(host, url.toString(), {
          shared: true,
          wsProtocols: ['binary'],
        })
        rfb.scaleViewport = true
        rfb.resizeSession = false
        rfb.background = 'rgb(24, 24, 27)'
        rfb.addEventListener('connect', () => {
          connected = true
          report('open')
          // 自动聚焦：打开桌面即可打字，无需先点击画面
          rfb?.focus({ preventScroll: true })
        })
        rfb.addEventListener('disconnect', (e) => {
          connected = false
          const clean = (e as CustomEvent<{ clean?: boolean }>).detail?.clean
          report(clean ? 'closed' : 'error', clean ? '' : '连接中断')
        })
        rfb.addEventListener('clipboard', (e) => {
          // 远端（x11vnc ServerCutText）剪贴板更新
          const text = (e as CustomEvent<{ text?: string }>).detail?.text ?? ''
          remoteClipRef.current = text
          onClipboardRef.current?.(text)
        })
        if (handleRef)
          handleRef.current = {
            paste: (text) => rfb?.clipboardPasteFrom(text),
            focus: () => rfb?.focus({ preventScroll: true }),
          }
      })
      .catch((err: unknown) =>
        report('error', err instanceof Error ? err.message : String(err))
      )
    return () => {
      disposed = true
      if (handleRef) handleRef.current = null
      host.removeEventListener('keydown', onHostKeyDown, true)
      host.removeEventListener('keyup', onHostKeyUp, true)
      document.removeEventListener('paste', onDocPaste)
      document.removeEventListener('copy', onDocCopy)
      document.removeEventListener('keydown', onDocKeyDown, true)
      rfb?.disconnect()
    }
  }, [ticketPath, socketPath, handleRef])

  return (
    <div className='relative h-full w-full overflow-hidden rounded-md bg-zinc-900'>
      <div ref={hostRef} className='h-full w-full' />
      {phase !== 'open' ? (
        <div className='absolute inset-0 flex items-center justify-center text-xs text-zinc-300'>
          {phase === 'connecting'
            ? '正在连接桌面…（首次启用需拉取桌面镜像，可能较慢）'
            : null}
          {phase === 'closed' ? '桌面已断开' : null}
          {phase === 'error' ? `桌面不可用：${detail}` : null}
        </div>
      ) : null}
    </div>
  )
}
