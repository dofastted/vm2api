import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  allocatedEgressPorts,
  egressRunDir,
  ensureEgressNetwork,
  ensureLocalProxyEgress,
  gatewayFromSubnet,
  persistedEgressPorts,
  portFromListenSpec,
  portsForProxy,
  resolveEgressPorts,
} from '../../src/lib/vm/egress.mjs'
import { gatewayOf, parseCidr } from '../../src/lib/vm/subnet-pool.mjs'
import { remoteEgressIpam } from '../../src/lib/cluster/remote-slot.mjs'

const POOL = parseCidr('100.64.0.0/10')

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-egress-ports-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeEgressConfig(root, proxyId, { tcp, dns, host = '100.64.0.1' }) {
  const dir = egressRunDir(root, proxyId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'egress.json'),
    JSON.stringify({ proxy_id: proxyId, listen_tcp: `${host}:${tcp}`, listen_dns: `${host}:${dns}` }),
  )
}

/**
 * Docker stand-in over an in-memory network table. `inspectEgressNetwork` and the
 * allocator's batch inspect share the `network inspect` verb, so they are told
 * apart by their format string. `runIp` is handed in separately so no test ever
 * reads the real host route table.
 */
function fakeDocker({ networks = {}, routes = '' } = {}) {
  const table = { ...networks }
  const calls = []
  const run = (args) => {
    calls.push(args)
    const [verb, action] = args
    if (verb !== 'network') return { ok: true, stdout: '' }
    if (action === 'ls') return { ok: true, stdout: Object.keys(table).join('\n') }
    if (action === 'inspect') {
      const fmt = args[3] || ''
      if (fmt.includes('|')) {
        const subnet = table[args[4]]
        return subnet
          ? { ok: true, stdout: `${subnet}|${gatewayOf(subnet)}` }
          : { ok: false, stderr: 'no such network' }
      }
      const found = args
        .slice(4)
        .map((name) => table[name])
        .filter(Boolean)
      return { ok: true, stdout: found.join(' ') }
    }
    if (action === 'create') {
      const name = args[args.length - 1]
      const at = args.indexOf('--subnet')
      table[name] = at >= 0 ? args[at + 1] : '172.17.0.0/16'
      return { ok: true, stdout: name }
    }
    return { ok: true, stdout: '' }
  }
  const runIp = () => ({ ok: true, stdout: routes })
  return { run, runIp, calls, table, creates: () => calls.filter((a) => a[1] === 'create') }
}

function subnetArgOf(create) {
  const at = create.indexOf('--subnet')
  assert.ok(at >= 0, `create call carried no --subnet: ${create.join(' ')}`)
  return create[at + 1]
}

function assertInsidePool(cidr) {
  const parsed = parseCidr(cidr)
  assert.ok(parsed, `not a cidr: ${cidr}`)
  assert.ok(
    parsed.network >= POOL.network && parsed.network + parsed.size - 1 <= POOL.network + POOL.size - 1,
    `${cidr} is outside 100.64.0.0/10`,
  )
}

function assertAbove(subnet, blockedCidr) {
  const blocked = parseCidr(blockedCidr)
  assert.ok(
    parseCidr(subnet).network > blocked.network + blocked.size - 1,
    `${subnet} landed inside the occupied ${blockedCidr}`,
  )
}

test('gatewayFromSubnet returns the first usable address for any prefix', () => {
  // The old implementation appended `.1` to the third octet, which is wrong for a
  // /28 that does not start at .0 — the gateway fell outside its own range.
  assert.equal(gatewayFromSubnet('100.64.0.16/28'), '100.64.0.17')
  assert.equal(gatewayFromSubnet('100.64.3.240/28'), '100.64.3.241')
  // Unchanged for the prefixes that were already correct.
  assert.equal(gatewayFromSubnet('172.17.0.0/16'), '172.17.0.1')
  assert.equal(gatewayFromSubnet('192.168.5.0/24'), '192.168.5.1')
  assert.equal(gatewayFromSubnet(''), '')
  assert.equal(gatewayFromSubnet('garbage'), '')
})

test('a new egress network is created with an explicit subnet from the pool', () => {
  const d = fakeDocker()
  const r = ensureEgressNetwork('px-a1b2c3d4', d.run, { runIp: d.runIp })

  assert.equal(r.ok, true)
  assert.equal(r.reused, false)
  const creates = d.creates()
  assert.equal(creates.length, 1)
  const subnet = subnetArgOf(creates[0])
  assertInsidePool(subnet)
  // Gateway is pinned alongside, so inspect never has to fall back.
  const gwAt = creates[0].indexOf('--gateway')
  assert.equal(creates[0][gwAt + 1], gatewayOf(subnet))
  assert.equal(r.subnet, subnet)
})

