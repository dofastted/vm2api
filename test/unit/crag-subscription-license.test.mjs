import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  activateCragLicense,
  activateCragSubscriptionBinding,
  checkCragLicense,
  cragLicenseDirectory,
  getCragLicense,
  prepareCragSubscriptionBinding,
  projectCragUniversalVm,
  projectLocalGrant,
  readCragClusterSubscription,
  readCragSubscriptionFiles,
  readCragSubscriptionReleaseCandidate,
  readKvmCragLicense,
  readKvmSubscriptionMachineId,
  redeemCragDeviceVoucher,
  verifyCragHostEntitlement,
} from '../../src/lib/vm/crag-license.mjs'
import { cragSubscriptionPublicDirectory } from '../../src/lib/vm/crag-subscription-paths.mjs'
import { publishKvmCragLicense } from '../../src/lib/vm/kvm-crag-license.mjs'
import { cragDockerAppArmorProfile, startVmRuntime } from '../../src/lib/vm/vm-runtime.mjs'
import { bindPlacement, unbindPlacement } from '../../src/lib/cluster/placement.mjs'
import { callRustKernel, streamRustKernel } from '../../src/lib/transport/rust-kernel-client.mjs'
import {
  issueFixtureCode,
  issueHostEntitlement,
  issueSlotPermit,
  issueUniversalCode,
  seedEncryptedPackage,
  signSubscriptionBytes,
} from '../fixtures/crag-license.mjs'

const envNames = [
  'KIN_SLOT_RUN_ROOT',
  'KIN_CRAG_V2_ROOT',
  'KIN_DATA_DIR',
  'KIN_CRS_MOCK',
  'KIN_CRS_TRACE_FILE',
  'KIN_MOCK_TRACE_FILE',
]
const savedEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]))
before(() => {
  for (const name of envNames) delete process.env[name]
})
after(() => {
  for (const name of envNames) {
    if (savedEnv[name] === undefined) delete process.env[name]
    else process.env[name] = savedEnv[name]
  }
})

function replace(file, contents) {
  const temporary = `${file}.replacement`
  const stat = fs.statSync(file)
  fs.writeFileSync(temporary, contents, { mode: stat.mode & 0o777 })
  if (process.getuid() === 0) fs.chownSync(temporary, stat.uid, stat.gid)
  fs.renameSync(temporary, file)
}

function fixture(t, { slotLimit = 2, seat = 2, activate = true, placement = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-subscription-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const machineId = crypto.randomBytes(16).toString('hex')
  const vm = {
    id: 'vm-13',
    dataplane: 'crag',
    runtime: { type: 'docker' },
    fingerprint: { guest_machine_id: machineId },
    ...placement,
  }
  fs.mkdirSync(path.join(root, 'vms', vm.id), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  fs.writeFileSync(path.join(root, 'vms', vm.id, 'machine-id'), `${machineId}\n`)
  const pkg = seedEncryptedPackage(root)
  const machineCode = prepareCragSubscriptionBinding(root, vm)
  const dir = cragLicenseDirectory(root, vm)
  const registration = path.join(dir, 'registration.code')
  const publicDir = cragSubscriptionPublicDirectory(root)
  fs.mkdirSync(publicDir, { recursive: true, mode: 0o755 })
  const hostId = crypto.randomBytes(32).toString('hex')
  const entitlement = path.join(publicDir, 'entitlement.code')
  fs.writeFileSync(path.join(publicDir, 'host_id'), `${hostId}\n`, { mode: 0o644 })
  const host = issueHostEntitlement(root, hostId, { slot_limit: slotLimit })
  fs.writeFileSync(entitlement, `${host.code}\n`, { mode: 0o644 })
  const permit = issueSlotPermit(root, machineCode, hostId, { seat })
  if (activate) activateCragSubscriptionBinding(root, vm, permit.code)
  const exec = { projectRoot: root, homeDir: path.join(root, 'vms', vm.id, 'cli-home'), vm }
  return { root, vm, pkg, machineCode, dir, registration, publicDir, hostId, host, entitlement, permit, exec }
}

test('starting a stopped host-licensed Docker slot repairs a missing entitlement mount', async (t) => {
  const { root, vm, registration, publicDir } = fixture(t)
  vm.proxy = { id: 'px-local', scheme: 'local' }
  const grant = fs.readFileSync(registration)
  assert.equal(checkCragLicense(root, vm).license.scope, 'host')
  const slotDir = path.join(root, 'vms', vm.id)
  const machineId = fs.readFileSync(path.join(slotDir, 'machine-id'))
  const computer = path.join(slotDir, 'kvm', 'fingerprint', 'system')
  for (const dir of ['etc', 'hardware', 'dmi/id']) fs.mkdirSync(path.join(computer, dir), { recursive: true })
  fs.writeFileSync(path.join(computer, 'etc', 'hostname'), 'wks1234567890123\n')
  fs.writeFileSync(path.join(computer, 'etc', 'machine-id'), machineId)
  fs.writeFileSync(path.join(computer, 'hardware', 'mac'), '02:00:00:00:00:13\n')

  const trace = path.join(root, 'docker.jsonl')
  const oldPath = process.env.PATH
  process.env.PATH = `${root}${path.delimiter}${oldPath}`
  t.after(() => {
    process.env.PATH = oldPath
  })
  const mounts = path.join(root, 'mounts.json')
  fs.writeFileSync(mounts, '[]')
  const profile = new URL('../../src/lib/vm/crag-v2-seccomp.json', import.meta.url)
  const appArmor = cragDockerAppArmorProfile()
  const securityOpts = JSON.stringify([
    'no-new-privileges',
    `seccomp=${profile.pathname}`,
    ...(appArmor ? [`apparmor=${appArmor}`] : []),
  ])
  fs.writeFileSync(
    path.join(root, 'docker'),
    `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + '\\n')
if (args[0] === 'network' && args[1] === 'inspect') console.log('172.20.0.0/24|172.20.0.1')
else if (args[0] === 'inspect' && args[2] === '{{json .Mounts}}') console.log(fs.readFileSync(${JSON.stringify(mounts)}, 'utf8'))
else if (args[0] === 'inspect') console.log(${JSON.stringify(`false|0|kin-eg-px-local||ghcr.io/dofastted/kin-os-ubuntu:24.04|fixture|docker||false|unless-stopped|${securityOpts}|true`)})
`,
    { mode: 0o755 },
  )
  const commands = () => fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse)

  const result = await startVmRuntime(vm, root, { routing: {} })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.action, 'created')
  assert.equal(
    commands().some(([op]) => op === 'start'),
    false,
  )
  assert.ok(
    commands()
      .find(([op]) => op === 'run')
      .includes(`type=bind,source=${publicDir},target=/run/kin/crag-host,readonly`),
  )

  fs.writeFileSync(trace, '')
  fs.writeFileSync(
    mounts,
    JSON.stringify([{ Type: 'bind', Source: publicDir, Destination: '/run/kin/crag-host', RW: false }]),
  )
  assert.equal((await startVmRuntime(vm, root, { routing: {} })).action, 'started')
  assert.equal(
    commands().some(([op]) => op === 'rm' || op === 'run'),
    false,
  )

  fs.writeFileSync(trace, '')
  fs.writeFileSync(mounts, 'null')
  assert.equal((await startVmRuntime(vm, root, { routing: {} })).code, 'crag_host_mount_inspect_failed')
  assert.equal(
    commands().some(([op]) => op === 'rm' || op === 'run' || op === 'start'),
    false,
  )
  assert.deepEqual(fs.readFileSync(registration), grant)
  assert.deepEqual(fs.readFileSync(path.join(slotDir, 'machine-id')), machineId)
})

