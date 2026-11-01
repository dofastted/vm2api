import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DEFAULT_PERSONA_TEMPLATES } from '../../src/lib/identity/persona-template.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import {
  clearConversationCacheTtls,
  listCacheMarkers,
  validateCacheBreakpoints,
} from '../../src/lib/protocol/cache-ttl.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { clearCachePrefixSessions } from '../../src/lib/protocol/cache-prefix.mjs'

const unixTest = process.platform === 'win32' ? test.skip : test
const control = (ttl) => ({ type: 'ephemeral', ...(ttl ? { ttl } : {}) })
const text = (value, ttl) => ({ type: 'text', text: value, ...(ttl === null ? {} : { cache_control: control(ttl) }) })
const model = 'claude-opus-5-5'

// Capture at the transport boundary after conversion, persona rendering and
// slot selection. API requests go through the real local-kernel client.
async function outbound(
  t,
  { preset, backend = 'cli', compatibility = {}, input = {}, headers = {}, protocol = 'anthropic.messages' },
) {
  clearConversationCacheTtls()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-outbound-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const routing = {
    sticky: { outbound_session: 'passthrough' },
    compatibility: { persona_preset: preset, overlay_preset: 'off', cache_ttl: '1h', ...compatibility },
  }
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify(routing))
  const incoming = { model, max_tokens: 128, stream: false, messages: [{ role: 'user', content: 'Hello' }], ...input }
  const before = structuredClone(incoming)
  const sent = []
  const message = {
    id: 'fixture',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: 'OK' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1000, output_tokens: 1 },
  }
  if (backend === 'api') {
    const socket = path.join(root, 'run', 'api-kernel.sock')
    fs.mkdirSync(path.dirname(socket), { recursive: true })
    const kernel = http.createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      sent.push(JSON.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')).body))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const emit = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`)
      emit({ type: 'message_start', message: { ...message, content: [] } })
      emit({ type: 'content_block_start', index: 0, content_block: message.content[0] })
      emit({ type: 'content_block_stop', index: 0 })
      emit({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
      emit({ type: 'message_stop' })
      res.end()
    })
    await new Promise((resolve, reject) => {
      kernel.once('error', reject)
      kernel.listen(socket, resolve)
    })
    t.after(() => new Promise((resolve) => kernel.close(resolve)))
  }
  const vm = { id: 'fixture-slot', persona_preset: preset, official_cc_inference: 'cli-hop' }
  const runner = new FailoverRunner({
    scheduler: {
      async selectAndReserve() {
        return { ok: true, vmId: vm.id, accountId: vm.id, vm, exec: { vmId: vm.id, vm, homeDir: root }, release() {} }
      },
      markSuccess() {},
      markCooldown() {},
      releaseAccountSessions() {},
    },
    config: { max_same_account_retries: 0 },
  })
  const response = { headersSent: false, on() {}, once() {}, off() {}, write() {}, end() {} }
  const handler = createHandleProtocol({
    json(_res, status, body) {
      response.status = status
      response.body = body
      return body
    },
    writeSSEHeaders() {},
    readBody: async () => structuredClone(incoming),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000 },
      paths: { data: root, project: root },
    },
    requestLog: { start: () => ({ request_id: 'persona-outbound-fixture' }), finish() {} },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: { ingestHeaders() {} },
    apiKeyStore: { acquire: () => ({ ok: true }), release() {}, recordUsage() {} },
    apiScheduler: {
      pick: () => ({
        ok: true,
        endpoint: { id: 'fixture', kind: 'claude', protocol: 'anthropic', base_url: 'https://upstream.invalid' },
        upstream_model: incoming.model,
        key: { id: 'fixture', api_key: 'fixture-not-secret' },
      }),
    },
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: routing,
    groupsRepo: { rateMultiplier: () => 1 },
    failoverRunner: {
      run(opts) {
        return runner.run({
          ...opts,
          callAttempt({ body }) {
            sent.push(structuredClone(body))
            return { ok: true, status: 200, terminalState: 'verified', body: structuredClone(message) }
          },
        })
      },
    },
  })
  const url = { 'anthropic.messages': '/v1/messages', 'openai.chat': '/v1/chat/completions' }[protocol]
  await handler.handleProtocol(
    {
      method: 'POST',
      url,
      headers: { authorization: 'Bearer fixture', 'user-agent': 'test-client', ...headers },
      apiKeyKind: 'managed',
      apiKeyRecord: { id: 'fixture', ...(backend === 'api' ? { category: 'api' } : {}) },
      once() {},
      off() {},
    },
    response,
    protocol,
    url,
  )
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.equal(sent.length, 1)
  assert.deepEqual(incoming, before)
  validateCacheBreakpoints(sent[0])
  return sent[0]
}

