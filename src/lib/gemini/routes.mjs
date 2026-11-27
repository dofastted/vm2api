import crypto from 'node:crypto'
import http from 'node:http'
import { isIP } from 'node:net'
import path from 'node:path'
import { filterModelCatalogForKey, keyModelError } from '../admin/key-models.mjs'
import { formatHealthSse, synthesizeProtocolResponse } from '../admin/health-probe.mjs'
import { summarizeBody } from '../admin/request-log.mjs'
import { filterModelsForPoolAccess, keyTierPolicyFromRecord, resolvePoolAccessForKey } from '../admin/key-scope.mjs'
import { isDbOpen } from '../db/database.mjs'
import { requestedPoolIdFromHeaders } from '../protocol/pool-prompt-policy.mjs'
import { PLATFORM_SCOPE, normalizeOwnerId, ownerScopeFromRequest } from '../admin/resource-owner.mjs'
import {
  buildGeminiRequest,
  createGeminiProtocolStreamEncoder,
  formatGeminiProtocolError,
  formatGeminiProtocolStreamError,
  parseInboundToGemini,
  renderGeminiProtocolResponse,
} from '../protocol/gemini-convert.mjs'
import {
  extractImpliedModelEffort,
  isGeminiSeriesId,
  resolveGeminiDefaultEffort,
} from '../protocol/gemini-model-policy.mjs'
import {
  THIRD_PARTY_CLIENT_SESSION_ID,
  reasoningEffortOf,
  resolveGeminiReasoningEffort,
  sessionIdForLog,
} from '../protocol/log-fields.mjs'
import { createGeminiTerminalBridge } from './terminal.mjs'
import { createGeminiMaintenanceHandler } from './maintenance.mjs'
import { ANTIGRAVITY_PROVIDERS, ANTIGRAVITY_QUOTA_GROUPS, isAntigravityRoutedModel } from './model-catalog.mjs'
import { normalizeGeminiOAuthImport } from './oauth-import.mjs'
import { normalizeGeminiOutboundPrompt } from './prompt-normalizer.mjs'
import { isGeminiProtocolAllowed } from './routing-config.mjs'
import { GEMINI_LICENSE_MESSAGES } from './subscription.mjs'
import { createGeminiSlotPrefs, parseGeminiDisplayName, parseGeminiScheduleLevel } from './slot-prefs.mjs'
import { resolveCragGeminiPromptPolicy } from './system-prompt.mjs'
import { configuredDnsUpstream, proxyDnsEmptyTypes } from '../vm/egress.mjs'
import { compileWithProtoFront, protoFrontMode } from '../transport/proto-front-client.mjs'
import {
  clientBlockErrorOf,
  isTrustedGateDecision,
  resolveRiskRepos,
  runUnifiedPreDispatch,
} from '../protocol/unified-pre-dispatch.mjs'

const PANEL_PATH = '/api/panel/gemini'
const PUBLIC_PATH = '/v1/gemini/sessions'
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const MODEL = /^[a-z0-9][a-z0-9._-]{0,99}$/
const RUN_ID = /^[a-f0-9]{32}$/
const MAX_CONCURRENCY = 64
const MAX_PROMPT_BYTES = 4096
const MAX_TEST_TEXT = 16 * 1024
const AUTH_CODE = /^[A-Za-z0-9._~/-]{1,2048}$/
const AUTH_STATE = /^[A-Za-z0-9._~-]{1,512}$/
const API_KEY = /^[A-Za-z0-9_-]{20,256}$/
const RELEASE_CODE = /^CGG1-[A-Za-z0-9_-]{43}$/
const STATES = new Set(['unverified', 'authorizing', 'authorized', 'reauth_required', 'disabled'])
const ACCOUNT_STATES = new Set(['ok', 'partial', 'error', 'reauth_required'])
const ACCOUNT_ELIGIBILITIES = new Set([
  'verification_required',
  'location_unsupported',
  'client_unsupported',
  'ineligible',
])
const PAYLOAD_STATES = new Set(['installed', 'install_on_create', 'awaiting_redemption', 'not_configured', 'invalid'])
const RUN_STATES = new Set(['running', 'completed', 'failed'])
const RUN_ERRORS = {
  gemini_oauth_required: [
    409,
    'Google OAuth 凭据已失效或被吊销（401 / invalid_grant），请在「账号」页重新完成官方 Google 授权（建议浏览器与绑定代理保持同区出口）',
  ],
  gemini_location_unsupported: [
    403,
    'Google 判定当前账号或出口地区不支持 Antigravity（403 UNSUPPORTED_REGION）；拉取模型成功不代表可对话，请在「代理」页更换支持地区（如美国住宅）的代理后重试，或更换账号',
  ],
  gemini_account_verification_required: [
    403,
    'Google 要求先在浏览器完成该账号的身份验证（403 VALIDATION_REQUIRED）；拉取模型成功不代表可对话，请在对应账号浏览器打开「账号」页的 Google 验证链接完成核验后再试',
  ],
  gemini_client_unsupported: [
    403,
    'Google 拒绝当前 Antigravity 客户端版本或标识（403 UNSUPPORTED_CLIENT），并非账号订阅失效；请前往「设置 → Gemini 维护」更新至最新 CRAGGemini / CLI 版本，或刷新账号重试',
  ],
  gemini_account_ineligible: [
    403,
    'Google 判定当前账号暂不符合 Antigravity 使用资格（403），请检查账号订阅状态、年龄限制或更换可用个人账号',
  ],
  gemini_proxy_error: [
    502,
    '无法通过绑定代理连接 Google 上游，请在「代理」页探活检查代理节点连通性与出口质量，或更换代理后重试',
  ],
  gemini_model_unavailable: [409, '上游不支持或未开放所选模型（404），请先点击「拉取模型」刷新最新模型目录后再试'],
  gemini_models_empty: [502, '上游未返回可调用模型，请检查账号资格与代理连通性，或重新完成授权后再拉取'],
  gemini_api_key_invalid: [
    400,
    '当前 Gemini API Key 无效或权限不足（400/401/403），请在 Google AI Studio 核对密钥状态与项目权限后重新配置',
  ],
  gemini_quota_exhausted: [
    429,
    '上游模型配额已用尽（429 RESOURCE_EXHAUSTED），请等待配额重置、切换其他模型或调度到其他账号',
  ],
  gemini_pool_overloaded: [429, '号池负载过高，请稍后再试'],
  gemini_upstream_unavailable: [503, 'Google 上游服务暂时不可用（503），已自动切换其他账号重试'],
  gemini_content_rejected: [
    429,
    '上游拒绝了当前请求提示词（429 内容触发过滤，非账号配额耗尽），请精简或调整系统提示词后重试',
  ],
  gemini_inference_timeout: [503, '上游响应超时（504），可能是代理延迟过高或模型负载波动，请检查代理延迟后重试'],
  gemini_inference_invalid_output: [502, '上游返回空回复或无法解析的流式响应，请重试或切换其他模型确认'],
  gemini_inference_start_failed: [
    503,
    '无法启动本地 Gemini 推理进程，请前往「设置 → Gemini 维护」检查宿主服务与载荷状态',
  ],
  gemini_inference_cancelled: [409, 'Gemini 测试已手动取消'],
  gemini_session_conflict: [
    409,
    '当前出站会话发生冲突：工具调用仍在挂起等待结果，而请求又追加了新的用户输入。网关已清除该会话与工具续接绑定；请重新发起请求。在部分路由下可能在首字节输出前、同一账号内自动换会话重试一次；若仍失败，请使用新的 X-Session-Id，或先仅回传工具结果再发送后续文本。',
  ],
  gemini_inference_output_limit: [502, '模型单次回复超过测试输出上限，请精简提示词或限制回复长度后重试'],
  gemini_inference_tool_blocked: [502, '当前测试通道限制了该工具调用，请改用纯文本提示词重试'],
  gemini_inference_failed: [
    502,
    '上游推理失败（502），请先刷新账号状态确认是否触发 Google 身份验证/风控，再检查绑定代理与宿主服务日志',
  ],
  gemini_native_tty_unavailable: [503, '宿主机没有可用的虚拟终端资源，请检查宿主机状态并重启 vm2api-gemini 服务'],
  gemini_native_worker_unavailable: [
    503,
    'CRAGGemini 原生常驻内核未就绪，请稍候等待自动预热，或前往「设置 → Gemini 维护」检查载荷与宿主服务',
  ],
  gemini_native_config_invalid: [
    503,
    'CRAGGemini 拒绝了宿主生成的 worker 配置，请前往「设置 → Gemini 维护」对齐宿主脚本与签名载荷版本',
  ],
  license_required: [403, GEMINI_LICENSE_MESSAGES.license_required],
  license_expired: [403, GEMINI_LICENSE_MESSAGES.license_expired],
  license_not_yet_valid: [403, GEMINI_LICENSE_MESSAGES.license_not_yet_valid],
  license_invalid: [403, GEMINI_LICENSE_MESSAGES.license_invalid],
  license_binding_mismatch: [403, GEMINI_LICENSE_MESSAGES.license_binding_mismatch],
  license_payload_key_mismatch: [403, GEMINI_LICENSE_MESSAGES.license_payload_key_mismatch],
  license_unconfigured: [403, GEMINI_LICENSE_MESSAGES.license_unconfigured],
  gemini_subscription_sync_pending: [503, GEMINI_LICENSE_MESSAGES.gemini_subscription_sync_pending],
}
const INFERENCE_STATES = new Set([...RUN_STATES, 'cancelled'])
const INFERENCE_ERROR_CODES = new Set([
  ...Object.keys(RUN_ERRORS),
  'gemini_inference_bad_input',
  'gemini_native_bridge_timeout',
])
const INFERENCE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/
const FAILURE = 'gemini_host_unavailable'
const PROTOCOL_ERROR = 'gemini_host_protocol_error'
const SOCKET_ERRORS = new Map([
  ['ENOENT', 'gemini_host_socket_missing'],
  ['ECONNREFUSED', 'gemini_host_socket_refused'],
  ['EACCES', 'gemini_host_socket_denied'],
  ['EPERM', 'gemini_host_socket_denied'],
  ['ABORT_ERR', 'gemini_host_timeout'],
])
const HOST_INFRASTRUCTURE_CODES = new Set([
  ...SOCKET_ERRORS.values(),
  'gemini_host_invalid_socket',
  'gemini_host_unsupported_platform',
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
  'gemini_sandbox_apparmor_restricted',
  'gemini_sandbox_unavailable',
])
const HOST_ERRORS = {
  ...RUN_ERRORS,
  gemini_operation_busy: [409, '此 Gemini 环境正在执行其他操作，请稍后重试'],
  gemini_invalid_concurrency: [400, '并发数必须为 1 到 64 的整数'],
  gemini_proxy_calibration_mismatch: [409, '绑定代理校验摘要不匹配，请重新校准代理'],
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
  gemini_oauth_tools_missing: [
    503,
    '缺少 Gemini OAuth/TUI 所需工具，请检查宿主 ip、nft、setpriv、bwrap、openvt 和 curl',
  ],
  gemini_ipv4_forwarding_unavailable: [503, '宿主 IPv4 转发未就绪，无法经绑定代理启动 Google 授权'],
  gemini_sandbox_apparmor_restricted: [
    503,
    '宿主机 AppArmor 限制了非特权 user namespace，导致 Gemini 沙箱无法启动；请在宿主机执行 prepare-gemini 或前往「设置 → Gemini 维护」执行修复安装',
  ],
  gemini_sandbox_unavailable: [
    503,
    '宿主机非特权沙箱（bwrap）不可用，无法启动 Gemini 隔离进程；请前往「设置 → Gemini 维护」诊断宿主并检查宿主服务日志',
  ],
  // Unregistered codes fall through to FAILURE, which reads as "no host service at
  // all" -- the one answer this is not. The socket answered, so the host is up and
  // it is the authorization launch that failed; losing that sent #1622 looking at
  // the service and its socket instead of the egress path.
  gemini_authorization_unavailable: [
    503,
    'Gemini 宿主服务在线，但 Google 授权流程未能启动，请检查宿主服务日志与绑定代理的出口连通性',
  ],
  gemini_native_bridge_timeout: [503, 'CRAGGemini TUI 未能在时限内连接 native worker'],
  gemini_account_read_failed: [502, '无法通过所选代理读取 Google 账号数据'],
  gemini_api_key_rejected: [400, 'Google 未接受该 Gemini API Key，请检查密钥和项目权限'],
  gemini_terminal_unavailable: [503, '无法启动 Gemini 终端，请检查宿主服务、Antigravity 安装和绑定代理'],
  gemini_terminal_conflict: [409, '此 Gemini 环境已有终端会话或正在执行其他操作，请稍后重试'],
  gemini_terminal_requires_oauth: [409, 'Antigravity CLI 需要有效的 Google OAuth 凭据，请重新授权后再启动'],
  gemini_terminal_limit: [429, '终端会话或连接票据已达上限，请关闭现有终端或稍后重试'],
  gemini_oauth_import_invalid: [400, 'Google 账号文件中的凭据格式无效'],
  gemini_oauth_import_rejected: [400, 'Google 凭据已过期或未获授权，请导出新文件或进行 Google 授权'],
  gemini_oauth_client_not_configured: [
    503,
    '宿主机未配置可用的 Google OAuth 客户端凭据，请检查 /etc/vm2api/gemini-oauth.env 或重新安装 Gemini 签名载荷',
  ],
  gemini_test_oauth_unsupported: [503, '当前签名载荷不支持 Google OAuth 推理测试'],
  gemini_test_auth_required: [409, '请先为 Gemini 环境完成授权'],
  gemini_test_invalid_input: [400, '请选择此环境的 Gemini 模型并输入有效的测试内容'],
  gemini_maintenance_lock_invalid: [503, 'Gemini 维护锁不受信，请联系宿主管理员修复属主和权限'],
  gemini_subscription_oauth_only: [409, GEMINI_LICENSE_MESSAGES.gemini_subscription_oauth_only],
  gemini_subscription_not_active: [409, GEMINI_LICENSE_MESSAGES.gemini_subscription_not_active],
  gemini_subscription_reclaim_unsupported: [409, GEMINI_LICENSE_MESSAGES.gemini_subscription_reclaim_unsupported],
  gemini_subscription_authority_unavailable: [502, GEMINI_LICENSE_MESSAGES.gemini_subscription_authority_unavailable],
  gemini_subscription_invalid_entitlement: [502, GEMINI_LICENSE_MESSAGES.gemini_subscription_invalid_entitlement],
  gemini_subscription_invalid_voucher: [400, GEMINI_LICENSE_MESSAGES.gemini_subscription_invalid_voucher],
  gemini_subscription_package_unready: [409, GEMINI_LICENSE_MESSAGES.gemini_subscription_package_unready],
  gemini_subscription_busy: [409, GEMINI_LICENSE_MESSAGES.gemini_subscription_busy],
  gemini_subscription_invalid_code: [400, GEMINI_LICENSE_MESSAGES.gemini_subscription_invalid_code],
  slot_limit_reached: [409, GEMINI_LICENSE_MESSAGES.slot_limit_reached],
  host_subscription_inactive: [403, GEMINI_LICENSE_MESSAGES.host_subscription_inactive],
  host_binding_conflict: [409, GEMINI_LICENSE_MESSAGES.host_binding_conflict],
  redeem_unavailable: [404, GEMINI_LICENSE_MESSAGES.redeem_unavailable],
  host_redeem_conflict: [409, GEMINI_LICENSE_MESSAGES.host_redeem_conflict],
  issuer_mismatch: [409, GEMINI_LICENSE_MESSAGES.issuer_mismatch],
  payload_key_unknown: [400, GEMINI_LICENSE_MESSAGES.payload_key_unknown],
  payload_key_conflict: [409, GEMINI_LICENSE_MESSAGES.payload_key_conflict],
  renewal_unavailable: [409, GEMINI_LICENSE_MESSAGES.renewal_unavailable],
  host_transfer_cooldown: [409, GEMINI_LICENSE_MESSAGES.host_transfer_cooldown],
  request_conflict: [409, GEMINI_LICENSE_MESSAGES.request_conflict],
  invalid_request: [400, GEMINI_LICENSE_MESSAGES.invalid_request],
  not_found: [404, GEMINI_LICENSE_MESSAGES.not_found],
  auth_forbidden: [403, GEMINI_LICENSE_MESSAGES.auth_forbidden],
}

