import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
const run = (scenario) => {
  const env = { ...process.env, VM2API_CONTROL_PLANE_MODE: 'standalone' }
  delete env.NODE_TEST_CONTEXT
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--experimental-test-module-mocks',
        new URL('../fixtures/ha-credential-refresh-producers.mjs', import.meta.url).pathname,
        scenario,
      ],
      { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  )
}
test('HA retry recovery uses typed refresh with no homeDir and no Pod credential comparison', () => {
  const r = run('runner-success')
  assert.equal(r.ensureCalls, 1)
  assert.equal(r.podReads, 0)
  assert.equal(r.result.retrySameAccount, true)
  assert.equal(r.result.action, 'continue')
})
test('HA retry recovery preserves unknown and handles only an explicit known refusal', () => {
  const unknown = run('runner-unknown')
  assert.equal(unknown.marked, 1)
  assert.equal(unknown.error.executionUncertain, true)
  const refused = run('runner-refused')
  assert.equal(refused.marked, 0)
  assert.equal(refused.result.reason, 'oauth_refresh_not_started')
  assert.equal(refused.result.action, 'stop')
})
test('server HA refresh captures authoritative PG metadata and avoids all file writers', () => {
  const r = run('server-success')
  assert.equal(r.error, undefined)
  assert.equal(r.captures, 1)
  assert.equal(r.ensureCalls, 1)
  assert.equal(r.legacy, 0)
  assert.equal(r.result.ok, true)
  assert.equal(r.result.taskTerminal, true)
})
test('server HA refresh retains typed uncertainty for the background task wrapper', () => {
  const r = run('server-unknown')
  assert.equal(r.captures, 1)
  assert.equal(r.legacy, 0)
  assert.equal(r.result.credentialRefreshUnknown, true)
  assert.notEqual(r.result.taskTerminal, true)
})
