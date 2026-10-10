import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { readWorkerCredentialFile } from '../../src/lib/oauth/oauth-credentials.mjs'
import { readCodexAccounts } from '../../src/lib/vm/codex-slot.mjs'
import { isLocalEgressProxy } from '../../src/lib/vm/egress.mjs'
import { buildVmPackage, parseVmPackage } from '../../src/lib/vm/vm-package.mjs'

function claudePackage(id, token = 'sk-ant-oat01-PACKAGE') {
  return buildVmPackage({
    vm: {
      id,
      name: 'finished',
      platform: 'anthropic',
      family: 'claude',
      kernel: 'ubuntu-24.04',
      timezone: 'Asia/Tokyo',
      timezone_source: 'manual',
      locale: 'en_US.UTF-8',
      note: 'ready',
      region: 'ap-northeast-1',
      persona_preset: 'official',
      inference_engine: 'rust',
      dataplane: 'wrap',
      proxy_cli_enabled: true,
      schedulable: true,
      schedule_manual: false,
      policy: {
        maxConcurrency: 3,
        concurrencyOverride: true,
        maxRpm: 12,
        rpmOverride: true,
        weight: 4,
        inflight: 9,
      },
      claude: { auth_scheme: 'authorization_bearer', mode: 'oauth' },
      stats: { requests: 40 },
    },
    proxy: { host: '10.2.2.2', port: 1080, username: 'alice', password: 's3cret' },
    proxyLabel: 'exit-a',
    claudeCred: {
      type: 'oauth',
      access_token: token,
      refresh_token: 'sk-ant-ort01-PACKAGE',
      expires_at: 1_900_000_000,
      email: 'slot@example.com',
    },
  })
}

function makeHandler(project, body, { pool, role = 'admin', panelUsers = null } = {}) {
  const response = {}
  const handlePanel = createPanelHandler({
    cfg: { paths: { project } },
    proxyPool: pool,
    panelUsers,
    packageImportBringUp: false,
    requireAuth(req) {
      if (role === 'admin') {
        req.apiKeyKind = 'master'
        req.panelRole = 'admin'
      } else {
        req.panelUser = 'member'
        req.panelRole = 'user'
        req.panelUserId = 'user-1'
      }
      return true
    },
    json(_res, status, payload) {
      response.status = status
      response.body = payload
      return true
    },
    readBody: async () => body,
  })
  return { handlePanel, response }
}

function makePool(t) {
  const db = createDatabase({ dbPath: ':memory:' })
  const pool = new ProxyPool({ db })
  t.after(() => {
    pool.stopScheduler()
    db.close()
  })
  return pool
}

test('package keeps traits, SOCKS password and token, and drops runtime', () => {
  const doc = claudePackage('vm-pkg')
  assert.equal(doc.type, 'vm2api-vm-package')
  assert.equal(doc.proxy.password, 's3cret')
  assert.equal(doc.credential.export.accounts[0].credentials.access_token, 'sk-ant-oat01-PACKAGE')
  assert.equal(doc.vm.stats, undefined)
  assert.equal(doc.vm.policy.inflight, undefined)
  assert.equal(doc.vm.timezone, 'Asia/Tokyo')
  const parsed = parseVmPackage(doc)
  assert.equal(parsed.ok, true, parsed.error?.message)
  assert.equal(parsed.value.proxy.password, 's3cret')
  assert.equal(parsed.value.vm.policy.maxConcurrency, 3)
  assert.equal(parsed.value.vm.persona_preset, 'official')
})

