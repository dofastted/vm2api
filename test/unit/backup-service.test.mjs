import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { openDatabase, closeDatabase, getDb, getDbPath } from '../../src/lib/db/database.mjs'
import { BackupRepo } from '../../src/lib/db/repos/backup-repo.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { VmsRepo } from '../../src/lib/db/repos/vms-repo.mjs'
import {
  buildDockerPgUri,
  isPgVersionMismatchStderr,
  parsePgMajorVersion,
  queryPgServerMajorVersion,
  resolvePgTool,
  restorePgSnapshotJob,
  sha256File,
} from '../../src/lib/admin/backup-core.mjs'
import { BackupService, tarAvailable } from '../../src/lib/admin/backup-service.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { ensureRedaction, publishRedactionForTests, redactionStatus } from '../../src/lib/redaction/runtime.mjs'
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
  publishRedactionForTests(null)
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

test('cleanStaging removes unfinished backup staging dirs and nothing else', async () => {
  const tmp = path.join(dataDir, 'tmp')
  fs.mkdirSync(path.join(tmp, 'kin-backup-AbC123', 'db'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'kin-backup-AbC123', 'db', 'kin.db'), 'snapshot')
  fs.mkdirSync(path.join(tmp, 'kin-restore-XyZ789'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'kin-backup-notes.txt'), 'keep')
  const removed = await svc.cleanStaging()
  assert.deepEqual(removed, [path.join(tmp, 'kin-backup-AbC123')])
  assert.equal(fs.existsSync(path.join(tmp, 'kin-restore-XyZ789')), true)
  assert.equal(fs.existsSync(path.join(tmp, 'kin-backup-notes.txt')), true)
})

test('abortRunning stops a backup in progress and frees the service for the next run', {
  skip: !tarAvailable(),
}, async () => {
  const run = svc.createBackup({ kind: 'manual' })
  // Let the worker start before stopping it.
  while (!svc._worker) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(await svc.abortRunning(), true)
  await assert.rejects(run)
  assert.equal(svc._running, false)
  assert.equal(await svc.abortRunning(), false, 'nothing left to stop')
})

test('killChildArchivers stops a tar this process spawned and leaves other children alone', {
  skip: process.platform !== 'linux',
}, async () => {
  const { killChildArchivers } = await import('../../src/lib/admin/backup-service.mjs')
  const { spawn } = await import('node:child_process')
  const bin = path.join(root, 'fakebin')
  fs.mkdirSync(bin, { recursive: true })
  // A script, not a renamed /bin/sleep: on uutils coreutils (Ubuntu 26.04) sleep is a multicall
  // binary that picks the tool from its own file name, so a copy named tar exits at once. The
  // kernel names a script's process after the script, so comm is still "tar".
  const fake = path.join(bin, 'tar')
  fs.writeFileSync(fake, '#!/bin/sh\nread line\n', { mode: 0o755 })
  const tar = spawn(fake, [], { stdio: ['pipe', 'ignore', 'ignore'] })
  const other = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
  const errors = []
  for (const child of [tar, other]) child.once('error', (e) => errors.push(e.message))
  const exited = (child) => new Promise((resolve) => child.once('exit', (code, signal) => resolve(signal)))
  const tarExit = exited(tar)
  const comm = (pid) => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      return stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'))
    } catch {
      return null
    }
  }
  // Wait until the exec is visible instead of sleeping a fixed time.
  const deadline = Date.now() + 5000
  while (comm(tar.pid) !== 'tar' && Date.now() < deadline && !errors.length && tar.exitCode == null) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const children = () =>
    fs
      .readdirSync('/proc')
      .filter((e) => /^\d+$/.test(e))
      .map((pid) => {
        try {
          const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
          const close = stat.lastIndexOf(')')
          return {
            pid,
            comm: stat.slice(stat.indexOf('(') + 1, close),
            ppid: Number(stat.slice(close + 2).split(' ')[1]),
          }
        } catch {
          return null
        }
      })
      .filter((row) => row && row.ppid === process.pid)
  try {
    assert.deepEqual(errors, [], 'children spawned')
    assert.equal(tar.exitCode, null, `fake tar is alive (exit ${tar.exitCode}, comm ${comm(tar.pid)})`)
    const seen = children()
    assert.equal(killChildArchivers(), 1, `children of ${process.pid}: ${JSON.stringify(seen)}`)
    assert.equal(await tarExit, 'SIGTERM')
    assert.equal(other.exitCode, null)
    assert.equal(other.signalCode, null)
  } finally {
    tar.kill('SIGKILL')
    other.kill('SIGKILL')
  }
})

