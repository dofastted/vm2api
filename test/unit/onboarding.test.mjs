import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { hashPassword } from '../../src/lib/admin/panel-users.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { filterVmsForPanel } from '../../src/lib/admin/resource-owner.mjs'
import {
  DEFAULT_ADMIN_PASSWORD,
  MASTER_ONBOARDING_USER,
  STEPS_BY_ROLE,
  adminPasswordDone,
  applyOnboardingAction,
  buildOnboardingPayload,
  loadOnboardingState,
  needsWelcome,
  onboardingRoleOf,
  onboardingUserOf,
  panelBaseUrl,
  recordOf,
  saveOnboardingState,
  stepsForRole,
  vmStepFacts,
} from '../../src/lib/admin/onboarding.mjs'

function idsOf(role) {
  return stepsForRole(role)
}

function payload(role, facts = {}, extra = {}) {
  return buildOnboardingPayload({ user: extra.user || role, role, facts, ...extra })
}

test('default password remains pending until the effective admin password changes', () => {
  const defaultAdmin = { password_hash: hashPassword(DEFAULT_ADMIN_PASSWORD) }
  const changedAdmin = { password_hash: hashPassword('changed-admin-pass') }
  const cases = [
    [{ envPassword: DEFAULT_ADMIN_PASSWORD, envAdmin: null }, false],
    [{ envPassword: DEFAULT_ADMIN_PASSWORD, envAdmin: defaultAdmin }, false],
    [{ envPassword: DEFAULT_ADMIN_PASSWORD, envAdmin: changedAdmin }, true],
    [{ envPassword: 'custom-pass', envAdmin: null }, true],
    [{ envPassword: 'custom-pass', envAdmin: defaultAdmin }, false],
    [{ envPassword: 'custom-pass', envAdmin: changedAdmin }, true],
  ]
  for (const [facts, done] of cases) {
    assert.equal(adminPasswordDone(facts), done)
    assert.equal(payload('admin', facts).steps.find((s) => s.id === 'admin_password').done, done)
  }
})

test('step sets follow role: admin 6, user 5, super schedulable+first_request', () => {
  assert.deepEqual(idsOf('admin'), [
    'admin_password',
    'egress',
    'slot_account',
    'schedulable',
    'api_key',
    'first_request',
  ])
  assert.equal(STEPS_BY_ROLE.admin.length, 6)
  assert.deepEqual(idsOf('user'), ['egress', 'slot_account', 'schedulable', 'api_key', 'first_request'])
  assert.equal(
    payload('user').steps.some((s) => s.id === 'admin_password'),
    false,
  )
  assert.equal(payload('user').total, 5)
  assert.deepEqual(idsOf('super'), ['schedulable', 'first_request'])
  assert.equal(payload('super').total, 2)
  assert.deepEqual(
    payload('super').steps.map((s) => s.id),
    ['schedulable', 'first_request'],
  )
})

test('guide pops until skip or finish, even when setup steps are already done', () => {
  assert.equal(needsWelcome(false), true)
  assert.equal(needsWelcome(undefined), true)
  assert.equal(needsWelcome(true), false)
  const fresh = payload('admin')
  assert.equal(fresh.guide_used, false)
  assert.equal(fresh.needs_welcome, true)
  const legacy = buildOnboardingPayload({
    user: 'admin',
    role: 'admin',
    status: 'dismissed',
    guide_used: false,
    facts: {
      envPassword: 'custom',
      envAdmin: { password_hash: hashPassword('custom-pass') },
      proxyCount: 1,
      vmWithTokenCount: 1,
      schedulableCount: 1,
      activeKeyCount: 1,
      hasFirstRequest: true,
    },
  })
  assert.equal(legacy.done_count, 6)
  assert.equal(legacy.needs_welcome, true)
  assert.equal(legacy.guide_used, false)
})

