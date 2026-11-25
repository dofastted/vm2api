import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  bootProtoFront,
  compileWithProtoFront,
  protoFrontHealth,
  protoFrontMode,
  protoFrontPaths,
  shutdownProtoFront,
  transcodeWithProtoFront,
} from '../../src/lib/transport/proto-front-client.mjs'
import { normalizeCodexRouting, validateInferenceWebsocketPatch } from '../../src/lib/protocol/codex-route.mjs'
import { normalizeGeminiRouting, validateGeminiRoutingPatch } from '../../src/lib/gemini/routing-config.mjs'

test('Web Settings official_passthrough switches normalize and validate cleanly for Codex and Gemini', () => {
  assert.equal(normalizeCodexRouting({}).official_passthrough, true)
  assert.equal(normalizeCodexRouting({ official_passthrough: false }).official_passthrough, false)
  assert.doesNotThrow(() => validateInferenceWebsocketPatch({ codex: { official_passthrough: false } }))
  assert.throws(() => validateInferenceWebsocketPatch({ codex: { official_passthrough: 'yes' } }), /布尔/)

  assert.equal(normalizeGeminiRouting({}).official_passthrough, true)
  assert.equal(normalizeGeminiRouting({ official_passthrough: false }).official_passthrough, false)
  assert.doesNotThrow(() => validateGeminiRoutingPatch({ gemini: { official_passthrough: false } }))
  assert.throws(() => validateGeminiRoutingPatch({ gemini: { official_passthrough: 1 } }), /布尔/)
})

test('protoFrontMode defaults to node and recognizes go/shadow', () => {
  const prev = process.env.KIN_PROTO_FRONT
  try {
    delete process.env.KIN_PROTO_FRONT
    assert.equal(protoFrontMode(), 'node')
    process.env.KIN_PROTO_FRONT = 'go'
    assert.equal(protoFrontMode(), 'go')
    process.env.KIN_PROTO_FRONT = 'shadow'
    assert.equal(protoFrontMode(), 'shadow')
    process.env.KIN_PROTO_FRONT = 'invalid'
    assert.equal(protoFrontMode(), 'node')
  } finally {
    if (prev === undefined) delete process.env.KIN_PROTO_FRONT
    else process.env.KIN_PROTO_FRONT = prev
  }
})