export function isGeminiPanelPath(value) {
  return value === PANEL_PATH || value.startsWith(`${PANEL_PATH}/`)
}

const GEMINI_GENERATE_PATH_RE = /^\/(v1beta|v1)\/models\/([^/:]+):(generateContent|streamGenerateContent)$/
const GEMINI_MODEL_GET_PATH_RE = /^\/(v1beta|v1)\/models\/([^/:]+)$/

export function parseGeminiGeneratePath(pathname) {
  const match = GEMINI_GENERATE_PATH_RE.exec(String(pathname || ''))
  if (!match) return null
  let model = match[2]
  try {
    model = decodeURIComponent(match[2])
  } catch {}
  return {
    version: match[1],
    model,
    action: match[3],
    stream: match[3] === 'streamGenerateContent',
  }
}

export function parseGeminiModelGetPath(pathname) {
  const match = GEMINI_MODEL_GET_PATH_RE.exec(String(pathname || ''))
  if (!match) return null
  let model = match[2]
  try {
    model = decodeURIComponent(match[2])
  } catch {}
  return { version: match[1], model }
}

/** Paths only Gemini serves. These route by path alone. */
export function isGeminiPublicPath(value) {
  return (
    value === PUBLIC_PATH ||
    value.startsWith(`${PUBLIC_PATH}/`) ||
    Boolean(parseGeminiGeneratePath(value)) ||
    /^\/v1beta\/models\/[^/:]+$/.test(value)
  )
}

/**
 * Paths Gemini shares with the OpenAI protocol handlers. Routing these by path
 * alone would shadow those handlers for every other caller, so the dispatch
 * must also require a Gemini-group key — the same way /v1/models does.
 */
export function isGeminiSharedPath(value) {
  return (
    value === '/v1/chat/completions' ||
    value === '/chat/completions' ||
    value === '/v1/responses' ||
    value === '/responses'
  )
}

export function geminiKeyAllowsPath(pathname, method) {
  return (
    isGeminiPublicPath(pathname) ||
    // A Gemini key still reaches the shared OpenAI paths; only the dispatch
    // for other callers is path-independent.
    isGeminiSharedPath(pathname) ||
    (method === 'POST' && (pathname === '/v1/messages' || pathname === '/messages')) ||
    (method === 'GET' &&
      (['/models', '/v1/models', '/v1beta/models', '/v1/usage', '/v1/me/quota', '/v1/me/usage'].includes(pathname) ||
        Boolean(parseGeminiModelGetPath(pathname))))
  )
}

export function geminiProxyFor(proxyPool, proxyId, opts) {
  return proxyFor(proxyPool, proxyId, opts)
}

export function geminiProxyEgressOptionsFor(proxyPool, proxyId, opts) {
  return proxyEgressOptionsFor(proxyPool, proxyId, opts)
}

const AUTH_STAGE_MESSAGES = {
  network_prepare: 'Gemini 宿主服务在线，但隔离网络初始化失败，请检查宿主服务日志与 ip/nft/iptables 环境',
  relay_start: 'Gemini 宿主服务在线，但宿主侧代理中继未能启动，请检查宿主服务日志',
  proxy_probe: 'Gemini 宿主服务在线，但隔离出口无法连通绑定代理，请检查绑定代理可用性与宿主前置代理路径',
  egress_start: 'Gemini 宿主服务在线，但隔离出口转发组件（kin-egress）未能就绪，请检查宿主服务日志',
  sandbox_denied:
    'Gemini 宿主服务在线，但宿主机沙箱策略（AppArmor / bwrap）拒绝启动隔离进程，请前往「设置 → Gemini 维护」诊断并修复宿主',
  cli_launch: 'Gemini 宿主服务在线，但 Antigravity CLI 授权进程未能拉起，请检查宿主服务日志与签名载荷',
  cli_early_exit:
    'Gemini 宿主服务在线，但 Antigravity CLI 授权进程在输出授权链接前异常退出，请检查宿主服务日志、签名载荷与沙箱状态',
  challenge_wait: 'Gemini 宿主服务在线，但未能在时限内获取 Google 授权链接，请检查绑定代理连通性与宿主服务日志',
}
const AUTH_STAGE_CODES = new Set([
  'gemini_authorization_unavailable',
  'gemini_sandbox_apparmor_restricted',
  'gemini_sandbox_unavailable',
])

