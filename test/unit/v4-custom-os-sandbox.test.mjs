import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { verifyCragV2Tree } from '../../src/lib/vm/wrap-cli-runtime.mjs'
import { resolveSlotClaude } from '../../src/lib/vm/slot-engine.mjs'
import { writeKernelConfig } from '../../src/lib/transport/rust-kernel-supervisor.mjs'
import {
  cragCustomOsDockerMountArgs,
  cragDockerSandboxArgs,
  nativeSlotSandboxNeedsRecreate,
} from '../../src/lib/vm/vm-runtime.mjs'
import {
  clusterCragContainerReady,
  clusterDockerCommandReady,
  slotContainerBody,
} from '../../src/lib/cluster/remote-slot.mjs'
import {
  clusterManagedSettingsBind,
  hasLocalManagedSettings,
  localComputerFiles,
  localManagedSettingsFiles,
} from '../../src/lib/cluster/slot-computer-files.mjs'

const unixTest = process.platform === 'win32' ? test.skip : test
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

function makeElf(arch = 'amd64', marker = 'bin') {
  const buf = Buffer.alloc(96 + Buffer.byteLength(marker))
  buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  buf.writeUInt16LE(3, 16)
  buf.writeUInt16LE(arch === 'amd64' ? 62 : 183, 18)
  buf.writeUInt32LE(1, 20)
  buf.write(marker, 96)
  return buf
}

function buildUnbundledCragTree(
  pkgDir,
  storeRoot,
  {
    arch = 'amd64',
    claudeVersion = '2.1.321',
    claudeMode = 0o555,
    tamperSig = false,
    tamperExternalSha = false,
    omitSignature = false,
    useSymlinkExternal = false,
    extraCaps = ['headless_claude_bridge_v1', 'generation_controls_v3'],
  } = {},
) {
  fs.mkdirSync(pkgDir, { recursive: true })
  const versionsDir = path.join(storeRoot, 'claude', 'versions', claudeVersion)
  fs.mkdirSync(versionsDir, { recursive: true })

  const keys = crypto.generateKeyPairSync('ed25519')
  const payloadKey = crypto.randomBytes(32)
  const bootstrapElf = makeElf(arch, `bootstrap-${claudeVersion}`)
  const claudeElf = makeElf(arch, `shared-claude-${claudeVersion}`)
  const claudeSha = sha(claudeElf)

  const externalBin = path.join(versionsDir, 'claude')
  if (useSymlinkExternal) {
    const outside = path.join(storeRoot, 'outside-claude')
    fs.writeFileSync(outside, claudeElf, { mode: claudeMode })
    fs.symlinkSync(outside, externalBin)
  } else {
    fs.writeFileSync(externalBin, tamperExternalSha ? makeElf(arch, 'tampered') : claudeElf, { mode: claudeMode })
    if (process.platform !== 'win32') fs.chmodSync(externalBin, claudeMode)
  }

  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', payloadKey, nonce)
  cipher.setAAD(Buffer.from('CRAG-V2-PAYLOAD-V1\0'))
  const encrypted = Buffer.concat([cipher.update(bootstrapElf), cipher.final()])
  const payloadBytes = Buffer.concat([Buffer.from('CRAGV2E1'), nonce, cipher.getAuthTag(), encrypted])

  const pem = keys.publicKey.export({ format: 'pem', type: 'spki' })
  const pubRaw = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  const issuerPublicKeyId = sha(pubRaw)
  const payloadKeyId = sha(payloadKey)
  const payloadSigned = {
    product: 'crag-v2',
    format: 'CRAGV2E1',
    algorithm: 'aes-256-gcm',
    key_id: payloadKeyId,
    plaintext_sha256: sha(bootstrapElf),
    ciphertext_sha256: sha(payloadBytes),
  }
  const payloadSignature = crypto
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

  const claudeRelPath = `claude-code-${claudeVersion}/claude`
  const signedOfficial = {
    product: 'crag-v2',
    arch,
    version: claudeVersion,
    path: claudeRelPath,
    sha256: claudeSha,
  }
  const sigBuf = crypto.sign(
    null,
    Buffer.concat([Buffer.from('CRAG-OFFICIAL-CLAUDE-V1\0'), Buffer.from(JSON.stringify(signedOfficial))]),
    keys.privateKey,
  )
  if (tamperSig) sigBuf[0] ^= 0xff

  const officialClaude = {
    version: claudeVersion,
    bundled: false,
    path: claudeRelPath,
    sha256: claudeSha,
    ...(omitSignature ? {} : { signature: sigBuf.toString('base64url') }),
  }

  const manifest = {
    family: 'crag',
    version: 'v2',
    arch,
    runtime: 'native',
    entrypoint: 'crag-v2',
    encrypted: true,
    capabilities: ['official_full', 'zero', 'cancel', 'telemetry', 'unix_socket_envelope', ...extraCaps],
    officialClaude,
    authorization: {
      scheme: 'ed25519-x25519-v1',
      product: 'crag-v2',
      public_key: pubRaw.toString('base64url'),
      public_key_id: issuerPublicKeyId,
    },
    payload: {
      path: 'crag-v2.payload.enc',
      ...payloadSigned,
      signature: payloadSignature,
    },
    sha256: Object.fromEntries(Object.entries(files).map(([rel, bytes]) => [rel, sha(bytes)])),
  }
  fs.writeFileSync(path.join(pkgDir, 'manifest.json'), JSON.stringify(manifest))
  return { pkgDir, storeRoot, externalBin, manifest, issuerPublicKeyId, payloadKeyId }
}

