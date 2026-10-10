#!/usr/bin/env node
/**
 * KVM runner provisioning: pull prebuilt kin-kvm images, fall back to the
 * in-repo Dockerfile. `--pull-only` never builds (boot prewarm must not block
 * on downloading a cloud image; the slot start path builds lazily).
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OS_CATALOG, KVM_BUILD_DIR } from '../../src/lib/vm/os-catalog.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const force = args.includes('--force')
const pullOnly = args.includes('--pull-only')
const pull = pullOnly || args.includes('--pull')
const only = args.filter((a) => !a.startsWith('--'))

function imageExists(tag) {
  return spawnSync('docker', ['image', 'inspect', tag], { stdio: 'ignore' }).status === 0
}

for (const [kernel, meta] of Object.entries(OS_CATALOG)) {
  const kvm = meta.kvm
  if (!kvm?.image || !kvm?.cloud_image) continue
  if (
    only.length &&
    !only.some(
      (arg) =>
        kernel.includes(arg) ||
        meta.dir.includes(arg) ||
        meta.family === arg ||
        kvm.image.includes(arg),
    )
  ) {
    continue
  }
  if (!force && imageExists(kvm.image)) {
    console.log(`vm2api: skip existing ${kvm.image}`)
    continue
  }
  if (pull && spawnSync('docker', ['pull', kvm.image], { stdio: 'inherit' }).status === 0) continue
  if (pullOnly) {
    console.warn(`vm2api: ${kvm.image} not pulled; will build on first slot start`)
    continue
  }
  const context = path.resolve(root, '..', '..', KVM_BUILD_DIR)
  const r = spawnSync(
    'docker',
    ['build', '-t', kvm.image, '--build-arg', `CLOUD_IMAGE_URL=${kvm.cloud_image}`, context],
    { stdio: 'inherit' },
  )
  if (r.status !== 0) process.exit(r.status || 1)
}
