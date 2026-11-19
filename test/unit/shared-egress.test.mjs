import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_SHARED_PREFIX,
  allocateHostIp,
  assignSharedIp,
  allocateSharedSubnet,
  hostRange,
  isSharedEgressId,
  isSharedModeVm,
  isSharedNetwork,
  networkModeOf,
  normalizeNetworkMode,
  sharedBridgeName,
  sharedCapacity,
  sharedChainName,
  sharedEgressId,
  sharedEgressNodeId,
  mergeSharedRoute,
  pruneSharedRoutes,
  sharedMembersOf,
  sharedNetworkName,
  sharedRoutes,
  unroutedMembers,
} from '../../src/lib/vm/shared-egress.mjs'
import {
  EGRESS_NOFILE,
  bridgeNetfilterEnabled,
  egressBinFingerprint,
  egressConfigBody,
  egressConfigFor,
  egressContainerSpec,
  egressRunDir,
  configuredNetworkMode,
  networkName,
  ensureSharedEgressNetwork,
  inspectSharedEgressNetwork,
  iptablesPlan,
  sharedEndpointIps,
  ensureSharedEgressForVm,
  ensureSharedEgressForVms,
  sharedIpOf,
  sharedIptablesPlan,
  slotNetworkArgs,
  slotNetworkForVm,
  startEgressProcess,
  startSharedEgress,
  stopSharedEgress,
} from '../../src/lib/vm/egress.mjs'
import { parseCidr } from '../../src/lib/vm/subnet-pool.mjs'
import { buildKvmRunArgs } from '../../src/lib/vm/vm-runtime.mjs'

const ipInt = (ip) => parseCidr(`${ip}/32`).network

test('shared network, bridge and chain names are derived from the node', () => {
  assert.equal(sharedNetworkName('node-a'), 'kin-eg-shared-node-a')
  assert.ok(isSharedNetwork(sharedNetworkName('node-a')))
  assert.ok(!isSharedNetwork('kin-eg-vm-234'))
  // The chain and bridge share one tag differing only in case, the same
  // relationship the per-VM names have.
  assert.equal(sharedChainName('node-a'), sharedBridgeName('node-a').toUpperCase())
  // Linux caps an interface name at 15 bytes, so the tag stays short.
  assert.ok(sharedBridgeName('a-very-long-node-identifier').length <= 15)
})

test('the shared subnet is a /20 and avoids ranges already taken', () => {
  const subnet = allocateSharedSubnet('node-a')
  assert.equal(parseCidr(subnet).prefix, DEFAULT_SHARED_PREFIX)
  // Deterministic: a node that rebuilds lands on the range its VMs already use.
  assert.equal(allocateSharedSubnet('node-a'), subnet)
  const moved = allocateSharedSubnet('node-a', { taken: [subnet] })
  assert.notEqual(moved, subnet)
  assert.equal(parseCidr(moved).prefix, DEFAULT_SHARED_PREFIX)
})

test('the usable host range excludes the network, gateway and broadcast', () => {
  const range = hostRange('100.64.16.0/20')
  assert.equal(range.gateway, ipInt('100.64.16.1'))
  assert.equal(range.first, ipInt('100.64.16.2'))
  assert.equal(range.last, ipInt('100.64.31.254'))
  // A /20 is 4096 addresses; 4094 are usable and the gateway takes one of them.
  assert.equal(range.total, 4093)
  assert.equal(hostRange('not-a-subnet'), null)
})

test('a VM keeps its shared address across rebuilds', () => {
  const subnet = '100.64.16.0/20'
  const first = allocateHostIp('vm-234', { subnet })
  assert.equal(allocateHostIp('vm-234', { subnet }), first)
  // The address must be inside the subnet and must not be the gateway.
  const range = hostRange(subnet)
  assert.ok(ipInt(first) >= range.first && ipInt(first) <= range.last)
  assert.notEqual(ipInt(first), range.gateway)
})

test('a taken address shifts one VM rather than failing the node', () => {
  const subnet = '100.64.16.0/20'
  const wanted = allocateHostIp('vm-234', { subnet })
  const moved = allocateHostIp('vm-234', { subnet, taken: [wanted] })
  assert.notEqual(moved, wanted)
  // Probing is linear, so the collision costs one address, not a reshuffle.
  assert.equal(ipInt(moved), ipInt(wanted) + 1)
})

test('distinct VMs get distinct addresses at node scale', () => {
  const subnet = '100.64.16.0/20'
  const taken = []
  const seen = new Set()
  for (let i = 0; i < 2000; i++) {
    const ip = allocateHostIp(`vm-${i}`, { subnet, taken })
    assert.ok(!seen.has(ip), `address ${ip} handed out twice at vm-${i}`)
    seen.add(ip)
    taken.push(ip)
  }
  assert.equal(seen.size, 2000)
})

test('a full shared subnet is reported, not silently reused', () => {
  // A /28 stands in for a full node: 13 usable addresses.
  const subnet = '100.64.16.0/28'
  const range = hostRange(subnet)
  const taken = []
  for (let i = 0; i < range.total; i++) taken.push(allocateHostIp(`vm-${i}`, { subnet, taken }))
  assert.equal(taken.length, range.total)
  assert.throws(() => allocateHostIp('vm-overflow', { subnet, taken }), /is full/)
})

test('addresses outside the subnet do not consume capacity', () => {
  const subnet = '100.64.16.0/20'
  const outside = ['10.0.0.5', '100.64.48.9', 'not-an-ip', '']
  const ip = allocateHostIp('vm-234', { subnet, taken: outside })
  assert.equal(ip, allocateHostIp('vm-234', { subnet }))
  const capacity = sharedCapacity(subnet, [...outside, '100.64.16.7'])
  assert.equal(capacity.used, 1)
  assert.equal(capacity.total, hostRange(subnet).total)
  assert.equal(capacity.free, capacity.total - 1)
})

test('the route table pairs each VM address with its own upstream', () => {
  const routes = sharedRoutes([
    { vmId: 'vm-2', ip: '100.64.16.9', proxyUrl: 'socks5h://b:1080' },
    { vmId: 'vm-1', ip: '100.64.16.3', proxyUrl: 'socks5h://a:1080' },
  ])
  // Sorted by address, so unchanged membership yields an unchanged config and
  // the helper is not reloaded over map iteration order.
  assert.deepEqual(routes, [
    { vm_ip: '100.64.16.3', proxy_url: 'socks5h://a:1080' },
    { vm_ip: '100.64.16.9', proxy_url: 'socks5h://b:1080' },
  ])
})

