import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { createGeminiPublicHandler } from '../../src/lib/gemini/routes.mjs'
import { blockedRiskTool } from '../../src/lib/core/refusal-guard.mjs'
import { SchedulerPoolsRepo } from '../../src/lib/db/repos/scheduler-pools-repo.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import {
  CRAG_PRINT_PROMPT_MAX_BYTES,
  cragSupportsEmptyReplace,
  prepareCragPrintBody,
} from '../../src/lib/protocol/crag-print-prompt.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import {
  applyPoolPromptToAnthropicBody,
  applyPoolSystemToBlocks,
  isPoolZeroInjectMode,
  resolvePoolSystemPromptPolicy,
  validatePoolPromptBytes,
} from '../../src/lib/protocol/pool-prompt-policy.mjs'
import { handleUserCountTokens } from '../../src/lib/protocol/user-count-tokens.mjs'
import { createSchedulerRuntime } from '../../src/lib/scheduler/scheduler-runtime.mjs'

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

async function startTestSchedulerRuntime(t, { root, poolsRepo, getVms, getRoutingConfig, settings = null }) {
  const binPath = resolveSchedulerBin()
  assert.ok(binPath, 'kin-scheduler binary must exist for scheduler-m1b-pool-prompt tests (set KIN_SCHEDULER_BIN)')
  const schedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1b-rust-sched-'))
  const rt = createSchedulerRuntime({
    cfg: { paths: { data: schedDir, project: root } },
    getDb: () => poolsRepo?.db || null,
    getVms,
    getRoutingConfig,
    settings,
    telemetryIntervalMs: 0,
    clientOptions: {
      binPath,
      socketPath: path.join(schedDir, 'run', 'scheduler.sock'),
      tokenPath: path.join(schedDir, 'run', 'scheduler.token'),
      capFile: path.join(schedDir, 'run', 'scheduler.cap.json'),
      manageProcess: true,
    },
  })
  t.after(async () => {
    try {
      await rt.shutdown({ drain: false, stopProcess: true })
    } catch {}
    fs.rmSync(schedDir, { recursive: true, force: true })
  })
  await rt.start({ waitMs: 5_000, startLoops: false })
  await rt.syncConfigNow('m1b_test_init')
  await rt.pushTelemetryNow()
  return rt
}

