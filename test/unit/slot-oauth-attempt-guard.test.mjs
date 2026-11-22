import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyCredentialRefresh, refreshErrorCodeOf } from '../../src/lib/oauth/oauth-credentials.mjs'
import { needsScheduledRefresh } from '../../src/lib/oauth/credential-refresh-monitor.mjs'
import { runSlotOauth } from '../../src/lib/transport/slot-oauth.mjs'

const exec = { vmId: 'vm-07', vm: {} }
const ok = '{"ok":true,"status":200,"body":{"refreshed":true},"headers":{}}'
const invalidArguments =
  '{"ok":false,"status":0,"body":{"error":{"code":"invalid_arguments","message":"invalid oauth arguments"}},"headers":{}}'

test('refresh asks the worker for its attempt journal', async () => {
  const calls = []
  const result = await runSlotOauth(exec, 'refresh', {
    runDocker: async (argv) => {
      calls.push(argv)
      return { code: 0, stdout: ok, stderr: '', timed_out: false }
    },
  })
  assert.equal(calls.length, 1)
  assert.ok(calls[0].includes('--attempt-guard'))
  assert.equal(result.ok, true)
  assert.equal(result.attempt_guard, true)
})

test('an older worker refuses the flag before touching the token, and is asked once more without it', async () => {
  const calls = []
  const result = await runSlotOauth(exec, 'refresh', {
    runDocker: async (argv) => {
      calls.push(argv)
      return { code: 2, stdout: argv.includes('--attempt-guard') ? invalidArguments : ok, stderr: '', timed_out: false }
    },
  })
  assert.equal(calls.length, 2)
  assert.ok(!calls[1].includes('--attempt-guard'))
  assert.equal(result.ok, true)
  assert.equal(result.attempt_guard, false)
})

test('non-refresh operations do not carry the refresh flag', async () => {
  const calls = []
  await runSlotOauth(exec, 'usage', {
    runDocker: async (argv) => {
      calls.push(argv)
      return { code: 0, stdout: ok, stderr: '', timed_out: false }
    },
  })
  assert.ok(!calls[0].includes('--attempt-guard'))
})

test('an attempt that started but never reported back is telemetry-recorded as unknown, not a rejection', async () => {
  const events = []
  const start = JSON.stringify({
    type: 'oauth_attempt',
    attempt_id: '0f8b1f2e-1d2c-4b3a-9e8f-7a6b5c4d3e2f',
    phase: 'start',
  })
  await runSlotOauth(exec, 'refresh', {
    postTelemetry: async (_exec, event) => {
      events.push(event)
      return { ok: true }
    },
    runDocker: async (_argv, { onStdoutLine }) => {
      onStdoutLine(start)
      return { code: null, stdout: `${start}\n`, stderr: '', timed_out: true }
    },
  })
  assert.equal(events.at(-1).phase, 'failure')
  assert.equal(events.at(-1).error_code, 'refresh_outcome_unknown')
})

test('transport failures are safe to retry only behind the attempt journal', () => {
  for (const code of ['worker_output_invalid', 'worker_exec_failed', 'worker_timeout', 'credential_pull_failed']) {
    assert.equal(classifyCredentialRefresh({ ok: false, error: { code }, attempt_guard: true }), 'retryable', code)
    const unguarded = { ok: false, error: { code }, attempt_guard: false }
    assert.equal(classifyCredentialRefresh(unguarded), 'failed', code)
    assert.equal(refreshErrorCodeOf(unguarded), 'worker_upgrade_required', code)
  }
})

test('an unknown refresh outcome is parked for re-authorization, never retried and never called invalid_grant', () => {
  const result = {
    ok: false,
    error: {
      code: 'refresh_outcome_unknown',
      message: 'an earlier OAuth refresh has no recorded result; re-authorize the slot',
    },
    attempt_guard: true,
  }
  assert.equal(classifyCredentialRefresh(result), 'failed')
  assert.equal(refreshErrorCodeOf(result), 'refresh_outcome_unknown')
  const expired = { expires_at: Date.now() - 60_000 }
  assert.equal(needsScheduledRefresh({ ...expired, claude: { refresh_error: 'refresh_outcome_unknown' } }), false)
  assert.equal(needsScheduledRefresh({ ...expired, claude: { refresh_error: 'worker_upgrade_required' } }), false)
  // History left by the old release: retried once the guarded worker is in place.
  assert.equal(needsScheduledRefresh({ ...expired, claude: { refresh_error: 'worker_output_invalid' } }), true)
  assert.equal(needsScheduledRefresh({ ...expired, claude: { refresh_error: 'invalid_grant' } }), false)
})

test('guard probe asks the node worker, never refreshes, and only an explicit yes counts', async () => {
  const { probeAttemptGuard } = await import('../../src/lib/transport/slot-oauth.mjs')
  const seen = []
  const answer =
    (stdout, extra = {}) =>
    async (argv) => {
      seen.push(argv)
      return { code: 0, stdout, stderr: '', timed_out: false, ...extra }
    }
  const yes = '{"ok":true,"status":200,"body":{"attempt_guard":true},"headers":{}}'
  assert.equal(await probeAttemptGuard(exec, { runDocker: answer(yes) }), true)
  assert.ok(seen[0].includes('guard-probe'))
  assert.ok(!seen[0].includes('refresh') && !seen[0].includes('--force'))
  // A worker without the journal does not know the operation.
  assert.equal(await probeAttemptGuard(exec, { runDocker: answer(invalidArguments) }), false)
  // Anything other than a clear yes leaves the slot parked.
  assert.equal(
    await probeAttemptGuard(exec, { runDocker: answer('{"ok":true,"status":200,"body":{},"headers":{}}') }),
    false,
  )
  assert.equal(await probeAttemptGuard(exec, { runDocker: answer('', { code: null, timed_out: true }) }), false)
  assert.equal(await probeAttemptGuard(exec, { runDocker: answer('not json') }), false)
  assert.equal(
    await probeAttemptGuard(exec, {
      runDocker: async () => {
        throw new Error('docker gone')
      },
    }),
    false,
  )
})
