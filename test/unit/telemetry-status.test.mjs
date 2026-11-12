import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RETIRE_LEGACY_TELEMETRY,
  readSlotProcessStatus,
  retireLegacyTelemetry,
} from '../../src/lib/vm/slot-process-status.mjs'

const telemetry = {
  enabled: true,
  state: 'waiting_credentials',
  pending_events: 2,
  last_upload_at: null,
  last_error: null,
}

test('native observation exposes only safe VM telemetry state, never arbitrary health identity', async () => {
  const result = await readSlotProcessStatus({
    projectRoot: '/tmp/private-fixture',
    vm: { id: 'vm-01' },
    health: async () => ({
      engine: 'rust',
      vm_telemetry: true,
      telemetry_ready: true,
      telemetry: { ...telemetry, access_token: 'must-not-leak', account_uuid: 'must-not-leak' },
    }),
  })
  assert.deepEqual(result.telemetry, telemetry)
  assert.ok(!JSON.stringify(result).includes('must-not-leak'))
})
test('unreachable native VM remains unknown rather than claiming upload or disabled', async () => {
  const result = await readSlotProcessStatus({
    projectRoot: '/tmp/private-fixture',
    vm: { id: 'vm-02' },
    health: async () => {
      throw new Error('offline')
    },
  })
  assert.equal(result.telemetry, null)
})
test('retire legacy telemetry execs without root user override', async () => {
  let argv
  const result = await retireLegacyTelemetry({
    vm: { id: 'vm-retire', runtime: { container: 'kin-retire' } },
    inspect: async () => ({ State: { Running: true }, Config: { User: '10001:987' } }),
    run: async (args) => {
      argv = args
      return { code: 0, timed_out: false }
    },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(argv, ['exec', 'kin-retire', 'sh', '-c', RETIRE_LEGACY_TELEMETRY])
})
test('stopped VM publication does not spawn a process to retire telemetry', async () => {
  let ran = false
  const result = await retireLegacyTelemetry({
    vm: { id: 'vm-03', status: 'stopped' },
    run: async () => {
      ran = true
      throw new Error('must not run')
    },
  })
  assert.equal(result.ok, true)
  assert.equal(ran, false)
})
test('malformed public counters and free text error data are not leaked as native status', async () => {
  const result = await readSlotProcessStatus({
    projectRoot: '/tmp/private-fixture',
    vm: { id: 'vm-04' },
    health: async () => ({ telemetry: { ...telemetry, last_error: 'https://private-host/token?secret=foo' } }),
  })
  assert.equal(result.telemetry.last_error, null)
  assert.ok(!JSON.stringify(result).includes('private-host'))
})
