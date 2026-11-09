/**
 * Slot files for VMs placed on a cluster node.
 *
 * The control plane keeps writing vms/<id>/ locally (every existing writer is
 * unchanged); this module copies the files the container reads to the node's
 * <root>/vms/<id>/ over SFTP. One exception, credentials.json: after a slot is
 * running the *remote* copy is authoritative, because `kin-worker oauth
 * refresh` rotates the refresh token inside the container. Pushing a local copy
 * over a rotated one would revoke the account, so credentials are only pushed
 * on an explicit import and otherwise pulled.
 *
 * Guest isolation: the host only touches files directly inside a bind-mount
 * root (`run/`, `claude/`) or host-only paths. The guest can plant entries
 * inside those directories but can never replace the directories themselves,
 * and remote-fs never follows a final symlink. `claude/` is mounted at
 * /home/kincli/.claude for exactly this reason: inside the writable home the
 * guest could swap `.claude` for a link to anywhere on the node.
 */

import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { nodeSession, remoteSlotDir, remoteSlotOwner, vmNodeId } from './placement.mjs'
import { hasCredentialPresence, mirrorWorkerCredentialsToVm } from '../oauth/oauth-credentials.mjs'
import { EGRESS_BIN } from '../vm/egress.mjs'
import { readJsonCached } from '../vm/vm-file.mjs'
import {
  openSftp,
  privateDirectoriesScript,
  readRemoteFileNoFollow,
  remoteSymlink,
  runRemote,
  shellQuote,
  writeRemoteFile,
} from './remote-fs.mjs'
import { cragSlotPayload } from './slot-image.mjs'
const SEED_SETTINGS_FILES = Object.freeze([
  'cli-home/.claude/settings.json',
  'cli-home/.claude/claude.setting',
  'cli-home/.claude/kin-seed.json',
])
export const SLOT_FILE_SETS = Object.freeze({
  run: ['run/kernel.json', 'run/worker.json', 'run/internal.token'],
  seed: [...SEED_SETTINGS_FILES, 'machine-id'],
  // Policy publication must not overwrite node-owned identity or OAuth files.
  seed_settings: SEED_SETTINGS_FILES,
  telemetry: ['run/kernel.json', ...SEED_SETTINGS_FILES, 'cli-home/.claude/telemetry/egress.json'],
})
const CREDENTIALS = 'cli-home/.claude/credentials.json'
const SLOT_BINARIES = Object.freeze(['kin-worker', 'kin-egress'])

function clusterBin(envKey, fallback) {
  const value = process.env[envKey]
  return value && String(value).trim() ? String(value).trim() : fallback
}

/** Local vms/<id>/ path → node path: the home's `.claude` lives in the host-owned `claude/` mount. */
export function remoteSlotPath(rel) {
  return rel.startsWith('cli-home/.claude/') ? `claude/${rel.slice('cli-home/.claude/'.length)}` : rel
}

const prepared = new WeakMap()
const REMOTE_FILE_MODE = 0o600

async function prepareRemoteDir(session, vm) {
  let done = prepared.get(session.client)
  if (!done) {
    done = new Set()
    prepared.set(session.client, done)
  }
  if (done.has(vm.id)) return
  const dir = remoteSlotDir(session.host, vm.id)
  const owner = remoteSlotOwner(session.host, vm)
  // Mount roots only: nothing here resolves through a path the guest can rewrite.
  const roots = [`${dir}/run`, `${dir}/claude`, `${dir}/claude/telemetry`, `${dir}/cli-home`].map(shellQuote).join(' ')
  const binDir = shellQuote(`${dir}/slot-bin`)
  const chown =
    session.host.uid === 0 ? ` && chown ${owner.uid}:${owner.gid} ${shellQuote(dir)} ${roots} ${binDir}` : ''
  const privateDirs = ['crag-native-assets', 'work', 'crag-license'].map((name) => `${dir}/run/${name}`)
  const privateScript = privateDirectoriesScript(privateDirs, session.host.uid === 0 ? owner : null)
  await runRemote(
    session.client,
    `umask 077 && mkdir -p ${roots} ${binDir} && chmod 700 ${shellQuote(dir)} ${roots} && chmod 755 ${binDir}${chown} && ${privateScript}`,
    { timeoutMs: 20_000 },
  )
  done.add(vm.id)
}

export function forgetRemoteDir(client, vmId) {
  prepared.get(client)?.delete(vmId)
}

function ownerFor(session, vm) {
  return session.host.uid === 0 ? remoteSlotOwner(session.host, vm) : null
}

