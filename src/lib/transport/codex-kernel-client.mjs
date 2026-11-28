/**
 * Codex kernel hop client. Same Unix-socket + internal token contract as
 * go-worker-client, socket is run/codex-kernel.sock.
 */
import crypto from 'node:crypto'
import path from 'node:path'
import zlib from 'node:zlib'
import { maxRequestBytes } from '../core/config.mjs'
import { callGoWorker, interruptWorker, streamGoWorker, workerHealth, workerPaths } from './go-worker-client.mjs'
import http from 'node:http'
import fs from 'node:fs'

const UDS_PACKED_BUDGET_BYTES = 32 * 1024 * 1024
const UDS_PACKED_MAX_ENTRIES = 64
const UDS_PACKED_TTL_MS = 280_000
const UDS_MIN_DELTA_COPY_BYTES = 256
const UDS_MIN_GZIP_BYTES = 256
const UDS_ANCHOR_LEN = 64
const UDS_ROLL_BASE = 257
const UDS_ROLL_POW = (() => {
  let p = 1
  for (let i = 1; i < UDS_ANCHOR_LEN; i += 1) p = Math.imul(p, UDS_ROLL_BASE) >>> 0
  return p
})()
const SHA256_HEX_RE = /^[0-9a-f]{64}$/

const socketCapabilities = new Map()
const slotBasePools = new Map()

export function resetCodexKernelClientCachesForTests() {
  socketCapabilities.clear()
  slotBasePools.clear()
}

export function codexKernelPaths(exec = {}) {
  const base = workerPaths(exec)
  const runDir = base.runDir
  return {
    runDir,
    socketPath: exec.vm?.runtime?.codex_kernel_socket || (runDir ? path.join(runDir, 'codex-kernel.sock') : null),
    tokenPath: base.tokenPath,
    configPath: runDir ? path.join(runDir, 'codex-kernel.json') : null,
    credentialPath: runDir ? path.join(path.dirname(runDir), 'codex-credentials.json') : null,
  }
}

export function withCodexKernelExec(exec) {
  const paths = codexKernelPaths(exec)
  return {
    ...exec,
    vm: {
      ...(exec?.vm || {}),
      runtime: {
        ...(exec?.vm?.runtime || {}),
        worker_socket: paths.socketPath,
        worker_token_file: paths.tokenPath,
        worker_run_dir: paths.runDir,
      },
    },
  }
}

function poolKeyOf(exec) {
  const paths = codexKernelPaths(exec)
  return paths.socketPath || exec?.vmId || exec?.vm?.id || 'default'
}

function capabilityMatchesPacked(status = null) {
  if (!status || typeof status !== 'object') return false
  if (status.uds_packed_v1 === true) return true
  return Array.isArray(status.capabilities) && status.capabilities.includes('uds_packed_v1')
}

function recordSocketCapabilities(exec, status) {
  const { socketPath } = codexKernelPaths(exec)
  if (!socketPath || !status || typeof status !== 'object' || status.ok === false) return
  if (capabilityMatchesPacked(status)) {
    socketCapabilities.set(socketPath, {
      udsPackedV1: true,
      capabilities: Array.isArray(status.capabilities) ? [...status.capabilities] : ['uds_packed_v1'],
      updatedAt: Date.now(),
    })
  } else if (status.abi != null || Array.isArray(status.capabilities)) {
    socketCapabilities.set(socketPath, {
      udsPackedV1: false,
      capabilities: Array.isArray(status.capabilities) ? [...status.capabilities] : [],
      updatedAt: Date.now(),
    })
  }
}

function canUseUdsPacked(exec, opts = {}) {
  if (opts.requestPath && opts.requestPath !== '/internal/v1/codex/responses/packed') return false
  if (capabilityMatchesPacked(exec?.workerStatus)) return true
  const { socketPath } = codexKernelPaths(exec)
  return !!(socketPath && socketCapabilities.get(socketPath)?.udsPackedV1)
}

function getBasePool(key) {
  let pool = slotBasePools.get(key)
  if (!pool) {
    pool = { entries: new Map(), sessionLatest: new Map(), mruBase: null, totalBytes: 0 }
    slotBasePools.set(key, pool)
  }
  return pool
}