unixTest(
  'verifyCragV2Tree enforces fail-closed O_NOFOLLOW, RO prefix, SHA-256, and Ed25519 checks for bundled:false',
  (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-unbundled-'))
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

    const okCase = buildUnbundledCragTree(path.join(tmp, 'pkg-ok'), path.join(tmp, 'store-ok'))
    // Default legacy mode MUST reject bundled=false
    const legacyDenied = verifyCragV2Tree(okCase.pkgDir, { expectedArch: 'amd64' })
    assert.equal(legacyDenied.ok, false)

    // Controlled custom-os shared store mode MUST pass when all invariants hold
    const customOk = verifyCragV2Tree(okCase.pkgDir, {
      expectedArch: 'amd64',
      expectedIssuerPublicKeyId: okCase.issuerPublicKeyId,
      expectedPayloadKeyId: okCase.payloadKeyId,
      allowUnbundledStore: true,
      sharedClaudeStoreRoot: okCase.storeRoot,
    })
    assert.equal(customOk.ok, true)
    assert.equal(customOk.bundledClaude, false)
    assert.equal(customOk.claudeVersion, '2.1.321')
    assert.equal(customOk.externalClaudeBin, okCase.externalBin)

    // Symlink escape rejected via O_NOFOLLOW
    const symCase = buildUnbundledCragTree(path.join(tmp, 'pkg-sym'), path.join(tmp, 'store-sym'), {
      useSymlinkExternal: true,
    })
    const symRes = verifyCragV2Tree(symCase.pkgDir, {
      expectedArch: 'amd64',
      allowUnbundledStore: true,
      sharedClaudeStoreRoot: symCase.storeRoot,
    })
    assert.equal(symRes.ok, false)
    assert.equal(symRes.code, 'shared_store_symlink_rejected')

    // Writable external binary (0755) rejected
    const writableCase = buildUnbundledCragTree(path.join(tmp, 'pkg-wr'), path.join(tmp, 'store-wr'), {
      claudeMode: 0o755,
    })
    const wrRes = verifyCragV2Tree(writableCase.pkgDir, {
      expectedArch: 'amd64',
      allowUnbundledStore: true,
      sharedClaudeStoreRoot: writableCase.storeRoot,
    })
    assert.equal(wrRes.ok, false)
    assert.equal(wrRes.code, 'shared_store_writable_rejected')

    // Path escape outside whitelist rejected
    const escapeRes = verifyCragV2Tree(okCase.pkgDir, {
      expectedArch: 'amd64',
      allowUnbundledStore: true,
      sharedClaudeStoreRoot: okCase.storeRoot,
      externalClaudeBin: path.join(tmp, 'store-ok', 'crag-escape'),
    })
    assert.equal(escapeRes.ok, false)
    assert.equal(escapeRes.code, 'shared_store_path_escape')

    // SHA-256 mismatch rejected
    const shaCase = buildUnbundledCragTree(path.join(tmp, 'pkg-sha'), path.join(tmp, 'store-sha'), {
      tamperExternalSha: true,
    })
    assert.equal(
      verifyCragV2Tree(shaCase.pkgDir, {
        expectedArch: 'amd64',
        allowUnbundledStore: true,
        sharedClaudeStoreRoot: shaCase.storeRoot,
      }).code,
      'crag_v2_hash_mismatch',
    )

    // Tampered or missing Ed25519 signature rejected
    const badSig = buildUnbundledCragTree(path.join(tmp, 'pkg-sig'), path.join(tmp, 'store-sig'), { tamperSig: true })
    assert.equal(
      verifyCragV2Tree(badSig.pkgDir, {
        expectedArch: 'amd64',
        allowUnbundledStore: true,
        sharedClaudeStoreRoot: badSig.storeRoot,
      }).ok,
      false,
    )
    const noSig = buildUnbundledCragTree(path.join(tmp, 'pkg-nosig'), path.join(tmp, 'store-nosig'), {
      omitSignature: true,
    })
    assert.equal(
      verifyCragV2Tree(noSig.pkgDir, {
        expectedArch: 'amd64',
        allowUnbundledStore: true,
        sharedClaudeStoreRoot: noSig.storeRoot,
      }).ok,
      false,
    )
  },
)

