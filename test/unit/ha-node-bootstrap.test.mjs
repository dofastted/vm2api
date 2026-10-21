import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { NodeManagementGrants } from '../../src/lib/cluster/node-management-grants.mjs'
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
  readerRole = 'command_wire_' + crypto.randomBytes(8).toString('hex')
  const password = crypto.randomBytes(24).toString('hex')
  await db.pool.query(
    `CREATE ROLE ${quoteIdentifier(readerRole)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
  )
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
  let failStart = false,
    beforeStart = null
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
    if (parsed.pathname === `/containers/${containerId}/start`) {
      if (beforeStart) await beforeStart()
      return res.writeHead(failStart ? 500 : 204).end()
    }
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
  const file = path.join(root, 'bootstrap.json'),
    output = path.join(root, 'reader.sql'),
    credentialFile = path.join(root, 'credential.json')
  const config = {
    database: { url: db.connectionString, schema: db.schema },
    node: { id: nodeId, ...node.link, presetId: 'claude-docker-v1', policyDigest },
    reader: { role: readerRole, sqlOutput: output },
    vm: { id: vmId, accountId: 'synthetic-account' },
    credentialFile,
  }
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 })
  fs.writeFileSync(credentialFile, payload, { mode: 0o600 })
  const cli = (command, extra = []) =>
    new Promise((resolve) => {
      const env = { ...process.env }
      delete env.NODE_TEST_CONTEXT
      const child = import('node:child_process').then(({ spawn }) => {
        const p = spawn(
          process.execPath,
          [
            fileURLToPath(new URL('../../scripts/ha-node-bootstrap.mjs', import.meta.url)),
            command,
            '--config',
            file,
            ...extra,
          ],
          { env, stdio: ['pipe', 'pipe', 'pipe'] },
        )
        p.stdin.end(extra.includes('--credential-fd') ? payload : undefined)
        let out = '',
          err = ''
        p.stdout.on('data', (c) => (out += c))
        p.stderr.on('data', (c) => (err += c))
        p.once('exit', (status) => resolve({ status, out, err }))
        p.once('error', (e) => resolve({ status: -1, out, err: e.code }))
      })
    })
  return {
    db,
    peer,
    coordinator,
    service,
    cli,
    file,
    config,
    output,
    credentialFile,
    node,
    calls,
    setFailStart: () => {
      failStart = true
    },
    setBeforeStart: (fn) => {
      beforeStart = fn
    },
    root,
    close,
    q: quoteIdentifier(service.schema),
  }
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

nodeCase(
  'trusted-init writes nonsecret reader SQL and slot-create persists only confirmed public metadata',
  async (fx) => {
    const initialized = await fx.cli('trusted-init')
    assert.equal(initialized.status, 0, initialized.out + initialized.err)
    const sql = fs.readFileSync(fx.output, 'utf8')
    assert.equal(fs.statSync(fx.output).mode & 0o777, 0o600)
    assert.equal(sql.includes('synthetic-command-refresh'), false)
    assert.equal(sql.includes(fx.db.connectionString), false)
    await fx.db.pool.query(sql)
    const result = await fx.cli('slot-create')
    assert.equal(result.status, 0, result.out + result.err)
    assert.equal(result.out.includes('synthetic-command-refresh'), false)
    assert.equal(result.err.includes('synthetic-command-access'), false)
    const row = (await fx.peer.query('SELECT vm_json,access_token,refresh_token FROM vms WHERE id=$1', [vmId])).rows[0]
    const vm = JSON.parse(row.vm_json)
    assert.equal(vm.node_id, nodeId)
    assert.equal(vm.claude.account_uuid, 'synthetic-account')
    assert.ok(vm.fingerprint.device_id)
    assert.ok(vm.fingerprint.session_id)
    assert.equal(row.access_token, null)
    assert.equal(row.refresh_token, null)
    assert.equal(row.vm_json.includes('synthetic-command-'), false)
    const before = fx.calls.length
    const repeated = await fx.cli('slot-create')
    assert.equal(repeated.status, 1)
    assert.equal(fx.calls.length, before)
    assert.equal((await fx.peer.query('SELECT count(*)::int AS n FROM vms')).rows[0].n, 1)
  },
)
nodeCase('bootstrap rejects public config permissions before any node request', async (fx) => {
  fs.chmodSync(fx.file, 0o644)
  const result = await fx.cli('trusted-init')
  assert.equal(result.status, 1)
  assert.match(result.err, /bootstrap_config_invalid/)
  assert.equal(fx.calls.length, 0)
})
nodeCase('bootstrap refuses an existing VM without overwriting its fingerprint or issuing grants', async (fx) => {
  const init = await fx.cli('trusted-init')
  assert.equal(init.status, 0, init.out + init.err)
  await fx.db.pool.query(fs.readFileSync(fx.output, 'utf8'))
  await fx.db.query('INSERT INTO vms(id,vm_json) VALUES($1,$2)', [
    vmId,
    JSON.stringify({ id: vmId, fingerprint: { device_id: 'original', session_id: 'original-session' } }),
  ])
  const result = await fx.cli('slot-create')
  assert.equal(result.status, 1)
  assert.match(result.err, /bootstrap_vm_exists/)
  assert.equal(fx.calls.length, 0)
  assert.equal(
    JSON.parse((await fx.peer.query('SELECT vm_json FROM vms WHERE id=$1', [vmId])).rows[0].vm_json).fingerprint
      .device_id,
    'original',
  )
})

nodeCase('slot-create accepts credential FD input without persisting it in config or public output', async (fx) => {
  const init = await fx.cli('trusted-init')
  assert.equal(init.status, 0, init.out + init.err)
  await fx.db.pool.query(fs.readFileSync(fx.output, 'utf8'))
  fx.config.vm.fingerprint = { device_id: '9'.repeat(64), session_id: '11111111-2222-4333-8444-555555555555' }
  delete fx.config.credentialFile
  fs.writeFileSync(fx.file, JSON.stringify(fx.config))
  const result = await fx.cli('slot-create', ['--credential-fd', '0'])
  assert.equal(result.status, 0, result.out + result.err)
  assert.equal(result.out.includes('synthetic-command-refresh'), false)
  assert.deepEqual(
    JSON.parse((await fx.peer.query('SELECT vm_json FROM vms WHERE id=$1', [vmId])).rows[0].vm_json).fingerprint,
    fx.config.vm.fingerprint,
  )
})
nodeCase('an unknown node launch retains bootstrap and VM claims and refuses replacement attempts', async (fx) => {
  const init = await fx.cli('trusted-init')
  assert.equal(init.status, 0, init.out + init.err)
  await fx.db.pool.query(fs.readFileSync(fx.output, 'utf8'))
  fx.setFailStart()
  const result = await fx.cli('slot-create')
  assert.equal(result.status, 1)
  assert.match(result.err, /node_launch_unconfirmed/)
  assert.equal((await fx.peer.query('SELECT count(*)::int AS n FROM vms')).rows[0].n, 0)
  const bg = (
    await fx.peer.query('SELECT unknown_at,finished_at FROM background_task_runs WHERE task_key=$1', [
      `ha-node-bootstrap:${vmId}`,
    ])
  ).rows[0]
  assert.ok(bg.unknown_at)
  assert.equal(bg.finished_at, null)
  assert.ok(
    (await fx.peer.query("SELECT uncertain_at FROM vm_operations WHERE kind='node_launch'")).rows[0].uncertain_at,
  )
  const before = fx.calls.length,
    retry = await fx.cli('slot-create')
  assert.equal(retry.status, 1)
  assert.match(retry.err, /bootstrap_claim_unavailable/)
  assert.equal(fx.calls.length, before)
})
nodeCase('an existing VM inserted during node launch is not overwritten by metadata publication', async (fx) => {
  const init = await fx.cli('trusted-init')
  assert.equal(init.status, 0, init.out + init.err)
  await fx.db.pool.query(fs.readFileSync(fx.output, 'utf8'))
  fx.setBeforeStart(async () =>
    fx.db.query('INSERT INTO vms(id,vm_json) VALUES($1,$2)', [
      vmId,
      JSON.stringify({ id: vmId, fingerprint: { device_id: 'racing-owner', session_id: 'racing-session' } }),
    ]),
  )
  const result = await fx.cli('slot-create')
  assert.equal(result.status, 1)
  assert.match(result.err, /bootstrap_vm_exists/)
  assert.equal(
    JSON.parse((await fx.peer.query('SELECT vm_json FROM vms WHERE id=$1', [vmId])).rows[0].vm_json).fingerprint
      .device_id,
    'racing-owner',
  )
  const bg = (
    await fx.peer.query('SELECT unknown_at,finished_at FROM background_task_runs WHERE task_key=$1', [
      `ha-node-bootstrap:${vmId}`,
    ])
  ).rows[0]
  assert.ok(bg.unknown_at)
  assert.equal(bg.finished_at, null)
})

nodeCase('private credential permissions and exact account identity are checked before node admission', async (fx) => {
  fs.chmodSync(fx.credentialFile, 0o644)
  let result = await fx.cli('slot-create')
  assert.equal(result.status, 1)
  assert.match(result.err, /bootstrap_credential_invalid/)
  fs.chmodSync(fx.credentialFile, 0o600)
  const payload = JSON.parse(fs.readFileSync(fx.credentialFile, 'utf8'))
  payload.credential.account_uuid = 'different-account'
  fs.writeFileSync(fx.credentialFile, JSON.stringify(payload))
  result = await fx.cli('slot-create')
  assert.equal(result.status, 1)
  assert.match(result.err, /bootstrap_credential_invalid/)
  assert.equal(fx.calls.length, 0)
})
nodeCase('trusted-init rejects a symlink configuration without creating authority tables', async (fx) => {
  const target = path.join(fx.root, 'real-config.json')
  fs.renameSync(fx.file, target)
  fs.symlinkSync(target, fx.file)
  const result = await fx.cli('trusted-init')
  assert.equal(result.status, 1)
  assert.match(result.err, /bootstrap_config_invalid/)
  assert.equal(
    (await fx.peer.query('SELECT to_regclass($1) AS present', [`${fx.service.schema}.allocations`])).rows[0].present,
    null,
  )
})

nodeCase(
  'a busy VM before the first node call is known not started and permits a later explicit invocation',
  async (fx) => {
    const init = await fx.cli('trusted-init')
    assert.equal(init.status, 0, init.out + init.err)
    await fx.db.pool.query(fs.readFileSync(fx.output, 'utf8'))
    const { SharedVmOperations } = await import('../../src/lib/vm/shared-vm-operations.mjs')
    const held = await new SharedVmOperations(fx.db).tryAcquire({
      vmId,
      accountId: 'synthetic-account',
      kind: 'synthetic_hold',
    })
    try {
      const first = await fx.cli('slot-create')
      assert.equal(first.status, 1)
      assert.equal(fx.calls.length, 0)
      const bg = (
        await fx.peer.query('SELECT finished_at,unknown_at FROM background_task_runs WHERE task_key=$1', [
          `ha-node-bootstrap:${vmId}`,
        ])
      ).rows[0]
      assert.ok(bg.finished_at)
      assert.equal(bg.unknown_at, null)
    } finally {
      await held.release()
    }
    const retry = await fx.cli('slot-create')
    assert.equal(retry.status, 0, retry.out + retry.err)
  },
)