test('a VM with no usable upstream is left out of the route table', () => {
  const members = [
    { vmId: 'vm-1', ip: '100.64.16.3', proxyUrl: 'socks5h://a:1080' },
    { vmId: 'vm-2', ip: '100.64.16.4', proxyUrl: '' },
    { vmId: 'vm-3', ip: '', proxyUrl: 'socks5h://c:1080' },
    // A duplicate address would be rejected by the helper as a whole table, so
    // only the first entry survives here.
    { vmId: 'vm-4', ip: '100.64.16.3', proxyUrl: 'socks5h://d:1080' },
  ]
  const routes = sharedRoutes(members)
  assert.deepEqual(routes, [{ vm_ip: '100.64.16.3', proxy_url: 'socks5h://a:1080' }])
  // Omission means the helper refuses that VM, so it has to be visible rather
  // than filled in with a placeholder upstream.
  assert.deepEqual(unroutedMembers(members), ['vm-2', 'vm-3'])
})

test('the shared iptables plan isolates VMs from each other', () => {
  const plan = sharedIptablesPlan({
    chain: 'KEGSHA',
    bridge: 'kegsha',
    subnet: '100.64.16.0/20',
    tcpPort: 18080,
    dnsPort: 18053,
  })
  const flat = plan.add.map((rule) => rule.join(' '))
  const isolation = '-i kegsha -o kegsha -j DROP'
  // VM-to-VM traffic stays on the bridge and never reaches the helper, so the
  // route table cannot refuse it; only this rule can.
  assert.ok(
    flat.some((rule) => rule === `-t filter -I FORWARD 1 ${isolation}`),
    'inter-VM traffic on the shared bridge is not dropped',
  )
  assert.ok(
    flat.some((rule) => rule === `-t filter -C FORWARD ${isolation}`),
    'the isolation rule is applied without an existence check',
  )
  // Teardown removes it, or a replaced network leaves a rule naming a gone bridge.
  assert.ok(plan.del.map((rule) => rule.join(' ')).includes(`-t filter -D FORWARD ${isolation}`))
  // Fail-closed on egress is kept from the per-VM plan.
  assert.ok(flat.some((rule) => rule === '-t filter -I FORWARD 1 -i kegsha ! -d 100.64.16.0/20 -j DROP'))
})

test('the shared plan is the per-VM plan plus isolation', () => {
  const args = { chain: 'KEGSHA', bridge: 'kegsha', subnet: '100.64.16.0/20', tcpPort: 18080, dnsPort: 18053 }
  const base = iptablesPlan(args)
  const shared = sharedIptablesPlan(args)
  // Same shape: the shared variant adds the isolation pair and nothing else, so
  // redirect and accept behaviour cannot drift between the two modes.
  assert.equal(shared.add.length, base.add.length + 2)
  assert.equal(shared.del.length, base.del.length + 1)
  for (const rule of base.add) assert.ok(shared.add.some((r) => r.join(' ') === rule.join(' ')))
})

test('shared rule count does not grow with the number of VMs', () => {
  const plan = (vms) => {
    // Every VM on the node shares one bridge, one chain and one helper port
    // pair, so the arguments do not depend on how many there are.
    void vms
    return sharedIptablesPlan({
      chain: 'KEGSHA',
      bridge: 'kegsha',
      subnet: '100.64.16.0/20',
      tcpPort: 18080,
      dnsPort: 18053,
    })
  }
  const ten = plan(10)
  const fiveThousand = plan(5000)
  assert.equal(fiveThousand.add.length, ten.add.length)
  assert.equal(fiveThousand.del.length, ten.del.length)
  // The count is what makes the node scale; per-VM plans multiply by VM count.
  assert.ok(ten.add.length < 20, `shared plan has ${ten.add.length} rules`)
})

/**
 * A docker double that answers both inspect shapes this module uses: the
 * `subnet|gateway` IPAM query and the container-address query.
 */
function fakeDocker({ networks = {}, endpoints = {}, routes = '', createFails = '' } = {}) {
  const table = { ...networks }
  const calls = []
  const run = (args) => {
    calls.push(args)
    if (args[0] !== 'network') return { ok: true, stdout: '' }
    const action = args[1]
    if (action === 'ls') return { ok: true, stdout: Object.keys(table).join('\n') }
    if (action === 'inspect') {
      const fmt = args[3] || ''
      const name = args[4]
      if (fmt.includes('.Containers')) {
        if (!(name in table)) return { ok: false, stderr: 'no such network' }
        return { ok: true, stdout: (endpoints[name] || []).join(' ') }
      }
      if (fmt.includes('|')) {
        const value = table[name]
        if (!value) return { ok: false, stderr: 'no such network' }
        // Arrays model a dual-stack network emitting several IPAM configs.
        const configs = Array.isArray(value) ? value : [value]
        return {
          ok: true,
          stdout: configs.map((c) => `${c}|${c.includes(':') ? '' : ipGateway(c)}`).join(' '),
        }
      }
      const found = args
        .slice(4)
        .map((n) => table[n])
        .flat()
        .filter(Boolean)
      return { ok: true, stdout: found.join(' ') }
    }
    if (action === 'create') {
      const name = args[args.length - 1]
      if (createFails) return { ok: false, stderr: createFails }
      const at = args.indexOf('--subnet')
      table[name] = at >= 0 ? args[at + 1] : '172.17.0.0/16'
      return { ok: true, stdout: name }
    }
    return { ok: true, stdout: '' }
  }
  return { run, runIp: () => ({ ok: true, stdout: routes }), calls, table }
}

const ipGateway = (cidr) => {
  const c = parseCidr(cidr)
  return c ? formatIpFromInt(c.network + 1) : ''
}
const formatIpFromInt = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')

const optOf = (create, key) => {
  for (let i = 0; i < create.length - 1; i++) {
    if (create[i] === '--opt' && String(create[i + 1]).startsWith(`${key}=`)) {
      return String(create[i + 1]).slice(key.length + 1)
    }
  }
  return null
}

