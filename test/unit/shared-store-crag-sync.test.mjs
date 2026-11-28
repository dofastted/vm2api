import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { stageBundledAuthClaude } from '../../src/lib/oauth/claude-auth-login.mjs'
import { activateCragLicense } from '../../src/lib/vm/crag-license.mjs'
import { installKernelTargets } from '../../src/lib/vm/kernel-install.mjs'
import { buildKvmRunArgs } from '../../src/lib/vm/vm-runtime.mjs'
import {
  inspectKernelChanges,
  materializeCragV2,
  resolveSharedStoreCragCurrentDir,
  sharedStoreCragWouldChange,
  syncSharedStoreCrag,
  verifyCragV2Tree,
} from '../../src/lib/vm/wrap-cli-runtime.mjs'
import { fixtureAuthority, issueUniversalCode } from '../fixtures/crag-license.mjs'

const unixTest = process.platform === 'win32' ? test.skip : test
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

function makeElf(arch = 'amd64', marker = 'crag') {
  const buf = Buffer.alloc(96 + Buffer.byteLength(marker))
  buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  buf.writeUInt16LE(3, 16)
  buf.writeUInt16LE(arch === 'amd64' ? 62 : 183, 18)
  buf.writeUInt32LE(1, 20)
  buf.write(marker, 96)
  return buf
}

function seedVersionedCragPackage(
  root,
  {
    softwareVersion = '3.1.26',
    claudeVersion = '2.1.321',
    revision = '',
    arch = 'amd64',
    destDir = '',
    unbundled = false,
    storeRoot = '',
  } = {},
) {
  const authority = fixtureAuthority(root)
  const dir = destDir || path.join(root, 'share', 'crag', 'kernels', 'v2', arch)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })

  const marker = `${softwareVersion}-${revision || 'base'}`
  const cragElf = makeElf(arch, `crag-${marker}`)
  const claudeElf = makeElf(arch, `claude-${claudeVersion}-${marker}`)
  const claudeSha = sha(claudeElf)
  const claudeRel = `claude-code-${claudeVersion}/claude`

  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', authority.payloadKey, nonce)
  cipher.setAAD(Buffer.from('CRAG-V2-PAYLOAD-V1\0'))
  const encrypted = Buffer.concat([cipher.update(cragElf), cipher.final()])
  const payloadBytes = Buffer.concat([Buffer.from('CRAGV2E1'), nonce, cipher.getAuthTag(), encrypted])

  const pem = authority.publicKey.export({ format: 'pem', type: 'spki' })
  const pubRaw = authority.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  const signedPayload = {
    product: 'crag-v2',
    format: 'CRAGV2E1',
    algorithm: 'aes-256-gcm',
    key_id: sha(authority.payloadKey),
    plaintext_sha256: sha(cragElf),
    ciphertext_sha256: sha(payloadBytes),
  }
  const payloadSig = crypto
    .sign(
      null,
      Buffer.concat([Buffer.from('CRAG-PAYLOAD-V1\0'), Buffer.from(JSON.stringify(signedPayload))]),
      authority.privateKey,
    )
    .toString('base64url')

  const signedOfficial = {
    product: 'crag-v2',
    arch,
    version: claudeVersion,
    path: claudeRel,
    sha256: claudeSha,
  }
  const officialSig = crypto
    .sign(
      null,
      Buffer.concat([Buffer.from('CRAG-OFFICIAL-CLAUDE-V1\0'), Buffer.from(JSON.stringify(signedOfficial))]),
      authority.privateKey,
    )
    .toString('base64url')

  const files = {
    'crag-v2': cragElf,
    'crag-v2.payload.enc': payloadBytes,
    'crag-license-public.pem': Buffer.from(pem, 'utf8'),
    ...(unbundled ? {} : { [claudeRel]: claudeElf }),
  }
  for (const [rel, body] of Object.entries(files)) {
    const out = path.join(dir, rel)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, body, { mode: rel === 'crag-v2' || rel === claudeRel ? 0o755 : 0o644 })
  }

  if (unbundled && storeRoot) {
    const extDir = path.join(storeRoot, 'claude', 'versions', claudeVersion)
    fs.mkdirSync(extDir, { recursive: true })
    const extBin = path.join(extDir, 'claude')
    fs.writeFileSync(extBin, claudeElf, { mode: 0o555 })
    if (process.platform !== 'win32') fs.chmodSync(extBin, 0o555)
  }

  const manifest = {
    family: 'crag',
    version: 'v2',
    software_version: softwareVersion,
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
    officialClaude: {
      version: claudeVersion,
      bundled: !unbundled,
      path: claudeRel,
      sha256: claudeSha,
      signature: officialSig,
    },
    authorization: {
      scheme: 'ed25519-x25519-v1',
      product: 'crag-v2',
      public_key: pubRaw.toString('base64url'),
      public_key_id: sha(pubRaw),
    },
    payload: {
      path: 'crag-v2.payload.enc',
      ...signedPayload,
      signature: payloadSig,
    },
    sha256: Object.fromEntries(Object.entries(files).map(([rel, body]) => [rel, sha(body)])),
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  return { dir, manifest, claudeElf, cragElf }
}

