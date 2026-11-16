import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { runtimeFileOwner } from '../oauth/oauth-credentials.mjs'
import { resolveKernelDataplane } from './slot-engine.mjs'
import { cragV2PackageRoot, installedCragV2Root, matchesCragIssuer, verifyCragV2Tree } from './wrap-cli-runtime.mjs'
import { workerPaths } from '../transport/go-worker-client.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { getVm, listVms } from './vm-registry.mjs'
import { isKvmRuntime } from './runtime-kind.mjs'
import { cragSubscriptionPublicDirectory } from './crag-subscription-paths.mjs'
import { ensureGuestMachineIdFile } from '../identity/workstation-fingerprint.mjs'

const MESSAGES = {
  license_required: 'Activate a CRAG registration code for this VM before using CRAG.',
  license_expired: 'The CRAG license has expired. Activate a renewed registration code.',
  license_not_yet_valid: 'The CRAG license is not yet valid. Check the UTC clock and activation date.',
  license_invalid: 'The CRAG registration code or device data is invalid.',
  license_binding_mismatch: 'This CRAG registration code belongs to a different VM or device.',
  license_payload_key_mismatch:
    'The signed registration is for a different CRAG package. Request a grant for this package.',
  license_unconfigured: 'CRAG requires a configured encrypted native package and private Linux runtime storage.',
  license_redeem_unavailable: 'This online device voucher cannot be redeemed.',
  license_redeem_conflict: 'This voucher has already been bound to another device or payload.',
  issuer_mismatch: 'CRAG Authority does not recognize the target package issuer.',
  payload_key_unknown: 'CRAG Authority does not have the target package payload key.',
  license_redeem_target_changed: 'The target slot, package or license changed. Restore the original target and retry.',
  license_redeem_subscription:
    'This slot uses a host subscription. Its permit cannot be replaced by device redemption.',
  license_redeem_service: 'CRAG Authority is unavailable. Retry the same voucher on this slot.',
}
const STATES = {
  license_required: 'unlicensed',
  license_expired: 'expired',
  license_not_yet_valid: 'not_yet_valid',
  license_invalid: 'invalid',
  license_binding_mismatch: 'invalid',
  license_payload_key_mismatch: 'invalid',
  license_unconfigured: 'unconfigured',
}
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const hex = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0')

// Cache package authority only. Registration bytes, binding and UTC validity are
// deliberately verified afresh on every admission, including after cache hits.
const packageTrustCache = new Map()
// One entry per installed slot package plus the shared download root. The
// kernel watchdog admits every slot each tick in a fixed order, so a bound below
// the slot count turns the LRU into a miss on every admission and re-hashes each
// full package (hundreds of MB, synchronously) every tick. Entries hold only a
// public key and ids, so keep the bound well above any realistic host.
const MAX_TRUST_ROOTS = 512
const redeemingSlots = new Set()
const DEVICE_ACTIVATION_URL = 'https://crag.fkcodex.com/v1/device-activation'

export class CragLicenseError extends Error {
  constructor(code, status = 403) {
    super(MESSAGES[code] || MESSAGES.license_invalid)
    this.code = MESSAGES[code] ? code : 'license_invalid'
    this.status = status
  }
}
const fail = (code = 'license_invalid') => {
  throw new CragLicenseError(code)
}

export function decodeLicenseBytes(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) fail()
  const bytes = Buffer.from(value, 'base64url')
  if ((length != null && bytes.length !== length) || bytes.toString('base64url') !== value) fail()
  return bytes
}

function xPrivate(raw) {
  return crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), raw]),
    format: 'der',
    type: 'pkcs8',
  })
}
function xPublic(raw) {
  return crypto.createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), raw]),
    format: 'der',
    type: 'spki',
  })
}

export function cragLicenseDirectory(projectRoot, vm) {
  if (!projectRoot || !text(vm?.id) || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(vm.id)) fail('license_unconfigured')
  const runDir = workerPaths({
    vm,
    homeDir: path.join(projectRoot, 'vms', vm.id, 'cli-home'),
    runRoot: String(process.env.KIN_SLOT_RUN_ROOT || '').trim(),
  }).runDir
  return path.join(runDir, 'crag-license')
}

/** One installation directory. CRAGU1 is not stored once per VM slot. */
export function cragUniversalDirectory(projectRoot) {
  if (!projectRoot) fail('license_unconfigured')
  const runRoot = String(process.env.KIN_SLOT_RUN_ROOT || '').trim()
  return path.join(runRoot || path.join(projectRoot, 'run'), 'crag-universal')
}
function calendarExpiry(issued, term) {
  const date = new Date(issued * 1000)
  const day = date.getUTCDate()
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() + { '1m': 1, '3m': 3, '6m': 6, '1y': 12 }[term])
  const end = new Date(date.getTime())
  end.setUTCMonth(end.getUTCMonth() + 1, 0)
  date.setUTCDate(Math.min(day, end.getUTCDate()))
  return date.getTime() / 1000
}

function checkDirectory(dir, create = false, vm) {
  if (process.platform !== 'linux') fail('license_unconfigured')
  // DrvFS cannot enforce private Linux permissions. Never put device secrets there.
  const absolute = path.resolve(dir)
  if (/^\/mnt\/[a-z](?:\/|$)/i.test(absolute)) fail('license_unconfigured')
  let cursor = path.parse(absolute).root
  for (const part of absolute.slice(cursor.length).split('/').filter(Boolean)) {
    cursor = path.join(cursor, part)
    try {
      const st = fs.lstatSync(cursor)
      if (!st.isDirectory() || st.isSymbolicLink()) fail('license_invalid')
    } catch (error) {
      if (error?.code !== 'ENOENT' || !create) throw error
      fs.mkdirSync(cursor, { mode: 0o700 })
    }
  }
  const real = fs.realpathSync(dir)
  if (/^\/mnt\/[a-z](?:\/|$)/i.test(real) || fs.statfsSync(dir).type === 0x01021997) fail('license_unconfigured')
  if (create) {
    fs.chmodSync(dir, 0o700)
    if (process.getuid() === 0) {
      const owner = runtimeFileOwner(vm)
      fs.chownSync(dir, owner.uid, owner.gid)
    }
  }
  const st = fs.statSync(dir)
  const owner = process.getuid() === 0 ? runtimeFileOwner(vm).uid : process.getuid()
  if ((st.mode & 0o777) !== 0o700 || st.uid !== owner) fail()
}

