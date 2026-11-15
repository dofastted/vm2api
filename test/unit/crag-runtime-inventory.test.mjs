import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { bindPlacement, unbindPlacement } from '../../src/lib/cluster/placement.mjs'
import {
  activateCragSubscriptionBinding,
  cragLicenseDirectory,
  prepareCragSubscriptionBinding,
  verifyCragHostEntitlement,
} from '../../src/lib/vm/crag-license.mjs'
import { createCragRuntimeInventory } from '../../src/lib/vm/crag-runtime-inventory.mjs'
import { cragSubscriptionPublicDirectory } from '../../src/lib/vm/crag-subscription-paths.mjs'
import {
  activateFixture,
  issueHostEntitlement,
  issueSlotPermit,
  seedEncryptedPackage,
  signSubscriptionBytes,
} from '../fixtures/crag-license.mjs'

const live = {
  ok: true,
  status: 200,
  runtime_variant: 'crag-v2',
  internalTokenAuthenticated: true,
  license_valid: true,
  worker_version: '3.0.8-native-v3',
  active: 1,
  active_requests: 2,
  queued: 0,
  ready_slots: 1,
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-inv-'))
  const saved = Object.fromEntries(
    ['KIN_SLOT_RUN_ROOT', 'KIN_CRS_MOCK', 'KIN_CRAG_V2_ROOT', 'KIN_DATA_DIR'].map((name) => [name, process.env[name]]),
  )
  for (const name of Object.keys(saved)) delete process.env[name]
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    fs.rmSync(root, { recursive: true, force: true })
  })
  const targets = []
  const hostId = randomBytes(32).toString('hex')
  let now = Date.now()
  function add(id, fields) {
    const vm = { id, dataplane: 'crag', status: 'running', ...fields }
    const dir = path.join(root, 'vms', id)
    fs.mkdirSync(path.join(dir, 'run'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'machine-id'), `${randomBytes(16).toString('hex')}\n`)
    targets.push(vm)
    return vm
  }
  const run = (vm, file) => path.join(root, 'vms', vm.id, 'run', file)
  const inventory = (options = {}) =>
    createCragRuntimeInventory({
      projectRoot: root,
      listTargets: () => targets,
      getRouting: () => ({}),
      now: () => now,
      observe: async () => ({ state: 'running' }),
      ...options,
    })
  function entitlement(slotLimit = 2, { roster, ...overrides } = {}) {
    const publicDir = cragSubscriptionPublicDirectory(root)
    fs.mkdirSync(publicDir, { recursive: true, mode: 0o755 })
    fs.writeFileSync(path.join(publicDir, 'host_id'), `${hostId}\n`, { mode: 0o644 })
    let { claims, code } = issueHostEntitlement(root, hostId, { slot_limit: slotLimit, ...overrides })
    if (roster) {
      claims = { ...claims, version: 2, roster }
      code = signSubscriptionBytes(root, 'CRAGH2', JSON.stringify(claims))
    }
    fs.writeFileSync(path.join(publicDir, 'entitlement.code'), `${code}\n`, { mode: 0o644 })
    return { hostId, claims: verifyCragHostEntitlement(root, code, hostId, { allowExpired: true }) }
  }
  function bind(vm, seat) {
    const machine = prepareCragSubscriptionBinding(root, vm)
    const { code } = issueSlotPermit(root, machine, hostId, { seat })
    activateCragSubscriptionBinding(root, vm, code)
    return { seat, permit_sha256: createHash('sha256').update(code).digest('hex') }
  }
  return {
    add,
    root,
    targets,
    hostId,
    run,
    inventory,
    entitlement,
    bind,
    advance: () => {
      now += 2100
    },
  }
}

