import test from 'node:test'
import assert from 'node:assert/strict'
import { officialMessagesBody } from '../../src/lib/protocol/anthropic-messages.mjs'
import { reasoningEffortOf } from '../../src/lib/protocol/log-fields.mjs'
import { liftMidConversationSystemMessages, normalizeAnthropicMessages } from '../../src/lib/protocol/sanitize.mjs'
import {
  BETA_EFFORT,
  BETA_MID_CONVERSATION_OUTPUT_CONFIG,
  BETA_MID_CONVERSATION_SYSTEM,
  withRequestProtocolBetas,
} from '../../src/lib/protocol/claude-code-betas.mjs'
import {
  MID_CONVERSATION_SYSTEM_BETA,
  sanitizeAnthropicBodyForBetaTokens,
  stripInvalidThinkingBlocks,
} from '../../src/lib/protocol/anthropic-policy.mjs'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'
import { stripUnsupportedEffort } from '../../src/lib/protocol/thinking.mjs'
import { applyModelRequestRules } from '../../src/lib/protocol/model-policy.mjs'
import { applyMessageBreakpoints } from '../../src/lib/protocol/cache-ttl.mjs'
import { finalizeWorkerPayload } from '../../src/lib/transport/go-worker-client.mjs'
import { toClaudeMessages } from '../../src/lib/protocol/convert.mjs'

const ISSUE_INBOUND = {
  model: 'claude-opus-5-5',
  max_tokens: 1024,
  stream: true,
  thinking: { type: 'adaptive', display: 'summarized' },
  output_config: { effort: 'high' },
  messages: [
    { role: 'user', content: 'Reply OK.' },
    { role: 'system', content: [], output_config: { effort: 'max' } },
  ],
}

function messageEfforts(body) {
  return (body.messages || [])
    .filter((message) => message?.output_config?.effort)
    .map((message) => message.output_config.effort)
}

function roles(body) {
  return (body.messages || []).map((message) => message.role)
}

test('issue 383: control after new user stays message-level and top-level effort is unchanged', () => {
  const inbound = structuredClone(ISSUE_INBOUND)
  const outbound = officialMessagesBody(structuredClone(inbound))
  assert.deepEqual(roles(outbound), ['user', 'system'])
  assert.equal(outbound.output_config.effort, 'high')
  assert.deepEqual(messageEfforts(outbound), ['max'])
  assert.deepEqual(outbound.messages[1].content, [])
  assert.equal(outbound.messages[0].content[0].text, 'Reply OK.')
  assert.equal(reasoningEffortOf(inbound), 'max')
  const betas = withRequestProtocolBetas([], outbound)
  assert.ok(betas.includes(BETA_MID_CONVERSATION_OUTPUT_CONFIG))
  assert.ok(!betas.includes(BETA_MID_CONVERSATION_SYSTEM))
  assert.ok(betas.includes(BETA_EFFORT))
})

test('issue 383: control before new user stays in place and does not lift', () => {
  const outbound = officialMessagesBody({
    model: 'claude-opus-5-5',
    max_tokens: 1024,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    messages: [
      { role: 'user', content: 'Reply OK.' },
      { role: 'assistant', content: 'OK.' },
      { role: 'system', content: [], output_config: { effort: 'medium' } },
      { role: 'user', content: 'Reply OK again.' },
    ],
  })
  assert.deepEqual(roles(outbound), ['user', 'assistant', 'system', 'user'])
  assert.equal(outbound.output_config.effort, 'high')
  assert.deepEqual(messageEfforts(outbound), ['medium'])
  assert.deepEqual(outbound.messages[2].content, [])
})

test('empty system effort control is kept instead of merged into an adjacent system turn', () => {
  const body = officialMessagesBody({
    model: 'claude-opus-5-5',
    max_tokens: 32,
    output_config: { effort: 'high' },
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: [{ type: 'text', text: 'reminder' }] },
      { role: 'system', content: [], output_config: { effort: 'max' } },
    ],
  })
  assert.deepEqual(roles(body), ['user', 'system', 'system'])
  assert.equal(body.messages[1].output_config, undefined)
  assert.equal(body.messages[1].content[0].text, 'reminder')
  assert.equal(body.messages[2].output_config.effort, 'max')
  assert.deepEqual(body.messages[2].content, [])
  assert.equal(body.output_config.effort, 'high')
})

