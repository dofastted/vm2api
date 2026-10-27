import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'
import { finalizeWorkerPayload } from '../../src/lib/transport/go-worker-client.mjs'
import { renderOfficial303Body } from '../../src/lib/identity/official-303.mjs'
import {
  OFFICIAL_303_GUIDANCE,
  OFFICIAL_303_HARNESS,
  OFFICIAL_303_IDENTITY,
  OFFICIAL_303_MAIN_PROMPT,
  OFFICIAL_303_ENV_UNTRUSTED,
  renderOfficial303Guidance,
  renderOfficial303MainPrompt,
} from '../../src/lib/identity/official-profiles.mjs'
import {
  ensureBillingAttribution,
  personaTemplateVars,
  stripSubagentBilling,
} from '../../src/lib/identity/crs-persona.mjs'
import { renderPersonaTemplate } from '../../src/lib/identity/persona-template.mjs'
import { CRS_OFFICIAL_AGENT_PROMPT } from '../../src/lib/identity/official-cc-system-2.1.241.mjs'
import {
  checkCallerPlacement,
  checkOfficial303Rules,
  diffShapes,
  isAllowedSkeletonDiff,
  outboundShape,
} from '../../src/lib/protocol/outbound-shape.mjs'
import { writeKernelConfig } from '../../src/lib/transport/rust-kernel-supervisor.mjs'

const SKELETON = JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/official-2.1.303-skeleton.json'),
    'utf8',
  ),
)

const CALLER_ENV = [
  '# Environment',
  'You have been invoked in the following environment: ',
  ' - Primary working directory: /srv/app',
  ' - Is a git repository: true',
  ' - Platform: linux',
  ' - Shell: bash',
  ' - OS Version: Linux 6.6.1-test',
  OFFICIAL_303_ENV_UNTRUSTED,
  '',
  'You are powered by the model named Opus 5.5 (1M context). The exact model ID is test-pro/claude-opus-5-5[1m]. Assistant knowledge cutoff is June 2026.',
].join('\n')
const AFTER_ENV =
  "\n\n# Language\nAlways respond in Chinese.\n\n<total_tokens>15000000 tokens left</total_tokens>\n\nToday's date is 2026-10-21."
const CALLER_REMINDER = '<system-reminder>\nContents of CLAUDE.md: keep it short.\n</system-reminder>\n'
const CALLER_MAIN = OFFICIAL_303_MAIN_PROMPT.replace('{{memory_dir}}', '/home/caller/.claude/projects/-srv-app/memory/')

function officialCaller(model = 'claude-opus-5-5') {
  return {
    model,
    max_tokens: 128000,
    stream: true,
    metadata: { user_id: '{"device_id":"aa","account_uuid":"","session_id":"bb"}' },
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.296.abc; cc_entrypoint=cli; cch=00000;' },
      { type: 'text', text: OFFICIAL_303_IDENTITY, cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: CRS_OFFICIAL_AGENT_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: CALLER_MAIN, cache_control: { type: 'ephemeral', ttl: '1h' } },
    ],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: CALLER_REMINDER },
          { type: 'text', text: 'hello', cache_control: { type: 'ephemeral', ttl: '1h' } },
        ],
      },
      { role: 'system', content: `${CALLER_ENV}${AFTER_ENV}` },
    ],
    tools: [
      { name: 'Bash', description: 'run', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } },
    ],
    thinking: { type: 'adaptive' },
    output_config: { effort: 'xhigh' },
  }
}

function lean(body, { ttl = '5m', officialCallerFlag = true, compat = {}, oneM = false, entrypoint = 'sdk-cli' } = {}) {
  const routing = {
    compatibility: {
      cache_ttl: ttl,
      cc_entrypoint: entrypoint,
      persona_guidance_presets: { official_full: true },
      ...compat,
    },
  }
  const prepared = prepareCliHopBody(body, { outboundShape: 'lean', routing, cacheTtl: ttl })
  return renderOfficial303Body(prepared, {
    callerSystem: body.system,
    officialCaller: officialCallerFlag,
    identity: { vmId: 'vm-01', timezone: 'America/New_York' },
    compat: routing.compatibility,
    cacheTtl: ttl,
    firstUserText: 'hello',
    sessionId: '11111111-2222-4333-8444-555555555555',
    oneM,
    entrypoint,
  })
}

function markers(body) {
  return outboundShape(body).markers
}

function stripMarkers(value) {
  return JSON.parse(JSON.stringify(value, (key, inner) => (key === 'cache_control' ? undefined : inner)))
}

