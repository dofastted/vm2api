import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  activateCragLicense,
  checkCragLicense,
  cragLicenseDirectory,
  getCragLicense,
  verifyCragRegistration,
} from '../../src/lib/vm/crag-license.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { dispatchCallInference } from '../../src/lib/transport/kernel-router.mjs'
import { callRustKernel, isNeedsRefreshResult, streamRustKernel } from '../../src/lib/transport/rust-kernel-client.mjs'
import { writeKernelConfig } from '../../src/lib/transport/rust-kernel-supervisor.mjs'
import { classifyUpstreamResult, shouldContinue } from '../../src/lib/pool/upstream-error-policy.mjs'
import { mapUpstreamError } from '../../src/lib/core/errors.mjs'
import { materializeCragV2, materializeSlotDataplane, verifyCragV2Tree } from '../../src/lib/vm/wrap-cli-runtime.mjs'
import {
  activateFixture,
  calendarExpiry,
  fixtureAuthority,
  issueFixtureCode,
  seedEncryptedPackage,
  issueUniversalCode,
  signedCode,
} from '../fixtures/crag-license.mjs'

const savedEnv = { run: process.env.KIN_SLOT_RUN_ROOT, pkg: process.env.KIN_CRAG_V2_ROOT }
before(() => {
  delete process.env.KIN_SLOT_RUN_ROOT
  delete process.env.KIN_CRAG_V2_ROOT
})
after(() => {
  for (const [key, value] of [
    ['KIN_SLOT_RUN_ROOT', savedEnv.run],
    ['KIN_CRAG_V2_ROOT', savedEnv.pkg],
  ]) {
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
})
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-license-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vm = { id: 'vm-13', status: 'stopped', dataplane: 'wrap' }
  fs.mkdirSync(path.join(root, 'vms', vm.id), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  fs.writeFileSync(path.join(root, 'vms', vm.id, 'machine-id'), crypto.randomBytes(16).toString('hex') + '\n')
  const pkg = seedEncryptedPackage(root)
  return { root, vm, pkg }
}
function route(root, method, suffix, body, role = 'admin') {
  const result = {}
  const handle = createPanelHandler({
    cfg: { paths: { project: root }, vm: { id: null } },
    routingConfig: {},
    requireAuth(req) {
      req.panelUser = 'fixture'
      req.panelRole = role
      return true
    },
    readBody: async () => body,
    json(_res, status, value) {
      result.status = status
      result.body = value
      return true
    },
    proxyPool: { unbindVm() {} },
  })
  return handle({ method }, {}, new URL(`http://localhost/api/panel/vms/vm-13${suffix}`)).then(() => result)
}

test('challenge and atomic activation expose only authenticated public status', async (t) => {
  const { root, vm } = fixture(t)
  assert.equal(fs.existsSync(cragLicenseDirectory(root, vm)), false)
  const initial = await route(root, 'GET', '/crag-license')
  assert.equal(initial.status, 200)
  assert.equal(initial.body.data.license.status, 'unlicensed')
  const challenge = initial.body.data.machine_code
  assert.match(challenge, /^CRAGM1\./)
  const issued = issueFixtureCode(root, challenge)
  const activated = await route(root, 'POST', '/crag-license', { registration_code: issued.code })
  assert.equal(activated.status, 200)
  assert.equal(activated.body.data.license.expires_at, issued.claims.expires_at)
  assert.equal(activated.body.data.license.valid, true)
  assert.equal(activated.body.data.license.kind, 'online')
  assert.doesNotMatch(JSON.stringify(activated.body), /CRAGL1|private_key|wrapped_key|ciphertext/)
  const dir = cragLicenseDirectory(root, vm)
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
  for (const name of ['device.json', 'registration.code'])
    assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600)
  const stored = fs.readFileSync(path.join(dir, 'registration.code'))
  const denied = await route(root, 'POST', '/crag-license', { registration_code: issued.code + 'x' })
  assert.equal(denied.status, 403)
  assert.equal(denied.body.error.code, 'license_invalid')
  assert.deepEqual(fs.readFileSync(path.join(dir, 'registration.code')), stored)
  assert.equal(getCragLicense(root, vm).license.valid, true)
})

