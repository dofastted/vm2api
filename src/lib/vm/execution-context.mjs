/**
 * Slot execution metadata.
 * Inference never uses process-global cfg.vm. The pool scheduler builds a
 * per-attempt candidate from the scheduled VM record: paths, OAuth snapshot,
 * proxy, quota account.
 *
 * Runtime: one Docker container + one long-lived Go slot worker per VM.
 */
import path from 'node:path'
import { boundProxyUrl, hasBoundExit, isLocalEgressProxy } from './egress.mjs'
import { getVm, listVms, getActiveVmId, isVmScheduleReady } from './vm-registry.mjs'
import { proxyBlockedReason } from './proxy-policy.mjs'

export const GATEWAY_CAPABILITIES = {
  runtime: 'docker-container',
  kernel: 'mixed-os-docker',
  worker: 'go-slot-worker',
  client_tools: true,
  images: true,
  multi_turn_native: true,
  sticky: 'vm-account',
  claude_session: false,
  workspace_default: 'client',
  tool_execution: 'client',
  forward_default: 'relay',
  stream_delivery_default: 'realtime',
  stream_delivery_optional: 'verified',
}

export function vmJsonPath(projectRoot, vmId) {
  return path.join(projectRoot, 'vms', `${vmId}.json`)
}

export function vmCliHomePath(projectRoot, vmId) {
  return path.join(projectRoot, 'vms', vmId || 'default', 'cli-home')
}

export function resolveVmProxyUrl(vm) {
  if (!vm?.proxy_cli_enabled) return null
  const p = vm.proxy
  if (!p) return null
  if (isLocalEgressProxy(p)) return ''
  return boundProxyUrl(p) || null
}

export function pickSchedulableVmId(projectRoot, preferredId = null) {
  const seen = new Set()
  const order = []
  const push = (id) => {
    if (!id || seen.has(id)) return
    seen.add(id)
    order.push(id)
  }
  push(preferredId)
  push(getActiveVmId(projectRoot))
  for (const s of listVms(projectRoot)) push(s.id)
  for (const id of order) {
    const vm = getVm(projectRoot, id)
    if (!vm) continue
    if (!isVmScheduleReady(vm)) continue
    if (!vm.proxy_cli_enabled || !hasBoundExit(vm.proxy)) continue
    if (proxyBlockedReason(vm.proxy)) continue
    return id
  }
  return null
}

export function snapshotOauth(vm) {
  const c = vm?.claude || {}
  return {
    has_access: !!(c.has_access || c.access_token),
    has_refresh: !!(c.has_refresh || c.refresh_token),
    expires_at: c.expires_at || null,
    email: c.email || null,
    account_uuid: c.account_uuid || null,
    org_uuid: c.org_uuid || null,
    refresh_error: c.refresh_error || null,
  }
}