/** Push the named sets (`run`, `seed`). Missing local files are skipped. */
export async function pushSlotFiles(vm, slotDir, sets = ['run', 'seed'], session = null) {
  const s = session || (await nodeSession(vmNodeId(vm)))
  await prepareRemoteDir(s, vm)
  const sftp = await openSftp(s.client)
  const remote = remoteSlotDir(s.host, vm.id)
  const owner = ownerFor(s, vm)
  const pushed = []
  for (const rel of sets.flatMap((name) => SLOT_FILE_SETS[name] || [])) {
    const local = path.join(slotDir, rel)
    let data
    try {
      data = fs.readFileSync(local)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      continue
    }
    // Never mirror local modes: a drvfs / 0777 checkout would publish tokens world-readable on the node.
    await writeRemoteFile(sftp, `${remote}/${remoteSlotPath(rel)}`, data, { mode: REMOTE_FILE_MODE, owner })
    pushed.push(rel)
  }
  return { pushed }
}

/** Publish Go service payloads into the persistent per-slot mount. */
export async function pushSlotBinaries(vm, projectRoot, session = null) {
  const s = session || (await nodeSession(vmNodeId(vm)))
  await prepareRemoteDir(s, vm)
  const sftp = await openSftp(s.client)
  const remote = `${remoteSlotDir(s.host, vm.id)}/slot-bin`
  const owner = ownerFor(s, vm)
  const pushed = []
  const digest = crypto.createHash('sha256')
  for (const name of SLOT_BINARIES) {
    const defaultBin = path.join(projectRoot, 'bin', name)
    const local =
      name === 'kin-worker'
        ? clusterBin('KIN_CLUSTER_WORKER_BIN', clusterBin('KIN_WORKER_BIN', defaultBin))
        : clusterBin(
            'KIN_CLUSTER_EGRESS_BIN',
            clusterBin('KIN_EGRESS_BIN', fs.existsSync(EGRESS_BIN) ? EGRESS_BIN : defaultBin),
          )
    let data
    try {
      data = fs.readFileSync(local)
    } catch {
      continue
    }
    await writeRemoteFile(sftp, `${remote}/${name}`, data, { mode: 0o755, owner })
    digest.update(name).update(data)
    pushed.push(name)
  }
  const crag = await pushCragSlot(vm, projectRoot, s)
  return { pushed, digest: digest.digest('hex'), crag }
}

/** Same CRAG tree the slot image bakes, for containers created before that image. */
export async function pushCragSlot(vm, projectRoot, session = null) {
  const s = session || (await nodeSession(vmNodeId(vm)))
  await prepareRemoteDir(s, vm)
  const payload = cragSlotPayload(projectRoot)
  const slotDir = remoteSlotDir(s.host, vm.id)
  const remote = `${slotDir}/slot-bin`
  const marker = `${remote}/crag.digest`
  const seccomp = fs.readFileSync(new URL('../vm/crag-v2-seccomp.json', import.meta.url))
  const owner = ownerFor(s, vm)
  const sftp = await openSftp(s.client)
  await writeRemoteFile(sftp, `${slotDir}/crag-v2-seccomp.json`, seccomp, { mode: 0o644, owner })
  const current = await readRemoteFileNoFollow(s.client, marker)
  if (current?.toString('utf8').trim() === payload.digest) return { pushed: false, digest: payload.digest }
  const dirs = new Set()
  for (const file of payload.files) {
    const rel = file.name.slice('opt/kin/'.length)
    const slash = rel.lastIndexOf('/')
    if (slash > 0) dirs.add(`${remote}/${rel.slice(0, slash)}`)
  }
  if (dirs.size) {
    const quoted = [...dirs].sort().map(shellQuote).join(' ')
    const chown = owner ? ` && chown ${owner.uid}:${owner.gid} ${quoted}` : ''
    await runRemote(s.client, `umask 022 && mkdir -p ${quoted} && chmod 755 ${quoted}${chown}`, { timeoutMs: 20_000 })
  }
  for (const file of payload.files) {
    const rel = file.name.slice('opt/kin/'.length)
    const data = file.body || fs.readFileSync(file.src)
    await writeRemoteFile(sftp, `${remote}/${rel}`, data, { mode: file.mode, owner })
  }
  await writeRemoteFile(sftp, marker, `${payload.digest}\n`, { mode: 0o644, owner })
  return { pushed: true, digest: payload.digest }
}

