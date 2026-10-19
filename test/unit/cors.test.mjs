import test from 'node:test'
import assert from 'node:assert/strict'
import { corsHeadersForRequest, parsePanelCorsOrigins, CORS_ALLOW_METHODS } from '../../src/lib/http/cors.mjs'

test('allowlisted origin is echoed with Allow-Credentials and Vary: Origin', () => {
  const origin = 'https://panel.example.com'
  const env = { PANEL_CORS_ORIGINS: `${origin},https://other.example.com` }
  const headers = corsHeadersForRequest({ headers: { origin } }, {}, env)
  assert.equal(headers['access-control-allow-origin'], origin)
  assert.equal(headers['access-control-allow-credentials'], 'true')
  assert.equal(headers.vary, 'Origin')
})

test('non-allowlisted origin stays wildcard without credentials or Vary', () => {
  const origin = 'https://panel.example.com'
  const headers = corsHeadersForRequest(
    { headers: { origin } },
    {},
    { PANEL_CORS_ORIGINS: 'https://admin.example.com' },
  )
  assert.equal(headers['access-control-allow-origin'], '*')
  assert.notEqual(headers['access-control-allow-origin'], origin)
  assert.equal(headers['access-control-allow-credentials'], undefined)
  assert.equal(headers.vary, undefined)
})

test('PUBLIC_BASE_URL origin is allowlisted without extra env', () => {
  const env = { PUBLIC_BASE_URL: 'https://api.example.com/' }
  assert.equal(parsePanelCorsOrigins(env).has('https://api.example.com'), true)
  const headers = corsHeadersForRequest({ headers: { origin: 'https://api.example.com' } }, {}, env)
  assert.equal(headers['access-control-allow-origin'], 'https://api.example.com')
  assert.equal(headers['access-control-allow-credentials'], 'true')
  assert.equal(headers.vary, 'Origin')
})

test('OPTIONS and JSON paths share methods including PATCH', () => {
  const headers = corsHeadersForRequest(null)
  assert.match(headers['access-control-allow-methods'], /PATCH/)
  assert.equal(CORS_ALLOW_METHODS.includes('PATCH'), true)
})

test('arbitrary origin is never echoed; response remains wildcard without credentials', () => {
  const origin = 'https://evil.example.com'
  const headers = corsHeadersForRequest(
    { headers: { origin } },
    {},
    { PANEL_CORS_ORIGINS: 'https://panel.example.com', PUBLIC_BASE_URL: 'https://api.example.com' },
  )
  assert.equal(headers['access-control-allow-origin'], '*')
  assert.notEqual(headers['access-control-allow-origin'], origin)
  assert.equal(headers['access-control-allow-credentials'], undefined)
  assert.equal(headers.vary, undefined)
})

test('preflight allows the Idempotency-Key the console sends on redeem', () => {
  assert.match(corsHeadersForRequest(null)['access-control-allow-headers'], /(^|, )idempotency-key(,|$)/)
})
