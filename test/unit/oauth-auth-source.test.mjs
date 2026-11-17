import test from 'node:test'
import assert from 'node:assert/strict'
import { OFFICIAL_CLI_VERSION } from '../../src/lib/identity/vm-identity.mjs'
import { sessionKeyToOAuth, exchangeTokenViaCookieAuth } from '../../src/lib/oauth/cookie-auth.mjs'

/**
 * `src/lib/oauth/auth.js` is local-only and git-ignored ("not part of the
 * published tree"), so a checkout without it is normal, not broken: these cases
 * skip instead of failing. A working tree that does have it gets the full
 * protocol asserted, which is what the fetchImpl seams in cookie-auth.mjs need.
 */
let auth = null
try {
  auth = await import('../../src/lib/oauth/auth.js')
} catch {
  auth = null
}
const localOnly = auth ? {} : { skip: 'src/lib/oauth/auth.js is local-only and absent from this tree' }

const ORG = '11111111-2222-4333-8444-555555555555'
const CLI_UA = `claude-cli/${OFFICIAL_CLI_VERSION} (external, cli)`

const json = (body) => ({ ok: true, status: 200, json: async () => body })

/**
 * Stands in for the provider. Records every request so the UA each stage sends
 * can be asserted, and echoes the authorize state back from the POST body the
 * way the provider does.
 */
function fakeProvider({ onAuthorize } = {}) {
  const seen = []
  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    seen.push({ url: u.replace(/\?.*/, ''), ua: init.headers?.['user-agent'], headers: init.headers || {} })
    if (u.includes('/api/organizations')) return json([{ uuid: ORG, raven_type: 'team' }])
    if (u.includes('/authorize')) {
      const sent = JSON.parse(init.body)
      const state = onAuthorize ? onAuthorize(sent) : sent.state
      return json({ redirect_uri: `https://platform.claude.com/oauth/code/callback?code=fixture-code&state=${state}` })
    }
    if (u.includes('/v1/oauth/token')) {
      return json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 28800 })
    }
    if (u.includes('bootstrap')) {
      return json({
        oauth_account: {
          account_email: 'seam@example.test',
          account_uuid: 'acct-fixture',
          organization_uuid: 'org-fixture',
        },
      })
    }
    throw new Error(`unexpected request: ${u}`)
  }
  return { fetchImpl, seen }
}

test('the local-only auth module exports the whole OAuth protocol surface', localOnly, () => {
  // It went missing from the working tree once, which left every fetchImpl seam dead.
  for (const name of [
    'resolveOrganizationUuid',
    'authorizeWithSessionKey',
    'exchangeAuthorizationCode',
    'fetchBootstrapIdentity',
    'completeAuthorizedToken',
    'sessionKeyToAuthorizedOAuth',
  ]) {
    assert.equal(typeof auth[name], 'function', `${name} must be exported`)
  }
})

test('the sessionKey seam runs the whole protocol through the injected fetch', localOnly, async () => {
  const { fetchImpl, seen } = fakeProvider()
  const cred = await sessionKeyToOAuth('sk-ant-sid-fixture', { fetchImpl, proxyUrl: '' })

  assert.equal(cred.access_token, 'fixture-access')
  assert.equal(cred.email, 'seam@example.test')
  assert.equal(cred.org_uuid, 'org-fixture')
  assert.deepEqual(
    seen.map((r) => r.url),
    [
      'https://claude.ai/api/organizations',
      `https://platform.claude.com/v1/oauth/${ORG}/authorize`,
      'https://platform.claude.com/v1/oauth/token',
      'https://api.anthropic.com/api/claude_cli/bootstrap',
    ],
  )
})

