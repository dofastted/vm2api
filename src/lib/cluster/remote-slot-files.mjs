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
import path from 'node:path'
import { nodeSession, remoteSlotDir, remoteSlotOwner, vmNodeId } from './placement.mjs'
import { hasCredentialPresence, mirrorWorkerCredentialsToVm } from '../oauth/oauth-credentials.mjs'
import { readJsonCached } from '../vm/vm-file.mjs'
import {
  openSftp,
  readRemoteFileNoFollow,
  remoteSymlink,
  runRemote,
  shellQuote,
  writeRemoteFile,
} from './remote-fs.mjs'

export const SLOT_FILE_SETS = Object.freeze({
  run: ['run/kernel.json', 'run/worker.json', 'run/internal.token'],
  seed: ['cli-home/.claude/settings.json', 'cli-home/.claude/kin-seed.json', 'machine-id'],
  touch: ['run/telemetry.touch'],
})
const CREDENTIALS = 'cli-home/.claude/credentials.json'
const TOUCH_PUSH_MS = 30_000

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
  const roots = [`${dir}/run`, `${dir}/claude`, `${dir}/cli-home`].map(shellQuote).join(' ')
  // Docker creates a missing bind source as root:root, which the slot uid cannot write.
  const chown = session.host.uid === 0 ? ` && chown ${owner.uid}:${owner.gid} ${shellQuote(dir)} ${roots}` : ''
  await runRemote(session.client, `umask 077 && mkdir -p ${roots} && chmod 700 ${shellQuote(dir)} ${roots}${chown}`, {
    timeoutMs: 20_000,
  })
  done.add(vm.id)
}

export function forgetRemoteDir(client, vmId) {
  prepared.get(client)?.delete(vmId)
}

function ownerFor(session, vm) {
  return session.host.uid === 0 ? remoteSlotOwner(session.host, vm) : null
}

/** Push the named sets (`run`, `seed`, `touch`). Missing local files are skipped. */
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
    } catch {
      continue
    }
    // Never mirror local modes: a drvfs / 0777 checkout would publish tokens world-readable on the node.
    await writeRemoteFile(sftp, `${remote}/${remoteSlotPath(rel)}`, data, { mode: REMOTE_FILE_MODE, owner })
    pushed.push(rel)
  }
  return { pushed }
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

const touchedAt = new Map()

/** Telemetry idle detection reads telemetry.touch in the slot; once per 30s is enough there. */
export function pushTelemetryTouch(vm, slotDir, now = Date.now()) {
  const last = touchedAt.get(vm.id) || 0
  if (now - last < TOUCH_PUSH_MS) return null
  touchedAt.set(vm.id, now)
  return queueSlotPush(vm, slotDir, ['touch'])
}

/** Delete the node-side slot tree (explicit delete / factory reset only). */
export async function removeRemoteSlotDir(vm, session) {
  const dir = remoteSlotDir(session.host, vm.id)
  await runRemote(session.client, `rm -rf ${shellQuote(dir)}`, { timeoutMs: 60_000 })
  forgetRemoteDir(session.client, vm.id)
}
