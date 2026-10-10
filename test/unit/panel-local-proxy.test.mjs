import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { buildDashboard, buildVmDetail, buildVmList, publicAllocatedProxy } from '../../src/lib/admin/panel-api.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { bindVmProxy, getVm, listVms } from '../../src/lib/vm/vm-registry.mjs'

function fixture(t, { bindLimit = 5 } = {}) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-local-'))
  const db = createDatabase({ dbPath: ':memory:' })
  const nodes = [
    { id: 'node-a', name: 'Node A', host: '192.0.2.10', link: { state: 'ready' } },
    { id: 'node-b', name: 'Node B', host: '192.0.2.20', link: { state: 'ready' } },
  ]
  const preflights = []
  const preflightOptions = []
  const pool = new ProxyPool({
    db,
    listVms: () => listVms(project),
    listNodes: () => nodes,
    nodeExitProxyUrl: (nodeId) => `socks5h://${nodeId}:test@127.0.0.1:1080`,
    geoLookup: async () => ({ ok: false, error: 'offline' }),
    geoV6Lookup: async () => ({ ok: false, error: 'offline' }),
  })
  pool.ensureLocal()
  pool.updateConfig({ bind_limit: bindLimit, enabled: false })
  pool.stopScheduler()
  t.after(() => {
    pool.stopScheduler()
    db.close()
    fs.rmSync(project, { recursive: true, force: true })
  })
  const cfg = { paths: { project }, rewrite: { enabled: false }, base_url: 'http://127.0.0.1' }
  const accountQuota = {
    config: { safety_ratio: 0.95 },
    snapshot: () => ({ accounts: [], safety_ratio: 0.95 }),
  }

  function writeVm(id, nodeId = null, extra = {}) {
    const vm = {
      id,
      name: id,
      node_id: nodeId,
      status: 'stopped',
      timezone: 'Asia/Tokyo',
      timezone_source: 'manual',
      claude: {},
      policy: {},
      proxy: null,
      ...extra,
    }
    const dir = path.join(project, 'vms')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(vm))
    return vm
  }

  function bind(id, proxyId = 'px-local') {
    const result = pool.bind(proxyId, id)
    assert.equal(result.ok, true, JSON.stringify(result))
    bindVmProxy(project, id, pool.getProxyForVm(id))
  }

  async function request(method, pathname, body = {}, { role = 'admin', userId = null } = {}) {
    const response = {}
    const handler = createPanelHandler({
      cfg,
      accountQuota,
      proxyPool: pool,
      routingConfig: {},
      requireAuth(req) {
        req.panelUser = role === 'admin' ? 'admin' : 'reader'
        req.panelRole = role
        req.panelUserId = userId
        return true
      },
      json(_res, status, payload) {
        response.status = status
        response.body = payload
        return true
      },
      readBody: async () => {
        if (body instanceof Error) throw body
        return body
      },
      preflightNode: async (nodeId, options) => {
        preflights.push(nodeId)
        preflightOptions.push(options)
        assert.ok(nodes.some((node) => node.id === nodeId))
        return { ok: true, node_id: nodeId, checks: [], image: { present: true } }
      },
    })
    await handler({ method }, {}, new URL(pathname, 'http://localhost'))
    return response
  }

  return { project, cfg, accountQuota, pool, nodes, preflights, preflightOptions, writeVm, bind, request }
}

for (const [occupiedNode, targetNode] of [
  [null, 'node-a'],
  ['node-a', null],
]) {
  test(`create checks local capacity on ${targetNode || 'the control plane'} independently`, async (t) => {
    const f = fixture(t, { bindLimit: 1 })
    f.writeVm('vm-occupied', occupiedNode)
    f.bind('vm-occupied')

    const created = await f.request('POST', '/api/panel/vms/create', {
      id: 'vm-new',
      node_id: targetNode,
      proxy_id: 'px-local',
      start: false,
      timezone: 'Asia/Tokyo',
    })
    assert.equal(created.status, 200, JSON.stringify(created.body))
    assert.equal(created.body.data.proxy_error, undefined)
    assert.equal(getVm(f.project, 'vm-new').node_id || null, targetNode)
    assert.equal(getVm(f.project, 'vm-new').proxy.id, 'px-local')
    assert.equal(created.body.data.allocated_proxy.node_id, targetNode)
    assert.equal(created.body.data.allocated_proxy.bound_count, 1)
    assert.deepEqual(created.body.data.allocated_proxy.bound_vm_ids, ['vm-new'])
    assert.equal(created.body.data.allocated_proxy.url, undefined)
    assert.equal(f.pool.getProxyForVm('vm-occupied').id, 'px-local')
    assert.deepEqual(f.preflights, targetNode ? [targetNode] : [])

    const full = await f.request('POST', '/api/panel/vms/create', {
      id: 'vm-overflow',
      node_id: targetNode,
      proxy_id: 'px-local',
      start: false,
      timezone: 'Asia/Tokyo',
    })
    assert.equal(full.status, 409, JSON.stringify(full.body))
    assert.equal(getVm(f.project, 'vm-overflow'), null, 'capacity rejection must happen before creating the VM')
  })
}