test('the shared network is created with an explicit /20 and both VM barriers', () => {
  const d = fakeDocker()
  const r = ensureSharedEgressNetwork('node-a', d.run, { runIp: d.runIp })
  assert.equal(r.ok, true)
  assert.equal(r.reused, false)
  assert.equal(r.network, sharedNetworkName('node-a'))
  assert.equal(r.bridge, sharedBridgeName('node-a'))
  const create = d.calls.find((a) => a[1] === 'create')
  const at = create.indexOf('--subnet')
  assert.ok(at >= 0, 'no explicit --subnet; the daemon pool is what runs dry')
  assert.equal(parseCidr(create[at + 1]).prefix, DEFAULT_SHARED_PREFIX)
  assert.equal(r.subnet, create[at + 1])
  // Masquerade would open a way out that the helper's route table never sees.
  assert.equal(optOf(create, 'com.docker.network.bridge.enable_ip_masquerade'), 'false')
  // First of the two barriers between VMs on this bridge; sharedIptablesPlan is the second.
  assert.equal(optOf(create, 'com.docker.network.bridge.enable_icc'), 'false')
  assert.equal(optOf(create, 'com.docker.network.bridge.name'), sharedBridgeName('node-a'))
  assert.equal(r.gateway, ipGateway(r.subnet))
})

test('an existing shared network is reused, not recreated', () => {
  const name = sharedNetworkName('node-a')
  const d = fakeDocker({ networks: { [name]: '100.64.16.0/20' } })
  const r = ensureSharedEgressNetwork('node-a', d.run, { runIp: d.runIp })
  assert.equal(r.ok, true)
  assert.equal(r.reused, true)
  assert.equal(r.subnet, '100.64.16.0/20')
  // Recreating would renumber every VM already holding an address here.
  assert.equal(d.calls.filter((a) => a[1] === 'create').length, 0, 'reuse still called docker network create')
})

test('the shared subnet avoids ranges docker and the host already use', () => {
  const wanted = allocateSharedSubnet('node-a')
  const d = fakeDocker({ networks: { 'some-other-net': wanted } })
  const r = ensureSharedEgressNetwork('node-a', d.run, { runIp: d.runIp })
  assert.equal(r.ok, true)
  assert.notEqual(r.subnet, wanted)
  assert.equal(parseCidr(r.subnet).prefix, DEFAULT_SHARED_PREFIX)
})

test('a dual-stack shared network still yields its IPv4 range', () => {
  const name = sharedNetworkName('node-a')
  // Back-to-back IPAM configs parse as neither range unless split apart.
  const d = fakeDocker({ networks: { [name]: ['fd21:f843::/64', '100.64.16.0/20'] } })
  const info = inspectSharedEgressNetwork('node-a', d.run)
  assert.equal(info.subnet, '100.64.16.0/20')
  assert.equal(info.gateway, '100.64.16.1')
})

test('a failed create surfaces instead of reporting a network that is not there', () => {
  const d = fakeDocker({ createFails: 'permission denied' })
  const r = ensureSharedEgressNetwork('node-a', d.run, { runIp: d.runIp })
  assert.equal(r.ok, false)
  assert.match(r.error, /permission denied/)
})

test('an exhausted pool surfaces rather than falling back to the daemon pool', () => {
  // A /20 cannot be placed inside a /24 of pool space.
  const d = fakeDocker({ routes: '100.64.0.0/10 dev eth0' })
  const r = ensureSharedEgressNetwork('node-a', d.run, { runIp: d.runIp })
  assert.equal(r.ok, false)
  // Falling back would re-create the exhaustion this module exists to avoid.
  assert.equal(d.calls.filter((a) => a[1] === 'create').length, 0)
})

test('endpoint addresses on the shared network are read from live state', () => {
  const name = sharedNetworkName('node-a')
  const d = fakeDocker({
    networks: { [name]: '100.64.16.0/20' },
    endpoints: { [name]: ['100.64.16.5/20', '100.64.16.9/20'] },
  })
  const live = sharedEndpointIps('node-a', d.run)
  assert.equal(live.ok, true)
  assert.deepEqual(live.items, ['100.64.16.5', '100.64.16.9'])
  // Those addresses must steer the allocator away from handing them out twice.
  const next = allocateHostIp('vm-new', { subnet: '100.64.16.0/20', taken: live.items })
  assert.ok(!live.items.includes(next))
})

test('an unreadable shared network is not reported as empty', () => {
  const d = fakeDocker()
  const live = sharedEndpointIps('node-a', d.run)
  // ok:false, not an empty list: "cannot read" must not look like "nothing
  // there", or the allocator would hand out addresses already in use.
  assert.equal(live.ok, false)
  assert.deepEqual(live.items, [])
})

test('the shared helper id reuses the per-proxy lifecycle shape', () => {
  assert.equal(sharedEgressId('node-a'), 'eg-shared-node-a')
  assert.ok(isSharedEgressId(sharedEgressId('node-a')))
  assert.ok(isSharedEgressId(sharedEgressId('')))
  assert.ok(!isSharedEgressId('px-a1b2c3d4'))
  // The node is recoverable from the id, so a run directory found on disk can
  // be matched back to the network it belongs to.
  assert.equal(sharedEgressNodeId(sharedEgressId('node-a')), 'node-a')
  assert.equal(sharedEgressNodeId(sharedEgressId('')), '')
})

test('a per-VM config is byte-identical to one without the routes field', () => {
  const base = {
    proxyId: 'px-a1b2c3d4',
    proxyUrl: 'socks5h://a:1080',
    listenTcp: '100.64.0.1:18080',
    listenDns: '100.64.0.1:18053',
  }
  // An older control plane wrote no `routes`, so a per-VM helper must not see
  // its config change and reload for nothing.
  assert.equal(egressConfigBody(egressConfigFor(base)), egressConfigBody(egressConfigFor({ ...base, routes: [] })))
  assert.equal(egressConfigFor(base).routes, undefined)
})

