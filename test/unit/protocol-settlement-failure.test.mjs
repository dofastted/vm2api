import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const fixture = fileURLToPath(new URL('../fixtures/protocol-settlement-failure.mjs', import.meta.url))
const setup = fileURLToPath(new URL('../pg-setup.mjs', import.meta.url))

for (const route of ['responses', 'search', 'images']) {
  for (const failure of ['multiplier', 'backend']) {
    test(`${route} preserves pending request quota after an execution-stage ${failure} failure`, () => {
      const env = { ...process.env, VM2API_SETTLEMENT_FAILURE_CASE: `${route}:${failure}` }
      delete env.NODE_TEST_CONTEXT
      const result = spawnSync(
        process.execPath,
        ['--experimental-test-module-mocks', '--import', setup, '--test', fixture],
        {
          env,
          encoding: 'utf8',
          timeout: 15_000,
        },
      )
      assert.equal(result.status, 0, result.stdout + result.stderr)
      assert.match(result.stdout, /# tests 1\b/, 'the isolated fixture must execute its assertion')
    })
  }
}