function readPrivate(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const st = fs.fstatSync(fd)
    if (
      !st.isFile() ||
      (st.mode & 0o777) !== 0o600 ||
      st.uid !== fs.statSync(path.dirname(file)).uid ||
      st.size > 32768
    )
      fail()
    return fs.readFileSync(fd, 'utf8')
  } finally {
    fs.closeSync(fd)
  }
}

function writePrivate(dir, name, data, vm, replace) {
  const tmp = path.join(dir, `.${name}.${crypto.randomUUID()}`)
  let fd
  try {
    fd = fs.openSync(
      tmp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    )
    fs.writeFileSync(fd, data)
    if (process.getuid() === 0) {
      const owner = runtimeFileOwner(vm)
      fs.fchownSync(fd, owner.uid, owner.gid)
    }
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    if (replace) {
      const st = fs.lstatSync(path.join(dir, name), { throwIfNoEntry: false })
      if (st && (!st.isFile() || st.isSymbolicLink())) fail()
      fs.renameSync(tmp, path.join(dir, name))
    } else {
      fs.linkSync(tmp, path.join(dir, name))
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    fs.rmSync(tmp, { force: true })
  }
}

function kvmGuestId(vm) {
  return String(vm.fingerprint?.guest_machine_id || vm.fingerprint?.machine_id || '')
    .trim()
    .replaceAll('-', '')
    .toLowerCase()
}

function deviceContext(projectRoot, vm, initialize, subscription = false) {
  if (!subscription && (vm?.node_id || isKvmRuntime(vm))) fail('license_unconfigured')
  // This file is the source bind-mounted at /etc/machine-id, not a vm.json claim.
  let machine
  try {
    machine = fs.readFileSync(path.join(projectRoot, 'vms', vm.id, 'machine-id'), 'utf8').trim()
  } catch {
    fail('license_unconfigured')
  }
  if (!/^[a-fA-F0-9]{32}$/.test(machine)) fail('license_unconfigured')
  if (isKvmRuntime(vm) && kvmGuestId(vm) !== machine) fail('license_binding_mismatch')
  const binding = { version: 1, product: 'crag-v2', vm_id: vm.id, machine_id_hash: sha(Buffer.from(machine)) }
  const dir = cragLicenseDirectory(projectRoot, vm)
  checkDirectory(dir, initialize, vm)
  let device
  try {
    device = JSON.parse(readPrivate(path.join(dir, 'device.json')))
  } catch (error) {
    if (error?.code !== 'ENOENT' || !initialize) throw error
    const pair = crypto.generateKeyPairSync('x25519')
    device = {
      ...binding,
      private_key: pair.privateKey.export({ format: 'jwk' }).d,
      public_key: pair.publicKey.export({ format: 'jwk' }).x,
    }
    try {
      writePrivate(dir, 'device.json', JSON.stringify(device) + '\n', vm, false)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      device = JSON.parse(readPrivate(path.join(dir, 'device.json')))
    }
  }
  if (Object.keys(binding).some((key) => binding[key] !== device[key])) fail('license_binding_mismatch')
  const privateKey = xPrivate(decodeLicenseBytes(device.private_key, 32))
  const publicKey = decodeLicenseBytes(device.public_key, 32)
  if (!crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).equals(publicKey))
    fail()
  const challenge = { ...binding, device_public_key: device.public_key }
  return {
    dir,
    device,
    privateKey,
    challenge,
    machine_code: `CRAGM1.${Buffer.from(JSON.stringify(challenge)).toString('base64url')}`,
  }
}

export function verifyCragRegistration(
  code,
  { device, privateKey, publicKey, keyId, now = Math.floor(Date.now() / 1000) },
) {
  try {
    if (typeof code !== 'string' || code.length > 32768) fail()
    const parts = code.trim().split('.')
    if (parts.length !== 3 || parts[0] !== 'CRAGL1') fail()
    const raw = decodeLicenseBytes(parts[1])
    if (
      !crypto.verify(
        null,
        Buffer.concat([Buffer.from('CRAG-LICENSE-V1\0'), raw]),
        publicKey,
        decodeLicenseBytes(parts[2], 64),
      )
    )
      fail()
    const c = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
    if (
      c.version !== 1 ||
      c.product !== 'crag-v2' ||
      !text(c.license_id) ||
      !text(c.vm_id) ||
      !hex(c.machine_id_hash) ||
      !hex(c.payload_key_id) ||
      !['1m', '3m', '6m', '1y'].includes(c.term)
    )
      fail()
    for (const key of ['issued_at', 'not_before', 'expires_at']) if (!Number.isSafeInteger(c[key])) fail()
    if (
      c.not_before < c.issued_at ||
      c.expires_at <= c.not_before ||
      c.expires_at !== calendarExpiry(c.issued_at, c.term)
    )
      fail()
    if (
      c.vm_id !== device.vm_id ||
      c.machine_id_hash !== device.machine_id_hash ||
      c.device_public_key !== device.public_key
    )
      fail('license_binding_mismatch')
    decodeLicenseBytes(c.device_public_key, 32)
    if (c.payload_key_id !== keyId) fail('license_payload_key_mismatch')
    unwrapDeviceKey(c.wrapped_key, device, privateKey, keyId)
    const status = { status: 'valid', valid: true, vm_id: device.vm_id, kind: 'online', scope: 'device' }
    for (const key of ['license_id', 'term', 'issued_at', 'not_before', 'expires_at']) status[key] = c[key]
    if (now < c.issued_at || now < c.not_before)
      return {
        ...status,
        status: 'not_yet_valid',
        valid: false,
        code: 'license_not_yet_valid',
        message: MESSAGES.license_not_yet_valid,
      }
    if (now >= c.expires_at)
      return { ...status, status: 'expired', valid: false, code: 'license_expired', message: MESSAGES.license_expired }
    return status
  } catch (error) {
    if (error instanceof CragLicenseError) throw error
    fail()
  }
}

function unwrapDeviceKey(wrapped, device, privateKey, keyId) {
  const shared = crypto.diffieHellman({
    privateKey: privateKey || xPrivate(decodeLicenseBytes(device.private_key, 32)),
    publicKey: xPublic(decodeLicenseBytes(wrapped.ephemeral_public_key, 32)),
  })
  let key
  let payload
  try {
    if (shared.every((byte) => byte === 0)) fail()
    key = Buffer.from(
      crypto.hkdfSync('sha256', shared, Buffer.from(keyId, 'hex'), Buffer.from('CRAG-LICENSE-KEYWRAP-V1\0'), 32),
    )
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, decodeLicenseBytes(wrapped.nonce, 12))
    decipher.setAAD(Buffer.from(`${device.vm_id}\0${device.machine_id_hash}\0${device.public_key}\0${keyId}`))
    decipher.setAuthTag(decodeLicenseBytes(wrapped.tag, 16))
    payload = decipher.update(decodeLicenseBytes(wrapped.ciphertext, 32))
    const tail = decipher.final()
    try {
      if (tail.length !== 0 || payload.length !== 32 || sha(payload) !== keyId) fail()
    } finally {
      tail.fill(0)
    }
  } finally {
    shared.fill(0)
    key?.fill(0)
    payload?.fill(0)
  }
}

