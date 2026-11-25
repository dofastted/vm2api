import test from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { loadModelPolicy, resetModelPolicy, saveModelPolicy, seedDefaultPolicy } from '../../src/lib/protocol/model-policy.mjs'
import { prepareAnthropicRequest } from '../../src/lib/protocol/anthropic-policy.mjs'
import { officialMessagesBody } from '../../src/lib/protocol/anthropic-messages.mjs'
import { BETA_EFFORT, withRequestProtocolBetas } from '../../src/lib/protocol/claude-code-betas.mjs'
import { toCodexResponses } from '../../src/lib/protocol/codex-convert.mjs'
import { toClaudeMessages } from '../../src/lib/protocol/convert.mjs'
import { prepareCragPrintBody } from '../../src/lib/protocol/crag-print-prompt.mjs'
import { sanitizeCragBodyWhitelist } from '../../src/lib/protocol/crag-whitelist.mjs'
import { parseInboundToGemini } from '../../src/lib/protocol/gemini-convert.mjs'
import { prepareCliNodeRequest, prepareCragRequest } from '../../src/lib/protocol/kernel-request.mjs'
import { reasoningEffortOf } from '../../src/lib/protocol/log-fields.mjs'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'
import { prepareClassifierBody } from '../../src/lib/protocol/request-purpose.mjs'
import { sanitizeAnthropicBody, stripEmptyEffort } from '../../src/lib/protocol/sanitize.mjs'
import {
  ensureUnofficialEffortHigh,
  loggedReasoningEffort,
  openaiReasoningToClaudeThinking,
} from '../../src/lib/protocol/thinking.mjs'

const EMPTY_EFFORTS = ['', '   ', '\t\n', null, undefined]

test('empty output_config.effort is treated as omitted and filled with model default on unofficial path', () => {
  openDatabase({ dbPath: ':memory:' })
  try {
    saveModelPolicy(seedDefaultPolicy())
    loadModelPolicy({ force: true })

    for (const empty of EMPTY_EFFORTS) {
      const sonnet5 = prepareAnthropicRequest(
        {
          model: 'claude-sonnet-5',
          output_config: { effort: empty },
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        },
        { unofficial: true },
      )
      assert.equal(sonnet5.output_config.effort, 'high')

      const opus55 = prepareAnthropicRequest(
        {
          model: 'claude-opus-5-5',
          output_config: { effort: empty, format: { type: 'json_schema', schema: { type: 'object' } } },
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        },
        { unofficial: true },
      )
      assert.equal(opus55.output_config.effort, 'medium')
      assert.equal(opus55.output_config.format.type, 'json_schema')

      const opus47 = ensureUnofficialEffortHigh({
        model: 'claude-opus-4-7',
        output_config: { effort: empty },
        messages: [{ role: 'user', content: 'hi' }],
      })
      assert.equal(opus47.output_config.effort, 'xhigh')

      const haiku45 = prepareAnthropicRequest(
        {
          model: 'claude-haiku-4-5',
          output_config: { effort: empty },
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        },
        { unofficial: true },
      )
      assert.equal(haiku45.output_config, undefined)
    }

    const policy = seedDefaultPolicy()
    policy.models['claude-sonnet-5'].params.default_effort = 'low'
    policy.models['claude-haiku-5-5'].params.default_effort = 'off'
    saveModelPolicy(policy)
    loadModelPolicy({ force: true })

    const panelOverride = ensureUnofficialEffortHigh({
      model: 'claude-sonnet-5',
      output_config: { effort: '   ' },
      messages: [{ role: 'user', content: 'hi' }],
    })
    assert.equal(panelOverride.output_config.effort, 'low')

    // default_effort=off must still strip empty effort instead of forwarding effort:""
    const offOnly = ensureUnofficialEffortHigh({
      model: 'claude-haiku-5-5',
      output_config: { effort: '' },
      messages: [{ role: 'user', content: 'hi' }],
    })
    assert.equal(offOnly.output_config, undefined)

    const offWithFormat = ensureUnofficialEffortHigh({
      model: 'claude-haiku-5-5',
      output_config: { effort: '  ', format: { type: 'json_schema', schema: { type: 'object' } } },
      messages: [{ role: 'user', content: 'hi' }],
    })
    assert.deepEqual(offWithFormat.output_config, { format: { type: 'json_schema', schema: { type: 'object' } } })
  } finally {
    resetModelPolicy()
    closeDatabase()
  }
})

