import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanDirectoryForSecrets } from '../../scripts/verify-os-image-secrets.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const KVM_DIR = path.join(REPO_ROOT, 'docker', 'kin-kvm')
const LOAD_HW_PLAN = path.join(KVM_DIR, 'load-hw-plan.sh')
const KVM_ENTRY = path.join(KVM_DIR, 'kin-kvm-entry')
const GUEST_INIT = path.join(KVM_DIR, 'guest', 'kin-guest-init')
const SLOT_AGENT = path.join(KVM_DIR, 'guest', 'kin-slot-agent')
const KERNEL_RELAY = path.join(KVM_DIR, 'guest', 'kin-kernel-relay.py')
const SSHD_CONFIG = path.join(KVM_DIR, 'guest', 'sshd_config.kin')
const KVM_DOCKERFILE = path.join(KVM_DIR, 'Dockerfile')
const OS_DOCKERFILE = path.join(REPO_ROOT, 'docker', 'kin-os', 'debian-13', 'Dockerfile')
const BUILD_OS_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-custom-debian13-os.sh')

const SAMPLE_UUID = '4d2a1b3c-5e6f-4789-9abc-def012345678'
const SAMPLE_SMBIOS_ARGS = [
  '-uuid',
  SAMPLE_UUID,
  '-smbios',
  'type=0,vendor=LENOVO,version=M47KT32A,date=03/14/2023,release=1.50,uefi=on',
  '-smbios',
  `type=1,manufacturer=LENOVO,product=11T30025US,version=ThinkCentre M70q Gen 3,serial=PCN12345,uuid=${SAMPLE_UUID},sku=LENOVO_MT_11T3,family=ThinkCentre`,
  '-smbios',
  'type=2,manufacturer=LENOVO,product=32E2,version=SDK0T76463 WIN,serial=L1HFM3E1234,asset=LN2304ABCD,location=System Board',
  '-smbios',
  'type=3,manufacturer=LENOVO,version=ThinkCentre Tiny,serial=PCN12345,asset=TK2314ABCD,sku=11T3-TINY',
  '-smbios',
  'type=4,sock_pfx=LGA1700,manufacturer=Intel(R) Corporation,version=12th Gen Intel(R) Core(TM) i5-12400T,serial=CPU2314ABCDEF01,asset=PROC-23ABCD,part=CM8071504650506,max-speed=4200,current-speed=1800',
  '-smbios',
  'type=17,loc_pfx=ChannelA-DIMM0,bank=BANK 0,manufacturer=Samsung,serial=3A7F91C4,asset=DIMM0023ABCD,part=M471A2K43EB1-CWE,speed=3200',
  '',
].join('\n')

const unixTest = process.platform === 'win32' ? test.skip : test

