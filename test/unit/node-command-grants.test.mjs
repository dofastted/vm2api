import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { setTimeout as delay } from 'node:timers/promises'
import { getDb, createDatabase, quoteIdentifier } from '../../src/lib/db/database.mjs'
import { GlobalMaintenanceCoordinator } from '../../src/lib/db/global-maintenance.mjs'
import { NodeManagementGrants } from '../../src/lib/cluster/node-management-grants.mjs'
import { SharedVmOperations } from '../../src/lib/vm/shared-vm-operations.mjs'
import { nodeGrantNamespace, nodeGrantResource } from '../../src/lib/db/node-management-authority.mjs'

const nodeId = 'synthetic-node'
const vmId = 'synthetic-vm'
const allocationId = 'synthetic-allocation'
const capturedFence = { generation: '1', incarnation: 'a'.repeat(32), executor: { kind: '', node_boot_id: '' } }
const payloadDigest = 'b'.repeat(64)
const policyDigest = 'c'.repeat(64)
const manifestDigest = 'd'.repeat(64)

async function fixture(t) {
  const db = getDb()
  const peer = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  const maintenance = new GlobalMaintenanceCoordinator(db)
  const service = new NodeManagementGrants(db)
  const other = new NodeManagementGrants(peer)
  const roles = []
  const readers = []
  t.after(async () => {
    await maintenance.stop()
    await peer.close()
    for (const client of readers) await client.end()
    const cleanup = new pg.Client({ connectionString: db.connectionString })
    await cleanup.connect()
    try {
      for (const role of roles)
        await cleanup.query(`DROP OWNED BY ${quoteIdentifier(role)}; DROP ROLE ${quoteIdentifier(role)}`)
      await cleanup.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(service.schema)} CASCADE`)
      await cleanup.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(maintenance.schema)} CASCADE`)
    } finally {
      await cleanup.end()
    }
  })
  await maintenance.start()
  await maintenance.acknowledgeEpoch(1)
  await service.initialize()
  const run = (kind, callback) => new SharedVmOperations(db).run(vmId, callback, { kind })
  await run('node_allocate', async (operation) => {
    const grant = await service.issueAllocation({ operation, nodeId, vmId, allocationId })
    const receipt = {
      node_id: nodeId,
      vm_id: vmId,
      allocation_id: allocationId,
      operation_id: grant.operationId,
      owner_id: grant.ownerId,
      epoch: grant.epoch,
      intent_digest: grant.intentDigest,
      fence: capturedFence,
    }
    // Synthetic node receipt: allocation transport/receipt authentication has its own real-node tests.
    await db.query(
      `UPDATE ${quoteIdentifier(service.schema)}.allocations SET receipt=$2::jsonb WHERE allocation_id=$1`,
      [allocationId, JSON.stringify(receipt)],
    )
  })
  const input = (operation, patch = {}) => ({
    operation,
    nodeId,
    vmId,
    allocationId,
    commandId: 'publish-one',
    capturedFence,
    expectedManifestRevision: '0',
    revision: '1',
    payloadDigest,
    presetId: 'claude-docker-v1',
    policyDigest,
    ...patch,
  })
  const publication = (grant, patch = {}) => ({
    intent: structuredClone(grant.intent),
    intent_digest: grant.intentDigest,
    manifest_revision: '1',
    manifest_digest: manifestDigest,
    ...patch,
  })
  async function publish() {
    let value
    await run('node_publish_initial', async (operation) => {
      const grant = await service.issueInitialPublish(input(operation))
      value = await service.recordInitialPublishReceipt(grant, publication(grant))
    })
    return value
  }
  async function reader() {
    const role = 'command_reader_' + crypto.randomBytes(8).toString('hex')
    const password = crypto.randomBytes(24).toString('hex')
    await db.pool.query(
      `CREATE ROLE ${quoteIdentifier(role)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
    )
    roles.push(role)
    await db.pool.query(service.readerRoleSql({ role, nodeId }))
    await db.pool.query(service.commandReaderRoleSql({ role }))
    const url = new URL(db.connectionString)
    url.username = role
    url.password = password
    const client = new pg.Client({ connectionString: url.toString() })
    await client.connect()
    readers.push(client)
    return client
  }
  return {
    db,
    peer,
    maintenance,
    service,
    other,
    run,
    input,
    publication,
    publish,
    reader,
    q: quoteIdentifier(service.schema),
  }
}

test('new actions require explicit trusted feature initialization without changing allocation v1', async (t) => {
  const fx = await fixture(t)
  await fx.run('node_publish_initial', async (operation) => {
    await assert.rejects(fx.service.issueInitialPublish(fx.input(operation)), {
      code: 'node_command_authority_unavailable',
    })
  })
  assert.equal(
    (await fx.peer.query('SELECT to_regclass($1) AS relation', [`${fx.service.schema}.command_grants`])).rows[0]
      .relation,
    null,
  )
  await fx.service.initializeCommands()
  const meta = (await fx.peer.query(`SELECT protocol_version,command_protocol_version FROM ${fx.q}.meta`)).rows[0]
  assert.deepEqual(meta, { protocol_version: 1, command_protocol_version: 1 })
  const marker = (
    await fx.peer.query(
      `SELECT protocol_version,command_protocol_version FROM ${quoteIdentifier(fx.maintenance.schema)}.node_authority_features`,
    )
  ).rows[0]
  assert.deepEqual(marker, meta)
  await fx.service.initialize()
  assert.equal((await fx.peer.query(`SELECT count(*) AS n FROM ${fx.q}.allocations`)).rows[0].n, 1)
})

test('publish and launch bind the original allocation, independent operations, digests and immutable receipts', async (t) => {
  const fx = await fixture(t)
  await fx.service.initializeCommands()
  const published = await fx.publish()
  assert.equal(published.manifest_digest, manifestDigest)
  let launched
  await fx.run('node_launch', async (operation) => {
    const grant = await fx.service.issueLaunch(
      fx.input(operation, {
        commandId: 'launch-one',
        expectedManifestRevision: '1',
        payloadDigest: '',
        manifestDigest,
      }),
    )
    assert.equal(grant.intent.action, 'launch')
    assert.equal(grant.intent.expected_manifest_revision, '1')
    assert.equal(grant.intent.payload_digest, '')
    const fence = {
      generation: '1',
      incarnation: capturedFence.incarnation,
      executor: {
        kind: 'container',
        node_boot_id: 'synthetic-boot',
        container_id: 'e'.repeat(64),
        docker_daemon_id: 'synthetic-daemon',
        started_at: '2026-10-22T01:02:03.123456789Z',
      },
    }
    launched = await fx.service.recordLaunchReceipt(grant, { ...fx.publication(grant), fence })
  })
  const rows = (
    await fx.peer.query(`SELECT action,operation_id,receipt,revoked_at FROM ${fx.q}.command_grants ORDER BY action`)
  ).rows
  assert.deepEqual(
    rows.map((row) => row.action),
    ['launch', 'publish-initial'],
  )
  assert.notEqual(rows[0].operation_id, rows[1].operation_id)
  assert.ok(rows.every((row) => row.revoked_at && row.receipt))
  assert.deepEqual(await fx.other.readLaunchReceipt({ nodeId, vmId }), launched)
  assert.equal(launched.fence.incarnation, capturedFence.incarnation)
  assert.equal(launched.fence.executor.container_id, 'e'.repeat(64))
})

test('fresh fences, missing publication receipts, wrong revisions and absent exact operation scope are rejected', async (t) => {
  const fx = await fixture(t)
  await fx.service.initializeCommands()
  await assert.rejects(fx.service.issueInitialPublish(fx.input({ operationId: 'forged', ownerId: 'forged' })), {
    code: 'node_operation_scope_required',
  })
  await fx.run('node_launch', async (operation) => {
    await assert.rejects(
      fx.service.issueLaunch(
        fx.input(operation, {
          commandId: 'launch-one',
          expectedManifestRevision: '1',
          payloadDigest: '',
          manifestDigest,
        }),
      ),
      { code: 'node_publication_required' },
    )
  })
  await fx.run('node_publish_initial', async (operation) => {
    for (const patch of [
      { capturedFence: { ...capturedFence, incarnation: 'f'.repeat(32) } },
      { expectedManifestRevision: '1' },
      { revision: '01' },
      { payloadDigest: 'not-a-digest' },
      { presetId: 'arbitrary-preset' },
    ]) {
      await assert.rejects(fx.service.issueInitialPublish(fx.input(operation, patch)), { code: 'node_command_invalid' })
    }
  })
})

test('a command cannot be reissued, relabeled or replaced after an unknown attempt', async (t) => {
  const fx = await fixture(t)
  await fx.service.initializeCommands()
  await fx.run('node_publish_initial', async (operation) => {
    const first = await fx.service.issueInitialPublish(fx.input(operation))
    for (const patch of [{}, { payloadDigest: 'f'.repeat(64) }, { commandId: 'new-command' }]) {
      await assert.rejects(fx.service.issueInitialPublish(fx.input(operation, patch)), {
        code: 'node_command_conflict',
      })
    }
    await operation.markUncertain()
    await assert.rejects(fx.service.recordInitialPublishReceipt(first, fx.publication(first)), {
      code: 'node_operation_invalid',
    })
    return { vmOperationUncertain: true }
  })
  const row = (await fx.peer.query(`SELECT revoked_at,receipt FROM ${fx.q}.command_grants`)).rows[0]
  assert.ok(row.revoked_at)
  assert.equal(row.receipt, null)
  assert.equal((await new SharedVmOperations(fx.peer).tryAcquire({ vmId })).ok, false)
})

test('receipt validation rejects secret fields and mismatched intent without committing a partial receipt', async (t) => {
  const fx = await fixture(t)
  await fx.service.initializeCommands()
  await fx.run('node_publish_initial', async (operation) => {
    const grant = await fx.service.issueInitialPublish(fx.input(operation))
    for (const receipt of [
      fx.publication(grant, { access_token: 'synthetic-secret-must-not-persist' }),
      fx.publication(grant, { intent_digest: 'f'.repeat(64) }),
      fx.publication(grant, { intent: { ...grant.intent, owner_id: 'other-owner' } }),
      fx.publication(grant, { manifest_revision: '2' }),
    ]) {
      await assert.rejects(fx.service.recordInitialPublishReceipt(grant, receipt), {
        code: 'node_command_receipt_invalid',
      })
      assert.equal((await fx.peer.query(`SELECT receipt FROM ${fx.q}.command_grants`)).rows[0].receipt, null)
    }
    const saved = await fx.service.recordInitialPublishReceipt(grant, fx.publication(grant))
    assert.deepEqual(await fx.service.recordInitialPublishReceipt(grant, fx.publication(grant)), saved)
    await assert.rejects(
      fx.service.recordInitialPublishReceipt(grant, fx.publication(grant, { manifest_digest: 'f'.repeat(64) })),
      { code: 'node_command_conflict' },
    )
  })
})

test('the node reader sees only live commands and release waits for its bounded authorization lock', async (t) => {
  const fx = await fixture(t)
  await fx.service.initializeCommands()
  const reader = await fx.reader()
  await assert.rejects(reader.query(`SELECT * FROM ${fx.q}.command_grants`), { code: '42501' })
  await fx.run('node_publish_initial', async (operation) => {
    const grant = await fx.service.issueInitialPublish(fx.input(operation))
    const rows = (await reader.query(`SELECT action,epoch::text,intent_digest FROM ${fx.q}.authorized_commands`)).rows
    assert.deepEqual(rows, [{ action: 'publish-initial', epoch: '1', intent_digest: grant.intentDigest }])
    await reader.query('BEGIN READ ONLY')
    await reader.query('SELECT pg_advisory_xact_lock_shared(hashtext($1),hashtext($2))', [
      nodeGrantNamespace(fx.service.schema),
      nodeGrantResource(nodeId, vmId),
    ])
    const releasing = operation.release()
    try {
      assert.equal(await Promise.race([releasing.then(() => 'released'), delay(75).then(() => 'waiting')]), 'waiting')
    } finally {
      await reader.query('COMMIT')
    }
    assert.equal((await releasing).released, true)
    assert.equal((await reader.query(`SELECT * FROM ${fx.q}.authorized_commands`)).rowCount, 0)
  })
})

test('enabled command state corruption fails closed instead of performing runtime DDL or releasing ownership', async (t) => {
  const fx = await fixture(t)
  await fx.service.initializeCommands()
  await fx.peer.query(`DROP TABLE ${fx.q}.command_grants CASCADE`)
  await assert.rejects(
    fx.run('node_publish_initial', (operation) => fx.service.issueInitialPublish(fx.input(operation))),
    { code: 'node_command_authority_unavailable' },
  )
  assert.equal(
    (await fx.peer.query('SELECT to_regclass($1) AS relation', [`${fx.service.schema}.command_grants`])).rows[0]
      .relation,
    null,
  )
  const rows = (await fx.peer.query("SELECT released_at FROM vm_operations WHERE kind='node_publish_initial'")).rows
  assert.equal(rows[0].released_at, null)
})

test('business epoch changes reject persisted old command receipts and deny the node reader', async (t) => {
  const fx = await fixture(t)
  await fx.service.initializeCommands()
  const reader = await fx.reader()
  await fx.run('node_publish_initial', async (operation) => {
    const grant = await fx.service.issueInitialPublish(fx.input(operation))
    await fx.peer.query(`UPDATE ${quoteIdentifier(fx.maintenance.schema)}.control SET epoch=2 WHERE id=1`)
    assert.equal((await reader.query(`SELECT * FROM ${fx.q}.authorized_commands`)).rowCount, 0)
    await assert.rejects(fx.service.recordInitialPublishReceipt(grant, fx.publication(grant)), {
      code: 'node_command_epoch_stale',
    })
  })
  assert.equal((await fx.peer.query(`SELECT receipt FROM ${fx.q}.command_grants`)).rows[0].receipt, null)
})
