import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabase } from '../../src/lib/db/sqlite-legacy.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = path.join(__dirname, '../../src/lib/db/migrations')

let tmp

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-mig-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** Copy migrations 001–maxVersion into a temp dir. */
function migrationsUpTo(maxVersion) {
  const dir = path.join(tmp, `migrations-to-${String(maxVersion).padStart(3, '0')}`)
  fs.mkdirSync(dir, { recursive: true })
  for (const f of fs.readdirSync(MIGRATIONS)) {
    const n = Number(f.split('_')[0])
    if (n >= 1 && n <= maxVersion) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f))
  }
  return dir
}

function appliedVersions(db) {
  return db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map((r) => r.version)
}

function legacyMigrationsDir() {
  return migrationsUpTo(13)
}

/** 013 end-state: category/key_secret/max_rpm/overrides/presented-key already exist. */
function seedLegacy(db) {
  db.exec(`
    INSERT INTO panel_users (id,username,password_hash,role,enabled,created_at) VALUES
      ('pu1','admin','scrypt$x','admin',1,'2026-01-01T00:00:00Z'),
      ('pu2','bob','scrypt$y','user',0,'2026-01-02T00:00:00Z');
    INSERT INTO api_keys (id,name,key,status,max_concurrency,quota_requests,quota_used,rpm,created_at,key_hash,category,key_secret) VALUES
      ('k1','key1','hmac:aa','active',4,100,42,60,'2026-01-01T00:00:00Z','h1','oauth','sec-k1'),
      ('k2','key2','hmac:bb','disabled',2,0,7,0,'2026-01-02T00:00:00Z','h2','api','sec-k2');
    INSERT INTO accounts (account_id,vm_id,email,max_concurrency,concurrency_override,max_rpm,rpm_override,requests,tokens_in,tokens_out,unified_json,last_blocked_json,updated_at) VALUES
      ('acc-1','vm-1','a@x.com',3,1,80,1,10,100,200,'{"5h":{"util":0.5}}','{"reason":"429"}','2026-01-01T00:00:00Z'),
      ('acc-2','vm-2','b@x.com',2,0,0,0,5,50,60,'not json',NULL,'2026-01-02T00:00:00Z');
    INSERT INTO account_runtime_states (account_id,vm_id,status,priority,weight,cooldown_until,cooldown_reason,model_states_json,last_used_at,credential_generation,worker_heartbeat_at,rate_limited_at,updated_at) VALUES
      ('acc-1','vm-1','cooldown',10,3,1767225600000,'rate_limited','{"m":1}',1767225000000,2,1767225500000,1767224000000,'2026-01-01T00:00:00Z'),
      ('acc-orphan','vm-3','ready',7,1,NULL,NULL,'{}',NULL,1,NULL,NULL,'2026-01-03T00:00:00Z');
    INSERT INTO request_logs (id,request_id,ts,model,status,input_tokens,output_tokens,api_key_id,account_id,total_cost,api_key_presented) VALUES
      ('l1','req-1','2026-01-01T00:00:00Z','fable-5',200,10,NULL,'k1','acc-1',0.5,'sk-presented-1'),
      ('l2','req-2','2026-01-02T00:00:00Z','opus-5',500,NULL,20,'k2','acc-2',NULL,NULL);
    INSERT INTO proxies (id,scheme,host,port,status,enabled,created_at) VALUES
      ('px-1','socks5','1.2.3.4',1080,'ok',1,'2026-01-01T00:00:00Z'),
      ('px-2','socks5',NULL,NULL,'unknown',0,'2026-01-02T00:00:00Z');
  `)
}

