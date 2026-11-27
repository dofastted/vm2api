import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  OS_CATALOG,
  OS_ORDER,
  OS_REGISTRY,
  KVM_BUILD_DIR,
  imageForKernel,
  kvmImageForKernel,
  buildDirForKernel,
  normalizeOsKernel,
} from '../../src/lib/vm/os-catalog.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('kvm catalog covers every OS with image + official cloud_image', () => {
  assert.equal(KVM_BUILD_DIR, 'docker/kin-kvm')
  assert.deepEqual(OS_ORDER, ['ubuntu-24.04', 'debian-12', 'archlinux', 'fedora-41', 'crag-debian13'])
  const expect = {
    'ubuntu-24.04': { image: `${OS_REGISTRY}/kin-kvm-ubuntu:24.04`, needle: 'noble-server-cloudimg-amd64' },
    'debian-12': { image: `${OS_REGISTRY}/kin-kvm-debian:12`, needle: 'debian-12-generic-amd64.qcow2' },
    archlinux: { image: `${OS_REGISTRY}/kin-kvm-arch:latest`, needle: 'Arch-Linux-x86_64-cloudimg' },
    'fedora-41': { image: `${OS_REGISTRY}/kin-kvm-fedora:41`, needle: 'Fedora-Cloud-Base-Generic-41' },
    'crag-debian13': { image: `${OS_REGISTRY}/kin-kvm-debian:13`, needle: 'debian-13-generic-amd64.qcow2' },
  }
  for (const kernel of OS_ORDER) {
    const kvm = OS_CATALOG[kernel].kvm
    assert.equal(kvm.image, expect[kernel].image)
    assert.match(kvm.cloud_image, /^https:\/\//)
    assert.ok(kvm.cloud_image.includes(expect[kernel].needle), kvm.cloud_image)
    assert.equal(kvmImageForKernel(kernel), kvm.image)
  }
  assert.equal(OS_CATALOG['debian-13'], OS_CATALOG['crag-debian13'])
  assert.equal(Object.keys(OS_CATALOG).includes('debian-13'), false)
  assert.equal(normalizeOsKernel('debian-13'), 'crag-debian13')
  assert.equal(normalizeOsKernel('crag-debian13'), 'crag-debian13')
  assert.equal(OS_CATALOG['crag-debian13'].kvm.erofs_image, 'kin-kvm-debian-13.erofs')
  assert.equal(kvmImageForKernel('unknown'), kvmImageForKernel('ubuntu-24.04'))
  assert.equal(imageForKernel('ubuntu-24.04'), `${OS_REGISTRY}/kin-os-ubuntu:24.04`)
  assert.equal(imageForKernel('crag-debian13'), `${OS_REGISTRY}/kin-os-debian:13-baked`)
  assert.equal(imageForKernel('debian-13'), `${OS_REGISTRY}/kin-os-debian:13-baked`)
  assert.equal(buildDirForKernel('debian-12'), 'debian-12')
  assert.equal(buildDirForKernel('crag-debian13'), 'debian-13')
})

test('guest-images workflow publishes debian-13 baked guest and SKIP_CLOUD_IMAGE=1 kin-kvm-debian:13 runner', () => {
  const workflow = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/guest-images.yml'), 'utf8')
  assert.match(workflow, /directory:\s*debian-13\s*\n\s*image:\s*debian:13-baked/)
  assert.match(workflow, /family:\s*debian\s*\n\s*tag:\s*'13'\s*\n\s*cloud_image:\s*''\s*\n\s*skip_cloud_image:\s*'1'/)
  assert.ok(workflow.includes("SKIP_CLOUD_IMAGE=${{ matrix.skip_cloud_image || '0' }}"))
})
