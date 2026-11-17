import { useQuery, type QueryClient } from '@tanstack/react-query'
import type { ClusterApiNode } from '@/types/panel-cluster'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { nodeReachable } from '@/features/cluster/model'
import { clusterNodesQueryOptions } from '@/features/cluster/queries'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { cragHostStatusQueryOptions, vmsListQueryOptions } from './queries'

export type VmDeleteResult = {
  deleted: string
  reclaim_pending?: boolean
  /** 节点不可达时强制删除：节点上的容器没有清理。 */
  remote_teardown?: 'skipped'
}

/** 槽所在节点已不在列表里（missing）或连不上（offline）；本机槽、在线节点为 null。 */
export type NodeGone = 'missing' | 'offline'

export function nodeGoneOf(
  vm: Pick<Vm, 'node_id'> | null | undefined,
  nodes: ClusterApiNode[] | undefined
): NodeGone | null {
  const nodeId = vm?.node_id
  if (!nodeId || !nodes) return null
  const node = nodes.find((n) => n.id === nodeId)
  if (!node) return 'missing'
  return nodeReachable(node) ? null : 'offline'
}

/** 只在删除对话框打开（传入目标槽）时读节点列表。 */
export function useNodeGone(vm: Vm | null): NodeGone | null {
  const nodes = useQuery({
    ...clusterNodesQueryOptions(),
    enabled: !!vm?.node_id,
  })
  return nodeGoneOf(vm, nodes.data)
}

/** `force`：节点不可达，服务端复查后只删面板记录，不碰节点上的容器。 */
export function vmDeletePath(id: string, force = false): string {
  return `/api/panel/vms/${encodeURIComponent(id)}${force ? '?force=1' : ''}`
}

export async function completeVmDeletion(
  qc: QueryClient,
  result: VmDeleteResult,
  message = '已删除'
) {
  const notes = [
    result.reclaim_pending &&
      'CRAG 绑定额度待回收确认；旧订阅需先启用槽位回收。',
    result.remote_teardown === 'skipped' &&
      '节点不可达，节点上的容器没有清理。',
  ].filter(Boolean)
  if (notes.length) {
    toast.warning(message, { description: notes.join(' ') })
  } else {
    toast.success(message)
  }
  await Promise.all([
    qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
    qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
    qc.invalidateQueries({ queryKey: cragHostStatusQueryOptions().queryKey }),
  ])
}