test('sanitize, official, cli-hop, and CRAG boundaries strip empty effort so downstream fills model defaults', () => {
  for (const empty of EMPTY_EFFORTS) {
    const raw = {
      model: 'claude-sonnet-5-5',
      max_tokens: 1024,
      output_config: { effort: empty },
      effort: empty,
      crag_options: { effort: empty, cache_ttl: '1h' },
      messages: [
        { role: 'system', content: [], output_config: { effort: empty } },
        { role: 'user', content: [{ type: 'text', text: 'hello' }], output_config: { effort: empty } },
      ],
    }

    const sanitized = sanitizeAnthropicBody(raw)
    assert.equal(sanitized.output_config, undefined)
    assert.equal(sanitized.effort, undefined)
    assert.deepEqual(sanitized.crag_options, { cache_ttl: '1h' })
    assert.equal(sanitized.messages.length, 1)
    assert.equal(sanitized.messages[0].output_config, undefined)

    const official = officialMessagesBody(raw)
    assert.equal(official.output_config, undefined)
    assert.equal(official.messages[0].output_config, undefined)

    const officialPrepared = prepareAnthropicRequest(raw, { unofficial: false })
    assert.equal(officialPrepared.output_config, undefined)

    const cliHop = prepareCliHopBody(raw)
    assert.equal(cliHop.output_config, undefined)

    const cliNode = prepareCliNodeRequest(raw)
    assert.equal(cliNode.output_config, undefined)
    assert.equal(cliNode.effort, undefined)

    const cragReq = prepareCragRequest(raw, { capabilities: ['generation_controls_v3'] })
    assert.equal(cragReq.output_config, undefined)
    assert.equal(cragReq.effort, undefined)
    assert.deepEqual(cragReq.crag_options, { cache_ttl: '1h' })

    const cragWhitelist = sanitizeCragBodyWhitelist(
      {
        model: 'claude-sonnet-5-5',
        max_tokens: 1024,
        output_config: { effort: empty },
        effort: empty,
        crag_options: { effort: empty },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }], output_config: { effort: empty } }],
      },
      { preserveCanonicalHistory: true },
    ).body
    assert.equal(cragWhitelist.output_config, undefined)
    assert.equal(cragWhitelist.effort, undefined)
    assert.equal(cragWhitelist.crag_options, undefined)
    assert.equal(cragWhitelist.messages[0].output_config, undefined)
  }

  // Folded empty system effort must not overwrite an existing top-level effort.
  const folded = prepareCragPrintBody({
    model: 'claude-sonnet-5-5',
    output_config: { effort: 'high' },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'q1' }] },
      { role: 'system', content: [{ type: 'text', text: 'note' }], output_config: { effort: '  ' } },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'user', content: [{ type: 'text', text: 'q2' }] },
    ],
  })
  assert.deepEqual(folded.output_config, { effort: 'high' })

  // Fast-path reuse preserves references when no empty effort exists.
  const clean = {
    model: 'claude-sonnet-5-5',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'clean' }] }],
  }
  assert.equal(stripEmptyEffort(clean), clean)
  assert.equal(sanitizeAnthropicBody(clean, { reuseCanonicalHistory: true }).messages, clean.messages)
})

