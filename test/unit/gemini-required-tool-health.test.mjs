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

test('required tools retain MAX_TOKENS completion semantics', async () => {
  const f = fixture({
    frames: [
      frame({ candidates: [{ content: { role: 'model', parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }] }),
    ],
  })
  const res = await f.call(requestBody({ tool_choice: 'required' }))
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(res.text).incomplete_details.reason, 'max_output_tokens')
  assert.equal(f.logs[0].final_state, 'verified')
})

test('local required-tool validation remains request-scoped with usage and no retries', async () => {
  for (const tool_choice of [
    'required',
    { type: 'function', name: 'known' },
    { type: 'allowed_tools', mode: 'required', tools },
  ]) {
    for (const parts of [[], [{ text: 'synthetic answer' }]]) {
      for (const stream of [false, true]) {
        const failures = []
        const completed = []
        const f = fixture({
          runtime: createMockSchedulerRuntime({
            onSwitch: () => assert.fail('required-tool validation must not retry'),
            onRelease: ({ payload }) => failures.push(payload),
          }),
          envIds: ['a', 'b'],
          attemptsRepo: { complete: (_id, _attempt, result) => completed.push(result) },
          poolScheduler: { unitCircuit: { recordFailure: () => assert.fail('must not penalize the circuit') } },
          frames: [
            frame({
              candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
              usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
            }),
          ],
        })
        const res = await f.call(requestBody({ tool_choice, stream }))
        assert.equal(res.status, stream ? 200 : 502)
        assert.match(res.text, /gemini_tool_call_required/)
        assert.equal(f.calls, 1)
        assert.equal(failures.length, 1)
        assert.equal(failures[0].http_status, 200)
        assert.equal(failures[0].error_class, 'request_protocol')
        assert.equal(failures[0].outcome, 'error')
        assert.equal(completed[0].errorScope, 'request')
        assert.equal(f.logs[0].usage.output_tokens, 5)
      }
    }
  }
})

test('upstream required-tool error names cannot impersonate a local validator', async () => {
  for (const status of [502, 504]) {
    const failures = []
    const slotPrefs = createGeminiSlotPrefs()
    const f = fixture({
      slotPrefs,
      runtime: createMockSchedulerRuntime({ onRelease: ({ payload }) => failures.push(payload) }),
      frames: [
        frame({
          error: {
            code: status,
            status: 'gemini_tool_call_required',
            localError: true,
            details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'gemini_tool_call_required' }],
          },
        }),
      ],
    })
    await f.call(requestBody({ tool_choice: 'required' }))
    assert.equal(failures[0].http_status, status)
    assert.equal(failures[0].error_class, status === 504 ? 'timeout' : 'server5xx')
    if (status === 502) assert.equal(slotPrefs.resolved('env-validation').unschedulable?.reason, 'upstream_502')
  }
})

for (const [label, toolChoice, response, expectedAttempts] of [
  [
    'required-text',
    'required',
    { candidates: [{ content: { role: 'model', parts: [{ text: 'answer' }] }, finishReason: 'STOP' }] },
    1,
  ],
]) {
  for (const stream of [false, true]) {
    test(`real Rust scheduler keeps accounts available after ${label} tool failure (stream=${stream})`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-tool-health-'))
      const envIds = ['a', 'b', 'c', 'd']
      let f
      const runtime = createSchedulerRuntime({
        getDb: () => null,
        getVms: () => [],
        getRoutingConfig: () => ({}),
        geminiScheduler: { listEnvironments: () => f.scheduler.listEnvironments() },
        telemetryIntervalMs: 0,
        clientOptions: {
          binPath: process.env.KIN_SCHEDULER_BIN,
          dataDir: dir,
          socketPath: path.join(dir, 'scheduler.sock'),
          tokenPath: path.join(dir, 'token'),
          capFile: path.join(dir, 'cap.json'),
        },
      })
      const slotPrefs = createGeminiSlotPrefs()
      f = fixture({ runtime, slotPrefs, envIds, frames: [frame(response)] })
      try {
        await f.scheduler.catalog()
        await runtime.start({ waitMs: 5000, startLoops: false })
        await runtime.pushTelemetryNow()
        const res = await f.call(requestBody({ tool_choice: toolChoice, stream }))
        assert.equal(res.status, stream ? 200 : 502, res.text)
        assert.match(res.text, /gemini_inference_invalid_output|gemini_tool_call_required/)
        assert.equal(f.calls, stream ? 1 : expectedAttempts, 'streamed terminal events must not be retried')
        for (const id of envIds) {
          assert.equal(slotPrefs.resolved(id).unschedulable, null)
          const leases = []
          try {
            // A cooled node can admit one probe; two simultaneous leases rule that out.
            for (let i = 0; i < 2; i++) {
              leases.push(
                await runtime.acquireNode({
                  originPoolId: '__virtual_gemini__',
                  apiKeyKind: 'master',
                  ownerScope: { type: 'platform' },
                  allowedNodeKeys: [`gemini_env:${id}`],
                  nodeTypes: ['gemini_env'],
                  model,
                  modelFamily: 'gemini',
                  protocol: 'google.gemini',
                  sessionId: crypto.randomUUID(),
                  noQueue: true,
                }),
              )
            }
          } finally {
            for (const lease of leases) await runtime.releaseLease(lease.lease_id, 'aborted')
          }
        }
      } finally {
        await runtime.shutdown({ drain: false, stopProcess: true })
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  }
}
