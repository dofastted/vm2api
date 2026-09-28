import test from 'node:test'
import assert from 'node:assert/strict'
import {
  sessionKeyToOAuth,
  exchangeTokenViaCookieAuth,
  classifyImportHelperOutput,
  publicImportError,
  panelImportErrorPayload,
  buildSetupTokenAuthorizeURL,
  extractOAuthCodeFromRedirect,
} from '../../src/lib/oauth/cookie-auth.mjs'
import fs from 'node:fs'
import { FULL_OAUTH_SCOPE, REDIRECT_URI, TOKEN_URL } from '../../src/lib/oauth/oauth-contract.mjs'

// auth.js is the local source of the kin-oauth-auth binary and is not in the repo.
const localAuthSkip = fs.existsSync(new URL('../../src/lib/oauth/auth.js', import.meta.url))
  ? false
  : 'src/lib/oauth/auth.js is local-only (shipped as bin/kin-oauth-auth)'

test('KIN_FAKE_SESSION_OAUTH returns deterministic creds without network', async () => {
  process.env.KIN_FAKE_SESSION_OAUTH = '1'
  const cred = await sessionKeyToOAuth('sk-ant-sid-test-aaaaaaaa')
  assert.equal(cred.source, 'KIN_FAKE_SESSION_OAUTH')
  assert.equal(cred.email, 'fake-oauth@kin.test')
  assert.match(cred.access_token, /^sk-ant-oat01-FAKE/)
  assert.ok(cred.expires_at > Math.floor(Date.now() / 1000))
  delete process.env.KIN_FAKE_SESSION_OAUTH
})

test('fake inference scope is setup-token', async () => {
  process.env.KIN_FAKE_SESSION_OAUTH = '1'
  const cred = await sessionKeyToOAuth('sk-ant-sid-test-aaaaaaaa', { scope: 'inference' })
  assert.equal(cred.type, 'setup-token')
  assert.equal(cred.mode, 'setup-token')
  assert.equal(cred.scope, FULL_OAUTH_SCOPE)
  delete process.env.KIN_FAKE_SESSION_OAUTH
})

test('fake branch still rejects non-sid keys', async () => {
  process.env.KIN_FAKE_SESSION_OAUTH = '1'
  await assert.rejects(() => sessionKeyToOAuth('not-a-sid'), /sk-ant-sid/)
  delete process.env.KIN_FAKE_SESSION_OAUTH
})

test('sessionKeyToOAuth requires a non-empty VM SOCKS5 in production', async () => {
  await assert.rejects(
    () => sessionKeyToOAuth('sk-ant-sid01-testaaaaaaaa', { proxyUrl: '' }),
    (e) => e.code === 'proxy_required',
  )
})

test('sessionKeyToOAuth on local egress hops without PROXY_URL', { skip: localAuthSkip }, async () => {
  const seen = []
  const cred = await sessionKeyToOAuth('sk-ant-sid01-testaaaaaaaa', {
    proxyUrl: '',
    fetchImpl: makeStrictOAuthFetch(seen),
  })
  assert.equal(cred.access_token, 'sk-ant-oat01-token')
  assert.equal(seen.length, 5)
})

test('sessionKeyToOAuth performs strict org authorize token bootstrap grove flow', {
  skip: localAuthSkip,
}, async () => {
  const seen = []
  const cred = await sessionKeyToOAuth('sk-ant-sid01-testaaaaaaaa', {
    proxyUrl: 'socks5://127.0.0.1:1080',
    scope: 'inference',
    fetchImpl: makeStrictOAuthFetch(seen),
  })
  assert.equal(cred.type, 'setup-token')
  assert.equal(cred.mode, 'setup-token')
  assert.equal(cred.scope, FULL_OAUTH_SCOPE)
  assert.equal(cred.email, 'sk@example.com')
  assert.equal(cred.account_uuid, 'acct-sk')
  assert.equal(cred.org_uuid, 'org-sk')
  assert.equal(cred.refresh_token, 'sk-ant-ort01-token')
  assert.deepEqual(
    seen.map((r) => r.stage),
    ['orgs', 'authorize', 'token', 'bootstrap', 'grove'],
  )
})

test('sessionKeyToOAuth maps stale authorize response', { skip: localAuthSkip }, async () => {
  await assert.rejects(
    () =>
      sessionKeyToOAuth('sk-ant-sid01-testaaaaaaaa', {
        proxyUrl: 'socks5h://127.0.0.1:1',
        fetchImpl: makeStrictOAuthFetch([], {
          authorizeStatus: 403,
          authorizeBody: { error: 'Session is not fresh enough' },
        }),
      }),
    (e) => e.code === 'session_stale_relogin',
  )
})

