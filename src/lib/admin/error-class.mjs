/**
 * Request-log error taxonomy for overview + logs.
 * Derived from status / error_code / message so historical rows classify without a migration.
 */

export const ERROR_CLASSES = {
  auth: { id: 'auth', owner: 'client', label: '认证' },
  request: { id: 'request', owner: 'client', label: '请求格式' },
  signature: { id: 'signature', owner: 'client', label: '思考签名' },
  rate_limit: { id: 'rate_limit', owner: 'provider', label: '限流' },
  quota: { id: 'quota', owner: 'platform', label: '额度' },
  overloaded: { id: 'overloaded', owner: 'provider', label: '过载排队' },
  timeout: { id: 'timeout', owner: 'provider', label: '超时' },
  credential: { id: 'credential', owner: 'platform', label: '凭证' },
  proxy: { id: 'proxy', owner: 'platform', label: '代理' },
  upstream: { id: 'upstream', owner: 'provider', label: '上游' },
  other: { id: 'other', owner: 'platform', label: '其它' },
  distill: { id: 'distill', owner: 'platform', label: '蒸馏拦截' },
  refusal: { id: 'refusal', owner: 'provider', label: '拒答拦截' },
}

const CODE_MAP = {
  auth_failed: 'auth',
  invalid_api_key: 'auth',
  missing_api_key: 'auth',
  api_key_disabled: 'auth',
  api_key_expired: 'auth',
  invalid_json: 'request',
  body_too_large: 'request',
  empty_body: 'request',
  missing_field: 'request',
  invalid_field: 'request',
  invalid_messages: 'request',
  invalid_content: 'request',
  invalid_request: 'request',
  model_required: 'request',
  model_not_supported: 'request',
  protocol_unsupported: 'request',
  convert_failed: 'request',
  vm_workspace_removed: 'request',
  upstream_invalid_request: 'request',
  gateway_rate_limit: 'rate_limit',
  api_key_rate_limit: 'rate_limit',
  upstream_rate_limit: 'rate_limit',
  quota_5h_safety: 'quota',
  quota_7d_safety: 'quota',
  api_key_quota_exhausted: 'quota',
  concurrency_limit: 'quota',
  api_key_concurrency_limit: 'quota',
  account_pool_exhausted: 'overloaded',
  server_overloaded: 'overloaded',
  upstream_overloaded: 'overloaded',
  upstream_timeout: 'timeout',
  stream_incomplete: 'timeout',
  client_cancelled: 'timeout',
  request_cancelled: 'timeout',
  client_aborted: 'timeout',
  selection_cancelled: 'timeout',
  ECONNRESET: 'timeout',
  aborted: 'timeout',
  upstream_auth_error: 'credential',
  oauth_need_reimport: 'credential',
  oauth_refresh_failed: 'credential',
  upstream_error: 'upstream',
  distill_blocked: 'distill',
  refusal_guard: 'refusal',
  content_filter_refusal: 'refusal',
}

export const IGNORED_ERROR_CODES = new Set([
  'client_cancelled',
  'request_cancelled',
  'client_aborted',
  'selection_cancelled',
  'ECONNRESET',
  'aborted',
])

/**
 * Client ingress auth (missing / unknown / disabled / expired sk-kin).
 * Same cut as sub2api MarkIngressRejected: visible in logs, not an ops/SLA failure.
 */
export const INGRESS_AUTH_ERROR_CODES = new Set([
  'auth_failed',
  'invalid_api_key',
  'missing_api_key',
  'api_key_disabled',
  'api_key_expired',
])

/** 5h/7d/限流仍算账号可用，SLA 也不把这些请求当失败。入口坏钥匙同口径。 */
export const SLA_OK_ERROR_CODES = new Set([
  ...IGNORED_ERROR_CODES,
  ...INGRESS_AUTH_ERROR_CODES,
  'upstream_rate_limit',
  'gateway_rate_limit',
  'api_key_rate_limit',
  'quota_5h_safety',
  'quota_7d_safety',
  'api_key_quota_exhausted',
  'concurrency_limit',
  'api_key_concurrency_limit',
  'distill_blocked',
  'refusal_guard',
  'content_filter_refusal',
])

export function ignoredErrorSqlList() {
  return [...IGNORED_ERROR_CODES].map((code) => `'${code}'`).join(', ')
}

export function slaOkErrorSqlList() {
  return [...SLA_OK_ERROR_CODES].map((code) => `'${code}'`).join(', ')
}

/** Default mute: invalid-key 401s flood the log list without being an ops failure. */
export const DEFAULT_MUTED_ERROR_CLASSES = ['auth']

export function normalizeMutedErrorClasses(raw) {
  const allowed = new Set(Object.keys(ERROR_CLASSES))
  const list = Array.isArray(raw) ? raw : String(raw || '').split(',')
  return [...new Set(list.map((s) => String(s).trim()).filter((id) => allowed.has(id)))]
}

/** Missing field → default mute auth. Explicit `[]` means show everything. */
export function resolveMutedErrorClasses(raw) {
  if (raw == null) return DEFAULT_MUTED_ERROR_CLASSES.slice()
  return normalizeMutedErrorClasses(raw)
}

export function ingressAuthSql() {
  const codes = [...INGRESS_AUTH_ERROR_CODES].map((code) => `'${code}'`).join(', ')
  const cred = "'upstream_auth_error','oauth_need_reimport','oauth_refresh_failed'"
  return `(
    IFNULL(error_code, '') IN (${codes})
    OR (
      status IN (401, 403)
      AND IFNULL(vm_id, '') = ''
      AND IFNULL(error_code, '') NOT IN (${cred})
    )
  )`
}

