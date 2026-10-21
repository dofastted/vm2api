import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDb } from '../../src/lib/db/database.mjs'
import { SharedBackgroundTasks } from '../../src/lib/core/shared-background-tasks.mjs'
import { SharedVmOperations } from '../../src/lib/vm/shared-vm-operations.mjs'
import { ExecutionAdmissionsRepo } from '../../src/lib/db/repos/execution-admissions-repo.mjs'
import { createKernelWatchdog } from '../../src/lib/transport/kernel-watchdog.mjs'

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-watchdog-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'kernel.json'), JSON.stringify({ slots_per_worker: 1 }))
  const vm = { id: 'vm-shared-watchdog', status: 'running', runtime: { worker_run_dir: root } }
  const db = getDb()
  return {
    vm,
    create: (extra = {}) =>
      createKernelWatchdog({
        listTargets: () => [vm],
        probeVm: () => vm,
        health: async () => ({ ok: true, healthy: true, ready_slots: 20 }),
        observeRuntime: async () => ({ state: 'running' }),
        sharedTasks: new SharedBackgroundTasks(db),
        operations: new SharedVmOperations(db),
        ensure: async () => ({ ok: true }),
        ...overrides,
        ...extra,
      }),
  }
}

function reserve() {
  return new ExecutionAdmissionsRepo(getDb()).tryReserve({
    accountId: 'watchdog-account',
    vmId: 'vm-shared-watchdog',
    accountLimit: 2,
    vmLimit: 2,
    fableLimit: 0,
    rpmLimit: 0,
  })
}

test('watchdog recovery cannot mutate a globally occupied VM', async (t) => {
  let restarts = 0
  const fx = fixture(t, {
    ensure: async () => {
      restarts++
      return { ok: true }
    },
  })
  const active = await reserve()
  assert.equal(active.ok, true)
  await fx.create().tick()
  assert.equal(restarts, 0)
  await active.release()
})

test('two controller watchdogs execute one shared VM check plan', async (t) => {
  let restarts = 0
  const fx = fixture(t, {
    ensure: async () => {
      restarts++
      return { ok: true }
    },
  })
  await Promise.all([fx.create().tick(), fx.create().tick()])
  assert.equal(restarts, 1)
})

test('an unconfirmed watchdog recovery retains VM and background occupancy', async (t) => {
  const fx = fixture(t, { ensure: async () => ({ ok: false, error: 'termination unknown' }) })
  await fx.create().tick()
  assert.equal((await reserve()).code, 'vm_operation_active')
  const row = await getDb().prepare('SELECT unknown_at, finished_at FROM background_task_runs').get()
  assert.ok(row.unknown_at)
  assert.equal(row.finished_at, null)
})

test('watchdog flush waits for off-path telemetry work to finish', async (t) => {
  let enter
  let finish
  const started = new Promise((resolve) => {
    enter = resolve
  })
  const done = new Promise((resolve) => {
    finish = resolve
  })
  const fx = fixture(t, {
    ensureTelemetry: async () => {
      enter()
      await done
      return { ok: true }
    },
  })
  const watchdog = fx.create()
  const ticking = watchdog.tick()
  await started
  await Promise.race([ticking, new Promise((resolve) => setTimeout(resolve, 20))])
  let flushed = false
  const flushing = watchdog.flush().then(() => {
    flushed = true
  })
  try {
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(flushed, false)
  } finally {
    finish()
    await Promise.all([ticking, flushing])
  }
})