test('universal CRAGU1 activates without creating a device binding', async (t) => {
  const { root, vm } = fixture(t)
  const issued = issueUniversalCode(root)
  const activated = await route(root, 'POST', '/crag-license', { registration_code: issued.code })
  assert.equal(activated.status, 200)
  assert.equal(activated.body.data.license.valid, true)
  assert.equal(activated.body.data.license.kind, 'offline')
  assert.equal(activated.body.data.license.license_id, issued.claims.license_id)
  assert.equal(activated.body.data.machine_code, '')
  assert.doesNotMatch(JSON.stringify(activated.body), /CRAGU1|wrapped_key|ciphertext|private_key/)
  const dir = cragLicenseDirectory(root, vm)
  assert.equal(fs.existsSync(path.join(dir, 'device.json')), false)
  assert.equal(fs.statSync(path.join(dir, 'registration.code')).mode & 0o777, 0o600)
  const stored = fs.readFileSync(path.join(dir, 'registration.code'))
  assert.throws(() => activateCragLicense(root, vm, `${issued.code}x`), { code: 'license_invalid' })
  assert.deepEqual(fs.readFileSync(path.join(dir, 'registration.code')), stored)
  const current = getCragLicense(root, vm)
  assert.equal(current.license.valid, true)
  assert.equal(current.machine_code, '')
  const panel = await route(root, 'GET', '/crag-license')
  assert.equal(panel.status, 200)
  assert.equal(panel.body.data.license.kind, 'offline')
  assert.match(panel.body.data.machine_code, /^CRAGM1\./)
  assert.equal(fs.existsSync(path.join(dir, 'device.json')), true)
  assert.equal(checkCragLicense(root, { ...vm, dataplane: 'crag' }).ok, true)
  const expired = issueUniversalCode(root, { issued_at: Math.floor(Date.now() / 1000) - 70 * 86400 })
  assert.throws(() => activateCragLicense(root, vm, expired.code), { code: 'license_expired' })
  assert.deepEqual(fs.readFileSync(path.join(dir, 'registration.code')), stored)
})

test('wrong VM, machine, signer, tamper and wrapped-key failure never replace an existing grant', (t) => {
  const { root, vm } = fixture(t)
  const active = activateFixture(root, vm)
  const authority = fixtureAuthority(root)
  const { code, claims } = issueFixtureCode(root, active.machine_code)
  const stored = fs.readFileSync(path.join(cragLicenseDirectory(root, vm), 'registration.code'))
  const cases = [
    [signedCode(authority, { ...claims, vm_id: 'vm-other' }), 'license_binding_mismatch'],
    [signedCode(authority, { ...claims, machine_id_hash: '0'.repeat(64) }), 'license_binding_mismatch'],
    [signedCode(crypto.generateKeyPairSync('ed25519'), claims), 'license_invalid'],
    [code.replace('CRAGL1.', 'CRAGL1.A'), 'license_invalid'],
    [
      signedCode(authority, {
        ...claims,
        wrapped_key: { ...claims.wrapped_key, tag: Buffer.alloc(16).toString('base64url') },
      }),
      'license_invalid',
    ],
    [signedCode(authority, { ...claims, term: 'forever' }), 'license_invalid'],
    [signedCode(authority, { ...claims, expires_at: claims.expires_at + 1 }), 'license_invalid'],
  ]
  for (const [candidate, expected] of cases) {
    assert.throws(() => activateCragLicense(root, vm, candidate), { code: expected })
    assert.deepEqual(fs.readFileSync(path.join(cragLicenseDirectory(root, vm), 'registration.code')), stored)
  }
  fs.writeFileSync(path.join(root, 'vms', vm.id, 'machine-id'), '1'.repeat(32))
  assert.equal(getCragLicense(root, vm).license.code, 'license_binding_mismatch')
})

test('expiry and future grants are terminal licensing failures, not refresh or model failover', async (t) => {
  const { root, vm } = fixture(t)
  const active = activateFixture(root, vm)
  const old = issueFixtureCode(root, active.machine_code, { issued_at: Math.floor(Date.now() / 1000) - 70 * 86400 })
  assert.throws(() => activateCragLicense(root, vm, old.code), { code: 'license_expired' })
  const future = issueFixtureCode(root, active.machine_code, { issued_at: Math.floor(Date.now() / 1000) + 86400 })
  assert.throws(() => activateCragLicense(root, vm, future.code), { code: 'license_not_yet_valid' })
  fs.writeFileSync(path.join(cragLicenseDirectory(root, vm), 'registration.code'), old.code)
  const exec = {
    projectRoot: root,
    homeDir: path.join(root, 'vms', vm.id, 'cli-home'),
    vm: { ...vm, dataplane: 'crag' },
  }
  let refresh = 0
  for (const result of [
    await dispatchCallInference({
      exec,
      ensureCredential: () => {
        refresh++
        throw new Error('must not refresh')
      },
    }),
    await callRustKernel({ exec }),
    await streamRustKernel({ exec }),
  ]) {
    assert.equal(result.status, 403)
    assert.equal(result.body.error.code, 'license_expired')
    assert.equal(result.upstreamExecutions, 0)
    assert.equal(isNeedsRefreshResult(result), false)
    const policy = classifyUpstreamResult(result, { model: 'claude-fable-5' })
    assert.equal(policy.action, 'stop')
    assert.equal(shouldContinue(policy), false)
    assert.equal(mapUpstreamError(result.status, result.body).body.error.code, 'license_expired')
  }
  assert.equal(refresh, 0)
})

