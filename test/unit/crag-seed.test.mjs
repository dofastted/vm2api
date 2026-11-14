import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { seedCragFactory } from '../../scripts/seed-crag.mjs'
import { cragV2Arch, verifyCragV2Tree } from '../../src/lib/vm/wrap-cli-runtime.mjs'
import { seedEncryptedPackage } from '../fixtures/crag-license.mjs'

const override = process.env.KIN_CRAG_V2_ROOT
before(() => {
  delete process.env.KIN_CRAG_V2_ROOT
})
after(() => {
  if (override == null) delete process.env.KIN_CRAG_V2_ROOT
  else process.env.KIN_CRAG_V2_ROOT = override
})

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-seed-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const image = path.join(base, 'image')
  const source = seedEncryptedPackage(image)
  const root = path.join(base, 'installation')
  const imageRoot = path.join(image, 'share/crag')
  const destination = path.join(root, 'share/crag/kernels/v2', cragV2Arch())
  return { root, source, imageRoot, destination }
}

function tree(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const file = path.join(dir, entry.name)
      return [entry.name, entry.isDirectory() ? tree(file) : fs.readFileSync(file)]
    })
}

test('empty installation receives the complete verified image package without a download selection or identity', {
  skip: cragV2Arch() !== 'amd64',
}, (t) => {
  const f = fixture(t)
  assert.equal(seedCragFactory(f.root, f.imageRoot).seeded, true)
  assert.equal(verifyCragV2Tree(f.destination).ok, true)
  assert.deepEqual(tree(f.destination), tree(f.source))
  assert.deepEqual(fs.readdirSync(path.dirname(f.destination)), ['amd64'])
  assert.equal(fs.existsSync(path.join(f.root, 'vms')), false)
})

test('existing factory and downloaded selection survive a different image issuer unchanged', {
  skip: cragV2Arch() !== 'amd64',
}, (t) => {
  const f = fixture(t)
  seedEncryptedPackage(f.root, { revision: 'existing' })
  const pointer = path.join(path.dirname(f.destination), 'current-amd64.json')
  const value = Buffer.from('{"package":"packages/amd64-operator-selection"}')
  fs.writeFileSync(pointer, value)
  const before = tree(path.dirname(f.destination))
  assert.equal(seedCragFactory(f.root, f.imageRoot).seeded, false)
  assert.deepEqual(tree(path.dirname(f.destination)), before)
})

test('tampered image package cannot publish a factory', { skip: cragV2Arch() !== 'amd64' }, (t) => {
  const f = fixture(t)
  fs.appendFileSync(path.join(f.source, 'crag-v2.payload.enc'), 'tampered')
  assert.throws(() => seedCragFactory(f.root, f.imageRoot), /crag_v2_hash_mismatch/)
  assert.equal(fs.existsSync(f.destination), false)
  assert.deepEqual(fs.readdirSync(path.dirname(f.destination)), [])
})

test('unsupported architecture and explicit package override leave the installation untouched', (t) => {
  const f = fixture(t)
  assert.equal(seedCragFactory(f.root, f.imageRoot, { arch: 'arm64' }).reason, 'unsupported_arch')
  assert.equal(fs.existsSync(f.root), false)
  process.env.KIN_CRAG_V2_ROOT = f.source
  try {
    assert.equal(seedCragFactory(f.root, f.imageRoot, { arch: 'amd64' }).reason, 'custom_package')
    assert.equal(fs.existsSync(f.root), false)
  } finally {
    delete process.env.KIN_CRAG_V2_ROOT
  }
})
