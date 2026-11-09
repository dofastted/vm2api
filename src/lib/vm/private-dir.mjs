import fs from 'node:fs'

const NOFOLLOW_DIR = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW

/**
 * Create or reuse a directory the guest can replace with a symlink.
 * A link or non-directory leaf is unlinked (the link itself, not its target).
 * Mode and owner are applied to the opened directory fd, so a raced symlink
 * fails the open instead of being followed by chmod/chown.
 */
export function ensureHostPrivateDir(dir, { uid = 0, gid = 0, privileged = false } = {}) {
  let existing = null
  try {
    existing = fs.lstatSync(dir)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) {
    fs.unlinkSync(dir)
    existing = null
  }
  if (!existing) fs.mkdirSync(dir, { mode: 0o700 })
  const fd = fs.openSync(dir, NOFOLLOW_DIR)
  try {
    fs.fchmodSync(fd, 0o700)
    if (privileged) fs.fchownSync(fd, uid, gid)
  } finally {
    fs.closeSync(fd)
  }
}
