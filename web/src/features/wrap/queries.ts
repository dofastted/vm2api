import { queryOptions } from '@tanstack/react-query'
import type { CragLicenseStatus } from '@/types/panel-vm'
import { api } from '@/lib/api'

export type KernelId = 'cli-node' | 'crag'

export type KernelProduct = {
  id: KernelId
  name: string
  paid: boolean
  ready: boolean
  version: string | null
  updated_at: string | null
  code?: string
  error?: string
}

export type KernelInstallation = {
  kernel: KernelId
  version: string | null
  installed_at: string
}

export type KernelCatalog = {
  kernels: KernelProduct[]
  licenses: Record<string, CragLicenseStatus>
  installations?: Record<string, KernelInstallation>
}

export type KernelTarget = { id: string; kernel: KernelId }

export type KernelInstallItem = KernelTarget & {
  ok: boolean
  stopped: boolean
  restarted?: boolean
  schedulable?: boolean
  status?: string
  version?: string | null
  code?: string
  error?: string
}

export type KernelInstallReport = {
  ok: boolean
  total: number
  ok_count: number
  failed_count: number
  items: KernelInstallItem[]
}

export function kernelCatalogQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'kernels'] as const,
    queryFn: () => api<KernelCatalog>('/api/panel/kernels'),
  })
}

export function pullKernelRelease(body: { kernel: KernelId; tag?: string }) {
  return api<{
    kernel: KernelProduct
    release?: { tag: string; version: string; asset: string }
  }>('/api/panel/kernels/pull', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function installKernelTargets(targets: KernelTarget[]) {
  return api<KernelInstallReport>('/api/panel/kernels/install', {
    method: 'POST',
    body: JSON.stringify({ targets }),
  })
}

// Fleet actions outside /wrap still consume the existing runtime-sync report.
export type WrapSyncReport = {
  ok?: boolean
  src?: string
  meta?: {
    source?: string
    source_vm?: string
    captured_at?: string
    kernel?: string
    release_tag?: string
    glibc_shim?: boolean
    files?: string[]
  } | null
  total?: number
  ok_count?: number
  failed_count?: number
  items?: {
    id?: string
    ok?: boolean
    error?: string
    code?: string
    kernel?: { ok?: boolean; skipped?: boolean; error?: string }
  }[]
}
