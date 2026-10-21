import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { getDb, registerActivityCoordinator, quoteIdentifier } from '../../src/lib/db/database.mjs'
import { GlobalMaintenanceCoordinator } from '../../src/lib/db/global-maintenance.mjs'
import { ExecutionAdmissionsRepo } from '../../src/lib/db/repos/execution-admissions-repo.mjs'
import { readWorkerCredentialFile, writeWorkerCredentialFile } from '../../src/lib/oauth/oauth-credentials.mjs'
import { runSlotOauth } from '../../src/lib/transport/slot-oauth.mjs'
import { ensureWorkerCredential } from '../../src/lib/transport/go-worker-client.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { SharedVmOperations } from '../../src/lib/vm/shared-vm-operations.mjs'
import { SharedCredentialRefresh } from '../../src/lib/oauth/shared-credential-refresh.mjs'

async function fixture(t) {
  const db = getDb()
  const coordinator = new GlobalMaintenanceCoordinator(db)
  await coordinator.start()
  registerActivityCoordinator(db, coordinator)
  const bootstrap = await coordinator.admitBootstrap()
  await coordinator.acknowledgeEpoch(bootstrap.epoch)
  await bootstrap.complete({ ended: true })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-shared-slot-refresh-'))
  const homeDir = path.join(root, 'vms', 'vm-01', 'cli-home')
  writeWorkerCredentialFile(homeDir, {
    type: 'oauth',
    access_token: 'SYNTHETIC_AT',
    refresh_token: 'SYNTHETIC_RT',
    expires_at: 1,
    account_uuid: 'slot-refresh-account',
  })
  const previous = process.env.VM2API_CONTROL_PLANE_MODE
  const dockerBin = process.env.KIN_DOCKER_BIN
  process.env.KIN_DOCKER_BIN = path.join(root, 'missing-synthetic-docker')
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  t.after(async () => {
    if (previous == null) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = previous
    if (dockerBin == null) delete process.env.KIN_DOCKER_BIN
    else process.env.KIN_DOCKER_BIN = dockerBin
    await coordinator.stop()
    const client = new pg.Client({ connectionString: db.connectionString })
    await client.connect()
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(coordinator.schema)} CASCADE`)
    } finally {
      await client.end()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  const run = (callback) =>
    coordinator.runActivity({ kind: 'fixture' }, async () => ({ ended: true, value: await callback() }))
  return { db, coordinator, homeDir, exec: { vmId: 'vm-01', homeDir, vm: {} }, run }
}

async function startDrain(f, scope) {
  let draining
  const began = new Promise((resolve) => {
    draining = resolve
  })
  const pending = f.coordinator.beginMaintenance({ kind: 'backup', timeoutMs: 1000, onDraining: () => draining() })
  pending.catch(() => {})
  await began
  return async () => {
    await scope.complete({ ended: true })
    const operation = await pending.catch(() => null)
    if (!operation) return false
    try {
      await operation.resume()
      await operation.finish()
      return true
    } finally {
      await operation.close()
    }
  }
}

test('the actual slot OAuth refresh shares a committed attempt after bootstrap has closed', async (t) => {
  const f = await fixture(t)
  let calls = 0
  const runDocker = async () => {
    calls++
    await new Promise((resolve) => setTimeout(resolve, 30))
    writeWorkerCredentialFile(f.homeDir, {
      ...readWorkerCredentialFile(f.homeDir),
      access_token: 'SYNTHETIC_NEW_AT',
      refresh_token: 'SYNTHETIC_NEW_RT',
    })
    return { code: 0, stdout: '{"ok":true,"status":200,"body":{"refreshed":true}}' }
  }
  const results = await Promise.all([
    runSlotOauth(f.exec, 'refresh', { runDocker }),
    runSlotOauth(f.exec, 'refresh', { runDocker }),
  ])
  assert.equal(calls, 1)
  assert.ok(results.every((result) => result.ok))
  const rows = await f.run(() => f.db.query('SELECT finished_at,shared_result FROM background_task_runs'))
  assert.equal(rows.rows.length, 1)
  assert.ok(rows.rows[0].finished_at)
  assert.equal(JSON.stringify(rows.rows).includes('SYNTHETIC_'), false)
})

test('a slot refresh timeout retains its shared operation and task', async (t) => {
  const f = await fixture(t)
  const result = await runSlotOauth(f.exec, 'refresh', { runDocker: async () => ({ timed_out: true }) })
  assert.equal(result.attemptFinished, false)
  const rows = await f.run(() => f.db.query('SELECT released_at,uncertain_at FROM vm_operations'))
  assert.equal(rows.rows.length, 1)
  assert.equal(rows.rows[0].released_at, null)
  assert.ok(rows.rows[0].uncertain_at)
})

test('ensure publishes its VM projection before the shared refresh and VM operation finish', async (t) => {
  const f = await fixture(t)
  let publications = 0
  const result = await ensureWorkerCredential(f.exec, {
    force: true,
    runDocker: async () => {
      writeWorkerCredentialFile(f.homeDir, {
        ...readWorkerCredentialFile(f.homeDir),
        access_token: 'SYNTHETIC_NEW_AT',
        refresh_token: 'SYNTHETIC_NEW_RT',
      })
      return { code: 0, stdout: '{"ok":true,"status":200,"body":{"refreshed":true}}' }
    },
    publishCredential: async () => {
      publications++
      assert.equal((await f.db.prepare('SELECT count(*) AS n FROM vm_operations WHERE released_at IS NULL').get()).n, 1)
      assert.equal(
        (await f.db.prepare('SELECT count(*) AS n FROM background_task_runs WHERE finished_at IS NULL').get()).n,
        1,
      )
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.attemptFinished, true)
  assert.equal(publications, 1)
  assert.equal(
    (await f.run(() => f.db.prepare('SELECT count(*) AS n FROM vm_operations WHERE released_at IS NULL').get())).n,
    0,
  )
})

test('implicit worker refresh commands cannot execute while another inference is active', async (t) => {
  const f = await fixture(t)
  const gate = await f.run(() =>
    new ExecutionAdmissionsRepo(f.db).tryReserve({
      accountId: 'slot-refresh-account',
      vmId: 'vm-01',
      accountLimit: 2,
      vmLimit: 2,
      rpmLimit: 0,
      fableLimit: 0,
    }),
  )
  let calls = 0
  try {
    await assert.rejects(
      runSlotOauth(f.exec, 'models', {
        runDocker: async () => {
          calls++
          return { code: 0, stdout: '{"ok":true,"status":200}' }
        },
      }),
      { code: 'vm_execution_active' },
    )
    assert.equal(calls, 0)
  } finally {
    await f.run(() => gate.release())
  }
})

test('a DRAINING refusal after bootstrap closes proves the refresh never started', async (t) => {
  const f = await fixture(t)
  const scope = await f.coordinator.admit()
  const finish = await startDrain(f, scope)
  let calls = 0
  try {
    await assert.rejects(
      runSlotOauth(f.exec, 'refresh', {
        runDocker: async () => {
          calls++
        },
      }),
      {
        code: 'database_maintenance',
        credentialRefreshNotStarted: true,
      },
    )
    assert.equal(calls, 0)
  } finally {
    await finish()
  }
})

test('a busy VM rejects refresh before mutation and completes its unused task claim', async (t) => {
  const f = await fixture(t)
  const operation = await f.run(() => new SharedVmOperations(f.db).tryAcquire({ vmId: 'vm-01' }))
  let calls = 0
  try {
    await assert.rejects(
      runSlotOauth(f.exec, 'refresh', {
        runDocker: async () => {
          calls++
        },
      }),
      {
        code: 'vm_operation_active',
        credentialRefreshNotStarted: true,
      },
    )
    assert.equal(calls, 0)
    assert.equal(
      (
        await f.run(() =>
          f.db.prepare('SELECT count(*) AS n FROM background_task_runs WHERE finished_at IS NULL').get(),
        )
      ).n,
      0,
    )
  } finally {
    await f.run(() => operation.release())
  }
})

for (const ended of [true, false]) {
  test(`runner handles a DRAINING refresh refusal with first job ended=${ended}`, async (t) => {
    const f = await fixture(t)
    const scope = await f.coordinator.admit()
    let gate
    await scope.run(async () => {
      gate = await new ExecutionAdmissionsRepo(f.db).tryReserve({
        accountId: 'slot-refresh-account',
        vmId: 'vm-01',
        accountLimit: 1,
        vmLimit: 1,
        rpmLimit: 0,
        fableLimit: 0,
      })
      await gate.bindExecution({ requestId: 'before-draining' })
      if (ended)
        await gate.completeExecution({
          requestId: 'before-draining',
          started: true,
          ended: true,
          reason: 'body_complete',
        })
    })
    const runner = new FailoverRunner({ scheduler: { accountQuota: { db: f.db } } })
    const selected = { ...gate, exec: f.exec }
    const finish = await startDrain(f, scope)
    let drained
    try {
      await scope.run(async () => {
        const recover = () =>
          runner.recoverCredential(selected, { reason: 'oauth_refresh_required' }, { executionEnded: ended })
        if (ended) {
          const policy = await recover()
          assert.equal(policy.credentialRefreshNotStarted, true)
          assert.equal((await f.db.prepare('SELECT uncertain_at FROM execution_admissions').get()).uncertain_at, null)
          assert.equal((await gate.release()).released, true)
        } else {
          await assert.rejects(recover(), { credentialRefreshNotStarted: true, executionUncertain: true })
          assert.ok((await f.db.prepare('SELECT uncertain_at FROM execution_admissions').get()).uncertain_at)
          assert.equal((await gate.release()).released, false)
        }
      })
    } finally {
      drained = await finish()
    }
    assert.equal(drained, ended)
  })
}

test('the same maintenance error after entering refresh cannot claim it never started', async (t) => {
  const f = await fixture(t)
  let calls = 0
  await assert.rejects(
    new SharedCredentialRefresh(f.db).run(
      {
        platform: 'claude',
        vmId: 'vm-01',
        accountId: 'slot-refresh-account',
        expectedGeneration: 'generation-one',
      },
      {
        readCurrent: async () => ({ generation: 'generation-one', credential: { refresh_token: 'SYNTHETIC_RT' } }),
        refresh: async () => {
          calls++
          throw Object.assign(new Error('synthetic in-flight error'), { code: 'database_maintenance' })
        },
        publish: async () => assert.fail('no publication'),
      },
    ),
    (error) => {
      assert.equal(error.credentialRefreshNotStarted, undefined)
      return error.code === 'database_maintenance'
    },
  )
  assert.equal(calls, 1)
  const operation = await f.run(() => f.db.prepare('SELECT released_at,uncertain_at FROM vm_operations').get())
  assert.equal(operation.released_at, null)
  assert.ok(operation.uncertain_at)
})
