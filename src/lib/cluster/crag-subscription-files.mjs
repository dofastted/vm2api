import { createHash } from 'node:crypto'
import { CRAG_HOST_MOUNT } from '../vm/crag-subscription-paths.mjs'
import { readCragClusterSubscription } from '../vm/crag-license.mjs'
import { nodeSession, remoteSlotDir, remoteSlotOwner } from './placement.mjs'
import { openSftp, privateDirectoriesScript, runRemote, shellQuote, writeRemoteFile } from './remote-fs.mjs'

const publications = new WeakMap()

export function clusterSubscriptionBinds(remoteDir) {
  return [
    `${remoteDir}/subscription-host:${CRAG_HOST_MOUNT}:ro`,
    `${remoteDir}/subscription-license:/run/kin/crag-license:ro`,
  ]
}

export function hasClusterSubscriptionBinds(container, remoteDir) {
  return clusterSubscriptionBinds(remoteDir).every((bind) => container?.HostConfig?.Binds?.includes(bind))
}

export async function publishClusterSubscription(projectRoot, vm, session = null, { force = false } = {}) {
  session ??= await nodeSession(vm.node_id)
  const root = remoteSlotDir(session.host, vm.id)
  const hostDir = `${root}/subscription-host`
  const licenseDir = `${root}/subscription-license`
  const marker = `${hostDir}/sync-pending`
  const owner = session.host.uid === 0 ? remoteSlotOwner(session.host, vm) : null
  let records = publications.get(session.client)
  if (!records) publications.set(session.client, (records = new Map()))
  const record = records.get(root) ?? {}
  records.set(root, record)
  const pending = (record.pending ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const files = readCragClusterSubscription(projectRoot, vm)
      if (!files) return false
      const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex')
      if (!force && record.digest === digest) return true
      record.digest = undefined
      await runRemote(
        session.client,
        `umask 077 && ${privateDirectoriesScript([licenseDir], owner)} ${privateDirectoriesScript([hostDir])} chmod 755 ${shellQuote(hostDir)}`,
        { timeoutMs: 8000 },
      )
      const sftp = await openSftp(session.client)
      const write = (file, data, mode, fileOwner) =>
        writeRemoteFile(sftp, file, `${data}\n`, { mode, owner: fileOwner, timeoutMs: 8000 })
      await write(marker, 'pending', 0o644)
      await write(`${licenseDir}/device.json`, files.device, 0o600, owner)
      await write(`${licenseDir}/registration.code`, files.permit, 0o600, owner)
      await write(`${hostDir}/host_id`, files.hostId, 0o644)
      await write(`${hostDir}/entitlement.code`, files.entitlement, 0o644)
      await runRemote(session.client, `rm -f ${shellQuote(marker)}`, { timeoutMs: 8000 })
      record.digest = digest
      return true
    })
  record.pending = pending
  try {
    return await pending
  } finally {
    if (record.pending === pending) record.pending = undefined
  }
}
