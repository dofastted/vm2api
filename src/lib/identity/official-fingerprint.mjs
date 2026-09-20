/**
 * Official Claude Code init userID / machineID is the only device identity.
 * Slot-generated UUIDs never win once official IDs exist.
 *
 * Compose slots set CLAUDE_CONFIG_DIR=/home/kincli/.claude, so the official
 * CLI writes ~/.claude/.claude.json — not ~/.claude.json. Treat that file as
 * the identity source and promote it; only delete it when it conflicts with
 * a canonical ~/.claude.json that already has IDs.
 */
import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson } from '../vm/vm-file.mjs'

export const OFFICIAL_IDENTITY_SOURCE = 'official-cc-init'

const STALE_FP_KEYS = Object.freeze(['machineID', 'userID', 'machineId', 'userId'])

function readClaudeJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

function claudeJsonHasIds(doc) {
  return !!(doc && (doc.userID || doc.machineID))
}

export function readOfficialCcIdentity(homeDir) {
  const canonical = readClaudeJsonFile(path.join(homeDir, '.claude.json'))
  const nested = readClaudeJsonFile(path.join(homeDir, '.claude', '.claude.json'))
  const doc = claudeJsonHasIds(canonical) ? canonical : claudeJsonHasIds(nested) ? nested : canonical
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
  const leftover = path.join(homeDir, '.claude', '.claude.json')
  const canonical = path.join(homeDir, '.claude.json')
  if (!fs.existsSync(leftover)) return { removed: false, conflict: false, promoted: false }
  const leftoverDoc = readClaudeJsonFile(leftover)
  const canonicalDoc = readClaudeJsonFile(canonical)
  const leftoverHas = claudeJsonHasIds(leftoverDoc)
  const canonicalHas = claudeJsonHasIds(canonicalDoc)
  if (leftoverHas && !canonicalHas) {
    try {
      atomicWriteJson(canonical, leftoverDoc, { mode: 0o600 })
    } catch {}
    return { removed: false, conflict: false, promoted: true }
  }
  if (leftoverHas && canonicalHas) {
    const conflict = !!(
      (leftoverDoc.machineID && leftoverDoc.machineID !== canonicalDoc.machineID) ||
      (leftoverDoc.userID && leftoverDoc.userID !== canonicalDoc.userID)
    )
    if (!conflict) return { removed: false, conflict: false, promoted: false }
    try {
      fs.rmSync(leftover, { force: true })
    } catch {}
    return { removed: true, conflict: true, promoted: false }
  }
  try {
    fs.rmSync(leftover, { force: true })
  } catch {}
  return { removed: true, conflict: false, promoted: false }
}

export function applyOfficialFingerprintToVm(vmPath, homeDir) {
  const leftover = discardLeftoverClaudeJson(homeDir)
  const official = readOfficialCcIdentity(homeDir)
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
  if (!changed && !leftover.removed && !leftover.promoted && !identityWrote) {
    return { wrote: false, official: !!(official.machine_id || official.user_id), leftover }
  }
  if (changed) {
    vm.fingerprint = next
    vm.updated_at = new Date().toISOString()
    atomicWriteJson(vmPath, vm, { mode: 0o600 })
  }
  return {
    wrote: changed || leftover.removed || leftover.promoted || identityWrote,
    official: !!(official.machine_id || official.user_id),
    leftover,
    replaced_device: !!(official.machine_id && prev.device_id && prev.device_id !== official.machine_id),
  }
}

export function reconcileOfficialFingerprints(projectRoot) {
  const vmsDir = path.join(projectRoot, 'vms')
  const summary = { scanned: 0, reconciled: 0, leftover_removed: 0, replaced_device: 0, skipped: 0 }
  if (!fs.existsSync(vmsDir)) return summary
  for (const name of fs.readdirSync(vmsDir)) {
    if (!name.startsWith('vm-') || !name.endsWith('.json')) continue
    const vmId = name.slice(0, -5)
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
