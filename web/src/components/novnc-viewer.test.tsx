import { renderToStaticMarkup } from 'react-dom/server'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type NoVncHandle, NoVncViewer } from './novnc-viewer'

const state = vi.hoisted(() => ({
  values: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  cursor: 0,
  refCursor: 0,
  effects: [] as Array<() => void | (() => void)>,
  rfb: null as null | {
    listeners: Map<string, (e: unknown) => void>
    sendKey: ReturnType<typeof vi.fn>
    clipboardPasteFrom: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
  },
}))

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = state.cursor++
    if (index >= state.values.length) state.values[index] = initial
    return [
      state.values[index],
      (next: unknown) => {
        state.values[index] = next
      },
    ]
  },
  useRef: (initial: unknown) => {
    const index = state.refCursor++
    state.refs[index] ??= { current: initial }
    return state.refs[index]
  },
  useEffect: (effect: () => void | (() => void)) => {
    state.effects.push(effect)
  },
}))

vi.mock('@novnc/novnc', () => ({
  default: class MockRFB {
    listeners = new Map<string, (e: unknown) => void>()
    scaleViewport = false
    resizeSession = false
    background = ''
    sendKey = vi.fn()
    clipboardPasteFrom = vi.fn()
    focus = vi.fn()
    disconnect = vi.fn()
    constructor() {
      state.rfb = this
    }
    addEventListener(type: string, fn: (e: unknown) => void) {
      this.listeners.set(type, fn)
    }
  },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}))

vi.mock('@/lib/api', () => ({
  api: vi.fn().mockResolvedValue({ ticket: 'ticket-1' }),
}))

vi.mock('@/lib/session', () => ({
  apiBase: () => 'https://panel.example',
}))

