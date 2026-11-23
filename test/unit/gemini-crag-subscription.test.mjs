import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  AGY_SHA256,
  CRAG_GEMINI_PRODUCT,
  installGeminiPayload,
  readCragGeminiPackageAuthority,
  readPinnedCragGeminiPublicKeySha256,
  verifyCragGeminiPayload,
  verifyGeminiPayload,
} from '../../src/lib/gemini/payload.mjs'
import { createGeminiPanelHandler } from '../../src/lib/gemini/routes.mjs'
import { createGeminiScheduler } from '../../src/lib/gemini/scheduler.mjs'
import {
  createGeminiCragSubscription,
  parseCragGeminiMachineCode,
  verifyCragGeminiHostEntitlement,
  verifyCragGeminiSlotPermit,
} from '../../src/lib/gemini/subscription.mjs'

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex')

function makeAuthority() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const payloadKey = crypto.randomBytes(32)
  const publicBytes = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')
  return {
    publicKey,
    privateKey,
    publicPem: publicKey.export({ format: 'pem', type: 'spki' }),
    publicBytes,
    issuerId: sha256(publicBytes),
    payloadKey,
    payloadKeyId: sha256(payloadKey),
  }
}

function signToken(authority, prefix, claims) {
  const raw = Buffer.from(JSON.stringify(claims))
  const sig = crypto.sign(null, Buffer.concat([Buffer.from(`${prefix}\0`), raw]), authority.privateKey)
  return `${prefix}.${raw.toString('base64url')}.${sig.toString('base64url')}`
}

function makeMachineCode(vmId, { product = CRAG_GEMINI_PRODUCT } = {}) {
  const pair = crypto.generateKeyPairSync('x25519')
  const identity = {
    version: 1,
    product,
    vm_id: vmId,
    machine_id_hash: sha256(`machine-${vmId}`),
    device_public_key: pair.publicKey.export({ format: 'jwk' }).x,
  }
  return {
    pair,
    identity,
    machine_code: `CRAGM1.${Buffer.from(JSON.stringify(identity)).toString('base64url')}`,
  }
}

function issuePermit(authority, machineCode, hostId, seat, { product = CRAG_GEMINI_PRODUCT } = {}) {
  const c = JSON.parse(Buffer.from(machineCode.split('.')[1], 'base64url'))
  const ephemeral = crypto.generateKeyPairSync('x25519')
  const devPub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: c.device_public_key }, format: 'jwk' })
  const shared = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: devPub })
  const wrapping = crypto.hkdfSync(
    'sha256',
    shared,
    Buffer.from(authority.payloadKeyId, 'hex'),
    Buffer.from('CRAG-LICENSE-KEYWRAP-V1\0'),
    32,
  )
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', wrapping, nonce)
  cipher.setAAD(Buffer.from(`${c.vm_id}\0${c.machine_id_hash}\0${c.device_public_key}\0${authority.payloadKeyId}`))
  const ciphertext = Buffer.concat([cipher.update(authority.payloadKey), cipher.final()])
  const claims = {
    version: 1,
    product,
    host_id: hostId,
    seat,
    vm_id: c.vm_id,
    machine_id_hash: c.machine_id_hash,
    device_public_key: c.device_public_key,
    payload_key_id: authority.payloadKeyId,
    wrapped_key: {
      ephemeral_public_key: ephemeral.publicKey.export({ format: 'jwk' }).x,
      nonce: nonce.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
    },
  }
  const code = signToken(authority, 'CRAGS1', claims)
  return { claims, code, permit_sha256: sha256(code) }
}

function seedCragGeminiPayloadDir(root, authority, { product = CRAG_GEMINI_PRODUCT, agyDigestOverride = null } = {}) {
  const dir = path.join(root, 'payload-src')
  fs.mkdirSync(dir, { recursive: true })
  const bootstrap = Buffer.from('\x7fELF\x02\x01\x01\x03bootstrap-craggemini')
  const corePlain = Buffer.from('\x7fELF\x02\x01\x01\x03core-craggemini-binary')
  const bridge = Buffer.from('mock-libagy-bridge')
  const agy = Buffer.from('mock-agy-binary')

  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', authority.payloadKey, nonce)
  cipher.setAAD(Buffer.from('CRAG-GEMINI-PAYLOAD-V1\0'))
  const ct = Buffer.concat([cipher.update(corePlain), cipher.final()])
  const encrypted = Buffer.concat([Buffer.from('CRAGV2E1'), nonce, cipher.getAuthTag(), ct])

  const statement = {
    product,
    format: 'CRAGV2E1',
    algorithm: 'aes-256-gcm',
    key_id: authority.payloadKeyId,
    plaintext_sha256: sha256(corePlain),
    ciphertext_sha256: sha256(encrypted),
  }
  const signature = crypto
    .sign(
      null,
      Buffer.concat([Buffer.from('CRAG-PAYLOAD-V1\0'), Buffer.from(JSON.stringify(statement))]),
      authority.privateKey,
    )
    .toString('base64url')

  const files = {
    craggemini: bootstrap,
    'craggemini.payload.enc': encrypted,
    'libagy_bridge.so': bridge,
    'crag-license-public.pem': Buffer.from(authority.publicPem),
    agy,
  }
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, { mode: name === 'craggemini' || name === 'agy' ? 0o755 : 0o644 })
  }
  const shaMap = Object.fromEntries(Object.entries(files).map(([name, content]) => [name, sha256(content)]))
  if (agyDigestOverride) shaMap.agy = agyDigestOverride
  const manifest = {
    family: 'crag',
    version: 'v1',
    software_version: '0.3.0-rc.3',
    arch: 'amd64',
    runtime: 'native',
    entrypoint: 'craggemini',
    encrypted: true,
    authorization: {
      scheme: 'ed25519-x25519-v1',
      product,
      public_key: authority.publicBytes.toString('base64url'),
      public_key_id: authority.issuerId,
    },
    payload: {
      path: 'craggemini.payload.enc',
      ...statement,
      signature,
    },
    sha256: shaMap,
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return { dir, manifest, encrypted }
}