function pruneBasePool(pool, now = Date.now()) {
  for (const [sha, entry] of pool.entries) {
    if (now - entry.at >= UDS_PACKED_TTL_MS) {
      pool.entries.delete(sha)
      pool.totalBytes = Math.max(0, pool.totalBytes - entry.rawBuf.length)
      if (entry.sessionId && pool.sessionLatest.get(entry.sessionId) === sha) {
        pool.sessionLatest.delete(entry.sessionId)
      }
      if (pool.mruBase === sha) pool.mruBase = null
    }
  }
  if (!pool.mruBase && pool.entries.size) {
    let latestSha = null
    for (const sha of pool.entries.keys()) latestSha = sha
    pool.mruBase = latestSha
  }
}

function pickCandidateBase(exec, sessionId = '') {
  const pool = slotBasePools.get(poolKeyOf(exec))
  if (!pool) return null
  pruneBasePool(pool)
  const trySha = (sha) => {
    if (!sha) return null
    const entry = pool.entries.get(sha)
    if (!entry) return null
    return { baseSha: sha, baseBuf: entry.rawBuf }
  }
  return (sessionId && trySha(pool.sessionLatest.get(sessionId))) || trySha(pool.mruBase)
}

function rememberBase(exec, { sessionId = '', baseSha = '', rawBuf } = {}) {
  if (!SHA256_HEX_RE.test(baseSha) || !Buffer.isBuffer(rawBuf) || rawBuf.length > UDS_PACKED_BUDGET_BYTES) return
  const expectedSha = crypto.createHash('sha256').update(rawBuf).digest('hex')
  if (expectedSha !== baseSha) return
  const pool = getBasePool(poolKeyOf(exec))
  pruneBasePool(pool)
  const existing = pool.entries.get(baseSha)
  if (existing) {
    pool.entries.delete(baseSha)
    pool.totalBytes = Math.max(0, pool.totalBytes - existing.rawBuf.length)
  }
  while (
    pool.entries.size >= UDS_PACKED_MAX_ENTRIES ||
    (pool.totalBytes + rawBuf.length > UDS_PACKED_BUDGET_BYTES && pool.entries.size > 0)
  ) {
    const oldest = pool.entries.entries().next().value
    if (!oldest) break
    const [oldSha, oldEntry] = oldest
    pool.entries.delete(oldSha)
    pool.totalBytes = Math.max(0, pool.totalBytes - oldEntry.rawBuf.length)
    if (oldEntry.sessionId && pool.sessionLatest.get(oldEntry.sessionId) === oldSha) {
      pool.sessionLatest.delete(oldEntry.sessionId)
    }
    if (pool.mruBase === oldSha) pool.mruBase = null
  }
  pool.entries.set(baseSha, { at: Date.now(), sessionId, rawBuf })
  pool.totalBytes += rawBuf.length
  if (sessionId) pool.sessionLatest.set(sessionId, baseSha)
  pool.mruBase = baseSha
}

function evictBase(exec, baseSha = '') {
  if (!baseSha) return
  const pool = slotBasePools.get(poolKeyOf(exec))
  if (!pool) return
  const entry = pool.entries.get(baseSha)
  if (!entry) return
  pool.entries.delete(baseSha)
  pool.totalBytes = Math.max(0, pool.totalBytes - entry.rawBuf.length)
  if (entry.sessionId && pool.sessionLatest.get(entry.sessionId) === baseSha) {
    pool.sessionLatest.delete(entry.sessionId)
  }
  if (pool.mruBase === baseSha) {
    pool.mruBase = null
    for (const sha of pool.entries.keys()) pool.mruBase = sha
  }
}

function hash64Window(buf, start) {
  let h = 0
  for (let i = 0; i < UDS_ANCHOR_LEN; i += 1) {
    h = (Math.imul(h, UDS_ROLL_BASE) + buf[start + i]) >>> 0
  }
  return h
}

function bytesEqual64(a, aStart, b, bStart) {
  for (let i = 0; i < UDS_ANCHOR_LEN; i += 1) {
    if (a[aStart + i] !== b[bStart + i]) return false
  }
  return true
}

