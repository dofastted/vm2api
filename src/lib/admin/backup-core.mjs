/**
 * Backup pipeline primitives (supports both SQLite and PostgreSQL).
 *
 * SQLite mode: VACUUM INTO online-consistent snapshot + tar.gz.
 * PostgreSQL mode: `pg_dump --format=custom` (preferred) with a streaming
 * pure-JS NDJSON.gz logical snapshot fallback when `pg_dump` is not installed.
 *
 * Always runs in `backup-worker.mjs` off the main event loop.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import readline from 'node:readline'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { getDb, getPgConfig, getPgPool, vacuumInto } from '../db/database.mjs'
import { buildPgConnectionString } from '../db/pg/config.mjs'
import { BackupRepo } from '../db/repos/backup-repo.mjs'

/**
 * Strip embedded password from a PostgreSQL URI and pass it via `PGPASSWORD`
 * environment variable so `pg_dump` / `pg_restore` never leak credentials in argv (`ps`).
 */
export function buildPgToolInvocation(dsn) {
  const env = { ...process.env }
  if (!dsn) return { uri: '', env }
  try {
    const u = new URL(dsn)
    if (u.password) {
      env.PGPASSWORD = decodeURIComponent(u.password)
      u.password = ''
    }
    return { uri: u.toString(), env }
  } catch {
    return { uri: dsn, env }
  }
}

export function stamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-')
}

export function sha256File(file) {
  const h = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(4 * 1024 * 1024)
    let read = 0
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      h.update(read === buf.length ? buf : buf.subarray(0, read))
    }
  } finally {
    fs.closeSync(fd)
  }
  return h.digest('hex')
}

export function tarAvailable() {
  try {
    const r = spawnSync('tar', ['--version'], { stdio: 'ignore' })
    return r.status === 0
  } catch {
    return false
  }
}

export function parsePgMajorVersion(output) {
  const text = String(output || '')
  const m = text.match(/\(PostgreSQL\)\s+(\d+)/i) || text.match(/\b(\d+)\.\d+/)
  return m ? Number(m[1]) : null
}

export function isPgVersionMismatchStderr(stderr) {
  return /server version mismatch/i.test(String(stderr || ''))
}

export async function queryPgServerMajorVersion(pool) {
  if (!pool) return null
  try {
    const res = await pool.query('SHOW server_version_num')
    const num = Number(res?.rows?.[0]?.server_version_num)
    if (Number.isFinite(num) && num >= 10000) return Math.floor(num / 10000)
  } catch {}
  return null
}

function isLocalPgDsn(dsn) {
  if (!dsn) return false
  try {
    const host = new URL(dsn).hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
  } catch {
    return false
  }
}

/** Rewrite a local PG DSN for execution inside the managed PostgreSQL container (port 5432). */
export function buildDockerPgUri(dsn) {
  const { uri, env } = buildPgToolInvocation(dsn)
  if (!uri) return { uri: '', env }
  try {
    const u = new URL(uri)
    u.hostname = '127.0.0.1'
    u.port = '5432'
    return { uri: u.toString(), env }
  } catch {
    return { uri, env }
  }
}

function versionSatisfies(clientMajor, serverMajor) {
  if (!serverMajor) return true
  return clientMajor != null && clientMajor >= serverMajor
}

function probeBinaryVersion(bin, spawnImpl) {
  try {
    const r = spawnImpl(bin, ['--version'], { stdio: 'pipe', encoding: 'utf8' })
    if (r?.status !== 0) return null
    return { ok: true, major: parsePgMajorVersion(r.stdout || r.stderr) }
  } catch {
    return null
  }
}

function probeDockerToolVersion(container, tool, spawnImpl) {
  try {
    const r = spawnImpl('docker', ['exec', container, tool, '--version'], { stdio: 'pipe', encoding: 'utf8' })
    if (r?.status !== 0) return null
    return { ok: true, major: parsePgMajorVersion(r.stdout || r.stderr) }
  } catch {
    return null
  }
}

