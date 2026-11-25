/**
 * Control-plane SSOT for Gemini slot scheduling preferences:
 *   - schedulable: operator toggle (default true)
 *   - schedule_level: manual priority 1..10, or null for auto (resolves to 5)
 *   - display_name: optional panel display-name override (<= 80 chars)
 *
 * Persisted under SettingsRepo key `gemini_slot_prefs` (works on SQLite & PostgreSQL
 * without schema migrations). Falls back to an in-memory store when no repo is supplied.
 */

export const GEMINI_SLOT_PREFS_KEY = 'gemini_slot_prefs'
export const DEFAULT_GEMINI_SCHEDULE_LEVEL = 5

export function parseGeminiScheduleLevel(value) {
  if (value === null || value === '' || value === 'auto') return { ok: true, value: null }
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value
  if (Number.isSafeInteger(n) && n >= 1 && n <= 10) return { ok: true, value: n }
  return { ok: false, value: null }
}

export function parseGeminiDisplayName(value) {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false, value: null }
  const trimmed = value.trim()
  if (!trimmed) return { ok: true, value: null }
  if (trimmed.length > 80) return { ok: false, value: null }
  return { ok: true, value: trimmed }
}

function sanitizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  if (raw.schedulable === false) out.schedulable = false
  const lvl = parseGeminiScheduleLevel(raw.schedule_level)
  if (lvl.ok && lvl.value != null) out.schedule_level = lvl.value
  const name = parseGeminiDisplayName(raw.display_name)
  if (name.ok && name.value != null) out.display_name = name.value
  return out
}

export function createGeminiSlotPrefs({ settingsRepo = null } = {}) {
  let memoryStore = {}

  function readAll() {
    if (!settingsRepo?.get) return { ...memoryStore }
    try {
      const raw = settingsRepo.get(GEMINI_SLOT_PREFS_KEY, {})
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
      return { ...raw }
    } catch {
      return { ...memoryStore }
    }
  }

  function writeAll(next) {
    memoryStore = { ...next }
    if (settingsRepo?.set) {
      settingsRepo.set(GEMINI_SLOT_PREFS_KEY, next)
    }
  }

  function get(envId) {
    if (!envId) return { schedulable: true, schedule_level: null, display_name: null }
    const raw = sanitizeEntry(readAll()[envId])
    return {
      schedulable: raw.schedulable !== false,
      schedule_level: raw.schedule_level ?? null,
      display_name: raw.display_name ?? null,
    }
  }

  function resolved(envId) {
    const raw = get(envId)
    return {
      schedulable: raw.schedulable,
      schedule_level: raw.schedule_level ?? DEFAULT_GEMINI_SCHEDULE_LEVEL,
      schedule_level_mode: raw.schedule_level != null ? 'manual' : 'auto',
      display_name: raw.display_name,
    }
  }

  function patch(envId, update = {}) {
    if (!envId) return resolved(envId)
    const store = readAll()
    const current = sanitizeEntry(store[envId])
    if (Object.hasOwn(update, 'schedulable')) {
      if (update.schedulable === false) current.schedulable = false
      else delete current.schedulable
    }
    if (Object.hasOwn(update, 'schedule_level')) {
      const parsed = parseGeminiScheduleLevel(update.schedule_level)
      if (!parsed.ok) {
        const err = new Error('调度优先级必须为 1–10 的整数或自动')
        err.code = 'gemini_invalid_schedule_level'
        err.status = 400
        throw err
      }
      if (parsed.value != null) current.schedule_level = parsed.value
      else delete current.schedule_level
    }
    if (Object.hasOwn(update, 'display_name')) {
      const parsed = parseGeminiDisplayName(update.display_name)
      if (!parsed.ok) {
        const err = new Error('环境名称长度不能超过 80 个字符')
        err.code = 'gemini_invalid_name'
        err.status = 400
        throw err
      }
      if (parsed.value != null) current.display_name = parsed.value
      else delete current.display_name
    }
    if (Object.keys(current).length > 0) store[envId] = current
    else delete store[envId]
    writeAll(store)
    return resolved(envId)
  }

  function remove(envId) {
    if (!envId) return
    const store = readAll()
    if (!Object.hasOwn(store, envId)) return
    delete store[envId]
    writeAll(store)
  }

  return {
    get,
    resolved,
    all: readAll,
    patch,
    remove,
  }
}
