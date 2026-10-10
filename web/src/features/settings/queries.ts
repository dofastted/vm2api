import { queryOptions } from '@tanstack/react-query'
import type { BackupsPayload, NotifyStatus } from '@/types/panel-routing'
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
  latest: string
  latest_tag: string
  update_available: boolean
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
    queryFn: () => api<Record<string, unknown>>('/api/panel/backups/config'),
  })
}

export function versionQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'version'] as const,
    queryFn: () => api<ReleaseStatus>('/api/panel/version'),
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

export type HealthSnapshotView = {
  ok: boolean
  at: string | null
  stale: boolean
  vm_id: string | null
  model: string | null
  error: string | null
  age_ms: number | null
}

export type HealthProbePayload = {
  config: Record<string, unknown>
  snapshot: HealthSnapshotView | null
  snapshots: {
    anthropic: HealthSnapshotView
    openai: HealthSnapshotView
  } | null
}

export function healthProbeQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'health-probe'] as const,
    queryFn: () => api<HealthProbePayload>('/api/panel/health-probe'),
    refetchInterval: 30_000,
  })
}
