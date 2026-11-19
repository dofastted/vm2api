/** Account quota summary from the slot's official subscription service. Never reads provider credentials. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fetchAntigravityQuota } from '../transport/antigravity-bridge-supervisor.mjs'
import { normalizeAntigravityRouting } from '../protocol/antigravity-route.mjs'
import { isValidVmId } from '../vm/vm-file.mjs'
import { isAntigravityVm } from '../vm/vm-kind.mjs'
import { summarizeAntigravitySlot } from '../vm/antigravity-slot.mjs'
import { patchVmRecord } from '../vm/vm-registry.mjs'

const MAX_BYTES = 256 * 1024
const active = new Map()
const failure = (code, message, status = 502) => ({ ok: false, code, message, status })

function text(value, max = 200) {
  if (typeof value !== 'string') return null
  const result = value.replace(/[\x00-\x1f\x7f]/g, ' ').trim()
  return result ? result.slice(0, max) : null
}

function bucketOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const fraction = raw.remainingFraction
  const amount = typeof raw.remainingAmount === 'string' ? Number(raw.remainingAmount) : raw.remainingAmount
  const reset = typeof raw.resetTime === 'string' ? Date.parse(raw.resetTime) : NaN
  const remaining =
    typeof fraction === 'number' && Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : null
  const remainingAmount = Number.isSafeInteger(amount) && amount >= 0 ? amount : null
  if (remaining == null && remainingAmount == null && raw.disabled !== true) return null
  return {
    id: text(raw.bucketId, 100),
    name: text(raw.displayName),
    description: text(raw.description, 400),
    window: text(raw.window, 40),
    remaining,
    remaining_amount: remainingAmount,
    disabled: raw.disabled === true,
    reset_at: Number.isFinite(reset) ? new Date(reset).toISOString() : null,
  }
}

/** google.internal.cloud.code.v1internal.RetrieveUserQuotaSummaryResponse (proto3 JSON). */
export function normalizeAntigravityQuotaSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const buckets = (list) => (Array.isArray(list) ? list.slice(0, 32).map(bucketOf).filter(Boolean) : [])
  const groups = (Array.isArray(value.groups) ? value.groups.slice(0, 32) : [])
    .filter((group) => group && typeof group === 'object' && !Array.isArray(group))
    .map((group) => ({
      name: text(group.displayName),
      description: text(group.description, 400),
      buckets: buckets(group.buckets),
    }))
    .filter((group) => group.buckets.length)
  const grouped = new Set(groups.flatMap((group) => group.buckets.map((bucket) => bucket.id)).filter(Boolean))
  const loose = buckets(value.buckets).filter((bucket) => !bucket.id || !grouped.has(bucket.id))
  if (loose.length) groups.push({ name: null, description: null, buckets: loose })
  return groups.length ? { description: text(value.description, 400), groups } : null
}

function quotaPath(root, vm, create = false) {
  if (!root || !isValidVmId(vm?.id)) throw new TypeError('A valid slot is required')
  // data/ is not mounted into the guest; the snapshot is control-plane state.
  let current = path.resolve(root)
  for (const part of ['data', 'antigravity-quota']) {
    current = path.join(current, part)
    if (create && !fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 })
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new TypeError('Quota directory is not private')
  }
  return path.join(current, `${vm.id}.json`)
}

