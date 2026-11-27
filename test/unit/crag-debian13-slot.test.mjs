import '../fixtures/kin-computer-test-env.mjs'
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { clusterDockerCommandReady, slotContainerBody } from '../../src/lib/cluster/remote-slot.mjs'
import { resolveAuthLoginClaude } from '../../src/lib/oauth/claude-auth-login.mjs'
import { writeKernelConfig } from '../../src/lib/transport/rust-kernel-supervisor.mjs'
import {
  CUSTOM_OS_BRIDGE_TMPFS_DIR,
  CUSTOM_OS_CLAUDE_CURRENT,
  CUSTOM_OS_DEFAULT_KERNEL,
  CUSTOM_OS_PROFILES_DIR,
  DEFAULT_KVM_VSOCK_PORT,
  isCragDebian13Kernel,
  isCustomKvmMode,
  isCustomOsMode,
  isCustomOsSlot,
} from '../../src/lib/vm/custom-os-runtime.mjs'
import { OS_CATALOG, OS_ORDER, imageForKernel, normalizeOsKernel } from '../../src/lib/vm/os-catalog.mjs'
import { LOCAL_CRAG_CLAUDE, resolveSlotClaude } from '../../src/lib/vm/slot-engine.mjs'
import {
  buildKvmRunArgs,
  cragCustomOsDockerMountArgs,
  cragDockerSandboxArgs,
  kernelForIndex,
} from '../../src/lib/vm/vm-runtime.mjs'
import { inspectKernelChanges, materializeCragV2 } from '../../src/lib/vm/wrap-cli-runtime.mjs'
import { CRAG_DEBIAN13_ASSETS, cragDebian13Files, isCragDebian13Pinned } from '../../scripts/fetch-payload.mjs'
import { seedEncryptedPackage } from '../fixtures/crag-license.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FETCH_PAYLOAD_SCRIPT = path.join(REPO_ROOT, 'scripts', 'fetch-payload.mjs')
const execFileAsync = promisify(execFile)
const unixTest = process.platform === 'win32' ? test.skip : test
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

function makeElf(arch = 'amd64', marker = 'crag-debian13') {
  const buf = Buffer.alloc(96 + Buffer.byteLength(marker))
  buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  buf.writeUInt16LE(3, 16)
  buf.writeUInt16LE(arch === 'amd64' ? 62 : 183, 18)
  buf.writeUInt32LE(1, 20)
  buf.write(marker, 96)
  return buf
}

function seedUnbundledCragAndStore(root, { arch = 'amd64', version = '2.1.321' } = {}) {
  const storeRoot = path.join(root, 'store')
  const verDir = path.join(storeRoot, 'claude', 'versions', version)
  fs.mkdirSync(verDir, { recursive: true })
  const claudeElf = makeElf(arch, `claude-${version}`)
  const claudeSha = sha(claudeElf)
  const storeBin = path.join(verDir, 'claude')
  fs.writeFileSync(storeBin, claudeElf, { mode: 0o555 })
  if (process.platform !== 'win32') fs.chmodSync(storeBin, 0o555)
  fs.symlinkSync(`versions/${version}/claude`, path.join(storeRoot, 'claude', 'current'))

  const pkgDir = path.join(root, 'share', 'crag', 'kernels', 'v2', arch)
  fs.mkdirSync(pkgDir, { recursive: true })
  const keys = crypto.generateKeyPairSync('ed25519')
  const payloadKey = crypto.randomBytes(32)
  const bootstrapElf = makeElf(arch, `bootstrap-${version}`)
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', payloadKey, nonce)
  cipher.setAAD(Buffer.from('CRAG-V2-PAYLOAD-V1\0'))
  const encrypted = Buffer.concat([cipher.update(bootstrapElf), cipher.final()])
  const payloadBytes = Buffer.concat([Buffer.from('CRAGV2E1'), nonce, cipher.getAuthTag(), encrypted])
  const pem = keys.publicKey.export({ format: 'pem', type: 'spki' })
  const pubRaw = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  const payloadSigned = {
    product: 'crag-v2',
    format: 'CRAGV2E1',
    algorithm: 'aes-256-gcm',
    key_id: sha(payloadKey),
    plaintext_sha256: sha(bootstrapElf),
    ciphertext_sha256: sha(payloadBytes),
  }
  const payloadSig = crypto
    .sign(
      null,
      Buffer.concat([Buffer.from('CRAG-PAYLOAD-V1\0'), Buffer.from(JSON.stringify(payloadSigned))]),
      keys.privateKey,
    )
    .toString('base64url')
  const files = {
    'crag-v2': bootstrapElf,
    'crag-v2.payload.enc': payloadBytes,
    'crag-license-public.pem': Buffer.from(pem, 'utf8'),
  }
  for (const [rel, bytes] of Object.entries(files)) {
    fs.writeFileSync(path.join(pkgDir, rel), bytes, { mode: rel === 'crag-v2' ? 0o755 : 0o644 })
  }
  const relPath = `claude-code-${version}/claude`
  const signedOfficial = { product: 'crag-v2', arch, version, path: relPath, sha256: claudeSha }
  const officialSig = crypto
    .sign(
      null,
      Buffer.concat([Buffer.from('CRAG-OFFICIAL-CLAUDE-V1\0'), Buffer.from(JSON.stringify(signedOfficial))]),
      keys.privateKey,
    )
    .toString('base64url')
  const manifest = {
    family: 'crag',
    version: 'v2',
    arch,
    runtime: 'native',
    entrypoint: 'crag-v2',
    encrypted: true,
    capabilities: [
      'official_full',
      'zero',
      'cancel',
      'telemetry',
      'unix_socket_envelope',
      'headless_claude_bridge_v1',
      'generation_controls_v3',
    ],
    officialClaude: { version, bundled: false, path: relPath, sha256: claudeSha, signature: officialSig },
    authorization: {
      scheme: 'ed25519-x25519-v1',
      product: 'crag-v2',
      public_key: pubRaw.toString('base64url'),
      public_key_id: sha(pubRaw),
    },
    payload: { path: 'crag-v2.payload.enc', ...payloadSigned, signature: payloadSig },
    sha256: Object.fromEntries(Object.entries(files).map(([rel, bytes]) => [rel, sha(bytes)])),
  }
  fs.writeFileSync(path.join(pkgDir, 'manifest.json'), JSON.stringify(manifest))
  return { storeRoot, pkgDir, manifest }
}

