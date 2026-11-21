import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocketServer } from 'ws'

const SOCKET_PATH = /^\/api\/panel\/gemini\/environments\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/terminal\/ws$/
const TICKET_TTL_MS = 30_000
const MAX_TICKETS = 64
const MAX_SESSIONS = 8
const MAX_QUEUE_BYTES = 64 * 1024
const MAX_QUEUE_FRAMES = 256
const MAX_INPUT = 1024
const MAX_OUTPUT = 16 * 1024
const MAX_BUFFERED_OUTPUT = 256 * 1024
const POLL_MS = 75

function size(cols, rows) {
  const clamp = (value, min, max, fallback) => {
    const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
    return Number.isSafeInteger(n) ? Math.max(min, Math.min(max, n)) : fallback
  }
  return { cols: clamp(cols, 10, 500, 80), rows: clamp(rows, 5, 200, 24) }
}

function terminalLimit() {
  return Object.assign(new Error('gemini_terminal_limit'), { code: 'gemini_terminal_limit' })
}

export function createGeminiTerminalBridge({ callHost, resolveTarget, errorMessage }) {
  const tickets = new Map()
  const sessions = new Map()
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_QUEUE_BYTES, perMessageDeflate: false })
  let stopping = false

  function checkCapacity(id) {
    if (stopping || sessions.has(id) || sessions.size >= MAX_SESSIONS) throw terminalLimit()
  }

  async function issueTicket(id) {
    checkCapacity(id)
    await resolveTarget(id)
    checkCapacity(id)
    const now = Date.now()
    for (const [token, entry] of tickets) if (entry.expiresAt <= now) tickets.delete(token)
    if (tickets.size >= MAX_TICKETS) throw terminalLimit()
    const ticket = randomBytes(24).toString('base64url')
    tickets.set(ticket, { id, expiresAt: now + TICKET_TTL_MS })
    return { ticket, expires_in: TICKET_TTL_MS / 1000 }
  }

  function handleUpgrade(req, socket, head) {
    let url
    try {
      url = new URL(req.url || '/', 'http://local')
    } catch {
      return false
    }
    const match = SOCKET_PATH.exec(url.pathname)
    if (!match) return false
    const id = match[1]
    const ticket = url.searchParams.get('ticket')
    const entry = tickets.get(ticket)
    // Never fall through to a different upgrade handler, even with a bad ticket.
    tickets.delete(ticket)
    const rejection =
      !entry || entry.id !== id || entry.expiresAt <= Date.now()
        ? '401 Unauthorized'
        : stopping || sessions.has(id) || sessions.size >= MAX_SESSIONS
          ? '429 Too Many Requests'
          : null
    if (rejection) {
      socket.once('error', () => socket.destroy())
      socket.end(`HTTP/1.1 ${rejection}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    } else {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const done = attach(ws, id, size(url.searchParams.get('cols'), url.searchParams.get('rows'))).finally(() =>
          sessions.delete(id),
        )
        sessions.set(id, done)
      })
    }
    return true
  }

  async function attach(ws, id, initialSize) {
    const session = { id, session_id: randomBytes(16).toString('hex') }
    const disconnect = new AbortController()
    const queue = []
    let queuedBytes = 0
    let stage = 'resolve'
    let pong = true

    const cancel = () => {
      disconnect.abort()
      queue.length = 0
      queuedBytes = 0
    }
    const active = () => !disconnect.signal.aborted && ws.readyState === ws.OPEN
    const fail = (message) => {
      if (active()) {
        ws.send(JSON.stringify({ t: 'error', message }))
        ws.close(1011)
      }
      cancel()
    }
    ws.once('close', cancel)
    ws.on('error', cancel)
    ws.on('pong', () => {
      pong = true
    })
    const heartbeat = setInterval(() => {
      if (!active()) return
      if (!pong) {
        cancel()
        ws.terminate()
      } else {
        pong = false
        ws.ping()
      }
    }, 20_000)
    heartbeat.unref()

    ws.on('message', (raw, isBinary) => {
      if (!active() || isBinary) return
      let frame
      try {
        frame = JSON.parse(raw.toString('utf8'))
      } catch {
        return
      }
      const item =
        frame?.t === 'd' && typeof frame.d === 'string' && frame.d
          ? { bytes: Buffer.from(frame.d, 'utf8'), offset: 0 }
          : frame?.t === 'r'
            ? { resize: size(frame.c, frame.r) }
            : null
      if (!item) return
      const bytes = item.bytes?.length ?? 0
      if (queue.length >= MAX_QUEUE_FRAMES || queuedBytes + bytes > MAX_QUEUE_BYTES) {
        fail('终端输入积压过多，请重新打开后分段粘贴')
        return
      }
      queue.push(item)
      queuedBytes += bytes
    })

    function nextInput() {
      const first = queue[0]
      if (!first) return {}
      if (first.resize) return queue.shift().resize
      const { bytes, offset } = first
      let end = Math.min(offset + MAX_INPUT, bytes.length)
      // Do not split a UTF-8 code point across host input requests.
      while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1
      first.offset = end
      if (end === bytes.length) {
        queue.shift()
        queuedBytes -= bytes.length
      }
      return { input: bytes.toString('utf8', offset, end) }
    }

    try {
      const target = await resolveTarget(id)
      if (!active()) return
      stage = 'start'
      const started = await callHost('terminal-start', { ...target, ...session, ...initialSize })
      if (started?.ok !== true) throw new Error('invalid terminal-start response')
      stage = 'io'
      while (active()) {
        const result = await callHost('terminal-io', { ...session, ...nextInput() })
        if (!active()) break
        if (
          typeof result?.data !== 'string' ||
          result.data.length > Math.ceil(MAX_OUTPUT / 3) * 4 ||
          typeof result.closed !== 'boolean'
        ) {
          throw new Error('invalid terminal-io response')
        }
        const output = Buffer.from(result.data, 'base64')
        if (output.length > MAX_OUTPUT || output.toString('base64') !== result.data) {
          throw new Error('invalid terminal output')
        }
        if (ws.bufferedAmount + output.length > MAX_BUFFERED_OUTPUT) {
          fail('浏览器未能及时接收终端输出，请重新打开')
          break
        }
        if (output.length) ws.send(output, { binary: true })
        if (result.closed) {
          ws.send(JSON.stringify({ t: 'exit' }))
          ws.close(1000)
          break
        }
        if (!queue.length && !output.length) await delay(POLL_MS, undefined, { signal: disconnect.signal })
      }
    } catch (error) {
      if (active()) fail(errorMessage(error?.code, stage))
    } finally {
      cancel()
      clearInterval(heartbeat)
      // Stop only after the start request settles: a disconnect can arrive before
      // the host has registered the session. Stop is idempotent, even on failure.
      if (stage !== 'resolve') {
        try {
          await callHost('terminal-stop', session)
        } catch {
          // The host idle lease also reaps sessions when its socket is unavailable.
        }
      }
    }
  }

  function close() {
    stopping = true
    tickets.clear()
    for (const ws of wss.clients) ws.terminate()
    return Promise.allSettled(sessions.values())
  }

  return { issueTicket, handleUpgrade, close }
}
