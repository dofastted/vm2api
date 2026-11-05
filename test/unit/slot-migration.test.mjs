import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  migrationRequest,
  startSlotMigration,
  slotMigrationJob,
  slotMigrationBusy,
} from '../../src/lib/cluster/slot-migration.mjs'
import { assertMigrationCapacity, assertMigrationProxy } from '../../src/lib/cluster/slot-migration-remote.mjs'
import { getVm, patchVmRecord, summarizeVm } from '../../src/lib/vm/vm-registry.mjs'
import { isKernelWatchdogTarget } from '../../src/lib/transport/kernel-watchdog.mjs'
import { reviveDownSlots } from '../../src/lib/vm/slot-recovery.mjs'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'

const G = 1024 ** 3
const vm = () => ({
  id: 'vm-move',
  node_id: 'node-a',
  status: 'running',
  runtime_type: 'kvm',
  kernel: 'debian-12',
  machine: { memory: '2g', vcpus: 2, disk_gb: 20 },
  runtime: { pid: 12 },
  schedule_off: true,
  schedule_off_reason: 'disabled',
  proxy: { id: 'px-a', url: 'socks5://203.0.113.7:1080' },
})

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-migration-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'))
  fs.writeFileSync(path.join(root, 'vms', 'vm-move.json'), JSON.stringify(vm()))
  const events = []
  const plan = {
    sameNode: false,
    from: '/source/vms/vm-move',
    backupDir: '/source/migration-backups/vm-move-job',
    summary: { source_node_id: 'node-a', target_node_id: 'node-b', memory: '4g' },
  }
  const args = {
    projectRoot: root,
    id: 'vm-move',
    body: { target_node_id: 'node-b', memory: '4g' },
    routing: {},
    poolScheduler: { vmInflight: new Map() },
    watchdog: {
      hold: async () => events.push('hold'),
      release: () => events.push('release'),
      reset: () => events.push('reset'),
    },
    ops: {
      preflight: async () => {
        events.push('preflight')
        return plan
      },
      wait: async () => {},
      stop: async () => {
        events.push('stop')
        return { ok: true }
      },
      preserve: async () => events.push('preserve'),
      copy: async () => {
        events.push('copy')
        return { copied_bytes: 1024, sha256: 'abc' }
      },
      publish: async () => events.push('publish'),
      finish: async () => events.push('finish'),
      rollback: async () => events.push('rollback'),
      powerOn: async () => {
        events.push(`boot:${getVm(root, 'vm-move').node_id}`)
        patchVmRecord(root, 'vm-move', { status: 'running' })
        return { ok: true }
      },
      diagnose: async () => {
        events.push('diagnose')
        return { ok: true }
      },
      ...overrides,
    },
  }
  return { root, args, events, plan }
}

test('migration input only permits remote KVM, enlargement and an explicit change', () => {
  assert.deepEqual(migrationRequest(vm(), { target_node_id: 'node-b', memory: '4g' }, {}), {
    targetNodeId: 'node-b',
    memory: '4g',
  })
  for (const body of [
    { target_node_id: 'node-a', memory: '2g' },
    { target_node_id: 'node-b', memory: '1g' },
    { target_node_id: 'node-b', memory: '4g', unknown: true },
  ])
    assert.throws(() => migrationRequest(vm(), body, {}))
  assert.throws(() => migrationRequest({ ...vm(), node_id: null }, { target_node_id: 'node-b' }, {}), {
    code: 'migration_unsupported',
  })
})

test('capacity includes allocations, KVM overhead, live availability and system reserve', () => {
  assertMigrationCapacity({ total: 32 * G, available: 10 * G, reserved: 20 * G, current: 0, requested: 4.5 * G })
  for (const values of [
    { total: 8 * G, available: 7 * G, reserved: 4 * G, current: 0, requested: 4.5 * G },
    { total: 32 * G, available: 4 * G, reserved: 0, current: 0, requested: 4.5 * G },
  ])
    assert.throws(() => assertMigrationCapacity(values), { code: 'migration_memory_full' })
  assertMigrationCapacity({ total: 32 * G, available: 4 * G, reserved: 20 * G, current: 2.5 * G, requested: 4.5 * G })
})

test('node-local exits cannot silently change when switching machines', () => {
  assertMigrationProxy(vm())
  for (const url of ['socks5://127.0.0.1:1080', 'socks5://localhost:1080'])
    assert.throws(() => assertMigrationProxy({ proxy: { url } }), { code: 'migration_node_local_proxy' })
})