function packageFingerprint(root) {
  const rows = []
  function visit(file, relative) {
    const st = fs.lstatSync(file, { bigint: true })
    if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) fail('license_unconfigured')
    rows.push([relative, st.dev, st.ino, st.mode, st.uid, st.gid, st.size, st.mtimeNs, st.ctimeNs].map(String))
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(file).sort())
        visit(path.join(file, name), relative ? `${relative}/${name}` : name)
    }
  }
  visit(root, '')
  return JSON.stringify(rows)
}

function trust(projectRoot, installedRoot, arch) {
  let canonicalRoot
  try {
    const root = installedRoot ?? cragV2PackageRoot(projectRoot, arch)
    if (!root || fs.lstatSync(root).isSymbolicLink()) fail('license_unconfigured')
    canonicalRoot = fs.realpathSync(root)
    // Complete membership includes manifest, public key, ciphertext, bootstrap,
    // official Claude, legal/config files and directories; no payload reads here.
    const fingerprint = packageFingerprint(canonicalRoot)
    const cached = packageTrustCache.get(canonicalRoot)
    const useInstalled = Boolean(installedRoot)
    if (cached?.fingerprint === fingerprint && cached.useInstalled === useInstalled) {
      if (useInstalled && !matchesCragIssuer(projectRoot, cached.authority.issuerId, cached.pem))
        fail('license_unconfigured')
      packageTrustCache.delete(canonicalRoot)
      packageTrustCache.set(canonicalRoot, cached)
      return cached.authority
    }
    packageTrustCache.delete(canonicalRoot)
    const verified = verifyCragV2Tree(canonicalRoot, { arch, allowPreviousClaude: useInstalled })
    if (!verified.ok) fail('license_unconfigured')
    const pem = fs.readFileSync(path.join(canonicalRoot, 'crag-license-public.pem'))
    if (useInstalled && !matchesCragIssuer(projectRoot, verified.manifest.authorization.public_key_id, pem))
      fail('license_unconfigured')
    const authority = {
      publicKey: crypto.createPublicKey(pem),
      keyId: verified.manifest.payload.key_id,
      issuerId: verified.manifest.authorization.public_key_id,
    }
    // A package changed during verification must not publish a mixed snapshot.
    if (packageFingerprint(canonicalRoot) !== fingerprint) fail('license_unconfigured')
    packageTrustCache.set(canonicalRoot, { fingerprint, authority, useInstalled, pem })
    if (packageTrustCache.size > MAX_TRUST_ROOTS) packageTrustCache.delete(packageTrustCache.keys().next().value)
    return authority
  } catch {
    if (canonicalRoot) packageTrustCache.delete(canonicalRoot)
    fail('license_unconfigured')
  }
}

function slotAuthority(projectRoot, vm, preferInstalled = true) {
  return trust(
    projectRoot,
    preferInstalled ? installedCragV2Root(projectRoot, vm) : undefined,
    vm?.node_id ? 'amd64' : undefined,
  )
}

export function cragTargetIds(projectRoot, vm, { preferInstalled = true } = {}) {
  const { keyId, issuerId } = slotAuthority(projectRoot, vm, preferInstalled)
  return { payloadKeyId: keyId, issuerId }
}
function publicFailure(vm, error) {
  const code =
    error instanceof CragLicenseError ? error.code : error?.code === 'ENOENT' ? 'license_required' : 'license_invalid'
  return { status: STATES[code], valid: false, vm_id: vm?.id || '', code, message: MESSAGES[code] }
}

const UNIVERSAL_DOMAIN = Buffer.from('CRAG-UNIVERSAL-LICENSE-V1\0')
const UNIVERSAL_WRAP = Buffer.from('CRAG-UNIVERSAL-WRAP-V1\0')
const UNIVERSAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAX_SUBSCRIPTION_TOKEN_BYTES = 8192
const MAX_HOST_ROSTER_ENTRIES = 10000
export const MAX_CRAG_HOST_ENTITLEMENT_BYTES = 1536 * 1024
const verifiedHostEntitlements = new WeakMap()

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  const present = Object.keys(value)
  if (present.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) fail()
}

function subscriptionJson(raw, maxArrayLength = 0) {
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw)
  const unsignedInteger = /(?:0|[1-9][0-9]{0,18})/y
  let offset = 0
  const whitespace = () => {
    while (/[\x20\t\r\n]/.test(source[offset] || '\0')) offset++
  }
  function value(depth = 0) {
    whitespace()
    if (source[offset] === '{') {
      if (depth > (maxArrayLength ? 2 : 1)) fail()
      const result = Object.create(null)
      offset++
      whitespace()
      if (source[offset] !== '}') {
        for (;;) {
          whitespace()
          if (source[offset] !== '"') fail()
          const key = value(depth + 1)
          if (Object.hasOwn(result, key)) fail()
          whitespace()
          if (source[offset++] !== ':') fail()
          result[key] = value(depth + 1)
          whitespace()
          if (source[offset] !== ',') break
          offset++
        }
      }
      if (source[offset++] !== '}') fail()
      return result
    }
    if (source[offset] === '[') {
      if (!maxArrayLength || depth !== 1) fail()
      const result = []
      offset++
      whitespace()
      if (source[offset] !== ']') {
        for (;;) {
          if (result.length >= maxArrayLength) fail()
          result.push(value(depth + 1))
          whitespace()
          if (source[offset] !== ',') break
          offset++
        }
      }
      if (source[offset++] !== ']') fail()
      return result
    }
    if (source[offset] === '"') {
      const start = offset++
      while (offset < source.length) {
        const char = source[offset++]
        if (char === '\\') offset++
        else if (char === '"') {
          const result = JSON.parse(source.slice(start, offset))
          if (Buffer.from(result).toString('utf8') !== result) fail()
          return result
        }
      }
      fail()
    }
    unsignedInteger.lastIndex = offset
    const token = unsignedInteger.exec(source)?.[0]
    if (!token) fail()
    offset += token.length
    const integer = BigInt(token)
    return integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer
  }
  const result = value()
  whitespace()
  if (offset !== source.length) fail()
  return result
}

