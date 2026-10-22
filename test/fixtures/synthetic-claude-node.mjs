import http from 'node:http'

// A controllable local provider substitute. Its observations are test evidence,
// never execution completion proofs; only the Go journal supplies those.
export async function syntheticClaudeNode(socketPath, { mode = 'sse' } = {}) {
  const model = 'claude-haiku-4-5-20251001'
  const modes = new Set(['sse', 'json', 'error', 'truncated'])
  let paused = false
  let closed = false
  let active = 0
  let peak = 0
  let responded = 0
  let healthCalls = 0
  const requests = []
  const waiting = new Set()
  const resume = () => { paused = false; for (const wake of waiting) wake(); waiting.clear() }
  const frames = (id) => [
    { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'synthetic-node-response' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
  const kernel = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/internal/health') {
        healthCalls++
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, healthy: true, ready_slots: 8, version: 'synthetic-kernel' }))
        return
      }
      if (req.method !== 'POST' || req.url !== '/internal/v1/messages') return res.writeHead(404).end()
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (body.length > 16 * 1024 * 1024) return res.writeHead(413).end()
      }
      const envelope = JSON.parse(body)
      if (typeof envelope.request_id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(envelope.request_id)) return res.writeHead(400).end()
      const record = { requestId: envelope.request_id, state: 'waiting', mode: null }
      requests.push(record)
      active++
      peak = Math.max(peak, active)
      try {
        if (paused) await new Promise((resolve) => waiting.add(resolve))
        if (closed) return res.destroy()
        record.mode = mode
        record.state = 'responded'
        const id = 'msg_' + envelope.request_id
        if (mode === 'error') {
          res.writeHead(502, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { type: 'worker_error', code: 'provider_error', message: 'synthetic provider error: client disconnected' } }))
        } else if (mode === 'json') {
          res.writeHead(200, { 'content-type': 'application/json', 'x-terminal-state': 'verified' })
          res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'synthetic-node-response' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }))
        } else {
          const body = frames(id)
          res.writeHead(200, { 'content-type': 'text/event-stream', 'x-terminal-state': 'verified', ...(mode === 'truncated' ? { 'content-length': String(Buffer.byteLength(body) + 32), connection: 'close' } : {}) })
          res.end(mode === 'truncated' ? body.slice(0, -4) : body)
        }
        responded++
      } finally {
        active--
      }
    } catch {
      res.destroy()
    }
  })
  const status = () => ({ syntheticProvider: true, paused, mode, active, peak, responded, healthCalls, requests })
  const control = http.createServer(async (req, res) => {
    const send = (value, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (req.method === 'GET' && req.url === '/status') return send(status())
    if (req.method !== 'POST') return send({ error: 'unsupported' }, 405)
    if (req.url === '/pause') paused = true
    else if (req.url === '/resume') resume()
    else if (req.url === '/mode') {
      try {
        let data = ''
        for await (const chunk of req) {
          data += chunk
          if (data.length > 2048) return send({ error: 'invalid_mode' }, 400)
        }
        const input = JSON.parse(data)
        if (Object.keys(input).join(',') !== 'mode' || !modes.has(input.mode)) throw new Error()
        mode = input.mode
      } catch { return send({ error: 'invalid_mode' }, 400) }
    } else return send({ error: 'unsupported' }, 404)
    send(status())
  })
  const listen = (server, address) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, resolve) })
  try {
    await listen(kernel, socketPath)
    await listen(control, { host: '127.0.0.1', port: 0 })
  } catch (error) {
    kernel.close()
    control.close()
    throw error
  }
  return {
    controlUrl: `http://127.0.0.1:${control.address().port}`,
    async close() {
      if (closed) return
      closed = true
      resume()
      for (const server of [control, kernel]) {
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
      }
    },
  }
}
