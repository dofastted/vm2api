import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  reasoningHistoryFallback,
  runCodexKernelHop,
  handleCodexProtocol,
} from '../../src/lib/protocol/handle-codex.mjs'
import { resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'
import { createMockSchedulerRuntime } from '../helpers/mock-scheduler-runtime.mjs'

const LIMIT = 128 * 1024
const KEEP_BUDGET = 120 * 1024

function arrayBytes(parts) {
  return Buffer.byteLength(JSON.stringify(parts))
}

function blob(n, ch = 'x') {
  return ch.repeat(n)
}

function serverError(status = 500, extra = {}) {
  return {
    ok: false,
    status,
    committed: false,
    transportError: false,
    body: {
      type: 'error',
      status: 500,
      error: {
        type: 'server_error',
        code: 'server_error',
        message: 'An error occurred while processing your request...',
      },
    },
    ...extra,
  }
}

function oversizedPair() {
  const old = blob(100000, 'a')
  const recent = blob(40000, 'b')
  return { old, recent, bytes: arrayBytes([old, recent]) }
}

function qualifyingArgs({
  input,
  body: bodyExtra = {},
  headers = {},
  session = {},
  signal,
  previous_response_id,
} = {}) {
  const { old, recent } = oversizedPair()
  const nextInput = input || [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'keep-first' }] },
    { type: 'reasoning', encrypted_content: old, summary: [] },
    { type: 'function_call', name: 'web.run', arguments: '{}' },
    { type: 'function_call_output', output: 'tool-keep' },
    { type: 'reasoning', encrypted_content: recent, summary: [] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'keep-last' }] },
  ]
  const body = {
    model: 'gpt-6-astra',
    stream: true,
    reasoning: { context: 'all_turns', effort: 'max' },
    input: nextInput,
    ...bodyExtra,
  }
  if (previous_response_id) body.previous_response_id = previous_response_id
  return {
    body,
    envelope: {
      headers: { 'x-openai-internal-codex-responses-lite': 'true', ...headers },
      session,
      body,
    },
    signal,
  }
}

function encryptedItems(input) {
  return (input || []).filter(
    (item) => item?.type === 'reasoning' && typeof item.encrypted_content === 'string' && item.encrypted_content,
  )
}

function writeGptVm(root, id) {
  const dir = path.join(root, 'vms')
  fs.mkdirSync(path.join(dir, id), { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      name: id,
      platform: 'openai',
      family: 'codex',
      schedulable: true,
      status: 'running',
      has_token: true,
    }),
  )
  fs.writeFileSync(
    path.join(dir, id, 'codex-credentials.json'),
    JSON.stringify({
      accounts: [{ id: `${id}-acc`, access_token: 'at', refresh_token: 'rt', chatgpt_account_id: id }],
    }),
  )
}

test('reasoningHistoryFallback gates on env, status, model, lite header and session', () => {
  const args = qualifyingArgs()
  assert.ok(arrayBytes(encryptedItems(args.body.input).map((item) => item.encrypted_content)) > LIMIT)

  assert.ok(reasoningHistoryFallback(args, serverError(500)))
  assert.ok(reasoningHistoryFallback(args, serverError(502)))
  assert.equal(reasoningHistoryFallback(args, serverError(503)), null)
  assert.equal(reasoningHistoryFallback(args, { ...serverError(500), ok: true, status: 200 }), null)
  assert.equal(reasoningHistoryFallback(args, { ...serverError(500), committed: true }), null)
  assert.equal(reasoningHistoryFallback(args, { ...serverError(500), transportError: true }), null)
  assert.equal(
    reasoningHistoryFallback(args, {
      ...serverError(500),
      body: { error: { type: 'api_error', code: 'upstream_transport', message: 'reset' } },
    }),
    null,
  )
  const aborted = new AbortController()
  aborted.abort()
  assert.equal(reasoningHistoryFallback(qualifyingArgs({ signal: aborted.signal }), serverError()), null)

  assert.equal(reasoningHistoryFallback(qualifyingArgs({ body: { model: 'gpt-6.1-sol' } }), serverError()), null)
  assert.equal(
    reasoningHistoryFallback(
      qualifyingArgs({ body: { reasoning: { context: 'none', effort: 'max' } } }),
      serverError(),
    ),
    null,
  )
  assert.equal(reasoningHistoryFallback(qualifyingArgs({ body: { input: 'not-array' } }), serverError()), null)
  assert.equal(
    reasoningHistoryFallback(
      qualifyingArgs({ headers: { 'x-openai-internal-codex-responses-lite': 'false' } }),
      serverError(),
    ),
    null,
  )
  assert.equal(reasoningHistoryFallback(qualifyingArgs({ previous_response_id: 'resp_prev' }), serverError()), null)
  assert.equal(
    reasoningHistoryFallback(qualifyingArgs({ session: { previous_response_id: 'resp_prev' } }), serverError()),
    null,
  )

  const prev = process.env.KIN_CODEX_REASONING_HISTORY_FALLBACK
  process.env.KIN_CODEX_REASONING_HISTORY_FALLBACK = '0'
  try {
    assert.equal(reasoningHistoryFallback(args, serverError()), null)
  } finally {
    if (prev === undefined) delete process.env.KIN_CODEX_REASONING_HISTORY_FALLBACK
    else process.env.KIN_CODEX_REASONING_HISTORY_FALLBACK = prev
  }
})

