import assert from 'node:assert/strict'
import { test } from 'node:test'
import { surfaceCragPolicyBlock } from '../../src/lib/transport/go-worker-client.mjs'
import { classifyUpstreamResult, shouldContinue } from '../../src/lib/pool/upstream-error-policy.mjs'

const blocked = (over = {}, result = {}) => ({
  ok: false,
  status: 502,
  via: 'go-worker-stream',
  committed: false,
  terminalState: 'incomplete',
  body: { type: 'message', role: 'assistant', content: [] },
  nativeHandoff: false,
  providerResult: {
    _internal_v2: true,
    schema_version: 2,
    type: 'kin_provider_result',
    source: 'crag',
    provider_complete: false,
    usage_complete: false,
    public_status: 502,
    delivery_error: { status: 502, type: 'crag_policy_error' },
    error: { type: 'crag_policy_error', message: 'Request was blocked before provider dispatch' },
    observation: {
      source: 'crag',
      policy_blocked: true,
      capture_failed: false,
      exception: {
        name: 'Error',
        code: 'CRAG_CACHE_CONTROL',
        message: 'Caller cache anchor changed in native history',
      },
    },
    ...over,
  },
  ...result,
})

test('CRAG cache-anchor block is surfaced and stops failover', () => {
  const before = classifyUpstreamResult(blocked())
  assert.equal(shouldContinue(before), true, 'baseline: an unmarked block looks like a retryable empty hop')

  const out = surfaceCragPolicyBlock(blocked())
  assert.equal(out.status, 502)
  assert.equal(out.terminalState, 'rejected')
  assert.equal(out.body.error.code, 'crag_policy_blocked')
  assert.match(out.body.error.message, /CRAG_CACHE_CONTROL: Caller cache anchor changed/)
  const policy = classifyUpstreamResult(out)
  assert.equal(policy.action, 'stop')
  assert.equal(policy.reason, 'crag_policy_blocked')
  assert.equal(shouldContinue(policy), false)
})

test('other results are untouched', () => {
  for (const input of [
    blocked({ observation: { policy_blocked: true, exception: { code: 'CRAG_OTHER' } } }),
    blocked({ source: 'provider_sse' }),
    blocked({ provider_complete: true }),
    blocked({}, { committed: true }),
    blocked({}, { ok: true, status: 200 }),
    blocked({}, { providerResult: null }),
  ]) {
    assert.equal(surfaceCragPolicyBlock(input), input)
  }
})