/** 010 end-state (现网): no key_secret / max_rpm / api_key_presented. */
function seedAt010(db) {
  db.exec(`
    INSERT INTO panel_users (id,username,password_hash,role,enabled,created_at) VALUES
      ('pu1','admin','scrypt$x','admin',1,'2026-01-01T00:00:00Z');
    INSERT INTO api_keys (id,name,key,status,max_concurrency,quota_requests,quota_used,rpm,created_at,key_hash,category) VALUES
      ('k1','key1','hmac:aa','active',4,100,42,60,'2026-01-01T00:00:00Z','h1','oauth');
    INSERT INTO accounts (account_id,vm_id,email,max_concurrency,concurrency_override,requests,tokens_in,tokens_out,unified_json,updated_at) VALUES
      ('acc-1','vm-1','a@x.com',3,1,10,100,200,'{"5h":{"util":0.5}}','2026-01-01T00:00:00Z');
    INSERT INTO account_runtime_states (account_id,vm_id,status,priority,weight,updated_at) VALUES
      ('acc-1','vm-1','ready',10,3,'2026-01-01T00:00:00Z');
    INSERT INTO request_logs (id,request_id,ts,model,status,input_tokens,output_tokens,api_key_id,account_id,total_cost) VALUES
      ('l1','req-1','2026-01-01T00:00:00Z','fable-5',200,10,20,'k1','acc-1',0.5);
  `)
}

test('fresh db: all migrations apply, groups seeded coding/other', () => {
  const db = createDatabase({ dbPath: path.join(tmp, 'fresh.db') })
  const groups = db.prepare('SELECT id,name FROM groups ORDER BY id').all()
  assert.deepEqual(
    groups.map((g) => [g.id, g.name]),
    [
      [1, 'coding'],
      [2, 'other'],
    ],
  )
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name)
  for (const t of ['users', 'groups', 'account_groups', 'redeem_codes', 'usage_logs', 'account_runtime']) {
    assert.ok(tables.includes(t), `missing table ${t}`)
  }
  assert.ok(!tables.includes('request_logs'), 'request_logs should be renamed')
  db.close()
})

