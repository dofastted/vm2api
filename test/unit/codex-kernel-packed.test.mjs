import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import {
  callCodexKernel,
  codexKernelDescribe,
  codexKernelHealth,
  findUdsCopySpan,
  interruptCodexKernel,
  resetCodexKernelClientCachesForTests,
  streamCodexKernel,
} from '../../src/lib/transport/codex-kernel-client.mjs'
import { isCodexFailoverError } from '../../src/lib/pool/codex-slot-pool.mjs'

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

async function readRequestBytes(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function listenUnix(server, socketPath) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
}

function closeServer(server) {
  server.closeAllConnections?.()
  return new Promise((resolve) => server.close(resolve))
}

test('findUdsCopySpan locates shared prefix and shifted anchor spans (>= 256B)', () => {
  const prefix = Buffer.from('{"model":"gpt-5.4","instructions":"' + 'x'.repeat(320) + '","input":[')
  const turn1 = Buffer.concat([prefix, Buffer.from('{"role":"user","content":"one"}]}')])
  const turn2 = Buffer.concat([prefix, Buffer.from('{"role":"user","content":"two"}]}')])

  const spanPrefix = findUdsCopySpan(turn1, turn2)
  assert.ok(spanPrefix)
  assert.equal(spanPrefix.offset, 0)
  assert.equal(spanPrefix.insert, 0)
  assert.ok(spanPrefix.count >= prefix.length)
  assert.equal(
    Buffer.compare(
      turn1.subarray(spanPrefix.offset, spanPrefix.offset + spanPrefix.count),
      turn2.subarray(spanPrefix.insert, spanPrefix.insert + spanPrefix.count),
    ),
    0,
  )

  const anchor = Buffer.from(
    Array.from({ length: 18 }, (_, i) => `"seg_${String(i).padStart(2, '0')}_abcdefghijklmnop"`).join(','),
  )
  const baseMid = Buffer.concat([Buffer.from('{"header":"v1",'), anchor, Buffer.from(',"tail":1}')])
  const targetMid = Buffer.concat([Buffer.from('{"header":"version-22",'), anchor, Buffer.from(',"tail":2}')])
  const spanMid = findUdsCopySpan(baseMid, targetMid)
  assert.ok(spanMid)
  assert.equal(
    Buffer.compare(
      baseMid.subarray(spanMid.offset, spanMid.offset + spanMid.count),
      targetMid.subarray(spanMid.insert, spanMid.insert + spanMid.count),
    ),
    0,
  )
  assert.ok(spanMid.count >= anchor.length)

  assert.equal(findUdsCopySpan(Buffer.from('short'), Buffer.from('short')), null)
  assert.equal(findUdsCopySpan(Buffer.from('a'.repeat(300)), Buffer.from('b'.repeat(300))), null)
})

