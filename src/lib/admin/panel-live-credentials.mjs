import { isClaudeVm } from '../vm/vm-kind.mjs'
/**
 * Live credential view for the panel.
 * Go worker is the refresh owner; vm.json / SQLite runtime can lag for hours
 * on idle slots. Dashboard/list/detail read the slot file + /internal/health
 * and never send tokens to the console.
 */
import { expiresAtToMs, mirrorWorkerCredentialsToVm, readSlotCredentialIdentity } from '../oauth/oauth-credentials.mjs'
import { rustKernelHealth } from '../transport/rust-kernel-client.mjs'
import { vmJsonPath } from '../vm/execution-context.mjs'
import { slotExec } from '../vm/slot-runtime.mjs'
import { CREDENTIAL_REFRESH_FAIL } from '../pool/availability.mjs'

export const LIVE_CREDENTIAL_SKEW_MS = 5 * 60 * 1000
export const LIVE_CREDENTIAL_CACHE_MS = 3000
const MIRROR_NEWER_MS = 2000

let cache = { at: 0, map: null }

export function invalidateLiveCredentialCache() {
  cache = { at: 0, map: null }
}

function mapPool(items, concurrency, fn) {
  const out = new Array(items.length)
  let cursor = 0
  const n = Math.max(1, Math.min(Number(concurrency) || 1, items.length || 1))
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++
      out[index] = await fn(items[index], index)
    }
  }
  return Promise.all(Array.from({ length: Math.min(n, items.length || 1) }, () => worker())).then(() => out)
}

function healthUsable(health) {
  return !!(
    health &&
    !health.transportError &&
    health.code !== 'worker_unavailable' &&
    (health.credential || health.ok === true)
  )
}

export function publicLiveCredential(health = null, fileIdentity = null, now = Date.now()) {
  const cred = healthUsable(health) ? health.credential || {} : {}
  const fileMs = expiresAtToMs(fileIdentity?.expires_at)
  const healthMs = expiresAtToMs(cred.expires_at)
  const expMs = Math.max(fileMs, healthMs)
  const hasAccess = !!(cred.has_access || fileIdentity?.has_access)
  const hasRefresh = !!(cred.has_refresh || fileIdentity?.has_refresh)
  const ttlSeconds = expMs
    ? Math.round((expMs - now) / 1000)
    : Number.isFinite(Number(cred.ttl_seconds))
      ? Number(cred.ttl_seconds)
      : null
  const needsRefresh = expMs ? expMs - now <= LIVE_CREDENTIAL_SKEW_MS : !!cred.needs_refresh
  let state = 'missing'
  if (hasRefresh && !hasAccess) state = 'refreshable'
  else if (expMs && expMs <= now) state = hasRefresh ? 'expired_refreshable' : 'expired'
  else if (needsRefresh && hasAccess) state = 'refresh_window'
  else if (hasAccess) state = 'fresh'
  const liveHealth = healthUsable(health)
  let lastError = liveHealth
    ? health.last_error || (typeof health.error === 'string' ? health.error : health.error?.message) || null
    : null
  let lastErrorClass = liveHealth ? health.last_error_class || null : null
  // A successful rotation leaves the previous invalid_grant on /internal/health
  // until the next Ensure. Fresh TTL must not keep painting 无效凭证.
  if (state === 'fresh' && CREDENTIAL_REFRESH_FAIL.test(String(lastError || ''))) {
    lastError = null
    lastErrorClass = null
  }
  return {
    has_access: hasAccess,
    has_refresh: hasRefresh,
    needs_refresh: needsRefresh,
    credential_state: state,
    expires_at: expMs || null,
    ttl_seconds: ttlSeconds,
    generation: cred.generation || fileIdentity?.generation || null,
    last_error_class: lastErrorClass,
    last_error: lastError,
    source: liveHealth && healthMs >= fileMs ? 'worker-health' : fileIdentity ? 'slot-credentials' : null,
    observed_at: now,
  }
}

function shouldMirror(vm, live) {
  const vmMs = expiresAtToMs(vm?.expires_at || vm?.claude?.expires_at)
  const liveMs = expiresAtToMs(live?.expires_at)
  return !!(liveMs && liveMs > (vmMs || 0) + MIRROR_NEWER_MS && (live.has_access || live.has_refresh))
}

export async function collectLivePanelCredentials(
  projectRoot,
  vms = [],
  { concurrency = 10, timeoutMs = 1200, cacheMs = LIVE_CREDENTIAL_CACHE_MS } = {},
) {
  const now = Date.now()
  if (cache.map && cacheMs > 0 && now - cache.at < cacheMs) return cache.map
  const list = Array.isArray(vms) ? vms.filter((vm) => vm?.id && isClaudeVm(vm)) : []
  const map = new Map()
  await mapPool(list, concurrency, async (vm) => {
    const exec = slotExec(projectRoot, vm)
    if (!exec) return
    const file = readSlotCredentialIdentity(exec.homeDir)
    let health = null
    try {
      health = await rustKernelHealth(exec, { timeoutMs })
    } catch (error) {
      health = { ok: false, code: 'worker_unavailable', error: String(error.message || error) }
    }
    const live = publicLiveCredential(health, file)
    if (!live.has_access && !live.has_refresh && !live.expires_at) return
    map.set(vm.id, live)
    if (shouldMirror(vm, live) && exec.homeDir) {
      try {
        mirrorWorkerCredentialsToVm(vmJsonPath(projectRoot, vm.id), exec.homeDir)
      } catch {}
    }
  })
  cache = { at: Date.now(), map }
  return map
}
