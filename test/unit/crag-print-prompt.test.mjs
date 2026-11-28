import { firstHistoryDiff } from '../../src/lib/protocol/cache-prefix.mjs'
import { sanitizeCragBodyWhitelist } from '../../src/lib/protocol/crag-whitelist.mjs'
import { relocateThirdPartySystem } from '../../src/lib/protocol/third-party-system.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { validatePersonaRoutingPatch } from '../../src/lib/admin/panel-api.mjs'
import {
  callerCwdDeclaration,
  callerSystemTail,
  cragV2KernelActive,
  foldHistorySystemMessages,
  prepareCragPrintBody,
  projectCallerSystem,
  readSlotKernelConfig,
  resolveCragPrintPersona,
  trackCallerSystemBlock,
} from '../../src/lib/protocol/crag-print-prompt.mjs'
import { sanitizeAnthropicBody } from '../../src/lib/protocol/sanitize.mjs'
import { prepareCragRequest } from '../../src/lib/protocol/kernel-request.mjs'
import { agentBody } from '../fixtures/agent-summary.mjs'

const billing = 'x-anthropic-billing-header: cc_version=2.1.317'

test('CRAG boundary validates while reusing typed history and normalizes noncanonical history', () => {
  const result = { type: 'tool_result', tool_use_id: 'toolu_read', content: 'result' }
  const body = {
    model: 'claude-sonnet-5-5',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Read this' }] },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'read', id: 'toolu_read', input: {} }] },
      { role: 'user', content: [result] },
    ],
  }
  assert.equal(prepareCragRequest(body).messages, body.messages)
  result.content = [{ type: 'text', text: 'result', annotations: [] }]
  assert.deepEqual(prepareCragRequest(body).messages[2].content[0].content, [{ type: 'text', text: 'result' }])
  result.content = [{ type: 'text', text: 123 }]
  assert.throws(
    () => prepareCragRequest(body),
    (error) => error.body?.error?.param === 'messages[2].content[0].content[0].text',
  )
})
const identity = 'You are Claude Code, an agent.'
const harness = 'You are an agent working with the user.'
const guidance = 'Bias toward working.'

const cwdTag = (cwd) => `<cwd>\n${cwd}\n</cwd>`
const callerCwdFromSystem = (system) => callerCwdDeclaration(system)?.cwd ?? null