test('SSOT helpers enable crag-debian13 & debian-13 per-slot without global env while honoring explicit legacy rollback', () => {
  assert.equal(CUSTOM_OS_DEFAULT_KERNEL, 'crag-debian13')
  assert.equal(isCragDebian13Kernel('crag-debian13'), true)
  assert.equal(isCragDebian13Kernel('debian-13'), true)
  assert.equal(isCragDebian13Kernel('ubuntu-24.04'), false)
  assert.equal(isCragDebian13Kernel('debian-12'), false)

  // Per-slot auto-activation with empty env (zero global KIN_OS_RUNTIME_MODE / KIN_KVM_MODE).
  assert.equal(isCustomOsMode({ env: {} }), false)
  assert.equal(isCustomOsSlot({ kernel: 'crag-debian13' }, { env: {} }), true)
  assert.equal(isCustomOsSlot({ kernel: 'debian-13' }, { env: {} }), true)
  assert.equal(isCustomOsSlot({ kernel: 'ubuntu-24.04' }, { env: {} }), false)
  assert.equal(isCustomOsSlot({ kernel: 'crag-debian13' }, { env: { KIN_OS_RUNTIME_MODE: 'legacy' } }), false)
  assert.equal(isCustomOsSlot({ kernel: 'ubuntu-24.04' }, { env: { KIN_OS_RUNTIME_MODE: 'custom-os' } }), true)

  // isCustomKvmMode({ vm, kernel, env, mode }) contract.
  assert.equal(isCustomKvmMode({ vm: { kernel: 'crag-debian13' }, env: {} }), true)
  assert.equal(isCustomKvmMode({ vm: { kernel: 'debian-13' }, env: {} }), true)
  assert.equal(isCustomKvmMode({ kernel: 'crag-debian13', env: {} }), true)
  assert.equal(isCustomKvmMode({ vm: { kernel: 'ubuntu-24.04' }, env: {} }), false)
  assert.equal(isCustomKvmMode({ vm: { kernel: 'crag-debian13' }, env: { KIN_KVM_MODE: 'legacy' } }), false)
  assert.equal(isCustomKvmMode({ vm: { kernel: 'crag-debian13' }, mode: 'legacy', env: {} }), false)
  assert.equal(isCustomKvmMode({ vm: { kernel: 'ubuntu-24.04' }, mode: 'custom-erofs', env: {} }), true)
  assert.equal(isCustomKvmMode({ vm: { kernel: 'ubuntu-24.04' }, env: { KIN_KVM_MODE: 'custom-erofs' } }), true)

  // Catalog canonical key + compat alias + general auto-rotation never silently assigns crag-debian13.
  assert.ok(OS_ORDER.includes('crag-debian13'))
  assert.equal(normalizeOsKernel('debian-13'), 'crag-debian13')
  assert.equal(OS_CATALOG['debian-13'], OS_CATALOG['crag-debian13'])
  for (let i = 1; i <= 8; i += 1) {
    assert.notEqual(kernelForIndex(i), 'crag-debian13')
  }
})

