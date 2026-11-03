import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { createRespond } from '../../src/lib/http/respond.mjs'
import { CODEX_IMAGE_EDITS_URL, CODEX_IMAGE_GENERATIONS_URL } from '../../src/lib/protocol/codex-models.mjs'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { loadGptModelPolicy, saveGptModelPolicy } from '../../src/lib/protocol/gpt-model-policy.mjs'
import { resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'

const USAGE = {
  input_tokens: 300,
  input_tokens_details: { text_tokens: 100, image_tokens: 200 },
  output_tokens: 1000,
  total_tokens: 1300,
}
const IMAGE = { created: 1700000000, output_format: 'png', data: [{ b64_json: 'aGk=' }], usage: USAGE }

let root

beforeEach(() => {
  resetOpenAIAccountRuntime()
  openDatabase({ dbPath: ':memory:' })
  loadGptModelPolicy({ force: true })
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-image-model-'))
  const dir = path.join(root, 'vms', 'vm-a')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-a.json'),
    JSON.stringify({
      id: 'vm-a',
      name: 'vm-a',
      platform: 'openai',
      family: 'codex',
      schedulable: true,
      status: 'running',
    }),
  )
  fs.writeFileSync(
    path.join(dir, 'codex-credentials.json'),
    JSON.stringify({ accounts: [{ id: 'acc', access_token: 'at', refresh_token: 'rt', chatgpt_account_id: 'vm-a' }] }),
  )
})

afterEach(() => {
  closeDatabase()
  loadGptModelPolicy({ force: true })
  fs.rmSync(root, { recursive: true, force: true })
})