export function findUdsCopySpan(baseBuf, targetBuf) {
  if (!Buffer.isBuffer(baseBuf) || !Buffer.isBuffer(targetBuf)) return null
  const minLen = Math.min(baseBuf.length, targetBuf.length)
  if (minLen < UDS_MIN_DELTA_COPY_BYTES) return null

  let prefixLen = 0
  while (prefixLen < minLen && baseBuf[prefixLen] === targetBuf[prefixLen]) prefixLen += 1
  if (prefixLen >= minLen * 0.5 && prefixLen >= UDS_MIN_DELTA_COPY_BYTES) {
    return { offset: 0, insert: 0, count: prefixLen }
  }

  let best = prefixLen >= UDS_MIN_DELTA_COPY_BYTES ? { offset: 0, insert: 0, count: prefixLen } : null
  // Cap anchor stride so every >= UDS_MIN_DELTA_COPY_BYTES match contains at least one base anchor regardless of byte shift.
  const maxGuaranteedStride = UDS_MIN_DELTA_COPY_BYTES - UDS_ANCHOR_LEN
  const stride = Math.max(64, Math.min(maxGuaranteedStride, Math.ceil(baseBuf.length / 2048)))
  const anchors = new Map()
  for (let pos = 0; pos + UDS_ANCHOR_LEN <= baseBuf.length; pos += stride) {
    const key = hash64Window(baseBuf, pos)
    const cur = anchors.get(key)
    if (cur === undefined) anchors.set(key, pos)
    else if (typeof cur === 'number') anchors.set(key, [cur, pos])
    else if (cur.length < 4) cur.push(pos)
  }
  if (!anchors.size) return best

  let tPos = 0
  let h = hash64Window(targetBuf, 0)
  while (tPos + UDS_ANCHOR_LEN <= targetBuf.length) {
    const slot = anchors.get(h)
    let advancedRight = 0
    if (slot !== undefined) {
      const candidates = typeof slot === 'number' ? [slot] : slot
      for (const basePos of candidates) {
        if (!bytesEqual64(baseBuf, basePos, targetBuf, tPos)) continue
        let left = 0
        while (left < basePos && left < tPos && baseBuf[basePos - left - 1] === targetBuf[tPos - left - 1]) {
          left += 1
        }
        let right = UDS_ANCHOR_LEN
        while (
          basePos + right < baseBuf.length &&
          tPos + right < targetBuf.length &&
          baseBuf[basePos + right] === targetBuf[tPos + right]
        ) {
          right += 1
        }
        const count = left + right
        if (count >= UDS_MIN_DELTA_COPY_BYTES && (!best || count > best.count)) {
          best = { offset: basePos - left, insert: tPos - left, count }
        }
        if (right > advancedRight) advancedRight = right
      }
    }
    if (advancedRight > 1) {
      tPos += advancedRight
      if (tPos + UDS_ANCHOR_LEN <= targetBuf.length) h = hash64Window(targetBuf, tPos)
    } else {
      if (tPos + UDS_ANCHOR_LEN < targetBuf.length) {
        const outTerm = Math.imul(targetBuf[tPos], UDS_ROLL_POW) >>> 0
        h = (Math.imul((h - outTerm) >>> 0, UDS_ROLL_BASE) + targetBuf[tPos + UDS_ANCHOR_LEN]) >>> 0
      }
      tPos += 1
    }
  }
  return best
}

function compressUdsWireBody(plainBuf) {
  if (plainBuf.length >= UDS_MIN_GZIP_BYTES) {
    const gz = zlib.gzipSync(plainBuf, { level: 1 })
    if (gz.length < plainBuf.length) {
      return { wireBody: gz, encoding: 'gzip' }
    }
  }
  return { wireBody: plainBuf, encoding: 'identity' }
}

