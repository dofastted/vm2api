import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  resolveHopEngine,
  dispatchStreamInference,
  dispatchCallInference,
  rustHealthTtlMs,
  rustSlotWaitMs,
  resolveHopSlotWaitMs,
  rustShouldWaitForSlot,
  waitForReadySlot,
  clearRustHealthCache,
  rememberRustHealth,
  peekRustHealth,
} from '../../src/lib/transport/kernel-router.mjs'
import { rustKernelBusy, rustKernelReachable } from '../../src/lib/transport/rust-kernel-client.mjs'
import {
  ensureRustKernel,
  writeKernelConfig,
  reconcileCliHopRuntime,
  wrapSlotCount,
  wrapNewerThanKernel,
  credentialsNewerThanKernel,
  WRAP_SLOT_MAX,
  WRAP_IDLE_RECYCLE_MS,
  scheduleWrapRecycle,
  recycleWrapIfIdle,
  resetWrapRecycleState,
} from '../../src/lib/transport/rust-kernel-supervisor.mjs'
import { rustKernelPaths, isNeedsRefreshResult } from '../../src/lib/transport/rust-kernel-client.mjs'
import { OFFICIAL_CLI_VERSION } from '../../src/lib/identity/vm-identity.mjs'

const unix = process.platform !== 'win32'
const unixTest = unix ? test : test.skip

test('wrap system error is not a credential ensure; 401 still is', () => {
  assert.equal(
    isNeedsRefreshResult({
      status: 200,
      terminalState: 'incomplete',
      body: { error: { code: 'upstream_stream_incomplete', message: 'provider error: provider error: system error' } },
    }),
    false,
  )
  assert.equal(
    isNeedsRefreshResult({ status: 401, body: { error: { message: 'OAuth access token has been revoked' } } }),
    true,
  )
  assert.equal(isNeedsRefreshResult({ status: 200, body: { error: { code: 'ok', message: 'fine' } } }), false)
})

test('rustHealthTtlMs defaults to 2s and 0 disables cache', () => {
  assert.equal(rustHealthTtlMs({}), 2000)
  assert.equal(rustHealthTtlMs({ inference: { health_ttl_ms: 0 } }), 0)
  assert.equal(rustHealthTtlMs({ inference: { health_ttl_ms: 1500 } }), 1500)
})

test('busy CLI waits for a free slot and is not hop-ready', () => {
  const busy = { ok: true, engine: 'rust', ready_slots: 0, cli_pid: 12 }
  const ready = { ok: true, engine: 'rust', ready_slots: 2, cli_pid: 12 }
  assert.equal(rustKernelBusy(busy), true)
  assert.equal(rustKernelReachable(busy), false)
  assert.equal(rustShouldWaitForSlot(busy, 0), true)
  assert.equal(rustShouldWaitForSlot(ready, 0), false)
  assert.equal(rustShouldWaitForSlot(ready, 1), true)
  assert.equal(rustSlotWaitMs({}), 30_000)
  assert.equal(rustSlotWaitMs({ inference: { slot_wait_ms: 1500 } }), 1500)
})

test('waitForReadySlot times out instead of hopping into a full kernel', async () => {
  const result = await waitForReadySlot({ vmId: 'vm-missing-slot' }, 250, 50)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'slot_busy')
})

test('hop slot wait uses remaining wait-plan budget instead of a second 30s', () => {
  assert.equal(resolveHopSlotWaitMs({ remainingBudgetMs: 0 }), 0)
  assert.equal(resolveHopSlotWaitMs({ remainingBudgetMs: 5000 }), 5000)
  assert.equal(
    resolveHopSlotWaitMs({ remainingBudgetMs: 45_000, routing: { inference: { slot_wait_ms: 8000 } } }),
    8000,
  )
  assert.equal(resolveHopSlotWaitMs({}), 30_000)
})

test('waitForReadySlot with zero budget does an immediate check only', async () => {
  const started = Date.now()
  const result = await waitForReadySlot({ vmId: 'vm-zero-budget' }, 0, 50)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'slot_busy')
  assert.ok(Date.now() - started < 80)
})

test('rust health cache hits within TTL and misses when disabled', () => {
  clearRustHealthCache()
  const exec = { vmId: 'vm-cache' }
  rememberRustHealth(exec, { ok: true, health: { engine: 'rust' } })
  assert.equal(peekRustHealth(exec, 2000)?.health?.engine, 'rust')
  assert.equal(peekRustHealth(exec, 0), null)
  assert.equal(peekRustHealth(exec, 2000, Date.now() + 3000), null)
  clearRustHealthCache('vm-cache')
  assert.equal(peekRustHealth(exec, 2000), null)
})

