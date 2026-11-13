import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bindPlacement, unbindPlacement } from '../../src/lib/cluster/placement.mjs'
import { pushSlotFiles } from '../../src/lib/cluster/remote-slot-files.mjs'

/** In-memory node: SFTP writes, `dd … | base64` reads, `sha256sum` and plain shell commands. */
function fakeNode() {
  const files = new Map()
  const modes = new Map()
  const renames = []
  const commands = []
  const handles = new Map()
  const sftp = new EventEmitter()
  const ok = (cb, v) => setImmediate(() => cb(null, v))
  sftp.open = (p, _flags, attrs, cb) => {
    const h = Buffer.from(String(handles.size))
    handles.set(h.toString(), { p, chunks: [] })
    modes.set(p, attrs.mode)
    ok(cb, h)
  }
  sftp.write = (h, buf, off, len, _pos, cb) => {
    handles.get(h.toString()).chunks.push(Buffer.from(buf.subarray(off, off + len)))
    ok(cb)
  }
  sftp.fchmod = (h, mode, cb) => {
    modes.set(handles.get(h.toString()).p, mode)
    ok(cb)
  }
  sftp.fchown = (_h, _u, _g, cb) => ok(cb)
  sftp.close = (h, cb) => {
    const e = handles.get(h.toString())
    files.set(e.p, Buffer.concat(e.chunks))
    ok(cb)
  }
  sftp.unlink = (p, cb) => {
    files.delete(p)
    ok(cb)
  }
  sftp.ext_openssh_rename = (from, to, cb) => {
    files.set(to, files.get(from))
    modes.set(to, modes.get(from))
    files.delete(from)
    renames.push(to)
    ok(cb)
  }
  const client = {
    sftp: (cb) => ok(cb, sftp),
    exec: (cmd, cb) => {
      const stream = new EventEmitter()
      stream.stderr = new EventEmitter()
      stream.close = () => {}
      ok(cb, stream)
      commands.push(cmd)
      const p = /f='\\''(.+?)'\\''/.exec(cmd)?.[1]
      let code = 0
      let out = ''
      if (p && cmd.includes('iflag=nofollow')) {
        if (files.has(p)) out = files.get(p).toString('base64')
        else code = 3
      } else if (p && cmd.includes('sha256sum')) {
        if (files.has(p)) out = `${crypto.createHash('sha256').update(files.get(p)).digest('hex')}  ${p}\n`
        else code = 3
      }
      setImmediate(() => {
        if (out) stream.emit('data', Buffer.from(out))
        stream.emit('exit', code)
        stream.emit('close')
      })
    },
  }
  const host = { uid: 1000, gid: 1000, home: '/home/ubuntu', root: '/home/ubuntu/.vm2api', sudo: true }
  return { files, modes, renames, commands, session: { nodeId: 'node-t', client, host } }
}

const vm = { id: 'vm-07', node_id: 'node-t', runtime: { type: 'kvm' } }
const remote = '/home/ubuntu/.vm2api/vms/vm-07'

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-live-payload-'))
  const saved = ['KIN_WRAP_CLI_ROOT', 'KIN_KERNEL_BIN'].map((key) => [key, process.env[key]])
  const wrap = path.join(root, 'wrap')
  fs.mkdirSync(path.join(wrap, 'glibc239'), { recursive: true })
  fs.writeFileSync(path.join(wrap, 'kin-kernel.bin'), 'kernel-v1')
  fs.writeFileSync(path.join(wrap, 'cli-node'), 'cli-node-v1')
  fs.writeFileSync(path.join(wrap, 'glibc239', 'libc.so.6'), 'libc')
  process.env.KIN_WRAP_CLI_ROOT = wrap
  delete process.env.KIN_KERNEL_BIN
  bindPlacement({ manager: {}, projectRoot: root, getRouting: () => ({}) })
  const slotDir = path.join(root, 'vms', vm.id)
  fs.mkdirSync(path.join(slotDir, 'run'), { recursive: true })
  fs.writeFileSync(
    path.join(slotDir, 'run/kernel.json'),
    JSON.stringify({ dataplane: 'wrap', claude_bin: '/opt/kin-live/cli-node' }),
  )
  t.after(() => {
    unbindPlacement()
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { wrap, slotDir }
}

test('a run publish lands the live payload in slot-bin before the kernel.json that names it', async (t) => {
  const { wrap, slotDir } = setup(t)
  const node = fakeNode()
  await pushSlotFiles(vm, slotDir, ['run'], node.session)

  const bin = `${remote}/slot-bin`
  assert.equal(node.files.get(`${bin}/cli-node`)?.toString(), 'cli-node-v1')
  assert.equal(node.files.get(`${bin}/kin-kernel.bin`)?.toString(), 'kernel-v1')
  assert.equal(node.files.get(`${bin}/glibc239/libc.so.6`)?.toString(), 'libc')
  assert.match(node.files.get(`${bin}/kin-kernel`)?.toString() || '', /^#!\/bin\/sh/)
  assert.equal(node.modes.get(`${bin}/cli-node`), 0o755)
  assert.ok(
    node.renames.indexOf(`${bin}/cli-node`) < node.renames.indexOf(`${remote}/run/kernel.json`),
    'cli-node must exist before kernel.json points the kernel at it',
  )
  assert.equal(
    node.files.get(`${remote}/cli-home/.kin/kin-kernel`)?.toString(),
    '#!/bin/sh\nexec /opt/kin-live/kin-kernel "$@"\n',
  )
  const mkdirs = node.commands.filter((cmd) => cmd.includes('mkdir -p') && cmd.includes('slot-bin/'))
  assert.ok(mkdirs.some((cmd) => cmd.includes(`${bin}/glibc239`)))
  for (const bogus of ['cli-nod', 'kin-kerne', 'kin-kernel.bi'])
    assert.ok(!mkdirs.some((cmd) => cmd.includes(`${bin}/${bogus}'`)), `no ${bogus} directory`)

  node.renames.length = 0
  await pushSlotFiles(vm, slotDir, ['run'], node.session)
  assert.deepEqual(
    node.renames.filter((p) => p.startsWith(`${bin}/`)),
    [],
    'an unchanged payload is not re-sent',
  )

  fs.writeFileSync(path.join(wrap, 'cli-node'), 'cli-node-v2')
  fs.utimesSync(path.join(wrap, 'cli-node'), new Date(), new Date(Date.now() + 5_000))
  node.renames.length = 0
  await pushSlotFiles(vm, slotDir, ['run'], node.session)
  assert.equal(node.files.get(`${bin}/cli-node`)?.toString(), 'cli-node-v2')
  assert.deepEqual(
    node.renames.filter((p) => p.startsWith(`${bin}/`)),
    [`${bin}/cli-node`, `${bin}/kin-live.digest`],
    'only the changed file and the marker are written',
  )
})

test('a run publish without the payload it names keeps the node on its previous kernel.json', async (t) => {
  const { wrap, slotDir } = setup(t)
  fs.rmSync(path.join(wrap, 'cli-node'))
  const node = fakeNode()
  node.files.set(`${remote}/run/kernel.json`, Buffer.from('previous'))
  await assert.rejects(pushSlotFiles(vm, slotDir, ['run'], node.session), { code: 'kernel_package_missing' })
  assert.equal(node.files.get(`${remote}/run/kernel.json`).toString(), 'previous')
  assert.equal(node.files.has(`${remote}/cli-home/.kin/kin-kernel`), false)
})