test('resolveSlotClaude and writeKernelConfig distinguish bundled:true vs bundled:false in custom-os mode', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-os-kcfg-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

  const unbundledVm = {
    id: 'vm-42',
    dataplane: 'crag',
    crag_kernel_version: 'v2',
    kernel_installation: {
      capabilities: ['headless_claude_bridge_v1', 'generation_controls_v3'],
      manifest: {
        capabilities: ['headless_claude_bridge_v1', 'generation_controls_v3'],
        officialClaude: { version: '2.1.321', bundled: false, path: 'claude-code-2.1.321/claude' },
      },
    },
  }
  const bundledVm = {
    id: 'vm-43',
    dataplane: 'crag',
    crag_kernel_version: 'v2',
    kernel_installation: {
      capabilities: ['headless_claude_bridge_v1', 'generation_controls_v3'],
      manifest: {
        capabilities: ['headless_claude_bridge_v1', 'generation_controls_v3'],
        officialClaude: { version: '2.1.321', bundled: true, path: 'claude-code-2.1.321/claude' },
      },
    },
  }

  // Legacy mode preserves bin === '' for V4 headless bridge
  const legacyClaude = resolveSlotClaude(unbundledVm, {}, { runtimeMode: 'legacy' })
  assert.equal(legacyClaude.headlessBridge, true)
  assert.equal(legacyClaude.bin, '')
  assert.equal(legacyClaude.sharedStore, undefined)

  // Custom OS + bundled:false emits read-only shared claude_bin + profiles dir
  const unbundledClaude = resolveSlotClaude(unbundledVm, {}, { runtimeMode: 'custom-os' })
  assert.equal(unbundledClaude.headlessBridge, true)
  assert.equal(unbundledClaude.customOs, true)
  assert.equal(unbundledClaude.sharedStore, true)
  assert.equal(unbundledClaude.bin, '/opt/kin/store/claude/versions/2.1.321/claude')
  assert.equal(unbundledClaude.wireProfileReadonlyDir, '/opt/kin/store/profiles')

  // Custom OS + bundled:true MUST keep bin === '' (so WU-1A assets.rs bundled verification succeeds)
  // while still emitting wire_profile_readonly_dir & bridge_socket_dir
  const bundledClaude = resolveSlotClaude(bundledVm, {}, { runtimeMode: 'custom-os' })
  assert.equal(bundledClaude.headlessBridge, true)
  assert.equal(bundledClaude.customOs, true)
  assert.equal(bundledClaude.sharedStore, false)
  assert.equal(bundledClaude.bundledClaude, true)
  assert.equal(bundledClaude.bin, '')
  assert.equal(bundledClaude.wireProfileReadonlyDir, '/opt/kin/store/profiles')

  // writeKernelConfig integration across all 3 paths
  const legacyRes = writeKernelConfig(tmp, unbundledVm, { token: 'tok-1', publish: false, runtimeMode: 'legacy' })
  const legacyCfg = JSON.parse(fs.readFileSync(legacyRes.configPath, 'utf8'))
  assert.equal(legacyCfg.claude_bin, '')
  assert.equal(legacyCfg.wire_profile_readonly_dir, undefined)
  assert.equal(legacyCfg.bridge_socket_dir, undefined)

  const customUnbundledRes = writeKernelConfig(tmp, unbundledVm, {
    token: 'tok-1',
    publish: false,
    runtimeMode: 'custom-os',
  })
  const customUnbundledCfg = JSON.parse(fs.readFileSync(customUnbundledRes.configPath, 'utf8'))
  assert.equal(customUnbundledCfg.claude_bin, '/opt/kin/store/claude/versions/2.1.321/claude')
  assert.equal(customUnbundledCfg.wire_profile_readonly_dir, '/opt/kin/store/profiles')
  assert.equal(customUnbundledCfg.bridge_socket_dir, '/run/kin/bridge')

  const customBundledRes = writeKernelConfig(tmp, bundledVm, {
    token: 'tok-2',
    publish: false,
    runtimeMode: 'custom-os',
  })
  const customBundledCfg = JSON.parse(fs.readFileSync(customBundledRes.configPath, 'utf8'))
  assert.equal(customBundledCfg.claude_bin, '')
  assert.equal(customBundledCfg.wire_profile_readonly_dir, '/opt/kin/store/profiles')
  assert.equal(customBundledCfg.bridge_socket_dir, '/run/kin/bridge')
})

