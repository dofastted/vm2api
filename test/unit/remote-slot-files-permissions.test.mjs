import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { remoteSlotOwner } from '../../src/lib/cluster/placement.mjs'
import { pushSlotFiles } from '../../src/lib/cluster/remote-slot-files.mjs'

for (const login of ['root', 'non-root']) {
  for (const existing of [false, true]) {
    test(`${login} SSH prepares ${existing ? 'existing' : 'new'} slot binaries without exposing private directories`, {
      skip: process.platform === 'win32' || (login === 'root') !== (process.getuid() === 0),
    }, async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "kin-slot permissions'"))
      t.after(() => fs.rmSync(root, { recursive: true, force: true }))
      const vm = { id: 'vm-07' }
      const host = {
        root,
        uid: process.getuid(),
        gid: process.getgid(),
      }
      const dir = path.join(root, 'vms', vm.id)
      const privateDirs = [dir, ...['run', 'claude', 'cli-home'].map((name) => path.join(dir, name))]
      const binDir = path.join(dir, 'slot-bin')
      if (existing) {
        for (const privateDir of privateDirs) {
          fs.mkdirSync(privateDir, { recursive: true })
          fs.chmodSync(privateDir, 0o755)
        }
        fs.mkdirSync(binDir)
        fs.chmodSync(binDir, 0o700)
      }
      const sftp = new EventEmitter()
      const client = {
        sftp: (callback) => callback(null, sftp),
        exec: (command, callback) => {
          const stream = new EventEmitter()
          stream.stderr = new EventEmitter()
          stream.close = () => {}
          callback(null, stream)
          let code = 0
          try {
            execFileSync('sh', ['-c', command], { stdio: 'pipe' })
          } catch (error) {
            stream.stderr.emit('data', error.stderr || Buffer.from(error.message))
            code = error.status || 1
          }
          stream.emit('exit', code)
          stream.emit('close')
        },
      }
      await pushSlotFiles(vm, root, [], { host, client })
      assert.equal(fs.statSync(binDir).mode & 0o777, 0o755)
      for (const privateDir of privateDirs) {
        assert.equal(fs.statSync(privateDir).mode & 0o777, 0o700)
      }
      if (login === 'root') {
        const owner = remoteSlotOwner(host, vm)
        for (const ownedDir of [...privateDirs, binDir]) {
          const stat = fs.statSync(ownedDir)
          assert.equal(stat.uid, owner.uid)
          assert.equal(stat.gid, owner.gid)
        }
      }
    })
  }
}
