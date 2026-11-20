import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_SHARED_PREFIX,
  allocateHostIp,
  allocateSharedSubnet,
  assignSharedIp,
  hostRange,
  mergeSharedRoute,
  networkModeOf,
  pruneSharedRoutes,
  sharedBridgeName,
  sharedChainName,
  sharedEgressId,
  sharedMembersOf,
  sharedNetworkName,
  sharedNodeIdFromNetwork,
  sharedRoutes,
  unroutedMembers,
} from '../../src/lib/vm/shared-egress.mjs'
import {
  EGRESS_NOFILE,
  SHARED_CLAIM_TTL_MS,
  claimSharedIp,
  readSharedClaims,
  releaseSharedIp,
  egressConfigBody,
  egressConfigFor,
  ensureSharedEgressForVm,
  iptablesPlan,
  sharedIptablesPlan,
  slotNetworkArgs,
  slotNetworkForVm,
  startSharedEgress,
} from '../../src/lib/vm/egress.mjs'
import { parseCidr } from '../../src/lib/vm/subnet-pool.mjs'
import { exitOf, remoteEgressIpam, sharedRemoteNames, slotContainerBody } from '../../src/lib/cluster/remote-slot.mjs'
import { patchVmRecord } from '../../src/lib/vm/vm-registry.mjs'
import { slotContainerNetworkMismatch } from '../../src/lib/vm/vm-runtime.mjs'

/**
 * The behaviour this feature exists for was verified on a real cluster node
 * (aws-jp, 2026-11-20), not here: two VMs on one /20 bridge reached their own
 * SOCKS exits by source address, an unrouted source was refused with `no route
 * for source`, .10 could reach neither .11 over TCP nor over ICMP while the
 * gateway stayed reachable, a third VM joining by SIGHUP left an established
 * connection intact, and the helper ran with an empty proxy_url.
 *
 * What remains here is what one node cannot show: the allocator at fleet
 * scale, the route table converging as VMs come and go, the mode switch and
 * its rollback, and the collisions that would silently undo the feature.
 */

const ipInt = (ip) => parseCidr(`${ip}/32`).network

test('addresses are allocated for a node of thousands, stably and without collision', () => {
  const subnet = '100.64.16.0/20'
  const range = hostRange(subnet)
  // Sized for the node rather than for one VM: 4093 usable addresses, against
  // the ~14 networks a 172.17.0.0/12 daemon pool yields in total.
  assert.equal(range.total, 4093)
  assert.equal(range.first, ipInt('100.64.16.2'))
  assert.equal(range.last, ipInt('100.64.31.254'))

  const taken = []
  const seen = new Set()
  for (let i = 0; i < 2000; i++) {
    const ip = allocateHostIp(`vm-${i}`, { subnet, taken })
    assert.ok(!seen.has(ip), `address ${ip} handed out twice at vm-${i}`)
    assert.notEqual(ipInt(ip), range.gateway, 'the gateway was handed to a VM')
    seen.add(ip)
    taken.push(ip)
  }
  // Stable across rebuilds: the address is already on the container and in the
  // helper's route table, so re-deriving it would strand both.
  assert.equal(allocateHostIp('vm-7', { subnet }), allocateHostIp('vm-7', { subnet }))
  // A collision shifts one VM rather than failing the node.
  const wanted = allocateHostIp('vm-x', { subnet })
  assert.equal(ipInt(allocateHostIp('vm-x', { subnet, taken: [wanted] })), ipInt(wanted) + 1)
  // A full node is reported rather than handing out an address twice.
  const small = '100.64.16.0/28'
  const full = []
  for (let i = 0; i < hostRange(small).total; i++) full.push(allocateHostIp(`vm-${i}`, { subnet: small, taken: full }))
  assert.throws(() => allocateHostIp('vm-overflow', { subnet: small, taken: full }), /is full/)
})