async function assertDenied(context, code) {
  const check = checkCragLicense(context.root, context.vm)
  assert.equal(check.ok, false)
  assert.equal(check.code, code)
  for (const call of [callRustKernel, streamRustKernel]) {
    const result = await call({ exec: context.exec })
    assert.equal(result.status, 403)
    assert.equal(result.body.error.code, code)
    assert.equal(result.upstreamExecutions, 0)
    assert.equal(result.committed, false)
    assert.equal(result.terminalState, 'rejected')
  }
}

for (const slotLimit of [2, 'unlimited']) {
  test(`H1/S1 ${slotLimit} admits through checkCragLicense and the raw kernel client`, async (t) => {
    const context = fixture(t, { slotLimit, seat: slotLimit === 'unlimited' ? 4294967295 : 2 })
    const { root, vm, machineCode, registration, host, hostId, permit } = context
    assert.deepEqual(verifyCragHostEntitlement(root, host.code, hostId), host.claims)
    assert.equal(prepareCragSubscriptionBinding(root, vm), machineCode)
    const status = getCragLicense(root, vm)
    assert.equal(status.license.valid, true)
    assert.equal(status.license.scope, 'host')
    assert.equal(status.license.seat, permit.claims.seat)
    assert.equal(status.machine_code, machineCode)
    assert.equal(checkCragLicense(root, vm).ok, true)
    assert.doesNotMatch(JSON.stringify(status), /private_key|wrapped_key|CRAGS1|CRAGH1/)
    assert.equal(fs.statSync(registration).mode & 0o777, 0o600)
    process.env.KIN_CRS_MOCK = '1'
    try {
      const result = await callRustKernel({
        exec: context.exec,
        body: { model: 'claude-sonnet-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] },
      })
      assert.equal(result.ok, true)
      assert.equal(result.via, 'rust-kernel-mock')
    } finally {
      delete process.env.KIN_CRS_MOCK
    }
  })
}

for (const placement of [
  { runtime: { type: 'kvm' } },
  { runtime: { type: 'qemu' } },
  { runtime: { type: 'libvirt' } },
  { runtime_type: 'kvm', runtime: undefined },
]) {
  test(`local KVM host permits retain signed device binding ${JSON.stringify(placement)}`, async (t) => {
    const context = fixture(t, { placement })
    const { root, vm, machineCode, permit, hostId, registration } = context
    assert.equal(prepareCragSubscriptionBinding(root, vm), machineCode)
    const status = getCragLicense(root, vm)
    assert.equal(status.license.valid, true)
    assert.equal(status.license.scope, 'host')
    assert.equal(checkCragLicense(root, vm).ok, true)
    assert.equal(
      readCragSubscriptionReleaseCandidate(root, vm, hostId),
      crypto.createHash('sha256').update(permit.code).digest('hex'),
    )
    const saved = fs.readFileSync(registration)
    assert.throws(() => activateCragLicense(root, vm, issueFixtureCode(root, machineCode).code), {
      code: 'license_unconfigured',
    })
    await assert.rejects(
      redeemCragDeviceVoucher(root, vm, `CRAGR1.${crypto.randomBytes(32).toString('base64url')}`, {
        fetchImpl: () => assert.fail('KVM device vouchers must not contact the authority'),
      }),
      { code: 'license_unconfigured' },
    )
    assert.deepEqual(fs.readFileSync(registration), saved)
  })
}

test('an unbound local KVM reports missing host authorization and initializes only its own challenge', (t) => {
  const { root, vm, dir, registration } = fixture(t, { activate: false, placement: { runtime: { type: 'kvm' } } })
  fs.rmSync(dir, { recursive: true })
  assert.equal(getCragLicense(root, vm).license.code, 'license_required')
  assert.equal(fs.existsSync(dir), false)
  const initial = getCragLicense(root, vm, { initialize: true })
  assert.equal(initial.license.code, 'license_required')
  assert.match(initial.machine_code, /^CRAGM1\./)
  assert.equal(prepareCragSubscriptionBinding(root, vm), initial.machine_code)
  assert.equal(fs.existsSync(registration), false)
  assert.equal(readCragSubscriptionFiles(root, vm), null)
  assert.doesNotMatch(JSON.stringify(initial), /private_key|wrapped_key|CRAGS1|CRAGH1/)
})

test('KVM host permits enforce H2 roster replacement, revocation and pending synchronization', async (t) => {
  const context = fixture(t, { placement: { runtime: { type: 'kvm' } } })
  const { root, vm, entitlement, host, permit, machineCode, hostId, registration, publicDir } = context
  const roster = (code) => [
    { seat: permit.claims.seat, permit_sha256: crypto.createHash('sha256').update(code).digest('hex') },
  ]
  const rights = (revision, entries) =>
    signSubscriptionBytes(root, 'CRAGH2', JSON.stringify({ ...host.claims, version: 2, revision, roster: entries }))
  replace(entitlement, rights(2, roster(permit.code)))
  assert.equal(getCragLicense(root, vm).license.revision, 2)
  assert.equal(readCragSubscriptionFiles(root, vm).permit, permit.code)
  const renewed = issueSlotPermit(root, machineCode, hostId, { seat: permit.claims.seat })
  replace(entitlement, rights(3, roster(renewed.code)))
  await assertDenied(context, 'license_binding_mismatch')
  assert.throws(() => readCragSubscriptionFiles(root, vm), { code: 'license_binding_mismatch' })
  activateCragSubscriptionBinding(root, vm, renewed.code)
  assert.equal(checkCragLicense(root, vm).ok, true)
  assert.equal(readCragSubscriptionFiles(root, vm).permit, renewed.code)
  fs.writeFileSync(path.join(publicDir, 'sync-pending'), 'pending\n')
  assert.equal(checkCragLicense(root, vm).ok, true)
  assert.equal(readCragSubscriptionFiles(root, vm).permit, renewed.code)
  fs.unlinkSync(path.join(publicDir, 'sync-pending'))
  replace(entitlement, rights(4, []))
  await assertDenied(context, 'license_binding_mismatch')
  assert.throws(() => readCragSubscriptionFiles(root, vm), { code: 'license_binding_mismatch' })
  assert.equal(fs.readFileSync(registration, 'utf8').trim(), renewed.code)
})

test('KVM subscription export verifies identities and signatures and exposes only guest authorization files', (t) => {
  const { root, vm, permit, host, hostId, dir, registration, entitlement } = fixture(t, {
    placement: { runtime: { type: 'kvm' } },
  })
  const exported = readCragSubscriptionFiles(root, vm)
  assert.deepEqual(Object.keys(exported).sort(), ['device', 'entitlement', 'hostId', 'permit'])
  assert.equal(exported.permit, permit.code)
  assert.equal(exported.entitlement, host.code)
  assert.equal(exported.hostId, hostId)
  assert.deepEqual(JSON.parse(exported.device), JSON.parse(fs.readFileSync(path.join(dir, 'device.json'), 'utf8')))
  assert.equal(readCragClusterSubscription(root, vm), null)
  const different = vm.fingerprint.guest_machine_id === '1'.repeat(32) ? '2'.repeat(32) : '1'.repeat(32)
  assert.throws(() => readCragSubscriptionFiles(root, { ...vm, fingerprint: { guest_machine_id: different } }), {
    code: 'license_binding_mismatch',
  })
  for (const [file, code] of [
    [registration, permit.code],
    [entitlement, host.code],
  ]) {
    const parts = code.split('.')
    parts[2] = Buffer.alloc(64).toString('base64url')
    replace(file, parts.join('.'))
    assert.throws(() => readCragSubscriptionFiles(root, vm), { code: 'license_invalid' })
    replace(file, code)
  }
  assert.deepEqual(readCragSubscriptionFiles(root, vm), exported)
})

test('KVM subscription initialization refuses noncanonical or mismatched guest identity without replacing files', (t) => {
  const { root, vm, dir, registration } = fixture(t, { placement: { runtime: { type: 'kvm' } } })
  const machineFile = path.join(root, 'vms', vm.id, 'machine-id')
  const machine = vm.fingerprint.guest_machine_id
  const different = machine === '1'.repeat(32) ? '2'.repeat(32) : '1'.repeat(32)
  const savedDevice = fs.readFileSync(path.join(dir, 'device.json'))
  const savedRegistration = fs.readFileSync(registration)
  const cases = [
    [{}, `${machine}\n`, 'license_unconfigured'],
    [{ machine_id: machine }, `${machine}\n`, 'license_unconfigured'],
    [{ guest_machine_id: `A${machine.slice(1)}` }, `${machine}\n`, 'license_unconfigured'],
    [{ guest_machine_id: `${machine}\n` }, `${machine}\n`, 'license_unconfigured'],
    [{ guest_machine_id: '0'.repeat(32) }, `${machine}\n`, 'license_unconfigured'],
    [{ guest_machine_id: machine }, `A${machine.slice(1)}\n`, 'license_unconfigured'],
    [{ guest_machine_id: machine }, `${machine}\n\n`, 'license_unconfigured'],
    [{ guest_machine_id: machine }, `${machine}\r\n`, 'license_unconfigured'],
    [{ guest_machine_id: machine }, different, 'license_binding_mismatch'],
  ]
  for (const [fingerprint, contents, code] of cases) {
    const changed = { ...vm, fingerprint }
    fs.writeFileSync(machineFile, contents)
    assert.throws(() => prepareCragSubscriptionBinding(root, changed), { code })
    assert.equal(getCragLicense(root, changed).license.code, code)
    assert.equal(fs.readFileSync(machineFile, 'utf8'), contents)
    assert.deepEqual(fs.readFileSync(path.join(dir, 'device.json')), savedDevice)
    assert.deepEqual(fs.readFileSync(registration), savedRegistration)
  }
  fs.writeFileSync(machineFile, `${machine}\n`)
  const moved = { ...vm, fingerprint: { guest_machine_id: different } }
  assert.equal(getCragLicense(root, moved).license.code, 'license_binding_mismatch')
  assert.equal(getCragLicense(root, vm).license.valid, true)
})

test('KVM subscription initialization does not repair an existing machine-id directory or link', (t) => {
  const { root, vm } = fixture(t, { placement: { runtime: { type: 'kvm' } } })
  const machineFile = path.join(root, 'vms', vm.id, 'machine-id')
  fs.unlinkSync(machineFile)
  fs.mkdirSync(machineFile)
  fs.writeFileSync(path.join(machineFile, 'keep'), 'protected')
  assert.throws(() => prepareCragSubscriptionBinding(root, vm), { code: 'license_unconfigured' })
  assert.equal(fs.readFileSync(path.join(machineFile, 'keep'), 'utf8'), 'protected')
  fs.rmSync(machineFile, { recursive: true })
  const target = path.join(root, 'linked-machine-id')
  fs.writeFileSync(target, `${vm.fingerprint.guest_machine_id}\n`)
  fs.symlinkSync(target, machineFile)
  assert.throws(() => prepareCragSubscriptionBinding(root, vm), { code: 'license_unconfigured' })
  assert.equal(fs.lstatSync(machineFile).isSymbolicLink(), true)
})

test('KVM readiness identity checks do not initialize or rewrite missing and mismatched machine files', (t) => {
  const { root, vm } = fixture(t, { placement: { runtime: { type: 'kvm' } } })
  const machineFile = path.join(root, 'vms', vm.id, 'machine-id')
  const machine = vm.fingerprint.guest_machine_id
  assert.equal(readKvmSubscriptionMachineId(root, vm), machine)
  fs.unlinkSync(machineFile)
  assert.throws(() => readKvmSubscriptionMachineId(root, vm), { code: 'license_unconfigured' })
  assert.equal(readKvmSubscriptionMachineId(root, vm, { allowMissingFile: true }), machine)
  assert.equal(fs.existsSync(machineFile), false)
  const different = machine === '1'.repeat(32) ? '2'.repeat(32) : '1'.repeat(32)
  fs.writeFileSync(machineFile, `${different}\n`)
  assert.throws(() => readKvmSubscriptionMachineId(root, vm), { code: 'license_binding_mismatch' })
  assert.throws(() => readKvmSubscriptionMachineId(root, vm, { allowMissingFile: true }), {
    code: 'license_binding_mismatch',
  })
  assert.equal(fs.readFileSync(machineFile, 'utf8'), `${different}\n`)
  fs.unlinkSync(machineFile)
  const target = path.join(root, 'machine-link-target')
  fs.writeFileSync(target, machine)
  fs.symlinkSync(target, machineFile)
  assert.throws(() => readKvmSubscriptionMachineId(root, vm, { allowMissingFile: true }), {
    code: 'license_unconfigured',
  })
  assert.equal(fs.lstatSync(machineFile).isSymbolicLink(), true)
})

test('host time checks enforce the exclusive expiry boundary and never relax future issuance', (t) => {
  const { root, hostId } = fixture(t)
  const now = Math.floor(Date.now() / 1000)
  const expired = issueHostEntitlement(root, hostId, { issued_at: now - 100, expires_at: now })
  assert.throws(() => verifyCragHostEntitlement(root, expired.code, hostId), { code: 'license_expired' })
  assert.deepEqual(verifyCragHostEntitlement(root, expired.code, hostId, { allowExpired: true }), expired.claims)
  const future = issueHostEntitlement(root, hostId, { issued_at: now + 86400, expires_at: now + 172800 })
  assert.throws(() => verifyCragHostEntitlement(root, future.code, hostId, { allowExpired: true }), {
    code: 'license_not_yet_valid',
  })
})

test('H1 integer boundaries are lossless without JSON reviver source support', (t) => {
  const { root, hostId, host, entitlement, vm } = fixture(t)
  const raw = JSON.stringify(host.claims)
    .replace('"revision":1', '"revision":9223372036854775807')
    .replace(`"expires_at":${host.claims.expires_at}`, '"expires_at":9223372036854775807')
  const code = signSubscriptionBytes(root, 'CRAGH1', raw)
  const claims = verifyCragHostEntitlement(root, code, hostId)
  assert.equal(claims.revision, 9223372036854775807n)
  assert.equal(claims.expires_at, 9223372036854775807n)
  replace(entitlement, code)
  const status = getCragLicense(root, vm)
  assert.equal(status.license.expires_at, '9223372036854775807')
  assert.doesNotThrow(() => JSON.stringify(status))
  for (const field of ['revision', 'expires_at']) {
    const invalid = raw.replace(`"${field}":9223372036854775807`, `"${field}":9223372036854775808`)
    assert.throws(() => verifyCragHostEntitlement(root, signSubscriptionBytes(root, 'CRAGH1', invalid), hostId), {
      code: 'license_invalid',
    })
  }
})

test('atomic H1 and S1 replacements, downgrade, renewal and sync are re-read on every admission', async (t) => {
  const context = fixture(t)
  const { root, vm, entitlement, hostId, host, publicDir, registration, machineCode, permit } = context
  activateCragLicense(root, vm, issueUniversalCode(root).code)
  replace(entitlement, issueHostEntitlement(root, hostId, { revision: 2, slot_limit: 1 }).code)
  await assertDenied(context, 'license_crag_host_over_quota')
  replace(registration, issueSlotPermit(root, machineCode, hostId, { seat: 1 }).code)
  assert.equal(checkCragLicense(root, vm).ok, true)
  replace(registration, permit.code)
  replace(entitlement, issueHostEntitlement(root, hostId, { revision: 3, slot_limit: 'unlimited' }).code)
  assert.equal(checkCragLicense(root, vm).ok, true)
  const now = Math.floor(Date.now() / 1000)
  replace(entitlement, issueHostEntitlement(root, hostId, { issued_at: now - 100, expires_at: now }).code)
  await assertDenied(context, 'license_expired')
  replace(entitlement, issueHostEntitlement(root, hostId, { issued_at: now + 86400, expires_at: now + 172800 }).code)
  await assertDenied(context, 'license_not_yet_valid')
  replace(entitlement, host.code)
  fs.writeFileSync(path.join(publicDir, 'sync-pending'), '')
  assert.equal(checkCragLicense(root, vm).ok, true)
  fs.unlinkSync(path.join(publicDir, 'sync-pending'))
  assert.equal(checkCragLicense(root, vm).ok, true)
  for (const broken of ['CRAGS1.broken.signature', 'CRAGS1']) {
    replace(registration, broken)
    await assertDenied(context, 'license_invalid')
    assert.equal(projectLocalGrant(root, vm, issueUniversalCode(root).code), false)
  }
  replace(registration, permit.code)
  fs.unlinkSync(entitlement)
  await assertDenied(context, 'license_required')
  assert.equal(getCragLicense(root, vm, { initialize: true }).license.valid, false)
  assert.equal(projectLocalGrant(root, vm, issueUniversalCode(root).code), false)
  assert.equal(fs.readFileSync(registration, 'utf8'), permit.code)
})

test('U1 projection and manual U1 activation cannot cover an invalid S1; legacy slots still work', async (t) => {
  const { root, vm, registration, entitlement, machineCode } = fixture(t)
  const before = fs.readFileSync(registration)
  fs.unlinkSync(entitlement)
  const universal = issueUniversalCode(root)
  assert.equal(activateCragLicense(root, vm, universal.code).license.scope, 'kernel')
  assert.equal(checkCragLicense(root, vm).ok, false)
  assert.equal(projectLocalGrant(root, vm, universal.code), false)
  await projectCragUniversalVm(root, vm)
  assert.deepEqual(fs.readFileSync(registration), before)
  const legacy = { id: 'vm-legacy', dataplane: 'crag' }
  assert.equal(checkCragLicense(root, legacy).ok, true)
  activateCragLicense(root, vm, issueFixtureCode(root, machineCode, { term: '3m' }).code)
  assert.equal(getCragLicense(root, vm).license.scope, 'device')
  assert.equal(checkCragLicense(root, vm).ok, true)
  assert.equal(projectLocalGrant(root, vm, universal.code), false)
})

test('remote projection preserves S1 and refuses unreadable registration instead of overwriting it', async (t) => {
  const { root, vm } = fixture(t)
  activateCragLicense(root, vm, issueUniversalCode(root).code)
  let exitCode = 0
  let calls = 0
  const client = {
    exec(_command, callback) {
      calls++
      const stream = new EventEmitter()
      stream.stderr = new EventEmitter()
      callback(null, stream)
      queueMicrotask(() => {
        stream.emit('data', Buffer.from('CRAGS1.preserved.even-if-invalid\n').toString('base64'))
        stream.emit('exit', exitCode)
        stream.emit('close')
      })
    },
    sftp() {
      assert.fail('must not start an SFTP write')
    },
  }
  bindPlacement({
    projectRoot: root,
    manager: {
      client: () => client,
      remoteHost: async () => ({ uid: 1000, gid: 1000, root: '/fixture' }),
    },
  })
  t.after(unbindPlacement)
  const remote = { id: 'vm-remote', node_id: 'node-fixture' }
  assert.deepEqual(await projectCragUniversalVm(root, remote), { ok: true })
  assert.equal(calls, 1)
  exitCode = 4
  await assert.rejects(projectCragUniversalVm(root, remote), { code: 'remote_read_refused' })
  assert.equal(calls, 2)
})

test('fully signed wrong binding and unwrap data never replace S1 or reach the raw client', async (t) => {
  const context = fixture(t)
  const { root, vm, machineCode, hostId, registration, permit } = context
  const originalPermit = fs.readFileSync(registration)
  assert.throws(() => activateCragSubscriptionBinding(root, vm, permit.code, { seat: 1 }), {
    code: 'license_binding_mismatch',
  })
  assert.deepEqual(fs.readFileSync(registration), originalPermit)
  assert.equal(activateCragSubscriptionBinding(root, vm, permit.code, { seat: 2 }).license.seat, 2)
  const otherKey = crypto.generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }).x
  const cases = [
    [{ host_id: '0'.repeat(64) }, {}, 'license_binding_mismatch'],
    [{ vm_id: 'vm-other' }, {}, 'license_binding_mismatch'],
    [{ machine_id_hash: '0'.repeat(64) }, {}, 'license_binding_mismatch'],
    [{ device_public_key: otherKey }, {}, 'license_binding_mismatch'],
    [{}, { devicePublicKey: otherKey }, 'license_invalid'],
    [{}, { aad: 'incorrect binding' }, 'license_invalid'],
    [{}, { payload: crypto.randomBytes(32) }, 'license_invalid'],
    [{}, { keyId: 'f'.repeat(64) }, 'license_payload_key_mismatch'],
    [
      { wrapped_key: { ...permit.claims.wrapped_key, ephemeral_public_key: Buffer.alloc(32).toString('base64url') } },
      {},
      'license_invalid',
    ],
  ]
  for (const [overrides, wrap, code] of cases) {
    const invalid = issueSlotPermit(root, machineCode, hostId, overrides, wrap).code
    const original = fs.readFileSync(registration)
    assert.throws(() => activateCragSubscriptionBinding(root, vm, invalid), { code })
    assert.deepEqual(fs.readFileSync(registration), original)
    replace(registration, invalid)
    await assertDenied(context, code)
    replace(registration, original)
  }
})

