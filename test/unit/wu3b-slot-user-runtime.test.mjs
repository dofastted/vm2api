import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { slotHost } from '../../src/lib/vm/slot-host.mjs'
import { panelShellLaunch } from '../../src/lib/vm/slot-shell.mjs'
import {
  cragClaudePathForHost,
  resolveSlotClaude,
  slotCcNodeBin,
  slotCliNodeBin,
  slotLocalCragClaude,
} from '../../src/lib/vm/slot-engine.mjs'
import {
  buildKvmRunArgs,
  computerDockerArgs,
  DOCKER_HOME_TMPFS_OPTS,
  dockerImageHasRegularEtcTargets,
  dockerSlotUserArgs,
  REGULAR_ETC_TARGETS_LABEL,
  slotContainerCommand,
  verifyLocalKvmKernelTrack,
} from '../../src/lib/vm/vm-runtime.mjs'
import { NODE_CLAUDE_SETUP_PY, writeKernelConfig } from '../../src/lib/transport/rust-kernel-supervisor.mjs'
import { resolveAuthLoginClaude } from '../../src/lib/oauth/claude-auth-login.mjs'
import { buildClaudeSetupTokenLaunch } from '../../src/lib/oauth/claude-setup-token.mjs'
import { buildOfficialCcDockerArgs, buildOfficialCcResidentLaunch } from '../../src/lib/oauth/official-cc-bootstrap.mjs'
import {
  clusterRegularEtcBinds,
  clusterRuntimeEtcBinds,
  localComputerFiles,
  localRegularEtcNames,
  pushClusterComputer,
} from '../../src/lib/cluster/slot-computer-files.mjs'
import { slotContainerBody } from '../../src/lib/cluster/remote-slot.mjs'
import { verifyNodeRuntimes } from '../../src/lib/cluster/node-edit.mjs'
import { READ_IDENTITY } from '../../src/lib/vm/guest-identity-reader.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const GUEST_EXEC = path.join(REPO_ROOT, 'docker', 'kin-kvm', 'kin-guest-exec')
const GUEST_INIT = path.join(REPO_ROOT, 'docker', 'kin-kvm', 'guest', 'kin-guest-init')
const SLOT_AGENT = path.join(REPO_ROOT, 'docker', 'kin-kvm', 'guest', 'kin-slot-agent')
const OS_DOCKERFILE = path.join(REPO_ROOT, 'docker', 'kin-os', 'debian-13', 'Dockerfile')
const BUILD_OS_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-custom-debian13-os.sh')
const SETUP_TOKEN_PTY = path.join(REPO_ROOT, 'scripts', 'claude-setup-token-pty.py')
const RESIDENT_PTY = path.join(REPO_ROOT, 'scripts', 'official-cc-resident.py')

const unixTest = process.platform === 'win32' ? test.skip : test

test('slotHost fixes custom-erofs execUser (1000:1000 new / 999:987 legacy) and parameterizes local bins', () => {
  const customKvmNew = {
    id: 'vm-1',
    kernel: 'crag-debian13',
    runtime_type: 'kvm',
    fingerprint: { username: 'mchen', guest_uid: 1000, guest_gid: 1000 },
  }
  assert.equal(slotHost(customKvmNew).execUser(customKvmNew), '1000:1000')
  assert.equal(slotHost(customKvmNew).bins.cli, '/home/mchen/.kin/cli-node')
  assert.equal(slotHost(customKvmNew).bins.cc, '/home/mchen/.kin/cc-node')

  const customKvmLegacy = {
    id: 'vm-2',
    kernel: 'crag-debian13',
    runtime_type: 'kvm',
    fingerprint: {},
  }
  assert.equal(slotHost(customKvmLegacy).execUser(customKvmLegacy), '999:987')
  assert.equal(slotHost(customKvmLegacy).bins.cli, '/home/kincli/.kin/cli-node')

  const legacyKvm = {
    id: 'vm-3',
    kernel: 'ubuntu-24.04',
    runtime_type: 'kvm',
    fingerprint: {},
  }
  assert.equal(slotHost(legacyKvm).execUser(legacyKvm), '10003:987')

  const localDockerNew = {
    id: 'vm-4',
    kernel: 'crag-debian13',
    runtime_type: 'docker',
    fingerprint: { username: 'dwalsh' },
  }
  assert.equal(slotHost(localDockerNew).execUser(localDockerNew), '10004:987')
  assert.equal(slotHost(localDockerNew).bins.cli, '/home/dwalsh/.kin/cli-node')
  assert.equal(slotHost(localDockerNew).bins.cc, '/home/dwalsh/.kin/cc-node')
})

test('slot-engine, claude-auth-login, slot-shell, and official-cc-bootstrap honor random username with legacy fallback', () => {
  const customVm = { id: 'vm-10', kernel: 'debian-12', fingerprint: { username: 'mchen' } }
  const legacyVm = { id: 'vm-11', kernel: 'debian-12' }

  assert.equal(slotCliNodeBin(customVm), '/home/mchen/.kin/cli-node')
  assert.equal(slotCcNodeBin(customVm), '/home/mchen/.kin/cc-node')
  assert.match(slotLocalCragClaude(customVm), /^\/home\/mchen\/\.kin\/crag-v2\/claude-code-/)
  assert.equal(
    cragClaudePathForHost('claude-code-2.1.321/claude', { bakedKernel: false }, customVm),
    '/home/mchen/.kin/crag-v2/claude-code-2.1.321/claude',
  )
  assert.equal(
    cragClaudePathForHost('claude-code-2.1.321/claude', { bakedKernel: true }, customVm),
    '/opt/kin-live/crag-v2/claude-code-2.1.321/claude',
  )
  assert.equal(
    cragClaudePathForHost('claude-code-2.1.321/claude', { bakedKernel: false }, legacyVm),
    '/home/kincli/.kin/crag-v2/claude-code-2.1.321/claude',
  )
  assert.equal(resolveSlotClaude({ ...customVm, dataplane: 'wrap' }, {}, {}).bin, '/home/mchen/.kin/cli-node')
  assert.equal(resolveAuthLoginClaude(customVm), slotLocalCragClaude(customVm))
  assert.equal(resolveAuthLoginClaude({ ...customVm, kernel: 'crag-debian13' }), '/opt/kin/store/claude/current')

  const customLaunch = panelShellLaunch('/opt/kin/store/claude/current', { homeDir: '/home/mchen' })
  assert.match(customLaunch.rc, /HOME="\$\{HOME:-\/home\/mchen\}"/)
  assert.doesNotMatch(customLaunch.rc, /\/home\/kincli/)

  const defaultLaunch = panelShellLaunch('/opt/kin/store/claude/current')
  assert.match(defaultLaunch.rc, /HOME="\$\{HOME:-\/home\/kincli\}"/)

  const ccArgs = buildOfficialCcDockerArgs({
    vmId: 'vm-10',
    uid: 10010,
    gid: 987,
    vm: customVm,
  })
  assert.ok(ccArgs.includes('HOME=/home/mchen'))
  assert.ok(ccArgs.includes('USER=mchen'))
  assert.ok(ccArgs.includes('LOGNAME=mchen'))
  assert.ok(ccArgs.includes('/home/mchen'))
  assert.ok(ccArgs.some((a) => a.startsWith('/home/mchen/.kin/crag-v2/')))
})