test('shared subnets land on the prefix boundary docker requires', () => {
  // The real node refused 100.64.200.0/20 and asked for 100.64.192.0/20. A
  // misaligned range is a node that cannot create its network at all.
  for (let i = 0; i < 200; i++) {
    const cidr = parseCidr(allocateSharedSubnet(`node-${i}`))
    assert.equal(cidr.prefix, DEFAULT_SHARED_PREFIX)
    assert.equal(cidr.network % cidr.size, 0, `unaligned shared subnet for node-${i}`)
  }
  const first = allocateSharedSubnet('node-a')
  assert.equal(allocateSharedSubnet('node-a'), first)
  assert.notEqual(allocateSharedSubnet('node-a', { taken: [first] }), first)
})

test('the route table keeps every present VM on its own exit as VMs come and go', () => {
  const members = [
    { vmId: 'vm-2', ip: '100.64.16.9', proxyUrl: 'socks5h://b:1080' },
    { vmId: 'vm-1', ip: '100.64.16.3', proxyUrl: 'socks5h://a:1080' },
    // No usable upstream: left out, so the helper refuses this one VM rather
    // than being given somewhere wrong to send it.
    { vmId: 'vm-3', ip: '100.64.16.4', proxyUrl: '' },
  ]
  // Sorted, so unchanged membership yields an unchanged config and the helper
  // is not reloaded over map iteration order.
  assert.deepEqual(sharedRoutes(members), [
    { vm_ip: '100.64.16.3', proxy_url: 'socks5h://a:1080' },
    { vm_ip: '100.64.16.9', proxy_url: 'socks5h://b:1080' },
  ])
  assert.deepEqual(unroutedMembers(members), ['vm-3'])

  // A departed VM's address can be reused, and a route still naming its exit
  // would send the new VM out through someone else's. Two mechanisms cover the
  // two shapes of that: merge replaces the entry for an address, prune drops
  // an address the network no longer holds.
  const stale = [{ vm_ip: '100.64.16.3', proxy_url: 'socks5h://departed:1080' }]
  assert.deepEqual(mergeSharedRoute(stale, { vmId: 'vm-new', ip: '100.64.16.3', proxyUrl: 'socks5h://new:1080' }), [
    { vm_ip: '100.64.16.3', proxy_url: 'socks5h://new:1080' },
  ])
  assert.deepEqual(pruneSharedRoutes(stale, ['100.64.16.9']), [])
  assert.deepEqual(pruneSharedRoutes(stale, ['100.64.16.3']), stale)

  // Only this node's shared VMs are members: per-vm VMs run beside them, and
  // another node's shared VM belongs to that node's helper.
  const vms = [
    { id: 'vm-1', node_id: 'n1', runtime: { egress_mode: 'shared', shared_ip: '100.64.16.3' }, proxy: { id: 'px-1' } },
    { id: 'vm-2', node_id: 'n1', runtime: {}, proxy: { id: 'px-2' } },
    { id: 'vm-3', node_id: 'n2', runtime: { egress_mode: 'shared', shared_ip: '100.64.32.3' }, proxy: { id: 'px-3' } },
  ]
  assert.deepEqual(sharedMembersOf(vms, { nodeId: 'n1', proxyUrlOf: (vm) => `socks5h://${vm.proxy.id}:1080` }), [
    { vmId: 'vm-1', ip: '100.64.16.3', proxyUrl: 'socks5h://px-1:1080' },
  ])
})

test('a VM carries its own mode, so the switch can be turned back off', () => {
  // Default per-vm, which is every VM that exists today.
  assert.equal(networkModeOf({ proxy: { id: 'px-1' } }), 'per-vm')
  for (const bad of ['', 'Shared', 'host', 'per_vm']) {
    assert.equal(networkModeOf({ runtime: { egress_mode: bad } }), 'per-vm')
  }

  const shared = { proxy: { id: 'px-1' }, node_id: 'n1', runtime: { egress_mode: 'shared', shared_ip: '100.64.16.3' } }
  assert.equal(slotNetworkForVm(shared), sharedNetworkName('n1'))
  // Attached at the recorded address, because the route table is keyed on it.
  // Letting docker assign one would put the VM on the bridge with an address
  // either no route names, or another VM's route names.
  assert.deepEqual(slotNetworkArgs(shared).args, ['--network', sharedNetworkName('n1'), '--ip', '100.64.16.3'])
  assert.equal(slotNetworkArgs({ ...shared, runtime: { egress_mode: 'shared' } }).error, 'shared_ip_missing')

  // A per-vm VM is unchanged: alone on its bridge, so docker still assigns.
  const perVm = slotNetworkArgs({ proxy: { id: 'px-a1b2c3d4' } })
  assert.deepEqual(perVm.args, ['--network', slotNetworkForVm({ proxy: { id: 'px-a1b2c3d4' } })])
  assert.equal(perVm.ip, undefined)

  // runtime.network_mode already holds the container's docker NetworkMode and
  // is rewritten on every refresh. Sharing that key would overwrite the egress
  // mode with a network name, normalise it back to per-vm, and send the control
  // plane looking for a per-VM bridge for a VM sitting on the shared one.
  assert.equal(networkModeOf({ runtime: { egress_mode: 'shared', network_mode: 'kin-eg-shared-n1' } }), 'shared')
  assert.equal(networkModeOf({ runtime: { network_mode: 'shared' } }), 'per-vm')
})