test('slot-computer-files optionally collects managed-settings.d drop-ins while preserving legacy slots without them', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-managed-d-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

  const vm = { id: 'vm-55' }
  const sysDir = path.join(tmp, 'vms', 'vm-55', 'kvm', 'fingerprint', 'system')
  fs.mkdirSync(path.join(sysDir, 'etc'), { recursive: true })
  fs.mkdirSync(path.join(sysDir, 'dmi', 'id'), { recursive: true })
  fs.mkdirSync(path.join(sysDir, 'hardware'), { recursive: true })
  fs.writeFileSync(path.join(sysDir, 'etc', 'kin-computer'), 'kind=pc\n')
  fs.writeFileSync(path.join(sysDir, 'dmi', 'id', 'sys_vendor'), 'Dell Inc.\n')
  fs.writeFileSync(path.join(sysDir, 'hardware', 'cpu'), 'Intel\n')

  // Legacy slot without managed-settings.d remains valid and reports hasLocalManagedSettings=false
  assert.equal(hasLocalManagedSettings(tmp, vm), false)
  assert.deepEqual(localManagedSettingsFiles(tmp, vm), [])
  const legacyFiles = localComputerFiles(tmp, vm)
  assert.equal(legacyFiles.length, 3)

  // Adding WU-1B 10-slot-preset.json makes it collected automatically for cluster push + RO bind
  const dropinDir = path.join(sysDir, 'etc', 'claude-code', 'managed-settings.d')
  fs.mkdirSync(dropinDir, { recursive: true })
  const presetBody = JSON.stringify({ theme: 'dark', env: { TZ: 'UTC', LANG: 'en_US.UTF-8' } })
  fs.writeFileSync(path.join(dropinDir, '10-slot-preset.json'), presetBody)
  fs.writeFileSync(path.join(dropinDir, '.ignored.json'), '{}')
  fs.writeFileSync(path.join(dropinDir, 'README.txt'), 'ignore')

  assert.equal(hasLocalManagedSettings(tmp, vm), true)
  const dropins = localManagedSettingsFiles(tmp, vm)
  assert.deepEqual(
    dropins.map((f) => f.rel),
    ['etc/claude-code/managed-settings.d/10-slot-preset.json'],
  )
  const allFiles = localComputerFiles(tmp, vm)
  assert.ok(allFiles.some((f) => f.rel === 'etc/claude-code/managed-settings.d/10-slot-preset.json'))
  assert.equal(
    clusterManagedSettingsBind('/srv/slots/vm-55'),
    '/srv/slots/vm-55/computer/etc/claude-code/managed-settings.d:/etc/claude-code/managed-settings.d:ro',
  )
})