test('historical empty system effort controls stay and top-level effort is unchanged', () => {
  const historical = officialMessagesBody({
    model: 'claude-opus-5-5',
    max_tokens: 32,
    output_config: { effort: 'high' },
    messages: [
      { role: 'user', content: 'one' },
      { role: 'system', content: [], output_config: { effort: 'low' } },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'two' },
    ],
  })
  assert.deepEqual(roles(historical), ['user', 'system', 'assistant', 'user'])
  assert.equal(historical.output_config.effort, 'high')
  assert.deepEqual(messageEfforts(historical), ['low'])

  const current = officialMessagesBody({
    model: 'claude-opus-5-5',
    max_tokens: 32,
    output_config: { effort: 'high' },
    messages: [
      { role: 'user', content: 'one' },
      { role: 'system', content: [], output_config: { effort: 'low' } },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'two' },
      { role: 'system', content: [], output_config: { effort: 'max' } },
    ],
  })
  assert.deepEqual(roles(current), ['user', 'system', 'assistant', 'user', 'system'])
  assert.equal(current.output_config.effort, 'high')
  assert.deepEqual(messageEfforts(current), ['low', 'max'])
})

test('repeated effort switches keep every historical control', () => {
  const body = officialMessagesBody({
    model: 'claude-opus-5-5',
    max_tokens: 32,
    output_config: { effort: 'high' },
    messages: [
      { role: 'user', content: 'one' },
      { role: 'system', content: [], output_config: { effort: 'low' } },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'two' },
      { role: 'system', content: [], output_config: { effort: 'max' } },
      { role: 'assistant', content: 'ok2' },
      { role: 'user', content: 'three' },
      { role: 'system', content: [], output_config: { effort: 'medium' } },
    ],
  })
  assert.deepEqual(roles(body), ['user', 'system', 'assistant', 'user', 'system', 'assistant', 'user', 'system'])
  assert.equal(body.output_config.effort, 'high')
  assert.deepEqual(messageEfforts(body), ['low', 'max', 'medium'])
})

test('empty system with clear_at is dropped', () => {
  const body = officialMessagesBody({
    model: 'claude-opus-5-5',
    max_tokens: 32,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: [], clear_at: 0 },
    ],
  })
  assert.deepEqual(roles(body), ['user'])
  assert.equal(
    body.messages.some((message) => message.clear_at != null),
    false,
  )
})

test('empty content without turn controls is still dropped', () => {
  const body = {
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: [] },
      { role: 'assistant', content: '   ' },
    ],
  }
  normalizeAnthropicMessages(body)
  assert.deepEqual(roles(body), ['user'])
})

test('unsupported models still lift the last message-level effort onto top-level output_config', () => {
  const lifted = liftMidConversationSystemMessages({
    model: 'claude-sonnet-5',
    output_config: { effort: 'high' },
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: [], output_config: { effort: 'low' } },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'again' },
      { role: 'system', content: [], output_config: { effort: 'max' } },
    ],
  })
  assert.equal(
    lifted.messages.some((message) => message.role === 'system'),
    false,
  )
  assert.equal(lifted.output_config.effort, 'max')
  assert.deepEqual(roles(lifted), ['user', 'assistant', 'user'])
})

