import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertAuthLoginReady,
  resolveAuthLoginClaude,
  stageBundledAuthClaude,
} from '../../src/lib/oauth/claude-auth-login.mjs'
import { writeKernelConfig } from '../../src/lib/transport/rust-kernel-supervisor.mjs'
import {
  CUSTOM_OS_BRIDGE_TMPFS_DIR,
  CUSTOM_OS_CLAUDE_CURRENT,
  CUSTOM_OS_MANAGED_SETTINGS_D,
  CUSTOM_OS_PROFILES_DIR,
  CUSTOM_OS_RUNTIME_MODE_CUSTOM,
  CUSTOM_OS_RUNTIME_MODE_LEGACY,
  DEFAULT_KVM_VSOCK_PORT,
  KVM_MODE_CUSTOM_EROFS,
} from '../../src/lib/vm/custom-os-runtime.mjs'
import { LOCAL_CRAG_CLAUDE, REMOTE_CRAG_CLAUDE } from '../../src/lib/vm/slot-engine.mjs'
import { slotExecArgv, slotExecCmd } from '../../src/lib/vm/slot-exec.mjs'
import { panelShellLaunch, terminalClaudeBin } from '../../src/lib/vm/slot-shell.mjs'
import { hasLocalManagedSettings, localManagedSettingsFiles } from '../../src/lib/cluster/slot-computer-files.mjs'
import { FORBIDDEN_MANAGED_ENV_KEYS, verifyManagedSettingsContent } from '../../scripts/verify-os-image-secrets.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const unixTest = process.platform === 'win32' ? test.skip : test
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

function makeElf(arch = 'amd64', marker = 'parity-bin') {
  const buf = Buffer.alloc(96 + Buffer.byteLength(marker))
  buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  buf.writeUInt16LE(3, 16)
  buf.writeUInt16LE(arch === 'amd64' ? 62 : 183, 18)
  buf.writeUInt32LE(1, 20)
  buf.write(marker, 96)
  return buf
}

function seedSharedStoreAndUnbundledCrag(
  root,
  { arch = 'amd64', version = '2.1.321', claudeMode = 0o555, includeCragPackage = true, tamperStoreBytes = false } = {},
) {
  const storeRoot = path.join(root, 'store')
  const versionsDir = path.join(storeRoot, 'claude', 'versions', version)
  fs.mkdirSync(versionsDir, { recursive: true })

  const claudeElf = makeElf(arch, `official-claude-${version}`)
  const claudeSha = sha(claudeElf)
  const storeBin = path.join(versionsDir, 'claude')
  fs.writeFileSync(storeBin, tamperStoreBytes ? makeElf(arch, 'tampered-claude') : claudeElf, { mode: claudeMode })
  if (process.platform !== 'win32') fs.chmodSync(storeBin, claudeMode)
  const currentLink = path.join(storeRoot, 'claude', 'current')
  fs.symlinkSync(`versions/${version}/claude`, currentLink)

  let pkgDir = ''
  if (includeCragPackage) {
    pkgDir = path.join(root, 'share', 'crag', 'kernels', 'v2', arch)
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

    const claudeRelPath = `claude-code-${version}/claude`
    const signedOfficial = {
      product: 'crag-v2',
      arch,
      version,
      path: claudeRelPath,
      sha256: claudeSha,
    }
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
      officialClaude: {
        version,
        bundled: false,
        path: claudeRelPath,
        sha256: claudeSha,
        signature: officialSig,
      },
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
  }

  return { storeRoot, storeBin, currentLink, pkgDir }
}

