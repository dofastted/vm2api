import { useEffect, useRef, useState } from 'react'
import RFB from '@novnc/novnc'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { apiBase } from '@/lib/session'

type Phase = 'connecting' | 'open' | 'closed' | 'error'

export type NoVncPasteResult = 'sent' | 'fallback_clipboard' | false

export type NoVncHandle = {
  paste: (text: string) => NoVncPasteResult
  focus: () => void
}

// X11 keysym 标准值（noVNC 的 KeyTable 未从包入口导出，直接内联）
const XK_Control_L = 0xffe3
const XK_v = 0x0076
const XK_Return = 0xff0d
const XK_Tab = 0xff09

// Unicode keysym 偏移：X11 把 U+0100 起的字符编码为 0x01000000+码点。
// x11vnc 对 keymap 里没有的 keysym 会用 XChangeKeyboardMapping 动态绑一个
// 空闲 keycode（add_keysyms 默认开启），中文等非 Latin-1 文本由此逐字符
// 注入——绕开经典 ClientCutText 的 Latin-1 上限（非 Latin-1 会被截成 '?'）。
const UNICODE_KEYSYM_OFFSET = 0x01000000
// 逐字符注入的长度上限：x11vnc 动态绑键的空闲 keycode 池约两百余个，且超过
// 后事件量过大；超长文本退回剪贴板通道（非 Latin-1 部分会变 ?）
const TYPE_TEXT_MAX = 1000

// Mac 客户端需要把 Cmd 重映射为 Ctrl：noVNC 原生把 Cmd 键（XK_Super_L）映射成
// 远端 Alt，导致 Mac 上 Cmd+C/V 在远端变成 Alt+C/V 完全无效。
const IS_MAC =
  typeof navigator !== 'undefined' &&
  (/mac|iPhone|iPad|iPod/i.test(navigator.platform || '') ||
    /Macintosh/.test(navigator.userAgent || ''))

// Cmd+=/-/0 等：焦点不在桌面时会被本地浏览器当缩放快捷键吃掉
const LOCAL_ZOOM_CODES = new Set(['Equal', 'Minus', 'Digit0'])

const isEditable = (t: EventTarget | null): boolean => {
  const n = t as HTMLElement | null
  return (
    !!n &&
    (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.isContentEditable)
  )
}

/** 文本里是否有 Latin-1 之外的字符（经典 ClientCutText 会把它们截成 '?'） */
const hasNonLatin1 = (text: string): boolean => {
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) > 0xff) return true
  }
  return false
}

/**
 * 还原 noVNC 对 legacy ServerCutText 的字节级误读。noVNC 把经典 ServerCutText
 * 的载荷按单字节 String.fromCharCode 解码（协议名义上是 Latin-1），而 x11vnc
 * 发送的是 X 剪贴板的原始字节——现代 X 程序一律 UTF-8。按字节还原后可无损
 * 解出真文本；若文本已含超出单字节的码点，说明走的是扩展剪贴板路径（真文本），
 * 原样返回。纯 ASCII 的还原是恒等变换，无副作用。
 */