test('CRAG provider compatibility keeps the caller system and requires advertised tool support', () => {
  const body = {
    model: 'claude-sonnet-5-5',
    system: [{ type: 'text', text: 'Policy', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Sample' }] }],
    tools: [
      ...Array.from({ length: 47 }, (_, index) => ({ name: `client_${index}`, input_schema: { type: 'object' } })),
      { type: 'web_search_20250305', name: 'web_search', max_uses: 2 },
    ],
  }
  const legacy = ['generation_controls_v3', 'prompt_replace', 'prompt_append']
  const capabilities = [...legacy, 'provider_managed_tools_v1']
  for (const preset of ['zero', 'official_full']) {
    const projected = prepareCragPrintBody(body, { preset, capabilities })
    const request = prepareCragRequest(projected, { capabilities })
    assert.deepEqual(request.system, body.system)
    assert.deepEqual(request.tools, body.tools)
    assert.equal(request.crag_prompt, undefined)
  }
  assert.throws(() => prepareCragRequest(body, { capabilities: legacy }), {
    message: /^tools\[47\]\.type:/,
    code: 'invalid_kernel_request',
  })
  assert.throws(() => prepareCragRequest(body, { capabilities: [] }), {
    message: /^tools\[47\]\.type:/,
  })
  assert.throws(
    () => prepareCragRequest({ ...body, crag_prompt: { mode: 'replace', text: 'Policy' } }, { capabilities }),
    {
      message: /^crag_prompt:/,
    },
  )
  assert.throws(
    () =>
      prepareCragRequest({ ...body, tools: [{ type: 'web_search_20990101', name: 'web_search' }] }, { capabilities }),
    { message: /^tools\[0\]\.type:/ },
  )
  const replay = {
    ...body,
    tools: body.tools.slice(0, 1),
    messages: [
      body.messages[0],
      {
        role: 'assistant',
        content: [{ type: 'server_tool_use', id: 'srvtoolu_example', name: 'web_search', input: {} }],
      },
      { role: 'user', content: [{ type: 'text', text: 'Continue' }] },
    ],
  }
  assert.deepEqual(prepareCragPrintBody(replay, { preset: 'zero', capabilities }), replay)
})

test('caller cwd accepts a single standalone absolute path from the raw system', () => {
  const posix = '/synthetic/work space/项目'
  const drive = String.raw`C:\Synthetic Work\project`
  const unc = String.raw`\\fixture\share\project`
  assert.equal(callerCwdFromSystem(`instructions\r\n  <cwd>\r\n  ${posix}  \r\n  </cwd>\r\nmore`), posix)
  assert.equal(
    callerCwdFromSystem([{ type: 'text', text: cwdTag(drive), cache_control: { type: 'ephemeral' } }]),
    drive,
  )
  assert.equal(callerCwdFromSystem([cwdTag(unc)]), unc)
  assert.equal(
    callerCwdFromSystem([
      { type: 'image', text: cwdTag('/not-a-text-block') },
      { type: 'text', text: cwdTag(posix) },
    ]),
    posix,
  )
})

test('caller cwd rejects malformed or ambiguous declarations', () => {
  const tag = cwdTag('/synthetic/workspace')
  for (const [name, system] of [
    ['missing system', undefined],
    ['no tag', 'caller instructions'],
    ['inline', '<cwd>/synthetic/workspace</cwd>'],
    ['uppercase tags', '<CWD>\n/synthetic/workspace\n</CWD>'],
    ['opening tag in prose', `example: ${tag}`],
    ['closing tag in prose', `${tag} is an example`],
    ['multiline value', cwdTag('/synthetic\n/workspace')],
    [
      'split across blocks',
      [
        { type: 'text', text: '<cwd>\n/synthetic/workspace' },
        { type: 'text', text: '</cwd>' },
      ],
    ],
    ['non-text block', [{ type: 'image', text: tag }]],
    ['messages instead of top-level system', { messages: [{ role: 'system', content: tag }] }],
    ['duplicate in one block', `${tag}\n${tag}`],
    [
      'duplicate across blocks',
      [
        { type: 'text', text: tag },
        { type: 'text', text: cwdTag('/other') },
      ],
    ],
  ]) {
    assert.equal(callerCwdFromSystem(system), null, name)
  }
})

test('caller cwd validates the path and caps the trimmed value at 512 UTF-8 bytes', () => {
  const atLimit = `/${'é'.repeat(255)}a`
  assert.equal(callerCwdFromSystem(cwdTag(` ${atLimit} `)), atLimit)
  for (const [name, value] of [
    ['one byte over the limit', `${atLimit}a`],
    ['blank', '   '],
    ['relative POSIX path', 'synthetic/workspace'],
    ['drive-relative path', String.raw`C:workspace`],
    ['UNC without share', String.raw`\\fixture`],
    ['Windows device path', String.raw`\\.\pipe\fixture`],
    ['forbidden Windows punctuation', String.raw`C:\synthetic\bad?name`],
    ['NUL', '/synthetic/\u0000workspace'],
    ['tab', '/synthetic/work\tspace'],
    ['Unicode line separator', '/synthetic/\u2028workspace'],
    ['markup', '/synthetic/<workspace>'],
    ['named entity', '/synthetic/one&amp;two'],
    ['numeric entity', '/synthetic/one&#x2f;two'],
  ]) {
    assert.equal(callerCwdFromSystem(cwdTag(value)), null, name)
  }
})

test('official_full appends only the caller tail', () => {
  const out = prepareCragPrintBody(
    {
      model: 'claude-sonnet-5',
      system: [
        { type: 'text', text: billing },
        { type: 'text', text: 'caller tail', cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'image', source: { type: 'base64', data: 'xx' } },
      ],
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'Read', input_schema: { type: 'object' } }],
      thinking: { type: 'adaptive' },
      crag_prompt: { mode: 'replace', text: 'smuggled' },
      crag_options: { prompt: { mode: 'replace', text: 'alias' }, effort: 'high' },
    },
    { preset: 'official_full' },
  )
  assert.equal(out.system, undefined)
  assert.deepEqual(out.crag_prompt, { mode: 'append', text: 'caller tail' })
  assert.equal(out.crag_prompt.text.includes('cache_control'), false)
  assert.deepEqual(out.crag_options, { effort: 'high' })
  assert.equal(out.thinking.type, 'adaptive')
  assert.equal(out.tools[0].name, 'Read')
  assert.equal(out.messages[0].content, 'hi')
})