test('OpenAI Responses and Chat treat empty effort as omitted and fall through to model default', () => {
  openDatabase({ dbPath: ':memory:' })
  try {
    saveModelPolicy(seedDefaultPolicy())
    loadModelPolicy({ force: true })

    for (const empty of EMPTY_EFFORTS) {
      assert.equal(openaiReasoningToClaudeThinking({ reasoning_effort: empty }), null)
      assert.equal(openaiReasoningToClaudeThinking({ reasoning: { effort: empty } }), null)

      const responsesConverted = toClaudeMessages('openai.responses', {
        model: 'claude-sonnet-5-5',
        input: [
          { type: 'configuration_update', reasoning: { effort: empty } },
          { role: 'user', content: 'hello' },
        ],
        reasoning: { effort: empty },
      })
      const responsesOmitted = toClaudeMessages('openai.responses', {
        model: 'claude-sonnet-5-5',
        input: [{ role: 'user', content: 'hello' }],
      })
      assert.deepEqual(responsesConverted.claude, responsesOmitted.claude)
      assert.equal(responsesConverted.claude.output_config, undefined)

      const filled = prepareAnthropicRequest(responsesConverted.claude, { unofficial: true })
      assert.equal(filled.output_config.effort, 'medium')

      const chatConverted = toClaudeMessages('openai.chat', {
        model: 'claude-sonnet-5',
        messages: [{ role: 'user', content: 'hello' }],
        reasoning_effort: empty,
      })
      assert.equal(chatConverted.claude.thinking, undefined)
      const chatFilled = prepareAnthropicRequest(chatConverted.claude, { unofficial: true })
      assert.equal(chatFilled.output_config.effort, 'high')
    }

    // Empty primary field falls back to non-empty secondary field; invalid non-empty still rejects.
    const fallback = toClaudeMessages('openai.responses', {
      model: 'claude-sonnet-5-5',
      input: 'hello',
      reasoning: { effort: '  ' },
      reasoning_effort: 'low',
    })
    assert.equal(fallback.claude.output_config.effort, 'low')

    assert.throws(
      () =>
        toClaudeMessages('openai.responses', {
          model: 'claude-sonnet-5-5',
          input: 'hello',
          reasoning: { effort: 'turbo' },
        }),
      /unsupported reasoning effort/,
    )
  } finally {
    resetModelPolicy()
    closeDatabase()
  }
})

test('Codex, Gemini, betas, classifier, and effort logging treat empty effort as omitted', () => {
  openDatabase({ dbPath: ':memory:' })
  try {
    saveModelPolicy(seedDefaultPolicy())
    loadModelPolicy({ force: true })

    // Codex: blank reasoning.effort falls back to reasoning_effort; all empty drops reasoning
    const codexFallback = toCodexResponses('openai.responses', {
      model: 'gpt-5.5',
      input: 'hi',
      reasoning: { effort: '   ' },
      reasoning_effort: 'high',
    })
    assert.equal(codexFallback.body.reasoning.effort, 'high')

    const codexEmpty = toCodexResponses('openai.responses', {
      model: 'gpt-5.5',
      input: 'hi',
      reasoning: { effort: '  ' },
    })
    assert.equal(codexEmpty.body.reasoning, undefined)

    // Gemini: blank thinking_level falls back to budget / secondary effort
    const geminiNative = parseInboundToGemini('gemini', {
      model: 'gemini-3-pro',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      generationConfig: { thinkingConfig: { thinkingLevel: '   ', thinkingBudget: 2048 } },
    })
    assert.equal(geminiNative.thinking.effort, 'low')

    const geminiChat = parseInboundToGemini('openai-chat', {
      model: 'gemini-3-pro',
      messages: [{ role: 'user', content: 'hi' }],
      extra_body: { google: { thinking_config: { thinking_level: '' } } },
      reasoning_effort: '   ',
      reasoning: { effort: 'high' },
    })
    assert.equal(geminiChat.thinking.effort, 'high')

    // Logging: empty effort falls back to model default; whitespace message effort does not clobber top-level
    assert.equal(reasoningEffortOf({ output_config: { effort: '   ' } }), null)
    assert.equal(reasoningEffortOf({ output_config: { effort: '' }, reasoning_effort: 'high' }), 'high')
    assert.equal(
      reasoningEffortOf({
        output_config: { effort: 'high' },
        messages: [{ role: 'system', content: [], output_config: { effort: '   ' } }],
      }),
      'high',
    )
    assert.equal(loggedReasoningEffort({ model: 'claude-sonnet-5-5', output_config: { effort: '' } }), 'medium')
    assert.equal(loggedReasoningEffort({ model: 'claude-sonnet-5', output_config: { effort: '   ' } }), 'high')
    assert.equal(loggedReasoningEffort({ model: 'claude-opus-4-7', output_config: { effort: null } }), 'xhigh')

    // Betas: empty effort does not inject effort beta
    const betas = withRequestProtocolBetas([], {
      model: 'claude-sonnet-5',
      output_config: { effort: '  ' },
      messages: [{ role: 'user', content: 'hi', output_config: { effort: '' } }],
    })
    assert.equal(betas.includes(BETA_EFFORT), false)

    // Classifier on model without effort support accepts empty effort as omitted
    const classifier = prepareClassifierBody({
      model: 'claude-haiku-4-5',
      max_tokens: 64,
      output_config: { effort: '' },
      messages: [{ role: 'user', content: 'classify' }],
    })
    assert.equal(classifier.output_config, undefined)
  } finally {
    resetModelPolicy()
    closeDatabase()
  }
})
