import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SUBNET_POOL,
  DEFAULT_SUBNET_PREFIX,
  allocateSubnet,
  collectTakenSubnets,
  createSubnetAllocator,
  formatCidr,
  hashIndex,
  overlaps,
  parseCidr,
  parseRouteSubnets,
  probeIndex,
  subnetAt,
} from '../../src/lib/vm/subnet-pool.mjs'

const SCALE = 5000

/** Expand a cidr string into its inclusive numeric bounds for overlap assertions. */
function bounds(cidr) {
  const parsed = parseCidr(cidr)
  assert.ok(parsed, `expected a parsable cidr, got ${cidr}`)
  return { start: parsed.network, end: parsed.network + parsed.size - 1 }
}

function assertPairwiseDisjoint(cidrs) {
  const ranges = cidrs.map(bounds).sort((a, b) => a.start - b.start)
  for (let i = 1; i < ranges.length; i++) {
    assert.ok(
      ranges[i].start > ranges[i - 1].end,
      `subnets overlap: [${ranges[i - 1].start},${ranges[i - 1].end}] vs [${ranges[i].start},${ranges[i].end}]`,
    )
  }
}

test('parseCidr normalizes to the network address and rejects malformed input', () => {
  assert.deepEqual(parseCidr('100.64.0.0/10'), { network: 0x64400000, prefix: 10, size: 2 ** 22 })
  // Host bits are masked off rather than accepted verbatim.
  assert.equal(formatCidr(parseCidr('100.64.3.77/28').network, 28), '100.64.3.64/28')
  assert.equal(parseCidr('0.0.0.0/0').network, 0)
  assert.equal(parseCidr('255.255.255.255/32').network, 0xffffffff)

  for (const bad of ['', '100.64.0.0', '100.64.0.0/33', '256.0.0.0/8', 'abc', '10.0.0.0/-1', null, undefined]) {
    assert.equal(parseCidr(bad), null, `expected null for ${String(bad)}`)
  }
})

test('overlaps is symmetric and detects containment in both directions', () => {
  const pool = parseCidr('100.64.0.0/10')
  const inside = parseCidr('100.64.3.64/28')
  const outside = parseCidr('10.0.0.0/8')

  assert.equal(overlaps(pool, inside), true)
  assert.equal(overlaps(inside, pool), true)
  assert.equal(overlaps(pool, outside), false)
  assert.equal(overlaps(outside, pool), false)
  // Adjacent, non-overlapping neighbours.
  assert.equal(overlaps(parseCidr('100.64.0.0/28'), parseCidr('100.64.0.16/28')), false)
  assert.equal(overlaps(null, pool), false)
})

test('subnetAt walks the pool in prefix-sized steps without wrapping', () => {
  const pool = parseCidr('100.64.0.0/10')
  assert.equal(formatCidr(subnetAt(pool, 28, 0), 28), '100.64.0.0/28')
  assert.equal(formatCidr(subnetAt(pool, 28, 1), 28), '100.64.0.16/28')
  assert.equal(formatCidr(subnetAt(pool, 28, 16), 28), '100.64.1.0/28')
  // Last index of /10 carved into /28 stays inside the pool.
  const total = 2 ** (28 - 10)
  assert.equal(formatCidr(subnetAt(pool, 28, total - 1), 28), '100.127.255.240/28')
})

test('hashIndex and probeIndex are deterministic for the same id', () => {
  assert.equal(hashIndex('vm-234', 1000), hashIndex('vm-234', 1000))
  assert.notEqual(hashIndex('vm-234', 1000), hashIndex('vm-235', 1000))
  assert.ok(hashIndex('vm-234', 1000) < 1000)

  const free = () => false
  assert.equal(probeIndex('vm-1', 64, free), probeIndex('vm-1', 64, free))
})

