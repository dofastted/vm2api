import test, { mock } from 'node:test'
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
  restartRustKernel,
  writeKernelConfig,
  syncClaudeKernelConfigs,
  syncClaudeKernelConfigsFromFile,
  reconcileCliHopRuntime,
  wrapSlotCount,
  wrapNewerThanKernel,
  WRAP_SLOT_MAX,
  WRAP_IDLE_RECYCLE_MS,
  scheduleWrapRecycle,
  recycleWrapIfIdle,
  resetWrapRecycleState,
  beginWrapHop,
  endWrapHop,
  requestKernelReloadWhenIdle,
} from '../../src/lib/transport/rust-kernel-supervisor.mjs'
import { rustKernelPaths, isNeedsRefreshResult } from '../../src/lib/transport/rust-kernel-client.mjs'
import { OFFICIAL_CLI_VERSION } from '../../src/lib/identity/vm-identity.mjs'
import { resetModelPolicy, saveModelPolicy } from '../../src/lib/protocol/model-policy.mjs'
import { slotRuntimeOwner } from '../../src/lib/oauth/oauth-credentials.mjs'
import { closeDatabase, openDatabase } from '../../src/lib/db/database.mjs'
import { socksUidFor } from '../../src/lib/vm/vm-runtime.mjs'
import { REMOTE_CRAG_ENTRY } from '../../src/lib/vm/slot-engine.mjs'
import { kvmCragAppArmorCommand } from '../../src/lib/vm/kvm-crag-apparmor.mjs'

const unix = process.platform !== 'win32'
const unixTest = unix ? test : test.skip

function kernelInspectResult(path = '/home/kincli/.kin/kin-kernel', args = null) {
  return { ok: true, stdout: `${JSON.stringify(path)}\n${JSON.stringify(args)}` }
}

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

const cragCapabilities = ['prompt_append', 'prompt_replace', 'model_directive', 'caller_cwd']
const cragHealth = (capabilities) => ({ ok: true, runtime_variant: 'crag-v2', ready_slots: 1, capabilities })

function cragHopBody(mode) {
  return {
    model: 'claude-haiku-4-5',
    messages: [{ role: 'user', content: 'hi' }],
    crag_prompt: { mode, text: 'prepared caller guidance' },
    crag_model: { id: 'caller-supplied-model' },
  }
}

async function readPostedEnvelope(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function respondToCragHop(res, stream) {
  if (stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-terminal-state': 'verified' })
    res.end(
      'data: {"type":"message_start","message":{"id":"msg_crag","type":"message","role":"assistant","content":[]}}\n\n' +
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"ok"}}\n\n' +
        'data: {"type":"message_stop"}\n\n',
    )
  } else {
    res.writeHead(200, { 'content-type': 'application/json', 'x-terminal-state': 'verified' })
    res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }))
  }
}

for (const [name, dispatch, stream] of [
  ['call', dispatchCallInference, false],
  ['stream', dispatchStreamInference, true],
]) {
  unixTest(`${name} dispatch gates each CRAG field on final readiness, not the scheduler snapshot`, async () => {
    const previous = process.env.KIN_KERNEL_BIN
    const posted = []
    const fx = await kernelFixture(async (req, res) => {
      posted.push({ url: req.url, token: req.headers['x-kin-internal-token'], envelope: await readPostedEnvelope(req) })
      respondToCragHop(res, stream)
    })
    process.env.KIN_KERNEL_BIN = '/bin/true'
    const callerCwd = '/synthetic/router-workspace'
    try {
      for (const mode of ['append', 'replace']) {
        const body = cragHopBody(mode)
        for (const capabilities of [[], ...cragCapabilities.map((cap) => [cap]), cragCapabilities]) {
          const label = `${mode}: ${capabilities.join(', ') || 'no capabilities'}`
          const stale = cragHealth(cragCapabilities.filter((cap) => !capabilities.includes(cap)))
          const result = await dispatch({
            exec: { ...fx.exec, workerStatus: stale },
            body: { ...body, stream },
            callerCwd,
            cliHop: true,
            routing: { inference: { engine: 'rust' } },
            ensureRust: async () => ({ ok: true, health: cragHealth(capabilities) }),
            timeoutMs: 3000,
          })
          assert.equal(result.engine, 'rust', label)
          assert.equal(result.ok, true, label)
          assert.equal(posted.length, 1, label)
          const { url, token, envelope } = posted.pop()
          assert.equal(url, '/internal/v1/messages', label)
          assert.equal(token, 'internal-test', label)
          assert.equal(envelope.stream, stream, label)
          assert.deepEqual(
            envelope.body.crag_prompt,
            capabilities.includes(`prompt_${mode}`) ? body.crag_prompt : undefined,
            label,
          )
          assert.equal(
            envelope.body.crag_model?.id,
            capabilities.includes('model_directive') ? 'claude-haiku-4-5-20251001' : undefined,
            label,
          )
          assert.equal(Object.hasOwn(envelope, 'caller_cwd'), capabilities.includes('caller_cwd'), label)
          if (capabilities.includes('caller_cwd')) assert.equal(envelope.caller_cwd, callerCwd, label)
          assert.equal(Object.hasOwn(envelope.body, 'caller_cwd'), false, label)
          assert.equal(JSON.stringify(envelope.body).includes(callerCwd), false, label)
        }
      }
    } finally {
      if (previous == null) delete process.env.KIN_KERNEL_BIN
      else process.env.KIN_KERNEL_BIN = previous
      await fx.close()
    }
  })
}

unixTest('transport and credential retries preserve the readiness-gated CRAG envelope', async () => {
  const previous = process.env.KIN_KERNEL_BIN
  const posted = []
  const fx = await kernelFixture(async (req, res) => {
    posted.push(await readPostedEnvelope(req))
    if (posted.length === 1) {
      res.destroy()
      return
    }
    if (posted.length === 2) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { code: 'needs_refresh', message: 'credential needs refresh' } }))
      return
    }
    respondToCragHop(res, false)
  })
  process.env.KIN_KERNEL_BIN = '/bin/true'
  const callerCwd = '/synthetic/retry-workspace'
  const body = cragHopBody('replace')
  let readyChecks = 0
  let credentialEnsures = 0
  try {
    const result = await dispatchCallInference({
      exec: { ...fx.exec, workerStatus: cragHealth(['prompt_append', 'model_directive']) },
      body,
      callerCwd,
      cliHop: true,
      routing: { inference: { engine: 'rust' } },
      ensureRust: async () => {
        readyChecks++
        return { ok: true, health: cragHealth(['prompt_replace', 'caller_cwd']) }
      },
      ensureCredential: async (_exec, { force }) => {
        credentialEnsures++
        assert.equal(force, true)
        return { ok: true }
      },
      timeoutMs: 3000,
    })
    assert.equal(result.ok, true)
    assert.equal(result.credential_retried, true)
    assert.equal(readyChecks, 1)
    assert.equal(credentialEnsures, 1)
    assert.equal(posted.length, 3)
    const comparable = posted.map(({ request_id: _id, ...envelope }) => envelope)
    assert.deepEqual(comparable[1], comparable[0], 'transport retry')
    assert.deepEqual(comparable[2], comparable[0], 'credential retry')
    assert.equal(comparable[0].caller_cwd, callerCwd)
    assert.deepEqual(comparable[0].body.crag_prompt, body.crag_prompt)
    assert.equal(Object.hasOwn(comparable[0].body, 'crag_model'), false)
    assert.equal(Object.hasOwn(comparable[0].body, 'caller_cwd'), false)
    assert.equal(JSON.stringify(comparable[0].body).includes(callerCwd), false)
  } finally {
    if (previous == null) delete process.env.KIN_KERNEL_BIN
    else process.env.KIN_KERNEL_BIN = previous
    await fx.close()
  }
})

