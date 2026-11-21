import assert from 'node:assert/strict'
import test from 'node:test'
import { FULL_OAUTH_SCOPE } from '../../src/lib/oauth/oauth-contract.mjs'
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

test('setup token runs the README flow: login scope, no lifetime requested', () => {
  // Identity (profile/roles/bootstrap) needs user:profile, and the minted token
  // is the upstream's short-lived one — a long-lived token is not fabricated.
  assert.equal(profilePolicy('setup-token').scope, FULL_OAUTH_SCOPE)
  assert.equal(scopeForProfile('setup-token'), FULL_OAUTH_SCOPE)
  assert.equal(expiresInForProfile('setup-token'), undefined)
})

test('a caller may narrow the login scope but never change the mint', () => {
  assert.equal(scopeForProfile('oauth', 'user:inference'), 'user:inference')
  assert.equal(scopeForProfile('oauth', '   '), FULL_OAUTH_SCOPE)
  // The mint owns its scope: caller values are ignored in both directions.
  assert.equal(scopeForProfile('setup-token', 'user:inference'), FULL_OAUTH_SCOPE)
  assert.equal(scopeForProfile('setup-token', ''), FULL_OAUTH_SCOPE)
})

test('unknown profiles fall back to the normal login', () => {
  assert.equal(scopeForProfile(undefined), FULL_OAUTH_SCOPE)
  assert.equal(scopeForProfile('inference'), FULL_OAUTH_SCOPE)
  assert.equal(expiresInForProfile('inference'), undefined)
})

test('capabilities name every behavior the e2e probes', () => {
  assert.deepEqual([...OAUTH_CAPABILITIES], ['session-code-bridge', 'setup-token-short-lived', 'proxy-fallback-local'])
})