function registerSyntheticBackup({ id, fileName, content, kind = 'imported', includes = null }) {
  const backupDir = path.join(dataDir, 'backups')
  fs.mkdirSync(backupDir, { recursive: true })
  const fp = path.join(backupDir, fileName)
  fs.writeFileSync(fp, content)
  return new BackupRepo(getDb()).insert({
    id,
    created_at: new Date().toISOString(),
    kind,
    status: 'ok',
    file_path: fp,
    file_name: fileName,
    size_bytes: fs.statSync(fp).size,
    sha256: sha256File(fp),
    db_bytes: fs.statSync(fp).size,
    includes,
    error: null,
    note: null,
  })
}

function buildTarArchive(entries) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-bak-stage-'))
  const out = path.join(stage, '..', `archive-${Date.now()}-${Math.random().toString(16).slice(2)}.tar.gz`)
  try {
    for (const [relPath, buf] of Object.entries(entries)) {
      const dest = path.join(stage, relPath)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, buf)
    }
    const r = spawnSync('tar', ['-czf', out, '-C', stage, '.'], { stdio: 'pipe' })
    assert.equal(r.status, 0, `tar failed: ${String(r.stderr || '')}`)
    return fs.readFileSync(out)
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
    fs.rmSync(out, { force: true })
  }
}

function listRestoreTmpDirs() {
  const tmpBase = path.join(dataDir, 'tmp')
  if (!fs.existsSync(tmpBase)) return []
  return fs.readdirSync(tmpBase).filter((name) => name.startsWith('kin-restore-'))
}

test('P2-14: SQLite mode preflight rejects PG backups before pre_restore and keeps kin.db intact', async () => {
  new SettingsRepo(getDb()).set('sqlite_sentinel', 'intact')
  const dbPath = getDbPath()
  const originalDbPrefix = fs.readFileSync(dbPath).subarray(0, 16)

  let preRestoreCalls = 0
  const origCreateBackup = svc.createBackup.bind(svc)
  svc.createBackup = async (opts) => {
    if (opts?.kind === 'pre_restore') preRestoreCalls += 1
    return origCreateBackup(opts)
  }

  // 1. Standalone .pg.ndjson.gz (must NOT be gunzipped over kin.db!)
  const ndjsonGz = zlib.gzipSync(Buffer.from('{"type":"meta","engine":"postgres","tables":[]}\n', 'utf8'))
  const recNdjson = registerSyntheticBackup({
    id: 'bak_pg_ndjson',
    fileName: 'kin-backup-2026-11-26.pg.ndjson.gz',
    content: ndjsonGz,
    includes: null,
  })
  await assert.rejects(svc.restoreBackup(recNdjson.id), (err) => {
    assert.equal(err.code, 'backup_incompatible')
    return true
  })

  // 2. Standalone .pgdump
  const recPgdump = registerSyntheticBackup({
    id: 'bak_pg_dump',
    fileName: 'kin-backup-2026-11-26.pgdump',
    content: Buffer.from('PGDMP-fake-custom-dump', 'utf8'),
    includes: null,
  })
  await assert.rejects(svc.restoreBackup(recPgdump.id), (err) => {
    assert.equal(err.code, 'backup_incompatible')
    return true
  })

  // 3. PG .tar.gz with includes=null (orphan archive containing only db/kin.pgdump)
  const pgDumpBytes = Buffer.from('PGDMP-inside-tar', 'utf8')
  const pgTarBuf = buildTarArchive({
    'db/kin.pgdump': pgDumpBytes,
    'manifest.json': JSON.stringify({ version: 2, engine: 'postgres', format: 'pg_dump_custom' }),
  })
  const recPgTar = registerSyntheticBackup({
    id: 'bak_pg_tar_orphan',
    fileName: 'kin-backup-2026-11-26-pg.tar.gz',
    content: pgTarBuf,
    includes: null,
  })
  await assert.rejects(svc.restoreBackup(recPgTar.id), (err) => {
    assert.equal(err.code, 'backup_incompatible')
    return true
  })

  // 4. PG .tar.gz with declared includes.engine='postgres'
  const recPgDeclared = registerSyntheticBackup({
    id: 'bak_pg_tar_declared',
    fileName: 'kin-backup-2026-11-26-pg-declared.tar.gz',
    content: pgTarBuf,
    kind: 'manual',
    includes: { db: true, engine: 'postgres', format: 'pg_dump_custom', vms: 0, config: 0 },
  })
  await assert.rejects(svc.restoreBackup(recPgDeclared.id), (err) => {
    assert.equal(err.code, 'backup_incompatible')
    return true
  })

  assert.equal(preRestoreCalls, 0, 'must not create pre_restore before preflight passes')
  assert.equal(svc.list().filter((r) => r.kind === 'pre_restore').length, 0)
  assert.equal(svc.isRestoring, false)
  assert.deepEqual(listRestoreTmpDirs(), [], 'preflight temp dirs must be cleaned up')
  assert.equal(new SettingsRepo(getDb()).get('sqlite_sentinel'), 'intact')
  assert.deepEqual(fs.readFileSync(dbPath).subarray(0, 16), originalDbPrefix)
})

