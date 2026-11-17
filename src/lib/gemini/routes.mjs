import http from 'node:http'
import { isIP } from 'node:net'
import path from 'node:path'

const PANEL_PATH = '/api/panel/gemini'
const PUBLIC_PATH = '/v1/gemini/sessions'
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const MODEL = /^[a-z0-9][a-z0-9._-]{0,99}$/
const AUTH_CODE = /^[A-Za-z0-9._~/-]{1,2048}$/
const AUTH_STATE = /^[A-Za-z0-9._~-]{1,512}$/
const API_KEY = /^[A-Za-z0-9_-]{20,256}$/
const STATES = new Set(['unverified', 'authorizing', 'authorized', 'reauth_required', 'disabled'])
const ACCOUNT_STATES = new Set(['ok', 'partial', 'error', 'reauth_required'])
const PAYLOAD_STATES = new Set(['installed', 'install_on_create', 'not_configured', 'invalid'])
const FAILURE = 'gemini_host_unavailable'
const HOST_ERRORS = {
  gemini_payload_not_configured: [503, '未找到 Gemini 签名载荷或发行公钥，请先配置宿主安装源'],
  gemini_payload_invalid: [503, 'Gemini 载荷安装或校验失败，请检查宿主服务日志'],
  gemini_egress_unavailable: [503, '缺少可用的 Gemini 出口组件，请检查宿主 kin-egress 安装'],
  gemini_authorization_unavailable: [503, 'Gemini 服务已连接，但未能启动 Google 授权，请检查代理与宿主日志'],
  gemini_account_read_failed: [502, '无法通过所选代理读取 Google 账号数据'],
  gemini_api_key_rejected: [400, 'Google 未接受该 Gemini API Key，请检查密钥和项目权限'],
}

export function isGeminiPanelPath(value) {
  return value === PANEL_PATH || value.startsWith(`${PANEL_PATH}/`)
}

export function isGeminiPublicPath(value) {
  return value === PUBLIC_PATH || value.startsWith(`${PUBLIC_PATH}/`)
}

function hostError(code, status = 503) {
  return Object.assign(new Error(code), { code, status })
}

export function officialGeminiAuthUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 4096) return null
    const url = new URL(value)
    if (
      url.origin !== 'https://accounts.google.com' ||
      url.pathname !== '/o/oauth2/auth' ||
      url.username ||
      url.password ||
      url.hash ||
      url.searchParams.get('redirect_uri') !== 'https://antigravity.google/oauth-callback' ||
      url.searchParams.get('response_type') !== 'code' ||
      url.searchParams.get('code_challenge_method') !== 'S256' ||
      !url.searchParams.get('state') ||
      !url.searchParams.get('code_challenge')
    )
      return null
    return url.href
  } catch {
    return null
  }
}

function hostRequest(socketPath, operation, payload) {
  if (process.platform !== 'linux' || process.arch !== 'x64' || !path.isAbsolute(socketPath || '')) {
    throw hostError(FAILURE)
  }
  const body = JSON.stringify(payload)
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
        method: 'POST',
        path: `/${operation}`,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        signal: AbortSignal.timeout(operation === 'create' ? 60000 : 30000),
      },
      async (response) => {
        try {
          const chunks = []
          let total = 0
          for await (const chunk of response) {
            total += chunk.length
            if (total > 512 * 1024) throw hostError(FAILURE)
            chunks.push(chunk)
          }
          if (response.statusCode === 404) throw hostError('gemini_environment_not_found', 404)
          if (response.statusCode === 409) throw hostError('gemini_environment_conflict', 409)
          const data = JSON.parse(Buffer.concat(chunks))
          if (Object.hasOwn(HOST_ERRORS, data?.code)) throw hostError(data.code)
          if (response.statusCode !== 200) throw hostError(FAILURE)
          resolve(data)
        } catch (error) {
          response.destroy()
          reject(error)
        }
      },
    )
    request.once('error', () => reject(hostError(FAILURE)))
    request.end(body)
  })
}

function text(value, size = 128) {
  return typeof value === 'string' && value.length ? value.slice(0, size) : null
}

function items(value, size, project) {
  return Array.isArray(value) ? value.slice(0, size).map(project).filter(Boolean) : []
}

function modelName(model) {
  return typeof model === 'string' && MODEL.test(model) ? model : null
}

