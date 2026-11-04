import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { classifierFixture } from '../fixtures/auto-mode.mjs'
import { officialMessagesBody } from '../../src/lib/protocol/anthropic-messages.mjs'
import {
  prepareCliHopBody,
  prepareOutboundAttempt,
  prepareOutboundEnvelope,
} from '../../src/lib/protocol/outbound-attempt.mjs'
import { finalizeWorkerPayload } from '../../src/lib/transport/go-worker-client.mjs'
import { outboundShape } from '../../src/lib/protocol/outbound-shape.mjs'
import { prepareAnthropicRequest } from '../../src/lib/protocol/anthropic-policy.mjs'
import {
  applyThinkingDisplay,
  ensureOfficialPrintThinking,
  ensureUnofficialAdaptiveThinking,
} from '../../src/lib/protocol/thinking.mjs'

openDatabase({ dbPath: ':memory:' })
after(() => closeDatabase())
const classifierContext = { purpose: 'auto_mode_classifier', format: 'xml', stage: 'xml_s1' }
const exec = { homeDir: '', vm: { claude: { mode: 'setup-token', scope: 'user:inference' } } }

for (const requestContext of [null, classifierContext]) {
  test(`${requestContext ? 'classifier' : 'ordinary Messages'} preserves between_tools to the final Node payload`, () => {
    const input = {
      ...classifierFixture({ model: 'claude-sonnet-5-5' }),
      thinking: { type: 'between_tools' },
      output_config: { effort: 'high' },
    }
    if (!requestContext) {
      input.system = 'Answer the user.'
      input.messages = [{ role: 'user', content: 'Hello' }]
    }
    const before = structuredClone(input)
    for (const stream of [true, false]) {
      const assembled = [
        officialMessagesBody(input, { stream }),
        prepareCliHopBody(input, { stream, requestContext }),
        prepareOutboundAttempt({ canonicalBody: input, identity: {}, requestContext, stream }).body,
        prepareOutboundEnvelope({
          canonicalBody: input,
          inbound: input,
          identity: {},
          requestContext,
          stream,
          unofficial: true,
        }).body,
      ]
      for (const body of assembled) {
        assert.deepEqual(body.thinking, { type: 'between_tools' })
        assert.equal(body.max_tokens, 64)
        assert.equal(body.stream, stream)
        assert.equal(body.output_config.effort, 'high')
        assert.deepEqual(outboundShape(body).thinking, { type: 'between_tools' })
        for (const cliHop of [true, false]) {
          const final = finalizeWorkerPayload({ body, reqHeaders: {}, exec, identity: null, cliHop, requestContext })
          assert.deepEqual(final.body.thinking, { type: 'between_tools' })
          assert.equal(final.body.max_tokens, 64)
          assert.equal(final.body.output_config.effort, 'high')
          assert.deepEqual(outboundShape(final.body).thinking, { type: 'between_tools' })
        }
      }
    }
    assert.deepEqual(input, before)
  })
}

test('display helpers and unofficial assembly never add fields to between_tools', () => {
  const input = {
    model: 'claude-sonnet-5-5',
    max_tokens: 64,
    thinking: { type: 'between_tools' },
    messages: [{ role: 'user', content: 'Hi' }],
  }
  for (const mode of ['summarized', 'omitted', 'updates']) {
    assert.deepEqual(applyThinkingDisplay(input, mode).thinking, input.thinking)
  }
  for (const out of [
    ensureOfficialPrintThinking(input),
    ensureUnofficialAdaptiveThinking(input),
    prepareAnthropicRequest(input, { unofficial: true }),
  ]) {
    assert.deepEqual(out.thinking, { type: 'between_tools' })
    assert.equal(out.max_tokens, 64)
  }
})