test('official caller: system is billing, identity, harness, guidance; caller system never reaches the wire', () => {
  const out = lean(officialCaller())
  assert.equal(out.system.length, 5)
  assert.match(
    out.system[0].text,
    /^x-anthropic-billing-header: cc_version=2\.1\.303\.[0-9a-f]{3}; cc_entrypoint=sdk-cli; cch=00000;/,
  )
  assert.equal(out.system[0].text.includes('cc_is_subagent'), false)
  assert.equal(out.system[0].cache_control, undefined)
  assert.equal(out.system[1].text, OFFICIAL_303_IDENTITY)
  assert.equal(out.system[1].cache_control, undefined)
  assert.equal(out.system[2].text, OFFICIAL_303_HARNESS)
  assert.equal(out.system[3].text, '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__')
  assert.equal(out.system[3].cache_control, undefined)
  assert.equal(out.system[4].text, renderOfficial303Guidance({ cwd: '/srv/app', entrypoint: 'sdk-cli' }))
  assert.doesNotMatch(out.system[4].text, /! <command>/)
  assert.deepEqual(out.thinking, { type: 'adaptive', display: 'summarized' })
  const wire = JSON.stringify(out)
  assert.ok(!wire.includes('You are an interactive agent that helps users'), 'old 2.1.296 full prompt dropped')
  assert.ok(!wire.includes('/home/caller/.claude/projects'), 'caller main prompt dropped')
  assert.ok(!wire.includes('cc_version=2.1.296'), 'caller billing dropped')
  assert.equal(JSON.stringify(out.messages).includes('You are an agent working with the user'), false)
})

test('cli entrypoint keeps the interactive identity and guidance bullet', () => {
  const out = lean(officialCaller(), { entrypoint: 'cli' })
  assert.match(out.system[0].text, /cc_entrypoint=cli;/)
  assert.equal(out.system[1].text, OFFICIAL_303_IDENTITY)
  assert.match(out.system[4].text, /! <command>/)
  assert.equal(out.system[4].text, renderOfficial303Guidance({ cwd: '/srv/app', entrypoint: 'cli' }))
})

test('official caller: only the role=system Environment section changes; other bytes stay', () => {
  const out = lean(officialCaller(), { oneM: true })
  assert.deepEqual(
    out.messages.map((message) => message.role),
    ['user', 'system'],
  )
  const tail = out.messages[1]
  assert.equal(typeof tail.content, 'string')
  assert.ok(tail.content.endsWith(AFTER_ENV))
  const env = tail.content.slice(0, tail.content.length - AFTER_ENV.length)
  assert.match(
    env,
    /^# Environment\nYou have been invoked in the following environment: \n - Primary working directory: \/srv\/app\n/,
  )
  assert.match(env, / - OS Version: Linux 6\.6\.1-test\n/)
  assert.doesNotMatch(env, /You are powered by the model/)
  assert.doesNotMatch(env, /test-pro\//)
  assert.equal(out.messages[0].content[0].text, CALLER_REMINDER)
})

test('harness and guidance carry the panel TTL; 1h harness also carries scope global', () => {
  for (const [ttl, expected, harness] of [
    ['5m', { type: 'ephemeral' }, { type: 'ephemeral' }],
    ['1h', { type: 'ephemeral', ttl: '1h' }, { type: 'ephemeral', ttl: '1h', scope: 'global' }],
  ]) {
    const out = lean(officialCaller(), { ttl })
    const found = markers(out)
    assert.equal(found.total, 3, ttl)
    assert.deepEqual(
      found.at.map((m) => m.where),
      ['system[2]', 'system[4]', 'messages[0].content[1]'],
    )
    assert.equal(out.system[1].cache_control, undefined)
    assert.deepEqual(out.system[2].cache_control, harness)
    assert.deepEqual(out.system[4].cache_control, expected)
    assert.deepEqual(out.messages[0].content[1].cache_control, expected)
    assert.equal(out.tools[0].cache_control, undefined)
    assert.deepEqual(checkOfficial303Rules(out), [], ttl)
  }
})
test('missing thinking stays omitted through the final payload; a repair does not refill it', () => {
  const exec = { homeDir: '', vm: { claude: { mode: 'oauth' } } }
  const missing = officialCaller()
  delete missing.thinking
  missing.system[0].text += ' cc_is_subagent=true;'
  const prepared = lean(missing)
  assert.equal(prepared.thinking, undefined)
  assert.equal(prepared.system[0].text.includes('cc_is_subagent'), false)
  const out = finalizeWorkerPayload({
    body: prepared,
    reqHeaders: {},
    exec,
    identity: null,
    routing: { compatibility: { thinking_display: 'summarized' } },
    cliHop: true,
  })
  assert.deepEqual(out.body.thinking, { type: 'adaptive', display: 'omitted' })
  const repairedHop = prepareCliHopBody(missing, { repaired: true, outboundShape: 'lean' })
  const repaired = finalizeWorkerPayload({
    body: repairedHop,
    reqHeaders: {},
    exec,
    identity: null,
    routing: { compatibility: { thinking_display: 'summarized' } },
    cliHop: true,
    repaired: true,
  })
  assert.equal(repaired.body.thinking, undefined)
})
test('a literal after the billing header line keeps cc_is_subagent', () => {
  const note = '\nDocument the field cc_is_subagent=true; do not send it.'
  const body = {
    system: [
      { type: 'text', text: `x-anthropic-billing-header: cc_version=2.1.303.abc; cc_is_subagent=true;${note}` },
      { type: 'text', text: `later block cc_is_subagent=true;${note}` },
    ],
  }
  const out = stripSubagentBilling(body)
  assert.equal(out.system[0].text.startsWith('x-anthropic-billing-header: cc_version=2.1.303.abc;'), true)
  assert.equal(out.system[0].text.split('\n')[0].includes('cc_is_subagent'), false)
  assert.equal(out.system[0].text.endsWith(note), true)
  assert.equal(out.system[1].text, body.system[1].text)
  assert.equal(body.system[0].text.includes('cc_is_subagent=true;'), true)
})

test('top level follows the 2.1.303 order and adds no sampling or context_management', () => {
  const out = lean(officialCaller())
  assert.deepEqual(Object.keys(out).slice(0, 8), [
    'model',
    'messages',
    'system',
    'tools',
    'max_tokens',
    'thinking',
    'output_config',
    'stream',
  ])
  assert.equal(out.temperature, undefined)
  assert.equal(out.context_management, undefined)
  const explicit = lean({
    ...officialCaller(),
    context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
  })
  assert.deepEqual(explicit.context_management, { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] })
})

