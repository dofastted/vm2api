/**
 * File operations on a cluster node over the node's SSH link. SFTP runs as the
 * SSH user, so the remote slot tree lives under that user's HOME and needs no
 * sudo. Writes are temp + rename: kin-kernel hot-reloads kernel.json and must
 * never read a half-written file.
 *
 * Slot directories are writable by the guest, which can plant symlinks there.
 * Host-namespace I/O must therefore never follow a final path component:
 * writes create an O_EXCL temp (EXCL never follows) and set mode / owner on the
 * open handle; reads open with O_NOFOLLOW. Callers keep every parent directory
 * out of guest reach (mount roots or host-only paths).
 */

import crypto from 'node:crypto'
import { ClusterError, execCollect } from './ssh-link.mjs'

const sessions = new WeakMap()

export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/** One cached SFTP subsystem per SSH client; dropped when either side closes. */
export function openSftp(client) {
  const cached = sessions.get(client)
  if (cached) return cached
  const pending = new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(new ClusterError(502, 'sftp_failed', `打开 SFTP 失败：${err.message}`))
      sftp.once('close', () => {
        if (sessions.get(client) === pending) sessions.delete(client)
      })
      resolve(sftp)
    })
  })
  pending.catch(() => sessions.delete(client))
  sessions.set(client, pending)
  return pending
}

function call(fn) {
  return new Promise((resolve, reject) => fn((err, value) => (err ? reject(err) : resolve(value))))
}

function sftpError(err, what) {
  return new ClusterError(502, 'sftp_failed', `${what}：${err?.message || err}`)
}

/** SFTP WRITE payloads stay under the 32 KiB every server accepts. */
const WRITE_CHUNK = 32 * 1024

/**
 * Atomic, symlink-safe write. `owner` is only set when the SSH user is root (the
 * slot then runs as 10000+n and must own its files); a non-root SSH user already is the slot uid.
 */
export async function writeRemoteFile(sftp, file, data, { mode = 0o600, owner = null, timeoutMs = 0 } = {}) {
  let timedOut = false
  const work = writeRemoteFileBody(sftp, file, data, { mode, owner }).catch((error) => {
    if (timedOut) return undefined
    throw error
  })
  if (!timeoutMs) return work
  let timer
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          reject(new ClusterError(504, 'sftp_timeout', `写入超时：${file}`))
        }, timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Regular-file SHA-256, or null when the path is missing. A symlink is not hashed. */
export async function remoteFileSha256(client, file) {
  const script = `f=${shellQuote(file)}; if [ -L "$f" ] || [ ! -f "$f" ]; then exit 3; fi; sha256sum "$f"`
  const result = await execCollect(client, `sh -c ${shellQuote(script)}`, { timeoutMs: 120_000, maxBytes: 4096 })
  if (result.code === 3) return null
  if (result.code !== 0) {
    const detail = (result.stderr || `exit ${result.code}`).trim().slice(-200)
    throw new ClusterError(502, 'remote_hash_failed', `校验 ${file} 失败：${detail}`)
  }
  const hash = result.stdout.trim().split(/\s+/)[0]
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new ClusterError(502, 'remote_hash_failed', `校验 ${file} 返回异常`)
  }
  return hash
}
async function writeRemoteFileBody(sftp, file, data, { mode = 0o600, owner = null } = {}) {
  if (!Buffer.isBuffer(data)) data = Buffer.from(data)
  const dir = file.slice(0, file.lastIndexOf('/'))
  const tmp = `${dir}/.kin-${crypto.randomBytes(8).toString('hex')}.tmp`
  let handle = null
  try {
    handle = await call((cb) => sftp.open(tmp, 'wx', { mode }, cb))
    for (let off = 0; off < data.length; off += WRITE_CHUNK) {
      const len = Math.min(WRITE_CHUNK, data.length - off)
      await call((cb) => sftp.write(handle, data, off, len, off, cb))
    }
    await call((cb) => sftp.fchmod(handle, mode, cb))
    if (owner) await call((cb) => sftp.fchown(handle, owner.uid, owner.gid, cb))
    await call((cb) => sftp.close(handle, cb))
    handle = null
    // Rename over the live path. Never unlink it first: a container command may point at it.
    await call((cb) => sftp.ext_openssh_rename(tmp, file, cb))
  } catch (err) {
    if (handle) await call((cb) => sftp.close(handle, cb)).catch(() => {})
    await call((cb) => sftp.unlink(tmp, cb)).catch(() => {})
    throw sftpError(err, `写入 ${file} 失败`)
  }
}