function seedSharedClaudeCurrent(storeDir, claudeElf, claudeVersion = '2.1.321') {
  const claudeDir = path.join(storeDir, 'claude')
  const verDir = path.join(claudeDir, 'versions', claudeVersion)
  fs.mkdirSync(verDir, { recursive: true })
  const binPath = path.join(verDir, 'claude')
  fs.writeFileSync(binPath, claudeElf, { mode: 0o555 })
  if (process.platform !== 'win32') fs.chmodSync(binPath, 0o555)
  const link = path.join(claudeDir, 'current')
  fs.rmSync(link, { force: true })
  fs.symlinkSync(`versions/${claudeVersion}/claude`, link)
}

unixTest(
  'syncSharedStoreCrag installs read-only immutable versions, flips relative symlinks, and prunes old copies',
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-store-crag-sync-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))

    // Skips gracefully when shared store dir does not exist unless requireStore is set.
    const skipped = syncSharedStoreCrag(root, { arch: 'amd64' })
    assert.equal(skipped.ok, true)
    assert.equal(skipped.skipped, true)
    assert.equal(skipped.changed, false)
    assert.equal(syncSharedStoreCrag(root, { arch: 'amd64', requireStore: true }).code, 'shared_store_missing')

    const storeDir = path.join(root, 'store')
    fs.mkdirSync(storeDir, { recursive: true })
    seedVersionedCragPackage(root, { softwareVersion: '3.1.26', arch: 'amd64' })

    const first = syncSharedStoreCrag(root, { sharedStoreHostDir: storeDir, arch: 'amd64' })
    assert.equal(first.ok, true, first.error)
    assert.equal(first.changed, true)
    assert.equal(first.version, '3.1.26')
    assert.equal(first.target, 'versions/3.1.26')
    assert.equal(fs.readlinkSync(path.join(storeDir, 'crag', 'current')), 'versions/3.1.26')
    assert.equal(resolveSharedStoreCragCurrentDir(storeDir), path.join(storeDir, 'crag', 'versions', '3.1.26'))

    const bin3126 = path.join(storeDir, 'crag', 'versions', '3.1.26', 'crag-v2')
    const claude3126 = path.join(storeDir, 'crag', 'versions', '3.1.26', 'claude-code-2.1.321', 'claude')
    const manifest3126 = path.join(storeDir, 'crag', 'versions', '3.1.26', 'manifest.json')
    assert.equal(fs.statSync(bin3126).mode & 0o777, 0o555)
    assert.equal(fs.statSync(claude3126).mode & 0o777, 0o555)
    assert.equal(fs.statSync(manifest3126).mode & 0o777, 0o444)
    assert.equal(verifyCragV2Tree(resolveSharedStoreCragCurrentDir(storeDir), { arch: 'amd64' }).ok, true)

    const inode3126 = fs.statSync(bin3126).ino
    const second = syncSharedStoreCrag(root, { sharedStoreHostDir: storeDir, arch: 'amd64' })
    assert.equal(second.ok, true)
    assert.equal(second.changed, false)
    assert.equal(second.version, '3.1.26')
    assert.equal(fs.statSync(bin3126).ino, inode3126)

    // Upgrade to 3.1.27 keeps 3.1.26 untouched (same inode) and points previous -> versions/3.1.26.
    seedVersionedCragPackage(root, { softwareVersion: '3.1.27', arch: 'amd64' })
    const upgraded = syncSharedStoreCrag(root, { sharedStoreHostDir: storeDir, arch: 'amd64' })
    assert.equal(upgraded.ok, true, upgraded.error)
    assert.equal(upgraded.changed, true)
    assert.equal(upgraded.version, '3.1.27')
    assert.equal(fs.readlinkSync(path.join(storeDir, 'crag', 'current')), 'versions/3.1.27')
    assert.equal(fs.readlinkSync(path.join(storeDir, 'crag', 'previous')), 'versions/3.1.26')
    assert.equal(fs.statSync(bin3126).ino, inode3126)

    // Same-version rebuild writes immutable 3.1.27-<sha8> without mutating existing versions/3.1.27.
    const bin3127 = path.join(storeDir, 'crag', 'versions', '3.1.27', 'crag-v2')
    const inode3127 = fs.statSync(bin3127).ino
    seedVersionedCragPackage(root, { softwareVersion: '3.1.27', revision: 'hotfix', arch: 'amd64' })
    const rebuilt = syncSharedStoreCrag(root, { sharedStoreHostDir: storeDir, arch: 'amd64' })
    assert.equal(rebuilt.ok, true, rebuilt.error)
    assert.equal(rebuilt.changed, true)
    assert.match(rebuilt.version, /^3\.1\.27-[a-f0-9]{8}$/)
    assert.equal(fs.readlinkSync(path.join(storeDir, 'crag', 'previous')), 'versions/3.1.27')
    assert.equal(fs.statSync(bin3127).ino, inode3127)

    // Rolling back to an already-cached version directory reuses it without re-copying.
    const back = syncSharedStoreCrag(root, {
      sharedStoreHostDir: storeDir,
      arch: 'amd64',
      srcDir: path.join(storeDir, 'crag', 'versions', '3.1.26'),
    })
    assert.equal(back.ok, true, back.error)
    assert.equal(back.changed, true)
    assert.equal(back.reused, true)
    assert.equal(back.version, '3.1.26')
    assert.equal(fs.readlinkSync(path.join(storeDir, 'crag', 'current')), 'versions/3.1.26')
    assert.equal(fs.statSync(bin3126).ino, inode3126)

    // Tampered source fails closed without moving current.
    const tampered = path.join(root, 'share', 'crag', 'kernels', 'v2', 'amd64', 'crag-v2')
    fs.writeFileSync(tampered, makeElf('amd64', 'tampered'), { mode: 0o755 })
    const bad = syncSharedStoreCrag(root, { sharedStoreHostDir: storeDir, arch: 'amd64' })
    assert.equal(bad.ok, false)
    assert.equal(bad.code, 'crag_v2_hash_mismatch')
    assert.equal(fs.readlinkSync(path.join(storeDir, 'crag', 'current')), 'versions/3.1.26')

    // Pruning bounds version history while always keeping current and previous.
    for (const ver of ['3.1.28', '3.1.29', '3.1.30']) {
      seedVersionedCragPackage(root, { softwareVersion: ver, arch: 'amd64' })
      const res = syncSharedStoreCrag(root, { sharedStoreHostDir: storeDir, arch: 'amd64', retainCount: 2 })
      assert.equal(res.ok, true, res.error)
    }
    const remaining = fs.readdirSync(path.join(storeDir, 'crag', 'versions'))
    assert.equal(remaining.includes('3.1.30'), true)
    assert.equal(remaining.includes('3.1.29'), true)
    assert.equal(remaining.length, 2)
  },
)