test('legacy 001-013 db upgrades with data intact', () => {
  const dbPath = path.join(tmp, 'up.db')
  let db = createDatabase({ dbPath, migrationsDir: legacyMigrationsDir() })
  seedLegacy(db)
  db.close()

  db = createDatabase({ dbPath })

  // panel_users → users (role identity, enabled → status)
  const users = db
    .prepare('SELECT id,email,username,role,status FROM users ORDER BY id')
    .all()
    .map((r) => ({ ...r }))
  assert.equal(users.length, 2)
  assert.deepEqual(users[0], {
    id: 'pu1',
    email: 'admin@panel.local',
    username: 'admin',
    role: 'admin',
    status: 'active',
  })
  assert.equal(users[1].status, 'disabled')

  // api_keys: USD pair takes canonical names, request quota renamed, coding group
  const k1 = db.prepare('SELECT * FROM api_keys WHERE id = ?').get('k1')
  assert.equal(k1.quota, 0)
  assert.equal(k1.quota_used, 0)
  assert.equal(k1.quota_requests, 100)
  assert.equal(k1.quota_requests_used, 42)
  assert.equal(k1.group_id, 1)
  assert.equal(k1.category, 'oauth')
  assert.equal(k1.key_secret, 'sec-k1')
  const k2 = db.prepare('SELECT category, key_secret FROM api_keys WHERE id = ?').get('k2')
  assert.equal(k2.category, 'api')
  assert.equal(k2.key_secret, 'sec-k2')

  // accounts: runtime merge + extra fold + ms→ISO conversion
  const a1 = db.prepare('SELECT * FROM accounts WHERE id = ?').get('acc-1')
  assert.equal(a1.name, 'a@x.com')
  assert.equal(a1.type, 'oauth')
  assert.equal(a1.platform, 'claude')
  assert.equal(a1.priority, 10)
  assert.equal(a1.load_factor, 3)
  assert.equal(a1.concurrency, 3)
  assert.equal(a1.max_rpm, 80)
  assert.equal(a1.rpm_override, 1)
  assert.equal(a1.concurrency_override, 1)
  assert.equal(a1.temp_unschedulable_until, '2026-01-01T00:00:00.000Z')
  assert.equal(a1.temp_unschedulable_reason, 'rate_limited')
  assert.equal(JSON.parse(a1.extra).unified['5h'].util, 0.5)
  assert.equal(JSON.parse(a1.extra).last_blocked.reason, '429')
  // corrupt unified_json degrades to null, not a migration failure
  const a2 = db.prepare('SELECT extra FROM accounts WHERE id = ?').get('acc-2')
  assert.equal(JSON.parse(a2.extra).unified, null)

  // orphan runtime row got a minimal accounts row; scheduling state kept
  const orphan = db.prepare('SELECT * FROM accounts WHERE id = ?').get('acc-orphan')
  assert.ok(orphan, 'orphan runtime row must materialize an accounts row')
  assert.equal(orphan.priority, 7)
  assert.equal(orphan.vm_id, 'vm-3')

  // every account landed in the coding group — including the orphan
  const ag = db
    .prepare('SELECT account_id,group_id FROM account_groups ORDER BY account_id')
    .all()
    .map((r) => ({ ...r }))
  assert.deepEqual(ag, [
    { account_id: 'acc-1', group_id: 1 },
    { account_id: 'acc-2', group_id: 1 },
    { account_id: 'acc-orphan', group_id: 1 },
  ])

  // thin runtime table keeps worker transients
  const rt = db.prepare('SELECT * FROM account_runtime ORDER BY account_id').all()
  assert.equal(rt.length, 2)
  assert.equal(rt[0].credential_generation, 2)
  assert.equal(rt[0].worker_heartbeat_at, 1767225500000)
  // the new account_runtime(vm_id) index exists on the new table
  const idx = db.prepare("SELECT tbl_name FROM sqlite_master WHERE name = 'idx_account_runtime_vm_new'").get()
  assert.equal(idx?.tbl_name, 'account_runtime')

  // request_logs → usage_logs with NULL token normalization + group backfill
  const logs = db
    .prepare(
      'SELECT id,request_id,created_at,input_tokens,output_tokens,group_id,rate_multiplier,actual_cost,total_cost,api_key_presented FROM usage_logs ORDER BY id',
    )
    .all()
  assert.equal(logs.length, 2)
  assert.equal(logs[0].created_at, '2026-01-01T00:00:00Z')
  assert.equal(logs[0].output_tokens, 0)
  assert.equal(logs[1].input_tokens, 0)
  assert.equal(logs[0].group_id, 1)
  assert.equal(logs[0].rate_multiplier, 1)
  assert.equal(logs[0].actual_cost, 0.5)
  assert.equal(logs[1].actual_cost, null)
  assert.equal(logs[0].api_key_presented, 'sk-presented-1')
  assert.equal(logs[1].api_key_presented, null)

  // proxies: scheme→protocol, generated display name, NULL-host fallback
  const px = db
    .prepare('SELECT id,protocol,name,enabled FROM proxies ORDER BY id')
    .all()
    .map((r) => ({ ...r }))
  assert.deepEqual(px, [
    { id: 'px-1', protocol: 'socks5', name: '1.2.3.4:1080', enabled: 1 },
    { id: 'px-2', protocol: 'socks5', name: 'px-2', enabled: 0 },
  ])

  // rollback snapshots survive
  assert.equal(db.prepare('SELECT COUNT(*) c FROM panel_users_legacy').get().c, 2)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM accounts_legacy').get().c, 2)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM account_runtime_states_legacy').get().c, 2)
  db.close()

  // re-open: applied migrations are skipped (checksum match), data unchanged
  db = createDatabase({ dbPath })
  assert.equal(db.prepare('SELECT COUNT(*) c FROM users').get().c, 2)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM usage_logs').get().c, 2)
  db.close()
})

