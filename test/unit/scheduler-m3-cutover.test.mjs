import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { SchedulerPoolsRepo } from '../../src/lib/db/repos/scheduler-pools-repo.mjs'
import { createGeminiPublicHandler } from '../../src/lib/gemini/routes.mjs'
import { createGeminiScheduler } from '../../src/lib/gemini/scheduler.mjs'
import { ApiScheduler } from '../../src/lib/pool/api-scheduler.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'
import { handleCodexProtocol, handleCodexSearch } from '../../src/lib/protocol/handle-codex.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { createResponsesWsHandler } from '../../src/lib/protocol/responses-ws.mjs'
import {
  SchedulerUnavailableError,
  VIRTUAL_POOL_IDS,
  createSchedulerRuntime,
  formatNodeKey,
} from '../../src/lib/scheduler/scheduler-runtime.mjs'
import { listVms } from '../../src/lib/vm/vm-registry.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')

function resolveSchedulerBin() {
  for (const candidate of [
    process.env.KIN_SCHEDULER_BIN,
    path.join(REPO_ROOT, 'bin', process.platform === 'win32' ? 'kin-scheduler.exe' : 'kin-scheduler'),
    '/tmp/vm2api-sched-m3-target/release/kin-scheduler',
    '/tmp/vm2api-sched-target/release/kin-scheduler',
  ]) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }
  return null
}

function makeRes() {
  const res = new EventEmitter()
  res.headers = {}
  res.statusCode = 0
  res.body = null
  res.chunks = []
  res.headersSent = false
  res.writableEnded = false
  res.destroyed = false
  res.closed = false
  res.setHeader = (k, v) => {
    res.headers[String(k).toLowerCase()] = v
  }
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status
    res.headersSent = true
    for (const [k, v] of Object.entries(headers)) res.headers[String(k).toLowerCase()] = v
  }
  res.write = (chunk) => {
    res.headersSent = true
    res.chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }
  res.end = (chunk) => {
    if (chunk) res.write(chunk)
    res.headersSent = true
    res.writableEnded = true
    res.closed = true
    res.emit('finish')
    res.emit('close')
  }
  return res
}

function jsonResponder(res, status, body) {
  res.statusCode = status
  res.body = body
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
  return body
}

function writeClaudeVm(
  root,
  id,
  { priority = 5, weight = 10, maxConcurrency = 4, runtime = null, omitTokens = false } = {},
) {
  const vmsDir = path.join(root, 'vms')
  fs.mkdirSync(path.join(vmsDir, id), { recursive: true })
  const vm = {
    id,
    name: id,
    platform: 'anthropic',
    dataplane: 'wrap',
    status: 'running',
    schedulable: true,
    official_cc_inference: 'cli-hop',
    inference_engine: 'crag',
    policy: { maxConcurrency, concurrencyOverride: true, weight, ...(priority != null ? { priority } : {}) },
    ...(runtime ? { runtime } : {}),
    claude: omitTokens
      ? {
          account_tier: 'max',
          account_tier_source: 'profile',
        }
      : {
          account_uuid: `acc-${id}`,
          account_tier: 'max',
          account_tier_source: 'profile',
          access_token: `at-${id}`,
          refresh_token: `rt-${id}`,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
  }
  fs.writeFileSync(path.join(vmsDir, `${id}.json`), JSON.stringify(vm))
  return vm
}

function writeCodexVm(root, id, { priority = 5, weight = 10, maxConcurrency = 4, plan = 'plus' } = {}) {
  const vmsDir = path.join(root, 'vms')
  fs.mkdirSync(path.join(vmsDir, id), { recursive: true })
  const vm = {
    id,
    name: id,
    platform: 'openai',
    family: 'codex',
    dataplane: 'wrap',
    status: 'running',
    schedulable: true,
    codex: { plan_type: plan },
    policy: { maxConcurrency, concurrencyOverride: true, weight, ...(priority != null ? { priority } : {}) },
  }
  fs.writeFileSync(path.join(vmsDir, `${id}.json`), JSON.stringify(vm))
  fs.writeFileSync(
    path.join(vmsDir, id, 'codex-credentials.json'),
    JSON.stringify({
      accounts: [{ id: `${id}-acc`, access_token: `at-${id}`, refresh_token: `rt-${id}`, chatgpt_account_id: id }],
    }),
  )
  return vm
}

async function startRuntime(t, opts = {}) {
  const binPath = resolveSchedulerBin()
  assert.ok(binPath, 'kin-scheduler binary must exist for scheduler-m3-cutover tests (set KIN_SCHEDULER_BIN)')
  const schedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-cutover-sched-'))
  const rt = createSchedulerRuntime({
    cfg: { paths: { data: schedDir, project: opts.projectRoot || schedDir } },
    getDb: () => opts.poolsRepo?.db || null,
    getVms: opts.getVms || (() => (opts.projectRoot ? listVms(opts.projectRoot) : [])),
    apiEndpointStore: opts.apiEndpointStore || null,
    geminiScheduler: opts.geminiScheduler || opts.getGeminiScheduler || null,
    getRoutingConfig: opts.getRoutingConfig || (() => ({})),
    settings: opts.settings || null,
    telemetryIntervalMs: 0,
    clientOptions: {
      binPath,
      socketPath: path.join(schedDir, 'run', 'scheduler.sock'),
      tokenPath: path.join(schedDir, 'run', 'scheduler.token'),
      capFile: path.join(schedDir, 'run', 'scheduler.cap.json'),
      manageProcess: true,
      ...(opts.clientOptions || {}),
    },
  })
  t.after(async () => {
    try {
      await rt.shutdown({ drain: false, stopProcess: true })
    } catch {}
    fs.rmSync(schedDir, { recursive: true, force: true })
  })
  await rt.start({ waitMs: 5_000, startLoops: false })
  await rt.syncConfigNow('m3_cutover_init')
  await rt.pushTelemetryNow()
  return { rt, schedDir }
}

async function startMockCragHealth(t, root) {
  const runDir = path.join(root, 'mock-crag', 'run')
  const homeDir = path.join(root, 'mock-crag', 'cli-home')
  fs.mkdirSync(runDir, { recursive: true })
  fs.mkdirSync(homeDir, { recursive: true })
  const fakeBin = path.join(root, 'kin-kernel')
  fs.writeFileSync(fakeBin, '#!/bin/sh\n', { mode: 0o755 })
  const prev = process.env.KIN_KERNEL_BIN
  process.env.KIN_KERNEL_BIN = fakeBin
  const tokenFile = path.join(runDir, 'internal.token')
  fs.writeFileSync(tokenFile, 'test-token\n', { mode: 0o600 })
  const socket = path.join(runDir, 'kernel.sock')
  const server = http.createServer((req, res) => {
    if (req.url === '/internal/health') {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          ok: true,
          engine: 'rust',
          healthy: true,
          ready_slots: 8,
          runtime_variant: 'crag-v2',
          transport: 'print',
          persona_preset: 'official_full',
          capabilities: ['prompt_replace', 'prompt_append', 'prompt_replace_empty'],
        }),
      )
      return
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, resolve)
  })
  t.after(async () => {
    if (prev === undefined) delete process.env.KIN_KERNEL_BIN
    else process.env.KIN_KERNEL_BIN = prev
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  })
  return {
    homeDir,
    runtime: {
      worker_socket: socket,
      kernel_socket: socket,
      worker_run_dir: runDir,
      worker_token_file: tokenFile,
    },
  }
}