test('Docker vs KVM slotExecArgv & slotExecCmd parity with exact kin-guest-exec divergence boundary', () => {
  const dockerVm = { id: 'vm-parity-doc', runtime: { type: 'docker' } }
  const kvmVm = { id: 'vm-parity-kvm', runtime: { type: 'kvm' } }
  const innerCmd = ['sh', '-c', 'test -f "$1" && test -x "$1"', 'auth-cli', CUSTOM_OS_CLAUDE_CURRENT]
  const execOpts = {
    user: '10001:987',
    workdir: '/home/kincli',
    env: ['HOME=/home/kincli', 'CLAUDE_CONFIG_DIR=/home/kincli/.claude'],
    tty: true,
    interactive: true,
  }

  const docArgv = slotExecArgv(dockerVm, innerCmd, execOpts)
  const kvmArgv = slotExecArgv(kvmVm, innerCmd, execOpts)
  assert.deepEqual(docArgv.slice(0, 2), ['exec', '-i'])
  assert.equal(docArgv.includes('/usr/local/bin/kin-guest-exec'), false)
  assert.ok(docArgv.includes('kin-parity-doc'))
  assert.deepEqual(docArgv.slice(-innerCmd.length), innerCmd)

  assert.deepEqual(kvmArgv.slice(0, 2), ['exec', '-i'])
  assert.ok(kvmArgv.includes('kin-parity-kvm'))
  assert.ok(kvmArgv.includes('/usr/local/bin/kin-guest-exec'))
  assert.deepEqual(kvmArgv.slice(-innerCmd.length), innerCmd)

  const docCmd = slotExecCmd(dockerVm, innerCmd, execOpts)
  const kvmCmd = slotExecCmd(kvmVm, innerCmd, execOpts)
  assert.equal(docCmd.User, '10001:987')
  assert.deepEqual(docCmd.Cmd, innerCmd)
  assert.deepEqual(Object.keys(docCmd).sort(), ['Cmd', 'User'])

  // Only legitimate KVM divergence: kin-guest-exec shim handles user/workdir/env/tty inside guest.
  assert.equal(kvmCmd.User, '')
  assert.deepEqual(Object.keys(kvmCmd).sort(), ['Cmd', 'User'])
  assert.equal(kvmCmd.Cmd[0], '/usr/local/bin/kin-guest-exec')
  assert.equal(kvmCmd.Cmd[kvmCmd.Cmd.indexOf('-u') + 1], '10001:987')
  assert.equal(kvmCmd.Cmd[kvmCmd.Cmd.indexOf('-w') + 1], '/home/kincli')
  const kvmEnvPairs = kvmCmd.Cmd.flatMap((arg, i) => (arg === '-e' ? [kvmCmd.Cmd[i + 1]] : []))
  assert.deepEqual(kvmEnvPairs, execOpts.env)
  assert.ok(kvmCmd.Cmd.includes('-i'))
  assert.ok(kvmCmd.Cmd.includes('-t'))
  assert.deepEqual(kvmCmd.Cmd.slice(kvmCmd.Cmd.indexOf('--') + 1), innerCmd)
})

