import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { openDatabase, closeDatabase, getDb, createDatabase } from '../../src/lib/db/database.mjs'
import { BackupRepo } from '../../src/lib/db/repos/backup-repo.mjs'
import { sha256FileAsync } from '../../src/lib/admin/backup-core.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
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

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-bak-'))
  dataDir = path.join(root, 'data')
  configDir = path.join(root, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, 'routing.json'), JSON.stringify({ sticky: { enabled: true } }))
  await openDatabase({ dataDir })
  svc = new BackupService({ dataDir, projectRoot: root, configDir })
})

afterEach(async () => {
  svc.stopScheduler()
  stopVmWatch()
  setVmWriteHook(null)
  await closeDatabase()
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
  await initVmDbSync(root, { watch: false })
  await new SettingsRepo(getDb()).set('marker', 'before-backup')

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
  assert.ok(fs.existsSync(path.join(tmp, 'db', 'postgres.dump')))
  assert.ok(fs.existsSync(path.join(tmp, 'vms', 'vm-b1.json')))
  assert.ok(fs.existsSync(path.join(tmp, 'config', 'routing.json')))
  const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'))
  assert.equal(manifest.version, 2)
  assert.ok(manifest.sha256s['db/postgres.dump'])
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('createBackup does not block the main thread (gateway keeps ticking)', async () => {
  seedVm()
  await initVmDbSync(root, { watch: false })
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
  await initVmDbSync(root, { watch: false })
  const keys = new ApiKeyStore({ db: getDb() })
  const kept = await keys.create({ name: 'kept-key' })

  const rec = await svc.createBackup({ kind: 'manual' })

  // mutate after the backup
  const lost = await keys.create({ name: 'lost-key' })
  await new SettingsRepo(getDb()).set('marker', 'after-backup')
  // wire the rebind like the server does
  let reboundDb = null
  svc.onRestored(async (db) => {
    reboundDb = db
    await keys.rebind(db)
  })

  const out = await svc.restoreBackup(rec.id)
  assert.equal(out.ok, true)
  assert.equal(fs.existsSync(svc.maintenanceFile), false)
  assert.ok(reboundDb, 'rebind callback should fire')

  // state rolled back
  assert.ok(await keys.getById(kept.id), 'pre-backup key survives')
  assert.equal(await keys.getById(lost.id), null, 'post-backup key rolled back')
  assert.equal(await new SettingsRepo(getDb()).get('marker'), null)

  // pre_restore archive file kept on disk for manual recovery
  const preFiles = fs.readdirSync(path.join(dataDir, 'backups'))
  assert.ok(preFiles.length >= 2, 'manual + pre_restore archives on disk')
  // ledger re-registered after restore: pre_restore (and restored manual) visible
  const ledger = await svc.list()
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

test('restore failure keeps maintenance enabled and exposes the recovery archive', async () => {
  seedVm()
  const rec = await svc.createBackup({ kind: 'manual' })
  svc.onRestored(() => {
    throw new Error('store rebind failed')
  })

  await assert.rejects(svc.restoreBackup(rec.id), /restore and rollback failed/)
  assert.equal(svc.isRestoring, true)
  assert.equal(svc.isMaintaining, true)
  assert.equal(fs.existsSync(svc.maintenanceFile), true)
  await assert.rejects(createDatabase({ dataDir, connectionString: 'invalid' }), /restore maintenance marker/)
  assert.equal((await getDb().prepare('SELECT 1 AS ok').get()).ok, 1)
})

test('restore restores VM JSON files together with PostgreSQL metadata', async () => {
  seedVm('vm-b2')
  await initVmDbSync(root, { watch: false })
  const rec = await svc.createBackup({ kind: 'manual' })

  // delete vm file + its row is still in backup db; also delete local file post-backup
  fs.rmSync(path.join(root, 'vms', 'vm-b2.json'))
  const out = await svc.restoreBackup(rec.id)
  assert.equal(out.ok, true)
  const back = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-b2.json'), 'utf8'))
  // tar snapshot still has the on-disk file from backup time; DB is metadata only.
  assert.equal(back.claude.access_token, 'sk-ant-oat01-BAK')
  const row = await new VmsRepo(getDb()).get('vm-b2')
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
  const remaining = (await svc.list()).filter((r) => r.kind === 'manual')
  assert.equal(remaining.length, 2)
  // newest two kept
  assert.ok(remaining.some((r) => r.id === recs[3].id))
  assert.ok(remaining.some((r) => r.id === recs[2].id))
  // pruned files removed from disk
  assert.equal(fs.existsSync(recs[0].file_path), false)
  assert.equal(fs.existsSync(recs[1].file_path), false)
})

test('schedule config defaults on, env override off, updateSchedule persists', async () => {
  const cfg = await svc.getSchedule()
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.interval_hours, 24)
  assert.equal(cfg.retention, 7)

  await svc.updateSchedule({ interval_hours: 6, retention: 3 })
  assert.equal((await svc.getSchedule()).interval_hours, 6)
  assert.equal((await svc.getSchedule()).retention, 3)
  await assert.rejects(() => svc.updateSchedule({ interval_hours: 0 }), /interval_hours/)

  process.env.KIN_BACKUP_DISABLED = '1'
  assert.equal((await svc.getSchedule()).enabled, false)
})

test('shouldRunScheduled: true when never run, false right after a backup', async () => {
  seedVm()
  assert.equal(await svc.shouldRunScheduled(), true)
  await svc.createBackup({ kind: 'scheduled' })
  assert.equal(await svc.shouldRunScheduled(), false)
  // pretend 25h elapsed
  assert.equal(await svc.shouldRunScheduled(Date.now() + 25 * 3600_000), true)
})

test('stopping scheduling drains an in-flight check without starting a backup afterward', async (t) => {
  let check
  t.mock.method(globalThis, 'setInterval', (callback) => {
    check = callback
    return { unref() {} }
  })
  t.mock.method(globalThis, 'clearInterval', () => {})
  let releaseCheck, signalCheck
  const gate = new Promise((resolve) => {
    releaseCheck = resolve
  })
  const started = new Promise((resolve) => {
    signalCheck = resolve
  })
  svc.shouldRunScheduled = async () => {
    signalCheck()
    await gate
    return true
  }
  let backups = 0
  svc.createBackup = async () => {
    backups += 1
    return { size_bytes: 0 }
  }
  svc.startScheduler()
  const checking = check()
  await started
  svc.stopScheduler()
  let flushed = false
  const pending = svc.flush().then(() => {
    flushed = true
  })
  let flushedDuringCheck
  try {
    await new Promise((resolve) => setImmediate(resolve))
    flushedDuringCheck = flushed
  } finally {
    releaseCheck()
    await checking
    await pending
  }
  assert.deepEqual({ flushedDuringCheck, backups }, { flushedDuringCheck: false, backups: 0 })
})

test('restarting scheduling does not reactivate a check from the previous schedule', async (t) => {
  let check
  t.mock.method(globalThis, 'setInterval', (callback) => {
    check = callback
    return { unref() {} }
  })
  t.mock.method(globalThis, 'clearInterval', () => {})
  let releaseCheck
  const gate = new Promise((resolve) => {
    releaseCheck = resolve
  })
  svc.shouldRunScheduled = async () => {
    await gate
    return true
  }
  let backups = 0
  svc.createBackup = async () => {
    backups += 1
    return { size_bytes: 0 }
  }
  svc.startScheduler()
  const previous = check()
  svc.startScheduler()
  releaseCheck()
  await previous
  assert.equal(backups, 0)
  await check()
  await svc.flush()
  assert.equal(backups, 1)
})

test('remove deletes record + file', async () => {
  seedVm()
  const rec = await svc.createBackup({ kind: 'manual' })
  assert.equal(await svc.remove(rec.id), true)
  assert.equal(fs.existsSync(rec.file_path), false)
  assert.equal(await svc.get(rec.id), null)
})

test('backup snapshot and copied files precede resumed writes', async () => {
  seedVm()
  await new SettingsRepo(getDb()).set('snapshot-boundary', 'before')
  const transitions = []
  svc.onMaintenance(async (enabled, reason) => {
    transitions.push([enabled, reason])
    if (!enabled) {
      await new SettingsRepo(getDb()).set('snapshot-boundary', 'after')
      fs.writeFileSync(path.join(configDir, 'routing.json'), '{"after":true}')
    }
  })
  const rec = await svc.createBackup()
  svc.onMaintenance(null)
  await svc.restoreBackup(rec.id)
  assert.equal(await new SettingsRepo(getDb()).get('snapshot-boundary'), 'before')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(configDir, 'routing.json'))), { sticky: { enabled: true } })
  assert.deepEqual(transitions, [
    [true, 'backup'],
    [false, 'backup'],
  ])
})