function makeFakeGeminiHost(envs, { delayMs = 0, onRun = null } = {}) {
  const runs = new Map()
  return {
    async callHost(action, payload) {
      if (action === 'list') {
        return {
          payload_mode: 'legacy_release',
          payload_state: 'installed',
          environments: envs.map((e) => ({
            id: e.id,
            auth_method: 'api_key',
            auth_state: 'authorized',
            models_discovered: true,
            models: e.models || ['gemini-4-neon'],
            proxy_id: 'proxy-g1',
            max_concurrency: e.maxConcurrency || 4,
            schedule_level: e.priority || 5,
          })),
        }
      }
      if (action === 'test-chat') {
        const runId = 'a'.repeat(32)
        const envId = payload.id
        onRun?.({ phase: 'start', envId, payload })
        runs.set(runId, { envId, startedAt: Date.now() })
        return { run_id: runId, id: envId, state: 'running', conversation_id: 'gc_test_conv_1' }
      }
      if (action === 'test-chat-status') {
        const entry = runs.get(payload.run_id)
        if (delayMs > 0 && Date.now() - entry.startedAt < delayMs) {
          return { run_id: payload.run_id, id: entry.envId, state: 'running' }
        }
        onRun?.({ phase: 'done', envId: entry.envId })
        return {
          run_id: payload.run_id,
          id: entry.envId,
          state: 'completed',
          text: `gemini-from-${entry.envId}`,
          usage: { input_tokens: 5, output_tokens: 3 },
        }
      }
      throw new Error(`unexpected callHost action: ${action}`)
    },
  }
}

// ===========================================================================
// 1. All 4 execution planes (Claude / Codex / Gemini / API Direct) via Rust
// ===========================================================================

test('M3 Acceptance #1: All 4 execution planes (Claude, Codex, Gemini, API Direct) dispatch via real Rust kin-scheduler', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-4planes-'))
  fs.mkdirSync(path.join(root, 'run'), { recursive: true })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  // Seed Claude VM, Codex VM, Gemini Env, and API Endpoint simultaneously
  writeClaudeVm(root, 'claude-1', { priority: 8 })
  writeCodexVm(root, 'codex-1', { priority: 8 })
  const apiEndpoints = [
    {
      id: 'ep-1',
      kind: 'custom',
      protocol: 'anthropic',
      base_url: 'https://relay.invalid',
      models: [{ name: 'claude-sonnet-4-6', alias: 'claude-sonnet-4-6' }],
      api_key_entries: [{ id: 'k1', api_key: 'sk-test', proxy_url: '' }],
    },
  ]
  const gemHost = makeFakeGeminiHost([{ id: 'gem-1', models: ['gemini-4-neon'], priority: 8 }])
  let geminiSchedulerRef = null
  const { rt } = await startRuntime(t, {
    projectRoot: root,
    apiEndpointStore: { listRaw: () => apiEndpoints },
    getGeminiScheduler: () => geminiSchedulerRef,
  })

  // Plane 1: Claude VM via FailoverRunner
  const poolSched = new PoolScheduler({ projectRoot: root, schedulerRuntime: rt })
  const runner = new FailoverRunner({
    scheduler: poolSched,
    schedulerRuntime: rt,
    config: { max_same_account_retries: 0 },
  })
  const claudeRes = await runner.run({
    requestId: 'm3-plane-claude-1',
    model: 'claude-sonnet-4-6',
    canonicalBody: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] },
    callAttempt: async ({ candidate, onFirstByte }) => {
      onFirstByte?.()
      return {
        ok: true,
        status: 200,
        committed: true,
        terminalState: 'verified',
        body: {
          id: 'msg_c1',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: `claude:${candidate.vmId}` }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 4, output_tokens: 2 },
        },
      }
    },
  })
  assert.equal(claudeRes.ok, true)
  assert.equal(claudeRes.vmId, 'claude-1')

  // Plane 2: Codex VM via handleCodexSearch (and handleCodexProtocol)
  const searchRes = makeRes()
  const searchLog = {}
  const searchStats = { errors: 0, requests: 0, by_route: {} }
  await handleCodexSearch({
    req: { headers: { 'user-agent': 'codex_exec/0.160.1' } },
    res: searchRes,
    body: { id: 'cs-1', model: 'gpt-6.1-sol', commands: { search_query: [{ q: 'rust' }] } },
    logBag: searchLog,
    stats: searchStats,
    json: jsonResponder,
    routing: {},
    projectRoot: root,
    schedulerRuntime: rt,
    ops: {
      fetchImpl: async () => ({
        status: 200,
        headers: new Map(),
        text: async () => JSON.stringify({ output: 'codex-ok' }),
      }),
    },
  })
  assert.equal(searchRes.statusCode, 200)
  assert.equal(searchLog.vm_id, 'codex-1')

  // Plane 3: Gemini Env via createGeminiScheduler
  geminiSchedulerRef = createGeminiScheduler({
    callHost: gemHost.callHost,
    callHostStream: null,
    resolveProxy: () => ({ id: 'proxy-g1', url: 'socks5://127.0.0.1:1080' }),
    schedulerRuntime: rt,
    directClient: null,
    listCacheTtlMs: 0,
  })
  await geminiSchedulerRef.catalog()
  await rt.syncConfigNow('gemini_loaded')
  await rt.pushTelemetryNow()
  const gemOut = await geminiSchedulerRef.complete({
    model: 'gemini-4-neon',
    text: 'hello gemini',
    inboundIdentity: { sessionId: '33333333-3333-4333-8333-333333333333', machineId: 'mac-g1' },
  })
  assert.equal(gemOut.account_id, 'gem-1')
  assert.equal(gemOut.text, 'gemini-from-gem-1')

  // Plane 4: API Direct via ApiScheduler + Rust acquire/commit/release
  const apiSched = new ApiScheduler({ schedulerRuntime: rt })
  apiSched.reload(apiEndpoints)
  const apiPick = await apiSched.acquire('claude-sonnet-4-6', {
    requestId: 'm3-plane-api-1',
    protocol: 'anthropic.messages',
    inboundIdentity: { sessionId: '44444444-4444-4444-8444-444444444444', machineId: 'mac-a1' },
  })
  assert.equal(apiPick.ok, true)
  assert.equal(apiPick.endpoint.id, 'ep-1')
  assert.ok(apiPick.leaseId)
  await apiSched.commitLease(apiPick.leaseId)
  await apiSched.releaseLease(apiPick.leaseId, { outcome: 'ok', http_status: 200 })
})

