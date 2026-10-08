import test from 'node:test'
import assert from 'node:assert/strict'
import {
  generateAuthUrl,
  exchangeAuthCode,
  peekAuthUrlSession,
  resetAuthUrlSessions,
  buildAuthorizationURL,
  CLIENT_ID,
  AUTHORIZE_URL,
  REDIRECT_URI,
  SCOPE_OAUTH,
  OAUTH_FLAVORS,
} from '../../src/lib/oauth/oauth-auth-url.mjs'

test('generateAuthUrl refuses an unbound VM but accepts local egress as direct', () => {
  resetAuthUrlSessions()
  assert.throws(() => generateAuthUrl({}), /vm_id required/)
  assert.throws(() => generateAuthUrl({ vmId: 'vm-01' }), /SOCKS5/)
  assert.throws(() => generateAuthUrl({ vmId: 'vm-01', proxyUrl: null }), /SOCKS5/)
  const out = generateAuthUrl({ vmId: 'vm-01', proxyUrl: '' })
  assert.equal(peekAuthUrlSession(out.session_id).proxyUrl, '')
})

test('generateAuthUrl builds Claude authorize URL and stores PKCE', () => {
  resetAuthUrlSessions()
  const out = generateAuthUrl({ vmId: 'vm-01', proxyUrl: 'socks5h://127.0.0.1:1080' })
  assert.match(out.auth_url, new RegExp('^' + AUTHORIZE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(out.auth_url, /code=true/)
  assert.match(out.auth_url, new RegExp('client_id=' + CLIENT_ID))
  assert.match(out.auth_url, /response_type=code/)
  assert.match(out.auth_url, /code_challenge_method=S256/)
  assert.ok(out.auth_url.includes(encodeURIComponent(REDIRECT_URI)))
  assert.ok(out.auth_url.includes(encodeURIComponent(SCOPE_OAUTH).replace(/%20/g, '+')))
  assert.equal(out.vm_id, 'vm-01')
  assert.ok(out.session_id)
  assert.ok(out.expires_at > Date.now())
  const session = peekAuthUrlSession(out.session_id)
  assert.ok(session)
  assert.equal(session.vmId, 'vm-01')
  assert.ok(session.codeVerifier)
  assert.ok(session.state)
  assert.equal(out.flavor, 'cai')
  assert.equal(session.flavor, 'cai')
  assert.equal(session.redirectUri, REDIRECT_URI)
})

test('generateAuthUrl claude_code uses official authorize and callback', () => {
  resetAuthUrlSessions()
  const spec = OAUTH_FLAVORS.claude_code
  const out = generateAuthUrl({
    vmId: 'vm-01',
    proxyUrl: 'socks5h://127.0.0.1:1080',
    flavor: 'claude_code',
  })
  assert.equal(out.flavor, 'claude_code')
  assert.match(out.auth_url, /^https:\/\/claude\.ai\/oauth\/authorize\?code=true/)
  assert.ok(out.auth_url.includes(encodeURIComponent(spec.redirectUri)))
  assert.ok(out.auth_url.includes(encodeURIComponent(spec.scope).replace(/%20/g, '+')))
  assert.ok(!out.auth_url.includes('cai/oauth'))
  const session = peekAuthUrlSession(out.session_id)
  assert.equal(session.flavor, 'claude_code')
  assert.equal(session.redirectUri, spec.redirectUri)
  assert.deepEqual(session.tokenUrls, spec.tokenUrls)
  assert.equal(session.source, 'oauth-claude-code')
})

test('generateAuthUrl setup_token uses full scope on CAI but keeps setup-token flavor', () => {
  resetAuthUrlSessions()
  const spec = OAUTH_FLAVORS.setup_token
  const out = generateAuthUrl({
    vmId: 'vm-01',
    proxyUrl: 'socks5h://127.0.0.1:1080',
    flavor: 'setup_token',
  })
  assert.equal(out.flavor, 'setup_token')
  assert.match(out.auth_url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true/)
  assert.ok(out.auth_url.includes(encodeURIComponent(spec.scope).replace(/%20/g, '+')))
  assert.ok(out.auth_url.includes('user%3Aprofile'))
  const session = peekAuthUrlSession(out.session_id)
  assert.equal(session.flavor, 'setup_token')
  assert.equal(session.scope, spec.scope)
  assert.equal(session.source, 'oauth-setup-token')
})

test('buildAuthorizationURL matches sub2api parameter order', () => {
  const url = buildAuthorizationURL('st', 'ch')
  assert.ok(url.startsWith(`${AUTHORIZE_URL}?code=true&client_id=${CLIENT_ID}&response_type=code`))
})

test('exchangeAuthCode rejects missing / mismatched session', async () => {
  resetAuthUrlSessions()
  await assert.rejects(
    () => exchangeAuthCode({ sessionId: 'missing', code: 'abc', proxyUrl: 'socks5h://127.0.0.1:1' }),
    /过期/,
  )
  const out = generateAuthUrl({ vmId: 'vm-01', proxyUrl: 'socks5h://127.0.0.1:1080' })
  await assert.rejects(
    () =>
      exchangeAuthCode({
        sessionId: out.session_id,
        code: 'abc',
        proxyUrl: 'socks5h://127.0.0.1:1080',
        vmId: 'vm-02',
      }),
    /不匹配/,
  )
})

test('fake exchange writes tokens without network', async () => {
  resetAuthUrlSessions()
  process.env.KIN_FAKE_SESSION_OAUTH = '1'
  const out = generateAuthUrl({ vmId: 'vm-01', proxyUrl: 'socks5h://127.0.0.1:1080' })
  const cred = await exchangeAuthCode({
    sessionId: out.session_id,
    code: 'pasted-code',
    proxyUrl: 'socks5h://127.0.0.1:1080',
    vmId: 'vm-01',
  })
  assert.equal(cred.source, 'KIN_FAKE_SESSION_OAUTH')
  assert.match(cred.access_token, /^sk-ant-oat01-FAKE-AUTH-URL/)
  assert.equal(peekAuthUrlSession(out.session_id), null)
  const cc = generateAuthUrl({
    vmId: 'vm-01',
    proxyUrl: 'socks5h://127.0.0.1:1080',
    flavor: 'claude_code',
  })
  const ccCred = await exchangeAuthCode({
    sessionId: cc.session_id,
    code: 'pasted-code',
    proxyUrl: 'socks5h://127.0.0.1:1080',
    vmId: 'vm-01',
  })
  assert.equal(ccCred.flavor, 'claude_code')
  delete process.env.KIN_FAKE_SESSION_OAUTH
})