test('the shared rules isolate VMs and stay fixed in number as VMs are added', () => {
  const args = { chain: 'KEGSHA', bridge: 'kegsha', subnet: '100.64.16.0/20', tcpPort: 18080, dnsPort: 18053 }
  const plan = sharedIptablesPlan(args)
  const flat = plan.add.map((r) => r.join(' '))
  const isolation = '-i kegsha -o kegsha -j DROP'
  // The per-VM plan leaves intra-subnet traffic alone, which allows nothing on
  // a /28 holding one VM but would let every VM on a shared /20 reach every
  // other — a path that never reaches the helper, so no route table can refuse
  // it.
  assert.ok(flat.includes(`-t filter -I FORWARD 1 ${isolation}`))
  assert.ok(flat.includes(`-t filter -C FORWARD ${isolation}`), 'without the check, repeats duplicate the rule')
  assert.ok(plan.del.map((r) => r.join(' ')).includes(`-t filter -D FORWARD ${isolation}`))

  // Same shape as the per-VM plan otherwise, so redirect and accept behaviour
  // cannot drift between the two modes.
  const base = iptablesPlan(args)
  assert.equal(plan.add.length, base.add.length + 2)
  for (const rule of base.add) assert.ok(plan.add.some((r) => r.join(' ') === rule.join(' ')))
  // A fixed count is the point of folding: one bridge, one chain and one port
  // pair for the whole node.
  assert.ok(plan.add.length < 20, `${plan.add.length} rules`)
})

test('the helper config is written by one builder, with routes and a raised fd ceiling', () => {
  const base = { proxyId: 'px-1', proxyUrl: 'socks5h://a:1080', listenTcp: '1:1', listenDns: '1:2' }
  // A per-VM config stays byte-identical to what an older control plane wrote,
  // so merging this reloads nothing.
  assert.equal(egressConfigBody(egressConfigFor(base)), egressConfigBody(egressConfigFor({ ...base, routes: [] })))
  assert.equal(egressConfigFor(base).routes, undefined)

  // A membership change has to change the body, or the helper is never
  // signalled and the joining VM has no route — in production, a VM with no
  // network.
  const route = (ip, url) => ({ ip, proxyUrl: url })
  const one = egressConfigBody(
    egressConfigFor({ ...base, routes: sharedRoutes([route('100.64.16.3', 'socks5h://a:1080')]) }),
  )
  const two = egressConfigBody(
    egressConfigFor({
      ...base,
      routes: sharedRoutes([route('100.64.16.3', 'socks5h://a:1080'), route('100.64.16.4', 'socks5h://b:1080')]),
    }),
  )
  assert.notEqual(one, two)

  // Every spliced connection holds two descriptors, and one helper now holds
  // them for a whole node rather than for one VM.
  assert.ok(EGRESS_NOFILE >= 65536, `nofile=${EGRESS_NOFILE} is too low for a node-wide helper`)
})

