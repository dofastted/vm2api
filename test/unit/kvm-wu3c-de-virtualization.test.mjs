import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CUSTOM_OS_CUSTOM_INITRD_FILENAME,
  CUSTOM_OS_CUSTOM_KERNEL_FILENAME,
  KVM_KERNEL_TRACK_CUSTOM,
  KVM_KERNEL_TRACK_OFFICIAL,
  detectHostCpuVendor,
  normalizeKvmKernelTrack,
  resolveKvmKernelAssets,
  resolveKvmKernelTrack,
  verifyKvmKernelTrackFiles,
} from '../../src/lib/vm/custom-os-runtime.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const KVM_DIR = path.join(REPO_ROOT, 'docker', 'kin-kvm')
const LOAD_HW_PLAN = path.join(KVM_DIR, 'load-hw-plan.sh')
const KVM_ENTRY = path.join(KVM_DIR, 'kin-kvm-entry')

const SAMPLE_UUID = '4d2a1b3c-5e6f-4789-9abc-def012345678'
const SAMPLE_SMBIOS_ARGS = [
  '-uuid',
  SAMPLE_UUID,
  '-smbios',
  'type=0,vendor=LENOVO,version=N3QET45W,date=04/18/2024,release=1.45,uefi=on',
  '-smbios',
  `type=1,manufacturer=LENOVO,product=21CF003WUS,version=ThinkPad T14 Gen 3,serial=PF4A9123,uuid=${SAMPLE_UUID},sku=LENOVO_MT_21CF,family=ThinkPad T14 Gen 3`,
  '',
].join('\n')

const unixTest = process.platform === 'win32' ? test.skip : test