test('remote KVM creation keeps node local capacity and forwards runtime to preflight', async (t) => {
  const f = fixture(t, { bindLimit: 1 })
  f.writeVm('vm-control')
  f.bind('vm-control')

  const created = await f.request('POST', '/api/panel/vms/create', {
    id: 'vm-kvm',
    node_id: 'node-a',
    proxy_id: 'px-local',
    kernel: 'ubuntu-24.04',
    runtime_type: 'kvm',
    machine: { memory: '4g', vcpus: 4, disk_gb: 40 },
    locale: 'ja_JP.UTF-8',
    timezone: 'Asia/Tokyo',
    start: false,
  })

  assert.equal(created.status, 200, JSON.stringify(created.body))
  assert.equal(created.body.data.proxy_error, undefined)
  assert.deepEqual(f.preflights, ['node-a'])
  assert.deepEqual(f.preflightOptions, [{ kernel: 'ubuntu-24.04', runtime: 'kvm' }])
  const saved = getVm(f.project, 'vm-kvm')
  assert.equal(saved.node_id, 'node-a')
  assert.equal(saved.runtime.type, 'kvm')
  assert.equal(saved.machine.memory, '4g')
  assert.equal(saved.machine.vcpus, 4)
  assert.equal(saved.machine.disk_gb, 40)
  assert.equal(saved.locale, 'ja_JP.UTF-8')
  assert.equal(saved.fingerprint.locale, 'ja_JP.UTF-8')
  assert.equal(saved.proxy.id, 'px-local')
  assert.equal(created.body.data.vm.runtime_type, 'kvm')
  assert.deepEqual(created.body.data.vm.machine, saved.machine)
  const allocated = created.body.data.allocated_proxy
  assert.equal(allocated.node_id, 'node-a')
  assert.equal(allocated.bound_count, 1)
  assert.equal(allocated.bind_limit, 1)
  assert.deepEqual(allocated.bound_vm_ids, ['vm-kvm'])
  const control = f.pool.snapshot({ nodeId: null }).proxies.find((proxy) => proxy.id === 'px-local')
  assert.equal(control.bound_count, 1)
  assert.equal(control.bind_limit, 1)
  assert.deepEqual(control.bound_vm_ids, ['vm-control'])
  assert.equal(f.pool.getProxyForVm('vm-control').id, 'px-local')
})

test('a bind request cannot use a different local scope from the VM placement', async (t) => {
  const f = fixture(t)
  const socks = f.pool.importLines('192.0.2.30:1080').items[0].id
  f.writeVm('vm-a', 'node-a')
  f.bind('vm-a', socks)
  const before = fs.readFileSync(path.join(f.project, 'vms', 'vm-a.json'), 'utf8')

  for (const nodeId of [null, 'node-b']) {
    const response = await f.request('POST', '/api/panel/proxies/px-local/bind', {
      vm_id: 'vm-a',
      node_id: nodeId,
    })
    assert.equal(response.status, 400, JSON.stringify(response.body))
    assert.equal(f.pool.getProxyForVm('vm-a').id, socks, 'rejected bind must preserve the previous pool binding')
    assert.equal(fs.readFileSync(path.join(f.project, 'vms', 'vm-a.json'), 'utf8'), before)
  }

  const bound = await f.request('POST', '/api/panel/proxies/px-local/bind', {
    vm_id: 'vm-a',
    node_id: 'node-a',
  })
  assert.equal(bound.status, 200, JSON.stringify(bound.body))
  assert.equal(bound.body.data.proxy.node_id, 'node-a')
  assert.equal(getVm(f.project, 'vm-a').proxy.id, 'px-local')
  assert.deepEqual(f.pool.snapshot().proxies.find((proxy) => proxy.id === socks).bound_vm_ids, [])
})