function subscriptionInteger(value, minimum, maximum) {
  if (typeof value !== 'bigint' && !Number.isSafeInteger(value)) fail()
  if (value < minimum || value > maximum) fail()
}

function authenticateSubscription(code, prefix, publicKey) {
  const maxBytes = prefix === 'CRAGH2' ? MAX_CRAG_HOST_ENTITLEMENT_BYTES : MAX_SUBSCRIPTION_TOKEN_BYTES
  if (typeof code !== 'string' || code.length > maxBytes || Buffer.byteLength(code) > maxBytes) fail()
  const parts = code.split('.')
  if (parts.length !== 3 || parts[0] !== prefix) fail()
  const raw = decodeLicenseBytes(parts[1])
  if (
    !crypto.verify(null, Buffer.concat([Buffer.from(`${prefix}\0`), raw]), publicKey, decodeLicenseBytes(parts[2], 64))
  )
    fail()
  return subscriptionJson(raw, prefix === 'CRAGH2' ? MAX_HOST_ROSTER_ENTRIES : 0)
}

function hostEntitlement(code, hostId, publicKey) {
  const rosterRequired = typeof code === 'string' && code.startsWith('CRAGH2.')
  const claims = authenticateSubscription(code, rosterRequired ? 'CRAGH2' : 'CRAGH1', publicKey)
  const keys = ['version', 'product', 'host_id', 'revision', 'issued_at', 'expires_at', 'slot_limit']
  if (rosterRequired) keys.push('roster')
  exactKeys(claims, keys)
  if (
    claims.version !== (rosterRequired ? 2 : 1) ||
    claims.product !== 'crag-v2' ||
    !hex(claims.host_id) ||
    claims.host_id.length !== 64
  )
    fail()
  subscriptionInteger(claims.revision, 1, 9223372036854775807n)
  subscriptionInteger(claims.issued_at, 0, 9223372036854775807n)
  subscriptionInteger(claims.expires_at, 0, 9223372036854775807n)
  if (claims.expires_at <= claims.issued_at) fail()
  if (claims.slot_limit !== 'unlimited') subscriptionInteger(claims.slot_limit, 1, 2147483647)
  if (rosterRequired) {
    if (!Array.isArray(claims.roster)) fail()
    const digests = new Set()
    let previousSeat = 0
    claims.roster = Object.freeze(
      claims.roster.map((entry) => {
        exactKeys(entry, ['seat', 'permit_sha256'])
        subscriptionInteger(entry.seat, previousSeat + 1, 4294967295)
        if (
          (claims.slot_limit !== 'unlimited' && entry.seat > claims.slot_limit) ||
          !hex(entry.permit_sha256) ||
          entry.permit_sha256.length !== 64 ||
          digests.has(entry.permit_sha256)
        )
          fail()
        digests.add(entry.permit_sha256)
        previousSeat = entry.seat
        return Object.freeze({ ...entry })
      }),
    )
  }
  if (claims.host_id !== hostId) fail('license_binding_mismatch')
  return { ...claims }
}

function hostTimeError({ issued_at, expires_at }) {
  const now = Math.floor(Date.now() / 1000)
  if (now < issued_at) return 'license_not_yet_valid'
  if (now >= expires_at) return 'license_expired'
  return null
}

export function verifyCragHostEntitlement(projectRoot, code, hostId, { allowExpired = false, vm } = {}) {
  try {
    const { publicKey } = slotAuthority(projectRoot, vm)
    const claims = hostEntitlement(code, hostId, publicKey)
    const codeForTime = hostTimeError(claims)
    if (codeForTime && !(allowExpired && codeForTime === 'license_expired')) fail(codeForTime)
    if (claims.version === 2) verifiedHostEntitlements.set(Object.freeze(claims), publicKey)
    return claims
  } catch (error) {
    if (error instanceof CragLicenseError) throw error
    fail()
  }
}

function subscriptionSlot(vm) {
  const runtime = String(vm?.runtime?.type || vm?.runtime_type || 'docker')
    .trim()
    .toLowerCase()
  if (
    process.platform !== 'linux' ||
    isCodexVm(vm) ||
    (runtime !== 'docker' && !isKvmRuntime(vm)) ||
    ['darwin', 'macos'].includes(vm?.node_platform)
  )
    fail('license_unconfigured')
  if (!text(vm?.id) || Buffer.byteLength(vm.id) > 256) fail('license_unconfigured')
}

function subscriptionDirectory(dir) {
  if (process.platform !== 'linux') fail('license_unconfigured')
  const absolute = path.resolve(dir)
  if (/^\/mnt\/[a-z](?:\/|$)/i.test(absolute)) fail('license_unconfigured')
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
  let fd = fs.openSync('/', flags)
  try {
    for (const part of absolute.split('/').filter(Boolean)) {
      const next = fs.openSync(`/proc/self/fd/${fd}/${part}`, flags)
      fs.closeSync(fd)
      fd = next
    }
    const kind = fs.statfsSync(`/proc/self/fd/${fd}`).type
    if (kind === 0x01021997 || kind === 0x53464846) fail('license_unconfigured')
    return fd
  } catch (error) {
    fs.closeSync(fd)
    throw error
  }
}

function subscriptionStamp(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mode, stat.uid, stat.nlink, stat.mtimeNs, stat.ctimeNs].join(':')
}

function subscriptionStorage(dir, vm, action, allowPending = false) {
  const fd = subscriptionDirectory(dir)
  const pinned = `/proc/self/fd/${fd}`
  try {
    const directory = fs.fstatSync(fd)
    const owner = vm && (process.getuid() === 0 ? runtimeFileOwner(vm).uid : process.getuid())
    if (vm ? (directory.mode & 0o7777) !== 0o700 || directory.uid !== owner : directory.mode & 0o022) fail()
    const stamps = new Map()
    function read(name, limit) {
      const file = fs.openSync(
        `${pinned}/${name}`,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      )
      try {
        const stat = fs.fstatSync(file, { bigint: true })
        if (
          !stat.isFile() ||
          stat.nlink !== 1n ||
          stat.size > limit ||
          (vm ? (stat.mode & 0o7777n) !== 0o600n || stat.uid !== BigInt(owner) : (stat.mode & 0o022n) !== 0n)
        )
          fail()
        const bytes = Buffer.alloc(limit + 1)
        let length = 0
        while (length < bytes.length) {
          const count = fs.readSync(file, bytes, length, bytes.length - length, null)
          if (!count) break
          length += count
        }
        const stamp = subscriptionStamp(stat)
        if (length > limit || subscriptionStamp(fs.fstatSync(file, { bigint: true })) !== stamp) fail()
        stamps.set(name, stamp)
        return bytes.subarray(0, length)
      } finally {
        fs.closeSync(file)
      }
    }
    function ready() {
      if (!vm && !allowPending && fs.lstatSync(`${pinned}/sync-pending`, { throwIfNoEntry: false })) fail()
    }
    function current() {
      ready()
      const currentFd = subscriptionDirectory(dir)
      try {
        const currentDir = fs.fstatSync(currentFd)
        if (
          currentDir.dev !== directory.dev ||
          currentDir.ino !== directory.ino ||
          currentDir.mode !== directory.mode ||
          currentDir.uid !== directory.uid
        )
          fail()
      } finally {
        fs.closeSync(currentFd)
      }
      for (const [name, stamp] of stamps) {
        if (subscriptionStamp(fs.lstatSync(`${pinned}/${name}`, { bigint: true })) !== stamp) fail()
      }
    }
    ready()
    return action({ dir: pinned, read, current, sync: () => fs.fsyncSync(fd) })
  } finally {
    fs.closeSync(fd)
  }
}