function hostError(code, status = 503, extra = null) {
  return Object.assign(new Error(code), { code, status, ...(extra || {}) })
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
          if (response.statusCode !== 200 && typeof data?.code === 'string' && Object.hasOwn(HOST_ERRORS, data.code)) {
            const stage =
              AUTH_STAGE_CODES.has(data.code) &&
              typeof data.stage === 'string' &&
              Object.hasOwn(AUTH_STAGE_MESSAGES, data.stage)
                ? data.stage
                : null
            throw hostError(data.code, response.statusCode, stage ? { stage } : null)
          }
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
  return value.replace(/(?:socks5h?|https?):\/\/[^\s/?#<>"`]*@[^\s<>"`]*/gi, '[redacted proxy URL]')
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

function parseConcurrency(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_CONCURRENCY ? value : null
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

function safeGoogleValidationUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null
  try {
    const url = new URL(value.trim())
    if (url.origin !== 'https://accounts.google.com' || url.username || url.password || url.hash) return null
    return url.href
  } catch {
    return null
  }
}

function accountView(account) {
  if (!ACCOUNT_STATES.has(account?.state)) return null
  const current = account.state === 'ok' || account.state === 'partial'
  const eligibility = ACCOUNT_ELIGIBILITIES.has(account?.eligibility) ? account.eligibility : null
  const validationUrl = safeGoogleValidationUrl(account?.validation_url)
  const modelCatalog = items(account.model_catalog, 128, (entry) =>
    modelName(entry?.id) &&
    ANTIGRAVITY_PROVIDERS.has(entry?.provider) &&
    ANTIGRAVITY_QUOTA_GROUPS.has(entry?.quota_group)
      ? { id: entry.id, provider: entry.provider, quota_group: entry.quota_group }
      : null,
  )
  const errorCode =
    typeof account?.error_code === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(account.error_code)
      ? account.error_code
      : null
  const errorMessage = text(account?.error_message, 240)
  const httpStatus =
    Number.isSafeInteger(account?.http_status) && account.http_status >= 0 && account.http_status <= 599
      ? account.http_status
      : null
  return {
    state: account.state,
    checked_at: text(account.checked_at),
    data_at: text(account.data_at) || (current ? text(account.checked_at) : null),
    email: text(account.email, 254),
    project_id: text(account.project_id),
    region: text(account.region),
    plan: text(account.plan),
    expires_at: text(account.expires_at),
    ...(eligibility ? { eligibility } : {}),
    ...(validationUrl ? { validation_url: validationUrl } : {}),
    ...(errorCode ? { error_code: errorCode } : {}),
    ...(errorMessage ? { error_message: errorMessage } : {}),
    ...(httpStatus != null ? { http_status: httpStatus } : {}),
    ...(modelCatalog.length ? { model_catalog: modelCatalog } : {}),
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

function inferenceTimestamp(value) {
  return typeof value === 'string' && INFERENCE_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value))
    ? value
    : null
}

function lastInferenceView(value) {
  if (!INFERENCE_STATES.has(value?.state)) return null
  const { state } = value
  const model = modelName(value.model)
  const startedAt = inferenceTimestamp(value.started_at)
  const finishedAt = state === 'running' ? null : inferenceTimestamp(value.finished_at)
  if (!model || !startedAt || (state !== 'running' && !finishedAt)) return null
  return {
    state,
    model,
    started_at: startedAt,
    finished_at: finishedAt,
    error_code:
      (state === 'failed' || state === 'cancelled') && INFERENCE_ERROR_CODES.has(value.error_code)
        ? value.error_code
        : null,
  }
}

function cragLicenseView(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return {
    product: text(value.product, 32) || 'craggemini',
    status: text(value.status, 32) || 'unlicensed',
    valid: value.valid === true,
    ...(typeof value.seat_required === 'boolean' ? { seat_required: value.seat_required } : {}),
    ...(text(value.binding, 32) ? { binding: text(value.binding, 32) } : {}),
    ...(text(value.kind, 32) ? { kind: text(value.kind, 32) } : {}),
    ...(text(value.scope, 32) ? { scope: text(value.scope, 32) } : {}),
    ...(Number.isSafeInteger(value.seat) && value.seat > 0 ? { seat: value.seat } : {}),
    ...(text(value.license_id, 128) ? { license_id: text(value.license_id, 128) } : {}),
    ...(text(value.payload_key_id, 64) ? { payload_key_id: text(value.payload_key_id, 64) } : {}),
    ...(typeof value.sync_pending === 'boolean' ? { sync_pending: value.sync_pending } : {}),
    ...(Number.isSafeInteger(value.issued_at) ? { issued_at: value.issued_at } : {}),
    ...(Number.isSafeInteger(value.not_before) ? { not_before: value.not_before } : {}),
    ...(Number.isSafeInteger(value.expires_at) ? { expires_at: value.expires_at } : {}),
    ...(text(value.code, 64) ? { code: text(value.code, 64) } : {}),
    ...(text(value.message, 256) ? { message: text(value.message, 256) } : {}),
  }
}

function geminiUsageView(cost) {
  if (!cost) return null
  const today = cost.today && typeof cost.today === 'object' ? cost.today : null
  const todayInput = Number(cost.today_input_tokens ?? today?.input_tokens ?? 0)
  const todayOut = Number(cost.today_output_tokens ?? today?.output_tokens ?? 0)
  const todayRead = Number(cost.today_cache_read_tokens ?? today?.cache_read_tokens ?? 0)
  const todayWrite = Number(cost.today_cache_creation_tokens ?? today?.cache_creation_tokens ?? 0)
  const prompt = todayInput + todayRead + todayWrite
  const totalTokens =
    Number(cost.input_tokens || 0) +
    Number(cost.output_tokens || 0) +
    Number(cost.cache_read_tokens || 0) +
    Number(cost.cache_creation_tokens || 0)
  return {
    today_cost: Number(cost.today_cost ?? today?.total_cost ?? 0),
    today_requests: Number(cost.today_requests ?? today?.requests ?? 0),
    today_tokens: todayInput + todayOut + todayRead + todayWrite,
    today_input_tokens: todayInput,
    today_output_tokens: todayOut,
    today_cache_read_tokens: todayRead,
    today_cache_creation_tokens: todayWrite,
    cache_hit_rate: prompt > 0 ? Math.min(1, todayRead / prompt) : null,
    window_5h_cost: Number(cost.window_5h_cost || 0),
    window_5h_requests: Number(cost.window_5h_requests || 0),
    window_5h_tokens: Number(cost.window_5h_tokens || 0),
    window_7d_cost: Number(cost.window_7d_cost || 0),
    window_7d_requests: Number(cost.window_7d_requests || 0),
    window_7d_success: Number(cost.window_7d_success || 0),
    window_7d_errors: Number(cost.window_7d_errors || 0),
    window_7d_tokens: Number(cost.window_7d_tokens || 0),
    total_cost: Number(cost.total_cost || 0),
    total_tokens: totalTokens,
    health_24h: Array.isArray(cost.health_24h) ? cost.health_24h : null,
  }
}

function geminiPeriodView(row) {
  if (!row || typeof row !== 'object') return null
  return {
    requests: Number(row.requests || 0),
    input_tokens: Number(row.input_tokens || 0),
    output_tokens: Number(row.output_tokens || 0),
    cache_read_tokens: Number(row.cache_read_tokens || 0),
    cache_creation_tokens: Number(row.cache_creation_tokens || 0),
    total_cost: Number(row.total_cost || 0),
  }
}

function indexGeminiBillingAccounts(requestLog) {
  const byEnvId = new Map()
  if (!requestLog?.billingStats) return byEnvId
  let billing = null
  try {
    billing = requestLog.billingStats()
  } catch {
    return byEnvId
  }
  for (const row of billing?.accounts || []) {
    const vmId = typeof row?.vm_id === 'string' ? row.vm_id : ''
    if (!vmId.startsWith('gemini:')) continue
    const envId = vmId.slice('gemini:'.length)
    if (!envId) continue
    if (!byEnvId.has(envId) || row.account_id === envId) {
      byEnvId.set(envId, row)
    }
  }
  return byEnvId
}

function environmentView(
  value,
  {
    id,
    proxyId,
    proxyPool,
    withProxyReady = false,
    billingReady = false,
    ownerUserId = null,
    usage = null,
    inflight = null,
    slotPref = null,
    restriction = null,
    circuit = null,
  } = {},
) {
  if (
    !validId(value?.id) ||
    !validId(value.proxy_id) ||
    !STATES.has(value.auth_state) ||
    (id !== undefined && value.id !== id) ||
    (proxyId !== undefined && value.proxy_id !== proxyId)
  ) {
    throw hostError(PROTOCOL_ERROR)
  }
  const normalizedOwner = normalizeOwnerId(ownerUserId)
  let proxyUrl
  if (proxyPool && (withProxyReady || value.last_inference != null)) {
    try {
      proxyUrl = proxyFor(proxyPool(), value.proxy_id, { ownerUserId: normalizedOwner })
    } catch (error) {
      if (error?.code !== 'gemini_proxy_unavailable') throw error
    }
  }
  // Compare with the current configured endpoint and credentials, not only the ID.
  // The digest is private to the host/control plane and is not projected out.
  const matchesProxy =
    proxyUrl &&
    value.last_inference != null &&
    crypto.createHash('sha256').update(proxyUrl).digest('hex') === value.last_inference_proxy_sha256
  const resolvedInflight =
    Number.isSafeInteger(inflight) && inflight >= 0
      ? inflight
      : Number.isSafeInteger(value.active_slots) && value.active_slots >= 0
        ? value.active_slots
        : null
  return {
    id: value.id,
    proxy_id: value.proxy_id,
    ...(normalizedOwner ? { owner_user_id: normalizedOwner } : {}),
    ...(withProxyReady && proxyPool && { proxy_ready: Boolean(proxyUrl) }),
    name: (slotPref?.display_name && text(slotPref.display_name, 80)) || text(value.name, 80) || '',
    auth_state: value.auth_state,
    auth_method: value.auth_method === 'api_key' ? 'api_key' : 'oauth',
    schedulable: slotPref ? slotPref.schedulable !== false : true,
    schedule_level: Number.isSafeInteger(slotPref?.schedule_level) ? slotPref.schedule_level : 5,
    schedule_level_mode: slotPref?.schedule_level_mode === 'manual' ? 'manual' : 'auto',
    ...(slotPref?.unschedulable
      ? {
          unschedulable: slotPref.unschedulable,
          unschedulable_reason: slotPref.unschedulable_reason ?? slotPref.unschedulable.reason ?? null,
          ...(slotPref.unschedulable_detail || slotPref.unschedulable.detail
            ? { unschedulable_detail: slotPref.unschedulable_detail ?? slotPref.unschedulable.detail }
            : {}),
          ...(slotPref.unschedulable_at || slotPref.unschedulable.at
            ? { unschedulable_at: slotPref.unschedulable_at ?? slotPref.unschedulable.at }
            : {}),
        }
      : {}),
    ...(restriction ? { restriction } : {}),
    ...(circuit ? { circuit } : {}),
    ...(value.oauth_imported === true && value.auth_method === 'oauth' ? { oauth_imported: true } : {}),
    kernel_version: text(value.kernel_version),
    runtime_ready: value.runtime_ready === true,
    ...(parseConcurrency(value.max_concurrency) != null
      ? { max_concurrency: parseConcurrency(value.max_concurrency) }
      : {}),
    ...(Number.isSafeInteger(value.active_slots) && value.active_slots >= 0
      ? { active_slots: value.active_slots }
      : {}),
    ...(resolvedInflight != null ? { inflight: resolvedInflight } : {}),
    models: items(value.models, 128, modelName),
    ...(value.models_discovered === true && { models_discovered: true }),
    ...(Array.isArray(value.capabilities)
      ? {
          capabilities: items(value.capabilities, 32, (c) =>
            typeof c === 'string' && /^[a-z0-9_]{1,40}$/.test(c) ? c : null,
          ),
        }
      : {}),
    account: accountView(value.account),
    ...(Object.hasOwn(value, 'last_inference') && {
      last_inference: matchesProxy ? lastInferenceView(value.last_inference) : null,
    }),
    ...(value.crag_license ? { crag_license: cragLicenseView(value.crag_license) } : {}),
    ...(usage ? { usage } : {}),
    created_at: text(value.created_at),
    updated_at: text(value.updated_at),
    billing_ready: billingReady === true,
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

function isAllowedProxyHost(hostname) {
  if (typeof hostname !== 'string' || !hostname || hostname.length > 253) return false
  const family = isIP(hostname)
  if (family === 4) {
    return !/^(?:127\.|169\.254\.|22[4-9]\.|23[0-9]\.|0\.0\.0\.0$|255\.255\.255\.255$)/.test(hostname)
  }
  if (family === 6) return false
  const lower = hostname.toLowerCase()
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.localdomain') ||
    lower.endsWith('.') ||
    lower.includes('..')
  ) {
    return false
  }
  const labels = lower.split('.')
  if (/^\d+$/.test(labels[labels.length - 1])) return false
  return labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
}

function proxyRecordFor(proxyPool, proxyId, ownerUserId = null) {
  if (!validId(proxyId)) return null
  const targetOwner = normalizeOwnerId(ownerUserId)
  const scopedList = proxyPool?.snapshot({ ownerUserId: targetOwner || null })?.proxies || []
  let proxy = scopedList.find((entry) => entry.id === proxyId)
  if (!proxy && targetOwner) {
    // Tenant-owned Gemini environments may use either their own proxy or a platform proxy, never another tenant's proxy.
    const platformList = proxyPool?.snapshot({ ownerUserId: null })?.proxies || []
    proxy = platformList.find((entry) => entry.id === proxyId)
  }
  return proxy || null
}

function proxyEgressOptionsFor(proxyPool, proxyId, { ownerUserId = null } = {}) {
  if (!proxyPool || !validId(proxyId)) return null
  const proxy = proxyRecordFor(proxyPool, proxyId, ownerUserId)
  const withAuth = proxyPool.getProxyByIdWithAuth?.(proxyId) || null
  const opts = {}
  if (proxy?.domain_forward === true || withAuth?.domain_forward === true) {
    opts.domain_forward = true
  }
  const emptyTypes = proxyDnsEmptyTypes(
    withAuth?.dns_disable_svcb_https !== undefined ? withAuth : proxy,
  )
  if (emptyTypes.length) {
    opts.dns_empty_types = emptyTypes
  }
  const dnsUpstream = configuredDnsUpstream()
  if (dnsUpstream) {
    opts.dns_upstream = dnsUpstream
  }
  return Object.keys(opts).length ? opts : null
}

function proxyFor(proxyPool, proxyId, { allowUnhealthy = false, forBinding = false, ownerUserId = null } = {}) {
  if (!validId(proxyId)) throw hostError('gemini_proxy_unavailable', 409)
  const targetOwner = normalizeOwnerId(ownerUserId)
  const proxy = proxyRecordFor(proxyPool, proxyId, targetOwner)
  const pOwner = normalizeOwnerId(proxy?.owner_user_id)
  const ownerAllowed = targetOwner ? !pOwner || pOwner === targetOwner : !pOwner
  if (
    !proxy?.enabled ||
    // Pool policy keeps enabled rows on `fail` until consecutive_failures reaches
    // max_failures; Gemini scheduling should mirror that, not treat one timeout
    // as unavailable while the row is still admitted for inference.
    (!allowUnhealthy && proxy.status === 'dead') ||
    // New binds mirror allocateForVm: a probe `fail` row is not offered for selection.
    (forBinding && proxy.status === 'fail') ||
    !ownerAllowed ||
    proxy.blocked_reason
  ) {
    throw hostError('gemini_proxy_unavailable', 409)
  }
  try {
    const url = new URL(proxyPool.getProxyByIdWithAuth(proxyId)?.url)
    const isSocks = url.protocol === 'socks5:' || url.protocol === 'socks5h:'
    const isHttp = url.protocol === 'http:'
    const port = url.port || (isHttp ? '80' : '')
    if (
      (isSocks || isHttp) &&
      isAllowedProxyHost(url.hostname) &&
      port &&
      (!url.pathname || url.pathname === '/') &&
      !url.hash &&
      !url.search
    ) {
      if (isHttp) {
        const auth = url.username || url.password ? `${url.username}${url.password ? `:${url.password}` : ''}@` : ''
        return `http://${auth}${url.hostname}:${port}`
      }
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
  const pool = proxyPool()
  const egressOptions = proxyEgressOptionsFor(pool, environment.proxy_id, options)
  return {
    proxy_id: environment.proxy_id,
    proxy_url: proxyFor(pool, environment.proxy_id, options),
    ...(egressOptions ? { egress_options: egressOptions } : {}),
  }
}

function hostStreamRequest(socketPath, operation, payload, { signal, timeoutMs = 300_000 } = {}) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw hostError('gemini_host_unsupported_platform')
  if (!path.isAbsolute(socketPath || '')) throw hostError('gemini_host_invalid_socket')
  const body = JSON.stringify(payload)
  const deadline = AbortSignal.timeout(timeoutMs)
  const reqSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
        method: 'POST',
        path: `/${operation}`,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        signal: reqSignal,
      },
      resolve,
    )
    request.once('error', (error) => {
      if (signal?.aborted) return reject(error)
      if (deadline.aborted) return reject(hostError('gemini_inference_timeout', 504))
      reject(hostError(SOCKET_ERRORS.get(error.code) || FAILURE))
    })
    request.end(body)
  })
}

export const callGeminiHost = (operation, payload) =>
  hostRequest(process.env.KIN_GEMINI_HOST_SOCKET ?? '/run/vm2api-gemini/control.sock', operation, payload)

export const callGeminiHostStream = (operation, payload, options) =>
  hostStreamRequest(
    process.env.KIN_GEMINI_HOST_SOCKET ?? '/run/vm2api-gemini/control.sock',
    operation,
    payload,
    options,
  )

/**
 * Proactively warm resident CRAGGemini kernels (`craggemini` + `agy` min_warm_slots=1)
 * for all authorized, licensed OAuth environments so inference starts hot and recovers
 * automatically after control-plane or gemini-host restarts.
 */
export async function warmGeminiEnvironments({ callHost = callGeminiHost, proxyPool, environmentIds = null } = {}) {
  const report = { warmed: 0, warming: 0, skipped: 0 }
  let view
  try {
    view = await callHost('list', {})
  } catch {
    return report
  }
  if (!Array.isArray(view?.environments) || view.payload_state !== 'installed' || view.oauth_runtime_issue) {
    return report
  }
  const cragMode = view.payload_mode === 'crag_subscription'
  const filter = Array.isArray(environmentIds) && environmentIds.length ? new Set(environmentIds) : null
  const pool = typeof proxyPool === 'function' ? proxyPool() : proxyPool
  if (!pool) return report
  for (const env of view.environments) {
    if (
      !env ||
      typeof env.id !== 'string' ||
      !ID.test(env.id) ||
      (filter && !filter.has(env.id)) ||
      env.auth_method === 'api_key' ||
      env.oauth_imported === true ||
      env.auth_state !== 'authorized' ||
      (cragMode && env.crag_license?.valid !== true)
    ) {
      report.skipped += 1
      continue
    }
    const hasBlockingEligibility = Boolean(
      env.account?.eligibility && ACCOUNT_ELIGIBILITIES.has(env.account.eligibility),
    )
    if (env.runtime_ready === true && env.models_discovered === true && !hasBlockingEligibility) {
      report.warmed += 1
      continue
    }
    let proxyUrl
    try {
      proxyUrl = proxyFor(pool, env.proxy_id)
    } catch {
      report.skipped += 1
      continue
    }
    const proxySha256 = crypto.createHash('sha256').update(proxyUrl).digest('hex')
    const egressOptions = proxyEgressOptionsFor(pool, env.proxy_id)
    try {
      const res = await callHost('warm', {
        id: env.id,
        proxy_id: env.proxy_id,
        proxy_url: proxyUrl,
        proxy_sha256: proxySha256,
        ...(egressOptions ? { egress_options: egressOptions } : {}),
      })
      if (res?.runtime_ready === true || res?.warmed === true) report.warmed += 1
      else if (res?.warming === true) report.warming += 1
      else report.skipped += 1
    } catch {
      report.skipped += 1
    }
  }
  return report
}

const AUTO_RECOVERABLE_UNSCHEDULABLE_REASONS = new Set([
  'reauth_required',
  'verification_required',
  'location_unsupported',
  'ineligible',
])

const BLOCKING_CHECK_ELIGIBILITIES = new Set(['verification_required', 'location_unsupported', 'ineligible'])

/**
 * Sync persisted four-state `unschedulable` and quota cooldowns from a refreshed Gemini
 * environment snapshot (used by both periodic status checks and manual operator refresh).
 */
export function reconcileGeminiAccountCheck(
  envId,
  refreshed,
  { slotPrefs = null, geminiScheduler = null, manual = false } = {},
) {
  if (!envId || !refreshed || typeof refreshed !== 'object') return { changed: false }
  const account = refreshed.account && typeof refreshed.account === 'object' ? refreshed.account : null
  const authState = refreshed.auth_state
  const eligibility = account?.eligibility || null
  const prevUnsched = slotPrefs?.resolved?.(envId)?.unschedulable ?? null
  let changed = false

  if (authState === 'reauth_required' || account?.state === 'reauth_required') {
    if (slotPrefs?.markUnschedulable) {
      slotPrefs.markUnschedulable(
        envId,
        'reauth_required',
        account?.error_message || 'Google OAuth 凭证已失效，需重新授权',
        {
          error_code: account?.error_code || 'gemini_oauth_required',
          upstream_status: account?.http_status ?? 401,
        },
      )
      changed = true
    }
  } else if (eligibility && BLOCKING_CHECK_ELIGIBILITIES.has(eligibility)) {
    if (slotPrefs?.markUnschedulable) {
      slotPrefs.markUnschedulable(envId, eligibility, account?.error_message || '', {
        ...(account?.error_code ? { error_code: account.error_code } : {}),
        ...(Number.isSafeInteger(account?.http_status) ? { upstream_status: account.http_status } : {}),
      })
      changed = true
    }
  } else if (authState === 'authorized' && (account?.state === 'ok' || account?.state === 'partial')) {
    if (
      prevUnsched &&
      (manual || AUTO_RECOVERABLE_UNSCHEDULABLE_REASONS.has(prevUnsched.reason)) &&
      slotPrefs?.clearUnschedulable
    ) {
      slotPrefs.clearUnschedulable(envId)
      changed = true
    }
    if (geminiScheduler?.syncAccountQuotaState && account) {
      const rep = geminiScheduler.syncAccountQuotaState(envId, account)
      if ((rep?.clearedModels || 0) > 0 || (rep?.clearedGroups || 0) > 0) changed = true
    }
  }
  if (changed) geminiScheduler?.invalidateCatalogCache?.()
  return { changed }
}

/**
 * Periodic Gemini account status & quota checker (modeled after Codex periodic probe +
 * Antigravity2API Pool.Replenish). Scans authorized / reauth / error environments whose
 * `account.checked_at` exceeds `gemini.pool.account_check_interval_secs`.
 */
export async function checkGeminiAccounts({
  callHost = callGeminiHost,
  proxyPool,
  slotPrefs = null,
  geminiScheduler = null,
  geminiOwnersRepo = null,
  getRoutingConfig = null,
  now = () => Date.now(),
  force = false,
} = {}) {
  const report = { checked: 0, ok: 0, errors: 0, skipped: 0 }
  const routing = typeof getRoutingConfig === 'function' ? getRoutingConfig()?.gemini : null
  const intervalSecs =
    routing?.pool && Number.isInteger(routing.pool.account_check_interval_secs)
      ? routing.pool.account_check_interval_secs
      : 300
  if (!force && intervalSecs === 0) return report
  const intervalMs = Math.max(60, intervalSecs) * 1000
  let view
  try {
    view = await callHost('list', {})
  } catch {
    return report
  }
  if (!Array.isArray(view?.environments) || view.payload_state !== 'installed') return report
  const pool = typeof proxyPool === 'function' ? proxyPool() : proxyPool
  if (!pool) return report
  const ts = now()
  let anyChanged = false
  for (const env of view.environments) {
    if (
      !env ||
      typeof env.id !== 'string' ||
      !ID.test(env.id) ||
      env.oauth_imported === true ||
      !['authorized', 'reauth_required'].includes(env.auth_state)
    ) {
      report.skipped += 1
      continue
    }
    const checkedAtMs = env.account?.checked_at ? Date.parse(env.account.checked_at) : NaN
    if (!force && Number.isFinite(checkedAtMs) && ts - checkedAtMs < intervalMs) {
      report.skipped += 1
      continue
    }
    const ownerUserId = geminiOwnersRepo?.getOwner ? normalizeOwnerId(geminiOwnersRepo.getOwner(env.id)) : null
    let proxyUrl
    try {
      proxyUrl = proxyFor(pool, env.proxy_id, { ownerUserId })
    } catch {
      report.skipped += 1
      continue
    }
    try {
      const egressOptions = proxyEgressOptionsFor(pool, env.proxy_id, { ownerUserId })
      const refreshed = await callHost('refresh', {
        id: env.id,
        proxy_id: env.proxy_id,
        proxy_url: proxyUrl,
        ...(egressOptions ? { egress_options: egressOptions } : {}),
      })
      report.checked += 1
      const { changed } = reconcileGeminiAccountCheck(env.id, refreshed, {
        slotPrefs,
        geminiScheduler,
        manual: false,
      })
      if (changed) anyChanged = true
      if (refreshed?.account?.state === 'ok' && refreshed?.auth_state === 'authorized') {
        report.ok += 1
      } else {
        report.errors += 1
      }
    } catch {
      report.errors += 1
    }
  }
  if (anyChanged) geminiScheduler?.invalidateCatalogCache?.()
  return report
}

export function createGeminiTerminal({ proxyPool, callHost = callGeminiHost }) {
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
      const pool = proxyPool()
      const egressOptions = proxyEgressOptionsFor(pool, environment.proxy_id)
      return {
        proxy_id: environment.proxy_id,
        proxy_url: proxyFor(pool, environment.proxy_id),
        ...(egressOptions ? { egress_options: egressOptions } : {}),
      }
    },
    errorMessage(code, stage) {
      if (code === 'gemini_proxy_unavailable') return '需要绑定可用的 SOCKS5 / HTTP 代理'
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

export function createGeminiPanelHandler({
  json,
  readBody,
  proxyPool,
  poolScheduler = null,
  terminal,
  cragSubscription = null,
  geminiOwnersRepo = null,
  geminiSlotPrefs = null,
  geminiScheduler = null,
  panelUsers = null,
  requestLog = null,
  callHost = callGeminiHost,
  billingReady = Boolean(requestLog),
}) {
  const maintenance = createGeminiMaintenanceHandler({ json, readBody })
  const slotPrefs = geminiSlotPrefs || createGeminiSlotPrefs()
  const envOwnerOf = (envId) => geminiOwnersRepo?.getOwner?.(envId) ?? null
  const resolvePoolScheduler = () => (typeof poolScheduler === 'function' ? poolScheduler() : poolScheduler)
  const liveInflightOf = (envId) => {
    const n = resolvePoolScheduler()?.inflight?.get?.(`gemini:${envId}`)
    return Number.isSafeInteger(n) && n >= 0 ? n : null
  }
  const restrictionFor = (envId) => {
    if (!envId) return { restriction: null, circuit: null }
    if (geminiScheduler?.environmentRestriction) {
      return geminiScheduler.environmentRestriction(envId)
    }
    const rawCircuit = resolvePoolScheduler()?.unitCircuit?.view?.(`gemini:${envId}`) || null
    const circuit = rawCircuit && rawCircuit.state !== 'closed' ? rawCircuit : null
    if (!circuit) return { restriction: null, circuit: null }
    return {
      circuit,
      restriction:
        circuit.state === 'open'
          ? { reason: 'circuit_open', text: '熔断中', until: circuit.open_until ?? null }
          : { reason: 'circuit_probe', text: '熔断探测', until: null },
    }
  }
  const toEnvView = (value, opts = {}) => {
    const runtimeState = restrictionFor(value?.id)
    return environmentView(value, {
      proxyPool,
      billingReady,
      ownerUserId: Object.hasOwn(opts, 'ownerUserId') ? opts.ownerUserId : envOwnerOf(value?.id),
      inflight: Object.hasOwn(opts, 'inflight') ? opts.inflight : liveInflightOf(value?.id),
      slotPref: slotPrefs.resolved(value?.id),
      restriction: runtimeState.restriction,
      circuit: runtimeState.circuit,
      ...opts,
    })
  }
  return async function handleGeminiPanel(req, res, pathname) {
    const ok = (data) => json(res, 200, { ok: true, data })
    const fail = (status, code, message = code, extra = null) =>
      json(res, status, { ok: false, error: { code, message, ...(extra || {}) } })
    res.setHeader('Cache-Control', 'no-store')
    if (pathname === `${PANEL_PATH}/maintenance` || pathname.startsWith(`${PANEL_PATH}/maintenance/`)) {
      return maintenance(req, res, pathname)
    }
    try {
      if (req.method === 'GET' && pathname === `${PANEL_PATH}/daemon-status`) {
        try {
          const data = await callHost('daemon-status', {})
          return ok({ available: true, ...(data && typeof data === 'object' ? data : {}) })
        } catch (error) {
          const code = Object.hasOwn(HOST_ERRORS, error?.code) ? error.code : FAILURE
          return ok({
            available: false,
            host_error: code,
            host_message: HOST_ERRORS[code]?.[1] || '未检测到可用的 Gemini 宿主机服务',
            shards: [],
          })
        }
      }
      if (req.method === 'POST' && pathname === `${PANEL_PATH}/daemon-action`) {
        const body = await readBody(req, 4096)
        const action = typeof body?.action === 'string' ? body.action.trim() : ''
        if (!['restart_shard', 'rebalance', 'account_lifecycle'].includes(action)) {
          return fail(400, 'invalid_request', '不支持的守护进程管理操作')
        }
        const data = await callHost('daemon-action', body)
        return ok(data)
      }
      if (req.method === 'GET' && pathname === `${PANEL_PATH}/crag-subscription`) {
        if (!cragSubscription) return fail(503, 'license_unconfigured', GEMINI_LICENSE_MESSAGES.license_unconfigured)
        const reqUrl = new URL(req.url || pathname, 'http://127.0.0.1')
        const syncParam = reqUrl.searchParams.get('sync')
        const sync = syncParam === '1' || syncParam === 'true'
        return ok(await cragSubscription.status({ sync }))
      }
      if (req.method === 'POST' && pathname === `${PANEL_PATH}/crag-subscription/sync`) {
        if (!cragSubscription) return fail(503, 'license_unconfigured', GEMINI_LICENSE_MESSAGES.license_unconfigured)
        if (cragSubscription.hasSyncPending?.()) {
          const recovered = await cragSubscription.recover()
          return ok(recovered?.status || (await cragSubscription.status()))
        }
        return ok(await cragSubscription.status({ sync: true }))
      }
      if (req.method === 'POST' && pathname === `${PANEL_PATH}/crag-subscription/redeem`) {
        if (!cragSubscription) return fail(503, 'license_unconfigured', GEMINI_LICENSE_MESSAGES.license_unconfigured)
        const body = await readBody(req, 2048)
        const out = await cragSubscription.redeem(body?.redemption_code)
        geminiScheduler?.invalidateCatalogCache?.()
        return ok(out)
      }
      if (req.method === 'POST' && pathname === `${PANEL_PATH}/crag-subscription/upgrade`) {
        if (!cragSubscription) return fail(503, 'license_unconfigured', GEMINI_LICENSE_MESSAGES.license_unconfigured)
        const out = await cragSubscription.upgrade()
        geminiScheduler?.invalidateCatalogCache?.()
        return ok(out)
      }
      if (req.method === 'GET' && pathname === PANEL_PATH) {
        if (cragSubscription?.hasSyncPending?.()) {
          await cragSubscription.recover().catch(() => null)
        }
        let view = await callHost('list', {})
        if (!Array.isArray(view?.environments)) throw hostError(PROTOCOL_ERROR)
        if (cragSubscription?.reconcileEnvironmentSeats && view.payload_mode === 'crag_subscription') {
          const reconciled = await cragSubscription
            .reconcileEnvironmentSeats(view.environments, { payloadMode: view.payload_mode })
            .catch(() => ({ boundIds: [] }))
          if (reconciled.boundIds?.length) {
            view = await callHost('list', {})
            if (!Array.isArray(view?.environments)) throw hostError(PROTOCOL_ERROR)
          }
        }
        const subscription = cragSubscription ? await cragSubscription.status().catch(() => null) : null
        const reqUrl = new URL(req.url || PANEL_PATH, 'http://127.0.0.1')
        const filterOwnerRaw = reqUrl.searchParams.get('owner_user_id')
        const filterOwner = filterOwnerRaw != null && filterOwnerRaw !== '' ? normalizeOwnerId(filterOwnerRaw) : null
        const visibleEnvs = filterOwner
          ? view.environments.filter((env) => envOwnerOf(env.id) === filterOwner)
          : view.environments
        const billingByEnvId = indexGeminiBillingAccounts(requestLog)
        return ok({
          available: true,
          payload_state: PAYLOAD_STATES.has(view.payload_state) ? view.payload_state : 'unknown',
          ...(view.payload_mode === 'crag_subscription' ? { payload_mode: 'crag_subscription' } : {}),
          payload_issue: PAYLOAD_ISSUES.has(view.payload_issue) ? view.payload_issue : null,
          release_activated: typeof view.release_activated === 'boolean' ? view.release_activated : null,
          oauth_runtime_issue: OAUTH_ISSUES.has(view.oauth_runtime_issue) ? view.oauth_runtime_issue : null,
          ...(subscription ? { crag_subscription: subscription } : {}),
          environments: visibleEnvs.map((value) =>
            toEnvView(value, {
              withProxyReady: true,
              usage: geminiUsageView(billingByEnvId.get(value?.id)),
            }),
          ),
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
        geminiScheduler?.invalidateCatalogCache?.()
        return ok({ kernel_version: result.kernel_version })
      }
      if (req.method === 'POST' && pathname === `${PANEL_PATH}/environments`) {
        const body = await readBody(req, 64 * 1024)
        const name = typeof body?.name === 'string' ? body.name.trim() : ''
        const method = body?.auth_method ?? 'oauth'
        if (!name || name.length > 80 || !validId(body?.proxy_id) || !['oauth', 'api_key'].includes(method)) {
          return fail(400, 'gemini_invalid_environment')
        }
        const apiKey = typeof body?.api_key === 'string' ? body.api_key.trim() : ''
        if ((method === 'api_key' && !API_KEY.test(apiKey)) || (method === 'oauth' && body?.api_key != null)) {
          return fail(400, 'gemini_invalid_api_key', '请提供有效格式的 Gemini API Key')
        }
        const hasConcurrency = body?.max_concurrency !== undefined
        const maxConcurrency = hasConcurrency ? parseConcurrency(body.max_concurrency) : null
        if (hasConcurrency && maxConcurrency == null) {
          return fail(400, 'gemini_invalid_concurrency', HOST_ERRORS.gemini_invalid_concurrency[1])
        }
        const imported = body?.oauth_account
        const normalizedImport = imported != null ? normalizeGeminiOAuthImport(imported) : null
        if (imported != null && (method !== 'oauth' || !normalizedImport)) {
          return fail(400, 'gemini_oauth_import_invalid', HOST_ERRORS.gemini_oauth_import_invalid[1])
        }
        const ownerUserId = normalizeOwnerId(body?.owner_user_id)
        const pool = proxyPool()
        const proxyUrl = proxyFor(pool, body.proxy_id, { ownerUserId, forBinding: true })
        const egressOptions = proxyEgressOptionsFor(pool, body.proxy_id, { ownerUserId })
        let created = await callHost('create', {
          name,
          proxy_id: body.proxy_id,
          proxy_url: proxyUrl,
          ...(egressOptions ? { egress_options: egressOptions } : {}),
          ...(maxConcurrency != null ? { max_concurrency: maxConcurrency } : {}),
          ...(method === 'api_key' ? { auth_method: method, api_key: apiKey } : {}),
          ...(normalizedImport != null && {
            oauth_account: {
              ...(normalizedImport.refresh_token ? { refresh_token: normalizedImport.refresh_token } : {}),
              ...(normalizedImport.access_token ? { access_token: normalizedImport.access_token } : {}),
              ...(normalizedImport.expiry_timestamp != null
                ? { expiry_timestamp: normalizedImport.expiry_timestamp }
                : {}),
              ...(normalizedImport.auth_method ? { auth_method: normalizedImport.auth_method } : {}),
              ...(normalizedImport.wif_provider ? { wif_provider: normalizedImport.wif_provider } : {}),
            },
          }),
        })
        if (ownerUserId && geminiOwnersRepo?.setOwner) {
          geminiOwnersRepo.setOwner(created.id, ownerUserId)
        }
        if (method === 'oauth' && cragSubscription?.ensureEnvironmentSeat) {
          const seat = await cragSubscription
            .ensureEnvironmentSeat(created.id, { env: created })
            .catch(() => ({ bound: false }))
          if (seat.bound) {
            created = await callHost('get', { id: created.id })
          }
        }
        geminiScheduler?.invalidateCatalogCache?.()
        return ok(toEnvView(created, { ownerUserId }))
      }
      const match =
        /^\/api\/panel\/gemini\/environments\/([A-Za-z0-9_-]{1,64})(?:\/(authorization|concurrency|disable|refresh|schedulable|prefs|recover|owner|terminal-ticket|proxy\/probe|proxy|models|test-chat|health|stats|crag-license(?:\/(?:bind|activate|release))?)(?:\/([^/]+))?)?$/.exec(
          pathname,
        )
      if (!match || !validId(match[1])) return fail(404, 'not_found')
      const [, id, action, runId] = match
      if (action === 'schedulable') {
        if (runId !== undefined || req.method !== 'POST') return fail(404, 'not_found')
        const body = await readBody(req, 1024)
        if (typeof body?.schedulable !== 'boolean') {
          return fail(400, 'invalid_request', 'schedulable 必须为布尔值')
        }
        const saved = slotPrefs.patch(id, { schedulable: body.schedulable })
        return ok({ id, ...saved })
      }
      if (action === 'prefs') {
        if (runId !== undefined || req.method !== 'PATCH') return fail(404, 'not_found')
        const body = await readBody(req, 4096)
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return fail(400, 'invalid_request', '无效的配置请求')
        }
        const prefPatch = {}
        if (Object.hasOwn(body, 'name')) {
          const parsedName = parseGeminiDisplayName(body.name)
          if (!parsedName.ok) return fail(400, 'gemini_invalid_name', '环境名称长度不能超过 80 个字符')
          prefPatch.display_name = parsedName.value
        }
        if (Object.hasOwn(body, 'schedule_level')) {
          const parsedLevel = parseGeminiScheduleLevel(body.schedule_level)
          if (!parsedLevel.ok) {
            return fail(400, 'gemini_invalid_schedule_level', '调度优先级必须为 1–10 的整数或自动')
          }
          prefPatch.schedule_level = parsedLevel.value
        }
        if (Object.hasOwn(body, 'schedulable')) {
          if (typeof body.schedulable !== 'boolean') {
            return fail(400, 'invalid_request', 'schedulable 必须为布尔值')
          }
          prefPatch.schedulable = body.schedulable
        }
        let maxConcurrency = null
        if (Object.hasOwn(body, 'max_concurrency') && body.max_concurrency !== undefined) {
          maxConcurrency = parseConcurrency(body.max_concurrency)
          if (maxConcurrency == null) {
            return fail(400, 'gemini_invalid_concurrency', HOST_ERRORS.gemini_invalid_concurrency[1])
          }
        }
        let hostEnv = null
        if (maxConcurrency != null) {
          hostEnv = await callHost('concurrency-set', { id, max_concurrency: maxConcurrency })
        }
        if (Object.keys(prefPatch).length > 0) {
          slotPrefs.patch(id, prefPatch)
        }
        if (!hostEnv) {
          hostEnv = await callHost('get', { id })
        }
        return ok(toEnvView(hostEnv, { id }))
      }
      if (action === 'recover') {
        if (runId !== undefined || req.method !== 'POST') return fail(404, 'not_found')
        slotPrefs.clearUnschedulable(id)
        geminiScheduler?.clearRestriction?.(id)
        resolvePoolScheduler()?.unitCircuit?.reset?.(`gemini:${id}`)
        return ok({ id, cleared: true })
      }
      if (action === 'owner') {
        if (runId !== undefined || req.method !== 'PATCH') return fail(404, 'not_found')
        const body = await readBody(req, 4096)
        const raw = Object.hasOwn(body || {}, 'user_id') ? body.user_id : body?.owner_user_id
        const nextOwner = raw === null || raw === '' || raw === undefined ? null : normalizeOwnerId(raw)
        if (raw != null && raw !== '' && !nextOwner) {
          return fail(400, 'invalid_request', '无效的租户用户 ID')
        }
        if (nextOwner && panelUsers?.getById && !panelUsers.getById(nextOwner)) {
          return fail(404, 'user_not_found', 'user not found')
        }
        if (nextOwner) geminiOwnersRepo?.setOwner?.(id, nextOwner)
        else geminiOwnersRepo?.remove?.(id)
        return ok({ id, owner_user_id: nextOwner })
      }
      if (action === 'health') {
        if (runId !== undefined || req.method !== 'GET') return fail(404, 'not_found')
        if (!requestLog?.healthBuckets) return fail(503, 'request_log_unavailable', 'request log unavailable')
        const reqUrl = new URL(req.url || pathname, 'http://127.0.0.1')
        const range = reqUrl.searchParams.get('range') === '7d' ? '7d' : '24h'
        const shape = range === '7d' ? { slots: 84, slotMin: 120 } : { slots: 48, slotMin: 30 }
        const vmId = `gemini:${id}`
        const now = Date.now()
        const start = new Date(now - shape.slots * shape.slotMin * 60_000).toISOString()
        const buckets = requestLog.healthBuckets({ now, vmId, ...shape }).get(vmId) || null
        return ok({
          range,
          slot_min: shape.slotMin,
          start,
          buckets,
          top_errors: requestLog.topErrors?.({ vmId, since: start }) || [],
        })
      }
      if (action === 'stats') {
        if (runId !== undefined || req.method !== 'GET') return fail(404, 'not_found')
        if (!requestLog) return fail(503, 'request_log_unavailable', 'request log unavailable')
        const vmId = `gemini:${id}`
        const cost = indexGeminiBillingAccounts(requestLog).get(id) || null
        let byModel = []
        let usageStats = null
        try {
          byModel = requestLog.costByModel?.({ vmId, accountId: id }) || []
        } catch {}
        try {
          usageStats = requestLog.vmUsageStats?.({ vmId, days: 30 }) || null
        } catch {}
        return ok({
          billing: {
            by_model: byModel,
            usage_stats: usageStats,
            window_5h: geminiPeriodView(cost?.window_5h),
            window_7d: geminiPeriodView(cost?.window_7d),
            prev_window_5h: null,
            prev_window_7d: null,
            window_5h_projection: null,
          },
        })
      }
      if (action?.startsWith('crag-license')) {
        if (runId !== undefined) return fail(404, 'not_found')
        if (!cragSubscription) return fail(503, 'license_unconfigured', GEMINI_LICENSE_MESSAGES.license_unconfigured)
        if (req.method === 'GET' && action === 'crag-license') {
          return ok(await cragSubscription.environmentStatus(id))
        }
        if (req.method === 'POST' && action === 'crag-license/bind') {
          const out = await cragSubscription.bindEnvironment(id)
          geminiScheduler?.invalidateCatalogCache?.()
          return ok(out)
        }
        if (req.method === 'POST' && action === 'crag-license/activate') {
          const body = await readBody(req, 16384)
          const out = await cragSubscription.activateEnvironment(id, body?.code)
          geminiScheduler?.invalidateCatalogCache?.()
          return ok(out)
        }
        if (req.method === 'POST' && action === 'crag-license/release') {
          const out = await cragSubscription.releaseEnvironment(id)
          geminiScheduler?.invalidateCatalogCache?.()
          return ok(out)
        }
        return fail(404, 'not_found')
      }
      if (runId !== undefined) {
        if (action !== 'test-chat' || !['GET', 'DELETE'].includes(req.method)) return fail(404, 'not_found')
        if (!validRunId(runId)) return fail(400, 'gemini_invalid_run_id')
        const payload = { id, run_id: runId }
        if (req.method === 'GET') return ok(runView(await callHost('test-chat-status', payload)))
        const result = await callHost('test-chat-cancel', payload)
        if (result?.cancelled !== true) throw hostError(PROTOCOL_ERROR)
        return ok({ cancelled: true })
      }
      if (req.method === 'PUT' && action === 'concurrency') {
        const body = await readBody(req, 1024)
        const maxConcurrency = parseConcurrency(body?.max_concurrency)
        if (maxConcurrency == null) {
          return fail(400, 'gemini_invalid_concurrency', HOST_ERRORS.gemini_invalid_concurrency[1])
        }
        const result = await callHost('concurrency-set', { id, max_concurrency: maxConcurrency })
        geminiScheduler?.invalidateCatalogCache?.()
        return ok(toEnvView(result, { id }))
      }
      if (req.method === 'PUT' && action === 'proxy') {
        const body = await readBody(req, 4096)
        const proxyId = body?.proxy_id
        if (!validId(proxyId)) return fail(400, 'gemini_invalid_proxy_id')
        const environment = await readEnvironment(callHost, id)
        const envOwner = envOwnerOf(id)
        const result = await callHost('proxy-bind', {
          id,
          previous_proxy_id: environment.proxy_id,
          proxy_id: proxyId,
          proxy_url: proxyFor(proxyPool(), proxyId, { ownerUserId: envOwner, forBinding: true }),
        })
        slotPrefs.clearUnschedulable(id)
        geminiScheduler?.invalidateCatalogCache?.()
        return ok(toEnvView(result, { id, proxyId, ownerUserId: envOwner }))
      }
      if (req.method === 'POST' && action === 'proxy/probe') {
        const environment = await readEnvironment(callHost, id)
        // Only probing the existing binding may bypass stored health. Scope,
        // enablement, policy, and valid IPv4 SOCKS5 still apply.
        const target = boundProxy(proxyPool, environment, { allowUnhealthy: true, ownerUserId: envOwnerOf(id) })
        return ok(probeView(await callHost('proxy-probe', { id, ...target })))
      }
      if (req.method === 'POST' && action === 'models') {
        const environment = await readEnvironment(callHost, id)
        let result = await callHost('models', {
          id,
          ...boundProxy(proxyPool, environment, { ownerUserId: envOwnerOf(id) }),
        })
        if (environment.auth_method === 'oauth' && cragSubscription?.ensureEnvironmentSeat) {
          const seat = await cragSubscription.ensureEnvironmentSeat(id, { env: result }).catch(() => ({ bound: false }))
          if (seat.bound) {
            result = await callHost('get', { id })
          }
        }
        const view = toEnvView(result, { id, proxyId: environment.proxy_id })
        geminiScheduler?.invalidateCatalogCache?.()
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
        const result = await callHost('test-chat', {
          id,
          ...boundProxy(proxyPool, environment, { ownerUserId: envOwnerOf(id) }),
          model,
          prompt,
        })
        if (!validRunId(result?.run_id)) throw hostError(PROTOCOL_ERROR)
        return ok({ run_id: result.run_id })
      }
      if (req.method === 'POST' && action === 'terminal-ticket') {
        if (!terminal) throw hostError('gemini_terminal_unavailable')
        return ok(await terminal.issueTicket(id))
      }
      if (req.method === 'DELETE' && !action) {
        let seatRelease = null
        if (cragSubscription) {
          seatRelease = await cragSubscription.releaseEnvironment(id, { ignoreMissing: true })
        }
        await callHost('delete', { id })
        geminiOwnersRepo?.remove?.(id)
        slotPrefs.remove(id)
        geminiScheduler?.clearRestriction?.(id)
        geminiScheduler?.invalidateCatalogCache?.()
        return ok({ deleted: true, ...(seatRelease ? { seat_released: seatRelease.released === true } : {}) })
      }
      if (req.method === 'POST' && action === 'disable') {
        await callHost('disable', { id })
        geminiScheduler?.invalidateCatalogCache?.()
        return ok({ disabled: true })
      }
      if (req.method === 'POST' && action === 'refresh') {
        const environment = environmentView(await callHost('get', { id }))
        const pool = proxyPool()
        const ownerUserId = envOwnerOf(id)
        const proxyUrl = proxyFor(pool, environment.proxy_id, { ownerUserId })
        const egressOptions = proxyEgressOptionsFor(pool, environment.proxy_id, { ownerUserId })
        let refreshed = await callHost('refresh', {
          id,
          proxy_id: environment.proxy_id,
          proxy_url: proxyUrl,
          ...(egressOptions ? { egress_options: egressOptions } : {}),
        })
        if (environment.auth_method === 'oauth' && cragSubscription?.ensureEnvironmentSeat) {
          const seat = await cragSubscription
            .ensureEnvironmentSeat(id, { env: refreshed })
            .catch(() => ({ bound: false }))
          if (seat.bound) {
            refreshed = await callHost('get', { id })
          }
        }
        reconcileGeminiAccountCheck(id, refreshed, {
          slotPrefs,
          geminiScheduler,
          manual: true,
        })
        geminiScheduler?.invalidateCatalogCache?.()
        return ok(toEnvView(refreshed))
      }
      if (action !== 'authorization') return fail(404, 'not_found')
      if (req.method === 'POST') {
        const environment = environmentView(await callHost('get', { id }))
        const pool = proxyPool()
        const ownerUserId = envOwnerOf(id)
        const proxyUrl = proxyFor(pool, environment.proxy_id, { ownerUserId })
        const proxySha256 = crypto.createHash('sha256').update(proxyUrl).digest('hex')
        const egressOptions = proxyEgressOptionsFor(pool, environment.proxy_id, { ownerUserId })
        const auth = await callHost('authorize', {
          id,
          proxy_id: environment.proxy_id,
          proxy_url: proxyUrl,
          proxy_sha256: proxySha256,
          ...(egressOptions ? { egress_options: egressOptions } : {}),
        })
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
        const pool = proxyPool()
        const ownerUserId = envOwnerOf(id)
        const proxyUrl = proxyFor(pool, environment.proxy_id, { ownerUserId })
        const proxySha256 = crypto.createHash('sha256').update(proxyUrl).digest('hex')
        const egressOptions = proxyEgressOptionsFor(pool, environment.proxy_id, { ownerUserId })
        let completed = await callHost('complete', {
          id,
          proxy_id: environment.proxy_id,
          proxy_url: proxyUrl,
          proxy_sha256: proxySha256,
          ...(egressOptions ? { egress_options: egressOptions } : {}),
          attempt_id: body.attempt_id,
          ...authorization,
        })
        if (cragSubscription?.ensureEnvironmentSeat) {
          const seat = await cragSubscription
            .ensureEnvironmentSeat(id, { env: completed })
            .catch(() => ({ bound: false }))
          if (seat.bound) {
            completed = await callHost('get', { id })
          }
        }
        slotPrefs.clearUnschedulable(id)
        geminiScheduler?.clearRestriction?.(id)
        geminiScheduler?.invalidateCatalogCache?.()
        return ok(toEnvView(completed))
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
        const stage =
          AUTH_STAGE_CODES.has(error.code) &&
          typeof error.stage === 'string' &&
          Object.hasOwn(AUTH_STAGE_MESSAGES, error.stage)
            ? error.stage
            : null
        const resolvedMessage =
          error.code === 'gemini_authorization_unavailable' && stage ? AUTH_STAGE_MESSAGES[stage] : message
        return fail(status, error.code, resolvedMessage, stage ? { stage } : null)
      }
      if (error?.code === 'gemini_proxy_unavailable') return fail(409, error.code, '需要绑定可用的 SOCKS5 / HTTP 代理')
      if (error?.code === 'gemini_environment_not_found') return fail(404, error.code, 'Gemini 环境不存在')
      if (error?.code === 'gemini_environment_conflict')
        return fail(409, error.code, 'Gemini 环境状态已变化，请刷新后重试')
      if (error?.status === 413) return fail(413, 'request_too_large')
      if (error?.status === 400) return fail(400, 'invalid_json')
      return fail(503, FAILURE, '未检测到可用的 Gemini 宿主机服务')
    }
  }
}

function publicError(error) {
  const code = typeof error?.code === 'string' ? error.code : FAILURE
  if (code === FAILURE || HOST_INFRASTRUCTURE_CODES.has(code)) {
    return {
      status: 503,
      body: { error: { type: 'api_error', code: FAILURE, message: 'Gemini host is not available.' } },
    }
  }
  if (code === 'gemini_pool_overloaded' || code === 'gemini_no_account') {
    return {
      status: 429,
      details: error?.details,
      retryAfter: Number.isFinite(error?.retryAfter) && error.retryAfter >= 1 ? error.retryAfter : 5,
      body: {
        error: {
          type: 'rate_limit_error',
          code: 'gemini_pool_overloaded',
          message: error?.message || '号池负载过高，请稍后再试',
        },
      },
    }
  }
  const known = HOST_ERRORS[code]
  const status = Number.isInteger(error?.status) ? error.status : known?.[0] || 503
  const message =
    code === 'gemini_operation_busy' && status === 503
      ? '当前可用 Gemini 账号并发繁忙，请稍后重试'
      : known?.[1] || error?.message || 'Gemini request failed.'
  return {
    status,
    details: error?.details,
    retryAfter: error?.retryAfter,
    body: {
      error: {
        type: status === 429 ? 'rate_limit_error' : status >= 500 ? 'api_error' : 'invalid_request_error',
        code,
        message,
      },
    },
  }
}

function plainParts(parts, { typed = false } = {}) {
  if (!Array.isArray(parts) || parts.length === 0) return null
  const text = []
  for (const part of parts) {
    const allowed = typed ? ['type', 'text'] : ['text']
    if (
      !part ||
      typeof part !== 'object' ||
      Array.isArray(part) ||
      Object.keys(part).some((key) => !allowed.includes(key)) ||
      (typed && part.type !== 'text') ||
      typeof part.text !== 'string'
    )
      return null
    text.push(part.text)
  }
  return text.join('')
}

function userMessage(message, { response = false } = {}) {
  const allowed = response ? ['type', 'role', 'content'] : ['role', 'content']
  if (
    !message ||
    typeof message !== 'object' ||
    Array.isArray(message) ||
    Object.keys(message).some((key) => !allowed.includes(key))
  )
    return null
  if (message.role !== 'user' || (response && message.type != null && message.type !== 'message')) return null
  return typeof message.content === 'string' ? message.content : plainParts(message.content, { typed: true })
}

export function geminiTurnFromBody(body, protocol = 'gemini-session', routeModel = null) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const model = routeModel || (typeof body.model === 'string' ? body.model : '')
  if (!MODEL.test(model) || (body.model != null && body.model !== model)) return null
  let text
  let stream = false
  if (protocol === 'gemini') {
    if (Object.keys(body).some((key) => !['model', 'contents'].includes(key))) return null
    const content = Array.isArray(body.contents) && body.contents.length === 1 ? body.contents[0] : null
    if (
      !content ||
      !['user', undefined].includes(content.role) ||
      Object.keys(content).some((key) => !['role', 'parts'].includes(key))
    )
      return null
    text = plainParts(content.parts)
  } else if (protocol === 'openai-chat' || protocol === 'openai-responses' || protocol === 'anthropic') {
    const response = protocol === 'openai-responses'
    const field = response ? 'input' : 'messages'
    const allowed = response ? ['model', 'input', 'stream'] : ['model', 'messages', 'stream']
    if (Object.keys(body).some((key) => !allowed.includes(key))) return null
    if (body.stream != null && typeof body.stream !== 'boolean') return null
    stream = body.stream === true
    if (response) {
      text =
        typeof body.input === 'string'
          ? body.input
          : Array.isArray(body.input) && body.input.length === 1
            ? userMessage(body.input[0], { response: true })
            : null
    } else {
      const message = Array.isArray(body[field]) && body[field].length === 1 ? body[field][0] : null
      text = userMessage(message)
    }
  } else if (protocol === 'gemini-session') {
    if (Object.keys(body).some((key) => !['model', 'input', 'stream'].includes(key))) return null
    if (body.stream != null && typeof body.stream !== 'boolean') return null
    stream = body.stream === true
    text = body.input
  } else {
    return null
  }
  if (!validPrompt(text)) return null
  return { model, text, stream }
}

/**
 * `/v1/messages` answers in the Anthropic Messages shape so an Anthropic client
 * can read it. Only `input_tokens` / `output_tokens` exist there, so the host's
 * `total_tokens` is dropped rather than returned under a field the clients ignore.
 */
function anthropicMessage(turn) {
  return {
    id: `msg_${crypto.randomBytes(12).toString('hex')}`,
    type: 'message',
    role: 'assistant',
    model: turn.model,
    content: turn.text ? [{ type: 'text', text: turn.text }] : [],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: turn.usage?.input_tokens || 0, output_tokens: turn.usage?.output_tokens || 0 },
  }
}

function anthropicStream(turn) {
  const message = anthropicMessage(turn)
  const events = [
    { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: turn.text } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: turn.usage?.output_tokens || 0 },
    },
    { type: 'message_stop' },
  ]
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
}

