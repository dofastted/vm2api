import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { CRAG_GEMINI_PRODUCT, readCragGeminiPackageAuthority, readPinnedCragGeminiPublicKeySha256 } from './payload.mjs'

const DEFAULT_AUTHORITY = 'https://www.vm2api.org'
const HOST_DOMAIN = 'crag-gemini-host-v1:'
const MAX_HOST_ENTITLEMENT_BYTES = 1536 * 1024
const MAX_SUBSCRIPTION_TOKEN_BYTES = 8192
const MAX_HOST_ROSTER_ENTRIES = 10_000
const MAX_HOST_GRANTS = 10_000
const HEX64 = /^[a-f0-9]{64}$/
const VOUCHER_RE = /^CRAGR1\.[A-Za-z0-9_-]{43}$/

const AUTHORITY_ERRORS = new Map([
  ['redeem_unavailable', 404],
  ['host_redeem_conflict', 409],
  ['host_binding_conflict', 409],
  ['host_subscription_inactive', 403],
  ['auth_forbidden', 403],
  ['not_found', 404],
  ['slot_limit_reached', 409],
  ['request_conflict', 409],
  ['invalid_request', 400],
  ['license_invalid', 400],
  ['license_binding_mismatch', 400],
])

export const GEMINI_LICENSE_MESSAGES = {
  license_required: '当前 Gemini OAuth 环境尚未绑定 CRAGGemini 订阅席位，请先绑定席位或激活许可。',
  license_expired: 'CRAGGemini 宿主机订阅或实例许可已过期，请续费或重新激活。',
  license_not_yet_valid: 'CRAGGemini 许可尚未生效，请检查系统 UTC 时间。',
  license_invalid: 'CRAGGemini 订阅许可或签名载荷无效。',
  license_binding_mismatch: 'CRAGGemini 许可与当前环境、设备或宿主机订阅名单不匹配。',
  license_unconfigured: 'CRAGGemini 尚未配置加密载荷或订阅信任根。',
  gemini_subscription_oauth_only: '纯 API Key 模式不运行 CRAGGemini，无需绑定 CRAG 订阅席位。',
  gemini_subscription_not_active: '请先为宿主机兑换 CRAGGemini 订阅凭证。',
  gemini_subscription_reclaim_unsupported: '当前宿主机订阅版本不支持 CRAGH2 席位回收，请先升级订阅格式。',
  gemini_subscription_authority_unavailable: '无法连接 CRAGGemini 授权中心，请稍后重试。',
  gemini_subscription_invalid_entitlement: 'CRAGGemini 授权中心返回的宿主权益签名无效。',
  gemini_subscription_invalid_voucher: '请输入有效的 CRAGR1 兑换码。',
  gemini_subscription_package_unready: '宿主机尚未安装可信的 CRAGGemini 加密载荷。',
  gemini_subscription_busy: 'CRAGGemini 订阅操作正在进行中，请稍后重试。',
  gemini_subscription_invalid_code: '请输入有效的 CRAGS1 / CRAGL1 / CRAGK1 许可码。',
  slot_limit_reached: 'CRAGGemini 宿主机订阅席位已满，请先删除/释放旧环境或扩容订阅。',
  host_subscription_inactive: 'CRAGGemini 宿主机订阅未激活或已过期。',
  host_binding_conflict: '该 Gemini 环境已绑定到其他设备密钥，无法覆盖。',
  redeem_unavailable: '该 CRAGR1 兑换码不可用或已被兑换。',
  host_redeem_conflict: '该 CRAGR1 兑换码已绑定到其他宿主机。',
  auth_forbidden: 'CRAGGemini 授权中心拒绝了宿主机凭据。',
  not_found: '授权中心未找到对应的宿主机订阅或载荷密钥。',
}

function fail(code, status = 500, extra = {}) {
  const message = GEMINI_LICENSE_MESSAGES[code] || code
  return Object.assign(new Error(message), { code, status, ...extra })
}

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex')

function decodeBase64Url(value, expectedLength = null) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw fail('license_invalid', 403)
  const bytes = Buffer.from(value, 'base64url')
  if ((expectedLength != null && bytes.length !== expectedLength) || bytes.toString('base64url') !== value) {
    throw fail('license_invalid', 403)
  }
  return bytes
}

function validVoucher(code) {
  if (typeof code !== 'string' || !VOUCHER_RE.test(code)) return false
  const body = code.slice(7)
  return Buffer.from(body, 'base64url').toString('base64url') === body
}

function validVmId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    !value.includes('\0') &&
    value.trim() === value
  )
}

function exactKeys(obj, keys) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw fail('license_invalid', 403)
  const actual = Object.keys(obj)
  if (actual.length !== keys.length || keys.some((k) => !Object.hasOwn(obj, k))) {
    throw fail('license_invalid', 403)
  }
}