test('V4 + custom-os unloads Docker crag-v2-seccomp and AppArmor overrides locally & remotely while preserving legacy V3', () => {
  const v4Vm = {
    id: 'vm-21',
    kernel: 'debian-13',
    timezone: 'UTC',
    locale: 'en_US.UTF-8',
    dataplane: 'crag',
    crag_kernel_version: 'v2',
    capabilities: ['headless_claude_bridge_v1', 'generation_controls_v3'],
  }
  const v3Vm = {
    id: 'vm-22',
    kernel: 'debian-12',
    timezone: 'UTC',
    locale: 'en_US.UTF-8',
    dataplane: 'crag',
    crag_kernel_version: 'v2',
    capabilities: ['linux_tui_native_queue', 'generation_controls_v3'],
  }

  // Local Docker sandbox args: V4 + custom-os drops seccomp & apparmor overrides
  const v4Args = cragDockerSandboxArgs(
    v4Vm,
    {},
    { runtimeMode: 'custom-os', appArmorEnabled: true, userNamespaceRestricted: true },
  )
  assert.deepEqual(v4Args, ['--security-opt', 'no-new-privileges', '--init'])
  assert.equal(
    v4Args.some((a) => a.includes('seccomp=') || a.includes('apparmor=') || a.includes('DUMPABLE')),
    false,
  )

  // Local Docker mounts for V4 + custom-os
  const v4Mounts = cragCustomOsDockerMountArgs(v4Vm, {
    runtimeMode: 'custom-os',
    sharedStoreHostDir: '/opt/vm2api/store',
    managedSettingsDir: '/opt/vm2api/vms/vm-21/managed-settings.d',
  })
  assert.ok(v4Mounts.includes('/run/kin/bridge:rw,noexec,nosuid,nodev,size=16m'))
  assert.ok(v4Mounts.includes('type=bind,source=/opt/vm2api/store,target=/opt/kin/store,readonly'))
  assert.ok(
    v4Mounts.includes(
      'type=bind,source=/opt/vm2api/vms/vm-21/managed-settings.d,target=/etc/claude-code/managed-settings.d,readonly',
    ),
  )

  // Legacy mode or V3 retains custom seccomp + AppArmor profile and emits no custom-os mounts
  const v4LegacyArgs = cragDockerSandboxArgs(
    v4Vm,
    {},
    { runtimeMode: 'legacy', appArmorEnabled: true, userNamespaceRestricted: true },
  )
  assert.ok(v4LegacyArgs.some((a) => a.startsWith('seccomp=')))
  assert.ok(v4LegacyArgs.includes('apparmor=vm2api-crag-docker'))
  assert.deepEqual(
    cragCustomOsDockerMountArgs(v4Vm, { runtimeMode: 'legacy', sharedStoreHostDir: '/opt/vm2api/store' }),
    [],
  )

  const v3CustomArgs = cragDockerSandboxArgs(
    v3Vm,
    {},
    { runtimeMode: 'custom-os', appArmorEnabled: true, userNamespaceRestricted: false },
  )
  assert.ok(v3CustomArgs.some((a) => a.startsWith('seccomp=')))
  assert.ok(v3CustomArgs.includes('apparmor=unconfined'))

  // nativeSlotSandboxNeedsRecreate migrates legacy overrides off V4 + custom-os containers
  assert.equal(
    nativeSlotSandboxNeedsRecreate(
      { securityOpts: ['no-new-privileges'], init: true },
      v4Vm,
      {},
      { runtimeMode: 'custom-os' },
    ),
    false,
  )
  assert.equal(
    nativeSlotSandboxNeedsRecreate(
      { securityOpts: ['no-new-privileges', 'seccomp=/x', 'apparmor=unconfined'], init: true },
      v4Vm,
      {},
      { runtimeMode: 'custom-os' },
    ),
    true,
  )

  // Remote cluster Docker slot body: V4 + custom-os removes seccomp & apparmor=unconfined, adds /run/kin/bridge + RO mounts
  const remoteV4Body = slotContainerBody(v4Vm, {
    image: 'ghcr.io/dofastted/kin-os-debian:13-baked',
    network: 'kin-net',
    remoteDir: '/srv/slots/vm-21',
    user: '10021:987',
    routing: {},
    runtimeMode: 'custom-os',
    sharedStoreDir: '/opt/vm2api/store',
    managedSettings: true,
  })
  assert.deepEqual(remoteV4Body.HostConfig.SecurityOpt, ['no-new-privileges'])
  assert.equal(remoteV4Body.HostConfig.ReadonlyRootfs, true)
  assert.deepEqual(remoteV4Body.HostConfig.CapDrop, ['ALL'])
  assert.equal(remoteV4Body.HostConfig.Init, true)
  assert.equal(remoteV4Body.HostConfig.Tmpfs['/run/kin/bridge'], 'rw,noexec,nosuid,nodev,size=16m')
  assert.ok(remoteV4Body.HostConfig.Binds.includes('/opt/vm2api/store:/opt/kin/store:ro'))
  assert.ok(
    remoteV4Body.HostConfig.Binds.includes(
      '/srv/slots/vm-21/computer/etc/claude-code/managed-settings.d:/etc/claude-code/managed-settings.d:ro',
    ),
  )
  assert.equal(
    clusterCragContainerReady(
      { Config: { Cmd: remoteV4Body.Cmd }, HostConfig: remoteV4Body.HostConfig },
      { v4CustomOs: true },
    ),
    true,
  )
  assert.equal(
    clusterDockerCommandReady(
      { ...v4Vm, node_id: 'node-1' },
      { Config: { Cmd: remoteV4Body.Cmd }, HostConfig: remoteV4Body.HostConfig },
      {},
      { runtimeMode: 'custom-os' },
    ),
    true,
  )

  // Remote legacy mode preserves seccomp & apparmor=unconfined
  const remoteLegacyBody = slotContainerBody(v4Vm, {
    image: 'ghcr.io/dofastted/kin-os-debian:12',
    network: 'kin-net',
    remoteDir: '/srv/slots/vm-21',
    user: '10021:987',
    routing: {},
    runtimeMode: 'legacy',
  })
  assert.ok(remoteLegacyBody.HostConfig.SecurityOpt.some((o) => o.startsWith('seccomp=')))
  assert.ok(remoteLegacyBody.HostConfig.SecurityOpt.includes('apparmor=unconfined'))
  assert.equal(remoteLegacyBody.HostConfig.Tmpfs['/run/kin/bridge'], undefined)
})
