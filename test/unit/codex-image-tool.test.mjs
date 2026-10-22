import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { handleCodexProtocol, imageGenUsageFromSseLine } from '../../src/lib/protocol/handle-codex.mjs'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { loadGptModelPolicy, saveGptModelPolicy } from '../../src/lib/protocol/gpt-model-policy.mjs'
import { resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'

const IMAGE_GEN = {
  input_tokens: 300,
  input_tokens_details: { text_tokens: 100, image_tokens: 200 },
  output_tokens: 1000,
  total_tokens: 1300,
}

let root

beforeEach(() => {
  resetOpenAIAccountRuntime()
  openDatabase({ dbPath: ':memory:' })
  loadGptModelPolicy({ force: true })
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-image-'))
  const dir = path.join(root, 'vms')
  fs.mkdirSync(path.join(dir, 'vm-gpt'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'vm-gpt.json'),
    JSON.stringify({
      id: 'vm-gpt',
      platform: 'openai',
      family: 'codex',
      schedulable: true,
      status: 'running',
      has_token: true,
    }),
  )
  fs.writeFileSync(
    path.join(dir, 'vm-gpt', 'codex-credentials.json'),
    JSON.stringify({ accounts: [{ id: 'acc', access_token: 'at', refresh_token: 'rt', chatgpt_account_id: 'org' }] }),
  )
})

afterEach(() => {
  closeDatabase()
  loadGptModelPolicy({ force: true })
  fs.rmSync(root, { recursive: true, force: true })
})

const completed = (response) => `data: ${JSON.stringify({ type: 'response.completed', response })}\n`

async function run(
  body,
  { lines = [completed({ status: 'completed', usage: { input_tokens: 10, output_tokens: 5 } })] } = {},
) {
  const hops = []
  const res = { headersSent: false, statusCode: 0, body: null, write() {}, end() {} }
  const logBag = {}
  await handleCodexProtocol({
    req: { headers: {}, apiKeyKind: 'user' },
    res,
    protocol: 'openai.responses',
    ctx: { body, path: '/v1/responses' },
    inbound: { stream: false },
    logBag,
    stats: { errors: 0, requests: 0, by_route: {} },
    json: (_res, status, payload) => {
      res.statusCode = status
      res.body = payload
      return payload
    },
    writeSSEHeaders() {
      res.headersSent = true
    },
    routing: {},
    projectRoot: root,
    ops: {
      writeCodexKernelConfig() {},
      ensureCodexKernel: async () => ({ ok: true }),
      streamCodexKernel: async ({ envelope, onEvent }) => {
        hops.push(envelope.body)
        for (const line of lines) await onEvent(line)
        return { ok: true, status: 200, terminalState: 'verified' }
      },
    },
  })
  return { res, logBag, hops }
}

const tool = (model) => ({ type: 'image_generation', ...(model ? { model } : {}) })
const request = (model) => ({ model: 'gpt-6-luna', input: 'draw a cat', stream: false, tools: [tool(model)] })

test('a disabled image model is rejected locally with no upstream hop', async () => {
  saveGptModelPolicy({ image_tools: { 'gpt-image-2.5-sunburst': { enabled: false } } })
  for (const model of ['gpt-image-2.5-sunburst', 'gpt-image-2.5-sunburst-2026-09-08']) {
    const { res, logBag, hops } = await run(request(model))
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.error.code, 'model_disabled')
    assert.match(res.body.error.message, /disabled/)
    assert.equal(logBag.error_code, 'model_disabled')
    assert.equal(hops.length, 0)
  }
})

test('an enabled, omitted or unknown image model reaches the upstream unchanged', async () => {
  saveGptModelPolicy({ image_tools: { 'gpt-image-2.5-sunburst': { enabled: false } } })
  for (const model of ['gpt-image-2.5-flare', null, 'gpt-image-9']) {
    const { res, hops } = await run(request(model))
    assert.equal(res.statusCode, 200, String(model))
    assert.equal(hops.length, 1)
    assert.deepEqual(hops[0].tools, [tool(model)])
  }
})

test('tool_usage.image_gen from response.completed is captured for billing', async () => {
  const { res, logBag } = await run(request('gpt-image-2.5-flare-2026-09-08'), {
    lines: [
      'data: {"type":"response.created","response":{"status":"in_progress"}}\n',
      completed({
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 5 },
        tool_usage: { image_gen: IMAGE_GEN },
      }),
    ],
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(logBag.image_usage, IMAGE_GEN)
  assert.equal(logBag.image_model, 'gpt-image-2.5-flare')
  // Non-stream clients get the official field back too.
  assert.deepEqual(res.body.tool_usage, { image_gen: IMAGE_GEN })
})

test('no image tool usage leaves the image columns empty', async () => {
  const { logBag } = await run({ model: 'gpt-6-luna', input: 'hi', stream: false })
  assert.equal(logBag.image_usage, undefined)
  assert.equal(logBag.image_model, undefined)
})

test('imageGenUsageFromSseLine only reads terminal response frames', () => {
  assert.deepEqual(imageGenUsageFromSseLine(completed({ tool_usage: { image_gen: IMAGE_GEN } })), IMAGE_GEN)
  const incomplete = `data: ${JSON.stringify({ type: 'response.incomplete', response: { tool_usage: { image_gen: IMAGE_GEN } } })}\n`
  assert.deepEqual(imageGenUsageFromSseLine(incomplete), IMAGE_GEN)
  assert.equal(imageGenUsageFromSseLine('data: {"type":"response.output_text.delta","delta":"tool_usage"}\n'), null)
  assert.equal(imageGenUsageFromSseLine(completed({ tool_usage: {} })), null)
  assert.equal(imageGenUsageFromSseLine('event: x'), null)
})
