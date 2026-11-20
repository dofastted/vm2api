import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildVmList, buildVmDetail } from '../../src/lib/admin/panel-api.mjs'
import { kernelFaults } from '../../src/lib/transport/rust-kernel-client.mjs'

function seed(root, id, extra = {}) {
  const dir = path.join(root, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({ id, name: id, status: 'running', schedulable: true, ...extra }),
  )
}

function accountQuotaStub() {
  return { config: {}, snapshot: () => ({ accounts: [] }) }
}

// #981: a kernel fault lives only in memory (kernelFaults Map). The scheduler
// skips the slot, but the panel list used to read only persisted fields, so a
// slot whose recovery budget was spent still showed 开 · 可用.
test('a kernel-faulted slot is restricted with 内核故障 on the VM list and detail', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kfault-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  seed(root, 'vm-01', { claude: { has_access: true, account_uuid: 'acc-01' } })
  seed(root, 'vm-02', { claude: { has_access: true, account_uuid: 'acc-02' } })
  kernelFaults.set('vm-01', 'kernel unhealthy after 3 recovery attempts: native cli stdout closed')
  try {
    const listed = await buildVmList({
      cfg: { paths: { project: root } },
      accountQuota: accountQuotaStub(),
      routingConfig: {},
    })
    const byId = Object.fromEntries(listed.data.items.map((vm) => [vm.id, vm]))
    assert.equal(byId['vm-01'].schedule_state, 'restricted')
    assert.equal(byId['vm-01'].restriction_reason, 'kernel_faulted')
    assert.equal(byId['vm-01'].restriction_text, '内核故障')
    // The healthy sibling stays untouched.
    assert.notEqual(byId['vm-02'].schedule_state, 'restricted')

    const detail = await buildVmDetail({
      cfg: { paths: { project: root } },
      accountQuota: accountQuotaStub(),
      routingConfig: {},
      id: 'vm-01',
    })
    assert.equal(detail.data.vm.schedule_state, 'restricted')
    assert.equal(detail.data.vm.restriction_reason, 'kernel_faulted')
    assert.equal(detail.data.vm.restriction_text, '内核故障')
  } finally {
    kernelFaults.delete('vm-01')
  }
})

// The fault is transient by design: watchdog recovery clears the map entry and
// the slot repaints to on without any operator action.
test('a cleared kernel fault restores the slot to 开', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kfault-clear-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  seed(root, 'vm-01', { claude: { has_access: true, account_uuid: 'acc-01' } })
  kernelFaults.set('vm-01', 'kernel unhealthy after 3 recovery attempts')
  let listed
  try {
    listed = await buildVmList({
      cfg: { paths: { project: root } },
      accountQuota: accountQuotaStub(),
      routingConfig: {},
    })
  } finally {
    kernelFaults.delete('vm-01')
  }
  const before = Object.fromEntries(listed.data.items.map((vm) => [vm.id, vm]))
  assert.equal(before['vm-01'].restriction_reason, 'kernel_faulted')
  kernelFaults.delete('vm-01')
  const relisted = await buildVmList({
    cfg: { paths: { project: root } },
    accountQuota: accountQuotaStub(),
    routingConfig: {},
  })
  const after = Object.fromEntries(relisted.data.items.map((vm) => [vm.id, vm]))
  assert.equal(after['vm-01'].schedule_state, 'on')
  assert.equal(after['vm-01'].restriction_reason, null)
})

// Stronger verdicts keep their own reason: the fault must not repaint a
// revoked grant as a recoverable kernel issue.
test('a revoked slot stays 不可调度 · 凭证吊销 even with a live kernel fault', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kfault-revoke-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  seed(root, 'vm-01', {
    claude: { has_access: true, account_uuid: 'acc-01' },
    unschedulable: { reason: 'oauth_revoked', detail: null, at: new Date().toISOString() },
  })
  kernelFaults.set('vm-01', 'kernel unhealthy after 3 recovery attempts')
  try {
    const listed = await buildVmList({
      cfg: { paths: { project: root } },
      accountQuota: accountQuotaStub(),
      routingConfig: {},
    })
    const byId = Object.fromEntries(listed.data.items.map((vm) => [vm.id, vm]))
    assert.equal(byId['vm-01'].schedule_state, 'unschedulable')
    assert.equal(byId['vm-01'].unschedulable_reason, 'oauth_revoked')
    assert.equal(byId['vm-01'].unschedulable_text, '凭证吊销')
  } finally {
    kernelFaults.delete('vm-01')
  }
})

// An operator-disabled slot keeps its intent; the fault only matters while
// the slot is participating in scheduling.
test('a schedule_off slot does not report the kernel fault as restriction', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kfault-off-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  seed(root, 'vm-01', {
    claude: { has_access: true, account_uuid: 'acc-01' },
    schedule_off: true,
    schedule_off_reason: 'seat-exp-20261118',
  })
  kernelFaults.set('vm-01', 'kernel unhealthy after 3 recovery attempts')
  try {
    const listed = await buildVmList({
      cfg: { paths: { project: root } },
      accountQuota: accountQuotaStub(),
      routingConfig: {},
    })
    const byId = Object.fromEntries(listed.data.items.map((vm) => [vm.id, vm]))
    assert.equal(byId['vm-01'].schedule_state, 'off')
  } finally {
    kernelFaults.delete('vm-01')
  }
})