function verifyTokenEnvelope(code, prefix, domain, publicKey, maxBytes = MAX_SUBSCRIPTION_TOKEN_BYTES) {
  if (typeof code !== 'string' || code.length > maxBytes || Buffer.byteLength(code) > maxBytes) {
    throw fail('license_invalid', 403)
  }
  const parts = code.trim().split('.')
  if (parts.length !== 3 || parts[0] !== prefix) throw fail('license_invalid', 403)
  const raw = decodeBase64Url(parts[1])
  const sig = decodeBase64Url(parts[2], 64)
  const key = typeof publicKey === 'string' || Buffer.isBuffer(publicKey) ? createPublicKey(publicKey) : publicKey
  if (!verify(null, Buffer.concat([Buffer.from(domain), raw]), key, sig)) {
    throw fail('license_invalid', 403)
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
  } catch {
    throw fail('license_invalid', 403)
  }
}

function checkSlotLimitValue(limit) {
  if (limit === 'unlimited') return
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2_147_483_647) {
    throw fail('license_invalid', 403)
  }
}

function slotLimitAllows(limit, seat) {
  if (!Number.isSafeInteger(seat) || seat < 1) return false
  if (limit === 'unlimited') return true
  return seat <= limit
}

function unionSlotLimit(a, b) {
  if (a === 'unlimited' || b === 'unlimited') return 'unlimited'
  return Math.min(2_147_483_647, a + b)
}

export function parseCragGeminiMachineCode(code) {
  if (typeof code !== 'string' || code.length > MAX_SUBSCRIPTION_TOKEN_BYTES || !code.startsWith('CRAGM1.')) {
    throw fail('license_invalid', 400)
  }
  const raw = decodeBase64Url(code.slice('CRAGM1.'.length))
  let parsed
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
  } catch {
    throw fail('license_invalid', 400)
  }
  exactKeys(parsed, ['version', 'product', 'vm_id', 'machine_id_hash', 'device_public_key'])
  if (
    parsed.version !== 1 ||
    parsed.product !== CRAG_GEMINI_PRODUCT ||
    !validVmId(parsed.vm_id) ||
    !HEX64.test(parsed.machine_id_hash)
  ) {
    throw fail('license_invalid', 400)
  }
  decodeBase64Url(parsed.device_public_key, 32)
  return parsed
}

export function effectiveGrantedSlots(grants, now = Math.floor(Date.now() / 1000)) {
  let limit = null
  for (const grant of grants) {
    if (grant.expires_at > now) {
      limit = limit === null ? grant.slots : unionSlotLimit(limit, grant.slots)
    }
  }
  return limit
}