// ===========================================================================
// 2. Concurrent same session_id strict FIFO serialization (zero sessionTails)
// ===========================================================================

test('M3 Acceptance #2: Same session_id concurrent requests serialize strictly FIFO (peak=1) across Claude and Codex', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-fifo-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeClaudeVm(root, 'claude-fifo-1', { priority: 5, maxConcurrency: 4 })
  writeCodexVm(root, 'codex-fifo-1', { priority: 5, maxConcurrency: 4 })

  const { rt } = await startRuntime(t, { projectRoot: root })

  // Claude plane FIFO
  const poolSched = new PoolScheduler({ projectRoot: root, schedulerRuntime: rt })
  const runner = new FailoverRunner({ scheduler: poolSched, schedulerRuntime: rt })
  assert.equal(runner.sessionTails, undefined, 'legacy FailoverRunner.sessionTails must be deleted')

  let claudeActive = 0
  let claudePeak = 0
  const claudeOrder = []
  const claudeSess = '55555555-5555-4555-8555-555555555555'
  const runClaude = (tag, ms) =>
    runner.run({
      requestId: `m3-cfifo-${tag}`,
      model: 'claude-sonnet-4-6',
      canonicalBody: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: tag }] },
      inboundIdentity: { sessionId: claudeSess, machineId: 'mac-fifo' },
      callAttempt: async ({ onFirstByte }) => {
        claudeActive += 1
        claudePeak = Math.max(claudePeak, claudeActive)
        claudeOrder.push(`${tag}:start`)
        onFirstByte?.()
        await new Promise((r) => setTimeout(r, ms))
        claudeOrder.push(`${tag}:end`)
        claudeActive -= 1
        return {
          ok: true,
          status: 200,
          committed: true,
          terminalState: 'verified',
          body: {
            id: `msg_${tag}`,
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            content: [{ type: 'text', text: tag }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        }
      },
    })
  const c1 = runClaude('c1', 70)
  await new Promise((r) => setTimeout(r, 15))
  const c2 = runClaude('c2', 20)
  const [rc1, rc2] = await Promise.all([c1, c2])
  assert.equal(rc1.ok, true)
  assert.equal(rc2.ok, true)
  assert.equal(claudePeak, 1)
  assert.deepEqual(claudeOrder, ['c1:start', 'c1:end', 'c2:start', 'c2:end'])

  // Codex plane FIFO via handleCodexProtocol
  let codexActive = 0
  let codexPeak = 0
  const codexOrder = []
  const codexSess = '66666666-6666-4666-8666-666666666666'
  const runCodex = async (tag, ms) => {
    const res = makeRes()
    const reqBody = { model: 'gpt-5.4', input: tag, stream: false }
    await handleCodexProtocol({
      req: Object.assign(new EventEmitter(), {
        headers: { 'user-agent': 'codex_exec/0.160.1' },
      }),
      res,
      protocol: 'openai.responses',
      ctx: { body: reqBody, path: '/v1/responses', headers: { 'user-agent': 'codex_exec/0.160.1' } },
      inbound: reqBody,
      body: reqBody,
      logBag: {},
      stats: { errors: 0, requests: 0, by_route: {} },
      json: jsonResponder,
      writeSSEHeaders() {},
      routing: {
        codex: {
          enabled: true,
          clients: { openai_compatible: 'allow', official_codex: 'allow', unknown: 'allow' },
          protocols: { 'openai.responses': { enabled: true, mode: 'native' } },
        },
      },
      projectRoot: root,
      schedulerRuntime: rt,
      inboundIdentity: { sessionId: codexSess, machineId: 'mac-cfifo' },
      ops: {
        ensureCodexKernel: async () => ({ ok: true }),
        async streamCodexKernel({ onEvent }) {
          codexActive += 1
          codexPeak = Math.max(codexPeak, codexActive)
          codexOrder.push(`${tag}:start`)
          await new Promise((r) => setTimeout(r, ms))
          onEvent?.(
            `data: ${JSON.stringify({
              type: 'response.completed',
              response: {
                id: `resp_${tag}`,
                object: 'response',
                status: 'completed',
                output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: tag }] }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            })}`,
          )
          codexOrder.push(`${tag}:end`)
          codexActive -= 1
          return { ok: true, status: 200, terminalState: 'verified', accountId: 'codex-fifo-1' }
        },
        writeCodexKernelConfig() {},
      },
    })
    return res
  }
  const o1 = runCodex('o1', 70)
  await new Promise((r) => setTimeout(r, 15))
  const o2 = runCodex('o2', 20)
  const [ro1, ro2] = await Promise.all([o1, o2])
  assert.equal(ro1.statusCode, 200)
  assert.equal(ro2.statusCode, 200)
  assert.equal(codexPeak, 1)
  assert.deepEqual(codexOrder, ['o1:start', 'o1:end', 'o2:start', 'o2:end'])
})

// ===========================================================================
// 3. 1-week machine_id sticky + D2 zero-cooldown spill preserving home binding
// ===========================================================================

