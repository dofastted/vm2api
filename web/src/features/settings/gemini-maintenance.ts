import { queryOptions } from '@tanstack/react-query'
import { ApiError, api, isApiError } from '@/lib/api'

const ROOT = '/api/panel/gemini/maintenance'

export const GEMINI_LOCAL_PREPARE_COMMAND =
  'sudo bash /opt/vm2api/deploy/install.sh prepare-gemini --dir /opt/vm2api'

export const GEMINI_INSTALL_COMMAND =
  'curl -fsSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install-gemini.sh | sudo bash -s -- --dir /opt/vm2api'

export const geminiCheckLabels: Record<string, string> = {
  platform: '宿主机架构',
  systemd: 'systemd 服务管理',
  runtime_service: 'Gemini 运行服务',
  maintenance: '维护状态完整性',
  signed_payload: 'CRAGGemini 签名载荷',
  pinned_egress: '固定出口代理（kin-egress）',
  runtime_tools: '运行工具依赖',
  ipv4_forwarding: 'IPv4 转发',
  sandbox: '非特权沙箱（bwrap / AppArmor）',
  google_qualification: 'Google 账号资格与真实推理',
  runtime: '运行环境',
}

export const geminiPayloadLabels: Record<string, string> = {
  installed: '已安装',
  invalid: '校验失败',
  missing: '未安装',
  not_installed: '未安装',
  not_configured: '未安装',
  awaiting_redemption: '等待兑换',
  unknown: '未知',
  unverified: '正在验证',
}

export const geminiPhaseLabels: Record<string, string> = {
  queued: '等待执行',
  checking: '检查宿主',
  dependencies: '准备宿主依赖',
  diagnosing: '诊断宿主',
  fetching: '下载签名载荷',
  preparing_runtime: '准备运行文件',
  restoring: '恢复未完成的维护',
  downloading: '下载签名载荷',
  verifying: '验证载荷',
  applying: '应用变更',
  starting: '启动 Gemini 服务',
  installing: '安装运行环境',
  restarting: '重启 Gemini 服务',
  completed: '执行完成',
  failed: '执行失败',
}

