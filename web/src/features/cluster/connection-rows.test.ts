import type { ClusterApiNode, ClusterLocalStatus } from '@/types/panel-cluster'
import { describe, expect, it } from 'vitest'
import {
  internalAddresses,
  localDetailRows,
  localDetailSummary,
} from '@/features/cluster/connection-rows'

const node = (over: Partial<ClusterApiNode> = {}): ClusterApiNode => ({
  id: 'node-1',
  label: '节点 A',
  host: '10.10.0.11',
  port: 22,
  username: 'root',
  auth_type: 'key',
  host_key_alg: 'ssh-ed25519',
  host_key_sha256: 'SHA256:2SIq',
  jump_node_id: null,
  created_at: '',
  updated_at: '',
  link: { state: 'ready', connected_at: '2026-11-02T01:19:00.000Z' },
  health: {
    latency_ms: 4,
    docker: { ok: true, error: null },
    containers: { total: 26, running: 26 },
    host: null,
    checked_at: '',
  },
  bridge: null,
  install: null,
  direct_link: {
    address: '10.10.0.11',
    port: 7790,
    state: 'ok',
    latency_ms: 21,
    error: null,
    gate_error: null,
    checked_at: '',
  },
  ...over,
})

const status = {
  checked_at: '',
  control: {
    mode: 'container',
    container: 'vm2api',
    network_mode: 'host',
    listen_host: '0.0.0.0',
    listen_port: 8787,
    loopback_only: false,
  },
  nat: {
    public_ip: '192.0.2.10',
    observed_via: { id: 'node-us', label: '远端节点 198.51.100.20' },
    local_ips: ['192.0.2.10', '172.30.0.1', '10.10.0.10'],
    behind_nat: false,
    inbound: 'closed',
  },
  docker: {
    ok: true,
    version: '29.9.2',
    running: 16,
    containers: 17,
    slots: 6,
    error: null,
  },
  kvm: { ok: true, accel: 'kvm', error: null },
} as ClusterLocalStatus

describe('local connection details', () => {
  it('says the closed panel port plainly and finds the internal address', () => {
    const rows = localDetailRows({
      status,
      host: { rss: 394 * 1024 * 1024, proc_uptime: 36000 },
      nodes: [node()],
    })
    const by = Object.fromEntries(rows.map((r) => [r.label, r]))
    expect(by['公网'].value).toBe('192.0.2.10 · 外网连不进 8787（正常）')
    expect(by['公网'].tone).toBe('ok')
    expect(by['内网'].value).toBe('10.10.0.10（连集群节点）')
    expect(by['Docker'].value).toContain('其中槽 6 个')
    expect(by['KVM'].value).toBe('可用（硬件加速）')
    expect(by['控制面进程'].value).toBe('内存 394MB · 已运行 10 小时')
    expect(by['集群出站'].value).toBe('1 / 1 个节点已连上')
    expect(localDetailSummary(status)).toBe(
      '控制面 host 网络 · 外网连不进 · Docker 正常 · KVM 可用'
    )
  })

  it('warns when the panel port is open to the internet', () => {
    const rows = localDetailRows({
      status: { ...status, nat: { ...status.nat, inbound: 'open' } },
      host: undefined,
      nodes: [],
    })
    expect(rows.find((r) => r.label === '公网')?.tone).toBe('caution')
  })

  it('only treats same-/24 addresses as internal', () => {
    expect(internalAddresses(['10.10.0.10', '172.30.0.1'], [node()])).toEqual([
      '10.10.0.10',
    ])
    expect(
      internalAddresses(['10.10.0.10'], [node({ host: '198.51.100.20' })])
    ).toEqual([])
  })
})
