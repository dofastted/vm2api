#!/usr/bin/env node
/**
 * CI/local stand-in for the closed kin-computer binary.
 * Implements: create --runtime kvm|docker --vm-id <id> --out <dir>
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

function usage() {
  process.stderr.write('usage: kin-computer-stub create --runtime kvm|docker --vm-id <id> --out <dir>\n')
  process.exit(2)
}

function parseCreate(argv) {
  if (argv[0] !== 'create') usage()
  let runtime = ''
  let vmId = ''
  let out = ''
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--runtime') runtime = String(argv[++i] || '')
    else if (arg === '--vm-id') vmId = String(argv[++i] || '')
    else if (arg === '--out') out = String(argv[++i] || '')
    else usage()
  }
  if (!runtime || !vmId || !out) usage()
  return { runtime, vmId, out }
}

function seedFor(vmId) {
  return crypto.createHash('sha256').update(`kin-computer-stub:${vmId}`).digest('hex')
}

function writeKvm(out, vmId) {
  const seed = seedFor(vmId)
  const hostname = `wks${seed.slice(0, 14)}`
  const machine_id = seed.slice(16, 48)
  const uuidRaw = seed.slice(0, 32)
  const uuid =
    process.env.KIN_COMPUTER_STUB_EMPTY_UUID === '1'
      ? ''
      : `${uuidRaw.slice(0, 8)}-${uuidRaw.slice(8, 12)}-${uuidRaw.slice(12, 16)}-${uuidRaw.slice(16, 20)}-${uuidRaw.slice(20, 32)}`
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(
    path.join(out, 'identity.json'),
    `${JSON.stringify({ hostname, machine_id, uuid }, null, 2)}\n`,
    'utf8',
  )
  fs.writeFileSync(
    path.join(out, 'qemu-smbios.args'),
    ['-uuid', uuid, '-smbios', `type=1,manufacturer=KinStub,product=Test,uuid=${uuid}`, ''].join('\n'),
    'utf8',
  )
}

function writeDocker(out, vmId) {
  const seed = seedFor(vmId)
  const hostname = `wks${seed.slice(0, 14)}`
  const machine_id = seed.slice(16, 48)
  const macBytes = Buffer.from(seed.slice(48, 60), 'hex')
  const mac = [...macBytes.slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join(':')
  const etc = path.join(out, 'system', 'etc')
  const hw = path.join(out, 'system', 'hardware')
  const dmi = path.join(out, 'system', 'dmi', 'id')
  fs.mkdirSync(etc, { recursive: true })
  fs.mkdirSync(hw, { recursive: true })
  fs.mkdirSync(dmi, { recursive: true })
  fs.writeFileSync(path.join(etc, 'hostname'), `${hostname}\n`, 'utf8')
  fs.writeFileSync(path.join(etc, 'machine-id'), `${machine_id}\n`, 'utf8')
  fs.writeFileSync(path.join(etc, 'kin-computer'), 'source=linux-pc\n', 'utf8')
  fs.writeFileSync(path.join(hw, 'mac'), `${mac}\n`, 'utf8')
  fs.writeFileSync(path.join(dmi, 'sys_vendor'), 'KinStub\n', 'utf8')
  fs.writeFileSync(path.join(dmi, 'product_name'), 'Workstation\n', 'utf8')
}

const { runtime, vmId, out } = parseCreate(process.argv.slice(2))
if (runtime === 'kvm') writeKvm(out, vmId)
else if (runtime === 'docker') writeDocker(out, vmId)
else usage()