const MAINTENANCE_ERROR_LABELS: Record<string, string> = {
  gemini_maintenance_busy:
    '宿主仍有进行中的 Gemini 授权、终端、推理或维护任务，请空闲后重试',
  gemini_maintenance_unavailable:
    '宿主机维护服务未启动或 socket 不存在，请先执行宿主机初始化',
  gemini_maintenance_denied:
    '控制面无权访问 Gemini 维护服务 socket，请检查用户组或挂载权限',
  gemini_maintenance_timeout: '连接宿主机 Gemini 维护服务超时',
  gemini_maintenance_transport_error: '与宿主机 Gemini 维护服务通信失败',
  gemini_maintenance_protocol_error: '维护服务返回了无法解析的响应',
  gemini_maintenance_unsupported_platform:
    '当前宿主机平台不受支持，仅支持 Linux amd64',
  gemini_maintenance_unsupported_host: 'CRAGGemini 仅支持 Linux amd64 宿主机',
  gemini_payload_unsupported_host:
    '当前宿主机架构不受支持（仅支持 Linux amd64）',
  gemini_maintenance_invalid_socket: 'Gemini 维护服务 socket 路径配置无效',
  gemini_maintenance_invalid_request: '维护请求参数无效',
  gemini_maintenance_invalid_action: '不支持的维护操作类型',
  gemini_maintenance_invalid_release: '目标签名版本标识无效',
  gemini_maintenance_forbidden: '维护服务拒绝访问',
  gemini_maintenance_not_found: '维护服务接口不存在',
  gemini_maintenance_method_not_allowed: '维护服务不支持该请求方法',
  gemini_maintenance_request_timeout: '维护请求超时',
  gemini_maintenance_body_too_large: '维护请求体过大',
  gemini_maintenance_headers_too_large: '维护请求头过大',
  gemini_maintenance_unsupported_media_type: '维护请求格式不受支持',
  gemini_maintenance_snapshot_too_large: '维护状态快照超出大小限制',
  gemini_maintenance_failed: '宿主机维护操作失败',
  gemini_maintenance_operation_failed: '宿主机执行维护操作时出错',
  gemini_maintenance_systemd_unavailable:
    '宿主机 systemd 不可用，无法管理 Gemini 服务',
  gemini_maintenance_service_inactive:
    'Gemini 运行服务（vm2api-gemini.service）当前未运行',
  gemini_maintenance_service_start_failed:
    'Gemini 服务启动失败，已自动恢复原版本',
  gemini_maintenance_incomplete:
    '检测到上次未完成的维护事务，请执行「修复安装」或「恢复推理环境」',
  gemini_maintenance_lock_invalid:
    '维护锁文件属主或权限异常，请联系宿主机管理员修复',
  gemini_maintenance_journal_invalid: '维护事务日志损坏，请由宿主机管理员核查',
  gemini_maintenance_egress_unverified: '尚未完成固定出口（kin-egress）校验',
  gemini_maintenance_egress_invalid:
    '固定出口（kin-egress）文件缺失或校验不通过',
  gemini_maintenance_egress_pin_mismatch:
    '宿主 kin-egress 摘要与发行清单不一致，请先更新控制面与宿主维护服务',
  gemini_maintenance_ipv4_forwarding_disabled:
    '宿主机未开启 IPv4 转发（net.ipv4.ip_forward=0）',
  gemini_sandbox_apparmor_restricted:
    '宿主机 AppArmor 限制了非特权 user namespace，导致 Gemini 沙箱无法启动；请执行「修复安装」或在宿主机运行 prepare-gemini',
  gemini_sandbox_unavailable:
    '宿主机非特权沙箱（bwrap）不可用，请检查宿主机 bubblewrap、内核 userns 配置与服务日志',
  gemini_maintenance_sandbox_unverified: '尚未完成非特权沙箱（bwrap）实测检查',
  gemini_maintenance_apparmor_unavailable:
    '宿主机启用了 AppArmor userns 限制，但缺少 apparmor_parser、ABI 4.0 或 apparmor.service 未加载',
  gemini_maintenance_apparmor_policy_conflict:
    '检测到非 vm2api 托管的 /etc/apparmor.d/vm2api-gemini 策略或符号链接，拒绝覆盖',
  gemini_maintenance_apparmor_load_failed:
    '加载 vm2api-gemini AppArmor 策略失败，请检查宿主机 AppArmor 状态与日志',
  gemini_maintenance_apparmor_load_failed_timeout:
    '加载 vm2api-gemini AppArmor 策略超时，请检查宿主机 AppArmor 状态与日志',
  gemini_maintenance_google_not_tested:
    '本地自检不含 Google 账号资格与真实推理，请在下方手动试聊验证',
  gemini_oauth_tools_missing:
    '宿主机缺少必需运行工具（node/ip/nft/setpriv/bwrap/curl/openvt 等）',
  gemini_release_redemption_required: '当前签名版本需要完成 CRAG 兑换激活',
  gemini_maintenance_downgrade_blocked:
    '目标版本低于当前已安装版本，不会自动降级；如需退回上一版请使用回滚',
  gemini_maintenance_unknown_release:
    '当前宿主维护服务不支持所选版本，请先在宿主机更新维护服务（prepare-gemini）',
  gemini_maintenance_repair_release_unknown:
    '无法识别当前已安装载荷对应的发行版本',
  gemini_maintenance_fetch_failed:
    '下载 CRAGGemini 签名载荷失败，请检查宿主机网络与 GitHub 连通性后重试',
  gemini_maintenance_payload_invalid:
    'CRAGGemini 签名载荷校验失败，原版本未改动',
  gemini_maintenance_payload_incomplete: 'CRAGGemini 签名载荷文件不完整',
  gemini_maintenance_payload_changed: '检测到签名载荷文件在验证后发生变更',
  gemini_maintenance_payload_unverified: '签名载荷尚未完成验证',
  gemini_maintenance_payload_pin_mismatch:
    '下载内容与宿主机可信公钥或校验摘要不匹配，原版本未改动',
  gemini_maintenance_release_payload_mismatch:
    '发行清单与目标版本号不匹配，原版本未改动',
  gemini_maintenance_update_requires_valid_payload:
    '当前尚未安装有效的 CRAGGemini 载荷，请先执行安装',
  gemini_maintenance_cli_incompatible:
    '所选 CLI 版本与当前已安装原生组件不兼容',
  gemini_cli_incompatible: '所选 CLI 版本与当前已安装原生组件不兼容',
  gemini_maintenance_rollback_invalid: '上一版本备份无效或缺失，无法回滚',
  gemini_maintenance_default_trust_conflict:
    '默认信任配置存在冲突，请检查宿主机维护配置',
  gemini_maintenance_unsupported_service_config:
    '检测到自定义 Gemini systemd 配置，维护服务拒绝覆盖；请先由宿主管理员迁移',
  gemini_maintenance_dependencies_missing:
    '宿主机缺少运行工具，请先补齐依赖后再试',
  gemini_maintenance_dependencies_failed:
    '宿主机依赖安装失败，请检查包管理器与网络',
  gemini_maintenance_manual_source_required:
    '检测到手动信任配置，请通过宿主机命令管理该载荷源',
  gemini_maintenance_manual_source_configured:
    '当前配置了手动载荷源，不能按版本目录覆盖',
  gemini_maintenance_runtime_unreachable:
    '无法联系运行中的 Gemini 宿主服务，请先检查 vm2api-gemini.service',
  gemini_maintenance_atomic_exchange_unavailable:
    '宿主机文件系统不支持原子替换操作',
  gemini_maintenance_atomic_exchange_failed:
    '原子切换运行目录失败，原版本未改动',
  maintenance_endpoint_missing: '控制面未提供 Gemini 维护接口，请先升级控制面',
}

