import type { StatusTone } from '@/types/status'
import { isGeminiHostIssue } from '@/lib/gemini-recovery'

type Authorization = {
  auth_state:
    'unverified' | 'authorizing' | 'authorized' | 'reauth_required' | 'disabled'
  auth_method: 'oauth' | 'api_key'
  oauth_imported?: boolean
}

type LastInference = {
  state: 'running' | 'completed' | 'failed' | 'cancelled'
  model: string
  started_at: string
  finished_at: string | null
  error_code: string | null
}

type InferenceEvidence = { last_inference?: LastInference | null }

type CragLicense = {
  product?: string
  valid: boolean
  status?: string
  code?: string | null
  seat?: number | null
  scope?: string | null
  seat_required?: boolean
}

type AccountRestriction = {
  reason: string
  text: string
  until: number | null
}

type AccountCircuit = {
  state: 'closed' | 'open' | 'half_open'
  failures: number
  threshold: number
  open_until: number | null
  open_ms: number
}

type AccountUnschedulable = {
  reason: string
  detail?: string
  at?: string
  upstream_status?: number
  error_code?: string
}

type AccountCheckMeta = {
  state?: 'ok' | 'partial' | 'error' | 'reauth_required'
  checked_at?: string | null
  error_code?: string | null
  error_message?: string | null
  http_status?: number | null
  eligibility?: string | null
}

type Account = Authorization &
  InferenceEvidence & {
    models_discovered?: boolean
    models: readonly string[]
    proxy_ready?: boolean
    schedulable?: boolean
    unschedulable?: AccountUnschedulable | null
    unschedulable_reason?: string | null
    unschedulable_detail?: string | null
    restriction?: AccountRestriction | null
    circuit?: AccountCircuit | null
    crag_license?: CragLicense | null
    account?: AccountCheckMeta | null
  }

type InventoryPrerequisites = {
  available: boolean
  payload_state?: string
  release_activated?: boolean | null
  oauth_runtime_issue?: string | null
}

const OAUTH_RUNTIME_LABELS: Readonly<Record<string, string>> = {
  gemini_oauth_tools_missing: '宿主缺少 Google 授权所需工具',
  gemini_egress_unavailable: '宿主缺少可用的 kin-egress',
  gemini_ipv4_forwarding_unavailable: '宿主 IPv4 转发未就绪',
  gemini_sandbox_apparmor_restricted: '宿主 AppArmor 限制了 Gemini 沙箱',
  gemini_sandbox_unavailable: '宿主非特权沙箱（bwrap）不可用',
}

export function geminiHostBlocker(
  environment: Pick<Authorization, 'auth_method'>,
  inventory?: InventoryPrerequisites,
  payloadIssue?: string | null
): string | null {
  if (inventory?.available === false) return 'Gemini 宿主服务不可用'
  if (payloadIssue) return payloadIssue
  if (inventory?.payload_state === 'install_on_create')
    return '宿主尚未安装签名载荷'
  if (
    inventory?.payload_state === 'awaiting_redemption' ||
    inventory?.release_activated === false
  ) {
    return '请先兑换 CRAGGemini 内核'
  }
  if (environment.auth_method === 'oauth' && inventory?.oauth_runtime_issue) {
    const code = inventory.oauth_runtime_issue
    return Object.prototype.hasOwnProperty.call(OAUTH_RUNTIME_LABELS, code)
      ? OAUTH_RUNTIME_LABELS[code]
      : '宿主 OAuth 运行条件未满足'
  }
  return null
}

export function geminiAuthorizationLabel(environment: Authorization): string {
  const apiKey = environment.auth_method === 'api_key'
  switch (environment.auth_state) {
    case 'disabled':
      return '已停用'
    case 'reauth_required':
      return apiKey ? '需要重新配置 API Key' : '需要重新授权'
    case 'authorizing':
      return apiKey ? '等待配置 API Key' : '等待 Google 授权'
    case 'authorized':
      if (apiKey) return '已配置 API Key'
      return environment.oauth_imported
        ? '已导入 OAuth 凭证'
        : '已完成官方 Google 授权'
    default:
      return apiKey ? '未配置 API Key' : '未授权'
  }
}

