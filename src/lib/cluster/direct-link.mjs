/**
 * Cluster direct link: remote slot traffic over one TLS connection per request
 * to the node's kin-slot-gate, instead of a channel on the node's long-lived
 * SSH connection.
 *
 * That one SSH flow carries every remote slot request. Bursty request bodies
 * behind chatty idle traffic leave its congestion state stuck low (BBR measured
 * ~17KB/s on a path that moves 350KB/s on a fresh connection), and the whole
 * node queues behind it. Through the gate each request gets a fresh connection
 * with its own ramp-up. Docker, terminal and health stay on SSH; a gate that
 * cannot be reached falls back to SSH.
 *
 * Trust: the gate self-signs its certificate on first start; the control plane
 * reads it over the authenticated SSH link and pins its SHA-256, so no CA is
 * involved. A per-node token, sent only after the pin matched, authorizes the
 * connection. The gate reaches nothing but <root>/vms/<vm>/run/{kernel,worker}.sock.
 */

import crypto from 'node:crypto'
import { isOverlap } from '../core/handover.mjs'
import fs from 'node:fs'
import net from 'node:net'
import tls from 'node:tls'
import {
  containerAction,
  createContainerRaw,
  dockerJson,
  inspectContainerOrNull,
  removeContainer,
} from './docker-remote.mjs'
import { openSftp, readRemoteFileNoFollow, runRemote, shellQuote, writeRemoteFile } from './remote-fs.mjs'
import { ClusterError } from './ssh-link.mjs'

export const GATE_CONTAINER = 'kin-slot-gate'
export const GATE_DEFAULT_PORT = 7790
export const GATE_DIAL_TIMEOUT_MS = 3_000
const GATE_MOUNT = '/etc/kin-slot-gate'
const PREFACE = 'KSG1'
const REPLY_MAX = 64
const SLOT_IMAGE_PREFIX = 'vm2api/kin-slot-'
const CERT_WAIT_TRIES = 20
const CERT_WAIT_MS = 250

export function newGateToken() {
  return crypto.randomBytes(32).toString('hex')
}

/** `{ address, port }` from the panel. An IP literal only: no DNS on the request path. */
export function parseDirectLinkInput(body = {}) {
  const address = String(body.address ?? '').trim()
  if (!net.isIP(address)) throw new ClusterError(400, 'invalid_direct_address', '直连地址必须是 IP')
  const port = body.port == null || body.port === '' ? GATE_DEFAULT_PORT : Number(body.port)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new ClusterError(400, 'invalid_direct_port', '直连端口须为 1024–65535')
  }
  return { address, port }
}

/** Hex SHA-256 of a certificate's DER, the form stored as the pin. */
export function certSha256(pem) {
  return new crypto.X509Certificate(pem).fingerprint256.replaceAll(':', '').toLowerCase()
}

function gateError(code, message) {
  return Object.assign(new Error(message), { code })
}

/**
 * Open one gate connection for `vmId`'s `kind` socket ('kernel' | 'worker'), or
 * 'ping'. Resolves `{ sock, ready }` as soon as TLS is up, the pinned
 * certificate matched and the preface is written, so the caller can send the
 * request body without waiting a round trip (the gate buffers it). Rejects with
 * gate_unreachable or gate_cert_mismatch: nothing was sent, the caller may use SSH.
 *
 * `ready` settles when the gate answers: resolves with the socket paused and the
 * "OK" line consumed (pipe or resume it), or rejects with gate_no_socket (slot
 * socket absent, the meaning of a refused streamlocal), gate_auth,
 * gate_bad_request or gate_unreachable.
 */
