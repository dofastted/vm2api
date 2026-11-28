import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readWorkerCredentialFile, writeWorkerCredentialFile } from '../../src/lib/oauth/oauth-credentials.mjs'
import {
  prepareClaudeClientCredentials,
  syncClaudeClientCredentials,
} from '../../src/lib/transport/go-worker-client.mjs'
import { runSlotOauth } from '../../src/lib/transport/slot-oauth.mjs'

function fixture(context, extraVm = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-sync-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const homeDir = path.join(root, 'cli-home')
  const official = path.join(homeDir, '.claude', '.credentials.json')
  const worker = path.join(homeDir, '.claude', 'credentials.json')
  return {
    homeDir,
    official,
    worker,
    exec: { homeDir, vm: { id: 'vm-01', proxy: { id: 'px-local', kind: 'local' }, ...extraVm } },
  }
}

const grant = { access_token: 'panel-access-fixture', refresh_token: 'panel-refresh-fixture', expires_at: 1900000000 }
const setupGrant = { ...grant, type: 'setup-token', scopes: ['user:inference', 'user:profile'] }

for (const credential of [grant, setupGrant, { type: 'apikey', api_key: 'panel-api-fixture' }]) {
  test(`explicit ${credential.type || 'oauth'} import replaces a newer loose native grant`, (context) => {
    const { homeDir, official, worker } = fixture(context)
    fs.mkdirSync(path.dirname(official), { recursive: true })
    fs.writeFileSync(
      official,
      JSON.stringify({
        claudeAiOauth: { accessToken: 'old-native', refreshToken: 'old-refresh', expiresAt: 9900000000000 },
      }),
    )
    writeWorkerCredentialFile(homeDir, credential)
    assert.equal(readWorkerCredentialFile(homeDir).access_token, credential.access_token || credential.api_key)
    assert.equal(fs.readlinkSync(official), 'credentials.json')
    assert.equal(fs.readFileSync(official, 'utf8'), fs.readFileSync(worker, 'utf8'))
  })
}

test('manual sync repairs native credential link without replacing the setup-token grant or exposing it', async (context) => {
  const { homeDir, official, worker, exec } = fixture(context)
  writeWorkerCredentialFile(homeDir, setupGrant)
  const before = fs.readFileSync(worker, 'utf8')
  fs.unlinkSync(official)
  fs.writeFileSync(official, JSON.stringify({ claudeAiOauth: { accessToken: 'old-native', expiresAt: 9900000000000 } }))
  const result = await syncClaudeClientCredentials(exec)
  assert.equal(result.ok, true)
  assert.equal(fs.readlinkSync(official), 'credentials.json')
  assert.equal(fs.readFileSync(worker, 'utf8'), before)
  assert.equal(result.credential.type, 'setup-token')
  assert.equal(result.credential.has_refresh, true)
  assert.equal(JSON.stringify(result).includes(setupGrant.access_token), false)
  assert.equal(JSON.stringify(result).includes(setupGrant.refresh_token), false)
})

test('sync requires an imported panel credential', async (context) => {
  const { exec } = fixture(context)
  const result = await syncClaudeClientCredentials(exec)
  assert.equal(result.status, 409)
  assert.equal(result.error.code, 'credential_required')
})