test('M3 Acceptance #3: 1-week machine_id sticky and D2 zero-cooldown immediate spill preserve machine home', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-sticky-spill-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeClaudeVm(root, 'vm-home', { priority: 9, maxConcurrency: 1 })
  writeClaudeVm(root, 'vm-standin', { priority: 4, maxConcurrency: 2 })

  const { rt } = await startRuntime(t, { projectRoot: root })
  const machineId = 'mac-home-sticky-7d'

  // Turn 1: binds machine_id -> vm-home (tier 9) on commit.
  const turn1 = await rt.acquireNode({
    requestId: 'm3-home-1',
    originPoolId: VIRTUAL_POOL_IDS.claude,
    model: 'claude-sonnet-4-6',
    modelFamily: 'claude',
    protocol: 'anthropic.messages',
    machineId,
    sessionId: '77777777-7777-4777-8777-777777777701',
  })
  assert.equal(turn1.selected_node.node_id, 'vm-home')
  assert.equal(turn1.stood_in, false)
  await rt.commitLease(turn1.lease_id)

  // While turn 1 STILL holds vm-home (maxConcurrency=1), a second session from the SAME machine_id
  // immediately spills (0ms wait, zero cooldown) to vm-standin with stood_in=true & preserve_machine_home=true!
  const tSpillStart = Date.now()
  const spillTurn = await rt.acquireNode({
    requestId: 'm3-home-spill',
    originPoolId: VIRTUAL_POOL_IDS.claude,
    model: 'claude-sonnet-4-6',
    modelFamily: 'claude',
    protocol: 'anthropic.messages',
    machineId,
    sessionId: '77777777-7777-4777-8777-777777777702',
  })
  const spillElapsed = Date.now() - tSpillStart
  assert.equal(spillTurn.selected_node.node_id, 'vm-standin')
  assert.equal(spillTurn.stood_in, true)
  assert.equal(spillTurn.preserve_machine_home, true)
  assert.ok(spillElapsed < 250, `expected immediate spill (0ms wait), took ${spillElapsed}ms`)
  await rt.commitLease(spillTurn.lease_id)
  await rt.releaseLease(spillTurn.lease_id, { outcome: 'ok', http_status: 200 })
  await rt.releaseLease(turn1.lease_id, { outcome: 'ok', http_status: 200 })

  // Next fresh session on the same machine_id MUST still return to preserved home `vm-home`!
  const backHome = await rt.acquireNode({
    requestId: 'm3-home-return',
    originPoolId: VIRTUAL_POOL_IDS.claude,
    model: 'claude-sonnet-4-6',
    modelFamily: 'claude',
    protocol: 'anthropic.messages',
    machineId,
    sessionId: '77777777-7777-4777-8777-777777777703',
  })
  assert.equal(backHome.selected_node.node_id, 'vm-home')
  assert.equal(backHome.stood_in, false)
  await rt.releaseLease(backHome.lease_id, { outcome: 'ok', http_status: 200 })
})

// ===========================================================================
// 4. Strict weight_tier (1..10) + SWRR intra-tier distribution
// ===========================================================================

test('M3 Acceptance #4: Strict weight_tier (1..10) priority and intra-tier SWRR weighting', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-swrr-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeClaudeVm(root, 'vm-t8-heavy', { priority: 8, weight: 30, maxConcurrency: 8 })
  writeClaudeVm(root, 'vm-t8-light', { priority: 8, weight: 10, maxConcurrency: 8 })
  writeClaudeVm(root, 'vm-t3-lower', { priority: 3, weight: 100, maxConcurrency: 8 })

  const { rt } = await startRuntime(t, { projectRoot: root })

  const counts = { 'vm-t8-heavy': 0, 'vm-t8-light': 0, 'vm-t3-lower': 0 }
  for (let i = 0; i < 8; i += 1) {
    const acq = await rt.acquireNode({
      requestId: `m3-swrr-${i}`,
      originPoolId: VIRTUAL_POOL_IDS.claude,
      model: 'claude-sonnet-4-6',
      modelFamily: 'claude',
      protocol: 'anthropic.messages',
      sessionId: `88888888-8888-4888-8888-8888888888${String(i).padStart(2, '0')}`,
      isEphemeralProbe: true,
    })
    counts[acq.selected_node.node_id] = (counts[acq.selected_node.node_id] || 0) + 1
    await rt.releaseLease(acq.lease_id, { outcome: 'ok', http_status: 200 })
  }
  assert.equal(counts['vm-t3-lower'], 0, 'lower weight_tier 3 must never receive traffic while tier 8 has capacity')
  assert.equal(counts['vm-t8-heavy'], 6, 'SWRR 30:10 over 8 requests must route 6 to heavy')
  assert.equal(counts['vm-t8-light'], 2, 'SWRR 30:10 over 8 requests must route 2 to light')
})

// ===========================================================================
// 5 & 6. Anthropic Official vs Zero-Inject + OpenAI/Google passthrough + JEV downgrade
// ===========================================================================