export function excludeErrorClassSql(classes) {
  const list = Array.isArray(classes)
    ? classes
    : String(classes || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
  const parts = []
  for (const id of list) {
    if (id === 'auth') parts.push(`NOT (${ingressAuthSql()})`)
  }
  return parts.length ? `(${parts.join(' AND ')})` : ''
}

function hay(row) {
  return `${row?.error_code || ''} ${row?.error_message || ''}`.toLowerCase()
}

function isOauthCredentialFailure(row = {}, text = '', code = '') {
  if (code === 'upstream_auth_error' || code === 'oauth_need_reimport' || code === 'oauth_refresh_failed') {
    return true
  }
  if (row?.vm_id) return true
  return /oauth|reimport|revoked|access token|refresh_token|invalid_grant/.test(text)
}

export function isIgnoredClientCancel(row = {}) {
  const status = Number(row?.status) || 0
  const code = String(row?.error_code || '').trim()
  if (status >= 400 && status !== 499) return false
  if (IGNORED_ERROR_CODES.has(code)) return true
  return /econnreset|client.?abort|request_cancelled|context canceled/i.test(hay(row))
}

export function isErrorRow(row) {
  if (isIgnoredClientCancel(row)) return false
  const status = Number(row?.status) || 0
  // HTTP 2xx already committed to the client. leftover error_code
  // (stream_incomplete after first-byte message_start) must not paint 超时.
  if (status > 0 && status < 400) return false
  return status >= 400 || !!row?.error_code
}

export function classifyRequestError(row = {}) {
  if (!isErrorRow(row)) return null
  const status = Number(row.status) || 0
  const code = String(row.error_code || '').trim()
  const text = hay(row)
  let id = CODE_MAP[code] || null

  if (/signature|thinking block|skip_thought_signature|must contain thinking/.test(text)) id = 'signature'
  else if ((id === 'upstream' || status === 503) && /overload|no eligible|负载过高/.test(text)) id = 'overloaded'
  if (!id) {
    if (/extra usage|entitlement|quota|5h|7d/.test(text) && (status === 429 || /quota|usage/.test(text))) id = 'quota'
    else if (/socks|proxy|cloudflare|just a moment/.test(text)) id = 'proxy'
    else if (/timeout|aborted|incomplete|deadline/.test(text) || status === 408 || status === 504) id = 'timeout'
    else if (
      INGRESS_AUTH_ERROR_CODES.has(code) ||
      /missing_api|invalid_api|api[_-]?key|missing credentials|invalid credentials/.test(text)
    ) {
      id = isOauthCredentialFailure(row, text, code) ? 'credential' : 'auth'
    } else if (status === 401 || status === 403 || /oauth|reimport|revoked/.test(text)) {
      id = isOauthCredentialFailure(row, text, code) ? 'credential' : 'auth'
    } else if (status === 429) id = 'rate_limit'
    else if (status === 529 || status === 503 || /overload|no eligible|负载过高/.test(text)) id = 'overloaded'
    else if (status === 400 || status === 422) id = 'request'
    else if (status >= 500) id = 'upstream'
    else id = 'other'
  }

  const meta = ERROR_CLASSES[id] || ERROR_CLASSES.other
  return {
    error_class: meta.id,
    error_owner: meta.owner,
    error_label: meta.label,
    error_code: code || `http_${status || 'err'}`,
  }
}

export function enrichLogRow(row) {
  if (!row) return row
  const cls = classifyRequestError(row)
  if (!cls) {
    return { ...row, error_class: null, error_owner: null, error_label: null }
  }
  return { ...row, ...cls }
}

export function collectErrors(rows = []) {
  const byClass = new Map()
  const byCode = new Map()
  const recent = []
  for (const raw of rows) {
    const row = enrichLogRow(raw)
    if (!row.error_class) continue
    const c = byClass.get(row.error_class) || {
      id: row.error_class,
      label: row.error_label,
      owner: row.error_owner,
      count: 0,
    }
    c.count += 1
    byClass.set(row.error_class, c)

    const key = `${row.error_class}:${row.error_code}`
    const g = byCode.get(key) || {
      error_class: row.error_class,
      error_label: row.error_label,
      error_owner: row.error_owner,
      error_code: row.error_code,
      count: 0,
      last_ts: null,
      last_message: null,
      last_status: null,
      last_model: null,
    }
    g.count += 1
    if (!g.last_ts || String(row.ts || '') > String(g.last_ts || '')) {
      g.last_ts = row.ts || null
      g.last_message = row.error_message ? String(row.error_message).slice(0, 180) : null
      g.last_status = row.status ?? null
      g.last_model = row.upstream_model || row.model || null
    }
    byCode.set(key, g)
    if (recent.length < 30)
      recent.push({
        ts: row.ts,
        request_id: row.request_id,
        status: row.status,
        model: row.upstream_model || row.model || null,
        vm_id: row.vm_id || null,
        error_class: row.error_class,
        error_label: row.error_label,
        error_owner: row.error_owner,
        error_code: row.error_code,
        error_message: row.error_message ? String(row.error_message).slice(0, 180) : null,
      })
  }
  return {
    total: [...byClass.values()].reduce((n, x) => n + x.count, 0),
    by_class: [...byClass.values()].sort((a, b) => b.count - a.count),
    by_code: [...byCode.values()].sort((a, b) => b.count - a.count).slice(0, 20),
    recent,
  }
}