const INFERENCE_TONES = {
  unknown: { key: 'unknown', cls: 'none', text: '尚无宿主推理记录' },
  running: { key: 'running', cls: 'none', text: '宿主推理进行中' },
  completed: { key: 'completed', cls: 'ok', text: '上次宿主推理成功' },
  failed: { key: 'failed', cls: 'caution', text: '上次宿主推理失败' },
  cancelled: { key: 'cancelled', cls: 'none', text: '上次宿主推理已取消' },
} satisfies Record<LastInference['state'] | 'unknown', StatusTone>

function inferenceTone(environment: InferenceEvidence): StatusTone {
  return INFERENCE_TONES[environment.last_inference?.state ?? 'unknown']
}

export function geminiInferenceLabel(environment: InferenceEvidence): string {
  return inferenceTone(environment).text
}

const INFERENCE_ERROR_LABELS: Readonly<Record<string, string>> = {
  gemini_location_unsupported: 'Google 403：地区或账号受限',
  gemini_account_verification_required: 'Google 账号需先完成浏览器验证',
  gemini_client_unsupported: 'Google 拒绝当前客户端版本（UNSUPPORTED_CLIENT）',
  gemini_account_ineligible: 'Google 账号不符合资格或可能已停用',
  gemini_proxy_error: '代理连接错误',
  gemini_proxy_unavailable: '代理不可用',
  gemini_model_unavailable: '模型不可用',
  gemini_models_empty: '没有可调用模型',
  gemini_oauth_required: '该次请求需重新授权',
  gemini_api_key_invalid: '该次请求的 API Key 被拒绝',
  gemini_api_key_rejected: '该次请求的 API Key 被拒绝',
  gemini_quota_exhausted: '额度用尽',
  gemini_pool_overloaded: '号池高负载（全部账号不可调度）',
  gemini_upstream_unavailable: '上游服务暂时不可用（503）',
  gemini_content_rejected: '内容触发上游过滤（429）',
  gemini_inference_failed: '上游推理失败（502）',
  gemini_inference_timeout: '请求超时',
  gemini_inference_bad_input: '推理输入不受支持',
  gemini_inference_invalid_output: '响应无法解析',
  gemini_inference_output_limit: '响应超过长度限制',
  gemini_inference_tool_blocked: '不支持工具调用',
  gemini_native_config_invalid: 'CRAGGemini 配置被载荷拒绝',
  gemini_sandbox_apparmor_restricted: '宿主 AppArmor 限制了 Gemini 沙箱',
  gemini_sandbox_unavailable: '宿主非特权沙箱不可用',
  gemini_host_resource_exhausted: '宿主机文件描述符耗尽（EMFILE/ENFILE）',
  license_required: '未绑定 CRAGGemini 订阅席位',
  license_expired: 'CRAGGemini 订阅许可已过期',
  license_not_yet_valid: 'CRAGGemini 许可尚未生效',
  license_invalid: 'CRAGGemini 许可无效',
  license_binding_mismatch: 'CRAGGemini 许可绑定不匹配',
  license_payload_key_mismatch: 'CRAGGemini 许可与当前载荷版本不匹配',
  license_unconfigured: 'CRAGGemini 订阅未配置',
  gemini_subscription_sync_pending: 'CRAGGemini 宿主订阅同步中',
}

export const DEFAULT_GEMINI_TEST_PROMPT = 'hello'
export const ANTIGRAVITY_MODEL_PREFIX = 'ag-'

export type GeminiModelProvider = 'google' | 'anthropic' | 'openai'

export type GeminiModelCatalogEntry = {
  id: string
  provider: GeminiModelProvider
  quota_group: string
}

