/** Public model metadata from the slot's official client. Never reads provider credentials. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { antigravityAuthVerifyArgv } from './antigravity-auth-login.mjs'
import { antigravityRuntimeSupport } from '../transport/antigravity-bridge-supervisor.mjs'
import {
  antigravityModelId,
  normalizeAntigravityModels,
  normalizeAntigravityRouting,
} from '../protocol/antigravity-route.mjs'
import { isValidVmId } from '../vm/vm-file.mjs'
import { summarizeAntigravitySlot } from '../vm/antigravity-slot.mjs'
import { modelsDevLimits } from '../admin/price-catalog.mjs'

const execFileAsync = promisify(execFile)
const active = new Map()
const MAX_BYTES = 256 * 1024
const failure = (code, message, status = 502) => ({ ok: false, code, message, status })

function catalogPath(root, vm, create = false) {
  if (!root || !isValidVmId(vm?.id)) throw new TypeError('A valid slot is required')
  // The guest does not mount data/. Keep its claimed capabilities outside guest-writable run/.
  let current = path.resolve(root)
  for (const part of ['data', 'antigravity-models']) {
    current = path.join(current, part)
    if (create && !fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 })
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new TypeError('Catalog directory is not private')
  }
  return path.join(current, `${vm.id}.json`)
}

function modelVendor(id) {
  if (id.startsWith('gemini-')) return 'google'
  if (id.startsWith('claude-')) return 'anthropic'
  if (id.startsWith('gpt-')) return 'openai'
  return null
}

/** Official 1.4.4 emits one model ID and display name per tab-separated line. */
export function parseAntigravityModels(stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > MAX_BYTES) return null
  const models = []
  const seen = new Set()
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    const fields = line.split('\t')
    const id = antigravityModelId(fields[0])
    if (!id || fields.length !== 2 || fields[0] !== id || /[\x00-\x1f\x7f]/.test(fields[1])) return null
    const displayName = fields[1].trim()
    if (!displayName || displayName.length > 240 || models.length >= 512) return null
    if (seen.has(id.toLowerCase())) continue
    seen.add(id.toLowerCase())
    models.push({ id, display_name: displayName, vendor: modelVendor(id), enabled: true })
  }
  return models.length ? models : null
}

export function readAntigravityModelCatalog(projectRoot, vm) {
  let fd
  try {
    const file = catalogPath(projectRoot, vm)
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_BYTES) return null
    const raw = JSON.parse(fs.readFileSync(fd, 'utf8'))
    if (raw.version !== 1 || raw.vm_id !== vm.id || raw.owner_user_id !== String(vm.owner_user_id ?? '')) return null
    if (raw.credential_updated_at !== (summarizeAntigravitySlot(projectRoot, vm).updated_at ?? null)) return null
    if (!Number.isFinite(Date.parse(raw.updated_at))) return null
    const models = Array.isArray(raw.models) ? raw.models : []
    const valid = models.every(
      (row) =>
        row &&
        antigravityModelId(row.id) === row.id &&
        typeof row.display_name === 'string' &&
        row.display_name.length <= 240 &&
        !/[\x00-\x1f\x7f]/.test(row.display_name),
    )
    if (!models.length || models.length > 512 || !valid) return null
    return {
      version: 1,
      updated_at: raw.updated_at,
      models: models.map((row) => ({
        id: row.id,
        display_name: row.display_name,
        vendor: modelVendor(row.id),
        enabled: row.enabled !== false,
      })),
    }
  } catch {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** `model` is the upstream variant (`gemini-4-argon-high`) the slot's account must list. */
export function slotAntigravitySupportsModel(projectRoot, vm, model) {
  const id = antigravityModelId(model)
  return (
    !!id && !!readAntigravityModelCatalog(projectRoot, vm)?.models.some((entry) => entry.id === id && entry.enabled)
  )
}

/** Slot catalog grouped by base model for display and allowlists. */
export function foldAntigravityModelCatalog(catalog) {
  return catalog ? { ...catalog, models: normalizeAntigravityModels(catalog.models) } : null
}

function writeCatalog(root, vm, models) {
  const file = catalogPath(root, vm, true)
  const temporary = `${file}.${crypto.randomBytes(12).toString('hex')}.tmp`
  const value = {
    version: 1,
    vm_id: vm.id,
    owner_user_id: String(vm.owner_user_id ?? ''),
    credential_updated_at: summarizeAntigravitySlot(root, vm).updated_at ?? null,
    updated_at: new Date().toISOString(),
    models,
  }
  try {
    fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, file)
  } finally {
    try {
      fs.unlinkSync(temporary)
    } catch {}
  }
  return { version: 1, updated_at: value.updated_at, models }
}

