import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { privateDirectoriesScript } from '../../src/lib/cluster/remote-fs.mjs'
import { ensureHostPrivateDir } from '../../src/lib/vm/private-dir.mjs'

test('remote private directories are chmodded without following a symlink', () => {
  const script = privateDirectoriesScript(['/slot/run/crag-license', '/slot/run/work'], { uid: 10000, gid: 10000 })
  assert.equal(script.includes('chmod -h'), false)
  assert.equal(script.includes('chown -h'), false)
  assert.match(script, /find -P "\$d" -maxdepth 0 -type d -exec chmod 700/)
  assert.match(script, /find -P "\$d" -maxdepth 0 -type d -exec chown 10000:10000/)
  assert.throws(() => privateDirectoriesScript(['/slot/run/work'], { uid: '1;rm', gid: 1 }))

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-private-remote-'))
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-private-target-'))
  try {
    fs.chmodSync(target, 0o755)
    const leaf = path.join(root, 'work')
    fs.symlinkSync(target, leaf)
    execFileSync('sh', ['-c', privateDirectoriesScript([leaf])], { stdio: 'pipe' })
    const replaced = fs.lstatSync(leaf)
    assert.equal(replaced.isSymbolicLink(), false)
    assert.equal(replaced.isDirectory(), true)
    assert.equal(replaced.mode & 0o777, 0o700)
    assert.equal(fs.statSync(target).mode & 0o777, 0o755)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(target, { recursive: true, force: true })
  }
})

test('local private directory creation does not chmod the symlink target', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-private-local-'))
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-private-local-target-'))
  try {
    fs.chmodSync(target, 0o755)
    const leaf = path.join(root, 'crag-native-assets')
    fs.symlinkSync(target, leaf)
    ensureHostPrivateDir(leaf)
    const replaced = fs.lstatSync(leaf)
    assert.equal(replaced.isSymbolicLink(), false)
    assert.equal(replaced.isDirectory(), true)
    assert.equal(replaced.mode & 0o777, 0o700)
    assert.equal(fs.statSync(target).mode & 0o777, 0o755)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(target, { recursive: true, force: true })
  }
})