test('signed malformed JSON, encodings, shapes and bounds match native rejection', (t) => {
  const { root, vm, hostId, host, permit, registration } = fixture(t)
  const hostRaw = JSON.stringify(host.claims)
  const permitRaw = JSON.stringify(permit.claims)
  const invalidHost = [
    hostRaw.replace('"revision":1', '"revision":0'),
    hostRaw.replace('"revision":1', '"revision":1.0'),
    hostRaw.replace('"revision":1', '"revision":1e0'),
    hostRaw.replace('"issued_at":', '"issued_at":-'),
    hostRaw.replace('"slot_limit":2', '"slot_limit":2147483648'),
    ...['0', '-1', 'null', 'true', '[]', '"2"', '"Unlimited"'].map((value) =>
      hostRaw.replace('"slot_limit":2', `"slot_limit":${value}`),
    ),
    hostRaw.replace(',"slot_limit":2', ''),
    hostRaw.replace('"revision":1', '"revision":1,"revis\\u0069on":2'),
    hostRaw.replace('{', '{"unknown":1,'),
    hostRaw.replace('"crag-v2"', '"crag-v2\\ud800"'),
    `[${hostRaw}]`,
    `\ufeff${hostRaw}`,
    hostRaw + 'null',
    hostRaw.replace('}', ',}'),
    Buffer.concat([Buffer.from(hostRaw.slice(0, -1)), Buffer.from([0xff]), Buffer.from('}')]),
  ]
  for (const raw of invalidHost) {
    const code = signSubscriptionBytes(root, 'CRAGH1', raw)
    assert.throws(() => verifyCragHostEntitlement(root, code, hostId), { code: 'license_invalid' })
  }
  const invalidPermit = [
    ...['0', '-0', '4294967296', '2.0', '2e0', '"2"', 'null'].map((value) =>
      permitRaw.replace('"seat":2', `"seat":${value}`),
    ),
    permitRaw.replace('"seat":2', '"seat":2,"seat":1'),
    permitRaw.replace('"wrapped_key":{', '"wrapped_key":{"unknown":1,'),
    permitRaw.replace('"wrapped_key":{', `"wrapped_key":{"nonce":"${permit.claims.wrapped_key.nonce}",`),
    permitRaw.replace('"product":"crag-v2",', ''),
    permitRaw.replace('{', '{"unknown":1,'),
  ]
  const original = fs.readFileSync(registration)
  for (const raw of invalidPermit) {
    assert.throws(() => activateCragSubscriptionBinding(root, vm, signSubscriptionBytes(root, 'CRAGS1', raw)), {
      code: 'license_invalid',
    })
    assert.deepEqual(fs.readFileSync(registration), original)
  }
})

