import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { FULL_GEMINI_CAPABILITIES } from '../../src/lib/protocol/gemini-convert.mjs'
import { createMockSchedulerRuntime } from '../helpers/mock-scheduler-runtime.mjs'
import { setTimeout as sleep } from 'node:timers/promises'
import { createGeminiScheduler } from '../../src/lib/gemini/scheduler.mjs'
import { createSchedulerRuntime } from '../../src/lib/scheduler/scheduler-runtime.mjs'

function environment() {
  return {
    id: 'one',
    proxy_id: 'px',
    auth_method: 'oauth',
    auth_state: 'authorized',
    models_discovered: true,
    models: ['gemini-4-hydrogen-high', 'gemini-4-hydrogen-medium', 'claude-sonnet-4-6-high'],
    max_concurrency: 1,
    capabilities: [...FULL_GEMINI_CAPABILITIES],
    account: {
      email: 'not-for-scheduler@example.invalid',
      quotas: [],
      quota_groups: [
        {
          name: 'Gemini Models',
          windows: [
            { id: 'gemini-5h', remaining_fraction: 0.5, reset_at: new Date(Date.now() + 60_000).toISOString() },
          ],
        },
      ],
      model_catalog: [{ id: 'gemini-4-hydrogen-high', provider: 'google', quota_group: 'gemini' }],
    },
  }
}

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-real-quota-'))
  const env = environment()
  const envs = [env]
  let calls = 0
  const scheduler = createGeminiScheduler({
    callHost: async (op) => {
      if (op === 'list') return { payload_state: 'installed', environments: envs }
      if (op === 'get') return env
      throw new Error(`unexpected host operation: ${op}`)
    },
    callHostStream: async () => {
      calls++
      return Object.assign(
        Readable.from([
          'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n',
        ]),
        {
          statusCode: 200,
          headers: { 'content-type': 'text/event-stream' },
        },
      )
    },
    resolveProxy: () => 'socks5h://192.0.2.1:1080',
  })
  const refresh = async () => {
    scheduler.invalidateCatalogCache()
    await scheduler.catalog()
  }
  await refresh()
  const runtime = createSchedulerRuntime({
    getDb: () => null,
    getVms: () => [],
    getRoutingConfig: () => ({}),
    geminiScheduler: scheduler,
    telemetryIntervalMs: 0,
    clientOptions: {
      binPath: process.env.KIN_SCHEDULER_BIN,
      dataDir: dir,
      socketPath: path.join(dir, 'scheduler.sock'),
      tokenPath: path.join(dir, 'token'),
      capFile: path.join(dir, 'cap.json'),
    },
  })
  scheduler.setSchedulerRuntime(runtime)
  t.after(async () => {
    await runtime.shutdown({ drain: false, stopProcess: true })
    fs.rmSync(dir, { recursive: true, force: true })
  })
  await runtime.start({ waitMs: 5000, startLoops: false })
  await runtime.pushTelemetryNow()
  const params = (extra = {}) => ({
    originPoolId: '__virtual_gemini__',
    apiKeyKind: 'master',
    nodeTypes: ['gemini_env'],
    model: 'gemini-4-hydrogen-medium',
    sessionId: crypto.randomUUID(),
    ...extra,
  })
  return { env, envs, scheduler, runtime, params, refresh, calls: () => calls }
}

test('real scheduler projection supplies only quota/catalog metadata and M3 observes refreshes', async (t) => {
  const { env, scheduler, runtime, params, refresh } = await setup(t)
  env.account.quota_groups[0].windows[0].remaining_fraction = 0
  await refresh()
  const projected = scheduler.listEnvironments()[0].account
  assert.equal(projected?.quota_groups[0].windows[0].remaining_fraction, 0)
  assert.equal(projected.email, undefined)
  assert.deepEqual(projected.model_catalog, env.account.model_catalog)
  await assert.rejects(runtime.acquireNode(params({ noQueue: true })), { code: 'pool_exhausted' })
  const claude = await runtime.acquireNode(params({ model: 'ag-claude-sonnet-4-6-high', noQueue: true }))
  await runtime.releaseLease(claude.lease_id, 'ok')
  env.account.quota_groups[0].windows[0].remaining_fraction = 0.5
  await refresh()
  const gemini = await runtime.acquireNode(params({ noQueue: true }))
  await runtime.releaseLease(gemini.lease_id, 'ok')
})