unixTest('managed CRAG retries consume the original queue deadline', async (t) => {
  const previous = process.env.KIN_KERNEL_BIN
  const posted = []
  const tenantId = 'a'.repeat(64)
  const startedAt = Date.now()
  let now = startedAt
  t.mock.method(Date, 'now', () => now)
  const fx = await kernelFixture(async (req, res) => {
    posted.push({ path: req.url, headers: req.headers, envelope: await readPostedEnvelope(req) })
    if (posted.length === 1) {
      now += 300
      res.destroy()
    } else if (posted.length === 2) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { code: 'needs_refresh', message: 'credential needs refresh' } }))
    } else {
      // JSON headers arrive after the first-byte budget, as they can on native CRAG.
      await new Promise((resolve) => setTimeout(resolve, 20))
      respondToCragHop(res, false)
    }
  })
  process.env.KIN_KERNEL_BIN = '/bin/true'
  try {
    const result = await dispatchCallInference({
      exec: { ...fx.exec, workerStatus: cragHealth([]) },
      envelope: {
        body: { ...cragHopBody('append'), gateway_policy: { queue_wait_ms: 5000 } },
        headers: { 'X-Tenant-ID': 'prebuilt-tenant' },
        gateway_policy: { queue_wait_ms: 5000 },
      },
      reqHeaders: { 'x-tenant-id': 'inbound-tenant' },
      routing: { inference: { engine: 'rust', session_idle_ttl_seconds: 75 } },
      tenantId,
      slotWaitMs: 1000,
      slotWaitDeadlineMs: startedAt + 1000,
      timeoutMs: 1,
      idleTimeoutMs: 25_000.4,
      ensureRust: async () => {
        now += 200
        return { ok: true, health: { ...cragHealth([]), gateway_policy_v1: true } }
      },
      ensureCredential: async () => {
        now += 600
        return { ok: true }
      },
    })
    assert.equal(result.ok, true)
    assert.equal(result.credential_retried, true)
    assert.equal(posted.length, 3)
    for (const [i, hop] of posted.entries()) {
      assert.equal(hop.path, '/internal/v1/messages')
      assert.equal(hop.headers['x-kin-internal-token'], 'internal-test')
      assert.equal(hop.headers['x-tenant-id'], tenantId)
      assert.equal(Object.hasOwn(hop.envelope.body, 'gateway_policy'), false)
      assert.equal(Object.hasOwn(hop.envelope.headers, 'X-Tenant-ID'), false)
      assert.deepEqual(hop.envelope.gateway_policy, {
        queue_wait_ms: [800, 500, 0][i],
        first_byte_timeout_ms: 1,
        stream_idle_timeout_ms: 25_000,
        session_idle_ttl_seconds: 75,
      })
    }
  } finally {
    if (previous == null) delete process.env.KIN_KERNEL_BIN
    else process.env.KIN_KERNEL_BIN = previous
    await fx.close()
  }
})

unixTest('only exact managed queue errors become local slot rejections', async () => {
  const previous = process.env.KIN_KERNEL_BIN
  const native = { ...cragHealth([]), gateway_policy_v1: true, ready: true, ready_slots: 0 }
  const legacy = cragHealth([])
  const replies = [
    { status: 503, type: 'overloaded_error', message: 'runtime queue is full', busy: true },
    { status: 504, type: 'timeout_error', message: 'runtime queue timeout', busy: true },
    { status: 504, type: 'timeout_error', message: 'upstream first byte timeout' },
    { status: 504, type: 'timeout_error', message: 'runtime queue timeout', legacy: true },
  ]
  let health = native
  const posted = []
  const fx = await kernelFixture(async (req, res) => {
    if (req.url === '/internal/health') {
      res.end(JSON.stringify(health))
      return
    }
    const reply = replies[posted.length]
    posted.push({ headers: req.headers, envelope: await readPostedEnvelope(req) })
    await new Promise((resolve) => setTimeout(resolve, 20))
    res.writeHead(reply.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: reply.type, message: reply.message } }))
  })
  process.env.KIN_KERNEL_BIN = '/bin/true'
  try {
    for (const [i, reply] of replies.entries()) {
      health = reply.legacy ? legacy : native
      const dispatch = i === 0 ? dispatchCallInference : dispatchStreamInference
      const result = await dispatch({
        exec: { ...fx.exec, workerStatus: reply.legacy ? native : legacy },
        body: { ...cragHopBody('append'), gateway_policy: { queue_wait_ms: 5000 } },
        reqHeaders: { 'x-tenant-id': 'inbound-tenant' },
        routing: { inference: { engine: 'rust', health_ttl_ms: 0 } },
        deliveryMode: 'verified',
        slotWaitDeadlineMs: Date.now(),
        timeoutMs: reply.legacy ? 3000 : 1,
      })
      assert.equal(result.status, reply.status)
      assert.equal(result.body.error.code, reply.busy ? 'slot_busy' : undefined)
      assert.equal(result.upstreamExecutions, reply.busy ? 0 : undefined)
      if (reply.busy) assert.equal(result.terminalState, 'rejected')
      assert.equal(posted[i].envelope.gateway_policy?.queue_wait_ms, reply.legacy ? undefined : 0)
      assert.equal(Object.hasOwn(posted[i].envelope.body, 'gateway_policy'), false)
      assert.equal(posted[i].headers['x-tenant-id'], undefined)
    }
    assert.equal(posted.length, replies.length)
  } finally {
    clearRustHealthCache(fx.exec.vmId)
    if (previous == null) delete process.env.KIN_KERNEL_BIN
    else process.env.KIN_KERNEL_BIN = previous
    await fx.close()
  }
})

unixTest('recovering native worker does not poll beyond the original slot budget', async () => {
  const previous = process.env.KIN_KERNEL_BIN
  let probes = 0
  const fx = await kernelFixture((req, res) => {
    assert.equal(req.url, '/internal/health')
    probes++
    res.end(JSON.stringify({ ...cragHealth([]), gateway_policy_v1: true, recovering: true, ready_slots: 0 }))
  })
  process.env.KIN_KERNEL_BIN = '/bin/true'
  try {
    const result = await dispatchCallInference({
      exec: fx.exec,
      body: cragHopBody('append'),
      routing: { inference: { engine: 'rust', health_ttl_ms: 0 } },
      slotWaitMs: 1000,
      slotWaitDeadlineMs: Date.now() - 1,
    })
    assert.equal(result.body.error.code, 'slot_busy')
    assert.equal(probes, 1)
  } finally {
    if (previous == null) delete process.env.KIN_KERNEL_BIN
    else process.env.KIN_KERNEL_BIN = previous
    await fx.close()
  }
})

