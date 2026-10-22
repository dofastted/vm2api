import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { handleCodexImages } from '../../src/lib/protocol/handle-codex.mjs'
import { CODEX_IMAGE_EDITS_URL, CODEX_IMAGE_GENERATIONS_URL } from '../../src/lib/protocol/codex-models.mjs'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { loadGptModelPolicy, saveGptModelPolicy } from '../../src/lib/protocol/gpt-model-policy.mjs'
import { resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'
import { StickyRouter } from '../../src/lib/pool/sticky-router.mjs'
import { readBody } from '../../src/lib/http/respond.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'

const USAGE = {
  input_tokens: 300,
  input_tokens_details: { text_tokens: 100, image_tokens: 200 },
  output_tokens: 1000,
  total_tokens: 1300,
}
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7])

let root

function writeGptVm(id, { plan = null, account = {} } = {}) {
  const dir = path.join(root, 'vms')
  fs.mkdirSync(path.join(dir, id), { recursive: true })
  const vm = { id, name: id, platform: 'openai', family: 'codex', schedulable: true, status: 'running' }
  if (plan) vm.codex = { plan_type: plan }
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(vm))
  fs.writeFileSync(
    path.join(dir, id, 'codex-credentials.json'),
    JSON.stringify({
      accounts: [{ id: `${id}-acc`, access_token: 'at', refresh_token: 'rt', chatgpt_account_id: id, ...account }],
    }),
  )
}

function upstream(status, payload, { raw = null } = {}) {
  return { status, headers: new Map(), text: async () => raw ?? JSON.stringify(payload) }
}

async function images({ kind = 'generations', body, headers = {}, ops = {}, stickyRouter = null } = {}) {
  const res = { statusCode: 0, body: null, setHeader() {} }
  const logBag = {}
  const stats = { errors: 0, requests: 0, by_route: {} }
  await handleCodexImages({
    req: { headers: { 'user-agent': 'codex_exec/0.163.0', ...headers } },
    res,
    kind,
    body: body ?? { model: 'gpt-image-2.5-flare', prompt: 'a cat', size: '1024x1024' },
    logBag,
    stats,
    json: (_res, status, payload) => {
      res.statusCode = status
      res.body = payload
      return payload
    },
    routing: {},
    projectRoot: root,
    stickyRouter,
    ops,
  })
  return { res, logBag, stats }
}

beforeEach(() => {
  resetOpenAIAccountRuntime()
  openDatabase({ dbPath: ':memory:' })
  loadGptModelPolicy({ force: true })
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-images-'))
})

afterEach(() => {
  closeDatabase()
  loadGptModelPolicy({ force: true })
  fs.rmSync(root, { recursive: true, force: true })
})

test('generations posts the JSON body to the Codex Images endpoint as the slot', async () => {
  writeGptVm('vm-a')
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return upstream(200, { created: 1, data: [{ b64_json: 'aGk=' }], usage: USAGE })
  }
  const { res, logBag, stats } = await images({
    headers: {
      authorization: 'Bearer sk-client',
      'x-codex-turn-metadata': '{"turn_id":"t-1"}',
      'x-codex-image-turn-id': 'img-1',
      'x-codex-turn-state': 'state-from-another-account',
    },
    ops: { fetchImpl },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, CODEX_IMAGE_GENERATIONS_URL)
  const sent = calls[0].init.headers
  assert.equal(sent.authorization, 'Bearer at')
  assert.equal(sent['chatgpt-account-id'], 'vm-a')
  assert.equal(sent.originator, 'codex_cli_rs')
  assert.equal(sent['x-codex-turn-metadata'], '{"turn_id":"t-1"}')
  assert.equal(sent['x-codex-image-turn-id'], 'img-1')
  assert.equal(sent['x-codex-turn-state'], undefined)
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: 'gpt-image-2.5-flare', prompt: 'a cat', size: '1024x1024' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.data[0].b64_json, 'aGk=')
  assert.equal(logBag.via, 'codex-images')
  assert.equal(logBag.vm_id, 'vm-a')
  assert.equal(logBag.final_state, 'verified')
  assert.equal(logBag.image_model, 'gpt-image-2.5-flare')
  assert.deepEqual(logBag.image_usage, USAGE)
  assert.equal(stats.by_route['openai.images'], 1)
})