test('CRAG encrypted craggemini payload verification rejects tampering, wrong issuer, and crag-v2 cross-product', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-crag-pkg-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const authority = makeAuthority()
  const wrongAuthority = makeAuthority()

  // Seed with exact AGY_SHA256 pin mismatch -> must fail on agy check.
  const badAgy = seedCragGeminiPayloadDir(path.join(root, 'bad-agy'), authority)
  await assert.rejects(() => verifyCragGeminiPayload(badAgy.dir, authority.publicPem), {
    code: 'gemini_payload_invalid_manifest',
  })

  // Seed with matching AGY_SHA256 pin (using readCragGeminiPackageAuthority for authority extraction).
  const okRoot = path.join(root, 'ok')
  const { dir: okDir } = seedCragGeminiPayloadDir(okRoot, authority, { agyDigestOverride: AGY_SHA256 })
  const extracted = readCragGeminiPackageAuthority(okDir, authority.publicPem)
  assert.equal(extracted.product, CRAG_GEMINI_PRODUCT)
  assert.equal(extracted.issuerId, authority.issuerId)
  assert.equal(extracted.payloadKeyId, authority.payloadKeyId)

  // Wrong issuer public key rejected.
  assert.throws(() => readCragGeminiPackageAuthority(okDir, wrongAuthority.publicPem), {
    code: 'gemini_payload_invalid_signature',
  })

  // Cross-product ("crag-v2") rejected.
  const wrongProd = seedCragGeminiPayloadDir(path.join(root, 'wrong-prod'), authority, {
    product: 'crag-v2',
    agyDigestOverride: AGY_SHA256,
  })
  assert.throws(() => readCragGeminiPackageAuthority(wrongProd.dir, authority.publicPem), {
    code: 'gemini_payload_invalid_manifest',
  })

  // Tampered payload ciphertext rejected.
  const tamperedRoot = path.join(root, 'tampered')
  const tampered = seedCragGeminiPayloadDir(tamperedRoot, authority, { agyDigestOverride: AGY_SHA256 })
  const encFile = path.join(tampered.dir, 'craggemini.payload.enc')
  const raw = fs.readFileSync(encFile)
  raw[raw.length - 1] ^= 0xff
  fs.writeFileSync(encFile, raw)
  await assert.rejects(() => verifyGeminiPayload(tampered.dir, authority.publicPem), {
    code: 'gemini_payload_member_mismatch',
  })
})

test('readCragGeminiPackageAuthority enforces independent trust root and rejects symlinks', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-crag-trust-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const authority = makeAuthority()
  const wrongAuthority = makeAuthority()
  const { dir } = seedCragGeminiPayloadDir(path.join(root, 'pkg'), authority, { agyDigestOverride: AGY_SHA256 })
  const pinnedSha = sha256(Buffer.from(authority.publicPem))

  // Never self-attest when neither explicit PEM nor SHA-256 pin is provided.
  assert.throws(() => readCragGeminiPackageAuthority(dir), { code: 'gemini_payload_invalid_signature' })
  assert.throws(() => readCragGeminiPackageAuthority(dir, ''), { code: 'gemini_payload_invalid_signature' })
  assert.throws(() => readCragGeminiPackageAuthority(dir, null, { expectedPublicKeySha256: 'not-hex' }), {
    code: 'gemini_payload_invalid_signature',
  })

  // Valid SHA-256 pin verifies manifest and returns package authority.
  const pinned = readCragGeminiPackageAuthority(dir, null, { expectedPublicKeySha256: pinnedSha })
  assert.equal(pinned.issuerId, authority.issuerId)
  assert.equal(pinned.payloadKeyId, authority.payloadKeyId)
  assert.equal(pinned.product, CRAG_GEMINI_PRODUCT)

  // Mismatched SHA-256 pin rejected.
  assert.throws(
    () => readCragGeminiPackageAuthority(dir, null, { expectedPublicKeySha256: sha256(wrongAuthority.publicPem) }),
    { code: 'gemini_payload_invalid_signature' },
  )

  // Tampered bundled PEM rejected even when expectedPublicKeyPem is supplied.
  const swappedDir = seedCragGeminiPayloadDir(path.join(root, 'swapped-pem'), authority, {
    agyDigestOverride: AGY_SHA256,
  }).dir
  fs.writeFileSync(path.join(swappedDir, 'crag-license-public.pem'), wrongAuthority.publicPem)
  assert.throws(() => readCragGeminiPackageAuthority(swappedDir, authority.publicPem), {
    code: 'gemini_payload_invalid_signature',
  })

  // deploy/payload.json pin extraction succeeds on valid pin and returns null otherwise.
  const proj = path.join(root, 'proj')
  fs.mkdirSync(path.join(proj, 'deploy'), { recursive: true })
  assert.equal(readPinnedCragGeminiPublicKeySha256(proj), null)
  fs.writeFileSync(
    path.join(proj, 'deploy', 'payload.json'),
    JSON.stringify({
      geminiDefaultLinuxAmd64: {
        assets: { 'crag-license-public.pem': { sha256: pinnedSha } },
      },
    }),
  )
  assert.equal(readPinnedCragGeminiPublicKeySha256(proj), pinnedSha)

  // Symlinked manifest.json or crag-license-public.pem must be rejected via O_NOFOLLOW.
  if (process.platform !== 'win32') {
    const symManifest = seedCragGeminiPayloadDir(path.join(root, 'sym-manifest'), authority, {
      agyDigestOverride: AGY_SHA256,
    }).dir
    const externalManifest = path.join(root, 'external-manifest.json')
    fs.renameSync(path.join(symManifest, 'manifest.json'), externalManifest)
    fs.symlinkSync(externalManifest, path.join(symManifest, 'manifest.json'))
    assert.throws(() => readCragGeminiPackageAuthority(symManifest, authority.publicPem))

    const symPem = seedCragGeminiPayloadDir(path.join(root, 'sym-pem'), authority, {
      agyDigestOverride: AGY_SHA256,
    }).dir
    const externalPem = path.join(root, 'external-public.pem')
    fs.renameSync(path.join(symPem, 'crag-license-public.pem'), externalPem)
    fs.symlinkSync(externalPem, path.join(symPem, 'crag-license-public.pem'))
    assert.throws(() => readCragGeminiPackageAuthority(symPem, null, { expectedPublicKeySha256: pinnedSha }))
  }
})

