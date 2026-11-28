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
import { fingerprintDir, renderSlotPasswdGroupContent } from '../identity/slot-computer.mjs'
import { isCustomSlotUser, slotHome, slotUser } from '../vm/slot-identity.mjs'
import { openSftp, runRemote, shellQuote, writeRemoteFile } from './remote-fs.mjs'

const MAX_FILE_BYTES = 64 * 1024
const MAX_FILES = 128

export const MANAGED_SETTINGS_D_REL = 'etc/claude-code/managed-settings.d'
export const OPTIONAL_REGULAR_ETC_FILES = Object.freeze(['os-release', 'localtime', 'timezone'])

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

export function clusterRuntimeEtcBinds(remoteDir) {
  return [
    `${remoteDir}/computer/runtime-etc/passwd:/etc/passwd:ro`,
    `${remoteDir}/computer/runtime-etc/group:/etc/group:ro`,
  ]
}

export function clusterRegularEtcBinds(remoteDir, names = OPTIONAL_REGULAR_ETC_FILES) {
  const allowed = new Set(OPTIONAL_REGULAR_ETC_FILES)
  return (Array.isArray(names) ? names : [])
    .filter((name) => allowed.has(name))
    .map((name) => `${remoteDir}/computer/etc/${name}:/etc/${name}:ro`)
}

export function localRegularEtcNames(projectRoot, vm) {
  if (!projectRoot || !vm?.id) return []
  const etcDir = path.join(fingerprintDir(projectRoot, vm.id), 'system', 'etc')
  return OPTIONAL_REGULAR_ETC_FILES.filter((name) => regularFile(path.join(etcDir, name)))
}

function parseUidGidSpec(userSpec) {
  const m = /^(\d+):(\d+)$/.exec(String(userSpec || '').trim())
  if (!m) return null
  const uid = Number(m[1])
  const gid = Number(m[2])
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid < 0 || gid < 0) return null
  return { uid, gid }
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
  for (const name of localRegularEtcNames(projectRoot, vm)) {
    out.push({ rel: `etc/${name}`, data: fs.readFileSync(path.join(system, 'etc', name)) })
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
 * For custom-username Docker slots, dynamically renders `runtime-etc/{passwd,group}`
 * against the target node's real container `uid:gid` (never control-plane local UID).
 */
export async function pushClusterComputer(
  projectRoot,
  vm,
  session,
  { remoteDir, owner = null, containerUser = '' } = {},
) {
  const files = localComputerFiles(projectRoot, vm)
  if (!files) return false
  const targetIds =
    parseUidGidSpec(containerUser) ||
    (owner && Number.isInteger(owner.uid) && Number.isInteger(owner.gid) ? owner : null) ||
    (session?.host && Number.isInteger(session.host.uid) && Number.isInteger(session.host.gid) && session.host.uid > 0
      ? { uid: session.host.uid, gid: session.host.gid }
      : null)
  const runtimeEtcFiles = []
  if (isCustomSlotUser(vm) && targetIds) {
    const rendered = renderSlotPasswdGroupContent({
      username: slotUser(vm),
      uid: targetIds.uid,
      gid: targetIds.gid,
      homeDir: slotHome(vm),
    })
    runtimeEtcFiles.push(
      { rel: 'runtime-etc/passwd', data: Buffer.from(rendered.passwd, 'utf8') },
      { rel: 'runtime-etc/group', data: Buffer.from(rendered.group, 'utf8') },
    )
  }
  const allFiles = [...files, ...runtimeEtcFiles]
  const root = `${remoteDir}/computer`
  const hasManaged = allFiles.some((f) => f.rel.startsWith(`${MANAGED_SETTINGS_D_REL}/`))
  const hasRuntimeEtc = runtimeEtcFiles.length > 0
  const dirs = [
    root,
    `${root}/etc`,
    `${root}/dmi`,
    `${root}/dmi/id`,
    `${root}/hardware`,
    ...(hasManaged ? [`${root}/etc/claude-code`, `${root}/${MANAGED_SETTINGS_D_REL}`] : []),
    ...(hasRuntimeEtc ? [`${root}/runtime-etc`] : []),
  ]
  const chown = owner ? ` && chown ${owner.uid}:${owner.gid} ${dirs.map(shellQuote).join(' ')}` : ''
  await runRemote(
    session.client,
    `rm -rf ${shellQuote(`${root}/dmi/id`)} ${shellQuote(`${root}/hardware`)} ${shellQuote(`${root}/${MANAGED_SETTINGS_D_REL}`)} ${shellQuote(`${root}/runtime-etc`)} && umask 022 && mkdir -p ${dirs.map(shellQuote).join(' ')} && chmod 755 ${dirs.map(shellQuote).join(' ')}${chown}`,
    { timeoutMs: 20_000 },
  )
  const sftp = await openSftp(session.client)
  for (const f of allFiles) await writeRemoteFile(sftp, `${root}/${f.rel}`, f.data, { mode: 0o644, owner })
  return true
}