test('a membership change changes the config body, so the helper reloads', () => {
  const base = { proxyId: 'eg-shared-node-a', proxyUrl: '', listenTcp: '1:1', listenDns: '1:2' }
  const one = egressConfigBody(
    egressConfigFor({ ...base, routes: sharedRoutes([{ ip: '100.64.16.3', proxyUrl: 'socks5h://a:1080' }]) }),
  )
  const two = egressConfigBody(
    egressConfigFor({
      ...base,
      routes: sharedRoutes([
        { ip: '100.64.16.3', proxyUrl: 'socks5h://a:1080' },
        { ip: '100.64.16.4', proxyUrl: 'socks5h://b:1080' },
      ]),
    }),
  )
  assert.notEqual(one, two, 'a VM joining left the config unchanged; the helper would never learn its route')
  // Same membership in a different order must not look like a change.
  const reordered = egressConfigBody(
    egressConfigFor({
      ...base,
      routes: sharedRoutes([
        { ip: '100.64.16.4', proxyUrl: 'socks5h://b:1080' },
        { ip: '100.64.16.3', proxyUrl: 'socks5h://a:1080' },
      ]),
    }),
  )
  assert.equal(two, reordered)
})

function sharedHarness(t, { networks = {}, endpoints = {} } = {}) {
  const d = fakeDocker({ networks, endpoints })
  const iptablesCalls = []
  const startCalls = []
  const stopCalls = []
  return {
    docker: d,
    iptablesCalls,
    startCalls,
    stopCalls,
    opts: {
      runDocker: d.run,
      runIp: d.runIp,
      runIptables: (args) => {
        iptablesCalls.push(args.join(' '))
        // -C reports "not present" so the paired -I is exercised.
        return args.includes('-C') ? { ok: false, stderr: 'No chain/target/match' } : { ok: true, stdout: '' }
      },
      ports: { tcp: 18080, dns: 18053 },
      startProcess: async (cfg) => {
        startCalls.push(cfg)
        return { ok: true, pid: 4242, reused: false, reloaded: false }
      },
      stopProcess: (root, proxyId) => {
        stopCalls.push(proxyId)
        return { ok: true, stopped: true }
      },
      waitListening: async () => true,
    },
  }
}

test('a node with no routable member stops the helper and builds no network', async () => {
  const h = sharedHarness()
  const r = await startSharedEgress('/tmp/root', {
    nodeId: 'node-a',
    members: [{ vmId: 'vm-1', ip: '100.64.16.3', proxyUrl: '' }],
    ...h.opts,
  })
  assert.equal(r.ok, true)
  assert.equal(r.stopped, true)
  assert.equal(r.reason, 'no_routable_members')
  assert.deepEqual(r.unrouted, ['vm-1'])
  assert.deepEqual(h.stopCalls, [sharedEgressId('node-a')])
  // Nothing to serve means nothing to stand up.
  assert.equal(h.docker.calls.filter((a) => a[1] === 'create').length, 0)
  assert.equal(h.startCalls.length, 0)
})

test('a shared helper starts with the route table and no upstream of its own', async () => {
  const h = sharedHarness()
  const members = [
    { vmId: 'vm-1', ip: '100.64.16.3', proxyUrl: 'socks5h://a:1080' },
    { vmId: 'vm-2', ip: '100.64.16.4', proxyUrl: 'socks5h://b:1080' },
    { vmId: 'vm-3', ip: '100.64.16.5', proxyUrl: '' },
  ]
  const r = await startSharedEgress('/tmp/root', { nodeId: 'node-a', members, ...h.opts })
  assert.equal(r.ok, true)
  assert.equal(r.routes, 2)
  assert.deepEqual(r.unrouted, ['vm-3'])
  assert.equal(r.network, sharedNetworkName('node-a'))
  assert.equal(parseCidr(r.subnet).prefix, DEFAULT_SHARED_PREFIX)

  assert.equal(h.startCalls.length, 1)
  const cfg = h.startCalls[0]
  assert.equal(cfg.proxyId, sharedEgressId('node-a'))
  // No default exit: every VM leaves through the upstream its route names.
  assert.equal(cfg.proxyUrl, '')
  assert.deepEqual(cfg.routes, [
    { vm_ip: '100.64.16.3', proxy_url: 'socks5h://a:1080' },
    { vm_ip: '100.64.16.4', proxy_url: 'socks5h://b:1080' },
  ])
  // The helper listens on the shared gateway, where REDIRECT delivers.
  assert.equal(cfg.listenHost, r.gateway)
  assert.equal(cfg.tcpPort, 18080)
})

test('starting a shared helper installs the isolation rule', async () => {
  const h = sharedHarness()
  const r = await startSharedEgress('/tmp/root', {
    nodeId: 'node-a',
    members: [{ vmId: 'vm-1', ip: '100.64.16.3', proxyUrl: 'socks5h://a:1080' }],
    ...h.opts,
  })
  assert.equal(r.ok, true)
  const bridge = sharedBridgeName('node-a')
  assert.ok(
    h.iptablesCalls.includes(`-t filter -I FORWARD 1 -i ${bridge} -o ${bridge} -j DROP`),
    'inter-VM isolation was not applied when the shared helper started',
  )
  assert.ok(h.iptablesCalls.some((c) => c.includes(`-j REDIRECT --to-ports 18080`)))
  assert.ok(h.iptablesCalls.some((c) => c.startsWith(`-t nat -N ${sharedChainName('node-a')}`)))
})

test('a failed network stops the start before any helper or rule', async () => {
  const d = fakeDocker({ createFails: 'permission denied' })
  const h = sharedHarness()
  const r = await startSharedEgress('/tmp/root', {
    nodeId: 'node-a',
    members: [{ vmId: 'vm-1', ip: '100.64.16.3', proxyUrl: 'socks5h://a:1080' }],
    ...h.opts,
    runDocker: d.run,
    runIp: d.runIp,
  })
  assert.equal(r.ok, false)
  assert.equal(h.startCalls.length, 0)
  // Rules naming a bridge that does not exist would outlive the failure.
  assert.deepEqual(h.iptablesCalls, [])
})

