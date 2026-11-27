/**
 * Control-plane SSOT for Gemini slot scheduling preferences:
 *   - schedulable: operator toggle (default true)
 *   - schedule_level: manual priority 1..10, or null for auto (resolves to 5)
 *   - display_name: optional panel display-name override (<= 80 chars)
 *   - unschedulable: persisted deterministic fault state (aligned with Codex four-state model),
 *     distinct from operator `schedulable: false` (`off`) so toggling or recovering stays clean.
 *
 * Persisted under SettingsRepo key `gemini_slot_prefs` (works on SQLite & PostgreSQL
 * without schema migrations). Falls back to an in-memory store when no repo is supplied.
 */

export const GEMINI_SLOT_PREFS_KEY = 'gemini_slot_prefs'
export const DEFAULT_GEMINI_SCHEDULE_LEVEL = 5

const UNSCHEDULABLE_REASON_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

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

function sanitizeUnschedulable(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const reason = typeof raw.reason === 'string' ? raw.reason.trim().toLowerCase() : ''
  if (!UNSCHEDULABLE_REASON_RE.test(reason)) return null
  const detail = typeof raw.detail === 'string' && raw.detail.trim() ? raw.detail.trim().slice(0, 240) : ''
  const at = typeof raw.at === 'string' && raw.at.trim() ? raw.at.trim().slice(0, 64) : new Date().toISOString()
  const out = { reason, at }
  if (detail) out.detail = detail
  if (Number.isSafeInteger(raw.upstream_status) && raw.upstream_status >= 100 && raw.upstream_status <= 599) {
    out.upstream_status = raw.upstream_status
  }
  if (typeof raw.error_code === 'string' && UNSCHEDULABLE_REASON_RE.test(raw.error_code.trim().toLowerCase())) {
    out.error_code = raw.error_code.trim().toLowerCase()
  }
  return out
}

function sanitizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  if (raw.schedulable === false) out.schedulable = false
  const lvl = parseGeminiScheduleLevel(raw.schedule_level)
  if (lvl.ok && lvl.value != null) out.schedule_level = lvl.value
  const name = parseGeminiDisplayName(raw.display_name)
  if (name.ok && name.value != null) out.display_name = name.value
  const unsched = sanitizeUnschedulable(raw.unschedulable)
  if (unsched) out.unschedulable = unsched
  return out
}

export function createGeminiSlotPrefs({ settingsRepo = null, now = () => Date.now() } = {}) {
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
    if (!envId) return { schedulable: true, schedule_level: null, display_name: null, unschedulable: null }
    const raw = sanitizeEntry(readAll()[envId])
    return {
      schedulable: raw.schedulable !== false,
      schedule_level: raw.schedule_level ?? null,
      display_name: raw.display_name ?? null,
      unschedulable: raw.unschedulable ?? null,
    }
  }

  function resolved(envId) {
    const raw = get(envId)
    return {
      schedulable: raw.schedulable,
      schedule_level: raw.schedule_level ?? DEFAULT_GEMINI_SCHEDULE_LEVEL,
      schedule_level_mode: raw.schedule_level != null ? 'manual' : 'auto',
      display_name: raw.display_name,
      unschedulable: raw.unschedulable,
      unschedulable_reason: raw.unschedulable?.reason ?? null,
      unschedulable_detail: raw.unschedulable?.detail ?? null,
      unschedulable_at: raw.unschedulable?.at ?? null,
    }
  }

  function patch(envId, update = {}) {
    if (!envId) return resolved(envId)
    const store = readAll()
    const current = sanitizeEntry(store[envId])
    if (Object.hasOwn(update, 'schedulable')) {
      if (update.schedulable === false) {
        current.schedulable = false
      } else {
        delete current.schedulable
        // Explicit operator re-enable clears system unschedulable state (mirrors Codex schedule-state).
        delete current.unschedulable
      }
    }
    if (Object.hasOwn(update, 'unschedulable')) {
      if (update.unschedulable == null) {
        delete current.unschedulable
      } else {
        const sanitized = sanitizeUnschedulable({
          at: new Date(now()).toISOString(),
          ...update.unschedulable,
        })
        if (sanitized) current.unschedulable = sanitized
        else delete current.unschedulable
      }
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

  function markUnschedulable(envId, reason, detail = '', extra = {}) {
    if (!envId) return resolved(envId)
    return patch(envId, {
      unschedulable: {
        reason: String(reason || 'upstream_502'),
        detail: typeof detail === 'string' ? detail : '',
        at: new Date(now()).toISOString(),
        ...extra,
      },
    })
  }

  function clearUnschedulable(envId) {
    if (!envId) return resolved(envId)
    const store = readAll()
    const current = sanitizeEntry(store[envId])
    if (!current.unschedulable) return resolved(envId)
    delete current.unschedulable
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
    markUnschedulable,
    clearUnschedulable,
    remove,
  }
}
