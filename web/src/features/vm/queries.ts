import { queryOptions } from '@tanstack/react-query'
import type {
  OfficialCcBootstrapPayload,
  SetupTokenSession,
  TestModelsPayload,
  VmCreateOptions,
  VmCredentialResponse,
  VmDetailPayload,
  VmSeedSettings,
  VmsListResponse,
} from '@/types/panel-vm'
import type { VmKernelSwitchJob } from '@/lib/api'
import { ApiError, api, getVmCragLicense, getVmKernelSwitch } from '@/lib/api'

/** 创建表单默认规格 + 本机 KVM 能力。ACL 与 POST /vms/create 相同，租户可读。 */
export function vmCreateOptionsQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'vms', 'create-options'] as const,
    queryFn: () => api<VmCreateOptions>('/api/panel/vms/create-options'),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

export function vmsListQueryOptions(refetchInterval?: number) {
  return queryOptions({
    queryKey: ['panel', 'vms'] as const,
    queryFn: async () => {
      const data = await api<VmsListResponse>('/api/panel/vms')
      return { items: data.items || [], pool_queue: data.pool_queue }
    },
    ...(refetchInterval
      ? { refetchInterval, refetchOnWindowFocus: false }
      : {}),
  })
}

export function vmQueryOptions(id: string) {
  return queryOptions({
    queryKey: ['panel', 'vm', id] as const,
    queryFn: () =>
      api<VmDetailPayload>(`/api/panel/vms/${encodeURIComponent(id)}`),
  })
}

export type CragRuntimeVm = {
  state: 'running' | 'not_running' | 'unknown'
  ready: boolean
  quota_blocked?: true
  scope: 'host' | 'independent' | 'unknown'
  version: string | null
  active_requests: number | null
  queued: number | null
  ready_slots: number | null
}

export type CragRuntime = {
  running_vms: number
  ready_vms: number
  unknown_vms: number
  host_running_vms: number
  host_unknown_vms: number
  host_runtime_available: number | 'unlimited' | null
  host_over_limit: boolean | null
  checked_at: string
  vms: Record<string, CragRuntimeVm>
}

export type CragHostStatus = {
  ready: boolean
  target_probe_failed?: true
  state: 'unavailable' | 'unredeemed' | 'active' | 'expired' | 'sync_pending'
  slot_limit?: number | 'unlimited'
  expires_at?: number
  revision?: number
  sku?: string
  months?: number
  used_slots?: number
  vm_count?: number
  total_slots?: number
  enabled_slots?: number
  activated_slots?: Array<{
    vm_id: string
    scope: 'host' | 'device' | 'kernel'
    expires_at: number
  }>
  available_slots?: number | null
  available_seats?: number | 'unlimited' | null
  reclaim_pending_count?: number
  reclaim_supported?: boolean
  upgrade_available?: boolean
  runtime?: CragRuntime
}

export function cragHostStatusQueryOptions() {
  return queryOptions({
    queryKey: ['crag-host-subscription'] as const,
    queryFn: ({ signal }) =>
      api<CragHostStatus>('/api/panel/crag-subscription', { signal }),
    retry: false,
  })
}

export function vmCragLicenseQueryOptions(id: string) {
  return queryOptions({
    queryKey: ['panel', 'vm', id, 'crag-license'] as const,
    queryFn: () => getVmCragLicense(id),
    staleTime: 0,
    retry: false,
  })
}

export function vmKernelSwitchQueryOptions(id: string) {
  const queryKey = ['panel', 'vm-kernel-switch', id] as const
  return queryOptions({
    queryKey,
    queryFn: async ({ client, queryKey, signal }) => {
      const previous = client.getQueryData<VmKernelSwitchJob | null>(queryKey)
      const job = await getVmKernelSwitch(id, signal)
      if (!job && previous?.status === 'running') {
        throw new ApiError(
          '切换任务记录已丢失，操作可能已中断（控制面可能已重启）。请核对 VM 实际状态。',
          0,
          'kernel_switch_interrupted'
        )
      }
      return job
    },
    refetchInterval: (query) =>
      query.state.status !== 'error' && query.state.data?.status === 'running'
        ? 2000
        : false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  })
}