test('legacy 001-010 db upgrades through 011-013 then 014-018', () => {
  const dbPath = path.join(tmp, 'from010.db')
  let db = createDatabase({ dbPath, migrationsDir: migrationsUpTo(10) })
  assert.deepEqual(appliedVersions(db), ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010'])
  seedAt010(db)
  db.close()

  db = createDatabase({ dbPath })
  const versions = appliedVersions(db)
  for (const v of ['011', '012', '013', '014', '015', '016', '017', '018']) {
    assert.ok(versions.includes(v), `missing migration ${v} on 010 upgrade path`)
  }

  const k1 = db.prepare('SELECT * FROM api_keys WHERE id = ?').get('k1')
  assert.equal(k1.category, 'oauth')
  assert.equal(k1.key_secret, null)
  assert.equal(k1.quota_requests_used, 42)
  assert.equal(k1.quota, 0)
  assert.equal(k1.quota_used, 0)

  const a1 = db.prepare('SELECT * FROM accounts WHERE id = ?').get('acc-1')
  assert.equal(a1.max_rpm, 0)
  assert.equal(a1.rpm_override, 0)
  assert.equal(a1.concurrency_override, 1)

  const log = db.prepare('SELECT api_key_presented, created_at FROM usage_logs WHERE id = ?').get('l1')
  assert.equal(log.api_key_presented, null)
  assert.equal(log.created_at, '2026-01-01T00:00:00Z')

  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='panel_users_legacy'").get())
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts_legacy'").get())
  db.close()
})

test('published 001 proxy schema upgrades through 018 with LF or CRLF checksum', () => {
  const historicalChecksums = [
    '376c686118bbd8aaa6db6ea13fb2ff0afecc0c7464bc3d668743a55c9ccafdde',
    'd6769ea311718b5af91e47295f97c3bf2722ece6d26acee7e89df84b88599ae2',
  ]
  for (const [index, checksum] of historicalChecksums.entries()) {
    const dbPath = path.join(tmp, `from-original-001-${index}.db`)
    let db = createDatabase({ dbPath, migrationsDir: migrationsUpTo(1) })
    db.exec(`
      DROP TABLE proxies;
      CREATE TABLE proxies (
        id TEXT PRIMARY KEY,
        scheme TEXT DEFAULT 'socks5',
        host TEXT,
        port INTEGER,
        username TEXT,
        password TEXT,
        url TEXT,
        status TEXT DEFAULT 'active',
        bound_vm_id TEXT,
        failures INTEGER DEFAULT 0,
        last_probe_at TEXT,
        last_probe_ok INTEGER,
        latency_ms INTEGER,
        disabled_reason TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      INSERT INTO proxies (
        id, scheme, host, port, username, password, url, status, bound_vm_id,
        failures, last_probe_at, last_probe_ok, latency_ms, disabled_reason,
        created_at, updated_at
      ) VALUES (
        'px-original', 'socks5', '10.0.0.8', 1080, 'u', 'p',
        'socks5://u:p@10.0.0.8:1080', 'dead', 'vm-old', 3,
        '2026-08-18T00:01:00Z', 0, 42, 'probe failed',
        '2026-08-18T00:00:00Z', '2026-08-18T00:02:00Z'
      );
    `)
    db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = ?').run(checksum, '001')
    db.close()

    db = createDatabase({ dbPath })
    assert.ok(appliedVersions(db).includes('018'))
    const proxy = db
      .prepare(`
      SELECT id, protocol, host, port, raw, status, enabled, bound_vm_id,
             consecutive_failures, latency_ms, last_probe_at, last_error, name
      FROM proxies WHERE id = 'px-original'
    `)
      .get()
    assert.deepEqual(
      { ...proxy },
      {
        id: 'px-original',
        protocol: 'socks5',
        host: '10.0.0.8',
        port: 1080,
        raw: 'socks5://u:p@10.0.0.8:1080',
        status: 'dead',
        enabled: 1,
        bound_vm_id: 'vm-old',
        consecutive_failures: 3,
        latency_ms: 42,
        last_probe_at: '2026-08-18T00:01:00Z',
        last_error: 'probe failed',
        name: '10.0.0.8:1080',
      },
    )
    db.close()
  }
})

test('published 001 checksum does not authorize an unrecognized proxy schema', () => {
  const dbPath = path.join(tmp, 'unrecognized-original-001.db')
  const db = createDatabase({ dbPath, migrationsDir: migrationsUpTo(1) })
  db.exec('DROP TABLE proxies; CREATE TABLE proxies (id TEXT PRIMARY KEY, url TEXT, raw TEXT);')
  db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = ?').run(
    '376c686118bbd8aaa6db6ea13fb2ff0afecc0c7464bc3d668743a55c9ccafdde',
    '001',
  )
  db.close()

  assert.throws(() => createDatabase({ dbPath }), /historical migration 001 proxy schema is not recognized/)
})

test('checksum mismatch on an applied migration is a hard error', () => {
  const dir = path.join(tmp, 'mut-migrations')
  fs.mkdirSync(dir, { recursive: true })
  for (const f of fs.readdirSync(MIGRATIONS)) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f))
  const dbPath = path.join(tmp, 'chk.db')
  createDatabase({ dbPath, migrationsDir: dir }).close()
  fs.appendFileSync(path.join(dir, '014_users_groups.sql'), '\n-- tampered\n')
  assert.throws(() => createDatabase({ dbPath, migrationsDir: dir }), /checksum mismatch/)
})
