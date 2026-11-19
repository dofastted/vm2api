import test from 'node:test'
import assert from 'node:assert/strict'
import { retireLegacyTelemetryChecked } from '../../src/lib/transport/rust-kernel-supervisor.mjs'

// The pre-start retire gates every kernel boot; a cluster-link flap during the
// exec must not turn into kernel_start_failed.
const ARGV = ['exec', 'kin-x', 'sh', '-c', 'true']

test('script exit code is honored as a deterministic failure', async () => {
  const result = await retireLegacyTelemetryChecked(ARGV, async () => ({ ok: false, code: 1, error: '' }))
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'legacy_telemetry_stop_failed')
})

test('transport failure retries once and then fails open', async () => {
  let calls = 0
  const result = await retireLegacyTelemetryChecked(ARGV, async () => {
    calls += 1
    return { ok: false, error: 'ssh_link_error' }
  })
  assert.equal(calls, 2)
  assert.equal(result.ok, true)
  assert.equal(result.unverified, true)
  assert.equal(result.reason, 'legacy_telemetry_unverified')
})

test('transport failure that recovers on retry reports success without unverified', async () => {
  let calls = 0
  const result = await retireLegacyTelemetryChecked(ARGV, async () => {
    calls += 1
    return calls === 1 ? { ok: false, error: 'docker exec timeout after 5000ms' } : { ok: true, code: 0 }
  })
  assert.equal(calls, 2)
  assert.equal(result.ok, true)
  assert.ok(!result.unverified)
})

test('a thrown exec error is treated as transport, not a script verdict', async () => {
  const result = await retireLegacyTelemetryChecked(ARGV, async () => {
    throw new Error('connection reset by peer')
  })
  assert.equal(result.ok, true)
  assert.equal(result.unverified, true)
})