const UNCERTAIN_SUBMIT_CODES = new Set([
  'gemini_maintenance_timeout',
  'gemini_maintenance_transport_error',
  'gemini_maintenance_request_timeout',
])

export function geminiMaintenanceCodeLabel(
  code?: string | null
): string | null {
  if (!code) return null
  return MAINTENANCE_ERROR_LABELS[code] || null
}

export function geminiMaintenanceErrorMessage(code?: string | null) {
  if (!code)
    return '宿主未返回错误代码，请前往「设置 → Gemini 维护」查看诊断结果。'
  const label = geminiMaintenanceCodeLabel(code)
  return label
    ? `${label}。`
    : `操作失败（${code}），请前往「设置 → Gemini 维护」查看诊断结果。`
}

export type MaintenanceSubmitErrorView = {
  kind: 'rejected' | 'uncertain'
  title: string
  detail: string
  code: string
}

export function classifyMaintenanceSubmitError(
  error: unknown
): MaintenanceSubmitErrorView {
  const code = isApiError(error) ? error.code : ''
  const label = geminiMaintenanceCodeLabel(code)
  const uncertain =
    !isApiError(error) ||
    error.status === 0 ||
    error.status === 408 ||
    error.status === 502 ||
    error.status === 504 ||
    UNCERTAIN_SUBMIT_CODES.has(code)
  if (uncertain) {
    return {
      kind: 'uncertain',
      title: '未能确认任务已提交',
      detail: label
        ? `${label}。请先刷新并查看最新任务状态，确认未重复执行后再试。`
        : '网络中断或请求超时，请先刷新并查看最新任务状态，确认未重复执行后再试。',
      code,
    }
  }
  const deterministic =
    (error.status >= 400 && error.status < 500) || error.status === 503
  const reason =
    label ||
    (error.message && error.message !== code
      ? error.message
      : '服务端拒绝了此次操作')
  if (deterministic) {
    return {
      kind: 'rejected',
      title: `任务未提交：${reason}`,
      detail:
        code === 'gemini_maintenance_busy'
          ? '宿主当前有进行中的任务，请等待授权、终端、推理或维护任务结束后再重试。'
          : '服务端已明确拒绝本次维护请求，不会启动后台任务。',
      code,
    }
  }
  return {
    kind: 'uncertain',
    title: '未能确认任务已提交',
    detail: `${reason}。请先刷新查看最新任务状态。`,
    code,
  }
}