test('P2-14: PostgreSQL mode preflight rejects SQLite backups, corrupt inner snapshots, and missing pg_restore before pre_restore', async () => {
  seedVm()
  const sqliteTar = await svc.createBackup({ kind: 'manual' })
  const sqliteDbGz = registerSyntheticBackup({
    id: 'bak_sqlite_dbgz',
    fileName: 'kin-backup-2026-11-26.db.gz',
    content: zlib.gzipSync(fs.readFileSync(getDbPath())),
    includes: null,
  })
  const standalonePgDump = registerSyntheticBackup({
    id: 'bak_pg_standalone',
    fileName: 'kin-backup-2026-11-26-standalone.pgdump',
    content: Buffer.from('PGDMP-standalone', 'utf8'),
    kind: 'manual',
    includes: { db: true, engine: 'postgres', format: 'pg_dump_custom', vms: 0, config: 0 },
  })

  const innerPgDump = Buffer.from('PGDMP-inside-archive', 'utf8')
  const innerPgDumpPath = path.join(root, 'inner.pgdump')
  fs.writeFileSync(innerPgDumpPath, innerPgDump)
  const innerPgDumpSha = sha256File(innerPgDumpPath)
  const validPgTar = registerSyntheticBackup({
    id: 'bak_pg_tar_valid',
    fileName: 'kin-backup-2026-11-26-valid-pg.tar.gz',
    content: buildTarArchive({
      'db/kin.pgdump': innerPgDump,
      'manifest.json': JSON.stringify({
        version: 2,
        engine: 'postgres',
        format: 'pg_dump_custom',
        sha256s: { 'db/kin.pgdump': innerPgDumpSha },
      }),
    }),
    kind: 'manual',
    includes: { db: true, engine: 'postgres', format: 'pg_dump_custom', vms: 0, config: 0 },
  })
  const corruptInnerPgTar = registerSyntheticBackup({
    id: 'bak_pg_tar_corrupt_inner',
    fileName: 'kin-backup-2026-11-26-corrupt-pg.tar.gz',
    content: buildTarArchive({
      'db/kin.pgdump': innerPgDump,
      'manifest.json': JSON.stringify({
        version: 2,
        engine: 'postgres',
        format: 'pg_dump_custom',
        sha256s: { 'db/kin.pgdump': '0'.repeat(64) },
      }),
    }),
    kind: 'manual',
    includes: { db: true, engine: 'postgres', format: 'pg_dump_custom', vms: 0, config: 0 },
  })

  let preRestoreCalls = 0
  const pgSvc = new BackupService({
    dataDir,
    projectRoot: root,
    configDir,
    getEngine: () => 'postgres',
    isPgRestoreAvailable: async () => false,
  })
  pgSvc.createBackup = async () => {
    preRestoreCalls += 1
    throw new Error('pre_restore should not have been invoked')
  }

  // SQLite tar.gz rejected
  await assert.rejects(pgSvc.restoreBackup(sqliteTar.id), (err) => {
    assert.equal(err.code, 'backup_incompatible')
    return true
  })
  // Standalone SQLite .db.gz rejected
  await assert.rejects(pgSvc.restoreBackup(sqliteDbGz.id), (err) => {
    assert.equal(err.code, 'backup_incompatible')
    return true
  })
  // Standalone .pgdump rejected when pg_restore binary is missing
  await assert.rejects(pgSvc.restoreBackup(standalonePgDump.id), (err) => {
    assert.equal(err.code, 'pg_restore_missing')
    return true
  })
  // .tar.gz with db/kin.pgdump rejected when pg_restore binary is missing
  await assert.rejects(pgSvc.restoreBackup(validPgTar.id), (err) => {
    assert.equal(err.code, 'pg_restore_missing')
    return true
  })
  // Corrupt inner snapshot sha256 rejected as backup_corrupt before pre_restore
  await assert.rejects(pgSvc.restoreBackup(corruptInnerPgTar.id), (err) => {
    assert.equal(err.code, 'backup_corrupt')
    return true
  })

  assert.equal(preRestoreCalls, 0, 'none of the failing preflight cases may create a pre_restore backup')
  assert.equal(pgSvc.isRestoring, false)
  assert.deepEqual(listRestoreTmpDirs(), [], 'all preflight staging dirs must be removed')

  // When preflight succeeds but createBackup(pre_restore) subsequently fails, staging tmp is still cleaned up.
  const pgSvcAfterPreflightFail = new BackupService({
    dataDir,
    projectRoot: root,
    configDir,
    getEngine: () => 'postgres',
    isPgRestoreAvailable: async () => true,
  })
  pgSvcAfterPreflightFail.createBackup = async () => {
    assert.equal(listRestoreTmpDirs().length, 1, 'preflight extracted archive before pre_restore')
    throw new Error('pre_restore disk full')
  }
  await assert.rejects(pgSvcAfterPreflightFail.restoreBackup(validPgTar.id), /pre_restore disk full/)
  assert.equal(pgSvcAfterPreflightFail.isRestoring, false)
  assert.deepEqual(listRestoreTmpDirs(), [], 'finally must clean up preflight tmp dir on later errors')
})