test('beta sanitize keeps Opus 5.5 controls and lifts models that reject per-message effort', () => {
  const header = `oauth-2025-04-20,${MID_CONVERSATION_SYSTEM_BETA}`
  const sonnet5 = sanitizeAnthropicBodyForBetaTokens(
    {
      model: 'claude-sonnet-5',
      output_config: { effort: 'high' },
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: [], output_config: { effort: 'max' } },
      ],
    },
    header,
  )
  assert.equal(
    sonnet5.messages.some((message) => message.role === 'system'),
    false,
  )
  assert.equal(sonnet5.output_config.effort, 'max')

  const opus = sanitizeAnthropicBodyForBetaTokens(
    {
      model: 'claude-opus-5-5',
      output_config: { effort: 'high' },
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: [], output_config: { effort: 'max' } },
      ],
    },
    header,
  )
  assert.deepEqual(roles(opus), ['user', 'system'])
  assert.equal(opus.output_config.effort, 'high')
  assert.deepEqual(messageEfforts(opus), ['max'])

  const fable = officialMessagesBody({
    model: 'claude-fable-5',
    max_tokens: 32,
    output_config: { effort: 'high' },
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: [], output_config: { effort: 'max' } },
    ],
  })
  assert.deepEqual(roles(fable), ['user'])
  assert.equal(fable.output_config.effort, 'max')

  const fable51 = officialMessagesBody({
    model: 'claude-fable-5-1',
    max_tokens: 32,
    output_config: { effort: 'high' },
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: [], output_config: { effort: 'max' } },
    ],
  })
  assert.deepEqual(roles(fable51), ['user', 'system'])
  assert.equal(fable51.output_config.effort, 'high')
  assert.deepEqual(messageEfforts(fable51), ['max'])
})

test('withRequestProtocolBetas derives mid-conversation-output-config from messages', () => {
  const derived = withRequestProtocolBetas(['caller-beta'], {
    model: 'claude-opus-5-5',
    output_config: { effort: 'high' },
    messages: [{ role: 'system', content: [], output_config: { effort: 'max' } }],
  })
  assert.ok(derived.includes('caller-beta'))
  assert.ok(derived.includes(BETA_MID_CONVERSATION_OUTPUT_CONFIG))
  assert.ok(derived.includes(BETA_EFFORT))
  assert.ok(!derived.includes(BETA_MID_CONVERSATION_SYSTEM))
  assert.deepEqual(withRequestProtocolBetas(['caller-beta'], { model: 'claude-sonnet-4-6' }), ['caller-beta'])
})

test('thread create and continue derive the same output-config beta without replayed effort controls', () => {
  const create = {
    model: 'claude-opus-5-5',
    output_config: { effort: 'high' },
    thread: { type: 'create' },
    messages: [
      { role: 'user', content: 'go' },
      { role: 'system', content: [], output_config: { effort: 'max' } },
    ],
  }
  const resume = {
    model: 'claude-opus-5-5',
    output_config: { effort: 'high' },
    thread: { type: 'continue', previous_message_id: 'msg_create' },
    messages: [{ role: 'user', content: 'next' }],
  }
  const created = withRequestProtocolBetas(['caller-beta'], create)
  assert.ok(created.includes(BETA_MID_CONVERSATION_OUTPUT_CONFIG))
  const continued = withRequestProtocolBetas(['caller-beta'], resume)
  assert.ok(continued.includes(BETA_MID_CONVERSATION_OUTPUT_CONFIG))
  assert.ok(!continued.includes(BETA_MID_CONVERSATION_SYSTEM))
  assert.ok(!created.includes(BETA_MID_CONVERSATION_SYSTEM))
  const { thread: _thread, ...plain } = resume
  assert.ok(!withRequestProtocolBetas(['caller-beta'], plain).includes(BETA_MID_CONVERSATION_OUTPUT_CONFIG))
  assert.ok(
    !withRequestProtocolBetas([], { ...resume, model: 'claude-sonnet-5' }).includes(
      BETA_MID_CONVERSATION_OUTPUT_CONFIG,
    ),
  )
})

test('thinking strip keeps empty system effort controls and a valid short signature on Opus 5.5', () => {
  const body = stripInvalidThinkingBlocks({
    model: 'claude-opus-5-5',
    thinking: { type: 'adaptive' },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'system', content: [{ type: 'text', text: 'reminder' }] },
      { role: 'system', content: [], output_config: { effort: 'max' } },
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'draft', signature: 'abc' }],
      },
    ],
  })
  assert.equal(
    body.messages.some((message) => message.role === 'assistant'),
    true,
  )
  assert.equal(
    body.messages.some((message) => message.content?.[0]?.text === 'reminder'),
    true,
  )
  assert.equal(body.output_config, undefined)
  assert.deepEqual(messageEfforts(body), ['max'])
})