test('PUT complete / dismiss / reset round-trip through settings; invalid action rejected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-onboarding-'))
  const db = await createDatabase({ dataDir: dir })
  const settings = new SettingsRepo(db)
  assert.equal(recordOf(await loadOnboardingState(settings), 'admin').status, 'pending')

  await saveOnboardingState(settings, applyOnboardingAction(await loadOnboardingState(settings), 'admin', 'complete'))
  const completed = recordOf(await loadOnboardingState(settings), 'admin')
  assert.equal(completed.status, 'completed')
  assert.equal(completed.guide_used, true)
  assert.ok(completed.updated_at)
  const afterComplete = buildOnboardingPayload({
    user: 'admin',
    role: 'admin',
    ...completed,
    facts: { envPassword: '123456', envAdmin: null },
  })
  assert.equal(afterComplete.needs_welcome, false)

  await saveOnboardingState(settings, applyOnboardingAction(await loadOnboardingState(settings), 'admin', 'dismiss'))
  assert.equal(recordOf(await loadOnboardingState(settings), 'admin').status, 'dismissed')
  assert.equal(recordOf(await loadOnboardingState(settings), 'admin').guide_used, true)
  const legacy = recordOf({ admin: { status: 'completed', updated_at: '2026-01-01T00:00:00.000Z' } }, 'admin')
  assert.equal(legacy.guide_used, false)
  assert.equal(buildOnboardingPayload({ user: 'admin', role: 'admin', ...legacy }).needs_welcome, true)
  assert.equal(recordOf(await loadOnboardingState(settings), 'bob').status, 'pending')

  await saveOnboardingState(settings, applyOnboardingAction(await loadOnboardingState(settings), 'admin', 'reset'))
  assert.equal(recordOf(await loadOnboardingState(settings), 'admin').status, 'pending')
  assert.equal((await loadOnboardingState(settings)).admin, undefined)

  assert.throws(
    () => applyOnboardingAction({}, 'admin', 'skip'),
    (e) => e.code === 'invalid_action',
  )
  assert.throws(
    () => applyOnboardingAction({}, 'admin', ''),
    (e) => e.code === 'invalid_action',
  )
  assert.throws(
    () => applyOnboardingAction({}, 'admin', undefined),
    (e) => e.code === 'invalid_action',
  )
})

test('only VMs visible to the user drive slot and schedulable steps', () => {
  const vms = [
    { id: 'vm-a', owner_user_id: 'u1', has_token: false, schedulable: true },
    { id: 'vm-b', owner_user_id: 'u2', has_token: true, schedulable: true },
  ]
  const steps = (userId) => payload('user', vmStepFacts(filterVmsForPanel(vms, { role: 'user', userId }))).steps
  assert.equal(steps('u1').find((s) => s.id === 'slot_account').done, false)
  assert.equal(steps('u1').find((s) => s.id === 'schedulable').done, false)
  assert.equal(steps('u2').find((s) => s.id === 'slot_account').done, true)
  assert.equal(steps('u2').find((s) => s.id === 'schedulable').done, true)
})

test('first_request EXISTS uses the same ownerPred as request-log stats', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-onboarding-logs-'))
  const db = await createDatabase({ dbPath: path.join(dir, 'logs.db') })
  await db.exec(`
    INSERT INTO users (id, email, username, password_hash) VALUES ('u1', 'a@x', 'alice', 'x'), ('u2', 'b@x', 'bob', 'x');
    INSERT INTO api_keys (id, name, key, user_id) VALUES ('k1', 'alice-key', 'sk-1', 'u1'), ('k2', 'bob-key', 'sk-2', 'u2');
  `)
  const repo = new UsageLogsRepo(db)
  await repo.insertSummary({
    id: 'log_fail',
    request_id: 'req-fail',
    created_at: '2026-01-01T00:00:00.000Z',
    status: 401,
    user_id: 'u1',
  })
  assert.equal(await repo.hasSuccessfulRequest({ owner_user_id: 'u1' }), false)
  await repo.insertSummary({
    id: 'log_other',
    request_id: 'req-other',
    created_at: '2026-01-01T00:00:01.000Z',
    status: 200,
    user_id: 'u2',
  })
  assert.equal(await repo.hasSuccessfulRequest({ owner_user_id: 'u1' }), false)
  assert.equal(await repo.hasSuccessfulRequest({ owner_user_id: 'u2' }), true)
  await repo.insertSummary({
    id: 'log_ok',
    request_id: 'req-ok',
    created_at: '2026-01-01T00:00:02.000Z',
    status: 200,
    user_id: 'u1',
  })
  assert.equal(await repo.hasSuccessfulRequest({ owner_user_id: 'u1' }), true)
  assert.equal(await repo.hasSuccessfulRequest({}), true)
  await repo.insertSummary({
    id: 'log_redirect',
    request_id: 'req-3xx',
    created_at: '2026-01-01T00:00:03.000Z',
    status: 301,
    user_id: 'u3',
  })
  assert.equal(await repo.hasSuccessfulRequest({ owner_user_id: 'u3' }), false)
})

test('master API key identity is __master__ / admin; base_url strips trailing slash', () => {
  assert.equal(
    onboardingUserOf({ apiKeyKind: 'master', panelUser: 'master', panelRole: 'admin' }),
    MASTER_ONBOARDING_USER,
  )
  assert.equal(onboardingRoleOf({ apiKeyKind: 'master', panelUser: 'master' }), 'admin')
  assert.equal(onboardingUserOf({ panelUser: 'alice', panelRole: 'user' }), 'alice')
  assert.equal(onboardingRoleOf({ panelUser: 'alice', panelRole: 'user' }), 'user')
  assert.equal(panelBaseUrl('https://host/'), 'https://host')
  assert.equal(panelBaseUrl('https://host'), 'https://host')
  assert.equal(panelBaseUrl(null), null)
  assert.equal(payload('admin', {}, { base_url: 'https://host/' }).base_url, 'https://host')
})