test('non-official caller: system text goes to a first-user reminder, Environment trails the last user', () => {
  const body = {
    model: 'claude-opus-5-5',
    max_tokens: 1024,
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=9.9.9; cc_entrypoint=x;' },
      { type: 'text', text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
      { type: 'text', text: 'You are a helpful bot.', cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: 'Rules: be brief.' },
    ],
    messages: [{ role: 'user', content: 'hi there' }],
  }
  const out = lean(body, { officialCallerFlag: false })
  assert.deepEqual(out.messages[0].content[0], {
    type: 'text',
    text: '<system-reminder>\nYou are a helpful bot.\n\nRules: be brief.\n</system-reminder>\n',
  })
  assert.deepEqual(out.messages[0].content[1], { type: 'text', text: 'hi there', cache_control: { type: 'ephemeral' } })
  assert.equal(out.messages[1].role, 'system')
  assert.match(out.messages[1].content, /^# Environment\n/)
  assert.equal(out.messages[1].content.includes('Primary working directory'), false)
})

test('non-official caller without system: no reminder; still three markers', () => {
  const out = lean(
    { model: 'claude-fable-5-1', max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }] },
    {
      officialCallerFlag: false,
    },
  )
  assert.equal(out.messages[0].content.length, 1)
  assert.equal(markers(out).total, 3)
  assert.deepEqual(checkOfficial303Rules(out), [])
})

const budget = (n) => `<${'total_tokens'}>${n} tokens left</${'total_tokens'}>`

test('two rounds: the previous user carries the first-round write marker; prefix bytes match', () => {
  const system = [{ type: 'text', text: `You are a helpful bot. ${budget(812345)}` }]
  const blocking = (problems) => problems.filter((p) => p.blocking !== false).map((p) => p.id)
  const first = lean(
    { model: 'claude-opus-5-5', max_tokens: 1024, system, messages: [{ role: 'user', content: 'q1' }] },
    {
      officialCallerFlag: false,
    },
  )
  const second = lean(
    {
      model: 'claude-opus-5-5',
      max_tokens: 1024,
      system: [{ type: 'text', text: `You are a helpful bot. ${budget(799000)}` }],
      messages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
        { role: 'user', content: 'q2' },
      ],
    },
    { officialCallerFlag: false },
  )
  assert.deepEqual(second.system, first.system)
  assert.deepEqual(second.messages[0], first.messages[0])
  assert.ok(first.messages[0].content[0].text.includes(budget(15000000)))
  assert.deepEqual(
    markers(first).at.map((m) => m.where),
    ['system[2]', 'system[4]', 'messages[0].content[1]'],
  )
  assert.deepEqual(
    markers(second).at.map((m) => m.where),
    ['system[2]', 'system[4]', 'messages[0].content[1]', 'messages[2].content[0]'],
  )
  assert.equal(second.messages.at(-1).role, 'system')
  assert.deepEqual(checkOfficial303Rules(first), [])
  assert.deepEqual(checkOfficial303Rules(second), [])
  for (const [out, inbound] of [
    [first, { system }],
    [second, { system: [{ type: 'text', text: `You are a helpful bot. ${budget(799000)}` }] }],
  ]) {
    assert.deepEqual(blocking(checkCallerPlacement(out, inbound, { officialCaller: false })), [])
  }
  const leaked = structuredClone(second)
  leaked.system[3].text += `\n\nYou are a helpful bot. ${budget(15000000)}`
  assert.deepEqual(blocking(checkCallerPlacement(leaked, { system }, { officialCaller: false })), [
    'caller.system_leak',
  ])
})

