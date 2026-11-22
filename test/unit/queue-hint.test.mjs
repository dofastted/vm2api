import test from 'node:test'
import assert from 'node:assert/strict'
import { queueAllowedByHeaders } from '../../src/lib/protocol/queue-hint.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'

test('x-kin-queue: off and its synonyms turn the seat queue off; anything else keeps it', () => {
  for (const value of ['off', 'OFF', ' off ', 'none', 'no', 'false', '0', ['off']]) {
    assert.equal(queueAllowedByHeaders({ 'x-kin-queue': value }), false, `value ${JSON.stringify(value)}`)
  }
  for (const value of [undefined, null, '', 'on', 'wait', '1', 'true']) {
    assert.equal(queueAllowedByHeaders({ 'x-kin-queue': value }), true, `value ${JSON.stringify(value)}`)
  }
  assert.equal(queueAllowedByHeaders({}), true)
  assert.equal(queueAllowedByHeaders(undefined), true)
})

/** Busy pool: a seat is granted only to a caller willing to wait for it. */
class BusyScheduler {
  calls = []
  async selectAndReserve({ allowWait = true } = {}) {
    this.calls.push(allowWait)
    if (!allowWait) return { ok: false, reason: 'all_accounts_busy', eligible: 1, available: 0 }
    return { ok: true, vmId: 'vm-01', accountId: 'account-1', selectionReason: 'balanced', waitMs: 0, release() {} }
  }
  markCooldown() {}
  markSuccess() {}
  releaseAccountSessions() {}
}

function ok() {
  return {
    ok: true,
    status: 200,
    terminalState: 'verified',
    body: {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }
}

for (const stickyKey of [null, 'session-a']) {
  test(`allowQueue:false fails a busy pool at once with 529 and never dispatches (stickyKey=${stickyKey})`, async () => {
    const scheduler = new BusyScheduler()
    const runner = new FailoverRunner({ scheduler })
    let dispatched = 0
    const result = await runner.run({
      requestId: 'no-queue',
      model: 'claude-sonnet-test',
      canonicalBody: { model: 'claude-sonnet-test' },
      stickyKey,
      allowQueue: false,
      callAttempt: () => {
        dispatched++
        return ok()
      },
    })
    assert.equal(dispatched, 0)
    assert.deepEqual(scheduler.calls, [false])
    assert.equal(result.ok, false)
    assert.equal(result.status, 529)
    assert.equal(result.body.error.code, 'pool_overloaded')
    assert.equal(result.body.error.details.reason, 'all_accounts_busy')
  })
}

test('without allowQueue the runner still waits for a seat (default unchanged)', async () => {
  const scheduler = new BusyScheduler()
  const runner = new FailoverRunner({ scheduler })
  const result = await runner.run({
    requestId: 'queue-default',
    model: 'claude-sonnet-test',
    canonicalBody: { model: 'claude-sonnet-test' },
    callAttempt: () => ok(),
  })
  assert.deepEqual(scheduler.calls, [true])
  assert.equal(result.ok, true)
})