test('an extracted caller cwd is not copied into append or replacement prompt text', () => {
  const callerCwd = '/synthetic/workspace'
  const body = {
    model: 'claude-sonnet-5',
    system: [
      { type: 'text', text: billing },
      { type: 'text', text: `${cwdTag(callerCwd)}\ncaller guidance` },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  }
  const system = projectCallerSystem(body.system, callerCwdDeclaration(body.system))
  for (const [preset, mode] of [
    ['official_full', 'append'],
    ['zero', 'replace'],
  ]) {
    const out = prepareCragPrintBody({ ...body, system }, { preset })
    assert.equal(Object.hasOwn(out, 'system'), false, preset)
    assert.equal(Object.hasOwn(out, 'caller_cwd'), false, preset)
    assert.deepEqual(out.crag_prompt, { mode, text: 'caller guidance' }, preset)
    assert.deepEqual(out.messages, body.messages, preset)
  }
  assert.equal(body.system[1].text, `${cwdTag(callerCwd)}\ncaller guidance`)
})

test('print preparation does not extract cwd again from normalized system history', () => {
  const raw = cwdTag('/synthetic/declared')
  const lifted = `historical instructions\n${raw}`
  const declaration = callerCwdDeclaration(raw)
  const body = sanitizeAnthropicBody(
    {
      system: raw,
      messages: [
        { role: 'system', content: lifted },
        { role: 'user', content: 'hi' },
      ],
    },
    { onSystemBlock: trackCallerSystemBlock(raw, declaration) },
  )
  assert.deepEqual(
    prepareCragPrintBody({ ...body, system: projectCallerSystem(body.system, declaration) }).crag_prompt,
    {
      mode: 'append',
      text: lifted,
    },
  )
  for (const preset of ['official_full', 'zero']) {
    const out = prepareCragPrintBody({ system: projectCallerSystem(raw, callerCwdDeclaration(raw)) }, { preset })
    assert.equal(Object.hasOwn(out, 'crag_prompt'), false, preset)
  }
})

test('zero replace does not leave a bare system, and refuses argv overflow', () => {
  const replaced = prepareCragPrintBody({ model: 'claude-sonnet-5', system: 'caller only' }, { preset: 'zero' })
  assert.equal(replaced.system, undefined)
  assert.deepEqual(replaced.crag_prompt, { mode: 'replace', text: 'caller only' })

  const empty = prepareCragPrintBody({ model: 'claude-sonnet-5', system: billing }, { preset: 'zero' })
  assert.equal(empty.system, undefined)
  assert.equal(empty.crag_prompt, undefined)

  assert.throws(
    () => prepareCragPrintBody({ system: 'x'.repeat(64 * 1024 + 1) }, { preset: 'zero' }),
    (error) => error.status === 400 && error.body.error.code === 'crag_prompt_too_large',
  )
  const longAppend = prepareCragPrintBody({ system: 'y'.repeat(64 * 1024 + 1) }, { preset: 'official_full' })
  assert.equal(longAppend.crag_prompt.mode, 'append')
  assert.equal(longAppend.crag_prompt.text.length, 64 * 1024 + 1)
})

test('legacy non-headless TUI zero + empty system emits empty replace only when prompt_replace_empty is advertised', () => {
  const legacyCaps = ['generation_controls_v3', 'linux_tui_native_queue', 'prompt_replace', 'prompt_append']
  const capsWithEmpty = [...legacyCaps, 'prompt_replace_empty']

  for (const system of [
    undefined,
    '',
    billing,
    [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
  ]) {
    const withCap = prepareCragPrintBody(
      { model: 'claude-sonnet-5', system, messages: [{ role: 'user', content: 'hi' }] },
      { preset: 'zero', officialPassthrough: false, capabilities: capsWithEmpty },
    )
    assert.equal(withCap.system, undefined)
    assert.deepEqual(withCap.crag_prompt, { mode: 'replace', text: '' })

    const withoutCap = prepareCragPrintBody(
      { model: 'claude-sonnet-5', system, messages: [{ role: 'user', content: 'hi' }] },
      { preset: 'zero', officialPassthrough: false, capabilities: legacyCaps },
    )
    assert.equal(withoutCap.system, undefined)
    assert.equal(withoutCap.crag_prompt, undefined)
  }

  // Official passthrough and official_full must never emit empty replace
  const passthrough = prepareCragPrintBody(
    { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] },
    { preset: 'zero', officialPassthrough: true, capabilities: capsWithEmpty },
  )
  assert.equal(passthrough.crag_prompt, undefined)

  const appendEmpty = prepareCragPrintBody(
    { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] },
    { preset: 'official_full', officialPassthrough: false, capabilities: capsWithEmpty },
  )
  assert.equal(appendEmpty.crag_prompt, undefined)
})

test('official passthrough does not append the caller system', () => {
  const out = prepareCragPrintBody(
    {
      system: [
        { type: 'text', text: billing },
        { type: 'text', text: identity },
        { type: 'text', text: harness },
        { type: 'text', text: guidance },
      ],
    },
    { preset: 'official_full', officialPassthrough: true },
  )
  assert.equal(out.system, undefined)
  assert.equal(out.crag_prompt, undefined)
})

test('native CRAG normalizes inline image aliases without moving content or tool results', () => {
  const cache = { type: 'ephemeral' }
  const alias = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAB' }, cache_control: cache }
  const image = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'AAAB' },
    cache_control: cache,
  }
  const before = { type: 'text', text: 'before' }
  const after = { type: 'text', text: 'after' }
  const result = { type: 'tool_result', tool_use_id: 'toolu_example', is_error: true, content: [before, alias, after] }
  const remote = { type: 'image_url', image_url: 'https://example.invalid/image.png' }
  const messages = [
    { role: 'user', content: [before, alias, after, remote] },
    { role: 'assistant', content: [{ type: 'tool_use', id: result.tool_use_id, name: 'lookup', input: {} }] },
    { role: 'user', content: [result, after] },
  ]
  const expected = [
    { ...messages[0], content: [before, image, after, remote] },
    messages[1],
    { ...messages[2], content: [{ ...result, content: [before, image, after] }, after] },
  ]
  const body = { messages }
  const original = structuredClone(body)
  const options = { capabilities: ['prompt_append', 'generation_controls_v3'] }
  assert.deepEqual(prepareCragPrintBody(body, options).messages, expected)
  assert.deepEqual(prepareCragPrintBody({ messages: expected }, options).messages, expected)
  assert.deepEqual(prepareCragPrintBody(body, { capabilities: ['prompt_append'] }).messages, messages)
  assert.deepEqual(body, original)
})

