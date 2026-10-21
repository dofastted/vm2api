import { flushPendingWrites } from '../../src/lib/db/pending-writes.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { handleCodexSearch } from '../../src/lib/protocol/handle-codex.mjs'
import { CODEX_APP_VERSION, CODEX_SEARCH_URL } from '../../src/lib/protocol/codex-models.mjs'
import { readCodexAccounts } from '../../src/lib/vm/codex-slot.mjs'
import { getVm } from '../../src/lib/vm/vm-registry.mjs'
import { resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'
import { Readable } from 'node:stream'
import { readBody } from '../../src/lib/http/respond.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'

function writeGptVm(root, id, account = {}) {
  const dir = path.join(root, 'vms')
  fs.mkdirSync(path.join(dir, id), { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({ id, name: id, platform: 'openai', family: 'codex', schedulable: true, status: 'running' }),
  )
  fs.writeFileSync(
    path.join(dir, id, 'codex-credentials.json'),
    JSON.stringify({
      accounts: [{ id: `${id}-acc`, access_token: 'at', refresh_token: 'rt', chatgpt_account_id: id, ...account }],
    }),
  )
}

function upstream(status, payload, headers = {}) {
  return { status, headers: new Map(Object.entries(headers)), text: async () => JSON.stringify(payload) }
}

async function search(root, { body, headers = {}, ops = {} } = {}) {
  const res = { statusCode: 0, body: null, setHeader() {} }
  const logBag = {}
  const stats = { errors: 0, requests: 0, by_route: {} }
  await handleCodexSearch({
    req: { headers: { 'user-agent': 'codex_exec/0.160.1 (Windows 10.0.26100; x86_64)', ...headers } },
    res,
    body: body ?? { id: 'sess-1', model: 'gpt-6.1-sol', commands: { search_query: [{ q: 'vm2api' }] } },
    logBag,
    stats,
    json: (_res, status, payload) => {
      res.statusCode = status
      res.body = payload
      return payload
    },
    routing: {},
    projectRoot: root,
    ops,
  })
  return { res, logBag, stats }
}

function tempRoot(name) {
  resetOpenAIAccountRuntime()
  return fs.mkdtempSync(path.join(os.tmpdir(), `kin-codex-search-${name}-`))
}

test('search posts to the Codex backend as the slot and returns the backend JSON', async () => {
  const root = tempRoot('ok')
  writeGptVm(root, 'vm-gpt-a')
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return upstream(200, { output: 'found it', results: [{ type: 'text_result', ref_id: 'turn0search0' }] })
  }
  const { res, logBag, stats } = await search(root, {
    body: {
      id: 'sess-1',
      model: 'gpt-6.1-sol',
      commands: { search_query: [{ q: 'vm2api' }] },
      prompt_cache_key: 'pck',
      prompt_cache_retention: '24h',
      store: false,
    },
    headers: { 'x-codex-turn-metadata': '{"turn_id":"t-1"}', authorization: 'Bearer sk-client' },
    ops: { fetchImpl },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, CODEX_SEARCH_URL)
  assert.equal(calls[0].init.method, 'POST')
  const sent = calls[0].init.headers
  assert.equal(sent.authorization, 'Bearer at')
  assert.equal(sent['chatgpt-account-id'], 'vm-gpt-a')
  assert.equal(sent.originator, 'codex_cli_rs')
  assert.match(sent['user-agent'], /^codex_cli_rs\//)
  assert.equal(sent.version, CODEX_APP_VERSION)
  assert.equal(sent['x-codex-turn-metadata'], '{"turn_id":"t-1"}')
  const payload = JSON.parse(calls[0].init.body)
  assert.deepEqual(payload, { id: 'sess-1', model: 'gpt-6.1-sol', commands: { search_query: [{ q: 'vm2api' }] } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.output, 'found it')
  assert.equal(logBag.via, 'codex-search')
  assert.equal(logBag.vm_id, 'vm-gpt-a')
  assert.equal(logBag.final_state, 'verified')
  assert.equal(stats.by_route['openai.search'], 1)
  fs.rmSync(root, { recursive: true, force: true })
})

test('search moves to the next GPT slot on a usage-limit 429 and parks the first', async () => {
  const root = tempRoot('failover')
  writeGptVm(root, 'vm-gpt-a')
  writeGptVm(root, 'vm-gpt-b')
  const seen = []
  const fetchImpl = async (_url, init) => {
    const account = init.headers['chatgpt-account-id']
    seen.push(account)
    if (account === 'vm-gpt-a') {
      return upstream(
        429,
        { error: { code: 'usage_limit_reached', message: 'limit' } },
        { 'x-codex-primary-used-percent': '100', 'x-codex-primary-window-minutes': '300' },
      )
    }
    return upstream(200, { output: 'from b' })
  }
  const { res, logBag } = await search(root, { ops: { fetchImpl } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.output, 'from b')
  assert.equal(seen.length, 2)
  assert.equal(seen.at(-1), 'vm-gpt-b')
  assert.equal(logBag.attempt_count, 2)
  assert.equal(logBag.vm_id, 'vm-gpt-b')
  assert.ok(getVm(root, seen[0]).codex.extra.codex_limited_until)
  fs.rmSync(root, { recursive: true, force: true })
})

test('search refreshes an expired token once, stores it and retries', async () => {
  const root = tempRoot('refresh')
  writeGptVm(root, 'vm-gpt-a')
  const auths = []
  let refreshes = 0
  const fetchImpl = async (_url, init) => {
    auths.push(init.headers.authorization)
    return init.headers.authorization === 'Bearer at2' ? upstream(200, { output: 'ok' }) : upstream(401, { error: {} })
  }
  const refresh = async ({ refreshToken }) => {
    refreshes += 1
    assert.equal(refreshToken, 'rt')
    return { ok: true, access_token: 'at2', refresh_token: 'rt2' }
  }
  const { res } = await search(root, { ops: { fetchImpl, refresh } })
  assert.equal(res.statusCode, 200)
  assert.equal(refreshes, 1)
  assert.deepEqual(auths, ['Bearer at', 'Bearer at2'])
  const [stored] = readCodexAccounts(root, 'vm-gpt-a')
  assert.equal(stored.access_token, 'at2')
  assert.equal(stored.refresh_token, 'rt2')
  fs.rmSync(root, { recursive: true, force: true })
})

test('search adopts a token the kernel refreshed meanwhile instead of rotating again', async () => {
  const root = tempRoot('kernel-rotated')
  writeGptVm(root, 'vm-gpt-a')
  const file = path.join(root, 'vms', 'vm-gpt-a', 'codex-credentials.json')
  const fetchImpl = async (_url, init) => {
    if (init.headers.authorization === 'Bearer at') {
      // The kernel rotated the refresh token while this request was in flight.
      fs.writeFileSync(
        file,
        JSON.stringify({ accounts: [{ access_token: 'at-k', refresh_token: 'rt-k', chatgpt_account_id: 'vm-gpt-a' }] }),
      )
      return upstream(401, { error: {} })
    }
    return upstream(200, { output: 'ok' })
  }
  const refresh = async () => assert.fail('must not spend the rotated refresh token')
  const { res } = await search(root, { ops: { fetchImpl, refresh } })
  assert.equal(res.statusCode, 200)
  assert.equal(readCodexAccounts(root, 'vm-gpt-a')[0].refresh_token, 'rt-k')
  fs.rmSync(root, { recursive: true, force: true })
})

test('search without a model is rejected before any upstream call', async () => {
  const root = tempRoot('no-model')
  writeGptVm(root, 'vm-gpt-a')
  const fetchImpl = async () => assert.fail('no upstream call expected')
  const { res, logBag } = await search(root, { body: { commands: {} }, ops: { fetchImpl } })
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.error.code, 'model_required')
  assert.equal(logBag.error_code, 'model_required')
  fs.rmSync(root, { recursive: true, force: true })
})

test('search passes a backend 404 through without trying other slots', async () => {
  const root = tempRoot('passthrough')
  writeGptVm(root, 'vm-gpt-a')
  writeGptVm(root, 'vm-gpt-b')
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return upstream(404, { error: { code: 'not_found', message: 'unknown command' } })
  }
  const { res, logBag } = await search(root, { ops: { fetchImpl } })
  assert.equal(calls, 1)
  assert.equal(res.statusCode, 404)
  assert.equal(res.body.error.code, 'not_found')
  assert.equal(logBag.final_state, 'upstream_error')
  fs.rmSync(root, { recursive: true, force: true })
})

test('the alpha/search route authenticates, logs and reaches the Codex search hop', async () => {
  const root = tempRoot('route')
  writeGptVm(root, 'vm-gpt-a') // no SOCKS5 bound: the hop must stop at proxy_required
  const rows = []
  const { handleSearch } = createHandleProtocol({
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
    requestLog: { start: () => ({ request_id: 'req-search' }), finish: (_ctx, row) => rows.push(row) },
    stats: { errors: 0, requests: 0, by_route: {} },
    groupsRepo: { rateMultiplier: () => 1 },
    routingConfig: {},
  })
  const req = Readable.from([Buffer.from('{"model":"gpt-6.1-sol","commands":{"search_query":[{"q":"x"}]}}')])
  req.headers = { 'user-agent': 'codex_exec/0.160.1' }
  const res = {
    statusCode: 0,
    body: null,
    on(event, fn) {
      if (event === 'finish') this.finish = fn
    },
    once() {},
    off() {},
  }
  await handleSearch(req, res, '/v1/alpha/search')
  res.finish()
  await flushPendingWrites()
  assert.equal(res.statusCode, 502)
  assert.equal(res.body.error.code, 'proxy_required')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].protocol, 'openai.search')
  assert.equal(rows[0].via, 'codex-search')
  assert.equal(rows[0].model, 'gpt-6.1-sol')
  assert.equal(rows[0].vm_id, 'vm-gpt-a')
  assert.equal(rows[0].api_key_kind, 'managed')
  fs.rmSync(root, { recursive: true, force: true })
})
