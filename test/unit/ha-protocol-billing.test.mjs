import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const fixture = fileURLToPath(new URL('../fixtures/ha-protocol-billing.mjs', import.meta.url))
for (const kind of [
  'complete',
  'no-usage',
  'deleted-key',
  'not-started',
  'not-started-with-id',
  'cancelled-before-dispatch',
]) {
  test(`HA protocol original command billing: ${kind}`, () => {
    const env = { ...process.env, VM2API_CONTROL_PLANE_MODE: 'standalone', VM2API_HA_BILLING_CASE: kind }
    delete env.NODE_TEST_CONTEXT
    const result = spawnSync(
      process.execPath,
      ['--experimental-test-module-mocks', '--import', './test/pg-setup.mjs', '--test', fixture],
      { env, encoding: 'utf8', timeout: 15000 },
    )
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /# tests 1\b/)
  })
}