test('P2-14: restoreBackup awaits async onRestored and resyncs redaction runtime', async () => {
  seedVm()
  fs.writeFileSync(
    path.join(configDir, 'routing.json'),
    JSON.stringify({ sticky: { enabled: true }, redaction: { enabled: false, secrets: true, personal: false } }),
  )
  const rec = await svc.createBackup({ kind: 'manual' })

  // Simulate redaction running after the backup was taken.
  const fakeChild = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    killed: false,
    kill() {
      this.killed = true
      this.signalCode = 'SIGTERM'
      setImmediate(() => this.emit('close', null, 'SIGTERM'))
    },
  })
  publishRedactionForTests({
    enabled: true,
    ready: true,
    policy: { enabled: true, secrets: true, personal: false, words: [], rules: [] },
    client: {},
    child: fakeChild,
    error: null,
  })
  assert.equal(redactionStatus().enabled, true)

  let asyncHookFinished = false
  svc.onRestored(async () => {
    const restoredRouting = JSON.parse(fs.readFileSync(path.join(configDir, 'routing.json'), 'utf8'))
    await ensureRedaction(restoredRouting, { projectRoot: root })
    asyncHookFinished = true
  })

  const out = await svc.restoreBackup(rec.id)
  assert.equal(out.ok, true)
  assert.equal(asyncHookFinished, true, 'restoreBackup must await async onRestored callback')
  assert.equal(fakeChild.killed, true, 'old kin-redact child must be stopped when restored config disables redaction')
  assert.deepEqual(redactionStatus(), { enabled: false, ready: true, error: null })

  // Async onRestored rejection must reject restoreBackup and clear isRestoring.
  svc.onRestored(async () => {
    await Promise.resolve()
    throw new Error('async rebind failed')
  })
  await assert.rejects(svc.restoreBackup(rec.id), /async rebind failed/)
  assert.equal(svc.isRestoring, false)
})

