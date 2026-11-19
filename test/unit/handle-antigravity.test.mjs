import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { handleAntigravityProtocol } from '../../src/lib/protocol/handle-antigravity.mjs'
import { createAntigravityPoolRuntime } from '../../src/lib/pool/antigravity-slot-pool.mjs'
import { createAntigravityResponseStore } from '../../src/lib/protocol/antigravity-response-store.mjs'
import { StickyRouter } from '../../src/lib/pool/sticky-router.mjs'

const slot = {
  id: 'vm-ag-01',
  platform: 'antigravity',
  status: 'running',
  schedulable: true,
  antigravity: { authenticated: true },
  proxy: { id: 'px-test', host: '1.2.3.4', port: 1080 },
}
const success = {
  ok: true,
  status: 200,
  content: [{ type: 'text', text: 'Hello' }],
  usage: { input_tokens: 10, output_tokens: 2 },
  stop_reason: 'end_turn',
  terminalState: 'verified',
}

async function invoke({
  protocol = 'openai.chat',
  body,
  slots = [slot],
  inference = async () => success,
  requestPatch = {},
  responsePatch = {},
  accountGate = null,
  extraOps = {},
  runtime = createAntigravityPoolRuntime(),
  store = createAntigravityResponseStore(),
  keyStore = null,
  routing = null,
  stickyRouter = null,
} = {}) {
  const req = Object.assign(
    new EventEmitter(),
    { headers: {}, apiKeyKind: 'managed', apiKeyRecord: { id: 'key-one' } },
    requestPatch,
  )
  const res = Object.assign(
    new EventEmitter(),
    {
      headersSent: false,
      writableEnded: false,
      writableLength: 0,
      chunks: [],
      write(chunk) {
        this.chunks.push(chunk)
      },
      end() {
        this.writableEnded = true
      },
    },
    responsePatch,
  )
  const logBag = {}
  const stats = { requests: 0, errors: 0, by_route: {} }
  const actualBody =
    body ||
    (protocol === 'openai.responses'
      ? { model: 'model-one', input: 'hello' }
      : { model: 'model-one', messages: [{ role: 'user', content: 'hello' }] })
  let runs = 0,
    billed = 0
  await handleAntigravityProtocol({
    req,
    res,
    protocol,
    inbound: actualBody,
    ctx: { body: actualBody },
    logBag,
    stats,
    json: (response, status, value) => {
      response.status = status
      response.body = value
      response.end()
    },
    writeSSEHeaders: (response) => {
      response.headersSent = true
      response.status = 200
    },
    routing: routing || {
      antigravity: { enabled: true, models: ['model-one-low', 'model-one-medium', 'model-one-high'] },
    },
    projectRoot: '/unused',
    stickyRouter,
    apiKeyStore: keyStore,
    accountGate,
    recordUsage: () => {
      billed++
    },
    ops: {
      keyScope: () => ({ group_type: 'all' }),
      listVms: () => slots,
      getVm: (_root, id) => slots.find((vm) => vm.id === id),
      supportsModel: () => true,
      runtime,
      responseStore: store,
      runInference: async (args) => {
        runs++
        return inference(args, runs)
      },
      ...extraOps,
    },
  })
  return { req, res, logBag, stats, runs, billed, runtime, store }
}

test('disconnected requests never start upstream inference', async () => {
  for (const patches of [
    { requestPatch: { aborted: true } },
    { responsePatch: { destroyed: true } },
    { responsePatch: { writableEnded: true } },
  ]) {
    const h = await invoke(patches)
    assert.equal(h.runs, 0)
    assert.equal(h.logBag.final_state, 'cancelled')
  }
  const request = new AbortController()
  const h = await invoke({
    accountGate: async () => {
      request.abort()
      return false
    },
    requestPatch: {
      once(name, listener) {
        if (name === 'aborted') request.signal.addEventListener('abort', listener)
      },
      off() {},
    },
  })
  assert.equal(h.runs, 0)
  assert.equal(h.logBag.final_state, 'cancelled')
})