function readRaw(root, vm) {
  let fd
  try {
    fd = fs.openSync(quotaPath(root, vm), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_BYTES) return null
    const raw = JSON.parse(fs.readFileSync(fd, 'utf8'))
    if (raw?.version !== 1 || raw.vm_id !== vm.id || raw.owner_user_id !== String(vm.owner_user_id ?? '')) return null
    if (raw.credential_updated_at !== (summarizeAntigravitySlot(root, vm).updated_at ?? null)) return null
    return raw
  } catch {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function view(raw) {
  if (!raw) return null
  return {
    updated_at: raw.updated_at ?? null,
    description: raw.description ?? null,
    groups: Array.isArray(raw.groups) ? raw.groups : [],
    error: raw.error ?? null,
  }
}

/** Snapshot bound to the current owner and authorization; account changes hide stale balances. */
export function readAntigravityQuota(projectRoot, vm) {
  return view(readRaw(projectRoot, vm))
}

function writeQuota(root, vm, patch) {
  const previous = readRaw(root, vm)
  const file = quotaPath(root, vm, true)
  const temporary = `${file}.${crypto.randomBytes(12).toString('hex')}.tmp`
  const value = {
    version: 1,
    vm_id: vm.id,
    owner_user_id: String(vm.owner_user_id ?? ''),
    credential_updated_at: summarizeAntigravitySlot(root, vm).updated_at ?? null,
    updated_at: previous?.updated_at ?? null,
    description: previous?.description ?? null,
    groups: previous?.groups ?? [],
    error: null,
    ...patch,
  }
  try {
    fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, file)
  } finally {
    try {
      fs.unlinkSync(temporary)
    } catch {}
  }
  return view(value)
}

const MESSAGES = {
  antigravity_disabled: 'Antigravity 平台接入未启用，无法查询额度。',
  antigravity_slot_unavailable: '槽位未运行或出口不匹配，无法查询额度。',
  antigravity_auth_expired: '账号授权已失效，请重新绑定凭证。',
  antigravity_rate_limited: '官方额度接口限流，请稍后再试。',
  antigravity_runtime_reload_required: '运行时配置已变更，重启槽位后才能查询额度。',
}

export async function refreshAntigravityQuota({ projectRoot, vm, routing = {}, ops = {} } = {}) {
  if (!isAntigravityVm(vm)) return failure('platform_mismatch', '此操作需要 Antigravity 槽位', 400)
  if (summarizeAntigravitySlot(projectRoot, vm).authenticated !== true)
    return failure('antigravity_official_login_required', '请先完成 Antigravity 账号授权。', 409)
  const key = `${path.resolve(projectRoot)}:${vm.id}`
  if (active.has(key)) return active.get(key)
  const operation = (async () => {
    const credentialUpdatedAt = summarizeAntigravitySlot(projectRoot, vm).updated_at ?? null
    const result = await (ops.fetchQuota || fetchAntigravityQuota)({ projectRoot, vm, routing, ops })
    const currentVm = ops.getVm ? ops.getVm() : vm
    if (!currentVm) return failure('vm_not_found', '槽位已删除。', 404)
    if (
      String(currentVm.owner_user_id ?? '') !== String(vm.owner_user_id ?? '') ||
      (summarizeAntigravitySlot(projectRoot, currentVm).updated_at ?? null) !== credentialUpdatedAt
    )
      return failure('antigravity_account_changed', '槽位账号已变更，请重新查询额度。', 409)
    const summary = result.ok ? normalizeAntigravityQuotaSummary(result.summary) : null
    if (!summary) {
      const code = result.ok ? 'antigravity_quota_invalid' : String(result.code || 'antigravity_quota_unavailable')
      const message = MESSAGES[code] || '无法读取官方额度，请确认槽位运行、账号已授权及出口可用。'
      writeQuota(projectRoot, currentVm, { error: { code, message, at: new Date().toISOString() } })
      return failure(code, message, result.ok ? 502 : result.status || 502)
    }
    if (result.email && result.email !== currentVm.antigravity?.email)
      (ops.patchVm || patchVmRecord)(projectRoot, currentVm.id, (record) => ({
        antigravity: { ...record.antigravity, email: result.email },
      }))
    return { ok: true, ...writeQuota(projectRoot, currentVm, { ...summary, updated_at: new Date().toISOString() }) }
  })()
  active.set(key, operation)
  try {
    return await operation
  } finally {
    active.delete(key)
  }
}

/** Reading the summary costs no inference, so authorized slots are refreshed on a fixed cadence. */
export function createAntigravityQuotaMonitor({
  projectRoot,
  listTargets,
  getRouting,
  intervalMs = 10 * 60_000,
  refresh = refreshAntigravityQuota,
} = {}) {
  let timer = null
  let running = null
  async function pass() {
    const routing = getRouting() || {}
    if (!normalizeAntigravityRouting(routing.antigravity).enabled) return
    for (const vm of listTargets()) {
      if (!timer) return
      if (!isAntigravityVm(vm) || summarizeAntigravitySlot(projectRoot, vm).authenticated !== true) continue
      try {
        await refresh({ projectRoot, vm, routing })
      } catch {}
    }
  }
  const tick = () => {
    running ||= pass().finally(() => {
      running = null
    })
    return running
  }
  return {
    start({ immediate = false } = {}) {
      if (timer) return
      timer = setInterval(tick, intervalMs)
      timer.unref?.()
      if (immediate) void tick()
    },
    stop() {
      clearInterval(timer)
      timer = null
    },
    tick,
  }
}