export type GeminiGroupedModel = {
  rawId: string
  publicId: string
  provider: GeminiModelProvider
  quotaGroup: string
}

export type GeminiModelGroup = {
  provider: GeminiModelProvider
  label: string
  models: GeminiGroupedModel[]
}

const MODEL_GROUP_LABELS: Readonly<Record<GeminiModelProvider, string>> = {
  google: 'Google Gemini',
  anthropic: 'Anthropic（API 前缀 ag-）',
  openai: 'OpenAI / 第三方（API 前缀 ag-）',
}

function inferModelProvider(rawId: string): GeminiModelProvider {
  const lower = rawId.trim().toLowerCase()
  const base = lower.startsWith(ANTIGRAVITY_MODEL_PREFIX)
    ? lower.slice(ANTIGRAVITY_MODEL_PREFIX.length)
    : lower
  if (base.startsWith('claude-')) return 'anthropic'
  if (/^(gpt-|o[1-9]|chatgpt|codex-)/.test(base)) return 'openai'
  return 'google'
}

export function groupGeminiModels(
  models: readonly string[],
  catalog?: readonly GeminiModelCatalogEntry[] | null
): GeminiModelGroup[] {
  const catalogMap = new Map<string, GeminiModelCatalogEntry>()
  for (const entry of catalog ?? []) {
    if (entry?.id) catalogMap.set(entry.id, entry)
  }
  const buckets: Record<GeminiModelProvider, GeminiGroupedModel[]> = {
    google: [],
    anthropic: [],
    openai: [],
  }
  const seen = new Set<string>()
  for (const raw of models) {
    const rawId = raw?.trim()
    if (!rawId || seen.has(rawId)) continue
    seen.add(rawId)
    const meta = catalogMap.get(rawId)
    const provider: GeminiModelProvider =
      meta?.provider === 'google' ||
      meta?.provider === 'anthropic' ||
      meta?.provider === 'openai'
        ? meta.provider
        : inferModelProvider(rawId)
    const publicId =
      provider === 'google'
        ? rawId
        : rawId.toLowerCase().startsWith(ANTIGRAVITY_MODEL_PREFIX)
          ? rawId
          : `${ANTIGRAVITY_MODEL_PREFIX}${rawId}`
    const quotaGroup =
      meta?.quota_group ||
      (provider !== 'google'
        ? '3p'
        : rawId.toLowerCase().includes('argon')
          ? 'gemini-argon-wtu'
          : 'gemini')
    buckets[provider].push({ rawId, publicId, provider, quotaGroup })
  }
  return (['google', 'anthropic', 'openai'] as const)
    .filter((provider) => buckets[provider].length > 0)
    .map((provider) => ({
      provider,
      label: MODEL_GROUP_LABELS[provider],
      models: buckets[provider],
    }))
}

export function defaultGeminiTestModel(models: readonly string[]): string {
  const clean = models.filter(Boolean)
  if (!clean.length) return ''
  return (
    clean.find((id) => id === 'gemini-4-neon') ??
    clean.find((id) => id === 'gemini-4-neon-high') ??
    clean.find((id) => id.startsWith('gemini-4-neon')) ??
    clean.find((id) => id.startsWith('gemini-')) ??
    clean[0]
  )
}

