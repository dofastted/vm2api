import { queryOptions } from '@tanstack/react-query'
import { ApiError, api, isApiError } from '@/lib/api'

const ROOT = '/api/panel/gemini/maintenance'

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
  | {
      action: 'diagnose' | 'install' | 'repair' | 'recover' | 'rollback'
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
}

type MaintenanceStatus =
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
