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

const AUTHORITY = 'https://crag.fkcodex.com'
const localFilesystems = new Set([0xef53, 0x794c7630, 0x58465342, 0x9123683e, 0x2fc12fc1, 0xf2f52010])
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
])
const fail = (code = 'crag_subscription_unavailable', status = 503) => Object.assign(new Error(code), { code, status })
const uid = () => process.getuid()
const validVoucher = (code) =>
  typeof code === 'string' &&
  /^CRAGR1\.[A-Za-z0-9_-]{43}$/.test(code) &&
  Buffer.from(code.slice(7), 'base64url').toString('base64url') === code.slice(7)
const safeTime = (value) => Number.isSafeInteger(value) && value >= 0
const isDigest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const validSku = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)
const validMonths = (value) => Number.isSafeInteger(value) && value >= 1 && value <= 4294967295
const invalidRights = () => fail('crag_subscription_invalid_entitlement', 502)
const hostPackageUnready = () => fail('crag_subscription_host_package_unready', 409)
const usageUnverified = () =>
  cragLicenseDeniedResult({
    code: 'license_crag_host_usage_unverified',
    error: '暂时无法核对宿主机 CRAG 运行额度，请刷新订阅或确认槽位状态后重试。',
  })
const overQuota = () =>
  cragLicenseDeniedResult({
    code: 'license_crag_host_over_quota',
    error: '宿主机运行中的 CRAG 内核超过订阅槽位。请停用、退役或切回标准内核，或兑换足够额度后重试。',
  })

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
  return result
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

