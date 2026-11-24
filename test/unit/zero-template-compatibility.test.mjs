import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { applyCrsUnofficialPersona } from '../../src/lib/identity/crs-persona.mjs'
import { DEFAULT_PERSONA_TEMPLATES } from '../../src/lib/identity/persona-template.mjs'
import { listCacheMarkers, validateCacheBreakpoints } from '../../src/lib/protocol/cache-ttl.mjs'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'
import { collapseSystemBudgetReminders } from '../../src/lib/identity/crs-persona.mjs'

const control = (ttl) => ({ type: 'ephemeral', ...(ttl ? { ttl } : {}) })
const text = (value, ttl) => ({ type: 'text', text: value, ...(ttl === null ? {} : { cache_control: control(ttl) }) })
const base = {
  model: 'claude-opus-5-5',
  max_tokens: 128,
  messages: [{ role: 'user', content: 'Hello' }],
}

test('reordered caller caches retain four controls, scope and coverage across a tool boundary', (t) => {
  const first = text('Help the user complete the current request. ORIGINAL_HOUR', '1h')
  first.cache_control.scope = 'global'
  const second = text('ORIGINAL_IMPLICIT_SHORT', undefined)
  const third = text('ORIGINAL_EXPLICIT_SHORT', '5m')
  const toolUse = { type: 'tool_use', id: 'tool_1', name: 'Read', input: {} }
  const toolResult = { type: 'tool_result', tool_use_id: 'tool_1', content: 'Done' }
  const message = { role: 'user', content: [toolResult, text('Continue', '5m')] }
  const input = {
    system: [first, second, third],
    messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: [toolUse] }, message],
  }
  validateCacheBreakpoints(input)
  const { out, rendered } = render(t, {
    blocks: [
      { id: 'instructions', type: 'text', text: '{{caller_system}}' },
      { id: 'agent', type: 'text', text: '{{caller_agent}}', cache_control: control('1h') },
    ],
    input,
  })
  const marked = [
    ...out.system,
    ...out.messages.flatMap((msg) => (Array.isArray(msg.content) ? msg.content : [])),
  ].filter((block) => block.cache_control)
  assert.deepEqual(
    marked.map((block) => block.cache_control),
    [first.cache_control, control('1h'), third.cache_control, control('5m')],
  )
  const hourAt = out.system.findIndex((block) => block.cache_control?.ttl === '1h')
  assert.ok(out.system.slice(0, hourAt).some((block) => block.text === second.text))
  assert.ok(out.system.slice(0, hourAt).some((block) => block.text === third.text))
  assert.deepEqual(out.messages[1].content, [toolUse])
  assert.deepEqual(out.messages[2], message)
  validateCacheBreakpoints(out)
  assert.deepEqual(prepareCliHopBody(out, { personaPreset: 'zero', cacheTtl: '1h' }), out)
  validateCacheBreakpoints(rendered)
})

test('a mid-system cache moves earlier short message controls after the hour without altering text order', (t) => {
  const user = text('HISTORICAL_USER', '5m')
  const assistant = text('HISTORICAL_ASSISTANT', undefined)
  const rule = text('CACHED_SYSTEM_RULE', '1h')
  const { out } = render(t, {
    blocks: [{ id: 'instructions', role: 'system', type: 'text', text: '{{caller_system}}' }],
    input: {
      system: [rule],
      messages: [
        { role: 'user', content: [user] },
        { role: 'assistant', content: [assistant] },
        { role: 'user', content: 'Continue' },
      ],
    },
  })
  assert.deepEqual(
    out.messages.map((message) => message.role),
    ['user', 'assistant', 'user', 'system'],
  )
  assert.equal(out.messages[0].content[0].text, user.text)
  assert.equal(out.messages[1].content[0].text, assistant.text)
  assert.deepEqual(
    out.messages[3].content.map((block) => block.cache_control),
    [rule.cache_control, user.cache_control, control('5m')],
  )
  validateCacheBreakpoints(out)
})