test('kin-proto-front UDS sidecar enforces double-gate passthrough, anti-collision strip, and G1-G4', async (t) => {
  const paths = protoFrontPaths()
  if (!fs.existsSync(paths.binPath)) {
    t.skip(`bin/kin-proto-front not built (${paths.binPath})`)
    return
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-pf-test-'))
  const prevMode = process.env.KIN_PROTO_FRONT
  const prevSock = process.env.KIN_PROTO_FRONT_SOCK
  const prevTok = process.env.KIN_PROTO_FRONT_TOKEN
  process.env.KIN_PROTO_FRONT = 'go'
  process.env.KIN_PROTO_FRONT_SOCK = path.join(tmpDir, 'run', 'proto-front.sock')
  process.env.KIN_PROTO_FRONT_TOKEN = path.join(tmpDir, 'run', 'proto-front.token')
  const cfg = { paths: { data: tmpDir, project: tmpDir } }

  try {
    const booted = await bootProtoFront(cfg, { detached: false, waitMs: 5000 })
    assert.equal(booted.ok, true)
    const health = await protoFrontHealth(cfg)
    assert.equal(health.ok, true)

    // 1. Official CC + switch ON -> passthrough; spoofed oh-my-pi + switch ON -> convert
    const uid = JSON.stringify({
      device_id: 'a'.repeat(64),
      account_uuid: '10000000-0000-4000-a000-000000000001',
      session_id: '20000000-0000-4000-a000-000000000002',
    })
    const officialBody = {
      model: 'claude-sonnet-5-5',
      max_tokens: 1024,
      system: [
        { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.321; cc_entrypoint=sdk-cli; cch=00000;' },
        {
          type: 'text',
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
          cache_control: { type: 'ephemeral' },
        },
      ],
      metadata: { user_id: uid },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    }
    const rOn = await compileWithProtoFront({
      cfg,
      inboundProtocol: 'anthropic.messages',
      targetFamily: 'claude_crag',
      headers: { 'user-agent': 'claude-cli/2.1.321 (external, sdk-cli)', 'anthropic-beta': 'claude-code-20250219' },
      body: officialBody,
      routing: { compatibility: { official_cc_passthrough: true } },
    })
    assert.equal(rOn.ok, true)
    assert.equal(rOn.mode, 'passthrough')
    assert.equal(rOn.decision.allow_passthrough, true)

    const rSpoof = await compileWithProtoFront({
      cfg,
      inboundProtocol: 'anthropic.messages',
      targetFamily: 'claude_crag',
      headers: { 'user-agent': 'claude-cli/2.1.321 (oh-my-pi)' },
      body: officialBody,
      routing: { compatibility: { official_cc_passthrough: true } },
    })
    assert.equal(rSpoof.ok, true)
    assert.equal(rSpoof.mode, 'convert')
    assert.equal(rSpoof.decision.allow_passthrough, false)

    // 2. Codex strips magpie-claude1: claudeseal even on official passthrough
    const rSeal = await compileWithProtoFront({
      cfg,
      inboundProtocol: 'openai.responses',
      targetFamily: 'codex_kernel',
      headers: { 'user-agent': 'codex_cli_rs/0.170.0', originator: 'codex_cli_rs' },
      body: {
        model: 'gpt-5.4',
        base_url: 'https://internal.local',
        input: [
          { type: 'reasoning', encrypted_content: 'magpie-claude1:eyJ0eXBlIjoidGhpbmtpbmcifQ==', summary: [] },
          { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        ],
      },
      outboundSessionId: 'sess-rebuilt-1',
    })
    assert.equal(rSeal.ok, true)
    assert.equal(rSeal.mode, 'passthrough')
    assert.equal(JSON.stringify(rSeal.outbound_body).includes('magpie-claude1:'), false)
    assert.equal(rSeal.outbound_body.prompt_cache_key, 'sess-rebuilt-1')

    // 3. G1 Gemini -> Claude CRAG & G3 Anthropic -> API OpenAI image+thinking
    const rG1 = await compileWithProtoFront({
      cfg,
      inboundProtocol: 'google.gemini',
      targetFamily: 'claude_crag',
      routeModel: 'claude-haiku-4-5',
      routeStream: false,
      body: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
    })
    assert.equal(rG1.ok, true)
    assert.equal(rG1.outbound_body.model, 'claude-haiku-4-5')

    const rG3 = await compileWithProtoFront({
      cfg,
      inboundProtocol: 'anthropic.messages',
      targetFamily: 'api_openai',
      body: {
        model: 'api-gpt-5.4',
        thinking: { type: 'enabled', budget_tokens: 1024 },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'see image' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            ],
          },
        ],
      },
    })
    assert.equal(rG3.ok, true)
    assert.equal(JSON.stringify(rG3.outbound_body).includes('input_image'), true)
    assert.ok(rG3.outbound_body.reasoning?.effort)

    // 4. G4 Codex SSE -> text_completion SSE
    const tcG4 = await transcodeWithProtoFront({
      cfg,
      upstreamProtocol: 'openai.responses',
      inboundProtocol: 'openai.completions',
      model: 'gpt-5.4',
      stream: true,
      payload: [
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"hello"}',
        '',
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.4","usage":{"input_tokens":5,"output_tokens":2}}}',
        '',
      ].join('\n'),
    })
    assert.equal(tcG4.ok, true)
    assert.equal(tcG4.body.includes('"object":"text_completion"'), true)
  } finally {
    shutdownProtoFront(process.env.KIN_PROTO_FRONT_SOCK)
    if (prevMode === undefined) delete process.env.KIN_PROTO_FRONT
    else process.env.KIN_PROTO_FRONT = prevMode
    if (prevSock === undefined) delete process.env.KIN_PROTO_FRONT_SOCK
    else process.env.KIN_PROTO_FRONT_SOCK = prevSock
    if (prevTok === undefined) delete process.env.KIN_PROTO_FRONT_TOKEN
    else process.env.KIN_PROTO_FRONT_TOKEN = prevTok
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
