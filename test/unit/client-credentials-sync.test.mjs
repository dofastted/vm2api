import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readWorkerCredentialFile, writeWorkerCredentialFile } from '../../src/lib/oauth/oauth-credentials.mjs'
import { syncClaudeClientCredentials } from '../../src/lib/transport/go-worker-client.mjs'

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-sync-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const homeDir = path.join(root, 'cli-home')
  const official = path.join(homeDir, '.claude', '.credentials.json')
  const worker = path.join(homeDir, '.claude', 'credentials.json')
  return { homeDir, official, worker, exec: { homeDir, vm: { id: 'vm-01' } } }
}

const grant = { access_token: 'panel-access-fixture', refresh_token: 'panel-refresh-fixture', expires_at: 1900000000 }

for (const credential of [grant, { type: 'apikey', api_key: 'panel-api-fixture' }]) {
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

test('manual sync repairs native credential link without replacing the panel grant or exposing it', async (context) => {
  const { homeDir, official, worker, exec } = fixture(context)
  writeWorkerCredentialFile(homeDir, grant)
  const before = fs.readFileSync(worker, 'utf8')
  fs.unlinkSync(official)
  fs.writeFileSync(official, JSON.stringify({ claudeAiOauth: { accessToken: 'old-native', expiresAt: 9900000000000 } }))
  const result = await syncClaudeClientCredentials(exec)
  assert.equal(result.ok, true)
  assert.equal(fs.readlinkSync(official), 'credentials.json')
  assert.equal(fs.readFileSync(worker, 'utf8'), before)
  assert.equal(JSON.stringify(result).includes(grant.access_token), false)
  assert.equal(JSON.stringify(result).includes(grant.refresh_token), false)
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