function responsesStream(turn) {
  const response = responsesOutput(turn)
  const item = response.output[0]
  const content = item.content[0]
  const events = [
    ['response.created', { response: { ...response, status: 'in_progress', output: [] } }],
    ['response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } }],
    ['response.content_part.added', { output_index: 0, content_index: 0, part: { ...content, text: '' } }],
    ['response.output_text.delta', { output_index: 0, content_index: 0, delta: turn.text }],
    ['response.output_text.done', { output_index: 0, content_index: 0, text: turn.text }],
    ['response.content_part.done', { output_index: 0, content_index: 0, part: content }],
    ['response.output_item.done', { output_index: 0, item }],
    ['response.completed', { response }],
  ]
  return events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
}

function googleUsage(usage = {}) {
  const input = usage.input_tokens || 0
  const output = usage.output_tokens || 0
  return {
    promptTokenCount: input,
    candidatesTokenCount: output,
    totalTokenCount: usage.total_tokens || input + output,
  }
}

function chatCompletion(turn) {
  return {
    id: `chatcmpl_${crypto.randomBytes(12).toString('hex')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: turn.model,
    choices: [{ index: 0, message: { role: 'assistant', content: turn.text }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: turn.usage?.input_tokens || 0,
      completion_tokens: turn.usage?.output_tokens || 0,
      total_tokens: turn.usage?.total_tokens || 0,
    },
  }
}

function responsesOutput(turn) {
  return {
    id: `resp_${crypto.randomBytes(12).toString('hex')}`,
    object: 'response',
    status: 'completed',
    model: turn.model,
    output: [
      {
        id: `msg_${crypto.randomBytes(12).toString('hex')}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: turn.text, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: turn.usage?.input_tokens || 0,
      output_tokens: turn.usage?.output_tokens || 0,
      total_tokens: turn.usage?.total_tokens || 0,
    },
  }
}