test('native CRAG rejects invalid or lossy inline image aliases, including in tool results', () => {
  const options = { capabilities: ['prompt_append', 'generation_controls_v3'] }
  for (const imageUrl of [
    null,
    {},
    { url: 123 },
    'data:image/png;base64,!!==',
    'data:text/plain;base64,AAAB',
    'data:image/png,AAAB',
    { url: 'data:image/png;base64,AAAB', detail: 'high' },
  ]) {
    const block = { type: 'image_url', image_url: imageUrl }
    for (const content of [[block], [{ type: 'tool_result', tool_use_id: 'toolu_example', content: [block] }]]) {
      assert.throws(
        () => prepareCragPrintBody({ messages: [{ role: 'user', content }] }, options),
        (error) => error.status === 400 && error.body.error.code === 'invalid_image_url',
      )
    }
  }
})

test('caller tail drops billing lines and non-text blocks', () => {
  assert.equal(
    callerSystemTail([
      { type: 'text', text: `${billing}\nkeep me` },
      { type: 'text', text: '  ' },
      { type: 'tool_result', content: 'nope' },
    ]),
    'keep me',
  )
})

test('CRAG print persona follows unified SSOT (slot > persona_preset > legacy crag_persona_preset)', () => {
  const routing = { compatibility: { persona_preset: 'official', crag_persona_preset: 'zero' } }
  assert.equal(resolveCragPrintPersona({}, routing), 'official')
  assert.equal(resolveCragPrintPersona({ persona_preset: 'official' }, routing), 'official')
  assert.equal(resolveCragPrintPersona({ persona_preset: 'official_303' }, routing), 'official_full')
  assert.equal(resolveCragPrintPersona({ persona_preset: 'zero' }, routing), 'zero')
  assert.equal(resolveCragPrintPersona({}, { compatibility: { persona_preset: 'zero' } }), 'zero')
  assert.equal(resolveCragPrintPersona({}, { compatibility: { crag_persona_preset: 'zero' } }), 'zero')
})

test('print follows the kernel enabled on the VM, not the global dataplane', () => {
  const routingOnly = { dataplane: 'crag', crag_kernel_version: 'v2' }
  assert.equal(cragV2KernelActive({ vm: { dataplane: 'wrap' }, kernelConfig: routingOnly }), false)
  assert.equal(cragV2KernelActive({ vm: { dataplane: 'cc' } }), false)
  assert.equal(cragV2KernelActive({ vm: { dataplane: 'crag', crag_kernel_version: 'legacy' } }), true)
  assert.equal(cragV2KernelActive({ vm: {} }), false)
  assert.equal(cragV2KernelActive({ vm: { dataplane: 'crag', crag_kernel_version: 'v2' } }), true)
  assert.equal(
    cragV2KernelActive({
      vm: { dataplane: 'wrap' },
      health: { runtime_variant: 'crag-v2', dataplane: 'crag', kernel_version: 'v2' },
    }),
    true,
  )
  assert.equal(
    cragV2KernelActive({
      vm: { dataplane: 'crag', crag_kernel_version: 'v2' },
      health: { runtime_variant: 'cli-node', dataplane: 'wrap' },
    }),
    false,
  )
  assert.equal(
    cragV2KernelActive({
      vm: { dataplane: 'crag' },
      kernelConfig: { dataplane: 'crag', crag_kernel_version: 'v2', runtime_variant: 'crag-v2' },
    }),
    true,
  )
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-route-'))
  const home = path.join(root, 'cli-home')
  fs.mkdirSync(path.join(root, 'run'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'run', 'kernel.json'),
    JSON.stringify({ dataplane: 'crag', crag_kernel_version: 'v2', runtime_variant: 'crag-v2' }),
  )
  assert.equal(cragV2KernelActive({ vm: {}, kernelConfig: readSlotKernelConfig(home) }), true)
  fs.rmSync(root, { recursive: true, force: true })
})

test('routing save accepts all four unified presets on legacy crag_persona_preset and rejects unknown values', () => {
  assert.deepEqual(validatePersonaRoutingPatch({ compatibility: { crag_persona_preset: 'official' } }), [])
  assert.deepEqual(validatePersonaRoutingPatch({ compatibility: { crag_persona_preset: 'official_full' } }), [])
  assert.deepEqual(validatePersonaRoutingPatch({ compatibility: { crag_persona_preset: 'zero' } }), [])
  assert.deepEqual(validatePersonaRoutingPatch({ compatibility: { crag_persona_preset: 'custom' } }), [])
  assert.deepEqual(validatePersonaRoutingPatch({ compatibility: { crag_persona_preset: '' } }), [])
  assert.match(
    validatePersonaRoutingPatch({ compatibility: { crag_persona_preset: 'invalid_mode' } })[0],
    /official \/ official_full \/ zero \/ custom/,
  )
})