unixTest('managed timeout SSE remains a timeout before and after downstream commit', async () => {
  const previous = process.env.KIN_KERNEL_BIN
  let visible = false
  const fx = await kernelFixture(async (req, res) => {
    await readPostedEnvelope(req)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"type":"message_start","message":{"content":[]}}\n\n')
    if (visible)
      res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n')
    res.end('data: {"type":"error","error":{"type":"timeout_error","message":"request timed out"}}\n\n')
  })
  process.env.KIN_KERNEL_BIN = '/bin/true'
  try {
    const dispatch = () =>
      dispatchStreamInference({
        exec: fx.exec,
        body: cragHopBody('append'),
        routing: { inference: { engine: 'rust' } },
        timeoutMs: 3000,
        ensureRust: async () => ({ ok: true, health: { ...cragHealth([]), gateway_policy_v1: true } }),
      })
    const uncommitted = await dispatch()
    assert.equal(uncommitted.committed, false)
    assert.equal(uncommitted.status, 504)
    assert.equal(uncommitted.terminalState, 'rejected')
    assert.equal(uncommitted.body.error.type, 'timeout_error')
    visible = true
    const committed = await dispatch()
    assert.equal(committed.committed, true)
    assert.equal(committed.status, 200)
    assert.equal(committed.terminalState, 'incomplete')
    assert.equal(committed.body.error.type, 'timeout_error')
  } finally {
    if (previous == null) delete process.env.KIN_KERNEL_BIN
    else process.env.KIN_KERNEL_BIN = previous
    await fx.close()
  }
})

unixTest('managed realtime header timeout is not replayed', async (t) => {
  const previous = process.env.KIN_KERNEL_BIN
  let posts = 0
  let expireHeaderTimer
  const fx = await kernelFixture(async (req, res) => {
    await readPostedEnvelope(req)
    posts++
    if (expireHeaderTimer) expireHeaderTimer()
    else respondToCragHop(res, true)
  })
  process.env.KIN_KERNEL_BIN = '/bin/true'
  const schedule = globalThis.setTimeout
  const headerTimers = t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    if (ms === 5001) expireHeaderTimer = fn
    return schedule(fn, ms, ...args)
  })
  try {
    const result = await dispatchStreamInference({
      exec: fx.exec,
      body: cragHopBody('append'),
      routing: { inference: { engine: 'rust' } },
      slotWaitDeadlineMs: Date.now(),
      timeoutMs: 1,
      ensureRust: async () => ({ ok: true, health: { ...cragHealth([]), gateway_policy_v1: true } }),
    })
    assert.equal(result.body.error.code, 'worker_timeout')
    assert.equal(result.rust_transport_retried, undefined)
    assert.equal(headerTimers.mock.calls.filter(({ arguments: [, ms] }) => ms === 5001).length, 1)
    assert.equal(posts, 1)
  } finally {
    if (previous == null) delete process.env.KIN_KERNEL_BIN
    else process.env.KIN_KERNEL_BIN = previous
    await fx.close()
  }
})

unixTest('dispatchStreamInference uses rust socket when ready', async () => {
  const prev = process.env.KIN_KERNEL_BIN
  process.env.KIN_KERNEL_BIN = '/bin/true'
  const fx = await kernelFixture((req, res) => {
    assert.equal(req.headers['x-internal-token'], 'internal-test')
    assert.equal(req.headers['x-kin-internal-token'], 'internal-test')
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      trailer: 'x-usage, x-stop-reason',
      'x-terminal-state': 'verified',
      'x-model': 'claude-haiku-4-5-20251001',
    })
    res.write('event: message_start\n')
    res.write('data: {"type":"message_start","message":{"type":"message","role":"assistant","content":[]}}\n\n')
    res.write('event: content_block_start\n')
    res.write('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"ok"}}\n\n')
    res.write('event: message_stop\n')
    res.write('data: {"type":"message_stop"}\n\n')
    res.addTrailers({
      'x-usage': JSON.stringify({
        input_tokens: 12,
        output_tokens: 4,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 5,
        cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 3 },
      }),
      'x-stop-reason': 'end_turn',
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
  let recycles = 0
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
    res.writeHead(200, { 'content-type': 'application/json', 'x-terminal-state': 'verified' })
    res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [] }))
  })
  try {
    const result = await dispatchCallInference({
      exec: fx.exec,
      body: { model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'hi' }] },
      routing: { inference: { engine: 'rust' } },
      ensureRust: async () => ({ ok: true }),
      recycleWrap: () => {
        recycles += 1
      },
      ensureCredential: async (_exec, opts = {}) => {
        ensures += 1
        assert.equal(opts.force, true)
        return { ok: true }
      },
    })
    assert.equal(hits, 2)
    assert.equal(ensures, 1)
    assert.equal(recycles, 0, 'the CLI reads refreshed credentials without recycling sibling requests')
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
      'x-terminal-state': 'verified',
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

unixTest('streamed plan-limit error is a response, not a dead slot: no recycle', async () => {
  const previous = process.env.KIN_KERNEL_BIN
  process.env.KIN_KERNEL_BIN = '/bin/true'
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-limit-'))
  const runDir = path.join(root, 'vm-01', 'run')
  const homeDir = path.join(root, 'vm-01', 'cli-home')
  fs.mkdirSync(runDir, { recursive: true })
  fs.mkdirSync(homeDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'internal.token'), 'internal-test\n', { mode: 0o600 })
  const kernelSocket = path.join(runDir, 'kernel.sock')
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"provider error: You\'ve hit your limit · resets 11am (UTC)"}}\n\n',
    )
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
      routing: { inference: { engine: 'rust' } },
      ensureRust: async () => ({ ok: true, reason: 'already_up' }),
      recycleWrap: (target) => {
        recycled.push(target?.vmId)
        return { ok: true, skipped: false }
      },
      timeoutMs: 3000,
    })
    assert.equal(result.status, 429)
    assert.equal(result.committed, false)
    assert.deepEqual(recycled, [])
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
    if (previous == null) delete process.env.KIN_KERNEL_BIN
    else process.env.KIN_KERNEL_BIN = previous
  }
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
    assert.equal(result.committed, false)
    assert.equal(result.transportError, true)
    assert.deepEqual(recycled, [], 'request failures leave recovery to the bounded watchdog')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
    if (previous == null) delete process.env.KIN_KERNEL_BIN
    else process.env.KIN_KERNEL_BIN = previous
  }
})