function runLoadHwPlan(tmp, hwDoc, extraEnv = {}, identityDoc = null) {
  const hwPath = path.join(tmp, 'hardware.json')
  fs.writeFileSync(hwPath, JSON.stringify(hwDoc, null, 2))
  const idPath = path.join(tmp, 'identity.json')
  if (identityDoc) {
    fs.writeFileSync(idPath, JSON.stringify(identityDoc, null, 2))
  } else if (fs.existsSync(idPath)) {
    fs.rmSync(idPath)
  }
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
      KIN_KVM_ACPI_OEM_ID=""
      KIN_KVM_ACPI_OEM_TABLE_ID=""
      load_hw_plan "$2"
      python3 - "$CPU_MODEL" "$KIN_KVM_ACPI_OEM_ID" "$KIN_KVM_ACPI_OEM_TABLE_ID" "$not_applied" <<'PY'
import json, sys
print(json.dumps({
    "cpu": sys.argv[1],
    "acpi_oem_id": sys.argv[2],
    "acpi_oem_table_id": sys.argv[3],
    "not_applied": sys.argv[4],
}))
PY
      `,
      '--',
      LOAD_HW_PLAN,
      hwPath,
    ],
    { encoding: 'utf8', env: { ...process.env, ...extraEnv } },
  )
  return JSON.parse(out.trim())
}

function runCustomErofsDryRun(
  tmp,
  { hwDoc, identityDoc = null, systemEtc = {}, extraEnv = {}, expectSuccess = true } = {},
) {
  const slotKvm = path.join(tmp, 'slot-kvm')
  const slotRun = path.join(tmp, 'slot-run')
  const slotHome = path.join(tmp, 'slot-home')
  const fpDir = path.join(slotKvm, 'fingerprint')
  const sysEtcDir = path.join(fpDir, 'system', 'etc')
  const optKvm = path.join(tmp, 'opt-kvm')
  const storeDir = path.join(tmp, 'store')
  const fakeBin = path.join(tmp, 'fake-bin')
  fs.mkdirSync(path.join(sysEtcDir, 'claude-code', 'managed-settings.d'), { recursive: true })
  fs.mkdirSync(optKvm, { recursive: true })
  fs.mkdirSync(storeDir, { recursive: true })
  fs.mkdirSync(fakeBin, { recursive: true })

  fs.writeFileSync(path.join(fpDir, 'qemu-smbios.args'), SAMPLE_SMBIOS_ARGS)
  if (hwDoc !== undefined) {
    fs.writeFileSync(path.join(fpDir, 'hardware.json'), JSON.stringify(hwDoc, null, 2))
  }
  if (identityDoc) {
    fs.writeFileSync(path.join(fpDir, 'identity.json'), JSON.stringify(identityDoc, null, 2))
  }
  for (const [rel, content] of Object.entries(systemEtc)) {
    const dest = path.join(sysEtcDir, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, content)
  }

  const fakeVirtiofsd = path.join(fakeBin, 'virtiofsd')
  fs.writeFileSync(fakeVirtiofsd, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

  const env = {
    ...process.env,
    PATH: `/usr/sbin:/sbin:${process.env.PATH || '/usr/bin:/bin'}`,
    KIN_KVM_DRY_RUN: '1',
    KIN_KVM_MODE: 'custom-erofs',
    KIN_KVM_OPT_DIR: optKvm,
    KIN_KVM_SLOT_KVM: slotKvm,
    KIN_KVM_SLOT_RUN: slotRun,
    KIN_KVM_SLOT_HOME: slotHome,
    KIN_KVM_LOAD_HW_PLAN: LOAD_HW_PLAN,
    KIN_KVM_SMBIOS_ARGS_FILE: path.join(fpDir, 'qemu-smbios.args'),
    KIN_KVM_HW_PLAN_FILE: path.join(fpDir, 'hardware.json'),
    KIN_KVM_IDENTITY_FILE: path.join(fpDir, 'identity.json'),
    KIN_KVM_SYSTEM_ETC_DIR: sysEtcDir,
    KIN_KVM_STORE_DIR: storeDir,
    KIN_KVM_VIRTIOFSD_BIN: fakeVirtiofsd,
    KIN_KVM_STORE_MODE: 'auto',
    KIN_KVM_VSOCK_CID: '1042',
    KIN_KVM_DRY_RUN_VSOCK: '1',
    KIN_VM_ID: 'vm-wu3c-01',
    KIN_KVM_UID: '1000',
    KIN_KVM_GID: '1000',
    KIN_KVM_MEMORY_MB: '2048',
    KIN_KVM_VCPUS: '2',
    KIN_KVM_DISK_GB: '20',
    KIN_KVM_CPU_MODEL: 'host',
    KIN_KVM_MAC: '98:fa:9b:11:22:33',
    KIN_KVM_DISK_SERIAL: 'S649NX0T04123456',
    KIN_KVM_HOSTNAME: 'thinkpad-t14-01',
    KIN_KVM_MACHINE_ID: '0123456789abcdef0123456789abcdef',
    KIN_KVM_ACCEL: 'kvm',
    KIN_KVM_HOST_CPU_VENDOR: 'amd',
    KIN_AGENT_TOKEN: 'b'.repeat(64),
    TZ: 'America/New_York',
    LANG: 'en_US.UTF-8',
    ...extraEnv,
  }
  const res = spawnSync('/bin/bash', [KVM_ENTRY], { env, encoding: 'utf8' })
  if (expectSuccess) {
    assert.equal(res.status, 0, `kin-kvm-entry dry-run failed:\n${res.stderr}`)
    return { plan: JSON.parse(res.stdout.trim()), stderr: res.stderr, optKvm, slotKvm }
  }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, optKvm, slotKvm }
}

test('custom-os-runtime kernel track resolution, remote pinning, fail-closed verify, and host CPU vendor detection', (t) => {
  assert.equal(normalizeKvmKernelTrack('custom'), KVM_KERNEL_TRACK_CUSTOM)
  assert.equal(normalizeKvmKernelTrack('OFFICIAL'), KVM_KERNEL_TRACK_OFFICIAL)
  assert.equal(normalizeKvmKernelTrack('bogus'), '')

  assert.equal(resolveKvmKernelTrack({ env: {} }), KVM_KERNEL_TRACK_OFFICIAL)
  assert.equal(resolveKvmKernelTrack({ env: { KIN_KVM_KERNEL_TRACK: 'custom' } }), KVM_KERNEL_TRACK_CUSTOM)
  assert.equal(resolveKvmKernelTrack({ vm: { kernel_track: 'custom' }, env: {} }), KVM_KERNEL_TRACK_CUSTOM)
  assert.equal(resolveKvmKernelTrack({ vm: { runtime: { kernel_track: 'custom' } }, env: {} }), KVM_KERNEL_TRACK_CUSTOM)
  assert.equal(
    resolveKvmKernelTrack({
      vm: { kernel_track: 'custom', runtime: { kernel_track: 'official' } },
      env: {},
    }),
    KVM_KERNEL_TRACK_OFFICIAL,
  )
  // Remote KVM slots stay pinned to official track even if local env or vm record requests custom.
  assert.equal(
    resolveKvmKernelTrack({
      vm: { node_id: 'node-remote-1', kernel_track: 'custom' },
      env: { KIN_KVM_KERNEL_TRACK: 'custom' },
    }),
    KVM_KERNEL_TRACK_OFFICIAL,
  )
  assert.equal(resolveKvmKernelTrack({ isRemote: true, kernelTrack: 'custom' }), KVM_KERNEL_TRACK_OFFICIAL)

  const offAssets = resolveKvmKernelAssets('/opt/kin-os/crag-debian13', { env: {} })
  assert.equal(offAssets.track, 'official')
  assert.equal(offAssets.kernelPath, '/opt/kin-os/crag-debian13/vmlinuz')
  assert.equal(offAssets.initrdPath, '/opt/kin-os/crag-debian13/initrd.img')

  const custAssets = resolveKvmKernelAssets('/opt/kin-os/crag-debian13', { env: { KIN_KVM_KERNEL_TRACK: 'custom' } })
  assert.equal(custAssets.track, 'custom')
  assert.equal(custAssets.kernelFilename, CUSTOM_OS_CUSTOM_KERNEL_FILENAME)
  assert.equal(custAssets.initrdFilename, CUSTOM_OS_CUSTOM_INITRD_FILENAME)
  assert.equal(custAssets.kernelPath, '/opt/kin-os/crag-debian13/vmlinuz-custom')
  assert.equal(custAssets.initrdPath, '/opt/kin-os/crag-debian13/initrd.img-custom')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-ktrack-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  assert.equal(verifyKvmKernelTrackFiles(dir, { env: {} }).ok, true)
  const missing = verifyKvmKernelTrackFiles(dir, { env: { KIN_KVM_KERNEL_TRACK: 'custom' } })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'kvm_custom_kernel_missing')

  fs.writeFileSync(path.join(dir, 'vmlinuz-custom'), 'stub-kernel')
  fs.writeFileSync(path.join(dir, 'initrd.img-custom'), '')
  const emptyInitrd = verifyKvmKernelTrackFiles(dir, { env: { KIN_KVM_KERNEL_TRACK: 'custom' } })
  assert.equal(emptyInitrd.ok, false)
  assert.equal(emptyInitrd.code, 'kvm_custom_kernel_invalid')

  fs.writeFileSync(path.join(dir, 'initrd.img-custom'), 'stub-initrd')
  assert.equal(verifyKvmKernelTrackFiles(dir, { env: { KIN_KVM_KERNEL_TRACK: 'custom' } }).ok, true)

  assert.equal(detectHostCpuVendor({ env: { KIN_KVM_HOST_CPU_VENDOR: 'amd' } }), 'amd')
  assert.equal(detectHostCpuVendor({ env: { KIN_KVM_HOST_CPU_VENDOR: 'GenuineIntel' } }), 'intel')
  assert.equal(detectHostCpuVendor({ env: {}, readFileSync: () => 'vendor_id\t: AuthenticAMD\n' }), 'amd')
  assert.equal(detectHostCpuVendor({ env: {}, readFileSync: () => 'vendor_id\t: GenuineIntel\n' }), 'intel')
  assert.equal(
    detectHostCpuVendor({
      env: {},
      readFileSync: () => {
        throw new Error('ENOENT')
      },
    }),
    'any',
  )
})

unixTest(
  'load-hw-plan.sh enforces host-vendor CPUID, cross-vendor guard, TCG branch, comma escaping, and ACPI OEM',
  (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wu3c-hw-'))
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

    // 1. AMD host + AMD profile -> clean AuthenticAMD + -svm + model-id + ACPI OEM
    const amdMatch = runLoadHwPlan(
      tmp,
      {
        cpu_vendor: 'AuthenticAMD',
        cpu_model_id: 'AMD Ryzen 7 PRO 6850U with Radeon Graphics',
        cpu_family: 25,
        cpu_model: 68,
        cpu_stepping: 1,
        acpi_oem_id: 'LENOVO',
        acpi_oem_table_id: 'TP-N3Q',
      },
      { KIN_KVM_ACCEL: 'kvm', KIN_KVM_HOST_CPU_VENDOR: 'amd' },
    )
    assert.equal(
      amdMatch.cpu,
      'max,kvm=off,-hypervisor,-svm,family=25,model=68,stepping=1,model-id=AMD Ryzen 7 PRO 6850U with Radeon Graphics',
    )
    assert.equal(amdMatch.acpi_oem_id, 'LENOVO')
    assert.equal(amdMatch.acpi_oem_table_id, 'TP-N3Q')
    assert.doesNotMatch(amdMatch.not_applied, /cross_vendor_cpu/)

    // 2. Intel host + Intel profile -> clean GenuineIntel + -vmx + model-id
    const intelMatch = runLoadHwPlan(
      tmp,
      {
        cpu_vendor: 'GenuineIntel',
        cpu_model_id: '13th Gen Intel(R) Core(TM) i7-13700K',
        cpu_family: 6,
        cpu_model: 183,
        cpu_stepping: 1,
        acpi_oem_id: 'DELL',
        acpi_oem_table_id: 'CBX3',
      },
      { KIN_KVM_ACCEL: 'kvm', KIN_KVM_HOST_CPU_VENDOR: 'intel' },
    )
    assert.equal(
      intelMatch.cpu,
      'max,kvm=off,-hypervisor,-vmx,family=6,model=183,stepping=1,model-id=13th Gen Intel(R) Core(TM) i7-13700K',
    )
    assert.equal(intelMatch.acpi_oem_id, 'DELL')
    assert.equal(intelMatch.acpi_oem_table_id, 'CBX3')
    assert.doesNotMatch(intelMatch.not_applied, /cross_vendor_cpu/)

    // 3. Cross-vendor guard: AMD host + Intel profile MUST NOT emit Intel family=6/model=183 or Intel model-id
    const amdCross = runLoadHwPlan(
      tmp,
      {
        cpu_vendor: 'GenuineIntel',
        cpu_model_id: '13th Gen Intel(R) Core(TM) i7-13700K',
        cpu_family: 6,
        cpu_model: 183,
        cpu_stepping: 1,
      },
      { KIN_KVM_ACCEL: 'kvm', KIN_KVM_HOST_CPU_VENDOR: 'amd' },
    )
    assert.equal(amdCross.cpu, 'max,kvm=off,-hypervisor,-svm,model-id=AMD Ryzen 7 5800X 8-Core Processor')
    assert.match(amdCross.not_applied, /\bcross_vendor_cpu\b/)
    assert.doesNotMatch(amdCross.cpu, /family=6|GenuineIntel|Intel/)

    // 4. Cross-vendor guard: Intel host + AMD profile MUST NOT emit AMD family=25 or Ryzen model-id
    const intelCross = runLoadHwPlan(
      tmp,
      {
        cpu_vendor: 'AuthenticAMD',
        cpu_model_id: 'AMD Ryzen 5 5600X 6-Core Processor',
        cpu_family: 25,
        cpu_model: 33,
        cpu_stepping: 0,
      },
      { KIN_KVM_ACCEL: 'kvm', KIN_KVM_HOST_CPU_VENDOR: 'intel' },
    )
    assert.equal(intelCross.cpu, 'max,kvm=off,-hypervisor,-vmx,model-id=12th Gen Intel(R) Core(TM) i7-12700')
    assert.match(intelCross.not_applied, /\bcross_vendor_cpu\b/)
    assert.doesNotMatch(intelCross.cpu, /family=25|AuthenticAMD|Ryzen/)

    // 5. TCG branch: no kvm=off, honors target vendor + family/model/stepping/model-id even on AMD host
    const tcgPlan = runLoadHwPlan(
      tmp,
      {
        cpu_vendor: 'GenuineIntel',
        cpu_model_id: '13th Gen Intel(R) Core(TM) i7-13700K',
        cpu_family: 6,
        cpu_model: 183,
        cpu_stepping: 1,
      },
      { KIN_KVM_ACCEL: 'tcg', KIN_KVM_HOST_CPU_VENDOR: 'amd' },
    )
    assert.equal(
      tcgPlan.cpu,
      'max,-hypervisor,vendor=GenuineIntel,family=6,model=183,stepping=1,model-id=13th Gen Intel(R) Core(TM) i7-13700K',
    )
    assert.doesNotMatch(tcgPlan.cpu, /kvm=off/)

    // 6. Comma escaping in model-id + zero eval injection + ACPI rejection on comma/equals
    const pwnMarker = path.join(tmp, 'pwn-marker')
    const commaPlan = runLoadHwPlan(
      tmp,
      {
        cpu_vendor: 'AuthenticAMD',
        cpu_model_id: `AMD Ryzen 7, Pro $(touch ${pwnMarker})`,
        cpu_family: 25,
        cpu_model: 68,
        cpu_stepping: 1,
        acpi_oem_id: 'BAD,ID',
        acpi_oem_table_id: 'BAD=TAB',
      },
      { KIN_KVM_ACCEL: 'kvm', KIN_KVM_HOST_CPU_VENDOR: 'amd' },
    )
    assert.match(commaPlan.cpu, /model-id=AMD Ryzen 7,, Pro/)
    assert.equal(commaPlan.acpi_oem_id, '')
    assert.equal(commaPlan.acpi_oem_table_id, '')
    assert.equal(fs.existsSync(pwnMarker), false)
  },
)

unixTest(
  'kin-kvm-entry scrubs /proc/cmdline kin.*, injects ACPI OEM, and idempotently syncs boot.env & etc-override across 2 boots via e2fsck/debugfs',
  (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wu3c-entry-'))
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

    const hwDoc = {
      cpu_vendor: 'AuthenticAMD',
      cpu_model_id: 'AMD Ryzen 7 PRO 6850U with Radeon Graphics',
      cpu_family: 25,
      cpu_model: 68,
      cpu_stepping: 1,
      logical_cpus: 4,
      ram_mb: 2048,
      en0_mac: '98:fa:9b:aa:bb:cc',
      disk_serial: 'S649NX0T04123456',
      acpi_oem_id: 'LENOVO',
      acpi_oem_table_id: 'TP-N3Q',
    }
    const identityDoc = {
      username: 'mchen',
      kernel_profile: {
        release: '6.8.0-51-generic',
        version: '#52-Ubuntu SMP PREEMPT_DYNAMIC Thu Dec 5 13:09:44 UTC 2024',
        proc_mid: '(buildd@lcy02-amd64-042) (x86_64-linux-gnu-gcc-13 13.3.0)',
      },
    }

    // Boot 1: fresh slot-state.ext4 + random slot user mchen (1000:1000)
    const boot1 = runCustomErofsDryRun(tmp, {
      hwDoc,
      identityDoc,
      systemEtc: {
        'os-release': 'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.2 LTS"\n',
        localtime: 'TZif2-boot1-nyc',
        timezone: 'America/New_York\n',
        'claude-code/managed-settings.d/10-slot-preset.json': '{"env":{"TZ":"America/New_York"}}\n',
      },
      extraEnv: {
        KIN_SLOT_USER: 'mchen',
        KIN_SLOT_UID: '1000',
        KIN_SLOT_GID: '1000',
        TZ: 'America/New_York',
        LANG: 'en_US.UTF-8',
      },
    })

    const { plan: p1 } = boot1
    assert.equal(p1.boot_env_synced, true)
    assert.equal(p1.kernel_track, 'official')
    assert.equal(p1.slot_user, 'mchen')
    assert.equal(p1.slot_uid, 1000)
    assert.equal(p1.slot_gid, 1000)
    assert.equal(p1.acpi_oem_id, 'LENOVO')
    assert.equal(p1.acpi_oem_table_id, 'TP-N3Q')

    const machIdx = p1.qemu.indexOf('-machine')
    assert.equal(p1.qemu[machIdx + 1], 'q35,mem-merge=off,vmport=off,x-oem-id=LENOVO,x-oem-table-id=TP-N3Q')
    const cpuIdx = p1.qemu.indexOf('-cpu')
    assert.equal(
      p1.qemu[cpuIdx + 1],
      'max,kvm=off,-hypervisor,-svm,family=25,model=68,stepping=1,model-id=AMD Ryzen 7 PRO 6850U with Radeon Graphics',
    )
    const appendIdx = p1.qemu.indexOf('-append')
    const cmdline = p1.qemu[appendIdx + 1]
    assert.doesNotMatch(cmdline, /\bkin\.[a-z_]+=/, `cmdline leaked kin.* parameter: ${cmdline}`)
    assert.match(
      cmdline,
      /rootfstype=erofs ro init=\/usr\/local\/sbin\/kin-guest-init net\.ifnames=0 biosdevname=0 quiet/,
    )

    // Verify slot-state.ext4 contents via debugfs & e2fsck
    const envPath = { ...process.env, PATH: `/usr/sbin:/sbin:${process.env.PATH || '/usr/bin:/bin'}` }
    const bootEnv1 = execFileSync('debugfs', ['-R', 'cat /boot.env', p1.state_disk], {
      encoding: 'utf8',
      env: envPath,
    })
    for (const expectedLine of [
      'KIN_VM_ID=vm-wu3c-01',
      'KIN_HOSTNAME=thinkpad-t14-01',
      'KIN_STORE_MODE=virtiofs',
      'KIN_AGENT_TRANSPORT=vsock',
      'KIN_VSOCK_PORT=7070',
      'KIN_AGENT_VSOCK_PORT=7071',
      'KIN_TZ=America/New_York',
      'KIN_LANG=en_US.UTF-8',
      'KIN_SLOT_USER=mchen',
      'KIN_SLOT_UID=1000',
      'KIN_SLOT_GID=1000',
      'KIN_KERNEL_RELEASE=6.8.0-51-generic',
      'KIN_KERNEL_VERSION=#52-Ubuntu SMP PREEMPT_DYNAMIC Thu Dec 5 13:09:44 UTC 2024',
      'KIN_KERNEL_PROC_MID=(buildd@lcy02-amd64-042) (x86_64-linux-gnu-gcc-13 13.3.0)',
    ]) {
      assert.ok(bootEnv1.split('\n').includes(expectedLine), `missing line in /boot.env: ${expectedLine}\n${bootEnv1}`)
    }
    const statBoot = execFileSync('debugfs', ['-R', 'stat /boot.env', p1.state_disk], {
      encoding: 'utf8',
      env: envPath,
    })
    assert.match(statBoot, /Type: regular\s+Mode:\s+0600/)
    assert.match(statBoot, /User:\s+0\s+Group:\s+0/)

    const osRel1 = execFileSync('debugfs', ['-R', 'cat /etc-override/os-release', p1.state_disk], {
      encoding: 'utf8',
      env: envPath,
    })
    assert.match(osRel1, /ID=ubuntu/)
    const lt1 = execFileSync('debugfs', ['-R', 'cat /etc-override/localtime', p1.state_disk], {
      encoding: 'utf8',
      env: envPath,
    })
    assert.equal(lt1, 'TZif2-boot1-nyc')
    const statOsRel = execFileSync('debugfs', ['-R', 'stat /etc-override/os-release', p1.state_disk], {
      encoding: 'utf8',
      env: envPath,
    })
    assert.match(statOsRel, /Type: regular\s+Mode:\s+0644/)

    // Boot 2 on the SAME slot-state.ext4: proves debugfs rm-then-write idempotency (no Ext2 file already exists)!
    const boot2 = runCustomErofsDryRun(tmp, {
      hwDoc,
      identityDoc,
      systemEtc: {
        'os-release': 'ID=debian\nVERSION_ID="13"\n',
        localtime: 'TZif2-boot2-tokyo',
        timezone: 'Asia/Tokyo\n',
        'claude-code/managed-settings.d/10-slot-preset.json': '{"env":{"TZ":"Asia/Tokyo"}}\n',
      },
      extraEnv: {
        KIN_SLOT_USER: 'mchen',
        KIN_SLOT_UID: '1000',
        KIN_SLOT_GID: '1000',
        KIN_KVM_FORCE_SERIAL: '1',
        TZ: 'Asia/Tokyo',
        LANG: 'ja_JP.UTF-8',
      },
    })

    const { plan: p2 } = boot2
    assert.equal(p2.transport, 'virtio-serial')
    const bootEnv2 = execFileSync('debugfs', ['-R', 'cat /boot.env', p2.state_disk], {
      encoding: 'utf8',
      env: envPath,
    })
    assert.ok(bootEnv2.split('\n').includes('KIN_TZ=Asia/Tokyo'))
    assert.ok(bootEnv2.split('\n').includes('KIN_LANG=ja_JP.UTF-8'))
    assert.ok(bootEnv2.split('\n').includes('KIN_AGENT_TRANSPORT=virtio-serial'))
    assert.equal(
      execFileSync('debugfs', ['-R', 'cat /etc-override/os-release', p2.state_disk], {
        encoding: 'utf8',
        env: envPath,
      }),
      'ID=debian\nVERSION_ID="13"\n',
    )
    assert.equal(
      execFileSync('debugfs', ['-R', 'cat /etc-override/localtime', p2.state_disk], {
        encoding: 'utf8',
        env: envPath,
      }),
      'TZif2-boot2-tokyo',
    )
    assert.equal(
      execFileSync('debugfs', ['-R', 'cat /managed-settings.d/10-slot-preset.json', p2.state_disk], {
        encoding: 'utf8',
        env: envPath,
      }),
      '{"env":{"TZ":"Asia/Tokyo"}}\n',
    )

    // Filesystem integrity must be 100% clean after multi-boot debugfs mutations.
    const fsck = spawnSync('e2fsck', ['-fn', p2.state_disk], { encoding: 'utf8', env: envPath })
    assert.equal(fsck.status, 0, `e2fsck -fn failed:\n${fsck.stdout}\n${fsck.stderr}`)
  },
)

unixTest('kin-kvm-entry defaults legacy kincli (999:987) and fails closed on missing custom kernel track', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wu3c-track-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

  // Legacy kincli defaults when KIN_SLOT_* omitted
  const legacy = runCustomErofsDryRun(tmp, {
    hwDoc: { cpu_vendor: 'AuthenticAMD', cpu_family: 25, cpu_model: 33, cpu_stepping: 0 },
  })
  assert.equal(legacy.plan.slot_user, 'kincli')
  assert.equal(legacy.plan.slot_uid, 999)
  assert.equal(legacy.plan.slot_gid, 987)
  assert.equal(legacy.plan.kernel_track, 'official')
  assert.equal(legacy.plan.qemu[legacy.plan.qemu.indexOf('-kernel') + 1], path.join(legacy.optKvm, 'vmlinuz'))

  // KIN_KVM_KERNEL_TRACK=custom fails closed when vmlinuz-custom / initrd.img-custom missing
  const missingCustom = runCustomErofsDryRun(tmp, {
    hwDoc: { cpu_vendor: 'AuthenticAMD', cpu_family: 25, cpu_model: 33, cpu_stepping: 0 },
    extraEnv: { KIN_KVM_KERNEL_TRACK: 'custom' },
    expectSuccess: false,
  })
  assert.notEqual(missingCustom.status, 0)
  assert.match(missingCustom.stderr, /vmlinuz-custom/)

  // Once both custom artifacts exist, track=custom selects them cleanly
  fs.writeFileSync(path.join(missingCustom.optKvm, 'vmlinuz-custom'), 'stub-custom-vmlinuz')
  const missingInitrd = runCustomErofsDryRun(tmp, {
    hwDoc: { cpu_vendor: 'AuthenticAMD', cpu_family: 25, cpu_model: 33, cpu_stepping: 0 },
    extraEnv: { KIN_KVM_KERNEL_TRACK: 'custom' },
    expectSuccess: false,
  })
  assert.notEqual(missingInitrd.status, 0)
  assert.match(missingInitrd.stderr, /initrd\.img-custom/)

  fs.writeFileSync(path.join(missingCustom.optKvm, 'initrd.img-custom'), 'stub-custom-initrd')
  const customOk = runCustomErofsDryRun(tmp, {
    hwDoc: { cpu_vendor: 'AuthenticAMD', cpu_family: 25, cpu_model: 33, cpu_stepping: 0 },
    extraEnv: { KIN_KVM_KERNEL_TRACK: 'custom' },
  })
  assert.equal(customOk.plan.kernel_track, 'custom')
  assert.equal(
    customOk.plan.qemu[customOk.plan.qemu.indexOf('-kernel') + 1],
    path.join(customOk.optKvm, 'vmlinuz-custom'),
  )
  assert.equal(
    customOk.plan.qemu[customOk.plan.qemu.indexOf('-initrd') + 1],
    path.join(customOk.optKvm, 'initrd.img-custom'),
  )

  // Instant rollback back to official track
  const rolledBack = runCustomErofsDryRun(tmp, {
    hwDoc: { cpu_vendor: 'AuthenticAMD', cpu_family: 25, cpu_model: 33, cpu_stepping: 0 },
    extraEnv: { KIN_KVM_KERNEL_TRACK: 'official' },
  })
  assert.equal(rolledBack.plan.kernel_track, 'official')
  assert.equal(
    rolledBack.plan.qemu[rolledBack.plan.qemu.indexOf('-kernel') + 1],
    path.join(rolledBack.optKvm, 'vmlinuz'),
  )
})