test('M3 Acceptance #5 & #6: Anthropic Official vs Zero-Inject prompt isolation, OpenAI/Google passthrough, and trusted JEV downgrade without sticky pollution', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-prompt-jev-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const routingFile = path.join(root, 'routing.json')
  const routing = { compatibility: { persona_preset: 'official_full' } }
  fs.writeFileSync(routingFile, JSON.stringify(routing))

  const mockCrag = await startMockCragHealth(t, root)
  const vmOff = writeClaudeVm(root, 'vm-off-1', { priority: 8, runtime: mockCrag.runtime, omitTokens: true })
  const vmZero = writeClaudeVm(root, 'vm-zero-1', { priority: 8, runtime: mockCrag.runtime, omitTokens: true })
  const vmDown = writeClaudeVm(root, 'vm-down-1', { priority: 8, runtime: mockCrag.runtime, omitTokens: true })
  writeCodexVm(root, 'vm-codex-pt', { priority: 8 })

  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-prompt-db-'))
  const keyStore = new ApiKeyStore({ dataDir: dbDir })
  t.after(() => {
    try {
      keyStore.close?.()
    } catch {}
    fs.rmSync(dbDir, { recursive: true, force: true })
  })
  const poolsRepo = new SchedulerPoolsRepo(keyStore.db)
  poolsRepo.insert({
    id: 'pool_m3_official',
    name: 'M3 Official',
    provider_scope: 'anthropic',
    system_prompt_mode: 'official',
    system_prompt_preset: 'official_full',
  })
  poolsRepo.setMembers('pool_m3_official', [{ node_type: 'claude_vm', node_id: 'vm-off-1' }])

  poolsRepo.insert({
    id: 'pool_m3_zero',
    name: 'M3 Zero Inject',
    provider_scope: 'anthropic',
    system_prompt_mode: 'zero_inject',
  })
  poolsRepo.setMembers('pool_m3_zero', [{ node_type: 'claude_vm', node_id: 'vm-zero-1' }])

  poolsRepo.insert({
    id: 'pool_dddd3333',
    name: 'M3 Downgrade',
    provider_scope: 'anthropic',
    pool_role: 'downgrade',
    system_prompt_mode: 'override',
    system_prompt_text: 'M3_DOWNGRADE_PROMPT',
    client_system_policy: 'replace_client',
  })
  poolsRepo.setMembers('pool_dddd3333', [{ node_type: 'claude_vm', node_id: 'vm-down-1' }])

  poolsRepo.insert({
    id: 'pool_m3_codex',
    name: 'M3 Codex',
    provider_scope: 'openai',
    system_prompt_mode: 'passthrough',
  })
  poolsRepo.setMembers('pool_m3_codex', [{ node_type: 'codex_vm', node_id: 'vm-codex-pt' }])

  // Start JEV mock server: downgrades prompts containing "borderline"
  const jevServer = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      const borderline = /borderline/i.test(String(payload.state || ''))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          answers: {
            usage_policy: { noul: borderline ? 0.55 : 0.98 },
            nsfw: { noul: 0.99 },
            abuse: { noul: 0.99 },
          },
        }),
      )
    })
  })
  await new Promise((resolve) => jevServer.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    jevServer.closeAllConnections?.()
    await new Promise((resolve) => jevServer.close(resolve))
  })
  const jevUrl = `http://127.0.0.1:${jevServer.address().port}/v1/systemone`

  const settings = {
    get(key, fb = null) {
      if (key === 'jev_intercept') return { enabled: true, base_url: jevUrl, hard_regex_enabled: false, dedup_sec: 0 }
      if (key === 'risk_audit_policy') return { downgrade_pool: 'pool_dddd3333', route_margin: 0.15 }
      return fb
    },
  }

  const { rt } = await startRuntime(t, {
    projectRoot: root,
    poolsRepo,
    getRoutingConfig: () => routing,
    settings,
  })

  // OpenAI node in Rust ALWAYS resolves prompt_policy.source === 'provider_exempt' / mode === 'passthrough'
  const codexAcq = await rt.acquireNode({
    requestId: 'm3-codex-pt-1',
    originPoolId: 'pool_m3_codex',
    apiKeyKind: 'master',
    model: 'gpt-5.4',
    modelFamily: 'openai',
    protocol: 'openai.responses',
  })
  assert.equal(codexAcq.prompt_policy.mode, 'passthrough')
  assert.equal(codexAcq.prompt_policy.source, 'provider_exempt')
  await rt.releaseLease(codexAcq.lease_id, { outcome: 'ok', http_status: 200 })

  const allVms = [vmOff, vmZero, vmDown]
  const observed = []
  let reqCounter = 0
  const runner = new FailoverRunner({
    schedulerRuntime: rt,
    scheduler: {
      resolveCandidateForNode(selectedNode, extra = {}) {
        const vm = allVms.find((v) => v.id === selectedNode?.node_id)
        return {
          ok: true,
          vmId: vm.id,
          accountId: vm.id,
          vm,
          exec: { vmId: vm.id, vm, homeDir: mockCrag.homeDir },
          nodeKey: selectedNode.node_key,
          ...extra,
          release() {},
        }
      },
      markSuccess() {},
      markCooldown() {},
      releaseAccountSessions() {},
    },
    config: { max_same_account_retries: 0 },
  })
  const handler = createHandleProtocol({
    json: jsonResponder,
    writeSSEHeaders() {},
    readBody: async (req) => req.body,
    requireAuth: () => true,
    settings,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000 },
      paths: { data: root, project: root },
    },
    poolsRepo,
    schedulerRuntime: rt,
    vms: allVms,
    requestLog: { start: () => ({ request_id: `m3-pj-${++reqCounter}` }), finish() {} },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: { ingestHeaders() {} },
    apiKeyStore: { acquire: () => ({ ok: true }), release() {}, recordUsage() {} },
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: routing,
    groupsRepo: { rateMultiplier: () => 1 },
    failoverRunner: {
      run(opts) {
        return runner.run({
          ...opts,
          async callAttempt({ candidate, body, onFirstByte }) {
            onFirstByte?.()
            observed.push({ vmId: candidate.vmId, cragPrompt: body?.crag_prompt || null })
            return {
              ok: true,
              status: 200,
              committed: true,
              terminalState: 'verified',
              vmId: candidate.vmId,
              accountId: candidate.accountId,
              body: {
                id: 'msg_ok',
                type: 'message',
                role: 'assistant',
                model: 'claude-sonnet-4-6',
                content: [{ type: 'text', text: 'ok' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            }
          },
        })
      },
    },
  })

  const sendAnthropic = async ({ keyId, poolId, content, machineId }) => {
    const req = Object.assign(new EventEmitter(), {
      method: 'POST',
      url: '/v1/messages',
      headers: machineId ? { 'x-machine-id': machineId } : {},
      apiKeyKind: 'managed',
      apiKeyRecord: {
        id: keyId,
        group_type: 'anthropic',
        pool_binding_mode: 'strict_pool',
        default_pool_id: poolId,
        allowed_pool_ids: [poolId],
      },
      body: { model: 'claude-sonnet-4-6', max_tokens: 32, messages: [{ role: 'user', content }] },
    })
    const res = makeRes()
    await handler.handleProtocol(req, res, 'anthropic.messages', '/v1/messages')
    return res
  }

  // Concurrent Official vs Zero-Inject
  const [resOff, resZero] = await Promise.all([
    sendAnthropic({ keyId: 'k-off', poolId: 'pool_m3_official', content: 'safe official', machineId: 'mac-off' }),
    sendAnthropic({ keyId: 'k-zero', poolId: 'pool_m3_zero', content: 'safe zero', machineId: 'mac-zero' }),
  ])
  assert.equal(resOff.statusCode, 200)
  assert.equal(resZero.statusCode, 200)
  const offObs = observed.find((o) => o.vmId === 'vm-off-1')
  const zeroObs = observed.find((o) => o.vmId === 'vm-zero-1')
  assert.equal(offObs.cragPrompt, null)
  assert.deepEqual(zeroObs.cragPrompt, { mode: 'replace', text: '' })

  // Trusted JEV downgrade on strict_pool key bound ONLY to pool_m3_official -> succeeds on vm-down-1 without 403!
  const resDown = await sendAnthropic({
    keyId: 'k-off',
    poolId: 'pool_m3_official',
    content: 'borderline content triggers downgrade',
    machineId: 'mac-off',
  })
  assert.equal(resDown.statusCode, 200)
  const downObs = observed.at(-1)
  assert.equal(downObs.vmId, 'vm-down-1')
  assert.deepEqual(downObs.cragPrompt, { mode: 'replace', text: 'M3_DOWNGRADE_PROMPT' })

  // Subsequent safe turn on SAME machineId returns cleanly to pool_m3_official (origin sticky NOT polluted!)
  const resAfter = await sendAnthropic({
    keyId: 'k-off',
    poolId: 'pool_m3_official',
    content: 'ordinary safe follow-up',
    machineId: 'mac-off',
  })
  assert.equal(resAfter.statusCode, 200)
  assert.equal(observed.at(-1).vmId, 'vm-off-1')
  assert.equal(observed.at(-1).cragPrompt, null)
})

// ===========================================================================
// 7. D4 Fail-Closed HTTP 503 scheduler_unavailable across ALL 4 planes + WS
// ===========================================================================

