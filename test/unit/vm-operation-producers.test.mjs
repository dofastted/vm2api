import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDb } from '../../src/lib/db/database.mjs'
import { createRepositoryTestDatabase as createDatabase } from '../repository-database.mjs'
import { ExecutionAdmissionsRepo } from '../../src/lib/db/repos/execution-admissions-repo.mjs'
import { AccountsRepo } from '../../src/lib/db/repos/accounts-repo.mjs'
import { createImportCommit } from '../../src/lib/oauth/import-commit.mjs'
import { queryClaudeResetCredits, redeemClaudeResetCredit } from '../../src/lib/oauth/claude-reset-credits.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { vmLockBusy } from '../../src/lib/vm/vm-file.mjs'

async function fixture(t, { codex = false } = {}) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-operation-producers-'))
  t.after(() => fs.rmSync(project, { recursive: true, force: true }))
  const original = {
    VM2API_CONTROL_PLANE_MODE: process.env.VM2API_CONTROL_PLANE_MODE,
    KIN_CRS_MOCK: process.env.KIN_CRS_MOCK,
  }
  process.env.VM2API_CONTROL_PLANE_MODE = 'kubernetes'
  process.env.KIN_CRS_MOCK = '1'
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const vm = codex
    ? { id: 'vm-1', platform: 'openai', family: 'codex', codex: {}, status: 'stopped' }
    : {
        id: 'vm-1',
        status: 'stopped',
        claude: { mode: 'oauth', has_access: true, scope: 'user:profile user:inference' },
      }
  fs.mkdirSync(path.join(project, 'vms'), { recursive: true })
  const vmPath = path.join(project, 'vms', 'vm-1.json')
  fs.writeFileSync(vmPath, JSON.stringify(vm))
  const db = getDb()
  const other = await createDatabase({ connectionString: db.connectionString, schema: db.schema })
  t.after(() => other.close())
  const active = async () =>
    (
      await other
        .prepare('SELECT count(*) AS n FROM vm_operations WHERE vm_id = $1 AND released_at IS NULL')
        .get('vm-1')
    ).n
  const input = {
    vmId: 'vm-1',
    vmPath,
    existing: vm,
    oauth: { access_token: 'synthetic-import-access', account_uuid: 'synthetic-account' },
    skipOfficialCc: true,
  }
  const ctx = { cfg: { paths: { project } }, accountQuota: { rebindToVm() {}, clearGrantRevokeLeftover() {} } }
  return { project, vmPath, vm, other, active, input, ctx }
}

function admission(other) {
  return new ExecutionAdmissionsRepo(other).tryReserve({
    accountId: 'account-a',
    vmId: 'vm-1',
    accountLimit: 2,
    vmLimit: 2,
    rpmLimit: 0,
    fableLimit: 0,
  })
}

test('credential import does not send or write before the VM claim rejects an active execution', async (t) => {
  const f = await fixture(t)
  const executing = await admission(f.other)
  let calls = 0
  const commit = createImportCommit({
    ...f.ctx,
    importWorkerCredential: async () => {
      calls++
      return { ok: true }
    },
  }).commitImportedOauth
  try {
    await assert.rejects(commit(f.input), { code: 'vm_execution_active' })
    assert.equal(calls, 0)
  } finally {
    await executing.release()
  }
})

test('credential import and post-import file writes share the complete VM operation scope', async (t) => {
  const f = await fixture(t)
  let sawImport = false
  let sawFinalFiles = false
  const commit = createImportCommit({
    ...f.ctx,
    importWorkerCredential: async () => {
      sawImport = true
      assert.equal(await f.active(), 1)
      return { ok: true }
    },
    getRoutingConfig: () => {
      sawFinalFiles = true
      assert.equal(vmLockBusy(f.vmPath), true)
      assert.equal(fs.existsSync(path.join(f.project, 'vms/vm-1/cli-home/.claude/credentials.json')), true)
      return {}
    },
  }).commitImportedOauth
  const result = await commit(f.input)
  assert.equal(result.ok, true)
  assert.equal(sawImport, true)
  assert.equal(sawFinalFiles, true)
  assert.equal(await f.active(), 0)
})

test('a nonthrowing unknown credential import retains the operation and denies execution', async (t) => {
  const f = await fixture(t)
  let calls = 0
  const commit = createImportCommit({
    ...f.ctx,
    importWorkerCredential: async () => {
      calls++
      return { ok: false, status: 0, error: { code: 'synthetic_remote_timeout' } }
    },
  }).commitImportedOauth
  const result = await commit(f.input)
  assert.equal(result.ok, false)
  assert.equal(calls, 1)
  assert.equal(await f.active(), 1)
  assert.equal((await admission(f.other)).code, 'vm_operation_active')
})

