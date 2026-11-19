import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { materializeAntigravityCli, publishAntigravitySlotAssets } from '../../src/lib/oauth/antigravity-auth-login.mjs'

const vm = { id: 'vm-asset-01', platform: 'antigravity' }

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-slot-assets-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'trusted-asset')
  fs.writeFileSync(source, 'official-asset-fixture')
  const home = path.join(root, 'vms', vm.id, 'cli-home')
  return { root, source, home }
}

test('slot assets publish executables, directories and empty cancellation markers with private modes', (t) => {
  const { root, source, home } = fixture(t)
  assert.equal(materializeAntigravityCli(root, vm, { source }), '/home/kincli/.local/bin/agy')
  publishAntigravitySlotAssets(root, vm, {
    files: [{ source, path: '.kin/antigravity-auth-exec.py' }],
    directories: ['.cache/tmp'],
    markers: ['.cache/tmp/antigravity-auth-session.json.cancel'],
  })
  for (const relative of ['.local/bin/agy', '.kin/antigravity-auth-exec.py']) {
    const file = path.join(home, relative)
    assert.equal(fs.readFileSync(file, 'utf8'), 'official-asset-fixture')
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false)
    assert.equal(fs.statSync(file).mode & 0o777, 0o755)
  }
  assert.equal(fs.statSync(path.join(home, '.cache/tmp')).mode & 0o777, 0o700)
  const marker = path.join(home, '.cache/tmp/antigravity-auth-session.json.cancel')
  assert.equal(fs.statSync(marker).size, 0)
  assert.equal(fs.statSync(marker).mode & 0o777, 0o600)
})

test('preplanted executable and predictable temporary symlinks cannot overwrite a file outside the slot', (t) => {
  const { root, source, home } = fixture(t)
  const victim = path.join(root, 'outside-slot-config')
  fs.writeFileSync(victim, 'private-config-must-remain', { mode: 0o640 })
  const bin = path.join(home, '.local/bin')
  fs.mkdirSync(bin, { recursive: true })
  const target = path.join(bin, 'agy')
  fs.symlinkSync(victim, target)
  fs.symlinkSync(victim, `${target}.${process.pid}.tmp`)
  materializeAntigravityCli(root, vm, { source })
  assert.equal(fs.readFileSync(victim, 'utf8'), 'private-config-must-remain')
  assert.equal(fs.statSync(victim).mode & 0o777, 0o640)
  assert.equal(fs.lstatSync(target).isSymbolicLink(), false)
  assert.equal(fs.readFileSync(target, 'utf8'), 'official-asset-fixture')
  assert.equal(fs.lstatSync(`${target}.${process.pid}.tmp`).isSymbolicLink(), true)
  assert.deepEqual(fs.readdirSync(bin).sort(), ['agy', `agy.${process.pid}.tmp`].sort())
})

test('cancellation marker replaces its symlink entry without truncating or chmodding the outside victim', (t) => {
  const { root, home } = fixture(t)
  const victim = path.join(root, 'outside-cancel-target')
  fs.writeFileSync(victim, 'do-not-truncate', { mode: 0o640 })
  const marker = path.join(home, '.cache/tmp/antigravity-auth-session.json.cancel')
  fs.mkdirSync(path.dirname(marker), { recursive: true })
  fs.symlinkSync(victim, marker)
  publishAntigravitySlotAssets(root, vm, { markers: ['.cache/tmp/antigravity-auth-session.json.cancel'] })
  assert.equal(fs.readFileSync(victim, 'utf8'), 'do-not-truncate')
  assert.equal(fs.statSync(victim).mode & 0o777, 0o640)
  assert.equal(fs.lstatSync(marker).isSymbolicLink(), false)
  assert.equal(fs.statSync(marker).size, 0)
})

test('each untrusted parent directory rejects symlinks before publishing or changing outside ownership', async (t) => {
  for (const [relative, operation] of [
    ['.local', 'cli'],
    ['.local/bin', 'cli'],
    ['.kin', 'wrapper'],
    ['.cache', 'marker'],
    ['.cache/tmp', 'marker'],
    ['', 'cli'],
  ]) {
    await t.test(relative || 'cli-home', (subtest) => {
      const { root, source, home } = fixture(subtest)
      const outside = path.join(root, 'outside-slot')
      fs.mkdirSync(outside, { mode: 0o750 })
      const victim = path.join(outside, 'untouched')
      fs.writeFileSync(victim, 'private-victim-data', { mode: 0o640 })
      const link = relative ? path.join(home, relative) : home
      fs.mkdirSync(path.dirname(link), { recursive: true })
      fs.symlinkSync(outside, link)
      const before = fs.statSync(outside)
      assert.throws(() => {
        if (operation === 'cli') materializeAntigravityCli(root, vm, { source })
        else if (operation === 'wrapper')
          publishAntigravitySlotAssets(root, vm, { files: [{ source, path: '.kin/antigravity-auth-exec.py' }] })
        else publishAntigravitySlotAssets(root, vm, { markers: ['.cache/tmp/auth.json.cancel'] })
      })
      const after = fs.statSync(outside)
      assert.equal(after.mode, before.mode)
      assert.equal(after.uid, before.uid)
      assert.equal(after.gid, before.gid)
      assert.deepEqual(fs.readdirSync(outside), ['untouched'])
      assert.equal(fs.readFileSync(victim, 'utf8'), 'private-victim-data')
    })
  }
})

test('invalid relative destinations and source symlinks fail without replacing an existing asset', (t) => {
  const { root, source, home } = fixture(t)
  materializeAntigravityCli(root, vm, { source })
  const original = path.join(home, '.local/bin/agy')
  for (const relative of ['../outside-slot-config', '/outside-slot-config', '.local/../outside-slot-config']) {
    assert.throws(() => publishAntigravitySlotAssets(root, vm, { files: [{ source, path: relative }] }))
  }
  const linkedSource = path.join(root, 'source-symlink')
  fs.symlinkSync(source, linkedSource)
  assert.throws(() => materializeAntigravityCli(root, vm, { source: linkedSource }))
  assert.equal(fs.readFileSync(original, 'utf8'), 'official-asset-fixture')
  assert.deepEqual(fs.readdirSync(path.dirname(original)), ['agy'])
  assert.equal(fs.existsSync(path.join(root, 'outside-slot-config')), false)
})