test('signature tampering, foreign signers and package replacement invalidate both credentials', async (t) => {
  const context = fixture(t)
  const foreign = fixture(t)
  const { root, vm, hostId, entitlement, host, registration, permit, pkg } = context
  replace(entitlement, issueHostEntitlement(foreign.root, hostId).code)
  await assertDenied(context, 'license_invalid')
  replace(entitlement, host.code)
  const tampered = Buffer.from(JSON.stringify({ ...permit.claims, seat: 1 })).toString('base64url')
  replace(registration, `CRAGS1.${tampered}.${permit.code.split('.')[2]}`)
  await assertDenied(context, 'license_invalid')
  replace(registration, permit.code)
  fs.appendFileSync(path.join(pkg, 'crag-v2.payload.enc'), 'tamper')
  await assertDenied(context, 'license_unconfigured')
  assert.throws(() => verifyCragHostEntitlement(root, host.code, hostId), { code: 'license_unconfigured' })
  assert.throws(() => prepareCragSubscriptionBinding(root, vm), { code: 'license_unconfigured' })
})

for (const placement of [
  { node_id: 'mac', node_platform: 'darwin' },
  { node_platform: 'darwin' },
  { platform: 'openai' },
  { family: 'codex' },
  { runtime: { type: 'native' } },
]) {
  test(`S1 rejects unsupported placement ${JSON.stringify(placement)} even with shared U1`, (t) => {
    const { root, vm, permit } = fixture(t)
    activateCragLicense(root, vm, issueUniversalCode(root).code)
    const unsupported = { ...vm, ...placement }
    assert.throws(() => prepareCragSubscriptionBinding(root, unsupported), { code: 'license_unconfigured' })
    assert.throws(() => activateCragSubscriptionBinding(root, unsupported, permit.code), {
      code: 'license_unconfigured',
    })
    assert.equal(getCragLicense(root, unsupported).license.valid, false)
    assert.throws(() => readCragSubscriptionFiles(root, unsupported), { code: 'license_unconfigured' })
  })
}

