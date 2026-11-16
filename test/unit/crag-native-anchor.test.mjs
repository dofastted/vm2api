import assert from 'node:assert/strict'
import test from 'node:test'
import { dropNativeBlockCacheAnchors, prepareCragPrintBody } from '../../src/lib/protocol/crag-print-prompt.mjs'

const CC = { type: 'ephemeral' }
const history = () => [
  { role: 'user', content: [{ type: 'text', text: 'run ls' }] },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'x', signature: 'sig' },
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Bash',
        input: { command: 'ls' },
        caller: { type: 'direct' },
        cache_control: CC,
      },
    ],
  },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a', cache_control: CC }] },
]

test('drops cache_control only on model-emitted (caller) assistant blocks', () => {
  const input = history()
  const out = dropNativeBlockCacheAnchors(input)
  const toolUse = out[1].content[1]
  assert.equal(toolUse.cache_control, undefined)
  assert.deepEqual(toolUse.caller, { type: 'direct' })
  assert.equal(toolUse.id, 'toolu_1')
  assert.deepEqual(out[1].content[0], input[1].content[0])
  assert.deepEqual(out[2].content[0].cache_control, CC, 'trailing tool_result breakpoint stays')
  assert.equal(input[1].content[1].cache_control, CC, 'input not mutated')
})

test('leaves blocks without caller and non-assistant turns alone', () => {
  const input = history()
  delete input[1].content[1].caller
  assert.equal(dropNativeBlockCacheAnchors(input), input)
  const user = [{ role: 'user', content: [{ type: 'text', text: 'x', caller: { type: 'direct' }, cache_control: CC }] }]
  assert.equal(dropNativeBlockCacheAnchors(user), user)
})

test('prepareCragPrintBody applies it', () => {
  const out = prepareCragPrintBody(
    { model: 'claude-opus-5-5', max_tokens: 10, messages: history() },
    { foldSystemMessages: false },
  )
  const toolUse = out.messages[1].content.find((block) => block.type === 'tool_use')
  assert.equal(toolUse.id, 'toolu_1')
  assert.equal(toolUse.cache_control, undefined)
  assert.deepEqual(out.messages[2].content[0].cache_control, CC)
})
