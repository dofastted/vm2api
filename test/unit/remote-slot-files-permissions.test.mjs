import '../fixtures/kin-computer-test-env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { remoteSlotOwner } from '../../src/lib/cluster/placement.mjs'
import { pushSlotFiles, pushSlotFingerprint } from '../../src/lib/cluster/remote-slot-files.mjs'

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

test('cluster Docker pushSlotFiles syncs /etc/kin-computer and DMI fingerprint tree with 0755/0644 modes', {
  skip: process.platform === 'win32',
}, async (t) => {
  const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-control-fp-'))
  const nodeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-node-fp-'))
  t.after(() => {
    fs.rmSync(controlRoot, { recursive: true, force: true })
    fs.rmSync(nodeRoot, { recursive: true, force: true })
  })
  const vm = { id: 'vm-07', node_id: 'node-a', runtime: { type: 'docker' } }
  const slotDir = path.join(controlRoot, 'vms', vm.id)
  fs.mkdirSync(path.join(slotDir, 'cli-home', '.claude'), { recursive: true })
  for (const [name, body] of [
    ['settings.json', '{"env":{}}'],
    ['claude.setting', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1\n'],
    ['kin-seed.json', '{"telemetry":"enabled"}'],
  ]) {
    fs.writeFileSync(path.join(slotDir, 'cli-home', '.claude', name), body)
  }
  const host = { root: nodeRoot, uid: process.getuid(), gid: process.getgid() }
  const handles = new Map()
  let nextHandle = 1
  const sftp = new EventEmitter()
  sftp.open = (file, flags, attrs, cb) => {
    try {
      const fd = fs.openSync(file, flags, attrs.mode)
      const h = Buffer.from(String(nextHandle++))
      handles.set(h.toString(), fd)
      cb(null, h)
    } catch (err) {
      cb(err)
    }
  }
  sftp.write = (h, buf, off, len, pos, cb) => {
    try {
      fs.writeSync(handles.get(h.toString()), buf, off, len, pos)
      cb(null)
    } catch (err) {
      cb(err)
    }
  }
  sftp.fchmod = (h, mode, cb) => {
    try {
      fs.fchmodSync(handles.get(h.toString()), mode)
      cb(null)
    } catch (err) {
      cb(err)
    }
  }
  sftp.fchown = (_h, _uid, _gid, cb) => cb(null)
  sftp.close = (h, cb) => {
    try {
      fs.closeSync(handles.get(h.toString()))
      handles.delete(h.toString())
      cb(null)
    } catch (err) {
      cb(err)
    }
  }
  sftp.unlink = (file, cb) => {
    try {
      fs.unlinkSync(file)
      cb(null)
    } catch (err) {
      cb(err)
    }
  }
  sftp.ext_openssh_rename = (from, to, cb) => {
    try {
      fs.renameSync(from, to)
      cb(null)
    } catch (err) {
      cb(err)
    }
  }
  const client = {
    sftp: (cb) => cb(null, sftp),
    exec: (command, cb) => {
      const stream = new EventEmitter()
      stream.stderr = new EventEmitter()
      stream.close = () => {}
      cb(null, stream)
      let code = 0
      try {
        execFileSync('sh', ['-c', command], { stdio: 'pipe' })
      } catch (err) {
        stream.stderr.emit('data', err.stderr || Buffer.from(err.message))
        code = err.status || 1
      }
      stream.emit('exit', code)
      stream.emit('close')
    },
  }

  // Simulate a stale Docker-created directory where kin-computer file belongs on the node.
  const remoteFp = path.join(nodeRoot, 'vms', vm.id, 'fingerprint')
  fs.mkdirSync(path.join(remoteFp, 'system', 'etc', 'kin-computer'), { recursive: true })

  const vmFile = path.join(controlRoot, 'vms', `${vm.id}.json`)
  const originalRecord = JSON.stringify({
    id: vm.id,
    node_id: vm.node_id,
    runtime: vm.runtime,
    fingerprint: { hostname: 'legacy-host', guest_machine_id: '1'.repeat(32) },
  })
  fs.writeFileSync(vmFile, originalRecord)

  // Policy publication (seed_settings) pushes fingerprint files without mutating vms/<id>.json on disk.
  const result = await pushSlotFiles(vm, slotDir, ['seed_settings'], { host, client })
  assert.ok(result.pushed.includes('kvm/fingerprint/system/etc/kin-computer'))
  assert.ok(result.pushed.includes('cli-home/.claude/settings.json'))
  assert.equal(fs.readFileSync(vmFile, 'utf8'), originalRecord)

  // Lifecycle seed sync (seed) remembers the computer identity and writes machine-id.
  const seeded = await pushSlotFiles(vm, slotDir, ['seed'], { host, client })
  assert.ok(seeded.pushed.includes('machine-id'))
  assert.ok(vm.fingerprint?.hostname && vm.fingerprint.hostname !== 'legacy-host')
  assert.ok(vm.fingerprint?.guest_machine_id && vm.fingerprint.guest_machine_id !== '1'.repeat(32))

  for (const relDir of ['', 'system', 'system/etc', 'system/dmi', 'system/dmi/id', 'system/hardware']) {
    const stat = fs.statSync(path.join(remoteFp, relDir))
    assert.equal(stat.isDirectory(), true)
    assert.equal(stat.mode & 0o777, 0o755, `expected 0755 on remote ${relDir || 'fingerprint'}`)
  }
  for (const relFile of [
    'system/etc/kin-computer',
    'system/etc/hostname',
    'system/etc/machine-id',
    'system/hardware/mac',
    'system/dmi/id/sys_vendor',
  ]) {
    const full = path.join(remoteFp, relFile)
    const stat = fs.statSync(full)
    assert.equal(stat.isFile(), true)
    assert.equal(stat.mode & 0o777, 0o644, `expected 0644 on remote ${relFile}`)
  }
  assert.equal(fs.readFileSync(path.join(remoteFp, 'system', 'etc', 'kin-computer'), 'utf8'), 'source=linux-pc\n')

  const kvmSkipped = await pushSlotFingerprint({ id: 'vm-kvm', runtime: { type: 'kvm' } }, controlRoot, {
    host,
    client,
  })
  assert.equal(kvmSkipped.pushed, false)
  assert.equal(kvmSkipped.skipped, 'not_docker')
})
