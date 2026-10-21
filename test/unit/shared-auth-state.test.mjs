import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase, getDb } from '../../src/lib/db/database.mjs'
import { ClusterManager } from '../../src/lib/cluster/cluster-manager.mjs'
import { createSlotShell } from '../../src/lib/vm/slot-shell.mjs'

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