test('template reordering does not silently repair an invalid caller cache policy', (t) => {
  const { rendered } = render(t, {
    blocks: [{ id: 'instructions', role: 'system', type: 'text', text: '{{caller_system}}' }],
    input: {
      tools: [{ name: 'Read', input_schema: { type: 'object' }, cache_control: control('5m') }],
      system: [text('INVALID_LATER_HOUR', '1h')],
    },
  })
  assert.equal(rendered.tools[0].cache_control.ttl, '5m')
  assert.equal(rendered.messages.at(-1).content[0].cache_control.ttl, '1h')
  assert.throws(() => validateCacheBreakpoints(rendered), /1h before 5m/)
})

for (const model of ['claude-opus-5-5', 'claude-sonnet-5']) {
  test(`${model} keeps tool results first when a cached caller variable uses a system message template`, (t) => {
    const toolUse = { type: 'tool_use', id: 'read_1', name: 'Read', input: {} }
    const toolResult = { type: 'tool_result', tool_use_id: 'read_1', content: 'Tool reply', cache_control: control() }
    const rule = text('TOOL_BOUNDARY_SYSTEM_RULE', '1h')
    const { out } = render(t, {
      blocks: [{ id: 'instructions', role: 'system', type: 'text', text: '{{caller_system}}' }],
      input: {
        model,
        system: [rule],
        messages: [
          { role: 'user', content: 'Read it' },
          { role: 'assistant', content: [toolUse] },
          { role: 'user', content: [toolResult] },
        ],
      },
    })
    assert.deepEqual(out.messages[1].content, [toolUse])
    if (model === 'claude-sonnet-5') {
      // Upstream places unsupported system turns at the top level, so the
      // original tool-result marker remains ordered and gets the default TTL.
      assert.deepEqual(out.messages[2].content[0], { ...toolResult, cache_control: control('1h') })
      assert.ok(out.system.some((block) => block.text === rule.text))
      assert.ok(!out.messages.some((message) => message.role === 'system'))
    } else {
      assert.deepEqual(out.messages[2].content[0], {
        type: 'tool_result',
        tool_use_id: 'read_1',
        content: 'Tool reply',
      })
    }
    assert.deepEqual(
      listCacheMarkers(out).map((marker) => marker.ttl),
      ['1h', '1h'],
    )
    assert.equal(JSON.stringify(out).split(rule.text).length - 1, 1)
    validateCacheBreakpoints(out)
  })
}

test('an already ordered variable layout retains the original marked blocks and message references', (t) => {
  const source = text('Help the user complete the current request. FIRST_HOUR', '1h')
  const remaining = text('SECOND_SHORT', undefined)
  const messages = [{ role: 'user', content: [text('Hello', '5m')] }]
  const { rendered } = render(t, {
    blocks: [
      { id: 'agent', type: 'text', text: '{{caller_agent}}' },
      { id: 'instructions', type: 'text', text: '{{caller_system}}' },
    ],
    input: { system: [source, remaining], messages },
  })
  assert.deepEqual(rendered.system.slice(1), [source, remaining])
  assert.strictEqual(rendered.messages, messages)
})

for (const id of ['instructions', 'caller_system']) {
  test(`zero ${id} reserves four caller markers before generated template controls`, (t) => {
    const system = [text('Rule A', '1h'), text('Rule B', undefined)]
    const messages = [{ role: 'user', content: [text('Hello', '5m')] }]
    const tool = { name: 'Read', input_schema: { type: 'object' }, cache_control: control('1h') }
    const { out } = render(t, {
      blocks: [
        text('Before', '5m'),
        { id, ...text('prefix {{caller_system}} suffix', '1h') },
        text('After', undefined),
      ],
      input: { system, messages, tools: [tool] },
    })
    const markers = listCacheMarkers(out)
    assert.equal(markers.length, 4)
    assert.deepEqual(out.tools, [tool])
    assert.deepEqual(
      markers.filter((marker) => marker.section !== 'tools').map((marker) => marker.ttl),
      ['1h', '1h', '5m'],
    )
    for (const block of system) assert.equal(JSON.stringify(out).split(block.text).length - 1, 1)
    validateCacheBreakpoints(out)
  })
}