function googleOutput(turn) {
  return {
    candidates: [{ content: { role: 'model', parts: [{ text: turn.text }] }, finishReason: 'STOP', index: 0 }],
    usageMetadata: googleUsage(turn.usage),
    modelVersion: turn.response_model || turn.model,
  }
}

function writeStream(res, events) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  for (const event of events) res.write(event)
  res.end()
}

function protocolErrorBody(protocol, status, code, message, details = null) {
  return formatGeminiProtocolError(protocol, status, code, message, details)
}

export function googleModelEntry(model) {
  const id = typeof model === 'string' ? model : String(model?.id || '').trim()
  return {
    name: `models/${id}`,
    baseModelId: id,
    displayName: (typeof model === 'object' && model?.display_name) || id,
    supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
  }
}

export function formatGoogleModelList(models = []) {
  return {
    models: (Array.isArray(models) ? models : [])
      .filter((m) => (typeof m === 'string' ? m : m?.id))
      .map(googleModelEntry),
  }
}

function publicModels(catalog, req) {
  return filterModelCatalogForKey({ object: 'list', data: catalog.models }, req)
}

function googleModelList(catalog, req) {
  return formatGoogleModelList(publicModels(catalog, req).data)
}

function findCatalogModel(models, requestedId) {
  const want = String(requestedId || '')
    .trim()
    .replace(/^models\//i, '')
    .toLowerCase()
  if (!want) return null
  return (Array.isArray(models) ? models : []).find((m) => String(m?.id || '').toLowerCase() === want) || null
}

function beginSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
}

