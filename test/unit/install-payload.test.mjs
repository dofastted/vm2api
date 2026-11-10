import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('installation payload verifies and stages without cc-node', (t) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'deploy/payload.json'), 'utf8'))
  assert.equal(
    manifest.files.some((file) => file.asset === 'cc-node'),
    false,
  )
  assert.ok(manifest.files.some((file) => file.asset === 'cli-node'))
  assert.ok(manifest.files.some((file) => file.asset === 'kin-kernel'))

  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'install-payload-'))
  t.after(() => fs.rmSync(dest, { recursive: true, force: true }))
  // Exercise the real checker and stager without depending on proprietary binaries.
  for (const file of manifest.files) {
    const bytes = Buffer.from(file.asset)
    file.size = bytes.length
    file.sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
    const target = path.join(dest, file.path)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, bytes)
  }
  const fixtureManifest = path.join(dest, 'payload.json')
  fs.writeFileSync(fixtureManifest, JSON.stringify(manifest))
  const stage = path.join(dest, 'dist')
  for (const args of [['--check'], ['--stage', stage]]) {
    const result = spawnSync(
      process.execPath,
      [path.join(root, 'scripts/fetch-payload.mjs'), '--manifest', fixtureManifest, '--dest', dest, ...args],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
  }
  assert.equal(fs.existsSync(path.join(stage, 'cc-node')), false)
  assert.equal(fs.existsSync(path.join(stage, 'cli-node')), true)
})

test('installation and release scripts do not require cc-node', () => {
  const arm64 = fs.readFileSync(path.join(root, 'deploy/Dockerfile.arm64-control'), 'utf8')
  const release = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8')
  const installer = fs.readFileSync(path.join(root, 'deploy/install.sh'), 'utf8')
  assert.doesNotMatch(arm64, /image-wrap-cli\/cc-node/)
  assert.doesNotMatch(release, /dist\/cc-node/)
  assert.doesNotMatch(installer, /cc-node/)
})
