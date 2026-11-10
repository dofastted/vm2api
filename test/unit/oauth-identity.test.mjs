import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyOauthIdentity,
  CLAUDE_CLI_BOOTSTRAP_URL,
  enrichOauthIdentity,
  flattenOauthIdentity,
  oauthIdentityComplete,
} from '../../src/lib/oauth/oauth-identity.mjs'
import { normalizeOauth } from '../../src/lib/oauth/oauth-credentials.mjs'
import { liveOauthToSetupToken } from '../../src/lib/oauth/credential-mode.mjs'
import { createImportCommit } from '../../src/lib/oauth/import-commit.mjs'

test('bootstrap URL uses claude-code entrypoint without vscode fields', () => {
  assert.match(CLAUDE_CLI_BOOTSTRAP_URL, /\/api\/claude_cli\/bootstrap\?entrypoint=claude-code&model=claude-opus-5-5$/)
  assert.doesNotMatch(CLAUDE_CLI_BOOTSTRAP_URL, /vscode/)
})
test('flattenOauthIdentity reads oauth_account bootstrap shape', () => {
  assert.deepEqual(
    flattenOauthIdentity({
      oauth_account: {
        account_uuid: 'acct-1',
        account_email: 'user@example.com',
        organization_uuid: 'org-1',
      },
    }),
    {
      email: 'user@example.com',
      account_uuid: 'acct-1',
      org_uuid: 'org-1',
      subscription_type: null,
      rate_limit_tier: null,
    },
  )
})

test('flattenOauthIdentity reads token account/organization objects', () => {
  assert.deepEqual(
    flattenOauthIdentity({
      account: { uuid: 'acct-2', email_address: 'two@example.com' },
      organization: { uuid: 'org-2' },
    }),
    {
      email: 'two@example.com',
      account_uuid: 'acct-2',
      org_uuid: 'org-2',
      subscription_type: null,
      rate_limit_tier: null,
    },
  )
})

test('flattenOauthIdentity ignores empty strings', () => {
  assert.deepEqual(flattenOauthIdentity({ email: '', account_uuid: '   ', org_uuid: null }), {
    email: null,
    account_uuid: null,
    org_uuid: null,
    subscription_type: null,
    rate_limit_tier: null,
  })
})

test('flattenOauthIdentity keeps the plan from the exchange profile and text', () => {
  assert.equal(
    flattenOauthIdentity({ organization: { organization_type: 'claude_max', uuid: 'org-m' } }).subscription_type,
    'max',
  )
  assert.equal(flattenOauthIdentity({ account: { has_claude_pro: true, uuid: 'acct-p' } }).subscription_type, 'pro')
  assert.equal(flattenOauthIdentity({ text: 'Plan: Claude Max 20x' }).subscription_type, 'max')
})

test('OAuth plan uses organization entitlement before broad account flags', () => {
  assert.equal(
    flattenOauthIdentity({
      account: { has_claude_pro: true },
      organization: { organization_type: 'claude_team' },
    }).subscription_type,
    'team',
  )
  assert.equal(
    flattenOauthIdentity({ organization: { rate_limit_tier: 'default_claude_max_5x' } }).subscription_type,
    'max',
  )
  assert.equal(flattenOauthIdentity({ subscriptionType: 'free' }).subscription_type, 'free')
  assert.equal(
    flattenOauthIdentity({
      account: { has_claude_max: true },
      organization: { organization_type: 'claude_pro' },
    }).subscription_type,
    'max',
  )
  assert.equal(flattenOauthIdentity({ usage_has_fable: true, fable: { ok: true } }).subscription_type, null)
})

test('import does not manufacture subscription metadata from a scheduling tier', () => {
  const { importedCredentialFromOauth } = createImportCommit({})
  const imported = importedCredentialFromOauth({ access_token: 'access' }, { claude: { account_tier: 'max' } })
  assert.equal(imported.subscription_type, null)
})

test('enrichOauthIdentity skips fetch when identity is already complete', async () => {
  let called = 0
  const out = await enrichOauthIdentity(
    {
      access_token: 'sk-ant-oat01-HAVE',
      email: 'have@example.com',
      account_uuid: 'acct-have',
      org_uuid: 'org-have',
    },
    {
      proxyUrl: 'socks5h://127.0.0.1:1',
      fetchImpl: async () => {
        called += 1
        throw new Error('should not fetch')
      },
    },
  )
  assert.equal(called, 0)
  assert.equal(out.email, 'have@example.com')
  assert.equal(oauthIdentityComplete(out), true)
})