test('calendar terms clamp UTC month-end and leap-year exactly', (t) => {
  const { root, vm } = fixture(t)
  const challenge = getCragLicense(root, vm, { initialize: true }).machine_code
  const device = JSON.parse(fs.readFileSync(path.join(cragLicenseDirectory(root, vm), 'device.json')))
  const authority = fixtureAuthority(root)
  for (const [start, term, end] of [
    ['2024-01-31T12:34:56Z', '1m', '2024-02-29T12:34:56Z'],
    ['2024-02-29T12:34:56Z', '1y', '2025-02-28T12:34:56Z'],
    ['2025-08-31T12:34:56Z', '6m', '2026-02-28T12:34:56Z'],
  ]) {
    const issued = Date.parse(start) / 1000
    const { code, claims } = issueFixtureCode(root, challenge, { issued_at: issued, term })
    assert.equal(claims.expires_at, Date.parse(end) / 1000)
    assert.equal(calendarExpiry(issued, term), claims.expires_at)
    const options = { device, publicKey: authority.publicKey, keyId: claims.payload_key_id }
    assert.equal(verifyCragRegistration(code, { ...options, now: issued }).valid, true)
    assert.equal(verifyCragRegistration(code, { ...options, now: claims.expires_at }).code, 'license_expired')
  }
})

test('atomic publication failure retains valid registration bytes and removes temporary files', (t) => {
  const { root, vm } = fixture(t)
  const active = activateFixture(root, vm)
  const dir = cragLicenseDirectory(root, vm)
  const old = fs.readFileSync(path.join(dir, 'registration.code'))
  const rename = fs.renameSync
  try {
    fs.renameSync = (source, dest) => {
      if (dest === path.join(dir, 'registration.code'))
        throw Object.assign(new Error('fixture failure'), { code: 'EACCES' })
      return rename(source, dest)
    }
    assert.throws(() => activateCragLicense(root, vm, issueFixtureCode(root, active.machine_code).code), {
      code: 'license_invalid',
    })
  } finally {
    fs.renameSync = rename
  }
  assert.deepEqual(fs.readFileSync(path.join(dir, 'registration.code')), old)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['device.json', 'registration.code'])
  assert.equal(getCragLicense(root, vm).license.valid, true)
})

test('PATCH and direct materializers refuse legacy and V2 bypass before metadata changes; wrap stays free', async (t) => {
  const { root, vm } = fixture(t)
  const file = path.join(root, 'vms', `${vm.id}.json`)
  const original = fs.readFileSync(file)
  for (const version of ['legacy', 'v2']) {
    const denied = await route(root, 'PATCH', '', { dataplane: 'crag', crag_kernel_version: version, weight: 9 })
    assert.equal(denied.status, 403)
    assert.equal(denied.body.error.code, 'license_required')
    assert.deepEqual(fs.readFileSync(file), original)
    assert.equal(
      materializeSlotDataplane(root, { ...vm, crag_kernel_version: version }, 'crag').code,
      'license_required',
    )
  }
  assert.equal(checkCragLicense(root, vm).ok, true)
  assert.equal(fs.existsSync(cragLicenseDirectory(root, vm)), false)
  fs.mkdirSync(path.join(root, 'share/wrap-cli'), { recursive: true })
  for (const name of ['cli-node', 'cc-node', 'kin-kernel'])
    fs.writeFileSync(path.join(root, 'share/wrap-cli', name), 'free-cli', { mode: 0o755 })
  assert.equal(materializeSlotDataplane(root, vm, 'wrap').ok, true)
  const mock = process.env.KIN_CRS_MOCK
  const trace = process.env.KIN_CRS_TRACE_FILE
  const fallbackTrace = process.env.KIN_MOCK_TRACE_FILE
  try {
    process.env.KIN_CRS_MOCK = '1'
    process.env.KIN_CRS_TRACE_FILE = path.join(root, 'free-cli-trace.json')
    delete process.env.KIN_MOCK_TRACE_FILE
    const result = await callRustKernel({
      exec: { projectRoot: root, vm, homeDir: path.join(root, 'vms', vm.id, 'cli-home') },
      body: { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'fixture' }] },
    })
    assert.equal(result.ok, true)
    assert.equal(fs.existsSync(cragLicenseDirectory(root, vm)), false)
  } finally {
    for (const [key, value] of [
      ['KIN_CRS_MOCK', mock],
      ['KIN_CRS_TRACE_FILE', trace],
      ['KIN_MOCK_TRACE_FILE', fallbackTrace],
    ]) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  }
  activateFixture(root, vm)
  assert.equal(materializeCragV2(root, vm).ok, true)
  const switched = await route(root, 'PATCH', '', { dataplane: 'crag', crag_kernel_version: 'v2' })
  assert.equal(switched.status, 200)
  const config = JSON.parse(fs.readFileSync(path.join(root, 'vms', vm.id, 'run/kernel.json')))
  assert.equal(config.license_dir, '/run/kin/crag-license')
})