test('resolveHopEngine prefers vm rust over routing go', () => {
  const hit = resolveHopEngine({ inference_engine: 'rust' }, { inference: { engine: 'go' } }, { rustReady: true })
  assert.equal(hit.engine, 'rust')
  assert.equal(hit.wanted, 'rust')
})

test('resolveHopEngine keeps rust cli-hop for setup-token slots', () => {
  const hit = resolveHopEngine(
    { inference_engine: 'rust', claude: { mode: 'setup-token' } },
    { inference: { engine: 'go' } },
    { rustReady: true },
  )
  assert.equal(hit.engine, 'rust')
  assert.equal(hit.wanted, 'rust')
})

test('resolveHopEngine blocks when rust binary is missing', () => {
  const hit = resolveHopEngine(
    { inference_engine: 'rust' },
    { inference: { engine: 'rust', fallback_to_go: true } },
    { binPath: '' },
  )
  assert.equal(hit.engine, 'rust')
  assert.equal(hit.wanted, 'rust')
  assert.equal(hit.blocked, true)
  assert.equal(hit.fallback, false)
  assert.equal(hit.reason, 'bin_missing')
})

test('noGoFallback blocks rust-to-go when kernel is missing', () => {
  const hit = resolveHopEngine(
    { inference_engine: 'rust' },
    { inference: { engine: 'rust', fallback_to_go: true } },
    { binPath: '', noGoFallback: true },
  )
  assert.equal(hit.engine, 'rust')
  assert.equal(hit.blocked, true)
  assert.equal(hit.fallback, false)
})

test('strict rust without binary is blocked', () => {
  const hit = resolveHopEngine(
    {},
    { inference: { engine: 'rust', fallback_to_go: false, strict: true } },
    { binPath: '' },
  )
  assert.equal(hit.engine, 'rust')
  assert.equal(hit.blocked, true)
})

async function kernelFixture(handler) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-hop-'))
  const slot = path.join(root, 'vms', 'vm-01')
  const runDir = path.join(slot, 'run')
  const homeDir = path.join(slot, 'cli-home')
  fs.mkdirSync(runDir, { recursive: true })
  fs.mkdirSync(homeDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'internal.token'), 'internal-test\n', { mode: 0o600 })
  const socket = path.join(runDir, 'kernel.sock')
  const server = http.createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, resolve)
  })
  const exec = {
    vmId: 'vm-01',
    homeDir,
    vm: {
      id: 'vm-01',
      inference_engine: 'rust',
      runtime: {
        kernel_socket: socket,
        worker_run_dir: runDir,
        worker_token_file: path.join(runDir, 'internal.token'),
      },
    },
  }
  return {
    root,
    exec,
    async close() {
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

unixTest('dispatchStreamInference uses rust socket when ready', async () => {
  const prev = process.env.KIN_KERNEL_BIN
  process.env.KIN_KERNEL_BIN = '/bin/true'
  const fx = await kernelFixture((req, res) => {
    assert.equal(req.headers['x-kin-internal-token'], 'internal-test')
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      trailer: 'x-kin-usage, x-kin-stop-reason',
      'x-kin-terminal-state': 'verified',
      'x-kin-model': 'claude-haiku-4-5-20251001',
    })
    res.write('event: message_stop\n')
    res.write('data: {"type":"message_stop"}\n\n')
    res.addTrailers({
      'x-kin-usage': JSON.stringify({
        input_tokens: 12,
        output_tokens: 4,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 5,
        cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 3 },
      }),
      'x-kin-stop-reason': 'end_turn',
    })
    res.end()
  })
  try {
    const result = await dispatchStreamInference({
      exec: fx.exec,
      body: { model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'hi' }] },
      routing: { inference: { engine: 'rust', fallback_to_go: true } },
      ensureRust: async () => ({ ok: true, reason: 'already_up' }),
      timeoutMs: 3000,
    })
    assert.equal(result.engine, 'rust')
    assert.equal(result.wanted_engine, 'rust')
    assert.match(String(result.via), /rust-kernel/)
    assert.equal(result.terminalState, 'verified')
    assert.deepEqual(result.usage, {
      input_tokens: 12,
      output_tokens: 4,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 5,
      cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 3 },
    })
    assert.equal(result.model, 'claude-haiku-4-5-20251001')
    assert.equal(result.stopReason, 'end_turn')
  } finally {
    await fx.close()
    if (prev == null) delete process.env.KIN_KERNEL_BIN
    else process.env.KIN_KERNEL_BIN = prev
  }
})

