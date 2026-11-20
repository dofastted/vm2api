/**
 * Downstream SSE keepalive:
 *   - default: event: ping
 *   - official Claude Code ≥ 2.1.193: empty content_block_delta so the CLI
 *     parser does not treat comment/ping as a dead stream
 * Used only toward the client. Upstream idle is the worker interval timeout.
 *
 * `arm()` covers an upstream attempt: the first ping waits one interval so a
 * fast failure can still return a real HTTP status and switch slots.
 * `armAfter(delay)` covers the queue before that attempt. The first byte is
 * held until the delay so a short seat wait can still finish as 429/529.
 * After that byte, pings continue across retries until `stop()`.
 */

export const CLAUDE_CODE_NOOP_DELTA_KEEPALIVE_MIN_VERSION = '2.1.193'
export const DEFAULT_STREAM_KEEPALIVE_MS = 10_000

const DELTA_FOR_BLOCK = Object.freeze({
  text: 'text_delta',
  tool_use: 'input_json_delta',
  thinking: 'thinking_delta',
})

const FIELD_FOR_DELTA = Object.freeze({
  text_delta: 'text',
  input_json_delta: 'partial_json',
  thinking_delta: 'thinking',
})

export function compareSemver(a, b) {
  const left = String(a || '')
    .split('.')
    .map((part) => parseInt(part, 10) || 0)
  const right = String(b || '')
    .split('.')
    .map((part) => parseInt(part, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const delta = (left[i] || 0) - (right[i] || 0)
    if (delta) return delta
  }
  return 0
}

export function extractCliVersion(ua = '') {
  const m = String(ua || '').match(/claude-cli\/(\d+\.\d+\.\d+)/i)
  return m ? m[1] : ''
}

export function shouldUseClaudeCodeNoopDeltaKeepalive(ua = '') {
  const version = extractCliVersion(ua)
  if (!version) return false
  return compareSemver(version, CLAUDE_CODE_NOOP_DELTA_KEEPALIVE_MIN_VERSION) >= 0
}

export function keepaliveDeltaTypeForContentBlock(blockType = '') {
  return DELTA_FOR_BLOCK[String(blockType || '')] || ''
}

export function buildPingKeepalive() {
  return 'event: ping\ndata: {"type":"ping"}\n\n'
}

export function buildCommentKeepalive() {
  return ': keepalive\n\n'
}

export function buildClaudeCodeNoopDeltaKeepalive(index, deltaType) {
  const field = FIELD_FOR_DELTA[deltaType]
  if (field == null || !Number.isInteger(index) || index < 0) return ''
  return `event: content_block_delta\ndata: {"type":"content_block_delta","index":${index},"delta":{"type":"${deltaType}","${field}":""}}\n\n`
}

export function observeKeepaliveEvent(state, event) {
  if (!event || typeof event !== 'object') return state
  const next = { ...state }
  const type = String(event.type || '')
  const index = Number(event.index)
  if (type === 'content_block_start') {
    const deltaType = keepaliveDeltaTypeForContentBlock(event.content_block?.type)
    if (Number.isInteger(index) && deltaType) {
      next.blockIndex = index
      next.deltaType = deltaType
    } else {
      next.blockIndex = -1
      next.deltaType = ''
    }
    return next
  }
  if (type === 'content_block_delta') {
    const deltaType = String(event.delta?.type || '')
    if (Number.isInteger(index) && FIELD_FOR_DELTA[deltaType]) {
      next.blockIndex = index
      next.deltaType = deltaType
    }
    return next
  }
  if (type === 'content_block_stop' && Number.isInteger(index) && index === next.blockIndex) {
    next.blockIndex = -1
    next.deltaType = ''
    return next
  }
  if (type === 'message_stop' || type === 'error') {
    next.blockIndex = -1
    next.deltaType = ''
    next.done = true
    return next
  }
  return next
}

export function parseSseDataLine(line) {
  const raw = String(line || '')
  if (!raw.startsWith('data:')) return null
  const piece = raw.slice(5).trim()
  if (!piece || piece === '[DONE]') return null
  try {
    const event = JSON.parse(piece)
    return event && typeof event === 'object' ? event : null
  } catch {
    return null
  }
}

export function resolveKeepaliveChunk({ protocol = 'anthropic.messages', userAgent = '', state = {} } = {}) {
  if (String(protocol || '') !== 'anthropic.messages') return buildCommentKeepalive()
  if (
    shouldUseClaudeCodeNoopDeltaKeepalive(userAgent) &&
    Number.isInteger(state.blockIndex) &&
    state.blockIndex >= 0 &&
    state.deltaType
  ) {
    const block = buildClaudeCodeNoopDeltaKeepalive(state.blockIndex, state.deltaType)
    if (block) return block
  }
  return buildPingKeepalive()
}

/**
 * @param {{ intervalMs?: number, userAgent?: string, protocol?: string, write: (chunk: string) => void }} opts
 */
export function createDownstreamKeepalive({
  intervalMs = DEFAULT_STREAM_KEEPALIVE_MS,
  userAgent = '',
  protocol = 'anthropic.messages',
  write,
} = {}) {
  const interval = Math.max(0, Number(intervalMs) || 0)
  let state = { blockIndex: -1, deltaType: '', done: false }
  let lastWriteAt = 0
  let timer = null
  let holdTimer = null
  let armed = false
  let written = false
  let attemptActive = false
  // Queue delay elapsed. The first byte is allowed even between attempts.
  let queueReleased = false

  const markWrite = () => {
    lastWriteAt = Date.now()
  }

  const due = () => {
    if (!armed || state.done || interval <= 0) return false
    if (written) return Date.now() - lastWriteAt >= interval
    // Inside an attempt the first ping still waits one interval: a fast
    // upstream failure can change HTTP status and move to another slot.
    if (attemptActive) return lastWriteAt > 0 && Date.now() - lastWriteAt >= interval
    return queueReleased
  }

  const beat = () => {
    if (!due()) return
    if (typeof write !== 'function') return
    try {
      write(resolveKeepaliveChunk({ protocol, userAgent, state }))
      written = true
      markWrite()
    } catch {
      stop()
    }
  }

  const start = () => {
    if (timer || interval <= 0) return
    timer = setInterval(beat, Math.min(interval, 1000))
    timer.unref?.()
  }

  const stop = () => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    if (holdTimer) {
      clearTimeout(holdTimer)
      holdTimer = null
    }
    attemptActive = false
    state = { ...state, done: true }
  }

  const arm = () => {
    if (state.done || interval <= 0) return
    attemptActive = true
    armed = true
    if (!written) markWrite()
    start()
  }

  // The attempt ended. Keep pinging only after the queue delay has already
  // produced a byte; until then a short failure can still be an HTTP status.
  const endAttempt = () => {
    attemptActive = false
  }

  /**
   * Hold the first queue byte for delayMs. `0` writes immediately.
   * Later idle pings use the same interval as an in-attempt keepalive.
   */
  const armAfter = (delayMs) => {
    if (state.done || interval <= 0) return
    const delay = Math.max(0, Number(delayMs) || 0)
    armed = true
    start()
    if (delay === 0) {
      queueReleased = true
      beat()
      return
    }
    holdTimer = setTimeout(() => {
      holdTimer = null
      queueReleased = true
      beat()
    }, delay)
    holdTimer.unref?.()
  }

  const observeLine = (line) => {
    armed = true
    written = true
    markWrite()
    const event = parseSseDataLine(line)
    if (event) {
      state = observeKeepaliveEvent(state, event)
      if (state.done) stop()
    }
  }

  return {
    start,
    stop,
    arm,
    armAfter,
    endAttempt,
    observeLine,
    beat,
    getState: () => ({ ...state, armed, lastWriteAt, written, attemptActive, queueReleased }),
  }
}