test('encrypted package rejects ciphertext tamper, unsigned rehash and old plain manifests', (t) => {
  const { pkg } = fixture(t)
  assert.equal(verifyCragV2Tree(pkg).ok, true)
  const payload = path.join(pkg, 'crag-v2.payload.enc')
  fs.appendFileSync(payload, 'tamper')
  assert.equal(verifyCragV2Tree(pkg).code, 'crag_v2_hash_mismatch')
  const file = path.join(pkg, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(file))
  manifest.payload.ciphertext_sha256 = manifest.sha256['crag-v2.payload.enc'] = crypto
    .createHash('sha256')
    .update(fs.readFileSync(payload))
    .digest('hex')
  fs.writeFileSync(file, JSON.stringify(manifest))
  assert.equal(verifyCragV2Tree(pkg).code, 'crag_v2_manifest_invalid')
  delete manifest.encrypted
  fs.writeFileSync(file, JSON.stringify(manifest))
  assert.equal(verifyCragV2Tree(pkg).code, 'crag_v2_manifest_invalid')
})

for (const mutation of [
  'native member replacement',
  'in-place member tamper',
  'public key and authorization replacement',
  'signed manifest replacement',
  'unlisted member addition',
  'hashed member removal',
]) {
  test(`cached package trust rejects ${mutation} on the next license admission`, async (t) => {
    const { root, vm, pkg } = fixture(t)
    activateFixture(root, vm)
    const selected = { ...vm, dataplane: 'crag', crag_kernel_version: 'v2' }
    assert.equal(checkCragLicense(root, selected).ok, true)
    assert.equal(getCragLicense(root, vm).license.valid, true)
    const manifestPath = path.join(pkg, 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath))
    const replace = (name, bytes) => {
      const file = path.join(pkg, name)
      const original = fs.statSync(file)
      const temporary = `${file}.replacement`
      fs.writeFileSync(temporary, bytes, { mode: original.mode & 0o777 })
      fs.utimesSync(temporary, original.atime, original.mtime)
      fs.renameSync(temporary, file)
    }
    if (mutation === 'native member replacement') {
      const bytes = fs.readFileSync(path.join(pkg, 'claude-code-2.1.317/claude'))
      bytes[bytes.length - 1] ^= 1
      replace('claude-code-2.1.317/claude', bytes)
    } else if (mutation === 'in-place member tamper') {
      const file = path.join(pkg, 'crag-v2.payload.enc')
      const original = fs.statSync(file)
      const bytes = fs.readFileSync(file)
      bytes[bytes.length - 1] ^= 1
      fs.writeFileSync(file, bytes)
      fs.utimesSync(file, original.atime, original.mtime)
    } else if (mutation === 'public key and authorization replacement') {
      const pair = crypto.generateKeyPairSync('ed25519')
      const pem = pair.publicKey.export({ format: 'pem', type: 'spki' })
      const raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
      replace('crag-license-public.pem', pem)
      manifest.authorization.public_key = raw.toString('base64url')
      manifest.authorization.public_key_id = crypto.createHash('sha256').update(raw).digest('hex')
      manifest.sha256['crag-license-public.pem'] = crypto.createHash('sha256').update(pem).digest('hex')
      replace('manifest.json', JSON.stringify(manifest))
    } else if (mutation === 'signed manifest replacement') {
      const signature = Buffer.from(manifest.payload.signature, 'base64url')
      signature[0] ^= 1
      manifest.payload.signature = signature.toString('base64url')
      replace('manifest.json', JSON.stringify(manifest))
    } else if (mutation === 'unlisted member addition') {
      fs.writeFileSync(path.join(pkg, 'unexpected-member'), 'untrusted')
    } else {
      fs.unlinkSync(path.join(pkg, 'crag-v2.payload.enc'))
    }
    const denied = checkCragLicense(root, selected)
    assert.equal(denied.ok, false)
    assert.equal(denied.code, 'license_unconfigured')
    const result = await callRustKernel({ exec: { projectRoot: root, vm: selected } })
    assert.equal(result.status, 403)
    assert.equal(result.body.error.code, 'license_unconfigured')
    assert.equal(result.upstreamExecutions, 0)
  })
}

