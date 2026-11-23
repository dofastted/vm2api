/**
 * One computer per slot, created by the closed kin-computer binary before the
 * guest starts. The algorithm and device codes stay in that binary.
 * Hostname and the 32-bit machine-id come from the directory it writes.
 * device_id stays a control-plane 64-bit value and is never the SMBIOS UUID.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isKvmRuntime } from '../vm/runtime-kind.mjs'
import { atomicWriteJson } from '../vm/vm-file.mjs'
import { generateWorkstationFingerprint, HOSTNAME_RE, MACHINE_ID_RE } from './workstation-fingerprint.mjs'
import { isRfc4122Uuid } from './rfc4122-uuid.mjs'
import { repairKvmFingerprintUuid } from './kvm-fingerprint-uuid.mjs'

const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

export function computerBin() {
  const fromEnv = String(process.env.KIN_COMPUTER_BIN || '').trim()
  if (fromEnv) return fromEnv
  return path.join(REPO_ROOT, 'bin', 'kin-computer')
}

export function fingerprintDir(projectRoot, vmId) {
  return path.join(projectRoot, 'vms', vmId, 'kvm', 'fingerprint')
}

function readTrimmed(file) {
  return fs.readFileSync(file, 'utf8').replace(/\s+/g, '')
}

function linuxComputer(dir) {
  const identPath = path.join(dir, 'identity.json')
  const smbios = path.join(dir, 'qemu-smbios.args')
  if (!fs.existsSync(identPath) || !fs.existsSync(smbios)) return null
  let data
  try {
    data = JSON.parse(fs.readFileSync(identPath, 'utf8'))
  } catch {
    return null
  }
  const hostname = String(data.hostname || '').trim()
  const guest_machine_id = String(data.machine_id || '')
    .trim()
    .toLowerCase()
  const uuid = String(data.uuid || '').trim()
  if (!HOSTNAME_RE.test(hostname) || !MACHINE_ID_RE.test(guest_machine_id) || !isRfc4122Uuid(uuid)) return null
  try {
    if (!fs.statSync(smbios).size) return null
  } catch {
    return null
  }
  return { hostname, guest_machine_id, mac: '', dir, kvm: true }
}

function containerComputer(dir) {
  const hostFile = path.join(dir, 'system', 'etc', 'hostname')
  const midFile = path.join(dir, 'system', 'etc', 'machine-id')
  const macFile = path.join(dir, 'system', 'hardware', 'mac')
  const dmi = path.join(dir, 'system', 'dmi', 'id')
  for (const file of [hostFile, midFile, macFile]) {
    try {
      if (!fs.statSync(file).isFile()) return null
    } catch {
      return null
    }
  }
  try {
    if (!fs.statSync(dmi).isDirectory()) return null
  } catch {
    return null
  }
  const hostname = readTrimmed(hostFile)
  const guest_machine_id = readTrimmed(midFile).toLowerCase()
  const mac = readTrimmed(macFile).toLowerCase()
  if (!HOSTNAME_RE.test(hostname) || !MACHINE_ID_RE.test(guest_machine_id) || !MAC_RE.test(mac)) return null
  return { hostname, guest_machine_id, mac, dir, kvm: false }
}

function ensureContainerComputerSourceFile(dir) {
  const compFile = path.join(dir, 'system', 'etc', 'kin-computer')
  try {
    const stat = fs.lstatSync(compFile)
    if (stat.isFile() && stat.size > 0) return
    fs.rmSync(compFile, { recursive: true, force: true })
  } catch {}
  fs.mkdirSync(path.dirname(compFile), { recursive: true, mode: 0o755 })
  fs.writeFileSync(compFile, 'source=linux-pc\n', { encoding: 'utf8', mode: 0o644 })
}

/**
 * Normalize fingerprint directories to 0755 and regular files to 0644 so a
 * restrictive host umask (077) never leaves /etc/kin-computer or DMI files
 * unreadable (0600 root-only) for non-root container UID 10000+n.
 */
export function normalizeFingerprintModes(dir) {
  let stat
  try {
    stat = fs.lstatSync(dir)
  } catch {
    return
  }
  if (stat.isSymbolicLink()) return
  if (stat.isDirectory()) {
    if ((stat.mode & 0o777) !== 0o755) fs.chmodSync(dir, 0o755)
    for (const entry of fs.readdirSync(dir)) {
      normalizeFingerprintModes(path.join(dir, entry))
    }
    return
  }
  if (stat.isFile() && (stat.mode & 0o777) !== 0o644) {
    fs.chmodSync(dir, 0o644)
  }
}