test('stopping the shared helper withdraws its rules', () => {
  const name = sharedNetworkName('node-a')
  const h = sharedHarness(null, { networks: { [name]: '100.64.16.0/20' } })
  const removed = []
  const r = stopSharedEgress('/tmp/root', 'node-a', {
    runDocker: h.docker.run,
    runIptables: (args) => {
      removed.push(args.join(' '))
      return { ok: true }
    },
  })
  assert.equal(r.ok, true)
  const bridge = sharedBridgeName('node-a')
  assert.ok(
    removed.includes(`-t filter -D FORWARD -i ${bridge} -o ${bridge} -j DROP`),
    'the isolation rule survived teardown and now names a bridge that may be gone',
  )
  assert.ok(removed.some((c) => c.startsWith(`-t nat -X ${sharedChainName('node-a')}`)))
})

/** A shared helper already running with `routes`, as the container runtime sees it. */
function runningHelper(t, routes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-shared-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const binDir = path.join(root, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  const bin = path.join(binDir, 'kin-egress')
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 })
  const proxyId = sharedEgressId('node-a')
  const dir = egressRunDir(root, proxyId)
  fs.mkdirSync(dir, { recursive: true })
  const listenTcp = '100.64.16.1:18080'
  const listenDns = '100.64.16.1:18053'
  const cfgPath = path.join(dir, 'egress.json')
  fs.writeFileSync(cfgPath, egressConfigBody(egressConfigFor({ proxyId, proxyUrl: '', listenTcp, listenDns, routes })))
  const fingerprint = egressBinFingerprint(bin)
  const digestFor = (forRoutes) =>
    egressContainerSpec({
      proxyId,
      body: egressConfigBody(egressConfigFor({ proxyId, proxyUrl: '', listenTcp, listenDns, routes: forRoutes })),
      hostDir: dir,
      hostBinDir: binDir,
      binName: 'kin-egress',
      image: 'kin:test',
      binFingerprint: fingerprint,
    }).digest
  const calls = []
  const runDocker = (args) => {
    calls.push(args)
    if (args[0] === 'inspect') return { ok: true, stdout: `true|false|999|${digestFor(routes)}|${fingerprint}|hup` }
    return { ok: true, stdout: '' }
  }
  const start = (nextRoutes) =>
    startEgressProcess({
      projectRoot: root,
      proxyId,
      proxyUrl: '',
      routes: nextRoutes,
      tcpPort: 18080,
      dnsPort: 18053,
      listenHost: '100.64.16.1',
      runtime: 'container',
      runDocker,
      bin,
      image: 'kin:test',
      hostPath: (p) => p,
    })
  return { root, proxyId, cfgPath, calls, start, digestFor }
}

const ROUTE_ONE = [{ vm_ip: '100.64.16.3', proxy_url: 'socks5h://a:1080' }]
const ROUTE_TWO = [...ROUTE_ONE, { vm_ip: '100.64.16.4', proxy_url: 'socks5h://b:1080' }]

test('a VM joining reloads the helper rather than leaving it on a stale table', async (t) => {
  const h = runningHelper(t, ROUTE_ONE)
  const r = await h.start(ROUTE_TWO)
  assert.equal(r.ok, true)
  // Membership is not part of the container rebuild key, so the joining VM
  // must arrive by signal with every established connection intact.
  assert.equal(r.reloaded, true)
  assert.ok(
    h.calls.some((a) => a[0] === 'kill' && a.includes('HUP')),
    'no SIGHUP: the new VM would have no route and be refused fail-closed',
  )
  assert.ok(!h.calls.some((a) => a[0] === 'run'), 'the container was rebuilt, dropping every live connection')
  const written = JSON.parse(fs.readFileSync(h.cfgPath, 'utf8'))
  assert.deepEqual(written.routes, ROUTE_TWO)
})

test('unchanged membership neither rewrites the table nor signals the helper', async (t) => {
  const h = runningHelper(t, ROUTE_ONE)
  const before = fs.statSync(h.cfgPath).mtimeMs
  const r = await h.start(ROUTE_ONE)
  assert.equal(r.ok, true)
  assert.equal(r.reused, true)
  assert.equal(r.reloaded, false)
  assert.ok(!h.calls.some((a) => a[0] === 'kill'), 'signalled the helper for a membership that did not change')
  assert.equal(fs.statSync(h.cfgPath).mtimeMs, before)
})

test('a VM leaving also reaches the helper', async (t) => {
  const h = runningHelper(t, ROUTE_TWO)
  const r = await h.start(ROUTE_ONE)
  assert.equal(r.reloaded, true)
  // A departed VM left in the table keeps an exit reachable by an address that
  // may since have been handed to someone else.
  assert.deepEqual(JSON.parse(fs.readFileSync(h.cfgPath, 'utf8')).routes, ROUTE_ONE)
})

test('a helper container raises its descriptor ceiling', (t) => {
  const h = runningHelper(t, ROUTE_ONE)
  const spec = egressContainerSpec({
    proxyId: h.proxyId,
    body: '{}\n',
    hostDir: '/d',
    hostBinDir: '/b',
    binName: 'kin-egress',
    image: 'kin:test',
    binFingerprint: 'fp',
  })
  const at = spec.args.indexOf('--ulimit')
  assert.ok(at >= 0, 'a shared helper holds every VM’s sockets against the daemon default')
  assert.equal(spec.args[at + 1], `nofile=${EGRESS_NOFILE}:${EGRESS_NOFILE}`)
  assert.ok(EGRESS_NOFILE >= 65536, `nofile=${EGRESS_NOFILE} is too low for a node-wide helper`)
})

test('the descriptor ceiling does not enter the container rebuild key', (t) => {
  // It is a container argument but deliberately a constant: were it derived
  // from membership it would change the digest and force a rebuild — and with
  // it every live connection — each time a VM joined.
  const h = runningHelper(t, ROUTE_ONE)
  const digestOf = (routes) => h.digestFor(routes)
  assert.equal(digestOf(ROUTE_ONE), digestOf(ROUTE_TWO))
})

test('an unrecognised or absent network mode is per-vm', () => {
  assert.equal(normalizeNetworkMode('shared'), 'shared')
  assert.equal(normalizeNetworkMode('per-vm'), 'per-vm')
  for (const bad of ['', null, undefined, 'Shared', 'host', 'bridge', 'per_vm']) {
    assert.equal(normalizeNetworkMode(bad), 'per-vm', `${JSON.stringify(bad)} was not treated as per-vm`)
  }
  // Every VM that exists today has nothing recorded, and must stay per-vm.
  assert.equal(networkModeOf({ proxy: { id: 'px-a1b2c3d4' } }), 'per-vm')
  assert.equal(networkModeOf({ runtime: {} }), 'per-vm')
  assert.ok(!isSharedModeVm({ runtime: { egress_mode: 'per-vm' } }))
  assert.ok(isSharedModeVm({ runtime: { egress_mode: 'shared' } }))
})

