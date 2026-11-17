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
import { applyUnschedulable, deriveScheduleFields, pickScheduleFields } from '../pool/schedule-state.mjs'
import { activeHoursOf } from '../pool/active-hours.mjs'
import { isCodexVm, stampVmKind } from './vm-kind.mjs'
import { isKvmRuntime } from './runtime-kind.mjs'
import { resolveKernelDataplane } from './slot-engine.mjs'
import {
  WRAP_CLI_BIN,
  cragV2PackageRoot,
  describeCliPayload,
  describeKernelPayload,
  materializeCragV2,
  materializeResolvedKernel,
  materializeWrapCli,
  verifyCragV2Tree,
} from './wrap-cli-runtime.mjs'
import { listVms } from './vm-registry.mjs'
import { regenerateMachineIdentity } from './machine-spec.mjs'
import { slotHost } from './slot-host.mjs'
import {
  applyGeneratedFingerprint,
  generateWorkstationFingerprint,
  takenFingerprintKeys,
  writeGuestMachineIdFile,
} from '../identity/workstation-fingerprint.mjs'
import { assignComputerFingerprint } from '../identity/slot-computer.mjs'

const KEEP_HOME = [
  'cli-home/.claude.json',
  'cli-home/.claude/.claude.json',
  'cli-home/.claude/settings.json',
  'cli-home/.claude/settings.local.json',
  'cli-home/.claude/claude.setting',
  'cli-home/.claude/kin-identity.json',
  'cli-home/.claude/telemetry',
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
    fs.lchownSync(dest, st.uid, st.gid)
    return
  }
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true, mode: st.mode & 0o777 })
    for (const name of fs.readdirSync(src)) copyKept(path.join(src, name), path.join(dest, name))
  } else {
    fs.copyFileSync(src, dest)
  }
  fs.chmodSync(dest, st.mode & 0o777)
  fs.chownSync(dest, st.uid, st.gid)
}

/** Keep-mode rebuild preserves VM-owned account, native identity/settings and telemetry backlog. */
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

function requireKernelResult(result) {
  if (result?.ok === false) {
    throw Object.assign(new Error(result.error || result.code), { code: result.code })
  }
}

/** Read-only create preflight for CRAG-capable placements. Nodes verify their CRAG payload via cragSlotPayload. */
export function preflightFreshClaudeKernels(projectRoot, vm) {
  if (!describeKernelPayload(projectRoot).path || !describeCliPayload(projectRoot, WRAP_CLI_BIN).path) {
    throw Object.assign(new Error('请先拉取 cli-node 内核'), { code: 'kernel_package_missing' })
  }
  if (slotHost(vm).bakedKernel) return
  const root = cragV2PackageRoot(projectRoot, 'amd64')
  if (!root) {
    throw Object.assign(new Error('CRAG v2 package missing (share/crag/kernels/v2/amd64 or KIN_CRAG_V2_ROOT)'), {
      code: 'crag_v2_package_missing',
    })
  }
  requireKernelResult(verifyCragV2Tree(root, { arch: 'amd64' }))
}

export function seedFreshCliHome(projectRoot, vm, { routing, preinstallBoth = false } = {}) {
  const host = slotHost(vm)
  const crag = resolveKernelDataplane(vm, routing) === 'crag'
  const written = writeSlotSeedFiles(projectRoot, vm, null, { cragNativeTelemetry: crag && !host.native })
  // Cluster payloads go in slot-bin, not the control plane's .kin home.
  if (!host.bakedKernel) {
    if (preinstallBoth) {
      const wrap = materializeWrapCli(projectRoot, vm)
      requireKernelResult(wrap)
      const cli = fs.statSync(path.join(wrap.dest, WRAP_CLI_BIN), { throwIfNoEntry: false })
      if (!wrap.kernel_bin || !wrap.wrapper || !cli?.isFile()) {
        throw Object.assign(new Error('cli-node 安装不完整'), { code: 'kernel_materialize_failed' })
      }
      // Wrap already stages the encrypted CRAG package for local KVM slots.
      if (!isKvmRuntime(vm)) requireKernelResult(materializeCragV2(projectRoot, vm, { select: false }))
    } else {
      const required = crag || (isKvmRuntime(vm) && !isCodexVm(vm))
      try {
        const laid = materializeResolvedKernel(projectRoot, vm, { routing })
        if (required) requireKernelResult(laid)
      } catch (error) {
        if (required) throw error
      }
    }
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

function recreatedMachine(prev, keep) {
  const machine = prev?.machine && typeof prev.machine === 'object' ? prev.machine : null
  const kvm = prev?.runtime?.type === 'kvm'
  if (keep && machine && (!kvm || (machine.mac && machine.disk_serial))) return { machine: { ...machine } }
  // traits, or a KVM record that never stored its identity: the container is already gone, so draw one.
  if (machine || kvm) return { machine: regenerateMachineIdentity(machine) }
  return {}
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
    proxy_cli_enabled: hasBoundExit(prev.proxy),
    seed_policy: defaultSeedPolicy(prev.seed_policy || {}),
    runtime: { type: prev.runtime?.type === 'kvm' ? 'kvm' : 'docker' },
    // Sizing survives a reset; traits draws a new MAC / SMBIOS / disk serial. KVM cannot boot without them.
    ...recreatedMachine(prev, keep),
    proxy_required: prev.proxy_required,
    ...(prev.inference_engine ? { inference_engine: prev.inference_engine } : {}),
    ...(prev.dataplane ? { dataplane: prev.dataplane } : {}),
    ...(prev.crag_kernel_version ? { crag_kernel_version: prev.crag_kernel_version } : {}),
    ...(prev.persona_preset ? { persona_preset: prev.persona_preset } : {}),
    ...(prev.node_id ? { node_id: prev.node_id } : {}),
    ...(prev.owner_user_id ? { owner_user_id: prev.owner_user_id } : {}),
    ...(prev.origin ? { origin: prev.origin } : {}),
  }
  // Keep mode carries the operator switch and any 不可调度 over; a fresh slot has no ticket.
  if (keep && prev?.claude?.has_access) Object.assign(next, pickScheduleFields(prev))
  else applyUnschedulable(next, 'no_credential')
  deriveScheduleFields(next)
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