export function dialGate({
  address,
  port,
  token,
  certSha256: pin,
  vmId = '-',
  kind,
  timeoutMs = GATE_DIAL_TIMEOUT_MS,
}) {
  return new Promise((resolveConn, rejectConn) => {
    if (!pin) {
      rejectConn(gateError('gate_cert_mismatch', 'no pinned gate certificate'))
      return
    }
    const sock = tls.connect({
      host: address,
      port,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
      allowHalfOpen: true,
      noDelay: true,
      keepAlive: true,
      keepAliveInitialDelay: 30_000,
    })
    let connected = false
    let resolveReady
    let rejectReady
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    ready.catch(() => {})
    let buf = Buffer.alloc(0)
    let settled = false
    const fail = (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.off('data', onData)
      sock.destroy()
      if (connected) rejectReady(err)
      else rejectConn(err)
    }
    const timer = setTimeout(() => fail(gateError('gate_unreachable', 'gate timeout')), timeoutMs)
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const nl = buf.indexOf(10)
      if (nl < 0) {
        if (buf.length > REPLY_MAX) fail(gateError('gate_bad_reply', 'gate reply too long'))
        return
      }
      const reply = buf.subarray(0, nl).toString('utf8')
      if (reply !== 'OK') {
        const code = /^ERR ([a-z_]+)$/.exec(reply)?.[1] || 'bad_reply'
        fail(gateError(`gate_${code}`, `gate refused: ${code}`))
        return
      }
      settled = true
      clearTimeout(timer)
      sock.off('data', onData)
      sock.pause()
      const rest = buf.subarray(nl + 1)
      if (rest.length) sock.unshift(rest)
      resolveReady(sock)
    }
    sock.once('secureConnect', () => {
      const presented = sock.getPeerCertificate()?.fingerprint256?.replaceAll(':', '').toLowerCase()
      if (presented !== pin) {
        fail(gateError('gate_cert_mismatch', 'gate certificate does not match the pinned one'))
        return
      }
      connected = true
      sock.on('data', onData)
      sock.write(`${PREFACE} ${token} ${vmId} ${kind}\n`)
      resolveConn({ sock, ready })
    })
    sock.once('error', (err) => fail(gateError('gate_unreachable', err.message)))
    sock.once('close', () => fail(gateError('gate_unreachable', 'gate closed')))
  })
}

/** Round trip of one authenticated ping (TCP + TLS + preface), in ms. */
export async function pingGate(link, timeoutMs = GATE_DIAL_TIMEOUT_MS) {
  const t0 = performance.now()
  const { sock, ready } = await dialGate({ ...link, kind: 'ping', timeoutMs })
  try {
    await ready
  } finally {
    sock.destroy()
  }
  return performance.now() - t0
}

/** Newest slot image on the node: the gate is a static binary and only needs a userland to start in. */
async function nodeSlotImage(docker) {
  const images = (await dockerJson(docker, { path: '/images/json', timeoutMs: 15_000 })) || []
  const slot = images
    .filter((img) => (img.RepoTags || []).some((tag) => tag.startsWith(SLOT_IMAGE_PREFIX)))
    .sort((a, b) => (b.Created || 0) - (a.Created || 0))[0]
  return slot ? slot.RepoTags.find((tag) => tag.startsWith(SLOT_IMAGE_PREFIX)) : null
}

/**
 * Container body. Root SSH logins run slots as per-slot uids with 0600 sockets,
 * so a root gate keeps only DAC_OVERRIDE (what sshd streamlocal had as root);
 * a non-root login runs slots as itself and needs no capability. Only tls/ is
 * writable, for the certificate the gate creates on first start.
 */
export function gateContainer({ host, imageRef, body, binaryDigest }) {
  const user = `${host.uid}:${host.gid}`
  const digest = crypto
    .createHash('sha256')
    .update(body)
    .update(imageRef)
    .update(user)
    .update(binaryDigest)
    .digest('hex')
    .slice(0, 16)
  const vms = `${host.root}/vms`
  return {
    digest,
    spec: {
      Image: imageRef,
      User: user,
      Entrypoint: [`${GATE_MOUNT}/kin-slot-gate`],
      Cmd: ['-config', `${GATE_MOUNT}/gate.json`],
      Labels: { 'kin.gate': '1', 'kin.gate.cfg': digest, 'vm2api.cluster': '1' },
      HostConfig: {
        NetworkMode: 'host',
        Binds: [`${host.root}/gate:${GATE_MOUNT}:ro`, `${host.root}/gate/tls:${GATE_MOUNT}/tls`, `${vms}:${vms}:ro`],
        RestartPolicy: { Name: 'unless-stopped' },
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        CapAdd: host.uid === 0 ? ['DAC_OVERRIDE'] : [],
        SecurityOpt: ['no-new-privileges'],
      },
    },
  }
}

