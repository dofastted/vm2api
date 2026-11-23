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

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-sync-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const homeDir = path.join(root, 'cli-home')
  const official = path.join(homeDir, '.claude', '.credentials.json')
  const worker = path.join(homeDir, '.claude', 'credentials.json')
  return { homeDir, official, worker, exec: { homeDir, vm: { id: 'vm-01' } } }
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

test('cluster sync preserves a rotated remote grant and links it without pushing a stale panel mirror', async (context) => {
  const { homeDir, exec } = fixture(context)
  writeWorkerCredentialFile(homeDir, grant)
  const calls = []
  const result = await syncClaudeClientCredentials(exec, {
    host: {
      kind: 'node',
      afterRefresh: async () => {
        calls.push('pull')
        writeWorkerCredentialFile(homeDir, {
          ...grant,
          access_token: 'rotated-access',
          refresh_token: 'rotated-refresh',
        })
        return { pulled: true }
      },
    },
    ensureRemoteLink: async () => {
      calls.push('link')
      return { linked: true }
    },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, ['pull', 'link'])
  assert.equal(readWorkerCredentialFile(homeDir).refresh_token, 'rotated-refresh')
})

test('remote sync errors and missing remote credentials never report success or expose details', async (context) => {
  const { exec } = fixture(context)
  for (const afterRefresh of [
    async () => {
      throw new Error('/private/path panel-refresh-fixture')
    },
    async () => ({ pulled: false, reason: 'remote_missing' }),
    async () => ({ pulled: true }),
  ]) {
    const result = await syncClaudeClientCredentials(exec, {
      host: { kind: 'node', afterRefresh },
      ensureRemoteLink: async () => ({ linked: false }),
    })
    assert.equal(result.ok, false)
    assert.equal(result.status, 502)
    assert.equal(result.error.code, 'client_credential_sync_failed')
    assert.doesNotMatch(JSON.stringify(result), /private|panel-refresh-fixture/)
  }
})

const dueGrant = () => ({ ...grant, expires_at: Date.now() + 60_000 })
const unexpectedRefresh = async () => assert.fail('slot refresh must not be called')

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
  const { homeDir, official, worker, exec } = fixture(context)
  exec.vm.runtime = { type: 'kvm' }
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

test('KVM preflight refreshes via the slot guest and rechecks the saved grant', async (context) => {
  const { homeDir, official, exec } = fixture(context)
  exec.vm.runtime = { type: 'kvm' }
  writeWorkerCredentialFile(homeDir, dueGrant())
  fs.unlinkSync(official)
  fs.writeFileSync(
    official,
    JSON.stringify({
      claudeAiOauth: { accessToken: 'native-access', refreshToken: 'native-refresh', expiresAt: 9900000000000 },
    }),
  )
  let argvSeen
  const result = await prepareClaudeClientCredentials(exec, {
    refreshInSlot: (slot, op, options) =>
      runSlotOauth(slot, op, {
        ...options,
        runDocker: async (argv) => {
          argvSeen = argv
          assert.equal(fs.readlinkSync(official), 'credentials.json')
          assert.equal(readWorkerCredentialFile(homeDir).refresh_token, grant.refresh_token)
          writeWorkerCredentialFile(homeDir, { ...grant, access_token: 'new-access', refresh_token: 'new-refresh' })
          return { stdout: '{"ok":true,"status":200,"body":{"refreshed":true}}' }
        },
      }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.refreshed, true)
  assert.ok(argvSeen.includes('/usr/local/bin/kin-guest-exec'))
  assert.deepEqual(argvSeen.slice(-5), ['oauth', 'refresh', '--config', '/run/kin/worker.json', '--attempt-guard'])
  assert.equal(readWorkerCredentialFile(homeDir).refresh_token, 'new-refresh')
  assert.doesNotMatch(JSON.stringify(result), /new-access|new-refresh/)
})

test('preflight pulls the rotated remote grant before deciding whether to refresh', async (context) => {
  const { homeDir, official, exec } = fixture(context)
  writeWorkerCredentialFile(homeDir, dueGrant())
  const calls = []
  const result = await prepareClaudeClientCredentials(exec, {
    host: {
      kind: 'node',
      afterRefresh: async () => {
        calls.push('pull')
        writeWorkerCredentialFile(homeDir, { ...grant, refresh_token: 'node-rotated-refresh' })
        return { pulled: true }
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
  assert.deepEqual(calls, ['pull', 'link'])
  assert.equal(readWorkerCredentialFile(homeDir).refresh_token, 'node-rotated-refresh')
  assert.equal(fs.readlinkSync(official), 'credentials.json')
})

test('preflight never refreshes a cached grant when the authoritative remote file is missing', async (context) => {
  const { homeDir, exec } = fixture(context)
  writeWorkerCredentialFile(homeDir, dueGrant())
  const result = await prepareClaudeClientCredentials(exec, {
    host: { kind: 'node', afterRefresh: async () => ({ pulled: false, reason: 'remote_missing' }) },
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

test('a refresh-only panel credential is recovered through the slot', async (context) => {
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

test('cluster sync pushes back sanitized credentials when remote still holds legacy email', async (context) => {
  const { homeDir, worker, exec } = fixture(context)
  const calls = []
  let pushedText = ''
  const result = await syncClaudeClientCredentials(exec, {
    host: {
      kind: 'node',
      afterRefresh: async () => {
        calls.push('pull')
        fs.mkdirSync(path.dirname(worker), { recursive: true })
        fs.writeFileSync(
          worker,
          JSON.stringify({
            claudeAiOauth: {
              accessToken: grant.access_token,
              refreshToken: 'rotated-refresh',
              expiresAt: grant.expires_at * 1000,
              email: 'remote-legacy@example.com',
            },
          }),
        )
        return { pulled: true }
      },
      onImport: async () => {
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
  assert.deepEqual(calls, ['pull', 'push-sanitized', 'link'])
  assert.doesNotMatch(pushedText, /remote-legacy@example\.com|"email"/)
  assert.equal(readWorkerCredentialFile(homeDir).refresh_token, 'rotated-refresh')
})

test('preflight strips legacy email written by an older slot refresher', async (context) => {
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