/**
 * Resolve a version-compatible `pg_dump` or `pg_restore` runner:
 *   1. Explicit env override (`KIN_PG_DUMP_BIN` / `KIN_PG_RESTORE_BIN`)
 *   2. Host PATH binary (`pg_dump` / `pg_restore`)
 *   3. Versioned Linux PGDG binaries (`/usr/lib/postgresql/<N>/bin/<tool>`, highest major first)
 *   4. Managed local Docker container (`docker exec <container> <tool>`) when DSN targets loopback
 *
 * Returns `{ mode: 'binary', bin, major }` or `{ mode: 'docker', container, tool, major }`, or `null`.
 */
export function resolvePgTool(
  tool,
  {
    serverMajor = null,
    connectionString = '',
    env = process.env,
    spawnImpl = spawnSync,
    readdirImpl = fs.readdirSync,
  } = {},
) {
  const envKey = tool === 'pg_dump' ? 'KIN_PG_DUMP_BIN' : 'KIN_PG_RESTORE_BIN'
  const explicitBin = String(env?.[envKey] || '').trim()
  if (explicitBin) {
    const probed = probeBinaryVersion(explicitBin, spawnImpl)
    if (probed && versionSatisfies(probed.major, serverMajor)) {
      return { mode: 'binary', bin: explicitBin, major: probed.major }
    }
  }

  const hostProbe = probeBinaryVersion(tool, spawnImpl)
  if (hostProbe && versionSatisfies(hostProbe.major, serverMajor)) {
    return { mode: 'binary', bin: tool, major: hostProbe.major }
  }

  // Scan PGDG multi-version install directories (e.g. /usr/lib/postgresql/18/bin/pg_dump).
  try {
    const dirs = readdirImpl('/usr/lib/postgresql')
      .filter((d) => /^\d+$/.test(String(d)))
      .map(Number)
      .sort((a, b) => b - a)
    for (const ver of dirs) {
      if (serverMajor && ver < serverMajor) break
      const candidate = `/usr/lib/postgresql/${ver}/bin/${tool}`
      const probed = probeBinaryVersion(candidate, spawnImpl)
      if (probed && versionSatisfies(probed.major, serverMajor)) {
        return { mode: 'binary', bin: candidate, major: probed.major }
      }
    }
  } catch {}

  if (isLocalPgDsn(connectionString)) {
    const container = String(env?.VM2API_PG_CONTAINER || 'vm2api-postgres').trim()
    if (container) {
      const probed = probeDockerToolVersion(container, tool, spawnImpl)
      if (probed && versionSatisfies(probed.major, serverMajor)) {
        return { mode: 'docker', container, tool, major: probed.major }
      }
    }
  }

  return null
}

export function pgDumpAvailable(opts = {}) {
  return resolvePgTool('pg_dump', opts) !== null
}

export function pgRestoreAvailable(opts = {}) {
  return resolvePgTool('pg_restore', opts) !== null
}

function execPgDump(runner, { dsn, dumpArgs, outFile, spawnImpl = spawnSync }) {
  if (runner.mode === 'docker') {
    const { uri, env } = buildDockerPgUri(dsn)
    const args = [
      'exec',
      ...(env.PGPASSWORD ? ['-e', 'PGPASSWORD'] : []),
      runner.container,
      'pg_dump',
      ...dumpArgs,
      uri,
    ]
    const outFd = fs.openSync(outFile, 'w', 0o600)
    try {
      return spawnImpl('docker', args, { stdio: ['ignore', outFd, 'pipe'], env })
    } finally {
      try {
        fs.closeSync(outFd)
      } catch {}
    }
  }
  const { uri, env } = buildPgToolInvocation(dsn)
  return spawnImpl(runner.bin, [...dumpArgs, `--file=${outFile}`, uri], { stdio: 'pipe', env })
}

