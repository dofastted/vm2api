import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recoverThinkingOnlyMaxTokens } from '../../src/lib/transport/go-worker-client.mjs'

const usage = {
  input_tokens: 190,
  output_tokens: 64,
  cache_read_input_tokens: 110106,
  cache_creation_input_tokens: 0,
  output_tokens_details: { thinking_tokens: 64 },
}
const facts = (over = {}) => ({
  schema_version: 2,
  type: 'kin_provider_result',
  http_status: 200,
  public_status: 502,
  provider_complete: true,
  usage_complete: true,
  response_valid: false,
  delivery_error: { status: 502, type: 'api_error' },
  validation_error: { type: 'api_error', message: 'native request completed without response content' },
  message_id: 'msg_011Ch6DVunWUXCsPyD5DrhGs',
  model: 'claude-sonnet-5',
  stop_reason: 'max_tokens',
  stop_sequence: null,
  usage,
  ...over,
})
const failed = (over = {}, result = {}) => ({
  ok: false,
  status: 502,
  via: 'go-worker-stream',
  committed: false,
  terminalState: 'incomplete',
  body: { type: 'error', error: { type: 'api_error', message: 'native request completed without response content' } },
  nativeHandoff: false,
  providerResult: facts(over),
  ...result,
})

test('thinking-only max_tokens 502 becomes a 200 empty message (non-stream)', async () => {
  const out = await recoverThinkingOnlyMaxTokens(failed())
  assert.equal(out.ok, true)
  assert.equal(out.status, 200)
  assert.equal(out.terminalState, 'verified')
  assert.deepEqual(out.body, {
    id: 'msg_011Ch6DVunWUXCsPyD5DrhGs',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [],
    stop_reason: 'max_tokens',
    stop_sequence: null,
    usage,
  })
  assert.equal(out.usage, usage)
  assert.equal(out.committed, false)
})

test('streaming client receives start/delta/stop frames', async () => {
  const lines = []
  let commits = 0
  const out = await recoverThinkingOnlyMaxTokens(failed(), {
    onEvent: async (line) => lines.push(line),
    onCommit: () => commits++,
  })
  assert.equal(out.ok, true)
  assert.equal(out.committed, true)
  assert.equal(commits, 1)
  const events = lines.filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)))
  assert.deepEqual(
    events.map((e) => e.type),
    ['message_start', 'message_delta', 'message_stop'],
  )
  assert.deepEqual(events[0].message.content, [])
  assert.equal(events[0].message.usage.output_tokens, 0)
  assert.equal(events[1].delta.stop_reason, 'max_tokens')
  assert.equal(events[1].usage.output_tokens, 64)
})

test('other failures stay untouched', async () => {
  for (const [over, result] of [
    [{ http_status: 502 }, {}],
    [{ stop_reason: 'end_turn' }, {}],
    [{ provider_complete: false }, {}],
    [{ validation_error: { type: 'api_error', message: 'something else' } }, {}],
    [{ schema_version: 1 }, {}],
    [{}, { ok: true, status: 200 }],
    [{}, { providerResult: null }],
  ]) {
    const input = failed(over, result)
    assert.equal(await recoverThinkingOnlyMaxTokens(input), input)
  }
})

const dataEvents = (lines) => lines.filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)))

test('committed hop without a downstream writer recovers silently (non-stream assemble)', async () => {
  const out = await recoverThinkingOnlyMaxTokens(failed({}, { committed: true }))
  assert.equal(out.ok, true)
  assert.equal(out.status, 200)
  assert.deepEqual(out.body.content, [])
})

test('committed stream closes open blocks and appends only terminal frames', async () => {
  const lines = []
  let commits = 0
  const out = await recoverThinkingOnlyMaxTokens(failed({}, { committed: true }), {
    onEvent: async (line) => lines.push(line),
    onCommit: () => commits++,
    downstream: { messageStarted: true, terminal: false, open: new Set([0]) },
  })
  assert.equal(out.ok, true)
  assert.equal(out.committed, true)
  assert.equal(commits, 0)
  assert.deepEqual(
    dataEvents(lines).map((e) => [e.type, e.index]),
    [
      ['content_block_stop', 0],
      ['message_delta', undefined],
      ['message_stop', undefined],
    ],
  )
})

test('committed stream without tracking or with a terminal frame already sent stays untouched', async () => {
  for (const downstream of [null, { messageStarted: true, terminal: true, open: new Set() }]) {
    const input = failed({}, { committed: true })
    assert.equal(await recoverThinkingOnlyMaxTokens(input, { onEvent: async () => {}, downstream }), input)
  }
})