test('a VM resolves to the network its own mode names', () => {
  const perVm = { proxy: { id: 'px-a1b2c3d4' } }
  assert.equal(slotNetworkForVm(perVm), networkName('px-a1b2c3d4'))

  const shared = { proxy: { id: 'px-a1b2c3d4' }, runtime: { egress_mode: 'shared', shared_ip: '100.64.16.3' } }
  assert.equal(slotNetworkForVm(shared), sharedNetworkName(''))
  // A cluster VM belongs to its own node's shared network.
  assert.equal(slotNetworkForVm({ ...shared, node_id: 'node-a' }), sharedNetworkName('node-a'))
})

test('a shared VM is attached at its recorded address, never one Docker picks', () => {
  const shared = { proxy: { id: 'px-a1b2c3d4' }, runtime: { egress_mode: 'shared', shared_ip: '100.64.16.3' } }
  const args = slotNetworkArgs(shared)
  assert.equal(args.ok, true)
  assert.deepEqual(args.args, ['--network', sharedNetworkName(''), '--ip', '100.64.16.3'])
  assert.equal(sharedIpOf(shared), '100.64.16.3')

  // A per-VM slot is alone on its bridge, so it keeps letting Docker assign.
  const perVm = slotNetworkArgs({ proxy: { id: 'px-a1b2c3d4' } })
  assert.deepEqual(perVm.args, ['--network', networkName('px-a1b2c3d4')])
  assert.equal(perVm.ip, undefined)
})

test('a shared VM with no recorded address refuses to start', () => {
  // Booting it anyway puts it on the bridge with an address no route names, or
  // worse, one another VM's route names.
  const r = slotNetworkArgs({ proxy: { id: 'px-a1b2c3d4' }, runtime: { egress_mode: 'shared' } })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'shared_ip_missing')
  assert.equal(r.args, undefined)
})

test('a VM already on the shared network is unaffected by the mode setting', () => {
  // The setting decides what a new VM is built as; this VM carries its own
  // mode, so turning the setting off does not send the control plane looking
  // for a per-VM bridge that was never created for it.
  const shared = { proxy: { id: 'px-a1b2c3d4' }, runtime: { egress_mode: 'shared', shared_ip: '100.64.16.3' } }
  assert.equal(slotNetworkForVm(shared), sharedNetworkName(''))
  // configuredNetworkMode reads settings; with no DB open it is the safe default.
  assert.equal(configuredNetworkMode(), 'per-vm')
})

test('the kvm slot container carries the fixed address through', () => {
  const args = buildKvmRunArgs({
    vm: { id: 'vm-1', runtime: { egress_mode: 'shared', shared_ip: '100.64.16.3' } },
    name: 'kin-vm-1',
    image: 'kin:test',
    hostName: 'vm-1',
    network: sharedNetworkName(''),
    ip: '100.64.16.3',
    memory: '2g',
    uid: 1000,
    gid: 1000,
    home: '/home/x',
    runDir: '/run/x',
    kvmDir: '/run/x/kvm',
    projectRoot: '/tmp/root',
  })
  const at = args.indexOf('--ip')
  assert.ok(at >= 0, 'the kvm slot was attached without its fixed address')
  assert.equal(args[at + 1], '100.64.16.3')
  // Right after --network, so it applies to that attachment.
  assert.equal(args[args.indexOf('--network') + 2], '--ip')
})

test('a per-vm kvm slot gets no address argument', () => {
  const args = buildKvmRunArgs({
    vm: { id: 'vm-1' },
    name: 'kin-vm-1',
    image: 'kin:test',
    hostName: 'vm-1',
    network: networkName('px-a1b2c3d4'),
    memory: '2g',
    uid: 1000,
    gid: 1000,
    home: '/home/x',
    runDir: '/run/x',
    kvmDir: '/run/x/kvm',
    projectRoot: '/tmp/root',
  })
  assert.equal(args.indexOf('--ip'), -1)
})

test('bridged traffic bypassing iptables is read as isolation off', () => {
  assert.equal(
    bridgeNetfilterEnabled(() => '1\n'),
    true,
  )
  assert.equal(
    bridgeNetfilterEnabled(() => '0\n'),
    false,
  )
  // An unreadable path means br_netfilter is not loaded, which leaves bridged
  // traffic outside iptables just as surely as the switch being off.
  assert.equal(
    bridgeNetfilterEnabled(() => {
      throw new Error('ENOENT')
    }),
    false,
  )
})

test('a node whose bridged traffic skips iptables refuses to fold', async () => {
  const h = sharedHarness()
  const r = await startSharedEgress('/tmp/root', {
    nodeId: 'node-a',
    members: [{ vmId: 'vm-1', ip: '100.64.16.3', proxyUrl: 'socks5h://a:1080' }],
    ...h.opts,
    bridgeNetfilter: () => false,
  })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'bridge_netfilter_disabled')
  assert.match(r.hint, /bridge-nf-call-iptables/)
  // Nothing is placed on a bridge that cannot isolate: no network, no rules,
  // no helper. Starting anyway would put every VM on the node in reach of
  // every other, with nothing in any log to say so.
  assert.equal(h.docker.calls.filter((a) => a[1] === 'create').length, 0)
  assert.deepEqual(h.iptablesCalls, [])
  assert.equal(h.startCalls.length, 0)
})

