import assert from 'node:assert/strict'
import test from 'node:test'
import { FULL_OAUTH_SCOPE, INFERENCE_ONLY_SCOPE, SETUP_TOKEN_TTL_SECONDS } from '../../src/lib/oauth/oauth-contract.mjs'
import {
  OAUTH_CAPABILITIES,
  expiresInForProfile,
  profilePolicy,
  scopeForProfile,
} from '../../src/lib/oauth/profile-policy.mjs'

test('normal login keeps the full scope and sends no lifetime', () => {
  assert.equal(profilePolicy('oauth').scope, FULL_OAUTH_SCOPE)
  assert.equal(scopeForProfile('oauth'), FULL_OAUTH_SCOPE)
  assert.equal(expiresInForProfile('oauth'), undefined)
})

test('setup token is inference-only with a one-year lifetime', () => {
  assert.equal(profilePolicy('setup-token').scope, INFERENCE_ONLY_SCOPE)
  assert.equal(scopeForProfile('setup-token'), INFERENCE_ONLY_SCOPE)
  assert.equal(expiresInForProfile('setup-token'), SETUP_TOKEN_TTL_SECONDS)
})

test('a caller may narrow the login scope but never widen the mint', () => {
  assert.equal(scopeForProfile('oauth', 'user:inference'), 'user:inference')
  assert.equal(scopeForProfile('oauth', '   '), FULL_OAUTH_SCOPE)
  // The mint owns its scope: any caller value is ignored, including the full one.
  assert.equal(scopeForProfile('setup-token', FULL_OAUTH_SCOPE), INFERENCE_ONLY_SCOPE)
  assert.equal(scopeForProfile('setup-token', ''), INFERENCE_ONLY_SCOPE)
})

test('unknown profiles fall back to the normal login', () => {
  assert.equal(scopeForProfile(undefined), FULL_OAUTH_SCOPE)
  assert.equal(scopeForProfile('inference'), FULL_OAUTH_SCOPE)
  assert.equal(expiresInForProfile('inference'), undefined)
})

test('capabilities name every behavior the e2e probes', () => {
  assert.deepEqual(
    [...OAUTH_CAPABILITIES],
    ['session-code-bridge', 'setup-token-inference', 'proxy-fallback-local'],
  )
})