function subscriptionDevice(storage, ctx) {
  const device = subscriptionJson(storage.read('device.json', 65536))
  exactKeys(device, ['version', 'product', 'vm_id', 'machine_id_hash', 'private_key', 'public_key'])
  if (Object.keys(device).some((key) => device[key] !== ctx.device[key])) fail('license_binding_mismatch')
}

export function prepareCragSubscriptionBinding(projectRoot, vm) {
  try {
    subscriptionSlot(vm)
    slotAuthority(projectRoot, vm)
    ensureGuestMachineIdFile(
      projectRoot,
      isKvmRuntime(vm) ? { ...vm, fingerprint: { guest_machine_id: kvmGuestId(vm) } } : vm,
    )
    const ctx = deviceContext(projectRoot, vm, true, true)
    return subscriptionStorage(ctx.dir, vm, (storage) => {
      subscriptionDevice(storage, ctx)
      storage.current()
      return ctx.machine_code
    })
  } catch (error) {
    if (error instanceof CragLicenseError) throw error
    fail()
  }
}

function subscriptionBinding(
  projectRoot,
  vm,
  slotPermit,
  {
    activate = false,
    seat,
    verifiedRights,
    candidateEntitlement,
    authority = slotAuthority(projectRoot, vm),
    exportFiles = false,
  } = {},
) {
  subscriptionSlot(vm)
  const ctx = deviceContext(projectRoot, vm, false, true)
  return subscriptionStorage(ctx.dir, vm, (privateStorage) => {
    subscriptionDevice(privateStorage, ctx)
    try {
      const stored = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
        .decode(privateStorage.read('registration.code', 65536))
        .trim()
      if (!activate && stored !== slotPermit) fail()
    } catch (error) {
      if (!activate || error?.code !== 'ENOENT') throw error
    }
    return subscriptionStorage(
      cragSubscriptionPublicDirectory(projectRoot),
      null,
      (hostStorage) => {
        const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
        const hostId = decoder.decode(hostStorage.read('host_id', 65)).trim()
        const entitlementCode =
          candidateEntitlement ??
          decoder.decode(hostStorage.read('entitlement.code', MAX_CRAG_HOST_ENTITLEMENT_BYTES + 1)).trim()
        const entitlement = hostEntitlement(entitlementCode, hostId, authority.publicKey)
        const permit = authenticateSubscription(slotPermit, 'CRAGS1', authority.publicKey)
        exactKeys(permit, [
          'version',
          'product',
          'host_id',
          'seat',
          'vm_id',
          'machine_id_hash',
          'device_public_key',
          'payload_key_id',
          'wrapped_key',
        ])
        exactKeys(permit.wrapped_key, ['ephemeral_public_key', 'nonce', 'ciphertext', 'tag'])
        if (
          [
            permit.host_id,
            permit.vm_id,
            permit.machine_id_hash,
            permit.device_public_key,
            permit.payload_key_id,
            ...Object.values(permit.wrapped_key),
          ].some((value) => typeof value !== 'string')
        )
          fail()
        if (permit.version !== 1 || permit.product !== 'crag-v2') fail()
        subscriptionInteger(permit.seat, 1, 4294967295)
        if (seat !== undefined && seat !== permit.seat) fail('license_binding_mismatch')
        if (
          permit.host_id !== entitlement.host_id ||
          permit.vm_id !== ctx.device.vm_id ||
          permit.machine_id_hash !== ctx.device.machine_id_hash ||
          permit.device_public_key !== ctx.device.public_key ||
          (entitlement.slot_limit !== 'unlimited' && permit.seat > entitlement.slot_limit)
        )
          fail('license_binding_mismatch')
        if (
          entitlement.version === 2 &&
          !entitlement.roster.some((entry) => entry.seat === permit.seat && entry.permit_sha256 === sha(slotPermit))
        )
          fail('license_binding_mismatch')
        if (
          verifiedRights &&
          (verifiedRights.revision !== entitlement.revision || verifiedRights.host_id !== entitlement.host_id)
        )
          fail('license_binding_mismatch')
        if (!hex(permit.payload_key_id)) fail()
        if (permit.payload_key_id !== authority.keyId) fail('license_payload_key_mismatch')
        unwrapDeviceKey(permit.wrapped_key, ctx.device, ctx.privateKey, authority.keyId)
        if (deviceContext(projectRoot, vm, false, true).machine_code !== ctx.machine_code)
          fail('license_binding_mismatch')
        privateStorage.current()
        hostStorage.current()
        const timeError = hostTimeError(entitlement)
        if (exportFiles) {
          if (timeError) fail(timeError)
          return { device: JSON.stringify(ctx.device), permit: slotPermit, hostId, entitlement: entitlementCode }
        }
        if (activate) {
          if (timeError) fail(timeError)
          if (candidateEntitlement === undefined) {
            writePrivate(privateStorage.dir, 'registration.code', `${slotPermit}\n`, vm, true)
            privateStorage.sync()
          }
        }
        const publicInteger = (value) => (typeof value === 'bigint' ? value.toString() : value)
        return {
          license: {
            ...(timeError
              ? publicFailure(vm, new CragLicenseError(timeError))
              : { status: 'valid', valid: true, vm_id: vm.id }),
            kind: 'online',
            scope: 'host',
            binding: 'host',
            license_id: `${hostId}:${permit.seat}`,
            host_id: hostId,
            seat: permit.seat,
            revision: publicInteger(entitlement.revision),
            slot_limit: entitlement.slot_limit,
            issued_at: publicInteger(entitlement.issued_at),
            not_before: publicInteger(entitlement.issued_at),
            expires_at: publicInteger(entitlement.expires_at),
          },
          machine_code: ctx.machine_code,
        }
      },
      activate && verifiedHostEntitlements.has(verifiedRights),
    )
  })
}

