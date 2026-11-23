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