function execPgRestore(runner, { connectionString, restoreArgs, dbFile, spawnImpl = spawnSync }) {
  if (runner.mode === 'docker') {
    const { uri, env } = buildDockerPgUri(connectionString)
    const args = [
      'exec',
      '-i',
      ...(env.PGPASSWORD ? ['-e', 'PGPASSWORD'] : []),
      runner.container,
      'pg_restore',
      ...restoreArgs,
      `--dbname=${uri}`,
    ]
    const inFd = fs.openSync(dbFile, 'r')
    try {
      return spawnImpl('docker', args, { stdio: [inFd, 'pipe', 'pipe'], env })
    } finally {
      try {
        fs.closeSync(inFd)
      } catch {}
    }
  }
  const { uri, env } = buildPgToolInvocation(connectionString)
  return spawnImpl(runner.bin, [...restoreArgs, `--dbname=${uri}`, dbFile], { stdio: 'pipe', env })
}

function mkdtempOnDataVolume({ tmpDir }) {
  const base = process.env.KIN_BACKUP_TMPDIR || tmpDir
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(base, 0o700)
  } catch {}
  return fs.mkdtempSync(path.join(base, 'kin-backup-'))
}

function applyRetention(repo, retention) {
  const drop = [...repo.beyondRetention(retention), ...repo.preRestoreBeyond(3)]
  for (const rec of drop) {
    try {
      if (rec.file_path && fs.existsSync(rec.file_path)) fs.rmSync(rec.file_path, { force: true })
    } catch {}
    try {
      repo.remove(rec.id)
    } catch {}
  }
  return drop.length
}

function stageVmsAndConfig(ctx, tmp, includes, sha256s) {
  const vmsDir = ctx.projectRoot ? path.join(ctx.projectRoot, 'vms') : null
  if (vmsDir && fs.existsSync(vmsDir)) {
    const outVms = path.join(tmp, 'vms')
    fs.mkdirSync(outVms, { recursive: true })
    for (const f of fs.readdirSync(vmsDir)) {
      if (!/\.json$/.test(f)) continue
      const src = path.join(vmsDir, f)
      try {
        if (!fs.statSync(src).isFile()) continue
        fs.copyFileSync(src, path.join(outVms, f))
        fs.chmodSync(path.join(outVms, f), 0o600)
        sha256s[`vms/${f}`] = sha256File(src)
        includes.vms += 1
      } catch {}
    }
  }
  if (ctx.configDir && fs.existsSync(ctx.configDir)) {
    const outCfg = path.join(tmp, 'config')
    fs.mkdirSync(outCfg, { recursive: true })
    for (const f of fs.readdirSync(ctx.configDir)) {
      if (!/\.json$/.test(f)) continue
      const src = path.join(ctx.configDir, f)
      try {
        if (!fs.statSync(src).isFile()) continue
        fs.copyFileSync(src, path.join(outCfg, f))
        sha256s[`config/${f}`] = sha256File(src)
        includes.config += 1
      } catch {}
    }
  }
}

/** Sort PostgreSQL tables in FK parent-before-child topological order. */
async function orderTablesByFk(client, tables) {
  const fkRes = await client.query(`
    SELECT DISTINCT
      tc.table_name AS child_table,
      ccu.table_name AS parent_table
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
     AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = current_schema()
  `)
  const tableSet = new Set(tables)
  const deps = new Map(tables.map((t) => [t, new Set()]))
  const children = new Map(tables.map((t) => [t, new Set()]))
  for (const { child_table: child, parent_table: parent } of fkRes.rows) {
    if (child === parent || !tableSet.has(child) || !tableSet.has(parent)) continue
    deps.get(child).add(parent)
    children.get(parent).add(child)
  }
  const ordered = []
  const queue = tables.filter((t) => deps.get(t).size === 0)
  const seen = new Set(queue)
  while (queue.length) {
    const cur = queue.shift()
    ordered.push(cur)
    for (const ch of children.get(cur)) {
      deps.get(ch).delete(cur)
      if (deps.get(ch).size === 0 && !seen.has(ch)) {
        seen.add(ch)
        queue.push(ch)
      }
    }
  }
  for (const t of tables) {
    if (!seen.has(t)) ordered.push(t)
  }
  return ordered
}

