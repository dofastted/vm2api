import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import tls from 'node:tls'
import pg from 'pg'
import * as management from '../../src/lib/transport/slotgate-management-client.mjs'
import { NodeManagementGrants } from '../../src/lib/cluster/node-management-grants.mjs'
import { SharedVmOperations } from '../../src/lib/vm/shared-vm-operations.mjs'
import { getDb, createDatabase, quoteIdentifier } from '../../src/lib/db/database.mjs'
import { GlobalMaintenanceCoordinator } from '../../src/lib/db/global-maintenance.mjs'
import { realAllocationGate } from '../fixtures/real-allocation-gate.mjs'

const nodeId = 'command-node'
const vmId = 'command-vm'
const allocationId = 'command-allocation'
const payload = Buffer.from(
  JSON.stringify({
    credential: {
      type: 'oauth',
      access_token: 'synthetic-command-access',
      refresh_token: 'synthetic-command-refresh',
      account_uuid: 'synthetic-account',
      org_uuid: 'synthetic-org',
      email: 'synthetic@example.invalid',
    },
  }),
)

async function fixture(t) {
  const db = getDb()
  const peer = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  const coordinator = new GlobalMaintenanceCoordinator(db)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nmc-'))
  let node
  let readerRole
  let engine
  let closed = false
  const service = new NodeManagementGrants(db, { resolveNodeLink: async () => node.link })
  const close = async () => {
    if (closed) return
    closed = true
    await node?.close()
    if (engine) {
      engine.closeAllConnections()
      await new Promise((resolve) => engine.close(resolve))
    }
    await coordinator.stop()
    await peer.close()
    const cleanup = new pg.Client({ connectionString: db.connectionString })
    await cleanup.connect()
    try {
      if (readerRole)
        await cleanup.query(`DROP OWNED BY ${quoteIdentifier(readerRole)}; DROP ROLE ${quoteIdentifier(readerRole)}`)
      await cleanup.query(
        `DROP SCHEMA IF EXISTS ${quoteIdentifier(service.schema)} CASCADE; DROP SCHEMA IF EXISTS ${quoteIdentifier(coordinator.schema)} CASCADE`,
      )
    } finally {
      await cleanup.end()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
  t.after(close)
  await coordinator.start()
  await coordinator.acknowledgeEpoch(1)
  await service.initialize()
  await service.initializeCommands()
  readerRole = 'command_wire_' + crypto.randomBytes(8).toString('hex')
  const password = crypto.randomBytes(24).toString('hex')
  await db.pool.query(
    `CREATE ROLE ${quoteIdentifier(readerRole)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
  )
  await db.pool.query(service.readerRoleSql({ role: readerRole, nodeId }))
  await db.pool.query(service.commandReaderRoleSql({ role: readerRole }))
  const url = new URL(db.connectionString)
  url.username = readerRole
  url.password = password
  const policy = {
    image_id: 'sha256:' + 'a'.repeat(64),
    network_id: 'none',
    uid: process.getuid() || 1000,
    gid: process.getgid() || 1000,
  }
  const policyDigest = crypto
    .createHash('sha256')
    .update(
      [
        'slotgate-policy-v1',
        'claude-docker-v1',
        policy.image_id,
        policy.network_id,
        String(policy.uid),
        String(policy.gid),
      ].join('\0'),
    )
    .digest('hex')
  const calls = []
  let spec
  const containerId = 'b'.repeat(64)
  engine = http.createServer(async (req, res) => {
    calls.push(`${req.method} ${req.url}`)
    const parsed = new URL(req.url, 'http://synthetic-engine')
    const send = (body, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (parsed.pathname === '/info') return send({ ID: 'synthetic-daemon' })
    if (parsed.pathname.startsWith('/images/'))
      return send({ Id: policy.image_id, Config: { Labels: { 'kin.slot.full': '1' } } })
    if (parsed.pathname === '/containers/create') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      spec = JSON.parse(Buffer.concat(chunks).toString())
      return send({ Id: containerId }, 201)
    }
    if (parsed.pathname === `/containers/${containerId}/start`) return res.writeHead(204).end()
    if (parsed.pathname === `/containers/${containerId}/json`)
      return send({
        Id: containerId,
        Image: policy.image_id,
        Config: { Labels: spec.Labels },
        State: { Running: true, Restarting: false, StartedAt: '2026-10-22T00:00:00.000000001Z' },
      })
    res.writeHead(404).end()
  })
  const socket = path.join(root, 'engine.sock')
  await new Promise((resolve, reject) => {
    engine.once('error', reject)
    engine.listen(socket, resolve)
  })
  node = await realAllocationGate(
    t,
    { connection_string: url.toString(), authority_schema: service.schema, node_id: nodeId },
    { launch: policy, dockerSocket: socket },
  )
  const run = (kind, callback) => new SharedVmOperations(db).run(vmId, callback, { kind })
  const allocated = await run('node_allocate', (operation) =>
    service.allocate({ operation, nodeId, vmId, allocationId }),
  )
  const input = (operation, patch = {}) => ({
    operation,
    nodeId,
    vmId,
    allocationId,
    commandId: 'wire-publish',
    capturedFence: allocated.fence,
    presetId: 'claude-docker-v1',
    policyDigest,
    payload,
    ...patch,
  })
  return { db, peer, service, run, input, node, calls, root, close, allocated, q: quoteIdentifier(service.schema) }
}

function nodeCase(name, callback) {
  test(name, async (t) => {
    const fx = await fixture(t)
    try {
      await callback(fx, t)
    } finally {
      await fx.close()
    }
  })
}

test('management transport validates the bounded payload before opening any connection', async (t) => {
  let connections = 0
  t.mock.method(tls, 'connect', () => {
    connections++
    throw new Error('unexpected network')
  })
  for (const value of [Buffer.alloc(0), Buffer.alloc(65537)]) {
    await assert.rejects(management.publishNodeSlotInitial({ link: {}, grant: {}, payload: value }), {
      code: 'node_command_invalid',
      vmOperationNotStarted: true,
    })
  }
  assert.equal(connections, 0)
})

nodeCase(
  'real PostgreSQL grants drive pinned TLS initial publication and launch without holding a transaction over node I/O',
  async (fx, t) => {
    const connect = tls.connect
    let sends = 0
    t.mock.method(tls, 'connect', (...args) => {
      assert.equal(fx.db.isTransaction, false)
      sends++
      return connect.apply(tls, args)
    })
    const published = await fx.run('node_publish_initial', (operation) =>
      fx.service.publishInitial(fx.input(operation)),
    )
    assert.equal(published.manifest_revision, '1')
    assert.equal(fx.calls.length, 0, 'publishing never calls Docker')
    const launched = await fx.run('node_launch', (operation) =>
      fx.service.launch(
        fx.input(operation, {
          commandId: 'wire-launch',
          manifestDigest: published.manifest_digest,
        }),
      ),
    )
    assert.equal(sends, 2, 'one management connection per issued action')
    assert.equal(launched.fence.executor.kind, 'container')
    assert.equal(launched.fence.executor.container_id, 'b'.repeat(64))
    assert.equal(launched.fence.incarnation, fx.allocated.fence.incarnation)
    assert.deepEqual(await new NodeManagementGrants(fx.peer).readLaunchReceipt({ vmId }), launched)
    const rows = (await fx.peer.query(`SELECT receipt,revoked_at FROM ${fx.q}.command_grants`)).rows
    assert.ok(rows.every((row) => row.revoked_at && row.receipt))
    assert.equal(JSON.stringify(rows).includes('synthetic-command-access'), false)
    assert.equal(JSON.stringify(rows).includes('synthetic-command-refresh'), false)
    assert.equal(fx.calls.filter((call) => call.startsWith('POST /containers/create')).length, 1)
  },
)

nodeCase(
  'a lost publication acknowledgement retains the original VM operation and does not issue another command',
  async (fx, t) => {
    const connect = tls.connect
    let sends = 0
    t.mock.method(tls, 'connect', (...args) => {
      sends++
      const socket = connect.apply(tls, args)
      const emit = socket.emit
      socket.emit = function (event, ...values) {
        if (event === 'data') {
          socket.destroy()
          return true
        }
        return emit.call(this, event, ...values)
      }
      return socket
    })
    await assert.rejects(
      fx.run('node_publish_initial', (operation) => fx.service.publishInitial(fx.input(operation))),
      { code: 'node_publication_unconfirmed', vmOperationUncertain: true },
    )
    assert.equal(sends, 1)
    assert.equal(fx.calls.length, 0)
    const row = (await fx.peer.query(`SELECT receipt,revoked_at FROM ${fx.q}.command_grants`)).rows[0]
    assert.equal(row.receipt, null)
    assert.ok(row.revoked_at)
    const operation = (
      await fx.peer.query("SELECT released_at,uncertain_at FROM vm_operations WHERE kind='node_publish_initial'")
    ).rows[0]
    assert.equal(operation.released_at, null)
    assert.ok(operation.uncertain_at)
    assert.equal((await new SharedVmOperations(fx.peer).tryAcquire({ vmId })).ok, false)
    const remoteConfig = path.join(
      fx.node.root,
      'runtime',
      'vms',
      vmId,
      'incarnations',
      fx.allocated.fence.incarnation,
      'run',
      'kernel.json',
    )
    assert.equal(fs.existsSync(remoteConfig), true, 'the real node committed files before its acknowledgement was lost')
  },
)

nodeCase(
  'failure to commit the received node receipt retains ownership and never repeats the mutation',
  async (fx, t) => {
    await fx.db.query(`CREATE FUNCTION reject_command_receipt() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic receipt failure' USING ERRCODE='P648C'; END$$;
    CREATE TRIGGER reject_command_receipt BEFORE UPDATE OF receipt ON ${fx.q}.command_grants FOR EACH ROW EXECUTE FUNCTION reject_command_receipt()`)
    const connect = tls.connect
    let sends = 0
    t.mock.method(tls, 'connect', (...args) => {
      sends++
      return connect.apply(tls, args)
    })
    await assert.rejects(
      fx.run('node_publish_initial', (operation) => fx.service.publishInitial(fx.input(operation))),
      { code: 'P648C' },
    )
    assert.equal(sends, 1)
    const row = (await fx.peer.query(`SELECT receipt,revoked_at FROM ${fx.q}.command_grants`)).rows[0]
    assert.equal(row.receipt, null)
    assert.ok(row.revoked_at)
    const operation = (
      await fx.peer.query("SELECT released_at,uncertain_at FROM vm_operations WHERE kind='node_publish_initial'")
    ).rows[0]
    assert.equal(operation.released_at, null)
    assert.ok(operation.uncertain_at)
  },
)