test('exchangeTokenViaCookieAuth posts token then requires bootstrap and Grove', { skip: localAuthSkip }, async () => {
  const seen = []
  const tok = await exchangeTokenViaCookieAuth({
    code: 'abc#state-1',
    codeVerifier: 'ver',
    proxyUrl: 'socks5h://127.0.0.1:1',
    fetchImpl: makeStrictOAuthFetch(seen, { tokenOnly: true }),
  })
  assert.equal(tok.access_token, 'sk-ant-oat01-token')
  assert.deepEqual(
    seen.map((r) => r.stage),
    ['token', 'bootstrap', 'grove'],
  )
})

test('exchangeTokenViaCookieAuth reads streamed token responses', { skip: localAuthSkip }, async () => {
  const seen = []
  const tok = await exchangeTokenViaCookieAuth({
    code: 'abc#state-1',
    codeVerifier: 'ver',
    proxyUrl: 'socks5h://127.0.0.1:1',
    fetchImpl: makeStrictOAuthFetch(seen, { tokenOnly: true, tokenStream: true }),
  })
  assert.equal(tok.access_token, 'sk-ant-oat01-token')
})

test('exchangeTokenViaCookieAuth falls back when platform Grove path is unavailable', {
  skip: localAuthSkip,
}, async () => {
  const seen = []
  await exchangeTokenViaCookieAuth({
    code: 'abc#state-1',
    codeVerifier: 'ver',
    proxyUrl: 'socks5h://127.0.0.1:1',
    fetchImpl: makeStrictOAuthFetch(seen, { tokenOnly: true, groveStatus: 404 }),
  })
  assert.deepEqual(
    seen.map((r) => r.stage),
    ['token', 'bootstrap', 'grove', 'grove_fallback'],
  )
})

test('exchangeTokenViaCookieAuth redacts failed token bodies', { skip: localAuthSkip }, async () => {
  await assert.rejects(
    () =>
      exchangeTokenViaCookieAuth({
        code: 'abc',
        codeVerifier: 'ver',
        proxyUrl: '',
        fetchImpl: makeStrictOAuthFetch([], {
          tokenOnly: true,
          tokenStatus: 400,
          tokenBody: { error: 'bad', access_token: 'sk-ant-oat01-SECRET' },
        }),
      }),
    (e) => /\[redacted-token\]/.test(e.message) && !/SECRET/.test(e.message),
  )
})

test('authorize 403 session freshness is not reported as Cloudflare', () => {
  const raw = 'authorize failed: 403 Session is not fresh enough to authorize'
  assert.equal(classifyImportHelperOutput(raw), 'session_stale_relogin')
  assert.match(publicImportError(raw), /不够新/)
  assert.doesNotMatch(publicImportError(raw), /Cloudflare|Just a moment/)
})

test('SOCKS5 user rejection is a proxy auth error, not a sessionKey failure', () => {
  const raw =
    '[1/5] GET /api/organizations impersonate=chrome146 orgs request failed: ProxyError: Failed to perform, curl: (97) User was rejected by the SOCKS5 server (1 1).. See https://curl.se/libcurl/c/libcurl-errors.html first for more details.'
  assert.equal(classifyImportHelperOutput(raw), 'proxy_auth_rejected')
  const payload = panelImportErrorPayload({ message: raw })
  assert.equal(payload.status, 400)
  assert.equal(payload.error.code, 'proxy_auth_rejected')
  assert.match(payload.error.message, /SOCKS5 拒绝了用户名或密码/)
  assert.doesNotMatch(payload.error.message, /sessionKey 不够新|Cloudflare/)
})

test('panel import catch maps helper codes without leaking ReferenceError', () => {
  const stale = panelImportErrorPayload({
    message: 'Session is not fresh enough to authorize',
  })
  assert.equal(stale.status, 400)
  assert.equal(stale.error.code, 'session_stale_relogin')
  assert.match(stale.error.message, /不够新/)

  const coded = panelImportErrorPayload({ code: 'session_stale_relogin', message: 'Session is not fresh enough' })
  assert.equal(coded.status, 400)
})

test('setup-token CAI URL helper requests full OAuth scope', () => {
  const url = buildSetupTokenAuthorizeURL('st', 'ch')
  assert.match(url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true/)
  assert.match(url, /client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e/)
  assert.ok(url.includes(encodeURIComponent(FULL_OAUTH_SCOPE).replace(/%20/g, '+')))
})

test('extractOAuthCodeFromRedirect reads callback query', () => {
  const got = extractOAuthCodeFromRedirect('https://platform.claude.com/oauth/code/callback?code=abc123&state=xyz')
  assert.equal(got.code, 'abc123')
  assert.equal(got.state, 'xyz')
  assert.equal(extractOAuthCodeFromRedirect({ redirect_uri: 'https://x.test/?code=tok#state=s' }).code, 'tok')
  assert.equal(extractOAuthCodeFromRedirect('https://x.test/nope'), null)
})

test('authorize_no_code is a 400 not Cloudflare', () => {
  assert.equal(classifyImportHelperOutput('authorize_no_code login_redirect'), 'authorize_no_code')
  assert.match(publicImportError('authorize_no_code login_redirect'), /CAI 授权页/)
  const payload = panelImportErrorPayload({ code: 'authorize_no_code', message: 'authorize_no_code' })
  assert.equal(payload.status, 400)
  assert.equal(payload.error.code, 'authorize_no_code')
})