test('a local egress network is created with an explicit subnet too', () => {
  const d = fakeDocker()
  const r = ensureLocalProxyEgress({ id: 'px-local' }, { runDocker: d.run, runIp: d.runIp })

  assert.equal(r.ok, true)
  assert.equal(r.mode, 'local')
  assertInsidePool(subnetArgOf(d.creates()[0]))
})

test('an existing network is reused without allocating or creating anything', () => {
  const d = fakeDocker({ networks: { 'kin-eg-px-a1b2c3d4': '172.20.5.0/24' } })
  const r = ensureEgressNetwork('px-a1b2c3d4', d.run, { runIp: d.runIp })

  assert.equal(r.reused, true)
  assert.equal(r.subnet, '172.20.5.0/24')
  assert.deepEqual(d.creates(), [], 'the reuse branch must not create a network')
  // Nor should it scan for conflicts: no `network ls` at all.
  assert.deepEqual(
    d.calls.filter((a) => a[1] === 'ls'),
    [],
  )
})

test('allocation steps over subnets already held by other networks on the host', () => {
  // Pre-fill the whole first /16 of the pool plus docker's own default range.
  const d = fakeDocker({ networks: { bridge: '172.17.0.0/16', other: '100.64.0.0/16' } })
  ensureEgressNetwork('px-deadbeef', d.run, { runIp: d.runIp })

  const subnet = subnetArgOf(d.creates()[0])
  assertInsidePool(subnet)
  assertAbove(subnet, '100.64.0.0/16')
})

test('a range known only to the host route table is still avoided', () => {
  // No docker network holds this; only the route table reveals it, which is the
  // case that matters for a VPS network or a wireguard tunnel.
  const routes = ['default via 10.0.0.1 dev eth0', '100.64.0.0/16 dev wg0 scope link'].join('\n')
  const d = fakeDocker({ routes })
  ensureEgressNetwork('px-deadbeef', d.run, { runIp: d.runIp })

  assertAbove(subnetArgOf(d.creates()[0]), '100.64.0.0/16')
})

test('an unreadable route table does not block network creation', () => {
  const d = fakeDocker()
  const r = ensureEgressNetwork('px-deadbeef', d.run, { runIp: () => ({ ok: false, stderr: 'ip: not found' }) })

  assert.equal(r.ok, true)
  assertInsidePool(subnetArgOf(d.creates()[0]))
})

test('portsForProxy stays a pure hash when no taken predicate is supplied', () => {
  const a = portsForProxy('px-a1b2c3d4')
  assert.deepEqual(portsForProxy('px-a1b2c3d4'), a)
  assert.equal(a.dns, a.tcp + 1)
  assert.ok(a.tcp >= 20000 && a.tcp < 20000 + 8000 * 2)
  // The folding contract: every local row on a host shares one pair.
  assert.deepEqual(portsForProxy('px-local-node-a'), portsForProxy('px-local'))
  assert.deepEqual(portsForProxy('px-local-node-b'), portsForProxy('px-local'))
})

test('portsForProxy probes past taken pairs and reports exhaustion', () => {
  const base = portsForProxy('px-a1b2c3d4')
  const next = portsForProxy('px-a1b2c3d4', { taken: (p) => p.tcp === base.tcp })

  assert.notEqual(next.tcp, base.tcp)
  assert.equal(next.tcp, base.tcp + 2, 'probing advances one slot at a time')
  assert.equal(next.dns, next.tcp + 1)

  // A collision on either port of the pair is enough to move on.
  const skipDns = portsForProxy('px-a1b2c3d4', { taken: (p) => p.dns === base.dns })
  assert.notEqual(skipDns.tcp, base.tcp)

  assert.throws(
    () => portsForProxy('px-a1b2c3d4', { taken: () => true }),
    (err) => {
      assert.equal(err.code, 'egress_ports_exhausted')
      return true
    },
  )
})

test('5000 distinct proxies each get a unique port pair when probing', () => {
  const used = new Set()
  for (let i = 0; i < 5000; i++) {
    const pair = portsForProxy(`px-${i}`, { taken: (p) => used.has(p.tcp) || used.has(p.dns) })
    assert.ok(!used.has(pair.tcp) && !used.has(pair.dns), `pair ${pair.tcp} handed out twice`)
    used.add(pair.tcp)
    used.add(pair.dns)
  }
  assert.equal(used.size, 10000)
})

test('portFromListenSpec reads the trailing port and rejects nonsense', () => {
  assert.equal(portFromListenSpec('100.64.0.1:20334'), 20334)
  assert.equal(portFromListenSpec('20334'), 20334)
  assert.equal(portFromListenSpec(''), 0)
  assert.equal(portFromListenSpec('100.64.0.1:0'), 0)
  assert.equal(portFromListenSpec('100.64.0.1:70000'), 0)
  assert.equal(portFromListenSpec(undefined), 0)
})

