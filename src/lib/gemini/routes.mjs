import http from 'node:http'
import { isIP } from 'node:net'
import path from 'node:path'
import { createGeminiTerminalBridge } from './terminal.mjs'

const PANEL_PATH = '/api/panel/gemini'
const PUBLIC_PATH = '/v1/gemini/sessions'
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const MODEL = /^[a-z0-9][a-z0-9._-]{0,99}$/
const RUN_ID = /^[a-f0-9]{32}$/
const MAX_PROMPT_BYTES = 4096
const MAX_TEST_TEXT = 16 * 1024
const AUTH_CODE = /^[A-Za-z0-9._~/-]{1,2048}$/
const AUTH_STATE = /^[A-Za-z0-9._~-]{1,512}$/
const API_KEY = /^[A-Za-z0-9_-]{20,256}$/
const RELEASE_CODE = /^CGG1-[A-Za-z0-9_-]{43}$/
const STATES = new Set(['unverified', 'authorizing', 'authorized', 'reauth_required', 'disabled'])
const ACCOUNT_STATES = new Set(['ok', 'partial', 'error', 'reauth_required'])
const PAYLOAD_STATES = new Set(['installed', 'install_on_create', 'awaiting_redemption', 'not_configured', 'invalid'])
const RUN_STATES = new Set(['running', 'completed', 'failed'])
const RUN_ERRORS = {
  gemini_oauth_required: [409, '请重新完成 Google OAuth 授权'],
  gemini_location_unsupported: [403, 'Google 判定当前账号所在地区不支持 Antigravity；拉取模型成功不代表可对话'],
  gemini_proxy_error: [502, '无法通过绑定代理连接 Gemini，请检查代理'],
  gemini_model_unavailable: [409, '当前环境不支持所选模型，请重新获取模型列表'],
  gemini_models_empty: [502, 'Gemini 未返回可用模型'],
  gemini_api_key_invalid: [400, '当前 Gemini API Key 无效'],
  gemini_quota_exhausted: [429, 'Gemini 额度已用尽，请稍后重试'],
  gemini_inference_timeout: [503, 'Gemini 请求超时，请稍后重试'],
  gemini_inference_invalid_output: [502, 'Gemini 返回了无法解析的响应'],
  gemini_inference_start_failed: [503, '无法启动 Gemini 测试进程'],
  gemini_inference_cancelled: [409, 'Gemini 测试已取消'],
  gemini_inference_output_limit: [502, 'Gemini 响应超过测试输出上限'],
  gemini_inference_tool_blocked: [502, '此测试仅支持文本，不支持工具调用'],
  gemini_inference_failed: [502, 'Gemini 请求失败，请检查环境状态'],
}
const FAILURE = 'gemini_host_unavailable'
const PROTOCOL_ERROR = 'gemini_host_protocol_error'
const SOCKET_ERRORS = new Map([
  ['ENOENT', 'gemini_host_socket_missing'],
  ['ECONNREFUSED', 'gemini_host_socket_refused'],
  ['EACCES', 'gemini_host_socket_denied'],
  ['EPERM', 'gemini_host_socket_denied'],
  ['ABORT_ERR', 'gemini_host_timeout'],
])
const PAYLOAD_ISSUES = new Set([
  'gemini_public_key_missing',
  'gemini_payload_source_missing',
  'gemini_payload_incomplete',
  'gemini_payload_invalid',
  'gemini_payload_not_installed',
  'gemini_release_not_configured',
  'gemini_release_invalid',
  'gemini_release_payload_mismatch',
])
const OAUTH_ISSUES = new Set([
  'gemini_oauth_tools_missing',
  'gemini_egress_unavailable',
  'gemini_ipv4_forwarding_unavailable',
])
const HOST_ERRORS = {
  ...RUN_ERRORS,
  gemini_operation_busy: [409, '此 Gemini 环境正在执行其他操作，请稍后重试'],
  gemini_run_not_found: [404, '测试会话不存在或已过期'],
  gemini_proxy_probe_failed: [502, '无法通过绑定代理连接 Gemini'],
  gemini_host_socket_missing: [503, '找不到 Gemini 控制 socket，请检查宿主服务和容器挂载'],
  gemini_host_socket_refused: [503, 'Gemini 控制 socket 拒绝连接，请检查宿主服务状态'],
  gemini_host_socket_denied: [503, '控制面无权访问 Gemini 控制 socket，请检查 vm2api 组和目录权限'],
  gemini_host_timeout: [503, 'Gemini 宿主服务响应超时，请检查宿主服务日志'],
  gemini_host_unsupported_platform: [503, 'Gemini 宿主服务只支持 Linux amd64'],
  gemini_host_invalid_socket: [503, 'Gemini 控制 socket 必须使用绝对路径'],
  [PROTOCOL_ERROR]: [503, 'Gemini 宿主服务响应格式不兼容，请对齐控制面和宿主服务版本'],
  gemini_payload_not_configured: [503, '未找到 Gemini 签名载荷或发行公钥，请先配置宿主安装源'],
  gemini_public_key_missing: [503, '缺少 Gemini 发行公钥，请从可信渠道安装'],
  gemini_payload_source_missing: [503, '缺少 Gemini 签名载荷，请配置已解包的安装源'],
  gemini_payload_incomplete: [503, 'Gemini 签名载荷不完整，请检查 agy、CRAGGemini 和清单文件'],
  gemini_payload_invalid: [503, 'Gemini 载荷安装或校验失败，请检查宿主服务日志'],
  gemini_payload_not_installed: [503, '请先在宿主机安装 Gemini 签名载荷，再兑换内核'],
  gemini_release_not_configured: [503, '此宿主机尚未配置当前版本的 CRAGGemini 授权'],
  gemini_release_invalid: [503, '宿主机的 CRAGGemini 授权配置无效，请联系部署管理员'],
  gemini_release_code_invalid: [400, '兑换码无效，或不适用于当前版本'],
  gemini_release_payload_mismatch: [409, '宿主机的 CRAGGemini 授权配置与签名载荷不匹配'],
  gemini_release_redemption_required: [403, '请先兑换 CRAGGemini 内核'],
  gemini_egress_unavailable: [503, '缺少可用的 Gemini 出口组件，请检查宿主 kin-egress 安装'],
  gemini_oauth_tools_missing: [503, '缺少 Google 授权所需工具，请检查宿主 ip、nft、setpriv、bwrap 和 curl'],
  gemini_ipv4_forwarding_unavailable: [503, '宿主 IPv4 转发未就绪，无法经绑定代理启动 Google 授权'],
  gemini_authorization_unavailable: [503, 'Gemini 服务已连接，但未能启动 Google 授权，请检查代理与宿主日志'],
  gemini_account_read_failed: [502, '无法通过所选代理读取 Google 账号数据'],
  gemini_api_key_rejected: [400, 'Google 未接受该 Gemini API Key，请检查密钥和项目权限'],
  gemini_terminal_unavailable: [503, '无法启动 Gemini 终端，请检查宿主服务、Antigravity 安装和绑定代理'],
  gemini_terminal_conflict: [409, '此 Gemini 环境已有终端会话或正在执行其他操作，请稍后重试'],
  gemini_terminal_requires_oauth: [409, 'Antigravity CLI 需要有效的 Google OAuth 凭据，请重新授权后再启动'],
  gemini_terminal_limit: [429, '终端会话或连接票据已达上限，请关闭现有终端或稍后重试'],
}