function load(file, mode, limit, owner = uid()) {
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    const st = fs.fstatSync(fd)
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      st.uid !== owner ||
      (mode == null ? st.mode & 0o022 : (st.mode & 0o777) !== mode) ||
      st.size < 1 ||
      st.size > limit
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
  machineIdFile,
} = {}) {
  if (origin !== AUTHORITY && !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin)) throw fail()
  const publicDir = cragSubscriptionPublicDirectory(projectRoot)
  const base = path.dirname(publicDir)
  const dataDir = path.dirname(base)
  const privateDir = path.join(base, 'private')
  const hostFile = path.join(publicDir, 'host_id')
  const keyFile = path.join(privateDir, 'credential')
  const entitlementFile = path.join(publicDir, 'entitlement.code')
  const intentFile = path.join(privateDir, 'redeem.json')
  const rosterIntentFile = path.join(privateDir, 'roster.json')
  const marker = path.join(publicDir, 'sync-pending')
  let busy = false
  const runtimeReservations = new Set()
  let admissionWaiters = 0
  let admissionQueue = Promise.resolve()
  let expiryProbe
  let lastExpiryProbe

  function identity() {
    if (process.platform !== 'linux') throw fail()
    const inContainer = fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv')
    const file = machineIdFile || (inContainer ? '/run/crag-host-machine-id' : '/etc/machine-id')
    const raw = load(file, null, 64, machineIdFile ? uid() : 0)
      ?.trim()
      .toLowerCase()
    if (!/^[a-f0-9]{32}$/.test(raw || '') || /^0{32}$/.test(raw)) throw fail()
    return createHash('sha256').update(`crag-host-v1:${raw}`).digest('hex')
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
        load(intentFile, 0o600, 512) ||
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
    const hostId = identity()
    storage()
    const previous = current(hostId)
    const pending =
      load(marker, 0o644, 32) != null ||
      load(intentFile, 0o600, 512) != null ||
      load(rosterIntentFile, 0o600, 1024) != null
    const claims = previous?.claims ?? null
    if (claims && (!safeTime(claims.expires_at) || !safeTime(claims.revision))) throw fail()
    return { hostId, claims, pending, previous }
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
    if (background && (busy || !unchangedRights({ hostId, pending: false, previous }, readLocalRights()))) return
    if (confirmed.code === previous.code) return confirmed
    if (current(hostId)?.code !== previous.code) throw invalidRights()
    checkNoIntent()
    publish(entitlementFile, confirmed.code, 0o644)
    return confirmed
  }

  async function refreshExpiredEntitlement() {
    if (expiryProbe) return expiryProbe
    if (busy || !fs.existsSync(entitlementFile)) return
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
    if (license.valid && license.scope !== 'host') return start()
    if (!license.valid && !((bindSubscription || install) && license.code === 'license_required')) {
      return denyRuntime(license)
    }
    if (admissionWaiters >= 32)
      return { ok: false, status: 409, code: 'crag_subscription_busy', error: 'CRAG 启动操作繁忙，请稍后重试。' }
    admissionWaiters++
    let reserved = false
    const admit = admissionQueue
      .then(async () => {
        const rights = readLocalRights()
        if (rights.pending) return runtimeDenial(usageUnverified())
        const checked = getCragLicense(projectRoot, vm, options).license
        const needsBinding = checked.code === 'license_required' && (bindSubscription || install)
        if (!checked.valid && !needsBinding) return denyRuntime(checked)
        if (checked.valid && checked.scope !== 'host') return null
        if (!rights.claims && needsBinding) {
          return denyRuntime(checked)
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
          if (id === vm.id || entry.scope === 'independent') continue
          if (entry.state === 'running') occupying.add(id)
          else if (!entry.stopped_confirmed && !entry.non_crag_confirmed) {
            occupying.add(id)
            uncertain = true
          }
        }
        const limit = roster
          ? Math.min(rights.claims.slot_limit === 'unlimited' ? 10000 : rights.claims.slot_limit, 10000)
          : rights.claims.slot_limit
        if (limit !== 'unlimited' && occupying.size >= limit) {
          return runtimeDenial(uncertain ? usageUnverified() : overQuota())
        }
        runtimeReservations.add(vm.id)
        reserved = true
        if (!needsBinding || install || !bindSubscription) return null
        await exclusive(async () => {
          if (!unchangedRights(rights, readLocalRights())) throw fail('crag_subscription_sync_pending', 409)
          checkNoIntent()
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

  async function admitInference({ vm, routing, health } = {}) {
    if (!runtimeInventory || !vm?.id) return null
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
      let rights = readLocalRights()
      if (localKvm) {
        if (busy || rights.pending || !rights.claims) return usageUnverified()
        const { license } = getCragLicense(projectRoot, vm)
        if (!license.valid) {
          try {
            await blockKvmBinding(projectRoot, vm)
          } catch {
            // A delivery failure does not change the verified reason this request is denied.
          }
          return cragLicenseDeniedResult({ code: license.code, error: license.message })
        }
        try {
          if ((await publishKvmBinding(projectRoot, vm)) !== true) return usageUnverified()
        } catch {
          return cragLicenseDeniedResult({
            code: 'license_crag_kvm_sync_failed',
            error: 'KVM 槽授权未同步，请检查 guest 状态后重试。',
          })
        }
        if (busy || !unchangedRights(rights, readLocalRights())) return usageUnverified()
      }
      if (vm.node_id) {
        if (rights.pending || !rights.claims) return usageUnverified()
        if (vm.status === 'running' && getCragLicense(projectRoot, vm).license.valid) {
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
      }
      const deadline = performance.now() + 4000
      for (let pass = 0; pass < 2; pass++) {
        if (rights.pending || !rights.claims) return usageUnverified()
        if (rights.claims.expires_at <= Math.floor(Date.now() / 1000)) return null
        const timeoutMs = deadline - performance.now()
        if (timeoutMs <= 0) return usageUnverified()
        const runtime = await runtimeInventory.snapshot({
          ...rights,
          hostOnly: true,
          currentHop: { id: vm.id, health },
          timeoutMs,
        })
        const next = readLocalRights()
        if (localKvm && (busy || !unchangedRights(rights, next))) return usageUnverified()
        if (unchangedRights(rights, next)) {
          if (runtime.host_over_limit === true) return overQuota()
          return runtime.host_over_limit === false ? null : usageUnverified()
        }
        rights = next
      }
    } catch {
      // A malformed host permit or unreadable local quota cannot authorize a new hop.
    }
    return usageUnverified()
  }

  async function status(confirmed, mayRetry = true) {
    let targets
    let inventory = {}
    let target_probe_failed = false
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
      const { hostId, claims, pending, previous } = local
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
        if (confirmed?.code === previous.code) {
          rights = confirmed.rights
        } else if (!needsRefresh) {
          try {
            const remote = await authority('status', hostId, credential(hostId))
            if (remote.entitlement === previous.code) rights = projection(remote, claims)
          } catch {
            // Signed local rights still apply during an Authority outage. Do not guess remote metadata.
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
        ...(target_probe_failed && { target_probe_failed }),
        state: pending ? 'sync_pending' : claims ? (expired ? 'expired' : 'active') : 'unredeemed',
        ...(claims && { slot_limit: claims.slot_limit, expires_at: claims.expires_at, revision: claims.revision }),
        ...rights,
        available_seats: pending || runtime === null ? null : availableSeats(claims, rights, claims && !expired),
        ...inventory,
        ...(total_slots !== undefined && { total_slots }),
        ...(enabled_slots !== undefined && { enabled_slots }),
        ...(upgrade_available && { upgrade_available }),
        ...runtime,
      }
    } catch {
      return {
        ready: false,
        state: 'unavailable',
        available_seats: null,
        ...(target_probe_failed && { target_probe_failed }),
        ...inventory,
        ...(await runtimeStatus()),
      }
    }
  }

  async function authority(action, hostId, key, extra) {
    try {
      const response = await fetchImpl(`${origin}/v1/host-subscriptions/${action}`, {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ host_id: hostId, ...extra }),
      })
      const envelope = await responseJson(response)
      if (response.ok && envelope?.ok === true && envelope.data && typeof envelope.data === 'object')
        return envelope.data
      const code = envelope?.error?.code
      if (envelope?.ok === false && authorityErrors.get(code) === response.status) throw fail(code, response.status)
    } catch (error) {
      if (authorityErrors.has(error.code)) throw error
    }
    throw fail('crag_subscription_authority_unavailable', 502)
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

  async function finish(hostId, intent, previous, asserted = {}) {
    const enrollment = Object.hasOwn(intent, 'host_package_sha256')
      ? hostEnrollmentIdentity(projectRoot, intent.host_package_sha256)
      : asserted
    publish(marker, 'pending\n', 0o644)
    let data
    try {
      data = await authority('redeem', hostId, credential(hostId), {
        redemption_code: intent.redemption_code,
        ...enrollment,
      })
    } catch (error) {
      if (terminalRedeem.has(error.code)) {
        remove(marker)
        remove(intentFile)
      }
      throw error
    }
    if (Object.hasOwn(intent, 'host_package_sha256')) assertHostPackage(projectRoot, intent.host_package_sha256)
    const confirmed = verifyRights(hostId, data, previous)
    publish(entitlementFile, confirmed.code, 0o644)
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
      if (vm.node_id || !isKvmRuntime(vm)) return false
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
    const rights = readLocalRights()
    let failed = false
    for (const vm of targets) {
      try {
        const { license } = getCragLicense(projectRoot, vm)
        if (!rights.pending && license.valid && license.scope === 'host') {
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

  async function exclusive(work, { blockBefore = true } = {}) {
    if (busy) throw fail('crag_subscription_busy', 409)
    busy = true
    const release = holdKvmCragSubscriptionPublications(projectRoot)
    let result, failure
    try {
      if (blockBefore) await blockKvmBindings()
      result = await work()
    } catch (error) {
      failure = error
    } finally {
      release()
      try {
        await restoreKvmBindings()
      } catch (error) {
        failure ??= error
      }
      busy = false
    }
    if (failure) throw failure
    return result
  }

  function readRosterIntent() {
    const raw = load(rosterIntentFile, 0o600, 1024)
    return raw == null ? null : JSON.parse(raw)
  }

  function checkNoIntent() {
    if (readRosterIntent() || load(intentFile, 0o600, 512) || load(marker, 0o644, 32))
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
        const machine_code = prepareCragSubscriptionBinding(projectRoot, target)
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
    clearRosterIntent()
    return confirmed
  }

  async function reclaimStoppedSeat(vm, rights, runtime) {
    const { hostId, previous, claims } = rights
    for (const target of await listTargets()) {
      if (target.id === vm.id || target.status !== 'stopped' || runtimeReservations.has(target.id)) continue
      if (
        target.kernel_operation?.phase === 'pending' ||
        vmLockBusy(path.join(projectRoot, 'vms', `${target.id}.json`)) ||
        !runtime.vms[target.id]?.stopped_confirmed
      )
        continue
      if (!(await runtimeInventory.confirmReclaimableStop(target))) continue
      if (runtimeReservations.has(target.id) || vmLockBusy(path.join(projectRoot, 'vms', `${target.id}.json`))) continue
      if (!unchangedRights(rights, readLocalRights())) throw fail('crag_subscription_sync_pending', 409)
      const permit_sha256 = readCragSubscriptionReleaseCandidate(projectRoot, target, hostId)
      if (!claims.roster.some((entry) => entry.permit_sha256 === permit_sha256)) continue
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
    throw fail('slot_limit_reached', 409)
  }

  async function bindForStart(vm, previous, hostId, payloadKeyId, options, runtime) {
    const machineCode = prepareCragSubscriptionBinding(projectRoot, vm)
    const bind = (rights) =>
      bindTarget(vm, hostId, rights, machineCode, payloadKeyId, { ...options, allowReissue: false })
    try {
      return await bind(previous)
    } catch (error) {
      if (error.code !== 'slot_limit_reached' || previous.claims.version !== 2 || !runtimeReservations.has(vm.id))
        throw error
    }
    // Bind can replay a remote seat whose earlier response was lost. Only a
    // definitive full response permits reclaiming another device's seat.
    const rights = readLocalRights()
    if (rights.pending || rights.previous?.code !== previous.code) throw fail('crag_subscription_sync_pending', 409)
    runtime ??= await runtimeInventory.snapshot({ ...rights, hostOnly: true, fresh: true, timeoutMs: 4000 })
    if (!unchangedRights(rights, readLocalRights())) throw fail('crag_subscription_sync_pending', 409)
    return bind(await reclaimStoppedSeat(vm, rights, runtime))
  }

  function redeem(value, renewal, expectedHost) {
    return exclusive(async () => {
      const redemption_code = typeof value === 'string' && value.trim()
      if (!validVoucher(redemption_code)) throw fail('crag_subscription_invalid_request', 400)
      const hostId = identity()
      if (expectedHost && hostId !== expectedHost) throw fail()
      const packageDigest = renewal ? undefined : hostPackageDigest(projectRoot)
      storage(!renewal)
      const previous = current(hostId)
      if (renewal && !previous) throw fail('host_subscription_inactive', 409)
      const pending = expectedHost && load(intentFile, 0o600, 512)
      if (pending) {
        const intent = JSON.parse(pending)
        if (
          intent.host_id !== hostId ||
          intent.redemption_code !== redemption_code ||
          intent.host_package_sha256 !== packageDigest ||
          Object.keys(intent).length !== 3 ||
          readRosterIntent()
        )
          throw fail('crag_subscription_sync_pending', 409)
        await finish(hostId, intent, previous)
        return
      }
      checkNoIntent()
      credential(hostId, !renewal)
      const intent = { host_id: hostId, redemption_code, ...(packageDigest && { host_package_sha256: packageDigest }) }
      publish(intentFile, JSON.stringify(intent), 0o600, true)
      const confirmed = await finish(hostId, intent, previous)
      if (!expectedHost) return status(confirmed)
    })
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
        const permit_sha256 = readCragSubscriptionReleaseCandidate(projectRoot, vm, hostId)
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
        if (!allowReissue || install || reissue || error.code !== 'payload_key_conflict') throw error
        if (!vm.node_id && getCragLicense(projectRoot, vm).license.code !== 'license_payload_key_mismatch') throw error
        data = await authority('bind', hostId, key, { ...request, reissue: true })
      }
    } catch (error) {
      if (
        roster &&
        [
          'slot_limit_reached',
          'host_binding_conflict',
          'host_subscription_inactive',
          'not_found',
          'auth_forbidden',
          'payload_key_unknown',
          'payload_key_conflict',
        ].includes(error.code)
      )
        clearRosterIntent()
      throw error
    }
    if (!Number.isInteger(data.seat) || data.seat <= 0 || (reissue && data.seat !== reissueSeat)) throw invalidRights()
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
    } else if (data.entitlement !== previous.code) {
      throw invalidRights()
    }
    const activated = activateCragSubscriptionBinding(projectRoot, vm, data.slot_permit, options)
    if (roster) clearRosterIntent()
    return { seat: data.seat, activated }
  }

  function activateTarget({ orderId, target, authorize, claim, redeemed, onRedeemed }) {
    return exclusive(async () => {
      const hostId = identity()
      const checkTarget = async () => {
        authorize?.()
        const resolved = await orderTarget(hostId, target.vm_id)
        if (resolved.fingerprint !== target.fingerprint || identity() !== hostId)
          throw fail('crag_subscription_target_changed', 409)
        authorize?.()
        return resolved
      }

      storage()
      await checkTarget()
      if (!redeemed) {
        storage(true)
        const redemption_code = await claim()
        if (!validVoucher(redemption_code)) throw invalidRights()
        const resolved = await checkTarget()
        const standard = standardEnrollment(projectRoot, resolved)
        const raw = load(intentFile, 0o600, 512)
        const binding = orderId ? { order_id: orderId } : { target_fingerprint: target.fingerprint }
        let intent = { host_id: hostId, redemption_code, ...binding }
        if (raw == null) {
          const pending = readRosterIntent()
          if (!orderId && pending?.action === 'bind') await syncRoster(hostId, pending, current(hostId))
          checkNoIntent()
          if (!current(hostId) && standard.payload_key_id) Object.assign(intent, standard)
          credential(hostId, true)
          publish(intentFile, JSON.stringify(intent), 0o600, true)
        } else {
          const saved = JSON.parse(raw)
          if (
            saved.order_id !== intent.order_id ||
            saved.target_fingerprint !== intent.target_fingerprint ||
            saved.host_id !== hostId ||
            saved.redemption_code !== redemption_code
          )
            throw fail('crag_subscription_sync_pending', 409)
          // Replay what was actually sent; old claims must not acquire new selectors.
          intent = saved
        }
        const asserted = Object.hasOwn(intent, 'payload_key_id') || Object.hasOwn(intent, 'issuer_public_key_id')
        if (
          asserted &&
          (intent.payload_key_id !== standard.payload_key_id ||
            intent.issuer_public_key_id !== standard.issuer_public_key_id)
        )
          throw hostPackageUnready()
        await finish(hostId, intent, current(hostId), asserted ? standard : {})
        onRedeemed?.()
      }

      const pending = readRosterIntent()
      if (pending?.action === 'bind') {
        const { vm } = await checkTarget()
        await syncRoster(hostId, pending, current(hostId, vm), vm)
      }
      checkNoIntent()
      await refreshExpired(hostId, current(hostId))
      const { vm, machineCode, payloadKeyId } = await checkTarget()
      return bindTarget(vm, hostId, current(hostId, vm), machineCode, payloadKeyId, { checkTarget })
    })
  }

  return {
    status: () => status(),
    admitInference,
    withRuntimeAdmission,
    purchaseDeviceId() {
      const hostId = identity()
      storage()
      const saved = load(hostFile, 0o644, 64)
      if (saved != null && saved !== hostId) throw fail()
      return hostId
    },
    redeemDeviceOrder(hostId, voucher) {
      if (!isDigest(hostId)) throw fail()
      return redeem(voucher, false, hostId)
    },
    async listOrderTargets() {
      try {
        const hostId = identity()
        storage()
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
      storage()
      return (await orderTarget(hostId, vmId)).fingerprint
    },
    activateOrder: activateTarget,
    async activateVoucher(vmId, voucher) {
      const hostId = identity()
      storage()
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
      storage()
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
          storage()
          checkNoIntent()
          const previous = current(hostId)
          if (!previous || !(await ready({ reclaim: true }))) throw fail('crag_subscription_target_unready', 409)
          if (previous.claims.version === 2) return status()
          await blockKvmBindings()
          const intent = { host_id: hostId, action: 'upgrade' }
          beginRosterIntent(intent)
          return status(await syncRoster(hostId, intent, previous))
        },
        { blockBefore: false },
      )
    },
    async teardown(vm, destroy) {
      if (process.platform !== 'linux') return destroy(false)
      let hostId, previous
      try {
        hostId = identity()
        storage()
        previous = current(hostId)
      } catch (error) {
        if (!fs.existsSync(entitlementFile)) return destroy(false)
        throw error
      }
      if (previous?.claims.version !== 2) return destroy(false)
      const permit = readCragSubscriptionReleaseCandidate(projectRoot, vm, hostId)
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
          await blockKvmBindings()
          await syncRoster(hostId, intent, now)
          return result
        },
        { blockBefore: false },
      )
    },
    recover() {
      return exclusive(async () => {
        // Unconfigured hosts have no startup work. An orphaned marker is never cleared implicitly.
        if (!fs.existsSync(intentFile) && !fs.existsSync(rosterIntentFile)) {
          if (fs.existsSync(marker)) throw fail('crag_subscription_sync_pending', 409)
          return
        }
        const hostId = identity()
        storage()
        const rosterIntent = readRosterIntent()
        if (rosterIntent) {
          await syncRoster(hostId, rosterIntent, current(hostId))
          return
        }
        const raw = load(intentFile, 0o600, 512)
        if (raw == null) return
        const intent = JSON.parse(raw)
        if (intent.host_id !== hostId || !validVoucher(intent.redemption_code)) throw fail()
        // An order may only resume redemption after re-authorizing its checkout pin.
        if (Object.hasOwn(intent, 'order_id') || Object.hasOwn(intent, 'target_fingerprint')) return
        const pinned = Object.hasOwn(intent, 'host_package_sha256')
        if (pinned) assertHostPackage(projectRoot, intent.host_package_sha256)
        const previous = current(hostId)
        // Old intents without local rights have no original digest, but still require a trusted package.
        if (!pinned && !previous) hostPackageDigest(projectRoot)
        await finish(hostId, intent, previous)
      })
    },
    refreshExpiredEntitlement,
    bind(vm) {
      return exclusive(async () => {
        if ((await assertReady(vm, { allowPrepared: true })) === false)
          throw fail('crag_subscription_target_unready', 409)
        const hostId = identity()
        storage()
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
        storage()
        checkNoIntent()
        const previous = await refreshExpired(hostId, current(hostId))
        assertActive(previous)
        const { license } = getCragLicense(projectRoot, vm)
        const candidate = getCragLicense(projectRoot, vm, { preferInstalled: false }).license
        if (!['license_required', 'license_payload_key_mismatch'].includes(candidate.code)) {
          throw fail('crag_subscription_target_unready', 409)
        }
        const permitDigest = readCragSubscriptionReleaseCandidate(projectRoot, vm, hostId)
        const reissueSeat =
          previous.claims.roster?.find((entry) => entry.permit_sha256 === permitDigest)?.seat ??
          (license.valid && license.scope === 'host' ? license.seat : undefined)
        if (!allowLegacyReissue && (reissueSeat !== undefined || candidate.code === 'license_payload_key_mismatch'))
          throw fail('crag_subscription_migration_required', 409)
        const { payloadKeyId } = cragTargetIds(projectRoot, vm, { preferInstalled: false })
        if (allowLegacyReissue) {
          return bindTarget(vm, hostId, previous, prepareCragSubscriptionBinding(projectRoot, vm), payloadKeyId, {
            install: true,
            reissueSeat,
          })
        }
        await bindForStart(vm, previous, hostId, payloadKeyId, { install: true })
      })
    },
  }
}
