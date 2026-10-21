/**
 * Factory-reset a slot: keep the registry identity (id / name / kernel /
 * timezone / proxy / seed / concurrency), wipe guest home + credentials,
 * then the caller destroys the container and starts a new one.
 */
import fs from 'node:fs'
import path from 'node:path'
import { validTimezone } from '../core/timezone.mjs'
import { hasBoundExit } from './egress.mjs'
import { atomicWriteJson, invalidateVmSlotReadCache } from './vm-file.mjs'
import { defaultSeedPolicy } from '../protocol/seed-policy.mjs'
import { writeSlotSeedFiles } from './slot-seed.mjs'
import { manualScheduleLevelOf } from '../pool/credential-weight.mjs'
import { activeHoursOf } from '../pool/active-hours.mjs'
import { stampVmKind } from './vm-kind.mjs'
import { materializeWrapCli } from './wrap-cli-runtime.mjs'
import { listVms } from './vm-registry.mjs'
import { slotHost } from './slot-host.mjs'
import {
  applyGeneratedFingerprint,
  generateWorkstationFingerprint,
  takenFingerprintKeys,
  writeGuestMachineIdFile,
} from '../identity/workstation-fingerprint.mjs'
import { assignComputerFingerprint } from '../identity/slot-computer.mjs'

const KEEP_HOME = [
  'cli-home/.claude/credentials.json',
  'cli-home/.claude/credentials.json.lock',
  'cli-home/.claude/.credentials.json',
  'cli-home/.codex/auth.json',
  'codex-credentials.json',
  'machine-id',
  'kvm/fingerprint',
]

function copyKept(src, dest) {
  const st = fs.lstatSync(src)
  if (st.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(src), dest)
    return
  }
  if (st.isDirectory()) {
    fs.cpSync(src, dest, { recursive: true })
    return
  }
  fs.copyFileSync(src, dest)
}

/** Move account files and the existing computer identity out, then wipe the rest. */
export function wipeSlotHome(projectRoot, id, { keepData = false } = {}) {
  if (!projectRoot || !id) return
  const home = path.join(projectRoot, 'vms', id)
  const stash = keepData ? fs.mkdtempSync(path.join(projectRoot, 'vms', `.${id}-keep-`)) : ''
  if (stash) {
    for (const rel of KEEP_HOME) {
      const src = path.join(home, rel)
      if (!fs.existsSync(src)) continue
      const dest = path.join(stash, rel)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      copyKept(src, dest)
    }
  }
  try {
    fs.rmSync(home, { recursive: true, force: true })
  } catch {}
  if (stash) {
    for (const rel of KEEP_HOME) {
      const src = path.join(stash, rel)
      if (!fs.existsSync(src)) continue
      const dest = path.join(home, rel)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      copyKept(src, dest)
    }
    fs.rmSync(stash, { recursive: true, force: true })
  }
  const chat = path.join(projectRoot, 'vms', `${id}-chat.json`)
  try {
    if (fs.existsSync(chat)) fs.unlinkSync(chat)
  } catch {}
  invalidateVmSlotReadCache(projectRoot, id)
}

export function seedFreshCliHome(projectRoot, vm) {
  const written = writeSlotSeedFiles(projectRoot, vm)
  // A baked slot image carries its binaries; no .kin copy in the home.
  if (!slotHost(vm).bakedKernel) {
    try {
      materializeWrapCli(projectRoot, vm)
    } catch {}
  }
  return { homeDir: written.homeDir, seed_policy: written.seed_policy || defaultSeedPolicy(vm.seed_policy || {}) }
}

function keptAccount(prev) {
  const claude = prev?.claude && typeof prev.claude === 'object' ? { ...prev.claude } : {}
  for (const key of ['access_token', 'refresh_token', 'accessToken', 'refreshToken', 'api_key']) delete claude[key]
  const codex = prev?.codex && typeof prev.codex === 'object' ? { ...prev.codex } : null
  if (codex) {
    for (const key of ['access_token', 'refresh_token', 'id_token']) delete codex[key]
  }
  return { claude, codex }
}

