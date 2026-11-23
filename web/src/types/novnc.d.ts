// @novnc/novnc ships plain ESM without type declarations; only the surface the
// slot desktop viewer uses is declared here.
declare module '@novnc/novnc' {
  export type RfbOptions = {
    shared?: boolean
    credentials?: { username?: string; password?: string; target?: string }
    wsProtocols?: string[]
  }
  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      urlOrChannel: string | WebSocket,
      options?: RfbOptions
    )
    scaleViewport: boolean
    resizeSession: boolean
    clipViewport: boolean
    viewOnly: boolean
    focusOnClick: boolean
    background: string
    disconnect(): void
    focus(options?: { preventScroll?: boolean }): void
    sendCtrlAltDel(): void
    /**
     * 按键注入：keysym 为 X11 keysym（如 0xffe3=Control_L）；code 传 null 走标准
     * KeyEvent（Unicode keysym 无 scancode）；down 省略表示按下并释放一对。
     */
    sendKey(keysym: number, code: string | null, down?: boolean | null): void
    clipboardPasteFrom(text: string): void
  }
}