unixTest(
  'per-slot crag-debian13 auto-wires Docker, KVM, remote-slot, wrap-cli, kernel config, and auth-login with zero global env',
  (t) => {
    const prevOs = process.env.KIN_OS_RUNTIME_MODE
    const prevKvm = process.env.KIN_KVM_MODE
    const prevCragRoot = process.env.KIN_CRAG_V2_ROOT
    delete process.env.KIN_OS_RUNTIME_MODE
    delete process.env.KIN_KVM_MODE
    delete process.env.KIN_CRAG_V2_ROOT
    t.after(() => {
      if (prevOs === undefined) delete process.env.KIN_OS_RUNTIME_MODE
      else process.env.KIN_OS_RUNTIME_MODE = prevOs
      if (prevKvm === undefined) delete process.env.KIN_KVM_MODE
      else process.env.KIN_KVM_MODE = prevKvm
      if (prevCragRoot === undefined) delete process.env.KIN_CRAG_V2_ROOT
      else process.env.KIN_CRAG_V2_ROOT = prevCragRoot
    })

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-debian13-e2e-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const { storeRoot, manifest } = seedUnbundledCragAndStore(root)

    const routing = { inference: { dataplane: 'crag', crag_kernel_version: 'v2' } }
    const cragDockerVm = {
      id: 'vm-cd13-doc',
      kernel: 'crag-debian13',
      timezone: 'UTC',
      locale: 'en_US.UTF-8',
      runtime: { type: 'docker' },
      dataplane: 'crag',
      crag_kernel_version: 'v2',
    }
    const cragKvmVm = {
      id: 'vm-cd13-kvm',
      kernel: 'crag-debian13',
      timezone: 'UTC',
      locale: 'en_US.UTF-8',
      runtime: { type: 'kvm', accel: 'kvm' },
      dataplane: 'crag',
      crag_kernel_version: 'v2',
      machine: {
        memory: '2g',
        vcpus: 2,
        disk_gb: 20,
        cpu_model: 'host',
        mac: '52:54:00:11:22:33',
        disk_serial: 'KIN1',
      },
      fingerprint: { hostname: 'ws-cd13-kvm', guest_machine_id: '0123456789abcdef0123456789abcdef' },
    }
    const legacyDockerVm = {
      id: 'vm-ub24-doc',
      kernel: 'ubuntu-24.04',
      timezone: 'UTC',
      locale: 'en_US.UTF-8',
      runtime: { type: 'docker' },
      dataplane: 'crag',
      crag_kernel_version: 'v2',
    }
    const legacyKvmVm = { ...cragKvmVm, id: 'vm-ub24-kvm', kernel: 'ubuntu-24.04' }

    // 1. Docker image, default seccomp, /run/kin/bridge tmpfs, RO store mount — automatic for crag-debian13, untouched for ubuntu-24.04.
    assert.match(imageForKernel(cragDockerVm.kernel), /kin-os-debian:13-baked$/)
    assert.deepEqual(
      cragDockerSandboxArgs(cragDockerVm, routing, { appArmorEnabled: true, userNamespaceRestricted: true }),
      ['--security-opt', 'no-new-privileges', '--init'],
    )
    const legacySandbox = cragDockerSandboxArgs(legacyDockerVm, routing, {
      appArmorEnabled: true,
      userNamespaceRestricted: true,
    })
    assert.ok(legacySandbox.some((arg) => arg.startsWith('seccomp=')))

    const docMounts = cragCustomOsDockerMountArgs(cragDockerVm, { routing, projectRoot: root })
    assert.ok(docMounts.includes(`${CUSTOM_OS_BRIDGE_TMPFS_DIR}:rw,noexec,nosuid,nodev,size=16m`))
    assert.ok(docMounts.includes(`type=bind,source=${storeRoot},target=/opt/kin/store,readonly`))
    assert.deepEqual(cragCustomOsDockerMountArgs(legacyDockerVm, { routing, projectRoot: root }), [])

    // 2. Remote Docker slot parity without global env.
    const remoteBody = slotContainerBody(cragDockerVm, {
      image: imageForKernel('crag-debian13'),
      network: 'kin-net',
      remoteDir: '/srv/slots/vm-cd13-doc',
      user: '10001:987',
      routing,
      sharedStoreDir: storeRoot,
      managedSettings: true,
    })
    assert.deepEqual(remoteBody.HostConfig.SecurityOpt, ['no-new-privileges'])
    assert.equal(remoteBody.HostConfig.Tmpfs[CUSTOM_OS_BRIDGE_TMPFS_DIR], 'rw,noexec,nosuid,nodev,size=16m')
    assert.ok(remoteBody.HostConfig.Binds.includes(`${storeRoot}:/opt/kin/store:ro`))
    assert.equal(
      clusterDockerCommandReady(
        { ...cragDockerVm, node_id: 'node-1' },
        { Config: { Cmd: remoteBody.Cmd }, HostConfig: remoteBody.HostConfig },
        routing,
      ),
      true,
    )

    const legacyRemoteBody = slotContainerBody(legacyDockerVm, {
      image: imageForKernel('ubuntu-24.04'),
      network: 'kin-net',
      remoteDir: '/srv/slots/vm-ub24-doc',
      user: '10001:987',
      routing,
    })
    assert.ok(legacyRemoteBody.HostConfig.SecurityOpt.some((o) => o.startsWith('seccomp=')))
    assert.equal(legacyRemoteBody.HostConfig.Tmpfs[CUSTOM_OS_BRIDGE_TMPFS_DIR], undefined)

    // 3. KVM runner args auto-enable custom-erofs for crag-debian13 only, and mount share/os/crag-debian13 when present.
    const kvmDir = path.join(root, 'vms', cragKvmVm.id, 'kvm')
    fs.mkdirSync(kvmDir, { recursive: true })
    const kvmArgs = buildKvmRunArgs({
      vm: cragKvmVm,
      name: 'kin-cd13-kvm',
      image: 'ghcr.io/dofastted/kin-kvm-debian:13',
      hostName: 'ws-cd13-kvm',
      network: 'kin-net',
      memory: '2g',
      accel: 'kvm',
      uid: 10001,
      gid: 987,
      home: path.join(root, 'vms', cragKvmVm.id, 'cli-home'),
      runDir: path.join(root, 'vms', cragKvmVm.id, 'run'),
      kvmDir,
      projectRoot: root,
      vhostVsockAvailable: true,
    })
    assert.ok(kvmArgs.includes('KIN_KVM_MODE=custom-erofs'))
    assert.ok(kvmArgs.includes('/dev/vhost-vsock'))
    assert.ok(kvmArgs.includes(`${storeRoot}:/opt/kin/store:ro`))
    assert.equal(
      kvmArgs.some((a) => String(a).includes('/opt/kin-os/crag-debian13')),
      false,
    )
    assert.equal(
      kvmArgs.some((a) => String(a).startsWith('KIN_KVM_EROFS_IMAGE=')),
      false,
    )

    // Once fetch-payload drops kin-kvm-debian-13.erofs + vmlinuz (+ initrd.img) into share/os/crag-debian13,
    // mount RO under /opt/kin-os/crag-debian13 (never shadowing /opt/kin-kvm) and wire KIN_KVM_{EROFS_IMAGE,KERNEL,INITRD}.
    const osAssetsDir = path.join(root, 'share', 'os', 'crag-debian13')
    fs.mkdirSync(osAssetsDir, { recursive: true })
    fs.writeFileSync(path.join(osAssetsDir, 'kin-kvm-debian-13.erofs'), 'erofs-fixture')
    fs.writeFileSync(path.join(osAssetsDir, 'vmlinuz'), 'vmlinuz-fixture')
    const kvmArgsCore = buildKvmRunArgs({
      vm: cragKvmVm,
      name: 'kin-cd13-kvm',
      image: 'ghcr.io/dofastted/kin-kvm-debian:13',
      hostName: 'ws-cd13-kvm',
      network: 'kin-net',
      memory: '2g',
      accel: 'kvm',
      uid: 10001,
      gid: 987,
      home: path.join(root, 'vms', cragKvmVm.id, 'cli-home'),
      runDir: path.join(root, 'vms', cragKvmVm.id, 'run'),
      kvmDir,
      projectRoot: root,
      vhostVsockAvailable: true,
    })
    assert.ok(kvmArgsCore.includes(`${osAssetsDir}:/opt/kin-os/crag-debian13:ro`))
    assert.equal(
      kvmArgsCore.some((a) => String(a).includes(':/opt/kin-kvm')),
      false,
    )
    assert.ok(kvmArgsCore.includes('KIN_KVM_EROFS_IMAGE=/opt/kin-os/crag-debian13/kin-kvm-debian-13.erofs'))
    assert.ok(kvmArgsCore.includes('KIN_KVM_KERNEL=/opt/kin-os/crag-debian13/vmlinuz'))
    assert.equal(
      kvmArgsCore.some((a) => String(a).startsWith('KIN_KVM_INITRD=')),
      false,
    )

    fs.writeFileSync(path.join(osAssetsDir, 'initrd.img'), 'initrd-fixture')
    const kvmArgsInitrd = buildKvmRunArgs({
      vm: cragKvmVm,
      name: 'kin-cd13-kvm',
      image: 'ghcr.io/dofastted/kin-kvm-debian:13',
      hostName: 'ws-cd13-kvm',
      network: 'kin-net',
      memory: '2g',
      accel: 'kvm',
      uid: 10001,
      gid: 987,
      home: path.join(root, 'vms', cragKvmVm.id, 'cli-home'),
      runDir: path.join(root, 'vms', cragKvmVm.id, 'run'),
      kvmDir,
      projectRoot: root,
      vhostVsockAvailable: true,
    })
    assert.ok(kvmArgsInitrd.includes('KIN_KVM_INITRD=/opt/kin-os/crag-debian13/initrd.img'))

    const legacyKvmDir = path.join(root, 'vms', legacyKvmVm.id, 'kvm')
    fs.mkdirSync(legacyKvmDir, { recursive: true })
    const legacyKvmArgs = buildKvmRunArgs({
      vm: legacyKvmVm,
      name: 'kin-ub24-kvm',
      image: 'ghcr.io/dofastted/kin-kvm-ubuntu:24.04',
      hostName: 'ws-ub24-kvm',
      network: 'kin-net',
      memory: '2g',
      accel: 'kvm',
      uid: 10001,
      gid: 987,
      home: path.join(root, 'vms', legacyKvmVm.id, 'cli-home'),
      runDir: path.join(root, 'vms', legacyKvmVm.id, 'run'),
      kvmDir: legacyKvmDir,
      projectRoot: root,
      vhostVsockAvailable: true,
    })
    assert.equal(legacyKvmArgs.includes('KIN_KVM_MODE=custom-erofs'), false)
    assert.equal(legacyKvmArgs.includes('/dev/vhost-vsock'), false)

    // 4. wrap-cli-runtime materializeCragV2 & inspectKernelChanges accept bundled:false for crag-debian13, reject for ubuntu-24.04.
    const matOk = materializeCragV2(root, cragDockerVm, { select: true })
    assert.equal(matOk.ok, true, matOk.error)
    const matLegacy = materializeCragV2(root, legacyDockerVm, { select: true })
    assert.equal(matLegacy.ok, false)

    const inspectRes = inspectKernelChanges(root, [cragDockerVm], { routing })
    assert.equal(inspectRes.ok, true)
    assert.equal(inspectRes.items[0].kernel_changed, false)

    // 5. slot-engine + writeKernelConfig + claude-auth-login auto-wire without global env.
    const resolved = resolveSlotClaude(cragKvmVm, routing, { manifest })
    assert.equal(resolved.customOs, true)
    assert.equal(resolved.sharedStore, true)
    assert.equal(resolved.bin, '/opt/kin/store/claude/versions/2.1.321/claude')

    const kvmKcfg = writeKernelConfig(root, cragKvmVm, {
      token: 'tok-cd13',
      routing,
      vsockEnabled: true,
    })
    const kvmDoc = JSON.parse(fs.readFileSync(kvmKcfg.configPath, 'utf8'))
    assert.equal(kvmDoc.runtime_variant, 'crag-v2')
    assert.equal(kvmDoc.socket_path, '/run/kin-guest/kernel.sock')
    assert.equal(kvmDoc.disable_dumpable, true)
    assert.equal(kvmDoc.listen_vsock_port, DEFAULT_KVM_VSOCK_PORT)
    assert.equal(kvmDoc.wire_profile_readonly_dir, CUSTOM_OS_PROFILES_DIR)
    assert.equal(kvmDoc.bridge_socket_dir, CUSTOM_OS_BRIDGE_TMPFS_DIR)
    assert.equal(kvmDoc.claude_bin, '/opt/kin/store/claude/versions/2.1.321/claude')

    const legacyKcfg = writeKernelConfig(root, legacyKvmVm, { token: 'tok-ub24', routing, vsockEnabled: true })
    const legacyDoc = JSON.parse(fs.readFileSync(legacyKcfg.configPath, 'utf8'))
    assert.equal(legacyDoc.disable_dumpable, undefined)
    assert.equal(legacyDoc.listen_vsock_port, undefined)

    assert.equal(resolveAuthLoginClaude(cragDockerVm), CUSTOM_OS_CLAUDE_CURRENT)
    assert.equal(resolveAuthLoginClaude(cragKvmVm), CUSTOM_OS_CLAUDE_CURRENT)
    assert.equal(resolveAuthLoginClaude(legacyDockerVm), LOCAL_CRAG_CLAUDE)
  },
)