/**
 * Regular-file bytes, or null when absent. A symlink fails (O_NOFOLLOW), a FIFO
 * reads empty (O_NONBLOCK) and a large file is cut at `maxBytes`, so a guest can
 * neither redirect the read nor stall it. base64 keeps the bytes intact across
 * exec's text channel.
 */
export async function readRemoteFileNoFollow(client, file, { maxBytes = 1 << 20 } = {}) {
  const blocks = Math.ceil(maxBytes / 65536)
  // BSD dd (macOS nodes) has no iflag: refuse links and non-regular files up front instead.
  const script = [
    `set -o pipefail; f=${shellQuote(file)}; [ -e "$f" ] || [ -L "$f" ] || exit 3;`,
    'if dd if=/dev/null of=/dev/null iflag=nofollow 2>/dev/null; then',
    `dd if="$f" iflag=nofollow,nonblock bs=65536 count=${blocks} status=none;`,
    'else if [ -L "$f" ] || [ ! -f "$f" ]; then echo "not a regular file" >&2; exit 4; fi;',
    `dd if="$f" bs=65536 count=${blocks} 2>/dev/null; fi | base64 | tr -d '\\n'`,
  ].join(' ')
  const r = await execCollect(client, `bash -c ${shellQuote(script)}`, { timeoutMs: 15_000, maxBytes: maxBytes * 2 })
  if (r.code === 3) return null
  if (r.code !== 0) {
    const detail = (r.stderr || `exit ${r.code}`).trim().slice(-200)
    throw new ClusterError(502, 'remote_read_refused', `读取 ${file} 被拒绝：${detail}`)
  }
  return Buffer.from(r.stdout.trim(), 'base64')
}

/** Symlink ownership is never checked by the kernel, so root-created links are fine. */
export async function remoteSymlink(sftp, target, linkPath) {
  await call((cb) => sftp.unlink(linkPath, cb)).catch(() => {})
  try {
    await call((cb) => sftp.symlink(target, linkPath, cb))
  } catch (err) {
    throw sftpError(err, `创建链接 ${linkPath} 失败`)
  }
}

/**
 * Make each final component a real directory. Parents must be mount roots.
 * Mode and owner go through `find -P`: GNU chmod before 8.32 and BusyBox reject
 * `chmod -h` (`invalid option -- 'h'`), which aborted kernel switch and deploy.
 * `-P` does not follow a symlink the guest swapped in; a link matches nothing
 * and the script fails closed instead of changing the target.
 * `owner` is only meaningful for a root SSH session.
 */
export function privateDirectoriesScript(dirs, owner = null) {
  const own =
    owner == null
      ? ''
      : `find -P "$d" -maxdepth 0 -type d -exec chown ${requireId(owner.uid)}:${requireId(owner.gid)} {} + || exit 1;`
  return dirs
    .map((dir) => {
      const d = shellQuote(dir)
      return [
        `d=${d};`,
        'if [ -L "$d" ]; then rm "$d" || exit 1; fi;',
        'if [ -e "$d" ] && [ ! -d "$d" ]; then rm "$d" || exit 1; fi;',
        'if [ ! -d "$d" ]; then mkdir "$d" || exit 1; fi;',
        'if [ -L "$d" ] || [ ! -d "$d" ]; then echo "private directory was replaced" >&2; exit 1; fi;',
        'hit=$(find -P "$d" -maxdepth 0 -type d -exec chmod 700 {} + -print);',
        '[ -n "$hit" ] || { echo "private directory was replaced" >&2; exit 1; };',
        'if [ -L "$d" ] || [ ! -d "$d" ]; then echo "private directory was replaced" >&2; exit 1; fi;',
        own,
      ].join(' ')
    })
    .join(' ')
}

function requireId(value) {
  const id = Number(value)
  if (!Number.isInteger(id) || id < 0) throw new Error('remote owner id is not an integer')
  return id
}

/** Run a shell script; non-zero exit is an error carrying stderr. */
export async function runRemote(client, script, { timeoutMs = 60_000, code = 'remote_exec_failed' } = {}) {
  const r = await execCollect(client, `sh -c ${shellQuote(script)}`, { timeoutMs })
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout || `exit ${r.code}`).trim().slice(-500)
    throw new ClusterError(502, code, detail)
  }
  return r.stdout
}
