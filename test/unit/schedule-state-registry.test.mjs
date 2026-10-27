import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  clearScheduleHold,
  clearUnschedulable,
  getVm,
  holdSchedulableSlots,
  markUnschedulable,
  migrateScheduleFields,
  resumeSchedulableSlots,
  setScheduleHold,
  setScheduleOff,
  setVmSchedulable,
  waitForSlotDrain,
} from '../../src/lib/vm/vm-registry.mjs'
import { restoreScheduleAfterLiveCredential } from '../../src/lib/oauth/oauth-credentials.mjs'

function project(records) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-sched-'))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  for (const record of records) {
    fs.writeFileSync(path.join(root, 'vms', `${record.id}.json`), JSON.stringify(record))
  }
  return root
}

const read = (root, id) => JSON.parse(fs.readFileSync(path.join(root, 'vms', `${id}.json`), 'utf8'))

test('automatic writes never reopen 调度关 or 不可调度', (t) => {
  const root = project([{ id: 'vm-01', status: 'running', schedulable: true, claude: { has_access: true } }])
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const off = setVmSchedulable(root, 'vm-01', false, 'disabled', { source: 'manual', preserveStatus: true })
  assert.equal(off.schedulable, false)
  assert.equal(off.schedule_off, true)
  assert.equal(read(root, 'vm-01').status, 'running')
  assert.equal(setVmSchedulable(root, 'vm-01', true).schedulable, false)

  setScheduleOff(root, 'vm-01', false)
  markUnschedulable(root, 'vm-01', 'proxy_desynced')
  assert.equal(setVmSchedulable(root, 'vm-01', true, null, { source: 'force' }).schedulable, false)
  assert.throws(() => clearUnschedulable(root, 'vm-01', { by: 'refresh' }), /not allowed/)
  const reopened = clearUnschedulable(root, 'vm-01', { by: 'proxy_rebind' })
  assert.equal(reopened.schedulable, true)
  assert.equal(reopened.unschedulable, null)
})

test('the operator "on" does not shield a slot from a later failure', (t) => {
  const root = project([{ id: 'vm-01', status: 'running', schedulable: true, schedule_manual: true }])
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  setScheduleOff(root, 'vm-01', false)
  const broken = markUnschedulable(root, 'vm-01', 'oauth_invalid_grant')
  assert.equal(broken.schedulable, false)
  assert.equal(broken.schedule_disabled_reason, 'oauth_invalid_grant')
})

test('org pause records the upstream error and only an operator action resumes it', (t) => {
  const root = project([
    {
      id: 'vm-01',
      status: 'running',
      schedulable: true,
      schedule_manual: true,
      claude: { has_access: true, has_refresh: true },
    },
  ])
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const detail = { status: 403, message: 'OAuth authentication is currently not allowed for this organization.' }
  const paused = markUnschedulable(root, 'vm-01', 'organization_disabled', detail)
  assert.equal(paused.schedulable, false)
  assert.equal(paused.schedule_disabled_reason, 'organization_disabled')
  assert.deepEqual(paused.unschedulable.detail, detail)
  assert.equal(read(root, 'vm-01').status, 'running')

  // Proxy re-enable, worker reload and a background credential mirror neither resume nor rename it.
  assert.equal(setVmSchedulable(root, 'vm-01', true).schedulable, false)
  setScheduleHold(root, 'vm-01', 'proxy_cooldown', { tag: 'p1' })
  assert.equal(getVm(root, 'vm-01').schedule_disabled_reason, 'organization_disabled')
  clearScheduleHold(root, 'vm-01', 'proxy_cooldown', { tag: 'p1' })
  const record = read(root, 'vm-01')
  restoreScheduleAfterLiveCredential(record)
  assert.equal(record.schedulable, false)

  const resumed = setScheduleOff(root, 'vm-01', false)
  assert.equal(resumed.schedulable, true)
  assert.equal(resumed.unschedulable, null)
  assert.equal('unschedulable' in read(root, 'vm-01'), false)
})

test('kernel update hold is a maintenance hold its owner lifts', async (t) => {
  const root = project([
    { id: 'vm-01', status: 'running', schedulable: true },
    { id: 'vm-02', status: 'running', schedulable: false, schedule_manual: true, schedule_disabled_reason: 'disabled' },
  ])
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const held = holdSchedulableSlots(root, 'kernel_update')
  assert.deepEqual(held, ['vm-01'])
  assert.equal(getVm(root, 'vm-01').schedule_hold.reason, 'maintenance')
  assert.equal(getVm(root, 'vm-01').schedulable, false)
  assert.equal(setVmSchedulable(root, 'vm-01', true).schedulable, false, 'auto on does not lift a hold')
  const drain = await waitForSlotDrain({ vmInflight: new Map([['vm-01', 1]]) }, held, { timeoutMs: 1 })
  assert.equal(drain.ok, false)
  assert.deepEqual(resumeSchedulableSlots(root, held, 'kernel_update'), ['vm-01'])
  assert.equal(getVm(root, 'vm-01').schedulable, true)
  assert.equal(getVm(root, 'vm-02').schedule_disabled_reason, 'disabled')
})

test('setVmSchedulable routes legacy reasons onto the owned fields', (t) => {
  const root = project([{ id: 'vm-01', status: 'running', schedulable: true }])
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.equal(setVmSchedulable(root, 'vm-01', false, 'proxy_edit_worker_reload').schedule_hold.reason, 'maintenance')
  clearScheduleHold(root, 'vm-01', 'maintenance')
  assert.equal(setVmSchedulable(root, 'vm-01', false, 'egress_down|proxy=p7').schedule_hold.detail.tag, 'p7')
  clearScheduleHold(root, 'vm-01', 'proxy_cooldown', { tag: 'p7' })
  const failed = setVmSchedulable(root, 'vm-01', false, 'boot timed out')
  assert.equal(failed.unschedulable.reason, 'runtime_start_failed')
  assert.equal(failed.unschedulable.detail.message, 'boot timed out')
})

test('boot migration backs up and rewrites legacy records once', (t) => {
  const root = project([
    { id: 'vm-01', schedulable: false, schedule_disabled_reason: 'oauth_revoked' },
    { id: 'vm-02', schedulable: false, schedule_disabled_reason: 'quota_7d_header' },
    { id: 'vm-03', schedulable: true },
  ])
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const migrated = migrateScheduleFields(root)
  assert.deepEqual(
    migrated.map((row) => [row.id, row.state, row.reason]),
    [
      ['vm-01', 'unschedulable', 'oauth_revoked'],
      ['vm-02', 'on', null],
    ],
  )
  assert.equal(read(root, 'vm-02').schedulable, true)
  assert.equal(read(root, 'vm-01').schedule_disabled_reason, 'oauth_revoked', 'legacy fields stay for rollback')
  const backups = fs.readdirSync(path.join(root, 'backups'))
  assert.equal(backups.length, 1)
  assert.deepEqual(fs.readdirSync(path.join(root, 'backups', backups[0])).sort(), ['vm-01.json', 'vm-02.json'])
  assert.deepEqual(migrateScheduleFields(root), [])
})