test('node membership is derived from the node\u2019s shared VMs only', () => {
  const vms = [
    { id: 'vm-1', runtime: { egress_mode: 'shared', shared_ip: '100.64.16.3' }, proxy: { id: 'px-1' } },
    // per-vm VMs run beside shared ones on the same node and are not members.
    { id: 'vm-2', runtime: {}, proxy: { id: 'px-2' } },
    // Another node's shared VM belongs to that node's helper, not this one.
    {
      id: 'vm-3',
      node_id: 'node-b',
      runtime: { egress_mode: 'shared', shared_ip: '100.64.32.3' },
      proxy: { id: 'px-3' },
    },
    { id: 'vm-4', runtime: { egress_mode: 'shared', shared_ip: '100.64.16.4' }, proxy: { id: 'px-4' } },
  ]
  const members = sharedMembersOf(vms, { nodeId: '', proxyUrlOf: (vm) => `socks5h://${vm.proxy.id}:1080` })
  assert.deepEqual(members, [
    { vmId: 'vm-1', ip: '100.64.16.3', proxyUrl: 'socks5h://px-1:1080' },
    { vmId: 'vm-4', ip: '100.64.16.4', proxyUrl: 'socks5h://px-4:1080' },
  ])
  assert.deepEqual(sharedMembersOf(vms, { nodeId: 'node-b', proxyUrlOf: (vm) => `socks5h://${vm.proxy.id}:1080` }), [
    { vmId: 'vm-3', ip: '100.64.32.3', proxyUrl: 'socks5h://px-3:1080' },
  ])
})

test('a VM keeps the shared address it already holds', () => {
  const subnet = '100.64.16.0/20'
  const held = { id: 'vm-1', runtime: { egress_mode: 'shared', shared_ip: '100.64.16.77' } }
  // Re-deriving would strand both the container attachment and the route.
  const kept = assignSharedIp(held, { subnet, taken: ['100.64.16.77'] })
  assert.deepEqual(kept, { ip: '100.64.16.77', reused: true })

  const fresh = { id: 'vm-2', runtime: { egress_mode: 'shared' } }
  const given = assignSharedIp(fresh, { subnet, taken: ['100.64.16.77'] })
  assert.equal(given.reused, false)
  assert.notEqual(given.ip, '100.64.16.77')
  assert.equal(given.ip, allocateHostIp('vm-2', { subnet, taken: ['100.64.16.77'] }))
})

test('the node-wide entry point derives membership and routes it', async () => {
  const h = sharedHarness()
  const vms = [
    {
      id: 'vm-1',
      node_id: 'node-a',
      runtime: { egress_mode: 'shared', shared_ip: '100.64.16.3' },
      proxy: { id: 'px-1' },
    },
    { id: 'vm-2', node_id: 'node-a', runtime: {}, proxy: { id: 'px-2' } },
  ]
  const r = await ensureSharedEgressForVms('/tmp/root', vms, {
    nodeId: 'node-a',
    proxyUrlOf: () => 'socks5h://a:1080',
    ...h.opts,
  })
  assert.equal(r.ok, true)
  // Only the shared VM is in the table; the per-vm one keeps its own helper.
  assert.equal(r.routes, 1)
  assert.deepEqual(h.startCalls[0].routes, [{ vm_ip: '100.64.16.3', proxy_url: 'socks5h://a:1080' }])
})

test('a node with only per-vm VMs stands up no shared helper', async () => {
  const h = sharedHarness()
  const r = await ensureSharedEgressForVms(
    '/tmp/root',
    [{ id: 'vm-1', node_id: 'node-a', runtime: {}, proxy: { id: 'px-1' } }],
    {
      nodeId: 'node-a',
      ...h.opts,
    },
  )
  assert.equal(r.ok, true)
  assert.equal(r.routes, 0)
  assert.equal(h.startCalls.length, 0)
  assert.equal(h.docker.calls.filter((a) => a[1] === 'create').length, 0)
})

test('the container’s NetworkMode is not mistaken for the egress mode', () => {
  // runtime.network_mode already holds the Docker NetworkMode — a network name,
  // or 'host' — and is rewritten on every refresh. The egress mode lives in its
  // own key, or a refresh would overwrite it with a network name that
  // normalises back to per-vm, sending the control plane looking for a per-VM
  // bridge for a VM sitting on the shared one.
  const shared = {
    id: 'vm-1',
    proxy: { id: 'px-a1b2c3d4' },
    runtime: {
      egress_mode: 'shared',
      shared_ip: '100.64.16.3',
      // What runtimePatch writes: the network the container is attached to.
      network_mode: sharedNetworkName(''),
    },
  }
  assert.equal(networkModeOf(shared), 'shared')
  assert.equal(slotNetworkForVm(shared), sharedNetworkName(''))

  // And the reverse: a per-vm VM whose NetworkMode happens to read 'shared'
  // must not be promoted by it.
  const perVm = { id: 'vm-2', proxy: { id: 'px-a1b2c3d4' }, runtime: { network_mode: 'shared' } }
  assert.equal(networkModeOf(perVm), 'per-vm')
  assert.equal(slotNetworkForVm(perVm), networkName('px-a1b2c3d4'))
})

test('routes for addresses no longer on the network are pruned', () => {
  const routes = [
    { vm_ip: '100.64.16.3', proxy_url: 'socks5h://a:1080' },
    { vm_ip: '100.64.16.4', proxy_url: 'socks5h://b:1080' },
  ]
  // vm-4 has gone; its address is no longer held.
  assert.deepEqual(pruneSharedRoutes(routes, ['100.64.16.3']), [
    { vm_ip: '100.64.16.3', proxy_url: 'socks5h://a:1080' },
  ])
  // A VM is routed before its container exists, so its own address is exempt.
  assert.deepEqual(pruneSharedRoutes(routes, [], { keep: ['100.64.16.4'] }), [
    { vm_ip: '100.64.16.4', proxy_url: 'socks5h://b:1080' },
  ])
  assert.deepEqual(pruneSharedRoutes([], ['100.64.16.3']), [])
})

test('merging a member replaces the entry for its address', () => {
  const routes = [{ vm_ip: '100.64.16.3', proxy_url: 'socks5h://old:1080' }]
  // Two entries for one address make the whole table invalid at the helper,
  // so the reload fails and every VM on the node stays on the previous table.
  const merged = mergeSharedRoute(routes, { vmId: 'vm-1', ip: '100.64.16.3', proxyUrl: 'socks5h://new:1080' })
  assert.deepEqual(merged, [{ vm_ip: '100.64.16.3', proxy_url: 'socks5h://new:1080' }])

  const added = mergeSharedRoute(routes, { vmId: 'vm-2', ip: '100.64.16.4', proxyUrl: 'socks5h://b:1080' })
  assert.equal(added.length, 2)
  // Still sorted, so an unchanged membership yields an unchanged config.
  assert.deepEqual(
    added.map((r) => r.vm_ip),
    ['100.64.16.3', '100.64.16.4'],
  )
})

