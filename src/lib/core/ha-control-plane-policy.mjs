import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'

export function haUnsupported() {
  return Object.assign(new Error('该操作暂不支持多副本部署'), { code: 'ha_operation_unsupported', status: 503 })
}

/** Read the bootstrap-mounted trust once; VM records cannot replace it. */
export function loadHaNodeTrust(file) {
  try {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error()
    const input = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!input || Object.keys(input).length !== 1 || !input.nodes || Array.isArray(input.nodes)) throw new Error()
    const nodes = Object.create(null)
    for (const [id, value] of Object.entries(input.nodes)) {
      if (
        !/^[A-Za-z0-9_-]{1,128}$/.test(id) ||
        !value ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(',') !== 'address,certSha256,policyDigest,port,presetId,token' ||
        !net.isIP(value.address) ||
        !Number.isInteger(value.port) ||
        value.port < 1 ||
        value.port > 65535 ||
        typeof value.token !== 'string' ||
        !/^[\x21-\x7e]{1,256}$/.test(value.token) ||
        !/^[a-f0-9]{64}$/.test(value.certSha256) ||
        !/^[a-f0-9]{64}$/.test(value.policyDigest) ||
        value.presetId !== 'claude-docker-v1'
      )
        throw new Error()
      nodes[id] = Object.freeze({ ...value })
    }
    if (!Object.keys(nodes).length) throw new Error()
    return Object.freeze(nodes)
  } catch {
    // A malformed trust file can contain transport credentials. Never echo it.
    throw Object.assign(new Error('HA node trust is unavailable'), { code: 'ha_node_trust_unavailable', status: 503 })
  }
}

const inference = new Set([
  '/v1/messages',
  '/messages',
  '/v1/chat/completions',
  '/chat/completions',
  '/v1/completions',
  '/completions',
  '/v1/responses',
  '/responses',
])
const panelReads = new Set([
  'me',
  'users',
  'api-keys',
  'vm-pools',
  'database/metrics',
  'version',
  'changelog',
  'dashboard',
  'vms',
  'pool/stream',
  'models',
  'model-policy',
  'pricing',
  'routing',
  'request-logs',
  'usage-logs',
  'statistics',
  'billing',
])

/** Only the supported HA operations enter a legacy HTTP/WS handler. */
export function haRouteAllowed(method, pathname, { upgrade = false } = {}) {
  if (upgrade) return method === 'GET' && ['/v1/responses', '/responses'].includes(pathname)
  if (inference.has(pathname)) return ['POST', 'GET'].includes(method)
  if (pathname === '/v1/models') return method === 'GET'
  if (['/healthz', '/readyz', '/health'].includes(pathname)) return method === 'GET' || method === 'HEAD'
  if (pathname.startsWith('/api/panel/')) {
    const suffix = pathname.slice('/api/panel/'.length)
    if (method === 'GET') {
      if (panelReads.has(suffix)) return true
      return /^(?:request-logs|usage-logs|statistics|api-keys|users)\/[^/]+$/.test(suffix)
    }
    if (method === 'POST' && ['login', 'logout', 'api-keys'].includes(suffix)) return true
    if (['PUT', 'DELETE'].includes(method) && /^api-keys\/[^/]+$/.test(suffix)) return true
    return method === 'PUT' && ['routing', 'model-policy', 'pricing/overrides'].includes(suffix)
  }
  if (pathname.startsWith('/admin')) {
    return (
      method === 'GET' && ['/admin/routing', '/admin/quota', '/admin/vms', '/admin/usage/summary'].includes(pathname)
    )
  }
  // Static assets and unknown public paths retain normal GET/HEAD handling.
  return !pathname.startsWith('/api/') && (method === 'GET' || method === 'HEAD')
}

/** Kernel, credentials, payload and egress remain node-owned immutable assets. */
export function assertHaRoutingPatch(patch) {
  const allowed = new Set([
    'sticky',
    'quota',
    'concurrency',
    'pool',
    'failover',
    'websocket',
    'logging',
    'tiers',
    'rate_limit',
  ])
  if (
    !patch ||
    typeof patch !== 'object' ||
    Array.isArray(patch) ||
    Object.keys(patch).some((key) => !allowed.has(key))
  ) {
    throw haUnsupported()
  }
}