const INFERENCE_ERROR_ACTIONS: Readonly<Record<string, string>> = {
  gemini_account_verification_required:
    '处理方式：在对应 Google 账号已登录的浏览器中打开「账号」页的 Google 验证链接完成核验，随后刷新账号并重新测试。',
  gemini_location_unsupported:
    '处理方式：Google 返回 403 拒绝 Antigravity，可能因出口地区不受支持，也可能因账号被停用；资格查询有时仍显示正常，请以实际对话为准。若为地区限制（UNSUPPORTED_REGION），请在「代理」页更换支持地区（如美国住宅）的 SOCKS5 代理；若账号被停用，请申诉或更换账号。',
  gemini_client_unsupported:
    '处理方式：Google 拒绝当前 Antigravity 客户端版本或协议标识（403 UNSUPPORTED_CLIENT），不代表账号订阅失效；请先前往「设置 → Gemini 维护」更新 CRAGGemini，再刷新账号或重新测试。',
  gemini_account_ineligible:
    '处理方式：Google 判定该账号不符合 Antigravity 资格或可能已被停用（403）。若上游为 TOS_VIOLATION，请在 Google 侧申诉或更换账号；资格查询不一定反映停用状态，请以实际对话测试确认。',
  gemini_oauth_required:
    '处理方式：OAuth 凭据已失效或被吊销（401 / invalid_grant），请在「账号」页重新完成官方 Google 授权，并确保授权浏览器与代理出口地区一致。',
  gemini_api_key_invalid:
    '处理方式：请在 Google AI Studio 核对 API Key 有效性、计费状态与项目权限后重新填写。',
  gemini_api_key_rejected:
    '处理方式：请在 Google AI Studio 核对 API Key 有效性、计费状态与项目权限后重新填写。',
  gemini_quota_exhausted:
    '处理方式：上游配额已耗尽（429），请等待配额重置、改用其他模型或切换至其他可用账号。',
  gemini_pool_overloaded:
    '处理方式：当前所有 Gemini 账号均不可调度或处于冷却/高负载，请检查账号错误状态、恢复 502 暂停账号或稍后重试。',
  gemini_upstream_unavailable:
    '处理方式：Google 上游返回 503 临时不可用，调度器已自动保留 agy 进程并切号，无需人工重启。',
  gemini_content_rejected:
    '处理方式：提示词触发上游内容过滤（429），账号配额未受影响，请调整提示词后重试。',
  gemini_proxy_error:
    '处理方式：请在「代理」页探活检查 SOCKS5 节点连通性与出口稳定性，或更换代理后重试。',
  gemini_proxy_unavailable:
    '处理方式：绑定代理当前不可用，请在「代理」页重新绑定健康可用的 IPv4 SOCKS5 代理。',
  gemini_model_unavailable:
    '处理方式：所选模型未对当前账号开放，请先点击「拉取模型」刷新可用列表后再选。',
  gemini_models_empty:
    '处理方式：上游未返回可调用模型，请检查代理连通性、账号订阅资格或重新授权后再拉取。',
  gemini_inference_timeout:
    '处理方式：上游响应超时（504），请检查代理延迟或稍后重试。',
  gemini_inference_bad_input: '处理方式：请缩短提示词或改为纯文本内容后重试。',
  gemini_inference_invalid_output:
    '处理方式：上游返回异常空包或中断，请重试或切换其他模型确认。',
  gemini_inference_output_limit:
    '处理方式：回复超出单次测试长度上限，请精简提示词或要求简短回答后重试。',
  gemini_inference_tool_blocked:
    '处理方式：当前测试通道不允许该工具调用，请改用纯文本提示词测试。',
  gemini_inference_failed:
    '处理方式：请先在「账号」页点击刷新确认是否触发 Google 身份验证/风控，再排查绑定代理与宿主服务日志。',
  gemini_native_worker_unavailable:
    '处理方式：CRAGGemini 常驻内核正在预热或异常退出，请稍候重试，或前往「设置 → Gemini 维护」检查载荷与宿主服务。',
  gemini_native_config_invalid:
    '处理方式：CRAGGemini 在握手前因配置字段不兼容退出，请前往「设置 → Gemini 维护」对齐宿主脚本与签名载荷版本后重试。',
  gemini_native_tty_unavailable:
    '处理方式：宿主机终端资源不足，请检查并重启宿主机 vm2api-gemini 服务。',
  gemini_native_bridge_timeout:
    '处理方式：本地桥接握手超时，请稍候重试或检查宿主机 vm2api-gemini 日志。',
  gemini_authorization_unavailable:
    '处理方式：宿主服务在线但未能拉起授权进程，请检查宿主机日志与绑定代理的出口连通性。',
  gemini_sandbox_apparmor_restricted:
    '处理方式：宿主机 AppArmor 限制了非特权 user namespace，请前往「设置 → Gemini 维护」执行「修复安装」或在宿主机运行 prepare-gemini。',
  gemini_sandbox_unavailable:
    '处理方式：宿主机非特权沙箱（bwrap）不可用，请前往「设置 → Gemini 维护」诊断宿主并检查 bubblewrap 与服务日志。',
  gemini_host_resource_exhausted:
    '处理方式：宿主机文件描述符耗尽（EMFILE/ENFILE），请重启 vm2api-gemini 服务并检查 Unix 控制连接池是否泄漏。',
  license_required:
    '处理方式：请在「账号」页为当前环境绑定可用的 CRAGGemini 订阅席位。',
  license_expired:
    '处理方式：CRAGGemini 订阅已过期，请前往订阅页续费或兑换新码后再试。',
  license_not_yet_valid:
    '处理方式：请核对宿主机系统时间与 CRAGGemini 许可生效时间。',
  license_invalid:
    '处理方式：请确认 CRAGGemini 宿主订阅已激活且未处于同步中，然后在「账号」页点击「重新绑定 CRAG 席位」，或前往「设置 → Gemini 维护」检查载荷与宿主订阅目录。',
  license_binding_mismatch:
    '处理方式：许可与当前环境设备或宿主机名单不一致，请在「账号」页点击「重新绑定 CRAG 席位」。',
  license_payload_key_mismatch:
    '处理方式：CRAGGemini 载荷密钥已更新，请在「账号」页点击「重新绑定 CRAG 席位」以换签当前版本许可。',
  license_unconfigured:
    '处理方式：请先在「订阅 CRAG」或「导入 → Gemini」完成 CRAGGemini 兑换与激活。',
  gemini_subscription_sync_pending:
    '处理方式：宿主机上次订阅变更尚未完成同步，请点击「继续同步订阅」或稍候等待自动恢复。',
}

