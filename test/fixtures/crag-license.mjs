import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { activateCragLicense, getCragLicense } from '../../src/lib/vm/crag-license.mjs'

const authorities = new Map()
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
export function fixtureAuthority(root) {
  if (!authorities.has(root)) authorities.set(root, { ...crypto.generateKeyPairSync('ed25519'), payloadKey: crypto.randomBytes(32) })
  return authorities.get(root)
}
export function calendarExpiry(issued, term) {
  const date = new Date(issued * 1000)
  const day = date.getUTCDate()
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() + ({ '1m': 1, '6m': 6, '1y': 12 })[term])
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
  date.setUTCDate(Math.min(day, last))
  return Math.floor(date.getTime() / 1000)
}
export function signedCode(authority, claims) {
  const bytes = Buffer.from(JSON.stringify(claims))
  return `CRAGL1.${bytes.toString('base64url')}.${crypto.sign(null, Buffer.concat([Buffer.from('CRAG-LICENSE-V1\0'), bytes]), authority.privateKey).toString('base64url')}`
}
export function issueFixtureCode(root, challenge, overrides = {}) {
  const authority = fixtureAuthority(root)
  const c = typeof challenge === 'string' ? JSON.parse(Buffer.from(challenge.split('.')[1], 'base64url')) : challenge
  const issued = overrides.issued_at ?? Math.floor(Date.now() / 1000) - 60
  const term = overrides.term || '1m'
  const keyId = sha(authority.payloadKey)
  const ephemeral = crypto.generateKeyPairSync('x25519')
  const publicKey = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: c.device_public_key }, format: 'jwk' })
  const shared = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey })
  const key = crypto.hkdfSync('sha256', shared, Buffer.from(keyId, 'hex'), Buffer.from('CRAG-LICENSE-KEYWRAP-V1\0'), 32)
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(`${c.vm_id}\0${c.machine_id_hash}\0${c.device_public_key}\0${keyId}`))
  const ciphertext = Buffer.concat([cipher.update(authority.payloadKey), cipher.final()])
  const claims = { version: 1, product: 'crag-v2', license_id: crypto.randomUUID(), vm_id: c.vm_id,
    machine_id_hash: c.machine_id_hash, device_public_key: c.device_public_key, issued_at: issued, not_before: issued,
    expires_at: calendarExpiry(issued, term), term, payload_key_id: keyId,
    wrapped_key: { ephemeral_public_key: ephemeral.publicKey.export({ format: 'jwk' }).x, nonce: nonce.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') }, ...overrides }
  return { code: signedCode(authority, claims), claims }
}
export function issueUniversalCode(root, overrides = {}) {
  const authority = fixtureAuthority(root)
  const issued = overrides.issued_at ?? Math.floor(Date.now() / 1000) - 60
  const term = overrides.term || '1m'
  const keyId = sha(authority.payloadKey)
  const licenseId = overrides.license_id || crypto.randomUUID()
  const bearer = crypto.randomBytes(32)
  const nonce = crypto.randomBytes(12)
  const expires = overrides.expires_at ?? calendarExpiry(issued, term)
  const claims = {
    version: 1,
    product: 'crag-v2',
    license_id: licenseId,
    issued_at: issued,
    not_before: issued,
    expires_at: expires,
    term,
    payload_key_id: keyId,
    wrapped_key: { nonce: nonce.toString('base64url'), ciphertext: '', tag: '' },
  }
  const cipher = crypto.createCipheriv('aes-256-gcm', bearer, nonce)
  cipher.setAAD(
    Buffer.concat([
      Buffer.from('CRAG-UNIVERSAL-WRAP-V1\0'),
      Buffer.from(licenseId),
      Buffer.from([0]),
      Buffer.from(keyId),
    ]),
  )
  const ciphertext = Buffer.concat([cipher.update(authority.payloadKey), cipher.final()])
  claims.wrapped_key.ciphertext = ciphertext.toString('base64url')
  claims.wrapped_key.tag = cipher.getAuthTag().toString('base64url')
  const raw = Buffer.from(JSON.stringify(claims))
  const signature = crypto.sign(
    null,
    Buffer.concat([Buffer.from('CRAG-UNIVERSAL-LICENSE-V1\0'), raw]),
    authority.privateKey,
  )
  return {
    code: `CRAGU1.${raw.toString('base64url')}.${signature.toString('base64url')}.${bearer.toString('base64url')}`,
    claims,
  }
}
export function seedEncryptedPackage(root, { revision = '' } = {}) {
  const authority = fixtureAuthority(root)
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const dir = path.join(root, 'share/crag/kernels/v2', arch)
  fs.mkdirSync(path.join(dir, 'claude-code-2.1.317'), { recursive: true })
  const elf = Buffer.alloc(96 + Buffer.byteLength(revision))
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  elf.writeUInt16LE(3, 16); elf.writeUInt16LE(arch === 'amd64' ? 62 : 183, 18); elf.writeUInt32LE(1, 20)
  elf.write(revision, 96)
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', authority.payloadKey, nonce)
  cipher.setAAD(Buffer.from('CRAG-V2-PAYLOAD-V1\0'))
  const encrypted = Buffer.concat([cipher.update(elf), cipher.final()])
  const payloadBytes = Buffer.concat([Buffer.from('CRAGV2E1'), nonce, cipher.getAuthTag(), encrypted])
  const pub = authority.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  const signed = { product: 'crag-v2', format: 'CRAGV2E1', algorithm: 'aes-256-gcm', key_id: sha(authority.payloadKey), plaintext_sha256: sha(elf), ciphertext_sha256: sha(payloadBytes) }
  const files = { 'crag-v2': elf, 'claude-code-2.1.317/claude': elf, 'crag-v2.payload.enc': payloadBytes, 'crag-license-public.pem': authority.publicKey.export({ format: 'pem', type: 'spki' }) }
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body, { mode: name === 'crag-v2' || name.endsWith('/claude') ? 0o755 : 0o644 })
  const manifest = { family: 'crag', version: 'v2', arch, runtime: 'native', entrypoint: 'crag-v2', encrypted: true,
    capabilities: ['official_full', 'zero', 'cancel', 'telemetry', 'unix_socket_envelope'],
    authorization: { scheme: 'ed25519-x25519-v1', product: 'crag-v2', public_key: pub.toString('base64url'), public_key_id: sha(pub) },
    payload: { path: 'crag-v2.payload.enc', ...signed, signature: crypto.sign(null, Buffer.concat([Buffer.from('CRAG-PAYLOAD-V1\0'), Buffer.from(JSON.stringify(signed))]), authority.privateKey).toString('base64url') },
    sha256: Object.fromEntries(Object.entries(files).map(([name, body]) => [name, sha(body)])) }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  return dir
}
export function activateFixture(root, vm = { id: 'vm-13' }) {
  fs.mkdirSync(path.join(root, 'vms', vm.id), { recursive: true })
  const machine = path.join(root, 'vms', vm.id, 'machine-id')
  if (!fs.existsSync(machine)) fs.writeFileSync(machine, crypto.randomBytes(16).toString('hex') + '\n')
  const current = getCragLicense(root, vm, { initialize: true })
  if (!current.license.valid) activateCragLicense(root, vm, issueFixtureCode(root, current.machine_code).code)
  return getCragLicense(root, vm)
}