/** A node whose shared network already holds `endpoints` and whose helper has `routes`. */
function vmHarness(t, { endpoints = [], routes = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vmshared-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const nodeId = ''
  const name = sharedNetworkName(nodeId)
  const subnet = '100.64.16.0/20'
  if (routes.length) {
    const dir = egressRunDir(root, sharedEgressId(nodeId))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'egress.json'),
      egressConfigBody(
        egressConfigFor({ proxyId: sharedEgressId(nodeId), listenTcp: '1:1', listenDns: '1:2', routes }),
      ),
    )
  }
  const d = fakeDocker({ networks: { [name]: subnet }, endpoints: { [name]: endpoints.map((ip) => `${ip}/20`) } })
  const startCalls = []
  return {
    root,
    subnet,
    startCalls,
    opts: {
      runDocker: d.run,
      runIp: d.runIp,
      runIptables: (args) => (args.includes('-C') ? { ok: false, stderr: 'no chain' } : { ok: true }),
      ports: { tcp: 18080, dns: 18053 },
      startProcess: async (cfg) => {
        startCalls.push(cfg)
        return { ok: true, pid: 1, reused: false, reloaded: true }
      },
      stopProcess: () => ({ ok: true, stopped: true }),
      waitListening: async () => true,
      bridgeNetfilter: () => true,
    },
  }
}

const sharedVm = (id, ip) => ({
  id,
  runtime: { egress_mode: 'shared', ...(ip ? { shared_ip: ip } : {}) },
  proxy: { id: `px-${id}`, scheme: 'socks5h', host: `${id}.example`, port: 1080 },
})

test('a VM joining a node is given an address and routed', async (t) => {
  const h = vmHarness(t)
  const r = await ensureSharedEgressForVm(h.root, sharedVm('vm-1'), h.opts)
  assert.equal(r.ok, true)
  assert.ok(r.ip, 'no address was assigned')
  assert.equal(r.ip, allocateHostIp('vm-1', { subnet: h.subnet }))
  // Routed before its container exists, so its own address survives the prune.
  assert.deepEqual(
    h.startCalls[0].routes.map((x) => x.vm_ip),
    [r.ip],
  )
})

test('a VM already holding an address keeps it', async (t) => {
  const h = vmHarness(t, { endpoints: ['100.64.16.77'] })
  const r = await ensureSharedEgressForVm(h.root, sharedVm('vm-1', '100.64.16.77'), h.opts)
  assert.equal(r.ok, true)
  assert.equal(r.ip, '100.64.16.77')
})

test('a reused address does not inherit the departed VM\u2019s exit', async (t) => {
  // vm-old left and the allocator hands its address to vm-new. The stale route
  // names vm-old's upstream; left in place, vm-new would leave through someone
  // else's exit. The address is exempt from the prune (vm-new's container does
  // not exist yet), so what has to protect it here is the merge replacing the
  // entry rather than adding beside it.
  const reused = allocateHostIp('vm-new', { subnet: '100.64.16.0/20' })
  const h = vmHarness(t, { endpoints: [], routes: [{ vm_ip: reused, proxy_url: 'socks5h://old-vm-exit:1080' }] })
  const r = await ensureSharedEgressForVm(h.root, sharedVm('vm-new'), h.opts)
  assert.equal(r.ok, true)
  assert.equal(r.ip, reused)
  const table = h.startCalls[0].routes
  assert.equal(table.length, 1, 'two entries for one address make the whole table invalid')
  assert.match(table[0].proxy_url, /vm-new\.example/)
  assert.ok(
    !table.some((x) => x.proxy_url.includes('old-vm-exit')),
    'the new VM would leave through the departed VM\u2019s exit',
  )
})

test('a departed VM\u2019s route is pruned when its address is not reused', async (t) => {
  // Here the prune is what removes it: the address is neither held on the
  // network nor the joining VM's own.
  const gone = '100.64.16.200'
  const h = vmHarness(t, { endpoints: [], routes: [{ vm_ip: gone, proxy_url: 'socks5h://old-vm-exit:1080' }] })
  const r = await ensureSharedEgressForVm(h.root, sharedVm('vm-new'), h.opts)
  assert.equal(r.ok, true)
  assert.notEqual(r.ip, gone)
  assert.equal(r.dropped, 1, 'the departed VM\u2019s route was not pruned')
  const table = h.startCalls[0].routes
  assert.deepEqual(
    table.map((x) => x.vm_ip),
    [r.ip],
  )
})

test('a VM joining does not disturb the routes of VMs still present', async (t) => {
  const present = '100.64.16.5'
  const h = vmHarness(t, {
    endpoints: [present],
    routes: [{ vm_ip: present, proxy_url: 'socks5h://still-here:1080' }],
  })
  const r = await ensureSharedEgressForVm(h.root, sharedVm('vm-2'), h.opts)
  assert.equal(r.ok, true)
  assert.equal(r.dropped, 0)
  const table = h.startCalls[0].routes
  assert.equal(table.length, 2)
  assert.ok(table.some((x) => x.vm_ip === present && x.proxy_url === 'socks5h://still-here:1080'))
})

test('a VM with no bound upstream is refused before anything is built', async (t) => {
  const h = vmHarness(t)
  const r = await ensureSharedEgressForVm(h.root, { id: 'vm-1', runtime: { egress_mode: 'shared' }, proxy: {} }, h.opts)
  assert.equal(r.ok, false)
  assert.match(r.error, /bound SOCKS5/)
  assert.equal(h.startCalls.length, 0)
})

test('an unreadable shared network does not become an empty one', async (t) => {
  const h = vmHarness(t)
  // ok:false from the endpoint read must stop the allocation: treating it as
  // "no addresses in use" would hand out one already held.
  const r = await ensureSharedEgressForVm(h.root, sharedVm('vm-1'), {
    ...h.opts,
    runDocker: (args) =>
      args[1] === 'inspect' && String(args[3]).includes('.Containers')
        ? { ok: false, stderr: 'x' }
        : h.opts.runDocker(args),
  })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'shared_network_unreadable')
  assert.equal(h.startCalls.length, 0)
})