export function isGeminiPanelPath(value) {
  return value === PANEL_PATH || value.startsWith(`${PANEL_PATH}/`)
}

export function isGeminiPublicPath(value) {
  return value === PUBLIC_PATH || value.startsWith(`${PUBLIC_PATH}/`)
}

export function geminiKeyAllowsPath(pathname, method) {
  return (
    isGeminiPublicPath(pathname) ||
    (method === 'GET' && ['/models', '/v1/models', '/v1/usage', '/v1/me/quota', '/v1/me/usage'].includes(pathname))
  )
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
  if (process.platform !== 'linux' || process.arch !== 'x64') throw hostError('gemini_host_unsupported_platform')
  if (!path.isAbsolute(socketPath || '')) throw hostError('gemini_host_invalid_socket')
  const terminal = operation.startsWith('terminal-')
  const timeout =
    operation === 'models' ? 40000 : ['create', 'redeem', 'terminal-start'].includes(operation) ? 60000 : 30000
  const body = JSON.stringify(payload)
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
        method: 'POST',
        path: `/${operation}`,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        signal: AbortSignal.timeout(timeout),
      },
      async (response) => {
        try {
          const chunks = []
          let total = 0
          for await (const chunk of response) {
            total += chunk.length
            if (total > 512 * 1024) throw hostError(PROTOCOL_ERROR)
            chunks.push(chunk)
          }
          const data = JSON.parse(Buffer.concat(chunks))
          if (response.statusCode !== 200 && typeof data?.code === 'string' && Object.hasOwn(HOST_ERRORS, data.code))
            throw hostError(data.code, response.statusCode)
          if (!terminal && operation !== 'redeem' && response.statusCode === 404)
            throw hostError('gemini_environment_not_found', 404)
          if (!terminal && operation !== 'redeem' && response.statusCode === 409)
            throw hostError('gemini_environment_conflict', 409)
          if (terminal && response.statusCode === 404) throw hostError('gemini_terminal_unavailable')
          if (response.statusCode !== 200) throw hostError(FAILURE)
          resolve(data)
        } catch (error) {
          response.destroy()
          reject(error instanceof SyntaxError ? hostError(PROTOCOL_ERROR) : error)
        }
      },
    )
    request.once('error', (error) => reject(hostError(SOCKET_ERRORS.get(error.code) || FAILURE)))
    request.end(body)
  })
}

