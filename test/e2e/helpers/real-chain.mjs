/**
 * Real outbound chain for e2e and replay: in-process Node handler → kin-kernel ELF →
 * cli-node ELF → local capture upstream. `send(fixture)` takes a crag replay
 * fixture (schema v1) and returns what the CLI finally put on the wire.
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHandleProtocol } from '../../../src/lib/protocol/handle-protocol.mjs'
import { createRespond, readBody } from '../../../src/lib/http/respond.mjs'
import { rememberRustHealth, clearRustHealthCache } from '../../../src/lib/transport/kernel-router.mjs'
import { profileForPreset } from '../../../src/lib/identity/official-profiles.mjs'
import { ccEntrypointFromRouting } from '../../../src/lib/identity/crs-persona.mjs'

const PROTOCOL_BY_PATH = {
  '/v1/messages': 'anthropic.messages',
  '/v1/chat/completions': 'openai.chat',
  '/v1/responses': 'openai.responses',
}
const DROP_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding'])

function unixRequest(socketPath, token, endpoint) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: endpoint, headers: { 'x-internal-token': token } }, (res) => {
      let text = ''
      res.on('data', (chunk) => {
        text += chunk
      })
      res.on('end', () => resolve(text))
    })
    req.on('error', reject)
    req.end()
  })
}

function message(model) {
  return {
    id: 'msg_303',
    type: 'message',
    role: 'assistant',
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }
}

function sse(model) {
  const events = [
    { type: 'message_start', message: message(model) },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function json(model) {
  return JSON.stringify({
    ...message(model),
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { ...message(model).usage, output_tokens: 1 },
  })
}

export async function startRealChain({
  kernelBin,
  cliBin,
  preset = 'official_303',
  cacheTtl = '5m',
  routingBase = null,
  timezone = 'America/New_York',
}) {
  const cleanups = []
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    for (const fn of cleanups.reverse()) await fn()
  }
  try {
    return await start()
  } catch (error) {
    await close()
    throw error
  }

  async function start() {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-303-e2e-'))
    cleanups.push(() => fs.rmSync(temp, { recursive: true, force: true }))
    const captured = []
    const upstream = http.createServer(async (req, res) => {
      let raw = ''
      for await (const chunk of req) raw += chunk
      if (!req.url.startsWith('/v1/messages')) return res.writeHead(404).end()
      const body = JSON.parse(raw)
      captured.push({ raw, body, headers: { ...req.headers } })
      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_303' })
        return res.end(json(body.model))
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_303' })
      res.end(sse(body.model))
    })
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    cleanups.push(async () => {
      upstream.closeAllConnections()
      await new Promise((resolve) => upstream.close(resolve))
    })
    const socketPath = path.join(temp, 'kernel.sock')
    const token = 'e2e-internal-token'
    const tokenPath = path.join(temp, 'internal.token')
    fs.writeFileSync(tokenPath, token)
    const homeDir = path.join(temp, 'cli-home')
    fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true })
    const credentialPath = path.join(homeDir, '.claude', 'credentials.json')
    fs.writeFileSync(credentialPath, JSON.stringify({ anthropicApiKey: { apiKey: 'local-fixture-key' } }))
    const configPath = path.join(temp, 'kernel.json')
    let presetNow = preset
    let ttlNow = cacheTtl
    const kernelConfig = () => ({
      vm_id: 'vm-01',
      socket_path: socketPath,
      credential_path: credentialPath,
      internal_token: token,
      provider: 'local_cli',
      claude_bin: cliBin,
      slots_per_worker: 2,
      system_layout: 'identity',
      persona_preset: presetNow,
      // Same projection as writeKernelConfig: cli-node hot-reads this for UA and billing.
      cli_version: profileForPreset(presetNow).cliVersion,
      default_cache_ttl: ttlNow,
      cc_entrypoint: ccEntrypointFromRouting(
        routingBase || { compatibility: { persona_preset: presetNow, cache_ttl: ttlNow } },
      ),
      cch_enabled: true,
      timezone,
      test_endpoints: true,
      anthropic_base_url: `http://127.0.0.1:${upstream.address().port}`,
    })
    fs.writeFileSync(configPath, JSON.stringify(kernelConfig()))
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
    ])
      delete env[key]
    const kernel = spawn(kernelBin, ['--gateway-worker', '--config', configPath], {
      cwd: temp,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const kernelClosed = once(kernel, 'close')
    let log = ''
    kernel.stdout.on('data', (c) => {
      log += c
    })
    kernel.stderr.on('data', (c) => {
      log += c
    })
    cleanups.push(async () => {
      kernel.kill('SIGKILL')
      await kernelClosed
    })
    for (let i = 0; i < 400 && !fs.existsSync(socketPath) && kernel.exitCode == null; i++)
      await new Promise((resolve) => setTimeout(resolve, 50))
    if (!fs.existsSync(socketPath)) throw new Error(`kernel socket missing\n${log.slice(-1200)}`)
    const health = JSON.parse(await unixRequest(socketPath, token, '/internal/health'))
    const vm = {
      id: 'vm-01',
      claude: { mode: 'api-key' },
      runtime: { kernel_socket: socketPath, worker_token_file: tokenPath, worker_run_dir: temp },
    }
    const exec = { vmId: vm.id, vm, homeDir, oauth: {}, timezone: 'UTC' }
    const routingPath = path.join(temp, 'routing.json')
    const buildRouting = () => {
      if (!routingBase) {
        return {
          inference: { engine: 'rust', health_ttl_ms: 60000 },
          compatibility: {
            persona_preset: presetNow,
            cache_ttl: ttlNow,
            min_max_tokens: 128,
            detect_proxied_official_cc: true,
            thinking_display: 'omitted',
            overlay_preset: 'off',
          },
          failover: { stream_keepalive_ms: 0 },
        }
      }
      const routing = structuredClone(routingBase)
      routing.compatibility = {
        ...routing.compatibility,
        persona_preset: presetNow,
        cache_ttl: ttlNow,
        overlay_preset: 'off',
      }
      routing.inference = { health_ttl_ms: 60000, ...routing.inference, engine: 'rust' }
      routing.failover = { ...routing.failover, stream_keepalive_ms: 0 }
      return routing
    }
    let routing
    // Routing and kernel.json move together, as the panel save does; the kernel hot-reloads.
    const writeSettings = () => {
      routing = buildRouting()
      fs.writeFileSync(routingPath, JSON.stringify(routing))
      fs.writeFileSync(configPath, JSON.stringify(kernelConfig()))
    }
    writeSettings()
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
    const logs = []
    const handler = createHandleProtocol({
      ...createRespond(cfg),
      readBody,
      cfg,
      requireAuth: () => true,
      requestLog: {
        start: () => ({ request_id: 'req_303_gateway', mode: 'debug', capture_outbound: true }),
        finish: (_ctx, bag) => logs.push(bag),
      },
      stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
      groupsRepo: { rateMultiplier: () => 1 },
      routingConfigPath: routingPath,
      routingConfig: routing,
      getRoutingConfig: () => routing,
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
    // send() is serialized, so the gateway reads the in-flight protocol from here.
    let protocolNow = 'anthropic.messages'
    const gateway = http.createServer((req, res) => {
      req.apiKeyKind = 'master'
      handler.handleProtocol(req, res, protocolNow, req.url.split('?')[0]).catch((error) => {
        res.writeHead(500)
        res.end(String(error.stack))
      })
    })
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve))
    cleanups.push(async () => {
      gateway.closeAllConnections()
      await new Promise((resolve) => gateway.close(resolve))
    })
    let queue = Promise.resolve()
    const sendOne = async (fixture) => {
      const request = fixture.request || {}
      const requestPath = request.path || '/v1/messages'
      protocolNow = fixture.source?.protocol || PROTOCOL_BY_PATH[requestPath.split('?')[0]] || 'anthropic.messages'
      const headers = {}
      for (const [key, value] of Object.entries(request.headers || {}))
        if (!DROP_HEADERS.has(key.toLowerCase())) headers[key] = value
      headers['content-type'] = 'application/json'
      const before = captured.length
      const response = await fetch(`http://127.0.0.1:${gateway.address().port}${requestPath}`, {
        method: request.method || 'POST',
        headers,
        body: JSON.stringify(request.body),
      })
      const text = await response.text()
      const last = captured.length > before ? captured.at(-1) : null
      return {
        status: response.status,
        response: text,
        raw: last?.raw ?? null,
        body: last?.body ?? null,
        headers: last?.headers ?? null,
        count: captured.length - before,
      }
    }
    const send = (fixture) => {
      const result = queue.then(() => sendOne(fixture))
      queue = result.catch(() => {})
      return result
    }
    return {
      send,
      switchPreset(next) {
        presetNow = next
        writeSettings()
      },
      setCacheTtl(next) {
        ttlNow = next
        writeSettings()
      },
      health: () => unixRequest(socketPath, token, '/internal/health'),
      logs,
      close,
    }
  }
}