function logProtocolName(protocol) {
  switch (protocol) {
    case 'anthropic':
      return 'anthropic.messages'
    case 'openai-chat':
      return 'openai.chat'
    case 'openai-responses':
      return 'openai.responses'
    case 'gemini':
      return 'google.gemini'
    default:
      return 'google.gemini.session'
  }
}

function extractGeminiSessionId(req, body, sessionPathId = '') {
  const headers = req?.headers || {}
  for (const key of [
    'x-session-id',
    'x-conversation-id',
    'x-claude-code-session-id',
    'x-opencode-session',
    'x-opencode-session-id',
    'session-id',
    'thread-id',
  ]) {
    if (typeof headers[key] === 'string' && headers[key].trim()) return headers[key].trim()
  }
  for (const field of ['conversation_id', 'conversationId', 'session_id', 'thread_id', 'prompt_cache_key']) {
    if (typeof body?.[field] === 'string' && body[field].trim()) return body[field].trim()
  }
  if (typeof body?.metadata?.user_id === 'string' && body.metadata.user_id.trim()) {
    const rawUser = body.metadata.user_id.trim()
    if (rawUser.startsWith('{')) {
      try {
        const parsedUid = JSON.parse(rawUser)
        if (typeof parsedUid?.session_id === 'string' && parsedUid.session_id.trim()) {
          return parsedUid.session_id.trim()
        }
      } catch {}
    }
    const match = /_session_([A-Za-z0-9._-]+)$/.exec(rawUser)
    return match ? match[1] : rawUser
  }
  return typeof sessionPathId === 'string' ? sessionPathId.trim() : ''
}