test('multi-turn history: role=system goes out as the official string, other bytes stay', () => {
  const body = officialCaller()
  body.messages = [
    { role: 'user', content: [{ type: 'text', text: 'first' }] },
    { role: 'system', content: [{ type: 'text', text: `${CALLER_ENV}${AFTER_ENV}` }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 't', signature: 'sig'.repeat(10) },
        { type: 'text', text: 'ok' },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'done' }] },
    { role: 'system', content: '<total_tokens>15000000 tokens left</total_tokens>' },
  ]
  const out = lean(body)
  assert.equal(typeof out.messages[1].content, 'string')
  assert.ok(out.messages[1].content.endsWith(AFTER_ENV))
  assert.doesNotMatch(out.messages[1].content, /You are powered by the model/)
  assert.equal(out.messages[4].content, '<total_tokens>15000000 tokens left</total_tokens>')
  assert.deepEqual(out.messages[0].content[0].cache_control, { type: 'ephemeral' })
  assert.deepEqual(out.messages[3].content[0].cache_control, { type: 'ephemeral' })
  assert.equal(markers(out).total, 4)
  assert.deepEqual(checkOfficial303Rules(out), [])
  const again = lean(body)
  assert.deepEqual(again.messages[1], out.messages[1])
})

test('role=system richer than one text block keeps its array form', () => {
  const body = officialCaller()
  body.messages[1] = {
    role: 'system',
    content: [
      { type: 'text', text: `${CALLER_ENV}${AFTER_ENV}` },
      { type: 'text', text: 'second block' },
    ],
  }
  const out = lean(body)
  assert.ok(Array.isArray(out.messages[1].content))
  assert.ok(out.messages[1].content[0].text.endsWith(AFTER_ENV))
  assert.equal(out.messages[1].content[1].text, 'second block')
})

