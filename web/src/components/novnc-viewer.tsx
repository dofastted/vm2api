import { useEffect, useRef, useState } from 'react'
import RFB from '@novnc/novnc'
import { api } from '@/lib/api'
import { apiBase } from '@/lib/session'

type Phase = 'connecting' | 'open' | 'closed' | 'error'

export type NoVncHandle = {
  paste: (text: string) => void
}

/**
 * noVNC client over the panel's ticketed WebSocket. The server side pipes raw
 * RFB (no websockify), so the socket is passed straight to RFB.
 */
export function NoVncViewer({
  ticketPath,
  socketPath,
  onPhase,
  handleRef,
}: {
  ticketPath: string
  socketPath: string
  onPhase?: (phase: Phase, detail?: string) => void
  handleRef?: React.MutableRefObject<NoVncHandle | null>
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<Phase>('connecting')
  const [detail, setDetail] = useState('')
  const onPhaseRef = useRef(onPhase)
  onPhaseRef.current = onPhase

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    let rfb: RFB | null = null
    const report = (p: Phase, d = '') => {
      if (disposed) return
      setPhase(p)
      setDetail(d)
      onPhaseRef.current?.(p, d)
    }
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
        rfb.addEventListener('connect', () => report('open'))
        rfb.addEventListener('disconnect', (e) => {
          const clean = (e as CustomEvent<{ clean?: boolean }>).detail?.clean
          report(clean ? 'closed' : 'error', clean ? '' : '连接中断')
        })
        if (handleRef)
          handleRef.current = { paste: (text) => rfb?.clipboardPasteFrom(text) }
      })
      .catch((err: unknown) =>
        report('error', err instanceof Error ? err.message : String(err))
      )
    return () => {
      disposed = true
      if (handleRef) handleRef.current = null
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
