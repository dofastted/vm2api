import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  needsRefresh,
  expiresAtToMs,
  normalizeOauth,
  applyOauthToCfg,
  persistOauthToVm,
  healLeftoverAuthState,
  markVmAuthCooldown,
  clearVmAuthCooldown,
  restoreScheduleAfterLiveCredential,
  readWorkerCredentialFile,
  readSlotCredentialIdentity,
  writeWorkerCredentialFile,
  slotUidGidFromHomeDir,
  ensureSlotClaudeOwnership,
  REFRESH_SKEW_MS,
} from '../../src/lib/oauth/oauth-credentials.mjs'

test('needsRefresh: missing/expired/skew', () => {
  const now = 1_000_000_000_000
  assert.equal(needsRefresh(null, now), true)
  assert.equal(needsRefresh(now / 1000 - 10, now), true)
  assert.equal(needsRefresh(now / 1000 + 60, now), true)
  assert.equal(needsRefresh(now / 1000 + REFRESH_SKEW_MS / 1000 + 120, now), false)
})

test('expiresAtToMs accepts seconds and ms', () => {
  assert.equal(expiresAtToMs(1786951995), 1786951995000)
  assert.equal(expiresAtToMs(1786951995000), 1786951995000)
})

test('normalizeOauth maps both casings and computes expires_at', () => {
  const n = normalizeOauth({
    accessToken: 'at',
    refreshToken: 'rt',
    expires_in: 100,
  })
  assert.equal(n.access_token, 'at')
  assert.equal(n.refresh_token, 'rt')
  assert.ok(n.expires_at > Math.floor(Date.now() / 1000) + 50)
})

test('persist + apply keep other vm fields', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-oauth-'))
  const vmPath = path.join(dir, 'vm-x.json')
  fs.writeFileSync(
    vmPath,
    JSON.stringify({
      id: 'vm-x',
      policy: { maxConcurrency: 2 },
      claude: { email: 'a@b.c', access_token: 'old', refresh_token: 'oldrt', extra: 1, session_key: 'sk-keep' },
    }),
  )
  persistOauthToVm(vmPath, { access_token: 'new', refresh_token: 'newrt', expires_at: 99 })
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(vm.policy.maxConcurrency, 2)
  assert.equal(vm.claude.email, 'a@b.c')
  assert.equal(vm.claude.extra, 1)
  assert.equal(vm.claude.has_access, true)
  assert.equal(vm.claude.has_refresh, true)
  assert.equal(vm.claude.access_token, undefined)
  assert.equal(vm.claude.refresh_token, undefined)
  assert.equal(vm.claude.session_key, undefined)
  assert.equal(vm.claude.expires_at, 99)
  assert.ok(vm.claude._token_version > 0)

  const cfg = { vm: { expires_at: 1 } }
  applyOauthToCfg(cfg, vm.claude)
  assert.equal(cfg.vm.access_token, undefined)
  assert.equal(cfg.vm.has_access, true)
  assert.equal(cfg.vm.expires_at, 99)
})

test('persistOauthToVm returns null for a missing vm file', () => {
  assert.equal(persistOauthToVm('/nonexistent/vm.json', { access_token: 'x' }), null)
})

test('persistOauthToVm clears leftover oauth_cleared after a live credential', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-oauth-'))
  const vmPath = path.join(dir, 'vm-02.json')
  fs.writeFileSync(
    vmPath,
    JSON.stringify({
      id: 'vm-02',
      status: 'stopped',
      schedulable: false,
      schedule_disabled_reason: 'oauth_cleared',
      claude: {},
    }),
  )
  persistOauthToVm(vmPath, { access_token: 'new', refresh_token: 'newrt', expires_at: 99 })
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(vm.status, 'running')
  assert.equal(vm.schedulable, true)
  assert.equal(vm.schedule_disabled_reason, null)
  assert.equal(vm.claude.has_access, true)
  assert.equal(vm.claude.has_refresh, true)
})