test('codex-kernel-client packed negotiation, delta splice, 3-signal 409 miss recovery, strip & interrupt', {
  skip: process.platform === 'win32' ? 'Unix domain sockets test runs on Linux/WSL' : false,
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-packed-unit-'))
  t.after(() => {
    resetCodexKernelClientCachesForTests()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const runDir = path.join(dir, 'vms', 'gpt-pack-1', 'run')
  fs.mkdirSync(runDir, { recursive: true })
  const socketPath = path.join(runDir, 'codex-kernel.sock')
  const tokenPath = path.join(runDir, 'internal.token')
  fs.writeFileSync(tokenPath, 'tok-packed')

  const baseStore = new Map()
  const recordedRequests = []
  let simulateRestartMissOnce = false

  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers['x-kin-internal-token'] || req.headers['x-internal-token'], 'tok-packed')
    const raw = await readRequestBytes(req)

    if (req.method === 'GET' && req.url === '/internal/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          abi: 1,
          uds_packed_v1: true,
          accounts: 1,
        }),
      )
      return
    }

    if (req.method === 'GET' && req.url === '/internal/v1/describe') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          abi_version: 1,
          capabilities: { uds_packed_v1: true, ws_replay: true, interrupt: true },
        }),
      )
      return
    }

    if (req.method === 'POST' && req.url === '/internal/v1/interrupt') {
      const payload = JSON.parse(raw.toString('utf8'))
      if (payload.request_id === 'req_conflict') {
        res.writeHead(409, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'interrupt_unavailable', message: 'not interruptible' } }))
        return
      }
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method === 'POST' && req.url === '/internal/v1/codex/responses/packed') {
      const baseSha = String(req.headers['x-kin-uds-base'] || '')
      const copyHeader = String(req.headers['x-kin-uds-copy'] || '')
      const contentEncoding = String(req.headers['content-encoding'] || '')
      const decodedPatch = contentEncoding === 'gzip' ? zlib.gunzipSync(raw) : raw

      if (simulateRestartMissOnce) {
        simulateRestartMissOnce = false
        baseStore.clear()
      }

      let fullPayload
      let cacheHit = '0'
      if (copyHeader) {
        const base = baseStore.get(baseSha)
        if (!base) {
          res.writeHead(409, {
            'content-type': 'application/json',
            'x-kin-uds-miss': '1',
            'x-kin-upstream-sent': '0',
          })
          res.end(JSON.stringify({ error: { code: 'local_base_unavailable', message: 'uds base missing' } }))
          return
        }
        cacheHit = '1'
        const [offset, insert, count] = copyHeader.split(',').map((n) => Number.parseInt(n, 10))
        fullPayload = Buffer.concat([
          decodedPatch.subarray(0, insert),
          base.subarray(offset, offset + count),
          decodedPatch.subarray(insert),
        ])
      } else {
        fullPayload = decodedPatch
      }

      const fullSha = sha256Hex(fullPayload)
      if (req.headers['x-kin-uds-store'] === '1') {
        baseStore.set(fullSha, fullPayload)
      }
      const parsed = JSON.parse(fullPayload.toString('utf8'))
      recordedRequests.push({
        url: req.url,
        encoding: contentEncoding,
        rawWireBytes: raw.length,
        fullBytes: fullPayload.length,
        hasCopy: Boolean(copyHeader),
        cacheHit,
        session: parsed.session?.session_id,
        parsed,
      })

      const timingJson = JSON.stringify({
        transport: 'websocket',
        setup_ms: 4,
        first_byte_ms: 11,
        first_text_ms: 14,
      })
      const completedResponse = {
        id: 'resp_p1',
        object: 'response',
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
        usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
      }
      const headers = {
        'content-type':
          parsed.stream === false ? 'application/json; charset=utf-8' : 'text/event-stream; charset=utf-8',
        'x-request-id': String(req.headers['x-request-id'] || 'kreq-1'),
        'x-tap-turn-timing': timingJson,
        'x-tap-interrupt': 'websocket',
        'x-kin-upstream-sent': '1',
        'x-kin-uds-base': fullSha,
        'x-kin-uds-received': String(raw.length),
        'x-models-etag': '"etag-packed-1"',
        'x-visible-header': 'keep-me',
      }
      if (parsed.stream === false) {
        res.writeHead(200, headers)
        res.end(JSON.stringify(completedResponse))
        return
      }
      const sse = [
        `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_p1', output: [] } })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: completedResponse })}\n\n`,
      ].join('')

      res.writeHead(200, headers)
      res.end(sse)
      return
    }

    res.writeHead(404)
    res.end()
  })

  await listenUnix(server, socketPath)
  t.after(() => closeServer(server))

  const exec = {
    vmId: 'gpt-pack-1',
    homeDir: path.join(dir, 'vms', 'gpt-pack-1', 'cli-home'),
    vm: { id: 'gpt-pack-1' },
  }

  const health = await codexKernelHealth(exec)
  assert.equal(health.ok, true)
  assert.equal(health.uds_packed_v1, true)

  const desc = await codexKernelDescribe(exec)
  assert.equal(desc.ok, true)
  assert.equal(desc.status, 200)
  assert.equal(desc.capabilities?.uds_packed_v1, true)

  const sharedHistory = Array.from({ length: 20 }, (_, i) => ({
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: `history-entry-${i}-` + 'h'.repeat(40) }],
  }))

  const makeEnvelope = (input, stream) => ({
    body: { model: 'gpt-5.4', stream, input },
    headers: { 'session-id': 'sess-packed-1' },
    stream,
    session: { session_id: 'sess-packed-1' },
    options: { upstream_transport: 'prefer_websocket' },
  })

  // Turn 1: full gzip to /packed, registers base
  const seenEvents = []
  let readyCallback = null
  const turn1Body = { model: 'gpt-5.4', stream: true, input: sharedHistory }
  const turn1 = await streamCodexKernel({
    exec,
    timeoutMs: 5000,
    idleTimeoutMs: 5000,
    body: turn1Body,
    envelope: makeEnvelope(sharedHistory, true),
    onEvent: async (evt) => {
      seenEvents.push(evt)
    },
    onInterruptReady: (info) => {
      readyCallback = info
    },
  })

  assert.equal(turn1.ok, true)
  assert.equal(turn1.status, 200)
  assert.equal(turn1.interruptTransport, 'websocket')
  assert.equal(turn1.upstreamSent, '1')
  assert.equal(turn1.modelsEtag, '"etag-packed-1"')
  assert.equal(turn1.turnTiming?.first_text_ms, 14)
  assert.equal(turn1.udsPacked?.endpoint, '/internal/v1/codex/responses/packed')
  assert.equal(turn1.udsPacked?.stored, true)
  assert.equal(turn1.udsPacked?.delta, false)
  assert.equal(turn1.udsPacked?.cacheMissRetried, false)
  assert.equal(turn1.headers['x-visible-header'], 'keep-me')
  for (const internalHeader of [
    'x-tap-turn-timing',
    'x-tap-interrupt',
    'x-kin-upstream-sent',
    'x-kin-upstream-error',
    'x-kin-uds-base',
    'x-kin-uds-received',
    'x-kin-uds-miss',
  ]) {
    assert.equal(turn1.headers[internalHeader], undefined, `${internalHeader} must be stripped from public headers`)
  }
  assert.equal(readyCallback?.interruptMode, 'websocket')
  assert.equal(typeof readyCallback?.interrupt, 'function')
  assert.equal(seenEvents.filter((l) => l.startsWith('data:')).length, 2)

  // Turn 2: appended turn reuses base via UDS delta
  const turn2Input = [
    ...sharedHistory,
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'follow-up delta turn 2' }] },
  ]
  const turn2 = await callCodexKernel({
    exec,
    timeoutMs: 5000,
    body: { model: 'gpt-5.4', stream: false, input: turn2Input },
    envelope: makeEnvelope(turn2Input, false),
  })
  assert.equal(turn2.ok, true)
  assert.equal(turn2.udsPacked?.endpoint, '/internal/v1/codex/responses/packed')
  assert.equal(turn2.udsPacked?.delta, true)
  assert.equal(recordedRequests[1].hasCopy, true)
  assert.equal(recordedRequests[1].cacheHit, '1')
  assert.ok(recordedRequests[1].rawWireBytes < recordedRequests[1].fullBytes)
  assert.equal(recordedRequests[1].parsed.body.input.length, turn2Input.length)

  // Turn 3: simulate kernel restart forgetting base -> 3-signal 409 triggers single transparent full-body retry
  simulateRestartMissOnce = true
  const turn3Input = [
    ...turn2Input,
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'after-restart turn 3' }] },
  ]
  const turn3 = await callCodexKernel({
    exec,
    timeoutMs: 5000,
    body: { model: 'gpt-5.4', stream: false, input: turn3Input },
    envelope: makeEnvelope(turn3Input, false),
  })
  assert.equal(turn3.ok, true)
  assert.equal(turn3.udsPacked?.endpoint, '/internal/v1/codex/responses/packed')
  assert.equal(turn3.udsPacked?.cacheMissRetried, true)
  assert.equal(turn3.udsPacked?.delta, false)
  assert.equal(recordedRequests.length, 3) // attempt[0] returned 409 miss before push; recordedRequests[2] is the full retry
  assert.equal(recordedRequests[2].hasCopy, false)
  assert.equal(recordedRequests[2].parsed.body.input.length, turn3Input.length)

  // interruptCodexKernel: 204 ok=true vs 409 ok=false status=409
  const intOk = await interruptCodexKernel(exec, { requestId: 'req_live', responseId: 'resp_p1' })
  assert.equal(intOk.ok, true)
  assert.equal(intOk.status, 204)

  const intConflict = await interruptCodexKernel(exec, { requestId: 'req_conflict', responseId: 'resp_p1' })
  assert.equal(intConflict.ok, false)
  assert.equal(intConflict.status, 409)
})

test('isCodexFailoverError refuses failover when upstream_sent is unknown', () => {
  assert.equal(
    isCodexFailoverError({
      ok: false,
      status: 502,
      upstreamSent: 'unknown',
      body: { error: { code: 'upstream_transport', message: 'read dropped mid-turn' } },
    }),
    false,
  )
  assert.equal(
    isCodexFailoverError({
      ok: false,
      status: 503,
      upstreamSent: 'unknown',
      body: { error: { code: 'server_error', message: 'ambiguous write' } },
    }),
    false,
  )
  assert.equal(
    isCodexFailoverError({
      ok: false,
      status: 503,
      upstreamSent: '0',
      body: { error: { code: 'server_error', message: 'never sent' } },
    }),
    true,
  )
})