test('summary cleanup preserves result text, media, errors and historical tool pairs', () => {
  const body = agentBody({ summary: true })
  const historical = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'old', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: 'old output' }] },
  ]
  body.messages.splice(1, 0, ...historical)
  const current = body.messages[4].content[0]
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } }
  current.content = [{ type: 'text', text: 'tool_result replayed' }, image]
  current.is_error = true
  current.cache_control = { type: 'ephemeral', ttl: '1h' }
  const before = structuredClone(body)
  const out = prepareCragPrintBody(body, { agentSummary: true, officialPassthrough: true, foldSystemMessages: false })
  assert.deepEqual(out.messages.slice(0, 3), before.messages.slice(0, 3))
  // The call is read-only too, so no tool_use is left without its tool_result.
  assert.deepEqual(out.messages[3].content, [{ type: 'text', text: '[tool call Write test-tool] {"content":"Draft"}' }])
  assert.deepEqual(out.messages[4].content, [
    { type: 'text', text: '[tool result test-tool (error)]', cache_control: current.cache_control },
    ...current.content,
    before.messages[4].content.at(-1),
  ])
  assert.deepEqual(out.messages[5], before.messages[5])
  assert.deepEqual(body, before)
  // A normal continuation, including a tool reporting this error, remains live.
  assert.deepEqual(prepareCragPrintBody(body, { foldSystemMessages: false }).messages, before.messages)
})

const sysTurn = (text, extra = {}) => ({ role: 'system', content: [{ type: 'text', text, ...extra }] })
const userTurn = (content) => ({ role: 'user', content })
const asstTurn = (content) => ({ role: 'assistant', content })

test('history system turns fold into the preceding user turn as reminders', () => {
  const cc = { type: 'ephemeral', ttl: '1h' }
  const messages = [
    userTurn('hi'),
    sysTurn('# Environment update\n - cwd: /a'),
    asstTurn([{ type: 'text', text: 'ok' }]),
    userTurn([{ type: 'text', text: 'next' }]),
    sysTurn('<total_tokens>9 tokens left</total_tokens>', { cache_control: cc }),
  ]
  const out = prepareCragPrintBody({ messages, system: 'caller' }).messages
  assert.deepEqual(
    out.map((m) => m.role),
    ['user', 'assistant', 'user'],
  )
  assert.deepEqual(out[0].content, [
    { type: 'text', text: 'hi' },
    { type: 'text', text: '<system-reminder>\n# Environment update\n - cwd: /a\n</system-reminder>' },
  ])
  assert.deepEqual(out[2].content.at(-1), {
    type: 'text',
    text: '<system-reminder>\n<total_tokens>9 tokens left</total_tokens>\n</system-reminder>',
    cache_control: cc,
  })
  assert.equal(messages[0].content, 'hi', 'caller history is not mutated')
})

test('folding keeps earlier turns byte-stable as history grows', () => {
  const turn1 = [userTurn('hi'), sysTurn('note 1')]
  const turn2 = [...turn1, asstTurn('ok'), userTurn('again'), sysTurn('note 2')]
  const a = prepareCragPrintBody({ messages: turn1 }).messages
  const b = prepareCragPrintBody({ messages: turn2 }).messages
  assert.deepEqual(b.slice(0, a.length), a)
})

test('a system turn after an assistant turn joins the next user turn after its tool results', () => {
  const messages = [
    userTurn('go'),
    asstTurn([{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]),
    sysTurn('<system-reminder>\nfile changed\n</system-reminder>'),
    userTurn([
      { type: 'tool_result', tool_use_id: 't1', content: 'done' },
      { type: 'text', text: 'and' },
    ]),
  ]
  const out = foldHistorySystemMessages(messages)
  assert.deepEqual(
    out.map((m) => m.role),
    ['user', 'assistant', 'user'],
  )
  assert.deepEqual(
    out[2].content.map((b) => b.type + (b.text ? `:${b.text}` : '')),
    ['tool_result', 'text:<system-reminder>\nfile changed\n</system-reminder>', 'text:and'],
  )
})

test('system turns that cannot fold keep their original shape', () => {
  const image = {
    role: 'system',
    content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } }],
  }
  const trailing = [userTurn('q'), asstTurn('a'), sysTurn('late')]
  assert.deepEqual(foldHistorySystemMessages(trailing), trailing)
  const withImage = [userTurn('q'), image]
  assert.deepEqual(foldHistorySystemMessages(withImage), withImage)
  const plain = [userTurn('q')]
  assert.equal(foldHistorySystemMessages(plain), plain)
  const off = prepareCragPrintBody({ messages: [userTurn('q'), sysTurn('n')] }, { foldSystemMessages: false })
  assert.deepEqual(
    off.messages.map((m) => m.role),
    ['user', 'system'],
  )
})

