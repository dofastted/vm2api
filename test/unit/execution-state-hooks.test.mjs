import test from 'node:test'
import assert from 'node:assert/strict'
import { getDb } from '../../src/lib/db/database.mjs'
import { SharedCodexRuntime } from '../../src/lib/pool/shared-codex-runtime.mjs'

function fixture() {
  const events = []
  const lease = {
    async bindExecution() {
      events.push('bind')
    },
    async completeExecution() {
      events.push('complete')
    },
    async markUncertain() {
      events.push('uncertain')
    },
  }
  return { events, lease, runtime: new SharedCodexRuntime(getDb()) }
}

test('shared Codex execution awaits request observers around durable job registration', async () => {
  const fx = fixture()
  const execution = { requestId: 'observer-job', started: true, ended: true, reason: 'http_body_complete' }
  await fx.runtime.invoke(
    fx.lease,
    async (args) => {
      await args.onExecutionStart({ requestId: execution.requestId })
      fx.events.push('job')
      await args.onExecutionEnd(execution)
      return { execution }
    },
    {
      onExecutionStart: async () => {
        fx.events.push('observer-start')
      },
      onExecutionEnd: async () => {
        fx.events.push('observer-end')
      },
    },
  )
  assert.deepEqual(fx.events, ['observer-start', 'bind', 'job', 'complete', 'observer-end'])
})

test('a request observer rejecting Codex submission prevents the actual job', async () => {
  const fx = fixture()
  const error = new Error('activity already closed')
  let submitted = 0
  await assert.rejects(
    fx.runtime.invoke(
      fx.lease,
      async (args) => {
        await args.onExecutionStart({ requestId: 'observer-rejected' })
        submitted++
        const execution = { requestId: 'observer-rejected', started: true, ended: true }
        await args.onExecutionEnd(execution)
        return { execution }
      },
      {
        onExecutionStart: async () => {
          throw error
        },
      },
    ),
    (actual) => actual === error,
  )
  assert.equal(submitted, 0)
  assert.equal(fx.events.includes('bind'), false)
})
