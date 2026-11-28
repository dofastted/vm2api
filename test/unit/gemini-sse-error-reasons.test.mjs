import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'
import { sanitizeErrorDetailsForLog } from '../../src/lib/core/errors.mjs'
import { createGeminiPublicHandler } from '../../src/lib/gemini/routes.mjs'
import { createGeminiSlotPrefs } from '../../src/lib/gemini/slot-prefs.mjs'
import { createGeminiScheduler } from '../../src/lib/gemini/scheduler.mjs'
import { readBody } from '../../src/lib/http/respond.mjs'
import {
  FULL_GEMINI_CAPABILITIES,
  buildGeminiRequest,
  createGeminiCollector,
  createGeminiEventDecoder,
  createGeminiRestoreTransform,
  parseInboundToGemini,
} from '../../src/lib/protocol/gemini-convert.mjs'
import { createSchedulerRuntime } from '../../src/lib/scheduler/scheduler-runtime.mjs'
import { SchedulerApiError } from '../../src/lib/transport/scheduler-client.mjs'
import { createMockSchedulerRuntime } from '../helpers/mock-scheduler-runtime.mjs'

const model = 'gemini-4-neon-xhigh'
const tools = [{ type: 'function', name: 'known', parameters: { type: 'object', properties: {} } }]
const requestBody = (extra = {}) => ({ model, input: 'synthetic check', tools, ...extra })
const parse = (extra = {}) => parseInboundToGemini('openai-responses', requestBody(extra))
const chunk = (names, extra = {}) => ({
  candidates: [
    {
      content: { role: 'model', parts: names.map((name) => ({ functionCall: { name, args: {} } })) },
      finishReason: 'STOP',
    },
  ],
  ...extra,
})
const frame = (body) => `data: ${JSON.stringify(body)}\n\n`

function restore(ir, body) {
  const decoder = createGeminiEventDecoder()
  const transform = createGeminiRestoreTransform(ir.restoreContext, { target: 'antigravity' })
  const collector = createGeminiCollector()
  decoder.decodeChunk(body, (event) => transform.push(event, (out) => collector.push(out)))
  transform.flush((out) => collector.push(out))
  return collector.result()
}

function fixture({
  frames = [],
  runtime = createMockSchedulerRuntime(),
  bodyReader = readBody,
  requestLog,
  slotPrefs,
  envIds = ['env-validation'],
  poolScheduler,
  attemptsRepo,
  getRoutingConfig,
} = {}) {
  let calls = 0
  const logs = []
  const scheduler = createGeminiScheduler({
    schedulerRuntime: runtime,
    slotPrefs,
    poolScheduler,
    attemptsRepo,
    getRoutingConfig,
    callHost: async (op, args) => {
      const env = {
        id: args?.id || envIds[0],
        proxy_id: 'px',
        auth_method: 'oauth',
        auth_state: 'authorized',
        models_discovered: true,
        models: [model],
        capabilities: [...FULL_GEMINI_CAPABILITIES],
      }
      if (op === 'list') return { payload_state: 'installed', environments: envIds.map((id) => ({ ...env, id })) }
      if (op === 'get') return env
      throw new Error(`unexpected host operation: ${op}`)
    },
    callHostStream: async () => {
      calls++
      return Object.assign(Readable.from(frames), { statusCode: 200, headers: { 'content-type': 'text/event-stream' } })
    },
    resolveProxy: () => 'socks5h://192.0.2.1:1080',
  })
  const handler = createGeminiPublicHandler({
    scheduler,
    readBody: bodyReader,
    json: (res, status, body) => {
      res.statusCode = status
      res.end(JSON.stringify(body))
    },
    requestLog: requestLog || {
      start: () => ({ request_id: `validation-${logs.length}` }),
      finish: (_ctx, log) => logs.push(log),
    },
  })
  return {
    logs,
    scheduler,
    get calls() {
      return calls
    },
    async call(body, { path = '/v1/responses', raw } = {}) {
      const req = Object.assign(raw === undefined ? new EventEmitter() : Readable.from([raw]), {
        method: 'POST',
        url: path,
        body,
        headers: {},
        apiKeyKind: 'managed',
        apiKeyRecord: { id: 'test', group_type: 'gemini' },
      })
      const res = new EventEmitter()
      Object.assign(res, { statusCode: 200, headers: {}, chunks: [], writableEnded: false, headersSent: false })
      res.setHeader = (key, value) => {
        res.headers[key.toLowerCase()] = value
      }
      res.writeHead = (status, headers = {}) => {
        res.statusCode = status
        res.headersSent = true
        Object.assign(res.headers, headers)
      }
      res.write = (data) => {
        res.headersSent = true
        res.chunks.push(String(data))
        return true
      }
      res.end = (data) => {
        if (data) res.write(data)
        res.writableEnded = true
        res.emit('finish')
      }
      await handler(req, res)
      return { status: res.statusCode, headers: res.headers, text: res.chunks.join('') }
    },
  }
}

test('all SSE error envelopes retain ErrorInfo reason without copying arbitrary metadata', async () => {
  const error = {
    code: 504,
    status: 'DEADLINE_EXCEEDED',
    message: 'timeout',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'gemini_inference_timeout',
        metadata: { private: 'not-for-public-output' },
      },
    ],
  }
  for (const wire of [frame({ error }), `event: error\n${frame({ error })}`, frame({ response: { error } })]) {
    const events = []
    createGeminiEventDecoder().decodeSseFrame(wire, (e) => events.push(e))
    assert.equal(events[0].reason, 'gemini_inference_timeout')
    assert.equal(events[0].code, 'DEADLINE_EXCEEDED')
    const f = fixture({ frames: [wire] })
    const res = await f.call(requestBody())
    assert.equal(res.status, 504)
    assert.equal(JSON.parse(res.text).error.code, 'gemini_inference_timeout')
    assert.doesNotMatch(res.text, /not-for-public-output/)
  }
})

test('unknown upstream reasons stay diagnostic; a committed error stays an SSE error', async () => {
  const error = {
    code: 504,
    status: 'DEADLINE_EXCEEDED',
    message: 'timeout',
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'UNRECOGNIZED_REASON' }],
  }
  const f = fixture({
    frames: [
      frame({ candidates: [{ content: { role: 'model', parts: [{ text: 'thinking', thought: true }] } }] }),
      frame({ error }),
    ],
  })
  const res = await f.call(requestBody({ stream: true }))
  assert.equal(res.status, 200)
  assert.match(res.text, /gemini_inference_failed/)
  assert.equal(f.logs[0].upstream_status, 504)
  const events = []
  createGeminiEventDecoder().decodeSseFrame(frame({ error }), (event) => events.push(event))
  assert.equal(events[0].reason, 'UNRECOGNIZED_REASON')
  assert.equal(f.calls, 1, 'no retry after protocol data is committed')
})
