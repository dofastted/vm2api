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
  if (manifest.crag_debian13_release?.tag && manifest.crag_debian13_release?.assets) {
    const osDir = manifest.crag_debian13_release.dest_dir || 'share/os/crag-debian13'
    for (const [asset, entry] of Object.entries(manifest.crag_debian13_release.assets)) {
      const bytes = Buffer.from(`fixture:${asset}`)
      entry.size = bytes.length
      entry.sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
      const target = path.join(dest, osDir, asset)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, bytes)
    }
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
  if (manifest.crag_debian13_release?.tag) {
    assert.equal(fs.existsSync(path.join(stage, 'kin-kvm-debian-13.erofs')), true)
    assert.equal(fs.existsSync(path.join(stage, 'vmlinuz')), true)
    assert.equal(fs.existsSync(path.join(stage, 'initrd.img')), true)
  }
})

test('installation and release scripts do not require cc-node', () => {
  const arm64 = fs.readFileSync(path.join(root, 'deploy/Dockerfile.arm64-control'), 'utf8')
  const release = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8')
  const installer = fs.readFileSync(path.join(root, 'deploy/install.sh'), 'utf8')
  assert.doesNotMatch(arm64, /image-wrap-cli\/cc-node/)
  assert.doesNotMatch(release, /dist\/cc-node/)
  assert.doesNotMatch(installer, /cc-node/)
})

test('the release manifest job publishes amd64 tags even when the ARM64 image is missing', () => {
  const release = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8')
  const manifest = release.slice(release.indexOf('\n  manifest:'))
  // Gating on amd64 alone keeps `latest` and the bare version tag from freezing on an older
  // release every time the ARM64 smoke test fails.
  assert.ok(manifest.includes("if: ${{ !cancelled() && needs.image-amd64.result == 'success' }}"))
  assert.ok(manifest.includes('sources=("${image}:${ref}-amd64")'))
  assert.match(
    manifest,
    /if \[ "\$\{ARM64_RESULT\}" = "success" \]; then\n\s+sources\+=\("\$\{image\}:\$\{ref\}-arm64"\)\n\s+expected="amd64 arm64"/,
  )
  // The published list is still checked against the architectures that actually got built.
  assert.ok(manifest.includes('missing = expected - found'))
})

test('macOS host preparation binds the platform UUID and does not overwrite it on a different host', (t) => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'install-crag-host-'))
  t.after(() => fs.rmSync(dest, { recursive: true, force: true }))
  const bin = path.join(dest, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(dest, '.env'), '')
  for (const [name, script] of Object.entries({
    id: 'echo 0',
    uname: 'echo Darwin',
    ioreg: `printf '    "IOPlatformUUID" = "%s"\n' "$TEST_HOST_UUID"`,
  })) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
  }
  const run = (uuid) =>
    spawnSync('bash', [path.join(root, 'deploy/install.sh'), 'prepare-crag-host', '--dir', dest], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_HOST_UUID: uuid, VM2API_CRAG_HOST_ID_FILE: '' },
    })
  const original = '12345678-90AB-CDEF-1234-567890ABCDEF'
  const file = path.join(dest, '.local', 'crag-host-machine-id')
  const prepared = run(original)
  assert.equal(prepared.status, 0, prepared.stderr)
  assert.equal(fs.readFileSync(file, 'utf8'), '1234567890abcdef1234567890abcdef\n')
  assert.match(
    fs.readFileSync(path.join(dest, '.env'), 'utf8'),
    /^VM2API_CRAG_HOST_ID_FILE=\.\/\.local\/crag-host-machine-id$/m,
  )
  assert.equal(run(original).status, 0)
  assert.equal(run('87654321-90AB-CDEF-1234-567890ABCDEF').status, 1)
  assert.equal(fs.readFileSync(file, 'utf8'), '1234567890abcdef1234567890abcdef\n')
})