for (const [variable, rule] of [
  ['caller_agent', 'Help the user complete the current request. AGENT_RULE'],
  ['agent_official', '<system-conventions>Oh My Pi HARNESS_RULE</system-conventions>'],
]) {
  test(`zero preserves source cache when explicitly interpolating ${variable}`, (t) => {
    const caller = text(rule, undefined)
    const { out } = render(t, {
      blocks: [{ id: 'agent', type: 'text', text: `Before {{${variable}}} After` }],
      input: { system: [caller] },
    })
    assert.deepEqual(
      out.system.find((block) => block.text === rule),
      { ...caller, cache_control: control('1h') },
    )
    assert.deepEqual(
      listCacheMarkers(out).map((marker) => marker.ttl),
      ['1h'],
    )
    validateCacheBreakpoints(out)
  })
}

test('repeated cached variables render the configured text twice but retain each caller control once', (t) => {
  const system = [text('SOURCE_RULE_A', '1h'), text('SOURCE_RULE_B', '5m')]
  const { out } = render(t, {
    blocks: [{ id: 'repeat', type: 'text', text: '{{caller_system}} then {{caller_system}}' }],
    input: { system },
  })
  for (const block of system) assert.equal(JSON.stringify(out).split(block.text).length - 1, 2)
  assert.deepEqual(
    listCacheMarkers(out).map((marker) => marker.ttl),
    ['1h', '5m'],
  )
})

test('a cached caller reminder stays singly wrapped and its literal variables are not interpolated again', (t) => {
  const system = [text('<system-reminder>\nLITERAL {{billing}} RULE\n</system-reminder>', undefined)]
  const { out } = render(t, {
    blocks: [{ id: 'caller_system', type: 'text', text: '<system-reminder>\n{{caller_system}}\n</system-reminder>\n' }],
    input: { system },
  })
  const messages = JSON.stringify(out.messages)
  assert.equal(messages.split('<system-reminder>').length - 1, 1)
  assert.equal(messages.split('</system-reminder>').length - 1, 1)
  assert.ok(messages.includes('LITERAL {{billing}} RULE'))
  assert.deepEqual(
    listCacheMarkers(out).map((marker) => marker.ttl),
    ['1h'],
  )
})

test('a pure caller variable keeps the marked source block whitespace inside its wrapper', (t) => {
  const caller = text('  caller rule\n\n', undefined)
  const { out } = render(t, {
    blocks: [{ id: 'caller_system', type: 'text', text: '{{caller_system}}' }],
    input: { system: [caller] },
  })
  assert.deepEqual(
    out.messages[0].content.find((block) => block.cache_control),
    { ...caller, cache_control: control('1h') },
  )
})

test('cached budget deduplication keeps every boundary and is idempotent', () => {
  const reminder = '<total_tokens>123 tokens left</total_tokens>'
  const body = { system: [text(reminder, '1h'), text(reminder, '5m'), text(reminder, undefined)] }
  const before = structuredClone(body)
  const out = collapseSystemBudgetReminders(body)
  assert.deepEqual(body, before)
  assert.deepEqual(
    out.system.map((block) => block.cache_control),
    body.system.map((block) => block.cache_control),
  )
  assert.equal(out.system.filter((block) => block.text.includes('total_tokens')).length, 1)
  assert.ok(out.system.every((block) => block.text.trim()))
  assert.deepEqual(collapseSystemBudgetReminders(out), out)
  validateCacheBreakpoints(out)
})