unixTest('a failed sibling hop cannot bypass watchdog recovery after other hops finish', async () => {
  resetWrapRecycleState()
  const previous = process.env.KIN_KERNEL_BIN
  process.env.KIN_KERNEL_BIN = '/bin/true'
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-sibling-'))
  const runDir = path.join(root, 'vm-02', 'run')
  const homeDir = path.join(root, 'vm-02', 'cli-home')
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
    vmId: 'vm-02',
    homeDir,
    vm: {
      id: 'vm-02',
      inference_engine: 'rust',
      runtime: {
        kernel_socket: kernelSocket,
        worker_socket: path.join(runDir, 'worker.sock'),
        worker_run_dir: runDir,
        worker_token_file: path.join(runDir, 'internal.token'),
      },
    },
  }
  beginWrapHop(exec)
  const recycled = []
  try {
    await dispatchStreamInference({
      exec,
      body: { model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'hi' }] },
      routing: { inference: { engine: 'rust' } },
      ensureRust: async () => ({ ok: true, reason: 'already_up' }),
      recycleWrap: (target) => {
        recycled.push(target?.vmId)
        return { ok: true, skipped: false }
      },
      timeoutMs: 3000,
    })
    assert.deepEqual(recycled, [])
    endWrapHop(exec)
    assert.deepEqual(recycled, [], 'ending the sibling does not trigger a request-side restart')
  } finally {
    endWrapHop(exec)
    resetWrapRecycleState()
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
  assert.equal(doc.default_cache_ttl, '1h')
  assert.equal(doc.thinking_display, 'summarized')
  assert.equal(doc.auto_compact_window, null)
  assert.match(written.socketPath.replace(/\\/g, '/'), /vms\/vm-09\/run\/kernel\.sock$/)
  assert.equal(fs.readFileSync(written.tokenPath, 'utf8').trim(), 'tok')
  const exec = { vmId: 'vm-09', homeDir: path.join(root, 'vms', 'vm-09', 'cli-home'), vm: { id: 'vm-09' } }
  assert.equal(rustKernelPaths(exec).socketPath, written.socketPath)
  fs.rmSync(root, { recursive: true, force: true })
})

test('writeKernelConfig projects thinking display and preserves it only without routing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-thinking-cfg-'))
  const vm = { id: 'vm-09' }
  const displayOf = (options = {}) => {
    const written = writeKernelConfig(root, vm, { token: 'tok', ...options })
    return JSON.parse(fs.readFileSync(written.configPath, 'utf8')).thinking_display
  }
  try {
    assert.equal(displayOf(), 'summarized')
    assert.equal(displayOf({ routing: { compatibility: { thinking_display: 'passthrough' } } }), 'passthrough')
    assert.equal(displayOf(), 'passthrough')
    assert.equal(displayOf({ routing: {} }), 'summarized')
    assert.equal(displayOf({ routing: { compatibility: { thinking_display: 'invalid' } } }), 'summarized')
    assert.equal(displayOf(), 'summarized')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('model effort changes rewrite kernel.json without a routing save or restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-effort-'))
  const routing = { compatibility: { persona_preset: 'official' } }
  const vm = { id: 'vm-09' }
  const configPath = path.join(root, 'vms', 'vm-09', 'run', 'kernel.json')
  const read = () => JSON.parse(fs.readFileSync(configPath, 'utf8'))
  openDatabase({ dbPath: ':memory:' })
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', 'vm-09.json'), JSON.stringify({ id: 'vm-09', status: 'running' }))
  try {
    saveModelPolicy({
      models: { 'claude-haiku-5-5': { params: { default_effort: 'high' } } },
    })
    writeKernelConfig(root, vm, { token: 'tok', routing })
    assert.equal(read().model_effort['claude-haiku-5-5'], 'high')
    const before = fs.statSync(configPath).mtimeMs
    saveModelPolicy({
      models: { 'claude-haiku-5-5': { params: { default_effort: 'off' } } },
    })
    const synced = syncClaudeKernelConfigs(root, routing)
    assert.equal(synced.updated, 1)
    assert.equal(read().model_effort['claude-haiku-5-5'], 'off')
    assert.ok(fs.statSync(configPath).mtimeMs >= before)
  } finally {
    resetModelPolicy()
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('writeKernelConfig idle timeout follows the panel stream idle timeout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-idle-cfg-'))
  const prev = process.env.KIN_STREAM_IDLE_TIMEOUT
  const idleOf = (opts) =>
    JSON.parse(fs.readFileSync(writeKernelConfig(root, { id: 'vm-09' }, { token: 'tok', ...opts }).configPath, 'utf8'))
      .idle_timeout_seconds
  try {
    delete process.env.KIN_STREAM_IDLE_TIMEOUT
    // Default stays 180s; the panel raises it when needed.
    assert.equal(idleOf({ routing: {} }), 180)
    process.env.KIN_STREAM_IDLE_TIMEOUT = '900000'
    assert.equal(idleOf({ routing: {} }), 900)
    // Panel value wins over env and is clamped to 30s..60min.
    assert.equal(idleOf({ routing: { failover: { stream_idle_timeout_ms: 1_200_000 } } }), 1200)
    assert.equal(idleOf({ routing: { failover: { stream_idle_timeout_ms: 5000 } } }), 30)
    assert.equal(idleOf({ routing: { failover: { stream_idle_timeout_ms: 99_999_999 } } }), 3600)
    // Partial callers without routing keep the last written value.
    idleOf({ routing: { failover: { stream_idle_timeout_ms: 1_200_000 } } })
    assert.equal(idleOf({}), 1200)
  } finally {
    if (prev === undefined) delete process.env.KIN_STREAM_IDLE_TIMEOUT
    else process.env.KIN_STREAM_IDLE_TIMEOUT = prev
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('writeKernelConfig request bytes follow the panel body limit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-body-cfg-'))
  const bytesOf = (opts) =>
    JSON.parse(fs.readFileSync(writeKernelConfig(root, { id: 'vm-09' }, { token: 'tok', ...opts }).configPath, 'utf8'))
      .max_request_bytes
  try {
    assert.equal(bytesOf({ routing: {} }), 32 * 1024 * 1024)
    assert.equal(bytesOf({ routing: { failover: { max_request_mib: 64 } } }), 64 * 1024 * 1024)
    assert.equal(bytesOf({ routing: { failover: { max_request_mib: 1 } } }), 8 * 1024 * 1024)
    bytesOf({ routing: { failover: { max_request_mib: 64 } } })
    assert.equal(bytesOf({}), 64 * 1024 * 1024)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
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
      routing: { compatibility: { cache_ttl: '5m' } },
    },
  )
  const doc = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  const raw = fs.readFileSync(written.configPath, 'utf8')
  assert.equal(doc.provider, 'local_cli')
  assert.equal(doc.claude_bin, '/home/kincli/.kin/cli-node')
  assert.equal(doc.https_proxy, undefined)
  assert.equal(doc.slots_per_worker, WRAP_SLOT_MAX)
  assert.equal(doc.system_layout, 'identity')
  assert.equal(doc.cli_version, OFFICIAL_CLI_VERSION)
  assert.equal(doc.default_cache_ttl, '5m')
  assert.equal(doc.auto_compact_window, null)
  assert.equal(doc.timezone, 'America/New_York')
  assert.equal(doc.proxy_url, '')
  assert.equal(doc.proxy_required, false)
  assert.doesNotMatch(raw, /sk-ant-|oat01|password=/i)
  fs.rmSync(root, { recursive: true, force: true })
})