test('createGeminiCragSubscription resolves trust root from deploy/payload.json or publicKeyFile and fails closed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-crag-root-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const authority = makeAuthority()
  const wrongAuthority = makeAuthority()
  const pinnedSha = sha256(Buffer.from(authority.publicPem))

  const proj = path.join(root, 'proj')
  const currentDir = path.join(proj, 'share', 'gemini', 'current')
  const { dir: seeded } = seedCragGeminiPayloadDir(path.join(root, 'seed'), authority, {
    agyDigestOverride: AGY_SHA256,
  })
  fs.mkdirSync(path.dirname(currentDir), { recursive: true })
  fs.cpSync(seeded, currentDir, { recursive: true })
  fs.mkdirSync(path.join(proj, 'deploy'), { recursive: true })
  const payloadJsonPath = path.join(proj, 'deploy', 'payload.json')
  const machineIdPath = path.join(root, 'machine-id')
  fs.writeFileSync(machineIdPath, 'fedcba9876543210fedcba9876543210\n')
  const callHost = async () => ({})

  // Without deploy/payload.json pin or publicKeyFile, runtime fails closed (no self-attestation).
  const unpinned = createGeminiCragSubscription({
    projectRoot: proj,
    dataDir: path.join(root, 'data-unpinned'),
    callHost,
    origin: 'http://127.0.0.1:18790',
    machineIdFile: machineIdPath,
  })
  assert.equal((await unpinned.status()).configured, false)

  // With valid deploy/payload.json SHA-256 pin, runtime resolves package authority.
  fs.writeFileSync(
    payloadJsonPath,
    JSON.stringify({
      geminiDefaultLinuxAmd64: { assets: { 'crag-license-public.pem': { sha256: pinnedSha } } },
    }),
  )
  const pinnedStatus = await unpinned.status()
  assert.equal(pinnedStatus.configured, true)
  assert.equal(pinnedStatus.issuer_public_key_id, authority.issuerId)
  assert.equal(pinnedStatus.payload_key_id, authority.payloadKeyId)

  // Mismatched deploy/payload.json pin fails closed.
  fs.writeFileSync(
    payloadJsonPath,
    JSON.stringify({
      geminiDefaultLinuxAmd64: {
        assets: { 'crag-license-public.pem': { sha256: sha256(Buffer.from(wrongAuthority.publicPem)) } },
      },
    }),
  )
  assert.equal((await unpinned.status()).configured, false)

  // Operator-rotated publicKeyFile overrides deploy/payload.json pin cleanly.
  const rotatedKeyFile = path.join(root, 'rotated-public.pem')
  fs.writeFileSync(rotatedKeyFile, authority.publicPem)
  const rotated = createGeminiCragSubscription({
    projectRoot: proj,
    dataDir: path.join(root, 'data-rotated'),
    publicKeyFile: rotatedKeyFile,
    callHost,
    origin: 'http://127.0.0.1:18790',
    machineIdFile: machineIdPath,
  })
  const rotatedStatus = await rotated.status()
  assert.equal(rotatedStatus.configured, true)
  assert.equal(rotatedStatus.issuer_public_key_id, authority.issuerId)

  // Explicitly configured missing publicKeyFile fails closed (does not fall back to deploy/payload.json).
  fs.writeFileSync(
    payloadJsonPath,
    JSON.stringify({
      geminiDefaultLinuxAmd64: { assets: { 'crag-license-public.pem': { sha256: pinnedSha } } },
    }),
  )
  const missingKeySub = createGeminiCragSubscription({
    projectRoot: proj,
    dataDir: path.join(root, 'data-missing'),
    publicKeyFile: path.join(root, 'does-not-exist.pem'),
    callHost,
    origin: 'http://127.0.0.1:18790',
    machineIdFile: machineIdPath,
  })
  assert.equal((await missingKeySub.status()).configured, false)
})