test('cold migration holds, drains, copies, verifies, cleans and preserves operator schedule off', async (t) => {
  const { root, args, events } = fixture(t)
  const { done } = startSlotMigration(args)
  assert.equal(slotMigrationBusy(root, args.id), true)
  await done
  assert.deepEqual(events, [
    'preflight',
    'hold',
    'stop',
    'preserve',
    'copy',
    'publish',
    'boot:node-b',
    'reset',
    'diagnose',
    'finish',
    'release',
  ])
  const current = getVm(root, args.id)
  assert.equal(current.node_id, 'node-b')
  assert.equal(current.machine.memory, '4g')
  assert.equal(current.machine.disk_gb, 20)
  assert.equal(current.schedule_off, true)
  assert.equal(current.schedule_off_reason, 'disabled')
  assert.equal(current.schedule_hold, undefined)
  assert.equal(slotMigrationJob(root, args.id).status, 'done')
  assert.equal('rollback' in slotMigrationJob(root, args.id), false)
})

test('same-node expansion never copies the disk', async (t) => {
  const { args, plan, events } = fixture(t)
  plan.sameNode = true
  args.body.target_node_id = 'node-a'
  await startSlotMigration(args).done
  assert.equal(events.includes('copy'), false)
  assert.equal(events.includes('boot:node-a'), true)
})

test('preflight failure has no hold, stop, boot or release side effects', async (t) => {
  const { root, args, events } = fixture(t, {
    preflight: async () => {
      throw new Error('capacity full')
    },
  })
  await startSlotMigration(args).done
  assert.deepEqual(events, [])
  assert.equal(getVm(root, args.id).status, 'running')
  assert.equal(slotMigrationJob(root, args.id).status, 'failed')
})

test('busy drain is bounded and resumes original scheduling without stopping', async (t) => {
  let now = 0
  const { root, args, events } = fixture(t, { now: () => (now += 60_000) })
  args.poolScheduler.vmInflight.set(args.id, 1)
  await startSlotMigration(args).done
  assert.equal(events.includes('stop'), false)
  assert.equal(getVm(root, args.id).schedule_hold, undefined)
})

test('copy or verification failure restores original placement and memory only after rollback', async (t) => {
  for (const failure of ['copy', 'diagnose']) {
    const f = fixture(t, {
      [failure]: async (current) => {
        if (failure === 'diagnose' && current.node_id === 'node-a') return { ok: true }
        throw new Error('interrupted')
      },
    })
    await startSlotMigration(f.args).done
    const current = getVm(f.root, f.args.id)
    assert.equal(current.node_id, 'node-a')
    assert.equal(current.machine.memory, '2g')
    assert.equal(current.status, 'running')
    assert.equal(current.schedule_hold, undefined)
    assert.equal(slotMigrationJob(f.root, f.args.id).phase, 'rolled_back')
    assert.ok(f.events.indexOf('rollback') < f.events.lastIndexOf('boot:node-a'))
  }
})

test('uncertain rollback stays held and never starts a second copy', async (t) => {
  const { root, args, events } = fixture(t, {
    copy: async () => {
      throw new Error('interrupted')
    },
    rollback: async () => {
      throw new Error('target unavailable')
    },
  })
  await startSlotMigration(args).done
  assert.equal(slotMigrationJob(root, args.id).status, 'needs_attention')
  assert.equal(getVm(root, args.id).schedule_hold.reason, 'maintenance')
  assert.equal(
    events.some((e) => e.startsWith('boot:')),
    false,
  )
  assert.throws(() => startSlotMigration(args), { code: 'migration_not_running' })
})

test('serializes jobs and persists interrupted holds across restart without exposing rollback metadata', async (t) => {
  let resume
  const f = fixture(t, {
    preflight: () =>
      new Promise((resolve) => {
        resume = resolve
      }),
  })
  const first = startSlotMigration(f.args)
  assert.throws(() => startSlotMigration(f.args), { code: 'migration_busy' })
  await new Promise((r) => setImmediate(r))
  resume(f.plan)
  await first.done
  patchVmRecord(f.root, f.args.id, {
    slot_migration: { id: 'saved', status: 'running', phase: 'copying', rollback: { private: true } },
  })
  const saved = slotMigrationJob(f.root, f.args.id)
  assert.equal(saved.status, 'needs_attention')
  assert.equal('rollback' in saved, false)
  const raw = getVm(f.root, f.args.id)
  assert.equal(isKernelWatchdogTarget(raw), false)
  const summary = summarizeVm(raw, f.root)
  assert.equal(isKernelWatchdogTarget(summary), false)
  let inspected = false
  await reviveDownSlots({
    vms: [summary],
    inspect: async () => {
      inspected = true
    },
    powerOn: async () => {},
  })
  assert.equal(inspected, false)
})

test('migration API is administrator-only, including job history', () => {
  for (const method of ['GET', 'POST']) {
    for (const role of ['user', 'super'])
      assert.equal(authorizePanelRoute(method, '/api/panel/vms/vm-move/migration', role).ok, false)
    assert.equal(authorizePanelRoute(method, '/api/panel/vms/vm-move/migration', 'admin').ok, true)
  }
})