function response(status, body, stream = false) {
  const text = JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    ...(stream
      ? {
          body: (async function* () {
            yield Buffer.from(text)
          })(),
        }
      : { text: async () => text }),
  }
}

function makeStrictOAuthFetch(seen, opts = {}) {
  return async (url, init = {}) => {
    const headers = init.headers || {}
    if (url === 'https://claude.ai/api/organizations') {
      seen.push({ stage: 'orgs' })
      assert.equal(init.method, 'GET')
      assert.match(headers.cookie || headers.Cookie || '', /sessionKey=sk-ant-sid01-testaaaaaaaa/)
      assert.match(headers['user-agent'] || headers['User-Agent'] || '', /Chrome\/146\.0\.0\.0/)
      return response(200, [{ uuid: 'org-sk', name: 'Team', raven_type: 'team' }])
    }
    if (url === 'https://platform.claude.com/v1/oauth/org-sk/authorize') {
      seen.push({ stage: 'authorize' })
      const body = JSON.parse(init.body)
      assert.equal(init.method, 'POST')
      assert.equal(headers['content-type'], 'application/json')
      assert.match(headers.cookie || headers.Cookie || '', /sessionKey=sk-ant-sid01-testaaaaaaaa/)
      assert.match(headers['user-agent'] || headers['User-Agent'] || '', /Chrome\/146\.0\.0\.0/)
      assert.equal(body.response_type, 'code')
      assert.equal(body.client_id, '9d1c250a-e61b-44d9-88ed-5944d1962f5e')
      assert.equal(body.redirect_uri, REDIRECT_URI)
      assert.equal(body.scope, FULL_OAUTH_SCOPE)
      assert.equal(body.code_challenge_method, 'S256')
      assert.ok(body.code_challenge)
      assert.ok(body.state)
      assert.equal(Object.prototype.hasOwnProperty.call(body, 'organization_uuid'), false)
      const status = opts.authorizeStatus || 200
      if (status >= 400) return response(status, opts.authorizeBody || { error: 'authorize failed' })
      return response(200, { redirect_uri: `${REDIRECT_URI}?code=auth-code&state=${body.state}` })
    }
    if (url === TOKEN_URL) {
      seen.push({ stage: 'token' })
      const body = JSON.parse(init.body)
      assert.equal(init.method, 'POST')
      assert.equal(headers['user-agent'] || headers['User-Agent'], 'claude-cli/2.1.284 (external, sdk-cli)')
      assert.equal(headers['x-app'], 'cli')
      assert.equal(body.grant_type, 'authorization_code')
      assert.equal(body.redirect_uri, REDIRECT_URI)
      assert.equal(body.client_id, '9d1c250a-e61b-44d9-88ed-5944d1962f5e')
      assert.ok(body.code_verifier)
      assert.equal(Object.prototype.hasOwnProperty.call(body, 'expires_in'), false)
      const status = opts.tokenStatus || 200
      if (status >= 400) return response(status, opts.tokenBody || { error: 'bad token' })
      return response(
        200,
        {
          access_token: 'sk-ant-oat01-token',
          refresh_token: 'sk-ant-ort01-token',
          expires_in: 3600,
          scope: FULL_OAUTH_SCOPE,
        },
        opts.tokenStream === true,
      )
    }
    if (url === 'https://api.anthropic.com/api/claude_cli/bootstrap?entrypoint=claude-vscode&model=claude-opus-5') {
      seen.push({ stage: 'bootstrap' })
      assert.equal(init.method, 'GET')
      assert.equal(headers['user-agent'], 'claude-cli/2.1.284 (external, sdk-cli)')
      assert.equal(headers['x-app'], 'cli')
      assert.equal(headers['anthropic-beta'], 'oauth-2025-04-20')
      assert.equal(headers.authorization, 'Bearer sk-ant-oat01-token')
      return response(200, {
        oauth_account: {
          account_uuid: 'acct-sk',
          account_email: 'sk@example.com',
          organization_uuid: 'org-sk',
        },
      })
    }
    if (url === 'https://platform.claude.com/api/oauth/account/settings') {
      seen.push({ stage: 'grove' })
      assert.equal(init.method, 'PATCH')
      assert.equal(headers['user-agent'], 'claude-cli/2.1.284 (external, sdk-cli)')
      assert.deepEqual(JSON.parse(init.body), { grove_enabled: true })
      if (opts.groveStatus) return response(opts.groveStatus, { error: 'unsupported path' })
      return response(200, { ok: true })
    }
    if (url === 'https://api.anthropic.com/api/oauth/account/settings') {
      seen.push({ stage: 'grove_fallback' })
      assert.equal(init.method, 'PATCH')
      assert.deepEqual(JSON.parse(init.body), { grove_enabled: true })
      return response(200, { ok: true })
    }
    throw new Error(`unexpected fetch ${url}`)
  }
}