unixTest('load-hw-plan.sh safely parses hardware.json without eval and validates SMBIOS whitelist', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-hw-plan-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

  const marker = path.join(tmp, 'pwned')
  const trickySerial = `SN 1 $(touch ${marker})`
  fs.writeFileSync(
    path.join(tmp, 'hardware.json'),
    JSON.stringify({
      cpu_family: 6,
      cpu_model: 158,
      cpu_stepping: 0,
      logical_cpus: 4,
      ram_mb: 1024,
      en0_mac: '98:fa:9b:12:34:56',
      disk_serial: trickySerial,
    }),
  )
  fs.writeFileSync(
    path.join(tmp, 'bad.json'),
    JSON.stringify({
      en0_mac: '01:22:fb:f9:50:9d',
      disk_serial: 'BAD,COMMA',
    }),
  )
  fs.writeFileSync(path.join(tmp, 'good.args'), SAMPLE_SMBIOS_ARGS)
  fs.writeFileSync(path.join(tmp, 'injected.args'), '-chardev\nsocket,id=pwn,path=/tmp/pwn\n')

  const out = execFileSync(
    '/bin/bash',
    [
      '-ceu',
      `
      source "$1"
      CPU_MODEL=""
      KIN_KVM_MEMORY_MB=""
      KIN_KVM_VCPUS=""
      KIN_KVM_MAC=""
      KIN_KVM_DISK_SERIAL=""
      load_hw_plan "$2/hardware.json"
      test ! -e "$3"
      python3 - "$CPU_MODEL" "$KIN_KVM_MEMORY_MB" "$KIN_KVM_VCPUS" "$KIN_KVM_MAC" "$KIN_KVM_DISK_SERIAL" "$not_applied" <<'PY'
import json, sys
print(json.dumps({
    "cpu": sys.argv[1],
    "mem": sys.argv[2],
    "vcpus": sys.argv[3],
    "mac": sys.argv[4],
    "serial": sys.argv[5],
    "not_applied": sys.argv[6],
}))
PY
      KIN_KVM_MAC=""
      KIN_KVM_DISK_SERIAL=""
      load_hw_plan "$2/bad.json"
      test -z "$KIN_KVM_MAC"
      test -z "$KIN_KVM_DISK_SERIAL"
      load_smbios_args "$2/good.args"
      test "\${#FP_SMBIOS[@]}" -eq 14
      if load_smbios_args "$2/injected.args" 2>/dev/null; then
        echo "expected injected.args to be rejected" >&2
        exit 1
      fi
      `,
      '--',
      LOAD_HW_PLAN,
      tmp,
      marker,
    ],
    { encoding: 'utf8' },
  )

  const parsed = JSON.parse(out.trim())
  assert.equal(parsed.cpu, 'max,family=6,model=158,stepping=0')
  assert.equal(parsed.mem, '1024')
  assert.equal(parsed.vcpus, '4')
  assert.equal(parsed.mac, '98:fa:9b:12:34:56')
  assert.equal(parsed.serial, trickySerial)
  assert.equal(parsed.not_applied, 'smc_version,rom_hex')
  assert.equal(fs.existsSync(marker), false)
})