test('vm-runtime Docker user mounts, label-gated /etc overrides, slotContainerCommand, and buildKvmRunArgs', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wu3b-vm-runtime-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const customVm = {
    id: 'vm-20',
    kernel: 'crag-debian13',
    runtime_type: 'docker',
    fingerprint: { username: 'mchen' },
  }
  const legacyVm = {
    id: 'vm-21',
    kernel: 'crag-debian13',
    runtime_type: 'docker',
  }

  assert.ok(slotContainerCommand(customVm, { wrapKernel: true }).includes('/home/mchen/.kin/kin-kernel'))
  assert.ok(slotContainerCommand(legacyVm, { wrapKernel: true }).includes('/home/kincli/.kin/kin-kernel'))

  // regularEtcTargets capability label gating
  assert.equal(
    dockerImageHasRegularEtcTargets('kin-os-debian:13-baked', {
      run: () => ({ ok: true, stdout: '1\n' }),
    }),
    true,
  )
  assert.equal(
    dockerImageHasRegularEtcTargets('kin-os-debian:12', {
      run: () => ({ ok: true, stdout: '\n' }),
    }),
    false,
  )

  const compDir = path.join(root, 'comp')
  const etcDir = path.join(compDir, 'system', 'etc')
  fs.mkdirSync(etcDir, { recursive: true })
  fs.writeFileSync(path.join(etcDir, 'hostname'), 'thinkpad-ab12\n')
  fs.writeFileSync(path.join(etcDir, 'kin-computer'), 'source=linux-pc\n')
  fs.writeFileSync(path.join(etcDir, 'os-release'), 'ID=ubuntu\nVERSION_ID="24.04"\n')
  fs.writeFileSync(path.join(etcDir, 'localtime'), Buffer.from('TZif2' + '\0'.repeat(48)))
  fs.writeFileSync(path.join(etcDir, 'timezone'), 'America/New_York\n')

  const legacyArgs = computerDockerArgs({ dir: compDir, mac: '02:00:00:00:00:01', regularEtcTargets: false })
  assert.equal(
    legacyArgs.some((a) => a.includes(':/etc/os-release:ro')),
    false,
  )
  assert.equal(
    legacyArgs.some((a) => a.includes(':/etc/localtime:ro')),
    false,
  )
  assert.equal(
    legacyArgs.some((a) => a.includes(':/etc/timezone:ro')),
    false,
  )

  const gatedArgs = computerDockerArgs({ dir: compDir, mac: '02:00:00:00:00:01', regularEtcTargets: true })
  assert.ok(gatedArgs.some((a) => a.endsWith(':/etc/os-release:ro')))
  assert.ok(gatedArgs.some((a) => a.endsWith(':/etc/localtime:ro')))
  assert.ok(gatedArgs.some((a) => a.endsWith(':/etc/timezone:ro')))

  // dockerSlotUserArgs: custom user vs legacy kincli
  let calledWith = null
  const customUserRes = dockerSlotUserArgs({
    vm: customVm,
    home: '/data/vms/vm-20/cli-home',
    projectRoot: root,
    uid: 10020,
    gid: 987,
    ensurePasswdFiles: (proj, vm, ids) => {
      calledWith = { proj, id: vm.id, ids }
    },
    runtimeEtcDirOf: (proj, id) => path.join(proj, 'vms', id, 'kvm', 'fingerprint', 'runtime-etc'),
  })
  assert.deepEqual(calledWith, { proj: root, id: 'vm-20', ids: { uid: 10020, gid: 987 } })
  assert.ok(customUserRes.mountArgs.includes(`/home:${DOCKER_HOME_TMPFS_OPTS}`))
  assert.ok(customUserRes.mountArgs.includes('/data/vms/vm-20/cli-home:/home/mchen'))
  assert.ok(customUserRes.mountArgs.some((a) => a.endsWith('runtime-etc/passwd:/etc/passwd:ro')))
  assert.ok(customUserRes.mountArgs.some((a) => a.endsWith('runtime-etc/group:/etc/group:ro')))
  assert.ok(customUserRes.envArgs.includes('HOME=/home/mchen'))
  assert.ok(customUserRes.envArgs.includes('USER=mchen'))
  assert.ok(customUserRes.envArgs.includes('LOGNAME=mchen'))
  assert.ok(customUserRes.envArgs.includes('CLAUDE_CONFIG_DIR=/home/mchen/.claude'))

  const legacyUserRes = dockerSlotUserArgs({
    vm: legacyVm,
    home: '/data/vms/vm-21/cli-home',
    projectRoot: root,
    uid: 10021,
    gid: 987,
    ensurePasswdFiles: () => {
      throw new Error('legacy kincli slot must not generate runtime-etc passwd')
    },
  })
  assert.deepEqual(legacyUserRes.mountArgs, ['-v', '/data/vms/vm-21/cli-home:/home/kincli'])
  assert.equal(legacyUserRes.userHome, '/home/kincli')

  // buildKvmRunArgs passes KIN_SLOT_{USER,UID,GID} and KIN_KVM_KERNEL_TRACK for custom-erofs
  const kvmDir = path.join(root, 'vms', 'vm-30', 'kvm')
  fs.mkdirSync(kvmDir, { recursive: true })
  const kvmNewArgs = buildKvmRunArgs({
    vm: {
      id: 'vm-30',
      kernel: 'crag-debian13',
      runtime_type: 'kvm',
      timezone: 'America/New_York',
      locale: 'en_US.UTF-8',
      fingerprint: {
        hostname: 'thinkpad-1122',
        guest_machine_id: '0123456789abcdef0123456789abcdef',
        username: 'mchen',
        guest_uid: 1000,
        guest_gid: 1000,
      },
    },
    name: 'kin-vm-30',
    image: 'kin-kvm-debian:13',
    hostName: 'thinkpad-1122',
    network: 'kin-eg-1',
    memory: '1536m',
    accel: 'kvm',
    uid: 10030,
    gid: 987,
    home: path.join(root, 'vms', 'vm-30', 'cli-home'),
    runDir: path.join(root, 'vms', 'vm-30', 'run'),
    kvmDir,
    projectRoot: root,
    vhostVsockAvailable: false,
  })
  assert.ok(kvmNewArgs.includes('KIN_SLOT_USER=mchen'))
  assert.ok(kvmNewArgs.includes('KIN_SLOT_UID=1000'))
  assert.ok(kvmNewArgs.includes('KIN_SLOT_GID=1000'))
  assert.ok(kvmNewArgs.includes('KIN_KVM_KERNEL_TRACK=official'))

  const kvmLegacyArgs = buildKvmRunArgs({
    vm: {
      id: 'vm-31',
      kernel: 'crag-debian13',
      runtime_type: 'kvm',
      timezone: 'UTC',
      locale: 'en_US.UTF-8',
      fingerprint: {
        hostname: 'thinkpad-3344',
        guest_machine_id: 'fedcba9876543210fedcba9876543210',
      },
    },
    name: 'kin-vm-31',
    image: 'kin-kvm-debian:13',
    hostName: 'thinkpad-3344',
    network: 'kin-eg-1',
    memory: '1536m',
    accel: 'kvm',
    uid: 10031,
    gid: 987,
    home: path.join(root, 'vms', 'vm-31', 'cli-home'),
    runDir: path.join(root, 'vms', 'vm-31', 'run'),
    kvmDir,
    projectRoot: root,
    vhostVsockAvailable: false,
  })
  assert.ok(kvmLegacyArgs.includes('KIN_SLOT_USER=kincli'))
  assert.ok(kvmLegacyArgs.includes('KIN_SLOT_UID=999'))
  assert.ok(kvmLegacyArgs.includes('KIN_SLOT_GID=987'))

  // Custom kernel track passes vmlinuz-custom / initrd.img-custom without silent official override
  const osAssetsDir = path.join(root, 'os-assets')
  fs.mkdirSync(osAssetsDir, { recursive: true })
  fs.writeFileSync(path.join(osAssetsDir, 'kin-kvm-debian-13.erofs'), 'erofs-bytes')
  fs.writeFileSync(path.join(osAssetsDir, 'vmlinuz'), 'official-vmlinuz')
  fs.writeFileSync(path.join(osAssetsDir, 'initrd.img'), 'official-initrd')

  const customTrackVm = {
    id: 'vm-32',
    kernel: 'crag-debian13',
    runtime_type: 'kvm',
    runtime: { type: 'kvm', kernel_track: 'custom' },
    timezone: 'UTC',
    locale: 'en_US.UTF-8',
    fingerprint: {
      hostname: 'thinkpad-5566',
      guest_machine_id: '00112233445566778899aabbccddeeff',
      username: 'mchen',
      guest_uid: 1000,
      guest_gid: 1000,
    },
  }

  // Fail closed when custom track artifacts are missing (even though official vmlinuz/initrd.img exist)
  const missingCustom = verifyLocalKvmKernelTrack(root, customTrackVm, { osAssetsHostDir: osAssetsDir })
  assert.equal(missingCustom.ok, false)
  assert.equal(missingCustom.code, 'kvm_custom_kernel_missing')

  // Fail closed when vmlinuz-custom is a symlink
  fs.symlinkSync('vmlinuz', path.join(osAssetsDir, 'vmlinuz-custom'))
  fs.writeFileSync(path.join(osAssetsDir, 'initrd.img-custom'), 'custom-initrd')
  const symlinkCustom = verifyLocalKvmKernelTrack(root, customTrackVm, { osAssetsHostDir: osAssetsDir })
  assert.equal(symlinkCustom.ok, false)
  assert.equal(symlinkCustom.code, 'kvm_custom_kernel_invalid')

  // Valid regular custom kernel + initrd pass fail-closed verification and flow into buildKvmRunArgs
  fs.unlinkSync(path.join(osAssetsDir, 'vmlinuz-custom'))
  fs.writeFileSync(path.join(osAssetsDir, 'vmlinuz-custom'), 'custom-vmlinuz')
  const okCustom = verifyLocalKvmKernelTrack(root, customTrackVm, { osAssetsHostDir: osAssetsDir })
  assert.equal(okCustom.ok, true)
  assert.equal(okCustom.track, 'custom')

  // Top-level vm.kernel_track='custom' also resolves through WU-3C resolveKvmKernelTrack
  const topLevelTrackOk = verifyLocalKvmKernelTrack(
    root,
    { id: 'vm-34', kernel: 'crag-debian13', runtime_type: 'kvm', kernel_track: 'custom' },
    { osAssetsHostDir: osAssetsDir },
  )
  assert.equal(topLevelTrackOk.ok, true)
  assert.equal(topLevelTrackOk.track, 'custom')

  const kvmCustomTrackArgs = buildKvmRunArgs({
    vm: customTrackVm,
    name: 'kin-vm-32',
    image: 'kin-kvm-debian:13',
    hostName: 'thinkpad-5566',
    network: 'kin-eg-1',
    memory: '1536m',
    accel: 'kvm',
    uid: 10032,
    gid: 987,
    home: path.join(root, 'vms', 'vm-32', 'cli-home'),
    runDir: path.join(root, 'vms', 'vm-32', 'run'),
    kvmDir,
    projectRoot: root,
    osAssetsHostDir: osAssetsDir,
    vhostVsockAvailable: false,
  })
  assert.ok(kvmCustomTrackArgs.includes('KIN_KVM_KERNEL_TRACK=custom'))
  assert.ok(kvmCustomTrackArgs.includes('KIN_KVM_KERNEL=/opt/kin-os/crag-debian13/vmlinuz-custom'))
  assert.ok(kvmCustomTrackArgs.includes('KIN_KVM_INITRD=/opt/kin-os/crag-debian13/initrd.img-custom'))
  assert.equal(kvmCustomTrackArgs.includes('KIN_KVM_KERNEL=/opt/kin-os/crag-debian13/vmlinuz'), false)
  assert.equal(kvmCustomTrackArgs.includes('KIN_KVM_INITRD=/opt/kin-os/crag-debian13/initrd.img'), false)

  // Official track still passes vmlinuz + initrd.img
  const officialTrackArgs = buildKvmRunArgs({
    vm: { ...customTrackVm, id: 'vm-33', runtime: { type: 'kvm', kernel_track: 'official' } },
    name: 'kin-vm-33',
    image: 'kin-kvm-debian:13',
    hostName: 'thinkpad-5566',
    network: 'kin-eg-1',
    memory: '1536m',
    accel: 'kvm',
    uid: 10033,
    gid: 987,
    home: path.join(root, 'vms', 'vm-33', 'cli-home'),
    runDir: path.join(root, 'vms', 'vm-33', 'run'),
    kvmDir,
    projectRoot: root,
    osAssetsHostDir: osAssetsDir,
    vhostVsockAvailable: false,
  })
  assert.ok(officialTrackArgs.includes('KIN_KVM_KERNEL_TRACK=official'))
  assert.ok(officialTrackArgs.includes('KIN_KVM_KERNEL=/opt/kin-os/crag-debian13/vmlinuz'))
  assert.ok(officialTrackArgs.includes('KIN_KVM_INITRD=/opt/kin-os/crag-debian13/initrd.img'))
})