unixTest('needs_refresh retries once via Go ensure', async () => {
  const prev = process.env.KIN_KERNEL_BIN
  process.env.KIN_KERNEL_BIN = '/bin/true'
  let hits = 0
  let ensures = 0
  const fx = await kernelFixture((_req, res) => {
    hits += 1
    if (hits === 1) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'worker_error', code: 'needs_refresh', message: 'credential needs refresh' },
        }),
      )
      return
    }
    res.writeHead(200, { 'content-type': 'application/json', 'x-kin-terminal-state': 'verified' })
    res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [] }))
  })
  try {
    const result = await dispatchCallInference({
      exec: fx.exec,
      body: { model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'hi' }] },
      routing: { inference: { engine: 'rust' } },
      ensureRust: async () => ({ ok: true }),
      recycleWrap: () => {},
      ensureCredential: async (_exec, opts = {}) => {
        ensures += 1
        assert.equal(opts.force, true)
        return { ok: true }
      },
    })
    assert.equal(hits, 2)
    assert.equal(ensures, 1)
    assert.equal(result.credential_retried, true)
    assert.equal(result.engine, 'rust')
  } finally {
    await fx.close()
    if (prev == null) delete process.env.KIN_KERNEL_BIN
    else process.env.KIN_KERNEL_BIN = prev
  }
})

unixTest('failed Go credential ensure is not followed by a blind Rust retry', async () => {
  const previous = process.env.KIN_KERNEL_BIN
  process.env.KIN_KERNEL_BIN = '/bin/true'
  let hits = 0
  const fx = await kernelFixture((_req, res) => {
    hits += 1
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        type: 'error',
        error: { type: 'worker_error', code: 'needs_refresh', message: 'credential needs refresh' },
      }),
    )
  })
  try {
    const result = await dispatchCallInference({
      exec: fx.exec,
      body: { model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'hi' }] },
      routing: { inference: { engine: 'rust' } },
      ensureRust: async () => ({ ok: true }),
      recycleWrap: () => {},
      ensureCredential: async (_exec, opts = {}) => {
        assert.equal(opts.force, true)
        return {
          ok: false,
          status: 401,
          error: { type: 'worker_error', code: 'invalid_grant', message: 'credential was revoked' },
        }
      },
    })
    assert.equal(hits, 1)
    assert.equal(result.credential_ensure_failed, true)
    assert.equal(result.status, 401)
    assert.equal(result.body.error.type, 'authentication_error')
    assert.equal(result.committed, false)

    assert.equal(result.body.error.code, 'invalid_grant')
  } finally {
    await fx.close()
    if (previous == null) delete process.env.KIN_KERNEL_BIN
    else process.env.KIN_KERNEL_BIN = previous
  }
})
unixTest('unhealthy rust does not fall back to go', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-fb-'))
  const slot = path.join(root, 'vm-01')
  const runDir = path.join(slot, 'run')
  const homeDir = path.join(slot, 'cli-home')
  fs.mkdirSync(runDir, { recursive: true })
  fs.mkdirSync(homeDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'internal.token'), 'internal-test\n', { mode: 0o600 })
  const socket = path.join(runDir, 'worker.sock')
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-kin-terminal-state': 'verified',
    })
    res.write('event: message_stop\n')
    res.write('data: {"type":"message_stop"}\n\n')
    res.end()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, resolve)
  })
  const exec = {
    vmId: 'vm-01',
    homeDir,
    vm: {
      id: 'vm-01',
      inference_engine: 'rust',
      runtime: {
        worker_socket: socket,
        worker_run_dir: runDir,
        worker_token_file: path.join(runDir, 'internal.token'),
      },
    },
  }
  try {
    const result = await dispatchStreamInference({
      exec,
      body: { model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'hi' }] },
      routing: { inference: { engine: 'rust', fallback_to_go: true } },
      ensureRust: async () => ({ ok: false, reason: 'bin_missing' }),
      timeoutMs: 3000,
    })
    assert.equal(result.engine, 'rust')
    assert.equal(result.wanted_engine, 'rust')
    assert.equal(result.ok, false)
    assert.equal(result.body?.error?.code, 'bin_missing')
    assert.match(String(result.via), /rust-kernel/)
    const disconnected = await dispatchStreamInference({
      exec,
      body: { model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'hi' }] },
      routing: { inference: { engine: 'rust', fallback_to_go: true } },
      ensureRust: async () => ({ ok: true, reason: 'already_up' }),
      timeoutMs: 3000,
    })
    assert.equal(disconnected.engine, 'rust')
    assert.equal(disconnected.wanted_engine, 'rust')
    assert.equal(disconnected.transportError, true)
    assert.match(String(disconnected.via), /rust-kernel/)
    const strict = await dispatchStreamInference({
      exec,
      body: { model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'hi' }] },
      routing: { inference: { engine: 'rust', fallback_to_go: true, strict: true } },
      ensureRust: async () => ({ ok: true, reason: 'already_up' }),
      timeoutMs: 3000,
    })
    assert.equal(strict.engine, 'rust')
    assert.equal(strict.transportError, true)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