test('reasoningHistoryFallback keeps a newest contiguous suffix under 120 KiB without mutating the original body', () => {
  const { old, recent } = oversizedPair()
  const args = qualifyingArgs()
  const snapshot = structuredClone(args.body)
  const fallback = reasoningHistoryFallback(args, serverError())
  assert.ok(fallback)
  assert.deepEqual(args.body, snapshot)
  assert.notEqual(fallback.args.body, args.body)
  assert.notEqual(fallback.args.body.input, args.body.input)
  assert.equal(args.envelope.body, args.body)

  const kept = encryptedItems(fallback.args.body.input)
  assert.equal(kept.length, 1)
  assert.equal(kept[0].encrypted_content, recent)
  assert.equal(fallback.info.original_items, 2)
  assert.equal(fallback.info.retained_items, 1)
  assert.equal(fallback.info.omitted_items, 1)
  assert.equal(fallback.info.original_array_bytes, arrayBytes([old, recent]))
  assert.ok(fallback.info.retained_array_bytes <= KEEP_BUDGET)
  assert.deepEqual(
    fallback.args.body.input.filter((item) => item.type !== 'reasoning').map((item) => item.type || item.role),
    snapshot.input.filter((item) => item.type !== 'reasoning').map((item) => item.type || item.role),
  )
  assert.equal(
    fallback.args.body.input.find((item) => item.type === 'message' && item.content?.[0]?.text === 'keep-first')
      .content[0].text,
    'keep-first',
  )
  assert.equal(fallback.args.body.input.at(-1).content[0].text, 'keep-last')
  assert.equal(fallback.args.body.input.find((item) => item.type === 'function_call_output').output, 'tool-keep')
})

test('reasoningHistoryFallback does not skip a middle reasoning item to keep an older one', () => {
  const oldest = blob(100000, 'a')
  const middle = blob(20000, 'b')
  const newest = blob(20000, 'c')
  assert.ok(arrayBytes([oldest, middle, newest]) > LIMIT)
  const args = qualifyingArgs({
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'u1' }] },
      { type: 'reasoning', encrypted_content: oldest, summary: [] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a1' }] },
      { type: 'reasoning', encrypted_content: middle, summary: [] },
      { type: 'function_call_output', output: 'tool' },
      { type: 'reasoning', encrypted_content: newest, summary: [] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'u2' }] },
    ],
  })
  const fallback = reasoningHistoryFallback(args, serverError())
  assert.ok(fallback)
  const kept = encryptedItems(fallback.args.body.input).map((item) => item.encrypted_content)
  assert.deepEqual(kept, [middle, newest])
  assert.equal(fallback.info.omitted_items, 1)
  assert.ok(!kept.includes(oldest))
})

test('reasoningHistoryFallback stays off at 128 KiB and when nothing can be omitted', () => {
  const exact = blob(LIMIT - 4)
  assert.equal(arrayBytes([exact]), LIMIT)
  assert.equal(
    reasoningHistoryFallback(
      qualifyingArgs({
        input: [{ type: 'reasoning', encrypted_content: exact, summary: [] }],
      }),
      serverError(),
    ),
    null,
  )

  const over = blob(LIMIT - 3)
  assert.ok(arrayBytes([over]) > LIMIT)
  // Single item already over the 120 KiB retain budget: cannot keep a suffix.
  assert.equal(
    reasoningHistoryFallback(
      qualifyingArgs({
        input: [{ type: 'reasoning', encrypted_content: over, summary: [] }],
      }),
      serverError(),
    ),
    null,
  )
})

