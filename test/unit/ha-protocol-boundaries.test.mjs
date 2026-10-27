import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const fixture = fileURLToPath(new URL('../fixtures/ha-protocol-boundaries.mjs', import.meta.url))
for (const kind of [
  'claude',
  'touch',
  'chat',
  'responses',
  'completions',
  'gpt',
  'api',
  'search',
  'images',
  'rewrite-gpt',
]) {
  test(`HA refuses legacy effects and unsupported backend: ${kind}`, () => {
    const env = { ...process.env, VM2API_CONTROL_PLANE_MODE: 'kubernetes-ha', VM2API_HA_PROTOCOL_CASE: kind }
    delete env.NODE_TEST_CONTEXT
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', fixture], {
      env,
      encoding: 'utf8',
      timeout: 15000,
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /# tests 1\b/)
  })
}
