import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SlotgateClient } from '../../src/lib/transport/slotgate-client.mjs'
import {
  workerHealth,
  ensureWorkerCredential,
  callGoWorker,
  streamGoWorker,
  callWorkerGet,
  countTokensViaWorker,
} from '../../src/lib/transport/go-worker-client.mjs'
import {
  clearRustHealthCache,
  dispatchCallInference,
  rememberRustHealth,
  peekRustHealth,
} from '../../src/lib/transport/kernel-router.mjs'
import { fakeSlotgate, syntheticFence } from '../fixtures/fake-slotgate.mjs'

function manifest(config) {
  config.manifest = { revision: '1', digest: 'b'.repeat(64) }
  return config
}

function receipt(config) {
  return {
    intent: {
      action: 'launch',
      node_id: config.nodeId,
      vm_id: config.vmId,
      allocation_id: 'synthetic-allocation',
      operation_id: 'synthetic-operation',
      owner_id: 'synthetic-owner',
      command_id: 'synthetic-launch',
      epoch: '1',
      fence: { generation: 1, incarnation: config.fence.incarnation, executor: { kind: '', node_boot_id: '' } },
      expected_manifest_revision: '1',
      manifest_revision: '1',
      payload_digest: '',
      preset_id: 'claude-docker-v1',
      policy_digest: 'c'.repeat(64),
      manifest_digest: config.manifest.digest,
    },
    intent_digest: 'd'.repeat(64),
    manifest_revision: '1',
    manifest_digest: config.manifest.digest,
    fence: structuredClone(config.fence),
  }
}

async function capture(config, patch = {}) {
  const { captureNodeExecution } = await import('../../src/lib/cluster/node-execution-capabilities.mjs')
  return captureNodeExecution({
    db: { schema: 'synthetic_capability' },
    vmId: config.vmId,
    accountId: 'synthetic-account',
    trustedNodes: { [config.nodeId]: { ...config.link, presetId: 'claude-docker-v1', policyDigest: 'c'.repeat(64) } },
    readLaunchReceipt: async () => receipt(config),
    ...patch,
  })
}

test('capture obtains the original ACTIVE fence from the PG receipt and confirms the same node account', async (t) => {
  const fx = await fakeSlotgate(t)
  manifest(fx.config)
  const result = await capture(fx.config)
  assert.deepEqual(result.slotgate.fence, syntheticFence())
  assert.equal(result.workerStatus.ok, true)
  assert.equal(result.accountId, 'synthetic-account')
  assert.equal(result.nodeManifest.epoch, '1')
  assert.equal(Object.isFrozen(result.slotgate.link), true)
  assert.equal(Object.isFrozen(result.slotgate.fence.executor), true)
  assert.deepEqual(
    fx.requests.map((value) => value.op),
    ['health'],
  )
  assert.equal(fx.requests[0].manifest_revision, '1')
  assert.equal(fx.requests[0].manifest_digest, 'b'.repeat(64))
})

test('capture rejects missing PG proof and untrusted links before a node request', async (t) => {
  const fx = await fakeSlotgate(t)
  manifest(fx.config)
  await assert.rejects(capture(fx.config, { readLaunchReceipt: async () => null }), {
    code: 'node_capability_unavailable',
  })
  await assert.rejects(capture(fx.config, { trustedNodes: {} }), { code: 'node_capability_unavailable' })
  await assert.rejects(capture(fx.config, { nodeId: 'other-node' }), { code: 'node_capability_unavailable' })
  await assert.rejects(
    capture(fx.config, {
      trustedNodes: { [fx.config.nodeId]: { ...fx.config.link, presetId: 'codex', policyDigest: 'c'.repeat(64) } },
    }),
    { code: 'node_capability_unavailable' },
  )
  assert.equal(fx.requests.length, 0)
})

test('capture does not adopt a fresh PG receipt after its original node health check', async (t) => {
  const fx = await fakeSlotgate(t)
  manifest(fx.config)
  let reads = 0
  await assert.rejects(
    capture(fx.config, {
      readLaunchReceipt: async () => {
        const value = receipt(fx.config)
        if (++reads > 1) value.intent.epoch = '2'
        return value
      },
    }),
    { code: 'node_capability_changed' },
  )
  assert.equal(reads, 2)
  assert.deepEqual(
    fx.requests.map((value) => value.op),
    ['health'],
  )
})

