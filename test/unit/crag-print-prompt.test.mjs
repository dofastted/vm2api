import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { validatePersonaRoutingPatch } from '../../src/lib/admin/panel-api.mjs'
import {
  callerSystemTail,
  cragV2KernelActive,
  prepareCragPrintBody,
  readSlotKernelConfig,
  resolveCragPrintPersona,
} from '../../src/lib/protocol/crag-print-prompt.mjs'

const billing = 'x-anthropic-billing-header: cc_version=2.1.317'
const identity = 'You are Claude Code, an agent.'
const harness = 'You are an agent working with the user.'
const guidance = 'Bias toward working.'

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
  assert.equal(cragV2KernelActive({ vm: { dataplane: 'crag', crag_kernel_version: 'legacy' } }), false)
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
