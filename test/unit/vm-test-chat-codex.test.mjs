import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  listTestableModels,
  resolveTestModels,
  runVmTestChat,
  syncCodexCatalog,
  testChatCredentialMode,
} from '../../src/lib/admin/vm-test-chat.mjs'

function seedCodexVm(root, id = 'vm-codex-01') {
  const vms = path.join(root, 'vms')
  fs.mkdirSync(path.join(vms, id), { recursive: true })
  fs.writeFileSync(
    path.join(vms, `${id}.json`),
    JSON.stringify({
      id,
      name: id,
      status: 'running',
      schedulable: true,
      platform: 'openai',
      family: 'codex',
      proxy_cli_enabled: true,
      proxy: { id: `proxy-${id}`, url: 'socks5h://127.0.0.1:1080', host: '127.0.0.1', port: 1080 },
      codex: { has_access: true },
    }),
  )
  fs.writeFileSync(
    path.join(vms, id, 'codex-credentials.json'),
    JSON.stringify({
      accounts: [{ access_token: 'codex-access', refresh_token: 'codex-refresh' }],
    }),
  )
}

function seedRouting(root) {
  const configDir = path.join(root, 'src', 'config')
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, 'routing.json'), JSON.stringify({}))
}

async function startLoopbackServer(t, respond) {
  const calls = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    calls.push({
      url: `http://${req.headers.host}${req.url}`,
      headers: req.headers,
      body,
    })
    const reply = respond()
    res.writeHead(reply.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(reply.body))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, calls }
}

test('listTestableModels(openai) hides Claude ids', () => {
  const gpt = listTestableModels('openai')
  const claude = listTestableModels('anthropic')
  assert.ok(gpt.length > 0)
  assert.ok(claude.length > 0)
  assert.ok(gpt.every((m) => /^(gpt-|codex-)/i.test(m.id) || m.family === 'codex'))
  assert.ok(claude.every((m) => !/^(gpt-|codex-)/i.test(m.id) && m.family !== 'codex'))
  assert.ok(gpt.some((m) => m.id === 'gpt-5.4'))
  assert.ok(!gpt[0].id.includes('mini'))
})

test('testChatCredentialMode reports Codex slots as codex', () => {
  assert.equal(testChatCredentialMode({ platform: 'openai', family: 'codex' }), 'codex')
})

test('runVmTestChat Codex slot loopbacks /v1/responses and never /v1/messages', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-testchat-codex-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  seedCodexVm(root)
  seedRouting(root)

  const { baseUrl, calls } = await startLoopbackServer(t, () => ({
    status: 200,
    body: {
      id: 'resp_test',
      object: 'response',
      model: 'gpt-5.4',
      output_text: 'hello from responses',
      usage: { input_tokens: 8, output_tokens: 3 },
      status: 'completed',
      kin: { vm_id: 'vm-codex-01' },
    },
  }))

  const result = await runVmTestChat({
    projectRoot: root,
    vmId: 'vm-codex-01',
    model: 'gpt-5.4',
    prompt: 'hello',
    max_tokens: 64,
    baseUrl,
    apiKey: 'test-master-key',
  })

  assert.equal(result.ok, true)
  assert.equal(result.text, 'hello from responses')
  assert.equal(result.debug?.path, '/v1/responses')
  assert.equal(result.debug?.inbound_class, 'openai_responses')
  assert.equal(result.credential_mode, 'codex')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].headers['x-kin-vm'], 'vm-codex-01')
  assert.equal(calls[0].headers.authorization, 'Bearer test-master-key')
  assert.match(String(calls[0].headers['user-agent'] || ''), /codex_cli_rs/i)
  assert.ok(calls[0].headers['x-codex-installation-id'])
  assert.equal(calls[0].body.model, 'gpt-5.4')
  assert.equal(Array.isArray(calls[0].body.input), true)
  assert.equal(calls[0].body.input[0].role, 'user')
  assert.equal(calls[0].body.input[0].content[0].type, 'input_text')
  assert.equal(calls[0].body.input[0].content[0].text, 'hello')
  assert.equal(calls[0].body.stream, true)
  assert.equal(calls[0].body.store, false)
  assert.equal(calls[0].body.max_output_tokens, undefined)
  assert.equal(calls[0].body.reasoning?.effort, 'medium')
  assert.equal(calls[0].body.messages, undefined)
  assert.ok(result.log.some((l) => /\/v1\/responses/.test(l.message)))
  assert.ok(!result.log.some((l) => /\/v1\/messages/.test(l.message)))
})