function makeRes() {
  const res = new EventEmitter()
  res.headers = {}
  res.statusCode = 200
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

function makeSettings(map = {}) {
  return {
    get(key, fallback = null) {
      return Object.hasOwn(map, key) ? map[key] : fallback
    },
  }
}

function makePoolsRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1b-pool-prompt-db-'))
  const store = new ApiKeyStore({ dataDir: dir })
  t.after(() => {
    try {
      store.close?.()
    } catch {}
    try {
      store.db?.close?.()
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return new SchedulerPoolsRepo(store.db)
}

function seedPool(poolsRepo, { members = [], ...input }) {
  const created = poolsRepo.insert(input)
  if (members.length) {
    return poolsRepo.setMembers(created.id, members)
  }
  return created
}

async function startMockCragHealthSocket(t, root, health = {}) {
  const runDir = path.join(root, 'mock-crag', 'run')
  const homeDir = path.join(root, 'mock-crag', 'cli-home')
  fs.mkdirSync(runDir, { recursive: true })
  fs.mkdirSync(homeDir, { recursive: true })
  const fakeBin = path.join(root, 'kin-kernel')
  fs.writeFileSync(fakeBin, '#!/bin/sh\n', { mode: 0o755 })
  const prevKernelBin = process.env.KIN_KERNEL_BIN
  process.env.KIN_KERNEL_BIN = fakeBin
  const tokenFile = path.join(runDir, 'internal.token')
  fs.writeFileSync(tokenFile, 'internal-test\n', { mode: 0o600 })
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
          ...health,
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
  t.after(() => {
    if (prevKernelBin === undefined) delete process.env.KIN_KERNEL_BIN
    else process.env.KIN_KERNEL_BIN = prevKernelBin
    server.closeAllConnections?.()
    return new Promise((resolve) => server.close(resolve))
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

function writeVmFile(root, vm) {
  const dir = path.join(root, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${vm.id}.json`), JSON.stringify(vm))
}

async function startJevServer(t, handler) {
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      let body = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      } catch {}
      const reply = handler(body, req)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections?.()
    return new Promise((resolve) => server.close(resolve))
  })
  return `http://127.0.0.1:${server.address().port}/v1/systemone`
}

test('resolvePoolSystemPromptPolicy enforces Anthropic-only boundary, 6 modes, internal exemption, and 64KiB limit', () => {
  const globalOfficial = { compatibility: { persona_preset: 'official_full' } }
  const globalZero = { compatibility: { persona_preset: 'zero' } }

  // OpenAI and Google pools ALWAYS resolve to passthrough regardless of stored prompt mode.
  for (const provider of ['openai', 'google']) {
    const pol = resolvePoolSystemPromptPolicy(
      { id: `pool_${provider}`, provider_scope: provider, system_prompt_mode: 'official', system_prompt_text: 'BAD' },
      globalZero,
    )
    assert.equal(pol.mode, 'passthrough')
    assert.equal(pol.applies, false)
    assert.equal(pol.source, 'provider_exempt')
    assert.equal(pol.isZeroInject, false)
  }

  // Mixed/API pools apply ONLY to Anthropic nodes, never OpenAI/Google nodes.
  const mixedPool = {
    id: 'pool_mixed',
    provider_scope: 'mixed',
    system_prompt_mode: 'zero_inject',
  }
  assert.equal(
    resolvePoolSystemPromptPolicy(mixedPool, globalOfficial, { nodeProvider: 'anthropic' }).mode,
    'zero_inject',
  )
  assert.equal(isPoolZeroInjectMode(mixedPool, globalOfficial, { nodeProvider: 'anthropic' }), true)
  assert.equal(resolvePoolSystemPromptPolicy(mixedPool, globalOfficial, { nodeProvider: 'openai' }).mode, 'passthrough')
  assert.equal(resolvePoolSystemPromptPolicy(mixedPool, globalOfficial, { nodeProvider: 'google' }).mode, 'passthrough')

  // Internal probes / classifier calls are always exempt.
  const internal = resolvePoolSystemPromptPolicy(
    { id: 'pool_anth', provider_scope: 'anthropic', system_prompt_mode: 'override', system_prompt_text: 'POOL' },
    globalOfficial,
    { nodeProvider: 'anthropic', isInternalCall: true },
  )
  assert.equal(internal.mode, 'passthrough')
  assert.equal(internal.applies, false)
  assert.equal(internal.source, 'internal_exempt')

  // Explicit Anthropic pool modes override global routing.compatibility.
  assert.equal(
    isPoolZeroInjectMode(
      { id: 'p_zero', provider_scope: 'anthropic', system_prompt_mode: 'zero_inject' },
      globalOfficial,
    ),
    true,
  )
  assert.equal(
    isPoolZeroInjectMode(
      {
        id: 'p_official',
        provider_scope: 'anthropic',
        system_prompt_mode: 'official',
        system_prompt_preset: 'official_full',
      },
      globalZero,
    ),
    false,
  )
  assert.equal(
    isPoolZeroInjectMode(
      { id: 'p_inherit', provider_scope: 'anthropic', system_prompt_mode: 'inherit_global' },
      globalZero,
    ),
    true,
  )

  // Override client_system_policy merge modes + append tail preservation.
  const callerSys = [{ type: 'text', text: 'CLIENT_SYS' }]
  const prependRes = applyPoolSystemToBlocks(
    callerSys,
    resolvePoolSystemPromptPolicy({
      id: 'p_ov1',
      provider_scope: 'anthropic',
      system_prompt_mode: 'override',
      system_prompt_text: 'POOL_SYS',
      client_system_policy: 'prepend_pool',
    }),
  )
  assert.deepEqual(
    prependRes.map((b) => b.text),
    ['POOL_SYS', 'CLIENT_SYS'],
  )

  const appendPoolRes = applyPoolSystemToBlocks(
    callerSys,
    resolvePoolSystemPromptPolicy({
      id: 'p_ov2',
      provider_scope: 'anthropic',
      system_prompt_mode: 'override',
      system_prompt_text: 'POOL_SYS',
      client_system_policy: 'append_pool',
    }),
  )
  assert.deepEqual(
    appendPoolRes.map((b) => b.text),
    ['CLIENT_SYS', 'POOL_SYS'],
  )

  const replaceClientRes = applyPoolSystemToBlocks(
    callerSys,
    resolvePoolSystemPromptPolicy({
      id: 'p_ov3',
      provider_scope: 'anthropic',
      system_prompt_mode: 'override',
      system_prompt_text: 'POOL_SYS',
      client_system_policy: 'replace_client',
    }),
  )
  assert.deepEqual(
    replaceClientRes.map((b) => b.text),
    ['POOL_SYS'],
  )

  // Append mode ALWAYS appends pool text at the tail to preserve Prompt Cache prefix.
  const appendBody = applyPoolPromptToAnthropicBody(
    { model: 'claude-sonnet-4-6', system: callerSys, messages: [] },
    resolvePoolSystemPromptPolicy({
      id: 'p_app',
      provider_scope: 'anthropic',
      system_prompt_mode: 'append',
      system_prompt_text: 'POOL_TAIL',
    }),
  )
  assert.deepEqual(
    appendBody.system.map((b) => b.text),
    ['CLIENT_SYS', 'POOL_TAIL'],
  )

  // 64KiB non-v3 validation vs native v3 allowance.
  const huge = 'x'.repeat(65 * 1024)
  assert.throws(() => validatePoolPromptBytes(huge, { nativeV3: false }), { code: 'crag_prompt_too_large' })
  assert.equal(validatePoolPromptBytes(huge, { nativeV3: true }), 65 * 1024)
})

test('prepareCragPrintBody enforces prompt_replace_empty capability gate (Fail-Closed), override, append, and 64KiB limit', () => {
  const zeroPolicy = resolvePoolSystemPromptPolicy({
    id: 'pool_zero',
    provider_scope: 'anthropic',
    system_prompt_mode: 'zero_inject',
  })
  const officialPolicy = resolvePoolSystemPromptPolicy({
    id: 'pool_official',
    provider_scope: 'anthropic',
    system_prompt_mode: 'official',
    system_prompt_preset: 'official_full',
  })
  const emptySystemBody = {
    model: 'claude-sonnet-4-6',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hi' }],
  }

  // 1. CRAG 3.1.25+ worker advertising `prompt_replace_empty` emits explicit `replace:""`.
  assert.equal(cragSupportsEmptyReplace(['prompt_replace', 'prompt_replace_empty']), true)
  const zeroWithCap = prepareCragPrintBody(emptySystemBody, {
    preset: 'zero',
    capabilities: ['prompt_replace', 'prompt_append', 'prompt_replace_empty'],
    health: { persona_preset: 'official_full' },
    promptPolicy: zeroPolicy,
  })
  assert.deepEqual(zeroWithCap.crag_prompt, { mode: 'replace', text: '' })

  // 2. Legacy CRAG worker lacking `prompt_replace_empty` AND static official_full MUST Fail-Closed.
  assert.throws(
    () =>
      prepareCragPrintBody(emptySystemBody, {
        preset: 'zero',
        capabilities: ['prompt_replace', 'prompt_append'],
        health: { persona_preset: 'official_full' },
        promptPolicy: zeroPolicy,
      }),
    (err) => err?.code === 'crag_prompt_replace_empty_unsupported' && err?.status === 503,
  )

  // 3. Legacy worker statically configured with `persona_preset: 'zero'` succeeds without silent official fallback.
  const zeroStaticHealth = prepareCragPrintBody(emptySystemBody, {
    preset: 'zero',
    capabilities: ['prompt_replace', 'prompt_append'],
    health: { persona_preset: 'zero' },
    promptPolicy: zeroPolicy,
  })
  assert.equal(zeroStaticHealth.crag_prompt, undefined)

  // 4. Official pool with empty caller system keeps default official append behavior (no replace:"").
  const officialOut = prepareCragPrintBody(emptySystemBody, {
    preset: 'official_full',
    capabilities: ['prompt_replace', 'prompt_append', 'prompt_replace_empty'],
    health: { persona_preset: 'official_full' },
    promptPolicy: officialPolicy,
  })
  assert.equal(officialOut.crag_prompt, undefined)

  // 5. Override mode renders replace with merged pool + client system text.
  const overridePolicy = resolvePoolSystemPromptPolicy({
    id: 'pool_ov',
    provider_scope: 'anthropic',
    system_prompt_mode: 'override',
    system_prompt_text: 'POOL_OVERRIDE_RULE',
    client_system_policy: 'prepend_pool',
  })
  const overrideOut = prepareCragPrintBody(
    { ...emptySystemBody, system: 'CLIENT_RULE' },
    {
      preset: 'zero',
      capabilities: ['prompt_replace', 'prompt_append', 'prompt_replace_empty'],
      health: { persona_preset: 'official_full' },
      promptPolicy: overridePolicy,
    },
  )
  assert.equal(overrideOut.crag_prompt?.mode, 'replace')
  assert.match(overrideOut.crag_prompt?.text || '', /^POOL_OVERRIDE_RULE[\s\S]*CLIENT_RULE$/)

  // 6. Append mode keeps client prefix ahead of pool tail to preserve Prompt Cache prefix.
  const appendPolicy = resolvePoolSystemPromptPolicy({
    id: 'pool_ap',
    provider_scope: 'anthropic',
    system_prompt_mode: 'append',
    system_prompt_text: 'POOL_TAIL_RULE',
  })
  const appendOut = prepareCragPrintBody(
    { ...emptySystemBody, system: 'CLIENT_PREFIX' },
    {
      preset: 'official_full',
      capabilities: ['prompt_replace', 'prompt_append', 'prompt_replace_empty'],
      health: { persona_preset: 'official_full' },
      promptPolicy: appendPolicy,
    },
  )
  assert.equal(appendOut.crag_prompt?.mode, 'append')
  assert.match(appendOut.crag_prompt?.text || '', /^CLIENT_PREFIX[\s\S]*POOL_TAIL_RULE$/)

  // 7. Non-v3 >64KiB pool prompt throws crag_prompt_too_large.
  const hugeOverride = resolvePoolSystemPromptPolicy({
    id: 'pool_huge',
    provider_scope: 'anthropic',
    system_prompt_mode: 'override',
    system_prompt_text: 'A'.repeat(CRAG_PRINT_PROMPT_MAX_BYTES + 10),
    client_system_policy: 'replace_client',
  })
  assert.throws(
    () =>
      prepareCragPrintBody(emptySystemBody, {
        preset: 'zero',
        capabilities: ['prompt_replace', 'prompt_replace_empty'],
        health: { persona_preset: 'official_full' },
        promptPolicy: hugeOverride,
      }),
    (err) => err?.status === 400 && err?.body?.error?.code === 'crag_prompt_too_large',
  )
})

test('Concurrent Pool 1 (official vm1/2/3) vs Pool 2 (zero_inject vm4/5/6 with empty system) execute with zero cross-contamination', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm1b-concurrent-pools-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const routingFile = path.join(root, 'routing.json')
  const routing = { compatibility: { persona_preset: 'official_full' } }
  fs.writeFileSync(routingFile, JSON.stringify(routing))

  const mockCrag = await startMockCragHealthSocket(t, root)
  const vmList = ['vm1', 'vm2', 'vm3', 'vm4', 'vm5', 'vm6'].map((id) => ({
    id,
    platform: 'anthropic',
    dataplane: 'wrap',
    schedulable: true,
    official_cc_inference: 'cli-hop',
    inference_engine: 'crag',
    runtime: mockCrag.runtime,
    claude: { account_tier: 'max', account_tier_source: 'profile' },
  }))
  for (const vm of vmList) writeVmFile(root, vm)

  const poolsRepo = makePoolsRepo(t)
  seedPool(poolsRepo, {
    id: 'pool_official_1',
    name: 'Pool 1 Official',
    provider_scope: 'anthropic',
    system_prompt_mode: 'official',
    system_prompt_preset: 'official_full',
    members: ['vm1', 'vm2', 'vm3'].map((id) => ({ node_type: 'claude_vm', node_id: id })),
  })
  seedPool(poolsRepo, {
    id: 'pool_zero_2',
    name: 'Pool 2 Zero Inject',
    provider_scope: 'anthropic',
    system_prompt_mode: 'zero_inject',
    members: ['vm4', 'vm5', 'vm6'].map((id) => ({ node_type: 'claude_vm', node_id: id })),
  })

  const schedulerRuntime = await startTestSchedulerRuntime(t, {
    root,
    poolsRepo,
    getVms: () => vmList,
    getRoutingConfig: () => routing,
  })

  const observed = []
  const runner = new FailoverRunner({
    schedulerRuntime,
    scheduler: {
      resolveCandidateForNode(selectedNode, extra = {}) {
        const vm = vmList.find((v) => v.id === selectedNode?.node_id)
        if (!vm) return null
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
    config: { max_same_account_retries: 0, total_retry_deadline_ms: 500 },
  })

  const handler = createHandleProtocol({
    json: jsonResponder,
    writeSSEHeaders() {},
    readBody: async (req) => req.body,
    requireAuth: () => true,
    settings: makeSettings({ jev_intercept: { enabled: false, hard_regex_enabled: false } }),
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000 },
      paths: { data: root, project: root },
    },
    poolsRepo,
    schedulerRuntime,
    vms: vmList,
    requestLog: { start: () => ({ request_id: `req-${Math.random()}` }), finish() {} },
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
          async callAttempt({ candidate, body }) {
            observed.push({
              poolId: opts.keyScope?.vm_pool_id,
              vmId: candidate.vmId,
              cragPrompt: body?.crag_prompt || null,
            })
            return {
              ok: true,
              status: 200,
              finalState: 'verified',
              attemptCount: 1,
              vmId: candidate.vmId,
              accountId: candidate.accountId,
              body: {
                id: `msg_${candidate.vmId}`,
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

  const makeReq = (keyId, poolId) =>
    Object.assign(new EventEmitter(), {
      method: 'POST',
      url: '/v1/messages',
      headers: {},
      apiKeyKind: 'managed',
      apiKeyRecord: {
        id: keyId,
        group_type: 'anthropic',
        pool_binding_mode: 'strict_pool',
        default_pool_id: poolId,
        allowed_pool_ids: [poolId],
      },
      body: {
        model: 'claude-sonnet-4-6',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hello' }],
      },
    })

  // Fire 6 interleaved concurrent requests across Pool 1 and Pool 2.
  const jobs = [0, 1, 2, 3, 4, 5].map(async (i) => {
    const isZero = i % 2 === 1
    const req = makeReq(isZero ? 'key-p2' : 'key-p1', isZero ? 'pool_zero_2' : 'pool_official_1')
    const res = makeRes()
    await handler.handleProtocol(req, res, 'anthropic.messages', '/v1/messages')
    assert.equal(res.statusCode, 200)
  })
  await Promise.all(jobs)

  const p1Calls = observed.filter((o) => o.poolId === 'pool_official_1')
  const p2Calls = observed.filter((o) => o.poolId === 'pool_zero_2')
  assert.equal(p1Calls.length, 3)
  assert.equal(p2Calls.length, 3)
  for (const call of p1Calls) {
    assert.ok(['vm1', 'vm2', 'vm3'].includes(call.vmId), `Pool 1 leaked to ${call.vmId}`)
    assert.equal(call.cragPrompt, null, 'Pool 1 official mode must not emit replace:""')
  }
  for (const call of p2Calls) {
    assert.ok(['vm4', 'vm5', 'vm6'].includes(call.vmId), `Pool 2 leaked to ${call.vmId}`)
    assert.deepEqual(call.cragPrompt, { mode: 'replace', text: '' })
  }
})

test('Step [2] pre-evaluation: strict_pool Fail-Closed, isPoolZeroInjectMode before JEV/count_tokens, and trusted JEV downgrade re-rendering without 403 deadlock', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm1b-downgrade-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const routingFile = path.join(root, 'routing.json')
  const routing = { compatibility: { persona_preset: 'official_full', count_tokens: true } }
  fs.writeFileSync(routingFile, JSON.stringify(routing))

  const mockCrag = await startMockCragHealthSocket(t, root)
  const vmA = {
    id: 'vm-a1',
    platform: 'anthropic',
    dataplane: 'wrap',
    schedulable: true,
    official_cc_inference: 'cli-hop',
    inference_engine: 'crag',
    runtime: mockCrag.runtime,
    claude: { account_tier: 'max', account_tier_source: 'profile' },
  }
  const vmD = {
    id: 'vm-d1',
    platform: 'anthropic',
    dataplane: 'wrap',
    schedulable: true,
    official_cc_inference: 'cli-hop',
    inference_engine: 'crag',
    runtime: mockCrag.runtime,
    claude: { account_tier: 'pro', account_tier_source: 'profile' },
  }
  writeVmFile(root, vmA)
  writeVmFile(root, vmD)

  const poolsRepo = makePoolsRepo(t)
  seedPool(poolsRepo, {
    id: 'pool_aaaa1111',
    name: 'Primary Official',
    provider_scope: 'anthropic',
    system_prompt_mode: 'official',
    system_prompt_preset: 'official_full',
    members: [{ node_type: 'claude_vm', node_id: 'vm-a1' }],
  })
  seedPool(poolsRepo, {
    id: 'pool_dddd2222',
    name: 'Trusted Downgrade Pool',
    provider_scope: 'anthropic',
    pool_role: 'downgrade',
    system_prompt_mode: 'override',
    system_prompt_text: 'DOWNGRADE_POOL_OVERRIDE',
    client_system_policy: 'replace_client',
    members: [{ node_type: 'claude_vm', node_id: 'vm-d1' }],
  })
  seedPool(poolsRepo, {
    id: 'pool_dead3333',
    name: 'Disabled Pool',
    provider_scope: 'anthropic',
    enabled: false,
    members: [{ node_type: 'claude_vm', node_id: 'vm-a1' }],
  })
  seedPool(poolsRepo, {
    id: 'pool_zero4444',
    name: 'Zero Inject Pool',
    provider_scope: 'anthropic',
    system_prompt_mode: 'zero_inject',
    members: [{ node_type: 'claude_vm', node_id: 'vm-a1' }],
  })

  const jevUrl = await startJevServer(t, (payload) => {
    const borderline = /borderline-downgrade/i.test(String(payload.state || ''))
    return {
      answers: {
        usage_policy: { noul: borderline ? 0.55 : 0.95 },
        nsfw: { noul: 0.99 },
        abuse: { noul: 0.99 },
      },
    }
  })

  const downgradeSettings = makeSettings({
    jev_intercept: { enabled: true, base_url: jevUrl, hard_regex_enabled: false },
    risk_audit_policy: { downgrade_pool: 'pool_dddd2222', route_margin: 0.15 },
  })
  const schedulerRuntime = await startTestSchedulerRuntime(t, {
    root,
    poolsRepo,
    getVms: () => [vmA, vmD],
    getRoutingConfig: () => routing,
    settings: downgradeSettings,
  })

  let selectCalls = 0
  let dgReqSeq = 0
  const calls = []
  const runner = new FailoverRunner({
    schedulerRuntime,
    scheduler: {
      resolveCandidateForNode(selectedNode, extra = {}) {
        selectCalls += 1
        const vm = selectedNode?.node_id === 'vm-d1' ? vmD : vmA
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
    config: { max_same_account_retries: 0, total_retry_deadline_ms: 500 },
  })

  const handler = createHandleProtocol({
    json: jsonResponder,
    writeSSEHeaders() {},
    readBody: async (req) => req.body,
    requireAuth: () => true,
    settings: downgradeSettings,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000 },
      paths: { data: root, project: root },
    },
    poolsRepo,
    schedulerRuntime,
    vms: [vmA, vmD],
    requestLog: { start: () => ({ request_id: `req-dg-${++dgReqSeq}` }), finish() {} },
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
          async callAttempt({ candidate, body }) {
            calls.push({ vmId: candidate.vmId, cragPrompt: body?.crag_prompt || null })
            return {
              ok: true,
              status: 200,
              finalState: 'verified',
              attemptCount: 1,
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

  // 1. Out-of-scope X-VM2API-Pool returns 403 pool_forbidden BEFORE slot reservation.
  const forbiddenReq = Object.assign(new EventEmitter(), {
    method: 'POST',
    url: '/v1/messages',
    headers: { 'x-vm2api-pool': 'pool_dddd2222' },
    apiKeyKind: 'managed',
    apiKeyRecord: {
      id: 'key-strict',
      group_type: 'anthropic',
      pool_binding_mode: 'strict_pool',
      default_pool_id: 'pool_aaaa1111',
      allowed_pool_ids: ['pool_aaaa1111'],
    },
    body: { model: 'claude-sonnet-4-6', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] },
  })
  const forbiddenRes = makeRes()
  await handler.handleProtocol(forbiddenReq, forbiddenRes, 'anthropic.messages', '/v1/messages')
  assert.equal(forbiddenRes.statusCode, 403)
  assert.equal(forbiddenRes.body?.error?.code, 'pool_forbidden')
  assert.equal(selectCalls, 0)

  // 2. Disabled bound pool returns 403 pool_unavailable (Fail-Closed, never global fallback).
  const disabledReq = Object.assign(new EventEmitter(), {
    method: 'POST',
    url: '/v1/messages',
    headers: {},
    apiKeyKind: 'managed',
    apiKeyRecord: {
      id: 'key-disabled',
      group_type: 'anthropic',
      pool_binding_mode: 'strict_pool',
      default_pool_id: 'pool_dead3333',
      allowed_pool_ids: ['pool_dead3333'],
    },
    body: { model: 'claude-sonnet-4-6', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] },
  })
  const disabledRes = makeRes()
  await handler.handleProtocol(disabledReq, disabledRes, 'anthropic.messages', '/v1/messages')
  assert.equal(disabledRes.statusCode, 403)
  assert.equal(disabledRes.body?.error?.code, 'pool_unavailable')
  assert.equal(selectCalls, 0)

  // 3. Trusted JEV downgrade exempts ONLY allowed_pool_ids (no 403 deadlock!) and re-renders using downgrade pool prompt!
  const downgradeReq = Object.assign(new EventEmitter(), {
    method: 'POST',
    url: '/v1/messages',
    headers: {},
    apiKeyKind: 'managed',
    apiKeyRecord: {
      id: 'key-strict',
      group_type: 'anthropic',
      pool_binding_mode: 'strict_pool',
      default_pool_id: 'pool_aaaa1111',
      allowed_pool_ids: ['pool_aaaa1111'],
    },
    body: {
      model: 'claude-sonnet-4-6',
      max_tokens: 32,
      system: 'ORIGINAL_CLIENT_SYS',
      messages: [{ role: 'user', content: 'borderline-downgrade prompt' }],
    },
  })
  const downgradeRes = makeRes()
  await handler.handleProtocol(downgradeReq, downgradeRes, 'anthropic.messages', '/v1/messages')
  assert.equal(downgradeRes.statusCode, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].vmId, 'vm-d1')
  assert.deepEqual(calls[0].cragPrompt, { mode: 'replace', text: 'DOWNGRADE_POOL_OVERRIDE' })

  // 4. Forged caller header `x-jev-downgrade-pool` cannot hijack strict_pool routing.
  const spoofReq = Object.assign(new EventEmitter(), {
    method: 'POST',
    url: '/v1/messages',
    headers: { 'x-jev-downgrade-pool': 'pool_dddd2222' },
    apiKeyKind: 'managed',
    apiKeyRecord: {
      id: 'key-strict',
      group_type: 'anthropic',
      pool_binding_mode: 'strict_pool',
      default_pool_id: 'pool_aaaa1111',
      allowed_pool_ids: ['pool_aaaa1111'],
    },
    body: {
      model: 'claude-sonnet-4-6',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'ordinary safe hello' }],
    },
  })
  const spoofRes = makeRes()
  await handler.handleProtocol(spoofReq, spoofRes, 'anthropic.messages', '/v1/messages')
  assert.equal(spoofRes.statusCode, 200)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].vmId, 'vm-a1')
  assert.equal(calls[1].cragPrompt, null)

  // 5. `/v1/messages/count_tokens` enforces Fail-Closed pool authorization BEFORE peekAccount
  //    AND passes pool `zero_inject` into distill before slot peek.
  let peekCalls = 0
  const ctForbiddenRes = makeRes()
  await handleUserCountTokens(
    {
      headers: { 'x-vm2api-pool': 'pool_dddd2222' },
      apiKeyKind: 'managed',
      apiKeyRecord: {
        id: 'key-strict',
        group_type: 'anthropic',
        pool_binding_mode: 'strict_pool',
        default_pool_id: 'pool_aaaa1111',
        allowed_pool_ids: ['pool_aaaa1111'],
      },
    },
    ctForbiddenRes,
    {
      json: jsonResponder,
      requireAuth: () => true,
      readBody: async () => ({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }),
      cfg: { limits: { max_body_bytes: 1024 * 1024 }, distill: { enabled: false }, paths: { project: root } },
      getRoutingConfig: () => routing,
      poolsRepo,
      vms: [vmA, vmD],
      settings: makeSettings({ jev_intercept: { enabled: false, hard_regex_enabled: false } }),
      poolScheduler: {
        async peekAccount() {
          peekCalls += 1
          return { ok: false }
        },
      },
    },
  )
  assert.equal(ctForbiddenRes.statusCode, 403)
  assert.equal(ctForbiddenRes.body?.error?.code, 'pool_forbidden')
  assert.equal(peekCalls, 0)

  // Official pool blocks distill on count_tokens (zeroInject=false);
  // Zero-inject pool skips distill even when global routing is official_full (zeroInject=true).
  const distillPayload = {
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'Please check synthetic-distill-sentinel-m1b now' }],
  }
  const distillCfg = {
    enabled: true,
    skip_official: false,
    skip_zero: true,
    error: { status: 403, type: 'permission_error', code: 'distill_blocked', message: 'distill blocked' },
    hard_needles: [],
    needles: ['synthetic-distill-sentinel-m1b'],
    patterns: [],
    fingerprints: [],
  }
  const ctOfficialRes = makeRes()
  let officialPeekCalls = 0
  await handleUserCountTokens(
    {
      headers: {},
      apiKeyKind: 'managed',
      apiKeyRecord: {
        id: 'key-strict',
        group_type: 'anthropic',
        pool_binding_mode: 'strict_pool',
        default_pool_id: 'pool_aaaa1111',
        allowed_pool_ids: ['pool_aaaa1111'],
      },
    },
    ctOfficialRes,
    {
      json: jsonResponder,
      requireAuth: () => true,
      readBody: async () => distillPayload,
      cfg: { limits: { max_body_bytes: 1024 * 1024 }, distill: distillCfg, paths: { project: root } },
      getRoutingConfig: () => routing,
      poolsRepo,
      vms: [vmA],
      settings: makeSettings({ jev_intercept: { enabled: false, hard_regex_enabled: false } }),
      poolScheduler: {
        async peekAccount() {
          officialPeekCalls += 1
          return { ok: false }
        },
      },
    },
  )
  assert.equal(ctOfficialRes.statusCode, 403)
  assert.equal(officialPeekCalls, 0)

  const ctZeroRes = makeRes()
  let observedPeekKeyScope = null
  await handleUserCountTokens(
    {
      headers: {},
      apiKeyKind: 'managed',
      apiKeyRecord: {
        id: 'key-zero-ct',
        group_type: 'anthropic',
        pool_binding_mode: 'strict_pool',
        default_pool_id: 'pool_zero4444',
        allowed_pool_ids: ['pool_zero4444'],
      },
    },
    ctZeroRes,
    {
      json: jsonResponder,
      requireAuth: () => true,
      readBody: async () => distillPayload,
      cfg: {
        limits: { max_body_bytes: 1024 * 1024 },
        distill: distillCfg,
        paths: { project: root },
      },
      getRoutingConfig: () => routing,
      poolsRepo,
      vms: [vmA],
      settings: makeSettings({ jev_intercept: { enabled: false, hard_regex_enabled: false } }),
      poolScheduler: {
        async peekAccount({ keyScope }) {
          observedPeekKeyScope = keyScope
          return {
            ok: true,
            vmId: 'vm-a1',
            accountId: 'vm-a1',
            vm: { ...vmA, claude: { mode: 'setup-token' } },
            exec: {},
          }
        },
      },
      countTokensViaWorker: async () => ({ ok: true, body: { input_tokens: 42 } }),
    },
  )
  assert.equal(ctZeroRes.statusCode, 200)
  assert.equal(ctZeroRes.body?.input_tokens, 42)
  assert.deepEqual(observedPeekKeyScope?.allowed_vms, ['vm-a1'])
})

test('Gemini public routes enforce Fail-Closed pool authorization, model catalog filtering, and #112 blocked_tools on functionDeclarations', async (t) => {
  const poolsRepo = makePoolsRepo(t)
  seedPool(poolsRepo, {
    id: 'pool_gem_1',
    name: 'Gemini Pool 1',
    provider_scope: 'google',
    members: [{ node_type: 'gemini_env', node_id: 'env-g1' }],
  })
  seedPool(poolsRepo, {
    id: 'pool_gem_disabled',
    name: 'Gemini Disabled',
    provider_scope: 'google',
    enabled: false,
    members: [{ node_type: 'gemini_env', node_id: 'env-g1' }],
  })

  let streamCalls = 0
  let lastCatalogScope = null
  const scheduler = {
    async catalog(scope) {
      lastCatalogScope = scope
      const allAccounts = [
        { id: 'env-g1', models: ['gemini-4-neon'] },
        { id: 'env-g2', models: ['gemini-4-argon'] },
      ]
      const accounts = Array.isArray(scope?.allowedEnvIds)
        ? allAccounts.filter((a) => scope.allowedEnvIds.includes(a.id))
        : allAccounts
      const models = [...new Set(accounts.flatMap((a) => a.models))].map((id) => ({ id, object: 'model' }))
      return { accounts, models }
    },
    async stream() {
      streamCalls += 1
      return { model: 'gemini-4-neon', text: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }
    },
  }

  const handler = createGeminiPublicHandler({
    json: jsonResponder,
    readBody: async (req) => req.body,
    scheduler,
    poolsRepo,
    settings: makeSettings({
      jev_intercept: { enabled: false, hard_regex_enabled: true },
      risk_audit_policy: {
        blocked_tools: [{ name: 'evil_shell', message: '不允许调用危险工具 evil_shell' }],
      },
    }),
  })

  const makeGemReq = (url, { method = 'POST', body = null, headers = {}, keyRecord = null } = {}) =>
    Object.assign(new EventEmitter(), {
      method,
      url,
      headers,
      body,
      apiKeyKind: 'managed',
      apiKeyRecord: keyRecord || {
        id: 'key-gem-strict',
        group_type: 'gemini',
        group_id: 1,
        pool_binding_mode: 'strict_pool',
        default_pool_id: 'pool_gem_1',
        allowed_pool_ids: ['pool_gem_1'],
      },
    })

  // 1. GET /v1beta/models filters strictly to authorized pool members' models (env-g1 only).
  const resModels = makeRes()
  await handler(makeGemReq('/v1beta/models', { method: 'GET' }), resModels)
  assert.equal(resModels.statusCode, 200)
  assert.deepEqual(lastCatalogScope?.allowedEnvIds, ['env-g1'])
  assert.deepEqual(
    (resModels.body?.models || []).map((m) => m.baseModelId),
    ['gemini-4-neon'],
  )

  // 2. Out-of-scope X-VM2API-Pool on GET /v1beta/models and POST :generateContent -> 403 pool_forbidden.
  const resForbModels = makeRes()
  await handler(
    makeGemReq('/v1beta/models', { method: 'GET', headers: { 'x-vm2api-pool': 'pool_gem_disabled' } }),
    resForbModels,
  )
  assert.equal(resForbModels.statusCode, 403)
  assert.equal(resForbModels.body?.error?.details?.[0]?.reason, 'pool_forbidden')

  const resDisPost = makeRes()
  await handler(
    makeGemReq('/v1beta/models/gemini-4-neon:generateContent', {
      body: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
      keyRecord: {
        id: 'key-gem-dis',
        group_type: 'gemini',
        pool_binding_mode: 'strict_pool',
        default_pool_id: 'pool_gem_disabled',
        allowed_pool_ids: ['pool_gem_disabled'],
      },
    }),
    resDisPost,
  )
  assert.equal(resDisPost.statusCode, 403)
  assert.equal(resDisPost.body?.error?.details?.[0]?.reason, 'pool_unavailable')
  assert.equal(streamCalls, 0)

  // 3. #112 Security Regression: Gemini tools[].functionDeclarations & function_declarations hit blocked_tools.
  const rules = [{ name: 'evil_shell', message: 'tool blocked' }]
  assert.equal(
    blockedRiskTool({ tools: [{ functionDeclarations: [{ name: 'evil_shell' }] }] }, null, rules)?.name,
    'evil_shell',
  )
  assert.equal(
    blockedRiskTool({ tools: [{ function_declarations: [{ name: 'EVIL_SHELL' }] }] }, null, rules)?.name,
    'evil_shell',
  )
  assert.equal(blockedRiskTool({ tools: [{ functionDeclarations: [{ name: 'safe_search' }] }] }, null, rules), null)

  for (const toolsKey of ['functionDeclarations', 'function_declarations']) {
    const resBlockedTool = makeRes()
    await handler(
      makeGemReq('/v1beta/models/gemini-4-neon:generateContent', {
        body: {
          contents: [{ role: 'user', parts: [{ text: 'run the tool' }] }],
          tools: [{ [toolsKey]: [{ name: 'evil_shell', description: 'dangerous' }] }],
        },
      }),
      resBlockedTool,
    )
    assert.equal(resBlockedTool.statusCode, 400)
    assert.equal(resBlockedTool.body?.error?.details?.[0]?.reason, 'risk_tool_blocked')
  }
  assert.equal(streamCalls, 0)
})

test('PR-3 Review Blocker #1: /v1/alpha/search and /v1/images/* enforce strict_pool and X-VM2API-Pool keyScope without cross-pool escape', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm1b-codex-pool-scope-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const routingFile = path.join(root, 'routing.json')
  const routing = { codex: { enabled: true } }
  fs.writeFileSync(routingFile, JSON.stringify(routing))

  const codexVms = [
    {
      id: 'codex-a',
      name: 'codex-a',
      platform: 'openai',
      family: 'codex',
      dataplane: 'wrap',
      status: 'running',
      schedulable: true,
      codex: { plan_type: 'plus' },
    },
    {
      id: 'codex-b',
      name: 'codex-b',
      platform: 'openai',
      family: 'codex',
      dataplane: 'wrap',
      status: 'running',
      schedulable: true,
      codex: { plan_type: 'plus' },
    },
    {
      id: 'codex-free',
      name: 'codex-free',
      platform: 'openai',
      family: 'codex',
      dataplane: 'wrap',
      status: 'running',
      schedulable: true,
      codex: { plan_type: 'free' },
    },
  ]
  for (const vm of codexVms) {
    writeVmFile(root, vm)
    fs.mkdirSync(path.join(root, 'vms', vm.id), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'vms', vm.id, 'codex-credentials.json'),
      JSON.stringify({
        accounts: [
          {
            id: `${vm.id}-acc`,
            access_token: 'at',
            refresh_token: 'rt',
            chatgpt_account_id: vm.id,
            chatgpt_plan_type: vm.codex.plan_type,
          },
        ],
      }),
    )
  }

  const poolsRepo = makePoolsRepo(t)
  // Custom non-hex pool IDs (vm_pool_id stays null on key -> legacy fallback would have escaped to all VMs!).
  seedPool(poolsRepo, {
    id: 'custom_codex_pool_a',
    name: 'Codex Pool A',
    provider_scope: 'openai',
    members: [{ node_type: 'codex_vm', node_id: 'codex-a' }],
  })
  seedPool(poolsRepo, {
    id: 'custom_codex_pool_b',
    name: 'Codex Pool B',
    provider_scope: 'openai',
    members: [{ node_type: 'codex_vm', node_id: 'codex-b' }],
  })
  seedPool(poolsRepo, {
    id: 'custom_codex_pool_free',
    name: 'Codex Free Only Pool',
    provider_scope: 'openai',
    members: [{ node_type: 'codex_vm', node_id: 'codex-free' }],
  })

  const schedulerRuntime = await startTestSchedulerRuntime(t, {
    root,
    poolsRepo,
    getVms: () => codexVms,
    getRoutingConfig: () => routing,
  })

  let codexReqSeq = 0
  const searchPickedVms = []
  const imagePickedVms = []
  const handler = createHandleProtocol({
    json: jsonResponder,
    writeSSEHeaders() {},
    readBody: async (req) => req.body,
    requireAuth: () => true,
    settings: makeSettings({ jev_intercept: { enabled: false, hard_regex_enabled: false } }),
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000 },
      paths: { data: root, project: root },
    },
    poolsRepo,
    schedulerRuntime,
    vms: codexVms,
    requestLog: { start: () => ({ request_id: `req-codex-${++codexReqSeq}` }), finish() {} },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: { ingestHeaders() {} },
    apiKeyStore: { acquire: () => ({ ok: true }), release() {}, recordUsage() {} },
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: routing,
    groupsRepo: { rateMultiplier: () => 1 },
    codexOps: {
      async postCodexSearch({ vm }) {
        searchPickedVms.push(vm.id)
        return { status: 200, headers: {}, text: JSON.stringify({ results: [] }), accountId: vm.id }
      },
      async postCodexJson({ vm }) {
        imagePickedVms.push(vm.id)
        return {
          status: 200,
          headers: {},
          text: JSON.stringify({ created: 1, data: [{ b64_json: 'AA==' }] }),
          accountId: vm.id,
        }
      },
    },
  })

  const makeStreamReq = (url, bodyObj, { headers = {}, keyRecord } = {}) => {
    const req = Readable.from([Buffer.from(JSON.stringify(bodyObj))])
    req.method = 'POST'
    req.url = url
    req.headers = { 'content-type': 'application/json', ...headers }
    req.apiKeyKind = 'managed'
    req.apiKeyRecord = keyRecord
    req.body = bodyObj
    return req
  }

  const keyStrictA = {
    id: 'key-codex-a',
    group_type: 'all',
    vm_pool_id: null,
    allowed_vms: [],
    pool_binding_mode: 'strict_pool',
    default_pool_id: 'custom_codex_pool_a',
    allowed_pool_ids: ['custom_codex_pool_a', 'custom_codex_pool_b'],
  }

  // 1. /v1/alpha/search stays in custom_codex_pool_a by default and switches to custom_codex_pool_b via X-VM2API-Pool.
  const sResA = makeRes()
  await handler.handleSearch(
    makeStreamReq('/v1/alpha/search', { model: 'gpt-5.4', query: 'hello' }, { keyRecord: keyStrictA }),
    sResA,
    '/v1/alpha/search',
  )
  assert.equal(sResA.statusCode, 200)
  assert.deepEqual(searchPickedVms, ['codex-a'])

  const sResB = makeRes()
  await handler.handleSearch(
    makeStreamReq(
      '/v1/alpha/search',
      { model: 'gpt-5.4', query: 'hello' },
      { headers: { 'x-vm2api-pool': 'custom_codex_pool_b' }, keyRecord: keyStrictA },
    ),
    sResB,
    '/v1/alpha/search',
  )
  assert.equal(sResB.statusCode, 200)
  assert.deepEqual(searchPickedVms, ['codex-a', 'codex-b'])

  // 2. /v1/images/generations stays in custom_codex_pool_b when X-VM2API-Pool is set.
  const imgResB = makeRes()
  await handler.handleImages(
    makeStreamReq(
      '/v1/images/generations',
      { model: 'gpt-image-1', prompt: 'a cat' },
      { headers: { 'x-vm2api-pool': 'custom_codex_pool_b' }, keyRecord: keyStrictA },
    ),
    imgResB,
    '/v1/images/generations',
    'generations',
  )
  assert.equal(imgResB.statusCode, 200)
  assert.deepEqual(imagePickedVms, ['codex-b'])

  // 3. /v1/images/generations on a Free-only pool MUST return 403 image_generation_unavailable
  //    even though other pools have Paid Codex VMs (keyScope filters the Free-plan pre-check!).
  const imgResFree = makeRes()
  await handler.handleImages(
    makeStreamReq(
      '/v1/images/generations',
      { model: 'gpt-image-1', prompt: 'a cat' },
      {
        keyRecord: {
          id: 'key-codex-free',
          group_type: 'all',
          vm_pool_id: null,
          allowed_vms: [],
          pool_binding_mode: 'strict_pool',
          default_pool_id: 'custom_codex_pool_free',
          allowed_pool_ids: ['custom_codex_pool_free'],
        },
      },
    ),
    imgResFree,
    '/v1/images/generations',
    'generations',
  )
  assert.equal(imgResFree.statusCode, 403)
  assert.equal(imgResFree.body?.error?.code, 'image_generation_unavailable')
  assert.deepEqual(imagePickedVms, ['codex-b'])
})

test('PR-3 Review Major #2: empty VM/API inventory [] stays Fail-Closed instead of coercing to null', async (t) => {
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm1b-empty-inv-'))
  t.after(() => fs.rmSync(emptyRoot, { recursive: true, force: true }))
  fs.mkdirSync(path.join(emptyRoot, 'vms'), { recursive: true })
  const routingFile = path.join(emptyRoot, 'routing.json')
  const routing = { compatibility: { persona_preset: 'official_full', count_tokens: true } }
  fs.writeFileSync(routingFile, JSON.stringify(routing))

  const poolsRepo = makePoolsRepo(t)
  seedPool(poolsRepo, {
    id: 'pool_orphaned_vm',
    name: 'Pool With Deleted VM',
    provider_scope: 'anthropic',
    members: [{ node_type: 'claude_vm', node_id: 'vm-deleted' }],
  })
  seedPool(poolsRepo, {
    id: 'pool_orphaned_api',
    name: 'Pool With Deleted Endpoint',
    provider_scope: 'api',
    members: [{ node_type: 'api_endpoint', node_id: 'ep-deleted' }],
  })

  let runnerCalls = 0
  const handler = createHandleProtocol({
    json: jsonResponder,
    writeSSEHeaders() {},
    readBody: async (req) => req.body,
    requireAuth: () => true,
    settings: makeSettings({ jev_intercept: { enabled: false, hard_regex_enabled: false } }),
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000 },
      paths: { data: emptyRoot, project: emptyRoot },
    },
    poolsRepo,
    // Intentionally omit `vms` so loadVmInventoryForPoolAccess reads `listVms(emptyRoot)` === [].
    apiEndpointStore: { listRaw: () => [], list: () => [] },
    requestLog: { start: () => ({ request_id: 'req-empty' }), finish() {} },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: { ingestHeaders() {} },
    apiKeyStore: { acquire: () => ({ ok: true }), release() {}, recordUsage() {} },
    apiScheduler: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: routing,
    groupsRepo: { rateMultiplier: () => 1 },
    failoverRunner: {
      run() {
        runnerCalls += 1
        throw new Error('must not dispatch when VM inventory is empty')
      },
    },
  })

  // 1. handleProtocol with 0 VMs on disk -> 403 pool_unavailable (not bypassed!)
  const vmRes = makeRes()
  await handler.handleProtocol(
    Object.assign(new EventEmitter(), {
      method: 'POST',
      url: '/v1/messages',
      headers: {},
      apiKeyKind: 'managed',
      apiKeyRecord: {
        id: 'key-empty-vm',
        group_type: 'anthropic',
        pool_binding_mode: 'strict_pool',
        default_pool_id: 'pool_orphaned_vm',
        allowed_pool_ids: ['pool_orphaned_vm'],
      },
      body: { model: 'claude-sonnet-4-6', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] },
    }),
    vmRes,
    'anthropic.messages',
    '/v1/messages',
  )
  assert.equal(vmRes.statusCode, 403)
  assert.equal(vmRes.body?.error?.code, 'pool_unavailable')
  assert.equal(runnerCalls, 0)

  // 2. handleProtocol with 0 API endpoints -> 403 pool_unavailable
  const epRes = makeRes()
  await handler.handleProtocol(
    Object.assign(new EventEmitter(), {
      method: 'POST',
      url: '/v1/messages',
      headers: {},
      apiKeyKind: 'managed',
      apiKeyRecord: {
        id: 'key-empty-ep',
        group_type: 'all',
        pool_binding_mode: 'strict_pool',
        default_pool_id: 'pool_orphaned_api',
        allowed_pool_ids: ['pool_orphaned_api'],
      },
      body: { model: 'claude-sonnet-4-6', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] },
    }),
    epRes,
    'anthropic.messages',
    '/v1/messages',
  )
  assert.equal(epRes.statusCode, 403)
  assert.equal(epRes.body?.error?.code, 'pool_unavailable')

  // 3. handleUserCountTokens with 0 VMs on disk -> 403 pool_unavailable before peekAccount
  let peekCalls = 0
  const ctRes = makeRes()
  await handleUserCountTokens(
    {
      headers: {},
      apiKeyKind: 'managed',
      apiKeyRecord: {
        id: 'key-empty-ct',
        group_type: 'anthropic',
        pool_binding_mode: 'strict_pool',
        default_pool_id: 'pool_orphaned_vm',
        allowed_pool_ids: ['pool_orphaned_vm'],
      },
    },
    ctRes,
    {
      json: jsonResponder,
      requireAuth: () => true,
      readBody: async () => ({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }),
      cfg: { limits: { max_body_bytes: 1024 * 1024 }, distill: { enabled: false }, paths: { project: emptyRoot } },
      getRoutingConfig: () => routing,
      poolsRepo,
      settings: makeSettings({ jev_intercept: { enabled: false, hard_regex_enabled: false } }),
      poolScheduler: {
        async peekAccount() {
          peekCalls += 1
          return { ok: false }
        },
      },
    },
  )
  assert.equal(ctRes.statusCode, 403)
  assert.equal(ctRes.body?.error?.code, 'pool_unavailable')
  assert.equal(peekCalls, 0)
})