test('writeKernelConfig points cc at cc-node and crag at native Claude', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-cc-cfg-'))
  try {
    const cc = JSON.parse(
      fs.readFileSync(writeKernelConfig(root, { id: 'vm-09', dataplane: 'cc' }, { token: 'tok' }).configPath, 'utf8'),
    )
    assert.equal(cc.dataplane, 'cc')
    assert.equal(cc.claude_bin, '/home/kincli/.kin/cc-node')
    const crag = JSON.parse(
      fs.readFileSync(writeKernelConfig(root, { id: 'vm-09', dataplane: 'crag' }, { token: 'tok' }).configPath, 'utf8'),
    )
    assert.equal(crag.dataplane, 'crag')
    assert.equal(crag.claude_bin, '/home/kincli/.kin/crag-v2/claude-code-2.1.321/claude')
    assert.equal(crag.crag_kernel_version, 'v2')
    assert.equal(crag.runtime_variant, 'crag-v2')
    const wrap = JSON.parse(
      fs.readFileSync(writeKernelConfig(root, { id: 'vm-09', dataplane: 'wrap' }, { token: 'tok' }).configPath, 'utf8'),
    )
    assert.equal(wrap.dataplane, 'wrap')
    assert.equal(wrap.claude_bin, '/home/kincli/.kin/cli-node')
    assert.equal(wrap.crag_kernel_version, undefined)
    assert.equal(wrap.runtime_variant, undefined)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('writeKernelConfig adds CRAG v2 fields for a local slot and a cluster Docker slot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-crag-v2-cfg-'))
  try {
    const legacy = JSON.parse(
      fs.readFileSync(writeKernelConfig(root, { id: 'vm-09', dataplane: 'crag' }, { token: 'tok' }).configPath, 'utf8'),
    )
    assert.equal(legacy.claude_bin, '/home/kincli/.kin/crag-v2/claude-code-2.1.321/claude')
    assert.equal(legacy.crag_kernel_version, 'v2')
    assert.equal(legacy.runtime_variant, 'crag-v2')
    assert.equal(legacy.license_dir, '/run/kin/crag-license')
    const v2 = JSON.parse(
      fs.readFileSync(
        writeKernelConfig(root, { id: 'vm-09', dataplane: 'crag', crag_kernel_version: 'v2' }, { token: 'tok' })
          .configPath,
        'utf8',
      ),
    )
    assert.equal(v2.dataplane, 'crag')
    assert.equal(v2.claude_bin, '/home/kincli/.kin/crag-v2/claude-code-2.1.321/claude')
    assert.equal(v2.crag_kernel_version, 'v2')
    assert.equal(v2.runtime_variant, 'crag-v2')
    assert.equal(v2.license_dir, '/run/kin/crag-license')
    assert.equal(v2.crag_v2_root, undefined)
    assert.equal(v2.node_bin, undefined)
    assert.equal(v2.telemetry.identity, undefined)
    const enabled = JSON.parse(
      fs.readFileSync(
        writeKernelConfig(
          root,
          {
            id: 'vm-09',
            dataplane: 'crag',
            crag_kernel_version: 'v2',
            kernel: 'ubuntu-24.04',
            seed_policy: { telemetry_disabled: false },
          },
          { token: 'tok' },
        ).configPath,
        'utf8',
      ),
    )
    assert.equal(enabled.telemetry.enabled, true)
    assert.equal(enabled.telemetry.dmi_dir, '/etc/kin-dmi')
    assert.equal(enabled.telemetry.identity.enabled, true)
    assert.equal(enabled.telemetry.identity.linux_distro_id, 'ubuntu')
    assert.equal(enabled.telemetry.identity.linux_distro_version, '24.04')
    assert.equal(enabled.telemetry.identity.linux_kernel, '6.8.0-51-generic')
    assert.equal(enabled.telemetry.identity.shell, '/bin/bash')
    assert.equal(enabled.telemetry.identity.terminal, 'xterm-256color')
    assert.equal(enabled.telemetry.identity.package_managers, 'apt')
    const remote = JSON.parse(
      fs.readFileSync(
        writeKernelConfig(
          root,
          { id: 'vm-09', dataplane: 'crag', crag_kernel_version: 'v2', node_id: 'node-1' },
          { token: 'tok' },
        ).configPath,
        'utf8',
      ),
    )
    assert.equal(remote.crag_kernel_version, 'v2')
    assert.equal(remote.runtime_variant, 'crag-v2')
    assert.equal(remote.claude_bin, '/opt/kin-live/crag-v2/claude-code-2.1.321/claude')
    assert.equal(remote.license_dir, '/run/kin/crag-license')
    assert.equal(remote.asset_dir, '/run/kin/crag-native-assets')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
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
  assert.equal(doc.persona_preset, 'official_full')
  fs.rmSync(root, { recursive: true, force: true })
})

test('writeKernelConfig uses identity when official_full has no persona_inject', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-preset-identity-'))
  const written = writeKernelConfig(
    root,
    { id: 'vm-05', inference_engine: 'rust' },
    { token: 'tok', routing: { compatibility: { persona_preset: 'official_full' } } },
  )
  const doc = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  assert.equal(doc.system_layout, 'identity')
  assert.equal(doc.persona_preset, 'official_full')
  const before = fs.statSync(written.configPath).mtimeMs
  const again = writeKernelConfig(
    root,
    { id: 'vm-05', inference_engine: 'rust' },
    { token: 'tok', routing: { compatibility: { persona_preset: 'official_full' } } },
  )
  assert.equal(again.changed, false)
  assert.equal(fs.statSync(written.configPath).mtimeMs, before)
  const zero = writeKernelConfig(
    root,
    { id: 'vm-05', inference_engine: 'rust', persona_preset: 'zero' },
    { token: 'tok', routing: { compatibility: { persona_preset: 'official_full' } } },
  )
  assert.equal(zero.changed, true)
  const overridden = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  assert.equal(overridden.persona_preset, 'zero')
  assert.equal(overridden.system_layout, 'zero')
})