test('M3 Acceptance #7: D4 Strict Fail-Closed 503 scheduler_unavailable (Retry-After: 1, zero Node fallback) across all 4 planes and WS', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-failclosed-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeClaudeVm(root, 'vm-c-dead', { priority: 5 })
  writeCodexVm(root, 'vm-o-dead', { priority: 5 })

  // Start a real Rust runtime, then shut down its sidecar permanently (manageProcess=false after stop)
  const { rt } = await startRuntime(t, { projectRoot: root })
  await rt.shutdown({ drain: false, stopProcess: true })

  // Plane 1: Claude FailoverRunner -> 503 scheduler_unavailable, Retry-After: 1, 0 attempts
  let claudeAttempts = 0
  const claudePool = new PoolScheduler({ projectRoot: root, schedulerRuntime: rt })
  const claudeRunner = new FailoverRunner({ scheduler: claudePool, schedulerRuntime: rt })
  const rClaude = await claudeRunner.run({
    requestId: 'm3-fc-claude',
    model: 'claude-sonnet-4-6',
    callAttempt: async () => {
      claudeAttempts += 1
      return { ok: true, status: 200 }
    },
  })
  assert.equal(claudeAttempts, 0)
  assert.equal(rClaude.status, 503)
  assert.equal(rClaude.retryAfterSec, 1)
  assert.equal(rClaude.body?.error?.code, 'scheduler_unavailable')

  // Plane 2: Codex Search -> 503 scheduler_unavailable, Retry-After: 1, 0 upstream calls
  let codexCalls = 0
  const codexRes = makeRes()
  await handleCodexSearch({
    req: { headers: { 'user-agent': 'codex_exec/0.160.1' } },
    res: codexRes,
    body: { id: 'fc-s1', model: 'gpt-6.1-sol', commands: { search_query: [{ q: 'x' }] } },
    logBag: {},
    stats: { errors: 0, requests: 0, by_route: {} },
    json: jsonResponder,
    routing: {},
    projectRoot: root,
    schedulerRuntime: rt,
    ops: {
      fetchImpl: async () => {
        codexCalls += 1
        throw new Error('must never call upstream')
      },
    },
  })
  assert.equal(codexCalls, 0)
  assert.equal(codexRes.statusCode, 503)
  assert.equal(codexRes.headers['retry-after'], '1')
  assert.equal(codexRes.body?.error?.code, 'scheduler_unavailable')

  // Plane 3: Gemini Scheduler & Public Handler -> 503 scheduler_unavailable, Retry-After: 1, 0 host runs
  let gemRuns = 0
  const gemHost = makeFakeGeminiHost([{ id: 'gem-fc-1', models: ['gemini-4-neon'] }], {
    onRun: () => {
      gemRuns += 1
    },
  })
  const gemSched = createGeminiScheduler({
    callHost: gemHost.callHost,
    callHostStream: null,
    resolveProxy: () => ({ id: 'proxy-g1', url: 'socks5://127.0.0.1:1080' }),
    schedulerRuntime: rt,
    directClient: null,
  })
  await assert.rejects(
    () => gemSched.complete({ model: 'gemini-4-neon', text: 'hi' }),
    (err) => err instanceof SchedulerUnavailableError && err.code === 'scheduler_unavailable',
  )
  const gemHandler = createGeminiPublicHandler({
    json: jsonResponder,
    readBody: async (req) => req.body,
    scheduler: gemSched,
    schedulerRuntime: rt,
    settings: { get: (_k, fb) => fb },
  })
  const gemRes = makeRes()
  await gemHandler(
    Object.assign(new EventEmitter(), {
      method: 'POST',
      url: '/v1beta/models/gemini-4-neon:generateContent',
      headers: {},
      apiKeyKind: 'managed',
      apiKeyRecord: { id: 'k-gem-fc', group_type: 'gemini' },
      body: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
    }),
    gemRes,
  )
  assert.equal(gemRuns, 0)
  assert.equal(gemRes.statusCode, 503)
  assert.equal(gemRes.headers['retry-after'], '1')

  // Plane 4: API Direct -> 503 scheduler_unavailable
  const apiSched = new ApiScheduler({ schedulerRuntime: rt })
  apiSched.reload([
    {
      id: 'ep-fc',
      kind: 'custom',
      protocol: 'anthropic',
      base_url: 'https://relay.invalid',
      models: [{ name: 'claude-sonnet-4-6', alias: 'claude-sonnet-4-6' }],
      api_key_entries: [{ id: 'k1', api_key: 'sk-test', proxy_url: '' }],
    },
  ])
  await assert.rejects(
    () => apiSched.acquire('claude-sonnet-4-6', { requestId: 'm3-fc-api' }),
    (err) => err instanceof SchedulerUnavailableError && err.code === 'scheduler_unavailable' && err.status === 503,
  )

  // Plane 5: Responses WS handler exports & wires schedulerRuntime cleanly
  const wsHandler = createResponsesWsHandler({
    handleProtocol: async () => {
      throw new SchedulerUnavailableError('sidecar down')
    },
    requireAuth: () => true,
    cfg: { limits: { max_body_bytes: 1024 * 1024 } },
    schedulerRuntime: rt,
  })
  assert.equal(typeof wsHandler.handleUpgrade, 'function')
})

// ===========================================================================
// 7b. B1 Regression: Stage 4 fallback_pool_id works across all 4 planes
// ===========================================================================

