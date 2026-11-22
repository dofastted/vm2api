import { panelIdentity } from './panel-acl.mjs'
import { sameOriginPost } from './crag-shop.mjs'

const ROOT = '/api/panel/crag-subscription'
const BIND = /^\/api\/panel\/vms\/([^/]+)\/crag-license\/bind$/

export function cragSubscriptionRoute(method, path) {
  if (method === 'GET' && path === ROOT) return { action: 'status' }
  if (method !== 'POST') return null
  if (path === `${ROOT}/redeem`) return { action: 'redeem' }
  if (path === `${ROOT}/recover`) return { action: 'recover' }
  if (path === `${ROOT}/upgrade`) return { action: 'upgrade' }
  if (path === `${ROOT}/unbind`) return { action: 'unbind' }
  const match = BIND.exec(path)
  return match ? { action: 'bind', id: match[1] } : null
}

const messages = {
  forbidden: 'Sign in as a panel administrator to manage the host subscription.',
  crag_subscription_origin_denied: 'Submit the request from this panel.',
  crag_subscription_json_required: 'Expected application/json.',
  crag_subscription_invalid_request: 'Invalid host subscription request.',
  crag_subscription_body_too_large: 'Host subscription request is too large.',
  crag_subscription_host_identity_unavailable: 'Provide a readable host identity before retrying.',
  crag_subscription_host_identity_changed: 'Restore the original host identity before retrying.',
  crag_subscription_storage_unavailable: 'Check the host subscription data directory before retrying.',
  crag_subscription_host_package_unready: 'Install or restore the trusted CRAG host package before retrying.',
  crag_subscription_host_package_changed:
    'The CRAG package changed during redemption. Confirm recovery with the current trusted package.',
  crag_subscription_recovery_unverified:
    'Existing host rights cannot confirm this voucher. Keep the original order and ask the administrator to reconcile it.',
  crag_subscription_invalid_redemption_receipt:
    'The saved redemption receipt could not be verified. Keep the original order and check the host subscription data.',
  payload_key_unknown:
    'The authorization service no longer offers the CRAG package key this redemption recorded. Keep the original record and contact the administrator with the request ID.',
  issuer_mismatch:
    'The CRAG issuer this redemption recorded does not match the authorization service. Restore the matching trusted package before retrying.',
  auth_forbidden:
    'The authorization service rejected this host request. Contact the administrator with the request ID; do not reset the host credential.',
  host_transfer_cooldown:
    'This host was retired too recently. Its vouchers become transferable again once the cooldown ends; see cooldown_until on the last retirement.',
  vm_not_found: 'VM not found.',
  crag_subscription_failed: 'The host subscription operation failed. Refresh its status before retrying.',
}

export function createCragSubscriptionHandler({ subscription, getVm, publicBaseUrl, json, readRawBody }) {
  const reject = (res, status, code, authorityRequestId) =>
    json(res, status, {
      ok: false,
      error: {
        code,
        message: Object.hasOwn(messages, code) ? messages[code] : messages.crag_subscription_failed,
        ...(authorityRequestId && { details: { authority_request_id: authorityRequestId } }),
      },
    })
  const ok = (res, data) => json(res, 200, { ok: true, data })

  return async (req, res, { action, id }) => {
    res.setHeader('Cache-Control', 'no-store')
    const identity = panelIdentity(req)
    // The master API key is the operator's own automation (seat binding for new slots); it is not a browser
    // session, so the same-origin CSRF guard does not apply to it.
    const master = req.apiKeyKind === 'master'
    if (!master && (req.apiKeyKind || !identity.user || identity.role !== 'admin')) return reject(res, 403, 'forbidden')

    let body
    if (action !== 'status') {
      if (!master && !sameOriginPost(req, publicBaseUrl)) return reject(res, 403, 'crag_subscription_origin_denied')
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
        return reject(res, 415, 'crag_subscription_json_required')
      }
      try {
        body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readRawBody(req, 8192)))
      } catch (error) {
        return error?.status === 413
          ? reject(res, 413, 'crag_subscription_body_too_large')
          : reject(res, 400, 'crag_subscription_invalid_request')
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return reject(res, 400, 'crag_subscription_invalid_request')
      }
      const valid =
        action === 'redeem'
          ? Object.keys(body).length === 1 && typeof body.redemption_code === 'string'
          : action === 'recover'
            ? Object.keys(body).length === 0 || (Object.keys(body).length === 1 && body.use_current_package === true)
            : Object.keys(body).length === 0
      if (!valid) return reject(res, 400, 'crag_subscription_invalid_request')
    }

    try {
      if (action === 'redeem') return ok(res, await subscription.redeem(body.redemption_code))
      if (action === 'upgrade') return ok(res, await subscription.upgrade())
      if (action === 'unbind') return ok(res, await subscription.unbind())
      if (action === 'bind') {
        const vm = getVm(id)
        if (!vm) return reject(res, 404, 'vm_not_found')
        return ok(res, await subscription.bind(vm))
      }
      if (action === 'recover') await subscription.recover({ useCurrentPackage: body.use_current_package === true })
      return ok(res, await subscription.status())
    } catch (error) {
      // Do not echo vendor responses, local paths, or voucher inputs to the panel.
      if (
        !Number.isInteger(error?.status) ||
        error.status < 400 ||
        error.status > 599 ||
        !/^[a-z][a-z0-9_]{1,63}$/.test(error?.code || '')
      ) {
        return reject(res, 500, 'crag_subscription_failed')
      }
      return reject(res, error.status === 401 ? 502 : error.status, error.code, error.authorityRequestId)
    }
  }
}
