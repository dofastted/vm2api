import test from 'node:test'
import assert from 'node:assert/strict'
import {
  sessionKeyToOAuth,
  classifyImportHelperOutput,
  publicImportError,
  panelImportErrorPayload,
  buildSetupTokenAuthorizeURL,
  extractOAuthCodeFromRedirect,
} from '../../src/lib/oauth/cookie-auth.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FULL_OAUTH_SCOPE, INFERENCE_ONLY_SCOPE } from '../../src/lib/oauth/oauth-contract.mjs'
import { slotExec } from '../../src/lib/vm/slot-runtime.mjs'

test('sessionKeyToOAuth rejects malformed session cookies before execution', async () => {
  await assert.rejects(() => sessionKeyToOAuth('not-a-sid'), /sk-ant-sid/)
})

test('sessionKeyToOAuth refuses a persisted VM without bound egress', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cookie-unbound-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vm = { id: 'vm-01', runtime: { type: 'docker' } }
  fs.mkdirSync(path.join(root, 'vms'))
  fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  await assert.rejects(
    () =>
      sessionKeyToOAuth('sk-ant-sid-unit-cookie', {
        exec: slotExec(root, vm),
        projectRoot: root,
        proxyUrl: 'socks5h://127.0.0.1:1',
      }),
    { code: 'proxy_required' },
  )
})

test('sessionKeyToOAuth cannot substitute a controller proxy for a target VM', async () => {
  await assert.rejects(() => sessionKeyToOAuth('sk-ant-sid-unit-cookie', { proxyUrl: 'socks5h://127.0.0.1:1' }), {
    code: 'oauth_vm_required',
  })
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

test('setup-token CAI URL helper asks for the inference-only scope', () => {
  const url = buildSetupTokenAuthorizeURL('st', 'ch')
  assert.match(url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true/)
  assert.match(url, /client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e/)
  assert.ok(url.includes(`scope=${encodeURIComponent(INFERENCE_ONLY_SCOPE)}`))
  assert.equal(url.includes(encodeURIComponent(FULL_OAUTH_SCOPE).replace(/%20/g, '+')), false)
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

test('a refused authorize Origin is an upstream protocol change, not a bad slot', () => {
  const raw =
    'authorize failed: 403 {"type":"error","error":{"type":"permission_error","message":"Origin not allowed"},"request_id":"req_011ChAgZMSqnv2VAeefKwWbW"} (Origin 被拒，已尝试：claude.ai, claude.com, cai, no-origin)'
  assert.equal(classifyImportHelperOutput(raw), 'origin_rejected')
  const payload = panelImportErrorPayload({ message: raw })
  assert.equal(payload.status, 502)
  assert.equal(payload.error.code, 'origin_rejected')
  assert.match(payload.error.message, /Origin not allowed/)
  assert.doesNotMatch(payload.error.message, /sessionKey 不够新|Cloudflare/)
})

test('a throttled token exchange is a 429 that says wait, not a bad code', () => {
  const raw =
    'token_exchange failed: 429 {"error":{"type":"rate_limit_error","message":"Ratelimited. Please try again later."}}'
  assert.equal(classifyImportHelperOutput(raw), 'token_exchange_rate_limited')
  assert.match(publicImportError(raw), /限流/)
  const payload = panelImportErrorPayload({ message: raw })
  assert.equal(payload.status, 429)
  assert.equal(payload.error.code, 'token_exchange_rate_limited')
  // A coded failure wins over text sniffing, and keeps its status.
  const coded = panelImportErrorPayload({ code: 'token_exchange_rate_limited', message: raw })
  assert.equal(coded.status, 429)
  assert.equal(coded.error.code, 'token_exchange_rate_limited')
})

test('a region-blocked token exchange is a 502 pointing at the exit', () => {
  const raw = 'token_exchange failed: 403 { "error": { "type": "forbidden", "message": "Request not allowed" } }'
  assert.equal(classifyImportHelperOutput(raw), 'token_exchange_forbidden')
  const payload = panelImportErrorPayload({ message: raw })
  assert.equal(payload.status, 502)
  assert.equal(payload.error.code, 'token_exchange_forbidden')
  assert.match(payload.error.message, /出口/)
  assert.doesNotMatch(payload.error.message, /限流|Cloudflare/)
})

test('a browser-attestation gate is reported as such, not as a stale cookie', () => {
  const raw = `authorize failed: 400 {"type":"error","error":{"type":"invalid_request_error","message":"This request couldn't be completed.","details":{"error_code":"missing_client_attestation"}},"request_id":"req_011ChB59nWjC5BhWghnDMkbA"}`
  assert.equal(classifyImportHelperOutput(raw), 'client_attestation_required')
  const payload = panelImportErrorPayload({ message: raw })
  assert.equal(payload.status, 502)
  assert.equal(payload.error.code, 'client_attestation_required')
  assert.match(payload.error.message, /client_attestation/)
  assert.match(payload.error.message, /授权链接/)
  assert.doesNotMatch(payload.error.message, /sessionKey 不够新|限流|Cloudflare/)
})
