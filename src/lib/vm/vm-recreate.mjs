/**
 * Factory-reset a slot: keep the registry identity (id / name / kernel /
 * timezone / proxy / seed / concurrency), wipe guest home + credentials,
 * then the caller destroys the container and starts a new one.
 */
import fs from 'node:fs'
import path from 'node:path'
import { normalizeTimezone, validTimezone } from '../core/timezone.mjs'
import { atomicWriteJson } from './vm-file.mjs'
import { defaultSeedPolicy } from '../protocol/seed-policy.mjs'
import { writeSlotSeedFiles } from './slot-seed.mjs'
import { manualScheduleLevelOf } from '../pool/credential-weight.mjs'
import { stampVmKind } from './vm-kind.mjs'
import { materializeWrapCli } from './wrap-cli-runtime.mjs'
import { listVms } from './vm-registry.mjs'
import {
  applyGeneratedFingerprint,
  generateWorkstationFingerprint,
  takenFingerprintKeys,
  writeGuestMachineIdFile,
} from '../identity/workstation-fingerprint.mjs'

export function wipeSlotHome(projectRoot, id) {
  if (!projectRoot || !id) return
  const home = path.join(projectRoot, 'vms', id)
  try {
    fs.rmSync(home, { recursive: true, force: true })
  } catch {}
  const chat = path.join(projectRoot, 'vms', `${id}-chat.json`)
  try {
    if (fs.existsSync(chat)) fs.unlinkSync(chat)
  } catch {}
}

export function seedFreshCliHome(projectRoot, vm) {
  const written = writeSlotSeedFiles(projectRoot, vm)
  try {
    materializeWrapCli(projectRoot, vm)
  } catch {}
  return { homeDir: written.homeDir, seed_policy: written.seed_policy || defaultSeedPolicy(vm.seed_policy || {}) }
}

export function buildRecreatedVmRecord(prev, generated) {
  const pack = generated?.device_id ? generated : generateWorkstationFingerprint(prev)
  const now = pack.reset_at || new Date().toISOString()
  const policy = prev?.policy && typeof prev.policy === 'object' ? prev.policy : {}
  const maxConcurrency = Number.isFinite(Number(policy.maxConcurrency))
    ? Math.max(0, Math.min(128, Number(policy.maxConcurrency)))
    : 20
  const maxRpm = Number.isFinite(Number(policy.maxRpm)) ? Math.max(0, Math.min(1e6, Number(policy.maxRpm))) : 0
  const rpmOverride = policy.rpmOverride === true
  const weight = Number.isFinite(Number(policy.weight)) ? Math.max(1, Math.min(100, Number(policy.weight))) : 1
  const priority = manualScheduleLevelOf(prev)
  const allowed = Array.isArray(policy.allowed_models)
    ? [...new Set(policy.allowed_models.map((id) => String(id || '').trim()).filter(Boolean))]
    : []
  const timezone = validTimezone(prev.timezone) || normalizeTimezone(pack.timezone)
  const locale = prev.locale || pack.locale
  const next = {
    id: prev.id,
    name: prev.name,
    status: 'stopped',
    kernel: prev.kernel || 'ubuntu-24.04',
    timezone,
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
    },
    claude: {},
    fingerprint: applyGeneratedFingerprint({}, { ...pack, timezone, locale, reset_at: now }),
    stats: {},
    created_at: prev.created_at || now,
    updated_at: now,
    schedulable: false,
    schedule_disabled_reason: 'no_credential',
    proxy_cli_enabled: prev.proxy_cli_enabled !== false,
    seed_policy: defaultSeedPolicy(prev.seed_policy || {}),
    runtime: { type: prev.runtime?.type === 'kvm' ? 'kvm' : 'docker' },
    proxy_required: prev.proxy_required,
    ...(prev.inference_engine ? { inference_engine: prev.inference_engine } : {}),
    ...(prev.persona_preset ? { persona_preset: prev.persona_preset } : {}),
  }
  stampVmKind(next, prev)
  return next
}

export function recreateVmFiles(projectRoot, prev) {
  if (!projectRoot || !prev?.id) throw new Error('projectRoot and vm id required')
  wipeSlotHome(projectRoot, prev.id)
  const generated = generateWorkstationFingerprint(prev, {
    taken: takenFingerprintKeys(listVms(projectRoot), { exceptId: prev.id }),
  })
  const vm = buildRecreatedVmRecord(prev, generated)
  const vmPath = path.join(projectRoot, 'vms', `${prev.id}.json`)
  atomicWriteJson(vmPath, vm, { mode: 0o600 })
  writeGuestMachineIdFile(projectRoot, vm.id, vm.fingerprint.guest_machine_id)
  seedFreshCliHome(projectRoot, vm)
  return { vm, vmPath }
}