test('restore rejects an archive directory symlink before entering maintenance', async () => {
  const source = path.join(root, 'symlink-source')
  const outside = path.join(root, 'outside-extraction')
  fs.mkdirSync(source)
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'sentinel.json'), '{"unchanged":true}')
  fs.writeFileSync(path.join(source, 'manifest.json'), '{}')
  fs.symlinkSync(outside, path.join(source, 'vms'))
  const archive = path.join(root, 'symlink.tar.gz')
  assert.equal(spawnSync('tar', ['-czf', archive, '-C', source, 'manifest.json', 'vms']).status, 0)
  // Reproduce the old extraction behavior using only this test's temporary paths.
  const oldExtraction = path.join(root, 'old-extraction')
  fs.mkdirSync(oldExtraction)
  assert.equal(spawnSync('tar', ['-xzf', archive, '-C', oldExtraction]).status, 0)
  assert.equal(fs.lstatSync(path.join(oldExtraction, 'vms')).isSymbolicLink(), true)
  const rec = await new BackupRepo(getDb()).insert({
    id: 'bak_symlink',
    created_at: new Date().toISOString(),
    status: 'ok',
    kind: 'manual',
    file_name: 'symlink.tar.gz',
    file_path: archive,
    sha256: await sha256FileAsync(archive),
  })
  await assert.rejects(svc.restoreBackup(rec.id), /invalid or duplicate backup archive path/)
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel.json'), 'utf8'), '{"unchanged":true}')
  assert.equal(svc.isMaintaining, false)
})