test('import creates the slot and rolls a colliding id forward', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-pkg-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = makePool(t)
  const doc = claudePackage('vm-pkg')
  const first = makeHandler(root, doc, { pool })
  await first.handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/package'))
  assert.equal(first.response.status, 201, first.response.body?.error?.message)
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-pkg.json'), 'utf8'))
  assert.equal(saved.id, 'vm-pkg')
  assert.equal(saved.status, 'stopped')
  assert.equal(saved.name, 'finished')
  assert.equal(saved.timezone, 'Asia/Tokyo')
  assert.equal(saved.persona_preset, 'official')
  assert.equal(saved.runtime.type, 'docker')
  assert.equal(saved.machine.memory, '512m')
  assert.equal(saved.policy.maxConcurrency, 3)
  assert.equal(saved.stats.requests, undefined)
  assert.equal(saved.proxy.host, '10.2.2.2')
  assert.equal(saved.proxy.password, 's3cret')
  assert.equal(saved.claude.access_token, undefined)
  const cred = readWorkerCredentialFile(path.join(root, 'vms', 'vm-pkg', 'cli-home'))
  assert.equal(cred.access_token, 'sk-ant-oat01-PACKAGE')
  assert.equal(pool.ensureSocks({ host: '10.2.2.2', port: 1080, username: 'alice', password: 's3cret' }).created, false)

  const again = makeHandler(root, doc, { pool })
  await again.handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/package'))
  assert.equal(again.response.status, 201, again.response.body?.error?.message)
  assert.equal(again.response.body.data.renamed_from, 'vm-pkg')
  const nextId = again.response.body.data.vm.id
  assert.equal(nextId, 'vm-01')
  const still = readWorkerCredentialFile(path.join(root, 'vms', 'vm-pkg', 'cli-home'))
  assert.equal(still.access_token, 'sk-ant-oat01-PACKAGE')
  const moved = JSON.parse(fs.readFileSync(path.join(root, 'vms', `${nextId}.json`), 'utf8'))
  assert.equal(moved.proxy.host, '10.2.2.2')
  assert.equal(moved.timezone, 'Asia/Tokyo')
  assert.equal(moved.name, 'finished')
})

test('write-back updates the current slot and leaves runtime counters', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-pkg-put-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = makePool(t)
  const created = makeHandler(root, claudePackage('vm-pkg'), { pool })
  await created.handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/package'))
  assert.equal(created.response.status, 201, created.response.body?.error?.message)
  const file = path.join(root, 'vms', 'vm-pkg.json')
  const before = JSON.parse(fs.readFileSync(file, 'utf8'))
  before.stats = { requests: 40 }
  before.policy.inflight = 7
  before.status = 'running'
  fs.writeFileSync(file, JSON.stringify(before))

  const edited = claudePackage('other-id', 'sk-ant-oat01-REPLACED')
  edited.vm.name = 'renamed'
  const put = makeHandler(root, edited, { pool })
  await put.handlePanel({ method: 'PUT' }, {}, new URL('http://localhost/api/panel/vms/vm-pkg/package'))
  assert.equal(put.response.status, 200, put.response.body?.error?.message)
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.id, 'vm-pkg')
  assert.equal(saved.name, 'renamed')
  assert.equal(saved.status, 'running')
  assert.equal(saved.stats.requests, 40)
  assert.equal(saved.policy.inflight, 7)
  assert.equal(fs.existsSync(path.join(root, 'vms', 'other-id.json')), false)
  const cred = readWorkerCredentialFile(path.join(root, 'vms', 'vm-pkg', 'cli-home'))
  assert.equal(cred.access_token, 'sk-ant-oat01-REPLACED')
})

test('local egress imports as px-local and codex tokens stay out of vm.json', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-pkg-kind-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = makePool(t)
  const local = claudePackage('vm-local')
  local.proxy = { kind: 'local' }
  const localRes = makeHandler(root, local, { pool })
  await localRes.handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/package'))
  assert.equal(localRes.response.status, 201, localRes.response.body?.error?.message)
  const localVm = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-local.json'), 'utf8'))
  assert.equal(isLocalEgressProxy(localVm.proxy), true)

  const codex = {
    type: 'vm2api-vm-package',
    version: 1,
    vm: {
      id: 'vm-gpt',
      name: 'gpt',
      platform: 'openai',
      family: 'codex',
      kernel: 'ubuntu-24.04',
      timezone: 'America/Los_Angeles',
      timezone_source: 'manual',
    },
    proxy: { kind: 'local' },
    credential: {
      platform: 'openai',
      accounts: [{ access_token: 'oa-access', refresh_token: 'oa-refresh', email: 'gpt@example.com' }],
    },
  }
  const gpt = makeHandler(root, codex, { pool })
  await gpt.handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/package'))
  assert.equal(gpt.response.status, 201, gpt.response.body?.error?.message)
  const gptVm = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-gpt.json'), 'utf8'))
  assert.equal(gptVm.platform, 'openai')
  assert.equal(gptVm.codex.access_token, undefined)
  assert.equal(readCodexAccounts(root, 'vm-gpt')[0].access_token, 'oa-access')

  const mismatch = makeHandler(root, codex, { pool })
  await mismatch.handlePanel({ method: 'PUT' }, {}, new URL('http://localhost/api/panel/vms/vm-local/package'))
  assert.equal(mismatch.response.status, 409)
  assert.equal(mismatch.response.body.error.code, 'credential_kind_mismatch')
})

