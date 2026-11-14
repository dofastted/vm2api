import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  activateCragSubscriptionBinding,
  prepareCragSubscriptionBinding,
  verifyCragHostEntitlement,
} from './crag-license.mjs'
import { cragSubscriptionPublicDirectory } from './crag-subscription-paths.mjs'

const AUTHORITY = 'https://crag.fkcodex.com'
const localFilesystems = new Set([0xef53, 0x794c7630, 0x58465342, 0x9123683e, 0x2fc12fc1, 0xf2f52010])
const terminalRedeem = new Map([
  ['redeem_unavailable', 404],
  ['host_redeem_conflict', 409],
])
const fail = (code = 'crag_subscription_unavailable', status = 503) => Object.assign(new Error(code), { code, status })
const uid = () => process.getuid()
const validVoucher = (code) =>
  typeof code === 'string' &&
  /^CRAGR1\.[A-Za-z0-9_-]{43}$/.test(code) &&
  Buffer.from(code.slice(7), 'base64url').toString('base64url') === code.slice(7)
const safeTime = (value) => Number.isSafeInteger(value) && value >= 0

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
      if (size > 32768) throw fail()
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
  assertReady,
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
    const code = load(entitlementFile, 0o644, 8192)
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

  async function ready() {
    for (const vm of await listTargets()) {
      try {
        if ((await assertReady(vm)) !== false) return true
      } catch (error) {
        if (error.code !== 'crag_subscription_target_unready') throw error
      }
    }
    return false
  }

  async function status() {
    try {
      const hostId = identity()
      storage()
      const previous = current(hostId)
      const pending = load(marker, 0o644, 32) != null || load(intentFile, 0o600, 512) != null
      const claims = previous?.claims
      if (claims && (!safeTime(claims.expires_at) || !safeTime(claims.revision))) throw fail()
      if (load(hostFile, 0o644, 64)) credential(hostId)
      return {
        ready: !pending && (await ready()),
        state: pending
          ? 'sync_pending'
          : claims
            ? Math.floor(Date.now() / 1000) >= claims.expires_at
              ? 'expired'
              : 'active'
            : 'unredeemed',
        ...(claims && { slot_limit: claims.slot_limit, expires_at: claims.expires_at, revision: claims.revision }),
      }
    } catch {
      return { ready: false, state: 'unavailable' }
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
      if (envelope?.ok === false && terminalRedeem.get(code) === response.status) throw fail(code, response.status)
      if (action === 'bind' && response.status === 409 && code === 'slot_limit_reached') throw fail(code, 409)
    } catch (error) {
      if (terminalRedeem.has(error.code) || error.code === 'slot_limit_reached') throw error
    }
    throw fail('crag_subscription_authority_unavailable', 502)
  }

  async function finish(hostId, intent, previous) {
    const key = credential(hostId)
    publish(marker, 'pending\n', 0o644)
    let data
    try {
      data = await authority('redeem', hostId, key, { redemption_code: intent.redemption_code })
    } catch (error) {
      if (terminalRedeem.has(error.code)) {
        remove(marker)
        remove(intentFile)
      }
      throw error
    }
    const next = verifyCragHostEntitlement(projectRoot, data.entitlement, hostId, { allowExpired: true })
    if (
      next.revision !== data.revision ||
      next.expires_at !== data.expires_at ||
      next.slot_limit !== data.slot_limit ||
      (previous &&
        (next.revision < previous.claims.revision ||
          (next.revision === previous.claims.revision && data.entitlement !== previous.code)))
    ) {
      throw fail('crag_subscription_invalid_entitlement', 502)
    }
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

  return {
    status,
    redeem(value) {
      return exclusive(async () => {
        const redemption_code = typeof value === 'string' && value.trim()
        if (!validVoucher(redemption_code)) throw fail('crag_subscription_invalid_request', 400)
        const hostId = identity()
        if (!(await ready())) throw fail('crag_subscription_target_unready', 409)
        storage(true)
        const previous = current(hostId)
        if (load(intentFile, 0o600, 512) || load(marker, 0o644, 32)) throw fail('crag_subscription_sync_pending', 409)
        credential(hostId, true)
        const intent = { host_id: hostId, redemption_code }
        publish(intentFile, JSON.stringify(intent), 0o600, true)
        await finish(hostId, intent, previous)
        return status()
      })
    },
    recover() {
      return exclusive(async () => {
        // Unconfigured hosts have no startup work. An orphaned marker is never cleared implicitly.
        if (!fs.existsSync(intentFile)) return
        const hostId = identity()
        storage()
        const raw = load(intentFile, 0o600, 512)
        if (raw == null) return
        const intent = JSON.parse(raw)
        if (intent.host_id !== hostId || !validVoucher(intent.redemption_code)) throw fail()
        await finish(hostId, intent, current(hostId))
      })
    },
    bind(vm) {
      return exclusive(async () => {
        if ((await assertReady(vm)) === false) throw fail('crag_subscription_target_unready', 409)
        const hostId = identity()
        storage()
        if (load(intentFile, 0o600, 512) || load(marker, 0o644, 32)) throw fail('crag_subscription_sync_pending', 409)
        const previous = current(hostId)
        if (!previous || Math.floor(Date.now() / 1000) >= previous.claims.expires_at)
          throw fail('host_subscription_inactive', 409)
        const machine_code = prepareCragSubscriptionBinding(projectRoot, vm)
        const data = await authority('bind', hostId, credential(hostId), { machine_code })
        if (data.entitlement !== previous.code || !Number.isInteger(data.seat) || data.seat <= 0)
          throw fail('crag_subscription_invalid_entitlement', 502)
        activateCragSubscriptionBinding(projectRoot, vm, data.slot_permit, { seat: data.seat })
        return { seat: data.seat }
      })
    },
  }
}