test('scoped unbind-all clears only that node in both the pool and VM records', async (t) => {
  const f = fixture(t)
  for (const [id, nodeId] of [
    ['vm-local', null],
    ['vm-a1', 'node-a'],
    ['vm-a2', 'node-a'],
    ['vm-b', 'node-b'],
  ]) {
    f.writeVm(id, nodeId)
    f.bind(id)
  }
  const keep = ['vm-local', 'vm-b'].map((id) => [
    id,
    fs.readFileSync(path.join(f.project, 'vms', `${id}.json`), 'utf8'),
  ])
  const response = await f.request('POST', '/api/panel/proxies/px-local/unbind', { node_id: 'node-a' })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  for (const id of ['vm-a1', 'vm-a2']) {
    assert.equal(f.pool.getProxyForVm(id), null)
    assert.equal(getVm(f.project, id).proxy, null)
    assert.equal(getVm(f.project, id).schedule_disabled_reason, 'proxy_required')
  }
  for (const [id, before] of keep) {
    assert.equal(f.pool.getProxyForVm(id).id, 'px-local')
    assert.equal(fs.readFileSync(path.join(f.project, 'vms', `${id}.json`), 'utf8'), before)
  }
})

test('a scoped unbind cannot remove a VM on a different node', async (t) => {
  const f = fixture(t)
  f.writeVm('vm-a', 'node-a')
  f.bind('vm-a')
  const before = fs.readFileSync(path.join(f.project, 'vms', 'vm-a.json'), 'utf8')
  const response = await f.request('POST', '/api/panel/proxies/px-local/unbind', {
    node_id: 'node-b',
    vm_id: 'vm-a',
  })
  assert.ok(response.status >= 400 && response.status < 500, JSON.stringify(response.body))
  assert.equal(f.pool.getProxyForVm('vm-a').id, 'px-local')
  assert.equal(fs.readFileSync(path.join(f.project, 'vms', 'vm-a.json'), 'utf8'), before)
})

test('dashboard, VM list and detail use local metadata for the VM actual node', async (t) => {
  t.mock.method(os, 'uptime', () => 3600)
  const f = fixture(t)
  for (const [id, nodeId] of [
    ['vm-local', null],
    ['vm-a1', 'node-a'],
    ['vm-a2', 'node-a'],
    ['vm-b', 'node-b'],
  ]) {
    f.writeVm(id, nodeId)
    f.bind(id)
  }
  const local = f.pool.state.proxies.find((proxy) => proxy.id === 'px-local')
  local.geo_ip = '198.51.100.1'
  local.geo_country = 'Japan'
  local.geo_country_code = 'JP'
  local.geo_timezone = 'Asia/Tokyo'
  local.geo_checked_at = '2026-01-01T00:00:00Z'
  local.latency_ms = 17
  f.pool.save()

  const dashboard = await buildDashboard({
    cfg: f.cfg,
    accountQuota: f.accountQuota,
    stickyRouter: { stats: () => ({ active_sessions: 0 }) },
    routingConfig: {},
    stats: {},
    proxyPool: f.pool,
  })
  const listed = await buildVmList({ cfg: f.cfg, accountQuota: f.accountQuota, routingConfig: {}, proxyPool: f.pool })
  const nodeAView = f.pool.snapshot().local_exits.find((row) => row.node_id === 'node-a')
  assert.ok(nodeAView?.view_id)
  for (const vms of [dashboard.data.vms, listed.data.items]) {
    const a = vms.find((vm) => vm.id === 'vm-a1').proxy
    const b = vms.find((vm) => vm.id === 'vm-b').proxy
    const control = vms.find((vm) => vm.id === 'vm-local').proxy
    assert.equal(a.id, 'px-local')
    assert.equal(a.node_id, 'node-a')
    assert.equal(a.node_name, undefined, 'VM metadata must not expose admin-only cluster labels')
    assert.equal(a.bound_vm_ids, undefined, 'VM metadata must not enumerate other VMs sharing an exit')
    assert.equal(a.view_id, nodeAView.view_id)
    assert.equal(a.bound_count, 2)
    assert.equal(a.bind_limit, 5)
    assert.notEqual(a.geo?.ip, local.geo_ip, 'node geo must not inherit the control plane exit')
    assert.notEqual(a.latency_ms, 17, 'node latency must not inherit the control plane probe')
    assert.equal(b.node_id, 'node-b')
    assert.equal(b.bound_count, 1)
    assert.notEqual(a.view_id, b.view_id)
    assert.equal(control.node_id, null)
    assert.equal(control.bound_count, 1)
    assert.equal(control.geo.ip, local.geo_ip)
  }
  const detail = await buildVmDetail({ cfg: f.cfg, accountQuota: f.accountQuota, id: 'vm-a1', proxyPool: f.pool })
  assert.equal(detail.ok, true)
  for (const proxy of [detail.data.proxy, detail.data.vm.proxy]) {
    assert.equal(proxy.node_id, 'node-a')
    assert.equal(proxy.node_name, undefined, 'VM detail must not expose admin-only cluster labels')
    assert.equal(proxy.bound_vm_ids, undefined, 'VM detail must not enumerate other VMs sharing an exit')
    assert.equal(proxy.view_id, nodeAView.view_id)
    assert.equal(proxy.bound_count, 2)
    assert.notEqual(proxy.geo?.ip, local.geo_ip)
  }
})