/** Real HTTP server around handleProtocol; `upstream(url, body)` answers the Codex Images call. */
async function serve(upstream) {
  const cfg = { rewrite: { enabled: false } }
  const respond = createRespond(cfg)
  const calls = []
  const rows = []
  const { handleProtocol } = createHandleProtocol({
    json: respond.json,
    writeSSEHeaders: respond.writeSSEHeaders,
    readBody: respond.readBody,
    requireAuth: (req) => {
      req.apiKeyKind = 'managed'
      return true
    },
    cfg: {
      ...cfg,
      intercept: { rules: [] },
      limits: { max_body_bytes: 1 << 20, stream_keepalive_ms: 15_000 },
      paths: { project: root, data: root },
    },
    requestLog: {
      start: () => ({ request_id: 'req-img-model', t0: Date.now() }),
      finish: (_ctx, row) => rows.push(row),
    },
    stats: { errors: 0, requests: 0, by_route: {} },
    groupsRepo: { rateMultiplier: () => 1 },
    routingConfig: {},
    codexOps: {
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body)
        calls.push({ url, body })
        const [status, payload] = upstream(url, body)
        return { status, headers: new Map(), text: async () => JSON.stringify(payload) }
      },
    },
  })
  const protocols = { '/v1/chat/completions': 'openai.chat', '/v1/responses': 'openai.responses' }
  const server = http.createServer((req, res) => handleProtocol(req, res, protocols[req.url], req.url))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = async (pathName, body) => {
    const res = await fetch(`${base}${pathName}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'openai-python/1.0' },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    // The log row is written on 'finish', which can land just after the client reads the body.
    await new Promise((resolve) => setImmediate(resolve))
    return { status: res.status, type: res.headers.get('content-type') || '', text }
  }
  return { post, calls, rows, close: () => new Promise((resolve) => server.close(resolve)) }
}

function sseEvents(text) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)))
}

test('a chat completion on an image model generates through Images and answers a markdown image', async () => {
  const live = await serve(() => [200, IMAGE])
  try {
    const out = await live.post('/v1/chat/completions', {
      model: 'gpt-image-2.5-flare',
      size: '1024x1024',
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'a dog' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: [{ type: 'text', text: 'a red fox in snow' }] },
      ],
    })
    assert.equal(out.status, 200)
    assert.equal(live.calls.length, 1)
    assert.equal(live.calls[0].url, CODEX_IMAGE_GENERATIONS_URL)
    assert.deepEqual(live.calls[0].body, {
      model: 'gpt-image-2.5-flare',
      prompt: 'a red fox in snow',
      size: '1024x1024',
    })
    const body = JSON.parse(out.text)
    assert.equal(body.object, 'chat.completion')
    assert.equal(body.model, 'gpt-image-2.5-flare')
    assert.equal(body.choices[0].message.content, '![image 1](data:image/png;base64,aGk=)')
    assert.equal(body.choices[0].finish_reason, 'stop')
    assert.deepEqual(body.usage, { prompt_tokens: 300, completion_tokens: 1000, total_tokens: 1300 })
    const row = live.rows[0]
    assert.equal(row.protocol, 'openai.images')
    assert.equal(row.final_state, 'verified')
    assert.equal(row.image_model, 'gpt-image-2.5-flare')
    assert.deepEqual(row.image_usage, USAGE)
  } finally {
    await live.close()
  }
})

test('images in the last user message turn the chat into an edit', async () => {
  const live = await serve(() => [200, IMAGE])
  try {
    const out = await live.post('/v1/chat/completions', {
      model: 'gpt-image-2.5-flare-2026-09-08',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'make it night' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        },
      ],
    })
    assert.equal(out.status, 200)
    assert.equal(live.calls[0].url, CODEX_IMAGE_EDITS_URL)
    assert.deepEqual(live.calls[0].body.images, [{ image_url: 'data:image/png;base64,AAAA' }])
    assert.equal(live.calls[0].body.prompt, 'make it night')
  } finally {
    await live.close()
  }
})

test('a streamed chat answers chunks, usage and [DONE]', async () => {
  const live = await serve(() => [200, IMAGE])
  try {
    const out = await live.post('/v1/chat/completions', {
      model: 'gpt-image-2.5-flare',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'a cat' }],
    })
    assert.equal(out.status, 200)
    assert.match(out.type, /text\/event-stream/)
    assert.match(out.text, /data: \[DONE\]\n\n$/)
    const events = sseEvents(out.text)
    assert.equal(events[0].choices[0].delta.content, '![image 1](data:image/png;base64,aGk=)')
    assert.equal(events[1].choices[0].finish_reason, 'stop')
    assert.equal(events[2].usage.total_tokens, 1300)
  } finally {
    await live.close()
  }
})

test('Responses on an image model returns image_generation_call output, streamed or not', async () => {
  const live = await serve(() => [200, { ...IMAGE, data: [{ b64_json: 'aGk=', revised_prompt: 'a cat, cute' }] }])
  try {
    const plain = await live.post('/v1/responses', { model: 'gpt-image-2', input: 'a cat' })
    assert.equal(plain.status, 200)
    const response = JSON.parse(plain.text)
    assert.equal(response.object, 'response')
    assert.equal(response.status, 'completed')
    assert.equal(response.output[0].type, 'image_generation_call')
    assert.equal(response.output[0].result, 'aGk=')
    assert.equal(response.output[0].revised_prompt, 'a cat, cute')
    assert.equal(response.usage.total_tokens, 1300)

    const streamed = await live.post('/v1/responses', {
      model: 'gpt-image-2',
      stream: true,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'a cat' }] }],
    })
    assert.equal(streamed.status, 200)
    const types = sseEvents(streamed.text).map((event) => event.type)
    assert.deepEqual(types, [
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.image_generation_call.completed',
      'response.output_item.done',
      'response.completed',
    ])
    const completed = sseEvents(streamed.text).at(-1)
    assert.equal(completed.response.output[0].result, 'aGk=')
    assert.equal(
      live.calls.every((call) => call.body.prompt === 'a cat'),
      true,
    )
  } finally {
    await live.close()
  }
})

test('no prompt, a disabled model or an upstream rejection keeps an HTTP error status', async () => {
  const live = await serve(() => [
    400,
    { error: { type: 'invalid_request_error', code: 'moderation_blocked', message: 'no' } },
  ])
  try {
    const empty = await live.post('/v1/chat/completions', {
      model: 'gpt-image-2.5-flare',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/a.png' } }] }],
    })
    assert.equal(empty.status, 400)
    assert.equal(JSON.parse(empty.text).error.code, 'prompt_required')
    assert.equal(live.calls.length, 0)

    const rejected = await live.post('/v1/chat/completions', {
      model: 'gpt-image-2.5-flare',
      stream: true,
      messages: [{ role: 'user', content: 'x' }],
    })
    assert.equal(rejected.status, 400)
    assert.equal(JSON.parse(rejected.text).error.code, 'moderation_blocked')

    saveGptModelPolicy({ image_tools: { 'gpt-image-2.5-flare': { enabled: false } } })
    const disabled = await live.post('/v1/responses', { model: 'gpt-image-2.5-flare', input: 'x' })
    assert.equal(disabled.status, 400)
    assert.equal(JSON.parse(disabled.text).error.code, 'model_disabled')
    assert.equal(live.calls.length, 1)
  } finally {
    await live.close()
  }
})