test('an already-started helper keeps its persisted pair instead of rehashing', (t) => {
  const root = tmpRoot(t)
  // A pair the hash would never pick, proving the persisted value wins.
  writeEgressConfig(root, 'px-a1b2c3d4', { tcp: 31000, dns: 31001 })

  assert.deepEqual(persistedEgressPorts(root, 'px-a1b2c3d4'), { tcp: 31000, dns: 31001 })
  assert.deepEqual(resolveEgressPorts(root, 'px-a1b2c3d4'), { tcp: 31000, dns: 31001 })
  assert.notEqual(resolveEgressPorts(root, 'px-a1b2c3d4').tcp, portsForProxy('px-a1b2c3d4').tcp)
})

test('a fresh helper probes past the pairs other helpers already wrote', (t) => {
  const root = tmpRoot(t)
  const wanted = portsForProxy('px-a1b2c3d4')
  // Another proxy squats exactly on the pair the hash wants.
  writeEgressConfig(root, 'px-squatter', { tcp: wanted.tcp, dns: wanted.dns })

  const used = allocatedEgressPorts(root, 'px-a1b2c3d4')
  assert.ok(used.has(wanted.tcp) && used.has(wanted.dns))

  const resolved = resolveEgressPorts(root, 'px-a1b2c3d4')
  assert.notEqual(resolved.tcp, wanted.tcp)
  assert.equal(resolved.tcp, wanted.tcp + 2)
})

test('allocatedEgressPorts excludes the proxy being resolved and tolerates junk', (t) => {
  const root = tmpRoot(t)
  writeEgressConfig(root, 'px-self', { tcp: 25000, dns: 25001 })
  // Unparsable config must not break collection.
  const junk = egressRunDir(root, 'px-junk')
  fs.mkdirSync(junk, { recursive: true })
  fs.writeFileSync(path.join(junk, 'egress.json'), 'not json')

  assert.deepEqual([...allocatedEgressPorts(root, 'px-self')], [])
  assert.deepEqual([...allocatedEgressPorts(root, 'px-other')].sort(), [25000, 25001])
  // A missing run directory is simply empty, never a throw.
  assert.deepEqual([...allocatedEgressPorts(path.join(root, 'nope'), '')], [])
})

test('local rows resolve to one shared pair, matching the folded bridge', (t) => {
  const root = tmpRoot(t)
  const shared = portsForProxy('px-local')
  writeEgressConfig(root, 'px-local', { tcp: shared.tcp, dns: shared.dns })

  // A node row reads the control-plane row's config, because both fold to px-local.
  assert.deepEqual(resolveEgressPorts(root, 'px-local-node-a'), shared)
  assert.deepEqual(resolveEgressPorts(root, 'px-local-node-b'), shared)
})

test('a node network gets an IPAM body with an explicit subnet and gateway', () => {
  const ipam = remoteEgressIpam({ name: 'kin-05-net' })

  assert.equal(ipam.Driver, 'default')
  assert.equal(ipam.Config.length, 1)
  const { Subnet, Gateway } = ipam.Config[0]
  assertInsidePool(Subnet)
  assert.equal(Gateway, gatewayOf(Subnet))
})

test('a node network rebuild lands on the same subnet', () => {
  assert.deepEqual(remoteEgressIpam({ name: 'kin-05-net' }), remoteEgressIpam({ name: 'kin-05-net' }))
  assert.notDeepEqual(remoteEgressIpam({ name: 'kin-05-net' }), remoteEgressIpam({ name: 'kin-06-net' }))
})

test('node allocation avoids subnets held by the node own networks', () => {
  const networks = [
    { Name: 'bridge', IPAM: { Config: [{ Subnet: '172.17.0.0/16' }] } },
    { Name: 'kin-01-net', IPAM: { Config: [{ Subnet: '100.64.0.0/16' }] } },
    { Name: 'host', IPAM: { Config: [] } },
    { Name: 'none' },
  ]
  const ipam = remoteEgressIpam({ name: 'kin-05-net', networks })

  assertInsidePool(ipam.Config[0].Subnet)
  assertAbove(ipam.Config[0].Subnet, '100.64.0.0/16')
})

test('node allocation avoids ranges only the node route table knows', () => {
  const routes = ['default via 10.0.0.1 dev eth0', '100.64.0.0/16 dev eth1 scope link'].join('\n')
  const ipam = remoteEgressIpam({ name: 'kin-05-net', routes })

  assertAbove(ipam.Config[0].Subnet, '100.64.0.0/16')
})

test('a drained node pool throws rather than silently falling back', () => {
  // Fill the configured pool entirely, so no slot is left.
  const networks = [{ Name: 'everything', IPAM: { Config: [{ Subnet: '100.64.0.0/10' }] } }]

  assert.throws(
    () => remoteEgressIpam({ name: 'kin-05-net', networks }),
    (err) => {
      assert.equal(err.code, 'subnet_pool_exhausted')
      return true
    },
  )
})