test('an agent summary keeps its trailing budget turns but folds shared history', () => {
  const body = agentBody({ summary: true })
  body.messages.splice(1, 0, sysTurn('# Environment update'))
  const out = prepareCragPrintBody(body, { agentSummary: true }).messages
  assert.equal(out.at(-1).role, 'system')
  assert.equal(
    out.slice(0, -1).some((m) => m.role === 'system'),
    false,
  )
  assert.ok(out[0].content.at(-1).text.includes('# Environment update'))
})

test('folded turn controls are lifted unless a later turn overrides them', () => {
  const effortOnly = {
    role: 'system',
    content: [],
    output_config: { effort: 'max' },
  }
  const dated = {
    role: 'system',
    content: "Today's date is 2026-11-15.",
    output_config: { effort: 'medium' },
  }
  const lifted = prepareCragPrintBody({
    output_config: { effort: 'high', format: { type: 'json_schema' } },
    messages: [userTurn('q'), dated, asstTurn('a'), userTurn('r'), effortOnly],
  })
  assert.deepEqual(
    lifted.messages.map((m) => m.role),
    ['user', 'assistant', 'user'],
  )
  assert.deepEqual(lifted.output_config, {
    effort: 'max',
    format: { type: 'json_schema' },
  })
  assert.ok(lifted.messages[0].content.at(-1).text.includes("Today's date"))

  const overridden = prepareCragPrintBody({
    output_config: { effort: 'high' },
    messages: [userTurn('q'), dated, asstTurn('a'), { ...userTurn('r'), output_config: { effort: 'low' } }],
  })
  assert.deepEqual(overridden.output_config, { effort: 'high' })

  const clearAt = { role: 'system', content: 'cleared', clear_at: 'tool_uses' }
  const kept = [userTurn('q'), clearAt]
  assert.deepEqual(foldHistorySystemMessages(kept), kept)

  const summary = agentBody({ summary: true })
  summary.messages.splice(1, 0, dated)
  summary.messages.push({
    role: 'system',
    content: [],
    output_config: { effort: 'low' },
  })
  const summaryOut = prepareCragPrintBody(summary, { agentSummary: true })
  assert.equal(summaryOut.output_config?.effort, summary.output_config?.effort)
})

test('a fold that would put a 1h breakpoint after a 5m one keeps the system turn', () => {
  const longSystem = {
    role: 'system',
    content: [
      {
        type: 'text',
        text: 'note',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ],
  }
  const shortResult = {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 't1',
        content: 'ok',
        cache_control: { type: 'ephemeral' },
      },
    ],
  }
  const inverted = [userTurn('q'), asstTurn('a'), longSystem, shortResult]
  assert.deepEqual(foldHistorySystemMessages(inverted), inverted)

  const longResult = {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 't1',
        content: 'ok',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ],
  }
  const folded = foldHistorySystemMessages([userTurn('q'), asstTurn('a'), longSystem, longResult])
  assert.deepEqual(
    folded.map((m) => m.role),
    ['user', 'assistant', 'user'],
  )
  assert.equal(folded[2].content[0].type, 'tool_result')
  assert.equal(folded[2].content[1].cache_control.ttl, '1h')
})

test('an agent summary leaves no unpaired tool_use for CRAG (history tool_result set is incomplete)', () => {
  const body = agentBody({ summary: true })
  body.messages[1].content.push({ type: 'tool_use', id: 'other', name: 'Read', input: {} })
  const out = prepareCragPrintBody(body, { agentSummary: true }).messages
  const answered = out
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => b.type === 'tool_result')
  const calls = out.flatMap((m) => (m.role === 'assistant' && Array.isArray(m.content) ? m.content : []))
  // Only the unanswered call stays live; the answered one is text now.
  assert.deepEqual(
    calls.filter((b) => b.type === 'tool_use').map((b) => b.id),
    ['other'],
  )
  assert.equal(answered.length, 0)
})

test('summary cleanup turns ToolSearch tool_reference results into text', () => {
  const body = agentBody({ summary: true })
  const current = body.messages[2].content[0]
  current.content = [{ type: 'tool_reference', tool_name: 'Monitor' }]
  const before = structuredClone(body)
  const out = prepareCragPrintBody(body, { agentSummary: true, officialPassthrough: true, foldSystemMessages: false })
  const blocks = out.messages[2].content
  // CRAG rejects a top-level tool_reference as "unsupported native history block".
  assert.ok(blocks.every((block) => block.type === 'text'))
  assert.deepEqual(blocks.slice(0, 2), [
    { type: 'text', text: `[tool result ${current.tool_use_id}]` },
    { type: 'text', text: '[tool_reference Monitor]' },
  ])
  assert.deepEqual(body, before)
  // Outside a summary fork the live tool_reference continuation is untouched.
  assert.deepEqual(prepareCragPrintBody(body, { foldSystemMessages: false }).messages, before.messages)
})

