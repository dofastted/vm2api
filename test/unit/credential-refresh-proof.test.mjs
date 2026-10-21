import test from 'node:test'
import assert from 'node:assert/strict'
import { runSlotOauth } from '../../src/lib/transport/slot-oauth.mjs'
import { refreshCodexAccessToken } from '../../src/lib/protocol/codex-models.mjs'

const exec = { vmId: 'vm-refresh-proof', vm: {} }
const worker =
  (payload, extra = {}) =>
  async () => ({
    code: 0,
    stdout: JSON.stringify(payload),
    stderr: '',
    timed_out: false,
    ...extra,
  })

test('a complete successful worker command proves its credential attempt finished', async () => {
  const result = await runSlotOauth(exec, 'refresh', {
    runDocker: worker({ ok: true, status: 200, body: { refreshed: true } }),
  })
  assert.equal(result.attemptFinished, true)
})

test('worker refresh uncertainty takes priority over a final complete rejection', async () => {
  const result = await runSlotOauth(exec, 'refresh', {
    runDocker: worker({ ok: false, status: 401, refresh_unknown: true, body: { error: { code: 'refresh_failed' } } }),
  })
  assert.equal(result.attemptFinished, false)
})

test('worker timeout, nonzero exit and reported upstream truncation cannot prove completion', async () => {
  for (const [payload, extra] of [
    [{ ok: true, status: 200 }, { timed_out: true }],
    [{ ok: true, status: 200 }, { code: 1 }],
    [{ ok: false, status: 401, body: { error: { code: 'upstream_transport_error' } } }, {}],
  ]) {
    const result = await runSlotOauth(exec, 'refresh', { runDocker: worker(payload, extra) })
    assert.equal(result.attemptFinished, false)
  }
})

test('a complete token rejection proves the refresh attempt finished', async () => {
  const result = await refreshCodexAccessToken({
    refreshToken: 'SYNTHETIC_RT',
    fetchImpl: async () => ({ status: 401, json: async () => ({ error: 'invalid_grant' }) }),
  })
  assert.equal(result.attemptFinished, true)
})

test('a rejected response with a truncated token body is uncertain', async () => {
  const result = await refreshCodexAccessToken({
    refreshToken: 'SYNTHETIC_RT',
    fetchImpl: async () => ({
      status: 401,
      json: async () => {
        throw new Error('synthetic premature close')
      },
    }),
  })
  assert.equal(result.attemptFinished, false)
})

test('a successful token response missing its credential is uncertain', async () => {
  const result = await refreshCodexAccessToken({
    refreshToken: 'SYNTHETIC_RT',
    fetchImpl: async () => ({ status: 200, json: async () => ({}) }),
  })
  assert.equal(result.attemptFinished, false)
})

test('a missing refresh token proves nothing was submitted', async () => {
  const result = await refreshCodexAccessToken({})
  assert.equal(result.attemptFinished, true)
})
