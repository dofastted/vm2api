import test from 'node:test'
import assert from 'node:assert/strict'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'

async function makePool(t) {
  const db = await createDatabase({ dbPath: ':memory:' })
  const pool = await new ProxyPool({ db }).init()
  t.after(async () => {
    pool.stopScheduler()
    await db.close()
  })
  return pool
}

test('import: different passwords at the same endpoint are distinct within a batch and after reload', async (t) => {
  const pool = await makePool(t)
  const first = pool.importLines('1.2.3.4:1080:alice:first\n1.2.3.4:1080:alice:second\n1.2.3.4:1080:alice:first')
  assert.equal(first.added, 2)
  assert.equal(first.skipped, 1)
  assert.equal(first.skip_details[0].reason, 'duplicate')
  assert.notEqual(first.items[0].id, first.items[1].id)

  await pool.reload()
  assert.deepEqual(pool.state.proxies.map((p) => p.password).sort(), ['first', 'second'])
  const next = pool.importLines('1.2.3.4:1080:alice:second\n1.2.3.4:1080:alice:third')
  assert.equal(next.added, 1)
  assert.equal(next.skipped, 1)
  assert.equal(pool.state.proxies.length, 3)
})

test('import: structured credentials containing colons do not collide, equivalent URLs still deduplicate', async (t) => {
  const pool = await makePool(t)
  const result = pool.importLines('', {
    fields: [
      { host: '1.2.3.4', port: 1080, username: 'alice:region', password: 'secret' },
      { host: '1.2.3.4', port: 1080, username: 'alice', password: 'region:secret' },
    ],
  })
  assert.equal(result.added, 2)
  assert.equal(result.skipped, 0)
  const duplicate = pool.importLines('socks5://alice:region%3Asecret@1.2.3.4:1080')
  assert.equal(duplicate.added, 0)
  assert.equal(duplicate.skipped, 1)
})
