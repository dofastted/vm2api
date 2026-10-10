import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'

function fixture(t, { vms = [], nodes = ['node-a', 'node-b'], ...options } = {}) {
  const db = createDatabase({ dbPath: ':memory:' })
  const nodeRows = nodes.map((id) => ({ id, name: id.toUpperCase(), link: { state: 'ready' } }))
  const config = {
    db,
    listVms: () => vms,
    listNodes: () => nodeRows,
    nodeExitProxyUrl: (id) => `socks5h://${id}:secret@127.0.0.1:1080`,
    geoLookup: async () => ({ ok: true, geo: { ip: '192.0.2.1', timezone: 'Etc/UTC' } }),
    geoV6Lookup: async () => ({ ok: false, error: 'no_ipv6' }),
    ...options,
  }
  const pool = new ProxyPool(config)
  t.after(() => {
    pool.stopScheduler()
    db.close()
  })
  pool.ensureLocal()
  return { pool, config, vms, nodeRows }
}

test('legacy px-local bindings project to node exits without changing persisted or runtime ids', (t) => {
  const { pool } = fixture(t, {
    vms: [{ id: 'main' }, { id: 'a', node_id: 'node-a' }, { id: 'lost', node_id: 'removed-node' }],
  })
  // A historical single row also includes a VM whose record is missing.
  pool.state.proxies[0].bound_vm_ids = ['main', 'a', 'lost', 'orphan']
  pool.save()
  const snap = pool.snapshot()
  assert.deepEqual(
    snap.proxies.map((p) => p.id),
    ['px-local'],
  )
  assert.deepEqual(snap.proxies[0].bound_vm_ids, ['main', 'a', 'lost', 'orphan'])
  const byNode = new Map(snap.local_exits.map((p) => [p.node_id, p]))
  assert.deepEqual(byNode.get(null).bound_vm_ids, ['main', 'orphan'])
  assert.deepEqual(byNode.get('node-a').bound_vm_ids, ['a'])
  assert.deepEqual(byNode.get('node-b').bound_vm_ids, [])
  assert.deepEqual(byNode.get('removed-node').bound_vm_ids, ['lost'])
  assert.equal(byNode.get('removed-node').blocked_reason, 'node_unavailable')
  assert.equal(byNode.get('node-a').node_name, 'NODE-A')
  assert.equal(new Set(snap.local_exits.map((p) => p.view_id)).size, 4)
  assert.equal(snap.totals.slots_cap, 20)
  assert.equal(snap.totals.slots_used, 4)
  assert.deepEqual(pool.snapshot({ nodeId: 'node-a' }).proxies[0].bound_vm_ids, ['a'])
  assert.equal(pool.getProxyForVm('a').id, 'px-local')
  assert.equal(pool.bind(byNode.get('node-a').view_id, 'main').error, 'proxy_not_found')
  assert.deepEqual(pool.snapshot({ ownerUserId: 'tenant' }).local_exits, [])
})

test('local limits, allocation and restart recovery use VM placement; SOCKS remains shared', (t) => {
  const { pool, vms } = fixture(t)
  pool.state.config.bind_limit = 2
  for (const nodeId of [null, 'node-a', 'node-b']) {
    for (let i = 0; i < 3; i++) vms.push({ id: `${nodeId || 'main'}-${i}`, node_id: nodeId })
  }
  for (const nodeId of [null, 'node-a', 'node-b']) {
    const prefix = nodeId || 'main'
    assert.equal(pool.bind('px-local', `${prefix}-0`).ok, true)
    assert.equal(pool.allocateForVm(`${prefix}-1`).id, 'px-local')
    assert.equal(pool.bind('px-local', `${prefix}-2`).error, 'proxy_bind_limit')
    assert.equal(pool.ensureBoundToVm(`${prefix}-0`, 'px-local').id, 'px-local')
  }
  const socks = pool.importLines('192.0.2.10:1080').items[0].id
  assert.equal(pool.bind(socks, 'main-2').ok, true)
  assert.equal(pool.bind(socks, 'node-a-2').ok, true)
  assert.equal(pool.bind(socks, 'node-b-2').error, 'proxy_bind_limit')
  assert.equal(pool.bind('px-local', 'node-a-2').error, 'proxy_bind_limit')
  assert.equal(pool.getProxyForVm('node-a-2').id, socks, 'rejected move preserves old binding')
  assert.equal(pool.proxyForVm('px-local', 'node-a-2').bound_count, 2)
})

