/** Official CLI IDs come from CLAUDE_CONFIG_DIR when configured; slot-generated UUIDs never replace them. */
import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson, listVmRecordFiles } from '../vm/vm-file.mjs'

export const OFFICIAL_IDENTITY_SOURCE = 'official-cc-init'

const STALE_FP_KEYS = Object.freeze(['machineID', 'userID', 'machineId', 'userId'])

// Current CLI writes only userID; older inits also wrote machineID. Prefer a doc carrying both.
function readClaudeIdentityDocument(homeDir) {
  let userOnly = null
  for (const file of [path.join(homeDir, '.claude.json'), path.join(homeDir, '.claude', '.claude.json')]) {
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!doc?.userID) continue
      if (doc.machineID) return doc
      userOnly ??= doc
    } catch {}
  }
  return userOnly || {}
}

export function readOfficialCcIdentity(homeDir) {
  const doc = readClaudeIdentityDocument(homeDir)
  const account = doc.oauthAccount && typeof doc.oauthAccount === 'object' ? doc.oauthAccount : {}
  const billing = account.billingType || account.subscriptionType || account.seatTier || null
  return {
    user_id: doc.userID || null,
    machine_id: doc.machineID || null,
    account_uuid: account.accountUuid || account.uuid || null,
    org_uuid: account.organizationUuid || account.orgUuid || null,
    email: account.emailAddress || account.email || null,
    billing_type: account.billingType || null,
    subscription_type: billing,
    display_name: account.displayName || null,
  }
}

export function reconcileFingerprint(prev = {}, official = {}) {
  const next = { ...(prev && typeof prev === 'object' ? prev : {}) }
  for (const key of STALE_FP_KEYS) delete next[key]
  const machine = official.machine_id || official.machineID || null
  const user = official.user_id || official.userID || null
  if (machine) {
    next.device_id = machine
    next.official_machine_id = machine
    if (next.machine_id && next.machine_id !== machine) {
      next.guest_machine_id = next.guest_machine_id || next.machine_id
      delete next.machine_id
    }
  }
  if (user) next.official_user_id = user
  if (official.account_uuid) next.official_account_uuid = official.account_uuid
  if (machine || user) next.identity_source = OFFICIAL_IDENTITY_SOURCE
  next.reconciled_at = new Date().toISOString()
  return next
}

export function discardLeftoverClaudeJson(homeDir) {
  const nested = path.join(homeDir, '.claude', '.claude.json')
  if (!fs.existsSync(nested)) return { removed: false, conflict: false }
  let doc = {}
  let canonical = {}
  try {
    doc = JSON.parse(fs.readFileSync(nested, 'utf8'))
  } catch {}
  try {
    canonical = JSON.parse(fs.readFileSync(path.join(homeDir, '.claude.json'), 'utf8'))
  } catch {}
  return {
    removed: false,
    conflict: !!(
      (canonical.machineID && doc.machineID && canonical.machineID !== doc.machineID) ||
      (canonical.userID && doc.userID && canonical.userID !== doc.userID)
    ),
  }
}

export function applyOfficialFingerprintToVm(vmPath, homeDir) {
  const official = readOfficialCcIdentity(homeDir)
  const leftover = discardLeftoverClaudeJson(homeDir)
  if (!vmPath || !fs.existsSync(vmPath)) {
    return { wrote: false, official: !!(official.machine_id || official.user_id), leftover }
  }
  const vm = JSON.parse(fs.readFileSync(vmPath, 'utf8'))
  const prev = vm.fingerprint && typeof vm.fingerprint === 'object' ? vm.fingerprint : {}
  const next = official.machine_id || official.user_id ? reconcileFingerprint(prev, official) : prev
  const identityPath = path.join(homeDir, '.claude', 'kin-identity.json')
  let identityWrote = false
  if (fs.existsSync(identityPath) && official.machine_id) {
    try {
      const ident = JSON.parse(fs.readFileSync(identityPath, 'utf8'))
      if (ident.device_id !== official.machine_id) {
        ident.device_id = official.machine_id
        if (official.user_id) ident.user_id = official.user_id
        if (official.account_uuid) ident.account_uuid = official.account_uuid
        ident.source = OFFICIAL_IDENTITY_SOURCE
        ident.written_at = new Date().toISOString()
        atomicWriteJson(identityPath, ident)
        identityWrote = true
      }
    } catch {}
  }
  const changed =
    JSON.stringify({
      device_id: prev.device_id,
      official_machine_id: prev.official_machine_id,
      official_user_id: prev.official_user_id,
      machine_id: prev.machine_id,
      identity_source: prev.identity_source,
    }) !==
    JSON.stringify({
      device_id: next.device_id,
      official_machine_id: next.official_machine_id,
      official_user_id: next.official_user_id,
      machine_id: next.machine_id,
      identity_source: next.identity_source,
    })
  if (!changed && !leftover.removed && !identityWrote) {
    return { wrote: false, official: !!(official.machine_id || official.user_id), leftover }
  }
  if (changed) {
    vm.fingerprint = next
    vm.updated_at = new Date().toISOString()
    atomicWriteJson(vmPath, vm, { mode: 0o600 })
  }
  return {
    wrote: changed || leftover.removed || identityWrote,
    official: !!(official.machine_id || official.user_id),
    leftover,
    replaced_device: !!(official.machine_id && prev.device_id && prev.device_id !== official.machine_id),
  }
}

export function reconcileOfficialFingerprints(projectRoot, { ids } = {}) {
  const vmsDir = path.join(projectRoot, 'vms')
  const summary = { scanned: 0, reconciled: 0, leftover_removed: 0, replaced_device: 0, skipped: 0 }
  if (!fs.existsSync(vmsDir)) return summary
  const wanted = ids ? new Set(ids) : null
  for (const name of listVmRecordFiles(vmsDir)) {
    const vmId = name.slice(0, -5)
    if (wanted && !wanted.has(vmId)) continue
    const vmPath = path.join(vmsDir, name)
    const homeDir = path.join(vmsDir, vmId, 'cli-home')
    summary.scanned += 1
    const result = applyOfficialFingerprintToVm(vmPath, homeDir)
    if (result.leftover?.removed) summary.leftover_removed += 1
    if (result.replaced_device) summary.replaced_device += 1
    if (result.wrote) summary.reconciled += 1
    else summary.skipped += 1
  }
  return summary
}