/** A node whose shared network holds `endpoints` and whose helper has `routes`. */
function nodeHarness({ endpoints = [], routes = [] } = {}) {
  const subnet = '100.64.16.0/20'
  const startCalls = []
  const runDocker = (args) => {
    if (args[0] !== 'network') return { ok: true, stdout: '' }
    if (args[1] === 'ls') return { ok: true, stdout: sharedNetworkName('') }
    if (args[1] === 'inspect') {
      const fmt = String(args[3] || '')
      if (fmt.includes('.Containers')) return { ok: true, stdout: endpoints.map((ip) => `${ip}/20`).join(' ') }
      if (fmt.includes('|')) return { ok: true, stdout: `${subnet}|100.64.16.1` }
      return { ok: true, stdout: subnet }
    }
    return { ok: true, stdout: '' }
  }
  return {
    subnet,
    startCalls,
    opts: {
      runDocker,
      runIp: () => ({ ok: true, stdout: '' }),
      runIptables: (a) => (a.includes('-C') ? { ok: false, stderr: 'no chain' } : { ok: true }),
      ports: { tcp: 18080, dns: 18053 },
      startProcess: async (cfg) => {
        startCalls.push(cfg)
        return { ok: true, pid: 1, reused: false, reloaded: true }
      },
      stopProcess: () => ({ ok: true, stopped: true }),
      waitListening: async () => true,
      bridgeNetfilter: () => true,
      readRoutes: () => routes,
    },
  }
}

const sharedVm = (id, ip) => ({
  id,
  runtime: { egress_mode: 'shared', ...(ip ? { shared_ip: ip } : {}) },
  proxy: { id: `px-${id}`, scheme: 'socks5h', host: `${id}.example`, port: 1080 },
})

test('a VM joining is addressed and routed without disturbing the VMs present', async () => {
  const present = '100.64.16.5'
  const h = nodeHarness({ endpoints: [present], routes: [{ vm_ip: present, proxy_url: 'socks5h://still-here:1080' }] })
  const r = await ensureSharedEgressForVm('/tmp/kin-shared-test', sharedVm('vm-2'), h.opts)
  assert.equal(r.ok, true)
  assert.ok(r.ip)
  const table = h.startCalls[0].routes
  assert.equal(table.length, 2)
  assert.ok(table.some((x) => x.vm_ip === present && x.proxy_url === 'socks5h://still-here:1080'))
  // No default exit: every VM leaves through the upstream its own route names.
  assert.equal(h.startCalls[0].proxyUrl, '')

  // An address the VM already holds is kept rather than re-derived.
  const held = await ensureSharedEgressForVm('/tmp/kin-shared-test', sharedVm('vm-3', present), h.opts)
  assert.equal(held.ip, present)
  assert.deepEqual(assignSharedIp(sharedVm('vm-1', '100.64.16.77'), { subnet: h.subnet, taken: ['100.64.16.77'] }), {
    ip: '100.64.16.77',
    reused: true,
  })
})

test('a node that cannot isolate, or has nothing to route, builds nothing', async () => {
  // Both barriers between VMs live in iptables, and bridged traffic only
  // reaches it when br_netfilter is on. With it off they are inert at once and
  // every VM on the node can reach every other, with nothing in any log.
  const blocked = nodeHarness()
  const r = await startSharedEgress('/tmp/kin-shared-test', {
    nodeId: '',
    members: [{ vmId: 'vm-1', ip: '100.64.16.3', proxyUrl: 'socks5h://a:1080' }],
    ...blocked.opts,
    bridgeNetfilter: () => false,
  })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'bridge_netfilter_disabled')
  assert.equal(blocked.startCalls.length, 0)

  // No routable member: the helper is stopped rather than left on a stale
  // table, while the network and rules stay, so a node between VMs is closed
  // rather than open.
  const empty = nodeHarness()
  const idle = await startSharedEgress('/tmp/kin-shared-test', {
    nodeId: '',
    members: [{ vmId: 'vm-1', ip: '100.64.16.3', proxyUrl: '' }],
    ...empty.opts,
  })
  assert.equal(idle.stopped, true)
  assert.equal(idle.reason, 'no_routable_members')
  assert.equal(empty.startCalls.length, 0)

  // An unreadable endpoint list must not read as "no addresses in use", which
  // would hand out one already held.
  const unreadable = nodeHarness()
  const bad = await ensureSharedEgressForVm('/tmp/kin-shared-test', sharedVm('vm-1'), {
    ...unreadable.opts,
    runDocker: (args) =>
      args[1] === 'inspect' && String(args[3]).includes('.Containers')
        ? { ok: false, stderr: 'x' }
        : unreadable.opts.runDocker(args),
  })
  assert.equal(bad.error, 'shared_network_unreadable')
  assert.equal(unreadable.startCalls.length, 0)
})

