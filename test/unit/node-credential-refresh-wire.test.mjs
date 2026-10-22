import { registerActivityCoordinator } from '../../src/lib/db/database.mjs'
import { withDatabaseActivities } from '../maintenance-fixture.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import tls from 'node:tls'
import net from 'node:net'
import pg from 'pg'
import { NodeCredentialRefreshGrants } from '../../src/lib/cluster/node-credential-refresh-grants.mjs'
import { SharedCredentialRefresh } from '../../src/lib/oauth/shared-credential-refresh.mjs'
import { runSlotOauth } from '../../src/lib/transport/slot-oauth.mjs'
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
      expires_at: Date.now() + 3600000,
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
  const refreshGrants = new NodeCredentialRefreshGrants(db)
  await refreshGrants.initialize()
  readerRole = 'command_wire_' + crypto.randomBytes(8).toString('hex')
  const password = crypto.randomBytes(24).toString('hex')
  await db.pool.query(
    `CREATE ROLE ${quoteIdentifier(readerRole)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
  )
  await db.pool.query(service.readerRoleSql({ role: readerRole, nodeId }))
  await db.pool.query(service.commandReaderRoleSql({ role: readerRole }))
  await db.pool.query(refreshGrants.readerRoleSql({ role: readerRole }))
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
  return {
    db,
    peer,
    coordinator,
    service,
    run,
    input,
    node,
    calls,
    root,
    close,
    allocated,
    q: quoteIdentifier(service.schema),
    refreshGrants,
  }
}

function nodeCase(name, callback) {
  test(name, async (t) => {
    const fx = await fixture(t)
    try {
      registerActivityCoordinator(fx.db, fx.coordinator)
      await withDatabaseActivities([fx.db], () => callback(fx, t))
    } finally {
      await fx.close()
    }
  })
}

nodeCase('real PG reader and pinned TLS authorize node-owned refresh without Pod credential files', async (fx, t) => {
  const published = await fx.run('node_publish_initial', (operation) => fx.service.publishInitial(fx.input(operation)))
  const launched = await fx.run('node_launch', (operation) =>
    fx.service.launch(fx.input(operation, { commandId: 'refresh-launch', manifestDigest: published.manifest_digest })),
  )
  const socket = path.join(
    fx.node.root,
    'runtime',
    'vms',
    vmId,
    'incarnations',
    launched.fence.incarnation,
    'run',
    'kernel.sock',
  )
  const kernel = http.createServer((req, res) => {
    assert.equal(req.url, '/internal/health')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise((resolve, reject) => {
    kernel.once('error', reject)
    kernel.listen(socket, resolve)
  })
  try {
    const mode = process.env.VM2API_CONTROL_PLANE_MODE
    process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes-ha'
    try {
      const slotgate = {
        trusted: true,
        pgBindingReady: true,
        nodeId,
        vmId,
        fence: launched.fence,
        link: fx.node.link,
        manifest: { revision: '1', digest: published.manifest_digest },
      }
      const value = await runSlotOauth(
        { vmId, accountId: 'synthetic-account', homeDir: '/must-not-read-pod-credentials', slotgate },
        'refresh',
        { db: fx.db, force: false },
      )
      assert.equal(value.ok, true)
      assert.equal(value.attemptFinished, true)
      assert.equal(value.body.refreshed, false)
      assert.equal(value.body.credential.generation, '1')
      assert.equal(value.body.credential.has_refresh, true)
      const rows = (await fx.peer.query(`SELECT receipt,revoked_at FROM ${fx.q}.refresh_grants`)).rows
      assert.equal(rows.length, 1)
      assert.equal(rows[0].receipt.finished, true)
      assert.ok(rows[0].revoked_at)
      const guest = fs.readFileSync(
        path.join(
          fx.node.root,
          'runtime',
          'vms',
          vmId,
          'incarnations',
          launched.fence.incarnation,
          'claude',
          'credentials.json',
        ),
        'utf8',
      )
      assert.equal(guest.includes('synthetic-command-refresh'), false)
      const canonical = fs.readFileSync(
        path.join(fx.node.root, 'authority', 'credentials', vmId, launched.fence.incarnation, 'credentials.json'),
        'utf8',
      )
      assert.equal(canonical.includes('synthetic-command-refresh'), true)
      assert.equal(JSON.stringify(rows).includes('synthetic-command-access'), false)
    } finally {
      if (mode === undefined) delete process.env.VM2API_CONTROL_PLANE_MODE
      else process.env.VM2API_CONTROL_PLANE_MODE = mode
    }
  } finally {
    kernel.closeAllConnections()
    await new Promise((resolve) => kernel.close(resolve))
  }
})

async function launchedRefresh(fx) {
  const published = await fx.run('node_publish_initial', (operation) => fx.service.publishInitial(fx.input(operation)))
  return fx.run('node_launch', (operation) =>
    fx.service.launch(fx.input(operation, { commandId: 'refresh-launch', manifestDigest: published.manifest_digest })),
  )
}

async function closedPortLink(link) {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return { ...link, address: '127.0.0.1', port }
}

function attemptRefresh(fx, launched, link) {
  const current = { generation: '1', credential: { account_uuid: 'synthetic-account' } }
  return new SharedCredentialRefresh(fx.db).run(
    { platform: 'claude', vmId, accountId: 'synthetic-account', expectedGeneration: '1' },
    {
      readCurrent: async () => current,
      refresh: async (_current, { operation }) => {
        const receipt = await fx.refreshGrants.refresh(
          {
            operation,
            nodeId,
            vmId,
            accountId: 'synthetic-account',
            commandId: crypto.randomUUID(),
            capturedFence: launched.fence,
            expectedGeneration: '1',
            force: false,
          },
          link,
        )
        return { finished: true, value: { ok: receipt.ok, generation: receipt.credential.generation } }
      },
      publish: async () => current,
    },
  )
}

nodeCase(
  'a TLS connection refusal retires only the unsent grant and permits a fresh command at the same generation',
  async (fx) => {
    const launched = await launchedRefresh(fx)
    await assert.rejects(attemptRefresh(fx, launched, await closedPortLink(fx.node.link)), {
      code: 'node_refresh_unconfirmed',
      vmOperationNotStarted: true,
      credentialRefreshNotStarted: true,
    })
    const first = (await fx.peer.query(`SELECT * FROM ${fx.q}.refresh_grants`)).rows[0]
    assert.ok(first.revoked_at)
    const next = await attemptRefresh(fx, launched, fx.node.link)
    assert.equal(next.finished, true)
    assert.equal(next.unknown, false)
    assert.equal(next.value.ok, true)
    const rows = (await fx.peer.query(`SELECT receipt,revoked_at FROM ${fx.q}.refresh_grants ORDER BY created_at`)).rows
    assert.equal(rows.length, 2)
    assert.equal(rows[0].receipt.not_started, true)
    assert.notEqual(rows[0].receipt.finished, true)
    assert.equal(rows[1].receipt.credential.generation, '1')
    assert.equal(
      rows.every((row) => row.revoked_at),
      true,
    )
  },
)

nodeCase('failure to commit an unsent grant terminal state retains both exact claims', async (fx) => {
  const launched = await launchedRefresh(fx)
  await fx.db.query(
    `CREATE FUNCTION reject_unsent_refresh() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION 'synthetic unsent commit failure' USING ERRCODE='P648N'; END $body$; CREATE TRIGGER reject_unsent_refresh BEFORE UPDATE OF receipt ON ${fx.q}.refresh_grants FOR EACH ROW EXECUTE FUNCTION reject_unsent_refresh()`,
  )
  await assert.rejects(attemptRefresh(fx, launched, await closedPortLink(fx.node.link)), (error) => {
    assert.equal(error.code, 'P648N')
    assert.notEqual(error.vmOperationNotStarted, true)
    assert.notEqual(error.credentialRefreshNotStarted, true)
    assert.equal(error.vmOperationUncertain, true)
    assert.equal(error.credentialRefreshUnknown, true)
    return true
  })
  const op = (await fx.peer.query("SELECT uncertain_at,released_at FROM vm_operations WHERE kind='credential_refresh'"))
    .rows[0]
  assert.ok(op.uncertain_at)
  assert.equal(op.released_at, null)
  const bg = (
    await fx.peer.query(
      "SELECT unknown_at,finished_at FROM background_task_runs WHERE task_key='oauth-refresh:claude:synthetic-account'",
    )
  ).rows[0]
  assert.ok(bg.unknown_at)
  assert.equal(bg.finished_at, null)
  const grant = (await fx.peer.query(`SELECT receipt,revoked_at FROM ${fx.q}.refresh_grants`)).rows[0]
  assert.equal(grant.receipt, null)
  assert.ok(grant.revoked_at)
})

nodeCase(
  'TLS application data followed by a missing acknowledgement keeps generation occupied after revocation',
  async (fx) => {
    const launched = await launchedRefresh(fx)
    let received = false
    const sockets = new Set()
    const server = tls.createServer(
      {
        cert: fs.readFileSync(path.join(fx.node.root, 'tls', 'cert.pem')),
        key: fs.readFileSync(path.join(fx.node.root, 'tls', 'key.pem')),
        minVersion: 'TLSv1.3',
      },
      (socket) => {
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
        socket.once('data', () => {
          received = true
          socket.destroy()
        })
      },
    )
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      await assert.rejects(attemptRefresh(fx, launched, { ...fx.node.link, port: server.address().port }), (error) => {
        assert.equal(error.code, 'node_refresh_unconfirmed')
        assert.equal(error.vmOperationUncertain, true)
        assert.notEqual(error.vmOperationNotStarted, true)
        assert.notEqual(error.credentialRefreshNotStarted, true)
        return true
      })
      assert.equal(received, true)
      const row = (await fx.peer.query(`SELECT receipt,revoked_at FROM ${fx.q}.refresh_grants`)).rows[0]
      assert.equal(row.receipt, null)
      assert.ok(row.revoked_at)
      await assert.rejects(
        fx.peer.query(
          `INSERT INTO ${fx.q}.refresh_grants SELECT 'late-command',node_id,vm_id,allocation_id,operation_id,owner_id,account_id,bg_task_key,bg_execution_id,bg_owner_id,epoch,expected_generation,intent_digest,intent,receipt,created_at,revoked_at FROM ${fx.q}.refresh_grants`,
        ),
        { code: '23505' },
      )
      const next = await attemptRefresh(fx, launched, fx.node.link)
      assert.equal(next.unknown, true)
      assert.equal((await fx.peer.query(`SELECT count(*)::int AS n FROM ${fx.q}.refresh_grants`)).rows[0].n, 1)
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    }
  },
)
