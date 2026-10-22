import test from 'node:test'
import assert from 'node:assert/strict'
import {
  prepareCliHopBody,
  prepareOfficialPassthroughBody,
  prepareOutboundEnvelope,
} from '../../src/lib/protocol/outbound-attempt.mjs'
import { rebuildOutboundSession } from '../../src/lib/identity/identity-rewrite.mjs'
import { resolveSlotPersonaPreset } from '../../src/lib/vm/slot-engine.mjs'

const identity = {
  deviceId: 'dev-slot-01',
  machineId: 'mid-slot-01',
  accountUuid: 'acct-slot-01',
  vmId: 'vm-01',
}

function officialBody() {
  return {
    model: 'claude-opus-5-5',
    max_tokens: 128000,
    stream: true,
    temperature: 1,
    metadata: {
      user_id: JSON.stringify({
        device_id: 'caller-device',
        account_uuid: 'caller-account',
        session_id: 'caller-session',
      }),
    },
    system: [
      {
        type: 'text',
        text: 'x-anthropic-billing-header: cc_version=2.1.306.de1; cc_entrypoint=claude-vscode; cch=abcde;',
      },
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
      {
        type: 'text',
        text: 'You are an interactive agent that helps users with software engineering tasks.',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ],
    tools: [
      {
        name: 'Bash',
        input_schema: { type: 'object' },
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
      {
        name: 'Read',
        input_schema: { type: 'object' },
        cache_control: { type: 'ephemeral', ttl: '5m' },
      },
    ],
    tool_choice: { type: 'auto' },
    context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'first', cache_control: { type: 'ephemeral' } }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'answer', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      },
      { role: 'user', content: [{ type: 'text', text: 'last' }] },
    ],
  }
}

test('official passthrough keeps system/tools/messages/cache markers and sampling fields', () => {
  const input = officialBody()
  const outboundSessionId = rebuildOutboundSession({ identity: 'caller-session', epoch: 'attempt:1' })
  const body = prepareOfficialPassthroughBody(input, {
    stream: true,
    identity,
    inbound: input,
    reqHeaders: { 'user-agent': 'claude-cli/2.1.306 (external, claude-vscode)' },
    sessionId: outboundSessionId,
  })

  assert.deepEqual(body.system, input.system, 'system and cache_control must not be rewritten')
  assert.deepEqual(body.tools, input.tools, 'tool schemas and markers must not be rewritten')
  assert.deepEqual(body.messages, input.messages, 'messages and markers must not be rewritten')
  assert.equal(body.temperature, 1)
  assert.deepEqual(body.context_management, input.context_management)
  assert.deepEqual(body.tool_choice, input.tool_choice)
  assert.equal(
    JSON.stringify(body.system).includes('cc_entrypoint=sdk-cli'),
    false,
    'must not add a proxy billing block',
  )
  assert.equal(JSON.stringify(body.system).includes('ttl":"1h"'), true, 'caller 1h markers stay as sent')

  const metadata = JSON.parse(body.metadata.user_id)
  assert.equal(metadata.device_id, 'dev-slot-01')
  assert.equal(metadata.account_uuid, 'acct-slot-01')
  assert.equal(metadata.session_id, outboundSessionId)
  assert.notEqual(metadata.session_id, 'caller-session')
})

test('official passthrough envelope returns the prepared body untouched', () => {
  const input = officialBody()
  const body = prepareOfficialPassthroughBody(input, {
    stream: true,
    identity,
    inbound: input,
    reqHeaders: {},
    sessionId: 'caller-session',
  })
  const envelope = prepareOutboundEnvelope({
    canonicalBody: body,
    inbound: input,
    identity,
    officialClient: true,
    unofficial: false,
    stream: true,
    officialPassthrough: true,
    reqHeaders: {},
    credentialMode: 'oauth',
    routing: {},
  })
  assert.equal(envelope.body, body, 'no sanitize / CCH / tool rename on official passthrough')
  assert.equal(envelope.headers.accept, 'text/event-stream')
  assert.equal(envelope.toolNames && Object.keys(envelope.toolNames).length, 0)
})

test('official passthrough does not run the cli-hop rewrite path', () => {
  const rewritten = prepareCliHopBody(officialBody(), { stream: true })
  assert.equal(rewritten.system[0].text, "You are Claude Code, Anthropic's official CLI for Claude.")
  assert.equal(
    rewritten.system.length < officialBody().system.length,
    true,
    'the legacy path collapses/rebuilds the caller system',
  )
  assert.notDeepEqual(rewritten.messages, officialBody().messages)
})

test('official_cc_passthrough projects the kernel to zero persona', () => {
  assert.equal(resolveSlotPersonaPreset({}, { compatibility: { official_cc_passthrough: true } }), 'zero')
  assert.equal(resolveSlotPersonaPreset({ persona_preset: 'official_full' }, { compatibility: {} }), 'official_full')
})

test('official passthrough does not inflate a 30k-char caller system', () => {
  const input = officialBody()
  input.system[2].text = `You are an interactive agent.\n${'x'.repeat(30_000)}`
  const body = prepareOfficialPassthroughBody(input, {
    stream: true,
    identity,
    inbound: input,
    reqHeaders: {},
    sessionId: 'caller-session',
  })
  assert.equal(body.system[2].text.length, input.system[2].text.length)
  assert.equal(JSON.stringify(body.system).includes('__PERSONA_AGENT__'), false)
  assert.equal(JSON.stringify(body.system).includes('cc_entrypoint=sdk-cli'), false)
})
