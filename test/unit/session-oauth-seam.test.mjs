import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  sessionKeyToOAuth,
  exchangeTokenViaCookieAuth,
  classifyImportHelperOutput,
  publicImportError,
  panelImportErrorPayload,
  buildSetupTokenAuthorizeURL,
  extractOAuthCodeFromRedirect,
} from '../../src/lib/oauth/cookie-auth.mjs'

function writeHelper(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cookie-auth-'))
  const bin = path.join(dir, 'kin-cookie-auth')
  fs.writeFileSync(bin, script, { mode: 0o755 })
  return bin
}

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
  delete process.env.KIN_FAKE_SESSION_OAUTH
})

test('fake branch still rejects non-sid keys', async () => {
  process.env.KIN_FAKE_SESSION_OAUTH = '1'
  await assert.rejects(() => sessionKeyToOAuth('not-a-sid'), /sk-ant-sid/)
  delete process.env.KIN_FAKE_SESSION_OAUTH
})

test('sessionKeyToOAuth requires SOCKS5', async () => {
  await assert.rejects(
    () => sessionKeyToOAuth('sk-ant-sid01-testaaaaaaaa'),
    (e) => e.code === 'proxy_required',
  )
})

test('sessionKeyToOAuth reads JSON from helper stdout', async () => {
  const bin = writeHelper(`#!/bin/sh
echo '{"access_token":"sk-ant-oat01-helper","refresh_token":"sk-ant-ort01-helper","source":"test-helper"}'
`)
  process.env.KIN_COOKIE_AUTH_BIN = bin
  try {
    const cred = await sessionKeyToOAuth('sk-ant-sid01-testaaaaaaaa', { proxyUrl: 'socks5://127.0.0.1:1080' })
    assert.equal(cred.access_token, 'sk-ant-oat01-helper')
    assert.equal(cred.source, 'test-helper')
  } finally {
    delete process.env.KIN_COOKIE_AUTH_BIN
  }
})

test('sessionKeyToOAuth maps helper stale stderr', async () => {
  const bin = writeHelper(`#!/bin/sh
echo 'Session is not fresh enough to authorize' >&2
exit 2
`)
  process.env.KIN_COOKIE_AUTH_BIN = bin
  try {
    await assert.rejects(
      () => sessionKeyToOAuth('sk-ant-sid01-testaaaaaaaa', { proxyUrl: 'socks5h://127.0.0.1:1' }),
      (e) => e.code === 'session_stale_relogin',
    )
  } finally {
    delete process.env.KIN_COOKIE_AUTH_BIN
  }
})

test('exchangeTokenViaCookieAuth sets IMPORT_MODE', async () => {
  const bin = writeHelper(`#!/bin/sh
if [ "$IMPORT_MODE" != "token_exchange" ]; then echo fail >&2; exit 2; fi
echo '{"access_token":"sk-ant-oat01-ex","refresh_token":"rt"}'
`)
  process.env.KIN_COOKIE_AUTH_BIN = bin
  try {
    const tok = await exchangeTokenViaCookieAuth({
      code: 'abc',
      codeVerifier: 'ver',
      proxyUrl: 'socks5h://127.0.0.1:1',
    })
    assert.equal(tok.access_token, 'sk-ant-oat01-ex')
  } finally {
    delete process.env.KIN_COOKIE_AUTH_BIN
  }
})

test('authorize 403 session freshness is not reported as Cloudflare', () => {
  const raw = 'authorize failed: 403 Session is not fresh enough to authorize'
  assert.equal(classifyImportHelperOutput(raw), 'session_stale_relogin')
  assert.match(publicImportError(raw), /不够新/)
  assert.doesNotMatch(publicImportError(raw), /Cloudflare|Just a moment/)
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

test('setup-token CAI URL helper stays inference-only', () => {
  const url = buildSetupTokenAuthorizeURL('st', 'ch')
  assert.match(url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true/)
  assert.match(url, /client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e/)
  assert.match(url, /scope=user%3Ainference/)
  assert.ok(!url.includes('user:profile'))
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