function runEntryDryRun(tmp, extraEnv = {}) {
  const slotKvm = path.join(tmp, 'slot-kvm')
  const slotRun = path.join(tmp, 'slot-run')
  const slotHome = path.join(tmp, 'slot-home')
  const fpDir = path.join(slotKvm, 'fingerprint')
  const storeDir = path.join(tmp, 'store')
  const fakeBin = path.join(tmp, 'fake-bin')
  fs.mkdirSync(fpDir, { recursive: true })
  fs.mkdirSync(storeDir, { recursive: true })
  fs.mkdirSync(fakeBin, { recursive: true })

  fs.writeFileSync(path.join(fpDir, 'qemu-smbios.args'), SAMPLE_SMBIOS_ARGS)
  fs.writeFileSync(
    path.join(fpDir, 'hardware.json'),
    JSON.stringify({
      cpu_family: 6,
      cpu_model: 151,
      cpu_stepping: 5,
      logical_cpus: 4,
      ram_mb: 1024,
      en0_mac: '98:fa:9b:aa:bb:cc',
      disk_serial: 'S649NX0T04123456',
    }),
  )
  const fakeVirtiofsd = path.join(fakeBin, 'virtiofsd')
  fs.writeFileSync(fakeVirtiofsd, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

  const env = {
    ...process.env,
    KIN_KVM_DRY_RUN: '1',
    KIN_KVM_SLOT_KVM: slotKvm,
    KIN_KVM_SLOT_RUN: slotRun,
    KIN_KVM_SLOT_HOME: slotHome,
    KIN_KVM_LOAD_HW_PLAN: LOAD_HW_PLAN,
    KIN_KVM_SMBIOS_ARGS_FILE: path.join(fpDir, 'qemu-smbios.args'),
    KIN_KVM_HW_PLAN_FILE: path.join(fpDir, 'hardware.json'),
    KIN_KVM_STORE_DIR: storeDir,
    KIN_KVM_VIRTIOFSD_BIN: fakeVirtiofsd,
    KIN_VM_ID: 'vm-p2-test',
    KIN_KVM_UID: '1000',
    KIN_KVM_GID: '1000',
    KIN_KVM_MEMORY_MB: '1024',
    KIN_KVM_VCPUS: '2',
    KIN_KVM_DISK_GB: '10',
    KIN_KVM_CPU_MODEL: 'host',
    KIN_KVM_MAC: '98:fa:9b:00:00:01',
    KIN_KVM_DISK_SERIAL: 'KIN0001',
    KIN_KVM_HOSTNAME: 'thinkcentre-123456',
    KIN_KVM_MACHINE_ID: '0123456789abcdef0123456789abcdef',
    KIN_KVM_ACCEL: 'kvm',
    KIN_KVM_SMBIOS_MANUFACTURER: 'LENOVO',
    KIN_KVM_SMBIOS_PRODUCT: '11T30025US',
    KIN_KVM_SMBIOS_VERSION: '1.0',
    KIN_KVM_SMBIOS_FAMILY: 'ThinkCentre',
    KIN_KVM_SMBIOS_SERIAL: 'PCN12345',
    KIN_KVM_SMBIOS_UUID: SAMPLE_UUID,
    KIN_AGENT_TOKEN: 'a'.repeat(64),
    ...extraEnv,
  }
  const res = spawnSync('/bin/bash', [KVM_ENTRY], { env, encoding: 'utf8' })
  assert.equal(res.status, 0, `kin-kvm-entry dry-run failed:\n${res.stderr}`)
  return JSON.parse(res.stdout.trim())
}

unixTest(
  'kin-kvm-entry custom-erofs builds virtiofs + vsock + full SMBIOS + offline ext4 + zero 9p/KSM/cloud-init',
  (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kvm-erofs-vsock-'))
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

    const plan = runEntryDryRun(tmp, {
      KIN_KVM_MODE: 'custom-erofs',
      KIN_KVM_STORE_MODE: 'auto',
      KIN_KVM_VSOCK_CID: '1042',
      KIN_KVM_DRY_RUN_VSOCK: '1',
    })

    assert.equal(plan.mode, 'custom-erofs')
    assert.equal(plan.store_mode, 'virtiofs')
    assert.equal(plan.transport, 'vsock')
    assert.equal(plan.agent_token_in_env, false, 'KIN_AGENT_TOKEN must be scrubbed before launching child processes')
    assert.equal(fs.existsSync(plan.state_disk), true, 'offline mke2fs slot-state.ext4 must be created')
    const slotKey = path.join(tmp, 'slot-kvm', 'id_ed25519')
    const slotPub = path.join(tmp, 'slot-kvm', 'id_ed25519.pub')
    assert.equal(fs.existsSync(slotKey), true, 'ensure_key must generate per-slot id_ed25519 for kin-guest-exec')
    assert.equal(fs.existsSync(slotPub), true, 'ensure_key must generate per-slot id_ed25519.pub')

    // Inspect offline slot-state.ext4 layout when debugfs is installed on the host.
    const dbg = spawnSync('debugfs', ['-R', 'ls -l /home', plan.state_disk], { encoding: 'utf8' })
    if (dbg.status === 0) {
      assert.match(dbg.stdout, /\.claude\b/)
      assert.match(dbg.stdout, /\.claude\.json\b/)
      const dbgSsh = execFileSync('debugfs', ['-R', 'ls -l /ssh', plan.state_disk], { encoding: 'utf8' })
      assert.match(dbgSsh, /authorized_keys\b/)
      assert.match(dbgSsh, /ssh_host_ed25519_key\b/)
      const authKeys = execFileSync('debugfs', ['-R', 'cat /ssh/authorized_keys', plan.state_disk], {
        encoding: 'utf8',
      })
      assert.equal(authKeys.trim(), fs.readFileSync(slotPub, 'utf8').trim())
    }

    // Second boot with existing slot-state.ext4 must ALSO scrub KIN_AGENT_TOKEN before spawning QEMU/virtiofsd.
    const planReuse = runEntryDryRun(tmp, {
      KIN_KVM_MODE: 'custom-erofs',
      KIN_KVM_STORE_MODE: 'auto',
      KIN_KVM_VSOCK_CID: '1042',
      KIN_KVM_DRY_RUN_VSOCK: '1',
    })
    assert.equal(
      planReuse.agent_token_in_env,
      false,
      'KIN_AGENT_TOKEN must be scrubbed even when slot-state.ext4 already exists',
    )

    const joined = plan.qemu.join(' ')
    assert.match(joined, /-machine q35,mem-merge=off/)
    assert.match(joined, /rootfstype=erofs ro init=\/usr\/local\/sbin\/kin-guest-init net\.ifnames=0 biosdevname=0/)
    assert.match(joined, /memory-backend-memfd,id=mem0,size=1024M,share=on/)
    assert.match(joined, /-m 1024 -smp 2\b/)
    assert.match(joined, /vhost-user-fs-pci,queue-size=1024,chardev=char_kinstore,tag=kinstore/)
    assert.match(joined, /user,id=net0,hostfwd=tcp:127\.0\.0\.1:2222-:22\b/)
    assert.match(joined, /vhost-vsock-pci,id=vsock0,guest-cid=1042/)
    assert.match(joined, new RegExp(`-uuid ${SAMPLE_UUID}`))
    for (const ty of ['type=0,', 'type=1,', 'type=2,', 'type=3,', 'type=4,', 'type=17,']) {
      assert.ok(
        plan.qemu.some((arg) => arg.startsWith(ty)),
        `missing SMBIOS ${ty}`,
      )
    }
    assert.doesNotMatch(joined, /virtio-9p-pci/)
    assert.doesNotMatch(joined, /seed\.iso/)
    assert.ok(plan.virtiofsd.includes('--readonly'))
    assert.ok(plan.virtiofsd.includes('--sandbox=none'))
    assert.match(plan.socat_kernel.join(' '), /VSOCK-CONNECT:1042:7070/)
    assert.match(plan.socat_agent.join(' '), /VSOCK-CONNECT:1042:7071/)

    // Hardware profile with 16 GiB RAM / 12 vCPU must be clamped to host slot ceiling while keeping SMBIOS Type 17.
    const bigHw = path.join(tmp, 'big-hardware.json')
    fs.writeFileSync(
      bigHw,
      JSON.stringify({
        cpu_family: 6,
        cpu_model: 154,
        cpu_stepping: 3,
        logical_cpus: 12,
        ram_mb: 16384,
        en0_mac: 'a0:d3:c1:17:5f:53',
        disk_serial: 'S649NX0T04999999',
      }),
    )
    const clamped = runEntryDryRun(tmp, {
      KIN_KVM_MODE: 'custom-erofs',
      KIN_KVM_STORE_MODE: 'auto',
      KIN_KVM_HW_PLAN_FILE: bigHw,
      KIN_KVM_MEMORY_MB: '1536',
      KIN_KVM_VCPUS: '2',
      KIN_KVM_VSOCK_CID: '1042',
      KIN_KVM_DRY_RUN_VSOCK: '1',
    })
    const clampedJoined = clamped.qemu.join(' ')
    assert.match(clampedJoined, /-cpu max,family=6,model=154,stepping=3\b/)
    assert.match(clampedJoined, /-m 1536 -smp 2\b/)
    assert.match(clampedJoined, /memory-backend-memfd,id=mem0,size=1536M,share=on/)
    assert.ok(
      clamped.qemu.some((arg) => arg.startsWith('type=17,')),
      'SMBIOS Type 17 must remain intact when RAM is clamped',
    )
  },
)

unixTest(
  'kin-kvm-entry custom-erofs falls back cleanly to virtio-blk + virtio-serial when vsock/virtiofs unavailable',
  (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kvm-erofs-fallback-'))
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

    const storeBlk = path.join(tmp, 'store.erofs')
    fs.writeFileSync(storeBlk, 'stub-erofs')

    const plan = runEntryDryRun(tmp, {
      KIN_KVM_MODE: 'custom-erofs',
      KIN_KVM_ACCEL: 'tcg',
      KIN_KVM_STORE_MODE: 'virtio-blk',
      KIN_KVM_STORE_BLK_IMAGE: storeBlk,
      KIN_KVM_VSOCK_CID: '1043',
    })

    assert.equal(plan.mode, 'custom-erofs')
    assert.equal(plan.store_mode, 'virtio-blk')
    assert.equal(plan.transport, 'virtio-serial')

    const joined = plan.qemu.join(' ')
    assert.match(joined, /id=store0,format=raw,readonly=on/)
    assert.match(joined, /virtio-blk-pci,drive=store0,serial=kinstore/)
    assert.match(joined, /user,id=net0,hostfwd=tcp:127\.0\.0\.1:2222-:22,hostfwd=tcp:127\.0\.0\.1:7070-:7070\b/)
    assert.match(joined, /virtio-serial-pci,id=vserial0/)
    assert.match(joined, /virtserialport,bus=vserial0\.0,chardev=char_agent,name=kin\.agent\.0/)
    assert.doesNotMatch(joined, /vhost-vsock-pci/)
    assert.doesNotMatch(joined, /vhost-user-fs-pci/)
    assert.doesNotMatch(joined, /virtio-9p-pci/)
  },
)

unixTest('kin-kvm-entry legacy mode stays 100% backward compatible while supporting full qemu-smbios.args', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-kvm-legacy-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

  const plan = runEntryDryRun(tmp, {
    KIN_KVM_MODE: 'legacy',
    KIN_KVM_APPLY_HW_PLAN: '0',
  })

  assert.equal(plan.mode, 'legacy')
  const joined = plan.qemu.join(' ')
  assert.match(joined, /disk\.qcow2/)
  assert.match(joined, /seed\.iso/)
  assert.match(joined, /virtio-9p-pci,fsdev=fs_home,mount_tag=kinhome/)
  assert.ok(plan.qemu.some((arg) => arg.startsWith('type=17,')))
})