test('the CRAG print body hands the kernel automatic caching as a block marker', () => {
  const mark = { type: 'ephemeral', ttl: '1h' }
  const body = {
    model: 'claude-opus-5-5',
    cache_control: mark,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 's' }] },
      { role: 'user', content: [{ type: 'text', text: 'b' }] },
    ],
  }
  const out = prepareCragPrintBody(body, { foldSystemMessages: false })
  // The kernel 400s on the top-level field, so no path may forward it.
  assert.equal('cache_control' in out, false)
  // Same policy, on the current message tail, skipping the thinking block.
  assert.deepEqual(out.messages[2].content, [{ type: 'text', text: 'b', cache_control: mark }])
  // The caller's body is never mutated.
  assert.deepEqual(body.cache_control, mark)
  assert.equal(body.messages[2].content[0].cache_control, undefined)
})

test('automatic caching is converted before the provider-compatibility early return', () => {
  const out = prepareCragPrintBody(
    {
      model: 'claude-opus-5-5',
      cache_control: { type: 'ephemeral' },
      thread: { id: 'th_1' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }],
    },
    { capabilities: ['message_threads_beta'] },
  )
  // This path returns early; it still must not carry the field to the kernel.
  assert.equal('cache_control' in out, false)
  assert.deepEqual(out.messages[0].content[0].cache_control, { type: 'ephemeral' })
})

test('automatic caching still converts at the four-breakpoint budget', () => {
  const mark = { type: 'ephemeral' }
  // Conversion is count neutral: the root marker becomes the tail block marker
  // rather than joining the others, so a body at the budget stays at it. A
  // guard that counted the root as an addition would drop caching here — and
  // tools carrying a marker is the common shape for official traffic.
  const out = prepareCragPrintBody(
    {
      model: 'claude-opus-5-5',
      cache_control: mark,
      tools: [{ name: 'Bash', input_schema: { type: 'object' }, cache_control: mark }],
      system: [
        { type: 'text', text: 'one', cache_control: mark },
        { type: 'text', text: 'two', cache_control: mark },
      ],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }],
    },
    { foldSystemMessages: false },
  )
  assert.equal('cache_control' in out, false)
  assert.deepEqual(out.messages[0].content[0].cache_control, mark)
})

test('trailing cached system turn after assistant stays role-stable when next user turn appends (#2007)', () => {
  const block = (text, cache = false) => ({
    type: 'text',
    text,
    ...(cache ? { cache_control: { type: 'ephemeral', ttl: '1h' } } : {}),
  })
  const turnA = {
    model: 'claude-fable-5-2',
    max_tokens: 64,
    system: [block('Stable synthetic instructions.')],
    messages: [
      { role: 'user', content: [block('Read the synthetic input.')] },
      { role: 'assistant', content: [block('Read complete.')] },
      { role: 'system', content: [block('Synthetic background task notice.', true)] },
    ],
  }
  const turnB = {
    ...turnA,
    messages: [...turnA.messages, { role: 'user', content: [block('Continue.', true)] }],
  }
  const turnC = {
    ...turnB,
    messages: [
      ...turnB.messages,
      { role: 'assistant', content: [block('Continued.')] },
      { role: 'user', content: [block('Follow up.')] },
      { role: 'system', content: [block('Regular post-user reminder.')] },
    ],
  }
  const options = {
    preset: 'official_full',
    capabilities: [
      'generation_controls_v3',
      'prompt_append',
      'system_text_cache_v3',
      'linux_tui_native_queue',
      'native_history_v3',
    ],
  }
  const outA = prepareCragPrintBody(turnA, options)
  const outB = prepareCragPrintBody(turnB, options)
  const outC = prepareCragPrintBody(turnC, options)

  assert.equal(firstHistoryDiff(turnA, turnB).section, null)
  assert.equal(firstHistoryDiff(outA, outB).section, null)
  assert.equal(firstHistoryDiff(outB, outC).section, null)
  assert.deepEqual(
    outB.messages.map((m) => m.role),
    ['user', 'assistant', 'system', 'user'],
  )
  // Later regular post-user system notices still fold into their preceding user turn.
  assert.deepEqual(
    outC.messages.map((m) => m.role),
    ['user', 'assistant', 'system', 'user', 'assistant', 'user'],
  )
})