for (const operation of ['acquire', 'switch', 'stream']) {
  test(`queued ${operation} rechecks refreshed quota and releases the rejected lease`, async (t) => {
    const { env, envs, scheduler, runtime, params, refresh, calls } = await setup(t)
    if (operation === 'switch') {
      envs.push({ ...environment(), id: 'source' })
      await refresh()
      await runtime.syncConfigNow('test-source-node')
      await runtime.pushTelemetryNow()
    }
    const queuedParams = params({ requestId: crypto.randomUUID(), allowedNodeKeys: ['gemini_env:one'] })
    const targetParams = () => params({ allowedNodeKeys: ['gemini_env:one'] })
    const held = await runtime.acquireNode(targetParams())
    let source = null
    if (operation === 'switch') {
      source = await runtime.acquireNode(params({ allowedNodeKeys: ['gemini_env:source'] }))
    }
    let settled = false
    const pending = (
      operation === 'acquire'
        ? runtime.acquireNode(queuedParams, { queueWaitMs: 4000 })
        : operation === 'stream'
          ? scheduler.stream({
              model: 'gemini-4-hydrogen-medium',
              apiKeyKind: 'master',
              geminiBody: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
            })
          : runtime.switchNode(
              { releaseLeaseId: source.lease_id, failure: { http_status: 400 }, nextAttempt: queuedParams },
              { queueWaitMs: 4000 },
            )
    ).then(
      (lease) => {
        settled = true
        return { lease }
      },
      (error) => {
        settled = true
        return { error }
      },
    )
    await sleep(100)
    assert.equal(settled, false, 'request must actually queue before the quota update')
    env.account.quota_groups[0].windows[0].remaining_fraction = 0
    await refresh()
    await runtime.pushTelemetryNow()
    await runtime.releaseLease(held.lease_id, 'ok')
    const result = await pending
    assert.equal(result.error?.code, 'gemini_quota_exhausted')
    assert.ok((result.error.retryAfterSec ?? result.error.retryAfter) > 0)
    assert.equal(calls(), 0)
    if (operation === 'stream') assert.equal(result.error.attemptCount, 0)
    // No node-wide cooldown or leaked capacity: a different bucket can acquire immediately.
    const available = await runtime.acquireNode(
      params({ model: 'ag-claude-sonnet-4-6-high', noQueue: true, allowedNodeKeys: ['gemini_env:one'] }),
    )
    await runtime.releaseLease(available.lease_id, 'ok')
  })
}

test('catalogSnapshot bootstrap also retains quota and model mapping for M3', async () => {
  const account = {
    id: 'cached',
    proxy_id: 'px',
    auth_method: 'oauth',
    models: ['gemini-4-hydrogen-high'],
    capabilities: new Set(FULL_GEMINI_CAPABILITIES),
    quotas: [{ model: 'other-model', remaining_fraction: 0 }],
    quota_groups: [{ windows: [{ id: '3p-weekly', remaining_fraction: 0 }] }],
    catalogIndex: new Map([['gemini-4-hydrogen-high', { provider: 'google', quota_group: 'gemini' }]]),
  }
  const scheduler = createGeminiScheduler({
    schedulerRuntime: createMockSchedulerRuntime(),
    callHost: async () => {
      throw new Error('host discovery must not be used for supplied catalog')
    },
    callHostStream: async () =>
      Object.assign(
        Readable.from([
          'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n',
        ]),
        { statusCode: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    resolveProxy: () => 'socks5h://192.0.2.1:1080',
  })
  await scheduler.stream({
    model: 'gemini-4-hydrogen-high',
    catalogSnapshot: { accounts: [account] },
    apiKeyKind: 'master',
    geminiBody: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
  })
  const projected = scheduler.listEnvironments()[0].account
  assert.deepEqual(projected.quotas, [{ model: 'other-model', remaining_fraction: 0, reset_at: undefined }])
  assert.equal(projected.quota_groups[0].windows[0].remaining_fraction, 0)
  assert.deepEqual(projected.model_catalog, [
    { id: 'gemini-4-hydrogen-high', provider: 'google', quota_group: 'gemini' },
  ])
})