test('POST /vms/create auto-closes crag-debian13 & debian-13 to dataplane=crag and keeps creation non-blocking via deferredCrag', async (t) => {
  function buildHandler(root, body, extra = {}) {
    seedEncryptedPackage(root)
    const template = path.join(root, 'share/wrap-cli')
    fs.mkdirSync(template, { recursive: true })
    for (const name of ['kin-kernel.bin', 'cli-node']) fs.writeFileSync(path.join(template, name), 'fixture')
    const response = {}
    const handlePanel = createPanelHandler({
      cfg: { paths: { project: root } },
      ...(extra.startSlotReady ? { startSlotReady: extra.startSlotReady } : {}),
      requireAuth(req) {
        req.apiKeyKind = 'master'
        req.panelRole = 'admin'
        return true
      },
      json(_res, status, payload) {
        response.status = status
        response.body = payload
        return true
      },
      readBody: async () => body,
      proxyPool: extra.proxyPool || {
        allocateForVm() {
          throw new Error('no proxy')
        },
        getProxyForVm() {
          return null
        },
      },
    })
    return { handlePanel, response }
  }

  // 1. Omitted dataplane or wrap override on crag-debian13 / debian-13 auto-closes to dataplane='crag' + kernel='crag-debian13'.
  for (const [kernel, dataplane] of [
    ['crag-debian13', undefined],
    ['crag-debian13', 'wrap'],
    ['debian-13', undefined],
    ['debian-13', 'wrap'],
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-d13-create-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const { handlePanel, response } = buildHandler(root, {
      kernel,
      ...(dataplane !== undefined ? { dataplane } : {}),
      start: false,
      auto_allocate_proxy: false,
    })
    await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/create'))
    assert.equal(response.status, 200, JSON.stringify(response.body))
    const id = response.body.data.vm.id
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', `${id}.json`), 'utf8'))
    assert.equal(saved.kernel, 'crag-debian13')
    assert.equal(saved.dataplane, 'crag')
    assert.equal(saved.crag_kernel_version, 'v2')
    assert.equal(saved.status, 'stopped')
  }

  // 2. Invalid cc dataplane or OpenAI platform on crag-debian13 is rejected with 400.
  for (const badBody of [
    { kernel: 'crag-debian13', dataplane: 'cc', start: false },
    { kernel: 'crag-debian13', platform: 'openai', start: false },
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-d13-bad-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const { handlePanel, response } = buildHandler(root, badBody)
    await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/create'))
    assert.equal(response.status, 400)
    assert.equal(response.body.error.code, 'invalid_create_dataplane')
  }

  // 3. Quota exhausted (`slot_limit_reached`) or unbound subscription (`license_missing`) falls back cleanly to deferredCrag (200 OK + stopped).
  for (const code of ['slot_limit_reached', 'license_missing']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-d13-defer-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const fakeProxy = { id: 'px-1', url: 'socks5://127.0.0.1:1080', enabled: true, status: 'alive' }
    const { handlePanel, response } = buildHandler(
      root,
      { kernel: 'crag-debian13', start: true, auto_allocate_proxy: true },
      {
        proxyPool: {
          allocateForVm: () => fakeProxy,
          getProxyForVm: () => fakeProxy,
          proxyTimezone: () => 'UTC',
          detectGeo: async () => ({ ok: true, geo: { timezone: 'UTC' } }),
          snapshot: () => ({ proxies: [fakeProxy] }),
        },
        startSlotReady: async () => ({ ok: false, code, error: `blocked:${code}` }),
      },
    )
    await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/create'))
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body.data.vm.status, 'stopped')
    assert.equal(response.body.data.start_error, `blocked:${code}`)
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', `${response.body.data.vm.id}.json`), 'utf8'))
    assert.equal(saved.status, 'stopped')
    assert.equal(saved.dataplane, 'crag')
    assert.equal(saved.crag_kernel_version, 'v2')
  }

  // 4. Prototype-chain kernel names (`toString`/`constructor`/`__proto__`) never leak empty kernel strings.
  for (const protoKey of ['toString', 'constructor', '__proto__', 'valueOf']) {
    assert.equal(normalizeOsKernel(protoKey), '')
    assert.equal(imageForKernel(protoKey), imageForKernel('ubuntu-24.04'))
  }
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-d13-proto-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const { handlePanel, response } = buildHandler(root, {
      kernel: 'toString',
      start: false,
      auto_allocate_proxy: false,
    })
    await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/create'))
    assert.equal(response.status, 200, JSON.stringify(response.body))
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', `${response.body.data.vm.id}.json`), 'utf8'))
    assert.equal(saved.kernel, 'ubuntu-24.04')
  }

  // 5. Post-create kernel-switch and PATCH refuse switching crag-debian13 away from dataplane=crag.
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-d13-switch-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const { handlePanel: createHandle, response: createRes } = buildHandler(root, {
      kernel: 'crag-debian13',
      start: false,
      auto_allocate_proxy: false,
    })
    await createHandle({ method: 'POST' }, {}, new URL('http://localhost/api/panel/vms/create'))
    assert.equal(createRes.status, 200)
    const id = createRes.body.data.vm.id

    // POST /api/panel/vms/:id/kernel-switch -> wrap rejected with 400 crag_debian13_crag_only.
    const { handlePanel: ksHandle, response: ksRes } = buildHandler(root, { dataplane: 'wrap' })
    await ksHandle({ method: 'POST' }, {}, new URL(`http://localhost/api/panel/vms/${id}/kernel-switch`))
    assert.equal(ksRes.status, 400, JSON.stringify(ksRes.body))
    assert.equal(ksRes.body.error.code, 'crag_debian13_crag_only')

    // PATCH /api/panel/vms/:id -> wrap rejected with 400 crag_debian13_crag_only.
    const { handlePanel: patchWrapHandle, response: patchWrapRes } = buildHandler(root, { dataplane: 'wrap' })
    await patchWrapHandle({ method: 'PATCH' }, {}, new URL(`http://localhost/api/panel/vms/${id}`))
    assert.equal(patchWrapRes.status, 400, JSON.stringify(patchWrapRes.body))
    assert.equal(patchWrapRes.body.error.code, 'crag_debian13_crag_only')

    // PATCH /api/panel/vms/:id -> inherit ('') when global routing is wrap also rejected with 400 crag_debian13_crag_only.
    const { handlePanel: patchInheritHandle, response: patchInheritRes } = buildHandler(root, { dataplane: '' })
    await patchInheritHandle({ method: 'PATCH' }, {}, new URL(`http://localhost/api/panel/vms/${id}`))
    assert.equal(patchInheritRes.status, 400, JSON.stringify(patchInheritRes.body))
    assert.equal(patchInheritRes.body.error.code, 'crag_debian13_crag_only')

    const persisted = JSON.parse(fs.readFileSync(path.join(root, 'vms', `${id}.json`), 'utf8'))
    assert.equal(persisted.kernel, 'crag-debian13')
    assert.equal(persisted.dataplane, 'crag')
  }
})

