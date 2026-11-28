import { queryOptions } from '@tanstack/react-query'
import type {
  BackupConfigPayload,
  BackupsPayload,
  NotifyStatus,
} from '@/types/panel-routing'
import { api } from '@/lib/api'

export type ChangelogEntry = {
  version: string
  tag: string | null
  date: string | null
  heading: string
  title: string
  body: string
  bullets: string[]
  needs_wrap_cli_sync: boolean
}

export type ReleaseStatus = {
  current: string
  current_tag: string
  latest: string | null
  latest_tag: string | null
  update_available: boolean | null
  check_status: 'ok' | 'failed'
  html_url: string
  published_at: string | null
  name: string | null
  notes: string
  changelog: ChangelogEntry[]
  needs_wrap_cli_sync: boolean
  upgrade_command: string
  check_command: string
  repo: string
  source_error?: string | null
  started?: boolean
  target?: string
  command?: string
  message?: string
  upgrade?: {
    state: 'running' | 'succeeded' | 'failed'
    target: string
    exit_code: number | null
    log_command: string
  }
}

export type ChangelogPayload = {
  current: string
  current_tag: string
  entries: ChangelogEntry[]
}

export function routingQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'routing'] as const,
    queryFn: () => api<Record<string, unknown>>('/api/panel/routing'),
  })
}

export function notifyQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'notify'] as const,
    queryFn: () => api<NotifyStatus>('/api/panel/notify'),
  })
}

export function backupsQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'backups'] as const,
    queryFn: () => api<BackupsPayload>('/api/panel/backups'),
  })
}

export function backupConfigQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'backups-config'] as const,
    queryFn: () => api<BackupConfigPayload>('/api/panel/backups/config'),
  })
}

export function fetchVersionStatus(opts?: { refresh?: boolean }) {
  return api<ReleaseStatus>(
    opts?.refresh ? '/api/panel/version?refresh=1' : '/api/panel/version'
  )
}

export function versionQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'version'] as const,
    queryFn: () => fetchVersionStatus(),
    staleTime: 60_000,
  })
}

export function changelogQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'changelog'] as const,
    queryFn: () => api<ChangelogPayload>('/api/panel/changelog'),
    staleTime: 60_000,
  })
}

export type HealthProbePlatform = 'anthropic' | 'openai' | 'google'

export type HealthCatalogModel = {
  id: string
  label: string
  family?: string
  online?: boolean
  probe_id?: string
}

export type HealthModelSnapshotView = {
  ok: boolean
  at: string | null
  stale: boolean
  vm_id: string | null
  model: string | null
  message_id?: string | null
  text?: string | null
  status?: number
  error: string | null
  last_error?: string | null
  last_failed_at?: string | null
  duration_ms?: number | null
  age_ms: number | null
  next_at?: string | null
  cache_ttl_sec?: number
}

export type HealthSnapshotView = HealthModelSnapshotView & {
  platform?: HealthProbePlatform
  enabled?: boolean
  all_models?: boolean
  probing?: boolean
  total_models?: number
  ok_models?: number
  failed_models?: number
  stale_models?: number
  models?: HealthModelSnapshotView[]
}

export type HealthProbePayload = {
  config: Record<string, unknown>
  snapshot: HealthSnapshotView | null
  snapshots: {
    anthropic: HealthSnapshotView
    openai: HealthSnapshotView
    google?: HealthSnapshotView
    gemini?: HealthSnapshotView
  } | null
  catalog?: Partial<Record<HealthProbePlatform, HealthCatalogModel[]>>
}

export function healthProbeQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'health-probe'] as const,
    queryFn: () => api<HealthProbePayload>('/api/panel/health-probe'),
    refetchInterval: 30_000,
  })
}

export function runHealthProbe(
  platform: 'all' | HealthProbePlatform | 'gemini' = 'all',
  model?: string
) {
  return api<HealthProbePayload>('/api/panel/health-probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      platform,
      ...(model ? { model } : {}),
    }),
  })
}

/** `GET /api/panel/outbound-profile` → `src/lib/admin/outbound-profile.mjs`. */
export type OutboundProfile = {
  preset: string
  cli_version: string
  user_agent: string
  cc_entrypoint: string
  anthropic_beta: string
  beta_sample_model: string
}

export function outboundProfileQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'outbound-profile'] as const,
    queryFn: () =>
      api<{ profile: OutboundProfile }>('/api/panel/outbound-profile'),
  })
}

export type GeminiShmRingStats = {
  requests_total: number
  responses_total: number
  request_bytes_total: number
  response_bytes_total: number
  crc_errors_total: number
  backpressure_waits_total: number
}

export type GeminiDaemonShardView = {
  shard_id: string
  kind: 'shard' | 'per_account'
  alive: boolean
  ready: boolean
  pid: number | null
  capacity: number
  account_count: number
  account_ids: string[]
  active_slots: number
  idle_slots: number
  total_slots: number
  circuit_open_accounts: number
  shm_enabled: boolean
  shm_ring_stats: GeminiShmRingStats | null
  fault_isolated: boolean
  restart_count: number
}

export type GeminiDaemonStatus = {
  available: boolean
  host_error?: string
  host_message?: string
  mode?: 'sharded' | 'per_account'
  accounts_per_daemon?: number
  daemon_fault_isolation?: boolean
  planned_shards?: number
  authorized_oauth_accounts?: number
  total_accounts?: number
  total_active_slots?: number
  total_idle_slots?: number
  shm_ring_stats?: GeminiShmRingStats | null
  shards: GeminiDaemonShardView[]
}

export function geminiDaemonStatusQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'gemini', 'daemon-status'] as const,
    queryFn: () => api<GeminiDaemonStatus>('/api/panel/gemini/daemon-status'),
    refetchInterval: 15_000,
  })
}
