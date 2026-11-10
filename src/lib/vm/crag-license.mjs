import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { runtimeFileOwner } from '../oauth/oauth-credentials.mjs'
import { resolveKernelDataplane } from './slot-engine.mjs'
import { cragV2PackageRoot, verifyCragV2Tree } from './wrap-cli-runtime.mjs'
import { workerPaths } from '../transport/go-worker-client.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { getVm, listVms } from './vm-registry.mjs'

const MESSAGES = {
  license_required: 'Activate a CRAG registration code for this VM before using CRAG.',
  license_expired: 'The CRAG license has expired. Activate a renewed registration code.',
  license_not_yet_valid: 'The CRAG license is not yet valid. Check the UTC clock and activation date.',
  license_invalid: 'The CRAG registration code or device data is invalid.',
  license_binding_mismatch: 'This CRAG registration code belongs to a different VM or device.',
  license_unconfigured: 'CRAG requires a configured encrypted native package and private Linux runtime storage.',
}
const STATES = {
  license_required: 'unlicensed',
  license_expired: 'expired',
  license_not_yet_valid: 'not_yet_valid',
  license_invalid: 'invalid',
  license_binding_mismatch: 'invalid',
  license_unconfigured: 'unconfigured',
}
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const hex = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0')

// Cache package authority only. Registration bytes, binding and UTC validity are
// deliberately verified afresh on every admission, including after cache hits.
const packageTrustCache = new Map()
const MAX_TRUST_ROOTS = 8

export class CragLicenseError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES.license_invalid)
    this.code = MESSAGES[code] ? code : 'license_invalid'
    this.status = 403
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
  date.setUTCMonth(date.getUTCMonth() + { '1m': 1, '6m': 6, '1y': 12 }[term])
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
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
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

function deviceContext(projectRoot, vm, initialize) {
  if (vm?.node_id || vm?.runtime?.type === 'kvm') fail('license_unconfigured')
  // This file is the source bind-mounted at /etc/machine-id, not a vm.json claim.
  let machine
  try {
    machine = fs.readFileSync(path.join(projectRoot, 'vms', vm.id, 'machine-id'), 'utf8').trim()
  } catch {
    fail('license_unconfigured')
  }
  if (!/^[a-fA-F0-9]{32}$/.test(machine)) fail('license_unconfigured')
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
      !['1m', '6m', '1y'].includes(c.term)
    )
      fail()
    for (const key of ['issued_at', 'not_before', 'expires_at']) if (!Number.isSafeInteger(c[key])) fail()
    if (
      c.not_before < c.issued_at ||
      c.expires_at <= c.not_before ||
      c.payload_key_id !== keyId ||
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
    const w = c.wrapped_key
    const shared = crypto.diffieHellman({
      privateKey: privateKey || xPrivate(decodeLicenseBytes(device.private_key, 32)),
      publicKey: xPublic(decodeLicenseBytes(w.ephemeral_public_key, 32)),
    })
    if (shared.every((n) => n === 0)) fail()
    const key = Buffer.from(
      crypto.hkdfSync('sha256', shared, Buffer.from(keyId, 'hex'), Buffer.from('CRAG-LICENSE-KEYWRAP-V1\0'), 32),
    )
    let payload
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, decodeLicenseBytes(w.nonce, 12))
      decipher.setAAD(Buffer.from(`${c.vm_id}\0${c.machine_id_hash}\0${c.device_public_key}\0${keyId}`))
      decipher.setAuthTag(decodeLicenseBytes(w.tag, 16))
      payload = Buffer.concat([decipher.update(decodeLicenseBytes(w.ciphertext, 32)), decipher.final()])
      if (sha(payload) !== keyId) fail()
    } finally {
      shared.fill(0)
      key.fill(0)
      payload?.fill(0)
    }
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

function trust(projectRoot) {
  let canonicalRoot
  try {
    const root = cragV2PackageRoot(projectRoot)
    if (!root || fs.lstatSync(root).isSymbolicLink()) fail('license_unconfigured')
    canonicalRoot = fs.realpathSync(root)
    // Complete membership includes manifest, public key, ciphertext, bootstrap,
    // official Claude, legal/config files and directories; no payload reads here.
    const fingerprint = packageFingerprint(canonicalRoot)
    const cached = packageTrustCache.get(canonicalRoot)
    if (cached?.fingerprint === fingerprint) {
      packageTrustCache.delete(canonicalRoot)
      packageTrustCache.set(canonicalRoot, cached)
      return cached.authority
    }
    packageTrustCache.delete(canonicalRoot)
    const verified = verifyCragV2Tree(canonicalRoot)
    if (!verified.ok) fail('license_unconfigured')
    const authority = {
      publicKey: crypto.createPublicKey(fs.readFileSync(path.join(canonicalRoot, 'crag-license-public.pem'))),
      keyId: verified.manifest.payload.key_id,
    }
    // A package changed during verification must not publish a mixed snapshot.
    if (packageFingerprint(canonicalRoot) !== fingerprint) fail('license_unconfigured')
    packageTrustCache.set(canonicalRoot, { fingerprint, authority })
    if (packageTrustCache.size > MAX_TRUST_ROOTS) packageTrustCache.delete(packageTrustCache.keys().next().value)
    return authority
  } catch {
    if (canonicalRoot) packageTrustCache.delete(canonicalRoot)
    fail('license_unconfigured')
  }
}
function publicFailure(vm, error) {
  const code =
    error instanceof CragLicenseError ? error.code : error?.code === 'ENOENT' ? 'license_required' : 'license_invalid'
  return { status: STATES[code], valid: false, vm_id: vm?.id || '', code, message: MESSAGES[code] }
}

