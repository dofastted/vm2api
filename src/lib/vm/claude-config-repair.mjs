import fs from 'node:fs'
import path from 'node:path'

// Claude Code names its own copies `.claude.json.backup.<epoch ms>` under ~/.claude/backups.
const BACKUP_NAME = /^\.claude\.json\.backup\.(\d{10,16})$/
const MAX_BACKUP_BYTES = 4 * 1024 * 1024
// A writer that truncates before it writes leaves a fresh mtime; never race it.
const SETTLE_MS = 30_000
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
const CREATE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0)

function realDirectory(dir) {
  try {
    const st = fs.lstatSync(dir)
    return st.isDirectory() && !st.isSymbolicLink()
  } catch {
    return false
  }
}

// The home is shared with the guest, so every file is opened without following links and
// checked on the open descriptor: a swapped-in link can never make the host read its own files.
function inspect(file, maxBytes = Infinity) {
  let fd
  try {
    fd = fs.openSync(file, READ_FLAGS)
  } catch (error) {
    return { state: error?.code === 'ENOENT' ? 'missing' : 'not_regular' }
  }
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile()) return { state: 'not_regular', st }
    if (st.size > maxBytes) return { state: 'too_large', st }
    if (st.size === 0) return { state: 'bad', st }
    const raw = fs.readFileSync(fd)
    try {
      const doc = JSON.parse(raw.toString('utf8'))
      return doc && typeof doc === 'object' && !Array.isArray(doc) ? { state: 'ok', st, raw } : { state: 'bad', st }
    } catch {
      return { state: 'bad', st }
    }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * An empty or unparsable ~/.claude/.claude.json makes every Claude Code start throw
 * ConfigParseError, so the slot kernel restarts the CLI forever ("timed out waiting for N ready
 * slots") and a kernel switch never reports ready. Restore the newest parsable backup the CLI
 * wrote itself, which keeps userID / oauthAccount. A healthy, missing, linked or still-settling
 * file is left alone; without a usable backup nothing is written.
 */
export function repairClaudeConfigFromBackup(homeDir, { now = Date.now(), settleMs = SETTLE_MS } = {}) {
  const dir = path.join(homeDir, '.claude')
  if (!realDirectory(dir)) return { repaired: false, reason: 'missing' }
  const primary = path.join(dir, '.claude.json')
  const current = inspect(primary)
  if (current.state !== 'bad') return { repaired: false, reason: current.state }
  if (now - current.st.mtimeMs < settleMs) return { repaired: false, reason: 'settling' }
  const backups = path.join(dir, 'backups')
  if (!realDirectory(backups)) return { repaired: false, reason: 'no_backup' }
  const candidates = fs
    .readdirSync(backups)
    .map((name) => [name, BACKUP_NAME.exec(name)?.[1]])
    .filter(([, stamp]) => stamp)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
  for (const [name] of candidates) {
    const backup = inspect(path.join(backups, name), MAX_BACKUP_BYTES)
    if (backup.state !== 'ok') continue
    const tmp = `${primary}.${process.pid}.repair.tmp`
    fs.rmSync(tmp, { force: true })
    const fd = fs.openSync(tmp, CREATE_FLAGS, current.st.mode & 0o777)
    try {
      try {
        fs.fchownSync(fd, current.st.uid, current.st.gid)
      } catch {}
      fs.writeFileSync(fd, backup.raw)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, primary)
    return { repaired: true, backup: name }
  }
  return { repaired: false, reason: 'no_backup' }
}