/**
 * Existing administrator choices win, including disabled models, levels, vendor metadata and
 * token limits. Limits still unset come from models.dev.
 */
export function mergeAntigravityCatalogModels(previous, discovered, limitsFor = modelsDevLimits) {
  const models = normalizeAntigravityModels(previous)
  const known = new Set(models.map((model) => model.id.toLowerCase()))
  for (const model of normalizeAntigravityModels(discovered)) {
    if (!known.has(model.id.toLowerCase())) {
      models.push(model)
      known.add(model.id.toLowerCase())
    }
  }
  return models.map((model) => {
    if (model.context_window && model.max_output_tokens) return model
    const limits = limitsFor(model.id)
    return {
      ...model,
      ...(!model.context_window && limits?.context ? { context_window: limits.context } : {}),
      ...(!model.max_output_tokens && limits?.output ? { max_output_tokens: limits.output } : {}),
    }
  })
}

export async function syncAntigravityModels({ projectRoot, vm, routing = {}, ops = {} } = {}) {
  const support = antigravityRuntimeSupport(vm)
  if (!support.ok) return failure(support.code, support.message, support.status)
  const key = `${path.resolve(projectRoot)}:${vm.id}`
  if (active.has(key)) return active.get(key)
  const operation = (async () => {
    try {
      const credentialUpdatedAt = summarizeAntigravitySlot(projectRoot, vm).updated_at ?? null
      const cli = normalizeAntigravityRouting(routing.antigravity).cli_bin
      const [command, ...argv] = antigravityAuthVerifyArgv(vm, cli)
      // Guest timeout bounds the actual official process even if docker exec is interrupted.
      const result = await (ops.execFile || execFileAsync)(command, argv, {
        timeout: 20_000,
        maxBuffer: MAX_BYTES,
        killSignal: 'SIGKILL',
      })
      const models = parseAntigravityModels(result.stdout)
      if (!models)
        return failure('antigravity_models_invalid', '官方客户端未返回有效模型目录，请确认账号授权和槽位网络。')
      const currentVm = ops.getVm ? ops.getVm() : vm
      if (!currentVm) return failure('vm_not_found', '槽位已删除。', 404)
      if (String(currentVm.owner_user_id ?? '') !== String(vm.owner_user_id ?? ''))
        return failure('antigravity_owner_changed', '槽位所属用户已变更，请重新同步。', 409)
      if ((summarizeAntigravitySlot(projectRoot, currentVm).updated_at ?? null) !== credentialUpdatedAt)
        return failure('antigravity_account_changed', '槽位账号已变更，请重新同步模型目录。', 409)
      return { ok: true, ...writeCatalog(projectRoot, currentVm, models) }
    } catch {
      // No raw CLI output, stderr, command exceptions, auth codes or tokens reach the panel/logs.
      return failure('antigravity_models_unavailable', '无法读取官方模型目录，请确认槽位运行、账号已授权及出口可用。')
    }
  })()
  active.set(key, operation)
  try {
    return await operation
  } finally {
    active.delete(key)
  }
}
