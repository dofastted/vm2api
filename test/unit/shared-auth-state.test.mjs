import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fork } from 'node:child_process'
import { createDatabase, getDb } from '../../src/lib/db/database.mjs'
import { ClusterManager } from '../../src/lib/cluster/cluster-manager.mjs'
import { createSlotShell } from '../../src/lib/vm/slot-shell.mjs'
import { createClusterRoutes } from '../../src/lib/cluster/cluster-routes.mjs'
import { OneTimeAuthRepo } from '../../src/lib/db/repos/one-time-auth-repo.mjs'

let instance = 0

async function fixture(t) {
  const names = ['VM2API_CONTROL_PLANE_MODE', 'VM2API_DB_SECRET', 'KIN_FAKE_SESSION_OAUTH']
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  process.env.VM2API_DB_SECRET = 'synthetic-shared-pkce-key'
  process.env.KIN_FAKE_SESSION_OAUTH = '1'
  const db = getDb()
  const other = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-shared-auth-'))
  t.after(async () => {
    await other.close()
    fs.rmSync(root, { recursive: true, force: true })
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name]
    }
  })
  const controllers = await Promise.all(
    [0, 1].map(async () => {
      const suffix = `shared-auth-${++instance}`
      return {
        claude: await import(`../../src/lib/oauth/oauth-auth-url.mjs?${suffix}`),
        codex: await import(`../../src/lib/oauth/codex-oauth.mjs?${suffix}`),
      }
    }),
  )
  return { db, other, root, controllers }
}

function callbackState(generated, kind) {
  const outer = new URL(generated.auth_url)
  return (kind === 'codex' ? new URL(outer.searchParams.get('authorize_url')) : outer).searchParams.get('state')
}

function childController(operation, args) {
  const child = fork(new URL('../fixtures/shared-auth-worker.mjs', import.meta.url), [], { execArgv: [], silent: true })
  const result = new Promise((resolve, reject) => {
    child.on('message', (message) => {
      if (message.event === 'provider_started') resolve(message)
      else if (message.error) reject(Object.assign(new Error('synthetic controller failed'), { code: message.error }))
      else resolve(message.result)
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code) reject(new Error('synthetic controller exited'))
    })
  })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.send({ operation, args })
  return { child, result, exited }
}

test('independent processes can issue and consume PKCE and shell grants exactly once', async (t) => {
  await fixture(t)
  const issue = childController('issueCodex', { vmId: 'vm-auth', proxyUrl: '' })
  const generated = await issue.result
  await issue.exited
  const args = {
    sessionId: generated.session_id,
    vmId: 'vm-auth',
    code: `synthetic#${callbackState(generated, 'codex')}`,
  }
  const exchange = childController('exchangeCodex', args)
  assert.equal((await exchange.result).exchanged, true)
  await exchange.exited
  const replay = childController('exchangeCodex', args)
  await assert.rejects(replay.result, { code: 'session_expired' })
  await replay.exited
  const issuedShell = childController('issueShell', {})
  const { ticket } = await issuedShell.result
  await issuedShell.exited
  const consume = childController('consumeShell', { ticket, nodeId: 'node-a' })
  assert.equal((await consume.result).accepted, true)
  await consume.exited
  const repeat = childController('consumeShell', { ticket, nodeId: 'node-a' })
  assert.equal((await repeat.result).accepted, false)
  await repeat.exited
})

test('PKCE is encrypted at rest and shell tickets persist only their digest', async (t) => {
  const fx = await fixture(t)
  const generated = await fx.controllers[0].codex.generateCodexAuthUrl({ vmId: 'vm-auth', proxyUrl: '' })
  const row = await fx.other.prepare('SELECT * FROM oauth_pkce_sessions').get()
  assert.match(row.encrypted_session, /^enc:v1:/)
  assert.equal(row.id_hash, crypto.createHash('sha256').update(generated.session_id).digest('hex'))
  assert.ok(!row.encrypted_session.includes('codeVerifier'))
  const manager = new ClusterManager({ repo: { db: fx.db }, dataDir: fx.root })
  manager.links.set('node-a', { state: 'ready', client: {} })
  const { ticket } = await manager.issueShellTicket('node-a')
  const shell = await fx.other.prepare('SELECT * FROM shell_tickets').get()
  assert.equal(shell.ticket_hash, crypto.createHash('sha256').update(ticket).digest('hex'))
  assert.ok(!JSON.stringify(shell).includes(ticket))
})