unixTest('syncSharedStoreCrag self-heals a legacy non-symlink store/crag/current directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-store-crag-legacy-dir-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const storeDir = path.join(root, 'store')
  const legacyCurrent = path.join(storeDir, 'crag', 'current')
  fs.mkdirSync(legacyCurrent, { recursive: true })
  fs.writeFileSync(path.join(legacyCurrent, 'stale.txt'), 'old-layout')
  seedVersionedCragPackage(root, { softwareVersion: '3.1.27', arch: 'amd64' })

  const res = syncSharedStoreCrag(root, { sharedStoreHostDir: storeDir, arch: 'amd64' })
  assert.equal(res.ok, true, res.error)
  assert.equal(res.changed, true)
  assert.equal(fs.lstatSync(legacyCurrent).isSymbolicLink(), true)
  assert.equal(fs.readlinkSync(legacyCurrent), 'versions/3.1.27')
})

unixTest(
  'crag-debian13 KVM materializeCragV2, inspectKernelChanges, buildKvmRunArgs, and auth-login follow store CRAG upgrades',
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-store-crag-kvm-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const storeDir = path.join(root, 'store')
    fs.mkdirSync(storeDir, { recursive: true })
    const pkg26 = seedVersionedCragPackage(root, { softwareVersion: '3.1.26', arch: 'amd64' })
    seedSharedClaudeCurrent(storeDir, pkg26.claudeElf, '2.1.321')

    const vm = {
      id: 'vm-38',
      kernel: 'crag-debian13',
      dataplane: 'crag',
      crag_kernel_version: 'v2',
      runtime: { type: 'kvm', arch: 'amd64' },
      timezone: 'UTC',
      locale: 'en_US.UTF-8',
      machine: {
        memory: '2g',
        vcpus: 2,
        disk_gb: 20,
        cpu_model: 'host',
        mac: '52:54:00:aa:bb:cc',
        disk_serial: 'KIN0038',
      },
      fingerprint: { hostname: 'ws-38', guest_machine_id: '0123456789abcdef0123456789abcdef' },
    }

    // stageBundledAuthClaude works when only store/crag/current symlink exists (no symlink rejection).
    const seeded = syncSharedStoreCrag(root, { sharedStoreHostDir: storeDir, arch: 'amd64' })
    assert.equal(seeded.ok, true)
    assert.doesNotThrow(() => stageBundledAuthClaude(root, vm))

    // First materialization syncs both slot .kin/crag-v2 and shared store.
    const mat1 = materializeCragV2(root, vm, { select: true })
    assert.equal(mat1.ok, true, mat1.error)
    assert.equal(fs.readlinkSync(path.join(storeDir, 'crag', 'current')), 'versions/3.1.26')
    assert.equal(inspectKernelChanges(root, [vm]).items[0].kernel_changed, false)

    // Upgrade share/crag to 3.1.27; inspectKernelChanges detects change and materializeCragV2 updates store/crag/current.
    seedVersionedCragPackage(root, { softwareVersion: '3.1.27', arch: 'amd64' })
    assert.equal(sharedStoreCragWouldChange(path.join(root, 'share/crag/kernels/v2/amd64'), storeDir, 'amd64'), true)
    assert.equal(inspectKernelChanges(root, [vm]).items[0].kernel_changed, true)

    const mat2 = materializeCragV2(root, vm, { select: true })
    assert.equal(mat2.ok, true, mat2.error)
    assert.equal(mat2.changed, true)
    assert.equal(mat2.kernel_changed, true)
    assert.equal(mat2.shared_store_crag_changed, true)
    assert.equal(fs.readlinkSync(path.join(storeDir, 'crag', 'current')), 'versions/3.1.27')
    assert.equal(fs.readlinkSync(path.join(storeDir, 'crag', 'previous')), 'versions/3.1.26')
    assert.equal(inspectKernelChanges(root, [vm]).items[0].kernel_changed, false)

    // Even when slot .kin/crag-v2 already matches 3.1.27, a stale store/crag/current triggers update & kernel_changed=true.
    const stale = syncSharedStoreCrag(root, {
      sharedStoreHostDir: storeDir,
      arch: 'amd64',
      srcDir: path.join(storeDir, 'crag', 'versions', '3.1.26'),
    })
    assert.equal(stale.ok, true)
    assert.equal(fs.readlinkSync(path.join(storeDir, 'crag', 'current')), 'versions/3.1.26')
    assert.equal(inspectKernelChanges(root, [vm]).items[0].kernel_changed, true)

    const mat3 = materializeCragV2(root, vm, { select: true })
    assert.equal(mat3.ok, true, mat3.error)
    assert.equal(mat3.changed, true)
    assert.equal(mat3.kernel_changed, true)
    assert.equal(mat3.shared_store_crag_changed, true)
    assert.equal(fs.readlinkSync(path.join(storeDir, 'crag', 'current')), 'versions/3.1.27')

    // buildKvmRunArgs also keeps store/crag/current synced for custom-erofs KVM.
    seedVersionedCragPackage(root, { softwareVersion: '3.1.28', arch: 'amd64' })
    const kvmDir = path.join(root, 'vms', vm.id, 'kvm')
    fs.mkdirSync(path.join(kvmDir, 'fingerprint'), { recursive: true })
    fs.writeFileSync(
      path.join(kvmDir, 'fingerprint', 'qemu-smbios.args'),
      '-uuid\n11111111-2222-4333-8444-555555555555\n-smbios\ntype=1,manufacturer=LENOVO,product=ThinkPad\n',
    )
    buildKvmRunArgs({
      vm,
      name: 'kin-38',
      image: 'ghcr.io/example/kin-kvm-debian:13',
      hostName: 'ws-38',
      network: 'kin-eg-px',
      memory: '2g',
      accel: 'kvm',
      uid: 1000,
      gid: 1000,
      home: path.join(root, 'vms', vm.id, 'cli-home'),
      runDir: path.join(root, 'vms', vm.id, 'run'),
      kvmDir,
      projectRoot: root,
      vhostVsockAvailable: true,
    })
    assert.equal(fs.readlinkSync(path.join(storeDir, 'crag', 'current')), 'versions/3.1.28')
  },
)

