import type { VmProxySnap } from '@/types/panel-vm'

export type ProxySortKey = 'host' | 'status' | 'vm' | 'geo'

export function proxyBoundIds(prx: VmProxySnap | undefined): string[] {
  if (!prx) return []
  if (Array.isArray(prx.bound_vm_ids) && prx.bound_vm_ids.length) {
    return prx.bound_vm_ids.filter(Boolean)
  }
  return prx.bound_vm_id ? [prx.bound_vm_id] : []
}

export function proxyBindLimit(
  prx: VmProxySnap | undefined,
  fallback: number
): number {
  const n = Number(prx?.bind_limit || fallback || 5)
  return Number.isFinite(n) && n > 0 ? n : 5
}

export function proxyIsInvalid(prx: VmProxySnap | undefined): boolean {
  if (!prx) return true
  return prx.enabled === false || prx.status === 'dead' || prx.status === 'fail'
}

export function proxyStatusLabel(prx: VmProxySnap): string {
  if (prx.enabled === false || prx.status === 'dead') return '失效'
  if (prx.status === 'fail') return '失败'
  if (prx.status === 'ok') return '正常'
  return '未测'
}

/**
 * 代理下拉的一行文案：`host:port · 状态 延迟 · n/limit`。
 *
 * 字段与顺序对齐 index.html:7617 proxyOptionLabel()，延迟缺失时显示 `—`。
 * 只拼 host/port —— 账密永不出现在任何渲染路径上（见 api-contract.md）。
 */
export function proxyOptionLabel(
  prx: VmProxySnap,
  poolBindLimit: number
): string {
  const lat = prx.latency_ms != null ? `${prx.latency_ms}ms` : '—'
  const used = proxyBoundIds(prx).length
  const limit = proxyBindLimit(prx, poolBindLimit)
  return `${prx.host || '?'}:${prx.port ?? '?'} · ${proxyStatusLabel(prx)} ${lat} · ${used}/${limit}`
}

/**
 * 这条代理对 `vmId` 还剩几个绑定位。已绑到本槽的算「改选回自己」，不占位。
 * 对齐 index.html:7653 proxyRemaining()。
 */
export function proxyRemaining(
  prx: VmProxySnap,
  vmId: string,
  poolBindLimit: number
): number {
  const ids = proxyBoundIds(prx)
  const here = !!vmId && ids.includes(vmId)
  return Math.max(
    0,
    proxyBindLimit(prx, poolBindLimit) - ids.length + (here ? 1 : 0)
  )
}

/**
 * 「能不能马上用」的排序，专给导入流程的代理下拉：
 * 健康优先 → 有余位优先 → 余位多的在前 → 延迟低的在前 → host:port。
 *
 * 与 `sortedProxies()`（代理页的用户可切列排序）是两个用途，不要混用。
 * 对齐 index.html:7659 sortedProxiesByAvailability()。
 */
export function sortedProxiesByAvailability(
  list: VmProxySnap[],
  vmId: string,
  poolBindLimit: number
): VmProxySnap[] {
  return list.slice().sort((a, b) => {
    const ia = proxyIsInvalid(a) ? 1 : 0
    const ib = proxyIsInvalid(b) ? 1 : 0
    if (ia !== ib) return ia - ib
    const ra = proxyRemaining(a, vmId, poolBindLimit)
    const rb = proxyRemaining(b, vmId, poolBindLimit)
    const fa = ra <= 0 ? 1 : 0
    const fb = rb <= 0 ? 1 : 0
    if (fa !== fb) return fa - fb
    if (rb !== ra) return rb - ra
    const la = Number(a.latency_ms ?? 1e9)
    const lb = Number(b.latency_ms ?? 1e9)
    if (la !== lb) return la - lb
    return cmp(
      `${a.host || ''}:${a.port || ''}`,
      `${b.host || ''}:${b.port || ''}`,
      'asc'
    )
  })
}

function cmp(
  a: string | number,
  b: string | number,
  dir: 'asc' | 'desc'
): number {
  if (a < b) return dir === 'asc' ? -1 : 1
  if (a > b) return dir === 'asc' ? 1 : -1
  return 0
}

export function sortedProxies(
  list: VmProxySnap[],
  key: ProxySortKey,
  dir: 'asc' | 'desc'
): VmProxySnap[] {
  const rows = list.slice()
  rows.sort((a, b) => {
    const ia = proxyIsInvalid(a) ? 1 : 0
    const ib = proxyIsInvalid(b) ? 1 : 0
    if (ia !== ib) return ia - ib
    if (key === 'host') {
      return cmp(
        `${a.host || ''}:${a.port || ''}`,
        `${b.host || ''}:${b.port || ''}`,
        dir
      )
    }
    if (key === 'status') return cmp(a.status || '', b.status || '', dir)
    if (key === 'geo') {
      // 未检测的排在最后：它们是「待办」，不是某个国家。
      const ga = a.geo?.country_code || a.geo?.country || '\uffff'
      const gb = b.geo?.country_code || b.geo?.country || '\uffff'
      return cmp(ga, gb, dir)
    }
    return cmp(proxyBoundIds(a)[0] || '', proxyBoundIds(b)[0] || '', dir)
  })
  return rows
}

export function readPositive(
  rec: Record<string, unknown>,
  key: string,
  fallback: number
): number {
  const n = Number(rec[key])
  return Number.isFinite(n) && n > 0 ? n : fallback
}
