const AUTH_URL =
  /https:\/\/(?:claude\.com\/cai|claude\.ai)\/oauth\/authorize\?[^\s\p{Cc}<>"']+/gu
const CALLBACK_ORIGINS: Record<string, true> = {
  'https://platform.claude.com': true,
  'https://console.anthropic.com': true,
}
const CODE_PART = /^[A-Za-z0-9._~+/%=-]+$/
const URL_TAIL = 4096

/** The manual authorize URL Claude prints or copies. */
export function loginAuthUrl(raw = '', complete = true): string {
  const text = raw.replace(/&\r?\n[ \t]*(?=[\w-]+=)/g, '&')
  let url = ''
  for (const match of text.matchAll(AUTH_URL)) {
    // A WebSocket boundary is not a URL boundary. Wait for the next chunk.
    if (!complete && (match.index ?? 0) + match[0].length === text.length)
      continue
    const candidate = match[0].replace(/[)\]}>.,]+$/, '')
    if (!new URL(candidate).searchParams.get('state')) continue
    url = candidate
  }
  return url
}

/** Claude accepts `code#state`; normalize known provider callback URLs to it. */
export function loginAuthCode(raw = ''): string {
  const text = raw.trim()
  let code: string | undefined | null
  let state: string | undefined | null
  if (/^https:\/\//i.test(text)) {
    if (/[\s\p{Cc}]/u.test(text)) return ''
    let url: URL
    try {
      url = new URL(text)
    } catch {
      return ''
    }
    if (
      !Object.prototype.hasOwnProperty.call(CALLBACK_ORIGINS, url.origin) ||
      url.pathname !== '/oauth/code/callback' ||
      url.username ||
      url.password ||
      url.hash ||
      url.searchParams.has('error') ||
      url.searchParams.getAll('code').length !== 1 ||
      url.searchParams.getAll('state').length !== 1
    ) {
      return ''
    }
    code = url.searchParams.get('code')
    state = url.searchParams.get('state')
  } else {
    const parts = text.split('#')
    if (parts.length !== 2) return ''
    code = parts[0]
    state = parts[1]
  }
  return code && state && CODE_PART.test(code) && CODE_PART.test(state)
    ? `${code}#${state}`
    : ''
}

/** Bound the amount of output held while waiting for a partial authorize URL. */
export function captureLoginAuthUrl(
  previous = '',
  chunk = ''
): { url: string; pending: string } {
  const text = previous + chunk
  return { url: loginAuthUrl(text, false), pending: text.slice(-URL_TAIL) }
}

export type LoginCommit = {
  official_cc_bootstrap?: { scheduled?: boolean; reason?: string } | null
}

type TerminalFrame =
  | { t: 'exit'; code?: number | null }
  | { t: 'error'; message: string }
  | { t: 'login'; result: LoginCommit }

/** Only an explicit successful login frame confirms a committed credential. */
export function parseTerminalFrame(raw: string): TerminalFrame | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || !('t' in value)) return null
  if (value.t === 'error') {
    return {
      t: 'error',
      message:
        'message' in value && typeof value.message === 'string' && value.message
          ? value.message
          : '终端错误',
    }
  }
  if (value.t === 'exit') {
    return {
      t: 'exit',
      code:
        'code' in value && typeof value.code === 'number' ? value.code : null,
    }
  }
  if (value.t !== 'login' || !('ok' in value) || value.ok !== true) return null
  const bootstrap =
    'official_cc_bootstrap' in value ? value.official_cc_bootstrap : undefined
  if (bootstrap === null) {
    return { t: 'login', result: { official_cc_bootstrap: null } }
  }
  if (!bootstrap || typeof bootstrap !== 'object') {
    return { t: 'login', result: {} }
  }
  return {
    t: 'login',
    result: {
      official_cc_bootstrap: {
        ...('scheduled' in bootstrap && typeof bootstrap.scheduled === 'boolean'
          ? { scheduled: bootstrap.scheduled }
          : {}),
        ...('reason' in bootstrap && typeof bootstrap.reason === 'string'
          ? { reason: bootstrap.reason }
          : {}),
      },
    },
  }
}