test('a PKCE claim prevents concurrent provider requests from another connection', async (t) => {
  const fx = await fixture(t)
  const generated = await fx.controllers[0].codex.generateCodexAuthUrl({ vmId: 'vm-auth', proxyUrl: '' })
  let release
  const hold = new Promise((resolve) => {
    release = resolve
  })
  let started
  const began = new Promise((resolve) => {
    started = resolve
  })
  let calls = 0
  const args = {
    sessionId: generated.session_id,
    vmId: 'vm-auth',
    code: 'code=synthetic',
    fetchImpl: async () => {
      calls += 1
      started()
      await hold
      return { status: 200, json: async () => ({ access_token: 'synthetic', refresh_token: 'synthetic' }) }
    },
  }
  const first = fx.controllers[0].codex.exchangeCodexAuthCode({ ...args, db: fx.db })
  try {
    await Promise.race([began, first])
    await assert.rejects(fx.controllers[1].codex.exchangeCodexAuthCode({ ...args, db: fx.other }), {
      code: 'session_in_use',
    })
    assert.equal(calls, 1)
  } finally {
    release()
    await first
  }
})

test('a provider rejection preserves the Codex session for a later controller retry', async (t) => {
  const fx = await fixture(t)
  const generated = await fx.controllers[0].codex.generateCodexAuthUrl({ vmId: 'vm-auth', proxyUrl: '' })
  const args = { sessionId: generated.session_id, vmId: 'vm-auth', code: 'code=synthetic' }
  await assert.rejects(
    fx.controllers[0].codex.exchangeCodexAuthCode({
      ...args,
      fetchImpl: async () => ({ status: 403, json: async () => ({}) }),
    }),
    { code: 'exchange_rejected' },
  )
  assert.equal((await fx.other.prepare('SELECT claim_id FROM oauth_pkce_sessions').get()).claim_id, null)
  await fx.controllers[1].codex.exchangeCodexAuthCode({
    ...args,
    db: fx.other,
    fetchImpl: async () => ({
      status: 200,
      json: async () => ({ access_token: 'synthetic', refresh_token: 'synthetic' }),
    }),
  })
})