const history = () =>
  Array.from({ length: 9 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: [text(`m${i}`, null)],
  }))
const messageMarkers = (body) => listCacheMarkers(body).filter((marker) => marker.section === 'messages')

for (const backend of ['cli', 'api']) {
  const run = backend === 'api' ? unixTest : test
  for (const requestedModel of backend === 'cli' ? ['claude-opus-5-5', 'claude-sonnet-5'] : [model]) {
    for (const shortTtl of [undefined, '5m']) {
      for (const placement of ['mid-system', 'agent-first']) {
        run(
          `${backend} ${requestedModel} zero ${placement} retains legal TTL order with ${shortTtl ?? 'implicit 5m'}`,
          async (t) => {
            const system =
              placement === 'mid-system'
                ? [text('CALLER_RULE_HOUR', '1h')]
                : [
                    text('CALLER_RULE_HOUR', '1h'),
                    text('Help the user complete the current request. AGENT_RULE_FIVE', shortTtl),
                  ]
            const messages = [{ role: 'user', content: [text('Hello', placement === 'mid-system' ? shortTtl : null)] }]
            const blocks =
              placement === 'mid-system'
                ? [{ id: 'instructions', role: 'system', type: 'text', text: '{{caller_system}}' }]
                : [
                    { id: 'agent', type: 'text', text: '{{caller_agent}}' },
                    { id: 'instructions', type: 'text', text: '{{caller_system}}' },
                  ]
            validateCacheBreakpoints({ system, messages })
            const out = await outbound(t, {
              preset: 'zero',
              backend,
              headers: { 'x-kin-cache-ttl': '1h' },
              compatibility: { persona_templates: { zero: [...DEFAULT_PERSONA_TEMPLATES.zero, ...blocks] } },
              input: { model: requestedModel, system, messages },
            })
            assert.deepEqual(
              listCacheMarkers(out).map((marker) => marker.ttl),
              ['1h', shortTtl ?? null],
            )
            for (const source of system) assert.equal(JSON.stringify(out).split(source.text).length - 1, 1)
            if (placement === 'agent-first') {
              assert.ok(
                out.system.findIndex((block) => block.text === system[1].text) <
                  out.system.findIndex((block) => block.text === system[0].text),
              )
            } else if (requestedModel === 'claude-opus-5-5') {
              assert.equal(out.messages[1].role, 'system')
              assert.equal(out.messages[1].content[0].text, system[0].text)
            }
          },
        )
      }
    }
  }
}

test('zero caller system markers interpolated into messages survive history optimization', async (t) => {
  clearCachePrefixSessions()
  const system = [text('PROJECTED_RULE_A', '1h'), text('PROJECTED_RULE_B', undefined)]
  const messages = history()
  const compatibility = {
    persona_templates: {
      zero: [...DEFAULT_PERSONA_TEMPLATES.zero, { id: 'caller_system', type: 'text', text: '{{caller_system}}' }],
    },
  }
  let before
  for (const edited of [false, true, true]) {
    if (edited) messages[6].content[0].text = 'edited history'
    const out = await outbound(t, {
      preset: 'zero',
      compatibility,
      headers: { 'x-session-id': 'projected-caller-system' },
      input: { system, messages },
    })
    assert.equal(listCacheMarkers(out).length, 2)
    assert.deepEqual(
      out.messages[0].content.filter((block) => block.cache_control),
      system,
    )
    if (before) assert.deepEqual(out.messages[0], before)
    before = out.messages[0]
  }
})