test('official-cc-bootstrap and claude-setup-token align KVM custom-erofs guest UID while preserving Docker/legacy uid:gid', () => {
  const kvmCustomNew = {
    id: 'vm-10',
    kernel: 'crag-debian13',
    runtime_type: 'kvm',
    fingerprint: { username: 'mchen', guest_uid: 1000, guest_gid: 1000 },
  }
  const kvmCustomLegacy = {
    id: 'vm-11',
    kernel: 'crag-debian13',
    runtime_type: 'kvm',
    fingerprint: {},
  }
  const kvmLegacy = {
    id: 'vm-12',
    kernel: 'ubuntu-24.04',
    runtime_type: 'kvm',
    fingerprint: {},
  }
  const dockerCustom = {
    id: 'vm-13',
    kernel: 'crag-debian13',
    runtime_type: 'docker',
    fingerprint: { username: 'dwalsh' },
  }

  const readUserFlag = (argv) => {
    const idx = argv.indexOf('-u')
    assert.notEqual(idx, -1, `expected -u flag in ${JSON.stringify(argv)}`)
    return argv[idx + 1]
  }

  // buildOfficialCcDockerArgs
  assert.equal(
    readUserFlag(buildOfficialCcDockerArgs({ vmId: 'vm-10', uid: 10010, gid: 987, vm: kvmCustomNew })),
    '1000:1000',
  )
  assert.equal(
    readUserFlag(buildOfficialCcDockerArgs({ vmId: 'vm-11', uid: 10011, gid: 987, vm: kvmCustomLegacy })),
    '999:987',
  )
  assert.equal(
    readUserFlag(buildOfficialCcDockerArgs({ vmId: 'vm-12', uid: 10012, gid: 987, vm: kvmLegacy })),
    '10012:987',
  )
  assert.equal(
    readUserFlag(buildOfficialCcDockerArgs({ vmId: 'vm-13', uid: 10013, gid: 987, vm: dockerCustom })),
    '10013:987',
  )

  // buildOfficialCcResidentLaunch (startOfficialCcResidentProcess backing helper)
  const resKvmNew = buildOfficialCcResidentLaunch({ vmId: 'vm-10', uid: 10010, gid: 987, vm: kvmCustomNew })
  assert.equal(resKvmNew.execUser, '1000:1000')
  assert.equal(resKvmNew.execUid, '1000')
  assert.equal(resKvmNew.execGid, '1000')
  assert.equal(readUserFlag(resKvmNew.execArgv), '1000:1000')

  const resKvmLegacy = buildOfficialCcResidentLaunch({ vmId: 'vm-11', uid: 10011, gid: 987, vm: kvmCustomLegacy })
  assert.equal(resKvmLegacy.execUser, '999:987')
  assert.equal(resKvmLegacy.execUid, '999')
  assert.equal(resKvmLegacy.execGid, '987')
  assert.equal(readUserFlag(resKvmLegacy.execArgv), '999:987')

  const resDocker = buildOfficialCcResidentLaunch({ vmId: 'vm-13', uid: 10013, gid: 987, vm: dockerCustom })
  assert.equal(resDocker.execUser, '10013:987')
  assert.equal(resDocker.execUid, '10013')
  assert.equal(resDocker.execGid, '987')
  assert.equal(readUserFlag(resDocker.execArgv), '10013:987')

  // buildClaudeSetupTokenLaunch (startClaudeSetupTokenSession backing helper)
  const stKvmNew = buildClaudeSetupTokenLaunch(kvmCustomNew)
  assert.equal(stKvmNew.execUser, '1000:1000')
  assert.equal(stKvmNew.execUid, '1000')
  assert.equal(stKvmNew.execGid, '1000')
  assert.equal(readUserFlag(stKvmNew.execArgv), '1000:1000')

  const stKvmLegacy = buildClaudeSetupTokenLaunch(kvmCustomLegacy)
  assert.equal(stKvmLegacy.execUser, '999:987')
  assert.equal(stKvmLegacy.execUid, '999')
  assert.equal(stKvmLegacy.execGid, '987')
  assert.equal(readUserFlag(stKvmLegacy.execArgv), '999:987')

  const stDocker = buildClaudeSetupTokenLaunch(dockerCustom)
  assert.equal(stDocker.execUser, '10013:987')
  assert.equal(stDocker.execUid, '10013')
  assert.equal(stDocker.execGid, '987')
  assert.equal(readUserFlag(stDocker.execArgv), '10013:987')
})

