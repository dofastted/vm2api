import test from 'node:test'
import assert from 'node:assert/strict'
import {
  correlationIdForLog,
  extractProviderCorrelation,
  reasoningEffortOf,
  sessionIdForLog,
} from '../../src/lib/protocol/log-fields.mjs'

test('reasoningEffortOf reads each inbound dialect', () => {
  assert.equal(reasoningEffortOf({ output_config: { effort: 'High' } }), 'high')
  assert.equal(reasoningEffortOf({ reasoning_effort: ' minimal ' }), 'minimal')
  assert.equal(reasoningEffortOf({ reasoning: { effort: 'XHIGH' } }), 'xhigh')
})

test('reasoningEffortOf prefers the Anthropic field and rejects unknown values', () => {
  assert.equal(reasoningEffortOf({ output_config: { effort: 'max' }, reasoning_effort: 'low' }), 'max')
  assert.equal(reasoningEffortOf({ reasoning_effort: 'turbo' }), null)
  assert.equal(reasoningEffortOf({ reasoning: { effort: 3 } }), null)
  assert.equal(reasoningEffortOf({ thinking: { type: 'enabled', budget_tokens: 2048 } }), null)
  assert.equal(reasoningEffortOf(null), null)
})

test('reasoningEffortOf prefers the last message-level output_config.effort', () => {
  assert.equal(
    reasoningEffortOf({
      output_config: { effort: 'high' },
      messages: [
        { role: 'system', content: [], output_config: { effort: 'low' } },
        { role: 'user', content: 'hi' },
        { role: 'system', content: [], output_config: { effort: 'Max' } },
      ],
    }),
    'max',
  )
  assert.equal(
    reasoningEffortOf({ output_config: { effort: 'high' }, messages: [{ role: 'user', content: 'hi' }] }),
    'high',
  )
})

test('sessionIdForLog trims, caps at 200 chars, and maps empty to null', () => {
  assert.equal(sessionIdForLog('  abc  '), 'abc')
  assert.equal(sessionIdForLog('x'.repeat(300)).length, 200)
  assert.equal(sessionIdForLog(''), null)
  assert.equal(sessionIdForLog(undefined), null)
})

test('correlationIdForLog and extractProviderCorrelation keep bounded safe IDs and reject secrets (#1845)', () => {
  assert.equal(correlationIdForLog('  11111111-2222-4333-8444-555555555555  '), '11111111-2222-4333-8444-555555555555')
  assert.equal(correlationIdForLog('sk-ant-oat01-ABCDEFGH'), null)
  assert.equal(correlationIdForLog('Bearer token-123'), null)
  assert.equal(correlationIdForLog('bad\nid'), null)
  assert.equal(correlationIdForLog('a'.repeat(129)), null)

  assert.deepEqual(
    extractProviderCorrelation({
      hopRequestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      providerResult: {
        run_id: 'run_01',
        turn_id: 'turn_02',
        attempt_id: 3,
        request_id: 'req_0123456789',
      },
    }),
    {
      hop_request_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      run_id: 'run_01',
      turn_id: 'turn_02',
      attempt_id: 3,
      provider_request_id: 'req_0123456789',
      request_id: 'req_0123456789',
    },
  )

  assert.deepEqual(
    extractProviderCorrelation({
      hopRequestId: 'sk-ant-secret',
      providerResult: { run_id: 'bad space', attempt_id: -1, request_id: 'req_ok' },
    }),
    {
      hop_request_id: null,
      run_id: null,
      turn_id: null,
      attempt_id: null,
      provider_request_id: 'req_ok',
      request_id: 'req_ok',
    },
  )
})