export function createGeminiPublicHandler({
  json,
  readBody,
  scheduler,
  stickyRouter = null,
  requestLog = null,
  groupsRepo = null,
  apiKeyStore = null,
  getRoutingConfig = null,
  getHealthMonitor = null,
  cfg = null,
  settings = null,
  refusalGuards = null,
  refusalDevices = null,
  refusalSessions = null,
  preDispatch = null,
  poolsRepo = null,
  geminiOwnerMap = null,
}) {
  const geminiScopeFromReq = (req) => {
    const rec = req?.apiKeyRecord || null
    const policy = req.apiKeyKind === 'managed' ? keyTierPolicyFromRecord(rec) : null
    // In production `apiKeyStore.users` resolves whether `user_id` is an admin or tenant.
    // When invoked standalone without a users repo, a `gemini`-group key without an explicit
    // `owner_id` or `tenant` tier defaults to `PLATFORM_SCOPE` (only admins can create `gemini` keys).
    const ownerScope =
      !apiKeyStore?.users && !policy?.owner_id && policy?.permission_tier !== 'tenant' && rec?.group_type === 'gemini'
        ? PLATFORM_SCOPE
        : ownerScopeFromRequest(req, apiKeyStore?.users)
    const allowedEnvIds =
      policy?.permission_tier === 'resource'
        ? policy.allowed_gemini_envs
        : policy?.allowed_gemini_envs?.length
          ? policy.allowed_gemini_envs
          : null
    return { ownerScope, allowedEnvIds }
  }
  const resolveGeminiPoolAccess = (req, { model = null, ownerScope = null, geminiEnvs = null } = {}) => {
    const requestedPoolId = requestedPoolIdFromHeaders(req?.headers || {})
    const rec = req?.apiKeyRecord || null
    const explicitIntent =
      Boolean(requestedPoolId) ||
      rec?.pool_binding_mode === 'strict_pool' ||
      Boolean(rec?.default_pool_id) ||
      (Array.isArray(rec?.allowed_pool_ids) && rec.allowed_pool_ids.length > 0)
    if (!poolsRepo && !isDbOpen() && !explicitIntent) {
      return {
        ok: true,
        status: 200,
        code: null,
        mode: 'legacy_scope',
        legacy: true,
        isDowngraded: false,
        originPool: null,
        effectivePool: null,
        allowedPoolIds: [],
        allowedMembers: null,
        allowedGeminiEnvIds: null,
        allowedModels: [],
      }
    }
    return resolvePoolAccessForKey({
      key: rec,
      apiKeyKind: req?.apiKeyKind || null,
      requestedPoolId,
      model,
      poolsRepo: poolsRepo || null,
      geminiEnvs,
      geminiOwnerMap: typeof geminiOwnerMap === 'function' ? geminiOwnerMap() : geminiOwnerMap,
      ownerScope,
    })
  }
  const narrowGeminiScope = (scope, poolAccess) => {
    if (!poolAccess || poolAccess.legacy) return scope
    const poolEnvIds = Array.isArray(poolAccess.allowedGeminiEnvIds) ? poolAccess.allowedGeminiEnvIds : []
    const allowedEnvIds = Array.isArray(scope.allowedEnvIds)
      ? scope.allowedEnvIds.filter((id) => poolEnvIds.includes(id))
      : [...poolEnvIds]
    return { ...scope, allowedEnvIds }
  }
  return async function handleGeminiPublic(
    req,
    res,
    {
      logBag: externalLogBag = null,
      logCtx: externalLogCtx = null,
      catalogSnapshot = null,
      preDispatchDecision = null,
    } = {},
  ) {
    res.setHeader('Cache-Control', 'no-store')
    const keyGroupType = req.apiKeyKind === 'managed' ? req.apiKeyRecord?.group_type || 'all' : null
    if (keyGroupType !== 'gemini' && keyGroupType !== 'all') {
      return json(res, 403, {
        error: {
          type: 'permission_error',
          code: 'gemini_key_required',
          message: 'This endpoint requires a Gemini or all-access API key.',
        },
      })
    }
    const baseGeminiScope = geminiScopeFromReq(req)
    const url = new URL(req.url || PUBLIC_PATH, 'http://127.0.0.1')
    const googleModels = url.pathname === '/v1beta/models'
    const singleModelGet = req.method === 'GET' ? parseGeminiModelGetPath(url.pathname) : null
    if (
      req.method === 'GET' &&
      ([PUBLIC_PATH, '/v1/models', '/models', '/v1beta/models'].includes(url.pathname) || singleModelGet)
    ) {
      const modelsPoolAccess = resolveGeminiPoolAccess(req, { ownerScope: baseGeminiScope.ownerScope })
      if (!modelsPoolAccess.ok) {
        const status = modelsPoolAccess.status || 403
        const code = modelsPoolAccess.code || 'pool_unavailable'
        const message = modelsPoolAccess.message || '分组池不可用'
        return json(
          res,
          status,
          protocolErrorBody(
            googleModels || singleModelGet?.version === 'v1beta' ? 'gemini' : 'openai-chat',
            status,
            code,
            message,
          ),
        )
      }
      const effectiveModelScope = narrowGeminiScope(baseGeminiScope, modelsPoolAccess)
      try {
        const catalog = await scheduler.catalog(effectiveModelScope)
        const poolFilteredList = filterModelsForPoolAccess(publicModels(catalog, req), modelsPoolAccess, {
          geminiEnvs: Array.isArray(catalog?.accounts) ? catalog.accounts : null,
        })
        if (singleModelGet) {
          const hit = findCatalogModel(poolFilteredList.data, singleModelGet.model)
          if (!hit) {
            return json(
              res,
              404,
              protocolErrorBody(
                singleModelGet.version === 'v1beta' ? 'gemini' : 'openai-chat',
                404,
                'gemini_model_unavailable',
                `Model not found: ${singleModelGet.model}`,
              ),
            )
          }
          return json(res, 200, singleModelGet.version === 'v1beta' ? googleModelEntry(hit) : hit)
        }
        return json(res, 200, googleModels ? formatGoogleModelList(poolFilteredList.data) : poolFilteredList)
      } catch (error) {
        const mapped = publicError(error)
        return json(
          res,
          mapped.status,
          protocolErrorBody(
            googleModels || singleModelGet?.version === 'v1beta' ? 'gemini' : 'openai-chat',
            mapped.status,
            mapped.body.error.code,
            mapped.body.error.message,
          ),
        )
      }
    }
    const session = /^\/v1\/gemini\/sessions\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(url.pathname)
    const messages = url.pathname === '/v1/messages' || url.pathname === '/messages'
    const chat = url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions'
    const responses = url.pathname === '/v1/responses' || url.pathname === '/responses'
    const google = parseGeminiGeneratePath(url.pathname)
    if (req.method !== 'POST' || !(session || messages || chat || responses || google)) {
      return json(res, 404, { error: { code: 'not_found', message: 'not found' } })
    }
    const protocol = google
      ? 'gemini'
      : messages
        ? 'anthropic'
        : chat
          ? 'openai-chat'
          : responses
            ? 'openai-responses'
            : 'gemini-session'
    if (typeof getRoutingConfig === 'function') {
      const allowed = isGeminiProtocolAllowed(logProtocolName(protocol), getRoutingConfig())
      if (!allowed.ok) {
        return json(
          res,
          allowed.status || 403,
          protocolErrorBody(protocol, allowed.status || 403, allowed.code, allowed.message),
        )
      }
    }
    const routeStream = google ? google.stream : undefined
    const modelFromPath = google ? google.model : null
    const bodyLimit = protocol === 'gemini-session' ? 256 * 1024 : 12 * 1024 * 1024

    const ownLogCtx =
      !externalLogBag && requestLog?.start
        ? requestLog.start(req, { protocol: logProtocolName(protocol), pathName: url.pathname })
        : null
    const activeLogCtx = externalLogCtx || ownLogCtx
    const startedAt = activeLogCtx?.t0 || Date.now()
    const logBag = externalLogBag || {}
    if (logBag.outbound_headers_source === 'unavailable') logBag.outbound_headers_source = null
    if (ownLogCtx) {
      res._kinRequestId = ownLogCtx.request_id
      // Register tapResponse before our finish listener so ctx.response has final status/headers/body.
      requestLog?.tapResponse?.(ownLogCtx, res)
    }
    let ownLogFlushed = false
    let ownLogStatusOverride = null
    const finishOwnLog = (statusCode) => {
      if (!ownLogCtx || ownLogFlushed) return
      ownLogFlushed = true
      try {
        const groupId = req.apiKeyRecord?.group_id ?? 1
        requestLog.finish(ownLogCtx, {
          status: statusCode ?? ownLogStatusOverride ?? (res.statusCode || 0),
          api_key_kind: req.apiKeyKind || null,
          api_key_id: req.apiKeyRecord?.id || null,
          user_id: req.apiKeyRecord?.user_id ?? null,
          group_id: groupId,
          rate_multiplier: groupsRepo?.rateMultiplier?.(groupId) ?? 1,
          ...logBag,
        })
      } catch {}
    }
    const hasFinishHook = typeof res?.once === 'function'
    if (ownLogCtx && hasFinishHook) {
      res.once('finish', () => finishOwnLog(ownLogStatusOverride ?? (res.statusCode || 0)))
    }
    const respondJson = (statusCode, payload) => {
      const out = json(res, statusCode, payload)
      if (ownLogCtx && !hasFinishHook) finishOwnLog(statusCode)
      return out
    }

    let body = req.body
    if (body == null) {
      try {
        body = await readBody(req, bodyLimit)
      } catch (error) {
        const status = error?.status || 400
        logBag.error_code = 'invalid_json'
        logBag.error_message = 'Invalid JSON request body.'
        logBag.final_state = 'failed'
        logBag.attempt_count = 0
        return respondJson(status, protocolErrorBody(protocol, status, 'invalid_json', 'Invalid JSON request body.'))
      }
    }
    if (activeLogCtx?.mode === 'debug' && logBag.inbound_body == null) {
      logBag.inbound_body = body
    }
    if (logBag.inbound_summary == null) {
      logBag.inbound_summary = summarizeBody(body)
    }

    const pfMode = protoFrontMode()
    if (pfMode === 'go' && protocol !== 'gemini-session') {
      try {
        const pfRes = await compileWithProtoFront({
          cfg: { paths: { project: process.cwd() } },
          inboundProtocol: logProtocolName(protocol),
          targetFamily: 'gemini_antigravity',
          reqPath: url.pathname,
          headers: req.headers,
          body,
          routing: typeof getRoutingConfig === 'function' ? getRoutingConfig() : {},
          routeModel: modelFromPath || '',
          routeStream,
        })
        if (pfRes) {
          logBag.hop_meta = {
            ...(logBag.hop_meta && typeof logBag.hop_meta === 'object' ? logBag.hop_meta : {}),
            proto_front: {
              mode: pfRes.mode || null,
              decision: pfRes.decision || null,
              stripped_fields: pfRes.stripped_fields || [],
            },
          }
        }
      } catch (err) {
        logBag.hop_meta = {
          ...(logBag.hop_meta && typeof logBag.hop_meta === 'object' ? logBag.hop_meta : {}),
          proto_front_error: err?.code || err?.message || 'error',
        }
      }
    } else if (pfMode === 'shadow' && protocol !== 'gemini-session') {
      void compileWithProtoFront({
        cfg: { paths: { project: process.cwd() } },
        inboundProtocol: logProtocolName(protocol),
        targetFamily: 'gemini_antigravity',
        reqPath: url.pathname,
        headers: req.headers,
        body,
        routing: typeof getRoutingConfig === 'function' ? getRoutingConfig() : {},
        routeModel: modelFromPath || '',
        routeStream,
      })
        .then((shadowRes) => {
          logBag.hop_meta = {
            ...(logBag.hop_meta && typeof logBag.hop_meta === 'object' ? logBag.hop_meta : {}),
            proto_front_shadow: { ok: shadowRes?.ok === true, mode: shadowRes?.mode, decision: shadowRes?.decision },
          }
        })
        .catch(() => {})
    }
    const supportsStream = typeof scheduler.stream === 'function'
    let parsed = null
    let requested = null
    if (supportsStream) {
      try {
        parsed = parseInboundToGemini(protocol, body, {
          routeModel: modelFromPath,
          routeStream,
          headers: req.headers,
        })
      } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 400
        const code = typeof error?.code === 'string' ? error.code : 'gemini_invalid_request'
        const msg = error?.message || 'Invalid Gemini request.'
        logBag.error_code = code
        logBag.error_message = msg
        logBag.final_state = 'failed'
        logBag.attempt_count = 0
        return respondJson(status, protocolErrorBody(protocol, status, code, msg))
      }
    } else {
      requested = geminiTurnFromBody(body, protocol, modelFromPath)
      if (!requested) {
        const status = 400
        logBag.error_code = 'gemini_unsupported_turn'
        logBag.error_message =
          'This CRAGGemini route accepts one plain-text user turn without tools or generation settings.'
        logBag.final_state = 'failed'
        logBag.attempt_count = 0
        return respondJson(
          status,
          protocolErrorBody(
            protocol,
            status,
            'gemini_unsupported_turn',
            'This CRAGGemini route accepts one plain-text user turn without tools or generation settings.',
          ),
        )
      }
    }

    const targetModel = supportsStream ? parsed.model : requested.model
    const wantStream =
      protocol === 'gemini-session' ? false : (supportsStream ? parsed.stream : requested.stream) === true
    const stickyHeader = extractGeminiSessionId(req, body, session?.[1])
    logBag.model = targetModel
    logBag.requested_model = targetModel
    logBag.stream = wantStream
    logBag.has_tools = Boolean(
      supportsStream
        ? parsed?.tools?.length > 0 ||
            parsed?.webSearch ||
            parsed?.googleTools?.length > 0 ||
            parsed?.requiredCapabilities?.includes('tools')
        : false,
    )
    logBag.attempt_count = 0
    const defaultGeminiEffort = resolveGeminiDefaultEffort(targetModel)
    const impliedModelEffort = extractImpliedModelEffort(targetModel)
    const requestedEffort = parsed?.thinking?.disabled
      ? null
      : parsed?.thinking?.effort ||
        reasoningEffortOf(body) ||
        (impliedModelEffort && impliedModelEffort !== 'none' ? impliedModelEffort : null)
    logBag.reasoning_effort = resolveGeminiReasoningEffort({
      inbound: body,
      parsed,
      model: targetModel,
      defaultEffort: defaultGeminiEffort,
    })
    const inboundSessionId = sessionIdForLog(logBag.session_id) || sessionIdForLog(stickyHeader)
    logBag.session_id = inboundSessionId || THIRD_PARTY_CLIENT_SESSION_ID
    logBag.outbound_session_id = inboundSessionId

    if (keyGroupType === 'all' && !isAntigravityRoutedModel(targetModel)) {
      const msg = 'All-access keys must address Antigravity non-Gemini models with the ag- prefix.'
      logBag.error_code = 'gemini_model_unavailable'
      logBag.error_message = msg
      logBag.final_state = 'failed'
      return respondJson(404, protocolErrorBody(protocol, 404, 'gemini_model_unavailable', msg))
    }

    const denied = keyModelError(req, targetModel, { anthropic: messages })
    if (denied) {
      logBag.error_code = denied.body.error.code
      logBag.error_message = denied.body.error.message
      logBag.final_state = 'failed'
      return respondJson(
        denied.status,
        protocolErrorBody(protocol, denied.status, denied.body.error.code, denied.body.error.message),
      )
    }

    // Fail-Closed pool authorization BEFORE JEV and BEFORE Gemini slot admission.
    // Google/Gemini pools never inject Anthropic System Prompt policies.
    const ownGeminiOwnerMap = typeof geminiOwnerMap === 'function' ? geminiOwnerMap() : geminiOwnerMap
    const hasCatalogAccounts = Array.isArray(catalogSnapshot?.accounts)
    const canReusePoolAccess =
      Boolean(req._poolAccess) &&
      (!ownGeminiOwnerMap || req._poolAccess._geminiOwnerMapChecked === true) &&
      (!hasCatalogAccounts || req._poolAccess._geminiEnvsChecked === true)
    const poolAccess = canReusePoolAccess
      ? req._poolAccess
      : resolveGeminiPoolAccess(req, {
          model: targetModel,
          ownerScope: baseGeminiScope.ownerScope,
          geminiEnvs: hasCatalogAccounts ? catalogSnapshot.accounts : null,
        })
    if (!poolAccess.ok) {
      const status = poolAccess.status || 403
      const code = poolAccess.code || 'pool_unavailable'
      const message = poolAccess.message || '分组池不可用'
      logBag.error_code = code
      logBag.error_message = message
      logBag.final_state = 'policy_blocked'
      logBag.attempt_count = 0
      return respondJson(status, protocolErrorBody(protocol, status, code, message))
    }
    if (poolAccess.effectivePool?.id) {
      logBag.resolved_pool_id = poolAccess.effectivePool.id
    }
    const geminiScope = narrowGeminiScope(baseGeminiScope, poolAccess)

    // Bypasses #1-#4 closed: every public Gemini inference call must clear the
    // unified pre-dispatch JEV gate BEFORE any Gemini account/slot reservation.
    const existingDecision = preDispatchDecision || req._preDispatchDecision || null
    let gateDecision = isTrustedGateDecision(existingDecision) ? existingDecision : null
    if (!gateDecision) {
      const riskState = resolveRiskRepos({ settings, refusalGuards, refusalDevices, refusalSessions })
      const preDispatchInput = {
        req,
        inbound: body,
        body:
          body && typeof body === 'object' && !Array.isArray(body) && targetModel && !body.model
            ? { ...body, model: targetModel }
            : body,
        headers: req.headers,
        distillRules: cfg?.distill,
        policy: riskState.policy,
        settings,
        repo: riskState.repo,
        devices: riskState.devices,
        sessions: riskState.sessions,
        requestId: activeLogCtx?.request_id || '',
        poolJevProfile:
          poolAccess.effectivePool?.jev_profile || req.poolJevProfile || req.apiKeyRecord?.jev_profile || null,
        zeroInject: false,
        channel: 'gemini',
        enforceHardAndJev: true,
        backend: 'oauth',
        openaiPlatform: false,
      }
      gateDecision =
        typeof preDispatch === 'function'
          ? await preDispatch(preDispatchInput)
          : await runUnifiedPreDispatch(preDispatchInput)
    }
    if (gateDecision?.action === 'block') {
      logBag.via = gateDecision.via || 'jev'
      logBag.attempt_count = 0
      logBag.final_state = gateDecision.final_state || 'policy_blocked'
      logBag.error_code = gateDecision.error_code || 'policy_blocked'
      logBag.error_message = gateDecision.message || '请求被协议拦截'
      if (gateDecision.error_details) {
        logBag.error_details = { ...(logBag.error_details || {}), ...gateDecision.error_details }
      }
      logBag.intercept = gateDecision.intercept || null
      logBag.jev_state = gateDecision.jev_state || null
      const retryAfter = gateDecision.retry_after_sec || gateDecision.error?.retryAfterSec
      if (retryAfter) res.setHeader?.('Retry-After', String(retryAfter))
      const clientErr = clientBlockErrorOf(gateDecision)
      return respondJson(
        clientErr.status,
        protocolErrorBody(protocol, clientErr.status, clientErr.code, clientErr.message, clientErr.details),
      )
    }
    if (gateDecision?.intercept && !logBag.intercept) logBag.intercept = gateDecision.intercept
    if (gateDecision?.jev_passed) {
      logBag._jevPassed = true
      if (gateDecision.jev_state) logBag._jevPassState = gateDecision.jev_state
      if (gateDecision.scores) logBag._jevPassScores = gateDecision.scores
    }

    const healthMonitor = typeof getHealthMonitor === 'function' ? getHealthMonitor() : null
    if (healthMonitor && protocol !== 'gemini-session' && isGeminiSeriesId(targetModel)) {
      const canonicalProtocol = logProtocolName(protocol)
      const healthBody =
        body && typeof body === 'object' && !Array.isArray(body)
          ? { ...body, model: targetModel }
          : { model: targetModel }
      const healthDecision = healthMonitor.decide?.(req.headers, healthBody, canonicalProtocol, { model: targetModel })
      if (healthDecision?.action === 'cache') {
        const hpCfg = healthMonitor.getConfig?.()
        const cached = synthesizeProtocolResponse(canonicalProtocol, healthBody, healthDecision.snapshot || {}, hpCfg)
        if (cached) {
          const snapUsage = healthDecision.snapshot?.body?.usage || { input_tokens: 0, output_tokens: 0 }
          logBag.via = healthDecision.via
          logBag.attempt_count = 0
          logBag.vm_id = healthDecision.snapshot?.vm_id || null
          logBag.upstream_model = healthDecision.snapshot?.model || targetModel
          logBag.usage = {
            input_tokens: snapUsage.input_tokens || 0,
            output_tokens: snapUsage.output_tokens || 0,
          }
          logBag.stop_reason = healthDecision.snapshot?.body?.stop_reason || 'end_turn'
          logBag.final_state = healthDecision.via
          logBag.first_token_ms = Math.max(0, Date.now() - startedAt)
          if (wantStream) {
            const sse = formatHealthSse(canonicalProtocol, healthBody, healthDecision.snapshot || {}, hpCfg)
            const out = writeStream(res, [sse])
            if (ownLogCtx && !hasFinishHook) finishOwnLog(200)
            return out
          }
          return respondJson(200, cached)
        }
      }
    }

    const controller = new AbortController()
    req.once?.('aborted', () => controller.abort())
    res.once?.('close', () => {
      if (!res.writableEnded) controller.abort()
    })

    let lastOutboundBody = null
    const applyTurnLog = (turn) => {
      const usage = turn?.usage || {}
      const cacheRead = usage.cache_read_input_tokens ?? usage.cache_read_tokens ?? 0
      const reasoning = usage.reasoning_tokens ?? 0
      const webSearches =
        Number.isSafeInteger(usage.web_search_requests) && usage.web_search_requests > 0
          ? usage.web_search_requests
          : Array.isArray(turn?.searches) && turn.searches.length > 0
            ? turn.searches.length
            : 0
      logBag.model = turn?.model || targetModel
      logBag.requested_model = targetModel
      logBag.upstream_model = turn?.response_model || turn?.upstream_model || turn?.model || targetModel
      logBag.account_id = turn?.account_id || null
      logBag.final_account_id = turn?.account_id || null
      logBag.vm_id = turn?.account_id ? `gemini:${turn.account_id}` : null
      logBag.via = turn?.auth_method === 'api_key' ? 'gemini_api_key' : 'craggemini'
      logBag.stop_reason = turn?.stopReason || 'end_turn'
      logBag.final_state = 'verified'
      logBag.attempt_count = Number.isInteger(turn?.attempt_count) ? turn.attempt_count : 1
      logBag.upstream_status = turn?.upstream_status ?? 200
      const resolvedConvId = sessionIdForLog(turn?.conversation_id)
      if (resolvedConvId) {
        logBag.outbound_session_id = resolvedConvId
      }
      if (turn?.local_tool_drain) {
        if (turn.tool_continuation_parent_request_id) {
          logBag.merge_into_request_id = turn.tool_continuation_parent_request_id
          logBag.tool_continuation = {
            ...(resolvedConvId ? { conversation_id: resolvedConvId } : {}),
            tools: Array.isArray(turn.toolCalls) ? turn.toolCalls.map((tc) => tc?.name).filter(Boolean) : [],
          }
        } else {
          logBag.skip_log = true
        }
      }
      if (Array.isArray(turn?.attempts) && turn.attempts.length > 0) {
        logBag.hop_meta = {
          ...logBag.hop_meta,
          via: logBag.via,
          ...(turn.conversation_id ? { conversation_id: turn.conversation_id } : {}),
          attempts: turn.attempts,
        }
      }
      logBag.reasoning_effort = resolveGeminiReasoningEffort({
        inbound: body,
        parsed,
        outboundBody: lastOutboundBody,
        model: targetModel,
        upstreamModel: turn?.dispatched_model || turn?.upstream_model || turn?.model || targetModel,
        defaultEffort: defaultGeminiEffort,
      })
      logBag.usage = {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        ...(cacheRead > 0 ? { cache_read_input_tokens: cacheRead, cache_read_tokens: cacheRead } : {}),
        ...(reasoning > 0 ? { reasoning_tokens: reasoning } : {}),
        ...(webSearches > 0 ? { web_search_requests: webSearches } : {}),
      }
      const timing = turn?.timing
      if (timing) {
        logBag.first_byte_ms = Number.isFinite(timing.firstByteAt)
          ? Math.max(0, timing.firstByteAt - startedAt)
          : (timing.firstByteMs ?? logBag.first_byte_ms ?? null)
        logBag.first_token_ms = Number.isFinite(timing.firstTokenAt)
          ? Math.max(0, timing.firstTokenAt - startedAt)
          : (timing.ttftMs ?? logBag.first_token_ms ?? null)
        logBag.generation_ms = timing.generationMs ?? null
      } else if (logBag.first_token_ms == null) {
        logBag.first_token_ms = Math.max(0, Date.now() - startedAt)
      }
    }

    const applyErrorLog = (error) => {
      if (!error || typeof error !== 'object') return
      if (Number.isInteger(error.attemptCount)) logBag.attempt_count = error.attemptCount
      if (Number.isInteger(error.upstreamStatus)) logBag.upstream_status = error.upstreamStatus
      if (error.accountId) {
        logBag.account_id = error.accountId
        logBag.final_account_id = error.accountId
        logBag.vm_id = `gemini:${error.accountId}`
      }
      if (error.authMethod) logBag.via = error.authMethod === 'api_key' ? 'gemini_api_key' : 'craggemini'
      if (error.upstreamModel) logBag.upstream_model = error.upstreamModel
      const resolvedErrorConvId = sessionIdForLog(error.conversationId)
      if (resolvedErrorConvId) {
        logBag.outbound_session_id = resolvedErrorConvId
      }
      if (Array.isArray(error.attempts) && error.attempts.length > 0) {
        logBag.hop_meta = {
          ...logBag.hop_meta,
          ...(logBag.via ? { via: logBag.via } : {}),
          ...(error.conversationId ? { conversation_id: error.conversationId } : {}),
          attempts: error.attempts,
        }
      }
      const timing = error.timing
      if (timing) {
        if (Number.isFinite(timing.firstByteAt)) logBag.first_byte_ms = Math.max(0, timing.firstByteAt - startedAt)
        else if (timing.firstByteMs != null) logBag.first_byte_ms = timing.firstByteMs
        if (Number.isFinite(timing.firstTokenAt)) logBag.first_token_ms = Math.max(0, timing.firstTokenAt - startedAt)
        else if (timing.ttftMs != null) logBag.first_token_ms = timing.ttftMs
        if (timing.generationMs != null) logBag.generation_ms = timing.generationMs
      }
      const usage = error.usage
      if (usage && (usage.input_tokens || usage.output_tokens || usage.cache_read_tokens || usage.reasoning_tokens)) {
        const cacheRead = usage.cache_read_input_tokens ?? usage.cache_read_tokens ?? 0
        const reasoning = usage.reasoning_tokens ?? 0
        logBag.usage = {
          input_tokens: usage.input_tokens || 0,
          output_tokens: usage.output_tokens || 0,
          ...(cacheRead > 0 ? { cache_read_input_tokens: cacheRead, cache_read_tokens: cacheRead } : {}),
          ...(reasoning > 0 ? { reasoning_tokens: reasoning } : {}),
        }
      }
      if (lastOutboundBody) {
        logBag.reasoning_effort = resolveGeminiReasoningEffort({
          inbound: body,
          parsed,
          outboundBody: lastOutboundBody,
          model: targetModel,
          upstreamModel: error.upstreamModel || targetModel,
          defaultEffort: defaultGeminiEffort,
        })
      }
    }

    if (!supportsStream) {
      try {
        const turn = await scheduler.complete({
          model: requested.model,
          text: requested.text,
          requestId: activeLogCtx?.request_id,
          startedAt,
          stickyKey: stickyHeader ? `${req.apiKeyRecord?.id || 'anon'}:${stickyHeader.slice(0, 128)}` : null,
          signal: controller.signal,
          apiKeyRecord: req.apiKeyRecord,
          allowUnprefixedNonGemini: keyGroupType === 'gemini',
          ...(catalogSnapshot ? { catalogSnapshot } : {}),
          ...geminiScope,
        })
        applyTurnLog(turn)
        if (messages) {
          if (requested.stream) {
            const out = writeStream(res, anthropicStream(turn))
            if (ownLogCtx && !hasFinishHook) finishOwnLog(200)
            return out
          }
          return respondJson(200, anthropicMessage(turn))
        }
        if (protocol === 'openai-chat') {
          if (!requested.stream) return respondJson(200, chatCompletion(turn))
          const id = `chatcmpl_${crypto.randomBytes(12).toString('hex')}`
          const out = writeStream(res, [
            `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: turn.model, choices: [{ index: 0, delta: { role: 'assistant', content: turn.text }, finish_reason: null }] })}\n\n`,
            `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: turn.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: turn.usage?.input_tokens || 0, completion_tokens: turn.usage?.output_tokens || 0, total_tokens: turn.usage?.total_tokens || 0 } })}\n\n`,
            'data: [DONE]\n\n',
          ])
          if (ownLogCtx && !hasFinishHook) finishOwnLog(200)
          return out
        }
        if (protocol === 'openai-responses') {
          if (requested.stream) {
            const out = writeStream(res, responsesStream(turn))
            if (ownLogCtx && !hasFinishHook) finishOwnLog(200)
            return out
          }
          return respondJson(200, responsesOutput(turn))
        }
        if (protocol === 'gemini') {
          const response = googleOutput(turn)
          if (routeStream) {
            const out = writeStream(res, [`data: ${JSON.stringify(response)}\n\n`])
            if (ownLogCtx && !hasFinishHook) finishOwnLog(200)
            return out
          }
          return respondJson(200, response)
        }
        return respondJson(200, {
          id: session[1],
          model: turn.model,
          account_id: turn.account_id,
          output_text: turn.text,
          usage: turn.usage,
        })
      } catch (error) {
        applyErrorLog(error)
        if (controller.signal.aborted) {
          logBag.error_code = 'gemini_inference_cancelled'
          logBag.final_state = 'cancelled'
          ownLogStatusOverride = 499
          finishOwnLog(499)
          return
        }
        const mapped = publicError(error)
        logBag.error_code = mapped.body.error.code
        logBag.error_message = mapped.body.error.message
        logBag.final_state = 'failed'
        if (Number.isFinite(Number(mapped.retryAfter)) && Number(mapped.retryAfter) > 0) {
          res.setHeader?.('Retry-After', String(Math.max(1, Math.ceil(Number(mapped.retryAfter)))))
        }
        return respondJson(
          mapped.status,
          protocolErrorBody(protocol, mapped.status, mapped.body.error.code, mapped.body.error.message, mapped.details),
        )
      }
    }

    let headersSent = false
    const encoder = wantStream
      ? createGeminiProtocolStreamEncoder(protocol, { model: parsed.model, restoreContext: parsed.restoreContext })
      : null
    const continuationCallIds = []
    const parsedMsgs = Array.isArray(parsed.messages) ? parsed.messages : []
    for (let i = parsedMsgs.length - 1; i >= 0; i -= 1) {
      const msgResults = []
      for (const part of parsedMsgs[i]?.parts || []) {
        if (part?.kind === 'tool_result' && typeof part.callId === 'string' && part.callId) {
          msgResults.push(part.callId)
        }
      }
      if (!msgResults.length) break
      continuationCallIds.unshift(...msgResults)
    }
    const writeChunk = (text) => {
      if (!text || controller.signal.aborted) return
      if (!headersSent) {
        beginSse(res)
        headersSent = true
      }
      res.write(text)
    }

    const deriveFirstUserFingerprint = () => {
      const msgs = Array.isArray(parsed?.messages) ? parsed.messages : []
      const firstUser = msgs.find((m) => m?.role === 'user') || msgs[0]
      if (!firstUser || !Array.isArray(firstUser.parts)) return ''
      const text = firstUser.parts
        .filter((p) => p?.kind === 'text' && typeof p.text === 'string' && p.text.trim())
        .map((p) => p.text)
        .join('\n')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 4000)
      if (text) return `ch:${crypto.createHash('sha256').update(text).digest('hex').slice(0, 24)}`
      const firstMedia = firstUser.parts.find((p) => p?.data || p?.url)
      if (firstMedia) {
        const seed = firstMedia.data ? String(firstMedia.data).slice(0, 512) : String(firstMedia.url)
        return `ch:${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24)}`
      }
      return ''
    }
    const codexStyleKey = stickyRouter?.extractPoolKey?.(req, body, { platform: 'gemini' }) || null
    const stickySeed =
      stickyHeader ||
      deriveFirstUserFingerprint() ||
      (typeof body?.previous_response_id === 'string' && body.previous_response_id.trim()) ||
      ''
    const stickyKey =
      codexStyleKey || (stickySeed ? `${req.apiKeyRecord?.id || 'anon'}:${stickySeed.slice(0, 128)}` : null)

    try {
      const promptPolicy = resolveCragGeminiPromptPolicy(
        typeof getRoutingConfig === 'function' ? getRoutingConfig() : {},
      )
      const builtTargetBodies = new Map()
      const turn = await scheduler.stream({
        model: parsed.model,
        requestedEffort,
        ...(activeLogCtx?.request_id ? { requestId: activeLogCtx.request_id } : {}),
        startedAt,
        targetBodyFor: (target, meta) => {
          const targetModelName = meta?.upstreamModel || parsed.model
          const cacheKey = `${target}\0${targetModelName}`
          let built = builtTargetBodies.get(cacheKey)
          if (!built) {
            const irForTarget = {
              ...parsed,
              requestedModel: targetModel,
              ...(meta?.upstreamModel ? { model: meta.upstreamModel } : {}),
              // On CRAGGemini (`antigravity`), always apply the scheduler's account-scoped
              // outbound conversation_id so switching accounts never reuses the prior account's
              // or raw caller's conversation_id.
              ...(target === 'antigravity' && meta?.conversationId ? { conversationId: meta.conversationId } : {}),
            }
            const reqBody = buildGeminiRequest(irForTarget, {
              target,
              defaultEffort: defaultGeminiEffort,
              includeThinkingConfig:
                target === 'antigravity' && Boolean(requestedEffort || parsed?.thinking || parsed?.hideThinking),
            })
            const normalized = normalizeGeminiOutboundPrompt(reqBody, {
              target,
              policy: promptPolicy,
              headers: req.headers,
            })
            built = {
              body: normalized.body,
              report: normalized.report,
              summary: summarizeBody(normalized.body),
            }
            builtTargetBodies.set(cacheKey, built)
          }
          const finalBody =
            target === 'antigravity' &&
            meta?.conversationId &&
            built.body &&
            typeof built.body === 'object' &&
            built.body.conversation_id !== meta.conversationId
              ? { ...built.body, conversation_id: meta.conversationId }
              : built.body
          lastOutboundBody = finalBody
          logBag.outbound_summary = built.summary
          if (built.report) {
            logBag.hop_meta = {
              ...(logBag.hop_meta && typeof logBag.hop_meta === 'object' ? logBag.hop_meta : {}),
              prompt_normalization: built.report,
            }
          }
          if (activeLogCtx?.capture_outbound) {
            logBag.outbound_body = finalBody
            logBag.outbound_body_source = target === 'antigravity' ? 'craggemini' : 'gemini_api'
          }
          return finalBody
        },
        restoreContext: parsed.restoreContext,
        continuationCallIds,
        inboundConversationId: parsed.conversationId || null,
        requiredCapabilities: parsed.requiredCapabilities,
        unsupportedFields: parsed.unsupportedFields,
        plainText: parsed.plainText,
        stickyKey,
        signal: controller.signal,
        apiKeyRecord: req.apiKeyRecord,
        allowUnprefixedNonGemini: keyGroupType === 'gemini',
        ...(catalogSnapshot ? { catalogSnapshot } : {}),
        ...geminiScope,
        onEvent: wantStream
          ? (event) => {
              if (event?.kind === 'error') return headersSent
              writeChunk(encoder.push(event))
              return headersSent
            }
          : null,
      })
      if (controller.signal.aborted) {
        applyTurnLog(turn)
        delete logBag.merge_into_request_id
        delete logBag.tool_continuation
        delete logBag.skip_log
        logBag.error_code = 'gemini_inference_cancelled'
        logBag.final_state = 'cancelled'
        ownLogStatusOverride = 499
        finishOwnLog(499)
        return
      }
      applyTurnLog(turn)
      if (wantStream) {
        writeChunk(encoder.finish())
        if (!headersSent) beginSse(res)
        res.end()
        if (ownLogCtx && !hasFinishHook) finishOwnLog(200)
        return
      }
      return respondJson(
        200,
        renderGeminiProtocolResponse(protocol, turn, {
          model: turn.response_model || turn.model || parsed.model,
          sessionId: session?.[1],
          accountId: turn.account_id,
          restoreContext: parsed.restoreContext,
        }),
      )
    } catch (error) {
      applyErrorLog(error)
      if (controller.signal.aborted) {
        logBag.error_code = 'gemini_inference_cancelled'
        logBag.final_state = 'cancelled'
        ownLogStatusOverride = 499
        finishOwnLog(499)
        return
      }
      const mapped = publicError(error)
      logBag.error_code = mapped.body.error.code
      logBag.error_message = mapped.body.error.message
      logBag.final_state = 'failed'
      if (headersSent) {
        ownLogStatusOverride = 200
        try {
          res.write(
            formatGeminiProtocolStreamError(protocol, mapped.status, mapped.body.error.code, mapped.body.error.message),
          )
          res.end()
        } catch {}
        if (ownLogCtx && !hasFinishHook) finishOwnLog(200)
        return
      }
      if (Number.isFinite(Number(mapped.retryAfter)) && Number(mapped.retryAfter) > 0) {
        res.setHeader?.('Retry-After', String(Math.max(1, Math.ceil(Number(mapped.retryAfter)))))
      }
      return respondJson(
        mapped.status,
        protocolErrorBody(protocol, mapped.status, mapped.body.error.code, mapped.body.error.message, mapped.details),
      )
    }
  }
}
