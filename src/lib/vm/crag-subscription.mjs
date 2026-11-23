import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  activateCragSubscriptionBinding,
  cragLicenseDeniedResult,
  cragTargetIds,
  getCragLicense,
  MAX_CRAG_HOST_ENTITLEMENT_BYTES,
  prepareCragSubscriptionBinding,
  readCragSubscriptionReleaseCandidate,
  removeReclaimedCragPermit,
  verifyCragHostEntitlement,
} from './crag-license.mjs'
import { cragSubscriptionPublicDirectory } from './crag-subscription-paths.mjs'
import { isValidVmId, vmLockBusy } from './vm-file.mjs'
import { cragV2PackageRoot } from './wrap-cli-runtime.mjs'
import { resolveKernelDataplane } from './slot-engine.mjs'
import { isKvmRuntime } from './runtime-kind.mjs'
import { publishKvmCragLicense } from './kvm-crag-license.mjs'
import { publishClusterSubscription } from '../cluster/crag-subscription-files.mjs'
import { blockKvmCragSubscription, holdKvmCragSubscriptionPublications } from './kvm-crag-subscription.mjs'

const AUTHORITY = 'https://www.vm2api.org'
const HOST_ID_MOUNT = '/run/crag-host-machine-id'
const SHARED_HOST_ID_FILESYSTEMS = new Set([0x01021997, 0x65735546])
const localFilesystems = new Set([0xef53, 0x794c7630, 0x58465342, 0x9123683e, 0x2fc12fc1, 0xf2f52010])
const MAX_DEFERRED_RELEASES = 10000
const MAX_DEFERRED_RELEASE_BYTES = 4 * 1024 * 1024
const MAX_REDEEM_INTENT_BYTES = 1024
const terminalRedeem = new Map([
  ['redeem_unavailable', 404],
  ['host_redeem_conflict', 409],
  ['issuer_mismatch', 409],
  ['payload_key_unknown', 400],
])
const authorityErrors = new Map([
  ...terminalRedeem,
  ['host_binding_conflict', 409],
  ['host_subscription_inactive', 403],
  ['auth_forbidden', 403],
  ['not_found', 404],
  ['slot_limit_reached', 409],
  ['renewal_unavailable', 409],
  ['request_conflict', 409],
  ['payload_key_conflict', 409],
  // Without this, a retirement refused by the cooldown degrades into
  // `crag_subscription_authority_unavailable` (502) -- which reads as "result
  // unconfirmed, retry" and sends the operator retrying something that is
  // simply not due yet.
  ['host_transfer_cooldown', 409],
  // A rejected request shape is final, so it must not read as "result unconfirmed,
  // retry": without this it degrades to `crag_subscription_authority_unavailable`
  // (502) and sends the caller retrying something that can never succeed. It is
  // also what lets a redemption tell "this Authority predates a field we sent"
  // apart from "the Authority is unreachable".
  ['invalid_request', 400],
])
const fail = (code = 'crag_subscription_unavailable', status = 503) => Object.assign(new Error(code), { code, status })
const authorityRequestId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const uid = () => process.getuid()
const validVoucher = (code) =>
  typeof code === 'string' &&
  /^CRAGR1\.[A-Za-z0-9_-]{43}$/.test(code) &&
  Buffer.from(code.slice(7), 'base64url').toString('base64url') === code.slice(7)
const safeTime = (value) => Number.isSafeInteger(value) && value >= 0
/** Shape of a shop order id, matching the Authority's own CHECK on the column. */
const validOrderId = (value) => typeof value === 'string' && /^[0-9a-zA-Z_-]{1,64}$/.test(value)
const isDigest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

const HOST_DOMAIN = 'crag-host-v1:'
const MAC_DOMAIN = 'crag-host-mac-v1:'
const NET_DIRECTORY = '/sys/class/net'
/** Must match the Authority's own cap; unsigned detail must not grow unbounded. */
const MAX_QUOTA_GRANTS = 256

/** The 32 hex digits a host id has always been derived from are exactly a
 * UUID's payload, so the identity this service already computes can be shown to
 * the operator and typed back in without inventing a second identifier -- and
 * without touching the wire format, which stays a 64 hex host id. */
const formatDeviceUuid = (raw) =>
  `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`

const hostIdFromRaw = (raw) => createHash('sha256').update(`${HOST_DOMAIN}${raw}`).digest('hex')

/** Accepts what a person would actually paste: any case, dashes or not. */
function normalizeDeviceUuid(input) {
  if (typeof input !== 'string') return null
  const raw = input.trim().toLowerCase().replaceAll('-', '')
  if (!/^[a-f0-9]{32}$/.test(raw) || /^(0{32}|f{32})$/.test(raw)) return null
  return formatDeviceUuid(raw)
}

/** The one path from a device UUID to the identity the protocol speaks. */
function uuidToHostId(uuid) {
  const normalized = normalizeDeviceUuid(uuid)
  return normalized && hostIdFromRaw(normalized.replaceAll('-', ''))
}

/** A MAC is a worse identifier than a machine-id in one respect -- replacing a
 * NIC changes it -- but better in the one that actually bites: it is unique.
 * Cloud images routinely ship without resetting `/etc/machine-id`, so every
 * instance cloned from such an image derives the same host id, and the second
 * one to register is refused with 403 for the rest of its life. A hypervisor
 * hands each instance its own MAC. The instability costs nothing here because
 * hardware is only ever sampled when no identity has been stored yet.
 */
function macDeviceRaw(netDirectory) {
  let names
  try {
    names = fs.readdirSync(netDirectory)
  } catch {
    return null
  }
  let best
  for (const name of names) {
    const base = path.join(netDirectory, name)
    try {
      // Virtual interfaces -- lo, docker0, veth*, bridges, tap* -- have no
      // backing device. Matching on names instead would misfire the moment a
      // container renames a physical interface.
      if (!fs.existsSync(path.join(base, 'device'))) continue
      // Anything other than a permanent address (randomized, locally assigned,
      // or copied from another interface) is not an identity.
      if (fs.readFileSync(path.join(base, 'addr_assign_type'), 'utf8').trim() !== '0') continue
      const mac = fs.readFileSync(path.join(base, 'address'), 'utf8').trim().toLowerCase()
      if (!/^([a-f0-9]{2}:){5}[a-f0-9]{2}$/.test(mac) || mac === '00:00:00:00:00:00') continue
      // Only the multicast bit disqualifies an address, because a multicast
      // address is not an interface's own. The locally administered bit must not:
      // hypervisors set it as a matter of course (QEMU's 52:54:00 prefix has it),
      // so rejecting it would discard the NIC on most virtual machines -- exactly
      // the hosts this is meant to identify. Whether an address is permanent is
      // already settled authoritatively by `addr_assign_type` above.
      if (Number.parseInt(mac.slice(0, 2), 16) & 0b1) continue
      // Lowest address wins. Kernel enumeration order and interface naming both
      // shift between boots, so neither of them may decide who this machine is.
      if (best === undefined || mac < best) best = mac
    } catch {
      continue
    }
  }
  if (best === undefined) return null
  // Hash rather than pad out to 32 digits: the operator copies this value into
  // support tickets and migration forms, so the hardware address should not
  // travel with it. The separate domain also keeps MAC-derived values from ever
  // colliding with machine-id-derived ones.
  return createHash('sha256').update(`${MAC_DOMAIN}${best}`).digest('hex').slice(0, 32)
}
const validSku = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)
const validMonths = (value) => Number.isSafeInteger(value) && value >= 1 && value <= 4294967295
const invalidRights = () => fail('crag_subscription_invalid_entitlement', 502)
const hostPackageUnready = () => fail('crag_subscription_host_package_unready', 409)
const hostPackageChanged = () => fail('crag_subscription_host_package_changed', 409)
const hostIdentityUnavailable = () => fail('crag_subscription_host_identity_unavailable')
const hostIdentityChanged = () => fail('crag_subscription_host_identity_changed', 409)
const USAGE_UNVERIFIED_MESSAGE = '暂时无法核对宿主机 CRAG 运行额度，请刷新订阅或确认槽位状态后重试。'
/**
 * A denial while the host rights are being changed is transient, not a verdict on
 * the credential: `retryable` lets a fronting gateway retry or pick another slot
 * instead of reading it as an authorization failure.
 */
const usageUnverified = ({ retryable = false, retryAfterSeconds = 0 } = {}) => {
  const denial = cragLicenseDeniedResult({
    code: 'license_crag_host_usage_unverified',
    error: USAGE_UNVERIFIED_MESSAGE,
  })
  if (!retryable) return denial
  denial.body.error.details = { ...denial.body.error.details, retryable: true }
  if (retryAfterSeconds > 0) denial.retryAfterSec = retryAfterSeconds
  return denial
}
const overQuota = () =>
  cragLicenseDeniedResult({
    code: 'license_crag_host_over_quota',
    error: '宿主订阅的运行槽位已满，无法启动此 CRAG 槽位。请释放运行名额或增加订阅额度。',
  })

/** `admitOnce` hit an in-flight exclusive operation; only the caller decides whether to wait. */
const EXCLUSIVE_BUSY = Symbol('crag_exclusive_busy')
const MAX_EXCLUSIVE_WAIT_MS = 15_000

/**
 * Cap the wait by the request's own slot budget so admission never outlives it.
 * `hopSlotWaitDeadline` yields "now" when no slot wait is configured, which would
 * leave those deployments with no wait at all, so an absent or spent budget still
 * gets the ceiling rather than zero.
 */
function exclusiveWaitBudgetMs(slotWaitDeadlineMs) {
  if (!Number.isFinite(slotWaitDeadlineMs)) return MAX_EXCLUSIVE_WAIT_MS
  const remaining = slotWaitDeadlineMs - Date.now()
  return remaining > 0 ? Math.min(MAX_EXCLUSIVE_WAIT_MS, remaining) : MAX_EXCLUSIVE_WAIT_MS
}

/** Resolves true if the operation finished in time. Never holds a lock, never polls. */
function settledWithin(pending, budgetMs) {
  if (!pending?.done) return Promise.resolve(true)
  if (!(budgetMs > 0)) return Promise.resolve(false)
  let timer
  return Promise.race([
    pending.done.then(() => true),
    // Not unref'd on purpose: an unref'd timer never fires once the loop has
    // nothing else to do, which would leave this await pending forever.
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), budgetMs)
    }),
  ]).finally(() => clearTimeout(timer))
}

function runtimeDenial(denial) {
  const { code, message } = denial.body.error
  return { ok: false, status: denial.status, code, error: message }
}

const denyRuntime = (license) => ({ ok: false, status: 403, code: license.code, error: license.message })

function projection(data, claims) {
  const reclaim = claims.version === 2
  const result = { reclaim_supported: reclaim }
  if (Object.hasOwn(data, 'sku')) {
    if (!validSku(data.sku)) throw invalidRights()
    result.sku = data.sku
  }
  if (Object.hasOwn(data, 'months')) {
    if (!validMonths(data.months)) throw invalidRights()
    result.months = data.months
  }
  if (Object.hasOwn(data, 'used_slots')) {
    if (
      !safeTime(data.used_slots) ||
      data.used_slots > 4294967295 ||
      (claims.slot_limit !== 'unlimited' && data.used_slots > claims.slot_limit) ||
      (reclaim && data.used_slots !== claims.roster.length)
    )
      throw invalidRights()
    result.used_slots = data.used_slots
  }
  if (Object.hasOwn(data, 'available_slots')) {
    const available = data.available_slots
    const capacity = reclaim
      ? Math.min(claims.slot_limit === 'unlimited' ? 10000 : claims.slot_limit, 10000) - claims.roster.length
      : claims.slot_limit === 'unlimited'
        ? null
        : claims.slot_limit - (result.used_slots ?? 0)
    if (
      available !== 0 &&
      (capacity === null
        ? available !== null
        : !safeTime(available) ||
          available > capacity ||
          ((reclaim || result.used_slots !== undefined) && available !== capacity))
    )
      throw invalidRights()
    result.available_slots = available
  }
  if (Object.hasOwn(data, 'reclaim_supported') && data.reclaim_supported !== reclaim) throw invalidRights()
  if (Object.hasOwn(data, 'quota_grants')) result.quota_grants = quotaGrants(data.quota_grants, claims)
  return result
}