export function verifyCragGeminiHostEntitlement(
  code,
  hostId,
  publicKey,
  { allowExpired = false, now = Math.floor(Date.now() / 1000) } = {},
) {
  if (typeof code !== 'string') throw fail('license_invalid', 403)
  const trimmed = code.trim()
  let claims
  if (trimmed.startsWith('CRAGH2.')) {
    claims = verifyTokenEnvelope(trimmed, 'CRAGH2', 'CRAGH2\0', publicKey, MAX_HOST_ENTITLEMENT_BYTES)
    exactKeys(claims, ['version', 'product', 'host_id', 'revision', 'issued_at', 'expires_at', 'slot_limit', 'roster'])
    if (
      claims.version !== 2 ||
      claims.product !== CRAG_GEMINI_PRODUCT ||
      !HEX64.test(claims.host_id) ||
      !Number.isSafeInteger(claims.revision) ||
      claims.revision < 1 ||
      !Number.isSafeInteger(claims.issued_at) ||
      claims.issued_at < 0 ||
      !Number.isSafeInteger(claims.expires_at) ||
      claims.expires_at <= claims.issued_at
    ) {
      throw fail('license_invalid', 403)
    }
    checkSlotLimitValue(claims.slot_limit)
    if (!Array.isArray(claims.roster) || claims.roster.length > MAX_HOST_ROSTER_ENTRIES) {
      throw fail('license_invalid', 403)
    }
    let prevSeat = 0
    const seen = new Set()
    for (const entry of claims.roster) {
      exactKeys(entry, ['seat', 'permit_sha256'])
      if (
        !Number.isSafeInteger(entry.seat) ||
        entry.seat <= prevSeat ||
        !slotLimitAllows(claims.slot_limit, entry.seat) ||
        !HEX64.test(entry.permit_sha256) ||
        seen.has(entry.permit_sha256)
      ) {
        throw fail('license_invalid', 403)
      }
      seen.add(entry.permit_sha256)
      prevSeat = entry.seat
    }
  } else if (trimmed.startsWith('CRAGH3.')) {
    claims = verifyTokenEnvelope(trimmed, 'CRAGH3', 'CRAGH3\0', publicKey, MAX_HOST_ENTITLEMENT_BYTES)
    exactKeys(claims, ['version', 'product', 'host_id', 'revision', 'issued_at', 'expires_at', 'grants'])
    if (
      claims.version !== 3 ||
      claims.product !== CRAG_GEMINI_PRODUCT ||
      !HEX64.test(claims.host_id) ||
      !Number.isSafeInteger(claims.revision) ||
      claims.revision < 1 ||
      !Number.isSafeInteger(claims.issued_at) ||
      claims.issued_at < 0 ||
      !Number.isSafeInteger(claims.expires_at) ||
      claims.expires_at <= claims.issued_at ||
      !Array.isArray(claims.grants) ||
      claims.grants.length < 1 ||
      claims.grants.length > MAX_HOST_GRANTS
    ) {
      throw fail('license_invalid', 403)
    }
    let prevExpiry = 0
    for (const grant of claims.grants) {
      exactKeys(grant, ['slots', 'expires_at'])
      checkSlotLimitValue(grant.slots)
      if (!Number.isSafeInteger(grant.expires_at) || grant.expires_at <= prevExpiry) {
        throw fail('license_invalid', 403)
      }
      prevExpiry = grant.expires_at
    }
    if (claims.expires_at !== prevExpiry) throw fail('license_invalid', 403)
  } else if (trimmed.startsWith('CRAGH1.')) {
    claims = verifyTokenEnvelope(trimmed, 'CRAGH1', 'CRAGH1\0', publicKey, MAX_SUBSCRIPTION_TOKEN_BYTES)
    exactKeys(claims, ['version', 'product', 'host_id', 'revision', 'issued_at', 'expires_at', 'slot_limit'])
    if (
      claims.version !== 1 ||
      claims.product !== CRAG_GEMINI_PRODUCT ||
      !HEX64.test(claims.host_id) ||
      !Number.isSafeInteger(claims.revision) ||
      claims.revision < 1 ||
      !Number.isSafeInteger(claims.issued_at) ||
      claims.issued_at < 0 ||
      !Number.isSafeInteger(claims.expires_at) ||
      claims.expires_at <= claims.issued_at
    ) {
      throw fail('license_invalid', 403)
    }
    checkSlotLimitValue(claims.slot_limit)
  } else {
    throw fail('license_invalid', 403)
  }

  if (claims.host_id !== hostId) throw fail('license_binding_mismatch', 403)
  if (now < claims.issued_at) throw fail('license_not_yet_valid', 403)
  if (!allowExpired && now >= claims.expires_at) throw fail('license_expired', 403)
  return claims
}

export function verifyCragGeminiSlotPermit(
  permitCode,
  entitlementClaims,
  publicKey,
  { expectedHostId, expectedVmId, expectedPayloadKeyId, now = Math.floor(Date.now() / 1000) } = {},
) {
  const trimmed = typeof permitCode === 'string' ? permitCode.trim() : ''
  const permit = verifyTokenEnvelope(trimmed, 'CRAGS1', 'CRAGS1\0', publicKey, MAX_SUBSCRIPTION_TOKEN_BYTES)
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
  if (
    permit.version !== 1 ||
    permit.product !== CRAG_GEMINI_PRODUCT ||
    !HEX64.test(permit.host_id) ||
    !Number.isSafeInteger(permit.seat) ||
    permit.seat < 1 ||
    !validVmId(permit.vm_id) ||
    !HEX64.test(permit.machine_id_hash) ||
    !HEX64.test(permit.payload_key_id)
  ) {
    throw fail('license_invalid', 403)
  }
  decodeBase64Url(permit.device_public_key, 32)
  exactKeys(permit.wrapped_key, ['ephemeral_public_key', 'nonce', 'ciphertext', 'tag'])
  decodeBase64Url(permit.wrapped_key.ephemeral_public_key, 32)
  decodeBase64Url(permit.wrapped_key.nonce, 12)
  decodeBase64Url(permit.wrapped_key.ciphertext, 32)
  decodeBase64Url(permit.wrapped_key.tag, 16)

  if (
    (expectedHostId && permit.host_id !== expectedHostId) ||
    (expectedVmId && permit.vm_id !== expectedVmId) ||
    permit.host_id !== entitlementClaims.host_id
  ) {
    throw fail('license_binding_mismatch', 403)
  }
  if (expectedPayloadKeyId && permit.payload_key_id !== expectedPayloadKeyId) {
    throw fail('license_invalid', 403)
  }

  if (entitlementClaims.version === 1) {
    if (!slotLimitAllows(entitlementClaims.slot_limit, permit.seat)) {
      throw fail('license_binding_mismatch', 403)
    }
  } else if (entitlementClaims.version === 2) {
    const permitSha = sha256Hex(trimmed)
    const inRoster = entitlementClaims.roster.some(
      (entry) => entry.seat === permit.seat && entry.permit_sha256 === permitSha,
    )
    if (!slotLimitAllows(entitlementClaims.slot_limit, permit.seat) || !inRoster) {
      throw fail('license_binding_mismatch', 403)
    }
  } else if (entitlementClaims.version === 3) {
    const liveLimit = effectiveGrantedSlots(entitlementClaims.grants, now)
    if (!liveLimit) throw fail('license_expired', 403)
    if (!slotLimitAllows(liveLimit, permit.seat)) throw fail('license_binding_mismatch', 403)
  } else {
    throw fail('license_invalid', 403)
  }
  return { permit, permit_sha256: sha256Hex(trimmed) }
}

