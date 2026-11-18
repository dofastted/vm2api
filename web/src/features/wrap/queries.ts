import { queryOptions } from '@tanstack/react-query'
import type { CragLicenseStatus } from '@/types/panel-vm'
import { ApiError, api, isApiError } from '@/lib/api'

export type KernelId = 'cli-node' | 'crag'

export type KernelProduct = {
  id: KernelId
  name: string
  paid: boolean
  ready: boolean
  version: string | null
  release_tag?: string
  updated_at: string | null
  release_options?: { tag: string; label: string }[]
  payload_tag?: string
  code?: string
  error?: string
}

export type KernelInstallation = {
  kernel: KernelId
  version: string | null
  installed_at: string
  payload_tag?: string
}

export type KernelCatalog = {
  kernels: KernelProduct[]
  licenses: Record<string, CragLicenseStatus>
  installations?: Record<string, KernelInstallation>
}

export type KernelTarget = {
  id: string
  kernel: KernelId
  expected_tag?: string
  payload_tag?: string
}

export type KernelInstallItem = KernelTarget & {
  ok: boolean
  stopped: boolean
  restarted?: boolean
  rolled_back?: boolean
  reclaim_pending?: boolean
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

export function kernelVersionsQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'kernel-releases'] as const,
    queryFn: () =>
      api<Record<KernelId, string[]>>('/api/panel/kernels/releases'),
    staleTime: 5 * 60_000,
    retry: false,
  })
}

export function pullKernelRelease(body: { kernel: KernelId; tag?: string }) {
  return api<{
    kernel: KernelProduct
    release?: {
      tag: string
      version: string
      asset: string
      payload_tag?: string
    }
  }>('/api/panel/kernels/pull', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function installKernelTargets(targets: KernelTarget[]) {
  const endpoint = '/api/panel/kernels/install'
  const unknown = () =>
    new ApiError(
      '无法确认安装结果，请先核对槽位状态，不要重复提交。',
      0,
      'kernel_install_unconfirmed'
    )
  const receipt = await api<{ job_id?: string }>(endpoint, {
    method: 'POST',
    body: JSON.stringify({ targets, background: true }),
    signal: AbortSignal.timeout(15_000),
  }).catch((error: unknown) => {
    if (
      isApiError(error) &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408 &&
      error.status !== 499
    )
      throw error
    throw unknown()
  })
  if (!receipt?.job_id) throw unknown()
  const statusUrl = `${endpoint}?${new URLSearchParams({ job_id: receipt.job_id })}`
  const deadline = Date.now() + 15 * 60_000
  while (Date.now() < deadline) {
    const job = await api<{
      state: 'running' | 'completed' | 'unknown'
      report?: KernelInstallReport
    }>(statusUrl, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    }).catch((error: unknown) => {
      if (
        isApiError(error) &&
        error.status >= 400 &&
        error.status !== 408 &&
        error.status !== 429 &&
        error.status !== 499 &&
        error.status < 500
      )
        throw unknown()
      return null
    })
    if (job?.state === 'completed' && Array.isArray(job.report?.items))
      return job.report
    if (job && job.state !== 'running') throw unknown()
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw unknown()
}

/** Abandons one VM's in-flight install and frees the kernel cache for other VMs. */
export function cancelKernelInstall(id: string) {
  return api<{ id: string; kernel: string; phase: string }>(
    '/api/panel/kernels/install/cancel',
    { method: 'POST', body: JSON.stringify({ id }) }
  )
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
