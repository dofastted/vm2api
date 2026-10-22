import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyVmPool,
  assertVmScope,
  keyAllowsVm,
  keyScopeFromRecord,
  keyScopeFromRequest,
  normalizeKeyScope,
  vmPoolDenial,
} from '../../src/lib/admin/key-scope.mjs'

const claude = { id: 'vm-01', platform: 'anthropic' }
const codex = { id: 'vm-02', platform: 'openai', family: 'codex' }

test('all is global and ignores a stored VM list', async () => {
  const scope = keyScopeFromRecord({ group_type: 'all', allowed_vms: '["vm-01"]' })
  assert.deepEqual(scope, { group_type: 'all', allowed_vms: [], vm_pool_id: null })
  assert.equal(keyAllowsVm(scope, claude), true)
  assert.equal(keyAllowsVm(scope, codex), true)
  assert.deepEqual(await keyScopeFromRequest({ apiKeyKind: 'master', apiKeyRecord: { group_type: 'openai' } }), {
    group_type: 'all',
    allowed_vms: [],
    vm_pool_id: null,
  })
})

test('anthropic and openai only allow checked VMs of that platform', () => {
  const scope = normalizeKeyScope({ group_type: 'anthropic', allowed_vms: ['vm-01', 'vm-01', ''] })
  assert.deepEqual(scope, { group_type: 'anthropic', allowed_vms: ['vm-01'], vm_pool_id: null })
  assert.equal(keyAllowsVm(scope, claude), true)
  assert.equal(keyAllowsVm(scope, codex), false)
  assert.equal(keyAllowsVm({ group_type: 'openai', allowed_vms: ['vm-02'] }, claude), false)
  assert.equal(keyAllowsVm({ group_type: 'openai', allowed_vms: ['vm-02'] }, codex), true)
})

test('a platform group cannot be saved with zero VMs or the wrong platform', () => {
  assert.throws(() => normalizeKeyScope({ group_type: 'openai', allowed_vms: [] }), /至少勾选一台 VM/)
  assert.throws(() => normalizeKeyScope({ group_type: 'nope' }), /group_type/)
  assert.throws(() => assertVmScope([claude], { group_type: 'anthropic', allowed_vms: ['missing'] }), /不存在/)
  assert.throws(() => assertVmScope([codex], { group_type: 'anthropic', allowed_vms: ['vm-02'] }), /不属于该分组/)
  assert.deepEqual(assertVmScope([claude, codex], { group_type: 'openai', allowed_vms: ['vm-02'] }), ['vm-02'])
})

test('a status-only patch does not widen or clear an existing scope', () => {
  const current = { group_type: 'anthropic', allowed_vms: '["vm-01"]' }
  assert.equal(normalizeKeyScope({ status: 'disabled' }, { partial: true, current }), null)
  assert.deepEqual(normalizeKeyScope({ group_type: 'all' }, { partial: true, current }), {
    group_type: 'all',
    allowed_vms: [],
    vm_pool_id: null,
  })
})

test('a named pool is the only schedule set and a dead pool does not widen', async () => {
  const bound = normalizeKeyScope({ vm_pool_id: 'pool_abcd1234', group_type: 'all' })
  assert.deepEqual(bound, { group_type: 'all', allowed_vms: [], vm_pool_id: 'pool_abcd1234' })
  const live = await applyVmPool(bound, () => ({ id: 'pool_abcd1234', enabled: true, vm_ids: ['vm-02'] }))
  assert.equal(keyAllowsVm(live, codex), true)
  assert.equal(keyAllowsVm(live, claude), false)
  const moved = await applyVmPool(bound, () => ({ id: 'pool_abcd1234', enabled: true, vm_ids: ['vm-01'] }))
  assert.equal(keyAllowsVm(moved, codex), false)
  assert.equal(keyAllowsVm(moved, claude), true)
  for (const vm_pool_error of ['missing', 'disabled', 'empty']) {
    const dead = await applyVmPool(bound, () =>
      vm_pool_error === 'missing' ? null : { enabled: vm_pool_error !== 'disabled', vm_ids: [] },
    )
    assert.equal(dead.vm_pool_error, vm_pool_error)
    assert.equal(keyAllowsVm(dead, claude), false)
    assert.equal(keyAllowsVm(dead, codex), false)
    assert.equal(vmPoolDenial(dead).code, 'vm_pool_unavailable')
  }
  const replaced = normalizeKeyScope(
    { group_type: 'anthropic', allowed_vms: ['vm-01'] },
    { partial: true, current: { group_type: 'all', vm_pool_id: 'pool_abcd1234' } },
  )
  assert.equal(replaced.vm_pool_id, null)
  assert.deepEqual(replaced.allowed_vms, ['vm-01'])
})