test('KVM rejects a permit when its guest machine ID differs from the bound identity', (t) => {
  const { root, vm } = fixture(t)
  const guest = { ...vm, runtime: { type: 'kvm' } }
  guest.fingerprint = { guest_machine_id: fs.readFileSync(path.join(root, 'vms', vm.id, 'machine-id'), 'utf8').trim() }
  assert.equal(checkCragLicense(root, guest).ok, true)
  guest.fingerprint.guest_machine_id = crypto.randomBytes(16).toString('hex')
  assert.equal(checkCragLicense(root, guest).code, 'license_binding_mismatch')
})

test('KVM guest publication sends only the verified slot bundle over stdin and checks for entitlement changes', async (t) => {
  const { root, vm, hostId, host, permit, entitlement } = fixture(t)
  const guest = { ...vm, runtime: { type: 'kvm', container: 'test-kvm' } }
  guest.fingerprint = { guest_machine_id: fs.readFileSync(path.join(root, 'vms', vm.id, 'machine-id'), 'utf8').trim() }
  const sent = []
  const runDockerExec = async (argv, opts) => {
    if (argv[0] === 'container') return { ok: true, code: 0, stdout: 'true' }
    assert.deepEqual(argv.slice(0, 9), [
      'exec',
      '-i',
      'test-kvm',
      '/usr/local/bin/kin-guest-exec',
      '-u',
      '0',
      '-i',
      '--',
      'python3',
    ])
    assert.ok(opts.timeoutMs > 0)
    assert.ok(!argv.join(' ').includes(permit.code))
    const request = JSON.parse(opts.input)
    assert.equal(request.action, 'publish')
    sent.push(request.files)
    return { ok: true, code: 0 }
  }
  await Promise.all([
    publishKvmCragLicense(root, guest, { runDockerExec }),
    publishKvmCragLicense(root, guest, { runDockerExec }),
  ])
  assert.equal(sent.length, 2)
  assert.deepEqual(Object.keys(sent[0]).sort(), ['device', 'entitlement', 'hostId', 'permit'])
  assert.equal(sent[0].hostId, hostId)
  assert.equal(sent[0].permit, permit.code)
  assert.equal(sent[0].entitlement, host.code)
  const renewal = issueHostEntitlement(root, hostId, { revision: 2 })
  replace(entitlement, renewal.code)
  await publishKvmCragLicense(root, guest, { runDockerExec })
  assert.equal(sent.length, 3)
  assert.equal(sent[2].entitlement, renewal.code)
})

