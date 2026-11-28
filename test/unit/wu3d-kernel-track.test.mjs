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
import {
  CRAG_DEBIAN13_ASSETS,
  CRAG_DEBIAN13_CUSTOM_KERNEL_ASSETS,
  cragDebian13CustomKernelFiles,
  cragDebian13Files,
  isCragDebian13CustomKernelPinned,
} from '../../scripts/fetch-payload.mjs'

const execFileAsync = promisify(execFile)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const KVM_DIR = path.join(REPO_ROOT, 'docker', 'kin-kvm')
const LOAD_HW_PLAN = path.join(KVM_DIR, 'load-hw-plan.sh')
const KVM_ENTRY = path.join(KVM_DIR, 'kin-kvm-entry')
const FETCH_PAYLOAD_SCRIPT = path.join(REPO_ROOT, 'scripts', 'fetch-payload.mjs')
const GUEST_IMAGES_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'guest-images.yml')

const unixTest = process.platform === 'win32' ? test.skip : test
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

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

function runKvmEntryDryRun(tmp, extraEnv = {}) {
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
  fs.writeFileSync(
    path.join(fpDir, 'hardware.json'),
    JSON.stringify({
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
    }),
  )
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
    KIN_VM_ID: 'vm-wu3d-01',
    KIN_SLOT_USER: 'mchen84',
    KIN_SLOT_UID: '1000',
    KIN_SLOT_GID: '1000',
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
    KIN_AGENT_TOKEN: 'c'.repeat(64),
    TZ: 'Asia/Tokyo',
    LANG: 'en_US.UTF-8',
    ...extraEnv,
  }
  const res = spawnSync('/bin/bash', [KVM_ENTRY], { env, encoding: 'utf8' })
  assert.equal(res.status, 0, `kin-kvm-entry dry-run failed:\n${res.stderr}`)
  return { plan: JSON.parse(res.stdout.trim()), optKvm }
}

unixTest(
  'kin-kvm-entry omits init= on custom kernel track for zero-kin /proc/cmdline and keeps init= on official track',
  (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wu3d-cmdline-'))
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

    // Official track keeps explicit init=/usr/local/sbin/kin-guest-init unchanged.
    const official = runKvmEntryDryRun(tmp, { KIN_KVM_KERNEL_TRACK: 'official' })
    const officialCmdline = official.plan.qemu[official.plan.qemu.indexOf('-append') + 1]
    assert.equal(official.plan.kernel_track, 'official')
    assert.equal(
      officialCmdline,
      'console=ttyS0 root=/dev/vda rootfstype=erofs ro init=/usr/local/sbin/kin-guest-init net.ifnames=0 biosdevname=0 quiet',
    )

    // Custom track uses initrd.img-custom /conf/conf.d/99-kin-init and emits ZERO "kin" substrings in /proc/cmdline.
    fs.writeFileSync(path.join(official.optKvm, 'vmlinuz-custom'), 'stub-custom-vmlinuz')
    fs.writeFileSync(path.join(official.optKvm, 'initrd.img-custom'), 'stub-custom-initrd')
    const custom = runKvmEntryDryRun(tmp, { KIN_KVM_KERNEL_TRACK: 'custom' })
    const customCmdline = custom.plan.qemu[custom.plan.qemu.indexOf('-append') + 1]
    assert.equal(custom.plan.kernel_track, 'custom')
    assert.equal(customCmdline, 'console=ttyS0 root=/dev/vda rootfstype=erofs ro net.ifnames=0 biosdevname=0 quiet')
    assert.doesNotMatch(
      customCmdline,
      /kin/i,
      `custom track cmdline must contain zero "kin" substrings: ${customCmdline}`,
    )
    assert.doesNotMatch(customCmdline, /\binit=/, `custom track cmdline must omit init=: ${customCmdline}`)
    assert.equal(
      custom.plan.qemu[custom.plan.qemu.indexOf('-kernel') + 1],
      path.join(official.optKvm, 'vmlinuz-custom'),
    )
    assert.equal(
      custom.plan.qemu[custom.plan.qemu.indexOf('-initrd') + 1],
      path.join(official.optKvm, 'initrd.img-custom'),
    )

    // Instant rollback to official track restores explicit init= and official kernel assets.
    const rollback = runKvmEntryDryRun(tmp, { KIN_KVM_KERNEL_TRACK: 'official' })
    const rollbackCmdline = rollback.plan.qemu[rollback.plan.qemu.indexOf('-append') + 1]
    assert.match(rollbackCmdline, /\binit=\/usr\/local\/sbin\/kin-guest-init\b/)
    assert.equal(rollback.plan.qemu[rollback.plan.qemu.indexOf('-kernel') + 1], path.join(official.optKvm, 'vmlinuz'))
  },
)

