import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RETIRE_LEGACY_TELEMETRY,
  RETIRE_RAN_MARKER,
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

// Transport jitter (node-link flap, exec timeout) must not be reported as
// "legacy telemetry process did not stop": only a numeric exit code is the
// script's own verdict.
test('retire legacy telemetry fails only on a deterministic script verdict', async () => {
  const base = {
    vm: { id: 'vm-retire-x', runtime: { container: 'kin-retire-x' } },
    inspect: async () => ({ State: { Running: true }, Config: { User: '10001:987' } }),
  }
  const deterministic = await retireLegacyTelemetry({
    ...base,
    run: async () => ({ code: 1, timed_out: false, stdout: `${RETIRE_RAN_MARKER}\n` }),
  })
  assert.equal(deterministic.ok, false)
  assert.equal(deterministic.code, 'legacy_telemetry_stop_failed')

  // docker CLI's own transport error: exit 1 but the script never printed its marker.
  let cliCalls = 0
  const cliTransport = await retireLegacyTelemetry({
    ...base,
    run: async () => {
      cliCalls += 1
      return { code: 1, timed_out: false, stdout: '', stderr: 'error during connect: EOF' }
    },
  })
  assert.equal(cliCalls, 2)
  assert.equal(cliTransport.ok, true)
  assert.equal(cliTransport.unverified, true)

  const recovered = await retireLegacyTelemetry({
    ...base,
    run: async () => ({ code: 0, timed_out: false }),
  })
  assert.equal(recovered.ok, true)
})

test('retire legacy telemetry retries transport failures and reports unverified, not failed', async () => {
  const base = {
    vm: { id: 'vm-retire-t', runtime: { container: 'kin-retire-t' } },
    inspect: async () => ({ State: { Running: true }, Config: { User: '10001:987' } }),
  }
  let calls = 0
  const flappy = await retireLegacyTelemetry({
    ...base,
    run: async () => {
      calls += 1
      return { code: null, timed_out: true, error: 'docker exec timeout after 5000ms' }
    },
  })
  assert.equal(calls, 2, 'transport failure is retried once')
  assert.equal(flappy.ok, true)
  assert.equal(flappy.unverified, true)
  assert.equal(flappy.code, 'legacy_telemetry_unverified')

  let secondCalls = 0
  const recoveredOnRetry = await retireLegacyTelemetry({
    ...base,
    run: async () => {
      secondCalls += 1
      return secondCalls === 1 ? { code: null, timed_out: true } : { code: 0, timed_out: false }
    },
  })
  assert.equal(secondCalls, 2)
  assert.equal(recoveredOnRetry.ok, true)
  assert.ok(!recoveredOnRetry.unverified)
})

test('retireLegacyTelemetry flags cluster Docker containers missing /etc/kin-computer or /etc/kin-dmi mounts', async () => {
  const clusterVm = {
    id: 'vm-cluster-legacy',
    node_id: 'node-a',
    runtime: { type: 'docker', container: 'kin-cluster' },
  }
  const legacy = await retireLegacyTelemetry({
    vm: clusterVm,
    inspect: async () => ({ State: { Running: true }, HostConfig: { Binds: [] }, Mounts: [] }),
    run: async () => ({ code: 0, timed_out: false }),
  })
  assert.equal(legacy.ok, true)
  assert.equal(legacy.running, true)
  assert.equal(legacy.needsRecreate, true)

  const current = await retireLegacyTelemetry({
    vm: clusterVm,
    inspect: async () => ({
      State: { Running: true },
      HostConfig: {
        Binds: [
          '/srv/vms/vm-cluster-legacy/fingerprint:/var/lib/kin-persona:ro',
          '/srv/vms/vm-cluster-legacy/fingerprint/system/etc/hostname:/etc/hostname:ro',
          '/srv/vms/vm-cluster-legacy/fingerprint/system/etc/kin-computer:/etc/kin-computer:ro',
          '/srv/vms/vm-cluster-legacy/fingerprint/system/dmi/id:/etc/kin-dmi:ro',
          '/srv/vms/vm-cluster-legacy/fingerprint/system/hardware:/etc/kin-hardware:ro',
        ],
      },
    }),
    run: async () => ({ code: 0, timed_out: false }),
  })
  assert.equal(current.ok, true)
  assert.equal(current.needsRecreate, undefined)
})
