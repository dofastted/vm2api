import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SHARED_PREFIX,
  allocateHostIp,
  allocateSharedSubnet,
  hostRange,
  isSharedNetwork,
  sharedBridgeName,
  sharedCapacity,
  sharedChainName,
  sharedNetworkName,
  sharedRoutes,
  unroutedMembers,
} from '../../src/lib/vm/shared-egress.mjs'
import {
  ensureSharedEgressNetwork,
  inspectSharedEgressNetwork,
  iptablesPlan,
  sharedEndpointIps,
  sharedIptablesPlan,
} from '../../src/lib/vm/egress.mjs'
import { parseCidr } from '../../src/lib/vm/subnet-pool.mjs'

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
  assert.equal(
    d.calls.filter((a) => a[1] === 'create').length,
    0,
    'reuse still called docker network create',
  )
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
