import test from 'node:test'
import assert from 'node:assert/strict'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { createDatabase, getDb } from '../../src/lib/db/database.mjs'

async function replicas(t) {
  const db = getDb()
  const other = await createDatabase({ connectionString: process.env.VM2API_TEST_DATABASE_URL, schema: db.schema })
  const first = await new ProxyPool({ db }).init()
  const second = await new ProxyPool({ db: other }).init()
  for (const pool of [first, second]) {
    pool.stopScheduler()
    pool.probeOne = async () => ({ ok: true, scope: 'socks', latency_ms: 1 })
  }
  t.after(() => {
    first.stopScheduler()
    second.stopScheduler()
  })
  return [first, second]
}

test('a stale replica probe and flush preserve a proxy created by another connection', async (t) => {
  const [first, second] = await replicas(t)
  const existing = await first.importLines('192.0.2.1:1080')
  await first.flush()
  await second.reload()
  const created = await first.importLines('192.0.2.2:1080')
  await first.flush()
  await second.probeAll()
  await second.flush()
  const ids = (await first.repo.loadAll()).map((proxy) => proxy.id)
  assert.ok(ids.includes(existing.items[0].id))
  assert.ok(
    ids.includes(created.items[0].id),
    'a probe must not replace the whole proxy table with its stale working set',
  )
})
