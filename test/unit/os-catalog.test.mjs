import test from 'node:test'
import assert from 'node:assert/strict'
import {
  OS_CATALOG,
  OS_ORDER,
  OS_REGISTRY,
  KVM_BUILD_DIR,
  imageForKernel,
  kvmImageForKernel,
  buildDirForKernel,
} from '../../src/lib/vm/os-catalog.mjs'

test('kvm catalog covers every OS with image + official cloud_image', () => {
  assert.equal(KVM_BUILD_DIR, 'docker/kin-kvm')
  assert.deepEqual(OS_ORDER, ['ubuntu-24.04', 'debian-12', 'archlinux', 'fedora-41'])
  const expect = {
    'ubuntu-24.04': { image: `${OS_REGISTRY}/kin-kvm-ubuntu:24.04`, needle: 'noble-server-cloudimg-amd64' },
    'debian-12': { image: `${OS_REGISTRY}/kin-kvm-debian:12`, needle: 'debian-12-generic-amd64.qcow2' },
    archlinux: { image: `${OS_REGISTRY}/kin-kvm-arch:latest`, needle: 'Arch-Linux-x86_64-cloudimg' },
    'fedora-41': { image: `${OS_REGISTRY}/kin-kvm-fedora:41`, needle: 'Fedora-Cloud-Base-Generic-41' },
  }
  for (const kernel of OS_ORDER) {
    const kvm = OS_CATALOG[kernel].kvm
    assert.equal(kvm.image, expect[kernel].image)
    assert.match(kvm.cloud_image, /^https:\/\//)
    assert.ok(kvm.cloud_image.includes(expect[kernel].needle), kvm.cloud_image)
    assert.equal(kvmImageForKernel(kernel), kvm.image)
  }
  assert.equal(kvmImageForKernel('unknown'), kvmImageForKernel('ubuntu-24.04'))
  assert.equal(imageForKernel('ubuntu-24.04'), `${OS_REGISTRY}/kin-os-ubuntu:24.04`)
  assert.equal(buildDirForKernel('debian-12'), 'debian-12')
})