/** Per-voucher windows behind the signed aggregate, for display only.
 *
 * The entitlement signs `revision`, `expires_at` and `slot_limit` -- nothing
 * else -- so this detail arrives unsigned and cannot be taken on trust: a wrong
 * one would have the panel state a confident, false expiry date. What makes it
 * usable is that the Authority derives it in the same transaction, from the same
 * `now`, as the aggregate it explains, so it must reconcile exactly. Anything
 * that does not is rejected like any other malformed rights payload.
 *
 * It never participates in admission; `slot_limit` is still enforced solely
 * against the signed aggregate.
 */
function quotaGrants(grants, claims) {
  if (!Array.isArray(grants) || !grants.length || grants.length > MAX_QUOTA_GRANTS) throw invalidRights()
  let total = 0
  let unlimited = false
  let soonest = Infinity
  const clean = grants.map((grant) => {
    if (!safeTime(grant.expires_at) || grant.expires_at < 1) throw invalidRights()
    soonest = Math.min(soonest, grant.expires_at)
    if (Object.hasOwn(grant, 'slot_limit')) {
      if (!safeTime(grant.slot_limit) || grant.slot_limit < 1 || grant.slot_limit > 4294967295) throw invalidRights()
      total += grant.slot_limit
    } else {
      unlimited = true
    }
    if (Object.hasOwn(grant, 'code_id') && (typeof grant.code_id !== 'string' || grant.code_id.length > 64))
      throw invalidRights()
    // Rebuilt rather than passed through, so only fields that were checked here
    // can reach the panel.
    return {
      ...(Object.hasOwn(grant, 'code_id') && { code_id: grant.code_id }),
      expires_at: grant.expires_at,
      ...(Object.hasOwn(grant, 'slot_limit') && { slot_limit: grant.slot_limit }),
    }
  })
  // Seats are the sum of the active windows, and one unlimited window makes the
  // whole subscription unlimited.
  if (claims.slot_limit === 'unlimited' ? !unlimited : unlimited || total !== claims.slot_limit) throw invalidRights()
  // The signed window ends at the window that lapses first: after that the total
  // drops, so the entitlement has to be re-signed rather than outlive it.
  if (soonest !== claims.expires_at) throw invalidRights()
  return clean
}

function availableSeats(claims, rights, active) {
  if (!active) return 0
  if (Object.hasOwn(rights, 'available_slots')) return rights.available_slots ?? 'unlimited'
  if (claims.version === 2) {
    return Math.min(claims.slot_limit === 'unlimited' ? 10000 : claims.slot_limit, 10000) - claims.roster.length
  }
  if (claims.slot_limit === 'unlimited') return 'unlimited'
  return rights.used_slots === undefined ? null : claims.slot_limit - rights.used_slots
}
export const isCragOrderVmId = (id) => typeof id === 'string' && id.length <= 131 && isValidVmId(id)

function checkParents(directory) {
  for (let current = directory; ; current = path.dirname(current)) {
    const st = fs.lstatSync(current)
    if (
      !st.isDirectory() ||
      (st.uid !== uid() && st.uid !== 0) ||
      (st.mode & 0o022 && !(st.uid === 0 && st.mode & 0o1000))
    )
      throw fail()
    if (current === '/') break
  }
}

function readOnlySharedHostId(fd) {
  if (!SHARED_HOST_ID_FILESYSTEMS.has(fs.statfsSync(`/proc/self/fd/${fd}`).type >>> 0)) return false
  const mountId = /^mnt_id:\s+(\d+)$/m.exec(fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))?.[1]
  if (!mountId) return false
  return fs
    .readFileSync('/proc/self/mountinfo', 'utf8')
    .split('\n')
    .some((line) => {
      const [id, , , , mount, options] = line.split(' ', 6)
      return id === mountId && mount === HOST_ID_MOUNT && options.split(',').includes('ro')
    })
}

function load(file, mode, limit, owner = uid()) {
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    const st = fs.fstatSync(fd)
    const ownerSafe = st.uid === owner || (owner === null && (st.uid === 0 || st.uid === uid()))
    const modeSafe = mode == null ? !(st.mode & 0o022) : (st.mode & 0o777) === mode
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      st.size < 1 ||
      st.size > limit ||
      (!(ownerSafe && modeSafe) && !(file === HOST_ID_MOUNT && mode === null && readOnlySharedHostId(fd)))
    )
      throw fail()
    const data = Buffer.alloc(st.size)
    if (fs.readSync(fd, data, 0, data.length, 0) !== data.length) throw fail()
    return new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function hostPackageDigest(projectRoot) {
  // The verified manifest covers every file; issuer and payload key IDs alone can span multiple releases.
  const readManifest = () => {
    const root = cragV2PackageRoot(projectRoot)
    if (!root) throw hostPackageUnready()
    const file = path.join(root, 'manifest.json')
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    try {
      const st = fs.fstatSync(fd)
      if (!st.isFile() || st.size < 1 || st.size > 1024 * 1024) throw hostPackageUnready()
      const bytes = Buffer.alloc(st.size)
      if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw hostPackageUnready()
      return createHash('sha256').update(bytes).digest('hex')
    } finally {
      fs.closeSync(fd)
    }
  }
  try {
    const digest = readManifest()
    cragTargetIds(projectRoot, undefined)
    if (readManifest() !== digest) throw hostPackageUnready()
    return digest
  } catch {
    throw hostPackageUnready()
  }
}

function assertHostPackage(projectRoot, digest) {
  if (!isDigest(digest) || hostPackageDigest(projectRoot) !== digest) throw hostPackageUnready()
}

function standardEnrollment(projectRoot, { issuerId, payloadKeyId }, strict = false) {
  let standard
  try {
    standard = JSON.parse(fs.readFileSync(path.join(projectRoot, 'deploy/payload.json'), 'utf8')).crag_authorization
  } catch (error) {
    if (error.code !== 'ENOENT') throw hostPackageUnready()
  }
  if (!standard) return {}
  if (standard.issuer_public_key_id !== issuerId || standard.payload_key_id !== payloadKeyId) {
    if (strict) throw hostPackageUnready()
    return {}
  }
  return { issuer_public_key_id: issuerId, payload_key_id: payloadKeyId }
}

function hostEnrollmentIdentity(projectRoot, digest) {
  assertHostPackage(projectRoot, digest)
  return standardEnrollment(projectRoot, cragTargetIds(projectRoot, undefined), true)
}

function pinnedIntentKind(intent) {
  const invalid = () => fail('crag_subscription_recovery_unverified', 409)
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) throw invalid()
  if (!isDigest(intent.host_id) || !validVoucher(intent.redemption_code) || !isDigest(intent.host_package_sha256))
    throw invalid()
  // `shop_order_id` records which order bought this voucher so the Authority can
  // later move it by that id. It is deliberately not named `order_id`: that key
  // already carries control flow -- `recover()` treats an intent holding it as one
  // that may only resume through the shop, so reusing it here made recovery return
  // without doing anything and left the order stuck at ready_to_apply.
  if (Object.hasOwn(intent, 'shop_order_id') && !validOrderId(intent.shop_order_id)) throw invalid()
  const keys = Object.keys(intent)
    .filter((key) => key !== 'shop_order_id')
    .sort()
    .join(',')
  if (keys === 'host_id,host_package_sha256,redemption_code') return 'legacy'
  if (keys !== 'enrollment,host_id,host_package_sha256,issuer_public_key_id,redemption_code') throw invalid()
  const selectors = intent.enrollment
  if (!selectors || typeof selectors !== 'object' || Array.isArray(selectors) || !isDigest(intent.issuer_public_key_id))
    throw invalid()
  const selectorKeys = Object.keys(selectors).sort().join(',')
  if (
    selectorKeys !== '' &&
    (selectorKeys !== 'issuer_public_key_id,payload_key_id' ||
      selectors.issuer_public_key_id !== intent.issuer_public_key_id ||
      !isDigest(selectors.payload_key_id))
  )
    throw invalid()
  return 'recorded'
}

function recordedEnrollment(projectRoot, intent) {
  if (pinnedIntentKind(intent) !== 'recorded') throw fail('crag_subscription_recovery_unverified', 409)
  if (cragTargetIds(projectRoot, undefined).issuerId !== intent.issuer_public_key_id)
    throw fail('crag_subscription_recovery_unverified', 409)
  return intent.enrollment
}

function sync(dir) {
  const handle = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  try {
    fs.fsyncSync(handle)
  } finally {
    fs.closeSync(handle)
  }
}

function publish(file, value, mode, createOnly = false) {
  const dir = path.dirname(file)
  const temp = path.join(dir, `.${randomUUID()}.tmp`)
  const fd = fs.openSync(temp, 'wx', mode)
  try {
    fs.fchmodSync(fd, mode)
    fs.writeFileSync(fd, value)
    fs.fsyncSync(fd)
    if (createOnly) fs.linkSync(temp, file)
    else fs.renameSync(temp, file)
  } finally {
    fs.closeSync(fd)
    fs.rmSync(temp, { force: true })
    sync(dir)
  }
}

function remove(file) {
  fs.rmSync(file, { force: true })
  sync(path.dirname(file))
}

async function responseJson(response) {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '') || !response.body) throw fail()
  const reader = response.body.getReader()
  const blocks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_CRAG_HOST_ENTITLEMENT_BYTES + 32768) throw fail()
      blocks.push(value)
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(blocks, size)))
  } finally {
    await reader.cancel().catch(() => {})
  }
}

function isContainerized() {
  return (
    process.env.container ||
    ['/.dockerenv', '/run/.containerenv', '/run/systemd/container'].some((file) => fs.existsSync(file))
  )
}