test('more than 32 local bindings across nodes survive save and reload', (t) => {
  const nodes = Array.from({ length: 8 }, (_, i) => `node-${i}`)
  const vms = nodes.flatMap((node_id) => Array.from({ length: 5 }, (_, i) => ({ id: `${node_id}-${i}`, node_id })))
  const { pool, config } = fixture(t, { nodes, vms })
  for (const vm of vms) assert.equal(pool.bind('px-local', vm.id).ok, true)
  const restored = new ProxyPool(config)
  assert.equal(restored.snapshot().proxies[0].bound_count, 40)
  assert.equal(restored.snapshot().totals.slots_used, 40)
  assert.equal(
    restored
      .snapshot()
      .local_exits.filter((p) => p.node_id)
      .every((p) => p.bound_count === 5),
    true,
  )
  for (const vm of vms) assert.equal(restored.getProxyForVm(vm.id).id, 'px-local')
})

test('scoped unbind cannot affect another node and global unbind remains compatible', (t) => {
  const vms = [{ id: 'main' }, { id: 'a', node_id: 'node-a' }, { id: 'b', node_id: 'node-b' }]
  const { pool } = fixture(t, { vms })
  for (const vm of vms) assert.equal(pool.bind('px-local', vm.id).ok, true)
  assert.equal(pool.bind('px-local', 'a', { nodeId: 'node-b' }).error, 'proxy_node_mismatch')
  assert.equal(pool.unbind('px-local', 'a', { nodeId: null }).error, 'proxy_node_mismatch')
  const result = pool.unbind('px-local', null, { nodeId: 'node-a' })
  assert.deepEqual(result.unbound_vm_ids, ['a'])
  assert.equal(result.proxy.node_id, 'node-a')
  assert.deepEqual(pool.snapshot().proxies[0].bound_vm_ids, ['main', 'b'])
  assert.deepEqual(pool.unbind('px-local').unbound_vm_ids, ['main', 'b'])
})

test('node geo and probes use that node; failures do not mutate the shared row or sibling diagnostics', async (t) => {
  const calls = []
  const disabled = []
  const { pool, nodeRows } = fixture(t, {
    geoLookup: async (url) => {
      calls.push(url)
      return url.includes('node-b')
        ? { ok: false, error: 'node_b_unreachable' }
        : { ok: true, geo: { ip: url ? '192.0.2.2' : '192.0.2.1', timezone: 'Etc/UTC' } }
    },
    onDisableVm: (...args) => disabled.push(args),
  })
  await pool.detectGeo('px-local', { nodeId: null })
  await pool.detectGeo('px-local', { nodeId: 'node-a' })
  assert.equal((await pool.detectGeo('px-local', { nodeId: 'node-a' })).cached, true)
  assert.equal(calls.length, 2)
  assert.equal(pool.snapshot({ nodeId: null }).proxies[0].geo.ip, '192.0.2.1')
  assert.equal(pool.snapshot({ nodeId: 'node-a' }).proxies[0].geo.ip, '192.0.2.2')
  assert.equal(pool.snapshot({ nodeId: 'node-b' }).proxies[0].geo, null)
  assert.equal((await pool.probeById('px-local', { nodeId: 'node-a' })).probe.ok, true)
  assert.equal((await pool.probeById('px-local', { nodeId: 'node-b' })).probe.ok, false)
  assert.equal(pool.snapshot({ nodeId: 'node-a' }).proxies[0].status, 'ok')
  assert.equal(pool.snapshot({ nodeId: 'node-b' }).proxies[0].status, 'fail')
  assert.equal(pool.state.proxies[0].status, 'ok')
  assert.deepEqual(disabled, [])
  nodeRows[0].link.state = 'disconnected'
  const before = calls.length
  assert.equal((await pool.probeById('px-local', { nodeId: 'node-a' })).probe.error, 'node_unavailable')
  assert.equal((await pool.detectGeo('px-local', { nodeId: 'node-a' })).error, 'node_unavailable')
  assert.equal(calls.length, before, 'disconnected nodes never fall back to the control plane')
  nodeRows[0].link.state = 'ready'
  assert.equal(pool.snapshot({ nodeId: 'node-a' }).proxies[0].status, 'unknown')
})