test('tenant proxy snapshots expose only owned proxies and no local node inventory', async (t) => {
  const f = fixture(t)
  f.writeVm('vm-platform', 'node-a')
  f.bind('vm-platform')
  const own = f.pool.importLines('192.0.2.41:1080', { ownerUserId: 'user-a' }).items[0].id
  f.pool.importLines('192.0.2.42:1080', { ownerUserId: 'user-b' })
  f.writeVm('vm-own', null, { owner_user_id: 'user-a', origin: 'user_created' })
  f.bind('vm-own', own)

  for (const pathname of ['/api/panel/proxies', '/api/panel/proxies?node_id=node-a']) {
    const response = await f.request('GET', pathname, {}, { role: 'user', userId: 'user-a' })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.deepEqual(
      response.body.data.proxies.map((proxy) => proxy.id),
      [own],
    )
    assert.deepEqual(response.body.data.local_exits || [], [])
    assert.doesNotMatch(JSON.stringify(response.body.data), /Node A|node-a|vm-platform|192\.0\.2\.10|user-b/)
  }
})

test('tenant VM detail does not reveal sibling local bindings or node connection metadata', async (t) => {
  const f = fixture(t)
  f.nodes[0].username = 'node-login-private'
  f.nodes[0].password = 'node-password-private'
  f.writeVm('vm-own', 'node-a', { owner_user_id: 'user-a', origin: 'admin_assigned' })
  f.writeVm('vm-other', 'node-a', { owner_user_id: 'user-b', origin: 'admin_assigned' })
  f.bind('vm-own')
  f.bind('vm-other')

  const response = await f.request('GET', '/api/panel/vms/vm-own', {}, { role: 'user', userId: 'user-a' })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  for (const proxy of [response.body.data.proxy, response.body.data.vm.proxy]) {
    assert.equal(proxy.node_id, 'node-a')
    assert.equal(proxy.bound_count, 2)
    assert.equal(proxy.node_name, undefined)
    assert.equal(proxy.bound_vm_ids, undefined)
    assert.equal(proxy.bound_vm_id, undefined)
  }
  assert.doesNotMatch(
    JSON.stringify(response.body.data),
    /Node A|Node B|192\.0\.2\.(10|20)|node-login-private|node-password-private|vm-other|user-b/,
  )
})

test('non-admin allocated proxy responses omit sibling VM bindings and node labels', (t) => {
  const f = fixture(t)
  f.writeVm('vm-own', 'node-a', { owner_user_id: 'user-a', origin: 'admin_assigned' })
  f.writeVm('vm-other', 'node-a', { owner_user_id: 'user-b', origin: 'admin_assigned' })
  f.bind('vm-own')
  f.bind('vm-other')
  const bound = f.pool.getProxyForVm('vm-own')
  const admin = publicAllocatedProxy(f.pool, bound, { nodeId: 'node-a', role: 'admin' })
  assert.equal(admin.node_name, 'Node A')
  assert.deepEqual(admin.bound_vm_ids, ['vm-own', 'vm-other'])
  for (const role of ['user', 'super']) {
    const proxy = publicAllocatedProxy(f.pool, bound, { nodeId: 'node-a', role })
    assert.equal(proxy.id, 'px-local')
    assert.equal(proxy.node_id, 'node-a')
    assert.equal(proxy.bound_count, 2)
    assert.equal(proxy.bind_limit, 5)
    assert.equal(proxy.node_name, undefined)
    assert.equal(proxy.bound_vm_id, undefined)
    assert.equal(proxy.bound_vm_ids, undefined)
    assert.equal(proxy.url, undefined)
    assert.doesNotMatch(JSON.stringify(proxy), /Node A|vm-other|user-b|192\.0\.2\.10/)
  }
})

