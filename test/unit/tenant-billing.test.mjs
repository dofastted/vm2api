import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDb } from '../../src/lib/db/database.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'

async function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-billing-'))
  const db = await getDb()
  return { dir, db, logs: new UsageLogsRepo(db) }
}

function row(partial) {
  return {
    id: partial.id,
    request_id: partial.request_id,
    created_at: partial.created_at || new Date().toISOString(),
    status: partial.status ?? 200,
    input_tokens: partial.input_tokens ?? 10,
    output_tokens: partial.output_tokens ?? 5,
    total_cost: partial.total_cost ?? 0.2,
    actual_cost: partial.actual_cost ?? 0.2,
    vm_id: partial.vm_id || null,
    api_key_id: partial.api_key_id || null,
    user_id: partial.user_id || null,
  }
}

test('ownerBilling and query hide other tenants', async () => {
  const { logs, db } = await tmpRepo()
  await db
    .prepare(
      "INSERT INTO vms (id, name, vm_json, owner_user_id, origin) VALUES ('vm-a','a','{}','user-a','user_created')",
    )
    .run()
  await db
    .prepare(
      "INSERT INTO vms (id, name, vm_json, owner_user_id, origin) VALUES ('vm-b','b','{}','user-b','user_created')",
    )
    .run()
  await logs.insertSummary(
    row({ id: 'l1', request_id: 'r1', vm_id: 'vm-a', user_id: 'user-a', total_cost: 1, actual_cost: 1 }),
  )
  await logs.insertSummary(
    row({ id: 'l2', request_id: 'r2', vm_id: 'vm-b', user_id: 'user-b', total_cost: 9, actual_cost: 9, status: 500 }),
  )

  const billed = await logs.ownerBilling({ ownerUserId: 'user-a', groupBy: 'vm' })
  assert.equal(billed.totals.requests, 1)
  assert.equal(billed.items.length, 1)
  assert.equal(billed.items[0].vm_id, 'vm-a')
  assert.equal(billed.items[0].cost_usd, 1)
  assert.equal(billed.items[0].official_cost_usd, 1)

  const listed = await logs.query({ owner_user_id: 'user-a' })
  assert.equal(listed.total, 1)
  assert.equal(listed.items[0].request_id, 'r1')

  assert.equal(await logs.belongsToOwner('r1', 'user-a'), true)
  assert.equal(await logs.belongsToOwner('r2', 'user-a'), false)
})

test('ownerBilling exposes official cost next to rate-multiplied cost', async () => {
  const { logs } = await tmpRepo()
  await logs.insertSummary(row({ id: 'm1', request_id: 'rm1', vm_id: 'vm-x', total_cost: 1, actual_cost: 2 }))
  const billed = await logs.ownerBilling({ groupBy: 'vm' })
  assert.equal(billed.totals.cost_usd, 2)
  assert.equal(billed.totals.official_cost_usd, 1)
  assert.equal(billed.items[0].cost_usd, 2)
  assert.equal(billed.items[0].official_cost_usd, 1)
})
