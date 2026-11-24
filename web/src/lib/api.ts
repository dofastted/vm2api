import type {
  LoginOutcome,
  TwoFactorCodes,
  TwoFactorSetup,
  TwoFactorStatus,
} from '@/types/panel-auth'
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

export async function cragDeviceApi<T>(path: string, opts: RequestInit = {}) {
  const res = await fetch(`/api/panel/crag-shop/device${path}`, {
    ...opts,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
  })
  const json: unknown = await res.json().catch(() => ({}))
  if (!res.ok)
    throw apiErrorFrom(json, res.status, res.statusText || '请求失败')
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
  /** Claude family mode; null clears the slot override. */
  max_primary_sessions?: number | null
  max_subagents_per_session?: number | null
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

export type VmKernelSwitchTarget = {
  dataplane: 'crag' | 'wrap'
  crag_kernel_version?: 'v2' | ''
}

export type VmKernelSwitchJob = VmKernelSwitchTarget & {
  id: string
  vm_id: string
  status: 'running' | 'succeeded' | 'failed'
  started_at: string
  finished_at: string | null
  error: { code: string; message: string } | null
  reclaim_pending?: boolean
  deferred_start?: boolean
  deferred_reason?: string | null
  start_error?: string | null
}

export function startVmKernelSwitch(id: string, body: VmKernelSwitchTarget) {
  return api<VmKernelSwitchJob>(
    `/api/panel/vms/${encodeURIComponent(id)}/kernel-switch`,
    { method: 'POST', body: JSON.stringify(body) }
  )
}

export function getVmKernelSwitch(id: string, signal?: AbortSignal) {
  return api<VmKernelSwitchJob | null>(
    `/api/panel/vms/${encodeURIComponent(id)}/kernel-switch`,
    { signal }
  )
}

export function getVmCragLicense(id: string) {
  return api<CragLicenseResponse>(
    `/api/panel/vms/${encodeURIComponent(id)}/crag-license`
  )
}

type LoginPayload = {
  token?: string
  user?: string
  data?: { token?: string; user?: string }
  totp_required?: boolean
  challenge?: string
  expires_in?: number
  error?: { message?: string; code?: string }
  message?: string
}

/** 登录与验证码两步都是公开端点：不带会话、不触发会话过期。 */
async function postLogin(
  base: string,
  path: string,
  body: Record<string, unknown>
): Promise<{ res: Response; json: LoginPayload; url: string }> {
  const url = `${base || ''}${path}`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new ApiError(`无法连接鉴权服务: ${url}`)
  }
  if (res.status === 405)
    throw new ApiError(`405 Method Not Allowed: ${url}`, 405)
  const json = (await res.json().catch(() => ({}))) as LoginPayload
  return { res, json, url }
}

type PanelSessionResult = Extract<LoginOutcome, { kind: 'session' }>

function sessionFrom(
  res: Response,
  json: LoginPayload,
  url: string,
  fallbackUser: string
): PanelSessionResult {
  const token = json.token || json.data?.token || ''
  if (!res.ok || !token) {
    throw new ApiError(
      json.error?.message ||
        json.message ||
        `登录失败 HTTP ${res.status} @ ${url}`,
      res.status,
      { code: json.error?.code || '' }
    )
  }
  return {
    kind: 'session',
    token,
    user: json.user || json.data?.user || fallbackUser,
  }
}

/**
 * 第一步：用户名 + 密码。账号开了两步验证时返回 `kind: 'totp'` 和
 * challenge，调用方再用 {@link loginTotpRequest} 带验证码换会话。
 */
export async function loginRequest(input: {
  username: string
  password: string
  /** 可选：一次性提交验证码，省掉第二步往返。 */
  code?: string
  base?: string
}): Promise<LoginOutcome> {
  const base = input.base ?? apiBase()
  const { res, json, url } = await postLogin(base, '/api/panel/login', {
    username: input.username,
    password: input.password,
    ...(input.code ? { code: input.code } : {}),
  })
  if (json.totp_required && json.challenge) {
    return {
      kind: 'totp',
      challenge: json.challenge,
      expiresIn: Number(json.expires_in) || 300,
    }
  }
  return sessionFrom(res, json, url, input.username)
}

/** 第二步：challenge + 验证码（或恢复码）换会话。 */
export async function loginTotpRequest(input: {
  challenge: string
  code: string
  username?: string
  base?: string
}): Promise<PanelSessionResult> {
  const base = input.base ?? apiBase()
  const { res, json, url } = await postLogin(base, '/api/panel/login/totp', {
    challenge: input.challenge,
    code: input.code,
  })
  return sessionFrom(res, json, url, input.username || '')
}

export function twoFactorStatusRequest() {
  return api<TwoFactorStatus>('/api/panel/2fa')
}

/** 生成待确认的密钥。改动第二因素要重新验证密码。 */
export function twoFactorSetupRequest(password: string) {
  return api<TwoFactorSetup>('/api/panel/2fa/setup', {
    method: 'POST',
    body: JSON.stringify({ password }),
  })
}

export function twoFactorEnableRequest(code: string) {
  return api<TwoFactorCodes>('/api/panel/2fa/enable', {
    method: 'POST',
    body: JSON.stringify({ code }),
  })
}

export function twoFactorDisableRequest(password: string, code: string) {
  return api<TwoFactorStatus>('/api/panel/2fa/disable', {
    method: 'POST',
    body: JSON.stringify({ password, code }),
  })
}

export function twoFactorRecoveryRequest(password: string) {
  return api<TwoFactorCodes>('/api/panel/2fa/recovery', {
    method: 'POST',
    body: JSON.stringify({ password }),
  })
}

/** 管理员解锁：清掉目标账号的两步验证，下次登录只要密码。 */
export function resetUserTwoFactorRequest(id: string) {
  return api<{ username: string; reset: boolean }>(
    `/api/panel/users/${encodeURIComponent(id)}/2fa`,
    { method: 'DELETE' }
  )
}

export function logoutRequest() {
  if (!hasSession()) return
  void panelFetch('/api/panel/logout', { method: 'POST' }).catch(
    () => undefined
  )
}