test('model without mid-conversation system merges Environment into guidance', () => {
  const body = officialCaller('claude-fable-6')
  const out = lean(body)
  assert.equal(
    out.messages.some((message) => message.role === 'system'),
    false,
  )
  assert.equal(out.system[2].text, OFFICIAL_303_HARNESS)
  assert.equal(out.system[3].text, '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__')
  assert.ok(out.system[4].text.startsWith(renderOfficial303Guidance({ cwd: '/srv/app' })))
  assert.match(out.system[4].text, /\n\n# Environment\nYou have been invoked/)
  assert.doesNotMatch(out.system[4].text, /You are powered by the model/)
  assert.ok(out.system[4].cache_control)
  assert.equal(markers(out).total, 3)
})

test('standing switch and edited 303 template still obey the panel TTL', () => {
  const out = lean(officialCaller(), {
    ttl: '5m',
    compat: {
      agent_standing: 'STANDING',
      agent_standing_presets: { official_303: true },
      persona_templates: {
        official_303: [
          { id: 'billing', type: 'text', text: '{{billing}}', cache_control: { type: 'ephemeral', ttl: '1h' } },
          { id: 'identity', type: 'text', text: '{{identity}}', cache_control: { type: 'ephemeral', ttl: '1h' } },
          {
            id: 'harness',
            type: 'text',
            text: '{{agent_standing}}{{harness_303}}',
            cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' },
          },
          {
            id: 'guidance',
            type: 'text',
            text: '{{guidance_303}}',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
      },
    },
  })
  assert.ok(out.system[2].text.startsWith('STANDING\n\nYou are an agent working with the user'))
  assert.equal(out.system[0].cache_control, undefined)
  assert.deepEqual(out.system[1].cache_control, { type: 'ephemeral' })
  assert.deepEqual(out.system[2].cache_control, { type: 'ephemeral' })
  assert.equal(markers(out).total, 4)
})

test('lean output only differs from the 2.1.303 skeleton by allowed items', () => {
  const out = lean(officialCaller())
  // applyCrsIdentityReplace adds metadata after assembly; cli-node writes the wire in profile order.
  const { model, messages, system, tools, ...rest } = out
  const shape = outboundShape({ model, messages, system, tools, metadata: { user_id: 'x' }, ...rest })
  const blocking = diffShapes(SKELETON, shape).filter((diff) => !isAllowedSkeletonDiff(diff))
  assert.deepEqual(blocking, [])
})

test('input is not mutated', () => {
  const body = officialCaller()
  const before = JSON.stringify(body)
  lean(body)
  assert.equal(JSON.stringify(body), before)
})

test('full-prompt models keep the existing cli-hop body; only the billing version moves', () => {
  const body = officialCaller('claude-sonnet-5-5')
  const routing = { compatibility: { cache_ttl: '1h' } }
  const base = prepareCliHopBody(body, { routing, cacheTtl: '1h' })
  const full = prepareCliHopBody(body, { routing, cacheTtl: '1h', outboundShape: 'full' })
  assert.deepEqual(full, base)
  const opts = { firstUserText: 'hello', sessionId: '11111111-2222-4333-8444-555555555555' }
  const v296 = ensureBillingAttribution({ ...base, system: base.system.slice() }, { ...opts, cliVersion: '2.1.296' })
  const v303 = ensureBillingAttribution({ ...base, system: base.system.slice() }, { ...opts, cliVersion: '2.1.303' })
  const neutral = (b) => JSON.stringify(b).replace(/cc_version=2\.1\.(296|303)\.[0-9a-f]{3}/, 'cc_version=X')
  assert.equal(neutral(v303), neutral(v296))
  assert.match(v303.system[0].text, /cc_version=2\.1\.303\./)
})

test('renderOfficial303Body adds only the editable extra for the current model', () => {
  const wire = (model, compat = {}) => JSON.stringify(lean(officialCaller(model), { compat }))
  const empty = wire('claude-opus-5-5')
  assert.equal(empty.includes('Sonnet extra.'), false)
  assert.equal(empty.includes('Haiku extra.'), false)
  const compat = {
    model_env_extra_presets: { official_303: true },
    model_env_extra: {
      'claude-sonnet-5-5': 'Sonnet extra.',
      'claude-haiku-5-5': 'Haiku extra.',
    },
  }
  assert.equal(wire('claude-sonnet-5-5', { model_env_extra: compat.model_env_extra }).includes('Sonnet extra.'), false)
  const sonnet = wire('claude-sonnet-5-5', compat)
  const haiku = wire('claude-haiku-5-5', compat)
  assert.equal(sonnet.includes('Sonnet extra.'), true)
  assert.equal(sonnet.includes('Haiku extra.'), false)
  assert.equal(haiku.includes('Haiku extra.'), true)
  assert.equal(haiku.includes('Sonnet extra.'), false)
  const cleared = wire('claude-sonnet-5-5', {
    ...compat,
    persona_templates: {
      official_303: [
        { id: 'billing', type: 'text', text: '{{billing}}' },
        { id: 'identity', type: 'text', text: '{{identity}}' },
        { id: 'harness', type: 'text', text: '{{harness_303}}' },
        { id: 'guidance', type: 'text', text: '{{guidance_303}}' },
        { id: 'env_extra', type: 'text', text: '' },
      ],
    },
  })
  assert.equal(cleared.includes('Sonnet extra.'), false)
  assert.equal(cleared.includes('Haiku extra.'), false)
})

test('kernel.json cli_version follows the slot profile', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-303-cfg-'))
  const read = (vm, routing) =>
    JSON.parse(fs.readFileSync(writeKernelConfig(root, vm, { token: 't', routing }).configPath, 'utf8'))
  try {
    assert.equal(read({ id: 'vm-01' }, { compatibility: { persona_preset: 'official_303' } }).cli_version, '2.1.303')
    assert.equal(read({ id: 'vm-02' }, { compatibility: { persona_preset: 'official_full' } }).cli_version, '2.1.303')
    assert.equal(read({ id: 'vm-03' }, {}).cli_version, '2.1.303')
    assert.equal(
      read({ id: 'vm-04', persona_preset: 'official_303' }, { compatibility: { persona_preset: 'zero' } }).cli_version,
      '2.1.303',
    )
    const slot = read({ id: 'vm-05', persona_preset: 'official_303' }, {})
    assert.equal(slot.persona_preset, 'official_303')
    assert.equal(slot.system_layout, 'identity')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