test('reasoning effort selects the upstream variant and carries the level; base ID is what gets logged', async () => {
  const cases = [
    ['openai.chat', { reasoning_effort: 'high' }, 'model-one-high', 'high'],
    ['openai.responses', { reasoning: { effort: 'low' } }, 'model-one-low', 'low'],
    ['anthropic.messages', { output_config: { effort: 'high' }, max_tokens: 64 }, 'model-one-high', 'high'],
    ['openai.chat', {}, 'model-one-medium', 'medium'],
  ]
  for (const [protocol, extra, upstream, level] of cases) {
    let sent
    const body =
      protocol === 'openai.responses'
        ? { model: 'model-one', input: 'hello', ...extra }
        : { model: 'model-one', messages: [{ role: 'user', content: 'hello' }], ...extra }
    const h = await invoke({
      protocol,
      body,
      inference: async ({ request }) => {
        sent = request
        return success
      },
    })
    assert.equal(h.res.status, 200, JSON.stringify(h.res.body))
    assert.equal(sent.model, upstream)
    assert.deepEqual(sent.reasoning, { effort: level })
    assert.equal(h.logBag.upstream_model, 'model-one')
    assert.equal(h.logBag.reasoning_effort, level)
    assert.equal(h.res.body.model, 'model-one')
  }
  const unsupported = await invoke({
    body: { model: 'model-one', reasoning_effort: 'minimal', messages: [{ role: 'user', content: 'hi' }] },
  })
  assert.equal(unsupported.res.status, 400)
  assert.equal(unsupported.res.body.error.code, 'reasoning_effort_not_supported')
  assert.match(unsupported.res.body.error.message, /low, medium, high/)
  assert.equal(unsupported.runs, 0)
  for (const model of ['model-one-high', 'antigravity/model-one']) {
    const legacy = await invoke({ body: { model, messages: [{ role: 'user', content: 'hi' }] } })
    assert.equal(legacy.res.body.error.code, 'model_not_allowed', model)
    assert.equal(legacy.runs, 0)
  }
})

test('Antigravity handler returns native envelopes and usage for all three public protocols', async () => {
  for (const protocol of ['openai.chat', 'openai.responses', 'anthropic.messages']) {
    const h = await invoke({ protocol })
    assert.equal(h.res.status, 200)
    assert.equal(h.runs, 1)
    assert.equal(h.billed, 1)
    assert.equal(h.logBag.vm_id, slot.id)
    assert.equal(h.logBag.input_tokens, 10)
    assert.equal(h.logBag.final_state, 'verified')
    assert.equal(h.runtime.snapshot(slot.id).inFlight, 0)
    assert.equal(
      protocol === 'openai.chat'
        ? h.res.body.choices[0].message.content
        : protocol === 'anthropic.messages'
          ? h.res.body.content[0].text
          : h.res.body.output_text,
      'Hello',
    )
  }
})

test('Antigravity stream preserves deltas and ends with exactly one verified terminal', async () => {
  const h = await invoke({
    body: {
      model: 'model-one',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
      stream_options: { include_usage: true },
    },
    inference: async ({ onEvent }) => {
      onEvent({ type: 'text_delta', text: 'Hel' })
      onEvent({ type: 'text_delta', text: 'lo' })
      return success
    },
  })
  const stream = h.res.chunks.join('')
  assert.match(stream, /"content":"Hel"/)
  assert.match(stream, /"content":"lo"/)
  assert.equal(stream.match(/\[DONE\]/g)?.length, 1)
  assert.match(stream, /"prompt_tokens":10/)
})

test('Uncommitted transient failures switch accounts, while committed streams never replay', async () => {
  const slots = [slot, { ...slot, id: 'vm-ag-02' }]
  const h = await invoke({
    slots,
    inference: async (_args, count) =>
      count === 1 ? { ok: false, status: 429, code: 'quota_exhausted', message: 'Upstream quota exhausted' } : success,
  })
  assert.equal(h.runs, 2)
  assert.equal(h.res.status, 200)
  const partial = await invoke({
    slots,
    body: { model: 'model-one', stream: true, messages: [{ role: 'user', content: 'hello' }] },
    inference: async ({ onEvent }) => {
      onEvent({ type: 'text_delta', text: 'part' })
      return { ok: false, status: 502, code: 'upstream_stream_incomplete', message: 'Stream interrupted' }
    },
  })
  assert.equal(partial.runs, 1)
  assert.match(partial.res.chunks.join(''), /upstream_stream_incomplete/)
  assert.doesNotMatch(partial.res.chunks.join(''), /\[DONE\]/)
})

