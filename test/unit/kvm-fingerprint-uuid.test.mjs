import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RFC4122_UUID_RE } from '../../src/lib/identity/rfc4122-uuid.mjs'
import { patchQemuSmbiosArgsUuid, repairKvmFingerprintUuid } from '../../src/lib/identity/kvm-fingerprint-uuid.mjs'

test('patchQemuSmbiosArgsUuid inserts -uuid and type=1 uuid field', () => {
  const before = ['-smbios', 'type=1,manufacturer=ASUS,product=System Product Name,sku=SKU', ''].join('\n')
  const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const after = patchQemuSmbiosArgsUuid(before, uuid)
  assert.match(after, new RegExp(`-uuid\\n${uuid}`))
  assert.match(after, new RegExp(`uuid=${uuid}`))
})

test('repairKvmFingerprintUuid writes identity and qemu-smbios.args', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvm-fp-repair-'))
  try {
    fs.writeFileSync(
      path.join(dir, 'identity.json'),
      `${JSON.stringify({ hostname: 'wks1234567890123', machine_id: 'b'.repeat(32), uuid: '' }, null, 2)}\n`,
    )
    fs.writeFileSync(path.join(dir, 'qemu-smbios.args'), '-smbios\ntype=1,manufacturer=KinStub,product=Test\n')
    assert.equal(repairKvmFingerprintUuid(dir), true)
    const ident = JSON.parse(fs.readFileSync(path.join(dir, 'identity.json'), 'utf8'))
    assert.match(String(ident.uuid || ''), RFC4122_UUID_RE)
    const args = fs.readFileSync(path.join(dir, 'qemu-smbios.args'), 'utf8')
    assert.match(args, new RegExp(`uuid=${ident.uuid}`))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('patchQemuSmbiosArgsUuid preserves QEMU doubled commas in type=1 manufacturer', () => {
  const uuid = 'cd378456-145b-480d-a3cb-515a3ce5bdf4'
  const before = [
    '-uuid',
    uuid,
    '-smbios',
    'type=0,vendor=American Megatrends International,, LLC.,version=F17d',
    '-smbios',
    `type=1,manufacturer=Gigabyte Technology Co.,, Ltd.,product=B550M AORUS PRO-P,uuid=${uuid},family=AORUS`,
    '',
  ].join('\n')
  const after = patchQemuSmbiosArgsUuid(before, uuid)
  assert.equal(after, before)
})

test('repairKvmFingerprintUuid self-heals unescaped comma in legacy corrupted type=1 line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvm-fp-comma-heal-'))
  try {
    const uuid = 'cd378456-145b-480d-a3cb-515a3ce5bdf4'
    fs.writeFileSync(
      path.join(dir, 'identity.json'),
      `${JSON.stringify({ hostname: 'b550m-aorus-pro-p-b93ef4', machine_id: 'b'.repeat(32), uuid }, null, 2)}\n`,
    )
    fs.writeFileSync(
      path.join(dir, 'qemu-smbios.args'),
      [
        '-uuid',
        uuid,
        '-smbios',
        `type=1,manufacturer=Gigabyte Technology Co., Ltd.,product=B550M AORUS PRO-P,uuid=${uuid},family=AORUS`,
        '',
      ].join('\n'),
    )
    assert.equal(repairKvmFingerprintUuid(dir), true)
    const args = fs.readFileSync(path.join(dir, 'qemu-smbios.args'), 'utf8')
    assert.match(args, /manufacturer=Gigabyte Technology Co\.,, Ltd\.,product=B550M AORUS PRO-P/)
    assert.equal(repairKvmFingerprintUuid(dir), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