function accountView(account) {
  if (!ACCOUNT_STATES.has(account?.state)) return null
  return {
    state: account.state,
    checked_at: text(account.checked_at),
    email: text(account.email, 254),
    project_id: text(account.project_id),
    region: text(account.region),
    plan: text(account.plan),
    expires_at: text(account.expires_at),
    quotas: items(account.quotas, 128, (quota) =>
      modelName(quota?.model) &&
      Number.isFinite(quota.remaining_fraction) &&
      quota.remaining_fraction >= 0 &&
      quota.remaining_fraction <= 1
        ? { model: quota.model, remaining_fraction: quota.remaining_fraction, reset_at: text(quota.reset_at) }
        : null,
    ),
    credits: items(account.credits, 16, (credit) => {
      const type = text(credit?.type)
      const amount = text(credit?.amount)
      return type && amount != null ? { type, amount } : null
    }),
  }
}

function environmentView(value) {
  if (!ID.test(value?.id ?? '') || !ID.test(value?.proxy_id ?? '') || !STATES.has(value?.auth_state)) {
    throw hostError(FAILURE)
  }
  return {
    id: value.id,
    proxy_id: value.proxy_id,
    name: String(value.name || '').slice(0, 80),
    auth_state: value.auth_state,
    auth_method: value.auth_method === 'api_key' ? 'api_key' : 'oauth',
    kernel_version: text(value.kernel_version),
    runtime_ready: value.runtime_ready === true,
    models: items(value.models, 128, modelName),
    account: accountView(value.account),
    created_at: text(value.created_at),
    updated_at: text(value.updated_at),
    billing_ready: false,
  }
}

function authorizationInput(body) {
  if (typeof body?.code !== 'string' || body.code.length > 3500) return null
  const value = body.code.trim()
  if (AUTH_CODE.test(value)) return { code: value }
  try {
    const url = new URL(value)
    if (
      url.origin !== 'https://antigravity.google' ||
      url.pathname !== '/oauth-callback' ||
      url.username ||
      url.password ||
      url.hash ||
      url.searchParams.has('error')
    )
      return null
    const codes = url.searchParams.getAll('code')
    const states = url.searchParams.getAll('state')
    if (codes.length !== 1 || states.length !== 1 || !AUTH_CODE.test(codes[0]) || !AUTH_STATE.test(states[0]))
      return null
    return { code: codes[0], state: states[0] }
  } catch {
    return null
  }
}

function proxyFor(proxyPool, proxyId) {
  const proxy = proxyPool?.snapshot({ ownerUserId: null }).proxies.find((entry) => entry.id === proxyId)
  if (
    !proxy?.enabled ||
    proxy.status === 'dead' ||
    proxy.status === 'fail' ||
    proxy.owner_user_id ||
    proxy.blocked_reason
  ) {
    throw hostError('gemini_proxy_unavailable', 409)
  }
  try {
    const url = new URL(proxyPool.getProxyByIdWithAuth(proxyId)?.url)
    if (
      (url.protocol === 'socks5:' || url.protocol === 'socks5h:') &&
      isIP(url.hostname) === 4 &&
      url.port &&
      !/^(?:127\.|169\.254\.|22[4-9]\.|23[0-9]\.|0\.0\.0\.0$|255\.255\.255\.255$)/.test(url.hostname) &&
      (!url.pathname || url.pathname === '/') &&
      !url.hash &&
      !url.search
    ) {
      return url.href.replace(/^socks5:/, 'socks5h:')
    }
  } catch {
    throw hostError('gemini_proxy_unavailable', 409)
  }
  throw hostError('gemini_proxy_unavailable', 409)
}