test('deploy/payload.json crag_debian13_release & scripts/fetch-payload.mjs enforce pure size+sha256 without extra crypto', async (t) => {
  const realManifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'deploy', 'payload.json'), 'utf8'))
  assert.equal(realManifest.crag_authorization.product, 'crag-v2')
  assert.ok(realManifest.crag_debian13_release)
  assert.equal(isCragDebian13Pinned(realManifest), true)
  const pinnedOsFiles = cragDebian13Files(realManifest)
  assert.equal(pinnedOsFiles.length, CRAG_DEBIAN13_ASSETS.length)
  assert.match(realManifest.crag_debian13_release.tag, /^payload-/)
  for (const name of CRAG_DEBIAN13_ASSETS) {
    const entry = realManifest.crag_debian13_release.assets[name]
    assert.ok(entry, `missing ${name}`)
    assert.deepEqual(Object.keys(entry).sort(), ['sha256', 'size'])
    assert.ok(Number.isInteger(entry.size) && entry.size > 0, `invalid size for ${name}`)
    assert.match(entry.sha256, /^[a-f0-9]{64}$/, `invalid sha256 for ${name}`)
  }

  // Real HTTP download + --pin-crag-debian13 + --check + tamper fail-closed.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-d13-payload-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const srcDest = path.join(tmp, 'src-dest')
  const dlDest = path.join(tmp, 'dl-dest')
  const osDir = path.join(srcDest, 'share', 'os', 'crag-debian13')
  fs.mkdirSync(osDir, { recursive: true })
  const assetData = {
    'kin-kvm-debian-13.erofs': Buffer.from('erofs-image-bytes-fixture'),
    vmlinuz: Buffer.from('linux-6.12-vmlinuz-fixture'),
    'initrd.img': Buffer.from('initrd-image-fixture'),
  }
  for (const [name, bytes] of Object.entries(assetData)) {
    fs.writeFileSync(path.join(osDir, name), bytes)
  }

  const testManifestPath = path.join(tmp, 'payload.json')
  fs.writeFileSync(testManifestPath, JSON.stringify({ repo: 'dofastted/vm2api', release: 'r1', files: [] }, null, 2))

  // 1. Pin local plaintext assets by size + sha256 only.
  const pinned = spawnSync(
    process.execPath,
    [FETCH_PAYLOAD_SCRIPT, '--manifest', testManifestPath, '--dest', srcDest, '--pin-crag-debian13', 'os-tag-1'],
    { encoding: 'utf8' },
  )
  assert.equal(pinned.status, 0, pinned.stderr)
  const pinnedManifest = JSON.parse(fs.readFileSync(testManifestPath, 'utf8'))
  assert.equal(isCragDebian13Pinned(pinnedManifest), true)
  assert.equal(pinnedManifest.crag_debian13_release.tag, 'os-tag-1')
  assert.equal(pinnedManifest.crag_debian13_release.assets.vmlinuz.size, assetData.vmlinuz.length)
  assert.equal(pinnedManifest.crag_debian13_release.assets.vmlinuz.sha256, sha(assetData.vmlinuz))

  // 2. Serve assets over local HTTP and fetch + verify size + sha256.
  let serveCorrupt = false
  const server = http.createServer((req, res) => {
    const assetName = path.posix.basename(req.url || '')
    if (!Object.hasOwn(assetData, assetName)) {
      res.writeHead(404).end('not found')
      return
    }
    const body = serveCorrupt && assetName === 'vmlinuz' ? Buffer.from('CORRUPT') : assetData[assetName]
    res.writeHead(200).end(body)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  const fetched = await execFileAsync(
    process.execPath,
    [FETCH_PAYLOAD_SCRIPT, '--manifest', testManifestPath, '--dest', dlDest, '--crag-debian13'],
    { encoding: 'utf8', env: { ...process.env, VM2API_PAYLOAD_BASE_URL: baseUrl } },
  )
  assert.match(fetched.stdout, /payload ready/)
  for (const [name, bytes] of Object.entries(assetData)) {
    assert.deepEqual(fs.readFileSync(path.join(dlDest, 'share', 'os', 'crag-debian13', name)), bytes)
  }

  // 3. Offline --check passes on clean files, fails closed on 1-byte tamper.
  const checkOk = spawnSync(
    process.execPath,
    [FETCH_PAYLOAD_SCRIPT, '--manifest', testManifestPath, '--dest', dlDest, '--check', '--crag-debian13'],
    { encoding: 'utf8' },
  )
  assert.equal(checkOk.status, 0, checkOk.stderr)

  const vmlinuzPath = path.join(dlDest, 'share', 'os', 'crag-debian13', 'vmlinuz')
  fs.writeFileSync(vmlinuzPath, Buffer.from('tampered-vmlinuz-bytes!!'))
  const checkTampered = spawnSync(
    process.execPath,
    [FETCH_PAYLOAD_SCRIPT, '--manifest', testManifestPath, '--dest', dlDest, '--check', '--crag-debian13'],
    { encoding: 'utf8' },
  )
  assert.equal(checkTampered.status, 1)

  // 4. Corrupt server response fails closed during fetch without writing target file.
  serveCorrupt = true
  const badDest = path.join(tmp, 'bad-dl')
  await assert.rejects(
    () =>
      execFileAsync(
        process.execPath,
        [FETCH_PAYLOAD_SCRIPT, '--manifest', testManifestPath, '--dest', badDest, '--crag-debian13'],
        { encoding: 'utf8', env: { ...process.env, VM2API_PAYLOAD_BASE_URL: baseUrl } },
      ),
    (err) => err.code !== 0,
  )
  assert.equal(fs.existsSync(path.join(badDest, 'share', 'os', 'crag-debian13', 'vmlinuz')), false)
})