test('probeIndex steps past taken indexes and reports exhaustion as -1', () => {
  const base = hashIndex('vm-1', 8)
  // Everything but the slot two steps on is taken.
  const target = (base + 2) % 8
  assert.equal(
    probeIndex('vm-1', 8, (i) => i !== target),
    target,
  )
  assert.equal(
    probeIndex('vm-1', 8, () => true),
    -1,
  )
  // A probe budget below the pool size still bails out rather than looping forever.
  assert.equal(
    probeIndex('vm-1', 1024, () => true, 4),
    -1,
  )
})

test('allocates 5000+ subnets that are pairwise disjoint and inside the pool', () => {
  const allocator = createSubnetAllocator()
  assert.equal(allocator.pool, DEFAULT_SUBNET_POOL)
  assert.equal(allocator.prefix, DEFAULT_SUBNET_PREFIX)

  const poolRange = bounds(DEFAULT_SUBNET_POOL)
  const seen = []
  for (let i = 0; i < SCALE; i++) seen.push(allocator.allocate(`vm-${i}`))

  assert.equal(seen.length, SCALE)
  assert.equal(new Set(seen).size, SCALE, 'every allocation must be unique')
  assert.equal(allocator.used, SCALE)
  assertPairwiseDisjoint(seen)

  for (const cidr of seen) {
    const range = bounds(cidr)
    assert.ok(
      range.start >= poolRange.start && range.end <= poolRange.end,
      `${cidr} escaped the pool ${DEFAULT_SUBNET_POOL}`,
    )
    assert.ok(cidr.endsWith(`/${DEFAULT_SUBNET_PREFIX}`))
  }
})

test('allocation avoids pre-seeded conflicts from docker networks and host routes', () => {
  // A /16 swallows 256 of the /28 slots; the /12 covers docker's own default range.
  const taken = ['100.64.0.0/16', '172.17.0.0/12', '10.0.0.0/8', '192.168.1.0/24']
  const allocator = createSubnetAllocator({ taken })
  const conflicts = taken.map(bounds)

  for (let i = 0; i < 500; i++) {
    const range = bounds(allocator.allocate(`vm-${i}`))
    for (const c of conflicts) {
      assert.ok(range.end < c.start || range.start > c.end, `allocation landed in a reserved range`)
    }
  }
  // Only the /16 intersects the pool, so exactly its slots are pre-marked.
  assert.equal(allocator.used, 2 ** (28 - 16) + 500)
})

test('hand-carved operator subnets are read back as occupied, needing no migration', () => {
  // Stand-ins for the spare ranges handed to vm-234 / vm-235 on the live hosts.
  const manual = ['100.64.9.16/28', '100.64.9.32/28']
  const allocator = createSubnetAllocator({ taken: manual })

  for (const cidr of manual) assert.equal(allocator.isTaken(cidr), true)

  const handed = []
  for (let i = 0; i < 200; i++) handed.push(allocator.allocate(`vm-${i}`))
  for (const cidr of manual) {
    assert.ok(!handed.includes(cidr), `${cidr} was handed out despite being carved out by hand`)
  }
})

test('the same id reclaims its subnet on rebuild, and a released subnet is reusable', () => {
  const first = allocateSubnet('vm-234')
  assert.equal(allocateSubnet('vm-234'), first, 'a rebuild must land on the same subnet')
  assert.notEqual(allocateSubnet('vm-235'), first)

  // Still occupied: a second id probes past it.
  const busy = createSubnetAllocator({ taken: [first] })
  assert.notEqual(busy.allocate('vm-234'), first)

  // Released: the next round hands it back, because taken is recomputed from reality.
  assert.equal(createSubnetAllocator().allocate('vm-234'), first)
})

test('reserve marks later allocations as occupied and ignores ranges outside the pool', () => {
  const allocator = createSubnetAllocator()
  const target = allocateSubnet('vm-777')

  allocator.reserve(target)
  assert.equal(allocator.isTaken(target), true)
  assert.notEqual(allocator.allocate('vm-777'), target)

  const before = allocator.used
  allocator.reserve('10.1.2.0/24')
  allocator.reserve('not-a-cidr')
  assert.equal(allocator.used, before, 'out-of-pool and malformed reserves must not consume slots')
})

