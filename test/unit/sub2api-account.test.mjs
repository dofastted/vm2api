import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isSub2apiAccountExport,
  pickSub2apiAccount,
  sub2apiAccountToOauth,
  oauthToSub2apiExport,
  parseCredentialEdit,
} from '../../src/lib/oauth/sub2api-account.mjs'

const exportDoc = {
  exported_at: '2026-08-23T12:00:06Z',
  proxies: [{ host: '10.1.2.3', port: 5580 }],
  accounts: [
    {
      name: 'claude-pro-2',
      platform: 'anthropic',
      type: 'oauth',
      credentials: {
        access_token: 'sk-ant-oat01-TEST',
        refresh_token: 'sk-ant-ort01-TEST',
        expires_at: 1787486457,
        email_address: 'user@example.com',
        account_uuid: 'acct-1',
        org_uuid: 'org-1',
        scope: 'user:inference user:profile user:sessions:claude_code',
      },
      extra: {
        account_uuid: 'acct-extra',
        email_address: 'extra@example.com',
        claude_environment_profile_pool: {
          slots: [{ environment: 'windows', profile: { device_id: 'win-device', client_version: '2.1.191' } }],
        },
      },
    },
  ],
}

test('detects account exports and ignores token-less wrappers', () => {
  assert.equal(isSub2apiAccountExport(exportDoc), true)
  assert.equal(isSub2apiAccountExport(exportDoc.accounts[0]), true)
  assert.equal(isSub2apiAccountExport({ vm_id: 'vm-30', access_token: 'x' }), false)
  assert.equal(isSub2apiAccountExport({ credentials: {} }), false)
})

test('transcribes OAuth only — no Windows device profile', () => {
  const oauth = sub2apiAccountToOauth(exportDoc)
  assert.equal(oauth.access_token, 'sk-ant-oat01-TEST')
  assert.equal(oauth.refresh_token, 'sk-ant-ort01-TEST')
  assert.equal(oauth.expires_at, 1787486457)
  assert.equal(oauth.email, 'user@example.com')
  assert.equal(oauth.account_uuid, 'acct-1')
  assert.equal(oauth.org_uuid, 'org-1')
  assert.deepEqual(oauth.scopes, ['user:inference', 'user:profile', 'user:sessions:claude_code'])
  assert.equal(oauth.source, 'sub2api-account-export')
  assert.equal(oauth.device_id, undefined)
  assert.equal(pickSub2apiAccount(exportDoc).name, 'claude-pro-2')
})

test('oauthToSub2apiExport round-trips through parseCredentialEdit', () => {
  const exported = oauthToSub2apiExport(
    { id: 'vm-01', name: 'slot-01', max_concurrency: 4, email: 'user@example.com' },
    {
      access_token: 'sk-ant-oat01-TEST',
      refresh_token: 'sk-ant-ort01-TEST',
      expires_at: 1787486457000,
      email: 'user@example.com',
      account_uuid: 'acct-1',
      org_uuid: 'org-1',
      scope: 'user:inference user:profile',
    },
    { now: new Date('2026-08-26T06:00:00.000Z') },
  )
  assert.equal(exported.type, 'sub2api-data')
  assert.equal(exported.version, 1)
  assert.equal(exported.exported_at, '2026-08-26T06:00:00.000Z')
  assert.equal(exported.accounts[0].name, 'slot-01')
  assert.equal(exported.accounts[0].platform, 'anthropic')
  assert.equal(exported.accounts[0].type, 'oauth')
  assert.equal(exported.accounts[0].concurrency, 4)
  assert.equal(exported.accounts[0].credentials.expires_at, 1787486457)
  assert.equal(isSub2apiAccountExport(exported), true)
  const parsed = parseCredentialEdit(exported)
  assert.equal(parsed.access_token, 'sk-ant-oat01-TEST')
  assert.equal(parsed.refresh_token, 'sk-ant-ort01-TEST')
  assert.equal(parsed.expires_at, 1787486457)
  assert.equal(parsed.email, 'user@example.com')
  assert.equal(parsed.account_uuid, 'acct-1')
  assert.equal(parseCredentialEdit({ export: exported }).access_token, 'sk-ant-oat01-TEST')
  assert.equal(parseCredentialEdit({ access_token: 'sk-ant-oat01-RAW' }).access_token, 'sk-ant-oat01-RAW')
  assert.equal(parseCredentialEdit({ credentials: {} }), null)
})

test('console API key export round-trips as apikey', () => {
  const exported = oauthToSub2apiExport(
    { id: 'vm-08', name: 'console-slot', claude: { mode: 'apikey' } },
    { type: 'apikey', api_key: 'sk-ant-api03-TEST', access_token: 'sk-ant-api03-TEST' },
    { now: new Date('2026-08-27T00:00:00.000Z') },
  )
  assert.equal(exported.accounts[0].type, 'apikey')
  assert.equal(exported.accounts[0].credentials.api_key, 'sk-ant-api03-TEST')
  assert.equal(exported.accounts[0].credentials.access_token, undefined)
  const parsed = parseCredentialEdit(exported)
  assert.equal(parsed.mode, 'apikey')
  assert.equal(parsed.api_key, 'sk-ant-api03-TEST')
})