test('M3 Acceptance #7b (B1): Stage 4 fallback_pool_id routes exhausted pool_a -> authorized pool_b across all 4 planes and rejects unauthorized pool_c', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-stage4-fb-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  // Seed pairs of nodes (origin_a = unschedulable/exhausted, fallback_b = healthy, unauth_c = healthy)
  writeClaudeVm(root, 'c-a', { priority: 8 })
  writeClaudeVm(root, 'c-b', { priority: 8 })
  writeClaudeVm(root, 'c-c', { priority: 8 })
  writeCodexVm(root, 'o-a', { priority: 8 })
  writeCodexVm(root, 'o-b', { priority: 8 })
  const apiEndpoints = [
    {
      id: 'ep-a',
      kind: 'custom',
      protocol: 'anthropic',
      base_url: 'https://a.invalid',
      models: [{ name: 'claude-sonnet-4-6', alias: 'claude-sonnet-4-6' }],
      api_key_entries: [{ id: 'ka', api_key: 'sk-a', proxy_url: '' }],
    },
    {
      id: 'ep-b',
      kind: 'custom',
      protocol: 'anthropic',
      base_url: 'https://b.invalid',
      models: [{ name: 'claude-sonnet-4-6', alias: 'claude-sonnet-4-6' }],
      api_key_entries: [{ id: 'kb', api_key: 'sk-b', proxy_url: '' }],
    },
  ]
  const gemHost = makeFakeGeminiHost([
    { id: 'g-a', models: ['gemini-4-neon'], priority: 8 },
    { id: 'g-b', models: ['gemini-4-neon'], priority: 8 },
  ])

  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-stage4-db-'))
  const keyStore = new ApiKeyStore({ dataDir: dbDir })
  t.after(() => {
    try {
      keyStore.close?.()
    } catch {}
    fs.rmSync(dbDir, { recursive: true, force: true })
  })
  const poolsRepo = new SchedulerPoolsRepo(keyStore.db)

  // Claude: pool_c_a -> fallback pool_c_b (authorized) and pool_c_u -> fallback pool_c_c (unauthorized)
  poolsRepo.insert({ id: 'pool_c_b', name: 'Claude FB B', provider_scope: 'anthropic', system_prompt_mode: 'official' })
  poolsRepo.setMembers('pool_c_b', [{ node_type: 'claude_vm', node_id: 'c-b' }])
  poolsRepo.insert({
    id: 'pool_c_a',
    name: 'Claude Origin A',
    provider_scope: 'anthropic',
    system_prompt_mode: 'official',
    fallback_pool_id: 'pool_c_b',
  })
  poolsRepo.setMembers('pool_c_a', [{ node_type: 'claude_vm', node_id: 'c-a' }])
  poolsRepo.insert({
    id: 'pool_c_c',
    name: 'Claude Unauth C',
    provider_scope: 'anthropic',
    system_prompt_mode: 'official',
  })
  poolsRepo.setMembers('pool_c_c', [{ node_type: 'claude_vm', node_id: 'c-c' }])
  poolsRepo.insert({
    id: 'pool_c_u',
    name: 'Claude Origin U',
    provider_scope: 'anthropic',
    system_prompt_mode: 'official',
    fallback_pool_id: 'pool_c_c',
  })
  poolsRepo.setMembers('pool_c_u', [{ node_type: 'claude_vm', node_id: 'c-a' }])

  // Codex: pool_o_a -> pool_o_b
  poolsRepo.insert({ id: 'pool_o_b', name: 'Codex FB B', provider_scope: 'openai', system_prompt_mode: 'passthrough' })
  poolsRepo.setMembers('pool_o_b', [{ node_type: 'codex_vm', node_id: 'o-b' }])
  poolsRepo.insert({
    id: 'pool_o_a',
    name: 'Codex Origin A',
    provider_scope: 'openai',
    system_prompt_mode: 'passthrough',
    fallback_pool_id: 'pool_o_b',
  })
  poolsRepo.setMembers('pool_o_a', [{ node_type: 'codex_vm', node_id: 'o-a' }])

  // API: pool_api_a -> pool_api_b
  poolsRepo.insert({ id: 'pool_api_b', name: 'API FB B', provider_scope: 'api', system_prompt_mode: 'official' })
  poolsRepo.setMembers('pool_api_b', [{ node_type: 'api_endpoint', node_id: 'ep-b' }])
  poolsRepo.insert({
    id: 'pool_api_a',
    name: 'API Origin A',
    provider_scope: 'api',
    system_prompt_mode: 'official',
    fallback_pool_id: 'pool_api_b',
  })
  poolsRepo.setMembers('pool_api_a', [{ node_type: 'api_endpoint', node_id: 'ep-a' }])

  // Gemini: pool_g_a -> pool_g_b
  poolsRepo.insert({ id: 'pool_g_b', name: 'Gem FB B', provider_scope: 'google', system_prompt_mode: 'passthrough' })
  poolsRepo.setMembers('pool_g_b', [{ node_type: 'gemini_env', node_id: 'g-b' }])
  poolsRepo.insert({
    id: 'pool_g_a',
    name: 'Gem Origin A',
    provider_scope: 'google',
    system_prompt_mode: 'passthrough',
    fallback_pool_id: 'pool_g_b',
  })
  poolsRepo.setMembers('pool_g_a', [{ node_type: 'gemini_env', node_id: 'g-a' }])

  let geminiSchedRef = null
  const { rt } = await startRuntime(t, {
    projectRoot: root,
    poolsRepo,
    apiEndpointStore: { listRaw: () => apiEndpoints },
    geminiScheduler: () => geminiSchedRef,
  })
  geminiSchedRef = createGeminiScheduler({
    callHost: gemHost.callHost,
    callHostStream: null,
    resolveProxy: () => ({ id: 'proxy-g1', url: 'socks5://127.0.0.1:1080' }),
    schedulerRuntime: rt,
    directClient: null,
    listCacheTtlMs: 0,
  })
  await geminiSchedRef.catalog()
  await rt.syncConfigNow('stage4_all_4_planes')
  await rt.pushTelemetryNow()

  // Mark all 4 origin nodes unschedulable in Rust telemetry to force Stage 4 fallback
  await rt.pushTelemetryNow([
    { node_key: formatNodeKey('claude_vm', 'c-a'), schedulable: false, unschedulable_reason: 'origin_full' },
    { node_key: formatNodeKey('codex_vm', 'o-a'), schedulable: false, unschedulable_reason: 'origin_full' },
    { node_key: formatNodeKey('api_endpoint', 'ep-a'), schedulable: false, unschedulable_reason: 'origin_full' },
    { node_key: formatNodeKey('gemini_env', 'g-a'), schedulable: false, unschedulable_reason: 'origin_full' },
  ])

  // 1. Claude plane: authorized pool_c_b succeeds (even though keyScope.allowed_vms only lists origin pool c-a!)
  const poolSched = new PoolScheduler({ projectRoot: root, schedulerRuntime: rt })
  const runner = new FailoverRunner({ scheduler: poolSched, schedulerRuntime: rt })
  const claudePoolA = poolsRepo.get('pool_c_a')
  const claudeOk = await runner.run({
    requestId: 'm3-s4-claude-ok',
    model: 'claude-sonnet-4-6',
    canonicalBody: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] },
    originPoolId: 'pool_c_a',
    keyScope: { vm_pool_id: 'pool_c_a', allowed_vms: ['c-a'] },
    poolAccess: { ok: true, legacy: false, originPool: claudePoolA, effectivePool: claudePoolA, allowedVmIds: ['c-a'] },
    apiKeyKind: 'managed',
    apiKeyRecord: {
      id: 'k-s4-c-ok',
      pool_binding_mode: 'strict_pool',
      default_pool_id: 'pool_c_a',
      allowed_pool_ids: ['pool_c_a', 'pool_c_b'],
    },
    allowQueue: false,
    callAttempt: async ({ candidate, onFirstByte }) => {
      onFirstByte?.()
      return {
        ok: true,
        status: 200,
        committed: true,
        terminalState: 'verified',
        body: {
          id: 'msg_s4',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: candidate.vmId }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }
    },
  })
  assert.equal(claudeOk.ok, true)
  assert.equal(claudeOk.vmId, 'c-b')
  assert.equal(claudeOk.resolvedPoolId, 'pool_c_b')

  // 1b. Claude plane: unauthorized fallback pool_c_c (NOT in allowed_pool_ids) is strictly rejected!
  const claudePoolU = poolsRepo.get('pool_c_u')
  const claudeDenied = await runner.run({
    requestId: 'm3-s4-claude-deny',
    model: 'claude-sonnet-4-6',
    canonicalBody: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] },
    originPoolId: 'pool_c_u',
    keyScope: { vm_pool_id: 'pool_c_u', allowed_vms: ['c-a'] },
    poolAccess: { ok: true, legacy: false, originPool: claudePoolU, effectivePool: claudePoolU, allowedVmIds: ['c-a'] },
    apiKeyKind: 'managed',
    apiKeyRecord: {
      id: 'k-s4-c-deny',
      pool_binding_mode: 'strict_pool',
      default_pool_id: 'pool_c_u',
      allowed_pool_ids: ['pool_c_u'],
    },
    allowQueue: false,
    callAttempt: async () => {
      throw new Error('unauthorized fallback pool_c_c must never be dispatched')
    },
  })
  assert.equal(claudeDenied.ok, false)

  // 2. Codex plane: handleCodexSearch falls back to o-b despite origin-only keyScope.allowed_vms=['o-a']
  const codexPoolA = poolsRepo.get('pool_o_a')
  const codexRes = makeRes()
  const codexLog = {}
  await handleCodexSearch({
    req: {
      headers: { 'user-agent': 'codex_exec/0.160.1' },
      apiKeyKind: 'managed',
      apiKeyRecord: {
        id: 'k-s4-o-ok',
        pool_binding_mode: 'strict_pool',
        default_pool_id: 'pool_o_a',
        allowed_pool_ids: ['pool_o_a', 'pool_o_b'],
      },
    },
    res: codexRes,
    body: { id: 's4-cs', model: 'gpt-6.1-sol', commands: { search_query: [{ q: 'fb' }] } },
    logBag: codexLog,
    stats: { errors: 0, requests: 0, by_route: {} },
    json: jsonResponder,
    routing: {},
    projectRoot: root,
    schedulerRuntime: rt,
    keyScope: { vm_pool_id: 'pool_o_a', allowed_vms: ['o-a'] },
    poolAccess: { ok: true, legacy: false, originPool: codexPoolA, effectivePool: codexPoolA, allowedVmIds: ['o-a'] },
    originPoolId: 'pool_o_a',
    ops: {
      fetchImpl: async () => ({ status: 200, headers: new Map(), text: async () => JSON.stringify({ output: 'ok' }) }),
    },
  })
  assert.equal(codexRes.statusCode, 200)
  assert.equal(codexLog.vm_id, 'o-b')

  // 3. API Direct plane: ApiScheduler falls back to ep-b despite origin-only allowedEndpointIds=['ep-a']
  const apiPoolA = poolsRepo.get('pool_api_a')
  const apiSched = new ApiScheduler({ schedulerRuntime: rt })
  apiSched.reload(apiEndpoints)
  const apiPick = await apiSched.acquire('claude-sonnet-4-6', {
    requestId: 'm3-s4-api-ok',
    originPoolId: 'pool_api_a',
    allowedEndpointIds: ['ep-a'],
    poolAccess: {
      ok: true,
      legacy: false,
      originPool: apiPoolA,
      effectivePool: apiPoolA,
      allowedEndpointIds: ['ep-a'],
    },
    apiKeyKind: 'managed',
    apiKeyRecord: {
      id: 'k-s4-api-ok',
      category: 'api',
      pool_binding_mode: 'strict_pool',
      default_pool_id: 'pool_api_a',
      allowed_pool_ids: ['pool_api_a', 'pool_api_b'],
    },
    noQueue: true,
  })
  assert.equal(apiPick.ok, true)
  assert.equal(apiPick.endpoint.id, 'ep-b')
  assert.equal(apiPick.resolvedPoolId, 'pool_api_b')
  await apiSched.releaseLease(apiPick.leaseId, { outcome: 'ok', http_status: 200 })

  // 4. Gemini plane: createGeminiPublicHandler + createGeminiScheduler fall back to g-b
  const gemHandler = createGeminiPublicHandler({
    json: jsonResponder,
    readBody: async (req) => req.body,
    scheduler: geminiSchedRef,
    schedulerRuntime: rt,
    poolsRepo,
    settings: { get: (_k, fb) => fb },
  })
  const gemRes = makeRes()
  await gemHandler(
    Object.assign(new EventEmitter(), {
      method: 'POST',
      url: '/v1beta/models/gemini-4-neon:generateContent',
      headers: { 'x-vm2api-no-queue': '1' },
      apiKeyKind: 'managed',
      apiKeyRecord: {
        id: 'k-s4-gem-ok',
        group_type: 'gemini',
        pool_binding_mode: 'strict_pool',
        default_pool_id: 'pool_g_a',
        allowed_pool_ids: ['pool_g_a', 'pool_g_b'],
      },
      body: { contents: [{ role: 'user', parts: [{ text: 'hello fallback' }] }] },
    }),
    gemRes,
  )
  assert.equal(gemRes.statusCode, 200, JSON.stringify(gemRes.body))
  assert.equal(gemRes.body?.candidates?.[0]?.content?.parts?.[0]?.text, 'gemini-from-g-b')
})