test('credit query holds the VM claim during its remote operation', async (t) => {
  const f = await fixture(t)
  const result = await queryClaudeResetCredits({
    projectRoot: f.project,
    vmId: 'vm-1',
    transport: async () => {
      assert.equal(await f.active(), 1)
      return { ok: true, status: 200, body: { cedar_ember: null } }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(await f.active(), 0)
})

test('a credit query timeout returned as an ordinary error retains the VM operation', async (t) => {
  const f = await fixture(t)
  const result = await queryClaudeResetCredits({
    projectRoot: f.project,
    vmId: 'vm-1',
    transport: async () => ({ ok: false, status: 0, transportError: true }),
  })
  assert.equal(result.ok, false)
  assert.equal(await f.active(), 1)
})

test('an unknown credit redemption retains its VM operation as well as the organization file fence', async (t) => {
  const f = await fixture(t)
  const result = await redeemClaudeResetCredit({
    projectRoot: f.project,
    vmId: 'vm-1',
    idempotencyKey: 'synthetic-redemption',
    transport: async (_exec, op) => {
      if (op === 'profile')
        return { ok: true, status: 200, body: { organization: { uuid: '11111111-1111-4111-8111-111111111111' } } }
      if (op === 'reset-status')
        return {
          ok: true,
          status: 200,
          body: {
            cedar_ember: {
              eligible: true,
              at_limit: true,
              next_grant_id: 'synthetic',
              grants: [
                { id: 'synthetic', resets_left: 1, usable_now: true, use_requires_limit: false, clears: ['five_hour'] },
              ],
            },
          },
        }
      return { ok: false, status: 0, transportError: true }
    },
  })
  assert.equal(result.outcome, 'unknown')
  assert.equal(await f.active(), 1)
  assert.equal((await admission(f.other)).code, 'vm_operation_active')
})

function panel(f, overrides = {}) {
  const response = {}
  const handler = createPanelHandler({
    ...f.ctx,
    requireAuth(req) {
      req.apiKeyKind = 'master'
      req.panelRole = 'admin'
      return true
    },
    readBody: async () => ({}),
    json(_res, status, body) {
      response.status = status
      response.body = body
      return true
    },
    ...overrides,
  })
  return { response, handler }
}

test('a reset destroy timeout returned as a normal HTTP error keeps its operation', async (t) => {
  const f = await fixture(t)
  // Protect the failing baseline too: its un-injected docker calls reach only this synthetic executable.
  const bin = path.join(f.project, 'fake-bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(
    path.join(bin, 'docker'),
    '#!/bin/sh\nif [ "$1" = inspect ]; then printf "true|123|bridge|now|synthetic|synthetic|docker||false\\n"; exit 0; fi\nexit 1\n',
    { mode: 0o700 },
  )
  const previousPath = process.env.PATH
  process.env.PATH = bin + path.delimiter + previousPath
  t.after(() => {
    process.env.PATH = previousPath
  })
  const p = panel(f, { destroySlot: async () => ({ ok: false, error: 'synthetic timeout' }) })
  await p.handler({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/vm-1/reset'))
  assert.equal(p.response.status, 500)
  assert.equal(await f.active(), 1)
})

test('credential clear cannot report SIGTERM delivery as confirmed kernel exit', async (t) => {
  const f = await fixture(t, { codex: true })
  // The old implementation ignores ctx mocks; remove all binary fallbacks before executing it.
  const cwd = process.cwd()
  const keys = ['KIN_CODEX_KERNEL_BIN', 'KIN_KERNEL_BIN', 'KIN_API_KERNEL_BIN']
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  for (const key of keys) process.env[key] = ''
  process.chdir(f.project)
  t.after(() => {
    process.chdir(cwd)
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  let starts = 0
  const p = panel(f, {
    stopCodexKernel: () => ({ exitCode: null, signalCode: null }),
    finishCodexRecycle: async () => ({ exited: false }),
    ensureCodexKernel: async () => {
      starts++
      return { ok: true }
    },
  })
  await p.handler({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/vm-1/credential/clear'))
  assert.equal(p.response.status, 200)
  assert.equal(starts, 0)
  assert.equal(await f.active(), 1)
  assert.equal(p.response.body.data.cleared.kernel.stopped, false)
})

test('a known not-started credential failure releases instead of reserving an unknown operation', async (t) => {
  const f = await fixture(t)
  const commit = createImportCommit({
    ...f.ctx,
    importWorkerCredential: async () => ({ ok: false, vmOperationNotStarted: true }),
  }).commitImportedOauth
  assert.equal((await commit(f.input)).ok, false)
  assert.equal(await f.active(), 0)
})

test('Kubernetes credential import awaits official initialization while holding the VM operation', async (t) => {
  const f = await fixture(t)
  process.env.KIN_CRS_MOCK = '0'
  let entered
  let finish
  const started = new Promise((resolve) => {
    entered = resolve
  })
  const completing = new Promise((resolve) => {
    finish = resolve
  })
  const commit = createImportCommit({
    ...f.ctx,
    routingConfig: { official_cc: { enabled: true } },
    reloadSlotReady: async () => ({ ok: true, runtime: {} }),
    importWorkerCredential: async () => ({ ok: true }),
    runOfficialCcBootstrap: async () => {
      entered()
      await completing
      return { ok: true }
    },
  }).commitImportedOauth
  const pending = commit({ ...f.input, skipOfficialCc: false })
  await started
  try {
    assert.equal(await f.active(), 1)
    assert.equal((await admission(f.other)).code, 'vm_operation_active')
  } finally {
    finish()
  }
  const result = await pending
  assert.equal(result.official_cc_bootstrap.completed, true)
  assert.equal(await f.active(), 0)
})

test('Kubernetes remote unsupported or disabled official initialization never falls back to local execution', async (t) => {
  const f = await fixture(t)
  process.env.KIN_CRS_MOCK = '0'
  let calls = 0
  const ctx = {
    ...f.ctx,
    routingConfig: { official_cc: { enabled: false } },
    reloadSlotReady: async () => ({ ok: true, runtime: {} }),
    importWorkerCredential: async () => ({ ok: true }),
    runOfficialCcBootstrap: async () => {
      calls++
      throw new Error('unexpected official initialization')
    },
  }
  const commit = createImportCommit(ctx).commitImportedOauth
  const disabled = await commit({ ...f.input, skipOfficialCc: false })
  assert.equal(disabled.official_cc_bootstrap.reason, 'disabled')
  const remoteVm = { ...JSON.parse(fs.readFileSync(f.vmPath)), node_id: 'synthetic-remote-node' }
  fs.writeFileSync(f.vmPath, JSON.stringify(remoteVm))
  ctx.routingConfig = { official_cc: { enabled: true } }
  const remote = await commit({ ...f.input, skipOfficialCc: false })
  assert.equal(remote.official_cc_bootstrap.reason, 'remote_unsupported')
  assert.equal(calls, 0)
  assert.equal(await f.active(), 0)
})

test('confirmed kernel exit and successful restart release credential clear normally', async (t) => {
  const f = await fixture(t, { codex: true })
  const events = []
  const p = panel(f, {
    stopCodexKernel: () => {
      events.push('signal')
      return {}
    },
    finishCodexRecycle: async () => {
      events.push('exit')
      return { exited: true }
    },
    ensureCodexKernel: async () => {
      events.push('start')
      return { ok: true }
    },
  })
  await p.handler({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/vm-1/credential/clear'))
  assert.deepEqual(events, ['signal', 'exit', 'start'])
  assert.equal(await f.active(), 0)
  assert.equal(p.response.body.data.cleared.kernel.stopped, true)
})

test('a confirmed destroy followed by an unknown start result keeps the reset operation', async (t) => {
  const f = await fixture(t)
  const vm = {
    ...f.vm,
    proxy: { id: 'synthetic-proxy', scheme: 'socks5', host: '127.0.0.1', port: 9, url: 'socks5://127.0.0.1:9' },
  }
  fs.writeFileSync(f.vmPath, JSON.stringify(vm))
  const p = panel(f, {
    readBody: async () => ({ mode: 'keep' }),
    destroySlot: async () => ({ ok: true, action: 'removed' }),
    startSlotReady: async () => ({ ok: false, error: 'synthetic start timeout' }),
  })
  await p.handler({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/vm-1/reset'))
  assert.equal(p.response.status, 500)
  assert.equal(await f.active(), 1)
})

test('a reset rejected before sending a destroy is known not-started and releases its operation', async (t) => {
  const f = await fixture(t)
  const p = panel(f, {
    destroySlot: async () => ({ ok: false, error: 'synthetic preflight rejected', vmOperationNotStarted: true }),
  })
  await p.handler({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/vm-1/reset'))
  assert.equal(p.response.status, 500)
  assert.equal(await f.active(), 0)
})

test('credential clear awaits the account identity patch before releasing its VM operation', async (t) => {
  const f = await fixture(t)
  const repo = new AccountsRepo(f.other)
  await repo.insert({ account_id: 'vm-1', email: 'synthetic@example.invalid', name: 'synthetic' })
  let entered
  let finish
  let patched = false
  let completed = false
  const started = new Promise((resolve) => {
    entered = resolve
  })
  const completing = new Promise((resolve) => {
    finish = resolve
  })
  const p = panel(f, {
    accountQuota: {
      repo: {
        get: (...args) => repo.get(...args),
        async patchFields(...args) {
          patched = true
          entered()
          await completing
          return repo.patchFields(...args)
        },
      },
    },
    stopCodexKernel: () => null,
  })
  const pending = p
    .handler({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/vm-1/credential/clear'))
    .finally(() => {
      completed = true
    })
  await Promise.race([started, pending])
  try {
    assert.equal(patched, true)
    assert.equal(completed, false)
    assert.equal(await f.active(), 1)
  } finally {
    finish()
    await pending
  }
  assert.equal((await repo.get('vm-1')).email, null)
  assert.equal(await f.active(), 0)
})
