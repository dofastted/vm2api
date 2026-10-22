import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SlotgateClient } from '../../src/lib/transport/slotgate-client.mjs'
import { callGoWorker, streamGoWorker, workerHealth } from '../../src/lib/transport/go-worker-client.mjs'
import { dispatchCallInference } from '../../src/lib/transport/kernel-router.mjs'
import { assistant, fakeSlotgate, syntheticFence } from '../fixtures/fake-slotgate.mjs'

function execFor(config) {
  return {
    vmId: config.vmId,
    slotgate: config,
    vm: { id: config.vmId, claude: {}, runtime: { kernel_socket: '/must-not-fallback.sock' } },
  }
}
function acknowledged(execution) {
  return { bound: true, requestId: execution.requestId, nodeBinding: execution.nodeBinding }
}
function call(config, patch = {}) {
  return callGoWorker({
    exec: execFor(config),
    envelope: { body: {} },
    onExecutionStart: async (value) => acknowledged(value),
    ...patch,
  })
}

test('KSG2 snapshots the original Fence and preserves uint64 generation without rounding', async (t) => {
  const fx = await fakeSlotgate(t)
  fx.config.fence = syntheticFence('18446744073709551615')
  const client = new SlotgateClient(fx.config)
  fx.config.fence.generation = '2'
  fx.config.fence.executor.container_id = 'b'.repeat(64)
  const binding = client.nodeBinding
  assert.equal(binding.fence.generation, '18446744073709551615')
  const handle = await client.prepare('captured-job')
  const status = await client.completion(handle)
  assert.equal(status.fence.generation, '18446744073709551615')
  assert.equal(fx.requests[0].fence.executor.container_id, 'a'.repeat(64))
})

test('KSG2 requires explicit trust, PG readiness and exact immutable identity fields', async (t) => {
  const fx = await fakeSlotgate(t)
  for (const patch of [
    { trusted: false },
    { pgBindingReady: false },
    { fence: { ...syntheticFence(), generation: Number.MAX_SAFE_INTEGER + 1 } },
    { fence: { ...syntheticFence(), generation: '01' } },
    { fence: { ...syntheticFence(), extra: true } },
    { fence: { ...syntheticFence(), executor: { ...syntheticFence().executor, pid: 123 } } },
  ])
    assert.throws(() => new SlotgateClient({ ...fx.config, ...patch }), { code: 'slotgate_capability_invalid' })
  assert.equal(fx.requests.length, 0)
})