test('Content safety blocks reach clients and tenant logs as a generic moderation refusal', async () => {
  const blocked = {
    ok: false,
    status: 400,
    code: 'antigravity_content_blocked',
    message: 'Antigravity generation ended with PROHIBITED_CONTENT',
  }
  const h = await invoke({ slots: [slot, { ...slot, id: 'vm-ag-02' }], inference: async () => blocked })
  assert.equal(h.runs, 1)
  assert.equal(h.res.status, 400)
  assert.equal(h.res.body.error.code, 'content_filter_refusal')
  assert.doesNotMatch(JSON.stringify(h.res.body), /antigravity/i)
  assert.equal(h.logBag.error_code, 'content_filter_refusal')
  assert.equal(h.logBag.error_message, 'The request was blocked by content safety review. (PROHIBITED_CONTENT)')
  const streamed = await invoke({
    body: { model: 'model-one', stream: true, messages: [{ role: 'user', content: 'hello' }] },
    inference: async ({ onEvent }) => {
      onEvent({ type: 'text_delta', text: 'part' })
      return { ...blocked, message: 'Antigravity rejected this request' }
    },
  })
  assert.match(streamed.res.chunks.join(''), /content_filter_refusal/)
  assert.doesNotMatch(streamed.res.chunks.join(''), /antigravity/i)
  assert.equal(streamed.logBag.error_message, 'The request was blocked by content safety review. (PROMPT_BLOCKED)')
})

test('Upstream errors never name Antigravity to clients or in logs', async () => {
  const busy = await invoke({
    inference: async () => ({
      ok: false,
      status: 400,
      code: 'invalid_request',
      message: 'Antigravity service returned HTTP 400',
    }),
  })
  assert.equal(busy.res.body.error.message, 'Upstream service returned HTTP 400')
  assert.equal(busy.logBag.error_message, 'Upstream service returned HTTP 400')
  const denied = await invoke({ extraOps: { keyScope: () => ({ group_type: 'anthropic' }) } })
  assert.equal(denied.res.status, 403)
  assert.equal(denied.res.body.error.message, '此密钥不可调用上游。')
  assert.equal(denied.logBag.error_message, '此密钥不可调用上游。')
})

test('Responses continuation carries canonical history only for its key and model', async () => {
  const store = createAntigravityResponseStore()
  const first = await invoke({ protocol: 'openai.responses', store })
  const body = { model: 'model-one', previous_response_id: first.res.body.id, input: 'continue' }
  let history
  const next = await invoke({
    protocol: 'openai.responses',
    body,
    store,
    inference: async ({ request }) => {
      history = request.messages
      return success
    },
  })
  assert.equal(next.res.status, 200)
  assert.equal(history.length, 3)
  assert.equal(history[1].role, 'assistant')
  const stolen = await invoke({
    protocol: 'openai.responses',
    body,
    store,
    requestPatch: { apiKeyRecord: { id: 'key-other' } },
  })
  assert.equal(stolen.res.status, 404)
  assert.equal(stolen.runs, 0)
  const noStore = await invoke({
    protocol: 'openai.responses',
    body: { model: 'model-one', input: 'private', store: false },
    store,
  })
  const missing = await invoke({
    protocol: 'openai.responses',
    body: { model: 'model-one', input: 'continue', previous_response_id: noStore.res.body.id },
    store,
  })
  assert.equal(missing.res.status, 404)
})

test('Managed key admission/release is enforced even on upstream errors', async () => {
  let acquired = 0,
    released = 0
  const keyStore = {
    acquire() {
      acquired++
      return { ok: true }
    },
    release() {
      released++
    },
  }
  const h = await invoke({
    keyStore,
    inference: async () => {
      throw new Error('private upstream diagnostic')
    },
  })
  assert.equal(acquired, 1)
  assert.equal(released, 1)
  assert.equal(h.res.status, 502)
  assert.doesNotMatch(JSON.stringify(h.res.body), /private upstream diagnostic/)
  const rejected = await invoke({
    keyStore: { acquire: () => ({ ok: false, status: 429, code: 'key_concurrency', message: 'Full' }) },
  })
  assert.equal(rejected.runs, 0)
  assert.equal(rejected.res.status, 429)
})

test('Tenant ownership and live pool membership cannot be widened by an ordinary key pin', async () => {
  const h = await invoke({
    slots: [{ ...slot, owner_user_id: 'another-user' }],
    requestPatch: { headers: { 'x-kin-vm': slot.id } },
  })
  assert.equal(h.runs, 0)
  assert.equal(h.res.status, 503)
  const empty = await invoke({
    extraOps: {
      keyScope: () => ({ group_type: 'all', vm_pool_id: 'pool_12345678', allowed_vms: [], vm_pool_error: 'empty' }),
    },
  })
  assert.equal(empty.res.status, 403)
  assert.equal(empty.runs, 0)
})