test('edits go to the edits endpoint', async () => {
  writeGptVm('vm-a')
  const urls = []
  await images({
    kind: 'edits',
    body: { model: 'gpt-image-2.5-sunburst', prompt: 'x', images: [{ image_url: 'data:image/png;base64,AA==' }] },
    ops: { fetchImpl: async (url) => (urls.push(url), upstream(200, { data: [] })) },
  })
  assert.deepEqual(urls, [CODEX_IMAGE_EDITS_URL])
})

test('Free-plan slots never take an Images call', async () => {
  writeGptVm('vm-free', { plan: 'free' })
  writeGptVm('vm-plus', { account: { chatgpt_plan_type: 'plus' } })
  const seen = []
  const { res } = await images({
    ops: {
      fetchImpl: async (_url, init) => (seen.push(init.headers['chatgpt-account-id']), upstream(200, { data: [] })),
    },
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(seen, ['vm-plus'])
})

test('only Free slots → a clear 403 without waiting or calling upstream', async () => {
  writeGptVm('vm-free', { account: { chatgpt_plan_type: 'FREE' } })
  let calls = 0
  const { res, logBag } = await images({ ops: { fetchImpl: async () => (calls++, upstream(200, {})) } })
  assert.equal(res.statusCode, 403)
  assert.equal(res.body.error.code, 'image_generation_unavailable')
  assert.equal(logBag.error_code, 'image_generation_unavailable')
  assert.equal(calls, 0)
})

test('a disabled image model is refused before any slot is used', async () => {
  writeGptVm('vm-a')
  saveGptModelPolicy({ image_tools: { 'gpt-image-2.5-sunburst': { enabled: false } } })
  let calls = 0
  const { res } = await images({
    body: { model: 'gpt-image-2.5-sunburst-2026-09-08', prompt: 'x' },
    ops: { fetchImpl: async () => (calls++, upstream(200, {})) },
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.error.code, 'model_disabled')
  assert.equal(calls, 0)
})

test('a missing or unknown model reaches the upstream unchanged', async () => {
  writeGptVm('vm-a')
  for (const body of [{ prompt: 'x' }, { model: 'gpt-image-9', prompt: 'x' }]) {
    const sent = []
    const { res } = await images({
      body,
      ops: { fetchImpl: async (_u, init) => (sent.push(JSON.parse(init.body)), upstream(200, {})) },
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(sent, [body])
  }
})

test('a 429 moves to the next slot', async () => {
  writeGptVm('vm-a')
  writeGptVm('vm-b')
  const seen = []
  const { res } = await images({
    ops: {
      fetchImpl: async (_url, init) => {
        const id = init.headers['chatgpt-account-id']
        seen.push(id)
        return seen.length === 1
          ? upstream(429, { error: { code: 'usage_limit_reached' } })
          : upstream(200, { data: [] })
      },
    },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(seen.length, 2)
  assert.notEqual(seen[0], seen[1])
})

test('a 401 refreshes the token once and retries on the same slot', async () => {
  writeGptVm('vm-a')
  const auth = []
  const { res } = await images({
    ops: {
      refresh: async () => ({ ok: true, access_token: 'at-new', refresh_token: 'rt-new' }),
      fetchImpl: async (_url, init) => {
        auth.push(init.headers.authorization)
        return auth.length === 1 ? upstream(401, { error: { code: 'token_expired' } }) : upstream(200, { data: [] })
      },
    },
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(auth, ['Bearer at', 'Bearer at-new'])
})

test('x-codex-image-turn-id keeps an edit turn on the slot that served it', async () => {
  writeGptVm('vm-a')
  writeGptVm('vm-b')
  const stickyRouter = new StickyRouter({ dataDir: path.join(root, 'data'), config: { sticky: { enabled: true } } })
  const seen = []
  const fetchImpl = async (_url, init) => (seen.push(init.headers['chatgpt-account-id']), upstream(200, { data: [] }))
  const headers = { 'x-codex-image-turn-id': 'img-turn-7' }
  for (let i = 0; i < 4; i++) await images({ headers, stickyRouter, ops: { fetchImpl } })
  assert.equal(new Set(seen).size, 1)
})

test('a non-JSON upstream answer is a 502, and upstream errors pass through', async () => {
  writeGptVm('vm-a')
  const bad = await images({ ops: { fetchImpl: async () => upstream(200, null, { raw: '<html>' }) } })
  assert.equal(bad.res.statusCode, 502)
  assert.equal(bad.res.body.error.code, 'upstream_invalid_body')
  const rejected = await images({
    ops: { fetchImpl: async () => upstream(400, { error: { code: 'moderation_blocked', message: 'no' } }) },
  })
  assert.equal(rejected.res.statusCode, 400)
  assert.equal(rejected.res.body.error.code, 'moderation_blocked')
  assert.equal(rejected.logBag.final_state, 'upstream_error')
})

function protocolHarness(rows, { apiKeyStore = null } = {}) {
  return createHandleProtocol({
    apiKeyStore,
    cfg: { limits: { max_body_bytes: 1 << 20 }, rewrite: { enabled: false }, paths: { project: root } },
    json(res, status, body) {
      res.statusCode = status
      res.body = body
    },
    readBody,
    requireAuth: (req) => {
      req.apiKeyKind = 'managed'
      return true
    },
    requestLog: { start: () => ({ request_id: 'req-img' }), finish: (_ctx, row) => rows.push(row) },
    stats: { errors: 0, requests: 0, by_route: {} },
    groupsRepo: { rateMultiplier: () => 1 },
    routingConfig: {},
  })
}

function fakeRes() {
  return {
    statusCode: 0,
    body: null,
    on(event, fn) {
      if (event === 'finish') this.finish = fn
    },
    once() {},
    off() {},
  }
}

test('the images route converts a multipart edit and logs without base64', async () => {
  writeGptVm('vm-a') // no SOCKS5 bound: the hop stops at proxy_required after conversion
  const rows = []
  const { handleImages } = protocolHarness(rows)
  const form = new FormData()
  form.append('model', 'gpt-image-2.5-flare')
  form.append('prompt', 'make it night')
  form.append('image[]', new Blob([PNG]), 'a.png')
  const encoded = new Request('http://local/', { method: 'POST', body: form })
  const req = Readable.from([Buffer.from(await encoded.arrayBuffer())])
  req.headers = { 'content-type': encoded.headers.get('content-type'), 'user-agent': 'codex_exec/0.163.0' }
  const res = fakeRes()
  await handleImages(req, res, '/v1/images/edits', 'edits')
  res.finish()
  assert.equal(res.statusCode, 502)
  assert.equal(res.body.error.code, 'proxy_required')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].protocol, 'openai.images')
  assert.equal(rows[0].via, 'codex-images')
  assert.equal(rows[0].model, 'gpt-image-2.5-flare')
  assert.doesNotMatch(JSON.stringify(rows[0].inbound_summary), /base64/)
})

test('the images route rejects a broken multipart edit as a 400', async () => {
  const rows = []
  const { handleImages } = protocolHarness(rows)
  const req = Readable.from([Buffer.from('--x\r\nnope')])
  req.headers = { 'content-type': 'multipart/form-data; boundary=x' }
  const res = fakeRes()
  await handleImages(req, res, '/v1/images/edits', 'edits')
  res.finish()
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.error.code, 'invalid_image_edit')
  assert.equal(rows[0].error_code, 'invalid_image_edit')
})

test('the images route picks slots by the key owner role, like search', async () => {
  writeGptVm('vm-platform')
  writeGptVm('vm-tenant')
  const file = path.join(root, 'vms', 'vm-tenant.json')
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), owner_user_id: 'u1' }))
  const roles = { a1: 'admin', u1: 'user' }
  const apiKeyStore = { users: { getById: (id) => ({ id, role: roles[id] }) } }
  const run = async (userId) => {
    const rows = []
    const { handleImages } = protocolHarness(rows, { apiKeyStore })
    const req = Readable.from([Buffer.from('{"model":"gpt-image-2.5-flare","prompt":"x"}')])
    req.headers = { 'content-type': 'application/json' }
    req.apiKeyRecord = { id: `key-${userId}`, user_id: userId }
    const res = fakeRes()
    await handleImages(req, res, '/v1/images/generations', 'generations')
    res.finish()
    return rows[0]
  }
  assert.equal((await run('a1')).vm_id, 'vm-platform')
  assert.equal((await run('u1')).vm_id, 'vm-tenant')
})

test('the images route reads JSON generations', async () => {
  writeGptVm('vm-a')
  const rows = []
  const { handleImages } = protocolHarness(rows)
  const req = Readable.from([Buffer.from('{"model":"gpt-image-2.5-flare","prompt":"x"}')])
  req.headers = { 'content-type': 'application/json' }
  const res = fakeRes()
  await handleImages(req, res, '/v1/images/generations', 'generations')
  res.finish()
  assert.equal(res.body.error.code, 'proxy_required')
  assert.equal(rows[0].model, 'gpt-image-2.5-flare')
})
