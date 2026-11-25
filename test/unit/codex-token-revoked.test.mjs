import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  classifyCredentialRefresh,
  markVmRefreshError,
  refreshErrorCodeOf,
} from '../../src/lib/oauth/oauth-credentials.mjs'
import { classifyUpstreamResult, isUnconfirmedAuthFailure } from '../../src/lib/pool/upstream-error-policy.mjs'
import { isCredentialRefreshFailed } from '../../src/lib/pool/availability.mjs'
import { semanticStatusForStreamError } from '../../src/lib/protocol/stream-error-status.mjs'

/**
 * OpenAI/codex revocations are spelled differently from Anthropic's:
 * the API answers 401 with
 *   { "error": { "message": "Encountered invalidated oauth token for user, failing request",
 *       "type": null, "code": "token_revoked" } }
 * None of those words match the historic grant-death patterns, so a dead codex
 * slot kept being selected, burned a 30s seat per attempt, and never left the
 * pool nor showed an invalid-credential state on the console.
 */
const CODEX_401_BODY = {
  error: {
    message: 'Encountered invalidated oauth token for user, failing request',
    type: null,
    code: 'token_revoked',
  },
}

const CLAUDE_401_BODY = {
  error: { type: 'authentication_error', message: 'token has been revoked' },
}

const CODEX_TOKEN_ENDPOINT_REFRESH = {
  ok: false,
  status: 401,
  error: {
    code: 'token_revoked',
    message: 'Encountered invalidated oauth token for user, failing request',
  },
}

test('classifyUpstreamResult: codex token_revoked 401 parks the account like claude oauth_revoked', () => {
  const policy = classifyUpstreamResult(
    { status: 401, body: CODEX_401_BODY },
    { hasRefresh: true },
  )
  assert.equal(policy.reason, 'oauth_revoked')
  assert.equal(policy.action, 'continue-and-cooldown')
  assert.equal(policy.retrySameAccount, false)
  assert.equal(policy.cooldownUntil, Number.MAX_SAFE_INTEGER)
})

test('classifyUpstreamResult: claude revocation wording still parks (no regression)', () => {
  const policy = classifyUpstreamResult(
    { status: 401, body: CLAUDE_401_BODY },
    { hasRefresh: true },
  )
  assert.equal(policy.reason, 'oauth_revoked')
  assert.equal(policy.cooldownUntil, Number.MAX_SAFE_INTEGER)
})

test('isUnconfirmedAuthFailure: a definitive codex revocation is not an unconfirmed 401', () => {
  assert.equal(isUnconfirmedAuthFailure({ status: 401, body: CODEX_401_BODY }), false)
})

test('mid-stream codex revocation follows the same unconfirmed path as claude (consistency, no cooldown)', () => {
  // Upstream deliberately treats terminalState:'incomplete' auth failures as
  // unconfirmed for both providers: a wrap hop can stream a stale local 401
  // before the CLI loaded the host ticket. Pin codex onto that same path so a
  // definitive body does not park mid-stream while claude does not.
  const codexMidStream = { status: 401, body: CODEX_401_BODY, terminalState: 'incomplete', committed: true }
  const claudeMidStream = { status: 401, body: CLAUDE_401_BODY, terminalState: 'incomplete', committed: true }
  assert.equal(isUnconfirmedAuthFailure(codexMidStream), true)
  assert.equal(isUnconfirmedAuthFailure(claudeMidStream), true)
  const codexPolicy = classifyUpstreamResult(codexMidStream, { hasRefresh: true })
  assert.equal(codexPolicy.reason, 'oauth_unconfirmed')
  // The definitive path (no terminalState) still parks — the production case.
  assert.equal(
    classifyUpstreamResult({ status: 401, body: CODEX_401_BODY }, { hasRefresh: true }).reason,
    'oauth_revoked',
  )
})

test('classifyCredentialRefresh: codex token endpoint rejection is fatal', () => {
  assert.equal(classifyCredentialRefresh(CODEX_TOKEN_ENDPOINT_REFRESH), 'fatal')
})

test('refreshErrorCodeOf: codex revocation normalizes onto oauth_revoked', () => {
  assert.equal(refreshErrorCodeOf(CODEX_TOKEN_ENDPOINT_REFRESH), 'oauth_revoked')
})

test('markVmRefreshError: fatal codex refresh leaves the pool (unschedulable + paused)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-codex-revoke-'))
  const vmPath = path.join(dir, 'vm-90.json')
  fs.writeFileSync(
    vmPath,
    JSON.stringify({ id: 'vm-90', status: 'running', claude: { has_refresh: true, refresh_error: null } }),
    'utf8',
  )
  try {
    const vm = markVmRefreshError(vmPath, CODEX_TOKEN_ENDPOINT_REFRESH)
    assert.equal(vm.claude.refresh_error, 'oauth_revoked')
    assert.ok(vm.unschedulable, 'slot must be ejected from the schedule')
    assert.equal(vm.status, 'paused')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('isCredentialRefreshFailed: legacy vm.json token_revoked leftovers count as dead', () => {
  // Slots parked before this fix may carry the raw upstream code on disk.
  const vm = { claude: { refresh_error: 'token_revoked' }, has_token: false }
  assert.equal(isCredentialRefreshFailed({ vm }), true)
})

test('semanticStatusForStreamError: codex stream error restores 401', () => {
  assert.equal(semanticStatusForStreamError(CODEX_401_BODY), 401)
})