test('kernel.json rename keeps the control-plane gid while adopting the slot uid', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-owner-'))
  const vm = { id: 'vm-10', inference_engine: 'rust' }
  const owner = slotRuntimeOwner(vm)
  const calls = []
  const chown = mock.method(fs, 'chownSync', (file, uid, gid) => {
    calls.push({ file, uid, gid })
  })
  const kernelOwned = () => calls.filter((call) => String(call.file).includes(`${path.sep}kernel.json`))
  try {
    assert.equal(owner.uid, Number(process.env.KIN_VM_UID_BASE || 10000) + 10)
    assert.equal(owner.gid, Number(process.env.KIN_VM_GID || 987))
    assert.equal(String(owner.uid), socksUidFor(vm))
    const zero = { compatibility: { persona_preset: 'zero', cache_ttl: '5m' } }
    const full = { compatibility: { persona_preset: 'official_full', cache_ttl: '5m' } }
    const first = writeKernelConfig(root, vm, { token: 'tok', routing: zero })
    assert.ok(
      calls.some((call) => call.file === first.tokenPath || String(call.file).startsWith(`${first.tokenPath}.`)),
    )
    calls.length = 0
    const changed = writeKernelConfig(root, vm, { token: 'tok', routing: full })
    assert.equal(changed.changed, true)
    const published = kernelOwned()
    const controlGid = process.getgid()
    assert.ok(published.length >= 1)
    assert.ok(
      published.every((call) => call.uid === owner.uid && call.gid === controlGid),
      JSON.stringify(published),
    )
    assert.ok(
      published.some(
        (call) => call.file !== changed.configPath && String(call.file).startsWith(`${changed.configPath}.`),
      ),
    )
    calls.length = 0
    const again = writeKernelConfig(root, vm, { token: 'tok', routing: full })
    assert.equal(again.changed, false)
    assert.equal(fs.readFileSync(again.configPath, 'utf8').includes('"persona_preset": "official_full'), true)
    assert.ok(
      kernelOwned().some((call) => call.file === again.configPath && call.uid === owner.uid && call.gid === controlGid),
    )
  } finally {
    chown.mock.restore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('named slot ids keep the shared runtime owner when kernel config is rewritten', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-named-owner-'))
  const vm = { id: 'loutish-arches-3gicloudcom' }
  const runDir = path.join(root, 'vms', vm.id, 'run')
  const owner = slotRuntimeOwner(vm)
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'worker.json'), '{"ok":true}\n', { mode: 0o644 })
  const calls = []
  const chown = mock.method(fs, 'chownSync', (file, uid, gid) => {
    calls.push({ file, uid, gid })
  })
  const getuid = mock.method(process, 'getuid', () => 0)
  try {
    writeKernelConfig(root, vm, { token: 'tok', routing: {} })
    const runOwned = calls.filter((call) => call.file === runDir)
    assert.equal(runOwned.length, 1)
    assert.equal(runOwned[0].uid, 10001)
    assert.equal(owner.uid, 10001)
    assert.notEqual(runOwned[0].uid, Number(process.env.KIN_VM_UID_BASE || 10000) + 3)
  } finally {
    getuid.mock.restore()
    chown.mock.restore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('routing.json mtime projects persona_preset into Claude kernel.json only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-persona-file-'))
  const vms = path.join(root, 'vms')
  fs.mkdirSync(vms, { recursive: true })
  fs.writeFileSync(path.join(vms, 'vm-claude.json'), JSON.stringify({ id: 'vm-claude', persona_preset: 'zero' }))
  fs.writeFileSync(
    path.join(vms, 'vm-codex.json'),
    JSON.stringify({ id: 'vm-codex', platform: 'openai', family: 'codex' }),
  )
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify({ compatibility: { persona_preset: 'official_full', cache_ttl: '1h' } }))
  try {
    const first = syncClaudeKernelConfigsFromFile(root, routingFile)
    assert.equal(first.updated, 1)
    const kernelPath = path.join(vms, 'vm-claude', 'run', 'kernel.json')
    const kernel = JSON.parse(fs.readFileSync(kernelPath, 'utf8'))
    assert.equal(kernel.persona_preset, 'zero')
    assert.equal(kernel.system_layout, 'zero')
    assert.equal(fs.existsSync(path.join(vms, 'vm-codex', 'run', 'kernel.json')), false)
    const repeat = syncClaudeKernelConfigsFromFile(root, routingFile)
    assert.equal(repeat.skipped, true)
    fs.writeFileSync(path.join(vms, 'vm-claude.json'), JSON.stringify({ id: 'vm-claude' }))
    fs.writeFileSync(routingFile, JSON.stringify({ compatibility: { persona_preset: 'official', cache_ttl: '1h' } }))
    fs.utimesSync(routingFile, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
    const next = syncClaudeKernelConfigsFromFile(root, routingFile)
    assert.equal(next.updated, 1)
    const followed = JSON.parse(fs.readFileSync(kernelPath, 'utf8'))
    assert.equal(followed.persona_preset, 'official')
    assert.equal(followed.system_layout, 'identity')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
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

test('requestKernelReloadWhenIdle restarts only once no job runs', async () => {
  resetWrapRecycleState()
  const exec = { vmId: 'vm-07', vm: { id: 'vm-07' } }
  const restarts = []
  const restart = async (target) => {
    restarts.push(target.vmId)
    return { ok: true }
  }
  const idle = { ok: true, ready_slots: WRAP_SLOT_MAX, closed_slots: 0 }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
  try {
    // Idle kernel: restart right away.
    let req = requestKernelReloadWhenIdle(exec, { restart, health: async () => idle })
    assert.deepEqual(await req.done, { ok: true })
    assert.deepEqual(restarts, ['vm-07'])

    // A job from another caller holds a slot: poll until it frees up.
    let status = { ok: true, ready_slots: WRAP_SLOT_MAX - 1, closed_slots: 0 }
    req = requestKernelReloadWhenIdle(exec, { restart, health: async () => status, pollMs: 10 })
    await tick()
    assert.deepEqual(restarts, ['vm-07'])
    status = idle
    // The poll timer is unref'd so a pending reload never holds the server open;
    // ref'd ticks keep this test's loop alive until it fires.
    for (let i = 0; i < 200 && restarts.length < 2; i++) await tick()
    await req.done
    assert.deepEqual(restarts, ['vm-07', 'vm-07'])

    // A hop in this process: wait for its end even if the kernel looks idle.
    beginWrapHop(exec)
    req = requestKernelReloadWhenIdle(exec, { restart, health: async () => idle, pollMs: 60_000 })
    await tick()
    assert.deepEqual(restarts, ['vm-07', 'vm-07'])
    endWrapHop(exec)
    await req.done
    assert.deepEqual(restarts, ['vm-07', 'vm-07', 'vm-07'])
  } finally {
    resetWrapRecycleState()
  }
})

test('wrapSlotCount always pre-opens max native slots', () => {
  assert.equal(wrapSlotCount({}), WRAP_SLOT_MAX)
  assert.equal(wrapSlotCount({ policy: { maxConcurrency: 5 } }), WRAP_SLOT_MAX)
  assert.equal(wrapSlotCount({ policy: { maxConcurrency: 32 } }), WRAP_SLOT_MAX)
  assert.equal(wrapSlotCount({ policy: { maxConcurrency: 0 } }), WRAP_SLOT_MAX)
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

for (const [preparation, mode] of [
  ['ready', 'restart'],
  ['failed', 'restart'],
  ['ssh-unavailable', 'restart'],
  ['ready', 'cold-boot'],
  ['failed', 'cold-boot'],
  ['ssh-unavailable', 'cold-boot'],
  ['ready', 'healthy'],
]) {
  unixTest(`KVM AppArmor preparation preserves the running kernel until ready: ${mode}/${preparation}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kvm-apparmor-restart-'))
    const id = `vm-apparmor-${mode}-${preparation}`
    const vm = { id, runtime: { type: 'kvm', container: `kin-${id}` } }
    const written = writeKernelConfig(root, vm, { token: 'tok', proxyUrl: '', proxyRequired: false })
    const exec = {
      vmId: id,
      homeDir: path.join(root, 'vms', id, 'cli-home'),
      vm: { ...vm, runtime: { ...vm.runtime, kernel_socket: written.socketPath } },
    }
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, engine: 'rust', ready_slots: 1, worker_version: 'fixture' }))
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(written.socketPath, resolve)
    })
    const calls = []
    const prepareCommand = kvmCragAppArmorCommand()
    let prepareAttempts = 0
    const runDockerExec = async (args) => {
      calls.push(args)
      if (args.includes(prepareCommand[2])) {
        prepareAttempts += 1
        if (preparation === 'failed') return { ok: false, error: 'fixture apparmor_parser refused the policy' }
        if (preparation === 'ssh-unavailable' && prepareAttempts <= 2) {
          return prepareAttempts === 1
            ? { ok: false, error: 'guest ssh unavailable' }
            : { ok: false, error: 'guest command failed', stderr: 'kin-guest-exec: guest ssh unavailable' }
        }
        return { ok: true }
      }
      return { ok: true }
    }
    try {
      const result =
        mode === 'restart'
          ? await restartRustKernel(exec, { timeoutMs: 2000, runDockerExec })
          : await ensureRustKernel(exec, {
              timeoutMs: 2000,
              runDockerExec,
              prepareGuestAppArmor: mode === 'cold-boot',
            })
      if (mode === 'healthy') {
        assert.equal(result.ok, true, JSON.stringify(result))
        assert.equal(result.reason, 'already_up')
        assert.deepEqual(
          calls.map((args) => args.slice(-3)),
          [['kill', '-CHLD', '1']],
          'routine health keeps only the existing zombie-reap action',
        )
        return
      }
      assert.deepEqual(calls[0].slice(-prepareCommand.length), prepareCommand)
      const guest = calls[0].indexOf('/usr/local/bin/kin-guest-exec')
      assert.ok(guest > 0)
      assert.ok(calls[0].slice(guest + 1).some((value, index, args) => value === '-u' && args[index + 1] === '0'))
      assert.equal(fs.existsSync(written.socketPath), true, 'a guest restart must preserve the host relay socket')
      if (preparation === 'failed' || (preparation === 'ssh-unavailable' && mode === 'restart')) {
        assert.equal(result.ok, false)
        assert.equal(result.reason, 'guest_apparmor_failed')
        assert.match(result.error, preparation === 'failed' ? /apparmor_parser refused/ : /guest ssh unavailable/)
        assert.equal(calls.length, 1, 'failed preparation must not retire, kill, or restart the running kernel')
      } else {
        assert.equal(result.ok, true, JSON.stringify(result))
        const restart = calls.findIndex((args) => args.includes('systemctl') && args.includes('restart'))
        assert.ok(restart > 0)
        const expectedAttempts = preparation === 'ssh-unavailable' ? 3 : 1
        assert.equal(calls.filter((args) => args.includes(prepareCommand[2])).length, expectedAttempts)
        assert.equal(
          calls.slice(0, expectedAttempts).every((args) => args.includes(prepareCommand[2])),
          true,
        )
        assert.equal(calls.filter((args) => args.includes('systemctl') && args.includes('restart')).length, 1)
        assert.equal(calls.filter((args) => String(args.at(-1)).includes('kill -KILL')).length, 1)
      }
    } finally {
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
}

for (const firstPrepares of [false, true]) {
  unixTest(
    `KVM AppArmor preparation coalesces behind a pending ${firstPrepares ? 'preparing' : 'ordinary'} ensure`,
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kvm-aa-pending-'))
      const id = `vm-aa-pending-${firstPrepares}`
      const vm = { id, runtime: { type: 'kvm', container: `kin-${id}` } }
      const written = writeKernelConfig(root, vm, { token: 'tok', proxyUrl: '', proxyRequired: false })
      const exec = {
        vmId: id,
        homeDir: path.join(root, 'vms', id, 'cli-home'),
        vm: { ...vm, runtime: { ...vm.runtime, kernel_socket: written.socketPath } },
      }
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, engine: 'rust', ready_slots: 1, worker_version: 'fixture' }))
      })
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(written.socketPath, resolve)
      })
      let observeFirst
      let releaseFirst
      const firstObserved = new Promise((resolve) => {
        observeFirst = resolve
      })
      const firstReleased = new Promise((resolve) => {
        releaseFirst = resolve
      })
      const calls = []
      const requests = []
      const prepareCommand = kvmCragAppArmorCommand()
      const runDockerExec = async (args) => {
        calls.push(args)
        if (calls.length === 1) {
          observeFirst()
          await firstReleased
        }
        return { ok: true }
      }
      try {
        requests.push(ensureRustKernel(exec, { timeoutMs: 2000, runDockerExec, prepareGuestAppArmor: firstPrepares }))
        await firstObserved
        requests.push(ensureRustKernel(exec, { timeoutMs: 2000, runDockerExec, prepareGuestAppArmor: true }))
        requests.push(ensureRustKernel(exec, { timeoutMs: 2000, runDockerExec, prepareGuestAppArmor: true }))
        releaseFirst()
        const results = await Promise.all(requests)
        assert.equal(
          results.every((result) => result.ok),
          true,
          JSON.stringify(results),
        )
        if (!firstPrepares) assert.equal(results[0].reason, 'already_up')
        assert.equal(results[1], results[2], 'concurrent preparation requests share the same completed start')
        assert.equal(calls.filter((args) => args.includes(prepareCommand[2])).length, 1)
        assert.equal(calls.filter((args) => args.includes('systemctl') && args.includes('restart')).length, 1)
      } finally {
        releaseFirst()
        await Promise.allSettled(requests)
        await new Promise((resolve) => server.close(resolve))
        fs.rmSync(root, { recursive: true, force: true })
      }
    },
  )
}

unixTest('Rust supervisor retires legacy telemetry without root docker exec', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-retire-user-'))
  const written = writeKernelConfig(
    root,
    { id: 'vm-retire-user' },
    { token: 'tok', proxyUrl: '', proxyRequired: false },
  )
  const exec = {
    vmId: 'vm-retire-user',
    homeDir: path.join(root, 'vms', 'vm-retire-user', 'cli-home'),
    vm: {
      id: 'vm-retire-user',
      runtime: { container: 'kin-retire-user', kernel_socket: written.socketPath },
    },
  }
  let readySlots = 0
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
  const execCalls = []
  const runDockerExec = async (args) => {
    execCalls.push(args)
    if (args[0] === 'inspect') return kernelInspectResult()
    if (args[0] === 'restart' && args[1] === 'kin-retire-user') {
      readySlots = 1
      await serve()
    }
    return { ok: true }
  }
  await serve()
  try {
    const ready = await ensureRustKernel(exec, { timeoutMs: 8000, runDockerExec })
    assert.equal(ready.ok, true, JSON.stringify(ready))
    const retireArgv = execCalls.find((args) => args[0] === 'exec' && args.includes('sh'))
    assert.ok(retireArgv, execCalls.map((args) => args.slice(0, 6)).join('\n'))
    assert.equal(retireArgv.includes('-u'), false)
    assert.equal(retireArgv[1], 'kin-retire-user')
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
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
    if (args[0] === 'inspect') return kernelInspectResult()
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
    if (args[0] === 'inspect') return kernelInspectResult()
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

unixTest('Rust supervisor honors a longer preflight timeout for a slow kernel response', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kernel-slow-remote-'))
  const vm = { id: 'vm-slow-remote' }
  const written = writeKernelConfig(root, vm, { token: 'tok', proxyUrl: '', proxyRequired: false })
  const homeDir = path.join(root, 'vms', vm.id, 'cli-home')
  const exec = {
    vmId: vm.id,
    homeDir,
    vm: {
      ...vm,
      runtime: { container: 'kin-slow-remote', kernel_socket: written.socketPath },
    },
  }
  const server = http.createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, engine: 'rust', ready_slots: 1, worker_version: 'fixture' }))
    }, 900)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(written.socketPath, resolve)
  })
  try {
    const ready = await ensureRustKernel(exec, {
      timeoutMs: 3000,
      healthTimeoutMs: 2000,
      runDockerExec: async () => ({ ok: true }),
    })
    assert.equal(ready.ok, true, JSON.stringify(ready))
    assert.equal(ready.reason, 'already_up')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

for (const state of ['idle', 'partly occupied', 'full']) {
  unixTest(`credential rotation does not restart the ${state} PID-1 kernel`, async () => {
    resetWrapRecycleState()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-ticket-live-'))
    const written = writeKernelConfig(root, { id: 'vm-ticket' }, { token: 'tok' })
    const homeDir = path.join(root, 'vms', 'vm-ticket', 'cli-home')
    const exec = {
      vmId: 'vm-ticket',
      homeDir,
      vm: { id: 'vm-ticket', runtime: { container: 'kin-ticket', kernel_socket: written.socketPath } },
    }
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({ ok: true, engine: 'rust', ready_slots: state === 'full' ? 0 : WRAP_SLOT_MAX, cli_pid: 4412 }),
      )
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(written.socketPath, resolve)
    })
    const past = new Date(Date.now() - 60_000)
    fs.utimesSync(written.socketPath, past, past)
    const socketMtime = fs.statSync(written.socketPath).mtimeMs
    fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(homeDir, '.claude', 'credentials.json'), '{}')
    if (state === 'partly occupied') beginWrapHop(exec)
    const commands = []
    const runDockerExec = async (args) => {
      commands.push(args)
      if (args[0] === 'inspect') return kernelInspectResult()
      if (args[0] === 'restart') return { ok: false, error: 'unexpected restart' }
      return { ok: true }
    }
    try {
      const ready = await ensureRustKernel(exec, { timeoutMs: 1000, runDockerExec })
      assert.equal(ready.ok, true, JSON.stringify(ready))
      assert.equal(ready.reason, state === 'idle' ? 'already_up' : 'busy')
      assert.equal(
        commands.some((args) => args[0] === 'restart' || args.some((arg) => arg.includes('kill -KILL'))),
        false,
      )
      assert.equal(fs.statSync(written.socketPath).mtimeMs, socketMtime)
    } finally {
      if (state === 'partly occupied') endWrapHop(exec)
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(root, { recursive: true, force: true })
      resetWrapRecycleState()
    }
  })
}

unixTest(
  'credential-free OAuth readiness does not require native telemetry or restart a live legacy kernel',
  async () => {
    const fx = await kernelFixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, engine: 'rust', ready_slots: 0, cli_pid: 4412 }))
    })
    try {
      fs.writeFileSync(rustKernelPaths(fx.exec).configPath, JSON.stringify({ slots_per_worker: WRAP_SLOT_MAX }))
      const commands = []
      const ready = await ensureRustKernel(fx.exec, {
        allowMissingCredential: true,
        timeoutMs: 100,
        runDockerExec: async (args) => {
          commands.push(args)
          return { ok: true }
        },
      })
      assert.equal(ready.ok, true, JSON.stringify(ready))
      assert.equal(ready.reason, 'already_up')
      assert.equal(
        commands.some((args) => args[0] === 'restart'),
        false,
      )
    } finally {
      await fx.close()
    }
  },
)

unixTest('supervisor repairs a Max subscription from a VM summary without restarting the live kernel', async () => {
  const fx = await kernelFixture((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, engine: 'rust', ready_slots: WRAP_SLOT_MAX, cli_pid: 4412 }))
  })
  try {
    fx.exec.vm.account_tier = 'max'
    const file = path.join(fx.exec.homeDir, '.claude', 'credentials.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-ticket', subscriptionType: 'pro' } }),
    )
    fs.writeFileSync(rustKernelPaths(fx.exec).configPath, JSON.stringify({ slots_per_worker: WRAP_SLOT_MAX }))
    const commands = []
    const ready = await ensureRustKernel(fx.exec, {
      runDockerExec: async (args) => {
        commands.push(args)
        return { ok: true }
      },
    })
    assert.equal(ready.ok, true)
    assert.equal(ready.reason, 'already_up')
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth.subscriptionType, 'max')
    assert.equal(
      commands.some((args) => args[0] === 'restart'),
      false,
    )
  } finally {
    await fx.close()
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
    if (args[0] === 'inspect') return kernelInspectResult()
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
    if (args[0] === 'inspect') return kernelInspectResult()
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

for (const [label, id, pid1] of [
  [
    'wrapped',
    'vm-wrapped-pid1',
    [
      '/bin/sh',
      '-c',
      'export TOKIO_WORKER_THREADS=2; exec "$@"',
      'kin-kernel-cpu',
      '/home/kincli/.kin/kin-kernel',
      '--gateway-worker',
      '--config',
      '/run/kin/kernel.json',
    ],
  ],
  // A cluster node home has no .kin/kin-kernel; detaching one fails and parks the slot.
  ['cluster CRAG', 'vm-cluster-crag-pid1', [REMOTE_CRAG_ENTRY, '--gateway-worker', '--config', '/run/kin/kernel.json']],
]) {
  unixTest(`${label} PID1 recovery restarts the container instead of detaching a second kernel`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `kin-kernel-${id}-`))
    const written = writeKernelConfig(root, { id }, { token: 'tok', proxyUrl: '', proxyRequired: false })
    const container = `kin-${id.slice(3)}`
    const exec = {
      vmId: id,
      homeDir: path.join(root, 'vms', id, 'cli-home'),
      vm: { id, runtime: { container, kernel_socket: written.socketPath } },
    }
    const calls = []
    let server = null
    const runDockerExec = async (args) => {
      calls.push(args)
      if (args[0] === 'inspect') return kernelInspectResult(pid1[0], pid1.slice(1))
      if (args.includes('-d'))
        return { ok: false, error: 'stat /home/kincli/.kin/kin-kernel: no such file or directory' }
      if (args[0] === 'restart' && args[1] === container) {
        server = http.createServer((_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, engine: 'rust', ready_slots: 1, worker_version: 'fixture' }))
        })
        await new Promise((resolve, reject) => {
          server.once('error', reject)
          server.listen(written.socketPath, resolve)
        })
      }
      return { ok: true }
    }

    try {
      const ready = await ensureRustKernel(exec, { timeoutMs: 1000, healthTimeoutMs: 200, runDockerExec })
      assert.equal(ready.ok, true, JSON.stringify(ready))
      assert.equal(calls.filter((args) => args[0] === 'restart').length, 1)
      assert.equal(
        calls.some((args) => args.includes('-d')),
        false,
      )
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve))
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
}

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
    if (args[0] === 'inspect') return kernelInspectResult()
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
    assert.ok(calls.some((args) => args.includes('-d')))
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

test('native V2 idle reload distinguishes runnable ceiling from live tool waits', async () => {
  const exec = { vmId: 'vm-native-idle' }
  const restarts = []
  let status = {
    ok: true,
    runtime_variant: 'crag-v2',
    capacity: 20,
    runnable_capacity: 4,
    ready_slots: 3,
    active: 0,
    waiting: 1,
    queued: 0,
    pids: [42],
  }
  let observed
  const firstProbe = new Promise((resolve) => {
    observed = resolve
  })
  let timer
  try {
    const request = requestKernelReloadWhenIdle(exec, {
      pollMs: 10,
      health: async () => {
        const snapshot = status
        observed()
        return snapshot
      },
      restart: async (target) => {
        restarts.push(target.vmId)
        return { ok: true }
      },
    })
    await firstProbe
    assert.deepEqual(restarts, [])
    status = { ...status, ready_slots: 4, waiting: 0, pids: [] }
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('native idle reload did not complete')), 3000)
    })
    assert.deepEqual(await Promise.race([request.done, deadline]), { ok: true })
    assert.deepEqual(restarts, ['vm-native-idle'])
  } finally {
    clearTimeout(timer)
    resetWrapRecycleState()
  }
})
