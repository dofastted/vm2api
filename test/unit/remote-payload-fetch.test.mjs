import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { claudeFetchSpec } from '../../src/lib/cluster/slot-image.mjs'
import { remoteFetchScript } from '../../src/lib/cluster/remote-fs.mjs'
import { publishSlotBinFiles, resolvePayloadFetchMode } from '../../src/lib/cluster/remote-slot-files.mjs'

test('claudeFetchSpec maps a pinned claude binary to its vendor download URL', () => {
  assert.deepEqual(claudeFetchSpec('claude-code-2.1.321/claude'), {
    kind: 'claude-code',
    version: '2.1.321',
    url: 'https://downloads.claude.ai/claude-code-releases/2.1.321/linux-x64/claude',
  })
})

test('claudeFetchSpec refuses non-claude or non-pinned paths', () => {
  assert.equal(claudeFetchSpec('crag-v2'), null)
  assert.equal(claudeFetchSpec('claude-code-2.1.321/LICENSE.md'), null)
  assert.equal(claudeFetchSpec('claude-code-2.1.321-beta1/claude'), null)
  assert.equal(claudeFetchSpec('claude-code-/claude'), null)
})

test('resolvePayloadFetchMode defaults to auto and rejects unknown values', () => {
  assert.equal(resolvePayloadFetchMode(undefined), 'auto')
  assert.equal(resolvePayloadFetchMode(''), 'auto')
  assert.equal(resolvePayloadFetchMode('PUSH'), 'push')
  assert.equal(resolvePayloadFetchMode(' remote '), 'remote')
  assert.equal(resolvePayloadFetchMode('yolo'), 'auto')
})

test('remoteFetchScript downloads to an exclusive temp, verifies, then atomically renames', () => {
  const script = remoteFetchScript({
    url: 'https://downloads.claude.ai/claude-code-releases/2.1.321/linux-x64/claude',
    file: '/srv/vms/vm-17/slot-bin/crag-v2/claude-code-2.1.321/claude',
    sha256: 'a'.repeat(64),
    mode: 0o755,
  })
  assert.match(script, /mktemp "\$\(dirname [^)]+\)\/\.kin-fetch\.XXXXXXXX"/)
  assert.match(script, /curl -fsSL --connect-timeout 10 --retry 2 -o "\$t" /)
  assert.match(script, /sha256sum -c/)
  assert.match(script, /chmod 755 "\$t"/)
  assert.match(script, /mv -f "\$t" "\$f"/)
  assert.match(script, /trap 'rm -f "\$t"' EXIT/)
  assert.doesNotMatch(script, /chown/)
})

test('remoteFetchScript quotes a hostile URL and sets owner when given', () => {
  const script = remoteFetchScript({
    url: "https://evil.example/'$(rm -rf /)'/claude",
    file: '/srv/x/claude',
    sha256: '0'.repeat(64),
    mode: 0o755,
    owner: { uid: 10017, gid: 10017 },
  })
  assert.ok(script.includes("'https://evil.example/'\\''$(rm -rf /)'\\''/claude'"))
  assert.match(script, /chown 10017:10017 "\$t"/)
})

/**
 * client.exec mock: remoteFetchFile commands (contain "curl") can be made to
 * fail; sha256sum probes consult a mutable shaByPath map, and a successful
 * fetch plants the expected hash — the download landed.
 */
function mockClient({ fetchExit = 0, fetchLandsWrongHash = false, shaByPath = new Map() } = {}) {
  const commands = []
  const client = {
    exec(command, callback) {
      commands.push(command)
      const stream = new EventEmitter()
      stream.stderr = new EventEmitter()
      stream.close = () => {}
      let code = 0
      let stdout = ''
      if (command.includes('curl')) {
        code = fetchExit
        if (code === 0) {
          const file = /f='\\''(.+?)'\\''/.exec(command)?.[1]
          const sha = /[0-9a-f]{64}/.exec(command)?.[0]
          if (file && sha) shaByPath.set(file, fetchLandsWrongHash ? 'd'.repeat(64) : sha)
        } else {
          stream.stderr.emit('data', Buffer.from('download failed'))
        }
      } else {
        const match = /f='\\''(.+?)'\\''/.exec(command) || /f='([^']+)'/.exec(command)
        const hash = match ? shaByPath.get(match[1]) : undefined
        if (!hash) code = 3
        else stdout = `${hash}  ${match[1]}`
      }
      callback(null, stream)
      if (stdout) stream.emit('data', Buffer.from(stdout))
      if (code !== 0) stream.stderr.emit('data', Buffer.from(`exit ${code}`))
      stream.emit('exit', code)
      stream.emit('close')
    },
  }
  return { client, commands }
}