test('Docker vs KVM resolveAuthLoginClaude & panelShellLaunch parity across legacy and custom-os modes', (t) => {
  const dockerVm = { id: 'vm-doc-01', runtime: { type: 'docker' }, dataplane: 'crag', crag_kernel_version: 'v2' }
  const kvmVm = { id: 'vm-kvm-01', runtime: { type: 'kvm' }, dataplane: 'crag', crag_kernel_version: 'v2' }
  const remoteVm = { id: 'vm-rem-01', node_id: 'node-a', runtime: { type: 'docker' }, dataplane: 'crag' }

  // Legacy default remains byte-for-byte identical for both Docker and KVM.
  assert.equal(resolveAuthLoginClaude(dockerVm, { runtimeMode: CUSTOM_OS_RUNTIME_MODE_LEGACY }), LOCAL_CRAG_CLAUDE)
  assert.equal(resolveAuthLoginClaude(kvmVm, { runtimeMode: CUSTOM_OS_RUNTIME_MODE_LEGACY }), LOCAL_CRAG_CLAUDE)
  assert.equal(resolveAuthLoginClaude(remoteVm, { runtimeMode: CUSTOM_OS_RUNTIME_MODE_CUSTOM }), REMOTE_CRAG_CLAUDE)

  // Custom-OS mode resolves both Docker and KVM to SSOT /opt/kin/store/claude/current (file symlink).
  const docBin = resolveAuthLoginClaude(dockerVm, { runtimeMode: CUSTOM_OS_RUNTIME_MODE_CUSTOM })
  const kvmBin = resolveAuthLoginClaude(kvmVm, { runtimeMode: CUSTOM_OS_RUNTIME_MODE_CUSTOM })
  assert.equal(docBin, CUSTOM_OS_CLAUDE_CURRENT)
  assert.equal(kvmBin, CUSTOM_OS_CLAUDE_CURRENT)
  assert.equal(CUSTOM_OS_CLAUDE_CURRENT, '/opt/kin/store/claude/current')
  assert.equal(terminalClaudeBin, resolveAuthLoginClaude)

  // Per-slot opt-in flag also activates shared store identically on Docker and KVM.
  assert.equal(
    resolveAuthLoginClaude({ id: 'vm-d', runtime: { type: 'docker', custom_os: true } }),
    CUSTOM_OS_CLAUDE_CURRENT,
  )
  assert.equal(
    resolveAuthLoginClaude({ id: 'vm-k', runtime: { type: 'kvm', custom_os: true } }),
    CUSTOM_OS_CLAUDE_CURRENT,
  )

  // panelShellLaunch produces byte-for-byte identical cmd & rc for Docker and KVM.
  const docShell = panelShellLaunch(docBin)
  const kvmShell = panelShellLaunch(kvmBin)
  assert.deepEqual(docShell, kvmShell)
  assert.ok(docShell.rc.includes(`if [ -x '${CUSTOM_OS_CLAUDE_CURRENT}' ]`))
  assert.ok(docShell.rc.includes('cc() { claude "$@"; }'))
  assert.ok(docShell.rc.includes('usage() { claude /usage "$@"; }'))

  if (process.platform !== 'win32') {
    // Verify shell function executes a file symlink (same shape as /opt/kin/store/claude/current) and ignores PATH decoys.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-shell-'))
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
    const verDir = path.join(tmp, 'versions', '2.1.321')
    const decoyDir = path.join(tmp, 'decoy')
    fs.mkdirSync(verDir, { recursive: true })
    fs.mkdirSync(decoyDir, { recursive: true })
    fs.writeFileSync(path.join(verDir, 'claude'), '#!/bin/sh\necho "store-claude:$*"\n', { mode: 0o555 })
    fs.writeFileSync(path.join(decoyDir, 'claude'), '#!/bin/sh\necho DECOY\n', { mode: 0o755 })
    const currentSymlink = path.join(tmp, 'current')
    fs.symlinkSync('versions/2.1.321/claude', currentSymlink)
    const { rc } = panelShellLaunch(currentSymlink)
    const rcPath = path.join(tmp, 'rc')
    fs.writeFileSync(rcPath, `${rc}\n`)
    const ran = spawnSync('bash', ['--rcfile', rcPath, '-ic', 'claude --version; cc --help; usage'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: tmp, PATH: `${decoyDir}:${process.env.PATH}`, KIN_PANEL_RCFILE: rcPath },
    })
    assert.equal(ran.status, 0, ran.stderr)
    assert.match(ran.stdout, /store-claude:--version/)
    assert.match(ran.stdout, /store-claude:--help/)
    assert.match(ran.stdout, /store-claude:\/usage/)
    assert.doesNotMatch(ran.stdout, /DECOY/)
  }
})

unixTest(
  'custom-os stageBundledAuthClaude & assertAuthLoginReady share RO store with zero per-slot copy on Docker and KVM',
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-auth-store-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))

    const { storeRoot } = seedSharedStoreAndUnbundledCrag(root, {
      arch: 'amd64',
      version: '2.1.321',
      claudeMode: 0o555,
    })

    for (const type of ['docker', 'kvm']) {
      const vm = { id: `vm-${type}-01`, runtime: { type }, dataplane: 'crag', crag_kernel_version: 'v2' }
      const probed = []
      const bin = await assertAuthLoginReady(root, vm, {
        runtimeMode: CUSTOM_OS_RUNTIME_MODE_CUSTOM,
        sharedStoreHostDir: storeRoot,
        inspect: () => ({ running: true }),
        cliExists: async (candidate) => {
          probed.push(candidate)
          return true
        },
      })

      assert.equal(bin, CUSTOM_OS_CLAUDE_CURRENT)
      assert.deepEqual(probed, [CUSTOM_OS_CLAUDE_CURRENT])
      // Strictly zero 356 MiB per-slot copy into vms/<id>/cli-home/.kin/crag-v2.
      const perSlotCragDir = path.join(root, 'vms', vm.id, 'cli-home', '.kin', 'crag-v2')
      assert.equal(fs.existsSync(perSlotCragDir), false, `${type} slot must never copy Claude into .kin/crag-v2`)
    }
  },
)