test('enrichOauthIdentity fetches bootstrap when helper only returned tokens', async () => {
  const seen = []
  const out = await enrichOauthIdentity(
    { access_token: 'sk-ant-oat01-NEED', refresh_token: 'sk-ant-ort01-NEED' },
    {
      proxyUrl: 'socks5h://127.0.0.1:1',
      fetchImpl: async (url, init) => {
        seen.push({ url, method: init.method, auth: init.headers.authorization })
        return {
          ok: true,
          status: 200,
          json: async () => ({
            oauth_account: {
              account_uuid: 'acct-boot',
              account_email: 'boot@example.com',
              organization_uuid: 'org-boot',
            },
          }),
        }
      },
    },
  )
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, CLAUDE_CLI_BOOTSTRAP_URL)
  assert.equal(seen[0].method, 'GET')
  assert.equal(seen[0].auth, 'Bearer sk-ant-oat01-NEED')
  assert.equal(out.email, 'boot@example.com')
  assert.equal(out.account_uuid, 'acct-boot')
  assert.equal(out.org_uuid, 'org-boot')
  assert.equal(out.refresh_token, 'sk-ant-ort01-NEED')
})

test('enrichOauthIdentity keeps tokens when bootstrap fails', async () => {
  const out = await enrichOauthIdentity(
    { access_token: 'sk-ant-oat01-KEEP', refresh_token: 'sk-ant-ort01-KEEP' },
    {
      proxyUrl: 'socks5h://127.0.0.1:1',
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
    },
  )
  assert.equal(out.access_token, 'sk-ant-oat01-KEEP')
  assert.equal(out.refresh_token, 'sk-ant-ort01-KEEP')
  assert.equal(out.email, undefined)
  assert.equal(oauthIdentityComplete(out), false)
})

test('applyOauthIdentity writes email_address together with email', () => {
  const out = applyOauthIdentity({ access_token: 't' }, { email: 'a@b.c', account_uuid: 'a', org_uuid: 'o' })
  assert.equal(out.email_address, 'a@b.c')
})

test('normalizeOauth and import commit keep nested oauth_account', () => {
  const nested = {
    access_token: 'sk-ant-oat01-NEST',
    refresh_token: 'sk-ant-ort01-NEST',
    oauth_account: {
      account_uuid: 'acct-nest',
      account_email: 'nest@example.com',
      organization_uuid: 'org-nest',
    },
  }
  const n = normalizeOauth(nested)
  assert.equal(n.email, 'nest@example.com')
  assert.equal(n.account_uuid, 'acct-nest')
  assert.equal(n.org_uuid, 'org-nest')
  const { importedCredentialFromOauth } = createImportCommit({})
  const imported = importedCredentialFromOauth({ ...nested, type: 'setup-token' }, {})
  assert.equal(imported.email, 'nest@example.com')
  assert.equal(imported.account_uuid, 'acct-nest')
  assert.equal(imported.org_uuid, 'org-nest')
  assert.equal(imported.type, 'setup-token')
})

test('explicit full-scope setup-token export stays setup-token during import', () => {
  const { importedCredentialFromOauth } = createImportCommit({})
  const imported = importedCredentialFromOauth(
    {
      type: 'setup-token',
      access_token: 'sk-ant-oat01-FULL',
      refresh_token: 'sk-ant-ort01-FULL',
      scopes: ['user:profile', 'user:inference', 'user:sessions:claude_code'],
    },
    {},
  )
  assert.equal(imported.type, 'setup-token')
  assert.deepEqual(imported.scopes, ['user:profile', 'user:inference', 'user:sessions:claude_code'])
})

test('liveOauthToSetupToken keeps flattened identity', () => {
  const out = liveOauthToSetupToken({
    access_token: 'sk-ant-oat01-LIVE',
    refresh_token: 'sk-ant-ort01-LIVE',
    oauth_account: {
      account_uuid: 'acct-live',
      account_email: 'live@example.com',
      organization_uuid: 'org-live',
    },
  })
  assert.equal(out.type, 'setup-token')
  assert.equal(out.email, 'live@example.com')
  assert.equal(out.account_uuid, 'acct-live')
  assert.equal(out.org_uuid, 'org-live')
})
