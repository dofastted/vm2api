import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { openDatabase, closeDatabase, getDb } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { StickyRepo } from '../../src/lib/db/repos/sticky-repo.mjs'
import { VmsRepo } from '../../src/lib/db/repos/vms-repo.mjs'
import { BackupService, tarAvailable } from '../../src/lib/admin/backup-service.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { stopVmWatch, initVmDbSync } from '../../src/lib/vm/vm-db-sync.mjs'
import { setVmWriteHook } from '../../src/lib/vm/vm-file.mjs'

let root, dataDir, configDir, svc

function seedVm(id = 'vm-b1') {
  const vmsDir = path.join(root, 'vms')
  fs.mkdirSync(vmsDir, { recursive: true })
  fs.writeFileSync(
    path.join(vmsDir, `${id}.json`),
    JSON.stringify(
      {
        id,
        name: 'b',
        status: 'running',
        claude: { access_token: 'sk-ant-oat01-BAK', refresh_token: 'sk-ant-ort01-BAK', account_uuid: 'acct-b' },
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(path.join(vmsDir, 'active.json'), JSON.stringify({ active_vm: id }))
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-bak-'))
  dataDir = path.join(root, 'data')
  configDir = path.join(root, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, 'routing.json'), JSON.stringify({ sticky: { enabled: true } }))
  openDatabase({ dataDir })
  svc = new BackupService({ dataDir, projectRoot: root, configDir })
})

afterEach(() => {
  svc.stopScheduler()
  stopVmWatch()
  setVmWriteHook(null)
  closeDatabase()
  fs.rmSync(root, { recursive: true, force: true })
  delete process.env.KIN_BACKUP_DISABLED
  delete process.env.KIN_BACKUP_INTERVAL_HOURS
  delete process.env.KIN_BACKUP_RETENTION
})

test('tar is available in this environment', () => {
  assert.equal(tarAvailable(), true)
})

test('createBackup produces tar.gz with manifest + db + vms + config, records ok', async () => {
  seedVm()
  initVmDbSync(root, { watch: false })
  new SettingsRepo(getDb()).set('marker', 'before-backup')

  const rec = await svc.createBackup({ kind: 'manual' })
  assert.equal(rec.status, 'ok')
  assert.equal(rec.kind, 'manual')
  assert.ok(rec.file_path.endsWith('.tar.gz'))
  assert.ok(fs.existsSync(rec.file_path))
  assert.ok(rec.size_bytes > 0)
  assert.match(rec.sha256, /^[0-9a-f]{64}$/)
  assert.equal(rec.includes.vms, 2) // vm-b1.json + active.json
  assert.equal(rec.includes.config, 1)

  // archive contents sane
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-bak-x-'))
  spawnSync('tar', ['-xzf', rec.file_path, '-C', tmp])
  assert.ok(fs.existsSync(path.join(tmp, 'manifest.json')))
  assert.ok(fs.existsSync(path.join(tmp, 'db', 'kin.db')))
  assert.ok(fs.existsSync(path.join(tmp, 'vms', 'vm-b1.json')))
  assert.ok(fs.existsSync(path.join(tmp, 'config', 'routing.json')))
  const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'))
  assert.equal(manifest.version, 1)
  assert.ok(manifest.sha256s['db/kin.db'])
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('createBackup does not block the main thread (gateway keeps ticking)', async () => {
  seedVm()
  initVmDbSync(root, { watch: false })
  let ticks = 0
  const timer = setInterval(() => {
    ticks += 1
  }, 5)
  try {
    await svc.createBackup({ kind: 'manual' })
  } finally {
    clearInterval(timer)
  }
  // The backup pipeline is synchronous for minutes on a real database; it must
  // run off the main thread or timers (SSE keepalive, health probes) stop firing
  // and the gateway looks dead to the reverse proxy (Cloudflare 524).
  assert.ok(ticks > 0, `event loop should tick during backup, got ${ticks}`)
})

test('restoreBackup rolls data back and creates pre_restore record', async () => {
  seedVm()
  initVmDbSync(root, { watch: false })
  const keys = new ApiKeyStore({ db: getDb() })
  const kept = keys.create({ name: 'kept-key' })

  const rec = await svc.createBackup({ kind: 'manual' })

  // mutate after the backup
  const lost = keys.create({ name: 'lost-key' })
  new SettingsRepo(getDb()).set('marker', 'after-backup')
  // wire the rebind like the server does
  let reboundDb = null
  svc.onRestored((db) => {
    reboundDb = db
    keys.rebind(db)
  })

  const out = await svc.restoreBackup(rec.id)
  assert.equal(out.ok, true)
  assert.ok(reboundDb, 'rebind callback should fire')

  // state rolled back
  assert.ok(keys.getById(kept.id), 'pre-backup key survives')
  assert.equal(keys.getById(lost.id), null, 'post-backup key rolled back')
  assert.equal(new SettingsRepo(getDb()).get('marker'), null)

  // old db file kept on disk as safety net
  assert.ok(fs.existsSync(path.join(dataDir, 'kin.db.pre-restore')))
  // pre_restore archive file kept on disk for manual recovery
  const preFiles = fs.readdirSync(path.join(dataDir, 'backups'))
  assert.ok(preFiles.length >= 2, 'manual + pre_restore archives on disk')
  // ledger re-registered after restore: pre_restore (and restored manual) visible
  const ledger = svc.list()
  assert.ok(
    ledger.some((r) => r.id === out.pre_restore && r.kind === 'pre_restore'),
    'pre_restore record re-registered in restored DB',
  )
  assert.ok(
    ledger.some((r) => r.id === rec.id),
    'restored manual record present',
  )
  assert.ok(
    ledger.every((r) => r.file_exists),
    'all ledger rows point at real files',
  )
})

test('restore fails when stores cannot rebind to the reopened database', async () => {
  seedVm()
  const rec = await svc.createBackup({ kind: 'manual' })
  svc.onRestored(() => {
    throw new Error('store rebind failed')
  })

  await assert.rejects(svc.restoreBackup(rec.id), /store rebind failed/)
  assert.equal(svc.isRestoring, false)
  assert.doesNotThrow(() => getDb().prepare('SELECT 1').get())
})

test('restore rebuilds vm files from DB mirror for db-only path', async () => {
  seedVm('vm-b2')
  initVmDbSync(root, { watch: false })
  const rec = await svc.createBackup({ kind: 'manual' })

  // delete vm file + its row is still in backup db; also delete local file post-backup
  fs.rmSync(path.join(root, 'vms', 'vm-b2.json'))
  const out = await svc.restoreBackup(rec.id)
  assert.equal(out.ok, true)
  const back = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-b2.json'), 'utf8'))
  // tar snapshot still has the on-disk file from backup time; DB is metadata only.
  assert.equal(back.claude.access_token, 'sk-ant-oat01-BAK')
  const row = new VmsRepo(getDb()).get('vm-b2')
  assert.equal(row.access_token, null)
  assert.equal(row.vm.claude.has_access, true)
  assert.equal(row.vm.claude.access_token, undefined)
})

test('sha256 tamper detection blocks restore', async () => {
  seedVm()
  const rec = await svc.createBackup({ kind: 'manual' })
  fs.appendFileSync(rec.file_path, 'tamper')
  await assert.rejects(svc.restoreBackup(rec.id), /sha256 mismatch/)
})

test('retention prunes old backups', async () => {
  process.env.KIN_BACKUP_RETENTION = '2'
  seedVm()
  const recs = []
  for (let i = 0; i < 4; i++) recs.push(await svc.createBackup({ kind: 'manual' }))
  const remaining = svc.list().filter((r) => r.kind === 'manual')
  assert.equal(remaining.length, 2)
  // newest two kept
  assert.ok(remaining.some((r) => r.id === recs[3].id))
  assert.ok(remaining.some((r) => r.id === recs[2].id))
  // pruned files removed from disk
  assert.equal(fs.existsSync(recs[0].file_path), false)
  assert.equal(fs.existsSync(recs[1].file_path), false)
})

test('schedule config defaults on, env override off, updateSchedule persists', () => {
  const cfg = svc.getSchedule()
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.interval_hours, 24)
  assert.equal(cfg.retention, 7)

  svc.updateSchedule({ interval_hours: 6, retention: 3 })
  assert.equal(svc.getSchedule().interval_hours, 6)
  assert.equal(svc.getSchedule().retention, 3)
  assert.throws(() => svc.updateSchedule({ interval_hours: 0 }), /interval_hours/)

  process.env.KIN_BACKUP_DISABLED = '1'
  assert.equal(svc.getSchedule().enabled, false)
})

test('shouldRunScheduled: true when never run, false right after a backup', async () => {
  seedVm()
  assert.equal(svc.shouldRunScheduled(), true)
  await svc.createBackup({ kind: 'scheduled' })
  assert.equal(svc.shouldRunScheduled(), false)
  // pretend 25h elapsed
  assert.equal(svc.shouldRunScheduled(Date.now() + 25 * 3600_000), true)
})

test('remove deletes record + file', async () => {
  seedVm()
  const rec = await svc.createBackup({ kind: 'manual' })
  assert.equal(svc.remove(rec.id), true)
  assert.equal(fs.existsSync(rec.file_path), false)
  assert.equal(svc.get(rec.id), null)
})

test('backup restore preserves root load and exact pre-existing account bindings', async () => {
  const roots = new StickyRepo(getDb())
  roots.upsert('assignment:root', {
    account_id: 'old-account',
    vm_id: 'vm-b1',
    expires_at: Date.now() + 60_000,
    assignment_root: 1,
  })
  roots.upsert('assignment:child', {
    account_id: 'old-account',
    vm_id: 'vm-b1',
    session_id: 'child-outbound',
    expires_at: Date.now() + 60_000,
  })
  const before = roots.get('assignment:root')
  const backup = await svc.createBackup({ kind: 'manual' })
  roots.remove('assignment:root')
  assert.equal(roots.rootAssignmentCounts().size, 0)
  await svc.restoreBackup(backup.id)
  const restored = new StickyRepo(getDb())
  assert.deepEqual(restored.get('assignment:root'), before)
  assert.deepEqual([...restored.rootAssignmentCounts()], [['old-account', 1]])
})