unixTest('pinned rust does not fall back to Go HTTP', async () => {
  const result = await dispatchStreamInference({
    exec: { vmId: 'vm-10', vm: { id: 'vm-10', inference_engine: 'rust' } },
    body: { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] },
    routing: { inference: { engine: 'rust', fallback_to_go: true } },
    noGoFallback: true,
    ensureRust: async () => ({ ok: false, reason: 'bin_missing', error: 'glibc' }),
    timeoutMs: 1000,
  })
  assert.equal(result.engine, 'rust')
  assert.equal(result.wanted_engine, 'rust')
  assert.equal(result.ok, false)
  assert.equal(result.body?.error?.code, 'bin_missing')
  assert.match(String(result.via), /rust-kernel/)
})

unixTest('committed Rust stream transport failure is not replayed on Go', async () => {
  const previous = process.env.KIN_KERNEL_BIN
  process.env.KIN_KERNEL_BIN = '/bin/true'
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-committed-'))
  const runDir = path.join(root, 'vm-01', 'run')
  const homeDir = path.join(root, 'vm-01', 'cli-home')
  fs.mkdirSync(runDir, { recursive: true })
  fs.mkdirSync(homeDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'internal.token'), 'internal-test\n', { mode: 0o600 })
  const kernelSocket = path.join(runDir, 'kernel.sock')
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.flushHeaders()
    res.write('data: {"type":"message_start","message":{}}\n\n', () => res.destroy())
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(kernelSocket, resolve)
  })
  const exec = {
    vmId: 'vm-01',
    homeDir,
    vm: {
      id: 'vm-01',
      inference_engine: 'rust',
      runtime: {
        kernel_socket: kernelSocket,
        worker_socket: path.join(runDir, 'worker.sock'),
        worker_run_dir: runDir,
        worker_token_file: path.join(runDir, 'internal.token'),
      },
    },
  }
  try {
    const recycled = []
    const result = await dispatchStreamInference({
      exec,
      body: { model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'hi' }] },
      routing: { inference: { engine: 'rust', fallback_to_go: true } },
      ensureRust: async () => ({ ok: true, reason: 'already_up' }),
      recycleWrap: (target) => {
        recycled.push(target?.vmId)
        return { ok: true, skipped: false }
      },
      timeoutMs: 3000,
    })
    assert.equal(result.engine, 'rust')
    assert.equal(result.wanted_engine, 'rust')
    assert.equal(result.committed, true)
    assert.equal(result.transportError, true)
    assert.equal(result.terminalState, 'incomplete')
    assert.deepEqual(recycled, [])
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
    if (previous == null) delete process.env.KIN_KERNEL_BIN
    else process.env.KIN_KERNEL_BIN = previous
  }
})

test('writeKernelConfig separates container paths from host socket paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-cfg-'))
  const written = writeKernelConfig(root, { id: 'vm-09' }, { token: 'tok', proxyUrl: '', proxyRequired: false })
  const doc = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  assert.equal(doc.vm_id, 'vm-09')
  assert.equal(doc.internal_token, 'tok')
  assert.equal(doc.socket_path, '/run/kin/kernel.sock')
  assert.equal(doc.credential_path, '/home/kincli/.claude/credentials.json')
  assert.equal(doc.runtime_kind, 'docker')
  assert.equal(doc.test_endpoints, false)
  assert.equal(doc.anthropic_base_url, undefined)
  assert.equal(doc.provider, 'local_cli')
  assert.equal(doc.claude_bin, '/home/kincli/.kin/cli-node')
  assert.equal(doc.https_proxy, undefined)
  assert.equal(doc.slots_per_worker, WRAP_SLOT_MAX)
  assert.match(written.socketPath.replace(/\\/g, '/'), /vms\/vm-09\/run\/kernel\.sock$/)
  assert.equal(fs.readFileSync(written.tokenPath, 'utf8').trim(), 'tok')
  const exec = { vmId: 'vm-09', homeDir: path.join(root, 'vms', 'vm-09', 'cli-home'), vm: { id: 'vm-09' } }
  assert.equal(rustKernelPaths(exec).socketPath, written.socketPath)
  fs.rmSync(root, { recursive: true, force: true })
})

