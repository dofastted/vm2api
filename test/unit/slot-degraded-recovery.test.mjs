import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { diagnoseSlotServices } from '../../src/lib/vm/slot-recovery.mjs'
import { kernelFaults, rustKernelNeedsRestart } from '../../src/lib/transport/rust-kernel-client.mjs'
import { FailoverRunner, vmTimeoutTracker } from '../../src/lib/pool/failover-runner.mjs'

const SOCKS = { id: 'px-a', host: '203.0.113.7', port: 1080, url: 'socks5://u:p@203.0.113.7:1080' }

function project(vms) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-recovery-test-'))
  fs.mkdirSync(path.join(root, 'vms'))
  for (const vm of vms) fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  return root
}

function healthyProbes(over = {}) {
  return {
    container: async () => ({ exists: true, running: true, status: 'running' }),
    rustHealth: async () => ({ ok: true, healthy: true, ready_slots: 20, closed_slots: 0, cli_pid: 42 }),
    codexHealth: async () => ({ ok: true }),
    localEgress: () => ({ ok: true }),
    socksEgress: () => ({ ok: true }),
    remoteEgress: async () => ({ exists: true, running: true }),
    cluster: () => null,
    ...over,
  }
}

test('rustKernelNeedsRestart: restarts when all slots are closed (ready_slots=0 and closed_slots>0)', () => {
  assert.equal(
    rustKernelNeedsRestart({ ok: true, healthy: true, ready_slots: 0, closed_slots: 20, cli_pid: 100 }),
    true,
    'all slots closed must trigger restart',
  )
  assert.equal(
    rustKernelNeedsRestart({ ok: true, healthy: true, ready_slots: 19, closed_slots: 1, cli_pid: 100 }),
    false,
    'partial closed slots with remaining ready slots does not restart container directly',
  )
  assert.equal(
    rustKernelNeedsRestart({ ok: true, healthy: false, ready_slots: 19, closed_slots: 1, cli_pid: 100 }),
    true,
    'healthy=false always restarts',
  )
})

test('diagnosis: reports warn (kernel_degraded) when some slots are closed', async () => {
  const vm = { id: 'vm-deg', status: 'running', claude: { has_access: true, has_refresh: true }, proxy: SOCKS }
  const root = project([vm])
  try {
    const d = await diagnoseSlotServices(vm, {
      projectRoot: root,
      probes: healthyProbes({
        rustHealth: async () => ({
          ok: true,
          healthy: true,
          ready_slots: 19,
          closed_slots: 1,
          cli_pid: 42,
        }),
      }),
    })
    const kernelCheck = d.checks.find((c) => c.id === 'kernel')
    assert.equal(kernelCheck.status, 'warn')
    assert.equal(kernelCheck.code, 'kernel_degraded')
    assert.match(kernelCheck.message, /1 个异常闭合槽位/)
    assert.equal(d.ok, true, 'warn alone does not fail the overall check')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('diagnosis: reports error (kernel_slots_closed) when all slots are closed', async () => {
  const vm = { id: 'vm-closed', status: 'running', claude: { has_access: true, has_refresh: true }, proxy: SOCKS }
  const root = project([vm])
  try {
    const d = await diagnoseSlotServices(vm, {
      projectRoot: root,
      probes: healthyProbes({
        rustHealth: async () => ({
          ok: true,
          healthy: true,
          ready_slots: 0,
          closed_slots: 20,
          cli_pid: 42,
        }),
      }),
    })
    const kernelCheck = d.checks.find((c) => c.id === 'kernel')
    assert.equal(kernelCheck.status, 'error')
    assert.equal(kernelCheck.code, 'kernel_slots_closed')
    assert.match(kernelCheck.message, /所有会话槽均已闭合/)
    assert.equal(d.ok, false)
    assert.equal(d.first_failure, 'kernel')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('vmTimeoutTracker and FailoverRunner: 3 consecutive silent timeouts mark kernel fault', () => {
  const vmId = 'vm-stall-test'
  kernelFaults.delete(vmId)
  vmTimeoutTracker.reset(vmId)

  const runner = new FailoverRunner({
    scheduler: { unitCircuit: { recordFailure() {}, recordSuccess() {}, releaseProbe() {} } },
  })

  const selected = { vmId, accountId: 'acc-1' }
  const timeoutResult = {
    ok: false,
    status: 504,
    upstream_status: 504,
    error: { message: 'job idle timeout: no CLI frame for 180s' },
    ttft_ms: null,
  }
  const policy = { reason: 'provider_timeout' }

  // Attempt 1: timeout
  runner.noteUnitHealth(selected, policy, timeoutResult)
  assert.equal(kernelFaults.has(vmId), false)

  // Attempt 2: timeout
  runner.noteUnitHealth(selected, policy, timeoutResult)
  assert.equal(kernelFaults.has(vmId), false)

  // Attempt 3: timeout -> trips circuit, marks kernel fault
  runner.noteUnitHealth(selected, policy, timeoutResult)
  assert.equal(kernelFaults.has(vmId), true)
  assert.match(kernelFaults.get(vmId), /consecutive_timeouts/)

  // Success on VM resets the tracker and allows recovery
  vmTimeoutTracker.reset(vmId)
  kernelFaults.delete(vmId)
})

test('vmTimeoutTracker: success resets consecutive timeout counter', () => {
  const vmId = 'vm-success-reset'
  vmTimeoutTracker.reset(vmId)
  kernelFaults.delete(vmId)

  const runner = new FailoverRunner({
    scheduler: { unitCircuit: { recordFailure() {}, recordSuccess() {}, releaseProbe() {} } },
  })
  const selected = { vmId, accountId: 'acc-1' }
  const timeoutResult = {
    ok: false,
    status: 504,
    upstream_status: 504,
    error: { message: 'job idle timeout' },
    ttft_ms: null,
  }
  const policy = { reason: 'provider_timeout' }

  // 2 timeouts
  runner.noteUnitHealth(selected, policy, timeoutResult)
  runner.noteUnitHealth(selected, policy, timeoutResult)
  assert.equal(vmTimeoutTracker.counts.get(vmId)?.count, 2)

  // 1 success
  const successResult = {
    ok: true,
    terminalState: 'verified',
    sawMessageStop: true,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'hello' }],
  }
  runner.noteUnitHealth(selected, {}, successResult)
  assert.equal(vmTimeoutTracker.counts.has(vmId), false)
  assert.equal(kernelFaults.has(vmId), false)
})
