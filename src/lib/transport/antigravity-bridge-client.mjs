import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { isValidVmId } from '../vm/vm-file.mjs'

export function antigravityBridgePaths(projectRoot, vm) {
  const id = typeof vm === 'string' ? vm : vm?.id
  if (!projectRoot || !isValidVmId(id)) throw new TypeError('A valid project root and VM id are required')
  const runDir = path.join(projectRoot, 'vms', id, 'run')
  return {
    runDir,
    socketPath: path.join(runDir, 'antigravity.sock'),
    configPath: path.join(runDir, 'antigravity.json'),
    tokenPath: path.join(runDir, 'antigravity.token'),
  }
}

export function callAntigravityBridge({
  projectRoot,
  vm,
  requestPath = '/health',
  body,
  signal,
  onText,
  onEvent,
  timeoutMs = 5000,
} = {}) {
  const paths = antigravityBridgePaths(projectRoot, vm)
  let token
  try {
    token = fs.readFileSync(paths.tokenPath, 'utf8').trim()
  } catch (error) {
    return Promise.resolve({
      ok: false,
      status: 503,
      code: 'antigravity_bridge_unavailable',
      transport_code: error.code || null,
      message: 'Antigravity bridge is not started',
    })
  }
  return new Promise((resolve) => {
    let settled = false
    let result = null
    let textCommitted = false
    const finish = (value) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      resolve(
        result && value?.ok === false
          ? {
              ...value,
              usage: value.usage ?? result.usage ?? null,
              output_committed: value.output_committed === true || textCommitted || result.output_committed === true,
              upstream_status: result.upstream_status ?? value.upstream_status ?? null,
            }
          : value,
      )
    }
    const req = http.request(
      {
        socketPath: paths.socketPath,
        agent: false,
        path: requestPath,
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
      },
      (res) => {
        res.setEncoding('utf8')
        let buffer = ''
        let bytes = 0
        const ndjson = String(res.headers['content-type'] || '').startsWith('application/x-ndjson')
        const parseLine = (line) => {
          if (!line.trim()) return
          const event = JSON.parse(line)
          if (result) throw new Error('event_after_result')
          if (event.event === 'text_delta' && typeof event.text === 'string') {
            textCommitted ||= !!event.text
            onText?.(event.text)
          } else if (event.event === 'inference_event' && event.value && typeof event.value.type === 'string') {
            textCommitted = true
            onEvent?.(event.value)
          } else if (event.event === 'result' && event.result && typeof event.result.ok === 'boolean')
            result = event.result
          else throw new Error('invalid_bridge_event')
        }
        res.on('data', (chunk) => {
          bytes += Buffer.byteLength(chunk)
          if (bytes > 32 * 1024 * 1024) return req.destroy(new Error('response_too_large'))
          buffer += chunk
          if (!ndjson) return
          try {
            let index
            while ((index = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, index)
              buffer = buffer.slice(index + 1)
              parseLine(line)
            }
          } catch {
            req.destroy(new Error('invalid_bridge_response'))
          }
        })
        res.on('end', () => {
          try {
            if (ndjson) {
              if (buffer.trim()) parseLine(buffer)
              if (!result) throw new Error('missing_terminal')
              finish({ ...result, output_committed: textCommitted || result.output_committed === true })
            } else finish(JSON.parse(buffer))
          } catch {
            finish({
              ok: false,
              status: 502,
              code: 'antigravity_stream_incomplete',
              message: 'Antigravity bridge did not return a valid terminal result',
              output_committed: textCommitted,
              terminalState: 'incomplete',
            })
          }
        })
        res.on('error', () =>
          finish({
            ok: false,
            status: 502,
            code: 'antigravity_stream_incomplete',
            message: 'Antigravity bridge stream closed',
            output_committed: textCommitted,
            terminalState: 'incomplete',
          }),
        )
      },
    )
    const onAbort = () => req.destroy(Object.assign(new Error('client_cancelled'), { code: 'ABORT_ERR' }))
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
    req.on('error', (error) =>
      finish({
        ok: false,
        status: error.code === 'ABORT_ERR' ? 499 : 503,
        code: error.code === 'ABORT_ERR' ? 'client_cancelled' : 'antigravity_bridge_unavailable',
        transport_code: error.code || null,
        message: error.code === 'ABORT_ERR' ? 'Request cancelled' : 'Antigravity bridge is unavailable',
        output_committed: textCommitted,
        terminalState: error.code === 'ABORT_ERR' ? 'cancelled' : 'incomplete',
      }),
    )
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    else req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

export async function closeAntigravityTextSession({ projectRoot, vm, sessionId } = {}) {
  const result = await callAntigravityBridge({
    projectRoot,
    vm,
    requestPath: '/close-session',
    body: { session_id: sessionId },
    timeoutMs: 2000,
  })
  if (['ENOENT', 'ECONNREFUSED'].includes(result.transport_code)) return { ok: true, closed: false }
  return result
}