export function geminiInferenceErrorLabel(code?: string | null): string {
  if (
    code &&
    Object.prototype.hasOwnProperty.call(INFERENCE_ERROR_LABELS, code)
  )
    return INFERENCE_ERROR_LABELS[code]
  return isGeminiHostIssue(code) ? '宿主运行环境故障' : '未知原因'
}

export function geminiInferenceErrorAction(
  code?: string | null
): string | null {
  if (
    code &&
    Object.prototype.hasOwnProperty.call(INFERENCE_ERROR_ACTIONS, code)
  )
    return INFERENCE_ERROR_ACTIONS[code]
  return isGeminiHostIssue(code)
    ? '处理方式：请前往「设置 → Gemini 维护」检查宿主机服务、签名载荷与日志。'
    : null
}

function safeGoogleValidationUrl(value?: string | null): string | null {
  if (typeof value !== 'string' || !value || value.length > 2048) return null
  try {
    const parsed = new URL(value.trim())
    if (
      parsed.origin !== 'https://accounts.google.com' ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    )
      return null
    return parsed.href
  } catch {
    return null
  }
}

/**
 * 上游资格提示。`lastInference` 是比账号检查更新的成功宿主推理时，
 * 说明验证已完成，旧的资格结论不再提示。
 */
export function geminiEligibilityNotice(
  account?: {
    eligibility?: string | null
    validation_url?: string | null
    checked_at?: string | null
  } | null,
  lastInference?: Pick<LastInference, 'state' | 'finished_at'> | null
): {
  label: string
  action: string
  validationUrl: string | null
  advisory: boolean
} | null {
  if (lastInference?.state === 'completed' && lastInference.finished_at) {
    const checked = account?.checked_at ? Date.parse(account.checked_at) : NaN
    const finished = Date.parse(lastInference.finished_at)
    // 抑制提示需要证明这次推理比资格结论更新。缺失或无法解析的 checked_at
    // 不是证明（面板的 checked_at 没有兜底，缺字段就下发 null），而误抑制会
    // 连一键验证链接一起藏掉，此时后端仍按 eligibility 冷却该账号。
    if (
      Number.isFinite(checked) &&
      Number.isFinite(finished) &&
      finished >= checked
    )
      return null
  }
  switch (account?.eligibility) {
    case 'verification_required':
      return {
        label: 'Google 要求先完成账号身份验证（VALIDATION_REQUIRED）',
        action:
          '请在对应 Google 账号浏览器打开下方验证链接完成核验，随后返回刷新账号状态即可恢复对话。',
        validationUrl: safeGoogleValidationUrl(account.validation_url),
        advisory: false,
      }
    case 'location_unsupported':
      return {
        label: 'Google 返回 403：地区可能不受支持，或账号已被停用',
        action:
          '资格/拉取模型有时仍显示正常，请以实际对话为准。若为地区限制（UNSUPPORTED_REGION），请在「代理」页更换支持地区（如美国住宅）的 SOCKS5 代理后刷新；若账号被停用，请申诉或更换账号。',
        validationUrl: null,
        advisory: false,
      }
    case 'client_unsupported':
      return {
        label: 'Google 拒绝当前客户端版本或标识（UNSUPPORTED_CLIENT）',
        action:
          '这通常与客户端版本或协议标识有关，不代表账号订阅失效；请前往「设置 → Gemini 维护」升级最新 CRAGGemini，再刷新账号或测试对话验证。',
        validationUrl: null,
        advisory: false,
      }
    case 'ineligible':
      return {
        label: 'Google 账号不符合资格或可能已被停用',
        action:
          '若以实际对话确认不可用，请核对订阅/年龄限制或更换账号；若上游原因为 TOS_VIOLATION，请在 Google 侧申诉。资格查询不一定反映停用状态，请以实际对话测试为准。',
        validationUrl: null,
        advisory: false,
      }
    default: {
      const validationUrl = safeGoogleValidationUrl(account?.validation_url)
      return validationUrl
        ? {
            label: 'Google 返回了账号核验链接（不代表当前账号不可用）',
            action:
              '若对话提示需要身份核验，请在对应 Google 账号浏览器打开链接，完成核验后重试。',
            validationUrl,
            advisory: true,
          }
        : null
    }
  }
}