test('rust-kernel-supervisor writes per-slot credential_path and NODE_CLAUDE_SETUP_PY reads HOME', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wu3b-kernel-cfg-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms', 'vm-40', 'cli-home', '.claude'), { recursive: true })
  const vm = {
    id: 'vm-40',
    kernel: 'crag-debian13',
    runtime_type: 'docker',
    dataplane: 'crag',
    fingerprint: { username: 'mchen' },
  }
  const written = writeKernelConfig(root, vm, { token: 'a'.repeat(64) })
  const cfg = JSON.parse(fs.readFileSync(written.configPath, 'utf8'))
  assert.equal(cfg.credential_path, '/home/mchen/.claude/credentials.json')
  assert.match(NODE_CLAUDE_SETUP_PY, /os\.environ\.get\("HOME"\)/)
})

test('cluster remote-slot, slot-computer-files, and node-edit handle custom username & dynamic remote UID', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wu3b-cluster-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const remoteDir = '/home/vpsuser/.vm2api/vms/vm-50'
  const vm = {
    id: 'vm-50',
    platform: 'anthropic',
    node_id: 'node-1',
    kernel: 'crag-debian13',
    timezone: 'America/New_York',
    locale: 'en_US.UTF-8',
    runtime: { type: 'docker' },
    fingerprint: { hostname: 'dell-ab12', username: 'mchen' },
  }

  // Stage local computer files including os-release/localtime/timezone
  const sys = path.join(root, 'vms', 'vm-50', 'kvm', 'fingerprint', 'system')
  fs.mkdirSync(path.join(sys, 'etc'), { recursive: true })
  fs.mkdirSync(path.join(sys, 'dmi', 'id'), { recursive: true })
  fs.mkdirSync(path.join(sys, 'hardware'), { recursive: true })
  fs.writeFileSync(path.join(sys, 'etc', 'kin-computer'), 'source=linux-pc\n')
  fs.writeFileSync(path.join(sys, 'etc', 'os-release'), 'ID=ubuntu\nVERSION_ID="24.04"\n')
  fs.writeFileSync(path.join(sys, 'etc', 'localtime'), Buffer.from('TZif2' + '\0'.repeat(48)))
  fs.writeFileSync(path.join(sys, 'etc', 'timezone'), 'America/New_York\n')
  fs.writeFileSync(path.join(sys, 'dmi', 'id', 'sys_vendor'), 'Dell Inc.\n')
  fs.writeFileSync(path.join(sys, 'hardware', 'mac'), '02:42:ac:11:00:50\n')

  assert.deepEqual(localRegularEtcNames(root, vm), ['os-release', 'localtime', 'timezone'])
  const localFiles = localComputerFiles(root, vm)
  assert.ok(localFiles.some((f) => f.rel === 'etc/os-release'))
  assert.ok(localFiles.some((f) => f.rel === 'etc/localtime'))
  assert.ok(localFiles.some((f) => f.rel === 'etc/timezone'))

  const body = slotContainerBody(vm, {
    image: 'kin-os-debian:13-baked',
    network: 'kin-eg-1',
    remoteDir,
    user: '1000:1000',
    routing: {},
    computer: true,
    runtimeEtc: true,
    regularEtcNames: ['os-release', 'localtime', 'timezone'],
  })
  assert.equal(body.WorkingDir, '/home/mchen')
  assert.ok(body.Env.includes('HOME=/home/mchen'))
  assert.ok(body.Env.includes('USER=mchen'))
  assert.ok(body.Env.includes('LOGNAME=mchen'))
  assert.equal(body.HostConfig.Tmpfs['/home'], DOCKER_HOME_TMPFS_OPTS)
  assert.ok(body.HostConfig.Binds.includes(`${remoteDir}/cli-home:/home/mchen`))
  assert.ok(body.HostConfig.Binds.includes(`${remoteDir}/claude:/home/mchen/.claude`))
  for (const bind of clusterRuntimeEtcBinds(remoteDir)) assert.ok(body.HostConfig.Binds.includes(bind), bind)
  for (const bind of clusterRegularEtcBinds(remoteDir, ['os-release', 'localtime', 'timezone'])) {
    assert.ok(body.HostConfig.Binds.includes(bind), bind)
  }

  // Legacy remote slot remains 100% unchanged
  const legacyBody = slotContainerBody(
    { ...vm, id: 'vm-51', fingerprint: { hostname: 'dell-cd34' } },
    {
      image: 'kin-os-debian:12',
      network: 'kin-eg-1',
      remoteDir: '/home/vpsuser/.vm2api/vms/vm-51',
      user: '1000:1000',
      routing: {},
      computer: true,
    },
  )
  assert.equal(legacyBody.WorkingDir, '/home/kincli')
  assert.equal(legacyBody.HostConfig.Tmpfs['/home'], undefined)
  assert.ok(legacyBody.HostConfig.Binds.includes('/home/vpsuser/.vm2api/vms/vm-51/cli-home:/home/kincli'))
  assert.equal(
    legacyBody.HostConfig.Binds.some((b) => b.includes('/etc/passwd')),
    false,
  )

  // Remote KVM custom-erofs locks KIN_KVM_KERNEL_TRACK=official and passes KIN_SLOT_{USER,UID,GID}
  const remoteKvmBody = slotContainerBody(
    {
      ...vm,
      id: 'vm-52',
      runtime: { type: 'kvm' },
      runtime_type: 'kvm',
      fingerprint: {
        hostname: 'dell-ef56',
        guest_machine_id: '0123456789abcdef0123456789abcdef',
        username: 'mchen',
        guest_uid: 1000,
        guest_gid: 1000,
      },
    },
    {
      image: 'kin-kvm-debian:13',
      network: 'kin-eg-1',
      remoteDir: '/home/vpsuser/.vm2api/vms/vm-52',
      user: '1000:1000',
      routing: {},
      accel: 'kvm',
    },
  )
  assert.ok(remoteKvmBody.Env.includes('KIN_SLOT_USER=mchen'))
  assert.ok(remoteKvmBody.Env.includes('KIN_SLOT_UID=1000'))
  assert.ok(remoteKvmBody.Env.includes('KIN_SLOT_GID=1000'))
  assert.ok(remoteKvmBody.Env.includes('KIN_KVM_KERNEL_TRACK=official'))
})

