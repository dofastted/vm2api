/**
 * "Slot follows its proxy" timezone default.
 *
 * Binding an exit node in Tokyo while the slot still claims America/Los_Angeles
 * is a fingerprint contradiction the upstream can see (`# Environment - Timezone`
 * vs the exit IP). After every bind the slot adopts the proxy's detected zone,
 * unless the operator pinned one by hand (`vm.timezone_source === 'manual'`).
 */
import { validTimezone } from '../core/timezone.mjs'
import { getVm, persistVmTimezone } from './vm-registry.mjs'

/**
 * @param {object} opts
 * @param {boolean} opts.force  apply even over a manually pinned timezone
 * @param {boolean} opts.detect run a geo lookup when the proxy has no location yet
 * @returns {Promise<{ok: boolean, applied: boolean, timezone: string|null, reason: string|null}>}
 */
export async function syncVmTimezoneFromProxy(
  projectRoot,
  proxyPool,
  vmId,
  { force = false, detect = true, proxyId = null } = {},
) {
  const id = String(vmId || '').trim()
  if (!id || !proxyPool) return skip('vm_id_required')
  if (!force && !proxyPool.followProxyTimezoneEnabled()) return skip('follow_proxy_timezone_disabled')
  const vm = getVm(projectRoot, id)
  if (!vm) return skip('vm_not_found')
  if (!force && vm.timezone_source === 'manual') return skip('timezone_pinned')

  const bound = proxyId || vm.proxy?.id || null
  let timezone = bound ? proxyPool.proxyTimezone(bound) : proxyPool.timezoneForVm(id)
  if (!timezone && detect && bound) {
    const detected = await proxyPool.detectGeo(bound)
    if (!detected?.ok) return skip(detected?.error || 'geo_lookup_failed')
    timezone = validTimezone(detected.geo?.timezone)
  }
  if (!timezone) return skip('proxy_timezone_unknown')
  if (vm.timezone === timezone) {
    // Already aligned, but re-stamp the source so the panel stops showing the
    // zone as hand-pinned once the operator opted back into following.
    if (force && vm.timezone_source !== 'proxy_geo') {
      persistVmTimezone(projectRoot, id, timezone, { source: 'proxy_geo' })
    }
    return { ok: true, applied: false, timezone, reason: 'already_current' }
  }
  const summary = persistVmTimezone(projectRoot, id, timezone, { source: 'proxy_geo' })
  if (!summary) return skip('persist_failed')
  return { ok: true, applied: true, timezone, reason: null }
}

function skip(reason) {
  return { ok: false, applied: false, timezone: null, reason }
}