test('remote KVM keeps the upstream normalized identity and signed subscription export', (t) => {
  const { root, vm, machineCode, hostId, permit } = fixture(t)
  const machine = vm.fingerprint.guest_machine_id
  const remote = {
    ...vm,
    node_id: 'remote-kvm',
    runtime: { type: 'qemu' },
    fingerprint: { machine_id: ` ${machine.match(/.{8}/g).join('-').toUpperCase()} ` },
  }
  assert.equal(prepareCragSubscriptionBinding(root, remote), machineCode)
  assert.equal(getCragLicense(root, remote).license.valid, true)
  assert.equal(readCragSubscriptionFiles(root, remote).permit, permit.code)
  assert.equal(readKvmCragLicense(root, remote).permit, permit.code)
  assert.equal(readCragClusterSubscription(root, remote), null)
  assert.equal(
    readCragSubscriptionReleaseCandidate(root, remote, hostId),
    crypto.createHash('sha256').update(permit.code).digest('hex'),
  )
})

test('explicit installation can authenticate an old host permit against the current trusted issuer without trusting a partial installed tree', (t) => {
  const { root, vm, hostId, permit, machineCode } = fixture(t)
  const installed = path.join(root, 'vms', vm.id, 'cli-home', '.kin', 'crag-v2')
  fs.mkdirSync(path.join(installed, 'claude-code-2.1.321'), { recursive: true })
  seedEncryptedPackage(root, { payloadKey: crypto.randomBytes(32) })
  assert.equal(getCragLicense(root, vm).license.code, 'license_unconfigured')
  assert.throws(() => readCragSubscriptionReleaseCandidate(root, vm, hostId), { code: 'license_unconfigured' })
  assert.throws(() => prepareCragSubscriptionBinding(root, vm), { code: 'license_unconfigured' })
  assert.equal(prepareCragSubscriptionBinding(root, vm, { preferInstalled: false }), machineCode)
  assert.equal(
    readCragSubscriptionReleaseCandidate(root, vm, hostId, { preferInstalled: false }),
    crypto.createHash('sha256').update(permit.code).digest('hex'),
  )
  assert.equal(getCragLicense(root, vm).license.code, 'license_unconfigured', 'ordinary reads must remain fail closed')
})