test('writeKernelConfig cli-hop writes local_cli without secrets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-cli-hop-cfg-'))
  const written = writeKernelConfig(
    root,
    { id: 'vm-05', inference_engine: 'rust', timezone: 'America/New_York' },
    {
      token: 'tok',
      proxyUrl: 'socks5h://127.0.0.1:1080',
      proxyRequired: true,
      timezone: 'America/New_York',
    },
  )
  const doc = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  const raw = fs.readFileSync(written.configPath, 'utf8')
  assert.equal(doc.provider, 'local_cli')
  assert.equal(doc.claude_bin, '/home/kincli/.kin/cli-node')
  assert.equal(doc.https_proxy, undefined)
  assert.equal(doc.slots_per_worker, WRAP_SLOT_MAX)
  assert.equal(doc.system_layout, 'zero')
  assert.equal(doc.cli_version, OFFICIAL_CLI_VERSION)
  assert.equal(doc.timezone, 'America/New_York')
  assert.equal(doc.proxy_url, '')
  assert.equal(doc.proxy_required, false)
  assert.doesNotMatch(raw, /sk-ant-|oat01|password=/i)
  fs.rmSync(root, { recursive: true, force: true })
})

test('writeKernelConfig uses identity layout when persona_inject is rewrite', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-identity-'))
  const written = writeKernelConfig(
    root,
    { id: 'vm-05', inference_engine: 'rust' },
    {
      token: 'tok',
      routing: { compatibility: { persona_inject: 'rewrite', persona_preset: 'official_full' } },
    },
  )
  const doc = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  assert.equal(doc.system_layout, 'identity')
  fs.rmSync(root, { recursive: true, force: true })
})

test('writeKernelConfig strips leftover CONNECT https_proxy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-preserve-proxy-'))
  const written = writeKernelConfig(
    root,
    { id: 'vm-10', inference_engine: 'rust' },
    { token: 'tok', proxyRequired: true },
  )
  const first = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  first.https_proxy = 'http://127.0.0.1:18010'
  first.slots_per_worker = 20
  first.timezone = 'America/Chicago'
  fs.writeFileSync(written.configPath, JSON.stringify(first, null, 2) + '\n')
  writeKernelConfig(root, { id: 'vm-10', inference_engine: 'rust' }, { token: 'tok', proxyRequired: true })
  const second = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  assert.equal(second.https_proxy, undefined)
  assert.equal(second.slots_per_worker, WRAP_SLOT_MAX)
  assert.equal(second.timezone, 'America/Chicago')
  fs.rmSync(root, { recursive: true, force: true })
})

test('reconcileCliHopRuntime reaps zombies and unpauses without CONNECT', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-reconcile-'))
  const written = writeKernelConfig(
    root,
    { id: 'vm-10', inference_engine: 'rust' },
    { token: 'tok', proxyRequired: true },
  )
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-10.json'),
    JSON.stringify({ id: 'vm-10', status: 'paused', schedulable: true }, null, 2),
  )
  const calls = []
  const runDockerExec = async (args) => {
    calls.push(args)
    return { ok: true }
  }
  const result = await reconcileCliHopRuntime(
    {
      projectRoot: root,
      vmId: 'vm-10',
      homeDir: path.join(root, 'vms', 'vm-10', 'cli-home'),
      vm: {
        id: 'vm-10',
        status: 'paused',
        schedulable: true,
        runtime: { container: 'kin-10', kernel_socket: written.socketPath },
      },
    },
    { runDockerExec },
  )
  assert.equal(result.ok, true)
  assert.equal(result.reason, 'transparent_egress')
  assert.deepEqual(result.actions, ['reap_zombies', 'status_running'])
  assert.equal(
    calls.some((args) => args.includes('python3') || args.includes('/home/kincli/.kin/http_to_socks.py')),
    false,
    JSON.stringify(calls),
  )
  const vm = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-10.json'), 'utf8'))
  assert.equal(vm.status, 'running')
  fs.rmSync(root, { recursive: true, force: true })
})

test('scheduleWrapRecycle bounces once then cools down', async () => {
  resetWrapRecycleState()
  const restarts = []
  const exec = { vmId: 'vm-13', vm: { id: 'vm-13' } }
  const restart = async (target) => {
    restarts.push(target.vmId)
    return { ok: true }
  }
  const first = scheduleWrapRecycle(exec, { now: 1_000, restart, cooldownMs: 30_000 })
  assert.equal(first.skipped, false)
  await first.pending
  const second = scheduleWrapRecycle(exec, { now: 10_000, restart, cooldownMs: 30_000 })
  assert.equal(second.skipped, true)
  assert.equal(second.reason, 'cooldown')
  const third = scheduleWrapRecycle(exec, { now: 40_000, restart, cooldownMs: 30_000 })
  assert.equal(third.skipped, false)
  await third.pending
  assert.deepEqual(restarts, ['vm-13', 'vm-13'])
  resetWrapRecycleState()
})

