import tls from 'node:tls'
import { normalizeRefreshGrant, normalizeRefreshReceipt } from '../core/node-credential-refresh.mjs'
import net from 'node:net'
import { isDeepStrictEqual } from 'node:util'
import crypto from 'node:crypto'
import { normalizeNodeManagementGrant, normalizeNodeManagementReceipt } from '../core/node-management-command.mjs'

function denied() {
  return Object.assign(new Error('node allocation acknowledgement unavailable'), {
    code: 'node_allocation_unconfirmed',
  })
}
function exact(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw denied()
}

export function normalizeAllocationReceipt(receipt, grant) {
  exact(receipt, ['node_id', 'vm_id', 'allocation_id', 'operation_id', 'owner_id', 'epoch', 'intent_digest', 'fence'])
  if (
    receipt.node_id !== grant.nodeId ||
    receipt.vm_id !== grant.vmId ||
    receipt.allocation_id !== grant.allocationId ||
    receipt.operation_id !== grant.operationId ||
    receipt.owner_id !== grant.ownerId ||
    receipt.epoch !== grant.epoch ||
    receipt.intent_digest !== grant.intentDigest
  )
    throw denied()
  const fence = receipt.fence
  exact(fence, ['generation', 'incarnation', 'executor'])
  if (
    String(fence.generation) !== '1' ||
    !/^[a-f0-9]{32}$/.test(fence.incarnation) ||
    !isDeepStrictEqual(fence.executor, { kind: '', node_boot_id: '' })
  )
    throw denied()
  return {
    ...receipt,
    fence: { generation: '1', incarnation: fence.incarnation, executor: { kind: '', node_boot_id: '' } },
  }
}

/** One typed management action; no retry, shell, launch or arbitrary path RPC. */
export function allocateNodeSlot({ link, grant }) {
  const values = [grant?.nodeId, grant?.vmId, grant?.allocationId, grant?.operationId, grant?.ownerId]
  if (
    grant?.action !== 'allocate' ||
    values.some((value) => typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) ||
    !link ||
    !net.isIP(link.address) ||
    !Number.isInteger(link.port) ||
    link.port < 1 ||
    link.port > 65535 ||
    typeof link.token !== 'string' ||
    !/^[\x21-\x7e]{32,256}$/.test(link.token) ||
    !/^[a-f0-9]{64}$/.test(link.certSha256)
  )
    return Promise.reject(denied())
  const request = {
    op: 'allocate',
    vm_id: grant.vmId,
    allocation_id: grant.allocationId,
    operation_id: grant.operationId,
    owner_id: grant.ownerId,
  }
  return new Promise((resolve, reject) => {
    let settled = false
    let buffer = Buffer.alloc(0)
    const socket = tls.connect({
      host: link.address,
      port: link.port,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
    })
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(denied()), 8000)
    socket.once('error', () => finish(denied()))
    socket.once('close', () => finish(denied()))
    socket.once('secureConnect', () => {
      const pin = socket.getPeerCertificate()?.fingerprint256?.replaceAll(':', '').toLowerCase()
      if (pin !== link.certSha256) return finish(denied())
      socket.write(
        `KSG2 ${link.token}\n${JSON.stringify(request, (key, value) => (key === 'generation' ? JSON.rawJSON(String(value)) : value))}\n`,
      )
    })
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > 8192) return finish(denied())
      const newline = buffer.indexOf(10)
      if (newline < 0) return
      try {
        const reply = JSON.parse(buffer.subarray(0, newline).toString(), (key, value, context) =>
          key === 'generation' && typeof value === 'number' ? context.source : value,
        )
        if (reply.ok !== true) throw denied()
        finish(null, normalizeAllocationReceipt(reply.allocation, grant))
      } catch {
        finish(denied())
      }
    })
  })
}

function managementInvalid() {
  return Object.assign(new Error('invalid node management command'), {
    code: 'node_command_invalid',
    vmOperationNotStarted: true,
  })
}

