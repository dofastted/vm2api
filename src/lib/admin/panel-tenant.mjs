import { getVm } from '../vm/vm-registry.mjs'
import { makeError, ErrorType, ErrorCode } from '../core/errors.mjs'
import { panelIdentity } from './panel-acl.mjs'
import { canUserDeleteVm, normalizeOwnerId, proxyOwnerId, vmOwnerId } from './resource-owner.mjs'

const VM_COLLECTION = new Set([
  'create',
  'create-options',
  'import',
  'package',
  'fleet-status',
  'fleet-update',
  'reconcile-fingerprints',
])

export function panelVmIdFromPath(path) {
  const m = String(path || '').match(/^\/api\/panel\/vms\/([^/]+)/)
  if (!m) return null
  const id = m[1]
  if (VM_COLLECTION.has(id)) return null
  return id
}

export function denyIfUserMissesVm(req, res, { projectRoot, json, path }) {
  const ident = panelIdentity(req)
  if (ident.role !== 'user') return false
  const id = panelVmIdFromPath(path)
  if (!id) return false
  const vm = getVm(projectRoot, id)
  if (!vm || vmOwnerId(vm) !== normalizeOwnerId(req.panelUserId)) {
    json(
      res,
      404,
      makeError({
        type: ErrorType.NOT_FOUND,
        code: ErrorCode.VM_NOT_FOUND,
        message: 'vm not found',
        status: 404,
      }).body,
    )
    return true
  }
  return false
}

export function denyIfUserCannotDeleteVm(req, res, vm, json) {
  const ident = panelIdentity(req)
  if (ident.role === 'admin') return false
  if (ident.role === 'user' && canUserDeleteVm(vm, req.panelUserId)) return false
  json(
    res,
    403,
    makeError({
      type: ErrorType.PERMISSION,
      code: 'forbidden',
      message: '当前权限无法执行此操作',
      status: 403,
    }).body,
  )
  return true
}

export function denyIfUserMissesKey(req, res, { apiKeyStore, json, keyId }) {
  const ident = panelIdentity(req)
  if (ident.role !== 'user') return false
  const rec = apiKeyStore?.repo?.getById?.(keyId) || null
  const owner = normalizeOwnerId(rec?.user_id)
  if (!rec || owner !== normalizeOwnerId(req.panelUserId)) {
    json(res, 404, { ok: false, error: { message: 'api key not found' } })
    return true
  }
  return false
}

const PROXY_COLLECTION = new Set(['import', 'config', 'probe'])

export function denyIfUserMissesProxy(req, res, { proxyPool, json, path }) {
  const ident = panelIdentity(req)
  if (ident.role !== 'user') return false
  const m = String(path || '').match(/^\/api\/panel\/proxies\/([^/]+)/)
  if (!m || PROXY_COLLECTION.has(m[1])) return false
  const row = (proxyPool?.state?.proxies || []).find((p) => p.id === m[1])
  if (!row || proxyOwnerId(row) !== normalizeOwnerId(req.panelUserId)) {
    json(res, 404, { ok: false, error: { message: 'proxy not found' } })
    return true
  }
  return false
}
