import { forwardApi, readApiJson } from '../transport/api-kernel-client.mjs'

const MESSAGES = {
  subscription_identity_required: '请先导入包含账号和组织身份的 Claude 凭据',
  subscription_session_invalid: '需要 sk-ant-sid 开头的 Claude 网页 sessionKey',
  subscription_session_expired: '网页 sessionKey 已失效，请重新保存',
  subscription_account_mismatch: 'sessionKey 的账号或组织与当前槽位不一致',
  subscription_access_denied: 'Claude 网页访问受限或当前账号无账单读取权限',
  subscription_rate_limited: 'Claude 查询频率受限，请稍后重试',
  subscription_response_invalid: 'Claude 订阅数据格式无法识别',
  subscription_request_failed: 'Claude 订阅查询失败，请稍后重试',
  subscription_encryption_required: '保存订阅查询凭据需要配置 VM2API_DB_SECRET 或 KIN_DB_SECRET',
  subscription_credential_missing: '请先保存订阅查询 sessionKey',
  subscription_changed: '账号或查询凭据已变更，请重新查询',
}

export function subscriptionError(code, status = 502) {
  return Object.assign(new Error(MESSAGES[code] || MESSAGES.subscription_request_failed), { code, status })
}

export function subscriptionIdentity(vm) {
  const account_uuid = vm?.claude?.account_uuid || vm?.account_uuid
  const org_uuid = vm?.claude?.org_uuid || vm?.org_uuid
  return account_uuid && org_uuid ? { vm_id: vm.id, account_uuid, org_uuid } : null
}

export function normalizeSubscriptionSessionKey(value) {
  if (typeof value !== 'string' || !/^sk-ant-sid[A-Za-z0-9_-]{1,4096}$/.test(value.trim())) {
    throw subscriptionError('subscription_session_invalid', 400)
  }
  return value.trim()
}

function billingDate(value) {
  if (value == null) return null
  if (typeof value !== 'string') throw subscriptionError('subscription_response_invalid')
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value)
  if (!dateOnly && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw subscriptionError('subscription_response_invalid')
  }
  const time = Date.parse(value)
  const day = new Date(value.slice(0, 10))
  if (!Number.isFinite(time) || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw subscriptionError('subscription_response_invalid')
  }
  return { value: dateOnly ? value : new Date(time).toISOString(), date_only: dateOnly }
}

export function parseClaudeSubscription(body) {
  const fields = ['next_charge_at', 'next_charge_date', 'plan_ending_at', 'plan_ending_before']
  if (
    !body ||
    !['active', 'trialing', 'canceled'].includes(body.status) ||
    !fields.every((key) => Object.hasOwn(body, key))
  ) {
    throw subscriptionError('subscription_response_invalid')
  }
  const end = billingDate(body.plan_ending_at) || billingDate(body.plan_ending_before)
  const renew =
    !end && body.status !== 'canceled' ? billingDate(body.next_charge_at) || billingDate(body.next_charge_date) : null
  return {
    status: body.status,
    expires_at: end?.value || null,
    expires_date_only: end?.date_only || false,
    renews_at: renew?.value || null,
    renews_date_only: renew?.date_only || false,
  }
}

function verifiedOrganization(account, identity) {
  if (account?.uuid !== identity.account_uuid || !Array.isArray(account.memberships)) {
    throw subscriptionError('subscription_account_mismatch', 409)
  }
  const membership = account.memberships.find((item) => item?.organization?.uuid === identity.org_uuid)
  if (!membership) throw subscriptionError('subscription_account_mismatch', 409)
  return membership.organization
}

function planName(org, account) {
  const tier = String(org.rate_limit_tier || org.organization_type || '').toLowerCase()
  if (tier.includes('max')) {
    const multiplier = tier.match(/(?:^|_)(5|20)x(?:_|$)/)?.[1]
    return multiplier ? `Max ${multiplier}x` : 'Max'
  }
  if (tier.includes('enterprise')) return 'Enterprise'
  if (tier.includes('team')) return 'Team'
  if (tier.includes('pro')) return 'Pro'
  if (account.has_claude_max === true) return 'Max'
  if (account.has_claude_pro === true) return 'Pro'
  return null
}

/** Fixed-origin GETs only. Never exchanges the cookie for OAuth or touches inference credentials. */
export async function queryClaudeSubscription({ vm, sessionKey, cfg, proxyUrl, request }) {
  const identity = subscriptionIdentity(vm)
  if (!identity) throw subscriptionError('subscription_identity_required', 400)
  const cookie = normalizeSubscriptionSessionKey(sessionKey)
  const signal = AbortSignal.timeout(15_000)
  const transport =
    request ||
    (async (url, options) => {
      const response = await forwardApi({ cfg, proxyUrl, url, ...options, body: '', timeoutMs: 15_000 })
      return { status: response.statusCode, body: await readApiJson(response, 256 * 1024) }
    })
  async function get(path) {
    let response
    try {
      response = await transport(`https://claude.ai/api${path}`, {
        method: 'GET',
        headers: { Cookie: `sessionKey=${cookie}`, Accept: 'application/json' },
        signal,
      })
    } catch {
      throw subscriptionError('subscription_request_failed')
    }
    if (response.status === 401) throw subscriptionError('subscription_session_expired', 422)
    if (response.status === 403) throw subscriptionError('subscription_access_denied')
    if (response.status === 429) throw subscriptionError('subscription_rate_limited', 429)
    if (response.status !== 200) throw subscriptionError('subscription_request_failed')
    return response.body
  }
  const account = await get('/account')
  const org = verifiedOrganization(account, identity)
  const dates = parseClaudeSubscription(
    await get(`/organizations/${encodeURIComponent(identity.org_uuid)}/subscription_details`),
  )
  verifiedOrganization(await get('/account'), identity)
  return { ...dates, plan: planName(org, account), fetched_at: new Date().toISOString() }
}
