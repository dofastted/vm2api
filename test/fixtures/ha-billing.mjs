import pg from 'pg'
import { getDb, quoteIdentifier, registerActivityCoordinator } from '../../src/lib/db/database.mjs'
import { GlobalMaintenanceCoordinator, coordinationSchemaFor } from '../../src/lib/db/global-maintenance.mjs'
import { createRepositoryTestDatabase } from '../repository-database.mjs'
import { withHaRequestContext, withHaRequestAttempt } from '../../src/lib/core/ha-request-context.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { ExecutionAdmissionsRepo } from '../../src/lib/db/repos/execution-admissions-repo.mjs'
import { RequestAttemptsRepo } from '../../src/lib/db/repos/request-attempts-repo.mjs'
import { syntheticFence } from './fake-slotgate.mjs'

export const syntheticBillingSnapshot = () => ({
  version: 1, model: 'claude-sonnet-4-5', rate_multiplier: 2, cache_ttl: '1h', requested_speed: null,
  resolved: { id: 'claude-sonnet-4-5', platform: 'anthropic', source: 'override', version: 'synthetic-v1', mode_sources: {}, price: { input: 3, output: 15, cache_read: .3, cache_5m: 3.75, cache_1h: 6 } },
})
export const syntheticUsageReceipt = () => ({
  id: 'a'.repeat(32), model: 'claude-sonnet-4-5-20250929', usage_complete: true,
  usage: { input_tokens: '100', output_tokens: '10', cache_read_input_tokens: '20', cache_creation_input_tokens: '30' },
  stop_reason: 'end_turn',
})

export async function haBillingFixture(t) {
  const db = getDb()
  const peer = await createRepositoryTestDatabase({ connectionString: db.connectionString, schema: db.schema })
  const original = new GlobalMaintenanceCoordinator(db, { ownerId: 'billing-original-owner' })
  const recovery = new GlobalMaintenanceCoordinator(peer, { ownerId: 'billing-recovery-owner' })
  await original.start(); await recovery.start()
  registerActivityCoordinator(db, original); registerActivityCoordinator(peer, recovery)
  await original.acknowledgeEpoch(1); await recovery.acknowledgeEpoch(1)
  const originalGate = await original.admit({ kind: 'request', requestId: 'billing-parent' })
  const recoveryGate = await recovery.admit({ kind: 'recovery' })
  const before = process.env.VM2API_CONTROL_PLANE_MODE
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes-ha'
  t.after(async () => {
    if (before == null) delete process.env.VM2API_CONTROL_PLANE_MODE
    else process.env.VM2API_CONTROL_PLANE_MODE = before
    await Promise.allSettled([original.stop(), recovery.stop()])
    const cleanup = new pg.Client({ connectionString: db.connectionString })
    await cleanup.connect()
    try { await cleanup.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(coordinationSchemaFor(db.schema))} CASCADE`) }
    finally { await cleanup.end() }
    await peer.close()
  })
  return { db, peer, original, recovery, originalGate, recoveryGate }
}

export async function billingRequest(f, callback = async () => {}, { snapshot = syntheticBillingSnapshot(), jobs = 1, stopOwner = true } = {}) {
  const nodeBinding = { protocol: 'KSG2', nodeId: 'original-node', vmId: 'vm-fixture', kind: 'kernel', fence: syntheticFence() }
  const data = { nodeBinding, commandIds: [] }
  await f.originalGate.run(() => withHaRequestContext({ db: f.db, requestId: 'billing-parent', activity: f.originalGate, recoveryKind: 'claude_messages' }, async () => {
    data.keys = new ApiKeyStore({ db: f.db })
    const now = new Date().toISOString()
    data.user = await data.keys.users.insert({ id: 'synthetic-billing-user', username: 'synthetic-billing-user', password_hash: 'synthetic-test-only', role: 'user', balance: 123, concurrency: 4, created_at: now, updated_at: now })
    data.key = await data.keys.create({ name: 'synthetic-billing-key', user_id: data.user.id })
    data.reservation = await data.keys.reserve(data.key)
    data.admission = await new ExecutionAdmissionsRepo(f.db).tryReserve({ accountId: 'fixture-account', vmId: 'vm-fixture', accountLimit: 5, vmLimit: 5, fableLimit: 0, rpmLimit: 0 })
    for (let attempt = 1; attempt <= jobs; attempt++) {
      await new RequestAttemptsRepo(f.db).begin({ requestId: 'billing-parent', attemptNo: attempt, vmId: 'vm-fixture', accountId: 'fixture-account', model: snapshot?.model ?? 'unpriced' })
      const commandId = 'billing-command-' + attempt
      data.commandIds.push(commandId)
      await withHaRequestAttempt(attempt, () => data.admission.bindExecution({ requestId: commandId, nodeBinding, billingSnapshot: snapshot }))
      await data.admission.completeExecution({ requestId: commandId, nodeBinding, nodeCompletion: { id: commandId, fence: nodeBinding.fence, status: 'completed', dispatched: true }, started: true, ended: true, reason: 'node_completed' })
    }
    await callback(data)
    await data.admission.markUncertain()
  }))
  await f.originalGate.complete({ ended: false, reason: 'synthetic_owner_lost' })
  if (stopOwner) await f.original.stop()
  return data
}

export function statusFor(data, requestId, receipt = syntheticUsageReceipt()) {
  return { found: true, command: { id: requestId, fence: data.nodeBinding.fence, status: 'completed', dispatched: true }, receipt }
}