const decodeCutText = (text: string): string => {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0xff) return text
  }
  return new TextDecoder('utf-8').decode(
    Uint8Array.from(text, (c) => c.charCodeAt(0))
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
    overrideProp(
      e,
      'code',
      e.code === 'MetaLeft' ? 'ControlLeft' : 'ControlRight'
    )
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
 * - Cmd/Ctrl+V 直通：统一走 sendPaste 分流——远端剪贴板相同则纯 Ctrl+V、
 *   含非 Latin-1 字符则逐字符注入（中文可用）、其余写远端剪贴板后 Ctrl+V；
 * - 远端复制（ServerCutText）按 UTF-8 还原后回调 onClipboard，面板可一键带回
 *   本机；安全上下文下无感同步本机剪贴板（仅内容变化时）；
 * - 桌面打开期间拦截本地 Cmd+=/-/0 缩放，避免面板被误缩放；
 * - 连接建立后自动聚焦画面，无需先点击即可打字。
 */
export function NoVncViewer({
  ticketPath,
  socketPath,
  active = true,
  onPhase,
  onClipboard,
  handleRef,
}: {
  ticketPath: string
  socketPath: string
  /** 当前「桌面」页签是否可见；forceMount 隐藏期间不得劫持全局剪贴板与快捷键。 */
  active?: boolean
  onPhase?: (phase: Phase, detail?: string) => void
  onClipboard?: (text: string) => void
  handleRef?: React.MutableRefObject<NoVncHandle | null>
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<Phase>('connecting')
  const [detail, setDetail] = useState('')
  const activeRef = useRef(active)
  activeRef.current = active
  const onPhaseRef = useRef(onPhase)
  onPhaseRef.current = onPhase
  const onClipboardRef = useRef(onClipboard)
  onClipboardRef.current = onClipboard
  const remoteClipRef = useRef('')
  // 已拦下 Cmd/Ctrl+V、等 paste 事件的两段状态：pasteTimer 存兜底定时器 id
  // （id 非 null = 兜底还没发），pasteFallbackAt 记兜底注入的时间（用于识别
  // 兜底之后才迟到的 paste，避免二次注入）。
  const pasteTimerRef = useRef<number | null>(null)
  const pasteFallbackAtRef = useRef(0)

  useEffect(() => {
    if (!active && pasteTimerRef.current != null) {
      clearTimeout(pasteTimerRef.current)
      pasteTimerRef.current = null
    }
  }, [active])

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

    // 非 Latin-1 文本逐字符注入：sendKey 不传 down 时自动发按下+抬起一对，
    // code 传 null 走标准 KeyEvent（任意 keysym 均可，x11vnc 动态绑键）
    const typeText = (text: string) => {
      if (!rfb) return
      for (const ch of text) {
        const cp = ch.codePointAt(0) ?? 0
        if (cp === 0x0a) rfb.sendKey(XK_Return, null)
        else if (cp === 0x09) rfb.sendKey(XK_Tab, null)
        else if (cp < 0x20 || cp === 0x7f)
          continue // 控制字符无法键入，跳过
        else rfb.sendKey(cp <= 0xff ? cp : UNICODE_KEYSYM_OFFSET | cp, null)
      }
    }

    // 统一的远端粘贴入口（Cmd/Ctrl+V 与工具栏「发送到桌面」共用）：
    // 1. 与远端剪贴板内容相同（桌面内复制→粘贴）→ 只注入 Ctrl+V，让远端贴自己的；
    // 2. 含非 Latin-1 字符 → 逐字符注入（ClientCutText 会截成 '?'，不能用）；
    // 3. 其余（ASCII/Latin-1）→ 写远端剪贴板 + 注入 Ctrl+V。
    const sendPaste = (text: string): NoVncPasteResult => {
      if (!rfb || !connected || !text) return false
      if (text === remoteClipRef.current) {
        injectCtrlV()
        return 'sent'
      }
      if (hasNonLatin1(text)) {
        if (text.length > TYPE_TEXT_MAX) {
          toast.warning('文本过长，改走剪贴板通道，非 Latin-1 字符会变 ?')
          rfb.clipboardPasteFrom(text)
          injectCtrlV()
          return 'fallback_clipboard'
        }
        typeText(text)
        return 'sent'
      }
      rfb.clipboardPasteFrom(text)
      injectCtrlV()
      return 'sent'
    }

    // —— host 捕获阶段拦截（host 是 canvas 祖先，先于 noVNC 在 canvas 上的监听）——
    const onHostKeyDown = (e: KeyboardEvent) => {
      if (!rfb) return
      if (isEditable(e.target)) return
      // Cmd/Ctrl+V 直通：拦掉 noVNC 的直接转发，交给浏览器 paste 事件统一
      // 处理（sendPaste 按内容分流后注入）。不 preventDefault：paste 事件必须能派发。
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyV') {
        e.stopImmediatePropagation()
        // 连按时先取消上一轮兜底，只保留最新的那次等待
        if (pasteTimerRef.current != null) clearTimeout(pasteTimerRef.current)
        pasteFallbackAtRef.current = 0
        pasteTimerRef.current = window.setTimeout(() => {
          pasteTimerRef.current = null
          pasteFallbackAtRef.current = Date.now()
          // paste 未派生（浏览器差异）：降级为直接转发，不让 V 键失效
          injectCtrlV()
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

    // —— document 级：剪贴板直通与本地快捷键兜底（仅桌面页签可见时生效）——
    const onDocPaste = (e: ClipboardEvent) => {
      if (!activeRef.current || !rfb || !connected) return
      if (isEditable(e.target)) return // 面板输入框正常粘贴
      const text = e.clipboardData?.getData('text/plain') ?? ''
      e.preventDefault()
      if (pasteTimerRef.current != null) {
        // paste 正常派发：取消兜底定时器，注入只走 sendPaste 这一条路
        clearTimeout(pasteTimerRef.current)
        pasteTimerRef.current = null
        sendPaste(text)
        return
      }
      if (Date.now() - pasteFallbackAtRef.current < 500) {
        // 兜底已注入、paste 迟到：不重复注入
        return
      }
      sendPaste(text) // 无对应按键的 paste（如右键菜单）：照常分流
    }
    const onDocCopy = (e: ClipboardEvent) => {
      if (!activeRef.current || !rfb || !connected) return
      if (isEditable(e.target)) return
      // 页面有选区时用户要复制的是面板文字（VM id、日志行等），不接管；
      // 无选区的 Cmd+C 才把桌面侧最近一次复制的内容带回本机
      if ((document.getSelection()?.toString().length ?? 0) > 0) return
      if (!remoteClipRef.current) return
      e.preventDefault()
      e.clipboardData?.setData('text/plain', remoteClipRef.current)
    }
    const onDocKeyDown = (e: KeyboardEvent) => {
      // 焦点在页面非输入区时，Cmd+=/-/0 不再缩放本地面板
      // （焦点在桌面画面时 noVNC 自己就会 stopEvent）
      if (!activeRef.current || !rfb || !connected) return
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
          // 自动聚焦：仅在桌面页签当前可见时聚焦画面，避免隐藏页签抢走其他页签焦点
          if (activeRef.current) rfb?.focus({ preventScroll: true })
        })
        rfb.addEventListener('disconnect', (e) => {
          connected = false
          const clean = (e as CustomEvent<{ clean?: boolean }>).detail?.clean
          report(clean ? 'closed' : 'error', clean ? '' : '连接中断')
        })
        rfb.addEventListener('clipboard', (e) => {
          // 远端（x11vnc ServerCutText）剪贴板更新，先还原字节级误读
          const text = decodeCutText(
            (e as CustomEvent<{ text?: string }>).detail?.text ?? ''
          )
          // 先留旧值再覆盖：相同内容（X11 PRIMARY 拖选会反复推送）直接跳过，
          // 不重复覆盖本机剪贴板、不重复弹提示
          const prev = remoteClipRef.current
          remoteClipRef.current = text
          onClipboardRef.current?.(text)
          // 无感同步到本机（仅桌面页签可见且内容变化时）：切到账号/终端等其他页签
          // 时不静默覆盖本机剪贴板（例如刚复制的授权链接），仍保留「带回」手动取回。
          if (
            activeRef.current &&
            text &&
            text !== prev &&
            window.isSecureContext &&
            navigator.clipboard &&
            document.hasFocus()
          ) {
            navigator.clipboard
              .writeText(text)
              .then(() => toast.success('桌面剪贴板已同步到本机'))
              .catch(() => {
                /* 无权限/失焦：静默，用「带回」按钮或 Cmd+C 取回 */
              })
          }
        })
        if (handleRef)
          handleRef.current = {
            paste: (text) => sendPaste(text),
            focus: () => rfb?.focus({ preventScroll: true }),
          }
      })
      .catch((err: unknown) =>
        report('error', err instanceof Error ? err.message : String(err))
      )
    return () => {
      disposed = true
      if (pasteTimerRef.current != null) {
        clearTimeout(pasteTimerRef.current)
        pasteTimerRef.current = null
      }
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