test('Dockerfile, kin-guest-init, and build-custom-debian13-os.sh align with Phase 2 EROFS and secret gate', (t) => {
  const dockerfile = fs.readFileSync(KVM_DOCKERFILE, 'utf8')
  assert.match(dockerfile, /^FROM debian:trixie-slim/m)
  for (const pkg of ['virtiofsd', 'erofs-utils', 'e2fsprogs']) {
    assert.match(dockerfile, new RegExp(`\\b${pkg}\\b`))
  }
  assert.match(dockerfile, /load-hw-plan\.sh/)
  assert.match(dockerfile, /kin-guest-init/)
  assert.match(dockerfile, /kin-slot-agent/)
  assert.match(dockerfile, /sshd_config\.kin/)

  const sshdCfg = fs.readFileSync(SSHD_CONFIG, 'utf8')
  for (const directive of [
    /^PermitRootLogin prohibit-password$/m,
    /^PasswordAuthentication no$/m,
    /^KbdInteractiveAuthentication no$/m,
    /^UsePAM no$/m,
    /^AuthorizedKeysFile \/var\/lib\/kin-slot\/ssh\/authorized_keys$/m,
    /^HostKey \/var\/lib\/kin-slot\/ssh\/ssh_host_ed25519_key$/m,
    /^PidFile \/run\/sshd\.pid$/m,
    /^AcceptEnv LANG LC_\*/m,
  ]) {
    assert.match(sshdCfg, directive, `sshd_config.kin missing directive ${directive}`)
  }

  const initText = fs.readFileSync(GUEST_INIT, 'utf8')
  const initCode = initText
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
  assert.match(initCode, /\/run\/vm2api-crag/)
  assert.match(initCode, /RUN_KIN=\/run\/kin/)
  assert.match(initCode, /\$RUN_KIN\/crag-native-assets/)
  assert.match(initCode, /RUN_GUEST=\/run\/kin-guest/)
  assert.match(initCode, /chmod 0700 "\$RUN_KIN\/crag-native-assets"/)
  assert.match(initCode, /chmod 0770 "\$RUN_GUEST"/)
  assert.match(initCode, /\[ -d \/home\/kincli \]/)
  assert.match(initCode, /mount --bind "\$STATE_DIR\/home" \/home\/kincli/)
  assert.doesNotMatch(initCode, /mkdir -p \/home\/kincli/)
  assert.match(initCode, /--claude-dir "\$STATE_DIR\/home\/\.claude"/)
  assert.match(initCode, /mkdir -p \/run\/sshd/)
  assert.match(initCode, /"\$SSHD_BIN" -D -e -f "\$SSHD_CFG"/)
  assert.match(initCode, /kill -TERM "\$SSHD_PID"/)
  assert.match(initCode, /\/etc\/machine-id/)
  assert.match(initCode, /virtiofs/)
  assert.match(initCode, /virtio-kinstore/)
  assert.match(initCode, /kin-slot-agent/)
  assert.match(initCode, /kin-kernel-relay/)
  assert.match(initCode, /modprobe virtio_net/)
  assert.match(initCode, /\/sys\/class\/net\/\*/)
  assert.match(initCode, /"\$KIN_AGENT_TRANSPORT" != vsock/)
  assert.match(initCode, /setpriv --reuid="\$KINCLI_UID" --regid="\$KINCLI_GID"/)
  assert.match(initCode, /127\.0\.0\.1 localhost/)
  assert.match(initCode, /::1 localhost/)
  assert.match(initCode, /127\.0\.1\.1/)
  assert.match(initCode, /mount --bind "\$RUN_KIN\/hosts" \/etc\/hosts/)
  assert.match(initCode, /proc_alive\(\)/)
  assert.match(initCode, /mv -f "\$RUN_KIN\/\.crag\.pid\.tmp" "\$RUN_KIN\/crag\.pid"/)
  assert.doesNotMatch(initCode, /cloud-init/)
  assert.doesNotMatch(initCode, /kin-crag-apparmor/)
  assert.doesNotMatch(initCode, /virtio-9p/)

  const entryText = fs.readFileSync(KVM_ENTRY, 'utf8')
  assert.match(entryText, /exec 3<>"\$VSOCK_DEV"/)
  assert.match(entryText, /net\.ifnames=0 biosdevname=0/)

  const buildScript = fs.readFileSync(BUILD_OS_SCRIPT, 'utf8')
  const osDockerfile = fs.readFileSync(OS_DOCKERFILE, 'utf8')
  const sharedPkgs = [
    'bash',
    'bubblewrap',
    'ca-certificates',
    'curl',
    'file',
    'git',
    'iproute2',
    'jq',
    'less',
    'locales',
    'ncurses-term',
    'nftables',
    'openssh-client',
    'procps',
    'python3',
    'ripgrep',
    'socat',
    'tzdata',
    'util-linux',
  ]
  const basePkgsMatch = buildScript.match(/^BASE_PKGS="([^"]+)"/m)
  assert.ok(basePkgsMatch, 'build-custom-debian13-os.sh must declare BASE_PKGS')
  assert.deepEqual(basePkgsMatch[1].split(',').sort(), [...sharedPkgs].sort())
  for (const pkg of sharedPkgs) {
    assert.match(osDockerfile, new RegExp(`\\b${pkg}\\b`), `docker/kin-os/debian-13/Dockerfile missing ${pkg}`)
  }
  assert.match(osDockerfile, /locale-gen en_US\.UTF-8/)
  assert.match(buildScript, /locale-gen en_US\.UTF-8/)
  assert.match(osDockerfile, /ln -sfn \/opt\/kin\/store\/claude\/current \/usr\/local\/bin\/claude/)
  assert.match(buildScript, /ln -sfn \/opt\/kin\/store\/claude\/current "\$1\/usr\/local\/bin\/claude"/)
  assert.match(buildScript, /EROFS_EXTRA_PKGS=\(kmod openssh-server\)/)
  assert.match(buildScript, /rm -f "\$\{ROOTFS_DIR\}"\/etc\/ssh\/ssh_host_\*_key\*/)
  assert.match(buildScript, /sshd_config\.kin/)
  assert.match(buildScript, /kin-guest-init/)
  assert.match(buildScript, /kin-slot-agent/)
  assert.match(buildScript, /kin-kernel-relay/)
  assert.match(
    buildScript,
    /ln -sfn \/opt\/kin\/store\/bin\/kin-oauth-auth "\$\{ROOTFS_DIR\}\/usr\/local\/bin\/kin-oauth-auth"/,
  )
  assert.match(
    buildScript,
    /ln -sfn \/opt\/kin\/store\/bin\/kin-worker "\$\{ROOTFS_DIR\}\/usr\/local\/bin\/kin-worker"/,
  )
  assert.match(buildScript, /home\/kincli\/\.claude/)
  assert.match(buildScript, /etc\/resolv\.conf/)
  assert.match(buildScript, /etc\/hosts/)

  // Stage a synthetic EROFS rootfs containing kin-guest-init + kin-slot-agent + kin-kernel-relay + sshd_config.kin
  // + /usr/local/bin/{claude,kin-oauth-auth,kin-worker} symlinks + managed-settings.json + /etc/hosts placeholder
  // and verify scripts/verify-os-image-secrets.mjs passes with 0 violations.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-erofs-secret-gate-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const rootfs = path.join(tmp, 'rootfs')
  fs.mkdirSync(path.join(rootfs, 'usr', 'local', 'sbin'), { recursive: true })
  fs.mkdirSync(path.join(rootfs, 'usr', 'local', 'bin'), { recursive: true })
  fs.mkdirSync(path.join(rootfs, 'etc', 'ssh'), { recursive: true })
  fs.mkdirSync(path.join(rootfs, 'home', 'kincli', '.claude'), { recursive: true })
  fs.mkdirSync(path.join(rootfs, 'etc', 'claude-code', 'managed-settings.d'), { recursive: true })
  fs.mkdirSync(path.join(rootfs, 'var', 'lib', 'kin-slot'), { recursive: true })
  fs.mkdirSync(path.join(rootfs, 'run', 'kin'), { recursive: true })
  fs.mkdirSync(path.join(rootfs, 'run', 'sshd'), { recursive: true })
  fs.mkdirSync(path.join(rootfs, 'run', 'vm2api-crag'), { recursive: true })
  fs.copyFileSync(GUEST_INIT, path.join(rootfs, 'usr', 'local', 'sbin', 'kin-guest-init'))
  fs.copyFileSync(SLOT_AGENT, path.join(rootfs, 'usr', 'local', 'sbin', 'kin-slot-agent'))
  fs.copyFileSync(KERNEL_RELAY, path.join(rootfs, 'usr', 'local', 'sbin', 'kin-kernel-relay'))
  fs.copyFileSync(SSHD_CONFIG, path.join(rootfs, 'etc', 'ssh', 'sshd_config.kin'))
  fs.symlinkSync('/opt/kin/store/claude/current', path.join(rootfs, 'usr', 'local', 'bin', 'claude'))
  fs.symlinkSync('/opt/kin/store/bin/kin-oauth-auth', path.join(rootfs, 'usr', 'local', 'bin', 'kin-oauth-auth'))
  fs.symlinkSync('/opt/kin/store/bin/kin-worker', path.join(rootfs, 'usr', 'local', 'bin', 'kin-worker'))
  fs.copyFileSync(
    path.join(REPO_ROOT, 'docker', 'kin-os', 'debian-13', 'managed-settings.json'),
    path.join(rootfs, 'etc', 'claude-code', 'managed-settings.json'),
  )
  fs.writeFileSync(path.join(rootfs, 'etc', 'machine-id'), '')
  fs.writeFileSync(path.join(rootfs, 'etc', 'resolv.conf'), '')
  fs.writeFileSync(path.join(rootfs, 'etc', 'hosts'), '')

  const scan = scanDirectoryForSecrets(rootfs)
  assert.equal(scan.ok, true, `secret gate failed: ${JSON.stringify(scan.violations)}`)
  assert.deepEqual(scan.violations, [])
})