async function insertPgRestoreRows(client, table, cols, rows, deferredJump) {
  if (!rows.length || !cols?.length) return
  const MAX_PG_PARAMS = 30_000
  const colList = cols.map((c) => `"${c}"`).join(', ')
  const batchSize = Math.max(1, Math.min(200, Math.floor(MAX_PG_PARAMS / Math.max(1, cols.length))))
  const isClusterNodes = table === 'cluster_nodes' && cols.includes('jump_node_id') && cols.includes('id')

  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize)
    const values = []
    const tuples = []
    let pIdx = 1
    for (const row of slice) {
      if (isClusterNodes && row.jump_node_id != null) {
        deferredJump.push([row.jump_node_id, row.id])
      }
      const ph = []
      for (const c of cols) {
        ph.push(`$${pIdx++}`)
        values.push(isClusterNodes && c === 'jump_node_id' ? null : (row[c] ?? null))
      }
      tuples.push(`(${ph.join(', ')})`)
    }
    await client.query(`INSERT INTO "${table}" (${colList}) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`, values)
  }
}

/** Pure-JS streaming logical dump fallback when `pg_dump` binary is not installed. */
async function dumpPgLogicalNdjsonGz(pool, outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  const gzip = zlib.createGzip({ level: 6 })
  const ws = fs.createWriteStream(outFile, { mode: 0o600 })
  gzip.pipe(ws)

  const writeLine = (obj) =>
    new Promise((resolve, reject) => {
      const ok = gzip.write(JSON.stringify(obj) + '\n')
      if (ok) return resolve()
      gzip.once('drain', resolve)
      gzip.once('error', reject)
    })

  const tablesRes = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `)
  const validTables = tablesRes.rows.map((r) => r.table_name).filter((t) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t))

  const client = await pool.connect()
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const orderedTables = await orderTablesByFk(client, validTables)
    await writeLine({
      type: 'meta',
      engine: 'postgres',
      format: 'pg_logical_ndjson_gz',
      fk_ordered: true,
      tables: orderedTables,
      created_at: new Date().toISOString(),
    })

    for (const table of orderedTables) {
      const colRes = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
        [table],
      )
      const cols = colRes.rows.map((r) => r.column_name)
      await writeLine({ type: 'table', name: table, columns: cols })
      const chunkSize = 1000
      // Server-side cursor inside REPEATABLE READ streams every table in O(N) without OFFSET drift.
      await client.query(`DECLARE "vm2api_dump_cur" NO SCROLL CURSOR FOR SELECT * FROM "${table}"`)
      try {
        for (;;) {
          const res = await client.query(`FETCH ${chunkSize} FROM "vm2api_dump_cur"`)
          if (!res.rows.length) break
          await writeLine({ type: 'rows', table, rows: res.rows })
          if (res.rows.length < chunkSize) break
        }
      } finally {
        await client.query('CLOSE "vm2api_dump_cur"')
      }
    }
    await client.query('COMMIT')
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {}
    throw err
  } finally {
    client.release()
  }

  await new Promise((resolve, reject) => {
    ws.once('finish', resolve)
    ws.once('error', reject)
    gzip.once('error', reject)
    gzip.end()
  })
}

/**
 * Restore a PostgreSQL snapshot (`.pgdump` or `.pg.ndjson.gz`) inside a worker thread.
 *
 * Running off the main event loop prevents a structural deadlock between an open
 * async `TRUNCATE ... AccessExclusiveLock` transaction and any main-thread timer
 * issuing a synchronous `PgSyncDb` (`Atomics.wait`) query.
 */
export async function restorePgSnapshotJob({
  pool,
  connectionString,
  dbFile,
  resolveToolImpl = resolvePgTool,
  spawnImpl = spawnSync,
}) {
  if (dbFile.endsWith('.pgdump')) {
    const serverMajor = await queryPgServerMajorVersion(pool)
    const runner = resolveToolImpl('pg_restore', { serverMajor, connectionString, spawnImpl })
    if (!runner) {
      const verHint = serverMajor ? ` (>= ${serverMajor})` : ''
      throw Object.assign(
        new Error(`compatible pg_restore binary${verHint} is required to restore custom PostgreSQL dumps`),
        {
          code: 'pg_restore_missing',
        },
      )
    }
    const restoreArgs = ['--clean', '--if-exists', '--no-owner', '--no-privileges']
    if (pool) {
      try {
        const sRes = await pool.query('SELECT current_schema() AS s')
        const sc = sRes.rows[0]?.s
        if (sc && sc !== 'public' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sc)) {
          restoreArgs.push(`--schema=${sc}`)
        }
      } catch {}
    }
    const r = execPgRestore(runner, { connectionString, restoreArgs, dbFile, spawnImpl })
    if (r.status !== 0) {
      throw new Error(`pg_restore failed: ${String(r.stderr || '').slice(0, 300)}`)
    }
    return
  }

  if (!dbFile.endsWith('.pg.ndjson.gz')) {
    throw Object.assign(new Error(`unsupported PostgreSQL backup file: ${path.basename(dbFile)}`), {
      code: 'backup_incompatible',
    })
  }

  if (!pool) throw new Error('PostgreSQL pool unavailable for restore')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout = '30s'")
    await client.query('SET LOCAL synchronous_commit = off')

    const gunzip = zlib.createGunzip()
    const stream = fs.createReadStream(dbFile).pipe(gunzip)
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

    const tableCols = new Map()
    const tableRows = new Map()
    const deferredJump = []
    let streamingOrdered = false
    let truncated = false

    for await (const line of rl) {
      if (!line) continue
      const rec = JSON.parse(line)
      if (rec.type === 'meta' && rec.fk_ordered === true && Array.isArray(rec.tables)) {
        const safeTables = rec.tables.filter(
          (t) => typeof t === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t) && t !== 'schema_migrations',
        )
        if (safeTables.length) {
          await client.query(`TRUNCATE TABLE ${safeTables.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`)
          truncated = true
          streamingOrdered = true
        }
      } else if (rec.type === 'table' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(rec.name)) {
        tableCols.set(rec.name, rec.columns)
        if (!streamingOrdered && !tableRows.has(rec.name)) tableRows.set(rec.name, [])
      } else if (rec.type === 'rows' && Array.isArray(rec.rows) && rec.rows.length) {
        if (rec.table === 'schema_migrations') continue
        if (streamingOrdered) {
          await insertPgRestoreRows(client, rec.table, tableCols.get(rec.table), rec.rows, deferredJump)
        } else {
          if (!tableRows.has(rec.table)) tableRows.set(rec.table, [])
          tableRows.get(rec.table).push(...rec.rows)
        }
      }
    }

    if (!streamingOrdered) {
      const tables = [...tableCols.keys()].filter((t) => t !== 'schema_migrations')
      const ordered = await orderTablesByFk(client, tables)
      if (ordered.length && !truncated) {
        await client.query(`TRUNCATE TABLE ${ordered.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`)
      }
      for (const table of ordered) {
        await insertPgRestoreRows(client, table, tableCols.get(table), tableRows.get(table) || [], deferredJump)
      }
    }

    for (const [jumpId, nodeId] of deferredJump) {
      await client.query('UPDATE "cluster_nodes" SET "jump_node_id" = $1 WHERE "id" = $2', [jumpId, nodeId])
    }

    // Re-sync BIGSERIAL/SERIAL sequences so post-restore inserts never collide on id=1.
    const seqRes = await client.query(`
      SELECT
        table_name,
        column_name,
        pg_get_serial_sequence(format('%I.%I', table_schema, table_name), column_name) AS seq_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND column_default LIKE 'nextval(%'
    `)
    for (const { table_name: t, column_name: c, seq_name: seq } of seqRes.rows) {
      if (!seq || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t) || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(c)) continue
      const maxRes = await client.query(`SELECT MAX("${c}") AS max_id, COUNT(*) AS cnt FROM "${t}"`)
      const cnt = Number(maxRes.rows[0]?.cnt || 0)
      const maxId = Number(maxRes.rows[0]?.max_id || 1)
      if (cnt > 0) {
        await client.query('SELECT setval($1::regclass, $2, true)', [seq, Math.max(1, maxId)])
      } else {
        await client.query('SELECT setval($1::regclass, 1, false)', [seq])
      }
    }

    await client.query('COMMIT')
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {}
    throw err
  } finally {
    client.release()
  }
}

/**
 * Run one PostgreSQL backup job end-to-end (called from backup-worker.mjs).
 */
export async function runPgBackupJob(ctx, { id, createdAt, kind = 'manual', note = null, retention = 7 }) {
  const repo = new BackupRepo(getDb())
  const pool = getPgPool()
  const pgConfig = getPgConfig()
  let tmp = null
  try {
    fs.mkdirSync(ctx.backupDir, { recursive: true, mode: 0o700 })
    try {
      fs.chmodSync(ctx.backupDir, 0o700)
    } catch {}
    tmp = mkdtempOnDataVolume(ctx)
    const dbDir = path.join(tmp, 'db')
    fs.mkdirSync(dbDir, { recursive: true })

    let dbSnap
    let dbRelPath
    let pgFormat
    const dsn = buildPgConnectionString(pgConfig)
    const serverMajor = await queryPgServerMajorVersion(pool)
    const dumpRunner = dsn ? resolvePgTool('pg_dump', { serverMajor, connectionString: dsn }) : null

    let dumpedCustom = false
    if (dumpRunner && dsn) {
      dbSnap = path.join(dbDir, 'kin.pgdump')
      dbRelPath = 'db/kin.pgdump'
      pgFormat = 'pg_dump_custom'
      const dumpArgs = ['--format=custom', '--no-owner', '--no-privileges']
      if (pool) {
        try {
          const sRes = await pool.query('SELECT current_schema() AS s')
          const sc = sRes.rows[0]?.s
          if (sc && sc !== 'public' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sc)) {
            dumpArgs.push(`--schema=${sc}`)
          }
        } catch {}
      }
      const r = execPgDump(dumpRunner, { dsn, dumpArgs, outFile: dbSnap })
      if (r.status === 0) {
        dumpedCustom = true
      } else {
        try {
          fs.rmSync(dbSnap, { force: true })
        } catch {}
        const stderr = String(r.stderr || '').slice(0, 300)
        if (pool && isPgVersionMismatchStderr(stderr)) {
          console.warn(`[backup] pg_dump version mismatch, falling back to logical NDJSON dump: ${stderr}`)
        } else {
          throw new Error(`pg_dump failed: ${stderr}`)
        }
      }
    }
    if (!dumpedCustom) {
      if (pool) {
        dbSnap = path.join(dbDir, 'kin.pg.ndjson.gz')
        dbRelPath = 'db/kin.pg.ndjson.gz'
        pgFormat = 'pg_logical_ndjson_gz'
        await dumpPgLogicalNdjsonGz(pool, dbSnap)
      } else {
        throw new Error('PostgreSQL pool unavailable for backup')
      }
    }

    const dbBytes = fs.statSync(dbSnap).size
    const includes = { db: true, engine: 'postgres', format: pgFormat, vms: 0, config: 0 }
    const sha256s = { [dbRelPath]: sha256File(dbSnap) }
    stageVmsAndConfig(ctx, tmp, includes, sha256s)

    const manifest = {
      version: 2,
      engine: 'postgres',
      format: pgFormat,
      tool: 'kin-gateway',
      created_at: createdAt,
      kind,
      includes,
      sha256s,
    }
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2))

    let filePath
    let fileName
    let noteOut = note
    if (tarAvailable()) {
      fileName = `kin-backup-${stamp(new Date(createdAt))}.tar.gz`
      filePath = path.join(ctx.backupDir, fileName)
      const r = spawnSync('tar', ['-czf', filePath, '-C', tmp, '.'], { stdio: 'pipe' })
      if (r.status !== 0) {
        throw new Error(`tar failed: ${String(r.stderr || '').slice(0, 300)}`)
      }
    } else {
      fileName = `kin-backup-${stamp(new Date(createdAt))}.${pgFormat === 'pg_dump_custom' ? 'pgdump' : 'pg.ndjson.gz'}`
      filePath = path.join(ctx.backupDir, fileName)
      fs.copyFileSync(dbSnap, filePath)
      noteOut = [note, 'tar unavailable — db-only PostgreSQL snapshot'].filter(Boolean).join(' | ')
    }
    try {
      fs.chmodSync(filePath, 0o600)
    } catch {}

    const rec = repo.insert({
      id,
      created_at: createdAt,
      kind,
      status: 'ok',
      file_path: filePath,
      file_name: fileName,
      size_bytes: fs.statSync(filePath).size,
      sha256: sha256File(filePath),
      db_bytes: dbBytes,
      includes,
      error: null,
      note: noteOut,
    })
    applyRetention(repo, retention)
    return rec
  } catch (e) {
    try {
      repo.insert({
        id,
        created_at: createdAt,
        kind,
        status: 'failed',
        file_path: null,
        file_name: null,
        size_bytes: null,
        sha256: null,
        db_bytes: null,
        includes: null,
        error: String(e.message || e).slice(0, 500),
        note,
      })
    } catch {}
    throw e
  } finally {
    if (tmp) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true })
      } catch {}
    }
  }
}

/**
 * Run one SQLite backup job end to end. Blocking by design — call it from a worker
 * thread (or the test process), never from the gateway's main thread.
 */
export function runBackupJob(ctx, { id, createdAt, kind = 'manual', note = null, retention = 7 }) {
  const repo = new BackupRepo(getDb())
  let tmp = null
  try {
    fs.mkdirSync(ctx.backupDir, { recursive: true, mode: 0o700 })
    try {
      fs.chmodSync(ctx.backupDir, 0o700)
    } catch {}
    tmp = mkdtempOnDataVolume(ctx)

    // 1. online-consistent DB snapshot (WAL-safe)
    const dbSnap = path.join(tmp, 'db', 'kin.db')
    vacuumInto(getDb(), dbSnap)
    const dbBytes = fs.statSync(dbSnap).size

    // 2. vm files + config files
    const includes = { db: true, vms: 0, config: 0 }
    const sha256s = { 'db/kin.db': sha256File(dbSnap) }
    stageVmsAndConfig(ctx, tmp, includes, sha256s)

    // 3. manifest
    const manifest = {
      version: 1,
      tool: 'kin-gateway',
      created_at: createdAt,
      kind,
      includes,
      sha256s,
    }
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2))

    // 4. archive (tar.gz preferred; gzipped db fallback)
    let filePath
    let fileName
    let noteOut = note
    if (tarAvailable()) {
      fileName = `kin-backup-${stamp(new Date(createdAt))}.tar.gz`
      filePath = path.join(ctx.backupDir, fileName)
      const r = spawnSync('tar', ['-czf', filePath, '-C', tmp, '.'], { stdio: 'pipe' })
      if (r.status !== 0) {
        throw new Error(`tar failed: ${String(r.stderr || '').slice(0, 300)}`)
      }
    } else {
      fileName = `kin-backup-${stamp(new Date(createdAt))}.db.gz`
      filePath = path.join(ctx.backupDir, fileName)
      fs.writeFileSync(filePath, zlib.gzipSync(fs.readFileSync(dbSnap)))
      noteOut = [note, 'tar unavailable — db-only gzip snapshot (vm files rebuilt from DB on restore)']
        .filter(Boolean)
        .join(' | ')
    }
    try {
      fs.chmodSync(filePath, 0o600)
    } catch {}

    const rec = repo.insert({
      id,
      created_at: createdAt,
      kind,
      status: 'ok',
      file_path: filePath,
      file_name: fileName,
      size_bytes: fs.statSync(filePath).size,
      sha256: sha256File(filePath),
      db_bytes: dbBytes,
      includes,
      error: null,
      note: noteOut,
    })
    applyRetention(repo, retention)
    return rec
  } catch (e) {
    try {
      repo.insert({
        id,
        created_at: createdAt,
        kind,
        status: 'failed',
        file_path: null,
        file_name: null,
        size_bytes: null,
        sha256: null,
        db_bytes: null,
        includes: null,
        error: String(e.message || e).slice(0, 500),
        note,
      })
    } catch {}
    throw e
  } finally {
    if (tmp) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true })
      } catch {}
    }
  }
}
