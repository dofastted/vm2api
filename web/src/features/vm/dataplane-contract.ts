export type KernelDataplane = 'wrap' | 'cc' | 'crag'

export function kernelRouteLabel(
  dataplane: unknown,
  cragVersion?: unknown
): string {
  if (dataplane === 'crag')
    return cragVersion === 'v2' ? 'CRAG v2' : 'CRAG legacy'
  if (dataplane === 'cc') return 'cc-node · cli-hop'
  return 'cli-node · cli-hop'
}

export function kernelRouteHint(
  dataplane: unknown,
  cragVersion?: unknown
): string {
  if (dataplane === 'crag' && cragVersion === 'v2') {
    return '这一槽是 CRAG v2，不是 cli-hop。官方 Claude Code 用手动权限；目录信任只认 CRAG 自己的工作目录。'
  }
  if (dataplane === 'crag') {
    return '这一槽是旧 CRAG kernel（仓内 cc-node），不是 cli-node 的 cli-hop，也不是 CRAG v2。'
  }
  if (dataplane === 'cc') {
    return 'cc-node 仍走 cli-hop，和 cli-node 共用 wrap kernel，不是 CRAG。'
  }
  return '老 cli-node 路线：Rust cli-hop 用 -p 和 bypassPermissions 拉起 cli-node，一进程 20 个 native 槽。不走官方 Claude 的登录、引导或目录信任页。'
}