test('resolvePgTool handles major-version mismatch across host binary, PGDG paths, and local Docker container', async () => {
  assert.equal(parsePgMajorVersion('pg_dump (PostgreSQL) 14.24 (Ubuntu 14.24-0ubuntu0.22.04.1)'), 14)
  assert.equal(parsePgMajorVersion('pg_dump (PostgreSQL) 18.6'), 18)
  assert.equal(parsePgMajorVersion('unknown'), null)
  assert.equal(isPgVersionMismatchStderr('pg_dump: error: aborting because of server version mismatch'), true)
  assert.equal(isPgVersionMismatchStderr('connection refused'), false)

  const serverMajor = await queryPgServerMajorVersion({
    query: async () => ({ rows: [{ server_version_num: '180006' }] }),
  })
  assert.equal(serverMajor, 18)

  const dockerUri = buildDockerPgUri('postgresql://vm2api:s3cr%40t@127.0.0.1:5433/vm2api')
  assert.equal(dockerUri.uri, 'postgresql://vm2api@127.0.0.1:5432/vm2api')
  assert.equal(dockerUri.env.PGPASSWORD, 's3cr@t')

  // 1. Host pg_dump is 14 vs server 18, PGDG 18 is installed -> picks /usr/lib/postgresql/18/bin/pg_dump
  const pgdgPicked = resolvePgTool('pg_dump', {
    serverMajor: 18,
    connectionString: 'postgresql://vm2api:pw@127.0.0.1:5432/vm2api',
    env: {},
    readdirImpl: () => ['14', '18'],
    spawnImpl: (cmd) => {
      if (cmd === 'pg_dump') return { status: 0, stdout: 'pg_dump (PostgreSQL) 14.24\n' }
      if (cmd === '/usr/lib/postgresql/18/bin/pg_dump') return { status: 0, stdout: 'pg_dump (PostgreSQL) 18.6\n' }
      return { status: 1, stdout: '' }
    },
  })
  assert.deepEqual(pgdgPicked, { mode: 'binary', bin: '/usr/lib/postgresql/18/bin/pg_dump', major: 18 })

  // 2. Host pg_dump is 14 vs server 18, no PGDG 18, local loopback DSN -> picks docker exec vm2api-postgres
  const dockerPicked = resolvePgTool('pg_dump', {
    serverMajor: 18,
    connectionString: 'postgresql://vm2api:pw@127.0.0.1:5432/vm2api',
    env: {},
    readdirImpl: () => ['14'],
    spawnImpl: (cmd, args) => {
      if (cmd === 'pg_dump') return { status: 0, stdout: 'pg_dump (PostgreSQL) 14.24\n' }
      if (cmd === 'docker' && args[0] === 'exec' && args[1] === 'vm2api-postgres' && args[2] === 'pg_dump') {
        return { status: 0, stdout: 'pg_dump (PostgreSQL) 18.6\n' }
      }
      return { status: 1, stdout: '' }
    },
  })
  assert.deepEqual(dockerPicked, { mode: 'docker', container: 'vm2api-postgres', tool: 'pg_dump', major: 18 })

  // 3. Remote non-loopback DSN with only host pg_dump 14 vs server 18 -> returns null (triggers pure-JS fallback)
  let dockerProbedForRemote = false
  const remoteMissed = resolvePgTool('pg_dump', {
    serverMajor: 18,
    connectionString: 'postgresql://vm2api:pw@pg.internal.example:5432/vm2api',
    env: {},
    readdirImpl: () => ['14'],
    spawnImpl: (cmd) => {
      if (cmd === 'docker') dockerProbedForRemote = true
      if (cmd === 'pg_dump') return { status: 0, stdout: 'pg_dump (PostgreSQL) 14.24\n' }
      return { status: 1, stdout: '' }
    },
  })
  assert.equal(remoteMissed, null)
  assert.equal(dockerProbedForRemote, false)

  // 4. restorePgSnapshotJob uses docker exec -i -e PGPASSWORD without leaking secret in argv
  const dumpFile = path.join(root, 'sample.pgdump')
  fs.writeFileSync(dumpFile, Buffer.from('PGDMP-test', 'utf8'))
  const calls = []
  await restorePgSnapshotJob({
    pool: {
      query: async (sql) =>
        sql.includes('server_version_num') ? { rows: [{ server_version_num: '180006' }] } : { rows: [{ s: 'public' }] },
    },
    connectionString: 'postgresql://vm2api:topsecret@127.0.0.1:5432/vm2api',
    dbFile: dumpFile,
    resolveToolImpl: () => ({ mode: 'docker', container: 'vm2api-postgres', tool: 'pg_restore', major: 18 }),
    spawnImpl: (cmd, args, opts) => {
      calls.push({ cmd, args, env: opts.env, stdinType: typeof opts.stdio[0] })
      return { status: 0, stderr: '' }
    },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].cmd, 'docker')
  assert.equal(calls[0].args.includes('topsecret'), false, 'password must never appear in docker argv')
  assert.equal(calls[0].args.includes('-e'), true)
  assert.equal(calls[0].args.includes('PGPASSWORD'), true)
  assert.equal(calls[0].env.PGPASSWORD, 'topsecret')
  assert.equal(calls[0].stdinType, 'number', 'dbFile must be streamed via file descriptor')

  // 5. restorePgSnapshotJob rejects with pg_restore_missing when no compatible version exists
  await assert.rejects(
    restorePgSnapshotJob({
      pool: { query: async () => ({ rows: [{ server_version_num: '180006' }] }) },
      connectionString: 'postgresql://vm2api:topsecret@remote.example:5432/vm2api',
      dbFile: dumpFile,
      resolveToolImpl: () => null,
    }),
    (err) => {
      assert.equal(err.code, 'pg_restore_missing')
      assert.match(err.message, />= 18/)
      return true
    },
  )
})
