/**
 * First-install onboarding: step booleans + per-user status.
 * Copy and URLs stay in the panel; this module only returns ids / done flags.
 */
import { normalizePanelRole } from './panel-acl.mjs'
import { verifyPassword } from './panel-users.mjs'

export const ONBOARDING_STATE_KEY = 'onboarding_state'
export const MASTER_ONBOARDING_USER = '__master__'
/** docker-entrypoint writes this when VM2API_ADMIN_PASSWORD is empty. */
export const DEFAULT_ADMIN_PASSWORD = '123456'

export const STEPS_BY_ROLE = Object.freeze({
  admin: Object.freeze(['admin_password', 'egress', 'slot_account', 'schedulable', 'api_key', 'first_request']),
  user: Object.freeze(['egress', 'slot_account', 'schedulable', 'api_key', 'first_request']),
  super: Object.freeze(['schedulable', 'first_request']),
})

export function stepsForRole(role) {
  const r = normalizePanelRole(role)
  return STEPS_BY_ROLE[r] || STEPS_BY_ROLE.user
}

/** Master API key sets panelUser='master'; persist under a dedicated key. */
export function onboardingUserOf(req) {
  if (req?.apiKeyKind === 'master') return MASTER_ONBOARDING_USER
  const user = String(req?.panelUser || '').trim()
  return user || MASTER_ONBOARDING_USER
}

export function onboardingRoleOf(req) {
  if (req?.apiKeyKind === 'master') return 'admin'
  return normalizePanelRole(req?.panelRole)
}

export function panelBaseUrl(raw) {
  if (raw == null) return null
  const s = String(raw).trim().replace(/\/+$/, '')
  return s || null
}

export function isDefaultEnvAdminPassword(password) {
  return String(password ?? '') === DEFAULT_ADMIN_PASSWORD
}

export function adminPasswordDone({ envPassword, envAdmin } = {}) {
  return envAdmin
    ? !verifyPassword(DEFAULT_ADMIN_PASSWORD, envAdmin.password_hash)
    : !isDefaultEnvAdminPassword(envPassword)
}

export function vmStepFacts(vms = []) {
  const list = Array.isArray(vms) ? vms : []
  return {
    vmWithTokenCount: list.filter((v) => v.has_token).length,
    schedulableCount: list.filter((v) => v.has_token && v.schedulable !== false).length,
  }
}

export function isStepDone(id, facts = {}) {
  switch (id) {
    case 'admin_password':
      return adminPasswordDone(facts)
    case 'egress':
      return Number(facts.proxyCount) >= 1
    case 'slot_account':
      return Number(facts.vmWithTokenCount) >= 1
    case 'schedulable':
      return Number(facts.schedulableCount) >= 1
    case 'api_key':
      return Number(facts.activeKeyCount) >= 1
    case 'first_request':
      return !!facts.hasFirstRequest
    default:
      return false
  }
}

/** Absent `guide_used` is unused, including records written before this flag existed. */
export function needsWelcome(guideUsed) {
  return guideUsed !== true
}

export function buildOnboardingPayload({
  user,
  role,
  status = 'pending',
  updated_at = null,
  base_url = null,
  profile = null,
  guide_used = false,
  facts = {},
} = {}) {
  const r = normalizePanelRole(role)
  const st = status === 'completed' || status === 'dismissed' ? status : 'pending'
  const steps = stepsForRole(r).map((id) => ({ id, done: isStepDone(id, facts) }))
  const done_count = steps.filter((s) => s.done).length
  const total = steps.length
  const chosen = profile === 'personal' || profile === 'relay' ? profile : null
  const used = guide_used === true
  return {
    user,
    role: r,
    status: st,
    updated_at: updated_at || null,
    needs_welcome: needsWelcome(used),
    base_url: panelBaseUrl(base_url),
    profile: chosen,
    guide_used: used,
    steps,
    done_count,
    total,
  }
}

export async function loadOnboardingState(settings) {
  const raw = await settings?.get?.(ONBOARDING_STATE_KEY, {})
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return raw
}

export async function saveOnboardingState(settings, map) {
  await settings.set(ONBOARDING_STATE_KEY, map && typeof map === 'object' ? map : {})
  return map
}

function chosenProfile(value) {
  return value === 'personal' || value === 'relay' ? value : null
}

function usedFlag(value) {
  return value === true
}

export function recordOf(state, username) {
  const rec = state?.[username]
  const profile = chosenProfile(rec?.profile)
  const guide_used = usedFlag(rec?.guide_used)
  if (!rec || typeof rec !== 'object') return { status: 'pending', updated_at: null, profile: null, guide_used: false }
  const status = rec.status
  if (status === 'completed' || status === 'dismissed' || status === 'pending') {
    return { status, updated_at: rec.updated_at || null, profile, guide_used }
  }
  return { status: 'pending', updated_at: rec.updated_at || null, profile, guide_used }
}

function statusRecord(state, username, status, now, guide_used) {
  const prev = recordOf(state, username)
  const rec = { status, updated_at: now, guide_used }
  if (prev.profile) rec.profile = prev.profile
  return rec
}

export function applyOnboardingAction(state, username, action, now = new Date().toISOString()) {
  const key = String(username || '')
  const next = { ...(state && typeof state === 'object' && !Array.isArray(state) ? state : {}) }
  switch (action) {
    case 'complete':
      next[key] = statusRecord(next, key, 'completed', now, true)
      return next
    case 'dismiss':
      next[key] = statusRecord(next, key, 'dismissed', now, true)
      return next
    case 'reset':
      delete next[key]
      return next
    default: {
      const err = new Error('action 必须是 complete、dismiss 或 reset')
      err.code = 'invalid_action'
      throw err
    }
  }
}

export function setOnboardingProfile(state, username, mode, now = new Date().toISOString()) {
  const profile = chosenProfile(mode)
  if (!profile) {
    const err = new Error('mode 必须是 personal 或 relay')
    err.code = 'invalid_profile'
    throw err
  }
  const key = String(username || '')
  const next = { ...(state && typeof state === 'object' && !Array.isArray(state) ? state : {}) }
  const prev = recordOf(next, key)
  const rec = { status: prev.status, updated_at: now, profile }
  if (prev.guide_used) rec.guide_used = true
  next[key] = rec
  return next
}