test('persistOauthToVm clears a 401 park after a live ticket is written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-oauth-'))
  const vmPath = path.join(dir, 'vm-05.json')
  fs.writeFileSync(
    vmPath,
    JSON.stringify({
      id: 'vm-05',
      schedulable: true,
      claude: { has_access: true, has_refresh: true },
    }),
  )
  markVmAuthCooldown(vmPath, {
    until: Date.now() + 120_000,
    reason: 'authentication_failed_after_refresh',
    generation: 9,
  })
  const parked = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(parked.claude.temp_unschedulable_reason, 'authentication_failed_after_refresh')
  assert.equal(parked.claude.oauth_401_generation, 9)
  persistOauthToVm(vmPath, { access_token: 'new', refresh_token: 'newrt', expires_at: 99 })
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(vm.claude.temp_unschedulable_until, undefined)
  assert.equal(vm.claude.temp_unschedulable_reason, undefined)
  assert.equal(vm.claude.oauth_401_generation, undefined)
  clearVmAuthCooldown(vmPath)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('persistOauthToVm does not reopen an operator-disabled slot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-oauth-'))
  const vmPath = path.join(dir, 'vm-02.json')
  fs.writeFileSync(
    vmPath,
    JSON.stringify({
      id: 'vm-02',
      status: 'paused',
      schedulable: false,
      schedule_disabled_reason: 'disabled',
      claude: {},
    }),
  )
  persistOauthToVm(vmPath, { access_token: 'new', refresh_token: 'newrt', expires_at: 99 })
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(vm.schedulable, false)
  assert.equal(vm.schedule_disabled_reason, 'disabled')
  assert.equal(vm.status, 'paused')
})

test('persistOauthToVm does not un-revoke when the ticket did not rotate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-oauth-revoked-'))
  const vmPath = path.join(dir, 'vm-50.json')
  fs.writeFileSync(
    vmPath,
    JSON.stringify({
      id: 'vm-50',
      schedulable: false,
      schedule_disabled_reason: 'oauth_revoked',
      claude: {
        has_access: true,
        has_refresh: true,
        expires_at: 1_800_000_000_000,
        refresh_error: 'oauth_revoked',
      },
    }),
  )
  persistOauthToVm(vmPath, {
    access_token: 'same',
    refresh_token: 'same-rt',
    expires_at: 1_800_000_000_000,
  })
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(vm.claude.refresh_error, 'oauth_revoked')
  assert.equal(vm.schedule_disabled_reason, 'oauth_revoked')
  assert.equal(vm.schedulable, false)
})

test('healLeftoverAuthState does not clear oauth_revoked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-heal-revoked-'))
  const vmPath = path.join(dir, 'vm-50.json')
  fs.writeFileSync(
    vmPath,
    JSON.stringify({
      id: 'vm-50',
      schedule_disabled_reason: 'oauth_revoked',
      claude: { refresh_error: 'oauth_revoked', temp_unschedulable_reason: 'authentication_failed_after_refresh' },
    }),
  )
  healLeftoverAuthState(vmPath)
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(vm.claude.refresh_error, 'oauth_revoked')
  assert.equal(vm.schedule_disabled_reason, 'oauth_revoked')
})

test('restoreScheduleAfterLiveCredential heals oauth_revoked after a live credential', () => {
  const vm = {
    status: 'paused',
    schedulable: false,
    schedule_disabled_reason: 'oauth_revoked',
    claude: { has_access: true, has_refresh: true },
  }
  restoreScheduleAfterLiveCredential(vm)
  assert.equal(vm.schedulable, true)
  assert.equal(vm.schedule_disabled_reason, null)
  assert.equal(vm.status, 'running')
})

