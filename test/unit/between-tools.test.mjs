import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { classifierFixture } from '../fixtures/auto-mode.mjs'
import { prepareClassifierBody } from '../../src/lib/protocol/request-purpose.mjs'
import { prepareAnthropicRequest, stripInvalidThinkingBlocks } from '../../src/lib/protocol/anthropic-policy.mjs'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'
import {
  applyModelRequestRules,
  getModelPolicy,
  resetModelPolicy,
  saveModelPolicy,
  seedDefaultPolicy,
  validateToolChoice,
} from '../../src/lib/protocol/model-policy.mjs'

openDatabase({ dbPath: ':memory:' })
resetModelPolicy()
after(() => closeDatabase())
const fixture = (overrides = {}) => ({
  ...classifierFixture({ model: 'claude-sonnet-5-5' }),
  thinking: { type: 'between_tools' },
  ...overrides,
})
const paths = [
  ['classifier', prepareClassifierBody, 'classifier_model_incompatible'],
  ['Messages', prepareAnthropicRequest, 'thinking_incompatible'],
  ['CLI hop', prepareCliHopBody, 'thinking_incompatible'],
  ['model rules', applyModelRequestRules, 'thinking_incompatible'],
]

for (const model of ['claude-sonnet-5-5', 'sonnet', 'anthropic/claude-sonnet-5-5[1m]']) {
  test(`${model}: between_tools preserves budget and accepts supported efforts`, () => {
    for (const effort of [undefined, 'low', 'medium', 'high']) {
      const input = fixture({ model, ...(effort ? { output_config: { effort } } : {}) })
      const before = structuredClone(input)
      const out = prepareClassifierBody(input)
      assert.equal(out.model, 'claude-sonnet-5-5')
      assert.equal(out.max_tokens, 64)
      assert.deepEqual(out.thinking, { type: 'between_tools' })
      assert.deepEqual(out.output_config, input.output_config)
      assert.deepEqual(out.system, input.system)
      assert.deepEqual(out.messages, input.messages)
      assert.deepEqual(out.stop_sequences, input.stop_sequences)
      assert.deepEqual(prepareClassifierBody(out), out)
      assert.deepEqual(input, before)
    }
  })
}

for (const [name, prepare, code] of paths) {
  test(`${name}: rejects unsupported models, efforts and every extra thinking field`, () => {
    const invalid = [
      ...['claude-sonnet-4-6', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-sonnet-future'].map((model) =>
        fixture({ model }),
      ),
      ...['xhigh', 'max'].map((effort) => fixture({ output_config: { effort } })),
      fixture({ messages: [{ role: 'user', content: 'Hello', output_config: { effort: 'max' } }] }),
      fixture({
        output_config: { effort: 'xhigh' },
        messages: [{ role: 'user', content: 'Hello', output_config: { effort: 'high' } }],
      }),
      ...[
        { display: 'omitted' },
        { display: 'summarized' },
        { display: 'updates' },
        { budget_tokens: 1024 },
        { budget_tokens: null },
        { block_binding: true },
        { future_field: false },
      ].map((extra) => fixture({ thinking: { type: 'between_tools', ...extra } })),
    ]
    for (const input of invalid) {
      const before = structuredClone(input)
      assert.throws(
        () => prepare(input),
        (e) => e.status === 400 && e.body.error.code === code,
      )
      assert.deepEqual(input, before)
    }
  })
}

test('between_tools is an explicit capability that survives saved policy merging', () => {
  const old = seedDefaultPolicy()
  delete old.models['claude-sonnet-5-5'].capabilities.supports_between_tools
  saveModelPolicy(old)
  assert.equal(getModelPolicy().models['claude-sonnet-5-5'].capabilities.supports_between_tools, true)
  try {
    old.models['claude-sonnet-5-5'].capabilities.supports_between_tools = false
    saveModelPolicy(old)
    assert.throws(() => prepareClassifierBody(fixture()), /between_tools/)
  } finally {
    resetModelPolicy()
  }
})

test('between_tools preserves signed and redacted history through a tool loop', () => {
  const history = [
    { role: 'user', content: [{ type: 'text', text: 'Use lookup.' }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: 'abcdefghijklmnopqrstuvwxyz0123456789' },
        { type: 'redacted_thinking', data: 'encrypted-fixture' },
        { type: 'tool_use', id: 'toolu_fixture', name: 'lookup', input: {} },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fixture', content: 'found' }] },
  ]
  const input = fixture({ messages: history, tools: [{ name: 'lookup', input_schema: { type: 'object' } }] })
  for (const model of ['claude-sonnet-5-5', 'sonnet']) {
    for (const prepare of [stripInvalidThinkingBlocks, prepareAnthropicRequest, prepareCliHopBody]) {
      const out = prepare({ ...input, model })
      assert.deepEqual(out.messages[1].content, history[1].content)
      assert.deepEqual(out.thinking, { type: 'between_tools' })
      assert.equal(out.context_management, undefined)
    }
  }
})

test('between_tools rejects incompatible injected effort without changing saved policy', () => {
  const policy = seedDefaultPolicy()
  policy.models['claude-sonnet-5-5'].params.default_effort = 'xhigh'
  saveModelPolicy(policy)
  try {
    assert.throws(() => prepareAnthropicRequest(fixture(), { unofficial: true }), /xhigh or max/)
    const out = prepareAnthropicRequest(fixture({ output_config: { effort: 'low' } }), { unofficial: true })
    assert.equal(out.output_config.effort, 'low')
    assert.equal(getModelPolicy().models['claude-sonnet-5-5'].params.default_effort, 'xhigh')
    // Classifier assembly does not inject a configured default.
    assert.equal(prepareClassifierBody(fixture()).output_config, undefined)
  } finally {
    resetModelPolicy()
  }
})

test('between_tools keeps the Sonnet 5.5 forced-tool restriction', () => {
  const input = {
    ...classifierFixture({ model: 'claude-sonnet-5-5', format: 'tool' }),
    thinking: { type: 'between_tools' },
  }
  assert.throws(
    () => prepareClassifierBody(input),
    (e) => e.status === 400 && e.body.error.code === 'classifier_model_incompatible',
  )
  assert.throws(
    () => validateToolChoice(input),
    (e) => e.status === 400 && e.body.error.code === 'tool_choice_incompatible',
  )
})
