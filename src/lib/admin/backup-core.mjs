/** PostgreSQL backup primitives. Child processes keep dump/compression off the HTTP thread. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { pipeline } from 'node:stream/promises'

export function stamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-')
}

// Chunked on purpose: the DB snapshot and the archive both outgrow Node's
// ~2 GiB Buffer ceiling, and readFileSync would throw before hashing.
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

/** Staging dir on the data volume — the DB snapshot can be several GB. */
function mkdtempOnDataVolume({ tmpDir }) {
  const base = process.env.KIN_BACKUP_TMPDIR || tmpDir
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(base, 0o700)
  } catch {}
  return fs.mkdtempSync(path.join(base, 'kin-backup-'))
}

/** The parent holds the exported snapshot until this asynchronous worker job completes. */
export async function runBackupJob(ctx, { id, createdAt, kind = 'manual', note = null }, onFilesCopied = () => {}) {
  let tmp = null
  try {
    fs.mkdirSync(ctx.backupDir, { recursive: true, mode: 0o700 })
    try {
      fs.chmodSync(ctx.backupDir, 0o700)
    } catch {}
    tmp = mkdtempOnDataVolume(ctx)

    const dbSnap = path.join(tmp, 'db', 'postgres.dump')
    fs.mkdirSync(path.dirname(dbSnap), { recursive: true, mode: 0o700 })

    // 2. vm files + config files
    const includes = { db: true, vms: 0, config: 0 }
    const sha256s = {}
    if (ctx.projectRoot) fs.mkdirSync(path.join(tmp, 'vms'), { recursive: true })
    if (ctx.configDir) fs.mkdirSync(path.join(tmp, 'config'), { recursive: true })
    const vmsDir = ctx.projectRoot ? path.join(ctx.projectRoot, 'vms') : null
    if (vmsDir && fs.existsSync(vmsDir)) {
      const outVms = path.join(tmp, 'vms')
      fs.mkdirSync(outVms, { recursive: true })
      for (const f of fs.readdirSync(vmsDir)) {
        if (!/\.json$/.test(f)) continue
        const src = path.join(vmsDir, f)
        if (!fs.statSync(src).isFile()) continue
        fs.copyFileSync(src, path.join(outVms, f))
        fs.chmodSync(path.join(outVms, f), 0o600)
        sha256s[`vms/${f}`] = sha256File(path.join(outVms, f))
        includes.vms += 1
      }
    }
    if (ctx.configDir && fs.existsSync(ctx.configDir)) {
      const outCfg = path.join(tmp, 'config')
      fs.mkdirSync(outCfg, { recursive: true })
      for (const f of fs.readdirSync(ctx.configDir)) {
        if (!/\.json$/.test(f)) continue
        const src = path.join(ctx.configDir, f)
        if (!fs.statSync(src).isFile()) continue
        fs.copyFileSync(src, path.join(outCfg, f))
        sha256s[`config/${f}`] = sha256File(path.join(outCfg, f))
        includes.config += 1
      }
    }

    // Files and exported DB snapshot refer to the same write-free window.
    await onFilesCopied()
    await runPgTool(
      'pg_dump',
      [
        '--format=custom',
        '--no-owner',
        '--no-privileges',
        `--schema=${ctx.schema}`,
        `--snapshot=${ctx.snapshot}`,
        '--file',
        dbSnap,
      ],
      ctx.connectionString,
    )
    fs.chmodSync(dbSnap, 0o600)
    const dbBytes = fs.statSync(dbSnap).size
    sha256s['db/postgres.dump'] = sha256File(dbSnap)

    const manifest = {
      version: 2,
      engine: 'postgresql',
      schema: ctx.schema,
      schema_version: ctx.schemaVersion,
      tool: 'kin-gateway',
      created_at: createdAt,
      kind,
      includes,
      sha256s,
    }
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2))

    const fileName = `kin-backup-${stamp(new Date(createdAt))}.tar.gz`
    const filePath = path.join(ctx.backupDir, fileName)
    await runProcess('tar', ['-czf', filePath, '-C', tmp, '.'])
    fs.chmodSync(filePath, 0o600)

    return {
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
      note,
    }
  } finally {
    if (tmp) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true })
      } catch {}
    }
  }
}

/** Secrets are passed only through the child environment; stderr may contain data and is never returned. */
export function pgEnvironment(connectionString) {
  let url
  try {
    url = new URL(connectionString)
  } catch {
    throw new Error('invalid PostgreSQL connection configuration')
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('PostgreSQL connection required')
  const env = {
    ...process.env,
    PGHOST: url.searchParams.get('host') || url.hostname.replace(/^\[(.+)\]$/, '$1'),
    PGPORT: url.searchParams.get('port') || url.port || '5432',
    PGUSER: url.searchParams.get('user') || decodeURIComponent(url.username),
    PGPASSWORD: url.searchParams.get('password') || decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGCONNECT_TIMEOUT: '10',
  }
  for (const [key, name] of Object.entries({
    sslmode: 'PGSSLMODE',
    sslcert: 'PGSSLCERT',
    sslkey: 'PGSSLKEY',
    sslrootcert: 'PGSSLROOTCERT',
    connect_timeout: 'PGCONNECT_TIMEOUT',
    application_name: 'PGAPPNAME',
    options: 'PGOPTIONS',
  })) {
    if (url.searchParams.has(key)) env[name] = url.searchParams.get(key)
  }
  return env
}

export function runProcess(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
      if (stdout.length > 1024 * 1024) {
        child.kill()
        reject(new Error(`${command} output exceeds the archive metadata limit`))
      }
    })
    child.once('error', () => reject(new Error(`${command} could not start`)))
    child.once('close', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`${command} failed (exit ${code})`)),
    )
  })
}

export function runPgTool(command, args, connectionString) {
  return runProcess(command, args, pgEnvironment(connectionString))
}

/** Hash large archives without blocking health checks on the main thread. */
export async function sha256FileAsync(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/** Extract only a selected member's bytes; archive symlinks are never installed on disk. */
export async function extractArchiveMember(archive, member, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
  const child = spawn('tar', ['-xOzf', archive, '--', member], { stdio: ['ignore', 'pipe', 'ignore'] })
  const done = new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('tar could not start')))
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error('backup archive extraction failed'))))
  })
  await Promise.all([pipeline(child.stdout, fs.createWriteStream(destination, { mode: 0o600, flags: 'wx' })), done])
}
