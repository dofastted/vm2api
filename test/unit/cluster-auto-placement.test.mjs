import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  bookedByMachine,
  bookedMiB,
  createPlacementLedger,
  normalizeAutoPlacement,
  pickPlacement,
  placementCandidates,
  rankPlacement,
  readLocalHost,
  requestedPlacement,
} from '../../src/lib/cluster/auto-placement.mjs'

const GiB = 1024 ** 3

function host(totalGiB, { usedGiB = 0, cpus = 8, load1 = 0 } = {}) {
  return { cpu_count: cpus, load1, mem_total: totalGiB * GiB, mem_used: usedGiB * GiB }
}

function node(id, h, extra = {}) {
  return { id, platform: 'linux', link: { state: 'ready' }, health: { docker: { ok: true }, host: h }, ...extra }
}

const slot = (memory, nodeId = null) => ({ machine: { memory }, ...(nodeId ? { node_id: nodeId } : {}) })

test('normalizeAutoPlacement: off by default, bad values fall back', () => {
  const d = normalizeAutoPlacement(undefined)
  assert.equal(d.enabled, false)
  assert.equal(d.include_local, true)
  assert.equal(d.on_full, 'local')
  const p = normalizeAutoPlacement({
    enabled: true,
    max_commit_ratio: 5,
    min_free_memory: 'lots',
    slot_reserve_memory: '8G',
    nodes: ['n1', 'n1', ''],
    on_full: 'reject',
  })
  assert.equal(p.max_commit_ratio, 0.85)
  assert.equal(p.min_free_memory, '2g')
  assert.equal(p.slot_reserve_memory, '8g')
  assert.deepEqual(p.nodes, ['n1'])
  assert.equal(p.on_full, 'reject')
})

test('requestedPlacement: node_id wins, body overrides config', () => {
  const on = normalizeAutoPlacement({ enabled: true })
  const off = normalizeAutoPlacement({})
  assert.deepEqual(requestedPlacement({ node_id: 'n1', placement: 'auto' }, on), { mode: 'node', nodeId: 'n1' })
  assert.equal(requestedPlacement({}, on).mode, 'auto')
  assert.equal(requestedPlacement({}, off).mode, 'local')
  assert.equal(requestedPlacement({ placement: 'local' }, on).mode, 'local')
  assert.equal(requestedPlacement({ placement: 'auto' }, off).mode, 'auto')
})

const tier = (rlt) => ({ claude: { rate_limit_tier: rlt } })

test('bookedByMachine: unknown plan books the reserve, or the limit when larger, per machine', () => {
  const policy = normalizeAutoPlacement({ slot_reserve_memory: '4g' })
  const booked = bookedByMachine([slot('2g'), slot('8g'), slot('1g', 'n1')], null, policy)
  assert.equal(booked.get('local'), 4096 + 8192)
  assert.equal(booked.get('n1'), 4096)
})

test('bookedMiB: a known plan books its target, not the reserve', () => {
  const policy = normalizeAutoPlacement({ slot_reserve_memory: '4g' })
  // Pro targets 2g, Max 5x 4g, Max 20x 8g; a recorded limit above the target still counts.
  assert.equal(bookedMiB({ ...slot('2g'), ...tier('default_claude_ai') }, null, policy), 2048)
  assert.equal(bookedMiB({ ...slot('512m'), ...tier('default_claude_max_5x') }, null, policy), 4096)
  assert.equal(bookedMiB({ ...slot('4g'), ...tier('default_claude_max_20x') }, null, policy), 8192)
  assert.equal(bookedMiB({ ...slot('8g'), ...tier('default_claude_ai') }, null, policy), 8192)
})

test('bookedMiB: unknown plan without a reserve books the largest plan target', () => {
  const policy = normalizeAutoPlacement({})
  assert.equal(bookedMiB(slot('512m'), null, policy), 8192)
  // Plan ratios come from routing.slot_capacity: a smaller top plan books less.
  const routing = { slot_capacity: { plans: { pro: 5, max_5x: 12, max_20x: 12, default: 5 } } }
  assert.equal(bookedMiB(slot('512m'), routing, policy), 4096)
})