test('persistOauthToVm heals revoke when acceptLiveGrant even if expiry did not bump', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-oauth-import-'))
  const vmPath = path.join(dir, 'vm-50.json')
  fs.writeFileSync(
    vmPath,
    JSON.stringify({
      id: 'vm-50',
      schedulable: false,
      schedule_disabled_reason: 'oauth_revoked',
      claude: {
        has_access: true,
        has_refresh: true,
        expires_at: 1_800_000_000_000,
        refresh_error: 'oauth_revoked',
      },
    }),
  )
  persistOauthToVm(
    vmPath,
    {
      access_token: 'new',
      refresh_token: 'new-rt',
      expires_at: 1_800_000_000_000,
    },
    { acceptLiveGrant: true },
  )
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(vm.claude.refresh_error, null)
  assert.equal(vm.schedule_disabled_reason, null)
  assert.equal(vm.schedulable, true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('restoreScheduleAfterLiveCredential ignores operator stopped', () => {
  const vm = {
    status: 'stopped',
    schedulable: false,
    schedule_disabled_reason: 'stopped',
    claude: { has_access: true, has_refresh: true },
  }
  restoreScheduleAfterLiveCredential(vm)
  assert.equal(vm.schedulable, false)
  assert.equal(vm.schedule_disabled_reason, 'stopped')
})

test('slot identity only reads worker credentials.json, never leftover dotfile', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-slot-cred-'))
  const claude = path.join(home, '.claude')
  fs.mkdirSync(claude, { recursive: true })
  fs.writeFileSync(
    path.join(claude, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: { accountUuid: 'wrong-leftover', accessToken: 'old', refreshToken: 'oldrt' },
    }),
  )
  assert.equal(readWorkerCredentialFile(home), null)
  assert.equal(readSlotCredentialIdentity(home), null)
  fs.writeFileSync(
    path.join(claude, 'credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accountUuid: 'slot-account',
        orgUuid: 'slot-org',
        email: 'slot@example.com',
        accessToken: 'live',
        refreshToken: 'livert',
      },
    }),
  )
  const id = readSlotCredentialIdentity(home)
  assert.equal(id.account_uuid, 'slot-account')
  assert.equal(id.org_uuid, 'slot-org')
  assert.equal(id.email, 'slot@example.com')
  assert.equal(id.source, 'slot-credentials.json')
  assert.equal(id.has_access, true)
  assert.ok(!Object.prototype.hasOwnProperty.call(id, 'access_token'))
})

test('readWorkerCredentialFile infers setup-token from inference-only scopes', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-slot-infer-'))
  const claude = path.join(home, '.claude')
  fs.mkdirSync(claude, { recursive: true })
  fs.writeFileSync(
    path.join(claude, 'credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-NEW',
        refreshToken: 'sk-ant-ort01-NEW',
        scopes: ['user:inference'],
      },
    }),
  )
  const cred = readWorkerCredentialFile(home)
  assert.equal(cred.type, 'setup-token')
  assert.equal(cred.scope, 'user:inference')
})

test('writeWorkerCredentialFile maps setup-token inference scope to user:inference', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-slot-scope-'))
  writeWorkerCredentialFile(home, {
    type: 'setup-token',
    access_token: 'sk-ant-oat01-SCOPE',
    scope: 'inference',
  })
  const cred = readWorkerCredentialFile(home)
  assert.equal(cred.type, 'setup-token')
  assert.equal(cred.scope, 'user:inference')
  const raw = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'credentials.json'), 'utf8'))
  assert.deepEqual(raw.claudeAiOauth.scopes, ['user:inference'])
  fs.rmSync(home, { recursive: true, force: true })
})

test('writeWorkerCredentialFile stores claudeAiOauth and reads back', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-slot-write-'))
  writeWorkerCredentialFile(home, {
    access_token: 'sk-ant-oat01-TEST',
    refresh_token: 'sk-ant-ort01-TEST',
    expires_at: 1787486457,
    email: 'slot@example.com',
    account_uuid: 'acct-1',
  })
  const cred = readWorkerCredentialFile(home)
  assert.equal(cred.access_token, 'sk-ant-oat01-TEST')
  assert.equal(cred.refresh_token, 'sk-ant-ort01-TEST')
  assert.equal(cred.email, 'slot@example.com')
  assert.equal(expiresAtToMs(cred.expires_at), 1787486457000)
  const official = path.join(home, '.claude', '.credentials.json')
  assert.equal(fs.lstatSync(official).isSymbolicLink(), true)
  assert.equal(fs.readlinkSync(official), 'credentials.json')
  fs.rmSync(home, { recursive: true, force: true })
})