export function activateCragSubscriptionBinding(
  projectRoot,
  vm,
  slotPermit,
  { seat, verifiedRights, preferInstalled = true, candidateEntitlement } = {},
) {
  try {
    if (typeof slotPermit !== 'string') fail()
    return subscriptionBinding(projectRoot, vm, slotPermit.trim(), {
      activate: true,
      seat,
      verifiedRights,
      candidateEntitlement,
      authority: slotAuthority(projectRoot, vm, preferInstalled),
    })
  } catch (error) {
    if (error instanceof CragLicenseError) throw error
    fail(error?.code === 'ENOENT' ? 'license_required' : 'license_invalid')
  }
}

export function readCragSubscriptionReleaseCandidate(projectRoot, vm, hostId) {
  if (process.platform !== 'linux' || isCodexVm(vm)) return null
  const registration = storedRegistration(cragLicenseDirectory(projectRoot, vm))
  if (!selectsSubscription(registration)) return null
  subscriptionSlot(vm)
  const permit = authenticateSubscription(registration, 'CRAGS1', slotAuthority(projectRoot, vm).publicKey)
  if (permit.version !== 1 || permit.product !== 'crag-v2' || permit.host_id !== hostId || permit.vm_id !== vm.id)
    fail('license_binding_mismatch')
  return sha(registration)
}

export function readCragClusterSubscription(projectRoot, vm) {
  if (!vm.node_id || isKvmRuntime(vm)) return null
  const permit = storedRegistration(cragLicenseDirectory(projectRoot, vm))
  return selectsSubscription(permit) ? subscriptionBinding(projectRoot, vm, permit, { exportFiles: true }) : null
}

export function readKvmCragLicense(projectRoot, vm) {
  const permit = storedRegistration(cragLicenseDirectory(projectRoot, vm))
  if (selectsSubscription(permit)) return subscriptionBinding(projectRoot, vm, permit, { exportFiles: true })
  const authority = () => slotAuthority(projectRoot, vm)
  if (permit.startsWith('CRAGU1.') && verifyCragUniversal(permit, authority()).valid) return { permit }
  const shared = readUniversalCode(projectRoot)
  return shared && verifyCragUniversal(shared, authority()).valid ? { permit: shared } : null
}

export function verifyCragUniversal(code, { publicKey, keyId, now = Math.floor(Date.now() / 1000) }) {
  let bearer
  try {
    if (typeof code !== 'string' || code.length > 4096) fail()
    const parts = code.trim().split('.')
    if (parts.length !== 4 || parts[0] !== 'CRAGU1') fail()
    const raw = decodeLicenseBytes(parts[1])
    if (!crypto.verify(null, Buffer.concat([UNIVERSAL_DOMAIN, raw]), publicKey, decodeLicenseBytes(parts[2], 64)))
      fail()
    bearer = decodeLicenseBytes(parts[3], 32)
    const claims = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
    exactKeys(claims, [
      'version',
      'product',
      'license_id',
      'issued_at',
      'not_before',
      'expires_at',
      'term',
      'payload_key_id',
      'wrapped_key',
    ])
    exactKeys(claims.wrapped_key, ['nonce', 'ciphertext', 'tag'])
    if (claims.version !== 1 || claims.product !== 'crag-v2' || !UNIVERSAL_ID.test(claims.license_id)) fail()
    if (!['1m', '3m', '6m', '1y'].includes(claims.term)) fail()
    for (const key of ['issued_at', 'not_before', 'expires_at']) if (!Number.isSafeInteger(claims[key])) fail()
    if (
      claims.not_before !== claims.issued_at ||
      claims.expires_at <= claims.issued_at ||
      claims.expires_at !== calendarExpiry(claims.issued_at, claims.term) ||
      !hex(claims.payload_key_id)
    )
      fail()
    if (claims.payload_key_id !== keyId) fail('license_payload_key_mismatch')
    const aad = Buffer.concat([
      UNIVERSAL_WRAP,
      Buffer.from(claims.license_id),
      Buffer.from([0]),
      Buffer.from(claims.payload_key_id),
    ])
    let payload
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', bearer, decodeLicenseBytes(claims.wrapped_key.nonce, 12))
      decipher.setAAD(aad)
      decipher.setAuthTag(decodeLicenseBytes(claims.wrapped_key.tag, 16))
      payload = Buffer.concat([
        decipher.update(decodeLicenseBytes(claims.wrapped_key.ciphertext, 32)),
        decipher.final(),
      ])
      if (payload.length !== 32 || sha(payload) !== claims.payload_key_id) fail()
    } finally {
      payload?.fill(0)
    }
    const status = { status: 'valid', valid: true, vm_id: '', kind: 'offline', scope: 'kernel' }
    for (const key of ['license_id', 'term', 'issued_at', 'not_before', 'expires_at']) status[key] = claims[key]
    if (now < claims.issued_at)
      return {
        ...status,
        status: 'not_yet_valid',
        valid: false,
        code: 'license_not_yet_valid',
        message: MESSAGES.license_not_yet_valid,
      }
    if (now >= claims.expires_at)
      return { ...status, status: 'expired', valid: false, code: 'license_expired', message: MESSAGES.license_expired }
    return status
  } catch (error) {
    if (error instanceof CragLicenseError) throw error
    fail()
  } finally {
    bearer?.fill(0)
  }
}

