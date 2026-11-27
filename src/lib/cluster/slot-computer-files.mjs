/**
 * Computer identity for Docker slots placed on a cluster node.
 *
 * A local Docker slot binds the kin-computer output read-only into the guest
 * (computerDockerArgs in vm-runtime.mjs): /etc/kin-computer, /etc/kin-dmi and
 * /etc/kin-hardware. The CRAG kernel treats those as the guest source for
 * native telemetry: without them it answers `telemetry_native_settings_blocked`
 * however clean the published settings are. Cluster slots never got them, so
 * telemetry could not be enabled on any slot that runs on a node.
 *
 * The identity is the one the control plane already holds under
 * vms/<id>/kvm/fingerprint/system. It is never created here: a slot without a
 * complete local identity simply keeps its current layout.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fingerprintDir } from '../identity/slot-computer.mjs'
import { openSftp, runRemote, shellQuote, writeRemoteFile } from './remote-fs.mjs'

const MAX_FILE_BYTES = 64 * 1024
const MAX_FILES = 128

export const MANAGED_SETTINGS_D_REL = 'etc/claude-code/managed-settings.d'

/** Guest path → path under the node's <slot>/computer and the local fingerprint/system dir. */
const MOUNTS = Object.freeze([
  { guest: '/etc/kin-computer', rel: 'etc/kin-computer', file: true },
  { guest: '/etc/kin-dmi', rel: 'dmi/id', file: false },
  { guest: '/etc/kin-hardware', rel: 'hardware', file: false },
])

export function clusterComputerBinds(remoteDir) {
  return MOUNTS.map((m) => `${remoteDir}/computer/${m.rel}:${m.guest}:ro`)
}

export function clusterManagedSettingsBind(remoteDir) {
  return `${remoteDir}/computer/${MANAGED_SETTINGS_D_REL}:/etc/claude-code/managed-settings.d:ro`
}

/** Without remoteDir (callers that only hold the inspected container) any node root is accepted. */
export function hasClusterComputerBinds(container, remoteDir = '') {
  const binds = container?.HostConfig?.Binds || []
  if (remoteDir) return clusterComputerBinds(remoteDir).every((bind) => binds.includes(bind))
  return MOUNTS.every((m) => binds.some((bind) => String(bind).endsWith(`/computer/${m.rel}:${m.guest}:ro`)))
}

function regularFile(file) {
  try {
    const st = fs.lstatSync(file)
    return st.isFile() && st.size <= MAX_FILE_BYTES
  } catch {
    return false
  }
}

/**
 * Optional read-only managed-settings.d drop-ins produced by `kin-computer`
 * under `vms/<id>/kvm/fingerprint/system/etc/claude-code/managed-settings.d/*.json`.
 * Returns an empty list for legacy slots that do not carry drop-ins.
 */
export function localManagedSettingsFiles(projectRoot, vm) {
  if (!projectRoot || !vm?.id) return []
  const dir = path.join(fingerprintDir(projectRoot, vm.id), 'system', MANAGED_SETTINGS_D_REL)
  let names
  try {
    const st = fs.lstatSync(dir)
    if (st.isSymbolicLink() || !st.isDirectory()) return []
    names = fs.readdirSync(dir).sort()
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    if (!name || name.startsWith('.') || !name.endsWith('.json')) continue
    const file = path.join(dir, name)
    if (!regularFile(file)) continue
    out.push({ rel: `${MANAGED_SETTINGS_D_REL}/${name}`, data: fs.readFileSync(file) })
  }
  return out
}

export function hasLocalManagedSettings(projectRoot, vm) {
  return localManagedSettingsFiles(projectRoot, vm).length > 0
}

/**
 * Files to publish, as [{ rel, data }] relative to <slot>/computer, or null when
 * the local identity is incomplete (no kin-computer file or an empty DMI dir).
 * Only regular files directly inside each mount root are taken; links are skipped.
 */
export function localComputerFiles(projectRoot, vm) {
  if (!projectRoot || !vm?.id) return null
  const system = path.join(fingerprintDir(projectRoot, vm.id), 'system')
  const out = []
  for (const m of MOUNTS) {
    const local = path.join(system, m.rel)
    if (m.file) {
      if (!regularFile(local)) return null
      out.push({ rel: m.rel, data: fs.readFileSync(local) })
      continue
    }
    let names
    try {
      if (!fs.lstatSync(local).isDirectory()) return null
      names = fs.readdirSync(local).sort()
    } catch {
      return null
    }
    const files = names.filter((name) => regularFile(path.join(local, name)))
    if (!files.length) return null
    for (const name of files) out.push({ rel: `${m.rel}/${name}`, data: fs.readFileSync(path.join(local, name)) })
  }
  for (const preset of localManagedSettingsFiles(projectRoot, vm)) out.push(preset)
  return out.length <= MAX_FILES ? out : null
}

export function hasLocalComputer(projectRoot, vm) {
  return localComputerFiles(projectRoot, vm) !== null
}

/**
 * Copy the identity to <remoteDir>/computer. Returns false when there is nothing
 * complete to publish. Directories are rebuilt so a stale file cannot linger.
 */
export async function pushClusterComputer(projectRoot, vm, session, { remoteDir, owner = null } = {}) {
  const files = localComputerFiles(projectRoot, vm)
  if (!files) return false
  const root = `${remoteDir}/computer`
  const hasManaged = files.some((f) => f.rel.startsWith(`${MANAGED_SETTINGS_D_REL}/`))
  const dirs = [
    root,
    `${root}/etc`,
    `${root}/dmi`,
    `${root}/dmi/id`,
    `${root}/hardware`,
    ...(hasManaged ? [`${root}/etc/claude-code`, `${root}/${MANAGED_SETTINGS_D_REL}`] : []),
  ]
  const chown = owner ? ` && chown ${owner.uid}:${owner.gid} ${dirs.map(shellQuote).join(' ')}` : ''
  await runRemote(
    session.client,
    `rm -rf ${shellQuote(`${root}/dmi/id`)} ${shellQuote(`${root}/hardware`)} ${shellQuote(`${root}/${MANAGED_SETTINGS_D_REL}`)} && umask 022 && mkdir -p ${dirs.map(shellQuote).join(' ')} && chmod 755 ${dirs.map(shellQuote).join(' ')}${chown}`,
    { timeoutMs: 20_000 },
  )
  const sftp = await openSftp(session.client)
  for (const f of files) await writeRemoteFile(sftp, `${root}/${f.rel}`, f.data, { mode: 0o644, owner })
  return true
}