test('user cannot download a package and cannot import past the create quota', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-pkg-user-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = makePool(t)
  const admin = makeHandler(root, claudePackage('vm-pkg'), { pool })
  await admin.handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/package'))
  assert.equal(admin.response.status, 201, admin.response.body?.error?.message)

  const reader = makeHandler(root, null, { pool, role: 'user' })
  await reader.handlePanel({ method: 'GET' }, {}, new URL('http://localhost/api/panel/vms/vm-pkg/package'))
  assert.equal(reader.response.status, 403)

  const importer = makeHandler(root, claudePackage('vm-other'), {
    pool,
    role: 'user',
    panelUsers: {
      getById() {
        return { vm_create_quota: 0 }
      },
    },
  })
  await importer.handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/package'))
  assert.equal(importer.response.status, 403)
  assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-other.json')), false)
})

test('tenant import cannot bind px-local or another owner SOCKS and drops seed_policy', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-pkg-tenant-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = makePool(t)
  const panelUsers = { getById: () => ({ vm_create_quota: 5 }) }
  const importAs = async (doc) => {
    const h = makeHandler(root, doc, { pool, role: 'user', panelUsers })
    await h.handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/package'))
    return h.response
  }

  const local = claudePackage('vm-t-local')
  local.proxy = { kind: 'local' }
  const localRes = await importAs(local)
  assert.equal(localRes.status, 403)
  assert.equal(localRes.body.error.code, 'proxy_forbidden')
  assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-t-local.json')), false)

  // The platform already owns this SOCKS row; equal credentials must not hand it to the tenant.
  pool.ensureSocks({ host: '10.2.2.2', port: 1080, username: 'alice', password: 's3cret' })
  const taken = await importAs(claudePackage('vm-t-taken'))
  assert.equal(taken.status, 403)
  assert.equal(taken.body.error.code, 'proxy_forbidden')
  assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-t-taken.json')), false)

  const own = claudePackage('vm-t-own')
  own.proxy = { host: '10.3.3.3', port: 1080, username: 'bob', password: 'pw' }
  own.vm.seed_policy = { extra_env: { HTTP_PROXY: 'http://attacker:1' } }
  const ok = await importAs(own)
  assert.equal(ok.status, 201, ok.body?.error?.message)
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-t-own.json'), 'utf8'))
  assert.equal(saved.owner_user_id, 'user-1')
  assert.equal(saved.proxy.host, '10.3.3.3')
  assert.equal(JSON.stringify(saved.seed_policy).includes('attacker'), false)

  const reserved = await importAs(claudePackage('package'))
  assert.equal(reserved.status, 400)
  assert.equal(fs.existsSync(path.join(root, 'vms', 'package.json')), false)
})

test('admin export returns the SOCKS password', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-pkg-get-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = makePool(t)
  const created = makeHandler(root, claudePackage('vm-pkg'), { pool })
  await created.handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/package'))
  const got = makeHandler(root, null, { pool })
  await got.handlePanel({ method: 'GET' }, {}, new URL('http://localhost/api/panel/vms/vm-pkg/package'))
  assert.equal(got.response.status, 200, got.response.body?.error?.message)
  assert.equal(got.response.body.data.proxy.password, 's3cret')
  assert.equal(got.response.body.data.credential.export.accounts[0].credentials.access_token, 'sk-ant-oat01-PACKAGE')
  assert.equal(got.response.body.data.vm.id, 'vm-pkg')
})