const PENDING_TONE: StatusTone = { key: 'pending', cls: 'none', text: '待验证' }

const UNSCHEDULABLE_REASON_LABELS: Readonly<Record<string, string>> = {
  upstream_502: '上游 502 异常 · 已暂停调度',
  proxy_502: '代理 502 异常 · 已暂停调度',
  reauth_required: 'OAuth 凭证失效 · 需重新授权',
  verification_required: '需完成 Google 身份验证',
  location_unsupported: '账号/代理地区不支持',
  ineligible: '账号资格受限',
}

export function geminiUnschedulableLabel(
  reason?: string | null,
  detail?: string | null
): string {
  if (
    reason &&
    Object.prototype.hasOwnProperty.call(UNSCHEDULABLE_REASON_LABELS, reason)
  ) {
    return UNSCHEDULABLE_REASON_LABELS[reason]
  }
  if (detail && detail.trim()) return detail.trim()
  return '不可调度'
}

export function geminiAccountErrorText(
  account?: AccountCheckMeta | null
): string | null {
  if (!account) return null
  if (account.error_message && account.error_message.trim()) {
    const statusSuffix =
      typeof account.http_status === 'number' && account.http_status > 0
        ? ` (HTTP ${account.http_status})`
        : ''
    return `${account.error_message.trim()}${
      account.error_message.includes(String(account.http_status ?? ''))
        ? ''
        : statusSuffix
    }`
  }
  if (account.error_code) {
    return geminiInferenceErrorLabel(account.error_code)
  }
  if (account.state === 'reauth_required') return '需要重新完成 Google 授权'
  if (account.state === 'error') return '定时状态检查失败，请检查代理或刷新账号'
  return null
}