function redactProxyAuth(value) {
  return value.replace(/socks5h?:\/\/[^\s/?#<>"`]*@[^\s<>"`]*/gi, '[redacted proxy URL]')
}

function text(value, size = 128) {
  return typeof value === 'string' && value.length ? redactProxyAuth(value).slice(0, size) : null
}

function items(value, size, project) {
  return Array.isArray(value) ? value.slice(0, size).map(project).filter(Boolean) : []
}

function modelName(model) {
  return typeof model === 'string' && MODEL.test(model) ? model : null
}

function validId(value) {
  return typeof value === 'string' && ID.test(value)
}

function validRunId(value) {
  return typeof value === 'string' && RUN_ID.test(value)
}

function validPrompt(value) {
  return (
    typeof value === 'string' &&
    value.length <= MAX_PROMPT_BYTES &&
    Buffer.byteLength(value, 'utf8') <= MAX_PROMPT_BYTES &&
    value.trim().length > 0 &&
    !/[\uD800-\uDFFF]/u.test(value)
  )
}

function probeView(result) {
  if (typeof result?.ok !== 'boolean') throw hostError(PROTOCOL_ERROR)
  return {
    ok: result.ok,
    latency_ms: Number.isFinite(result.latency_ms) && result.latency_ms >= 0 ? result.latency_ms : null,
    ...(result.ok ? {} : { code: 'gemini_proxy_probe_failed' }),
  }
}

function runView(result) {
  if (!RUN_STATES.has(result?.state) || typeof result.text !== 'string') throw hostError(PROTOCOL_ERROR)
  const view = { state: result.state, text: redactProxyAuth(result.text).slice(0, MAX_TEST_TEXT) }
  const usage = {}
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) {
    const count = result.usage?.[key]
    if (Number.isSafeInteger(count) && count >= 0) usage[key] = count
  }
  if (Object.keys(usage).length) view.usage = usage
  if (result.state === 'failed') {
    const supplied = result.error?.code
    const code =
      typeof supplied === 'string' && Object.hasOwn(RUN_ERRORS, supplied) ? supplied : 'gemini_inference_failed'
    view.error = { code, message: RUN_ERRORS[code][1] }
  }
  return view
}

function isFraction(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1
}

function accountView(account) {
  if (!ACCOUNT_STATES.has(account?.state)) return null
  const current = account.state === 'ok' || account.state === 'partial'
  return {
    state: account.state,
    checked_at: text(account.checked_at),
    data_at: text(account.data_at) || (current ? text(account.checked_at) : null),
    email: text(account.email, 254),
    project_id: text(account.project_id),
    region: text(account.region),
    plan: text(account.plan),
    expires_at: text(account.expires_at),
    quotas: items(account.quotas, 128, (quota) =>
      modelName(quota?.model) && isFraction(quota.remaining_fraction)
        ? { model: quota.model, remaining_fraction: quota.remaining_fraction, reset_at: text(quota.reset_at) }
        : null,
    ),
    quota_groups: items(account.quota_groups, 12, (group) => {
      const name = text(group?.name)
      const windows = items(group?.windows, 4, (window) => {
        if (
          !modelName(window?.id) ||
          !['5h', 'weekly'].includes(window.period) ||
          !(window.remaining_fraction === null || isFraction(window.remaining_fraction))
        )
          return null
        return {
          id: window.id,
          period: window.period,
          remaining_fraction: window.remaining_fraction,
          reset_at: text(window.reset_at),
        }
      })
      return name && windows.length ? { name, windows } : null
    }),
    credits: items(account.credits, 16, (credit) => {
      const type = text(credit?.type)
      const amount = text(credit?.amount)
      return type && amount != null ? { type, amount } : null
    }),
  }
}

function environmentView(value, { id, proxyId } = {}) {
  if (
    !validId(value?.id) ||
    !validId(value.proxy_id) ||
    !STATES.has(value.auth_state) ||
    (id !== undefined && value.id !== id) ||
    (proxyId !== undefined && value.proxy_id !== proxyId)
  ) {
    throw hostError(PROTOCOL_ERROR)
  }
  return {
    id: value.id,
    proxy_id: value.proxy_id,
    name: text(value.name, 80) || '',
    auth_state: value.auth_state,
    auth_method: value.auth_method === 'api_key' ? 'api_key' : 'oauth',
    kernel_version: text(value.kernel_version),
    runtime_ready: value.runtime_ready === true,
    models: items(value.models, 128, modelName),
    ...(value.models_discovered === true && { models_discovered: true }),
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

function proxyFor(proxyPool, proxyId, { allowUnhealthy = false } = {}) {
  if (!validId(proxyId)) throw hostError('gemini_proxy_unavailable', 409)
  const proxy = proxyPool?.snapshot({ ownerUserId: null }).proxies.find((entry) => entry.id === proxyId)
  if (
    !proxy?.enabled ||
    (!allowUnhealthy && (proxy.status === 'dead' || proxy.status === 'fail')) ||
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

async function readEnvironment(callHost, id) {
  return environmentView(await callHost('get', { id }), { id })
}

function boundProxy(proxyPool, environment, options) {
  return { proxy_id: environment.proxy_id, proxy_url: proxyFor(proxyPool(), environment.proxy_id, options) }
}

const defaultCallHost = (operation, payload) =>
  hostRequest(process.env.KIN_GEMINI_HOST_SOCKET ?? '/run/vm2api-gemini/control.sock', operation, payload)

export function createGeminiTerminal({ proxyPool, callHost = defaultCallHost }) {
  return createGeminiTerminalBridge({
    callHost,
    async resolveTarget(id) {
      const environment = await callHost('get', { id })
      if (environment?.id !== id) throw hostError(PROTOCOL_ERROR)
      if (environment.payload_state === 'awaiting_redemption') {
        throw hostError('gemini_release_redemption_required', 403)
      }
      if (PAYLOAD_ISSUES.has(environment.payload_issue)) {
        throw hostError(environment.payload_issue, HOST_ERRORS[environment.payload_issue][0])
      }
      if (environment.auth_method !== 'oauth' || environment.auth_state !== 'authorized') {
        throw hostError('gemini_terminal_requires_oauth', 409)
      }
      if (typeof environment.proxy_id !== 'string' || !ID.test(environment.proxy_id)) {
        throw hostError('gemini_proxy_unavailable', 409)
      }
      return { proxy_id: environment.proxy_id, proxy_url: proxyFor(proxyPool(), environment.proxy_id) }
    },
    errorMessage(code, stage) {
      if (code === 'gemini_proxy_unavailable') return '需要绑定可用的 IPv4 SOCKS5 代理'
      if (code === 'gemini_environment_not_found') return 'Gemini 环境不存在'
      if (code === 'gemini_environment_conflict') return 'Gemini 环境状态已变化，请刷新后重试'
      return (
        (Object.hasOwn(HOST_ERRORS, code) && HOST_ERRORS[code][1]) ||
        (stage === 'resolve'
          ? '无法读取 Gemini 环境，请检查宿主服务'
          : stage === 'io'
            ? 'Gemini 终端连接中断，请检查宿主服务或重新打开终端'
            : HOST_ERRORS.gemini_terminal_unavailable[1])
      )
    },
  })
}

export function createGeminiPanelHandler({ json, readBody, proxyPool, terminal, callHost = defaultCallHost }) {
  return async function handleGeminiPanel(req, res, pathname) {
    const ok = (data) => json(res, 200, { ok: true, data })
    const fail = (status, code, message = code) => json(res, status, { ok: false, error: { code, message } })
    res.setHeader('Cache-Control', 'no-store')
    try {
      if (req.method === 'GET' && pathname === PANEL_PATH) {
        const view = await callHost('list', {})
        if (!Array.isArray(view?.environments)) throw hostError(PROTOCOL_ERROR)
        return ok({
          available: true,
          payload_state: PAYLOAD_STATES.has(view.payload_state) ? view.payload_state : 'unknown',
          payload_issue: PAYLOAD_ISSUES.has(view.payload_issue) ? view.payload_issue : null,
          release_activated: typeof view.release_activated === 'boolean' ? view.release_activated : null,
          oauth_runtime_issue: OAUTH_ISSUES.has(view.oauth_runtime_issue) ? view.oauth_runtime_issue : null,
          environments: view.environments.map((value) => {
            const environment = environmentView(value)
            if (!proxyPool) return environment
            try {
              proxyFor(proxyPool(), environment.proxy_id)
              environment.proxy_ready = true
            } catch (error) {
              if (error?.code !== 'gemini_proxy_unavailable') throw error
              environment.proxy_ready = false
            }
            return environment
          }),
        })
      }
      // All Gemini panel routes pass through the existing admin-only panel ACL.
      if (req.method === 'POST' && pathname === `${PANEL_PATH}/payload/redeem`) {
        const body = await readBody(req, 1024)
        const code = typeof body?.redemption_code === 'string' ? body.redemption_code.trim() : ''
        if (!RELEASE_CODE.test(code)) {
          const [status, message] = HOST_ERRORS.gemini_release_code_invalid
          return fail(status, 'gemini_release_code_invalid', message)
        }
        const result = await callHost('redeem', { redemption_code: code })
        if (typeof result?.kernel_version !== 'string' || !/^[a-zA-Z0-9.-]{1,64}$/.test(result.kernel_version)) {
          throw hostError(PROTOCOL_ERROR)
        }
        return ok({ kernel_version: result.kernel_version })
      }
      if (req.method === 'POST' && pathname === `${PANEL_PATH}/environments`) {
        const body = await readBody(req, 4096)
        const name = typeof body?.name === 'string' ? body.name.trim() : ''
        const method = body?.auth_method ?? 'oauth'
        if (!name || name.length > 80 || !validId(body?.proxy_id) || !['oauth', 'api_key'].includes(method)) {
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
        /^\/api\/panel\/gemini\/environments\/([A-Za-z0-9_-]{1,64})(?:\/(authorization|disable|refresh|terminal-ticket|proxy\/probe|proxy|models|test-chat)(?:\/([^/]+))?)?$/.exec(
          pathname,
        )
      if (!match || !validId(match[1])) return fail(404, 'not_found')
      const [, id, action, runId] = match
      if (runId !== undefined) {
        if (action !== 'test-chat' || !['GET', 'DELETE'].includes(req.method)) return fail(404, 'not_found')
        if (!validRunId(runId)) return fail(400, 'gemini_invalid_run_id')
        const payload = { id, run_id: runId }
        if (req.method === 'GET') return ok(runView(await callHost('test-chat-status', payload)))
        const result = await callHost('test-chat-cancel', payload)
        if (result?.cancelled !== true) throw hostError(PROTOCOL_ERROR)
        return ok({ cancelled: true })
      }
      if (req.method === 'PUT' && action === 'proxy') {
        const body = await readBody(req, 4096)
        const proxyId = body?.proxy_id
        if (!validId(proxyId)) return fail(400, 'gemini_invalid_proxy_id')
        const environment = await readEnvironment(callHost, id)
        const result = await callHost('proxy-bind', {
          id,
          previous_proxy_id: environment.proxy_id,
          proxy_id: proxyId,
          proxy_url: proxyFor(proxyPool(), proxyId),
        })
        return ok(environmentView(result, { id, proxyId }))
      }
      if (req.method === 'POST' && action === 'proxy/probe') {
        const environment = await readEnvironment(callHost, id)
        // Only probing the existing binding may bypass stored health. Scope,
        // enablement, policy, and valid IPv4 SOCKS5 still apply.
        const target = boundProxy(proxyPool, environment, { allowUnhealthy: true })
        return ok(probeView(await callHost('proxy-probe', { id, ...target })))
      }
      if (req.method === 'POST' && action === 'models') {
        const environment = await readEnvironment(callHost, id)
        const result = await callHost('models', { id, ...boundProxy(proxyPool, environment) })
        const view = environmentView(result, { id, proxyId: environment.proxy_id })
        if (!view.models.length) throw hostError('gemini_models_empty')
        return ok(view)
      }
      if (req.method === 'POST' && action === 'test-chat') {
        // A JSON string may need six wire bytes per decoded byte.
        const body = await readBody(req, 32 * 1024)
        const model = modelName(body?.model)
        const prompt = body?.prompt
        if (!model) return fail(400, 'gemini_invalid_model')
        if (!validPrompt(prompt)) return fail(400, 'gemini_invalid_prompt')
        const environment = await readEnvironment(callHost, id)
        const result = await callHost('test-chat', { id, ...boundProxy(proxyPool, environment), model, prompt })
        if (!validRunId(result?.run_id)) throw hostError(PROTOCOL_ERROR)
        return ok({ run_id: result.run_id })
      }
      if (req.method === 'POST' && action === 'terminal-ticket') {
        if (!terminal) throw hostError('gemini_terminal_unavailable')
        return ok(await terminal.issueTicket(id))
      }
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
      if (req.method === 'GET' && pathname === PANEL_PATH) {
        const code = Object.hasOwn(HOST_ERRORS, error?.code) ? error.code : FAILURE
        return ok({
          available: false,
          host_error: code,
          host_message: HOST_ERRORS[code]?.[1] || '未检测到可用的 Gemini 宿主机服务',
          environments: [],
        })
      }
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

export function handleGeminiPublic(req, res, json) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.apiKeyKind !== 'managed' || req.apiKeyRecord?.group_type !== 'gemini') {
    return json(res, 403, {
      error: {
        type: 'permission_error',
        code: 'gemini_key_required',
        message: 'This endpoint requires a dedicated Gemini API key.',
      },
    })
  }
  return json(res, 503, {
    error: {
      type: 'service_unavailable',
      code: 'gemini_runtime_not_supported',
      message: 'The current CRAGAnti payload does not support Google OAuth inference.',
    },
  })
}
