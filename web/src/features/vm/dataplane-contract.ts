export type KernelDataplane = 'wrap' | 'cc' | 'crag'

export function kernelRouteLabel(
  dataplane: unknown,
  cragVersion?: unknown
): string {
  if (dataplane === 'crag' && cragVersion === 'v2') return 'CRAG v2 原生 worker'
  if (dataplane === 'crag') return 'cc-node + CRAG kernel'
  if (dataplane === 'cc') return 'cc-node + wrap kernel'
  return 'cli-node + wrap kernel'
}

export function kernelRouteHint(
  dataplane: unknown,
  cragVersion?: unknown
): string {
  if (dataplane === 'crag' && cragVersion === 'v2') {
    return '本槽把 crag_kernel_version 固定为 v2。跑原生 CRAG worker，不用 cli-node，也不用 wrap kin-kernel。'
  }
  if (dataplane === 'crag') {
    return 'claude_bin 是 cc-node，内核是 share/crag 的 kin-kernel。不是 cli-node + wrap kernel，也不是 CRAG v2。'
  }
  if (dataplane === 'cc') {
    return 'claude_bin 是 cc-node，内核仍是 wrap kin-kernel，推理走 cli-hop。不是 CRAG kernel。'
  }
  return '老 cli-node 路线。claude_bin 是 cli-node，内核是 wrap kin-kernel，推理走 cli-hop。'
}