test('A full slot queues for antigravity.queue_timeout_ms, independent of the Claude pool wait', async () => {
  const runtime = createAntigravityPoolRuntime()
  const held = runtime.acquire(slot.id, { concurrency: 1 })
  setTimeout(() => held.release(), 50)
  const routing = {
    antigravity: { enabled: true, models: ['model-one-medium'], queue_timeout_ms: 2000 },
    pool: { fallback_wait_timeout_ms: 1 },
  }
  const queued = await invoke({ runtime, routing })
  assert.equal(queued.res.status, 200)
  assert.equal(queued.runs, 1)

  const busy = createAntigravityPoolRuntime()
  busy.acquire(slot.id, { concurrency: 1 })
  const started = Date.now()
  const timedOut = await invoke({
    runtime: busy,
    routing: { ...routing, antigravity: { ...routing.antigravity, queue_timeout_ms: 1000 } },
  })
  assert.equal(timedOut.res.status, 429)
  assert.equal(timedOut.res.body.error.code, 'antigravity_capacity_unavailable')
  assert.ok(Date.now() - started >= 900)
  assert.equal(timedOut.runs, 0)
})

test('A slot runs as many concurrent requests as its resolved max_concurrency allows', async () => {
  const runtime = createAntigravityPoolRuntime()
  const routing = {
    antigravity: { enabled: true, models: ['model-one-medium'], max_sessions: 3, queue_timeout_ms: 1000 },
  }
  let active = 0,
    peak = 0
  const inference = async () => {
    peak = Math.max(peak, ++active)
    await new Promise((resolve) => setTimeout(resolve, 30))
    active--
    return success
  }
  const results = await Promise.all(
    Array.from({ length: 3 }, () => invoke({ runtime, routing, slots: [{ ...slot, max_concurrency: 3 }], inference })),
  )
  assert.deepEqual(
    results.map((h) => h.res.status),
    [200, 200, 200],
  )
  assert.equal(peak, 3)
})

function affinityHarness(t, affinityWaitMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-ag-sticky-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const router = new StickyRouter({ dataDir: dir, config: { sticky: { enabled: true, ttl_seconds: 600 } } })
  const runtime = createAntigravityPoolRuntime()
  const slots = [slot, { ...slot, id: 'vm-ag-02' }]
  const routing = {
    antigravity: {
      enabled: true,
      models: ['model-one-medium'],
      queue_timeout_ms: 2000,
      affinity_wait_ms: affinityWaitMs,
    },
  }
  const turn = async (messages) =>
    (
      await invoke({
        body: { model: 'model-one', messages },
        slots,
        runtime,
        routing,
        stickyRouter: router,
        requestPatch: { headers: { 'x-session-id': 'ses-cache' } },
      })
    ).logBag.vm_id
  const hold = (id, ms) => {
    const lease = runtime.acquire(id, { concurrency: 1 })
    setTimeout(() => lease.release(), ms)
  }
  return { turn, hold, other: (id) => (id === slot.id ? 'vm-ag-02' : slot.id) }
}

const opening = [{ role: 'user', content: 'build the app' }]
const followUp = [...opening, { role: 'assistant', content: 'done' }, { role: 'user', content: 'now add tests' }]

test('A busy warm slot is awaited instead of re-sending the prefix cold on another account', async (t) => {
  const { turn, hold } = affinityHarness(t, 1000)
  const home = await turn(opening)
  hold(home, 60)
  assert.equal(await turn(followUp), home)
})

test('Same-session side requests with another prefix never move the conversation off its warm slot', async (t) => {
  const { turn, hold, other } = affinityHarness(t, 1000)
  const home = await turn(opening)
  hold(home, 60)
  assert.equal(await turn([{ role: 'user', content: 'generate a title for this chat' }]), other(home))
  assert.equal(await turn(followUp), home)
})

test('After a spill the binding follows the slot that now holds the longest cached prefix', async (t) => {
  const { turn, hold, other } = affinityHarness(t, 0)
  const home = await turn(opening)
  hold(home, 60)
  const spilled = await turn(followUp)
  assert.equal(spilled, other(home))
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(
    await turn([...followUp, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'ship it' }]),
    spilled,
  )
})
