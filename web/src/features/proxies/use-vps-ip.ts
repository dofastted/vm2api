import type { VmProxySnap } from '@/types/panel-vm'
import { proxyIsLocal, proxyMatchesNode } from './proxy-sort'

/** 只展示实测出口 IP；节点 SSH 地址不等于公网出口。 */
export function useVpsIp(
  nodeId: string | null | undefined,
  pool: VmProxySnap[]
): string | null {
  const local = pool.find((p) => proxyIsLocal(p) && proxyMatchesNode(p, nodeId))
  if (nodeId && !local?.view_id) return null
  return local?.geo?.ip || null
}