test('the CLI stages send the pinned CLI User-Agent; the cookie stages send the browser one', localOnly, async () => {
  const { fetchImpl, seen } = fakeProvider()
  await sessionKeyToOAuth('sk-ant-sid-fixture', { fetchImpl, proxyUrl: '' })

  const [orgs, authorize, token, bootstrap] = seen
  // claude.ai and the CAI authorize page are reached with the session cookie,
  // as a browser would.
  assert.match(orgs.ua, /^Mozilla\/5\.0 /)
  assert.match(authorize.ua, /^Mozilla\/5\.0 /)
  assert.equal(orgs.headers.cookie, 'sessionKey=sk-ant-sid-fixture')
  // Anything carrying the token is the CLI. `sdk-cli` is `--print`, which an
  // OAuth exchange never is, and the version follows OFFICIAL_CLI_VERSION
  // instead of a hand-synced literal that had drifted to 2.1.303.
  assert.equal(token.ua, CLI_UA)
  assert.equal(bootstrap.ua, CLI_UA)
  assert.equal(bootstrap.headers['anthropic-beta'], 'oauth-2025-04-20')
})

test('an explicit claude_version overrides the pin, and a malformed one falls back', localOnly, async () => {
  for (const [version, expected] of [
    ['2.1.400', 'claude-cli/2.1.400 (external, cli)'],
    ['not-a-version', CLI_UA],
  ]) {
    const { fetchImpl, seen } = fakeProvider()
    await auth.exchangeAuthorizationCode({
      code: 'fixture-code',
      codeVerifier: 'fixture-verifier',
      claudeVersion: version,
      fetchImpl,
    })
    assert.equal(seen.at(-1).ua, expected)
  }
})

test('the authorize state is verified before the code is spent', localOnly, async () => {
  const { fetchImpl, seen } = fakeProvider({ onAuthorize: () => 'someone-elses-state' })
  await assert.rejects(() => sessionKeyToOAuth('sk-ant-sid-fixture', { fetchImpl, proxyUrl: '' }), {
    code: 'state_mismatch',
  })
  // Refused at authorize: the token endpoint is never reached.
  assert.ok(!seen.some((r) => r.url.endsWith('/v1/oauth/token')))
})

test('an unbound slot is refused, but local egress goes direct', localOnly, async () => {
  // null/undefined proxy with no injected fetch: refuse rather than quietly
  // leaving through the host route.
  await assert.rejects(() => auth.sessionKeyToAuthorizedOAuth({ sessionKey: 'sk-ant-sid-fixture' }), {
    code: 'proxy_required',
  })
  await assert.rejects(() => auth.exchangeAuthorizationCode({ code: 'c', codeVerifier: 'v', proxyUrl: null }), {
    code: 'proxy_required',
  })
  // '' is a slot on local egress; its exit is the host default route.
  const { fetchImpl } = fakeProvider()
  const cred = await auth.sessionKeyToAuthorizedOAuth({ sessionKey: 'sk-ant-sid-fixture', proxyUrl: '', fetchImpl })
  assert.equal(cred.access_token, 'fixture-access')
})

test('the paste-code seam exchanges and bootstraps through the injected fetch', localOnly, async () => {
  const { fetchImpl, seen } = fakeProvider()
  const token = await exchangeTokenViaCookieAuth({
    code: 'fixture-code',
    codeVerifier: 'fixture-verifier',
    fetchImpl,
    proxyUrl: '',
  })
  assert.equal(token.access_token, 'fixture-access')
  assert.equal(token.email, 'seam@example.test')
  assert.deepEqual(
    seen.map((r) => r.url),
    ['https://platform.claude.com/v1/oauth/token', 'https://api.anthropic.com/api/claude_cli/bootstrap'],
  )
})

test('a refusal names its stage and never echoes the token', localOnly, async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: 'invalid_grant', hint: 'sk-ant-oat01-SECRET' }),
  })
  await assert.rejects(
    () => auth.exchangeAuthorizationCode({ code: 'c', codeVerifier: 'v', fetchImpl }),
    (err) => {
      assert.equal(err.code, 'token_exchange_failed')
      assert.ok(!err.message.includes('sk-ant-oat01-SECRET'), 'token must be redacted')
      assert.match(err.message, /\[redacted-token\]/)
      return true
    },
  )
})
