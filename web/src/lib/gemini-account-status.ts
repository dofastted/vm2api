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

type Account = Authorization &
  InferenceEvidence & {
    models_discovered?: boolean
    models: readonly string[]
    proxy_ready?: boolean
    crag_license?: CragLicense | null
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
  gemini_location_unsupported: 'Google 地区资格受限',
  gemini_account_verification_required: 'Google 账号需先完成浏览器验证',
  gemini_account_ineligible: 'Google 账号不符合 Antigravity 资格',
  gemini_proxy_error: '代理连接错误',
  gemini_proxy_unavailable: '代理不可用',
  gemini_model_unavailable: '模型不可用',
  gemini_models_empty: '没有可调用模型',
  gemini_oauth_required: '该次请求需重新授权',
  gemini_api_key_invalid: '该次请求的 API Key 被拒绝',
  gemini_api_key_rejected: '该次请求的 API Key 被拒绝',
  gemini_quota_exhausted: '额度用尽',
  gemini_inference_timeout: '请求超时',
  gemini_inference_bad_input: '推理输入不受支持',
  gemini_inference_invalid_output: '响应无法解析',
  gemini_inference_output_limit: '响应超过长度限制',
  gemini_inference_tool_blocked: '不支持工具调用',
  license_required: '未绑定 CRAGGemini 订阅席位',
  license_expired: 'CRAGGemini 订阅许可已过期',
  license_not_yet_valid: 'CRAGGemini 许可尚未生效',
  license_invalid: 'CRAGGemini 许可无效',
  license_binding_mismatch: 'CRAGGemini 许可绑定不匹配',
  license_unconfigured: 'CRAGGemini 订阅未配置',
}

export function geminiInferenceErrorLabel(code?: string | null): string {
  if (
    code &&
    Object.prototype.hasOwnProperty.call(INFERENCE_ERROR_LABELS, code)
  )
    return INFERENCE_ERROR_LABELS[code]
  return isGeminiHostIssue(code) ? '宿主运行环境故障' : '未知原因'
}

const PENDING_TONE: StatusTone = { key: 'pending', cls: 'none', text: '待验证' }

function candidateBlocker(
  environment: Account,
  hostBlocker?: string | null
): string | null {
  if (environment.auth_state !== 'authorized') return null
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