for (const invalid of ['wrong-host', 'wrong-vm', 'wrong-issuer', 'tampered-candidate']) {
  test(`explicit installation refuses to authenticate a host permit with ${invalid}`, (t) => {
    const { root, vm, hostId, machineCode, registration, pkg } = fixture(t)
    if (invalid === 'wrong-host') replace(registration, issueSlotPermit(root, machineCode, '0'.repeat(64)).code)
    if (invalid === 'wrong-vm')
      replace(registration, issueSlotPermit(root, machineCode, hostId, { vm_id: 'vm-other' }).code)
    if (invalid === 'wrong-issuer') {
      const other = fixture(t)
      replace(registration, issueSlotPermit(other.root, machineCode, hostId).code)
    }
    if (invalid === 'tampered-candidate') fs.appendFileSync(path.join(pkg, 'crag-v2.payload.enc'), 'tampered')
    assert.throws(() => readCragSubscriptionReleaseCandidate(root, vm, hostId, { preferInstalled: false }))
  })
}

test('KVM independent export preserves U1 on both local and remote placements', (t) => {
  const { root, vm } = fixture(t, { activate: false })
  const universal = issueUniversalCode(root)
  activateCragLicense(root, vm, universal.code)
  for (const node_id of [undefined, 'remote-kvm']) {
    const target = { ...vm, node_id, runtime: { type: 'kvm' } }
    assert.deepEqual(readKvmCragLicense(root, target), { permit: universal.code })
  }
})