test('pushClusterComputer renders runtime-etc/{passwd,group} with remote node UID:GID and node-edit matches slotHome', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wu3b-cluster-push-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vm = {
    id: 'vm-55',
    node_id: 'node-1',
    kernel: 'crag-debian13',
    runtime: { type: 'docker', container_id: 'cid-55', container: 'kin-vm-55', user: '2001:2002' },
    fingerprint: { hostname: 'dell-xy99', username: 'mchen' },
  }
  const sys = path.join(root, 'vms', 'vm-55', 'kvm', 'fingerprint', 'system')
  fs.mkdirSync(path.join(sys, 'etc'), { recursive: true })
  fs.mkdirSync(path.join(sys, 'dmi', 'id'), { recursive: true })
  fs.mkdirSync(path.join(sys, 'hardware'), { recursive: true })
  fs.writeFileSync(path.join(sys, 'etc', 'kin-computer'), 'source=linux-pc\n')
  fs.writeFileSync(path.join(sys, 'dmi', 'id', 'sys_vendor'), 'Dell Inc.\n')
  fs.writeFileSync(path.join(sys, 'hardware', 'mac'), '02:42:ac:11:00:55\n')

  const writes = new Map()
  const fakeSftp = {
    once() {},
    open(file, _flags, attrsOrCb, maybeCb) {
      const cb = typeof attrsOrCb === 'function' ? attrsOrCb : maybeCb
      cb(null, file)
    },
    write(handle, buf, offset, length, _pos, cb) {
      const prev = writes.get(handle) || Buffer.alloc(0)
      writes.set(handle, Buffer.concat([prev, buf.subarray(offset, offset + length)]))
      cb(null)
    },
    chmod(_file, _mode, cb) {
      cb(null)
    },
    fchmod(_handle, _mode, cb) {
      cb(null)
    },
    fsetstat(_handle, _attrs, cb) {
      cb(null)
    },
    setstat(_file, _attrs, cb) {
      cb(null)
    },
    close(_handle, cb) {
      cb(null)
    },
    rename(from, to, cb) {
      writes.set(to, writes.get(from))
      writes.delete(from)
      cb(null)
    },
    ext_openssh_rename(from, to, cb) {
      writes.set(to, writes.get(from))
      writes.delete(from)
      cb(null)
    },
    unlink(_file, cb) {
      cb(null)
    },
    end() {},
  }
  const fakeClient = {
    exec(_cmd, cb) {
      const listeners = {}
      const stream = {
        on(ev, fn) {
          listeners[ev] = fn
          if (ev === 'close') {
            setImmediate(() => {
              listeners.exit?.(0)
              fn(0)
            })
          }
          return stream
        },
        stderr: {
          on() {
            return this
          },
        },
      }
      cb(null, stream)
    },
    sftp(cb) {
      cb(null, fakeSftp)
    },
  }

  const pushed = await pushClusterComputer(
    root,
    vm,
    { client: fakeClient, host: { uid: 2001, gid: 2002 } },
    {
      remoteDir: '/home/vpsuser/.vm2api/vms/vm-55',
      containerUser: '2001:2002',
    },
  )
  assert.equal(pushed, true)
  const passwdKey = [...writes.keys()].find((k) => k.endsWith('/computer/runtime-etc/passwd'))
  const groupKey = [...writes.keys()].find((k) => k.endsWith('/computer/runtime-etc/group'))
  assert.ok(passwdKey, 'must push remote runtime-etc/passwd')
  assert.ok(groupKey, 'must push remote runtime-etc/group')
  const passwdText = writes.get(passwdKey).toString('utf8')
  const groupText = writes.get(groupKey).toString('utf8')
  assert.match(passwdText, /^mchen:x:2001:2002::\/home\/mchen:\/bin\/bash$/m)
  assert.doesNotMatch(passwdText, /^kincli:/m)
  assert.match(groupText, /^mchen:x:2002:$/m)
  assert.doesNotMatch(groupText, /^kincli:/m)

  // Verify node-edit source checks slotHome(vm) instead of hardcoded '/home/kincli'
  const nodeEditSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'lib', 'cluster', 'node-edit.mjs'), 'utf8')
  assert.match(nodeEditSrc, /mountMatches\(info, `\$\{dir\}\/cli-home`, kvm \? '\/slot\/home' : slotHome\(vm\)\)/)
  assert.equal(typeof verifyNodeRuntimes, 'function')
})

