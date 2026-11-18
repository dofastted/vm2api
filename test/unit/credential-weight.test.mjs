import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  automaticScheduleLevel,
  parseScheduleLevelInput,
  resolveCredentialScheduleLevel,
  setResetPriorityEnabled,
  weeklyResetAt,
} from '../../src/lib/pool/credential-weight.mjs'
import { normalizePoolRouting, PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'
import { persistVmActiveHours, persistVmScheduleLevel, summarizeVm } from '../../src/lib/vm/vm-registry.mjs'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-09-01T12:00:00.000Z')

test('automatic schedule level follows rolling 24-hour buckets', () => {
  assert.equal(automaticScheduleLevel(NOW + 1, NOW), 7)
  assert.equal(automaticScheduleLevel(NOW + DAY_MS - 1, NOW), 7)
  assert.equal(automaticScheduleLevel(NOW + DAY_MS, NOW), 6)
  assert.equal(automaticScheduleLevel(NOW + 2 * DAY_MS, NOW), 5)
  assert.equal(automaticScheduleLevel(NOW + 5 * DAY_MS, NOW), 2)
  assert.equal(automaticScheduleLevel(NOW + 6 * DAY_MS, NOW), 1)
  assert.equal(automaticScheduleLevel(NOW + 7 * DAY_MS, NOW), 1)
})

test('automatic schedule level falls back to one for missing, invalid, or elapsed reset', () => {
  assert.equal(automaticScheduleLevel(null, NOW), 1)
  assert.equal(automaticScheduleLevel('invalid', NOW), 1)
  assert.equal(automaticScheduleLevel(NOW, NOW), 1)
  assert.equal(automaticScheduleLevel(NOW - 1, NOW), 1)
})

test('weekly reset prefers a future live header and falls back to official usage', () => {
  const officialReset = new Date(NOW + 3 * DAY_MS).toISOString()
  const headerReset = new Date(NOW + DAY_MS).toISOString()
  const unified = {
    headers: { '7d': { reset: headerReset, status: 'allowed' } },
    official: { '7d': { resets_at: officialReset, status: 'allowed' } },
  }
  assert.equal(weeklyResetAt(unified, NOW), headerReset)
  unified.headers['7d'].reset = new Date(NOW - 1).toISOString()
  assert.equal(weeklyResetAt(unified, NOW), officialReset)
})

test('manual schedule level overrides automatic level and validates the public input', () => {
  const resolved = resolveCredentialScheduleLevel({
    vm: { policy: { priority: 10 } },
    resetAt: NOW + DAY_MS,
    now: NOW,
  })
  assert.deepEqual(resolved, { level: 10, mode: 'manual' })
  assert.deepEqual(parseScheduleLevelInput('auto'), { ok: true, value: null })
  assert.deepEqual(parseScheduleLevelInput(null), { ok: true, value: null })
  assert.deepEqual(parseScheduleLevelInput(1), { ok: true, value: 1 })
  assert.deepEqual(parseScheduleLevelInput(10), { ok: true, value: 10 })
  assert.equal(parseScheduleLevelInput(0).ok, false)
  assert.equal(parseScheduleLevelInput(11).ok, false)
  assert.equal(parseScheduleLevelInput(1.5).ok, false)
})

test('VM schedule level persists independently from WRR weight and can return to auto', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-credential-weight-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  const file = path.join(root, 'vms', 'vm-01.json')
  fs.writeFileSync(file, JSON.stringify({ id: 'vm-01', name: 'one', policy: { weight: 3 } }))

  persistVmScheduleLevel(root, 'vm-01', 9)
  let saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.policy.priority, 9)
  assert.equal(saved.policy.weight, 3)
  assert.equal(summarizeVm(saved).schedule_level_manual, 9)

  persistVmScheduleLevel(root, 'vm-01', null)
  saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.policy.priority, undefined)
  assert.equal(saved.policy.weight, 3)
  assert.equal(summarizeVm(saved).schedule_level_manual, null)
})

test('VM active hours persist, normalize, and clear to 24h duty', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-active-hours-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  const file = path.join(root, 'vms', 'vm-01.json')
  fs.writeFileSync(file, JSON.stringify({ id: 'vm-01', name: 'one', policy: { weight: 3 } }))

  persistVmActiveHours(root, 'vm-01', { start: '20:00', end: '08:00', timezone: 'asia/shanghai', days: [6, 0, 0] })
  let saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(saved.policy.active_hours, {
    start: '20:00',
    end: '08:00',
    timezone: 'Asia/Shanghai',
    days: [0, 6],
  })
  assert.deepEqual(summarizeVm(saved).active_hours, saved.policy.active_hours)

  persistVmActiveHours(root, 'vm-01', null)
  saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.policy.active_hours, undefined)
  assert.equal(saved.policy.weight, 3)
  assert.equal(summarizeVm(saved).active_hours, null)

  assert.throws(() => persistVmActiveHours(root, 'vm-01', { start: '8:00', end: '22:00' }), TypeError)
})

test('pool.reset_priority off flattens auto levels; manual levels still apply', () => {
  try {
    assert.equal(normalizePoolRouting({}).reset_priority, true)
    assert.equal(normalizePoolRouting({ reset_priority: false }).reset_priority, false)
    setResetPriorityEnabled(false)
    assert.equal(automaticScheduleLevel(NOW + 1, NOW), 1)
    assert.equal(automaticScheduleLevel(NOW + 6 * DAY_MS, NOW), 1)
    assert.deepEqual(resolveCredentialScheduleLevel({ manualLevel: 5, resetAt: NOW + 1, now: NOW }), {
      level: 5,
      mode: 'manual',
    })
    setResetPriorityEnabled(true)
    assert.equal(automaticScheduleLevel(NOW + 1, NOW), 7)
  } finally {
    setResetPriorityEnabled(true)
  }
})

test('PoolScheduler config load and hot reload drive reset_priority', () => {
  try {
    const scheduler = new PoolScheduler({ config: { reset_priority: false } })
    assert.equal(automaticScheduleLevel(NOW + 1, NOW), 1)
    scheduler.reloadConfig({})
    assert.equal(automaticScheduleLevel(NOW + 1, NOW), 7)
  } finally {
    setResetPriorityEnabled(true)
  }
})