/** Explicit import only: replace the remote credential with the local one. */
export async function pushSlotCredentials(vm, slotDir, session = null) {
  const s = session || (await nodeSession(vmNodeId(vm)))
  await prepareRemoteDir(s, vm)
  const local = path.join(slotDir, CREDENTIALS)
  if (!fs.existsSync(local)) return { pushed: false }
  const sftp = await openSftp(s.client)
  const remote = remoteSlotDir(s.host, vm.id)
  await writeRemoteFile(sftp, `${remote}/${remoteSlotPath(CREDENTIALS)}`, fs.readFileSync(local), {
    mode: REMOTE_FILE_MODE,
    owner: ownerFor(s, vm),
  })
  // Official CLI reads ~/.claude/.credentials.json; one store, same as local slots.
  await remoteSymlink(sftp, 'credentials.json', `${remote}/claude/.credentials.json`)
  return { pushed: true }
}

/** Pull the node credential and repair its metadata even when local bytes already match. */
export async function pullSlotCredentials(vm, slotDir, session = null) {
  const s = session || (await nodeSession(vmNodeId(vm)))
  const remote = await readRemoteFileNoFollow(
    s.client,
    `${remoteSlotDir(s.host, vm.id)}/${remoteSlotPath(CREDENTIALS)}`,
  )
  if (!remote) return { pulled: false, reason: 'remote_missing' }
  const local = path.join(slotDir, CREDENTIALS)
  let mode = 0o600
  let same = false
  try {
    same = fs.readFileSync(local).equals(remote)
    mode = fs.statSync(local).mode & 0o777
  } catch {}
  if (!same) {
    fs.mkdirSync(path.dirname(local), { recursive: true, mode: 0o700 })
    const tmp = `${local}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, remote, { mode })
    // The local seal must survive whatever umask Node runs with.
    fs.chmodSync(tmp, mode)
    fs.renameSync(tmp, local)
  }
  const vmPath = path.join(path.dirname(slotDir), `${vm.id}.json`)
  let record = readJsonCached(vmPath)
  // Unchanged credentials must not clear an existing auth cooldown on every start.
  if (!same || !hasCredentialPresence(record?.claude)) {
    record = mirrorWorkerCredentialsToVm(vmPath, path.join(slotDir, 'cli-home'))
  }
  if (record) vm.claude = record.claude
  return same ? { pulled: false, reason: 'same' } : { pulled: true }
}

/**
 * Start/reload reconcile: a remote credential wins (it may be rotated); only a
 * slot whose node dir has none yet gets the local one.
 */
export async function reconcileSlotCredentials(vm, slotDir, session) {
  const pulled = await pullSlotCredentials(vm, slotDir, session)
  if (pulled.reason !== 'remote_missing') return pulled
  return pushSlotCredentials(vm, slotDir, session)
}

/** Point the node official CLI at worker credentials.json without rewriting its bytes. */
export async function ensureRemoteOfficialCredentialLink(vm, slotDir, session = null) {
  const s = session || (await nodeSession(vmNodeId(vm)))
  const remoteCred = `${remoteSlotDir(s.host, vm.id)}/${remoteSlotPath(CREDENTIALS)}`
  const remote = await readRemoteFileNoFollow(s.client, remoteCred)
  if (!remote) return { linked: false, reason: 'remote_missing' }
  await prepareRemoteDir(s, vm)
  const sftp = await openSftp(s.client)
  await remoteSymlink(sftp, 'credentials.json', `${remoteSlotDir(s.host, vm.id)}/claude/.credentials.json`)
  return { linked: true }
}

const queues = new Map()

/** Fire-and-forget push, serialized per VM so a slow push never races the next one. */
export function queueSlotPush(vm, slotDir, sets, { logger = console } = {}) {
  const prev = queues.get(vm.id) || Promise.resolve()
  const next = prev
    .catch(() => {})
    .then(() => pushSlotFiles(vm, slotDir, sets))
    .catch((err) => {
      logger.warn(
        JSON.stringify({ event: 'remote_slot_push_failed', vm_id: vm.id, sets, error: String(err?.message || err) }),
      )
    })
    .finally(() => {
      if (queues.get(vm.id) === next) queues.delete(vm.id)
    })
  queues.set(vm.id, next)
  return next
}

/** Delete the node-side slot tree (explicit delete / factory reset only). */
export async function removeRemoteSlotDir(vm, session) {
  const dir = remoteSlotDir(session.host, vm.id)
  await runRemote(session.client, `rm -rf ${shellQuote(dir)}`, { timeoutMs: 60_000 })
  forgetRemoteDir(session.client, vm.id)
}