test('runVmTestChat Codex slot refreshes OAuth after wrapped 401', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-testchat-codex-401-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  seedCodexVm(root)
  seedRouting(root)
  let hits = 0
  const { baseUrl, calls } = await startLoopbackServer(t, () => {
    hits += 1
    if (hits === 1) {
      return {
        status: 502,
        body: {
          error: {
            type: 'api_error',
            code: 'upstream_transport',
            message: 'HTTP error: 401 Unauthorized',
          },
        },
      }
    }
    return {
      status: 200,
      body: {
        id: 'resp_retry',
        object: 'response',
        model: 'gpt-5.4',
        output_text: 'after refresh',
        status: 'completed',
      },
    }
  })
  const result = await runVmTestChat({
    projectRoot: root,
    vmId: 'vm-codex-01',
    model: 'gpt-5.4',
    prompt: 'hello',
    max_tokens: 16,
    baseUrl,
    apiKey: 'test-master-key',
    fetchImpl: async (url) => {
      if (String(url).includes('/oauth/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 60 }),
        }
      }
      throw new Error(`unexpected fetch ${url}`)
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.text, 'after refresh')
  assert.equal(calls.length, 2)
  assert.ok(result.log.some((l) => /尝试刷新 OAuth/.test(l.message)))
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-codex-01', 'codex-credentials.json'), 'utf8'))
  assert.equal(saved.accounts[0].access_token, 'at-new')
})

test('runVmTestChat Codex slot rejects Claude models', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-testchat-codex-reject-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  seedCodexVm(root)
  seedRouting(root)
  const result = await runVmTestChat({
    projectRoot: root,
    vmId: 'vm-codex-01',
    model: 'claude-haiku-4-5',
    prompt: 'hello',
    baseUrl: 'http://127.0.0.1:9',
    apiKey: 'test-master-key',
  })
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'model_not_allowed')
})

test('resolveTestModels(vm_id) returns only GPT ids and responses protocol', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-test-models-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  seedCodexVm(root)
  const view = await resolveTestModels({ projectRoot: root, vmId: 'vm-codex-01' })
  assert.equal(view.platform, 'openai')
  assert.equal(view.protocol, 'openai.responses')
  assert.equal(view.inbound_path, '/v1/responses')
  assert.ok(view.items.length > 0)
  assert.ok(view.items.every((m) => /^(gpt-|codex-)/i.test(m.id)))
  assert.ok(!view.items.some((m) => String(m.id).startsWith('claude-')))
})

test('resolveTestModels refresh merges ChatGPT ids and ignores 401', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-test-models-refresh-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  seedCodexVm(root)
  const merged = await resolveTestModels({
    projectRoot: root,
    vmId: 'vm-codex-01',
    refresh: true,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: [{ slug: 'gpt-5.6' }, { slug: 'gpt-5.4' }] }),
    }),
  })
  assert.equal(merged.source, 'chatgpt')
  assert.ok(merged.items.some((m) => m.id === 'gpt-5.6'))
  assert.equal(merged.protocol, 'openai.responses')

  const denied = await resolveTestModels({
    projectRoot: root,
    vmId: 'vm-codex-01',
    refresh: true,
    catalogClientVersion: '0.158.0',
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  })
  assert.equal(denied.source, 'policy')
  assert.ok(denied.items.every((m) => /^(gpt-|codex-)/i.test(m.id)))
})

test('syncCodexCatalog refreshes OAuth on 401 then merges GPT ids', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-sync-codex-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  seedCodexVm(root)
  let modelGets = 0
  const result = await syncCodexCatalog({
    projectRoot: root,
    vmId: 'vm-codex-01',
    rotate: true,
    catalogClientVersion: '0.158.0',
    fetchImpl: async (url) => {
      const href = String(url)
      if (href.includes('/oauth/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'at-rotated', refresh_token: 'rt-rotated', expires_in: 60 }),
        }
      }
      modelGets += 1
      if (modelGets <= 1) {
        return { ok: false, status: 401, json: async () => ({}) }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ models: [{ slug: 'gpt-5.6' }, { slug: 'gpt-5.5' }] }),
      }
    },
  })
  assert.equal(result.ok, true)
  assert.ok(result.ids.includes('gpt-5.6'))
  assert.ok(result.ids.includes('gpt-5.5'))
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-codex-01', 'codex-credentials.json'), 'utf8'))
  assert.equal(saved.accounts[0].access_token, 'at-rotated')
  assert.equal(saved.accounts[0].refresh_token, 'rt-rotated')
})

test('runVmTestChat Codex ENOENT is not rewritten as wrap cli-hop', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-testchat-codex-enoent-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  seedCodexVm(root)
  seedRouting(root)
  const model = listTestableModels('openai')[0]?.id || 'gpt-5.5'
  const { baseUrl } = await startLoopbackServer(t, () => ({
    status: 503,
    body: {
      error: {
        code: 'ENOENT',
        message: 'connect ENOENT /opt/kin-gateway/vms/vm-codex-02/run/codex-kernel.sock',
        request_id: 'db05657b-93ea-49e7-a06e-c2b760266061',
      },
    },
  }))
  const result = await runVmTestChat({
    projectRoot: root,
    vmId: 'vm-codex-01',
    model,
    prompt: 'hello',
    baseUrl,
    apiKey: 'test-master-key',
  })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /Codex kernel 未就绪/)
  assert.doesNotMatch(result.error.message, /wrap cli-hop 未就绪/)
})