test('stripUnsupportedEffort drops message-level effort on Haiku', () => {
  const stripped = stripUnsupportedEffort({
    model: 'claude-haiku-4-5',
    output_config: { effort: 'high' },
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: [], output_config: { effort: 'max' } },
    ],
  })
  assert.equal(stripped.output_config, undefined)
  assert.equal(
    stripped.messages.some((message) => message.output_config),
    false,
  )
  assert.deepEqual(roles(stripped), ['user'])
})

test('prepareCliHopBody keeps trailing message-level max on Opus 5.5', () => {
  const body = prepareCliHopBody(structuredClone(ISSUE_INBOUND))
  assert.deepEqual(roles(body), ['user', 'system'])
  assert.equal(body.output_config.effort, 'high')
  assert.deepEqual(messageEfforts(body), ['max'])
  assert.equal(body.messages[0].content[0].text, 'Reply OK.')
  assert.ok(body.messages[0].content[0].cache_control)
  assert.equal(body.messages[1].content.length, 0)
})

test('prepareCliHopBody lifts last effort on Sonnet 5 and strips it on Haiku', () => {
  const sonnet = prepareCliHopBody({
    model: 'claude-sonnet-5',
    max_tokens: 256,
    output_config: { effort: 'high' },
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: [], output_config: { effort: 'max' } },
    ],
  })
  assert.equal(
    sonnet.messages.some((message) => message.role === 'system'),
    false,
  )
  assert.equal(sonnet.output_config.effort, 'max')

  const haiku = prepareCliHopBody({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    output_config: { effort: 'high' },
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: [], output_config: { effort: 'max' } },
    ],
  })
  assert.equal(haiku.output_config, undefined)
  assert.equal(
    haiku.messages.some((message) => message.role === 'system' || message.output_config),
    false,
  )
})

test('toClaudeMessages passthrough and rewrite both keep the empty effort control', () => {
  const passthrough = toClaudeMessages('anthropic.messages', structuredClone(ISSUE_INBOUND)).claude
  assert.deepEqual(roles(passthrough), ['user', 'system'])
  assert.equal(passthrough.output_config.effort, 'high')
  assert.deepEqual(messageEfforts(passthrough), ['max'])
  const rewritten = toClaudeMessages('anthropic.messages', structuredClone(ISSUE_INBOUND), {
    rewrite: true,
    model_map: false,
  }).claude
  const hop = officialMessagesBody(rewritten)
  assert.deepEqual(roles(hop), ['user', 'system'])
  assert.equal(hop.output_config.effort, 'high')
  assert.deepEqual(messageEfforts(hop), ['max'])
})

test('cache rewrite stamps the last content-bearing turn, not an empty control', () => {
  const out = applyMessageBreakpoints(
    {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'system', content: [], output_config: { effort: 'max' } },
      ],
    },
    '1h',
    'rewrite',
  )
  assert.deepEqual(out.messages[0].content[0].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.equal(out.messages[1].content.length, 0)
  assert.equal(out.messages[1].output_config.effort, 'max')
})

test('cli-hop worker envelope keeps the empty effort control and required beta', () => {
  const body = prepareCliHopBody(structuredClone(ISSUE_INBOUND))
  const out = finalizeWorkerPayload({
    body,
    reqHeaders: {},
    exec: { homeDir: '', vm: { claude: { mode: 'setup-token', scope: 'user:inference' } } },
    identity: null,
    cliHop: true,
  })
  assert.deepEqual(roles(out.body), ['user', 'system'])
  assert.equal(out.body.output_config.effort, 'high')
  assert.deepEqual(messageEfforts(out.body), ['max'])
  assert.ok(out.body.betas.includes(BETA_MID_CONVERSATION_OUTPUT_CONFIG))
  assert.ok(out.body.betas.includes(BETA_EFFORT))
})

test('Haiku 5.5 disabled+max at message-level still becomes adaptive', () => {
  const blocked = applyModelRequestRules({
    model: 'claude-haiku-5-5',
    thinking: { type: 'disabled' },
    output_config: { effort: 'high' },
    messages: [{ role: 'system', content: [], output_config: { effort: 'max' } }],
  })
  assert.deepEqual(blocked.thinking, { type: 'adaptive' })
})
