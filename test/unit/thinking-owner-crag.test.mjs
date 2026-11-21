import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  ThinkingOwnerStore,
  dropForeignThinkingForCrag,
  thinkingSignatureKey,
} from '../../src/lib/pool/thinking-owner.mjs'

const OWN = 'sig-own-account-0123456789abcdef'
const OTHER = 'sig-other-account-0123456789abcd'
const UNKNOWN = 'sig-never-recorded-0123456789abcd'

function seeded() {
  const store = new ThinkingOwnerStore({ db: new DatabaseSync(':memory:') })
  store.record([thinkingSignatureKey({ type: 'thinking', signature: OWN })], 'acct-a')
  store.record([thinkingSignatureKey({ type: 'thinking', signature: OTHER })], 'acct-b')
  return store
}

test('closed history: foreign and unknown blocks go, own stays, thinking stays on', () => {
  const body = {
    thinking: { type: 'adaptive' },
    messages: [
      { role: 'user', content: 'a' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'x', signature: OTHER },
          { type: 'text', text: 'one' },
        ],
      },
      { role: 'user', content: 'b' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'y', signature: OWN },
          { type: 'redacted_thinking', data: UNKNOWN },
          { type: 'text', text: 'two' },
        ],
      },
      { role: 'user', content: 'c' },
    ],
  }
  const res = dropForeignThinkingForCrag(body, 'acct-a', seeded())
  assert.equal(res.kept, 1)
  assert.equal(res.dropped, 2)
  assert.equal(res.openLoop, false)
  assert.deepEqual(res.body.thinking, { type: 'adaptive' })
  assert.deepEqual(res.body.messages[1].content, [{ type: 'text', text: 'one' }])
  assert.deepEqual(
    res.body.messages[3].content.map((b) => b.type),
    ['thinking', 'text'],
  )
  assert.equal(res.body.messages[3].content[0].signature, OWN)
  // input untouched
  assert.equal(body.messages[1].content.length, 2)
})

test('all own: same body object back', () => {
  const body = {
    messages: [
      { role: 'user', content: 'a' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'y', signature: OWN },
          { type: 'text', text: 't' },
        ],
      },
      { role: 'user', content: 'b' },
    ],
  }
  const res = dropForeignThinkingForCrag(body, 'acct-a', seeded())
  assert.equal(res.body, body)
  assert.equal(res.dropped, 0)
})

test('thinking-only foreign turn is dropped', () => {
  const body = {
    messages: [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: UNKNOWN }] },
      { role: 'user', content: 'b' },
    ],
  }
  const res = dropForeignThinkingForCrag(body, 'acct-a', seeded())
  assert.equal(res.droppedTurns, 1)
  assert.deepEqual(
    res.body.messages.map((m) => m.role),
    ['user'],
  )
  assert.equal(res.body.messages[0].content, 'a\nb')
})

test('open tool loop touched: loop thinking wiped and thinking turned off', () => {
  const body = {
    thinking: { type: 'adaptive' },
    context_management: { edits: [{ type: 'clear_thinking_20251015' }] },
    messages: [
      { role: 'user', content: 'a' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'old', signature: OWN },
          { type: 'text', text: 'ok' },
        ],
      },
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'x', signature: OTHER },
          { type: 'tool_use', id: 't1', name: 'Read', input: {} },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'y', signature: OWN },
          { type: 'tool_use', id: 't2', name: 'Read', input: {} },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'r' }] },
    ],
  }
  const res = dropForeignThinkingForCrag(body, 'acct-a', seeded())
  assert.equal(res.openLoop, true)
  assert.equal(res.thinkingOff, true)
  assert.equal(res.body.thinking, undefined)
  assert.equal(res.body.context_management.edits, undefined)
  assert.equal(res.body.messages[1].content[0].signature, OWN)
  assert.equal(res.body.messages[3].content[0].type, 'tool_use')
  assert.equal(res.body.messages[5].content[0].type, 'tool_use')
  assert.deepEqual(body.thinking, { type: 'adaptive' })
})

test('prefill with a foreign block is left alone', () => {
  const body = {
    messages: [
      { role: 'user', content: 'a' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'x', signature: OTHER },
          { type: 'text', text: 't' },
        ],
      },
    ],
  }
  const res = dropForeignThinkingForCrag(body, 'acct-a', seeded())
  assert.equal(res.bailed, 'prefill')
  assert.equal(res.body, body)
})

test('no database: unchanged', () => {
  const body = {
    messages: [
      { role: 'user', content: 'a' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'x', signature: OTHER },
          { type: 'text', text: 't' },
        ],
      },
      { role: 'user', content: 'b' },
    ],
  }
  const res = dropForeignThinkingForCrag(body, 'acct-a', { ownersOf: () => null })
  assert.equal(res.bailed, 'no_db')
  assert.equal(res.body, body)
})