test('verifyCragGeminiHostEntitlement & verifyCragGeminiSlotPermit enforce CRAGH1/CRAGH2/CRAGH3 and product isolation', () => {
  const authority = makeAuthority()
  const hostId = 'a1'.repeat(32)
  const vmId = 'gemini-000000000000000000000001'
  const now = 1_800_000_000
  const m = makeMachineCode(vmId)
  assert.equal(parseCragGeminiMachineCode(m.machine_code).vm_id, vmId)

  // Cross-product crag-v2 machine code rejected.
  const wrongMachine = makeMachineCode(vmId, { product: 'crag-v2' })
  assert.throws(() => parseCragGeminiMachineCode(wrongMachine.machine_code), { code: 'license_invalid' })

  const permit = issuePermit(authority, m.machine_code, hostId, 2)

  // CRAGH1
  const h1 = signToken(authority, 'CRAGH1', {
    version: 1,
    product: CRAG_GEMINI_PRODUCT,
    host_id: hostId,
    revision: 1,
    issued_at: now - 60,
    expires_at: now + 3600,
    slot_limit: 2,
  })
  const h1Claims = verifyCragGeminiHostEntitlement(h1, hostId, authority.publicKey, { now })
  assert.equal(
    verifyCragGeminiSlotPermit(permit.code, h1Claims, authority.publicKey, { expectedVmId: vmId, now }).permit.seat,
    2,
  )

  // CRAGH2 active vs revoked
  const h2Active = signToken(authority, 'CRAGH2', {
    version: 2,
    product: CRAG_GEMINI_PRODUCT,
    host_id: hostId,
    revision: 2,
    issued_at: now - 60,
    expires_at: now + 3600,
    slot_limit: 2,
    roster: [{ seat: 2, permit_sha256: permit.permit_sha256 }],
  })
  const h2ActiveClaims = verifyCragGeminiHostEntitlement(h2Active, hostId, authority.publicKey, { now })
  assert.equal(
    verifyCragGeminiSlotPermit(permit.code, h2ActiveClaims, authority.publicKey, { expectedVmId: vmId, now })
      .permit_sha256,
    permit.permit_sha256,
  )

  const h2Revoked = signToken(authority, 'CRAGH2', {
    version: 2,
    product: CRAG_GEMINI_PRODUCT,
    host_id: hostId,
    revision: 3,
    issued_at: now - 60,
    expires_at: now + 3600,
    slot_limit: 2,
    roster: [],
  })
  const h2RevokedClaims = verifyCragGeminiHostEntitlement(h2Revoked, hostId, authority.publicKey, { now })
  assert.throws(
    () => verifyCragGeminiSlotPermit(permit.code, h2RevokedClaims, authority.publicKey, { expectedVmId: vmId, now }),
    {
      code: 'license_binding_mismatch',
    },
  )

  // CRAGH3 grant ladder shrinks over time
  const h3 = signToken(authority, 'CRAGH3', {
    version: 3,
    product: CRAG_GEMINI_PRODUCT,
    host_id: hostId,
    revision: 4,
    issued_at: now - 60,
    expires_at: now + 5000,
    grants: [
      { slots: 1, expires_at: now + 1000 },
      { slots: 1, expires_at: now + 5000 },
    ],
  })
  const h3Claims = verifyCragGeminiHostEntitlement(h3, hostId, authority.publicKey, { now: now + 500 })
  assert.equal(
    verifyCragGeminiSlotPermit(permit.code, h3Claims, authority.publicKey, { expectedVmId: vmId, now: now + 500 })
      .permit.seat,
    2,
  )
  assert.throws(
    () =>
      verifyCragGeminiSlotPermit(permit.code, h3Claims, authority.publicKey, { expectedVmId: vmId, now: now + 1500 }),
    {
      code: 'license_binding_mismatch',
    },
  )

  // Malformed base64url tokens fail with license_invalid (403), never raw TypeError.
  assert.throws(() => parseCragGeminiMachineCode('CRAGM1.not!valid+base64'), {
    code: 'license_invalid',
    status: 403,
  })
  assert.throws(() => verifyCragGeminiHostEntitlement('CRAGH1.bad+payload.bad+sig', hostId, authority.publicKey), {
    code: 'license_invalid',
    status: 403,
  })

  // CRAGH3 with expires_at <= issued_at must be rejected as license_invalid.
  const h3InvalidWindow = signToken(authority, 'CRAGH3', {
    version: 3,
    product: CRAG_GEMINI_PRODUCT,
    host_id: hostId,
    revision: 5,
    issued_at: now,
    expires_at: now,
    grants: [{ slots: 1, expires_at: now }],
  })
  assert.throws(
    () => verifyCragGeminiHostEntitlement(h3InvalidWindow, hostId, authority.publicKey, { now, allowExpired: true }),
    {
      code: 'license_invalid',
      status: 403,
    },
  )
})