test('a node reclaims a shared network through the rules it actually created', () => {
  const host = { root: '/srv/kin', uid: 0 }
  // A shared network carries no per-VM label. Without the shared branch this
  // falls through to the per-proxy parse, reads 'shared-node-a' as a proxy id,
  // and derives a chain and bridge that were never created: deleting nothing,
  // and leaving the real rules behind naming a bridge that is gone.
  const exit = exitOf(sharedNetworkName('node-a'), { Labels: {} }, host)
  assert.equal(exit.chain, sharedChainName('node-a'))
  assert.equal(exit.bridge, sharedBridgeName('node-a'))
  assert.equal(exit.dir, `/srv/kin/egress/${sharedEgressId('node-a')}`)
  assert.ok(!exit.dir.includes('/vms/'), 'the helper outlives every single VM on the node')

  // A per-VM exit still resolves through its VM label.
  assert.ok(exitOf('kin-eg-vm-1-net', { Labels: { 'kin.egress.vm': 'vm-1' } }, host).dir.includes('/vms/vm-1/'))
  // A name that merely starts with the prefix is not a shared network.
  assert.equal(sharedNodeIdFromNetwork('kin-eg-sharedX'), null)
  assert.equal(sharedNodeIdFromNetwork('kin-eg-vm-234'), null)

  // The node-side IPAM sizes a shared network per node rather than per VM.
  const shared = remoteEgressIpam({ name: sharedNetworkName('node-a'), prefix: DEFAULT_SHARED_PREFIX })
  assert.equal(parseCidr(shared.Config[0].Subnet).prefix, DEFAULT_SHARED_PREFIX)
  assert.equal(parseCidr(remoteEgressIpam({ name: 'kin-eg-vm-1' }).Config[0].Subnet).prefix, 28)
})

/**
 * Two slots starting on one node, the second beginning before the first has
 * attached its container. Deterministic: the first slot is held inside its
 * critical section by a gate, so the overlap is forced rather than raced.
 *
 * This is the shape that whole-table replacement gets wrong. Computing the
 * table outside the node's lock lets both slots start from one snapshot and the
 * later publish drops the earlier slot's route — its container is up with no
 * way out. A starting slot is also invisible to `docker network inspect`, so
 * without a record of promised addresses the second slot would both reuse the
 * first slot's address and prune its route as though that VM had left.
 */
function concurrentHarness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-shared-conc-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const subnet = '100.64.16.0/20'
  // Endpoints stay empty for the whole test: neither container attaches, which
  // is exactly the window the claims exist for.
  const published = []
  const runDocker = (args) => {
    if (args[0] !== 'network') return { ok: true, stdout: '' }
    if (args[1] === 'ls') return { ok: true, stdout: sharedNetworkName('') }
    if (args[1] === 'inspect') {
      const fmt = String(args[3] || '')
      if (fmt.includes('.Containers')) return { ok: true, stdout: '' }
      if (fmt.includes('|')) return { ok: true, stdout: `${subnet}|100.64.16.1` }
      return { ok: true, stdout: subnet }
    }
    return { ok: true, stdout: '' }
  }
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let held = false
  return {
    root,
    subnet,
    published,
    release,
    opts: (hold) => ({
      runDocker,
      runIp: () => ({ ok: true, stdout: '' }),
      runIptables: (a) => (a.includes('-C') ? { ok: false, stderr: 'no chain' } : { ok: true }),
      ports: { tcp: 18080, dns: 18053 },
      // The helper's config is the only record of the published table, so the
      // join path reads back what the previous slot actually wrote.
      readRoutes: () => published.at(-1) || [],
      startProcess: async (cfg) => {
        if (hold && !held) {
          held = true
          await gate
        }
        published.push(cfg.routes)
        return { ok: true, pid: 1, reused: false, reloaded: true }
      },
      stopProcess: () => ({ ok: true, stopped: true }),
      waitListening: async () => true,
      bridgeNetfilter: () => true,
    }),
  }
}