export function cragGeminiSubscriptionPublicDirectory(projectRoot, dataDir = null) {
  const baseData = dataDir || process.env.KIN_DATA_DIR || path.join(projectRoot, 'src', 'data')
  return path.resolve(baseData, 'crag-gemini-subscription', 'public')
}

function fsyncDir(dir) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function publishFile(file, value, mode, createOnly = false) {
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
    fsyncDir(dir)
  }
}

function removeFile(file) {
  fs.rmSync(file, { force: true })
  if (fs.existsSync(path.dirname(file))) fsyncDir(path.dirname(file))
}

function readOptionalFile(file, limit) {
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    const st = fs.fstatSync(fd)
    if (!st.isFile() || st.size > limit) throw fail('license_invalid', 503)
    const buf = Buffer.alloc(st.size)
    if (st.size > 0 && fs.readSync(fd, buf, 0, buf.length, 0) !== buf.length) throw fail('license_invalid', 503)
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function resolveOrigin(origin) {
  const value = (origin || process.env.KIN_CRAG_GEMINI_AUTHORITY_URL || DEFAULT_AUTHORITY).trim()
  const normalized = value.replace(/\/+$/, '')
  if (
    normalized !== DEFAULT_AUTHORITY &&
    !/^https:\/\/[A-Za-z0-9.-]+(?::[1-9][0-9]{0,4})?(?:\/[A-Za-z0-9_-]+)*$/.test(normalized) &&
    !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}(?:\/[A-Za-z0-9_-]+)*$/.test(normalized)
  ) {
    throw fail('license_unconfigured', 503)
  }
  return normalized
}

