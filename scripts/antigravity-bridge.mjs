#!/usr/bin/env node
/** Experimental text-only bridge. Runs inside a slot, never in the control plane. */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createAntigravityUpstream, ANTIGRAVITY_API_CAPABILITIES } from './antigravity-upstream.mjs'

const TERMINAL = new Set(['SUCCESS', 'ERROR', 'CANCELED', 'INTERRUPTED', 'INVALID'])
const COUNTERS = ['input_tokens', 'output_tokens', 'thinking_tokens', 'cache_read_tokens', 'total_tokens']
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/
export const ANTIGRAVITY_TEXT_CAPABILITIES = Object.freeze({
  experimental: true,
  text: true,
  stream: true,
  session: true,
  system: false,
  history: false,
  images: false,
  client_tools: false,
})

function failure(status, code, message, extra = {}) {
  return { ok: false, status, code, message, terminalState: 'rejected', ...extra }
}

export function antigravityCliEnv(env = process.env) {
  const allowed = /^(HOME|PATH|LANG|LC_[A-Z_]+|TZ|USER|LOGNAME|XDG_[A-Z_]+|DBUS_SESSION_BUS_ADDRESS|SHELL)$/
  const result = Object.fromEntries(Object.entries(env).filter(([key]) => allowed.test(key)))
  if (result.HOME) result.PATH = `${result.HOME}/.local/bin:${result.PATH || '/usr/bin:/bin'}`
  return result
}

function countersOf(value) {
  if (!value || typeof value !== 'object') return null
  if (!Number.isSafeInteger(value.input_tokens) || !Number.isSafeInteger(value.output_tokens)) return null
  const out = {}
  for (const key of COUNTERS) {
    const n = value[key]
    if (n == null) continue
    if (!Number.isSafeInteger(n) || n < 0) return null
    out[key] = n
  }
  return out
}

export function antigravityUsageDelta(previous, cumulative) {
  const next = countersOf(cumulative)
  if (!next) return { usage: null, cumulative: null }
  if (!previous) return { usage: null, cumulative: next }
  const usage = {}
  for (const [key, value] of Object.entries(next)) {
    if (!Number.isSafeInteger(previous[key]) || value < previous[key]) return { usage: null, cumulative: next }
    usage[key] = value - previous[key]
  }
  return { usage, cumulative: next }
}