for (const backend of ['cli', 'api']) {
  const run = backend === 'api' ? unixTest : test
  for (const ttl of [undefined, '5m', '1h']) {
    run(`${backend} Chat preserves assistant text blocks and ${ttl ?? 'implicit 5m'} cache`, async (t) => {
      const content = [text('  FIRST_ASSISTANT_BLOCK\n', '1h'), text('SECOND_ASSISTANT_BLOCK', ttl)]
      const out = await outbound(t, {
        preset: 'zero',
        backend,
        protocol: 'openai.chat',
        headers: { 'x-kin-cache-ttl': '1h' },
        input: {
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content },
            { role: 'user', content: 'Continue' },
          ],
        },
      })
      assert.deepEqual(out.messages[1].content, content)
      assert.equal(listCacheMarkers(out).length, 2)
    })
    for (const id of ['instructions', 'caller_system']) {
      run(`${backend} zero variable ${id} preserves caller blocks and ${ttl ?? 'implicit 5m'} cache`, async (t) => {
        const system = [text('FIRST_SYSTEM_RULE', '1h'), text('SECOND_SYSTEM_RULE', ttl)]
        const out = await outbound(t, {
          preset: 'zero',
          backend,
          headers: { 'x-kin-cache-ttl': '1h' },
          compatibility: {
            persona_templates: {
              zero: [...DEFAULT_PERSONA_TEMPLATES.zero, { id, type: 'text', text: 'Before {{caller_system}} After' }],
            },
          },
          input: { system },
        })
        const blocks = [
          ...out.system,
          ...out.messages.flatMap((message) => (Array.isArray(message.content) ? message.content : [])),
        ]
        for (const original of system) {
          assert.equal(JSON.stringify(out).split(original.text).length - 1, 1)
          assert.deepEqual(
            blocks.find((block) => block.text === original.text),
            original,
          )
        }
        assert.deepEqual(
          listCacheMarkers(out).map((marker) => marker.ttl),
          ['1h', ttl ?? null],
        )
      })
    }
    run(`${backend} duplicate budget reminder retains ${ttl ?? 'implicit 5m'} cache`, async (t) => {
      const reminder = '<total_tokens>123 tokens left</total_tokens>'
      const out = await outbound(t, {
        preset: 'zero',
        backend,
        headers: { 'x-kin-cache-ttl': '1h' },
        input: { system: [text('BUSINESS_RULE', null), text(reminder, null), text(reminder, ttl)] },
      })
      const markers = listCacheMarkers(out)
      assert.equal(markers.length, 1)
      assert.equal(markers[0].section, 'system')
      assert.equal(markers[0].ttl, ttl ?? null)
      assert.ok(JSON.stringify(out).includes('BUSINESS_RULE'))
    })
  }
}

for (const backend of ['cli', 'api']) {
  for (const protocol of ['anthropic.messages', 'openai.chat']) {
    for (const role of ['system', 'developer']) {
      for (const ttl of [undefined, '5m', '1h']) {
        const run = backend === 'api' ? unixTest : test
        run(`${backend} ${protocol} preserves leading ${role} cache ${ttl ?? 'implicit 5m'}`, async (t) => {
          const block = text('  SYSTEM_CACHE_RULE_MUST_SURVIVE\n', ttl)
          const messages = [
            { role, content: [block] },
            { role: 'user', content: 'Hello' },
          ]
          const out = await outbound(t, {
            preset: 'zero',
            backend,
            protocol,
            headers: { 'x-kin-cache-ttl': '1h' },
            input: { messages },
          })
          assert.deepEqual(
            out.system.find((item) => item.text === block.text),
            block,
          )
          assert.equal(listCacheMarkers(out).length, 1)
          assert.equal(messageMarkers(out).length, 0)
        })
      }
    }
  }
}

for (const preset of ['zero', 'official', 'official_full', 'custom']) {
  test(`CLI ${preset} lifts unsupported mid-system text while retaining its cache boundary`, async (t) => {
    const out = await outbound(t, {
      preset,
      headers: { 'x-kin-cache-ttl': '1h' },
      input: {
        model: 'claude-sonnet-5',
        messages: [
          { role: 'user', content: [text('Hello', '1h')] },
          { role: 'system', content: [text('MID_SYSTEM_CACHE_RULE', '5m')] },
          { role: 'user', content: 'Continue' },
        ],
      },
    })
    assert.ok(out.system.some((block) => block.text === 'MID_SYSTEM_CACHE_RULE' && !block.cache_control))
    const markers = messageMarkers(out)
    assert.deepEqual(
      markers.map((marker) => marker.ttl),
      ['1h', '5m'],
    )
    assert.equal(out.messages[0].content.at(-1).text, 'Continue')
    assert.equal(JSON.stringify(out.messages).includes('MID_SYSTEM_CACHE_RULE'), false)
  })
}