test('host storage refuses links, writable files/directories and pending symlinks', async (t) => {
  const context = fixture(t)
  const { publicDir, entitlement, root } = context
  for (const file of [entitlement, path.join(publicDir, 'host_id')]) {
    fs.chmodSync(file, 0o666)
    await assertDenied(context, 'license_invalid')
    fs.chmodSync(file, 0o644)
    const link = path.join(root, 'linked-public-file')
    fs.linkSync(file, link)
    await assertDenied(context, 'license_invalid')
    fs.unlinkSync(link)
    fs.renameSync(file, link)
    fs.symlinkSync(link, file)
    await assertDenied(context, 'license_invalid')
    fs.unlinkSync(file)
    fs.renameSync(link, file)
  }
  fs.chmodSync(publicDir, 0o777)
  await assertDenied(context, 'license_invalid')
  fs.chmodSync(publicDir, 0o755)
  fs.symlinkSync(path.join(root, 'missing'), path.join(publicDir, 'sync-pending'))
  await assertDenied(context, 'license_invalid')
  fs.unlinkSync(path.join(publicDir, 'sync-pending'))
  const moved = `${publicDir}-moved`
  fs.renameSync(publicDir, moved)
  fs.symlinkSync(moved, publicDir)
  await assertDenied(context, 'license_invalid')
})

test('a Linux cluster slot uses signed host rights and exports only its own device and permit', (t) => {
  const { root, vm, host, hostId, permit, machineCode } = fixture(t, { activate: false })
  const cluster = { ...vm, node_id: 'linux-worker' }
  assert.equal(prepareCragSubscriptionBinding(root, cluster), machineCode)
  assert.equal(activateCragSubscriptionBinding(root, cluster, permit.code).license.valid, true)
  assert.equal(getCragLicense(root, cluster).license.scope, 'host')
  const files = readCragClusterSubscription(root, cluster)
  assert.deepEqual(Object.keys(files).sort(), ['device', 'entitlement', 'hostId', 'permit'])
  assert.equal(JSON.parse(files.device).vm_id, vm.id)
  assert.equal(files.hostId, hostId)
  assert.equal(files.entitlement, host.code)
  assert.equal(files.permit, permit.code)
})

test('private registration/device links and malformed device JSON cannot unlock S1', async (t) => {
  const context = fixture(t)
  const { root, dir, registration } = context
  for (const file of [registration, path.join(dir, 'device.json')]) {
    const link = path.join(root, 'linked-private-file')
    fs.linkSync(file, link)
    await assertDenied(context, 'license_invalid')
    fs.unlinkSync(link)
  }
  const device = path.join(dir, 'device.json')
  replace(device, fs.readFileSync(device, 'utf8').replace('{', '{"version":1,'))
  await assertDenied(context, 'license_invalid')
})

test('replacement during signature verification fails closed and atomic save failure retains S1', async (t) => {
  const context = fixture(t)
  const { root, vm, hostId, entitlement, registration, dir, permit } = context
  const verify = crypto.verify
  let replaced = false
  try {
    crypto.verify = (...args) => {
      const verified = verify(...args)
      if (!replaced && args[1].subarray(0, 7).toString() === 'CRAGS1\0') {
        replaced = true
        replace(entitlement, issueHostEntitlement(root, hostId, { slot_limit: 1, revision: 2 }).code)
      }
      return verified
    }
    assert.equal(checkCragLicense(root, vm).code, 'license_invalid')
  } finally {
    crypto.verify = verify
  }
  assert.equal(replaced, true)
  replace(entitlement, issueHostEntitlement(root, hostId).code)
  const original = fs.readFileSync(registration)
  const rename = fs.renameSync
  try {
    fs.renameSync = (source, target) => {
      if (target.endsWith('/registration.code'))
        throw Object.assign(new Error('fixture rename failure'), { code: 'EACCES' })
      return rename(source, target)
    }
    assert.throws(() => activateCragSubscriptionBinding(root, vm, permit.code), { code: 'license_invalid' })
  } finally {
    fs.renameSync = rename
  }
  assert.deepEqual(fs.readFileSync(registration), original)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['device.json', 'registration.code'])
  assert.equal(checkCragLicense(root, vm).ok, true)
})
