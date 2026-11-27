#!/usr/bin/env node
/**
 * CI/local stand-in for the closed kin-computer binary.
 * Implements: create --runtime kvm|docker --vm-id <id> --out <dir> [options]
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

function usage() {
  process.stderr.write(
    'usage: kin-computer-stub create --runtime kvm|docker --vm-id <id> --out <dir> [--cpu-vendor any|intel|amd] [--os-family debian|any] [--tz <IANA>] [--locale <LANG>] [--theme <theme>] [--telemetry on|off] [--username <name>] [--exclude-usernames <csv>]\n',
  )
  process.exit(2)
}

function parseCreate(argv) {
  if (argv[0] !== 'create') usage()
  const opts = {
    runtime: '',
    vmId: '',
    out: '',
    cpuVendor: 'any',
    osFamily: 'debian',
    tz: 'America/Los_Angeles',
    locale: 'en_US.UTF-8',
    theme: 'dark',
    telemetry: 'off',
    username: '',
    excludeUsernames: new Set(),
    osId: '',
    osVersion: '',
    osCodename: '',
    osPrettyName: '',
  }
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--runtime') opts.runtime = String(argv[++i] || '')
    else if (arg === '--vm-id') opts.vmId = String(argv[++i] || '')
    else if (arg === '--out') opts.out = String(argv[++i] || '')
    else if (arg === '--cpu-vendor') opts.cpuVendor = String(argv[++i] || 'any')
    else if (arg === '--os-family') opts.osFamily = String(argv[++i] || 'debian')
    else if (arg === '--os') i++
    else if (arg === '--tz') opts.tz = String(argv[++i] || 'America/Los_Angeles')
    else if (arg === '--locale') opts.locale = String(argv[++i] || 'en_US.UTF-8')
    else if (arg === '--theme') opts.theme = String(argv[++i] || 'dark')
    else if (arg === '--telemetry') opts.telemetry = String(argv[++i] || 'off')
    else if (arg === '--username') opts.username = String(argv[++i] || '')
    else if (arg === '--exclude-usernames') {
      for (const item of String(argv[++i] || '').split(',')) {
        const clean = item.trim().toLowerCase()
        if (clean) opts.excludeUsernames.add(clean)
      }
    } else if (arg === '--exclude-username') {
      const clean = String(argv[++i] || '')
        .trim()
        .toLowerCase()
      if (clean) opts.excludeUsernames.add(clean)
    } else if (arg === '--os-id') opts.osId = String(argv[++i] || '')
    else if (arg === '--os-version') opts.osVersion = String(argv[++i] || '')
    else if (arg === '--os-codename') opts.osCodename = String(argv[++i] || '')
    else if (arg === '--os-pretty-name') opts.osPrettyName = String(argv[++i] || '')
    else usage()
  }
  if (!opts.runtime || !opts.vmId || !opts.out) usage()
  return opts
}

function seedFor(vmId) {
  return crypto.createHash('sha256').update(`kin-computer-stub:${vmId}`).digest('hex')
}

const STUB_NAMES = ['mchen', 'dwalsh', 'kpatel', 'nreed', 'hpark', 'lgrant', 'scole', 'tlin']

function deriveStubUsername(vmId, explicit, excludeSet) {
  if (explicit) return explicit
  for (let i = 0; i < 32; i++) {
    const h = crypto.createHash('sha256').update(`stub-user:${vmId}:${i}`).digest('hex')
    const base = STUB_NAMES[Number.parseInt(h.slice(0, 4), 16) % STUB_NAMES.length]
    const num = String((Number.parseInt(h.slice(4, 8), 16) % 89) + 10)
    const cand = `${base}${num}`
    if (!excludeSet.has(cand)) return cand
  }
  return `mchen${seedFor(vmId).slice(0, 4)}`
}

function buildMeta(opts) {
  const seed = seedFor(opts.vmId)
  const hostname = `wks${seed.slice(0, 14)}`
  const machine_id = seed.slice(16, 48)
  const uuidRaw = seed.slice(0, 32)
  const uuid =
    process.env.KIN_COMPUTER_STUB_EMPTY_UUID === '1'
      ? ''
      : `${uuidRaw.slice(0, 8)}-${uuidRaw.slice(8, 12)}-4${uuidRaw.slice(13, 16)}-8${uuidRaw.slice(17, 20)}-${uuidRaw.slice(20, 32)}`
  const username = deriveStubUsername(opts.vmId, opts.username, opts.excludeUsernames)
  const isAmd = opts.cpuVendor === 'amd'
  const cpuid_vendor = isAmd ? 'AuthenticAMD' : 'GenuineIntel'
  const cpu_model_id = isAmd ? 'AMD Ryzen 7 PRO 6850U with Radeon Graphics' : '12th Gen Intel(R) Core(TM) i5-12400'
  const acpi = isAmd ? { oem_id: 'LENOVO', oem_table_id: 'TP-N3Q' } : { oem_id: 'DELL', oem_table_id: 'CBX3' }
  const os_release = {
    id: opts.osId || 'ubuntu',
    name: opts.osId === 'debian' ? 'Debian GNU/Linux' : 'Ubuntu',
    version_id: opts.osVersion || '24.04',
    version_codename: opts.osCodename || 'noble',
    pretty_name: opts.osPrettyName || 'Ubuntu 24.04.2 LTS',
    id_like: 'debian',
  }
  const kernel_profile = {
    release: '6.8.0-57-generic',
    version: '#59-Ubuntu SMP PREEMPT_DYNAMIC Sat Mar 15 17:40:59 UTC 2025',
    proc_mid:
      '(buildd@lcy02-amd64-087) (x86_64-linux-gnu-gcc-13 (Ubuntu 13.3.0-6ubuntu2~24.04) 13.3.0, GNU ld (GNU Binutils for Ubuntu) 2.42)',
  }
  return { seed, hostname, machine_id, uuid, username, cpuid_vendor, cpu_model_id, acpi, os_release, kernel_profile }
}

function writeCommonSystemFiles(out, opts, meta) {
  const etc = path.join(out, 'system', 'etc')
  const presetDir = path.join(etc, 'claude-code', 'managed-settings.d')
  fs.mkdirSync(presetDir, { recursive: true })
  const osLines = [
    `PRETTY_NAME="${meta.os_release.pretty_name}"`,
    `NAME="${meta.os_release.name}"`,
    `VERSION_ID="${meta.os_release.version_id}"`,
    `VERSION_CODENAME=${meta.os_release.version_codename}`,
    `ID=${meta.os_release.id}`,
    'ID_LIKE=debian',
  ]
  fs.writeFileSync(path.join(etc, 'os-release'), `${osLines.join('\n')}\n`, 'utf8')
  fs.writeFileSync(path.join(etc, 'timezone'), `${opts.tz}\n`, 'utf8')
  const zi = path.join('/usr/share/zoneinfo', opts.tz)
  if (fs.existsSync(zi) && fs.statSync(zi).isFile()) {
    fs.copyFileSync(zi, path.join(etc, 'localtime'))
  }
  const env = { TZ: opts.tz, LANG: opts.locale, LC_ALL: opts.locale }
  if (opts.telemetry !== 'on') {
    env.DISABLE_TELEMETRY = '1'
    env.DO_NOT_TRACK = '1'
  }
  fs.writeFileSync(
    path.join(presetDir, '10-slot-preset.json'),
    `${JSON.stringify({ theme: opts.theme, env }, null, 2)}\n`,
    'utf8',
  )
}

function writeKvm(opts) {
  const meta = buildMeta(opts)
  const { out } = opts
  fs.mkdirSync(out, { recursive: true })
  const ident = {
    hostname: meta.hostname,
    machine_id: meta.machine_id,
    uuid: meta.uuid,
    username: meta.username,
    home_dir: `/home/${meta.username}`,
    cpuid_vendor: meta.cpuid_vendor,
    cpu_model_id: meta.cpu_model_id,
    acpi: meta.acpi,
    os_release: meta.os_release,
    kernel_profile: meta.kernel_profile,
  }
  fs.writeFileSync(path.join(out, 'identity.json'), `${JSON.stringify(ident, null, 2)}\n`, 'utf8')
  fs.writeFileSync(
    path.join(out, 'hardware.json'),
    `${JSON.stringify(
      {
        cpu_vendor: meta.cpuid_vendor,
        cpu_model_id: meta.cpu_model_id,
        cpu_brand: meta.cpu_model_id,
        cpu_family: meta.cpuid_vendor === 'AuthenticAMD' ? 25 : 6,
        cpu_model: meta.cpuid_vendor === 'AuthenticAMD' ? 68 : 151,
        cpu_stepping: 1,
        acpi_oem_id: meta.acpi.oem_id,
        acpi_oem_table_id: meta.acpi.oem_table_id,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  fs.writeFileSync(
    path.join(out, 'qemu-smbios.args'),
    ['-uuid', meta.uuid, '-smbios', `type=1,manufacturer=KinStub,product=Test,uuid=${meta.uuid}`, ''].join('\n'),
    'utf8',
  )
  writeCommonSystemFiles(out, opts, meta)
}

function writeDocker(opts) {
  const meta = buildMeta(opts)
  const { out } = opts
  const macBytes = Buffer.from(meta.seed.slice(48, 60), 'hex')
  macBytes[0] = macBytes[0] & 0xfe
  const mac = [...macBytes.slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join(':')
  const etc = path.join(out, 'system', 'etc')
  const hw = path.join(out, 'system', 'hardware')
  const dmi = path.join(out, 'system', 'dmi', 'id')
  fs.mkdirSync(etc, { recursive: true })
  fs.mkdirSync(hw, { recursive: true })
  fs.mkdirSync(dmi, { recursive: true })
  const ident = {
    hostname: meta.hostname,
    machine_id: meta.machine_id,
    uuid: meta.uuid,
    username: meta.username,
    home_dir: `/home/${meta.username}`,
    cpuid_vendor: meta.cpuid_vendor,
    cpu_model_id: meta.cpu_model_id,
    acpi: meta.acpi,
    os_release: meta.os_release,
    kernel_profile: meta.kernel_profile,
  }
  fs.writeFileSync(path.join(out, 'identity.json'), `${JSON.stringify(ident, null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(out, 'pc_identity.json'), `${JSON.stringify(ident, null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(etc, 'hostname'), `${meta.hostname}\n`, 'utf8')
  fs.writeFileSync(path.join(etc, 'machine-id'), `${meta.machine_id}\n`, 'utf8')
  fs.writeFileSync(path.join(etc, 'kin-computer'), 'source=linux-pc\n', 'utf8')
  fs.writeFileSync(path.join(hw, 'mac'), `${mac}\n`, 'utf8')
  fs.writeFileSync(path.join(dmi, 'sys_vendor'), 'KinStub\n', 'utf8')
  fs.writeFileSync(path.join(dmi, 'product_name'), 'Workstation\n', 'utf8')
  writeCommonSystemFiles(out, opts, meta)
}

const opts = parseCreate(process.argv.slice(2))
if (opts.runtime === 'kvm') writeKvm(opts)
else if (opts.runtime === 'docker') writeDocker(opts)
else usage()