unixTest(
  'installKernelTargets updates store/crag/current on upgrade and restores previous version on rollback',
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-store-crag-rollback-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const storeDir = path.join(root, 'store')
    fs.mkdirSync(storeDir, { recursive: true })
    const runDir = path.join(root, 'linux-private-run', 'vm-39')
    fs.mkdirSync(runDir, { recursive: true })

    const vm = {
      id: 'vm-39',
      status: 'running',
      kernel: 'crag-debian13',
      dataplane: 'crag',
      crag_kernel_version: 'v2',
      timezone: 'UTC',
      runtime: { type: 'kvm', arch: 'amd64', worker_run_dir: runDir },
      fingerprint: { hostname: 'ws-39', guest_machine_id: '0123456789abcdef0123456789abcdef' },
      seed_policy: { telemetry: false },
      claude: { account_uuid: 'acct-39', has_access: true },
    }
    fs.mkdirSync(path.join(root, 'vms', vm.id, 'cli-home', '.claude'), { recursive: true })
    fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
    fs.writeFileSync(path.join(root, 'vms', vm.id, 'cli-home', '.claude', 'credentials.json'), 'cred-39')

    // Initial state: slot running on 3.1.26 with synced shared store.
    seedVersionedCragPackage(root, { softwareVersion: '3.1.26', arch: 'amd64' })
    const activated = activateCragLicense(root, vm, issueUniversalCode(root).code)
    assert.equal(activated.license.valid, true)
    const initialMat = materializeCragV2(root, vm, { select: true })
    assert.equal(initialMat.ok, true, initialMat.error)
    assert.equal(fs.readlinkSync(path.join(storeDir, 'crag', 'current')), 'versions/3.1.26')

    // Host upgrades share/crag to 3.1.27; installKernelTargets fails health check on 3.1.27 and rolls back to 3.1.26.
    seedVersionedCragPackage(root, { softwareVersion: '3.1.27', arch: 'amd64' })
    const observedStoreTargets = []
    let startAttempt = 0
    const result = await installKernelTargets({
      projectRoot: root,
      targets: [{ id: vm.id, kernel: 'crag' }],
      ops: {
        stopSlot: async () => ({ ok: true, runtime: { stopped: true } }),
        suspendVmRuntimeRestart: async () => ({ ok: true }),
        initializeSlotSeedFiles: async () => ({ ok: true }),
        writeKernelConfig: () => ({ configPath: path.join(runDir, 'kernel.json'), runDir }),
        startSlotReady: async () => {
          startAttempt += 1
          observedStoreTargets.push(fs.readlinkSync(path.join(storeDir, 'crag', 'current')))
          if (startAttempt === 1) {
            return { ok: false, code: 'kernel_health_timeout', error: 'simulated 3.1.27 boot failure' }
          }
          return { ok: true, rust_ok: true, rust: { ok: true }, runtime: { stopped: false } }
        },
        rustKernelHealth: async () => ({
          ok: true,
          healthy: true,
          internalTokenAuthenticated: true,
          runtime_variant: 'crag-v2',
          execution_mode: 'v2_process_pool',
          cli_pid: 4242,
        }),
      },
    })

    assert.equal(result.ok, false)
    assert.equal(result.items[0].rolled_back, true, JSON.stringify(result.items[0]))
    assert.deepEqual(observedStoreTargets, ['versions/3.1.27', 'versions/3.1.26'])
    assert.equal(fs.readlinkSync(path.join(storeDir, 'crag', 'current')), 'versions/3.1.26')

    // Unbundled (bundled:false) CRAG upgrade on crag-debian13 KVM passes preflight and updates store/crag/current.
    seedVersionedCragPackage(root, {
      softwareVersion: '3.1.28',
      arch: 'amd64',
      unbundled: true,
      storeRoot: storeDir,
    })
    const unbundledUpgrade = await installKernelTargets({
      projectRoot: root,
      targets: [{ id: vm.id, kernel: 'crag' }],
      ops: {
        stopSlot: async () => ({ ok: true, runtime: { stopped: true } }),
        suspendVmRuntimeRestart: async () => ({ ok: true }),
        initializeSlotSeedFiles: async () => ({ ok: true }),
        writeKernelConfig: () => ({ configPath: path.join(runDir, 'kernel.json'), runDir }),
        startSlotReady: async () => ({ ok: true, rust_ok: true, rust: { ok: true }, runtime: { stopped: false } }),
      },
    })
    assert.equal(unbundledUpgrade.ok, true, JSON.stringify(unbundledUpgrade))
    assert.equal(fs.readlinkSync(path.join(storeDir, 'crag', 'current')), 'versions/3.1.28')
    assert.equal(fs.readlinkSync(path.join(storeDir, 'crag', 'previous')), 'versions/3.1.26')
  },
)