for (const preset of ['zero', 'official', 'official_full', 'custom']) {
  for (const ttl of [undefined, '5m']) {
    test(`CLI ${preset} retains caller 1h and ${ttl ?? 'implicit 5m'} through session history edits`, async (t) => {
      clearCachePrefixSessions()
      const messages = history()
      messages[2].content[0].cache_control = control('1h')
      messages[8].content[0].cache_control = control(ttl)
      const headers = { 'x-session-id': `caller-policy-${preset}-${ttl}` }
      for (const edited of [false, true, true]) {
        if (edited) messages[6].content[0].text = 'edited m6'
        const out = await outbound(t, { preset, headers, input: { messages, system: rule } })
        assert.deepEqual(messageMarkers(out), messageMarkers({ messages }))
        assert.deepEqual(out.messages[2], messages[2])
        assert.deepEqual(out.messages[8], messages[8])
        assert.equal(JSON.stringify(out).split(rule).length - 1, 1)
      }
    })
  }
  test(`CLI ${preset} still optimizes generated markers after a session history edit`, async (t) => {
    clearCachePrefixSessions()
    const messages = history()
    const headers = { 'x-session-id': `gateway-policy-${preset}` }
    const first = await outbound(t, { preset, headers, input: { messages } })
    assert.deepEqual(
      messageMarkers(first).map((marker) => marker.index),
      [6, 8],
    )
    messages[3].content[0].text = 'edited m3'
    const next = await outbound(t, { preset, headers, input: { messages } })
    assert.deepEqual(
      messageMarkers(next).map((marker) => marker.index),
      [2, 8],
    )
    assert.ok(messageMarkers(next).every((marker) => marker.ttl === '1h'))
  })
}

test('CLI zero retains only the automatic tail marker after a session history edit', async (t) => {
  clearCachePrefixSessions()
  const messages = history()
  const headers = { 'x-session-id': 'automatic-policy' }
  for (const edited of [false, true]) {
    if (edited) messages[3].content[0].text = 'edited m3'
    const out = await outbound(t, {
      preset: 'zero',
      headers,
      input: { messages, cache_control: control() },
    })
    assert.equal(messageMarkers(out).length, 1)
    assert.equal(messageMarkers(out)[0].index, 8)
    assert.deepEqual(out.messages[8].content[0].cache_control, control())
  }
})

for (const preset of ['official', 'official_full']) {
  for (const boundary of ['disabled', 'removed']) {
    test(`CLI ${preset} with boundary ${boundary} preserves template text and caller TTL`, async (t) => {
      const templateRule = 'You are Claude Code. TEMPLATE_RULE_MUST_SURVIVE'
      const templates = DEFAULT_PERSONA_TEMPLATES[preset].filter(
        (block) => boundary !== 'removed' || block.id !== 'dynamic_boundary',
      )
      const out = await outbound(t, {
        preset,
        compatibility: {
          persona_templates: { [preset]: [...templates, text(templateRule, null)] },
          persona_block_presets: { [preset]: { dynamic_boundary: boundary !== 'disabled' } },
        },
        input: { system: rule, messages: [{ role: 'user', content: [text('Hello', '5m')] }] },
      })
      assert.ok(out.system.some((block) => block.text === templateRule))
      assert.ok(!out.system.some((block) => block.text === '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'))
      assert.equal(JSON.stringify(out).split(rule).length - 1, 1)
      assert.equal(messageMarkers(out).length, 1)
      assert.deepEqual(out.messages[0].content.at(-1).cache_control, control('5m'))
    })
  }
  for (const ttl of ['5m', '1h']) {
    test(`CLI ${preset} without boundary fills ${ttl} within the remaining template budget`, async (t) => {
      // Official also inserts its cached agent block, for three prefix markers.
      const templates = Array.from({ length: preset === 'official' ? 2 : 3 }, (_, i) => ({
        ...text(`You are Claude Code. CONFIGURED_RULE_${i}`, undefined),
        id: `rule_${i}`,
      }))
      const out = await outbound(t, {
        preset,
        compatibility: { cache_ttl: ttl, persona_templates: { [preset]: templates } },
        input: { messages: history() },
      })
      for (const block of templates) assert.ok(out.system.some((candidate) => candidate.text === block.text))
      assert.equal(listCacheMarkers(out).length, 4)
      assert.ok(listCacheMarkers(out).every((marker) => marker.ttl === ttl))
      assert.equal(messageMarkers(out).length, 1)
      assert.equal(messageMarkers(out)[0].index, 8)
    })
  }
}

test('CLI custom template is not cleaned or rebuilt after rendering', async (t) => {
  const templateRule = 'You are Claude Code. CUSTOM_TEMPLATE_RULE'
  const out = await outbound(t, {
    preset: 'custom',
    compatibility: { persona_templates: { custom: [text(templateRule, '1h')] } },
    input: { messages: [{ role: 'user', content: [text('Hello', '5m')] }] },
  })
  assert.deepEqual(
    out.system.find((block) => block.text === templateRule),
    text(templateRule, '1h'),
  )
  assert.equal(listCacheMarkers(out).length, 2)
  assert.deepEqual(out.messages[0].content.at(-1).cache_control, control('5m'))
})

