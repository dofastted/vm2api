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
    focus(): void
    sendCtrlAltDel(): void
    clipboardPasteFrom(text: string): void
  }
}
