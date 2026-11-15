import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  activateCragSubscriptionBinding,
  getCragLicense,
  MAX_CRAG_HOST_ENTITLEMENT_BYTES,
  prepareCragSubscriptionBinding,
  selectedCragIssuerId,
  selectedCragPayloadId,
  readCragSubscriptionReleaseCandidate,
  verifyCragHostEntitlement,
} from './crag-license.mjs'
import { cragSubscriptionPublicDirectory } from './crag-subscription-paths.mjs'

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
  ['host_subscription_inactive', 409],
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

function projection(data, claims) {
  const result = {}
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
      (claims.slot_limit !== 'unlimited' && data.used_slots > claims.slot_limit)
    )
      throw invalidRights()
    result.used_slots = data.used_slots
  }
  if (Object.hasOwn(data, 'available_slots') && claims.version === 1) {
    const available = data.available_slots
    if (
      available !== 0 &&
      (claims.slot_limit === 'unlimited'
        ? available !== null
        : !safeTime(available) ||
          (result.used_slots !== undefined && available !== claims.slot_limit - result.used_slots))
    )
      throw invalidRights()
    result.available_slots = available
  }
  if (Object.hasOwn(data, 'reclaim_supported') && data.reclaim_supported !== (claims.version === 2))
    throw invalidRights()
  if (claims.version === 2) {
    const used_slots = claims.roster.length
    const capacity = Math.min(claims.slot_limit === 'unlimited' ? 10000 : claims.slot_limit, 10000)
    const available_slots = claims.expires_at <= Math.floor(Date.now() / 1000) ? 0 : capacity - used_slots
    if (
      (Object.hasOwn(data, 'used_slots') && data.used_slots !== used_slots) ||
      (Object.hasOwn(data, 'available_slots') && data.available_slots !== available_slots && data.available_slots !== 0)
    )
      throw invalidRights()
    return { ...result, used_slots, available_slots, reclaim_supported: true }
  }
  return { ...result, reclaim_supported: false }
}
const isOrderVmId = (id) => typeof id === 'string' && /^vm-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)

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
  isSubscriptionSlot,
  assertReady,
  targetPayloadId = selectedCragPayloadId,
  isSlotEnabled,
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

  function current(hostId) {
    const savedHost = load(hostFile, 0o644, 64)
    if (savedHost != null && savedHost !== hostId) throw fail()
    const code = load(entitlementFile, 0o644, MAX_CRAG_HOST_ENTITLEMENT_BYTES)
    if (!code) return null
    if (!savedHost) throw fail()
    return { code, claims: verifyCragHostEntitlement(projectRoot, code, hostId, { allowExpired: true }) }
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

  async function ready(opts) {
    for (const vm of await listTargets()) {
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
    if (!isOrderVmId(vmId)) throw fail('crag_subscription_target_unready', 409)
    const vm = getTarget ? await getTarget(vmId) : (await listTargets()).find(({ id }) => id === vmId)
    const options = { reclaim: current(hostId)?.claims.version === 2, allowPrepared: true }
    if (vm?.id !== vmId || (await assertReady(vm, options)) === false)
      throw fail('crag_subscription_target_unready', 409)
    preserveOtherLicense(vm)
    const machineCode = prepareCragSubscriptionBinding(projectRoot, vm)
    const payloadKeyId = targetPayloadId(projectRoot)
    const issuerId = selectedCragIssuerId(projectRoot)
    // Pin both the actual device key and the persisted VM owner, not Docker's mutable container ID.
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([hostId, machineCode, vm.owner_user_id ?? null, payloadKeyId]))
      .digest('hex')
    return { vm, machineCode, payloadKeyId, issuerId, fingerprint }
  }

  async function status() {
    let total_slots
    try {
      const targets = await listTargets()
      if (isSubscriptionSlot) total_slots = targets.filter(isSubscriptionSlot).length
      const hostId = identity()
      storage()
      const previous = current(hostId)
      const pending =
        load(marker, 0o644, 32) != null ||
        load(intentFile, 0o600, 512) != null ||
        load(rosterIntentFile, 0o600, 1024) != null
      const claims = previous?.claims
      if (claims && (!safeTime(claims.expires_at) || !safeTime(claims.revision))) throw fail()
      if (load(hostFile, 0o644, 64)) credential(hostId)
      let rights = claims ? projection({}, claims) : {}
      if (claims && !pending) {
        try {
          const remote = await authority('status', hostId, credential(hostId))
          if (remote.entitlement === previous.code) rights = projection(remote, claims)
        } catch {
          // Signed local rights still apply during an Authority outage. Do not guess remote metadata.
        }
      }
      let enabled_slots
      if (isSlotEnabled && (claims || isSubscriptionSlot)) {
        enabled_slots = 0
        for (const vm of claims && !pending ? targets : []) {
          if (await isSlotEnabled(vm, { reclaim: claims.version === 2 })) enabled_slots += 1
        }
      }
      const expired = claims && claims.expires_at <= Math.floor(Date.now() / 1000)
      return {
        ready: !pending && (await ready({ allowPrepared: true })),
        state: pending
          ? 'sync_pending'
          : claims
            ? Math.floor(Date.now() / 1000) >= claims.expires_at
              ? 'expired'
              : 'active'
            : 'unredeemed',
        ...(claims && { slot_limit: claims.slot_limit, expires_at: claims.expires_at, revision: claims.revision }),
        ...rights,
        ...(total_slots !== undefined && { total_slots }),
        ...(enabled_slots !== undefined && { enabled_slots }),
        ...(expired && { available_slots: 0 }),
        ...(pending && { available_slots: 0 }),
        ...(claims?.version === 1 && !pending && (await ready({ reclaim: true })) && { upgrade_available: true }),
      }
    } catch {
      return { ready: false, state: 'unavailable', ...(total_slots !== undefined && { total_slots }) }
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

  function verifyRights(hostId, data, previous) {
    const next = verifyCragHostEntitlement(projectRoot, data.entitlement, hostId, { allowExpired: true })
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
    projection(data, next)
    return next
  }

  async function finish(hostId, intent, previous, target) {
    publish(marker, 'pending\n', 0o644)
    let data
    try {
      data = await authority('redeem', hostId, credential(hostId), {
        redemption_code: intent.redemption_code,
        ...(target && { payload_key_id: target.payloadKeyId, issuer_public_key_id: target.issuerId }),
      })
    } catch (error) {
      if (terminalRedeem.has(error.code)) {
        remove(marker)
        remove(intentFile)
      }
      throw error
    }
    verifyRights(hostId, data, previous)
    publish(entitlementFile, data.entitlement, 0o644)
    remove(marker)
    remove(intentFile)
  }

  async function exclusive(work) {
    if (busy) throw fail('crag_subscription_busy', 409)
    busy = true
    try {
      return await work()
    } finally {
      busy = false
    }
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

  async function syncRoster(hostId, intent, previous) {
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
    const next = verifyRights(hostId, data, previous)
    if (
      next.version !== 2 ||
      (intent.action === 'release' && next.roster.some((entry) => entry.permit_sha256 === intent.permit_sha256))
    )
      throw invalidRights()
    publish(entitlementFile, data.entitlement, 0o644)
    clearRosterIntent()
  }

  function redeem(value, renewal) {
    return exclusive(async () => {
      const redemption_code = typeof value === 'string' && value.trim()
      if (!validVoucher(redemption_code)) throw fail('crag_subscription_invalid_request', 400)
      const hostId = identity()
      if (!renewal && !(await ready({ allowPrepared: true }))) throw fail('crag_subscription_target_unready', 409)
      storage(!renewal)
      const previous = current(hostId)
      if (renewal && !previous) throw fail('host_subscription_inactive', 409)
      checkNoIntent()
      credential(hostId, !renewal)
      const intent = { host_id: hostId, redemption_code }
      publish(intentFile, JSON.stringify(intent), 0o600, true)
      await finish(hostId, intent, previous)
      return status()
    })
  }

  function assertActive(previous) {
    if (!previous || Math.floor(Date.now() / 1000) >= previous.claims.expires_at)
      throw fail('host_subscription_inactive', 409)
  }

  async function bindTarget(vm, hostId, previous, machineCode, payloadKeyId, checkTarget) {
    assertActive(previous)
    const roster = previous.claims.version === 2
    if (roster) beginRosterIntent({ host_id: hostId, action: 'bind' })
    let data
    try {
      data = await authority('bind', hostId, credential(hostId), {
        machine_code: machineCode,
        payload_key_id: payloadKeyId,
      })
    } catch (error) {
      if (
        roster &&
        [
          'slot_limit_reached',
          'host_binding_conflict',
          'host_subscription_inactive',
          'payload_key_unknown',
          'payload_key_conflict',
        ].includes(error.code)
      )
        clearRosterIntent()
      throw error
    }
    if (!Number.isInteger(data.seat) || data.seat <= 0) throw invalidRights()
    if (checkTarget) ({ vm } = await checkTarget())
    if (targetPayloadId(projectRoot) !== payloadKeyId) throw fail('crag_subscription_target_changed', 409)
    let activated
    if (!roster) {
      if (data.entitlement !== previous.code) throw invalidRights()
      activated = activateCragSubscriptionBinding(projectRoot, vm, data.slot_permit, { seat: data.seat })
    } else {
      const next = verifyRights(hostId, data, previous)
      publish(entitlementFile, data.entitlement, 0o644)
      activated = activateCragSubscriptionBinding(projectRoot, vm, data.slot_permit, {
        seat: data.seat,
        verifiedRights: next,
      })
      clearRosterIntent()
    }
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
        const confirmed = await checkTarget()
        const raw = load(intentFile, 0o600, 512)
        const binding = orderId ? { order_id: orderId } : { target_fingerprint: target.fingerprint }
        const intent = { host_id: hostId, redemption_code, ...binding }
        if (raw == null) {
          const pending = readRosterIntent()
          if (!orderId && pending?.action === 'bind') await syncRoster(hostId, pending, current(hostId))
          checkNoIntent()
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
        }
        await finish(hostId, intent, current(hostId), confirmed)
        onRedeemed?.()
      }

      const pending = readRosterIntent()
      if (pending?.action === 'bind') await syncRoster(hostId, pending, current(hostId))
      checkNoIntent()
      const { vm, machineCode, payloadKeyId } = await checkTarget()
      return bindTarget(vm, hostId, current(hostId), machineCode, payloadKeyId, checkTarget)
    })
  }

  return {
    status,
    async listOrderTargets() {
      let options
      try {
        const hostId = identity()
        storage()
        options = { reclaim: current(hostId)?.claims.version === 2, allowPrepared: true }
      } catch {
        return []
      }
      const targets = []
      for (const vm of await listTargets()) {
        if (!isOrderVmId(vm.id)) continue
        try {
          if ((await assertReady(vm, options)) === false) continue
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
      return exclusive(async () => {
        const hostId = identity()
        storage()
        checkNoIntent()
        const previous = current(hostId)
        if (!previous || !(await ready({ reclaim: true }))) throw fail('crag_subscription_target_unready', 409)
        if (previous.claims.version === 2) return status()
        const intent = { host_id: hostId, action: 'upgrade' }
        beginRosterIntent(intent)
        await syncRoster(hostId, intent, previous)
        return status()
      })
    },
    async teardown(vm, destroy) {
      if (process.platform !== 'linux' || vm.node_id) return destroy(false)
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
      return exclusive(async () => {
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
      })
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
        if (rosterIntent) return syncRoster(hostId, rosterIntent, current(hostId))
        const raw = load(intentFile, 0o600, 512)
        if (raw == null) return
        const intent = JSON.parse(raw)
        if (intent.host_id !== hostId || !validVoucher(intent.redemption_code)) throw fail()
        // An order may only resume redemption after re-authorizing its checkout pin.
        if (Object.hasOwn(intent, 'order_id') || Object.hasOwn(intent, 'target_fingerprint')) return
        await finish(hostId, intent, current(hostId))
      })
    },
    bind(vm) {
      return exclusive(async () => {
        if ((await assertReady(vm, { allowPrepared: true })) === false)
          throw fail('crag_subscription_target_unready', 409)
        const hostId = identity()
        storage()
        checkNoIntent()
        const previous = current(hostId)
        assertActive(previous)
        const { seat } = await bindTarget(
          vm,
          hostId,
          previous,
          prepareCragSubscriptionBinding(projectRoot, vm),
          targetPayloadId(projectRoot),
        )
        return { seat }
      })
    },
  }
}