unixTest(
  'custom-os stageBundledAuthClaude fails closed on missing, escaping, writable, wrong-arch, or tampered shared store',
  (t) => {
    const baseVm = { id: 'vm-neg-01', runtime: { type: 'kvm' }, dataplane: 'crag' }

    // 1. Missing current symlink
    {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-neg-missing-'))
      t.after(() => fs.rmSync(root, { recursive: true, force: true }))
      fs.mkdirSync(path.join(root, 'store', 'claude', 'versions'), { recursive: true })
      assert.throws(
        () => stageBundledAuthClaude(root, baseVm, { runtimeMode: CUSTOM_OS_RUNTIME_MODE_CUSTOM }),
        (err) => err.code === 'shared_store_claude_missing',
      )
    }

    // 2. Absolute / escaping current symlink target
    {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-neg-escape-'))
      t.after(() => fs.rmSync(root, { recursive: true, force: true }))
      fs.mkdirSync(path.join(root, 'store', 'claude', 'versions'), { recursive: true })
      fs.symlinkSync('/etc/passwd', path.join(root, 'store', 'claude', 'current'))
      assert.throws(
        () => stageBundledAuthClaude(root, baseVm, { runtimeMode: CUSTOM_OS_RUNTIME_MODE_CUSTOM }),
        (err) => err.code === 'shared_store_current_invalid',
      )
    }

    // 3. Writable (0755) store binary rejected
    {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-neg-writable-'))
      t.after(() => fs.rmSync(root, { recursive: true, force: true }))
      seedSharedStoreAndUnbundledCrag(root, { arch: 'amd64', claudeMode: 0o755, includeCragPackage: false })
      assert.throws(
        () => stageBundledAuthClaude(root, baseVm, { runtimeMode: CUSTOM_OS_RUNTIME_MODE_CUSTOM }),
        (err) => err.code === 'shared_store_writable_rejected',
      )
    }

    // 4. Wrong ELF arch (arm64 binary for amd64 slot)
    {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-neg-arch-'))
      t.after(() => fs.rmSync(root, { recursive: true, force: true }))
      seedSharedStoreAndUnbundledCrag(root, { arch: 'arm64', claudeMode: 0o555, includeCragPackage: false })
      assert.throws(
        () => stageBundledAuthClaude(root, baseVm, { runtimeMode: CUSTOM_OS_RUNTIME_MODE_CUSTOM }),
        (err) => err.code === 'shared_store_arch_mismatch',
      )
    }

    // 5. Tampered shared store binary against signed unbundled CRAG v2 manifest
    {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-neg-tamper-'))
      t.after(() => fs.rmSync(root, { recursive: true, force: true }))
      seedSharedStoreAndUnbundledCrag(root, {
        arch: 'amd64',
        claudeMode: 0o555,
        includeCragPackage: true,
        tamperStoreBytes: true,
      })
      assert.throws(
        () => stageBundledAuthClaude(root, baseVm, { runtimeMode: CUSTOM_OS_RUNTIME_MODE_CUSTOM }),
        (err) => err.code === 'crag_v2_hash_mismatch',
      )
    }
  },
)

