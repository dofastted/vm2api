import http from 'node:http'
import { isIP } from 'node:net'
import path from 'node:path'

const PANEL_PATH = '/api/panel/gemini'
const PUBLIC_PATH = '/v1/gemini/sessions'
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const MODEL = /^[a-z0-9][a-z0-9-]{0,79}$/
const AUTH_CODE = /^[A-Za-z0-9._~/-]{1,2048}$/
const STATES = new Set(['unverified', 'authorizing', 'authorized', 'reauth_required', 'disabled'])
const FAILURE = 'gemini_host_unavailable'

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
        signal: AbortSignal.timeout(25000),
      },
      async (response) => {
        try {
          const chunks = []
          let total = 0
          for await (const chunk of response) {
            total += chunk.length
            if (total > 64 * 1024) throw hostError(FAILURE)
            chunks.push(chunk)
          }
          if (response.statusCode === 404) throw hostError('gemini_environment_not_found', 404)
          if (response.statusCode === 409) throw hostError('gemini_environment_conflict', 409)
          if (response.statusCode !== 200) throw hostError(FAILURE)
          resolve(JSON.parse(Buffer.concat(chunks)))
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

function environmentView(value) {
  if (!ID.test(value?.id ?? '') || !ID.test(value?.proxy_id ?? '') || !STATES.has(value?.auth_state)) {
    throw hostError(FAILURE)
  }
  return {
    id: value.id,
    proxy_id: value.proxy_id,
    name: String(value.name || '').slice(0, 80),
    auth_state: value.auth_state,
    runtime_ready: value.runtime_ready === true,
    models: Array.isArray(value.models)
      ? value.models.filter((model) => typeof model === 'string' && MODEL.test(model)).slice(0, 32)
      : [],
    billing_ready: false,
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
    if ((url.protocol === 'socks5:' || url.protocol === 'socks5h:') && isIP(url.hostname) === 4 && url.port) {
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
  callHost = (operation, payload) => hostRequest(process.env.KIN_GEMINI_HOST_SOCKET, operation, payload),
}) {
  return async function handleGeminiPanel(req, res, pathname) {
    const ok = (data) => json(res, 200, { ok: true, data })
    const fail = (status, code, message = code) => json(res, status, { ok: false, error: { code, message } })
    res.setHeader('Cache-Control', 'no-store')
    try {
      if (req.method === 'GET' && pathname === PANEL_PATH) {
        const view = await callHost('list', {})
        return ok({ available: true, environments: view.environments.map(environmentView) })
      }
      if (req.method === 'POST' && pathname === `${PANEL_PATH}/environments`) {
        const body = await readBody(req, 4096)
        const name = typeof body?.name === 'string' ? body.name.trim() : ''
        if (!name || name.length > 80 || typeof body?.proxy_id !== 'string' || !ID.test(body.proxy_id)) {
          return fail(400, 'gemini_invalid_environment')
        }
        const proxyUrl = proxyFor(proxyPool(), body.proxy_id)
        return ok(environmentView(await callHost('create', { name, proxy_id: body.proxy_id, proxy_url: proxyUrl })))
      }
      const match = /^\/api\/panel\/gemini\/environments\/([A-Za-z0-9_-]{1,64})(?:\/(authorization|disable))?$/.exec(
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
        if (
          typeof body?.attempt_id !== 'string' ||
          !ID.test(body.attempt_id) ||
          typeof body?.code !== 'string' ||
          !AUTH_CODE.test(body.code)
        ) {
          return fail(400, 'gemini_invalid_authorization_code')
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
              code: body.code,
            }),
          ),
        )
      }
      return fail(404, 'not_found')
    } catch (error) {
      if (req.method === 'GET' && pathname === PANEL_PATH) return ok({ available: false, environments: [] })
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