const UNIVERSAL_DOMAIN = Buffer.from('CRAG-UNIVERSAL-LICENSE-V1\0')
const UNIVERSAL_WRAP = Buffer.from('CRAG-UNIVERSAL-WRAP-V1\0')
const UNIVERSAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  const present = Object.keys(value)
  if (present.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) fail()
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
    if (!['1m', '6m', '1y'].includes(claims.term)) fail()
    for (const key of ['issued_at', 'not_before', 'expires_at']) if (!Number.isSafeInteger(claims[key])) fail()
    if (
      claims.not_before !== claims.issued_at ||
      claims.expires_at <= claims.issued_at ||
      claims.expires_at !== calendarExpiry(claims.issued_at, claims.term) ||
      !hex(claims.payload_key_id) ||
      claims.payload_key_id !== keyId
    )
      fail()
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

function sharedUniversalLicense(projectRoot) {
  const stored = readUniversalCode(projectRoot)
  if (!stored) return null
  return verifyCragUniversal(stored, trust(projectRoot))
}

function withMachineCode(projectRoot, vm, license, initialize) {
  if (!initialize) return { license, machine_code: '' }
  try {
    // A machine-code failure must not hide an already valid offline license.
    return { license, machine_code: deviceContext(projectRoot, vm, true).machine_code }
  } catch {
    return { license, machine_code: '' }
  }
}

/** Copy the installation grant into a slot directory. Never replaces a device-bound L1. */
export function projectLocalGrant(projectRoot, vm, code) {
  if (!vm?.id || isCodexVm(vm) || vm.node_id) return false
  const dir = cragLicenseDirectory(projectRoot, vm)
  let existing = ''
  try {
    existing = storedRegistration(dir)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (existing.startsWith('CRAGL1.') || existing === code) return false
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
  try {
    const current = await readRemoteFileNoFollow(session.client, file, { maxBytes: 32768 })
    const text = current.toString('utf8').trim()
    if (text.startsWith('CRAGL1.') || text === code) return false
  } catch {
    // Missing or unreadable: create the private directory below.
  }
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

export function getCragLicense(projectRoot, vm, { initialize = false } = {}) {
  let ctx
  try {
    const dir = cragLicenseDirectory(projectRoot, vm)
    const stored = storedRegistration(dir)
    if (stored.startsWith('CRAGU1.')) {
      const license = verifyCragUniversal(stored, trust(projectRoot))
      const chosen = license.valid ? license : sharedUniversalLicense(projectRoot) || license
      return withMachineCode(projectRoot, vm, chosen, initialize)
    }
    if (!stored.startsWith('CRAGL1.')) {
      const grant = sharedUniversalLicense(projectRoot)
      if (grant) return withMachineCode(projectRoot, vm, grant, initialize)
    }
    ctx = deviceContext(projectRoot, vm, initialize)
    if (!stored) {
      const missing = new Error('missing registration')
      missing.code = 'ENOENT'
      throw missing
    }
    return {
      license: verifyCragRegistration(stored, { ...ctx, ...trust(projectRoot) }),
      machine_code: ctx.machine_code,
    }
  } catch (error) {
    return { license: publicFailure(vm, error), machine_code: ctx?.machine_code || '' }
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
    const license = verifyCragRegistration(trimmed, { ...ctx, ...trust(projectRoot) })
    if (!license.valid) fail(license.code)
    writePrivate(ctx.dir, 'registration.code', `${trimmed}\n`, vm, true)
    return { license, machine_code: ctx.machine_code }
  } catch (error) {
    if (error instanceof CragLicenseError) throw error
    fail()
  }
}

export function checkCragLicense(projectRoot, vm, routing = {}) {
  if (resolveKernelDataplane(vm, routing) !== 'crag') return { ok: true }
  const { license } = getCragLicense(projectRoot, vm)
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