for (const preset of ['official', 'official_full', 'custom']) {
  for (const ttl of [undefined, '5m', '1h']) {
    unixTest(`API ${preset} respects preceding tool TTL ${ttl ?? 'implicit 5m'}`, async (t) => {
      const tool = { name: 'Read', input_schema: { type: 'object' }, cache_control: control(ttl) }
      const out = await outbound(t, { preset, backend: 'api', input: { tools: [tool] } })
      assert.deepEqual(out.tools[0].cache_control, tool.cache_control)
      const markers = listCacheMarkers(out).filter((marker) => marker.section === 'system')
      assert.ok(markers.length > 0)
      assert.ok(markers.every((marker) => marker.ttl === (ttl === '1h' ? '1h' : '5m')))
    })
  }
}

unixTest('API zero reserves the root automatic-cache marker in the four-breakpoint budget', async (t) => {
  const system = Array.from({ length: 3 }, (_, i) => text(`Caller ${i}`, '1h'))
  const out = await outbound(t, {
    preset: 'zero',
    backend: 'api',
    input: { system, cache_control: control('1h') },
    compatibility: { persona_templates: { zero: [...DEFAULT_PERSONA_TEMPLATES.zero, text('Template rule', '1h')] } },
  })
  assert.deepEqual(out.cache_control, control('1h'))
  assert.deepEqual(out.system.slice(1), [text('Template rule', null), ...system])
  assert.equal(listCacheMarkers(out).length, 4)
})

for (const preset of ['zero', 'official', 'official_full', 'custom']) {
  unixTest(`API ${preset} keeps template TTL compatible with root automatic 1h`, async (t) => {
    const out = await outbound(t, {
      preset,
      backend: 'api',
      input: { cache_control: control('1h') },
      headers: { 'x-kin-cache-ttl': '5m' },
      // The root 1h still constrains template markers when the requested
      // default is 5m. Explicit template 5m must be omitted, not rewritten.
      compatibility:
        preset === 'zero'
          ? { persona_templates: { zero: [...DEFAULT_PERSONA_TEMPLATES.zero, text('Template rule', '5m')] } }
          : {},
    })
    assert.deepEqual(out.cache_control, control('1h'))
    if (preset === 'zero') assert.deepEqual(out.system[1], text('Template rule', null))
  })
}

for (const backend of ['cli', 'api']) {
  const run = backend === 'api' ? unixTest : test
  run(`${backend} custom default fills template TTL before caller 1h`, async (t) => {
    const message = { role: 'user', content: [text('Hello', '1h')] }
    const out = await outbound(t, {
      preset: 'custom',
      backend,
      input: { messages: [message] },
      headers: { 'x-kin-cache-ttl': '5m' },
    })
    assert.ok(listCacheMarkers(out).length > 1)
    assert.ok(listCacheMarkers(out).every((marker) => marker.ttl === '1h'))
    assert.deepEqual(out.messages[0], message)
  })
  for (const ttl of ['5m', '1h']) {
    run(`${backend} custom fills missing template TTL from ${ttl}`, async (t) => {
      const out = await outbound(t, {
        preset: 'custom',
        backend,
        compatibility: { cache_ttl: ttl, persona_templates: { custom: [text('Configured rule')] } },
      })
      const markers = listCacheMarkers(out)
      assert.ok(markers.some((marker) => marker.section === 'system'))
      assert.ok(markers.every((marker) => marker.ttl === ttl))
    })
  }
  run(`${backend} custom omits conflicting template TTL without replacing caller markers`, async (t) => {
    const message = { role: 'user', content: [text('Hello', '1h')] }
    const out = await outbound(t, {
      preset: 'custom',
      backend,
      input: { messages: [message] },
      compatibility: { persona_templates: { custom: [text('Configured rule', '5m')] } },
    })
    assert.deepEqual(
      out.system.find((block) => block.text === 'Configured rule'),
      text('Configured rule', null),
    )
    assert.deepEqual(out.messages[0], message)
    assert.equal(listCacheMarkers(out).length, 1)
  })
  for (const callerCount of [0, 4]) {
    run(`${backend} custom budgets five template markers with ${callerCount} caller markers`, async (t) => {
      const templates = Array.from({ length: 5 }, (_, i) => text(`Template ${i}`, '1h'))
      const messages = callerCount
        ? Array.from({ length: callerCount }, (_, i) => ({
            role: i % 2 ? 'assistant' : 'user',
            content: [text(`Message ${i}`, '1h')],
          }))
        : [{ role: 'user', content: 'Hello' }]
      const out = await outbound(t, {
        preset: 'custom',
        backend,
        input: { messages },
        compatibility: { persona_templates: { custom: templates } },
      })
      assert.equal(listCacheMarkers(out).length, 4)
      assert.equal(messageMarkers(out).length, callerCount)
      for (const block of templates) assert.ok(out.system.some((candidate) => candidate.text === block.text))
      if (callerCount) assert.deepEqual(out.messages, messages)
    })
  }
}