test('two slots starting at once both keep their route and their own address', async (t) => {
  const h = concurrentHarness(t)
  // vm-1 and vm-4 hash to the same address on an empty snapshot, which is what
  // both slots see while neither container has attached. Only the other slot's
  // claim makes the probe shift one of them; without it both would be handed
  // 100.64.23.247 and the second container would fail to start.
  const first = ensureSharedEgressForVm(h.root, sharedVm('vm-1'), h.opts(true))
  // Let the first slot reach its publish and block there.
  await new Promise((r) => setTimeout(r, 20))
  const second = ensureSharedEgressForVm(h.root, sharedVm('vm-4'), h.opts(false))
  await new Promise((r) => setTimeout(r, 20))
  h.release()
  const [a, b] = await Promise.all([first, second])

  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  // Distinct addresses: the second slot could not see the first on the network,
  // so only the claim keeps it from handing out the same one.
  assert.notEqual(a.ip, b.ip, 'both slots were given the same address')

  // The table the helper ends up with must name both VMs. A whole-table
  // replacement computed from a stale snapshot would carry only the last one.
  const final = h.published.at(-1)
  assert.deepEqual(
    final.map((r) => r.vm_ip).sort(),
    [a.ip, b.ip].sort(),
    `final table ${JSON.stringify(final)} lost a slot's route`,
  )
  assert.ok(final.some((r) => r.proxy_url.includes('vm-1.example')))
  assert.ok(final.some((r) => r.proxy_url.includes('vm-4.example')))
  // The colliding pair proves the claim drove the probe: one of them had to move.
  assert.ok(
    [a.ip, b.ip].includes('100.64.23.247') && [a.ip, b.ip].includes('100.64.23.248'),
    `expected the colliding pair to be spread apart, got ${a.ip} and ${b.ip}`,
  )
})

test('a claim expires so a slot that died starting cannot hold an address', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-shared-claim-'))
  try {
    const now = Date.now()
    claimSharedIp(root, '', 'vm-dead', '100.64.16.9', now - SHARED_CLAIM_TTL_MS - 1000)
    claimSharedIp(root, '', 'vm-live', '100.64.16.10', now)
    const claims = readSharedClaims(root, '', now)
    // The stale one is gone, so its address is allocatable again; the live one
    // still holds, or a slot mid-start would lose its address.
    assert.equal(claims['vm-dead'], undefined)
    assert.equal(claims['vm-live'].ip, '100.64.16.10')
    // Released explicitly once the container is on the bridge.
    releaseSharedIp(root, '', 'vm-live')
    assert.deepEqual(readSharedClaims(root, '', now), {})
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/**
 * The switch entry point writes the mode and nothing else. These pin the parts
 * an operator depends on when moving one VM at a time: that a VM the helper
 * would refuse is stopped before the record changes, that the ordinary start
 * path then recreates the slot onto the right network, and that rolling back
 * leaves no address behind.
 */
function switchFixture(t, vms) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-switch-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  for (const vm of vms) {
    fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), `${JSON.stringify(vm, null, 2)}\n`)
  }
  return root
}

const perVmRecord = (id, proxyId, extra = {}) => ({
  id,
  status: 'running',
  created_at: '2026-01-01T00:00:00.000Z',
  ...(proxyId
    ? { proxy: { id: proxyId, scheme: 'socks5h', host: `${proxyId}.example`, port: 1080, enabled: true } }
    : {}),
  runtime: { container: `kin-${id}`, network_mode: proxyId ? `kin-eg-${proxyId}` : 'bridge' },
  ...extra,
})