function candidateBlocker(
  environment: Account,
  hostBlocker?: string | null
): string | null {
  if (environment.auth_state !== 'authorized') return null
  if (environment.unschedulable?.reason) {
    return geminiUnschedulableLabel(
      environment.unschedulable.reason,
      environment.unschedulable.detail
    )
  }
  if (environment.auth_method === 'oauth' && environment.oauth_imported) {
    return '需完成官方 Google 授权'
  }
  if (environment.proxy_ready === false) return '绑定代理不可用'
  if (hostBlocker) return hostBlocker
  if (
    environment.auth_method === 'oauth' &&
    environment.crag_license &&
    environment.crag_license.valid === false
  ) {
    const code = environment.crag_license.code
    return code &&
      Object.prototype.hasOwnProperty.call(INFERENCE_ERROR_LABELS, code)
      ? INFERENCE_ERROR_LABELS[code]
      : '未绑定 CRAGGemini 订阅席位'
  }
  if (environment.models_discovered !== true) return '尚未拉取模型，不能调度'
  if (!environment.models.length) return '未发现可调用模型'
  return null
}

type GeminiGroup =
  | 'off'
  | 'none'
  | 'bad'
  | 'restricted'
  | 'unschedulable'
  | 'pending'
  | 'host_failed'
  | 'host_verified'

/** Display only: host inference evidence is not a public scheduling gate. */
export function geminiAccountStatus(
  environment: Account,
  hostBlocker?: string | null
) {
  const { auth_state: auth } = environment
  const authorization: StatusTone = {
    key: auth,
    cls:
      auth === 'reauth_required' ? 'bad' : auth === 'disabled' ? 'off' : 'none',
    text: geminiAuthorizationLabel(environment),
  }
  const modelsLabel =
    environment.models_discovered !== true
      ? '尚未拉取模型'
      : environment.models.length
        ? `已发现 ${environment.models.length} 个模型`
        : '未发现可调用模型'
  const blocker = candidateBlocker(environment, hostBlocker)
  const inference = inferenceTone(environment)
  let group: GeminiGroup
  let tone = authorization
  switch (auth) {
    case 'disabled':
      group = 'off'
      break
    case 'reauth_required':
      group = 'bad'
      break
    case 'authorizing':
      group = 'pending'
      break
    case 'authorized':
      if (blocker) {
        group = 'unschedulable'
        tone = { key: group, cls: 'bad', text: blocker }
      } else if (environment.schedulable === false) {
        group = 'off'
        tone = { key: 'off', cls: 'off', text: '调度关' }
      } else if (
        environment.circuit &&
        environment.circuit.state !== 'closed'
      ) {
        group = 'restricted'
        tone =
          environment.circuit.state === 'open'
            ? { key: 'circuit', cls: 'bad', text: '熔断中' }
            : { key: 'circuit', cls: 'caution', text: '熔断探测' }
      } else if (
        environment.restriction &&
        (!environment.restriction.until ||
          environment.restriction.until > Date.now())
      ) {
        group = 'restricted'
        tone = {
          key: 'cool',
          cls: 'caution',
          text: environment.restriction.text || '冷却中',
        }
      } else if (inference.key === 'completed') {
        group = 'host_verified'
        tone = inference
      } else if (inference.key === 'failed') {
        group = 'host_failed'
        tone = inference
      } else {
        group = 'pending'
        tone = inference.key === 'running' ? inference : PENDING_TONE
      }
      break
    default:
      group = 'none'
  }
  return {
    authorization,
    modelsLabel,
    blocker,
    inference,
    lastInference: environment.last_inference,
    group,
    tone,
  }
}