export function buildRecreatedVmRecord(prev, generated, { mode = 'traits' } = {}) {
  const keep = mode === 'keep'
  const pack = keep
    ? {
        ...(prev?.fingerprint && typeof prev.fingerprint === 'object' ? prev.fingerprint : {}),
        timezone: validTimezone(prev.timezone) || prev?.fingerprint?.timezone || null,
        locale: prev.locale || prev?.fingerprint?.locale,
      }
    : generated?.device_id
      ? generated
      : generateWorkstationFingerprint(prev)
  const now = keep ? new Date().toISOString() : pack.reset_at || new Date().toISOString()
  const policy = prev?.policy && typeof prev.policy === 'object' ? prev.policy : {}
  const maxConcurrency = Number.isFinite(Number(policy.maxConcurrency))
    ? Math.max(0, Math.min(128, Number(policy.maxConcurrency)))
    : 20
  const maxRpm = Number.isFinite(Number(policy.maxRpm)) ? Math.max(0, Math.min(1e6, Number(policy.maxRpm))) : 0
  const rpmOverride = policy.rpmOverride === true
  const weight = Number.isFinite(Number(policy.weight)) ? Math.max(1, Math.min(100, Number(policy.weight))) : 1
  const priority = manualScheduleLevelOf(prev)
  const activeHours = activeHoursOf({ policy })
  const allowed = Array.isArray(policy.allowed_models)
    ? [...new Set(policy.allowed_models.map((id) => String(id || '').trim()).filter(Boolean))]
    : []
  const timezone = validTimezone(prev.timezone) || validTimezone(pack.timezone) || null
  const locale = prev.locale || pack.locale
  const account = keep ? keptAccount(prev) : { claude: {}, codex: null }
  const next = {
    id: prev.id,
    name: prev.name,
    status: 'stopped',
    kernel: prev.kernel || 'ubuntu-24.04',
    timezone,
    timezone_source: prev.timezone_source || 'auto',
    locale,
    region: prev.region || null,
    note: prev.note || null,
    proxy: prev.proxy || null,
    policy: {
      maxConcurrency,
      maxRpm,
      ...(rpmOverride ? { rpmOverride: true } : {}),
      weight,
      ...(priority == null ? {} : { priority }),
      inflight: 0,
      ...(allowed.length ? { allowed_models: allowed } : {}),
      ...(policy.quota && typeof policy.quota === 'object' ? { quota: policy.quota } : {}),
      ...(activeHours ? { active_hours: activeHours } : {}),
    },
    claude: account.claude,
    fingerprint: keep
      ? { ...pack, timezone, locale }
      : applyGeneratedFingerprint({}, { ...pack, timezone, locale, reset_at: now }),
    stats: keep && prev.stats && typeof prev.stats === 'object' ? prev.stats : {},
    created_at: prev.created_at || now,
    updated_at: now,
    schedulable: false,
    schedule_disabled_reason: keep && prev?.claude?.has_access ? null : 'no_credential',
    proxy_cli_enabled: hasBoundExit(prev.proxy),
    seed_policy: defaultSeedPolicy(prev.seed_policy || {}),
    runtime: { type: prev.runtime?.type === 'kvm' ? 'kvm' : 'docker' },
    proxy_required: prev.proxy_required,
    ...(prev.inference_engine ? { inference_engine: prev.inference_engine } : {}),
    ...(prev.persona_preset ? { persona_preset: prev.persona_preset } : {}),
    ...(prev.node_id ? { node_id: prev.node_id } : {}),
    ...(prev.owner_user_id ? { owner_user_id: prev.owner_user_id } : {}),
    ...(prev.origin ? { origin: prev.origin } : {}),
  }
  if (!keep || next.schedule_disabled_reason) next.schedulable = false
  if (keep && !next.schedule_disabled_reason) next.schedulable = prev.schedulable !== false
  stampVmKind(next, prev)
  if (keep && account.codex) next.codex = account.codex
  else if (keep) next.claude = account.claude
  return next
}

export function recreateVmFiles(projectRoot, prev, { mode = 'traits' } = {}) {
  if (!projectRoot || !prev?.id) throw new Error('projectRoot and vm id required')
  const keep = mode === 'keep'
  wipeSlotHome(projectRoot, prev.id, { keepData: keep })
  const generated = keep
    ? null
    : assignComputerFingerprint(projectRoot, prev, {
        taken: takenFingerprintKeys(listVms(projectRoot), { exceptId: prev.id }),
      })
  const vm = buildRecreatedVmRecord(prev, generated, { mode: keep ? 'keep' : 'traits' })
  const vmPath = path.join(projectRoot, 'vms', `${prev.id}.json`)
  atomicWriteJson(vmPath, vm, { mode: 0o600 })
  if (vm.fingerprint?.guest_machine_id) writeGuestMachineIdFile(projectRoot, vm.id, vm.fingerprint.guest_machine_id)
  seedFreshCliHome(projectRoot, vm)
  return { vm, vmPath, mode: keep ? 'keep' : 'traits' }
}