/** Each session owns one CLI process. Prompts are sent only after a tool-free init. */
export function createAntigravitySessionPool(config = {}, { spawnImpl = spawn, now = Date.now } = {}) {
  const sessions = new Map()
  const retired = new Map()
  const maxSessions = Math.min(20, Math.max(1, Number(config.max_sessions) || 1))
  const idleMs = Math.max(1000, Number(config.idle_ttl_seconds || 600) * 1000)
  const timeoutMs = Math.max(100, Number(config.timeout_ms) || 180_000)
  const maxBytes = Number(config.max_response_bytes) || 4 * 1024 * 1024
  const maxEventBytes = Number(config.max_event_bytes) || 1024 * 1024
  const models = new Set(
    (config.models || [])
      .filter((row) => row?.enabled !== false)
      .map((row) => String(typeof row === 'string' ? row : row?.id || '')),
  )
  const workdir = config.workdir || path.join(process.env.HOME || '.', '.kin', 'antigravity-workspace')
  let closed = false

  function terminate(session) {
    if (sessions.get(session.id) === session) sessions.delete(session.id)
    clearTimeout(session.idleTimer)
    if (session.dead) return
    session.dead = true
    retired.set(session.id, true)
    // Preserve recent ended IDs without retaining conversation content or growing forever.
    if (retired.size > 4096) retired.delete(retired.keys().next().value)
    try {
      session.child.stdin.destroy()
    } catch {}
    try {
      session.child.kill('SIGTERM')
    } catch {}
    const killTimer = setTimeout(() => {
      try {
        session.child.kill('SIGKILL')
      } catch {}
    }, 250)
    killTimer.unref?.()
  }

  function finish(session, result, { close = false } = {}) {
    const pending = session.pending
    if (!pending) {
      if (close) terminate(session)
      return
    }
    session.pending = null
    session.busy = false
    session.lastUsed = now()
    clearTimeout(pending.timer)
    pending.signal?.removeEventListener('abort', pending.onAbort)
    if (close) terminate(session)
    else {
      session.idleTimer = setTimeout(() => terminate(session), idleMs)
      session.idleTimer.unref?.()
    }
    pending.resolve({
      ...result,
      session_id: session.id,
      conversation_id: session.conversationId || null,
      output_committed: pending.text.length > 0,
    })
  }

  function protocolError(session, code = 'antigravity_protocol_error', message = 'Antigravity CLI stream is invalid') {
    session.baseline = null
    finish(session, failure(502, code, message, { terminalState: 'incomplete' }), { close: true })
  }

  function sendPrompt(session) {
    const pending = session.pending
    if (!pending || !session.ready || pending.sent || session.dead) return
    pending.sent = true
    session.child.stdin.write(
      JSON.stringify({ event: 'user', message: { content: pending.prompt } }) + '\n',
      (error) => {
        if (error && session.pending === pending)
          protocolError(session, 'antigravity_input_failed', 'Antigravity CLI input closed')
      },
    )
  }

  function onEvent(session, event) {
    if (!event || typeof event !== 'object' || typeof event.event !== 'string') return protocolError(session)
    if (event.event === 'init') {
      if (session.ready || !Array.isArray(event.init?.tools) || event.init.tools.length !== 0) {
        return protocolError(
          session,
          'antigravity_tools_not_disabled',
          'Antigravity text sessions require an empty tool list',
        )
      }
      if (event.init.model !== session.model)
        return protocolError(session, 'antigravity_model_mismatch', 'Antigravity selected a different model')
      if (event.init.agent !== 'vm2api-text')
        return protocolError(session, 'antigravity_agent_mismatch', 'Antigravity did not select the tool-free agent')
      session.conversationId = String(event.conversation_id || event.init.conversation_id || '')
      session.ready = true
      return sendPrompt(session)
    }
    if (event.event === 'step_update') {
      if (!session.ready || !session.pending?.sent) return protocolError(session)
      const step = event.step_update
      if (!step || typeof step !== 'object') return protocolError(session)
      if (step.conversation_id && session.conversationId && step.conversation_id !== session.conversationId)
        return protocolError(session)
      if (step.step_type === 'tool' || step.tool_info || step.subagent_info) {
        return protocolError(session, 'antigravity_tools_not_disabled', 'Antigravity emitted an unexpected tool step')
      }
      if (step.step_type !== 'agent_response' || step.text_delta == null) return
      if (typeof step.text_delta !== 'string') return protocolError(session)
      const pending = session.pending
      pending.text += step.text_delta
      if (Buffer.byteLength(pending.text) > maxBytes)
        return protocolError(session, 'antigravity_response_too_large', 'Antigravity response exceeds the limit')
      try {
        pending.onText?.(step.text_delta)
      } catch {
        protocolError(session, 'antigravity_delivery_failed', 'Antigravity response delivery failed')
      }
      return
    }
    if (event.event !== 'result') return
    const result = event.result
    if (!session.pending || !result || !TERMINAL.has(result.status)) return protocolError(session)
    if (result.conversation_id && session.conversationId && result.conversation_id !== session.conversationId)
      return protocolError(session)
    session.conversationId ||= String(result.conversation_id || '')
    const delta = antigravityUsageDelta(session.baseline, result.usage)
    session.baseline = delta.cumulative
    const extra = { usage: delta.usage, usage_cumulative: delta.cumulative, upstream_status: result.status }
    if (result.status !== 'SUCCESS') {
      const cancelled = result.status === 'CANCELED' || result.status === 'INTERRUPTED'
      return finish(
        session,
        failure(
          cancelled ? 499 : 502,
          cancelled ? 'client_cancelled' : 'antigravity_cli_error',
          `Antigravity CLI returned ${result.status}`,
          {
            ...extra,
            terminalState: cancelled ? 'cancelled' : 'rejected',
          },
        ),
        { close: true },
      )
    }
    if (
      !session.ready ||
      !session.pending.sent ||
      typeof result.response !== 'string' ||
      Buffer.byteLength(result.response) > maxBytes
    )
      return protocolError(session)
    const streamed = session.pending.text
    if (streamed && streamed !== result.response)
      return protocolError(session, 'antigravity_text_mismatch', 'Antigravity final text does not match its stream')
    finish(session, { ok: true, status: 200, response: result.response, terminalState: 'verified', ...extra })
  }

  function newSession(id, model) {
    const child = spawnImpl(
      config.cli_bin || 'agy',
      [
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--model',
        model,
        '--agent',
        'vm2api-text',
        '--sandbox',
      ],
      {
        cwd: workdir,
        env: antigravityCliEnv(config.env || process.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      },
    )
    const session = {
      id,
      model,
      child,
      ready: false,
      dead: false,
      busy: false,
      pending: null,
      conversationId: '',
      baseline: Object.fromEntries(COUNTERS.map((key) => [key, 0])),
      buffer: '',
      lastUsed: now(),
    }
    sessions.set(id, session)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (session.dead) return
      session.buffer += chunk
      let index
      while ((index = session.buffer.indexOf('\n')) >= 0) {
        const line = session.buffer.slice(0, index)
        session.buffer = session.buffer.slice(index + 1)
        if (Buffer.byteLength(line) > maxEventBytes) return protocolError(session)
        if (!line.trim()) continue
        try {
          onEvent(session, JSON.parse(line))
        } catch {
          return protocolError(session)
        }
        if (session.dead) return
      }
      if (Buffer.byteLength(session.buffer) > maxEventBytes) protocolError(session)
    })
    // Diagnostics may contain auth material; never forward or retain stderr.
    child.stderr.on('data', () => {})
    child.stdin.on('error', () => protocolError(session, 'antigravity_input_failed', 'Antigravity CLI input closed'))
    child.on('error', () =>
      protocolError(session, 'antigravity_cli_unavailable', 'Antigravity CLI could not be started in the slot'),
    )
    child.on('close', () => {
      if (session.pending)
        protocolError(session, 'antigravity_stream_incomplete', 'Antigravity CLI exited before a terminal result')
      terminate(session)
    })
    return session
  }

  return {
    get size() {
      return sessions.size
    },
    async infer({ prompt, model, session_id: suppliedId, signal, onText } = {}) {
      if (closed) return failure(503, 'antigravity_bridge_stopped', 'Antigravity bridge is stopped')
      if (signal?.aborted) return failure(499, 'client_cancelled', 'Request cancelled', { terminalState: 'cancelled' })
      if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 64 * 1024)
        return failure(400, 'invalid_prompt', 'A nonempty text prompt up to 64 KiB is required')
      if (!ID.test(String(model || '')) || !models.has(model))
        return failure(400, 'model_not_supported', 'The model is not enabled for Antigravity')
      const id = suppliedId || crypto.randomUUID()
      if (!ID.test(String(id))) return failure(400, 'invalid_session_id', 'Invalid Antigravity session id')
      for (const entry of sessions.values()) if (!entry.busy && now() - entry.lastUsed >= idleMs) terminate(entry)
      if (retired.has(id))
        return failure(409, 'antigravity_session_closed', 'This Antigravity session ended; start a new conversation')
      let session = sessions.get(id)
      if (session?.model !== undefined && session.model !== model)
        return failure(409, 'antigravity_session_model_mismatch', 'A session cannot switch models')
      if (session?.busy)
        return failure(409, 'antigravity_session_busy', 'This Antigravity session is already processing a request')
      if (!session && sessions.size >= maxSessions)
        return failure(429, 'antigravity_sessions_full', 'All Antigravity sessions are occupied')
      try {
        session ||= newSession(id, model)
      } catch {
        return failure(503, 'antigravity_cli_unavailable', 'Antigravity CLI could not be started in the slot')
      }
      clearTimeout(session.idleTimer)
      session.busy = true
      return await new Promise((resolve) => {
        const pending = { resolve, prompt, signal, onText, text: '', sent: false }
        session.pending = pending
        pending.onAbort = () => {
          session.baseline = null
          finish(session, failure(499, 'client_cancelled', 'Request cancelled', { terminalState: 'cancelled' }), {
            close: true,
          })
        }
        signal?.addEventListener('abort', pending.onAbort, { once: true })
        pending.timer = setTimeout(() => {
          session.baseline = null
          finish(
            session,
            failure(504, 'antigravity_timeout', 'Antigravity request timed out', { terminalState: 'incomplete' }),
            { close: true },
          )
        }, timeoutMs)
        sendPrompt(session)
        if (signal?.aborted) pending.onAbort()
      })
    },
    closeSession(id) {
      const session = sessions.get(id)
      if (!session) return false
      if (session.pending)
        finish(session, failure(499, 'client_cancelled', 'Session closed', { terminalState: 'cancelled' }), {
          close: true,
        })
      else terminate(session)
      return true
    },
    close() {
      closed = true
      for (const id of [...sessions.keys()]) this.closeSession(id)
    },
  }
}