export function geminiReleaseVersionLabel(tag?: string | null) {
  if (!tag) return ''
  const match = /-gemini-(\d+\.\d+\.\d+(?:-rc\.\d+)?)$/.exec(tag)
  return match?.[1] || tag
}

function parseGeminiVersionTuple(
  value?: string | null
): [number, number, number, number, number] | null {
  const match = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-rc\.(\d{1,9}))?$/.exec(
    String(value || '').trim()
  )
  if (!match) return null
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    match[4] ? 0 : 1,
    match[4] ? Number(match[4]) : 0,
  ]
}

export function compareGeminiVersions(
  left?: string | null,
  right?: string | null
): number | null {
  const a = parseGeminiVersionTuple(left)
  const b = parseGeminiVersionTuple(right)
  if (!a || !b) return null
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

export const maintenanceActionLabels = {
  diagnose: '诊断宿主',
  install: '安装运行环境',
  repair: '修复安装',
  recover: '恢复推理环境',
  update_cli: '仅更新 CLI',
  update_native: '更新 CRAGGemini',
  rollback: '回滚上一版',
} as const

type MaintenanceAction = keyof typeof maintenanceActionLabels

export type MaintenanceRequest =
  | { action: 'update_cli' | 'update_native'; release_id: string }
  | { action: 'install'; release_id?: string }
  | {
      action: 'diagnose' | 'repair' | 'recover' | 'rollback'
      release_id?: never
    }

export type MaintenanceRelease = {
  id: string
  version: string
  cli_version: string
  installed: boolean
  compatible: boolean
}

export type MaintenanceSnapshot = {
  available: true
  install_dir: string | null
  service: { installed: boolean; active: boolean }
  payload: {
    state: string
    version: string | null
    cli_version: string | null
    activation_required: boolean
    issue: string | null
  }
  releases: MaintenanceRelease[]
  rollback: { available: boolean; version: string | null }
  checks: {
    id: string
    state: 'pass' | 'fail' | 'warning'
    code: string | null
  }[]
  job: {
    id: string
    action: MaintenanceAction
    status: 'running' | 'completed' | 'failed'
    phase: string
    error_code: string | null
    started_at: string
    finished_at: string | null
  } | null
  supports_remote_releases?: boolean
}

export type MaintenanceStatus =
  | MaintenanceSnapshot
  | { available: false; bootstrap_required: boolean; code: string }

export const maintenanceQueryOptions = queryOptions({
  queryKey: ['panel', 'gemini-maintenance'] as const,
  queryFn: async ({ signal }): Promise<MaintenanceStatus> => {
    try {
      const status = await api<MaintenanceStatus>(ROOT, {
        signal,
        cache: 'no-store',
      })
      if (status?.available === true || status?.available === false)
        return status
      throw new ApiError('维护接口返回了无法识别的状态。', 502)
    } catch (error) {
      if (isApiError(error) && error.status === 404) {
        return {
          available: false,
          bootstrap_required: true,
          code: 'maintenance_endpoint_missing',
        }
      }
      throw error
    }
  },
  networkMode: 'always',
  retry: false,
  refetchInterval: (query) => {
    const status = query.state.data
    return status?.available &&
      (status.job?.status === 'running' ||
        status.payload.state === 'unverified')
      ? 1500
      : false
  },
})

export async function startMaintenance({
  action,
  release_id,
}: MaintenanceRequest) {
  const snapshot = await api<MaintenanceSnapshot>(`${ROOT}/jobs`, {
    method: 'POST',
    body: JSON.stringify(release_id ? { action, release_id } : { action }),
  })
  if (
    snapshot?.available !== true ||
    !snapshot.job ||
    snapshot.job.action !== action
  ) {
    throw new ApiError('维护接口未返回此操作的任务状态。', 502)
  }
  return snapshot
}
