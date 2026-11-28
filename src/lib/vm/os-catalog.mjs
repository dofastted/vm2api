/**
 * Guest OS catalog. Images are pulled from a registry; the Dockerfiles under
 * docker/kin-os are the offline fallback and are tagged with the same ref.
 * KIN_OS_REGISTRY lets a self-hoster mirror them.
 *
 * kvm.image is the qemu runner; kvm.cloud_image is the official guest disk
 * baked into that runner at docker/kin-kvm build time (ARG CLOUD_IMAGE_URL).
 */
export const OS_REGISTRY = String(process.env.KIN_OS_REGISTRY || 'ghcr.io/dofastted').replace(/\/+$/, '')

/** Build context for kin-kvm runners (single Dockerfile + ARG CLOUD_IMAGE_URL). */
export const KVM_BUILD_DIR = 'docker/kin-kvm'

const CRAG_DEBIAN13_SPEC = {
  image: `${OS_REGISTRY}/kin-os-debian:13-baked`,
  family: 'debian',
  pretty: 'CRAG Debian 13 (Trixie)',
  dir: 'debian-13',
  customOs: true,
  cragOnly: true,
  kvm: {
    image: `${OS_REGISTRY}/kin-kvm-debian:13`,
    erofs_image: 'kin-kvm-debian-13.erofs',
    cloud_image: 'https://cloud.debian.org/images/cloud/trixie/latest/debian-13-generic-amd64.qcow2',
  },
}

export const OS_KERNEL_ALIASES = Object.freeze({
  'debian-13': 'crag-debian13',
})

export const OS_CATALOG = {
  'ubuntu-24.04': {
    image: `${OS_REGISTRY}/kin-os-ubuntu:24.04`,
    family: 'ubuntu',
    pretty: 'Ubuntu 24.04',
    dir: 'ubuntu-24.04',
    kvm: {
      image: `${OS_REGISTRY}/kin-kvm-ubuntu:24.04`,
      cloud_image: 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img',
    },
  },
  'debian-12': {
    image: `${OS_REGISTRY}/kin-os-debian:12`,
    family: 'debian',
    pretty: 'Debian 12',
    dir: 'debian-12',
    kvm: {
      image: `${OS_REGISTRY}/kin-kvm-debian:12`,
      // genericcloud's linux-image-cloud-amd64 omits 9p/9pnet_virtio. generic
      // ships linux-image-amd64 with those modules, so first boot does not
      // need a kernel swap + reboot (that path also broke sshd under TCG).
      cloud_image: 'https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-generic-amd64.qcow2',
    },
  },
  'crag-debian13': CRAG_DEBIAN13_SPEC,
  archlinux: {
    image: `${OS_REGISTRY}/kin-os-arch:latest`,
    family: 'arch',
    pretty: 'Arch Linux',
    dir: 'archlinux',
    kvm: {
      image: `${OS_REGISTRY}/kin-kvm-arch:latest`,
      cloud_image: 'https://geo.mirror.pkgbuild.com/images/latest/Arch-Linux-x86_64-cloudimg.qcow2',
    },
  },
  'fedora-41': {
    image: `${OS_REGISTRY}/kin-os-fedora:41`,
    family: 'fedora',
    pretty: 'Fedora 41',
    dir: 'fedora-41',
    kvm: {
      image: `${OS_REGISTRY}/kin-kvm-fedora:41`,
      cloud_image:
        'https://download.fedoraproject.org/pub/archive/fedora/linux/releases/41/Cloud/x86_64/images/Fedora-Cloud-Base-Generic-41-1.4.x86_64.qcow2',
    },
  },
}

// Keep `debian-13` lookup-compatible without duplicating `Object.keys(OS_CATALOG)` loops.
Object.defineProperty(OS_CATALOG, 'debian-13', {
  value: CRAG_DEBIAN13_SPEC,
  enumerable: false,
  configurable: true,
})

export const OS_ORDER = ['ubuntu-24.04', 'debian-12', 'archlinux', 'fedora-41', 'crag-debian13']

function lookupOsSpec(kernel) {
  const raw = String(kernel || '').trim()
  if (!raw) return null
  const canonical = Object.hasOwn(OS_KERNEL_ALIASES, raw) ? OS_KERNEL_ALIASES[raw] : raw
  return Object.hasOwn(OS_CATALOG, canonical) ? OS_CATALOG[canonical] : null
}

export function normalizeOsKernel(kernel) {
  const raw = String(kernel || '').trim()
  if (!raw) return ''
  const canonical = Object.hasOwn(OS_KERNEL_ALIASES, raw) ? OS_KERNEL_ALIASES[raw] : raw
  return Object.hasOwn(OS_CATALOG, canonical) ? canonical : ''
}

export function imageForKernel(kernel) {
  return (lookupOsSpec(kernel) || OS_CATALOG['ubuntu-24.04']).image
}

export function kvmImageForKernel(kernel) {
  return (lookupOsSpec(kernel) || OS_CATALOG['ubuntu-24.04']).kvm.image
}

/** Build context dir name under docker/kin-os for the offline fallback. */
export function buildDirForKernel(kernel) {
  return (lookupOsSpec(kernel) || OS_CATALOG['ubuntu-24.04']).dir
}