test('slotUidGidFromHomeDir maps numeric slot homes', () => {
  assert.deepEqual(slotUidGidFromHomeDir('/opt/kin-gateway-rust/vms/vm-03/cli-home'), { uid: 10003, gid: 987 })
  assert.equal(slotUidGidFromHomeDir('/tmp/kin-slot-write-xxx'), null)
})

test('ensureSlotClaudeOwnership creates the worker .claude dir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-claude-own-'))
  const home = path.join(root, 'vms', 'vm-03', 'cli-home')
  fs.mkdirSync(home, { recursive: true })
  ensureSlotClaudeOwnership(home)
  assert.equal(fs.existsSync(path.join(home, '.claude')), true)
  fs.rmSync(root, { recursive: true, force: true })
})

test('persistOauthToVm writes scope from scopes array', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-scope-'))
  const vmPath = path.join(dir, 'vm-05.json')
  fs.writeFileSync(
    vmPath,
    JSON.stringify({
      id: 'vm-05',
      claude: { mode: 'oauth', scope: 'user:profile user:inference', has_access: true, has_refresh: true },
    }),
  )
  persistOauthToVm(
    vmPath,
    {
      type: 'setup-token',
      access_token: 'sk-ant-oat01-NEW',
      refresh_token: 'sk-ant-ort01-NEW',
      scopes: ['user:inference'],
      source: 'oauth-setup-token',
    },
    { acceptLiveGrant: true },
  )
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(vm.claude.mode, 'setup-token')
  assert.equal(vm.claude.scope, 'user:inference')
})

test('persistOauthToVm writes flattened oauth_account identity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-ident-'))
  const vmPath = path.join(dir, 'vm-06.json')
  fs.writeFileSync(vmPath, JSON.stringify({ id: 'vm-06', claude: { mode: 'setup-token' } }))
  persistOauthToVm(
    vmPath,
    {
      type: 'setup-token',
      access_token: 'sk-ant-oat01-ID',
      refresh_token: 'sk-ant-ort01-ID',
      oauth_account: {
        account_uuid: 'acct-persist',
        account_email: 'persist@example.com',
        organization_uuid: 'org-persist',
      },
    },
    { acceptLiveGrant: true },
  )
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(vm.claude.email, 'persist@example.com')
  assert.equal(vm.claude.account_uuid, 'acct-persist')
  assert.equal(vm.claude.org_uuid, 'org-persist')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('official setup-token persist omits refresh and marks mode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-setup-token-'))
  const vmPath = path.join(dir, 'vm-05.json')
  fs.writeFileSync(
    vmPath,
    JSON.stringify({
      id: 'vm-05',
      schedulable: false,
      schedule_disabled_reason: 'disabled',
      claude: { mode: 'oauth', has_access: true, has_refresh: true, email: 'a@b.c' },
    }),
  )
  persistOauthToVm(
    vmPath,
    {
      type: 'setup-token',
      mode: 'setup-token',
      access_token: 'sk-ant-oat01-SETUP',
      source: 'claude-setup-token',
      expires_at: Date.now() + 365 * 24 * 60 * 60 * 1000,
    },
    { acceptLiveGrant: true },
  )
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  assert.equal(vm.claude.mode, 'setup-token')
  assert.equal(vm.claude.has_access, true)
  assert.equal(vm.claude.has_refresh, false)
  assert.equal(vm.claude.source, 'claude-setup-token')
  assert.equal(vm.schedule_disabled_reason, 'disabled')

  const home = path.join(dir, 'cli-home')
  writeWorkerCredentialFile(home, {
    type: 'setup-token',
    access_token: 'sk-ant-oat01-SETUP',
    expires_at: vm.claude.expires_at,
    scope: 'user:inference',
  })
  const raw = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'credentials.json'), 'utf8'))
  assert.equal(raw.type, 'setup-token')
  assert.equal(raw.claudeAiOauth.type, 'setup-token')
  assert.ok(!Object.prototype.hasOwnProperty.call(raw.claudeAiOauth, 'refreshToken'))
  const cred = readWorkerCredentialFile(home)
  assert.equal(cred.type, 'setup-token')
  assert.equal(cred.refresh_token, '')
})