test('signed downgrade counts both live processes but keeps independent and preinstalled slots separate', async (t) => {
  const f = fixture(t)
  seedEncryptedPackage(f.root)
  f.entitlement()
  const main = f.add('vm-11')
  const extra = f.add('vm-12')
  const independent = f.add('vm-13', { dataplane: 'wrap' })
  const parked = f.add('vm-14', { dataplane: 'wrap', status: 'stopped' })
  const standard = f.add('vm-15')
  f.bind(main, 1)
  f.bind(extra, 2)
  activateFixture(f.root, independent)
  fs.mkdirSync(path.join(f.root, 'vms', parked.id, 'cli-home', '.kin', 'crag-v2'), { recursive: true })
  const states = new Map()
  const inv = f.inventory({
    observe: async (vm, options) => {
      assert.equal(options.timeoutMs, 1500)
      assert.notEqual(vm.id, parked.id)
      return { state: states.get(vm.id) ?? 'running' }
    },
    health: async ({ vm }, options) => {
      assert.equal(options.timeoutMs, 2500)
      assert.equal(options.requireInternalToken, true)
      if (vm.id === standard.id) return { status: 200, ok: true, runtime_variant: 'cli-node' }
      if (vm.id === extra.id) return { ...live, status: 503, ok: false, license_valid: false, ready_slots: 0 }
      return live
    },
  })
  const rights = f.entitlement(1, { revision: 2 })
  const over = await inv.snapshot(rights)
  assert.equal(over.running_vms, 3)
  assert.equal(over.ready_vms, 1)
  assert.equal(over.host_running_vms, 2)
  assert.equal(over.host_runtime_available, 0)
  assert.equal(over.host_over_limit, true)
  assert.equal(new Date(over.checked_at).toISOString(), over.checked_at)
  assert.equal(over.vms[parked.id], undefined)
  assert.equal(over.vms[standard.id].state, 'not_running')
  assert.deepEqual(over.vms[independent.id], {
    state: 'running',
    ready: true,
    scope: 'independent',
    version: '3.0.8-native-v3',
    active_requests: 2,
    queued: 0,
    ready_slots: 1,
  })
  assert.equal(over.vms[main.id].ready, false)
  const hostOnly = await inv.snapshot({ ...rights, hostOnly: true })
  assert.deepEqual(Object.keys(hostOnly.vms).sort(), [main.id, extra.id])
  states.set(extra.id, 'unknown')
  f.advance()
  const uncertain = await inv.snapshot(rights)
  assert.equal(uncertain.host_unknown_vms, 1)
  assert.equal(uncertain.host_over_limit, null)
  states.set(extra.id, 'stopped')
  f.advance()
  const inQuota = await inv.snapshot(rights)
  assert.equal(inQuota.host_running_vms, 1)
  assert.equal(inQuota.host_over_limit, false)
  assert.equal(inQuota.vms[main.id].ready, true)
  main.schedulable = false
  assert.equal((await inv.snapshot(rights)).vms[main.id].ready, false)
  states.set(extra.id, 'running')
  f.advance()
  assert.equal((await inv.snapshot(rights)).host_over_limit, true)
})

test('H1 and H2 limits use fresh rights and corrupted permits give an upper bound, not confirmed use', async (t) => {
  const f = fixture(t)
  seedEncryptedPackage(f.root)
  const initial = f.entitlement()
  const main = f.add('vm-11')
  const uncertain = f.add('vm-12')
  const roster = [f.bind(main, 1), f.bind(uncertain, 2)]
  const inv = f.inventory({ health: async () => live })
  assert.equal((await inv.snapshot(initial)).host_running_vms, 2)
  fs.writeFileSync(path.join(cragLicenseDirectory(f.root, uncertain), 'registration.code'), 'CRAGS1.invalid.invalid')
  const available = await inv.snapshot(initial)
  assert.equal(available.host_running_vms, 1)
  assert.equal(available.host_unknown_vms, 1)
  assert.equal(available.host_runtime_available, null)
  assert.equal(available.host_over_limit, false)
  assert.equal(available.vms[uncertain.id].scope, 'unknown')
  const unlimited = f.entitlement('unlimited')
  assert.equal((await inv.snapshot(unlimited)).host_runtime_available, 'unlimited')
  assert.equal((await inv.snapshot({ ...unlimited, pending: true })).host_runtime_available, null)
  f.targets.pop()
  for (const limit of [10001, 'unlimited']) {
    const h2 = f.entitlement(limit, { roster })
    assert.equal((await inv.snapshot(h2)).host_runtime_available, 9999)
  }
  assert.equal((await inv.snapshot(f.entitlement(10001))).host_runtime_available, 10000)
  const seconds = Math.floor(Date.now() / 1000)
  const expired = f.entitlement(2, { issued_at: seconds - 300, expires_at: seconds - 120 })
  assert.equal((await inv.snapshot(expired)).host_runtime_available, 0)
  assert.equal((await inv.snapshot(expired)).host_over_limit, null)
})

