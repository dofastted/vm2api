import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { createRespond, readBody } from '../../src/lib/http/respond.mjs'
import { rememberRustHealth, clearRustHealthCache } from '../../src/lib/transport/kernel-router.mjs'
import { sealClaudeCodeCch } from '../../src/lib/identity/cch.mjs'

const root = path.resolve(import.meta.dirname, '../..')

async function startRealChain({ kernelBin, cliBin, preset, cacheTtl }) {
  const cleanups = []
  const close = async () => {
    for (const cleanup of cleanups.reverse()) await cleanup()
  }
  try {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-cch-history-'))
    cleanups.push(() => fs.rmSync(temp, { recursive: true, force: true }))
    const captured = []
    const upstream = http.createServer(async (req, res) => {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw)
      captured.push(body)
      const events = [
        {
          type: 'message_start',
          message: {
            id: 'msg_cch',
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
    })
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    cleanups.push(async () => {
      upstream.closeAllConnections()
      await new Promise((resolve) => upstream.close(resolve))
    })
    const socketPath = path.join(temp, 'kernel.sock')
    const token = 'local-cch-history-token'
    const tokenPath = path.join(temp, 'internal.token')
    fs.writeFileSync(tokenPath, token)
    const homeDir = path.join(temp, 'cli-home')
    fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true })
    const credentialPath = path.join(homeDir, '.claude', 'credentials.json')
    fs.writeFileSync(credentialPath, JSON.stringify({ anthropicApiKey: { apiKey: 'local-fixture-key' } }))
    const configPath = path.join(temp, 'kernel.json')
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        vm_id: 'cch-fixture',
        socket_path: socketPath,
        credential_path: credentialPath,
        internal_token: token,
        provider: 'local_cli',
        claude_bin: cliBin,
        slots_per_worker: 2,
        system_layout: 'identity',
        persona_preset: preset,
        cli_version: '2.1.296',
        default_cache_ttl: cacheTtl,
        cch_enabled: true,
        timezone: 'America/New_York',
        test_endpoints: true,
        anthropic_base_url: `http://127.0.0.1:${upstream.address().port}`,
      }),
    )
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: temp,
      ANTHROPIC_API_KEY: 'local-fixture-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      NO_PROXY: '127.0.0.1,localhost',
      KIN_ENVELOPE_PATH: path.join(temp, 'no-envelope.json'),
    }
    for (const key of [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_VERSION',
      'KIN_SOCKS5',
      'KIN_HTTPS_PROXY',
      'KIN_CLAUDE_AI_OAUTH_JSON',
      'KIN_CLAUDE_CODE_OAUTH_TOKEN',
    ])
      delete env[key]
    const kernel = spawn(kernelBin, ['--gateway-worker', '--config', configPath], {
      cwd: temp,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const closed = once(kernel, 'close')
    let log = ''
    kernel.stdout.on('data', (chunk) => {
      log += chunk
    })
    kernel.stderr.on('data', (chunk) => {
      log += chunk
    })
    cleanups.push(async () => {
      kernel.kill('SIGKILL')
      await closed
    })
    for (let i = 0; i < 100 && !fs.existsSync(socketPath) && kernel.exitCode == null; i++)
      await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok(fs.existsSync(socketPath), log.slice(-1200))
    const health = await new Promise((resolve, reject) => {
      const req = http.get({ socketPath, path: '/internal/health', headers: { 'x-internal-token': token } }, (res) => {
        let text = ''
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => resolve(JSON.parse(text)))
      })
      req.on('error', reject)
    })
    const vm = {
      id: 'cch-fixture',
      claude: { mode: 'api-key' },
      runtime: { kernel_socket: socketPath, worker_token_file: tokenPath, worker_run_dir: temp },
    }
    const exec = { vmId: vm.id, vm, homeDir, oauth: {}, timezone: 'UTC' }
    const routing = {
      inference: { engine: 'rust', health_ttl_ms: 60000 },
      compatibility: {
        persona_preset: preset,
        cache_ttl: cacheTtl,
        min_max_tokens: 128,
        detect_proxied_official_cc: true,
        thinking_display: 'omitted',
        overlay_preset: 'off',
      },
      failover: { stream_keepalive_ms: 0 },
    }
    const routingPath = path.join(temp, 'routing.json')
    fs.writeFileSync(routingPath, JSON.stringify(routing))
    const previousKernelBin = process.env.KIN_KERNEL_BIN
    process.env.KIN_KERNEL_BIN = kernelBin
    cleanups.push(() => {
      if (previousKernelBin === undefined) delete process.env.KIN_KERNEL_BIN
      else process.env.KIN_KERNEL_BIN = previousKernelBin
    })
    rememberRustHealth(exec, { ok: true, health })
    cleanups.push(() => clearRustHealthCache(vm.id))
    const cfg = {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 4 * 1024 * 1024, upstream_timeout_ms: 15000, stream_idle_timeout_ms: 15000 },
      paths: { project: temp, data: temp },
    }
    const handler = createHandleProtocol({
      ...createRespond(cfg),
      readBody,
      cfg,
      requireAuth: () => true,
      requestLog: { start: () => ({ request_id: 'req_cch' }), finish() {} },
      stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
      groupsRepo: { rateMultiplier: () => 1 },
      routingConfigPath: routingPath,
      routingConfig: routing,
      apiKeyStore: {},
      accountQuota: {},
      stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
      failoverRunner: {
        async run(opts) {
          const candidate = { vmId: vm.id, accountId: 'fixture-account', vm, exec }
          const prepared = await opts.applyAttempt(opts.canonicalBody, candidate)
          return opts.callAttempt({
            candidate,
            body: prepared.body,
            attemptMeta: prepared.meta,
            signal: opts.signal,
            deliveryMode: opts.deliveryMode,
            onCommit() {},
          })
        },
      },
    })
    const gateway = http.createServer((req, res) => {
      req.apiKeyKind = 'master'
      handler.handleProtocol(req, res, 'anthropic.messages', '/v1/messages').catch((error) => {
        res.writeHead(500)
        res.end(String(error.stack))
      })
    })
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve))
    cleanups.push(async () => {
      gateway.closeAllConnections()
      await new Promise((resolve) => gateway.close(resolve))
    })
    return {
      close,
      async send({ request }) {
        const before = captured.length
        const response = await fetch(`http://127.0.0.1:${gateway.address().port}/v1/messages`, {
          method: 'POST',
          headers: { ...request.headers, 'content-type': 'application/json' },
          body: JSON.stringify(request.body),
        })
        await response.text()
        return { status: response.status, count: captured.length - before, body: captured.at(-1) }
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}

function withoutMarkers(value) {
  if (Array.isArray(value)) return value.map(withoutMarkers)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'cache_control')
      .map(([key, nested]) => [key, withoutMarkers(nested)]),
  )
}

