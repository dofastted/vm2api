import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/api'

export type WrapSampleMeta = {
  source?: string
  source_vm?: string
  captured_at?: string
  kernel?: string
  release_tag?: string
  glibc_shim?: boolean
  files?: string[]
}

export type WrapKernelPayload = {
  source?: 'configured' | 'sample' | 'missing' | string
  path?: string
  size?: number
  mtime?: string
}

export type WrapSample = {
  ok: boolean
  dir?: string
  kernel_bin?: boolean
  glibc_shim?: boolean
  wrapper?: boolean
  code?: string
  error?: string
  meta?: WrapSampleMeta | null
  kernel?: WrapKernelPayload | null
  cli_node?: WrapKernelPayload | null
  cc_node?: WrapKernelPayload | null
  crag?: (WrapKernelPayload & { ok?: boolean }) | null
  crag_v2?: (WrapKernelPayload & {
    ok?: boolean
    code?: string
    error?: string
    arch?: string
    version?: string
  }) | null
  dataplane?: 'wrap' | 'cc' | 'crag'
  written?: string[]
  sample_ok?: boolean
}

export type WrapSyncReport = {
  ok?: boolean
  src?: string
  meta?: WrapSampleMeta | null
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

export type WrapRepairReport = {
  wrap?: { ok?: boolean; dest?: string; error?: string }
  kernel?: { ok?: boolean; skipped?: boolean; reason?: string; error?: string }
}

export function wrapSampleQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'wrap-cli'] as const,
    queryFn: () => api<WrapSample>('/api/panel/wrap-cli'),
  })
}

export function syncWrapSample(
  body: { ids?: string[]; restart?: boolean } = {}
) {
  return api<WrapSyncReport>('/api/panel/wrap-cli/sync', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function makeWrapSample(body: { glibc_vm?: string } = {}) {
  const glibc_vm = String(body.glibc_vm || '').trim()
  return api<WrapSample>('/api/panel/wrap-cli/make', {
    method: 'POST',
    body: JSON.stringify(glibc_vm ? { glibc_vm } : {}),
  })
}

export function promoteWrapSample(id: string) {
  return api<WrapSample>(
    `/api/panel/vms/${encodeURIComponent(id)}/wrap-cli/promote`,
    { method: 'POST', body: JSON.stringify({}) }
  )
}

export function repairWrapSample(id: string) {
  return api<WrapRepairReport>(
    `/api/panel/vms/${encodeURIComponent(id)}/wrap-cli/repair`,
    { method: 'POST', body: JSON.stringify({}) }
  )
}

export type WrapReleaseUpdate = {
  release?: {
    tag?: string
    version?: string
    asset?: string
    size?: number
    cli_node?: string
    cli_node_size?: number
    cc_node?: string
    cc_node_size?: number
    crag?: string | null
    crag_size?: number
    crag_skipped?: boolean
  }
  kernel?: WrapSample
  sync?: WrapSyncReport
}

export function installReleaseKernel(
  body: { ids?: string[]; restart?: boolean } = {}
) {
  return api<WrapReleaseUpdate>('/api/panel/wrap-cli/kernel/release', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function uploadKernelBinary(file: Blob) {
  return api<WrapSample>('/api/panel/wrap-cli/kernel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  })
}

export function uploadCragKernelBinary(file: Blob) {
  return api<WrapSample>('/api/panel/wrap-cli/crag-kernel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  })
}

export function setKernelDataplane(body: {
  dataplane: 'wrap' | 'cc' | 'crag'
  ids?: string[]
  all?: boolean
  restart?: boolean
}) {
  return api<WrapSyncReport & { dataplane?: 'wrap' | 'cc' | 'crag' }>(
    '/api/panel/dataplane',
    {
      method: 'POST',
      body: JSON.stringify(body),
    }
  )
}

export type SlotPolicyReport = {
  updated?: number
  missing?: string[]
  failed?: { id?: string; code?: string; error?: string }[]
}

export function applySlotKernelPolicy(body: {
  ids: string[]
  dataplane: 'crag'
  crag_kernel_version: 'v2'
}) {
  return api<SlotPolicyReport>('/api/panel/vms/slot-policy', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
