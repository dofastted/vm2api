import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('control-plane Dockerfiles build kin-api-kernel into image-bin', () => {
  for (const rel of ['Dockerfile', 'deploy/Dockerfile.arm64-control']) {
    const body = fs.readFileSync(path.join(root, rel), 'utf8')
    assert.match(body, /kin-api-kernel/, rel)
    assert.match(body, /api-kernel/, rel)
  }
})

test('docker entrypoint refreshes kin-api-kernel before Node starts', () => {
  const entry = fs.readFileSync(path.join(root, 'scripts/docker-entrypoint.sh'), 'utf8')
  assert.match(entry, /ensure_bin kin-api-kernel/)
  assert.match(entry, /KIN_API_KERNEL_BIN/)
})

test('control-plane images include the guest AppArmor helper used by remote KVM slots', () => {
  const helper = 'docker/kin-kvm/guest/kin-crag-apparmor'
  assert.ok(fs.existsSync(path.join(root, helper)))
  for (const rel of ['Dockerfile', 'deploy/Dockerfile.arm64-control']) {
    const body = fs.readFileSync(path.join(root, rel), 'utf8')
    const copies = body
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter(([instruction]) => instruction === 'COPY')
    assert.ok(
      copies.some(([, source, destination]) => {
        if (!source || !destination) return false
        const target = destination.replace(/^\.\//, '').replace(/\/$/, '')
        return source === target && (helper === source || helper.startsWith(`${source}/`))
      }),
      `${rel} must ship ${helper} at its runtime path`,
    )
  }
})
