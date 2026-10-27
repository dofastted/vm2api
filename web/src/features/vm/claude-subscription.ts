import type { ClaudeSubscription } from '@/types/panel-vm'

export function subscriptionDate(
  value: string | null | undefined,
  dateOnly = false
) {
  if (!value) return '未知'
  if (dateOnly) return value.slice(0, 10)
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? '未知'
    : date.toLocaleString('zh-CN', { hour12: false })
}

export function subscriptionDateText(
  subscription: ClaudeSubscription | undefined
) {
  if (subscription?.expires_at) {
    return `到期：${subscriptionDate(subscription.expires_at, subscription.expires_date_only)}`
  }
  if (subscription?.renews_at) {
    return `续费：${subscriptionDate(subscription.renews_at, subscription.renews_date_only)}`
  }
  return subscription?.configured ? '订阅日期：未知' : '订阅日期：未获取'
}

export const SUBSCRIPTION_ERRORS: Record<string, string> = {
  subscription_session_expired: '网页 sessionKey 已失效，请重新保存',
  subscription_account_mismatch: '网页账号或组织与当前槽位不一致',
  subscription_access_denied: '网页访问受限或无账单读取权限',
  subscription_rate_limited: '查询频率受限，请稍后重试',
  subscription_response_invalid: '订阅数据格式无法识别',
  subscription_request_failed: '订阅查询失败，请稍后重试',
}