export const udsPackedCodec = {
  prepare({ exec, rawBuf, sessionId = '' }) {
    const stored = rawBuf.length <= UDS_PACKED_BUDGET_BYTES
    const candidate = pickCandidateBase(exec, sessionId)
    const span = candidate ? findUdsCopySpan(candidate.baseBuf, rawBuf) : null
    const plainWire = span
      ? Buffer.concat([rawBuf.subarray(0, span.insert), rawBuf.subarray(span.insert + span.count)])
      : rawBuf
    const { wireBody, encoding } = compressUdsWireBody(plainWire)
    const headers = {
      'content-encoding': encoding,
      ...(stored ? { 'x-kin-uds-store': '1' } : {}),
      ...(span
        ? {
            'x-kin-uds-base': candidate.baseSha,
            'x-kin-uds-copy': `${span.offset},${span.insert},${span.count}`,
          }
        : {}),
    }
    return {
      wireBody,
      headers,
      stored,
      baseSent: span ? candidate.baseSha : null,
      rawBytes: rawBuf.length,
      wireBytes: wireBody.length,
    }
  },
  prepareFull({ rawBuf }) {
    const stored = rawBuf.length <= UDS_PACKED_BUDGET_BYTES
    const { wireBody, encoding } = compressUdsWireBody(rawBuf)
    return {
      wireBody,
      headers: {
        'content-encoding': encoding,
        ...(stored ? { 'x-kin-uds-store': '1' } : {}),
      },
      stored,
      baseSent: null,
      rawBytes: rawBuf.length,
      wireBytes: wireBody.length,
    }
  },
  remember: rememberBase,
  evict: evictBase,
}

function remapVia(result) {
  if (!result || typeof result !== 'object') return result
  return {
    ...result,
    via: String(result.via || 'go-worker').replace(/go-worker/g, 'codex-kernel'),
  }
}

export async function callCodexKernel(opts = {}) {
  const exec = withCodexKernelExec(opts.exec)
  const usePacked = canUseUdsPacked(exec, opts)
  return remapVia(
    await callGoWorker({
      ...opts,
      maxRequestBytes: maxRequestBytes(opts.routing),
      exec,
      requestPath: usePacked
        ? '/internal/v1/codex/responses/packed'
        : opts.requestPath || '/internal/v1/codex/responses',
      ...(usePacked ? { packedCodec: udsPackedCodec } : {}),
    }),
  )
}

export async function streamCodexKernel(opts = {}) {
  const exec = withCodexKernelExec(opts.exec)
  const usePacked = canUseUdsPacked(exec, opts)
  return remapVia(
    await streamGoWorker({
      ...opts,
      maxRequestBytes: maxRequestBytes(opts.routing),
      exec,
      requestPath: usePacked
        ? '/internal/v1/codex/responses/packed'
        : opts.requestPath || '/internal/v1/codex/responses',
      ...(usePacked ? { packedCodec: udsPackedCodec } : {}),
    }),
  )
}

export async function interruptCodexKernel(exec, opts = {}) {
  return interruptWorker(withCodexKernelExec(exec), opts)
}

export async function codexKernelDescribe(exec, { timeoutMs = 2000 } = {}) {
  const mapped = withCodexKernelExec(exec)
  const paths = codexKernelPaths(mapped)
  if (!paths.socketPath || !paths.tokenPath) return { ok: false, status: 0, code: 'worker_socket_missing' }
  let token = ''
  try {
    token = fs.readFileSync(paths.tokenPath, 'utf8').trim()
  } catch {
    return { ok: false, status: 0, code: 'worker_token_missing' }
  }
  return new Promise((resolve) => {
    const req = http.request(
      {
        socketPath: paths.socketPath,
        path: '/internal/v1/describe',
        method: 'GET',
        headers: {
          'x-kin-internal-token': token,
          'x-internal-token': token,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            const status = res.statusCode || 0
            if (status === 200 && parsed && typeof parsed === 'object') {
              recordSocketCapabilities(mapped, parsed)
              resolve({ ok: true, status, ...parsed })
              return
            }
            resolve({ ok: false, status, body: parsed })
          } catch {
            resolve({ ok: false, status: res.statusCode || 0 })
          }
        })
      },
    )
    req.on('timeout', () => {
      req.destroy(Object.assign(new Error('describe timeout'), { code: 'worker_timeout' }))
    })
    req.on('error', (error) => resolve({ ok: false, status: 0, code: error.code || 'worker_unavailable' }))
    req.end()
  })
}

export async function codexKernelHealth(exec, opts = {}) {
  const mapped = withCodexKernelExec(exec)
  const health = await workerHealth(mapped, opts)
  recordSocketCapabilities(mapped, health)
  if (health?.source) {
    return { ...health, source: String(health.source).replace(/go-worker/g, 'codex-kernel') }
  }
  return health
}