export function createGeminiPanelHandler({
  json,
  readBody,
  proxyPool,
  callHost = (operation, payload) =>
    hostRequest(process.env.KIN_GEMINI_HOST_SOCKET ?? '/run/vm2api-gemini/control.sock', operation, payload),
}) {
  return async function handleGeminiPanel(req, res, pathname) {
    const ok = (data) => json(res, 200, { ok: true, data })
    const fail = (status, code, message = code) => json(res, status, { ok: false, error: { code, message } })
    res.setHeader('Cache-Control', 'no-store')
    try {
      if (req.method === 'GET' && pathname === PANEL_PATH) {
        const view = await callHost('list', {})
        return ok({
          available: true,
          payload_state: PAYLOAD_STATES.has(view.payload_state) ? view.payload_state : 'installed',
          environments: view.environments.map(environmentView),
        })
      }
      if (req.method === 'POST' && pathname === `${PANEL_PATH}/environments`) {
        const body = await readBody(req, 4096)
        const name = typeof body?.name === 'string' ? body.name.trim() : ''
        const method = body?.auth_method ?? 'oauth'
        if (
          !name ||
          name.length > 80 ||
          typeof body?.proxy_id !== 'string' ||
          !ID.test(body.proxy_id) ||
          !['oauth', 'api_key'].includes(method)
        ) {
          return fail(400, 'gemini_invalid_environment')
        }
        const apiKey = typeof body?.api_key === 'string' ? body.api_key.trim() : ''
        if ((method === 'api_key' && !API_KEY.test(apiKey)) || (method === 'oauth' && body?.api_key != null)) {
          return fail(400, 'gemini_invalid_api_key', '请提供有效格式的 Gemini API Key')
        }
        const proxyUrl = proxyFor(proxyPool(), body.proxy_id)
        return ok(
          environmentView(
            await callHost('create', {
              name,
              proxy_id: body.proxy_id,
              proxy_url: proxyUrl,
              ...(method === 'api_key' ? { auth_method: method, api_key: apiKey } : {}),
            }),
          ),
        )
      }
      const match =
        /^\/api\/panel\/gemini\/environments\/([A-Za-z0-9_-]{1,64})(?:\/(authorization|disable|refresh))?$/.exec(
          pathname,
        )
      if (!match || !ID.test(match[1])) return fail(404, 'not_found')
      const [, id, action] = match
      if (req.method === 'DELETE' && !action) {
        await callHost('delete', { id })
        return ok({ deleted: true })
      }
      if (req.method === 'POST' && action === 'disable') {
        await callHost('disable', { id })
        return ok({ disabled: true })
      }
      if (req.method === 'POST' && action === 'refresh') {
        const environment = environmentView(await callHost('get', { id }))
        const proxyUrl = proxyFor(proxyPool(), environment.proxy_id)
        return ok(
          environmentView(await callHost('refresh', { id, proxy_id: environment.proxy_id, proxy_url: proxyUrl })),
        )
      }
      if (action !== 'authorization') return fail(404, 'not_found')
      if (req.method === 'POST') {
        const environment = environmentView(await callHost('get', { id }))
        const proxyUrl = proxyFor(proxyPool(), environment.proxy_id)
        const auth = await callHost('authorize', { id, proxy_id: environment.proxy_id, proxy_url: proxyUrl })
        const url = officialGeminiAuthUrl(auth?.url)
        if (!url || !ID.test(auth?.attempt_id ?? '')) throw hostError(FAILURE)
        return ok({ url, attempt_id: auth.attempt_id })
      }
      if (req.method === 'PUT') {
        const body = await readBody(req, 4096)
        const authorization = authorizationInput(body)
        if (typeof body?.attempt_id !== 'string' || !ID.test(body.attempt_id) || !authorization) {
          return fail(400, 'gemini_invalid_authorization_code', '请输入 Google 授权码或完整回调链接')
        }
        const environment = environmentView(await callHost('get', { id }))
        const proxyUrl = proxyFor(proxyPool(), environment.proxy_id)
        return ok(
          environmentView(
            await callHost('complete', {
              id,
              proxy_id: environment.proxy_id,
              proxy_url: proxyUrl,
              attempt_id: body.attempt_id,
              ...authorization,
            }),
          ),
        )
      }
      return fail(404, 'not_found')
    } catch (error) {
      if (req.method === 'GET' && pathname === PANEL_PATH) return ok({ available: false, environments: [] })
      if (Object.hasOwn(HOST_ERRORS, error?.code)) {
        const [status, message] = HOST_ERRORS[error.code]
        return fail(status, error.code, message)
      }
      if (error?.code === 'gemini_proxy_unavailable') return fail(409, error.code, '需要绑定可用的 IPv4 SOCKS5 代理')
      if (error?.code === 'gemini_environment_not_found') return fail(404, error.code, 'Gemini 环境不存在')
      if (error?.code === 'gemini_environment_conflict')
        return fail(409, error.code, 'Gemini 环境状态已变化，请刷新后重试')
      if (error?.status === 413) return fail(413, 'request_too_large')
      if (error?.status === 400) return fail(400, 'invalid_json')
      return fail(503, FAILURE, '未检测到可用的 Gemini 宿主机服务')
    }
  }
}

export function geminiBillingUnavailable(json, res) {
  res.setHeader('Cache-Control', 'no-store')
  return json(res, 503, {
    error: {
      type: 'service_unavailable',
      code: 'gemini_official_billing_unavailable',
      message: 'Gemini paid inference is disabled until verified per-turn official settlement is available.',
    },
  })
}
