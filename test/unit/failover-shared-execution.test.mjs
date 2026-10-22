import test from 'node:test'
import assert from 'node:assert/strict'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'

function fixture() {
  const events = []
  const selected = {
    ok: true,
    accountId: 'shared-account',
    vmId: 'shared-vm',
    bindExecution: async () => {},
    markUncertain: async () => {
      events.push('uncertain')
    },
    release: async () => {
      events.push('release')
    },
  }
  const runner = new FailoverRunner({
    scheduler: {
      async selectAndReserve() {
        const another = events.includes('select')
        events.push('select')
        if (another) return { ok: false, reason: 'no_eligible_accounts' }
        return selected
      },
      markSuccess() {},
      markCooldown() {},
    },
    config: { max_same_account_retries: 0, max_account_switches: 2, max_total_attempts: 2 },
  })
  return { runner, events }
}

function args(callAttempt, extra = {}) {
  return {
    requestId: 'shared-execution',
    model: 'claude-sonnet-4-6',
    canonicalBody: { model: 'claude-sonnet-4-6', messages: [] },
    callAttempt,
    ...extra,
  }
}

for (const execution of [undefined, { requestId: 'job-1', started: true, ended: false, reason: 'transport_error' }]) {
  test(`shared execution with ${execution ? 'an unfinished job' : 'missing termination metadata'} does not fail over`, async () => {
    const { runner, events } = fixture()
    const result = await runner.run(
      args(async () => {
        events.push('call')
        return { ok: false, status: 0, transportError: true, terminalState: 'transport_error', execution }
      }),
    )
    assert.equal(result.ok, false)
    assert.equal(result.executionUncertain, true)
    assert.deepEqual(events, ['select', 'call', 'uncertain', 'release'])
  })
}

test('an exception after entering a shared execution retains capacity and stops retries', async () => {
  const { runner, events } = fixture()
  const result = await runner.run(
    args(async () => {
      events.push('call')
      throw new Error('connection interrupted')
    }),
  )
  assert.equal(result.ok, false)
  assert.equal(result.executionUncertain, true)
  assert.deepEqual(events, ['select', 'call', 'uncertain', 'release'])
})

test('request preparation failure releases a shared reservation without marking execution uncertain', async () => {
  const { runner, events } = fixture()
  const result = await runner.run(
    args(() => assert.fail('preparation must precede submission'), {
      applyAttempt: async () => {
        throw Object.assign(new Error('invalid cache control'), {
          status: 400,
          body: { error: { code: 'invalid_cache_control' } },
        })
      },
    }),
  )
  assert.equal(result.status, 400)
  assert.deepEqual(events, ['select', 'release'])
})

test('a proven terminal shared execution releases capacity normally', async () => {
  const { runner, events } = fixture()
  const result = await runner.run(
    args(async () => ({
      ok: true,
      status: 200,
      terminalState: 'verified',
      execution: { requestId: 'job-1', started: true, ended: true, reason: 'eof' },
      body: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
      },
    })),
  )
  assert.equal(result.ok, true)
  assert.deepEqual(events, ['select', 'release'])
})