export function createGeminiCragSubscription({
  projectRoot,
  dataDir = null,
  payloadDir = null,
  publicKeyPem = null,
  publicKeyFile = process.env.KIN_GEMINI_PUBLIC_KEY_FILE || null,
  expectedPublicKeySha256 = null,
  resolveAuthority = null,
  callHost,
  fetchImpl = globalThis.fetch,
  origin = null,
  machineIdFile = process.env.KIN_CRAG_HOST_ID_FILE || '/etc/machine-id',
} = {}) {
  const authorityOrigin = resolveOrigin(origin)
  const publicDir = cragGeminiSubscriptionPublicDirectory(projectRoot, dataDir)
  const baseDir = path.dirname(publicDir)
  const privateDir = path.join(baseDir, 'private')
  const hostIdFile = path.join(publicDir, 'host_id')
  const entitlementFile = path.join(publicDir, 'entitlement.code')
  const syncMarkerFile = path.join(publicDir, 'sync-pending')
  const credentialFile = path.join(privateDir, 'credential')
  const AUTO_BIND_BACKOFF_MS = 30_000
  const autoBindBackoff = new Map()
  let busy = false

  function ensureStorage() {
    fs.mkdirSync(baseDir, { recursive: true, mode: 0o755 })
    fs.mkdirSync(publicDir, { recursive: true, mode: 0o755 })
    fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 })
    fs.chmodSync(publicDir, 0o755)
    fs.chmodSync(privateDir, 0o700)
  }

  function resolveHostId(create = false) {
    if (create) ensureStorage()
    const saved = readOptionalFile(hostIdFile, 128)?.trim()
    if (saved) {
      if (!HEX64.test(saved)) throw fail('license_invalid', 503)
      return saved
    }
    let raw = null
    try {
      const text = fs.readFileSync(machineIdFile, 'utf8').trim().toLowerCase().replaceAll('-', '')
      if (/^[a-f0-9]{32}$/.test(text) && !/^(0{32}|f{32})$/.test(text)) raw = text
    } catch {}
    const derived = raw
      ? sha256Hex(`${HOST_DOMAIN}${raw}`)
      : sha256Hex(`${HOST_DOMAIN}${randomBytes(16).toString('hex')}`)
    if (create) publishFile(hostIdFile, `${derived}\n`, 0o644, true)
    return derived
  }

  function resolveCredential(hostId, initialize = false) {
    ensureStorage()
    const saved = readOptionalFile(credentialFile, 128)?.trim()
    if (saved) {
      if (!validVoucher(`CRAGR1.${saved}`)) throw fail('license_invalid', 503)
      return saved
    }
    if (!initialize) throw fail('gemini_subscription_not_active', 409)
    const generated = randomBytes(32).toString('base64url')
    publishFile(credentialFile, `${generated}\n`, 0o600, true)
    if (!readOptionalFile(hostIdFile, 128)) {
      publishFile(hostIdFile, `${hostId}\n`, 0o644, true)
    }
    return generated
  }

  // Trust root priority (never self-attest from payloadDir/crag-license-public.pem):
  // 1. Explicit `publicKeyPem` option (in-process / test override).
  // 2. Operator-configured `publicKeyFile` (`KIN_GEMINI_PUBLIC_KEY_FILE`, read with O_NOFOLLOW)
  //    so authority key rotation works without rebuilding vm2api.
  // 3. Explicit `expectedPublicKeySha256` or the git-tracked pin in `deploy/payload.json`.
  function packageAuthority() {
    if (resolveAuthority) return resolveAuthority()
    const dir = payloadDir || process.env.KIN_GEMINI_PAYLOAD_DIR || path.join(projectRoot, 'share', 'gemini', 'current')
    const keyFile = typeof publicKeyFile === 'string' ? publicKeyFile.trim() : ''
    try {
      let trustedPem = publicKeyPem
      let pinnedSha = null
      if (!trustedPem && keyFile) {
        const filePem = readOptionalFile(keyFile, 4096)
        if (!filePem || !filePem.trim()) throw fail('gemini_subscription_package_unready', 409)
        trustedPem = filePem
      }
      if (!trustedPem) {
        pinnedSha = expectedPublicKeySha256 ?? readPinnedCragGeminiPublicKeySha256(projectRoot)
        if (!pinnedSha) throw fail('gemini_subscription_package_unready', 409)
      }
      return readCragGeminiPackageAuthority(dir, trustedPem, { expectedPublicKeySha256: pinnedSha })
    } catch {
      throw fail('gemini_subscription_package_unready', 409)
    }
  }

  function readLocalEntitlement(authority) {
    const hostId = readOptionalFile(hostIdFile, 128)?.trim()
    const code = readOptionalFile(entitlementFile, MAX_HOST_ENTITLEMENT_BYTES + 1)?.trim()
    if (!hostId || !code) return null
    const claims = verifyCragGeminiHostEntitlement(code, hostId, authority.publicKey, { allowExpired: true })
    return { hostId, code, claims }
  }

  async function callAuthority(action, hostId, credential, body) {
    let status = 502
    let code = null
    let requestId = null
    try {
      const response = await fetchImpl(`${authorityOrigin}/v1/host-subscriptions/${action}`, {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
        headers: {
          authorization: `Bearer ${credential}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ host_id: hostId, ...body }),
      })
      status = response.status
      requestId = response.headers.get('x-request-id') || null
      const json = await response.json()
      if (response.ok && json?.ok === true && json.data && typeof json.data === 'object') {
        return json.data
      }
      if (json?.ok === false && typeof json.error?.code === 'string' && AUTHORITY_ERRORS.has(json.error.code)) {
        code = json.error.code
      }
    } catch {
      // Transport failure
    }
    if (code) throw fail(code, AUTHORITY_ERRORS.get(code) || status, { authorityRequestId: requestId })
    throw fail('gemini_subscription_authority_unavailable', 502, { authorityRequestId: requestId })
  }

  async function withLock(fn) {
    if (busy) throw fail('gemini_subscription_busy', 409)
    busy = true
    try {
      return await fn()
    } finally {
      busy = false
    }
  }

  function canAutoBindLocal() {
    if (fs.existsSync(syncMarkerFile)) return null
    let authority
    try {
      authority = packageAuthority()
    } catch {
      return null
    }
    let local
    try {
      local = readLocalEntitlement(authority)
    } catch {
      return null
    }
    if (!local) return null
    const now = Math.floor(Date.now() / 1000)
    const { claims } = local
    if (now < claims.issued_at || now >= claims.expires_at) return null
    if (claims.version === 2) {
      const cap = claims.slot_limit === 'unlimited' ? 10_000 : Math.min(claims.slot_limit, 10_000)
      if (claims.roster.length >= cap) return null
    } else if (claims.version === 3) {
      if (!effectiveGrantedSlots(claims.grants, now)) return null
    }
    return { authority, local }
  }

  function needsAutoSeatBind(env, { payloadMode = null } = {}) {
    if (!env || typeof env.id !== 'string' || !env.id) return false
    if (env.auth_method === 'api_key' || env.auth_state === 'disabled') return false
    const isCragSub =
      payloadMode === 'crag_subscription' ||
      env.payload_mode === 'crag_subscription' ||
      env.crag_license?.seat_required === true
    if (!isCragSub) return false
    if (env.crag_license?.valid === true) return false
    if (env.crag_license?.code && env.crag_license.code !== 'license_required') return false
    return true
  }

  function formatStatus({ hostId, authority, local, remote = null }) {
    const now = Math.floor(Date.now() / 1000)
    const syncPending = fs.existsSync(syncMarkerFile)
    if (!local) {
      return {
        configured: Boolean(authority),
        active: false,
        product: CRAG_GEMINI_PRODUCT,
        host_id: hostId,
        sync_pending: syncPending,
        issuer_public_key_id: authority?.issuerId ?? null,
        payload_key_id: authority?.payloadKeyId ?? null,
        version: null,
        revision: null,
        issued_at: null,
        expires_at: null,
        slot_limit: 0,
        used_slots: 0,
        available_slots: 0,
        reclaim_supported: false,
      }
    }
    const { claims } = local
    const active = !syncPending && now >= claims.issued_at && now < claims.expires_at
    let slotLimit = claims.slot_limit
    let usedSlots = remote?.used_slots ?? null
    let availableSlots = remote?.available_slots ?? null
    if (claims.version === 2) {
      usedSlots = claims.roster.length
      const cap = claims.slot_limit === 'unlimited' ? 10_000 : Math.min(claims.slot_limit, 10_000)
      availableSlots = active ? Math.max(0, cap - usedSlots) : 0
    } else if (claims.version === 3) {
      slotLimit = effectiveGrantedSlots(claims.grants, now) ?? 0
    }
    return {
      configured: true,
      active,
      product: CRAG_GEMINI_PRODUCT,
      host_id: local.hostId,
      sync_pending: syncPending,
      issuer_public_key_id: authority.issuerId,
      payload_key_id: authority.payloadKeyId,
      version: claims.version,
      revision: claims.revision,
      issued_at: claims.issued_at,
      expires_at: claims.expires_at,
      slot_limit: slotLimit,
      used_slots: usedSlots,
      available_slots: availableSlots,
      reclaim_supported: claims.version === 2,
      ...(Array.isArray(remote?.quota_grants) ? { quota_grants: remote.quota_grants } : {}),
    }
  }

  return {
    publicDir,

    async status({ sync = false } = {}) {
      let authority = null
      try {
        authority = packageAuthority()
      } catch {
        return formatStatus({ hostId: readOptionalFile(hostIdFile, 128)?.trim() || null, authority: null, local: null })
      }
      const hostId = resolveHostId(false)
      let local = readLocalEntitlement(authority)
      let remote = null
      if (sync && local) {
        const cred = resolveCredential(hostId, false)
        const data = await callAuthority('status', hostId, cred, {})
        const nextClaims = verifyCragGeminiHostEntitlement(data.entitlement, hostId, authority.publicKey, {
          allowExpired: true,
        })
        if (nextClaims.revision < local.claims.revision) throw fail('gemini_subscription_invalid_entitlement', 502)
        if (nextClaims.revision > local.claims.revision) {
          publishFile(entitlementFile, `${data.entitlement}\n`, 0o644)
          local = { hostId, code: data.entitlement, claims: nextClaims }
        }
        remote = data
      }
      return formatStatus({ hostId, authority, local, remote })
    },

    async redeem(redemptionCode) {
      const code = typeof redemptionCode === 'string' ? redemptionCode.trim() : ''
      if (!validVoucher(code)) throw fail('gemini_subscription_invalid_voucher', 400)
      return withLock(async () => {
        const authority = packageAuthority()
        const hostId = resolveHostId(true)
        const cred = resolveCredential(hostId, true)
        const previous = readLocalEntitlement(authority)
        publishFile(syncMarkerFile, 'pending\n', 0o644)
        try {
          const data = await callAuthority('redeem', hostId, cred, {
            redemption_code: code,
            issuer_public_key_id: authority.issuerId,
            payload_key_id: authority.payloadKeyId,
          })
          const claims = verifyCragGeminiHostEntitlement(data.entitlement, hostId, authority.publicKey, {
            allowExpired: true,
          })
          if (previous && claims.revision < previous.claims.revision) {
            throw fail('gemini_subscription_invalid_entitlement', 502)
          }
          publishFile(entitlementFile, `${data.entitlement}\n`, 0o644)
          removeFile(syncMarkerFile)
          autoBindBackoff.clear()
          return formatStatus({ hostId, authority, local: { hostId, code: data.entitlement, claims }, remote: data })
        } catch (error) {
          if (error?.code !== 'gemini_subscription_authority_unavailable') {
            removeFile(syncMarkerFile)
          }
          throw error
        }
      })
    },

    async upgrade() {
      return withLock(async () => {
        const authority = packageAuthority()
        const hostId = resolveHostId(false)
        const cred = resolveCredential(hostId, false)
        const previous = readLocalEntitlement(authority)
        if (!previous) throw fail('gemini_subscription_not_active', 409)
        publishFile(syncMarkerFile, 'pending\n', 0o644)
        try {
          const data = await callAuthority('upgrade', hostId, cred, {})
          const claims = verifyCragGeminiHostEntitlement(data.entitlement, hostId, authority.publicKey, {
            allowExpired: true,
          })
          if (claims.version !== 2 || claims.revision < previous.claims.revision) {
            throw fail('gemini_subscription_invalid_entitlement', 502)
          }
          publishFile(entitlementFile, `${data.entitlement}\n`, 0o644)
          removeFile(syncMarkerFile)
          autoBindBackoff.clear()
          return formatStatus({ hostId, authority, local: { hostId, code: data.entitlement, claims }, remote: data })
        } catch (error) {
          if (error?.code !== 'gemini_subscription_authority_unavailable') removeFile(syncMarkerFile)
          throw error
        }
      })
    },

    async bindEnvironment(envId) {
      return withLock(async () => {
        const env = await callHost('get', { id: envId })
        if (env?.auth_method === 'api_key') throw fail('gemini_subscription_oauth_only', 409)
        const authority = packageAuthority()
        const hostId = resolveHostId(false)
        const local = readLocalEntitlement(authority)
        if (!local) throw fail('gemini_subscription_not_active', 409)
        const cred = resolveCredential(hostId, false)
        const machineInfo = await callHost('license-machine-code', { id: envId })
        const machineCode = typeof machineInfo?.machine_code === 'string' ? machineInfo.machine_code.trim() : ''
        const identity = parseCragGeminiMachineCode(machineCode)
        if (identity.vm_id !== envId) throw fail('license_binding_mismatch', 409)

        publishFile(syncMarkerFile, 'pending\n', 0o644)
        try {
          const bound = await callAuthority('bind', hostId, cred, {
            machine_code: machineCode,
            issuer_public_key_id: authority.issuerId,
            payload_key_id: authority.payloadKeyId,
          })
          const nextClaims = verifyCragGeminiHostEntitlement(bound.entitlement, hostId, authority.publicKey)
          if (nextClaims.revision < local.claims.revision) {
            throw fail('gemini_subscription_invalid_entitlement', 502)
          }
          const verifiedPermit = verifyCragGeminiSlotPermit(bound.slot_permit, nextClaims, authority.publicKey, {
            expectedHostId: hostId,
            expectedVmId: envId,
            expectedPayloadKeyId: authority.payloadKeyId,
          })
          if (verifiedPermit.permit.seat !== bound.seat) {
            throw fail('gemini_subscription_invalid_entitlement', 502)
          }
          publishFile(entitlementFile, `${bound.entitlement}\n`, 0o644)
          removeFile(syncMarkerFile)
          const activated = await callHost('license-activate', { id: envId, code: bound.slot_permit })
          autoBindBackoff.delete(envId)
          return {
            vm_id: envId,
            seat: bound.seat,
            license: activated,
            subscription: formatStatus({
              hostId,
              authority,
              local: { hostId, code: bound.entitlement, claims: nextClaims },
            }),
          }
        } catch (error) {
          if (error?.code !== 'gemini_subscription_authority_unavailable') removeFile(syncMarkerFile)
          throw error
        }
      })
    },

    async activateEnvironment(envId, code) {
      const trimmed = typeof code === 'string' ? code.trim() : ''
      if (
        !trimmed ||
        (!trimmed.startsWith('CRAGS1.') && !trimmed.startsWith('CRAGL1.') && !trimmed.startsWith('CRAGK1.'))
      ) {
        throw fail('gemini_subscription_invalid_code', 400)
      }
      const env = await callHost('get', { id: envId })
      if (env?.auth_method === 'api_key') throw fail('gemini_subscription_oauth_only', 409)
      const license = await callHost('license-activate', { id: envId, code: trimmed })
      return { vm_id: envId, license }
    },

    async releaseEnvironment(envId, { ignoreMissing = false } = {}) {
      return withLock(async () => {
        const env = await callHost('get', { id: envId })
        if (env?.auth_method === 'api_key') {
          if (ignoreMissing) return { released: false, seat_required: false }
          throw fail('gemini_subscription_oauth_only', 409)
        }
        const candidate = await callHost('license-release-candidate', { id: envId })
        const permitSha = typeof candidate?.permit_sha256 === 'string' ? candidate.permit_sha256 : null
        if (!permitSha || !HEX64.test(permitSha)) {
          if (ignoreMissing) return { released: false, seat_required: true }
          throw fail('license_required', 409)
        }
        const authority = packageAuthority()
        const hostId = resolveHostId(false)
        const local = readLocalEntitlement(authority)
        if (!local) {
          if (ignoreMissing) {
            await callHost('license-clear', { id: envId })
            return { released: false, cleared_local: true }
          }
          throw fail('gemini_subscription_not_active', 409)
        }
        if (local.claims.version !== 2) {
          if (ignoreMissing) {
            await callHost('license-clear', { id: envId })
            return { released: false, reclaim_supported: false, cleared_local: true }
          }
          throw fail('gemini_subscription_reclaim_unsupported', 409)
        }
        const cred = resolveCredential(hostId, false)
        publishFile(syncMarkerFile, 'pending\n', 0o644)
        try {
          const data = await callAuthority('release', hostId, cred, {
            vm_id: envId,
            permit_sha256: permitSha,
          })
          const nextClaims = verifyCragGeminiHostEntitlement(data.entitlement, hostId, authority.publicKey, {
            allowExpired: true,
          })
          if (
            nextClaims.version !== 2 ||
            nextClaims.revision < local.claims.revision ||
            nextClaims.roster.some((entry) => entry.permit_sha256 === permitSha)
          ) {
            throw fail('gemini_subscription_invalid_entitlement', 502)
          }
          publishFile(entitlementFile, `${data.entitlement}\n`, 0o644)
          removeFile(syncMarkerFile)
          await callHost('license-clear', { id: envId })
          autoBindBackoff.clear()
          return {
            released: true,
            vm_id: envId,
            subscription: formatStatus({
              hostId,
              authority,
              local: { hostId, code: data.entitlement, claims: nextClaims },
              remote: data,
            }),
          }
        } catch (error) {
          if (error?.code !== 'gemini_subscription_authority_unavailable') removeFile(syncMarkerFile)
          throw error
        }
      })
    },

    async ensureEnvironmentSeat(envId, { env = null, payloadMode = null } = {}) {
      if (busy) return { attempted: false, bound: false, reason: 'busy' }
      const until = autoBindBackoff.get(envId)
      if (until && Date.now() < until) return { attempted: false, bound: false, reason: 'backoff' }
      if (!canAutoBindLocal()) return { attempted: false, bound: false, reason: 'inactive_or_full' }
      const target = env ?? (await callHost('get', { id: envId }).catch(() => null))
      if (!needsAutoSeatBind(target, { payloadMode })) {
        return { attempted: false, bound: false, reason: 'not_needed' }
      }
      try {
        const result = await this.bindEnvironment(envId)
        return { attempted: true, bound: true, seat: result.seat, result }
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'bind_failed'
        autoBindBackoff.set(envId, Date.now() + AUTO_BIND_BACKOFF_MS)
        return { attempted: true, bound: false, error_code: code }
      }
    },

    async reconcileEnvironmentSeats(environments, { payloadMode = null } = {}) {
      if (busy || !Array.isArray(environments) || !environments.length) return { boundIds: [] }
      if (!canAutoBindLocal()) return { boundIds: [] }
      const boundIds = []
      for (const env of environments) {
        if (!needsAutoSeatBind(env, { payloadMode })) continue
        const outcome = await this.ensureEnvironmentSeat(env.id, { env, payloadMode })
        if (outcome.bound) {
          boundIds.push(env.id)
          continue
        }
        if (
          outcome.reason === 'inactive_or_full' ||
          outcome.reason === 'busy' ||
          outcome.error_code === 'slot_limit_reached' ||
          outcome.error_code === 'host_subscription_inactive' ||
          outcome.error_code === 'gemini_subscription_authority_unavailable'
        ) {
          break
        }
      }
      return { boundIds }
    },

    async environmentStatus(envId) {
      const env = await callHost('get', { id: envId })
      if (env?.auth_method === 'api_key') {
        return {
          vm_id: envId,
          auth_method: 'api_key',
          seat_required: false,
          license: { product: CRAG_GEMINI_PRODUCT, status: 'not_required', valid: true, vm_id: envId },
        }
      }
      const status = await callHost('license-status', { id: envId })
      return {
        vm_id: envId,
        auth_method: 'oauth',
        seat_required: true,
        ...status,
      }
    },

    checkAdmission(environment, { payloadMode = null } = {}) {
      if (!environment || environment.auth_method === 'api_key') {
        return { ok: true, seat_required: false }
      }
      const lic = environment.crag_license
      if (payloadMode !== 'crag_subscription' && !lic) {
        return { ok: true, seat_required: false }
      }
      if (lic?.valid === true) {
        return { ok: true, seat_required: true, seat: lic.seat ?? null }
      }
      const code =
        typeof lic?.code === 'string' && Object.hasOwn(GEMINI_LICENSE_MESSAGES, lic.code)
          ? lic.code
          : 'license_required'
      return {
        ok: false,
        status: 403,
        code,
        message: GEMINI_LICENSE_MESSAGES[code],
      }
    },
  }
}