/** Minimal sftp recording stub: writeRemoteFile must not run when fetch succeeds. */
function mockSftp() {
  const writes = []
  const call = (fn) =>
    new Promise((resolve, reject) => fn((err, value) => (err ? reject(err) : resolve(value))))
  const sftp = {
    writes,
    open: (file, flags, opts, cb) => cb(null, { tag: file }),
    write: (handle, data, off, len, remoteOff, cb) => {
      writes.push(handle.tag)
      cb(null)
    },
    fchmod: (handle, mode, cb) => cb(null),
    fchown: (handle, uid, gid, cb) => cb(null),
    close: (handle, cb) => cb(null),
    unlink: (file, cb) => cb(null),
    ext_openssh_rename: (from, to, cb) => cb(null),
  }
  sftp._call = call
  return sftp
}

function fixtureFile(root) {
  const src = path.join(root, 'claude')
  fs.writeFileSync(src, 'binary-bytes')
  return {
    rel: 'crag-v2/claude-code-2.1.321/claude',
    src,
    mode: 0o755,
    sha256: 'b'.repeat(64),
    fetch: claudeFetchSpec('claude-code-2.1.321/claude'),
  }
}

test('publishSlotBinFiles fetches a changed vendor binary node-side and skips SFTP', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-fetch-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = fixtureFile(root)
  // Empty map: the pre-check misses, the node-side fetch lands the file with
  // the expected hash, and the post-fetch re-hash confirms it.
  const { client, commands } = mockClient()
  const sftp = mockSftp()
  const result = await publishSlotBinFiles(sftp, client, '/srv/vm-17/slot-bin', [file], null, {
    fetchMode: 'auto',
  })
  assert.deepEqual(result.fetched, [file.rel])
  assert.deepEqual(result.written, [])
  assert.equal(sftp.writes.length, 0)
  assert.ok(commands.some((c) => c.includes('curl') && c.includes('claude-code-2.1.321')))
})

test('publishSlotBinFiles falls back to SFTP when the node-side fetch fails', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-fetch-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = fixtureFile(root)
  // shaByPath empty: pre-check reports missing; fetch fails; SFTP fallback runs
  // and the post-fetch re-hash stays missing, exercising the fallback fully.
  const { client } = mockClient({ fetchExit: 12 })
  const sftp = mockSftp()
  const result = await publishSlotBinFiles(sftp, client, '/srv/vm-17/slot-bin', [file], null, {
    fetchMode: 'auto',
  })
  assert.deepEqual(result.fetched, [])
  assert.deepEqual(result.written, [file.rel])
  assert.ok(sftp.writes.length > 0)
})

test('publishSlotBinFiles remote mode surfaces a failed fetch instead of falling back', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-fetch-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = fixtureFile(root)
  const { client } = mockClient({ fetchExit: 12 })
  const sftp = mockSftp()
  await assert.rejects(
    publishSlotBinFiles(sftp, client, '/srv/vm-17/slot-bin', [file], null, { fetchMode: 'remote' }),
    (error) => error.code === 'remote_fetch_failed',
  )
  assert.equal(sftp.writes.length, 0)
})

test('publishSlotBinFiles push mode never attempts a node-side fetch', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-fetch-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = fixtureFile(root)
  const { client, commands } = mockClient()
  const sftp = mockSftp()
  const result = await publishSlotBinFiles(sftp, client, '/srv/vm-17/slot-bin', [file], null, {
    fetchMode: 'push',
  })
  assert.deepEqual(result.written, [file.rel])
  assert.ok(commands.every((c) => !c.includes('curl')))
  assert.ok(sftp.writes.length > 0)
})

test('publishSlotBinFiles re-hashes after a fetch, so a wrong download still falls back', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-fetch-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = fixtureFile(root)
  // Fetch exits 0 but the landed bytes hash differently than expected.
  const { client } = mockClient({ fetchLandsWrongHash: true })
  const sftp = mockSftp()
  const result = await publishSlotBinFiles(sftp, client, '/srv/vm-17/slot-bin', [file], null, {
    fetchMode: 'auto',
  })
  assert.deepEqual(result.fetched, [])
  assert.deepEqual(result.written, [file.rel])
  assert.ok(sftp.writes.length > 0)
})