function render(t, { blocks = [], input = {}, ttl = '1h', compatibility = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-template-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const routingFile = path.join(dir, 'routing.json')
  const templates = [...DEFAULT_PERSONA_TEMPLATES.zero, ...blocks]
  fs.writeFileSync(
    routingFile,
    JSON.stringify({
      compatibility: {
        persona_preset: 'zero',
        persona_templates: { zero: templates },
        ...compatibility,
      },
    }),
  )
  const body = { ...base, ...input }
  const before = structuredClone(body)
  const rendered = applyCrsUnofficialPersona(body, {
    mode: 'zero',
    routingFile,
    forceConfigured: true,
    cacheTtl: ttl,
    sessionId: 'zero-template-fixture',
  })
  const out = prepareCliHopBody(rendered, { cacheTtl: ttl })
  assert.deepEqual(body, before)
  return { rendered, out }
}

for (const [variable, prompt] of [
  ['caller_agent', 'Help the user complete the current request. AGENT_MARK'],
  ['agent_official', '<system-conventions>\nOh My Pi\nHARNESS_MARK\n</system-conventions>'],
]) {
  for (const leftoverId of [null, 'instructions', 'caller_system']) {
    test(`zero consumes ${variable} once with leftover placement ${leftoverId}`, (t) => {
      const extra = 'Explain Claude Agent SDK. Keep cc_entrypoint=sdk-cli documentation.'
      const separate = 'SEPARATE_CALLER_RULE'
      const blocks = [{ id: 'agent', type: 'text', text: `{{${variable}}}` }]
      if (leftoverId) blocks.push({ id: leftoverId, type: 'text', text: '{{caller_system}}' })
      const { out } = render(t, {
        blocks,
        input: { system: [text(`${prompt}\n\n${extra}`, null), text(separate, null)] },
      })
      for (const marker of [prompt, extra, separate]) {
        const allText = [
          ...out.system.map((block) => block.text),
          ...out.messages.flatMap((message) =>
            Array.isArray(message.content) ? message.content.map((block) => block.text || '') : [message.content],
          ),
        ].join('\n\n')
        assert.equal(allText.split(marker).length - 1, 1, `${marker} must appear exactly once`)
      }
      validateCacheBreakpoints(out)
    })
  }
}

for (const variable of ['caller_agent', 'caller_system', 'agent_official']) {
  test(`zero does not consume ${variable} in a disabled role=system block`, (t) => {
    const prompt =
      variable === 'agent_official'
        ? '<system-conventions>Oh My Pi HARNESS_MARK</system-conventions>'
        : 'Help the user complete the current request. CALLER_MARK'
    const { out } = render(t, {
      blocks: [{ id: 'instructions', type: 'text', role: 'system', text: `{{${variable}}}` }],
      input: { system: prompt },
      compatibility: { persona_env_presets: { zero: false } },
    })
    assert.deepEqual(out.system.slice(1), [text(prompt, null)])
  })
}

for (const ttl of ['5m', '1h']) {
  test(`zero fills both template and omitted caller TTL from ${ttl}`, (t) => {
    const caller = text('Caller implicit TTL')
    const { out } = render(t, { ttl, blocks: [text('Template implicit TTL')], input: { system: [caller] } })
    assert.deepEqual(out.system.at(-1), { ...caller, cache_control: control(ttl) })
    assert.deepEqual(
      listCacheMarkers(out).map((marker) => marker.ttl),
      [ttl, ttl],
    )
    validateCacheBreakpoints(out)
  })
}

test('zero fills template 1h before caller 1h even when the setting is 5m', (t) => {
  const caller = text('Caller hour', '1h')
  const { out } = render(t, { ttl: '5m', blocks: [text('Template implicit TTL')], input: { system: [caller] } })
  assert.deepEqual(out.system.at(-1), caller)
  assert.deepEqual(
    listCacheMarkers(out).map((marker) => marker.ttl),
    ['1h', '1h'],
  )
  validateCacheBreakpoints(out)
})

test('zero keeps compatible explicit template TTL', (t) => {
  const template = text('Template five minutes', '5m')
  const caller = text('Caller five minutes', '5m')
  const { out } = render(t, { blocks: [template], input: { system: [caller] } })
  assert.deepEqual(out.system.slice(1), [template, caller])
  validateCacheBreakpoints(out)
})

test('zero omits an incompatible template 5m marker before caller 1h, preserving both texts', (t) => {
  const caller = text('Caller hour', '1h')
  const { out } = render(t, { blocks: [text('Template five minutes', '5m')], input: { system: [caller] } })
  assert.deepEqual(out.system.slice(1), [text('Template five minutes', null), caller])
  validateCacheBreakpoints(out)
})

test('zero fills an earlier omitted tool TTL from config while respecting explicit 5m tool markers', (t) => {
  const tool = { name: 'Read', input_schema: { type: 'object' }, cache_control: control() }
  const message = { role: 'user', content: [text('Message marker', '5m')] }
  const { out } = render(t, {
    blocks: [text('Incompatible template hour', '1h'), text('Template implicit TTL')],
    input: { tools: [tool], system: [text('Caller rule', null)], messages: [message] },
  })
  assert.deepEqual(out.tools, [{ ...tool, cache_control: control('1h') }])
  assert.deepEqual(out.messages, [message])
  assert.deepEqual(out.system.slice(1), [
    text('Incompatible template hour', null),
    text('Template implicit TTL', '5m'),
    text('Caller rule', null),
  ])
  validateCacheBreakpoints(out)

  // Explicit 5m tool marker still stays 5m and keeps template markers compatible.
  const explicitTool = { name: 'Read', input_schema: { type: 'object' }, cache_control: control('5m') }
  const { out: outFive } = render(t, {
    blocks: [text('Incompatible template hour', '1h'), text('Template implicit TTL')],
    input: { tools: [explicitTool], system: [text('Caller rule', null)], messages: [message] },
  })
  assert.deepEqual(outFive.tools, [explicitTool])
  assert.deepEqual(outFive.system.slice(1), [
    text('Incompatible template hour', null),
    text('Template implicit TTL', '5m'),
    text('Caller rule', null),
  ])
  validateCacheBreakpoints(outFive)
})

test('zero fills template 1h before a caller message hour marker', (t) => {
  const message = { role: 'user', content: [text('Message hour', '1h')] }
  const { out } = render(t, {
    ttl: '5m',
    blocks: [text('Template implicit TTL')],
    input: { messages: [message] },
  })
  assert.equal(out.system[1].cache_control.ttl, '1h')
  assert.deepEqual(out.messages, [message])
  validateCacheBreakpoints(out)
})

test('zero reserves all four caller breakpoints before considering template markers', (t) => {
  const system = Array.from({ length: 4 }, (_, i) => text(`Caller ${i}`, '1h'))
  const { out } = render(t, { blocks: [text('Template anchor', '1h')], input: { system } })
  assert.deepEqual(out.system.slice(1), [text('Template anchor', null), ...system])
  assert.equal(listCacheMarkers(out).length, 4)
  validateCacheBreakpoints(out)
})

test('zero counts tool, system and message markers when allocating template budget', (t) => {
  const tool = { name: 'Read', input_schema: { type: 'object' }, cache_control: control('1h') }
  const caller = text('Caller anchor', '1h')
  const message = { role: 'user', content: [text('Message anchor', '1h')] }
  const { out } = render(t, {
    blocks: [text('Earlier template anchor', '1h'), text('Later template anchor', '1h')],
    input: { tools: [tool], system: [caller], messages: [message] },
  })
  assert.deepEqual(out.tools, [tool])
  assert.deepEqual(out.messages, [message])
  assert.deepEqual(out.system.slice(1), [
    text('Earlier template anchor', null),
    text('Later template anchor', '1h'),
    caller,
  ])
  assert.equal(listCacheMarkers(out).length, 4)
  validateCacheBreakpoints(out)
})

for (const location of ['system', 'tools', 'messages']) {
  test(`caller boundary sentinel cannot change zero ${location} cache policy`, (t) => {
    const input = { system: [text('Caller rule', null), text('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__', null)] }
    const anchor = text('Caller anchor', '5m')
    if (location === 'system') input.system.push(anchor)
    if (location === 'tools')
      input.tools = [{ name: 'Read', input_schema: { type: 'object' }, cache_control: control('5m') }]
    if (location === 'messages') input.messages = [{ role: 'user', content: [anchor] }]
    const { out } = render(t, { input })
    assert.deepEqual(out.system.slice(1), input.system)
    if (input.tools) assert.deepEqual(out.tools, input.tools)
    if (input.messages) assert.deepEqual(out.messages, input.messages)
    const markers = listCacheMarkers(out)
    assert.equal(markers.length, 1)
    assert.equal(markers[0].section, location)
    assert.equal(markers[0].ttl, '5m')
    validateCacheBreakpoints(out)
  })
}