test('cluster sync one-way pushes authoritative panel credentials and verifies the remote symlink without pulling', async (context) => {
  const { homeDir, exec } = fixture(context)
  writeWorkerCredentialFile(homeDir, grant)
  const calls = []
  const result = await syncClaudeClientCredentials(exec, {
    host: {
      kind: 'node',
      afterRefresh: async () => assert.fail('Panel SSOT must never pull credentials from a remote node'),
      syncCredentials: async () => {
        calls.push('push')
        return { pushed: true }
      },
    },
    ensureRemoteLink: async () => {
      calls.push('link')
      return { linked: true }
    },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, ['push', 'link'])
  assert.equal(readWorkerCredentialFile(homeDir).refresh_token, grant.refresh_token)
})

test('remote sync errors never report success or expose details', async (context) => {
  const { homeDir, exec } = fixture(context)
  writeWorkerCredentialFile(homeDir, grant)
  for (const [syncCredentials, ensureRemoteLink] of [
    [
      async () => {
        throw new Error('/private/path panel-refresh-fixture')
      },
      async () => ({ linked: true }),
    ],
    [async () => ({ pushed: true }), async () => ({ linked: false })],
  ]) {
    const result = await syncClaudeClientCredentials(exec, {
      host: { kind: 'node', syncCredentials },
      ensureRemoteLink,
    })
    assert.equal(result.ok, false)
    assert.equal(result.status, 502)
    assert.equal(result.error.code, 'client_credential_sync_failed')
    assert.doesNotMatch(JSON.stringify(result), /private|panel-refresh-fixture/)
  }
})

const dueGrant = () => ({ ...grant, expires_at: Date.now() + 60_000 })
const unexpectedRefresh = async () => assert.fail('panel refresh must not be called')

test('preflight never adopts a loose native credential in an empty panel slot', async (context) => {
  const { official, worker, exec } = fixture(context)
  fs.mkdirSync(path.dirname(official), { recursive: true })
  const loose = JSON.stringify({ claudeAiOauth: { accessToken: 'native-access', refreshToken: 'native-refresh' } })
  fs.writeFileSync(official, loose)
  const result = await prepareClaudeClientCredentials(exec, { refreshInSlot: unexpectedRefresh })
  assert.equal(result.status, 409)
  assert.equal(result.error.code, 'credential_required')
  assert.equal(fs.existsSync(worker), false)
  assert.equal(fs.readFileSync(official, 'utf8'), loose)
})

test('KVM preflight repairs absolute host aliases to the guest-relative path', async (context) => {
  const { homeDir, official, worker, exec } = fixture(context, { runtime: { type: 'kvm' } })
  writeWorkerCredentialFile(homeDir, grant)
  const originalMode = fs.statSync(worker).mode & 0o777
  fs.unlinkSync(official)
  fs.symlinkSync(worker, official)
  const result = await prepareClaudeClientCredentials(exec, { refreshInSlot: unexpectedRefresh })
  assert.equal(result.ok, true)
  assert.equal(result.refreshed, false)
  assert.equal(fs.readlinkSync(official), 'credentials.json')
  assert.equal(fs.readFileSync(official, 'utf8'), fs.readFileSync(worker, 'utf8'))
  assert.equal(fs.statSync(worker).mode & 0o777, originalMode)
})

test('KVM preflight refreshes on the control plane via panel kin-worker and one-way projects to the slot', async (context) => {
  const { homeDir, official, exec } = fixture(context, { runtime: { type: 'kvm' }, kernel: 'crag-debian13' })
  writeWorkerCredentialFile(homeDir, dueGrant())
  fs.unlinkSync(official)
  fs.writeFileSync(
    official,
    JSON.stringify({
      claudeAiOauth: { accessToken: 'native-access', refreshToken: 'native-refresh', expiresAt: 9900000000000 },
    }),
  )
  let argvSeen
  let syncedCount = 0
  const host = {
    kind: 'local',
    syncCredentials: async () => {
      syncedCount += 1
      return { pushed: true }
    },
  }
  const result = await prepareClaudeClientCredentials(exec, {
    host,
    refreshInSlot: (slot, op, options) =>
      runSlotOauth(slot, op, {
        ...options,
        host,
        runWorker: async (argv) => {
          argvSeen = argv
          assert.equal(fs.readlinkSync(official), 'credentials.json')
          assert.equal(readWorkerCredentialFile(homeDir).refresh_token, grant.refresh_token)
          writeWorkerCredentialFile(homeDir, { ...grant, access_token: 'new-access', refresh_token: 'new-refresh' })
          return { code: 0, stdout: '{"ok":true,"status":200,"body":{"refreshed":true}}', stderr: '' }
        },
      }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.refreshed, true)
  assert.equal(argvSeen[0], 'oauth')
  assert.equal(argvSeen[1], 'refresh')
  assert.equal(argvSeen[2], '--config')
  assert.equal(argvSeen.includes('--attempt-guard'), true)
  assert.equal(argvSeen.includes('/usr/local/bin/kin-guest-exec'), false)
  assert.ok(syncedCount >= 1)
  assert.equal(readWorkerCredentialFile(homeDir).refresh_token, 'new-refresh')
  assert.doesNotMatch(JSON.stringify(result), /new-access|new-refresh/)
})

test('cluster preflight pushes fresh panel credentials without calling afterRefresh or refreshing', async (context) => {
  const { homeDir, official, exec } = fixture(context)
  writeWorkerCredentialFile(homeDir, grant)
  const calls = []
  const result = await prepareClaudeClientCredentials(exec, {
    host: {
      kind: 'node',
      afterRefresh: async () => assert.fail('Panel SSOT preflight must never pull from node'),
      syncCredentials: async () => {
        calls.push('push')
        return { pushed: true }
      },
    },
    ensureRemoteLink: async () => {
      calls.push('link')
      return { linked: true }
    },
    refreshInSlot: unexpectedRefresh,
  })
  assert.equal(result.ok, true)
  assert.equal(result.refreshed, false)
  assert.deepEqual(calls, ['push', 'link'])
  assert.equal(readWorkerCredentialFile(homeDir).refresh_token, grant.refresh_token)
  assert.equal(fs.readlinkSync(official), 'credentials.json')
})

test('cluster preflight returns credential_required when panel has no credential', async (context) => {
  const { exec } = fixture(context)
  const result = await prepareClaudeClientCredentials(exec, {
    host: {
      kind: 'node',
      syncCredentials: async () => assert.fail('must not push when panel credential is missing'),
    },
    ensureRemoteLink: async () => assert.fail('cannot link a missing credential'),
    refreshInSlot: unexpectedRefresh,
  })
  assert.equal(result.status, 409)
  assert.equal(result.error.code, 'credential_required')
})

test('preflight fails closed on unsuccessful refresh or an unchanged stale grant', async (context) => {
  const { homeDir, worker, exec } = fixture(context)
  writeWorkerCredentialFile(homeDir, dueGrant())
  const before = fs.readFileSync(worker, 'utf8')
  const fatal = async () => ({ ok: false, body: { error: { code: 'invalid_grant', message: grant.refresh_token } } })
  const transport = async () => {
    throw new Error(grant.access_token)
  }
  const noWrite = async () => ({ ok: true, body: { refreshed: true, expires_at: grant.expires_at } })
  for (const [refreshInSlot, expectedClass, expectedCode] of [
    [fatal, 'fatal', 'invalid_grant'],
    [transport, 'retryable', undefined],
    [noWrite, 'retryable', undefined],
  ]) {
    const result = await prepareClaudeClientCredentials(exec, { refreshInSlot })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'client_credential_stale')
    assert.equal(result.refresh_class, expectedClass)
    assert.equal(result.error.refresh_code, expectedCode)
    assert.doesNotMatch(JSON.stringify(result), /panel-(access|refresh)-fixture/)
    assert.equal(fs.readFileSync(worker, 'utf8'), before)
  }
})

test('concurrent preflights refresh a due grant only once', async (context) => {
  const { homeDir, exec } = fixture(context)
  writeWorkerCredentialFile(homeDir, dueGrant())
  let refreshes = 0
  const refreshInSlot = async () => {
    refreshes++
    writeWorkerCredentialFile(homeDir, grant)
    return { ok: true, body: { refreshed: true } }
  }
  const results = await Promise.all([
    prepareClaudeClientCredentials(exec, { refreshInSlot }),
    prepareClaudeClientCredentials(exec, { refreshInSlot }),
  ])
  assert.equal(refreshes, 1)
  assert.deepEqual(
    results.map(({ ok, refreshed }) => [ok, refreshed]),
    [
      [true, true],
      [true, false],
    ],
  )
})

test('preflight does not refresh API keys or unexpired official setup tokens', async (context) => {
  const { homeDir, exec } = fixture(context)
  for (const credential of [
    { type: 'apikey', api_key: 'panel-api-fixture' },
    { type: 'official-setup-token', access_token: 'official-oat', expires_at: Date.now() + 60_000 },
  ]) {
    writeWorkerCredentialFile(homeDir, credential)
    const result = await prepareClaudeClientCredentials(exec, { refreshInSlot: unexpectedRefresh })
    assert.equal(result.ok, true)
    assert.equal(result.refreshed, false)
    assert.equal(result.credential.mode, credential.type)
  }
})

test('a refresh-only panel credential is recovered through the panel refresher', async (context) => {
  const { homeDir, exec, worker } = fixture(context)
  fs.mkdirSync(path.dirname(worker), { recursive: true })
  fs.writeFileSync(worker, JSON.stringify({ claudeAiOauth: { refreshToken: grant.refresh_token } }))
  const result = await prepareClaudeClientCredentials(exec, {
    refreshInSlot: async () => {
      writeWorkerCredentialFile(homeDir, grant)
      return { ok: true, body: { refreshed: true } }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.credential.has_access, true)
})

test('sync strips legacy email from local credentials and excludes email from summary', async (context) => {
  const { homeDir, official, worker, exec } = fixture(context)
  fs.mkdirSync(path.dirname(worker), { recursive: true })
  fs.writeFileSync(
    worker,
    JSON.stringify({
      type: 'oauth',
      email: 'top@example.com',
      claudeAiOauth: {
        accessToken: grant.access_token,
        refreshToken: grant.refresh_token,
        expiresAt: grant.expires_at * 1000,
        email: 'legacy@example.com',
        emailAddress: 'legacy-addr@example.com',
        email_address: 'legacy-snake@example.com',
        accountUuid: 'acct-1',
        orgUuid: 'org-1',
      },
    }),
  )
  const result = await syncClaudeClientCredentials(exec)
  assert.equal(result.ok, true)
  assert.equal(fs.readlinkSync(official), 'credentials.json')
  const text = fs.readFileSync(worker, 'utf8')
  assert.doesNotMatch(text, /example\.com|"email"|emailAddress|email_address/)
  const saved = JSON.parse(text)
  assert.equal(saved.claudeAiOauth.accessToken, grant.access_token)
  assert.equal(saved.claudeAiOauth.refreshToken, grant.refresh_token)
  assert.equal(saved.claudeAiOauth.accountUuid, 'acct-1')
  assert.equal(saved.claudeAiOauth.orgUuid, 'org-1')
  assert.equal(Object.prototype.hasOwnProperty.call(result.credential, 'email'), false)
  assert.equal(JSON.stringify(result).includes('example.com'), false)
})

test('cluster sync strips legacy email on the panel before one-way pushing to the node', async (context) => {
  const { homeDir, worker, exec } = fixture(context)
  fs.mkdirSync(path.dirname(worker), { recursive: true })
  fs.writeFileSync(
    worker,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: grant.access_token,
        refreshToken: 'panel-refresh',
        expiresAt: grant.expires_at * 1000,
        email: 'panel-legacy@example.com',
      },
    }),
  )
  const calls = []
  let pushedText = ''
  const result = await syncClaudeClientCredentials(exec, {
    host: {
      kind: 'node',
      syncCredentials: async () => {
        calls.push('push-sanitized')
        pushedText = fs.readFileSync(worker, 'utf8')
        return { pushed: true }
      },
    },
    ensureRemoteLink: async () => {
      calls.push('link')
      return { linked: true }
    },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, ['push-sanitized', 'link'])
  assert.doesNotMatch(pushedText, /panel-legacy@example\.com|"email"/)
  assert.equal(readWorkerCredentialFile(homeDir).refresh_token, 'panel-refresh')
})

test('preflight strips legacy email written by an older refresher before projecting', async (context) => {
  const { homeDir, worker, exec } = fixture(context)
  writeWorkerCredentialFile(homeDir, dueGrant())
  const result = await prepareClaudeClientCredentials(exec, {
    refreshInSlot: async () => {
      fs.chmodSync(worker, 0o600)
      fs.writeFileSync(
        worker,
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'refreshed-access',
            refreshToken: 'refreshed-refresh',
            expiresAt: grant.expires_at * 1000,
            email: 'old-worker@example.com',
          },
        }),
      )
      return { ok: true, body: { refreshed: true } }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.refreshed, true)
  assert.doesNotMatch(fs.readFileSync(worker, 'utf8'), /old-worker@example\.com|"email"/)
  assert.equal(Object.prototype.hasOwnProperty.call(result.credential, 'email'), false)
})