const helper = fileURLToPath(new URL('../../src/lib/cluster/slot-transfer.py', import.meta.url))
test('SSH helper round-trips a sparse cold disk, credentials, metadata and normal links; excludes transient run data', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-transfer-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'source'),
    target = path.join(root, 'target')
  for (const name of ['kvm', 'claude', 'cli-home', 'run', 'slot-bin'])
    fs.mkdirSync(path.join(source, name), { recursive: true })
  const disk = path.join(source, 'kvm/disk.qcow2')
  const fd = fs.openSync(disk, 'wx', 0o600)
  fs.writeSync(fd, Buffer.from('disk start'), 0, 10, 0)
  fs.writeSync(fd, Buffer.from('disk end'), 0, 8, 8 * 1024 ** 2)
  fs.closeSync(fd)
  fs.writeFileSync(path.join(source, 'claude/credentials.json'), 'synthetic-test-only', { mode: 0o600 })
  fs.writeFileSync(path.join(source, 'run/kernel.json'), 'transient')
  fs.symlinkSync('../claude/credentials.json', path.join(source, 'cli-home/credentials'))
  const stream = execFileSync('python3', [helper, 'send', source], { maxBuffer: 16 * 1024 ** 2, timeout: 30_000 })
  const receipt = JSON.parse(
    execFileSync('python3', [helper, 'receive', target, 'test-owner'], { input: stream, timeout: 30_000 }),
  )
  assert.deepEqual(fs.readFileSync(path.join(target, 'kvm/disk.qcow2')), fs.readFileSync(disk))
  assert.equal(fs.readlinkSync(path.join(target, 'cli-home/credentials')), '../claude/credentials.json')
  assert.equal(fs.readFileSync(path.join(target, 'cli-home/credentials'), 'utf8'), 'synthetic-test-only')
  assert.equal(fs.statSync(path.join(target, 'claude/credentials.json')).mode & 0o777, 0o600)
  assert.deepEqual(fs.readdirSync(path.join(target, 'run')), [])
  assert.equal(receipt.sha256.length, 64)
  const published = path.join(root, 'published')
  execFileSync('python3', [helper, 'publish', target, published, 'test-owner'])
  execFileSync('python3', [helper, 'remove', published, 'test-owner'])
  assert.equal(fs.existsSync(published), false)
})

test('ordinary interrupted transfer removes its own partial staging directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-transfer-interrupted-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const target = path.join(root, 'partial')
  const result = spawnSync('python3', [helper, 'receive', target, 'test-owner'], {
    input: Buffer.alloc(0),
    timeout: 5000,
  })
  assert.notEqual(result.status, 0)
  assert.equal(fs.existsSync(target), false)
})

test('panel POST starts a job, GET observes it, and another lifecycle mutation is rejected while moving', async (t) => {
  const { Readable } = await import('node:stream')
  const { createPanelHandler } = await import('../../src/lib/admin/panel-routes.mjs')
  const { readBody } = await import('../../src/lib/http/respond.mjs')
  let resume
  const f = fixture(t, {
    preflight: () =>
      new Promise((resolve) => {
        resume = resolve
      }),
  })
  const response = {}
  const handler = createPanelHandler({
    cfg: { paths: { project: f.root } },
    routingConfig: {},
    slotMigrationOps: f.args.ops,
    poolScheduler: f.args.poolScheduler,
    kernelWatchdog: f.args.watchdog,
    readBody,
    requireAuth(req) {
      req.apiKeyKind = 'master'
      req.panelRole = 'admin'
      return true
    },
    json(_res, status, body) {
      Object.assign(response, { status, body })
    },
  })
  async function request(method, suffix, body = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    req.method = method
    await handler(req, {}, new URL(`http://localhost/api/panel/vms/${f.args.id}/${suffix}`))
    return { ...response }
  }
  const started = await request('POST', 'migration', f.args.body)
  try {
    assert.equal(started.status, 202)
    assert.equal(started.body.data.status, 'running')
    const read = await request('GET', 'migration')
    assert.equal(read.body.data.id, started.body.data.id)
    const stop = await request('POST', 'stop')
    assert.equal(stop.status, 409)
    assert.equal(stop.body.error.code, 'migration_busy')
  } finally {
    await new Promise((r) => setImmediate(r))
    resume(f.plan)
    for (let attempt = 0; attempt < 20 && slotMigrationBusy(f.root, f.args.id); attempt++)
      await new Promise((r) => setImmediate(r))
  }
  assert.equal(slotMigrationJob(f.root, f.args.id).status, 'done')
})
