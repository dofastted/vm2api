import type { ProxyPoolPayload } from '@/types/panel-proxy'
import type { VmProxySnap } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import {
  proxiesForNode,
  proxiesForVmBind,
  proxyBindable,
  proxyBoundIds,
  proxyInFilter,
  proxyLabel,
  proxyMatchesNode,
  proxyMatchesQuery,
  proxyRemaining,
  proxyRows,
  proxyScope,
  proxyViewId,
} from './proxy-sort'
import { useVpsIp } from './use-vps-ip'

const local: VmProxySnap = {
  id: 'px-local',
  kind: 'local',
  enabled: true,
  status: 'ok',
  bind_limit: 5,
  bound_vm_ids: ['main-1', 'main-2', 'a-1', 'a-2', 'a-3', 'a-4', 'a-5'],
  geo: { ip: '192.0.2.10', country: 'Control plane' },
  latency_ms: 0,
}
const main: VmProxySnap = {
  ...local,
  view_id: 'px-local@main',
  node_id: null,
  node_name: '主控',
  bound_vm_ids: ['main-1', 'main-2'],
}
const nodeA: VmProxySnap = {
  ...local,
  view_id: 'px-local@node-a',
  node_id: 'node-a',
  node_name: '东京节点',
  bound_vm_ids: ['a-1', 'a-2', 'a-3', 'a-4', 'a-5'],
  geo: null,
  latency_ms: undefined,
  status: 'unknown',
}
const nodeB: VmProxySnap = {
  ...nodeA,
  view_id: 'px-local@node-b',
  node_id: 'node-b',
  node_name: '洛杉矶节点',
  bound_vm_ids: [],
}
const socks: VmProxySnap = {
  id: 'px-socks',
  kind: 'socks5',
  host: '198.51.100.4',
  port: 1080,
  enabled: true,
  status: 'ok',
  bind_limit: 5,
  bound_vm_ids: [],
}
const payload: ProxyPoolPayload = {
  proxies: [local, socks],
  local_exits: [main, nodeA, nodeB],
}

describe('local exits by node', () => {
  it('counts each binding once and gives the display rows distinct identities', () => {
    const rows = proxyRows(payload)
    expect(rows.map(proxyViewId)).toEqual([
      main.view_id,
      nodeA.view_id,
      nodeB.view_id,
      socks.id,
    ])
    expect(rows.reduce((n, row) => n + proxyBoundIds(row).length, 0)).toBe(7)
    expect(rows.reduce((n, row) => n + (row.bind_limit || 0), 0)).toBe(20)
    expect(payload.proxies?.[0]).toBe(local)
  })

  it('only offers the destination local exit, while keeping shared SOCKS5', () => {
    expect(proxiesForNode(payload, 'node-b')).toEqual([nodeB, socks])
    expect(proxiesForNode(payload, null)).toEqual([main, socks])
    expect(proxiesForNode(payload, undefined)).toEqual([main, socks])
    expect(proxiesForNode(payload, 'missing-node')).toEqual([socks])
    expect(proxyMatchesNode(nodeA, 'node-b')).toBe(false)
    expect(proxyMatchesNode(socks, 'node-b')).toBe(true)
  })

  it('a full node does not consume another node or control-plane capacity', () => {
    const a = proxiesForNode(payload, 'node-a')
    const b = proxiesForNode(payload, 'node-b')
    expect(proxiesForVmBind(a, 'new-vm').map((p) => p.id)).toEqual(['px-socks'])
    expect(proxiesForVmBind(b, 'new-vm').map((p) => p.id)).toEqual([
      'px-local',
      'px-socks',
    ])
    expect(proxyRemaining(main, 'new-vm', 5)).toBe(3)
    expect(proxyRemaining(nodeB, 'new-vm', 5)).toBe(5)
    expect(proxiesForVmBind(a, 'a-1')[0]).toBe(nodeA)
  })

  it('sends the real proxy ID and explicit node scope, including the control plane', () => {
    expect(nodeA.id).toBe('px-local')
    expect(proxyScope(nodeA)).toEqual({ node_id: 'node-a' })
    expect(proxyScope(main)).toEqual({ node_id: null })
    expect(proxyScope(socks)).toEqual({})
  })

  it('names and searches nodes without treating connection addresses as exit observations', () => {
    expect(proxyLabel(nodeA, '192.0.2.10')).toBe(
      'local:东京节点 · 所在节点直出'
    )
    expect(proxyMatchesQuery(nodeA, '东京', () => '')).toBe(true)
    expect(proxyMatchesQuery(nodeA, 'node-a', () => '')).toBe(true)
    expect(useVpsIp('node-a', proxyRows(payload))).toBeNull()
    expect(useVpsIp(null, proxyRows(payload))).toBe('192.0.2.10')
    expect(useVpsIp('node-a', [local])).toBeNull()
    expect(
      proxyRows(payload).find((p) => p.node_id === 'node-a')?.geo
    ).toBeNull()
  })

  it('keeps an orphaned node identifiable without requiring the cluster API', () => {
    const orphan = { ...nodeA, node_name: null, node_id: 'removed-node' }
    const rows = { ...payload, local_exits: [main, orphan] }
    expect(proxyLabel(orphan)).toBe('local:removed-node · 所在节点直出')
    expect(proxiesForNode(rows, 'removed-node')).toEqual([orphan, socks])
  })

  it('keeps an offline node and its existing seats visible without offering new bindings', () => {
    const offline: VmProxySnap = {
      ...nodeB,
      status: 'fail',
      blocked_reason: 'node_unavailable',
      bound_vm_ids: ['b-1'],
    }
    const snapshot = { ...payload, local_exits: [main, nodeA, offline] }
    const choices = proxiesForNode(snapshot, 'node-b')
    expect(proxyRows(snapshot)).toContain(offline)
    expect(proxyBoundIds(offline)).toEqual(['b-1'])
    expect(proxyInFilter(offline, 'all', 5)).toBe(true)
    expect(proxyInFilter(offline, 'off', 5)).toBe(false)
    expect(proxyInFilter(offline, 'open', 5)).toBe(false)
    expect(proxyBindable(offline)).toBe(false)
    expect(proxiesForVmBind(choices, 'new-vm')).toEqual([socks])
    expect(proxiesForVmBind(choices, 'b-1')).toEqual([socks])
    expect(
      proxiesForVmBind(proxiesForNode(snapshot, null), 'new-vm')
    ).toContain(main)
  })

  it('accepts a legacy response, and does not resurrect a local hidden by the server', () => {
    expect(proxyRows({ proxies: [local, socks] })).toEqual([local, socks])
    expect(proxyRows({ proxies: [local, socks], local_exits: [] })).toEqual([
      socks,
    ])
    expect(proxyRows(undefined)).toEqual([])
  })
})
