import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PLATFORM_SCOPE,
  VM_ORIGIN,
  assignOriginForOwner,
  canBindProxyToVm,
  clampVmCreateQuota,
  countUserCreatedVms,
  filterVmsForPanel,
  ownerScopeFromApiKey,
  ownerScopeFromRequest,
  vmMatchesOwnerScope,
} from '../../src/lib/admin/resource-owner.mjs'

test('panel sessions without a key record follow the session role', () => {
  const tenant = ownerScopeFromRequest({ panelUser: 'alice', panelRole: 'user', panelUserId: 'u1' })
  assert.deepEqual(tenant, { type: 'user', userId: 'u1' })
  assert.equal(vmMatchesOwnerScope({}, tenant), false)
  const orphan = ownerScopeFromRequest({ panelUser: 'ghost', panelRole: 'user', panelUserId: null })
  assert.equal(vmMatchesOwnerScope({}, orphan), false)
  assert.equal(vmMatchesOwnerScope({ owner_user_id: 'u1' }, orphan), false)
  assert.deepEqual(ownerScopeFromRequest({ panelUser: 'root', panelRole: 'admin', panelUserId: 'a1' }), PLATFORM_SCOPE)
  assert.deepEqual(ownerScopeFromRequest({ panelUser: 'ops', panelRole: 'super', panelUserId: 's1' }), PLATFORM_SCOPE)
  assert.deepEqual(
    ownerScopeFromRequest({ panelUser: 'master', panelRole: 'admin', apiKeyKind: 'master' }),
    PLATFORM_SCOPE,
  )
})

test('managed keys resolve the owner role through the users repo', () => {
  const users = { getById: (id) => ({ a1: { role: 'admin' }, u1: { role: 'user' } })[id] || null }
  const req = (userId) => ({ apiKeyKind: 'managed', apiKeyRecord: { user_id: userId } })
  assert.deepEqual(ownerScopeFromRequest(req('a1'), users), PLATFORM_SCOPE)
  assert.deepEqual(ownerScopeFromRequest(req('u1'), users), { type: 'user', userId: 'u1' })
})

test('admin and master keys stay on the platform pool', () => {
  assert.deepEqual(ownerScopeFromApiKey({ user_id: 'admin-1' }, { apiKeyKind: 'master' }), PLATFORM_SCOPE)
  assert.deepEqual(
    ownerScopeFromApiKey({ user_id: 'admin-1' }, { apiKeyKind: 'managed', ownerRole: 'admin' }),
    PLATFORM_SCOPE,
  )
  assert.deepEqual(ownerScopeFromApiKey({ user_id: null }, { apiKeyKind: 'managed' }), PLATFORM_SCOPE)
})

test('user keys only match their VMs', () => {
  const scope = ownerScopeFromApiKey({ user_id: 'u1' }, { ownerRole: 'user' })
  assert.deepEqual(scope, { type: 'user', userId: 'u1' })
  assert.equal(vmMatchesOwnerScope({ owner_user_id: 'u1' }, scope), true)
  assert.equal(vmMatchesOwnerScope({ owner_user_id: 'u2' }, scope), false)
  assert.equal(vmMatchesOwnerScope({}, scope), false)
  assert.equal(vmMatchesOwnerScope({}, PLATFORM_SCOPE), true)
  assert.equal(vmMatchesOwnerScope({ owner_user_id: 'u1' }, PLATFORM_SCOPE), false)
})

test('panel list hides unowned VMs from user', () => {
  const vms = [{ id: 'vm-01' }, { id: 'vm-02', owner_user_id: 'u1' }, { id: 'vm-03', owner_user_id: 'u2' }]
  assert.deepEqual(
    filterVmsForPanel(vms, { role: 'user', userId: 'u1' }).map((v) => v.id),
    ['vm-02'],
  )
  assert.equal(filterVmsForPanel(vms, { role: 'admin', userId: 'u1' }).length, 3)
})

test('quota clamp and self-created count', () => {
  assert.equal(clampVmCreateQuota(-1), 0)
  assert.equal(clampVmCreateQuota(101), 100)
  assert.equal(clampVmCreateQuota('8'), 8)
  const vms = [
    { owner_user_id: 'u1', origin: VM_ORIGIN.userCreated },
    { owner_user_id: 'u1', origin: VM_ORIGIN.adminAssigned },
    { owner_user_id: 'u1' },
  ]
  assert.equal(countUserCreatedVms(vms, 'u1'), 1)
})

test('unassign origin and proxy bind rules', () => {
  assert.equal(assignOriginForOwner(null), VM_ORIGIN.platform)
  assert.equal(assignOriginForOwner('u1'), VM_ORIGIN.adminAssigned)
  assert.equal(assignOriginForOwner('u1', { previousOrigin: VM_ORIGIN.userCreated }), VM_ORIGIN.userCreated)
  assert.equal(canBindProxyToVm({ owner_user_id: 'u1' }, { owner_user_id: 'u1' }, { role: 'user' }), true)
  assert.equal(canBindProxyToVm({ owner_user_id: 'u1' }, {}, { role: 'admin' }), false)
  assert.equal(canBindProxyToVm({}, { owner_user_id: 'u1' }, { role: 'admin' }), true)
})
