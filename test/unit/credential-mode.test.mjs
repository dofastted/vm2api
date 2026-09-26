import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeCredentialMode,
  credentialModeFromOauth,
  canOfficialCc,
  canOfficialUsage,
  canCountTokens,
  canRefreshCredential,
  looksLikeConsoleApiKey,
  looksLikeOauthAccessToken,
  liveOauthToSetupToken,
} from '../../src/lib/oauth/credential-mode.mjs'
import { apiKeyBetaHeader, BETA_OAUTH } from '../../src/lib/protocol/claude-code-betas.mjs'

test('normalizeCredentialMode maps aliases', () => {
  assert.equal(normalizeCredentialMode('setup_token'), 'setup-token')
  assert.equal(normalizeCredentialMode('inference'), 'setup-token')
  assert.equal(normalizeCredentialMode('console'), 'apikey')
  assert.equal(normalizeCredentialMode(''), 'oauth')
})

test('setup-token cannot official-cc, can official usage and refresh', () => {
  assert.equal(canOfficialCc('setup-token'), false)
  assert.equal(canOfficialUsage('setup-token'), true)
  assert.equal(canCountTokens('setup-token'), true)
  assert.equal(canRefreshCredential('setup-token'), true)
})

test('apikey cannot official-cc, usage, or refresh', () => {
  assert.equal(canOfficialCc('apikey'), false)
  assert.equal(canOfficialUsage('apikey'), false)
  assert.equal(canCountTokens('apikey'), true)
  assert.equal(canRefreshCredential('apikey'), false)
})

test('oauth can usage, cannot count_tokens', () => {
  assert.equal(canOfficialUsage('oauth'), true)
  assert.equal(canCountTokens('oauth'), false)
})

test('credentialModeFromOauth infers from type, prefix, and scope', () => {
  assert.equal(credentialModeFromOauth({ type: 'setup-token' }), 'setup-token')
  assert.equal(credentialModeFromOauth({ api_key: 'sk-ant-api03-xxxx' }), 'apikey')
  assert.equal(credentialModeFromOauth({ scope: 'user:inference' }), 'setup-token')
  assert.equal(credentialModeFromOauth({ type: 'oauth', scope: 'user:inference' }), 'setup-token')
  assert.equal(credentialModeFromOauth({ scope: 'user:profile user:inference' }), 'oauth')
  assert.equal(looksLikeConsoleApiKey('sk-ant-api03-abc'), true)
  assert.equal(looksLikeOauthAccessToken('sk-ant-oat01-abc'), true)
  assert.equal(looksLikeOauthAccessToken('sk-ant-api03-abc'), false)
})

test('apiKeyBetaHeader strips oauth beta', () => {
  const header = apiKeyBetaHeader(`claude-code-20250219,${BETA_OAUTH},interleaved-thinking-2025-05-14`)
  assert.ok(!header.includes(BETA_OAUTH))
  assert.match(header, /claude-code-20250219/)
})

test('liveOauthToSetupToken keeps refresh and real expiry', () => {
  const expires = Date.now() + 8 * 3600 * 1000
  const oauth = liveOauthToSetupToken({
    type: 'oauth',
    access_token: 'sk-ant-oat01-live',
    refresh_token: 'sk-ant-ort01-live',
    expires_at: expires,
    email: 'a@b.c',
    scope: 'user:profile user:inference',
  })
  assert.equal(oauth.type, 'setup-token')
  assert.equal(oauth.mode, 'setup-token')
  assert.equal(oauth.access_token, 'sk-ant-oat01-live')
  assert.equal(oauth.refresh_token, 'sk-ant-ort01-live')
  assert.equal(oauth.expires_at, expires)
  assert.equal(oauth.scope, 'user:inference')
  assert.equal(oauth.source, 'oauth-to-setup-token')
})

test('liveOauthToSetupToken rejects apikey and missing access', () => {
  assert.throws(() => liveOauthToSetupToken({ type: 'apikey', access_token: 'sk-ant-api03-xxxx' }), /Console API Key/)
  try {
    liveOauthToSetupToken({})
    assert.fail('expected throw')
  } catch (e) {
    assert.equal(e.code, 'credential_required')
  }
})