// ===========================================================================
// 8. Static source-code D4/M3 hygiene assertion across all Piece 6B files
// ===========================================================================

test('M3 Acceptance #8: Piece 6B source files contain zero legacy fallback switches or FailoverRunner.sessionTails', () => {
  const piece6bFiles = [
    'src/lib/pool/openai-account-selector.mjs',
    'src/lib/pool/codex-slot-pool.mjs',
    'src/lib/pool/api-scheduler.mjs',
    'src/lib/pool/pool-scheduler.mjs',
    'src/lib/pool/failover-runner.mjs',
    'src/lib/gemini/scheduler.mjs',
    'src/lib/gemini/routes.mjs',
    'src/lib/protocol/handle-codex.mjs',
    'src/lib/protocol/handle-protocol.mjs',
    'src/lib/protocol/responses-ws.mjs',
  ]
  const forbidden = [
    /\bsessionTails\b/,
    /\bfallback_node\b/,
    /\bKIN_SCHEDULER_MODE\b/,
    /\bKIN_SCHEDULER_FAIL_MODE\b/,
    /\bshadow_mode\b/,
  ]
  for (const rel of piece6bFiles) {
    const content = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')
    for (const pattern of forbidden) {
      assert.equal(pattern.test(content), false, `Forbidden pattern ${pattern} found in ${rel}`)
    }
  }
})