function managementFailure(action, sent) {
  return Object.assign(new Error('node management acknowledgement unavailable'), {
    code:
      action === 'credential-refresh'
        ? 'node_refresh_unconfirmed'
        : action === 'publish-initial'
          ? 'node_publication_unconfirmed'
          : 'node_launch_unconfirmed',
    ...(sent ? { vmOperationUncertain: true } : { vmOperationNotStarted: true }),
  })
}

function managementLink(link) {
  if (
    !link ||
    !net.isIP(link.address) ||
    !Number.isInteger(link.port) ||
    link.port < 1 ||
    link.port > 65535 ||
    typeof link.token !== 'string' ||
    !/^[\x21-\x7e]{32,256}$/.test(link.token) ||
    typeof link.certSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(link.certSha256)
  )
    throw managementInvalid()
  return { address: link.address, port: link.port, token: link.token, certSha256: link.certSha256 }
}

/** Exactly one typed action. No retry or shell/Docker/path parameter is accepted. */
async function commandNodeSlot({ link: linkInput, grant: grantInput, payload: payloadInput }, action) {
  let grant
  let link
  let payload
  try {
    if (action === 'publish-initial') {
      if (!Buffer.isBuffer(payloadInput) || payloadInput.length < 1 || payloadInput.length > 65536)
        throw managementInvalid()
      payload = Buffer.from(payloadInput)
    }
    grant =
      action === 'credential-refresh' ? normalizeRefreshGrant(grantInput) : normalizeNodeManagementGrant(grantInput)
    if (
      grant.intent.action !== action ||
      (payload && crypto.createHash('sha256').update(payload).digest('hex') !== grant.intent.payload_digest)
    )
      throw managementInvalid()
    link = managementLink(linkInput)
  } catch {
    throw managementInvalid()
  }
  const request = {
    op: action,
    vm_id: grant.intent.vm_id,
    [action === 'credential-refresh' ? 'refresh' : 'management']: grant.intent,
    ...(payload ? { content_length: payload.length } : {}),
  }
  return new Promise((resolve, reject) => {
    let settled = false
    let sent = false
    let buffer = Buffer.alloc(0)
    const socket = tls.connect({
      host: link.address,
      port: link.port,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
    })
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(value)
    }
    const failed = () => finish(managementFailure(action, sent))
    const timer = setTimeout(failed, action === 'credential-refresh' ? 45000 : 8000)
    socket.once('error', failed)
    socket.once('close', failed)
    socket.once('secureConnect', () => {
      const pin = socket.getPeerCertificate()?.fingerprint256?.replaceAll(':', '').toLowerCase()
      if (pin !== link.certSha256) return failed()
      sent = true
      socket.write(
        `KSG2 ${link.token}\n${JSON.stringify(request, (key, value) => (key === 'generation' ? JSON.rawJSON(String(value)) : value))}\n`,
      )
      if (payload) socket.write(payload)
    })
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > 8192) return failed()
      const newline = buffer.indexOf(10)
      if (newline < 0) return
      try {
        const reply = JSON.parse(buffer.subarray(0, newline).toString(), (key, value, context) =>
          key === 'generation' && typeof value === 'number' ? context.source : value,
        )
        const field =
          action === 'credential-refresh' ? 'refresh' : action === 'publish-initial' ? 'publication' : 'launch'
        exact(reply, ['ok', field])
        if (reply.ok !== true) return failed()
        finish(
          null,
          action === 'credential-refresh'
            ? normalizeRefreshReceipt(grant, reply[field])
            : normalizeNodeManagementReceipt(grant, reply[field]),
        )
      } catch {
        failed()
      }
    })
  })
}

export function publishNodeSlotInitial(input) {
  return commandNodeSlot(input, 'publish-initial')
}
export function launchNodeSlot(input) {
  return commandNodeSlot(input, 'launch')
}

export function refreshNodeSlotCredential(input) {
  return commandNodeSlot(input, 'credential-refresh')
}