test('runCodexKernelHop retries an uncommitted 500/502 server_error once with trimmed history', async () => {
  for (const status of [500, 502]) {
    const args = qualifyingArgs()
    const originalInput = args.body.input
    const hops = []
    const result = await runCodexKernelHop({
      hop: async (call) => {
        hops.push(call.body)
        if (hops.length === 1) return serverError(status)
        return { ok: true, status: 200, terminalState: 'verified' }
      },
      args,
    })
    assert.equal(hops.length, 2, `status ${status}`)
    assert.equal(hops[0].input, originalInput)
    assert.equal(encryptedItems(hops[1].input).length, 1)
    assert.equal(encryptedItems(hops[1].input)[0].encrypted_content, oversizedPair().recent)
    assert.equal(result.ok, true)
    assert.equal(result.reasoning_history_retried, true)
    assert.equal(result.reasoning_history_fallback.omitted_items, 1)
    assert.equal(result.transport_retried, undefined)
    assert.equal(args.body.input, originalInput)
  }
})

test('runCodexKernelHop does not stack reasoning fallback after emit, transport retry, or cancel', async () => {
  let n = 0
  const emitted = await runCodexKernelHop({
    hop: async ({ onEvent }) => {
      n += 1
      await onEvent('data: {"type":"response.output_item.added"}')
      return serverError(500)
    },
    args: qualifyingArgs(),
  })
  assert.equal(n, 1)
  assert.equal(emitted.reasoning_history_retried, undefined)

  n = 0
  const transportThenError = await runCodexKernelHop({
    hop: async () => {
      n += 1
      if (n === 1)
        return { ok: false, status: 502, transportError: true, body: { error: { code: 'upstream_transport' } } }
      return serverError(500)
    },
    args: qualifyingArgs(),
  })
  assert.equal(n, 2)
  assert.equal(transportThenError.transport_retried, true)
  assert.equal(transportThenError.reasoning_history_retried, undefined)

  n = 0
  const ac = new AbortController()
  const cancelled = await runCodexKernelHop({
    hop: async () => {
      n += 1
      return serverError(500)
    },
    args: qualifyingArgs({ signal: ac.signal }),
    onReasoningFallback: () => ac.abort(),
  })
  assert.equal(n, 1)
  assert.equal(cancelled.ok, false)
  assert.equal(cancelled.reasoning_history_retried, undefined)
})

test('handleCodexProtocol counts the extra attempt on the same slot and records the retry body', async () => {
  resetOpenAIAccountRuntime()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-hist-'))
  writeGptVm(root, 'vm-gpt-a')
  writeGptVm(root, 'vm-gpt-b')
  const { old, recent } = oversizedPair()
  const logBag = {}
  const seen = []
  const bodies = []
  const out = await handleCodexProtocol({
    req: {
      headers: {
        'user-agent': 'curl/8.0',
        'x-openai-internal-codex-responses-lite': 'true',
      },
      apiKeyKind: 'user',
    },
    res: { headersSent: false, write() {}, end() {} },
    protocol: 'openai.responses',
    ctx: {
      path: '/v1/responses',
      body: {
        model: 'gpt-6-astra',
        stream: false,
        reasoning: { context: 'all_turns', effort: 'max' },
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'keep-first' }] },
          { type: 'reasoning', encrypted_content: old, summary: [] },
          { type: 'function_call_output', output: 'tool-keep' },
          { type: 'reasoning', encrypted_content: recent, summary: [] },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'keep-last' }] },
        ],
      },
    },
    inbound: { stream: false },
    logBag,
    stats: { errors: 0, requests: 0, by_route: {} },
    json: (_res, status, body) => ({ status, body }),
    writeSSEHeaders() {},
    routing: { pool: { fallback_wait_timeout_ms: 5000 } },
    projectRoot: root,
    schedulerRuntime: createMockSchedulerRuntime({ projectRoot: root }),
    captureOutbound: true,
    ops: {
      writeCodexKernelConfig() {},
      ensureCodexKernel: async () => ({ ok: true }),
      streamCodexKernel: async ({ exec, body }) => {
        seen.push(exec.vm.id)
        bodies.push(body)
        if (bodies.length === 1) return serverError(500)
        return { ok: true, status: 200, terminalState: 'verified', body: { id: 'resp_ok' } }
      },
    },
  })
  assert.equal(out.status, 200)
  assert.deepEqual(seen, ['vm-gpt-a', 'vm-gpt-a'])
  assert.equal(logBag.attempt_count, 2)
  assert.equal(logBag.reasoning_history_retried, true)
  assert.equal(encryptedItems(bodies[0].input).length, 2)
  assert.equal(encryptedItems(bodies[1].input).length, 1)
  assert.equal(encryptedItems(logBag.outbound_body.input).length, 1)
  assert.equal(encryptedItems(logBag.outbound_body.input)[0].encrypted_content, recent)
  resetOpenAIAccountRuntime()
  fs.rmSync(root, { recursive: true, force: true })
})