test('complete HTTP body remains uncertain until original-ticket node status is durably completed', async (t) => {
  const fx = await fakeSlotgate(t)
  let start
  const result = await call(fx.config, {
    requestId: 'normal-job',
    onExecutionStart: async (value) => {
      start = structuredClone(value)
      assert.equal(fx.requests.length, 0, 'PG binding precedes node prepare and forward')
      return acknowledged(value)
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.execution.ended, true)
  assert.deepEqual(result.execution.nodeBinding, start.nodeBinding)
  assert.equal(result.execution.nodeCompletion.status, 'completed')
  assert.deepEqual(
    fx.requests.map((value) => value.op),
    ['prepare', 'forward', 'command'],
  )
  assert.equal(fx.commands.get('normal-job').envelope.request_id, 'normal-job')
  assert.deepEqual(fx.requests[2].fence, fx.requests[0].fence)
  assert.equal(fx.requests[2].ticket, fx.requests[1].ticket)
})

test('KSG2 forwards the existing kernel internal authentication headers', async (t) => {
  const fx = await fakeSlotgate(t)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ksg2-token-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const tokenFile = path.join(root, 'internal.token')
  fs.writeFileSync(tokenFile, 'synthetic-kernel-internal-token\n', { mode: 0o600 })
  const exec = execFor(fx.config)
  exec.vm.runtime.worker_token_file = tokenFile
  await call(fx.config, { exec, requestId: 'authenticated-job' })
  const headers = fx.commands.get('authenticated-job').headers
  assert.match(headers, /x-kin-internal-token: synthetic-kernel-internal-token\r\n/i)
  assert.match(headers, /x-internal-token: synthetic-kernel-internal-token\r\n/i)
})

for (const mode of ['pending', 'unknown', 'mismatch', 'unavailable']) {
  test(`HTTP success with ${mode} node proof retains execution and does not resend`, async (t) => {
    const fx = await fakeSlotgate(t, {
      status: (command) => {
        if (mode === 'unavailable') return { ok: false, error: 'authority_unavailable' }
        return {
          ok: true,
          command: {
            id: command.command_id,
            fence: mode === 'mismatch' ? syntheticFence('2') : command.fence,
            status: mode === 'pending' || mode === 'unknown' ? mode : 'completed',
            dispatched: true,
          },
        }
      },
    })
    const result = await call(fx.config)
    assert.equal(result.execution.ended, false)
    assert.equal(result.execution.nodeCompletion, undefined)
    assert.equal(fx.requests.filter((value) => value.op === 'forward').length, 1)
  })
}

test('a failed or malformed PG binding acknowledgement sends no node or fallback request', async (t) => {
  const fx = await fakeSlotgate(t)
  const error = new Error('synthetic bind failure')
  await assert.rejects(
    call(fx.config, {
      onExecutionStart: async () => {
        throw error
      },
    }),
    (value) => value === error,
  )
  await assert.rejects(call(fx.config, { onExecutionStart: async () => ({ bound: true }) }), {
    code: 'slotgate_binding_unconfirmed',
  })
  assert.equal(fx.requests.length, 0)
})

test('truncated body never queries a successful completion or releases execution', async (t) => {
  const fx = await fakeSlotgate(t, { truncated: true })
  const result = await call(fx.config)
  assert.equal(result.execution.ended, false)
  assert.equal(result.transportError, true)
  assert.deepEqual(
    fx.requests.map((value) => value.op),
    ['prepare', 'forward'],
  )
})

test('normal SSE requires the same durable node status as JSON', async (t) => {
  const body = `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { ...assistant, content: [], stop_reason: null } })}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`
  const fx = await fakeSlotgate(t, { body, sse: true, status: { ok: false, error: 'authority_unavailable' } })
  const result = await streamGoWorker({
    exec: execFor(fx.config),
    envelope: { body: {} },
    onExecutionStart: async (value) => acknowledged(value),
  })
  assert.equal(result.execution.ended, false)
  assert.deepEqual(
    fx.requests.map((value) => value.op),
    ['prepare', 'forward', 'command'],
  )
})

test('a pending node fsync is awaited using only the original ticket', async (t) => {
  let reads = 0
  const fx = await fakeSlotgate(t, {
    status: (command) => ({
      ok: true,
      command: {
        id: command.command_id,
        fence: command.fence,
        status: ++reads === 1 ? 'pending' : 'completed',
        dispatched: true,
      },
    }),
  })
  const result = await call(fx.config)
  assert.equal(result.execution.ended, true)
  assert.equal(reads, 2)
  assert.equal(fx.requests.filter((value) => value.op === 'forward').length, 1)
  assert.equal(new Set(fx.requests.filter((value) => value.ticket).map((value) => value.ticket)).size, 1)
})

test('certificate mismatch sends no token or job and never opens the legacy UDS', async (t) => {
  const fx = await fakeSlotgate(t)
  fx.config.link.certSha256 = '0'.repeat(64)
  const result = await call(fx.config)
  assert.equal(result.execution.ended, false)
  assert.equal(result.transportError, true)
  assert.equal(fx.requests.length, 0)
})

test('fenced cancellation retains the original execution without an unfenced cancel request', async (t) => {
  const controller = new AbortController()
  const fx = await fakeSlotgate(t, { hold: true, onForward: () => controller.abort() })
  const result = await call(fx.config, { signal: controller.signal })
  assert.equal(result.execution.ended, false)
  assert.equal(result.execution.reason, 'client_aborted')
  assert.deepEqual(
    fx.requests.map((value) => value.op),
    ['prepare', 'forward'],
  )
  const health = await workerHealth(execFor(fx.config))
  assert.equal(health.code, 'slotgate_route_unavailable')
  assert.equal(fx.requests.length, 2)
})

test('router preserves durable PG bind acknowledgement for the fenced worker client', async (t) => {
  const previous = process.env.KIN_KERNEL_BIN
  process.env.KIN_KERNEL_BIN = '/bin/true'
  t.after(() => {
    if (previous == null) delete process.env.KIN_KERNEL_BIN
    else process.env.KIN_KERNEL_BIN = previous
  })
  const fx = await fakeSlotgate(t)
  fx.config.manifest = { revision: '1', digest: 'b'.repeat(64) }
  let completed
  const result = await dispatchCallInference({
    exec: execFor(fx.config),
    envelope: { body: {} },
    onExecutionStart: async (value) => acknowledged(value),
    onExecutionEnd: async (value) => {
      completed = value
    },
  })
  assert.equal(result.execution.ended, true)
  assert.equal(completed.nodeCompletion.status, 'completed')
  assert.equal(fx.requests.filter((value) => value.op === 'forward').length, 1)
})
