export type AntigravityOAuthStatus =
  | 'starting'
  | 'awaiting_code'
  | 'verifying'
  | 'authenticated'
  | 'failed'
  | 'expired'
  | 'cancelled'

export type AntigravityOAuthSession = {
  session_id: string
  status: AntigravityOAuthStatus
  auth_url: string | null
  expires_at: string
  authenticated: boolean
  error?: string | { code?: string; message?: string } | null
  message?: string
}

export function antigravityOAuthAuthenticated(
  session: AntigravityOAuthSession | null
) {
  return session?.status === 'authenticated' && session.authenticated === true
}

export function antigravityOAuthPending(
  session: AntigravityOAuthSession | null
) {
  return (
    !!session &&
    (['starting', 'awaiting_code', 'verifying'].includes(session.status) ||
      (session.status === 'authenticated' && !session.authenticated))
  )
}

export function antigravityOAuthExpired(
  session: AntigravityOAuthSession | null,
  now: number
) {
  const expires = Date.parse(session?.expires_at || '')
  return (
    antigravityOAuthPending(session) &&
    Number.isFinite(expires) &&
    expires <= now
  )
}

/** Only expose Google's authorization page for the official Antigravity callback. */
export function antigravityOAuthUrl(session: AntigravityOAuthSession | null) {
  try {
    if (!session?.auth_url || session.auth_url.length > 16384) return ''
    const url = new URL(session.auth_url)
    return url.origin === 'https://accounts.google.com' &&
      !url.username &&
      !url.password &&
      url.searchParams.get('redirect_uri') ===
        'https://antigravity.google/oauth-callback' &&
      url.searchParams.get('response_type') === 'code' &&
      !!url.searchParams.get('state') &&
      !!url.searchParams.get('code_challenge')
      ? url.href
      : ''
  } catch {
    return ''
  }
}

/** A late poll must not replace a newer verification or a completed session. */
export function mergeAntigravityOAuthSession(
  current: AntigravityOAuthSession | null,
  incoming: AntigravityOAuthSession
) {
  if (!current || incoming.session_id !== current.session_id) return current
  if (!antigravityOAuthPending(current)) return current
  if (
    current.status === 'verifying' &&
    ['starting', 'awaiting_code'].includes(incoming.status)
  )
    return current
  if (current.status === 'awaiting_code' && incoming.status === 'starting')
    return current
  return incoming
}

export function antigravityOAuthMessage(
  session: AntigravityOAuthSession | null
) {
  if (!session)
    return '生成授权链接后，在浏览器中完成 Google 登录，再粘贴授权页面给出的单行授权码。'
  if (antigravityOAuthAuthenticated(session))
    return 'Antigravity OAuth 已完成，当前槽位已绑定账号。'
  const error =
    typeof session.error === 'string' ? session.error : session.error?.message
  if (error) return error
  if (session.message) return session.message
  switch (session.status) {
    case 'starting':
      return '正在启动官方客户端并生成授权链接…'
    case 'awaiting_code':
      return '请打开授权页完成登录，并将页面给出的授权码粘贴到下方。'
    case 'verifying':
    case 'authenticated':
      return '正在确认官方客户端的登录状态…'
    case 'expired':
      return '授权会话已过期，请重新生成授权链接。'
    case 'cancelled':
      return '已取消本次授权。'
    case 'failed':
      return '授权失败，请重新生成链接后重试。'
  }
}
