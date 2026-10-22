/** Materialize old SQLite archives without extracting archive paths or symlinks. */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { runProcess, sha256File } from '../admin/backup-core.mjs'

async function memberToFile(archive, member, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
  const child = spawn('tar', ['-xOzf', archive, '--', member], { stdio: ['ignore', 'pipe', 'ignore'] })
  const done = new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('tar could not start')))
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error('legacy archive extraction failed'))))
  })
  await Promise.all([pipeline(child.stdout, fs.createWriteStream(destination, { mode: 0o600, flags: 'wx' })), done])
}
export async function materializeSqliteBackup(source, root) {
  const database = path.join(root, 'db', 'kin.db')
  fs.mkdirSync(path.dirname(database), { recursive: true, mode: 0o700 })
  if (source.endsWith('.db.gz')) {
    await pipeline(
      fs.createReadStream(source),
      createGunzip(),
      fs.createWriteStream(database, { mode: 0o600, flags: 'wx' }),
    )
    return database
  }
  if (!source.endsWith('.tar.gz')) throw new Error('legacy backup must be .tar.gz or .db.gz')
  const entries = (await runProcess('tar', ['-tzf', source])).split('\n').filter(Boolean)
  const seen = new Set()
  for (const entry of entries) {
    const name = entry.replace(/^\.\//, '')
    if (name === '.' || name === '') continue
    if (/^(db|vms|config)\/$/.test(name)) {
      fs.mkdirSync(path.join(root, name), { recursive: true, mode: 0o700 })
      continue
    }
    if (!/^(db\/kin\.db|manifest\.json|(vms|config)\/[A-Za-z0-9._-]+\.json)$/.test(name) || seen.has(name))
      throw new Error('legacy archive contains an unsupported path')
    seen.add(name)
    await memberToFile(source, entry, path.join(root, name))
  }
  if (!fs.existsSync(database)) throw new Error('legacy archive has no SQLite snapshot')
  const manifest = path.join(root, 'manifest.json')
  if (fs.existsSync(manifest)) {
    const info = JSON.parse(fs.readFileSync(manifest, 'utf8'))
    for (const [name, hash] of Object.entries(info.sha256s || {})) {
      if (!seen.has(name) || sha256File(path.join(root, name)) !== hash)
        throw new Error('legacy archive checksum mismatch')
    }
  }
  return database
}