test('local runtime disconnect and probe recovery stay within the affected node', async (t) => {
  const disconnected = []
  const enabled = []
  const vms = [
    { id: 'main' },
    { id: 'a1', node_id: 'node-a' },
    { id: 'a2', node_id: 'node-a' },
    { id: 'b', node_id: 'node-b' },
  ]
  const { pool } = fixture(t, {
    vms,
    onDisconnectVm: (id) => disconnected.push(id),
    onEnableVm: (id) => enabled.push(id),
  })
  pool.state.config.disconnect_on_error = true
  for (const vm of vms) pool.bind('px-local', vm.id)
  pool.reportRuntimeFailure('a1', 'proxy_transport_failure')
  assert.deepEqual(disconnected, ['a1', 'a2'])
  assert.equal(pool.state.proxies[0].status, 'ok')
  await pool.probeById('px-local', { nodeId: null })
  assert.deepEqual(enabled, [], 'control-plane probe cannot recover a failing node')
  await pool.probeById('px-local', { nodeId: 'node-a' })
  assert.deepEqual(enabled, ['a1', 'a2'])
  pool.reportRuntimeFailure('main', 'proxy_transport_failure')
  assert.deepEqual(disconnected, ['a1', 'a2', 'main'])
  await pool.probeById('px-local', { nodeId: 'node-b' })
  assert.deepEqual(enabled, ['a1', 'a2'])
  await pool.probeById('px-local', { nodeId: null })
  assert.deepEqual(enabled, ['a1', 'a2', 'main'])
  pool.setEnabled('px-local', false)
  await pool.probeById('px-local', { nodeId: 'node-a' })
  await pool.probeById('px-local', { nodeId: null })
  assert.equal(pool.state.proxies[0].enabled, false, 'probes preserve the explicit global disable')
  assert.deepEqual(enabled, ['a1', 'a2', 'main'])
})

test('a node probe recovers persisted proxy failures after restart without touching manual pauses', async (t) => {
  const enabled = []
  const vms = [
    { id: 'a', node_id: 'node-a', schedule_disabled_reason: 'proxy_disconnect:transport|proxy=px-local' },
    { id: 'manual', node_id: 'node-a', schedule_disabled_reason: 'manual_pause' },
    { id: 'b', node_id: 'node-b', schedule_disabled_reason: 'proxy_disconnect:transport|proxy=px-local' },
  ]
  const { pool } = fixture(t, { vms, onEnableVm: (id) => enabled.push(id) })
  for (const vm of vms) pool.bind('px-local', vm.id)
  await pool.probeById('px-local', { nodeId: 'node-a' })
  assert.deepEqual(enabled, ['a'])
})

test('runtime proxy lookup reads only the target local VM and never enumerates VM files', (t) => {
  const vms = [{ id: 'main' }, { id: 'a', node_id: 'node-a' }, { id: 'socks-vm', node_id: 'node-b' }]
  const { pool, nodeRows } = fixture(t, { vms })
  pool.bind('px-local', 'main')
  pool.bind('px-local', 'a')
  const socks = pool.importLines('192.0.2.10:1080').items[0].id
  pool.bind(socks, 'socks-vm')
  const placementReads = []
  pool.getVmNodeId = (id) => {
    placementReads.push(id)
    return vms.find((vm) => vm.id === id)?.node_id
  }
  pool.listVms = () => assert.fail('runtime lookup must not enumerate VM records')
  assert.equal(pool.getProxyForVm('socks-vm').id, socks)
  assert.deepEqual(placementReads, [])
  assert.equal(pool.getProxyForVm('main').id, 'px-local')
  assert.equal(pool.getProxyForVm('a').id, 'px-local')
  assert.deepEqual(placementReads, ['main', 'a'])
  nodeRows[0].link.state = 'disconnected'
  assert.equal(pool.getProxyForVm('a'), null)
})

test('restart never replaces an unavailable node local exit with a free SOCKS proxy', (t) => {
  const vm = { id: 'a', node_id: 'node-a', proxy: { id: 'px-local', scheme: 'local' } }
  const { pool, nodeRows } = fixture(t, { vms: [vm] })
  const socks = pool.importLines('192.0.2.10:1080').items[0].id
  nodeRows[0].link.state = 'disconnected'
  assert.equal(pool.ensureBoundToVm(vm.id, vm.proxy.id), null)
  assert.deepEqual(
    pool.snapshot().proxies.flatMap((p) => p.bound_vm_ids),
    [],
  )
  assert.equal(vm.proxy.id, 'px-local')
  nodeRows[0].link.state = 'ready'
  assert.equal(pool.ensureBoundToVm(vm.id, vm.proxy.id).id, 'px-local')
  nodeRows[0].link.state = 'disconnected'
  assert.equal(pool.ensureBoundToVm(vm.id), null)
  assert.deepEqual(pool.snapshot().proxies.find((p) => p.id === 'px-local').bound_vm_ids, [vm.id])
  assert.deepEqual(pool.snapshot().proxies.find((p) => p.id === socks).bound_vm_ids, [])
})
