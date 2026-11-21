/**
 * 064_proxy_dns_disable_svcb_https backfill.
 *
 * The switch moved from `settings.proxy_pool_config` onto the proxy row, so the
 * migration has to carry the old pool-level value onto every existing proxy —
 * otherwise an install that had it on silently loses the override on upgrade.
 * The SQL is exercised directly against a minimal schema: what matters is the
 * UPDATE's reading of the JSON settings blob, not the rest of the table.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const MIGRATION = fs.readFileSync(
  new URL('../../src/lib/db/migrations/064_proxy_dns_disable_svcb_https.sql', import.meta.url),
  'utf8',
)

/** Only the columns the migration reads or writes. */
function seed(t, poolConfig) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE proxies (id TEXT PRIMARY KEY, host TEXT, port INTEGER);
  `)
  if (poolConfig !== undefined) {
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      'proxy_pool_config',
      JSON.stringify(poolConfig),
      '2026-11-20T00:00:00.000Z',
    )
  }
  for (const [id, host] of [
    ['px-1', '10.0.0.1'],
    ['px-2', '10.0.0.2'],
  ]) {
    db.prepare('INSERT INTO proxies (id, host, port) VALUES (?, ?, 1080)').run(id, host)
  }
  db.exec(MIGRATION)
  // node:sqlite hands back null-prototype rows, which deepStrictEqual rejects
  // against a plain object literal even when the values match.
  return db
    .prepare('SELECT id, dns_disable_svcb_https FROM proxies ORDER BY id')
    .all()
    .map((row) => ({ ...row }))
}

test('the pool-level switch is carried onto every proxy when it was on', (t) => {
  assert.deepEqual(seed(t, { dns_disable_svcb_https: true, bind_limit: 5 }), [
    { id: 'px-1', dns_disable_svcb_https: 1 },
    { id: 'px-2', dns_disable_svcb_https: 1 },
  ])
})

test('a pool with the switch off, absent, or no config row at all backfills to off', (t) => {
  for (const config of [{ dns_disable_svcb_https: false }, { bind_limit: 5 }, undefined]) {
    assert.deepEqual(
      seed(t, config),
      [
        { id: 'px-1', dns_disable_svcb_https: 0 },
        { id: 'px-2', dns_disable_svcb_https: 0 },
      ],
      JSON.stringify(config ?? null),
    )
  }
})