test('legacy CRAG V4 (without prompt_spec_v1) official_full reserves 2 template breakpoints while CRAG 3.1.27+ (prompt_spec_v1) preserves all 4 caller breakpoints (#2016)', () => {
  const countCacheControls = (obj) => {
    let n = 0
    const walk = (v) => {
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object') {
        if (v.cache_control != null) n += 1
        Object.values(v).forEach(walk)
      }
    }
    walk(obj)
    return n
  }

  const legacyV4Caps = ['headless_claude_bridge_v1', 'generation_controls_v3', 'prompt_append', 'system_text_cache_v3']
  const promptSpecV1Caps = [...legacyV4Caps, 'prompt_spec_v1']
  const promptSpecHealthFlag = { capabilities: legacyV4Caps, prompt_spec_v1: true }
  const inbound = {
    model: 'claude-opus-5-5',
    max_tokens: 64,
    stream: true,
    system: [
      { type: 'text', text: 'You are a concise assistant.', cache_control: { type: 'ephemeral', ttl: '1h' } },
      {
        type: 'text',
        text: "Follow the user's requested answer format.",
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
      {
        type: 'text',
        text: 'Do not call tools or perform any actions.',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Reply with exactly OK, nothing else.',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
      },
    ],
  }
  const relocated = relocateThirdPartySystem(inbound, { onlyForeign: false })

  // 1. Legacy CRAG V4 (<= 3.1.26, no prompt_spec_v1): reserves 2 template breakpoints so 4 caller -> 2 (2 + 2 <= 4).
  const legacyPrepared = prepareCragPrintBody(relocated.body, {
    preset: 'official_full',
    officialPassthrough: false,
    capabilities: legacyV4Caps,
    cacheTtl: '1h',
  })
  assert.equal(legacyPrepared.crag_persona_preset, 'official_full')
  assert.equal(legacyPrepared.system, undefined)
  assert.equal(countCacheControls(legacyPrepared), 2)
  assert.equal(legacyPrepared.messages[0].content[0].cache_control, undefined)
  assert.equal(legacyPrepared.messages[0].content[1].cache_control, undefined)
  assert.deepEqual(legacyPrepared.messages[0].content[2].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.deepEqual(legacyPrepared.messages[0].content[3].cache_control, { type: 'ephemeral', ttl: '1h' })

  const legacyWhitelist = sanitizeCragBodyWhitelist(
    {
      model: 'claude-opus-5-5',
      max_tokens: 64,
      crag_persona_preset: 'official_full',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'a', cache_control: { type: 'ephemeral', ttl: '1h' } },
            { type: 'text', text: 'b', cache_control: { type: 'ephemeral', ttl: '1h' } },
            { type: 'text', text: 'c', cache_control: { type: 'ephemeral', ttl: '1h' } },
            { type: 'text', text: 'd', cache_control: { type: 'ephemeral', ttl: '1h' } },
          ],
        },
      ],
    },
    { capabilities: legacyV4Caps },
  ).body
  assert.equal(countCacheControls(legacyWhitelist), 2)
  assert.deepEqual(legacyWhitelist.messages[0].content[2].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.deepEqual(legacyWhitelist.messages[0].content[3].cache_control, { type: 'ephemeral', ttl: '1h' })

  // 2. Modern CRAG V4 3.1.27+ (prompt_spec_v1 in capabilities OR health.prompt_spec_v1):
  //    preserves all 4 caller breakpoints intact; wire.rs::enforce_post_injection_cache_controls
  //    drops injected template markers first instead of sacrificing caller anchors.
  for (const opts of [
    { capabilities: promptSpecV1Caps, health: null },
    { capabilities: legacyV4Caps, health: promptSpecHealthFlag },
  ]) {
    const modernPrepared = prepareCragPrintBody(relocated.body, {
      preset: 'official_full',
      officialPassthrough: false,
      capabilities: opts.capabilities,
      health: opts.health,
      cacheTtl: '1h',
    })
    assert.equal(modernPrepared.crag_persona_preset, 'official_full')
    assert.equal(modernPrepared.crag_prompt_spec?.mode, 'official_full')
    assert.equal(modernPrepared.system, undefined)
    assert.equal(countCacheControls(modernPrepared), 4)
    const modernWhitelisted = sanitizeCragBodyWhitelist(modernPrepared, opts).body
    assert.equal(countCacheControls(modernWhitelisted), 4)
  }

  // 3. Controls: zero preset and officialPassthrough keep all 4 caller breakpoints even on legacy V4.
  const zeroPrepared = prepareCragPrintBody(inbound, {
    preset: 'zero',
    capabilities: legacyV4Caps,
    cacheTtl: '1h',
  })
  assert.equal(zeroPrepared.crag_persona_preset, 'zero')
  assert.equal(countCacheControls(zeroPrepared), 4)
  assert.equal(countCacheControls(sanitizeCragBodyWhitelist(zeroPrepared, { capabilities: legacyV4Caps }).body), 4)

  const passthroughPrepared = prepareCragPrintBody(inbound, {
    preset: 'official_full',
    officialPassthrough: true,
    capabilities: legacyV4Caps,
    cacheTtl: '1h',
  })
  assert.equal(countCacheControls(passthroughPrepared), 4)
  assert.equal(
    countCacheControls(sanitizeCragBodyWhitelist(passthroughPrepared, { capabilities: legacyV4Caps }).body),
    4,
  )
})