test('a full pool throws subnet_pool_exhausted carrying the water level', () => {
  // /24 carved into /28 leaves 16 slots.
  const allocator = createSubnetAllocator({ pool: '100.64.0.0/24', prefix: 28 })
  assert.equal(allocator.total, 16)
  for (let i = 0; i < 16; i++) allocator.allocate(`vm-${i}`)

  assert.throws(
    () => allocator.allocate('vm-overflow'),
    (err) => {
      assert.equal(err.code, 'subnet_pool_exhausted')
      assert.deepEqual(err.water, { used: 16, total: 16, pool: '100.64.0.0/24', ratio: 1 })
      return true
    },
  )
})

test('invalid pool or prefix is rejected up front', () => {
  assert.throws(() => createSubnetAllocator({ pool: 'nope' }), /invalid subnet pool/)
  // A prefix shorter than the pool would hand out ranges larger than the pool itself.
  assert.throws(() => createSubnetAllocator({ pool: '100.64.0.0/10', prefix: 8 }), /invalid subnet prefix/)
  // /31 and /32 cannot host a gateway plus a container.
  assert.throws(() => createSubnetAllocator({ prefix: 31 }), /invalid subnet prefix/)
  assert.throws(() => createSubnetAllocator({ prefix: 24.5 }), /invalid subnet prefix/)
})

test('parseRouteSubnets keeps real routes and drops the default route', () => {
  const routes = [
    'default via 172.31.1.1 dev eth0 proto static',
    '100.64.0.0/28 dev kegabc proto kernel scope link src 100.64.0.1',
    '172.17.0.0/16 dev docker0 proto kernel scope link src 172.17.0.1',
    '10.8.0.3 dev wg0 scope link',
    '',
  ].join('\n')

  const parsed = parseRouteSubnets(routes).map((c) => formatCidr(c.network, c.prefix))
  assert.deepEqual(parsed, ['100.64.0.0/28', '172.17.0.0/16', '10.8.0.3/32'])
})

test('collectTakenSubnets batches docker inspect and merges host routes', () => {
  const calls = []
  const names = Array.from({ length: 450 }, (_, i) => `net${i}`)
  const runDocker = (args) => {
    calls.push(args)
    if (args[1] === 'ls') return { ok: true, stdout: names.join('\n') }
    // One subnet per inspected id, so the batching is observable.
    const ids = args.slice(4)
    return { ok: true, stdout: ids.map((_, i) => `100.64.${i}.0/28`).join(' ') }
  }
  const runIp = () => ({ ok: true, stdout: '172.20.0.0/16 dev eth0 scope link' })

  const taken = collectTakenSubnets({ runDocker, runIp })
  const inspects = calls.filter((a) => a[1] === 'inspect')
  assert.equal(inspects.length, 3, '450 networks must inspect in batches of 200')
  assert.deepEqual(
    inspects.map((a) => a.slice(4).length),
    [200, 200, 50],
  )
  assert.ok(
    taken.some((c) => formatCidr(c.network, c.prefix) === '172.20.0.0/16'),
    'host routes must be merged',
  )
})

test('collectTakenSubnets tolerates docker and ip failures without throwing', () => {
  assert.deepEqual(collectTakenSubnets({}), [])
  assert.deepEqual(collectTakenSubnets({ runDocker: () => ({ ok: false, stderr: 'boom' }) }), [])
  assert.deepEqual(
    collectTakenSubnets({
      runDocker: () => ({ ok: true, stdout: 'net1' }),
      runIp: () => ({ ok: false, stderr: 'no ip tool' }),
    }).length,
    0,
    'a failed inspect contributes nothing rather than a bogus subnet',
  )
})
