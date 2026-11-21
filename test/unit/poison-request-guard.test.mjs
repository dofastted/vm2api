import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PoisonRequestGuard, describeRequest, messageDigests } from '../../src/lib/pool/poison-request-guard.mjs'

const SECRET = 'TOP-SECRET-SENTINEL-do-not-log'

function body(...messages) {
  return { model: 'claude-opus-test', messages }
}

const user = (text) => ({ role: 'user', content: text })
const assistantToolUse = (name = 'Read') => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id: 'toolu_1', name, input: { file_path: `/tmp/${SECRET}` } }],
})
const toolResult = (inner) => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: inner }],
})

function clock(start = 1_000_000) {
  const t = { now: start }
  return { t, now: () => t.now }
}

function guard(overrides = {}) {
  const { t, now } = clock()
  const logger = { warn: (line) => logger.lines.push(line), lines: [] }
  return { g: new PoisonRequestGuard({ threshold: 2, now, logger, ...overrides }), t, logger }
}

const turn = body(user('hi'), assistantToolUse(), toolResult('ok'))

test('one silent timeout does not quarantine; the second identical request does', () => {
  const { g } = guard()
  assert.equal(g.recordSilentTimeout('sess:a', turn).quarantined, false)
  assert.equal(g.check('sess:a', turn), null)
  assert.equal(g.recordSilentTimeout('sess:a', turn).quarantined, true)
  const blocked = g.check('sess:a', turn)
  assert.equal(blocked.failures, 2)
  assert.ok(blocked.retryAfterSec > 0)
})

test('the same conversation with new turns appended is still quarantined', () => {
  const { g } = guard()
  g.recordSilentTimeout('sess:a', turn)
  g.recordSilentTimeout('sess:a', turn)
  const longer = body(...turn.messages, { role: 'assistant', content: 'x' }, user('continue'))
  assert.ok(g.check('sess:a', longer))
})

test('rewinding before the failing turn, or starting over, is allowed', () => {
  const { g } = guard()
  g.recordSilentTimeout('sess:a', turn)
  g.recordSilentTimeout('sess:a', turn)
  assert.equal(g.check('sess:a', body(user('hi'), assistantToolUse())), null, 'shorter prefix')
  assert.equal(g.check('sess:a', body(user('hi'), assistantToolUse(), toolResult('different'))), null, 'edited tail')
  assert.equal(g.check('sess:a', body(user('brand new'))), null, 'new conversation')
})

test('other sessions and a missing session key are never blocked', () => {
  const { g } = guard()
  g.recordSilentTimeout('sess:a', turn)
  g.recordSilentTimeout('sess:a', turn)
  assert.equal(g.check('sess:b', turn), null)
  assert.equal(g.check('', turn), null)
  assert.equal(g.recordSilentTimeout('', turn), null)
})

test('the quarantine lifts after its time, then a single further failure re-quarantines', () => {
  const { g, t } = guard({ quarantineMs: 60_000 })
  g.recordSilentTimeout('sess:a', turn)
  g.recordSilentTimeout('sess:a', turn)
  t.now += 59_000
  assert.ok(g.check('sess:a', turn))
  t.now += 2_000
  assert.equal(g.check('sess:a', turn), null, 'one probe may pass')
  assert.equal(g.recordSilentTimeout('sess:a', turn).quarantined, true)
  assert.ok(g.check('sess:a', turn))
})

test('a success for the session clears its record', () => {
  const { g } = guard()
  g.recordSilentTimeout('sess:a', turn)
  g.recordSilentTimeout('sess:a', turn)
  g.recordSuccess('sess:a')
  assert.equal(g.check('sess:a', turn), null)
  assert.equal(g.recordSilentTimeout('sess:a', turn).quarantined, false)
})

test('failures outside the window do not accumulate', () => {
  const { g, t } = guard({ windowMs: 60_000, quarantineMs: 30_000 })
  g.recordSilentTimeout('sess:a', turn)
  t.now += 120_000
  assert.equal(g.recordSilentTimeout('sess:a', turn).quarantined, false)
})

test('threshold 0 or quarantine 0 disables the guard', () => {
  for (const o of [{ threshold: 0 }, { quarantineMs: 0 }]) {
    const { g } = guard(o)
    assert.equal(g.recordSilentTimeout('sess:a', turn), null)
    assert.equal(g.check('sess:a', turn), null)
  }
})

test('the table is bounded and drops the oldest sessions', () => {
  const { g } = guard({ maxEntries: 3 })
  for (const k of ['s1', 's2', 's3', 's4']) g.recordSilentTimeout(k, turn)
  assert.equal(g.snapshot().length, 3)
  assert.equal(
    g.snapshot().some((e) => e.session === 's1'),
    false,
  )
})

test('bodies without messages are ignored', () => {
  const { g } = guard()
  assert.equal(messageDigests({}), null)
  assert.equal(g.recordSilentTimeout('sess:a', { model: 'x' }), null)
  assert.equal(g.check('sess:a', undefined), null)
})

test('the structure report has sizes and kinds but never any content', () => {
  const big = 'x'.repeat(5000)
  const req = body(
    user(`please read ${SECRET}`),
    assistantToolUse('Read'),
    toolResult([
      { type: 'text', text: `${SECRET} ${big}` },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]),
  )
  req.tools = [{ name: 'Read' }, { name: 'Bash' }]
  req.system = [{ type: 'text', text: 'system prompt' }]
  const d = describeRequest(req)
  assert.equal(d.messages, 3)
  assert.equal(d.tools, 2)
  assert.ok(d.bytes > 5000)
  const last = d.last_messages.at(-1)
  assert.equal(last.role, 'user')
  assert.deepEqual(last.blocks[0].result_kinds, ['text', 'image'])
  assert.ok(last.blocks[0].bytes > 5000)
  assert.equal(d.largest_blocks[0].type, 'tool_result')
  assert.equal(JSON.stringify(d).includes(SECRET), false, 'no message text, tool input or path may leak')
})

test('control characters and lone surrogates are reported as flags only', () => {
  const nul = describeRequest(body(user('a\u0000b')))
  assert.equal(nul.flags.control_chars, true)
  const lone = describeRequest(body(user(`a${String.fromCharCode(0xd800)}b`)))
  assert.equal(lone.flags.lone_surrogates, true)
  const clean = describeRequest(body(user('plain\ttext\nok')))
  assert.deepEqual(clean.flags, {})
})

test('each failure logs one structured line without content', () => {
  const { g, logger } = guard()
  g.recordSilentTimeout('sess:a', body(user(SECRET)), { vm_id: 'vm-03', account_id: 'acc-1' })
  assert.equal(logger.lines.length, 1)
  assert.match(logger.lines[0], /^\[poison-request\] \{/)
  assert.equal(logger.lines[0].includes(SECRET), false)
  const parsed = JSON.parse(logger.lines[0].replace('[poison-request] ', ''))
  assert.equal(parsed.vm_id, 'vm-03')
  assert.equal(parsed.failures, 1)
  assert.equal(parsed.quarantined, false)
})