const callerBusinessCases = [
  [
    'SDK names',
    'Always respond in Chinese. Explain Claude Agent SDK, agent-sdk, claude-desktop and claude-vscode behavior. Keep cc_entrypoint=sdk-cli examples.',
  ],
  ['agent headings', '# Doing tasks\nNever disclose private records.\n\n# Tone and style\nReturn JSON only.'],
  [
    'environment headings',
    '# Environment\nUse the production database in read-only mode.\n\n# Text output (does not apply to tool calls)\nReturn JSON only.',
  ],
  ['billing documentation', 'Explain the literal x-anthropic-billing-header: field. Return only the documentation.'],
  ['identity with business suffix', 'You are Claude Agent SDK running inside claude-desktop. Always return JSON.'],
]
for (const preset of ['official', 'official_full', 'custom']) {
  for (const backend of ['cli', 'api']) {
    const run = backend === 'api' ? unixTest : test
    for (const [name, system] of callerBusinessCases) {
      run(`${backend} ${preset} retains business system with ${name} exactly once`, async (t) => {
        const out = await outbound(t, {
          preset,
          backend,
          input: { system },
          compatibility: {
            detect_proxied_official_cc: false,
            persona_env_presets: { [preset]: true },
          },
        })
        const encoded = JSON.stringify(out)
        const expected = JSON.stringify(system).slice(1, -1)
        assert.equal(encoded.split(expected).length - 1, 1)
      })
    }
  }
}

const billingCases = [
  ['disabled', { persona_block_presets: { zero: { billing: false } } }],
  ['removed', { persona_templates: { zero: [text('Configured zero rule', null)] } }],
  ['edited', { persona_templates: { zero: [{ id: 'billing', type: 'text', text: '{{billing}}' }] } }],
]
for (const [name, compatibility] of billingCases) {
  test(`zero with billing ${name} preserves caller system and mixed cache TTL at the CLI boundary`, async (t) => {
    const system = [text('You are Claude Code. CALLER_RULE_MUST_SURVIVE', '1h'), text('SECOND_RULE', '5m')]
    const out = await outbound(t, {
      preset: 'zero',
      input: { system },
      compatibility: { persona_preset: 'official', ...compatibility },
    })
    for (const block of system)
      assert.deepEqual(
        out.system.find((candidate) => candidate.text === block.text),
        block,
      )
    assert.equal(listCacheMarkers(out).length, 2)
    assert.equal(JSON.stringify(out).split('CALLER_RULE_MUST_SURVIVE').length - 1, 1)
  })
  test(`zero with billing ${name} still supplies missing message cache markers`, async (t) => {
    const out = await outbound(t, {
      preset: 'zero',
      input: { system: 'CALLER_RULE_MUST_SURVIVE' },
      compatibility: { persona_preset: 'official', cache_ttl: '5m', ...compatibility },
    })
    assert.ok(out.system.some((block) => block.text === 'CALLER_RULE_MUST_SURVIVE'))
    const markers = listCacheMarkers(out)
    assert.equal(markers.length, 1)
    assert.equal(markers[0].section, 'messages')
    assert.equal(markers[0].ttl, '5m')
  })
  test(`zero with billing ${name} and no caller system stays zero`, async (t) => {
    const out = await outbound(t, { preset: 'zero', compatibility })
    assert.ok(!JSON.stringify(out).includes("You are Claude Code, Anthropic's official CLI for Claude."))
    assert.equal(listCacheMarkers(out).length, 1)
    assert.equal(listCacheMarkers(out)[0].section, 'messages')
  })
}

test('zero without billing preserves caller boundary text and implicit tool TTL', async (t) => {
  const system = [text('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__', null), text('CALLER_RULE', null)]
  const tool = { name: 'Read', input_schema: { type: 'object' }, cache_control: control() }
  const out = await outbound(t, {
    preset: 'zero',
    input: { system, tools: [tool] },
    compatibility: { persona_block_presets: { zero: { billing: false } } },
  })
  assert.deepEqual(out.system.slice(1), system)
  assert.deepEqual(out.tools[0].cache_control, tool.cache_control)
  assert.equal(listCacheMarkers(out).length, 1)
})