test('a provider rejection preserves the Claude session for a later retry', async (t) => {
  const fx = await fixture(t)
  const previous = process.env.KIN_OAUTH_AUTH_BIN
  const file = path.join(fx.root, 'synthetic-oauth-auth')
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
process.stdin.resume(); process.stdin.once('end',()=>process.stdout.write(JSON.stringify({ok:false,error:{code:'synthetic_provider_rejected',message:'synthetic rejection'}})+'\\n'));
`,
    { mode: 0o700 },
  )
  process.env.KIN_OAUTH_AUTH_BIN = file
  delete process.env.KIN_FAKE_SESSION_OAUTH
  try {
    const generated = await fx.controllers[0].claude.generateAuthUrl({ vmId: 'vm-auth', proxyUrl: '' })
    const args = { sessionId: generated.session_id, vmId: 'vm-auth', code: 'code=synthetic' }
    await assert.rejects(fx.controllers[0].claude.exchangeAuthCode(args), { code: 'synthetic_provider_rejected' })
    assert.equal((await fx.other.prepare('SELECT claim_id FROM oauth_pkce_sessions').get()).claim_id, null)
    process.env.KIN_FAKE_SESSION_OAUTH = '1'
    await fx.controllers[1].claude.exchangeAuthCode({ ...args, db: fx.other })
  } finally {
    if (previous === undefined) delete process.env.KIN_OAUTH_AUTH_BIN
    else process.env.KIN_OAUTH_AUTH_BIN = previous
  }
})

test('a crashed PKCE owner remains claimed until the original session expires', async (t) => {
  const fx = await fixture(t)
  const generated = await fx.controllers[0].codex.generateCodexAuthUrl({ vmId: 'vm-auth', proxyUrl: '' })
  const args = { sessionId: generated.session_id, vmId: 'vm-auth', code: 'code=synthetic' }
  const owner = childController('claimCodexForever', args)
  try {
    await owner.result
  } finally {
    owner.child.kill('SIGKILL')
    await owner.exited
  }
  let calls = 0
  const retry = {
    ...args,
    db: fx.other,
    fetchImpl: async () => {
      calls += 1
      assert.fail('no provider request expected')
    },
  }
  await assert.rejects(fx.controllers[1].codex.exchangeCodexAuthCode(retry), { code: 'session_in_use' })
  await fx.db.prepare("UPDATE oauth_pkce_sessions SET expires_at=clock_timestamp()-interval '1 second'").run()
  await assert.rejects(fx.controllers[1].codex.exchangeCodexAuthCode(retry), { code: 'session_expired' })
  assert.equal(calls, 0)
})

for (const [phase, event, expectedCalls] of [
  ['claim', 'UPDATE OF claim_id', 0],
  ['consume', 'DELETE', 1],
]) {
  test(`a PKCE PostgreSQL ${phase} failure never uses local fallback`, async (t) => {
    const fx = await fixture(t)
    const generated = await fx.controllers[0].codex.generateCodexAuthUrl({ vmId: 'vm-auth', proxyUrl: '' })
    await fx.db.exec(`CREATE FUNCTION reject_pkce() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic failure' USING ERRCODE='P6494'; END; $$;
      CREATE TRIGGER reject_pkce BEFORE ${event} ON oauth_pkce_sessions FOR EACH ROW EXECUTE FUNCTION reject_pkce();`)
    let calls = 0
    await assert.rejects(
      fx.controllers[0].codex.exchangeCodexAuthCode({
        sessionId: generated.session_id,
        vmId: 'vm-auth',
        code: 'code=synthetic',
        fetchImpl: async () => {
          calls += 1
          return { status: 200, json: async () => ({ access_token: 'synthetic', refresh_token: 'synthetic' }) }
        },
      }),
      { code: 'P6494' },
    )
    assert.equal(calls, expectedCalls)
    const row = await fx.other.prepare('SELECT claim_id FROM oauth_pkce_sessions').get()
    assert.equal(!!row.claim_id, phase === 'consume')
    if (phase === 'consume') {
      await assert.rejects(
        fx.controllers[1].codex.exchangeCodexAuthCode({
          sessionId: generated.session_id,
          vmId: 'vm-auth',
          code: 'code=synthetic',
          db: fx.other,
          fetchImpl: async () => {
            calls += 1
            assert.fail('a consumed provider code must not be retried')
          },
        }),
        { code: 'session_in_use' },
      )
      assert.equal(calls, 1)
    }
  })
}

test('PostgreSQL issue failures create neither PKCE nor a local shell fallback', async (t) => {
  const fx = await fixture(t)
  await fx.db.exec(`CREATE FUNCTION reject_auth_issue() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic issue failure' USING ERRCODE='P6495'; END; $$;
    CREATE TRIGGER reject_auth_issue BEFORE INSERT ON oauth_pkce_sessions FOR EACH ROW EXECUTE FUNCTION reject_auth_issue();
    CREATE TRIGGER reject_auth_issue BEFORE INSERT ON shell_tickets FOR EACH ROW EXECUTE FUNCTION reject_auth_issue();`)
  await assert.rejects(fx.controllers[0].codex.generateCodexAuthUrl({ vmId: 'vm-auth', proxyUrl: '' }), {
    code: 'P6495',
  })
  const manager = new ClusterManager({ repo: { db: fx.db }, dataDir: fx.root })
  manager.links.set('node-a', { state: 'ready', client: {} })
  await assert.rejects(manager.issueShellTicket('node-a'), { code: 'P6495' })
  assert.equal(manager.tickets.size, 0)
  assert.equal((await fx.other.prepare('SELECT count(*) AS count FROM oauth_pkce_sessions').get()).count, 0)
  assert.equal((await fx.other.prepare('SELECT count(*) AS count FROM shell_tickets').get()).count, 0)
})

test('shell scope mismatch does not consume a grant and concurrent consumers get one winner', async (t) => {
  const fx = await fixture(t)
  const a = new OneTimeAuthRepo(fx.db)
  const b = new OneTimeAuthRepo(fx.other)
  const { ticket } = await a.issueShell('slot', 'vm-a', { scope: 'login' })
  await assert.rejects(b.consumeShell('slot', ticket, 'vm-a'), { code: 'shell_ticket_scope_mismatch' })
  assert.equal(await b.consumeShell('node', ticket, 'vm-a'), null)
  const results = await Promise.all([a, b].map((repo) => repo.consumeShell('slot', ticket, 'vm-a', { scope: 'login' })))
  assert.equal(results.filter(Boolean).length, 1)
})

for (const kind of ['PKCE', 'shell']) {
  test(`${kind} that expires while waiting for a database row lock cannot be consumed`, async (t) => {
    const fx = await fixture(t)
    const repo = new OneTimeAuthRepo(fx.other)
    let consume
    let table
    if (kind === 'PKCE') {
      const generated = await fx.controllers[0].codex.generateCodexAuthUrl({ vmId: 'vm-auth', proxyUrl: '' })
      table = 'oauth_pkce_sessions'
      consume = () => repo.claimPkce('codex', generated.session_id, () => {})
    } else {
      const { ticket } = await new OneTimeAuthRepo(fx.db).issueShell('node', 'node-a')
      table = 'shell_tickets'
      consume = () => repo.consumeShell('node', ticket, 'node-a')
    }
    await fx.db.exec(`UPDATE ${table} SET expires_at=clock_timestamp()+interval '500 milliseconds'`)
    const client = await fx.db.pool.connect()
    let pending
    try {
      await client.query('BEGIN')
      await client.query(`SELECT * FROM ${table} FOR UPDATE`)
      const xid = (await client.query('SELECT pg_current_xact_id()::text AS xid')).rows[0].xid
      pending = consume()
      let blocked = false
      for (let i = 0; i < 100; i++) {
        const row = await fx.db
          .prepare(`SELECT count(*) AS count FROM pg_locks
          WHERE locktype='transactionid' AND transactionid::text=$1 AND NOT granted`)
          .get(xid)
        if (row.count) {
          blocked = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      assert.equal(blocked, true)
      await new Promise((resolve) => setTimeout(resolve, 550))
    } finally {
      await client.query('COMMIT')
      client.release()
    }
    if (kind === 'PKCE') await assert.rejects(pending, { code: 'session_expired' })
    else assert.equal(await pending, null)
  })
}

test('expired shell tickets are rejected and a database failure cannot authorize a node shell', async (t) => {
  const fx = await fixture(t)
  const a = new ClusterManager({ repo: { db: fx.db }, dataDir: fx.root })
  const b = new ClusterManager({ repo: { db: fx.other }, dataDir: fx.root })
  a.links.set('node-a', { state: 'ready', client: {} })
  const first = await a.issueShellTicket('node-a')
  await fx.db.prepare("UPDATE shell_tickets SET expires_at=clock_timestamp()-interval '1 second'").run()
  assert.equal(await b.consumeShellTicket(first.ticket, 'node-a'), false)
  const next = await a.issueShellTicket('node-a')
  await fx.other.close()
  await assert.rejects(b.consumeShellTicket(next.ticket, 'node-a'))
  assert.equal(await a.consumeShellTicket(next.ticket, 'node-a'), true)
})

test('cluster upgrade awaits ticket authorization and rejects a PostgreSQL failure', async () => {
  for (const consumeShellTicket of [
    async () => false,
    async () => {
      throw new Error('synthetic PG failure')
    },
  ]) {
    const routes = createClusterRoutes({
      manager: { consumeShellTicket },
      json() {},
      readBody() {},
      ok: (value) => value,
    })
    const writes = []
    const socket = { write: (value) => writes.push(String(value)), destroy() {} }
    assert.equal(
      routes.handleUpgrade({ url: '/api/panel/cluster/nodes/node-a/shell?ticket=synthetic' }, socket, Buffer.alloc(0)),
      true,
    )
    await routes.drain()
    assert.match(writes[0], /^HTTP\/1\.1 (401|503) /)
  }
})

for (const kind of ['claude', 'codex']) {
  test(`${kind} PKCE survives a controller change and permits only one successful exchange`, async (t) => {
    const fx = await fixture(t)
    const [a, b] = fx.controllers.map((controller) => controller[kind])
    const generate = kind === 'codex' ? a.generateCodexAuthUrl : a.generateAuthUrl
    const exchange = kind === 'codex' ? b.exchangeCodexAuthCode : b.exchangeAuthCode
    const generated = await generate({ vmId: 'vm-auth', proxyUrl: '', db: fx.db })
    const args = {
      sessionId: generated.session_id,
      code: `synthetic-code#${callbackState(generated, kind)}`,
      vmId: 'vm-auth',
      db: fx.other,
      fetchImpl: async () => ({
        status: 200,
        json: async () => ({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' }),
      }),
    }
    const result = await exchange(args)
    assert.ok(result.access_token)
    await assert.rejects(exchange(args), { code: 'session_expired' })
  })
}