test('Dockerfile and build-custom-debian13-os.sh convert /etc/{os-release,localtime,timezone} to regular files with label', () => {
  const df = fs.readFileSync(OS_DOCKERFILE, 'utf8')
  assert.match(df, new RegExp(`${REGULAR_ETC_TARGETS_LABEL}="1"`))
  assert.match(df, /cp -L \/usr\/lib\/os-release \/etc\/\.os-release\.reg/)
  assert.match(df, /cp -L \/usr\/share\/zoneinfo\/UTC \/etc\/localtime/)
  assert.match(df, /chmod 0644 \/etc\/os-release \/etc\/localtime \/etc\/timezone/)

  const buildSh = fs.readFileSync(BUILD_OS_SCRIPT, 'utf8')
  assert.match(buildSh, new RegExp(`LABEL ${REGULAR_ETC_TARGETS_LABEL}=1`))
  assert.match(buildSh, /ensure_regular_etc_targets/)
  assert.match(buildSh, /etc\/os-release usr\/lib\/os-release etc\/localtime etc\/timezone/)
})

unixTest('PTY scripts honor KIN_SLOT_HOME and KIN_SLOT_USER in fallback build_argv', () => {
  for (const script of [SETUP_TOKEN_PTY, RESIDENT_PTY]) {
    const out = execFileSync(
      'python3',
      [
        '-c',
        `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("mod", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
print(json.dumps(mod.build_argv()))`,
        script,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          KIN_DOCKER_ARGV: '',
          KIN_CONTAINER: 'kin-vm-70',
          KIN_UID: '10070',
          KIN_GID: '987',
          KIN_CLI_BIN: '/home/mchen/.kin/cli-node',
          KIN_SLOT_HOME: '/home/mchen',
          KIN_SLOT_USER: 'mchen',
        },
      },
    )
    const argv = JSON.parse(out.trim())
    assert.ok(argv.includes('HOME=/home/mchen'))
    assert.ok(argv.includes('USER=mchen'))
    assert.ok(argv.includes('LOGNAME=mchen'))
    assert.ok(argv.includes('TMPDIR=/home/mchen/.cache/tmp'))
    assert.ok(argv.includes('/home/mchen'))
    assert.equal(
      argv.some((a) => a.includes('/home/kincli')),
      false,
    )
  }
})