const rule = 'CALLER_SYSTEM_RULE_0921'
for (const backend of ['cli', 'api']) {
  for (const [protocol, input] of [
    ['anthropic.messages', { system: rule }],
    [
      'openai.chat',
      {
        messages: [
          { role: 'system', content: rule },
          { role: 'user', content: 'Hello' },
        ],
      },
    ],
  ]) {
    const run = backend === 'api' ? unixTest : test
    run(`${backend} official preserves ${protocol} system exactly once as a first-user reminder`, async (t) => {
      const out = await outbound(t, { preset: 'official', backend, protocol, input })
      assert.equal(JSON.stringify(out).split(rule).length - 1, 1)
      const user = out.messages.find((message) => message.role === 'user')
      const content =
        typeof user.content === 'string' ? user.content : user.content.map((block) => block.text || '').join('')
      assert.ok(content.startsWith(`<system-reminder>\n${rule}\n</system-reminder>\n`))
    })
  }
}

for (const preset of ['official', 'official_full']) {
  test(`CLI ${preset} fills 1h after removing implicit 5m tool markers`, async (t) => {
    const out = await outbound(t, {
      preset,
      input: { tools: [{ name: 'Read', input_schema: { type: 'object' }, cache_control: control() }] },
    })
    assert.equal(out.tools[0].cache_control, undefined)
    assert.ok(listCacheMarkers(out).every((marker) => marker.ttl === '1h'))
  })

  for (const [callerTtl, expected] of [
    [undefined, '1h'],
    ['5m', '5m'],
    ['1h', '1h'],
  ]) {
    test(`CLI ${preset} rewrite fills only missing official caller marker TTL (${callerTtl ?? 'missing'})`, async (t) => {
      const out = await outbound(t, {
        preset,
        headers: { 'user-agent': 'claude-cli/2.1.303 (external, cli)' },
        input: {
          system: [text("You are Claude Code, Anthropic's official CLI for Claude."), text('Official caller prompt')],
          messages: [
            { role: 'user', content: [text('Hello')] },
            { role: 'system', content: [text('Trailing reminder', callerTtl)] },
          ],
          metadata: { user_id: { device_id: 'fixture-device', session_id: 'fixture-session' } },
        },
      })
      const marker = listCacheMarkers(out).find((item) => item.section === 'messages' && item.role === 'system')
      assert.equal(marker?.ttl, expected)
    })
  }

  for (const backend of ['cli', 'api']) {
    const run = backend === 'api' ? unixTest : test
    run(`${backend} ${preset} reserves all four caller message breakpoints`, async (t) => {
      const messages = Array.from({ length: 4 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        content: [text(`turn ${i}`, '1h')],
      }))
      messages.push({ role: 'user', content: [text('Continue', null)] })
      const out = await outbound(t, { preset, backend, input: { messages } })
      assert.equal(listCacheMarkers(out).length, 4)
      assert.ok(listCacheMarkers(out).every((marker) => marker.section === 'messages'))
      assert.deepEqual(
        out.messages.filter((message) => message.role !== 'system'),
        messages,
      )
    })
    run(`${backend} ${preset} omits an explicit template 5m before caller 1h`, async (t) => {
      const templates = DEFAULT_PERSONA_TEMPLATES[preset].map((block) =>
        block.cache_control ? { ...block, cache_control: control('5m') } : block,
      )
      const out = await outbound(t, {
        preset,
        backend,
        input: { messages: [{ role: 'user', content: [text('Hello', '1h')] }] },
        compatibility: { persona_templates: { [preset]: templates } },
      })
      assert.equal(listCacheMarkers(out).length, 1)
      assert.equal(listCacheMarkers(out)[0].section, 'messages')
      assert.ok(out.system.some((block) => block.text.includes('You are Claude Code')))
    })
  }
  unixTest(`API ${preset} omits explicit template 1h after caller tool 5m`, async (t) => {
    const templates = DEFAULT_PERSONA_TEMPLATES[preset].map((block) =>
      block.cache_control ? { ...block, cache_control: control('1h') } : block,
    )
    const out = await outbound(t, {
      preset,
      backend: 'api',
      input: { tools: [{ name: 'Read', input_schema: { type: 'object' }, cache_control: control() }] },
      compatibility: { persona_templates: { [preset]: templates } },
    })
    assert.equal(listCacheMarkers(out).length, 1)
    assert.equal(listCacheMarkers(out)[0].section, 'tools')
    assert.deepEqual(out.tools[0].cache_control, control())
  })
}