for (const environmentOverride of [false, true]) {
  test(`license identity persists in ${environmentOverride ? 'explicit environment' : 'recorded Linux runtime'} run mapping`, async (t) => {
    const { root, vm } = fixture(t)
    const linuxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crag-mapped-run-'))
    t.after(() => fs.rmSync(linuxRoot, { recursive: true, force: true }))
    const recordedRun = path.join(linuxRoot, 'recorded', vm.id)
    const mappedVm = { ...vm, runtime: { type: 'docker', worker_run_dir: recordedRun } }
    fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(mappedVm))
    const previous = process.env.KIN_SLOT_RUN_ROOT
    try {
      if (environmentOverride) process.env.KIN_SLOT_RUN_ROOT = path.join(linuxRoot, 'explicit')
      else delete process.env.KIN_SLOT_RUN_ROOT
      const expectedRun = environmentOverride ? path.join(linuxRoot, 'explicit', vm.id) : recordedRun
      const initial = await route(root, 'GET', '/crag-license')
      assert.equal(initial.status, 200)
      assert.equal(initial.body.data.license.status, 'unlicensed')
      const challenge = initial.body.data.machine_code
      const issued = issueFixtureCode(root, challenge)
      const activated = await route(root, 'POST', '/crag-license', { registration_code: issued.code })
      assert.equal(activated.status, 200)
      assert.equal(activated.body.data.license.valid, true)
      const privateDir = path.join(expectedRun, 'crag-license')
      assert.equal(cragLicenseDirectory(root, mappedVm), privateDir)
      const device = fs.readFileSync(path.join(privateDir, 'device.json'))
      const registration = fs.readFileSync(path.join(privateDir, 'registration.code'))
      // Config callers can carry only a summary; the persisted run mount still owns placement.
      for (let pass = 0; pass < 2; pass++) {
        const written = writeKernelConfig(root, { id: vm.id, dataplane: 'crag' }, { token: 'fixture', publish: false })
        assert.equal(written.runDir, expectedRun)
        const config = JSON.parse(fs.readFileSync(written.configPath))
        assert.equal(config.license_dir, '/run/kin/crag-license')
        const status = await route(root, 'GET', '/crag-license')
        assert.equal(status.body.data.machine_code, challenge)
        assert.equal(status.body.data.license.valid, true)
      }
      assert.deepEqual(fs.readFileSync(path.join(privateDir, 'device.json')), device)
      assert.deepEqual(fs.readFileSync(path.join(privateDir, 'registration.code')), registration)
      assert.equal(fs.existsSync(path.join(root, 'vms', vm.id, 'run')), false)
      if (environmentOverride) assert.equal(fs.existsSync(recordedRun), false)
    } finally {
      if (previous == null) delete process.env.KIN_SLOT_RUN_ROOT
      else process.env.KIN_SLOT_RUN_ROOT = previous
    }
  })
}

test('symlinked device files and DrvFS storage are refused; non-admin activation is forbidden', async (t) => {
  const { root, vm } = fixture(t)
  activateFixture(root, vm)
  const dir = cragLicenseDirectory(root, vm)
  fs.renameSync(path.join(dir, 'device.json'), path.join(dir, 'original-device'))
  fs.symlinkSync(path.join(dir, 'original-device'), path.join(dir, 'device.json'))
  assert.equal(getCragLicense(root, vm).license.valid, false)
  const denied = await route(root, 'GET', '/crag-license', null, 'super')
  assert.equal(denied.status, 403)
  assert.equal(getCragLicense('/mnt/c/not-created', vm, { initialize: true }).license.valid, false)
})