test('a wrong Codex VM or state cannot consume another controller PKCE session', async (t) => {
  const fx = await fixture(t)
  const a = fx.controllers[0].codex
  const b = fx.controllers[1].codex
  const generated = await a.generateCodexAuthUrl({ vmId: 'vm-auth', proxyUrl: '', db: fx.db })
  let calls = 0
  const args = {
    sessionId: generated.session_id,
    code: `synthetic#${callbackState(generated, 'codex')}`,
    vmId: 'vm-wrong',
    db: fx.other,
    fetchImpl: async () => {
      calls += 1
      return {
        status: 200,
        json: async () => ({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' }),
      }
    },
  }
  await assert.rejects(b.exchangeCodexAuthCode(args), { code: 'session_vm_mismatch' })
  await assert.rejects(b.exchangeCodexAuthCode({ ...args, vmId: 'vm-auth', code: 'synthetic#wrong-state' }), {
    code: 'state_mismatch',
  })
  assert.equal(calls, 0)
  await b.exchangeCodexAuthCode({ ...args, vmId: 'vm-auth' })
  assert.equal(calls, 1)
})

test('Kubernetes PKCE refuses issue without the configured database encryption key', async (t) => {
  const fx = await fixture(t)
  delete process.env.VM2API_DB_SECRET
  const previous = process.env.KIN_DB_SECRET
  delete process.env.KIN_DB_SECRET
  try {
    await assert.rejects(
      async () => fx.controllers[0].codex.generateCodexAuthUrl({ vmId: 'vm-auth', proxyUrl: '', db: fx.db }),
      {
        code: 'oauth_session_encryption_required',
      },
    )
  } finally {
    if (previous !== undefined) process.env.KIN_DB_SECRET = previous
  }
})

test('node shell tickets cross controllers and a wrong resource does not consume them', async (t) => {
  const fx = await fixture(t)
  const managers = [fx.db, fx.other].map((db) => {
    const manager = new ClusterManager({ repo: { db }, dataDir: fx.root })
    for (const id of ['node-a', 'node-b']) manager.links.set(id, { state: 'ready', client: {} })
    return manager
  })
  const { ticket } = await managers[0].issueShellTicket('node-a')
  assert.equal(await managers[0].consumeShellTicket(ticket, 'node-b'), false)
  assert.equal(await managers[1].consumeShellTicket(ticket, 'node-a'), true)
  assert.equal(await managers[0].consumeShellTicket(ticket, 'node-a'), false)
})

test('slot login tickets cross controllers while a wrong VM does not consume them', async (t) => {
  const fx = await fixture(t)
  fs.mkdirSync(path.join(fx.root, 'vms'))
  for (const id of ['vm-a', 'vm-b']) fs.writeFileSync(path.join(fx.root, 'vms', `${id}.json`), JSON.stringify({ id }))
  const shells = [fx.db, fx.other].map((db) =>
    createSlotShell({
      projectRoot: fx.root,
      db,
      authLoginReady: async () => {},
      upgradeLoginReady: async () => {
        throw new Error('synthetic terminal is unavailable')
      },
    }),
  )
  t.after(async () => Promise.all(shells.map((shell) => shell.drain())))
  const { ticket } = await shells[0].issueTicket('vm-a', { login: true })
  async function upgrade(shell, id) {
    const writes = []
    assert.equal(
      shell.handleUpgrade(
        { url: `/api/panel/vms/${id}/shell?ticket=${ticket}&login=1` },
        {
          write: (data) => writes.push(String(data)),
          destroy() {},
        },
        Buffer.alloc(0),
      ),
      true,
    )
    for (let i = 0; !writes.length && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    return writes[0]
  }
  assert.match(await upgrade(shells[0], 'vm-b'), /^HTTP\/1\.1 401 /)
  assert.match(await upgrade(shells[1], 'vm-a'), /^HTTP\/1\.1 409 /)
  assert.match(await upgrade(shells[0], 'vm-a'), /^HTTP\/1\.1 401 /)
})