export function createCragSubscription({
  projectRoot,
  listTargets,
  getTarget,
  isLocalCragSlot,
  isSubscriptionSlot,
  assertReady,
  isSlotEnabled,
  runtimeInventory,
  publishClusterBinding = publishClusterSubscription,
  publishKvmBinding = publishKvmCragLicense,
  blockKvmBinding = blockKvmCragSubscription,
  fetchImpl = globalThis.fetch,
  origin = AUTHORITY,
  machineIdFile = process.env.KIN_CRAG_HOST_ID_FILE,
  netDirectory = NET_DIRECTORY,
} = {}) {
  if (origin !== AUTHORITY && !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin)) throw fail()
  const publicDir = cragSubscriptionPublicDirectory(projectRoot)
  const base = path.dirname(publicDir)
  const dataDir = path.dirname(base)
  const privateDir = path.join(base, 'private')
  const hostFile = path.join(publicDir, 'host_id')
  const uuidFile = path.join(publicDir, 'device_uuid')
  const keyFile = path.join(privateDir, 'credential')
  const entitlementFile = path.join(publicDir, 'entitlement.code')
  const intentFile = path.join(privateDir, 'redeem.json')
  const rosterIntentFile = path.join(privateDir, 'roster.json')
  const deferredReleaseFile = path.join(privateDir, 'deleted-slots.json')
  const marker = path.join(publicDir, 'sync-pending')
  /** null = idle. Otherwise the in-flight exclusive operation: `done` settles once
   * its guest re-delivery finished, so a waiter that wakes on it sees a settled host. */
  let exclusiveState = null
  /** Set inside an exclusive work body. A nested admission must not wait on the
   * operation it is itself running under. */
  const exclusiveScope = new AsyncLocalStorage()
  const runtimeReservations = new Set()
  let admissionWaiters = 0
  let admissionQueue = Promise.resolve()
  let expiryProbe
  let lastExpiryProbe

  function machineIdRaw(file, native) {
    let raw
    try {
      const resolved = native ? fs.realpathSync(file) : file
      if (native) checkParents(path.dirname(resolved))
      raw = load(resolved, null, 64, machineIdFile ? null : 0)
        ?.trim()
        .toLowerCase()
    } catch {
      return null
    }
    if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(raw || '')) raw = raw.replaceAll('-', '')
    if (!/^[a-f0-9]{32}$/.test(raw || '') || /^(0{32}|f{32})$/.test(raw)) return null
    return raw
  }

  /** Where this machine's identity can be sampled from, best first. The MAC
   * comes before the machine-id because it is the one that is actually unique;
   * see `macDeviceRaw`. */
  function* candidateRaws() {
    if (machineIdFile) {
      for (const file of [machineIdFile].flat()) yield ['override', machineIdRaw(file, false)]
      return
    }
    yield ['mac', macDeviceRaw(netDirectory)]
    if (!fs.existsSync(HOST_ID_MOUNT) && !isContainerized()) {
      for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) yield ['machine-id', machineIdRaw(file, true)]
    } else {
      yield ['mount', machineIdRaw(HOST_ID_MOUNT, false)]
    }
  }

  /** The stored readable form, if it is there and really does derive `hostId`.
   * The host id stays the single authority: a `device_uuid` that does not
   * derive it was tampered with or belongs to another install. */
  function readStoredUuid(hostId) {
    let stored
    try {
      stored = load(uuidFile, 0o644, 36)
    } catch {
      return null
    }
    return stored && normalizeDeviceUuid(stored) === stored && uuidToHostId(stored) === hostId ? stored : null
  }

  /** Recover the readable form for an install that predates `device_uuid`, and
   * write it out once. Returns null when it cannot be reconstructed. */
  function backfillUuid(hostId, sources) {
    for (const [, raw] of sources) {
      if (hostIdFromRaw(raw) !== hostId) continue
      const uuid = formatDeviceUuid(raw)
      try {
        publish(uuidFile, uuid, 0o644)
      } catch {
        // Being able to display the identity is not worth failing a request over.
      }
      return uuid
    }
    // A machine whose machine-id has since changed cannot have its UUID
    // reconstructed -- sha256 does not run backwards. Reporting null is honest.
    // A fabricated one would not derive this host id, and would silently aim a
    // migration at a device that does not exist.
    return null
  }

  /** Resolves this machine's identity as `{ hostId, uuid, source }`. */
  function deviceIdentity() {
    if (process.platform !== 'linux') throw hostIdentityUnavailable()
    let saved
    try {
      storage()
      saved = load(hostFile, 0o644, 64)
    } catch {
      throw fail('crag_subscription_storage_unavailable')
    }
    // A stored identity is returned exactly as it stands, with no value
    // comparison. This machine has already paid; a regenerated machine-id, a
    // rebuilt container or a swapped NIC must not turn it into a stranger. This
    // is what used to raise `crag_subscription_host_identity_changed`, and what
    // left paid hosts wedged after ordinary maintenance.
    //
    // Sources are still required to be sound: one that is missing or replaced by
    // something unsafe is a different matter from one whose value changed, and
    // only the latter is tolerated. In the settled case any single sound source
    // settles that, and `candidateRaws` is lazy, so this path does not sample
    // every source -- it runs on slot-start admission.
    if (saved) {
      const stored = readStoredUuid(saved)
      if (stored) {
        for (const [, raw] of candidateRaws()) {
          if (raw) return { hostId: saved, uuid: stored, source: 'saved' }
        }
        throw hostIdentityUnavailable()
      }
      const sources = [...candidateRaws()].filter(([, raw]) => raw)
      if (!sources.length) throw hostIdentityUnavailable()
      return { hostId: saved, uuid: backfillUuid(saved, sources), source: 'saved' }
    }
    const sources = [...candidateRaws()].filter(([, raw]) => raw)
    if (!sources.length) throw hostIdentityUnavailable()
    const [source, raw] = sources[0]
    return { hostId: hostIdFromRaw(raw), uuid: formatDeviceUuid(raw), source }
  }

  function identity() {
    return deviceIdentity().hostId
  }

  /** Discard the stored identity and re-derive it from the NIC.
   *
   * Reserved for the credential-recovery flow, once recovery has been refused
   * and this host id is judged to be shared with another machine -- without
   * this, such a machine is stuck for good: its stored host id answers 403
   * forever, recovery must keep refusing it, and "a stored identity is
   * permanent" would otherwise mean permanently broken. Doing it on the ordinary
   * path instead would make every identity drift by itself, which is the exact
   * guarantee `deviceIdentity` exists to provide. */
  function rebuildDeviceIdentity({ reason } = {}) {
    if (!reason) throw fail()
    storage()
    const raw = macDeviceRaw(netDirectory)
    // Without a usable NIC the rebuild would land right back on the machine-id
    // it is trying to escape, destroying the stored identity for nothing.
    if (!raw) throw hostIdentityUnavailable()
    const uuid = formatDeviceUuid(raw)
    const hostId = hostIdFromRaw(raw)
    publish(hostFile, hostId, 0o644)
    publish(uuidFile, uuid, 0o644)
    return { hostId, uuid, source: 'mac' }
  }

  function storage(create = false) {
    checkParents(dataDir)
    if (!localFilesystems.has(fs.statfsSync(dataDir).type >>> 0)) throw fail()
    for (const [directory, mode] of [
      [base, 0o755],
      [publicDir, 0o755],
      [privateDir, 0o700],
    ]) {
      if (create) {
        try {
          fs.mkdirSync(directory, { mode })
          // Restore the required traversal mode on this newly created directory
          // even under a restrictive service umask. Never repair existing paths.
          const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
          try {
            if (fs.fstatSync(fd).uid !== uid()) throw fail()
            fs.fchmodSync(fd, mode)
            fs.fsyncSync(fd)
          } finally {
            fs.closeSync(fd)
          }
          sync(path.dirname(directory))
        } catch (error) {
          if (error.code !== 'EEXIST') throw error
        }
      }
      if (!fs.existsSync(directory)) continue
      const st = fs.lstatSync(directory)
      if (!st.isDirectory() || (st.mode & 0o777) !== mode || st.uid !== uid()) throw fail()
    }
  }

  function current(hostId, vm) {
    const savedHost = load(hostFile, 0o644, 64)
    if (savedHost != null && savedHost !== hostId) throw fail()
    const code = load(entitlementFile, 0o644, MAX_CRAG_HOST_ENTITLEMENT_BYTES)
    if (!code) return null
    if (!savedHost) throw fail()
    return { code, claims: verifyCragHostEntitlement(projectRoot, code, hostId, { allowExpired: true, vm }) }
  }

  function credential(hostId, initialize = false) {
    const prior = load(hostFile, 0o644, 64)
    if (prior != null && prior !== hostId) throw fail()
    let key = load(keyFile, 0o600, 43)
    if (!key) {
      if (
        !initialize ||
        prior ||
        load(intentFile, 0o600, MAX_REDEEM_INTENT_BYTES) ||
        load(entitlementFile, 0o644, 8192) ||
        load(marker, 0o644, 32)
      )
        throw fail()
      key = randomBytes(32).toString('base64url')
      publish(keyFile, key, 0o600, true)
    }
    if (!validVoucher(`CRAGR1.${key}`)) throw fail()
    if (!prior) {
      if (!initialize) throw fail()
      publish(hostFile, hostId, 0o644, true)
    }
    return key
  }

  async function ready(opts, targets) {
    for (const vm of targets ?? (await listTargets())) {
      try {
        if ((await assertReady(vm, opts)) !== false) return true
      } catch (error) {
        if (error.code !== 'crag_subscription_target_unready') throw error
      }
    }
    return false
  }

  function preserveOtherLicense(vm) {
    const { license } = getCragLicense(projectRoot, vm)
    if (license.valid && license.scope !== 'host') throw fail('crag_subscription_target_unready', 409)
  }

  async function orderTarget(hostId, vmId) {
    if (!isCragOrderVmId(vmId)) throw fail('crag_subscription_target_unready', 409)
    const vm = getTarget ? await getTarget(vmId) : (await listTargets()).find(({ id }) => id === vmId)
    if (vm?.id !== vmId) throw fail('crag_subscription_target_unready', 409)
    const options = { allowPrepared: true }
    if ((await assertReady(vm, options)) === false) throw fail('crag_subscription_target_unready', 409)
    preserveOtherLicense(vm)
    const machineCode = prepareCragSubscriptionBinding(projectRoot, vm)
    const { payloadKeyId, issuerId } = cragTargetIds(projectRoot, vm)
    // Pin both the actual device key and the persisted VM owner, not Docker's mutable container ID.
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          hostId,
          machineCode,
          vm.owner_user_id ?? null,
          payloadKeyId,
          ...(vm.node_id ? [vm.node_id] : []),
        ]),
      )
      .digest('hex')
    return { vm, machineCode, payloadKeyId, issuerId, fingerprint }
  }

  function readLocalRights() {
    // One resolution yields all three: the identity is resolved here anyway, so
    // carrying the displayable form and its source along costs nothing.
    const { hostId, uuid, source } = deviceIdentity()
    const previous = current(hostId)
    const pending =
      load(marker, 0o644, 32) != null ||
      load(intentFile, 0o600, MAX_REDEEM_INTENT_BYTES) != null ||
      load(rosterIntentFile, 0o600, 1024) != null
    const claims = previous?.claims ?? null
    if (claims && (!safeTime(claims.expires_at) || !safeTime(claims.revision))) throw fail()
    return { hostId, uuid, source, claims, pending, previous }
  }

  function unchangedRights(before, after) {
    return (
      before.hostId === after.hostId &&
      before.pending === after.pending &&
      before.previous?.code === after.previous?.code
    )
  }

  async function refreshExpired(hostId, previous, background = false) {
    if (!previous || previous.claims.expires_at * 1000 > Date.now()) return previous
    const remote = await authority('status', hostId, credential(hostId))
    const confirmed = verifyRights(hostId, remote, previous)
    if (background && (exclusiveState || !unchangedRights({ hostId, pending: false, previous }, readLocalRights())))
      return
    if (confirmed.code === previous.code) return confirmed
    if (current(hostId)?.code !== previous.code) throw invalidRights()
    checkNoIntent()
    publish(entitlementFile, confirmed.code, 0o644)
    return confirmed
  }

  async function refreshExpiredEntitlement() {
    if (expiryProbe) return expiryProbe
    if (exclusiveState || !fs.existsSync(entitlementFile)) return
    const { hostId, claims, pending, previous } = readLocalRights()
    const now = Date.now()
    if (pending || !claims || claims.expires_at * 1000 > now) return
    if (lastExpiryProbe?.code === previous.code && now < lastExpiryProbe.retryAfter) return
    lastExpiryProbe = { code: previous.code, retryAfter: now + 30_000 }
    expiryProbe = refreshExpired(hostId, previous, true)
    try {
      const confirmed = await expiryProbe
      if (!confirmed) lastExpiryProbe = undefined
      return confirmed
    } finally {
      expiryProbe = undefined
    }
  }

  async function runtimeStatus(rights) {
    if (!runtimeInventory) return {}
    let result = {}
    try {
      const { hostId, claims, pending } = rights || { claims: null, pending: true }
      const runtime = await runtimeInventory.snapshot({ hostId, claims, pending })
      result = { runtime }
    } catch {
      // Keep confirmed subscription fields if the independent runtime probe fails.
    }
    if (rights && !unchangedRights(rights, readLocalRights())) return null
    return result
  }

  function withRuntimeAdmission(vm, { install = false, bindSubscription = false } = {}, start) {
    if (!runtimeInventory) return start()
    const options = { preferInstalled: !install }
    const { license } = getCragLicense(projectRoot, vm, options)
    const rebindable = new Set([
      'license_required',
      'license_crag_host_over_quota',
      'license_payload_key_mismatch',
      'license_binding_mismatch',
    ])
    if (license.valid && license.scope !== 'host') return start()
    if (!license.valid && !((bindSubscription || install) && rebindable.has(license.code))) {
      return denyRuntime(license)
    }
    if (admissionWaiters >= 32)
      return { ok: false, status: 409, code: 'crag_subscription_busy', error: 'CRAG 启动操作繁忙，请稍后重试。' }
    admissionWaiters++
    let reserved = false
    const admit = admissionQueue
      .then(async () => {
        const rights = readLocalRights()
        const checked = getCragLicense(projectRoot, vm, options).license
        const needsBinding = rebindable.has(checked.code) && (bindSubscription || install)
        if (!checked.valid && !needsBinding) return denyRuntime(checked)
        if (checked.valid && checked.scope !== 'host') return null
        if (!rights.claims && needsBinding) {
          return denyRuntime(checked.code === 'license_required' ? checked : { ...checked, code: 'license_required' })
        }
        assertActive(rights.previous)
        if (runtimeReservations.has(vm.id))
          return { ok: false, status: 409, code: 'crag_slot_start_busy', error: '此 CRAG 槽位正在启动或更新。' }
        const runtime = await runtimeInventory.snapshot({ ...rights, hostOnly: true, fresh: true, timeoutMs: 4000 })
        if (!unchangedRights(rights, readLocalRights())) return runtimeDenial(usageUnverified())
        const roster = rights.claims.roster
        const occupying = new Set(runtimeReservations)
        let uncertain = false
        for (const [id, entry] of Object.entries(runtime.vms)) {
          if (id === vm.id || entry.scope === 'independent' || entry.quota_blocked) continue
          if (entry.state === 'running') occupying.add(id)
          else if (!entry.stopped_confirmed && !entry.non_crag_confirmed) {
            occupying.add(id)
            uncertain = true
          }
        }
        const limit = roster
          ? Math.min(rights.claims.slot_limit === 'unlimited' ? 10000 : rights.claims.slot_limit, 10000)
          : rights.claims.slot_limit
        const alreadyRunning = runtime.vms?.[vm.id]?.state === 'running'
        if (!alreadyRunning && limit !== 'unlimited' && occupying.size >= limit) {
          return runtimeDenial(uncertain ? usageUnverified() : overQuota())
        }
        runtimeReservations.add(vm.id)
        reserved = true
        if (!needsBinding || install || !bindSubscription) return null
        await exclusive(async () => {
          const priorBind = readRosterIntent()
          if (priorBind?.action === 'bind' && !priorBind.reissue) clearRosterIntent()
          const currentRights = readLocalRights()
          if (currentRights.previous?.code !== rights.previous?.code) throw fail('crag_subscription_sync_pending', 409)
          await bindForStart(
            vm,
            rights.previous,
            rights.hostId,
            cragTargetIds(projectRoot, vm).payloadKeyId,
            {},
            runtime,
          )
        })
        return null
      })
      .catch((error) => {
        if (authorityErrors.has(error?.code) || error?.code?.startsWith('crag_subscription_')) {
          return { ok: false, status: error.status || 409, code: error.code, error: error.message }
        }
        return runtimeDenial(usageUnverified())
      })
    admissionQueue = admit.finally(() => {
      admissionWaiters--
    })
    return admit
      .then((denial) => denial || start())
      .finally(() => {
        if (reserved) runtimeReservations.delete(vm.id)
      })
  }

  async function admitOnce({ vm, routing, health } = {}) {
    if (!vm?.id) return null
    const liveCrag = health?.runtime_variant === 'crag-v2' || (!health?.runtime_variant && health?.dataplane === 'crag')
    if (!liveCrag && resolveKernelDataplane(vm, routing) !== 'crag') return null
    let hostId
    try {
      hostId = identity()
    } catch {
      // No host identity need be available for an independent grant.
    }
    try {
      const localKvm = !vm.node_id && isKvmRuntime(vm)
      if (!readCragSubscriptionReleaseCandidate(projectRoot, vm, hostId)) {
        if (isKvmRuntime(vm) && vm.status === 'running' && getCragLicense(projectRoot, vm).license.valid) {
          if ((await publishKvmBinding(projectRoot, vm)) === false && localKvm) return usageUnverified()
        }
        return null
      }
      const rights = readLocalRights()
      if (!rights.claims) return usageUnverified()
      if (localKvm && exclusiveState) return EXCLUSIVE_BUSY
      const { license } = getCragLicense(projectRoot, vm)
      if (!license.valid) {
        if (localKvm) {
          try {
            await blockKvmBinding(projectRoot, vm)
          } catch {
            // A delivery failure does not change the verified reason this request is denied.
          }
        }
        return cragLicenseDeniedResult({ code: license.code, error: license.message })
      }
      if (license.scope !== 'host') return usageUnverified()
      if (localKvm) {
        try {
          if ((await publishKvmBinding(projectRoot, vm)) !== true) return usageUnverified()
        } catch {
          return cragLicenseDeniedResult({
            code: 'license_crag_kvm_sync_failed',
            error: 'KVM 槽授权未同步，请检查 guest 状态后重试。',
          })
        }
        if (!unchangedRights(rights, readLocalRights())) return usageUnverified()
      }
      if (vm.node_id && vm.status === 'running') {
        try {
          const publishSlot = isKvmRuntime(vm) ? publishKvmBinding : publishClusterBinding
          if ((await publishSlot(projectRoot, vm)) === false) return usageUnverified()
        } catch {
          return cragLicenseDeniedResult({
            code: 'license_crag_slot_sync_failed',
            error: '槽位授权未同步，请检查槽位连接后重试。',
          })
        }
        if (!unchangedRights(rights, readLocalRights())) return usageUnverified()
      }
      return null
    } catch {
      // A malformed host permit or unreadable local quota cannot authorize a new hop.
    }
    return usageUnverified()
  }

  /**
   * Any roster change republishes the single host entitlement every slot's grant
   * is derived from, so an in-flight exclusive operation cannot be narrowed to the
   * slot it names. Rather than deny every local KVM slot for the whole operation
   * (#1307: 27 slots, ~25 minutes of rolling 403s during a per-slot migration),
   * wait for it to finish and re-run the same checks against the settled host.
   */
  async function admitInference({ vm, routing, health, slotWaitDeadlineMs } = {}) {
    const first = await admitOnce({ vm, routing, health })
    if (first !== EXCLUSIVE_BUSY) return first
    // Running inside the work body itself: waiting here would wait on us.
    if (exclusiveScope.getStore()) return usageUnverified()
    const pending = exclusiveState
    const budgetMs = exclusiveWaitBudgetMs(slotWaitDeadlineMs)
    const retryable = { retryable: true, retryAfterSeconds: Math.max(1, Math.ceil(budgetMs / 1000)) }
    if (!(await settledWithin(pending, budgetMs))) return usageUnverified(retryable)
    // One retry only: back-to-back operations must not chain a request forever.
    const second = await admitOnce({ vm, routing, health })
    return second === EXCLUSIVE_BUSY ? usageUnverified(retryable) : second
  }

  async function status(confirmed, mayRetry = true) {
    let targets
    let inventory = {}
    let target_probe_failed = false
    let credential_recovery
    try {
      targets = await listTargets()
      if (isLocalCragSlot) {
        const activated = []
        for (const vm of targets.filter(isLocalCragSlot)) {
          const { license } = getCragLicense(projectRoot, vm)
          if (license.valid && safeTime(license.expires_at)) {
            activated.push({ vm_id: vm.id, scope: license.scope, expires_at: license.expires_at })
          }
        }
        inventory = {
          activated_slots: activated.sort(
            (first, second) => first.expires_at - second.expires_at || first.vm_id.localeCompare(second.vm_id),
          ),
        }
      }
    } catch {
      target_probe_failed = true
    }
    try {
      const local = readLocalRights()
      const { hostId, uuid, source, claims, pending, previous } = local
      const reclaim_pending_count = readDeferredReleases(hostId).filter((entry) => entry.proven).length
      try {
        await ensureCredential(hostId)
      } catch (error) {
        // A lost credential that cannot be re-established is reported through
        // the local check below, which is the one that decides what the panel
        // shows. Recovery is an attempt to avoid that, not a new failure mode.
        if (error.recovery && error.recovery !== 'unavailable') credential_recovery = error.recovery
      }
      if (load(hostFile, 0o644, 64)) credential(hostId)
      const needsRefresh = claims && claims.expires_at * 1000 <= Date.now()
      if (needsRefresh && !pending && !confirmed && mayRetry) {
        try {
          confirmed = await refreshExpiredEntitlement()
        } catch {
          // An expired signed window stays expired if the Authority is unreachable.
        }
        if (!unchangedRights(local, readLocalRights())) return status(confirmed, false)
      }
      let rights = claims ? { reclaim_supported: claims.version === 2 } : {}
      if (claims && !pending) {
        if (confirmed?.code === previous.code && confirmed.rights) {
          rights = confirmed.rights
        } else if (!needsRefresh) {
          try {
            const remote = await authority('status', hostId, credential(hostId))
            if (remote.entitlement === previous.code) rights = projection(remote, claims)
          } catch (error) {
            // Signed local rights still apply during an Authority outage. Do not guess remote metadata.
            // A refused credential recovery is not an outage though: it is a
            // durable fault only the operator can clear -- most often this host
            // id being shared with another machine. Surfacing it here is the
            // difference between "the panel looks normal until a redemption
            // mysteriously fails" and being told what to fix.
            if (error.recovery && error.recovery !== 'unavailable') credential_recovery = error.recovery
          }
        }
      }
      const expired = claims && claims.expires_at <= Math.floor(Date.now() / 1000)
      let total_slots, enabled_slots, upgrade_available
      let targetReady = false
      // Slot inventory is not the authority for signed host rights.
      try {
        if (targets && isSubscriptionSlot) total_slots = targets.filter(isSubscriptionSlot).length
        targetReady = !!targets && !pending && (await ready({ allowPrepared: true }, targets))
        if (targets && claims?.version === 1 && !pending) upgrade_available = await ready({ reclaim: true }, targets)
        if (targets && isSlotEnabled && (claims || isSubscriptionSlot)) {
          let enabled = 0
          for (const vm of claims && !pending ? targets : []) {
            if (await isSlotEnabled(vm, { reclaim: claims.version === 2 })) enabled += 1
          }
          enabled_slots = enabled
        }
      } catch {
        target_probe_failed = true
      }
      const runtime = await runtimeStatus(local)
      if (runtime === null && mayRetry) return status(confirmed, false)
      return {
        ready: targetReady,
        // The identity itself, so the panel can show what to quote in a support
        // request and which source it came from. `uuid` is null on an install
        // whose original source is gone (see `storedUuid`).
        ...(uuid && { device_uuid: uuid }),
        identity_source: source,
        ...(target_probe_failed && { target_probe_failed }),
        ...(credential_recovery && { credential_recovery }),
        state: pending ? 'sync_pending' : claims ? (expired ? 'expired' : 'active') : 'unredeemed',
        ...(claims && { slot_limit: claims.slot_limit, expires_at: claims.expires_at, revision: claims.revision }),
        ...rights,
        available_seats: pending || runtime === null ? null : availableSeats(claims, rights, claims && !expired),
        reclaim_pending_count,
        ...inventory,
        ...(Array.isArray(targets) && { vm_count: targets.length }),
        ...(total_slots !== undefined && { total_slots }),
        ...(enabled_slots !== undefined && { enabled_slots }),
        ...(upgrade_available && { upgrade_available }),
        ...runtime,
      }
    } catch {
      // Report this machine's identity even when nothing above succeeded. It is
      // derived from local files and never needs the Authority, so withholding it
      // here only hides it from the hosts that need it most: the panel drops the
      // whole device-identity block -- and with it the only migration entry --
      // whenever `device_uuid` is missing, and a host whose credential the
      // Authority rejects lands in this branch on every single refresh. That is
      // exactly the host whose way back in is to claim by order id.
      //
      // Re-read rather than hoisted out of the `try`: the read itself can throw,
      // and hoisting it would take the whole status response down with it instead
      // of degrading to the shape this returned before.
      let identity
      try {
        identity = deviceIdentity()
      } catch {
        identity = undefined
      }
      return {
        ready: false,
        state: 'unavailable',
        ...(identity?.uuid && { device_uuid: identity.uuid }),
        ...(identity && { identity_source: identity.source }),
        available_seats: null,
        ...(target_probe_failed && { target_probe_failed }),
        ...inventory,
        ...(Array.isArray(targets) && { vm_count: targets.length }),
        ...(await runtimeStatus()),
      }
    }
  }

  /** One recovery is shared by every caller that races into the same 403.
   * Each one replacing the credential in turn would invalidate the one before
   * it, so concurrent attempts would take turns locking each other out. */
  let credentialRecovery = null

  /** The Authority knows this host but rejected our credential -- the usual
   * cause is a rebuilt data directory that lost `<private>/credential`.
   *
   * The stored entitlement is what proves ownership in its place: the Authority
   * signed it itself and bound it to this host id, so presenting it is enough
   * to have the credential replaced without touching a single right. Returns
   * the replacement, or null when this machine has nothing to prove ownership
   * with (it never activated successfully, so this is not a recovery case). */
  async function recoverCredential(hostId) {
    credentialRecovery ??= (async () => {
      const entitlement = load(entitlementFile, 0o644, MAX_CRAG_HOST_ENTITLEMENT_BYTES)
      if (!entitlement) return null
      const replacement = randomBytes(32).toString('base64url')
      // Only persist once the Authority accepted it: writing first would leave
      // a credential the Authority never saw. Either order self-heals, since
      // recovery does not depend on the local credential, but this one keeps
      // the stored secret meaningful at every point.
      await authority('recover', hostId, replacement, { entitlement }, false)
      publish(keyFile, replacement, 0o600)
      return replacement
    })().finally(() => {
      credentialRecovery = null
    })
    return credentialRecovery
  }

  /** A credential that is simply *gone* never reaches the Authority at all:
   * `credential()` refuses to mint a second one for a host that is already
   * bound, so the call fails locally and the subscription reads as unavailable.
   * That is the right default -- minting one silently would orphan the host --
   * but when the signed entitlement is still on disk, ownership can be proven
   * and the credential re-established instead of stranding the operator. */
  async function ensureCredential(hostId) {
    if (load(keyFile, 0o600, 43) || !load(hostFile, 0o644, 64)) return
    await recoverCredential(hostId)
  }

  async function authority(action, hostId, key, extra, allowRecovery = true) {
    let requestId
    let status
    let code
    try {
      const response = await fetchImpl(`${origin}/v1/host-subscriptions/${action}`, {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ host_id: hostId, ...extra }),
      })
      const id = response.headers.get('x-request-id')
      if (authorityRequestId.test(id ?? '')) requestId = id
      status = response.status
      const envelope = await responseJson(response)
      if (response.ok && envelope?.ok === true && envelope.data && typeof envelope.data === 'object')
        return envelope.data
      if (envelope?.ok === false && authorityErrors.get(envelope.error?.code) === status) {
        code = envelope.error.code
      }
    } catch {
      // A transport or decoding failure does not prove the Authority rejected the operation.
    }
    const error = code ? fail(code, status) : fail('crag_subscription_authority_unavailable', 502)
    if (requestId) error.authorityRequestId = requestId
    if (code === 'auth_forbidden' && allowRecovery) {
      let replacement
      try {
        replacement = await recoverCredential(hostId)
      } catch (recoveryError) {
        // Recovery is deliberately refused when this host id is shared with
        // another machine -- a cloned VPS image that kept its machine-id --
        // because otherwise the two would take the subscription from each
        // other. Report the original rejection, but record which case it is so
        // the panel can say what to do instead of showing a bare 403.
        error.recovery =
          recoveryError.code === 'auth_forbidden'
            ? 'host_id_collision'
            : recoveryError.code === 'crag_subscription_authority_unavailable'
              ? 'unavailable'
              : 'failed'
        throw error
      }
      // Retry once, never in a loop: a replacement the Authority just accepted
      // that is rejected again is a real failure, not something to grind on.
      if (replacement) return await authority(action, hostId, replacement, extra, false)
      error.recovery = 'not_activated'
    }
    throw error
  }

  function verifyRights(hostId, data, previous, vm) {
    const next = verifyCragHostEntitlement(projectRoot, data.entitlement, hostId, { allowExpired: true, vm })
    if (
      next.revision !== data.revision ||
      next.expires_at !== data.expires_at ||
      next.slot_limit !== data.slot_limit ||
      (previous &&
        (next.revision < previous.claims.revision ||
          (previous.claims.version === 2 && next.version !== 2) ||
          (next.revision === previous.claims.revision && data.entitlement !== previous.code)))
    ) {
      throw fail('crag_subscription_invalid_entitlement', 502)
    }
    return { code: data.entitlement, claims: next, rights: projection(data, next) }
  }

  const voucherDigest = (voucher) => createHash('sha256').update(voucher).digest('hex')
  const redemptionReceiptFile = (digest) => path.join(privateDir, `redeemed-${digest}.json`)

  function appliedRedemption(hostId, digest) {
    if (!isDigest(digest)) throw fail('crag_subscription_invalid_request', 400)
    if (identity() !== hostId) throw hostIdentityChanged()
    const raw = load(redemptionReceiptFile(digest), 0o600, MAX_CRAG_HOST_ENTITLEMENT_BYTES + 512)
    if (raw === null) return null
    try {
      const receipt = JSON.parse(raw)
      if (
        Object.keys(receipt).sort().join(',') !== 'entitlement,host_id,version,voucher_sha256' ||
        receipt.version !== 1 ||
        receipt.host_id !== hostId ||
        receipt.voucher_sha256 !== digest
      )
        throw invalidRights()
      const proof = verifyCragHostEntitlement(projectRoot, receipt.entitlement, hostId, { allowExpired: true })
      const installed = current(hostId)
      if (
        !installed ||
        installed.claims.revision < proof.revision ||
        (installed.claims.revision === proof.revision && installed.code !== receipt.entitlement)
      )
        throw invalidRights()
      // A receipt proves this voucher was applied; it carries no remote metadata.
      // Leaving rights unset lets status() read the current plan and usage instead
      // of reporting a replay as a subscription with no quota information.
      return installed
    } catch {
      throw fail('crag_subscription_invalid_redemption_receipt', 409)
    }
  }

  async function prepareRecovery(hostId, intent, previous, useCurrentPackage) {
    if (!Object.hasOwn(intent, 'host_package_sha256')) return intent
    const kind = pinnedIntentKind(intent)
    const digest = hostPackageDigest(projectRoot)
    if (digest === intent.host_package_sha256) return intent
    if (!useCurrentPackage) throw hostPackageChanged()
    if (kind === 'recorded') {
      // A changed package can replay only the exact original selectors, against
      // the same trusted issuer. Only the same-voucher response proves payment.
      recordedEnrollment(projectRoot, intent)
    } else {
      // Old records lack request selectors. Host status cannot identify which
      // voucher produced existing rights, so only a confirmed absent first
      // subscription permits replacing these records' package pin.
      if (previous) throw fail('crag_subscription_recovery_unverified', 409)
      try {
        await authority('status', hostId, credential(hostId))
        throw fail('crag_subscription_recovery_unverified', 409)
      } catch (error) {
        if (error.code !== 'not_found') throw error
      }
      hostEnrollmentIdentity(projectRoot, digest)
    }
    if (identity() !== hostId) throw hostIdentityChanged()
    assertHostPackage(projectRoot, digest)
    const next = { ...intent, host_package_sha256: digest }
    // Replace atomically: a crash leaves either the original request or its
    // explicitly authorized replacement, never an empty transaction window.
    publish(intentFile, JSON.stringify(next), 0o600)
    return next
  }

  // Tell the Authority which shop order bought this voucher, so the buyer can later
  // migrate it by order id -- the only handle that survives losing this machine.
  //
  // Degrades instead of failing: the Authority's redeem request rejects unknown
  // fields with `invalid_request` (400), so an instance newer than the Authority
  // would have every redemption die on `order_id` alone. Mapping `invalid_request`
  // in `authorityErrors` lets us tell that shape rejection apart from a 502
  // transport/availability failure and retry once without `order_id`. Recording
  // the order only matters for a migration that has not happened yet; it must
  // never block the redemption in front of us.
  async function redeemAtAuthority(hostId, intent, enrollment) {
    const body = { redemption_code: intent.redemption_code, ...enrollment }
    // Both paths carry a real shop order id: `order_id` on an order-driven activation
    // and `shop_order_id` on a device checkout. Shapes are kept in step with the
    // Authority's own CHECK, so a malformed id is simply not sent rather than relying
    // on the degrade path below to absorb it.
    const candidate = intent.shop_order_id ?? intent.order_id
    const orderId = validOrderId(candidate) ? candidate : undefined
    if (!orderId) return authority('redeem', hostId, credential(hostId), body)
    try {
      return await authority('redeem', hostId, credential(hostId), { ...body, order_id: orderId })
    } catch (error) {
      // Only a rejected request shape means this Authority predates `order_id`. A
      // 502 must keep its meaning -- the redemption may well have committed, and
      // retrying here would resolve a sync that is supposed to stay pending.
      if (error?.code !== 'invalid_request') throw error
      return authority('redeem', hostId, credential(hostId), body)
    }
  }

  async function finish(hostId, intent, previous, asserted = {}, replay = false) {
    const digest = voucherDigest(intent.redemption_code)
    const applied = appliedRedemption(hostId, digest)
    if (applied) {
      remove(marker)
      remove(intentFile)
      return applied
    }
    let enrollment = asserted
    if (Object.hasOwn(intent, 'host_package_sha256')) {
      const kind = pinnedIntentKind(intent)
      assertHostPackage(projectRoot, intent.host_package_sha256)
      enrollment =
        kind === 'recorded'
          ? recordedEnrollment(projectRoot, intent)
          : hostEnrollmentIdentity(projectRoot, intent.host_package_sha256)
    }
    publish(marker, 'pending\n', 0o644)
    let data
    try {
      data = await redeemAtAuthority(hostId, intent, enrollment)
    } catch (error) {
      // A denial on replay does not tell us whether the original request committed.
      if (!replay && error?.code !== 'crag_subscription_authority_unavailable') {
        remove(marker)
        remove(intentFile)
      }
      throw error
    }
    if (Object.hasOwn(intent, 'host_package_sha256')) assertHostPackage(projectRoot, intent.host_package_sha256)
    const confirmed = verifyRights(hostId, data, previous)
    publish(entitlementFile, confirmed.code, 0o644)
    // This private receipt links a successful same-voucher redeem response to
    // signed rights. A generic host status response must never create it.
    publish(
      redemptionReceiptFile(digest),
      JSON.stringify({ version: 1, host_id: hostId, voucher_sha256: digest, entitlement: confirmed.code }),
      0o600,
    )
    remove(marker)
    remove(intentFile)
    return confirmed
  }

  async function kvmBindings() {
    if (process.platform !== 'linux') return []
    const hostId = load(hostFile, 0o644, 65)?.trim()
    if (!hostId) return []
    const targets = await listTargets()
    if (!Array.isArray(targets)) throw fail('crag_subscription_target_unready', 409)
    return targets.filter((vm) => {
      if (vm.node_id || !isKvmRuntime(vm) || vm.status !== 'running') return false
      try {
        return !!readCragSubscriptionReleaseCandidate(projectRoot, vm, hostId)
      } catch {
        // A damaged permit must not leave a previously published guest grant usable.
        return true
      }
    })
  }

  async function blockKvmBindings() {
    for (const vm of await kvmBindings()) await blockKvmBinding(projectRoot, vm)
  }

  async function restoreKvmBindings() {
    const targets = await kvmBindings()
    if (!targets.length) return
    let failed = false
    for (const vm of targets) {
      try {
        const { license } = getCragLicense(projectRoot, vm)
        if (license.valid && license.scope === 'host') {
          await publishKvmBinding(projectRoot, vm)
        } else {
          // Revocation, expiry and an install awaiting a new payload keep the guest blocked.
          await blockKvmBinding(projectRoot, vm)
        }
      } catch {
        failed = true
      }
    }
    if (failed) throw fail('license_crag_kvm_sync_failed', 503)
  }

  async function exclusive(work, { blockBefore = false } = {}) {
    if (exclusiveState) throw fail('crag_subscription_busy', 409)
    let settle
    exclusiveState = { since: Date.now(), done: new Promise((resolve) => (settle = resolve)) }
    const release = holdKvmCragSubscriptionPublications(projectRoot)
    let result, failure
    try {
      if (blockBefore) await blockKvmBindings()
      // The scope marks every async branch started by this body, so a nested
      // admission can tell it is running under the very operation it would wait for.
      result = await exclusiveScope.run(true, () => work())
    } catch (error) {
      failure = error
    } finally {
      release()
      try {
        await restoreKvmBindings()
      } catch (error) {
        failure ??= error
      }
      // Clear before settling: a waiter wakes to an idle host with its guests
      // already re-delivered, never to a state that is still winding down.
      exclusiveState = null
      settle()
    }
    if (failure) throw failure
    return result
  }

  function readRosterIntent() {
    const raw = load(rosterIntentFile, 0o600, 1024)
    return raw == null ? null : JSON.parse(raw)
  }

  function readDeferredReleases(hostId) {
    const raw = load(deferredReleaseFile, 0o600, MAX_DEFERRED_RELEASE_BYTES)
    if (raw == null) return []
    const saved = JSON.parse(raw)
    if (
      !saved ||
      saved.version !== 1 ||
      Object.keys(saved).length !== 3 ||
      !isDigest(saved.host_id) ||
      !Array.isArray(saved.entries) ||
      saved.entries.length > MAX_DEFERRED_RELEASES
    )
      throw fail('crag_subscription_invalid_reclaim', 409)
    if (saved.host_id !== hostId) throw hostIdentityChanged()
    const seen = new Set()
    for (const entry of saved.entries) {
      if (
        !entry ||
        Object.keys(entry).length !== 3 ||
        !isCragOrderVmId(entry.vm_id) ||
        !isDigest(entry.permit_sha256) ||
        typeof entry.proven !== 'boolean' ||
        seen.has(entry.permit_sha256)
      )
        throw fail('crag_subscription_invalid_reclaim', 409)
      seen.add(entry.permit_sha256)
    }
    return saved.entries
  }

  function writeDeferredReleases(hostId, entries) {
    if (entries.length) {
      publish(deferredReleaseFile, JSON.stringify({ version: 1, host_id: hostId, entries }), 0o600)
    } else if (fs.existsSync(deferredReleaseFile)) {
      remove(deferredReleaseFile)
    }
  }

  function saveDeferredRelease(hostId, vmId, permit, proven) {
    const entries = readDeferredReleases(hostId)
    const index = entries.findIndex((entry) => entry.permit_sha256 === permit)
    if (index >= 0 && entries[index].vm_id !== vmId) throw fail('crag_subscription_invalid_reclaim', 409)
    const entry = { vm_id: vmId, permit_sha256: permit, proven }
    if (index >= 0) entries[index] = entry
    else {
      if (entries.length >= MAX_DEFERRED_RELEASES) throw fail('crag_subscription_reclaim_limit', 409)
      entries.push(entry)
    }
    writeDeferredReleases(hostId, entries)
  }

  function removeDeferredRelease(hostId, vmId, permit) {
    const entries = readDeferredReleases(hostId)
    writeDeferredReleases(
      hostId,
      entries.filter((entry) => entry.vm_id !== vmId || entry.permit_sha256 !== permit),
    )
  }

  function checkNoIntent() {
    if (readRosterIntent() || load(intentFile, 0o600, MAX_REDEEM_INTENT_BYTES) || load(marker, 0o644, 32))
      throw fail('crag_subscription_sync_pending', 409)
  }

  function beginRosterIntent(intent) {
    publish(rosterIntentFile, JSON.stringify(intent), 0o600, true)
    publish(marker, 'pending\n', 0o644)
  }

  function clearRosterIntent() {
    remove(marker)
    remove(rosterIntentFile)
  }

  function publishInstallBinding(vm, slotPermit, seat, { claims, code }) {
    const options = { seat, verifiedRights: claims, preferInstalled: false }
    activateCragSubscriptionBinding(projectRoot, vm, slotPermit, { ...options, candidateEntitlement: code })
    publish(entitlementFile, code, 0o644)
    return activateCragSubscriptionBinding(projectRoot, vm, slotPermit, options)
  }

  async function syncRoster(hostId, intent, previous, vm) {
    if (!previous || intent.host_id !== hostId || !['upgrade', 'bind', 'release'].includes(intent.action)) throw fail()
    if (
      intent.action === 'release' &&
      (!isDigest(intent.permit_sha256) || typeof intent.vm_id !== 'string' || intent.proven !== true)
    )
      throw fail()
    publish(marker, 'pending\n', 0o644)
    const data = await authority(
      intent.action === 'bind' ? 'status' : intent.action,
      hostId,
      credential(hostId),
      intent.action === 'release' ? { vm_id: intent.vm_id, permit_sha256: intent.permit_sha256 } : undefined,
    )
    const confirmed = verifyRights(hostId, data, previous, vm)
    const { claims: next } = confirmed
    if (
      next.version !== 2 ||
      (intent.action === 'release' && next.roster.some((entry) => entry.permit_sha256 === intent.permit_sha256))
    )
      throw invalidRights()
    if (intent.action === 'bind' && Object.hasOwn(intent, 'reissue')) {
      const { vm_id, seat, permit_sha256, payload_key_id, machine_sha256 } = intent.reissue
      if (
        typeof vm_id !== 'string' ||
        !isValidVmId(vm_id) ||
        !safeTime(seat) ||
        seat === 0 ||
        ![permit_sha256, payload_key_id, machine_sha256].every(isDigest)
      )
        throw fail()
      const entry = next.roster.find((item) => item.seat === seat)
      if (entry && entry.permit_sha256 !== permit_sha256) {
        const target = getTarget ? await getTarget(vm_id) : (await listTargets()).find(({ id }) => id === vm_id)
        const changed = () => fail('crag_subscription_target_changed', 409)
        if (
          target?.id !== vm_id ||
          cragTargetIds(projectRoot, target, { preferInstalled: false }).payloadKeyId !== payload_key_id
        )
          throw changed()
        const machine_code = prepareCragSubscriptionBinding(projectRoot, target, { preferInstalled: false })
        if (createHash('sha256').update(machine_code).digest('hex') !== machine_sha256) throw changed()
        const binding = await authority('bind', hostId, credential(hostId), { machine_code, payload_key_id })
        if (binding.seat !== seat || binding.entitlement !== confirmed.code) throw invalidRights()
        publishInstallBinding(target, binding.slot_permit, seat, confirmed)
        clearRosterIntent()
        return confirmed
      }
    }
    publish(entitlementFile, confirmed.code, 0o644)
    if (intent.action === 'release' && intent.reclaim === true) {
      const target = getTarget
        ? await getTarget(intent.vm_id)
        : (await listTargets()).find(({ id }) => id === intent.vm_id)
      if (target?.id === intent.vm_id) removeReclaimedCragPermit(projectRoot, target, intent.permit_sha256)
    }
    if (intent.action === 'release' && fs.existsSync(deferredReleaseFile))
      removeDeferredRelease(hostId, intent.vm_id, intent.permit_sha256)
    clearRosterIntent()
    return confirmed
  }

  async function replayDeferredReleases(hostId, previous) {
    const entries = readDeferredReleases(hostId)
    if (previous?.claims.version !== 2) return
    let confirmed,
      blocked = false
    for (const entry of entries) {
      if (!entry.proven) continue
      if (!previous.claims.roster.some((item) => item.permit_sha256 === entry.permit_sha256)) {
        removeDeferredRelease(hostId, entry.vm_id, entry.permit_sha256)
        continue
      }
      const target = getTarget
        ? await getTarget(entry.vm_id)
        : (await listTargets()).find((vm) => vm.id === entry.vm_id)
      if (target) {
        if (runtimeReservations.has(target.id) || vmLockBusy(path.join(projectRoot, 'vms', `${target.id}.json`)))
          continue
        let permit
        try {
          permit = readCragSubscriptionReleaseCandidate(projectRoot, target, hostId)
        } catch {
          continue
        }
        // A failed panel delete can leave the record available for another start.
        if (permit === entry.permit_sha256 && !(await runtimeInventory?.confirmReclaimableStop?.(target))) continue
        if (runtimeReservations.has(target.id) || vmLockBusy(path.join(projectRoot, 'vms', `${target.id}.json`)))
          continue
      }
      checkNoIntent()
      if (!blocked) {
        await blockKvmBindings()
        blocked = true
      }
      if (current(hostId)?.code !== previous.code) throw fail('crag_subscription_sync_pending', 409)
      const intent = { host_id: hostId, action: 'release', ...entry, reclaim: true, deferred: true }
      beginRosterIntent(intent)
      confirmed = await syncRoster(hostId, intent, previous)
      previous = confirmed
    }
    return confirmed
  }

  async function reclaimStoppedSeat(vm, rights, runtime) {
    const { hostId, previous, claims } = rights
    const replayed = await replayDeferredReleases(hostId, previous)
    if (replayed && replayed.claims.roster.length < claims.roster.length) return replayed
    const targets = await listTargets()
    const livePermits = new Set()
    for (const target of targets) {
      let permit_sha256 = null
      try {
        permit_sha256 = readCragSubscriptionReleaseCandidate(projectRoot, target, hostId)
      } catch {
        // Keep searching other targets; corrupt/unready target permits are not counted as valid live bindings.
      }
      if (permit_sha256) livePermits.add(permit_sha256)
      if (!permit_sha256 || !claims.roster.some((entry) => entry.permit_sha256 === permit_sha256)) continue
      if (target.id === vm.id || runtimeReservations.has(target.id)) continue
      if (
        target.kernel_operation?.phase === 'pending' ||
        vmLockBusy(path.join(projectRoot, 'vms', `${target.id}.json`))
      )
        continue
      const entry = runtime.vms[target.id]
      const nonCragConfirmed = entry?.non_crag_confirmed === true
      const stoppedConfirmed =
        target.status === 'stopped' &&
        entry?.stopped_confirmed === true &&
        (await runtimeInventory.confirmReclaimableStop(target))
      if (!stoppedConfirmed && !nonCragConfirmed) continue
      if (runtimeReservations.has(target.id) || vmLockBusy(path.join(projectRoot, 'vms', `${target.id}.json`))) continue
      if (current(hostId)?.code !== previous.code) throw fail('crag_subscription_sync_pending', 409)
      const intent = {
        host_id: hostId,
        action: 'release',
        vm_id: target.id,
        permit_sha256,
        proven: true,
        reclaim: true,
      }
      beginRosterIntent(intent)
      return syncRoster(hostId, intent, previous)
    }
    for (const entry of claims.roster) {
      if (livePermits.has(entry.permit_sha256)) continue
      const intent = {
        host_id: hostId,
        action: 'release',
        vm_id: 'orphaned-slot',
        permit_sha256: entry.permit_sha256,
        proven: true,
        reclaim: true,
      }
      beginRosterIntent(intent)
      return syncRoster(hostId, intent, previous)
    }
    throw fail('slot_limit_reached', 409)
  }

  async function bindForStart(vm, previous, hostId, payloadKeyId, options, runtime) {
    const machineCode = prepareCragSubscriptionBinding(projectRoot, vm, { preferInstalled: !options?.install })
    const bind = (rights) =>
      bindTarget(vm, hostId, rights, machineCode, payloadKeyId, { ...options, allowReissue: true })
    try {
      return await bind(previous)
    } catch (error) {
      if (error.code !== 'slot_limit_reached' || previous.claims.version !== 2 || !runtimeReservations.has(vm.id))
        throw error
    }
    // Bind can replay a remote seat whose earlier response was lost. Only a
    // definitive full response permits reclaiming another device's seat.
    const rights = readLocalRights()
    if (rights.previous?.code !== previous.code) throw fail('crag_subscription_sync_pending', 409)
    runtime ??= await runtimeInventory.snapshot({ ...rights, hostOnly: true, fresh: true, timeoutMs: 4000 })
    if (readLocalRights().previous?.code !== rights.previous?.code) throw fail('crag_subscription_sync_pending', 409)
    return bind(await reclaimStoppedSeat(vm, rights, runtime))
  }

  function redeem(value, renewal, expectedHost, orderId) {
    return exclusive(
      async () => {
        const redemption_code = typeof value === 'string' && value.trim()
        if (!validVoucher(redemption_code)) throw fail('crag_subscription_invalid_request', 400)
        const hostId = identity()
        if (expectedHost && hostId !== expectedHost) throw hostIdentityChanged()
        const packageDigest = renewal ? undefined : hostPackageDigest(projectRoot)
        storage(!renewal)
        const previous = current(hostId)
        if (renewal && !previous) throw fail('host_subscription_inactive', 409)
        const rawIntent = load(intentFile, 0o600, MAX_REDEEM_INTENT_BYTES)
        if (rawIntent != null) {
          const saved = JSON.parse(rawIntent)
          if (
            !renewal &&
            saved.host_id === hostId &&
            saved.redemption_code === redemption_code &&
            Object.hasOwn(saved, 'host_package_sha256') &&
            !readRosterIntent()
          ) {
            pinnedIntentKind(saved)
            if (
              saved.host_package_sha256 !== packageDigest &&
              !appliedRedemption(hostId, voucherDigest(redemption_code))
            )
              throw hostPackageChanged()
            const confirmed = await finish(hostId, saved, previous, {}, true)
            return expectedHost ? undefined : status(confirmed)
          }
          if (expectedHost) throw fail('crag_subscription_sync_pending', 409)
          if (Object.hasOwn(saved, 'order_id') || Object.hasOwn(saved, 'target_fingerprint')) {
            await reconcileStaleOrderIntent(hostId, previous)
          }
        }
        const pendingRoster = readRosterIntent()
        if (pendingRoster?.action === 'bind' && !pendingRoster.reissue) clearRosterIntent()
        checkNoIntent()
        credential(hostId, !renewal)
        let asserted = {}
        if (renewal) {
          try {
            asserted = standardEnrollment(projectRoot, cragTargetIds(projectRoot, undefined), false)
          } catch {
            asserted = {}
          }
        }
        const intent = {
          host_id: hostId,
          redemption_code,
          ...(orderId && { shop_order_id: orderId }),
          ...(packageDigest && {
            host_package_sha256: packageDigest,
            enrollment: hostEnrollmentIdentity(projectRoot, packageDigest),
            issuer_public_key_id: cragTargetIds(projectRoot, undefined).issuerId,
          }),
        }
        publish(intentFile, JSON.stringify(intent), 0o600, true)
        const confirmed = await finish(hostId, intent, previous, asserted)
        if (!expectedHost) return status(confirmed)
      },
      { blockBefore: true },
    )
  }

  function assertActive(previous) {
    if (!previous || Math.floor(Date.now() / 1000) >= previous.claims.expires_at)
      throw fail('host_subscription_inactive', 409)
  }

  async function bindTarget(
    vm,
    hostId,
    previous,
    machineCode,
    payloadKeyId,
    { checkTarget, reissueSeat, install = false, allowReissue = true } = {},
  ) {
    assertActive(previous)
    const reissue = reissueSeat !== undefined
    const targetOptions = { preferInstalled: !install }
    const { issuerId } = cragTargetIds(projectRoot, vm, targetOptions)
    const roster = previous.claims.version === 2
    if (roster) {
      const intent = { host_id: hostId, action: 'bind' }
      if (reissue) {
        const permit_sha256 = readCragSubscriptionReleaseCandidate(projectRoot, vm, hostId, targetOptions)
        if (
          !previous.claims.roster.some((entry) => entry.seat === reissueSeat && entry.permit_sha256 === permit_sha256)
        )
          throw invalidRights()
        intent.reissue = {
          vm_id: vm.id,
          seat: reissueSeat,
          permit_sha256,
          payload_key_id: payloadKeyId,
          machine_sha256: createHash('sha256').update(machineCode).digest('hex'),
        }
      }
      beginRosterIntent(intent)
    }
    let data
    try {
      const key = credential(hostId)
      const request = {
        machine_code: machineCode,
        payload_key_id: payloadKeyId,
        ...(reissue && { reissue: true }),
      }
      try {
        data = await authority('bind', hostId, key, request)
      } catch (error) {
        if (
          !allowReissue ||
          install ||
          reissue ||
          !['payload_key_conflict', 'host_binding_conflict'].includes(error.code)
        )
          throw error
        if (
          !vm.node_id &&
          error.code === 'payload_key_conflict' &&
          getCragLicense(projectRoot, vm).license.code !== 'license_payload_key_mismatch'
        )
          throw error
        data = await authority('bind', hostId, key, { ...request, reissue: true })
      }
    } catch (error) {
      if (
        roster &&
        (!reissue ||
          [
            'slot_limit_reached',
            'host_binding_conflict',
            'host_subscription_inactive',
            'not_found',
            'auth_forbidden',
            'payload_key_unknown',
            'payload_key_conflict',
          ].includes(error.code))
      )
        clearRosterIntent()
      throw error
    }
    let committedEntitlement = false
    try {
      if (!Number.isInteger(data.seat) || data.seat <= 0 || (reissue && data.seat !== reissueSeat))
        throw invalidRights()
      if (checkTarget) ({ vm } = await checkTarget())
      const actual = cragTargetIds(projectRoot, vm, targetOptions)
      if (actual.payloadKeyId !== payloadKeyId || actual.issuerId !== issuerId)
        throw fail('crag_subscription_target_changed', 409)
      const options = { seat: data.seat, preferInstalled: !install }
      if (roster) {
        const confirmed = verifyRights(hostId, data, previous, install ? undefined : vm)
        if (install) {
          const activated = publishInstallBinding(vm, data.slot_permit, data.seat, confirmed)
          clearRosterIntent()
          return { seat: data.seat, activated }
        }
        options.verifiedRights = confirmed.claims
        activateCragSubscriptionBinding(projectRoot, vm, data.slot_permit, {
          ...options,
          candidateEntitlement: confirmed.code,
        })
        publish(entitlementFile, confirmed.code, 0o644)
        committedEntitlement = true
      } else if (data.entitlement !== previous.code) {
        throw invalidRights()
      }
      const activated = activateCragSubscriptionBinding(projectRoot, vm, data.slot_permit, options)
      if (roster) clearRosterIntent()
      return { seat: data.seat, activated }
    } catch (error) {
      if (roster && !reissue && !committedEntitlement) clearRosterIntent()
      throw error
    }
  }

  async function reconcileStaleOrderIntent(hostId, previous) {
    try {
      const remote = await authority('status', hostId, credential(hostId))
      const confirmed = verifyRights(hostId, remote, previous)
      if (!previous || confirmed.code !== previous.code) publish(entitlementFile, confirmed.code, 0o644)
    } catch {
      // Clear the stale order intent anyway; unconfirmed orders can retry via shop polling.
    }
    remove(marker)
    remove(intentFile)
  }

  function activateTarget({ orderId, target, authorize, claim, redeemed, onRedeemed }) {
    return exclusive(
      async () => {
        const hostId = identity()
        const checkTarget = async () => {
          authorize?.()
          const resolved = await orderTarget(hostId, target.vm_id)
          if (resolved.fingerprint !== target.fingerprint || identity() !== hostId)
            throw fail('crag_subscription_target_changed', 409)
          authorize?.()
          return resolved
        }

        await checkTarget()
        if (!redeemed) {
          storage(true)
          const redemption_code = await claim()
          if (!validVoucher(redemption_code)) throw invalidRights()
          const resolved = await checkTarget()
          const standard = standardEnrollment(projectRoot, resolved)
          const staleRoster = readRosterIntent()
          if (staleRoster?.action === 'bind' && !staleRoster.reissue) clearRosterIntent()
          let raw = load(intentFile, 0o600, MAX_REDEEM_INTENT_BYTES)
          const binding = orderId ? { order_id: orderId } : { target_fingerprint: target.fingerprint }
          let intent = { host_id: hostId, redemption_code, ...binding }
          if (raw != null) {
            const saved = JSON.parse(raw)
            const sameOrder =
              saved.order_id === intent.order_id &&
              saved.target_fingerprint === intent.target_fingerprint &&
              saved.host_id === hostId &&
              saved.redemption_code === redemption_code
            if (!sameOrder) {
              if (Object.hasOwn(saved, 'order_id') || Object.hasOwn(saved, 'target_fingerprint')) {
                await reconcileStaleOrderIntent(hostId, current(hostId))
                raw = null
              } else {
                throw fail('crag_subscription_sync_pending', 409)
              }
            } else {
              // Replay what was actually sent; old claims must not acquire new selectors.
              intent = saved
            }
          }
          if (raw == null) {
            const pending = readRosterIntent()
            if (!orderId && pending?.action === 'bind') await syncRoster(hostId, pending, current(hostId))
            checkNoIntent()
            if (!current(hostId) && standard.payload_key_id) Object.assign(intent, standard)
            credential(hostId, true)
            publish(intentFile, JSON.stringify(intent), 0o600, true)
          }
          const asserted = Object.hasOwn(intent, 'payload_key_id') || Object.hasOwn(intent, 'issuer_public_key_id')
          if (
            asserted &&
            (intent.payload_key_id !== standard.payload_key_id ||
              intent.issuer_public_key_id !== standard.issuer_public_key_id)
          )
            throw hostPackageUnready()
          await finish(hostId, intent, current(hostId), asserted ? standard : {}, raw != null)
          onRedeemed?.()
        }

        const pending = readRosterIntent()
        if (pending?.action === 'bind') {
          if (pending.reissue) {
            const { vm } = await checkTarget()
            await syncRoster(hostId, pending, current(hostId, vm), vm)
          } else {
            clearRosterIntent()
          }
        }
        checkNoIntent()
        await refreshExpired(hostId, current(hostId))
        const { vm, machineCode, payloadKeyId } = await checkTarget()
        return bindTarget(vm, hostId, current(hostId, vm), machineCode, payloadKeyId, { checkTarget })
      },
      { blockBefore: true },
    )
  }

  return {
    status: () => status(),
    isRedemptionApplied: (hostId, digest) => Boolean(appliedRedemption(hostId, digest)),
    admitInference,
    withRuntimeAdmission,
    purchaseDeviceId: identity,
    /** `{ hostId, uuid, source }`. The panel shows `uuid` (null on an install
     * whose original source is gone, see `storedUuid`) and `source` says where
     * the identity came from, which is what makes an identity fault diagnosable
     * instead of just "unavailable". */
    deviceIdentity: () => deviceIdentity(),
    rebuildDeviceIdentity,
    /** Normalize a device UUID a person typed or pasted, then resolve it to the
     * host id the protocol speaks. Returns null when it is not a UUID. The one
     * path from typed-in identity to protocol identity, shared by redemption
     * and by migrating to a replacement machine. */
    resolveDeviceUuid: (input) => (normalizeDeviceUuid(input) ? uuidToHostId(input) : null),
    /** `target` is this machine's identity: either the 64 hex host id, which
     * existing callers and scripts already pass, or the device UUID the panel
     * displays. Accepting the UUID is what lets an operator redeem by copying
     * what is on screen, instead of having to find the hashed form. */
    redeemDeviceOrder(target, voucher, orderId) {
      const hostId = isDigest(target) ? target : uuidToHostId(target)
      if (!hostId) throw fail()
      return redeem(voucher, false, hostId, orderId)
    },
    async listOrderTargets() {
      try {
        const hostId = identity()
        current(hostId)
      } catch {
        return []
      }
      const targets = []
      for (const vm of await listTargets()) {
        if (!isCragOrderVmId(vm.id)) continue
        try {
          if ((await assertReady(vm, { allowPrepared: true })) === false) continue
          preserveOtherLicense(vm)
          targets.push(vm.id)
        } catch (error) {
          if (error.code !== 'crag_subscription_target_unready') throw error
        }
      }
      return targets
    },
    async pinOrderTarget(vmId) {
      const hostId = identity()
      return (await orderTarget(hostId, vmId)).fingerprint
    },
    activateOrder: activateTarget,
    async activateVoucher(vmId, voucher) {
      const hostId = identity()
      const { fingerprint } = await orderTarget(hostId, vmId)
      const { activated } = await activateTarget({ target: { vm_id: vmId, fingerprint }, claim: () => voucher })
      return activated
    },
    redeem(value) {
      return redeem(value, false)
    },
    redeemRenewal(value) {
      return redeem(value, true)
    },
    async renewalProof() {
      const hostId = identity()
      checkNoIntent()
      if (!current(hostId)) throw fail('host_subscription_inactive', 409)
      const { proof } = await authority('renewal-proof', hostId, credential(hostId))
      if (typeof proof !== 'string' || proof.length > 2048 || !/^CRAGRP1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(proof))
        throw invalidRights()
      return proof
    },
    upgrade() {
      return exclusive(
        async () => {
          const hostId = identity()
          checkNoIntent()
          const previous = current(hostId)
          if (!previous) throw fail('crag_subscription_target_unready', 409)
          if (previous.claims.version === 2) return status(await replayDeferredReleases(hostId, previous))
          if (!(await ready({ reclaim: true }))) throw fail('crag_subscription_target_unready', 409)
          await blockKvmBindings()
          const intent = { host_id: hostId, action: 'upgrade' }
          beginRosterIntent(intent)
          const upgraded = await syncRoster(hostId, intent, previous)
          return status((await replayDeferredReleases(hostId, upgraded)) || upgraded)
        },
        { blockBefore: false },
      )
    },
    /** Retire this machine's subscription at the Authority.
     *
     * Every live voucher is released carrying its remaining window, seats are
     * cleared, and the host row is deleted. Those vouchers can then be redeemed
     * on a replacement machine, where they inherit the window rather than
     * restarting the term -- so replacing hardware neither loses paid time nor
     * grants free time.
     *
     * The voucher code is the secret that authorizes the move, and the Authority
     * never echoes it back (not even to its holder), so the operator has to
     * still have it. There is no way around that: the device UUID is shown in
     * the panel, so if it were sufficient on its own, anyone who saw it could
     * claim the subscription.
     *
     * Deliberately destructive -- this is the operator saying the machine is
     * done. Local signed rights are dropped once the Authority confirms:
     * keeping them would have `status()` go on reporting a subscription that no
     * longer exists, which is exactly the stale-local-truth this module refuses
     * to show anywhere else.
     */
    // Claim the voucher a shop order bought onto this machine.
    //
    // This is the path for replacing hardware: the order id is the only handle that
    // survives losing the old machine, because the voucher code lives at the
    // supplier behind a receipt key that was stored there. The Authority releases
    // the voucher from whatever host still holds it, so the old machine does not
    // have to be reachable -- needing it to release first is what stranded a
    // subscription whose machine was reinstalled or destroyed.
    claimByOrder(orderId) {
      return exclusive(async () => {
        if (!validOrderId(orderId)) throw fail('crag_subscription_invalid_request', 400)
        const hostId = identity()
        checkNoIntent()
        storage(true)
        const previous = current(hostId)
        // The Authority binds the voucher to this host's credential, so it has to
        // exist before the request: a first claim on a fresh machine has none yet.
        credential(hostId, true)
        // Assert the package exactly as redemption does. Without payload_key_id the
        // Authority records the voucher as an unlabelled baseline, and a baseline
        // voucher shares one combined window with every other such voucher -- it can
        // never be moved by order id again. `standardEnrollment` returns {} rather
        // than throwing when deploy/payload.json is absent, so refuse here instead:
        // migrating is explicit and low-frequency, and silently making this the last
        // migration ever possible is not a trade worth taking. A host with no trusted
        // package could not serve the entitlement being claimed anyway.
        const enrollment = hostEnrollmentIdentity(projectRoot, hostPackageDigest(projectRoot))
        if (!enrollment.payload_key_id || !enrollment.issuer_public_key_id) throw hostPackageUnready()
        const data = await authority('claim-by-order', hostId, credential(hostId), {
          order_id: orderId,
          ...enrollment,
        })
        const confirmed = verifyRights(hostId, data, previous)
        publish(entitlementFile, confirmed.code, 0o644)
        return status(confirmed)
      })
    },
    unbind() {
      return exclusive(async () => {
        const hostId = identity()
        checkNoIntent()
        if (!current(hostId)) throw fail('crag_subscription_target_unready', 409)
        const released = await authority('unbind', hostId, credential(hostId))
        // Only after the Authority confirmed. Dropping them first would strand a
        // machine whose request never landed: rights gone locally, still held
        // remotely, and no way to prove either.
        for (const file of [entitlementFile, marker, deferredReleaseFile]) remove(file)
        return { ...(await status()), released }
      })
    },
    async releaseStoppedBinding(vm, { stop } = {}) {
      const unchanged = (supported = false) => ({ released: false, stopped: false, reclaim_supported: supported })
      if (process.platform !== 'linux' || !fs.existsSync(entitlementFile)) return unchanged()
      const hostId = identity()
      const previous = current(hostId)
      if (!previous) return unchanged()
      const currentPermit = readCragSubscriptionReleaseCandidate(projectRoot, vm, hostId)
      if (previous.claims.version !== 2) return currentPermit ? { ...unchanged(), reclaim_pending: true } : unchanged()
      const priorIntent = readRosterIntent()
      const permit =
        currentPermit ||
        (priorIntent?.action === 'release' &&
        priorIntent.reclaim === true &&
        priorIntent.vm_id === vm.id &&
        priorIntent.proven === true &&
        isDigest(priorIntent.permit_sha256)
          ? priorIntent.permit_sha256
          : null)
      if (!permit) return unchanged(true)
      return exclusive(async () => {
        if (runtimeReservations.has(vm.id)) throw fail('crag_slot_start_busy', 409)
        const saved = readRosterIntent()
        if (
          saved &&
          (saved.action !== 'release' ||
            saved.reclaim !== true ||
            saved.vm_id !== vm.id ||
            saved.permit_sha256 !== permit)
        )
          throw fail('crag_subscription_sync_pending', 409)
        if (!saved) checkNoIntent()
        const now = current(hostId)
        if (now?.code !== previous.code) throw fail('crag_subscription_sync_pending', 409)
        if (!saved && !now.claims.roster.some((entry) => entry.permit_sha256 === permit)) return unchanged(true)
        if (!currentPermit && saved?.proven === true) {
          await syncRoster(hostId, saved, now)
          return { released: true, stopped: false, reclaim_supported: true }
        }
        if (stop && (await stop(vm))?.ok !== true) throw fail('crag_subscription_stop_unconfirmed', 409)
        if (!(await runtimeInventory?.confirmReclaimableStop?.(vm)))
          throw fail('crag_subscription_stop_unconfirmed', 409)
        if (runtimeReservations.has(vm.id)) throw fail('crag_slot_start_busy', 409)
        if (readCragSubscriptionReleaseCandidate(projectRoot, vm, hostId) !== permit)
          throw fail('crag_subscription_target_changed', 409)
        if (current(hostId)?.code !== now.code) throw fail('crag_subscription_sync_pending', 409)
        const intent = saved ?? {
          host_id: hostId,
          action: 'release',
          vm_id: vm.id,
          permit_sha256: permit,
          proven: true,
          reclaim: true,
        }
        if (!saved) beginRosterIntent(intent)
        await syncRoster(hostId, intent, now)
        return { released: true, stopped: true, reclaim_supported: true }
      })
    },
    async teardown(vm, destroy) {
      if (process.platform !== 'linux') return destroy(false)
      let hostId, previous
      try {
        hostId = identity()
        previous = current(hostId)
      } catch (error) {
        if (!fs.existsSync(entitlementFile)) return destroy(false)
        throw error
      }
      if (!previous) return destroy(false)
      const permit = readCragSubscriptionReleaseCandidate(projectRoot, vm, hostId)
      if (previous.claims.version === 1) {
        if (!permit) return destroy(false)
        return exclusive(
          async () => {
            checkNoIntent()
            if (current(hostId)?.code !== previous.code) throw fail('crag_subscription_sync_pending', 409)
            saveDeferredRelease(hostId, vm.id, permit, false)
            const result = await destroy(true)
            if (!result.ok) return result
            if (result.teardownConfirmed !== true) throw fail('crag_subscription_teardown_unconfirmed', 409)
            saveDeferredRelease(hostId, vm.id, permit, true)
            return { ...result, reclaim_pending: true }
          },
          { blockBefore: false },
        )
      }
      const priorIntent = readRosterIntent()
      if (!permit && priorIntent?.vm_id !== vm.id) return destroy(false)
      return exclusive(
        async () => {
          const saved = readRosterIntent()
          if (
            saved &&
            (saved.action !== 'release' || saved.vm_id !== vm.id || (permit && saved.permit_sha256 !== permit))
          )
            throw fail('crag_subscription_sync_pending', 409)
          if (!saved) checkNoIntent()
          const now = current(hostId)
          const intent = saved ?? {
            host_id: hostId,
            action: 'release',
            vm_id: vm.id,
            permit_sha256: permit,
            proven: false,
          }
          if (!saved) beginRosterIntent(intent)
          const result = await destroy(true)
          if (!result.ok) return result
          if (result.teardownConfirmed !== true) throw fail('crag_subscription_teardown_unconfirmed', 409)
          intent.proven = true
          publish(rosterIntentFile, JSON.stringify(intent), 0o600)
          await syncRoster(hostId, intent, now)
          return result
        },
        { blockBefore: false },
      )
    },
    recover({ useCurrentPackage = false } = {}) {
      return exclusive(async () => {
        if (!fs.existsSync(intentFile) && !fs.existsSync(rosterIntentFile)) {
          if (fs.existsSync(marker)) remove(marker)
          if (fs.existsSync(deferredReleaseFile)) {
            const hostId = identity()
            await replayDeferredReleases(hostId, current(hostId))
          }
          return
        }
        const hostId = identity()
        const rosterIntent = readRosterIntent()
        if (rosterIntent) {
          if (rosterIntent.action === 'bind' && !rosterIntent.reissue) {
            clearRosterIntent()
            return
          }
          const confirmed = await syncRoster(hostId, rosterIntent, current(hostId))
          await replayDeferredReleases(hostId, confirmed)
          return
        }
        const raw = load(intentFile, 0o600, MAX_REDEEM_INTENT_BYTES)
        if (raw == null) return
        let intent
        try {
          intent = JSON.parse(raw)
        } catch {
          throw fail('crag_subscription_recovery_unverified', 409)
        }
        if (
          !intent ||
          typeof intent !== 'object' ||
          Array.isArray(intent) ||
          !isDigest(intent.host_id) ||
          !validVoucher(intent.redemption_code)
        )
          throw fail('crag_subscription_recovery_unverified', 409)
        const orderIntent = Object.hasOwn(intent, 'order_id') || Object.hasOwn(intent, 'target_fingerprint')
        const pinned = Object.hasOwn(intent, 'host_package_sha256')
        if (
          pinned ||
          Object.hasOwn(intent, 'enrollment') ||
          (!orderIntent && Object.hasOwn(intent, 'issuer_public_key_id'))
        )
          pinnedIntentKind(intent)
        else if (!orderIntent && Object.keys(intent).sort().join(',') !== 'host_id,redemption_code')
          throw fail('crag_subscription_recovery_unverified', 409)
        if (intent.host_id !== hostId) throw hostIdentityChanged()
        // An order may only resume redemption after re-authorizing its checkout pin;
        // keep order_id / target_fingerprint intact for shop polling (it no longer blocks existing slots or new orders).
        if (orderIntent) return
        const previous = current(hostId)
        const applied = appliedRedemption(hostId, voucherDigest(intent.redemption_code))
        if (!applied) intent = await prepareRecovery(hostId, intent, previous, useCurrentPackage)
        // Old intents without local rights have no original digest, but still require a trusted package.
        if (!pinned && !previous) hostPackageDigest(projectRoot)
        const confirmed = await finish(hostId, intent, previous, {}, true)
        await replayDeferredReleases(hostId, confirmed)
      })
    },
    refreshExpiredEntitlement,
    bind(vm) {
      return exclusive(async () => {
        if ((await assertReady(vm, { allowPrepared: true })) === false)
          throw fail('crag_subscription_target_unready', 409)
        const hostId = identity()
        const pendingRoster = readRosterIntent()
        if (pendingRoster?.action === 'bind' && !pendingRoster.reissue) clearRosterIntent()
        checkNoIntent()
        await refreshExpired(hostId, current(hostId))
        const previous = current(hostId, vm)
        assertActive(previous)
        const { seat } = await bindTarget(
          vm,
          hostId,
          previous,
          prepareCragSubscriptionBinding(projectRoot, vm),
          cragTargetIds(projectRoot, vm).payloadKeyId,
        )
        return { seat }
      })
    },
    authorizeInstall(vm, { allowLegacyReissue = false } = {}) {
      return exclusive(async () => {
        if (typeof vm?.id !== 'string' || !isValidVmId(vm.id)) throw fail('crag_subscription_target_unready', 409)
        const hostId = identity()
        const pendingRoster = readRosterIntent()
        if (pendingRoster?.action === 'bind' && !pendingRoster.reissue) clearRosterIntent()
        checkNoIntent()
        const previous = await refreshExpired(hostId, current(hostId))
        assertActive(previous)
        const { license } = getCragLicense(projectRoot, vm)
        const candidate = getCragLicense(projectRoot, vm, { preferInstalled: false }).license
        if (
          ![
            'license_required',
            'license_payload_key_mismatch',
            'license_crag_host_over_quota',
            'license_binding_mismatch',
          ].includes(candidate.code)
        ) {
          throw fail('crag_subscription_target_unready', 409)
        }
        if (!allowLegacyReissue && candidate.code === 'license_payload_key_mismatch')
          throw fail('crag_subscription_migration_required', 409)
        const permitDigest = readCragSubscriptionReleaseCandidate(projectRoot, vm, hostId, {
          preferInstalled: !allowLegacyReissue,
        })
        const reissueSeat =
          previous.claims.roster?.find((entry) => entry.permit_sha256 === permitDigest)?.seat ??
          (license.valid && license.scope === 'host' ? license.seat : undefined)
        if (!allowLegacyReissue && reissueSeat !== undefined) throw fail('crag_subscription_migration_required', 409)
        const { payloadKeyId } = cragTargetIds(projectRoot, vm, { preferInstalled: false })
        if (allowLegacyReissue) {
          return bindTarget(
            vm,
            hostId,
            previous,
            prepareCragSubscriptionBinding(projectRoot, vm, { preferInstalled: false }),
            payloadKeyId,
            { install: true, reissueSeat },
          )
        }
        await bindForStart(vm, previous, hostId, payloadKeyId, { install: true })
      })
    },
  }
}