unixTest('writeKernelConfig Docker vs KVM parity in custom-os mode with strict divergence boundary', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-kcfg-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const { pkgDir } = seedSharedStoreAndUnbundledCrag(root, { arch: 'amd64', version: '2.1.321', claudeMode: 0o555 })
  const prevCragRoot = process.env.KIN_CRAG_V2_ROOT
  process.env.KIN_CRAG_V2_ROOT = pkgDir
  t.after(() => {
    if (prevCragRoot === undefined) delete process.env.KIN_CRAG_V2_ROOT
    else process.env.KIN_CRAG_V2_ROOT = prevCragRoot
  })

  const routing = { inference: { dataplane: 'crag', crag_kernel_version: 'v2' } }
  const dockerVm = { id: 'vm-par-doc', runtime: { type: 'docker' }, dataplane: 'crag', crag_kernel_version: 'v2' }
  const kvmVm = {
    id: 'vm-par-kvm',
    runtime: { type: 'kvm', accel: 'kvm' },
    dataplane: 'crag',
    crag_kernel_version: 'v2',
  }

  const docRes = writeKernelConfig(root, dockerVm, {
    token: 'parity-tok',
    routing,
    runtimeMode: CUSTOM_OS_RUNTIME_MODE_CUSTOM,
    vsockEnabled: true,
  })
  const kvmRes = writeKernelConfig(root, kvmVm, {
    token: 'parity-tok',
    routing,
    runtimeMode: CUSTOM_OS_RUNTIME_MODE_CUSTOM,
    kvmMode: KVM_MODE_CUSTOM_EROFS,
    vsockEnabled: true,
  })
  const kvmTcgRes = writeKernelConfig(
    root,
    { ...kvmVm, id: 'vm-par-tcg', runtime: { type: 'kvm', accel: 'tcg' } },
    {
      token: 'parity-tok',
      routing,
      runtimeMode: CUSTOM_OS_RUNTIME_MODE_CUSTOM,
      kvmMode: KVM_MODE_CUSTOM_EROFS,
      existsSync: () => true,
    },
  )

  const docCfg = JSON.parse(fs.readFileSync(docRes.configPath, 'utf8'))
  const kvmCfg = JSON.parse(fs.readFileSync(kvmRes.configPath, 'utf8'))
  const tcgCfg = JSON.parse(fs.readFileSync(kvmTcgRes.configPath, 'utf8'))

  // Core shared fields MUST be identical across Docker and KVM.
  for (const field of [
    'credential_path',
    'license_dir',
    'asset_dir',
    'work_dir',
    'dataplane',
    'crag_kernel_version',
    'runtime_variant',
    'claude_bin',
    'wire_profile_readonly_dir',
    'bridge_socket_dir',
  ]) {
    assert.equal(docCfg[field], kvmCfg[field], `field ${field} must match between Docker and KVM`)
    assert.equal(tcgCfg[field], kvmCfg[field], `field ${field} must match between KVM accel=kvm and accel=tcg`)
  }
  assert.equal(docCfg.claude_bin, '/opt/kin/store/claude/versions/2.1.321/claude')
  assert.equal(docCfg.wire_profile_readonly_dir, CUSTOM_OS_PROFILES_DIR)
  assert.equal(docCfg.bridge_socket_dir, CUSTOM_OS_BRIDGE_TMPFS_DIR)
  assert.equal(docCfg.license_dir, '/run/kin/crag-license')

  // Strictly assert ONLY the allowed platform divergences.
  assert.equal(docCfg.runtime_kind, 'docker')
  assert.equal(kvmCfg.runtime_kind, 'kvm')
  assert.equal(docCfg.socket_path, '/run/kin/kernel.sock')
  assert.equal(kvmCfg.socket_path, '/run/kin-guest/kernel.sock')
  assert.equal(docCfg.disable_dumpable, undefined)
  assert.equal(kvmCfg.disable_dumpable, true)
  assert.equal(tcgCfg.disable_dumpable, true)
  assert.equal(docCfg.listen_vsock_port, undefined)
  assert.equal(kvmCfg.listen_vsock_port, DEFAULT_KVM_VSOCK_PORT)
  assert.equal(tcgCfg.listen_vsock_port, undefined)
})

test('Docker vs KVM managed-settings SSOT path & Self-Probe-safe baseline parity', (t) => {
  assert.equal(CUSTOM_OS_MANAGED_SETTINGS_D, '/etc/claude-code/managed-settings.d')
  const bakedPath = path.join(REPO_ROOT, 'docker', 'kin-os', 'debian-13', 'managed-settings.json')
  const raw = fs.readFileSync(bakedPath, 'utf8')
  const parsed = JSON.parse(raw)
  assert.equal(parsed.autoUpdates, false)
  assert.deepEqual(verifyManagedSettingsContent(raw), [])
  for (const forbidden of FORBIDDEN_MANAGED_ENV_KEYS) {
    assert.equal(Object.hasOwn(parsed.env || {}, forbidden), false)
  }

  // Per-slot managed-settings projection helper resolves identically for Docker and KVM slot dirs.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-managed-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const vm of [
    { id: 'vm-doc-ms', runtime: { type: 'docker' } },
    { id: 'vm-kvm-ms', runtime: { type: 'kvm' } },
  ]) {
    const msDir = path.join(
      root,
      'vms',
      vm.id,
      'kvm',
      'fingerprint',
      'system',
      'etc',
      'claude-code',
      'managed-settings.d',
    )
    fs.mkdirSync(msDir, { recursive: true })
    fs.writeFileSync(path.join(msDir, '10-slot.json'), JSON.stringify({ env: { DISABLE_TELEMETRY: '1' } }))
    assert.equal(hasLocalManagedSettings(root, vm), true)
    assert.deepEqual(
      localManagedSettingsFiles(root, vm).map((f) => f.rel),
      ['etc/claude-code/managed-settings.d/10-slot.json'],
    )
  }
})