export function vmSeedQueryOptions(id: string) {
  return queryOptions({
    queryKey: ['panel', 'vm', id, 'seed'] as const,
    queryFn: () =>
      api<VmSeedSettings>(
        `/api/panel/vms/${encodeURIComponent(id)}/seed-settings`
      ),
    refetchInterval: false,
  })
}

/** Upload audit lines only — does not share the seed form query key. */
export function vmSeedUploadLogQueryOptions(id: string) {
  return queryOptions({
    queryKey: ['panel', 'vm', id, 'seed-upload-log'] as const,
    queryFn: async () => {
      const data = await api<VmSeedSettings>(
        `/api/panel/vms/${encodeURIComponent(id)}/seed-settings?debug=1`
      )
      if (data.telemetry_log_error) {
        throw new Error('所在 VM 的原生计数记录暂不可读取')
      }
      const lines = data.telemetry_log
      return Array.isArray(lines)
        ? lines.filter(
            (line): line is string => typeof line === 'string' && line !== ''
          )
        : []
    },
    refetchInterval: false,
  })
}

export function vmCredentialQueryOptions(id: string, enabled = true) {
  return queryOptions({
    queryKey: ['panel', 'vm', id, 'credential'] as const,
    queryFn: () =>
      api<VmCredentialResponse>(
        `/api/panel/vms/${encodeURIComponent(id)}/oauth/credential`
      ),
    enabled,
    gcTime: 0,
    staleTime: 0,
  })
}

export function testModelsQueryOptions(vmId: string) {
  return queryOptions({
    queryKey: ['panel', 'test-models', vmId || ''] as const,
    queryFn: () => {
      const q = vmId ? `?vm_id=${encodeURIComponent(vmId)}` : ''
      return api<TestModelsPayload>(`/api/panel/test-models${q}`)
    },
    enabled: !!vmId,
  })
}

export function setupTokenSessionQueryOptions(id: string, enabled = true) {
  return queryOptions({
    queryKey: ['panel', 'vm', id, 'setup-token-session'] as const,
    queryFn: () =>
      api<SetupTokenSession>(
        `/api/panel/vms/${encodeURIComponent(id)}/oauth/setup-token-session`
      ),
    enabled: enabled && !!id,
    staleTime: 10_000,
    retry: false,
  })
}

export function officialCcBootstrapQueryOptions(id: string, enabled = true) {
  return queryOptions({
    queryKey: ['panel', 'official-cc-bootstrap', id] as const,
    queryFn: () =>
      api<OfficialCcBootstrapPayload>(
        `/api/panel/vms/${encodeURIComponent(id)}/official-cc-bootstrap`
      ),
    enabled,
    refetchInterval: (query) =>
      query.state.data?.status?.status === 'running' ? 2500 : false,
  })
}

export function vmOfficialCcQueryOptions(id: string) {
  return queryOptions({
    queryKey: ['panel', 'vm', id, 'official-cc'] as const,
    queryFn: async () => {
      const response = await api<OfficialCcBootstrapPayload>(
        `/api/panel/vms/${encodeURIComponent(id)}/official-cc-bootstrap`
      )
      return response.status || null
    },
    refetchInterval: (query) =>
      query.state.data?.status === 'running' ? 2500 : false,
  })
}

export type VmHealthRange = '24h' | '7d'

export type VmHealthPayload = {
  range: VmHealthRange
  slot_min: number
  start: string
  buckets: Array<[number, number]> | null
  top_errors: Array<{
    code: string
    status: number | null
    count: number
    last_at: string
  }>
}

/** 展开明细的请求健康：按需取，30 秒内复用。 */
export function vmHealthQueryOptions(id: string, range: VmHealthRange) {
  return queryOptions({
    queryKey: ['panel', 'vm', id, 'health', range] as const,
    queryFn: () =>
      api<VmHealthPayload>(
        `/api/panel/vms/${encodeURIComponent(id)}/health?range=${range}`
      ),
    staleTime: 30_000,
  })
}
