import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'
import {
  isOfficialClaudeCodeTraffic,
  CRS_OFFICIAL_SYSTEM,
  CRS_OFFICIAL_AGENT_PROMPT,
} from '../../src/lib/identity/crs-persona.mjs'
import { classifyClient } from '../../src/lib/protocol/client-fingerprint.mjs'
import { runVmTestChat, buildVmTestInbound, testChatCredentialMode } from '../../src/lib/admin/vm-test-chat.mjs'

function seedVm(root, id = 'vm-01') {
  const vms = path.join(root, 'vms')
  fs.mkdirSync(vms, { recursive: true })
  fs.writeFileSync(
    path.join(vms, `${id}.json`),
    JSON.stringify({
      id,
      name: id,
      status: 'running',
      schedulable: true,
      proxy_cli_enabled: true,
      proxy: { id: `proxy-${id}`, url: 'socks5h://127.0.0.1:1080', host: '127.0.0.1', port: 1080 },
      claude: {
        access_token: 'sk-ant-oat01-test',
        refresh_token: 'sk-ant-ort01-test',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        account_uuid: 'acct-test',
      },
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

test('runVmTestChat without project/vm does not invent a panel request_log', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-testchat-'))
  const store = new RequestLogStore({ dataDir: dir, mode: 'normal' })
  const result = await runVmTestChat({ vmId: 'vm-01', requestLog: store })
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'invalid_request')
  assert.equal((await store.listNormal({ limit: 5 })).length, 0)
})

test('runVmTestChat loopbacks /v1/messages with x-kin-vm pin and never calls a worker', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-testchat-v1-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  seedVm(root)
  seedRouting(root)

  const { baseUrl, calls } = await startLoopbackServer(t, () => ({
    status: 200,
    body: {
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      content: [{ type: 'text', text: 'hello back' }],
      usage: { input_tokens: 12, output_tokens: 4 },
      stop_reason: 'end_turn',
      kin: { vm_id: 'vm-01' },
    },
  }))

  const result = await runVmTestChat({
    projectRoot: root,
    vmId: 'vm-01',
    model: 'claude-haiku-4-5',
    prompt: 'hello',
    max_tokens: 64,
    baseUrl,
    apiKey: 'test-master-key',
  })

  assert.equal(result.ok, true)
  assert.equal(result.via, 'v1-loopback')
  assert.equal(result.text, 'hello back')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${baseUrl}/v1/messages`)
  assert.equal(calls[0].headers['x-kin-vm'], 'vm-01')
  assert.equal(calls[0].headers.authorization, 'Bearer test-master-key')
  assert.equal(calls[0].headers.connection, 'close')
  assert.equal(calls[0].headers['user-agent'], 'kin-console-test/1.0')
  assert.equal(calls[0].headers['anthropic-beta'], undefined)
  assert.equal(calls[0].body.stream, true)
  assert.match(String(calls[0].body.messages[0].content || ''), /hello/)
  assert.equal(calls[0].body.system, undefined)
  assert.equal(result.official_cc_inference, 'cli-hop')
  assert.ok(result.log.some((l) => /\/v1\/messages/.test(l.message)))
  assert.ok(!result.log.some((l) => /Go slot worker|streamGoWorker|callGoWorker/i.test(l.message)))
})

test('testChatCredentialMode treats inference-only as official-setup-token', () => {
  assert.equal(testChatCredentialMode({ claude: { mode: 'setup-token' } }), 'setup-token')
  assert.equal(testChatCredentialMode({ claude: { mode: 'oauth', scope: 'user:inference' } }), 'official-setup-token')
  assert.equal(testChatCredentialMode({ claude: { mode: 'oauth', scope: 'user:profile user:inference' } }), 'oauth')
  assert.equal(testChatCredentialMode({ claude: { mode: 'apikey' } }), 'apikey')
  assert.equal(
    testChatCredentialMode({ claude: { mode: 'setup-token', source: 'claude-setup-token', scope: 'user:inference' } }),
    'official-setup-token',
  )
})

test('runVmTestChat uses unofficial inbound for setup-token', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-testchat-st-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  seedVm(root, 'vm-05')
  seedRouting(root)
  const vmPath = path.join(root, 'vms', 'vm-05.json')
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  vm.claude.mode = 'setup-token'
  vm.claude.scope = 'user:inference'
  delete vm.claude.refresh_token
  fs.writeFileSync(vmPath, JSON.stringify(vm))

  const { baseUrl, calls } = await startLoopbackServer(t, () => ({
    status: 401,
    body: {
      error: { type: 'authentication_error', message: 'OAuth access token is invalid.', code: 'upstream_auth_error' },
    },
  }))

  const result = await runVmTestChat({
    projectRoot: root,
    vmId: 'vm-05',
    model: 'claude-haiku-4-5',
    prompt: 'hello',
    max_tokens: 64,
    baseUrl,
    apiKey: 'test-master-key',
  })

  assert.equal(result.ok, false)
  assert.equal(result.credential_mode, 'official-setup-token')
  assert.equal(result.debug.inbound_class, 'cli_hop_passthrough')
  assert.equal(calls[0].headers['user-agent'], 'kin-console-test/1.0')
  assert.equal(calls[0].headers['anthropic-beta'], undefined)
  assert.match(result.error.message, /Setup Token/)
})

test('buildVmTestInbound stays Claude Code shaped for /v1 loopback', () => {
  const { inbound, headers } = buildVmTestInbound({
    model: 'claude-haiku-4-5',
    prompt: 'hello',
    maxTokens: 8192,
    sessionId: 'vm-test-vm-01',
  })
  assert.match(headers['user-agent'], /^claude-cli\//)
  assert.equal(headers['anthropic-beta'], undefined)
  assert.equal(inbound.stream, true)
})
test('health probe mode uses the full official Claude Code prompt', () => {
  const { inbound, headers } = buildVmTestInbound({
    model: 'claude-haiku-4-5',
    prompt: 'hello',
    maxTokens: 64,
    sessionId: 'health-probe-vm-01',
    personaMode: 'overwrite',
    rewrite: true,
  })
  assert.equal(inbound.system.length, 4)
  assert.equal(inbound.system[0].text, CRS_OFFICIAL_SYSTEM)
  assert.equal(inbound.system[1].text, CRS_OFFICIAL_AGENT_PROMPT)
  assert.deepEqual(inbound.system[1].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.match(inbound.system[2].text, /# Environment/)
  assert.deepEqual(inbound.system[2].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.equal(isOfficialClaudeCodeTraffic(headers, inbound), true)
})

test('runVmTestChat reports cli-hop when slot engine is rust', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-testchat-cli-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  seedVm(root, 'vm-13')
  fs.mkdirSync(path.join(root, 'src/config'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'src/config/routing.json'),
    JSON.stringify({ inference: { engine: 'rust', fallback_to_go: false, strict: true } }),
  )
  const { baseUrl, calls } = await startLoopbackServer(t, () => ({
    status: 200,
    body: {
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 8, output_tokens: 2 },
      stop_reason: 'end_turn',
    },
  }))
  const result = await runVmTestChat({
    projectRoot: root,
    vmId: 'vm-13',
    model: 'claude-haiku-4-5',
    prompt: 'hello',
    max_tokens: 64,
    baseUrl,
    apiKey: 'test-master-key',
  })
  assert.equal(result.ok, true)
  assert.equal(result.inference_engine, 'rust')
  assert.equal(result.dataplane, 'wrap')
  assert.equal(result.official_cc_inference, 'cli-hop')
  assert.equal(result.debug.inbound_class, 'cli_hop_passthrough')
  assert.equal(calls[0].headers['user-agent'], 'kin-console-test/1.0')
  assert.equal(calls[0].body.system, undefined)
  assert.ok(result.log.some((l) => /cli-hop wrap/.test(l.message)))
  assert.ok(result.log.some((l) => /cli-hop CLI 官方提示词/.test(l.message)))
})

test('runVmTestChat reports crag dataplane when routing says crag', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-testchat-crag-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  seedVm(root, 'vm-13')
  fs.mkdirSync(path.join(root, 'src/config'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'src/config/routing.json'),
    JSON.stringify({ inference: { engine: 'rust', dataplane: 'crag', fallback_to_go: false, strict: true } }),
  )
  const { baseUrl } = await startLoopbackServer(t, () => ({
    status: 200,
    body: {
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 8, output_tokens: 2 },
      stop_reason: 'end_turn',
    },
  }))
  const result = await runVmTestChat({
    projectRoot: root,
    vmId: 'vm-13',
    model: 'claude-haiku-4-5',
    prompt: 'hello',
    max_tokens: 64,
    baseUrl,
    apiKey: 'test-master-key',
  })
  assert.equal(result.ok, true)
  assert.equal(result.dataplane, 'crag')
  assert.ok(result.log.some((l) => /cli-hop crag/.test(l.message)))
  assert.equal(
    result.log.some((l) => /cli-hop wrap/.test(l.message)),
    false,
  )
})