test('switching a VM to shared makes the start path move it, and leaves others alone', (t) => {
  const root = switchFixture(t, [perVmRecord('vm-01', 'px-aaaa1111'), perVmRecord('vm-03', 'px-aaaa1111')])
  const file = path.join(root, 'vms', 'vm-01.json')

  // What the switch writes: the mode, and no address — the boot path allocates
  // that under the node lock, where it can reserve against slots starting
  // beside it.
  patchVmRecord(root, 'vm-01', (record) => ({ runtime: { ...record.runtime, egress_mode: 'shared' } }))
  const switched = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(networkModeOf(switched), 'shared')
  assert.equal(switched.runtime.shared_ip, undefined)

  // The slot now resolves to the shared network, and the existing container is
  // on the old one — which is what makes the ordinary start path recreate it.
  assert.equal(slotNetworkForVm(switched), sharedNetworkName(''))
  assert.equal(slotContainerNetworkMismatch({ networkMode: switched.runtime.network_mode }, switched), true)
  // Until the address is allocated the slot refuses to start rather than
  // letting docker pick one the route table does not name.
  assert.equal(slotNetworkArgs(switched).error, 'shared_ip_missing')

  // A VM sharing the same proxy is untouched: switching is one VM at a time.
  const other = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-03.json'), 'utf8'))
  assert.equal(networkModeOf(other), 'per-vm')
  assert.equal(slotContainerNetworkMismatch({ networkMode: other.runtime.network_mode }, other), false)
})

test('rolling a VM back to per-vm drops the shared address', (t) => {
  const root = switchFixture(t, [
    perVmRecord('vm-01', 'px-aaaa1111', {
      runtime: {
        container: 'kin-vm-01',
        network_mode: sharedNetworkName(''),
        egress_mode: 'shared',
        shared_ip: '100.64.16.7',
      },
    }),
  ])
  patchVmRecord(root, 'vm-01', (record) => {
    const runtime = { ...record.runtime, egress_mode: 'per-vm' }
    delete runtime.shared_ip
    return { runtime }
  })
  const back = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-01.json'), 'utf8'))
  assert.equal(networkModeOf(back), 'per-vm')
  // Left behind, the address would still look like a member to the next prune,
  // and the VM would hold a slot on a bridge it has left.
  assert.equal(back.runtime.shared_ip, undefined)
  assert.equal(slotNetworkForVm(back), 'kin-eg-px-aaaa1111')
  // The container is on the shared network, so the start path recreates it.
  assert.equal(slotContainerNetworkMismatch({ networkMode: back.runtime.network_mode }, back), true)
  assert.deepEqual(slotNetworkArgs(back).args, ['--network', 'kin-eg-px-aaaa1111'])
})

test('the shared helper binary lands in the node-level mount its container binds', () => {
  const host = { root: '/home/ubuntu/.vm2api', uid: 1000, gid: 1000 }
  // What remoteEgressContainer binds as the executable directory, for both the
  // control-plane host's shared helper and a cluster node's.
  for (const nodeId of ['', 'node-7b55028e']) {
    const names = sharedRemoteNames(nodeId, host)
    const bound = path.posix.join(names.dir, '..', 'slot-bin')
    // Node level, not inside any VM tree: the helper outlives every single VM
    // on the node, and the per-slot push path would never put a binary here.
    assert.equal(bound, `${host.root}/egress/slot-bin`)
    assert.ok(!bound.includes('/vms/'))
  }
})

test('a remote shared slot is pinned to its address, a per-VM slot is not', () => {
  const base = { image: 'kin:test', remoteDir: '/srv/kin/vms/vm-01', user: '1000:1000', routing: {} }
  const vm = { id: 'vm-01', kernel: 'ubuntu-24.04' }

  const shared = slotContainerBody(vm, { ...base, network: sharedNetworkName(''), ip: '100.64.16.7' })
  // Pinned, because the helper's route table is keyed on this exact address:
  // letting docker assign one puts the VM on the bridge with an address either
  // no route names, or another VM's route names.
  assert.deepEqual(shared.NetworkingConfig, {
    EndpointsConfig: { [sharedNetworkName('')]: { IPAMConfig: { IPv4Address: '100.64.16.7' } } },
  })
  // A sibling of HostConfig, not nested inside it, or docker ignores it.
  assert.equal(shared.HostConfig.NetworkingConfig, undefined)
  assert.equal(shared.HostConfig.NetworkMode, sharedNetworkName(''))

  // A per-VM slot is alone on its bridge, so docker still assigns and the
  // body stays byte-identical to what it was before shared mode existed.
  const perVm = slotContainerBody(vm, { ...base, network: 'kin-eg-px-abc' })
  assert.equal(perVm.NetworkingConfig, undefined)
  assert.equal(perVm.HostConfig.NetworkMode, 'kin-eg-px-abc')
})