export function gateConfigBody({ host, link }) {
  return `${JSON.stringify({ listen: `0.0.0.0:${link.port}`, root: host.root, token: link.token, tls_dir: `${GATE_MOUNT}/tls` }, null, 2)}\n`
}

async function readGateCert(client, host) {
  for (let i = 0; i < CERT_WAIT_TRIES; i += 1) {
    const pem = await readRemoteFileNoFollow(client, `${host.root}/gate/tls/cert.pem`, { maxBytes: 16 * 1024 })
    if (pem?.length) return certSha256(pem)
    await new Promise((resolve) => setTimeout(resolve, CERT_WAIT_MS))
  }
  throw new ClusterError(502, 'gate_cert_missing', '节点上的 kin-slot-gate 没有生成证书，查看该容器日志')
}

/**
 * Create or refresh the node's gate, then read its certificate over SSH for
 * pinning. Idempotent: a running gate with the same spec is kept.
 */
export async function ensureNodeGate({ client, host, docker }, link, gateBin) {
  let binary
  try {
    binary = fs.readFileSync(gateBin)
  } catch {
    throw new ClusterError(500, 'gate_binary_missing', `控制面缺少 ${gateBin}`)
  }
  const imageRef = await nodeSlotImage(docker)
  if (!imageRef) throw new ClusterError(409, 'gate_image_missing', '节点上还没有槽位镜像，先在该节点建一个槽')
  const body = gateConfigBody({ host, link })
  const binaryDigest = crypto.createHash('sha256').update(binary).digest('hex')
  const { digest, spec } = gateContainer({ host, imageRef, body, binaryDigest })
  const existing = await inspectContainerOrNull(docker, GATE_CONTAINER)
  let changed = false
  const running = existing?.State?.Running && !existing.State.Restarting
  if (running && existing.Config?.Labels?.['kin.gate.cfg'] !== digest && isOverlap()) {
    // Blue/green overlap: recreating the gate would cut the draining controller's direct streams.
    // The caller retries once the overlap ends.
    return { changed: false, deferred: true, image: imageRef, certSha256: await readGateCert(client, host) }
  }
  if (!(running && existing.Config?.Labels?.['kin.gate.cfg'] === digest)) {
    const dir = `${host.root}/gate`
    await runRemote(
      client,
      `umask 077 && mkdir -p ${shellQuote(`${dir}/tls`)} && chmod 700 ${shellQuote(dir)} ${shellQuote(`${dir}/tls`)}`,
    )
    const sftp = await openSftp(client)
    await writeRemoteFile(sftp, `${dir}/kin-slot-gate`, binary, { mode: 0o755 })
    await writeRemoteFile(sftp, `${dir}/gate.json`, body, { mode: 0o600 })
    if (existing) await removeContainer(docker, GATE_CONTAINER)
    await createContainerRaw(docker, GATE_CONTAINER, spec)
    await containerAction(docker, GATE_CONTAINER, 'start')
    changed = true
  }
  return { changed, image: imageRef, certSha256: await readGateCert(client, host) }
}

export async function removeNodeGate({ client, host, docker }) {
  if (await inspectContainerOrNull(docker, GATE_CONTAINER)) await removeContainer(docker, GATE_CONTAINER)
  await runRemote(client, `rm -rf ${shellQuote(`${host.root}/gate`)}`)
}