test('a permit installed during probing contributes to the host upper bound', async (t) => {
  const f = fixture(t)
  seedEncryptedPackage(f.root)
  const rights = f.entitlement()
  const first = f.add('vm-11')
  const second = f.add('vm-12')
  f.bind(first, 1)
  const inv = f.inventory({
    health: async ({ vm }) => {
      assert.equal(vm.id, first.id, 'the second VM had no permit when probes were selected')
      f.bind(second, 2)
      return live
    },
  })
  const result = await inv.snapshot({ ...rights, hostOnly: true })
  assert.equal(result.host_running_vms, 1)
  assert.equal(result.host_unknown_vms, 1)
  assert.equal(result.host_over_limit, false)
  assert.equal(result.host_runtime_available, null)
  assert.equal(result.vms[second.id].state, 'unknown')
})

test('strict current-hop evidence supersedes an older negative without polluting the normal cache', async (t) => {
  const f = fixture(t)
  seedEncryptedPackage(f.root)
  const rights = f.entitlement(1)
  const vm = f.add('vm-11')
  f.bind(vm, 1)
  let reply = { status: 200, ok: true, runtime_variant: 'cli-node' }
  let probes = 0
  const inv = f.inventory({
    health: async () => {
      probes++
      return reply
    },
  })
  const snap = (health, id = vm.id) => inv.snapshot({ ...rights, hostOnly: true, currentHop: { id, health } })
  assert.equal((await snap(live, 'vm-other')).host_running_vms, 0)
  assert.equal((await snap(live)).host_running_vms, 1)
  assert.equal((await snap({ ...live, status: 403 })).host_running_vms, 0)
  assert.equal(probes, 1)
  // A live hint which cannot prove authentication must re-probe rather
  // than reusing the cached negative while the target is now accepting hops.
  reply = { ...live, runtime_variant: undefined, dataplane: 'crag', kernel_version: 'v2' }
  assert.equal((await snap({ ...live, internalTokenAuthenticated: undefined })).host_running_vms, 1)
  assert.equal(probes, 2)
})

test('published config selects candidates but only strict health can expose running metrics', async (t) => {
  const f = fixture(t)
  const switched = f.add('vm-31', { dataplane: 'wrap', status: 'stopped' })
  const busy = f.add('vm-32')
  const ordinary = f.add('vm-33', { dataplane: 'wrap' })
  const codex = f.add('vm-34', { platform: 'openai' })
  fs.writeFileSync(f.run(switched, 'kernel.json'), '{"dataplane":"crag","internal_token":"unpublished-secret"}')
  const seen = new Set()
  const result = await f
    .inventory({
      health: async ({ vm }) => {
        seen.add(vm.id)
        if (vm.id === switched.id) {
          return {
            ...live,
            worker_version: '/private/kernel',
            active_requests: -1,
            queued: '2',
            ready_slots: 0.5,
            credential: { token: 'private-health-secret' },
          }
        }
        if (vm.id === busy.id) return { ...live, ready_slots: 0, queued: 3 }
        return { status: 200, ok: true }
      },
    })
    .snapshot()
  assert.equal(result.running_vms, 2)
  assert.equal(result.ready_vms, 0)
  assert.equal(result.unknown_vms, 0, 'no-identity standard watch candidate is not a CRAG candidate')
  assert.deepEqual(result.vms[switched.id], {
    state: 'running',
    ready: false,
    scope: 'unknown',
    version: null,
    active_requests: null,
    queued: null,
    ready_slots: null,
  })
  assert.equal(result.vms[busy.id].ready_slots, 0)
  assert.equal(result.vms[busy.id].queued, 3)
  assert.equal(result.vms[ordinary.id], undefined)
  assert.equal(seen.has(codex.id), false)
  assert.doesNotMatch(JSON.stringify(result), /private|secret/)
})

