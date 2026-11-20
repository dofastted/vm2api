import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTH_SCHEME_BEARER,
  AUTH_SCHEME_X_API_KEY,
  defaultAuthScheme,
  normalizeAuthScheme,
  resolveAuthScheme,
} from '../../src/lib/oauth/auth-scheme.mjs'
import { officialSetupTokenToOauth } from '../../src/lib/oauth/claude-setup-token.mjs'
import { upstreamAuthHeaders } from '../../src/lib/pool/api-presets.mjs'

test('defaults: setup-token/oauth Bearer, console x-api-key', () => {
  assert.equal(defaultAuthScheme('setup-token'), AUTH_SCHEME_BEARER)
  assert.equal(defaultAuthScheme('oauth'), AUTH_SCHEME_BEARER)
  assert.equal(defaultAuthScheme('apikey'), AUTH_SCHEME_X_API_KEY)
})

test('normalize accepts auth scheme aliases', () => {
  assert.equal(normalizeAuthScheme('authorization_bearer'), AUTH_SCHEME_BEARER)
  assert.equal(normalizeAuthScheme('Authorization-Bearer'), AUTH_SCHEME_BEARER)
  assert.equal(normalizeAuthScheme('x-api-key'), AUTH_SCHEME_X_API_KEY)
  assert.equal(normalizeAuthScheme(''), '')
})

test('resolve prefers explicit scheme over credential default', () => {
  assert.equal(
    resolveAuthScheme({
      mode: 'apikey',
      extra: { anthropic_apikey_auth_scheme: 'authorization_bearer' },
    }),
    AUTH_SCHEME_BEARER,
  )
  assert.equal(
    resolveAuthScheme({
      mode: 'setup-token',
      auth_scheme: 'x_api_key',
    }),
    AUTH_SCHEME_X_API_KEY,
  )
})

test('official setup-token oauth is Bearer by default', () => {
  const oauth = officialSetupTokenToOauth('sk-ant-oat01-' + 'c'.repeat(96))
  assert.equal(oauth.auth_scheme, AUTH_SCHEME_BEARER)
})

test('upstreamAuthHeaders switches Anthropic header', () => {
  const key = 'sk-ant-oat01-' + 'd'.repeat(96)
  const bearer = upstreamAuthHeaders('anthropic', key, { auth_scheme: AUTH_SCHEME_BEARER })
  assert.equal(bearer.authorization, `Bearer ${key}`)
  assert.equal(bearer['x-api-key'], undefined)
  const xkey = upstreamAuthHeaders('anthropic', 'sk-ant-api03-live')
  assert.equal(xkey['x-api-key'], 'sk-ant-api03-live')
  assert.equal(xkey.authorization, undefined)
})