function runChecked(argv, timeout) {
  try {
    execFileSync(argv[0], argv.slice(1), {
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    const detail = String(e.stderr || e.stdout || e.message || e).trim()
    throw new Error(detail || 'vm-os computer identity failed')
  }
}

/**
 * Read an existing computer. Create it once when the directory has no identity.
 * The binary's vm-id pick is stable, so a second call must not run it again.
 */
export function ensureSlotComputer(projectRoot, vm) {
  if (!projectRoot || !vm?.id) throw new Error('projectRoot and vm id required')
  const kvm = isKvmRuntime(vm)
  const dir = fingerprintDir(projectRoot, vm.id)
  const ready = kvm ? linuxComputer(dir) : containerComputer(dir)
  if (ready) {
    if (!kvm) ensureContainerComputerSourceFile(dir)
    normalizeFingerprintModes(dir)
    return { ...ready, created: false }
  }
  if (kvm && fs.existsSync(dir)) {
    repairKvmFingerprintUuid(dir)
    const repaired = linuxComputer(dir)
    if (repaired) {
      normalizeFingerprintModes(dir)
      return { ...repaired, created: false }
    }
  }
  const bin = computerBin()
  if (!fs.existsSync(bin)) {
    const missing = new Error('计算机服务未安装。放好 kin-computer 后可再次创建，已完成的身份不会重抽。')
    missing.code = 'computer_service_missing'
    throw missing
  }
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  try {
    runChecked(
      [bin, 'create', '--runtime', kvm ? 'kvm' : 'docker', '--vm-id', vm.id, '--out', dir],
      kvm ? 120_000 : 180_000,
    )
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true })
    const failed = new Error(`计算机身份创建失败，目录已清掉，可再次创建：${String(e.message || e).slice(0, 240)}`)
    failed.code = 'computer_create_failed'
    throw failed
  }
  if (kvm) repairKvmFingerprintUuid(dir)
  const written = kvm ? linuxComputer(dir) : containerComputer(dir)
  if (!written) {
    fs.rmSync(dir, { recursive: true, force: true })
    const incomplete = new Error('计算机身份不完整，目录已清掉，可再次创建。')
    incomplete.code = 'computer_create_failed'
    throw incomplete
  }
  if (!kvm) ensureContainerComputerSourceFile(dir)
  normalizeFingerprintModes(dir)
  return { ...written, created: true }
}

/** Control-plane device_id plus the computer hostname and machine-id. */
export function assignComputerFingerprint(projectRoot, vm, { taken, now } = {}) {
  const computer = ensureSlotComputer(projectRoot, vm)
  if (taken?.hostname?.has(computer.hostname) || taken?.guest_machine_id?.has(computer.guest_machine_id)) {
    throw new Error('workstation fingerprint collision')
  }
  const generated = generateWorkstationFingerprint(vm, { taken, now })
  return {
    ...generated,
    hostname: computer.hostname,
    guest_machine_id: computer.guest_machine_id,
  }
}

/** Point the slot record at the computer. Does not touch device_id. */
export function rememberComputer(projectRoot, vm, computer) {
  if (!computer?.hostname || !vm?.id) return false
  const fp = vm.fingerprint && typeof vm.fingerprint === 'object' ? vm.fingerprint : {}
  const same =
    fp.hostname === computer.hostname &&
    String(fp.guest_machine_id || '')
      .trim()
      .toLowerCase() === computer.guest_machine_id
  if (same) return false
  vm.fingerprint = {
    ...fp,
    hostname: computer.hostname,
    guest_machine_id: computer.guest_machine_id,
  }
  const vmPath = path.join(projectRoot, 'vms', `${vm.id}.json`)
  if (!fs.existsSync(vmPath)) return true
  const disk = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  disk.fingerprint = {
    ...(disk.fingerprint && typeof disk.fingerprint === 'object' ? disk.fingerprint : {}),
    hostname: computer.hostname,
    guest_machine_id: computer.guest_machine_id,
  }
  disk.updated_at = new Date().toISOString()
  atomicWriteJson(vmPath, disk, { mode: 0o600 })
  return true
}
