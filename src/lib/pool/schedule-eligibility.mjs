/**
 * Single schedulability gate shared by the pool picker and the panel.
 * Green on the console must mean the scheduler will actually select the slot.
 */
import { hasBoundExit, isLocalEgressProxy } from '../vm/egress.mjs'
import { isVmScheduleReady, vmHasClaudeCredential, isCodexVm } from '../vm/vm-registry.mjs'
import { expiresAtToMs, hasRefreshPresence } from '../oauth/oauth-credentials.mjs'
import { rustKernelBusy } from '../transport/rust-kernel-client.mjs'

// Only a dead grant / operator disable should keep the slot out of the pool.
// Stale access 401 (`authentication_failed_after_refresh`) is not fatal when
// a refresh token still exists — the worker must be allowed to rotate and retry.
export const AUTH_COOLDOWN_REASON = /authentication_failed_after_refresh|permission_denied/i
const FATAL_CREDENTIAL_COOLDOWN =
  /oauth_invalid_grant|invalid_grant|refresh_token_missing|organization_disabled|oauth_revoked|token has been revoked/i
/** Panel test / loadtest probes are not grant-death. Stale access 401 must not eject a live ticket. */
export const TEST_PROBE_SOURCES = new Set(['test-chat', 'kin-console-test', 'kin-console-loadtest'])

export function isTestProbeSource(probe = null, source = null) {
  return TEST_PROBE_SOURCES.has(String(probe?.source || source || ''))
}

export function isAuthCooldownReason(reason) {
  return AUTH_COOLDOWN_REASON.test(String(reason || ''))
}
const REFRESH_FAILURE =
  /credential_refresh_failed|oauth_refresh|refresh_token_missing|invalid_grant|token has been revoked/i
const GRANT_REVOKED = /access token has been revoked|token has been revoked|oauth_revoked/i

export function isRefreshFailure(workerStatus) {
  if (String(workerStatus?.last_error_class || workerStatus?.refresh_class || '').toLowerCase() === 'retryable')
    return false
  const err = String(workerStatus?.last_error || workerStatus?.error || workerStatus?.code || '')
  return REFRESH_FAILURE.test(err)
}

export function isLiveDiskGrant(vm = {}, extras = {}) {
  const refreshError = extras.refresh_error ?? vm.refresh_error ?? vm.claude?.refresh_error ?? null
  const reason = extras.schedule_disabled_reason ?? vm.schedule_disabled_reason ?? null
  const blob = `${refreshError || ''} ${reason || ''}`
  if (GRANT_REVOKED.test(blob) || /oauth_invalid_grant|invalid_grant/i.test(blob)) return false
  return !!(
    extras.has_token ||
    extras.has_refresh ||
    vm.has_token ||
    vm.has_access ||
    vm.has_refresh ||
    vm.claude?.has_access ||
    vm.claude?.has_refresh
  )
}

/** Runtime grant-death cache that no longer matches a live vm.json ticket. */
export function isLeftoverGrantRevokeRuntime(state, vm = {}, extras = {}) {
  if (!state || !isLiveDiskGrant(vm, extras)) return false
  const reason = String(state.cooldown_reason || '')
  return GRANT_REVOKED.test(reason) || FATAL_CREDENTIAL_COOLDOWN.test(reason)
}

export function viewRuntimeWithoutLeftoverRevoke(state, vm = {}, extras = {}) {
  if (!isLeftoverGrantRevokeRuntime(state, vm, extras)) return state
  return {
    ...state,
    status: 'ready',
    cooldown_until: null,
    cooldown_reason: null,
  }
}

export function isCredentialRuntimeBlocked(state, now = Date.now(), vm = null) {
  if (!state) return false
  if (vm && isLeftoverGrantRevokeRuntime(state, vm)) return false
  if (String(state.status || '') === 'disabled') return true
  const until = Number(state.cooldown_until) || 0
  if (until > now && FATAL_CREDENTIAL_COOLDOWN.test(String(state.cooldown_reason || ''))) return true
  return false
}

export function slotHasBoundProxy(vm) {
  if (!vm?.proxy_cli_enabled || !vm?.proxy) return false
  return hasBoundExit(vm.proxy)
}