function storedRegistration(dir) {
  try {
    return readPrivate(path.join(dir, 'registration.code')).trim()
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

function selectsSubscription(code) {
  return code === 'CRAGS1' || code.startsWith('CRAGS1.')
}

function readUniversalCode(projectRoot) {
  try {
    const stored = storedRegistration(cragUniversalDirectory(projectRoot))
    if (stored.startsWith('CRAGU1.')) return stored
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  // Older activations wrote the grant onto local slots only. A cluster slot has
  // no machine identity, so it has to reuse that same installation code.
  return universalCodeFromLocalSlots(projectRoot)
}

function universalCodeFromLocalSlots(projectRoot) {
  let found = ''
  for (const summary of listVms(projectRoot)) {
    const vm = getVm(projectRoot, summary.id)
    if (!vm || vm.node_id || isCodexVm(vm)) continue
    let code = ''
    try {
      code = storedRegistration(cragLicenseDirectory(projectRoot, vm))
    } catch (error) {
      if (error?.code !== 'ENOENT') continue
    }
    if (!code.startsWith('CRAGU1.')) continue
    if (!found) found = code
    else if (found !== code) return ''
  }
  return found
}

function sharedUniversalLicense(projectRoot, authority) {
  const stored = readUniversalCode(projectRoot)
  if (!stored) return null
  return verifyCragUniversal(stored, authority())
}

function withMachineCode(projectRoot, vm, license, initialize) {
  if (!initialize) return { license, machine_code: '' }
  try {
    // A machine-code failure must not hide an already valid offline license.
    return {
      license,
      ...machineExport(deviceContext(projectRoot, vm, true).machine_code, slotAuthority(projectRoot, vm).keyId),
    }
  } catch {
    return { license, machine_code: '' }
  }
}

function machineExport(machine_code, keyId) {
  if (!machine_code) return { machine_code: '' }
  return { machine_code, ...(keyId && { payload_key_id: keyId }) }
}

/** Copy the installation grant without replacing a device-bound L1 or host-bound S1. */
export function projectLocalGrant(projectRoot, vm, code) {
  if (!vm?.id || isCodexVm(vm) || vm.node_id) return false
  const dir = cragLicenseDirectory(projectRoot, vm)
  let existing = ''
  try {
    existing = storedRegistration(dir)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (existing.startsWith('CRAGL1.') || selectsSubscription(existing) || existing === code) return false
  checkDirectory(dir, true, vm)
  writePrivate(dir, 'registration.code', `${code}\n`, vm, true)
  return true
}

function projectLocalGrantAll(projectRoot, code, requiredVm) {
  projectLocalGrant(projectRoot, requiredVm, code)
  for (const summary of listVms(projectRoot)) {
    if (summary.id === requiredVm.id) continue
    const other = getVm(projectRoot, summary.id)
    if (!other) continue
    try {
      projectLocalGrant(projectRoot, other, code)
    } catch {
      // The next start of that slot retries. The installation grant stays valid.
    }
  }
}

async function projectRemoteGrant(vm, code) {
  const { nodeSession, remoteSlotDir, remoteSlotOwner, vmNodeId } = await import('../cluster/placement.mjs')
  const { openSftp, privateDirectoriesScript, readRemoteFileNoFollow, runRemote, shellQuote, writeRemoteFile } =
    await import('../cluster/remote-fs.mjs')
  const nodeId = vmNodeId(vm)
  if (!nodeId) return false
  const session = await nodeSession(nodeId)
  const dir = `${remoteSlotDir(session.host, vm.id)}/run/crag-license`
  const file = `${dir}/registration.code`
  const current = await readRemoteFileNoFollow(session.client, file, { maxBytes: 32768 })
  const text = current?.toString('utf8').trim() || ''
  if (text.startsWith('CRAGL1.') || selectsSubscription(text) || text === code) return false
  const owner = session.host.uid === 0 ? remoteSlotOwner(session.host, vm) : null
  const runDir = shellQuote(dir.slice(0, dir.lastIndexOf('/')))
  const chown = owner ? ` && chown ${owner.uid}:${owner.gid} ${runDir}` : ''
  await runRemote(
    session.client,
    `umask 077 && mkdir -p ${runDir} && chmod 700 ${runDir}${chown} && ${privateDirectoriesScript([dir], owner)}`,
    { timeoutMs: 20_000 },
  )
  const sftp = await openSftp(session.client)
  await writeRemoteFile(sftp, file, `${code}\n`, {
    mode: 0o600,
    owner: session.host.uid === 0 ? owner : null,
  })
  return true
}

/** Make the installation grant visible to one slot kernel. No-op without a CRAGU1 grant. */
export async function projectCragUniversalVm(projectRoot, vm) {
  const code = readUniversalCode(projectRoot)
  if (!code || !vm?.id || isCodexVm(vm)) return { ok: true, skipped: true }
  if (vm.node_id) {
    await projectRemoteGrant(vm, code)
    return { ok: true }
  }
  projectLocalGrant(projectRoot, vm, code)
  return { ok: true }
}

/** Push the one offline grant to every local slot and every cluster machine. */
export async function distributeCragUniversalGrant(projectRoot) {
  const code = readUniversalCode(projectRoot)
  if (!code) return { ok: true, skipped: true }
  const errors = []
  for (const summary of listVms(projectRoot)) {
    const vm = getVm(projectRoot, summary.id)
    if (!vm?.id || isCodexVm(vm)) continue
    try {
      if (vm.node_id) await projectRemoteGrant(vm, code)
      else projectLocalGrant(projectRoot, vm, code)
    } catch {
      errors.push(vm.id)
    }
  }
  return { ok: errors.length === 0, errors }
}

export function getCragLicense(projectRoot, vm, { initialize = false, preferInstalled = true } = {}) {
  let ctx
  const authority = () => slotAuthority(projectRoot, vm, preferInstalled)
  try {
    const dir = cragLicenseDirectory(projectRoot, vm)
    const stored = storedRegistration(dir)
    if (selectsSubscription(stored)) return subscriptionBinding(projectRoot, vm, stored, { authority: authority() })
    if (stored.startsWith('CRAGU1.')) {
      const license = verifyCragUniversal(stored, authority())
      const chosen = license.valid ? license : sharedUniversalLicense(projectRoot, authority) || license
      return withMachineCode(projectRoot, vm, chosen, initialize)
    }
    if (!stored.startsWith('CRAGL1.')) {
      const grant = sharedUniversalLicense(projectRoot, authority)
      if (grant) return withMachineCode(projectRoot, vm, grant, initialize)
    }
    if (!stored && isKvmRuntime(vm)) return { license: publicFailure(vm, { code: 'ENOENT' }), machine_code: '' }
    ctx = deviceContext(projectRoot, vm, initialize)
    if (!stored)
      return { license: publicFailure(vm, { code: 'ENOENT' }), ...machineExport(ctx.machine_code, authority().keyId) }
    const target = authority()
    return {
      license: verifyCragRegistration(stored, { ...ctx, ...target }),
      ...machineExport(ctx.machine_code, target.keyId),
    }
  } catch (error) {
    return { license: publicFailure(vm, error), ...machineExport(ctx?.machine_code) }
  }
}

export function activateCragLicense(projectRoot, vm, code) {
  try {
    const trimmed = typeof code === 'string' ? code.trim() : ''
    if (trimmed.startsWith('CRAGU1.')) {
      const license = verifyCragUniversal(trimmed, trust(projectRoot))
      if (!license.valid) fail(license.code)
      const dir = cragUniversalDirectory(projectRoot)
      checkDirectory(dir, true, { id: 'crag-universal' })
      writePrivate(dir, 'registration.code', `${trimmed}\n`, { id: 'crag-universal' }, true)
      projectLocalGrantAll(projectRoot, trimmed, vm)
      return { license, machine_code: '' }
    }
    const ctx = deviceContext(projectRoot, vm, true)
    const authority = slotAuthority(projectRoot, vm)
    const license = verifyCragRegistration(trimmed, { ...ctx, ...authority })
    if (!license.valid) fail(license.code)
    writePrivate(ctx.dir, 'registration.code', `${trimmed}\n`, vm, true)
    return { license, ...machineExport(ctx.machine_code, authority.keyId) }
  } catch (error) {
    if (error instanceof CragLicenseError) throw error
    fail()
  }
}

async function requestVoucher(action, body, fetchImpl) {
  let response
  try {
    response = await fetchImpl(`${DEVICE_ACTIVATION_URL}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    })
    if (!response.body || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''))
      throw Error()
    const chunks = []
    let bytes = 0
    for await (const chunk of response.body) {
      bytes += chunk.byteLength
      if (bytes > 32768) throw Error()
      chunks.push(chunk)
    }
    const reply = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (response.ok && reply.ok === true) {
      if (action === 'resolve' && ['device', 'host'].includes(reply.data?.kind)) return reply.data.kind
      if (
        action === 'redeem' &&
        typeof reply.data?.registration_code === 'string' &&
        typeof reply.data.replayed === 'boolean'
      )
        return { registration: reply.data.registration_code, replayed: reply.data.replayed }
    }
    if (response.status === 404 && reply.error?.code === 'redeem_unavailable') fail('license_redeem_unavailable')
    if (response.status === 409 && ['redeem_conflict', 'payload_key_conflict'].includes(reply.error?.code))
      throw new CragLicenseError('license_redeem_conflict', 409)
    if (response.status === 409 && reply.error?.code === 'issuer_mismatch')
      throw new CragLicenseError('issuer_mismatch', 409)
    if (response.status === 400 && reply.error?.code === 'payload_key_unknown')
      throw new CragLicenseError('payload_key_unknown', 400)
    if (response.status === 429) throw new CragLicenseError('license_redeem_service', 429)
    throw Error()
  } catch (error) {
    if (error instanceof CragLicenseError) throw error
    throw new CragLicenseError('license_redeem_service', 503)
  } finally {
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {})
  }
}

export function resolveCragVoucherKind(projectRoot, vm, voucher, fetchImpl = globalThis.fetch) {
  if (typeof voucher !== 'string' || !/^CRAGR1\.[A-Za-z0-9_-]{43}$/.test(voucher)) fail('license_redeem_unavailable')
  decodeLicenseBytes(voucher.slice(7), 32)
  return requestVoucher(
    'resolve',
    { redemption_code: voucher, issuer_public_key_id: slotAuthority(projectRoot, vm).issuerId },
    fetchImpl,
  )
}

export async function redeemCragDeviceVoucher(
  projectRoot,
  vm,
  voucher,
  { fetchImpl = globalThis.fetch, getTarget, routing } = {},
) {
  if (typeof voucher !== 'string' || !/^CRAGR1\.[A-Za-z0-9_-]{43}$/.test(voucher)) fail()
  if (process.platform !== 'linux' || vm.node_id || isKvmRuntime(vm) || isCodexVm(vm)) fail('license_unconfigured')
  decodeLicenseBytes(voucher.slice(7), 32)
  const slot = path.resolve(projectRoot, 'vms', vm.id)
  const targetAuthority = (target) => {
    const installed = installedCragV2Root(projectRoot, target)
    if (!installed && resolveKernelDataplane(target, routing) === 'crag') fail('license_unconfigured')
    return trust(projectRoot, installed)
  }
  if (redeemingSlots.has(slot)) throw new CragLicenseError('license_redeem_service', 409)
  redeemingSlots.add(slot)
  try {
    const initial = targetAuthority(vm)
    const context = deviceContext(projectRoot, vm, true)
    const original = storedRegistration(context.dir)
    if (selectsSubscription(original)) throw new CragLicenseError('license_redeem_subscription', 409)
    const { registration, replayed } = await requestVoucher(
      'redeem',
      {
        redemption_code: voucher,
        machine_code: context.machine_code,
        payload_key_id: initial.keyId,
        issuer_public_key_id: initial.issuerId,
      },
      fetchImpl,
    )
    const currentVm = getTarget ? getTarget() : vm
    if (
      !currentVm ||
      currentVm.id !== vm.id ||
      currentVm.node_id ||
      isKvmRuntime(currentVm) ||
      isCodexVm(currentVm) ||
      currentVm.owner_user_id !== vm.owner_user_id
    )
      throw new CragLicenseError('license_redeem_target_changed', 409)
    const current = deviceContext(projectRoot, currentVm, false)
    const authority = targetAuthority(currentVm)
    const saved = storedRegistration(current.dir)
    if (
      current.dir !== context.dir ||
      current.machine_code !== context.machine_code ||
      authority.keyId !== initial.keyId ||
      authority.issuerId !== initial.issuerId ||
      (saved !== original && saved !== registration)
    )
      throw new CragLicenseError('license_redeem_target_changed', 409)
    const license = verifyCragRegistration(registration, { ...current, ...authority })
    if (!license.valid) fail(license.code)
    if (saved !== registration) {
      // Recovery of an earlier voucher must not roll back a later device authorization.
      if (replayed && saved.startsWith('CRAGL1.')) {
        const existing = verifyCragRegistration(saved, { ...current, ...authority })
        if (existing.valid && existing.issued_at >= license.issued_at)
          throw new CragLicenseError('license_redeem_target_changed', 409)
      }
      try {
        writePrivate(current.dir, 'registration.code', `${registration}\n`, currentVm, true)
      } catch {
        throw new CragLicenseError('license_redeem_service', 503)
      }
    }
    return { license, ...machineExport(current.machine_code, authority.keyId) }
  } catch (error) {
    if (error instanceof CragLicenseError) throw error
    fail()
  } finally {
    redeemingSlots.delete(slot)
  }
}

export function checkCragLicense(projectRoot, vm, routing = {}, options) {
  if (resolveKernelDataplane(vm, routing) !== 'crag') return { ok: true }
  const { license } = getCragLicense(projectRoot, vm, options)
  return license.valid ? { ok: true, license } : { ok: false, code: license.code, error: license.message, license }
}

export function cragLicenseDeniedResult(check) {
  return {
    ok: false,
    status: 403,
    terminalState: 'rejected',
    upstreamExecutions: 0,
    committed: false,
    body: { type: 'error', error: { type: 'permission_error', code: check.code, message: check.error } },
  }
}
