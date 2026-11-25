#!/usr/bin/env node
/**
 * Generates the deterministic, sanitized >=110-case local protocol standard baseline corpus.
 *
 * Covers:
 *  - Real sanitized packets from test/fixtures/pkt-001..003 & synth-tools-metadata
 *  - Real CRAG replay standards (messages, chat, gemini, boundaries, persona)
 *  - All 4+1 inbound protocols x 3 native CLI targets + 3 external API channels
 *  - Web Settings passthrough 2x2 matrix (WebSetting ON/OFF x official/third-party/spoofed/cross-protocol)
 *  - Anti-collision inbound fingerprint stripping for CRAG, CRAGGemini, and Codex
 *  - Multi-turn tool/thinking continuations, streaming/non-streaming parity, and error boundaries
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')
const OUT_FILE = path.join(__dirname, 'corpus/standard-baseline.json')

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAUAAAADCAIAAADUVFKvAAAAEElEQVR4nGP8z4ACmBjw8wEvkQEFsRIyegAAAABJRU5ErkJggg=='

const OFFICIAL_CC_USER_ID = JSON.stringify({
  device_id: 'a'.repeat(64),
  account_uuid: '10000000-0000-4000-a000-000000000001',
  session_id: '20000000-0000-4000-a000-000000000002',
})

const OFFICIAL_CC_HEADERS = {
  'user-agent': 'claude-cli/2.1.321 (external, sdk-cli)',
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14',
  'x-app': 'cli',
  'x-claude-code-session-id': '20000000-0000-4000-a000-000000000002',
  'x-stainless-lang': 'js',
  'x-stainless-os': 'Linux',
  'x-stainless-arch': 'x64',
  'x-stainless-runtime': 'node',
}

const OFFICIAL_CC_SYSTEM = [
  { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.321; cc_entrypoint=sdk-cli; cch=00000;' },
  {
    type: 'text',
    text: "You are Claude Code, Anthropic's official CLI for Claude.",
    cache_control: { type: 'ephemeral' },
  },
  {
    type: 'text',
    text: 'You are an interactive CLI tool that helps users with software engineering tasks.',
    cache_control: { type: 'ephemeral' },
  },
]

const OFFICIAL_CODEX_HEADERS = {
  'user-agent': 'codex_cli_rs/0.170.0 (linux x86_64)',
  originator: 'codex_cli_rs',
  'openai-beta': 'responses=experimental',
  'session-id': '30000000-0000-4000-a000-000000000003',
  'x-codex-installation-id': '40000000-0000-4000-a000-000000000004',
}

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'))
}

function buildCases() {
  const cases = []
  const add = (entry) => {
    cases.push({
      web_settings: {},
      client_profile: 'generic_sdk',
      mock_upstream: { mode: 'ok_text', stream: false },
      ...entry,
    })
  }

  const pktChat = readJson('test/fixtures/pkt-001-openai.chat.completions.json')
  const pktMsg = readJson('test/fixtures/pkt-002-anthropic.messages.json')
  const pktResp = readJson('test/fixtures/pkt-003-openai.responses.json')
  const synthTools = readJson('test/fixtures/synth-tools-metadata.anthropic.json')

  // =========================================================================
  // GROUP A: CLAUDE CRAG NATIVE CLI (46 cases)
  // =========================================================================

  // A1: Real fixture packets redirected to Claude
  add({
    id: 'crag-pkt001-chat-text',
    source: 'vm2api_fixture',
    inbound_protocol: 'openai.chat',
    target_family: 'claude_crag',
    request: {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'user-agent': 'openai-node/4.77.0' },
      body: { ...pktChat.inbound_body, model: 'claude-haiku-4-5-20251001', stream: false },
    },
  })
  add({
    id: 'crag-pkt002-messages-text',
    source: 'vm2api_fixture',
    inbound_protocol: 'anthropic.messages',
    target_family: 'claude_crag',
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'user-agent': 'anthropic-sdk-typescript/0.39.0' },
      body: { ...pktMsg.inbound_body, stream: false },
    },
  })
  add({
    id: 'crag-pkt003-responses-text',
    source: 'vm2api_fixture',
    inbound_protocol: 'openai.responses',
    target_family: 'claude_crag',
    request: {
      method: 'POST',
      path: '/v1/responses',
      headers: { 'user-agent': 'openai-python/1.68.0' },
      body: { ...pktResp.inbound_body, model: 'claude-sonnet-4-6', stream: false },
    },
  })
  add({
    id: 'crag-synth-tools-metadata-strip',
    source: 'vm2api_fixture',
    inbound_protocol: 'anthropic.messages',
    target_family: 'claude_crag',
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'user-agent': 'third-party-agent/1.0', 'x-custom-client': 'leak-me' },
      body: { ...synthTools.inbound_body, stream: false },
    },
  })

  // A2: All 4+1 inbound protocols -> Claude CRAG (streaming & non-streaming)
  for (const stream of [false, true]) {
    const suffix = stream ? 'stream' : 'json'
    add({
      id: `crag-messages-basic-${suffix}`,
      source: 'crag_standard',
      inbound_protocol: 'anthropic.messages',
      target_family: 'claude_crag',
      request: {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'user-agent': 'curl/8.5.0' },
        body: {
          model: 'claude-haiku-4-5',
          max_tokens: 384,
          stream,
          messages: [{ role: 'user', content: '样本 Ω\nline two' }],
        },
      },
      mock_upstream: { mode: 'ok_text', stream },
    })
    add({
      id: `crag-chat-basic-${suffix}`,
      source: 'crag_standard',
      inbound_protocol: 'openai.chat',
      target_family: 'claude_crag',
      request: {
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'user-agent': 'openai-node/4.80.0' },
        body: {
          model: 'claude-haiku-4-5',
          max_completion_tokens: 384,
          stream,
          messages: [
            { role: 'developer', content: 'Follow concise JSON output.' },
            { role: 'user', content: '样本 Ω\nline two' },
          ],
        },
      },
      mock_upstream: { mode: 'ok_text', stream },
    })
    add({
      id: `crag-responses-basic-${suffix}`,
      source: 'crag_standard',
      inbound_protocol: 'openai.responses',
      target_family: 'claude_crag',
      request: {
        method: 'POST',
        path: '/v1/responses',
        headers: { 'user-agent': 'openai-python/1.72.0' },
        body: {
          model: 'claude-haiku-4-5',
          instructions: 'Return concise output.',
          max_output_tokens: 384,
          stream,
          input: [{ role: 'user', content: [{ type: 'input_text', text: '样本 Ω\nline two' }] }],
        },
      },
      mock_upstream: { mode: 'ok_text', stream },
    })
    add({
      id: `crag-completions-basic-${suffix}`,
      source: 'crag_standard',
      inbound_protocol: 'openai.completions',
      target_family: 'claude_crag',
      request: {
        method: 'POST',
        path: '/v1/completions',
        headers: { 'user-agent': 'legacy-client/1.0' },
        body: {
          model: 'claude-haiku-4-5',
          prompt: '样本 Ω\nline two',
          max_tokens: 128,
          stream,
        },
      },
      mock_upstream: { mode: 'ok_text', stream },
    })
    // G1: google.gemini -> Claude CRAG (currently 400 on Node, fixed in Go front!)
    add({
      id: `crag-gemini-cross-${suffix}`,
      source: 'crag_standard',
      inbound_protocol: 'google.gemini',
      target_family: 'claude_crag',
      expected_improvement: 'G1',
      request: {
        method: 'POST',
        path: `/v1beta/models/claude-haiku-4-5:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`,
        headers: { 'user-agent': 'google-genai-sdk/1.0' },
        body: {
          systemInstruction: { parts: [{ text: 'FORMAT_RULE_8' }] },
          contents: [{ role: 'user', parts: [{ text: '样本 Ω\nline two' }] }],
          generationConfig: { maxOutputTokens: 384, temperature: 0.2 },
        },
      },
      mock_upstream: { mode: 'ok_text', stream },
    })
  }

  // A3: Web Settings Passthrough 2x2 Matrix for Claude CRAG
  add({
    id: 'crag-passthrough-off-official-cc',
    source: 'passthrough_matrix',
    inbound_protocol: 'anthropic.messages',
    client_profile: 'official_claude_code',
    target_family: 'claude_crag',
    web_settings: { compatibility: { official_cc_passthrough: false, crag_persona_preset: 'official_full' } },
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: { ...OFFICIAL_CC_HEADERS },
      body: {
        model: 'claude-sonnet-5-5',
        max_tokens: 1024,
        stream: false,
        system: OFFICIAL_CC_SYSTEM,
        metadata: { user_id: OFFICIAL_CC_USER_ID },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'check repo status' }] }],
      },
    },
  })
  add({
    id: 'crag-passthrough-on-official-cc',
    source: 'passthrough_matrix',
    inbound_protocol: 'anthropic.messages',
    client_profile: 'official_claude_code',
    target_family: 'claude_crag',
    web_settings: { compatibility: { official_cc_passthrough: true, crag_persona_preset: 'official_full' } },
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: { ...OFFICIAL_CC_HEADERS },
      body: {
        model: 'claude-sonnet-5-5',
        max_tokens: 1024,
        stream: false,
        system: OFFICIAL_CC_SYSTEM,
        metadata: { user_id: OFFICIAL_CC_USER_ID },
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'check repo status', cache_control: { type: 'ephemeral' } }],
          },
        ],
      },
    },
  })
  add({
    id: 'crag-passthrough-on-proxied-official-cc',
    source: 'passthrough_matrix',
    inbound_protocol: 'anthropic.messages',
    client_profile: 'proxied_official_cc',
    target_family: 'claude_crag',
    web_settings: { compatibility: { official_cc_passthrough: true, detect_proxied_official_cc: true } },
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'user-agent': 'Go-http-client/2.0', 'anthropic-version': '2023-06-01' },
      body: {
        model: 'claude-sonnet-5-5',
        max_tokens: 1024,
        stream: false,
        system: OFFICIAL_CC_SYSTEM,
        metadata: { user_id: OFFICIAL_CC_USER_ID },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'proxied cc request' }] }],
      },
    },
  })
  add({
    id: 'crag-passthrough-on-spoofed-oh-my-pi',
    source: 'passthrough_matrix',
    inbound_protocol: 'anthropic.messages',
    client_profile: 'oh_my_pi',
    target_family: 'claude_crag',
    expected_improvement: 'strict_official_cc_passthrough',
    web_settings: { compatibility: { official_cc_passthrough: true, claude_code_only: false } },
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: { ...OFFICIAL_CC_HEADERS, 'user-agent': 'claude-cli/2.1.321 (oh-my-pi)' },
      body: {
        model: 'claude-sonnet-5-5',
        max_tokens: 1024,
        stream: false,
        system: [
          { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
          { type: 'text', text: 'You are oh-my-pi coding assistant running inside omp.' },
        ],
        metadata: { user_id: OFFICIAL_CC_USER_ID },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'spoofed cc should not passthrough' }] }],
      },
    },
  })
  add({
    id: 'crag-passthrough-on-spoofed-opencode',
    source: 'passthrough_matrix',
    inbound_protocol: 'anthropic.messages',
    client_profile: 'opencode',
    target_family: 'claude_crag',
    web_settings: { compatibility: { official_cc_passthrough: true, claude_code_only: false } },
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'user-agent': 'opencode/0.9.1', 'anthropic-version': '2023-06-01' },
      body: {
        model: 'claude-sonnet-5-5',
        max_tokens: 1024,
        stream: false,
        system: [
          { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
          { type: 'text', text: 'You are OpenCode, an interactive CLI coding agent.' },
        ],
        messages: [{ role: 'user', content: 'fix the bug in parser' }],
      },
    },
  })
  add({
    id: 'crag-passthrough-on-cross-chat',
    source: 'passthrough_matrix',
    inbound_protocol: 'openai.chat',
    client_profile: 'generic_sdk',
    target_family: 'claude_crag',
    web_settings: { compatibility: { official_cc_passthrough: true } },
    request: {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { ...OFFICIAL_CC_HEADERS },
      body: {
        model: 'claude-sonnet-5-5',
        stream: false,
        messages: [
          { role: 'system', content: 'Custom chat system prompt.' },
          { role: 'user', content: 'cross protocol must never passthrough' },
        ],
      },
    },
  })
  add({
    id: 'crag-claude-code-only-reject-third-party',
    source: 'passthrough_matrix',
    inbound_protocol: 'anthropic.messages',
    client_profile: 'opencode',
    target_family: 'claude_crag',
    web_settings: { compatibility: { claude_code_only: true } },
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'user-agent': 'opencode/0.9.1' },
      body: {
        model: 'claude-sonnet-5-5',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'should be blocked' }],
      },
    },
  })

  // A4: Anti-collision fingerprint stripping, persona presets, cache breakpoints, tools, thinking, images
  add({
    id: 'crag-strip-billing-identity-budget-counter',
    source: 'strip_matrix',
    inbound_protocol: 'anthropic.messages',
    client_profile: 'third_party_sdk',
    target_family: 'claude_crag',
    web_settings: { compatibility: { crag_persona_preset: 'official_full', claude_code_only: false } },
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'user-agent': 'node-fetch/3.0', 'x-forwarded-for': '10.0.0.5', 'x-title': 'MyIDE' },
      body: {
        model: 'claude-sonnet-5-5',
        max_tokens: 512,
        system: [
          { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.200; cch=abcde;' },
          { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
          {
            type: 'text',
            text: 'User project rules: keep edits small.\n<total_tokens>194321 tokens left</total_tokens>',
          },
        ],
        metadata: { user_id: 'fake-user', machine_id: 'WIN-BOX-1' },
        caller_cwd: '/tmp/secret',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello', annotations: [{ type: 'cite' }] }] },
          { role: 'system', content: 'Timezone: Asia/Shanghai\n<total_tokens>190000 tokens left</total_tokens>' },
          { role: 'user', content: 'continue task' },
        ],
      },
    },
  })
  for (const preset of ['official_full', 'zero']) {
    add({
      id: `crag-preset-${preset}-system-and-env`,
      source: 'crag_standard',
      inbound_protocol: 'anthropic.messages',
      target_family: 'claude_crag',
      web_settings: { compatibility: { crag_persona_preset: preset, claude_code_only: false } },
      request: {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'user-agent': 'custom-client/1.0' },
        body: {
          model: 'claude-haiku-4-5',
          max_tokens: 512,
          system: 'REPLAY_SYSTEM_P7',
          messages: [
            { role: 'user', content: 'REPLAY_TASK_P7' },
            { role: 'system', content: [{ type: 'text', text: 'Timezone: Europe/Paris\nLanguage: fr-FR' }] },
          ],
        },
      },
    })
  }
  add({
    id: 'crag-cache-four-valid-official',
    source: 'crag_standard',
    inbound_protocol: 'anthropic.messages',
    client_profile: 'official_claude_code',
    target_family: 'claude_crag',
    web_settings: { compatibility: { official_cc_passthrough: true } },
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: { ...OFFICIAL_CC_HEADERS },
      body: {
        model: 'claude-sonnet-5-5',
        max_tokens: 512,
        system: OFFICIAL_CC_SYSTEM,
        metadata: { user_id: OFFICIAL_CC_USER_ID },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'anchor-A', cache_control: { type: 'ephemeral', ttl: '1h' } },
              { type: 'text', text: 'anchor-B', cache_control: { type: 'ephemeral', ttl: '5m' } },
            ],
          },
        ],
      },
    },
  })
  add({
    id: 'crag-cache-five-reject-official',
    source: 'crag_standard',
    inbound_protocol: 'anthropic.messages',
    client_profile: 'official_claude_code',
    target_family: 'claude_crag',
    web_settings: { compatibility: { official_cc_passthrough: true } },
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: { ...OFFICIAL_CC_HEADERS },
      body: {
        model: 'claude-sonnet-5-5',
        max_tokens: 512,
        system: OFFICIAL_CC_SYSTEM,
        metadata: { user_id: OFFICIAL_CC_USER_ID },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'a1', cache_control: { type: 'ephemeral', ttl: '1h' } },
              { type: 'text', text: 'a2', cache_control: { type: 'ephemeral', ttl: '5m' } },
              { type: 'text', text: 'a3', cache_control: { type: 'ephemeral', ttl: '5m' } },
            ],
          },
        ],
      },
    },
  })
  add({
    id: 'crag-cache-short-before-long-reject-official',
    source: 'crag_standard',
    inbound_protocol: 'anthropic.messages',
    client_profile: 'official_claude_code',
    target_family: 'claude_crag',
    web_settings: { compatibility: { official_cc_passthrough: true } },
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: { ...OFFICIAL_CC_HEADERS },
      body: {
        model: 'claude-sonnet-5-5',
        max_tokens: 512,
        system: [
          { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.321; cc_entrypoint=sdk-cli; cch=00000;' },
          {
            type: 'text',
            text: "You are Claude Code, Anthropic's official CLI for Claude.",
            cache_control: { type: 'ephemeral', ttl: '5m' },
          },
        ],
        metadata: { user_id: OFFICIAL_CC_USER_ID },
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'tail', cache_control: { type: 'ephemeral', ttl: '1h' } }],
          },
        ],
      },
    },
  })
  add({
    id: 'crag-unsigned-and-dummy-thinking-strip',
    source: 'strip_matrix',
    inbound_protocol: 'anthropic.messages',
    target_family: 'claude_crag',
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'user-agent': 'sdk/1.0' },
      body: {
        model: 'claude-sonnet-5-5',
        max_tokens: 2048,
        thinking: { type: 'enabled', budget_tokens: 1024 },
        messages: [
          { role: 'user', content: 'solve 2+2' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'unsigned draft', signature: 'skip_thought_signature_validator' },
              { type: 'text', text: '4' },
            ],
          },
          { role: 'user', content: 'and 3+3?' },
        ],
      },
    },
  })
  add({
    id: 'crag-chat-tools-schema-and-args',
    source: 'crag_standard',
    inbound_protocol: 'openai.chat',
    target_family: 'claude_crag',
    request: {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'user-agent': 'openai-node/4.80.0' },
      body: {
        model: 'claude-sonnet-5-5',
        stream: false,
        messages: [
          { role: 'developer', content: 'FORMAT_RULE_8' },
          { role: 'user', content: 'look up row 7' },
          {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_chat_7',
                type: 'function',
                function: { name: 'lookup', arguments: '{"row":7}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_chat_7', content: 'seven' },
          { role: 'user', content: 'summarize as json' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup',
              description: 'Lookup row',
              parameters: { type: 'object', properties: { row: { type: 'integer' } }, required: ['row'] },
            },
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'answer',
            strict: true,
            schema: {
              type: 'object',
              properties: { count: { type: 'integer' } },
              required: ['count'],
              additionalProperties: false,
            },
          },
        },
      },
    },
    mock_upstream: { mode: 'ok_tool_call', stream: false },
  })
  add({
    id: 'crag-chat-tool-stream',
    source: 'crag_standard',
    inbound_protocol: 'openai.chat',
    target_family: 'claude_crag',
    request: {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'user-agent': 'openai-node/4.80.0' },
      body: {
        model: 'claude-sonnet-5-5',
        stream: true,
        messages: [{ role: 'user', content: 'call lookup with row 7' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup',
              parameters: { type: 'object', properties: { row: { type: 'integer' } } },
            },
          },
        ],
        tool_choice: { type: 'function', function: { name: 'lookup' } },
      },
    },
    mock_upstream: { mode: 'ok_tool_call', stream: true },
  })
  add({
    id: 'crag-responses-tools-and-reasoning-stream',
    source: 'crag_standard',
    inbound_protocol: 'openai.responses',
    target_family: 'claude_crag',
    request: {
      method: 'POST',
      path: '/v1/responses',
      headers: { 'user-agent': 'openai-python/1.72.0' },
      body: {
        model: 'claude-sonnet-5-5',
        stream: true,
        instructions: 'Use tools carefully.',
        reasoning: { effort: 'high' },
        tools: [
          {
            type: 'function',
            name: 'read_file',
            description: 'Read a file',
            parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          },
        ],
        tool_choice: 'required',
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'read README.md' }] },
          { type: 'function_call', call_id: 'fc_1', name: 'read_file', arguments: '{"path":"README.md"}' },
          { type: 'function_call_output', call_id: 'fc_1', output: '# vm2api' },
        ],
      },
    },
    mock_upstream: { mode: 'ok_thinking_tool', stream: true },
  })
  add({
    id: 'crag-messages-inline-png-image',
    source: 'crag_standard',
    inbound_protocol: 'anthropic.messages',
    target_family: 'claude_crag',
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'user-agent': 'anthropic-sdk/0.39' },
      body: {
        model: 'claude-haiku-4-5',
        max_tokens: 256,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'before PNG' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_B64 } },
              { type: 'text', text: 'after PNG' },
            ],
          },
        ],
      },
    },
  })
  add({
    id: 'crag-chat-image-data-uri',
    source: 'crag_standard',
    inbound_protocol: 'openai.chat',
    target_family: 'claude_crag',
    request: {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'user-agent': 'openai-node/4.80.0' },
      body: {
        model: 'claude-haiku-4-5',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe image' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${TINY_PNG_B64}` } },
            ],
          },
        ],
      },
    },
  })
  for (const [badId, extra] of [
    ['n-gt-1', { n: 2 }],
    ['seed', { seed: 42 }],
    ['logprobs', { logprobs: true }],
    ['presence-penalty', { presence_penalty: 0.5 }],
    ['frequency-penalty', { frequency_penalty: 0.3 }],
  ]) {
    add({
      id: `crag-fail-closed-unrepresentable-${badId}`,
      source: 'boundary_matrix',
      inbound_protocol: 'anthropic.messages',
      target_family: 'claude_crag',
      request: {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'user-agent': 'sdk/1.0' },
        body: {
          model: 'claude-haiku-4-5',
          max_tokens: 128,
          ...extra,
          messages: [{ role: 'user', content: 'test' }],
        },
      },
    })
  }
  add({
    id: 'crag-upstream-http-400-passthrough',
    source: 'boundary_matrix',
    inbound_protocol: 'anthropic.messages',
    target_family: 'claude_crag',
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'user-agent': 'sdk/1.0' },
      body: {
        model: 'claude-haiku-4-5',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'trigger mock 400' }],
      },
    },
    mock_upstream: { mode: 'http_400', stream: false },
  })
  add({
    id: 'crag-messages-thinking-and-tool-stream',
    source: 'crag_standard',
    inbound_protocol: 'anthropic.messages',
    target_family: 'claude_crag',
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'user-agent': 'anthropic-sdk/0.39' },
      body: {
        model: 'claude-sonnet-5-5',
        max_tokens: 2048,
        stream: true,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
        tools: [
          {
            name: 'lookup',
            description: 'Lookup',
            input_schema: { type: 'object', properties: { row: { type: 'integer' } } },
          },
        ],
        messages: [{ role: 'user', content: 'think and call lookup' }],
      },
    },
    mock_upstream: { mode: 'ok_thinking_tool', stream: true },
  })
  add({
    id: 'crag-messages-multiturn-3step',
    source: 'multiturn_matrix',
    inbound_protocol: 'anthropic.messages',
    target_family: 'claude_crag',
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'user-agent': 'anthropic-sdk/0.39' },
      body: {
        model: 'claude-sonnet-5-5',
        max_tokens: 1024,
        tools: [{ name: 'read_file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
        messages: [
          { role: 'user', content: 'Turn 1: read a.txt' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_t1', name: 'read_file', input: { path: 'a.txt' } }],
          },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_t1', content: 'alpha' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'File has alpha.' }] },
          { role: 'user', content: 'Turn 3: confirm alpha' },
        ],
      },
    },
  })
  add({
    id: 'crag-chat-empty-effort-strip',
    source: 'strip_matrix',
    inbound_protocol: 'openai.chat',
    target_family: 'claude_crag',
    request: {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'user-agent': 'openai-node/4.80' },
      body: {
        model: 'claude-sonnet-5-5',
        reasoning_effort: '',
        messages: [{ role: 'user', content: 'empty effort should be omitted' }],
      },
    },
  })
  add({
    id: 'crag-chat-bad-schema-400',
    source: 'crag_standard',
    inbound_protocol: 'openai.chat',
    target_family: 'claude_crag',
    expected_improvement: 'fail_closed_schema',
    request: {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'user-agent': 'openai-node/4.80' },
      body: {
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'return count' }],
        response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: 'object' } },
      },
    },
  })
  add({
    id: 'crag-messages-output-config-format',
    source: 'crag_standard',
    inbound_protocol: 'anthropic.messages',
    target_family: 'claude_crag',
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'user-agent': 'anthropic-sdk/0.39' },
      body: {
        model: 'claude-sonnet-5-5',
        max_tokens: 512,
        output_config: {
          effort: 'medium',
          format: {
            type: 'json_schema',
            schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
          },
        },
        messages: [{ role: 'user', content: 'return ok' }],
      },
    },
  })
  add({
    id: 'crag-messages-stop-sequences-and-temp',
    source: 'crag_standard',
    inbound_protocol: 'anthropic.messages',
    target_family: 'claude_crag',
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'user-agent': 'anthropic-sdk/0.39' },
      body: {
        model: 'claude-haiku-4-5',
        max_tokens: 256,
        temperature: 0.3,
        top_p: 0.9,
        top_k: 40,
        stop_sequences: ['END_MARKER'],
        messages: [{ role: 'user', content: 'say hi' }],
      },
    },
  })
  add({
    id: 'crag-responses-image-input',
    source: 'crag_standard',
    inbound_protocol: 'openai.responses',
    target_family: 'claude_crag',
    request: {
      method: 'POST',
      path: '/v1/responses',
      headers: { 'user-agent': 'openai-node/4.80' },
      body: {
        model: 'claude-haiku-4-5',
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'inspect png' },
              { type: 'input_image', image_url: `data:image/png;base64,${TINY_PNG_B64}` },
            ],
          },
        ],
      },
    },
  })
  add({
    id: 'crag-messages-unknown-model-400',
    source: 'boundary_matrix',
    inbound_protocol: 'anthropic.messages',
    target_family: 'claude_crag',
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'user-agent': 'sdk/1.0' },
      body: {
        model: 'totally-unknown-model-xyz',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      },
    },
  })

  // =========================================================================
  // GROUP B: GEMINI CRAGGEMINI NATIVE CLI (agy 8-key SHM) (32 cases)
  // =========================================================================

  for (const stream of [false, true]) {
    const suffix = stream ? 'stream' : 'json'
    add({
      id: `gemini-native-basic-${suffix}`,
      source: 'gemini_standard',
      inbound_protocol: 'google.gemini',
      client_profile: 'official_gemini',
      target_family: 'gemini_craggemini',
      request: {
        method: 'POST',
        path: `/v1beta/models/gemini-4-hydrogen-high:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`,
        headers: { 'user-agent': 'google-genai-sdk/1.10', 'x-goog-api-client': 'genai-js/1.10' },
        body: {
          systemInstruction: { parts: [{ text: 'Answer directly.' }] },
          contents: [{ role: 'user', parts: [{ text: '样本 Ω\nline two' }] }],
          generationConfig: { maxOutputTokens: 512, temperature: 0.4 },
        },
      },
      mock_upstream: { mode: 'ok_text', stream },
    })
    add({
      id: `gemini-anthropic-basic-${suffix}`,
      source: 'gemini_standard',
      inbound_protocol: 'anthropic.messages',
      target_family: 'gemini_craggemini',
      request: {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'user-agent': 'anthropic-sdk/0.39' },
        body: {
          model: 'gemini-4-hydrogen-high',
          max_tokens: 512,
          stream,
          system: 'Answer directly.',
          messages: [{ role: 'user', content: '样本 Ω\nline two' }],
        },
      },
      mock_upstream: { mode: 'ok_text', stream },
    })
    add({
      id: `gemini-chat-basic-${suffix}`,
      source: 'gemini_standard',
      inbound_protocol: 'openai.chat',
      target_family: 'gemini_craggemini',
      request: {
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'user-agent': 'openai-node/4.80' },
        body: {
          model: 'gemini-4-hydrogen-high',
          max_tokens: 512,
          stream,
          messages: [
            { role: 'system', content: 'Answer directly.' },
            { role: 'user', content: '样本 Ω\nline two' },
          ],
        },
      },
      mock_upstream: { mode: 'ok_text', stream },
    })
    add({
      id: `gemini-responses-basic-${suffix}`,
      source: 'gemini_standard',
      inbound_protocol: 'openai.responses',
      target_family: 'gemini_craggemini',
      request: {
        method: 'POST',
        path: '/v1/responses',
        headers: { 'user-agent': 'openai-python/1.72' },
        body: {
          model: 'gemini-4-hydrogen-high',
          instructions: 'Answer directly.',
          max_output_tokens: 512,
          stream,
          input: '样本 Ω\nline two',
        },
      },
      mock_upstream: { mode: 'ok_text', stream },
    })
  }

  // B2: Anti-collision fingerprint stripping for CRAGGemini (v1.4.207 / v1.4.208 regressions!)
  for (const normMode of ['auto', 'strict', 'off']) {
    add({
      id: `gemini-strip-claude-code-429-triggers-${normMode}`,
      source: 'strip_matrix',
      inbound_protocol: 'anthropic.messages',
      client_profile: 'official_claude_code',
      target_family: 'gemini_craggemini',
      web_settings: {
        compatibility: {
          craggemini_persona_preset: 'official_full',
          craggemini_prompt_normalization: normMode,
        },
      },
      request: {
        method: 'POST',
        path: '/v1/messages',
        headers: { ...OFFICIAL_CC_HEADERS },
        body: {
          model: 'gemini-4-neon-xhigh',
          max_tokens: 1024,
          stream: false,
          system: [
            { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.321; cc_entrypoint=cli; cch=00000;' },
            { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
            {
              type: 'text',
              text: 'Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context.\n```md\nYou are Claude Code inside a fenced code block.\n```',
            },
          ],
          messages: [{ role: 'user', content: 'run /help and inspect <antigravity> tag' }],
        },
      },
    })
  }
  add({
    id: 'gemini-strip-opencode-native-envelope',
    source: 'strip_matrix',
    inbound_protocol: 'google.gemini',
    client_profile: 'opencode',
    target_family: 'gemini_craggemini',
    web_settings: { compatibility: { craggemini_prompt_normalization: 'auto' } },
    request: {
      method: 'POST',
      path: '/v1beta/models/gemini-4-neon-xhigh:generateContent',
      headers: { 'user-agent': 'opencode/0.9.1' },
      body: {
        systemInstruction: {
          parts: [
            {
              text: "You are Claude Code, Anthropic's official CLI for Claude.\nYou are OpenCode, an AI coding agent.",
            },
          ],
        },
        contents: [{ role: 'user', parts: [{ text: 'call ping_tool' }] }],
        tools: [
          {
            functionDeclarations: [
              { name: 'ping_tool', description: 'Ping', parameters: { type: 'object', properties: {} } },
            ],
          },
        ],
      },
    },
    mock_upstream: { mode: 'ok_tool_call', stream: false },
  })
  for (const preset of ['official_full', 'zero']) {
    add({
      id: `gemini-preset-${preset}-with-global-prompt`,
      source: 'gemini_standard',
      inbound_protocol: 'openai.chat',
      target_family: 'gemini_craggemini',
      web_settings: {
        compatibility: {
          craggemini_persona_preset: preset,
          craggemini_system_prompt: 'GLOBAL_GEMINI_POLICY_G1',
          craggemini_prompt_normalization: 'auto',
        },
      },
      request: {
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'user-agent': 'openai-node/4.80' },
        body: {
          model: 'gemini-4-hydrogen-high',
          messages: [
            { role: 'system', content: 'CALLER_SYSTEM_G2' },
            { role: 'user', content: 'hello gemini' },
          ],
        },
      },
    })
  }
  // B3: RestoreContext tool name sanitization (_x_) + thoughtSignature round-trip across all 4 protocols
  for (const [proto, reqPath, body] of [
    [
      'anthropic.messages',
      '/v1/messages',
      {
        model: 'gemini-4-hydrogen-high',
        max_tokens: 512,
        stream: true,
        tools: [
          {
            name: '123run-tool',
            description: 'Numeric prefix tool',
            input_schema: {
              type: 'object',
              $defs: { Arg: { type: 'string', enum: ['a', 'b'] } },
              properties: { mode: { $ref: '#/$defs/Arg' } },
              required: ['mode'],
            },
          },
        ],
        tool_choice: { type: 'tool', name: '123run-tool' },
        messages: [{ role: 'user', content: 'invoke 123run-tool' }],
      },
    ],
    [
      'openai.chat',
      '/v1/chat/completions',
      {
        model: 'gemini-4-hydrogen-high',
        stream: true,
        tools: [
          {
            type: 'function',
            function: {
              name: '-dash-tool',
              description: 'Dash prefix tool',
              parameters: { type: 'object', properties: { row: { type: 'integer' } } },
            },
          },
        ],
        tool_choice: { type: 'function', function: { name: '-dash-tool' } },
        messages: [{ role: 'user', content: 'invoke -dash-tool' }],
      },
    ],
    [
      'openai.responses',
      '/v1/responses',
      {
        model: 'gemini-4-hydrogen-high',
        stream: true,
        tools: [
          {
            type: 'function',
            name: 'lookup',
            parameters: { type: 'object', properties: { row: { type: 'integer' } } },
          },
        ],
        tool_choice: { type: 'function', name: 'lookup' },
        input: 'invoke lookup',
      },
    ],
    [
      'google.gemini',
      '/v1beta/models/gemini-4-hydrogen-high:streamGenerateContent?alt=sse',
      {
        contents: [{ role: 'user', parts: [{ text: 'invoke lookup' }] }],
        tools: [
          {
            functionDeclarations: [
              {
                name: 'lookup',
                description: 'Lookup',
                parameters: { type: 'object', properties: { row: { type: 'integer' } } },
              },
            ],
          },
        ],
        toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['lookup'] } },
      },
    ],
  ]) {
    add({
      id: `gemini-restore-tools-${proto.replace('.', '-')}`,
      source: 'gemini_standard',
      inbound_protocol: proto,
      target_family: 'gemini_craggemini',
      request: { method: 'POST', path: reqPath, headers: { 'user-agent': 'test-client/1.0' }, body },
      mock_upstream: { mode: 'ok_thinking_tool', stream: true },
    })
  }
  add({
    id: 'gemini-inline-png-and-multiturn',
    source: 'gemini_standard',
    inbound_protocol: 'google.gemini',
    target_family: 'gemini_craggemini',
    request: {
      method: 'POST',
      path: '/v1beta/models/gemini-4-hydrogen-high:generateContent',
      headers: { 'user-agent': 'google-genai-sdk/1.10' },
      body: {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'inspect png' }, { inlineData: { mimeType: 'image/png', data: TINY_PNG_B64 } }],
          },
          {
            role: 'model',
            parts: [{ functionCall: { id: 'fc_g1', name: 'lookup', args: { row: 7 } }, thoughtSignature: 'sig-gem-1' }],
          },
          {
            role: 'user',
            parts: [{ functionResponse: { id: 'fc_g1', name: 'lookup', response: { result: 'seven' } } }],
          },
        ],
      },
    },
  })
  add({
    id: 'gemini-snake-case-proto-keys',
    source: 'gemini_standard',
    inbound_protocol: 'google.gemini',
    target_family: 'gemini_craggemini',
    request: {
      method: 'POST',
      path: '/v1beta/models/gemini-4-hydrogen-high:generateContent',
      headers: { 'user-agent': 'google-genai-py/1.0' },
      body: {
        system_instruction: { parts: [{ text: 'Be helpful.' }] },
        generation_config: {
          max_output_tokens: 512,
          thinking_config: { thinking_budget: 2048, include_thoughts: true },
        },
        contents: [{ role: 'user', parts: [{ text: 'hello snake_case' }] }],
      },
    },
  })
  add({
    id: 'gemini-thinking-effort-anthropic',
    source: 'gemini_standard',
    inbound_protocol: 'anthropic.messages',
    target_family: 'gemini_craggemini',
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'user-agent': 'anthropic-sdk/0.39' },
      body: {
        model: 'gemini-4-carbon-high',
        max_tokens: 2048,
        thinking: { type: 'enabled', budget_tokens: 4096 },
        output_config: { effort: 'high' },
        messages: [{ role: 'user', content: 'reason carefully' }],
      },
    },
    mock_upstream: { mode: 'ok_thinking_tool', stream: false },
  })
  add({
    id: 'gemini-thinking-disabled-chat',
    source: 'gemini_standard',
    inbound_protocol: 'openai.chat',
    target_family: 'gemini_craggemini',
    request: {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'user-agent': 'openai-node/4.80' },
      body: {
        model: 'gemini-4-hydrogen-high',
        reasoning_effort: 'none',
        messages: [{ role: 'user', content: 'no thinking' }],
      },
    },
  })
  add({
    id: 'gemini-structured-output-chat',
    source: 'gemini_standard',
    inbound_protocol: 'openai.chat',
    target_family: 'gemini_craggemini',
    request: {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'user-agent': 'openai-node/4.80' },
      body: {
        model: 'gemini-4-hydrogen-high',
        messages: [{ role: 'user', content: 'return count' }],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'count_schema',
            schema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
          },
        },
      },
    },
  })
  add({
    id: 'gemini-protocol-disabled-403',
    source: 'passthrough_matrix',
    inbound_protocol: 'openai.chat',
    target_family: 'gemini_craggemini',
    web_settings: { gemini: { protocols: { 'openai.chat': { mode: 'reject', enabled: false } } } },
    request: {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'user-agent': 'openai-node/4.80' },
      body: { model: 'gemini-4-hydrogen-high', messages: [{ role: 'user', content: 'blocked' }] },
    },
  })
  add({
    id: 'gemini-multicandidate-unsupported',
    source: 'boundary_matrix',
    inbound_protocol: 'google.gemini',
    target_family: 'gemini_craggemini',
    request: {
      method: 'POST',
      path: '/v1beta/models/gemini-4-hydrogen-high:generateContent',
      headers: { 'user-agent': 'google-genai/1.0' },
      body: {
        contents: [{ role: 'user', parts: [{ text: 'sample' }] }],
        generationConfig: { candidateCount: 2 },
      },
    },
  })
  add({
    id: 'gemini-chat-multiturn-tool-results',
    source: 'multiturn_matrix',
    inbound_protocol: 'openai.chat',
    target_family: 'gemini_craggemini',
    request: {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'user-agent': 'openai-node/4.80' },
      body: {
        model: 'gemini-4-hydrogen-high',
        tools: [
          {
            type: 'function',
            function: { name: 'lookup', parameters: { type: 'object', properties: { row: { type: 'integer' } } } },
          },
        ],
        messages: [
          { role: 'user', content: 'lookup 7' },
          {
            role: 'assistant',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"row":7}' } }],
          },
          { role: 'tool', tool_call_id: 'c1', content: '{"val":7}' },
          { role: 'user', content: 'next step' },
        ],
      },
    },
  })
  add({
    id: 'gemini-anthropic-image-and-tool-result',
    source: 'gemini_standard',
    inbound_protocol: 'anthropic.messages',
    target_family: 'gemini_craggemini',
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'user-agent': 'anthropic-sdk/0.39' },
      body: {
        model: 'gemini-4-hydrogen-high',
        max_tokens: 512,
        tools: [{ name: 'view', input_schema: { type: 'object', properties: { file: { type: 'string' } } } }],
        messages: [
          { role: 'user', content: 'view img.png' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'view', input: { file: 'img.png' } }] },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_1',
                content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_B64 } }],
              },
            ],
          },
        ],
      },
    },
  })
  add({
    id: 'gemini-responses-reasoning-effort-high',
    source: 'gemini_standard',
    inbound_protocol: 'openai.responses',
    target_family: 'gemini_craggemini',
    request: {
      method: 'POST',
      path: '/v1/responses',
      headers: { 'user-agent': 'openai-python/1.72' },
      body: {
        model: 'gemini-4-carbon-high',
        reasoning: { effort: 'high' },
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'analyze architecture' }] }],
      },
    },
  })
  add({
    id: 'gemini-web-search-anthropic',
    source: 'gemini_standard',
    inbound_protocol: 'anthropic.messages',
    target_family: 'gemini_craggemini',
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'user-agent': 'anthropic-sdk/0.39' },
      body: {
        model: 'gemini-4-hydrogen-high',
        max_tokens: 512,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: 'latest release notes' }],
      },
    },
  })
  add({
    id: 'gemini-passthrough-official-vs-third-party-slash',
    source: 'passthrough_matrix',
    inbound_protocol: 'google.gemini',
    client_profile: 'official_gemini',
    target_family: 'gemini_craggemini',
    web_settings: { compatibility: { craggemini_prompt_normalization: 'strict' } },
    request: {
      method: 'POST',
      path: '/v1beta/models/gemini-4-hydrogen-high:generateContent',
      headers: { 'user-agent': 'google-genai-sdk/1.10' },
      body: {
        contents: [{ role: 'user', parts: [{ text: '/plan create baseline' }] }],
      },
    },
  })
  add({
    id: 'gemini-upstream-error-400',
    source: 'boundary_matrix',
    inbound_protocol: 'openai.chat',
    target_family: 'gemini_craggemini',
    request: {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'user-agent': 'openai-node/4.80' },
      body: { model: 'gemini-4-hydrogen-high', messages: [{ role: 'user', content: 'trigger 400' }] },
    },
    mock_upstream: { mode: 'http_400', stream: false },
  })
  add({
    id: 'gemini-responses-json-schema',
    source: 'gemini_standard',
    inbound_protocol: 'openai.responses',
    target_family: 'gemini_craggemini',
    request: {
      method: 'POST',
      path: '/v1/responses',
      headers: { 'user-agent': 'openai-python/1.72' },
      body: {
        model: 'gemini-4-hydrogen-high',
        input: 'return json',
        text: {
          format: {
            type: 'json_schema',
            name: 'res',
            schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
          },
        },
      },
    },
  })
  add({
    id: 'gemini-chat-non-stream-tool-call',
    source: 'gemini_standard',
    inbound_protocol: 'openai.chat',
    target_family: 'gemini_craggemini',
    request: {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'user-agent': 'openai-node/4.80' },
      body: {
        model: 'gemini-4-hydrogen-high',
        stream: false,
        tools: [
          {
            type: 'function',
            function: { name: 'lookup', parameters: { type: 'object', properties: { row: { type: 'integer' } } } },
          },
        ],
        messages: [{ role: 'user', content: 'call lookup' }],
      },
    },
    mock_upstream: { mode: 'ok_tool_call', stream: false },
  })

  // =========================================================================
  // GROUP C: CODEX NATIVE KERNEL (kin-codex-kernel) (24 cases)
  // =========================================================================

  for (const stream of [false, true]) {
    const suffix = stream ? 'stream' : 'json'
    add({
      id: `codex-responses-official-${suffix}`,
      source: 'codex_standard',
      inbound_protocol: 'openai.responses',
      client_profile: 'official_codex',
      target_family: 'codex_kernel',
      web_settings: { sticky: { outbound_session: 'rebuild' } },
      request: {
        method: 'POST',
        path: '/v1/responses',
        headers: { ...OFFICIAL_CODEX_HEADERS, 'x-custom-leak': 'drop-me' },
        body: {
          model: 'gpt-5.4',
          instructions: 'You are Codex.',
          stream,
          reasoning: { effort: 'high' },
          prompt_cache_key: 'caller-cache-key-must-be-rebuilt',
          conversation_id: 'conv-caller-strip',
          session_id: 'sess-caller-strip',
          base_url: 'https://caller.internal',
          metadata: { user_id: 'u1', device_id: 'd1', installation_id: 'inst1', keep_tag: 'ok' },
          input: [{ role: 'user', content: [{ type: 'input_text', text: '样本 Ω\nline two' }] }],
        },
      },
      mock_upstream: { mode: 'ok_text', stream },
    })
    add({
      id: `codex-chat-convert-${suffix}`,
      source: 'codex_standard',
      inbound_protocol: 'openai.chat',
      client_profile: 'openai_compatible',
      target_family: 'codex_kernel',
      request: {
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'user-agent': 'openai-node/4.80' },
        body: {
          model: 'gpt-5.4',
          stream,
          reasoning_effort: 'medium',
          max_completion_tokens: 512,
          messages: [
            { role: 'system', content: 'Be terse.' },
            { role: 'user', content: '样本 Ω\nline two' },
          ],
          tools: [
            {
              type: 'function',
              function: {
                name: 'lookup',
                description: 'Lookup row',
                parameters: { type: 'object', properties: { row: { type: 'integer' } } },
              },
            },
          ],
          tool_choice: { type: 'function', function: { name: 'lookup' } },
        },
      },
      mock_upstream: { mode: 'ok_tool_call', stream },
    })
    add({
      id: `codex-completions-convert-${suffix}`,
      source: 'codex_standard',
      inbound_protocol: 'openai.completions',
      client_profile: 'openai_compatible',
      target_family: 'codex_kernel',
      ...(stream ? { expected_improvement: 'G4' } : {}),
      request: {
        method: 'POST',
        path: '/v1/completions',
        headers: { 'user-agent': 'openai-python/1.60' },
        body: {
          model: 'gpt-5.4',
          prompt: 'complete this line',
          max_tokens: 128,
          stream,
        },
      },
      mock_upstream: { mode: 'ok_text', stream },
    })
    add({
      id: `codex-anthropic-convert-${suffix}`,
      source: 'codex_standard',
      inbound_protocol: 'anthropic.messages',
      client_profile: 'openai_compatible',
      target_family: 'codex_kernel',
      expected_improvement: 'G2',
      request: {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'user-agent': 'custom-anthropic-bridge/1.0' },
        body: {
          model: 'gpt-5.4',
          max_tokens: 1024,
          stream,
          system: 'Follow strict format.',
          thinking: { type: 'enabled', budget_tokens: 2048 },
          output_config: { effort: 'high' },
          stop_sequences: ['HALT'],
          tools: [
            {
              name: 'lookup',
              description: 'Lookup',
              input_schema: { type: 'object', properties: { row: { type: 'integer' } } },
            },
          ],
          messages: [{ role: 'user', content: 'think and lookup row 7' }],
        },
      },
      mock_upstream: { mode: 'ok_thinking_tool', stream },
    })
  }

  add({
    id: 'codex-gemini-cross-json',
    source: 'codex_standard',
    inbound_protocol: 'google.gemini',
    client_profile: 'openai_compatible',
    target_family: 'codex_kernel',
    expected_improvement: 'G1',
    request: {
      method: 'POST',
      path: '/v1beta/models/gpt-5.4:generateContent',
      headers: { 'user-agent': 'google-genai/1.0' },
      body: {
        systemInstruction: { parts: [{ text: 'Be concise.' }] },
        contents: [{ role: 'user', parts: [{ text: 'hello gpt from gemini' }] }],
        generationConfig: { maxOutputTokens: 256 },
      },
    },
  })
  add({
    id: 'codex-responses-session-passthrough-mode',
    source: 'passthrough_matrix',
    inbound_protocol: 'openai.responses',
    client_profile: 'official_codex',
    target_family: 'codex_kernel',
    web_settings: { sticky: { outbound_session: 'passthrough' } },
    request: {
      method: 'POST',
      path: '/v1/responses',
      headers: { ...OFFICIAL_CODEX_HEADERS },
      body: {
        model: 'gpt-5.4',
        prompt_cache_key: 'keep-this-official-key',
        input: 'session passthrough check',
      },
    },
  })
  add({
    id: 'codex-responses-third-party-strict-non-passthrough',
    source: 'passthrough_matrix',
    inbound_protocol: 'openai.responses',
    client_profile: 'openai_compatible',
    target_family: 'codex_kernel',
    expected_improvement: 'strict_codex_passthrough',
    web_settings: { codex: { official_passthrough: true } },
    request: {
      method: 'POST',
      path: '/v1/responses',
      headers: { 'user-agent': 'openai-node/4.80' },
      body: {
        model: 'gpt-5.4',
        base_url: 'https://third-party.local',
        endpoint: 'http://internal:9999',
        api_key: 'sk-leak',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'third party responses' }] }],
      },
    },
  })
  add({
    id: 'codex-responses-official-switch-off',
    source: 'passthrough_matrix',
    inbound_protocol: 'openai.responses',
    client_profile: 'official_codex',
    target_family: 'codex_kernel',
    expected_improvement: 'strict_codex_passthrough',
    web_settings: { codex: { official_passthrough: false } },
    request: {
      method: 'POST',
      path: '/v1/responses',
      headers: { ...OFFICIAL_CODEX_HEADERS },
      body: {
        model: 'gpt-5.4',
        base_url: 'https://official-switch-off.local',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'official codex with switch off' }] }],
      },
    },
  })
  add({
    id: 'gemini-native-official-switch-off',
    source: 'passthrough_matrix',
    inbound_protocol: 'google.gemini',
    client_profile: 'official_gemini',
    target_family: 'gemini_craggemini',
    web_settings: { gemini: { official_passthrough: false } },
    request: {
      method: 'POST',
      path: '/v1beta/models/gemini-4-hydrogen-high:generateContent',
      headers: { 'user-agent': 'google-genai-sdk/1.10' },
      body: {
        contents: [{ role: 'user', parts: [{ text: 'official gemini with switch off' }] }],
      },
    },
  })
  add({
    id: 'codex-reject-claude-code-ua-403',
    source: 'passthrough_matrix',
    inbound_protocol: 'openai.responses',
    client_profile: 'official_claude_code',
    target_family: 'codex_kernel',
    request: {
      method: 'POST',
      path: '/v1/responses',
      headers: { 'user-agent': 'claude-cli/2.1.321 (external, sdk-cli)' },
      body: { model: 'gpt-5.4', input: 'should reject claude_code ua' },
    },
  })
  add({
    id: 'codex-strip-claudeseal-encrypted-reasoning',
    source: 'strip_matrix',
    inbound_protocol: 'openai.responses',
    client_profile: 'official_codex',
    target_family: 'codex_kernel',
    expected_improvement: 'strip_claudeseal',
    request: {
      method: 'POST',
      path: '/v1/responses',
      headers: { ...OFFICIAL_CODEX_HEADERS },
      body: {
        model: 'gpt-5.4',
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'prev turn' }] },
          { type: 'reasoning', encrypted_content: 'magpie-claude1:eyJ0eXBlIjoidGhpbmtpbmcifQ==', summary: [] },
          { role: 'user', content: [{ type: 'input_text', text: 'next turn on codex' }] },
        ],
      },
    },
  })
  add({
    id: 'codex-chat-multiturn-image-and-tools',
    source: 'multiturn_matrix',
    inbound_protocol: 'openai.chat',
    client_profile: 'openai_compatible',
    target_family: 'codex_kernel',
    request: {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'user-agent': 'openai-node/4.80' },
      body: {
        model: 'gpt-5.4',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'inspect and lookup' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${TINY_PNG_B64}` } },
            ],
          },
          {
            role: 'assistant',
            tool_calls: [{ id: 'c_1', type: 'function', function: { name: 'lookup', arguments: '{"row":7}' } }],
          },
          { role: 'tool', tool_call_id: 'c_1', content: 'seven' },
          { role: 'user', content: 'done?' },
        ],
      },
    },
  })
  add({
    id: 'codex-fast-alias-service-tier',
    source: 'codex_standard',
    inbound_protocol: 'openai.responses',
    client_profile: 'official_codex',
    target_family: 'codex_kernel',
    request: {
      method: 'POST',
      path: '/v1/responses',
      headers: { ...OFFICIAL_CODEX_HEADERS },
      body: { model: 'gpt-5.4', service_tier: 'priority', input: 'fast tier check' },
    },
  })
  add({
    id: 'codex-upstream-http-400',
    source: 'boundary_matrix',
    inbound_protocol: 'openai.chat',
    client_profile: 'openai_compatible',
    target_family: 'codex_kernel',
    request: {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'user-agent': 'openai-node/4.80' },
      body: { model: 'gpt-5.4', messages: [{ role: 'user', content: 'trigger 400' }] },
    },
    mock_upstream: { mode: 'http_400', stream: false },
  })
  for (let i = 1; i <= 8; i++) {
    add({
      id: `codex-chat-variant-${String(i).padStart(2, '0')}`,
      source: 'codex_standard',
      inbound_protocol: i % 2 === 0 ? 'openai.responses' : 'openai.chat',
      client_profile: i % 2 === 0 ? 'official_codex' : 'openai_compatible',
      target_family: 'codex_kernel',
      request: {
        method: 'POST',
        path: i % 2 === 0 ? '/v1/responses' : '/v1/chat/completions',
        headers: i % 2 === 0 ? { ...OFFICIAL_CODEX_HEADERS } : { 'user-agent': 'openai-node/4.80' },
        body:
          i % 2 === 0
            ? { model: 'gpt-5.4', input: `Codex corpus sample #${i}`, max_output_tokens: 64 + i * 16 }
            : {
                model: 'gpt-5.4',
                max_completion_tokens: 64 + i * 16,
                messages: [{ role: 'user', content: `Codex chat sample #${i}` }],
              },
      },
    })
  }

  // =========================================================================
  // GROUP D: EXTERNAL API CHANNELS (api_anthropic, api_openai, api_gemini) (16 cases)
  // =========================================================================

  add({
    id: 'api-anthropic-messages-default',
    source: 'api_standard',
    inbound_protocol: 'anthropic.messages',
    target_family: 'api_anthropic',
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'user-agent': 'anthropic-sdk/0.39' },
      body: { model: 'relay/sonnet', max_tokens: 256, messages: [{ role: 'user', content: 'hello api anthropic' }] },
    },
  })
  add({
    id: 'api-anthropic-messages-caller-policy',
    source: 'passthrough_matrix',
    inbound_protocol: 'anthropic.messages',
    client_profile: 'official_claude_code',
    target_family: 'api_anthropic',
    web_settings: { endpoint_body_policy: 'caller', compatibility: { official_cc_passthrough: true } },
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: { ...OFFICIAL_CC_HEADERS },
      body: {
        model: 'relay/sonnet',
        max_tokens: 256,
        system: OFFICIAL_CC_SYSTEM,
        metadata: { user_id: OFFICIAL_CC_USER_ID },
        messages: [{ role: 'user', content: 'caller body policy passthrough' }],
      },
    },
  })
  add({
    id: 'api-anthropic-from-chat-json',
    source: 'api_standard',
    inbound_protocol: 'openai.chat',
    target_family: 'api_anthropic',
    request: {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'user-agent': 'openai-node/4.80' },
      body: {
        model: 'relay/sonnet',
        max_tokens: 256,
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'chat to api anthropic' },
        ],
      },
    },
  })
  add({
    id: 'api-anthropic-from-responses-stream',
    source: 'api_standard',
    inbound_protocol: 'openai.responses',
    target_family: 'api_anthropic',
    request: {
      method: 'POST',
      path: '/v1/responses',
      headers: { 'user-agent': 'openai-python/1.72' },
      body: { model: 'relay/sonnet', stream: true, input: 'responses to api anthropic' },
    },
    mock_upstream: { mode: 'ok_text', stream: true },
  })
  add({
    id: 'api-openai-from-responses-json',
    source: 'api_standard',
    inbound_protocol: 'openai.responses',
    target_family: 'api_openai',
    request: {
      method: 'POST',
      path: '/v1/responses',
      headers: { 'user-agent': 'openai-node/4.80' },
      body: { model: 'api-gpt-5.4', input: 'hello api openai', reasoning: { effort: 'low' } },
    },
  })
  add({
    id: 'api-openai-from-chat-json',
    source: 'api_standard',
    inbound_protocol: 'openai.chat',
    target_family: 'api_openai',
    request: {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'user-agent': 'openai-node/4.80' },
      body: {
        model: 'api-gpt-5.4',
        reasoning_effort: 'low',
        temperature: 0.2,
        parallel_tool_calls: false,
        messages: [{ role: 'user', content: 'chat to api openai' }],
      },
    },
  })
  add({
    id: 'api-openai-from-anthropic-image-and-thinking',
    source: 'api_standard',
    inbound_protocol: 'anthropic.messages',
    target_family: 'api_openai',
    expected_improvement: 'G3',
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'user-agent': 'anthropic-sdk/0.39' },
      body: {
        model: 'api-gpt-5.4',
        max_tokens: 512,
        thinking: { type: 'enabled', budget_tokens: 1024 },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'inspect image on api openai' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_B64 } },
            ],
          },
        ],
      },
    },
  })
  add({
    id: 'api-openai-reject-shared-stateful-field',
    source: 'boundary_matrix',
    inbound_protocol: 'openai.responses',
    target_family: 'api_openai',
    request: {
      method: 'POST',
      path: '/v1/responses',
      headers: { 'user-agent': 'openai-node/4.80' },
      body: { model: 'api-gpt-5.4', previous_response_id: 'resp_other_key', input: 'hi' },
    },
  })
  for (const [proto, reqPath, body] of [
    [
      'google.gemini',
      '/v1beta/models/api-gemini-2.5-pro:generateContent',
      { contents: [{ role: 'user', parts: [{ text: 'hello api gemini' }] }] },
    ],
    [
      'anthropic.messages',
      '/v1/messages',
      {
        model: 'api-gemini-2.5-pro',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'anthropic to api gemini' }],
      },
    ],
    [
      'openai.chat',
      '/v1/chat/completions',
      { model: 'api-gemini-2.5-pro', messages: [{ role: 'user', content: 'chat to api gemini' }] },
    ],
    ['openai.responses', '/v1/responses', { model: 'api-gemini-2.5-pro', input: 'responses to api gemini' }],
  ]) {
    add({
      id: `api-gemini-from-${proto.replace('.', '-')}`,
      source: 'api_standard',
      inbound_protocol: proto,
      target_family: 'api_gemini',
      request: { method: 'POST', path: reqPath, headers: { 'user-agent': 'sdk/1.0' }, body },
    })
  }

  // Additional realistic multi-turn / long-context Claude cases to exceed 110 total cases
  for (let i = 1; i <= 12; i++) {
    const protoList = ['anthropic.messages', 'openai.chat', 'openai.responses', 'openai.completions']
    const proto = protoList[(i - 1) % protoList.length]
    const reqPath =
      proto === 'anthropic.messages'
        ? '/v1/messages'
        : proto === 'openai.chat'
          ? '/v1/chat/completions'
          : proto === 'openai.responses'
            ? '/v1/responses'
            : '/v1/completions'
    const body =
      proto === 'anthropic.messages'
        ? {
            model: 'claude-haiku-4-5',
            max_tokens: 256 + i * 32,
            system: `Project constraint #${i}`,
            messages: [
              { role: 'user', content: `Task ${i}: analyze module ${i}` },
              { role: 'assistant', content: `Checked module ${i}.` },
              { role: 'user', content: `Now summarize finding ${i}.` },
            ],
          }
        : proto === 'openai.chat'
          ? {
              model: 'claude-haiku-4-5',
              max_completion_tokens: 256 + i * 32,
              messages: [
                { role: 'system', content: `Project constraint #${i}` },
                { role: 'user', content: `Task ${i}: analyze module ${i}` },
                { role: 'assistant', content: `Checked module ${i}.` },
                { role: 'user', content: `Now summarize finding ${i}.` },
              ],
            }
          : proto === 'openai.responses'
            ? {
                model: 'claude-haiku-4-5',
                instructions: `Project constraint #${i}`,
                max_output_tokens: 256 + i * 32,
                input: [
                  { role: 'user', content: [{ type: 'input_text', text: `Task ${i}: analyze module ${i}` }] },
                  { role: 'assistant', content: [{ type: 'output_text', text: `Checked module ${i}.` }] },
                  { role: 'user', content: [{ type: 'input_text', text: `Now summarize finding ${i}.` }] },
                ],
              }
            : {
                model: 'claude-haiku-4-5',
                prompt: `Task ${i}: complete summary for module ${i}.`,
                max_tokens: 128 + i * 16,
              }
    add({
      id: `crag-multiturn-matrix-${String(i).padStart(2, '0')}-${proto.replace('.', '-')}`,
      source: 'multiturn_matrix',
      inbound_protocol: proto,
      target_family: 'claude_crag',
      request: { method: 'POST', path: reqPath, headers: { 'user-agent': 'benchmark-client/1.0' }, body },
    })
  }

  return cases
}

const cases = buildCases()
const ids = cases.map((c) => c.id)
if (ids.length !== new Set(ids).size) {
  throw new Error('Duplicate case IDs detected!')
}
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })
fs.writeFileSync(OUT_FILE, JSON.stringify({ version: 1, count: cases.length, cases }, null, 2) + '\n')

const byTarget = {}
const byProto = {}
for (const c of cases) {
  byTarget[c.target_family] = (byTarget[c.target_family] || 0) + 1
  byProto[c.inbound_protocol] = (byProto[c.inbound_protocol] || 0) + 1
}
console.log(`Generated ${cases.length} sanitized baseline cases -> ${OUT_FILE}`)
console.log('By target_family:', JSON.stringify(byTarget))
console.log('By inbound_protocol:', JSON.stringify(byProto))