function tokenMatches(actual, expected) {
  const a = Buffer.from(String(actual || ''))
  const b = Buffer.from(String(expected || ''))
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b)
}

export async function startAntigravityBridge(
  config,
  { pool = createAntigravitySessionPool(config), upstream = createAntigravityUpstream(config) } = {},
) {
  if (!config?.socket_path || !config.internal_token) throw new Error('socket_path and internal_token are required')
  fs.mkdirSync(path.dirname(config.socket_path), { recursive: true, mode: 0o700 })
  let shutdown = async () => {}
  const server = http.createServer(async (req, res) => {
    req.on('error', () => {})
    req.socket.on('error', () => {})
    // A client may disappear while an error response is being flushed.
    res.on('error', () => {})
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (!tokenMatches(req.headers.authorization, `Bearer ${config.internal_token}`))
      return json(401, failure(401, 'unauthorized', 'Unauthorized'))
    if (req.method === 'GET' && req.url === '/health')
      return json(200, {
        ok: true,
        platform: 'antigravity',
        authenticated: null,
        config_hash: config.config_hash || null,
        capabilities: ANTIGRAVITY_API_CAPABILITIES,
        sessions: pool.size,
      })
    if (req.method === 'POST' && req.url === '/shutdown') {
      json(200, { ok: true })
      setImmediate(() => {
        void shutdown()
      })
      return
    }
    if (req.method === 'GET' && req.url === '/quota') {
      const controller = new AbortController()
      const disconnect = () => {
        if (!res.writableEnded) controller.abort()
      }
      res.once('close', disconnect)
      const result = await upstream.quota({ signal: controller.signal })
      res.off('close', disconnect)
      if (!res.destroyed) json(result.ok ? 200 : result.status || 502, result)
      return
    }
    if (req.method !== 'POST' || !['/text', '/inference', '/close-session'].includes(req.url))
      return json(404, failure(404, 'not_found', 'Not found'))
    let body = ''
    let tooLarge = false
    try {
      req.setEncoding('utf8')
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        if (tooLarge) continue
        body += chunk
        if (Buffer.byteLength(body) > (req.url === '/inference' ? 32 * 1024 * 1024 : 128 * 1024)) {
          tooLarge = true
          body = ''
        }
      }
      if (tooLarge) return json(413, failure(413, 'request_too_large', 'Request exceeds the bridge size limit'))
      body = JSON.parse(body)
    } catch {
      return json(400, failure(400, 'invalid_json', 'Invalid JSON'))
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return json(400, failure(400, 'invalid_json', 'A JSON object is required'))
    if (req.url === '/close-session') {
      if (!ID.test(String(body.session_id || '')))
        return json(400, failure(400, 'invalid_session_id', 'Invalid Antigravity session id'))
      return json(200, { ok: true, closed: pool.closeSession(body.session_id) })
    }
    const controller = new AbortController()
    const disconnect = () => {
      if (!res.writableEnded) controller.abort()
    }
    res.once('close', disconnect)
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    const result =
      req.url === '/inference'
        ? await upstream.infer(body, {
            signal: controller.signal,
            onEvent: (value) => {
              if (res.writableLength > 1024 * 1024) throw new Error('slow consumer')
              res.write(JSON.stringify({ event: 'inference_event', value }) + '\n')
            },
          })
        : await pool.infer({
            ...body,
            signal: controller.signal,
            onText: (text) => {
              if (res.writableLength > 1024 * 1024) throw new Error('slow consumer')
              res.write(JSON.stringify({ event: 'text_delta', text }) + '\n')
            },
          })
    res.off('close', disconnect)
    if (!res.destroyed) res.end(JSON.stringify({ event: 'result', result }) + '\n')
  })
  server.on('clientError', (_error, socket) => socket.destroy())
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  // Never unlink an existing socket: it may belong to a live bridge.
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.socket_path, resolve)
  })
  fs.chmodSync(config.socket_path, 0o600)
  let closing = null
  shutdown = () => {
    closing ||= (async () => {
      pool.close()
      upstream.close()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      try {
        fs.unlinkSync(config.socket_path)
      } catch {}
    })()
    return closing
  }
  return { server, close: shutdown }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = process.argv.indexOf('--config')
  if (flag < 0 || !process.argv[flag + 1]) throw new Error('--config is required')
  const config = JSON.parse(fs.readFileSync(process.argv[flag + 1], 'utf8'))
  const bridge = await startAntigravityBridge(config)
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    await bridge.close()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}