test('PR-3 Review Major #3: /v1/messages Gemini Bypasses #3/#4 enforce geminiOwnerMap and disabled gemini_env Fail-Closed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm1b-gem-bypass-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify({}))

  const poolsRepo = makePoolsRepo(t)
  seedPool(poolsRepo, {
    id: 'pool_gem_tenant_b',
    name: 'Tenant B Gemini Pool',
    provider_scope: 'google',
    members: [{ node_type: 'gemini_env', node_id: 'env-tenant-b' }],
  })
  seedPool(poolsRepo, {
    id: 'pool_gem_disabled_env',
    name: 'Disabled Env Gemini Pool',
    provider_scope: 'google',
    members: [{ node_type: 'gemini_env', node_id: 'env-disabled' }],
  })

  const geminiOwnerMap = new Map([
    ['env-tenant-b', 202],
    ['env-disabled', 101],
  ])
  const geminiAccounts = [
    { id: 'env-tenant-b', enabled: true, owner_user_id: 202, models: ['claude-sonnet-4-6', 'gemini-4-neon'] },
    { id: 'env-disabled', enabled: false, owner_user_id: 101, models: ['claude-sonnet-4-6', 'gemini-4-neon'] },
  ]
  let delegatedCalls = 0
  let streamCalls = 0

  const geminiHandler = createGeminiPublicHandler({
    json: jsonResponder,
    readBody: async (req) => req.body,
    poolsRepo,
    geminiOwnerMap: () => geminiOwnerMap,
    apiKeyStore: {
      users: {
        get: (uid) => ({ id: uid, role: 'user' }),
      },
    },
    scheduler: {
      async catalog() {
        return { accounts: geminiAccounts, models: [{ id: 'gemini-4-neon' }, { id: 'ag-claude-sonnet-4-6' }] }
      },
      async stream() {
        streamCalls += 1
        return { model: 'gemini-4-neon', text: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }
      },
    },
    settings: makeSettings({ jev_intercept: { enabled: false, hard_regex_enabled: false } }),
  })

  const handler = createHandleProtocol({
    json: jsonResponder,
    writeSSEHeaders() {},
    readBody: async (req) => req.body,
    requireAuth: () => true,
    settings: makeSettings({ jev_intercept: { enabled: false, hard_regex_enabled: false } }),
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000 },
      paths: { data: root, project: root },
    },
    poolsRepo,
    geminiOwnerMap: () => geminiOwnerMap,
    geminiScheduler: {
      async catalog() {
        return { accounts: geminiAccounts, models: [{ id: 'gemini-4-neon' }, { id: 'ag-claude-sonnet-4-6' }] }
      },
    },
    handleGeminiMessages: (req, res, opts) => {
      delegatedCalls += 1
      return geminiHandler(req, res, opts)
    },
    handleGeminiPublic: (req, res, opts) => {
      delegatedCalls += 1
      return geminiHandler(req, res, opts)
    },
    requestLog: { start: () => ({ request_id: 'req-gem-bypass' }), finish() {} },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: { ingestHeaders() {} },
    apiKeyStore: {
      acquire: () => ({ ok: true }),
      release() {},
      recordUsage() {},
      users: { get: (uid) => ({ id: uid, role: 'user' }) },
    },
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: {},
    groupsRepo: { rateMultiplier: () => 1 },
  })

  // 1. Bypass #3: Tenant 101 `gemini` key bound to pool whose only env belongs to Tenant 202 -> 403 pool_unavailable!
  const resCrossTenant = makeRes()
  await handler.handleProtocol(
    Object.assign(new EventEmitter(), {
      method: 'POST',
      url: '/v1/messages',
      headers: {},
      apiKeyKind: 'managed',
      apiKeyRecord: {
        id: 'key-u101-gem',
        user_id: 101,
        group_type: 'gemini',
        permission_tier: 'tenant',
        pool_binding_mode: 'strict_pool',
        default_pool_id: 'pool_gem_tenant_b',
        allowed_pool_ids: ['pool_gem_tenant_b'],
      },
      body: { model: 'gemini-4-neon', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] },
    }),
    resCrossTenant,
    'anthropic.messages',
    '/v1/messages',
  )
  assert.equal(resCrossTenant.statusCode, 403)
  assert.equal(resCrossTenant.body?.error?.code, 'pool_unavailable')
  assert.equal(delegatedCalls, 0)

  // 2. Bypass #4: Tenant 101 `all` key + `ag-claude-sonnet-4-6` bound to pool whose only env is disabled -> 403 pool_unavailable!
  const resDisabledEnv = makeRes()
  await handler.handleProtocol(
    Object.assign(new EventEmitter(), {
      method: 'POST',
      url: '/v1/messages',
      headers: {},
      apiKeyKind: 'managed',
      apiKeyRecord: {
        id: 'key-u101-all',
        user_id: 101,
        group_type: 'all',
        permission_tier: 'tenant',
        pool_binding_mode: 'strict_pool',
        default_pool_id: 'pool_gem_disabled_env',
        allowed_pool_ids: ['pool_gem_disabled_env'],
      },
      body: { model: 'ag-claude-sonnet-4-6', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] },
    }),
    resDisabledEnv,
    'anthropic.messages',
    '/v1/messages',
  )
  assert.equal(resDisabledEnv.statusCode, 403)
  assert.equal(resDisabledEnv.body?.error?.code, 'pool_unavailable')
  assert.equal(delegatedCalls, 0)

  // 3. Defense-in-depth in gemini/routes.mjs: even if a caller attaches an incomplete `req._poolAccess`
  //    without `_geminiOwnerMapChecked`/`_geminiEnvsChecked`, handleGeminiPublic re-validates with its own geminiOwnerMap!
  const resDefense = makeRes()
  await geminiHandler(
    Object.assign(new EventEmitter(), {
      method: 'POST',
      url: '/v1/messages',
      headers: {},
      apiKeyKind: 'managed',
      apiKeyRecord: {
        id: 'key-u101-gem-defense',
        user_id: 101,
        group_type: 'gemini',
        permission_tier: 'tenant',
        pool_binding_mode: 'strict_pool',
        default_pool_id: 'pool_gem_tenant_b',
        allowed_pool_ids: ['pool_gem_tenant_b'],
      },
      _poolAccess: {
        ok: true,
        legacy: false,
        effectivePool: { id: 'pool_gem_tenant_b', jev_profile: 'inherit_global' },
        allowedGeminiEnvIds: ['env-tenant-b'],
        _geminiOwnerMapChecked: false,
        _geminiEnvsChecked: false,
      },
      body: { model: 'gemini-4-neon', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] },
    }),
    resDefense,
    { catalogSnapshot: { accounts: geminiAccounts } },
  )
  assert.equal(resDefense.statusCode, 403)
  assert.equal(resDefense.body?.error?.code, 'pool_unavailable')
  assert.equal(streamCalls, 0)
})