test('CLI seals system billing without changing quoted billing in growing history', { timeout: 60000 }, async (t) => {
  const chain = await startRealChain({
    kernelBin: process.env.KIN_CCH_KERNEL || path.join(root, 'bin/kin-kernel'),
    cliBin: process.env.KIN_CCH_CLI || path.join(root, 'share/wrap-cli/cli-node'),
    preset: 'official',
    cacheTtl: '1h',
  })
  t.after(() => chain.close())

  const literal = 'x-anthropic-billing-header: cc_version=2.8.4; cc_entrypoint=sdk-cli; cch=259ed;'
  const body = {
    model: 'claude-opus-5-5',
    max_tokens: 128,
    stream: true,
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.296; cc_entrypoint=sdk-cli; cch=00000;' },
      { type: 'text', text: 'Preserve the fixture and continue the conversation.' },
    ],
    tools: [{ name: 'Read', description: 'Read a fixture', input_schema: { type: 'object', properties: {} } }],
    messages: [
      { role: 'user', content: 'Read the fixture.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'read_fixture', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read_fixture', content: literal }] },
    ],
  }

  let previous = []
  for (let turn = 0; turn < 3; turn++) {
    if (turn)
      body.messages.push({ role: 'assistant', content: 'Done.' }, { role: 'user', content: `Continue ${turn}.` })
    const result = await chain.send({
      source: { protocol: 'anthropic.messages' },
      request: { path: '/v1/messages', headers: { 'user-agent': 'cache-history-fixture' }, body },
    })
    assert.equal(result.status, 200)
    assert.equal(result.count, 1)
    assert.equal(result.body.messages[2].content[0].content, literal)
    assert.deepEqual(withoutMarkers(result.body.messages.slice(0, previous.length)), withoutMarkers(previous))

    const billing = result.body.system.find((block) => /^x-anthropic-billing-header:/i.test(block.text || ''))
    assert.ok(billing)
    assert.equal((billing.text.match(/\bcch=/g) || []).length, 1)
    const resealed = sealClaudeCodeCch(result.body)
    assert.deepEqual(resealed.messages, result.body.messages)
    assert.deepEqual(
      resealed.system,
      result.body.system,
      'CLI digest must match final-body CCH, not a session constant',
    )
    previous = result.body.messages
  }
})