unixTest(
  'kin-guest-init proc_alive + supervise_crag_once reaps SIGTERM-killed crag-v2 zombie and respawns with updated crag.pid',
  (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-guest-init-supervise-'))
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

    const runKin = path.join(tmp, 'run-kin')
    const storeDir = path.join(tmp, 'store')
    const cragDir = path.join(storeDir, 'crag', 'current')
    const fakeBin = path.join(tmp, 'fake-bin')
    fs.mkdirSync(runKin, { recursive: true })
    fs.mkdirSync(cragDir, { recursive: true })
    fs.mkdirSync(fakeBin, { recursive: true })
    fs.writeFileSync(path.join(runKin, 'kernel.json'), '{"rev":1}\n')

    // Pass-through setpriv shim so unprivileged test can run supervise_crag_once directly under /bin/sh.
    const fakeSetpriv = path.join(fakeBin, 'setpriv')
    fs.writeFileSync(
      fakeSetpriv,
      '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--" ]; then shift; break; fi\n  shift\ndone\nexec "$@"\n',
      { mode: 0o755 },
    )
    const stubCrag = path.join(cragDir, 'crag-v2')
    fs.writeFileSync(stubCrag, '#!/bin/sh\ntrap "exit 0" TERM\nwhile :; do sleep 1; done\n', { mode: 0o755 })

    // Extract function definitions from kin-guest-init (everything before trap/main execution).
    const initSrc = fs.readFileSync(GUEST_INIT, 'utf8')
    const markerIdx = initSrc.indexOf('\ntrap shutdown_guest ')
    assert.ok(markerIdx > 0, 'kin-guest-init missing main trap marker')
    const libPath = path.join(tmp, 'init-lib.sh')
    fs.writeFileSync(libPath, initSrc.slice(0, markerIdx + 1))

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
        KIN_TZ="UTC"
        LANG="C.UTF-8"
        KINCLI_UID="$(id -u)"
        KINCLI_GID="$(id -g)"
        CRAG_PID=""
        supervise_crag_once
        pid1="$(cat "$RUN_KIN/crag.pid")"
        test -n "$pid1"
        proc_alive "$pid1"
        kill -TERM "$pid1"
        # Wait briefly so pid1 exits (possibly becoming a zombie under /bin/sh).
        i=0
        while [ "$i" -lt 30 ]; do
          if ! proc_alive "$pid1"; then
            break
          fi
          sleep 0.05 2>/dev/null || sleep 1
          i=$((i + 1))
        done
        # Re-run supervise_crag_once (as main loop does) after updating kernel.json.
        printf '{"rev":2}\\n' > "$RUN_KIN/kernel.json"
        supervise_crag_once
        pid2="$(cat "$RUN_KIN/crag.pid")"
        test -n "$pid2"
        test "$pid1" != "$pid2"
        proc_alive "$pid2"
        kill -TERM "$pid2" 2>/dev/null || true
        wait "$pid2" 2>/dev/null || true
        printf '%s %s\\n' "$pid1" "$pid2"
        `,
        '--',
        libPath,
        fakeBin,
        runKin,
        storeDir,
      ],
      { encoding: 'utf8' },
    )
    const [pid1, pid2] = out.trim().split(/\s+/)
    assert.ok(Number(pid1) > 1 && Number(pid2) > 1 && pid1 !== pid2)
  },
)