test('end-to-end Gemini CRAG subscription: redeem, bind OAuth seat, skip api_key, panel DELETE auto-reclaim, scheduler admission', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-crag-sub-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const authority = makeAuthority()
  const now = Math.floor(Date.now() / 1000)

  // In-memory mock CRAG Authority for product: "craggemini"
  let revision = 0
  const seatMap = new Map() // vm_id -> { seat, permitCode, permitSha }
  const slotLimit = 1
  const buildH2 = (hostId) => {
    const roster = [...seatMap.values()]
      .sort((a, b) => a.seat - b.seat)
      .map(({ seat, permitSha }) => ({ seat, permit_sha256: permitSha }))
    const claims = {
      version: 2,
      product: CRAG_GEMINI_PRODUCT,
      host_id: hostId,
      revision,
      issued_at: now - 60,
      expires_at: now + 86400,
      slot_limit: slotLimit,
      roster,
    }
    return {
      entitlement: signToken(authority, 'CRAGH2', claims),
      expires_at: claims.expires_at,
      slot_limit: claims.slot_limit,
      revision: claims.revision,
      used_slots: roster.length,
      available_slots: slotLimit - roster.length,
      reclaim_supported: true,
    }
  }

  const fetchImpl = async (url, options) => {
    const action = url.split('/').pop()
    const body = JSON.parse(options.body)
    if (action === 'redeem') {
      assert.equal(body.issuer_public_key_id, authority.issuerId)
      assert.equal(body.payload_key_id, authority.payloadKeyId)
      revision += 1
      return new Response(JSON.stringify({ ok: true, data: buildH2(body.host_id) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (action === 'bind') {
      const identity = parseCragGeminiMachineCode(body.machine_code)
      if (!seatMap.has(identity.vm_id)) {
        if (seatMap.size >= slotLimit) {
          return new Response(JSON.stringify({ ok: false, error: { code: 'slot_limit_reached' } }), {
            status: 409,
            headers: { 'content-type': 'application/json' },
          })
        }
        const seat = 1
        const permit = issuePermit(authority, body.machine_code, body.host_id, seat)
        seatMap.set(identity.vm_id, { seat, permitCode: permit.code, permitSha: permit.permit_sha256 })
        revision += 1
      }
      const entry = seatMap.get(identity.vm_id)
      const h2 = buildH2(body.host_id)
      return new Response(
        JSON.stringify({
          ok: true,
          data: { entitlement: h2.entitlement, slot_permit: entry.permitCode, seat: entry.seat },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (action === 'release') {
      const entry = seatMap.get(body.vm_id)
      assert.equal(entry?.permitSha, body.permit_sha256)
      seatMap.delete(body.vm_id)
      revision += 1
      return new Response(JSON.stringify({ ok: true, data: buildH2(body.host_id) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`unexpected authority action: ${action}`)
  }

  // Mock Gemini Host storing OAuth env + API Key env
  const machines = {
    'gemini-oauth-1': makeMachineCode('gemini-oauth-1'),
    'gemini-oauth-2': makeMachineCode('gemini-oauth-2'),
  }
  const activePermits = new Map()
  const environments = new Map([
    [
      'gemini-oauth-1',
      {
        id: 'gemini-oauth-1',
        name: 'OAuth One',
        proxy_id: 'px-1',
        auth_state: 'authorized',
        auth_method: 'oauth',
        models_discovered: true,
        models: ['gemini-3-flash'],
        capabilities: ['streaming', 'native_tui'],
      },
    ],
    [
      'gemini-oauth-2',
      {
        id: 'gemini-oauth-2',
        name: 'OAuth Two',
        proxy_id: 'px-1',
        auth_state: 'authorized',
        auth_method: 'oauth',
        models_discovered: true,
        models: ['gemini-3-flash'],
        capabilities: ['streaming', 'native_tui'],
      },
    ],
    [
      'gemini-apikey-1',
      {
        id: 'gemini-apikey-1',
        name: 'API Key Env',
        proxy_id: 'px-1',
        auth_state: 'authorized',
        auth_method: 'api_key',
        models_discovered: true,
        models: ['gemini-2.5-pro'],
        capabilities: ['streaming', 'full_gemini_api'],
      },
    ],
  ])

  const envLicenseView = (env) => {
    if (env.auth_method === 'api_key') {
      return { product: CRAG_GEMINI_PRODUCT, status: 'not_required', valid: true, seat_required: false, vm_id: env.id }
    }
    const permit = activePermits.get(env.id)
    if (!permit) {
      return {
        product: CRAG_GEMINI_PRODUCT,
        status: 'unlicensed',
        valid: false,
        seat_required: true,
        vm_id: env.id,
        code: 'license_required',
      }
    }
    return {
      product: CRAG_GEMINI_PRODUCT,
      status: 'valid',
      valid: true,
      seat_required: true,
      vm_id: env.id,
      scope: 'host',
      seat: 1,
    }
  }

  const callHost = async (op, body) => {
    if (op === 'list') {
      return {
        payload_state: 'installed',
        payload_mode: 'crag_subscription',
        release_activated: true,
        environments: [...environments.values()].map((env) => ({ ...env, crag_license: envLicenseView(env) })),
      }
    }
    if (op === 'get') {
      const env = environments.get(body.id)
      if (!env) throw Object.assign(new Error('not found'), { code: 'gemini_environment_not_found', status: 404 })
      return { ...env, payload_mode: 'crag_subscription', crag_license: envLicenseView(env) }
    }
    if (op === 'license-machine-code') return { machine_code: machines[body.id].machine_code, vm_id: body.id }
    if (op === 'license-activate') {
      activePermits.set(body.id, body.code)
      return envLicenseView(environments.get(body.id))
    }
    if (op === 'license-status') return { license: envLicenseView(environments.get(body.id)) }
    if (op === 'license-release-candidate') {
      const code = activePermits.get(body.id)
      return { permit_sha256: code ? sha256(code) : null }
    }
    if (op === 'license-clear') {
      activePermits.delete(body.id)
      return { cleared: true }
    }
    if (op === 'delete') {
      environments.delete(body.id)
      return {}
    }
    throw new Error(`unexpected host op: ${op}`)
  }

  const machineIdPath = path.join(root, 'host-machine-id')
  fs.writeFileSync(machineIdPath, '0123456789abcdef0123456789abcdef\n')

  const subscription = createGeminiCragSubscription({
    projectRoot: root,
    dataDir: path.join(root, 'data'),
    resolveAuthority: () => ({
      product: CRAG_GEMINI_PRODUCT,
      publicKey: authority.publicKey,
      publicKeyBytes: authority.publicBytes,
      issuerId: authority.issuerId,
      payloadKeyId: authority.payloadKeyId,
      softwareVersion: '0.3.0-rc.3',
    }),
    callHost,
    fetchImpl,
    origin: 'http://127.0.0.1:18790',
    machineIdFile: machineIdPath,
  })

  // Scheduler before binding: OAuth model blocked with 403 license_required; api_key model STILL available!
  const scheduler = createGeminiScheduler({ callHost, cragSubscription: subscription })
  const initialCatalog = await scheduler.catalog()
  assert.deepEqual(
    initialCatalog.accounts.map((a) => a.id),
    ['gemini-apikey-1'],
  )
  await assert.rejects(
    () =>
      scheduler.stream({
        model: 'gemini-3-flash',
        geminiBody: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      }),
    (err) => err.status === 403 && err.code === 'license_required',
  )

  // Redeem host voucher via panel handler
  const responses = []
  const json = (_res, status, payload) => responses.push({ status, payload })
  const makeReq = (method, body = {}) => ({ method, body })
  const readBody = async (req) => req.body
  const res = { setHeader() {} }
  const panel = createGeminiPanelHandler({
    json,
    readBody,
    proxyPool: () => null,
    cragSubscription: subscription,
    callHost,
  })

  const voucher = `CRAGR1.${crypto.randomBytes(32).toString('base64url')}`
  await panel(makeReq('POST', { redemption_code: voucher }), res, '/api/panel/gemini/crag-subscription/redeem')
  const redeemed = responses.pop()
  assert.equal(redeemed.status, 200)
  assert.equal(redeemed.payload.data.active, true)
  assert.equal(redeemed.payload.data.reclaim_supported, true)
  assert.equal(redeemed.payload.data.available_slots, 1)

  // API key environment refuses seat binding (409 gemini_subscription_oauth_only)
  await panel(makeReq('POST'), res, '/api/panel/gemini/environments/gemini-apikey-1/crag-license/bind')
  const apiKeyBind = responses.pop()
  assert.equal(apiKeyBind.status, 409)
  assert.equal(apiKeyBind.payload.error.code, 'gemini_subscription_oauth_only')

  // Bind OAuth 1 -> takes seat 1
  await panel(makeReq('POST'), res, '/api/panel/gemini/environments/gemini-oauth-1/crag-license/bind')
  const bind1 = responses.pop()
  assert.equal(bind1.status, 200)
  assert.equal(bind1.payload.data.seat, 1)
  assert.equal(bind1.payload.data.subscription.available_slots, 0)

  // Scheduler now admits OAuth 1!
  const afterBindCatalog = await scheduler.catalog()
  assert.deepEqual(afterBindCatalog.accounts.map((a) => a.id).sort(), ['gemini-apikey-1', 'gemini-oauth-1'])

  // Bind OAuth 2 -> 409 slot_limit_reached
  await panel(makeReq('POST'), res, '/api/panel/gemini/environments/gemini-oauth-2/crag-license/bind')
  const bind2Fail = responses.pop()
  assert.equal(bind2Fail.status, 409)
  assert.equal(bind2Fail.payload.error.code, 'slot_limit_reached')

  // Delete OAuth 1 via panel -> automatically reclaims seat via CRAGH2!
  await panel(makeReq('DELETE'), res, '/api/panel/gemini/environments/gemini-oauth-1')
  const delResp = responses.pop()
  assert.equal(delResp.status, 200)
  assert.equal(delResp.payload.data.deleted, true)
  assert.equal(delResp.payload.data.seat_released, true)

  // Bind OAuth 2 now succeeds and reclaims seat 1!
  await panel(makeReq('POST'), res, '/api/panel/gemini/environments/gemini-oauth-2/crag-license/bind')
  const bind2Ok = responses.pop()
  assert.equal(bind2Ok.status, 200)
  assert.equal(bind2Ok.payload.data.seat, 1)
  assert.equal(fs.existsSync(path.join(subscription.publicDir, 'entitlement.code')), true)
  assert.equal(fs.existsSync(path.join(subscription.publicDir, 'sync-pending')), false)
})

test('auto-binds CRAGGemini seats on create, panel inventory reconcile, and scheduler catalog', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-crag-autobind-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const authority = makeAuthority()
  const now = Math.floor(Date.now() / 1000)

  let revision = 0
  let nextSeat = 1
  const seatMap = new Map()
  const buildH2 = (hostId) => {
    const roster = [...seatMap.values()]
      .sort((a, b) => a.seat - b.seat)
      .map(({ seat, permitSha }) => ({ seat, permit_sha256: permitSha }))
    const claims = {
      version: 2,
      product: CRAG_GEMINI_PRODUCT,
      host_id: hostId,
      revision,
      issued_at: now - 60,
      expires_at: now + 86400,
      slot_limit: 'unlimited',
      roster,
    }
    return {
      entitlement: signToken(authority, 'CRAGH2', claims),
      expires_at: claims.expires_at,
      slot_limit: claims.slot_limit,
      revision: claims.revision,
      used_slots: roster.length,
      available_slots: 10_000 - roster.length,
      reclaim_supported: true,
    }
  }

  const fetchImpl = async (url, options) => {
    const action = url.split('/').pop()
    const body = JSON.parse(options.body)
    if (action === 'redeem') {
      revision += 1
      return new Response(JSON.stringify({ ok: true, data: buildH2(body.host_id) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (action === 'bind') {
      const identity = parseCragGeminiMachineCode(body.machine_code)
      if (!seatMap.has(identity.vm_id)) {
        const seat = nextSeat++
        const permit = issuePermit(authority, body.machine_code, body.host_id, seat)
        seatMap.set(identity.vm_id, { seat, permitCode: permit.code, permitSha: permit.permit_sha256 })
        revision += 1
      }
      const entry = seatMap.get(identity.vm_id)
      const h2 = buildH2(body.host_id)
      return new Response(
        JSON.stringify({
          ok: true,
          data: { entitlement: h2.entitlement, slot_permit: entry.permitCode, seat: entry.seat },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    throw new Error(`unexpected authority action: ${action}`)
  }

  const machines = {}
  const activePermits = new Map()
  const environments = new Map()
  const addEnv = (env) => {
    environments.set(env.id, env)
    if (env.auth_method !== 'api_key') machines[env.id] = makeMachineCode(env.id)
  }

  const envLicenseView = (env) => {
    if (env.auth_method === 'api_key') {
      return { product: CRAG_GEMINI_PRODUCT, status: 'not_required', valid: true, seat_required: false, vm_id: env.id }
    }
    const seat = activePermits.get(env.id)
    if (!seat) {
      return {
        product: CRAG_GEMINI_PRODUCT,
        status: 'unlicensed',
        valid: false,
        seat_required: true,
        vm_id: env.id,
        code: 'license_required',
      }
    }
    return {
      product: CRAG_GEMINI_PRODUCT,
      status: 'valid',
      valid: true,
      seat_required: true,
      vm_id: env.id,
      scope: 'host',
      seat,
    }
  }

  let createCounter = 0
  const callHost = async (op, body) => {
    if (op === 'list') {
      return {
        payload_state: 'installed',
        payload_mode: 'crag_subscription',
        release_activated: true,
        environments: [...environments.values()].map((env) => ({ ...env, crag_license: envLicenseView(env) })),
      }
    }
    if (op === 'get') {
      const env = environments.get(body.id)
      if (!env) throw Object.assign(new Error('not found'), { code: 'gemini_environment_not_found', status: 404 })
      return { ...env, payload_mode: 'crag_subscription', crag_license: envLicenseView(env) }
    }
    if (op === 'create') {
      const id = `gemini-auto-${++createCounter}`
      const env = {
        id,
        name: body.name,
        proxy_id: body.proxy_id,
        auth_state: body.auth_method === 'api_key' ? 'authorized' : 'unverified',
        auth_method: body.auth_method === 'api_key' ? 'api_key' : 'oauth',
        models_discovered: body.auth_method === 'api_key',
        models: body.auth_method === 'api_key' ? ['gemini-2.5-pro'] : [],
      }
      addEnv(env)
      return { ...env, payload_mode: 'crag_subscription', crag_license: envLicenseView(env) }
    }
    if (op === 'license-machine-code') return { machine_code: machines[body.id].machine_code, vm_id: body.id }
    if (op === 'license-activate') {
      const claims = JSON.parse(Buffer.from(body.code.split('.')[1], 'base64url'))
      activePermits.set(body.id, claims.seat)
      return envLicenseView(environments.get(body.id))
    }
    throw new Error(`unexpected host op: ${op}`)
  }

  const machineIdPath = path.join(root, 'host-machine-id')
  fs.writeFileSync(machineIdPath, 'fedcba9876543210fedcba9876543210\n')
  const subscription = createGeminiCragSubscription({
    projectRoot: root,
    dataDir: path.join(root, 'data'),
    resolveAuthority: () => ({
      product: CRAG_GEMINI_PRODUCT,
      publicKey: authority.publicKey,
      publicKeyBytes: authority.publicBytes,
      issuerId: authority.issuerId,
      payloadKeyId: authority.payloadKeyId,
      softwareVersion: '0.3.0',
    }),
    callHost,
    fetchImpl,
    origin: 'http://127.0.0.1:18790',
    machineIdFile: machineIdPath,
  })

  const responses = []
  const panel = createGeminiPanelHandler({
    json: (_res, status, payload) => responses.push({ status, payload }),
    readBody: async (req) => req.body,
    proxyPool: () => ({
      snapshot: () => ({ proxies: [{ id: 'px-1', enabled: true, status: 'ok', owner_user_id: null }] }),
      getProxyByIdWithAuth: () => ({ url: 'socks5h://192.0.2.10:1080' }),
    }),
    cragSubscription: subscription,
    callHost,
  })
  const res = { setHeader() {} }

  // 1. Activate host subscription
  const voucher = `CRAGR1.${crypto.randomBytes(32).toString('base64url')}`
  await panel({ method: 'POST', body: { redemption_code: voucher } }, res, '/api/panel/gemini/crag-subscription/redeem')
  assert.equal(responses.pop().status, 200)

  // 2. Creating an OAuth env auto-binds seat #1 immediately
  await panel({ method: 'POST', body: { name: 'Fresh OAuth', proxy_id: 'px-1' } }, res, '/api/panel/gemini/environments')
  const createdOAuth = responses.pop()
  assert.equal(createdOAuth.status, 200)
  assert.equal(createdOAuth.payload.data.crag_license.valid, true)
  assert.equal(createdOAuth.payload.data.crag_license.seat, 1)

  // 3. Creating an API Key env never consumes a seat
  await panel(
    {
      method: 'POST',
      body: { name: 'Key Env', proxy_id: 'px-1', auth_method: 'api_key', api_key: 'AIzaSyTestKeyValue1234567890' },
    },
    res,
    '/api/panel/gemini/environments',
  )
  const createdKey = responses.pop()
  assert.equal(createdKey.status, 200)
  assert.equal(seatMap.size, 1)

  // 4. Existing unlicensed OAuth env is auto-bound on GET /api/panel/gemini; disabled env is skipped
  addEnv({
    id: 'gemini-existing-oauth',
    name: 'Existing OAuth',
    proxy_id: 'px-1',
    auth_state: 'authorized',
    auth_method: 'oauth',
    models_discovered: true,
    models: ['gemini-3-flash'],
  })
  addEnv({
    id: 'gemini-disabled-oauth',
    name: 'Disabled OAuth',
    proxy_id: 'px-1',
    auth_state: 'disabled',
    auth_method: 'oauth',
    models_discovered: true,
    models: ['gemini-3-flash'],
  })
  await panel({ method: 'GET' }, res, '/api/panel/gemini')
  const listed = responses.pop()
  assert.equal(listed.status, 200)
  const existingView = listed.payload.data.environments.find((e) => e.id === 'gemini-existing-oauth')
  const disabledView = listed.payload.data.environments.find((e) => e.id === 'gemini-disabled-oauth')
  assert.equal(existingView.crag_license.valid, true)
  assert.equal(existingView.crag_license.seat, 2)
  assert.equal(disabledView.crag_license.valid, false)

  // 5. Headless scheduler.catalog() also auto-binds an unlicensed ready OAuth env
  addEnv({
    id: 'gemini-sched-oauth',
    name: 'Scheduler OAuth',
    proxy_id: 'px-1',
    auth_state: 'authorized',
    auth_method: 'oauth',
    models_discovered: true,
    models: ['gemini-3-pro'],
  })
  const scheduler = createGeminiScheduler({ callHost, cragSubscription: subscription })
  const catalog = await scheduler.catalog()
  assert.ok(catalog.accounts.some((a) => a.id === 'gemini-sched-oauth'))
  assert.equal(activePermits.get('gemini-sched-oauth'), 3)
})

test('createGeminiCragSubscription accepts path-prefixed authority URLs and surfaces stacked quota_grants', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-crag-path-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const authority = makeAuthority()
  const now = Math.floor(Date.now() / 1000)
  const machineIdPath = path.join(root, 'machine-id')
  fs.writeFileSync(machineIdPath, '22222222222222222222222222222222\n')

  const seenUrls = []
  const fetchImpl = async (url, options) => {
    seenUrls.push(String(url))
    const body = JSON.parse(options.body)
    const ent = signToken(authority, 'CRAGH2', {
      version: 2,
      product: CRAG_GEMINI_PRODUCT,
      host_id: body.host_id,
      revision: 2,
      issued_at: now - 5,
      expires_at: now + 7 * 86400,
      slot_limit: 20,
      roster: [],
    })
    return {
      ok: true,
      status: 200,
      headers: new Map([['x-request-id', 'req-stacked']]),
      async json() {
        return {
          ok: true,
          data: {
            entitlement: ent,
            slot_limit: 20,
            expires_at: now + 7 * 86400,
            quota_grants: [
              { code_id: 'code-7d', expires_at: now + 7 * 86400, slot_limit: 10 },
              { code_id: 'code-1m', expires_at: now + 30 * 86400, slot_limit: 10 },
            ],
          },
        }
      },
    }
  }

  const sub = createGeminiCragSubscription({
    projectRoot: root,
    dataDir: path.join(root, 'data'),
    resolveAuthority: () => ({
      publicKey: authority.publicKey,
      issuerId: authority.issuerId,
      payloadKeyId: authority.payloadKeyId,
    }),
    callHost: async () => ({}),
    fetchImpl,
    origin: 'https://www.vm2api.org/gemini/',
    machineIdFile: machineIdPath,
  })
  const voucher = `CRAGR1.${crypto.randomBytes(32).toString('base64url')}`
  const status = await sub.redeem(voucher)
  assert.equal(seenUrls[0], 'https://www.vm2api.org/gemini/v1/host-subscriptions/redeem')
  assert.equal(status.slot_limit, 20)
  assert.equal(status.quota_grants.length, 2)
})