test('capture refuses a different account without preparing inference', async (t) => {
  const fx = await fakeSlotgate(t)
  manifest(fx.config)
  await assert.rejects(capture(fx.config, { accountId: 'other-account' }), { code: 'node_account_mismatch' })
  assert.deepEqual(
    fx.requests.map((value) => value.op),
    ['health'],
  )
})

test('capture snapshots fixed TLS configuration before awaiting the PG receipt', async (t) => {
  const fx = await fakeSlotgate(t)
  manifest(fx.config)
  const trustedNodes = new Map([
    [fx.config.nodeId, { ...fx.config.link, presetId: 'claude-docker-v1', policyDigest: 'c'.repeat(64) }],
  ])
  let resume
  const blocked = new Promise((resolve) => {
    resume = resolve
  })
  let reads = 0
  const pending = capture(fx.config, {
    trustedNodes,
    readLaunchReceipt: async () => {
      if (++reads === 1) await blocked
      return receipt(fx.config)
    },
  })
  // Wait until capture has entered its original lookup, not until node IO.
  await new Promise((resolve) => setImmediate(resolve))
  trustedNodes.get(fx.config.nodeId).certSha256 = '0'.repeat(64)
  resume()
  const result = await pending
  assert.equal(result.slotgate.link.certSha256, fx.config.link.certSha256)
})

for (const account of [undefined, null, '', 'other-account']) {
  test(`capture does not authorize account by display email or conflicting identity (${account})`, async (t) => {
    const fx = await fakeSlotgate(t, {
      health: (command) => ({
        ok: true,
        fence: command.fence,
        manifest_revision: command.manifest_revision,
        manifest_digest: command.manifest_digest,
        health: {
          ok: true,
          credential: { has_access: true, account_uuid: account, email: 'synthetic-account' },
          identity: { account_uuid: 'synthetic-account' },
        },
      }),
    })
    manifest(fx.config)
    await assert.rejects(capture(fx.config), { code: 'node_account_mismatch' })
    assert.deepEqual(
      fx.requests.map((value) => value.op),
      ['health'],
    )
  })
}

test('a PG receipt failure has no TLS or legacy fallback', async (t) => {
  const fx = await fakeSlotgate(t)
  manifest(fx.config)
  await assert.rejects(
    capture(fx.config, {
      readLaunchReceipt: async () => {
        throw Object.assign(new Error('synthetic PG failure'), { code: 'synthetic_pg_failure' })
      },
    }),
    { code: 'synthetic_pg_failure' },
  )
  assert.equal(fx.requests.length, 0)
})

test('health cache separates captured fences and manifests and VM invalidation clears each', async () => {
  clearRustHealthCache()
  const first = {
    vmId: 'cache-vm',
    slotgate: { fence: syntheticFence(), manifest: { revision: '1', digest: 'a'.repeat(64) } },
  }
  rememberRustHealth(first, { ok: true, health: { ok: true } })
  assert.equal(peekRustHealth(first, 1000).health.ok, true)
  const next = { ...first, slotgate: { ...first.slotgate, fence: syntheticFence('2') } }
  assert.equal(peekRustHealth(next, 1000), null)
  const changedManifest = {
    ...first,
    slotgate: { ...first.slotgate, manifest: { revision: '2', digest: 'b'.repeat(64) } },
  }
  assert.equal(peekRustHealth(changedManifest, 1000), null)
  clearRustHealthCache('cache-vm')
  assert.equal(peekRustHealth(first, 1000), null)
})

test('typed health returns only public fields and never needs a Pod kernel token', async (t) => {
  const fx = await fakeSlotgate(t, {
    health: (command) => ({
      ok: true,
      fence: command.fence,
      manifest_revision: command.manifest_revision,
      manifest_digest: command.manifest_digest,
      health: {
        ok: true,
        engine: 'rust',
        ready_slots: 2,
        healthy: true,
        internal_token: 'must-not-escape',
        credential: {
          has_access: true,
          has_refresh: true,
          generation: 'g1',
          expires_at: 1981929600000,
          account_uuid: 'synthetic-account',
          org_uuid: 'synthetic-org',
          email: 'synthetic@example.invalid',
          access_token: 'must-not-escape',
          refresh_token: 'must-not-escape',
          provider_extension: { secret: 'must-not-escape' },
        },
      },
    }),
  })
  const config = manifest(fx.config)
  const value = await workerHealth({ vmId: config.vmId, slotgate: config })
  assert.equal(value.ok, true)
  assert.equal(value.credential.account_uuid, 'synthetic-account')
  assert.equal(JSON.stringify(value).includes('must-not-escape'), false)
  assert.deepEqual(
    fx.requests.map((entry) => entry.op),
    ['health'],
  )
})

