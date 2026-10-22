import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import {
  bridgeName,
  isLocalEgressId,
  isLocalEgressProxy,
  localEgressIdForNode,
  localEgressNodeId,
  networkName,
  portsForProxy,
  stopProxyEgress,
} from '../../src/lib/vm/egress.mjs'

const NODES = { 'vm-ctrl': null, 'vm-a1': 'node-a', 'vm-a2': 'node-a', 'vm-b1': 'node-b' }

async function makePool(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-local-node-'))
  const pool = await new ProxyPool({ dataDir: dir, vmNodeOf: (vmId) => NODES[vmId] ?? null, ...opts }).init()
  pool.stopScheduler()
  t.after(() => {
    pool.stopScheduler()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return pool
}

test('local egress ids name their VPS and share one bridge per host', () => {
  assert.equal(localEgressIdForNode(null), 'px-local')
  assert.equal(localEgressIdForNode('node-a'), 'px-local-node-a')
  assert.equal(localEgressNodeId('px-local-node-a'), 'node-a')
  assert.equal(localEgressNodeId('px-local'), null)
  assert.equal(localEgressNodeId('px-1234'), null)
  assert.equal(isLocalEgressId('px-local-node-a'), true)
  assert.equal(isLocalEgressId('px-1234'), false)
  assert.equal(isLocalEgressProxy({ id: 'px-local-node-a' }), true)
  // Node slots keep the bridge they already run on.
  assert.equal(networkName('px-local-node-a'), networkName('px-local'))
  assert.equal(bridgeName('px-local-node-a'), bridgeName('px-local'))
  assert.deepEqual(portsForProxy('px-local-node-a'), portsForProxy('px-local'))
})

test('a generic px-local bind lands on the slot’s own VPS row, with its own capacity', async (t) => {
  const pool = await makePool(t)
  await pool.ensureLocal()
  await pool.updateConfig({ bind_limit: 1 })
  assert.equal((await pool.bind('px-local', 'vm-ctrl')).proxy.id, 'px-local')
  // The control plane is full, the node is not: capacity is per machine.
  const a1 = await pool.bind('px-local', 'vm-a1')
  assert.equal(a1.ok, true)
  assert.equal(a1.proxy.id, 'px-local-node-a')
  assert.equal(a1.proxy.node_id, 'node-a')
  assert.equal((await pool.bind('px-local', 'vm-a2')).error, 'proxy_bind_limit')
  assert.equal(pool.getProxyForVm('vm-a1').id, 'px-local-node-a')
})

test('another machine’s local row is refused', async (t) => {
  const pool = await makePool(t)
  await pool.ensureLocal()
  await pool.ensureLocalForNode('node-a')
  const wrong = await pool.bind('px-local-node-a', 'vm-b1')
  assert.equal(wrong.ok, false)
  assert.equal(wrong.error, 'local_proxy_node_mismatch')
  assert.equal(wrong.expected, 'px-local-node-b')
  assert.equal((await pool.bind('px-local-node-a', 'vm-ctrl')).error, 'local_proxy_node_mismatch')
})

test('auto-allocation only offers the slot’s own local row', async (t) => {
  const pool = await makePool(t)
  await pool.ensureLocal()
  const picked = await pool.allocateForVm('vm-b1')
  assert.equal(picked.id, 'px-local-node-b')
  assert.equal((await pool.allocateForVm('vm-ctrl')).id, 'px-local')
})

test('node rows follow the cluster and keep rows that still hold slots', async (t) => {
  const pool = await makePool(t)
  // No local egress in use: nothing is created for nodes.
  assert.deepEqual(await pool.syncLocalNodes(['node-a']), { created: [], removed: [] })
  await pool.ensureLocal()
  assert.deepEqual((await pool.syncLocalNodes(['node-a', 'node-b'])).created, ['px-local-node-a', 'px-local-node-b'])
  await pool.bind('px-local', 'vm-a1')
  const synced = await pool.syncLocalNodes([])
  assert.deepEqual(synced.removed, ['px-local-node-b'])
  assert.ok(pool.state.proxies.some((p) => p.id === 'px-local-node-a'))
  // Local rows stay grouped at the top of the pool.
  assert.ok(pool.state.proxies.slice(0, 2).every((p) => isLocalEgressProxy(p)))
})

test('slots left on the shared row move to their node row, past a full limit', async (t) => {
  const pool = await makePool(t)
  await pool.ensureLocal()
  await pool.updateConfig({ bind_limit: 1 })
  // Pre-split data: every local slot sits on px-local.
  const row = pool.state.proxies.find((p) => p.id === 'px-local')
  row.bound_vm_ids = ['vm-ctrl', 'vm-a1', 'vm-a2', 'vm-b1']
  await pool.save()
  const moves = await pool.adoptNodeLocalBindings()
  assert.deepEqual(
    moves.map((m) => `${m.vm_id}:${m.to}`),
    ['vm-a1:px-local-node-a', 'vm-a2:px-local-node-a', 'vm-b1:px-local-node-b'],
  )
  const ids = (id) => pool.state.proxies.find((p) => p.id === id).bound_vm_ids
  assert.deepEqual(ids('px-local'), ['vm-ctrl'])
  assert.deepEqual(ids('px-local-node-a'), ['vm-a1', 'vm-a2'])
  assert.deepEqual(await pool.adoptNodeLocalBindings(), [])
})

test('migration leaves ids of deleted slots alone', async (t) => {
  const pool = await makePool(t, { vmNodeOf: (vmId) => (vmId === 'vm-gone' ? undefined : (NODES[vmId] ?? null)) })
  await pool.ensureLocal()
  await pool.flush()
  pool.state.proxies.find((p) => p.id === 'px-local').bound_vm_ids = ['vm-gone', 'vm-a1']
  await pool.save()
  assert.deepEqual(
    (await pool.adoptNodeLocalBindings()).map((m) => m.vm_id),
    ['vm-a1'],
  )
})

test('a node row probes its node link; a down link marks it failed without parking slots', async (t) => {
  let healthy = true
  const disabled = []
  const pool = await makePool(t, {
    localExitHealth: (nodeId) =>
      healthy ? { ok: true, latency_ms: 42 } : { ok: false, error: `node_link_down:${nodeId}` },
    onDisableVm: (vmId) => disabled.push(vmId),
  })
  await pool.ensureLocal()
  await pool.bind('px-local', 'vm-a1')
  const row = pool.state.proxies.find((p) => p.id === 'px-local-node-a')
  const up = await pool.probeOne(row)
  assert.deepEqual(up, { ok: true, scope: 'node', mode: 'direct', latency_ms: 42 })
  healthy = false
  for (let i = 0; i < 4; i++) pool._applyProbeResult(row, await pool.probeOne(row))
  assert.equal(row.status, 'fail')
  assert.equal(row.enabled, true)
  assert.equal(row.last_error, 'node_link_down:node-a')
  assert.deepEqual(disabled, [])
  // The control plane row stays a direct route.
  const ctrl = await pool.probeOne(pool.state.proxies.find((p) => p.id === 'px-local'))
  assert.equal(ctrl.scope, 'local')
})

test('a node link still dialling leaves the row alone until it settles', async (t) => {
  let health = { pending: true, error: 'node_link_connecting' }
  const pool = await makePool(t, { localExitHealth: () => health })
  await pool.ensureLocal()
  await pool.bind('px-local', 'vm-a1')
  const row = pool.state.proxies.find((p) => p.id === 'px-local-node-a')
  pool._applyProbeResult(row, await pool.probeOne(row))
  assert.equal(row.status, 'ok')
  assert.equal(row.last_error ?? null, null)
  health = { ok: false, error: 'node_link_backoff' }
  assert.equal((await pool.probeLocalNode('node-a')).ok, false)
  assert.equal(row.status, 'fail')
  health = { ok: true, latency_ms: 30 }
  assert.equal((await pool.probeLocalNode('node-a')).ok, true)
  assert.equal(row.status, 'ok')
  assert.equal(row.latency_ms, 30)
  assert.equal(await pool.probeLocalNode('node-missing'), null)
})

test('a node row looks up its geo through that node’s route', async (t) => {
  const seen = []
  const geo = { ok: true, geo: { ip: '203.0.113.7', country: 'Japan', timezone: 'Asia/Tokyo' } }
  const pool = await makePool(t, {
    localExitUrl: (nodeId) => `socks5h://${nodeId}@127.0.0.1:1080`,
    geoLookup: async (url) => {
      seen.push(url)
      return geo
    },
    geoV6Lookup: async () => ({ ok: false, error: 'no_v6' }),
  })
  await pool.ensureLocal()
  await pool.bind('px-local', 'vm-a1')
  const r = await pool.detectGeo('px-local-node-a')
  assert.equal(r.ok, true)
  assert.equal(pool.proxyTimezone('px-local-node-a'), 'Asia/Tokyo')
  await pool.detectGeo('px-local')
  assert.deepEqual(seen, ['socks5h://node-a@127.0.0.1:1080', ''])
})

test('tearing down a node row never touches the control plane bridge', () => {
  const calls = []
  const result = stopProxyEgress('/tmp/none', 'px-local-node-a', {
    runDocker: (args) => {
      calls.push(['docker', ...args])
      return { ok: true, stdout: '' }
    },
    runIptables: (args) => {
      calls.push(['iptables', ...args])
      return { ok: true }
    },
  })
  assert.deepEqual(result, { ok: true, skipped: 'node_local' })
  assert.deepEqual(calls, [])
})

test('an operator-disabled node row stays disabled through link changes', async (t) => {
  let health = { ok: false, error: 'node_link_backoff' }
  const pool = await makePool(t, { localExitHealth: () => health })
  await pool.ensureLocal()
  await pool.bind('px-local', 'vm-a1')
  const row = pool.state.proxies.find((p) => p.id === 'px-local-node-a')
  row.enabled = false
  row.status = 'dead'
  await pool.save()
  assert.equal(await pool.probeLocalNode('node-a'), null)
  pool._applyProbeResult(row, await pool.probeOne(row))
  health = { ok: true, latency_ms: 10 }
  pool._applyProbeResult(row, await pool.probeOne(row))
  assert.equal(row.enabled, false)
  assert.equal(row.status, 'dead')
})

test('migration commits targeted bindings once without replacing the pool', async (t) => {
  const pool = await makePool(t)
  await pool.ensureLocal()
  await pool.flush()
  pool.state.proxies.find((p) => p.id === 'px-local').bound_vm_ids = ['vm-a1', 'vm-a2', 'vm-b1']
  await pool.save()
  let writes = 0
  const lockMutations = pool.repo.lockMutations.bind(pool.repo)
  pool.repo.lockMutations = () => {
    writes += 1
    return lockMutations()
  }
  pool.repo.replaceAll = () => assert.fail('runtime mutations must not replace the proxy table')
  assert.equal((await pool.adoptNodeLocalBindings()).length, 3)
  await pool.flush()
  assert.equal(writes, 1)
})

test('resolveLocalTarget lands a generic pick on the target VPS', async (t) => {
  const pool = await makePool(t)
  await pool.ensureLocal()
  assert.deepEqual(await pool.resolveLocalTarget('px-local', 'node-a'), { ok: true, id: 'px-local-node-a' })
  assert.ok(pool.state.proxies.some((p) => p.id === 'px-local-node-a'))
  assert.deepEqual(await pool.resolveLocalTarget('px-local', null), { ok: true, id: 'px-local' })
  assert.equal((await pool.resolveLocalTarget('px-local-node-a', 'node-b')).error, 'local_proxy_node_mismatch')
})
