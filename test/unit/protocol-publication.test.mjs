import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const fixture = fileURLToPath(new URL('../fixtures/protocol-publication.mjs', import.meta.url))
const setup = fileURLToPath(new URL('../pg-setup.mjs', import.meta.url))
for (const kind of ['sync', 'touch']) {
  test(`protocol awaits its own ${kind} publication`, () => {
    const env = { ...process.env, VM2API_PROTOCOL_PUBLICATION_CASE: kind }
    delete env.NODE_TEST_CONTEXT
    const result = spawnSync(
      process.execPath,
      ['--experimental-test-module-mocks', '--import', setup, '--test', fixture],
      {
        env,
        encoding: 'utf8',
        timeout: 20_000,
      },
    )
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /# tests 1\b/)
  })
}