test('bookedMiB: Codex slots and capacity off keep limit-or-reserve', () => {
  const policy = normalizeAutoPlacement({ slot_reserve_memory: '4g' })
  assert.equal(bookedMiB({ ...slot('1g'), platform: 'openai' }, null, policy), 4096)
  assert.equal(bookedMiB({ ...slot('1g'), platform: 'openai' }, null, normalizeAutoPlacement({})), 1024)
  const off = { slot_capacity: { enabled: false } }
  assert.equal(bookedMiB({ ...slot('2g'), ...tier('default_claude_max_20x') }, off, policy), 4096)
})

test('placementCandidates: skips nodes that cannot take a slot, honours allow/deny lists', () => {
  const nodes = [
    node('ready', host(64)),
    node('down', host(64), { link: { state: 'connecting' } }),
    node('mac', host(64), { platform: 'darwin' }),
    node('nodock', host(64), { health: { docker: { ok: false }, host: host(64) } }),
    node('blind', null),
    node('denied', host(64)),
  ]
  const policy = normalizeAutoPlacement({ exclude_nodes: ['denied'] })
  const got = placementCandidates({ nodes, localHost: host(32), policy })
  assert.deepEqual(
    got.map((c) => [c.id, c.skip || null]),
    [
      ['local', null],
      ['ready', null],
      ['down', 'link_not_ready'],
      ['mac', 'not_linux'],
      ['nodock', 'docker_unavailable'],
      ['blind', 'no_host_facts'],
    ],
  )
  const only = placementCandidates({
    nodes,
    localHost: host(32),
    policy: normalizeAutoPlacement({ nodes: ['ready'], include_local: false }),
  })
  assert.deepEqual(
    only.map((c) => c.id),
    ['ready'],
  )
})

test('rankPlacement: most booked headroom share first; vetoes full, starved and busy machines', () => {
  const policy = normalizeAutoPlacement({ max_commit_ratio: 0.5 })
  const candidates = [
    { id: 'local', local: true, host: host(64) },
    { id: 'big', local: false, host: host(128) },
    { id: 'starved', local: false, host: host(128, { usedGiB: 127 }) },
    { id: 'busy', local: false, host: host(128, { cpus: 4, load1: 8 }) },
    { id: 'full', local: false, host: host(16) },
  ]
  // local: 32G capacity, 24G booked; big: 64G capacity, 16G booked; full: 8G capacity, 8G booked
  const booked = new Map([
    ['local', 24 * 1024],
    ['big', 16 * 1024],
    ['full', 8 * 1024],
  ])
  const { rows, order } = rankPlacement({ candidates, booked, needMiB: 4096, policy })
  assert.deepEqual(
    order.map((r) => r.id),
    ['big', 'local'],
  )
  const why = Object.fromEntries(rows.map((r) => [r.id, r.reason]))
  assert.equal(why.starved, 'memory_available')
  assert.equal(why.busy, 'cpu_load')
  assert.equal(why.full, 'memory_booked')
})

test('rankPlacement: a commit ratio above 1 books past RAM; live memory still vetoes', () => {
  const policy = normalizeAutoPlacement({ max_commit_ratio: 1.6 })
  assert.equal(policy.max_commit_ratio, 1.6)
  const candidates = [
    { id: 'roomy', local: false, host: host(64) },
    { id: 'starved', local: false, host: host(64, { usedGiB: 63 }) },
  ]
  // 64G × 1.6 = 102.4G bookable; 80G already booked on each.
  const booked = new Map([
    ['roomy', 80 * 1024],
    ['starved', 80 * 1024],
  ])
  const { rows, order } = rankPlacement({ candidates, booked, needMiB: 4096, policy })
  assert.deepEqual(
    order.map((r) => r.id),
    ['roomy'],
  )
  const roomy = rows.find((r) => r.id === 'roomy')
  assert.equal(roomy.capacity_mib, Math.floor(64 * 1024 * 1.6))
  assert.equal(rows.find((r) => r.id === 'starved').reason, 'memory_available')
  const full = rankPlacement({ candidates, booked: new Map([['roomy', 100 * 1024]]), needMiB: 4096, policy })
  assert.equal(full.rows.find((r) => r.id === 'roomy').reason, 'memory_booked')
})