for (const ttl of [undefined, '5m', '1h']) {
  for (const tail of ['user', 'assistant']) {
    test(`CLI zero translates automatic ${ttl ?? 'implicit 5m'} to the ${tail} tail`, async (t) => {
      const messages = [{ role: 'user', content: 'Hello' }]
      if (tail === 'assistant') messages.push({ role: 'assistant', content: [text('Prefill', null)] })
      const system = [text('Caller hour prefix', '1h')]
      const out = await outbound(t, { preset: 'zero', input: { system, messages, cache_control: control(ttl) } })
      assert.equal(out.cache_control, undefined)
      assert.deepEqual(out.system.slice(1), system)
      const message = out.messages.findLast((message) => message.role === tail)
      assert.deepEqual(message.content.at(-1).cache_control, control(ttl))
      assert.equal(listCacheMarkers(out).length, 2)
    })
  }
}

test('CLI zero translates automatic cache within a full caller budget', async (t) => {
  const system = Array.from({ length: 3 }, (_, i) => text(`Caller ${i}`, '1h'))
  const out = await outbound(t, {
    preset: 'zero',
    input: { system, cache_control: control('5m') },
    compatibility: { persona_templates: { zero: [...DEFAULT_PERSONA_TEMPLATES.zero, text('Template rule', '1h')] } },
  })
  assert.deepEqual(out.system.slice(1), [text('Template rule', null), ...system])
  assert.equal(listCacheMarkers(out).length, 4)
  assert.deepEqual(out.messages[0].content.at(-1).cache_control, control('5m'))
})

test('CLI zero advances an automatic breakpoint as conversation history grows', async (t) => {
  const messages = []
  for (let turn = 0; turn < 3; turn++) {
    messages.push({ role: 'user', content: `Question ${turn}` })
    const out = await outbound(t, {
      preset: 'zero',
      input: { system: [text('Stable caller prefix', '1h')], messages, cache_control: control('5m') },
    })
    const markers = listCacheMarkers(out).filter((marker) => marker.section === 'messages')
    assert.equal(markers.length, 1)
    assert.equal(markers[0].index, messages.length - 1)
    assert.deepEqual(out.messages[markers[0].index].content.at(-1), text(`Question ${turn}`, '5m'))
    messages.push({ role: 'assistant', content: `Answer ${turn}` })
  }
})

test('CLI zero keeps an explicit tail marker when automatic caching reaches the same block', async (t) => {
  const out = await outbound(t, {
    preset: 'zero',
    input: { messages: [{ role: 'user', content: [text('Hello', '1h')] }], cache_control: control('5m') },
  })
  assert.deepEqual(out.messages[0].content[0], text('Hello', '1h'))
  assert.equal(listCacheMarkers(out).length, 1)
})

for (const backend of ['cli', 'api']) {
  const run = backend === 'api' ? unixTest : test
  const legacy = DEFAULT_PERSONA_TEMPLATES.official.filter((block) => block.id !== 'caller_system')
  run(`${backend} migrates a saved old official default without losing caller system`, async (t) => {
    const out = await outbound(t, {
      preset: 'official',
      backend,
      input: { system: rule },
      compatibility: { persona_templates: { official: legacy } },
    })
    assert.equal(JSON.stringify(out).split(rule).length - 1, 1)
    assert.ok(JSON.stringify(out.messages[0]).includes(rule))
  })
  run(`${backend} respects an explicit caller_system opt-out on a migrated official template`, async (t) => {
    const out = await outbound(t, {
      preset: 'official',
      backend,
      input: { system: rule },
      compatibility: {
        persona_templates: { official: legacy },
        persona_block_presets: { official: { caller_system: false } },
      },
    })
    assert.ok(!JSON.stringify(out).includes(rule))
  })
  run(`${backend} keeps edited official placement without appending a duplicate reminder`, async (t) => {
    const out = await outbound(t, {
      preset: 'official',
      backend,
      input: { system: rule },
      compatibility: {
        persona_templates: { official: [...legacy, { id: 'custom', type: 'text', text: 'Custom: {{caller_system}}' }] },
      },
    })
    assert.equal(JSON.stringify(out).split(rule).length - 1, 1)
    assert.ok(out.system.some((block) => block.text === `Custom: ${rule}`))
  })
}
