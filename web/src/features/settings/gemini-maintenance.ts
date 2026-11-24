import { queryOptions } from '@tanstack/react-query'
import { ApiError, api, isApiError } from '@/lib/api'

const ROOT = '/api/panel/gemini/maintenance'

export const GEMINI_INSTALL_COMMAND =
  'curl -fsSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install-gemini.sh | sudo bash -s -- --dir /opt/vm2api'

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
    '宿主仍有进行中的 Gemini 授权、终端、推理或维护任务，请空闲后重试。',
  gemini_maintenance_downgrade_blocked:
    '目标版本低于当前已安装版本，不会自动降级；如需退回上一版请使用回滚。',
  gemini_maintenance_unknown_release:
    '当前宿主维护服务不支持所选版本，请先在宿主机更新维护服务（prepare-gemini）。',
  gemini_maintenance_fetch_failed:
    '下载 CRAGGemini 签名载荷失败，请检查宿主机网络与 GitHub 连通性后重试。',
  gemini_maintenance_payload_invalid:
    'CRAGGemini 签名载荷校验失败，原版本未改动。',
  gemini_maintenance_payload_pin_mismatch:
    '下载内容与宿主机可信公钥或校验摘要不匹配，原版本未改动。',
  gemini_maintenance_release_payload_mismatch:
    '发行清单与目标版本号不匹配，原版本未改动。',
  gemini_maintenance_update_requires_valid_payload:
    '当前尚未安装有效的 CRAGGemini 载荷，请先执行安装。',
  gemini_maintenance_service_start_failed:
    'Gemini 服务启动失败，已自动恢复原版本；请前往「设置 → Gemini 维护」诊断。',
  gemini_maintenance_unsupported_host: 'CRAGGemini 仅支持 Linux amd64 宿主机。',
  gemini_maintenance_unsupported_service_config:
    '检测到自定义 Gemini systemd 配置，维护服务拒绝覆盖；请先由宿主管理员迁移。',
  gemini_maintenance_dependencies_missing:
    '宿主机缺少运行工具，请先补齐依赖后再试。',
  gemini_maintenance_dependencies_failed:
    '宿主机依赖安装失败，请检查包管理器与网络。',
  gemini_maintenance_manual_source_required:
    '检测到手动信任配置，请通过宿主机命令管理该载荷源。',
  gemini_maintenance_manual_source_configured:
    '当前配置了手动载荷源，不能按版本目录覆盖。',
  gemini_maintenance_egress_pin_mismatch:
    '宿主 kin-egress 摘要与发行清单不一致，请先更新控制面与宿主维护服务。',
  gemini_maintenance_runtime_unreachable:
    '无法联系运行中的 Gemini 宿主服务，请先检查 vm2api-gemini.service。',
}

export function geminiMaintenanceErrorMessage(code?: string | null) {
  if (!code)
    return '宿主未返回错误代码，请前往「设置 → Gemini 维护」查看诊断结果。'
  return (
    MAINTENANCE_ERROR_LABELS[code] ||
    `操作失败（${code}），请前往「设置 → Gemini 维护」查看诊断结果。`
  )
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
