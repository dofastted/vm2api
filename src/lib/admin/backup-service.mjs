/** PostgreSQL backup scheduling, write maintenance and transactional restore. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { getDb, applyMigrations, quoteIdentifier } from '../db/database.mjs'
import { sha256FileAsync, runPgTool, runProcess, extractArchiveMember } from './backup-core.mjs'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { BackupRepo } from '../db/repos/backup-repo.mjs'
import { invalidateReadCache } from '../vm/vm-file.mjs'

// tarAvailability / sha256File / the runnable pipeline live in backup-core.mjs;
// keep the historical export surface for tests and callers.
export { tarAvailable } from './backup-core.mjs'

const SCHEDULE_KEY = 'backup_schedule'

export const DEFAULT_SCHEDULE = {
  enabled: true,
  interval_hours: 24,
  retention: 7,
}

export class BackupService {
  constructor({ dataDir, projectRoot, configDir, backupDir, tmpDir, checkIntervalMs = 10 * 60_000 } = {}) {
    this.dataDir = dataDir
    this.projectRoot = projectRoot
    this.configDir = configDir || null
    this.backupDir = backupDir || path.join(dataDir, 'backups')
    this.tmpDir = tmpDir || path.join(dataDir, 'tmp')
    this.checkIntervalMs = checkIntervalMs
    this.maintenanceFile = path.join(dataDir, 'restore-maintenance.json')
    this.isRestoring = fs.existsSync(this.maintenanceFile)
    this.isMaintaining = this.isRestoring
    this._restoreRunning = false
    this._maintenance = null
    this._running = false
    this._schedulerGeneration = 0
    this._scheduledChecks = new Set()
    this._timer = null
    this._bootTimer = null
    this._rebindStores = null // set via onRestored()
  }

  _repo() {
    return new BackupRepo(getDb())
  }
  _settings() {
    return new SettingsRepo(getDb())
  }

  /** Staging dir on the data volume — the DB snapshot can be several GB. */
  _mkdtemp(prefix) {
    const base = process.env.KIN_BACKUP_TMPDIR || this.tmpDir
    fs.mkdirSync(base, { recursive: true, mode: 0o700 })
    try {
      fs.chmodSync(base, 0o700)
    } catch {}
    return fs.mkdtempSync(path.join(base, prefix))
  }

  /** Register the callback that re-binds stores to the new DB after restore. */
  onRestored(fn) {
    this._rebindStores = typeof fn === 'function' ? fn : null
  }

  /** The server pauses new writes, drains in-flight work, and resumes only after success. */
  onMaintenance(fn) {
    this._maintenance = typeof fn === 'function' ? fn : null
  }

  async _enterMaintenance(reason) {
    if (this.isMaintaining) return false
    this.isMaintaining = true
    await this._maintenance?.(true, reason)
    return true
  }

  async _leaveMaintenance(reason) {
    await this._maintenance?.(false, reason)
    this.isMaintaining = false
  }

  // ---------- schedule config ----------

  async getSchedule() {
    let cfg = { ...DEFAULT_SCHEDULE, ...((await this._settings().get(SCHEDULE_KEY, {})) || {}) }
    if (process.env.KIN_BACKUP_DISABLED === '1') cfg.enabled = false
    if (process.env.KIN_BACKUP_INTERVAL_HOURS) {
      const n = Number(process.env.KIN_BACKUP_INTERVAL_HOURS)
      if (Number.isFinite(n) && n > 0) cfg.interval_hours = n
    }
    if (process.env.KIN_BACKUP_RETENTION) {
      const n = Number(process.env.KIN_BACKUP_RETENTION)
      if (Number.isFinite(n) && n > 0) cfg.retention = n
    }
    return cfg
  }

  async updateSchedule(patch = {}) {
    const cur = { ...DEFAULT_SCHEDULE, ...((await this._settings().get(SCHEDULE_KEY, {})) || {}) }
    if (patch.enabled != null) cur.enabled = !!patch.enabled
    if (patch.interval_hours != null) {
      const n = Number(patch.interval_hours)
      if (!Number.isFinite(n) || n < 1 || n > 24 * 30) {
        throw Object.assign(new Error('interval_hours must be 1..720'), { code: 'invalid_interval' })
      }
      cur.interval_hours = n
    }
    if (patch.retention != null) {
      const n = Math.floor(Number(patch.retention))
      if (!Number.isFinite(n) || n < 1 || n > 100) {
        throw Object.assign(new Error('retention must be 1..100'), { code: 'invalid_retention' })
      }
      cur.retention = n
    }
    await this._settings().set(SCHEDULE_KEY, cur)
    return this.getSchedule()
  }

  async nextAutoAt() {
    const cfg = await this.getSchedule()
    if (!cfg.enabled) return null
    const last = await this._repo().lastSuccessful({})
    const base = last ? Date.parse(last.created_at) : 0
    return new Date(Math.max(Date.now(), base + cfg.interval_hours * 3600_000)).toISOString()
  }

  // ---------- create ----------

  async flush() {
    await Promise.all([...this._scheduledChecks, this._pendingBackup, this._pendingRestore].filter(Boolean))
  }

  async createBackup(options = {}) {
    if (this._restoreRunning && options.kind !== 'pre_restore')
      throw Object.assign(new Error('restore already in progress'), { code: 'restore_in_progress' })
    if (this._running) throw Object.assign(new Error('backup already in progress'), { code: 'backup_in_progress' })
    const pending = this._createBackup(options)
    this._pendingBackup = pending
    try {
      return await pending
    } finally {
      if (this._pendingBackup === pending) this._pendingBackup = null
    }
  }

  /** Export a PostgreSQL snapshot while files are frozen, then dump in a worker. */
  async _createBackup({ kind = 'manual', note = null } = {}) {
    if (this._running) throw Object.assign(new Error('backup already in progress'), { code: 'backup_in_progress' })
    this._running = true
    const id = 'bak_' + crypto.randomBytes(6).toString('hex')
    const createdAt = new Date().toISOString()
    let client
    let entered = false
    try {
      entered = await this._enterMaintenance(kind === 'pre_restore' ? 'restore' : 'backup')
      const db = getDb()
      client = await db.pool.connect()
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const snapshot = (await client.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot
      const version = (await client.query('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1'))
        .rows[0]
      const rec = await this._runBackupWorker(
        { id, createdAt, kind, note },
        {
          connectionString: db.connectionString,
          schema: db.schema,
          snapshot,
          schemaVersion: version?.version || null,
        },
        async () => {
          if (entered) {
            await this._leaveMaintenance('backup')
            entered = false
          }
        },
      )
      await client.query('COMMIT')
      client.release()
      client = null
      const stored = await this._repo().insert(rec)
      const retention = (await this.getSchedule()).retention
      for (const old of [
        ...(await this._repo().beyondRetention(retention)),
        ...(await this._repo().preRestoreBeyond(3)),
      ]) {
        if (old.file_path) fs.rmSync(old.file_path, { force: true })
        await this._repo().remove(old.id)
      }
      return stored
    } catch (error) {
      try {
        if (!(await this._repo().get(id)))
          await this._repo().insert({
            id,
            created_at: createdAt,
            kind,
            status: 'failed',
            error: String(error.message || error).slice(0, 500),
            note,
          })
      } catch {}
      throw error
    } finally {
      if (client) {
        try {
          await client.query('ROLLBACK')
        } finally {
          client.release()
        }
      }
      this._running = false
      if (entered) await this._leaveMaintenance('backup')
    }
  }

  _runBackupWorker(job, database, onFilesCopied) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./backup-worker.mjs', import.meta.url), {
        workerData: {
          ctx: {
            projectRoot: this.projectRoot,
            configDir: this.configDir,
            backupDir: this.backupDir,
            tmpDir: this.tmpDir,
            ...database,
          },
          job,
        },
      })
      let settled = false
      let resumed = Promise.resolve()
      const finish = (fn, arg) => {
        if (settled) return
        settled = true
        fn(arg)
      }
      worker.on('message', (msg) => {
        if (msg.type === 'files-copied') {
          resumed = onFilesCopied()
          // Keep the exported snapshot alive until the worker finishes even when resume failed.
          resumed.catch(() => {})
          return
        }
        if (msg.ok)
          resumed.then(
            () => finish(resolve, msg.rec),
            (error) => finish(reject, error),
          )
        else
          finish(
            reject,
            Object.assign(new Error(msg.error?.message || 'backup failed'), {
              code: msg.error?.code || 'backup_failed',
            }),
          )
      })
      worker.once('error', (error) => finish(reject, error))
      worker.once('exit', (code) => {
        if (code !== 0) finish(reject, new Error(`backup worker exited with code ${code}`))
      })
    })
  }

  // ---------- list / delete ----------

  async list({ limit = 100 } = {}) {
    return (await this._repo().list({ limit })).map((r) => ({
      ...r,
      file_exists: !!(r.file_path && fs.existsSync(r.file_path)),
    }))
  }

  async get(id) {
    return this._repo().get(id)
  }

  async remove(id) {
    const rec = await this._repo().get(id)
    if (!rec) return false
    try {
      if (rec.file_path && fs.existsSync(rec.file_path)) fs.rmSync(rec.file_path, { force: true })
    } catch {}
    return this._repo().remove(id)
  }

  // ---------- restore ----------

  async _extractArchive(rec) {
    if (!rec.file_name?.endsWith('.tar.gz'))
      throw Object.assign(new Error('convert the SQLite backup with the offline import tool before restoring'), {
        code: 'legacy_backup_conversion_required',
      })
    const tmp = this._mkdtemp('kin-restore-')
    try {
      const entries = (await runProcess('tar', ['-tzf', rec.file_path])).split('\n').filter(Boolean)
      const files = new Set()
      const members = new Set()
      for (const entry of entries) {
        const name = entry.replace(/^\.\//, '')
        if (!name || name === '.') continue
        if (members.has(name)) throw new Error('invalid or duplicate backup archive path')
        members.add(name)
        if (name === 'db/kin.db')
          throw Object.assign(new Error('convert the SQLite backup with the offline import tool before restoring'), {
            code: 'legacy_backup_conversion_required',
          })
        if (/^(db|vms|config)\/$/.test(name)) {
          fs.mkdirSync(path.join(tmp, name), { recursive: true, mode: 0o700 })
          continue
        }
        if (!/^(manifest\.json|db\/postgres\.dump|(vms|config)\/[^/]+\.json)$/.test(name) || files.has(name)) {
          throw new Error('invalid or duplicate backup archive path')
        }
        files.add(name)
        await extractArchiveMember(rec.file_path, entry, path.join(tmp, name))
      }
      const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'))
      if (manifest.version !== 2 || manifest.engine !== 'postgresql')
        throw Object.assign(new Error('convert the SQLite backup with the offline import tool before restoring'), {
          code: 'legacy_backup_conversion_required',
        })
      if (manifest.schema !== getDb().schema) throw new Error('backup schema does not match this application')
      if (!manifest.sha256s?.['db/postgres.dump']) throw new Error('backup database checksum is missing')
      for (const [directory, required] of [
        ['vms', !!this.projectRoot],
        ['config', !!this.configDir],
      ]) {
        const count = [...files].filter((name) => name.startsWith(`${directory}/`)).length
        if (manifest.includes?.[directory] !== count || (required && !fs.existsSync(path.join(tmp, directory)))) {
          throw new Error('backup file snapshot is incomplete')
        }
      }
      for (const name of files) {
        if (name !== 'manifest.json' && !manifest.sha256s[name]) throw new Error('backup contains an unchecked file')
      }
      for (const [name, digest] of Object.entries(manifest.sha256s)) {
        if (
          path.isAbsolute(name) ||
          name.split('/').includes('..') ||
          (await sha256FileAsync(path.join(tmp, name))) !== digest
        ) {
          throw Object.assign(new Error('backup file checksum mismatch'), { code: 'backup_corrupt' })
        }
      }
      const dump = path.join(tmp, 'db', 'postgres.dump')
      const listing = await runPgTool('pg_restore', ['--list', dump], getDb().connectionString)
      const schema = getDb().schema
      const tables = new Set()
      const allowed =
        /^(TABLE DATA|SEQUENCE OWNED BY|SEQUENCE SET|FK CONSTRAINT|TABLE|SEQUENCE|DEFAULT|CONSTRAINT|INDEX|SCHEMA|COMMENT) (\S+) (.+)$/
      for (const line of listing.split('\n')) {
        if (!line || line.startsWith(';')) continue
        const entry = line.replace(/^\d+; \d+ \d+ /, '')
        if (/^(ENCODING - ENCODING|STDSTRINGS - STDSTRINGS|SEARCHPATH - SEARCHPATH)( |$)/.test(entry)) continue
        if (entry.startsWith(`COMMENT - SCHEMA ${schema} `)) continue
        if (entry.startsWith(`FUNCTION ${schema} ascii_fold(text) `)) continue
        const item = entry.match(allowed)
        if (
          !item ||
          (item[1] === 'SCHEMA' ? item[2] !== '-' || !item[3].startsWith(`${schema} `) : item[2] !== schema)
        ) {
          throw new Error('backup contains objects outside the application schema allowlist')
        }
        if (item[1] === 'TABLE') tables.add(item[3].split(' ')[0])
      }
      return { tmp, dump, manifest, tables }
    } catch (error) {
      fs.rmSync(tmp, { recursive: true, force: true })
      throw error
    }
  }

  _restoreFiles(tmp) {
    if (this.projectRoot && fs.existsSync(path.join(tmp, 'vms'))) {
      const target = path.join(this.projectRoot, 'vms')
      fs.mkdirSync(target, { recursive: true })
      for (const name of fs.readdirSync(target)) {
        if (name.endsWith('.json') && !fs.lstatSync(path.join(target, name)).isDirectory())
          fs.rmSync(path.join(target, name), { force: true })
      }
      for (const name of fs.readdirSync(path.join(tmp, 'vms'))) {
        fs.copyFileSync(path.join(tmp, 'vms', name), path.join(target, name))
        fs.chmodSync(path.join(target, name), 0o600)
      }
    }
    if (this.configDir && fs.existsSync(path.join(tmp, 'config'))) {
      fs.mkdirSync(this.configDir, { recursive: true })
      for (const name of fs.readdirSync(this.configDir)) {
        if (name.endsWith('.json') && !fs.lstatSync(path.join(this.configDir, name)).isDirectory())
          fs.rmSync(path.join(this.configDir, name), { force: true })
      }
      for (const name of fs.readdirSync(path.join(tmp, 'config'))) {
        fs.copyFileSync(path.join(tmp, 'config', name), path.join(this.configDir, name))
        fs.chmodSync(path.join(this.configDir, name), 0o600)
      }
    }
    invalidateReadCache()
  }

  async _applyArchive(archive) {
    const db = getDb()
    // pg_restore --clean only removes objects present in the archive. Later
    // migrations can add tables (including login sessions) that must disappear
    // before restoring an older snapshot and reapplying those migrations.
    const tables = (
      await db.prepare('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename').all(db.schema)
    ).map(({ tablename }) => tablename)
    const extraTables = tables.filter((name) => !archive.tables.has(name))
    const tableName = (name) => `${quoteIdentifier(db.schema)}.${quoteIdentifier(name)}`
    const cleanup = path.join(archive.tmp, 'cleanup.sql')
    const restore = path.join(archive.tmp, 'restore.sql')
    fs.writeFileSync(
      cleanup,
      [
        tables.length ? `LOCK TABLE ${tables.map(tableName).join(', ')} IN ACCESS EXCLUSIVE MODE;` : '',
        `DO $$ BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_catalog.pg_inherits i
            JOIN pg_catalog.pg_class p ON p.oid=i.inhparent
            JOIN pg_catalog.pg_namespace pn ON pn.oid=p.relnamespace
            JOIN pg_catalog.pg_class c ON c.oid=i.inhrelid
            JOIN pg_catalog.pg_namespace cn ON cn.oid=c.relnamespace
            WHERE pn.nspname='${db.schema}' AND cn.nspname<>'${db.schema}'
          ) THEN
            RAISE EXCEPTION 'restore refuses cross-schema inheritance or partitions';
          END IF;
        END $$;`,
        extraTables.length ? `DROP TABLE ${extraTables.map(tableName).join(', ')};` : '',
      ].join('\n'),
      { mode: 0o600 },
    )
    fs.writeFileSync(restore, '', { mode: 0o600 })
    await runPgTool(
      'pg_restore',
      [
        '--clean',
        '--if-exists',
        '--no-owner',
        '--no-privileges',
        `--schema=${db.schema}`,
        '--file',
        restore,
        archive.dump,
      ],
      db.connectionString,
    )
    // Lock parents and descendants before checking: attaching or detaching a
    // partition must not race the check. RESTRICT alone still drops partitions
    // automatically, including ones outside this schema. All cleanup and restore
    // statements commit together; psql streams the potentially multi-GB SQL file.
    await runPgTool(
      'psql',
      ['--no-psqlrc', '--quiet', '--single-transaction', '--set=ON_ERROR_STOP=1', '--file', cleanup, '--file', restore],
      db.connectionString,
    )
    this._restoreFiles(archive.tmp)
    await applyMigrations(getDb())
  }

  async restoreBackup(id) {
    if (this._restoreRunning || this._running)
      throw Object.assign(new Error('restore already in progress'), { code: 'restore_in_progress' })
    const pending = this._restoreBackup(id)
    this._pendingRestore = pending
    try {
      return await pending
    } finally {
      if (this._pendingRestore === pending) this._pendingRestore = null
    }
  }

  /** Failure keeps maintenance enabled. The restore endpoint may explicitly retry. */
  async _restoreBackup(id) {
    if (this._restoreRunning || this._running)
      throw Object.assign(new Error('restore already in progress'), { code: 'restore_in_progress' })
    this._restoreRunning = true
    let archive
    let previous
    let pre
    let changed = false
    let maintenanceStarted = false
    try {
      const rec = await this._repo().get(id)
      if (!rec) throw Object.assign(new Error('backup not found'), { code: 'backup_not_found' })
      if (rec.status !== 'ok') throw Object.assign(new Error('backup is not restorable'), { code: 'backup_not_ok' })
      if (!rec.file_path || !fs.existsSync(rec.file_path))
        throw Object.assign(new Error('backup file missing'), { code: 'backup_file_missing' })
      if (rec.sha256 && (await sha256FileAsync(rec.file_path)) !== rec.sha256)
        throw Object.assign(new Error('backup archive sha256 mismatch'), { code: 'backup_corrupt' })
      archive = await this._extractArchive(rec)
      fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
      fs.writeFileSync(this.maintenanceFile, JSON.stringify({ backup_id: id, started_at: new Date().toISOString() }), {
        mode: 0o600,
      })
      maintenanceStarted = true
      this.isRestoring = true
      await this._enterMaintenance('restore')
      pre = await this.createBackup({ kind: 'pre_restore', note: `before restore of ${id}` })
      previous = await this._extractArchive(pre)
      changed = true
      await getDb().withMaintenance(async () => {
        await this._applyArchive(archive)
        await this._registerOrphanArchives([pre, rec])
        await this._rebindStores?.(getDb())
      })
      await this._leaveMaintenance('restore')
      fs.rmSync(this.maintenanceFile)
      this.isRestoring = false
      return { ok: true, restored: id, pre_restore: pre.id }
    } catch (error) {
      if (maintenanceStarted) {
        this.isRestoring = true
        this.isMaintaining = true
      }
      if (changed && previous) {
        try {
          await getDb().withMaintenance(async () => {
            await this._applyArchive(previous)
            await this._registerOrphanArchives([pre])
            await this._rebindStores?.(getDb())
          })
        } catch {
          throw Object.assign(new Error('restore and rollback failed; maintenance remains enabled'), {
            code: 'restore_rollback_failed',
          })
        }
      }
      throw error
    } finally {
      this._restoreRunning = false
      for (const item of [archive, previous]) if (item) fs.rmSync(item.tmp, { recursive: true, force: true })
    }
  }

  /**
   * Insert ledger rows for archive files that exist on disk but have no
   * record in the (freshly restored) DB. `known` records are inserted
   * verbatim; remaining orphans get kind='imported'.
   */
  async _registerOrphanArchives(known = []) {
    const repo = this._repo()
    const existing = new Set((await repo.list({ limit: 500 })).map((r) => r.file_name))
    for (const rec of known) {
      if (rec?.file_name && !existing.has(rec.file_name) && rec.file_path && fs.existsSync(rec.file_path)) {
        await repo.insert(rec)
        existing.add(rec.file_name)
      }
    }
    if (!fs.existsSync(this.backupDir)) return
    for (const f of fs.readdirSync(this.backupDir)) {
      if (!/^kin-backup-.*\.(tar\.gz|db\.gz)$/.test(f) || existing.has(f)) continue
      const fp = path.join(this.backupDir, f)
      try {
        const st = fs.statSync(fp)
        await repo.insert({
          id: 'bak_' + crypto.randomBytes(6).toString('hex'),
          created_at: st.mtime.toISOString(),
          kind: 'imported',
          status: 'ok',
          file_path: fp,
          file_name: f,
          size_bytes: st.size,
          sha256: await sha256FileAsync(fp),
          db_bytes: null,
          includes: null,
          error: null,
          note: 're-registered from disk after restore',
        })
        existing.add(f)
      } catch {}
    }
  }

  // ---------- scheduler ----------

  /** Auto-backup checker: every checkIntervalMs + a catch-up run at boot. */
  startScheduler() {
    this.stopScheduler()
    const generation = this._schedulerGeneration
    const check = () => {
      if (generation !== this._schedulerGeneration) return
      const pending = (async () => {
        try {
          if ((await this.shouldRunScheduled()) && generation === this._schedulerGeneration) {
            const rec = await this.createBackup({ kind: 'scheduled' })
            console.log(`[backup] scheduled backup completed (${Math.round((rec.size_bytes || 0) / 1048576)} MiB)`)
          }
        } catch (e) {
          console.warn('[backup] scheduled backup failed:', String(e.message || e))
        }
      })()
      this._scheduledChecks.add(pending)
      pending.finally(() => this._scheduledChecks.delete(pending))
      return pending
    }
    this._timer = setInterval(check, this.checkIntervalMs)
    if (typeof this._timer.unref === 'function') this._timer.unref()
    // boot catch-up (delayed so startup isn't blocked)
    this._bootTimer = setTimeout(check, 5_000)
    if (typeof this._bootTimer.unref === 'function') this._bootTimer.unref()
  }

  async shouldRunScheduled(now = Date.now()) {
    const cfg = await this.getSchedule()
    if (!cfg.enabled || this._running || this._restoreRunning || this.isMaintaining) return false
    const last = await this._repo().lastSuccessful({})
    if (!last) return true
    return now - Date.parse(last.created_at) >= cfg.interval_hours * 3600_000
  }

  stopScheduler() {
    this._schedulerGeneration += 1
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    if (this._bootTimer) {
      clearTimeout(this._bootTimer)
      this._bootTimer = null
    }
  }
}
