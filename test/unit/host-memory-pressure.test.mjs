import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  HOST_PRESSURE_CRITICAL,
  HOST_PRESSURE_OK,
  HOST_PRESSURE_TIGHT,
  LOCAL_HOST_KEY,
  createHostMemoryPressure,
  hostKeyOf,
  hostMemoryLevelForVm,
  installHostMemoryPressure,
  nextPressureLevel,
  normalizeHostMemoryPressure,
  readLocalMemory,
} from '../../src/lib/cluster/host-memory-pressure.mjs'

const GiB = 1024 ** 3
const quiet = { warn() {} }

test('normalize clamps ratios and keeps tight at or above critical', () => {
  const d = normalizeHostMemoryPressure()
  assert.equal(d.enabled, true)
  assert.equal(d.tight_available_ratio, 0.2)
  assert.equal(d.critical_available_ratio, 0.1)
  const c = normalizeHostMemoryPressure({
    tight_available_ratio: 0.05,
    critical_available_ratio: 0.15,
    recover_margin: 9,
  })
  assert.equal(c.critical_available_ratio, 0.15)
  assert.equal(c.tight_available_ratio, 0.15)
  assert.equal(c.recover_margin, 0.05)
  assert.equal(normalizeHostMemoryPressure({ enabled: false }).enabled, false)
  assert.equal(normalizeHostMemoryPressure({ interval_ms: 10 }).interval_ms, 15_000)
})

test('levels follow the available ratio with hysteresis on the way back', () => {
  const cfg = normalizeHostMemoryPressure()
  assert.equal(nextPressureLevel(HOST_PRESSURE_OK, 0.5, cfg), HOST_PRESSURE_OK)
  assert.equal(nextPressureLevel(HOST_PRESSURE_OK, 0.19, cfg), HOST_PRESSURE_TIGHT)
  assert.equal(nextPressureLevel(HOST_PRESSURE_OK, 0.09, cfg), HOST_PRESSURE_CRITICAL)
  // Leaving critical needs critical + margin (0.15); leaving tight needs tight + margin (0.25).
  assert.equal(nextPressureLevel(HOST_PRESSURE_CRITICAL, 0.12, cfg), HOST_PRESSURE_CRITICAL)
  assert.equal(nextPressureLevel(HOST_PRESSURE_CRITICAL, 0.16, cfg), HOST_PRESSURE_TIGHT)
  assert.equal(nextPressureLevel(HOST_PRESSURE_TIGHT, 0.22, cfg), HOST_PRESSURE_TIGHT)
  assert.equal(nextPressureLevel(HOST_PRESSURE_TIGHT, 0.26, cfg), HOST_PRESSURE_OK)
  assert.equal(nextPressureLevel(HOST_PRESSURE_OK, 0.22, cfg), HOST_PRESSURE_OK)
  assert.equal(nextPressureLevel(HOST_PRESSURE_TIGHT, Number.NaN, cfg), HOST_PRESSURE_OK)
})

test('samples this host and cluster nodes; stale and unknown machines count as ok', () => {
  let clock = 1_000_000
  let local = { total: 64 * GiB, available: 5 * GiB }
  const nodes = { 'node-a': { total: 256 * GiB, available: 100 * GiB, at: clock } }
  const logs = []
  const pressure = createHostMemoryPressure({
    readLocal: () => local,
    listNodes: () => Object.keys(nodes),
    readNode: (id) => nodes[id] || null,
    now: () => clock,
    log: { warn: (line) => logs.push(line) },
  })
  pressure.refresh()
  assert.equal(pressure.levelOf(LOCAL_HOST_KEY), HOST_PRESSURE_CRITICAL)
  assert.equal(pressure.levelOf('node-a'), HOST_PRESSURE_OK)
  assert.equal(pressure.levelOf('node-missing'), HOST_PRESSURE_OK)
  assert.equal(pressure.levelForVm({ id: 'vm-01' }), HOST_PRESSURE_CRITICAL)
  assert.equal(pressure.levelForVm({ id: 'vm-02', node_id: 'node-a' }), HOST_PRESSURE_OK)
  assert.match(logs[0], /\[host-memory\] local ok -> critical available=7\.8%/)

  nodes['node-a'] = { total: 256 * GiB, available: 40 * GiB, at: clock }
  local = { total: 64 * GiB, available: 9 * GiB }
  pressure.refresh()
  assert.equal(pressure.levelOf('node-a'), HOST_PRESSURE_TIGHT)
  assert.equal(pressure.levelOf(LOCAL_HOST_KEY), HOST_PRESSURE_CRITICAL, 'held until critical + margin')
  assert.equal(pressure.snapshot().length, 2)

  // The node's health probe stops answering: its old sample no longer blocks anything.
  clock += 121_000
  local = { total: 64 * GiB, available: 32 * GiB }
  pressure.refresh()
  assert.equal(pressure.levelOf('node-a'), HOST_PRESSURE_OK)
  assert.equal(pressure.levelOf(LOCAL_HOST_KEY), HOST_PRESSURE_OK)
})

test('disabled config reports ok and skips sampling', () => {
  let reads = 0
  const pressure = createHostMemoryPressure({
    getConfig: () => ({ enabled: false }),
    readLocal: () => {
      reads++
      return { total: 10, available: 0 }
    },
    log: quiet,
  })
  assert.equal(pressure.refresh().skipped, 'disabled')
  assert.equal(reads, 0)
  pressure.sample(LOCAL_HOST_KEY, { total: 10, available: 0 })
  assert.equal(pressure.levelOf(LOCAL_HOST_KEY), HOST_PRESSURE_OK)
})

test('invalid figures are ignored', () => {
  const pressure = createHostMemoryPressure({ log: quiet })
  assert.equal(pressure.sample('x', { total: 0, available: 1 }), null)
  assert.equal(pressure.sample('x', { total: 10, available: -1 }), null)
  assert.equal(pressure.snapshot().length, 0)
})

test('readLocalMemory parses /proc/meminfo', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-meminfo-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'meminfo')
  fs.writeFileSync(file, 'MemTotal:       65536000 kB\nMemFree:  100 kB\nMemAvailable:   16384000 kB\n')
  assert.deepEqual(readLocalMemory({ meminfoPath: file }), { total: 65536000 * 1024, available: 16384000 * 1024 })
  const fallback = readLocalMemory({ meminfoPath: path.join(dir, 'missing') })
  assert.ok(fallback.total > 0)
})

test('installed instance answers hostMemoryLevelForVm; none installed is ok', (t) => {
  t.after(() => installHostMemoryPressure(null))
  assert.equal(hostMemoryLevelForVm({ id: 'vm-01' }), HOST_PRESSURE_OK)
  const pressure = installHostMemoryPressure(createHostMemoryPressure({ log: quiet }))
  pressure.sample('node-b', { total: 100, available: 15 })
  assert.equal(hostMemoryLevelForVm({ id: 'vm-01', node_id: 'node-b' }), HOST_PRESSURE_TIGHT)
  assert.equal(hostKeyOf({ node_id: 'node-b' }), 'node-b')
  assert.equal(hostKeyOf({}), LOCAL_HOST_KEY)
})
