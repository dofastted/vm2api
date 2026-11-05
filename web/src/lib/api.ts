import type {
  CragLicenseResponse,
  VmActiveHours,
  VmQuotaOverride,
} from '@/types/panel-vm'
import {
  apiBase,
  expirePanelSession,
  hasSession,
  sessionToken,
} from '@/lib/session'

export type PanelErrorMetadata = {
  type?: string
  code?: string
  details?: unknown
  /** 放置预检失败（`placement_preflight_failed`）时的 `error.checks`。 */
  checks?: unknown
  data?: unknown
}

export type NormalizedPanelError = PanelErrorMetadata & {
  message: string
  status: number
}

export class ApiError extends Error {
  status: number
  type?: string
  code: string
  details?: unknown
  checks?: unknown
  data?: unknown

  constructor(
    message: string,
    status = 0,
    metadata: string | PanelErrorMetadata = ''
  ) {
    super(message)
    const normalized =
      typeof metadata === 'string' ? { code: metadata } : metadata
    this.name = 'ApiError'
    this.status = status
    this.type = normalized.type
    this.code = normalized.code || ''
    this.details = normalized.details
    this.checks = normalized.checks
    this.data = normalized.data
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}

type Json =
  Record<string, unknown> | unknown[] | string | number | boolean | null

function authHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  const token = sessionToken()
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function normalizePanelError(
  payload: unknown,
  status = 0,
  fallback = '请求失败'
): NormalizedPanelError {
  const body = asRecord(payload)
  const error = asRecord(body?.error)
  const message = String(error?.message || body?.message || fallback)
  const type = error?.type == null ? undefined : String(error.type)
  const code = error?.code == null ? undefined : String(error.code)
  return {
    message,
    status,
    ...(type ? { type } : {}),
    ...(code ? { code } : {}),
    ...(Object.prototype.hasOwnProperty.call(error || {}, 'details')
      ? { details: error?.details }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(error || {}, 'checks')
      ? { checks: error?.checks }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(body || {}, 'data')
      ? { data: body?.data }
      : {}),
  }
}

function apiErrorFrom(payload: unknown, status: number, fallback: string) {
  const normalized = normalizePanelError(payload, status, fallback)
  const { message, status: normalizedStatus, ...metadata } = normalized
  return new ApiError(message, normalizedStatus, metadata)
}

function unwrapEnvelope(payload: unknown, status: number): unknown {
  const body = asRecord(payload)
  if (!body) return payload
  if (body.ok === false) throw apiErrorFrom(body, status, '请求失败')
  return body.data !== undefined ? body.data : payload
}

function isPanelApiPath(path: string): boolean {
  return path.startsWith('/api/panel/') && path !== '/api/panel/login'
}

export async function panelFetch(
  path: string,
  opts: RequestInit = {}
): Promise<Response> {
  const url = `${apiBase() || ''}${path}`
  const res = await fetch(url, {
    ...opts,
    credentials: 'include',
    headers: { ...authHeaders(), ...(opts.headers || {}) },
  })
  if (res.status === 401 && isPanelApiPath(path)) expirePanelSession()
  return res
}

export async function api<T = unknown>(
  path: string,
  opts: RequestInit = {}
): Promise<T> {
  if (!hasSession()) throw new ApiError('未登录', 401)
  const res = await panelFetch(path, opts)
  const json = (await res.json().catch(() => ({}))) as Json
  if (res.status === 401) {
    throw apiErrorFrom(json, res.status, '登录已过期')
  }
  if (!res.ok) {
    throw apiErrorFrom(json, res.status, res.statusText || '请求失败')
  }
  return unwrapEnvelope(json, res.status) as T
}

export type VmPatch = {
  inference_engine?: 'go' | 'rust' | ''
  persona_preset?: string
  dataplane?: 'wrap' | 'cc' | 'crag' | ''
  crag_kernel_version?: 'legacy' | 'v2' | ''
  /** null = 去掉本槽覆盖，跟随分档 / 全局。 */
  max_concurrency?: number | null
  max_rpm?: number | null
  /** OpenAI only; null clears the pin and follows codex.quota.max_sessions. */
  max_sessions?: number | null
  session_slots?: number | null
  quota_override?: VmQuotaOverride | null
  allowed_models?: string[]
  auth_scheme?: string
  schedule_level?: number | 'auto' | null
  /** null = 清除工作时段，恢复 24h 接单。 */
  active_hours?: VmActiveHours | null
  /** Docker 槽在线提升内存（仅上调）。 */
  memory?: string
  machine?: { memory?: string }
}

export function patchVm<T = unknown>(id: string, body: VmPatch) {
  return api<T>(`/api/panel/vms/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export function getVmCragLicense(id: string) {
  return api<CragLicenseResponse>(
    `/api/panel/vms/${encodeURIComponent(id)}/crag-license`
  )
}

export function activateVmCragLicense(id: string, registrationCode: string) {
  return api<CragLicenseResponse>(
    `/api/panel/vms/${encodeURIComponent(id)}/crag-license`,
    {
      method: 'POST',
      body: JSON.stringify({ registration_code: registrationCode }),
    }
  )
}

export async function loginRequest(input: {
  username: string
  password: string
  base?: string
}): Promise<{ token: string; user: string }> {
  const base = input.base ?? apiBase()
  const url = `${base || ''}/api/panel/login`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: input.username,
        password: input.password,
      }),
    })
  } catch {
    throw new ApiError(`无法连接鉴权服务: ${url}`)
  }
  if (res.status === 405)
    throw new ApiError(`405 Method Not Allowed: ${url}`, 405)
  const json = (await res.json().catch(() => ({}))) as {
    token?: string
    user?: string
    data?: { token?: string; user?: string }
    error?: { message?: string }
    message?: string
  }
  const token = json.token || json.data?.token || ''
  if (!res.ok || !token) {
    throw new ApiError(
      json.error?.message ||
        json.message ||
        `登录失败 HTTP ${res.status} @ ${url}`,
      res.status
    )
  }
  return { token, user: json.user || json.data?.user || input.username }
}

export function logoutRequest() {
  if (!hasSession()) return
  void panelFetch('/api/panel/logout', { method: 'POST' }).catch(
    () => undefined
  )
}