unixTest('kin-guest-exec seeds USER/LOGNAME/HOME from /etc/passwd on -u and lets explicit -e override', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wu3b-guest-exec-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const bin = path.join(tmp, 'bin')
  fs.mkdirSync(bin)
  const key = path.join(tmp, 'id_ed25519')
  fs.writeFileSync(key, 'fake\n', { mode: 0o600 })
  const fakePasswd = path.join(tmp, 'passwd')
  fs.writeFileSync(fakePasswd, 'root:x:0:0:root:/root:/bin/bash\nmchen:x:1000:1000::/home/mchen:/bin/bash\n')

  // Fake ssh executes the remote sh -c snippet locally with fake setpriv + fake /etc/passwd.
  fs.writeFileSync(
    path.join(bin, 'setpriv'),
    '#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = "--" ] && { shift; break; }; shift; done\nexec "$@"\n',
    { mode: 0o755 },
  )
  fs.writeFileSync(
    path.join(bin, 'ssh'),
    `#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in
    root@127.0.0.1) shift; remote=$1; break ;;
    *) shift ;;
  esac
done
remote=$(printf '%s' "$remote" | sed "s|/etc/passwd|${fakePasswd.replace(/'/g, `'\\''`)}|g")
HOME=/root USER=root LOGNAME=root MAIL=/var/mail/root eval "$remote"
`,
    { mode: 0o755 },
  )
  const execCopy = path.join(tmp, 'kin-guest-exec')
  fs.writeFileSync(execCopy, fs.readFileSync(GUEST_EXEC, 'utf8').replace('KEY=/slot/kvm/id_ed25519', `KEY=${key}`), {
    mode: 0o755,
  })

  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` }
  const seeded = spawnSync(
    execCopy,
    ['-u', '1000:1000', '--', '/bin/sh', '-c', 'printf "%s|%s|%s|%s" "$USER" "$LOGNAME" "$HOME" "${MAIL:-}"'],
    {
      encoding: 'utf8',
      env,
    },
  )
  assert.equal(seeded.status, 0, seeded.stderr)
  assert.equal(seeded.stdout, 'mchen|mchen|/home/mchen|')

  const overridden = spawnSync(
    execCopy,
    [
      '-u',
      '1000:1000',
      '-e',
      'HOME=/tmp/custom',
      '-e',
      'USER=override',
      '-e',
      'MAIL=/var/mail/mchen',
      '--',
      '/bin/sh',
      '-c',
      'printf "%s|%s|%s|%s" "$USER" "$LOGNAME" "$HOME" "${MAIL:-}"',
    ],
    { encoding: 'utf8', env },
  )
  assert.equal(overridden.status, 0, overridden.stderr)
  assert.equal(overridden.stdout, 'override|mchen|/tmp/custom|/var/mail/mchen')
})

unixTest(
  'kin-guest-init boot.env zero-eval parser, identity resolver, prctl EINVAL fallback, and crag env injection',
  (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wu3b-guest-init-'))
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
    const initSrc = fs.readFileSync(GUEST_INIT, 'utf8')
    const markerIdx = initSrc.indexOf('\ntrap shutdown_guest ')
    assert.ok(markerIdx > 0)
    const libPath = path.join(tmp, 'init-lib.sh')
    fs.writeFileSync(libPath, initSrc.slice(0, markerIdx + 1))

    const marker = path.join(tmp, 'pwned')
    const bootEnv = path.join(tmp, 'boot.env')
    fs.writeFileSync(
      bootEnv,
      [
        '# comment line',
        'KIN_VM_ID=vm-90',
        `KIN_HOSTNAME=pc-$(touch ${marker})`,
        'KIN_SLOT_USER=mchen',
        'KIN_SLOT_UID=1000',
        'KIN_SLOT_GID=1000',
        'KIN_TZ=America/New_York',
        'KIN_LANG=en_US.UTF-8',
        'KIN_KERNEL_RELEASE=6.8.0-57-generic',
        'KIN_KERNEL_VERSION=#59-Ubuntu SMP PREEMPT_DYNAMIC',
        'KIN_KERNEL_PROC_MID=(buildd@lcy02-amd64-087)',
        '',
      ].join('\n'),
    )

    const runKin = path.join(tmp, 'run-kin')
    const storeDir = path.join(tmp, 'store')
    const fakeBin = path.join(tmp, 'fake-bin')
    fs.mkdirSync(runKin, { recursive: true })
    fs.mkdirSync(path.join(storeDir, 'crag', 'current'), { recursive: true })
    fs.mkdirSync(fakeBin, { recursive: true })
    fs.writeFileSync(path.join(runKin, 'kernel.json'), '{}\n')
    const envOut = path.join(tmp, 'crag-env.txt')
    fs.writeFileSync(
      path.join(fakeBin, 'setpriv'),
      `#!/bin/sh
printf 'SETPRIV=%s\\n' "$*" > ${envOut}
while [ $# -gt 0 ]; do [ "$1" = "--" ] && { shift; break; }; shift; done
exec "$@"
`,
      { mode: 0o755 },
    )
    fs.writeFileSync(
      path.join(storeDir, 'crag', 'current', 'crag-v2'),
      `#!/bin/sh
printf 'HOME=%s\\nUSER=%s\\nLOGNAME=%s\\nCLAUDE_CONFIG_DIR=%s\\nTZ=%s\\nLANG=%s\\n' "$HOME" "$USER" "$LOGNAME" "$CLAUDE_CONFIG_DIR" "$TZ" "$LANG" >> ${envOut}
sleep 2
`,
      { mode: 0o755 },
    )

    const out = execFileSync(
      '/bin/sh',
      [
        '-eu',
        '-c',
        `
      . "$1"
      PATH="$2:$PATH"
      export PATH
      RUN_KIN="$3"
      STORE_DIR="$4"
      load_boot_env "$5"
      resolve_slot_identity
      apply_kernel_uts_once
      LANG="$KIN_LANG"
      supervise_crag_once
      sleep 0.2
      kill -TERM "$CRAG_PID" 2>/dev/null || true
      wait "$CRAG_PID" 2>/dev/null || true
      printf '%s|%s|%s|%s|%s\\n' "$SLOT_USER" "$SLOT_UID" "$SLOT_GID" "$SLOT_HOME" "$KIN_HOSTNAME"
      # Invalid/reserved username falls back to kincli (999:987)
      KIN_SLOT_USER=root
      KIN_SLOT_UID=""
      KIN_SLOT_GID=""
      resolve_slot_identity
      printf '%s|%s|%s|%s\\n' "$SLOT_USER" "$SLOT_UID" "$SLOT_GID" "$SLOT_HOME"
      `,
        '--',
        libPath,
        fakeBin,
        runKin,
        storeDir,
        bootEnv,
      ],
      { encoding: 'utf8' },
    )
    const [line1, line2] = out.trim().split('\n')
    assert.equal(fs.existsSync(marker), false, 'boot.env parser must never eval command substitution')
    assert.equal(line1, `mchen|1000|1000|/home/mchen|pc-$(touch ${marker})`)
    assert.equal(line2, 'kincli|999|987|/home/kincli')
    const captured = fs.readFileSync(envOut, 'utf8')
    assert.match(captured, /--reuid=1000 --regid=1000/)
    assert.match(captured, /^HOME=\/home\/mchen$/m)
    assert.match(captured, /^USER=mchen$/m)
    assert.match(captured, /^LOGNAME=mchen$/m)
    assert.match(captured, /^CLAUDE_CONFIG_DIR=\/home\/mchen\/\.claude$/m)
    assert.match(captured, /^TZ=America\/New_York$/m)
  },
)