test('fetch-payload.mjs silently skips undeclared custom_kernel and fails closed on invalid partial/tampered custom_kernel', async (t) => {
  const realManifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'deploy', 'payload.json'), 'utf8'))
  if (!isCragDebian13CustomKernelPinned(realManifest)) {
    assert.deepEqual(cragDebian13CustomKernelFiles(realManifest), [])
    assert.equal(cragDebian13Files(realManifest).length, CRAG_DEBIAN13_ASSETS.length)
  }

  const baseAssets = {
    'kin-kvm-debian-13.erofs': { size: 100, sha256: 'a'.repeat(64) },
    vmlinuz: { size: 200, sha256: 'b'.repeat(64) },
    'initrd.img': { size: 300, sha256: 'c'.repeat(64) },
  }

  // Empty custom_kernel object is silently skipped.
  const emptyCustomManifest = {
    crag_debian13_release: { tag: 'os-1', dest_dir: 'share/os/crag-debian13', assets: baseAssets, custom_kernel: {} },
  }
  assert.equal(isCragDebian13CustomKernelPinned(emptyCustomManifest), false)
  assert.deepEqual(cragDebian13CustomKernelFiles(emptyCustomManifest), [])
  assert.equal(cragDebian13Files(emptyCustomManifest).length, 3)

  // Half-declared custom_kernel fails closed.
  assert.throws(
    () =>
      cragDebian13Files({
        crag_debian13_release: {
          tag: 'os-1',
          dest_dir: 'share/os/crag-debian13',
          assets: baseAssets,
          custom_kernel: {
            tag: 'kern-1',
            assets: { 'vmlinuz-custom': { size: 10, sha256: 'd'.repeat(64) } },
          },
        },
      }),
    /initrd\.img-custom/,
  )

  // Invalid sha256 fails closed.
  assert.throws(
    () =>
      cragDebian13Files({
        crag_debian13_release: {
          tag: 'os-1',
          dest_dir: 'share/os/crag-debian13',
          assets: baseAssets,
          custom_kernel: {
            assets: {
              'vmlinuz-custom': { size: 10, sha256: 'not-hex' },
              'initrd.img-custom': { size: 20, sha256: 'e'.repeat(64) },
            },
          },
        },
      }),
    /64-hex sha256/,
  )

  // Non-object custom_kernel fails closed.
  assert.throws(
    () =>
      cragDebian13Files({
        crag_debian13_release: {
          tag: 'os-1',
          dest_dir: 'share/os/crag-debian13',
          assets: baseAssets,
          custom_kernel: 'bad',
        },
      }),
    /custom_kernel must be an object/,
  )

  // Full end-to-end pin + HTTP download + SHA-256 check + tamper fail-closed.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wu3d-payload-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const srcDest = path.join(tmp, 'src')
  const dlDest = path.join(tmp, 'dl')
  const osDir = path.join(srcDest, 'share', 'os', 'crag-debian13')
  fs.mkdirSync(osDir, { recursive: true })

  const basePayloads = {
    'kin-kvm-debian-13.erofs': Buffer.from('erofs-base-bytes'),
    vmlinuz: Buffer.from('official-vmlinuz-bytes'),
    'initrd.img': Buffer.from('official-initrd-bytes'),
  }
  const customPayloads = {
    'vmlinuz-custom': Buffer.from('custom-6.12.118-prctl-vmlinuz-bytes'),
    'initrd.img-custom': Buffer.from('custom-zero-kin-initrd-bytes'),
  }
  for (const [name, bytes] of Object.entries({ ...basePayloads, ...customPayloads })) {
    fs.writeFileSync(path.join(osDir, name), bytes)
  }

  const manifestPath = path.join(tmp, 'payload.json')
  fs.writeFileSync(manifestPath, JSON.stringify({ repo: 'dofastted/vm2api', release: 'r1', files: [] }, null, 2))

  // 1. Pin base OS release and then pin optional custom_kernel under a separate release tag.
  const pinBase = spawnSync(
    process.execPath,
    [FETCH_PAYLOAD_SCRIPT, '--manifest', manifestPath, '--dest', srcDest, '--pin-crag-debian13', 'os-tag-1'],
    { encoding: 'utf8' },
  )
  assert.equal(pinBase.status, 0, pinBase.stderr)

  const pinCustom = spawnSync(
    process.execPath,
    [
      FETCH_PAYLOAD_SCRIPT,
      '--manifest',
      manifestPath,
      '--dest',
      srcDest,
      '--pin-crag-debian13-custom-kernel',
      'kernel-tag-612',
    ],
    { encoding: 'utf8' },
  )
  assert.equal(pinCustom.status, 0, pinCustom.stderr)

  const pinnedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  assert.equal(isCragDebian13CustomKernelPinned(pinnedManifest), true)
  const resolved = cragDebian13Files(pinnedManifest)
  assert.equal(resolved.length, CRAG_DEBIAN13_ASSETS.length + CRAG_DEBIAN13_CUSTOM_KERNEL_ASSETS.length)
  assert.equal(resolved.find((f) => f.asset === 'vmlinuz-custom')?.release, 'kernel-tag-612')
  assert.equal(resolved.find((f) => f.asset === 'initrd.img-custom')?.release, 'kernel-tag-612')
  assert.equal(resolved.find((f) => f.asset === 'vmlinuz')?.release, 'os-tag-1')

  // Re-pinning base crag-debian13 preserves existing custom_kernel section.
  const repinBase = spawnSync(
    process.execPath,
    [FETCH_PAYLOAD_SCRIPT, '--manifest', manifestPath, '--dest', srcDest, '--pin-crag-debian13', 'os-tag-2'],
    { encoding: 'utf8' },
  )
  assert.equal(repinBase.status, 0, repinBase.stderr)
  const repinned = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  assert.equal(repinned.crag_debian13_release.tag, 'os-tag-2')
  assert.equal(repinned.crag_debian13_release.custom_kernel.tag, 'kernel-tag-612')

  // 2. Serve both release tags over local HTTP and verify fetch + SHA-256 verification.
  let corruptCustom = false
  const server = http.createServer((req, res) => {
    const parts = (req.url || '').split('/').filter(Boolean)
    const [tag, assetName] = parts.slice(-2)
    if (tag === 'os-tag-2' && Object.hasOwn(basePayloads, assetName)) {
      res.writeHead(200).end(basePayloads[assetName])
      return
    }
    if (tag === 'kernel-tag-612' && Object.hasOwn(customPayloads, assetName)) {
      const body =
        corruptCustom && assetName === 'vmlinuz-custom' ? Buffer.from('TAMPERED-KERNEL') : customPayloads[assetName]
      res.writeHead(200).end(body)
      return
    }
    res.writeHead(404).end('not found')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  const fetched = await execFileAsync(
    process.execPath,
    [FETCH_PAYLOAD_SCRIPT, '--manifest', manifestPath, '--dest', dlDest, '--crag-debian13'],
    { encoding: 'utf8', env: { ...process.env, VM2API_PAYLOAD_BASE_URL: baseUrl } },
  )
  assert.match(fetched.stdout, /payload ready \(os-tag-2, 5 files\)/)
  for (const [name, bytes] of Object.entries({ ...basePayloads, ...customPayloads })) {
    const outPath = path.join(dlDest, 'share', 'os', 'crag-debian13', name)
    assert.deepEqual(fs.readFileSync(outPath), bytes)
    assert.equal(sha256(fs.readFileSync(outPath)), sha256(bytes))
  }

  // 3. Offline --check passes on clean files, fails closed on 1-byte tamper of vmlinuz-custom.
  const checkOk = spawnSync(
    process.execPath,
    [FETCH_PAYLOAD_SCRIPT, '--manifest', manifestPath, '--dest', dlDest, '--check', '--crag-debian13'],
    { encoding: 'utf8' },
  )
  assert.equal(checkOk.status, 0, checkOk.stderr)

  const customKernelPath = path.join(dlDest, 'share', 'os', 'crag-debian13', 'vmlinuz-custom')
  fs.writeFileSync(customKernelPath, Buffer.from('x'.repeat(customPayloads['vmlinuz-custom'].length)))
  const checkBad = spawnSync(
    process.execPath,
    [FETCH_PAYLOAD_SCRIPT, '--manifest', manifestPath, '--dest', dlDest, '--check', '--crag-debian13'],
    { encoding: 'utf8' },
  )
  assert.notEqual(checkBad.status, 0)
  assert.match(checkBad.stderr, /vmlinuz-custom/)

  // 4. Tampered download fails closed and never writes corrupt bytes into dest.
  const dlBad = path.join(tmp, 'dl-bad')
  corruptCustom = true
  await assert.rejects(
    () =>
      execFileAsync(
        process.execPath,
        [FETCH_PAYLOAD_SCRIPT, '--manifest', manifestPath, '--dest', dlBad, '--crag-debian13'],
        { encoding: 'utf8', env: { ...process.env, VM2API_PAYLOAD_BASE_URL: baseUrl } },
      ),
    (err) => {
      assert.notEqual(err?.code, 0)
      assert.match(String(err?.stderr || err?.message || ''), /does not match share\/os\/crag-debian13\/vmlinuz-custom/)
      return true
    },
  )
  assert.equal(fs.existsSync(path.join(dlBad, 'share', 'os', 'crag-debian13', 'vmlinuz-custom')), false)
})

test('.github/workflows/guest-images.yml exposes opt-in build_custom_kernel input (default false) and archives outputs', () => {
  const yml = fs.readFileSync(GUEST_IMAGES_WORKFLOW, 'utf8')
  assert.match(yml, /workflow_dispatch:\s*\n\s+inputs:\s*\n\s+build_custom_kernel:/)
  assert.match(yml, /type:\s*boolean\s*\n\s+default:\s*false/)
  assert.match(yml, /if:\s*github\.event_name == 'workflow_dispatch' && inputs\.build_custom_kernel == true/)
  assert.match(yml, /scripts\/build-custom-debian13-kernel\.sh/)
  assert.match(yml, /vmlinuz-custom/)
  assert.match(yml, /initrd\.img-custom/)
  assert.match(yml, /SHA256SUMS/)
  assert.match(yml, /actions\/upload-artifact@v7/)
})
