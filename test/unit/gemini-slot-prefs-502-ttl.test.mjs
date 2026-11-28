import assert from 'node:assert/strict'
import test from 'node:test'
import { createGeminiSlotPrefs } from '../../src/lib/gemini/slot-prefs.mjs'

function makePrefs(start = Date.parse('2026-11-28T06:24:57.670Z')) {
  const clock = { t: start }
  const prefs = createGeminiSlotPrefs({ now: () => clock.t })
  return { prefs, clock }
}

const TEN_MIN = 10 * 60 * 1000

test('an upstream_502 mark expires on its own so a healthy account is not parked forever (#2049)', () => {
  const { prefs, clock } = makePrefs()
  prefs.markUnschedulable('gem-1', 'upstream_502', 'LLM response received', { upstream_status: 502 })

  assert.equal(prefs.resolved('gem-1').unschedulable?.reason, 'upstream_502')
  assert.equal(prefs.get('gem-1').unschedulable?.reason, 'upstream_502')

  clock.t += TEN_MIN - 1
  assert.equal(prefs.resolved('gem-1').unschedulable?.reason, 'upstream_502', 'still parked just before expiry')

  clock.t += 1
  const after = prefs.resolved('gem-1')
  assert.equal(after.unschedulable, null)
  assert.equal(after.unschedulable_reason, null)
  assert.equal(after.schedulable, true)
})

test('proxy_502 also expires', () => {
  const { prefs, clock } = makePrefs()
  prefs.markUnschedulable('gem-2', 'proxy_502', 'socks5 reset', { upstream_status: 502 })
  clock.t += TEN_MIN
  assert.equal(prefs.resolved('gem-2').unschedulable, null)
})

test('deterministic faults never expire by time', () => {
  const { prefs, clock } = makePrefs()
  for (const reason of ['reauth_required', 'verification_required', 'location_unsupported', 'ineligible']) {
    prefs.markUnschedulable(`gem-${reason}`, reason, 'x')
  }
  clock.t += 30 * 24 * 60 * 60 * 1000
  for (const reason of ['reauth_required', 'verification_required', 'location_unsupported', 'ineligible']) {
    assert.equal(prefs.resolved(`gem-${reason}`).unschedulable?.reason, reason)
  }
})

test('a fresh 502 re-arms the window instead of inheriting the old deadline', () => {
  const { prefs, clock } = makePrefs()
  prefs.markUnschedulable('gem-3', 'upstream_502', 'first')
  clock.t += TEN_MIN - 1000
  prefs.markUnschedulable('gem-3', 'upstream_502', 'second')
  clock.t += TEN_MIN - 1000
  assert.equal(prefs.resolved('gem-3').unschedulable?.detail, 'second')
  clock.t += 1000
  assert.equal(prefs.resolved('gem-3').unschedulable, null)
})

test('an expired mark is dropped from the persisted entry so it stops reappearing', () => {
  const { prefs, clock } = makePrefs()
  prefs.markUnschedulable('gem-4', 'upstream_502', 'x')
  prefs.patch('gem-4', { schedule_level: 3 })
  clock.t += TEN_MIN
  assert.equal(prefs.all()['gem-4']?.unschedulable, undefined)
  assert.equal(prefs.all()['gem-4']?.schedule_level, 3)
})

test('an operator toggle-off (schedulable:false) is unaffected by the 502 expiry', () => {
  const { prefs, clock } = makePrefs()
  prefs.patch('gem-5', { schedulable: false })
  prefs.markUnschedulable('gem-5', 'upstream_502', 'x')
  clock.t += TEN_MIN
  const r = prefs.resolved('gem-5')
  assert.equal(r.unschedulable, null)
  assert.equal(r.schedulable, false, 'manual off stays off')
})

test('a legacy 502 mark persisted before this change (no expires_at) expires from its `at`', () => {
  const at = '2026-11-28T06:24:57.670Z'
  const store = { 'gem-6': { unschedulable: { reason: 'upstream_502', at, detail: 'old' } } }
  const clock = { t: Date.parse(at) + TEN_MIN - 1 }
  const settingsRepo = {
    get: () => store,
    set: (_k, v) => Object.assign(store, v),
  }
  const prefs = createGeminiSlotPrefs({ settingsRepo, now: () => clock.t })
  assert.equal(prefs.resolved('gem-6').unschedulable?.reason, 'upstream_502')
  clock.t += 1
  assert.equal(prefs.resolved('gem-6').unschedulable, null)
})

test('manual clearUnschedulable still works before expiry', () => {
  const { prefs } = makePrefs()
  prefs.markUnschedulable('gem-7', 'upstream_502', 'x')
  prefs.clearUnschedulable('gem-7')
  assert.equal(prefs.resolved('gem-7').unschedulable, null)
})
