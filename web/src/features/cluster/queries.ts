import { queryOptions } from '@tanstack/react-query'
import type {
  ClusterApiNode,
  ClusterLocalStatus,
  DockerContainer,
  DockerInfo,
  NodePreflight,
  SlotImageJob,
} from '@/types/panel-cluster'
import type { RuntimeType } from '@/types/panel-vm'
import { api } from '@/lib/api'

export const CLUSTER_NODES_KEY = ['panel', 'cluster', 'nodes'] as const

export function clusterNodesQueryOptions(refetchInterval = 5000) {
  return queryOptions({
    queryKey: CLUSTER_NODES_KEY,
    queryFn: () =>
      api<{ items: ClusterApiNode[] }>('/api/panel/cluster/nodes').then(
        (d) => d.items
      ),
    refetchInterval,
    refetchOnWindowFocus: false,
  })
}

export const CLUSTER_LOCAL_KEY = ['panel', 'cluster', 'local'] as const

/** 服务端缓存 30s；`refresh` 强制重新观测（两次远端 exec）。 */
export function clusterLocalQueryOptions() {
  return queryOptions({
    queryKey: CLUSTER_LOCAL_KEY,
    queryFn: () => api<ClusterLocalStatus>('/api/panel/cluster/local'),
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

export function dockerInfoQueryOptions(nodeId: string, enabled: boolean) {
  return queryOptions({
    queryKey: ['panel', 'cluster', nodeId, 'docker', 'info'] as const,
    queryFn: () =>
      api<DockerInfo>(`/api/panel/cluster/nodes/${nodeId}/docker/info`),
    enabled,
    retry: false,
  })
}

export function dockerContainersQueryOptions(nodeId: string, enabled: boolean) {
  return queryOptions({
    queryKey: ['panel', 'cluster', nodeId, 'docker', 'containers'] as const,
    queryFn: () =>
      api<{ items: DockerContainer[] }>(
        `/api/panel/cluster/nodes/${nodeId}/docker/containers`
      ).then((d) => d.items),
    enabled,
    refetchInterval: enabled ? 5000 : false,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

function nodePath(nodeId: string) {
  return `/api/panel/cluster/nodes/${encodeURIComponent(nodeId)}`
}

/**
 * 放置预检。服务端是 POST（要实际 SSH 过去跑检查），但语义是只读观测，
 * 按 节点 + 内核 缓存成 query；不自动轮询，由调用方手动 refetch。
 */
export function nodePreflightQueryOptions(
  nodeId: string,
  kernel: string,
  runtimeType: RuntimeType = 'docker'
) {
  return queryOptions({
    queryKey: [
      'panel',
      'cluster',
      nodeId,
      'preflight',
      kernel,
      runtimeType,
    ] as const,
    queryFn: () =>
      api<NodePreflight>(
        `${nodePath(nodeId)}/preflight`,
        jsonBody({ kernel, runtime_type: runtimeType })
      ),
    enabled: !!nodeId && !!kernel,
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

/** 构建中每 3s 轮询一次；done / failed / 无任务时停。 */
export function slotImageJobQueryOptions(
  nodeId: string,
  kernel: string,
  enabled: boolean
) {
  return queryOptions({
    queryKey: ['panel', 'cluster', nodeId, 'slot-image', kernel] as const,
    queryFn: () =>
      api<SlotImageJob | null>(
        `${nodePath(nodeId)}/slot-image?kernel=${encodeURIComponent(kernel)}`
      ),
    enabled: enabled && !!nodeId && !!kernel,
    refetchInterval: (query) =>
      query.state.data?.status === 'running' ? 3000 : false,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

export function startSlotImageBuild(
  nodeId: string,
  kernel: string,
  runtimeType: RuntimeType = 'docker'
) {
  return api<SlotImageJob>(
    `${nodePath(nodeId)}/slot-image`,
    jsonBody({ kernel, runtime_type: runtimeType })
  )
}

export function jsonBody(body: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) }
}