test('restore rejects file counts that disagree with the manifest', async () => {
  seedVm()
  const rec = await svc.createBackup()
  const source = path.join(root, 'count-mismatch')
  fs.mkdirSync(source)
  assert.equal(spawnSync('tar', ['-xzf', rec.file_path, '-C', source]).status, 0)
  const file = path.join(source, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(file))
  manifest.includes.vms += 1
  fs.writeFileSync(file, JSON.stringify(manifest))
  assert.equal(spawnSync('tar', ['-czf', rec.file_path, '-C', source, '.']).status, 0)
  await getDb()
    .prepare('UPDATE backup_records SET sha256 = $1 WHERE id = $2')
    .run(await sha256FileAsync(rec.file_path), rec.id)
  await assert.rejects(svc.restoreBackup(rec.id), /backup file snapshot is incomplete/)
  assert.equal(svc.isMaintaining, false)
})

test('restore replaces all top-level JSON while preserving CLI homes and non-JSON files', async () => {
  seedVm()
  const vmsDir = path.join(root, 'vms')
  const cliHome = path.join(vmsDir, 'vm-b1', 'cli-home')
  fs.mkdirSync(cliHome, { recursive: true })
  fs.writeFileSync(path.join(cliHome, 'keep.txt'), 'keep')
  fs.writeFileSync(path.join(configDir, 'keep.txt'), 'keep')
  const rec = await svc.createBackup()
  fs.writeFileSync(path.join(vmsDir, 'vm-b1-chat.json'), '{}')
  fs.writeFileSync(path.join(configDir, 'after-backup.json'), '{}')
  await svc.restoreBackup(rec.id)
  assert.equal(fs.existsSync(path.join(vmsDir, 'vm-b1-chat.json')), false)
  assert.equal(fs.existsSync(path.join(configDir, 'after-backup.json')), false)
  assert.equal(fs.readFileSync(path.join(cliHome, 'keep.txt'), 'utf8'), 'keep')
  assert.equal(fs.readFileSync(path.join(configDir, 'keep.txt'), 'utf8'), 'keep')
})

test('failed restore rolls back target-only JSON and persists maintenance until an explicit successful retry', async () => {
  seedVm()
  const targetOnly = path.join(configDir, 'target-only.json')
  const currentOnly = path.join(configDir, 'current-only.json')
  fs.writeFileSync(targetOnly, '{}')
  const rec = await svc.createBackup()
  fs.rmSync(targetOnly)
  fs.writeFileSync(currentOnly, '{}')
  let calls = 0
  svc.onRestored(async () => {
    if (++calls === 1) throw new Error('first rebind failed')
  })
  await assert.rejects(svc.restoreBackup(rec.id), /first rebind failed/)
  assert.equal(fs.existsSync(targetOnly), false)
  assert.equal(fs.existsSync(currentOnly), true)
  assert.equal(fs.existsSync(svc.maintenanceFile), true)
  assert.equal(svc.isMaintaining, true)
  await svc.restoreBackup(rec.id)
  assert.equal(fs.existsSync(svc.maintenanceFile), false)
  assert.equal(svc.isMaintaining, false)
  assert.equal(fs.existsSync(targetOnly), true)
  assert.equal(fs.existsSync(currentOnly), false)
})