test('genuine local ENOENT/ECONNREFUSED remain negative; stale paths and unauthenticated replies are unknown', async (t) => {
  const f = fixture(t)
  const make = (id, fields) => {
    const vm = f.add(id, fields)
    fs.writeFileSync(f.run(vm, 'internal.token'), 'test-token\n')
    return vm
  }
  const absent = make('vm-11')
  const refused = make('vm-12')
  const regular = make('vm-13')
  const kvm = make('vm-14', { runtime_type: 'kvm' })
  const noToken = f.add('vm-15')
  const denied = make('vm-16')
  const anonymous = make('vm-17')
  const signed = make('vm-18')
  fs.writeFileSync(f.run(regular, 'kernel.sock'), 'not a socket')
  async function serve(vm, handler) {
    const server = http.createServer(handler)
    server.listen(f.run(vm, 'kernel.sock'))
    await once(server, 'listening')
    return server
  }
  // Rename an open socket then close its listener. Node unlinks the original path,
  // leaving the renamed genuine Unix socket without a listener.
  const stale = await serve(refused, () => assert.fail('stale socket accepted a request'))
  fs.renameSync(f.run(refused, 'kernel.sock'), f.run(refused, 'stale.sock'))
  stale.close()
  await once(stale, 'close')
  fs.renameSync(f.run(refused, 'stale.sock'), f.run(refused, 'kernel.sock'))
  for (const vm of [denied, anonymous, signed]) {
    const server = await serve(vm, (req, res) => {
      assert.equal(req.headers['x-kin-internal-token'], 'test-token')
      res.statusCode = vm === denied ? 401 : 200
      res.end(JSON.stringify({ ...live, effective_config: vm === signed ? { transport: 'tui' } : undefined }))
    })
    t.after(() => {
      server.close()
      server.closeAllConnections()
    })
  }
  const data = (await f.inventory().snapshot()).vms
  for (const vm of [absent, refused]) assert.equal(data[vm.id].state, 'not_running', vm.id)
  for (const vm of [regular, kvm, noToken, denied, anonymous]) assert.equal(data[vm.id].state, 'unknown', vm.id)
  assert.equal(data[signed.id].state, 'running')
})

test('relay slots never connect to an unrelated recorded socket', async (t) => {
  const f = fixture(t)
  const paths = (node, id) => ({ kernel: path.join(f.root, `${node}-${id}.sock`) })
  bindPlacement({
    projectRoot: f.root,
    manager: { slotRelayPaths: paths, nodePlatform: (id) => (id === 'mac' ? 'darwin' : 'linux') },
  })
  t.after(unbindPlacement)
  const stalePath = path.join(f.root, 'stale.sock')
  const remote = f.add('vm-11', { node_id: 'node', runtime: { kernel_socket: stalePath } })
  const remoteMissing = f.add('vm-12', { node_id: 'node', runtime: { kernel_socket: stalePath } })
  const kvm = f.add('vm-13', { runtime: { type: 'kvm', kernel_socket: stalePath } })
  const mac = f.add('vm-14', { node_id: 'mac' })
  for (const socket of [stalePath, paths('node', remote.id).kernel, f.run(kvm, 'kernel.sock')]) {
    const server = http.createServer(() => assert.fail('fixture should use injected health'))
    server.listen(socket)
    await once(server, 'listening')
    t.after(() => server.close())
  }
  const seen = new Map()
  const inv = f.inventory({
    health: async ({ vm }) => {
      seen.set(vm.id, vm.runtime.kernel_socket)
      return vm.id === kvm.id ? live : { status: 0, code: 'ECONNREFUSED' }
    },
  })
  const { vms } = await inv.snapshot()
  assert.equal(vms[remote.id].state, 'unknown')
  assert.equal(vms[remoteMissing.id].state, 'unknown')
  assert.equal(vms[kvm.id].state, 'running')
  assert.equal(seen.size, 2)
  assert.equal(seen.get(remote.id), paths('node', remote.id).kernel)
  assert.equal(seen.get(kvm.id), f.run(kvm, 'kernel.sock'))
  assert.equal(seen.has(remoteMissing.id), false)
  assert.equal(seen.has(mac.id), false)
})

test('overlapping snapshots coalesce up to eight probes; expiry skips outstanding queue and config bytes invalidate cache', async (t) => {
  const f = fixture(t)
  for (let i = 1; i <= 12; i++) f.add(`vm-${i}`)
  let calls = 0
  let release
  let busy = new Promise((resolve) => {
    release = resolve
  })
  const inv = f.inventory({
    observe: async () => {
      calls++
      await busy
      return { state: 'stopped' }
    },
  })
  const first = inv.snapshot()
  const second = inv.snapshot()
  await nextTurn()
  assert.equal(calls, 8)
  release()
  await Promise.all([first, second])
  assert.equal(calls, 12)
  const vm = f.targets[0]
  fs.writeFileSync(f.run(vm, 'kernel.json'), '{"dataplane":"crag"}')
  await inv.snapshot()
  assert.equal(calls, 13)
  f.targets.shift()
  await inv.snapshot()
  f.targets.push(vm)
  await inv.snapshot()
  assert.equal(calls, 14)
  f.advance()
  busy = new Promise((resolve) => {
    release = resolve
  })
  try {
    await assert.rejects(inv.snapshot({ timeoutMs: 150 }), /crag_runtime_inventory_unavailable/)
    assert.equal(calls, 22)
  } finally {
    release()
  }
  await nextTurn()
  assert.equal(calls, 22, 'expired queued work did not start after the timeout')
})