test('recycleWrapIfIdle bounces unknown and stale hops, skips fresh', async () => {
  resetWrapRecycleState()
  const restarts = []
  const exec = { vmId: 'vm-05', vm: { id: 'vm-05' } }
  const restart = async (target) => {
    restarts.push(target.vmId)
    return { ok: true }
  }
  const first = await recycleWrapIfIdle(exec, { now: 1_000, idleMs: WRAP_IDLE_RECYCLE_MS, restart })
  assert.equal(first.skipped, false)
  const fresh = await recycleWrapIfIdle(exec, { now: 60_000, idleMs: WRAP_IDLE_RECYCLE_MS, restart })
  assert.equal(fresh.skipped, true)
  assert.equal(fresh.reason, 'fresh')
  const stale = await recycleWrapIfIdle(exec, {
    now: 60_000 + WRAP_IDLE_RECYCLE_MS + 1,
    idleMs: WRAP_IDLE_RECYCLE_MS,
    restart,
  })
  assert.equal(stale.skipped, false)
  assert.deepEqual(restarts, ['vm-05', 'vm-05'])
  resetWrapRecycleState()
})

test('wrapSlotCount always pre-opens max native slots', () => {
  assert.equal(wrapSlotCount({}), WRAP_SLOT_MAX)
  assert.equal(wrapSlotCount({ policy: { maxConcurrency: 5 } }), WRAP_SLOT_MAX)
  assert.equal(wrapSlotCount({ policy: { maxConcurrency: 32 } }), WRAP_SLOT_MAX)
  assert.equal(wrapSlotCount({ policy: { maxConcurrency: 0 } }), WRAP_SLOT_MAX)
})

test('credentialsNewerThanKernel is true after host rotates the ticket', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cred-stale-'))
  const home = path.join(root, 'vms', 'vm-13', 'cli-home')
  const claude = path.join(home, '.claude')
  const run = path.join(root, 'vms', 'vm-13', 'run')
  fs.mkdirSync(claude, { recursive: true })
  fs.mkdirSync(run, { recursive: true })
  const sock = path.join(run, 'kernel.sock')
  const cred = path.join(claude, 'credentials.json')
  fs.writeFileSync(sock, '')
  fs.writeFileSync(cred, '{}')
  const past = new Date(Date.now() - 60_000)
  fs.utimesSync(sock, past, past)
  const exec = {
    homeDir: home,
    vm: { id: 'vm-13', runtime: { kernel_socket: sock } },
  }
  assert.equal(credentialsNewerThanKernel(exec), true)
  fs.utimesSync(cred, past, past)
  fs.utimesSync(sock, new Date(), new Date())
  assert.equal(credentialsNewerThanKernel(exec), false)
  fs.rmSync(root, { recursive: true, force: true })
})

test('wrapNewerThanKernel is true after wrap files replace a stale sock', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wrap-stale-'))
  const home = path.join(root, 'vms', 'vm-10', 'cli-home')
  const kin = path.join(home, '.kin')
  const run = path.join(root, 'vms', 'vm-10', 'run')
  fs.mkdirSync(kin, { recursive: true })
  fs.mkdirSync(run, { recursive: true })
  const sock = path.join(run, 'kernel.sock')
  fs.writeFileSync(sock, '')
  const past = new Date(Date.now() - 60_000)
  fs.utimesSync(sock, past, past)
  fs.writeFileSync(path.join(kin, 'kin-kernel.bin'), 'x')
  const exec = {
    homeDir: home,
    vm: { id: 'vm-10', runtime: { kernel_socket: sock } },
  }
  assert.equal(wrapNewerThanKernel(exec), true)
  fs.rmSync(sock)
  assert.equal(wrapNewerThanKernel(exec), false)
  fs.writeFileSync(sock, '')
  fs.utimesSync(sock, past, past)
  fs.utimesSync(path.join(kin, 'kin-kernel.bin'), past, past)
  fs.utimesSync(sock, new Date(), new Date())
  assert.equal(wrapNewerThanKernel(exec), false)
  fs.rmSync(root, { recursive: true, force: true })
})

test('writeKernelConfig cli-hop native slots ignore live 并行', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-cli-hop-slots-'))
  const written = writeKernelConfig(
    root,
    {
      id: 'vm-13',
      inference_engine: 'rust',
      policy: { maxConcurrency: 5 },
    },
    { token: 'tok', proxyUrl: 'socks5h://127.0.0.1:1080', proxyRequired: true },
  )
  const doc = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  assert.equal(doc.slots_per_worker, WRAP_SLOT_MAX)
  fs.rmSync(root, { recursive: true, force: true })
})

