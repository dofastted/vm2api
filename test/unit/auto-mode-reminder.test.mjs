import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeAnthropicMessages } from '../../src/lib/protocol/sanitize.mjs'
import { OFFICIAL_AUTO_MODE_REMINDER, repairAutoModeReminderText } from '../../src/lib/protocol/auto-mode-reminder.mjs'

const CANONICAL = `<system-reminder>\n${OFFICIAL_AUTO_MODE_REMINDER}\n</system-reminder>`
const HARNESS = `<system-reminder>\nAuto mode still active (reported by harness).\n</system-reminder>`
const SPARSE =
  '<system-reminder>\nAuto mode still active (see full instructions earlier in conversation). Execute autonomously, minimize interruptions, prefer action over planning.\n</system-reminder>'
const OLD_FULL = `<system-reminder>\n## Auto Mode Active\n\nAuto mode is active. The user chose continuous, autonomous execution. You should:\n\n1. Execute.\n</system-reminder>`

test('a stack of harness-reported auto mode reminders becomes one official reminder', () => {
  const body = {
    model: 'claude-sonnet-5',
    messages: [
      { role: 'user', content: `${HARNESS}\n我总是熬夜` },
      ...Array.from({ length: 10 }, () => ({ role: 'user', content: HARNESS })),
    ],
  }
  normalizeAnthropicMessages(body)
  assert.equal(body.messages.length, 1)
  assert.equal(body.messages[0].content, `${CANONICAL}\n我总是熬夜`)
  assert.equal(body.messages[0].content.includes('reported by harness'), false)
  const again = structuredClone(body)
  normalizeAnthropicMessages(again)
  assert.deepEqual(again, body)
})

test('old cli-node sparse and full auto mode prompts are replaced, official text is kept', () => {
  assert.equal(repairAutoModeReminderText(SPARSE), CANONICAL)
  assert.equal(repairAutoModeReminderText(OLD_FULL), CANONICAL)
  const official = `${CANONICAL}\n\nBefore any command that could discard uncommitted work — keep this extra section.`
  assert.equal(repairAutoModeReminderText(official), official)
  assert.equal(
    repairAutoModeReminderText('<system-reminder>\nPlan mode still active.\n</system-reminder>'),
    '<system-reminder>\nPlan mode still active.\n</system-reminder>',
  )
})

test('assistant echoes of the bad reminder are dropped and do not break alternation', () => {
  const body = {
    model: 'claude-sonnet-5',
    messages: [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: HARNESS },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: HARNESS },
          { type: 'text', text: '先睡。' },
        ],
      },
    ],
  }
  normalizeAnthropicMessages(body)
  assert.deepEqual(
    body.messages.map((message) => message.role),
    ['user', 'assistant'],
  )
  assert.deepEqual(body.messages[1].content, [{ type: 'text', text: '先睡。' }])
})
