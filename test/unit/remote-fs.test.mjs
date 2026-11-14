import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ssh2 from 'ssh2'
import { connectSsh } from '../../src/lib/cluster/ssh-link.mjs'
import { openSftp, writeRemoteFile } from '../../src/lib/cluster/remote-fs.mjs'

const { Server, utils } = ssh2

test('remote atomic writes preserve UTF-8 byte offsets and do not follow destination symlinks', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-sftp-write-'))
  const handles = new Map()
  const connections = new Set()
  let pendingWrites = 0
  let peakWrites = 0
  let failAt = null
  let closedWithPendingWrites = false
  // ssh2 1.17 emits a malformed ed25519 OpenSSH key ~0.4% of the time; ECDSA keys parse every time.
  const server = new Server({ hostKeys: [utils.generateKeyPairSync('ecdsa', { bits: 256 }).private] }, (conn) => {
    connections.add(conn)
    conn.on('close', () => connections.delete(conn))
    conn.on('error', () => {})
    conn.on('authentication', (ctx) => ctx.accept())
    conn.on('session', (accept) => {
      accept().on('sftp', (acceptSftp) => {
        const sftp = acceptSftp()
        const reply = (id, fn) => {
          try {
            fn()
            sftp.status(id, utils.sftp.STATUS_CODE.OK)
          } catch (e) {
            sftp.status(id, utils.sftp.STATUS_CODE.FAILURE, e.message)
          }
        }
        sftp.on('OPEN', (id, file, flags, attrs) => {
          try {
            const fd = fs.openSync(file, utils.sftp.flagsToString(flags), attrs.mode)
            const handle = Buffer.from(String(fd))
            handles.set(handle.toString(), fd)
            sftp.handle(id, handle)
          } catch (e) {
            sftp.status(id, utils.sftp.STATUS_CODE.FAILURE, e.message)
          }
        })
        sftp.on('WRITE', (id, h, position, data) => {
          pendingWrites++
          peakWrites = Math.max(peakWrites, pendingWrites)
          // A distant node can accept more data before acknowledging earlier chunks.
          setTimeout(
            () => {
              pendingWrites--
              if (position === failAt) return sftp.status(id, utils.sftp.STATUS_CODE.FAILURE, 'disk full')
              reply(id, () => fs.writeSync(handles.get(h.toString()), data, 0, data.length, position))
            },
            position === failAt ? 1 : 10,
          )
        })
        sftp.on('FSETSTAT', (id, h, attrs) => reply(id, () => fs.fchmodSync(handles.get(h.toString()), attrs.mode)))
        sftp.on('CLOSE', (id, h) =>
          reply(id, () => {
            if (pendingWrites) closedWithPendingWrites = true
            fs.closeSync(handles.get(h.toString()))
            handles.delete(h.toString())
          }),
        )
        sftp.on('REMOVE', (id, file) => reply(id, () => fs.unlinkSync(file)))
        sftp.on('EXTENDED', (id, name, data) => {
          if (name !== 'posix-rename@openssh.com') return sftp.status(id, utils.sftp.STATUS_CODE.OP_UNSUPPORTED)
          const fromLength = data.readUInt32BE(0)
          const from = data.subarray(4, 4 + fromLength).toString()
          const toLength = data.readUInt32BE(4 + fromLength)
          const to = data.subarray(8 + fromLength, 8 + fromLength + toLength).toString()
          reply(id, () => fs.renameSync(from, to))
        })
      })
    })
  })
  t.after(async () => {
    for (const conn of connections) conn.end()
    await new Promise((resolve) => server.close(resolve))
    for (const fd of handles.values()) fs.closeSync(fd)
    fs.rmSync(root, { recursive: true, force: true })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { client } = await connectSsh({
    host: '127.0.0.1',
    port: server.address().port,
    username: 'u',
    authType: 'password',
    password: 'x',
  })
  const sftp = await openSftp(client)
  // ssh2's server implements our handler but does not advertise extensions.
  sftp._extensions['posix-rename@openssh.com'] = '1'
  const file = path.join(root, 'egress.json')
  const sibling = path.join(root, 'other-slot.json')
  fs.writeFileSync(sibling, 'other slot must stay unchanged')
  fs.symlinkSync(sibling, file)
  const text = JSON.stringify({ note: '出口🙂'.repeat(10000), listen_tcp: '127.0.0.1:21000' }) + '\n'
  await writeRemoteFile(sftp, file, text)
  assert.equal(fs.readFileSync(file, 'utf8'), text)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(fs.readFileSync(sibling, 'utf8'), 'other slot must stay unchanged')
  assert.ok(peakWrites > 1, 'large uploads must not wait one network round trip per 32 KiB')
  failAt = 32 * 1024
  await assert.rejects(writeRemoteFile(sftp, file, Buffer.alloc(96 * 1024, 7)), /写入.*失败/)
  assert.equal(fs.readFileSync(file, 'utf8'), text, 'a rejected upload must retain the prior complete file')
  assert.equal(pendingWrites, 0, 'all submitted writes must settle before failure cleanup')
  assert.equal(closedWithPendingWrites, false)
  assert.equal(handles.size, 0)
  failAt = null
  const binary = Buffer.from([0, 255, 128, 1])
  await writeRemoteFile(sftp, file, binary)
  assert.deepEqual(fs.readFileSync(file), binary)
  assert.deepEqual(fs.readdirSync(root).sort(), ['egress.json', 'other-slot.json'])
})
