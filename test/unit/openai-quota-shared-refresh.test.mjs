import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { getDb, getActivityCoordinator, quoteIdentifier } from '../../src/lib/db/database.mjs'
import { withDatabaseActivities } from '../maintenance-fixture.mjs'
import { queryOpenaiQuota } from '../../src/lib/oauth/openai-quota.mjs'

async function fixture(t, callback) {
  const db = getDb()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-quota-shared-refresh-'))
  const vmId = 'vm-codex-refresh'
  fs.mkdirSync(path.join(root, 'vms', vmId), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', vmId + '.json'),
    JSON.stringify({
      id: vmId,
      platform: 'openai',
      family: 'codex',
      proxy: { url: 'socks5h://127.0.0.1:19999' },
    }),
  )
  fs.writeFileSync(
    path.join(root, 'vms', vmId, 'codex-credentials.json'),
    JSON.stringify({
      accounts: [
        {
          id: 'synthetic',
          access_token: 'SYNTHETIC_OLD_AT',
          refresh_token: 'SYNTHETIC_RT',
          chatgpt_account_id: 'synthetic-account',
        },
      ],
    }),
  )
  const previous = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  t.after(async () => {
    if (previous == null) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = previous
    const coordinator = getActivityCoordinator(db)
    await coordinator?.stop()
    const client = new pg.Client({ connectionString: db.connectionString })
    await client.connect()
    try {
      if (coordinator) await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(coordinator.schema)} CASCADE`)
    } finally {
      await client.end()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  await withDatabaseActivities([db], () => callback({ db, root, vmId }))
}

const response = (status, payload) => ({ status, json: async () => payload })

test('concurrent quota 401 recovery shares one published refresh attempt', async (t) =>
  fixture(t, async ({ db, root, vmId }) => {
    let refreshes = 0
    const fetchImpl = async (url, init) => {
      if (url.includes('/oauth/token')) {
        refreshes++
        await new Promise((resolve) => setTimeout(resolve, 30))
        return response(200, { access_token: 'SYNTHETIC_NEW_AT', refresh_token: 'SYNTHETIC_NEW_RT' })
      }
      if (init.headers.authorization === 'Bearer SYNTHETIC_OLD_AT') return response(401, {})
      return response(200, { rate_limit: {}, rate_limit_reset_credits: { available_count: 0 } })
    }
    const results = await Promise.all([1, 2].map(() => queryOpenaiQuota({ projectRoot: root, vmId, fetchImpl })))
    assert.equal(refreshes, 1)
    assert.ok(results.every((result) => result.ok))
    const rows = (await db.query('SELECT finished_at,shared_result FROM background_task_runs')).rows
    assert.equal(rows.length, 1)
    assert.ok(rows[0].finished_at)
    assert.equal(JSON.stringify(rows).includes('SYNTHETIC_'), false)
  }))

test('quota refresh transport failure leaves both durable claims unavailable', async (t) =>
  fixture(t, async ({ db, root, vmId }) => {
    let refreshes = 0
    const fetchImpl = async (url) => {
      if (url.includes('/oauth/token')) {
        refreshes++
        throw new Error('synthetic token disconnect')
      }
      return response(401, {})
    }
    const first = await queryOpenaiQuota({ projectRoot: root, vmId, fetchImpl })
    assert.equal(first.ok, false)
    await queryOpenaiQuota({ projectRoot: root, vmId, fetchImpl })
    assert.equal(refreshes, 1)
    const task = (await db.query('SELECT finished_at,unknown_at FROM background_task_runs')).rows[0]
    assert.equal(task.finished_at, null)
    assert.ok(task.unknown_at)
    const operation = (await db.query('SELECT released_at,uncertain_at FROM vm_operations')).rows[0]
    assert.equal(operation.released_at, null)
    assert.ok(operation.uncertain_at)
  }))