test('rankPlacement: equal share prefers more absolute room, then local', () => {
  const policy = normalizeAutoPlacement({})
  const { order } = rankPlacement({
    candidates: [
      { id: 'n1', local: false, host: host(64) },
      { id: 'local', local: true, host: host(64) },
    ],
    booked: new Map(),
    needMiB: 1024,
    policy,
  })
  assert.equal(order[0].id, 'local')
})

test('rankPlacement: memory used by other workloads on a shared node lowers its rank', () => {
  const policy = normalizeAutoPlacement({})
  const { order } = rankPlacement({
    // shared: nothing booked here, but 100G of 128G already used by other services
    candidates: [
      { id: 'shared', local: false, host: host(128, { usedGiB: 100 }) },
      { id: 'quiet', local: false, host: host(64) },
    ],
    booked: new Map(),
    needMiB: 8192,
    policy,
  })
  assert.deepEqual(
    order.map((r) => r.id),
    ['quiet', 'shared'],
  )
  assert.equal(order[1].usable_mib, 28 * 1024 - 2048)
})

test('pickPlacement: node failing preflight is skipped for the next candidate', async () => {
  const policy = normalizeAutoPlacement({ enabled: true })
  const seen = []
  const picked = await pickPlacement({
    vm: slot('4g'),
    vms: [slot('8g'), slot('8g'), slot('8g')],
    policy,
    nodes: [node('bad', host(256)), node('good', host(128))],
    localHost: host(64),
    preflight: async (id) => {
      seen.push(id)
      return id === 'bad' ? { ok: false, checks: [{ id: 'image', ok: false }] } : { ok: true }
    },
    ledger: createPlacementLedger(),
  })
  assert.deepEqual(seen, ['bad', 'good'])
  assert.equal(picked.node_id, 'good')
  assert.equal(picked.report.chosen, 'good')
  assert.equal(picked.report.candidates.find((r) => r.id === 'bad').reason, 'preflight_failed')
})

test('pickPlacement: in-flight holds steer concurrent creates apart and expire', async () => {
  let t = 0
  const ledger = createPlacementLedger({ ttlMs: 1000, now: () => t })
  const policy = normalizeAutoPlacement({ enabled: true, include_local: true })
  const args = {
    vm: slot('8g'),
    vms: [],
    policy,
    nodes: [node('n1', host(32))],
    localHost: host(32),
    preflight: async () => ({ ok: true }),
    ledger,
  }
  const first = await pickPlacement(args)
  const second = await pickPlacement(args)
  assert.notEqual(first.node_id, second.node_id)
  first.release()
  second.release()
  ledger.hold('local', 1024 * 1024)
  t = 2000
  assert.equal(ledger.snapshot().size, 0)
})

test('pickPlacement: everything full → local fallback, or 409 when on_full=reject', async () => {
  const args = {
    vm: slot('8g'),
    vms: [slot('8g'), slot('8g')],
    nodes: [],
    localHost: host(16),
    preflight: async () => ({ ok: true }),
    ledger: createPlacementLedger(),
  }
  const soft = await pickPlacement({ ...args, policy: normalizeAutoPlacement({ enabled: true }) })
  assert.equal(soft.node_id, null)
  assert.equal(soft.report.fallback, true)
  const hard = await pickPlacement({ ...args, policy: normalizeAutoPlacement({ enabled: true, on_full: 'reject' }) })
  assert.equal(hard.error.status, 409)
  assert.equal(hard.error.code, 'placement_no_capacity')
})

test('readLocalHost: uses MemAvailable from meminfo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-meminfo-'))
  try {
    const file = path.join(dir, 'meminfo')
    fs.writeFileSync(file, 'MemTotal:       4194304 kB\nMemFree:  100 kB\nMemAvailable:   1048576 kB\n')
    const h = readLocalHost({ meminfo: file })
    assert.equal(h.mem_total, 4 * GiB)
    assert.equal(h.mem_used, 3 * GiB)
    assert.ok(h.cpu_count >= 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