export function evaluateSlotGate(vm) {
  if (isCodexVm(vm)) return { ok: false, reason: 'codex_vm' }
  const oauthProjection = /^oauth_/.test(String(vm?.schedule_disabled_reason || ''))
  if (!isVmScheduleReady(vm, { allowMissingCredential: oauthProjection })) {
    if (!oauthProjection) return { ok: false, reason: 'vm_unschedulable' }
  }
  if (!vmHasClaudeCredential(vm) && !oauthProjection) return { ok: false, reason: 'no_credential' }
  if (!slotHasBoundProxy(vm)) return { ok: false, reason: 'proxy_required' }
  return { ok: true }
}

/** Unknown means the caller did not read worker.json. null/'' means it is empty. */
export const WORKER_PROXY_UNKNOWN = undefined

export function evaluateProxySync({ vm, workerProxyEndpoint = WORKER_PROXY_UNKNOWN, egressMode = '' } = {}) {
  if (isLocalEgressProxy(vm?.proxy)) return { ok: true }
  if (String(egressMode || '').trim() === 'transparent') return { ok: true }
  const wantHost = vm?.proxy?.host
  const wantPort = vm?.proxy?.port
  let want = null
  if (wantHost && wantPort) want = `${wantHost}:${Number(wantPort)}`
  else {
    const url = String(vm?.proxy?.url || '')
    const m = url.match(/^[a-z0-9+.-]+:\/\/(?:[^/@]+@)?([^:/?#]+):(\d+)/i)
    if (m) want = `${m[1]}:${Number(m[2])}`
  }
  if (!want) return { ok: true }
  if (workerProxyEndpoint === WORKER_PROXY_UNKNOWN) return { ok: true }
  if (!workerProxyEndpoint) return { ok: false, reason: 'worker_proxy_missing' }
  if (String(want) !== String(workerProxyEndpoint)) {
    return { ok: false, reason: 'proxy_desynced' }
  }
  return { ok: true }
}

function accessTtlMs(expiresAt, workerCred = {}) {
  return expiresAtToMs(expiresAt) || expiresAtToMs(workerCred?.expires_at)
}

export function probeOlderThanRefresh(extras = {}, quota = {}) {
  const probeAt = Date.parse(
    extras.last_probe?.at || extras.fable?.probed_at || quota.last_probe?.at || quota.fable?.probed_at || '',
  )
  const refreshedAt = Date.parse(extras.refreshed_at || extras.oauth_refreshed_at || '')
  return Number.isFinite(probeAt) && Number.isFinite(refreshedAt) && probeAt < refreshedAt
}

export function isGrantRevoked(extras = {}, quota = {}) {
  const liveDisk = isLiveDiskGrant(extras.vm || {}, extras)
  const staleProbe = probeOlderThanRefresh(extras, quota)
  const testProbe = isTestProbeSource(extras.last_probe) || isTestProbeSource(quota.last_probe)
  const bits = [extras.schedule_disabled_reason, extras.refresh_error]
  // Runtime cooldown is a cache of disk grant-death. After login heals vm.json
  // it must not keep painting revoke. Fresh last_probe revoke still counts.
  if (!liveDisk) {
    bits.push(extras.runtime?.cooldown_reason, extras.cooldown_reason)
  }
  if (!staleProbe) {
    if (!testProbe) {
      bits.push(extras.last_probe?.error, extras.last_probe?.message, quota.last_probe?.error)
    }
    bits.push(
      quota.fable?.error,
      extras.fable?.error,
      extras.worker_credential?.last_error,
      extras.runtime?.worker_status?.last_error,
      extras.runtime?.worker_status?.error,
    )
  }
  return GRANT_REVOKED.test(bits.filter(Boolean).join(' '))
}

/** Access is live only when TTL is still in the future and the grant is not revoked. */
export function isLiveAccess({ extras = {}, expiresAt = null, now = Date.now(), requireTtl = false } = {}) {
  if (isGrantRevoked(extras)) return false
  const cred = extras.worker_credential || {}
  const expMs = accessTtlMs(expiresAt, cred)
  if (requireTtl && !expMs) return false
  if (expMs && expMs <= now) return false
  if (cred.needs_refresh === true && (!expMs || expMs <= now)) return false
  return !!(extras.has_token || cred.has_access)
}

export function evaluateCredentialEligibility({ vm, workerStatus = null, now = Date.now() } = {}) {
  const cred = workerStatus?.credential || {}
  const vmCredential = vmHasClaudeCredential(vm)
  const workerCredential = !!(cred.has_access || cred.has_refresh)
  if (!vmCredential && !workerCredential) return { ok: false, reason: 'no_credential' }
  const expMs = accessTtlMs(vm?.claude?.expires_at, cred)
  const refreshPresent = hasRefreshPresence(vm?.claude) || !!cred.has_refresh
  const accessFresh = !!(cred.has_access && cred.needs_refresh !== true && expMs && expMs > now)
  const workerLive = !!(workerStatus?.ok === true && (accessFresh || refreshPresent))
  // Leftover last_error / refresh_error must not eject a worker that already rotated.
  const leftoverRevoke = isGrantRevoked(
    {
      worker_credential: { last_error: workerStatus?.last_error || workerStatus?.error },
      schedule_disabled_reason: vm?.schedule_disabled_reason,
      refreshed_at: vm?.claude?.refreshed_at || null,
    },
    { fable: { error: vm?.claude?.refresh_error } },
  )
  if (leftoverRevoke && !accessFresh && !workerLive) {
    return { ok: false, reason: 'oauth_revoked' }
  }
  if (!workerLive && (isRefreshFailure(workerStatus) || isRefreshFailure({ last_error: vm?.claude?.refresh_error }))) {
    return { ok: false, reason: 'oauth_invalid_grant' }
  }
  if (expMs && expMs <= now && !refreshPresent) {
    return { ok: false, reason: 'oauth_expired' }
  }
  if (!expMs && workerStatus && !cred.has_access && !refreshPresent) {
    return { ok: false, reason: 'oauth_unconfirmed' }
  }
  if (rustKernelBusy(workerStatus)) {
    return { ok: true, reason: 'slot_busy' }
  }
  if (workerStatus && workerStatus.ok !== true && !refreshPresent) {
    return { ok: false, reason: 'worker_unhealthy' }
  }
  if (expMs && expMs <= now && refreshPresent) {
    return { ok: true, reason: 'refresh_pending' }
  }
  return { ok: true }
}

export function hasLivePanelCredential(extras = {}, expiresAt = null, now = Date.now()) {
  return isLiveAccess({ extras, expiresAt, now })
}

/** True only when the slot really has no refresh — not just a stripped vm.json. */
export function shouldMarkMissingRefresh(vm) {
  return !hasRefreshPresence(vm?.claude)
}
export function credPanelUnavailable(extras = {}, expiresAt = null, now = Date.now()) {
  if (isGrantRevoked(extras)) return true
  const expMs = accessTtlMs(expiresAt, extras.worker_credential)
  const refreshPresent = !!(extras.has_refresh || extras.worker_credential?.has_refresh)
  if (expMs && expMs <= now && !refreshPresent) return true
  const reason = String(extras.schedule_disabled_reason || '')
  const err = String(
    extras.worker_credential?.last_error ||
      extras.runtime?.worker_status?.last_error ||
      extras.runtime?.worker_status?.error ||
      '',
  )
  const fatalGrant = /oauth_invalid_grant|invalid_grant|refresh_token_missing|refresh token not found/i.test(
    `${reason} ${err}`,
  )
  if (fatalGrant && !isLiveAccess({ extras, expiresAt, now, requireTtl: true })) return true
  if (/^oauth_/.test(reason) && !fatalGrant) {
    const leftover = reason === 'oauth_cleared' || reason === 'oauth_no_refresh'
    const live =
      isLiveAccess({ extras, expiresAt, now }) ||
      !!(leftover && (extras.has_token || refreshPresent || extras.worker_credential?.has_access))
    if (!live) return true
  }
  if (isCredentialRuntimeBlocked(extras.runtime || extras.state, now)) return true
  return false
}