describe('NoVncViewer active-tab scoping and paste status', () => {
  const docListeners = new Map<string, (e: unknown) => void>()
  const hostListeners = new Map<string, (e: unknown) => void>()
  const writeText = vi.fn().mockResolvedValue(undefined)
  let cleanups: Array<void | (() => void)> = []

  const hostNode = {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      hostListeners.set(type, fn)
    },
    removeEventListener: (type: string) => {
      hostListeners.delete(type)
    },
  }

  function renderViewer(props: {
    active?: boolean
    handleRef?: { current: NoVncHandle | null }
    onClipboard?: (text: string) => void
    onPhase?: (phase: 'connecting' | 'open' | 'closed' | 'error') => void
  }) {
    state.cursor = 0
    state.refCursor = 0
    state.effects = []
    state.refs[0] = { current: hostNode }
    renderToStaticMarkup(
      <NoVncViewer
        ticketPath='/api/panel/vms/vm-1/desktop-ticket'
        socketPath='/api/panel/vms/vm-1/desktop/ws'
        {...props}
      />
    )
  }

  beforeEach(() => {
    state.values = []
    state.refs = []
    state.rfb = null
    docListeners.clear()
    hostListeners.clear()
    cleanups = []
    vi.clearAllMocks()
    vi.stubGlobal('window', {
      isSecureContext: true,
      location: { origin: 'https://panel.example' },
      setTimeout: globalThis.setTimeout.bind(globalThis),
    })
    vi.stubGlobal('navigator', {
      platform: 'MacIntel',
      userAgent: 'Mozilla/5.0 (Macintosh)',
      clipboard: { writeText },
    })
    vi.stubGlobal('document', {
      hasFocus: () => true,
      getSelection: () => ({ toString: () => '' }),
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        docListeners.set(type, fn)
      },
      removeEventListener: (type: string) => {
        docListeners.delete(type)
      },
    })
  })

  afterEach(() => {
    for (const cleanup of cleanups) cleanup?.()
    vi.unstubAllGlobals()
  })

  it('does not hijack document paste/copy or overwrite local clipboard when forceMount tab is inactive', async () => {
    const handleRef: { current: NoVncHandle | null } = { current: null }
    const onClipboard = vi.fn()
    renderViewer({ active: true, handleRef, onClipboard })
    cleanups = state.effects.map((effect) => effect())
    await Promise.resolve()
    await Promise.resolve()

    expect(state.rfb).not.toBeNull()
    expect(handleRef.current?.paste('before-connect')).toBe(false)

    // Switch away from Desktop tab BEFORE VNC finishes connecting: connect must not steal focus.
    renderViewer({ active: false, handleRef, onClipboard })
    state.effects[0]?.()
    state.rfb?.listeners.get('connect')?.({})
    expect(state.rfb?.focus).not.toHaveBeenCalled()

    // Hidden Desktop tab must not intercept paste on other tabs (e.g. Account / Terminal).
    const pastePrevent = vi.fn()
    docListeners.get('paste')?.({
      target: { tagName: 'DIV', isContentEditable: false },
      clipboardData: { getData: () => 'oauth-code-123' },
      preventDefault: pastePrevent,
    })
    expect(pastePrevent).not.toHaveBeenCalled()
    expect(state.rfb?.clipboardPasteFrom).not.toHaveBeenCalled()

    // Hidden Desktop ServerCutText updates preview state but does NOT overwrite local clipboard or toast.
    state.rfb?.listeners.get('clipboard')?.({ detail: { text: 'remote-x11' } })
    expect(onClipboard).toHaveBeenCalledWith('remote-x11')
    expect(writeText).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()

    // Hidden Desktop tab must not intercept Cmd+C on other tabs (e.g. xterm canvas).
    const copyPrevent = vi.fn()
    const setData = vi.fn()
    docListeners.get('copy')?.({
      target: { tagName: 'CANVAS', isContentEditable: false },
      clipboardData: { setData },
      preventDefault: copyPrevent,
    })
    expect(copyPrevent).not.toHaveBeenCalled()
    expect(setData).not.toHaveBeenCalled()

    // Switching back to active Desktop tab re-enables paste, copy, and live clipboard sync.
    renderViewer({ active: true, handleRef, onClipboard })
    state.effects[0]?.()

    docListeners.get('paste')?.({
      target: { tagName: 'DIV', isContentEditable: false },
      clipboardData: { getData: () => 'hello' },
      preventDefault: pastePrevent,
    })
    expect(pastePrevent).toHaveBeenCalledTimes(1)
    expect(state.rfb?.clipboardPasteFrom).toHaveBeenCalledWith('hello')

    docListeners.get('copy')?.({
      target: { tagName: 'DIV', isContentEditable: false },
      clipboardData: { setData },
      preventDefault: copyPrevent,
    })
    expect(copyPrevent).toHaveBeenCalledTimes(1)
    expect(setData).toHaveBeenCalledWith('text/plain', 'remote-x11')

    state.rfb?.listeners.get('clipboard')?.({ detail: { text: 'remote-next' } })
    await Promise.resolve()
    expect(writeText).toHaveBeenCalledWith('remote-next')
    expect(toast.success).toHaveBeenCalledWith('桌面剪贴板已同步到本机')
  })

  it('distinguishes sent vs fallback_clipboard paste outcomes for toolbar feedback', async () => {
    const handleRef: { current: NoVncHandle | null } = { current: null }
    renderViewer({ active: true, handleRef })
    cleanups = state.effects.map((effect) => effect())
    await Promise.resolve()
    await Promise.resolve()
    state.rfb?.listeners.get('connect')?.({})

    expect(handleRef.current?.paste('')).toBe(false)
    expect(handleRef.current?.paste('中文短文本')).toBe('sent')
    expect(toast.warning).not.toHaveBeenCalled()

    expect(handleRef.current?.paste('中'.repeat(1001))).toBe(
      'fallback_clipboard'
    )
    expect(toast.warning).toHaveBeenCalledTimes(1)
  })
})
