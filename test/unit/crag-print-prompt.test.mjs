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
  prepareCragPrintBody,
  projectCallerSystem,
  readSlotKernelConfig,
  resolveCragPrintPersona,
  trackCallerSystemBlock,
} from '../../src/lib/protocol/crag-print-prompt.mjs'
import { sanitizeAnthropicBody } from '../../src/lib/protocol/sanitize.mjs'

const billing = 'x-anthropic-billing-header: cc_version=2.1.317'
const identity = 'You are Claude Code, an agent.'
const harness = 'You are an agent working with the user.'
const guidance = 'Bias toward working.'

const cwdTag = (cwd) => `<cwd>\n${cwd}\n</cwd>`
const callerCwdFromSystem = (system) => callerCwdDeclaration(system)?.cwd ?? null

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

test('CRAG print persona does not follow the cli-node preset', () => {
  const routing = { compatibility: { persona_preset: 'official', crag_persona_preset: 'zero' } }
  assert.equal(resolveCragPrintPersona({}, routing), 'zero')
  assert.equal(resolveCragPrintPersona({ persona_preset: 'official' }, routing), 'official_full')
  assert.equal(resolveCragPrintPersona({ persona_preset: 'official_303' }, routing), 'official_full')
  assert.equal(resolveCragPrintPersona({ persona_preset: 'zero' }, routing), 'zero')
  assert.equal(resolveCragPrintPersona({}, { compatibility: { persona_preset: 'zero' } }), 'official_full')
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

test('routing save accepts only the two CRAG print presets', () => {
  assert.deepEqual(validatePersonaRoutingPatch({ compatibility: { crag_persona_preset: 'official_full' } }), [])
  assert.deepEqual(validatePersonaRoutingPatch({ compatibility: { crag_persona_preset: 'zero' } }), [])
  assert.deepEqual(validatePersonaRoutingPatch({ compatibility: { crag_persona_preset: '' } }), [])
  assert.match(
    validatePersonaRoutingPatch({ compatibility: { crag_persona_preset: 'official' } })[0],
    /official_full \/ zero/,
  )
})