unixTest(
  'kin-slot-agent accepts --slot-uid/--slot-gid and sync_preset_tz refreshes TZif in-place preserving inode',
  (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wu3b-slot-agent-'))
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
    const stateDir = path.join(tmp, 'state')
    const managedDir = path.join(stateDir, 'managed-settings.d')
    const etcTzDir = path.join(tmp, 'etc-tz')
    fs.mkdirSync(managedDir, { recursive: true })
    fs.mkdirSync(etcTzDir, { recursive: true })

    // Pre-seed larger TZif file to prove pwrite + ftruncate preserves inode AND truncates trailing bytes cleanly.
    const liveLocaltime = path.join(etcTzDir, 'localtime')
    const initialTzif = Buffer.concat([Buffer.from('TZif2'), Buffer.alloc(120, 0x41)])
    fs.writeFileSync(liveLocaltime, initialTzif)
    const beforeIno = fs.statSync(liveLocaltime).ino

    const nextTzif = Buffer.concat([Buffer.from('TZif2'), Buffer.alloc(50, 0x42)])
    const nextTzifSha = crypto.createHash('sha256').update(nextTzif).digest('hex')
    const presetBytes = Buffer.from(JSON.stringify({ env: { TZ: 'America/New_York', LANG: 'en_US.UTF-8' } }) + '\n')
    const presetSha = crypto.createHash('sha256').update(presetBytes).digest('hex')
    const badBytes = Buffer.from('NOT-A-TZIF-FILE' + 'X'.repeat(40))
    const badSha = crypto.createHash('sha256').update(badBytes).digest('hex')
    const token = 'b'.repeat(64)

    const out = execFileSync(
      'python3',
      [
        '-c',
        `import importlib.machinery, importlib.util, json, sys
from pathlib import Path
loader = importlib.machinery.SourceFileLoader("slot_agent", sys.argv[1])
spec = importlib.util.spec_from_loader("slot_agent", loader)
mod = importlib.util.module_from_spec(spec)
sys.modules["slot_agent"] = mod
loader.exec_module(mod)
cfg = mod.AgentConfig(
    token=sys.argv[2],
    state_dir=Path(sys.argv[3]),
    managed_preset_dir=Path(sys.argv[4]),
    etc_tz_dir=Path(sys.argv[5]),
    kincli_uid=1000,
    kincli_gid=1000,
    project_mounts=False,
)
svc = mod.SlotAgentService(cfg)
ok_res = svc.handle_request({
    "id": "r1",
    "token": sys.argv[2],
    "op": "sync_preset_tz",
    "params": {
        "timezone": "America/New_York",
        "localtime_b64": sys.argv[6],
        "localtime_sha256": sys.argv[7],
        "preset_b64": sys.argv[8],
        "preset_sha256": sys.argv[9],
    },
})
bad_res = svc.handle_request({
    "id": "r2",
    "token": sys.argv[2],
    "op": "sync_preset_tz",
    "params": {
        "localtime_b64": sys.argv[10],
        "localtime_sha256": sys.argv[11],
    },
})
print(json.dumps({"ok_res": ok_res, "bad_res": bad_res}))`,
        SLOT_AGENT,
        token,
        stateDir,
        managedDir,
        etcTzDir,
        nextTzif.toString('base64'),
        nextTzifSha,
        presetBytes.toString('base64'),
        presetSha,
        badBytes.toString('base64'),
        badSha,
      ],
      { encoding: 'utf8' },
    )
    const { ok_res, bad_res } = JSON.parse(out.trim())
    assert.equal(ok_res.ok, true, JSON.stringify(ok_res))
    assert.deepEqual(ok_res.result.updated, ['managed_preset', 'timezone', 'localtime'])
    assert.equal(ok_res.result.live_tz_refreshed, true)

    const afterStat = fs.statSync(liveLocaltime)
    assert.equal(afterStat.ino, beforeIno, 'in-place pwrite+ftruncate must keep the bind-mounted inode unchanged')
    assert.equal(afterStat.size, nextTzif.length)
    assert.deepEqual(fs.readFileSync(liveLocaltime), nextTzif)
    assert.equal(fs.readFileSync(path.join(etcTzDir, 'timezone'), 'utf8'), 'America/New_York\n')
    assert.deepEqual(fs.readFileSync(path.join(stateDir, 'etc-override', 'localtime')), nextTzif)
    assert.equal(fs.readFileSync(path.join(managedDir, '10-slot-preset.json'), 'utf8'), presetBytes.toString('utf8'))

    assert.equal(bad_res.ok, false)
    assert.equal(bad_res.error, 'invalid_localtime')
  },
)

test('guest-identity-reader READ_IDENTITY dynamically resolves /etc/os-release, uname -r, and /etc/passwd shell', () => {
  assert.match(READ_IDENTITY, /\. \/etc\/os-release/)
  assert.match(READ_IDENTITY, /\$\(uname -r\)/)
  assert.match(READ_IDENTITY, /id -un/)
  assert.match(READ_IDENTITY, /\/etc\/passwd/)
})
