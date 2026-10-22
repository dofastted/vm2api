import test from 'node:test'
import assert from 'node:assert/strict'
import { pgEnvironment, runPgTool } from '../../src/lib/admin/backup-core.mjs'

test('PostgreSQL child environment preserves encoded credentials and IPv6 without command arguments', () => {
  const env = pgEnvironment('postgresql://test:p%40ss%3Aword@[::1]:55432/example_test?sslmode=verify-full')
  assert.equal(env.PGPASSWORD, 'p@ss:word')
  assert.equal(env.PGHOST, '::1')
  assert.equal(env.PGPORT, '55432')
  assert.equal(env.PGDATABASE, 'example_test')
  assert.equal(env.PGSSLMODE, 'verify-full')
})

test('child process errors do not return stderr that can contain row values', async () => {
  await assert.rejects(
    runPgTool(
      process.execPath,
      ['-e', "process.stderr.write('synthetic-sensitive-row');process.exit(2)"],
      'postgresql://test:synthetic-password@127.0.0.1/example_test',
    ),
    (error) => {
      assert.equal(error.message.includes('synthetic'), false)
      assert.match(error.message, /failed \(exit 2\)/)
      return true
    },
  )
})