unixTest('Rust supervisor recycles when ready_slots stay at 0', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-wedged-'))
  const written = writeKernelConfig(root, { id: 'vm-wedged' }, { token: 'tok', proxyUrl: '', proxyRequired: false })
  const exec = {
    vmId: 'vm-wedged',
    homeDir: path.join(root, 'vms', 'vm-wedged', 'cli-home'),
    vm: {
      id: 'vm-wedged',
      runtime: { container: 'kin-wedged', kernel_socket: written.socketPath },
    },
  }
  let readySlots = 0
  let restarts = 0
  let server = null
  const serve = async () => {
    if (server) await new Promise((resolve) => server.close(resolve))
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, engine: 'rust', ready_slots: readySlots, worker_version: 'fixture' }))
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(written.socketPath, resolve)
    })
  }
  const runDockerExec = async (args) => {
    if (args[0] === 'inspect') return { ok: true, stdout: '/home/kincli/.kin/kin-kernel' }
    if (args[0] === 'restart' && args[1] === 'kin-wedged') {
      restarts += 1
      readySlots = 1
      await serve()
    }
    return { ok: true }
  }
  await serve()
  try {
    const ready = await ensureRustKernel(exec, { timeoutMs: 8000, runDockerExec })
    assert.equal(ready.ok, true, JSON.stringify(ready))
    assert.equal(restarts, 1)
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

unixTest('Rust supervisor does not recycle a busy CLI with ready_slots=0', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-busy-'))
  const written = writeKernelConfig(root, { id: 'vm-busy' }, { token: 'tok', proxyUrl: '', proxyRequired: false })
  const exec = {
    vmId: 'vm-busy',
    homeDir: path.join(root, 'vms', 'vm-busy', 'cli-home'),
    vm: {
      id: 'vm-busy',
      runtime: { container: 'kin-busy', kernel_socket: written.socketPath },
    },
  }
  let restarts = 0
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, engine: 'rust', ready_slots: 0, cli_pid: 4412, worker_version: 'fixture' }))
  })
  const runDockerExec = async (args) => {
    if (args[0] === 'inspect') return { ok: true, stdout: '/home/kincli/.kin/kin-kernel' }
    if (args[0] === 'restart') restarts += 1
    return { ok: true }
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(written.socketPath, resolve)
  })
  try {
    const ready = await ensureRustKernel(exec, { timeoutMs: 8000, runDockerExec })
    assert.equal(ready.ok, true, JSON.stringify(ready))
    assert.equal(ready.reason, 'busy')
    assert.equal(restarts, 0)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

unixTest('Rust supervisor launches the gateway worker with docker restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-container-'))
  const written = writeKernelConfig(root, { id: 'vm-container' }, { token: 'tok', proxyUrl: '', proxyRequired: false })
  const exec = {
    vmId: 'vm-container',
    homeDir: path.join(root, 'vms', 'vm-container', 'cli-home'),
    vm: {
      id: 'vm-container',
      runtime: { container: 'kin-container', kernel_socket: written.socketPath },
    },
  }
  let server = null
  const runDockerExec = async (args) => {
    if (args[0] === 'inspect') return { ok: true, stdout: '/home/kincli/.kin/kin-kernel' }
    if (args[0] === 'restart' && args[1] === 'kin-container') {
      server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, engine: 'rust', worker_version: 'fixture' }))
      })
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(written.socketPath, resolve)
      })
    }
    return { ok: true }
  }

  try {
    const ready = await ensureRustKernel(exec, { timeoutMs: 1000, runDockerExec })
    assert.equal(ready.ok, true, JSON.stringify(ready))
    assert.equal(ready.reason, 'started_in_vm')
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

unixTest('pid1 kernel already booting is not docker-restarted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-booting-'))
  const written = writeKernelConfig(root, { id: 'vm-booting' }, { token: 'tok', proxyUrl: '', proxyRequired: false })
  const exec = {
    vmId: 'vm-booting',
    homeDir: path.join(root, 'vms', 'vm-booting', 'cli-home'),
    vm: {
      id: 'vm-booting',
      runtime: { container: 'kin-booting', kernel_socket: written.socketPath },
    },
  }
  let restarts = 0
  let server = null
  const runDockerExec = async (args) => {
    if (args[0] === 'inspect') return { ok: true, stdout: '/home/kincli/.kin/kin-kernel' }
    if (args[0] === 'restart') {
      restarts += 1
      return { ok: true }
    }
    return { ok: true }
  }
  setTimeout(() => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, engine: 'rust', worker_version: 'fixture', ready_slots: 1 }))
    })
    server.listen(written.socketPath)
  }, 200)
  try {
    const ready = await ensureRustKernel(exec, { timeoutMs: 2000, runDockerExec })
    assert.equal(ready.ok, true, JSON.stringify(ready))
    assert.equal(restarts, 0)
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

unixTest('concurrent Rust ensures issue one docker restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-concurrent-'))
  const written = writeKernelConfig(root, { id: 'vm-concurrent' }, { token: 'tok', proxyUrl: '', proxyRequired: false })
  const exec = {
    vmId: 'vm-concurrent',
    homeDir: path.join(root, 'vms', 'vm-concurrent', 'cli-home'),
    vm: { id: 'vm-concurrent', runtime: { container: 'kin-concurrent', kernel_socket: written.socketPath } },
  }
  let starts = 0
  let server = null
  const runDockerExec = async (args) => {
    if (args[0] === 'inspect') return { ok: true, stdout: '/home/kincli/.kin/kin-kernel' }
    if (args[0] === 'restart' && args[1] === 'kin-concurrent') {
      starts += 1
      server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, engine: 'rust', worker_version: 'fixture' }))
      })
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(written.socketPath, resolve)
      })
    }
    return { ok: true }
  }

  try {
    const ready = await Promise.all([
      ensureRustKernel(exec, { timeoutMs: 1000, runDockerExec }),
      ensureRustKernel(exec, { timeoutMs: 1000, runDockerExec }),
    ])
    assert.equal(
      ready.every((result) => result.ok),
      true,
      JSON.stringify(ready),
    )
    assert.equal(starts, 1)
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

unixTest('Rust supervisor fails fast when kernel process never stays up', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-dead-'))
  const written = writeKernelConfig(root, { id: 'vm-dead' }, { token: 'tok', proxyUrl: '', proxyRequired: false })
  const exec = {
    vmId: 'vm-dead',
    homeDir: path.join(root, 'vms', 'vm-dead', 'cli-home'),
    vm: {
      id: 'vm-dead',
      runtime: { container: 'kin-dead', kernel_socket: written.socketPath },
    },
  }
  const calls = []
  const runDockerExec = async (args) => {
    calls.push(args)
    const joined = args.map(String).join(' ')
    if (joined.includes('pgrep') || args.includes('pidof')) return { ok: false, stdout: '' }
    return { ok: true }
  }
  const started = Date.now()
  try {
    const ready = await ensureRustKernel(exec, { timeoutMs: 5000, runDockerExec })
    assert.equal(ready.ok, false, JSON.stringify(ready))
    assert.equal(ready.reason, 'start_failed')
    assert.ok(Date.now() - started < 3500)
    assert.ok(calls.some((args) => args.map(String).join(' ').includes('pgrep') || args.includes('pidof')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('writeKernelConfig gates local upstream endpoints behind test mode', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-test-endpoint-cfg-'))
  const previous = {
    enabled: process.env.KIN_KERNEL_TEST_ENDPOINTS,
    anthropic: process.env.KIN_ANTHROPIC_BASE_URL,
    oauth: process.env.KIN_OAUTH_TOKEN_URL,
  }
  process.env.KIN_KERNEL_TEST_ENDPOINTS = '1'
  process.env.KIN_ANTHROPIC_BASE_URL = 'http://127.0.0.1:19091'
  process.env.KIN_OAUTH_TOKEN_URL = 'http://127.0.0.1:19091/v1/oauth/token'
  try {
    const written = writeKernelConfig(root, { id: 'vm-10' }, { token: 'tok', proxyUrl: '', proxyRequired: false })
    const doc = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
    assert.equal(doc.test_endpoints, true)
    assert.equal(doc.anthropic_base_url, 'http://127.0.0.1:19091')
    assert.equal(doc.oauth_token_url, 'http://127.0.0.1:19091/v1/oauth/token')
  } finally {
    if (previous.enabled == null) delete process.env.KIN_KERNEL_TEST_ENDPOINTS
    else process.env.KIN_KERNEL_TEST_ENDPOINTS = previous.enabled
    if (previous.anthropic == null) delete process.env.KIN_ANTHROPIC_BASE_URL
    else process.env.KIN_ANTHROPIC_BASE_URL = previous.anthropic
    if (previous.oauth == null) delete process.env.KIN_OAUTH_TOKEN_URL
    else process.env.KIN_OAUTH_TOKEN_URL = previous.oauth
    fs.rmSync(root, { recursive: true, force: true })
  }
})