for (const kind of ['fence', 'manifest', 'missing']) {
  test(`typed health rejects ${kind} proof and never prepares inference`, async (t) => {
    const fx = await fakeSlotgate(t, {
      health: (command) =>
        kind === 'missing'
          ? { ok: true, health: { ok: true } }
          : {
              ok: true,
              fence: kind === 'fence' ? syntheticFence('2') : command.fence,
              manifest_revision: kind === 'manifest' ? '2' : command.manifest_revision,
              manifest_digest: command.manifest_digest,
              health: { ok: true, healthy: true, ready_slots: 1 },
            },
    })
    manifest(fx.config)
    const value = await workerHealth({ vmId: fx.config.vmId, slotgate: fx.config })
    assert.equal(value.ok, false)
    assert.equal(value.code, 'slotgate_health_unconfirmed')
    assert.deepEqual(
      fx.requests.map((entry) => entry.op),
      ['health'],
    )
  })
}

test('typed health observes cancellation without a legacy cancel request', async (t) => {
  const fx = await fakeSlotgate(t, { holdHealth: true })
  const client = new SlotgateClient(manifest(fx.config))
  const controller = new AbortController()
  const pending = client.health({ signal: controller.signal, timeoutMs: 1000 })
  setTimeout(() => controller.abort(), 40)
  await assert.rejects(pending, { code: 'ABORT_ERR' })
  assert.equal(
    fx.requests.every((value) => value.op === 'health'),
    true,
  )
})

test('fenced router never creates Pod credential links or reads a host kernel binary', async (t) => {
  clearRustHealthCache()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-node-router-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const fx = await fakeSlotgate(t)
  const config = manifest(fx.config)
  const homeDir = path.join(root, 'forbidden-home')
  const result = await dispatchCallInference({
    exec: { vmId: config.vmId, homeDir, slotgate: config, vm: { id: config.vmId } },
    envelope: { body: {} },
    onExecutionStart: async (value) => ({ bound: true, requestId: value.requestId, nodeBinding: value.nodeBinding }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.execution.ended, true)
  assert.equal(fs.existsSync(homeDir), false)
  assert.deepEqual(
    fx.requests.map((value) => value.op),
    ['health', 'prepare', 'forward', 'command'],
  )
})

test('fenced credential ensure fails before touching a Pod credential file', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-node-credential-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const fx = await fakeSlotgate(t)
  const homeDir = path.join(root, 'forbidden-home')
  const result = await ensureWorkerCredential({ vmId: fx.config.vmId, homeDir, slotgate: manifest(fx.config) })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'slotgate_route_unavailable')
  assert.equal(result.credentialRefreshNotStarted, true)
  assert.equal(fs.existsSync(homeDir), false)
  assert.equal(fx.requests.length, 0)
})

test('HA transport refuses a missing trusted capability before mock or legacy execution', async () => {
  const before = process.env.VM2API_CONTROL_PLANE_MODE
  const beforeMock = process.env.KIN_CRS_MOCK
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes-ha'
  process.env.KIN_CRS_MOCK = '1'
  try {
    await assert.rejects(callGoWorker({ exec: { vmId: 'legacy-vm' }, envelope: { body: {} } }), {
      code: 'slotgate_capability_required',
    })
    await assert.rejects(streamGoWorker({ exec: { vmId: 'legacy-vm' }, envelope: { body: {} } }), {
      code: 'slotgate_capability_required',
    })
    await assert.rejects(callWorkerGet({ vmId: 'legacy-vm' }, '/internal/v1/models'), {
      code: 'slotgate_capability_required',
    })
    await assert.rejects(countTokensViaWorker({ vmId: 'legacy-vm' }, { body: {} }), {
      code: 'slotgate_capability_required',
    })
  } finally {
    if (before == null) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = before
    if (beforeMock == null) delete process.env.KIN_CRS_MOCK
    else process.env.KIN_CRS_MOCK = beforeMock
  }
})