test('scoped local requests cannot change shared enable, disable, update or delete state', async (t) => {
  const f = fixture(t)
  for (const [id, nodeId] of [
    ['vm-local', null],
    ['vm-a', 'node-a'],
    ['vm-b', 'node-b'],
  ]) {
    f.writeVm(id, nodeId)
    f.bind(id)
  }
  const before = structuredClone(f.pool.state)
  const vmFiles = ['vm-local', 'vm-a', 'vm-b'].map((id) => [
    id,
    fs.readFileSync(path.join(f.project, 'vms', `${id}.json`), 'utf8'),
  ])
  for (const [method, pathname, body] of [
    ['POST', '/api/panel/proxies/px-local/enable', { node_id: 'node-a' }],
    ['POST', '/api/panel/proxies/px-local/disable', { node_id: null }],
    ['PUT', '/api/panel/proxies/px-local', { node_id: 'node-a', label: 'one node only' }],
    ['DELETE', '/api/panel/proxies/px-local', { node_id: 'node-b' }],
  ]) {
    const response = await f.request(method, pathname, body)
    assert.equal(response.status, 400, `${method} ${pathname}: ${JSON.stringify(response.body)}`)
    assert.equal(response.body.error.code, 'local_scope_operation_unsupported')
    assert.deepEqual(f.pool.state, before, 'rejecting a scoped action must preserve the shared pool record')
    for (const [id, original] of vmFiles) {
      assert.equal(fs.readFileSync(path.join(f.project, 'vms', `${id}.json`), 'utf8'), original)
    }
  }
})

test('invalid node_id values are rejected before binding or updating VM configuration', async (t) => {
  const f = fixture(t)
  f.writeVm('vm-a', 'node-a')
  const before = fs.readFileSync(path.join(f.project, 'vms', 'vm-a.json'), 'utf8')
  for (const nodeId of [[], {}, 1, true, '']) {
    const response = await f.request('POST', '/api/panel/proxies/px-local/bind', {
      node_id: nodeId,
      vm_id: 'vm-a',
    })
    assert.equal(response.status, 400, JSON.stringify(response.body))
    assert.equal(response.body.error.code, 'invalid_node_id')
    assert.equal(f.pool.getProxyForVm('vm-a'), null)
    assert.equal(fs.readFileSync(path.join(f.project, 'vms', 'vm-a.json'), 'utf8'), before)
  }
})

test('malformed proxy JSON cannot fall back to unscoped management or control-plane probes', async (t) => {
  const f = fixture(t)
  for (const [id, nodeId] of [
    ['vm-local', null],
    ['vm-a', 'node-a'],
  ]) {
    f.writeVm(id, nodeId)
    f.bind(id)
  }
  const before = structuredClone(f.pool.state)
  const vmFiles = ['vm-local', 'vm-a'].map((id) => [
    id,
    fs.readFileSync(path.join(f.project, 'vms', `${id}.json`), 'utf8'),
  ])
  const probe = t.mock.method(f.pool, 'probeById')
  const geo = t.mock.method(f.pool, 'detectGeo')
  const lookup = t.mock.method(f.pool, 'geoLookup')
  const lookupV6 = t.mock.method(f.pool, 'geoV6Lookup')
  for (const [method, pathname] of [
    ['POST', '/api/panel/proxies/px-local/probe'],
    ['POST', '/api/panel/proxies/px-local/geo'],
    ['POST', '/api/panel/proxies/px-local/enable'],
    ['POST', '/api/panel/proxies/px-local/disable'],
    ['DELETE', '/api/panel/proxies/px-local'],
  ]) {
    const response = await f.request(method, pathname, new SyntaxError('Unexpected end of JSON input'))
    assert.equal(response.status, 400, `${method} ${pathname}: ${JSON.stringify(response.body)}`)
    assert.equal(response.body.error.code, 'invalid_json')
    assert.deepEqual(f.pool.state, before)
    for (const call of [probe, geo, lookup, lookupV6]) assert.equal(call.mock.callCount(), 0)
    for (const [id, original] of vmFiles) {
      assert.equal(fs.readFileSync(path.join(f.project, 'vms', `${id}.json`), 'utf8'), original)
    }
  }
})
